// Escalation and raid mode - an extension of the compromised-account system.
//
// A honeypot catch has two possible meanings and nothing observable at the time
// tells them apart. Either it is a spam bot, or it is a member walking into the
// trap because the server told them to - a raid tool that auto-posts "verify" to
// beat a gate produces telemetry identical to real members typing the same word
// (KORWiN Gaming, 2026-07-31: 33 members removed in six minutes for posting
// "weryfikacja").
//
// So a FIRST offence never bans and never reaches the shared ban list. It kicks,
// which is reversible: a real member rejoins and verifies, while a spam bot
// trips the same trap again within seconds. The second offence is the confirmed
// one - that bans, and only then does it feed the network. The bot proves it is a
// bot by coming back; a confused human simply does not.
//
// Raid mode sits on top of that. It does not change the ladder - it exists to
// report a burst once instead of once per catch, to keep an unconfirmed burst out
// of the public trap feed, and to force noShare even on repeats while a server is
// clearly in trouble.

export function raidSettings(cfg) {
  // Raid/escalation settings live under `compromised` so the whole family is one
  // feature in config and in the dashboard; a legacy top-level `raid` still works.
  const r = cfg?.compromised?.raid ?? cfg?.raid ?? {};
  return {
    escalate: r.escalate !== false, // first offence kicks, repeat bans (default on)
    enabled: r.enabled !== false,                                            // default on
    threshold: Math.max(2, Math.min(50, Number(r.threshold) || 5)),          // catches...
    windowSec: Math.max(5, Math.min(600, Number(r.windowSec) || 60)),        // ...within this window
    cooldownSec: Math.max(30, Math.min(3600, Number(r.cooldownSec) || 600)), // quiet time before standing down
  };
}

// Record a catch and report the resulting state. `store` is a Map the caller
// owns: guildId -> { hits: number[], since: number }. `engaged` is true only on
// the single catch that trips it, so the caller alerts once, not once per catch.
export function recordCatch(store, guildId, now, opts) {
  const { threshold, windowSec, cooldownSec } = opts;
  const st = store.get(guildId) ?? { hits: [], since: 0 };
  const prev = st.hits.length ? st.hits[st.hits.length - 1] : undefined;
  // If we were in raid mode but it has been quiet for the cooldown, stand down
  // first so this catch is judged as the start of a fresh burst.
  if (st.since && prev !== undefined && now - prev > cooldownSec * 1000) {
    st.since = 0;
    st.hits = [];
  }
  st.hits = st.hits.filter((t) => now - t < windowSec * 1000);
  st.hits.push(now);
  let engaged = false;
  if (!st.since && st.hits.length >= threshold) { st.since = now; engaged = true; }
  store.set(guildId, st);
  return { raid: Boolean(st.since), engaged, count: st.hits.length };
}

// Is a guild in raid mode right now, without recording a catch?
export function inRaid(store, guildId, now, opts) {
  const st = store.get(guildId);
  if (!st?.since) return false;
  const last = st.hits.length ? st.hits[st.hits.length - 1] : 0;
  return now - last <= opts.cooldownSec * 1000;
}

// Forget guilds that have gone quiet, so the store cannot grow forever.
export function sweep(store, now, opts) {
  for (const [gid, st] of store) {
    const last = st.hits.length ? st.hits[st.hits.length - 1] : 0;
    if (now - last > opts.cooldownSec * 2000) store.delete(gid);
  }
}

// ---- the offence ladder ----
// How many times this user has been caught in THIS guild without a moderator
// reversing it. A reversal (unban, dismissed review, approved appeal) is a human
// saying the catch was wrong, so it resets the count - being forgiven should not
// make the next mistake harsher.
export function priorOffenses(rows, guildId, userId) {
  let n = 0;
  for (const r of rows) {
    if (r.guildId !== guildId || r.id !== userId) continue;
    if (r.unbanned) n = 0; else n += 1;
  }
  return n;
}

// What to do about a catch. `prior` is the count BEFORE this one.
//   first offence  -> kick, keep it local (nothing is proven yet)
//   repeat offence -> ban, and let it feed the shared list
// A raid never upgrades the action, and always keeps the catch local.
export function chooseAction({ prior = 0, raid = false, escalate = true } = {}) {
  if (!escalate) return { action: 'ban', share: !raid, reason: 'escalation disabled' };
  if (prior < 1) return { action: 'kick', share: false, reason: 'first offence' };
  return { action: 'ban', share: !raid, reason: `offence ${prior + 1}` };
}
