// crypto.js — Step 2 encryption. Web Crypto API only: no libraries, no network, no fallbacks.
//
// The threat this defends against: someone who gets at the bytes on the device — a shared
// laptop, a stolen phone, a browser profile copied off a disk, a backup file in cloud storage.
// It does NOT defend against malicious code running inside the page itself (an XSS bug, a
// hostile extension): once the ledger is unlocked, the key is in memory by definition.
//
// Shape of a sealed vault (what goes into localStorage, and into a .self backup file):
//   { schemaVersion, salt, check: { iv, ciphertext }, iv, ciphertext }
// Every binary field is base64. `ciphertext` carries the whole ledger document.
//
// WHY THE PARAMETERS ARE NOT STORED: an attacker holding the file can rewrite anything in it,
// so reading the iteration count back out of the file would let them ask for 1 iteration.
// `schemaVersion` pins the whole suite instead — version 1 means exactly PBKDF2-SHA256 at
// 600,000 iterations and AES-GCM-256, as written in PARAMS below. A future version 2 can
// change them and still open a version 1 vault, because version 1's numbers stay here.

export class CryptoError extends Error {}

/** Minimum passphrase length. A length rule is weak on its own; the strength meter does the rest. */
export const MIN_PASSPHRASE = 8;

/** The suite this build writes. Older versions stay readable through PARAMS. */
export const VAULT_VERSION = 1;

const PARAMS = {
  1: { kdf: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, keyBits: 256, saltBytes: 16, ivBytes: 12 },
};

const CHECK_PLAINTEXT = 'S.E.L.F passphrase check v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function paramsFor(version) {
  const p = PARAMS[version];
  if (!p) throw new CryptoError(`This data uses encryption settings this version of S.E.L.F doesn't know (version ${version}). Update the app.`);
  return p;
}

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

/**
 * Web Crypto only exists in a secure context: https, or localhost. Opened over plain http
 * from another machine (or from a file:// path) there is no crypto.subtle at all.
 */
export const isAvailable = () => typeof globalThis.crypto?.subtle?.deriveKey === 'function';

function requireCrypto() {
  if (!isAvailable()) {
    throw new CryptoError('Encryption needs a secure connection. Open S.E.L.F over https, or from localhost.');
  }
  return globalThis.crypto;
}

/* ------------------------------------------------------------------ */
/* Bytes and base64                                                    */
/* ------------------------------------------------------------------ */

/** Cryptographically strong random bytes. Never Math.random(). */
export function randomBytes(length) {
  return requireCrypto().getRandomValues(new Uint8Array(length));
}

export const newSalt = (version = VAULT_VERSION) => randomBytes(paramsFor(version).saltBytes);

/** Chunked so a large ciphertext can't blow the argument limit of String.fromCharCode. */
export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < view.length; i += CHUNK) binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new CryptoError('Damaged data: not valid base64.');
  let binary;
  try { binary = atob(text); } catch { throw new CryptoError('Damaged data: not valid base64.'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const asBytes = (value) => (value instanceof Uint8Array ? value : fromBase64(value));

/* ------------------------------------------------------------------ */
/* Key derivation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turn a passphrase into an AES-GCM key.
 *
 * The key is created with extractable: false, so the browser will not hand the raw bytes back
 * to anyone — including this code. It lives in memory only and is never written anywhere.
 */
export async function deriveKey(passphrase, salt, version = VAULT_VERSION) {
  const { iterations, hash, keyBits } = paramsFor(version);
  const subtle = requireCrypto().subtle;
  if (typeof passphrase !== 'string' || passphrase === '') throw new CryptoError('Enter your passphrase.');
  const material = await subtle.importKey('raw', encoder.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: asBytes(salt), iterations, hash },
    material,
    { name: 'AES-GCM', length: keyBits },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

/* ------------------------------------------------------------------ */
/* Seal and open                                                       */
/* ------------------------------------------------------------------ */

/** Encrypt a JSON-serialisable value with a fresh random IV. → { iv, ciphertext } (base64). */
export async function seal(key, value, version = VAULT_VERSION) {
  const { ivBytes } = paramsFor(version);
  const iv = randomBytes(ivBytes);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await requireCrypto().subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/**
 * Decrypt and parse. Throws CryptoError if the key is wrong or a single byte has changed:
 * AES-GCM authenticates the ciphertext, so tampering fails loudly instead of returning rubbish.
 */
export async function open(key, iv, ciphertext) {
  let plaintext;
  try {
    plaintext = await requireCrypto().subtle.decrypt({ name: 'AES-GCM', iv: asBytes(iv) }, key, asBytes(ciphertext));
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    throw new CryptoError('Could not decrypt: wrong key, or the data has been altered.');
  }
  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new CryptoError('Decrypted, but the contents are not readable JSON.');
  }
}

/* ------------------------------------------------------------------ */
/* Passphrase check value                                              */
/* ------------------------------------------------------------------ */

/**
 * A known string, encrypted under the same key.
 *
 * AES-GCM would already reject a wrong passphrase on the ledger itself, so this is not what
 * makes a wrong passphrase safe. What it buys is a precise diagnosis: if the check opens but
 * the ledger does not, the passphrase was RIGHT and the stored data is damaged — a completely
 * different message and a completely different remedy (restore a backup, don't retype).
 * It is also quick to test against a candidate key before touching the real payload.
 */
export const makeCheck = (key, version = VAULT_VERSION) => seal(key, CHECK_PLAINTEXT, version);

/** True when this key is the one the check was made with. Never throws on a wrong key. */
export async function checkKey(key, check) {
  if (!check || typeof check !== 'object') return false;
  try {
    return (await open(key, check.iv, check.ciphertext)) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Envelope validation                                                 */
/* ------------------------------------------------------------------ */

const isB64 = (v) => typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);

/** A quick shape test, for telling an encrypted backup from a plain JSON one. */
export function isEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Number.isInteger(value.schemaVersion) && isB64(value.salt) && isB64(value.iv) && isB64(value.ciphertext);
}

/** Validate an envelope's shape and supported version. Returns it, or throws CryptoError. */
export function validateEnvelope(value) {
  if (!isEnvelope(value)) throw new CryptoError('This is not an encrypted S.E.L.F vault.');
  paramsFor(value.schemaVersion);
  const { check } = value;
  if (!check || typeof check !== 'object' || !isB64(check.iv) || !isB64(check.ciphertext)) {
    throw new CryptoError('This vault has no passphrase check value, so it cannot be opened safely.');
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Strength meter                                                      */
/* ------------------------------------------------------------------ */

// Deliberately a rough guide, not a guarantee, and the UI says so. A real estimator needs a
// dictionary far larger than belongs in a no-build app; this catches the common bad habits.
const COMMON = [
  'password', 'passwd', 'pass', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn', 'letmein', 'welcome',
  'admin', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'superman', 'trustno1',
  'abc123', 'sunshine', 'princess', 'shadow', 'master', 'secret', 'hello', 'freedom', 'whatever',
  'money', 'budget', 'finance', 'ledger', 'wallet', 'self', 'bank', 'savings', 'login', 'test',
];

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

const LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

function poolSize(pass) {
  let pool = 0;
  if (/[a-z]/.test(pass)) pool += 26;
  if (/[A-Z]/.test(pass)) pool += 26;
  if (/[0-9]/.test(pass)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pass)) pool += 32;
  if (/[^\x20-\x7e]/.test(pass)) pool += 100; // accented letters, emoji, other scripts
  return Math.max(pool, 2);
}

function hasSequence(lower) {
  for (const row of SEQUENCES) {
    for (let i = 0; i + 4 <= row.length; i += 1) {
      const run = row.slice(i, i + 4);
      if (lower.includes(run) || lower.includes([...run].reverse().join(''))) return true;
    }
  }
  return false;
}

/**
 * → { score 0-4, label, bits, hint }
 * `bits` is an estimate of guessing difficulty BEFORE the 600,000 PBKDF2 iterations, which
 * add roughly 19 bits of work on top for anyone attacking the file offline.
 */
export function passphraseStrength(passphrase) {
  const pass = String(passphrase ?? '');
  if (pass.length < MIN_PASSPHRASE) {
    return { score: 0, label: LABELS[0], bits: 0, hint: `Use at least ${MIN_PASSPHRASE} characters. Four unrelated words work well.` };
  }

  const lower = pass.toLowerCase();
  let bits = pass.length * Math.log2(poolSize(pass));
  const hints = [];

  // Repeats carry far less information than their length suggests ("aaaaaaaa", "abababab").
  const distinct = new Set(pass).size;
  bits *= 0.45 + 0.55 * (distinct / pass.length);

  // Natural language: all lowercase letters and spaces is a strong hint of dictionary words,
  // which the per-character model badly over-rates.
  if (/^[a-z ]+$/.test(pass)) {
    bits *= 0.55;
    if (!pass.includes(' ')) hints.push('Several words separated by spaces are easier to remember and harder to guess.');
  }

  const word = COMMON.find((w) => lower.includes(w));
  if (word) { bits -= 12; hints.push(`"${word}" is one of the first things an attacker tries.`); }
  if (hasSequence(lower)) { bits -= 10; hints.push('Runs like "abcd" or "1234" are guessed early.'); }
  if (/^\d+$/.test(pass)) { bits -= 12; hints.push('Digits only is weak, even when it is long. Add words.'); }
  if (/^(.+?)\1+$/.test(pass)) { bits -= 12; hints.push('A repeated pattern is only as strong as the part that repeats.'); }

  bits = Math.max(0, Math.round(bits));
  const score = bits < 40 ? 1 : bits < 56 ? 2 : bits < 72 ? 3 : 4;
  if (!hints.length) {
    hints.push(score >= 4 ? 'Strong. Write it down and keep it somewhere safe.'
      : score === 3 ? 'Good. One more word would make it stronger.'
        : 'Add length: four unrelated words beat a short password with symbols.');
  }
  return { score, label: LABELS[score], bits, hint: hints[0] };
}
