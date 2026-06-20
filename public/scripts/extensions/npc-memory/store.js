/**
 * Per-chat NPC memory store (contract §4: memory is keyed by stable `id`,
 * never by `uid`).
 *
 * State lives in `chat_metadata.npcMemory` so it travels with the chat and is
 * persisted by SillyTavern's chat save. Phase 1 establishes the record shape
 * and lifecycle; event capture and slot population arrive in later phases, so
 * `slots`/`events` are created empty and ready.
 */

import { chat_metadata, saveMetadata } from '../../../script.js';
import { saveMetadataDebounced } from '../../extensions.js';

const STORE_KEY = 'npcMemory';
const STORE_VERSION = 1;

/**
 * @typedef {object} NpcRecord
 * @property {string} id
 * @property {string} displayName
 * @property {boolean} seeded            Reserved for schema 2 seeding.
 * @property {object} slots              { lastWithUser, lastAlone } memory slots.
 * @property {Array<object>} events      Captured events (populated later).
 * @property {number} firstSeen          Timestamp first encountered.
 * @property {number} updatedAt          Timestamp last touched.
 */

/**
 * Get (creating if needed) the store root inside chat_metadata.
 * @returns {{ v: number, npcs: Object<string, NpcRecord> }}
 */
function root() {
    let store = chat_metadata[STORE_KEY];
    if (!store || typeof store !== 'object') {
        store = { v: STORE_VERSION, npcs: {} };
        chat_metadata[STORE_KEY] = store;
    }
    if (!store.npcs || typeof store.npcs !== 'object') store.npcs = {};
    if (typeof store.v !== 'number') store.v = STORE_VERSION;
    return store;
}

/**
 * Get an NPC record by stable id, or undefined if not yet stored.
 * @param {string} id
 * @returns {NpcRecord|undefined}
 */
export function getRecord(id) {
    return root().npcs[id];
}

/** @returns {Object<string, NpcRecord>} all stored records, keyed by id. */
export function allRecords() {
    return root().npcs;
}

/**
 * Ensure a record exists for an NPC, creating an empty one from index metadata.
 * Does not overwrite existing memory; only refreshes the display name.
 *
 * @param {string} id
 * @param {{ displayName?: string }} [meta]
 * @returns {NpcRecord}
 */
export function ensureRecord(id, meta = {}) {
    const store = root();
    let rec = store.npcs[id];
    const now = Date.now();
    if (!rec) {
        rec = {
            id,
            displayName: meta.displayName || id,
            seeded: false,
            slots: { lastWithUser: null, lastAlone: null },
            events: [],
            firstSeen: now,
            updatedAt: now,
        };
        store.npcs[id] = rec;
    } else if (meta.displayName && rec.displayName !== meta.displayName) {
        rec.displayName = meta.displayName;
        rec.updatedAt = now;
    }
    return rec;
}

/** Persist the store (debounced). Use for high-frequency updates. */
export function save() {
    saveMetadataDebounced();
}

/** Persist the store immediately. Use on lifecycle boundaries. */
export async function saveNow() {
    await saveMetadata();
}
