# SillyTavern D&D Logistics Starter Kit

A minimal, importable proof that SillyTavern's **engine** can run the logistics of a
tabletop RPG — real dice, persistent HP/stats, and turn-by-turn state injection —
without any custom extension. Everything here uses stock ST features.

## What's in the box

| File | Type | Import via |
|------|------|-----------|
| `DungeonMaster.card.json` | Character card (Tavern Card V2) | Characters panel → **Import Character** |
| `DnD_Rules.lorebook.json` | World Info / lorebook (native ST format) | World Info panel → **Import World Info** |
| `DnD_Mechanics.qr.json` | Quick Reply set with STScript | Quick Reply settings → **Import QR Set** |

## The core idea: engine owns the numbers, model owns the narration

The reason ST *can* be a D&D engine — and the answer to "it's just an LLM pretending
to roll" — is that the mechanical layer runs **outside** the model:

- **Dice are computed by the engine before the model sees the text.** The `{{roll::1d20}}`
  macro (`public/scripts/macros/definitions/core-macros.js:303`, backed by the `droll`
  library) resolves at prompt-injection time. The model receives `17`, not the instruction
  to roll. It cannot fudge the result.
- **State is real, persistent, and engine-held.** HP/AC/stats live in chat-scoped variables
  (`/setvar`, `/getvar` in `public/scripts/variables.js`), persisted in `chat_metadata`.
- **Control flow is real.** `/if`, `/while`, `/sub`, `/add` enforce thresholds (e.g. HP ≤ 0 →
  unconscious) deterministically.
- **The game loop is automated.** The Quick Reply extension auto-runs STScript on events
  (`executeOnNewChat`, `executeBeforeGeneration`, etc. — see
  `public/scripts/extensions/quick-reply/src/AutoExecuteHandler.js`).

This is the "hard" tier the model can't override. The lorebook + character card are the
"soft" tier (prose rules the model is asked to obey). The kit wires the two together so the
soft narration always reads from the hard state.

## How the pieces connect

1. **New Character** (`executeOnNewChat`, auto) seeds the sheet once per chat:
   `hp/maxhp`, `ac`, `level`, `xp`, `gold`, six ability modifiers, `conditions`, and an
   `initialized` guard so it never clobbers an existing sheet.
2. **Inject State** (`executeBeforeGeneration`, auto, hidden) runs *before every generation*
   and `/inject`s the live sheet into the prompt at depth 2 as a system note labelled
   authoritative. This is what keeps the DM's narration consistent with the real numbers.
3. **Roll / Attack / Take Damage / Heal** (manual buttons) are the player's dice tools.
   They roll via `{{roll::}}`, mutate variables, and clamp results (HP can't exceed max;
   HP ≤ 0 sets the `unconscious` condition).
4. **The lorebook** supplies the rules text: a `constant` (always-on) core-rules entry, plus
   keyword-triggered entries for checks, combat, the Sunken Crypt location, and the Bone
   Warden (which doubles as a **recursion demo** — the crypt entry mentions the warden by
   name, so with recursive scanning enabled the warden entry activates too).
5. **The character card** is the DM persona, instructed to treat the injected state as ground
   truth, to call for checks rather than inventing rolls, and to announce damage amounts
   rather than asserting HP totals.

## Setup steps

1. Import all three files (table above).
2. Quick Reply settings: enable the set globally **and** tick **"Allow auto-execute"** so the
   `executeOnNewChat` / `executeBeforeGeneration` scripts fire.
3. (Optional but recommended) World Info settings: enable **Recursive scanning** to see the
   Crypt → Bone Warden cascade.
4. Start a new chat with **The Dungeon Master**. The sheet auto-creates; tap **Show Sheet** to
   confirm. Play: when the DM calls for a check, tap **Roll**/**Attack**; when it announces
   damage, tap **Take Damage**.

## Honest limitations

- This is a **starter** sheet (flat ability modifiers, single character, no classes/spells).
  Extend by adding variables and buttons — the pattern scales.
- Auto-applying damage straight from the AI's text is possible (`executeOnAi` + regex parsing)
  but fragile, so the kit keeps damage/heal as explicit player actions. That's the robust
  design: the human confirms, the engine computes.
- Lorebook/system-prompt rules are soft — the model can still drift. The fix is always to back
  a rule with the hard tier (a variable + an `/if`), as the HP-to-unconscious logic shows.

## Verify the claims yourself

- Dice macro: `public/scripts/macros/definitions/core-macros.js:303`
- Variables & `/if` / `/while` / math: `public/scripts/variables.js`
- `/inject`: `public/scripts/slash-commands.js` (search `name: 'inject'`)
- Quick Reply auto-execute: `public/scripts/extensions/quick-reply/src/AutoExecuteHandler.js`
- Native lorebook entry schema: `default/content/Eldoria.json`
- Character card V2 schema: `src/types/spec-v2.d.ts`
