# SillyTavern (AndreiNicu fork)

A personal fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern)
that tracks upstream `release` and adds a small set of features focused on
multi-character group chats, smarter world-info activation, and runtime
debugging.

For general SillyTavern documentation, installation, and support, see the
upstream project:

- Upstream repo: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Subreddit: <https://reddit.com/r/SillyTavernAI>

This README only describes what is different here.

## What this fork adds

### LLM-routed group chat reply strategy

A new group reply strategy that uses a small/fast model (selected via a
Connection Manager profile) to decide which character(s) speak next based
on the recent conversation, instead of picking by natural order or
manually. Highlights:

- Returns an ordered queue of speakers; the queue is re-polled after it
  drains so addressees and cross-character exchanges flow naturally.
- Bounded by a per-group "max consecutive turns" cap to prevent runaway
  loops, with the router biased toward stopping (`[]`) on follow-up
  rounds and given a turn-context line so it can taper off near the cap.
- Group settings expose three new fields persisted via `/api/groups`:
  router profile id, optional system-prompt override, and max
  consecutive turns.
- "Director" / "NPC" tagged cards are recognised automatically and split
  into a separate roster section. Off-roster NPC names addressed by
  `{{user}}` are routed to a Director card and performed via a one-shot
  in-character system note.
- Fuzzy first-token matching resolves short names ("Anna") to full
  main-cast names ("Anna Johansson") when unambiguous.
- Guards against the Director performing the same NPC twice in a row or
  performing as `{{user}}`'s own persona.
- Falls back to natural order on missing profile or request failure so
  chats never stall.

### LLM-based world info (lorebook) key filter

A global toggleable setting that runs a small LLM against the candidate
lorebook entries' **titles and keys only** (never their content) to pick
which ones are semantically relevant to the recent chat. Selected
entries flow through the normal scan pipeline unchanged, so constants,
decorators, sticky/cooldown, position, and budget all still apply.

- Unlocks synonym expansion (e.g. "stallion" activates a "horse" entry)
  and disambiguates generic key matches.
- Includes the author's note when set — its named beats / locations
  often carry the most useful context for relevance.
- Skipped for quiet generations (summaries, vector embeddings,
  expression classification, slash-command LLM calls) where the result
  would be discarded anyway.
- Thinking-model safe: strips `<think>` / `<thinking>` / `<reasoning>` /
  `<|think|>` / `<|begin_of_thought|>` wrappers and parses the last
  valid JSON array in the cleaned text.
- Fail-open: parse or transport errors surface as a toast and fall back
  to the regex scan.

### Per-lorebook "Disable inclusion group competition" toggle

A checkbox at the top of each lorebook's editor (persisted as
`disable_inclusion_group_competition` at the root of the lorebook JSON)
that exempts every entry in that book from inclusion-group competition.
Useful when you use the group field as an organisational tag (one group
string per lorebook/arc/character) rather than as a competition bucket.
Off by default; existing books are unaffected.

### World Forge style-override runtime extension

A new built-in extension (`public/scripts/extensions/world-forge`) that
reads `data.extensions.world_forge.style_override` from the active
character and splices a `<style_override>` block into the system prompt
immediately after `</style_contract>` via
`CHAT_COMPLETION_PROMPT_READY`. The pipeline owns all prose composition
and ships a pre-resolved `directives` array (schema v2), so the
extension just substitutes `{{char}}`/`{{user}}` macros and emits the
block verbatim. Cards with `style_override = null` emit nothing and the
world default governs untouched.

### Prompt viewer extension

A wand-menu extension that lets you inspect the exact JSON body the
browser POSTs to the chat/text-completion backends, with labels
indicating which server-side transforms (post-processing, Claude/Gemini
format conversion, name-prefix injection) will further mutate the
prompt before it reaches the upstream API. Capture is done by patching
`window.fetch` with event-based fallbacks
(`CHAT_COMPLETION_SETTINGS_READY` / `GENERATE_AFTER_COMBINE_PROMPTS`).

A complementary **server-side dump** can be toggled from the same popup.
When on, the post-processed request body is written as JSON to
`$user/Logs_Prompts/` from inside
`src/endpoints/backends/chat-completions.js` (after `postProcessPrompt`,
before provider-specific conversion) and `text-completions.js`. The
extension popup lists the most recent 200 dumps and re-renders them
through the same viewer. Off by default.

### Structural debug log

A "Debug Log to File" toggle in User Settings writes a structural entry
per generation to `<user_data>/Logs_Debug/debug-YYYY-MM-DD.log` via a
new `POST /api/debug-logs/append` endpoint. Logged fields:

- Last character to speak (and message id).
- Activated lorebook entries (world/uid, title, position/depth, constant
  flag).
- Prompt section order — for chat-completion, role + identifier or a
  content snippet; for text-completion, recognised section markers.
- An `llm_decision_calls` section with the full prompts/responses sent
  to the group reply router and the world-info LLM key filter (success
  and failure paths both emit; prompt and response truncated at 8 KB).

No actual prompt content is logged beyond the structural metadata, so
the files stay small and readable. Entry boundaries follow the user
turn: group chats use `GROUP_WRAPPER_STARTED` →
`GROUP_WRAPPER_FINISHED` so multi-speaker turns aren't split into
several entries.

### Character video player on the zoomed avatar

Lets you upload an mp4/webm video for a character alongside the static
avatar. Clicking the avatar opens the existing zoomed view; a toggle in
the panel control bar swaps between the still image and a looping video
with audio and native controls. Mobile UX is reworked so the zoomed
panel sizes to content, the control bar stays visible without hover,
and tap targets meet the ~40 px guidance.

### Better default summary prompt

The default summary prompt has been rewritten to forbid forward-looking
"next action" content and present-tense "current state" framing — both
of which produced stale summaries once the second-to-last-message slot
fell several turns behind the live chat. The new default asks for a
past-tense, chronological summary that remains accurate when read
later.

### Token caps and error surfacing

The LLM router (group reply) and LLM key filter (world info) token caps
were bumped (router 64 → 1024, filter 256 → 2048) to give thinking
models room to reason before producing their JSON answer. Failures from
either call now surface as a toast in addition to the console error,
and both fall back to the heuristic / regex path so generation
continues.

## Branch layout

- `claude/merge-upstream-release-*` — periodic merges from
  `upstream/release`.
- `claude/<feature-slug>-*` — short-lived branches per feature.
- Merged into `main` (this repo's default) via PR once tested.

## License

AGPL-3.0, same as upstream SillyTavern.
