// Render a code as a noisy PNG so bots can't read it as plain text.
// Returns a PNG Buffer.
import { createCanvas } from '@napi-rs/canvas';
import './fonts.js'; // register bundled fonts so captcha text renders without system fonts

const BG = '#0c0e11';
const INK = ['#ff9d12', '#de9400', '#e9ecf1', '#ffb347']; // honey + light text
const NOISE = '#2a313b';

// A wavy interference curve across the width - the single most effective thing
// against OCR, because it fuses glyph edges together.
function interference(ctx, W, H, color, width, rand) {
  const y0 = rand() * H;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(-5, y0);
  for (let x = 0; x <= W; x += 12) {
    ctx.lineTo(x, y0 + Math.sin((x / W) * Math.PI * (2 + rand() * 3) + rand() * 6) * (10 + rand() * 14));
  }
  ctx.stroke();
}

// Difficulty scales how much OCR-defeating noise goes on the image. 'easy' is
// still distorted (a clean captcha is pointless), just lighter.
const DIFFICULTY = { easy: 0.55, normal: 1, hard: 1.6 };

export function renderCaptcha(code, difficulty = 'normal', rand = Math.random) {
  const k = DIFFICULTY[difficulty] ?? 1;
  const step = 46;
  const startX = 40;
  // Slack for the variable glyph pitch below. Combined with the now-variable
  // code length (captchaLength), the image no longer advertises a fixed
  // "always N chars at a fixed pitch" prior a solver can hardcode.
  const W = startX + Math.ceil(code.length * step * 1.25) + 20;
  const H = 110;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // background clutter: faint ghost glyphs + short strokes so the real code
  // doesn't sit alone on a clean field
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < Math.round(10 * k); i++) {
    ctx.save();
    ctx.translate(rand() * W, rand() * H);
    ctx.rotate((rand() - 0.5) * 1.4);
    ctx.font = `bold ${22 + rand() * 20}px sans-serif`;
    ctx.fillStyle = `rgba(120,130,145,${0.05 + rand() * 0.08})`;
    ctx.fillText(ALPHA[Math.floor(rand() * ALPHA.length)], 0, 0);
    ctx.restore();
  }
  for (let i = 0; i < Math.round(5 * k); i++) {
    ctx.strokeStyle = i % 2 ? 'rgba(255,157,18,0.18)' : NOISE;
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    ctx.moveTo(rand() * W, rand() * H);
    ctx.lineTo(rand() * W, rand() * H);
    ctx.stroke();
  }

  // a couple of interference curves UNDER the text
  interference(ctx, W, H, INK[Math.floor(rand() * INK.length)], 2 + rand() * 2, rand);
  interference(ctx, W, H, NOISE, 2 + rand() * 2, rand);

  // characters: jitter + rotation + horizontal shear (skew), varied size, and
  // NON-CONSTANT horizontal pitch so a solver can't segment glyphs by assuming
  // a fixed step. Distortion magnitude scales with difficulty.
  let x = startX;
  for (let i = 0; i < code.length; i++) {
    const y = H / 2 + (rand() * 22 - 11) * k;
    ctx.save();
    ctx.translate(x + (rand() * 8 - 4) * k, y);
    ctx.transform(1, (rand() - 0.5) * 0.5 * k, (rand() - 0.5) * 0.5 * k, 1, 0, 0); // shear
    ctx.rotate((rand() - 0.5) * 0.8 * k);
    ctx.font = `bold ${44 + Math.floor(rand() * 16)}px sans-serif`;
    ctx.fillStyle = INK[Math.floor(rand() * INK.length)];
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
    x += step * (0.8 + rand() * 0.4); // 0.8..1.2 of step, mean 1.0 - pitch varies per glyph
  }

  // interference curves OVER the text - these cross the glyphs and defeat OCR
  for (let i = 0; i < Math.max(1, Math.round(3 * k)); i++) {
    interference(ctx, W, H, INK[Math.floor(rand() * INK.length)], 1.5 + rand() * 2, rand);
  }

  // dense speckle
  for (let i = 0; i < Math.round(260 * k); i++) {
    ctx.fillStyle = `rgba(${140 + rand() * 60 | 0},${150 + rand() * 60 | 0},${160 + rand() * 40 | 0},${rand() * 0.55})`;
    ctx.fillRect(rand() * W, rand() * H, 2, 2);
  }

  return canvas.toBuffer('image/png');
}

// Random length in a per-difficulty range - longer is harder to guess/OCR, and
// varying it removes the fixed "always N chars" prior a trained solver relies on.
export const captchaLength = (difficulty, rand = Math.random) => {
  const [lo, hi] = ({ easy: [4, 5], normal: [5, 6], hard: [6, 7] })[difficulty] ?? [5, 6];
  return lo + Math.floor(rand() * (hi - lo + 1));
};

// ---------- position captcha ("fit the piece") ----------
// One puzzle piece floats above a row of slots, each with a cut-out hole; only
// the target slot's hole matches the piece's edge pattern (knobs/notches). The
// member answers with ONE button click - no typing - while a bot needs actual
// shape matching, not OCR. Difficulty controls how subtly the decoy holes
// differ and how much noise goes over the image.

export const POSITION_SLOTS = 5; // one Discord button row holds max 5 buttons

// Trace a jigsaw-piece path: square of size s centered on (cx,cy), each edge
// flat (0), knob out (1), or notch in (-1). Canvas arc rule used throughout:
// ccw=false bulges outward from the square, ccw=true cuts inward.
function piecePath(ctx, cx, cy, s, e) {
  const h = s / 2, r = s / 5;
  const [top, right, bottom, left] = e;
  ctx.beginPath();
  ctx.moveTo(cx - h, cy - h);
  if (top) { ctx.lineTo(cx - r, cy - h); ctx.arc(cx, cy - h, r, Math.PI, 0, top > 0); ctx.lineTo(cx + h, cy - h); }
  else ctx.lineTo(cx + h, cy - h);
  if (right) { ctx.lineTo(cx + h, cy - r); ctx.arc(cx + h, cy, r, -Math.PI / 2, Math.PI / 2, right < 0); ctx.lineTo(cx + h, cy + h); }
  else ctx.lineTo(cx + h, cy + h);
  if (bottom) { ctx.lineTo(cx + r, cy + h); ctx.arc(cx, cy + h, r, 0, Math.PI, bottom < 0); ctx.lineTo(cx - h, cy + h); }
  else ctx.lineTo(cx - h, cy + h);
  if (left) { ctx.lineTo(cx - h, cy + r); ctx.arc(cx - h, cy, r, Math.PI / 2, -Math.PI / 2, left < 0); ctx.lineTo(cx - h, cy - h); }
  else ctx.lineTo(cx - h, cy - h);
  ctx.closePath();
}

const randEdge = (rand) => [-1, 0, 1][Math.floor(rand() * 3)];
const edgeKey = (e) => e.join(',');

// A decoy differs from the target in exactly `diff` edges (never equal).
function decoyEdges(target, diff, rand) {
  const e = [...target];
  const idxs = [0, 1, 2, 3].sort(() => rand() - 0.5).slice(0, diff);
  for (const i of idxs) {
    const others = [-1, 0, 1].filter((v) => v !== target[i]);
    e[i] = others[Math.floor(rand() * others.length)];
  }
  return e;
}

export function renderPositionCaptcha(slot, difficulty = 'easy', rand = Math.random) {
  const k = DIFFICULTY[difficulty] ?? 1;
  // how many edges each decoy differs by: obvious on easy, subtle on hard
  const diffRange = ({ easy: [2, 4], normal: [1, 3], hard: [1, 1] })[difficulty] ?? [2, 4];

  const W = 480, H = 190;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // target shape: at least one knob/notch so there is something to match
  let target;
  do { target = [randEdge(rand), randEdge(rand), randEdge(rand), randEdge(rand)]; }
  while (target.every((v) => v === 0));

  // unique decoy shapes for the non-target slots
  const shapes = [];
  const used = new Set([edgeKey(target)]);
  while (shapes.length < POSITION_SLOTS - 1) {
    const diff = diffRange[0] + Math.floor(rand() * (diffRange[1] - diffRange[0] + 1));
    const d = decoyEdges(target, diff, rand);
    if (!used.has(edgeKey(d))) { used.add(edgeKey(d)); shapes.push(d); }
  }

  // background clutter (kept off the shapes' band so humans can still match)
  for (let i = 0; i < Math.round(4 * k); i++) {
    ctx.strokeStyle = i % 2 ? 'rgba(255,157,18,0.15)' : NOISE;
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    ctx.moveTo(rand() * W, rand() * H);
    ctx.lineTo(rand() * W, rand() * H);
    ctx.stroke();
  }

  // interference stays in the top band and UNDER the piece - noise for a bot's
  // segmentation, but it must never obscure the shape a human has to match
  interference(ctx, W, 40, INK[Math.floor(rand() * INK.length)], 1.5 + rand() * 1.5, rand);

  // the floating piece, top band, at a horizontal position UNRELATED to the
  // answer, with a slight wobble (small enough to still eyeball-match)
  const s = 48;
  const px = 70 + rand() * (W - 140);
  ctx.save();
  ctx.translate(px, 44);
  ctx.rotate((rand() - 0.5) * 0.14);
  piecePath(ctx, 0, 0, s, target);
  ctx.fillStyle = INK[Math.floor(rand() * INK.length)];
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // the slot row: panels with a hole cut in each (hole = BG fill on the panel);
  // slot order mixes the target in at `slot` (1-based)
  const pitch = W / POSITION_SLOTS;
  let d = 0;
  for (let n = 1; n <= POSITION_SLOTS; n++) {
    const cx = pitch * (n - 0.5), cy = 118;
    const jx = (rand() - 0.5) * 8, jy = (rand() - 0.5) * 6;
    ctx.save();
    ctx.translate(cx + jx, cy + jy);
    ctx.rotate((rand() - 0.5) * 0.1);
    ctx.fillStyle = '#232a34';
    ctx.beginPath();
    ctx.roundRect(-pitch / 2 + 8, -34, pitch - 16, 68, 8);
    ctx.fill();
    piecePath(ctx, 0, 0, s, n === slot ? target : shapes[d++]);
    ctx.fillStyle = BG; // the "hole"
    ctx.fill();
    ctx.restore();
    // slot number, jittered like captcha glyphs
    ctx.save();
    ctx.translate(cx + (rand() - 0.5) * 6, 172 + (rand() - 0.5) * 4);
    ctx.rotate((rand() - 0.5) * 0.3);
    ctx.font = `bold ${19 + Math.floor(rand() * 5)}px sans-serif`;
    ctx.fillStyle = INK[Math.floor(rand() * INK.length)];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), 0, 0);
    ctx.restore();
  }

  // a light speckle everywhere (never heavy enough to hide a knob)
  for (let i = 0; i < Math.round(160 * k); i++) {
    ctx.fillStyle = `rgba(${140 + rand() * 60 | 0},${150 + rand() * 60 | 0},${160 + rand() * 40 | 0},${rand() * 0.4})`;
    ctx.fillRect(rand() * W, rand() * H, 2, 2);
  }

  return canvas.toBuffer('image/png');
}
