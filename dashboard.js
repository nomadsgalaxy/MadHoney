// MadHoney web dashboard - Discord OAuth2 login, per-guild config + actions.
// Runs inside the bot process (started from bot.js when CLIENT_ID/SECRET are set).
// Binds 127.0.0.1 and is meant to sit behind a reverse proxy / Cloudflare tunnel.
// ponytail: in-memory sessions (logout on restart), no rate limiting - add both
// only if this ever serves more than a handful of admins.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PermissionsBitField, ChannelType } from 'discord.js';
import { getGuild, saveGuild, bans, trappedCount } from './store.js';
import { postVerifyPanel, postBanner, gateChannels, ungateChannels, classifyChannels, grandfather, syncBans, preflight, roleColorMap, DEFAULT_VERIFY_TEXT } from './actions.js';
import { renderBanner, DEFAULT_BANNER, FONTS } from './banner.js';
import { TERMS, PRIVACY } from './legal.js';

const PORT = Number(process.env.PORT || 8300);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const API = 'https://discord.com/api/v10';
const WEEK = 7 * 24 * 3600 * 1000;

const sessions = new Map(); // sid -> { user, guilds, at }
const gfJobs = new Map(); // guildId -> live grandfather progress {total, done, added, skipped, failed, finished, result, at}
const LANDING = readFileSync(new URL('./landing.html', import.meta.url), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/logo.svg?v=3" type="image/svg+xml">
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
  progress{width:100%;height:14px;accent-color:var(--honey);margin-top:.6rem}
  .slist{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:.7rem;list-style:none;padding:0;margin:.4rem 0 0}
  .stile{display:flex;align-items:center;gap:.75rem;background:#0f1216;border:1px solid var(--line);border-radius:11px;padding:.7rem .8rem;text-decoration:none;color:var(--ink);transition:border-color .15s,transform .15s}
  .stile:hover{border-color:var(--honey);transform:translateY(-2px);text-decoration:none}
  .savatar{width:44px;height:44px;border-radius:13px;flex:0 0 44px;object-fit:cover;background:#1c2029;display:flex;align-items:center;justify-content:center;font-family:"Bricolage Grotesque",sans-serif;font-weight:800;color:var(--honey);font-size:1.25rem}
  .smeta{min-width:0}
  .sname{font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spill{display:inline-block;font-size:.72rem;font-weight:700;padding:.08rem .5rem;border-radius:20px;margin-top:.25rem}
  .spill.armed{background:rgba(255,179,26,.16);color:var(--honey)}
  .spill.setup{background:rgba(255,138,125,.14);color:#ff8a7d}
  .spill.add{background:#1c2029;color:var(--dim)}
  h2 .count{font:400 .8rem/1 "Instrument Sans",sans-serif;color:var(--dim);margin-left:.5rem}
  /* guild page */
  .ghead{display:flex;align-items:center;gap:1rem;margin:.6rem 0 1rem}
  .ghead .savatar{width:58px;height:58px;border-radius:16px;flex:0 0 58px;font-size:1.6rem}
  .ghead .gtitle{min-width:0}
  .ghead h1{margin:0;font-size:clamp(1.4rem,4vw,1.9rem)}
  .ghead .crumbs{font-size:.85rem;margin:.15rem 0 0}
  .chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1rem}
  .chip{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:.3rem .75rem;font-size:.82rem;color:var(--dim)}
  .chip b{color:var(--ink);font-weight:700}
  .chip.on{border-color:rgba(255,179,26,.5);color:var(--honey)}
  .chip.off{opacity:.75}
  .subh{font-family:"Bricolage Grotesque",sans-serif;font-weight:700;font-size:.82rem;letter-spacing:.06em;text-transform:uppercase;color:var(--honey);margin:1.3rem 0 .1rem;padding-top:1rem;border-top:1px solid var(--line)}
  .subh.first{margin-top:0;padding-top:0;border-top:0}
  .grid2f{display:grid;grid-template-columns:1fr 1fr;gap:0 1.1rem}
  @media(max-width:620px){.grid2f{grid-template-columns:1fr}}
  .toggle{display:flex;gap:.6rem;align-items:flex-start;margin:.7rem 0;font-weight:600;cursor:pointer}
  .toggle input{width:18px;height:18px;margin-top:.15rem;accent-color:var(--honey);flex:0 0 auto}
  .steps{margin-top:.6rem}
  .step{display:grid;grid-template-columns:210px 1fr;gap:.4rem 1rem;align-items:center;padding:.7rem 0;border-top:1px solid var(--line)}
  .step:first-child{border-top:0}
  .step .btn{width:100%;text-align:center;margin:0}
  .step small{margin:0}
  @media(max-width:600px){.step{grid-template-columns:1fr}}
  .btable{width:100%;border-collapse:collapse;font-size:.85rem;font-variant-numeric:tabular-nums}
  .btable td{padding:.4rem .6rem;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
  .btable tr:last-child td{border-bottom:0}
  .btable .k{color:var(--dim);font-size:.78rem}
  .badge{font-size:.72rem;font-weight:700;padding:.05rem .45rem;border-radius:5px}
  .badge.ban{background:rgba(214,69,69,.16);color:#ff8a7d}
  .badge.un{background:rgba(123,216,143,.14);color:#7bd88f}
  .empty{color:var(--dim);padding:.4rem 0}
  /* gate picker */
  .clist{margin:.3rem 0 0}
  .crow{display:flex;align-items:center;gap:.6rem;padding:.32rem .5rem;border-radius:7px;font-weight:500}
  .crow:hover{background:#0f1216}
  .crow input{width:17px;height:17px;accent-color:var(--honey);flex:0 0 auto;margin:0}
  .crow.cat{font-weight:700;color:var(--ink);margin-top:.3rem}
  .crow.disabled{opacity:.5}
  .gsec{border:1px solid var(--line);border-radius:11px;padding:.8rem 1rem;margin:.9rem 0}
  .gsec>.gh{display:flex;justify-content:space-between;align-items:center;gap:.6rem}
  .gsec .gh b{font-family:"Bricolage Grotesque",sans-serif}
  .gsec .toggle-all{font-size:.8rem;color:var(--honey);cursor:pointer;background:none;border:0;font-weight:600}
  .gsec small{margin:.15rem 0 .4rem}
  .gsec.pub{border-color:rgba(255,179,26,.35)}
  .gsec.adm{border-color:rgba(214,69,69,.4)}
  .info{display:flex;gap:.6rem;align-items:center;padding:.3rem .5rem;color:var(--dim)}
  .stripes{height:12px;border-radius:4px;background:repeating-linear-gradient(-45deg,var(--honey) 0 18px,#111 18px 36px);margin-bottom:1.1rem}
  img.banner{max-width:100%;border-radius:8px;border:1px solid var(--line)}
</style><div class="stripes"></div>${body}
<p><small>Built on <a href="https://github.com/nomadsgalaxy/MadHoney" target="_blank" rel="noopener">MadHoney</a> by Nomads Galaxy · OCL v1.1 + SWAtt v1 · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></small></p></html>`;
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
}

function session(req) {
  const s = sessions.get(cookies(req).sid);
  if (!s || Date.now() - s.at > WEEK) return null;
  return s;
}

// Server admins (owner / Manage Server) always have access, from the OAuth
// guild flags alone. Members holding the configured staff role or dashboard
// admin role get access too - that requires fetching their member object.
function isAdmin(sess, guildId) {
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
  // Minimum viable permission set - see the note in bot.js.
  const inviteUrl = () =>
    `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=bot+applications.commands&permissions=268536852`;

  async function canManage(sess, guildId) {
    if (isAdmin(sess, guildId)) return true;
    const cfg = getGuild(guildId);
    const roleIds = [cfg?.staffRoleId, cfg?.adminRoleId].filter(Boolean);
    if (!roleIds.length) return false;
    const member = await client.guilds.cache.get(guildId)?.members.fetch(sess.user.id).catch(() => null);
    return !!member && roleIds.some((r) => member.roles.cache.has(r));
  }

  // `at` anchors the result: the message renders inside that card and the
  // form's action fragment scrolls the browser back to it after a POST.
  async function guildPage(guild, sess, msg = '', at = 'top') {
    const cfg = getGuild(guild.id) ?? {};
    const msgAt = (key) => (msg && at === key ? `<pre style="margin-top:.6rem">${esc(msg)}</pre>` : '');
    // standing health warning: catches the classic "bot role below verified role" mistake
    const problem = cfg.verifiedRoleId ? await preflight(guild, cfg).catch((e) => e.message) : null;
    const b = { ...DEFAULT_BANNER, ...cfg.banner };
    const roles = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id)
      .sort((a, z) => z.position - a.position);
    const chans = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText)
      .sort((a, z) => a.rawPosition - z.rawPosition);
    const roleOpts = (sel) => ['<option value="">(none)</option>', ...roles.map((r) =>
      `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`)].join('');
    const chanOpts = (sel) => ['<option value="">(none)</option>', ...chans.map((c) =>
      `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>#${esc(c.name)}</option>`)].join('');
    const banRows = bans(guild.id);
    const trappedHere = trappedCount(banRows);
    const icon = guild.iconURL?.({ size: 128 });
    const avatar = icon ? `<img class="savatar" src="${icon}" alt="">` : `<span class="savatar">${esc([...guild.name][0]?.toUpperCase() ?? '#')}</span>`;
    const roleName = cfg.verifiedRoleId ? (roles.get(cfg.verifiedRoleId)?.name ?? 'set') : null;
    const configured = cfg.verifiedRoleId && cfg.verifyChannelId && cfg.honeypotChannelId;
    const chips = [
      configured ? '<span class="chip on"><b>🍯 Armed</b></span>' : '<span class="chip off">Needs setup</span>',
      `<span class="chip">Trapped here <b>${trappedHere}</b></span>`,
      roleName ? `<span class="chip">Verified role <b>${esc(roleName)}</b></span>` : '',
      `<span class="chip ${cfg.banShare ? 'on' : 'off'}">Universal list <b>${cfg.banShare ? 'ON' : 'off'}</b></span>`,
    ].filter(Boolean).join('');

    const recent = banRows.slice(-12).reverse().map((x) => {
      const when = esc(String(x.at).replace('T', ' ').slice(0, 16));
      return `<tr><td>${x.unbanned ? '<span class="badge un">unban</span>' : '<span class="badge ban">ban</span>'}</td><td>${esc(x.tag ?? x.id)}</td><td class="k">${esc(x.channel ?? '')}</td><td class="k">${when}</td></tr>`;
    }).join('');

    return layout(`MadHoney - ${guild.name}`, `
<div class="ghead">${avatar}<div class="gtitle">
  <h1>${esc(guild.name)}</h1>
  <div class="crumbs"><a href="/">← all servers</a> · <a href="/g/${guild.id}?refresh=1" title="Re-fetch roles, channels and members from Discord">⟳ refresh data</a></div>
</div></div>
<div class="chips">${chips}</div>
${problem ? `<div class="card" style="border-color:#d64545"><b style="color:#ff5b4d">⚠️ Setup problem</b><pre style="margin-top:.5rem">${esc(problem)}</pre></div>` : ''}
${msg && at === 'top' ? `<div class="card"><pre>${esc(msg)}</pre></div>` : ''}
<div class="card" id="config"><h2>Configuration</h2>${msgAt('config')}
<form method="post" action="/g/${guild.id}/save#config">
  <div class="subh first">Core setup</div>
  <div class="grid2f">
  <label>Verified role <select name="verifiedRoleId">${roleOpts(cfg.verifiedRoleId)}</select>
    <small>Granted after the captcha. MadHoney's own role must sit ABOVE it.</small></label>
  <label>Verify channel <select name="verifyChannelId">${chanOpts(cfg.verifyChannelId)}</select>
    <small>Where the Verify button lives - your #rules channel is the classic spot.</small></label>
  <label>Honeypot channel <select name="honeypotChannelId">${chanOpts(cfg.honeypotChannelId)}</select>
    <small>The trap. Name it like a real channel (general-2). Posting here = instant ban.</small></label>
  <label>Log channel (optional) <select name="logChannelId">${chanOpts(cfg.logChannelId)}</select>
    <small>Staff-only channel - each ban is reported there with an Unban button.</small></label>
  </div>
  <div class="subh">Staff &amp; dashboard access</div>
  <div class="grid2f">
  <label>Staff role (optional) <select name="staffRoleId">${roleOpts(cfg.staffRoleId)}</select>
    <small>Never trapped by the honeypot, and can manage MadHoney here.</small></label>
  <label>Dashboard admin role (optional) <select name="adminRoleId">${roleOpts(cfg.adminRoleId)}</select>
    <small>Dashboard access WITHOUT the honeypot exemption - for helpers.</small></label>
  </div>
  <div class="subh">Verify message</div>
  <label><textarea name="verifyText" rows="3">${esc(cfg.verifyText || DEFAULT_VERIFY_TEXT)}</textarea>
    <small>Shown above the Verify button.</small></label>
  <div class="subh">Universal ban list</div>
  <label class="toggle"><input type="checkbox" name="banShare" ${cfg.banShare ? 'checked' : ''}>
    <span>Apply the universal ban list to this server<small>Every honeypot catch across all MadHoney servers feeds one list. ON: users on it are banned when they join here (use "Ban from List" below to apply it retroactively). OFF: this server acts only on its own catches - which it keeps either way.</small></span></label>
  <button class="btn">Save configuration</button>
</form></div>
<div class="card" id="banner"><h2>Honeypot banner</h2>${msgAt('banner')}
<small>Live preview - it re-renders as you tweak. Save, then post it from Actions below.</small>
<img class="banner" id="bannerPreview" src="/g/${guild.id}/banner.png?${Date.now()}" alt="banner preview" style="margin-top:.6rem">
<form method="post" action="/g/${guild.id}/save#banner" id="bannerForm">
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
<div class="card" id="actions"><h2>Actions</h2>${msgAt('actions')}
${gfJobs.has(guild.id) ? `
<div id="gfwrap"><progress id="gfbar" max="1" value="0"></progress><small id="gftext">Grandfathering: starting…</small></div>
<script>
(async function poll() {
  try {
    const p = await (await fetch('/g/${guild.id}/progress')).json();
    if (!p.none) {
      const bar = document.getElementById('gfbar'), txt = document.getElementById('gftext');
      bar.max = p.total || 1; bar.value = p.done || 0;
      txt.textContent = p.finished
        ? p.result
        : (p.label || 'Working') + ': ' + (p.done ?? 0) + '/' + (p.total ?? '?') + ' · ' + (p.added ?? 0) + ' added · ' + (p.skipped ?? 0) + ' skipped' + (p.failed ? ' · ' + p.failed + ' FAILED' : '');
      if (p.finished) { bar.value = bar.max; return; }
    }
  } catch {}
  setTimeout(poll, 1200);
})();
</script>` : ''}
<div class="subh first">Deploy — run 1 → 4 in order on first setup</div>
<form method="post" action="/g/${guild.id}/action#actions" class="steps">
${[
  ['grandfather', 'grey', '1 · Grandfather members',
    'Gives the verified role to every human already in the server, so gating never locks anyone out. Bots and already-verified members are skipped.'],
  ['post_verify', '', '2 · Post Verify panel',
    'Posts the Verify button in the verify channel. New members click it, read a captcha, and receive the verified role.'],
  ['post_banner', '', '3 · Post honeypot banner',
    'Posts the warning image (designed above) into the honeypot channel. Re-run after changing the banner.'],
].map(([val, cls, label, desc]) =>
  `<div class="step"><button class="btn ${cls}" name="do" value="${val}">${label}</button><small>${desc}</small></div>`).join('')}
<div class="step"><a class="btn" href="/g/${guild.id}/gate">4 · Gate channels…</a><small>Opens the channel picker: MadHoney classifies every channel (public / private / admin) and you choose exactly which to hide behind the verified role. Nothing changes until you apply.</small></div>
</form>
<div class="subh">Maintenance</div>
<form method="post" action="/g/${guild.id}/action#actions" class="steps">
${[
  ['ungate', 'grey', '↩ Restore channels',
    'Reverses gating: returns the channels MadHoney gated to how they looked before. Admin channels it never touched are left alone.'],
  ['ban_sync', 'grey', 'Ban from shared list',
    'Bans everyone on the universal ban list now, instead of waiting for them to join. Needs the universal list turned ON above.'],
].map(([val, cls, label, desc]) =>
  `<div class="step"><button class="btn ${cls}" name="do" value="${val}">${label}</button><small>${desc}</small></div>`).join('')}
</form></div>
<div class="card"><h2>Recent bans <span class="count">${trappedHere} trapped here</span></h2>
${recent ? `<table class="btable">${recent}</table>` : '<div class="empty">No bans logged in this server yet.</div>'}</div>`);
  }

  // Channel gating picker: classify every channel and let the admin choose
  // exactly which to gate, instead of a blanket "all public".
  async function gatePage(guild, sess, msg = '') {
    const cfg = getGuild(guild.id) ?? {};
    if (!cfg.verifiedRoleId || !cfg.verifyChannelId || !cfg.honeypotChannelId) {
      return layout('MadHoney - Gate', `<div class="ghead"><div class="gtitle"><h1>Gate channels</h1>
        <div class="crumbs"><a href="/g/${guild.id}">← ${esc(guild.name)}</a></div></div></div>
        <div class="card"><p>Finish <a href="/g/${guild.id}#config">configuration</a> first - I need the verified role, verify channel and honeypot channel.</p></div>`);
    }
    const chans = await classifyChannels(guild, cfg);
    const gated = new Set(cfg.gatedChannels ?? []);
    const firstRun = gated.size === 0;

    const row = (c, defChecked) => {
      const checked = c.canManage && (firstRun ? defChecked : gated.has(c.id)) ? 'checked' : '';
      const badge = !c.canManage ? ' <span class="badge ban">can\'t access</span>' : '';
      return `<label class="crow ${c.isCategory ? 'cat' : ''} ${c.canManage ? '' : 'disabled'}">
        <input type="checkbox" name="ch" value="${c.id}" ${checked} ${c.canManage ? '' : 'disabled'}>
        <span>${c.isCategory ? '▸ ' : '# '}${esc(c.name)}${badge}</span></label>`;
    };
    const section = (cls, title, hint, kind, defChecked) => {
      const items = chans.filter((c) => c.kind === kind);
      if (!items.length) return '';
      return `<div class="gsec ${cls}"><div class="gh"><b>${title} <span class="count">${items.length}</span></b>
        <button type="button" class="toggle-all" data-kind="${kind}">toggle all</button></div>
        <small>${hint}</small><div class="clist" data-kind="${kind}">${items.map((c) => row(c, defChecked)).join('')}</div></div>`;
    };
    const verify = chans.find((c) => c.kind === 'verify');
    const honeypot = chans.find((c) => c.kind === 'honeypot');

    return layout(`MadHoney - Gate ${guild.name}`, `
<div class="ghead"><div class="gtitle"><h1>Gate channels</h1>
  <div class="crumbs"><a href="/g/${guild.id}">← ${esc(guild.name)}</a> · <a href="/g/${guild.id}/gate">⟳ re-scan</a></div></div></div>
${msg ? `<div class="card"><pre>${esc(msg)}</pre></div>` : ''}
<div class="card">
<p>MadHoney scanned this server and sorted every channel below. <b>Tick the ones to hide behind the verified role</b> (public channels are pre-selected). Unticked channels are left exactly as they are. When applied: verify stays public, the honeypot stays open to unverified, and any admin channel under a gated category is explicitly kept hidden.</p>
<form method="post" action="/g/${guild.id}/gate">
${section('pub', '🌐 Public channels', 'Standard channels anyone can currently see. These are what you normally gate.', 'public', true)}
${section('', '🔒 Private / restricted', 'Already hidden from @everyone (not admin). Usually leave these alone - tick only if you want the verified role added.', 'private', false)}
${section('adm', '🛡️ Admin / staff channels', 'Hidden from @everyone AND a mod/staff role can see them. Leave unticked unless you know what you\'re doing.', 'admin', false)}
<div class="info">✅ Verify gateway (stays public): <b style="color:var(--ink);margin-left:.3rem">#${verify ? esc(verify.name) : '?'}</b></div>
<div class="info">🍯 Honeypot (open to unverified, hidden from verified): <b style="color:var(--ink);margin-left:.3rem">#${honeypot ? esc(honeypot.name) : '?'}</b></div>
<button class="btn" style="margin-top:1rem">Apply gating to selected</button>
<a class="btn grey" href="/g/${guild.id}" style="margin-top:1rem">Cancel</a>
</form></div>
<script>
document.querySelectorAll('.toggle-all').forEach((b) => b.addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('.clist[data-kind="' + b.dataset.kind + '"] input:not([disabled])')];
  const anyOff = boxes.some((x) => !x.checked);
  boxes.forEach((x) => { x.checked = anyOff; });
}));
</script>`);
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

      // ---- legal pages ----
      if (url.pathname === '/terms') return html(layout('MadHoney - Terms of Service', TERMS));
      if (url.pathname === '/privacy') return html(layout('MadHoney - Privacy Policy', PRIVACY));

      // ---- public assets ----
      if (url.pathname === '/logo.svg' || url.pathname === '/logo.png') {
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
            .replaceAll('%%BANS%%', trappedCount().toLocaleString('en-US')));
        }
        const manageable = [];
        for (const g of sess.guilds) {
          // full role check only where the bot is present; elsewhere OAuth flags decide
          const ok = client.guilds.cache.has(g.id) ? await canManage(sess, g.id) : isAdmin(sess, g.id);
          if (ok) manageable.push(g);
        }
        const avatar = (g) => g.icon
          ? `<img class="savatar" src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="" loading="lazy">`
          : `<span class="savatar">${esc([...g.name][0]?.toUpperCase() ?? '#')}</span>`;
        const tile = (g, href, target, pill) =>
          `<a class="stile" href="${href}"${target}>${avatar(g)}<span class="smeta"><div class="sname">${esc(g.name)}</div>${pill}</span></a>`;

        const present = manageable.filter((g) => client.guilds.cache.has(g.id));
        const absent = manageable.filter((g) => !client.guilds.cache.has(g.id));
        const armed = (g) => !!getGuild(g.id)?.honeypotChannelId;
        // armed servers first, then those needing setup; alphabetical within each
        present.sort((a, z) => (armed(a) === armed(z) ? a.name.localeCompare(z.name) : armed(a) ? -1 : 1));
        absent.sort((a, z) => a.name.localeCompare(z.name));

        const presentTiles = present.map((g) => tile(g, `/g/${g.id}`, '',
          armed(g) ? '<span class="spill armed">🍯 Armed</span>' : '<span class="spill setup">Needs setup</span>')).join('');
        const absentTiles = absent.map((g) => tile(g, `${inviteUrl()}&guild_id=${g.id}`, ' target="_blank" rel="noopener"',
          '<span class="spill add">＋ Add MadHoney</span>')).join('');
        const armedCount = present.filter(armed).length;

        return html(layout('MadHoney', `
<h1><img src="/logo.svg?v=3" alt="">Mad<span>Honey</span></h1>
<p>Hi ${esc(sess.user.username)} · <a href="/logout">log out</a></p>
${present.length ? `<div class="card"><h2>Your servers <span class="count">${present.length} with MadHoney · ${armedCount} armed</span></h2>
<ul class="slist">${presentTiles}</ul></div>` : `<div class="card"><h2>Get started</h2>
<p>MadHoney isn't in any of your servers yet. Add it to one below, then run through setup here.</p></div>`}
${absent.length ? `<div class="card"><h2>Add MadHoney to another server <span class="count">${absent.length} available</span></h2>
<ul class="slist">${absentTiles}</ul></div>` : ''}
${!manageable.length ? '<div class="card"><p>No servers where you have Manage Server (or a MadHoney staff/admin role). Ask an admin, or add MadHoney to a server you own.</p></div>' : ''}`));
      }

      // ---- per-guild ----
      const m = url.pathname.match(/^\/g\/(\d+)(\/save|\/action|\/banner\.png|\/progress|\/gate)?$/);
      if (m) {
        const sess = session(req);
        if (!sess) return redirect('/login');
        if (!(await canManage(sess, m[1]))) {
          return html(layout('MadHoney', '<h1>403</h1><p>You need Manage Server there (or that server\'s staff / dashboard admin role).</p>'), 403);
        }
        const guild = client.guilds.cache.get(m[1]);
        if (!guild) return html(layout('MadHoney', `<h1>Not here yet</h1><p><a href="${inviteUrl()}&guild_id=${m[1]}" target="_blank" rel="noopener">Invite MadHoney to this server</a> first.</p>`), 404);

        if (m[2] === '/progress') {
          const p = gfJobs.get(guild.id);
          if (p?.finished && Date.now() - p.at > 60_000) gfJobs.delete(guild.id); // prune old results
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(JSON.stringify(p ?? { none: true }));
        }
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
            return html(await guildPage(guild, sess, 'Banner saved. Post it from Actions (or /madhoney deploy in Discord).', 'banner'));
          }
          const patch = {};
          for (const k of ['verifiedRoleId', 'staffRoleId', 'adminRoleId', 'verifyChannelId', 'honeypotChannelId', 'logChannelId', 'verifyText']) {
            if (form.has(k)) patch[k] = form.get(k).trim();
          }
          patch.banShare = form.get('banShare') === 'on';
          if (patch.verifyChannelId && patch.verifyChannelId === patch.honeypotChannelId) {
            return html(await guildPage(guild, sess, '❌ Verify and honeypot must be different channels - not saved.', 'config'));
          }
          saveGuild(guild.id, patch);
          return html(await guildPage(guild, sess, 'Saved.', 'config'));
        }
        if (m[2] === '/action' && req.method === 'POST') {
          const form = await body(req);
          const cfg = getGuild(guild.id);
          if (!cfg?.verifiedRoleId || !cfg?.verifyChannelId || !cfg?.honeypotChannelId) {
            return html(await guildPage(guild, sess, '❌ Finish configuration first (role + both channels).', 'actions'));
          }
          // Member-by-member jobs (one API call each) run in the background
          // with a polled progress bar; one job at a time per guild.
          const slowJobs = { grandfather, ban_sync: syncBans };
          if (slowJobs[form.get('do')]) {
            if (gfJobs.get(guild.id) && !gfJobs.get(guild.id).finished) {
              return html(await guildPage(guild, sess, 'A job is already running - watch the bar below.', 'actions'));
            }
            const progress = { finished: false, at: Date.now() };
            gfJobs.set(guild.id, progress);
            slowJobs[form.get('do')](guild, getGuild(guild.id), progress)
              .then((r) => Object.assign(progress, { finished: true, result: r, at: Date.now() }))
              .catch((e) => Object.assign(progress, { finished: true, result: `❌ ${e.message}`, at: Date.now() }));
            return html(await guildPage(guild, sess, '', 'actions'));
          }
          const acts = {
            post_verify: () => postVerifyPanel(guild, cfg),
            post_banner: () => postBanner(guild, cfg),
            ungate: () => ungateChannels(guild, cfg),
          };
          const act = acts[form.get('do')];
          if (!act) return html(await guildPage(guild, sess, 'Unknown action.', 'actions'), 400);
          const result = await act().catch((e) => `❌ ${e.message}`);
          return html(await guildPage(guild, sess, result, 'actions'));
        }
        if (m[2] === '/gate') {
          const cfg = getGuild(guild.id);
          if (req.method === 'POST') {
            const form = await body(req);
            const ids = form.getAll('ch');
            const result = await gateChannels(guild, cfg, true, ids).catch((e) => `❌ ${e.message}`);
            return html(await gatePage(guild, sess, result));
          }
          return html(await gatePage(guild, sess));
        }
        if (url.searchParams.get('refresh')) {
          await Promise.all([guild.roles.fetch(), guild.channels.fetch()]).catch(() => {});
          return html(await guildPage(guild, sess, 'Refreshed roles and channels from Discord.'));
        }
        return html(await guildPage(guild, sess));
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
