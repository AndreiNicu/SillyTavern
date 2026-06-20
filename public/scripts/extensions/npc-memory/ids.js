/**
 * Identifier utilities for the NPC Memory consumer.
 *
 * These implement the contract's identifier-stability rules (§4) and the
 * prose-fallback parsing conventions (§10) so that ids derived from a bare
 * lorebook match the ids a manifest would emit for the same names.
 */

/**
 * Derive a stable NPC/scene id slug from a canonical name (contract §4).
 * Rule: lowercase, non-alphanumerics -> `_`, collapse repeats, trim edges.
 *
 * `Anna Larsson` -> `anna_larsson`, `Mr. Black` -> `mr_black`.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
    return String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

// Leading marker for an NPC lorebook entry comment, e.g. "NPC — Anna (Physical)".
// Accept em-dash (contract), en-dash and hyphen for robustness against exports.
const NPC_COMMENT_RE = /^\s*NPC\s*[—–-]\s*(.+)$/i;
const BEAT_COMMENT_RE = /^\s*BEAT\s*[—–-]\s*(.+)$/i;

/**
 * Map a facet parenthetical (e.g. "Physical Description") to a reserved facet
 * key (contract §5). Unknown parentheticals default to `volatile`.
 *
 * @param {string} parenthetical
 * @returns {string}
 */
export function inferFacetType(parenthetical) {
    const p = String(parenthetical ?? '').toLowerCase();
    if (!p) return 'combined';
    if (p.includes('physical')) return 'physical';
    if (p.includes('psych')) return 'psychological';
    if (p.includes('standing') || p.includes('goal')) return 'standingGoal';
    if (p.includes('relationship')) return 'relationship';
    if (p.includes('combined')) return 'combined';
    return 'volatile';
}

/**
 * Parse an NPC lorebook entry comment into name/facet parts (contract §10).
 * Strips only the leading `NPC — ` so em-dashes inside the facet parenthetical
 * (e.g. `(Relationship to Jake — Father)`) are preserved.
 *
 * @param {string} comment
 * @returns {{ name: string, id: string, facetType: string, parenthetical: string } | null}
 *          null when the comment is not an NPC entry.
 */
export function parseNpcComment(comment) {
    const m = NPC_COMMENT_RE.exec(String(comment ?? ''));
    if (!m) return null;

    let rest = m[1].trim();
    let parenthetical = '';

    // Pull a trailing `(...)` parenthetical off the end, if present.
    const paren = /\s*\(([^()]*)\)\s*$/.exec(rest);
    if (paren) {
        parenthetical = paren[1].trim();
        rest = rest.slice(0, paren.index).trim();
    }

    const name = rest;
    if (!name) return null;

    return {
        name,
        id: slugify(name),
        facetType: inferFacetType(parenthetical),
        parenthetical,
    };
}

/**
 * Detect a BEAT/scene lorebook entry from its comment (contract §10).
 *
 * @param {string} comment
 * @returns {{ title: string } | null}
 */
export function parseBeatComment(comment) {
    const m = BEAT_COMMENT_RE.exec(String(comment ?? ''));
    if (!m) return null;
    return { title: m[1].trim() };
}
