// Per-guild config + shared ban log. Plain files, synchronous.
// ponytail: JSON file + JSONL append is plenty for this scale; move to SQLite
// only if MadHoney ever serves hundreds of guilds with heavy dashboard traffic.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const GUILDS = new URL('./guilds.json', import.meta.url);
const BANS = new URL('./bans.jsonl', import.meta.url);

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
