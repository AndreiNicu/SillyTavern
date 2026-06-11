# SillyTavern RPG Engine Kit

A server-authoritative game-state engine for tabletop-style roleplay. Stats live in
JSON on the server, combat math runs server-side (so the model can't fudge it), and a
small parser LLM turns the narration into structured outcomes that mutate the state.
Every change is snapshotted so deleting/swiping a message cleanly reverts the stats.

This is the "hard tier" companion to the `dnd-starter-kit` Quick Reply set: the QR
buttons do player-initiated dice; this engine tracks persistent state and adjudicates
narrative combat automatically.

## Architecture

```
CLIENT EXTENSION (orchestrator)              SERVER PLUGIN (authority)
- before each gen: GET /sheet, inject        /api/plugins/rpg-engine
- after each reply: parser LLM -> JSON       - defaults.json -> active.json (/reset)
  -> POST /apply                             - tier -> dice, damage - armor_dr (/apply)
- on delete/swipe: POST /rollback            - snapshot per message (undo)
```

The model only ever **classifies** an exchange (`damage_tier: "medium"`); the server
decides legality, rolls the dice, subtracts armor, clamps HP, and sets conditions.

## What's in the box

| Path | Goes where | Purpose |
|------|-----------|---------|
| `server-plugin/` | `plugins/rpg-engine/` | Express plugin: state files, combat math, undo snapshots |
| `extension/` | `public/scripts/extensions/third-party/rpg-engine/` | Event hooks, parser call, prompt injection, settings UI |

(Both target directories are git-ignored runtime locations, which is why the kit ships
as a separate folder you copy in — same pattern as `dnd-starter-kit`.)

## Install

1. **Plugin:** copy `server-plugin/` to `plugins/rpg-engine/`.
2. **Enable plugins:** in `config.yaml` set `enableServerPlugins: true`, then restart.
   On boot you should see `[rpg-engine] plugin initialized`.
3. **Extension:** copy `extension/` to
   `public/scripts/extensions/third-party/rpg-engine/`, then reload the UI. (Or install
   it as a third-party extension via the Extensions panel.)
4. Open **Extensions → RPG Engine**, tick **Enable engine** and **Auto-parse combat**.

## Data layout (per user)

```
{user}/user/files/rpg-engine/
  games/{chatId}/active.json      # live state (auto-seeded from defaults.json)
  games/{chatId}/undo/{idx}.json  # pre-action snapshot, one per AI message
```

`server-plugin/defaults.json` is the global baseline (the "one global JSON" for
user + character). `Reset Game` copies it over `active.json`, so restarting a game
restores the defaults. NPCs are created on demand from `rules.json -> npc_template`
the first time they are targeted.

## The armor example

`armor_dr` is flat damage reduction applied on every physical hit
(`taken = max(0, roll(tier) - armor_dr)` in `applyAction`). Give the player heavy
plate by setting `"armor_dr": 3` in `defaults.json`, or add it to an NPC's
`npc_template`. The injected sheet tells the narrator the armor exists; the server
guarantees the numbers reflect it.

## Endpoints

| Method | Route | Body / query | Returns |
|--------|-------|-------------|---------|
| GET  | `/state`    | `?chatId=`                     | `{ state }` |
| GET  | `/sheet`    | `?chatId=`                     | `{ sheet }` (the injected text) |
| POST | `/reset`    | `{ chatId }`                   | `{ state }` |
| POST | `/apply`    | `{ chatId, msgIdx, parsed }`   | `{ ok, delta, state, sheet }` |
| POST | `/rollback` | `{ chatId, msgIdx }`           | `{ restored, state, sheet }` |

`parsed` is the schema the parser LLM fills:

```json
{
  "action_valid": true,
  "attacker": "player",
  "target": "orc_captain",
  "attack_type": "slashing",
  "damage_tier": "medium",
  "evidence": "the blade bites into the captain's flank"
}
```

## Mislabel safeguards

The parser's tier choice is the one fallible step; everything after it is deterministic.
Four layers keep a bad label cheap (full rationale in `schema/README.md`):

1. **Constrain** — `damage_tier` is a strict enum; a rubric in the parser prompt anchors each
   tier to concrete narrative cues and says "when unsure, pick the lower tier".
2. **Gate** — combat-mode flag (button) + a keyword regex mean the parser usually doesn't fire
   at all outside fights. The triggering keyword is passed to the parser as an anchor.
3. **Validate** — the engine rejects unknown `target`/`attacker` (hallucinated combatants), and
   the client skips applying if the `evidence` quote isn't actually in the narration.
4. **Contain** — a **damage governor** (`rules.json.governor`) caps a single non-crit hit at a
   fraction of `maxhp` (default 35%) so a misclassified `heavy` can't one-shot.

## Tuning

- **Damage tiers:** edit `server-plugin/rules.json` (`tiers` maps each tier to a dice formula;
  `npc_template` is the default NPC; `governor` caps per-hit damage). Real games override these
  with World-Forge per-entity / per-tier tables — `rules.json` is the demo fallback.
- **Combat mode & keywords:** Extensions → RPG Engine → *Enter Combat Mode*, plus the two gate
  checkboxes and the keyword list in settings.
- **Injection depth:** *Injection depth* (default 2 = near the end of the chat).
- **Parser model:** `generateRaw` uses the active preset's connection and sampler settings (it
  has **no** per-call temperature override). For a cheap, stable, low-temperature parser, swap
  the call for `ConnectionManagerRequestService.sendRequest(profileId, ...)` pointed at a
  dedicated low-temp profile (see `public/scripts/extensions/shared.js`).

## Honest limitations

- **Two LLM calls per turn** (reply + parser) — keep `parserMaxTokens` low, the parser model
  small, and lean on the combat-mode/keyword gates to skip non-combat turns.
- **Structured output support varies by backend.** OpenAI-compatible APIs honor the JSON schema
  strictly; others fall back to best-effort parsing.
- **The tier choice is still soft.** Safeguards make mislabels cheap and auto-reject the obvious
  ones, but the model can still pick a wrong-but-plausible tier. Undo is the backstop.
- **`msgIdx` is the chat index.** Swipes reuse the index, so `/apply` rolls back to the snapshot
  before re-applying — damage is never double-counted on a swipe.
