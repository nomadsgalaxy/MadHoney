// MadHoney web dashboard - Discord OAuth2 login, per-guild config + actions.
// Runs inside the bot process (started from bot.js when CLIENT_ID/SECRET are set).
// Binds 127.0.0.1 and is meant to sit behind a reverse proxy / Cloudflare tunnel.
// ponytail: in-memory sessions (logout on restart), no rate limiting - add both
// only if this ever serves more than a handful of admins.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PermissionsBitField, ChannelType } from 'discord.js';
import { getGuild, saveGuild, bans, trappedCount } from './store.js';
import { postVerifyPanel, postBanner, gateChannels, ungateChannels, classifyChannels, grandfather, syncBans, preflight, explainError, roleColorMap, DEFAULT_VERIFY_TEXT } from './actions.js';
import { honeypotMode } from './trap.js';
import { renderBanner, DEFAULT_BANNER, FONTS, resolveCredit, SELF_HOSTED } from './banner.js';
import { TERMS, PRIVACY } from './legal.js';

const PORT = Number(process.env.PORT || 8300);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const API = 'https://discord.com/api/v10';
const WEEK = 7 * 24 * 3600 * 1000;

const sessions = new Map(); // sid -> { user, guilds, at }
const gfJobs = new Map(); // guildId -> live grandfather progress {total, done, added, skipped, failed, finished, result, at}
const LANDING = readFileSync(new URL('./landing.html', import.meta.url), 'utf8');

// Persist login sessions across restarts so deploying the bot doesn't log
// everyone out. Stores only profile + guild list (no OAuth tokens).
// ponytail: plain gitignored JSON file, fine at this scale.
const SESS_FILE = new URL('./sessions.json', import.meta.url);
if (existsSync(SESS_FILE)) {
  try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(SESS_FILE, 'utf8')))) sessions.set(k, v); } catch { /* corrupt file, start fresh */ }
}
const persistSessions = () => { try { writeFileSync(SESS_FILE, JSON.stringify(Object.fromEntries(sessions))); } catch { /* best effort */ } };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, body, opts = {}) {
  const invite = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=bot+applications.commands&permissions=268536852`;
  const navRight = opts.user
    ? `<a href="/stats">Stats</a><span class="navuser">${esc(opts.user)}</span><a href="/logout">Log out</a><a class="btn sm" href="${invite}" target="_blank" rel="noopener">＋ Add<span class="lg"> server</span></a>`
    : `<a href="/stats">Stats</a><a href="/login">Log in</a><a class="btn sm" href="${invite}" target="_blank" rel="noopener">＋ Add<span class="lg"> to Discord</span></a>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/logo.svg?v=3" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--honey:#ffb31a;--bg:#0a0b0d;--card:#12141a;--ink:#f2ede2;--dim:#9a948a;--line:#262b34}
  *{box-sizing:border-box}
  html,body{overflow-x:hidden}
  body{font:15px/1.55 "Instrument Sans",system-ui,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:0}
  body::before{content:"";position:fixed;inset:0;z-index:-1;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='27.7128' height='48' viewBox='0 0 27.7128 48'%3E%3Cpath d='M0 8L13.8564 0l13.8564 8M0 8v16l13.8564 8 13.8564-8M13.8564 32v16' fill='none' stroke='%23ffb31a' stroke-opacity='.045' stroke-width='1.5'/%3E%3C/svg%3E");
    background-size:27.7128px 48px}
  .wrap{max-width:880px;margin:0 auto;padding:0 1rem 2.5rem}
  nav{position:sticky;top:0;z-index:20;background:rgba(10,11,13,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  nav .nin{max-width:880px;margin:0 auto;padding:0 1rem;display:flex;align-items:center;gap:1rem;height:56px}
  nav .wm{display:inline-flex;align-items:center;gap:.5rem;font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:1.15rem;color:var(--ink);white-space:nowrap}
  nav .wm img{height:26px;width:auto}
  nav .wm b{color:var(--honey)}
  nav .navr{margin-left:auto;display:flex;align-items:center;gap:.9rem;font-size:.9rem;min-width:0}
  nav .navr>a{color:var(--dim);white-space:nowrap} nav .navr>a:hover{color:var(--ink);text-decoration:none}
  nav .navr .btn.sm{white-space:nowrap}
  nav .navuser{color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:12ch}
  .navtape{height:5px;background:repeating-linear-gradient(-45deg,var(--honey) 0 14px,#101010 14px 28px)}
  @media(max-width:520px){nav .navuser{display:none} nav .navr{gap:.7rem} nav .navr .lg{display:none} nav .nin{gap:.5rem} nav .wm span{display:none}}
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
  .btn.sm{padding:.42rem .85rem;font-size:.85rem}
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
  .subnav{display:flex;align-items:center;gap:.5rem;margin:.6rem 0 1rem;flex-wrap:wrap}
  .backbtn{display:inline-flex;align-items:center;gap:.4rem;padding:.45rem .9rem;border-radius:9px;background:var(--card);border:1px solid var(--line);color:var(--ink);font-weight:600;font-size:.9rem;transition:transform .12s,border-color .12s,color .12s}
  .backbtn:hover{border-color:var(--honey);color:var(--honey);text-decoration:none;transform:translateX(-2px)}
  .backbtn .chev{font-size:1.15em;line-height:1;margin-top:-1px}
  .pillbtn{display:inline-flex;align-items:center;gap:.45rem;padding:.45rem .9rem;border-radius:9px;background:transparent;border:1px solid var(--line);color:var(--dim);font-weight:600;font-size:.88rem;transition:border-color .12s,color .12s}
  .pillbtn:hover{border-color:var(--honey);color:var(--honey);text-decoration:none}
  .pillbtn .ico{display:inline-block;transition:transform .4s ease}
  .pillbtn:hover .ico{transform:rotate(180deg)}
  .subnav .spacer{margin-left:auto}
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
  /* gate board */
  .legend{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;color:var(--dim);font-size:.82rem;margin:.2rem 0 .8rem}
  .kdot{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 .15rem 0 .6rem;vertical-align:middle}
  .kdot:first-child{margin-left:0}
  .kdot.public{background:#ffb31a}.kdot.private{background:#6c7683}.kdot.admin{background:#d64545}
  .board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.7rem;margin:.4rem 0;align-items:start}
  @media(max-width:720px){.board{grid-template-columns:1fr}}
  .zcol{min-width:0;background:#0f1216;border:1px solid var(--line);border-radius:11px;padding:.6rem .7rem;display:flex;flex-direction:column}
  .zcol .zh b{font-family:"Bricolage Grotesque",sans-serif;font-size:.95rem;white-space:nowrap}
  .zcol small{margin:.1rem 0 .5rem;min-height:3.4em}
  .drop{flex:1;min-width:0;min-height:90px;border:1.5px dashed var(--line);border-radius:9px;padding:.4rem;display:flex;flex-direction:column;gap:.35rem;transition:border-color .12s,background .12s}
  .drop.over{border-color:var(--honey);background:rgba(255,179,26,.06)}
  .zempty{color:var(--dim);font-size:.8rem;text-align:center;padding:1.2rem .3rem}
  .chip2{display:flex;align-items:center;gap:.4rem;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.35rem .5rem;font-size:.85rem;cursor:grab;user-select:none}
  .chip2:hover{border-color:var(--honey)}
  .chip2.iscat{background:#171b22;font-weight:700}
  .chip2.dragging{opacity:.4}
  .chip2 .kdot{margin:0;flex:0 0 auto}
  .chip2 .cn{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chip2 .ctag{font-size:.62rem;letter-spacing:.04em;color:var(--dim);text-transform:uppercase;flex:0 1 auto;min-width:0;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .info{display:flex;gap:.6rem;align-items:flex-start;padding:.3rem .5rem;color:var(--dim);flex-wrap:wrap}
  .tscroll{overflow-x:auto}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86em;background:#0f1216;border:1px solid var(--line);border-radius:5px;padding:.05em .35em;color:var(--honey)}
  details.guide{border-color:rgba(255,179,26,.35)}
  details.guide summary{cursor:pointer;list-style:none;font-size:1rem;display:flex;align-items:center;gap:.5rem}
  details.guide summary::-webkit-details-marker{display:none}
  details.guide summary::before{content:"▸";color:var(--honey);transition:transform .15s;display:inline-block}
  details.guide[open] summary::before{transform:rotate(90deg)}
  details.guide summary b{font-family:"Bricolage Grotesque",sans-serif;font-size:1.05rem}
  details.guide .gb{margin-top:.9rem;color:var(--dim);font-size:.93rem}
  details.guide .gb ol{padding-left:1.2rem;margin:.5rem 0}
  details.guide .gb li{margin:.45rem 0}
  details.guide .gb b{color:var(--ink)}
  details.guide .tip{background:#0f1216;border:1px solid var(--line);border-radius:8px;padding:.55rem .8rem;margin:.55rem 0;line-height:1.5}
  .warnbox{background:rgba(214,69,69,.1);border:1px solid rgba(214,69,69,.45);border-radius:8px;padding:.6rem .85rem;margin:.3rem 0 .2rem;font-size:.9rem;line-height:1.5;color:#ffb3aa}
  .warnbox b{color:#fff}
  .armbar{display:flex;align-items:center;gap:1rem;justify-content:space-between;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;padding:.9rem 1.2rem;margin:0 0 1rem}
  .armbar.on{border-color:rgba(255,179,26,.5);background:rgba(255,179,26,.06)}
  .armbar.off{border-color:rgba(214,69,69,.5);background:rgba(214,69,69,.07)}
  .armbar b{font-family:"Bricolage Grotesque",sans-serif;font-size:1.05rem}
  .armbar small{color:var(--dim);display:block;margin-top:.2rem}
  .armbar .btn{margin:0;flex:0 0 auto}
  .modebtns{display:flex;gap:.3rem;flex:0 0 auto;background:#0f1216;border:1px solid var(--line);border-radius:9px;padding:.25rem}
  .modeb{border:0;background:transparent;color:var(--dim);font:inherit;font-weight:600;font-size:.85rem;padding:.35rem .7rem;border-radius:6px;cursor:pointer;white-space:nowrap}
  .modeb:hover:not(.active){color:var(--ink)}
  .modeb.active{background:var(--honey);color:#141005;cursor:default}
  img.banner{max-width:100%;border-radius:8px;border:1px solid var(--line)}
  footer.f{margin-top:2rem;color:var(--dim);font-size:.85rem;border-top:1px solid var(--line);padding-top:1rem}
</style>
<nav><div class="nin"><a class="wm" href="/"><img src="/logo.svg?v=3" alt=""><span>Mad<b>Honey</b></span></a>
<div class="navr">${navRight}</div></div></nav><div class="navtape"></div>
<div class="wrap">${body}
<footer class="f">Built on <a href="https://github.com/nomadsgalaxy/MadHoney" target="_blank" rel="noopener">MadHoney</a> by <a href="https://nomadsgalaxy.com" target="_blank" rel="noopener">Nomads Galaxy</a> · OCL v1.1 + SWAtt v1 · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>
</div></html>`;
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
    const problem = (cfg.verificationEnabled !== false && cfg.verifiedRoleId) ? await preflight(guild, cfg).catch((e) => e.message) : null;
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
    const verifyOn = cfg.verificationEnabled !== false; // default on
    const mode = honeypotMode(cfg); // 'armed' | 'review' | 'disarmed'
    // With verification off there's no verified role/gate to require - just the honeypot.
    const configured = cfg.honeypotChannelId && (!verifyOn || (cfg.verifiedRoleId && cfg.verifyChannelId));
    const modeChip = { armed: '<span class="chip on"><b>🍯 Armed</b></span>', review: '<span class="chip on"><b>⏸ Review</b></span>', disarmed: '<span class="chip off"><b>⭘ Disarmed</b></span>' }[mode];
    const chips = [
      !configured ? '<span class="chip off">Needs setup</span>' : modeChip,
      `<span class="chip">Trapped here <b>${trappedHere}</b></span>`,
      verifyOn
        ? (roleName ? `<span class="chip">Verified role <b>${esc(roleName)}</b></span>` : '')
        : '<span class="chip off">⚠️ Verification OFF</span>',
      `<span class="chip ${cfg.banShare ? 'on' : 'off'}">Universal list <b>${cfg.banShare ? 'ON' : 'off'}</b></span>`,
    ].filter(Boolean).join('');
    const modeBtn = (val, label) => `<button class="modeb ${mode === val ? 'active' : ''}" name="do" value="mode_${val}" ${mode === val ? 'disabled' : ''}>${label}</button>`;
    const armDesc = { armed: 'Anyone who posts in the honeypot is banned immediately.', review: 'Honeypot posts are held and reported to your log channel with Ban / Dismiss buttons - a mod decides. Not recommended for busy servers.', disarmed: 'The trap is off - nobody gets banned. Arm it once everything is set up.' }[mode];
    const armBar = configured ? `<form method="post" action="/g/${guild.id}/action" class="armbar ${mode === 'disarmed' ? 'off' : 'on'}">
      <div><b>${{ armed: '🍯 Honeypot is Armed', review: '⏸ Honeypot: Hold for review', disarmed: '⭘ Honeypot is Disarmed' }[mode]}</b>
      <small>${armDesc}${mode === 'review' && !cfg.logChannelId ? ' <b style="color:#ff8a7d">Set a log channel below - held posts have nowhere to go otherwise.</b>' : ''}</small></div>
      <div class="modebtns">${modeBtn('armed', '🍯 Armed')}${modeBtn('review', '⏸ Review')}${modeBtn('disarmed', '⭘ Off')}</div>
    </form>` : '';

    const recent = banRows.slice(-12).reverse().map((x) => {
      const when = esc(String(x.at).replace('T', ' ').slice(0, 16));
      return `<tr><td>${x.unbanned ? '<span class="badge un">unban</span>' : '<span class="badge ban">ban</span>'}</td><td>${esc(x.tag ?? x.id)}</td><td class="k">${esc(x.channel ?? '')}</td><td class="k">${when}</td></tr>`;
    }).join('');

    return layout(`MadHoney - ${guild.name}`, `
<div class="subnav">
  <a class="backbtn" href="/"><span class="chev">‹</span> All servers</a>
  <a class="pillbtn spacer" href="/g/${guild.id}?refresh=1" title="Re-fetch roles, channels and members from Discord"><span class="ico">⟳</span> Refresh</a>
</div>
<div class="ghead">${avatar}<div class="gtitle"><h1>${esc(guild.name)}</h1></div></div>
<div class="chips">${chips}</div>
${armBar}
${problem ? `<div class="card" style="border-color:#d64545"><b style="color:#ff5b4d">⚠️ Setup problem</b><pre style="margin-top:.5rem">${esc(problem)}</pre></div>` : ''}
${msg && at === 'top' ? `<div class="card"><pre>${esc(msg)}</pre></div>` : ''}
<details class="card guide" ${configured ? '' : 'open'}>
<summary><b>📋 Best practices &amp; setup guide</b></summary>
<div class="gb">
<p><b>Why MadHoney works this way.</b> A spam bot never posts once - it blasts every channel it can reach and pings @everyone if it can, and every message leaves that channel marked unread. Banning the bot and deleting the spam doesn't clear those unread markers, so you're left with a whole server flagged for spam nobody should have seen. MadHoney catches the bot in one place before it can touch the rest of your server.</p>
<p>Bots aren't smart, and the design leans on that: gate every channel behind the verified role and the only place an unverified account can post is the honeypot. Name it like a real channel (<code>general-2</code>) and an indiscriminate bot walks straight in. Its only content is an image - a human reads the warning and backs off, but a bot can't parse a picture, so it posts anyway and trips the trap. The verified role hides the honeypot from anyone who passed the captcha, so <b>no real member ever gets caught</b>. That's why verification is the recommended setup - it's what keeps humans out of the trap.</p>
<p><b>Set it up in this order:</b></p>
<ol>
<li><b>Verified role first.</b> Create a role (e.g. "Verified") in Server Settings → Roles, then drag the <b>MadHoney</b> role ABOVE it. If MadHoney's role sits below the verified role, gating and grandfathering fail with a permission error - this is the single most common mistake.</li>
<li><b>Configure below.</b> Pick the verified role, your verify channel (usually <code>#rules</code>), and a honeypot channel. Optionally add a staff role and a log channel.</li>
<li><b>Grandfather members.</b> Run this first so everyone already in the server gets the verified role and nobody is locked out when you gate.</li>
<li><b>Post the Verify panel and honeypot banner.</b></li>
<li><b>Gate channels.</b> Open the drag board, review what MadHoney detected, move anything it misjudged, then apply. Nothing changes until you hit Apply.</li>
</ol>
<div class="tip"><b>🍯 Naming the honeypot:</b> name it like a real channel so bots post in it. Good: <code>general-2</code>, <code>chat-2</code>, <code>off-topic-2</code>. Bad: <code>honeypot</code>, <code>do-not-post</code> (some spam tools skip those).</div>
<div class="tip"><b>🔘 Honeypot mode:</b> the control at the top has three settings. <b>Armed</b> bans on sight (recommended). <b>Off</b> disables the trap while you set up. <b>Review</b> holds each hit in your log channel with Ban / Dismiss buttons so a mod decides - not recommended for busy servers (a real spam run floods the log), but it works if you want a human in the loop.</div>
<div class="tip"><b>⚠️ Discord Onboarding:</b> if you use it, make sure it does NOT auto-grant the verified role, or the captcha can be skipped.</div>
<div class="tip"><b>🔒 Getting a permission error?</b> It's almost always the MadHoney role sitting below your verified role, or missing Manage Roles / Manage Channels. Re-invite MadHoney with <b>＋ Add server</b> in the top bar, then drag its role to the top of your staff roles.</div>
</div>
</details>
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
  <label>Delete messages on ban <select name="banDeleteDays">
    ${[[0, "Don't delete any"], [1, 'Last 1 day'], [3, 'Last 3 days'], [7, 'Last 7 days (default)']].map(([v, l]) => `<option value="${v}" ${Number(cfg.banDeleteDays ?? 7) === v ? 'selected' : ''}>${l}</option>`).join('')}
  </select><small>How much of a trapped user's recent message history to wipe when banned. Discord's max is 7 days.</small></label>
  </div>
  <div class="subh">Staff &amp; dashboard access</div>
  <div class="grid2f">
  <label>Staff role (optional) <select name="staffRoleId">${roleOpts(cfg.staffRoleId)}</select>
    <small>Never trapped by the honeypot, and can manage MadHoney here.</small></label>
  <label>Dashboard admin role (optional) <select name="adminRoleId">${roleOpts(cfg.adminRoleId)}</select>
    <small>Dashboard access WITHOUT the honeypot exemption - for helpers.</small></label>
  </div>
  <div class="subh">Verification</div>
  <label class="toggle"><input type="checkbox" name="verificationEnabled" ${verifyOn ? 'checked' : ''}>
    <span>Require members to verify <b style="color:var(--honey)">(recommended)</b><small>This is the whole point of MadHoney. It gates your channels behind the verified role so the honeypot is the <b>only</b> place an unverified account can post, and it hides the honeypot from real members so no human ever gets caught. Turn this off and the honeypot still bans, but it's visible to everyone, so a member could wander in and get banned - you'd be relying only on the warning banner.</small></span></label>
  ${!verifyOn ? '<div class="warnbox">⚠️ <b>Verification is OFF.</b> The honeypot is not hidden from your members, so a human could post in it and get banned. Only the warning banner protects them. We strongly recommend turning verification back on.</div>' : ''}
  <label>Captcha difficulty <select name="captchaDifficulty" ${verifyOn ? '' : 'disabled'}>
    ${[['easy', 'Easy (4 chars, lighter)'], ['normal', 'Normal (5 chars)'], ['hard', 'Hard (6 chars, heavy)']].map(([v, l]) => `<option value="${v}" ${(cfg.captchaDifficulty ?? 'normal') === v ? 'selected' : ''}>${l}</option>`).join('')}
  </select><small>Harder = longer code and more OCR-defeating distortion. Raise it if bots start solving your captcha; lower it if real members struggle.</small></label>
  <label>Verify message <textarea name="verifyText" rows="3" ${verifyOn ? '' : 'disabled'}>${esc(cfg.verifyText || DEFAULT_VERIFY_TEXT)}</textarea>
    <small>Shown above the Verify button.</small></label>
  <div class="subh">Universal ban list</div>
  <label class="toggle"><input type="checkbox" name="banShare" ${cfg.banShare ? 'checked' : ''}>
    <span>Apply the universal ban list to this server<small>Every honeypot catch across all MadHoney servers feeds one list. ON: users on it are banned when they join here (use "Ban from List" below to apply it retroactively). OFF: this server acts only on its own catches - which it keeps either way.</small></span></label>
  <div class="subh">Appeals</div>
  <label class="toggle"><input type="checkbox" name="appealEnabled" ${cfg.appealEnabled ? 'checked' : ''} ${cfg.logChannelId ? '' : 'disabled'}>
    <span>Let banned users appeal by DM<small>When a honeypot ban happens, MadHoney DMs the user offering to appeal. If they do, the request lands in your <b>log channel</b> with Approve (unban + fresh invite) / Deny buttons. A user only ever sees servers they were actually banned from that turned this on - never anything else. ${cfg.logChannelId ? '' : '<b>Set a log channel above first.</b>'}</small></span></label>
  <button class="btn">Save configuration</button>
</form></div>
<div class="card" id="banner"><h2>Honeypot banner</h2>${msgAt('banner')}
<small>Live preview - it re-renders as you tweak. Save, then post it from Actions below.<br><b style="color:var(--honey)">Make it yours.</b> If every MadHoney honeypot looked identical, bots could learn to recognize and skip it. Change the text, colors, font or logo so your banner is one of a kind. (The file is also posted under a random name each time, for the same reason.)</small>
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
  <label>Distortion <select name="banner_distort">
    ${[[0, 'None (clean)'], [1, 'Light'], [2, 'Medium'], [3, 'Heavy']].map(([v, l]) => `<option value="${v}" ${Number(b.distort ?? 0) === v ? 'selected' : ''}>${l}</option>`).join('')}
  </select><small>Garbles the text captcha-style so OCR bots can't read the warning and skip the trap. Higher = harder for machines (and slightly harder for humans). Preview it above before you post.</small></label>
  ${SELF_HOSTED
    ? `<label class="toggle"><input type="checkbox" name="banner_hidecredit" ${b.hideCredit ? 'checked' : ''}>
    <span>Hide the "protected by MadHoney" credit line<small>You're self-hosting, so this is your call. Heads up: a fixed credit string is a fingerprint bots could use to spot the honeypot - customizing the banner is the safer way to stay unique.</small></span></label>`
    : '<label><small>ℹ️ A small "protected by MadHoney" credit line is included on the banner. Want it gone? MadHoney is free and open - self-host it (SELF_HOSTED=true) and you can remove it.</small></label>'}
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
${recent ? `<div class="tscroll"><table class="btable">${recent}</table></div>` : '<div class="empty">No bans logged in this server yet.</div>'}</div>`, { user: sess.user.username });
  }

  // Channel gating picker: classify every channel and let the admin choose
  // exactly which to gate, instead of a blanket "all public".
  async function gatePage(guild, sess, msg = '') {
    const cfg = getGuild(guild.id) ?? {};
    if (!cfg.verifiedRoleId || !cfg.verifyChannelId || !cfg.honeypotChannelId) {
      return layout('MadHoney - Gate', `<div class="subnav"><a class="backbtn" href="/g/${guild.id}"><span class="chev">‹</span> ${esc(guild.name)}</a></div>
        <div class="ghead"><div class="gtitle"><h1>Gate channels</h1></div></div>
        <div class="card"><p>Finish <a href="/g/${guild.id}#config">configuration</a> first - I need the verified role, verify channel and honeypot channel.</p></div>`, { user: sess.user.username });
    }
    const chans = (await classifyChannels(guild, cfg)).sort((a, z) => a.position - z.position);
    const override = cfg.channelTreatment ?? {};
    // Default zone: an explicit saved move wins; else a channel that's already
    // gated, or a standard public channel, defaults to Gate; everything else
    // to Leave.
    const defaultZone = (c) => (c.gated || c.kind === 'public' ? 'gate' : 'leave');
    const zoneOf = (c) => override[c.id] ?? defaultZone(c);

    const verify = chans.find((c) => c.kind === 'verify');
    const honeypot = chans.find((c) => c.kind === 'honeypot');
    const draggable = chans.filter((c) => c.kind !== 'verify' && c.kind !== 'honeypot' && c.canManage);
    const locked = chans.filter((c) => !c.canManage && c.kind !== 'verify' && c.kind !== 'honeypot');

    const catName = (id) => chans.find((c) => c.id === id)?.name;
    const chip = (c) => {
      const tag = c.isCategory ? '<span class="ctag">CATEGORY</span>'
        : c.parentId ? `<span class="ctag">${esc(catName(c.parentId) ?? '')}</span>` : '';
      const kindDot = `<span class="kdot ${c.kind}" title="detected: ${c.kind}"></span>`;
      return `<div class="chip2 ${c.isCategory ? 'iscat' : ''}" draggable="true" data-id="${c.id}" data-cat="${c.parentId ?? ''}" data-type="${c.isCategory ? 'category' : 'channel'}" data-kind="${c.kind}">${kindDot}<span class="cn">${c.isCategory ? '▸ ' : '# '}${esc(c.name)}</span>${tag}</div>`;
    };
    const zone = (id, title, hint) =>
      `<div class="zcol"><div class="zh"><b>${title}</b></div><small>${hint}</small>
        <div class="drop" data-zone="${id}">${draggable.filter((c) => zoneOf(c) === id).map(chip).join('') || '<div class="zempty">drag channels here</div>'}</div></div>`;

    return layout(`MadHoney - Gate ${guild.name}`, `
<div class="subnav">
  <a class="backbtn" href="/g/${guild.id}"><span class="chev">‹</span> ${esc(guild.name)}</a>
  <a class="pillbtn spacer" href="/g/${guild.id}/gate" title="Re-scan channels from Discord"><span class="ico">⟳</span> Re-scan</a>
</div>
<div class="ghead"><div class="gtitle"><h1>Gate channels</h1></div></div>
${msg ? `<div class="card"><pre>${esc(msg)}</pre></div>` : ''}
<div class="card">
<p><b>Drag channels between the columns</b> to choose what MadHoney does with each (or tap a channel to cycle it). The colored dot shows what MadHoney auto-detected - if it guessed wrong, just move the channel. <b>Dragging a category moves all its channels with it</b>, like Discord. Your moves are saved, so the next scan remembers them.</p>
<div class="legend"><span class="kdot public"></span>public <span class="kdot private"></span>private <span class="kdot admin"></span>admin/staff</div>
<form method="post" action="/g/${guild.id}/gate" id="gateForm">
<div class="board">
  ${zone('gate', '🔒 Gate', 'Hidden behind the verified role. Unverified accounts can\'t see these.')}
  ${zone('public', '🌐 Keep public', 'Stays visible to everyone, verified or not.')}
  ${zone('leave', '⬜ Leave as-is', 'MadHoney won\'t touch these at all.')}
</div>
<div class="info">✅ Verify gateway (always public): <b style="color:var(--ink);margin-left:.3rem">#${verify ? esc(verify.name) : '?'}</b></div>
<div class="info">🍯 Honeypot (open to unverified, hidden from verified): <b style="color:var(--ink);margin-left:.3rem">#${honeypot ? esc(honeypot.name) : '?'}</b></div>
${locked.length ? `<div class="info" style="color:#ff8a7d">⚠️ Can't access ${locked.length} channel(s) (hidden from me): ${locked.map((c) => '#' + esc(c.name)).join(', ')}. Grant the MadHoney role View there, or temporarily give it Administrator.</div>` : ''}
<button class="btn" style="margin-top:1rem">Apply</button>
<a class="btn grey" href="/g/${guild.id}" style="margin-top:1rem">Cancel</a>
</form>
<form method="post" action="/g/${guild.id}/gate" style="margin-top:.4rem"><input type="hidden" name="do" value="reset">
  <button class="btn grey" style="background:none;box-shadow:none;color:var(--dim);padding-left:0">↺ Reset to auto-detected</button></form>
</div>
<script>
(() => {
  let drag;
  const wire = (c) => {
    c.addEventListener('dragstart', () => { drag = c; setTimeout(() => c.classList.add('dragging'), 0); });
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); drag = null; });
    c.addEventListener('click', () => { // tap-to-cycle (touch fallback)
      const zones = ['gate', 'public', 'leave'];
      const cur = c.closest('.drop').dataset.zone;
      moveTo(c, document.querySelector('.drop[data-zone="' + zones[(zones.indexOf(cur) + 1) % 3] + '"]'));
    });
  };
  const moveTo = (c, dropzone) => {
    dropzone.querySelector('.zempty')?.remove();
    dropzone.appendChild(c);
    if (c.dataset.type === 'category') // categories carry their channels, like Discord
      document.querySelectorAll('.chip2[data-cat="' + c.dataset.id + '"]').forEach((ch) => dropzone.appendChild(ch));
  };
  document.querySelectorAll('.chip2').forEach(wire);
  document.querySelectorAll('.drop').forEach((z) => {
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); if (drag) moveTo(drag, z); });
  });
  document.getElementById('gateForm').addEventListener('submit', () => {
    document.querySelectorAll('input.zin').forEach((i) => i.remove());
    for (const zn of ['gate', 'public']) {
      document.querySelectorAll('.drop[data-zone="' + zn + '"] .chip2').forEach((c) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.className = 'zin'; i.name = zn; i.value = c.dataset.id;
        document.getElementById('gateForm').appendChild(i);
      });
    }
  });
})();
</script>`, { user: sess.user.username });
  }

  // Public statistics page. Aggregates the ban log into headline numbers and a
  // 30-day trap-activity chart. Logged-in users also see their own servers.
  async function statsPage(sess) {
    const rows = bans();
    const trapped = trappedCount(rows);
    const servers = client.guilds.cache.size;
    // daily catches (ban events, excluding unban reversals), last 30 days
    const DAY = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = today.getTime() - 29 * DAY;
    const buckets = new Map();
    for (let t = start; t <= today.getTime(); t += DAY) buckets.set(new Date(t).toISOString().slice(0, 10), 0);
    let last30 = 0;
    for (const b of rows) {
      if (b.unbanned) continue;
      const day = String(b.at).slice(0, 10);
      if (buckets.has(day)) { buckets.set(day, buckets.get(day) + 1); last30++; }
    }
    const series = [...buckets.entries()].map(([d, c]) => ({ d, c }));
    const max = Math.max(1, ...series.map((s) => s.c));

    // chart geometry (viewBox coords; SVG scales to container width)
    const W = 760, H = 260, padL = 34, padR = 14, padT = 14, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB, n = series.length;
    const xAt = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => padT + (1 - v / max) * plotH;
    const pts = series.map((s, i) => [xAt(i), yAt(s.c)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const area = `M${xAt(0).toFixed(1)},${(padT + plotH).toFixed(1)} ${line.replace(/^M/, 'L')} L${xAt(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
    const yTicks = [0, 0.5, 1].map((f) => Math.round(max * f));
    const grid = yTicks.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(yAt(v) + 4).toFixed(1)}" class="ytick">${v}</text>`).join('');
    const xLabels = series.map((s, i) => ((i % 7 === 0 && i < n - 3) || i === n - 1)
      ? `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" class="xtick">${s.d.slice(5)}</text>` : '').join('');
    const dots = series.map((s, i) => JSON.stringify({ x: +xAt(i).toFixed(1), y: +yAt(s.c).toFixed(1), d: s.d, c: s.c }));

    const mine = sess ? sess.guilds
      .filter((g) => client.guilds.cache.has(g.id))
      .map((g) => ({ name: g.name, n: trappedCount(bans(g.id)), armed: !!getGuild(g.id)?.honeypotChannelId }))
      .filter((g) => sess.guilds.length)
      .sort((a, z) => z.n - a.n) : [];

    return layout('MadHoney - Statistics', `
<style>
  .stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:.9rem;margin:.4rem 0 1.2rem}
  @media(max-width:640px){.stat-row{grid-template-columns:1fr}}
  .stat-tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.3rem}
  .stat-tile .n{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:2.3rem;color:var(--honey);line-height:1}
  .stat-tile .l{color:var(--dim);font-size:.85rem;margin-top:.3rem;text-transform:uppercase;letter-spacing:.06em}
  .chartwrap{position:relative}
  svg.chart{width:100%;height:auto;display:block}
  svg.chart .grid{stroke:var(--line);stroke-width:1}
  svg.chart .ytick,svg.chart .xtick{fill:var(--dim);font:400 11px "Instrument Sans",sans-serif}
  svg.chart .ytick{text-anchor:end}svg.chart .xtick{text-anchor:middle}
  svg.chart .area{fill:var(--honey);opacity:.14}
  svg.chart .line{fill:none;stroke:var(--honey);stroke-width:2}
  svg.chart .cross{stroke:var(--honey);stroke-width:1;opacity:0;stroke-dasharray:3 3}
  svg.chart .cdot{fill:var(--honey);stroke:var(--card);stroke-width:2;opacity:0}
  .ctip{position:absolute;pointer-events:none;background:#0f1216;border:1px solid var(--line);border-radius:7px;padding:.35rem .55rem;font-size:.8rem;opacity:0;transform:translate(-50%,-120%);white-space:nowrap}
  .ctip b{color:var(--honey)}
</style>
<h1 style="margin:1rem 0 .2rem">📊 MadHoney statistics</h1>
<p style="color:var(--dim);margin:0 0 1rem">Live numbers across every server running MadHoney.</p>
<div class="stat-row">
  <div class="stat-tile"><div class="n">${trapped.toLocaleString('en-US')}</div><div class="l">Spammers trapped</div></div>
  <div class="stat-tile"><div class="n">${servers.toLocaleString('en-US')}</div><div class="l">Servers protected</div></div>
  <div class="stat-tile"><div class="n">${last30.toLocaleString('en-US')}</div><div class="l">Caught in last 30 days</div></div>
</div>
<div class="card"><h2>Honeypot catches · last 30 days</h2>
<div class="chartwrap">
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Honeypot catches per day over the last 30 days">
  ${grid}
  <path class="area" d="${area}"/>
  <path class="line" d="${line}"/>
  ${xLabels}
  <line class="cross" id="cx" y1="${padT}" y2="${padT + plotH}"/>
  <circle class="cdot" id="cd" r="4"/>
</svg>
<div class="ctip" id="ctip"></div>
</div>
<small style="color:var(--dim)">Each catch is one honeypot ban event across the network. Deduplicated unique spammers are shown in the tile above.</small>
</div>
${sess && mine.length ? `<div class="card"><h2>Your servers</h2>
<table class="btable"><tr><td class="k">Server</td><td class="k">Status</td><td class="k">Trapped</td></tr>
${mine.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.armed ? '<span class="badge un">armed</span>' : '<span class="k">setup</span>'}</td><td>${g.n}</td></tr>`).join('')}
</table></div>` : ''}
<script>
(() => {
  const pts = [${dots.join(',')}];
  const svg = document.querySelector('svg.chart'), cx = document.getElementById('cx'), cd = document.getElementById('cd'), tip = document.getElementById('ctip'), wrap = document.querySelector('.chartwrap');
  if (!svg || !pts.length) return;
  const vb = ${W};
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const vx = (e.clientX - r.left) / r.width * vb;
    let best = pts[0]; for (const p of pts) if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;
    cx.setAttribute('x1', best.x); cx.setAttribute('x2', best.x); cx.style.opacity = 1;
    cd.setAttribute('cx', best.x); cd.setAttribute('cy', best.y); cd.style.opacity = 1;
    tip.style.opacity = 1;
    tip.style.left = (best.x / vb * r.width) + 'px';
    tip.style.top = (best.y / ${H} * r.height) + 'px';
    tip.innerHTML = '<b>' + best.c + '</b> caught<br>' + best.d;
  });
  svg.addEventListener('mouseleave', () => { cx.style.opacity = cd.style.opacity = tip.style.opacity = 0; });
})();
</script>`, sess ? { user: sess.user.username } : {});
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
        persistSessions();
        return redirect('/', { 'set-cookie': `sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${PUBLIC_URL.startsWith('https') ? '; Secure' : ''}` });
      }
      if (url.pathname === '/logout') {
        sessions.delete(cookies(req).sid);
        persistSessions();
        return redirect('/', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      }

      // ---- legal pages ----
      if (url.pathname === '/terms') return html(layout('MadHoney - Terms of Service', TERMS));
      if (url.pathname === '/privacy') return html(layout('MadHoney - Privacy Policy', PRIVACY));

      // ---- public stats ----
      if (url.pathname === '/stats') {
        const sess = session(req);
        return html(await statsPage(sess), 200);
      }

      // ---- SEO ----
      if (url.pathname === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`User-agent: *\nAllow: /$\nAllow: /stats\nAllow: /terms\nAllow: /privacy\nDisallow: /g/\nDisallow: /login\nDisallow: /callback\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`);
      }
      if (url.pathname === '/sitemap.xml') {
        const pages = ['/', '/stats', '/terms', '/privacy'];
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `<url><loc>${PUBLIC_URL}${p}</loc><changefreq>weekly</changefreq></url>`).join('\n')}\n</urlset>\n`);
      }

      // ---- public assets ----
      if (url.pathname === '/logo.svg' || url.pathname === '/logo.png' || url.pathname === '/og.png') {
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

        return html(layout('MadHoney - Your servers', `
<h1 style="margin:1.1rem 0 .2rem">Your servers</h1>
<p style="color:var(--dim);margin:0 0 1rem">Pick a server to configure MadHoney, or add it to a new one.</p>
${present.length ? `<div class="card"><h2>Your servers <span class="count">${present.length} with MadHoney · ${armedCount} armed</span></h2>
<ul class="slist">${presentTiles}</ul></div>` : `<div class="card"><h2>Get started</h2>
<p>MadHoney isn't in any of your servers yet. Add it to one below, then run through setup here.</p></div>`}
${absent.length ? `<div class="card"><h2>Add MadHoney to another server <span class="count">${absent.length} available</span></h2>
<ul class="slist">${absentTiles}</ul></div>` : ''}
${!manageable.length ? '<div class="card"><p>No servers where you have Manage Server (or a MadHoney staff/admin role). Ask an admin, or add MadHoney to a server you own.</p></div>' : ''}`, { user: sess.user.username }));
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
          for (const k of ['title', 'text', 'accent', 'color', 'bg', 'font', 'logoUrl', 'mentionColor', 'mentionMode', 'distort']) {
            const v = url.searchParams.get(`banner_${k}`);
            if (v !== null) opts[k] = v;
          }
          opts.credit = resolveCredit(url.searchParams.get('banner_hidecredit') === 'on');
          const png = await renderBanner({ ...opts, roleColors: roleColorMap(guild) });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        }
        if (m[2] === '/save' && req.method === 'POST') {
          const form = await body(req);
          if (form.has('banner_title') || form.has('banner_text')) {
            const banner = { ...DEFAULT_BANNER, ...getGuild(guild.id)?.banner };
            for (const k of ['title', 'text', 'accent', 'color', 'bg', 'font', 'logoUrl', 'mentionColor', 'mentionMode', 'distort']) {
              if (form.has(`banner_${k}`)) banner[k] = form.get(`banner_${k}`).trim();
            }
            banner.hideCredit = SELF_HOSTED && form.get('banner_hidecredit') === 'on';
            delete banner.credit; // effective credit is resolved at render time
            saveGuild(guild.id, { banner });
            return html(await guildPage(guild, sess, 'Banner saved. Post it from Actions (or /madhoney deploy in Discord).', 'banner'));
          }
          const patch = {};
          for (const k of ['verifiedRoleId', 'staffRoleId', 'adminRoleId', 'verifyChannelId', 'honeypotChannelId', 'logChannelId', 'verifyText', 'captchaDifficulty']) {
            if (form.has(k)) patch[k] = form.get(k).trim();
          }
          patch.banShare = form.get('banShare') === 'on';
          patch.appealEnabled = form.get('appealEnabled') === 'on';
          patch.verificationEnabled = form.get('verificationEnabled') === 'on';
          if (form.has('banDeleteDays')) patch.banDeleteDays = Math.min(7, Math.max(0, Number(form.get('banDeleteDays')) || 0));
          if (patch.verifyChannelId && patch.verifyChannelId === patch.honeypotChannelId) {
            return html(await guildPage(guild, sess, '❌ Verify and honeypot must be different channels - not saved.', 'config'));
          }
          saveGuild(guild.id, patch);
          return html(await guildPage(guild, sess, 'Saved.', 'config'));
        }
        if (m[2] === '/action' && req.method === 'POST') {
          const form = await body(req);
          const cfg = getGuild(guild.id);
          // Set the honeypot mode - just a config flip, works regardless of the rest.
          const modeMap = { mode_armed: 'armed', mode_review: 'review', mode_disarmed: 'disarmed' };
          if (modeMap[form.get('do')]) {
            const m = modeMap[form.get('do')];
            saveGuild(guild.id, { honeypotMode: m });
            const note = {
              armed: '🍯 Honeypot armed. Anyone who posts in the honeypot channel is now banned.',
              review: '⏸ Honeypot set to Hold for review. Honeypot posts go to your log channel with Ban / Dismiss buttons instead of an instant ban.' + (getGuild(guild.id)?.logChannelId ? '' : ' ⚠️ Set a log channel below so held posts have somewhere to go.'),
              disarmed: '⭘ Honeypot disarmed. The trap is off - nobody gets banned until you arm it again.',
            }[m];
            return html(await guildPage(guild, sess, note, 'top'));
          }
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
              .catch((e) => Object.assign(progress, { finished: true, result: `❌ ${explainError(e.message)}`, at: Date.now() }));
            return html(await guildPage(guild, sess, '', 'actions'));
          }
          const acts = {
            post_verify: () => postVerifyPanel(guild, cfg),
            post_banner: () => postBanner(guild, cfg),
            ungate: () => ungateChannels(guild, cfg),
          };
          const act = acts[form.get('do')];
          if (!act) return html(await guildPage(guild, sess, 'Unknown action.', 'actions'), 400);
          const result = await act().catch((e) => `❌ ${explainError(e.message)}`);
          return html(await guildPage(guild, sess, result, 'actions'));
        }
        if (m[2] === '/gate') {
          const cfg = getGuild(guild.id);
          if (req.method === 'POST') {
            const form = await body(req);
            if (form.get('do') === 'reset') {
              saveGuild(guild.id, { channelTreatment: {} });
              return html(await gatePage(guild, sess, 'Cleared manual moves - channels are back to auto-detected placement.'));
            }
            const result = await gateChannels(guild, cfg, true, { gate: form.getAll('gate'), public: form.getAll('public') }).catch((e) => `❌ ${explainError(e.message)}`);
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
