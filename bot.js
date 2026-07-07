// MadHoney - honeypot + captcha verification for any Discord server.
// One process: the bot, plus (if CLIENT_ID/CLIENT_SECRET are set) the web
// dashboard. Per-guild config lives in guilds.json; bans in bans.jsonl.
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  Client, GatewayIntentBits, Events, PermissionFlagsBits, PermissionsBitField, MessageFlags,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
} from 'discord.js';
import { shouldTrap, honeypotMode, staffRoles } from './trap.js';
import { compromisedSettings, messageSignature, recordAndCheck, sweep as sweepCompromised } from './compromised.js';
import { makeCode, answerOk } from './verify.js';
import { renderCaptcha, captchaLength, renderPositionCaptcha, POSITION_SLOTS } from './captcha.js';
import { renderBanner, DEFAULT_BANNER, FONTS } from './banner.js';
// Pluggable store backend: MADHONEY_STORE selects an alternative module with
// the same exports (defaults to the plain file store).
const store = await import(process.env.MADHONEY_STORE ?? './store.js');
const { getGuild, saveGuild, logBan, bans, bannedElsewhere, appealableGuildIds, banEpoch, hasAppealed, recordAppeal, reBanSource, incidentOf, resolveIncident } = store;
import { makeIncidentId } from './incident.js';
import { postVerifyPanel, postBanner, refreshVerifyPanel, refreshBanner, gateChannels, gateNewChannel, ungateChannels, grandfather, syncBans, explainError, roleColorMap, DEFAULT_VERIFY_TEXT } from './actions.js';
import { startDashboard } from './dashboard.js';
import { t } from './i18n.js';

// Optional Cloudflare delegation runner. MadHoney runs entirely on your own
// server by default — this file is NOT part of the base build. It's a
// deployment-only add-on for an HA setup where an edge worker offloads bulk
// jobs to the bot via a shared database. If the module isn't present (the
// normal self-host case), the bot simply skips it and runs standalone.
let startJobRunner = () => {};
try { ({ startJobRunner } = await import('./jobrunner.js')); } catch { /* server-only: no external delegation */ }

const EPH = { flags: MessageFlags.Ephemeral };
const pending = new Map(); // userId -> { code, attempts, expires, cooldownUntil } (in-memory; users re-click after a restart)
const appealInFlight = new Set(); // `${uid}:${gid}:${epoch}` mid-send; the async half of the one-appeal-per-ban guard (durable half is appeals.jsonl)
const VERIFY_TTL = 3 * 60 * 1000;  // a shown captcha is valid this long
const VERIFY_MAX_ATTEMPTS = 5;     // wrong guesses against one code before it's burned
const VERIFY_COOLDOWN = 2000;      // min ms between "Verify" clicks (each mints a fresh image)
// sweep expired codes so `pending` can't grow without bound
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (now > v.expires) pending.delete(k); }, 60_000).unref?.();

// Liveness marker for the honeypot catch-up sweep (see ClientReady): stamped
// only while actually connected, so any window where the bot couldn't see
// messages - restart, crash, outage - is swept on the next boot.
const LASTSEEN = new URL('./.lastseen', import.meta.url);
setInterval(() => { if (client.isReady()) { try { writeFileSync(LASTSEEN, String(Date.now())); } catch { /* best effort */ } } }, 60_000).unref?.();

// Per-process fan-out tracker for compromised-account detection (compromised.js).
// Swept every 5 min so one-off posters don't linger; per-message pruning does the
// tight in-window work.
const compromisedStore = new Map();
setInterval(() => sweepCompromised(compromisedStore, Date.now(), 5 * 60 * 1000), 5 * 60 * 1000).unref?.();
// Detection ships as "Coming soon": stays fully off (dashboard shows a preview)
// until we flip COMPROMISED_LIVE=on. Belt-and-suspenders over Message Content
// dormancy, so it can't silently activate when that intent is approved.
const COMPROMISED_LIVE = process.env.COMPROMISED_LIVE === 'on';

// Sign appeal buttons so a forged `mh_appeal_<gid>` can't be used to probe
// "am I banned here?" - the signature binds the button to this user + ban
// episode. Set APPEAL_SIGNING_KEY to a stable secret; falls back to the bot
// token (already secret and stable per deployment).
const APPEAL_KEY = process.env.APPEAL_SIGNING_KEY || process.env.DISCORD_TOKEN || 'madhoney-dev';
const appealSig = (uid, gid, epoch) => createHmac('sha256', APPEAL_KEY).update(`${uid}:${gid}:${epoch}`).digest('hex').slice(0, 16);

// ---- log-channel flood control ----
// Two-tier token buckets so a flood of low-priority notices (appeals, auto-gate,
// webhook alerts) can never crowd out critical ban/trap reports, plus a global
// cap that protects the bot's Discord rate limit across all guilds. In-memory,
// 60s windows. Critical (ban/trap) reports bypass the global cap - a real ban
// wave must always land in the log.
const logBuckets = new Map(); // `${guildId}:${priority}` -> { tokens, resetAt }
let globalLog = { tokens: 0, resetAt: 0 };
const LOG_LIMITS = { critical: 20, normal: 8 }; // per guild, per 60s window
function logAllow(guildId, priority) {
  const now = Date.now();
  if (now > globalLog.resetAt) globalLog = { tokens: 30, resetAt: now + 60_000 };
  const key = `${guildId}:${priority}`;
  let b = logBuckets.get(key);
  if (!b || now > b.resetAt) { b = { tokens: LOG_LIMITS[priority] ?? 8, resetAt: now + 60_000 }; logBuckets.set(key, b); }
  if (b.tokens <= 0) return false;
  if (priority !== 'critical') { if (globalLog.tokens <= 0) return false; globalLog.tokens--; }
  b.tokens--;
  return true;
}
// Fire-and-forget send to a guild's log channel, throttled by priority. Use
// logAllow directly where the caller needs to know whether it went through.
// Guilds we've already nudged this session about a broken log channel, so a
// stream of failed ban reports doesn't spam the owner. ponytail: in-memory Set;
// resets on restart (re-warns next session if still broken), which is fine.
const logWarned = new Set();
// When a log-channel post fails (missing/deleted channel, or MadHoney lacks
// View/Send there), the mods never see ban reports OR appeal forwards. DM the
// owner once so they can fix permissions — the appeal pipeline depends on it.
async function warnOwnerLogBroken(guild, cfg) {
  if (logWarned.has(guild.id)) return;
  logWarned.add(guild.id);
  try {
    const owner = await guild.fetchOwner();
    await owner.send(t('log.permReminder', cfg?.locale, { guild: guild.name, dash: dashLink(guild.id) }));
  } catch { /* owner DMs closed - nothing more we can do */ }
}

async function logSend(guild, cfg, payload, priority = 'normal') {
  if (!cfg?.logChannelId) return;
  if (!logAllow(guild.id, priority)) { console.log(`[${guild.name}] log ${priority} message throttled`); return; }
  try {
    const log = await guild.channels.fetch(cfg.logChannelId);
    await log.send(payload);
    logWarned.delete(guild.id); // recovered - allow a fresh warning if it breaks again
  } catch (err) {
    console.error(`[${guild.name}] log send failed:`, err.message);
    warnOwnerLogBroken(guild, cfg); // deduped owner nudge to fix permissions
  }
}
const DASH = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const dashLink = (guildId) => (DASH ? `**[${DASH.replace(/^https?:\/\//, '')}](${DASH}${guildId ? `/g/${guildId}` : ''})**` : 'the web dashboard');

// The trap itself never needs message content. It's only used to COPY the
// spam text into the log channel - opt-in, because it's a privileged intent:
// enable it in the Dev Portal AND set MESSAGE_CONTENT=on, or login fails.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
// Server Members is a PRIVILEGED intent (needed for grandfathering, ban-share on
// join, and member fetches). If its Dev Portal toggle is off - e.g. while the
// privileged-intent review is pending after crossing 10k users - the gateway
// rejects login with "Used disallowed intents" and the bot can't start at all.
// SERVER_MEMBERS=off drops it so the bot runs DEGRADED (honeypot + edge
// verification keep working; grandfather/ban-share/auto-sync are paused) instead
// of crash-looping. Default on. Flip back to on once the portal toggle is re-enabled.
if (process.env.SERVER_MEMBERS !== 'off') intents.push(GatewayIntentBits.GuildMembers);
if (process.env.MESSAGE_CONTENT === 'on') intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });

// ---- network-wide trap feed + daily report (operator's #madhoney-trapped) ----
// Gated by TRAP_FEED_CHANNEL: unset on self-hosted instances, so nothing posts
// there. Posts a live line on every honeypot catch across all servers, plus a
// once-a-day summary. Never pings (allowedMentions cleared).
const TRAP_FEED = process.env.TRAP_FEED_CHANNEL || '';
const REPORT_HOUR = Number(process.env.TRAP_REPORT_HOUR ?? 12); // UTC hour to post the daily summary
const REPORT_MARK = '📊 MadHoney daily report';
async function feedSend(content) {
  if (!TRAP_FEED) return;
  try { const ch = await client.channels.fetch(TRAP_FEED); await ch.send({ content, allowedMentions: { parse: [] } }); }
  catch (e) { console.error('[trap-feed] send failed:', e.message); }
}
// live feed: honeypot-origin catches only (ban-share propagations are skipped to
// avoid one catch fanning out into a dozen feed posts across sharing servers).
const notifyTrap = (guild, user, channelName) =>
  feedSend(`🍯 **Trapped** in **${guild.name}** — ${user.tag} (\`${user.id}\`) posted in #${channelName}`);

// once-a-day summary, deduped via the channel itself (no persisted state needed):
// if a report dated today already exists, skip - so restarts/failover never double-post.
async function maybeDailyReport() {
  if (!TRAP_FEED) return;
  const now = new Date();
  if (now.getUTCHours() < REPORT_HOUR) return; // hold until the report hour (UTC)
  const todayUtc = now.toISOString().slice(0, 10);
  let ch;
  try { ch = await client.channels.fetch(TRAP_FEED); } catch { return; }
  try {
    const recent = await ch.messages.fetch({ limit: 15 });
    const already = recent.some((m) => m.author.id === client.user.id && m.content.includes(REPORT_MARK)
      && new Date(m.createdTimestamp).toISOString().slice(0, 10) === todayUtc);
    if (already) return;
  } catch { return; } // can't read history -> skip rather than risk a double-post
  // summarize the last 24h from the ban ledger: honeypot-origin catches only.
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = bans();
  const byGuild = new Map();
  const activeUsers = new Set();
  const state = new Map(); // latest banned-state per (user,guild)
  let total = 0;
  for (const b of rows) {
    state.set(`${b.id}:${b.guildId}`, !b.unbanned);
    if (b.unbanned) continue;
    if (b.channel === '(ban-share)' || b.channel === '(ban-sync)') continue; // origin only
    if (Date.parse(b.at) < since) continue;
    total++; byGuild.set(b.guildId, (byGuild.get(b.guildId) ?? 0) + 1);
  }
  for (const [k, v] of state) if (v) activeUsers.add(k.slice(0, k.lastIndexOf(':')));
  const nameOf = (gid) => client.guilds.cache.get(gid)?.name ?? gid;
  const lines = [...byGuild.entries()].sort((a, z) => z[1] - a[1]).slice(0, 10).map(([g, n]) => `• ${nameOf(g)}: ${n}`);
  await feedSend([
    `${REPORT_MARK} — ${todayUtc}`,
    `Last 24h: **${total}** spammer${total === 1 ? '' : 's'} trapped across **${byGuild.size}** server${byGuild.size === 1 ? '' : 's'}.`,
    lines.length ? lines.join('\n') : '_No honeypot catches in the last 24h._',
    `Shared ban list: **${activeUsers.size}** accounts.`,
  ].join('\n'));
}

// ---------- slash command ----------

const command = new SlashCommandBuilder()
  .setName('madhoney')
  .setDescription('MadHoney setup & controls')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('setup').setDescription('Configure the verified role, verify channel and honeypot channel'))
  .addSubcommand((s) => s.setName('deploy').setDescription('Post panels, gate channels, grandfather members'))
  .addSubcommand((s) => s.setName('status').setDescription('Show current MadHoney config and ban count'))
  .addSubcommand((s) => s
    .setName('banner').setDescription('Design the honeypot warning banner')
    .addStringOption((o) => o.setName('title').setDescription('Headline (default: HONEYPOT IS ACTIVE)'))
    .addStringOption((o) => o.setName('text').setDescription('Body text'))
    .addStringOption((o) => o.setName('accent').setDescription('Stripe/title color, hex (default #ffb31a)'))
    .addStringOption((o) => o.setName('color').setDescription('Body text color, hex (default #e9ecf1)'))
    .addStringOption((o) => o.setName('bg').setDescription('Background color, hex (default #0c0e11)'))
    .addStringOption((o) => o.setName('font').setDescription('Font').addChoices(...FONTS.map((f) => ({ name: f, value: f }))))
    .addStringOption((o) => o.setName('logo_url').setDescription('Logo URL (PNG/JPG). Empty = MadHoney logo, "none" = no logo'))
    .addStringOption((o) => o.setName('mention_color').setDescription('#channel/@role highlight color, hex (default #5865f2)'))
    .addStringOption((o) => o.setName('mention_mode').setDescription('How to color @role mentions')
      .addChoices({ name: 'custom color', value: 'custom' }, { name: 'real role colors', value: 'role' })))
  .addSubcommand((s) => s
    .setName('banshare').setDescription('Share bans with other MadHoney servers, or stay isolated')
    .addStringOption((o) => o.setName('mode').setDescription('shared = auto-ban users banned in other sharing servers').setRequired(true)
      .addChoices({ name: 'shared', value: 'shared' }, { name: 'isolated', value: 'isolated' })))
  .addSubcommand((s) => s.setName('bansync').setDescription('Ban everyone on the active shared list now (requires ban sharing ON)'))
  .addSubcommand((s) => s
    .setName('honeypot').setDescription('Set the honeypot mode')
    .addStringOption((o) => o.setName('mode').setDescription('armed = ban now · review = hold for a mod · disarmed = off').setRequired(true)
      .addChoices(
        { name: 'armed (ban immediately)', value: 'armed' },
        { name: 'review (hold each hit for a mod)', value: 'review' },
        { name: 'disarmed (off)', value: 'disarmed' },
      )))
  .addSubcommand((s) => s.setName('arm').setDescription('Arm the honeypot - start banning accounts that post in it'))
  .addSubcommand((s) => s.setName('disarm').setDescription('Disarm the honeypot - stop banning (use while setting up)'))
  .addSubcommand((s) => s.setName('support').setDescription('Get an invite to the MadHoney support server'));

// ---------- setup panel ----------

function setupContent(guild) {
  const cfg = getGuild(guild.id) ?? {};
  const loc = cfg.locale;
  const ns = t('common.notSet', loc);
  const v = (id) => (id ? `<#${id}>` : ns);
  const role = (id) => (id ? `<@&${id}>` : ns);
  const roleList = (ids) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : ns);
  const hp = { armed: t('setup.hpArmed', loc), review: t('setup.hpReview', loc), disarmed: t('setup.hpDisarmed', loc) }[honeypotMode(cfg)];
  return [
    t('setup.title', loc),
    t('setup.dashHint', loc, { dash: dashLink(guild.id) }),
    '',
    t('setup.verifiedRole', loc, { role: role(cfg.verifiedRoleId) }),
    t('setup.verifyChannel', loc, { channel: v(cfg.verifyChannelId) }),
    t('setup.honeypotChannel', loc, { channel: v(cfg.honeypotChannelId) }),
    t('setup.staffRole', loc, { role: roleList(staffRoles(cfg)) }),
    t('setup.logChannel', loc, { channel: v(cfg.logChannelId) }),
    t('setup.banSharing', loc, { mode: cfg.banShare ? t('setup.banShared', loc) : t('setup.banIsolated', loc) }),
    t('setup.honeypotLine', loc, { mode: hp }),
    '',
    t('setup.onboarding', loc),
    t('setup.accessibility', loc),
    t('setup.whenReady', loc),
  ].join('\n');
}

function setupComponents(cfg = {}) {
  const loc = cfg.locale;
  const role = new RoleSelectMenuBuilder().setCustomId('mh_role').setPlaceholder(t('setup.phRole', loc));
  if (cfg.verifiedRoleId) role.setDefaultRoles(cfg.verifiedRoleId);
  const verifyCh = new ChannelSelectMenuBuilder().setCustomId('mh_verifych').setPlaceholder(t('setup.phVerifyCh', loc)).setChannelTypes(ChannelType.GuildText);
  if (cfg.verifyChannelId) verifyCh.setDefaultChannels(cfg.verifyChannelId);
  const honeyCh = new ChannelSelectMenuBuilder().setCustomId('mh_honeych').setPlaceholder(t('setup.phHoneyCh', loc)).setChannelTypes(ChannelType.GuildText);
  if (cfg.honeypotChannelId) honeyCh.setDefaultChannels(cfg.honeypotChannelId);
  return [
    new ActionRowBuilder().addComponents(role),
    new ActionRowBuilder().addComponents(verifyCh),
    new ActionRowBuilder().addComponents(honeyCh),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mh_text').setLabel(t('setup.btnEditVerify', loc)).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_more').setLabel(t('setup.btnStaffLog', loc)).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_deploy_open').setLabel(t('setup.btnDeploy', loc)).setStyle(ButtonStyle.Primary),
    ),
  ];
}

// Sub-panel: staff exemption role + ban-report log channel (Discord caps a
// message at 5 component rows, so these live behind the "Staff & log" button).
function morePanel(guild) {
  const cfg = getGuild(guild.id) ?? {};
  const loc = cfg.locale;
  const ns = t('common.notSet', loc);
  const sr = staffRoles(cfg);
  const staff = new RoleSelectMenuBuilder().setCustomId('mh_staffrole').setPlaceholder(t('more.phStaff', loc)).setMinValues(0).setMaxValues(25);
  if (sr.length) staff.setDefaultRoles(...sr);
  const logCh = new ChannelSelectMenuBuilder().setCustomId('mh_logch').setPlaceholder(t('more.phLog', loc)).setChannelTypes(ChannelType.GuildText);
  if (cfg.logChannelId) logCh.setDefaultChannels(cfg.logChannelId);
  return {
    content: [
      t('more.title', loc),
      t('more.staffRole', loc, { role: sr.length ? sr.map((id) => `<@&${id}>`).join(' ') : ns }),
      t('more.logChannel', loc, { channel: cfg.logChannelId ? `<#${cfg.logChannelId}>` : ns }),
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(staff), new ActionRowBuilder().addComponents(logCh)],
    ...EPH,
  };
}

function deployPanel(guild) {
  const cfg = getGuild(guild.id) ?? {};
  const loc = cfg.locale;
  const ready = cfg.verifiedRoleId && cfg.verifyChannelId && cfg.honeypotChannelId;
  return {
    content: ready
      ? [t('deploy.title', loc), t('deploy.dashHint', loc, { dash: dashLink(guild.id) }), '', t('deploy.order', loc),
        t('deploy.step1', loc), t('deploy.step2', loc), t('deploy.step3', loc), t('deploy.step4', loc)].join('\n')
      : t('deploy.incomplete', loc),
    components: ready ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mh_grandfather').setLabel(t('deploy.btnGrandfather', loc)).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_post_verify').setLabel(t('deploy.btnPostVerify', loc)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mh_post_banner').setLabel(t('deploy.btnPostBanner', loc)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mh_gate_dry').setLabel(t('deploy.btnGateDry', loc)).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_gate_apply').setLabel(t('deploy.btnGateApply', loc)).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mh_ungate').setLabel(t('deploy.btnRestore', loc)).setStyle(ButtonStyle.Secondary),
    )] : [],
    ...EPH,
  };
}

// ---------- interactions ----------

const isManager = (i) => i.inGuild() && i.member.permissions.has(PermissionFlagsBits.ManageGuild);

// ---- captcha minting (shared by verify_start, the style picker, and the
// position flow's re-rolls) ----
const posRow = () => new ActionRowBuilder().addComponents(
  Array.from({ length: POSITION_SLOTS }, (_, n) =>
    new ButtonBuilder().setCustomId(`mh_pos_${n + 1}`).setLabel(String(n + 1)).setStyle(ButtonStyle.Secondary)),
);
// Creates the pending record + returns the reply payload for one fresh captcha.
// The answer only ever lives server-side (never in a customId).
function mintCaptcha(userId, cfg, style, test = false) {
  const now = Date.now();
  const difficulty = cfg.captchaDifficulty ?? 'easy';
  if (style === 'position') {
    const slot = 1 + Math.floor(Math.random() * POSITION_SLOTS);
    const rounds = difficulty === 'hard' ? 3 : 2; // 1/25 by pure luck, 1/125 on hard
    pending.set(userId, { style, slot, round: 0, rounds, test, attempts: 0, expires: now + VERIFY_TTL, cooldownUntil: now + VERIFY_COOLDOWN });
    return {
      content: (test ? t('verify.testMode', cfg.locale) + '\n' : '') + t('verify.posInstructions', cfg.locale, { total: rounds }),
      files: [new AttachmentBuilder(renderPositionCaptcha(slot, difficulty), { name: 'captcha.png' })],
      components: [posRow()],
    };
  }
  const code = makeCode(captchaLength(difficulty));
  pending.set(userId, { style: 'text', code, test, attempts: 0, expires: now + VERIFY_TTL, cooldownUntil: now + VERIFY_COOLDOWN });
  return {
    content: (test ? t('verify.testMode', cfg.locale) + '\n' : '') + t('verify.instructions', cfg.locale),
    files: [new AttachmentBuilder(renderCaptcha(code, difficulty), { name: 'captcha.png' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_open').setLabel(t('verify.enterCode', cfg.locale)).setStyle(ButtonStyle.Success),
    )],
  };
}
// Passing verification: grant the role - unless this was a staff test run,
// which must never touch roles.
async function verifyPassed(i, cfg, rec, edit = false) {
  pending.delete(i.user.id);
  const done = (content) => edit ? i.update({ content, files: [], attachments: [], components: [] }) : i.reply({ content, ...EPH });
  if (rec.test) return done(t('verify.testPassed', cfg.locale));
  const role = cfg.verifiedRoleId && (await i.guild.roles.fetch(cfg.verifiedRoleId).catch(() => null));
  if (!role) return done(t('verify.roleMissing', cfg.locale));
  await i.member.roles.add(role, 'MadHoney: passed verification');
  return done(t('verify.success', cfg.locale, { guild: i.guild.name }));
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    // --- public: /madhoney support (no permissions needed) — invite to the
    // support server. (Interactions are edge-served; this is a gateway fallback.)
    if (i.isChatInputCommand() && i.commandName === 'madhoney' && i.options.getSubcommand() === 'support') {
      const invite = process.env.SUPPORT_INVITE || 'https://discord.gg/wVKHJbZrZ3';
      return i.reply({ content: t('reply.support', getGuild(i.guildId)?.locale, { invite }), ...EPH });
    }

    // --- member-facing verify flow (no permissions needed) ---
    if (i.isButton() && i.customId === 'verify_start') {
      const cfg = getGuild(i.guildId) ?? {};
      const role = cfg.verifiedRoleId && (await i.guild.roles.fetch(cfg.verifiedRoleId).catch(() => null));
      // already-verified STAFF get a test run (real flow, no role changes) so
      // admins can try their captcha settings exactly as members see them
      const test = Boolean(role && i.member.roles.cache.has(role.id) && isManager(i));
      if (role && i.member.roles.cache.has(role.id) && !test) return i.reply({ content: t('verify.alreadyVerified', cfg.locale), ...EPH });
      const now = Date.now();
      const prev = pending.get(i.user.id);
      if (prev && now < prev.cooldownUntil) return i.reply({ content: t('verify.cooldown', cfg.locale), ...EPH });
      const style = cfg.captchaStyle ?? 'position';
      if (style === 'choice') {
        // the member picks; the record holds the cooldown until they do
        pending.set(i.user.id, { style: 'choice', test, expires: now + VERIFY_TTL, cooldownUntil: now + VERIFY_COOLDOWN });
        return i.reply({
          content: (test ? t('verify.testMode', cfg.locale) + '\n' : '') + t('verify.pickStyle', cfg.locale),
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mh_style_text').setLabel(t('verify.styleText', cfg.locale)).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('mh_style_pos').setLabel(t('verify.stylePos', cfg.locale)).setStyle(ButtonStyle.Primary),
          )],
          ...EPH,
        });
      }
      return i.reply({ ...mintCaptcha(i.user.id, cfg, style, test), ...EPH });
    }
    if (i.isButton() && (i.customId === 'mh_style_text' || i.customId === 'mh_style_pos')) {
      const cfg = getGuild(i.guildId) ?? {};
      const test = pending.get(i.user.id)?.test ?? false;
      return i.update({ ...mintCaptcha(i.user.id, cfg, i.customId === 'mh_style_pos' ? 'position' : 'text', test), attachments: [] });
    }
    if (i.isButton() && i.customId.startsWith('mh_pos_')) {
      const cfg = getGuild(i.guildId) ?? {};
      const rec = pending.get(i.user.id);
      if (!rec || rec.style !== 'position' || Date.now() > rec.expires) {
        pending.delete(i.user.id);
        return i.update({ content: t('verify.expired', cfg.locale), files: [], attachments: [], components: [] });
      }
      const difficulty = cfg.captchaDifficulty ?? 'easy';
      if (Number(i.customId.slice('mh_pos_'.length)) === rec.slot) {
        rec.round++;
        if (rec.round >= rec.rounds) return verifyPassed(i, cfg, rec, true);
        rec.slot = 1 + Math.floor(Math.random() * POSITION_SLOTS); // fresh puzzle each round
        return i.update({
          content: t('verify.posAgain', cfg.locale, { n: rec.round + 1, total: rec.rounds }),
          files: [new AttachmentBuilder(renderPositionCaptcha(rec.slot, difficulty), { name: 'captcha.png' })],
          attachments: [], components: [posRow()],
        });
      }
      // wrong slot: burn the streak, fresh puzzle, bounded attempts overall
      rec.attempts++;
      rec.round = 0;
      if (rec.attempts >= VERIFY_MAX_ATTEMPTS) {
        pending.delete(i.user.id);
        return i.update({ content: t('verify.tooMany', cfg.locale), files: [], attachments: [], components: [] });
      }
      rec.slot = 1 + Math.floor(Math.random() * POSITION_SLOTS);
      return i.update({
        content: t('verify.posWrong', cfg.locale, { left: VERIFY_MAX_ATTEMPTS - rec.attempts }),
        files: [new AttachmentBuilder(renderPositionCaptcha(rec.slot, difficulty), { name: 'captcha.png' })],
        attachments: [], components: [posRow()],
      });
    }
    if (i.isButton() && i.customId === 'verify_open') {
      const loc = getGuild(i.guildId)?.locale;
      const modal = new ModalBuilder().setCustomId('verify_answer').setTitle(t('verify.modalTitle', loc));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ans').setLabel(t('verify.modalLabel', loc)).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(8),
      ));
      return i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'verify_answer') {
      const cfg = getGuild(i.guildId) ?? {};
      const rec = pending.get(i.user.id);
      if (!rec || !rec.code || Date.now() > rec.expires) {
        pending.delete(i.user.id);
        return i.reply({ content: t('verify.expired', cfg.locale), ...EPH });
      }
      if (answerOk(i.fields.getTextInputValue('ans'), rec.code)) {
        return verifyPassed(i, cfg, rec);
      }
      // wrong answer: count it against this code; burn the code after too many so
      // re-opening the modal (verify_open) can't brute-force one image forever.
      rec.attempts++;
      if (rec.attempts >= VERIFY_MAX_ATTEMPTS) {
        pending.delete(i.user.id);
        return i.reply({ content: t('verify.tooMany', cfg.locale), ...EPH });
      }
      return i.reply({ content: t('verify.wrong', cfg.locale, { left: VERIFY_MAX_ATTEMPTS - rec.attempts }), ...EPH });
    }

    // Appeal button (clicked in a DM). User-facing, so handled before the
    // admin/guild guard below. Forwards the appeal to that server's log channel.
    if (i.isButton() && i.customId.startsWith('mh_appeal_')) {
      // customId: mh_appeal_<gid>_<sig>, sig = HMAC(user, gid, banEpoch). The
      // signature binds the button to THIS user + ban, so a forged id can't be
      // used to probe "am I banned here?" - every failure path returns one
      // identical reply (no oracle). One appeal per ban episode (see the ledger):
      // the checks + the in-flight add run synchronously (no await between them),
      // so a flood of parallel replays can't all pass before one wins.
      const [gid, sig] = i.customId.slice('mh_appeal_'.length).split('_');
      const loc = getGuild(gid)?.locale;
      const epoch = gid ? banEpoch(i.user.id, gid) : null;
      const nope = t('appeal.invalid', loc);
      if (!epoch || sig !== appealSig(i.user.id, gid, epoch) || !appealableGuildIds(i.user.id).includes(gid)) {
        return i.reply({ content: nope });
      }
      const key = `${i.user.id}:${gid}:${epoch}`;
      if (appealInFlight.has(key) || hasAppealed(i.user.id, gid, epoch)) return i.reply({ content: nope });
      appealInFlight.add(key); // synchronous claim before any await
      const cfg = getGuild(gid);
      const guild = client.guilds.cache.get(gid);
      try {
        if (!logAllow(gid, 'normal')) {
          return i.reply({ content: t('appeal.busy', loc) });
        }
        const log = await guild.channels.fetch(cfg.logChannelId);
        await log.send({
          content: t('log.appealForward', loc, { id: i.user.id, tag: i.user.tag }),
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mh_appok_${gid}_${i.user.id}`).setLabel(t('log.approveBtn', loc)).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`mh_appno_${gid}_${i.user.id}`).setLabel(t('log.denyBtn', loc)).setStyle(ButtonStyle.Danger),
          )],
        });
        recordAppeal(i.user.id, gid, epoch); // persist ONLY after it actually reached the mod team
        return i.reply({ content: t('appeal.sent', loc, { guild: guild.name }) });
      } catch (e) {
        return i.reply({ content: t('appeal.unreachable', loc, { error: e.message }) });
      } finally {
        appealInFlight.delete(key); // released; durable dedup is now on recordAppeal (success) or free to retry (failure/throttle)
      }
    }

    // --- everything below is admin-only ---
    if (!i.inGuild()) return;
    const admin = i.isChatInputCommand() || i.customId?.startsWith('mh_');
    if (admin && !isManager(i)) {
      if (i.isRepliable()) return i.reply({ content: t('reply.needManageServer', getGuild(i.guildId)?.locale), ...EPH });
      return;
    }

    if (i.isChatInputCommand() && i.commandName === 'madhoney') {
      const sub = i.options.getSubcommand();
      if (sub === 'setup') {
        return i.reply({ content: setupContent(i.guild), components: setupComponents(getGuild(i.guildId) ?? {}), ...EPH });
      }
      if (sub === 'deploy') return i.reply(deployPanel(i.guild));
      if (sub === 'status') {
        const cfg = getGuild(i.guildId) ?? {};
        const mine = bans(i.guildId).length;
        return i.reply({ content: setupContent(i.guild) + '\n\n' + t('setup.statusCounts', cfg.locale, { mine, pool: bans().length }), ...EPH });
      }
      if (sub === 'banshare') {
        const shared = i.options.getString('mode') === 'shared';
        saveGuild(i.guildId, { banShare: shared });
        return i.reply({ content: t(shared ? 'reply.banshareOn' : 'reply.banshareOff', getGuild(i.guildId)?.locale), ...EPH });
      }
      if (sub === 'bansync') {
        await i.deferReply(EPH);
        const progress = {};
        const job = syncBans(i.guild, getGuild(i.guildId) ?? {}, progress).catch((e) => `❌ ${explainError(e.message, getGuild(i.guildId)?.locale)}`);
        const ticker = setInterval(() => {
          if (progress.total !== undefined) {
            i.editReply({ content: `⏳ Ban sync… ${progress.done}/${progress.total} · ${progress.added} banned · ${progress.skipped} skipped` }).catch(() => {});
          }
        }, 2500);
        const result = await job;
        clearInterval(ticker);
        return i.editReply({ content: String(result).slice(0, 1900) });
      }
      if (sub === 'arm' || sub === 'disarm' || sub === 'honeypot') {
        const mode = sub === 'arm' ? 'armed' : sub === 'disarm' ? 'disarmed' : i.options.getString('mode');
        const cfgNow = getGuild(i.guildId) ?? {};
        const loc = cfgNow.locale;
        if (mode !== 'disarmed' && !cfgNow.honeypotChannelId) {
          return i.reply({ content: t('reply.noHoneypotYet', loc), ...EPH });
        }
        saveGuild(i.guildId, { honeypotMode: mode });
        const msg = { armed: 'reply.modeArmed', review: 'reply.modeReview', disarmed: 'reply.modeDisarmed' }[mode];
        const warn = mode === 'review' && !cfgNow.logChannelId ? '\n' + t('reply.modeReviewNoLog', loc) : '';
        return i.reply({ content: t(msg, loc) + warn, ...EPH });
      }
      if (sub === 'banner') {
        const prev = getGuild(i.guildId)?.banner ?? {};
        const banner = {
          ...DEFAULT_BANNER, ...prev,
          ...Object.fromEntries(['title', 'text', 'accent', 'color', 'bg', 'font'].map((k) => [k, i.options.getString(k)]).filter(([, v]) => v)),
        };
        const logo = i.options.getString('logo_url');
        if (logo != null) banner.logoUrl = logo;
        const mc = i.options.getString('mention_color');
        if (mc) banner.mentionColor = mc;
        const mm = i.options.getString('mention_mode');
        if (mm) banner.mentionMode = mm;
        await i.deferReply(EPH);
        saveGuild(i.guildId, { banner });
        const png = await renderBanner({ ...banner, roleColors: roleColorMap(i.guild) });
        const bloc = getGuild(i.guildId)?.locale;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('mh_post_banner').setLabel(t('banner.btnPost', bloc)).setStyle(ButtonStyle.Primary),
        );
        return i.editReply({
          content: t('banner.preview', bloc),
          files: [new AttachmentBuilder(png, { name: 'banner-preview.png' })], components: [row],
        });
      }
    }

    // setup selects - save immediately, refresh the panel
    if (i.isRoleSelectMenu() && i.customId === 'mh_role') {
      saveGuild(i.guildId, { verifiedRoleId: i.values[0] });
      return i.update({ content: setupContent(i.guild), components: setupComponents(getGuild(i.guildId)) });
    }
    if (i.isRoleSelectMenu() && i.customId === 'mh_staffrole') {
      saveGuild(i.guildId, { staffRoleIds: i.values, staffRoleId: '' });
      return i.update(morePanel(i.guild));
    }
    if (i.isButton() && i.customId === 'mh_more') return i.reply(morePanel(i.guild));
    if (i.isChannelSelectMenu() && i.customId === 'mh_logch') {
      saveGuild(i.guildId, { logChannelId: i.values[0] });
      return i.update(morePanel(i.guild));
    }
    if (i.isChannelSelectMenu() && ['mh_verifych', 'mh_honeych'].includes(i.customId)) {
      const key = i.customId === 'mh_verifych' ? 'verifyChannelId' : 'honeypotChannelId';
      const cfg = getGuild(i.guildId) ?? {};
      const clash = i.values[0] === (key === 'verifyChannelId' ? cfg.honeypotChannelId : cfg.verifyChannelId);
      if (clash) {
        return i.update({ content: setupContent(i.guild) + '\n\n' + t('setup.clash', cfg.locale), components: setupComponents(cfg) });
      }
      saveGuild(i.guildId, { [key]: i.values[0] });
      return i.update({ content: setupContent(i.guild), components: setupComponents(getGuild(i.guildId)) });
    }

    // Unban button on a log-channel ban report
    if (i.isButton() && i.customId.startsWith('mh_unban_')) {
      const userId = i.customId.slice('mh_unban_'.length);
      const uloc = getGuild(i.guildId)?.locale;
      try {
        await i.guild.bans.remove(userId, `MadHoney: unbanned by ${i.user.tag} via log channel`);
      } catch (e) {
        return i.reply({ content: t('reply.unbanFailed', uloc, { error: e.message }), ...EPH });
      }
      // reversal entry so ban-sharing servers stop acting on this ban
      logBan({ id: userId, guildId: i.guildId, channel: '(unban)', at: new Date().toISOString(), unbanned: true });
      return i.update({
        content: i.message.content + '\n' + t('log.unbannedBy', uloc, { mod: `${i.user}` }),
        components: [],
      });
    }

    // Hold-for-review decision buttons
    if (i.isButton() && i.customId.startsWith('mh_review_ban_')) {
      // customId: mh_review_ban_<userId>[_<msgId>] (msgId absent on older buttons)
      const [userId, msgId] = i.customId.slice('mh_review_ban_'.length).split('_');
      const cfg = getGuild(i.guildId) ?? {};
      const deleteDays = Math.min(7, Math.max(0, cfg.banDeleteDays ?? 7));
      try {
        await i.guild.bans.create(userId, { reason: `MadHoney: approved from review by ${i.user.tag}`, deleteMessageSeconds: deleteDays * 24 * 60 * 60 });
      } catch (e) {
        return i.reply({ content: t('reply.banFailed', cfg.locale, { error: e.message }), ...EPH });
      }
      logBan({ id: userId, guildId: i.guildId, channel: '(review-ban)', at: new Date().toISOString() });
      // approved as spam -> remove the held trap post too (best-effort)
      if (msgId && cfg.honeypotChannelId) {
        i.guild.channels.fetch(cfg.honeypotChannelId).then((ch) => ch.messages.delete(msgId)).catch(() => {});
      }
      return i.update({ content: i.message.content + '\n' + t('log.bannedBy', cfg.locale, { mod: `${i.user}` }), components: [] });
    }
    if (i.isButton() && i.customId.startsWith('mh_review_dismiss_')) {
      return i.update({ content: i.message.content + '\n' + t('log.dismissedBy', getGuild(i.guildId)?.locale, { mod: `${i.user}` }), components: [] });
    }

    // Appeal approve / deny (clicked by a mod in the log channel)
    if (i.isButton() && i.customId.startsWith('mh_appok_')) {
      const [, , , uid] = i.customId.split('_'); // mh_appok_{gid}_{uid}
      // Capture the incident before the reversal flips the user's latest state.
      const inc = incidentOf(uid, i.guildId);
      try {
        await i.guild.bans.remove(uid, `MadHoney: appeal approved by ${i.user.tag}`);
      } catch (e) {
        // Unknown Ban (10026) = already unbanned manually; still write the
        // reversal + resolve so they leave the universal list (audit fix).
        if (e.code !== 10026) return i.reply({ content: t('reply.unbanFailed', getGuild(i.guildId)?.locale, { error: e.message }), ...EPH });
      }
      logBan({ id: uid, guildId: i.guildId, channel: '(appeal-approved)', at: new Date().toISOString(), unbanned: true });
      if (inc) resolveIncident(inc, i.user.tag); // clear the incident network-wide
      let invite = null;
      try {
        const cfg = getGuild(i.guildId) ?? {};
        const ch = (cfg.verifyChannelId && await i.guild.channels.fetch(cfg.verifyChannelId).catch(() => null)) ||
          i.guild.channels.cache.find((c) => c.isTextBased?.() && c.viewable);
        if (ch) invite = (await ch.createInvite({ maxAge: 86400, maxUses: 1, unique: true, reason: 'MadHoney appeal approved' })).url;
      } catch { /* no invite perm - mod can send one manually */ }
      const aloc = getGuild(i.guildId)?.locale;
      client.users.send(uid, invite ? t('appeal.approvedInvite', aloc, { guild: i.guild.name, invite }) : t('appeal.approvedNoInvite', aloc, { guild: i.guild.name })).catch(() => {});
      return i.update({ content: i.message.content + '\n' + (invite ? t('log.approvedReinvited', aloc, { mod: `${i.user}` }) : t('log.approvedNoInvite', aloc, { mod: `${i.user}` })), components: [] });
    }
    if (i.isButton() && i.customId.startsWith('mh_appno_')) {
      const [, , , uid] = i.customId.split('_');
      client.users.send(uid, t('appeal.denied', getGuild(i.guildId)?.locale, { guild: i.guild.name })).catch(() => {});
      return i.update({ content: i.message.content + '\n' + t('log.deniedBy', getGuild(i.guildId)?.locale, { mod: `${i.user}` }), components: [] });
    }

    if (i.isButton() && i.customId === 'mh_text') {
      const cfg = getGuild(i.guildId) ?? {};
      const modal = new ModalBuilder().setCustomId('mh_text_modal').setTitle('Verify message');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('txt').setLabel('Shown above the Verify button')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)
          .setValue(cfg.verifyText || DEFAULT_VERIFY_TEXT),
      ));
      return i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'mh_text_modal') {
      saveGuild(i.guildId, { verifyText: i.fields.getTextInputValue('txt') });
      return i.reply({ content: 'Verify message saved. Re-post the panel from `/madhoney deploy` to update it.', ...EPH });
    }

    if (i.isButton() && i.customId === 'mh_deploy_open') return i.reply(deployPanel(i.guild));

    // deploy actions
    const deployActions = {
      mh_post_verify: (g, cfg) => postVerifyPanel(g, cfg),
      mh_post_banner: (g, cfg) => postBanner(g, cfg),
      mh_gate_dry: (g, cfg) => gateChannels(g, cfg, false),
      mh_gate_apply: (g, cfg) => gateChannels(g, cfg, true),
      mh_ungate: (g, cfg) => ungateChannels(g, cfg),
    };
    if (i.isButton() && (deployActions[i.customId] || i.customId === 'mh_grandfather')) {
      const cfg = getGuild(i.guildId);
      if (!cfg?.verifiedRoleId || !cfg?.verifyChannelId || !cfg?.honeypotChannelId) {
        return i.reply({ content: t('deploy.incomplete', cfg?.locale), ...EPH });
      }
      await i.deferReply(EPH);
      if (i.customId === 'mh_grandfather') {
        // one API call per member - stream progress into the ephemeral reply
        const progress = {};
        const job = grandfather(i.guild, cfg, progress).catch((e) => `❌ ${explainError(e.message, cfg?.locale)}`);
        const ticker = setInterval(() => {
          if (progress.total) {
            i.editReply({
              content: `⏳ Grandfathering… ${progress.done}/${progress.total} members · ${progress.added} added · ${progress.skipped} skipped${progress.failed ? ` · ${progress.failed} FAILED` : ''}`,
            }).catch(() => {});
          }
        }, 2500);
        const result = await job;
        clearInterval(ticker);
        return i.editReply({ content: result.slice(0, 1900) });
      }
      const result = await deployActions[i.customId](i.guild, cfg).catch((e) => `❌ ${explainError(e.message, cfg?.locale)}`);
      return i.editReply({ content: result.slice(0, 1900) });
    }
  } catch (err) {
    console.error('interaction error:', err);
    if (i.isRepliable() && !i.replied && !i.deferred) i.reply({ content: t('common.broke', getGuild(i.guildId)?.locale), ...EPH }).catch(() => {});
  }
});

// ---------- onboarding: point new servers at the dashboard ----------

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined ${guild.name} (${guild.id})`);
  try {
    const me = await guild.members.fetchMe();
    const canPost = (c) => c?.isTextBased?.() && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
    const ch = canPost(guild.systemChannel) ? guild.systemChannel : guild.channels.cache.find(canPost);
    await ch?.send({
      content: [
        '🍯 Thanks for adding **MadHoney**!',
        `The easiest way to set up is the **web dashboard**: ${dashLink(guild.id)} - drag-and-drop channel gating, a live banner designer, and guided setup. It's much friendlier than doing it by hand.`,
        'Prefer Discord? Run `/madhoney setup`. Either way, make sure my role sits **above** your verified role in Server Settings → Roles.',
        '📋 When you pick a **mod-log channel**, make sure I have **View Channel** and **Send Messages** there - ban reports and member appeals are posted to it, and the appeal Approve/Deny buttons live there too.',
      ].join('\n\n'),
    });
  } catch { /* no postable channel - fine */ }
});

// ---------- keep the gate closed on channels added/re-opened later ----------

// A channel created after the initial gate (or one an admin re-exposes to
// @everyone) is an ungated hole. Auto-gate it behind the verified role, matching
// the classify/gate rules. Best-effort; reports to the log channel if set.
async function autogate(channel) {
  const guild = channel?.guild;
  if (!guild) return;
  const cfg = getGuild(guild.id);
  if (!cfg) return;
  try {
    const msg = await gateNewChannel(guild, cfg, channel);
    if (!msg) return;
    console.log(`[${guild.name}] ${msg}`);
    await logSend(guild, cfg, { content: msg }, 'normal');
  } catch (err) {
    console.error(`[${guild.name}] auto-gate failed for #${channel?.name}:`, err.message);
  }
}
client.on(Events.GuildChannelCreate, (channel) => autogate(channel));
client.on(Events.GuildChannelUpdate, (_old, channel) => autogate(channel));

// ---------- appeal pipeline (opt-in) ----------

// DM a just-banned user offering to appeal ONLY the server that just banned
// them. Scoped deliberately: the DM never lists other servers the user is
// banned in, so it can't be turned into a tool to enumerate someone's server
// memberships. Best-effort: fails silently if DMs are closed or not appealable.
async function offerAppeal(user, guildId) {
  if (!appealableGuildIds(user.id).includes(guildId)) return; // this server didn't opt in, or they aren't banned here
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const epoch = banEpoch(user.id, guildId);
  if (!epoch) return;
  const loc = getGuild(guildId)?.locale;
  await user.send({
    content: [t('appeal.dmIntro', loc), t('appeal.dmAsk', loc, { guild: guild.name })].join('\n\n'),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mh_appeal_${guild.id}_${appealSig(user.id, guild.id, epoch)}`).setLabel(t('appeal.button', loc, { guild: guild.name }).slice(0, 80)).setStyle(ButtonStyle.Primary),
    )],
  });
}

// ---------- honeypot ----------

client.on(Events.MessageCreate, async (msg) => {
  if (!msg.inGuild()) return;
  const cfg = getGuild(msg.guildId);

  // Webhooks post with the bot flag, so shouldTrap's bot exemption skips them -
  // but a webhook firing in the honeypot is hostile and can't be "banned" (it's
  // not a member). Delete the post and alert; removing the webhook itself needs
  // Manage Webhooks and is the mods' call.
  if (msg.webhookId && cfg?.honeypotChannelId && msg.channelId === cfg.honeypotChannelId && honeypotMode(cfg) !== 'disarmed') {
    msg.delete().catch(() => {});
    console.log(`[${msg.guild.name}] deleted webhook post in honeypot (${msg.webhookId})`);
    await logSend(msg.guild, cfg, { content: t('log.webhookAlert', cfg.locale, { channel: cfg.honeypotChannelId }) }, 'normal');
    return;
  }

  // Ban-list enforcement on first activity: GuildMemberAdd is the primary path,
  // but it needs the Server Members intent — while that's unavailable a known
  // spammer who joins fires no join event, so we also check on message. A user on
  // the universal list (unresolved elsewhere) is banned and their message deleted
  // the instant they post, in any channel. Skips bots/owner/staff — reBanSource
  // only flags accounts banned for spam elsewhere, but a listed account that's
  // somehow staff/owner here is a false positive to handle manually, not auto-ban.
  if (cfg?.banShare && !msg.author.bot && msg.guild.ownerId !== msg.author.id
    && !((msg.member?.permissions.has(PermissionsBitField.Flags.ManageGuild) ?? false)
      || staffRoles(cfg).some((r) => msg.member?.roles.cache.has(r) ?? false))
    && reBanSource(msg.author.id, msg.guildId)) {
    await msg.delete().catch(() => {});
    if (await enforceBanList(msg.guild, msg.author, cfg)) return; // banned - nothing more to do
  }

  // Lazy grandfathering: an existing member who joined BEFORE this server's
  // grandfather cutoff but lacks the verified role gets it the instant they post,
  // so channel gating never locks out a legitimate existing member. It reads only
  // the member data MESSAGE_CREATE already carries (no member-list fetch), so it
  // keeps working while the Server Members privileged intent is unavailable - and
  // it self-heals anyone a bulk grandfather pass skipped. Security-critical: the
  // cutoff means anyone who joined AFTER grandfathering must still verify, so a
  // fresh account can never post once and bypass verification.
  if (cfg?.verifiedRoleId && cfg?.grandfatheredAt && !msg.author.bot && msg.member
    && msg.member.joinedTimestamp && msg.member.joinedTimestamp < Date.parse(cfg.grandfatheredAt)
    && !msg.member.roles.cache.has(cfg.verifiedRoleId)) {
    msg.member.roles.add(cfg.verifiedRoleId, 'MadHoney: grandfathered existing member on activity')
      .then(() => console.log(`[${msg.guild.name}] lazy-grandfathered ${msg.author.tag} (${msg.author.id})`))
      .catch(() => {});
  }

  // Compromised-account detection: a hijacked member blasts the same message
  // across many channels in seconds - faster than a human switching channels by
  // hand. If this non-privileged member's post matches their own recent posts in
  // enough OTHER channels within the window, treat the account as compromised and
  // take the configured action. Compares content, so it's dormant without the
  // Message Content intent (empty signature -> skipped). Independent of the
  // honeypot; skips the honeypot channel, webhooks, bots, owner and staff.
  const comp = compromisedSettings(cfg);
  if (COMPROMISED_LIVE && cfg && comp.enabled && msg.member && !msg.author.bot && !msg.webhookId
    && msg.guild.ownerId !== msg.author.id && msg.channelId !== cfg.honeypotChannelId
    && !((msg.member.permissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false)
      || staffRoles(cfg).some((r) => msg.member.roles.cache.has(r)))) {
    const sig = messageSignature({ content: msg.content, attachmentNames: [...msg.attachments.values()].map((a) => a.name) });
    const blast = recordAndCheck(compromisedStore, `${msg.guildId}:${msg.author.id}`, sig,
      { channelId: msg.channelId, messageId: msg.id }, msg.createdTimestamp, comp);
    if (blast) { await handleCompromised(msg.member, cfg, comp, blast); return; }
  }

  const facts = {
    channelId: msg.channelId,
    authorIsBot: msg.author.bot,
    isOwner: msg.guild.ownerId === msg.author.id,
    // staff = Manage Server permission OR the configured staff role
    isStaff: (msg.member?.permissions.has(PermissionsBitField.Flags.ManageGuild) ?? false) ||
      staffRoles(cfg).some((r) => msg.member?.roles.cache.has(r) ?? false),
  };
  if (!shouldTrap(facts, cfg)) return;

  // Capture what we can BEFORE the ban wipes the message. The gateway strips
  // content + attachments without the Message Content intent - but a REST
  // re-fetch recovers ATTACHMENTS (and content too, if the intent is on), so we
  // can show the actual spam images in the log either way.
  let full = msg;
  if (!msg.content && msg.attachments.size === 0) full = await msg.fetch().catch(() => msg);
  const spamText = full.content || null;
  const atts = [...full.attachments.values()];
  const attachments = atts.map((a) => a.name).join(', ');
  // Re-host up to 4 image attachments in the log. Download the bytes NOW, before
  // the ban's deleteMessageSeconds purge can wipe the CDN copy - so the mod log
  // keeps the actual spam image even after the original is gone.
  const spamFiles = [];
  for (const a of atts.filter((x) => x.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(x.name)).slice(0, 4)) {
    try { spamFiles.push(new AttachmentBuilder(Buffer.from(await (await fetch(a.url)).arrayBuffer()), { name: a.name })); }
    catch { /* couldn't fetch the attachment - skip it */ }
  }
  const quoted = spamText
    ? spamText.slice(0, 1000).split('\n').map((l) => `> ${l}`).join('\n')
    : (atts.length ? `> *(${atts.length} attachment(s) - shown below)*`
      : '> *(message content unavailable - enable the Message Content intent and set `MESSAGE_CONTENT=on` to capture it)*');

  // Hold-for-review mode: don't ban. Post the hit to the log channel and let a
  // mod decide with Ban / Dismiss buttons. Not recommended (a real spam run
  // buries the log), but supported.
  if (honeypotMode(cfg) === 'review') {
    if (!cfg.logChannelId) { console.log(`[${msg.guild.name}] review mode but no log channel - ignoring honeypot hit`); return; }
    await logSend(msg.guild, cfg, {
      content: [
        t('log.reviewHeld', cfg.locale, { tag: msg.author.tag, id: msg.author.id, channel: cfg.honeypotChannelId }),
        t('log.jump', cfg.locale, { url: msg.url }),
        quoted,
        attachments ? t('log.attach', cfg.locale, { names: attachments }) : null,
      ].filter(Boolean).join('\n'),
      files: spamFiles.length ? spamFiles : undefined,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mh_review_ban_${msg.author.id}_${msg.id}`).setLabel(t('log.banBtn', cfg.locale)).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`mh_review_dismiss_${msg.author.id}`).setLabel(t('log.dismissBtn', cfg.locale)).setStyle(ButtonStyle.Secondary),
      )],
    }, 'critical');
    // mark the held message as handled so a restart's catch-up sweep never
    // re-posts a hold a mod may have already decided on
    await msg.react('⏳').catch(() => {});
    console.log(`[${msg.guild.name}] held ${msg.author.tag} (${msg.author.id}) for review`);
    return;
  }

  // --- armed mode: ban now ---
  // log first, so we keep the ID even if the ban call fails. Stamp a stable
  // incidentId: this is the ORIGIN of the incident; ban-share/bansync copy it so
  // one appeal approval clears the whole thing network-wide (see incident.js).
  const now = Date.now();
  const incidentId = makeIncidentId(msg.guildId, msg.author.id, now);
  // A server only CONTRIBUTES catches to the shared/global ban list if it actually
  // enforces entry - gated channels OR required verification. An ungated server
  // with verification off has a wide-open honeypot a real member can wander into,
  // so its catches stay LOCAL (noShare): it still bans here + still CONSUMES the
  // shared list, but its bans don't propagate. Keeps false positives off the network.
  const noShare = !((cfg.gatedChannels?.length ?? 0) > 0 || (cfg.verificationEnabled !== false && !!cfg.verifiedRoleId));
  logBan({ id: msg.author.id, tag: msg.author.tag, guildId: msg.guildId, channel: msg.channel.name, at: new Date(now).toISOString(), incidentId, ...(noShare ? { noShare: true } : {}) });

  // Appeal DM (opt-in): a real human who tripped the trap can ask for review.
  // Sent BEFORE the ban so they're still reachable, and only lists servers they
  // are actually banned in that opted into appeals (never leaks other servers).
  await offerAppeal(msg.author, msg.guildId).catch(() => {});

  let banned = false;
  // How much of their recent message history to wipe with the ban (0-7 days).
  const deleteDays = Math.min(7, Math.max(0, cfg.banDeleteDays ?? 7));
  try {
    await msg.guild.bans.create(msg.author.id, {
      reason: `MadHoney honeypot: posted in #${msg.channel.name}`,
      deleteMessageSeconds: deleteDays * 24 * 60 * 60,
    });
    banned = true;
    console.log(`[${msg.guild.name}] banned ${msg.author.tag} (${msg.author.id})`);
  } catch (err) {
    console.error(`[${msg.guild.name}] ban FAILED for ${msg.author.id} (logged anyway):`, err.message);
  }

  // Report to the log channel (if configured) with an Unban escape hatch.
  await logSend(msg.guild, cfg, {
    content: [
      t(banned ? 'log.reportBanned' : 'log.reportFailed', cfg.locale, { channel: cfg.honeypotChannelId }),
      t('log.user', cfg.locale, { tag: msg.author.tag, id: msg.author.id }),
      quoted,
      attachments ? t('log.attach', cfg.locale, { names: attachments }) : null,
    ].filter(Boolean).join('\n'),
    files: spamFiles.length ? spamFiles : undefined,
    components: banned ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mh_unban_${msg.author.id}`).setLabel(t('log.undoBtn', cfg.locale)).setStyle(ButtonStyle.Danger),
    )] : [],
  }, 'critical');

  // The post is now preserved in the report above (text + attachment names), so
  // remove it - a caught spammer's message shouldn't linger in the decoy channel.
  // The ban's deleteMessageSeconds can miss a message this recent, so delete it
  // explicitly. Best-effort: needs Manage Messages in the honeypot channel.
  await msg.delete().catch(() => {});
  // ...then sweep any stragglers the ban's purge raced past in other channels.
  if (banned) sweepStragglers(msg.guild, msg.author.id).catch(() => {});
  if (banned) notifyTrap(msg.guild, msg.author, msg.channel.name).catch(() => {}); // network-wide trap feed
});

// Act on a detected compromised-account blast (compromised.js). Deletes the
// blasted messages across channels (best-effort), then applies the server's
// action: kick (default), quarantine (strip the verified role so they must
// re-verify), ban, or notify-only. Always alerts the mod log. Self-contained and
// never throws - if the action fails (missing permission, role hierarchy) it
// downgrades to a notify so mods still see it.
async function handleCompromised(member, cfg, comp, blast) {
  const guild = member.guild;
  const { user: { tag }, id } = member;
  const n = blast.length;
  try {
    if (comp.deleteMessages) {
      for (const { channelId, messageId } of blast) {
        await guild.channels.cache.get(channelId)?.messages.delete(messageId).catch(() => {});
      }
    }
    const reason = `MadHoney: compromised-account blast across ${n} channels`;
    let action = comp.action;
    const fail = (e) => { console.log(`[${guild.name}] compromised ${action} failed for ${tag}: ${e.message}`); action = 'notify'; };
    if (action === 'kick') await member.kick(reason).catch(fail);
    else if (action === 'ban') await guild.bans.create(id, { reason, deleteMessageSeconds: 3600 }).catch(fail);
    else if (action === 'quarantine') {
      if (cfg.verifiedRoleId) await member.roles.remove(cfg.verifiedRoleId, reason).catch(fail);
      else action = 'notify'; // nothing to strip
    }
    console.log(`[${guild.name}] compromised: ${tag} (${id}) blasted ${n} channels -> ${action}`);
    await logSend(guild, cfg, { content: t(`log.compromised_${action}`, cfg.locale, { tag, id, n }) }, 'critical');
  } catch (e) {
    console.log(`[${guild.name}] compromised handler error for ${tag}: ${e.message}`);
  }
}

// Discord's ban `deleteMessageSeconds` purge is best-effort and races the message
// indexer: a message posted in the ~second before the ban can survive as a
// "straggler" (seen on busy servers like Prusa). After a ban, sweep the user's
// recent messages across channels we can moderate and delete anything the purge
// missed. Bounded + best-effort so it can't become a full history scan:
// ponytail: last ~30 msgs per channel, only messages from the last 15 min, only
// channels with Manage Messages, pool of 5. A short delay lets Discord settle first.
async function sweepStragglers(guild, userId) {
  const me = guild.members.me;
  if (!me) return;
  await new Promise((r) => setTimeout(r, 3000)); // let the ban's own purge + indexer settle
  const cutoff = Date.now() - 15 * 60 * 1000;
  const chans = [...guild.channels.cache.values()].filter((c) => c.isTextBased?.() && !c.isVoiceBased?.()
    && c.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageMessages)
    && c.permissionsFor(me)?.has(PermissionsBitField.Flags.ReadMessageHistory));
  let idx = 0, deleted = 0;
  const worker = async () => {
    while (idx < chans.length) {
      const ch = chans[idx++];
      try {
        const msgs = await ch.messages.fetch({ limit: 30 });
        const mine = msgs.filter((m) => m.author.id === userId && m.createdTimestamp >= cutoff);
        if (mine.size === 1) { await mine.first().delete().catch(() => {}); deleted += 1; }
        else if (mine.size > 1) { const d = await ch.bulkDelete(mine, true).catch(() => null); deleted += d ? d.size : 0; }
      } catch { /* best effort - missing perms / rate limit */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, chans.length || 1) }, worker));
  if (deleted) console.log(`[${guild.name}] straggler sweep removed ${deleted} leftover message(s) from ${userId}`);
}

// ---------- cross-server ban sharing (opt-in) ----------

// Universal ban-list enforcement, shared by the join event and the message path.
// Incident-aware: reBanSource returns the guild whose ban is still UNRESOLVED, or
// null when they aren't banned elsewhere OR an approved appeal already cleared the
// incident network-wide (so we must NOT re-ban — the confirmed lockout loop). The
// origin incidentId is carried onto the propagated row so one appeal keeps
// covering it. Returns true if a ban was issued.
async function enforceBanList(guild, user, cfg) {
  if (!cfg?.banShare) return false; // universal list only applies to opted-in servers
  const source = reBanSource(user.id, guild.id);
  if (!source) return false;
  const incidentId = incidentOf(user.id, source);
  // Purge their recent history with the ban (same window as the honeypot path) -
  // previously this passed no deleteMessageSeconds, so a ban-share/message-path
  // ban left every spam message in place.
  const deleteDays = Math.min(7, Math.max(0, cfg.banDeleteDays ?? 7));
  try {
    await guild.bans.create(user.id, {
      reason: 'MadHoney: on the universal ban list (caught by another server\'s honeypot)',
      deleteMessageSeconds: deleteDays * 24 * 60 * 60,
    });
    logBan({ id: user.id, tag: user.tag, guildId: guild.id, channel: '(ban-share)', at: new Date().toISOString(), incidentId });
    console.log(`[${guild.name}] ban-share banned ${user.tag} (${user.id})`);
  } catch (err) {
    console.error(`[${guild.name}] ban-share FAILED for ${user.id}:`, err.message);
    return false;
  }
  sweepStragglers(guild, user.id).catch(() => {}); // catch anything the purge raced past
  await logSend(guild, cfg, {
    content: [
      t('log.banshareReport', cfg.locale),
      t('log.user', cfg.locale, { tag: user.tag, id: user.id }),
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mh_unban_${user.id}`).setLabel(t('log.undoBtn', cfg.locale)).setStyle(ButtonStyle.Danger),
    )],
  }, 'critical');
  return true;
}

// On join: primary ban-list enforcement (needs the Server Members intent). While
// that intent is unavailable, the message-path check below is the fallback.
client.on(Events.GuildMemberAdd, async (member) => {
  await enforceBanList(member.guild, member.user, getGuild(member.guild.id));
});

// ---------- boot ----------

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([command]);
  console.log(`MadHoney armed as ${c.user.tag} in ${c.guilds.cache.size} guild(s). /madhoney setup to begin.`);

  // Keep posted messages current WITHOUT notifying anyone: each refresh edits
  // the existing Verify panel / banner in place, and only when its content
  // actually changed (fingerprint check inside). A plain bot update with no
  // visible change to those messages does nothing here.
  setTimeout(async () => {
    for (const guild of c.guilds.cache.values()) {
      const cfg = getGuild(guild.id);
      if (!cfg) continue;
      try {
        if (cfg.verifyPosted) { const r = await refreshVerifyPanel(guild, getGuild(guild.id)); if (r) console.log(`[${guild.name}] ${r}`); }
        if (cfg.bannerPosted) { const r = await refreshBanner(guild, getGuild(guild.id)); if (r) console.log(`[${guild.name}] ${r}`); }
      } catch (err) {
        console.error(`[${guild.name}] panel refresh failed (will retry next boot):`, err.message);
      }
    }
  }, 5000); // let the guild/channel caches settle first

  // Honeypot catch-up: replay trap-channel messages posted while the bot
  // couldn't see them (restart, crash, outage) through the normal handler, so a
  // downtime window doesn't let a spammer slip through. `.lastseen` is stamped
  // every minute while connected; anything newer than it was never handled.
  setTimeout(async () => {
    let since = Date.now();
    try { if (existsSync(LASTSEEN)) since = Number(readFileSync(LASTSEEN, 'utf8')) || since; } catch { /* first boot */ }
    since = Math.max(since, Date.now() - 24 * 3600 * 1000); // a stale marker must never replay days of handled history
    for (const guild of c.guilds.cache.values()) {
      const cfg = getGuild(guild.id);
      if (!cfg?.honeypotChannelId || honeypotMode(cfg) === 'disarmed') continue;
      try {
        const ch = await guild.channels.fetch(cfg.honeypotChannelId);
        const missed = [...(await ch.messages.fetch({ limit: 50 })).values()]
          .filter((m) => m.author.id !== c.user.id && m.createdTimestamp > since - 5000)
          .reverse(); // oldest first, like live delivery
        for (const m of missed) {
          // skip anything a mod (or a previous instance) already adjudicated:
          // our own reaction marks a handled review-hold, and any ban-log row
          // newer than the message means the episode was decided after it -
          // replaying would reverse a deliberate unban/dismiss
          if (m.reactions.cache.some((r) => r.me)) continue;
          if (bans(guild.id).some((b) => b.id === m.author.id && Date.parse(b.at) >= m.createdTimestamp)) continue;
          // REST-fetched messages carry no member; resolve it so the staff/owner
          // exemptions in the live handler still hold (a mod tidying the decoy
          // must never be banned by the replay)
          if (!m.member) await guild.members.fetch(m.author.id).catch(() => null);
          client.emit(Events.MessageCreate, m);
        }
        if (missed.length) console.log(`[${guild.name}] honeypot catch-up: replayed ${missed.length} missed message(s)`);
      } catch { /* trap channel unreadable/gone - preflight reports that */ }
    }
    try { writeFileSync(LASTSEEN, String(Date.now())); } catch { /* best effort */ }
  }, 8000);

  // Gate catch-up: GuildChannelCreate only fires for LIVE events, so a channel
  // created while the bot was offline (restart, deploy, a failover window) is an
  // ungated hole that never gets closed. On boot, re-run the auto-gate check over
  // every channel of each gating guild. gateNewChannel is idempotent and cheap -
  // it early-returns for channels already gated, private, read-only, or the
  // admin left public - so only genuine new holes trigger an edit.
  setTimeout(async () => {
    for (const guild of c.guilds.cache.values()) {
      const cfg = getGuild(guild.id);
      if (!cfg?.gatedChannels?.length) continue; // only servers that use gating
      let closed = 0;
      try {
        for (const channel of (await guild.channels.fetch()).values()) {
          if (!channel) continue;
          const msg = await gateNewChannel(guild, cfg, channel).catch(() => null);
          if (msg) { closed++; console.log(`[${guild.name}] ${msg}`); }
        }
        if (closed) await logSend(guild, getGuild(guild.id), { content: t('log.gateCatchup', cfg.locale, { n: closed }) }, 'normal');
      } catch (e) { console.error(`[${guild.name}] gate catch-up failed:`, e.message); }
    }
  }, 15000); // after honeypot catch-up; caches settled

  // Resume grandfather / ban-sync jobs a restart interrupted. Both are
  // idempotent (skip members already handled) and self-clear their pending flag
  // on completion; run sequentially so several servers can't gang up on the
  // rate limit at once. If one fails on resume (e.g. config changed), clear its
  // flag so it doesn't retry every boot.
  setTimeout(async () => {
    for (const guild of c.guilds.cache.values()) {
      const gcfg = getGuild(guild.id);
      // Only clear the flag on a PERMANENT failure (e.g. verified role deleted);
      // a transient error (rate limit, network) keeps the flag so it retries on
      // the next boot instead of abandoning the job.
      const transient = (e) => /rate.?limit|opcode 8|ECONN|ETIMEDOUT|timed out|socket|50[23]|network|fetch failed/i.test(e?.message || '');
      if (gcfg?.grandfatherPending) {
        console.log(`[${guild.name}] resuming interrupted grandfather...`);
        try { console.log(`[${guild.name}] ${await grandfather(guild, gcfg)}`); }
        catch (e) {
          console.error(`[${guild.name}] grandfather resume ${transient(e) ? 'hit a transient error - keeping flag to retry next boot' : 'failed - clearing flag'}:`, e.message);
          if (!transient(e)) saveGuild(guild.id, { grandfatherPending: false });
        }
      }
      if (gcfg?.banSyncPending) {
        console.log(`[${guild.name}] resuming interrupted ban-sync...`);
        try { console.log(`[${guild.name}] ${await syncBans(guild, gcfg)}`); }
        catch (e) {
          console.error(`[${guild.name}] ban-sync resume ${transient(e) ? 'hit a transient error - keeping flag to retry next boot' : 'failed - clearing flag'}:`, e.message);
          if (!transient(e)) saveGuild(guild.id, { banSyncPending: false });
        }
      }
    }
  }, 12000);

  // Periodic auto ban-sync: the shared list is otherwise only applied on JOIN
  // (ban-share) or a manual /madhoney bansync, so a member already IN a server
  // when they're caught elsewhere never gets synced. Every SYNC_EVERY_MS, each
  // opted-in server re-applies the current list. syncBans is idempotent (skips
  // already-banned) and incident-aware (skips appeal-resolved incidents), so a
  // recovered user is never re-swept. Serialized across guilds so the shared
  // list can't gang up on the per-guild ban rate limit.
  const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
  const autoSync = async () => {
    for (const guild of c.guilds.cache.values()) {
      const gcfg = getGuild(guild.id);
      if (!gcfg?.banShare) continue;
      const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
      if (!me?.permissions.has(PermissionFlagsBits.BanMembers)) continue; // can't ban here; skip quietly
      try {
        const progress = {};
        const result = await syncBans(guild, gcfg, progress);
        if (progress.added) console.log(`[${guild.name}] auto ban-sync: ${result}`);
      } catch (e) {
        console.error(`[${guild.name}] auto ban-sync failed:`, e.message);
      }
    }
  };
  // First pass 5 min after boot (let caches + boot jobs settle), then on the interval.
  setTimeout(() => { autoSync(); setInterval(autoSync, SYNC_EVERY_MS).unref?.(); }, 5 * 60 * 1000).unref?.();

  // Daily trap-feed report: check ~2 min after boot, then hourly. maybeDailyReport
  // self-dedupes against the channel, so hourly checks post at most once per day.
  if (TRAP_FEED) setTimeout(() => { maybeDailyReport().catch(() => {}); setInterval(() => maybeDailyReport().catch(() => {}), 60 * 60 * 1000).unref?.(); }, 2 * 60 * 1000).unref?.();

  // Minimum viable: Manage Roles (verified role + channel overwrites), Manage
  // Channels, Ban Members, View Channels, Send Messages, Attach Files, Read
  // Message History. If gating a specific channel fails with Missing Access,
  // the bot can't see it - grant the MadHoney role View there (or temporarily
  // give it Administrator, gate, then remove).
  console.log(`Invite: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot+applications.commands&permissions=268545044`);
  // Run bulk/canvas jobs the edge verify-worker delegates via the D1 `jobs`
  // table (grandfather, bansync, gating, banner render) — no-op without CF_D1
  // creds, so a plain self-host is unaffected.
  startJobRunner(client, getGuild);
  if (process.env.CLIENT_ID) {
    startDashboard(client);
    if (!process.env.CLIENT_SECRET) console.log('Dashboard up in landing-only mode - set CLIENT_SECRET in .env to enable login.');
  } else console.log('Dashboard disabled (set CLIENT_ID in .env to enable).');
});

// Pluggable stores may need async init (hydrating caches) and may hold or drop
// the gateway connection (e.g. replicated deployments). No-op for the file store.
await store.init?.({
  fence: () => client.destroy(),
  unfence: () => client.login(process.env.DISCORD_TOKEN),
});
// a store that fenced during init is telling us NOT to connect (another
// instance owns the token right now) - it exits/recovers on its own schedule
if (!store.isFenced?.()) client.login(process.env.DISCORD_TOKEN);
