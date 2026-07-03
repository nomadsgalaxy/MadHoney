// MadHoney - honeypot + captcha verification for any Discord server.
// One process: the bot, plus (if CLIENT_ID/CLIENT_SECRET are set) the web
// dashboard. Per-guild config lives in guilds.json; bans in bans.jsonl.
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Events, PermissionFlagsBits, PermissionsBitField, MessageFlags,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
} from 'discord.js';
import { shouldTrap } from './trap.js';
import { makeCode, answerOk } from './verify.js';
import { renderCaptcha } from './captcha.js';
import { renderBanner, DEFAULT_BANNER, FONTS } from './banner.js';
import { getGuild, saveGuild, logBan, bans, bannedElsewhere } from './store.js';
import { postVerifyPanel, postBanner, gateChannels, grandfather, roleColorMap, DEFAULT_VERIFY_TEXT } from './actions.js';
import { startDashboard } from './dashboard.js';

const EPH = { flags: MessageFlags.Ephemeral };
const pending = new Map(); // userId -> expected captcha answer (in-memory; users just re-click after a restart)

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
    .addStringOption((o) => o.setName('title').setDescription('Headline (default: DO NOT POST IN THIS CHANNEL)'))
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
      .addChoices({ name: 'shared', value: 'shared' }, { name: 'isolated', value: 'isolated' })));

// ---------- setup panel ----------

function setupContent(guild) {
  const cfg = getGuild(guild.id) ?? {};
  const v = (id) => (id ? `<#${id}>` : '*not set*');
  return [
    '## MadHoney setup',
    `**Verified role:** ${cfg.verifiedRoleId ? `<@&${cfg.verifiedRoleId}>` : '*not set*'} - pick an existing role, or create one first (Server Settings → Roles, e.g. "Verified").`,
    `**Verify channel:** ${v(cfg.verifyChannelId)} - where the Verify button lives. Your **#rules** channel is the classic spot.`,
    `**Honeypot channel:** ${v(cfg.honeypotChannelId)} - create a decoy channel bots will post in. Name it like a real channel: \`general-2\`, \`general2\`, \`chat-2\`. Anyone who posts there is banned.`,
    `**Staff role (optional):** ${cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : '*not set*'} - members with it are never trapped (admins with **Manage Server** and the owner are always exempt). Set it under **Staff & log**.`,
    `**Log channel (optional):** ${v(cfg.logChannelId)} - every honeypot ban is reported there with an **Unban** button. Set it under **Staff & log**.`,
    `**Ban sharing:** ${cfg.banShare ? 'shared 🌐' : 'isolated 🔒'} (change with \`/madhoney banshare\`)`,
    '',
    '⚠️ If you use Discord **Onboarding**, make sure it does NOT auto-grant the verified role, or the captcha is bypassable.',
    '♿ Honeypots are visual traps - not recommended for servers serving visually impaired communities. At minimum, name the honeypot in your rules so text-to-speech users hear the warning.',
    'When all three are set, run **/madhoney deploy**.',
  ].join('\n');
}

function setupComponents(cfg = {}) {
  const role = new RoleSelectMenuBuilder().setCustomId('mh_role').setPlaceholder('Verified role…');
  if (cfg.verifiedRoleId) role.setDefaultRoles(cfg.verifiedRoleId);
  const verifyCh = new ChannelSelectMenuBuilder().setCustomId('mh_verifych').setPlaceholder('Verify channel (suggest: #rules)…').setChannelTypes(ChannelType.GuildText);
  if (cfg.verifyChannelId) verifyCh.setDefaultChannels(cfg.verifyChannelId);
  const honeyCh = new ChannelSelectMenuBuilder().setCustomId('mh_honeych').setPlaceholder('Honeypot channel (e.g. #general-2)…').setChannelTypes(ChannelType.GuildText);
  if (cfg.honeypotChannelId) honeyCh.setDefaultChannels(cfg.honeypotChannelId);
  return [
    new ActionRowBuilder().addComponents(role),
    new ActionRowBuilder().addComponents(verifyCh),
    new ActionRowBuilder().addComponents(honeyCh),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mh_text').setLabel('Edit verify message').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_more').setLabel('Staff & log').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_deploy_open').setLabel('Deploy →').setStyle(ButtonStyle.Primary),
    ),
  ];
}

// Sub-panel: staff exemption role + ban-report log channel (Discord caps a
// message at 5 component rows, so these live behind the "Staff & log" button).
function morePanel(guild) {
  const cfg = getGuild(guild.id) ?? {};
  const staff = new RoleSelectMenuBuilder().setCustomId('mh_staffrole').setPlaceholder('Staff role - never trapped (optional)…');
  if (cfg.staffRoleId) staff.setDefaultRoles(cfg.staffRoleId);
  const logCh = new ChannelSelectMenuBuilder().setCustomId('mh_logch').setPlaceholder('Log channel for ban reports (optional)…').setChannelTypes(ChannelType.GuildText);
  if (cfg.logChannelId) logCh.setDefaultChannels(cfg.logChannelId);
  return {
    content: [
      '## Staff & log',
      `**Staff role:** ${cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : '*not set*'} - anyone with this role can post in the honeypot without being banned. The owner and anyone with **Manage Server** are always exempt; set this for mods who don't have that permission.`,
      `**Log channel:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*not set*'} - a staff-only channel; every honeypot ban is reported there with an **Unban** button in case someone trips it by accident.`,
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(staff), new ActionRowBuilder().addComponents(logCh)],
    ...EPH,
  };
}

function deployPanel(guild) {
  const cfg = getGuild(guild.id) ?? {};
  const ready = cfg.verifiedRoleId && cfg.verifyChannelId && cfg.honeypotChannelId;
  return {
    content: ready
      ? ['## Deploy MadHoney', 'Recommended order:',
        '1. **Grandfather members** - give everyone already here the verified role',
        '2. **Post Verify panel** - the button + captcha, in your verify channel',
        '3. **Post honeypot banner** - the warning image (design it with `/madhoney banner`)',
        '4. **Gate channels (dry run)** - preview, then **APPLY**'].join('\n')
      : '⚠️ Setup incomplete - run `/madhoney setup` first.',
    components: ready ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mh_grandfather').setLabel('1 Grandfather members').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_post_verify').setLabel('2 Post Verify panel').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mh_post_banner').setLabel('3 Post honeypot banner').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mh_gate_dry').setLabel('4 Gate (dry run)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mh_gate_apply').setLabel('4 Gate APPLY').setStyle(ButtonStyle.Danger),
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
      if (role && i.member.roles.cache.has(role.id)) return i.reply({ content: "You're already verified ✅", ...EPH });
      const code = makeCode();
      pending.set(i.user.id, code);
      const img = new AttachmentBuilder(renderCaptcha(code), { name: 'captcha.png' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('verify_open').setLabel('Enter code').setStyle(ButtonStyle.Success),
      );
      return i.reply({ content: 'Type the characters shown below (not case-sensitive). New image each try.', files: [img], components: [row], ...EPH });
    }
    if (i.isButton() && i.customId === 'verify_open') {
      const modal = new ModalBuilder().setCustomId('verify_answer').setTitle('Human check');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ans').setLabel('Code shown in the image').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(8),
      ));
      return i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'verify_answer') {
      const expected = pending.get(i.user.id);
      if (expected && answerOk(i.fields.getTextInputValue('ans'), expected)) {
        pending.delete(i.user.id);
        const cfg = getGuild(i.guildId) ?? {};
        const role = cfg.verifiedRoleId && (await i.guild.roles.fetch(cfg.verifiedRoleId).catch(() => null));
        if (!role) return i.reply({ content: 'Passed - but the verified role is missing. Ping a mod.', ...EPH });
        await i.member.roles.add(role, 'MadHoney: passed verification');
        return i.reply({ content: `Verified ✅ Welcome to ${i.guild.name}.`, ...EPH });
      }
      return i.reply({ content: "That's not right - hit Verify and try again.", ...EPH });
    }

    // --- everything below is admin-only ---
    if (!i.inGuild()) return;
    const admin = i.isChatInputCommand() || i.customId?.startsWith('mh_');
    if (admin && !isManager(i)) {
      if (i.isRepliable()) return i.reply({ content: 'You need **Manage Server** to use MadHoney controls.', ...EPH });
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
        return i.reply({ content: setupContent(i.guild) + `\n\n**Bans logged here:** ${mine} · **shared pool:** ${bans().length}`, ...EPH });
      }
      if (sub === 'banshare') {
        const shared = i.options.getString('mode') === 'shared';
        saveGuild(i.guildId, { banShare: shared });
        return i.reply({
          content: shared
            ? '🌐 **Ban sharing ON** - users banned by other sharing MadHoney servers are auto-banned when they join here (and your honeypot bans protect them).'
            : '🔒 **Isolated** - this server only acts on its own honeypot.',
          ...EPH,
        });
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
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('mh_post_banner').setLabel('Post to honeypot channel').setStyle(ButtonStyle.Primary),
        );
        return i.editReply({
          content: 'Banner preview - saved. Tweak with `/madhoney banner`, or post it:',
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
        return i.update({ content: setupContent(i.guild) + '\n\n❌ Verify and honeypot must be **different** channels.', components: setupComponents(cfg) });
      }
      saveGuild(i.guildId, { [key]: i.values[0] });
      return i.update({ content: setupContent(i.guild), components: setupComponents(getGuild(i.guildId)) });
    }

    // Unban button on a log-channel ban report
    if (i.isButton() && i.customId.startsWith('mh_unban_')) {
      const userId = i.customId.slice('mh_unban_'.length);
      try {
        await i.guild.bans.remove(userId, `MadHoney: unbanned by ${i.user.tag} via log channel`);
      } catch (e) {
        return i.reply({ content: `Unban failed: ${e.message}`, ...EPH });
      }
      // reversal entry so ban-sharing servers stop acting on this ban
      logBan({ id: userId, guildId: i.guildId, channel: '(unban)', at: new Date().toISOString(), unbanned: true });
      return i.update({
        content: i.message.content + `\n✅ **Unbanned** by ${i.user} - they can rejoin (send them a fresh invite; ban-share won't re-ban them).`,
        components: [],
      });
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
    };
    if (i.isButton() && (deployActions[i.customId] || i.customId === 'mh_grandfather')) {
      const cfg = getGuild(i.guildId);
      if (!cfg?.verifiedRoleId || !cfg?.verifyChannelId || !cfg?.honeypotChannelId) {
        return i.reply({ content: 'Setup incomplete - run `/madhoney setup` first.', ...EPH });
      }
      await i.deferReply(EPH);
      if (i.customId === 'mh_grandfather') {
        // one API call per member - stream progress into the ephemeral reply
        const progress = {};
        const job = grandfather(i.guild, cfg, progress).catch((e) => `❌ ${e.message}`);
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
      const result = await deployActions[i.customId](i.guild, cfg).catch((e) => `❌ ${e.message}`);
      return i.editReply({ content: result.slice(0, 1900) });
    }
  } catch (err) {
    console.error('interaction error:', err);
    if (i.isRepliable() && !i.replied && !i.deferred) i.reply({ content: 'Something broke - try again.', ...EPH }).catch(() => {});
  }
});

// ---------- honeypot ----------

client.on(Events.MessageCreate, async (msg) => {
  if (!msg.inGuild()) return;
  const cfg = getGuild(msg.guildId);
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

  // log first, so we keep the ID even if the ban call fails
  logBan({ id: msg.author.id, tag: msg.author.tag, guildId: msg.guildId, channel: msg.channel.name, at: new Date().toISOString() });
  let banned = false;
  try {
    await msg.guild.bans.create(msg.author.id, {
      reason: `MadHoney honeypot: posted in #${msg.channel.name}`,
      deleteMessageSeconds: 7 * 24 * 60 * 60, // also wipes their last week of messages
    });
    banned = true;
    console.log(`[${msg.guild.name}] banned ${msg.author.tag} (${msg.author.id})`);
  } catch (err) {
    console.error(`[${msg.guild.name}] ban FAILED for ${msg.author.id} (logged anyway):`, err.message);
  }

  // Report to the log channel (if configured) with an Unban escape hatch.
  if (!cfg.logChannelId) return;
  try {
    const log = await msg.guild.channels.fetch(cfg.logChannelId);
    const quoted = spamText
      ? spamText.slice(0, 1000).split('\n').map((l) => `> ${l}`).join('\n')
      : '> *(message content unavailable - enable the Message Content intent and set `MESSAGE_CONTENT=on` to capture it)*';
    await log.send({
      content: [
        `🍯 **The following message was posted in the honeypot** (<#${cfg.honeypotChannelId}>) **and the user has been ${banned ? 'banned' : '⚠️ NOT banned (ban failed - check my permissions)'}.**`,
        `**User:** ${msg.author.tag} (\`${msg.author.id}\`)`,
        quoted,
        attachments ? `📎 ${attachments}` : null,
      ].filter(Boolean).join('\n'),
      components: banned ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mh_unban_${msg.author.id}`).setLabel('Undo - unban this user').setStyle(ButtonStyle.Danger),
      )] : [],
    });
  } catch (err) {
    console.error(`[${msg.guild.name}] log-channel report failed:`, err.message);
  }
});

// ---------- cross-server ban sharing (opt-in) ----------

client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = getGuild(member.guild.id);
  if (!cfg?.banShare) return;
  if (!bannedElsewhere(member.id, member.guild.id)) return;
  try {
    await member.ban({ reason: 'MadHoney: banned by another server in the shared honeypot pool' });
    logBan({ id: member.id, tag: member.user.tag, guildId: member.guild.id, channel: '(ban-share)', at: new Date().toISOString() });
    console.log(`[${member.guild.name}] ban-share banned ${member.user.tag} (${member.id})`);
  } catch (err) {
    console.error(`[${member.guild.name}] ban-share FAILED for ${member.id}:`, err.message);
  }
});

// ---------- boot ----------

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([command]);
  console.log(`MadHoney armed as ${c.user.tag} in ${c.guilds.cache.size} guild(s). /madhoney setup to begin.`);
  // Minimum viable: Manage Roles (verified role + channel overwrites), Ban
  // Members, View Channels, Send Messages, Attach Files, Read Message History.
  // If gating a specific channel fails, that channel denies the bot access -
  // grant it View/Send there (or gate it by hand).
  console.log(`Invite: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot+applications.commands&permissions=268536836`);
  if (process.env.CLIENT_ID) {
    startDashboard(client);
    if (!process.env.CLIENT_SECRET) console.log('Dashboard up in landing-only mode - set CLIENT_SECRET in .env to enable login.');
  } else console.log('Dashboard disabled (set CLIENT_ID in .env to enable).');
});

client.login(process.env.DISCORD_TOKEN);
