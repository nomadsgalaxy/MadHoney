// Regression test for the pure helpers behind the preflight health check.
// (preflight() itself hits the Discord API and is covered by manual/integration
// checks.) Run: node test-preflight.mjs
import assert from 'node:assert';
import { dangerousRolePerms, contentGatedChannels, DANGEROUS_ROLE_PERMS, missingFeaturePerms, FEATURE_REQUIREMENTS } from '../src/actions.js';

// --- dangerousRolePerms: which dangerous bits are literally set on the role ---
assert.deepEqual(dangerousRolePerms(0n), []);
assert.deepEqual(dangerousRolePerms(1n << 3n), ['Administrator']);           // the Pezliz bug
assert.deepEqual(dangerousRolePerms(1n << 2n), ['Ban Members']);
assert.deepEqual(dangerousRolePerms(1n << 1n), ['Kick Members']);
assert.deepEqual(dangerousRolePerms(1n << 5n), ['Manage Server']);
assert.deepEqual(dangerousRolePerms(1n << 28n), ['Manage Roles']);
assert.deepEqual(dangerousRolePerms(1n << 4n), ['Manage Channels']);
assert.deepEqual(dangerousRolePerms(1n << 11n), []);                          // Send Messages is not dangerous
// combined, reported in DANGEROUS_ROLE_PERMS order
assert.deepEqual(dangerousRolePerms((1n << 3n) | (1n << 2n)), ['Administrator', 'Ban Members']);
assert.deepEqual(dangerousRolePerms('8'), ['Administrator']); // accepts a string bitfield
// Administrator alone means grandfather() blocks (it's in the returned set)
assert.ok(dangerousRolePerms(1n << 3n).includes('Administrator'));

// --- contentGatedChannels: gated channels excluding the verify gateway + honeypot ---
assert.deepEqual(contentGatedChannels({ gatedChannels: ['c1', 'v', 'h'], verifyChannelId: 'v', honeypotChannelId: 'h' }), ['c1']);
assert.deepEqual(contentGatedChannels({ gatedChannels: ['v', 'h'], verifyChannelId: 'v', honeypotChannelId: 'h' }), []); // nothing real gated
assert.deepEqual(contentGatedChannels({}), []);
assert.deepEqual(contentGatedChannels({ gatedChannels: ['c1', 'c2'], verifyChannelId: 'v', honeypotChannelId: 'h' }), ['c1', 'c2']);

// sanity: the dangerous set includes exactly the perms we refuse to hand out broadly
assert.deepEqual(Object.keys(DANGEROUS_ROLE_PERMS).sort(),
  ['Administrator', 'Ban Members', 'Kick Members', 'Manage Channels', 'Manage Roles', 'Manage Server']);

// ---- every enabled feature must declare the permissions it needs ----
// A permission gap should never silently make an enabled feature do nothing.
const ALL = ['ManageRoles','ManageChannels','BanMembers','KickMembers','ManageMessages'];
const hasAll = () => true;
const hasNone = () => false;
const hasAllBut = (...missing) => (f) => ALL.includes(f) && !missing.includes(f);
const full = { verificationEnabled: true, verifiedRoleId: 'r', gatedChannels: ['a'], honeypotChannelId: 'h', banShare: true, appealEnabled: true };
const comp = { enabled: true, action: 'kick', deleteMessages: true };
const ctx = (over = {}) => ({ hpMode: 'armed', escalate: true, comp, ...over });
const keys = (gaps) => gaps.map((g) => g.key).sort();

// nothing missing when the bot has everything
assert.deepEqual(missingFeaturePerms(full, hasAll, ctx()), []);

// the ladder's kick, and a compromised action of kick, both need Kick Members
assert.deepEqual(keys(missingFeaturePerms(full, hasAllBut('KickMembers'), ctx())), ['compromised', 'escalation']);

// a DISABLED feature is never reported - only what the server actually turned on
assert.equal(keys(missingFeaturePerms({ ...full, banShare: false, appealEnabled: false }, hasAllBut('BanMembers'), ctx()))
  .includes('banlist'), false, 'ban list off -> not reported');
assert.ok(keys(missingFeaturePerms(full, hasAllBut('BanMembers'), ctx())).includes('banlist'));

// a disarmed honeypot needs neither ban nor the kick ladder
assert.deepEqual(keys(missingFeaturePerms({ honeypotChannelId: 'h' }, hasNone, ctx({ hpMode: 'disarmed', comp: { enabled: false } }))), []);

// quarantine needs Manage Roles; notify needs nothing of its own
assert.ok(missingFeaturePerms({ honeypotChannelId: 'h' }, hasAllBut('ManageRoles'),
  ctx({ hpMode: 'disarmed', comp: { enabled: true, action: 'quarantine', deleteMessages: false } }))
  .some((g) => g.key === 'compromised' && g.missing.includes('Manage Roles')));
assert.deepEqual(missingFeaturePerms({}, hasAllBut('KickMembers', 'BanMembers'),
  ctx({ hpMode: 'disarmed', comp: { enabled: true, action: 'notify', deleteMessages: false } })), []);

// deleting the spam needs Manage Messages regardless of the action chosen
assert.ok(missingFeaturePerms({}, hasAllBut('ManageMessages'),
  ctx({ hpMode: 'disarmed', comp: { enabled: true, action: 'notify', deleteMessages: true } }))
  .some((g) => g.missing.includes('Manage Messages')));

// each requirement carries an i18n label so the warning names the card to fix it in
for (const f of FEATURE_REQUIREMENTS) {
  assert.ok(typeof f.label === 'string' && f.label.includes('.'), `${f.key} needs an i18n label`);
  assert.equal(typeof f.on, 'function');
}
// missing permissions are de-duplicated per feature
const dup = missingFeaturePerms(full, hasNone, ctx({ comp: { enabled: true, action: 'ban', deleteMessages: true } }));
for (const g of dup) assert.equal(g.missing.length, new Set(g.missing).size, `${g.key} lists a permission twice`);

console.log('ok');
