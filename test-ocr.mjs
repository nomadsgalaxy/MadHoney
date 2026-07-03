// OCR gut-check: does tesseract.js read our captcha / banner? A low read rate
// means the distortion is doing its job. Dev-only (needs devDependency
// tesseract.js). Run: node test-ocr.mjs
import { createWorker } from 'tesseract.js';
import { renderCaptcha, captchaLength } from './captcha.js';
import { makeCode } from './verify.js';
import { renderBanner } from './banner.js';

const clean = (s) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
const worker = await createWorker('eng');

console.log('\n=== CAPTCHA (per difficulty, 12 samples each) ===');
for (const diff of ['easy', 'normal', 'hard']) {
  let solved = 0, near = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const code = makeCode(captchaLength(diff));
    const png = renderCaptcha(code, diff);
    const { data } = await worker.recognize(png);
    const read = clean(data.text);
    if (read === code) solved++;
    else if ([...code].filter((c, j) => read[j] === c).length >= code.length - 1) near++;
  }
  console.log(`  ${diff.padEnd(6)}: exact ${solved}/${N}, off-by-one ${near}/${N}  (lower = better)`);
}

console.log('\n=== BANNER (per distort level) - can OCR read the warning words? ===');
const TELLS = ['HONEYPOT', 'TRAP', 'BAN', 'DONOTPOST', 'DONOT'];
for (const distort of [0, 1, 2, 3]) {
  const png = await renderBanner({ distort });
  const { data } = await worker.recognize(png);
  const read = clean(data.text);
  const found = TELLS.filter((t) => read.includes(t));
  console.log(`  distort ${distort}: tell-words read: [${found.join(', ') || 'none'}]`);
}

await worker.terminate();
console.log('\nDone.');
