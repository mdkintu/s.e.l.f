// money.js — pure money helpers. No DOM, no storage.
//
// Money is ALWAYS an integer count of the currency's smallest unit, never a float:
//   UGX (0 decimals)  50000  → "USh 50,000"
//   USD (2 decimals)  125000 → "$1,250.00"
// The decimal places and symbol are derived from the ISO 4217 code through Intl,
// never typed in by hand.

export const DEFAULT_CURRENCY = 'UGX';

// Largest single amount accepted at entry, in minor units. Keeps a sum of tens of
// thousands of transactions comfortably inside Number.MAX_SAFE_INTEGER.
export const MAX_MINOR = 100_000_000_000;

// Shown first in the picker (East Africa first, then the usual suspects).
const PINNED = ['UGX', 'KES', 'TZS', 'RWF', 'USD', 'EUR', 'GBP', 'ZAR', 'NGN', 'GHS',
  'INR', 'CAD', 'AUD', 'JPY', 'CNY', 'AED'];

// Only used if the browser lacks Intl.supportedValuesOf('currency').
const FALLBACK_CODES = [...PINNED, 'BIF', 'CHF', 'EGP', 'ETB', 'MWK', 'MZN', 'NZD', 'SEK',
  'NOK', 'DKK', 'SGD', 'HKD', 'BRL', 'MXN', 'PKR', 'BDT', 'ZMW', 'SSP', 'SOS', 'CDF'];

export const isCurrencyCode = (code) => typeof code === 'string' && /^[A-Z]{3}$/.test(code);

function userLocale() {
  const nav = globalThis.navigator;
  return nav?.languages?.[0] || nav?.language || 'en';
}

function makeFormat(locale, options) {
  try { return new Intl.NumberFormat(locale, options); }
  catch { return new Intl.NumberFormat('en', options); }
}

// The user's own locale often has no local symbol for a currency ("UGX" instead of
// "USh"). Ask the currency's home locale (en-UG for UGX) for it instead.
function symbolFor(code, locale) {
  for (const loc of [locale, `en-${code.slice(0, 2)}`, 'en']) {
    try {
      const parts = new Intl.NumberFormat(loc, { style: 'currency', currency: code }).formatToParts(0);
      const symbol = parts.find((p) => p.type === 'currency')?.value;
      if (symbol && symbol !== code) return symbol;
    } catch { /* try the next locale */ }
  }
  return code;
}

const infoCache = new Map();

/** { code, name, symbol, decimals, nf } for an ISO 4217 code. Cached. */
export function currencyInfo(code) {
  let info = infoCache.get(code);
  if (info) return info;
  const locale = userLocale();
  const base = { style: 'currency', currency: code };
  const decimals = makeFormat(locale, base).resolvedOptions().maximumFractionDigits;
  const nameIn = (loc) => {
    try { return new Intl.DisplayNames([loc], { type: 'currency' }).of(code) || code; } catch { return code; }
  };
  info = {
    code,
    name: nameIn(locale),
    englishName: nameIn('en'), // so "shilling" finds UGX even when the UI language is not English
    symbol: symbolFor(code, locale),
    decimals,
    nf: makeFormat(locale, { ...base, minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
  };
  infoCache.set(code, info);
  return info;
}

export const decimalsFor = (code) => currencyInfo(code).decimals;

/** 125000 + 2 decimals → "1250.00"; 50000 + 0 decimals → "50000". Integer maths only. */
export function minorToDecimalString(minor, decimals) {
  const negative = minor < 0;
  let digits = String(Math.abs(minor));
  if (decimals > 0) {
    digits = digits.padStart(decimals + 1, '0');
    digits = `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  }
  return negative ? `-${digits}` : digits;
}

/** Format integer minor units for display: 5000000 UGX→"USh 5,000,000", 125000 USD→"$1,250.00". */
export function formatMoney(minor, code) {
  const { nf, symbol, decimals } = currencyInfo(code);
  // Intl accepts an exact decimal string, so no float division ever happens.
  return nf.formatToParts(minorToDecimalString(minor, decimals))
    .map((p) => (p.type === 'currency' ? symbol : p.value))
    .join('');
}

/**
 * Parse what a person typed into integer minor units, using string maths (no floats).
 * Returns { minor } or { error } where error is one of:
 *   empty | invalid | no-decimals | too-many-decimals | zero | too-large
 * Accepts thousands separators of either kind ("1,250.50", "1.250,50", "1 250").
 */
export function parseAmount(input, decimals) {
  const s = String(input ?? '').replace(/[\s  ']/g, '');
  if (s === '') return { error: 'empty' };
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { error: 'invalid' };

  let intDigits = s.replace(/[.,]/g, '');
  let frac = '';
  const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (last !== -1) {
    const sep = s[last];
    const other = sep === '.' ? ',' : '.';
    const before = s.slice(0, last);
    const after = s.slice(last + 1);
    let isDecimal;
    if (before.includes(sep)) {
      if (before.includes(other)) return { error: 'invalid' }; // "1.2,3.4"
      isDecimal = false;                                        // "1,250,000" → all grouping
    } else if (before.includes(other)) {
      isDecimal = true;                                         // "1,250.50" → last one is the point
    } else {
      // A single separator: three digits after it means grouping ("1,250"), unless the
      // currency really has three decimals (KWD).
      isDecimal = !(after.length === 3 && decimals !== 3);
    }
    if (isDecimal) {
      if (after.length > decimals) return { error: decimals === 0 ? 'no-decimals' : 'too-many-decimals' };
      intDigits = before.replace(/[.,]/g, '');
      frac = after;
    }
  }

  const digits = `${intDigits || '0'}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  if (digits.length > 15) return { error: 'too-large' };
  const minor = Number(digits);
  if (minor === 0) return { error: 'zero' };
  if (minor > MAX_MINOR) return { error: 'too-large' };
  return { minor };
}

/**
 * Re-express an amount when the currency's decimal places change, keeping the face value:
 * 50,000 UGX (50000) → 50,000.00 USD (5000000). Going down rounds half up.
 * Returns { minor, rounded } where rounded says whether precision was lost.
 */
export function rescale(minor, fromDecimals, toDecimals) {
  if (toDecimals === fromDecimals) return { minor, rounded: false };
  if (toDecimals > fromDecimals) return { minor: minor * 10 ** (toDecimals - fromDecimals), rounded: false };
  const factor = 10n ** BigInt(fromDecimals - toDecimals);
  const value = BigInt(minor);
  const quotient = value / factor;
  const remainder = value % factor;
  const up = remainder * 2n >= factor;
  return { minor: Number(up ? quotient + 1n : quotient), rounded: remainder !== 0n };
}

/** Every currency the browser knows, pinned ones first, then A–Z. */
export function listCurrencies() {
  let codes;
  try { codes = Intl.supportedValuesOf('currency'); } catch { codes = FALLBACK_CODES; }
  const unique = [...new Set([...PINNED, ...codes])];
  const rank = (c) => { const i = PINNED.indexOf(c); return i === -1 ? PINNED.length : i; };
  unique.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return unique.map((code) => {
    const { name, englishName, symbol, decimals } = currencyInfo(code);
    return { code, name, englishName, symbol, decimals };
  });
}

/** Case-insensitive match on code, name (local or English) or symbol. */
export function searchCurrencies(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.code.toLowerCase().includes(q)
    || c.name.toLowerCase().includes(q)
    || c.englishName.toLowerCase().includes(q)
    || c.symbol.toLowerCase() === q);
}
