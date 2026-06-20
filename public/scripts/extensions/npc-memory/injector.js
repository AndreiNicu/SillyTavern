/**
 * Selective prompt injection for the NPC Memory consumer.
 *
 * Builds a compact memory block for the NPCs present this turn and injects it
 * via setExtensionPrompt. Because WORLD_INFO_ACTIVATED is emitted (and awaited)
 * before extension prompts are gathered during generation, an injection set
 * from the activation handler lands in the same generation's prompt.
 *
 * Phase 1 surfaces presence and manifest relationship hints among co-present
 * NPCs (contract §8). Stored memory slots/events are included once later phases
 * populate them.
 */

import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../script.js';
import { getRecord } from './store.js';

/** Unique key for this extension's prompt injection. */
export const INJECT_KEY = 'npc_memory';

/**
 * Build the injection text for the present NPCs. Returns '' when there is
 * nothing worth injecting (so the prompt stays clean).
 *
 * @param {string[]} npcIds                Present NPC ids.
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @param {object} settings
 * @returns {string}
 */
export function buildInjectionText(npcIds, index, settings) {
    if (!Array.isArray(npcIds) || npcIds.length === 0) return '';

    const cap = Number(settings.maxNpcs) > 0 ? Number(settings.maxNpcs) : npcIds.length;
    const present = npcIds.slice(0, cap);
    const lines = [];

    // Per-NPC memory lines (slots/events populated by later phases).
    for (const id of present) {
        const meta = index.byId.get(id);
        const name = meta?.displayName ?? id;
        const rec = getRecord(id);
        const memory = rec ? summarizeRecord(rec) : '';
        if (memory) lines.push(`- ${name}: ${memory}`);
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

    if (lines.length === 0) return '';
    return `[NPC Memory]\n${lines.join('\n')}`;
}

/**
 * Summarize a stored record into a single line. Empty in Phase 1 (no captured
 * memory yet); kept as the single place later phases extend.
 *
 * @param {import('./store.js').NpcRecord} rec
 * @returns {string}
 */
function summarizeRecord(rec) {
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
 * @param {string} text       Injection text; '' clears the injection.
 * @param {object} settings
 */
export function applyInjection(text, settings) {
    const role = resolveRole(settings.role);
    const depth = Number.isFinite(Number(settings.depth)) ? Number(settings.depth) : 2;
    setExtensionPrompt(INJECT_KEY, text || '', extension_prompt_types.IN_CHAT, depth, false, role);
}

/** Clear any standing injection. */
export function clearInjection() {
    setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0);
}

function resolveRole(role) {
    switch (String(role).toLowerCase()) {
        case 'user': return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
        default: return extension_prompt_roles.SYSTEM;
    }
}
