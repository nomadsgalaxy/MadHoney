// Regression test for surgical gating: the snapshot / exact-restore state
// machine and the custom-permission detector. These are what guarantee gating
// never tramples a server's existing permission setup (the Prusa lesson).
// Run: node test/test-gating.mjs
import assert from 'node:assert';
import { GATE_BITS, snapshotOverwrite, restorePatch, onlyManagedBits, hasCustomRoleDeny } from '../src/actions.js';
import { OverwriteType } from 'discord.js';

const V = GATE_BITS.v, S = GATE_BITS.s, M = GATE_BITS.m, R = GATE_BITS.r;

// --- snapshotOverwrite: records exactly what was there ---
assert.deepEqual(snapshotOverwrite(null, ['v']), { x: 1, v: 'n' });                       // no overwrite existed
assert.deepEqual(snapshotOverwrite({ allow: V, deny: 0n }, ['v']), { v: 'a' });           // explicit allow
assert.deepEqual(snapshotOverwrite({ allow: 0n, deny: V }, ['v']), { v: 'd' });           // explicit deny
assert.deepEqual(snapshotOverwrite({ allow: 0n, deny: 0n }, ['v']), { v: 'n' });          // overwrite exists, bit neutral
assert.deepEqual(snapshotOverwrite({ allow: V, deny: S }, ['v', 's']), { v: 'a', s: 'd' }); // read-only channel: View allow + Send deny
assert.deepEqual(snapshotOverwrite(null, ['v', 'm', 'r']), { x: 1, v: 'n', m: 'n', r: 'n' }); // bot pin from nothing

// --- restorePatch: snapshot -> the exact edit() that undoes us ---
assert.deepEqual(restorePatch({ v: 'a' }), { ViewChannel: true });    // explicit allow comes BACK as allow
assert.deepEqual(restorePatch({ v: 'd' }), { ViewChannel: false });   // explicit deny comes back as deny
assert.deepEqual(restorePatch({ v: 'n' }), { ViewChannel: null });    // neutral comes back neutral
assert.deepEqual(restorePatch({ x: 1, v: 'n', m: 'n', r: 'n' }),      // x flag itself is not a permission
  { ViewChannel: null, ManageMessages: null, ReadMessageHistory: null });
// THE PRUSA CASE: pre-existing read-only channel (@everyone Send deny) that got
// gated. Restore must bring back the Send deny, not blank it to postable.
assert.deepEqual(restorePatch({ v: 'a', s: 'd' }), { ViewChannel: true, SendMessages: false });

// --- onlyManagedBits: may we DELETE the overwrite we created? ---
const rec = { x: 1, v: 'n' };
assert.equal(onlyManagedBits({ allow: V, deny: 0n }, rec), true);       // only our View bit -> delete (restores category sync)
assert.equal(onlyManagedBits({ allow: 0n, deny: V }, rec), true);
assert.equal(onlyManagedBits({ allow: V | S, deny: 0n }, rec), false);  // admin added Send since -> must not delete their work
assert.equal(onlyManagedBits({ allow: V, deny: 1n << 6n }, rec), false); // admin added another deny -> keep
assert.equal(onlyManagedBits({ allow: V | M | R, deny: 0n }, { x: 1, v: 'n', m: 'n', r: 'n' }), true); // full bot pin -> delete

// --- hasCustomRoleDeny: channels hidden from specific roles need a human ---
const EV = 'everyone', VR = 'verified';
const roleOw = (id, deny) => ({ type: OverwriteType.Role, id, deny });
const memberOw = (id, deny) => ({ type: OverwriteType.Member, id, deny });
assert.equal(hasCustomRoleDeny([], EV, VR), false);                                    // plain channel
assert.equal(hasCustomRoleDeny([roleOw(EV, V)], EV, VR), false);                       // @everyone deny is OUR mechanism, not custom
assert.equal(hasCustomRoleDeny([roleOw(VR, V)], EV, VR), false);                       // verified deny = our honeypot/protect pattern
assert.equal(hasCustomRoleDeny([roleOw('muted', V)], EV, VR), true);                   // hidden from a specific role -> custom
assert.equal(hasCustomRoleDeny([roleOw('muted', S)], EV, VR), false);                  // role denied SEND only - gating View is safe
assert.equal(hasCustomRoleDeny([memberOw('user1', V)], EV, VR), false);                // member denies outrank role allows - gate can't leak
assert.equal(hasCustomRoleDeny([roleOw(EV, V), roleOw('bots', V)], EV, VR), true);     // mixed: the role deny still flags it

console.log('ok');
