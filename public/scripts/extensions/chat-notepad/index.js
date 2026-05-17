import {
    eventSource,
    event_types,
    substituteParams,
    updateMessageBlock,
    saveChatConditional,
} from '../../../script.js';
import { renderExtensionTemplateAsync } from '../../extensions.js';
import { parseReasoningFromString } from '../../reasoning.js';
import { getContext } from '../../st-context.js';
import { debounce } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';
import { power_user } from '../../power-user.js';

const MODULE = 'chat-notepad';

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
    $window.show();
    isOpen = true;
    rebuild();
}

function closeWindow() {
    if (!$window) return;
    $window.hide();
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
    const windowHtml = await renderExtensionTemplateAsync(MODULE, 'window');
    const buttonHtml = await renderExtensionTemplateAsync(MODULE, 'button');

    $(document.body).append(windowHtml);
    $('#extensionsMenu').append(buttonHtml);

    $window = $('#chat_notepad_window');
    $body = $('#chat_notepad_body');
    $empty = $('#chat_notepad_empty');
    $status = $('#chat_notepad_status');

    $('#chat_notepad_menu_button').on('click', toggleWindow);
    $('#chat_notepad_close').on('click', closeWindow);
    $('#chat_notepad_refresh').on('click', () => { if (isOpen) rebuild(); });

    attachChatListeners();
}
