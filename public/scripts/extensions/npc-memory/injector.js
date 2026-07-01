/**
 * Selective prompt injection for the NPC Memory consumer.
 *
 * Builds a compact memory block for the NPCs present this turn and injects it
 * via setExtensionPrompt. Because WORLD_INFO_ACTIVATED is emitted (and awaited)
 * before extension prompts are gathered during generation, an injection set
 * from the activation handler lands in the same generation's prompt.
 *
 * `buildInjectionText` is pure (no SillyTavern imports) so it stays unit-
 * testable; the apply/clear helpers lazy-import script.js at call time.
 *
 * Phase 1 surfaces presence and manifest relationship hints among co-present
 * NPCs (contract §8). Stored memory slots/events are included once later phases
 * populate them.
 */

import { buildEmitInstruction } from './turntag.js';
import { selectRelevant } from './relevance.js';

/** Unique key for this extension's prompt injection. */
export const INJECT_KEY = 'npc_memory';

/**
 * Build the injection text for the present NPCs. Returns '' when there is
 * nothing worth injecting (so the prompt stays clean).
 *
 * @param {string[]} npcIds      Present NPC ids.
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @param {object} settings
 * @param {(id:string)=>(object|undefined)} [getRecord]  Store accessor.
 * @param {{ sceneId?: string|null, personaName?: string, queryText?: string, inSceneIds?: Set<string>|null }} [extra]
 * @returns {string}
 */
export function buildInjectionText(npcIds, index, settings, getRecord = () => undefined, extra = {}) {
    if (!Array.isArray(npcIds) || npcIds.length === 0) return '';

    const cap = Number(settings.maxNpcs) > 0 ? Number(settings.maxNpcs) : npcIds.length;
    const present = npcIds.slice(0, cap);
    const lines = [];

    // Per-NPC memory: rolling "now" recap (contract §6) plus long-term key
    // moments, retrieved by relevance to the current moment (not just recency).
    // The "now" recap is only injected for NPCs actually in the scene (when a
    // scene roster is provided); long-term facts are gated by relevance instead.
    const maxLT = Number(settings.maxLongTerm) > 0 ? Number(settings.maxLongTerm) : 10;
    for (const id of present) {
        const meta = index.byId.get(id);
        const name = meta?.displayName ?? id;
        const rec = getRecord(id);
        const inScene = !extra.inSceneIds || extra.inSceneIds.has(id);
        const now = inScene ? summarizeRecord(rec) : '';
        if (now) lines.push(`- ${name} (now): ${now}`);
        if (settings.longTermMemory !== false) {
            const facts = relevantLongTerm(rec, settings, extra, maxLT);
            if (facts.length) lines.push(`- ${name} (remembers): ${facts.join(' | ')}`);
        }
    }

    // Relationship hints among co-present NPCs (contract §8).
    if (settings.relationshipHints !== false) {
        for (const line of relationshipHints(present, index)) lines.push(line);
    }

    // Presence roster (optional; useful for verifying the pipeline).
    if (settings.announcePresence) {
        const names = present.map(id => index.byId.get(id)?.displayName ?? id);
        if (names.length) lines.unshift(`Present: ${names.join(', ')}.`);
    }

    let block = lines.length ? `[NPC Memory]\n${lines.join('\n')}` : '';

    // Turn-tag emit-instruction (consumer-owned lever, contract §7 step 1).
    if (settings.emitTag !== false) {
        const allIds = [...index.byId.keys()];
        const sceneIds = [...new Set([...index.sceneByUid.values()].map(s => s.id))];
        const personaName = extra.personaName || index.personas?.user?.name || '';
        // When an authoritative scene roster is known, only offer ids for NPCs
        // actually in scene as "actors" candidates. `present` may also include
        // NPCs merely mentioned/activated this turn (e.g. referenced in dialogue)
        // whose "now" line we still want injected, but they didn't act — offering
        // them here invites the model to (wrongly) tag them as acting too.
        const actorVocab = (extra.inSceneIds && extra.inSceneIds.size > 0)
            ? present.filter(id => extra.inSceneIds.has(id))
            : present;
        const instr = buildEmitInstruction(actorVocab, allIds, sceneIds, personaName);
        block = block ? `${block}\n\n${instr}` : `[NPC Memory]\n${instr}`;
    }

    return block;
}

/**
 * Pick the long-term facts to inject for an NPC: relevance-ranked against the
 * current moment when enabled (and a query is available), else most-recent.
 *
 * @param {import('./store.js').NpcRecord|undefined} rec
 * @param {object} settings
 * @param {{ queryText?: string }} extra
 * @param {number} maxLT
 * @returns {string[]}
 */
function relevantLongTerm(rec, settings, extra, maxLT) {
    const all = rec?.longTerm ?? [];
    if (all.length === 0) return [];
    if (settings.relevanceRetrieval !== false && extra.queryText) {
        return selectRelevant(all, extra.queryText, { max: maxLT, minScore: 1 });
    }
    return all.slice(-maxLT).map(e => e.text); // fallback: recency
}

/**
 * Summarize a stored record into a single line (the rolling "now" recap).
 *
 * @param {import('./store.js').NpcRecord|undefined} rec
 * @returns {string}
 */
function summarizeRecord(rec) {
    if (!rec) return '';
    const parts = [];
    if (rec.slots?.lastWithUser?.summary) parts.push(`with you: ${rec.slots.lastWithUser.summary}`);
    if (rec.slots?.lastAlone?.summary) parts.push(`recently: ${rec.slots.lastAlone.summary}`);
    return parts.join('; ');
}

/**
 * Produce relationship-hint lines for pairs of co-present NPCs.
 *
 * @param {string[]} present
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @returns {string[]}
 */
function relationshipHints(present, index) {
    const out = [];
    const presentSet = new Set(present);
    for (const id of present) {
        const meta = index.byId.get(id);
        for (const edge of meta?.relationships ?? []) {
            if (!presentSet.has(edge?.to)) continue;
            const a = meta.displayName ?? id;
            const b = index.byId.get(edge.to)?.displayName ?? edge.to;
            const kind = edge.kind ? ` (${edge.kind})` : '';
            const note = edge.note ? ` — ${edge.note}` : '';
            out.push(`- ${a} → ${b}${kind}${note}`);
        }
    }
    return out;
}

/**
 * Apply (or clear) the injection for the current turn.
 *
 * @param {string} text     Injection text; '' clears the injection.
 * @param {object} settings
 */
export async function applyInjection(text, settings) {
    const { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } = await import('../../../script.js');
    const role = resolveRole(extension_prompt_roles, settings.role);
    const depth = Number.isFinite(Number(settings.depth)) ? Number(settings.depth) : 2;
    setExtensionPrompt(INJECT_KEY, text || '', extension_prompt_types.IN_CHAT, depth, false, role);
}

/** Clear any standing injection. */
export async function clearInjection() {
    const { setExtensionPrompt, extension_prompt_types } = await import('../../../script.js');
    setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0);
}

function resolveRole(roles, role) {
    switch (String(role).toLowerCase()) {
        case 'user': return roles.USER;
        case 'assistant': return roles.ASSISTANT;
        default: return roles.SYSTEM;
    }
}
