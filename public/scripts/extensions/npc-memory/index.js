/**
 * NPC Memory — consumer extension (Phase 1).
 *
 * Reads a World-Forge NPC manifest (or falls back to prose parsing), tracks
 * which NPCs are present each turn via World Info activation, maintains a
 * per-chat memory store keyed by stable NPC id, and selectively injects a
 * compact memory block for the present NPCs.
 *
 * See MEMORY_CONTRACT.md for the full producer/consumer contract.
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';

import { loadIndex } from './manifest-reader.js';
import { resolvePresence } from './resolver.js';
import { ensureRecord, save as saveStore, allRecords } from './store.js';
import { buildInjectionText, applyInjection, clearInjection } from './injector.js';

const MODULE_NAME = 'npc-memory';
const LOG = '[npc-memory]';

const defaultSettings = {
    enabled: true,
    // Injection placement.
    depth: 2,
    role: 'system',
    maxNpcs: 6,
    // Content toggles.
    relationshipHints: true,
    announcePresence: true,
};

/** In-memory index for the active chat (rebuilt on chat change). */
let index = null;
/** Last resolved presence, for diagnostics/UI. */
let lastPresence = { npcIds: [], sceneId: null };

function settings() {
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const s = extension_settings[MODULE_NAME];
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
}

/** Rebuild the NPC index from the current world info. */
async function refreshIndex() {
    index = await loadIndex();
    updateStatusUI();
}

/**
 * WORLD_INFO_ACTIVATED handler: resolve present NPCs, ensure their store
 * records exist, and inject their memory block for this generation.
 *
 * @param {Array<object>} activatedEntries
 */
async function onWorldInfoActivated(activatedEntries) {
    if (!settings().enabled) return clearInjection();
    if (!index) await refreshIndex();

    const presence = resolvePresence(activatedEntries, index);
    lastPresence = presence;

    if (presence.npcIds.length === 0) {
        clearInjection();
        updateStatusUI();
        return;
    }

    // Ensure a store record exists for each present NPC (keyed by stable id).
    for (const id of presence.npcIds) {
        ensureRecord(id, { displayName: index.byId.get(id)?.displayName });
    }
    saveStore();

    const text = buildInjectionText(presence.npcIds, index, settings());
    applyInjection(text, settings());
    updateStatusUI();
}

async function onChatChanged() {
    clearInjection();
    lastPresence = { npcIds: [], sceneId: null };
    await refreshIndex();
}

/* ----------------------------- settings UI ------------------------------ */

async function addSettingsPanel() {
    try {
        const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
        $('#extensions_settings').append(html);
    } catch (err) {
        console.warn(`${LOG} settings panel failed to render.`, err);
        return;
    }

    const s = settings();
    $('#npcmem_enabled').prop('checked', s.enabled).on('input', function () {
        s.enabled = !!$(this).prop('checked');
        if (!s.enabled) clearInjection();
        saveSettingsDebounced();
    });
    $('#npcmem_announce').prop('checked', s.announcePresence).on('input', function () {
        s.announcePresence = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#npcmem_relationships').prop('checked', s.relationshipHints).on('input', function () {
        s.relationshipHints = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#npcmem_depth').val(s.depth).on('input', function () {
        s.depth = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#npcmem_refresh').on('click', () => refreshIndex());

    updateStatusUI();
}

function updateStatusUI() {
    const status = $('#npcmem_status');
    if (status.length === 0) return;
    const src = index?.fromManifest ? `manifest (schema ${index.schema})` : (index?.byId.size ? 'prose fallback' : 'none');
    const npcCount = index ? index.byId.size : 0;
    const stored = Object.keys(allRecords()).length;
    const present = lastPresence.npcIds
        .map(id => index?.byId.get(id)?.displayName ?? id)
        .join(', ') || '—';
    status.html(
        `Source: <b>${src}</b><br>` +
        `NPCs known: <b>${npcCount}</b> · stored: <b>${stored}</b><br>` +
        `Present last turn: <b>${present}</b>` +
        (lastPresence.sceneId ? `<br>Scene: <b>${lastPresence.sceneId}</b>` : ''),
    );
}

/* ------------------------------- bootstrap ------------------------------ */

export async function init() {
    loadSettings();
    await addSettingsPanel();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);

    // Initial load if a chat is already open.
    if (getContext()?.getCurrentChatId?.()) await refreshIndex();

    console.info(`${LOG} initialized.`);
}
