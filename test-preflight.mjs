// Regression test for the pure helpers behind the preflight health check.
// (preflight() itself hits the Discord API and is covered by manual/integration
// checks.) Run: node test-preflight.mjs
import assert from 'node:assert';
import { dangerousRolePerms, contentGatedChannels, DANGEROUS_ROLE_PERMS } from './actions.js';

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

console.log('ok');
