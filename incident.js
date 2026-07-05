// Incident model for the ban ledger — the keystone of the appeal overhaul.
//
// An "incident" is one spam/compromise event. The ORIGIN ban stamps a stable
// incidentId into its row; every propagated row (ban-share, bansync) copies it.
// Resolving an appeal appends ONE ledger row that clears the whole incident
// network-wide, so a recovered user isn't re-banned on rejoin and doesn't have
// to appeal each server separately.
//
// Deliberately reuses the existing append-only ban ledger + its fold semantics
// (latest-row-wins) instead of a new table: an incident is resolved iff a
// resolution row exists for its id. Pure functions here; each store
// (store.js, store.d1.js, verify-worker/src/store.js) imports and wires them.
// ponytail: incidentId is a plain field on the row JSON — no schema migration.

// Stamp an id on an origin ban. Stable, sortable, no RNG needed for uniqueness
// (guild+user+ms is unique enough for one origin event); callers pass the ms so
// this stays deterministic/testable (no Date.now() here).
export const makeIncidentId = (guildId, userId, atMs) => `inc_${guildId}_${userId}_${atMs}`;

// A resolution is recorded as a special ledger row: { incidentId, resolved:true,
// guildId:'incident', ... }. guildId:'incident' keeps it out of per-guild folds
// (it's not a ban/unban of any real guild) while still living in the one ledger.
export const RESOLUTION_GUILD = 'incident';
export const resolutionRow = (incidentId, by, atIso) =>
  ({ guildId: RESOLUTION_GUILD, incidentId, resolved: true, by, at: atIso });

// Set of incidentIds that have been resolved (appeal approved). One pass.
export function resolvedIncidents(rows) {
  const set = new Set();
  for (const r of rows) if (r.guildId === RESOLUTION_GUILD && r.resolved && r.incidentId) set.add(r.incidentId);
  return set;
}
export const isIncidentResolved = (incidentId, rows) =>
  Boolean(incidentId) && resolvedIncidents(rows).has(incidentId);

// The incident a user's CURRENT ban in a guild belongs to: the incidentId of the
// latest un-reversed ban row for (user,guild), or null. Mirrors banEpoch's fold
// but returns the incident tag instead of the timestamp.
export function incidentOf(userId, guildId, rows) {
  let inc = null;
  for (const r of rows) {
    if (r.id !== userId || r.guildId !== guildId) continue;
    inc = r.unbanned ? null : (r.incidentId ?? inc);
  }
  return inc;
}

// THE re-ban guard. ban-share (GuildMemberAdd) and bansync both call this before
// acting on the shared list. A user should be (re)banned in `guild` only if some
// OTHER guild has them currently banned AND that ban's incident is NOT resolved.
// This kills the confirmed lockout loop: once an appeal resolves the incident,
// no server re-applies it. Returns the blocking guildId, or null if clear.
export function reBanSource(userId, guild, rows) {
  const resolved = resolvedIncidents(rows);
  const latest = new Map(); // guildId -> { banned, incidentId }
  for (const r of rows) {
    if (r.id !== userId || r.guildId === RESOLUTION_GUILD) continue;
    latest.set(r.guildId, { banned: !r.unbanned, incidentId: r.incidentId });
  }
  for (const [g, s] of latest) {
    if (g === guild || !s.banned) continue;
    if (s.incidentId && resolved.has(s.incidentId)) continue; // appeal cleared it network-wide
    return g;
  }
  return null;
}
