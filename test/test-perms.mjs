// Regression test for Discord permission resolution — the logic behind the
// stray-verified-role invariant and the category-lockout check. Getting this
// wrong is how an armed honeypot silently catches nothing (Bondtech, 2026-07-30).
// Run: node test/test-perms.mjs
import assert from 'node:assert';
import { resolveChannelPerms } from '../src/actions.js';
import { PermissionFlagsBits as F } from 'discord.js';

const VIEW = F.ViewChannel, SEND = F.SendMessages, ADMIN = F.Administrator;
const has = (p, b) => (p & b) === b;
const ow = (allow, deny) => ({ allow, deny });

// --- base perms pass through untouched ---
assert.ok(has(resolveChannelPerms({ basePerms: VIEW | SEND }), VIEW));
assert.ok(!has(resolveChannelPerms({ basePerms: SEND }), VIEW));

// --- Administrator short-circuits every overwrite, including explicit denies ---
assert.ok(has(resolveChannelPerms({ basePerms: ADMIN, everyoneOverwrite: ow(0n, VIEW) }), VIEW),
  'Administrator ignores a View deny');

// --- @everyone overwrite applies before role overwrites ---
assert.ok(!has(resolveChannelPerms({ basePerms: VIEW, everyoneOverwrite: ow(0n, VIEW) }), VIEW));
assert.ok(has(resolveChannelPerms({ basePerms: 0n, everyoneOverwrite: ow(VIEW, 0n) }), VIEW));

// --- THE BONDTECH CASE: a role deny takes View away from the bot ---
// Honeypot denies View to @Verified; the bot wearing that role inherits the deny
// and goes blind on its own trap.
const wearingVerified = resolveChannelPerms({
  basePerms: VIEW,                       // @everyone can see the honeypot (it is the bait)
  roleOverwrites: [ow(0n, VIEW)],        // @Verified: View denied
});
assert.ok(!has(wearingVerified, VIEW), 'bot wearing the verified role loses sight of the honeypot');
// and dropping the role restores it
const withoutVerified = resolveChannelPerms({ basePerms: VIEW });
assert.ok(has(withoutVerified, VIEW), 'dropping the role restores sight');

// --- role ALLOW beats role DENY (why an explicit bot pin survives the borrow) ---
const pinnedBot = resolveChannelPerms({
  basePerms: VIEW,
  roleOverwrites: [ow(0n, VIEW), ow(VIEW, 0n)],  // verified denies, bot's own role allows
});
assert.ok(has(pinnedBot, VIEW), 'an explicit bot-role allow survives a verified-role deny');

// --- member overwrite wins over everything except Administrator ---
assert.ok(!has(resolveChannelPerms({ basePerms: VIEW, roleOverwrites: [ow(VIEW, 0n)], memberOverwrite: ow(0n, VIEW) }), VIEW),
  'member deny beats role allow');
assert.ok(has(resolveChannelPerms({ basePerms: 0n, roleOverwrites: [ow(0n, VIEW)], memberOverwrite: ow(VIEW, 0n) }), VIEW),
  'member allow beats role deny');

// --- denies from several roles accumulate, then allows are applied ---
assert.ok(has(resolveChannelPerms({ basePerms: 0n, roleOverwrites: [ow(0n, VIEW), ow(0n, SEND), ow(VIEW, 0n)] }), VIEW));
assert.ok(!has(resolveChannelPerms({ basePerms: SEND, roleOverwrites: [ow(0n, SEND)] }), SEND));

// --- a neutral overwrite changes nothing (the empty-overwrite case seen live) ---
assert.ok(has(resolveChannelPerms({ basePerms: VIEW, everyoneOverwrite: ow(0n, 0n) }), VIEW),
  'an all-zero overwrite is a no-op, not a deny');

console.log('ok');
