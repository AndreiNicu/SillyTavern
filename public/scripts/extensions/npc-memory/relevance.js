/**
 * Relevance retrieval for long-term NPC memory.
 *
 * Long-term memories should surface only when they matter to the current
 * moment, not flood the context. This scores each stored fact against a query
 * built from the recent conversation using lightweight lexical overlap — no
 * embeddings, no extra LLM call, fully synchronous. Pure and unit-testable.
 */

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
    'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'he', 'she',
    'they', 'them', 'his', 'her', 'their', 'you', 'your', 'yours', 'i', 'me', 'my', 'mine', 'we',
    'us', 'our', 'that', 'this', 'these', 'those', 'then', 'than', 'so', 'if', 'not', 'no', 'do',
    'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'just',
    'about', 'into', 'out', 'up', 'down', 'over', 'what', 'who', 'whom', 'when', 'where', 'why',
    'how', 'all', 'any', 'some', 'one', 'two', 'now', 'here', 'there', 'back', 'still', 'like',
    'get', 'got', 'go', 'going', 'said', 'says', 'say', 'tell', 'told', 'asked', 'ask',
]);

/**
 * Tokenize text into a set of normalized content tokens (lowercased, depunctuated,
 * stopwords and very short tokens removed). A trailing-'s' variant is added so
 * simple singular/plural forms match.
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
    const out = new Set();
    for (const w of String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        if (w.length < 3 || STOPWORDS.has(w)) continue;
        out.add(w);
        if (w.length > 3 && w.endsWith('s')) out.add(w.slice(0, -1));
    }
    return out;
}

/** Relevance score of a fact against the query token set (shared content tokens). */
function score(factText, queryTokens) {
    const ft = tokenize(factText);
    let s = 0;
    for (const t of ft) if (queryTokens.has(t)) s++;
    return s;
}

/**
 * Select the long-term facts relevant to the current query.
 *
 * @param {Array<{text:string, ts?:number}>} facts  Stored long-term entries.
 * @param {string} queryText                         Recent conversation context.
 * @param {{ max?: number, minScore?: number }} [opts]
 * @returns {string[]} relevant fact texts, most relevant first (max-capped).
 *          When the query is empty, falls back to the most recent `max` facts.
 */
export function selectRelevant(facts, queryText, opts = {}) {
    const max = Number(opts.max) > 0 ? Number(opts.max) : 10;
    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 1;
    const list = Array.isArray(facts) ? facts : [];
    if (list.length === 0) return [];

    const q = tokenize(queryText);
    if (q.size === 0) return list.slice(-max).map(f => f.text); // no query: recency fallback

    const scored = list
        .map(f => ({ text: f.text, ts: f.ts || 0, s: score(f.text, q) }))
        .filter(x => x.s >= minScore)
        .sort((a, b) => (b.s - a.s) || (b.ts - a.ts));

    return scored.slice(0, max).map(x => x.text);
}
