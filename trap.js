// Pure decision: should this message trigger the honeypot ban?
// Kept separate from Discord I/O so it's testable (see test.js).
export function shouldTrap(facts, cfg) {
  if (!cfg?.honeypotChannelId) return false; // guild not configured
  if (facts.channelId !== cfg.honeypotChannelId) return false; // wrong channel
  if (facts.authorIsBot) return false; // ignore bots (incl. self)
  if (facts.isOwner || facts.isStaff) return false; // never nuke staff
  return true;
}
