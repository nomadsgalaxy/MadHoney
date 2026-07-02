// Guild actions shared by the slash commands (bot.js) and the dashboard
// (dashboard.js). Each takes a discord.js Guild + the stored config and
// returns a human-readable result string.
import { PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { renderBanner, DEFAULT_BANNER } from './banner.js';

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
  return `Posted the Verify panel in #${ch.name}.`;
}

// Render the configured banner and post it in the honeypot channel.
export async function postBanner(guild, cfg) {
  const ch = await textChannel(guild, cfg.honeypotChannelId, 'Honeypot');
  const png = await renderBanner(cfg.banner ?? DEFAULT_BANNER);
  try {
    const recent = await ch.messages.fetch({ limit: 50 });
    for (const m of recent.filter((m) => m.author.id === guild.client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  } catch { /* skip cleanup */ }
  await ch.send({ files: [new AttachmentBuilder(png, { name: 'do-not-post.png' })] });
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
export async function grandfather(guild, cfg) {
  const role = await guild.roles.fetch(cfg.verifiedRoleId).catch(() => null);
  if (!role) throw new Error('Verified role not found - re-run setup.');
  const members = await guild.members.fetch();
  let changed = 0, skipped = 0; const failed = [];
  for (const m of members.values()) {
    if (m.user.bot || m.roles.cache.has(role.id)) { skipped++; continue; }
    await m.roles.add(role, 'MadHoney: grandfathered existing member')
      .then(() => changed++)
      .catch((e) => failed.push(`${m.user.tag}: ${e.message}`));
  }
  return `Grandfathered "${role.name}": ${changed} added, ${skipped} skipped.${failed.length ? `\n${failed.length} failed (is the MadHoney role ABOVE "${role.name}"?): ` + failed.slice(0, 5).join(', ') : ''}`;
}
