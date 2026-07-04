# World-Forge ⇄ Extension Sync Contract

**Status:** Draft · **Version:** 2 · **Last updated:** 2026-06-30

> **Shared contract — canonical source of truth:**
> [`AndreiNicu/World-Forge`](https://github.com/AndreiNicu/World-Forge) → `contracts/WORLD_FORGE_SYNC.md`.
> Copies in other repositories (including the SillyTavern fork) are mirrored
> **read-only**. Do not edit a copy — edit the canonical file, then run the
> contract sync (`scripts/sync-contracts.sh`). A CI drift check keeps every copy
> byte-identical to this canonical version.

This document is the handshake between the World-Forge producer pipeline and the
**two** SillyTavern companion extensions that consume its output in this fork:

| Side | Component | Repo / path |
| --- | --- | --- |
| **Producer** | World-Forge agent pipeline (Architect, Compiler, Prompt Engineer) | [World-Forge](https://github.com/AndreiNicu/World-Forge) |
| **Consumer A** | `npc-memory` extension | `public/scripts/extensions/npc-memory/` |
| **Consumer B** | `world-forge` extension (Scene Tracker, Key Moments, Style Override) | `public/scripts/extensions/world-forge/` |

It is the companion to [`MEMORY_CONTRACT.md`](./MEMORY_CONTRACT.md),
which fully specifies the **npc-memory data channel** (manifest, facets, turn
tag). That contract is in good shape and already honored by the Compiler and
`tools/validate_export.py`. This document covers the *other* seams — the ones
that the `world-forge` extension and the group-chat router depend on, where the
producer's behavior is currently load-bearing but **not guaranteed by the
pipeline** (only the hand-built `Samples/` world happens to satisfy them).

Like the memory contract, every requirement here is designed so the consumers
**degrade gracefully** when the producer hasn't adopted it — but each adopted
item removes a specific, real desync. None of this is required for a chat to
run; all of it makes the two extensions cohere with a generated world instead of
only with the Sample.

---

## 1. Why these seams exist

`MEMORY_CONTRACT.md` governs structured *data inside lorebooks*. The seams below
are different in kind: they are **runtime conventions** that span character-card
metadata, SillyTavern tags, and the preset's assembled system prompt. They have
no JSON schema and no validator, so they drift silently.

Four of them (§2, §3, §4, §5) are concrete asks of the World-Forge agents. One
(§6) is a consumer-side improvement we plan to make on our end and only
*document* here so the producer knows the direction.

---

## 2. Director / NPC-host card MUST carry a recognized tag  *(highest impact)*

### 2.1 The dependency

Two independent runtime features classify the "Director" / NPC-host card **purely
by SillyTavern tag membership** — never by card name, manifest, or content:

- **Group-chat router** — `partitionByDirectorRole()` splits members into main
  cast vs. directors so off-roster NPC names get routed to the host card
  (`public/scripts/group-chats.js`).
- **Scene Tracker** — `resolveDirectorName()` → `isDirectorCharacter()` decides
  who voices the NPCs, which drives the injected `<scene_state>` framing lines
  ("You are X, the World Director: you narrate the scene and voice the NPCs")
  (`public/scripts/extensions/world-forge/index.js`).

The recognized tag set is (case/accent-insensitive, exact match):

```
director · npc · world-director · world director · npc-controller · npc controller
```
(`DIRECTOR_TAG_NAMES` in `public/scripts/group-chats.js`.)

### 2.2 The gap

The `Samples/` Director card ships tagged `world-director` + `npc-controller`,
but `agent_roles/02_The_Architect.md` and `04_The_Compiler.md` never **require**
this tag. A generated (non-Sample) world that uses a Director/NPC-host card will:

- mis-route in group chats (off-roster NPC requests have no host to land on), and
- get an incorrect "played by … the World Director" line in `<scene_state>`,
  because the Scene Tracker can't tell which member is the host.

### 2.3 The ask

- When the pipeline produces a Director / NPC-host card, the Architect/Compiler
  **MUST** add at least one tag from §2.1 to that card's V3 `tags` array, and
  the tag MUST survive export.
- This MUST agree with the manifest's `lorebook.kind: "director"` (the manifest
  already declares the role; the card tag is what the *runtime* reads).
- Prefer `world-director` and/or `npc-controller` for consistency with the Sample.

> Consumer behavior without it: no card is treated as a Director; group routing
> falls back to main-cast only and the Scene Tracker omits the host framing.
> Nothing errors — the world just behaves as if it has no NPC host.

---

## 3. `aliases` MUST cover every narration-surface name

### 3.1 The dependency

npc-memory's scene gating maps the Scene Tracker's roster onto stable memory ids.
The Scene Tracker stores `present[].name` as **free-form names extracted by a
small LLM from prose**; npc-memory then resolves each to an id via
`resolveNameToId()` — match against `displayName`/`aliases`, else slugify the raw
name (`public/scripts/extensions/npc-memory/turntag.js`).

### 3.2 The gap

If the scene LLM writes the bare first name (`"Anna"`) but the manifest only
lists `displayName: "Anna Larsson"` with `aliases: ["Anna Larsson"]`, the lookup
misses and slugifies to `anna` — a **different id** from `anna_larsson`. Memory
for that NPC silently splits in two. The Compiler does include first-name aliases
in practice, but it is not a stated invariant, so it can regress.

### 3.3 The ask

- `npcs[].aliases` **MUST** include every form the NPC is named in narration,
  explicitly including the **bare first name** and any nickname the prose uses.
- This is the same alias union that `MEMORY_CONTRACT.md` §3.3 / §10 already
  recommend — this section only raises "bare first name is present" from
  *recommended* to **required**, because the Scene Tracker round-trip depends on
  it, not just the turn-tag matcher.

> Consumer behavior without it: the NPC still works, but its scene-gated "now"
> memory may key to a slug that doesn't match its manifest id, so the durable
> record and the live record diverge.

---

## 4. The `</style_contract>` marker is a load-bearing literal

### 4.1 The dependency

The `world-forge` extension injects each card's per-card style override by
splicing a `<style_override>…</style_override>` block into the **assembled system
prompt immediately after the exact literal string** `</style_contract>`
(`spliceOverrideIntoChat()` / `injectStyleOverride()` in
`public/scripts/extensions/world-forge/index.js`). The Prompt Engineer emits the
world `<style_contract>…</style_contract>` block in the preset's Main Prompt.

### 4.2 The gap

The splice is a plain substring search for `</style_contract>`. If the Prompt
Engineer ever emits it with an attribute (`<style_contract v="2">`), different
casing, or a renamed tag, the override is dropped **with no error** — the debug
log says "no `</style_contract>` marker found" and the card's style silently
reverts to the world default.

### 4.3 The ask

- The closing marker MUST be emitted **verbatim** as `</style_contract>` — no
  attributes on the close tag, exact casing, on its own or at a line end inside a
  `system`-role message.
- Treat the literal as a pinned constant shared across both repos. If it ever
  must change, change it in `injectStyleOverride()` and the Prompt Engineer in
  the same release and bump this document's version.

> Consumer behavior without it: per-card `<style_override>` is never injected;
> the world-level `<style_contract>` still applies, so prose stays coherent but
> per-card overrides are lost.

---

## 5. World calendar (Scene Tracker date seed)

Optional, like every seam here; absent ⇒ the Scene Tracker's manual, per-chat
date behavior is unchanged and existing worlds are unaffected.

### 5.1 The dependency

The `world-forge` extension's **Scene Tracker** can track a full in-world date —
a weekday tied to a day counter, an anchored month/year that rolls over by real
month lengths, and a story horizon (`Day X of N` / open-ended). On a brand-new
chat it will **seed** all of that from a world-level `[[WORLD_CALENDAR]]` lorebook
entry if the world ships one (`readWorldCalendar()` / `maybeSeedCalendarFromWorld()`
in `public/scripts/extensions/world-forge/index.js`). Seeding touches only a
**pristine** scene record, so it never clobbers hand-set values; a missing or
malformed block is a silent no-op.

### 5.2 The carrier

One world-level World Info entry whose `comment` contains the marker token
`[[WORLD_CALENDAR]]` (mirroring `[[NPC_MANIFEST]]`); its `content` is a single
JSON object. At most one per world — if several are present, the first wins.

> **Carrier flag — differs from `[[NPC_MANIFEST]]`, and the difference is
> load-bearing.** The Scene Tracker reads candidate entries from
> `getSortedEntries()` and **rejects any with `disable: true`**
> (`.find(e => e && !e.disable && …)`). So unlike the memory manifest — which is
> emitted `disable: true` and read out of the raw world-info data — the calendar
> carrier MUST be **enabled** (`disable: false`). To keep an enabled entry inert
> (never injected into the prompt), give it `key: []` and `constant: false`: with
> no keys and not constant it never activates, yet it remains visible to
> `getSortedEntries()`. A `[[WORLD_CALENDAR]]` emitted `disable: true` is silently
> skipped and the world seeds nothing.

### 5.3 Payload

```jsonc
{
  "schema": 1,                        // consumer reads what it knows, ignores the rest
  "weekdayOfDay1": 2,                 // 0=Sun … 6=Sat; omit/null = no weekday
  "start": { "month": 5, "year": 1 }, // month 0–11 (5 = June). Day 1 = the 1st of this month/year
  "end":   { "month": 11, "year": 1 } // last day of this month/year = the conclusion
}
```

| Path | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema` | int | yes | Contract version of this payload (currently `1`). |
| `weekdayOfDay1` | int 0–6 | no | Weekday Day 1 falls on (0 = Sunday). **Independent of `start`**, so fictional calendars work. Omit/null ⇒ no weekday shown. |
| `start` | object | no | `{ "month": 0–11, "year": int }`. Day 1 = the 1st of this month/year; the current month/year then derive from the day counter. Absent/null ⇒ no calendar (free-form month label). |
| `end` | object \| null \| `"infinite"` | no | `{ "month": 0–11, "year": int }` whose last day is the conclusion. null / `"infinite"` / omitted ⇒ **open-ended** (days keep counting, no `of N`, no conclusion note). |

- `month` is **0-indexed** (0 = January … 11 = December), matching the consumer.
- The consumer is forward-compatible on `schema` and tolerant of absence/garbage:
  it reads the fields it recognizes and no-ops on anything malformed.

### 5.4 The ask

- When the world's brief fixes a **start date** plus either an **end date** or
  **open-ended**, the Architect/Compiler **SHOULD** emit one `[[WORLD_CALENDAR]]`
  entry in the **World (Tier 1) lorebook**, enabled-but-inert per §5.2, with the
  §5.3 payload. Worlds with no fixed calendar emit nothing.
- The marker, the `disable: false` flag, and 0-indexed months are the
  load-bearing literals — emit them exactly.

> Consumer behavior without it: the Scene Tracker keeps its manual per-chat date
> fields (default off); nothing errors and nothing appears in the prompt until the
> user sets a Day by hand.

---

## 6. Consumer-side direction (informative — not an ask)

The `world-forge` extension's Scene Tracker currently re-derives each present
person's `role` (`user` / `character` / `npc`) and the player persona by **LLM
guess**, even though the `[[NPC_MANIFEST]]` already declares `personas.user` and
the full NPC roster with stable ids (`MEMORY_CONTRACT.md` §3).

We intend to have the Scene Tracker **read the manifest** so it can:

- classify roles deterministically (persona vs. roster NPC) instead of guessing, and
- hand npc-memory stable ids directly, removing the fragile name round-trip in §3.

This is a change on the **consumer** side and requires nothing new from the
producer beyond the manifest it already emits. It is recorded here only so the
producer keeps `personas.user.aliases` and `npcs[].aliases` complete (§3), since
that manifest data becomes the Scene Tracker's source of truth once adopted.

---

## 7. Producer conformance checklist (World-Forge agents)

- [ ] Director / NPC-host cards carry a recognized tag from §2.1, surviving export.
- [ ] Director card tag agrees with manifest `lorebook.kind: "director"`.
- [ ] Every `npcs[].aliases` includes the bare first name + nicknames used in prose (§3).
- [ ] Preset Main Prompt emits `</style_contract>` verbatim, no attributes (§4).
- [ ] (If the world fixes a start date) one `[[WORLD_CALENDAR]]` entry in the World
      lorebook, **enabled** (`disable: false`) + inert (`key: []`, `constant: false`),
      0-indexed months, per §5.
- [ ] (Already met) `[[NPC_MANIFEST]]` + facets + scenes per `MEMORY_CONTRACT.md`.
- [ ] (Already met) `<style_override>` via `extensions.world_forge.style_override` (v2 directives array).

## 8. Relationship to `MEMORY_CONTRACT.md`

| Concern | Governed by |
| --- | --- |
| NPC manifest, facets, ids, turn tag, scenes registry | `MEMORY_CONTRACT.md` |
| Director-card tag, scene-name reconciliation, `</style_contract>` marker, `style_override` runtime, `[[WORLD_CALENDAR]]` date seed | this document |

The two are independently versioned. A producer that satisfies both is fully
cohesive with the `npc-memory` and `world-forge` extensions in this fork.
