// Staff / dashboard-admin roles: multiple allowed via staffRoleIds[] /
// adminRoleIds[], with back-compat for the legacy single staffRoleId /
// adminRoleId. Deduped; empties dropped.
export const staffRoles = (cfg) => [...new Set([...(cfg?.staffRoleIds ?? []), cfg?.staffRoleId].filter(Boolean))];
export const adminRoles = (cfg) => [...new Set([...(cfg?.adminRoleIds ?? []), cfg?.adminRoleId].filter(Boolean))];

// Every setup step EXCEPT arming is done. Mirrors the dashboard checklist's
// done.config/gf/panels/gate (dashboard.js) - keep the two in sync. Used to
// decide whether an unset honeypot mode should default to review (mid-setup) or
// armed (ready). All fields come from the stored config, so it's pure.
export function setupComplete(cfg) {
  if (!cfg?.honeypotChannelId) return false;
  const verifyOn = cfg.verificationEnabled !== false;
  if (!verifyOn) return Boolean(cfg.bannerPosted); // honeypot-only: banner is the last step
  return Boolean(cfg.verifiedRoleId && cfg.verifyChannelId)            // core config
    && (Boolean(cfg.grandfatheredAt) || Boolean(cfg.grandfatherSkipped)) // grandfather
    && Boolean(cfg.verifyPosted) && Boolean(cfg.bannerPosted)           // panels posted
    && (cfg.gatedChannels?.length ?? 0) > 0;                            // channels gated
}

// The honeypot's mode: 'armed' (auto-ban), 'review' (hold each hit for a mod to
// approve), or 'disarmed' (off). An explicit choice always wins. With no explicit
// choice, it holds catches for review DURING setup - safe if the honeypot isn't
// hidden from members yet - and auto-arms once every setup step is done. Falls
// back to the legacy honeypotEnabled flag for configs saved before modes existed.
export function honeypotMode(cfg) {
  if (!cfg) return 'disarmed';
  if (['armed', 'review', 'disarmed'].includes(cfg.honeypotMode)) return cfg.honeypotMode;
  if (cfg.honeypotEnabled === false) return 'disarmed';
  return setupComplete(cfg) ? 'armed' : 'review';
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
