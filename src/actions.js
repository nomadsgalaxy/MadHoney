// Guild actions shared by the slash commands (bot.js) and the dashboard
// (dashboard.js). Each takes a discord.js Guild + the stored config and
// returns a human-readable result string.
import { PermissionFlagsBits, ChannelType, OverwriteType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { createHash, randomBytes } from 'node:crypto';
import { renderBanner, DEFAULT_BANNER, creditSuffix } from './banner.js';
import { resolvedIncidents } from './incident.js';
import { honeypotMode } from './trap.js';
import { compromisedSettings } from './compromised.js';
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
const { getGuild, saveGuild, bans, logBan } = await import(process.env.MADHONEY_STORE ?? './store.js'); // pluggable store backend

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
    // is explicitly allowed to view - on the channel itself, OR inherited from a
    // synced parent category (surgical gating leaves synced children untouched;
    // showing them un-gated would invite a re-select that breaks their sync).
    const parent = ch.parentId ? channels.get(ch.parentId) : null;
    const gatedViaCategory = !!parent && ch.permissionsLocked === true &&
      !!parent.permissionOverwrites?.cache.get(cfg.verifiedRoleId)?.allow.has(PermissionFlagsBits.ViewChannel);
    const gated = kind !== 'public' && kind !== 'verify' && kind !== 'honeypot' &&
      (!!ch.permissionOverwrites.cache.get(cfg.verifiedRoleId)?.allow.has(PermissionFlagsBits.ViewChannel) || gatedViaCategory);
    list.push({ id: ch.id, name: ch.name, kind, gated, isCategory: ch.type === ChannelType.GuildCategory, parentId: ch.parentId, position: ch.rawPosition ?? 0, canManage });
  }
  return list;
}

// ---- surgical gating: snapshot / exact-restore of the bits we touch ----
// Gating must never trample a server's existing permission setup (learned the
// hard way on a large server with per-role rules). Before editing an overwrite
// we record the PRIOR state of exactly the bits we change; Restore replays that
// record instead of blind-clearing. Pure + unit-tested (test/test-gating.mjs).
export const GATE_BITS = {
  v: PermissionFlagsBits.ViewChannel,
  s: PermissionFlagsBits.SendMessages,
  m: PermissionFlagsBits.ManageMessages,
  r: PermissionFlagsBits.ReadMessageHistory,
};
// ow = { allow, deny } as bigints, or null when no overwrite existed for the
// target. Returns e.g. { x:1, v:'n' } / { v:'a', s:'d' }  (a=allow d=deny n=neutral).
export function snapshotOverwrite(ow, bits) {
  const rec = {};
  if (!ow) rec.x = 1; // target had NO overwrite - restore deletes it entirely
  for (const b of bits) {
    rec[b] = !ow ? 'n' : (ow.allow & GATE_BITS[b]) === GATE_BITS[b] ? 'a'
      : (ow.deny & GATE_BITS[b]) === GATE_BITS[b] ? 'd' : 'n';
  }
  return rec;
}
// Turn a snapshot back into a permissionOverwrites.edit() patch.
export function restorePatch(rec) {
  const FLAG = { v: 'ViewChannel', s: 'SendMessages', m: 'ManageMessages', r: 'ReadMessageHistory' };
  const patch = {};
  for (const [b, state] of Object.entries(rec)) {
    if (b === 'x') continue;
    patch[FLAG[b]] = state === 'a' ? true : state === 'd' ? false : null;
  }
  return patch;
}
// True when the overwrite only carries bits we manage - safe to DELETE outright
// (restores category sync / pre-gate absence). If the admin added other bits
// since gating, we must edit our bits back instead of deleting their work.
export function onlyManagedBits(ow, rec) {
  let mask = 0n;
  for (const b of Object.keys(rec)) if (b !== 'x') mask |= GATE_BITS[b];
  return ((ow.allow | ow.deny) & ~mask) === 0n;
}
// A channel that deliberately hides from specific roles (View DENY on a role
// other than @everyone/verified) is a trap for gating: Discord resolves "any
// role-allow beats any role-deny", so adding a verified-role allow would make
// the channel visible to members the admin explicitly hid it from. Those
// channels need a human decision, not a blanket gate.
export function hasCustomRoleDeny(overwrites, everyoneId, verifiedId) {
  return overwrites.some((o) => o.type === OverwriteType.Role && o.id !== everyoneId
    && o.id !== verifiedId && (o.deny & GATE_BITS.v) === GATE_BITS.v);
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

  const plan = { gate: [], keep: [], honeypot: [], skip: [], noaccess: [], custom: [], synced: [] };
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
    // with an explicit View allow ONLY when a gated parent category would
    // otherwise hide them. An explicit dashboard selection (gateSet) still overrides.
    const isReadonly = !gateSet && everyoneView && !everyonePosts
      && ch.id !== cfg.honeypotChannelId && ch.id !== cfg.verifyChannelId;
    // Non-standard permissions need a human: a channel hidden from specific
    // roles would become visible to those members through the verified-role
    // allow (role-allow beats role-deny). Auto mode leaves it alone and reports
    // it; an explicit dashboard selection gates it (the admin decided).
    const customPerms = !gateSet && hasCustomRoleDeny(
      [...ch.permissionOverwrites.cache.values()].map((o) => ({ type: o.type, id: o.id, deny: o.deny.bitfield })),
      everyone.id, role.id);
    const wantGate = gateSet ? gateSet.has(ch.id) : (everyoneView && everyonePosts);
    const target = ch.id === cfg.honeypotChannelId ? 'honeypot'
      : ch.id === cfg.verifyChannelId ? 'keep'
      : wantGate ? (customPerms ? 'custom' : 'gate')
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
  // A child synced with a gated parent category needs NO edits of its own - the
  // category's deny/allow cascade does the gating. Touching it would break the
  // sync the admin manages perms through, so don't.
  for (let i = plan.gate.length - 1; i >= 0; i--) {
    const c = plan.gate[i];
    if (c.parentId && gatedCatIds.has(c.parentId) && c.permissionsLocked) {
      plan.synced.push(c);
      plan.gate.splice(i, 1);
    }
  }

  const name = (c) => `${c.type === ChannelType.GuildCategory ? '▸' : '#'}${c.name}`;
  const none = t('dash.act.gNone', loc);
  const lines = [
    t('dash.act.gLineGate', loc, { role: role.name, n: plan.gate.length, list: plan.gate.map(name).join(', ') || none }),
    ...(plan.synced.length ? [t('dash.act.gLineSynced', loc, { n: plan.synced.length, list: plan.synced.map(name).join(', ') })] : []),
    ...(plan.custom.length ? [t('dash.act.gLineCustom', loc, { n: plan.custom.length, list: plan.custom.map(name).join(', ') })] : []),
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
  const botTarget = me.roles.botRole ?? me;
  const backup = { ...cfg.gateBackup };
  // A channel gated BEFORE snapshots existed is already in its gated state -
  // snapshotting now would record our own edits and make Restore re-apply them.
  // Those stay on the legacy restore path (rec absent) forever. Every channel
  // the NEW code manages gets an explicit record - a real snapshot, or a marker
  // (_cat = gated via its synced category, _keep = kept public untouched) - so
  // "no record" unambiguously means legacy.
  const isLegacy = (id) => (cfg.gatedChannels ?? []).includes(id) && !cfg.gateBackup?.[id];

  // PHASE 1 - stage snapshots for every bit we MIGHT touch, from PRE-edit state.
  // This must happen before ANY edit: gating a category makes Discord cascade
  // real overwrite changes into its synced children, so a snapshot taken mid-run
  // could record our own edits as "pre-gate" state. First gate wins: bits already
  // recorded by an earlier run are never re-snapshotted.
  const staged = new Map(); // channelId -> { targetId: snapshot }
  const stage = (ch, targetId, bits) => {
    if (isLegacy(ch.id)) return;
    const prior = backup[ch.id];
    if (prior?.[targetId]) return; // real record from an earlier gate wins
    const s = staged.get(ch.id) ?? {};
    if (s[targetId]) return;
    const ow = ch.permissionOverwrites.cache.get(targetId);
    s[targetId] = snapshotOverwrite(ow ? { allow: ow.allow.bitfield, deny: ow.deny.bitfield } : null, bits);
    staged.set(ch.id, s);
  };
  // Keep-pin need is decided from PRE-edit visibility too (once the gate loop
  // denies a parent category, every child would look pinnable).
  const keepPin = new Map();
  for (const ch of plan.gate) { stage(ch, role.id, ['v']); stage(ch, everyone.id, ['v']); stage(ch, botTarget.id, ['v', 'm', 'r']); }
  for (const ch of plan.keep) {
    // Pin an explicit @everyone View allow ONLY where it's needed to punch
    // through a gated parent category (or the channel is currently hidden).
    // Stamping it unconditionally rewrites permissions on channels we have no
    // business touching - the exact "it overwrote my perms" complaint.
    const needsPin = (ch.parentId && gatedCatIds.has(ch.parentId))
      || !ch.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel);
    keepPin.set(ch.id, needsPin);
    if (needsPin) stage(ch, everyone.id, ['v']);
    if (ch.id === cfg.verifyChannelId) stage(ch, botTarget.id, ['v', 'm', 'r']);
  }
  for (const ch of plan.honeypot) { stage(ch, everyone.id, ['v', 's']); stage(ch, role.id, ['v']); stage(ch, botTarget.id, ['v', 'm', 'r']); }
  for (const ch of protect) stage(ch, role.id, ['v']);

  // PHASE 2 - edits. A channel's staged snapshot and its membership in
  // gatedChannels are committed ONLY when its edits succeed; a failed channel
  // keeps no phantom record (Restore must never act on edits that didn't happen).
  const succeeded = new Set();
  const tryEdit = async (ch, fn) => {
    try {
      await fn(); ok++; succeeded.add(ch.id);
      const s = staged.get(ch.id);
      if (s) {
        const base = { ...backup[ch.id] };
        delete base._cat; delete base._keep; // real edits supersede a marker
        backup[ch.id] = { ...base, ...s };
      }
    } catch (e) { failed.push(`${name(ch)} (${e.message})`); }
  };
  // Gating denies @everyone View, which would blind the BOT ITSELF on servers
  // where it isn't Administrator (it doesn't hold the verified role) — it could
  // no longer monitor gated channels (compromised-account detection) or manage
  // them later. Pin its access with an explicit overwrite on its managed role.
  // ManageMessages can only be self-granted where the bot already holds it
  // (Discord rule), so fall back to View-only when that edit is refused.
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
  // Synced children are gated via their category: no edits, and a `_cat` marker
  // (unless a real record already exists) so Restore knows there is deliberately
  // nothing to undo on the channel itself - its category's restore un-gates it.
  for (const ch of plan.synced) {
    if (!backup[ch.id] || backup[ch.id]._keep) backup[ch.id] = { _cat: 1 };
    ok++; succeeded.add(ch.id);
  }
  for (const ch of plan.keep) {
    await tryEdit(ch, async () => {
      if (keepPin.get(ch.id)) {
        await ch.permissionOverwrites.edit(everyone, { ViewChannel: true }, { reason: 'MadHoney: keep this channel public' });
      }
      // Pin the bot's own access to the verify channel too, so a later @everyone
      // View change can't lock it out of managing the verify panel (same guard the
      // gated channels + honeypot get).
      if (ch.id === cfg.verifyChannelId) await keepBotAccess(ch, 'MadHoney: keep bot able to manage the verify panel');
    });
  }
  // Keep channels we deliberately did NOT touch still get a marker: without one
  // they'd read as legacy and Restore would null-clear channels we never edited.
  for (const ch of plan.keep) if (succeeded.has(ch.id) && !backup[ch.id]) backup[ch.id] = { _keep: 1 };
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
  // auto-detection. gatedChannels is a UNION with what was already managed: a
  // narrower re-gate selection must not strand still-gated channels outside
  // Restore's reach. Entries for channels that no longer exist are pruned.
  const treatment = { ...cfg.channelTreatment };
  for (const c of [...plan.gate, ...plan.synced]) if (succeeded.has(c.id)) treatment[c.id] = 'gate';
  for (const c of plan.keep) if (succeeded.has(c.id) && c.id !== cfg.verifyChannelId) treatment[c.id] = 'public';
  for (const c of [...plan.skip, ...plan.custom]) treatment[c.id] = 'leave';
  const managed = new Set(cfg.gatedChannels ?? []);
  for (const c of [...plan.gate, ...plan.synced, ...plan.keep, ...plan.honeypot, ...protect]) {
    if (succeeded.has(c.id)) managed.add(c.id);
  }
  for (const id of [...managed]) if (!channels.has(id)) managed.delete(id);
  for (const id of Object.keys(backup)) if (!channels.has(id)) delete backup[id];
  saveGuild(guild.id, {
    gatedChannels: [...managed],
    channelTreatment: treatment,
    gateBackup: backup,
  });
  // Self-heal: an applied gate also restores bot access on anything it had
  // previously gated but gone blind on (see repairBotAccess).
  const repaired = await repairBotAccess(guild, getGuild(guild.id) ?? cfg, loc).catch(() => null);
  return t('dash.act.gDone', loc, {
    repaired: repaired && !repaired.startsWith(t('dash.act.raNone', loc)) ? `\n${repaired}` : '',
    ok, failed: failed.length,
    unreachable: plan.noaccess.length ? t('dash.act.gUnreachable', loc, { n: plan.noaccess.length }) : '',
    failedList: failed.length ? t('dash.act.gFailedList', loc, { list: failed.join(', ') }) : '',
    lines: lines.join('\n'),
  });
}


// Back-fill the bot's own access on channels MadHoney already gated.
//
// Servers gated before the bot-access pin existed denied @everyone View without
// granting the bot anything, so MadHoney went blind on exactly the channels it
// is supposed to watch - compromised-account detection cannot see a blast there.
// A normal re-gate does not fix it: an already-gated channel no longer looks
// public, so the planner skips it.
//
// The catch is that the bot cannot edit permissions on a channel it cannot see
// (Discord returns Missing Access). The verified role CAN see gated channels -
// that is the gate - so the bot briefly grants itself that role, pins its
// access, and drops the role again. try/finally guarantees the role comes back
// off even if an edit throws.
export async function repairBotAccess(guild, cfg, loc = cfg?.locale) {
  const me = await guild.members.fetchMe();
  const botTarget = me.roles.botRole ?? me;
  const ids = new Set([...(cfg.gatedChannels ?? []), ...memberPostableChannels(guild, cfg).map((c) => c.id)]);
  const blind = [];
  for (const id of ids) {
    const ch = guild.channels.cache.get(id);
    if (!ch || ch.id === cfg.verifyChannelId) continue;
    if (!ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) blind.push(ch);
  }
  if (!blind.length) return t('dash.act.raNone', loc);

  const role = cfg.verifiedRoleId ? await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null) : null;
  // Only borrow the role when we actually need to and are allowed to.
  const canBorrow = role && me.permissions.has(PermissionFlagsBits.ManageRoles)
    && me.roles.highest.comparePositionTo(role) > 0 && !me.roles.cache.has(role.id);
  let borrowed = false;
  let fixed = 0; const failed = [];
  try {
    if (canBorrow) {
      await me.roles.add(role, 'MadHoney: temporary self-verify to restore bot access').then(() => { borrowed = true; }).catch(() => {});
      if (borrowed) await new Promise((r) => setTimeout(r, 2500)); // let the grant propagate
    }
    for (const ch of blind) {
      try {
        await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, ReadMessageHistory: true, ManageMessages: true },
          { reason: 'MadHoney: restore bot access to a gated channel' });
        fixed++;
      } catch {
        // ManageMessages cannot always be self-granted; View alone still restores detection
        try {
          await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, ReadMessageHistory: true },
            { reason: 'MadHoney: restore bot access to a gated channel' });
          fixed++;
        } catch (e) { failed.push(`#${ch.name} (${e.message})`); }
      }
    }
  } finally {
    if (borrowed) await me.roles.remove(role, 'MadHoney: remove temporary verify role').catch(() => {});
  }
  return t('dash.act.raDone', loc, {
    fixed, found: blind.length,
    failedPart: failed.length ? t('dash.act.raFailed', loc, { n: failed.length, list: failed.slice(0, 5).join(', ') }) : '',
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
  if (cfg?.autoGate === false) return null; // opt-out: this server manages gating manually (no auto-gate of new/offline channels)
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
  // Non-standard permissions (View denied to specific roles) - auto-gating
  // would make the channel visible to those members via the verified-role
  // allow. Leave it to the admin and say so (same rule as gateChannels).
  if (hasCustomRoleDeny(
    [...channel.permissionOverwrites.cache.values()].map((o) => ({ type: o.type, id: o.id, deny: o.deny.bitfield })),
    everyone.id, role.id)) {
    const f = getGuild(guild.id) ?? cfg;
    saveGuild(guild.id, { channelTreatment: { ...f.channelTreatment, [channel.id]: 'leave' } });
    return t('dash.act.anCustom', loc, { channel: channel.name });
  }
  // Snapshot prior state (same record Restore replays - see gateChannels).
  // Config is re-read FRESH here and again at save: during the boot catch-up
  // sweep or a burst of channel creates, interleaved gateNewChannel calls with a
  // stale cfg would drop each other's snapshots on save. Rules: a legacy-era
  // channel (managed but recordless) is never snapshotted (its current state is
  // our own gate); a real prior record wins; a marker-only record (_cat/_keep)
  // is superseded by a fresh snapshot since we're about to make real edits.
  const newBotTarget = me.roles.botRole ?? me;
  const before = getGuild(guild.id) ?? cfg;
  const prior = before.gateBackup?.[channel.id];
  const priorIsMarker = !!prior && !Object.keys(prior).some((k) => k !== '_cat' && k !== '_keep');
  const wasLegacy = (before.gatedChannels ?? []).includes(channel.id) && !prior;
  let rec = null;
  if (!wasLegacy && (!prior || priorIsMarker)) {
    const snapOf = (targetId, bits) => {
      const ow = channel.permissionOverwrites.cache.get(targetId);
      return snapshotOverwrite(ow ? { allow: ow.allow.bitfield, deny: ow.deny.bitfield } : null, bits);
    };
    rec = {
      [role.id]: snapOf(role.id, ['v']),
      [everyone.id]: snapOf(everyone.id, ['v']),
      [newBotTarget.id]: snapOf(newBotTarget.id, ['v', 'm', 'r']),
    };
  }
  // role-first ordering (see gateChannels) so the bot doesn't lock itself out
  await channel.permissionOverwrites.edit(role, { ViewChannel: true }, { reason: 'MadHoney: auto-gate new channel' });
  await channel.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: 'MadHoney: auto-gate new channel' });
  // same bot-access pin as gateChannels (monitoring + later management)
  try {
    await channel.permissionOverwrites.edit(newBotTarget, { ViewChannel: true, ManageMessages: true, ReadMessageHistory: true }, { reason: 'MadHoney: keep bot able to monitor the gated channel' });
  } catch {
    await channel.permissionOverwrites.edit(newBotTarget, { ViewChannel: true, ReadMessageHistory: true }, { reason: 'MadHoney: keep bot able to monitor the gated channel' }).catch(() => {});
  }
  const fresh = getGuild(guild.id) ?? cfg;
  saveGuild(guild.id, {
    gatedChannels: (fresh.gatedChannels ?? []).includes(channel.id) ? fresh.gatedChannels : [...(fresh.gatedChannels ?? []), channel.id],
    channelTreatment: { ...fresh.channelTreatment, [channel.id]: 'gate' },
    ...(rec ? { gateBackup: { ...fresh.gateBackup, [channel.id]: rec } } : {}),
  });
  return t('dash.act.anGated', loc, { channel: channel.name, role: role.name });
}

// Reverse gating. Channels gated with a snapshot (cfg.gateBackup) get their
// EXACT pre-gate state back, bit by bit: an explicit allow returns as an allow,
// neutral returns as neutral, and an overwrite MadHoney created from nothing is
// deleted outright (which also restores category sync). Channels gated before
// snapshots existed fall back to clearing only the bits gating sets - never
// SendMessages on a normal channel (only the honeypot's Send was ever ours).
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
      const ow = ch.permissionOverwrites?.cache ?? new Map();
      const everyoneDenied = ow.get(everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel);
      const someRoleAllows = [...ow.values()].some((o) => o.id !== everyone.id && o.allow.has(PermissionFlagsBits.ViewChannel));
      return everyoneDenied && !someRoleAllows;
    }).map((ch) => ch.id);
    if (!ids.length) throw new Error(t('dash.act.unNothing', loc));
    note = t('dash.act.unRecovered', loc);
  }
  let ok = 0; const failed = []; const failedIds = [];
  const unMe = await guild.members.fetchMe();
  const unBotTarget = unMe.roles.botRole ?? unMe;
  const reason = 'MadHoney: restore pre-gate permissions';
  const legacyClear = async (ch, honeypot) => {
    await ch.permissionOverwrites.edit(everyone, { ViewChannel: null, ...(honeypot ? { SendMessages: null } : {}) }, { reason });
    if (role) await ch.permissionOverwrites.edit(role, { ViewChannel: null }, { reason });
    // clear the bot-access pin gateChannels added (best-effort; harmless if absent)
    await ch.permissionOverwrites.edit(unBotTarget, { ViewChannel: null, ManageMessages: null, ReadMessageHistory: null }, { reason }).catch(() => {});
  };
  for (const id of ids) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch) continue; // deleted - nothing to restore, entry is dropped below
    try {
      const rec = cfg.gateBackup?.[id];
      const targets = rec ? Object.entries(rec).filter(([k]) => k !== '_cat' && k !== '_keep') : null;
      if (rec && !targets.length) {
        // Marker-only record. _keep = we never touched it. _cat = gated via a
        // synced category, whose own restore un-gates it - UNLESS the channel
        // has since been moved/unsynced: then it carries the mirrored gate
        // overwrites itself, so clear those (a still-synced child is left alone;
        // editing it would break the very sync we preserved).
        if (rec._cat && ch.permissionsLocked !== true
          && ch.permissionOverwrites.cache.get(everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel)) {
          await legacyClear(ch, false);
        }
        ok++; continue;
      }
      if (rec) {
        // exact restore from the snapshot taken when this channel was gated
        for (const [targetId, tRec] of targets) {
          const cur = ch.permissionOverwrites.cache.get(targetId);
          if (!cur) continue; // already gone - nothing to undo
          if (tRec.x && onlyManagedBits({ allow: cur.allow.bitfield, deny: cur.deny.bitfield }, tRec)) {
            // we created this overwrite and nobody added to it: remove it whole
            await ch.permissionOverwrites.delete(targetId, reason);
          } else {
            await ch.permissionOverwrites.edit(targetId, restorePatch(tRec), { reason });
          }
        }
      } else {
        // legacy (pre-snapshot) gate: clear only bits gating ever set here
        await legacyClear(ch, id === cfg.honeypotChannelId);
      }
      ok++;
    } catch (e) { failed.push(`#${ch.name} (${e.message})`); failedIds.push(id); }
  }
  // Channels whose restore FAILED keep their bookkeeping so Restore can be
  // retried; everything successfully restored (or deleted) is released.
  const keptBackup = {};
  for (const id of failedIds) if (cfg.gateBackup?.[id]) keptBackup[id] = cfg.gateBackup[id];
  saveGuild(guild.id, { gatedChannels: failedIds, gateBackup: keptBackup });
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
// Permissions that are dangerous to hand to everyone who verifies (and to
// mass-grant during grandfathering). Raw bits so the check is pure + testable,
// independent of discord.js. Administrator is the accidental-server-wide-admin.
export const DANGEROUS_ROLE_PERMS = {
  Administrator: 1n << 3n, 'Manage Server': 1n << 5n, 'Ban Members': 1n << 2n,
  'Kick Members': 1n << 1n, 'Manage Roles': 1n << 28n, 'Manage Channels': 1n << 4n,
};
export function dangerousRolePerms(bitfield) {
  const bits = BigInt(bitfield);
  return Object.entries(DANGEROUS_ROLE_PERMS).filter(([, b]) => (bits & b) === b).map(([n]) => n);
}
// Channels actually gated behind verification, excluding the verify gateway and
// the honeypot (which live in gatedChannels but aren't "content"). Empty while
// verification is on = unverified members can still reach everything.
export function contentGatedChannels(cfg) {
  return (cfg?.gatedChannels ?? []).filter((id) => id !== cfg?.verifyChannelId && id !== cfg?.honeypotChannelId);
}


// Channels a REGULAR member can post in - the actual attack surface for a
// compromised account. Staff are exempt from detection and read-only or
// mod-only channels cannot be blasted, so neither needs bot coverage.
export function memberPostableChannels(guild, cfg) {
  const everyone = guild.roles.everyone;
  const verified = cfg?.verifiedRoleId ? guild.roles.cache.get(cfg.verifiedRoleId) : null;
  const out = [];
  for (const ch of guild.channels.cache.values()) {
    if (!ch || ch.type === ChannelType.GuildCategory) continue;
    if (!ch.isTextBased?.() && !ch.isVoiceBased?.()) continue;
    if (ch.id === cfg?.honeypotChannelId) continue; // the trap has its own rules
    const post = ch.isVoiceBased?.() ? PermissionFlagsBits.Connect : PermissionFlagsBits.SendMessages;
    const open = (role) => { const p = ch.permissionsFor(role); return !!p && p.has(PermissionFlagsBits.ViewChannel) && p.has(post); };
    if (open(everyone) || (verified && open(verified))) out.push(ch);
  }
  return out;
}


// ---- permission resolution we can reason about (and unit-test) ----
// Discord resolves a channel as: base role perms -> @everyone overwrite ->
// OR of role denies then OR of role allows -> member overwrite. Administrator
// short-circuits everything. Categories do NOT cascade at runtime - a child
// only inherits by being synced - but Discord still requires access to the
// PARENT before it will let you edit a child's overwrites, which is why a
// category the bot cannot see makes its children unmanageable.
const ALL_PERMS = (1n << 64n) - 1n;
export function resolveChannelPerms({ basePerms, everyoneOverwrite, roleOverwrites = [], memberOverwrite }) {
  let p = BigInt(basePerms);
  if ((p & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) return ALL_PERMS;
  if (everyoneOverwrite) p = (p & ~BigInt(everyoneOverwrite.deny)) | BigInt(everyoneOverwrite.allow);
  let allow = 0n, deny = 0n;
  for (const o of roleOverwrites) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
  p = (p & ~deny) | allow;
  if (memberOverwrite) p = (p & ~BigInt(memberOverwrite.deny)) | BigInt(memberOverwrite.allow);
  return p;
}
// The bot's effective permissions on a channel if it did NOT hold `dropRoleId`.
function botPermsWithout(guild, me, ch, dropRoleId) {
  const roleIds = [...me.roles.cache.keys()].filter((id) => id !== dropRoleId && id !== guild.id);
  let base = guild.roles.everyone.permissions.bitfield;
  for (const id of roleIds) base |= guild.roles.cache.get(id)?.permissions.bitfield ?? 0n;
  const ow = ch.permissionOverwrites.cache;
  return resolveChannelPerms({
    basePerms: base,
    everyoneOverwrite: ow.get(guild.id) && { allow: ow.get(guild.id).allow.bitfield, deny: ow.get(guild.id).deny.bitfield },
    roleOverwrites: roleIds.filter((id) => ow.has(id)).map((id) => ({ allow: ow.get(id).allow.bitfield, deny: ow.get(id).deny.bitfield })),
    memberOverwrite: ow.get(me.id) && { allow: ow.get(me.id).allow.bitfield, deny: ow.get(me.id).deny.bitfield },
  });
}

// INVARIANT: MadHoney must never hold a server's verified role.
// A correctly configured honeypot DENIES View to the verified role, so a bot
// wearing it goes blind on its own trap - the trap stays armed and silently
// catches nothing. The role gets stuck there when an admin grants it by hand,
// or when repairBotAccess's temporary borrow is interrupted mid-run.
// Dropping it is only safe once the bot's access no longer depends on it, so we
// pin an explicit overwrite on anything it would otherwise lose first.
export async function dropStrayVerifiedRole(guild, cfg, loc = cfg?.locale) {
  if (!cfg?.verifiedRoleId) return null;
  const me = await guild.members.fetchMe();
  if (!me.roles.cache.has(cfg.verifiedRoleId)) return null;
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) return null;
  const botTarget = me.roles.botRole ?? me;
  const wouldLose = [];
  for (const ch of guild.channels.cache.values()) {
    // threads are in this cache too and carry no overwrites of their own -
    // they inherit from the parent channel, so there is nothing to pin on them
    if (!ch || ch.type === ChannelType.GuildCategory || ch.isThread?.() || !ch.permissionOverwrites) continue;
    const now = ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel);
    if (!now) continue;
    const after = (botPermsWithout(guild, me, ch, cfg.verifiedRoleId) & PermissionFlagsBits.ViewChannel) === PermissionFlagsBits.ViewChannel;
    if (!after) wouldLose.push(ch);
  }
  const failed = [];
  for (const ch of wouldLose) {
    try {
      await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, ReadMessageHistory: true, ManageMessages: true },
        { reason: 'MadHoney: pin bot access before dropping a stray verified role' });
    } catch {
      try {
        await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, ReadMessageHistory: true },
          { reason: 'MadHoney: pin bot access before dropping a stray verified role' });
      } catch (e) { failed.push(`#${ch.name}`); }
    }
  }
  // Refuse to drop the role if we could not secure every channel it was providing.
  if (failed.length) return t('dash.act.svBlocked', loc, { n: failed.length, list: failed.slice(0, 5).join(', ') });
  try {
    await me.roles.remove(role, 'MadHoney: the bot must not hold the verified role (it blinds the honeypot)');
  } catch (e) {
    return t('dash.act.svCantRemove', loc, { role: role.name, err: e.message });
  }
  return t('dash.act.svDropped', loc, { role: role.name, pinned: wouldLose.length });
}

// Categories the bot cannot see that contain channels it is supposed to manage.
// Discord refuses child-overwrite edits without access to the parent, so those
// channels are unmanageable. Most are still self-fixable: repairBotAccess can
// briefly borrow the verified role, and that role can usually see the category.
// Only categories hidden from the verified role TOO are a dead end that needs a
// human, so those are all we report - warning about the rest would cry wolf on
// servers where pressing Apply genuinely fixes it.
export function lockedCategories(guild, cfg, me) {
  const verified = cfg?.verifiedRoleId ? guild.roles.cache.get(cfg.verifiedRoleId) : null;
  const relevant = new Set([...(cfg?.gatedChannels ?? []), ...memberPostableChannels(guild, cfg).map((c) => c.id)]);
  const out = new Map();
  for (const id of relevant) {
    const ch = guild.channels.cache.get(id);
    if (!ch?.parentId) continue;
    const cat = guild.channels.cache.get(ch.parentId);
    if (!cat || out.has(cat.id)) continue;
    if (cat.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) continue;      // visible: fine
    if (verified && cat.permissionsFor(verified)?.has(PermissionFlagsBits.ViewChannel)) continue; // reachable by borrowing the role
    out.set(cat.id, cat);
  }
  return [...out.values()];
}

// Health check for a verify-enabled server: returns EVERY problem it finds as
// { level, msg }, most severe first (empty array = healthy). 'block' issues make
// core actions fail or cause harm at scale, so grandfather() refuses on them;
// 'warn' issues are surfaced in the dashboard but don't block. Built from real
// misconfigurations seen in the wild - a config can look complete while the
// server is silently broken, so this validates the actual DISCORD state.
export async function preflight(guild, cfg, loc = cfg?.locale) {
  const issues = [];
  const push = (level, key, params) => issues.push({ level, msg: t(key, loc, params) });
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) { push('block', 'dash.act.pfRoleMissing'); return issues; }
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) push('block', 'dash.act.pfNoManageRoles');
  else if (me.roles.highest.comparePositionTo(role) <= 0) push('block', 'dash.act.pfBelow', { me: me.roles.highest.name, role: role.name });
  // Dangerous verified role: everyone who verifies inherits these, and
  // grandfathering grants them to every existing member at once. Administrator is
  // catastrophic enough to BLOCK grandfathering; lesser mod perms just warn.
  const dangerous = dangerousRolePerms(role.permissions.bitfield);
  if (dangerous.length) push(dangerous.includes('Administrator') ? 'block' : 'warn', 'dash.act.pfVerifiedDangerous', { perms: dangerous.join(', ') });
  // Inverted honeypot: the trap must be visible to the unverified accounts it's
  // meant to catch and hidden from verified members (who'd be auto-banned for
  // posting there). Gated like a normal channel, it's both inert AND a ban risk.
  if (cfg.honeypotChannelId && honeypotMode(cfg) !== 'disarmed') {
    const hp = await guild.channels.fetch(cfg.honeypotChannelId).catch(() => null);
    if (hp) {
      const everyoneSees = hp.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.ViewChannel);
      const verifiedSees = hp.permissionsFor(role).has(PermissionFlagsBits.ViewChannel);
      if (!everyoneSees || verifiedSees) push('warn', 'dash.act.pfHoneypotInverted');
    }
  }
  // An ARMED honeypot with no warning banner posted is an unmarked insta-ban
  // trap: to a real member it looks like any other channel until they post and
  // get banned (this exact setup lost the network a large server). Review mode
  // is exempt - a moderator approves every catch there.
  if (cfg.honeypotChannelId && honeypotMode(cfg) === 'armed' && !cfg.bannerPosted) {
    push('warn', 'dash.act.pfArmedNoBanner');
  }
  // Verify channel must be postable by the bot AND visible to unverified members,
  // or nobody can verify - the #1 cause of "I set it up but it's stuck".
  if (cfg.verifyChannelId) {
    const vch = await guild.channels.fetch(cfg.verifyChannelId).catch(() => null);
    if (vch) {
      if (!vch.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) push('warn', 'dash.act.pfVerifyBotCantPost');
      if (!vch.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.ViewChannel)) push('warn', 'dash.act.pfVerifyHidden');
    }
  }
  // Verification on, but nothing real behind it.
  if (contentGatedChannels(cfg).length === 0) push('warn', 'dash.act.pfNothingGated');
  // Compromised-account detection has its own requirements, and they differ by
  // the action the server chose. Silent failure is the danger here: without
  // View the blast is never seen, and without Manage Messages the spam stays up.
  // The bot wearing the verified role silently blinds it on a correct honeypot.
  if (me.roles.cache.has(cfg.verifiedRoleId)) push('warn', 'dash.act.pfBotHasVerified', { role: role.name });
  // A category the bot cannot see makes every channel inside it unmanageable.
  const locked = lockedCategories(guild, cfg, me);
  if (locked.length) push('warn', 'dash.act.pfCategoryLocked', { n: locked.length, list: locked.map((c) => c.name).join(', ') });
  const comp = compromisedSettings(cfg);
  if (comp.enabled) {
    const NEED = { kick: [PermissionFlagsBits.KickMembers, 'Kick Members'], ban: [PermissionFlagsBits.BanMembers, 'Ban Members'] };
    const need = NEED[comp.action];
    if (need && !me.permissions.has(need[0])) push('warn', 'dash.act.pfCompActionPerm', { perm: need[1], action: comp.action });
    if (comp.action === 'quarantine' && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      push('warn', 'dash.act.pfCompActionPerm', { perm: 'Manage Roles', action: comp.action });
    }
    const postable = memberPostableChannels(guild, cfg);
    const blind = postable.filter((ch) => !ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel));
    if (blind.length) push('warn', 'dash.act.pfCompBlind', { n: blind.length, total: postable.length, list: blind.slice(0, 5).map((c) => '#' + c.name).join(', ') });
    if (comp.deleteMessages) {
      const noDel = postable.filter((ch) => { const p = ch.permissionsFor(me); return p?.has(PermissionFlagsBits.ViewChannel) && !p.has(PermissionFlagsBits.ManageMessages); });
      if (noDel.length) push('warn', 'dash.act.pfCompNoDelete', { n: noDel.length, total: postable.length, list: noDel.slice(0, 5).map((c) => '#' + c.name).join(', ') });
    }
  }
  return issues.sort((a, b) => Number(a.level !== 'block') - Number(b.level !== 'block'));
}

// The first blocking issue (if any) - what grandfather() refuses on.
export async function preflightBlock(guild, cfg, loc = cfg?.locale) {
  return (await preflight(guild, cfg, loc)).find((p) => p.level === 'block') || null;
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
  const block = await preflightBlock(guild, cfg, loc);
  if (block) throw new Error(block.msg);
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
  // a real pass supersedes any manual "mark as done" and re-enables lazy grandfathering
  saveGuild(guild.id, { grandfatherPending: false, grandfatheredAt: new Date().toISOString(), grandfatherSkipped: false });
  return t('dash.act.gfDone', loc, { role: role.name, added: progress.added, skipped: progress.skipped, failedPart: failures.length ? t('dash.act.gfFailed', loc, { n: failures.length, role: role.name, list: failures.slice(0, 5).join(', ') }) : '' });
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
    if (b.noShare) continue; // origin (ungated + no verification) opted out of contributing to the shared list
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
  const bannedTags = [];
  const worker = async () => {
    while (i < targets.length) {
      const [id, info] = targets[i++];
      try {
        await guild.bans.create(id, { reason: 'MadHoney: synced from the shared ban list' });
        logBan({ id, tag: info.tag, guildId: guild.id, channel: '(ban-sync)', at: new Date().toISOString(), incidentId: info.incidentId });
        progress.added++; bannedTags.push(info.tag || id);
      } catch { progress.failed++; }
      progress.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));
  saveGuild(guild.id, { banSyncPending: false });
  // Tell the mod log channel what was banned from the shared list. ONE summary,
  // never per-user - a sync can ban dozens at once. Lists tags when few.
  if (progress.added > 0 && cfg.logChannelId) {
    const listPart = bannedTags.length <= 15 ? '\n' + bannedTags.map((tag) => `• ${tag}`).join('\n') : '';
    try {
      const log = await guild.channels.fetch(cfg.logChannelId);
      await log.send({ content: t('log.banSyncSummary', loc, { n: progress.added }) + listPart, allowedMentions: { parse: [] } });
    } catch { /* mod channel unreachable - console + the returned string still record it */ }
  }
  return t('dash.act.sbDone', loc, { added: progress.added, skipped: progress.skipped, failedPart: progress.failed ? t('dash.act.sbFailed', loc, { n: progress.failed }) : '', pool: pool.size });
}
