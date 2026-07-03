// MadHoney - honeypot + captcha verification for any Discord server.
// One process: the bot, plus (if CLIENT_ID/CLIENT_SECRET are set) the web
// dashboard. Per-guild config lives in guilds.json; bans in bans.jsonl.
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import {
  Client, GatewayIntentBits, Events, PermissionFlagsBits, PermissionsBitField, MessageFlags,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
} from 'discord.js';
import { shouldTrap, honeypotMode } from './trap.js';
import { makeCode, answerOk } from './verify.js';
import { renderCaptcha, captchaLength } from './captcha.js';
import { renderBanner, DEFAULT_BANNER, FONTS } from './banner.js';
import { getGuild, saveGuild, logBan, bans, bannedElsewhere, appealableGuildIds, banEpoch, hasAppealed, recordAppeal } from './store.js';
import { postVerifyPanel, postBanner, refreshVerifyPanel, refreshBanner, gateChannels, gateNewChannel, ungateChannels, grandfather, syncBans, explainError, roleColorMap, DEFAULT_VERIFY_TEXT } from './actions.js';
import { startDashboard } from './dashboard.js';
import { t } from './i18n.js';

const EPH = { flags: MessageFlags.Ephemeral };
const pending = new Map(); // userId -> { code, attempts, expires, cooldownUntil } (in-memory; users re-click after a restart)
const appealInFlight = new Set(); // `${uid}:${gid}:${epoch}` mid-send; the async half of the one-appeal-per-ban guard (durable half is appeals.jsonl)
const VERIFY_TTL = 3 * 60 * 1000;  // a shown captcha is valid this long
const VERIFY_MAX_ATTEMPTS = 5;     // wrong guesses against one code before it's burned
const VERIFY_COOLDOWN = 2000;      // min ms between "Verify" clicks (each mints a fresh image)
// sweep expired codes so `pending` can't grow without bound
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (now > v.expires) pending.delete(k); }, 60_000).unref?.();

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
async function logSend(guild, cfg, payload, priority = 'normal') {
  if (!cfg?.logChannelId) return;
  if (!logAllow(guild.id, priority)) { console.log(`[${guild.name}] log ${priority} message throttled`); return; }
  try {
    const log = await guild.channels.fetch(cfg.logChannelId);
    await log.send(payload);
  } catch (err) { console.error(`[${guild.name}] log send failed:`, err.message); }
}
const DASH = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const dashLink = (guildId) => (DASH ? `**[${DASH.replace(/^https?:\/\//, '')}](${DASH}${guildId ? `/g/${guildId}` : ''})**` : 'the web dashboard');

// The trap itself never needs message content. It's only used to COPY the
// spam text into the log channel - opt-in, because it's a privileged intent:
// enable it in the Dev Portal AND set MESSAGE_CONTENT=on, or login fails.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers];
if (process.env.MESSAGE_CONTENT === 'on') intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });

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
  .addSubcommand((s) => s.setName('disarm').setDescription('Disarm the honeypot - stop banning (use while setting up)'));

// ---------- setup panel ----------

function setupContent(guild) {
  const cfg = getGuild(guild.id) ?? {};
  const loc = cfg.locale;
  const ns = t('common.notSet', loc);
  const v = (id) => (id ? `<#${id}>` : ns);
  const role = (id) => (id ? `<@&${id}>` : ns);
  const hp = { armed: t('setup.hpArmed', loc), review: t('setup.hpReview', loc), disarmed: t('setup.hpDisarmed', loc) }[honeypotMode(cfg)];
  return [
    t('setup.title', loc),
    t('setup.dashHint', loc, { dash: dashLink(guild.id) }),
    '',
    t('setup.verifiedRole', loc, { role: role(cfg.verifiedRoleId) }),
    t('setup.verifyChannel', loc, { channel: v(cfg.verifyChannelId) }),
    t('setup.honeypotChannel', loc, { channel: v(cfg.honeypotChannelId) }),
    t('setup.staffRole', loc, { role: role(cfg.staffRoleId) }),
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
  const staff = new RoleSelectMenuBuilder().setCustomId('mh_staffrole').setPlaceholder(t('more.phStaff', loc));
  if (cfg.staffRoleId) staff.setDefaultRoles(cfg.staffRoleId);
  const logCh = new ChannelSelectMenuBuilder().setCustomId('mh_logch').setPlaceholder(t('more.phLog', loc)).setChannelTypes(ChannelType.GuildText);
  if (cfg.logChannelId) logCh.setDefaultChannels(cfg.logChannelId);
  return {
    content: [
      t('more.title', loc),
      t('more.staffRole', loc, { role: cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : ns }),
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

client.on(Events.InteractionCreate, async (i) => {
  try {
    // --- member-facing verify flow (no permissions needed) ---
    if (i.isButton() && i.customId === 'verify_start') {
      const cfg = getGuild(i.guildId) ?? {};
      const role = cfg.verifiedRoleId && (await i.guild.roles.fetch(cfg.verifiedRoleId).catch(() => null));
      if (role && i.member.roles.cache.has(role.id)) return i.reply({ content: t('verify.alreadyVerified', cfg.locale), ...EPH });
      const now = Date.now();
      const prev = pending.get(i.user.id);
      if (prev && now < prev.cooldownUntil) return i.reply({ content: t('verify.cooldown', cfg.locale), ...EPH });
      const difficulty = cfg.captchaDifficulty ?? 'normal';
      const code = makeCode(captchaLength(difficulty));
      pending.set(i.user.id, { code, attempts: 0, expires: now + VERIFY_TTL, cooldownUntil: now + VERIFY_COOLDOWN });
      const img = new AttachmentBuilder(renderCaptcha(code, difficulty), { name: 'captcha.png' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('verify_open').setLabel(t('verify.enterCode', cfg.locale)).setStyle(ButtonStyle.Success),
      );
      return i.reply({ content: t('verify.instructions', cfg.locale), files: [img], components: [row], ...EPH });
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
      if (!rec || Date.now() > rec.expires) {
        pending.delete(i.user.id);
        return i.reply({ content: t('verify.expired', cfg.locale), ...EPH });
      }
      if (answerOk(i.fields.getTextInputValue('ans'), rec.code)) {
        pending.delete(i.user.id);
        const role = cfg.verifiedRoleId && (await i.guild.roles.fetch(cfg.verifiedRoleId).catch(() => null));
        if (!role) return i.reply({ content: t('verify.roleMissing', cfg.locale), ...EPH });
        await i.member.roles.add(role, 'MadHoney: passed verification');
        return i.reply({ content: t('verify.success', cfg.locale, { guild: i.guild.name }), ...EPH });
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
        const job = syncBans(i.guild, getGuild(i.guildId) ?? {}, progress).catch((e) => `❌ ${explainError(e.message)}`);
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
      saveGuild(i.guildId, { staffRoleId: i.values[0] });
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
      const userId = i.customId.slice('mh_review_ban_'.length);
      const cfg = getGuild(i.guildId) ?? {};
      const deleteDays = Math.min(7, Math.max(0, cfg.banDeleteDays ?? 7));
      try {
        await i.guild.bans.create(userId, { reason: `MadHoney: approved from review by ${i.user.tag}`, deleteMessageSeconds: deleteDays * 24 * 60 * 60 });
      } catch (e) {
        return i.reply({ content: t('reply.banFailed', cfg.locale, { error: e.message }), ...EPH });
      }
      logBan({ id: userId, guildId: i.guildId, channel: '(review-ban)', at: new Date().toISOString() });
      return i.update({ content: i.message.content + '\n' + t('log.bannedBy', cfg.locale, { mod: `${i.user}` }), components: [] });
    }
    if (i.isButton() && i.customId.startsWith('mh_review_dismiss_')) {
      return i.update({ content: i.message.content + '\n' + t('log.dismissedBy', getGuild(i.guildId)?.locale, { mod: `${i.user}` }), components: [] });
    }

    // Appeal approve / deny (clicked by a mod in the log channel)
    if (i.isButton() && i.customId.startsWith('mh_appok_')) {
      const [, , , uid] = i.customId.split('_'); // mh_appok_{gid}_{uid}
      try {
        await i.guild.bans.remove(uid, `MadHoney: appeal approved by ${i.user.tag}`);
      } catch (e) {
        return i.reply({ content: t('reply.unbanFailed', getGuild(i.guildId)?.locale, { error: e.message }), ...EPH });
      }
      logBan({ id: uid, guildId: i.guildId, channel: '(appeal-approved)', at: new Date().toISOString(), unbanned: true });
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
        const job = grandfather(i.guild, cfg, progress).catch((e) => `❌ ${explainError(e.message)}`);
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
      const result = await deployActions[i.customId](i.guild, cfg).catch((e) => `❌ ${explainError(e.message)}`);
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

  const facts = {
    channelId: msg.channelId,
    authorIsBot: msg.author.bot,
    isOwner: msg.guild.ownerId === msg.author.id,
    // staff = Manage Server permission OR the configured staff role
    isStaff: (msg.member?.permissions.has(PermissionsBitField.Flags.ManageGuild) ?? false) ||
      (!!cfg?.staffRoleId && (msg.member?.roles.cache.has(cfg.staffRoleId) ?? false)),
  };
  if (!shouldTrap(facts, cfg)) return;

  // Capture what we can BEFORE the ban wipes the message. content is only
  // populated when the privileged Message Content intent is on (MESSAGE_CONTENT=on).
  const spamText = msg.content || null;
  const attachments = [...msg.attachments.values()].map((a) => a.name).join(', ');
  const quoted = spamText
    ? spamText.slice(0, 1000).split('\n').map((l) => `> ${l}`).join('\n')
    : '> *(message content unavailable - enable the Message Content intent and set `MESSAGE_CONTENT=on` to capture it)*';

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
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mh_review_ban_${msg.author.id}`).setLabel(t('log.banBtn', cfg.locale)).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`mh_review_dismiss_${msg.author.id}`).setLabel(t('log.dismissBtn', cfg.locale)).setStyle(ButtonStyle.Secondary),
      )],
    }, 'critical');
    console.log(`[${msg.guild.name}] held ${msg.author.tag} (${msg.author.id}) for review`);
    return;
  }

  // --- armed mode: ban now ---
  // log first, so we keep the ID even if the ban call fails
  logBan({ id: msg.author.id, tag: msg.author.tag, guildId: msg.guildId, channel: msg.channel.name, at: new Date().toISOString() });

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
    components: banned ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mh_unban_${msg.author.id}`).setLabel(t('log.undoBtn', cfg.locale)).setStyle(ButtonStyle.Danger),
    )] : [],
  }, 'critical');
});

// ---------- cross-server ban sharing (opt-in) ----------

client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = getGuild(member.guild.id);
  if (!cfg?.banShare) return; // universal list only applies to opted-in servers
  if (!bannedElsewhere(member.id, member.guild.id)) return;
  let banned = false;
  try {
    await member.ban({ reason: 'MadHoney: on the universal ban list (caught by another server\'s honeypot)' });
    logBan({ id: member.id, tag: member.user.tag, guildId: member.guild.id, channel: '(ban-share)', at: new Date().toISOString() });
    banned = true;
    console.log(`[${member.guild.name}] ban-share banned ${member.user.tag} (${member.id})`);
  } catch (err) {
    console.error(`[${member.guild.name}] ban-share FAILED for ${member.id}:`, err.message);
  }
  if (!banned) return;
  await logSend(member.guild, cfg, {
    content: [
      t('log.banshareReport', cfg.locale),
      t('log.user', cfg.locale, { tag: member.user.tag, id: member.id }),
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mh_unban_${member.id}`).setLabel(t('log.undoBtn', cfg.locale)).setStyle(ButtonStyle.Danger),
    )],
  }, 'critical');
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
  // Minimum viable: Manage Roles (verified role + channel overwrites), Manage
  // Channels, Ban Members, View Channels, Send Messages, Attach Files, Read
  // Message History. If gating a specific channel fails with Missing Access,
  // the bot can't see it - grant the MadHoney role View there (or temporarily
  // give it Administrator, gate, then remove).
  console.log(`Invite: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot+applications.commands&permissions=268536852`);
  if (process.env.CLIENT_ID) {
    startDashboard(client);
    if (!process.env.CLIENT_SECRET) console.log('Dashboard up in landing-only mode - set CLIENT_SECRET in .env to enable login.');
  } else console.log('Dashboard disabled (set CLIENT_ID in .env to enable).');
});

client.login(process.env.DISCORD_TOKEN);
