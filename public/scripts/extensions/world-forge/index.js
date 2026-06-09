import { eventSource, event_types, this_chid, characters, substituteParams, chat, name1, getCurrentChatId, chat_metadata, saveMetadata, getRequestHeaders } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { ConnectionManagerRequestService } from '../shared.js';
import {
    loadWorldInfo,
    saveWorldInfo,
    createWorldInfoEntry,
    createNewWorldInfo,
    deleteWorldInfo,
    getFreeWorldName,
    reloadEditor,
    world_names,
    world_info_llm_filter_profile,
    getSortedEntries,
    METADATA_KEY,
} from '../../world-info.js';

const SETTINGS_KEY = 'world_forge';
const STYLE_CONTRACT_CLOSE = '</style_contract>';

// ---------------------------------------------------------------------------
// Key Moments — small-LLM driven recorder that distils recent chat into
// concise entries inside the chat-bound lorebook. Reuses the same secondary
// LLM connection profile as the World Info "LLM Filter" feature.
// ---------------------------------------------------------------------------
const KM_EXTRACT_MAX_TOKENS = 1024;
const KM_SUMMARIZE_MAX_TOKENS = 1536;
const KM_MAX_CANDIDATES = 8;

const DEFAULT_EXTRACT_PROMPT = [
    'You are analysing a roleplay/story transcript to spot KEY MOMENTS worth recording in a long-term memory lorebook.',
    'Key moments are things like: a newly developed character trait, an important plot development, a relationship change,',
    'a decision, a revelation, a gained/lost ability, or any notable event the story should remember later.',
    '',
    `Read the recent messages and list the distinct key moments you find (at most ${KM_MAX_CANDIDATES}).`,
    'Reply with ONLY a JSON array of short one-line strings, each summarising one candidate key moment.',
    'If nothing significant happened, reply with an empty array: [].',
].join('\n');

const DEFAULT_SUMMARIZE_PROMPT = [
    'You are recording selected key moments into a memory lorebook.',
    'For EACH selected key moment, write a concise, on-point description (1-3 sentences) capturing what happened and why it matters later,',
    'and provide 1-5 short trigger keywords (names, places, objects, concepts) that should make this memory resurface.',
    'ALWAYS include at least one keyword per moment — these are how the entry gets pulled back into context later.',
    'Keep descriptions factual and self-contained — they will be read out of chat context.',
    '',
    'Reply with ONLY a JSON array of objects in this exact shape:',
    '[{"title": "short label", "content": "the description", "keywords": ["kw1", "kw2"]}]',
].join('\n');

const reasoningTagRegex = /<(?:think|thinking|thought|reasoning)>[\s\S]*?<\/(?:think|thinking|thought|reasoning)>/gi;

let $kmOverlay = null;
let $kmStatus = null;
let $kmCandidates = null;
let $kmNotes = null;
let $kmRecord = null;
let kmBusy = false;

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }
    const s = extension_settings[SETTINGS_KEY];
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (typeof s.debug !== 'boolean') s.debug = true;
    if (typeof s.keyMomentsEnabled !== 'boolean') s.keyMomentsEnabled = true;
    if (typeof s.sceneTrackerEnabled !== 'boolean') s.sceneTrackerEnabled = true;
    if (typeof s.contextMessages !== 'number' || !Number.isFinite(s.contextMessages)) s.contextMessages = 10;
    s.contextMessages = Math.max(1, Math.min(50, Math.round(s.contextMessages)));
    return s;
}

function log(...args) {
    if (getSettings().debug) console.log('[world-forge]', ...args);
}

function warn(...args) {
    console.warn('[world-forge]', ...args);
}

// ----------------------------- style_override ------------------------------

function buildOverrideBlock(styleOverride) {
    if (!styleOverride || typeof styleOverride !== 'object') {
        return { block: '', applied: [], skipped: [] };
    }

    const directives = Array.isArray(styleOverride.directives)
        ? styleOverride.directives.filter(s => typeof s === 'string' && s.trim().length > 0)
        : [];

    if (directives.length === 0) {
        return { block: '', applied: [], skipped: [] };
    }

    const applied = directives.map(line => {
        const colonIdx = line.indexOf(':');
        return colonIdx > 0 ? line.slice(0, colonIdx).trim() : line;
    });

    return {
        block: `<style_override>\n${directives.join('\n')}\n</style_override>`,
        applied,
        skipped: [],
    };
}

function getActiveCharacter() {
    const idx = this_chid;
    if (idx === undefined || idx === null) return null;
    return characters?.[idx] ?? null;
}

function spliceOverrideIntoChat(chatArr, block) {
    if (!Array.isArray(chatArr)) return false;
    for (const msg of chatArr) {
        if (!msg || msg.role !== 'system' || typeof msg.content !== 'string') continue;
        const anchor = msg.content.indexOf(STYLE_CONTRACT_CLOSE);
        if (anchor === -1) continue;
        const insertAt = anchor + STYLE_CONTRACT_CLOSE.length;
        msg.content = msg.content.slice(0, insertAt) + '\n\n' + block + msg.content.slice(insertAt);
        return true;
    }
    return false;
}

function onChatCompletionPromptReady(eventData) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!eventData || eventData.dryRun) return;

    injectStyleOverride(eventData, settings);
    injectSceneState(eventData, settings);
}

function injectStyleOverride(eventData, settings) {
    const character = getActiveCharacter();
    if (!character) return;

    const styleOverride = character.data?.extensions?.world_forge?.style_override;
    const { block, applied, skipped } = buildOverrideBlock(styleOverride);
    const tag = `[world-forge] ${character.name || `chid#${this_chid}`}`;

    if (!block) {
        if (settings.debug) {
            if (skipped.length) console.warn(`${tag} → no override emitted; unknown enum values: ${skipped.join(', ')}`);
            else console.log(`${tag} → no override`);
        }
        return;
    }

    const resolvedBlock = substituteParams(block);
    const inserted = spliceOverrideIntoChat(eventData.chat, resolvedBlock);
    if (settings.debug) {
        if (inserted) console.log(`${tag} → injected style_override after </style_contract> (${applied.join(', ')})`);
        else console.warn(`${tag} → override built but no </style_contract> marker found in any system message; nothing injected`);
    }
}

/**
 * Splice the per-chat Scene Tracker state into the prompt as a system message
 * near the end (high recency) so the model stays aware of where the scene is,
 * who's present, and each character's condition. Gated by the per-chat
 * "Inject into prompt" toggle.
 */
function injectSceneState(eventData, settings) {
    if (!getCurrentChatId()) return;
    const scene = getSceneData();
    if (!scene.inject) return;

    const block = buildSceneBlock(scene);
    if (!block) return;

    const resolved = substituteParams(block);
    const chatArr = eventData.chat;
    if (!Array.isArray(chatArr)) return;
    const insertAt = Math.max(0, chatArr.length - 1);
    chatArr.splice(insertAt, 0, { role: 'system', content: resolved });
    if (settings.debug) console.log('[world-forge] → injected <scene_state> before final message');
}

// ------------------------------- helpers -----------------------------------

function stripReasoning(text) {
    return String(text ?? '').replace(reasoningTagRegex, '').trim();
}

/**
 * Tolerant JSON-array extractor for LLM replies that may be fenced or padded
 * with prose. Returns the parsed array, or null if nothing usable was found.
 * @param {string} text Raw model output
 * @returns {any[]|null}
 */
function extractJsonArray(text) {
    if (!text) return null;
    let s = String(text).replace(/```(?:json)?/gi, '').trim();

    try {
        const v = JSON.parse(s);
        if (Array.isArray(v)) return v;
    } catch { /* fall through to bracket scan */ }

    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start !== -1 && end > start) {
        try {
            const v = JSON.parse(s.slice(start, end + 1));
            if (Array.isArray(v)) return v;
        } catch { /* give up */ }
    }
    return null;
}

const KM_STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'as', 'is',
    'are', 'was', 'were', 'be', 'been', 'his', 'her', 'their', 'its', 'our', 'your', 'my', 'he',
    'she', 'they', 'it', 'we', 'you', 'i', 'that', 'this', 'these', 'those', 'from', 'by', 'into',
    'about', 'after', 'before', 'when', 'while', 'then', 'than', 'has', 'have', 'had', 'will',
    'would', 'could', 'should', 'not', 'no', 'so', 'up', 'out', 'who', 'what', 'which', 'now',
]);

/**
 * Derive trigger keywords from a moment's title/content when the model didn't
 * supply any. Recorded moments are Constant (always-on), so keys aren't required
 * for activation, but they're kept as useful metadata and let an entry also be
 * found or matched by keyword if its type is later changed in the WI editor.
 * Prefers proper nouns (capitalised tokens), then any significant words.
 * @param {string} title
 * @param {string} content
 * @returns {string[]}
 */
function deriveKeywords(title, content) {
    const words = `${title} ${content}`.match(/[A-Za-z][A-Za-z'-]{2,}/g) || [];
    const proper = words.filter(w => /^[A-Z]/.test(w) && !KM_STOPWORDS.has(w.toLowerCase()));
    const pool = (proper.length ? proper : words).filter(w => !KM_STOPWORDS.has(w.toLowerCase()));

    const seen = new Set();
    const result = [];
    for (const w of pool) {
        const lower = w.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        result.push(w);
        if (result.length >= 5) break;
    }
    return result;
}

/**
 * Build the "oldest → newest" transcript of the last N visible messages.
 * @returns {string}
 */
function buildRecentTranscript() {
    const settings = getSettings();
    const n = Math.max(1, Math.min(50, Number(settings.contextMessages) || 10));
    if (!Array.isArray(chat) || chat.length === 0) return '';

    const lines = [];
    for (let i = chat.length - 1; i >= 0 && lines.length < n; i--) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== 'string') continue;
        // Skip hidden/system filler but keep narrator content.
        if (msg.is_system && msg.extra?.type !== 'narrator') continue;
        const speaker = msg.is_user ? (msg.name || name1) : (msg.name || 'Character');
        const body = stripReasoning(msg.mes);
        if (!body) continue;
        lines.push(`${speaker}: ${body}`);
    }
    return lines.reverse().join('\n');
}

/**
 * Run a single secondary-LLM request via the WI LLM filter connection profile.
 * @param {string} prompt
 * @param {number} maxTokens
 * @returns {Promise<string>} Cleaned text content
 */
async function callSmallLlm(prompt, maxTokens) {
    const profileId = String(world_info_llm_filter_profile || '');
    if (!profileId) {
        throw new Error('No Connection Profile set. Configure it under World Info → "LLM Filter".');
    }
    const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens, { deterministic: true });
    const content = (result && typeof result === 'object' && 'content' in result) ? String(result.content ?? '') : '';
    return stripReasoning(content);
}

const KM_OWNER_TAG = 'world_forge_key_moments';

/**
 * Build a flat, chat-named lorebook filename for the current chat. SillyTavern's
 * World Info engine only lists flat files in the worlds directory, so the chat
 * name is encoded in the filename rather than a subfolder.
 * @param {string} chatId
 * @returns {string}
 */
function chatBookBaseName(chatId) {
    const base = `Key Moments - ${chatId}`
        .replace(/[^a-z0-9 _-]/gi, '_')
        .replace(/_{2,}/g, '_')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .substring(0, 100);
    return base || 'Key Moments';
}

/**
 * Resolve the chat-bound lorebook, creating a chat-named one if the chat isn't
 * bound yet. Returns whether we created it (so we know we may take ownership of
 * it for cleanup-on-delete; a pre-existing user-bound book is left unowned).
 * @returns {Promise<{book: string, created: boolean}>}
 */
async function getOrCreateChatBook() {
    const chatId = getCurrentChatId();
    if (!chatId) throw new Error('Open a chat first.');

    const existing = chat_metadata[METADATA_KEY];
    if (existing && world_names.includes(existing)) {
        return { book: existing, created: false };
    }

    const base = chatBookBaseName(chatId);
    const name = world_names.includes(base) ? getFreeWorldName(base) : base;
    if (!name) throw new Error('Could not allocate a lorebook name.');

    await createNewWorldInfo(name);
    chat_metadata[METADATA_KEY] = name;
    await saveMetadata();
    $('.chat_lorebook_button').addClass('world_set');
    return { book: name, created: true };
}

/**
 * Insert the given key-moment objects as keyword-triggered entries into the
 * chat-bound lorebook, with inclusion-group competition disabled for the book.
 * @param {{title: string, content: string, keywords: string[]}[]} moments
 * @returns {Promise<{book: string, added: number}>}
 */
async function insertKeyMoments(moments) {
    const { book, created } = await getOrCreateChatBook();
    const data = await loadWorldInfo(book);
    if (!data || typeof data !== 'object') throw new Error(`Failed to load lorebook "${book}".`);
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};

    // Only mutate book-level settings / take ownership for books our feature
    // created or already owns — never a user's pre-existing manually-bound
    // lorebook (which must keep its own settings and survive chat deletion).
    const alreadyOwned = data.extensions?.[KM_OWNER_TAG]?.owned === true;
    if (created || alreadyOwned) {
        // Per-book flag the user requested: "Disable inclusion group competition".
        data.disable_inclusion_group_competition = true;
        // Stamp ownership so the book can be cleaned up when its chat is deleted.
        if (!data.extensions || typeof data.extensions !== 'object') data.extensions = {};
        data.extensions[KM_OWNER_TAG] = { owned: true, chat_id: String(getCurrentChatId() ?? '') };
    }

    let added = 0;
    for (const moment of moments) {
        const title = String(moment?.title ?? '').trim();
        const content = String(moment?.content ?? '').trim();
        if (!content) continue;
        let keywords = Array.isArray(moment?.keywords)
            ? moment.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 10)
            : [];
        if (keywords.length === 0) keywords = deriveKeywords(title, content);

        const entry = createWorldInfoEntry(book, data);
        if (!entry) continue;
        entry.comment = title || content.slice(0, 50);
        entry.content = content;
        entry.key = keywords;
        // Constant (always-on): key moments are injected directly and stay OUT of
        // the WI LLM filter's candidate list (getLlmFilterCandidates skips constants).
        // This stops recorded moments from diluting the filter's picks for other
        // lorebooks, while keeping them reliably in context.
        entry.constant = true;
        added++;
    }

    if (added === 0) throw new Error('Nothing to record — the model returned no usable entries.');

    await saveWorldInfo(book, data, true);
    // Refresh the editor if this book happens to be open.
    reloadEditor(book);

    return { book, added };
}

/**
 * When a chat is deleted, remove any key-moments lorebook we created for it.
 * Matches only books we own (tagged) whose recorded chat_id equals the deleted
 * chat — never a user's manually-bound or global lorebook.
 * @param {string} deletedChatId Chat name/id from CHAT_DELETED / GROUP_CHAT_DELETED
 */
async function onChatDeleted(deletedChatId) {
    try {
        const id = String(deletedChatId ?? '').replace(/\.jsonl$/i, '').trim();
        if (!id) return;

        const res = await fetch('/api/worldinfo/list', { method: 'POST', headers: getRequestHeaders() });
        if (!res.ok) return;
        const list = await res.json();
        if (!Array.isArray(list)) return;

        const owned = list.filter((w) => {
            const tag = w?.extensions?.[KM_OWNER_TAG];
            return tag?.owned === true && String(tag.chat_id ?? '') === id;
        });

        for (const w of owned) {
            const name = w.file_id;
            const deleted = await deleteWorldInfo(name);
            log(`chat "${id}" deleted → removed key-moments lorebook "${name}" (${deleted ? 'ok' : 'not found'})`);
        }
    } catch (e) {
        warn('cleanup on chat delete failed', e);
    }
}

/**
 * One-time migration: when a chat opens, flip any older keyword-triggered key
 * moments in OUR owned chat-bound book to Constant. Older recorded moments were
 * keyword-triggered and thus appeared in the WI LLM filter's candidate list;
 * making them Constant removes them from the picker (restoring its original
 * behavior) while keeping them injected. Idempotent and only touches books we
 * own — a user's manually-bound lorebook is never modified.
 */
async function migrateOwnedBookToConstant() {
    try {
        const book = chat_metadata[METADATA_KEY];
        if (!book || !world_names.includes(book)) return;

        const data = await loadWorldInfo(book);
        if (!data?.entries || typeof data.entries !== 'object') return;
        if (data.extensions?.[KM_OWNER_TAG]?.owned !== true) return; // not our book

        let changed = 0;
        for (const uid of Object.keys(data.entries)) {
            const entry = data.entries[uid];
            if (entry && !entry.constant) {
                entry.constant = true;
                changed++;
            }
        }

        if (changed > 0) {
            await saveWorldInfo(book, data, true);
            reloadEditor(book);
            log(`migrated ${changed} key-moment entr${changed === 1 ? 'y' : 'ies'} to Constant in "${book}"`);
        }
    } catch (e) {
        warn('constant migration failed (non-fatal)', e);
    }
}

// ---------------------------------------------------------------------------
// Scene Tracker — a per-chat record of the current scene: where it's happening,
// who is present, and the basic condition of each non-player character. Stored
// in chat_metadata (like the chat-bound lorebook) and optionally injected into
// the prompt so the model keeps track of scene state across turns.
// ---------------------------------------------------------------------------
const SCENE_META_KEY = 'world_forge_scene';
const SCENE_EXTRACT_MAX_TOKENS = 1024;

/** @typedef {{name: string, role: 'user'|'character'|'npc', health?: string, condition?: string, lastLocation?: string}} ScenePerson */
/** @typedef {{location: string, present: ScenePerson[], inject: boolean}} SceneData */

/** @returns {SceneData} */
function defaultSceneData() {
    return { location: '', present: [], inject: true };
}

/**
 * Read (and lazily normalise) the current chat's scene record. Returns a live
 * reference held in chat_metadata so edits mutate in place; call saveSceneData
 * to persist.
 * @returns {SceneData}
 */
function getSceneData() {
    let s = chat_metadata[SCENE_META_KEY];
    if (!s || typeof s !== 'object') {
        s = defaultSceneData();
        chat_metadata[SCENE_META_KEY] = s;
    }
    if (typeof s.location !== 'string') s.location = '';
    if (!Array.isArray(s.present)) s.present = [];
    if (typeof s.inject !== 'boolean') s.inject = true;
    for (const p of s.present) {
        if (p && p.role !== 'user' && p.role !== 'character' && p.role !== 'npc') p.role = 'npc';
    }
    return s;
}

let saveSceneTimer = null;
function saveSceneData() {
    if (saveSceneTimer) clearTimeout(saveSceneTimer);
    saveSceneTimer = setTimeout(() => {
        saveSceneTimer = null;
        try {
            saveMetadata();
        } catch (e) {
            warn('saveMetadata failed', e);
        }
    }, 400);
}

/**
 * Render the scene record as a compact, prompt-friendly block. Lines with no
 * data are omitted; returns '' when there's nothing worth injecting.
 * @param {SceneData} scene
 * @returns {string}
 */
function buildSceneBlock(scene) {
    const lines = [];
    const location = String(scene.location || '').trim();
    if (location) lines.push(`Location: ${location}`);

    const present = (scene.present || []).filter(p => p && String(p.name || '').trim());
    if (present.length) {
        const names = present.map(p => (p.role === 'user' ? `${p.name} (you)` : p.name));
        lines.push(`Present: ${names.join(', ')}`);

        const status = [];
        for (const p of present) {
            if (p.role === 'user') continue;
            const bits = [];
            if (String(p.health || '').trim()) bits.push(`health: ${p.health.trim()}`);
            if (String(p.condition || '').trim()) bits.push(`condition: ${p.condition.trim()}`);
            if (String(p.lastLocation || '').trim()) bits.push(`last seen: ${p.lastLocation.trim()}`);
            if (bits.length) status.push(`- ${p.name} — ${bits.join('; ')}`);
        }
        if (status.length) {
            lines.push('Character status:');
            lines.push(...status);
        }
    }

    if (!lines.length) return '';
    return `<scene_state>\n${lines.join('\n')}\n</scene_state>`;
}

const SCENE_EXTRACT_PROMPT = [
    'You are tracking the current SCENE of a roleplay/story transcript.',
    'From the recent messages, determine the present state of the scene:',
    '- "location": a short description of where the scene is currently happening.',
    '- "present": the characters/NPCs (and the user, if they are in the scene) currently in it.',
    '  For each, give: "name"; "role" (one of "user", "character", or "npc" — "character" = a main AI character, "npc" = a minor/side character);',
    '  and for non-user entries the best current "health" (e.g. healthy, wounded, exhausted),',
    '  "condition" (any injury/soreness/status, or "" if none), and "lastLocation" (where they were last seen, or "").',
    'Base everything ONLY on the transcript. Use "" for anything unknown. Do not invent characters.',
    '',
    'Reply with ONLY a JSON object of this exact shape:',
    '{"location": "...", "present": [{"name": "...", "role": "npc", "health": "...", "condition": "...", "lastLocation": "..."}]}',
].join('\n');

/**
 * Tolerant JSON-object extractor (mirrors extractJsonArray but for objects).
 * @param {string} text
 * @returns {Record<string, any>|null}
 */
function extractJsonObject(text) {
    if (!text) return null;
    const s = String(text).replace(/```(?:json)?/gi, '').trim();
    try {
        const v = JSON.parse(s);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* fall through */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const v = JSON.parse(s.slice(start, end + 1));
            if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        } catch { /* give up */ }
    }
    return null;
}

/**
 * Run the secondary LLM over recent messages and merge the result into the
 * current scene record. Location is replaced; present cast is merged by name so
 * hand-edited stats survive unless the model has fresher detail. The roster is
 * never touched here.
 * @returns {Promise<{location: string, present: number}>}
 */
async function refreshSceneFromChat() {
    if (!getCurrentChatId()) throw new Error('Open a chat first.');
    const transcript = buildRecentTranscript();
    if (!transcript) throw new Error('No messages to scan in this chat.');

    const prompt = [
        SCENE_EXTRACT_PROMPT,
        '',
        'RECENT MESSAGES (oldest → newest):',
        transcript,
        '',
        'Reply with only the JSON object describing the current scene.',
    ].join('\n');

    const content = await callSmallLlm(prompt, SCENE_EXTRACT_MAX_TOKENS);
    const parsed = extractJsonObject(content);
    if (!parsed) {
        log('scene refresh: unparseable response', content);
        throw new Error('Could not parse the model reply.');
    }

    const scene = getSceneData();
    if (typeof parsed.location === 'string' && parsed.location.trim()) {
        scene.location = parsed.location.trim();
    }

    const incoming = Array.isArray(parsed.present) ? parsed.present : [];
    const byName = new Map(scene.present.map(p => [String(p.name || '').toLowerCase(), p]));
    for (const raw of incoming) {
        const name = String(raw?.name || '').trim();
        if (!name) continue;
        const role = (raw.role === 'user' || raw.role === 'character' || raw.role === 'npc') ? raw.role : 'npc';
        const existing = byName.get(name.toLowerCase());
        const next = existing || { name, role };
        next.name = name;
        next.role = role;
        if (role !== 'user') {
            if (String(raw.health || '').trim()) next.health = String(raw.health).trim();
            if (String(raw.condition || '').trim()) next.condition = String(raw.condition).trim();
            if (String(raw.lastLocation || '').trim()) next.lastLocation = String(raw.lastLocation).trim();
        }
        if (!existing) {
            scene.present.push(next);
            byName.set(name.toLowerCase(), next);
        }
    }

    saveSceneData();
    return { location: scene.location, present: scene.present.length };
}

// --------------------------------- UI --------------------------------------

const WINDOW_HTML = `
<div id="wf_km_overlay" class="wf_km_overlay wf_km_hidden">
    <div class="wf_km_modal">
        <div class="wf_km_header">
            <h3 class="margin0">
                <i class="fa-solid fa-star"></i>
                <span data-i18n="Add Key Moment">Add Key Moment</span>
            </h3>
            <div id="wf_km_close" class="menu_button menu_button_icon" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </div>
        </div>
        <div class="wf_km_body">
            <div id="wf_km_status" class="wf_km_status"></div>
            <div id="wf_km_candidates" class="wf_km_candidates"></div>
            <label for="wf_km_notes" data-i18n="Which ones to record / extra guidance">Which ones to record / extra guidance</label>
            <textarea id="wf_km_notes" class="text_pole wf_km_notes" rows="3"
                placeholder="Tick the moments above, and/or describe what to record (e.g. 'record the betrayal and the new fire ability; merge the first two')."></textarea>
        </div>
        <div class="wf_km_footer">
            <div id="wf_km_rescan" class="menu_button" title="Re-scan recent messages">
                <i class="fa-solid fa-rotate"></i> <span data-i18n="Re-scan">Re-scan</span>
            </div>
            <div id="wf_km_record" class="menu_button menu_button_primary">
                <i class="fa-solid fa-floppy-disk"></i> <span data-i18n="Record">Record</span>
            </div>
        </div>
    </div>
</div>`;

const BUTTON_HTML = `
<div id="wf_km_menu_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <div class="fa-solid fa-star extensionsMenuExtensionButton" title="Add Key Moment"></div>
    <span data-i18n="Add Key Moment">Add Key Moment</span>
</div>`;

const SETTINGS_HTML = `
<div class="world_forge_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b data-i18n="World Forge — Key Moments">World Forge — Key Moments</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="wf_km_enabled">
                <input id="wf_km_enabled" type="checkbox" />
                <span data-i18n="Show the &quot;Add Key Moment&quot; button">Show the "Add Key Moment" button</span>
            </label>
            <label class="checkbox_label" for="wf_scene_enabled">
                <input id="wf_scene_enabled" type="checkbox" />
                <span data-i18n="Show the &quot;Scene Tracker&quot; button">Show the "Scene Tracker" button</span>
            </label>
            <label for="wf_km_context_messages" data-i18n="Messages to scan">Messages to scan</label>
            <div class="flex-container alignItemsCenter flexGap10">
                <input id="wf_km_context_messages" class="neo-range-slider" type="range" min="1" max="50" step="1" />
                <input id="wf_km_context_messages_counter" class="neo-range-input" type="number" min="1" max="50" step="1" />
            </div>
            <small class="notes">
                Uses the same Connection Profile as World Info → LLM Filter. Recorded moments are saved as always-on (Constant) entries in the chat-bound lorebook, so they're injected directly and are not picked over by the LLM filter.
            </small>
        </div>
    </div>
</div>`;

const STYLE_CSS = `
.wf_km_overlay {
    position: fixed; inset: 0; z-index: 10010;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);
}
.wf_km_overlay.wf_km_hidden { display: none !important; }
.wf_km_modal {
    width: 560px; max-width: 92vw; max-height: 85vh;
    display: flex; flex-direction: column;
    background-color: var(--SmartThemeBlurTintColor, #1f1f1f);
    color: var(--SmartThemeBodyColor, #e0e0e0);
    border: 1px solid var(--SmartThemeBorderColor, #444);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    overflow: hidden;
}
.wf_km_header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
    flex: 0 0 auto;
}
.wf_km_body { padding: 12px 14px; overflow-y: auto; flex: 1 1 auto; }
.wf_km_status { opacity: 0.8; font-style: italic; margin-bottom: 8px; min-height: 1.2em; }
.wf_km_status.wf_km_error { color: var(--fullred, #e06666); font-style: normal; }
.wf_km_candidates { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.wf_km_candidate {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 6px 8px; border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
}
.wf_km_candidate input[type="checkbox"] { margin-top: 3px; flex: 0 0 auto; }
.wf_km_candidate span { line-height: 1.4; }
.wf_km_notes { width: 100%; box-sizing: border-box; resize: vertical; }
.wf_km_footer {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 14px; border-top: 1px solid var(--SmartThemeBorderColor, #444);
    flex: 0 0 auto;
}
.wf_km_busy { opacity: 0.6; pointer-events: none; }
@media (max-width: 600px) { .wf_km_modal { width: 96vw; } }`;

function injectStyles() {
    if (document.getElementById('wf_km_inline_styles')) return;
    const style = document.createElement('style');
    style.id = 'wf_km_inline_styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
}

function setStatus(text, isError = false) {
    if (!$kmStatus) return;
    $kmStatus.text(text || '');
    $kmStatus.toggleClass('wf_km_error', !!isError);
}

function setBusy(busy) {
    kmBusy = busy;
    $kmOverlay?.find('.wf_km_modal').toggleClass('wf_km_busy', busy);
}

function renderCandidates(items) {
    if (!$kmCandidates) return;
    $kmCandidates.empty();
    if (!items.length) {
        $kmCandidates.append('<small class="notes">No key moments were detected. You can still describe one in the box below and Record it.</small>');
        return;
    }
    for (const text of items) {
        const id = `wf_km_cand_${Math.random().toString(36).slice(2)}`;
        const $row = $('<label class="wf_km_candidate"></label>').attr('for', id);
        $('<input type="checkbox" checked>').attr('id', id).appendTo($row);
        $('<span></span>').text(text).appendTo($row);
        $kmCandidates.append($row);
    }
}

function getSelectedCandidates() {
    const selected = [];
    $kmCandidates?.find('.wf_km_candidate').each(function () {
        const checked = $(this).find('input[type="checkbox"]').prop('checked');
        if (checked) selected.push($(this).find('span').text());
    });
    return selected;
}

async function runExtract() {
    if (kmBusy) return;
    if (!getCurrentChatId()) {
        setStatus('Open a chat first.', true);
        return;
    }
    const transcript = buildRecentTranscript();
    if (!transcript) {
        setStatus('No messages to scan in this chat.', true);
        renderCandidates([]);
        return;
    }

    setBusy(true);
    setStatus('Scanning recent messages…');
    renderCandidates([]);
    try {
        const prompt = [
            DEFAULT_EXTRACT_PROMPT,
            '',
            'RECENT MESSAGES (oldest → newest):',
            transcript,
            '',
            'Reply with only the JSON array of candidate key moments.',
        ].join('\n');

        const content = await callSmallLlm(prompt, KM_EXTRACT_MAX_TOKENS);
        const parsed = extractJsonArray(content);
        if (!parsed) {
            log('extract: unparseable response', content);
            setStatus('Could not parse the model reply. You can still type a moment below and Record it.', true);
            renderCandidates([]);
            return;
        }
        const items = parsed
            .map(x => (typeof x === 'string' ? x : (x?.title || x?.text || JSON.stringify(x))))
            .map(s => String(s).trim())
            .filter(Boolean)
            .slice(0, KM_MAX_CANDIDATES);
        renderCandidates(items);
        setStatus(items.length ? 'Tick the moments to keep, then Record.' : 'No key moments detected.');
    } catch (error) {
        warn('extract failed', error);
        setStatus(error?.message || String(error), true);
    } finally {
        setBusy(false);
    }
}

async function runRecord() {
    if (kmBusy) return;
    const selected = getSelectedCandidates();
    const notes = String($kmNotes?.val() ?? '').trim();
    if (selected.length === 0 && !notes) {
        setStatus('Tick at least one moment, or describe one in the box.', true);
        return;
    }

    setBusy(true);
    setStatus('Writing key moment(s)…');
    try {
        const transcript = buildRecentTranscript();
        const promptParts = [DEFAULT_SUMMARIZE_PROMPT, ''];
        if (selected.length) {
            promptParts.push('SELECTED KEY MOMENTS:', selected.map((s, i) => `${i + 1}. ${s}`).join('\n'), '');
        }
        if (notes) {
            promptParts.push('USER GUIDANCE (weigh this heavily):', notes, '');
        }
        promptParts.push(
            'RECENT MESSAGES (for context, oldest → newest):',
            transcript || '(none)',
            '',
            'Reply with only the JSON array of entry objects.',
        );

        const content = await callSmallLlm(promptParts.join('\n'), KM_SUMMARIZE_MAX_TOKENS);
        const parsed = extractJsonArray(content);
        if (!parsed || parsed.length === 0) {
            log('record: unparseable response', content);
            setStatus('The model did not return usable entries. Try rephrasing your guidance.', true);
            return;
        }

        const { book, added } = await insertKeyMoments(parsed);
        log(`recorded ${added} key moment(s) into "${book}"`);
        if (typeof toastr !== 'undefined') {
            toastr.success(`Recorded ${added} key moment${added === 1 ? '' : 's'} into "${book}".`, 'World Forge');
        }
        closeWindow();
    } catch (error) {
        warn('record failed', error);
        setStatus(error?.message || String(error), true);
    } finally {
        setBusy(false);
    }
}

function openWindow() {
    if (!$kmOverlay) return;
    $kmOverlay.removeClass('wf_km_hidden');
    if ($kmNotes) $kmNotes.val('');
    renderCandidates([]);
    runExtract();
}

function closeWindow() {
    if (!$kmOverlay) return;
    $kmOverlay.addClass('wf_km_hidden');
}

function applySettingsToUI() {
    const s = getSettings();
    $('#wf_km_enabled').prop('checked', s.keyMomentsEnabled);
    $('#wf_scene_enabled').prop('checked', s.sceneTrackerEnabled);
    $('#wf_km_context_messages').val(s.contextMessages);
    $('#wf_km_context_messages_counter').val(s.contextMessages);
    $('#wf_km_menu_button').toggle(!!s.keyMomentsEnabled);
    $('#wf_scene_menu_button').toggle(!!s.sceneTrackerEnabled);
}

function wireSettings() {
    const ctx = getContext();
    const save = () => ctx.saveSettingsDebounced();

    $('#wf_km_enabled').on('input', function () {
        getSettings().keyMomentsEnabled = !!$(this).prop('checked');
        $('#wf_km_menu_button').toggle(getSettings().keyMomentsEnabled);
        save();
    });

    $('#wf_scene_enabled').on('input', function () {
        getSettings().sceneTrackerEnabled = !!$(this).prop('checked');
        $('#wf_scene_menu_button').toggle(getSettings().sceneTrackerEnabled);
        save();
    });

    const onContextMessages = function () {
        const value = Math.max(1, Math.min(50, Number($(this).val()) || 10));
        getSettings().contextMessages = value;
        $('#wf_km_context_messages').val(value);
        $('#wf_km_context_messages_counter').val(value);
        save();
    };
    $('#wf_km_context_messages').on('input', onContextMessages);
    $('#wf_km_context_messages_counter').on('input', onContextMessages);
}

function initKeyMomentsUI() {
    try {
        injectStyles();
    } catch (e) {
        warn('style injection failed (non-fatal)', e);
    }

    try {
        $(document.body).append(WINDOW_HTML);
        const $menu = $('#extensionsMenu');
        if ($menu.length) $menu.append(BUTTON_HTML);
        else $(document.body).append(BUTTON_HTML);

        const $settingsAnchor = $('#extensions_settings');
        if ($settingsAnchor.length) $settingsAnchor.append(SETTINGS_HTML);

        $kmOverlay = $('#wf_km_overlay');
        $kmStatus = $('#wf_km_status');
        $kmCandidates = $('#wf_km_candidates');
        $kmNotes = $('#wf_km_notes');
        $kmRecord = $('#wf_km_record');

        if ($kmOverlay.length === 0) {
            warn('Key Moments overlay not found after append (sanitizer may have stripped it)');
            return;
        }

        $('#wf_km_menu_button').on('click', openWindow);
        $('#wf_km_close').on('click', closeWindow);
        $('#wf_km_rescan').on('click', runExtract);
        $kmRecord.on('click', runRecord);
        // Click on the dimmed backdrop closes the modal.
        $kmOverlay.on('click', (e) => { if (e.target === $kmOverlay[0]) closeWindow(); });

        wireSettings();
        applySettingsToUI();
    } catch (e) {
        warn('Key Moments UI wiring failed', e);
        return;
    }

    try {
        registerSlashCommands();
    } catch (e) {
        warn('slash command registration failed (non-fatal)', e);
    }
}

function registerSlashCommands() {
    const ctx = getContext();
    if (!ctx?.SlashCommandParser || !ctx?.SlashCommand) return;
    const { SlashCommandParser, SlashCommand } = ctx;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'keymoment',
        callback: () => { openWindow(); return ''; },
        helpString: 'Opens the World Forge "Add Key Moment" recorder.',
    }));
}

// ----------------------------- Scene Tracker UI ----------------------------

const SCENE_WINDOW_HTML = `
<div id="wf_scene_window" class="wf_scene_window wf_scene_hidden">
    <div class="wf_scene_header flex-container alignItemsCenter spaceBetween">
        <h3 class="margin0">
            <i class="fa-solid fa-masks-theater"></i>
            <span data-i18n="Scene Tracker">Scene Tracker</span>
        </h3>
        <div class="flex-container flexGap5 alignItemsCenter">
            <label class="wf_scene_inject" title="Inject scene state into the prompt">
                <input id="wf_scene_inject" type="checkbox" />
                <span data-i18n="Inject">Inject</span>
            </label>
            <div id="wf_scene_refresh" class="menu_button menu_button_icon" title="Refresh from recent messages">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
            </div>
            <div id="wf_scene_close" class="menu_button menu_button_icon" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </div>
        </div>
    </div>
    <div class="wf_scene_tabs">
        <div class="wf_scene_tab wf_scene_tab_active" data-tab="location" data-i18n="Location">Location</div>
        <div class="wf_scene_tab" data-tab="present" data-i18n="In the Scene">In the Scene</div>
        <div class="wf_scene_tab" data-tab="roster" data-i18n="NPC Roster">NPC Roster</div>
    </div>
    <div id="wf_scene_status" class="wf_scene_status"></div>
    <div class="wf_scene_body">
        <div id="wf_scene_pane_location" class="wf_scene_pane wf_scene_pane_active">
            <label data-i18n="Where is the current scene happening?">Where is the current scene happening?</label>
            <textarea id="wf_scene_location" class="text_pole wf_scene_location" rows="4"
                placeholder="e.g. The rain-soaked back alley behind the Copper Lantern tavern, near midnight."></textarea>
        </div>
        <div id="wf_scene_pane_present" class="wf_scene_pane">
            <div id="wf_scene_present_list" class="wf_scene_list"></div>
            <div class="wf_scene_add_row">
                <input id="wf_scene_present_name" class="text_pole" type="text" placeholder="Add someone to the scene…" />
                <div id="wf_scene_present_add" class="menu_button" title="Add to scene"><i class="fa-solid fa-plus"></i></div>
            </div>
        </div>
        <div id="wf_scene_pane_roster" class="wf_scene_pane">
            <small class="notes" data-i18n="NPCs available in this roleplay's active lorebooks. Click + to add one to the scene.">NPCs available in this roleplay's active lorebooks. Click + to add one to the scene.</small>
            <div class="wf_scene_roster_controls">
                <select id="wf_scene_roster_book" class="text_pole"></select>
                <div id="wf_scene_roster_reload" class="menu_button menu_button_icon" title="Reload from lorebooks"><i class="fa-solid fa-rotate"></i></div>
            </div>
            <input id="wf_scene_roster_search" class="text_pole" type="text" placeholder="Filter by name or content…" />
            <div id="wf_scene_roster_count" class="wf_scene_roster_count"></div>
            <div id="wf_scene_roster_list" class="wf_scene_list"></div>
        </div>
    </div>
</div>`;

const SCENE_BUTTON_HTML = `
<div id="wf_scene_menu_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <div class="fa-solid fa-masks-theater extensionsMenuExtensionButton" title="Toggle Scene Tracker"></div>
    <span data-i18n="Scene Tracker">Scene Tracker</span>
</div>`;

const SCENE_CSS = `
#wf_scene_window {
    position: fixed !important;
    top: var(--topBarBlockSize, 40px) !important;
    right: 0 !important; left: auto !important; bottom: 0 !important;
    width: 420px !important; max-width: 90vw !important;
    margin: 0 !important; z-index: 3000;
    background-color: var(--SmartThemeBlurTintColor, #1f1f1f);
    color: var(--SmartThemeBodyColor, #e0e0e0);
    border-left: 1px solid var(--SmartThemeBorderColor, #444);
    box-shadow: -4px 0 12px rgba(0, 0, 0, 0.35);
    display: flex; flex-direction: column;
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    padding: 0 !important; border-radius: 0 !important; overflow: hidden;
}
#wf_scene_window.wf_scene_hidden { display: none !important; }
.wf_scene_header {
    padding: 8px 12px; border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
    flex: 0 0 auto; user-select: none;
}
.wf_scene_inject { display: flex; align-items: center; gap: 4px; font-size: 0.85em; opacity: 0.85; cursor: pointer; }
.wf_scene_inject input { margin: 0; }
.wf_scene_tabs { display: flex; flex: 0 0 auto; border-bottom: 1px solid var(--SmartThemeBorderColor, #444); }
.wf_scene_tab {
    flex: 1 1 0; text-align: center; padding: 8px 4px; cursor: pointer;
    opacity: 0.6; border-bottom: 2px solid transparent; user-select: none; font-size: 0.9em;
}
.wf_scene_tab:hover { opacity: 0.85; }
.wf_scene_tab_active { opacity: 1; border-bottom-color: var(--SmartThemeQuoteColor, #6bb1ff); }
.wf_scene_status { padding: 4px 12px 0; min-height: 0; font-size: 0.8em; opacity: 0.7; font-style: italic; }
.wf_scene_status.wf_scene_error { color: var(--fullred, #e06666); font-style: normal; opacity: 1; }
.wf_scene_body { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 12px; }
.wf_scene_pane { display: none; flex-direction: column; gap: 8px; }
.wf_scene_pane_active { display: flex; }
.wf_scene_location { width: 100%; box-sizing: border-box; resize: vertical; }
.wf_scene_list { display: flex; flex-direction: column; gap: 8px; }
.wf_scene_person {
    border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 8px;
    padding: 8px; background: rgba(255, 255, 255, 0.03);
}
.wf_scene_person_head { display: flex; align-items: center; gap: 6px; }
.wf_scene_person_head .text_pole { flex: 1 1 auto; min-width: 0; }
.wf_scene_role {
    flex: 0 0 auto; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 2px 6px; border-radius: 10px; cursor: pointer; user-select: none;
    border: 1px solid var(--SmartThemeBorderColor, #555); opacity: 0.85; white-space: nowrap;
}
.wf_scene_stats { display: grid; grid-template-columns: auto 1fr; gap: 6px 8px; margin-top: 8px; align-items: center; }
.wf_scene_stats label { font-size: 0.82em; opacity: 0.8; }
.wf_scene_stats .text_pole { width: 100%; box-sizing: border-box; }
.wf_scene_remove { flex: 0 0 auto; cursor: pointer; opacity: 0.6; }
.wf_scene_remove:hover { opacity: 1; color: var(--fullred, #e06666); }
.wf_scene_add_row { display: flex; gap: 6px; align-items: center; }
.wf_scene_add_row .text_pole { flex: 1 1 auto; min-width: 0; }
.wf_scene_roster_controls { display: flex; gap: 6px; align-items: center; }
.wf_scene_roster_controls .text_pole { flex: 1 1 auto; min-width: 0; }
.wf_scene_roster_count { font-size: 0.78em; opacity: 0.6; }
.wf_scene_npc {
    border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 8px;
    padding: 6px 8px; background: rgba(255, 255, 255, 0.03);
}
.wf_scene_npc_head { display: flex; align-items: center; gap: 6px; }
.wf_scene_npc_title { flex: 1 1 auto; min-width: 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf_scene_npc_title b { font-weight: 600; }
.wf_scene_npc_book { font-size: 0.72em; opacity: 0.55; }
.wf_scene_npc_content { margin-top: 6px; font-size: 0.85em; opacity: 0.85; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto; }
.wf_scene_npc_in { opacity: 0.45; }
.wf_scene_empty { opacity: 0.55; font-style: italic; padding: 8px 2px; }
@media (max-width: 768px) { #wf_scene_window { width: 100vw; max-width: 100vw; } }`;

function injectSceneStyles() {
    if (document.getElementById('wf_scene_inline_styles')) return;
    const style = document.createElement('style');
    style.id = 'wf_scene_inline_styles';
    style.textContent = SCENE_CSS;
    document.head.appendChild(style);
}

let $sceneWindow = null;
let $sceneStatus = null;
let sceneOpen = false;

function setSceneStatus(text, isError = false) {
    if (!$sceneStatus) return;
    $sceneStatus.text(text || '');
    $sceneStatus.toggleClass('wf_scene_error', !!isError);
}

const ROLE_CYCLE = { npc: 'character', character: 'user', user: 'npc' };

function renderPresent() {
    const scene = getSceneData();
    const $list = $('#wf_scene_present_list');
    if (!$list.length) return;
    $list.empty();

    if (!scene.present.length) {
        $list.append('<div class="wf_scene_empty">No one is in the scene yet. Add someone below, or hit Refresh.</div>');
        return;
    }

    scene.present.forEach((person, idx) => {
        const $card = $('<div class="wf_scene_person"></div>');
        const $head = $('<div class="wf_scene_person_head"></div>');

        const $role = $('<span class="wf_scene_role"></span>')
            .text(person.role)
            .attr('title', 'Click to change role (npc → character → user)')
            .on('click', () => {
                person.role = ROLE_CYCLE[person.role] || 'npc';
                saveSceneData();
                renderPresent();
            });

        const $name = $('<input class="text_pole" type="text">').val(person.name)
            .on('input', function () { person.name = $(this).val(); saveSceneData(); });

        const $remove = $('<div class="wf_scene_remove" title="Remove from scene"><i class="fa-solid fa-trash-can"></i></div>')
            .on('click', () => { scene.present.splice(idx, 1); saveSceneData(); renderPresent(); });

        $head.append($role, $name, $remove);
        $card.append($head);

        // Stats only for non-player (AI) characters & NPCs.
        if (person.role !== 'user') {
            const $stats = $('<div class="wf_scene_stats"></div>');
            const field = (key, labelText, placeholder) => {
                const $label = $('<label></label>').text(labelText);
                const $input = $('<input class="text_pole" type="text">')
                    .attr('placeholder', placeholder)
                    .val(person[key] || '')
                    .on('input', function () { person[key] = $(this).val(); saveSceneData(); });
                $stats.append($label, $input);
            };
            field('health', 'Health', 'e.g. healthy, wounded');
            field('condition', 'Injury / soreness', 'e.g. sprained ankle');
            field('lastLocation', 'Last known location', 'optional');
            $card.append($stats);
        }

        $list.append($card);
    });
}

// The NPC Roster reads the roleplay's active lorebooks (character book, chat
// book, global, persona) and presents their entries as a browsable directory of
// available NPCs — each can be dropped into the scene with one click.
const ALL_BOOKS = '__all__';
let rosterEntries = [];
let rosterLoaded = false;
let rosterLoading = false;

/** Title for a lorebook entry: its memo/comment, else its first keyword. */
function entryTitle(entry) {
    const comment = String(entry?.comment || '').trim();
    if (comment) return comment;
    const firstKey = Array.isArray(entry?.key) ? String(entry.key[0] || '').trim() : '';
    return firstKey || '(untitled entry)';
}

async function loadRoster() {
    if (rosterLoading) return;
    rosterLoading = true;
    try {
        const entries = await getSortedEntries();
        // Drop disabled entries; keep a stable, readable order by book then title.
        rosterEntries = (Array.isArray(entries) ? entries : [])
            .filter(e => e && !e.disable)
            .sort((a, b) => String(a.world).localeCompare(String(b.world)) || entryTitle(a).localeCompare(entryTitle(b)));
        rosterLoaded = true;
        populateRosterBooks();
        renderRoster();
    } catch (e) {
        warn('roster load failed', e);
        setSceneStatus('Could not read lorebooks for the roster.', true);
    } finally {
        rosterLoading = false;
    }
}

function populateRosterBooks() {
    const $select = $('#wf_scene_roster_book');
    if (!$select.length) return;
    const previous = $select.val() || ALL_BOOKS;
    const books = [...new Set(rosterEntries.map(e => String(e.world)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    $select.empty();
    $('<option></option>').val(ALL_BOOKS).text(`All active lorebooks (${rosterEntries.length})`).appendTo($select);
    for (const book of books) {
        const count = rosterEntries.filter(e => e.world === book).length;
        $('<option></option>').val(book).text(`${book} (${count})`).appendTo($select);
    }
    // Restore the previous selection if it still exists.
    $select.val(books.includes(previous) || previous === ALL_BOOKS ? previous : ALL_BOOKS);
}

function renderRoster() {
    const $list = $('#wf_scene_roster_list');
    const $count = $('#wf_scene_roster_count');
    if (!$list.length) return;
    $list.empty();

    if (!rosterLoaded) {
        $list.append('<div class="wf_scene_empty">Loading lorebooks…</div>');
        $count.text('');
        return;
    }

    const book = $('#wf_scene_roster_book').val() || ALL_BOOKS;
    const query = String($('#wf_scene_roster_search').val() || '').trim().toLowerCase();
    const present = new Set(getSceneData().present.map(p => String(p.name || '').toLowerCase()));

    let items = book === ALL_BOOKS ? rosterEntries : rosterEntries.filter(e => e.world === book);
    if (query) {
        items = items.filter(e =>
            entryTitle(e).toLowerCase().includes(query) ||
            String(e.content || '').toLowerCase().includes(query) ||
            (Array.isArray(e.key) && e.key.some(k => String(k).toLowerCase().includes(query))));
    }

    $count.text(`${items.length} entr${items.length === 1 ? 'y' : 'ies'}`);

    if (!items.length) {
        $list.append(`<div class="wf_scene_empty">${rosterEntries.length ? 'No entries match your filter.' : 'No active lorebooks found for this chat/character.'}</div>`);
        return;
    }

    for (const entry of items) {
        const title = entryTitle(entry);
        const inScene = present.has(title.toLowerCase());
        const $card = $('<div class="wf_scene_npc"></div>');
        const $head = $('<div class="wf_scene_npc_head"></div>');

        const $title = $('<div class="wf_scene_npc_title"></div>')
            .attr('title', 'Click to show entry content')
            .append($('<b></b>').text(title));
        if (book === ALL_BOOKS) $title.append($('<span class="wf_scene_npc_book"></span>').text(` · ${entry.world}`));

        const $content = $('<div class="wf_scene_npc_content" style="display:none;"></div>')
            .text(String(entry.content || '').trim() || '(no content)');
        $title.on('click', () => $content.toggle());

        const $add = $(`<div class="menu_button menu_button_icon ${inScene ? 'wf_scene_npc_in' : ''}" title="${inScene ? 'Already in scene' : 'Add to scene'}"><i class="fa-solid fa-user-plus"></i></div>`)
            .on('click', () => {
                const scn = getSceneData();
                if (scn.present.some(p => p.name.toLowerCase() === title.toLowerCase())) {
                    setSceneStatus(`"${title}" is already in the scene.`);
                    return;
                }
                scn.present.push({ name: title, role: 'npc' });
                saveSceneData();
                setSceneStatus(`Added "${title}" to the scene.`);
                renderRoster();
            });

        $head.append($title, $add);
        $card.append($head, $content);
        $list.append($card);
    }
}

function renderScene() {
    const scene = getSceneData();
    $('#wf_scene_location').val(scene.location);
    $('#wf_scene_inject').prop('checked', scene.inject);
    renderPresent();
    renderRoster();
}

function switchSceneTab(tab) {
    $('.wf_scene_tab').removeClass('wf_scene_tab_active');
    $(`.wf_scene_tab[data-tab="${tab}"]`).addClass('wf_scene_tab_active');
    $('.wf_scene_pane').removeClass('wf_scene_pane_active');
    $(`#wf_scene_pane_${tab}`).addClass('wf_scene_pane_active');
    // Lazily read the lorebooks the first time the roster tab is opened.
    if (tab === 'roster' && !rosterLoaded && !rosterLoading) loadRoster();
}

function openSceneWindow() {
    if (!$sceneWindow) return;
    $sceneWindow.removeClass('wf_scene_hidden');
    sceneOpen = true;
    setSceneStatus('');
    renderScene();
}

function closeSceneWindow() {
    if (!$sceneWindow) return;
    $sceneWindow.addClass('wf_scene_hidden');
    sceneOpen = false;
}

function toggleSceneWindow() {
    sceneOpen ? closeSceneWindow() : openSceneWindow();
}

async function onSceneRefresh() {
    setSceneStatus('Scanning recent messages…');
    $('#wf_scene_refresh').addClass('wf_scene_busy');
    try {
        const { present } = await refreshSceneFromChat();
        renderScene();
        setSceneStatus(`Updated from chat — ${present} in scene.`);
    } catch (error) {
        warn('scene refresh failed', error);
        setSceneStatus(error?.message || String(error), true);
    } finally {
        $('#wf_scene_refresh').removeClass('wf_scene_busy');
    }
}

function initSceneTrackerUI() {
    try {
        injectSceneStyles();
    } catch (e) {
        warn('scene style injection failed (non-fatal)', e);
    }

    try {
        $(document.body).append(SCENE_WINDOW_HTML);
        const $menu = $('#extensionsMenu');
        if ($menu.length) $menu.append(SCENE_BUTTON_HTML);
        else $(document.body).append(SCENE_BUTTON_HTML);

        $sceneWindow = $('#wf_scene_window');
        $sceneStatus = $('#wf_scene_status');
        if ($sceneWindow.length === 0) {
            warn('Scene Tracker window not found after append (sanitizer may have stripped it)');
            return;
        }

        $('#wf_scene_menu_button').on('click', toggleSceneWindow);
        $('#wf_scene_close').on('click', closeSceneWindow);
        $('#wf_scene_refresh').on('click', onSceneRefresh);
        $('.wf_scene_tab').on('click', function () { switchSceneTab($(this).data('tab')); });

        $('#wf_scene_location').on('input', function () {
            getSceneData().location = $(this).val();
            saveSceneData();
        });
        $('#wf_scene_inject').on('change', function () {
            getSceneData().inject = $(this).prop('checked');
            saveSceneData();
        });

        const addPresent = () => {
            const $input = $('#wf_scene_present_name');
            const name = String($input.val() || '').trim();
            if (!name) return;
            const scene = getSceneData();
            if (!scene.present.some(p => p.name.toLowerCase() === name.toLowerCase())) {
                scene.present.push({ name, role: 'npc' });
                saveSceneData();
                renderPresent();
            }
            $input.val('');
        };
        $('#wf_scene_present_add').on('click', addPresent);
        $('#wf_scene_present_name').on('keydown', (e) => { if (e.key === 'Enter') addPresent(); });

        $('#wf_scene_roster_reload').on('click', () => { rosterLoaded = false; loadRoster(); });
        $('#wf_scene_roster_book').on('change', renderRoster);
        $('#wf_scene_roster_search').on('input', renderRoster);

        // Re-render when the chat changes so the panel reflects the new chat's
        // record, and invalidate the roster so it re-reads the new lorebook set.
        eventSource.on(event_types.CHAT_CHANGED, () => {
            rosterLoaded = false;
            rosterEntries = [];
            if (sceneOpen) {
                renderScene();
                if ($('.wf_scene_tab[data-tab="roster"]').hasClass('wf_scene_tab_active')) loadRoster();
            }
        });

        const s = getSettings();
        $('#wf_scene_menu_button').toggle(!!s.sceneTrackerEnabled);
    } catch (e) {
        warn('Scene Tracker UI wiring failed', e);
        return;
    }

    try {
        const ctx = getContext();
        if (ctx?.SlashCommandParser && ctx?.SlashCommand) {
            const { SlashCommandParser, SlashCommand } = ctx;
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'scene',
                callback: () => { toggleSceneWindow(); return ''; },
                helpString: 'Toggles the World Forge Scene Tracker pane.',
            }));
        }
    } catch (e) {
        warn('scene slash command registration failed (non-fatal)', e);
    }
}

export function init() {
    getSettings();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    eventSource.on(event_types.CHAT_DELETED, onChatDeleted);
    eventSource.on(event_types.GROUP_CHAT_DELETED, onChatDeleted);
    eventSource.on(event_types.CHAT_CHANGED, migrateOwnedBookToConstant);
    // Defer DOM wiring until the document is ready so #extensionsMenu exists.
    const initUI = () => { initKeyMomentsUI(); initSceneTrackerUI(); };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI, { once: true });
    } else {
        initUI();
    }
    console.log('[world-forge] runtime extension loaded');
}
