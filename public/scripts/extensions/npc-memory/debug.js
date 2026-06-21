/**
 * Debug tooling for the NPC Memory consumer.
 *
 * Holds a live diagnostics snapshot (last index + last turn resolution) and
 * renders it as plain text or HTML for the inspector popup, the settings panel,
 * and the `/npc-memory` slash command. Also provides a gated verbose logger.
 */

let verbose = false;

/** Enable/disable verbose console logging. */
export function setVerbose(on) {
    verbose = !!on;
}

/** Verbose console log (no-op unless debug logging is enabled). */
export function dlog(...args) {
    if (verbose) console.log('[npc-memory]', ...args);
}

/**
 * @typedef {object} Diagnostics
 * @property {import('./manifest-reader.js').NpcMemoryIndex|null} index
 * @property {object|null} lastTurn   { at, mapping, npcIds, sceneId, injected }.
 */

/** @type {Diagnostics} */
const state = { index: null, lastTurn: null, lastCapture: null };

export function setIndex(index) {
    state.index = index;
}

export function setLastTurn(turn) {
    state.lastTurn = { at: Date.now(), ...turn };
}

export function setLastCapture(capture) {
    state.lastCapture = { at: Date.now(), ...capture };
}

export function getDiagnostics() {
    return state;
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Render an NPC's remembered slots into a table cell. */
function memoryCell(rec) {
    if (!rec) return '<span style="opacity:.5">—</span>';
    const line = (label, slot) => {
        if (!slot?.summary) return '';
        const raw = slot.kind === 'snippet' ? ' <span style="opacity:.5">(raw)</span>' : '';
        return `<b>${label}:</b> ${esc(slot.summary)}${raw}`;
    };
    const out = [line('with you', rec.slots?.lastWithUser), line('alone', rec.slots?.lastAlone)].filter(Boolean);
    return out.length ? out.join('<br>') : '<span style="opacity:.5">(no events yet)</span>';
}

/**
 * Build a compact one-block status summary for the settings panel.
 * @param {object} store  Map of stored records (allRecords()).
 * @returns {string} HTML
 */
export function renderStatus(store) {
    const idx = state.index;
    if (!idx) return '<small>Not loaded.</small>';

    const src = idx.fromManifest
        ? `manifest × ${idx.manifests.length} book(s), schema ${idx.schema}`
        : (idx.byId.size ? 'prose fallback' : 'none');
    const stored = Object.keys(store ?? {}).length;

    let html = `Source: <b>${esc(src)}</b><br>`;
    html += `NPCs known: <b>${idx.byId.size}</b> · stored: <b>${stored}</b> · scenes: <b>${idx.sceneByUid.size}</b>`;

    const t = state.lastTurn;
    if (t) {
        const resolved = t.mapping.filter(m => m.kind === 'npc' || m.kind === 'scene').length;
        const unresolved = t.mapping.filter(m => m.kind === 'unresolved').length;
        const present = t.npcIds.map(id => esc(idx.byId.get(id)?.displayName ?? id)).join(', ') || '—';
        html += `<br>Last turn: <b>${resolved}/${t.mapping.length}</b> activations resolved`;
        html += `<br>Present: <b>${present}</b>`;
        if (t.sceneId) html += `<br>Scene: <b>${esc(t.sceneId)}</b>`;
        if (unresolved > 0) html += `<br><span style="color:var(--warning,#e0a800)">⚠ ${unresolved} activation(s) unresolved</span>`;
    }
    return html;
}

/**
 * Build the full inspector report.
 * @param {object} store      Map of stored records (allRecords()).
 * @param {object} settings
 * @returns {string} HTML
 */
export function renderReport(store, settings) {
    const idx = state.index;
    const parts = [];

    parts.push('<h3>NPC Memory — diagnostics</h3>');

    // Manifests / source.
    if (!idx) {
        parts.push('<p><em>Index not loaded. Open a chat or click “Reload manifest”.</em></p>');
        return parts.join('\n');
    }
    // Every loaded book — so you can see whether the expected lorebooks (and
    // their manifests) are actually loaded at index-build time.
    parts.push('<h4>Loaded books</h4>');
    if (idx.books?.length) {
        const rows = idx.books.map(b => {
            const tag = b.mode === 'manifest' ? '<b>manifest</b>'
                : b.mode === 'prose' ? 'prose'
                    : '<span style="opacity:.6">no NPCs</span>';
            const origin = b.via === 'group-member'
                ? 'group member'
                : '<span style="opacity:.6">world info</span>';
            return `<tr><td><b>${esc(b.world || '(unnamed)')}</b></td><td>${b.entries}</td><td>${tag}</td><td>${b.npcCount || ''}</td><td><small>${origin}</small></td></tr>`;
        }).join('');
        parts.push('<table style="width:100%;border-collapse:collapse" class="npcmem-table">' +
            '<thead><tr><th>book</th><th>entries</th><th>source</th><th>npcs</th><th>origin</th></tr></thead>' +
            `<tbody>${rows}</tbody></table>`);
    } else {
        parts.push('<p><em>No world info loaded.</em></p>');
    }

    parts.push('<h4>Manifests</h4>');
    if (idx.manifests.length) {
        parts.push('<ul>' + idx.manifests.map(m =>
            `<li><b>${esc(m.world || '(unnamed)')}</b> — schema ${m.schema}, npcs: ${m.npcIds.map(esc).join(', ') || '—'}</li>`,
        ).join('') + '</ul>');
    } else if (idx.byId.size) {
        parts.push('<p>No manifest found — using <b>prose fallback</b> from lorebook comments.</p>');
    } else {
        parts.push('<p><em>No NPC data found in loaded world info.</em></p>');
    }

    // Persona.
    if (idx.personas?.user) {
        const u = idx.personas.user;
        parts.push(`<h4>Persona</h4><p>${esc(u.name ?? '—')} <small>(${(u.aliases || []).map(esc).join(', ')})</small></p>`);
    }

    // NPC roster.
    parts.push('<h4>NPC roster</h4>');
    if (idx.byId.size) {
        const rows = [];
        for (const rec of idx.byId.values()) {
            const facets = Object.entries(rec.facets).map(([k, v]) => `${esc(k)}→${esc(v)}`).join(', ') || '—';
            const rels = (rec.relationships || []).map(r => `${esc(r.to)}${r.kind ? ` (${esc(r.kind)})` : ''}`).join(', ') || '—';
            const sr = store?.[rec.id];
            const known = sr ? `✓ ${sr.events?.length || 0}` : '·';
            const mem = memoryCell(sr);
            rows.push(`<tr><td>${known}</td><td><b>${esc(rec.id)}</b></td><td>${esc(rec.displayName)}</td>` +
                `<td><small>${facets}</small></td><td><small>${rels}</small></td>` +
                `<td><small>${mem}</small></td></tr>`);
        }
        parts.push('<table style="width:100%;border-collapse:collapse" class="npcmem-table">' +
            '<thead><tr><th>stored (ev)</th><th>id</th><th>name</th><th>facets (uid)</th><th>relationships</th><th>remembered memory</th></tr></thead>' +
            `<tbody>${rows.join('')}</tbody></table>`);
    } else {
        parts.push('<p><em>none</em></p>');
    }

    // Last-turn activation mapping — the key "what just happened" view.
    parts.push('<h4>Last turn — World Info activation mapping</h4>');
    const t = state.lastTurn;
    if (!t) {
        parts.push('<p><em>No generation observed yet this session.</em></p>');
    } else {
        const when = new Date(t.at).toLocaleTimeString();
        const rows = t.mapping.map(m => {
            let res;
            if (m.kind === 'unresolved') {
                res = '<span style="color:var(--warning,#e0a800)">unresolved</span>';
            } else if (m.kind === 'ignored') {
                res = '<span style="opacity:.6">ignored (non-NPC lore)</span>';
            } else {
                res = `${esc(m.kind)} → <b>${esc(m.id)}</b> <small>(${esc(m.via)})</small>`;
            }
            return `<tr><td><small>${esc(m.world)}</small></td><td>${esc(m.uid)}</td><td><small>${esc(m.comment)}</small></td><td>${res}</td></tr>`;
        }).join('');
        const ignored = t.mapping.filter(m => m.kind === 'ignored').length;
        const unresolved = t.mapping.filter(m => m.kind === 'unresolved').length;
        parts.push(`<p><small>at ${esc(when)} · present: <b>${t.npcIds.map(esc).join(', ') || '—'}</b>` +
            `${t.sceneId ? ` · scene: <b>${esc(t.sceneId)}</b>` : ''}` +
            ` · ignored: ${ignored} · unresolved: ${unresolved}</small></p>`);
        parts.push('<table style="width:100%;border-collapse:collapse" class="npcmem-table">' +
            '<thead><tr><th>book</th><th>uid</th><th>comment</th><th>resolved</th></tr></thead>' +
            `<tbody>${rows}</tbody></table>`);

        // Exact injected text.
        parts.push('<h4>Injected this turn</h4>');
        parts.push(t.injected
            ? `<pre style="white-space:pre-wrap" class="npcmem-pre">${esc(t.injected)}</pre>`
            : '<p><em>(nothing injected)</em></p>');
    }

    // Last capture — the turn-tag / inference result fed into the store.
    parts.push('<h4>Last capture</h4>');
    const c = state.lastCapture;
    if (!c) {
        parts.push('<p><em>No message captured yet this session.</em></p>');
    } else {
        const srcTag = c.source === 'inferred'
            ? '<span style="color:var(--warning,#e0a800)">inferred</span>'
            : `<b>${esc(c.source)}</b>`;
        parts.push(`<p><small>at ${esc(new Date(c.at).toLocaleTimeString())} · actors: <b>${(c.actors || []).map(esc).join(', ') || '—'}</b>` +
            ` · withUser: <b>${c.withUser}</b>${c.scene ? ` · scene: <b>${esc(c.scene)}</b>` : ''} · source: ${srcTag}</small></p>`);
    }

    parts.push(`<h4>Settings</h4><pre class="npcmem-pre">${esc(JSON.stringify(settings, null, 2))}</pre>`);
    return parts.join('\n');
}

/** Build a plain-text version of the report (for console / slash output). */
export function renderReportText(store) {
    const idx = state.index;
    const L = [];
    L.push('=== NPC Memory diagnostics ===');
    if (!idx) { L.push('index not loaded.'); return L.join('\n'); }
    L.push(`source: ${idx.fromManifest ? `manifest ×${idx.manifests.length}, schema ${idx.schema}` : (idx.byId.size ? 'prose fallback' : 'none')}`);
    for (const m of idx.manifests) L.push(`  book "${m.world}": schema ${m.schema}, npcs [${m.npcIds.join(', ')}]`);
    L.push(`npcs (${idx.byId.size}):`);
    for (const rec of idx.byId.values()) {
        L.push(`  ${rec.id} "${rec.displayName}" stored=${store?.[rec.id] ? 'yes' : 'no'} facets={${Object.entries(rec.facets).map(([k, v]) => `${k}:${v}`).join(',')}} book=${rec.world}`);
    }
    const t = idx && getDiagnostics().lastTurn;
    if (t) {
        const resolved = t.mapping.filter(m => m.kind !== 'unresolved').length;
        L.push(`last turn: ${resolved}/${t.mapping.length} resolved; present [${t.npcIds.join(', ')}]${t.sceneId ? ` scene=${t.sceneId}` : ''}`);
        for (const m of t.mapping) L.push(`  [${m.world} ${m.uid}] ${m.comment} -> ${m.kind}${m.id ? `:${m.id}` : ''}`);
    }
    return L.join('\n');
}
