/**
 * Presence resolver for the NPC Memory consumer (contract §7 actors, §9 scene).
 *
 * Given the World Info entries that activated for a turn and the current index,
 * determine which NPCs are present and which scene is active. `uid` is used only
 * as a within-lorebook pointer to map an activated entry back to its NPC/scene
 * (contract §4); it is never stored as identity.
 */

import { parseNpcComment } from './ids.js';

const LOG = '[npc-memory]';

/**
 * @typedef {object} Presence
 * @property {string[]} npcIds       Distinct NPC ids present this turn.
 * @property {string|null} sceneId   Active scene id, or null.
 * @property {object|null} scene     Active scene record, or null.
 */

/**
 * Resolve presence from activated WI entries against the index.
 *
 * @param {Array<object>} activatedEntries  Entries from WORLD_INFO_ACTIVATED.
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @returns {Presence}
 */
export function resolvePresence(activatedEntries, index) {
    const npcIds = new Set();
    let scene = null;

    for (const entry of Array.isArray(activatedEntries) ? activatedEntries : []) {
        const uid = Number(entry?.uid);

        // 1) Primary: map the activated uid through the index (manifest or prose).
        if (Number.isFinite(uid)) {
            const npcId = index.uidToNpcId.get(uid);
            if (npcId) {
                npcIds.add(npcId);
                continue;
            }
            const sceneRec = index.sceneByUid.get(uid);
            if (sceneRec) {
                // Last activated scene wins for this turn.
                scene = sceneRec;
                continue;
            }
        }

        // 2) Fallback: parse the comment directly. Covers entries present in the
        //    lorebook but absent from the index (e.g. a manifest that omits a uid).
        const parsed = parseNpcComment(entry?.comment);
        if (parsed && index.byId.has(parsed.id)) {
            npcIds.add(parsed.id);
        } else if (parsed && !index.fromManifest) {
            // Prose mode: trust the parsed id even if not pre-indexed.
            npcIds.add(parsed.id);
        }
    }

    const ids = Array.from(npcIds);
    if (ids.length > 0 || scene) {
        console.debug(`${LOG} present: [${ids.join(', ')}]${scene ? `, scene=${scene.id}` : ''}`);
    }

    return { npcIds: ids, sceneId: scene?.id ?? null, scene };
}
