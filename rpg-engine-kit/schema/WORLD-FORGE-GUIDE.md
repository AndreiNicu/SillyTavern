# World-Forge → RPG Engine: producer integration guide

**Audience:** the Claude instance working in the [World-Forge](https://github.com/AndreiNicu/World-Forge)
repo, adding the RPG side-pipeline.

**Your job:** emit RPG stat data that conforms to `world-forge-rpg.schema.json`. That's the entire
contract. This guide explains *what to produce, where to put it, and the rules that keep the two
projects from drifting.* You do **not** need to read the RPG engine's code — only honor the schema.

---

## The division of labour (read this first)

World-Forge and the RPG engine have a hard boundary:

| | World-Forge (you) | RPG engine (consumer) |
|---|---|---|
| **Owns** | *values* — HP, AC, armor, equipment, and **balance** (how hard each tier hits, what a tier-1 vs tier-5 monster is) | *execution* — rolling dice, subtracting armor, clamping HP, undo |
| **Authoring** | the human authors stats at world conception; you serialize them | generates **nothing**; it's a referee |

The single rule that makes this work: **you emit a dice formula (e.g. `"6d10"`); the engine rolls
it.** The formula is balance data (yours). The roll is execution (theirs). They never overlap.

Two consequences you must respect:
1. **Starting values only.** Everything you emit is the *initial* state. Once a game starts, the
   engine owns all mutation. Never emit "current HP" mid-game — there is no mid-game for you.
2. **No raw damage numbers in the combat path.** Damage severity is expressed as a *tier word*
   (`graze/light/medium/heavy/critical`) plus a per-entity dice table. You never write
   `"damage": 15` anywhere — the schema rejects it (`additionalProperties: false`).

---

## What to produce, and where it goes

Three document `kind`s. Each must include `kind` and `schema_version` (currently `"1.0.0"`).

### 1. `character_rpg_profile` — embedded in a character card
Goes **inside the V3 card** at `data.extensions.world_forge_rpg`. This sits right next to your
existing `data.extensions.world_forge` (`style_override`) — same namespace, new sibling key. The
RPG engine reads it to create that character's combat entity.

```jsonc
// inside SomeCharacter_Card.json
{
  "spec": "chara_card_v3",
  "data": {
    "name": "Ser Kael",
    "extensions": {
      "world_forge": { "style_override": "..." },   // your existing block
      "world_forge_rpg": {                            // NEW: the RPG profile
        "kind": "character_rpg_profile",
        "schema_version": "1.0.0",
        "world_id": "lucifer",
        "stats": { /* a statBlock — see below */ }
      }
    }
  }
}
```

### 2. `user_rpg_profile` — standalone file for the player
Personas (the `User.md` you already emit) have no rich extensions field, so the player's RPG stats
live in their own file, e.g. `Lucifer-User_RPG.json`. **By convention `stats.id` must be `"player"`**
so it maps onto the engine's player entity. For the Lucifer world, this file *is* Lucifer's stat
block — the human authored it at world conception; you serialize it.

### 3. `bestiary` — standalone monster library
One file per world, e.g. `Lucifer-Bestiary.json`. Read-only to the engine: on encounter it copies a
monster into the live game and discards the copy when slain — your library stays canonical. This is
where **world balance** lives (see "Tier balance" below).

---

## The `statBlock` (shared by all three kinds)

The only **required** parts are `id` and a `combat` block with `hp`/`maxhp`. Everything else is
optional context.

```jsonc
{
  "id": "ser_kael",            // REQUIRED. snake_case, [a-z0-9_]. Used as the entity key AND
                               //   as the attacker/target id the parser emits. Keep it stable.
  "display_name": "Ser Kael",  // shown in the narrator's injected sheet
  "level": 3,
  "abilities": { "str": 3, "dex": 1, "con": 3, "int": 0, "wis": 1, "cha": 1 }, // modifiers, not 3-18
  "combat": {
    "hp": 34, "maxhp": 34,     // REQUIRED
    "ac": 17,                  // avoidance (harder to hit)
    "armor_dr": 4,             // flat damage reduction subtracted from EVERY physical hit
    "conditions": "none",
    "default_attack_tier": "medium",
    "damage_tiers": {          // THIS entity's tier->dice. Overrides bestiary/global tables.
      "light": "1d8", "medium": "2d8", "heavy": "3d8+2", "critical": "5d8"
    },
    "tier_shift": { "slashing": -1 } // resistance/weakness by attack_type (see below)
  },
  "equipment": [ /* items */ ],
  "progression": { "xp": 900, "next_level_xp": 2700 }, // optional; ties to your arc model
  "tags": ["knight", "frontline"]
}
```

### Two defensive models (use either, both, or neither)
- **`armor_dr`** — flat soak. Subtracted from every physical hit. "Thick plate absorbs 4 per blow."
- **`tier_shift`** — categorical resistance/weakness. Per `attack_type`, shift the *incoming* tier
  before the roll. `{"slashing": -1}` = a `heavy` slash is resolved as `medium` (plate turns blades
  aside). Positive = vulnerability: `{"fire": 1}` makes a `medium` fire attack hit as `heavy`.

These stack and are both deterministic — exactly the kind of "armor matters" rule the engine can
enforce without ever asking the model for a number.

---

## Tier balance (the part that's genuinely yours)

You decide what each tier *means* per creature, via dice formulas. Dice use **droll** notation:
`NdM` or `NdM+K` or a bare integer (`"5"`). `2d6` = roll two six-sided dice, sum them (avg 7).

### Where tier tables can live (most specific wins)
The engine resolves the dice for an attack in this order:
1. the attacker's own `combat.damage_tiers`
2. the bestiary's `tier_tables["<tier>"]` ← **the canonical per-tier balance layer**
3. the bestiary's `global_damage_tiers`
4. the engine's demo fallback (only if you provide nothing)

So in a bestiary, define balance **once per tier** and only override on special monsters:

```jsonc
{
  "kind": "bestiary", "schema_version": "1.0.0", "world_id": "lucifer",
  "tier_tables": {
    "1": { "light": "1d6", "medium": "1d8",  "heavy": "2d6"  },
    "5": { "light": "3d8", "medium": "4d10", "heavy": "6d10" }
  },
  "monsters": [
    { "tier": 1, "stats": { "id": "goblin_raider", "combat": { "hp": 12, "maxhp": 12 } } },
    { "tier": 5, "boss": true,
      "stats": { "id": "bone_warden", "combat": { "hp": 120, "maxhp": 120, "armor_dr": 5,
                  "damage_tiers": { "critical": "8d12+10" } } } } // overrides only crit
  ]
}
```

### Balance guideline that protects against LLM mislabels
A small LLM classifies the tier from prose, and it will sometimes be one step off. The engine caps
and validates, but **you** make the residual errors harmless: keep **adjacent tiers for the same
creature close together.** A good shape (by average damage):

```
light ≈ ½·medium      heavy ≈ 1.5·medium      critical ≈ 2·medium
```

Big power gaps belong **between tier-1 and tier-5 creatures**, *not* between adjacent words for one
creature. Avoid e.g. `medium:2d6` next to `heavy:6d10` on the same monster — a single misclassified
"heavy" then becomes a kill. (The engine also caps any non-crit hit at ~35% of the target's maxhp as
a backstop, but don't rely on it — balance properly.)

---

## Equipment

Emit the **resolved** combat numbers in `combat` (so the engine stays a pure calculator), and
*also* record each item's contribution in `equipment[].combat_mods`. The mods aren't re-derived at
runtime today, but they let a future loot/`/equip` flow recompute when gear changes.

```jsonc
"equipment": [
  { "id": "heavy_plate", "name": "Heavy Plate", "slot": "body", "type": "armor",
    "combat_mods": { "armor_dr_bonus": 4, "ac_bonus": 5 } },
  { "id": "longsword", "name": "Longsword", "slot": "main_hand", "type": "weapon",
    "combat_mods": { "attack_tier": "medium", "attack_type": "slashing" } }
]
```
i.e. if Kael's `armor_dr` is `4`, that should equal the sum of his worn armor's `armor_dr_bonus`.

---

## Validate before you ship

The contract ships a validator. Run it in World-Forge CI against your generated files:

```bash
node rpg-engine-kit/schema/validate.cjs        # validates the bundled samples + negative tests
```

To validate **your own** output, point any draft-07 validator (e.g. `ajv`) at
`world-forge-rpg.schema.json`. The `samples/` directory has one valid instance of each kind to copy
from. Things the schema will reject (by design): a raw `damage` field, non-snake_case ids, unknown
tier names, monster `tier` outside 1–5, malformed dice strings.

---

## Versioning

`schema_version` is semver. If we change the contract incompatibly, the major version bumps and the
engine refuses mismatched documents rather than guessing. Stamp every document with the version you
authored against (`"1.0.0"` today).

---

## Checklist for the World-Forge RPG pipeline

- [ ] Character cards get `data.extensions.world_forge_rpg` (a `character_rpg_profile`).
- [ ] A standalone `*_User_RPG.json` (`user_rpg_profile`, `stats.id` = `"player"`).
- [ ] A standalone `*_Bestiary.json` (`bestiary`) with `tier_tables` for the tiers you use.
- [ ] Every `stats.id` is stable, snake_case, and unique within its scope.
- [ ] `combat` carries resolved `hp/maxhp` (+ `ac`/`armor_dr` as needed); equipment recorded.
- [ ] Adjacent tiers per creature are close; tier-to-tier power lives across tiers.
- [ ] No raw damage numbers anywhere; dice tables only.
- [ ] All files validate against the schema; `schema_version` stamped.
