// Honeypot warning banner generator: hazard-striped card with configurable
// title, body text, colors, font, and an optional logo image (by URL).
// Returns a PNG Buffer. Pure rendering - no Discord I/O.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

// Generic families always resolve; the named ones fall back via fontconfig.
export const FONTS = ['sans-serif', 'serif', 'monospace', 'DejaVu Sans', 'Liberation Sans', 'Liberation Serif'];

// Bundled MadHoney bee - the default banner logo. Set logoUrl to a URL for
// your own, or 'none' for no logo at all.
const BUNDLED_LOGO = fileURLToPath(new URL('./logo.png', import.meta.url));

export const DEFAULT_BANNER = {
  title: 'DO NOT POST IN THIS CHANNEL',
  text: 'This channel is a trap for spam bots. Anything posted here triggers an instant, automated ban. Real humans: verify in #rules and back away slowly.',
  color: '#e9ecf1',   // body text
  accent: '#ffb31a',  // hazard stripes + title
  bg: '#0c0e11',
  font: 'sans-serif',
  logoUrl: '',        // '' -> bundled MadHoney logo, 'none' -> no logo
  mentionColor: '#5865f2', // #channel / @role highlight (Discord blurple)
  mentionMode: 'custom',   // 'custom' -> mentionColor for all; 'role' -> real role colors via opts.roleColors
};

// A word is a "mention" if it starts with # or @ (like #rules or @Staff).
const MENTION = /^[#@][\w-]/;

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function hazardStripes(ctx, y, w, h, accent) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y, w, h);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(0, y, w, h);
  ctx.fillStyle = '#111111';
  for (let x = -h * 2; x < w + h; x += 44) {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + h, y);
    ctx.lineTo(x + h + 22, y);
    ctx.lineTo(x + 22, y + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export async function renderBanner(opts = {}) {
  const o = { ...DEFAULT_BANNER, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null && v !== '')) };
  const W = 960, STRIPE = 26, PAD = 40;

  // Measure body first so the card height fits the text.
  const measure = createCanvas(W, 100).getContext('2d');
  measure.font = `26px ${o.font}`;
  let logo = null;
  const logoSrc = o.logoUrl === 'none' ? null : (o.logoUrl || BUNDLED_LOGO);
  if (logoSrc) {
    try { logo = await loadImage(logoSrc); } catch { /* bad URL - render without logo */ }
  }
  const logoW = logo ? 150 : 0;
  const textX = PAD + (logo ? logoW + PAD : 0);
  const textWidth = W - textX - PAD;
  const bodyLines = wrap(measure, o.text, textWidth);
  measure.font = `bold 44px ${o.font}`;
  const titleLines = wrap(measure, o.title, textWidth);

  const contentH = titleLines.length * 54 + 16 + bodyLines.length * 36;
  const H = Math.max(STRIPE * 2 + PAD * 2 + contentH, logo ? STRIPE * 2 + PAD * 2 + logoW : 0, 280);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = o.bg;
  ctx.fillRect(0, 0, W, H);
  hazardStripes(ctx, 0, W, STRIPE, o.accent);
  hazardStripes(ctx, H - STRIPE, W, STRIPE, o.accent);

  if (logo) {
    const ly = (H - logoW) / 2;
    ctx.drawImage(logo, PAD, ly, logoW, logoW);
  }

  // Draw a line word by word so #channel / @role tokens get a Discord-style
  // colored pill. Color comes from opts.roleColors (mentionMode 'role', built
  // by the caller from the guild) with mentionColor as the fallback.
  const mentionColorFor = (word) => {
    const token = word.match(/^[#@][\w-]+/)?.[0].toLowerCase();
    return (o.mentionMode === 'role' && o.roleColors?.[token]) || o.mentionColor;
  };
  const drawLine = (line, y, baseColor, size) => {
    let cx = textX;
    const space = ctx.measureText(' ').width;
    for (const word of line.split(' ')) {
      const w = ctx.measureText(word).width;
      if (MENTION.test(word)) {
        const mc = mentionColorFor(word);
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = mc;
        ctx.beginPath();
        ctx.roundRect(cx - 5, y - size * 0.82 - 3, w + 10, size * 1.06 + 6, 6);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = mc;
      } else {
        ctx.fillStyle = baseColor;
      }
      ctx.fillText(word, cx, y);
      cx += w + space;
    }
  };

  let y = (H - contentH) / 2 + 36;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 44px ${o.font}`;
  for (const line of titleLines) { drawLine(line, y, o.accent, 44); y += 54; }
  y += 16;
  ctx.font = `26px ${o.font}`;
  for (const line of bodyLines) { drawLine(line, y, o.color, 26); y += 36; }

  return canvas.toBuffer('image/png');
}
