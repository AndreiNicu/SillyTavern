# SillyTavern World Loader Kit

Load an entire [World-Forge](https://github.com/AndreiNicu/World-Forge) world from a single `.zip`.
Instead of the manual chore — import each lorebook, import each card, import the preset, create a
persona and paste `User.md`, bind the protagonist book, attach a per-character lorebook to every card,
enable the world book, leave only Arc 1 active, select the preset — you pick the export zip and press
**Load World**. Everything is imported and wired in one pass; you create the group chat to launch.

This is the "onboarding" companion to the `rpg-engine-kit` and `dnd-starter-kit`.

## Architecture

```
CLIENT EXTENSION (orchestrator)                  SERVER PLUGIN (inspector)
- upload .zip -> get a load plan                 /api/plugins/world-loader
- lorebooks  -> POST /api/worldinfo/edit         - unzip in memory (yauzl)
- characters -> POST /api/characters/import      - find world.manifest.json, else
- preset     -> getPresetManager().savePreset      classify by filename convention
- persona    -> initPersona() + avatar upload    - return a structured plan
- bind books -> charSetAuxWorlds()               - writes NOTHING (pure inspection)
- activate   -> /world (Tier-1 + active arc)
```

The plugin only **classifies** the bundle. All persistence happens client-side through SillyTavern's own
import endpoints, so imported assets go through exactly the same code paths as a manual import.

## What it does, tier by tier

| World-Forge asset | Loader action |
|---|---|
| Character cards (`*_Card.json`) | import via `/api/characters/import` |
| Tier-1 world lorebook | import + **activate globally** (always on) |
| Tier-2 character lorebook | import + **bind to the card** (`charLore` aux book) |
| Tier-2 protagonist lorebook | import + **bind to the persona** |
| Tier-3 arc lorebooks | import all; **activate only the default arc** (others stay off) |
| Intimacy profiles / registers | import alongside their owner |
| Chat-completion preset | import + best-effort select |
| `User.md` persona | create persona with that description |
| Group lorebook | import, left inactive (all-in-one alternative to the per-tier books) |
| RPG bestiary / user profile | detected & reported (see *Honest limitations*) |

## What's in the box

| Path | Goes where | Purpose |
|------|-----------|---------|
| `server-plugin/` | `plugins/world-loader/` | unzip + classify a bundle into a load plan |
| `extension/` | `public/scripts/extensions/third-party/world-loader/` | the **Load World** panel and the import/wiring orchestration |
| `schema/world.manifest.schema.json` | (World-Forge side) | the manifest contract the loader prefers |
| `schema/WORLD-FORGE-LOADER-GUIDE.md` | (World-Forge side) | producer guide for emitting the manifest |
| `schema/samples/world.manifest.json` | reference | a complete valid manifest |

(Both runtime target directories are git-ignored, which is why the kit ships as a separate folder you
copy in — same pattern as `rpg-engine-kit`.)

## Install

1. **Plugin:** copy `server-plugin/` to `plugins/world-loader/`.
2. **Enable plugins:** in `config.yaml` set `enableServerPlugins: true`, then restart. On boot you should
   see `[world-loader] plugin initialized`. (The plugin uses `multer` + `yauzl`, both already bundled
   with SillyTavern.)
3. **Extension:** copy `extension/` to `public/scripts/extensions/third-party/world-loader/`, then reload
   the UI. (Or install it as a third-party extension via the Extensions panel.)
4. Open **Extensions → World Loader**.

## Use

1. Pick a World-Forge export `.zip` and press **Inspect**. The loader shows a preview of what it found
   (world, characters, lorebooks by tier, preset, persona) plus any warnings.
2. Press **Load World**. The summary reports what was imported and wired.
3. **Launch:** create a *group chat* with the imported characters. The lorebooks, persona and preset are
   already in place; Arc 1 is active. Switch arcs by toggling arc lorebooks in World Info.

## The bundle contract

The loader prefers a root-level `world.manifest.json` (schema + producer guide under `schema/`), and
falls back to filename conventions when it is absent. The manifest's job is to remove the two things
filename sniffing genuinely cannot know: which lorebook is the **protagonist** book (bound to the persona,
not a card) and which arc is the **default**. The convention fallback normalizes names (so a
`WorldDirector_Lorebook` filename still binds to a `World Director` card) and treats the first lorebook
that matches no card as the protagonist book — good enough for the standard World-Forge layout, but ship
the manifest for anything non-standard.

## Honest limitations

- **The group chat is yours to create.** Scope is "import + stage": the loader wires everything that does
  not require a group to exist, then stops. Group creation is the explicit launch step, and the group
  lorebook is left for you to attach to that group.
- **Preset selection is best-effort.** The preset is always imported under the Chat Completion API; it is
  only auto-selected if your active API is chat completion. Otherwise the summary tells you to select it.
- **RPG auto-wiring is not done yet.** Character RPG profiles (`data.extensions.world_forge_rpg`) import
  with their cards automatically, but standalone `bestiary` / `user_profile` files are only detected and
  reported — feeding them into `rpg-engine-kit` needs a defined sink on the engine side first.
- **Re-importing overwrites by name.** Lorebooks/cards/presets with the same name are replaced, not
  merged. The `world.id` is there so a future version can namespace re-imports.
- **It reads internal ST functions.** `charSetAuxWorlds`/`initPersona` are imported lazily from
  SillyTavern modules; if an upstream rename breaks them, the loader degrades (skips that step with a
  note) rather than failing the whole import.

## Verify the claims yourself

- World info import (server): `src/endpoints/worldinfo.js` (`/edit`, `/import`)
- Character import (server): `src/endpoints/characters.js` (`/import`)
- Character ↔ lorebook binding: `public/scripts/world-info.js` (`charSetAuxWorlds`, `world_info.charLore`)
- Global world activation: `public/scripts/world-info.js` (`/world` slash command)
- Persona creation: `public/scripts/personas.js` (`initPersona`)
- Preset manager: `public/scripts/preset-manager.js` (`savePreset`, `selectPreset`)
