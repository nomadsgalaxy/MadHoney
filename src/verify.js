// Pure challenge logic, kept out of Discord/canvas I/O so it's testable (test.js).
// Ambiguous glyphs (0/O, 1/I/L) removed so humans don't fail on a typo.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeCode(len = 5, rand = Math.random) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

export function answerOk(input, answer) {
  return String(input).trim().toUpperCase() === String(answer).toUpperCase();
}
