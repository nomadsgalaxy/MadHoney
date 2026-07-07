// MadHoney web dashboard - Discord OAuth2 login, per-guild config + actions.
// Runs inside the bot process (started from bot.js when CLIENT_ID/SECRET are set).
// Binds 127.0.0.1 and is meant to sit behind a reverse proxy / Cloudflare tunnel.
// ponytail: in-memory sessions (logout on restart), no rate limiting - add both
// only if this ever serves more than a handful of admins.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { PermissionsBitField, ChannelType } from 'discord.js';
const { getGuild, saveGuild, bans, trappedCount } = await import(process.env.MADHONEY_STORE ?? './store.js'); // pluggable store backend
import { postVerifyPanel, postBanner, gateChannels, ungateChannels, classifyChannels, grandfather, grandfatherViaWorkerBee, workerBeeInvite, syncBans, preflight, explainError, roleColorMap, DEFAULT_VERIFY_TEXT } from './actions.js';
import { honeypotMode, staffRoles, adminRoles } from './trap.js';
import { resolvedIncidents } from './incident.js';
import { renderCaptcha, captchaLength, renderPositionCaptcha, POSITION_SLOTS } from './captcha.js';
import { makeCode } from './verify.js';
import { renderBanner, DEFAULT_BANNER, FONTS, SELF_HOSTED } from './banner.js';
import { TERMS, PRIVACY } from './legal.js';
import { SUPPORTED, LOCALE_NAMES, t, resolveLocale } from './i18n.js';

const PORT = Number(process.env.PORT || 8300);
// Bind 127.0.0.1 by default (behind a reverse proxy/tunnel). In a container set
// HOST=0.0.0.0 so a published port can reach it; keep the host-side mapping
// bound to 127.0.0.1 unless you intend to expose it publicly.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
// The Server Members privileged intent is unavailable (e.g. pending Discord's
// review after crossing 10k users): bulk grandfathering can't enumerate members,
// so we surface a warning. Lazy grandfathering still grants the role as members
// post; full coverage returns when the intent is restored.
const GF_DEGRADED = process.env.SERVER_MEMBERS === 'off';
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

// Viewer locale of the in-flight request (the dashboard follows each visitor's
// own language, separate from any guild's bot language). Set at handler entry.
// ponytail: the dashboard serves ~a handful of admins, so a request-scoped
// module global is fine here; thread it explicitly only if it ever needs to
// render concurrent requests in different languages at the same instant.
let curLocale = 'en';
function dashLocale(req) {
  const c = cookies(req).mh_lang; // explicit picker choice wins
  if (c && SUPPORTED.includes(c)) return c;
  return resolveLocale((req.headers['accept-language'] || '').split(',')[0].trim());
}

// Operator maintenance notice: if notice.txt exists next to the app, its text
// banners every dashboard page. Read per request, so writing/removing the file
// applies instantly - no restart. (echo "..." > notice.txt / rm notice.txt)
function maintenanceNotice() {
  try { return readFileSync(new URL('./notice.txt', import.meta.url), 'utf8').trim(); }
  catch { return ''; }
}

// Live running-cost breakdown for the landing page's donate section, driven by
// costs.json next to the app (deployment content, like notice.txt; absent =
// widget hidden). Read per request, so tuning the numbers applies instantly.
// Shape: { kwhRate, serverWatts, share, monthly: { failover, domain } }
// Step chart of the sampled monthly total over time: server-side SVG, single
// honey series on a recessive grid, y anchored at zero (it's a magnitude).
// Hidden until there are two+ samples - a one-point chart is just a dot.
function costChart(hist, dl) {
  if (hist.length < 2) return '';
  const W = 400, H = 110, PL = 34, PR = 8, PT = 8, PB = 18;
  const t0 = Date.parse(hist[0].date), t1 = Date.parse(hist[hist.length - 1].date);
  const yMax = Math.max(...hist.map((h) => h.total)) * 1.15;
  const x = (d) => PL + (t1 === t0 ? 0 : (Date.parse(d) - t0) / (t1 - t0)) * (W - PL - PR);
  const y = (v) => PT + (1 - v / yMax) * (H - PT - PB);
  // step-after: a cost holds until the config changes
  let path = `M${x(hist[0].date).toFixed(1)},${y(hist[0].total).toFixed(1)}`;
  for (let i = 1; i < hist.length; i++) {
    path += `H${x(hist[i].date).toFixed(1)}V${y(hist[i].total).toFixed(1)}`;
  }
  const grid = [0.5, 1].map((f) => `<line x1="${PL}" y1="${y(yMax * f).toFixed(1)}" x2="${W - PR}" y2="${y(yMax * f).toFixed(1)}" stroke="#262b34" stroke-width="1"/>`).join('');
  return `<div class="costchart"><small>${t('landing.costChartTitle', dl)}</small>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('landing.costChartTitle', dl)}">
    ${grid}
    <line x1="${PL}" y1="${y(0)}" x2="${W - PR}" y2="${y(0)}" stroke="#262b34" stroke-width="1"/>
    <path d="${path}" fill="none" stroke="#ffb31a" stroke-width="2"/>
    <text x="${PL - 4}" y="${y(yMax * 1) + 4}" text-anchor="end" font-size="9" fill="#9a948a">$${(yMax).toFixed(0)}</text>
    <text x="${PL - 4}" y="${y(0)}" text-anchor="end" font-size="9" fill="#9a948a">$0</text>
    <text x="${PL}" y="${H - 4}" font-size="9" fill="#9a948a">${hist[0].date}</text>
    <text x="${W - PR}" y="${H - 4}" text-anchor="end" font-size="9" fill="#9a948a">${hist[hist.length - 1].date}</text>
  </svg></div>`;
}

// Branded error page: big honey status code, themed copy (the 404 IS a decoy),
// and a way home. opts.title/opts.body override for context-specific errors
// (e.g. "bot isn't in that server"); opts.login adds a log-in button.
function errPage(code, dl, opts = {}) {
  const K = { 401: 'e401', 403: 'e403', 404: 'e404', 500: 'e500' }[code];
  const title = opts.title ?? (K ? t(`dash.err.${K}Title`, dl) : 'MadHoney');
  const body = opts.body ?? (K ? t(`dash.err.${K}Body`, dl) : '');
  return layout(`${code} - MadHoney`, `
<div class="errpage">
  <div class="errcode">${code}</div>
  <h1>${title}</h1>
  <p>${body}</p>
  <a class="btn" href="/">${t('dash.err.homeBtn', dl)}</a>
  ${opts.login ? ` <a class="btn" href="/login" style="background:transparent;border:1px solid var(--honey);color:var(--honey)">${t('dash.nav.login', dl)}</a>` : ''}
</div>`);
}

function costsWidget(dl) {
  let c;
  try { c = JSON.parse(readFileSync(new URL('./costs.json', import.meta.url), 'utf8')); } catch { return ''; }
  const watts = Math.round((c.serverWatts ?? 0) * (c.share ?? 1));
  const power = (watts / 1000) * 24 * 30.44 * (c.kwhRate ?? 0); // avg hours per month
  // The Cloudflare edge (Workers + D1) is free at this scale but D1 grows with
  // the database, so it's a real line item (driven by costs.json like the rest)
  // shown even at $0 — bump monthly.cloudflare when it crosses into paid and the
  // total + chart follow. `always` keeps it visible where the others hide at $0.
  const items = [
    { l: t('landing.costPower', dl), v: power },
    { l: t('landing.costFailover', dl), v: c.monthly?.failover ?? 0 },
    { l: t('landing.costCloudflare', dl), v: c.monthly?.cloudflare ?? 0, always: true },
    { l: t('landing.costDomain', dl), v: c.monthly?.domain ?? 0 },
  ];
  const rows = items.filter((i) => i.v > 0 || i.always).map((i) => [i.l, i.v]);
  if (!rows.length) return '';
  const total = items.reduce((s, i) => s + i.v, 0);
  const usd = (v) => `$${v.toFixed(2)}`;

  // daily sample of the computed total -> costs-history.jsonl (drives the chart)
  const HIST = new URL('./costs-history.jsonl', import.meta.url);
  const today = new Date().toISOString().slice(0, 10);
  let hist = [];
  try {
    hist = readFileSync(HIST, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* first run */ }
  if (!hist.some((h) => h.date === today)) {
    const entry = { date: today, total: +total.toFixed(2) };
    try { appendFileSync(HIST, JSON.stringify(entry) + '\n'); hist.push(entry); } catch { /* best effort */ }
  }

  // two columns inside the donate card: the maintainer's note on the left, the
  // receipts (table + trend chart) on the right; classes styled in landing.html
  return `<div class="costs">
    <div class="coststory">
      <div class="costlabel">${t('landing.costFrom', dl)}</div>
      <p>${t('landing.costStory', dl)}</p>
    </div>
    <div>
      <div class="costlabel">${t('landing.costTitle', dl)}</div>
      <table class="costtable">
        ${rows.map(([l, v]) => `<tr><td>${l}</td><td>${usd(v)}/mo</td></tr>`).join('')}
        <tr><td>${t('landing.costTotal', dl)}</td><td>${usd(total)}/mo</td></tr>
      </table>
      <small class="costnote">${t('landing.costNote', dl, { watts, rate: `$${(c.kwhRate ?? 0).toFixed(2)}` })}</small>
      ${costChart(hist, dl)}
    </div>
  </div>`;
}

function layout(title, body, opts = {}) {
  const dl = curLocale;
  const notice = maintenanceNotice();
  const invite = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=bot+applications.commands&permissions=268545044`;
  const picker = `<select class="langsel" onchange="document.cookie='mh_lang='+this.value+';path=/;max-age=31536000';location.reload()" aria-label="${esc(t('dash.lang', dl))}">${SUPPORTED.map((c) => `<option value="${c}" ${c === dl ? 'selected' : ''}>${esc(LOCALE_NAMES[c])}</option>`).join('')}</select>`;
  const navRight = opts.user
    ? `<a href="/stats">${t('dash.nav.stats', dl)}</a><span class="navuser">${esc(opts.user)}</span><a href="/logout">${t('dash.nav.logout', dl)}</a>${picker}<a class="btn sm" href="${invite}" target="_blank" rel="noopener">＋ <span class="lg">${t('dash.nav.addServer', dl)}</span></a>`
    : `<a href="/stats">${t('dash.nav.stats', dl)}</a><a href="/login">${t('dash.nav.login', dl)}</a>${picker}<a class="btn sm" href="${invite}" target="_blank" rel="noopener">＋ <span class="lg">${t('dash.nav.addDiscord', dl)}</span></a>`;
  return `<!doctype html><html lang="${dl}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/logo.svg?v=3" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--honey:#ffb31a;--bg:#0a0b0d;--card:#12141a;--ink:#f2ede2;--dim:#9a948a;--line:#262b34;--field:#0f1216;--ok:#7bd88f;--warn2:#ff8a7d}
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
  .langsel{display:inline-block;width:auto;margin:0;background:#0f1216;color:var(--dim);border:1px solid var(--line);border-radius:7px;padding:.25rem .4rem;font:inherit;font-size:.82rem;max-width:8.5rem;cursor:pointer}
  .langsel:hover{border-color:var(--honey);color:var(--ink)}
  @media(max-width:520px){.langsel{max-width:5.5rem}}
  a{color:var(--honey);text-decoration:none} a:hover{text-decoration:underline}
  h1,h2{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;line-height:1.2;letter-spacing:-.02em} h1 span{color:var(--honey)}
  h1 img{height:38px;vertical-align:-8px;margin-right:.4rem}
  h2{font-size:1.4rem;margin:.35rem 0 .45rem}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.2rem 1.4rem;margin:1rem 0}
  .cardsub{color:var(--dim);font-size:.9rem;margin:-.2rem 0 .5rem;max-width:64ch}
  .errpage{text-align:center;padding:4.5rem 1rem 3rem}
  .errpage .errcode{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:6.5rem;line-height:1;color:var(--honey);letter-spacing:-.04em;text-shadow:0 0 60px rgba(255,179,26,.25)}
  .errpage h1{margin:.4rem 0 .7rem}
  .errpage p{color:var(--dim);max-width:46ch;margin:0 auto 1.6rem}
  .errpage .btn{display:inline-block;background:var(--honey);color:#141414;font-weight:700;padding:.55rem 1.1rem;border-radius:9px}
  .errpage .btn:hover{text-decoration:none;transform:translateY(-1px)}
  label{display:block;margin:.7rem 0;font-weight:600}
  input[type=text],textarea,select{display:block;width:100%;padding:.5rem;margin-top:.2rem;background:#0f1216;color:var(--ink);border:1px solid var(--line);border-radius:7px;font:inherit}
  .rolechecks{max-height:220px;overflow-y:auto;background:#0f1216;border:1px solid var(--line);border-radius:7px;padding:.35rem .55rem;margin-top:.3rem}
  .rolechecks label{display:flex;align-items:center;gap:.5rem;margin:.1rem 0;font-weight:400;cursor:pointer}
  .rolechecks input[type=checkbox]{width:auto;margin:0;flex:none}
  input[type=text]:focus,textarea:focus,select:focus{border-color:var(--honey)}
  :focus-visible{outline:2px solid var(--honey);outline-offset:2px}
  select.narrow{max-width:38ch}
  input[type=color]{appearance:none;-webkit-appearance:none;width:100%;height:38px;padding:3px;margin-top:.2rem;background:#0f1216;border:1px solid var(--line);border-radius:7px;cursor:pointer}
  input[type=color]::-webkit-color-swatch-wrapper{padding:2px}
  input[type=color]::-webkit-color-swatch{border:none;border-radius:4px}
  input[type=color]:hover{border-color:var(--honey)}
  .colors{display:grid;grid-template-columns:repeat(3,1fr);gap:.9rem}
  .cols2{display:grid;grid-template-columns:2fr 1fr;gap:.9rem}
  @media (max-width:640px){.colors,.cols2{grid-template-columns:1fr}}
  small{display:block;font-weight:400;color:var(--dim);font-size:.85rem;max-width:62ch;margin-top:.15rem}
  details.more{margin:.25rem 0 .55rem;font-size:.85rem;color:var(--dim);max-width:62ch}
  details.more summary{cursor:pointer;color:var(--honey);font-weight:600;list-style:none;width:max-content}
  details.more summary::-webkit-details-marker{display:none}
  details.more summary::before{content:"▸ "}
  details.more[open] summary::before{content:"▾ "}
  details.more .mb{margin:.35rem 0 0}
  .btn{display:inline-block;padding:.55rem 1.1rem;border:0;border-radius:7px;background:var(--honey);color:#141005;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;margin:.2rem .3rem .2rem 0;transition:transform .12s}
  .btn:hover{transform:translateY(-1px);text-decoration:none}
  .btn.grey{background:#39414c;color:var(--ink)} .btn.red{background:#d64545;color:#fff}
  .btn.danger{background:transparent;color:var(--warn2);border:1px solid rgba(214,69,69,.5)}
  .btn.danger.confirming,.btn.confirming{background:#d64545;color:#fff;border-color:#d64545}
  .btn[disabled]{opacity:.45;cursor:not-allowed;transform:none}
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
  .chip.off{color:#b3ada2}
  .chip.bad{border-color:rgba(214,69,69,.55);color:#ffb3aa}
  .kv{display:flex;gap:.4rem 1.4rem;flex-wrap:wrap;margin:0 0 1rem;font-size:.85rem;color:var(--dim)}
  .kv b{color:var(--ink);font-weight:600}
  .kv a{color:inherit;text-decoration:none} .kv a:hover b{color:var(--honey)}
  .kv .warn{color:#ffb3aa;font-weight:600}
  .gstat{margin-left:auto;text-align:right}
  .gstat a{text-decoration:none;color:inherit;display:block}
  .gstat .n{font-family:"Bricolage Grotesque",sans-serif;font-size:1.9rem;font-weight:800;color:var(--honey);line-height:1;font-variant-numeric:tabular-nums}
  .gstat .l{font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-top:.15rem}
  .subh{font-family:"Bricolage Grotesque",sans-serif;font-weight:700;font-size:.98rem;letter-spacing:0;color:var(--honey);margin:1.6rem 0 .15rem;padding-top:1.1rem;border-top:1px solid var(--line)}
  .subh.first{margin-top:.6rem;padding-top:0;border-top:0}
  .grid2f{display:grid;grid-template-columns:1fr 1fr;gap:0 1.1rem}
  @media(max-width:620px){.grid2f{grid-template-columns:1fr}}
  .toggle{display:flex;gap:.6rem;align-items:center;margin:1rem 0 0;font-weight:600;cursor:pointer;width:max-content;max-width:100%}
  .toggle input{width:22px;height:22px;margin:0;accent-color:var(--honey);flex:0 0 auto}
  .toggle+small,.toggle+small+details.more{margin-left:calc(22px + .6rem)}
  .check{list-style:none;padding:0;margin:.4rem 0 0}
  .check li{display:grid;grid-template-columns:26px 1fr auto;gap:.3rem .7rem;align-items:center;padding:.65rem 0;border-top:1px solid var(--line)}
  .check li:first-child{border-top:0}
  .check .tick{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:800;background:rgba(123,216,143,.15);color:var(--ok)}
  .check .tick.todo{background:var(--field);color:var(--dim);border:1px dashed var(--line)}
  .check .what b{display:block}
  .check .what small{margin-top:.05rem}
  .check .ctl{white-space:nowrap}
  .check .ctl .btn{margin:.1rem 0 .1rem .3rem}
  @media(max-width:560px){.check li{grid-template-columns:26px 1fr}.check .ctl{grid-column:2;white-space:normal}}
  .bgrid{display:grid;grid-template-columns:1fr 280px;gap:1.2rem;align-items:start}
  @media(max-width:720px){.bgrid{grid-template-columns:1fr}}
  .bprev{position:sticky;top:calc(56px + 5px + .8rem)}
  .rolewrap .rcmeta{display:flex;gap:.7rem;align-items:center;margin-top:.3rem}
  .rolewrap .rfilter{margin:0;font-size:.85rem;padding:.35rem .5rem}
  .rolewrap .cnt{font-size:.78rem;color:var(--dim);white-space:nowrap;font-weight:400}
  #savebar{position:fixed;left:0;right:0;bottom:0;z-index:30;background:rgba(18,20,26,.97);border-top:1px solid var(--honey);padding:.6rem 1rem;display:none}
  #savebar.show{display:block}
  #savebar .in{max-width:880px;margin:0 auto;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
  #savebar .msg{font-weight:600}
  #savebar .msg b{color:var(--honey)}
  #savebar .btn{margin:0}
  .notebox{background:rgba(255,179,26,.07);border:1px solid rgba(255,179,26,.35);border-radius:8px;padding:.6rem .85rem;margin:.5rem 0;font-size:.9rem;color:var(--dim);line-height:1.5}
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
  .kdot.public{background:#ffb31a}
  .kdot.private{background:transparent;border:2px solid #8b95a3}
  .kdot.admin{background:#d64545;border-radius:2px;transform:rotate(45deg) scale(.92)}
  .board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.7rem;margin:.4rem 0;align-items:start}
  @media(max-width:720px){.board{grid-template-columns:1fr}}
  .zcol{min-width:0;background:#0f1216;border:1px solid var(--line);border-radius:11px;padding:.6rem .7rem;display:flex;flex-direction:column}
  .zcol .zh b{font-family:"Bricolage Grotesque",sans-serif;font-size:.95rem;white-space:nowrap}
  .zcol small{margin:.1rem 0 .5rem;min-height:3.4em}
  .drop{flex:1;min-width:0;min-height:90px;border:1.5px dashed var(--line);border-radius:9px;padding:.4rem;display:flex;flex-direction:column;gap:.35rem;transition:border-color .12s,background .12s}
  .drop.over{border-color:var(--honey);background:rgba(255,179,26,.06)}
  .zempty{color:var(--dim);font-size:.8rem;text-align:center;padding:1.2rem .3rem}
  .chip2{display:flex;align-items:center;gap:.4rem;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.35rem .5rem;font-size:.85rem;cursor:grab;user-select:none}
  button.chip2{width:100%;text-align:left;font:inherit;color:var(--ink)}
  .visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
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
${notice ? `<div style="background:#3a2b00;border-bottom:1px solid var(--honey);color:var(--ink);padding:.6rem 1rem;text-align:center;font-weight:600">🛠️ ${esc(notice)}</div>` : ''}
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
  // Live member counts without the Server Members intent. guild.memberCount only
  // refreshes at (re)connect and never moves between restarts when member events
  // don't fire (no GuildMembers intent), so the "members protected" total drifts.
  // A low-frequency REST fetch with withCounts populates approximateMemberCount,
  // which needs no privileged intent. Falls back to memberCount if a fetch fails.
  const liveCounts = new Map(); // guildId -> approximate member count
  async function refreshCounts() {
    for (const id of client.guilds.cache.keys()) {
      try {
        const g = await client.guilds.fetch({ guild: id, withCounts: true, force: true });
        if (g.approximateMemberCount != null) liveCounts.set(id, g.approximateMemberCount);
      } catch { /* keep the last good value */ }
    }
  }
  const memberTotal = () => client.guilds.cache.reduce((s, g) => s + (liveCounts.get(g.id) ?? g.memberCount ?? 0), 0);
  refreshCounts();
  setInterval(refreshCounts, 15 * 60 * 1000).unref?.(); // every 15 min; 19 guilds = trivial

  // Minimum viable permission set - see the note in bot.js.
  const inviteUrl = () =>
    `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=bot+applications.commands&permissions=268545044`;

  async function canManage(sess, guildId) {
    if (isAdmin(sess, guildId)) return true;
    const cfg = getGuild(guildId);
    const roleIds = [...staffRoles(cfg), ...adminRoles(cfg)];
    if (!roleIds.length) return false;
    const member = await client.guilds.cache.get(guildId)?.members.fetch(sess.user.id).catch(() => null);
    return !!member && roleIds.some((r) => member.roles.cache.has(r));
  }

  // `at` anchors the result: the message renders inside that card and the
  // form's action fragment scrolls the browser back to it after a POST.
  async function guildPage(guild, sess, msg = '', at = 'top') {
    const dl = curLocale;
    const cfg = getGuild(guild.id) ?? {};
    const msgAt = (key) => (msg && at === key ? `<pre style="margin-top:.6rem">${esc(msg)}</pre>` : '');
    // standing health warning: catches the classic "bot role below verified role" mistake
    const problem = (cfg.verificationEnabled !== false && cfg.verifiedRoleId) ? await preflight(guild, cfg, dl).catch((e) => e.message) : null;
    const b = { ...DEFAULT_BANNER, ...cfg.banner };
    const roles = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id)
      .sort((a, z) => z.position - a.position);
    const chans = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText)
      .sort((a, z) => a.rawPosition - z.rawPosition);
    const roleOpts = (sel) => ['<option value="">(none)</option>', ...roles.map((r) =>
      `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`)].join('');
    const chanOpts = (sel) => ['<option value="">(none)</option>', ...chans.map((c) =>
      `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>#${esc(c.name)}</option>`)].join('');
    // checked-first checkbox list with a filter and a live selected-count: a flat
    // 5-row scroll box hides checked roles below the fold on servers with dozens
    // of roles (and native <select multiple> is ctrl-click hostile on mobile)
    const roleChecks = (name, selected) => {
      const sel = new Set(selected ?? []);
      const ordered = [...roles.values()].sort((a, z) => ((sel.has(z.id) ? 1 : 0) - (sel.has(a.id) ? 1 : 0)) || z.position - a.position);
      return `<div class="rcmeta"><input class="rfilter" type="text" placeholder="${esc(t('dash.guild.filterRoles', dl))}" data-target="rc_${name}" aria-label="${esc(t('dash.guild.filterRoles', dl))}"></div>
      <div class="rolechecks" id="rc_${name}">${ordered.map((r) =>
        `<label><input type="checkbox" name="${name}" value="${r.id}" ${sel.has(r.id) ? 'checked' : ''}>${esc(r.name)}</label>`).join('') || '<span style="color:var(--dim)">(no roles)</span>'}</div>`;
    };
    const banRows = bans(guild.id);
    const trappedHere = trappedCount(banRows);
    const icon = guild.iconURL?.({ size: 128 });
    const avatar = icon ? `<img class="savatar" src="${icon}" alt="">` : `<span class="savatar">${esc([...guild.name][0]?.toUpperCase() ?? '#')}</span>`;
    const roleName = cfg.verifiedRoleId ? (roles.get(cfg.verifiedRoleId)?.name ?? 'set') : null;
    const verifyOn = cfg.verificationEnabled !== false; // default on
    const mode = honeypotMode(cfg); // 'armed' | 'review' | 'disarmed'
    // With verification off there's no verified role/gate to require - just the honeypot.
    const configured = cfg.honeypotChannelId && (!verifyOn || (cfg.verifiedRoleId && cfg.verifyChannelId));

    // Setup progress, derived from config the server already tracks. It both
    // orders the page (checklist leads until done, monitoring leads after) and
    // drives the stateful checklist rows.
    const gatedCount = (cfg.gatedChannels ?? []).length;
    const done = {
      config: Boolean(configured),
      gf: !verifyOn || Boolean(cfg.grandfatheredAt),
      panels: (!verifyOn || Boolean(cfg.verifyPosted)) && Boolean(cfg.bannerPosted),
      gate: !verifyOn || gatedCount > 0,
      arm: mode !== 'disarmed',
    };
    const setupDone = Object.values(done).every(Boolean);

    // shared-list pool size for the ban-sync confirm label (approximate is fine
    // here - syncBans reports exact numbers when it actually runs)
    const allRows = bans();
    const resolvedInc = resolvedIncidents(allRows);
    const poolState = new Map();
    for (const r of allRows) {
      if (r.guildId === guild.id || r.guildId === 'incident' || !r.id) continue;
      poolState.set(`${r.id}:${r.guildId}`, (r.unbanned || r.noShare || (r.incidentId && resolvedInc.has(r.incidentId))) ? null : r.id);
    }
    const poolN = new Set([...poolState.values()].filter(Boolean)).size;

    const modeBtn = (val, label) => `<button class="modeb ${mode === val ? 'active' : ''}" name="do" value="mode_${val}" ${mode === val ? 'disabled' : ''}>${label}</button>`;
    const armDesc = { armed: t('dash.guild.armDescArmed', dl), review: t('dash.guild.armDescReview', dl), disarmed: t('dash.guild.armDescDisarmed', dl) }[mode];
    const armBar = configured ? `<form method="post" action="/g/${guild.id}/action" class="armbar ${mode === 'disarmed' ? 'off' : 'on'}">
      <div><b>${{ armed: t('dash.guild.armTitleArmed', dl), review: t('dash.guild.armTitleReview', dl), disarmed: t('dash.guild.armTitleDisarmed', dl) }[mode]}</b>
      <small>${armDesc}${mode === 'review' && !cfg.logChannelId ? ` <b style="color:#ff8a7d">${t('dash.guild.armReviewNoLog', dl)}</b>` : ''} <a href="#honeypot">${t('dash.guild.honeySettingsLink', dl)} ↓</a></small></div>
      <div class="modebtns">${modeBtn('armed', t('dash.guild.mArmed', dl))}${modeBtn('review', t('dash.guild.mReview', dl))}${modeBtn('disarmed', t('dash.guild.mOff', dl))}</div>
    </form>` : '';

    // headline card shows just the latest 5; the /log page has the full history
    const recent = banRows.slice(-5).reverse().map((x) => {
      const when = esc(String(x.at).replace('T', ' ').slice(0, 16));
      return `<tr><td>${x.unbanned ? `<span class="badge un">${t('dash.guild.badgeUnban', dl)}</span>` : `<span class="badge ban">${t('dash.guild.badgeBan', dl)}</span>`}</td><td>${esc(x.tag ?? x.id)}</td><td class="k">${esc(x.channel ?? '')}</td><td class="k">${when}</td></tr>`;
    }).join('');

    // Deploy/setup checklist: instruction and control share a row, done-ness
    // comes from cfg, and every step stays actionable (re-run / re-post) after
    // setup so the same list doubles as deploy status.
    const step = (isDone, label, hint, ctl) =>
      `<li><span class="tick${isDone ? '' : ' todo'}"${isDone ? ` title="${esc(t('dash.guild.stepDone', dl))}"` : ''}>${isDone ? '✓' : ''}</span><span class="what"><b>${label}</b><small>${hint}</small></span><span class="ctl">${ctl}</span></li>`;
    const gfMins = Math.max(1, Math.ceil((guild.memberCount || 0) / 60));
    const gfConfirm = esc(t('dash.guild.confirmGf', dl, { members: (guild.memberCount || 0).toLocaleString(dl) }));
    const gfBtn = GF_DEGRADED
      ? `<a class="btn sm ${done.gf ? 'grey' : ''}" href="/g/${guild.id}/grandfather-setup">${t('dash.guild.actGrandfather', dl)}</a>`
      : `<button form="actform" name="do" value="grandfather" class="btn sm ${done.gf ? 'grey' : ''}" data-confirm="${gfConfirm}">${done.gf ? t('dash.guild.rerun', dl) : t('dash.guild.actGrandfather', dl)}</button>`;
    const checklist = `<ul class="check">
      ${step(done.config, t('dash.guild.stepConfigL', dl), t('dash.guild.stepConfigH', dl), `<a class="btn sm ${done.config ? 'grey' : ''}" href="#honeypot">${t('dash.guild.configuration', dl)}</a>`)}
      ${verifyOn ? step(done.gf, t('dash.guild.stepGfL', dl), t('dash.guild.gfEstimate', dl, { members: (guild.memberCount || 0).toLocaleString(dl), mins: gfMins }), gfBtn) : ''}
      ${step(done.panels, t('dash.guild.stepPanelsL', dl), t('dash.guild.stepPanelsH', dl),
    `${verifyOn ? `<button form="actform" name="do" value="post_verify" class="btn sm ${cfg.verifyPosted ? 'grey' : ''}">${cfg.verifyPosted ? t('dash.guild.repostPanel', dl) : t('dash.guild.actPostPanel', dl)}</button>` : ''}<button form="actform" name="do" value="post_banner" class="btn sm ${cfg.bannerPosted ? 'grey' : ''}">${cfg.bannerPosted ? t('dash.guild.repostBanner', dl) : t('dash.guild.actPostBanner', dl)}</button>`)}
      ${verifyOn ? step(done.gate, t('dash.guild.stepGateL', dl), t('dash.guild.step4Desc', dl), `<a class="btn sm ${done.gate ? 'grey' : ''}" href="/g/${guild.id}/gate">${t('dash.guild.actGate', dl)}</a>`) : ''}
      ${step(done.arm, t('dash.guild.stepArmL', dl), t('dash.guild.stepArmH', dl), done.arm ? '' : `<button form="actform" name="do" value="mode_armed" class="btn sm">${t('dash.guild.mArmed', dl)}</button>`)}
    </ul>`;
    const guideDetails = `<details class="more"><summary>${t('dash.guild.howItWorks', dl)}</summary>
      <div class="mb">${t('dash.guild.guideP1', dl)}</div><div class="mb">${t('dash.guild.guideP2', dl)}</div>
      <div class="mb">${t('dash.guild.tipNaming', dl)}</div><div class="mb">${t('dash.guild.tipMode', dl)}</div>
      <div class="mb">${t('dash.guild.tipOnboarding', dl)}</div><div class="mb">${t('dash.guild.tipPerm', dl)}</div></details>`;

    const progressBlock = gfJobs.has(guild.id) ? `
<div class="card" id="gfwrap"><progress id="gfbar" max="1" value="0"></progress><small id="gftext">${t('dash.guild.gfStarting', dl)}</small></div>
<script>
(async function poll() {
  try {
    const p = await (await fetch('/g/${guild.id}/progress')).json();
    if (!p.none) {
      const bar = document.getElementById('gfbar'), txt = document.getElementById('gftext');
      bar.max = p.total || 1; bar.value = p.done || 0;
      txt.textContent = p.finished
        ? p.result
        : (p.label || ${JSON.stringify(t('dash.guild.working', dl))}) + ': ' + (p.done ?? 0) + '/' + (p.total ?? '?') + ' · ' + (p.added ?? 0) + ' ' + ${JSON.stringify(t('dash.guild.added', dl))} + ' · ' + (p.skipped ?? 0) + ' ' + ${JSON.stringify(t('dash.guild.skipped', dl))} + (p.failed ? ' · ' + p.failed + ' ' + ${JSON.stringify(t('dash.guild.failed', dl))} : '');
      if (p.finished) { bar.value = bar.max; return; }
    }
  } catch {}
  setTimeout(poll, 1200);
})();
</script>` : '';

    return layout(`MadHoney - ${guild.name}`, `
<div class="subnav">
  <a class="backbtn" href="/"><span class="chev">‹</span> ${t('dash.guild.allServers', dl)}</a>
  <a class="pillbtn spacer" href="/g/${guild.id}?refresh=1" title="${esc(t('dash.guild.refreshTitle', dl))}"><span class="ico">⟳</span> ${t('dash.guild.refresh', dl)}</a>
</div>
<form id="actform" method="post" action="/g/${guild.id}/action"></form>
<div class="ghead" id="top">${avatar}<div class="gtitle"><h1>${esc(guild.name)}</h1></div>
  <div class="gstat"><a href="#activity"><div class="n">${trappedHere}</div><div class="l">${t('dash.guild.trappedChip', dl)}</div></a></div></div>
<div class="kv">
  ${configured ? '' : `<span class="chip bad">${t('dash.guild.needsSetup', dl)}</span>`}
  ${verifyOn ? (roleName ? `<span>${t('dash.guild.verifiedRoleChip', dl)} <b>${esc(roleName)}</b></span>` : '') : `<a href="#verify"><span class="warn">${t('dash.guild.verifOffChip', dl)}</span></a>`}
  <span>${t('dash.guild.universalChip', dl)} <a href="#modcard"><b>${cfg.banShare ? t('dash.guild.on', dl) : t('dash.guild.off', dl)}</b></a></span>
  <span>${t('dash.guild.appeals', dl)} <a href="#modcard"><b>${cfg.appealEnabled ? t('dash.guild.on', dl) : t('dash.guild.off', dl)}</b></a></span>
  <span>${t('dash.guild.kvSetup', dl)} <a href="${setupDone ? '#deploy' : '#setup'}"><b style="color:${setupDone ? 'var(--ok)' : 'var(--warn2)'}">${setupDone ? t('dash.guild.kvComplete', dl) : t('dash.guild.kvIncomplete', dl)}</b></a></span>
</div>
${armBar}
${progressBlock}
${problem ? `<div class="warnbox" style="white-space:pre-wrap"><b>${t('dash.guild.setupProblem', dl)}</b>
${esc(problem)}</div>` : ''}
${msg && at === 'top' ? `<div class="card"><pre>${esc(msg)}</pre></div>` : ''}
${setupDone ? '' : `<div class="card" id="setup"><h2>${t('dash.guild.setupTitle', dl)}</h2>${msgAt('setup')}
${GF_DEGRADED && verifyOn && !done.gf ? `<div class="warnbox">${t('dash.guild.gfIntentWarn', dl, { invite: workerBeeInvite() || '#' })}</div>` : ''}
${checklist}
${guideDetails}
</div>`}
<div class="card" id="activity"><h2>${t('dash.guild.cardActivity', dl)} <span class="count">${t('dash.guild.trappedCount', dl, { n: trappedHere })}</span></h2>${msgAt('activity')}
${recent ? `<div class="tscroll"><table class="btable">${recent}</table></div>
<small style="margin-top:.5rem"><a href="/g/${guild.id}/log">${t('dash.guild.viewFullLog', dl)}</a></small>` : `<div class="empty">${t('dash.guild.noBans', dl)}</div>`}</div>
<div class="card" id="honeypot"><h2>${t('dash.guild.cardHoneypot', dl)}</h2>
<p class="cardsub">${t('dash.guild.cardHoneypotSub', dl)}</p>${msgAt('honeypot')}
<form method="post" action="/g/${guild.id}/save#honeypot" id="hpForm" data-dirty="${esc(t('dash.guild.cardHoneypot', dl))}">
  <input type="hidden" name="back" value="honeypot">
  <div class="grid2f">
  <label>${t('dash.guild.honeypotChannel', dl)} <select name="honeypotChannelId">${chanOpts(cfg.honeypotChannelId)}</select>
    <small>${t('dash.guild.honeypotChannelHint', dl)}</small></label>
  <label>${t('dash.guild.deleteOnBan', dl)} <select name="banDeleteDays">
    ${[[0, t('dash.guild.del0', dl)], [1, t('dash.guild.del1', dl)], [3, t('dash.guild.del3', dl)], [7, t('dash.guild.del7', dl)]].map(([v, l]) => `<option value="${v}" ${Number(cfg.banDeleteDays ?? 7) === v ? 'selected' : ''}>${l}</option>`).join('')}
  </select><small>${t('dash.guild.deleteHint', dl)}</small></label>
  </div>
  <h3 class="subh">${t('dash.guild.honeypotBanner', dl)}</h3>
  <details class="more"><summary>${t('dash.guild.learnMore', dl)}</summary><div class="mb">${t('dash.guild.bannerNote', dl)}</div></details>
  <div class="bgrid">
    <div>
      <label>${t('dash.guild.headline', dl)} <input type="text" name="banner_title" value="${esc(b.title)}"></label>
      <label>${t('dash.guild.bodyText', dl)} <textarea name="banner_text" rows="2">${esc(b.text)}</textarea></label>
      <div class="colors">
        <label>${t('dash.guild.accent', dl)} <input type="color" name="banner_accent" value="${esc(b.accent)}"></label>
        <label>${t('dash.guild.textColor', dl)} <input type="color" name="banner_color" value="${esc(b.color)}"></label>
        <label>${t('dash.guild.background', dl)} <input type="color" name="banner_bg" value="${esc(b.bg)}"></label>
      </div>
      <div class="colors">
        <label>${t('dash.guild.mentionHighlight', dl)} <input type="color" name="banner_mentionColor" value="${esc(b.mentionColor)}">
          <small>${t('dash.guild.mentionHighlightHint', dl)}</small></label>
        <label>${t('dash.guild.roleColoring', dl)} <select name="banner_mentionMode">
          <option value="custom" ${b.mentionMode !== 'role' ? 'selected' : ''}>${t('dash.guild.roleColorCustom', dl)}</option>
          <option value="role" ${b.mentionMode === 'role' ? 'selected' : ''}>${t('dash.guild.roleColorReal', dl)}</option>
        </select>
          <small>${t('dash.guild.roleColoringHint', dl)}</small></label>
      </div>
      <div class="cols2">
        <label>${t('dash.guild.logo', dl)} <input type="text" name="banner_logoUrl" value="${esc(b.logoUrl)}" placeholder="${esc(t('dash.guild.logoPlaceholder', dl))}">
          <small>${t('dash.guild.logoHint', dl)}</small></label>
        <label>${t('dash.guild.font', dl)} <select name="banner_font">${FONTS.map((f) => `<option ${f === b.font ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      </div>
      <label>${t('dash.guild.distortion', dl)} <select name="banner_distort">
        ${[[0, t('dash.guild.distNone', dl)], [1, t('dash.guild.distLight', dl)], [2, t('dash.guild.distMedium', dl)], [3, t('dash.guild.distHeavy', dl)]].map(([v, l]) => `<option value="${v}" ${Number(b.distort ?? 0) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select><small>${t('dash.guild.distortionHint', dl)}</small></label>
      ${SELF_HOSTED ? `<label class="toggle"><input type="checkbox" name="banner_hidecredit" ${b.hideCredit ? 'checked' : ''}> ${t('dash.guild.hideCredit', dl)}</label>
      <small>${t('dash.guild.hideCreditHint', dl)}</small>` : ''}
    </div>
    <div class="bprev"><img class="banner" id="bannerPreview" src="/g/${guild.id}/banner.png?${Date.now()}" alt="banner preview"></div>
  </div>
  <button class="btn">${t('dash.guild.saveHoneypot', dl)}</button>
  <button form="actform" name="do" value="post_banner" class="btn grey">${t('dash.guild.actPostBanner', dl)}</button>
</form></div>
<div class="card" id="verify"><h2>${t('dash.guild.cardVerification', dl)}</h2>
<p class="cardsub">${t('dash.guild.cardVerificationSub', dl)}</p>${msgAt('verify')}
<form method="post" action="/g/${guild.id}/save#verify" data-dirty="${esc(t('dash.guild.cardVerification', dl))}">
  <input type="hidden" name="back" value="verify"><input type="hidden" name="own" value="verificationEnabled autoGate">
  <label class="toggle"><input type="checkbox" name="verificationEnabled" id="vtog" ${verifyOn ? 'checked' : ''} aria-describedby="vhint"> ${t('dash.guild.requireVerify', dl)}&nbsp;<b style="color:var(--honey)">${t('dash.guild.recommended', dl)}</b></label>
  <small id="vhint">${t('dash.guild.requireVerifyShort', dl)}</small>
  <details class="more"><summary>${t('dash.guild.learnMore', dl)}</summary><div class="mb">${t('dash.guild.requireVerifyHint', dl)}</div></details>
  ${!verifyOn ? `<div class="warnbox">${t('dash.guild.verifOffWarn', dl)}</div>` : ''}
  <fieldset id="vfields" ${verifyOn ? '' : 'disabled'} style="border:0;padding:0;margin:0;min-width:0${verifyOn ? '' : ';opacity:.45'}">
    <div class="grid2f">
    <label>${t('dash.guild.verifiedRole', dl)} <select name="verifiedRoleId">${roleOpts(cfg.verifiedRoleId)}</select>
      <small>${t('dash.guild.verifiedRoleHint', dl)}</small></label>
    <label>${t('dash.guild.verifyChannel', dl)} <select name="verifyChannelId">${chanOpts(cfg.verifyChannelId)}</select>
      <small>${t('dash.guild.verifyChannelHint', dl)}</small></label>
    <label>${t('dash.guild.captchaDifficulty', dl)} <select name="captchaDifficulty" onchange="cpvNew()">
      ${[['easy', t('dash.guild.diffEasy', dl)], ['normal', t('dash.guild.diffNormal', dl)], ['hard', t('dash.guild.diffHard', dl)]].map(([v, l]) => `<option value="${v}" ${(cfg.captchaDifficulty ?? 'easy') === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select><small>${t('dash.guild.captchaHint', dl)}</small></label>
    <label>${t('dash.guild.captchaStyle', dl)} <select name="captchaStyle" onchange="cpvNew()">
      ${[['text', t('dash.guild.styleText', dl)], ['position', t('dash.guild.stylePos', dl)], ['choice', t('dash.guild.styleChoice', dl)]].map(([v, l]) => `<option value="${v}" ${(cfg.captchaStyle ?? 'position') === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select><small>${t('dash.guild.captchaStyleHint', dl)}</small></label>
    </div>
    <div style="margin:.4rem 0 .8rem">
      <img id="cpv" src="/g/${guild.id}/captcha.png" alt="captcha preview" style="max-width:100%;border-radius:8px;border:1px solid var(--line)"><br>
      <button type="button" class="btn grey sm" onclick="cpvNew()">${t('dash.guild.captchaPreviewNew', dl)}</button>
      <small>${t('dash.guild.captchaTestHint', dl)}</small>
    </div>
    <label>${t('dash.guild.verifyMessage', dl)} <textarea name="verifyText" rows="3" placeholder="${esc(DEFAULT_VERIFY_TEXT)}">${esc(cfg.verifyText || '')}</textarea>
      <small>${t('dash.guild.verifyMessageHint', dl)}</small></label>
  </fieldset>
  <label class="toggle"><input type="checkbox" name="autoGate" ${cfg.autoGate !== false ? 'checked' : ''} aria-describedby="aghint"> ${t('dash.guild.autoGateLabel', dl)}</label>
  <small id="aghint">${t('dash.guild.autoGateHint', dl)}</small>
  ${SELF_HOSTED ? '' : `<div class="notebox">${t('dash.guild.creditNote', dl)}</div>`}
  <button class="btn">${t('dash.guild.saveVerification', dl)}</button>
  <h3 class="subh" id="deploy">${t('dash.guild.deployStatus', dl)}</h3>
  ${setupDone ? checklist : `<small><a href="#setup">${t('dash.guild.setupTitle', dl)} ↑</a></small>`}
  ${gatedCount ? `<details class="more"><summary>${t('dash.guild.ungateLabel', dl)}</summary><div class="mb">${t('dash.guild.ungateDesc', dl)}<br>
    <button form="actform" name="do" value="ungate" class="btn danger sm" style="margin-top:.5rem" data-confirm="${esc(t('dash.guild.confirmRestore', dl, { n: gatedCount }))}">${t('dash.guild.actRestore', dl)}</button></div></details>` : ''}
</form></div>
<script>function cpvNew(){const s=document.querySelector('[name=captchaStyle]'),d=document.querySelector('[name=captchaDifficulty]');document.getElementById('cpv').src='/g/${guild.id}/captcha.png?style='+encodeURIComponent(s?s.value:'text')+'&diff='+encodeURIComponent(d?d.value:'easy')+'&r='+Math.random()}</script>
<div class="card" id="modcard"><h2>${t('dash.guild.cardModeration', dl)}</h2>
<p class="cardsub">${t('dash.guild.cardModerationSub', dl)}</p>${msgAt('modcard')}
<form method="post" action="/g/${guild.id}/save#modcard" data-dirty="${esc(t('dash.guild.cardModeration', dl))}">
  <input type="hidden" name="back" value="modcard"><input type="hidden" name="own" value="banShare appealEnabled">
  <label>${t('dash.guild.logChannel', dl)} <select name="logChannelId" class="narrow">${chanOpts(cfg.logChannelId)}</select>
    <small>${t('dash.guild.logChannelHint', dl)}</small></label>
  <label class="toggle"><input type="checkbox" name="banShare" id="bltog" ${cfg.banShare ? 'checked' : ''} aria-describedby="blhint"> ${t('dash.guild.applyList', dl)}</label>
  <small id="blhint">${t('dash.guild.applyListShort', dl)}</small>
  <details class="more"><summary>${t('dash.guild.learnMore', dl)}</summary><div class="mb">${t('dash.guild.applyListHint', dl)}${SELF_HOSTED ? ` ${t('dash.guild.applyListSelfHost', dl)}` : ''}</div></details>
  <div style="margin:.2rem 0 .4rem"><button form="actform" name="do" value="ban_sync" id="bansyncBtn" class="btn danger sm" ${cfg.banShare ? '' : 'disabled'} data-confirm="${esc(t('dash.guild.confirmBanSync', dl, { n: poolN }))}">${t('dash.guild.actBanSync', dl)}</button>
  <small id="bansyncWhy"${cfg.banShare ? ' style="display:none"' : ''}>${t('dash.guild.turnOnListFirst', dl)}</small></div>
  <label class="toggle"><input type="checkbox" name="appealEnabled" id="appealToggle" ${cfg.appealEnabled ? 'checked' : ''} aria-describedby="aphint"> ${t('dash.guild.letAppeal', dl)}</label>
  <small id="aphint">${t('dash.guild.letAppealShort', dl)}</small>
  <details class="more"><summary>${t('dash.guild.learnMore', dl)}</summary><div class="mb">${t('dash.guild.letAppealHint', dl)}</div></details>
  <div class="warnbox" id="appealNeedsLog"${cfg.logChannelId ? ' style="display:none"' : ''}>${t('dash.guild.setLogFirst', dl)}</div>
  <button class="btn">${t('dash.guild.saveModeration', dl)}</button>
</form></div>
<div class="card" id="access"><h2>${t('dash.guild.cardAccess', dl)}</h2>
<p class="cardsub">${t('dash.guild.cardAccessSub', dl)}</p>${msgAt('access')}
<form method="post" action="/g/${guild.id}/save#access" data-dirty="${esc(t('dash.guild.cardAccess', dl))}">
  <input type="hidden" name="back" value="access"><input type="hidden" name="own" value="roles">
  <div class="grid2f">
  <div class="rolewrap"><label style="margin-bottom:0">${t('dash.guild.staffRole', dl)} <span class="cnt" data-count="rc_staffRoleIds"></span></label>
    <small>${t('dash.guild.staffRoleHint', dl)}</small>
    ${roleChecks('staffRoleIds', staffRoles(cfg))}</div>
  <div class="rolewrap"><label style="margin-bottom:0">${t('dash.guild.adminRole', dl)} <span class="cnt" data-count="rc_adminRoleIds"></span></label>
    <small>${t('dash.guild.adminRoleHint', dl)}</small>
    ${roleChecks('adminRoleIds', adminRoles(cfg))}</div>
  </div>
  <label>${t('dash.guild.botLanguage', dl)} <select name="locale" class="narrow">
    ${SUPPORTED.map((c) => `<option value="${c}" ${(cfg.locale || 'en') === c ? 'selected' : ''}>${LOCALE_NAMES[c]}</option>`).join('')}
  </select><small>${t('dash.guild.botLanguageHint', dl)}</small></label>
  <button class="btn">${t('dash.guild.saveAccess', dl)}</button>
</form></div>
<div id="savebar"><div class="in"><span class="msg">${t('dash.guild.unsavedIn', dl, { card: '<b id="sbwhere"></b>' })}</span>
<button class="btn sm" id="sbsave" type="button">${t('dash.guild.saveBtn', dl)}</button>
<button class="btn grey sm" id="sbdiscard" type="button">${t('dash.guild.discardBtn', dl)}</button></div></div>
<script>
(() => {
  // banner live preview (debounced). Reads the whole honeypot form; the
  // banner.png endpoint only consumes banner_* params, so extras are harmless.
  const hp = document.getElementById('hpForm'), img = document.getElementById('bannerPreview');
  if (hp && img) { let tm; hp.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => {
    img.src = '/g/${guild.id}/banner.png?' + new URLSearchParams(new FormData(hp)).toString(); }, 250); }); }

  // dirty-state: editing any card shows a sticky save bar naming that card, and
  // navigating away with unsaved edits asks first (cleared on submit)
  const bar = document.getElementById('savebar'), sbw = document.getElementById('sbwhere');
  let dirtyForm = null;
  document.querySelectorAll('form[data-dirty]').forEach((f) => {
    f.addEventListener('input', () => { dirtyForm = f; sbw.textContent = f.dataset.dirty; bar.classList.add('show'); });
    f.addEventListener('submit', () => { dirtyForm = null; bar.classList.remove('show'); });
  });
  document.getElementById('sbsave').addEventListener('click', () => dirtyForm?.requestSubmit());
  document.getElementById('sbdiscard').addEventListener('click', () => { dirtyForm = null; location.reload(); });
  window.addEventListener('beforeunload', (e) => { if (dirtyForm) { e.preventDefault(); e.returnValue = ''; } });

  // two-step confirm on destructive/long-running actions: first click arms the
  // button with the consequence (and count), second click actually submits
  document.querySelectorAll('[data-confirm]').forEach((btn) => {
    const orig = btn.textContent; let armed = false, tm2;
    btn.addEventListener('click', (e) => {
      if (armed) return;
      e.preventDefault(); armed = true; btn.classList.add('confirming'); btn.textContent = btn.dataset.confirm;
      tm2 = setTimeout(() => { armed = false; btn.classList.remove('confirming'); btn.textContent = orig; }, 4000);
    });
  });

  // verification toggle governs its fieldset live (no save round-trip)
  const vtog = document.getElementById('vtog'), vf = document.getElementById('vfields');
  if (vtog && vf) vtog.addEventListener('change', () => { vf.disabled = !vtog.checked; vf.style.opacity = vtog.checked ? '' : '.45'; });

  // ban-from-list needs the list on - disabled with the reason inline
  const bl = document.getElementById('bltog'), bs = document.getElementById('bansyncBtn'), bw = document.getElementById('bansyncWhy');
  if (bl && bs) bl.addEventListener('change', () => { bs.disabled = !bl.checked; bw.style.display = bl.checked ? 'none' : ''; });

  // appeals need a log channel - the dependency is local and loud now
  const log = document.querySelector('[name=logChannelId]'), ap = document.getElementById('appealToggle'), aw = document.getElementById('appealNeedsLog');
  if (log && ap) {
    log.addEventListener('change', () => { const has = !!log.value; aw.style.display = has ? 'none' : ''; if (!has && ap.checked) ap.checked = false; });
    ap.addEventListener('change', () => { if (ap.checked && !log.value) { ap.checked = false; aw.style.display = ''; } });
  }

  // role pickers: filter + live selected-count
  document.querySelectorAll('.rfilter').forEach((inp) => inp.addEventListener('input', () => {
    const q = inp.value.toLowerCase();
    document.getElementById(inp.dataset.target)?.querySelectorAll('label').forEach((l) => { l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  }));
  const counts = () => document.querySelectorAll('[data-count]').forEach((c) => {
    const n = document.getElementById(c.dataset.count)?.querySelectorAll('input:checked').length ?? 0;
    c.textContent = '· ' + ${JSON.stringify(t('dash.guild.selectedCount', dl))}.replace('{n}', n);
  });
  document.querySelectorAll('.rolechecks').forEach((r) => r.addEventListener('change', counts));
  counts();
})();
</script>`, { user: sess.user.username });
  }

  // Full ban/appeal history — the Activity card on the server page shows only
  // the latest 5; this is the detailed log it links to.
  function logPage(guild, sess) {
    const dl = curLocale;
    const rows = bans(guild.id).slice(-200).reverse();
    const table = rows.map((x) => {
      const when = esc(String(x.at).replace('T', ' ').slice(0, 16));
      return `<tr><td>${x.unbanned ? `<span class="badge un">${t('dash.guild.badgeUnban', dl)}</span>` : `<span class="badge ban">${t('dash.guild.badgeBan', dl)}</span>`}</td><td>${esc(x.tag ?? x.id)}</td><td class="k">${esc(x.id ?? '')}</td><td class="k">${esc(x.channel ?? '')}</td><td class="k">${when}</td></tr>`;
    }).join('');
    return layout(`MadHoney - ${t('dash.guild.logTitle', dl)}`, `
<div class="subnav"><a class="backbtn" href="/g/${guild.id}#activity"><span class="chev">‹</span> ${esc(guild.name)}</a></div>
<div class="ghead"><div class="gtitle"><h1>${t('dash.guild.logTitle', dl)}</h1></div></div>
<div class="card">
${table ? `<div class="tscroll"><table class="btable">${table}</table></div>
<small style="margin-top:.5rem">${t('dash.guild.logShowing', dl, { n: rows.length })}</small>` : `<div class="empty">${t('dash.guild.noBans', dl)}</div>`}
</div>`, { user: sess.user.username });
  }

  // Guided WorkerBee setup — shown when an admin clicks "Grandfather Members"
  // while MadHoney's Server Members intent is down. Explains the helper bot,
  // links the invite, and offers a Run button (posts do=grandfather, which the
  // action handler routes through grandfatherViaWorkerBee). Only reachable while
  // GF_DEGRADED; otherwise the step is a normal in-place grandfather button.
  function grandfatherSetupPage(guild, sess) {
    const dl = curLocale;
    const invite = workerBeeInvite() || '#';
    return layout(`MadHoney - ${t('dash.guild.step1Label', dl)}`, `
<div class="subnav"><a class="backbtn" href="/g/${guild.id}#setup"><span class="chev">‹</span> ${esc(guild.name)}</a></div>
<div class="ghead"><div class="gtitle"><h1>${t('dash.guild.step1Label', dl)}</h1></div></div>
<div class="card">
  <div class="warnbox">${t('dash.guild.gfIntentWarn', dl, { invite })}</div>
  <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem;align-items:center">
    <a class="btn grey" href="${invite}" target="_blank" rel="noopener">${t('dash.guild.gfInviteBtn', dl)}</a>
    <form method="post" action="/g/${guild.id}/action" style="margin:0">
      <button class="btn" name="do" value="grandfather">${t('dash.guild.gfRunNow', dl)}</button>
    </form>
  </div>
</div>`, { user: sess.user.username });
  }

  // Channel gating picker: classify every channel and let the admin choose
  // exactly which to gate, instead of a blanket "all public".
  async function gatePage(guild, sess, msg = '') {
    const cfg = getGuild(guild.id) ?? {};
    const dl = curLocale;
    if (!cfg.verifiedRoleId || !cfg.verifyChannelId || !cfg.honeypotChannelId) {
      return layout('MadHoney - Gate', `<div class="subnav"><a class="backbtn" href="/g/${guild.id}"><span class="chev">‹</span> ${esc(guild.name)}</a></div>
        <div class="ghead"><div class="gtitle"><h1>${t('dash.gate.title', dl)}</h1></div></div>
        <div class="card"><p>${t('dash.gate.notConfigBody', dl, { config: `<a href="/g/${guild.id}#honeypot">${t('dash.gate.configLink', dl)}</a>` })}</p></div>`, { user: sess.user.username });
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
      const tag = c.isCategory ? `<span class="ctag">${t('dash.gate.category', dl)}</span>`
        : c.parentId ? `<span class="ctag">${esc(catName(c.parentId) ?? '')}</span>` : '';
      const kindDot = `<span class="kdot ${c.kind}" title="${esc(t('dash.gate.detectedTitle', dl, { kind: c.kind }))}"></span>`;
      // a real <button> so keyboard users can Tab + Enter the tap-to-cycle path
      // that pointer users get via drag; type=button because it sits in gateForm
      return `<button type="button" class="chip2 ${c.isCategory ? 'iscat' : ''}" draggable="true" data-id="${c.id}" data-cat="${c.parentId ?? ''}" data-type="${c.isCategory ? 'category' : 'channel'}" data-kind="${c.kind}" title="${esc(t('dash.gate.detectedTitle', dl, { kind: c.kind }))}">${kindDot}<span class="cn">${c.isCategory ? '▸ ' : '# '}${esc(c.name)}</span>${tag}</button>`;
    };
    const zone = (id, title, hint) =>
      `<div class="zcol"><div class="zh"><b>${title}</b></div><small>${hint}</small>
        <div class="drop" data-zone="${id}">${draggable.filter((c) => zoneOf(c) === id).map(chip).join('') || `<div class="zempty">${t('dash.gate.dragHere', dl)}</div>`}</div></div>`;

    return layout(`MadHoney - Gate ${guild.name}`, `
<div class="subnav">
  <a class="backbtn" href="/g/${guild.id}"><span class="chev">‹</span> ${esc(guild.name)}</a>
  <a class="pillbtn spacer" href="/g/${guild.id}/gate" title="${esc(t('dash.gate.rescanTitle', dl))}"><span class="ico">⟳</span> ${t('dash.gate.rescan', dl)}</a>
</div>
<div class="ghead"><div class="gtitle"><h1>${t('dash.gate.title', dl)}</h1></div></div>
${msg ? `<div class="card"><pre>${esc(msg)}</pre></div>` : ''}
${GF_DEGRADED ? `<div class="warnbox">${t('dash.guild.gfIntentWarn', dl, { invite: workerBeeInvite() || '#' })}</div>` : ''}
${cfg.grandfatherPending
    ? `<div class="warnbox">${t('dash.gate.gfRunningWarn', dl)}</div>`
    : (cfg.verificationEnabled !== false && cfg.verifiedRoleId && !cfg.grandfatheredAt
      ? `<div class="warnbox">${t('dash.gate.gfNotDoneWarn', dl)}</div>` : '')}
<div class="card">
<p>${t('dash.gate.intro', dl)}</p>
<div class="legend"><span class="kdot public"></span>${t('dash.gate.legendPublic', dl)} <span class="kdot private"></span>${t('dash.gate.legendPrivate', dl)} <span class="kdot admin"></span>${t('dash.gate.legendAdmin', dl)}</div>
<form method="post" action="/g/${guild.id}/gate" id="gateForm">
<div class="board">
  ${zone('gate', t('dash.gate.zoneGate', dl), t('dash.gate.zoneGateHint', dl))}
  ${zone('public', t('dash.gate.zonePublic', dl), t('dash.gate.zonePublicHint', dl))}
  ${zone('leave', t('dash.gate.zoneLeave', dl), t('dash.gate.zoneLeaveHint', dl))}
</div>
<div class="info">${t('dash.gate.verifyGateway', dl)} <b style="color:var(--ink);margin-left:.3rem">#${verify ? esc(verify.name) : '?'}</b></div>
<div class="info">${t('dash.gate.honeypotInfo', dl)} <b style="color:var(--ink);margin-left:.3rem">#${honeypot ? esc(honeypot.name) : '?'}</b></div>
${locked.length ? `<div class="info" style="color:#ff8a7d">${t('dash.gate.cantAccess', dl, { n: locked.length, list: locked.map((c) => '#' + esc(c.name)).join(', ') })}</div>` : ''}
<button class="btn" style="margin-top:1rem">${t('dash.gate.apply', dl)}</button>
<a class="btn grey" href="/g/${guild.id}" style="margin-top:1rem">${t('dash.gate.cancel', dl)}</a>
</form>
<form method="post" action="/g/${guild.id}/gate" style="margin-top:.4rem"><input type="hidden" name="do" value="reset">
  <button class="btn grey" style="background:none;box-shadow:none;color:var(--dim);padding-left:0">${t('dash.gate.reset', dl)}</button></form>
<div class="visually-hidden" aria-live="polite" id="gateLive"></div>
</div>
<script>
(() => {
  let drag;
  const zoneNames = { gate: ${JSON.stringify(t('dash.gate.zoneGate', dl))}, public: ${JSON.stringify(t('dash.gate.zonePublic', dl))}, leave: ${JSON.stringify(t('dash.gate.zoneLeave', dl))} };
  const live = document.getElementById('gateLive');
  const movedMsg = ${JSON.stringify(t('dash.gate.movedTo', dl))};
  const wire = (c) => {
    c.addEventListener('dragstart', () => { drag = c; setTimeout(() => c.classList.add('dragging'), 0); });
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); drag = null; });
    c.addEventListener('click', () => { // tap-to-cycle (touch + keyboard: chips are real buttons)
      const zones = ['gate', 'public', 'leave'];
      const cur = c.closest('.drop').dataset.zone;
      moveTo(c, document.querySelector('.drop[data-zone="' + zones[(zones.indexOf(cur) + 1) % 3] + '"]'));
      c.focus(); // moving the node steals focus - hand it back for repeated Enter presses
    });
  };
  const moveTo = (c, dropzone) => {
    dropzone.querySelector('.zempty')?.remove();
    dropzone.appendChild(c);
    if (c.dataset.type === 'category') // categories carry their channels, like Discord
      document.querySelectorAll('.chip2[data-cat="' + c.dataset.id + '"]').forEach((ch) => dropzone.appendChild(ch));
    live.textContent = movedMsg.replace('{channel}', c.querySelector('.cn').textContent.trim()).replace('{zone}', zoneNames[dropzone.dataset.zone] ?? dropzone.dataset.zone);
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
    const dl = curLocale;
    const rows = bans();
    const trapped = trappedCount(rows);
    const servers = client.guilds.cache.size;
    const members = memberTotal();
    // UNIQUE spammers, counted once on the day they were first caught (so a
    // user banned in several servers or re-logged by ban-share isn't double
    // counted). Only users still trapped somewhere are included.
    const stillBanned = new Map(); // `${id}:${gid}` -> banned?
    for (const b of rows) stillBanned.set(`${b.id}:${b.guildId}`, !b.unbanned);
    const trappedUsers = new Set();
    for (const [k, v] of stillBanned) if (v) trappedUsers.add(k.slice(0, k.lastIndexOf(':')));
    const firstSeen = new Map(); // userId -> earliest catch timestamp
    for (const b of rows) {
      if (b.unbanned || !trappedUsers.has(b.id)) continue;
      const cur = firstSeen.get(b.id);
      if (!cur || String(b.at) < cur) firstSeen.set(b.id, String(b.at));
    }
    const DAY = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = today.getTime() - 29 * DAY;
    const buckets = new Map();
    for (let t = start; t <= today.getTime(); t += DAY) buckets.set(new Date(t).toISOString().slice(0, 10), 0);
    let last30 = 0;
    for (const at of firstSeen.values()) {
      const day = at.slice(0, 10);
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

    // Per-server breakdown: ONLY servers the viewer actually staffs/moderates
    // (owner / Manage Server / staff role / dashboard-admin role). Public
    // visitors get the fleet aggregate above and no server names at all.
    const mine = [];
    if (sess) {
      for (const g of sess.guilds) {
        if (!client.guilds.cache.has(g.id)) continue;
        if (await canManage(sess, g.id)) {
          mine.push({ name: g.name, n: trappedCount(bans(g.id)), armed: !!getGuild(g.id)?.honeypotChannelId });
        }
      }
      mine.sort((a, z) => z.n - a.n);
    }

    return layout(t('dash.stats.title', dl), `
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
<h1 style="margin:1rem 0 .2rem">${t('dash.stats.h1', dl)}</h1>
<p style="color:var(--dim);margin:0 0 1rem">${t('dash.stats.subtitle', dl)}</p>
<div class="stat-row">
  <div class="stat-tile"><div class="n">${trapped.toLocaleString('en-US')}</div><div class="l">${t('dash.stats.tileTrapped', dl)}</div></div>
  <div class="stat-tile"><div class="n">${servers.toLocaleString('en-US')}</div><div class="l">${t('dash.stats.tileServers', dl)}</div></div>
  <div class="stat-tile"><div class="n">${members.toLocaleString('en-US')}</div><div class="l">${t('dash.stats.tileMembers', dl)}</div></div>
  <div class="stat-tile"><div class="n">${last30.toLocaleString('en-US')}</div><div class="l">${t('dash.stats.tile30d', dl)}</div></div>
</div>
<div class="card"><h2>${t('dash.stats.chartHeading', dl)}</h2>
<div class="chartwrap">
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('dash.stats.chartAria', dl))}">
  ${grid}
  <path class="area" d="${area}"/>
  <path class="line" d="${line}"/>
  ${xLabels}
  <line class="cross" id="cx" y1="${padT}" y2="${padT + plotH}"/>
  <circle class="cdot" id="cd" r="4"/>
</svg>
<div class="ctip" id="ctip"></div>
</div>
<small style="color:var(--dim)">${t('dash.stats.chartNote', dl)}</small>
</div>
${mine.length ? `<div class="card"><h2>${t('dash.stats.yourServers', dl)} <span class="count">${t('dash.stats.youManage', dl, { n: mine.length })}</span></h2>
<div class="tscroll"><table class="btable"><tr><td class="k">${t('dash.stats.colServer', dl)}</td><td class="k">${t('dash.stats.colStatus', dl)}</td><td class="k">${t('dash.stats.colTrapped', dl)}</td></tr>
${mine.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.armed ? `<span class="badge un">${t('dash.stats.armed', dl)}</span>` : `<span class="k">${t('dash.stats.needsSetup', dl)}</span>`}</td><td>${g.n}</td></tr>`).join('')}
</table></div><small style="color:var(--dim)">${t('dash.stats.onlyYou', dl)}</small></div>` : ''}
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
    tip.innerHTML = '<b>' + best.c + '</b> ' + ${JSON.stringify(t('dash.stats.caught', dl))} + '<br>' + best.d;
  });
  svg.addEventListener('mouseleave', () => { cx.style.opacity = cd.style.opacity = tip.style.opacity = 0; });
})();
</script>`, sess ? { user: sess.user.username } : {});
  }

  const server = createServer(async (req, res) => {
    const html = (s, code = 200, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(s); };
    const redirect = (to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
    const url = new URL(req.url, PUBLIC_URL);
    curLocale = dashLocale(req); // this viewer's language, for every t() below

    try {
      // ---- auth ----
      if (url.pathname === '/login') {
        if (!process.env.CLIENT_SECRET) {
          return html(errPage(503, curLocale, { title: t('dash.err.loginTitle', curLocale), body: t('dash.err.loginBody', curLocale, { add: `<a href="${inviteUrl()}">${t('dash.err.addLink', curLocale)}</a>` }) }), 503);
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
          return html(errPage(400, curLocale, { title: t('dash.err.loginFailed', curLocale), body: t('dash.err.badState', curLocale, { retry: `<a href="/login">${t('dash.err.retry', curLocale)}</a>` }) }), 400);
        }
        const tok = await (await fetch(`${API}/oauth2/token`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${PUBLIC_URL}/callback`,
          }),
        })).json();
        if (!tok.access_token) return html(errPage(400, curLocale, { title: t('dash.err.loginFailed', curLocale), body: t('dash.err.tokenFailed', curLocale, { retry: `<a href="/login">${t('dash.err.retry', curLocale)}</a>` }) }), 400);
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
          const dl = curLocale;
          const picker = `<select class="langsel" onchange="document.cookie='mh_lang='+this.value+';path=/;max-age=31536000';location.reload()" aria-label="${esc(t('dash.lang', dl))}">${SUPPORTED.map((c) => `<option value="${c}" ${c === dl ? 'selected' : ''}>${esc(LOCALE_NAMES[c])}</option>`).join('')}</select>`;
          return html(LANDING
            .replace(/%%L_([\w.]+)%%/g, (_, k) => t('landing.' + k, dl)) // values carry intentional HTML — do not esc()
            .replaceAll('%%LANG%%', dl)
            .replaceAll('%%LANGPICKER%%', picker)
            .replaceAll('%%COSTS%%', costsWidget(dl))
            .replaceAll('%%INVITE%%', inviteUrl())
            .replaceAll('%%GUILDS%%', client.guilds.cache.size.toLocaleString(dl))
            .replaceAll('%%MEMBERS%%', memberTotal().toLocaleString(dl))
            .replaceAll('%%BANS%%', trappedCount().toLocaleString(dl)));
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
          armed(g) ? `<span class="spill armed">${t('dash.home.pillArmed', curLocale)}</span>` : `<span class="spill setup">${t('dash.home.pillSetup', curLocale)}</span>`)).join('');
        const absentTiles = absent.map((g) => tile(g, `${inviteUrl()}&guild_id=${g.id}`, ' target="_blank" rel="noopener"',
          `<span class="spill add">${t('dash.home.pillAdd', curLocale)}</span>`)).join('');
        const armedCount = present.filter(armed).length;

        return html(layout(t('dash.home.title', curLocale), `
<h1 style="margin:1.1rem 0 .2rem">${t('dash.home.h1', curLocale)}</h1>
<p style="color:var(--dim);margin:0 0 1rem">${t('dash.home.subtitle', curLocale)}</p>
${present.length ? `<div class="card"><h2>${t('dash.home.yourServers', curLocale)} <span class="count">${t('dash.home.withCount', curLocale, { n: present.length, armed: armedCount })}</span></h2>
<ul class="slist">${presentTiles}</ul></div>` : `<div class="card"><h2>${t('dash.home.getStarted', curLocale)}</h2>
<p>${t('dash.home.getStartedBody', curLocale)}</p></div>`}
${absent.length ? `<div class="card"><h2>${t('dash.home.addAnother', curLocale)} <span class="count">${t('dash.home.availCount', curLocale, { n: absent.length })}</span></h2>
<ul class="slist">${absentTiles}</ul></div>` : ''}
${!manageable.length ? `<div class="card"><p>${t('dash.home.noServers', curLocale)}</p></div>` : ''}`, { user: sess.user.username }));
      }

      // ---- per-guild ----
      const m = url.pathname.match(/^\/g\/(\d+)(\/save|\/action|\/banner\.png|\/captcha\.png|\/progress|\/gate|\/grandfather-setup|\/log)?$/);
      if (m) {
        const sess = session(req);
        if (!sess) {
          // pages redirect to login; endpoint/asset requests (fetch, <img>)
          // must fail honestly with a 401 instead of bouncing to an HTML form
          if (['/progress', '/banner.png', '/captcha.png', '/save', '/action'].includes(m[2])) {
            return html(errPage(401, curLocale, { login: true }), 401);
          }
          return redirect('/login');
        }
        if (!(await canManage(sess, m[1]))) {
          return html(errPage(403, curLocale), 403);
        }
        const guild = client.guilds.cache.get(m[1]);
        if (!guild) return html(errPage(404, curLocale, { title: t('dash.err.notHereTitle', curLocale), body: t('dash.err.notHereBody', curLocale, { invite: `<a href="${inviteUrl()}&guild_id=${m[1]}" target="_blank" rel="noopener">${t('dash.err.inviteLink', curLocale)}</a>` }) }), 404);

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
          const png = await renderBanner({ ...opts, roleColors: roleColorMap(guild) });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        }
        if (m[2] === '/captcha.png') {
          // live preview for the config form: unsaved style/difficulty come in
          // as query params; the answer is random and never leaves the server
          const diff = url.searchParams.get('diff') || getGuild(guild.id)?.captchaDifficulty || 'easy';
          const style = url.searchParams.get('style') || getGuild(guild.id)?.captchaStyle || 'position';
          const png = style === 'position'
            ? renderPositionCaptcha(1 + Math.floor(Math.random() * POSITION_SLOTS), diff)
            : renderCaptcha(makeCode(captchaLength(diff)), diff);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        }
        if (m[2] === '/save' && req.method === 'POST') {
          // The page is split into per-task cards that each POST only their own
          // fields, so this handler is field-driven: text/select fields patch only
          // when present, checkboxes only when the form DECLARES ownership via the
          // hidden `own` field (an unchecked checkbox submits nothing, so absence
          // alone can't distinguish "off" from "different card").
          const form = await body(req);
          const back = ['honeypot', 'verify', 'modcard', 'access', 'setup'].includes(form.get('back')) ? form.get('back') : 'top';
          const own = new Set((form.get('own') ?? '').split(' ').filter(Boolean));
          const patch = {};
          if (form.has('banner_title') || form.has('banner_text')) {
            const banner = { ...DEFAULT_BANNER, ...getGuild(guild.id)?.banner };
            for (const k of ['title', 'text', 'accent', 'color', 'bg', 'font', 'logoUrl', 'mentionColor', 'mentionMode', 'distort']) {
              if (form.has(`banner_${k}`)) banner[k] = form.get(`banner_${k}`).trim();
            }
            banner.hideCredit = SELF_HOSTED && form.get('banner_hidecredit') === 'on';
            delete banner.credit; // effective credit is resolved at render time
            patch.banner = banner;
          }
          for (const k of ['verifiedRoleId', 'verifyChannelId', 'honeypotChannelId', 'logChannelId', 'verifyText', 'captchaDifficulty', 'captchaStyle', 'locale']) {
            if (form.has(k)) patch[k] = form.get(k).trim();
          }
          if (own.has('roles')) {
            // staff / dashboard-admin roles are multi-select checkboxes; the array
            // is authoritative, so clear the legacy single fields on save
            patch.staffRoleIds = form.getAll('staffRoleIds').filter(Boolean);
            patch.adminRoleIds = form.getAll('adminRoleIds').filter(Boolean);
            patch.staffRoleId = '';
            patch.adminRoleId = '';
          }
          if (own.has('banShare')) patch.banShare = form.get('banShare') === 'on';
          if (own.has('appealEnabled')) {
            // Appeals require a log channel (where Approve/Deny land). Honor the
            // toggle only when the EFFECTIVE log channel after this save is set.
            const effectiveLog = form.has('logChannelId') ? patch.logChannelId : getGuild(guild.id)?.logChannelId;
            patch.appealEnabled = form.get('appealEnabled') === 'on' && Boolean(effectiveLog);
          }
          if (own.has('verificationEnabled')) patch.verificationEnabled = form.get('verificationEnabled') === 'on';
          if (own.has('autoGate')) patch.autoGate = form.get('autoGate') === 'on'; // default on; false = opt-out of auto-gating new channels
          if (form.has('banDeleteDays')) patch.banDeleteDays = Math.min(7, Math.max(0, Number(form.get('banDeleteDays')) || 0));
          const cur = getGuild(guild.id) ?? {};
          const effVerify = patch.verifyChannelId ?? cur.verifyChannelId;
          const effHoney = patch.honeypotChannelId ?? cur.honeypotChannelId;
          if (effVerify && effVerify === effHoney) {
            return html(await guildPage(guild, sess, t('dash.msg.channelClash', curLocale), back));
          }
          saveGuild(guild.id, patch);
          return html(await guildPage(guild, sess, patch.banner ? t('dash.msg.bannerSaved', curLocale) : t('dash.msg.saved', curLocale), back));
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
              armed: t('dash.msg.noteArmed', curLocale),
              review: t('dash.msg.noteReview', curLocale) + (getGuild(guild.id)?.logChannelId ? '' : t('dash.msg.noteReviewNoLog', curLocale)),
              disarmed: t('dash.msg.noteDisarmed', curLocale),
            }[m];
            return html(await guildPage(guild, sess, note, 'top'));
          }
          if (!cfg?.verifiedRoleId || !cfg?.verifyChannelId || !cfg?.honeypotChannelId) {
            return html(await guildPage(guild, sess, t('dash.msg.finishConfig', curLocale), 'setup'));
          }
          // Member-by-member jobs (one API call each) run in the background
          // with a polled progress bar; one job at a time per guild.
          // While MadHoney's Server Members intent is down, route grandfathering
          // through the WorkerBee helper (MadHoney orchestrates it). Same signature
          // + progress shape, so the polled job runner is unchanged.
          const slowJobs = { grandfather: GF_DEGRADED ? grandfatherViaWorkerBee : grandfather, ban_sync: syncBans };
          if (slowJobs[form.get('do')]) {
            if (gfJobs.get(guild.id) && !gfJobs.get(guild.id).finished) {
              return html(await guildPage(guild, sess, t('dash.msg.jobRunning', curLocale), 'top'));
            }
            const progress = { finished: false, at: Date.now() };
            gfJobs.set(guild.id, progress);
            slowJobs[form.get('do')](guild, getGuild(guild.id), progress, curLocale)
              .then((r) => Object.assign(progress, { finished: true, result: r, at: Date.now() }))
              .catch((e) => Object.assign(progress, { finished: true, result: `❌ ${explainError(e.message, curLocale)}`, at: Date.now() }));
            return html(await guildPage(guild, sess, '', 'top'));
          }
          const acts = {
            post_verify: () => postVerifyPanel(guild, cfg, curLocale),
            post_banner: () => postBanner(guild, cfg, curLocale),
            ungate: () => ungateChannels(guild, cfg, curLocale),
          };
          const act = acts[form.get('do')];
          if (!act) return html(await guildPage(guild, sess, t('dash.msg.unknownAction', curLocale), 'top'), 400);
          const result = await act().catch((e) => `❌ ${explainError(e.message, curLocale)}`);
          // land the result message inside the card the action belongs to
          const actAt = { post_verify: 'verify', post_banner: 'honeypot', ungate: 'verify' }[form.get('do')] ?? 'top';
          return html(await guildPage(guild, sess, result, actAt));
        }
        if (m[2] === '/gate') {
          const cfg = getGuild(guild.id);
          if (req.method === 'POST') {
            const form = await body(req);
            if (form.get('do') === 'reset') {
              saveGuild(guild.id, { channelTreatment: {} });
              return html(await gatePage(guild, sess, t('dash.msg.gateReset', curLocale)));
            }
            const result = await gateChannels(guild, cfg, true, { gate: form.getAll('gate'), public: form.getAll('public') }, curLocale).catch((e) => `❌ ${explainError(e.message, curLocale)}`);
            return html(await gatePage(guild, sess, result));
          }
          return html(await gatePage(guild, sess));
        }
        if (m[2] === '/grandfather-setup') {
          return html(grandfatherSetupPage(guild, sess));
        }
        if (m[2] === '/log') {
          return html(logPage(guild, sess));
        }
        if (url.searchParams.get('refresh')) {
          await Promise.all([guild.roles.fetch(), guild.channels.fetch()]).catch(() => {});
          return html(await guildPage(guild, sess, t('dash.msg.refreshed', curLocale)));
        }
        return html(await guildPage(guild, sess));
      }

      html(errPage(404, curLocale), 404);
    } catch (err) {
      console.error('dashboard error:', err);
      html(errPage(500, curLocale), 500);
    }
  });

  server.listen(PORT, HOST, () =>
    console.log(`Dashboard: http://${HOST}:${PORT} → public at ${PUBLIC_URL} (put a reverse proxy/tunnel in front).`),
  );
  return server;
}
