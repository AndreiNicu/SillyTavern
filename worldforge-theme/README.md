# World Forge — SillyTavern UI theme

A modern dark theme: deep indigo glass surfaces, an indigo→cyan accent, soft glow
on focus/hover, rounded message cards with a color-coded edge (you vs. character),
a gradient name accent, refined buttons and input bar, and thin gradient
scrollbars. It's a **theme, not a code change** — purely cosmetic and fully
reversible (switch back to any other theme any time).

## What's in the box

| File | Purpose |
|------|---------|
| `WorldForge.json` | the importable theme (this is the only file SillyTavern needs) |
| `theme.css` | the human-editable source for the theme's `custom_css` |
| `build.cjs` | regenerates `WorldForge.json` from the palette + `theme.css` |

The theme leans on SillyTavern's own `--SmartTheme*` variables, so the palette set
in `WorldForge.json` and the `custom_css` stay in sync — change a color in the
theme picker and the accents follow.

## Install (import — recommended, no core change)

1. **User Settings** (the gear/person icon) → **Themes**.
2. Next to the theme dropdown, click **Import** and pick `WorldForge.json`.
3. Select **World Forge** from the theme dropdown.

That's it. To revert, just pick another theme.

## Optional: ship it as a built-in theme

If you want **World Forge** to appear automatically for fresh installs (new user
data dirs), add it to the shipped content:

1. Copy `WorldForge.json` to `default/content/themes/`.
2. Add an entry to `default/content/index.json`:
   ```json
   { "filename": "themes/World Forge.json", "type": "theme" }
   ```

This only seeds *new* user data — existing users still import via the UI above.

## Tweaking

Edit `theme.css` (it's commented), then:

```bash
node worldforge-theme/build.cjs   # regenerates WorldForge.json
```

Re-import the JSON to see changes. The accent colors live at the top of
`theme.css` as `--wf-accent` / `--wf-accent-2`; the rest derives from them.

## Notes

- Everything is **additive** — it restyles surfaces, spacing, accents and motion,
  and never rebuilds layout, so it stays robust across SillyTavern updates.
- Motion respects `prefers-reduced-motion` (all transitions/animations are
  disabled when the OS asks for reduced motion).
- The name accent uses background-clip text (Chromium/modern browsers — i.e. the
  SillyTavern desktop app and current desktop browsers).
