/**
 * RPG Engine — SillyTavern server plugin.
 *
 * Authoritative, server-side game-state engine. Holds per-game stat JSON on
 * disk, performs damage/armor calculations the client cannot tamper with, and
 * keeps a pre-mutation snapshot per message so the user can undo/swipe without
 * losing pre-action stats.
 *
 * Files live under the per-user data directory:
 *   {user}/user/files/rpg-engine/games/{chatId}/active.json     - live state
 *   {user}/user/files/rpg-engine/games/{chatId}/undo/{idx}.json - snapshots
 *
 * Bundled with the plugin (read-only templates):
 *   defaults.json - baseline sheet copied into active.json on /reset
 *   rules.json    - tier->dice table, armor rules, thresholds
 *
 * Routes mount under /api/plugins/rpg-engine/*.
 */
/* global require, module, __dirname, console, structuredClone */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const express = require('express');

const PLUGIN_ID = 'rpg-engine';

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'defaults.json'), 'utf-8'));
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf-8'));

const info = {
    id: PLUGIN_ID,
    name: 'RPG Engine',
    description: 'Authoritative server-side stat tracking, combat math, and undo snapshots for tabletop-style roleplay.',
};

/* ------------------------------------------------------------------ paths */

/** Strip anything that could escape the games directory. */
function sanitizeId(id) {
    return String(id || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200) || 'default';
}

/** Resolve the rpg-engine root inside the requesting user's files directory. */
function userRoot(req) {
    const files = req.user && req.user.directories && req.user.directories.files;
    if (!files) throw new Error('User files directory unavailable');
    return path.join(files, PLUGIN_ID);
}

function gameDir(req, chatId) {
    return path.join(userRoot(req), 'games', sanitizeId(chatId));
}

function activePath(req, chatId) {
    return path.join(gameDir(req, chatId), 'active.json');
}

function undoPath(req, chatId, msgIdx) {
    return path.join(gameDir(req, chatId), 'undo', `${sanitizeId(String(msgIdx))}.json`);
}

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf-8'));
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
    }
}

async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf-8');
}

/** Load the active sheet, seeding it from defaults the first time. */
async function loadActive(req, chatId) {
    const file = activePath(req, chatId);
    let state = await readJson(file, null);
    if (!state) {
        state = structuredClone(DEFAULTS);
        await writeJson(file, state);
    }
    return state;
}

/* ----------------------------------------------------------------- rules */

/** Roll a droll-style NdM(+/-K) formula, or return a bare number. */
function rollFormula(formula) {
    const text = String(formula).trim();
    const m = /^(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?$/i.exec(text);
    if (!m) {
        const n = Number(text);
        return Number.isFinite(n) ? n : 0;
    }
    const count = Number(m[1]);
    const sides = Number(m[2]);
    const mod = m[3] ? Number(m[3].replace(/\s+/g, '')) : 0;
    let total = mod;
    for (let i = 0; i < count; i++) {
        total += 1 + Math.floor(Math.random() * sides);
    }
    return total;
}

// Ordered severity ladder. tier_shift moves an incoming attack along this list
// (negative = resisted/downgraded, positive = vulnerable/upgraded).
const TIER_ORDER = ['none', 'graze', 'light', 'medium', 'heavy', 'critical'];

function entityExists(state, id) {
    return !!(state && state.entities && state.entities[id]);
}

function ensureEntity(state, id) {
    if (!state.entities) state.entities = {};
    if (!state.entities[id]) {
        state.entities[id] = { ...structuredClone(RULES.npc_template), name: id };
    }
    return state.entities[id];
}

/**
 * Resolve the dice formula for a (attacker, tier) pair using the most-specific
 * table available. Resolution order:
 *   attacker.damage_tiers -> state.tier_tables[attacker.tier]
 *   -> state.global_damage_tiers -> RULES.tiers (demo fallback)
 * @returns {string|undefined}
 */
function resolveFormula(state, attacker, tier) {
    const tables = [
        attacker && attacker.damage_tiers,
        attacker && state.tier_tables && state.tier_tables[String(attacker.tier)],
        state && state.global_damage_tiers,
        RULES.tiers,
    ];
    for (const t of tables) {
        if (t && t[tier] !== undefined) return t[tier];
    }
    return undefined;
}

/**
 * Apply the target's tier_shift for this attack type, clamped to the ladder.
 * @returns {string} the (possibly shifted) tier name
 */
function applyTierShift(target, attackType, tier) {
    const shift = target && target.tier_shift && attackType
        ? Number(target.tier_shift[attackType]) || 0
        : 0;
    if (!shift) return tier;
    const idx = TIER_ORDER.indexOf(tier);
    if (idx < 0) return tier;
    const shifted = Math.min(TIER_ORDER.length - 1, Math.max(0, idx + shift));
    return TIER_ORDER[shifted];
}

/**
 * Apply one parsed combat outcome to the state in place.
 *
 * The parser LLM only classifies (target/attacker/attack_type/damage_tier);
 * legality and all numbers are decided here. Several deterministic safeguards
 * limit the blast radius of an LLM mislabel:
 *   - target/attacker must be known entities (rejects hallucinated combatants);
 *   - tier_shift adjusts severity by damage type before rolling;
 *   - a damage governor caps a single non-crit hit as a fraction of maxhp.
 *
 * @returns {{ ok: boolean, delta: string, rejected?: string }}
 */
function applyAction(state, parsed) {
    if (!parsed || parsed.action_valid === false) {
        return { ok: false, delta: 'No valid combat action detected.' };
    }
    if (!parsed.target) {
        return { ok: false, delta: 'No target specified.' };
    }
    const targetId = sanitizeId(parsed.target);
    const attackerId = parsed.attacker ? sanitizeId(parsed.attacker) : null;

    // Safeguard: reject hallucinated combatants. The target must already exist
    // in the game (auto-create only if explicitly allowed, for the demo flow).
    if (!entityExists(state, targetId)) {
        if (!RULES.allow_auto_create) {
            return { ok: false, rejected: 'unknown_target', delta: `Rejected: unknown target '${targetId}'.` };
        }
    }
    // A named attacker that doesn't exist is a strong hallucination signal; warn
    // but don't auto-create attackers (they don't take damage here).
    let attackerWarn = '';
    if (attackerId && !entityExists(state, attackerId)) {
        attackerWarn = ` [warn: unknown attacker '${attackerId}']`;
    }

    const rawTier = String(parsed.damage_tier || 'none');
    if (rawTier === 'none') {
        return { ok: false, delta: 'No damage this exchange.' };
    }
    if (!TIER_ORDER.includes(rawTier)) {
        return { ok: false, rejected: 'bad_tier', delta: `Rejected: unknown damage tier '${rawTier}'.` };
    }

    const target = ensureEntity(state, targetId);
    const attacker = attackerId && entityExists(state, attackerId) ? state.entities[attackerId] : null;
    const attackType = parsed.attack_type || null;

    // tier_shift (target's resistance/weakness by attack type), then resolve dice.
    const effTier = applyTierShift(target, attackType, rawTier);
    const formula = resolveFormula(state, attacker, effTier);
    if (formula === undefined) {
        return { ok: false, rejected: 'no_formula', delta: `Rejected: no dice table for tier '${effTier}'.` };
    }

    const raw = rollFormula(formula);
    const dr = Number(target.armor_dr) || 0;
    let taken = Math.max(0, raw - dr);

    // Safeguard: damage governor. Cap a single hit as a fraction of maxhp so a
    // misclassified heavy can't one-shot. Critical (or configured tiers) exempt.
    const gov = RULES.governor || {};
    let governed = false;
    if (gov.enabled && !(gov.exempt_tiers || []).includes(effTier)) {
        const cap = Math.floor((Number(target.maxhp) || 0) * (Number(gov.max_fraction) || 1));
        if (cap > 0 && taken > cap) {
            taken = cap;
            governed = true;
        }
    }

    const before = Number(target.hp) || 0;
    target.hp = Math.max(0, before - taken);

    const downAt = RULES.unconscious_at ?? 0;
    if (target.hp <= downAt) {
        target.conditions = RULES.unconscious_condition || 'unconscious';
    }

    const verb = attackType || 'hit';
    const shiftNote = effTier !== rawTier ? ` (shifted ${rawTier}->${effTier})` : '';
    const delta =
        `${attackerId || 'attacker'} -> ${targetId}: ${verb} (${rawTier})${shiftNote} rolled ${raw}` +
        (dr ? `, armor DR ${dr}` : '') +
        (governed ? `, capped to ${taken}` : '') +
        `, ${taken} damage. HP ${before} -> ${target.hp}/${target.maxhp}` +
        (target.hp <= downAt ? ' [DOWN]' : '') +
        attackerWarn;

    return { ok: true, delta };
}

/** Render the authoritative sheet string injected into the prompt. */
function formatSheet(state) {
    const entities = (state && state.entities) || {};
    const lines = Object.entries(entities).map(([id, e]) => {
        const name = e.name && e.name !== id ? `${e.name} (${id})` : id;
        let line = `- ${name}: HP ${e.hp}/${e.maxhp}, AC ${e.ac}`;
        if (Number(e.armor_dr) > 0) line += `, armor DR ${e.armor_dr}`;
        if (e.conditions && e.conditions !== 'none') line += `, ${e.conditions}`;
        return line;
    });
    return (
        'Game state (authoritative — narrate consistently with these numbers; ' +
        'never invent or contradict them):\n' +
        (lines.length ? lines.join('\n') : '- (no entities yet)')
    );
}

/* ---------------------------------------------------------------- router */

async function init(router) {
    router.use(express.json({ limit: '5mb' }));

    // Health/info probe.
    router.get('/', (_req, res) => res.json({ ...info, rules: RULES, defaults: DEFAULTS }));

    // Reset a game: copy defaults -> active, clear undo snapshots.
    router.post('/reset', async (req, res) => {
        try {
            const chatId = req.body.chatId;
            const fresh = structuredClone(DEFAULTS);
            await writeJson(activePath(req, chatId), fresh);
            await fsp.rm(path.join(gameDir(req, chatId), 'undo'), { recursive: true, force: true });
            res.json({ ok: true, state: fresh });
        } catch (err) {
            console.error('[rpg-engine] /reset failed', err);
            res.status(500).json({ ok: false, error: String(err.message || err) });
        }
    });

    // Current live state.
    router.get('/state', async (req, res) => {
        try {
            const state = await loadActive(req, req.query.chatId);
            res.json({ ok: true, state });
        } catch (err) {
            console.error('[rpg-engine] /state failed', err);
            res.status(500).json({ ok: false, error: String(err.message || err) });
        }
    });

    // Formatted sheet for prompt injection.
    router.get('/sheet', async (req, res) => {
        try {
            const state = await loadActive(req, req.query.chatId);
            res.json({ ok: true, sheet: formatSheet(state) });
        } catch (err) {
            console.error('[rpg-engine] /sheet failed', err);
            res.status(500).json({ ok: false, error: String(err.message || err) });
        }
    });

    // Apply a parsed combat outcome. Snapshots first so it can be undone.
    router.post('/apply', async (req, res) => {
        try {
            const { chatId, msgIdx, parsed } = req.body;
            const state = await loadActive(req, chatId);

            // Snapshot the pre-action state keyed by message index (idempotent
            // per index: re-applying the same message overwrites the snapshot
            // only if one does not already exist, so swipes rollback cleanly).
            const snapFile = undoPath(req, chatId, msgIdx);
            const existingSnap = await readJson(snapFile, null);
            const baseline = existingSnap || state;
            if (!existingSnap) {
                await writeJson(snapFile, structuredClone(state));
            } else {
                // Re-deciding the same message: start from the snapshot, not the
                // already-mutated state, so damage is never double-applied.
                Object.assign(state, structuredClone(baseline));
            }

            const result = applyAction(state, parsed);
            await writeJson(activePath(req, chatId), state);
            res.json({ ok: result.ok, delta: result.delta, state, sheet: formatSheet(state) });
        } catch (err) {
            console.error('[rpg-engine] /apply failed', err);
            res.status(500).json({ ok: false, error: String(err.message || err) });
        }
    });

    // Restore the pre-action snapshot for a message (undo / delete).
    router.post('/rollback', async (req, res) => {
        try {
            const { chatId, msgIdx } = req.body;
            const snapFile = undoPath(req, chatId, msgIdx);
            const snap = await readJson(snapFile, null);
            if (!snap) {
                const state = await loadActive(req, chatId);
                return res.json({ ok: false, restored: false, state, sheet: formatSheet(state) });
            }
            await writeJson(activePath(req, chatId), snap);
            await fsp.rm(snapFile, { force: true });
            res.json({ ok: true, restored: true, state: snap, sheet: formatSheet(snap) });
        } catch (err) {
            console.error('[rpg-engine] /rollback failed', err);
            res.status(500).json({ ok: false, error: String(err.message || err) });
        }
    });

    console.log('[rpg-engine] plugin initialized');
}

module.exports = { info, init };
