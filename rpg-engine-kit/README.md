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
  "attack_type": "slash",
  "damage_tier": "medium"
}
```

## Tuning

- **Damage tiers:** edit `server-plugin/rules.json` (`tiers` maps each tier to a dice
  formula; `npc_template` is the default NPC; `unconscious_at` is the down threshold).
- **Injection depth:** Extensions → RPG Engine → *Injection depth* (default 2 = near the
  end of the chat, so it dominates attention).
- **Parser model:** the parser uses the main connection's `generateRaw` with a JSON
  schema. To run it on a cheaper/faster model, swap the call for
  `ConnectionManagerRequestService.sendRequest(profileId, ...)` and add a profile picker
  to the settings (see `public/scripts/extensions/shared.js`).

## Honest limitations

- **Two LLM calls per turn** (reply + parser) — keep `parserMaxTokens` low and the
  parser model small.
- **Structured output support varies by backend.** OpenAI-compatible APIs honor the
  JSON schema strictly; others fall back to best-effort parsing.
- **`action_valid` is advisory.** The server still decides the numbers; the model can't
  apply damage it didn't earn, but it can mislabel a tier. Tune the parser prompt.
- **`msgIdx` is the chat index.** Swipes reuse the index, so `/apply` rolls back to the
  snapshot before re-applying — damage is never double-counted on a swipe.
