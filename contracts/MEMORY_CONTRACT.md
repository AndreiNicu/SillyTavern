# NPC Memory Contract

**Status:** Draft · **Schema version:** 1 · **Last updated:** 2026-06-18

> **Shared contract — canonical source of truth:**
> [`AndreiNicu/World-Forge`](https://github.com/AndreiNicu/World-Forge) → `contracts/MEMORY_CONTRACT.md`.
> Copies in other repositories (including the SillyTavern fork) are mirrored
> **read-only**. Do not edit a copy — edit the canonical file, then run the
> contract sync (`scripts/sync-contracts.sh`). A CI drift check keeps every copy
> byte-identical to this canonical version.

This document is the shared contract between two independently-developed parts:

| Side | Role | Repo |
| --- | --- | --- |
| **Producer** | Emits structured world data into lorebooks and per-message tags | [World-Forge](https://github.com/AndreiNicu/World-Forge) |
| **Consumer** | Reads that data to build NPC-aware memory & compression | `npc-memory` SillyTavern extension (this repo) |

The goal is to let each side be built and shipped independently. The consumer
**must** function with today's exports (no producer changes) by falling back to
prose parsing; every structured field below is an *enhancement* that removes a
specific piece of guesswork. Nothing here is mandatory for a chat to work.

---

## 1. Versioning

- The contract is versioned by a single integer `schema` field, starting at `1`.
- The consumer reads `schema` first. If it is **greater** than the version it
  understands, it consumes the fields it recognizes and ignores the rest (forward
  compatible). If **lower**, it applies the documented migration for that version.
- Producers MUST set `schema` on every manifest. Whoever emits a turn tag
  (consumer-injected, model, or producer-baked — §7) MUST set its `v`.
- Unknown fields MUST be ignored, never error. Do not repurpose field names across
  versions; add new names instead.

---

## 2. Data channels

Two channels carry structured data. Both are optional and independently adoptable.

| Channel | Carries | Lifetime | Section |
| --- | --- | --- | --- |
| **Manifest entry** | Static world structure: NPC roster, ids, aliases, facets, relationships, scenes, persona | Per lorebook, set at export time | §3 |
| **Turn tag** | Per-message ground truth: who acted, with whom, where, which scene | One per generated message | §7 |

The manifest answers *"who exists and how are they identified."* The turn tag
answers *"who just did what, right now."*

---

## 3. The manifest entry

### 3.1 Carrier

The manifest is a normal World Info entry embedded in the NPC lorebook (and,
optionally, the Arc lorebook for scenes). It is identified by **both** of:

- `comment` begins with the marker token `[[NPC_MANIFEST]]`
- `disable: true`

`disable: true` keeps the entry out of every prompt while leaving it fully
present in the loaded world-info data, where the consumer reads it directly. The
entry's `key` SHOULD be `[]` and `constant` SHOULD be `false` (it never needs to
activate).

> The consumer locates the manifest by scanning loaded world-info entries for the
> `[[NPC_MANIFEST]]` comment marker. There may be at most one manifest per
> lorebook; if multiple are present, the consumer uses the first and logs a warning.

### 3.2 Payload

The entry's `content` is a single JSON object (UTF-8, no surrounding prose):

```jsonc
{
  "schema": 1,

  // Optional. Identifies the lorebook this manifest describes.
  "lorebook": { "name": "Compliance NPC Lorebook", "kind": "npc" },
  //   kind ∈ "npc" | "arc" | "world" | "group" | "director"

  // The player character(s). Used to classify "with user" vs "alone" (§6).
  "personas": {
    "user": { "name": "Andrei", "aliases": ["Andrei", "Andrei Petrov", "{{user}}"] }
  },

  // The NPC roster. One object per distinct NPC (NOT per facet).
  "npcs": [
    {
      "id": "anna_larsson",                 // stable, lowercase slug — see §4
      "displayName": "Anna Larsson",
      "aliases": ["Anna", "Anna Larsson", "Anna L."],
      "facets": {                            // facet type -> source entry uid (§5)
        "physical": 11,
        "psychological": 12,
        "standingGoal": 17
      },
      "relationships": [                     // directed, NPC -> target (§8)
        { "to": "katherine_carr", "kind": "rival", "note": "old grudge" }
      ],
      "tags": ["student"]                    // optional free-form labels
    }
  ],

  // Optional scene registry. Lives in the Arc lorebook manifest, or here.
  "scenes": [
    {
      "id": "arc1_beat1",                    // stable scene id — see §4
      "uid": 6,                              // source BEAT entry uid
      "arc": "Arc1",
      "seq": 1,                              // ordering within the arc
      "title": "Anna Arrives at the Penthouse"
    }
  ]
}
```

### 3.3 Field reference

| Path | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema` | int | yes | Contract version of this payload. |
| `lorebook.name` | string | no | Human label for diagnostics. |
| `lorebook.kind` | enum | no | Lorebook role; see values above. |
| `personas.user.name` | string | rec. | Canonical player display name. |
| `personas.user.aliases` | string[] | rec. | All ways the player is named in narration. |
| `npcs[].id` | string | yes | Stable NPC id (§4). Primary memory key. |
| `npcs[].displayName` | string | yes | Name shown to the model in memory lines. |
| `npcs[].aliases` | string[] | rec. | Union of all names/nicknames; matcher for narration. |
| `npcs[].facets` | object | no | Map of facet type → source entry `uid` (§5). |
| `npcs[].relationships` | array | no | Seed relationship graph (§8). |
| `npcs[].tags` | string[] | no | Optional labels (role, faction, …). |
| `scenes[].id` | string | rec.\* | Stable scene id (§4). \*required if `scenes` present. |
| `scenes[].uid` | int | no | Source BEAT entry uid, for activation mapping. |
| `scenes[].arc` | string | no | Arc grouping label. |
| `scenes[].seq` | int | rec. | Order of the scene within its arc. |
| `scenes[].title` | string | no | Human label for checkpoints. |

---

## 4. Identifier stability rules

Identifiers are the contract's load-bearing element: stored memory is keyed by
them, so they must outlive re-exports.

- **`npcs[].id`** is a stable slug derived once from the NPC's canonical name
  (e.g. `Anna Larsson` → `anna_larsson`: lowercase, non-alphanumerics → `_`,
  collapse repeats, trim). Once assigned it MUST NOT change across re-exports,
  even if the display name is lightly edited. If the producer can persist ids
  across runs, it SHOULD; if it can only derive them, it MUST use the slug rule
  above so the consumer derives the same id from the same name.
- **`scenes[].id`** is stable per scene (recommended form `<arc>_<beat-slug>` or
  `<arc>_beat<seq>`). It MUST NOT be reused for a different scene.
- **`uid`** is explicitly **not** an identity. It is a within-lorebook pointer
  that may be renumbered on re-export. It is only used to map a freshly-activated
  World Info entry back to an NPC/scene during a session. Memory is never keyed by
  `uid`.

---

## 5. Facet vocabulary

NPCs may be authored as a single entry or split across multiple facet entries
(both forms exist in current exports). The `facets` map names each facet type and
points at its source `uid`. Reserved facet keys:

| Key | Nature | Consumer use |
| --- | --- | --- |
| `physical` | durable identity | seed, never overwrite from chat |
| `psychological` | durable identity | seed, never overwrite from chat |
| `standingGoal` | durable-ish | seed; may drift, track lightly |
| `relationship` | durable identity | feeds the relationship graph (§8) |
| `combined` | durable identity | a single entry covering physical+psych |
| `volatile` | mutable state | the consumer's memory is authoritative; do not seed over it |

- Producers MAY emit additional facet keys; the consumer treats any unrecognized
  key as `volatile` unless told otherwise.
- The distinction matters because **durable** facets are read once to warm-start an
  NPC's memory, while **volatile** state is owned by the running memory system and
  must not be clobbered by a re-export.

---

## 6. Persona / "with user" classification

The consumer classifies each captured event as `withUser: true | false`.

- Authoritative source: the **turn tag** `withUser` field (§7) when present. This
  is POV-independent — the model states participation directly.
- Fallback (POV-independent inference): an event is `withUser: true` if any
  `personas.user.aliases` token appears in the message text **or** the message
  addresses the player in the second person (`you`, `your`, …). This catches
  both *"taps Andrei on the shoulder"* and *"taps you on the shoulder"*.
- Actor inference is likewise POV/topology-independent: actors are the speaker
  when it is a known NPC, otherwise the NPCs mentioned in the prose (so a
  narrator/Director card that voices several NPCs still attributes correctly).
- If no manifest persona is available, the consumer falls back to the active
  SillyTavern persona name.

These map directly to the per-NPC `lastWithUser` / `lastAlone` memory slots.

---

## 7. Turn tag (the per-message machine tag)

A hidden, machine-readable tag appended as the last line of a generated message,
giving the consumer ground truth (who acted, whether {{user}} was involved, the
current scene) instead of alias inference.

**This lever is consumer-owned.** The consumer drives the whole loop and does not
depend on the producer:

1. The consumer **injects the emit-instruction** into the prompt (it already
   injects per-NPC memory, and it holds the manifest `id`s and current scene
   candidates). The instruction tells the model to end its message with a
   `npcmem` tag using that authoritative `id` vocabulary.
2. The **model** fills in the one thing the consumer cannot reliably derive: the
   per-turn judgment of who *acted* (vs. was merely present) and whether {{user}}
   participated.
3. The consumer **parses, strips, and stores** the result (§7.3), and
   **synthesizes a fallback tag** (marked `"src":"inferred"`) when none is present.

Because the consumer injects the instruction, the lever works on **any** card.
A producer (e.g. World-Forge) MAY additionally bake tag emission into its cards
as redundancy, but this is **optional** and not required for the lever to function.
Producer-baked and consumer-injected tags share the identical format below.

> Note: do not let the consumer author the tag *content* from its own alias
> inference and then read it back as authoritative — that is circular and adds no
> information. Consumer-authored tags are only the explicit `inferred` fallback.

### 7.1 Format

A single-line HTML comment, placed as the **last line** of the message:

```
<!--npcmem:{"v":1,"actors":["anna_larsson"],"withUser":true,"scene":"arc1_beat3","location":"penthouse"}-->
```

- Prefix is exactly `<!--npcmem:` and the closing is exactly `-->`.
- Between them is a single-line JSON object. No line breaks inside the tag.
- Exactly **one** tag per message, on its own final line.
- User/persona messages carry no tag (the consumer infers the player acted).

### 7.2 Payload fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `v` | int | yes | Tag schema version (tracks this contract's `schema`). |
| `actors` | string[] | yes | NPC `id`s who *acted* this turn (not merely present). |
| `present` | string[] | no | NPC `id`s in scene but not acting. Defaults to `actors`. |
| `withUser` | bool | rec. | Whether {{user}} participated this turn. |
| `scene` | string | no | Current `scenes[].id`. Drives scene-boundary detection (§9). |
| `location` | string | no | Free-form locale label, stored on the event. |
| `src` | string | no | Tag origin: `model` (emitted per the injected instruction), `card` (producer-baked), or `inferred` (consumer fallback). Absent ⇒ treat as `model`. |

`actors`/`present` MUST use manifest `id`s. If an id cannot be resolved, a
`displayName` string MAY be emitted instead; the consumer resolves it via aliases
and logs if unmatched. The consumer treats `inferred`-source tags as
lower-confidence: a later `model`/`card` tag for the same message supersedes them.

### 7.3 Consumer handling

1. **Parse** the tag from the raw message on receipt
   (regex: `<!--npcmem:(\{.*?\})-->` , last match wins).
2. **Strip** it before the message enters the model context, so it never pollutes
   future prompts. The consumer owns a SillyTavern regex/interceptor rule for this;
   the producer does not need to manage stripping.
3. **Record** `actors`, `withUser`, `scene`, `location` as the authoritative event
   metadata, overriding any alias-based inference for that message.
4. If the tag is **absent or malformed**, run §5/§6 inference and **synthesize**
   a tag from the result tagged `"src":"inferred"`, so downstream storage is
   uniform. A malformed tag is logged and treated as absent — never fatal.

### 7.4 Display

The tag is an HTML comment and does not render in the chat UI. The consumer's
strip rule additionally removes it from stored/exported message text once parsed,
to keep transcripts clean. (Configurable: strip-on-parse vs. keep-for-audit.)

---

## 8. Relationship graph

- Seeded from `npcs[].relationships` and/or from facet entries whose facet type is
  `relationship`.
- Each edge is directed: it belongs to the NPC that owns the entry and points `to`
  another NPC `id`.
- `kind` is a free-form short label (`rival`, `parent`, `ally`, …); `note` is
  optional prose context.
- The graph is a **seed only**. Once a chat is running, the consumer's observed
  interactions are authoritative; a re-export refreshes only edges the consumer has
  not modified.
- When two related NPCs are co-present in a scene, the consumer MAY surface the
  relationship to color the injected memory line.

---

## 9. Scene boundaries & compression

- The consumer detects the active scene from, in priority order: the turn tag
  `scene` field (§7), else the activated `BEAT —` World Info entry mapped through
  `scenes[].uid`, else `null`.
- A **scene boundary** is observed when the active scene id changes between turns,
  or when the Arc lorebook group is swapped (a coarse boundary).
- On a boundary the consumer builds a structured checkpoint of the closed scene
  (labeled with `scenes[].title`) and may compress prior raw turns out of context.
  Scene ids let checkpoints be labeled and de-duplicated reliably.

This section is informative for the producer; it constrains only that scene ids be
stable (§4) and, if the turn tag is used, that `scene` reflect the current scene.

---

## 10. Fallback behavior (no producer changes)

If neither channel is present, the consumer degrades to prose parsing of existing
exports, with these conventions observed in current World-Forge output:

- **NPC entries**: `comment` matches `^NPC\s*—\s*(.+)$`. The NPC name is the capture
  with any trailing ` (facet…)` parenthetical removed. Strip only the *leading*
  `NPC — ` so em-dashes inside the facet (e.g. `(Relationship to Jake — Father)`)
  are preserved.
- **Facet type** is inferred from the parenthetical text (e.g. `Physical Description`
  → `physical`), defaulting to `volatile` when unrecognized.
- **NPC id** is derived from the parsed name via the §4 slug rule, so a later
  manifest using the same slug aligns with already-stored memory.
- **Aliases** are the union of `key[]` across all of an NPC's facet entries.
- **Relationships** are harvested from `(Relationship to X)` facet entries.
- **Scenes** are inferred from `BEAT —` entries in Arc lorebooks; ids derived as
  `<arc>_beat<n>` by activation order.
- **Participants / withUser** fall back to §6 alias inference.

Adopting any structured field replaces the corresponding fallback with no other
changes required.

---

## 11. Worked examples

### 11.1 Single-entry NPC (WorldDirector-style export)

Source entry:

```jsonc
{ "uid": 1, "comment": "NPC — Mr. Black",
  "key": ["Mr. Black", "Black", "the tall one", "Andrei's right hand"], "content": "…" }
```

Manifest record:

```jsonc
{ "id": "mr_black", "displayName": "Mr. Black",
  "aliases": ["Mr. Black", "Black", "the tall one", "Andrei's right hand"],
  "facets": { "combined": 1 } }
```

### 11.2 Facet-decomposed NPC (Compliance NPC lorebook-style export)

Source entries:

```
uid 11  NPC — Anna Larsson (Physical Description)
uid 12  NPC — Anna Larsson (Psychological Core)
uid 17  NPC — Anna Larsson (Standing Goal)
uid 31  NPC — Anna Larsson (Relationship to Katherine Carr)
```

Manifest record:

```jsonc
{ "id": "anna_larsson", "displayName": "Anna Larsson",
  "aliases": ["Anna", "Anna Larsson"],
  "facets": { "physical": 11, "psychological": 12, "standingGoal": 17, "relationship": 31 },
  "relationships": [ { "to": "katherine_carr", "kind": "rival" } ] }
```

### 11.3 A generated message with a turn tag

```
Anna lingers by the elevator, pretending not to watch the door.
"You're late," she says, not turning around.
<!--npcmem:{"v":1,"actors":["anna_larsson"],"withUser":true,"scene":"arc1_beat1","location":"penthouse"}-->
```

Consumer result: records an event for `anna_larsson`, `withUser:true`, scene
`arc1_beat1`, location `penthouse`; strips the tag from context; updates Anna's
`lastWithUser` slot.

---

## 12. Reserved / future

- `schema` 2+ may add: faction/group objects, per-NPC memory seeding hints,
  multi-persona support, and explicit arc-transition events.
- Reserved tag fields (do not reuse for other meaning): `mood`, `items`, `time`.
- Producers should namespace any experimental fields under `x_` (e.g. `x_mood`) so
  they are guaranteed ignorable.

---

## 13. Conformance checklist

**Producer (World-Forge)**

- [ ] Emits one `[[NPC_MANIFEST]]` entry (`disable: true`, `key: []`) per NPC lorebook.
- [ ] `schema` set; every NPC has stable `id`, `displayName`, `aliases`.
- [ ] Facet maps point at correct `uid`s; durable vs. volatile facets typed.
- [ ] Persona block populated with player name + aliases.
- [ ] (If using scenes) scene registry with stable ids + `seq`.
- [ ] (Optional redundancy) cards MAY bake `npcmem` emission using manifest ids;
      not required — the turn tag is consumer-owned (§7).

**Consumer (npc-memory extension)**

- [ ] Reads manifest by marker; tolerates absence (full prose fallback).
- [ ] Ignores unknown fields and higher `schema`; never errors on bad data.
- [ ] Keys all stored memory by `id`, never `uid`.
- [ ] Injects the turn-tag emit-instruction (manifest ids + scene candidates).
- [ ] Parses + strips turn tags; synthesizes an `inferred` tag when absent.
- [ ] Derives the same slug ids in fallback as the manifest would, for alignment.
