/**
 * Chat compression / checkpoint for the NPC Memory consumer (contract §9).
 *
 * Compresses the chat-so-far into a narrative "story so far" recap and injects
 * it at the top of the prompt, while hiding the older messages from the prompt
 * (is_system) — the chat file itself is preserved, only marked. Only messages
 * after the marker are sent to the model, plus the recap. Reversible.
 */

import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../script.js';
import { requestLLM } from './summarize.js';
import { getCompress, setCompress, clearCompress } from './store.js';
import { snippet } from './store.js';
import { dlog } from './debug.js';

const RECAP_KEY = 'npcmem_recap';

/** Re-assert (or clear) the recap injection from the stored marker. */
export function applyRecapFromMarker(settings) {
    const marker = getCompress();
    if (marker?.summary && settings.compressEnabled !== false) {
        applyRecap(marker.summary);
    } else {
        clearRecap();
    }
}

/** Inject the recap block at the top of the prompt (scenario-like). */
export function applyRecap(summary) {
    if (!summary) { clearRecap(); return; }
    const text = `[Story so far]\n${summary}\n\nThe scene continues from here.`;
    setExtensionPrompt(RECAP_KEY, text, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}

/** Remove the recap injection. */
export function clearRecap() {
    setExtensionPrompt(RECAP_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}

/**
 * Compress the chat up to (length - 1 - keepLast): summarize the still-visible
 * messages into/onto the recap, hide them, and store the marker.
 * @param {object} ctx       getContext() result.
 * @param {object} settings
 * @returns {Promise<{ok: boolean, reason?: string, hidden?: number, kept?: number}>}
 */
export async function compressChat(ctx, settings) {
    const chat = ctx?.chat ?? [];
    if (chat.length === 0) return { ok: false, reason: 'empty chat' };

    const keep = Math.max(0, Number(settings.compressKeepLast) || 0);
    const cut = chat.length - 1 - keep;
    if (cut < 0) return { ok: false, reason: 'nothing to compress' };

    // Gather still-visible (non-hidden) messages in the span to compress.
    const span = [];
    for (let i = 0; i <= cut; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const body = snippet(String(m.mes ?? ''), 1000);
        if (body) span.push(`${m.name || '?'}: ${body}`);
    }
    if (span.length === 0) return { ok: false, reason: 'nothing new to compress' };

    const prev = getCompress()?.summary || '';
    const summary = await buildRecap(ctx, settings, prev, span);
    if (!summary) return { ok: false, reason: 'summary generation failed' };

    const { hideChatMessageRange } = await import('../../chats.js');
    await hideChatMessageRange(0, cut, false); // hide => is_system, excluded from prompt

    setCompress({ cutMesId: cut, summary, ts: Date.now() });
    applyRecap(summary);
    dlog('compress', { cut, hidden: cut + 1, kept: keep });
    return { ok: true, hidden: cut + 1, kept: keep };
}

/**
 * Undo the most recent compression: unhide the spanned messages and clear the
 * recap + marker.
 * @param {object} ctx
 * @returns {Promise<{ok: boolean}>}
 */
export async function uncompressChat(ctx) {
    const marker = getCompress();
    if (!marker) return { ok: false };
    const { hideChatMessageRange } = await import('../../chats.js');
    await hideChatMessageRange(0, marker.cutMesId, true); // unhide
    clearCompress();
    clearRecap();
    dlog('uncompress', { cut: marker.cutMesId });
    return { ok: true };
}

async function buildRecap(ctx, settings, prev, span) {
    const maxTokens = Number(settings.compressTokens) > 0 ? Number(settings.compressTokens) : 400;
    const instruction =
        'Write a "story so far" recap of the roleplay below so the narrative can continue seamlessly. ' +
        'Cover who the characters are, the setting, the key events and decisions in order, important ' +
        'revelations, and any unresolved threads, ending on the current situation. ' +
        `${prev ? 'Integrate the new messages into the existing recap below. ' : ''}` +
        'Past tense, third person, 1-2 tight paragraphs. No preamble.';
    const body = [
        prev ? `Existing recap:\n${prev}` : '',
        'Messages (oldest first):',
        span.join('\n'),
    ].filter(Boolean).join('\n\n');
    return requestLLM(ctx, settings, `${instruction}\n\n${body}`, maxTokens, 'chat-recap');
}
