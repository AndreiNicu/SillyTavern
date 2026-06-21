/**
 * Presence resolver for the NPC Memory consumer (contract §7 actors, §9 scene).
 *
 * Given the World Info entries that activated for a turn and the current index,
 * determine which NPCs are present and which scene is active. `uid` is only a
 * within-book pointer (contract §4), so each activated entry is mapped through
 * the composite worldKey(entry.world, entry.uid). A per-entry `mapping` is
 * returned for debugging (resolved vs. unresolved activations).
 */

import { parseNpcComment } from './ids.js';
import { worldKey } from './manifest-reader.js';

const LOG = '[npc-memory]';

// Recognized non-NPC structural lore comment prefixes. Entries matching these
// are intentionally ignored (world/state/tension lore), as opposed to genuinely
// unknown entries. Used only to label the debug mapping clearly.
const STRUCTURAL_RE = /^\s*(Location|WORLD_PULSE|SANDBOX_STATE|TENSION|NPC_SHIFT|ARC|[A-Z][A-Z0-9]*_STATE)\b/i;

/**
 * @typedef {object} EntryMapping
 * @property {string} world
 * @property {number|string} uid
 * @property {string} comment
 * @property {'npc'|'scene'|'ignored'|'unresolved'} kind
 * @property {string|null} id    Resolved npc/scene id, or null.
 * @property {string} via        How it resolved: 'uid' | 'comment' | ''.
 */

/**
 * @typedef {object} Presence
 * @property {string[]} npcIds        Distinct NPC ids present this turn.
 * @property {string|null} sceneId    Active scene id, or null.
 * @property {object|null} scene      Active scene record, or null.
 * @property {EntryMapping[]} mapping Per-activated-entry resolution (debug).
 */

/**
 * Resolve presence from activated WI entries against the index.
 * @param {Array<object>} activatedEntries  Entries from WORLD_INFO_ACTIVATED.
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @returns {Presence}
 */
export function resolvePresence(activatedEntries, index) {
    const npcIds = new Set();
    const mapping = [];
    let scene = null;

    for (const entry of Array.isArray(activatedEntries) ? activatedEntries : []) {
        const world = entry?.world ?? '';
        const uid = entry?.uid;
        const comment = String(entry?.comment ?? '');
        const key = worldKey(world, uid);

        // 1) Primary: map the activated entry through its book-scoped uid.
        const npcId = index.uidToNpcId.get(key);
        if (npcId) {
            npcIds.add(npcId);
            mapping.push({ world, uid, comment, kind: 'npc', id: npcId, via: 'uid' });
            continue;
        }
        const sceneRec = index.sceneByUid.get(key);
        if (sceneRec) {
            scene = sceneRec; // Last activated scene wins for this turn.
            mapping.push({ world, uid, comment, kind: 'scene', id: sceneRec.id, via: 'uid' });
            continue;
        }

        // 2) Fallback: parse the comment directly (covers entries not in index).
        const parsed = parseNpcComment(comment);
        if (parsed && (index.byId.has(parsed.id) || !index.fromManifest)) {
            npcIds.add(parsed.id);
            mapping.push({ world, uid, comment, kind: 'npc', id: parsed.id, via: 'comment' });
            continue;
        }

        // Not an NPC/scene: distinguish recognized non-NPC lore (ignored) from
        // genuinely unknown entries (unresolved) for clearer diagnostics.
        const kind = STRUCTURAL_RE.test(comment) ? 'ignored' : 'unresolved';
        mapping.push({ world, uid, comment, kind, id: null, via: '' });
    }

    const ids = Array.from(npcIds);
    if (ids.length > 0 || scene) {
        console.debug(`${LOG} present: [${ids.join(', ')}]${scene ? `, scene=${scene.id}` : ''}`);
    }

    return { npcIds: ids, sceneId: scene?.id ?? null, scene, mapping };
}
