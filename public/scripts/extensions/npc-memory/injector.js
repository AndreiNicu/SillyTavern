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

    // Whether an authoritative scene roster is available. Without one (e.g. the
    // first turns of a fresh chat, before the Scene Tracker has scanned), the
    // candidate list only means "activated/mentioned this turn" — it must not be
    // presented to the model as physical presence.
    const hasRoster = !!(extra.inSceneIds && extra.inSceneIds.size > 0);

    // Per-NPC memory: rolling "now" recap (contract §6) plus long-term key
    // moments, retrieved by relevance to the current moment (not just recency).
    // The "now" recap is only injected for NPCs actually in the scene (when a
    // scene roster is provided); long-term facts are gated by relevance instead.
    const maxLT = Number(settings.maxLongTerm) > 0 ? Number(settings.maxLongTerm) : 10;
    for (const id of present) {
        const meta = index.byId.get(id);
        const name = meta?.displayName ?? id;
        const rec = getRecord(id);
        const inScene = !hasRoster || extra.inSceneIds.has(id);
        // Without a roster, mention-inferred snippet recaps are double guesswork
        // (guessed actor + unconfirmed presence): a greeting that merely names an
        // NPC would otherwise inject "<NPC> (now): with you: …" for someone who
        // never acted. Only confident recaps (model/card tags, LLM summaries)
        // are injected until presence is known.
        const now = inScene ? summarizeRecord(rec, !hasRoster) : '';
        if (now) lines.push(`- ${name} (now): ${now}`);
        if (settings.longTermMemory !== false) {
            const facts = relevantLongTerm(rec, settings, extra, maxLT);
            if (facts.length) lines.push(`- ${name} (remembers): ${facts.join(' | ')}`);
        }
    }

    // Relationship hints among co-present NPCs (contract §8). "Co-present"
    // needs the scene roster: without one, hints among merely-mentioned NPCs
    // read like scene state (models parse "A → B" as A acting on B) and imply
    // absent NPCs are around.
    if (settings.relationshipHints !== false && hasRoster) {
        const coPresent = present.filter(id => extra.inSceneIds.has(id));
        for (const line of relationshipHints(coPresent, index)) lines.push(line);
    }

    // Presence roster (optional; useful for verifying the pipeline). "Present:"
    // is only claimed from the authoritative scene roster; anything else is
    // labeled as mentioned/relevant so the model doesn't spawn absent NPCs.
    if (settings.announcePresence) {
        const nameOf = id => index.byId.get(id)?.displayName ?? id;
        const header = [];
        if (hasRoster) {
            const inScene = present.filter(id => extra.inSceneIds.has(id)).map(nameOf);
            const offScene = present.filter(id => !extra.inSceneIds.has(id)).map(nameOf);
            if (inScene.length) header.push(`Present: ${inScene.join(', ')}.`);
            if (offScene.length) header.push(`Mentioned, not in scene: ${offScene.join(', ')}.`);
        } else if (present.length) {
            header.push(`NPCs this turn (mentioned or relevant — not necessarily in the scene): ${present.map(nameOf).join(', ')}.`);
        }
        lines.unshift(...header);
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
 * @param {boolean} [confidentOnly]  Skip slots that came from mention-inferred
 *   snippets (kind 'snippet' + source 'inferred') — used while no scene roster
 *   confirms the NPC's presence. Slots from turn tags or LLM summaries pass.
 * @returns {string}
 */
function summarizeRecord(rec, confidentOnly = false) {
    if (!rec) return '';
    const usable = (slot) => slot?.summary
        && (!confidentOnly || slot.kind !== 'snippet' || slot.source !== 'inferred');
    const parts = [];
    if (usable(rec.slots?.lastWithUser)) parts.push(`with you: ${rec.slots.lastWithUser.summary}`);
    if (usable(rec.slots?.lastAlone)) parts.push(`recently: ${rec.slots.lastAlone.summary}`);
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
            // "Relationship:" keeps the model from reading the arrow as an
            // action ("A did something to B") instead of a standing relation.
            out.push(`- Relationship: ${a} → ${b}${kind}${note}`);
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
