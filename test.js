// npm test - checks the pure logic. No Discord, no network.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { shouldTrap, honeypotMode } from './trap.js';
import { makeCode, answerOk } from './verify.js';
import { bannedElsewhere, trappedCount, appealableGuildIds, banEpoch } from './store.js';
import { renderBanner } from './banner.js';
import { renderCaptcha } from './captcha.js';
import { t, SUPPORTED, resolveLocale } from './i18n.js';

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
assert.equal(shouldTrap(base, { ...cfg, honeypotEnabled: false }), false, 'legacy disarmed → no');
assert.equal(shouldTrap(base, { ...cfg, honeypotMode: 'disarmed' }), false, 'disarmed → no');
assert.equal(shouldTrap(base, { ...cfg, honeypotMode: 'armed' }), true, 'armed → yes');
assert.equal(shouldTrap(base, { ...cfg, honeypotMode: 'review' }), true, 'review still trips (mode decides action)');
assert.equal(honeypotMode({}), 'armed', 'default mode is armed');
assert.equal(honeypotMode({ honeypotEnabled: false }), 'disarmed', 'legacy flag maps to disarmed');

// captcha logic
const code = makeCode(5, () => 0.42);
assert.equal(code.length, 5);
assert.ok(answerOk(` ${code.toLowerCase()} `, code), 'case/space-insensitive match');
assert.ok(!answerOk('nope!', code));

// universal ban list: every catch counts; opting out only stops applying it
const rows = [
  { id: 'u1', guildId: 'A' },
  { id: 'u2', guildId: 'C' },
  { id: 'u3', guildId: 'A' }, { id: 'u3', guildId: 'A', unbanned: true },
];
assert.ok(bannedElsewhere('u1', 'B', rows), 'banned in guild A → on the universal list');
assert.ok(!bannedElsewhere('u1', 'A', rows), 'own guild does not count');
assert.ok(bannedElsewhere('u2', 'B', rows), 'even an isolated guild\'s catches feed the list');
assert.ok(!bannedElsewhere('u3', 'B', rows), 'unban reverses the entry');

// appeal targets: only servers the user is actively banned in AND opted in
const agGuilds = { A: { appealEnabled: true, logChannelId: 'L' }, B: { appealEnabled: false, logChannelId: 'L' }, C: { appealEnabled: true } };
const agRows = [{ id: 'x', guildId: 'A' }, { id: 'x', guildId: 'B' }, { id: 'x', guildId: 'C' }, { id: 'x', guildId: 'D' }];
const ag = appealableGuildIds('x', agGuilds, agRows);
assert.deepEqual(ag, ['A'], 'appeal: only opted-in+logchannel+banned server (A); not B (opted out), C (no log), D (unknown/not-in-before)');
assert.deepEqual(appealableGuildIds('nobody', agGuilds, agRows), [], 'no bans -> no appeal targets');

// ban episode: latest un-reversed ban `at` per (user,guild); one appeal per episode
const beRows = [
  { id: 'z', guildId: 'A', at: 'T1' },
  { id: 'z', guildId: 'A', at: 'T2', unbanned: true }, // unbanned...
  { id: 'z', guildId: 'A', at: 'T3' },                 // ...then re-banned = new episode
  { id: 'z', guildId: 'B', at: 'T4' },
];
assert.equal(banEpoch('z', 'A', beRows), 'T3', 'episode = latest un-reversed ban');
assert.equal(banEpoch('z', 'B', beRows), 'T4', 'banned in B');
assert.equal(banEpoch('z', 'C', beRows), null, 'not banned in C -> no episode');
assert.equal(banEpoch('nobody', 'A', beRows), null, 'unknown user -> no episode');
assert.equal(banEpoch('q', 'A', [{ id: 'q', guildId: 'A', at: 'T1' }, { id: 'q', guildId: 'A', at: 'T2', unbanned: true }]), null,
  'currently unbanned -> no episode (appeal closed)');

// trapped count: distinct users, not raw log lines
const trows = [
  { id: 'a', guildId: 'G1' }, { id: 'a', guildId: 'G2' },       // same user, 2 servers -> 1
  { id: 'a', guildId: 'G1', channel: '(ban-sync)' },            // propagation dup -> still 1
  { id: 'b', guildId: 'G1' },                                    // +1
  { id: 'c', guildId: 'G1' }, { id: 'c', guildId: 'G1', unbanned: true }, // unbanned -> 0
];
assert.equal(trappedCount(trows), 2, 'a and b count once each; c is unbanned');

// renderers produce PNGs
const png = (buf) => buf.length > 800 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
assert.ok(png(renderCaptcha('AB3DE')), 'captcha renders a PNG');
assert.ok(png(await renderBanner({})), 'default banner renders a PNG');
assert.ok(png(await renderBanner({ title: 'STOP', text: 'x '.repeat(200), font: 'monospace', logoUrl: 'not-a-url' })),
  'long text + bad logo URL still renders');
assert.ok(png(await renderBanner({
  text: 'Verify in #rules or ping @Staff about it.',
  mentionMode: 'role', roleColors: { '@staff': '#e91e63' },
})), 'mention pills render');

// i18n: locale resolution, interpolation, fallback, and full catalog parity
assert.equal(resolveLocale('es-ES'), 'es', 'es-ES -> es');
assert.equal(resolveLocale('sv-SE'), 'sv', 'sv-SE -> sv');
assert.equal(resolveLocale('pt-BR'), 'pt-BR', 'exact pt-BR');
assert.equal(resolveLocale('en-US'), 'en', 'en-US -> en');
assert.equal(resolveLocale('zz'), 'en', 'unknown -> en');
assert.equal(resolveLocale(undefined), 'en', 'undefined -> en');
assert.equal(t('verify.button', 'en'), 'Verify');
assert.equal(t('verify.button', 'es'), 'Verificar');
assert.ok(t('verify.success', 'de', { guild: 'Foo' }).includes('Foo'), 'interpolates {guild}');
assert.ok(t('verify.wrong', 'en', { left: 3 }).includes('(3 left)'), 'interpolates {left}');
assert.equal(t('does.not.exist', 'es'), 'does.not.exist', 'unknown key -> key itself');

// every shipped locale has EXACTLY en's keys, and each string keeps en's {placeholders}
const enCat = JSON.parse(readFileSync(new URL('./locales/en.json', import.meta.url)));
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
const phs = (s) => (String(s).match(/\{\w+\}/g) || []).sort();
const enKeys = flat(enCat).sort();
for (const code of SUPPORTED) {
  if (code === 'en') continue;
  const cat = JSON.parse(readFileSync(new URL(`./locales/${code}.json`, import.meta.url)));
  assert.deepEqual(flat(cat).sort(), enKeys, `${code}: same keys as en`);
  const walk = (en, tr, p = '') => { for (const [k, v] of Object.entries(en)) { if (v && typeof v === 'object') walk(v, tr[k], `${p}${k}.`); else assert.deepEqual(phs(tr[k]), phs(v), `${code}: ${p}${k} keeps placeholders`); } };
  walk(enCat, cat);
}

console.log('ok');
