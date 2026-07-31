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
MadHoney there. What the bot does in your server, it does on your
instruction: bans, kicks and quarantines issued through the honeypot or
automated spam / compromised-account detection, channel gating, and role
changes are your moderation decisions, and the Undo button exists for a
reason. Automatic safeguards - raid mode downgrading a burst to a kick, or a
health check refusing to run something unsafe - reduce the damage a
misconfiguration can do, but they do not make the configuration ours. Review
what your server catches. You are responsible for complying with
<a href="https://discord.com/terms" target="_blank" rel="noopener">Discord's Terms of Service</a> and
Community Guidelines.</p>
<p>If your community includes members who rely on text-to-speech or screen
readers, you must disclose the honeypot channel in your server rules. A
honeypot is a visual trap; do not deploy one where it can catch people who
cannot see the warning.</p>

<h2>The universal ban list</h2>
<p>Every honeypot ban is recorded on a universal ban list (Discord user IDs).
Whether that list <i>applies to your server</i> is your choice and off by
default: opt in and users on the list are banned when they join (or all at
once with Ban from List); stay opted out and your server acts only on its
own honeypot catches, which remain yours either way. Unbanning a user
through the log channel removes them from the list's effect.</p>

<h2>Fair use</h2>
<p>Don't abuse the service: no attempting to overload the bot or dashboard,
no using the shared ban pool to target people who were never spamming, no
scraping. We can remove a server from the hosted service if it's being used
to harass people.</p>

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
<p>Three tables, and that's the whole database:</p>
<p><b>Server configuration</b> - for each server: the chosen role and channel
IDs, your verify message, banner design settings, your per-channel gating
choices, whether ban sharing is on, and your compromised-account and raid-mode
settings. So that your own staff can see who changed what, we also record the
Discord ID, username and timestamp of the dashboard user who first set the
server up and of whoever last changed a setting.</p>
<p><b>Ban log</b> - when MadHoney acts on an account (or an admin undoes it):
the Discord user ID, username, server ID, channel name, and timestamp. Kicks
and quarantines are recorded here too, not only bans. Each entry also carries
an incident ID, so the several messages of one spam blast are grouped as one
event rather than looking like several offenders; a count of how many times
that account has been caught in that server; and flags noting whether the entry
was held back from the shared ban list or happened during a detected burst.
Ban entries are what powers the log channel, the dashboard's ban list, and
(only for opted-in servers) cross-server ban sharing.</p>
<p><b>Appeals</b> - if a server turns appeals on: that a given user appealed a
given ban, and when. Not the text of the appeal.</p>

<h2>Where it lives</h2>
<p>The database is <b>Cloudflare D1</b>, so Cloudflare stores the above on our
behalf and <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">their privacy policy</a>
covers that. The bot keeps a mirror copy on its own machine so it can keep
working if D1 is unreachable. Nothing goes anywhere else - there is no
third-party analytics, logging or moderation service in the path.</p>

<h2>Message content</h2>
<p>The spam trap fires on <i>where</i> a message is posted - a decoy honeypot
channel - not on what it says. Beyond that, we process message content for two
narrow moderation purposes: when the honeypot catches a spam account, the
offending message's text and any image are included in the ban report sent to
your server's private moderator-log channel, so your moderators can see what
was posted; and to catch compromised (hijacked) accounts, the bot compares a
member's own messages across channels to flag near-identical messages posted at
superhuman speed - within about a second - for moderator review. This happens in
the moment: message content is never written to our database (the ban log stores
only IDs, usernames, timestamps and channel names, never message text), never
stored off Discord, and never used to train any model.</p>

<h2>What we don't do</h2>
<p>No analytics, no tracking pixels, no advertising, and we don't sell or share
data with anyone. The captcha is generated by the bot itself; no third-party
captcha service ever sees your members.</p>

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
user ID) lands on the universal ban list. Servers that opted in to the list
may ban you when you join them. An admin unbanning you removes that effect
everywhere.</p>
<p>Two things deliberately keep entries <i>off</i> that list. If a server's
honeypot fires many times in a few minutes, MadHoney treats the burst as
unexplained: it kicks rather than bans, and adds nobody to the shared list
until one of that server's moderators confirms it - so a single
misconfigured server cannot ban you everywhere. Servers that have not
finished setting up don't contribute to the list at all. If you believe
you're on the list wrongly, ask the server that banned you to undo it, or
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
