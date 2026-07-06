# Shared contracts (mirror)

This directory holds the **shared design contracts** between the
[World-Forge](https://github.com/AndreiNicu/World-Forge) pipeline and the
`world-forge` + `npc-memory` extensions in this fork.

| File | Covers |
| --- | --- |
| [`MEMORY_CONTRACT.md`](./MEMORY_CONTRACT.md) | The npc-memory data channel: `[[NPC_MANIFEST]]`, facets, stable ids, the `npcmem` turn tag, scenes registry, prose fallback. |
| [`WORLD_FORGE_SYNC.md`](./WORLD_FORGE_SYNC.md) | The runtime seams: Director-card tag, narration-surface alias coverage, the `</style_contract>` marker, `style_override` runtime, plus a producer conformance checklist. |
| [`DICE_ORACLE.md`](./DICE_ORACLE.md) | The dice oracle channel: the `[[DICE_TABLES]]` carrier entry, roll-table payload (pools, procedures, conditional steps), and the Scene Tracker's authoritative-facts injection. |

## Canonical vs. mirror

The **canonical source of truth lives in World-Forge** (`contracts/` there), next
to `tools/validate_export.py`, the producer that must conform to these contracts.

The copies in *this* directory are **mirrored read-only**. Never hand-edit them —
they are kept byte-identical to canonical:

```bash
# refresh the mirror from World-Forge
scripts/sync-contracts.sh

# verify the mirror is in sync (what CI runs)
scripts/sync-contracts.sh --check
```

`.github/workflows/contracts-drift.yml` runs the `--check` mode on every PR that
touches `contracts/`, so a hand-edit or a stale mirror fails CI. While the
canonical `contracts/` directory hasn't been published in World-Forge yet, the
check treats "canonical unreachable" as a skip (not a failure); it starts
enforcing once the World-Forge side lands.

To point the sync at a branch or fork while iterating:

```bash
WF_REF=some-branch scripts/sync-contracts.sh --check
```
