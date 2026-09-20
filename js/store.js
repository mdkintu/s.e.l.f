// store.js — the ONLY module that reads or writes storage.
//
// Today the backend is one localStorage key holding one JSON document, so every change is
// atomic. Later steps swap the backend (encrypted blob in Step 2, Supabase in Step 4) by
// changing read()/write() below; nothing else in the app knows where the data lives.
//
// Saved document:
//   { schemaVersion, settings, categories, transactions }
// Transaction:
//   { id, type, amount, currency, categoryId, subCategoryId, date, note, createdAt, updatedAt, deleted }
//   amount is an integer in the currency's smallest unit. date is a local 'YYYY-MM-DD'.
//   Deleting only sets `deleted: true` (soft delete), which Step 4 sync needs.

import {
  defaultCategories, sanitizeCategories, mergeCategories, newId, noteRequired, findMain, findSub, SchemaError,
} from './schema.js';
import { DEFAULT_CURRENCY, isCurrencyCode, currencyInfo, rescale } from './money.js';

export const SCHEMA_VERSION = 1;
export class StoreError extends Error {}

const KEY = 'self.data';
const CORRUPT_KEY = 'self.data.corrupt';
const THEMES = ['system', 'light', 'dark'];
const NOTE_MAX = 500;

let state = null;
let persistent = true;
let recovered = null;
const listeners = new Set();

/* ------------------------------------------------------------------ */
/* Backend (the only place that touches localStorage)                  */
/* ------------------------------------------------------------------ */

function read() {
  return localStorage.getItem(KEY);
}

function write(text) {
  localStorage.setItem(KEY, text);
}

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

function load() {
  let text;
  try { text = read(); } catch { persistent = false; return null; }
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

function onStorageEvent(e) {
  if (e.key !== null && e.key !== KEY) return;
  state = load() ?? freshState();
  notify();
}

/** Call once at startup. → { persistent, recovered } so the UI can warn if storage is unusable. */
export function init() {
  persistent = true;
  recovered = null;
  try {
    localStorage.setItem('self.probe', '1');
    localStorage.removeItem('self.probe');
  } catch { persistent = false; }
  state = (persistent ? load() : null) ?? freshState();
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorageEvent);
  return { persistent, recovered };
}

function notify() {
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Swap in a new state, persist it, and tell listeners. If saving fails the old state is kept. */
function commit(next) {
  if (persistent) {
    try { write(JSON.stringify(next)); } catch {
      throw new StoreError('Could not save: browser storage is full or blocked. Export a backup to be safe.');
    }
  }
  state = next;
  notify();
}

/* ------------------------------------------------------------------ */
/* Reads (treat the returned objects as read-only)                     */
/* ------------------------------------------------------------------ */

export const getState = () => state;
export const getSettings = () => state.settings;
export const getCategories = () => state.categories;
export const getTransactions = () => state.transactions;
export const isPersistent = () => persistent;
/** Rough size of the saved document (localStorage stores UTF-16, ~2 bytes per character). */
export const approxBytes = () => JSON.stringify(state).length * 2;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function updateSettings(patch) {
  const settings = cleanSettings({ ...state.settings, ...patch });
  commit({ ...state, settings });
}

/** What changing currency would do — used to warn before it happens. Counts visible transactions. */
export function previewCurrencyChange(code) {
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
 * Parse and validate backup text. Throws StoreError with a plain-language reason if the file
 * is unusable; invalid individual records are skipped and counted instead.
 */
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new StoreError('That file is not valid JSON.'); }
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

/** Compare a parsed backup with what is on this device, for the "Merge or replace?" dialog. */
export function previewImport({ backup, skipped, exportedAt }) {
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
 */
export function applyImport({ backup }, mode) {
  if (mode === 'replace') {
    commit({
      schemaVersion: SCHEMA_VERSION,
      settings: { ...backup.settings, currencyConfirmed: true },
      categories: backup.categories,
      transactions: backup.transactions,
    });
    return;
  }
  if (mode !== 'merge') throw new StoreError('Unknown import mode.');
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
