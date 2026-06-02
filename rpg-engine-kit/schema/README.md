# World-Forge RPG — interface contract

`world-forge-rpg.schema.json` is the **shared contract** between two repos:

- **Producer:** [World-Forge](https://github.com/AndreiNicu/World-Forge) — its RPG side pipeline
  emits stat data conforming to this schema.
- **Consumer:** the SillyTavern RPG engine (`rpg-engine-kit/`) — reads that data to seed the
  authoritative game state (`active.json`).

Because two independent Claude instances edit the two repos, this file is the seam where they
agree. Both repos should run `validate.cjs` in CI so the contract can't drift silently.

> **Working in the World-Forge repo?** Start with **[`WORLD-FORGE-GUIDE.md`](./WORLD-FORGE-GUIDE.md)** —
> a producer-focused walkthrough of what to emit, where it goes, and the balance rules. This file
> below is the reference; the guide is the onboarding.

## The one rule that matters

**Numbers in this schema are STARTING values only.** Once a game begins, the engine owns all
mutation; live/per-turn state never travels in these documents. And the LLM never emits raw
damage — only a `damage_tier` enum. The schema enforces this: profile objects are
`additionalProperties: false`, so a stray `"damage": 15` is rejected at validation time.

## Three document kinds (discriminated by `kind`)

| `kind` | Where it lives | Seeds |
|--------|----------------|-------|
| `character_rpg_profile` | Inside a V3 card at `data.extensions.world_forge_rpg` | a character entity |
| `user_rpg_profile` | Standalone file (personas have no rich extensions field) | the `player` entity |
| `bestiary` | Standalone file, **read-only** | monster templates, copied on spawn |

`data.extensions.world_forge_rpg` mirrors World-Forge's existing `data.extensions.world_forge`
(`style_override`) convention — same namespace, new sibling key.

## Key design choices (the "why")

- **`schema_version`** is semver; the engine checks major-version compatibility on import and
  refuses mismatches rather than guessing.
- **Per-entity `damage_tiers`** — each entity calibrates its own tier→dice table, so a tier-5
  boss's `heavy` (`6d10`) genuinely outclasses a tier-1's `heavy`. A global table
  (`bestiary.global_damage_tiers`, or the engine's `rules.json`) is the fallback.
- **Resolved `combat` profile** — World-Forge computes `armor_dr`/`ac`/tiers from base stats +
  equipment and emits the **resolved** numbers, so the engine stays a pure calculator.
  `equipment[].combat_mods` documents each item's contribution for a future loot/`/equip` flow.
- **`tier_shift`** — a server-deterministic resistance/weakness model: per `attack_type`, shift
  the incoming tier by N steps (`{"slashing": -1}` = plate downgrades slashes). Keeps "armor
  matters" expressible without handing numeric authority to the model.
- **`armor_dr` vs `ac`** — `armor_dr` is flat damage reduction per hit (the "thick armor"
  model); `ac` is avoidance (harder to hit). Both are supported; use either or both.

## Bestiary lifecycle

The bestiary is a library. On spawn the engine **copies** a monster's stat block into
`active.json` as a combat instance (multiple copies get distinct instance ids like
`goblin_raider#2`), mutates the copy per turn, and discards it on defeat — the library stays
intact. This is the "compose monster → fight → vanquish → file removed, master intact" flow.

## Reliability — keeping the LLM from mislabelling

The one fallible step is the parser LLM choosing a `damage_tier`. The math after it is
deterministic. We attack the risk on four fronts; the engine implements the deterministic ones,
and World-Forge should follow the balance guideline below.

**Constrain what it can say** — `damage_tier` is a closed enum under JSON-schema strict mode, so
only the six words are possible. For a stable parser, point the engine at a dedicated
low-temperature connection profile (classification wants determinism, not creativity).

**Make the decision easier** — the parser prompt carries a *rubric* (concrete narrative anchors
per tier: graze/light/medium/heavy/critical), is told "when unsure, choose the lower tier", is
handed the triggering combat keyword, and must return an `evidence` quote. Requiring evidence
both improves the choice and lets the engine corroborate it.

**Validate before trusting** (engine, deterministic):
- `target`/`attacker` are checked against `active.json`; an unknown target is rejected unless
  `rules.json.allow_auto_create` is on (demo only). This kills hallucinated combatants.
- the `evidence` quote must actually appear in the narration, or the apply is skipped.

**Contain the blast radius** (engine + balance):
- a **damage governor** (`rules.json.governor`) caps any single non-critical hit at a fraction
  of the target's `maxhp` (default 35%), so a misclassified `heavy` can't one-shot. `critical`
  is exempt by design.
- **Balance guideline for World-Forge:** keep *adjacent* tiers for the same entity close, so a
  one-step mislabel is survivable. Big jumps belong *between* tier-1 and tier-5 creatures, not
  between adjacent words for one creature. A reasonable shape is roughly:
  `light ≈ ½·medium`, `heavy ≈ 1.5·medium`, `critical ≈ 2·medium` (avg damage). Avoid e.g.
  `medium:2d6` next to `heavy:6d10` on the same creature — that turns a single misclassification
  into a kill.

## Tier-table resolution order

When the engine needs the dice for a (`tier`) on a given attacker, it uses the most specific
table available:

1. the attacker's own `combat.damage_tiers`
2. the bestiary's `tier_tables[<attacker tier>]` (per-tier world balance)
3. the bestiary's `global_damage_tiers`
4. the engine's `rules.json.tiers` (demo fallback)

This lets World-Forge state "all tier-5 monsters hit like *this*" once via `tier_tables`, and
only override on a special boss via that monster's own `damage_tiers`.

## Samples & validation

`samples/` holds one valid instance of each kind (the knight `ser_kael` shows `armor_dr 4` +
`tier_shift slashing:-1`; the bestiary shows tier 1/3/5 with escalating tier tables).

```
node rpg-engine-kit/schema/validate.cjs
```

Validates all samples and runs negative tests (raw-number leak, bad id casing, bad tier name,
out-of-range tier, malformed dice) that must all be rejected.
