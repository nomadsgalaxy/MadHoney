// Register bundled fonts so text renders on hosts with NO system fonts and NO
// fontconfig (bare-metal self-hosts, slim/Alpine containers). Without this,
// @napi-rs/canvas asks the OS for `sans-serif` and gets nothing, so banners and
// captchas come out blank or garbled. Bundling DejaVu makes rendering
// self-contained: no `apt install fonts-*` required anywhere.
//
// Importing this module (for its side effects) once, before any canvas text is
// drawn, is enough — ES modules run their top level a single time. banner.js,
// captcha.js and og-gen.mjs all import it.
//
// Fonts: DejaVu (Bitstream Vera + DejaVu changes), a permissive license that
// allows bundling and redistribution. See fonts/LICENSE.
import { GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const reg = (file, ...families) => {
  const p = fileURLToPath(new URL(`./fonts/${file}`, import.meta.url));
  if (!existsSync(p)) { console.warn(`[fonts] missing ${file} - text may not render`); return; }
  // Register under each family name (proper name + the generic alias the
  // renderer asks for). Regular and bold share a family; the font's own weight
  // metadata lets Skia pick the right face for `bold ...px <family>`.
  for (const fam of families) GlobalFonts.registerFromPath(p, fam);
};

// sans-serif is the default (DEFAULT_BANNER.font) and what captcha.js hardcodes,
// so it MUST resolve; alias DejaVu Sans to it as well as its proper name.
reg('DejaVuSans.ttf', 'sans-serif', 'DejaVu Sans');
reg('DejaVuSans-Bold.ttf', 'sans-serif', 'DejaVu Sans');
reg('DejaVuSerif.ttf', 'serif', 'DejaVu Serif');
reg('DejaVuSerif-Bold.ttf', 'serif', 'DejaVu Serif');
reg('DejaVuSansMono.ttf', 'monospace', 'DejaVu Sans Mono');
reg('DejaVuSansMono-Bold.ttf', 'monospace', 'DejaVu Sans Mono');

// 'Liberation Sans'/'Liberation Serif' are also offered in banner.js FONTS; map
// them onto DejaVu so picking them never yields blank text on a font-less host.
reg('DejaVuSans.ttf', 'Liberation Sans');
reg('DejaVuSerif.ttf', 'Liberation Serif');

export const FONTS_READY = true;
