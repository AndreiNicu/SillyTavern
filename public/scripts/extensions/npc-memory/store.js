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

/** Max events retained per NPC (oldest dropped beyond this). */
const MAX_EVENTS = 50;
/** Max characters kept in a slot summary snippet (placeholder display). */
const SUMMARY_LEN = 220;
/** Max characters of cleaned prose retained per event (summarizer input). */
const EVENT_TEXT_LEN = 600;

/**
 * Condense message prose into a single line: drop markdown emphasis and quotes,
 * collapse whitespace, truncate to `len`.
 * @param {string} text
 * @param {number} [len]
 * @returns {string}
 */
export function snippet(text, len = SUMMARY_LEN) {
    let s = String(text ?? '')
        .replace(/[*_`>#~]/g, ' ')
        .replace(/["'""'']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length > len) s = s.slice(0, len - 1).trimEnd() + '…';
    return s;
}

/** Records with at least one event not yet folded into an LLM summary. */
export function pendingCount() {
    return root().pending || 0;
}

/** Increment the captured-message counter; returns the new value. */
export function bumpPending() {
    const s = root();
    s.pending = (s.pending || 0) + 1;
    return s.pending;
}

/** Reset the captured-message counter (after a summary batch runs). */
export function resetPending() {
    root().pending = 0;
}

/**
 * Record a captured event against an NPC and update its memory slot
 * (contract §6: withUser -> lastWithUser, else lastAlone).
 *
 * @param {string} id            NPC stable id.
 * @param {object} ev            { withUser, scene, location, text, source, ts }.
 * @param {{ displayName?: string }} [meta]
 * @returns {NpcRecord}
 */
export function recordEvent(id, ev, meta = {}) {
    const rec = ensureRecord(id, meta);
    const ts = ev.ts ?? Date.now();

    const event = {
        ts,
        withUser: !!ev.withUser,
        scene: ev.scene ?? null,
        location: ev.location ?? '',
        source: ev.source ?? 'model',
        text: snippet(ev.text, EVENT_TEXT_LEN),
        summarized: false,
    };
    rec.events.push(event);
    if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);

    // Placeholder slot from the raw snippet; an LLM batch summary (summarize.js)
    // overwrites this with a real recap and sets kind: 'llm'.
    const slot = { ts, summary: snippet(ev.text), scene: event.scene, location: event.location, source: event.source, kind: 'snippet' };
    if (rec.slots[event.withUser ? 'lastWithUser' : 'lastAlone']?.kind !== 'llm') {
        rec.slots[event.withUser ? 'lastWithUser' : 'lastAlone'] = slot;
    } else {
        // Keep the LLM summary; just refresh the timestamp until next batch.
        rec.slots[event.withUser ? 'lastWithUser' : 'lastAlone'].ts = ts;
    }

    rec.updatedAt = ts;
    return rec;
}
