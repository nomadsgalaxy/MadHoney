// npm test - checks the pure logic. No Discord, no network.
import assert from 'node:assert';
import { shouldTrap } from './trap.js';
import { makeCode, answerOk } from './verify.js';
import { bannedElsewhere } from './store.js';
import { renderBanner } from './banner.js';
import { renderCaptcha } from './captcha.js';

const cfg = { honeypotChannelId: 'HONEY' };
const base = { channelId: 'HONEY', authorIsBot: false, isOwner: false, isStaff: false };

// trap
assert.equal(shouldTrap(base, cfg), true, 'spammer in honeypot → trap');
assert.equal(shouldTrap({ ...base, channelId: 'other' }, cfg), false, 'other channel → no');
assert.equal(shouldTrap({ ...base, authorIsBot: true }, cfg), false, 'bot → no');
assert.equal(shouldTrap({ ...base, isStaff: true }, cfg), false, 'staff → no');
assert.equal(shouldTrap({ ...base, isOwner: true }, cfg), false, 'owner → no');
assert.equal(shouldTrap(base, null), false, 'unconfigured guild → no');
assert.equal(shouldTrap(base, {}), false, 'no honeypot set → no');

// captcha logic
const code = makeCode(5, () => 0.42);
assert.equal(code.length, 5);
assert.ok(answerOk(` ${code.toLowerCase()} `, code), 'case/space-insensitive match');
assert.ok(!answerOk('nope!', code));

// ban sharing
const guilds = { A: { banShare: true }, B: { banShare: true }, C: { banShare: false } };
const rows = [
  { id: 'u1', guildId: 'A' },
  { id: 'u2', guildId: 'C' },
  { id: 'u3', guildId: 'A' }, { id: 'u3', guildId: 'A', unbanned: true },
];
assert.ok(bannedElsewhere('u1', 'B', guilds, rows), 'banned in sharing guild A → banned elsewhere');
assert.ok(!bannedElsewhere('u1', 'A', guilds, rows), 'own guild does not count');
assert.ok(!bannedElsewhere('u2', 'B', guilds, rows), 'isolated guild C does not share');
assert.ok(!bannedElsewhere('u3', 'B', guilds, rows), 'unban reverses the share');

// renderers produce PNGs
const png = (buf) => buf.length > 800 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
assert.ok(png(renderCaptcha('AB3DE')), 'captcha renders a PNG');
assert.ok(png(await renderBanner({})), 'default banner renders a PNG');
assert.ok(png(await renderBanner({ title: 'STOP', text: 'x '.repeat(200), font: 'monospace', logoUrl: 'not-a-url' })),
  'long text + bad logo URL still renders');

console.log('ok');
