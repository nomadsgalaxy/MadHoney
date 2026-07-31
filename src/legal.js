// Terms of Service and Privacy Policy page bodies, rendered by dashboard.js
// inside the shared layout. Plain HTML strings, updated by hand.
// If you change what the bot stores, update the Privacy section to match.

export const TERMS = `
<h1><img src="/logo.svg?v=3" alt="">Terms of <span>Service</span></h1>
<p><a href="/">← home</a></p>
<div class="card">
<p><small>Effective 2026-07-31. MadHoney is operated by <a href="https://nomadsgalaxy.com" target="_blank" rel="noopener">Nomads Galaxy</a> ("we").
"The service" means the hosted MadHoney Discord bot and the dashboard at
madhoney.nomadsgalaxy.com.</small></p>

<h2>The service</h2>
<p>MadHoney is a honeypot and verification bot for Discord. It is free and
provided as-is, with no warranty and no uptime guarantee. We can change or
discontinue it at any time; you can remove the bot from your server at any
time.</p>

<h2>Your responsibilities</h2>
<p>You need the Manage Server permission in a Discord server to configure
MadHoney there. You control MadHoney's configuration in your server. This
configuration controls bans, kicks, quarantines, honeypot actions,
compromised-account detection, channel gating, and role changes. These are
your moderation decisions. Review the moderation actions regularly. Use the
Undo button to reverse an incorrect action.</p>
<p>MadHoney includes automatic safeguards. During raid mode, it changes a
burst of bans to kicks. The health check refuses to mass-assign the verified
role when your configuration would make that unsafe; it reports other problems
in the dashboard but does not block them. These safeguards reduce the effects
of a configuration error, but you remain responsible for your configuration.
You are also responsible for complying with
<a href="https://discord.com/terms" target="_blank" rel="noopener">Discord's Terms of Service</a> and
Community Guidelines.</p>
<p>If your community includes members who rely on text-to-speech or screen
readers, you must disclose the honeypot channel in your server rules. A
honeypot is a visual trap; do not deploy one where it can catch people who
cannot see the warning.</p>

<h2>The universal ban list</h2>
<p>A honeypot ban is normally added to a universal ban list (Discord user IDs).
There are two exceptions: MadHoney withholds a burst of catches until one of
your moderators confirms it, and a server that has not finished setup does not
contribute to the list at all.</p>
<p>Whether the list <i>applies to</i> your server is a separate choice, and it
is off by default. If you opt in, MadHoney bans listed users when they join
your server. You can also use Ban from List to ban all listed users at once.
If you stay opted out, MadHoney acts only on your server's own honeypot
catches. Unbanning a user through the log channel stops the list from applying
to that user on every server; the log keeps both the original entry and the
unban, so the record stays auditable.</p>

<h2>Fair use</h2>
<p>Do not attempt to overload the bot or dashboard. Do not use the universal
ban list to target people who were not spamming. Do not scrape the service.
We can remove a server from the hosted service if its members use MadHoney to
harass people.</p>

<h2>Self-hosting</h2>
<p>The source is available at
<a href="https://github.com/nomadsgalaxy/MadHoney" target="_blank" rel="noopener">github.com/nomadsgalaxy/MadHoney</a>
under OCL v1.1 + SWAtt v1, plus the MadHoney Commercial License (MCL v1).
Commercial use is allowed as long as the software stays free to use for
everyone &mdash; no fees, subscriptions, or paywalls on it or any of its
features &mdash; and you don't resell it without permission. Self-hosted
instances are your own; these terms cover only the hosted service.</p>

<h2>Liability</h2>
<p>To the maximum extent permitted by law, we are not liable for any damages
arising from use of the service, including missed spam, wrongful bans issued
by your configuration, or downtime. The service's total liability is limited
to the amount you paid for it, which is zero.</p>

<h2>Changes</h2>
<p>We may update these terms; the effective date above changes when we do.
Continued use after a change means you accept it. Questions or problems:
<a href="https://github.com/nomadsgalaxy/MadHoney/issues" target="_blank" rel="noopener">open a GitHub issue</a>.</p>
</div>`;

export const PRIVACY = `
<h1><img src="/logo.svg?v=3" alt="">Privacy <span>Policy</span></h1>
<p><a href="/">← home</a></p>
<div class="card">
<p><small>Effective 2026-07-31. This covers the hosted MadHoney bot and the
dashboard at madhoney.nomadsgalaxy.com, operated by <a href="https://nomadsgalaxy.com" target="_blank" rel="noopener">Nomads Galaxy</a>.</small></p>

<h2>What we store</h2>
<p>The database holds three kinds of record about people:</p>
<p><b>Server configuration</b> - for each server: the chosen role and channel
IDs, your verify message, banner design settings, your per-channel gating
choices, whether ban sharing is on, and your compromised-account and raid-mode
settings. We also record who first configured the server and who last changed
a setting. For each person, we record the Discord ID, username, and timestamp.
Your staff can use this information to see who changed the configuration.</p>
<p><b>Ban log</b> - when MadHoney acts on an account (or an admin undoes it):
the Discord user ID, username, server ID, channel name, and timestamp. Kicks
and quarantines are also recorded. Each entry has an incident ID that groups
the messages from one spam event. It also has the account's catch count for
that server. Flags show whether MadHoney withheld the entry from the universal
ban list or detected it during a burst. Ban entries provide the data for the
log channel and the dashboard's ban list. For opted-in servers, they also
provide the data for cross-server ban sharing.</p>
<p><b>Appeals</b> - if a server turns appeals on: that a given user appealed a
given ban, and when. We do not store the text of the appeal.</p>
<p>The database also holds operational state that is not about people:
dashboard actions queued for the bot to run, and failover status. Neither
contains message content.</p>

<h2>Data storage</h2>
<p>The database is <b>Cloudflare D1</b>, so Cloudflare stores the above on our
behalf and <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">their privacy policy</a>
covers that storage. The bot keeps a mirror copy on its own machine. This copy
lets the bot continue to work if D1 is unavailable. We do not send this data
to a third-party analytics, logging, or moderation service.</p>

<h2>Message content</h2>
<p>The honeypot acts because of <i>where</i> a message is posted, not because of
what the message says. MadHoney processes message content for two moderation
purposes. First, a ban report can include the text and images from the message
that triggered the honeypot. MadHoney sends this report to your private
moderator-log channel so your moderators can review it. Second, MadHoney
compares a member's messages across channels to detect a compromised account.
It flags near-identical messages that the account posts in three or more
channels inside a short window. The default window is five seconds; a server
can set it between one and sixty seconds.</p>
<p>MadHoney processes message content in memory. It does not write message
content to the database. The ban log stores only IDs, usernames, timestamps,
and channel names. MadHoney does not store message content outside Discord and
does not use it to train a model.</p>

<h2>What we don't do</h2>
<p>We do not use analytics, tracking pixels, or advertising. We do not sell or
share data with anyone. The bot generates the captcha. No third-party captcha
service receives information about your members.</p>

<h2>The dashboard</h2>
<p>Logging in uses Discord OAuth with the <b>identify</b> and <b>guilds</b>
scopes: we receive your Discord username, ID, avatar, and your server list
with permission flags, and use them only to show you the servers you can
manage. Sessions live in server memory and disappear on logout or when the
bot restarts. The only cookie is a session ID; there are no tracking
cookies.</p>
<p>The site is served through Cloudflare's edge, which handles TLS and caching,
and loads fonts from Google Fonts.</p>

<h2>The universal ban list and your data</h2>
<p>If a MadHoney honeypot bans you in any server, the record (your Discord
user ID) goes to the universal ban list. Servers that opted in to the list
may ban you when you join them. An admin unbanning you removes that effect
everywhere.</p>
<p>Two things deliberately keep entries <i>off</i> that list. If a server's
honeypot fires many times in a few minutes, MadHoney treats the burst as
unexplained. It kicks the accounts instead of banning them. It does not add
the accounts to the universal ban list until a moderator confirms the
incidents. Thus, one misconfigured server cannot ban you everywhere. Servers
that have not finished setup do not add accounts to the list. If you believe
MadHoney added you to the list in error, ask the server that banned you to
undo the ban, or
<a href="https://github.com/nomadsgalaxy/MadHoney/issues" target="_blank" rel="noopener">open a GitHub issue</a>
and we'll look at the record.</p>

<h2>Retention and deletion</h2>
<p>Server configuration persists so the bot re-arms if it's re-invited;
kicking the bot stops all processing for that server. Ban log entries are
kept so ban sharing and the Undo button keep working. To have your server's
configuration or a specific ban record deleted,
<a href="https://github.com/nomadsgalaxy/MadHoney/issues" target="_blank" rel="noopener">open a GitHub issue</a>
from an account that can prove server ownership.</p>

<h2>Changes</h2>
<p>If what we store ever changes, this page changes with it, along with the
effective date above.</p>
</div>`;
