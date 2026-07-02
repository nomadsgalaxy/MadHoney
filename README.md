# 🍯 MadHoney

Honeypot + captcha verification for Discord servers. Two traps, one bot:

1. **Verification gate.** New members click Verify, read an image captcha,
   and get the verified role. Everything worth seeing is hidden until they do.
2. **Honeypot.** A decoy channel only unverified accounts can see. Spam bots
   blast every channel they can post in, so they hit the honeypot first and
   get banned on the spot, recent messages deleted. Humans never see the
   channel once verified.

Also in the box: a designable warning banner for the honeypot, a mod-log with
an undo button, optional cross-server ban sharing, a web dashboard, and a
setup wizard that runs entirely inside Discord. Source-available under
OCL v1.1 + SWAtt.

## Add MadHoney to your server (hosted)

1. Invite the bot from https://madhoney.nomadsgalaxy.com and grant the
   requested permissions.
2. If you don't have them yet, create a **verified role** (e.g. `Verified`)
   and a **honeypot channel** (naming tips below). MadHoney's own role must
   sit *above* the verified role in Server Settings → Roles.
3. Run `/madhoney setup`. Pick the verified role, the verify channel (your
   `#rules` channel is the classic spot), and the honeypot. Under **Staff &
   log** you can also pick a staff role (never trapped; the owner and anyone
   with Manage Server are always exempt) and a log channel where each ban is
   reported with an Undo button.
4. Optionally design the warning image with `/madhoney banner` (title, text,
   colors, font, your logo).
5. Run `/madhoney deploy` and click through in order: grandfather existing
   members, post the Verify panel, post the banner, then gate the channels.
   Gating has a dry run; nothing changes until you hit APPLY.
6. Optionally `/madhoney banshare mode:shared` to auto-ban users on join if
   another sharing MadHoney server already caught them. Default is isolated.

Everything above can also be done from the dashboard at
https://madhoney.nomadsgalaxy.com. Log in with Discord; any server where you
have Manage Server shows up.

**Onboarding gotcha:** if your server uses Discord Onboarding, make sure it
does not auto-grant the verified role. Otherwise the captcha is a decoration.

### Naming the honeypot channel

The trap works because bots can't tell it from a real channel. Good names:
`general-2`, `general2`, `chat-2`, `off-topic-2`. Bad names: `honeypot`,
`do-not-post`, `bot-trap` (some spam tooling skips those). Pin the warning
banner in it so no human has an excuse, and let the gate step hide it from
verified members so real people rarely see it at all.

## Slash commands

| Command | What it does |
|---|---|
| `/madhoney setup` | Pick roles and channels, edit the verify message |
| `/madhoney deploy` | Grandfather, post panels, gate channels |
| `/madhoney banner` | Design the honeypot warning image |
| `/madhoney banshare` | `shared` or `isolated` |
| `/madhoney status` | Current config and ban counts |

All admin commands require Manage Server.

## Self-hosting

You need Node 18+ and a Discord application (https://discord.com/developers).

```bash
git clone https://github.com/nomadsgalaxy/MadHoney /opt/madhoney
cd /opt/madhoney
npm ci
cp .env.example .env && nano .env    # token, plus CLIENT_ID/SECRET for the dashboard
npm test
npm start
```

Dev Portal checklist:

- Bot → Privileged Gateway Intents: enable **Server Members**. It's required
  for grandfathering and ban-share. Enable **Message Content** only if you
  want the spam text copied into log reports (then set `MESSAGE_CONTENT=on`).
- OAuth2 → Redirects: add `https://your-dashboard-domain/callback` if you run
  the dashboard.
- Invite the bot with the URL it prints on startup. The URL asks for
  Administrator: gating edits permission overwrites on every channel, and
  Discord only lets a bot set overwrites for permissions it already holds in
  that specific channel, so granular grants fail on channels with custom
  overwrites (a #rules channel usually has them).

### Run it 24/7 (systemd)

```bash
sudo useradd -r -m -d /opt/madhoney -s /usr/sbin/nologin madhoney
sudo chown -R madhoney:madhoney /opt/madhoney && sudo chmod 600 /opt/madhoney/.env
sudo cp madhoney.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now madhoney
journalctl -u madhoney -f
```

### Dashboard hosting

The dashboard binds `127.0.0.1:$PORT`. Put a reverse proxy or Cloudflare
tunnel in front, set `PUBLIC_URL` to the public https URL, and add
`PUBLIC_URL/callback` to the OAuth2 redirects.

## Data & privacy

State is two files: `guilds.json` (per-server config) and `bans.jsonl`
(append-only ban log: user id, tag, guild id, timestamp). The bot does not
read message content unless you opt in with `MESSAGE_CONTENT=on`; the trap
fires on *where* a message was posted, not what it says.

Ban sharing is opt-in per server, both directions. Only sharing servers
contribute bans and only sharing servers act on them. An Undo from the log
channel also removes the user from the shared pool.

## License

OCL v1.1 + SWAtt v1, see [LICENSE.md](LICENSE.md). Built by Nomads Galaxy.
Derivatives must keep the attribution ("built on MadHoney by Nomads Galaxy").
