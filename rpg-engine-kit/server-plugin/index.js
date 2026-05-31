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

function ensureEntity(state, id) {
    if (!state.entities) state.entities = {};
    if (!state.entities[id]) {
        state.entities[id] = { ...structuredClone(RULES.npc_template), name: id };
    }
    return state.entities[id];
}

/**
 * Apply one parsed combat outcome to the state in place.
 * The parser LLM only classifies; legality and numbers are decided here.
 * @returns {{ ok: boolean, delta: string }}
 */
function applyAction(state, parsed) {
    if (!parsed || parsed.action_valid === false) {
        return { ok: false, delta: 'No valid combat action detected.' };
    }
    const targetId = sanitizeId(parsed.target);
    if (!parsed.target) {
        return { ok: false, delta: 'No target specified.' };
    }
    const tier = String(parsed.damage_tier || 'none');
    if (tier === 'none') {
        return { ok: false, delta: 'No damage this exchange.' };
    }
    const formula = RULES.tiers[tier];
    if (formula === undefined) {
        return { ok: false, delta: `Unknown damage tier '${tier}'.` };
    }

    const target = ensureEntity(state, targetId);
    const raw = rollFormula(formula);
    const dr = Number(target.armor_dr) || 0;
    const taken = Math.max(0, raw - dr);
    const before = Number(target.hp) || 0;
    target.hp = Math.max(0, before - taken);

    const downAt = RULES.unconscious_at ?? 0;
    if (target.hp <= downAt) {
        target.conditions = RULES.unconscious_condition || 'unconscious';
    }

    const attacker = parsed.attacker ? sanitizeId(parsed.attacker) : 'attacker';
    const verb = parsed.attack_type || 'hit';
    const delta =
        `${attacker} -> ${targetId}: ${verb} (${tier}) rolled ${raw}` +
        (dr ? `, armor DR ${dr}` : '') +
        `, ${taken} damage. HP ${before} -> ${target.hp}/${target.maxhp}` +
        (target.hp <= downAt ? ' [DOWN]' : '');

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
