// Regression test for raid-mode burst detection.
// This exists because of KORWiN Gaming (2026-07-31): the honeypot removed 33
// accounts in six minutes and never questioned it. Raid mode trips early and
// switches to the reversible action instead of guessing why the burst happened.
// Run: node test/test-raid.mjs
import assert from 'node:assert';
import { raidSettings, recordCatch, inRaid, sweep, priorOffenses, chooseAction } from '../src/raid.js';

// --- settings: sane defaults, clamped ---
const d = raidSettings(undefined);
assert.deepEqual([d.enabled, d.threshold, d.windowSec, d.cooldownSec, d.escalate], [true, 5, 180, 600, true]);
// settings now live under compromised (raid is an extension of that feature)
assert.equal(raidSettings({ compromised: { raid: { threshold: 9 } } }).threshold, 9);
assert.equal(raidSettings({ raid: { threshold: 7 } }).threshold, 7, 'legacy top-level raid config still honoured');
assert.equal(raidSettings({ raid: { enabled: false } }).enabled, false);
assert.equal(raidSettings({ raid: { threshold: 1 } }).threshold, 2);      // clamp low
assert.equal(raidSettings({ raid: { threshold: 999 } }).threshold, 50);   // clamp high
assert.equal(raidSettings({ raid: { windowSec: 1 } }).windowSec, 5);
assert.equal(raidSettings({ raid: { cooldownSec: 99999 } }).cooldownSec, 3600);

const O = { threshold: 5, windowSec: 60, cooldownSec: 600 };
const G = 'guild1';

// --- THE KORWIN CASE: 33 catches ~11s apart should trip at the 5th, not the 33rd ---
{
  const s = new Map();
  let engagedAt = null;
  for (let i = 0; i < 33; i++) {
    const r = recordCatch(s, G, i * 11000, O);
    if (r.engaged) engagedAt = i + 1;
  }
  assert.equal(engagedAt, 5, 'raid mode engages on the 5th catch');
  assert.ok(inRaid(s, G, 33 * 11000, O), 'still in raid mode during the burst');
}

// --- engaged fires exactly ONCE, so mods get one alert, not 29 ---
{
  const s = new Map();
  const flags = [];
  for (let i = 0; i < 10; i++) flags.push(recordCatch(s, G, i * 1000, O).engaged);
  assert.equal(flags.filter(Boolean).length, 1, 'engaged is true exactly once per burst');
}

// --- a slow trickle never trips it: 4 catches spread beyond the window ---
{
  const s = new Map();
  let any = false;
  for (let i = 0; i < 8; i++) any = recordCatch(s, G, i * 30000, O).raid || any; // 30s apart
  assert.equal(any, false, 'two catches per window is normal, not a raid');
}

// --- exactly at the threshold trips; one below does not ---
{
  const s = new Map();
  for (let i = 0; i < 4; i++) assert.equal(recordCatch(s, G, i * 1000, O).raid, false);
  assert.equal(recordCatch(s, G, 4000, O).raid, true, '5th catch in-window trips it');
}

// --- stands down after the cooldown, and a later burst re-engages ---
{
  const s = new Map();
  for (let i = 0; i < 5; i++) recordCatch(s, G, i * 1000, O);
  assert.ok(inRaid(s, G, 5000, O));
  const quiet = 5000 + O.cooldownSec * 1000 + 1000;
  assert.equal(inRaid(s, G, quiet, O), false, 'stands down once quiet');
  // a fresh burst much later must engage again (not be swallowed by stale state)
  let re = null;
  for (let i = 0; i < 5; i++) { const r = recordCatch(s, G, quiet + i * 1000, O); if (r.engaged) re = i + 1; }
  assert.equal(re, 5, 'a later burst engages again');
}

// --- per-guild isolation: one server raiding must not flag another ---
{
  const s = new Map();
  for (let i = 0; i < 6; i++) recordCatch(s, 'raided', i * 1000, O);
  assert.ok(inRaid(s, 'raided', 6000, O));
  assert.equal(inRaid(s, 'calm', 6000, O), false);
  assert.equal(recordCatch(s, 'calm', 6000, O).raid, false, 'a single catch elsewhere is not a raid');
}

// --- sweep drops quiet guilds ---
{
  const s = new Map();
  recordCatch(s, G, 1000, O);
  sweep(s, 1000 + O.cooldownSec * 2000 + 1, O);
  assert.equal(s.size, 0, 'quiet guild pruned');
  recordCatch(s, G, 5_000_000, O);
  sweep(s, 5_000_000, O);
  assert.equal(s.size, 1, 'active guild kept');
}

// ---- the offence ladder: never ban or share on a first offence ----
const row = (id, guildId, extra = {}) => ({ id, guildId, ...extra });

// no history at all
assert.equal(priorOffenses([], 'g', 'u'), 0);
// one prior catch in this guild
assert.equal(priorOffenses([row('u', 'g')], 'g', 'u'), 1);
// catches in OTHER guilds do not count toward this guild's ladder
assert.equal(priorOffenses([row('u', 'other'), row('u', 'other')], 'g', 'u'), 0);
// a moderator reversal forgives the history - being unbanned must not make the
// next mistake harsher
assert.equal(priorOffenses([row('u', 'g'), row('u', 'g', { unbanned: true })], 'g', 'u'), 0);
// ...and offences after a reversal start counting again
assert.equal(priorOffenses([row('u', 'g'), row('u', 'g', { unbanned: true }), row('u', 'g')], 'g', 'u'), 1);

// ---- what happens to a catch ----
// Measured over every catch on record: only 1% of (server,account) pairs are ever
// caught twice, so a blanket first-offence kick would stop banning ~99% of spam
// bots and starve the shared list. The reversible action is therefore gated on a
// BURST - the only signal that has ever indicated a misconfiguration.

// THE 99% CASE: an isolated catch is a spam bot. Ban it, and protect the network.
assert.deepEqual(chooseAction({}), { action: 'ban', share: true, reason: 'catch' });
assert.deepEqual(chooseAction({ prior: 0, raid: false }), { action: 'ban', share: true, reason: 'catch' });

// Inside a burst the cause is unknown -> reversible, and nothing is shared.
assert.deepEqual(chooseAction({ raid: true }), { action: 'kick', share: false, reason: 'burst, first offence' });
// a repeat inside the burst bans, but an unconfirmed burst still never shares
assert.deepEqual(chooseAction({ raid: true, prior: 1 }), { action: 'ban', share: false, reason: 'burst, repeat offence' });
// an account already on the shared list is not made innocent by a burst
assert.deepEqual(chooseAction({ raid: true, knownSpammer: true }), { action: 'ban', share: true, reason: 'already on the shared list' });
// a server can opt out of the reversible step entirely
assert.deepEqual(chooseAction({ raid: true, escalate: false }), { action: 'ban', share: false, reason: 'burst, repeat offence' });

// KORWIN REPLAY: 33 distinct accounts in one burst -> nothing banned, nothing shared
{
  const store = new Map(); const ledger = [];
  let bans = 0, shared = 0, kicks = 0;
  for (let i = 0; i < 33; i++) {
    const uid = 'member' + i;
    const b = recordCatch(store, 'korwin', i * 11000, O);
    const v = chooseAction({ prior: priorOffenses(ledger, 'korwin', uid), raid: b.raid, escalate: true });
    if (v.action === 'ban') bans++; else kicks++;
    if (v.share) shared++;
    ledger.push(row(uid, 'korwin'));
  }
  // the first four arrive before the burst trips, so they ban as normal catches
  assert.equal(bans, 4, 'only the pre-burst catches ban');
  assert.equal(kicks, 29, 'once the burst is detected the rest are kicked');
  assert.equal(shared, 4, 'the burst itself never reaches the shared list');
}

// NORMAL WEEK REPLAY: isolated catches on quiet servers all ban and all share
{
  const store = new Map(); const ledger = [];
  let bans = 0, shared = 0;
  for (let i = 0; i < 20; i++) {                       // one catch per hour
    const uid = 'spambot' + i;
    const b = recordCatch(store, 'quiet', i * 3600_000, O);
    const v = chooseAction({ prior: priorOffenses(ledger, 'quiet', uid), raid: b.raid, escalate: true });
    if (v.action === 'ban') bans++;
    if (v.share) shared++;
    ledger.push(row(uid, 'quiet'));
  }
  assert.equal(bans, 20, 'every ordinary spam bot is still banned');
  assert.equal(shared, 20, 'and still feeds the shared ban list');
}

console.log('ok');
