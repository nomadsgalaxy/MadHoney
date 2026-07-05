// Honeypot warning banner generator: hazard-striped card with configurable
// title, body text, colors, font, and an optional logo image (by URL).
// Returns a PNG Buffer. Pure rendering - no Discord I/O.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import './fonts.js'; // register bundled fonts so text renders without system fonts

// Generic families always resolve; the named ones fall back via fontconfig.
export const FONTS = ['sans-serif', 'serif', 'monospace', 'DejaVu Sans', 'Liberation Sans', 'Liberation Serif'];

// Bundled MadHoney bee - the default banner logo. Set logoUrl to a URL for
// your own, or 'none' for no logo at all.
const BUNDLED_LOGO = fileURLToPath(new URL('./logo.png', import.meta.url));

// The attribution/credit line. On the hosted service it's mandatory (marketing
// + SWAtt); only self-hosters may hide it. Set SELF_HOSTED=true to allow that.
export const CREDIT_LINE = 'protected by https://madhoney.nomadsgalaxy.com';
export const CREDIT_URL = 'https://madhoney.nomadsgalaxy.com';
export const SELF_HOSTED = ['true', 'on', '1', 'yes'].includes(String(process.env.SELF_HOSTED).toLowerCase());
// Resolve whether the credit shows at all: forced on unless a self-hoster hid it.
export const resolveCredit = (hideCredit) => (SELF_HOSTED && hideCredit ? '' : CREDIT_LINE);
// The attribution now lives on the VERIFY PANEL, not the honeypot banner - so the
// decoy carries no MadHoney-specific tell. Discord subtext + a real link. '' only
// when a self-hoster has hidden it.
export const creditSuffix = (hideCredit) => (resolveCredit(hideCredit) ? `\n\n-# protected by <${CREDIT_URL}>` : '');

export const DEFAULT_BANNER = {
  title: 'HONEYPOT IS ACTIVE',
  text: 'This channel is a trap for spam bots. Anything posted here triggers an instant, automated ban. Real humans: verify in #rules and back away slowly.',
  color: '#e9ecf1',   // body text
  accent: '#ffb31a',  // hazard stripes + title
  bg: '#0c0e11',
  font: 'sans-serif',
  logoUrl: '',        // '' -> bundled MadHoney logo, 'none' -> no logo
  mentionColor: '#5865f2', // #channel / @role highlight (Discord blurple)
  mentionMode: 'custom',   // 'custom' -> mentionColor for all; 'role' -> real role colors via opts.roleColors
  credit: '',              // attribution moved to the verify panel (see creditSuffix); banner stays generic
  distort: 0,              // 0 none .. 3 heavy: garble the text against OCR/bot detection
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
  const creditH = o.credit ? 26 : 0;
  const H = Math.max(STRIPE * 2 + PAD * 2 + contentH + creditH, logo ? STRIPE * 2 + PAD * 2 + logoW : 0, 280);

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
  // distort level (0-3): captcha-style garbling so OCR can't lift the text and
  // bots can't fingerprint the warning. Higher = harder for machines (and a bit
  // harder for humans), so it's the admin's call.
  const dz = Math.min(3, Math.max(0, Math.round(o.distort ?? 0)));
  const jitter = (n) => (dz ? (Math.random() - 0.5) * n * dz : 0); // ponytail: cosmetic only, no seed needed
  const textTop = (H - contentH) / 2 + 4;

  const drawLine = (line, y, baseColor, size) => {
    let cx = textX;
    const space = ctx.measureText(' ').width;
    for (const word of line.split(' ')) {
      const w = ctx.measureText(word).width;
      const isM = MENTION.test(word);
      let color = baseColor;
      if (isM) {
        const mc = mentionColorFor(word);
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = mc;
        ctx.beginPath();
        ctx.roundRect(cx - 5, y - size * 0.82 - 3, w + 10, size * 1.06 + 6, 6);
        ctx.fill();
        ctx.globalAlpha = 1;
        color = mc;
      }
      ctx.fillStyle = color;
      if (!dz) {
        ctx.fillText(word, cx, y);
        cx += w + space;
      } else {
        // per-character jitter/rotation/shear so OCR can't segment the word
        for (const ch of word) {
          const cw = ctx.measureText(ch).width;
          ctx.save();
          ctx.translate(cx + cw / 2 + jitter(3), y + jitter(7));
          ctx.rotate(jitter(0.12));
          ctx.transform(1, jitter(0.18), jitter(0.18), 1, 0, 0);
          ctx.fillStyle = color;
          ctx.fillText(ch, -cw / 2, 0);
          ctx.restore();
          cx += cw + jitter(2);
        }
        cx += space;
      }
    }
  };

  let y = textTop + 32;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 44px ${o.font}`;
  for (const line of titleLines) { drawLine(line, y, o.accent, 44); y += 54; }
  y += 16;
  ctx.font = `26px ${o.font}`;
  for (const line of bodyLines) { drawLine(line, y, o.color, 26); y += 36; }

  // Interference curves across the text region + speckle, scaled by distort.
  // Curves are drawn thick and over the glyphs so they fuse edges (the thing
  // that actually beats OCR).
  if (dz) {
    const top = textTop, bot = y + 6;
    for (let i = 0; i < dz * 5; i++) {
      const y0 = top + Math.random() * (bot - top);
      ctx.strokeStyle = i % 3 === 0 ? o.bg : (i % 2 ? o.accent : o.color);
      ctx.globalAlpha = 0.4 + Math.random() * 0.35;
      ctx.lineWidth = 2 + Math.random() * (1 + dz);
      ctx.beginPath();
      ctx.moveTo(textX - 6, y0);
      for (let x = textX; x <= W - PAD; x += 10) ctx.lineTo(x, y0 + Math.sin(x / (16 + i) + i) * (5 + dz * 4));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < dz * 200; i++) {
      ctx.fillStyle = `rgba(200,200,205,${Math.random() * 0.4})`;
      ctx.fillRect(textX + Math.random() * (W - textX - PAD), top + Math.random() * (bot - top), 2, 2);
    }
  }

  if (o.credit) {
    ctx.font = `14px ${o.font}`;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = o.color;
    ctx.fillText(o.credit, W - PAD - ctx.measureText(o.credit).width, H - STRIPE - 10);
    ctx.globalAlpha = 1;
  }

  // Always add a faint, unique speckle so two servers with identical settings
  // never produce byte-identical images - defeats fingerprinting by image hash.
  for (let i = 0; i < 50; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.045})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }

  return canvas.toBuffer('image/png');
}
