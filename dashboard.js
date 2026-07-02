// MadHoney web dashboard - Discord OAuth2 login, per-guild config + actions.
// Runs inside the bot process (started from bot.js when CLIENT_ID/SECRET are set).
// Binds 127.0.0.1 and is meant to sit behind a reverse proxy / Cloudflare tunnel.
// ponytail: in-memory sessions (logout on restart), no rate limiting - add both
// only if this ever serves more than a handful of admins.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PermissionsBitField, ChannelType } from 'discord.js';
import { getGuild, saveGuild, bans } from './store.js';
import { postVerifyPanel, postBanner, gateChannels, grandfather, roleColorMap, DEFAULT_VERIFY_TEXT } from './actions.js';
import { renderBanner, DEFAULT_BANNER, FONTS } from './banner.js';

const PORT = Number(process.env.PORT || 8300);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const API = 'https://discord.com/api/v10';
const WEEK = 7 * 24 * 3600 * 1000;

const sessions = new Map(); // sid -> { user, guilds, at }
const LANDING = readFileSync(new URL('./landing.html', import.meta.url), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/logo.svg?v=2" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--honey:#ffb31a;--bg:#0a0b0d;--card:#12141a;--ink:#f2ede2;--dim:#9a948a;--line:#262b34}
  *{box-sizing:border-box}
  body{font:15px/1.55 "Instrument Sans",system-ui,sans-serif;background:var(--bg);color:var(--ink);max-width:880px;margin:0 auto;padding:1rem}
  body::before{content:"";position:fixed;inset:0;z-index:-1;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='27.7128' height='48' viewBox='0 0 27.7128 48'%3E%3Cpath d='M0 8L13.8564 0l13.8564 8M0 8v16l13.8564 8 13.8564-8M13.8564 32v16' fill='none' stroke='%23ffb31a' stroke-opacity='.045' stroke-width='1.5'/%3E%3C/svg%3E");
    background-size:27.7128px 48px}
  a{color:var(--honey);text-decoration:none} a:hover{text-decoration:underline}
  h1,h2{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;line-height:1.2;letter-spacing:-.02em} h1 span{color:var(--honey)}
  h1 img{height:38px;vertical-align:-8px;margin-right:.4rem}
  h2{font-size:1.15rem}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.2rem 1.4rem;margin:1rem 0}
  label{display:block;margin:.7rem 0;font-weight:600}
  input[type=text],textarea,select{display:block;width:100%;padding:.5rem;margin-top:.2rem;background:#0f1216;color:var(--ink);border:1px solid var(--line);border-radius:7px;font:inherit}
  input[type=text]:focus,textarea:focus,select:focus{outline:none;border-color:var(--honey)}
  input[type=color]{appearance:none;-webkit-appearance:none;width:100%;height:38px;padding:3px;margin-top:.2rem;background:#0f1216;border:1px solid var(--line);border-radius:7px;cursor:pointer}
  input[type=color]::-webkit-color-swatch-wrapper{padding:2px}
  input[type=color]::-webkit-color-swatch{border:none;border-radius:4px}
  input[type=color]:hover{border-color:var(--honey)}
  .colors{display:grid;grid-template-columns:repeat(3,1fr);gap:.9rem}
  .cols2{display:grid;grid-template-columns:2fr 1fr;gap:.9rem}
  @media (max-width:640px){.colors,.cols2{grid-template-columns:1fr}}
  small{display:block;font-weight:400;color:var(--dim)}
  .btn{display:inline-block;padding:.55rem 1.1rem;border:0;border-radius:7px;background:var(--honey);color:#141005;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;margin:.2rem .3rem .2rem 0;transition:transform .12s}
  .btn:hover{transform:translateY(-1px);text-decoration:none}
  .btn.grey{background:#39414c;color:var(--ink)} .btn.red{background:#d64545;color:#fff}
  pre{background:#0f1216;border:1px solid var(--line);padding:.8rem;border-radius:7px;white-space:pre-wrap;overflow-x:auto}
  .stripes{height:12px;border-radius:4px;background:repeating-linear-gradient(-45deg,var(--honey) 0 18px,#111 18px 36px);margin-bottom:1.1rem}
  img.banner{max-width:100%;border-radius:8px;border:1px solid var(--line)}
</style><div class="stripes"></div>${body}
<p><small>Built on <a href="https://github.com/nomadsgalaxy/MadHoney">MadHoney</a> by Nomads Galaxy · OCL v1.1 + SWAtt v1</small></p></html>`;
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
}

function session(req) {
  const s = sessions.get(cookies(req).sid);
  if (!s || Date.now() - s.at > WEEK) return null;
  return s;
}

function canManage(sess, guildId) {
  const g = sess.guilds.find((g) => g.id === guildId);
  return !!g && (g.owner || (BigInt(g.permissions) & PermissionsBitField.Flags.ManageGuild) !== 0n);
}

function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(data)));
  });
}

export function startDashboard(client) {
  // Administrator - see the note in bot.js: channel gating needs it in practice.
  const inviteUrl = () =>
    `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=bot+applications.commands&permissions=8`;

  function guildPage(guild, sess, msg = '') {
    const cfg = getGuild(guild.id) ?? {};
    const b = { ...DEFAULT_BANNER, ...cfg.banner };
    const roles = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id)
      .sort((a, z) => z.position - a.position);
    const chans = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText)
      .sort((a, z) => a.rawPosition - z.rawPosition);
    const roleOpts = (sel) => ['<option value="">(none)</option>', ...roles.map((r) =>
      `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`)].join('');
    const chanOpts = (sel) => ['<option value="">(none)</option>', ...chans.map((c) =>
      `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>#${esc(c.name)}</option>`)].join('');
    const recent = bans(guild.id).slice(-15).reverse()
      .map((x) => `${x.at}  ${x.unbanned ? 'UNBAN' : 'ban  '}  ${esc(x.tag ?? x.id)}  ${esc(x.channel ?? '')}`).join('\n') || '(none yet)';
    return layout(`MadHoney - ${guild.name}`, `
<h1><img src="/logo.svg?v=2" alt="MadHoney"><span>${esc(guild.name)}</span></h1>
<p><a href="/">← servers</a></p>
${msg ? `<div class="card"><pre>${esc(msg)}</pre></div>` : ''}
<div class="card"><h2>Configuration</h2>
<form method="post" action="/g/${guild.id}/save">
  <label>Verified role <select name="verifiedRoleId">${roleOpts(cfg.verifiedRoleId)}</select>
    <small>Granted after the captcha. Create one in Discord first if needed (e.g. "Verified"). MadHoney's own role must sit ABOVE it.</small></label>
  <label>Verify channel <select name="verifyChannelId">${chanOpts(cfg.verifyChannelId)}</select>
    <small>Where the Verify button lives - your #rules channel is the classic spot. Stays visible to everyone.</small></label>
  <label>Honeypot channel <select name="honeypotChannelId">${chanOpts(cfg.honeypotChannelId)}</select>
    <small>The trap. Name it like a real channel (general-2, chat-2). Posting here = instant ban.</small></label>
  <label>Staff role (optional) <select name="staffRoleId">${roleOpts(cfg.staffRoleId)}</select>
    <small>Members with this role are never trapped by the honeypot. The owner and anyone with Manage Server are always exempt - set this for mods who don't have that permission.</small></label>
  <label>Log channel (optional) <select name="logChannelId">${chanOpts(cfg.logChannelId)}</select>
    <small>Staff-only channel - each honeypot ban is reported there with an Unban button.</small></label>
  <label>Verify message <textarea name="verifyText" rows="4">${esc(cfg.verifyText || DEFAULT_VERIFY_TEXT)}</textarea></label>
  <label><input type="checkbox" name="banShare" ${cfg.banShare ? 'checked' : ''} style="width:auto;display:inline"> Share bans with other MadHoney servers
    <small>ON: users banned by other sharing servers are auto-banned when they join yours. OFF: fully isolated.</small></label>
  <button class="btn">Save</button>
</form></div>
<div class="card"><h2>Honeypot banner</h2>
<small>Live preview - it re-renders as you tweak. Save, then post it from Actions below.</small>
<img class="banner" id="bannerPreview" src="/g/${guild.id}/banner.png?${Date.now()}" alt="banner preview" style="margin-top:.6rem">
<form method="post" action="/g/${guild.id}/save" id="bannerForm">
  <label>Headline <input type="text" name="banner_title" value="${esc(b.title)}"></label>
  <label>Body <textarea name="banner_text" rows="2">${esc(b.text)}</textarea></label>
  <div class="colors">
    <label>Accent (stripes + headline) <input type="color" name="banner_accent" value="${esc(b.accent)}"></label>
    <label>Text <input type="color" name="banner_color" value="${esc(b.color)}"></label>
    <label>Background <input type="color" name="banner_bg" value="${esc(b.bg)}"></label>
  </div>
  <div class="colors">
    <label>Mention highlight <input type="color" name="banner_mentionColor" value="${esc(b.mentionColor)}">
      <small>Anything written as #channel or @role gets a pill in this color.</small></label>
    <label>@role coloring <select name="banner_mentionMode">
      <option value="custom" ${b.mentionMode !== 'role' ? 'selected' : ''}>custom color (above)</option>
      <option value="role" ${b.mentionMode === 'role' ? 'selected' : ''}>real role colors</option>
    </select>
      <small>"Real role colors" pulls each @role's color from Discord; #channels and colorless roles use the custom color.</small></label>
  </div>
  <div class="cols2">
    <label>Logo <input type="text" name="banner_logoUrl" value="${esc(b.logoUrl)}" placeholder="empty = MadHoney logo">
      <small>Direct PNG/JPG URL for your own logo, or type <b>none</b> for no logo.</small></label>
    <label>Font <select name="banner_font">${FONTS.map((f) => `<option ${f === b.font ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
  </div>
  <button class="btn">Save banner</button>
</form>
<script>
(() => {
  const form = document.getElementById('bannerForm'), img = document.getElementById('bannerPreview');
  let t;
  form.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const p = new URLSearchParams(new FormData(form));
      img.src = '/g/${guild.id}/banner.png?' + p.toString();
    }, 250);
  });
})();
</script></div>
<div class="card"><h2>Actions</h2>
<small>Run in order 1 → 4 on first deploy. Each one is safe to re-run later.</small>
<form method="post" action="/g/${guild.id}/action">
${[
  ['grandfather', 'grey', '1 · Grandfather members',
    'Gives the verified role to every human already in the server, so gating never locks out existing members. Bots are skipped, members who already have the role are skipped. Needs MadHoney’s role positioned ABOVE the verified role.'],
  ['post_verify', '', '2 · Post Verify panel',
    'Posts the Verify button (with your verify message) in the verify channel. New members click it, read a captcha image, type the code, and receive the verified role. Old MadHoney panels in that channel are cleaned up first.'],
  ['post_banner', '', '3 · Post honeypot banner',
    'Posts the warning image designed above into the honeypot channel, so no human has an excuse. Re-run it after changing the banner.'],
  ['gate_dry', 'grey', '4 · Gate channels (dry run)',
    'Prints exactly which channels WOULD be hidden behind the verified role - changes nothing. Always run this first.'],
  ['gate_apply', 'red', '4 · Gate channels (APPLY)',
    'Does it for real: every public channel becomes visible only to verified members; the verify channel stays public (it’s the gateway); the honeypot stays open to unverified accounts but is hidden from verified ones. Already-private staff channels are untouched. Undo by editing channel permissions in Discord.'],
].map(([val, cls, label, desc]) =>
  `<p style="margin:.8rem 0 .2rem"><button class="btn ${cls}" name="do" value="${val}">${label}</button><small>${desc}</small></p>`).join('')}
</form></div>
<div class="card"><h2>Recent bans</h2><pre>${recent}</pre></div>`);
  }

  const server = createServer(async (req, res) => {
    const html = (s, code = 200, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(s); };
    const redirect = (to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
    const url = new URL(req.url, PUBLIC_URL);

    try {
      // ---- auth ----
      if (url.pathname === '/login') {
        if (!process.env.CLIENT_SECRET) {
          return html(layout('MadHoney', '<h1>Login not configured yet</h1><p>The bot owner hasn\'t set the OAuth client secret. You can still <a href="' + inviteUrl() + '">add MadHoney to your server</a> and run <code>/madhoney setup</code> in Discord.</p>'), 503);
        }
        const state = randomBytes(16).toString('hex');
        const auth = new URL('https://discord.com/oauth2/authorize');
        auth.search = new URLSearchParams({
          client_id: process.env.CLIENT_ID, redirect_uri: `${PUBLIC_URL}/callback`,
          response_type: 'code', scope: 'identify guilds', state,
        });
        return redirect(auth.href, { 'set-cookie': `oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax` });
      }
      if (url.pathname === '/callback') {
        if (!url.searchParams.get('code') || url.searchParams.get('state') !== cookies(req).oauth_state) {
          return html(layout('MadHoney', '<h1>Login failed</h1><p>Bad state or missing code. <a href="/login">Try again</a>.</p>'), 400);
        }
        const tok = await (await fetch(`${API}/oauth2/token`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${PUBLIC_URL}/callback`,
          }),
        })).json();
        if (!tok.access_token) return html(layout('MadHoney', '<h1>Login failed</h1><p>Token exchange failed. <a href="/login">Try again</a>.</p>'), 400);
        const bearer = { headers: { authorization: `Bearer ${tok.access_token}` } };
        const user = await (await fetch(`${API}/users/@me`, bearer)).json();
        const guilds = await (await fetch(`${API}/users/@me/guilds`, bearer)).json();
        const sid = randomBytes(24).toString('hex');
        sessions.set(sid, { user, guilds: Array.isArray(guilds) ? guilds : [], at: Date.now() });
        for (const [k, v] of sessions) if (Date.now() - v.at > WEEK) sessions.delete(k); // prune
        return redirect('/', { 'set-cookie': `sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${PUBLIC_URL.startsWith('https') ? '; Secure' : ''}` });
      }
      if (url.pathname === '/logout') {
        sessions.delete(cookies(req).sid);
        return redirect('/', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      }

      // ---- public assets ----
      if (url.pathname === '/logo.svg?v=2' || url.pathname === '/logo.png') {
        const type = url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
        return res.end(readFileSync(new URL('.' + url.pathname, import.meta.url)));
      }
      // sample banner shown on the landing page
      if (url.pathname === '/sample-banner.png') {
        const png = await renderBanner({});
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
        return res.end(png);
      }

      // ---- landing / guild list ----
      if (url.pathname === '/') {
        const sess = session(req);
        if (!sess) {
          return html(LANDING
            .replaceAll('%%INVITE%%', inviteUrl())
            .replaceAll('%%GUILDS%%', String(client.guilds.cache.size))
            .replaceAll('%%BANS%%', String(bans().filter((b) => !b.unbanned).length)));
        }
        const rows = sess.guilds
          .filter((g) => canManage(sess, g.id))
          .map((g) => {
            const live = client.guilds.cache.get(g.id);
            return live
              ? `<li><a href="/g/${g.id}">${esc(g.name)}</a> ${getGuild(g.id)?.honeypotChannelId ? '🍯 armed' : '- not configured yet'}</li>`
              : `<li>${esc(g.name)} - <a href="${inviteUrl()}&guild_id=${g.id}">invite MadHoney</a></li>`;
          }).join('');
        return html(layout('MadHoney', `
<h1><img src="/logo.svg?v=2" alt="">Mad<span>Honey</span></h1>
<p>Hi ${esc(sess.user.username)} · <a href="/logout">log out</a></p>
<div class="card"><h2>Your servers</h2><ul>${rows || '<li>No servers where you have Manage Server.</li>'}</ul></div>`));
      }

      // ---- per-guild ----
      const m = url.pathname.match(/^\/g\/(\d+)(\/save|\/action|\/banner\.png)?$/);
      if (m) {
        const sess = session(req);
        if (!sess) return redirect('/login');
        if (!canManage(sess, m[1])) return html(layout('MadHoney', '<h1>403</h1><p>You need Manage Server permission there.</p>'), 403);
        const guild = client.guilds.cache.get(m[1]);
        if (!guild) return html(layout('MadHoney', `<h1>Not here yet</h1><p><a href="${inviteUrl()}&guild_id=${m[1]}">Invite MadHoney to this server</a> first.</p>`), 404);

        if (m[2] === '/banner.png') {
          // query params (banner_*) override the saved config so the form can
          // live-preview without saving
          const opts = { ...getGuild(guild.id)?.banner };
          for (const k of ['title', 'text', 'accent', 'color', 'bg', 'font', 'logoUrl', 'mentionColor', 'mentionMode']) {
            const v = url.searchParams.get(`banner_${k}`);
            if (v !== null) opts[k] = v;
          }
          const png = await renderBanner({ ...opts, roleColors: roleColorMap(guild) });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        }
        if (m[2] === '/save' && req.method === 'POST') {
          const form = await body(req);
          if (form.has('banner_title') || form.has('banner_text')) {
            const banner = { ...DEFAULT_BANNER, ...getGuild(guild.id)?.banner };
            for (const k of ['title', 'text', 'accent', 'color', 'bg', 'font', 'logoUrl', 'mentionColor', 'mentionMode']) {
              if (form.has(`banner_${k}`)) banner[k] = form.get(`banner_${k}`).trim();
            }
            saveGuild(guild.id, { banner });
            return html(guildPage(guild, sess, 'Banner saved. Post it from Actions (or /madhoney deploy in Discord).'));
          }
          const patch = {};
          for (const k of ['verifiedRoleId', 'staffRoleId', 'verifyChannelId', 'honeypotChannelId', 'logChannelId', 'verifyText']) {
            if (form.has(k)) patch[k] = form.get(k).trim();
          }
          patch.banShare = form.get('banShare') === 'on';
          if (patch.verifyChannelId && patch.verifyChannelId === patch.honeypotChannelId) {
            return html(guildPage(guild, sess, '❌ Verify and honeypot must be different channels - not saved.'));
          }
          saveGuild(guild.id, patch);
          return html(guildPage(guild, sess, 'Saved.'));
        }
        if (m[2] === '/action' && req.method === 'POST') {
          const form = await body(req);
          const cfg = getGuild(guild.id);
          if (!cfg?.verifiedRoleId || !cfg?.verifyChannelId || !cfg?.honeypotChannelId) {
            return html(guildPage(guild, sess, '❌ Finish configuration first (role + both channels).'));
          }
          const acts = {
            post_verify: () => postVerifyPanel(guild, cfg),
            post_banner: () => postBanner(guild, cfg),
            gate_dry: () => gateChannels(guild, cfg, false),
            gate_apply: () => gateChannels(guild, cfg, true),
            grandfather: () => grandfather(guild, cfg),
          };
          const act = acts[form.get('do')];
          if (!act) return html(guildPage(guild, sess, 'Unknown action.'), 400);
          const result = await act().catch((e) => `❌ ${e.message}`);
          return html(guildPage(guild, sess, result));
        }
        return html(guildPage(guild, sess));
      }

      html(layout('MadHoney', '<h1>404</h1><p><a href="/">home</a></p>'), 404);
    } catch (err) {
      console.error('dashboard error:', err);
      html(layout('MadHoney', '<h1>500</h1><p>Something broke - check the bot logs.</p>'), 500);
    }
  });

  server.listen(PORT, '127.0.0.1', () =>
    console.log(`Dashboard: http://127.0.0.1:${PORT} → public at ${PUBLIC_URL} (put a reverse proxy/tunnel in front).`),
  );
  return server;
}
