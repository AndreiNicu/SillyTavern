#!/usr/bin/env node
/**
 * Validates the World-Forge RPG sample profiles against the schema, plus a set
 * of negative cases that MUST be rejected. Run from anywhere; resolves ajv from
 * the nearest node_modules (SillyTavern root or tests/ both ship ajv@6 / draft-07).
 *
 *   node rpg-engine-kit/schema/validate.cjs
 *
 * Both repos (World-Forge producer, RPG engine consumer) should run this in CI
 * so the interface contract can't drift silently.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });
const base = __dirname;

const schema = JSON.parse(fs.readFileSync(path.join(base, 'world-forge-rpg.schema.json'), 'utf8'));
let validate;
try {
    validate = ajv.compile(schema);
} catch (e) {
    console.error('SCHEMA COMPILE FAILED:', e.message);
    process.exit(1);
}
console.log('Schema compiled OK (valid draft-07).');

let fail = 0;

const samples = [
    'samples/character.world_forge_rpg.json',
    'samples/user.world_forge_rpg.json',
    'samples/bestiary.world_forge_rpg.json',
];
for (const s of samples) {
    const data = JSON.parse(fs.readFileSync(path.join(base, s), 'utf8'));
    const ok = validate(data);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}`);
    if (!ok) {
        fail++;
        console.log('   ', JSON.stringify(validate.errors, null, 2));
    }
}

// Negative tests: the contract's guarantees. These MUST all be rejected.
console.log('\n-- negative tests (should all be REJECTED) --');
const neg = [
    ['raw damage number leaks', { kind: 'character_rpg_profile', schema_version: '1.0.0', stats: { id: 'x', combat: { hp: 10, maxhp: 10, damage: 15 } } }],
    ['bad id casing', { kind: 'user_rpg_profile', schema_version: '1.0.0', stats: { id: 'Player One', combat: { hp: 10, maxhp: 10 } } }],
    ['bad tier name', { kind: 'bestiary', schema_version: '1.0.0', monsters: [{ tier: 2, stats: { id: 'm', combat: { hp: 5, maxhp: 5, default_attack_tier: 'massive' } } }] }],
    ['tier out of range', { kind: 'bestiary', schema_version: '1.0.0', monsters: [{ tier: 9, stats: { id: 'm', combat: { hp: 5, maxhp: 5 } } }] }],
    ['bad dice formula', { kind: 'user_rpg_profile', schema_version: '1.0.0', stats: { id: 'player', combat: { hp: 10, maxhp: 10, damage_tiers: { heavy: 'lots' } } } }],
];
for (const [label, data] of neg) {
    const ok = validate(data);
    console.log(`${ok ? 'LEAK!' : 'rejected'}  ${label}`);
    if (ok) fail++;
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
