# Working in the `npc-memory` extension

This extension is a **consumer** in a shared, versioned contract with the
[World-Forge](https://github.com/AndreiNicu/World-Forge) pipeline — the
**producer** that generates the lorebooks/cards/preset this extension reads. It
consumes the `[[NPC_MANIFEST]]`, NPC ids/aliases/facets, the `npcmem` turn tag,
and the scenes registry, with a prose-parsing fallback.

## Before you change what this extension expects from World-Forge

If you are about to change **how this extension consumes producer data** — e.g.
manifest fields, the `npcmem` turn-tag format, id/alias resolution, facet
vocabulary, scene-boundary detection, or anything it assumes about export shape —
**read the shared contracts first** (mirrored read-only at the repo root):

- `contracts/MEMORY_CONTRACT.md` — the npc-memory data channel (manifest, facets, ids, turn tag, scenes, fallback).
- `contracts/WORLD_FORGE_SYNC.md` — the runtime seams (Director-card tag, alias coverage, the `</style_contract>` marker).

## If those expectations actually change, it's a contract change

1. Edit the **canonical** copy in the **World-Forge** repo (`contracts/` there) — never the mirror here.
2. Re-sync the mirror in this fork: `scripts/sync-contracts.sh`.
3. Bump the contract `schema`/version, and keep a **fallback** so existing exports (and producers that haven't adopted the change) still work — this consumer must never hard-error on old or unknown data (`MEMORY_CONTRACT.md` §1, §10).
4. The producer side (World-Forge agents + `tools/validate_export.py`) is updated separately to emit/enforce the new field.

The `contracts/` mirror is **read-only**: a CI drift check (`contracts-drift`)
fails the build if it is hand-edited instead of synced from canonical.
