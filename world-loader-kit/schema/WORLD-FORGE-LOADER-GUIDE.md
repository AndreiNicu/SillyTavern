# World-Forge → World Loader: producer integration guide

**Audience:** the Claude instance working in the [World-Forge](https://github.com/AndreiNicu/World-Forge)
repo, adding a manifest to the export pipeline.

**Your job:** emit one extra file — `world.manifest.json` — at the root of the export bundle, conforming
to `world.manifest.schema.json`. That's the whole contract. The World Loader (a SillyTavern kit) reads it
and assembles the entire world in one pass: imports every card, lorebook, preset, and persona, binds the
per-character and persona lorebooks, activates the world lorebook and the default arc, and stages the
group lorebook for the group chat the human creates.

You do **not** need to read the loader's code — only honor the schema.

---

## Why a manifest

The loader can run without one (see "Convention fallback" below), but filename sniffing is brittle: it
cannot reliably tell a *protagonist* lorebook (bound to the persona) from a *character* lorebook (bound to
a card), it has to guess which arc is the default, and it cannot know the world's narrative mode. The
manifest makes all of that explicit and stable across renames. **Emit it.**

Place it at the **root of the export zip** as `world.manifest.json`. Every path inside it is a filename
**relative to the zip root** — no directories, no `./`. Stamp `schema_version` with the version you
authored against (`"1.0.0"` today).

---

## The shape (full reference is the schema)

```jsonc
{
  "kind": "world_manifest",
  "schema_version": "1.0.0",
  "world": {
    "id": "lucifer",            // snake_case, stable; namespaces re-imports
    "name": "Lucifer",
    "mode": "arc",              // "arc" (one arc active at a time) | "sandbox" (arc state always on)
    "description": "..."        // optional, shown in the loader preview
  },

  "preset": "Lucifer-Lucifer_ChatPreset.json",   // chat-completion preset (optional)

  "persona": {
    "name": "Andrei",
    "description_file": "Lucifer-User.md",        // markdown -> persona description
    "lorebook": "Lucifer-Andrei_Lorebook.json"    // protagonist book, bound to the persona
  },

  "characters": [
    { "file": "Anna_Card.json", "name": "Anna",
      "lorebook": "Lucifer-Anna_Lorebook.json",          // Tier-2, bound to the card
      "intimacy": "Lucifer-Anna_Intimacy_Profile.json" }, // optional, conditional
    { "file": "WorldDirector_Card.json", "name": "World Director",
      "lorebook": "Lucifer-WorldDirector_Lorebook.json",
      "director": true }
  ],

  "lorebooks": {
    "world": ["Lucifer-World_Lorebook.json"],     // Tier-1, activated globally (always on)
    "group": ["Lucifer-Group_Lorebook.json"],     // staged for the group chat
    "arcs": [                                       // Tier-3; only the default arc is activated
      { "n": 1, "file": "Lucifer-Arc1_Lorebook.json", "intimacy": "Lucifer-Arc1_Intimacy_Register.json" },
      { "n": 2, "file": "Lucifer-Arc2_Lorebook.json", "intimacy": "Lucifer-Arc2_Intimacy_Register.json" }
    ]
  },

  "rpg": {                                          // optional; consumed by rpg-engine-kit
    "user_profile": "Lucifer-User_RPG.json",
    "bestiary": "Lucifer-Bestiary.json"
  },

  "defaults": { "active_arc": 1 },                  // arc to enable on load (defaults to lowest)

  "docs": ["Lucifer-Compiler_Log.md", "Lucifer-Prompt_Engineer_Audit.md"] // surfaced, not imported
}
```

### Tier → manifest field mapping

| World-Forge tier | Where it goes in the manifest | What the loader does with it |
|---|---|---|
| Tier 1 — permanent world | `lorebooks.world[]` | import + activate globally (always on) |
| Tier 2 — per-character | `characters[].lorebook` | import + bind to that card |
| Tier 2 — protagonist | `persona.lorebook` | import + bind to the persona |
| Tier 3 — per-arc | `lorebooks.arcs[]` | import all; activate only the default arc |
| Group-tagged combined | `lorebooks.group[]` | import + stage for the group chat |
| Intimacy (conditional) | `characters[].intimacy` / `arcs[].intimacy` | import alongside its owner; left to the entries' own activation rules |

---

## Rules that keep the two projects from drifting

1. **Filenames in the manifest must match the files actually in the zip**, byte-for-byte. The loader
   resolves each reference against the bundle and reports any miss as a warning — it never invents a file.
2. **A lorebook is referenced exactly once.** A book named under `characters[].lorebook` must not also
   appear in `lorebooks.world`. The loader imports each file once; double references are flagged.
3. **`persona.description_file` is markdown**, not JSON — it's pasted verbatim into the persona
   description. Everything else referenced is JSON in SillyTavern's native format (cards = V2/V3 spec,
   lorebooks = `{ entries: {...} }`, preset = chat-completion preset).
4. **Lorebook JSON must contain an `entries` object** (SillyTavern's import requirement). Emit native ST
   World Info, not your internal markdown.
5. **Don't put current/runtime state anywhere.** The manifest indexes *authored* assets only.

---

## Convention fallback (what the loader does without a manifest)

If `world.manifest.json` is absent, the loader classifies by filename so older exports still load. Keep
emitting these patterns and the fallback stays accurate:

| Pattern (case-insensitive) | Classified as |
|---|---|
| `*_Card.json` | character card (`director` if the name contains "Director") |
| `*-World_Lorebook.json` | Tier-1 world (global) |
| `*-Group_Lorebook.json` | group lorebook |
| `*-Arc<N>_Lorebook.json` | arc `N` |
| `*-Arc<N>_Intimacy_Register.json` | arc `N` intimacy |
| `*-<Name>_Intimacy_Profile.json` | intimacy for character `<Name>` |
| `*-<Name>_Lorebook.json` (not World/Group/Arc) | character book if `<Name>` matches a card; else flagged as an unbound book for manual binding |
| `*_ChatPreset.json` | chat-completion preset |
| `*User.md` | persona description |
| `*_RPG.json` / `*-User_RPG.json` | RPG user profile |
| `*Bestiary.json` | bestiary |
| other `*.md` | doc (surfaced, not imported) |

The fallback's blind spot is exactly the protagonist book and the default arc — which is why the manifest
exists. When in doubt, ship the manifest.

---

## Validate before you ship

Point any draft-07 validator (e.g. `ajv`) at `world.manifest.schema.json`; `samples/world.manifest.json`
is a complete valid instance to copy from. The loader performs the same structural checks at import time
and refuses a manifest whose `schema_version` major differs from its own.

---

## Checklist for the World-Forge export pipeline

- [ ] Emit `world.manifest.json` at the zip root, `kind:"world_manifest"`, `schema_version:"1.0.0"`.
- [ ] `world.id` snake_case and stable; `world.mode` set to `arc` or `sandbox`.
- [ ] Every card listed in `characters[]` with its Tier-2 `lorebook` (and `intimacy` if present).
- [ ] `persona.description_file` (the `User.md`) and `persona.lorebook` (protagonist book) set.
- [ ] Tier-1 books in `lorebooks.world[]`; arcs in `lorebooks.arcs[]`; `defaults.active_arc` chosen.
- [ ] `preset` set if the world ships one; `rpg` set if RPG assets are included.
- [ ] Every referenced filename exists in the zip; no file referenced twice.
- [ ] Manifest validates against the schema.
