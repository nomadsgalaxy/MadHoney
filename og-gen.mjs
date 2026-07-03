// One-off: render the 1200x630 social-preview image (og.png). Re-run if the
// branding changes. node og-gen.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';

const W = 1200, H = 630;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// background
ctx.fillStyle = '#0a0b0d';
ctx.fillRect(0, 0, W, H);
// honey glow
const g = ctx.createRadialGradient(W * 0.72, -40, 60, W * 0.72, -40, 620);
g.addColorStop(0, 'rgba(255,179,26,0.16)');
g.addColorStop(1, 'rgba(255,179,26,0)');
ctx.fillStyle = g;
ctx.fillRect(0, 0, W, H);

// hazard stripes top + bottom
const stripe = (y, h) => {
  ctx.save();
  ctx.beginPath(); ctx.rect(0, y, W, h); ctx.clip();
  ctx.fillStyle = '#ffb31a'; ctx.fillRect(0, y, W, h);
  ctx.fillStyle = '#0a0b0d';
  for (let x = -h; x < W + h; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, y + h); ctx.lineTo(x + h, y); ctx.lineTo(x + h + 20, y); ctx.lineTo(x + 20, y + h);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
};
stripe(0, 16);
stripe(H - 16, 16);

const logo = await loadImage('logo.png');
const LS = 190;
ctx.drawImage(logo, 80, (H - LS) / 2 - 10, LS, LS);

const tx = 310;
// wordmark
ctx.textBaseline = 'alphabetic';
ctx.font = 'bold 76px sans-serif';
ctx.fillStyle = '#f2ede2'; ctx.fillText('Mad', tx, 250);
const mw = ctx.measureText('Mad').width;
ctx.fillStyle = '#ffb31a'; ctx.fillText('Honey', tx + mw, 250);

// tagline
ctx.font = 'bold 54px sans-serif';
ctx.fillStyle = '#f2ede2'; ctx.fillText('Spam bots ', tx, 340);
ctx.fillStyle = '#ffb31a'; ctx.fillText('ban themselves.', tx + ctx.measureText('Spam bots ').width, 340);

// subtitle
ctx.font = '30px sans-serif';
ctx.fillStyle = '#9a948a';
ctx.fillText('Free honeypot + captcha anti-spam for Discord', tx, 400);
ctx.fillStyle = '#ffb31a';
ctx.font = 'bold 28px sans-serif';
ctx.fillText('madhoney.nomadsgalaxy.com', tx, 450);

writeFileSync('og.png', canvas.toBuffer('image/png'));
console.log('og.png written', W, 'x', H);
