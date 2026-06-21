/**
 * NPC Memory — consumer extension (Phase 1 + debug tooling).
 *
 * Reads World-Forge NPC manifests (or falls back to prose parsing), tracks
 * which NPCs are present each turn via World Info activation, maintains a
 * per-chat memory store keyed by stable NPC id, and selectively injects a
 * compact memory block for the present NPCs.
 *
 * Ships a debug surface (settings status, inspector popup, /npc-memory command,
 * verbose logging) to make the pipeline observable against real exports.
 *
 * See MEMORY_CONTRACT.md for the full producer/consumer contract.
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';

import { loadIndex } from './manifest-reader.js';
import { resolvePresence } from './resolver.js';
import { ensureRecord, save as saveStore, allRecords } from './store.js';
import { buildInjectionText, applyInjection, clearInjection } from './injector.js';
import { setVerbose, dlog, setIndex, setLastTurn, renderStatus, renderReport, renderReportText } from './debug.js';

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
    // Debug.
    debugLog: false,
};

/** In-memory index for the active chat (rebuilt on chat change). */
let index = null;

function settings() {
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const s = extension_settings[MODULE_NAME];
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
    setVerbose(s.debugLog);
}

/** Rebuild the NPC index from the current world info. */
async function refreshIndex() {
    index = await loadIndex();
    setIndex(index);
    dlog('index rebuilt', { npcs: index.byId.size, scenes: index.sceneByUid.size, books: index.manifests.length });
    updateStatusUI();
}

/**
 * WORLD_INFO_ACTIVATED handler: resolve present NPCs, ensure their store
 * records exist, inject their memory block, and record diagnostics. Runs (and
 * is awaited) before extension prompts are gathered, so the injection lands in
 * the same generation.
 *
 * @param {Array<object>} activatedEntries
 */
async function onWorldInfoActivated(activatedEntries) {
    if (!settings().enabled) return clearInjection();
    if (!index) await refreshIndex();

    const presence = resolvePresence(activatedEntries, index);
    dlog('activation', { entries: activatedEntries?.length ?? 0, mapping: presence.mapping });

    let injected = '';
    if (presence.npcIds.length > 0) {
        for (const id of presence.npcIds) {
            ensureRecord(id, { displayName: index.byId.get(id)?.displayName });
        }
        saveStore();
        injected = buildInjectionText(presence.npcIds, index, settings());
        applyInjection(injected, settings());
    } else {
        clearInjection();
    }

    setLastTurn({
        mapping: presence.mapping,
        npcIds: presence.npcIds,
        sceneId: presence.sceneId,
        injected,
    });
    updateStatusUI();
}

async function onChatChanged() {
    clearInjection();
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
    const bindCheckbox = (sel, key, after) => {
        $(sel).prop('checked', s[key]).on('input', function () {
            s[key] = !!$(this).prop('checked');
            if (after) after(s[key]);
            saveSettingsDebounced();
        });
    };

    bindCheckbox('#npcmem_enabled', 'enabled', (on) => { if (!on) clearInjection(); });
    bindCheckbox('#npcmem_announce', 'announcePresence');
    bindCheckbox('#npcmem_relationships', 'relationshipHints');
    bindCheckbox('#npcmem_debug', 'debugLog', (on) => setVerbose(on));

    $('#npcmem_depth').val(s.depth).on('input', function () {
        s.depth = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#npcmem_refresh').on('click', () => refreshIndex());
    $('#npcmem_inspect').on('click', () => openInspector());

    updateStatusUI();
}

function updateStatusUI() {
    const el = $('#npcmem_status');
    if (el.length === 0) return;
    el.html(renderStatus(allRecords()));
}

/* ------------------------------ inspector ------------------------------- */

async function openInspector() {
    if (!index) await refreshIndex();
    const html = `<div class="npcmem-report" style="text-align:left">${renderReport(allRecords(), settings())}</div>`;
    try {
        await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    } catch (err) {
        // Fallback: dump to console if the popup API shape differs.
        console.warn(`${LOG} inspector popup failed; logging report instead.`, err);
        console.log(renderReportText(allRecords()));
    }
}

function registerSlashCommand() {
    try {
        const ctx = getContext();
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'npc-memory',
            aliases: ['npcmem'],
            helpString: 'Open the NPC Memory diagnostics inspector.',
            callback: () => { openInspector(); return ''; },
        }));
        dlog('slash command /npc-memory registered.');
    } catch (err) {
        console.warn(`${LOG} could not register slash command.`, err);
    }
}

/* ------------------------------- bootstrap ------------------------------ */

export async function init() {
    loadSettings();
    await addSettingsPanel();
    registerSlashCommand();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);

    // Initial load if a chat is already open.
    if (getContext()?.getCurrentChatId?.()) await refreshIndex();

    console.info(`${LOG} initialized.`);
}
