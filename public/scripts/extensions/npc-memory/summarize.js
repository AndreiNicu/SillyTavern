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
    // Need either a connection profile or the main generation API available.
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
        const summary = await callSummary(ctx, rec.displayName, prev, evs, label, settings, who);
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

/**
 * Generate one slot summary. Routes through a user-selected connection profile
 * (normal temperature, via the profile's own preset) when configured, mirroring
 * the lorebook LLM filter / group reply-strategy pattern; otherwise falls back
 * to the main generation API.
 */
async function callSummary(ctx, name, prev, evs, label, settings, who) {
    const lines = evs.map(e => `- ${e.text}`).join('\n');
    const instruction =
        `You maintain ${name}'s memory log for a roleplay. From the events below, capture only the ` +
        `KEY details of what happened ${label}: concrete actions, decisions made, new facts learned, ` +
        `and any shift in their relationship with ${who}. Omit atmosphere and filler. ` +
        `${prev ? 'Integrate this with the existing memory below. ' : ''}` +
        'Write 2-3 sentences, past tense, third person, no preamble and no quotes.';
    const body = [
        prev ? `Existing memory: ${prev}` : '',
        'Events (oldest first):',
        lines,
    ].filter(Boolean).join('\n');
    const prompt = `${instruction}\n\n${body}`;
    const maxTokens = Number(settings.summaryTokens) > 0 ? Number(settings.summaryTokens) : 200;

    // Preferred: dedicated connection profile (its preset controls temperature).
    if (settings.summaryProfile) {
        try {
            const { ConnectionManagerRequestService } = await import('../shared.js');
            const out = await ConnectionManagerRequestService.sendRequest(settings.summaryProfile, prompt, maxTokens);
            const text = typeof out === 'string' ? out : (out?.content ?? '');
            if (text) return String(text).trim();
            console.warn(`${LOG} profile request returned empty; falling back to main API.`);
        } catch (err) {
            console.warn(`${LOG} connection profile request failed; falling back to main API.`, err);
        }
    }

    // Fallback: main generation API.
    try {
        if (typeof ctx?.generateRaw !== 'function') return '';
        const out = await ctx.generateRaw({
            prompt,
            systemPrompt: 'You write terse, factual memory notes. Reply with only the memory text.',
            responseLength: maxTokens,
        });
        return String(out ?? '').trim();
    } catch (err) {
        console.warn(`${LOG} summary generation failed for ${name} (${label}).`, err);
        return '';
    }
}
