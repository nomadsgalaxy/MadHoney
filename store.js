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

// A user is "banned elsewhere" if any OTHER guild with ban-sharing ON has a
// ban entry for them that wasn't later reversed (unbanned:true entry wins).
export function bannedElsewhere(userId, guildId, guilds = allGuilds(), rows = bans()) {
  const state = new Map(); // guildId -> currently banned there?
  for (const b of rows) if (b.id === userId) state.set(b.guildId, !b.unbanned);
  for (const [g, banned] of state) {
    if (g !== guildId && banned && guilds[g]?.banShare) return true;
  }
  return false;
}
