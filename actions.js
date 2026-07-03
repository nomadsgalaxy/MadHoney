// Guild actions shared by the slash commands (bot.js) and the dashboard
// (dashboard.js). Each takes a discord.js Guild + the stored config and
// returns a human-readable result string.
import { PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { renderBanner, DEFAULT_BANNER } from './banner.js';
import { saveGuild } from './store.js';

// Bump this whenever a code change alters what the posted Verify panel or
// honeypot banner looks like. On the next boot, every configured server's
// posted messages are refreshed automatically (see bot.js ClientReady).
export const ASSETS_VERSION = 2; // v2: "protected by" credit line on the banner

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
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_start').setLabel('Verify').setStyle(ButtonStyle.Success),
  );
  await ch.send({ content: cfg.verifyText || DEFAULT_VERIFY_TEXT, components: [row] });
  saveGuild(guild.id, { verifyPosted: true });
  return `Posted the Verify panel in #${ch.name}.`;
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
  await ch.send({ files: [new AttachmentBuilder(png, { name: 'do-not-post.png' })] });
  saveGuild(guild.id, { bannerPosted: true });
  return `Posted the honeypot banner in #${ch.name}.`;
}

// Gate every currently-public channel behind the verified role.
// Verify channel stays public (it's the gateway); honeypot stays open to
// @everyone but hidden from verified members. Dry run unless apply=true.
export async function gateChannels(guild, cfg, apply = false) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) throw new Error('Verified role not found - re-run setup.');
  const everyone = guild.roles.everyone;
  const channels = await guild.channels.fetch();

  const plan = { gate: [], keep: [], honeypot: [], skip: [] };
  for (const ch of channels.values()) {
    if (!ch) continue;
    const isPublic = ch.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel);
    if (ch.id === cfg.honeypotChannelId) plan.honeypot.push(ch);
    else if (ch.id === cfg.verifyChannelId) plan.keep.push(ch);
    else if (isPublic) plan.gate.push(ch);
    else plan.skip.push(ch);
  }

  const name = (c) => `${c.type === ChannelType.GuildCategory ? '▸' : '#'}${c.name}`;
  const lines = [
    `GATE behind "${role.name}" (${plan.gate.length}): ${plan.gate.map(name).join(', ') || '(none)'}`,
    `STAYS PUBLIC (verify gateway): ${plan.keep.map(name).join(', ') || '(none)'}`,
    `HONEYPOT (open to everyone, hidden from verified): ${plan.honeypot.map(name).join(', ') || '(none)'}`,
    `SKIP already private (${plan.skip.length})`,
  ];
  if (!apply) return `DRY RUN - nothing changed.\n${lines.join('\n')}\nRun "Gate channels (APPLY)" to make it real.`;

  let ok = 0; const failed = [];
  const tryEdit = async (ch, fn) => {
    try { await fn(); ok++; } catch (e) { failed.push(`${name(ch)} (${e.message})`); }
  };
  for (const ch of plan.gate) {
    await tryEdit(ch, async () => {
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: 'MadHoney: gate behind verified' });
      await ch.permissionOverwrites.edit(role, { ViewChannel: true }, { reason: 'MadHoney: gate behind verified' });
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
  return `Gated. ${ok} channels updated, ${failed.length} failed.${failed.length ? '\nFailed: ' + failed.join(', ') : ''}\n${lines.join('\n')}`;
}

// Grandfather: add the verified role to every existing non-bot member so the
// gate doesn't lock out people who were already in the server.
// Needs the privileged Server Members intent.
// Pass a `progress` object to watch it live: {total, done, added, skipped,
// failed} are updated as the loop runs (one Discord API call per member, so
// large servers take a while).
export async function grandfather(guild, cfg, progress = {}) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) throw new Error('Verified role not found - re-run setup.');
  const members = await guild.members.fetch();
  Object.assign(progress, { total: members.size, done: 0, added: 0, skipped: 0, failed: 0 });
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
