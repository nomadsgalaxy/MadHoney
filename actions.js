// Guild actions shared by the slash commands (bot.js) and the dashboard
// (dashboard.js). Each takes a discord.js Guild + the stored config and
// returns a human-readable result string.
import { PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { createHash } from 'node:crypto';
import { renderBanner, DEFAULT_BANNER } from './banner.js';
import { saveGuild, bans, logBan } from './store.js';

// Bump these ONLY when a code change alters how the posted Verify panel or
// banner looks. Combined with the per-guild content, they form a fingerprint;
// on boot the posted message is edited in place (no notification) only if that
// fingerprint changed, so plain bot updates never re-post anything.
const VERIFY_PANEL_VERSION = 1;
const BANNER_RENDER_VERSION = 2; // v2: HONEYPOT IS ACTIVE headline + credit line
const fp = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
export const verifyFingerprint = (cfg) => fp(`${VERIFY_PANEL_VERSION}|${cfg.verifyText || DEFAULT_VERIFY_TEXT}`);
export const bannerFingerprint = (cfg) => fp(`${BANNER_RENDER_VERSION}|${JSON.stringify({ ...DEFAULT_BANNER, ...cfg.banner })}`);

const verifyRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('verify_start').setLabel('Verify').setStyle(ButtonStyle.Success),
);

export const DEFAULT_VERIFY_TEXT =
  '**Verify & Agree to the Rules**\nClick **Verify** and type the code from the image. ' +
  'Verifying confirms you’ve read and agree to the rules above, and unlocks the server.';

async function textChannel(guild, id, what) {
  const ch = await guild.channels.fetch(id).catch(() => null);
  if (!ch || !ch.isTextBased()) throw new Error(`${what} channel not found - re-run setup.`);
  return ch;
}

// Post (or refresh) the Verify panel in the configured verify channel.
export async function postVerifyPanel(guild, cfg) {
  const ch = await textChannel(guild, cfg.verifyChannelId, 'Verify');
  try { // best-effort cleanup of our previous panels
    const recent = await ch.messages.fetch({ limit: 20 });
    for (const m of recent.filter((m) => m.author.id === guild.client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  } catch { /* no Read History - skip cleanup */ }
  const msg = await ch.send({ content: cfg.verifyText || DEFAULT_VERIFY_TEXT, components: [verifyRow()] });
  saveGuild(guild.id, { verifyPosted: true, verifyMsgId: msg.id, verifyFp: verifyFingerprint(cfg) });
  return `Posted the Verify panel in #${ch.name}.`;
}

// Silent update: only if the panel's content actually changed, edit the
// existing message in place (Discord edits don't notify). Adopts a panel we
// posted before message-ID tracking existed. Returns null when nothing to do.
export async function refreshVerifyPanel(guild, cfg) {
  if (!cfg.verifyChannelId || cfg.verifyFp === verifyFingerprint(cfg)) return null;
  const ch = await guild.channels.fetch(cfg.verifyChannelId).catch(() => null);
  if (!ch?.isTextBased()) return null;
  const payload = { content: cfg.verifyText || DEFAULT_VERIFY_TEXT, components: [verifyRow()] };
  let msg = cfg.verifyMsgId ? await ch.messages.fetch(cfg.verifyMsgId).catch(() => null) : null;
  if (!msg) {
    const recent = await ch.messages.fetch({ limit: 20 }).catch(() => null);
    msg = recent?.find((m) => m.author.id === guild.client.user.id && m.components.length);
  }
  if (msg) await msg.edit(payload); else msg = await ch.send(payload);
  saveGuild(guild.id, { verifyMsgId: msg.id, verifyFp: verifyFingerprint(cfg) });
  return 'verify panel updated (edited in place, no ping)';
}

// Map '@rolename' -> the role's Discord color, for mentionMode 'role'.
// Roles left on the default (no) color fall back to the custom mention color.
export function roleColorMap(guild) {
  const map = {};
  for (const r of guild.roles.cache.values()) {
    if (r.hexColor && r.hexColor !== '#000000') map['@' + r.name.toLowerCase()] = r.hexColor;
  }
  return map;
}

// Render the configured banner and post it in the honeypot channel.
export async function postBanner(guild, cfg) {
  const ch = await textChannel(guild, cfg.honeypotChannelId, 'Honeypot');
  const png = await renderBanner({ ...(cfg.banner ?? DEFAULT_BANNER), roleColors: roleColorMap(guild) });
  try {
    const recent = await ch.messages.fetch({ limit: 50 });
    for (const m of recent.filter((m) => m.author.id === guild.client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  } catch { /* skip cleanup */ }
  const msg = await ch.send({ files: [new AttachmentBuilder(png, { name: 'do-not-post.png' })] });
  saveGuild(guild.id, { bannerPosted: true, bannerMsgId: msg.id, bannerFp: bannerFingerprint(cfg) });
  return `Posted the honeypot banner in #${ch.name}.`;
}

// Silent update: only if the banner's design changed, edit the existing
// message's attachment in place (no notification). Returns null when unchanged.
export async function refreshBanner(guild, cfg) {
  if (!cfg.honeypotChannelId || cfg.bannerFp === bannerFingerprint(cfg)) return null;
  const ch = await guild.channels.fetch(cfg.honeypotChannelId).catch(() => null);
  if (!ch?.isTextBased()) return null;
  const png = await renderBanner({ ...(cfg.banner ?? DEFAULT_BANNER), roleColors: roleColorMap(guild) });
  const file = new AttachmentBuilder(png, { name: 'do-not-post.png' });
  let msg = cfg.bannerMsgId ? await ch.messages.fetch(cfg.bannerMsgId).catch(() => null) : null;
  if (!msg) {
    const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    msg = recent?.find((m) => m.author.id === guild.client.user.id && m.attachments.size);
  }
  if (msg) await msg.edit({ files: [file], attachments: [] }); else msg = await ch.send({ files: [file] });
  saveGuild(guild.id, { bannerMsgId: msg.id, bannerFp: bannerFingerprint(cfg) });
  return 'banner updated (edited in place, no ping)';
}

// Gate every currently-public channel behind the verified role.
// Verify channel stays public (it's the gateway); honeypot stays open to
// @everyone but hidden from verified members. Dry run unless apply=true.
//
// Two things this has to get right, both learned the hard way:
//  1. ORDER: grant the verified role View BEFORE denying @everyone View.
//     Denying @everyone first strips the bot's own inherited access (the bot
//     only has @everyone + its role), so the follow-up grant fails and the
//     channel is left half-gated - visible to no one. Role-first means both
//     edits complete while the bot can still see the channel.
//  2. VISIBILITY: a channel already hidden from @everyone that the bot has no
//     override on is invisible to the bot - it can't edit what it can't see.
//     Report those as needs-access instead of failing mid-edit.
export async function gateChannels(guild, cfg, apply = false) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) throw new Error('Verified role not found - re-run setup.');
  const everyone = guild.roles.everyone;
  const me = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();

  const plan = { gate: [], keep: [], honeypot: [], skip: [], noaccess: [] };
  for (const ch of channels.values()) {
    if (!ch) continue;
    const target = ch.id === cfg.honeypotChannelId ? 'honeypot'
      : ch.id === cfg.verifyChannelId ? 'keep'
      : ch.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel) ? 'gate'
      : 'skip';
    // The bot must be able to see AND manage roles on a channel to gate it.
    if (target !== 'skip' && !ch.permissionsFor(me).has(PermissionFlagsBits.ViewChannel)) plan.noaccess.push(ch);
    else plan[target].push(ch);
  }

  // Granting the verified role View on a category cascades to its children.
  // A private (admin/staff) channel under a gated category that only blocks
  // @everyone would inherit that allow and become visible to verified members.
  // Explicitly deny the verified role on those so admin channels stay hidden.
  const gatedCatIds = new Set(plan.gate.filter((c) => c.type === ChannelType.GuildCategory).map((c) => c.id));
  const protect = plan.skip.filter((c) => c.parentId && gatedCatIds.has(c.parentId) &&
    !c.permissionOverwrites.cache.get(role.id)?.deny.has(PermissionFlagsBits.ViewChannel));

  const name = (c) => `${c.type === ChannelType.GuildCategory ? '▸' : '#'}${c.name}`;
  const lines = [
    `GATE behind "${role.name}" (${plan.gate.length}): ${plan.gate.map(name).join(', ') || '(none)'}`,
    `STAYS PUBLIC (verify gateway): ${plan.keep.map(name).join(', ') || '(none)'}`,
    `HONEYPOT (open to everyone, hidden from verified): ${plan.honeypot.map(name).join(', ') || '(none)'}`,
    `KEEP ADMIN CHANNELS HIDDEN (${protect.length}): ${protect.map(name).join(', ') || '(none)'}`,
    `SKIP already private (${plan.skip.length})`,
  ];
  if (plan.noaccess.length) {
    lines.push(`⚠️ CAN'T ACCESS (${plan.noaccess.length}) - I can't see these, so I can't gate them: ${plan.noaccess.map(name).join(', ')}\n   Fix: temporarily give the MadHoney role Administrator (Server Settings → Roles), run gate again, then remove it - or grant the MadHoney role View Channel on each.`);
  }
  if (!apply) return `DRY RUN - nothing changed.\n${lines.join('\n')}\nRun "Gate channels (APPLY)" to make it real.`;

  let ok = 0; const failed = [];
  const tryEdit = async (ch, fn) => {
    try { await fn(); ok++; } catch (e) { failed.push(`${name(ch)} (${e.message})`); }
  };
  for (const ch of plan.gate) {
    await tryEdit(ch, async () => {
      await ch.permissionOverwrites.edit(role, { ViewChannel: true }, { reason: 'MadHoney: gate behind verified' });
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: 'MadHoney: gate behind verified' });
    });
  }
  for (const ch of plan.keep) {
    await tryEdit(ch, () => ch.permissionOverwrites.edit(everyone, { ViewChannel: true }, { reason: 'MadHoney: verify gateway stays public' }));
  }
  for (const ch of plan.honeypot) {
    await tryEdit(ch, async () => {
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: true, SendMessages: true }, { reason: 'MadHoney: honeypot open to unverified' });
      await ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'MadHoney: hide honeypot from verified' });
    });
  }
  for (const ch of protect) {
    await tryEdit(ch, () => ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'MadHoney: keep admin channel hidden from verified' }));
  }
  // Remember what we changed so "Restore" can reverse exactly these, and no
  // admin channels we never touched.
  saveGuild(guild.id, { gatedChannels: [...plan.gate, ...plan.keep, ...plan.honeypot, ...protect].map((c) => c.id) });
  return `Gated. ${ok} channels updated, ${failed.length} failed${plan.noaccess.length ? `, ${plan.noaccess.length} unreachable` : ''}.${failed.length ? '\nFailed: ' + failed.join(', ') : ''}\n${lines.join('\n')}`;
}

// Reverse gating: clear the ViewChannel overwrites MadHoney added on the
// channels it gated, returning them to their pre-gate (inherited) visibility.
// Only touches channels MadHoney recorded gating - admin channels it never
// changed are left alone.
export async function ungateChannels(guild, cfg) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  const everyone = guild.roles.everyone;
  let ids = cfg.gatedChannels ?? [];
  let note = '';
  if (!ids.length) {
    // No record (older gate): fall back to ORPHANED channels - @everyone denied
    // View and no role grants View, so nobody can see them (half-gate damage).
    // Admin channels grant a mod role View, so they're left alone.
    const channels = await guild.channels.fetch();
    ids = channels.filter((ch) => {
      if (!ch) return false;
      const ow = ch.permissionOverwrites.cache;
      const everyoneDenied = ow.get(everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel);
      const someRoleAllows = [...ow.values()].some((o) => o.id !== everyone.id && o.allow.has(PermissionFlagsBits.ViewChannel));
      return everyoneDenied && !someRoleAllows;
    }).map((ch) => ch.id);
    if (!ids.length) throw new Error('Nothing to restore - no channels I gated on record, and none look orphaned.');
    note = ' (recovered orphaned channels - no gate record existed)';
  }
  let ok = 0; const failed = [];
  for (const id of ids) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch) continue;
    try {
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: null, SendMessages: null }, { reason: 'MadHoney: restore pre-gate visibility' });
      if (role) await ch.permissionOverwrites.edit(role, { ViewChannel: null }, { reason: 'MadHoney: restore pre-gate visibility' });
      ok++;
    } catch (e) { failed.push(`#${ch.name} (${e.message})`); }
  }
  saveGuild(guild.id, { gatedChannels: [] });
  return `Restored ${ok} channels to their pre-gate visibility${note}${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : '.'}`;
}

// Grandfather: add the verified role to every existing non-bot member so the
// gate doesn't lock out people who were already in the server.
// Needs the privileged Server Members intent.
// Can the bot actually grant the verified role here? Returns null when
// everything checks out, or a human-readable problem with the exact fix.
export async function preflight(guild, cfg) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) return 'Verified role not found - re-run setup and pick one.';
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'I don\'t have the Manage Roles permission here - re-invite me with the link on the site, or grant it to my role.';
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return `My role ("${me.roles.highest.name}") is BELOW the verified role ("${role.name}") in the role list, so Discord won't let me grant it. Fix: Server Settings → Roles → drag "${me.roles.highest.name}" above "${role.name}", then try again.`;
  }
  return null;
}

// Pass a `progress` object to watch it live: {total, done, added, skipped,
// failed} are updated as the loop runs (one Discord API call per member, so
// large servers take a while).
export async function grandfather(guild, cfg, progress = {}) {
  const problem = await preflight(guild, cfg);
  if (problem) throw new Error(problem);
  const role = await guild.roles.fetch(cfg.verifiedRoleId);
  const members = await guild.members.fetch();
  Object.assign(progress, { label: 'Grandfathering', total: members.size, done: 0, added: 0, skipped: 0, failed: 0 });
  const failures = [];
  for (const m of members.values()) {
    progress.done++;
    if (m.user.bot || m.roles.cache.has(role.id)) { progress.skipped++; continue; }
    await m.roles.add(role, 'MadHoney: grandfathered existing member')
      .then(() => progress.added++)
      .catch((e) => { progress.failed++; failures.push(`${m.user.tag}: ${e.message}`); });
  }
  return `Grandfathered "${role.name}": ${progress.added} added, ${progress.skipped} skipped.${failures.length ? `\n${failures.length} failed (is the MadHoney role ABOVE "${role.name}"?): ` + failures.slice(0, 5).join(', ') : ''}`;
}

// Ban from List: proactively ban every user on the active shared list (bans
// from OTHER sharing servers that weren't undone), instead of waiting for
// them to join. Requires ban sharing to be ON for this server.
export async function syncBans(guild, cfg, progress = {}) {
  if (!cfg.banShare) throw new Error('Ban sharing is OFF for this server - turn it on first, then sync.');
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.BanMembers)) throw new Error("I don't have the Ban Members permission here.");

  // universal list: latest state per (user, guild); an unban reverses the entry
  const perGuild = new Map();
  for (const b of bans()) {
    if (b.guildId !== guild.id) perGuild.set(`${b.id}:${b.guildId}`, b);
  }
  const pool = new Map(); // userId -> tag
  for (const b of perGuild.values()) if (!b.unbanned) pool.set(b.id, b.tag);

  // ponytail: bans.fetch caps at 1000 entries; paginate if a server ever exceeds it
  const existing = await guild.bans.fetch();
  const already = new Set([...existing.keys(), ...bans(guild.id).filter((b) => !b.unbanned).map((b) => b.id)]);

  Object.assign(progress, { label: 'Ban sync', total: pool.size, done: 0, added: 0, skipped: 0, failed: 0 });
  for (const [id, tag] of pool) {
    progress.done++;
    if (already.has(id)) { progress.skipped++; continue; }
    try {
      await guild.bans.create(id, { reason: 'MadHoney: synced from the shared ban list' });
      logBan({ id, tag, guildId: guild.id, channel: '(ban-sync)', at: new Date().toISOString() });
      progress.added++;
    } catch { progress.failed++; }
  }
  return `Ban sync: ${progress.added} banned from the shared list, ${progress.skipped} already banned here${progress.failed ? `, ${progress.failed} failed` : ''}. Pool size: ${pool.size}.`;
}
