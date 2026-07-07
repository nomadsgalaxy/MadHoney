// Proves the incident model closes the confirmed appeal lockout holes. No infra.
//   node test-incident.mjs
import assert from 'node:assert/strict';
import { makeIncidentId, resolutionRow, isIncidentResolved, incidentOf, reBanSource, resolvedIncidents } from './incident.js';

const U = 'user1';
const inc = makeIncidentId('A', U, 1000);
assert.equal(inc, 'inc_A_user1_1000', 'stable incident id');

// --- Scenario: honeypot ban in A, ban-share propagates to B, appeal approved ---
// origin + propagated rows share the incidentId
let rows = [
  { id: U, guildId: 'A', at: 't1', incidentId: inc },                 // origin ban
  { id: U, guildId: 'B', at: 't2', channel: '(ban-share)', incidentId: inc }, // propagation
];
// before appeal: rejoining A must be re-banned (B still holds the incident)
assert.equal(reBanSource(U, 'A', rows), 'B', 'pre-appeal: B blocks rejoin of A');
assert.equal(reBanSource(U, 'B', rows), 'A', 'pre-appeal: A blocks rejoin of B');
assert.equal(incidentOf(U, 'A', rows), inc, 'incidentOf finds origin incident');

// appeal approved -> ONE resolution row clears the whole incident network-wide
rows.push(resolutionRow(inc, 'operator', 't3'));
assert.equal(isIncidentResolved(inc, rows), true, 'incident marked resolved');
assert.equal(reBanSource(U, 'A', rows), null, 'THE FIX: no re-ban of A after resolution');
assert.equal(reBanSource(U, 'B', rows), null, 'THE FIX: no re-ban of B after resolution — network-wide');

// --- a DIFFERENT, unresolved incident must still re-ban ---
const inc2 = makeIncidentId('C', U, 5000);
rows.push({ id: U, guildId: 'C', at: 't4', incidentId: inc2 });
assert.equal(reBanSource(U, 'A', rows), 'C', 'unrelated live incident still blocks');

// --- manual ban with NO incidentId must NOT be silently cleared by any resolution ---
rows = [{ id: U, guildId: 'D', at: 't1' }]; // legacy/manual row, no incidentId
assert.equal(reBanSource(U, 'E', rows), 'D', 'manual/legacy ban still blocks (no incident to resolve)');
rows.push(resolutionRow('inc_bogus', 'x', 't2'));
assert.equal(reBanSource(U, 'E', rows), 'D', 'a resolution for a different incident cannot lift a manual ban');

// --- an unbanned origin (mod Undo) drops it from the fold regardless of incident ---
rows = [
  { id: U, guildId: 'A', at: 't1', incidentId: inc },
  { id: U, guildId: 'A', at: 't2', unbanned: true }, // Undo in A
];
assert.equal(reBanSource(U, 'B', rows), null, 'A no longer a source after Undo');
assert.equal(incidentOf(U, 'A', rows), null, 'incidentOf null when latest row is unbanned');

// --- noShare: an ungated+unverified origin does NOT contribute to the network ---
// (theshork case: Lemontron false-banned a real member; its catch must not propagate)
rows = [{ id: U, guildId: 'F', at: 't1', incidentId: makeIncidentId('F', U, 9000), noShare: true }];
assert.equal(reBanSource(U, 'G', rows), null, 'noShare origin never propagates to other servers');
// but a normal (shareable) ban elsewhere still blocks, even alongside a noShare one
rows.push({ id: U, guildId: 'H', at: 't2', incidentId: makeIncidentId('H', U, 9500) });
assert.equal(reBanSource(U, 'G', rows), 'H', 'a shareable ban still blocks past a noShare one');
assert.equal(reBanSource(U, 'H', rows), null, 'the noShare guild F is still not a source for H');

// resolvedIncidents ignores real-guild rows
assert.equal(resolvedIncidents([{ guildId: 'A', incidentId: inc, resolved: true }]).size, 0, 'a real-guild row is never a resolution');

console.log('ok - incident model closes the confirmed lockout holes (all assertions pass)');
