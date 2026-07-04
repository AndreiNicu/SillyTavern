/**
 * Batched memory summarization for the NPC Memory consumer (contract §9).
 *
 * Every N captured messages, for each NPC with pending events:
 *  - working memory: fold new events into a rolling per-slot recap
 *    (lastWithUser / lastAlone) — "what's going on now";
 *  - long-term memory: extract significant, lasting moments (declarations,
 *    promises, revelations, decisions, relationship shifts) and append them to
 *    a persistent, deduped longTerm[] — key history that is never silently
 *    overwritten by the rolling recap.
 *
 * Requests route through a user-selected connection profile (its preset controls
 * temperature) when configured, else the main generation API.
 */

import { allRecords, addLongTerm, isErrorNotice } from './store.js';
import { dlog } from './debug.js';

const LOG = '[npc-memory]';
let inFlight = false;

/**
 * Run a summarization pass over every NPC with pending events.
 * @param {object} ctx           getContext() result (provides generateRaw).
 * @param {object} settings
 * @param {string} personaName   {{user}} display name (for prompt phrasing).
 * @returns {Promise<number>} number of slots summarized.
 */
export async function runBatchSummary(ctx, settings, personaName) {
    if (inFlight) { dlog('summary: already running, skipped'); return 0; }
    if (!settings?.summaryProfile && typeof ctx?.generateRaw !== 'function') return 0;
    inFlight = true;
    let count = 0;
    try {
        const recs = allRecords();
        for (const id of Object.keys(recs)) {
            const rec = recs[id];
            if (!rec.events?.some(e => !e.summarized)) continue;
            count += await summarizeRecord(rec, ctx, settings, personaName);
        }
        dlog('summary: pass complete', { slots: count });
    } finally {
        inFlight = false;
    }
    return count;
}

/** True while a summary batch is running (avoids overlapping passes). */
export function isSummarizing() {
    return inFlight;
}

async function summarizeRecord(rec, ctx, settings, personaName) {
    const who = personaName || 'the user';
    scrubNoise(rec); // self-heal records poisoned by a prior failed summary
    const newEvents = rec.events.filter(e => !e.summarized);

    // --- Working memory: rolling recency recap per slot. ---
    const buckets = [
        ['lastWithUser', true, `with ${who}`],
        ['lastAlone', false, 'alone or with others'],
    ];
    let done = 0;
    for (const [slotKey, withUser, label] of buckets) {
        const evs = newEvents.filter(e => !!e.withUser === withUser);
        if (evs.length === 0) continue;
        const prevSlot = rec.slots[slotKey];
        const prev = prevSlot?.kind === 'llm' ? prevSlot.summary : '';
        const summary = await callSummary(ctx, rec.displayName, prev, evs, label, settings, who);
        if (summary) {
            const last = evs[evs.length - 1];
            rec.slots[slotKey] = {
                ts: last.ts, summary, scene: last.scene, location: last.location,
                source: 'summary', kind: 'llm',
            };
            done++;
        }
    }

    // --- Long-term memory: extract durable key moments from new events. ---
    if (settings.longTermMemory !== false && newEvents.length) {
        const facts = await extractLongTerm(ctx, rec.displayName, rec.longTerm ?? [], newEvents, who, settings);
        if (facts.length) {
            const added = addLongTerm(rec.id, facts, { source: 'summary', displayName: rec.displayName });
            dlog('long-term', { id: rec.id, added });
        }
    }

    // Mark all processed events summarized regardless, so a failed call doesn't
    // re-summarize the same backlog forever.
    for (const e of rec.events) e.summarized = true;
    return done;
}

/**
 * Remove memories poisoned by a prior failed summary (a provider error notice
 * stored as content). Drops such long-term facts and clears any slot whose
 * summary is a notice, so the next summary pass can repopulate it cleanly.
 * @param {import('./store.js').NpcRecord} rec
 */
function scrubNoise(rec) {
    if (Array.isArray(rec.longTerm)) {
        const kept = rec.longTerm.filter(e => !isErrorNotice(e?.text));
        if (kept.length !== rec.longTerm.length) {
            dlog('scrub: dropped poisoned long-term', { id: rec.id, removed: rec.longTerm.length - kept.length });
            rec.longTerm = kept;
        }
    }
    for (const key of ['lastWithUser', 'lastAlone']) {
        if (isErrorNotice(rec.slots?.[key]?.summary)) {
            dlog('scrub: cleared poisoned slot', { id: rec.id, slot: key });
            rec.slots[key] = null;
        }
    }
}

/**
 * Generate one rolling slot recap (working memory).
 */
async function callSummary(ctx, name, prev, evs, label, settings, who) {
    const lines = evs.map(e => `- ${e.text}`).join('\n');
    const instruction =
        `You maintain ${name}'s memory log for a roleplay. From the events below, capture only the ` +
        `KEY details of what happened ${label}: concrete actions, decisions made, new facts learned, ` +
        `and any shift in their relationship with ${who}. Omit atmosphere and filler. ` +
        `${prev ? 'Integrate this with the existing memory below. ' : ''}` +
        'Write 2-3 sentences, past tense, third person, no preamble and no quotes.';
    const body = [prev ? `Existing memory: ${prev}` : '', 'Events (oldest first):', lines].filter(Boolean).join('\n');
    return requestLLM(ctx, settings, `${instruction}\n\n${body}`, summaryTokens(settings), name);
}

/**
 * Extract new, durable long-term facts/moments from the events. Returns an array
 * of one-line memory strings (possibly empty).
 */
async function extractLongTerm(ctx, name, existing, evs, who, settings) {
    const lines = evs.map(e => `- ${e.text}`).join('\n');
    const known = existing.length
        ? `Already remembered (do NOT repeat these):\n${existing.map(e => `- ${e.text}`).join('\n')}\n\n`
        : '';
    const instruction =
        'From the roleplay events below, extract any LASTING, significant moments worth remembering ' +
        `permanently about ${name}: promises, declarations, confessions, decisions, revelations, ` +
        `important personal facts, and changes in their relationship with ${who}. ` +
        'Also keep CHARGED interpersonal beats even when they read as casual or flirtatious: ' +
        `moments of attraction or tension, things ${name} notices about ${who} (or notices ${who} ` +
        `noticing), and anything ${name} could later use as leverage or hold over ${who}. ` +
        'Ignore only true filler — ambient scenery, idle small talk, and routine actions with no ' +
        'lasting consequence. When in doubt about an interpersonal beat, keep it. ' +
        'Output each as its own short, self-contained line in past tense (no bullets, no preamble). ' +
        'If there is nothing genuinely significant and new, reply with exactly: NONE';
    const out = await requestLLM(ctx, settings, `${instruction}\n\n${known}Events (oldest first):\n${lines}`, summaryTokens(settings), name);
    return parseFacts(out);
}

/** Parse an LLM list response into clean fact lines. */
function parseFacts(text) {
    const s = String(text ?? '').trim();
    if (!s || /^none\.?$/i.test(s)) return [];
    return s.split('\n')
        .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
        .filter(l => l && !/^none\.?$/i.test(l));
}

function summaryTokens(settings) {
    return Number(settings.summaryTokens) > 0 ? Number(settings.summaryTokens) : 512;
}

/**
 * Run one LLM request, preferring the configured connection profile (its preset
 * controls temperature), falling back to the main generation API.
 * @returns {Promise<string>}
 */
export async function requestLLM(ctx, settings, prompt, maxTokens, name) {
    if (settings.summaryProfile) {
        try {
            const { ConnectionManagerRequestService } = await import('../shared.js');
            const out = await ConnectionManagerRequestService.sendRequest(settings.summaryProfile, prompt, maxTokens);
            const text = typeof out === 'string' ? out : (out?.content ?? '');
            if (text && !isErrorNotice(text)) return String(text).trim();
            if (isErrorNotice(text)) {
                console.warn(`${LOG} summary model returned a truncation/error notice (not stored). Raise "Summary token budget" or disable thinking on the summary profile. Falling back to main API.`);
            } else {
                console.warn(`${LOG} profile request returned empty; falling back to main API.`);
            }
        } catch (err) {
            console.warn(`${LOG} connection profile request failed; falling back to main API.`, err);
        }
    }
    try {
        if (typeof ctx?.generateRaw !== 'function') return '';
        const out = await ctx.generateRaw({
            prompt,
            systemPrompt: 'You write terse, factual memory notes. Reply with only the requested text.',
            responseLength: maxTokens,
        });
        const text = String(out ?? '').trim();
        if (isErrorNotice(text)) {
            console.warn(`${LOG} summary generation returned a truncation/error notice (not stored). Raise the summary token budget or disable thinking on the summary model.`);
            return '';
        }
        return text;
    } catch (err) {
        console.warn(`${LOG} generation failed for ${name}.`, err);
        return '';
    }
}
