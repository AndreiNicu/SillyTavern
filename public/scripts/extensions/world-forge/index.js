import { eventSource, event_types, this_chid, characters, substituteParams, chat, name1, getCurrentChatId } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { ConnectionManagerRequestService } from '../shared.js';
import {
    loadWorldInfo,
    saveWorldInfo,
    createWorldInfoEntry,
    reloadEditor,
    world_info_llm_filter_profile,
} from '../../world-info.js';

const SETTINGS_KEY = 'world_forge';
const STYLE_CONTRACT_CLOSE = '</style_contract>';

// ---------------------------------------------------------------------------
// Key Moments — small-LLM driven recorder that distils recent chat into
// concise entries inside the chat-bound lorebook. Reuses the same secondary
// LLM connection profile as the World Info "LLM Filter" feature.
// ---------------------------------------------------------------------------
const KM_EXTRACT_MAX_TOKENS = 1024;
const KM_SUMMARIZE_MAX_TOKENS = 1536;
const KM_MAX_CANDIDATES = 8;

const DEFAULT_EXTRACT_PROMPT = [
    'You are analysing a roleplay/story transcript to spot KEY MOMENTS worth recording in a long-term memory lorebook.',
    'Key moments are things like: a newly developed character trait, an important plot development, a relationship change,',
    'a decision, a revelation, a gained/lost ability, or any notable event the story should remember later.',
    '',
    `Read the recent messages and list the distinct key moments you find (at most ${KM_MAX_CANDIDATES}).`,
    'Reply with ONLY a JSON array of short one-line strings, each summarising one candidate key moment.',
    'If nothing significant happened, reply with an empty array: [].',
].join('\n');

const DEFAULT_SUMMARIZE_PROMPT = [
    'You are recording selected key moments into a memory lorebook.',
    'For EACH selected key moment, write a concise, on-point description (1-3 sentences) capturing what happened and why it matters later,',
    'and provide 1-5 short trigger keywords (names, places, objects, concepts) that should make this memory resurface.',
    'Keep descriptions factual and self-contained — they will be read out of chat context.',
    '',
    'Reply with ONLY a JSON array of objects in this exact shape:',
    '[{"title": "short label", "content": "the description", "keywords": ["kw1", "kw2"]}]',
].join('\n');

const reasoningTagRegex = /<(?:think|thinking|thought|reasoning)>[\s\S]*?<\/(?:think|thinking|thought|reasoning)>/gi;

let $kmOverlay = null;
let $kmStatus = null;
let $kmCandidates = null;
let $kmNotes = null;
let $kmRecord = null;
let kmBusy = false;

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }
    const s = extension_settings[SETTINGS_KEY];
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (typeof s.debug !== 'boolean') s.debug = true;
    if (typeof s.keyMomentsEnabled !== 'boolean') s.keyMomentsEnabled = true;
    if (typeof s.contextMessages !== 'number' || !Number.isFinite(s.contextMessages)) s.contextMessages = 10;
    s.contextMessages = Math.max(1, Math.min(50, Math.round(s.contextMessages)));
    return s;
}

function log(...args) {
    if (getSettings().debug) console.log('[world-forge]', ...args);
}

function warn(...args) {
    console.warn('[world-forge]', ...args);
}

// ----------------------------- style_override ------------------------------

function buildOverrideBlock(styleOverride) {
    if (!styleOverride || typeof styleOverride !== 'object') {
        return { block: '', applied: [], skipped: [] };
    }

    const directives = Array.isArray(styleOverride.directives)
        ? styleOverride.directives.filter(s => typeof s === 'string' && s.trim().length > 0)
        : [];

    if (directives.length === 0) {
        return { block: '', applied: [], skipped: [] };
    }

    const applied = directives.map(line => {
        const colonIdx = line.indexOf(':');
        return colonIdx > 0 ? line.slice(0, colonIdx).trim() : line;
    });

    return {
        block: `<style_override>\n${directives.join('\n')}\n</style_override>`,
        applied,
        skipped: [],
    };
}

function getActiveCharacter() {
    const idx = this_chid;
    if (idx === undefined || idx === null) return null;
    return characters?.[idx] ?? null;
}

function spliceOverrideIntoChat(chatArr, block) {
    if (!Array.isArray(chatArr)) return false;
    for (const msg of chatArr) {
        if (!msg || msg.role !== 'system' || typeof msg.content !== 'string') continue;
        const anchor = msg.content.indexOf(STYLE_CONTRACT_CLOSE);
        if (anchor === -1) continue;
        const insertAt = anchor + STYLE_CONTRACT_CLOSE.length;
        msg.content = msg.content.slice(0, insertAt) + '\n\n' + block + msg.content.slice(insertAt);
        return true;
    }
    return false;
}

function onChatCompletionPromptReady(eventData) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!eventData || eventData.dryRun) return;

    const character = getActiveCharacter();
    if (!character) return;

    const styleOverride = character.data?.extensions?.world_forge?.style_override;
    const { block, applied, skipped } = buildOverrideBlock(styleOverride);
    const tag = `[world-forge] ${character.name || `chid#${this_chid}`}`;

    if (!block) {
        if (settings.debug) {
            if (skipped.length) console.warn(`${tag} → no override emitted; unknown enum values: ${skipped.join(', ')}`);
            else console.log(`${tag} → no override`);
        }
        return;
    }

    const resolvedBlock = substituteParams(block);
    const inserted = spliceOverrideIntoChat(eventData.chat, resolvedBlock);
    if (settings.debug) {
        if (inserted) console.log(`${tag} → injected style_override after </style_contract> (${applied.join(', ')})`);
        else console.warn(`${tag} → override built but no </style_contract> marker found in any system message; nothing injected`);
    }
}

// ------------------------------- helpers -----------------------------------

function stripReasoning(text) {
    return String(text ?? '').replace(reasoningTagRegex, '').trim();
}

/**
 * Tolerant JSON-array extractor for LLM replies that may be fenced or padded
 * with prose. Returns the parsed array, or null if nothing usable was found.
 * @param {string} text Raw model output
 * @returns {any[]|null}
 */
function extractJsonArray(text) {
    if (!text) return null;
    let s = String(text).replace(/```(?:json)?/gi, '').trim();

    try {
        const v = JSON.parse(s);
        if (Array.isArray(v)) return v;
    } catch { /* fall through to bracket scan */ }

    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start !== -1 && end > start) {
        try {
            const v = JSON.parse(s.slice(start, end + 1));
            if (Array.isArray(v)) return v;
        } catch { /* give up */ }
    }
    return null;
}

/**
 * Build the "oldest → newest" transcript of the last N visible messages.
 * @returns {string}
 */
function buildRecentTranscript() {
    const settings = getSettings();
    const n = Math.max(1, Math.min(50, Number(settings.contextMessages) || 10));
    if (!Array.isArray(chat) || chat.length === 0) return '';

    const lines = [];
    for (let i = chat.length - 1; i >= 0 && lines.length < n; i--) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== 'string') continue;
        // Skip hidden/system filler but keep narrator content.
        if (msg.is_system && msg.extra?.type !== 'narrator') continue;
        const speaker = msg.is_user ? (msg.name || name1) : (msg.name || 'Character');
        const body = stripReasoning(msg.mes);
        if (!body) continue;
        lines.push(`${speaker}: ${body}`);
    }
    return lines.reverse().join('\n');
}

/**
 * Run a single secondary-LLM request via the WI LLM filter connection profile.
 * @param {string} prompt
 * @param {number} maxTokens
 * @returns {Promise<string>} Cleaned text content
 */
async function callSmallLlm(prompt, maxTokens) {
    const profileId = String(world_info_llm_filter_profile || '');
    if (!profileId) {
        throw new Error('No Connection Profile set. Configure it under World Info → "LLM Filter".');
    }
    const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens);
    const content = (result && typeof result === 'object' && 'content' in result) ? String(result.content ?? '') : '';
    return stripReasoning(content);
}

/**
 * Resolve (creating if needed) the chat-bound lorebook name.
 * Delegates to the core /getchatbook slash command so metadata + UI stay in sync.
 * @returns {Promise<string>}
 */
async function getOrCreateChatBook() {
    const ctx = getContext();
    const result = await ctx.executeSlashCommandsWithOptions('/getchatbook');
    const name = String(result?.pipe ?? '').trim();
    if (!name) throw new Error('Could not resolve the chat-bound lorebook.');
    return name;
}

/**
 * Insert the given key-moment objects as keyword-triggered entries into the
 * chat-bound lorebook, with inclusion-group competition disabled for the book.
 * @param {{title: string, content: string, keywords: string[]}[]} moments
 * @returns {Promise<{book: string, added: number}>}
 */
async function insertKeyMoments(moments) {
    const book = await getOrCreateChatBook();
    const data = await loadWorldInfo(book);
    if (!data || typeof data !== 'object') throw new Error(`Failed to load lorebook "${book}".`);
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};

    // Per-book flag the user requested: "Disable inclusion group competition".
    data.disable_inclusion_group_competition = true;

    let added = 0;
    for (const moment of moments) {
        const title = String(moment?.title ?? '').trim();
        const content = String(moment?.content ?? '').trim();
        if (!content) continue;
        const keywords = Array.isArray(moment?.keywords)
            ? moment.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 10)
            : [];

        const entry = createWorldInfoEntry(book, data);
        if (!entry) continue;
        entry.comment = title || content.slice(0, 50);
        entry.content = content;
        entry.key = keywords;
        added++;
    }

    if (added === 0) throw new Error('Nothing to record — the model returned no usable entries.');

    await saveWorldInfo(book, data, true);
    // Refresh the editor if this book happens to be open.
    reloadEditor(book);

    return { book, added };
}

// --------------------------------- UI --------------------------------------

const WINDOW_HTML = `
<div id="wf_km_overlay" class="wf_km_overlay wf_km_hidden">
    <div class="wf_km_modal">
        <div class="wf_km_header">
            <h3 class="margin0">
                <i class="fa-solid fa-star"></i>
                <span data-i18n="Add Key Moment">Add Key Moment</span>
            </h3>
            <div id="wf_km_close" class="menu_button menu_button_icon" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </div>
        </div>
        <div class="wf_km_body">
            <div id="wf_km_status" class="wf_km_status"></div>
            <div id="wf_km_candidates" class="wf_km_candidates"></div>
            <label for="wf_km_notes" data-i18n="Which ones to record / extra guidance">Which ones to record / extra guidance</label>
            <textarea id="wf_km_notes" class="text_pole wf_km_notes" rows="3"
                placeholder="Tick the moments above, and/or describe what to record (e.g. 'record the betrayal and the new fire ability; merge the first two')."></textarea>
        </div>
        <div class="wf_km_footer">
            <div id="wf_km_rescan" class="menu_button" title="Re-scan recent messages">
                <i class="fa-solid fa-rotate"></i> <span data-i18n="Re-scan">Re-scan</span>
            </div>
            <div id="wf_km_record" class="menu_button menu_button_primary">
                <i class="fa-solid fa-floppy-disk"></i> <span data-i18n="Record">Record</span>
            </div>
        </div>
    </div>
</div>`;

const BUTTON_HTML = `
<div id="wf_km_menu_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <div class="fa-solid fa-star extensionsMenuExtensionButton" title="Add Key Moment"></div>
    <span data-i18n="Add Key Moment">Add Key Moment</span>
</div>`;

const SETTINGS_HTML = `
<div class="world_forge_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b data-i18n="World Forge — Key Moments">World Forge — Key Moments</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="wf_km_enabled">
                <input id="wf_km_enabled" type="checkbox" />
                <span data-i18n="Show the &quot;Add Key Moment&quot; button">Show the "Add Key Moment" button</span>
            </label>
            <label for="wf_km_context_messages" data-i18n="Messages to scan">Messages to scan</label>
            <div class="flex-container alignItemsCenter flexGap10">
                <input id="wf_km_context_messages" class="neo-range-slider" type="range" min="1" max="50" step="1" />
                <input id="wf_km_context_messages_counter" class="neo-range-input" type="number" min="1" max="50" step="1" />
            </div>
            <small class="notes" data-i18n="Uses the same Connection Profile as World Info → LLM Filter.">
                Uses the same Connection Profile as World Info → LLM Filter. Recorded moments go into the chat-bound lorebook with inclusion-group competition disabled.
            </small>
        </div>
    </div>
</div>`;

const STYLE_CSS = `
.wf_km_overlay {
    position: fixed; inset: 0; z-index: 10010;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);
}
.wf_km_overlay.wf_km_hidden { display: none !important; }
.wf_km_modal {
    width: 560px; max-width: 92vw; max-height: 85vh;
    display: flex; flex-direction: column;
    background-color: var(--SmartThemeBlurTintColor, #1f1f1f);
    color: var(--SmartThemeBodyColor, #e0e0e0);
    border: 1px solid var(--SmartThemeBorderColor, #444);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    overflow: hidden;
}
.wf_km_header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
    flex: 0 0 auto;
}
.wf_km_body { padding: 12px 14px; overflow-y: auto; flex: 1 1 auto; }
.wf_km_status { opacity: 0.8; font-style: italic; margin-bottom: 8px; min-height: 1.2em; }
.wf_km_status.wf_km_error { color: var(--fullred, #e06666); font-style: normal; }
.wf_km_candidates { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.wf_km_candidate {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 6px 8px; border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
}
.wf_km_candidate input[type="checkbox"] { margin-top: 3px; flex: 0 0 auto; }
.wf_km_candidate span { line-height: 1.4; }
.wf_km_notes { width: 100%; box-sizing: border-box; resize: vertical; }
.wf_km_footer {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 14px; border-top: 1px solid var(--SmartThemeBorderColor, #444);
    flex: 0 0 auto;
}
.wf_km_busy { opacity: 0.6; pointer-events: none; }
@media (max-width: 600px) { .wf_km_modal { width: 96vw; } }`;

function injectStyles() {
    if (document.getElementById('wf_km_inline_styles')) return;
    const style = document.createElement('style');
    style.id = 'wf_km_inline_styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
}

function setStatus(text, isError = false) {
    if (!$kmStatus) return;
    $kmStatus.text(text || '');
    $kmStatus.toggleClass('wf_km_error', !!isError);
}

function setBusy(busy) {
    kmBusy = busy;
    $kmOverlay?.find('.wf_km_modal').toggleClass('wf_km_busy', busy);
}

function renderCandidates(items) {
    if (!$kmCandidates) return;
    $kmCandidates.empty();
    if (!items.length) {
        $kmCandidates.append('<small class="notes">No key moments were detected. You can still describe one in the box below and Record it.</small>');
        return;
    }
    for (const text of items) {
        const id = `wf_km_cand_${Math.random().toString(36).slice(2)}`;
        const $row = $('<label class="wf_km_candidate"></label>').attr('for', id);
        $('<input type="checkbox" checked>').attr('id', id).appendTo($row);
        $('<span></span>').text(text).appendTo($row);
        $kmCandidates.append($row);
    }
}

function getSelectedCandidates() {
    const selected = [];
    $kmCandidates?.find('.wf_km_candidate').each(function () {
        const checked = $(this).find('input[type="checkbox"]').prop('checked');
        if (checked) selected.push($(this).find('span').text());
    });
    return selected;
}

async function runExtract() {
    if (kmBusy) return;
    if (!getCurrentChatId()) {
        setStatus('Open a chat first.', true);
        return;
    }
    const transcript = buildRecentTranscript();
    if (!transcript) {
        setStatus('No messages to scan in this chat.', true);
        renderCandidates([]);
        return;
    }

    setBusy(true);
    setStatus('Scanning recent messages…');
    renderCandidates([]);
    try {
        const prompt = [
            DEFAULT_EXTRACT_PROMPT,
            '',
            'RECENT MESSAGES (oldest → newest):',
            transcript,
            '',
            'Reply with only the JSON array of candidate key moments.',
        ].join('\n');

        const content = await callSmallLlm(prompt, KM_EXTRACT_MAX_TOKENS);
        const parsed = extractJsonArray(content);
        if (!parsed) {
            log('extract: unparseable response', content);
            setStatus('Could not parse the model reply. You can still type a moment below and Record it.', true);
            renderCandidates([]);
            return;
        }
        const items = parsed
            .map(x => (typeof x === 'string' ? x : (x?.title || x?.text || JSON.stringify(x))))
            .map(s => String(s).trim())
            .filter(Boolean)
            .slice(0, KM_MAX_CANDIDATES);
        renderCandidates(items);
        setStatus(items.length ? 'Tick the moments to keep, then Record.' : 'No key moments detected.');
    } catch (error) {
        warn('extract failed', error);
        setStatus(error?.message || String(error), true);
    } finally {
        setBusy(false);
    }
}

async function runRecord() {
    if (kmBusy) return;
    const selected = getSelectedCandidates();
    const notes = String($kmNotes?.val() ?? '').trim();
    if (selected.length === 0 && !notes) {
        setStatus('Tick at least one moment, or describe one in the box.', true);
        return;
    }

    setBusy(true);
    setStatus('Writing key moment(s)…');
    try {
        const transcript = buildRecentTranscript();
        const promptParts = [DEFAULT_SUMMARIZE_PROMPT, ''];
        if (selected.length) {
            promptParts.push('SELECTED KEY MOMENTS:', selected.map((s, i) => `${i + 1}. ${s}`).join('\n'), '');
        }
        if (notes) {
            promptParts.push('USER GUIDANCE (weigh this heavily):', notes, '');
        }
        promptParts.push(
            'RECENT MESSAGES (for context, oldest → newest):',
            transcript || '(none)',
            '',
            'Reply with only the JSON array of entry objects.',
        );

        const content = await callSmallLlm(promptParts.join('\n'), KM_SUMMARIZE_MAX_TOKENS);
        const parsed = extractJsonArray(content);
        if (!parsed || parsed.length === 0) {
            log('record: unparseable response', content);
            setStatus('The model did not return usable entries. Try rephrasing your guidance.', true);
            return;
        }

        const { book, added } = await insertKeyMoments(parsed);
        log(`recorded ${added} key moment(s) into "${book}"`);
        if (typeof toastr !== 'undefined') {
            toastr.success(`Recorded ${added} key moment${added === 1 ? '' : 's'} into "${book}".`, 'World Forge');
        }
        closeWindow();
    } catch (error) {
        warn('record failed', error);
        setStatus(error?.message || String(error), true);
    } finally {
        setBusy(false);
    }
}

function openWindow() {
    if (!$kmOverlay) return;
    $kmOverlay.removeClass('wf_km_hidden');
    if ($kmNotes) $kmNotes.val('');
    renderCandidates([]);
    runExtract();
}

function closeWindow() {
    if (!$kmOverlay) return;
    $kmOverlay.addClass('wf_km_hidden');
}

function applySettingsToUI() {
    const s = getSettings();
    $('#wf_km_enabled').prop('checked', s.keyMomentsEnabled);
    $('#wf_km_context_messages').val(s.contextMessages);
    $('#wf_km_context_messages_counter').val(s.contextMessages);
    $('#wf_km_menu_button').toggle(!!s.keyMomentsEnabled);
}

function wireSettings() {
    const ctx = getContext();
    const save = () => ctx.saveSettingsDebounced();

    $('#wf_km_enabled').on('input', function () {
        getSettings().keyMomentsEnabled = !!$(this).prop('checked');
        $('#wf_km_menu_button').toggle(getSettings().keyMomentsEnabled);
        save();
    });

    const onContextMessages = function () {
        const value = Math.max(1, Math.min(50, Number($(this).val()) || 10));
        getSettings().contextMessages = value;
        $('#wf_km_context_messages').val(value);
        $('#wf_km_context_messages_counter').val(value);
        save();
    };
    $('#wf_km_context_messages').on('input', onContextMessages);
    $('#wf_km_context_messages_counter').on('input', onContextMessages);
}

function initKeyMomentsUI() {
    try {
        injectStyles();
    } catch (e) {
        warn('style injection failed (non-fatal)', e);
    }

    try {
        $(document.body).append(WINDOW_HTML);
        const $menu = $('#extensionsMenu');
        if ($menu.length) $menu.append(BUTTON_HTML);
        else $(document.body).append(BUTTON_HTML);

        const $settingsAnchor = $('#extensions_settings');
        if ($settingsAnchor.length) $settingsAnchor.append(SETTINGS_HTML);

        $kmOverlay = $('#wf_km_overlay');
        $kmStatus = $('#wf_km_status');
        $kmCandidates = $('#wf_km_candidates');
        $kmNotes = $('#wf_km_notes');
        $kmRecord = $('#wf_km_record');

        if ($kmOverlay.length === 0) {
            warn('Key Moments overlay not found after append (sanitizer may have stripped it)');
            return;
        }

        $('#wf_km_menu_button').on('click', openWindow);
        $('#wf_km_close').on('click', closeWindow);
        $('#wf_km_rescan').on('click', runExtract);
        $kmRecord.on('click', runRecord);
        // Click on the dimmed backdrop closes the modal.
        $kmOverlay.on('click', (e) => { if (e.target === $kmOverlay[0]) closeWindow(); });

        wireSettings();
        applySettingsToUI();
    } catch (e) {
        warn('Key Moments UI wiring failed', e);
        return;
    }

    try {
        registerSlashCommands();
    } catch (e) {
        warn('slash command registration failed (non-fatal)', e);
    }
}

function registerSlashCommands() {
    const ctx = getContext();
    if (!ctx?.SlashCommandParser || !ctx?.SlashCommand) return;
    const { SlashCommandParser, SlashCommand } = ctx;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'keymoment',
        callback: () => { openWindow(); return ''; },
        helpString: 'Opens the World Forge "Add Key Moment" recorder.',
    }));
}

export function init() {
    getSettings();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    // Defer DOM wiring until the document is ready so #extensionsMenu exists.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initKeyMomentsUI, { once: true });
    } else {
        initKeyMomentsUI();
    }
    console.log('[world-forge] runtime extension loaded');
}
