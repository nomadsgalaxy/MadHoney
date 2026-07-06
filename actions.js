// Guild actions shared by the slash commands (bot.js) and the dashboard
// (dashboard.js). Each takes a discord.js Guild + the stored config and
// returns a human-readable result string.
import { PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Client, GatewayIntentBits, Events } from 'discord.js';
import { createHash, randomBytes } from 'node:crypto';
import { renderBanner, DEFAULT_BANNER, creditSuffix } from './banner.js';
import { resolvedIncidents } from './incident.js';
import { t } from './i18n.js';

// Randomize the banner's attachment filename on every post. A fixed name like
// "do-not-post.png" is a fingerprint: once MadHoney is popular, spam tooling
// could learn to skip any channel holding that exact file. These blend in with
// names real uploads use.
function bannerFileName() {
  const r = randomBytes(6);
  const kinds = [
    () => 'image.png',
    () => 'unknown.png',
    () => `IMG_${1000 + (r.readUInt16BE(0) % 9000)}.png`,
    () => `${r.toString('hex')}.png`,
    () => `Screenshot_${r.toString('hex').slice(0, 6)}.png`,
  ];
  return kinds[r[5] % kinds.length]();
}
const { saveGuild, bans, logBan } = await import(process.env.MADHONEY_STORE ?? './store.js'); // pluggable store backend

// Bump these ONLY when a code change alters how the posted Verify panel or
// banner looks. Combined with the per-guild content, they form a fingerprint;
// on boot the posted message is edited in place (no notification) only if that
// fingerprint changed, so plain bot updates never re-post anything.
const VERIFY_PANEL_VERSION = 2; // v2: attribution line moved onto the verify panel
const BANNER_RENDER_VERSION = 4; // v4: credit line removed from the banner (moved to verify panel)
const fp = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
export const verifyFingerprint = (cfg) => fp(`${VERIFY_PANEL_VERSION}|${cfg.verifyText || t('verify.panelText', cfg.locale)}|${cfg.locale || 'en'}|${creditSuffix(cfg.banner?.hideCredit)}`);
export const bannerFingerprint = (cfg) => fp(`${BANNER_RENDER_VERSION}|${JSON.stringify({ ...DEFAULT_BANNER, ...cfg.banner })}`);

const verifyRow = (loc) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('verify_start').setLabel(t('verify.button', loc)).setStyle(ButtonStyle.Success),
);

// English default, from the catalog. Used as the edit-box placeholder; the
// posted panel uses the guild's bot language via verifyContent().
export const DEFAULT_VERIFY_TEXT = t('verify.panelText', 'en');

// The verify panel's full text = the admin's custom message (if any) OR the
// default in the guild's bot language, + the MadHoney attribution line.
const verifyContent = (cfg) => (cfg.verifyText || t('verify.panelText', cfg.locale)) + creditSuffix(cfg.banner?.hideCredit);

async function textChannel(guild, id, what, loc) {
  const ch = await guild.channels.fetch(id).catch(() => null);
  if (!ch || !ch.isTextBased()) throw new Error(t('dash.act.chNotFound', loc, { what }));
  return ch;
}

// Post (or refresh) the Verify panel in the configured verify channel.
export async function postVerifyPanel(guild, cfg, loc = cfg?.locale) {
  const ch = await textChannel(guild, cfg.verifyChannelId, 'Verify', loc);
  try { // best-effort cleanup of our previous panels
    const recent = await ch.messages.fetch({ limit: 20 });
    for (const m of recent.filter((m) => m.author.id === guild.client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  } catch { /* no Read History - skip cleanup */ }
  const msg = await ch.send({ content: verifyContent(cfg), components: [verifyRow(cfg.locale)] });
  saveGuild(guild.id, { verifyPosted: true, verifyMsgId: msg.id, verifyFp: verifyFingerprint(cfg) });
  return t('dash.act.postedVerify', loc, { channel: ch.name });
}

// Silent update: only if the panel's content actually changed, edit the
// existing message in place (Discord edits don't notify). Adopts a panel we
// posted before message-ID tracking existed. Returns null when nothing to do.
export async function refreshVerifyPanel(guild, cfg) {
  if (!cfg.verifyChannelId || cfg.verifyFp === verifyFingerprint(cfg)) return null;
  const ch = await guild.channels.fetch(cfg.verifyChannelId).catch(() => null);
  if (!ch?.isTextBased()) return null;
  const payload = { content: verifyContent(cfg), components: [verifyRow(cfg.locale)] };
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
export async function postBanner(guild, cfg, loc = cfg?.locale) {
  const ch = await textChannel(guild, cfg.honeypotChannelId, 'Honeypot', loc);
  const png = await renderBanner({ ...(cfg.banner ?? DEFAULT_BANNER), roleColors: roleColorMap(guild) });
  try {
    const recent = await ch.messages.fetch({ limit: 50 });
    for (const m of recent.filter((m) => m.author.id === guild.client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  } catch { /* skip cleanup */ }
  const msg = await ch.send({ files: [new AttachmentBuilder(png, { name: bannerFileName() })] });
  saveGuild(guild.id, { bannerPosted: true, bannerMsgId: msg.id, bannerFp: bannerFingerprint(cfg) });
  return t('dash.act.postedBanner', loc, { channel: ch.name });
}

// Silent update: only if the banner's design changed, edit the existing
// message's attachment in place (no notification). Returns null when unchanged.
export async function refreshBanner(guild, cfg) {
  if (!cfg.honeypotChannelId || cfg.bannerFp === bannerFingerprint(cfg)) return null;
  const ch = await guild.channels.fetch(cfg.honeypotChannelId).catch(() => null);
  if (!ch?.isTextBased()) return null;
  const png = await renderBanner({ ...(cfg.banner ?? DEFAULT_BANNER), roleColors: roleColorMap(guild) });
  const file = new AttachmentBuilder(png, { name: bannerFileName() });
  let msg = cfg.bannerMsgId ? await ch.messages.fetch(cfg.bannerMsgId).catch(() => null) : null;
  if (!msg) {
    const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    msg = recent?.find((m) => m.author.id === guild.client.user.id && m.attachments.size);
  }
  if (msg) await msg.edit({ files: [file], attachments: [] }); else msg = await ch.send({ files: [file] });
  saveGuild(guild.id, { bannerMsgId: msg.id, bannerFp: bannerFingerprint(cfg) });
  return 'banner updated (edited in place, no ping)';
}

// Roles that mark a channel as admin/staff (any grants "elevated" here).
const ELEVATED = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageMessages | PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers | PermissionFlagsBits.ModerateMembers;

// Classify every channel so the dashboard can show what MadHoney sees and let
// the admin pick exactly what to gate. Kinds:
//   public  - @everyone can view (standard channel; the gate targets these)
//   private - hidden from @everyone, no elevated role has access (restricted)
//   admin   - hidden from @everyone AND an elevated (mod/staff) role can view
//   verify  - the verify gateway (stays public)
//   honeypot- the trap
export async function classifyChannels(guild, cfg) {
  const everyone = guild.roles.everyone;
  const me = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();
  const list = [];
  for (const ch of channels.values()) {
    if (!ch) continue;
    const canManage = ch.permissionsFor(me).has(PermissionFlagsBits.ViewChannel) &&
      ch.permissionsFor(me).has(PermissionFlagsBits.ManageRoles);
    let kind;
    if (ch.id === cfg.honeypotChannelId) kind = 'honeypot';
    else if (ch.id === cfg.verifyChannelId) kind = 'verify';
    else if (ch.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel)) kind = 'public';
    else {
      const adminRoleSees = guild.roles.cache.some((r) =>
        (r.permissions.bitfield & ELEVATED) !== 0n &&
        ch.permissionOverwrites.cache.get(r.id)?.allow.has(PermissionFlagsBits.ViewChannel));
      kind = adminRoleSees ? 'admin' : 'private';
    }
    // Already gated by MadHoney? = hidden from @everyone AND the verified role
    // is explicitly allowed to view. Lets the board show current state.
    const gated = kind !== 'public' && kind !== 'verify' && kind !== 'honeypot' &&
      !!ch.permissionOverwrites.cache.get(cfg.verifiedRoleId)?.allow.has(PermissionFlagsBits.ViewChannel);
    list.push({ id: ch.id, name: ch.name, kind, gated, isCategory: ch.type === ChannelType.GuildCategory, parentId: ch.parentId, position: ch.rawPosition ?? 0, canManage });
  }
  return list;
}

// Gate channels behind the verified role. If `only` (a Set/array of channel
// IDs) is given, gate exactly those; otherwise gate every public channel.
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
// `sel` selects what to do with each channel:
//   null                 -> gate every currently-public channel (blanket)
//   [id, id, ...]         -> gate exactly these (legacy)
//   { gate:[], public:[] } -> gate these, force-public these, leave the rest
export async function gateChannels(guild, cfg, apply = false, sel = null, loc = cfg?.locale) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) throw new Error(t('dash.act.roleNotFound', loc));
  const everyone = guild.roles.everyone;
  const me = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();
  const gateSet = sel ? new Set(Array.isArray(sel) ? sel : sel.gate ?? []) : null;
  const publicSet = new Set(!sel || Array.isArray(sel) ? [] : sel.public ?? []);

  const plan = { gate: [], keep: [], honeypot: [], skip: [], noaccess: [] };
  const readonly = []; // viewable but NOT postable by @everyone: left public by default
  for (const ch of channels.values()) {
    if (!ch) continue;
    const everyoneView = ch.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel);
    // "Postable" per channel type: voice/stage = Connect, everything else = Send.
    const postBit = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
      ? PermissionFlagsBits.Connect : PermissionFlagsBits.SendMessages;
    const everyonePosts = ch.permissionsFor(everyone).has(postBit);
    // Default detection: gate what @everyone can both SEE and POST in. Read-only
    // broadcast channels (#announcements and friends) carry no spam risk and are
    // exactly what Discord Onboarding needs visible, so they stay public — pinned
    // with an explicit View allow (below) so a gated parent category can't hide
    // them. An explicit dashboard selection (gateSet) still overrides.
    const isReadonly = !gateSet && everyoneView && !everyonePosts
      && ch.id !== cfg.honeypotChannelId && ch.id !== cfg.verifyChannelId;
    const wantGate = gateSet ? gateSet.has(ch.id) : (everyoneView && everyonePosts);
    const target = ch.id === cfg.honeypotChannelId ? 'honeypot'
      : ch.id === cfg.verifyChannelId ? 'keep'
      : wantGate ? 'gate'
      : (publicSet.has(ch.id) || isReadonly) ? 'keep' // forced public / read-only broadcast
      : 'skip';
    // The bot must be able to see AND manage roles on a channel to gate it.
    if ((target === 'gate' || target === 'keep') && !ch.permissionsFor(me).has(PermissionFlagsBits.ViewChannel)) plan.noaccess.push(ch);
    else {
      plan[target].push(ch);
      if (target === 'keep' && isReadonly) readonly.push(ch);
    }
  }

  // Granting the verified role View on a category cascades to its children.
  // A private (admin/staff) channel under a gated category that only blocks
  // @everyone would inherit that allow and become visible to verified members.
  // Explicitly deny the verified role on those so admin channels stay hidden.
  const gatedCatIds = new Set(plan.gate.filter((c) => c.type === ChannelType.GuildCategory).map((c) => c.id));
  const protect = plan.skip.filter((c) => c.parentId && gatedCatIds.has(c.parentId) &&
    !c.permissionOverwrites.cache.get(role.id)?.deny.has(PermissionFlagsBits.ViewChannel));

  const name = (c) => `${c.type === ChannelType.GuildCategory ? '▸' : '#'}${c.name}`;
  const none = t('dash.act.gNone', loc);
  const lines = [
    t('dash.act.gLineGate', loc, { role: role.name, n: plan.gate.length, list: plan.gate.map(name).join(', ') || none }),
    t('dash.act.gLineKeep', loc, { list: plan.keep.filter((c) => !readonly.includes(c)).map(name).join(', ') || none }),
    ...(readonly.length ? [t('dash.act.gLineReadonly', loc, { n: readonly.length, list: readonly.map(name).join(', ') })] : []),
    t('dash.act.gLineHoney', loc, { list: plan.honeypot.map(name).join(', ') || none }),
    t('dash.act.gLineProtect', loc, { n: protect.length, list: protect.map(name).join(', ') || none }),
    t('dash.act.gLineSkip', loc, { n: plan.skip.length }),
  ];
  if (plan.noaccess.length) {
    lines.push(t('dash.act.gNoAccess', loc, { n: plan.noaccess.length, list: plan.noaccess.map(name).join(', ') }));
  }
  if (!apply) return t('dash.act.gDryRun', loc, { lines: lines.join('\n') });

  let ok = 0; const failed = [];
  const tryEdit = async (ch, fn) => {
    try { await fn(); ok++; } catch (e) { failed.push(`${name(ch)} (${e.message})`); }
  };
  // Gating denies @everyone View, which would blind the BOT ITSELF on servers
  // where it isn't Administrator (it doesn't hold the verified role) — it could
  // no longer monitor gated channels (compromised-account detection) or manage
  // them later. Pin its access with an explicit overwrite on its managed role.
  // ManageMessages can only be self-granted where the bot already holds it
  // (Discord rule), so fall back to View-only when that edit is refused.
  const botTarget = me.roles.botRole ?? me;
  const keepBotAccess = async (ch, reason) => {
    try {
      await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, ManageMessages: true, ReadMessageHistory: true }, { reason });
    } catch {
      await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, ReadMessageHistory: true }, { reason }).catch(() => {});
    }
  };
  for (const ch of plan.gate) {
    await tryEdit(ch, async () => {
      await ch.permissionOverwrites.edit(role, { ViewChannel: true }, { reason: 'MadHoney: gate behind verified' });
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: 'MadHoney: gate behind verified' });
      await keepBotAccess(ch, 'MadHoney: keep bot able to monitor the gated channel');
    });
  }
  for (const ch of plan.keep) {
    await tryEdit(ch, () => ch.permissionOverwrites.edit(everyone, { ViewChannel: true }, { reason: 'MadHoney: verify gateway stays public' }));
  }
  for (const ch of plan.honeypot) {
    await tryEdit(ch, async () => {
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: true, SendMessages: true }, { reason: 'MadHoney: honeypot open to unverified' });
      await ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'MadHoney: hide honeypot from verified' });
      await keepBotAccess(ch, 'MadHoney: keep bot able to delete trap posts'); // channel-scoped ManageMessages where grantable
    });
  }
  for (const ch of protect) {
    await tryEdit(ch, () => ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'MadHoney: keep admin channel hidden from verified' }));
  }
  // Remember what we changed (for Restore) and how each channel was treated,
  // so a future re-scan reflects the admin's manual moves instead of just the
  // auto-detection.
  const treatment = { ...cfg.channelTreatment };
  for (const c of plan.gate) treatment[c.id] = 'gate';
  for (const c of plan.keep) if (c.id !== cfg.verifyChannelId) treatment[c.id] = 'public';
  for (const c of plan.skip) treatment[c.id] = 'leave';
  saveGuild(guild.id, {
    gatedChannels: [...plan.gate, ...plan.keep, ...plan.honeypot, ...protect].map((c) => c.id),
    channelTreatment: treatment,
  });
  return t('dash.act.gDone', loc, {
    ok, failed: failed.length,
    unreachable: plan.noaccess.length ? t('dash.act.gUnreachable', loc, { n: plan.noaccess.length }) : '',
    failedList: failed.length ? t('dash.act.gFailedList', loc, { list: failed.join(', ') }) : '',
    lines: lines.join('\n'),
  });
}

// Keep the gate closed on a channel created (or re-opened) AFTER the initial
// gate. Without this, any channel an admin adds later is an ungated hole an
// unverified account can post in (and it's not the honeypot, so nothing traps
// them there). Only acts when the server is set up AND has gated before; leaves
// the verify gateway, the honeypot, private/admin channels (anything @everyone
// already can't see), and channels the admin explicitly forced public/left
// alone. Returns a short status string, or null when it did nothing.
export async function gateNewChannel(guild, cfg, channel, loc = cfg?.locale) {
  if (!cfg?.verifiedRoleId || !cfg?.verifyChannelId || !cfg?.honeypotChannelId) return null;
  if (!cfg.gatedChannels?.length) return null; // this server doesn't use gating
  if (channel.id === cfg.verifyChannelId || channel.id === cfg.honeypotChannelId) return null;
  const treat = cfg.channelTreatment?.[channel.id];
  if (treat === 'public' || treat === 'leave') return null; // admin's explicit choice - honor it
  const everyone = guild.roles.everyone;
  // Only a channel @everyone can currently VIEW is a hole. One that inherits
  // "hidden" from a gated category is already effectively gated - leave it.
  // ponytail: same call as gateChannels; admin channels under a gated category
  // stay hidden by inheritance, so we don't re-run its explicit-deny protect step.
  if (!channel.permissionOverwrites || !channel.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel)) return null;
  // Read-only for @everyone = broadcast channel, no spam hole (same default as
  // gateChannels): leave it public.
  const newPostBit = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
    ? PermissionFlagsBits.Connect : PermissionFlagsBits.SendMessages;
  if (!channel.permissionsFor(everyone).has(newPostBit)) return null;
  const me = await guild.members.fetchMe();
  if (!channel.permissionsFor(me).has(PermissionFlagsBits.ViewChannel) ||
      !channel.permissionsFor(me).has(PermissionFlagsBits.ManageRoles)) {
    return t('dash.act.anCant', loc, { channel: channel.name });
  }
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) return null;
  // role-first ordering (see gateChannels) so the bot doesn't lock itself out
  await channel.permissionOverwrites.edit(role, { ViewChannel: true }, { reason: 'MadHoney: auto-gate new channel' });
  await channel.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: 'MadHoney: auto-gate new channel' });
  // same bot-access pin as gateChannels (monitoring + later management)
  const newBotTarget = me.roles.botRole ?? me;
  try {
    await channel.permissionOverwrites.edit(newBotTarget, { ViewChannel: true, ManageMessages: true, ReadMessageHistory: true }, { reason: 'MadHoney: keep bot able to monitor the gated channel' });
  } catch {
    await channel.permissionOverwrites.edit(newBotTarget, { ViewChannel: true, ReadMessageHistory: true }, { reason: 'MadHoney: keep bot able to monitor the gated channel' }).catch(() => {});
  }
  saveGuild(guild.id, {
    gatedChannels: cfg.gatedChannels.includes(channel.id) ? cfg.gatedChannels : [...cfg.gatedChannels, channel.id],
    channelTreatment: { ...cfg.channelTreatment, [channel.id]: 'gate' },
  });
  return t('dash.act.anGated', loc, { channel: channel.name, role: role.name });
}

// Reverse gating: clear the ViewChannel overwrites MadHoney added on the
// channels it gated, returning them to their pre-gate (inherited) visibility.
// Only touches channels MadHoney recorded gating - admin channels it never
// changed are left alone.
export async function ungateChannels(guild, cfg, loc = cfg?.locale) {
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
    if (!ids.length) throw new Error(t('dash.act.unNothing', loc));
    note = t('dash.act.unRecovered', loc);
  }
  let ok = 0; const failed = [];
  const unMe = await guild.members.fetchMe();
  const unBotTarget = unMe.roles.botRole ?? unMe;
  for (const id of ids) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch) continue;
    try {
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: null, SendMessages: null }, { reason: 'MadHoney: restore pre-gate visibility' });
      if (role) await ch.permissionOverwrites.edit(role, { ViewChannel: null }, { reason: 'MadHoney: restore pre-gate visibility' });
      // clear the bot-access pin gateChannels added (best-effort; harmless if absent)
      await ch.permissionOverwrites.edit(unBotTarget, { ViewChannel: null, ManageMessages: null, ReadMessageHistory: null }, { reason: 'MadHoney: restore pre-gate visibility' }).catch(() => {});
      ok++;
    } catch (e) { failed.push(`#${ch.name} (${e.message})`); }
  }
  saveGuild(guild.id, { gatedChannels: [] });
  return t('dash.act.unDone', loc, { ok, note, failedPart: failed.length ? t('dash.act.unFailed', loc, { n: failed.length, list: failed.join(', ') }) : t('dash.act.unDonePeriod', loc) });
}

// Grandfather: add the verified role to every existing non-bot member so the
// gate doesn't lock out people who were already in the server.
// Needs the privileged Server Members intent.
// Turn a raw Discord API error into plain, step-by-step guidance. Most setup
// failures are one of two permission problems; spell out the exact fix.
export function explainError(msg, loc) {
  const m = String(msg ?? '');
  if (/Missing Permissions|\b50013\b/i.test(m)) return t('dash.act.errPerm', loc, { msg: m });
  if (/Missing Access|\b50001\b/i.test(m)) return t('dash.act.errAccess', loc, { msg: m });
  return m;
}

// Can the bot actually grant the verified role here? Returns null when
// everything checks out, or a human-readable problem with the exact fix.
export async function preflight(guild, cfg, loc = cfg?.locale) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) return t('dash.act.pfRoleMissing', loc);
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return t('dash.act.pfNoManageRoles', loc);
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return t('dash.act.pfBelow', loc, { me: me.roles.highest.name, role: role.name });
  }
  return null;
}

// Pass a `progress` object to watch it live: {total, done, added, skipped,
// failed} are updated as the loop runs (one Discord API call per member, so
// large servers take a while).
// guild.members.fetch() sends a gateway REQUEST_GUILD_MEMBERS (opcode 8), which
// has its own rate limit - on a busy boot (a server resuming, live verifies) it
// can reject with "retry after Ns". Wait it out and retry instead of failing the
// whole job.
async function fetchAllMembers(guild, tries = 5) {
  for (let a = 0; ; a++) {
    try { return await guild.members.fetch(); }
    catch (e) {
      const m = /retry after ([\d.]+)/i.exec(e.message || '');
      if (m && a < tries) { await new Promise((r) => setTimeout(r, (parseFloat(m[1]) + 1) * 1000)); continue; }
      throw e;
    }
  }
}

export async function grandfather(guild, cfg, progress = {}, loc = cfg?.locale) {
  const problem = await preflight(guild, cfg, loc);
  if (problem) throw new Error(problem);
  // resumable: mark in-progress so a bot restart mid-run re-runs it on the next
  // boot (see ClientReady). Idempotent - already-verified members are skipped.
  saveGuild(guild.id, { grandfatherPending: true });
  const role = await guild.roles.fetch(cfg.verifiedRoleId);
  const members = await fetchAllMembers(guild);
  Object.assign(progress, { label: 'Grandfathering', total: members.size, done: 0, added: 0, skipped: 0, failed: 0 });
  const failures = [];
  // bots + members who already have the role need no API call
  const targets = [];
  for (const m of members.values()) {
    if (m.user.bot || m.roles.cache.has(role.id)) { progress.skipped++; progress.done++; }
    else targets.push(m);
  }
  // Role-add is one request per member (no bulk API), so on a several-thousand
  // member server the old serial `await` was bottlenecked on round-trip latency.
  // Run a bounded pool instead - discord.js's rate limiter packs the concurrent
  // requests and backs off on 429s, so this is ~10x faster without risking a
  // global rate-limit that would starve bans/verifications on other guilds.
  const CONCURRENCY = 10;
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const m = targets[i++];
      await m.roles.add(role, 'MadHoney: grandfathered existing member')
        .then(() => progress.added++)
        .catch((e) => { progress.failed++; failures.push(`${m.user.tag}: ${e.message}`); });
      progress.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));
  saveGuild(guild.id, { grandfatherPending: false, grandfatheredAt: new Date().toISOString() });
  return t('dash.act.gfDone', loc, { role: role.name, added: progress.added, skipped: progress.skipped, failedPart: failures.length ? t('dash.act.gfFailed', loc, { n: failures.length, role: role.name, list: failures.slice(0, 5).join(', ') }) : '' });
}

// WorkerBee app id, derived from its token (a bot token's first segment is the
// base64 bot user id) so the invite link needs no extra config.
export function workerBeeInvite() {
  const tok = process.env.SIDECAR_TOKEN;
  if (!tok) return null;
  let id; try { id = Buffer.from(tok.split('.')[0], 'base64').toString('utf8'); } catch { return null; }
  return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=268435456`; // Manage Roles
}

// Bulk grandfathering while MadHoney's own Server Members intent is unavailable
// (pending Discord review). MadHoney orchestrates WorkerBee - a separate helper
// app that DOES hold the intent: it logs WorkerBee in, has it fetch the member
// list and grant the verified role, then WorkerBee LEAVES the server. Same
// signature + progress shape as grandfather(), so it drops straight into the
// dashboard's slow-job runner. Security: the grandfatheredAt cutoff means anyone
// who joined AFTER grandfathering still has to verify - never auto-granted.
let workerBeeBusy = false; // one WorkerBee gateway login at a time (shared token)
export async function grandfatherViaWorkerBee(guild, cfg, progress = {}, loc = cfg?.locale) {
  const token = process.env.SIDECAR_TOKEN;
  if (!token) throw new Error('WorkerBee helper is not configured (SIDECAR_TOKEN unset).');
  if (!cfg?.verifiedRoleId) throw new Error('Set a verified role before grandfathering.');
  // Two concurrent logins with WorkerBee's single token would fight over the
  // gateway connection - serialize so one server's run finishes before the next.
  if (workerBeeBusy) throw new Error('WorkerBee is grandfathering another server right now — try again in a minute.');
  workerBeeBusy = true;
  const invite = workerBeeInvite();
  const wb = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('WorkerBee took too long to connect.')), 30_000);
      wb.once(Events.ClientReady, () => { clearTimeout(timer); res(); });
      wb.login(token).catch((e) => { clearTimeout(timer); rej(new Error(`WorkerBee could not log in: ${e.message}`)); });
    });
    const wbGuild = await wb.guilds.fetch(guild.id).then((g) => g.fetch()).catch(() => null);
    if (!wbGuild) throw new Error(`WorkerBee isn't in this server yet. Invite it first: ${invite}`);
    const role = await wbGuild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
    if (!role) throw new Error('The verified role no longer exists.');
    const me = await wbGuild.members.fetchMe();
    if (me.roles.highest.comparePositionTo(role) <= 0) {
      throw new Error(`WorkerBee's role must sit ABOVE "${role.name}". In Server Settings › Roles, drag WorkerBee's role above it, then run this again.`);
    }
    const cutoffMs = cfg.grandfatheredAt ? Date.parse(cfg.grandfatheredAt) : null;
    const members = await wbGuild.members.fetch(); // needs the Server Members intent - WorkerBee has it
    const targets = [];
    let skipped = 0;
    for (const m of members.values()) {
      if (m.user.bot || m.roles.cache.has(role.id)) { skipped++; continue; }
      if (cutoffMs !== null && m.joinedTimestamp >= cutoffMs) { skipped++; continue; } // joined after verification - must verify
      targets.push(m);
    }
    Object.assign(progress, { label: 'Grandfathering via WorkerBee', total: targets.length, done: 0, added: 0, skipped, failed: 0 });
    const failures = [];
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const m = targets[i++];
        await m.roles.add(role, 'MadHoney via WorkerBee: grandfathered existing member')
          .then(() => progress.added++)
          .catch((e) => { progress.failed++; if (failures.length < 5) failures.push(`${m.user.tag}: ${e.message}`); });
        progress.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(10, targets.length || 1) }, worker));
    if (!cfg.grandfatheredAt) saveGuild(guild.id, { grandfatherPending: false, grandfatheredAt: new Date().toISOString() });
    await wbGuild.leave().catch(() => { /* admin can kick it manually */ });
    return t('dash.act.gfDone', loc, { role: role.name, added: progress.added, skipped: progress.skipped, failedPart: failures.length ? t('dash.act.gfFailed', loc, { n: failures.length, role: role.name, list: failures.slice(0, 5).join(', ') }) : '' }) + ' 🐝';
  } finally {
    await wb.destroy().catch(() => {});
    workerBeeBusy = false;
  }
}

// Ban from List: proactively ban every user on the active shared list (bans
// from OTHER sharing servers that weren't undone), instead of waiting for
// them to join. Requires ban sharing to be ON for this server.
export async function syncBans(guild, cfg, progress = {}, loc = cfg?.locale) {
  if (!cfg.banShare) throw new Error(t('dash.act.sbOff', loc));
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.BanMembers)) throw new Error(t('dash.act.sbNoBan', loc));
  saveGuild(guild.id, { banSyncPending: true }); // resumable across restarts (see ClientReady)

  // universal list: latest state per (user, guild); an unban reverses the entry
  const allRows = bans();
  const resolved = resolvedIncidents(allRows); // incidents cleared by an approved appeal
  const perGuild = new Map();
  for (const b of allRows) {
    if (b.guildId !== guild.id) perGuild.set(`${b.id}:${b.guildId}`, b);
  }
  const pool = new Map(); // userId -> { tag, incidentId }
  for (const b of perGuild.values()) {
    if (b.unbanned) continue;
    if (b.incidentId && resolved.has(b.incidentId)) continue; // appeal cleared it network-wide
    pool.set(b.id, { tag: b.tag, incidentId: b.incidentId }); // last writer wins; fine for the tag
  }

  // ponytail: bans.fetch caps at 1000 entries; paginate if a server ever exceeds it
  const existing = await guild.bans.fetch();
  const already = new Set([...existing.keys(), ...bans(guild.id).filter((b) => !b.unbanned).map((b) => b.id)]);

  Object.assign(progress, { label: 'Ban sync', total: pool.size, done: 0, added: 0, skipped: 0, failed: 0 });
  // users already banned here need no API call; ban the rest with a bounded pool
  // (same rationale as grandfather() above - ~10x faster on big shared lists,
  // and logBan is synchronous so concurrent workers can't race the ban log)
  const targets = [];
  for (const [id, info] of pool) {
    if (already.has(id)) { progress.skipped++; progress.done++; }
    else targets.push([id, info]);
  }
  const CONCURRENCY = 10;
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const [id, info] = targets[i++];
      try {
        await guild.bans.create(id, { reason: 'MadHoney: synced from the shared ban list' });
        logBan({ id, tag: info.tag, guildId: guild.id, channel: '(ban-sync)', at: new Date().toISOString(), incidentId: info.incidentId });
        progress.added++;
      } catch { progress.failed++; }
      progress.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));
  saveGuild(guild.id, { banSyncPending: false });
  return t('dash.act.sbDone', loc, { added: progress.added, skipped: progress.skipped, failedPart: progress.failed ? t('dash.act.sbFailed', loc, { n: progress.failed }) : '', pool: pool.size });
}
