// Per-guild config + shared ban log. Plain files, synchronous.
// ponytail: JSON file + JSONL append is plenty for this scale; move to SQLite
// only if MadHoney ever serves hundreds of guilds with heavy dashboard traffic.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Data lives beside the code by default. Set MADHONEY_DATA_DIR to keep state on
// a separate volume (e.g. a Docker mount) so it survives image rebuilds.
const DATA_DIR = process.env.MADHONEY_DATA_DIR
  ? pathToFileURL(process.env.MADHONEY_DATA_DIR.replace(/\/?$/, '/'))
  : new URL('./', import.meta.url);
if (process.env.MADHONEY_DATA_DIR) mkdirSync(process.env.MADHONEY_DATA_DIR, { recursive: true });
const GUILDS = new URL('guilds.json', DATA_DIR);
const BANS = new URL('bans.jsonl', DATA_DIR);
const APPEALS = new URL('appeals.jsonl', DATA_DIR);

export function allGuilds() {
  return existsSync(GUILDS) ? JSON.parse(readFileSync(GUILDS, 'utf8')) : {};
}

export function getGuild(id) {
  return allGuilds()[id] ?? null;
}

export function saveGuild(id, patch) {
  const all = allGuilds();
  all[id] = { ...all[id], ...patch };
  writeFileSync(GUILDS, JSON.stringify(all, null, 2) + '\n');
  return all[id];
}

export function logBan(entry) {
  // Dedup: skip a ban row for a user already banned in this guild (per their
  // latest row). Unban rows and a user's first ban always write. Keeps the
  // append-only log from ballooning under repeat catches / propagation and
  // bounds ban-list flooding.
  // ponytail: re-reads the guild's rows per call - fine at this scale (see file
  // header). A ban-sync over a huge shared list is the O(n^2) case that triggers
  // the SQLite migration, not this.
  if (!entry.unbanned && entry.id && entry.guildId) {
    let banned = false;
    for (const b of bans(entry.guildId)) if (b.id === entry.id) banned = !b.unbanned;
    if (banned) return;
  }
  appendFileSync(BANS, JSON.stringify(entry) + '\n');
}

export function bans(guildId = null) {
  if (!existsSync(BANS)) return [];
  const rows = readFileSync(BANS, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return guildId ? rows.filter((b) => b.guildId === guildId) : rows;
}

// Count distinct users currently trapped, not raw log lines. A user banned in
// several servers (or propagated by ban-share / ban-sync) is one spammer; a
// user whose latest state everywhere is unbanned doesn't count.
export function trappedCount(rows = bans()) {
  const state = new Map(); // `${id}:${guildId}` -> currently banned?
  for (const b of rows) state.set(`${b.id}:${b.guildId}`, !b.unbanned);
  const users = new Set();
  for (const [key, banned] of state) if (banned) users.add(key.slice(0, key.lastIndexOf(':')));
  return users.size;
}

// Every honeypot ban lands on the universal list; banShare only controls
// whether a server ACTS on it (checked at the call sites). A user is "banned
// elsewhere" if any OTHER guild has a ban entry for them that wasn't later
// reversed (unbanned:true entry wins).
export function bannedElsewhere(userId, guildId, rows = bans()) {
  const state = new Map(); // guildId -> currently banned there?
  for (const b of rows) if (b.id === userId) state.set(b.guildId, !b.unbanned);
  for (const [g, banned] of state) {
    if (g !== guildId && banned) return true;
  }
  return false;
}

// Guilds a user may appeal to: ONLY ones they are currently banned in (so we
// never reveal a server they were never removed from) AND that opted into the
// appeal pipeline with a log channel. This is the privacy boundary for the DM.
export function appealableGuildIds(userId, guilds = allGuilds(), rows = bans()) {
  const state = new Map();
  for (const b of rows) if (b.id === userId) state.set(b.guildId, !b.unbanned);
  const out = [];
  for (const [g, banned] of state) {
    if (banned && guilds[g]?.appealEnabled && guilds[g]?.logChannelId) out.push(g);
  }
  return out;
}

// The "episode" identifier of a user's CURRENT ban in a guild: the `at` of the
// latest un-reversed ban row for (user, guild), or null if they aren't banned
// there right now. An unban then re-ban is a NEW episode, so a fresh ban is
// appealable again while duplicate clicks on one ban collapse to one appeal.
export function banEpoch(userId, guildId, rows = bans()) {
  let epoch = null;
  for (const b of rows) {
    if (b.id !== userId || b.guildId !== guildId) continue;
    epoch = b.unbanned ? null : (b.at ?? epoch);
  }
  return epoch;
}

// One appeal per ban episode. hasAppealed is the durable (survives restarts)
// half of the dedup; the caller pairs it with an in-memory in-flight guard to
// cover the async gap before recordAppeal persists. Both checks are synchronous
// so concurrent button replays can't all pass before one wins.
export function hasAppealed(userId, guildId, epoch) {
  if (!existsSync(APPEALS)) return false;
  const key = `${userId}:${guildId}:${epoch}`;
  for (const l of readFileSync(APPEALS, 'utf8').trim().split('\n').filter(Boolean)) {
    try { const a = JSON.parse(l); if (`${a.id}:${a.guildId}:${a.epoch}` === key) return true; } catch { /* skip */ }
  }
  return false;
}

export function recordAppeal(userId, guildId, epoch) {
  appendFileSync(APPEALS, JSON.stringify({ id: userId, guildId, epoch, at: new Date().toISOString() }) + '\n');
}
