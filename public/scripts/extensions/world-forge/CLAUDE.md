# Working in the `world-forge` extension

This extension (Scene Tracker, Key Moments, Style Override) is a **consumer** in a
shared, versioned contract with the
[World-Forge](https://github.com/AndreiNicu/World-Forge) pipeline — the
**producer** that generates the lorebooks/cards/preset it works alongside. It
depends on producer-side conventions: the Director-card tag (read via
`isDirectorCharacter`), narration-surface NPC names matching manifest aliases,
and the verbatim `</style_contract>` marker it splices `<style_override>` after.

## Before you change what this extension expects from World-Forge

If you are about to change **how this extension consumes producer data or
markers** — e.g. the `</style_contract>` splice, the `style_override` directives
schema, Director/NPC-host detection, or how the Scene Tracker reconciles names to
NPC ids — **read the shared contracts first** (mirrored read-only at the repo
root):

- `contracts/WORLD_FORGE_SYNC.md` — the runtime seams: Director-card tag (§2), alias coverage (§3), the `</style_contract>` marker (§4), `style_override` runtime.
- `contracts/MEMORY_CONTRACT.md` — the npc-memory data channel the Scene Tracker's roster feeds into (scene gating maps present names → stable ids).

## If those expectations actually change, it's a contract change

1. Edit the **canonical** copy in the **World-Forge** repo (`contracts/` there) — never the mirror here.
2. Re-sync the mirror in this fork: `scripts/sync-contracts.sh`.
3. Bump the contract version, and keep graceful degradation so worlds that haven't adopted the change still work (e.g. no Director tag ⇒ no host framing, not an error).
4. The producer side (World-Forge agents + `tools/validate_export.py`) is updated separately to emit/enforce the new requirement.

The `contracts/` mirror is **read-only**: a CI drift check (`contracts-drift`)
fails the build if it is hand-edited instead of synced from canonical.
