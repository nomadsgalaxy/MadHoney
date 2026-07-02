// Render a code as a noisy PNG so bots can't read it as plain text.
// Returns a PNG Buffer.
import { createCanvas } from '@napi-rs/canvas';

const BG = '#0c0e11';
const INK = ['#ff9d12', '#de9400', '#e9ecf1', '#ffb347']; // honey + light text
const NOISE = '#2a313b';

export function renderCaptcha(code, rand = Math.random) {
  const W = 70 + code.length * 46;
  const H = 96;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // streaks
  for (let i = 0; i < 7; i++) {
    ctx.strokeStyle = i % 2 ? 'rgba(255,157,18,0.22)' : NOISE;
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    ctx.moveTo(rand() * W, rand() * H);
    ctx.lineTo(rand() * W, rand() * H);
    ctx.stroke();
  }

  // characters, each jittered + rotated
  for (let i = 0; i < code.length; i++) {
    const x = 34 + i * 46 + (rand() * 8 - 4);
    const y = H / 2 + (rand() * 18 - 9);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rand() - 0.5) * 0.6);
    ctx.font = `bold ${40 + Math.floor(rand() * 12)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK[Math.floor(rand() * INK.length)];
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }

  // speckle
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle = `rgba(154,163,173,${rand() * 0.5})`;
    ctx.fillRect(rand() * W, rand() * H, 2, 2);
  }

  return canvas.toBuffer('image/png');
}
