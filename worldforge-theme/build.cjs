/*
 * Builds WorldForge.json (an importable SillyTavern UI theme) from the palette
 * below + the human-editable theme.css. Run: `node build.cjs`.
 *
 * The theme JSON keys mirror SillyTavern's theme schema (see
 * default/content/themes/*.json); only the palette, a few display prefs, and the
 * custom_css differ from stock.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, 'theme.css'), 'utf-8');

const theme = {
    name: 'World Forge',
    blur_strength: 8,
    main_text_color: 'rgba(229, 231, 240, 1)',
    italics_text_color: 'rgba(184, 170, 230, 1)',
    underline_text_color: 'rgba(160, 150, 210, 1)',
    quote_text_color: 'rgba(125, 211, 230, 1)',
    blur_tint_color: 'rgba(20, 21, 31, 0.85)',
    chat_tint_color: 'rgba(26, 28, 42, 0.60)',
    user_mes_blur_tint_color: 'rgba(38, 32, 56, 0.55)',
    bot_mes_blur_tint_color: 'rgba(22, 24, 38, 0.55)',
    shadow_color: 'rgba(0, 0, 0, 0.45)',
    shadow_width: 2,
    border_color: 'rgba(130, 120, 200, 0.28)',
    font_scale: 1,
    fast_ui_mode: false,
    waifuMode: false,
    avatar_style: 0,
    chat_display: 1,
    noShadows: false,
    chat_width: 55,
    timer_enabled: false,
    timestamps_enabled: true,
    timestamp_model_icon: true,
    mesIDDisplay_enabled: true,
    hideChatAvatars_enabled: false,
    message_token_count_enabled: false,
    expand_message_actions: false,
    enableZenSliders: false,
    enableLabMode: false,
    hotswap_enabled: true,
    custom_css: css,
    bogus_folders: true,
    reduced_motion: false,
    compact_input_area: true,
};

const out = path.join(__dirname, 'WorldForge.json');
fs.writeFileSync(out, JSON.stringify(theme, null, 4) + '\n', 'utf-8');
console.log(`Wrote ${out} (${css.length} bytes of custom CSS)`);
