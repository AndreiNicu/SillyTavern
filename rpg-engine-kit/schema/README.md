# World-Forge RPG — interface contract

`world-forge-rpg.schema.json` is the **shared contract** between two repos:

- **Producer:** [World-Forge](https://github.com/AndreiNicu/World-Forge) — its RPG side pipeline
  emits stat data conforming to this schema.
- **Consumer:** the SillyTavern RPG engine (`rpg-engine-kit/`) — reads that data to seed the
  authoritative game state (`active.json`).

Because two independent Claude instances edit the two repos, this file is the seam where they
agree. Both repos should run `validate.cjs` in CI so the contract can't drift silently.

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

## Samples & validation

`samples/` holds one valid instance of each kind (the knight `ser_kael` shows `armor_dr 4` +
`tier_shift slashing:-1`; the bestiary shows tier 1/3/5 with escalating tier tables).

```
node rpg-engine-kit/schema/validate.cjs
```

Validates all samples and runs negative tests (raw-number leak, bad id casing, bad tier name,
out-of-range tier, malformed dice) that must all be rejected.
