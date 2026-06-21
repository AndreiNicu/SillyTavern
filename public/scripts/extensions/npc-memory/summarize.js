/**
 * Batched memory summarization for the NPC Memory consumer (contract §9).
 *
 * Every N captured messages, fold each NPC's not-yet-summarized events into a
 * concise per-slot recap (lastWithUser / lastAlone) via one background
 * generation per non-empty slot. This keeps stored memory a real summary of
 * what happened rather than a raw snippet, at a controlled token cost.
 */

import { allRecords } from './store.js';
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
    if (typeof ctx?.generateRaw !== 'function') return 0;
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
    const buckets = [
        ['lastWithUser', true, `with ${who}`],
        ['lastAlone', false, 'alone or with others'],
    ];
    let done = 0;
    for (const [slotKey, withUser, label] of buckets) {
        const evs = rec.events.filter(e => !e.summarized && !!e.withUser === withUser);
        if (evs.length === 0) continue;
        const prevSlot = rec.slots[slotKey];
        const prev = prevSlot?.kind === 'llm' ? prevSlot.summary : '';
        const summary = await callSummary(ctx, rec.displayName, prev, evs, label, settings);
        if (summary) {
            const last = evs[evs.length - 1];
            rec.slots[slotKey] = {
                ts: last.ts,
                summary,
                scene: last.scene,
                location: last.location,
                source: 'summary',
                kind: 'llm',
            };
            done++;
        }
    }
    // Mark all processed events summarized regardless, so a failed call doesn't
    // re-summarize the same backlog forever (slots keep last good summary).
    for (const e of rec.events) e.summarized = true;
    return done;
}

async function callSummary(ctx, name, prev, evs, label, settings) {
    const lines = evs.map(e => `- ${e.text}`).join('\n');
    const systemPrompt =
        'You maintain terse, factual third-person memory notes for a roleplay character. ' +
        'Reply with ONLY the memory text — 1-2 sentences, past tense, no preamble, no quotes.';
    const prompt = [
        `Character: ${name}.`,
        prev ? `Existing memory (${label}): ${prev}` : '',
        `Recent events (${label}), oldest first:`,
        lines,
        `Write ${name}'s updated memory of what happened ${label}` +
        `${prev ? ', merging the existing memory' : ''}. 1-2 sentences.`,
    ].filter(Boolean).join('\n');

    try {
        const out = await ctx.generateRaw({
            prompt,
            systemPrompt,
            responseLength: Number(settings.summaryTokens) > 0 ? Number(settings.summaryTokens) : 120,
        });
        return String(out ?? '').trim();
    } catch (err) {
        console.warn(`${LOG} summary generation failed for ${name} (${label}).`, err);
        return '';
    }
}
