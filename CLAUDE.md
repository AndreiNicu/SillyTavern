# Repository guidance

This is a fork of SillyTavern that ships two first-party extensions tightly
coupled to the [World-Forge](https://github.com/AndreiNicu/World-Forge)
world-building pipeline:

- `public/scripts/extensions/world-forge/` — Scene Tracker, Key Moments, Style Override
- `public/scripts/extensions/npc-memory/` — NPC-aware memory & compression

These extensions are **consumers** of World-Forge's output; World-Forge is the
**producer**. They evolve together under a shared, versioned contract.

## Always consider the other side of the contract

Before changing anything at the integration surface — the export shape,
`[[NPC_MANIFEST]]` fields, the `npcmem` turn tag, the Director-card tag, NPC
ids/aliases, the scene roster, or the `</style_contract>` marker — **read the
shared contracts first** (mirrored read-only at the repo root):

- `contracts/MEMORY_CONTRACT.md` — the npc-memory data channel (manifest, facets, ids, turn tag, scenes, prose fallback).
- `contracts/WORLD_FORGE_SYNC.md` — the runtime seams (Director tag, alias coverage, `</style_contract>` marker) + producer conformance checklist.

If those expectations change, it is a **contract change**:

1. Edit the **canonical** copy in the **World-Forge** repo (`contracts/` there) — never the mirror here.
2. Re-sync the mirror: `scripts/sync-contracts.sh` (`--check` is what CI runs).
3. Bump the contract `schema`/version and keep a graceful fallback so worlds/exports that haven't adopted the change still work.

The `contracts/` mirror is read-only; the `contracts-drift` CI check fails if it
is hand-edited instead of synced from canonical. See the `CLAUDE.md` in each
extension directory for consumer-specific detail.
