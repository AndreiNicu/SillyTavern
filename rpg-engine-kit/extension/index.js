/**
 * RPG Engine — SillyTavern client extension (orchestrator half).
 *
 * Reacts to chat events and talks to the rpg-engine server plugin over HTTP:
 *  - before each generation, injects the authoritative sheet into the prompt;
 *  - after each AI reply, sends the player action + narration to a small
 *    parser LLM, which classifies the combat outcome as JSON, then asks the
 *    server to apply it;
 *  - on delete/swipe, rolls the server state back to the pre-action snapshot.
 *
 * The server owns the numbers; this file only wires events to it.
 */

/* global SillyTavern, jQuery, $, fetch, toastr, console, globalThis, structuredClone */

const API = '/api/plugins/rpg-engine';
const PROMPT_KEY = 'rpg_engine_sheet';
const INJECT_IN_CHAT = 1; // extension_prompt_types.IN_CHAT
const ROLE_SYSTEM = 0;    // extension_prompt_roles.SYSTEM
const MODULE = 'rpg_engine';

const defaultSettings = {
    enabled: true,
    injectDepth: 2,
    parseEnabled: true,
    parserMaxTokens: 200,
    // Reliability controls (see schema/README.md "Reliability").
    combatModeOnly: true,           // only parse while combat mode is on (cheapest gate)
    keywordGate: true,              // within combat mode, only fire on a keyword hit
    // NOTE: generateRaw uses the active preset's sampler settings; it has no
    // per-call temperature override. For a stable, low-temp parser, point the
    // engine at a dedicated low-temperature connection profile (see README).
    combatKeywords:
        'attack,hit,hits,strike,strikes,slash,slashes,stab,stabs,pierce,pierces,' +
        'cut,cuts,cleave,cleaves,smash,smashes,bash,crush,shoot,shoots,fire,fires,' +
        'swing,swings,punch,kick,bite,bites,claw,claws,wound,wounds,blood,bleed,' +
        'dodge,dodges,parry,parries,block,blocks,miss,misses,damage,hurt,injure',
};

// JSON schema the parser LLM must fill. The server maps damage_tier -> dice.
const COMBAT_SCHEMA = {
    name: 'combat_outcome',
    description: 'Structured outcome of the latest combat exchange in the roleplay.',
    strict: true,
    value: {
        type: 'object',
        additionalProperties: false,
        properties: {
            action_valid: { type: 'boolean', description: 'True ONLY if a concrete attack that landed and dealt damage occurred this exchange. Misses, dodges, parries, threats, and movement are NOT valid.' },
            attacker: { type: 'string', description: 'Short snake_case id of the attacker, e.g. "player" or "orc_captain". Must be someone present in the scene.' },
            target: { type: 'string', description: 'Short snake_case id of who was hit, e.g. "player" or "orc_captain". Must be someone present in the scene.' },
            attack_type: { type: 'string', description: 'Lowercase damage type, e.g. "slashing", "piercing", "bludgeoning", "fire". Used for resistances.' },
            damage_tier: { type: 'string', enum: ['none', 'graze', 'light', 'medium', 'heavy', 'critical'] },
            evidence: { type: 'string', description: 'A SHORT verbatim quote from the narration that justifies the tier (e.g. "the blade bites deep into his shoulder"). Must be copied from the text, not paraphrased.' },
        },
        required: ['action_valid', 'attacker', 'target', 'attack_type', 'damage_tier', 'evidence'],
    },
};

// Rubric anchors each tier to concrete narrative cues — small models classify
// far better with a rubric than with bare enum names.
const PARSER_SYSTEM_PROMPT =
    'You are a strict combat adjudicator for a tabletop RPG. Read the player\'s action and the ' +
    'narrator\'s response, then output ONLY the structured combat outcome JSON.\n\n' +
    'Rules:\n' +
    '- Use short snake_case ids for attacker/target ("player" for the user\'s character).\n' +
    '- If no attack LANDED (a miss, dodge, parry, block, threat, or pure movement), set ' +
    'action_valid=false and damage_tier="none".\n' +
    '- Quote real text in "evidence"; never invent details or numbers.\n\n' +
    'Damage tier rubric (judge by what the narration describes, not by who is fighting):\n' +
    '- none: no hit landed (miss/dodge/parry/block) or no combat.\n' +
    '- graze: barely connects; a scratch, nick, or glancing touch.\n' +
    '- light: a real but minor hit; "grazes", "clips", "shallow cut".\n' +
    '- medium: a solid, clean hit; "lands squarely", "bites into", "staggers".\n' +
    '- heavy: a brutal, forceful blow; "drives deep", "cracks bone", "sends reeling", draws a cry.\n' +
    '- critical: a maiming, near-lethal strike explicitly described as devastating, crippling, or fatal.\n' +
    'When unsure between two tiers, choose the LOWER one.';

let ctx = null;
let settings = defaultSettings;
let lastSheet = '';
let isParsing = false; // guard against re-entrancy from the parser's own generation

function getSettings() {
    const all = ctx.extensionSettings;
    if (!all[MODULE]) all[MODULE] = structuredClone(defaultSettings);
    // Backfill any keys added in later versions.
    for (const k of Object.keys(defaultSettings)) {
        if (all[MODULE][k] === undefined) all[MODULE][k] = defaultSettings[k];
    }
    return all[MODULE];
}

async function api(method, route, body) {
    const opts = { method, headers: ctx.getRequestHeaders() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${route}`, opts);
    if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`);
    return res.json();
}

function notify(msg, type = 'info') {
    if (typeof toastr !== 'undefined' && toastr[type]) toastr[type](msg, 'RPG Engine');
}

/* --------------------------------------------------------- prompt inject */

/** Refresh the injected sheet from the server (called before each generation). */
async function refreshSheet() {
    const chatId = ctx.getCurrentChatId();
    if (!settings.enabled || !chatId) {
        ctx.setExtensionPrompt(PROMPT_KEY, '', INJECT_IN_CHAT, settings.injectDepth, false, ROLE_SYSTEM);
        return;
    }
    try {
        const { sheet } = await api('GET', `/sheet?chatId=${encodeURIComponent(chatId)}`);
        lastSheet = sheet || '';
    } catch (err) {
        console.warn('[rpg-engine] sheet fetch failed, using cached', err);
    }
    ctx.setExtensionPrompt(PROMPT_KEY, lastSheet, INJECT_IN_CHAT, settings.injectDepth, false, ROLE_SYSTEM);
}

// Declared in manifest.json as the generate_interceptor — runs before every
// main generation. We use it purely to refresh the injected sheet.
globalThis.rpgEngine_interceptGeneration = async function (_chat, _contextSize, _abort, _type) {
    if (isParsing) return; // don't inject/parse during the parser's own call
    await refreshSheet();
};

/* ------------------------------------------------------------- parse loop */

let combatMode = false; // toggled by the QR/button; gates parsing entirely when off

/** Build the compiled keyword regex from settings (word-boundary, case-insensitive). */
function combatKeywordRegex() {
    const words = String(settings.combatKeywords || '')
        .split(',').map(w => w.trim()).filter(Boolean)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return null;
    return new RegExp(`\\b(${words.join('|')})\\b`, 'i');
}

/** Cheap two-level gate: combat-mode flag, then keyword presence. */
function shouldParse(text) {
    if (settings.combatModeOnly && !combatMode) return false;
    if (settings.keywordGate) {
        const re = combatKeywordRegex();
        if (re && !re.test(text)) return false;
    }
    return true;
}

async function parseAndApply() {
    if (!settings.enabled || !settings.parseEnabled || isParsing) return;
    const chatId = ctx.getCurrentChatId();
    if (!chatId) return;

    const chat = ctx.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const aiMsg = chat[chat.length - 1];
    if (!aiMsg || aiMsg.is_user || aiMsg.is_system) return; // only adjudicate AI replies
    const msgIdx = chat.length - 1;

    // Find the most recent preceding user message as the player's action.
    let userAction = '';
    for (let i = chat.length - 2; i >= 0; i--) {
        if (chat[i].is_user) { userAction = chat[i].mes || ''; break; }
        if (!chat[i].is_system) break; // stop at the previous AI turn
    }

    // Two-level gate: skip the LLM call entirely outside combat / without keywords.
    const combinedText = `${userAction}\n${aiMsg.mes || ''}`;
    if (!shouldParse(combinedText)) return;

    // Pass the keyword that triggered us as an anchor for the classification.
    const re = combatKeywordRegex();
    const hit = re && re.exec(combinedText);
    const hintLine = hit ? `Triggering combat keyword: "${hit[1]}"\n\n` : '';

    const prompt =
        hintLine +
        `Player action:\n${userAction || '(none)'}\n\n` +
        `Narrator response:\n${aiMsg.mes || ''}\n\n` +
        'Output the combat outcome JSON.';

    isParsing = true;
    try {
        let parsed = await ctx.generateRaw({
            prompt,
            systemPrompt: PARSER_SYSTEM_PROMPT,
            responseLength: settings.parserMaxTokens,
            jsonSchema: COMBAT_SCHEMA,
        });
        if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch { parsed = null; }
        }
        if (!parsed || typeof parsed !== 'object') return;

        // Corroboration: the cited evidence should actually appear in the text.
        // A fabricated quote is a strong hallucination signal — skip rather than apply.
        if (parsed.action_valid && parsed.evidence) {
            const ev = String(parsed.evidence).toLowerCase().replace(/\s+/g, ' ').trim();
            const hay = combinedText.toLowerCase().replace(/\s+/g, ' ');
            if (ev.length > 8 && !hay.includes(ev)) {
                console.warn('[rpg-engine] evidence not found in text, skipping apply:', parsed.evidence);
                notify('Combat parse skipped (unverified evidence).', 'warning');
                return;
            }
        }

        const result = await api('POST', '/apply', { chatId, msgIdx, parsed });
        if (result.sheet) lastSheet = result.sheet;
        if (result.ok && result.delta) notify(result.delta, 'success');
        else if (result.rejected) {
            console.warn('[rpg-engine] apply rejected:', result.delta);
            notify(result.delta, 'warning');
        }
    } catch (err) {
        console.error('[rpg-engine] parse/apply failed', err);
    } finally {
        isParsing = false;
    }
}

/* --------------------------------------------------------------- rollback */

async function rollback(msgIdx) {
    if (!settings.enabled) return;
    const chatId = ctx.getCurrentChatId();
    if (!chatId) return;
    try {
        const result = await api('POST', '/rollback', { chatId, msgIdx });
        if (result.sheet) lastSheet = result.sheet;
        if (result.restored) notify(`Reverted stats for message ${msgIdx}.`, 'info');
    } catch (err) {
        console.error('[rpg-engine] rollback failed', err);
    }
}

/* --------------------------------------------------------------- settings */

function renderSettings() {
    const html = `
    <div class="rpg-engine-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>RPG Engine</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="rpg_enabled">
                    <input id="rpg_enabled" type="checkbox"> Enable engine (inject sheet)
                </label>
                <label class="checkbox_label" for="rpg_parse_enabled">
                    <input id="rpg_parse_enabled" type="checkbox"> Auto-parse combat after each reply (extra LLM call)
                </label>
                <label class="checkbox_label" for="rpg_combat_only">
                    <input id="rpg_combat_only" type="checkbox"> Only parse while Combat Mode is ON
                </label>
                <label class="checkbox_label" for="rpg_keyword_gate">
                    <input id="rpg_keyword_gate" type="checkbox"> Require a combat keyword to fire the parser
                </label>
                <label for="rpg_depth">Injection depth</label>
                <input id="rpg_depth" type="number" class="text_pole" min="0" max="20" step="1">
                <div class="flex-container" style="gap:5px;margin-top:8px;">
                    <input id="rpg_combat_toggle" type="button" class="menu_button" value="Enter Combat Mode">
                    <input id="rpg_show" type="button" class="menu_button" value="Show State">
                    <input id="rpg_reset" type="button" class="menu_button" value="Reset Game">
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#rpg_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = $(this).prop('checked');
        ctx.saveSettingsDebounced();
    });
    $('#rpg_parse_enabled').prop('checked', settings.parseEnabled).on('change', function () {
        settings.parseEnabled = $(this).prop('checked');
        ctx.saveSettingsDebounced();
    });
    $('#rpg_combat_only').prop('checked', settings.combatModeOnly).on('change', function () {
        settings.combatModeOnly = $(this).prop('checked');
        ctx.saveSettingsDebounced();
    });
    $('#rpg_keyword_gate').prop('checked', settings.keywordGate).on('change', function () {
        settings.keywordGate = $(this).prop('checked');
        ctx.saveSettingsDebounced();
    });
    $('#rpg_combat_toggle').on('click', function () {
        combatMode = !combatMode;
        $(this).val(combatMode ? 'Exit Combat Mode' : 'Enter Combat Mode');
        notify(combatMode ? 'Combat mode ON.' : 'Combat mode OFF.', combatMode ? 'success' : 'info');
    });
    $('#rpg_depth').val(settings.injectDepth).on('input', function () {
        settings.injectDepth = Number($(this).val()) || 0;
        ctx.saveSettingsDebounced();
    });
    $('#rpg_show').on('click', async () => {
        const chatId = ctx.getCurrentChatId();
        if (!chatId) return notify('No active chat.', 'warning');
        const { state } = await api('GET', `/state?chatId=${encodeURIComponent(chatId)}`);
        notify(`<pre style="white-space:pre-wrap">${JSON.stringify(state.entities, null, 2)}</pre>`, 'info');
    });
    $('#rpg_reset').on('click', async () => {
        const chatId = ctx.getCurrentChatId();
        if (!chatId) return notify('No active chat.', 'warning');
        await api('POST', '/reset', { chatId });
        await refreshSheet();
        notify('Game reset to defaults.', 'success');
    });
}

/* ------------------------------------------------------------------- init */

jQuery(async () => {
    ctx = SillyTavern.getContext();
    settings = getSettings();

    const { eventSource, eventTypes } = ctx;
    eventSource.on(eventTypes.GENERATION_ENDED, () => { void parseAndApply(); });
    eventSource.on(eventTypes.MESSAGE_DELETED, (n) => { void rollback(Number(n)); });
    eventSource.on(eventTypes.MESSAGE_SWIPED, (idx) => { void rollback(Number(idx)); });
    eventSource.on(eventTypes.CHAT_CHANGED, () => { void refreshSheet(); });

    renderSettings();
    console.log('[rpg-engine] extension loaded');
});
