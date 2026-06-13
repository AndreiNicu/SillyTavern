/**
 * World Loader — SillyTavern client extension (orchestrator half).
 *
 * Turns a World-Forge export (.zip) into a ready-to-launch setup in one pass.
 * The server plugin (/api/plugins/world-loader/inspect) unzips and classifies
 * the bundle into a "load plan"; this file executes that plan against ST's own
 * import paths:
 *
 *   lorebooks  -> POST /api/worldinfo/edit            (native ST world info)
 *   characters -> POST /api/characters/import         (V2/V3 cards)
 *   preset     -> getPresetManager('openai').savePreset
 *   persona    -> initPersona() + /api/avatars/upload
 *   wiring     -> charSetAuxWorlds() (Tier-2 books), /world (Tier-1 + active arc)
 *
 * Scope is "import + stage": everything is imported and wired, but the group
 * chat is left for the user to create — that's the launch step.
 */

/* global SillyTavern, jQuery, $, fetch, FormData, File, Blob, toastr, console */

const API = '/api/plugins/world-loader';
const PRESET_API = 'openai'; // World-Forge ships chat-completion presets.

let ctx = null;
let currentPlan = null;

// Internal ST functions not exposed via getContext(). Imported lazily so a
// module-path change upstream degrades gracefully instead of breaking load.
let charSetAuxWorlds = null;
let initPersona = null;
let getUserAvatars = null;

async function loadInternals() {
    try {
        ({ charSetAuxWorlds } = await import('../../../world-info.js'));
    } catch (e) {
        console.warn('[world-loader] could not import world-info.js; character lorebook binding disabled', e);
    }
    try {
        ({ initPersona, getUserAvatars } = await import('../../../personas.js'));
    } catch (e) {
        console.warn('[world-loader] could not import personas.js; persona creation disabled', e);
    }
}

function notify(msg, type = 'info') {
    if (typeof toastr !== 'undefined' && toastr[type]) toastr[type](msg, 'World Loader');
}

/* ------------------------------------------------------------ low-level IO */

/** Create/overwrite a lorebook from a parsed JSON object. Returns its name. */
async function importLorebook(book) {
    const res = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name: book.name, data: book.data }),
    });
    if (!res.ok) throw new Error(`lorebook "${book.name}" -> HTTP ${res.status}`);
    return book.name;
}

/** Import a character card from a parsed JSON object. Returns its avatar id (no ext). */
async function importCharacter(card, fileBase) {
    const blob = new Blob([JSON.stringify(card)], { type: 'application/json' });
    const file = new File([blob], `${fileBase}.json`, { type: 'application/json' });
    const fd = new FormData();
    fd.append('avatar', file);
    fd.append('file_type', 'json');
    const res = await fetch('/api/characters/import', {
        method: 'POST',
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        body: fd,
        cache: 'no-cache',
    });
    if (!res.ok) throw new Error(`character "${fileBase}" -> HTTP ${res.status}`);
    const data = await res.json();
    return data.file_name; // avatar filename without extension == charLore key
}

/** Activate a world as a global (always-on) lorebook via the public /world command. */
async function activateGlobalWorld(name) {
    if (typeof ctx.executeSlashCommandsWithOptions !== 'function') return false;
    await ctx.executeSlashCommandsWithOptions(`/world silent=true state=on ${name}`);
    return true;
}

/** Create a persona from a description string and bind its protagonist lorebook. */
async function createPersona(persona) {
    if (typeof initPersona !== 'function') {
        return { ok: false, reason: 'persona API unavailable' };
    }
    const safe = (persona.name || 'Player').replace(/[^a-zA-Z0-9]/g, '') || 'Player';
    const avatarId = `${Date.now()}-${safe}.png`;

    // Give the persona the default avatar image so it renders in the picker.
    try {
        const img = await fetch('/img/user-default.png');
        const blob = await img.blob();
        const f = new File([blob], 'avatar.png', { type: 'image/png' });
        const fd = new FormData();
        fd.append('avatar', f);
        fd.append('overwrite_name', avatarId);
        await fetch('/api/avatars/upload', {
            method: 'POST',
            headers: ctx.getRequestHeaders({ omitContentType: true }),
            body: fd,
            cache: 'no-cache',
        });
    } catch (e) {
        console.warn('[world-loader] persona avatar upload failed (non-fatal)', e);
    }

    const lorebookName = persona.lorebook ? persona.lorebook.name : '';
    await initPersona(avatarId, persona.name || 'Player', persona.description || '', '', { lorebook: lorebookName });
    try { if (typeof getUserAvatars === 'function') await getUserAvatars(true, avatarId); } catch { /* refresh is cosmetic */ }
    return { ok: true, avatarId };
}

/* --------------------------------------------------------------- inspect */

async function inspect(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API}/inspect`, {
        method: 'POST',
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        body: fd,
        cache: 'no-cache',
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (!res.ok || !data.ok) {
        throw new Error(data.error || `inspect failed (HTTP ${res.status})`);
    }
    return data;
}

/* ------------------------------------------------------------------ load */

/** Collect every lorebook in the plan as a flat de-duplicated list. */
function allBooks(plan) {
    const seen = new Set();
    const out = [];
    const add = (b) => { if (b && !seen.has(b.name)) { seen.add(b.name); out.push(b); } };
    plan.worldBooks?.forEach(add);
    plan.groupBooks?.forEach(add);
    plan.arcBooks?.forEach((a) => { add(a); add(a.intimacy); });
    plan.characters?.forEach((c) => { add(c.lorebook); add(c.intimacy); });
    add(plan.persona?.lorebook);
    return out;
}

async function loadWorld(plan) {
    const summary = { lorebooks: 0, characters: 0, bound: 0, preset: null, persona: null, activated: [], notes: [] };

    // 1. Import every lorebook (native ST format -> /api/worldinfo/edit).
    for (const book of allBooks(plan)) {
        try {
            await importLorebook(book);
            summary.lorebooks++;
        } catch (e) {
            summary.notes.push(`Lorebook "${book.name}" failed: ${e.message}`);
        }
    }
    if (typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList();

    // 2. Import character cards and bind their Tier-2 books.
    for (const c of plan.characters || []) {
        try {
            const avatarId = await importCharacter(c.card, c.file.replace(/\.json$/i, ''));
            summary.characters++;
            const books = [c.lorebook, c.intimacy].filter(Boolean).map((b) => b.name);
            if (books.length && typeof charSetAuxWorlds === 'function') {
                charSetAuxWorlds(avatarId, books);
                summary.bound += books.length;
            } else if (books.length) {
                summary.notes.push(`Could not bind lorebook(s) to "${c.displayName}" (binding API unavailable).`);
            }
        } catch (e) {
            summary.notes.push(`Character "${c.displayName}" failed: ${e.message}`);
        }
    }
    if (typeof ctx.getCharacters === 'function') await ctx.getCharacters();

    // 3. Import + (best-effort) select the chat-completion preset.
    if (plan.preset) {
        try {
            const pm = ctx.getPresetManager(PRESET_API);
            await pm.savePreset(plan.preset.name, plan.preset.data);
            summary.preset = plan.preset.name;
            try {
                pm.selectPreset(plan.preset.name);
            } catch {
                summary.notes.push(`Preset imported as "${plan.preset.name}" — select it under a Chat Completion API.`);
            }
        } catch (e) {
            summary.notes.push(`Preset import failed: ${e.message}`);
        }
    }

    // 4. Create the persona and bind its protagonist lorebook.
    if (plan.persona) {
        try {
            const r = await createPersona(plan.persona);
            if (r.ok) summary.persona = plan.persona.name;
            else summary.notes.push(`Persona not created: ${r.reason}`);
        } catch (e) {
            summary.notes.push(`Persona creation failed: ${e.message}`);
        }
    }

    // 5. Activate Tier-1 world books globally, plus the default arc only.
    for (const wb of plan.worldBooks || []) {
        try { if (await activateGlobalWorld(wb.name)) summary.activated.push(wb.name); } catch { /* noop */ }
    }
    const activeArc = plan.defaults?.active_arc;
    const arc = (plan.arcBooks || []).find((a) => a.n === activeArc) || (plan.arcBooks || [])[0];
    if (arc) {
        try { if (await activateGlobalWorld(arc.name)) summary.activated.push(arc.name); } catch { /* noop */ }
    }

    // 6. Things the loader stages but cannot finish without the group chat.
    if (plan.groupBooks?.length) {
        summary.notes.push(`Group lorebook${plan.groupBooks.length > 1 ? 's' : ''} imported (${plan.groupBooks.map((b) => b.name).join(', ')}). This is an all-in-one alternative; left inactive to avoid double-firing the per-tier books. Activate it manually if you prefer it.`);
    }
    if (plan.rpg?.bestiary || plan.rpg?.userProfile) {
        summary.notes.push('RPG assets detected (bestiary / user profile). Character RPG profiles import with their cards; standalone bestiary/user-profile wiring into the RPG Engine is not automated yet.');
    }

    return summary;
}

/* --------------------------------------------------------------- panel UI */

function renderPlanPreview(plan) {
    const arcList = (plan.arcBooks || []).map((a) => `Arc ${a.n}${a.n === plan.defaults?.active_arc ? ' (active)' : ''}`).join(', ') || '—';
    const rows = [
        ['Source', plan.source === 'manifest' ? 'world.manifest.json' : 'filename convention'],
        ['World', `${plan.world?.name} (${plan.world?.mode})`],
        ['Characters', (plan.characters || []).map((c) => c.displayName).join(', ') || '—'],
        ['World books (Tier 1)', (plan.worldBooks || []).map((b) => b.name).join(', ') || '—'],
        ['Arcs (Tier 3)', arcList],
        ['Preset', plan.preset?.name || '—'],
        ['Persona', plan.persona ? `${plan.persona.name}${plan.persona.lorebook ? ' + protagonist book' : ''}` : '—'],
        ['RPG', plan.rpg?.bestiary || plan.rpg?.userProfile ? 'present' : '—'],
    ];
    const tbl = rows.map(([k, v]) => `<tr><td style="opacity:.7;padding-right:8px;white-space:nowrap">${k}</td><td>${escapeHtml(String(v))}</td></tr>`).join('');
    const warns = (plan.warnings || []).length
        ? `<div class="wl-warn"><b>Warnings</b><ul>${plan.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
        : '';
    return `<table class="wl-table">${tbl}</table>${warns}`;
}

function renderSummary(s) {
    const notes = s.notes.length ? `<div class="wl-warn"><b>Next steps & notes</b><ul>${s.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>` : '';
    return `
        <div class="wl-ok"><b>World loaded.</b></div>
        <ul>
            <li>${s.lorebooks} lorebook(s) imported${s.activated.length ? `, active: ${escapeHtml(s.activated.join(', '))}` : ''}</li>
            <li>${s.characters} character(s) imported, ${s.bound} character-book binding(s)</li>
            <li>Preset: ${s.preset ? escapeHtml(s.preset) : '—'}</li>
            <li>Persona: ${s.persona ? escapeHtml(s.persona) : '—'}</li>
        </ul>
        <div class="wl-launch"><b>To launch:</b> create a <i>group chat</i> with the imported characters (the lorebooks, persona and preset are already wired). Switch arcs later by toggling arc lorebooks in World Info.</div>
        ${notes}`;
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function renderPanel() {
    const html = `
    <div class="world-loader-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>World Loader</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small>Load a full World-Forge export (.zip): characters, tiered lorebooks, preset and persona, imported and wired in one pass.</small>
                <div class="wl-controls">
                    <input id="wl_file" type="file" accept=".zip" class="text_pole">
                    <input id="wl_inspect" type="button" class="menu_button" value="Inspect">
                </div>
                <div id="wl_preview" class="wl-box" style="display:none"></div>
                <input id="wl_load" type="button" class="menu_button" value="Load World" style="display:none;margin-top:8px">
                <div id="wl_summary" class="wl-box" style="display:none;margin-top:8px"></div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#wl_inspect').on('click', async () => {
        const file = $('#wl_file')[0]?.files?.[0];
        if (!file) return notify('Pick a World-Forge .zip first.', 'warning');
        $('#wl_inspect').prop('disabled', true).val('Inspecting…');
        try {
            currentPlan = await inspect(file);
            $('#wl_preview').html(renderPlanPreview(currentPlan)).show();
            $('#wl_load').show();
            $('#wl_summary').hide().empty();
        } catch (e) {
            notify(e.message, 'error');
            $('#wl_preview').hide();
            $('#wl_load').hide();
        } finally {
            $('#wl_inspect').prop('disabled', false).val('Inspect');
        }
    });

    $('#wl_load').on('click', async () => {
        if (!currentPlan) return;
        $('#wl_load').prop('disabled', true).val('Loading…');
        try {
            const summary = await loadWorld(currentPlan);
            $('#wl_summary').html(renderSummary(summary)).show();
            notify('World loaded — create a group chat to launch.', 'success');
        } catch (e) {
            notify(e.message, 'error');
            $('#wl_summary').html(`<div class="wl-warn">Load failed: ${escapeHtml(e.message)}</div>`).show();
        } finally {
            $('#wl_load').prop('disabled', false).val('Load World');
        }
    });
}

/* ------------------------------------------------------------------- init */

jQuery(async () => {
    ctx = SillyTavern.getContext();
    await loadInternals();
    renderPanel();
    console.log('[world-loader] extension loaded');
});
