// Render a code as a noisy PNG so bots can't read it as plain text.
// Returns a PNG Buffer.
import { createCanvas } from '@napi-rs/canvas';

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

export function renderCaptcha(code, rand = Math.random) {
  const step = 48;
  const W = 60 + code.length * step;
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
  for (let i = 0; i < 10; i++) {
    ctx.save();
    ctx.translate(rand() * W, rand() * H);
    ctx.rotate((rand() - 0.5) * 1.4);
    ctx.font = `bold ${22 + rand() * 20}px sans-serif`;
    ctx.fillStyle = `rgba(120,130,145,${0.05 + rand() * 0.08})`;
    ctx.fillText(ALPHA[Math.floor(rand() * ALPHA.length)], 0, 0);
    ctx.restore();
  }
  for (let i = 0; i < 5; i++) {
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
  // slight overlap so neighbouring glyphs touch (hard for OCR to segment)
  for (let i = 0; i < code.length; i++) {
    const x = 40 + i * step + (rand() * 10 - 5);
    const y = H / 2 + (rand() * 22 - 11);
    ctx.save();
    ctx.translate(x, y);
    ctx.transform(1, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5, 1, 0, 0); // shear
    ctx.rotate((rand() - 0.5) * 0.8);
    ctx.font = `bold ${44 + Math.floor(rand() * 16)}px sans-serif`;
    ctx.fillStyle = INK[Math.floor(rand() * INK.length)];
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }

  // interference curves OVER the text - these cross the glyphs and defeat OCR
  for (let i = 0; i < 3; i++) {
    interference(ctx, W, H, INK[Math.floor(rand() * INK.length)], 1.5 + rand() * 2, rand);
  }

  // dense speckle
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(${140 + rand() * 60 | 0},${150 + rand() * 60 | 0},${160 + rand() * 40 | 0},${rand() * 0.55})`;
    ctx.fillRect(rand() * W, rand() * H, 2, 2);
  }

  return canvas.toBuffer('image/png');
}
