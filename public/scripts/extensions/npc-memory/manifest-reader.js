/**
 * Manifest reader for the NPC Memory consumer (contract §3, §4).
 *
 * Locates the `[[NPC_MANIFEST]]` World Info entry among the loaded entries,
 * parses its JSON payload, and builds lookup indexes. Everything here is
 * tolerant of absence and malformed data: a missing or broken manifest yields
 * an empty index, never an error (contract §1, §10).
 */

import { getSortedEntries } from '../../world-info.js';
import { parseNpcComment, parseBeatComment, slugify } from './ids.js';

const LOG = '[npc-memory]';
const MANIFEST_MARKER = '[[NPC_MANIFEST]]';

/** The contract schema version this consumer understands. */
export const SUPPORTED_SCHEMA = 1;

/**
 * @typedef {object} NpcMemoryIndex
 * @property {object|null} manifest   The parsed manifest payload, or null.
 * @property {number} schema          Manifest schema (0 when no manifest).
 * @property {Map<string, object>} byId        npc id -> npc record.
 * @property {Map<number, string>} uidToNpcId  WI entry uid -> npc id.
 * @property {Map<number, object>} sceneByUid  WI entry uid -> scene record.
 * @property {object|null} personas   Manifest personas block, or null.
 * @property {boolean} fromManifest   True if backed by a real manifest.
 */

/** @returns {NpcMemoryIndex} an empty index (no manifest present). */
function emptyIndex() {
    return {
        manifest: null,
        schema: 0,
        byId: new Map(),
        uidToNpcId: new Map(),
        sceneByUid: new Map(),
        personas: null,
        fromManifest: false,
    };
}

/**
 * Find the manifest entry among loaded WI entries by marker (contract §3.1).
 * Disabled entries are present in the loaded data, so the marker scan works
 * even though `disable: true` keeps the entry out of prompts.
 *
 * @param {Array<object>} entries
 * @returns {object|null}
 */
function findManifestEntry(entries) {
    const matches = entries.filter(e => String(e?.comment ?? '').includes(MANIFEST_MARKER));
    if (matches.length === 0) return null;
    if (matches.length > 1) {
        console.warn(`${LOG} ${matches.length} manifest entries found; using the first.`);
    }
    return matches[0];
}

/**
 * Parse a manifest entry's content into a payload object.
 *
 * @param {object} entry
 * @returns {object|null} parsed payload, or null when unparseable.
 */
function parseManifestPayload(entry) {
    const raw = String(entry?.content ?? '').trim();
    if (!raw) return null;
    try {
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== 'object') {
            console.warn(`${LOG} manifest payload is not an object; ignoring.`);
            return null;
        }
        return payload;
    } catch (err) {
        console.warn(`${LOG} manifest JSON parse failed; ignoring.`, err);
        return null;
    }
}

/**
 * Build an index from a parsed manifest payload (contract §3.2, §3.3).
 *
 * @param {object} payload
 * @returns {NpcMemoryIndex}
 */
function indexFromManifest(payload) {
    const index = emptyIndex();
    index.manifest = payload;
    index.schema = Number(payload.schema) || 0;
    index.personas = payload.personas ?? null;
    index.fromManifest = true;

    if (index.schema > SUPPORTED_SCHEMA) {
        // Forward-compatible: consume what we know, ignore the rest (contract §1).
        console.info(`${LOG} manifest schema ${index.schema} > supported ${SUPPORTED_SCHEMA}; reading known fields only.`);
    }

    for (const npc of Array.isArray(payload.npcs) ? payload.npcs : []) {
        const id = String(npc?.id ?? '').trim() || slugify(npc?.displayName ?? '');
        if (!id) {
            console.warn(`${LOG} npc with no id/displayName skipped.`, npc);
            continue;
        }
        const record = {
            id,
            displayName: String(npc?.displayName ?? id),
            aliases: Array.isArray(npc?.aliases) ? npc.aliases.slice() : [],
            facets: (npc?.facets && typeof npc.facets === 'object') ? npc.facets : {},
            relationships: Array.isArray(npc?.relationships) ? npc.relationships : [],
            tags: Array.isArray(npc?.tags) ? npc.tags : [],
        };
        index.byId.set(id, record);

        // Map every facet source uid back to this npc (contract §4: uid is a
        // within-lorebook pointer, never an identity).
        for (const uid of Object.values(record.facets)) {
            const n = Number(uid);
            if (Number.isFinite(n)) index.uidToNpcId.set(n, id);
        }
    }

    for (const scene of Array.isArray(payload.scenes) ? payload.scenes : []) {
        const id = String(scene?.id ?? '').trim();
        if (!id) continue;
        const record = {
            id,
            uid: Number.isFinite(Number(scene?.uid)) ? Number(scene.uid) : null,
            arc: scene?.arc ?? null,
            seq: Number.isFinite(Number(scene?.seq)) ? Number(scene.seq) : null,
            title: scene?.title ?? null,
        };
        if (record.uid !== null) index.sceneByUid.set(record.uid, record);
    }

    return index;
}

/**
 * Build an index by prose-parsing bare lorebook entries (contract §10) when no
 * manifest is present. NPC records are derived from `NPC — Name (Facet)`
 * comments; aliases are the union of each facet entry's `key[]`.
 *
 * @param {Array<object>} entries
 * @returns {NpcMemoryIndex}
 */
function indexFromProse(entries) {
    const index = emptyIndex();

    for (const entry of entries) {
        const parsed = parseNpcComment(entry?.comment);
        if (parsed) {
            let record = index.byId.get(parsed.id);
            if (!record) {
                record = {
                    id: parsed.id,
                    displayName: parsed.name,
                    aliases: [],
                    facets: {},
                    relationships: [],
                    tags: [],
                };
                index.byId.set(parsed.id, record);
            }
            // Union aliases from this facet entry's keys (contract §10).
            for (const k of Array.isArray(entry?.key) ? entry.key : []) {
                if (k && !record.aliases.includes(k)) record.aliases.push(k);
            }
            const uid = Number(entry?.uid);
            if (Number.isFinite(uid)) {
                record.facets[parsed.facetType] = uid;
                index.uidToNpcId.set(uid, parsed.id);
            }
            continue;
        }

        const beat = parseBeatComment(entry?.comment);
        if (beat) {
            const uid = Number(entry?.uid);
            const id = slugify(beat.title);
            if (id) {
                index.sceneByUid.set(Number.isFinite(uid) ? uid : -1, {
                    id, uid: Number.isFinite(uid) ? uid : null, arc: null, seq: null, title: beat.title,
                });
            }
        }
    }

    if (index.byId.size > 0) {
        console.info(`${LOG} no manifest; derived ${index.byId.size} NPC(s) via prose fallback.`);
    }
    return index;
}

/**
 * Load the current NPC index from world info: prefer the manifest, fall back to
 * prose parsing, and finally an empty index. Never throws.
 *
 * @returns {Promise<NpcMemoryIndex>}
 */
export async function loadIndex() {
    let entries;
    try {
        entries = await getSortedEntries();
    } catch (err) {
        console.warn(`${LOG} could not load world info entries.`, err);
        return emptyIndex();
    }
    if (!Array.isArray(entries) || entries.length === 0) return emptyIndex();

    const manifestEntry = findManifestEntry(entries);
    if (manifestEntry) {
        const payload = parseManifestPayload(manifestEntry);
        if (payload) {
            const index = indexFromManifest(payload);
            console.info(`${LOG} loaded manifest schema ${index.schema}: ${index.byId.size} NPC(s), ${index.sceneByUid.size} scene(s).`);
            return index;
        }
    }

    return indexFromProse(entries);
}
