# Shared contracts (mirror)

This directory holds the **shared design contracts** between the
[World-Forge](https://github.com/AndreiNicu/World-Forge) pipeline and the
`world-forge` + `npc-memory` extensions in this fork.

| File | Covers |
| --- | --- |
| [`MEMORY_CONTRACT.md`](./MEMORY_CONTRACT.md) | The npc-memory data channel: `[[NPC_MANIFEST]]`, facets, stable ids, the `npcmem` turn tag, scenes registry, prose fallback. |
| [`WORLD_FORGE_SYNC.md`](./WORLD_FORGE_SYNC.md) | The runtime seams: Director-card tag, narration-surface alias coverage, the `</style_contract>` marker, `style_override` runtime, plus a producer conformance checklist. |
| [`DICE_ORACLE.md`](./DICE_ORACLE.md) | The dice oracle channel: the `[[DICE_TABLES]]` carrier entry, roll-table payload (pools, procedures, conditional steps), and the Scene Tracker's authoritative-facts injection. |
| [`BODY_CYCLES.md`](./BODY_CYCLES.md) | Recurring body states: the `[[BODY_CYCLES]]` carrier, per-character cycle seed payload, and phase derivation from the Scene Tracker day counter. **v1 — consumer implemented here, producer not wired**, so it fires only on hand-authored carrier entries. |
| [`RPG_STATS.md`](./RPG_STATS.md) | The RPG character-state channel: the `[[RPG_STATS]]` carrier with the world's stat system, item catalog, starting sheets, and bestiary, keyed by npc-memory slug ids. **Draft (schema 0) — neither side built**; producers must not emit it yet. |
| [`OUTCOME_AUTHORITY.md`](./OUTCOME_AUTHORITY.md) | Who decides outcomes in a world with tracked state: what `{{user}}`'s message can and cannot change (pinned rolls on swipe, parse-error-only corrections, `downed` recovery, a pre-generation legality check). **Draft (version 0) — exploration only**: no carrier, nothing emitted or enforced. |
| [`RESOLUTION.md`](./RESOLUTION.md) | How attempts become outcomes: the core roll and outcome bands, the odds math and modifier stack, time and turn order, combat, dice grammar, and attempt parsing. **Placeholder (version 0) — no content yet**, to be authored from this fork's side (the canonical copy still lives in World-Forge). |

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
touches `contracts/`, so a hand-edit or a stale mirror fails CI. The canonical
`contracts/` directory is published, so the check is enforcing; it still treats
"canonical unreachable" as a skip rather than a failure, so a network blip does
not turn the build red on its own.

**Which files sync is discovered, not listed.** The script reads the canonical
`contracts/` directory listing from the GitHub API and mirrors every `*.md` there
except `README.md` (this README is per-repo and is not synced). A contract newly
added in World-Forge is therefore picked up by the next sync, and `--check`
reports it as drift until it is mirrored. If the listing can't be fetched, the
script warns and falls back to a built-in list. A mirror file with no canonical
counterpart (dropped or renamed upstream) is reported as a warning and never
deleted automatically. When a new contract lands, add a row for it to the table
above by hand.

Note that a **draft** contract is mirrored under the same rule as an established
one: byte-identical or CI fails. A draft's canonical copy may still change while
its consumer is being built, so a canonical edit means re-running the sync here
in the same change.

To point the sync at a branch or fork while iterating:

```bash
WF_REF=some-branch scripts/sync-contracts.sh --check
```
