/**
 * Turn-tag handling for the NPC Memory consumer (contract §7).
 *
 * The turn tag is consumer-owned: the extension injects an emit-instruction so
 * the model ends its reply with a machine-readable tag, then parses and strips
 * it. When the model emits nothing, an `inferred` tag is synthesized from §6
 * alias inference. All functions here are pure (no SillyTavern imports) so they
 * stay unit-testable.
 */

import { slugify } from './ids.js';

/** Matches one turn tag and captures its JSON body. Global for stripping. */
const TAG_RE = /<!--\s*npcmem:(\{[\s\S]*?\})\s*-->/g;

/** Current tag schema version (tracks the contract `schema`). */
export const TAG_VERSION = 1;

/**
 * Parse the turn tag from a message (contract §7.3 step 1; last match wins).
 * @param {string} text
 * @returns {object|null} normalized tag, or null when absent/malformed.
 */
export function parseTag(text) {
    const s = String(text ?? '');
    let m, last = null;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(s)) !== null) last = m[1];
    if (last === null) return null;
    try {
        const raw = JSON.parse(last);
        if (!raw || typeof raw !== 'object') return null;
        return normalizeTag(raw, raw.src ?? 'model');
    } catch {
        return null; // Malformed: caller treats as absent (never fatal).
    }
}

/** Normalize an arbitrary tag-ish object into the canonical shape. */
function normalizeTag(raw, src) {
    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];
    const actors = arr(raw.actors);
    return {
        v: Number(raw.v) || TAG_VERSION,
        actors,
        present: arr(raw.present).length ? arr(raw.present) : actors.slice(),
        withUser: typeof raw.withUser === 'boolean' ? raw.withUser : undefined,
        scene: typeof raw.scene === 'string' ? raw.scene : null,
        location: typeof raw.location === 'string' ? raw.location : '',
        src,
    };
}

/**
 * Remove every turn tag from a message (contract §7.3 step 2 / §7.4), tidying
 * any leftover trailing whitespace.
 * @param {string} text
 * @returns {string}
 */
export function stripTags(text) {
    return String(text ?? '').replace(TAG_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');
}

/** True if the text contains at least one turn tag. */
export function hasTag(text) {
    TAG_RE.lastIndex = 0;
    return TAG_RE.test(String(text ?? ''));
}

/**
 * Resolve a speaker/display name to a manifest id (via displayName/aliases,
 * else the slug rule so it aligns with a manifest using the same name).
 * @param {string} name
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @returns {string}
 */
export function resolveNameToId(name, index) {
    const n = String(name ?? '').trim();
    if (!n) return '';
    const lower = n.toLowerCase();
    for (const rec of index?.byId?.values?.() ?? []) {
        if (rec.displayName?.toLowerCase() === lower) return rec.id;
        if ((rec.aliases ?? []).some(a => String(a).toLowerCase() === lower)) return rec.id;
    }
    return slugify(n);
}

/**
 * Synthesize an `inferred` tag for a character message with no model tag
 * (contract §6 / §7.3 step 4).
 * @param {{name?: string, mes?: string}} message
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @param {string[]} personaAliases  All known {{user}} names/aliases.
 * @returns {object} an inferred tag (always has at least one actor).
 */
export function inferTag(message, index, personaAliases) {
    const actorId = resolveNameToId(message?.name, index);
    const text = String(message?.mes ?? '');
    const withUser = aliasInText(text, personaAliases);
    return {
        v: TAG_VERSION,
        actors: actorId ? [actorId] : [],
        present: actorId ? [actorId] : [],
        withUser,
        scene: null,
        location: '',
        src: 'inferred',
    };
}

/** Case-insensitive whole-word-ish test for any persona alias in the text. */
function aliasInText(text, aliases) {
    const t = String(text ?? '').toLowerCase();
    for (const a of aliases ?? []) {
        const alias = String(a ?? '').toLowerCase().trim();
        if (!alias || alias === '{{user}}') continue;
        if (t.includes(alias)) return true;
    }
    return false;
}

/**
 * Build the emit-instruction injected into the prompt (contract §7 step 1).
 * The consumer supplies the authoritative id vocabulary; the model fills in the
 * per-turn judgment.
 * @param {string[]} presentIds   Ids present this turn (primary vocabulary).
 * @param {string[]} allIds       Full roster ids.
 * @param {string[]} sceneIds     Known scene ids (may be empty).
 * @param {string} personaName    {{user}} display name.
 * @returns {string}
 */
export function buildEmitInstruction(presentIds, allIds, sceneIds, personaName) {
    const ids = (presentIds?.length ? presentIds : allIds) ?? [];
    const who = personaName || 'the user';
    const sceneClause = sceneIds?.length
        ? ` "scene" must be one of: ${sceneIds.join(', ')} (or null).`
        : ' "scene" must be null.';
    return [
        'End your reply with exactly one line and nothing after it:',
        '<!--npcmem:{"v":1,"actors":["<id>"],"withUser":<true|false>,"scene":<"id"|null>}-->',
        `Valid NPC ids: ${ids.join(', ') || '(none)'}. "actors" = the NPC ids who acted this turn;` +
        ` "withUser" = whether ${who} took part this turn.${sceneClause}`,
    ].join('\n');
}
