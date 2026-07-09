// Compromised-account detection. A hijacked member (a real, already-trusted
// account, not a throwaway bot) typically blasts the SAME message across many
// channels within seconds - far faster than a human switching channels by hand.
// We watch each non-staff member's own recent posts and, when the same message
// lands in enough DISTINCT channels inside a tight window, treat the account as
// compromised and take the server's configured action (kick by default).
//
// The tight window is the whole safety margin: superhuman fan-out speed is the
// signal, so a member legitimately cross-posting an announcement over several
// seconds never trips it. Detection compares message CONTENT, so it only bites
// when the Message Content intent is enabled - until then every signature is
// empty and it stays dormant (see messageSignature).

// Per-server settings, normalized with safe defaults. Kept tight so a false
// positive is near-impossible: identical content in 3+ channels within 5s.
export function compromisedSettings(cfg) {
  const c = cfg?.compromised ?? {};
  const action = ['kick', 'ban', 'quarantine', 'notify'].includes(c.action) ? c.action : 'kick';
  const channels = Math.max(2, Math.min(10, Number(c.channels) || 3));
  const windowSec = Math.max(1, Math.min(60, Number(c.windowSec) || 5));
  return {
    enabled: c.enabled !== false,               // default on (dormant without Message Content)
    channels,
    windowSec,
    windowMs: windowSec * 1000,
    action,
    deleteMessages: c.deleteMessages !== false, // default on
  };
}

// Normalize so trivial variation doesn't defeat the match: a hijack blast is
// copy-paste identical modulo case, spacing, a pinged role, or a tracking link.
export function normalizeContent(text) {
  return (text || '')
    .toLowerCase()
    .replace(/<@[!&]?\d+>|<#\d+>/g, '')   // user / role / channel mentions
    .replace(/https?:\/\/\S+/g, '')        // links
    .replace(/\s+/g, ' ')
    .trim();
}

// A message's comparison signature: normalized text plus any attachment names
// (image blasts reuse the same file). Empty string means nothing to compare on
// (e.g. the Message Content intent is off) and the caller skips it.
export function messageSignature({ content, attachmentNames } = {}) {
  const norm = normalizeContent(content);
  const names = (attachmentNames || []).slice().sort().join(',');
  return [norm, names].filter(Boolean).join('|');
}

// Stateful fan-out check. `store` is a Map the caller owns (one per process),
// keyed by `${guildId}:${userId}`. Records this post and, if the same signature
// has now reached `channels` distinct channels within `windowMs`, returns the
// blast as [{channelId, messageId}, ...]; otherwise null. On a trip it clears
// the signature so one blast fires exactly once.
export function recordAndCheck(store, key, sig, post, now, { channels, windowMs }) {
  if (!sig) return null;
  let byUser = store.get(key);
  if (!byUser) { byUser = new Map(); store.set(key, byUser); }
  let hits = byUser.get(sig);
  if (!hits) { hits = new Map(); byUser.set(sig, hits); }
  // Keep only channels still inside the window, then record the newest post for
  // this channel (re-posting in the same channel doesn't count as extra fan-out).
  for (const [ch, p] of hits) if (now - p.ts > windowMs) hits.delete(ch);
  hits.set(post.channelId, { messageId: post.messageId, ts: now });
  if (hits.size >= channels) {
    const blast = [...hits.entries()].map(([channelId, p]) => ({ channelId, messageId: p.messageId }));
    byUser.delete(sig);              // fired - don't retrigger on the member's next post
    if (byUser.size === 0) store.delete(key);
    return blast;
  }
  return null;
}

// Drop everything older than windowMs so one-off posters don't accumulate in the
// store forever. Called on a timer by the bot.
// ponytail: O(total tracked posts) full scan; fine at our scale (a handful of
// active posters per guild). Shard by guild if a mega-server ever makes it hurt.
export function sweep(store, now, windowMs) {
  for (const [key, byUser] of store) {
    for (const [sig, hits] of byUser) {
      for (const [ch, p] of hits) if (now - p.ts > windowMs) hits.delete(ch);
      if (hits.size === 0) byUser.delete(sig);
    }
    if (byUser.size === 0) store.delete(key);
  }
}
