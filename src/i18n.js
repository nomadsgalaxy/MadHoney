// Tiny i18n layer. Catalogs live in locales/<code>.json (en.json is the source
// of truth); every other locale falls back to English per-key, so a missing or
// half-translated string never breaks - it just shows in English.
//
// Two independent locale sources in the app:
//   - the BOT's Discord messages (replies, panels, DMs, logs) -> the guild's
//     admin-chosen locale (cfg.locale). One language per server.
//   - the DASHBOARD -> the viewer's own preferred language (browser
//     Accept-Language, with a cookie override from the picker). Per person,
//     independent of any server's bot language.
import { readFileSync, existsSync } from 'node:fs';

// Catalog codes we ship. Each needs a locales/<code>.json (except en, the base).
export const SUPPORTED = ['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'uk', 'sv', 'cs'];
// Preview catalogs: selectable in the dashboard picker for proofreading, but not
// offered as a server bot language and exempt from the translation parity test.
// 737-MaxQ = the landing copy rewritten in ASD-STE100 Simplified Technical
// English, so the operator can proofread the style in place on the real site.
export const PREVIEW_LOCALES = ['737-MaxQ'];

// Human names, for the dashboard/command locale picker.
export const LOCALE_NAMES = {
  en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
  'pt-BR': 'Português (BR)', it: 'Italiano', uk: 'Українська', sv: 'Svenska', cs: 'Čeština',
  '737-MaxQ': '737-MaxQ',
};

const DIR = new URL('../locales/', import.meta.url);
const cache = new Map(); // code -> catalog object (loaded once; deploy = restart clears it)
function load(code) {
  if (cache.has(code)) return cache.get(code);
  let data = {};
  try {
    const url = new URL(`${code}.json`, DIR);
    if (existsSync(url)) data = JSON.parse(readFileSync(url, 'utf8'));
  } catch { /* malformed catalog -> fall back to English */ }
  cache.set(code, data);
  return data;
}

// Map any Discord locale (e.g. 'es-ES', 'es-419', 'sv-SE', 'pt-BR') to a shipped
// catalog code. Exact match wins; otherwise match on the base language; else en.
export function resolveLocale(locale) {
  if (!locale) return 'en';
  const l = String(locale);
  if (SUPPORTED.includes(l) || PREVIEW_LOCALES.includes(l)) return l;
  const base = l.split('-')[0];
  return SUPPORTED.find((s) => s === base || s.split('-')[0] === base) || 'en';
}


// A locale code safe to hand to Intl APIs (toLocaleString etc.). Preview
// catalog codes are not valid BCP-47 tags, so they format numbers as English.
export function intlLocale(code) {
  try { new Intl.NumberFormat(code); return code; } catch { return 'en'; }
}
const dig = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// t('verify.success', locale, { guild: 'X' }) -> localized string with {vars}
// interpolated. Falls back to the English value, then to the key itself.
export function t(key, locale = 'en', vars = {}) {
  const code = resolveLocale(locale);
  const str = dig(load(code), key) ?? dig(load('en'), key) ?? key;
  return typeof str === 'string' ? str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`)) : key;
}
