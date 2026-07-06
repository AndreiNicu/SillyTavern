import { eventSource, event_types, this_chid, characters, substituteParams, chat, name1, getCurrentChatId, chat_metadata, saveMetadata, getRequestHeaders, animation_duration, extension_prompt_types, extension_prompt_roles } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { ConnectionManagerRequestService } from '../shared.js';
import { getBase64Async, saveBase64AsFile, getFileExtension } from '../../utils.js';
import { isDirectorCharacter } from '../../group-chats.js';
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
// Dedicated extension-prompt key for the Scene Tracker injection. Separate from
// the native Author's Note ('2_floating_prompt') so the two coexist.
const SCENE_PROMPT_KEY = 'world_forge_scene';

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
// When set, the scan is focused on a single message and its immediate
// neighbours (message N-1, N, N+1) instead of the trailing recent window.
// null means "scan the recent messages" (the default behaviour).
let kmFocusIndex = null;

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }
    const s = extension_settings[SETTINGS_KEY];
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (typeof s.debug !== 'boolean') s.debug = true;
    if (typeof s.keyMomentsEnabled !== 'boolean') s.keyMomentsEnabled = true;
    if (typeof s.sceneTrackerEnabled !== 'boolean') s.sceneTrackerEnabled = true;
    // Global map of NPC name (normalised) → uploaded picture path. NPCs live in a
    // shared lorebook reused across chats, so their portraits persist app-wide.
    if (!s.npcPictures || typeof s.npcPictures !== 'object') s.npcPictures = {};
    if (typeof s.contextMessages !== 'number' || !Number.isFinite(s.contextMessages)) s.contextMessages = 10;
    s.contextMessages = Math.max(1, Math.min(50, Math.round(s.contextMessages)));
    // Scene Tracker auto-scan cadence: re-scan presence every N AI messages.
    // 0 = off (manual Refresh only). Scans run on the WI LLM-filter profile, so
    // they no-op silently when that profile isn't configured.
    if (typeof s.autoScanInterval !== 'number' || !Number.isFinite(s.autoScanInterval)) s.autoScanInterval = 3;
    s.autoScanInterval = Math.max(0, Math.min(50, Math.round(s.autoScanInterval)));
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
 * Push the per-chat Scene Tracker state into the prompt using the same engine as
 * the native Author's Note — getContext().setExtensionPrompt — under our own key.
 * This gives Author's-Note-style placement (position / depth / role) and an
 * insertion interval, and works for both Chat and Text Completion. Called before
 * each generation (GENERATION_AFTER_COMMANDS) and when the chat/scene changes.
 */
function updateSceneExtensionPrompt() {
    const ctx = getContext();
    const clear = () => ctx.setExtensionPrompt(SCENE_PROMPT_KEY, '', extension_prompt_types.NONE, 0);

    if (!getCurrentChatId()) return clear();
    const scene = getSceneData();
    if (!scene.inject) return clear();

    const block = buildSceneBlock(scene);
    if (!block) return clear();

    // Insertion-interval gate, mirroring Author's Note: count user messages and
    // only inject on the cadence the user picked (1 = always).
    const interval = scene.injectInterval;
    let userMsgs = Array.isArray(chat) ? chat.filter(m => m && m.is_user).length : 0;
    if (interval === 1) userMsgs = 1;
    if (userMsgs <= 0 || interval <= 0) return clear();
    const messagesTillInsertion = userMsgs >= interval ? (userMsgs % interval) : (interval - userMsgs);
    if (messagesTillInsertion !== 0) return clear();

    ctx.setExtensionPrompt(
        SCENE_PROMPT_KEY,
        substituteParams(block),
        scene.injectPosition,
        scene.injectDepth,
        false,
        scene.injectRole,
    );
    if (getSettings().debug) console.log('[world-forge] → scene_state set as extension prompt', { position: scene.injectPosition, depth: scene.injectDepth, role: scene.injectRole });
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
 * Build a transcript focused on a single message and its immediate neighbours
 * (centerIndex - 1, centerIndex, centerIndex + 1), clamped to the chat bounds.
 * Used when the user asks to scan a specific message number, e.g. "/keymoment 43"
 * gathers key moments from messages 42, 43 and 44.
 * @param {number} centerIndex Zero-based chat index of the focused message.
 * @returns {string}
 */
function buildTranscriptAround(centerIndex) {
    if (!Array.isArray(chat) || chat.length === 0) return '';
    const start = Math.max(0, centerIndex - 1);
    const end = Math.min(chat.length - 1, centerIndex + 1);

    const lines = [];
    for (let i = start; i <= end; i++) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== 'string') continue;
        // Skip hidden/system filler but keep narrator content.
        if (msg.is_system && msg.extra?.type !== 'narrator') continue;
        const speaker = msg.is_user ? (msg.name || name1) : (msg.name || 'Character');
        const body = stripReasoning(msg.mes);
        if (!body) continue;
        lines.push(`${speaker}: ${body}`);
    }
    return lines.join('\n');
}

/**
 * Pick the transcript for the current scan: focused around a single message when
 * a message number was supplied, otherwise the trailing recent window.
 * @returns {string}
 */
function buildScanTranscript() {
    return kmFocusIndex === null ? buildRecentTranscript() : buildTranscriptAround(kmFocusIndex);
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
// Absence grace: how many consecutive auto/manual scans an NPC may go unmentioned
// (without an explicit departure) before being dropped from the scene. Guards
// against a quietly-present character flickering out just because the last N
// messages didn't happen to name them — which would make the injected block
// contradict itself turn to turn. Explicit departures bypass this entirely.
const SCENE_ABSENCE_GRACE = 3;

/** @typedef {{name: string, role: 'user'|'character'|'npc', health?: string, condition?: string, clothing?: string, mood?: string, lastLocation?: string, missesScans?: number}} ScenePerson */
/** @typedef {{location: string, time: string, day: number, dayLimit: number, openEnded: boolean, weekdayStart: number, month: string, startMonth: number, startYear: number, endMonth: number, endYear: number, present: ScenePerson[], director: string, inject: boolean, injectPosition: number, injectDepth: number, injectRole: number, injectInterval: number}} SceneData */

// Weekday names, indexed to match the day-of-week anchor (weekdayStart). The
// weekday shown for a given day is derived purely from the day counter and this
// anchor, so it stays consistent as the story spans days without the model
// having to track it.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Month names, indexed 0–11, for the anchored-calendar mode (startMonth/endMonth).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a given month, honouring Gregorian leap years for February. */
function daysInMonth(year, month) {
    if (month === 1) {
        const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return leap ? 29 : 28;
    }
    return MONTH_DAYS[((month % 12) + 12) % 12];
}

/** @returns {SceneData} */
function defaultSceneData() {
    return {
        location: '',
        // Free-form time of the current scene: either a clock time ("4PM") or a
        // time-of-day label ("morning", "evening", "night"). '' = unset.
        time: '',
        // Day counter for time-dependent worlds (a story spanning days 1, 2, 3…).
        // 0 = off (no day is tracked / injected).
        day: 0,
        // Day limit for the world — the day the roleplay is meant to conclude on
        // (e.g. "Day 1 of 30"). 0 = off (no limit / horizon shown). Used only when
        // the anchored calendar is off; with a calendar the horizon is the end
        // month/year below. Ignored entirely when openEnded is true.
        dayLimit: 0,
        // Open-ended story: days (and the calendar) keep counting, but no horizon
        // or "of N" / conclusion note is ever shown. For infinite roleplays.
        openEnded: false,
        // The weekday Day 1 falls on, as an index into WEEKDAYS. The weekday of
        // the current day is derived from this anchor + the day counter, so e.g.
        // weekdayStart = 2 (Tuesday) means Day 1 is Tuesday, Day 2 Wednesday, …
        // -1 = off (no weekday is derived / shown).
        weekdayStart: -1,
        // Free-form month of the current scene (e.g. "June", or a fantasy month
        // name). Settable and updated by scans like `time`. '' = unset. Used only
        // when the anchored calendar (startMonth) is off; otherwise the month is
        // derived from the day counter.
        month: '',
        // Anchored calendar: when startMonth is a real month (0–11), Day 1 is the
        // 1st of that month/year and the current month/year are DERIVED from the
        // day counter (months roll over by their real lengths). -1 = off (use the
        // free-form `month` label instead).
        startMonth: -1,
        startYear: 1,
        // Calendar horizon: the month/year the story is set to conclude in (the
        // last day of that month). -1 = off (no horizon from the calendar).
        endMonth: -1,
        endYear: 1,
        present: [],
        // Group chats only: name of the group member card that plays the NPCs
        // (e.g. an "NPC controller" card backed by a lorebook). '' = unset.
        director: '',
        // Author's-Note-style placement (injected under our own extension-prompt key).
        inject: true,
        injectPosition: extension_prompt_types.IN_CHAT, // 1 = in chat @ depth
        injectDepth: 4,
        injectRole: extension_prompt_roles.SYSTEM,       // 0 = system
        injectInterval: 1,                               // every N user messages (1 = always)
    };
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
    if (typeof s.time !== 'string') s.time = '';
    if (typeof s.day !== 'number' || !Number.isFinite(s.day)) s.day = 0;
    s.day = Math.max(0, Math.round(s.day));
    if (typeof s.dayLimit !== 'number' || !Number.isFinite(s.dayLimit)) s.dayLimit = 0;
    s.dayLimit = Math.max(0, Math.min(100000, Math.round(s.dayLimit)));
    if (typeof s.openEnded !== 'boolean') s.openEnded = false;
    if (typeof s.weekdayStart !== 'number' || !Number.isFinite(s.weekdayStart)) s.weekdayStart = -1;
    s.weekdayStart = Math.round(s.weekdayStart);
    if (s.weekdayStart < 0 || s.weekdayStart > 6) s.weekdayStart = -1;
    if (typeof s.month !== 'string') s.month = '';
    if (typeof s.startMonth !== 'number' || !Number.isFinite(s.startMonth)) s.startMonth = -1;
    s.startMonth = Math.round(s.startMonth);
    if (s.startMonth < 0 || s.startMonth > 11) s.startMonth = -1;
    if (typeof s.startYear !== 'number' || !Number.isFinite(s.startYear)) s.startYear = 1;
    s.startYear = Math.round(s.startYear);
    if (typeof s.endMonth !== 'number' || !Number.isFinite(s.endMonth)) s.endMonth = -1;
    s.endMonth = Math.round(s.endMonth);
    if (s.endMonth < 0 || s.endMonth > 11) s.endMonth = -1;
    if (typeof s.endYear !== 'number' || !Number.isFinite(s.endYear)) s.endYear = 1;
    s.endYear = Math.round(s.endYear);
    if (!Array.isArray(s.present)) s.present = [];
    if (typeof s.director !== 'string') s.director = '';
    if (typeof s.inject !== 'boolean') s.inject = true;
    if (![extension_prompt_types.IN_PROMPT, extension_prompt_types.IN_CHAT, extension_prompt_types.BEFORE_PROMPT].includes(s.injectPosition)) s.injectPosition = extension_prompt_types.IN_CHAT;
    if (typeof s.injectDepth !== 'number' || !Number.isFinite(s.injectDepth)) s.injectDepth = 4;
    s.injectDepth = Math.max(0, Math.min(100, Math.round(s.injectDepth)));
    if (![extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT].includes(s.injectRole)) s.injectRole = extension_prompt_roles.SYSTEM;
    if (typeof s.injectInterval !== 'number' || !Number.isFinite(s.injectInterval)) s.injectInterval = 1;
    s.injectInterval = Math.max(0, Math.min(50, Math.round(s.injectInterval)));
    for (const p of s.present) {
        if (p && p.role !== 'user' && p.role !== 'character' && p.role !== 'npc') p.role = 'npc';
        if (p && (typeof p.missesScans !== 'number' || !Number.isFinite(p.missesScans))) p.missesScans = 0;
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
 * The weekday name for the scene's current day, derived from the day counter and
 * the day-of-week anchor (weekdayStart = the weekday Day 1 falls on). Returns ''
 * when no day is tracked or no anchor is set.
 * @param {SceneData} scene
 * @returns {string}
 */
function weekdayForDay(scene) {
    const day = Number(scene.day) || 0;
    const start = Number(scene.weekdayStart);
    if (day < 1 || !Number.isFinite(start) || start < 0 || start > 6) return '';
    return WEEKDAYS[(((start + (day - 1)) % 7) + 7) % 7];
}

/** True when the anchored calendar is in use (a start month is set and a day is tracked). */
function calendarActive(scene) {
    return Number(scene.startMonth) >= 0 && Number(scene.startMonth) <= 11 && (Number(scene.day) || 0) >= 1;
}

/**
 * The derived calendar date for the scene's current day, anchoring Day 1 to the
 * 1st of the start month/year and walking forward (day − 1) days through real
 * month lengths. Returns {year, month, dom} (month 0–11), or null when the
 * calendar is off. Day-of-month is computed to roll months over correctly even
 * though the injected block only surfaces the month and year.
 * @param {SceneData} scene
 */
function calendarDateForDay(scene) {
    if (!calendarActive(scene)) return null;
    let year = Number(scene.startYear) || 0;
    let month = Number(scene.startMonth);
    let offset = (Number(scene.day) || 0) - 1; // days past the 1st
    // Bounded walk so a runaway day counter can never spin forever.
    for (let guard = 0; guard < 200000 && offset >= daysInMonth(year, month); guard++) {
        offset -= daysInMonth(year, month);
        month++;
        if (month > 11) { month = 0; year++; }
    }
    return { year, month, dom: offset + 1 };
}

/**
 * The day number on which an anchored-calendar story concludes — the last day of
 * the end month/year, counted from Day 1 = the 1st of the start month/year.
 * Returns 0 when there is no calendar horizon, or when the end precedes the start.
 * @param {SceneData} scene
 */
function calendarDayLimit(scene) {
    if (!calendarActive(scene)) return 0;
    if (Number(scene.endMonth) < 0 || Number(scene.endMonth) > 11) return 0;
    let year = Number(scene.startYear) || 0;
    let month = Number(scene.startMonth);
    const endYear = Number(scene.endYear) || 0;
    const endMonth = Number(scene.endMonth);
    if (endYear < year || (endYear === year && endMonth < month)) return 0; // end before start
    let count = 0;
    for (let guard = 0; guard < 200000 && !(year === endYear && month === endMonth); guard++) {
        count += daysInMonth(year, month);
        month++;
        if (month > 11) { month = 0; year++; }
    }
    return count + daysInMonth(endYear, endMonth); // include the full end month
}

/**
 * The horizon day count actually shown as "Day X of N", or 0 when there is none.
 * Open-ended stories have no horizon; otherwise the calendar's end date wins when
 * a calendar is active, falling back to the manual day limit.
 * @param {SceneData} scene
 */
function effectiveDayLimit(scene) {
    if (scene.openEnded) return 0;
    if (calendarActive(scene)) return calendarDayLimit(scene);
    return Number(scene.dayLimit) || 0;
}

/** "Anna", "Anna and Tom", "Anna, Mira and Tom". */
function listNames(people) {
    const names = people.map(p => p.name);
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Tolerant person-name comparison: exact (case-insensitive), or one name is the
 * first word of the other ("Anna" ↔ "Anna Johansson"). Mirrors the group LLM
 * router's first-token matching so the scene block never tells a card not to
 * speak for the very character it is playing under a shorter/longer name.
 */
function sameCharacter(a, b) {
    const x = String(a || '').trim().toLowerCase();
    const y = String(b || '').trim().toLowerCase();
    if (!x || !y) return false;
    if (x === y) return true;
    const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
    return longer.startsWith(`${shorter} `) || longer.startsWith(`${shorter}'`);
}

/** Group member characters of the currently selected group (solo chat = []). */
function getGroupMembers() {
    const ctx = getContext();
    const group = ctx.groupId ? (ctx.groups || []).find(g => g.id === ctx.groupId) : null;
    if (!group) return [];
    return (group.members || [])
        .map(avatar => characters.find(c => c.avatar === avatar))
        .filter(Boolean);
}

/**
 * The group member card that plays the NPCs: the explicit per-chat selection
 * when set, otherwise the single Director/NPC-tagged member (same tag
 * classification the group LLM router uses). Ambiguous (several tagged) or
 * none → ''.
 * @param {SceneData} scene
 * @returns {string}
 */
function resolveDirectorName(scene) {
    const explicit = String(scene.director || '').trim();
    if (explicit) return explicit;
    const tagged = getGroupMembers().filter(isDirectorCharacter);
    return tagged.length === 1 ? String(tagged[0].name || '').trim() : '';
}

/**
 * Render the scene record as a narrative, prompt-friendly block that states the
 * location and — crucially — WHO PLAYS WHOM, so the model never speaks for the
 * human player or for characters owned by other group members.
 *
 * In group chats the block is speaker-aware: generateGroupWrapper sets the
 * active character (this_chid) before Generate() fires GENERATION_AFTER_COMMANDS,
 * so by the time updateSceneExtensionPrompt rebuilds this block we know which
 * member is about to reply and can phrase the framing from their perspective
 * ("you are replying as Anna" / "the NPCs are played by you, the World Director").
 *
 * Lines with no data are omitted; returns '' when there's nothing to inject.
 * @param {SceneData} scene
 * @returns {string}
 */
function buildSceneBlock(scene) {
    const lines = [];
    const location = String(scene.location || '').trim();
    if (location) lines.push(`The current scene takes place at: ${location}`);
    const day = Number(scene.day) || 0;
    const cal = calendarDateForDay(scene);
    if (day >= 1) {
        const limit = effectiveDayLimit(scene);
        const weekday = weekdayForDay(scene);
        const dayPart = `Day ${day}${limit >= 1 ? ` of ${limit}` : ''}`;
        lines.push(`Current day: ${weekday ? `${weekday}, ${dayPart}` : dayPart}.`);

        if (cal) {
            lines.push(`Current month: ${MONTHS[cal.month]}, Year ${cal.year}.`);
        } else {
            const month = String(scene.month || '').trim();
            if (month) lines.push(`Current month: ${month}.`);
        }

        if (limit >= 1) {
            if (day >= limit) {
                lines.push('This is the final day — bring the story toward its conclusion.');
            } else if (cal && Number(scene.endMonth) >= 0) {
                lines.push(`The story is set to conclude at the end of ${MONTHS[scene.endMonth]}, Year ${scene.endYear} (Day ${limit}); pace events accordingly.`);
            } else {
                lines.push(`The story is set to conclude on Day ${limit}; pace events accordingly.`);
            }
        }
    } else {
        // No day counter yet: a free-form month label may still apply.
        const month = String(scene.month || '').trim();
        if (month) lines.push(`Current month: ${month}.`);
    }
    const time = String(scene.time || '').trim();
    if (time) lines.push(`Current time: ${time}`);

    const present = (scene.present || []).filter(p => p && String(p.name || '').trim());
    if (present.length) {
        const players = present.filter(p => p.role === 'user');
        const cast = present.filter(p => p.role === 'character');
        const npcs = present.filter(p => p.role === 'npc');

        const isGroup = !!getContext().groupId;
        const speaker = isGroup ? String(getActiveCharacter()?.name || '').trim() : '';
        const director = isGroup ? resolveDirectorName(scene) : '';
        const speakerIsDirector = !!(speaker && director && sameCharacter(director, speaker));

        lines.push(`Present in the scene: ${present.map(p => p.name).join(', ')}.`);

        if (players.length) {
            const them = players.length > 1 ? 'them' : players[0].name;
            lines.push(`${listNames(players)} ${players.length > 1 ? 'are' : 'is'} played by the human player. Never speak, act, or decide for ${them}.`);
        }

        if (isGroup) {
            if (speakerIsDirector) {
                lines.push(`You are ${speaker}, the World Director: you narrate the scene and voice the NPCs.`);
            } else if (speaker) {
                lines.push(`You are currently replying as ${speaker}.`);
            }
            // "Do not write dialogue/decisions" (not "do not mention"): an omniscient
            // Director card may still describe other cast members in its narration.
            for (const c of cast) {
                if (speaker && sameCharacter(c.name, speaker)) continue;
                lines.push(`${c.name} is played by their own character card. Do not write dialogue or make decisions for ${c.name}.`);
            }
            if (npcs.length) {
                const are = npcs.length > 1 ? 'are NPCs' : 'is an NPC';
                if (speakerIsDirector) {
                    if (npcs.length > 1) {
                        lines.push(`${listNames(npcs)} are NPCs for you to voice. All of them are present in the scene — give each of them their own voice and presence in your reply; don't focus on just one and let the others fade out.`);
                    } else {
                        lines.push(`${npcs[0].name} is an NPC for you to voice.`);
                    }
                } else if (director) {
                    lines.push(`${listNames(npcs)} ${are} played by ${director}, the World Director. Do not write dialogue or make decisions for ${npcs.length > 1 ? 'them' : npcs[0].name}.`);
                } else {
                    lines.push(`${listNames(npcs)} ${are} in the scene.`);
                }
            }
        } else {
            if (cast.length) lines.push(`You are playing ${listNames(cast)}.`);
            if (npcs.length) {
                const are = npcs.length > 1 ? 'are NPCs' : 'is an NPC';
                lines.push(`${listNames(npcs)} ${are} ${cast.length ? 'also ' : ''}played by you, acting as the World Director.`);
                if (npcs.length > 1) {
                    lines.push('All of them are present in the scene — give each of them their own voice and presence in your reply; don\'t focus on just one and let the others fade out.');
                }
            }
        }

        const status = [];
        for (const p of present) {
            if (p.role === 'user') continue;
            // Physical status stays on the character's headline; clothing and mood get
            // their own indented lines beneath it so they read as distinct facts.
            const bits = [];
            if (String(p.health || '').trim()) bits.push(`health: ${p.health.trim()}`);
            if (String(p.condition || '').trim()) bits.push(`condition: ${p.condition.trim()}`);
            if (String(p.lastLocation || '').trim()) bits.push(`last seen: ${p.lastLocation.trim()}`);
            const extra = [];
            if (String(p.clothing || '').trim()) extra.push(`  Wearing: ${p.clothing.trim()}`);
            if (String(p.mood || '').trim()) extra.push(`  Mood: ${p.mood.trim()}`);
            if (bits.length || extra.length) {
                status.push(`- ${p.name}${bits.length ? ` — ${bits.join('; ')}` : ''}`);
                status.push(...extra);
            }
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
    '- "time": the current time of the scene if it can be told from the text — either a clock time (e.g. "4PM")',
    '  or a time of day (e.g. "morning", "noon", "evening", "night"). Use "" if it is unknown.',
    '- "month": the current month if it can be told from the text (e.g. "June", or a fantasy month name). Use "" if it is unknown.',
    '- "dayAdvance": the number of WHOLE days that pass within these recent messages because of an explicit time',
    '  skip (sleeping through to the next morning, "three days later", etc.). Use 0 if the scene stays on the same day.',
    '- "present": the characters/NPCs (and the user, if they are in the scene) currently in it.',
    '  For each, give: "name"; "role" (one of "user", "character", or "npc" — "character" = a main AI character, "npc" = a minor/side character);',
    '  and for non-user entries the best current "health" (e.g. healthy, wounded, exhausted),',
    '  "condition" (any injury/soreness/status, or "" if none), "clothing" (what they are currently wearing, or "" if unknown),',
    '  "mood" (their current emotional state, e.g. calm, angry, flustered, aroused, or "" if unknown),',
    '  and "lastLocation" (where they were last seen, or "").',
    '- "left": the names of anyone who VISIBLY EXITED the scene in these recent messages — they walked out, fled,',
    '  were taken away, teleported, hung up, died, or otherwise clearly departed. List a name here ONLY when the text',
    '  shows an actual departure. Do NOT list someone merely because they stopped being mentioned — silence is not leaving.',
    'Base everything ONLY on the transcript. Use "" for anything unknown. Do not invent characters.',
    '',
    'Reply with ONLY a JSON object of this exact shape:',
    '{"location": "...", "time": "...", "month": "...", "dayAdvance": 0, "present": [{"name": "...", "role": "npc", "health": "...", "condition": "...", "clothing": "...", "mood": "...", "lastLocation": "..."}], "left": ["..."]}',
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

// ------------------------- world calendar seed ----------------------------
// Optional producer hand-off: a World-Forge export may carry a world-level
// [[WORLD_CALENDAR]] lorebook entry whose JSON payload declares the world's
// starting date, ending date (or that it is open-ended), and the weekday Day 1
// falls on. When present, a brand-new chat's Scene Tracker seeds its date fields
// from it. This is a graceful enhancement — worlds without the block (and older
// exports) simply keep the manual, per-chat behavior. See the calendar block in
// the World-Forge ⇄ Extension sync contract (contracts/WORLD_FORGE_SYNC.md).
const WORLD_CALENDAR_MARKER = '[[WORLD_CALENDAR]]';

/** Coerce arbitrary input to a 0–11 month index, or -1 when unusable. */
function coerceMonthIndex(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 11 ? n : -1;
}

/**
 * Read the world's [[WORLD_CALENDAR]] block, if any. Tolerant of absence and
 * malformed payloads: returns the parsed object or null, never throws. Expected
 * shape (all optional, month is 0–11):
 *   {"schema":1,"weekdayOfDay1":2,"start":{"month":5,"year":1},"end":{"month":11,"year":1}}
 * `end` null/absent/"infinite" ⇒ the story is open-ended.
 * @returns {Promise<Record<string, any>|null>}
 */
async function readWorldCalendar() {
    let entries;
    try {
        entries = await getSortedEntries();
    } catch (e) {
        warn('world calendar: could not read world info', e);
        return null;
    }
    const entry = (Array.isArray(entries) ? entries : [])
        .find(e => e && !e.disable && String(e.comment || '').includes(WORLD_CALENDAR_MARKER));
    if (!entry) return null;
    const payload = extractJsonObject(String(entry.content || ''));
    if (!payload) {
        log('world calendar: entry found but payload was unparseable');
        return null;
    }
    return payload;
}

/**
 * Seed a brand-new chat's Scene Tracker date fields from the world's
 * [[WORLD_CALENDAR]] block. Fires only when the user has not set up ANY date
 * tracking yet (a pristine record), so it never clobbers hand-set values; absent
 * or older worlds leave the manual behavior untouched.
 */
async function maybeSeedCalendarFromWorld() {
    if (!getCurrentChatId()) return;
    const scene = getSceneData();
    const pristine = (Number(scene.day) || 0) === 0 && scene.weekdayStart === -1
        && scene.startMonth === -1 && scene.endMonth === -1 && (Number(scene.dayLimit) || 0) === 0
        && !scene.openEnded && !String(scene.month || '').trim();
    if (!pristine) return;

    const cal = await readWorldCalendar();
    if (!cal) return;
    // The chat may have changed (or the user may have started editing) while the
    // world info was loading; only seed if it is still pristine.
    if ((Number(scene.day) || 0) !== 0 || scene.startMonth !== -1 || scene.weekdayStart !== -1) return;

    let touched = false;
    const wd = Math.round(Number(cal.weekdayOfDay1));
    if (Number.isFinite(wd) && wd >= 0 && wd <= 6) { scene.weekdayStart = wd; touched = true; }

    const startMonth = cal.start ? coerceMonthIndex(cal.start.month) : -1;
    if (startMonth >= 0) {
        scene.startMonth = startMonth;
        scene.startYear = Math.round(Number(cal.start.year)) || 1;
        // A world that defines a calendar implies the story opens on its Day 1.
        scene.day = 1;
        touched = true;

        const open = cal.end == null || cal.end === 'infinite';
        if (open) {
            scene.openEnded = true;
        } else {
            const endMonth = coerceMonthIndex(cal.end.month);
            if (endMonth >= 0) {
                scene.endMonth = endMonth;
                scene.endYear = Math.round(Number(cal.end.year)) || scene.startYear;
            }
        }
    }

    if (touched) {
        log('seeded scene calendar from world [[WORLD_CALENDAR]] block');
        saveSceneData();
        if (sceneOpen) renderScene();
        updateSceneExtensionPrompt();
    }
}

// ------------------------------- dice oracle --------------------------------
// Manual pre-narration randomizer (Scene Tracker "Dice" tab). The user rolls
// against world-authored tables BEFORE the model writes a recounted story or a
// temporary character, and the resolved facts are injected as authoritative
// context — the dice fix WHAT happened so the model doesn't have to invent it.
// Tables come from a world-level [[DICE_TABLES]] lorebook entry (same
// enabled-but-inert carrier convention as [[WORLD_CALENDAR]]); without one the
// built-in demo tables below are offered. Payload schema, step grammar, and
// the one-exchange lifecycle are specified in contracts/DICE_ORACLE.md.
const DICE_TABLES_MARKER = '[[DICE_TABLES]]';
const DICE_PROMPT_KEY = 'world_forge_dice';
const DICE_META_KEY = 'world_forge_dice';

// Demo fallback so the feature is testable in any world. A world
// [[DICE_TABLES]] entry with at least one valid procedure fully replaces this.
const BUILTIN_DICE_TABLES = {
    schema: 1,
    pools: {
        personality: ['reckless', 'shy and easily flustered', 'boastful', 'gentle', 'hot-tempered', 'deadpan', 'clumsy', 'overconfident'],
        body_type: ['short and wiry', 'tall and lanky', 'broad and heavy-set', 'soft and round', 'compact and athletic', 'gangly, all elbows'],
    },
    procedures: [
        {
            id: 'recall_story',
            label: 'Past story (recall)',
            steps: [
                {
                    id: 'valence', label: 'How it turned out', roll: '1d20',
                    outcomes: { '1-7': 'bad', '8-14': 'mixed', '15-20': 'great' },
                    text: { bad: 'it went wrong / ended in embarrassment', mixed: 'a ridiculous mess, but a fond one', great: 'it turned out genuinely great' },
                },
                {
                    id: 'injured', label: 'Anyone hurt', roll: '1d6',
                    outcomes: { '1-2': 'yes', '3-6': 'no' },
                    when: { valence: ['bad', 'mixed'] },
                },
                {
                    id: 'severity', label: 'How bad', roll: '1d10',
                    outcomes: { '1-5': 'minor', '6-8': 'moderate', '9-10': 'serious' },
                    text: { minor: 'minor — walked it off', moderate: 'moderate — needed patching up', serious: 'serious — left a lasting mark' },
                    when: { injured: 'yes' },
                },
                {
                    id: 'goal', label: 'Did they pull it off', roll: '1d20',
                    outcomes: { '1-10': 'no', '11-20': 'yes' },
                },
            ],
        },
        {
            id: 'temp_npc',
            label: 'Temporary NPC',
            steps: [
                { id: 'personality', label: 'Personality', pick: 'personality' },
                { id: 'body', label: 'Build', pick: 'body_type' },
            ],
        },
    ],
};

/** Roll an NdM(+/-K) formula (or bare number). Returns null when unparseable. */
function rollDiceFormula(formula) {
    const text = String(formula ?? '').trim();
    const m = /^(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?$/i.exec(text);
    if (!m) {
        const n = Number(text);
        return Number.isFinite(n) ? Math.round(n) : null;
    }
    const count = Number(m[1]);
    const sides = Number(m[2]);
    if (count < 1 || count > 100 || sides < 1) return null;
    let total = m[3] ? Number(m[3].replace(/\s+/g, '')) : 0;
    for (let i = 0; i < count; i++) {
        total += 1 + Math.floor(Math.random() * sides);
    }
    return total;
}

/** Map a roll total to its outcome key via "a-b" / "n" range keys, or null. */
function matchDiceOutcome(outcomes, total) {
    for (const [range, key] of Object.entries(outcomes || {})) {
        const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(range).trim());
        if (m) {
            if (total >= Number(m[1]) && total <= Number(m[2])) return String(key);
        } else if (Number(String(range).trim()) === total) {
            return String(key);
        }
    }
    return null;
}

/** Is one step's `when` gate satisfied by the outcome keys resolved so far? */
function diceWhenSatisfied(when, resolvedKeys) {
    for (const [stepId, accepted] of Object.entries(when || {})) {
        const got = resolvedKeys[stepId];
        const list = Array.isArray(accepted) ? accepted : [accepted];
        if (got === undefined || !list.map(String).includes(got)) return false;
    }
    return true;
}

/** A step is a pick (pool name or inline array) XOR a roll with outcomes. */
function isValidDiceStep(step) {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !step.id) return false;
    const isPick = typeof step.pick === 'string' || Array.isArray(step.pick);
    const isRoll = step.roll !== undefined && step.outcomes && typeof step.outcomes === 'object';
    return isPick !== isRoll ? (isPick || isRoll) : false;
}

/**
 * Validate/normalise a [[DICE_TABLES]] payload (contracts/DICE_ORACLE.md §3).
 * Tolerant per the contract: bad pools/steps/procedures are dropped one by one;
 * returns null only when nothing usable remains (⇒ caller falls back).
 * @param {Record<string, any>} payload
 * @returns {{pools: Record<string, string[]>, procedures: any[]}|null}
 */
function normalizeDiceTables(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const pools = {};
    if (payload.pools && typeof payload.pools === 'object') {
        for (const [name, arr] of Object.entries(payload.pools)) {
            if (!Array.isArray(arr)) continue;
            const values = arr.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
            if (values.length) pools[name] = values;
        }
    }
    const procedures = [];
    for (const proc of Array.isArray(payload.procedures) ? payload.procedures : []) {
        if (!proc || typeof proc !== 'object' || typeof proc.id !== 'string' || !proc.id) continue;
        const steps = (Array.isArray(proc.steps) ? proc.steps : []).filter(isValidDiceStep);
        if (!steps.length) {
            warn(`dice: procedure '${proc.id}' has no valid steps, dropped`);
            continue;
        }
        procedures.push({
            id: proc.id,
            label: typeof proc.label === 'string' && proc.label.trim() ? proc.label.trim() : proc.id,
            // Optional per-procedure lead-in for the injected block; falls back
            // to the payload-level `framing`, then the built-in default.
            framing: typeof proc.framing === 'string' ? proc.framing.trim() : '',
            steps,
        });
    }
    if (!procedures.length) return null;
    const framing = typeof payload.framing === 'string' ? payload.framing.trim() : '';
    return { pools, procedures, framing };
}

/** Read the world's [[DICE_TABLES]] entry; null when absent/unusable. */
async function readWorldDiceTables() {
    let entries;
    try {
        entries = await getSortedEntries();
    } catch (e) {
        warn('dice: could not read world info', e);
        return null;
    }
    const entry = (Array.isArray(entries) ? entries : [])
        .find(e => e && !e.disable && String(e.comment || '').includes(DICE_TABLES_MARKER));
    if (!entry) return null;
    const payload = extractJsonObject(String(entry.content || ''));
    if (!payload) {
        log('dice: [[DICE_TABLES]] entry found but payload was unparseable');
        return null;
    }
    return normalizeDiceTables(payload);
}

/**
 * Walk one procedure's steps in order, rolling/picking each one. Steps whose
 * `when` gate is unmet (or whose pool/range is broken) resolve nothing.
 * @returns {{id: string, label: string, value: string, detail: string}[]}
 */
function resolveDiceProcedure(tables, proc) {
    const facts = [];
    const resolvedKeys = {};
    for (const step of proc.steps) {
        if (step.when && !diceWhenSatisfied(step.when, resolvedKeys)) continue;
        const label = typeof step.label === 'string' && step.label.trim() ? step.label.trim() : step.id;
        if (step.pick !== undefined) {
            const pool = Array.isArray(step.pick) ? step.pick.filter(v => typeof v === 'string' && v.trim()) : tables.pools[step.pick];
            if (!Array.isArray(pool) || !pool.length) {
                warn(`dice: step '${step.id}' references empty/unknown pool, skipped`);
                continue;
            }
            const value = String(pool[Math.floor(Math.random() * pool.length)]).trim();
            resolvedKeys[step.id] = value; // `when` matches the picked string itself
            facts.push({ id: step.id, label, value, detail: `1 of ${pool.length}` });
        } else {
            const total = rollDiceFormula(step.roll);
            if (total === null) {
                warn(`dice: step '${step.id}' has an unparseable roll '${step.roll}', skipped`);
                continue;
            }
            const key = matchDiceOutcome(step.outcomes, total);
            if (key === null) {
                warn(`dice: step '${step.id}' rolled ${total}, matched no outcome range, skipped`);
                continue;
            }
            resolvedKeys[step.id] = key;
            const value = (step.text && typeof step.text[key] === 'string' && step.text[key].trim()) ? step.text[key].trim() : key;
            facts.push({ id: step.id, label, value, detail: `${String(step.roll).trim()} → ${total}` });
        }
    }
    return facts;
}

/**
 * Per-chat oracle state, in chat_metadata (like the scene record). Lifecycle:
 * Roll arms it → the next generation consumes it (swipes of that reply still
 * see the same facts — a swipe retells, it doesn't re-roll history) → the
 * user's NEXT message clears it. Facts are ephemeral by design in v1: never
 * canon, never written to memory (contracts/DICE_ORACLE.md §1).
 */
function getDiceData() {
    let d = chat_metadata[DICE_META_KEY];
    if (!d || typeof d !== 'object') {
        d = {};
        chat_metadata[DICE_META_KEY] = d;
    }
    if (typeof d.armed !== 'boolean') d.armed = false;
    if (typeof d.consumed !== 'boolean') d.consumed = false;
    if (typeof d.procedureLabel !== 'string') d.procedureLabel = '';
    if (typeof d.framing !== 'string') d.framing = '';
    if (!Array.isArray(d.facts)) d.facts = [];
    d.facts = d.facts.filter(f => f && typeof f === 'object' && typeof f.value === 'string');
    return d;
}

// Default lead-in when neither the procedure nor the payload supplies a
// `framing`. Deliberately light: it establishes the facts as true and hands
// interpretation to the world's own instructions, rather than dictating tone.
const DEFAULT_DICE_FRAMING = 'Here are the established facts for the memory, encounter, or character being recounted. Treat them as true, and follow this world\'s guidance on how to interpret and narrate them:';

function buildDiceBlock(dice) {
    if (!dice.armed || !dice.facts.length) return '';
    // Model-facing facts only — no dice math (that stays in the UI panel).
    const lines = dice.facts.map(f => `- ${f.label || f.id}: ${f.value}`);
    const framing = dice.framing && dice.framing.trim() ? dice.framing.trim() : DEFAULT_DICE_FRAMING;
    return [
        '<dice_oracle>',
        framing,
        ...lines,
        '</dice_oracle>',
    ].join('\n');
}

/** Set/clear the one-shot oracle injection (same engine as the scene block). */
function updateDiceExtensionPrompt() {
    const ctx = getContext();
    const clear = () => ctx.setExtensionPrompt(DICE_PROMPT_KEY, '', extension_prompt_types.NONE, 0);
    if (!getCurrentChatId()) return clear();
    const block = buildDiceBlock(getDiceData());
    if (!block) return clear();
    // Fixed placement in v1: system role, in-chat at depth 1 — right above the
    // user's latest message, where a one-shot directive binds strongest.
    ctx.setExtensionPrompt(DICE_PROMPT_KEY, substituteParams(block), extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    log('→ dice_oracle set as extension prompt', { facts: getDiceData().facts.length });
}

function disarmDice(clearFacts = false) {
    const dice = getDiceData();
    dice.armed = false;
    dice.consumed = false;
    if (clearFacts) {
        dice.facts = [];
        dice.procedureLabel = '';
    }
    saveSceneData(); // debounced chat_metadata save (shared with the scene record)
    updateDiceExtensionPrompt();
    if (sceneOpen) renderDicePane();
}

/** GENERATION_ENDED: the armed facts have shaped a reply — mark them spent. */
function onDiceGenerationEnded() {
    if (!getCurrentChatId()) return;
    const dice = getDiceData();
    if (dice.armed && !dice.consumed) {
        dice.consumed = true;
        saveSceneData();
        if (sceneOpen) renderDicePane();
    }
}

/** MESSAGE_SENT: the exchange the roll was for is over — let go of the facts. */
function onDiceMessageSent() {
    if (!getCurrentChatId()) return;
    const dice = getDiceData();
    if (dice.armed && dice.consumed) {
        log('dice: exchange over, disarming oracle');
        disarmDice();
    }
}

// ------------------------- dice oracle: UI ---------------------------------
// Lazily-loaded tables for the Dice tab: the world's [[DICE_TABLES]] payload
// when present, otherwise the built-in demo set. Reset on chat change.
let diceTables = null;
let diceUsingBuiltin = false;
let diceLoaded = false;
let diceLoading = false;
let diceSelectedProcedureId = '';

async function loadDiceTables() {
    if (diceLoading) return;
    diceLoading = true;
    try {
        const world = await readWorldDiceTables();
        if (world) {
            diceTables = world;
            diceUsingBuiltin = false;
        } else {
            diceTables = normalizeDiceTables(BUILTIN_DICE_TABLES);
            diceUsingBuiltin = true;
        }
        diceLoaded = true;
        // Keep the current selection if it still exists, else default to first.
        const ids = diceTables.procedures.map(p => p.id);
        if (!ids.includes(diceSelectedProcedureId)) diceSelectedProcedureId = ids[0] || '';
    } catch (e) {
        warn('dice: table load failed', e);
        diceTables = normalizeDiceTables(BUILTIN_DICE_TABLES);
        diceUsingBuiltin = true;
        diceLoaded = true;
    } finally {
        diceLoading = false;
        if (sceneOpen) renderDicePane();
    }
}

function renderDicePane() {
    const $source = $('#wf_dice_source');
    const $select = $('#wf_dice_procedure');
    const $result = $('#wf_dice_result');
    if (!$select.length) return;

    if (!diceLoaded) {
        $source.text('Loading tables…').removeClass('wf_dice_builtin');
        $select.empty();
        $result.empty();
        if (!diceLoading) void loadDiceTables();
        return;
    }

    const procedures = (diceTables && diceTables.procedures) || [];
    $source
        .text(diceUsingBuiltin
            ? 'Using built-in demo tables (no [[DICE_TABLES]] in this world).'
            : `Using this world's [[DICE_TABLES]] — ${procedures.length} procedure${procedures.length === 1 ? '' : 's'}.`)
        .toggleClass('wf_dice_builtin', diceUsingBuiltin);

    $select.empty();
    for (const proc of procedures) {
        $('<option></option>').val(proc.id).text(proc.label).appendTo($select);
    }
    if (!procedures.some(p => p.id === diceSelectedProcedureId)) diceSelectedProcedureId = procedures[0]?.id || '';
    $select.val(diceSelectedProcedureId);
    $('#wf_dice_roll').toggleClass('wf_dice_disabled', procedures.length === 0);

    // Render the currently-armed facts (survives tab/chat re-open until cleared).
    const dice = getDiceData();
    $result.empty();
    if (dice.armed && dice.facts.length) {
        const note = dice.consumed
            ? 'Rolled facts shaped the last reply — swipes reuse them; your next message clears them.'
            : 'Armed for the next reply. Roll again to replace, or Clear to discard.';
        $('<div></div>').addClass('wf_dice_armed_note').toggleClass('wf_dice_spent', dice.consumed).text(note).appendTo($result);
        for (const f of dice.facts) {
            const $card = $('<div></div>').addClass('wf_dice_fact');
            $('<div></div>').addClass('wf_dice_fact_label').text(f.label || f.id).appendTo($card);
            $('<div></div>').addClass('wf_dice_fact_value').text(f.value).appendTo($card);
            if (f.detail) $('<div></div>').addClass('wf_dice_fact_detail').text(f.detail).appendTo($card);
            $card.appendTo($result);
        }
    }
}

function onDiceRoll() {
    if (!getCurrentChatId()) { setSceneStatus('Open a chat before rolling.', true); return; }
    if (!diceLoaded || !diceTables) { void loadDiceTables(); return; }
    const proc = diceTables.procedures.find(p => p.id === diceSelectedProcedureId);
    if (!proc) { setSceneStatus('No procedure selected.', true); return; }

    const facts = resolveDiceProcedure(diceTables, proc);
    if (!facts.length) { setSceneStatus('That procedure produced no facts (check its tables).', true); return; }

    const dice = getDiceData();
    dice.facts = facts;
    dice.procedureLabel = proc.label;
    // Snapshot the lead-in now (per-procedure overrides payload-level), so an
    // armed roll keeps its framing even if the tables are edited afterward.
    dice.framing = proc.framing || diceTables.framing || '';
    dice.armed = true;
    dice.consumed = false;
    saveSceneData();
    updateDiceExtensionPrompt();
    renderDicePane();
    setSceneStatus(`Rolled "${proc.label}" — armed for the next reply.`);
}

/**
 * Run the secondary LLM over recent messages and merge the result into the
 * current scene record. Location is replaced; present cast is merged by name so
 * hand-edited stats survive unless the model has fresher detail.
 *
 * Removal is deliberate, never inferred from silence: anyone the model reports
 * in "left" is dropped immediately (except the human player), and an NPC who
 * simply goes unmentioned is only dropped after SCENE_ABSENCE_GRACE consecutive
 * scans without a mention — so a quietly-present character doesn't flicker out
 * of the injected block and contradict the prior turn. The roster is untouched.
 * @returns {Promise<{location: string, present: number, removed: number}>}
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
    if (typeof parsed.time === 'string' && parsed.time.trim()) {
        scene.time = parsed.time.trim();
    }
    // The anchored calendar derives the month from the day counter, so a scanned
    // month label only applies in free-form (no-calendar) mode.
    if (!calendarActive(scene) && typeof parsed.month === 'string' && parsed.month.trim()) {
        scene.month = parsed.month.trim();
    }
    // Day only auto-advances once the user has opted in by setting a day (>= 1),
    // and only on explicit in-text time skips — never reset or started from a scan.
    const dayAdvance = Number(parsed.dayAdvance);
    if (scene.day >= 1 && Number.isFinite(dayAdvance) && dayAdvance > 0) {
        scene.day += Math.round(dayAdvance);
    }

    const incoming = Array.isArray(parsed.present) ? parsed.present : [];
    const leftNames = (Array.isArray(parsed.left) ? parsed.left : [])
        .map(n => String(n || '').trim())
        .filter(Boolean);
    const incomingNames = incoming
        .map(r => String(r?.name || '').trim())
        .filter(Boolean);

    // Merge present cast. Match existing people tolerantly (sameCharacter) so a
    // shorter/longer rendering of a name updates the same record instead of
    // spawning a duplicate, and stamp missesScans = 0 to mark them seen now.
    for (const raw of incoming) {
        const name = String(raw?.name || '').trim();
        if (!name) continue;
        const role = (raw.role === 'user' || raw.role === 'character' || raw.role === 'npc') ? raw.role : 'npc';
        const existing = scene.present.find(p => sameCharacter(p.name, name));
        const next = existing || { name, role };
        next.role = role;
        next.missesScans = 0;
        if (role !== 'user') {
            if (String(raw.health || '').trim()) next.health = String(raw.health).trim();
            if (String(raw.condition || '').trim()) next.condition = String(raw.condition).trim();
            if (String(raw.clothing || '').trim()) next.clothing = String(raw.clothing).trim();
            if (String(raw.mood || '').trim()) next.mood = String(raw.mood).trim();
            if (String(raw.lastLocation || '').trim()) next.lastLocation = String(raw.lastLocation).trim();
        }
        if (!existing) scene.present.push(next);
    }

    // Reconcile departures. The human player is never auto-removed. An explicit
    // departure drops the person at once; otherwise an unmentioned NPC counts
    // down its grace before being dropped, and main characters are left in place
    // (their absence from a short window is far more likely to be a lull).
    const isPresentNow = p => incomingNames.some(n => sameCharacter(n, p.name));
    const hasLeft = p => leftNames.some(n => sameCharacter(n, p.name));
    const before = scene.present.length;
    scene.present = scene.present.filter(p => {
        if (p.role === 'user') return true;
        if (hasLeft(p)) return false;
        if (isPresentNow(p)) { p.missesScans = 0; return true; }
        if (p.role === 'npc') {
            p.missesScans = (p.missesScans || 0) + 1;
            if (p.missesScans >= SCENE_ABSENCE_GRACE) return false;
        }
        return true;
    });
    const removed = before - scene.present.length;

    saveSceneData();
    return { location: scene.location, present: scene.present.length, removed };
}

// --------------------------- auto-scan (presence) --------------------------
// Event-driven, not a wall-clock timer: a re-scan is considered after each AI
// reply and only fires once the configured number of AI messages have arrived
// since the last scan. This never burns secondary-LLM calls while the chat is
// idle, and the scan runs on the separate WI-filter connection so it doesn't
// touch the main chat context — only its resulting <scene_state> block does.

let autoScanInFlight = false;
let lastAutoScanMsgCount = 0;

/** Count of AI (non-user, non-system) messages currently in the chat. */
function aiMessageCount() {
    return Array.isArray(chat) ? chat.filter(m => m && !m.is_user && !m.is_system).length : 0;
}

/**
 * Consider an automatic presence re-scan. No-ops unless auto-scan is enabled,
 * a connection profile is configured, the scene state is actually being used
 * (injected or the panel is open), and enough new AI messages have arrived.
 */
async function maybeAutoScan() {
    const interval = getSettings().autoScanInterval;
    if (!interval || interval <= 0) return;
    if (autoScanInFlight) return;
    if (!getCurrentChatId()) return;
    // No profile → manual Refresh would also fail; stay silent rather than spam.
    if (!String(world_info_llm_filter_profile || '')) return;
    // Scanning is only worth its cost when the result will be seen or injected.
    const scene = getSceneData();
    if (!scene.inject && !sceneOpen) return;

    const aiCount = aiMessageCount();
    if (aiCount - lastAutoScanMsgCount < interval) return;

    autoScanInFlight = true;
    try {
        const { removed } = await refreshSceneFromChat();
        lastAutoScanMsgCount = aiMessageCount();
        updateSceneExtensionPrompt();
        if (sceneOpen) renderScene();
        if (removed) log(`auto-scan dropped ${removed} from the scene`);
    } catch (e) {
        // Non-fatal: a flaky scan must never interrupt the chat.
        warn('auto-scan failed (non-fatal)', e);
    } finally {
        autoScanInFlight = false;
    }
}

// --------------------------------- UI --------------------------------------

const WINDOW_HTML = `
<div id="wf_km_overlay" class="wf_km_overlay wf_km_hidden">
    <div class="wf_km_modal">
        <div class="wf_km_header">
            <h3 class="margin0">
                <i class="fa-solid fa-star"></i>
                <span id="wf_km_title" data-i18n="Add Key Moment">Add Key Moment</span>
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
            <label for="wf_scene_autoscan" data-i18n="Auto-scan scene presence every N AI messages (0 = off)">Auto-scan scene presence every N AI messages (0 = off)</label>
            <div class="flex-container alignItemsCenter flexGap10">
                <input id="wf_scene_autoscan" class="neo-range-slider" type="range" min="0" max="50" step="1" />
                <input id="wf_scene_autoscan_counter" class="neo-range-input" type="number" min="0" max="50" step="1" />
            </div>
            <small class="notes">
                Uses the same Connection Profile as World Info → LLM Filter. Recorded moments are saved as always-on (Constant) entries in the chat-bound lorebook, so they're injected directly and are not picked over by the LLM filter. Auto-scan re-reads recent messages to keep the Scene Tracker's "who's present" list current, dropping characters who visibly left; it only runs while the scene is being injected or its panel is open, and stays off if no Connection Profile is set.
            </small>
        </div>
    </div>
</div>`;

const STYLE_CSS = `
.wf_km_overlay {
    position: fixed; inset: 0; z-index: 10010;
    /* Explicit size: inset-0 stretching collapses to 0 height on mobile, where
       ST's transformed <html> (the fixed-position containing block) has 0 height. */
    width: 100vw; height: 100vh; height: 100dvh;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);
}
.wf_km_overlay.wf_km_hidden { display: none !important; }
.wf_km_modal {
    width: 560px; max-width: 92vw; max-height: 85vh; max-height: 85dvh;
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
    const transcript = buildScanTranscript();
    if (!transcript) {
        setStatus(kmFocusIndex === null ? 'No messages to scan in this chat.' : `No messages to scan around #${kmFocusIndex}.`, true);
        renderCandidates([]);
        return;
    }

    setBusy(true);
    setStatus(kmFocusIndex === null ? 'Scanning recent messages…' : `Scanning messages around #${kmFocusIndex}…`);
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
        const transcript = buildScanTranscript();
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

/**
 * Open the Key Moments recorder.
 * @param {number|null} focusIndex When a number, scan that message and its
 *   immediate neighbours (N-1, N, N+1); when null, scan the recent window.
 */
function openWindow(focusIndex = null) {
    if (!$kmOverlay) return;
    kmFocusIndex = (typeof focusIndex === 'number' && Number.isFinite(focusIndex)) ? focusIndex : null;
    $kmOverlay.removeClass('wf_km_hidden');
    $kmOverlay.find('#wf_km_title').text(kmFocusIndex === null ? 'Add Key Moment' : `Add Key Moment — around #${kmFocusIndex}`);
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
    $('#wf_scene_autoscan').val(s.autoScanInterval);
    $('#wf_scene_autoscan_counter').val(s.autoScanInterval);
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

    const onAutoScan = function () {
        const value = Math.max(0, Math.min(50, Number($(this).val()) || 0));
        getSettings().autoScanInterval = value;
        $('#wf_scene_autoscan').val(value);
        $('#wf_scene_autoscan_counter').val(value);
        save();
    };
    $('#wf_scene_autoscan').on('input', onAutoScan);
    $('#wf_scene_autoscan_counter').on('input', onAutoScan);
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

        $('#wf_km_menu_button').on('click', () => openWindow());
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
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;

    // Resolve a message-number argument (e.g. "43") to a chat index, accepting an
    // optional leading "#". Returns null when nothing usable was supplied.
    const resolveFocusIndex = (raw) => {
        const value = String(raw ?? '').trim().replace(/^#/, '');
        if (value === '') return null;
        const n = Number(value);
        if (!Number.isInteger(n)) return null;
        if (!Array.isArray(chat) || n < 0 || n >= chat.length) {
            toastr?.warning(`Message #${value} is out of range for this chat.`, 'World Forge');
            return null;
        }
        return n;
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'keymoment',
        callback: (_args, value) => { openWindow(resolveFocusIndex(value)); return ''; },
        unnamedArgumentList: SlashCommandArgument ? [
            SlashCommandArgument.fromProps({
                description: 'message number to focus the scan on (scans that message and its neighbours, e.g. "43" → 42, 43, 44)',
                typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.NUMBER] : undefined,
                isRequired: false,
            }),
        ] : undefined,
        helpString: 'Opens the World Forge "Add Key Moment" recorder. Pass a message number (e.g. <code>/keymoment 43</code>) to scan that message and its neighbours; with no argument it scans the recent messages.',
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
        <div class="wf_scene_tab" data-tab="dice" data-i18n="Dice">Dice</div>
    </div>
    <div id="wf_scene_status" class="wf_scene_status"></div>
    <div class="wf_scene_body">
        <div id="wf_scene_pane_location" class="wf_scene_pane wf_scene_pane_active">
            <label data-i18n="Where is the current scene happening?">Where is the current scene happening?</label>
            <textarea id="wf_scene_location" class="text_pole wf_scene_location" rows="4"
                placeholder="e.g. The rain-soaked back alley behind the Copper Lantern tavern, near midnight."></textarea>

            <label for="wf_scene_time" data-i18n="What time is it?">What time is it?</label>
            <input id="wf_scene_time" class="text_pole" type="text"
                placeholder="e.g. 4PM, or morning / noon / evening / night" />
            <div id="wf_scene_time_presets" class="wf_scene_time_presets">
                <span class="wf_scene_time_chip" data-time="Dawn" data-i18n="Dawn">Dawn</span>
                <span class="wf_scene_time_chip" data-time="Morning" data-i18n="Morning">Morning</span>
                <span class="wf_scene_time_chip" data-time="Noon" data-i18n="Noon">Noon</span>
                <span class="wf_scene_time_chip" data-time="Afternoon" data-i18n="Afternoon">Afternoon</span>
                <span class="wf_scene_time_chip" data-time="Evening" data-i18n="Evening">Evening</span>
                <span class="wf_scene_time_chip" data-time="Night" data-i18n="Night">Night</span>
                <span class="wf_scene_time_chip" data-time="Midnight" data-i18n="Midnight">Midnight</span>
            </div>

            <label for="wf_scene_day" data-i18n="Day (for stories spanning multiple days; 0 = off)">Day (for stories spanning multiple days; 0 = off)</label>
            <div class="wf_scene_day_row">
                <div id="wf_scene_day_dec" class="menu_button menu_button_icon" title="Previous day"><i class="fa-solid fa-minus"></i></div>
                <input id="wf_scene_day" class="text_pole" type="number" min="0" max="100000" step="1" />
                <div id="wf_scene_day_inc" class="menu_button menu_button_icon" title="Next day"><i class="fa-solid fa-plus"></i></div>
            </div>
            <small class="notes" data-i18n="Set the starting day to begin tracking. Refresh/auto-scan then advances it when the story explicitly skips days.">Set the starting day to begin tracking. Refresh/auto-scan then advances it when the story explicitly skips days.</small>
            <small id="wf_scene_date_preview" class="notes wf_scene_date_preview"></small>

            <label for="wf_scene_weekday" data-i18n="Day 1 is a…">Day 1 is a…</label>
            <select id="wf_scene_weekday" class="text_pole">
                <option value="-1" data-i18n="Off">Off</option>
                <option value="0" data-i18n="Sunday">Sunday</option>
                <option value="1" data-i18n="Monday">Monday</option>
                <option value="2" data-i18n="Tuesday">Tuesday</option>
                <option value="3" data-i18n="Wednesday">Wednesday</option>
                <option value="4" data-i18n="Thursday">Thursday</option>
                <option value="5" data-i18n="Friday">Friday</option>
                <option value="6" data-i18n="Saturday">Saturday</option>
            </select>

            <label class="wf_scene_open_ended" title="Keep counting days/months forever — never show an end or a 'Day X of N' countdown.">
                <input id="wf_scene_open_ended" type="checkbox" />
                <span data-i18n="Open-ended story (no end — just keep counting)">Open-ended story (no end — just keep counting)</span>
            </label>

            <label for="wf_scene_start_month" data-i18n="Calendar — Day 1 starts in">Calendar — Day 1 starts in</label>
            <div class="wf_scene_date_grid">
                <div class="wf_scene_date_field">
                    <select id="wf_scene_start_month" class="text_pole">
                        <option value="-1" data-i18n="Off (no calendar)">Off (no calendar)</option>
                        <option value="0" data-i18n="January">January</option>
                        <option value="1" data-i18n="February">February</option>
                        <option value="2" data-i18n="March">March</option>
                        <option value="3" data-i18n="April">April</option>
                        <option value="4" data-i18n="May">May</option>
                        <option value="5" data-i18n="June">June</option>
                        <option value="6" data-i18n="July">July</option>
                        <option value="7" data-i18n="August">August</option>
                        <option value="8" data-i18n="September">September</option>
                        <option value="9" data-i18n="October">October</option>
                        <option value="10" data-i18n="November">November</option>
                        <option value="11" data-i18n="December">December</option>
                    </select>
                </div>
                <div class="wf_scene_date_field">
                    <input id="wf_scene_start_year" class="text_pole" type="number" step="1" title="Starting year" placeholder="Year" />
                </div>
            </div>
            <small class="notes" data-i18n="With a calendar on, the month and year are derived from the day counter and roll over automatically.">With a calendar on, the month and year are derived from the day counter and roll over automatically.</small>

            <div id="wf_scene_calendar_end">
                <label for="wf_scene_end_month" data-i18n="Story concludes in">Story concludes in</label>
                <div class="wf_scene_date_grid">
                    <div class="wf_scene_date_field">
                        <select id="wf_scene_end_month" class="text_pole">
                            <option value="-1" data-i18n="Off (no end)">Off (no end)</option>
                            <option value="0" data-i18n="January">January</option>
                            <option value="1" data-i18n="February">February</option>
                            <option value="2" data-i18n="March">March</option>
                            <option value="3" data-i18n="April">April</option>
                            <option value="4" data-i18n="May">May</option>
                            <option value="5" data-i18n="June">June</option>
                            <option value="6" data-i18n="July">July</option>
                            <option value="7" data-i18n="August">August</option>
                            <option value="8" data-i18n="September">September</option>
                            <option value="9" data-i18n="October">October</option>
                            <option value="10" data-i18n="November">November</option>
                            <option value="11" data-i18n="December">December</option>
                        </select>
                    </div>
                    <div class="wf_scene_date_field">
                        <input id="wf_scene_end_year" class="text_pole" type="number" step="1" title="Ending year" placeholder="Year" />
                    </div>
                </div>
            </div>

            <div id="wf_scene_freeform_month">
                <label for="wf_scene_month" data-i18n="What month is it?">What month is it?</label>
                <input id="wf_scene_month" class="text_pole" type="text"
                    placeholder="e.g. June, or a custom month name" />
                <div id="wf_scene_month_presets" class="wf_scene_month_presets">
                    <span class="wf_scene_month_chip" data-month="January" data-i18n="January">January</span>
                    <span class="wf_scene_month_chip" data-month="February" data-i18n="February">February</span>
                    <span class="wf_scene_month_chip" data-month="March" data-i18n="March">March</span>
                    <span class="wf_scene_month_chip" data-month="April" data-i18n="April">April</span>
                    <span class="wf_scene_month_chip" data-month="May" data-i18n="May">May</span>
                    <span class="wf_scene_month_chip" data-month="June" data-i18n="June">June</span>
                    <span class="wf_scene_month_chip" data-month="July" data-i18n="July">July</span>
                    <span class="wf_scene_month_chip" data-month="August" data-i18n="August">August</span>
                    <span class="wf_scene_month_chip" data-month="September" data-i18n="September">September</span>
                    <span class="wf_scene_month_chip" data-month="October" data-i18n="October">October</span>
                    <span class="wf_scene_month_chip" data-month="November" data-i18n="November">November</span>
                    <span class="wf_scene_month_chip" data-month="December" data-i18n="December">December</span>
                </div>
            </div>

            <div id="wf_scene_manual_limit">
                <label for="wf_scene_day_limit" data-i18n="Day limit (end of story; 0 = off)">Day limit (end of story; 0 = off)</label>
                <input id="wf_scene_day_limit" class="text_pole" type="number" min="0" max="100000" step="1" />
            </div>

            <div id="wf_scene_director_row" style="display:none;">
                <label for="wf_scene_director" data-i18n="World Director (group member who plays the NPCs)">World Director (group member who plays the NPCs)</label>
                <select id="wf_scene_director" class="text_pole"></select>
                <small class="notes" data-i18n="The scene block will tell this card it plays the NPCs, and tell every other card not to speak for them.">The scene block will tell this card it plays the NPCs, and tell every other card not to speak for them.</small>
            </div>

            <div class="wf_scene_inject_cfg">
                <div class="wf_scene_inject_cfg_head" id="wf_scene_inject_cfg_toggle">
                    <i class="fa-solid fa-syringe"></i>
                    <span data-i18n="Injection (Author's Note style)">Injection (Author's Note style)</span>
                    <i class="fa-solid fa-chevron-down wf_scene_cfg_chevron"></i>
                </div>
                <div class="wf_scene_inject_cfg_body" style="display:none;">
                    <small class="notes" data-i18n="Places the scene block into the prompt like an Author's Note, under its own key (your Author's Note is untouched).">Places the scene block into the prompt like an Author's Note, under its own key (your Author's Note is untouched).</small>
                    <label data-i18n="Position">Position</label>
                    <select id="wf_scene_inject_position" class="text_pole">
                        <option value="1" data-i18n="In chat @ depth">In chat @ depth</option>
                        <option value="0" data-i18n="After main prompt">After main prompt</option>
                        <option value="2" data-i18n="Before main prompt">Before main prompt</option>
                    </select>
                    <div id="wf_scene_inject_depth_row" class="wf_scene_cfg_row">
                        <label for="wf_scene_inject_depth" data-i18n="Depth">Depth</label>
                        <input id="wf_scene_inject_depth" class="text_pole" type="number" min="0" max="100" step="1" />
                    </div>
                    <div class="wf_scene_cfg_row">
                        <label for="wf_scene_inject_role" data-i18n="Role">Role</label>
                        <select id="wf_scene_inject_role" class="text_pole">
                            <option value="0" data-i18n="System">System</option>
                            <option value="1" data-i18n="User">User</option>
                            <option value="2" data-i18n="Assistant">Assistant</option>
                        </select>
                    </div>
                    <div class="wf_scene_cfg_row">
                        <label for="wf_scene_inject_interval" data-i18n="Every N messages (1 = always)">Every N messages (1 = always)</label>
                        <input id="wf_scene_inject_interval" class="text_pole" type="number" min="0" max="50" step="1" />
                    </div>
                </div>
            </div>
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
            <label class="wf_scene_names_only" title="Show only entries whose title looks like a personal name">
                <input id="wf_scene_roster_names_only" type="checkbox" checked />
                <span data-i18n="Names only (NPCs)">Names only (NPCs)</span>
            </label>
            <div id="wf_scene_roster_count" class="wf_scene_roster_count"></div>
            <div id="wf_scene_roster_list" class="wf_scene_list"></div>
        </div>
        <div id="wf_scene_pane_dice" class="wf_scene_pane">
            <small class="notes" data-i18n="Roll world-authored tables BEFORE the model narrates a recalled story or a temporary character. The rolled facts are injected as authoritative context for the next reply only — the dice fix WHAT happened, the model invents the texture.">Roll world-authored tables BEFORE the model narrates a recalled story or a temporary character. The rolled facts are injected as authoritative context for the next reply only — the dice fix WHAT happened, the model invents the texture.</small>
            <div id="wf_dice_source" class="wf_dice_source"></div>
            <div class="wf_dice_pick_row">
                <select id="wf_dice_procedure" class="text_pole"></select>
                <div id="wf_dice_reload" class="menu_button menu_button_icon" title="Reload tables from lorebooks"><i class="fa-solid fa-rotate"></i></div>
            </div>
            <div class="wf_dice_actions">
                <div id="wf_dice_roll" class="menu_button menu_button_primary"><i class="fa-solid fa-dice"></i> <span data-i18n="Roll">Roll</span></div>
                <div id="wf_dice_clear" class="menu_button"><i class="fa-solid fa-xmark"></i> <span data-i18n="Clear">Clear</span></div>
            </div>
            <div id="wf_dice_result" class="wf_dice_result"></div>
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
    right: 0 !important; left: auto !important; bottom: auto !important;
    /* Explicit viewport-unit height instead of top+bottom stretching: ST core sets
       -webkit-transform/-webkit-perspective on <html>, making it the containing
       block for fixed elements, and on mobile body{position:fixed} collapses
       <html> to 0 height — so a top+bottom-stretched panel computes to 0px tall.
       100vh is the fallback for browsers without dvh support. */
    height: calc(100vh - var(--topBarBlockSize, 40px)) !important;
    height: calc(100dvh - var(--topBarBlockSize, 40px)) !important;
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
#wf_scene_time, #wf_scene_month { width: 100%; box-sizing: border-box; }
.wf_scene_time_presets, .wf_scene_month_presets { display: flex; flex-wrap: wrap; gap: 6px; }
.wf_scene_time_chip, .wf_scene_month_chip {
    font-size: 0.78em; padding: 3px 9px; border-radius: 12px; cursor: pointer; user-select: none;
    border: 1px solid var(--SmartThemeBorderColor, #555); opacity: 0.8; white-space: nowrap;
}
.wf_scene_time_chip:hover, .wf_scene_month_chip:hover { opacity: 1; border-color: var(--SmartThemeQuoteColor, #6bb1ff); }
.wf_scene_time_chip.wf_scene_time_active, .wf_scene_month_chip.wf_scene_month_active { opacity: 1; border-color: var(--SmartThemeQuoteColor, #6bb1ff); background: var(--SmartThemeQuoteColor, #6bb1ff); color: var(--SmartThemeBlurTintColor, #1f1f1f); }
.wf_scene_day_row { display: flex; align-items: center; gap: 6px; }
.wf_scene_day_row .text_pole { flex: 1 1 auto; min-width: 0; text-align: center; }
.wf_scene_date_grid { display: flex; gap: 10px; flex-wrap: wrap; }
.wf_scene_date_field { flex: 1 1 120px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wf_scene_date_preview { font-style: italic; opacity: 0.9; }
.wf_scene_date_preview:empty { display: none; }
.wf_scene_open_ended { display: flex; align-items: center; gap: 6px; cursor: pointer; margin: 4px 0; }
.wf_scene_open_ended input { margin: 0; }
#wf_scene_director_row { display: flex; flex-direction: column; gap: 4px; }
.wf_scene_inject_cfg { margin-top: 10px; border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 8px; }
.wf_scene_inject_cfg_head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; user-select: none; opacity: 0.9; }
.wf_scene_inject_cfg_head:hover { opacity: 1; }
.wf_scene_cfg_chevron { margin-left: auto; transition: transform 0.15s ease; }
.wf_scene_inject_cfg.open .wf_scene_cfg_chevron { transform: rotate(180deg); }
.wf_scene_inject_cfg_body { display: flex; flex-direction: column; gap: 6px; padding: 0 10px 10px; }
.wf_scene_inject_cfg_body label { font-size: 0.85em; opacity: 0.85; }
.wf_scene_cfg_row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wf_scene_cfg_row label { flex: 1 1 auto; }
.wf_scene_cfg_row input, .wf_scene_cfg_row select { flex: 0 0 auto; width: 110px; }
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
.wf_scene_names_only { display: flex; align-items: center; gap: 6px; font-size: 0.82em; opacity: 0.85; cursor: pointer; }
.wf_scene_names_only input { margin: 0; }
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
.wf_npc_portrait_wrap { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.wf_npc_portrait {
    width: 34px; height: 34px; flex: 0 0 auto; border-radius: 50%;
    background-size: cover; background-position: center top; cursor: pointer;
    border: 1px solid var(--SmartThemeBorderColor, #555);
    display: flex; align-items: center; justify-content: center; opacity: 0.9;
}
.wf_npc_portrait.no_pic { opacity: 0.45; font-size: 0.9em; }
.wf_npc_portrait:hover { opacity: 1; border-color: var(--SmartThemeQuoteColor, #6bb1ff); }
.wf_npc_pic_btn { cursor: pointer; opacity: 0.5; font-size: 0.82em; padding: 2px; }
.wf_npc_pic_btn:hover { opacity: 1; }
.wf_scene_person .wf_npc_portrait_wrap { margin-top: 8px; }
.wf_dice_source { font-size: 0.78em; opacity: 0.7; }
.wf_dice_source.wf_dice_builtin { color: var(--SmartThemeQuoteColor, #6bb1ff); opacity: 0.9; }
.wf_dice_pick_row { display: flex; gap: 6px; align-items: center; }
.wf_dice_pick_row .text_pole { flex: 1 1 auto; min-width: 0; }
.wf_dice_actions { display: flex; gap: 6px; }
.wf_dice_actions .menu_button { flex: 1 1 0; justify-content: center; }
.wf_dice_result { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.wf_dice_result:empty { display: none; }
.wf_dice_armed_note { font-size: 0.8em; opacity: 0.85; font-style: italic; }
.wf_dice_armed_note.wf_dice_spent { color: var(--SmartThemeQuoteColor, #6bb1ff); }
.wf_dice_fact {
    border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 8px;
    padding: 7px 9px; background: rgba(255, 255, 255, 0.03);
    display: flex; flex-direction: column; gap: 2px;
}
.wf_dice_fact_label { font-size: 0.74em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
.wf_dice_fact_value { font-size: 0.95em; }
.wf_dice_fact_detail { font-size: 0.72em; opacity: 0.5; margin-left: auto; margin-top: -14px; }
.wf_dice_disabled { opacity: 0.4; pointer-events: none; }
/* ST's mobile breakpoint (see mobile-styles.css). Declarations need !important to
   beat the base rule above. Keep the panel docked to the right edge with a sliver
   of chat visible, and pad for the home indicator on notched phones. */
@media screen and (max-width: 1000px) {
    #wf_scene_window {
        width: min(420px, 92vw) !important;
        max-width: 92vw !important;
        padding-bottom: env(safe-area-inset-bottom, 0px) !important;
    }
}`;

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

// ----------------------------- NPC pictures --------------------------------
// Each NPC can have a portrait the user uploads. The mapping is keyed by the
// NPC's (normalised) name and stored globally in extension settings, so the
// same picture follows that NPC across every chat that uses its lorebook.

function npcKey(name) {
    return String(name || '').trim().toLowerCase();
}

function getNpcPicture(name) {
    const key = npcKey(name);
    if (!key) return '';
    const path = getSettings().npcPictures[key];
    return typeof path === 'string' ? path : '';
}

function setNpcPicture(name, path) {
    const key = npcKey(name);
    if (!key) return;
    getSettings().npcPictures[key] = path;
    getContext().saveSettingsDebounced();
}

function removeNpcPicture(name) {
    const key = npcKey(name);
    if (!key) return;
    delete getSettings().npcPictures[key];
    getContext().saveSettingsDebounced();
}

/** Safe-for-selector token derived from an NPC name. */
function npcSlug(name) {
    return (npcKey(name).replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'npc');
}

/**
 * Show an NPC's picture in the same draggable, zoomable popup used when you
 * click a character's avatar in chat (reuses #zoomed_avatar_template). Clicking
 * the same NPC again toggles the popup closed.
 * @param {string} name
 * @param {string} src
 */
function showNpcPicture(name, src) {
    if (!src) return;
    const forChar = `wf_npc_${npcSlug(name)}`;
    const existing = $(`.zoomed_avatar[forChar="${forChar}"]`);
    if (existing.length) {
        existing.fadeOut(animation_duration, function () { $(this).remove(); });
        return;
    }

    const template = $('#zoomed_avatar_template').html();
    if (!template) { window.open(src, '_blank'); return; } // graceful fallback

    const $el = $(template);
    $el.attr('forChar', forChar).attr('id', `zoomFor_${forChar}`).addClass('draggable');
    $el.find('.drag-grabber').attr('id', `zoomFor_${forChar}header`);
    // NPC portraits are static images — drop the unused video/toggle controls.
    $el.find('.zoomed_avatar_video, .zoomed_avatar_toggle').remove();

    $('body').append($el);
    const $img = $el.find('.zoomed_avatar_img');
    $img.attr('src', src).attr('data-izoomify-url', src).attr('alt', name);
    $el.css('display', 'flex').hide().fadeIn(animation_duration);

    try { if ($.fn?.draggable) $el.draggable({ handle: '.drag-grabber' }); } catch { /* drag is optional */ }

    $el.on('click touchend', (e) => {
        if (e.target.closest('.dragClose')) {
            $(`.zoomed_avatar[forChar="${forChar}"]`).fadeOut(animation_duration, function () { $(this).remove(); });
        }
    });
}

/**
 * Open a file picker and upload the chosen image as this NPC's picture. Mirrors
 * the background-upload flow: data URL → strip prefix → /api/images/upload.
 * @param {string} name
 * @param {Function} [onChange] Called after a successful upload to re-render.
 */
function uploadNpcPicture(name, onChange) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            setSceneStatus(`Uploading picture for "${name}"…`);
            const dataUrl = await getBase64Async(file);
            const base64 = String(dataUrl).split(',')[1];
            const ext = getFileExtension(file) || (file.type.split('/')[1] || 'png');
            const fileName = `${npcSlug(name)}_${Date.now()}`;
            const path = await saveBase64AsFile(base64, 'world_forge_npcs', fileName, ext);
            setNpcPicture(name, path);
            setSceneStatus(`Saved picture for "${name}".`);
            if (typeof onChange === 'function') onChange();
        } catch (error) {
            warn('npc picture upload failed', error);
            setSceneStatus(error?.message || 'Picture upload failed.', true);
        }
    });
    input.click();
}

/**
 * Build the portrait + picture controls for an NPC/character. With a picture:
 * the portrait shows it and clicking it opens the zoom popup, plus replace/remove
 * buttons. Without one: a placeholder whose click uploads a picture.
 * @param {string} name
 * @param {Function} onChange Re-render callback for the owning list.
 * @returns {JQuery<HTMLElement>}
 */
function buildNpcPortrait(name, onChange) {
    const src = getNpcPicture(name);
    const $wrap = $('<div class="wf_npc_portrait_wrap"></div>');
    const $portrait = $('<div class="wf_npc_portrait"></div>');

    if (src) {
        $portrait.addClass('has_pic')
            .css('background-image', `url("${String(src).replace(/"/g, '%22')}")`)
            .attr('title', 'Show picture')
            .on('click', () => showNpcPicture(name, src));
        const $replace = $('<div class="wf_npc_pic_btn" title="Replace picture"><i class="fa-solid fa-camera"></i></div>')
            .on('click', (e) => { e.stopPropagation(); uploadNpcPicture(name, onChange); });
        const $remove = $('<div class="wf_npc_pic_btn" title="Remove picture"><i class="fa-solid fa-trash-can"></i></div>')
            .on('click', (e) => { e.stopPropagation(); removeNpcPicture(name); if (typeof onChange === 'function') onChange(); });
        $wrap.append($portrait, $replace, $remove);
    } else {
        $portrait.addClass('no_pic')
            .attr('title', 'Add picture')
            .html('<i class="fa-solid fa-user"></i>')
            .on('click', () => uploadNpcPicture(name, onChange));
        $wrap.append($portrait);
    }
    return $wrap;
}

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

        // Portrait + picture controls for AI characters & NPCs (not the user).
        if (person.role !== 'user') {
            $card.append(buildNpcPortrait(person.name, renderPresent));
        }

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
            field('clothing', 'Clothing', 'e.g. red dress, leather armor');
            field('mood', 'Mood', 'e.g. calm, angry, flustered');
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

// Lowercase tokens that are part of a name but not themselves capitalised name
// words — name particles ("von Trapp", "de la Cruz") and honorifics ("Dr.",
// "Sir"). They don't count toward, nor disqualify, a title looking like a name.
const NAME_PARTICLES = new Set(['von', 'van', 'de', 'del', 'della', 'di', 'da', 'la', 'le', 'du', 'of', 'the', 'bin', 'al', 'mac', 'mc', 'san', 'st', 'dos', 'das', 'ten', 'ter']);
const NAME_HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'lady', 'lord', 'capt', 'captain', 'prof', 'professor', 'father', 'sister', 'brother', 'king', 'queen', 'prince', 'princess', 'master', 'mistress', 'madam', 'madame', 'count', 'countess', 'baron', 'baroness', 'duke', 'duchess', 'general', 'sgt', 'sergeant', 'col', 'colonel', 'major', 'lt', 'lieutenant']);

// Abstract nouns that mark a title as non-NPC lore even when capitalised like a
// name ("World Rules", "Magic System Overview"). Deliberately limited to words
// that are very unlikely to be a person's name.
const NON_NAME_WORDS = new Set(['rules', 'system', 'systems', 'overview', 'lore', 'timeline', 'history', 'map', 'faction', 'factions', 'guide', 'summary', 'glossary', 'index', 'mechanics', 'setting', 'settings', 'location', 'locations', 'inventory', 'quest', 'quests', 'background', 'intro', 'introduction', 'notes', 'readme', 'template', 'prompt', 'instructions', 'worldbuilding', 'world', 'rule', 'info', 'information', 'list']);

/**
 * First-release heuristic for "this title looks like a personal name". Structural
 * (not dictionary-based) so it works for invented/fantasy names too: 1–4 words,
 * letters plus name punctuation only, each significant word Capitalised and not a
 * SHOUTED heading. Rejects entries with digits, symbols, or colons (typically
 * non-NPC lore like "World Rules", "Faction: The Order", "Chapter 2").
 * @param {string} title
 * @returns {boolean}
 */
function looksLikeName(title) {
    const t = String(title || '').trim();
    if (!t) return false;
    // Letters (any script) plus spaces, periods, hyphens and apostrophes only.
    if (!/^[\p{L}][\p{L} .'’-]*$/u.test(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) return false;

    let nameWords = 0;
    for (const raw of words) {
        const word = raw.replace(/\.$/, ''); // tolerate a trailing period ("Dr.")
        const bare = word.toLowerCase().replace(/[.'’-]/g, '');
        if (NON_NAME_WORDS.has(bare)) return false; // a lore-heading word, not a name
        if (NAME_PARTICLES.has(bare) || NAME_HONORIFICS.has(bare)) continue;
        // A name word starts with an uppercase letter and isn't a SHOUTED heading.
        if (!/^\p{Lu}[\p{L}'’-]*$/u.test(word)) return false;
        if (word.length > 1 && word === word.toUpperCase()) return false;
        nameWords++;
    }
    return nameWords >= 1;
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
    const namesOnly = $('#wf_scene_roster_names_only').prop('checked');
    const present = new Set(getSceneData().present.map(p => String(p.name || '').toLowerCase()));

    let items = book === ALL_BOOKS ? rosterEntries : rosterEntries.filter(e => e.world === book);
    if (namesOnly) items = items.filter(e => looksLikeName(entryTitle(e)));
    if (query) {
        items = items.filter(e =>
            entryTitle(e).toLowerCase().includes(query) ||
            String(e.content || '').toLowerCase().includes(query) ||
            (Array.isArray(e.key) && e.key.some(k => String(k).toLowerCase().includes(query))));
    }

    const noun = namesOnly ? (items.length === 1 ? 'NPC' : 'NPCs') : `entr${items.length === 1 ? 'y' : 'ies'}`;
    $count.text(`${items.length} ${noun}`);

    if (!items.length) {
        let msg;
        if (!rosterEntries.length) msg = 'No active lorebooks found for this chat/character.';
        else if (namesOnly) msg = 'No name-like entries found. Untick "Names only" to see all entries.';
        else msg = 'No entries match your filter.';
        $list.append(`<div class="wf_scene_empty">${msg}</div>`);
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

        $head.append(buildNpcPortrait(title, renderRoster), $title, $add);
        $card.append($head, $content);
        $list.append($card);
    }
}

/**
 * Populate the World Director dropdown with the current group's member names.
 * Only meaningful (and only shown) in group chats; in solo chats the active
 * character implicitly plays everything, so the row stays hidden.
 */
function renderSceneDirector() {
    const $row = $('#wf_scene_director_row');
    const $select = $('#wf_scene_director');
    if (!$row.length || !$select.length) return;

    if (!getContext().groupId) {
        $row.hide();
        return;
    }

    const members = getGroupMembers();
    const memberNames = members.map(m => m.name).filter(Boolean);
    const scene = getSceneData();

    // Auto mode: with no explicit pick, the single Director/NPC-tagged member
    // (the same tag classification the group reply router uses) is assumed.
    const autoDetected = scene.director ? '' : resolveDirectorName(scene);
    $select.empty();
    $('<option></option>').val('').text(autoDetected ? `— auto: ${autoDetected} —` : '— not set —').appendTo($select);
    for (const member of members) {
        const label = isDirectorCharacter(member) ? `${member.name} (Director tag)` : member.name;
        $('<option></option>').val(member.name).text(label).appendTo($select);
    }
    // Keep a stale value visible (e.g. the card was removed from the group)
    // instead of silently snapping the selection back to "not set".
    if (scene.director && !memberNames.includes(scene.director)) {
        $('<option></option>').val(scene.director).text(`${scene.director} (not in group)`).appendTo($select);
    }
    $select.val(scene.director || '');
    $row.show();
}

/** Highlight the time-of-day chip matching the current free-text time, if any. */
function renderSceneTimeChips() {
    const current = String(getSceneData().time || '').trim().toLowerCase();
    $('.wf_scene_time_chip').each(function () {
        const chip = String($(this).data('time') || '').toLowerCase();
        $(this).toggleClass('wf_scene_time_active', !!chip && chip === current);
    });
}

/** Highlight the month chip matching the current free-text month, if any. */
function renderSceneMonthChips() {
    const current = String(getSceneData().month || '').trim().toLowerCase();
    $('.wf_scene_month_chip').each(function () {
        const chip = String($(this).data('month') || '').toLowerCase();
        $(this).toggleClass('wf_scene_month_active', !!chip && chip === current);
    });
}

/** Live "→ Tuesday, Day 1 of 30 — June, Year 1" preview under the date controls. */
function renderSceneDatePreview() {
    const scene = getSceneData();
    const day = Number(scene.day) || 0;
    let text = '';
    if (day >= 1) {
        const limit = effectiveDayLimit(scene);
        const weekday = weekdayForDay(scene);
        const dayPart = `Day ${day}${limit >= 1 ? ` of ${limit}` : ''}`;
        text = `→ ${weekday ? `${weekday}, ${dayPart}` : dayPart}`;
        const cal = calendarDateForDay(scene);
        if (cal) text += ` — ${MONTHS[cal.month]}, Year ${cal.year}`;
        if (scene.openEnded) text += ' (open-ended)';
    }
    $('#wf_scene_date_preview').text(text);
}

/** Show the calendar controls vs the free-form month/manual-limit fallback. */
function renderSceneCalendarVisibility() {
    const scene = getSceneData();
    const hasCalendar = Number(scene.startMonth) >= 0;
    // Free-form month and the manual day limit only apply without a calendar.
    $('#wf_scene_freeform_month').toggle(!hasCalendar);
    $('#wf_scene_manual_limit').toggle(!hasCalendar && !scene.openEnded);
    // An open-ended story has no horizon, so the end-date pickers are moot.
    $('#wf_scene_calendar_end').toggle(hasCalendar && !scene.openEnded);
}

function renderScene() {
    const scene = getSceneData();
    $('#wf_scene_location').val(scene.location);
    $('#wf_scene_time').val(scene.time);
    renderSceneTimeChips();
    $('#wf_scene_month').val(scene.month);
    renderSceneMonthChips();
    $('#wf_scene_day').val(scene.day);
    $('#wf_scene_day_limit').val(scene.dayLimit);
    $('#wf_scene_weekday').val(String(scene.weekdayStart));
    $('#wf_scene_open_ended').prop('checked', scene.openEnded);
    $('#wf_scene_start_month').val(String(scene.startMonth));
    $('#wf_scene_start_year').val(scene.startYear);
    $('#wf_scene_end_month').val(String(scene.endMonth));
    $('#wf_scene_end_year').val(scene.endYear);
    renderSceneCalendarVisibility();
    renderSceneDatePreview();
    $('#wf_scene_inject').prop('checked', scene.inject);
    $('#wf_scene_inject_position').val(String(scene.injectPosition));
    $('#wf_scene_inject_depth').val(scene.injectDepth);
    $('#wf_scene_inject_role').val(String(scene.injectRole));
    $('#wf_scene_inject_interval').val(scene.injectInterval);
    // Depth only matters for the "in chat @ depth" position.
    $('#wf_scene_inject_depth_row').toggle(scene.injectPosition === extension_prompt_types.IN_CHAT);
    renderSceneDirector();
    renderPresent();
    renderRoster();
    // Only refresh the Dice pane if its tables are already loaded — opening the
    // window on another tab shouldn't force a world-info read.
    if (diceLoaded) renderDicePane();
}

function switchSceneTab(tab) {
    $('.wf_scene_tab').removeClass('wf_scene_tab_active');
    $(`.wf_scene_tab[data-tab="${tab}"]`).addClass('wf_scene_tab_active');
    $('.wf_scene_pane').removeClass('wf_scene_pane_active');
    $(`#wf_scene_pane_${tab}`).addClass('wf_scene_pane_active');
    // Lazily read the lorebooks the first time the roster tab is opened.
    if (tab === 'roster' && !rosterLoaded && !rosterLoading) loadRoster();
    // Lazily read the world's dice tables the first time the Dice tab is opened.
    if (tab === 'dice') {
        if (!diceLoaded && !diceLoading) void loadDiceTables();
        else renderDicePane();
    }
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
        const { present, removed } = await refreshSceneFromChat();
        // Keep the auto-scan cadence in step so it doesn't immediately re-fire.
        lastAutoScanMsgCount = aiMessageCount();
        renderScene();
        updateSceneExtensionPrompt();
        setSceneStatus(`Updated from chat — ${present} in scene${removed ? `, ${removed} left` : ''}.`);
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
        $('#wf_scene_time').on('input', function () {
            getSceneData().time = $(this).val();
            renderSceneTimeChips();
            saveSceneData();
        });
        $('#wf_scene_time_presets').on('click', '.wf_scene_time_chip', function () {
            const value = String($(this).data('time') || '');
            getSceneData().time = value;
            $('#wf_scene_time').val(value);
            renderSceneTimeChips();
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        $('#wf_scene_month').on('input', function () {
            getSceneData().month = $(this).val();
            renderSceneMonthChips();
            saveSceneData();
        });
        $('#wf_scene_month_presets').on('click', '.wf_scene_month_chip', function () {
            const value = String($(this).data('month') || '');
            getSceneData().month = value;
            $('#wf_scene_month').val(value);
            renderSceneMonthChips();
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        $('#wf_scene_day').on('input', function () {
            getSceneData().day = Math.max(0, Math.round(Number($(this).val()) || 0));
            renderSceneDatePreview();
            saveSceneData();
        });
        $('#wf_scene_day_limit').on('input', function () {
            getSceneData().dayLimit = Math.max(0, Math.min(100000, Math.round(Number($(this).val()) || 0)));
            renderSceneDatePreview();
            saveSceneData();
        });
        $('#wf_scene_weekday').on('change', function () {
            let v = Math.round(Number($(this).val()));
            if (!Number.isFinite(v) || v < 0 || v > 6) v = -1;
            getSceneData().weekdayStart = v;
            renderSceneDatePreview();
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        $('#wf_scene_open_ended').on('change', function () {
            getSceneData().openEnded = $(this).prop('checked');
            renderSceneCalendarVisibility();
            renderSceneDatePreview();
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        const onCalendarMonthChange = (key) => function () {
            let v = Math.round(Number($(this).val()));
            if (!Number.isFinite(v) || v < 0 || v > 11) v = -1;
            getSceneData()[key] = v;
            renderSceneCalendarVisibility();
            renderSceneDatePreview();
            saveSceneData();
            updateSceneExtensionPrompt();
        };
        const onCalendarYearChange = (key) => function () {
            getSceneData()[key] = Math.round(Number($(this).val()) || 0);
            renderSceneDatePreview();
            saveSceneData();
            updateSceneExtensionPrompt();
        };
        $('#wf_scene_start_month').on('change', onCalendarMonthChange('startMonth'));
        $('#wf_scene_end_month').on('change', onCalendarMonthChange('endMonth'));
        $('#wf_scene_start_year').on('input', onCalendarYearChange('startYear'));
        $('#wf_scene_end_year').on('input', onCalendarYearChange('endYear'));
        const stepDay = (delta) => {
            const scene = getSceneData();
            scene.day = Math.max(0, scene.day + delta);
            $('#wf_scene_day').val(scene.day);
            renderSceneDatePreview();
            saveSceneData();
            updateSceneExtensionPrompt();
        };
        $('#wf_scene_day_dec').on('click', () => stepDay(-1));
        $('#wf_scene_day_inc').on('click', () => stepDay(1));
        $('#wf_scene_inject').on('change', function () {
            getSceneData().inject = $(this).prop('checked');
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        $('#wf_scene_director').on('change', function () {
            getSceneData().director = String($(this).val() || '');
            saveSceneData();
            updateSceneExtensionPrompt();
        });

        // Author's-Note-style placement controls.
        $('#wf_scene_inject_cfg_toggle').on('click', function () {
            const $cfg = $(this).closest('.wf_scene_inject_cfg');
            const $body = $cfg.find('.wf_scene_inject_cfg_body');
            const show = $body.is(':hidden');
            $body.toggle(show);
            $cfg.toggleClass('open', show);
        });
        $('#wf_scene_inject_position').on('change', function () {
            const scene = getSceneData();
            scene.injectPosition = Number($(this).val());
            $('#wf_scene_inject_depth_row').toggle(scene.injectPosition === extension_prompt_types.IN_CHAT);
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        $('#wf_scene_inject_depth').on('input', function () {
            getSceneData().injectDepth = Math.max(0, Math.min(100, Number($(this).val()) || 0));
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        $('#wf_scene_inject_role').on('change', function () {
            getSceneData().injectRole = Number($(this).val());
            saveSceneData();
            updateSceneExtensionPrompt();
        });
        $('#wf_scene_inject_interval').on('input', function () {
            getSceneData().injectInterval = Math.max(0, Math.min(50, Number($(this).val()) || 0));
            saveSceneData();
            updateSceneExtensionPrompt();
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
        $('#wf_scene_roster_names_only').on('change', renderRoster);

        // Dice oracle tab.
        $('#wf_dice_procedure').on('change', function () { diceSelectedProcedureId = String($(this).val() || ''); });
        $('#wf_dice_reload').on('click', () => { diceLoaded = false; loadDiceTables(); });
        $('#wf_dice_roll').on('click', onDiceRoll);
        $('#wf_dice_clear').on('click', () => {
            disarmDice(true);
            setSceneStatus('Dice oracle cleared.');
        });

        // Re-render when the chat changes so the panel reflects the new chat's
        // record, and invalidate the roster so it re-reads the new lorebook set.
        eventSource.on(event_types.CHAT_CHANGED, () => {
            rosterLoaded = false;
            rosterEntries = [];
            // A new chat may bind a different world (different [[DICE_TABLES]]);
            // invalidate so the Dice tab re-reads on next open.
            diceLoaded = false;
            diceTables = null;
            if (sceneOpen) {
                renderScene();
                if ($('.wf_scene_tab[data-tab="roster"]').hasClass('wf_scene_tab_active')) loadRoster();
                if ($('.wf_scene_tab[data-tab="dice"]').hasClass('wf_scene_tab_active')) loadDiceTables();
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
    // Scene Tracker injection (Author's-Note-style placement under our own key):
    // recompute before each generation, and clear/refresh when the chat changes.
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, updateSceneExtensionPrompt);
    eventSource.on(event_types.CHAT_CHANGED, updateSceneExtensionPrompt);
    // Dice oracle (manual, one-exchange lifecycle — see contracts/DICE_ORACLE.md):
    // keep the injection current before each gen, mark facts spent once a reply
    // lands, and release them when the user sends the next message. Refresh on
    // chat change so a stale armed roll from another chat never leaks in.
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, updateDiceExtensionPrompt);
    eventSource.on(event_types.GENERATION_ENDED, onDiceGenerationEnded);
    eventSource.on(event_types.MESSAGE_SENT, onDiceMessageSent);
    eventSource.on(event_types.CHAT_CHANGED, updateDiceExtensionPrompt);
    // Seed the Scene Tracker's calendar from the world's [[WORLD_CALENDAR]] block
    // on a fresh chat (no-op when absent or when the user has set dates already).
    eventSource.on(event_types.CHAT_CHANGED, maybeSeedCalendarFromWorld);
    // Periodic presence re-scan, paced by AI messages (see maybeAutoScan). Reset
    // the per-chat cadence baseline whenever the chat changes.
    eventSource.on(event_types.MESSAGE_RECEIVED, maybeAutoScan);
    eventSource.on(event_types.CHAT_CHANGED, () => { lastAutoScanMsgCount = aiMessageCount(); });
    // Defer DOM wiring until the document is ready so #extensionsMenu exists.
    const initUI = () => { initKeyMomentsUI(); initSceneTrackerUI(); };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI, { once: true });
    } else {
        initUI();
    }
    console.log('[world-forge] runtime extension loaded');
}
