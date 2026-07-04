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
import { resolveNameToId } from './turntag.js';
import { ensureRecord, save as saveStore, allRecords, getRecord, bumpPending, resetPending, pendingCount, clearAll, getCompress } from './store.js';
import { buildInjectionText, applyInjection, clearInjection } from './injector.js';
import { captureFromMessage } from './capture.js';
import { runBatchSummary } from './summarize.js';
import { compressChat, uncompressChat, applyRecapFromMarker } from './compress.js';
import { setVerbose, dlog, setIndex, setLastTurn, setLastCapture, renderStatus, renderReport, renderReportText } from './debug.js';

const MODULE_NAME = 'npc-memory';
const LOG = '[npc-memory]';

const defaultSettings = {
    enabled: true,
    // Whether the memory block is injected into the prompt (capture still runs).
    inject: true,
    // Injection placement.
    depth: 2,
    role: 'system',
    maxNpcs: 6,
    // Rescan: how many trailing messages to reinitialize memory from.
    rescanCount: 50,
    // Content toggles.
    relationshipHints: true,
    announcePresence: true,
    // Turn-tag loop (contract §7).
    emitTag: true,
    stripTags: true,
    // Batched summarization (contract §9).
    summarize: true,
    summarizeEvery: 4,
    summaryTokens: 512,
    summaryProfile: '', // connection profile id; '' = use main generation API
    // Long-term memory tier (durable key moments).
    longTermMemory: true,
    maxLongTerm: 10,
    relevanceRetrieval: true, // retrieve long-term by relevance, not recency
    relevanceWindow: 3,       // recent messages used to build the relevance query
    // Inject the "now" recap only for NPCs the World-Forge scene tracker lists
    // as present (falls back to activation when no scene roster is available).
    sceneGating: true,
    // Chat compression / checkpoint.
    compressEnabled: true,
    compressKeepLast: 8, // keep the last ~4 exchanges (8 messages) visible
    compressTokens: 400,

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
    if (!settings().enabled) return void await clearInjection();
    if (!index) await refreshIndex();

    const presence = resolvePresence(activatedEntries, index);
    dlog('activation', { entries: activatedEntries?.length ?? 0, mapping: presence.mapping });

    // Authoritative scene roster from the World-Forge scene tracker (if used).
    const sceneIds = settings().sceneGating ? scenePresentIds(index) : null;
    const useScene = !!(sceneIds && sceneIds.size > 0);

    // Candidates = activated (mentioned/relevant) NPCs, plus any in-scene NPCs
    // whose keywords didn't fire this turn so their "now" still injects.
    const candidates = presence.npcIds.slice();
    if (useScene) {
        for (const id of sceneIds) {
            if (index.byId.has(id) && !candidates.includes(id)) candidates.push(id);
        }
    }

    let injected = '';
    if (candidates.length > 0) {
        for (const id of candidates) {
            ensureRecord(id, { displayName: index.byId.get(id)?.displayName });
        }
        saveStore();
        if (settings().inject) {
            const ctx = getContext();
            const personaName = ctx?.name1 || index.personas?.user?.name || '';
            const queryText = recentQueryText(ctx);
            injected = buildInjectionText(candidates, index, settings(), getRecord, {
                sceneId: presence.sceneId, personaName, queryText,
                inSceneIds: useScene ? sceneIds : null,
            });
            await applyInjection(injected, settings());
        } else {
            await clearInjection();
        }
    } else {
        await clearInjection();
    }

    setLastTurn({
        mapping: presence.mapping,
        npcIds: candidates,
        inScene: useScene ? [...sceneIds] : null,
        sceneId: presence.sceneId,
        injected,
    });
    updateStatusUI();
}

/**
 * Read the authoritative scene roster from the World-Forge scene tracker
 * (chat_metadata.world_forge_scene.present), mapping present character/NPC names
 * to our stable ids. Returns a Set (possibly empty), or null when no scene
 * record exists (so callers can fall back to activation-based presence).
 * @param {import('./manifest-reader.js').NpcMemoryIndex} idx
 * @returns {Set<string>|null}
 */
function scenePresentIds(idx) {
    const scene = getContext()?.chatMetadata?.world_forge_scene;
    if (!scene || !Array.isArray(scene.present)) return null;
    const ids = new Set();
    for (const p of scene.present) {
        if (!p || (p.role !== 'npc' && p.role !== 'character')) continue;
        const id = resolveNameToId(p.name, idx);
        if (id) ids.add(id);
    }
    return ids;
}

/**
 * CHARACTER_MESSAGE_RENDERED handler: capture the turn tag (or infer one) from
 * the finalized character message into the per-NPC store, and strip the tag.
 * @param {number} messageId
 */
async function onCharacterMessage(messageId) {
    if (!settings().enabled) return;
    if (!index) await refreshIndex();
    try {
        // Restrict prose-mention actor inference to the live scene roster (when
        // the World-Forge Scene Tracker provides one) so a name merely mentioned
        // in narration isn't credited with acting this turn (contract §6).
        const presentIds = settings().sceneGating ? scenePresentIds(index) : null;
        const result = captureFromMessage(messageId, index, settings(), getContext(), false, presentIds);
        if (result) setLastCapture(result);
        saveStore();

        // Batched summarization: every N captured messages, fold pending events
        // into real per-NPC recaps (contract §9).
        if (settings().summarize && result) {
            const n = bumpPending();
            const every = Number(settings().summarizeEvery) > 0 ? Number(settings().summarizeEvery) : 4;
            if (n >= every) {
                resetPending();
                const personaName = getContext()?.name1 || index.personas?.user?.name || '';
                await runBatchSummary(getContext(), settings(), personaName);
                saveStore();
            }
        }
        updateStatusUI();
    } catch (err) {
        console.warn(`${LOG} capture failed for message ${messageId}.`, err);
    }
}

/**
 * Build the relevance query from the most recent conversation turns (the
 * strongest signal for what the current moment is about).
 * @param {object} ctx  getContext() result.
 * @returns {string}
 */
function recentQueryText(ctx) {
    const chat = ctx?.chat ?? [];
    const n = Number(settings().relevanceWindow) > 0 ? Number(settings().relevanceWindow) : 3;
    return chat.filter(m => m && !m.is_system).slice(-n).map(m => String(m.mes ?? '')).join('\n');
}

async function onChatChanged() {
    clearInjection();
    await refreshIndex();
    // Re-assert the compression recap for the newly-loaded chat (or clear it).
    applyRecapFromMarker(settings());
}

/** Minimum chat length before compression is worthwhile. */
const MIN_COMPRESS_MESSAGES = 20;

async function compressNow() {
    const ctx = getContext();
    const total = (ctx?.chat ?? []).length;
    if (total < MIN_COMPRESS_MESSAGES) {
        toast(`Too few messages to compress (${total}). Need at least ${MIN_COMPRESS_MESSAGES} for a useful recap.`);
        return;
    }
    const done = progressToast('Compressing chat… summarizing memory.');
    let res;
    try {
        res = await compressChat(ctx, settings());
    } finally {
        done();
    }
    if (res.ok) toast(`Compressed ${res.hidden} message(s) into a recap; kept the last ${res.kept} for context.`);
    else toast(`Nothing compressed (${res.reason}).`);
    updateStatusUI();
}

async function uncompressNow() {
    const res = await uncompressChat(getContext());
    toast(res.ok ? 'Compression undone; messages restored.' : 'No active compression.');
    updateStatusUI();
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
    bindCheckbox('#npcmem_inject', 'inject', (on) => { if (!on) clearInjection(); });
    bindCheckbox('#npcmem_announce', 'announcePresence');
    bindCheckbox('#npcmem_relationships', 'relationshipHints');
    bindCheckbox('#npcmem_emittag', 'emitTag');
    bindCheckbox('#npcmem_striptags', 'stripTags');
    bindCheckbox('#npcmem_debug', 'debugLog', (on) => setVerbose(on));

    bindCheckbox('#npcmem_summarize', 'summarize');
    bindCheckbox('#npcmem_longterm', 'longTermMemory');
    bindCheckbox('#npcmem_relevance', 'relevanceRetrieval');
    bindCheckbox('#npcmem_scenegating', 'sceneGating');
    $('#npcmem_depth').val(s.depth).on('input', function () {
        s.depth = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#npcmem_every').val(s.summarizeEvery).on('input', function () {
        s.summarizeEvery = Math.max(1, Number($(this).val()) || 1);
        saveSettingsDebounced();
    });
    $('#npcmem_summary_tokens').val(s.summaryTokens).on('input', function () {
        s.summaryTokens = Math.max(64, Number($(this).val()) || 512);
        saveSettingsDebounced();
    });
    renderProfileOptions(s.summaryProfile);
    $('#npcmem_summary_profile').on('change', function () {
        s.summaryProfile = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#npcmem_rescan_n').val(s.rescanCount).on('input', function () {
        s.rescanCount = Math.max(1, Number($(this).val()) || 1);
        saveSettingsDebounced();
    });
    $('#npcmem_keeplast').val(s.compressKeepLast).on('input', function () {
        s.compressKeepLast = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });
    $('#npcmem_refresh').on('click', () => refreshIndex());
    $('#npcmem_inspect').on('click', () => openInspector());
    $('#npcmem_rescan').on('click', () => rescanMemory());
    $('#npcmem_compress').on('click', () => compressNow());
    $('#npcmem_uncompress').on('click', () => uncompressNow());

    updateStatusUI();
}

/**
 * Reinitialize the per-NPC memory by re-capturing the last N chat messages.
 * Clears existing stored memory first, then re-runs capture (forced) and a
 * summary batch. Useful to bootstrap memory from a chat that predates the
 * extension, or after changing settings.
 */
async function rescanMemory() {
    // Reload the manifest/index first, in case lorebooks changed.
    await refreshIndex();
    const ctx = getContext();
    const chat = ctx?.chat ?? [];
    if (chat.length === 0) {
        toast('No messages to rescan.');
        return;
    }
    const n = Math.max(1, Number(settings().rescanCount) || 50);
    const start = Math.max(0, chat.length - n);

    const confirmed = await callGenericPopup(
        `Reinitialize NPC memory from the last ${chat.length - start} message(s)? This clears the current stored memory for this chat.`,
        POPUP_TYPE.CONFIRM,
    );
    if (!confirmed) return;

    const done = progressToast('Rescanning… reinitializing NPC memory.');
    let captured = 0;
    try {
        clearAll();
        for (let i = start; i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_user || m.is_system) continue;
            if (captureFromMessage(i, index, settings(), ctx, true)) captured++;
        }

        if (settings().summarize && captured > 0) {
            const personaName = ctx?.name1 || index.personas?.user?.name || '';
            await runBatchSummary(ctx, settings(), personaName);
        }
        resetPending();
        saveStore();
    } finally {
        done();
    }
    updateStatusUI();
    toast(`Rescanned ${captured} message(s); memory reinitialized.`);
}

/**
 * Show a sticky "in progress" toast for a long-running action. Returns a
 * function that dismisses it (call when the action finishes, before the
 * "done" toast). No-ops gracefully if toastr is unavailable.
 * @param {string} msg
 * @returns {() => void}
 */
function progressToast(msg) {
    if (typeof toastr === 'undefined') { console.info(`${LOG} ${msg}`); return () => {}; }
    const el = toastr.info(msg, 'NPC Memory', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    return () => { try { toastr.clear(el); } catch { /* noop */ } };
}

function toast(msg) {
    if (typeof toastr !== 'undefined') toastr.info(msg, 'NPC Memory');
    else console.info(`${LOG} ${msg}`);
}

/**
 * Populate the summarization connection-profile dropdown from the Connection
 * Manager's profile list (mirrors the lorebook LLM-filter profile selector).
 * @param {string} selectedId
 */
function renderProfileOptions(selectedId) {
    const select = document.getElementById('npcmem_summary_profile');
    if (!select) return;
    const profiles = extension_settings?.connectionManager?.profiles ?? [];
    select.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = profiles.length ? 'Main generation API (default)' : 'Connection Manager unavailable';
    select.appendChild(def);
    for (const p of [...profiles].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
    }
    select.value = selectedId && profiles.some(p => p.id === selectedId) ? selectedId : '';
}

function updateStatusUI() {
    const el = $('#npcmem_status');
    if (el.length === 0) return;
    let html = renderStatus(allRecords());
    if (settings().summarize) {
        const every = Number(settings().summarizeEvery) > 0 ? Number(settings().summarizeEvery) : 4;
        const profId = settings().summaryProfile;
        const profName = profId
            ? (extension_settings?.connectionManager?.profiles?.find(p => p.id === profId)?.name ?? profId)
            : 'main API';
        html += `<br><small>Summary batch: <b>${pendingCount()}/${every}</b> messages · via <b>${profName}</b></small>`;
    }
    const cmp = getCompress();
    if (cmp) {
        html += `<br><small>Compressed: <b>${cmp.cutMesId + 1}</b> message(s) hidden · recap active</small>`;
    }
    el.html(html);
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
    // makeLast so the message is fully finalized/rendered before we capture.
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessage);

    // Initial load if a chat is already open.
    if (getContext()?.getCurrentChatId?.()) {
        await refreshIndex();
        applyRecapFromMarker(settings());
    }

    console.info(`${LOG} initialized.`);
}
