// store.js — the ONLY module that reads or writes storage.
//
// Two backends live behind one API:
//   'plain'     — Step 1: one JSON document under `self.data`. Writes are synchronous.
//   'encrypted' — Step 2: one sealed vault under `self.vault`. Writes are asynchronous,
//                 because encrypting is asynchronous, so they are queued (see flushVault).
// Nothing else in the app knows which is in use, or where the data lives.
//
// Saved document (inside the ciphertext once encrypted):
//   { schemaVersion, settings, categories, transactions }
// Transaction:
//   { id, type, amount, currency, categoryId, subCategoryId, date, note, createdAt, updatedAt, deleted }
//   amount is an integer in the currency's smallest unit. date is a local 'YYYY-MM-DD'.
//   Deleting only sets `deleted: true` (soft delete), which Step 4 sync needs.
//
// While the ledger is locked there is no state and no key in memory: reads return empty
// values and every write throws. The key is only ever a non-extractable CryptoKey.

import {
  defaultCategories, sanitizeCategories, mergeCategories, newId, noteRequired, findMain, findSub, SchemaError,
} from './schema.js';
import { DEFAULT_CURRENCY, isCurrencyCode, currencyInfo, rescale } from './money.js';
import * as vault from './crypto.js';

export const SCHEMA_VERSION = 1;
export class StoreError extends Error {}

const KEY = 'self.data';
const VAULT_KEY = 'self.vault';
const CORRUPT_KEY = 'self.data.corrupt';
const LOCKOUT_KEY = 'self.lockout';
const PROBE_KEY = 'self.probe';
const THEMES = ['system', 'light', 'dark'];
const NOTE_MAX = 500;

/** Minutes of inactivity before auto-lock. 0 means never. */
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 0];
export const MIN_PASSPHRASE = vault.MIN_PASSPHRASE;

let state = null;
let persistent = true;
let recovered = null;
let mode = 'plain';      // 'plain' | 'encrypted'
let locked = false;
let damaged = false;     // a vault is present but unreadable
let key = null;          // CryptoKey — memory only, never persisted in any form
let envelope = null;     // the sealed vault, minus the plaintext it protects
let writeError = null;
const listeners = new Set();

/* ------------------------------------------------------------------ */
/* Backend (the only place that touches localStorage)                  */
/* ------------------------------------------------------------------ */

function readRaw(name) {
  return localStorage.getItem(name);
}

function writeRaw(name, text) {
  try {
    localStorage.setItem(name, text);
  } catch {
    throw new StoreError('Could not save: browser storage is full or blocked. Export a backup to be safe.');
  }
}

const removeRaw = (name) => { try { localStorage.removeItem(name); } catch { /* nothing to do */ } };

/* ------------------------------------------------------------------ */
/* Schema versions and migrations                                      */
/* ------------------------------------------------------------------ */

// MIGRATIONS[n] upgrades a document from version n to n+1. Add one whenever SCHEMA_VERSION goes up.
const MIGRATIONS = {
  // 0 → 1: data that predates versioning or was assembled by hand. Fill in what v1 requires.
  0: (d) => ({
    ...d,
    settings: d.settings ?? {},
    transactions: (d.transactions ?? []).map((t) => ({ deleted: false, ...t })),
  }),
};

/** Bring a parsed document up to SCHEMA_VERSION. Refuses documents from a newer app. */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StoreError('That is not S.E.L.F data.');
  let version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
  if (version > SCHEMA_VERSION) {
    throw new StoreError(`This data was saved by a newer version of S.E.L.F (schema ${version}). Update the app first.`);
  }
  let data = structuredClone(raw);
  while (version < SCHEMA_VERSION) {
    data = MIGRATIONS[version](data);
    version += 1;
    data.schemaVersion = version;
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();

function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

const asIso = (v, fallback) => {
  const t = typeof v === 'string' ? new Date(v) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : fallback;
};

/** → { tx } with every field checked and normalised, or { reason }. */
function cleanTransaction(raw) {
  if (!raw || typeof raw !== 'object') return { reason: 'not an object' };
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(raw.id)) return { reason: 'bad id' };
  if (raw.type !== 'income' && raw.type !== 'expense') return { reason: 'bad type' };
  if (!Number.isSafeInteger(raw.amount) || raw.amount <= 0) return { reason: 'amount must be a whole number above zero' };
  if (!isCurrencyCode(raw.currency)) return { reason: 'bad currency' };
  if (typeof raw.categoryId !== 'string' || !raw.categoryId) return { reason: 'no category' };
  if (raw.subCategoryId != null && typeof raw.subCategoryId !== 'string') return { reason: 'bad sub-category' };
  if (!isRealDate(raw.date)) return { reason: 'bad date' };
  const note = raw.note == null ? '' : raw.note;
  if (typeof note !== 'string' || note.length > NOTE_MAX) return { reason: 'bad note' };
  const created = asIso(raw.createdAt, nowIso());
  return {
    tx: {
      id: raw.id,
      type: raw.type,
      amount: raw.amount,
      currency: raw.currency,
      categoryId: raw.categoryId,
      subCategoryId: raw.subCategoryId ?? null,
      date: raw.date,
      note,
      createdAt: created,
      updatedAt: asIso(raw.updatedAt, created),
      deleted: raw.deleted === true,
    },
  };
}

function cleanSettings(raw = {}) {
  return {
    currency: isCurrencyCode(raw.currency) ? raw.currency : DEFAULT_CURRENCY,
    currencyConfirmed: raw.currencyConfirmed === true,
    privacyMode: raw.privacyMode === true,
    theme: THEMES.includes(raw.theme) ? raw.theme : 'system',
    autoLockMinutes: AUTO_LOCK_CHOICES.includes(raw.autoLockMinutes) ? raw.autoLockMinutes : 5,
    encryptionSkipped: raw.encryptionSkipped === true,
  };
}

/** Validate a migrated document. Bad transactions are skipped (and reported), not fatal. */
function normalize(data) {
  const settings = cleanSettings(data.settings);
  const categories = data.categories === undefined ? defaultCategories() : sanitizeCategories(data.categories);
  const transactions = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of Array.isArray(data.transactions) ? data.transactions : []) {
    const { tx, reason } = cleanTransaction(raw);
    if (!tx) { skipped.push(reason); continue; }
    if (tx.currency !== settings.currency) { skipped.push('different currency'); continue; }
    if (seen.has(tx.id)) { skipped.push('duplicate id'); continue; }
    seen.add(tx.id);
    transactions.push(tx);
  }
  return { data: { schemaVersion: SCHEMA_VERSION, settings, categories, transactions }, skipped };
}

const freshState = () => ({
  schemaVersion: SCHEMA_VERSION,
  settings: cleanSettings(),
  categories: defaultCategories(),
  transactions: [],
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function loadPlain() {
  let text;
  try { text = readRaw(KEY); } catch { persistent = false; return null; }
  if (text == null) return null;
  try {
    return normalize(migrate(JSON.parse(text))).data;
  } catch (err) {
    // Never silently discard something we couldn't read: park it under another key.
    try { localStorage.setItem(CORRUPT_KEY, text); } catch { /* nothing more we can do */ }
    recovered = err.message;
    return null;
  }
}

/** Parse the sealed vault, if there is one. A present-but-broken vault sets `damaged`. */
function loadEnvelope() {
  let text;
  try { text = readRaw(VAULT_KEY); } catch { return null; }
  if (text == null) return null;
  try {
    return vault.validateEnvelope(JSON.parse(text));
  } catch (err) {
    damaged = true;
    recovered = err.message;
    return null;
  }
}

/**
 * Call once at startup. Never decrypts: an encrypted device comes up locked, so a refresh
 * always needs the passphrase again.
 * → { mode, locked, damaged, persistent, recovered }
 */
export function init() {
  persistent = true;
  recovered = null;
  damaged = false;
  writeError = null;
  key = null;
  envelope = null;
  pending = null;
  writeChain = Promise.resolve();
  try {
    localStorage.setItem(PROBE_KEY, '1');
    localStorage.removeItem(PROBE_KEY);
  } catch { persistent = false; }

  const found = persistent ? loadEnvelope() : null;
  if (found || damaged) {
    mode = 'encrypted';
    locked = true;
    envelope = found;
    state = null;
  } else {
    mode = 'plain';
    locked = false;
    state = (persistent ? loadPlain() : null) ?? freshState();
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorageEvent);
  return { mode, locked, damaged, persistent, recovered };
}

async function onStorageEvent(e) {
  if (e.key !== null && e.key !== KEY && e.key !== VAULT_KEY) return;
  if (mode === 'encrypted') {
    if (locked) return;
    const found = loadEnvelope();
    // The vault was removed, or re-keyed in another tab: this tab can no longer read it.
    if (!found || found.salt !== envelope?.salt) { await lock(); return; }
    envelope = found;
    try {
      state = normalize(migrate(await vault.open(key, found.iv, found.ciphertext))).data;
      notify();
    } catch { await lock(); }
    return;
  }
  state = loadPlain() ?? freshState();
  notify();
}

function notify() {
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

let writeChain = Promise.resolve();
let pending = null;

/**
 * Encrypted writes can't be synchronous, so they are queued: the newest document wins and
 * only one encrypt/write runs at a time. A failure is reported through getWriteError()
 * rather than thrown, because by then the caller has long since returned.
 */
function queueVaultWrite(doc) {
  pending = doc;
  writeChain = writeChain.then(flushVault);
  return writeChain;
}

async function flushVault() {
  const doc = pending;
  if (!doc || !key || !envelope) return;
  pending = null;
  try {
    const sealed = await vault.seal(key, doc, envelope.schemaVersion);
    writeRaw(VAULT_KEY, JSON.stringify({ ...envelope, ...sealed }));
    if (writeError) { writeError = null; notify(); }
  } catch (err) {
    writeError = err instanceof StoreError ? err.message : `Could not save your last change: ${err.message}`;
    notify();
  }
}

/** Resolves once every queued encrypted write has landed. */
export const flush = () => writeChain;
export const getWriteError = () => writeError;

/**
 * Guard for everything that reads or writes the open ledger. While locked there is no state
 * at all, so this has to come before any field of it is touched.
 */
function requireOpen() {
  if (locked || !state) throw new StoreError('The ledger is locked.');
}

/** Swap in a new state, persist it, and tell listeners. If saving fails the old state is kept. */
function commit(next) {
  requireOpen();
  if (persistent) {
    // Plain mode writes synchronously and throws on failure, exactly as in Step 1.
    if (mode === 'plain') writeRaw(KEY, JSON.stringify(next));
    else queueVaultWrite(next);
  }
  state = next;
  notify();
}

/* ------------------------------------------------------------------ */
/* Reads (treat the returned objects as read-only)                     */
/* ------------------------------------------------------------------ */

const LOCKED_SETTINGS = Object.freeze(cleanSettings());

export const getState = () => state;
export const getSettings = () => state?.settings ?? LOCKED_SETTINGS;
export const getCategories = () => state?.categories ?? [];
export const getTransactions = () => state?.transactions ?? [];
export const isPersistent = () => persistent;
export const isEncrypted = () => mode === 'encrypted';
export const isLocked = () => locked;
export const isVaultDamaged = () => damaged;
export const isCryptoAvailable = () => vault.isAvailable();
/** Rough size of the saved document (localStorage stores UTF-16, ~2 bytes per character). */
export const approxBytes = () => (state ? JSON.stringify(state).length * 2 : 0);

/* ------------------------------------------------------------------ */
/* Encryption: set up, lock, unlock, re-key                            */
/* ------------------------------------------------------------------ */

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new StoreError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  }
}

const asStoreError = (err) => (err instanceof vault.CryptoError ? new StoreError(err.message) : err);

/** Read back what actually landed in storage, with a key derived afresh from the passphrase. */
async function verifyVault(passphrase, expected) {
  const stored = JSON.parse(readRaw(VAULT_KEY));
  const env = vault.validateEnvelope(stored);
  const proof = await vault.deriveKey(passphrase, env.salt, env.schemaVersion);
  if (!(await vault.checkKey(proof, env.check))) throw new StoreError('The encrypted copy could not be verified.');
  const back = await vault.open(proof, env.iv, env.ciphertext);
  if (JSON.stringify(back) !== JSON.stringify(expected)) throw new StoreError('The encrypted copy did not read back correctly.');
  return env;
}

/**
 * Encrypt what is on this device for the first time (Step 1 data included).
 *
 * The order matters: write the vault, PROVE it decrypts with a freshly derived key, and only
 * then delete the plaintext. If anything fails the vault is removed and the plaintext is left
 * exactly where it was, so a failure can never cost data.
 */
export async function setupEncryption(passphrase) {
  if (mode === 'encrypted') throw new StoreError('This device is already encrypted.');
  if (!persistent) throw new StoreError('This browser is blocking storage, so there is nothing to encrypt.');
  assertPassphrase(passphrase);
  const doc = state;
  try {
    const salt = vault.newSalt();
    const fresh = await vault.deriveKey(passphrase, salt, vault.VAULT_VERSION);
    const check = await vault.makeCheck(fresh, vault.VAULT_VERSION);
    const sealed = await vault.seal(fresh, doc, vault.VAULT_VERSION);
    const env = { schemaVersion: vault.VAULT_VERSION, salt: vault.toBase64(salt), check, ...sealed };
    writeRaw(VAULT_KEY, JSON.stringify(env));
    await verifyVault(passphrase, doc);
    removeRaw(KEY); // the plaintext copy goes only once the vault has proven readable
    mode = 'encrypted';
    locked = false;
    damaged = false;
    key = fresh;
    envelope = env;
    clearFailures();
    notify();
  } catch (err) {
    removeRaw(VAULT_KEY); // leave the device exactly as it was
    throw asStoreError(err);
  }
}

/** Forget the key and the decrypted ledger. Any queued write lands first. */
export async function lock() {
  if (mode !== 'encrypted' || locked) return;
  try { await writeChain; } catch { /* reported through writeError */ }
  key = null;
  state = null;
  pending = null;
  locked = true;
  notify();
}

/**
 * Derive the key and decrypt. The check value is tested first, so a wrong passphrase is
 * reported as such and a right passphrase over damaged data gets its own message.
 */
export async function unlock(passphrase) {
  if (mode !== 'encrypted') throw new StoreError('This device is not encrypted.');
  if (damaged || !envelope) throw new StoreError('The encrypted data on this device is damaged. Restore from a backup.');
  const wait = lockoutRemaining();
  if (wait > 0) throw new StoreError(`Too many attempts. Wait ${Math.ceil(wait / 1000)} seconds and try again.`);

  let candidate;
  try {
    candidate = await vault.deriveKey(passphrase, envelope.salt, envelope.schemaVersion);
  } catch (err) { throw asStoreError(err); }

  if (!(await vault.checkKey(candidate, envelope.check))) {
    recordFailure();
    throw new StoreError('Incorrect passphrase.');
  }

  let doc;
  try {
    doc = await vault.open(candidate, envelope.iv, envelope.ciphertext);
  } catch {
    throw new StoreError('That passphrase is correct, but the saved data is damaged. Restore from your most recent backup.');
  }

  state = normalize(migrate(doc)).data;
  key = candidate;
  locked = false;
  writeError = null;
  clearFailures();
  notify();
}

/** Re-encrypt everything under a new salt and a new key. The old vault is restored on failure. */
export async function changePassphrase(current, next) {
  if (mode !== 'encrypted' || locked) throw new StoreError('Unlock the ledger first.');
  assertPassphrase(next);
  // Captured before the first await: auto-lock can fire part way through this, and locking
  // sets `state` to null. Re-reading it later would seal an empty ledger over a full one.
  const doc = state;
  const proof = await vault.deriveKey(current, envelope.salt, envelope.schemaVersion).catch((err) => { throw asStoreError(err); });
  if (!(await vault.checkKey(proof, envelope.check))) {
    recordFailure();
    throw new StoreError('That is not your current passphrase.');
  }
  try { await writeChain; } catch { /* reported through writeError */ }
  // If the ledger locked while the old passphrase was being checked, stop before touching the
  // vault: the old passphrase keeps working and nothing is lost.
  if (locked) throw new StoreError('The ledger locked before the passphrase could be changed. Unlock and try again.');

  const previous = readRaw(VAULT_KEY);
  try {
    const salt = vault.newSalt();
    const fresh = await vault.deriveKey(next, salt, vault.VAULT_VERSION);
    const check = await vault.makeCheck(fresh, vault.VAULT_VERSION);
    const sealed = await vault.seal(fresh, doc, vault.VAULT_VERSION);
    const env = { schemaVersion: vault.VAULT_VERSION, salt: vault.toBase64(salt), check, ...sealed };
    writeRaw(VAULT_KEY, JSON.stringify(env));
    await verifyVault(next, doc);
    // The envelope always follows what is on disk, so a later unlock uses the new salt. The key
    // only comes back if auto-lock didn't fire while this was running — it must not outlive a lock.
    envelope = env;
    if (!locked) key = fresh;
    clearFailures();
    notify();
  } catch (err) {
    if (previous != null) { try { localStorage.setItem(VAULT_KEY, previous); } catch { /* keep going */ } }
    throw asStoreError(err);
  }
}

/**
 * Erase everything on this device. The only way past a forgotten passphrase, and it is
 * exactly as destructive as it sounds.
 */
export function eraseEverything() {
  removeRaw(VAULT_KEY);
  removeRaw(KEY);
  removeRaw(CORRUPT_KEY);
  removeRaw(LOCKOUT_KEY);
  key = null;
  envelope = null;
  damaged = false;
  mode = 'plain';
  locked = false;
  state = freshState();
  notify();
}

/* ------------------------------------------------------------------ */
/* Wrong-passphrase throttle                                           */
/* ------------------------------------------------------------------ */

// How long to wait after the nth consecutive wrong attempt (indexed by n, so two slips are
// free). This slows a person at the keyboard; it is not the defence against an offline
// attack on a copied file — 600,000 PBKDF2 iterations are.
const DELAYS_MS = [0, 0, 0, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

function readLockout() {
  try {
    const parsed = JSON.parse(readRaw(LOCKOUT_KEY) ?? 'null');
    if (parsed && Number.isInteger(parsed.fails)) return parsed;
  } catch { /* fall through */ }
  return { fails: 0, until: 0 };
}

function recordFailure() {
  const fails = readLockout().fails + 1;
  const wait = DELAYS_MS[Math.min(fails, DELAYS_MS.length - 1)];
  try { localStorage.setItem(LOCKOUT_KEY, JSON.stringify({ fails, until: Date.now() + wait })); } catch { /* best effort */ }
}

const clearFailures = () => removeRaw(LOCKOUT_KEY);

/** Milliseconds still to wait before another attempt is accepted. */
export const lockoutRemaining = () => Math.max(0, (readLockout().until || 0) - Date.now());
export const failedAttempts = () => readLockout().fails;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function updateSettings(patch) {
  requireOpen();
  const settings = cleanSettings({ ...state.settings, ...patch });
  commit({ ...state, settings });
}

/** What changing currency would do — used to warn before it happens. Counts visible transactions. */
export function previewCurrencyChange(code) {
  requireOpen();
  const from = currencyInfo(state.settings.currency).decimals;
  const to = currencyInfo(code).decimals;
  let count = 0;
  let rounded = 0;
  for (const t of state.transactions) {
    if (t.deleted) continue;
    count += 1;
    if (rescale(t.amount, from, to).rounded) rounded += 1;
  }
  return { count, rounded, fromDecimals: from, toDecimals: to };
}

/**
 * Relabel every transaction (deleted ones too) in the new currency WITHOUT converting the value:
 * 50,000 UGX stays 50,000 (stored as 50000 UGX → 5000000 minor units in USD).
 */
export function changeCurrency(code) {
  requireOpen();
  if (!isCurrencyCode(code)) throw new StoreError('That is not a valid currency code.');
  const from = currencyInfo(state.settings.currency).decimals;
  const to = currencyInfo(code).decimals;
  const stamp = nowIso();
  const transactions = state.transactions.map((t) => {
    const { minor } = rescale(t.amount, from, to);
    if (!Number.isSafeInteger(minor)) throw new StoreError('An amount is too large to relabel in that currency.');
    return { ...t, amount: minor, currency: code, updatedAt: stamp };
  });
  commit({ ...state, settings: { ...state.settings, currency: code, currencyConfirmed: true }, transactions });
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

/** Persist a tree produced by the schema.js editors. */
export function saveCategories(categories) {
  requireOpen();
  commit({ ...state, categories: sanitizeCategories(categories) });
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

function checkCategory({ categoryId, subCategoryId, note }) {
  const main = findMain(state.categories, categoryId);
  if (!main) throw new StoreError('Choose a category.');
  if (subCategoryId && !findSub(state.categories, categoryId, subCategoryId)) {
    throw new StoreError('That sub-category does not belong to the chosen category.');
  }
  if (noteRequired(state.categories, categoryId, subCategoryId) && !String(note ?? '').trim()) {
    throw new StoreError('Please add a note: "Other (Specify)" needs a description.');
  }
}

const FIELDS = ['type', 'amount', 'categoryId', 'subCategoryId', 'date', 'note'];
const pick = (obj) => Object.fromEntries(FIELDS.filter((k) => k in obj).map((k) => [k, obj[k]]));

export function addTransaction(input) {
  requireOpen();
  const stamp = nowIso();
  const candidate = {
    subCategoryId: null, note: '', ...pick(input),
    id: newId(), currency: state.settings.currency, createdAt: stamp, updatedAt: stamp, deleted: false,
  };
  candidate.note = String(candidate.note).trim();
  const { tx, reason } = cleanTransaction(candidate);
  if (!tx) throw new StoreError(`Could not save: ${reason}.`);
  checkCategory(tx);
  commit({ ...state, transactions: [...state.transactions, tx] });
  return tx;
}

export function updateTransaction(id, patch) {
  requireOpen();
  const current = state.transactions.find((t) => t.id === id && !t.deleted);
  if (!current) throw new StoreError('That transaction no longer exists.');
  const { tx, reason } = cleanTransaction({ ...current, ...pick(patch), updatedAt: nowIso() });
  if (!tx) throw new StoreError(`Could not save: ${reason}.`);
  tx.note = tx.note.trim();
  checkCategory(tx);
  commit({ ...state, transactions: state.transactions.map((t) => (t.id === id ? tx : t)) });
  return tx;
}

function setDeleted(id, deleted) {
  requireOpen();
  if (!state.transactions.some((t) => t.id === id)) throw new StoreError('That transaction no longer exists.');
  const stamp = nowIso();
  commit({
    ...state,
    transactions: state.transactions.map((t) => (t.id === id ? { ...t, deleted, updatedAt: stamp } : t)),
  });
}

/** Soft delete: the record stays (flagged) so sync can propagate the deletion later. */
export const deleteTransaction = (id) => setDeleted(id, true);
export const restoreTransaction = (id) => setDeleted(id, false);

/* ------------------------------------------------------------------ */
/* Backup: export, validate, preview, import                           */
/* ------------------------------------------------------------------ */

/** The full backup document: settings, category schema, and every transaction (deleted ones too). */
export function exportBackup() {
  requireOpen();
  return {
    app: 'S.E.L.F',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    settings: state.settings,
    categories: state.categories,
    transactions: state.transactions,
  };
}

/**
 * The same backup document, sealed with this device's key: a .self file that only this
 * passphrase opens. Restoring it on another browser needs nothing but the passphrase.
 */
export async function exportEncryptedBackup() {
  if (mode !== 'encrypted' || locked) throw new StoreError('Unlock the ledger first.');
  const sealed = await vault.seal(key, exportBackup(), envelope.schemaVersion);
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    salt: envelope.salt,
    check: envelope.check,
    ...sealed,
  }, null, 2);
}

/** True when this text is a sealed .self file rather than a plain JSON backup. */
export function looksEncrypted(text) {
  try { return vault.isEnvelope(JSON.parse(text)); } catch { return false; }
}

function parseBackupDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.transactions)) {
    throw new StoreError('This does not look like a S.E.L.F backup (no transaction list found).');
  }
  if (raw.app !== undefined && raw.app !== 'S.E.L.F') throw new StoreError('This backup was made by a different app.');
  try {
    const { data, skipped } = normalize(migrate(raw));
    return { backup: data, skipped, exportedAt: asIso(raw.exportedAt, null) };
  } catch (err) {
    if (err instanceof SchemaError) throw new StoreError(`The backup's categories are damaged: ${err.message}`);
    throw err;
  }
}

/**
 * Parse and validate backup text. Throws StoreError with a plain-language reason if the file
 * is unusable; invalid individual records are skipped and counted instead.
 */
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new StoreError('That file is not valid JSON.'); }
  return parseBackupDocument(raw);
}

/** The same, for a sealed .self file. Needs the passphrase that file was written with. */
export async function parseEncryptedBackup(text, passphrase) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new StoreError('That file is not valid JSON.'); }
  let env;
  try { env = vault.validateEnvelope(raw); } catch (err) { throw asStoreError(err); }

  let fileKey;
  try { fileKey = await vault.deriveKey(passphrase, env.salt, env.schemaVersion); } catch (err) { throw asStoreError(err); }
  if (!(await vault.checkKey(fileKey, env.check))) throw new StoreError('Incorrect passphrase for this backup file.');

  let doc;
  try { doc = await vault.open(fileKey, env.iv, env.ciphertext); } catch {
    throw new StoreError('That passphrase is correct, but this backup file is damaged.');
  }
  return parseBackupDocument(doc);
}

/** Compare a parsed backup with what is on this device, for the "Merge or replace?" dialog. */
export function previewImport({ backup, skipped, exportedAt }) {
  requireOpen();
  const local = new Map(state.transactions.map((t) => [t.id, t]));
  let added = 0;
  let updated = 0;
  let same = 0;
  for (const t of backup.transactions) {
    const mine = local.get(t.id);
    if (!mine) added += 1;
    else if (t.updatedAt > mine.updatedAt) updated += 1;
    else same += 1;
  }
  const custom = backup.categories.reduce((n, m) => n + (m.custom ? 1 : 0) + m.subs.filter((s) => s.custom).length, 0);
  return {
    found: backup.transactions.filter((t) => !t.deleted).length,
    removed: backup.transactions.filter((t) => t.deleted).length,
    added, updated, same,
    skipped: skipped.length,
    currency: backup.settings.currency,
    localCurrency: state.settings.currency,
    localCount: state.transactions.filter((t) => !t.deleted).length,
    // Totals add raw amounts, so two currencies can't be merged in this version.
    mergeBlocked: state.transactions.length > 0 && backup.settings.currency !== state.settings.currency,
    customCategories: custom,
    exportedAt,
  };
}

/**
 * Apply a parsed backup.
 *   'replace' — this device becomes exactly the backup.
 *   'merge'   — union by transaction id; on a clash the newer updatedAt wins; categories are unioned.
 *
 * Encryption is a property of the device, not of the backup: whatever passphrase protects this
 * device keeps protecting it afterwards.
 */
export function applyImport({ backup }, mode_) {
  requireOpen();
  if (mode_ === 'replace') {
    commit({
      schemaVersion: SCHEMA_VERSION,
      settings: { ...cleanSettings(backup.settings), currencyConfirmed: true },
      categories: backup.categories,
      transactions: backup.transactions,
    });
    return;
  }
  if (mode_ !== 'merge') throw new StoreError('Unknown import mode.');
  if (state.transactions.length > 0 && backup.settings.currency !== state.settings.currency) {
    throw new StoreError(`The backup is in ${backup.settings.currency} but this device uses ${state.settings.currency}.`);
  }
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  for (const t of backup.transactions) {
    const mine = byId.get(t.id);
    if (!mine || t.updatedAt > mine.updatedAt) byId.set(t.id, t);
  }
  const adoptCurrency = state.transactions.length === 0;
  commit({
    ...state,
    settings: {
      ...state.settings,
      currency: adoptCurrency ? backup.settings.currency : state.settings.currency,
      currencyConfirmed: true,
    },
    categories: mergeCategories(state.categories, backup.categories),
    transactions: [...byId.values()],
  });
}
