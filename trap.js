// Staff / dashboard-admin roles: multiple allowed via staffRoleIds[] /
// adminRoleIds[], with back-compat for the legacy single staffRoleId /
// adminRoleId. Deduped; empties dropped.
export const staffRoles = (cfg) => [...new Set([...(cfg?.staffRoleIds ?? []), cfg?.staffRoleId].filter(Boolean))];
export const adminRoles = (cfg) => [...new Set([...(cfg?.adminRoleIds ?? []), cfg?.adminRoleId].filter(Boolean))];

// The honeypot's mode: 'armed' (auto-ban, default), 'review' (hold each hit for
// a mod to approve), or 'disarmed' (off). Falls back to the legacy
// honeypotEnabled flag for configs saved before modes existed.
export function honeypotMode(cfg) {
  if (!cfg) return 'disarmed';
  if (['armed', 'review', 'disarmed'].includes(cfg.honeypotMode)) return cfg.honeypotMode;
  return cfg.honeypotEnabled === false ? 'disarmed' : 'armed';
}

// Pure decision: should this message trip the honeypot at all? (The mode then
// decides whether that means ban-now or hold-for-review.) Kept separate from
// Discord I/O so it's testable (see test.js).
export function shouldTrap(facts, cfg) {
  if (!cfg?.honeypotChannelId) return false; // guild not configured
  if (honeypotMode(cfg) === 'disarmed') return false; // trap is off
  if (facts.channelId !== cfg.honeypotChannelId) return false; // wrong channel
  if (facts.authorIsBot) return false; // ignore bots (incl. self)
  if (facts.isOwner || facts.isStaff) return false; // never nuke staff
  return true;
}
