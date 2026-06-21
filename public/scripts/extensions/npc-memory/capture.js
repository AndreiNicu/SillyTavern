/**
 * Event capture for the NPC Memory consumer (contract §6, §7.3).
 *
 * On each finalized character message: parse the turn tag (or synthesize an
 * `inferred` one), record an event per actor into the store, then strip the tag
 * from the stored message so it never re-enters the model context.
 */

import { parseTag, inferTag, stripTags, hasTag } from './turntag.js';
import { recordEvent } from './store.js';
import { dlog } from './debug.js';

const LOG = '[npc-memory]';

/**
 * Capture from a single chat message by index.
 *
 * @param {number} messageId
 * @param {import('./manifest-reader.js').NpcMemoryIndex} index
 * @param {object} settings
 * @param {object} ctx           getContext() result.
 * @returns {{actors: string[], withUser: boolean, scene: string|null, source: string}|null}
 */
export function captureFromMessage(messageId, index, settings, ctx) {
    const chat = ctx?.chat;
    const message = chat?.[messageId];
    if (!message || message.is_user || message.is_system) return null;

    // Guard against re-capturing the same swipe (CHARACTER_MESSAGE_RENDERED can
    // fire on re-render/scroll). A new swipe has a different id and re-captures.
    message.extra = message.extra || {};
    const swipeKey = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    if (message.extra.npcmem_cap === swipeKey) return null;
    message.extra.npcmem_cap = swipeKey;

    const text = String(message.mes ?? '');

    // Tag (authoritative) or inferred fallback (contract §7.3 step 4).
    const personaAliases = [
        ...(index.personas?.user?.aliases ?? []),
        index.personas?.user?.name,
        ctx?.name1,
    ].filter(Boolean);

    let tag = parseTag(text);
    if (!tag) {
        tag = inferTag(message, index, personaAliases);
    } else if (tag.withUser === undefined) {
        // Model omitted withUser: fall back to alias inference for that field.
        tag.withUser = inferTag(message, index, personaAliases).withUser;
    }

    const actors = tag.actors.length ? tag.actors : inferTag(message, index, personaAliases).actors;
    if (actors.length === 0) {
        dlog('capture: no resolvable actor for message', messageId);
    }

    const ts = Date.parse(message.send_date) || Date.now();
    const prose = stripTags(text); // memory stores clean prose, never the tag
    for (const id of actors) {
        recordEvent(id, {
            ts,
            withUser: !!tag.withUser,
            scene: tag.scene,
            location: tag.location,
            text: prose,
            source: tag.src,
        }, { displayName: index.byId.get(id)?.displayName });
    }

    // Strip the tag from storage so it never enters future prompts (§7.4).
    if (settings.stripTags !== false && hasTag(text)) {
        const cleaned = stripTags(text);
        message.mes = cleaned;
        if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
            const sw = message.swipes[message.swipe_id];
            if (typeof sw === 'string') message.swipes[message.swipe_id] = stripTags(sw);
        }
        try {
            ctx.saveChat?.();
        } catch (err) {
            console.warn(`${LOG} failed to persist stripped message.`, err);
        }
    }

    dlog('capture', { messageId, actors, withUser: !!tag.withUser, scene: tag.scene, src: tag.src });
    return { actors, withUser: !!tag.withUser, scene: tag.scene, source: tag.src };
}
