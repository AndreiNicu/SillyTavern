/**
 * World Loader — SillyTavern server plugin (inspector half).
 *
 * One job: take an uploaded World-Forge export (.zip), unzip it in memory, and
 * return a structured "load plan" the client extension can execute against
 * SillyTavern's own import APIs. It writes NOTHING — all persistence happens
 * client-side through ST's normal pipelines (so cards/lorebooks/presets go
 * through the same code paths as a manual import).
 *
 * Classification prefers a root-level `world.manifest.json`
 * (see ../schema/WORLD-FORGE-LOADER-GUIDE.md); when absent it falls back to
 * filename conventions so older exports still load.
 *
 * Routes mount under /api/plugins/world-loader/*.
 */
/* global require, module, console, Buffer */
'use strict';

const multer = require('multer');
const yauzl = require('yauzl');

const PLUGIN_ID = 'world-loader';
const SCHEMA_MAJOR = 1; // manifests with a different major are refused.

const info = {
    id: PLUGIN_ID,
    name: 'World Loader',
    description: 'Inspects a World-Forge export zip and returns a load plan (cards, lorebooks, preset, persona, RPG).',
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 64 * 1024 * 1024 }, // 64 MB; worlds are small, this is generous.
});

/* --------------------------------------------------------------- zip read */

/**
 * Read every file in a zip buffer into a map keyed by basename (last path
 * segment), so a zip wrapped in an `Export/` folder still resolves cleanly.
 * @returns {Promise<{ byName: Object<string,Buffer>, dupes: string[] }>}
 */
function readZip(buffer) {
    return new Promise((resolve, reject) => {
        const byName = {};
        const dupes = [];
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            zip.on('entry', (entry) => {
                if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; } // directory
                const base = entry.fileName.split('/').pop();
                if (!base || base.startsWith('.') || base.startsWith('__MACOSX')) { zip.readEntry(); return; }
                zip.openReadStream(entry, (err2, stream) => {
                    if (err2) return reject(err2);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('error', reject);
                    stream.on('end', () => {
                        if (byName[base] !== undefined) dupes.push(base);
                        byName[base] = Buffer.concat(chunks);
                        zip.readEntry();
                    });
                });
            });
            zip.on('error', reject);
            zip.on('end', () => resolve({ byName, dupes }));
            zip.readEntry();
        });
    });
}

/* --------------------------------------------------------------- helpers */

const baseName = (file) => String(file || '').split('/').pop();
const stripExt = (file) => baseName(file).replace(/\.[^/.]+$/, '');

function parseJson(byName, file, warnings) {
    const buf = byName[baseName(file)];
    if (buf === undefined) { warnings.push(`Missing file referenced in bundle: ${file}`); return null; }
    try {
        return JSON.parse(buf.toString('utf-8'));
    } catch (e) {
        warnings.push(`Could not parse JSON: ${file} (${e.message})`);
        return null;
    }
}

function readText(byName, file, warnings) {
    const buf = byName[baseName(file)];
    if (buf === undefined) { warnings.push(`Missing file referenced in bundle: ${file}`); return null; }
    return buf.toString('utf-8');
}

/** A lorebook descriptor: { name (basename, no ext), data (parsed JSON) }. */
function lorebook(byName, file, warnings) {
    if (!file) return null;
    const data = parseJson(byName, file, warnings);
    if (!data) return null;
    if (!data || typeof data !== 'object' || !('entries' in data)) {
        warnings.push(`Not a valid lorebook (no "entries"): ${file}`);
        return null;
    }
    return { name: stripExt(file), file: baseName(file), data };
}

/* ----------------------------------------------------- manifest classify */

function planFromManifest(byName, manifest, warnings) {
    const m = manifest;
    if (typeof m.schema_version === 'string') {
        const major = Number(m.schema_version.split('.')[0]);
        if (Number.isFinite(major) && major !== SCHEMA_MAJOR) {
            warnings.push(`Manifest schema_version ${m.schema_version} differs in major from loader (${SCHEMA_MAJOR}.x); loading best-effort.`);
        }
    }

    const characters = (m.characters || []).map((c) => {
        const card = parseJson(byName, c.file, warnings);
        if (!card) return null;
        return {
            file: baseName(c.file),
            displayName: c.name || card?.data?.name || card?.name || stripExt(c.file),
            director: !!c.director,
            card,
            lorebook: lorebook(byName, c.lorebook, warnings),
            intimacy: lorebook(byName, c.intimacy, warnings),
        };
    }).filter(Boolean);

    const worldBooks = (m.lorebooks?.world || []).map((f) => lorebook(byName, f, warnings)).filter(Boolean);
    const groupBooks = (m.lorebooks?.group || []).map((f) => lorebook(byName, f, warnings)).filter(Boolean);
    const arcBooks = (m.lorebooks?.arcs || []).map((a) => {
        const book = lorebook(byName, a.file, warnings);
        if (!book) return null;
        return { n: a.n, ...book, intimacy: lorebook(byName, a.intimacy, warnings) };
    }).filter(Boolean);

    let persona = null;
    if (m.persona) {
        persona = {
            name: m.persona.name || 'Player',
            description: m.persona.description_file ? (readText(byName, m.persona.description_file, warnings) || '') : '',
            lorebook: lorebook(byName, m.persona.lorebook, warnings),
        };
    }

    let preset = null;
    if (m.preset) {
        const data = parseJson(byName, m.preset, warnings);
        if (data) preset = { name: stripExt(m.preset), file: baseName(m.preset), data };
    }

    const rpg = { userProfile: null, bestiary: null };
    if (m.rpg?.user_profile) {
        const data = parseJson(byName, m.rpg.user_profile, warnings);
        if (data) rpg.userProfile = { file: baseName(m.rpg.user_profile), data };
    }
    if (m.rpg?.bestiary) {
        const data = parseJson(byName, m.rpg.bestiary, warnings);
        if (data) rpg.bestiary = { file: baseName(m.rpg.bestiary), data };
    }

    const lowestArc = arcBooks.length ? Math.min(...arcBooks.map((a) => a.n)) : null;
    const activeArc = m.defaults?.active_arc ?? lowestArc;

    return {
        source: 'manifest',
        schema_version: m.schema_version || null,
        world: {
            id: m.world?.id || 'world',
            name: m.world?.name || m.world?.id || 'Imported World',
            mode: m.world?.mode || 'arc',
            description: m.world?.description || '',
        },
        defaults: { active_arc: activeArc },
        characters, worldBooks, groupBooks, arcBooks, persona, preset, rpg,
        docs: (m.docs || []).map((f) => ({ file: baseName(f) })),
    };
}

/* --------------------------------------------------- convention classify */

function planFromConvention(byName, warnings) {
    const names = Object.keys(byName);
    const characters = [];
    const worldBooks = [];
    const groupBooks = [];
    const arcBooks = [];
    const charBooksUnbound = []; // *_Lorebook.json not matched to a card yet
    const intimacyByName = {};   // name -> book (character intimacy profiles)
    const arcIntimacy = {};      // n -> book
    let preset = null;
    let personaText = null;
    const rpg = { userProfile: null, bestiary: null };
    const docs = [];

    for (const file of names) {
        const lower = file.toLowerCase();
        if (file === 'world.manifest.json') continue;

        if (/_card\.json$/i.test(file)) {
            const card = parseJson(byName, file, warnings);
            if (card) {
                characters.push({
                    file, displayName: card?.data?.name || card?.name || stripExt(file),
                    director: /director/i.test(file), card, lorebook: null, intimacy: null,
                });
            }
        } else if (/-world_lorebook\.json$/i.test(file)) {
            const b = lorebook(byName, file, warnings); if (b) worldBooks.push(b);
        } else if (/-group_lorebook\.json$/i.test(file)) {
            const b = lorebook(byName, file, warnings); if (b) groupBooks.push(b);
        } else if (/-arc(\d+)_lorebook\.json$/i.test(file)) {
            const n = Number(file.match(/-arc(\d+)_lorebook\.json$/i)[1]);
            const b = lorebook(byName, file, warnings); if (b) arcBooks.push({ n, ...b, intimacy: null });
        } else if (/-arc(\d+)_intimacy_register\.json$/i.test(file)) {
            const n = Number(file.match(/-arc(\d+)_intimacy_register\.json$/i)[1]);
            const b = lorebook(byName, file, warnings); if (b) arcIntimacy[n] = b;
        } else if (/_intimacy_profile\.json$/i.test(file)) {
            const owner = stripExt(file).replace(/_intimacy_profile$/i, '').replace(/^[^-]*-/, '');
            const b = lorebook(byName, file, warnings);
            if (b) intimacyByName[owner.toLowerCase().replace(/[^a-z0-9]/g, '')] = b;
        } else if (/_lorebook\.json$/i.test(file)) {
            const b = lorebook(byName, file, warnings);
            if (b) charBooksUnbound.push({ owner: stripExt(file).replace(/_lorebook$/i, '').replace(/^[^-]*-/, ''), book: b });
        } else if (/_chatpreset\.json$/i.test(file)) {
            const data = parseJson(byName, file, warnings);
            if (data) preset = { name: stripExt(file), file, data };
        } else if (/user\.md$/i.test(lower)) {
            personaText = readText(byName, file, warnings);
        } else if (/bestiary\.json$/i.test(lower)) {
            const data = parseJson(byName, file, warnings); if (data) rpg.bestiary = { file, data };
        } else if (/_rpg\.json$/i.test(lower)) {
            const data = parseJson(byName, file, warnings); if (data) rpg.userProfile = { file, data };
        } else if (/\.md$/i.test(lower)) {
            docs.push({ file });
        }
    }

    // Bind unbound *_Lorebook books to cards by name; the leftover is the persona book.
    // Match on a normalized key (lowercase, alphanumerics only) so "WorldDirector"
    // in a filename lines up with a card named "World Director".
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let personaBook = null;
    for (const { owner, book } of charBooksUnbound) {
        const card = characters.find((c) => norm(c.displayName) === norm(owner));
        if (card) {
            card.lorebook = book;
        } else if (!personaBook) {
            personaBook = book; // first non-card lorebook is the protagonist book
        } else {
            warnings.push(`Lorebook "${book.name}" did not match any character; left unbound (import a manifest to disambiguate).`);
        }
    }
    // Attach character intimacy profiles and arc intimacy registers.
    for (const c of characters) {
        const im = Object.entries(intimacyByName).find(([k]) => k === norm(c.displayName));
        if (im) c.intimacy = im[1];
    }
    for (const a of arcBooks) {
        if (arcIntimacy[a.n]) a.intimacy = arcIntimacy[a.n];
    }

    const persona = (personaText || personaBook)
        ? { name: personaBook ? personaBook.name.replace(/^[^-]*-/, '').replace(/_lorebook$/i, '') : 'Player', description: personaText || '', lorebook: personaBook }
        : null;

    const lowestArc = arcBooks.length ? Math.min(...arcBooks.map((a) => a.n)) : null;

    return {
        source: 'convention',
        schema_version: null,
        world: { id: 'world', name: 'Imported World', mode: 'arc', description: '' },
        defaults: { active_arc: lowestArc },
        characters, worldBooks, groupBooks,
        arcBooks: arcBooks.sort((a, b) => a.n - b.n),
        persona, preset, rpg,
        docs,
    };
}

/* ---------------------------------------------------------------- router */

async function init(router) {
    router.post('/inspect', upload.single('file'), async (req, res) => {
        try {
            if (!req.file || !req.file.buffer) {
                return res.status(400).json({ ok: false, error: 'No file uploaded (expected a .zip in field "file").' });
            }
            const warnings = [];
            let byName, dupes;
            try {
                ({ byName, dupes } = await readZip(req.file.buffer));
            } catch (zipErr) {
                return res.status(400).json({ ok: false, error: `Not a readable .zip file: ${zipErr.message}` });
            }
            for (const d of dupes) warnings.push(`Duplicate filename in zip (last one wins): ${d}`);

            if (!Object.keys(byName).length) {
                return res.status(400).json({ ok: false, error: 'Zip contained no usable files.' });
            }

            let plan;
            if (byName['world.manifest.json']) {
                let manifest = null;
                try {
                    manifest = JSON.parse(byName['world.manifest.json'].toString('utf-8'));
                } catch (e) {
                    return res.status(400).json({ ok: false, error: `world.manifest.json is not valid JSON: ${e.message}` });
                }
                plan = planFromManifest(byName, manifest, warnings);
            } else {
                warnings.push('No world.manifest.json found — classifying by filename convention. Ship a manifest for reliable results.');
                plan = planFromConvention(byName, warnings);
            }

            plan.warnings = warnings;
            plan.ok = true;
            return res.json(plan);
        } catch (err) {
            console.error('[world-loader] /inspect failed', err);
            return res.status(500).json({ ok: false, error: String(err.message || err) });
        }
    });

    router.get('/', (_req, res) => res.json({ ...info, schema_major: SCHEMA_MAJOR }));

    console.log('[world-loader] plugin initialized');
}

module.exports = { info, init };
