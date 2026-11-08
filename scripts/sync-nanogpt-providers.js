#!/usr/bin/env node
//
// Sync the hardcoded NANOGPT_PROVIDERS list in public/scripts/textgen-models.js
// with NanoGPT's live providers endpoint.
//
// The NanoGPT provider dropdown is built only from that array: per-model
// availability (/api/nanogpt/models/providers) disables entries in it but never
// adds missing ones, so providers NanoGPT adds stay unselectable until the
// array is refreshed. Upstream SillyTavern may lag behind, so re-run this after
// merging upstream if the array conflicts.
//
// Usage:
//   node scripts/sync-nanogpt-providers.js                 Fetch live list, rewrite the array
//   node scripts/sync-nanogpt-providers.js --check         Exit 1 if the array is out of date (never writes)
//   node scripts/sync-nanogpt-providers.js --file p.json   Use a saved copy of the endpoint response
//
// Env overrides:
//   NANOGPT_PROVIDERS_URL   default: https://nano-gpt.com/api/models/providers

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.NANOGPT_PROVIDERS_URL || 'https://nano-gpt.com/api/models/providers';
const TARGET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/scripts/textgen-models.js');
const MARKER = 'const NANOGPT_PROVIDERS = [';
// Sanity floor: refuse to overwrite the list with an obviously broken response.
const MIN_PROVIDERS = 20;

const args = process.argv.slice(2);
const check = args.includes('--check');
const fileIndex = args.indexOf('--file');
const file = fileIndex >= 0 ? args[fileIndex + 1] : null;

async function loadLive() {
    let data;
    if (file) {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
        const response = await fetch(ENDPOINT, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) {
            throw new Error(`GET ${ENDPOINT} failed: ${response.status} ${response.statusText}`);
        }
        data = await response.json();
    }

    const providers = Array.isArray(data?.providers) ? data.providers : null;
    if (!providers || providers.length < MIN_PROVIDERS) {
        throw new Error(`Unexpected providers response (${providers?.length ?? 'no'} entries)`);
    }
    for (const p of providers) {
        if (typeof p?.id !== 'string' || !p.id || typeof p?.label !== 'string' || !p.label) {
            throw new Error(`Malformed provider entry: ${JSON.stringify(p)}`);
        }
    }
    return providers;
}

/** @param {string} s */
const quote = s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;

function render(providers) {
    return providers
        .map(p => `    {\n        'id': ${quote(p.id)},\n        'label': ${quote(p.label)},\n    },`)
        .join('\n');
}

function currentIds(src, start, end) {
    return [...src.slice(start, end).matchAll(/'id': '((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
}

async function main() {
    const live = await loadLive();

    const raw = fs.readFileSync(TARGET, 'utf8');
    const crlf = raw.includes('\r\n');
    const src = raw.replace(/\r\n/g, '\n');

    const start = src.indexOf(MARKER);
    const end = start >= 0 ? src.indexOf('\n];', start) : -1;
    if (start < 0 || end < 0) {
        throw new Error(`Could not find "${MARKER} ... ];" in ${TARGET}`);
    }

    let next = src.slice(0, start) + MARKER + '\n' + render(live) + src.slice(end);
    if (crlf) {
        next = next.replace(/\n/g, '\r\n');
    }

    const before = new Set(currentIds(src, start, end));
    const after = new Set(live.map(p => p.id));
    const added = live.filter(p => !before.has(p.id)).map(p => p.id);
    const removed = [...before].filter(id => !after.has(id));

    if (next === raw) {
        console.log(`NANOGPT_PROVIDERS is up to date (${live.length} providers).`);
        return;
    }

    console.log(`${before.size} -> ${live.length} providers`);
    if (added.length) console.log(`  added:   ${added.join(', ')}`);
    if (removed.length) console.log(`  removed: ${removed.join(', ')}`);
    if (!added.length && !removed.length) console.log('  (labels or order changed)');

    if (check) {
        console.error('NANOGPT_PROVIDERS is out of date. Run: node scripts/sync-nanogpt-providers.js');
        process.exitCode = 1;
        return;
    }

    fs.writeFileSync(TARGET, next);
    console.log(`Updated ${path.relative(process.cwd(), TARGET)}`);
}

main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 2;
});
