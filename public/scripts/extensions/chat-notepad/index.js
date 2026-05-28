import {
    eventSource,
    event_types,
    substituteParams,
    updateMessageBlock,
    saveChatConditional,
} from '../../../script.js';
import { parseReasoningFromString } from '../../reasoning.js';
import { getContext } from '../../st-context.js';
import { debounce } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';
import { power_user } from '../../power-user.js';

const MODULE = 'chat-notepad';

// Templates are inlined to avoid an extra HTTP fetch for window.html / button.html
// (some deployments don't serve arbitrary files from extension directories).
const WINDOW_HTML = `
<div id="chat_notepad_window" class="chat_notepad_window chat_notepad_hidden">
    <div id="chat_notepad_header" class="chat_notepad_header flex-container alignItemsCenter spaceBetween">
        <h3 class="margin0">
            <i class="fa-solid fa-book-open"></i>
            <span data-i18n="Chat Notepad">Chat Notepad</span>
        </h3>
        <div class="flex-container flexGap5 alignItemsCenter">
            <small id="chat_notepad_status" class="chat_notepad_status" data-i18n="Saved">Saved</small>
            <div id="chat_notepad_refresh" class="menu_button menu_button_icon" title="Rebuild from chat">
                <i class="fa-solid fa-rotate"></i>
            </div>
            <div id="chat_notepad_close" class="menu_button menu_button_icon" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </div>
        </div>
    </div>
    <div id="chat_notepad_empty" class="chat_notepad_empty" style="display: none;">
        <p data-i18n="No chat is open, or the chat has no messages.">No chat is open, or the chat has no messages.</p>
    </div>
    <div id="chat_notepad_body" class="chat_notepad_body"></div>
</div>`;

const BUTTON_HTML = `
<div id="chat_notepad_menu_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <div class="fa-solid fa-book-open extensionsMenuExtensionButton" title="Toggle Chat Notepad"></div>
    <span data-i18n="Chat Notepad">Chat Notepad</span>
</div>`;

const STYLE_CSS = `
#chat_notepad_window {
    position: fixed !important;
    top: var(--topBarBlockSize, 40px) !important;
    right: 0 !important;
    left: auto !important;
    bottom: 0 !important;
    width: 420px !important;
    max-width: 90vw !important;
    height: auto !important;
    min-width: 0 !important;
    margin: 0 !important;
    z-index: 3000;
    background-color: var(--SmartThemeBlurTintColor, #1f1f1f);
    color: var(--SmartThemeBodyColor, #e0e0e0);
    border-left: 1px solid var(--SmartThemeBorderColor, #444);
    box-shadow: -4px 0 12px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    padding: 0 !important;
    border-radius: 0 !important;
    overflow: hidden;
}
#chat_notepad_window.chat_notepad_hidden {
    display: none !important;
}
.chat_notepad_header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
    flex: 0 0 auto;
    cursor: default;
    user-select: none;
}
.chat_notepad_status {
    opacity: 0.65;
    font-style: italic;
    min-width: 60px;
    text-align: right;
}
.chat_notepad_status.dirty {
    color: var(--warning, #d39a00);
    opacity: 1;
}
.chat_notepad_empty {
    padding: 24px;
    text-align: center;
    opacity: 0.7;
}
.chat_notepad_body {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px 18px;
    font-family: var(--mainFontFamily, Georgia, 'Times New Roman', serif);
    font-size: 15px;
    line-height: 1.55;
}
.chat_notepad_segment {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    color: inherit;
    border: none;
    outline: none;
    resize: none;
    padding: 0;
    margin: 0 0 1em 0;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    display: block;
    /* SillyTavern's global "textarea" rule caps height at 90vh; without this
       override long messages get clamped and their bottom paragraphs hidden
       behind the next segment. Let autoResize() set the full content height. */
    max-height: none !important;
    min-height: 0 !important;
}
.chat_notepad_segment:focus {
    background: rgba(255, 255, 255, 0.04);
    box-shadow: inset 0 0 0 1px var(--SmartThemeBorderColor, #555);
    border-radius: 3px;
}
.chat_notepad_body:empty::before {
    content: 'No messages yet.';
    opacity: 0.5;
}
@media (max-width: 768px) {
    #chat_notepad_window {
        width: 100vw;
        max-width: 100vw;
    }
}`;

function injectStyles() {
    if (document.getElementById('chat_notepad_inline_styles')) return;
    const style = document.createElement('style');
    style.id = 'chat_notepad_inline_styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
}

// Ring buffer of recent log entries. Exposed via /notepad-log slash command
// and on window.__chatNotepad so diagnostics are reachable without DevTools.
const LOG_BUFFER_MAX = 200;
const logBuffer = [];

function pushLog(level, args) {
    const entry = {
        t: new Date().toISOString(),
        level,
        msg: args.map(a => {
            if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' '),
    };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

function log(...args) {
    pushLog('info', args);
    console.log(`[${MODULE}]`, ...args);
}
function warn(...args) {
    pushLog('warn', args);
    console.warn(`[${MODULE}]`, ...args);
}
function err(...args) {
    pushLog('error', args);
    console.error(`[${MODULE}]`, ...args);
    try {
        if (typeof toastr !== 'undefined') {
            const msg = args.map(a => (a instanceof Error) ? `${a.name}: ${a.message}` : String(a)).join(' ');
            toastr.error(msg.slice(0, 500), 'Chat Notepad');
        }
    } catch { /* ignore toast failures */ }
}

function dumpLog() {
    const text = logBuffer.map(e => `[${e.t}] [${e.level}] ${e.msg}`).join('\n');
    console.log(`[${MODULE}] --- log dump (${logBuffer.length} entries) ---\n${text}`);
    return text;
}

let isOpen = false;
let isApplyingExternalUpdate = false;
let $window = null;
let $body = null;
let $empty = null;
let $status = null;

const segments = new Map();

const reasoningTagRegex = /<(?:think|thinking|thought|reasoning)>[\s\S]*?<\/(?:think|thinking|thought|reasoning)>/gi;

function stripReasoning(text) {
    if (!text) return '';
    let cleaned = String(text);
    const parsed = parseReasoningFromString(cleaned, { strict: false });
    if (parsed && typeof parsed.content === 'string' && parsed.content.length > 0) {
        cleaned = parsed.content;
    }
    cleaned = cleaned.replace(reasoningTagRegex, '');
    return cleaned;
}

function toDisplayText(message) {
    if (!message || typeof message.mes !== 'string') return '';
    let text = message.mes;
    text = stripReasoning(text);
    try {
        text = substituteParams(text, undefined, message.name);
    } catch {
        // ignore macro errors, fall back to raw text
    }
    if (power_user?.trim_spaces) {
        text = text.trim();
    }
    return text;
}

function autoResize(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight + 2) + 'px';
}

function setStatus(text, dirty = false) {
    if (!$status) return;
    $status.text(text);
    $status.toggleClass('dirty', !!dirty);
}

function shouldShowMessage(message) {
    if (!message) return false;
    // Hide hidden/system filler messages but keep narrator content
    if (message.is_system && message.extra?.type !== 'narrator') return false;
    return true;
}

function buildSegment(message, messageId) {
    const textarea = document.createElement('textarea');
    textarea.className = 'chat_notepad_segment' + (message.is_user ? ' is_user' : '');
    textarea.dataset.mesid = String(messageId);
    textarea.spellcheck = true;
    textarea.value = toDisplayText(message);
    textarea.addEventListener('input', onSegmentInput);
    textarea.addEventListener('blur', onSegmentBlur);
    return textarea;
}

function rebuild() {
    if (!$body) return;
    const context = getContext();
    const chat = context?.chat;
    segments.clear();
    $body.empty();

    if (!Array.isArray(chat) || chat.length === 0) {
        $empty.show();
        return;
    }

    $empty.hide();

    const frag = document.createDocumentFragment();
    let visibleCount = 0;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!shouldShowMessage(message)) continue;
        const textarea = buildSegment(message, i);
        frag.appendChild(textarea);
        segments.set(i, textarea);
        visibleCount++;
    }

    $body[0].appendChild(frag);

    // Resize on next frame so they're attached to the DOM and have width.
    requestAnimationFrame(() => {
        for (const ta of segments.values()) autoResize(ta);
    });

    if (visibleCount === 0) $empty.show();
    setStatus('Saved', false);
}

function updateOneSegment(messageId) {
    const message = getContext().chat?.[messageId];
    if (!message) {
        const existing = segments.get(messageId);
        if (existing) {
            existing.remove();
            segments.delete(messageId);
        }
        return;
    }

    let textarea = segments.get(messageId);
    if (!textarea) {
        if (!shouldShowMessage(message)) return;
        // Append-only path for new last message (avoid full rebuild on stream/send).
        const chatLen = getContext().chat?.length ?? 0;
        if (messageId === chatLen - 1) {
            $empty.hide();
            textarea = buildSegment(message, messageId);
            segments.set(messageId, textarea);
            $body[0].appendChild(textarea);
            requestAnimationFrame(() => autoResize(textarea));
            return;
        }
        rebuild();
        return;
    }

    const newText = toDisplayText(message);
    if (textarea.value !== newText) {
        if (document.activeElement === textarea) return;
        textarea.value = newText;
        autoResize(textarea);
    }
}

const saveSegmentDebounced = debounce(saveSegment, debounce_timeout.short);

function onSegmentInput(e) {
    if (isApplyingExternalUpdate) return;
    autoResize(e.currentTarget);
    setStatus('Editing…', true);
    saveSegmentDebounced(e.currentTarget);
}

function onSegmentBlur(e) {
    if (isApplyingExternalUpdate) return;
    saveSegment(e.currentTarget);
}

async function saveSegment(textarea) {
    if (!textarea || !textarea.isConnected) return;
    const messageId = Number(textarea.dataset.mesid);
    const context = getContext();
    const message = context?.chat?.[messageId];
    if (!message) return;

    const newText = textarea.value;
    const currentDisplay = toDisplayText(message);
    if (newText === currentDisplay) {
        setStatus('Saved', false);
        return;
    }

    message.mes = newText;
    if (message.swipe_id !== undefined && Array.isArray(message.swipes)) {
        message.swipes[message.swipe_id] = newText;
    }
    // The user removed any <think> blocks by editing here — clear cached reasoning
    // so the cleaned text becomes the source of truth.
    if (message.extra) {
        if (message.extra.display_text) delete message.extra.display_text;
    }

    isApplyingExternalUpdate = true;
    try {
        updateMessageBlock(messageId, message);
        await eventSource.emit(event_types.MESSAGE_EDITED, messageId);
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    } finally {
        isApplyingExternalUpdate = false;
    }

    await saveChatConditional();
    setStatus('Saved', false);
}

function openWindow() {
    if (!$window) return;
    $window.removeClass('chat_notepad_hidden');
    isOpen = true;
    rebuild();
}

function closeWindow() {
    if (!$window) return;
    $window.addClass('chat_notepad_hidden');
    isOpen = false;
}

function toggleWindow() {
    isOpen ? closeWindow() : openWindow();
}

function attachChatListeners() {
    const onMessageChange = (messageId) => {
        if (!isOpen) return;
        if (isApplyingExternalUpdate) return;
        if (typeof messageId === 'number') {
            updateOneSegment(messageId);
        } else {
            rebuild();
        }
    };

    eventSource.on(event_types.MESSAGE_SENT, onMessageChange);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageChange);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageChange);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageChange);
    eventSource.on(event_types.MESSAGE_DELETED, () => { if (isOpen) rebuild(); });
    eventSource.on(event_types.MESSAGE_SWIPED, () => { if (isOpen) rebuild(); });
    eventSource.on(event_types.MESSAGE_REASONING_EDITED, onMessageChange);
    eventSource.on(event_types.MESSAGE_REASONING_DELETED, onMessageChange);
    eventSource.on(event_types.CHAT_CHANGED, () => { if (isOpen) rebuild(); });
    eventSource.on(event_types.CHAT_LOADED, () => { if (isOpen) rebuild(); });
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => { if (isOpen) rebuild(); });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageChange);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageChange);
    const streamUpdate = debounce(() => {
        if (!isOpen) return;
        const chat = getContext().chat;
        if (!Array.isArray(chat) || chat.length === 0) return;
        updateOneSegment(chat.length - 1);
    }, 100);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamUpdate);
}

export async function init() {
    log('init: starting');

    // Expose diagnostics for the user even if DevTools isn't open.
    try {
        window.__chatNotepad = {
            module: MODULE,
            getLog: () => logBuffer.slice(),
            dumpLog,
            isOpen: () => isOpen,
            segments: () => segments,
            open: openWindow,
            close: closeWindow,
            rebuild,
        };
    } catch (e) {
        warn('failed to install window.__chatNotepad', e);
    }

    try {
        injectStyles();
    } catch (e) {
        warn('init: style injection failed (non-fatal)', e);
    }

    try {
        log('init: appending window + button (inline templates)');
        $(document.body).append(WINDOW_HTML);
        const $menu = $('#extensionsMenu');
        if ($menu.length === 0) {
            warn('init: #extensionsMenu not found in DOM, appending button to body as fallback');
            $(document.body).append(BUTTON_HTML);
        } else {
            $menu.append(BUTTON_HTML);
        }

        $window = $('#chat_notepad_window');
        $body = $('#chat_notepad_body');
        $empty = $('#chat_notepad_empty');
        $status = $('#chat_notepad_status');

        if ($window.length === 0 || $body.length === 0) {
            err('init: window element not found after append (DOMPurify may have stripped it)');
            return;
        }

        $('#chat_notepad_menu_button').on('click', toggleWindow);
        $('#chat_notepad_close').on('click', closeWindow);
        $('#chat_notepad_refresh').on('click', () => { if (isOpen) rebuild(); });
    } catch (e) {
        err('init: DOM wiring failed', e);
        return;
    }

    try {
        attachChatListeners();
    } catch (e) {
        err('init: event listener attach failed', e);
        return;
    }

    try {
        registerSlashCommands();
    } catch (e) {
        warn('init: slash command registration failed (non-fatal)', e);
    }

    log('init: complete');
}

function registerSlashCommands() {
    const ctx = getContext();
    if (!ctx?.SlashCommandParser || !ctx?.SlashCommand) return;
    const { SlashCommandParser, SlashCommand } = ctx;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'notepad-log',
        callback: () => {
            const text = dumpLog();
            try {
                if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text);
            } catch { /* ignore */ }
            if (typeof toastr !== 'undefined') {
                toastr.info(`${logBuffer.length} entries dumped to console (also copied to clipboard)`, 'Chat Notepad');
            }
            return text;
        },
        helpString: 'Dumps the Chat Notepad log buffer to the console (and copies to clipboard).',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'notepad',
        callback: () => { toggleWindow(); return ''; },
        helpString: 'Toggles the Chat Notepad pane.',
    }));
}
