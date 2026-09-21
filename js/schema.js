// schema.js — the category tree (as data) and the customizer logic that edits it.
//
// Everything here is pure: editors take the current tree and return a NEW one, or throw a
// SchemaError. store.js persists the result. Nothing in the UI hardcodes a category.
//
// Shape of the tree (a flat list of main categories, each with its sub-categories):
//   main: { id, type: 'income'|'expense', name, emoji, color, enabled, custom, isSavings, subs: [] }
//   sub : { id, name, emoji, color, enabled, custom, requiresNote }
// Two flags carry rules that would otherwise be hardcoded by name:
//   requiresNote — choosing this sub-category makes the note mandatory ("Other (Specify)")
//   isSavings    — reported separately from spending in the totals ("Savings & Investments")

export class SchemaError extends Error {}

/** Identifier for categories and transactions. Falls back when randomUUID needs a secure context. */
export function newId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ------------------------------------------------------------------ */
/* The default tree                                                    */
/* ------------------------------------------------------------------ */

// A sub-category is a plain string, or { name, requiresNote } when it needs a flag.
const OTHER = { name: 'Other (Specify)', requiresNote: true };

const DEFAULT_TREE = [
  // INCOME
  { key: 'employment', type: 'income', name: 'Employment Income', emoji: '💼', color: '#14b8a6',
    subs: ['Salary / Wages', 'Bonuses', 'Commissions'] },
  { key: 'investment', type: 'income', name: 'Investment Income', emoji: '📈', color: '#3b82f6',
    subs: ['Dividends', 'Interest', 'Capital Gains', 'Trading Income'] },
  { key: 'other', type: 'income', name: 'Other Income', emoji: '🪙', color: '#84cc16',
    subs: ['From Previous Month', 'Rental Income', 'Loans', OTHER] },
  // EXPENSES
  { key: 'housing-tech', type: 'expense', name: 'Housing & Technology', emoji: '🏠', color: '#6366f1',
    subs: ['Data', 'IT Stuff', 'Forex', 'Education'] },
  { key: 'transport', type: 'expense', name: 'Transportation', emoji: '🚌', color: '#0ea5e9',
    subs: ['Public Transportation', 'Gas', 'Car Payments', 'Insurance'] },
  { key: 'food', type: 'expense', name: 'Food', emoji: '🍽️', color: '#f59e0b',
    subs: ['Dining Out', 'Groceries'] },
  { key: 'health', type: 'expense', name: 'Healthcare', emoji: '🩺', color: '#f43f5e',
    subs: ['Medical Expenses', 'Life Insurance', 'Prescription Drugs'] },
  { key: 'personal', type: 'expense', name: 'Personal Expenses', emoji: '🛍️', color: '#a855f7',
    subs: ['Entertainment', 'Gifts', 'Clothing', 'Hobbies'] },
  { key: 'savings', type: 'expense', name: 'Savings & Investments', emoji: '🏦', color: '#10b981', isSavings: true,
    subs: ['Investment Accounts', 'Savings Accounts', 'Retirement Contributions'] },
  { key: 'debt', type: 'expense', name: 'Debt Payments', emoji: '💳', color: '#64748b',
    subs: ['Credit Card Payments', 'Personal Loans', 'Student Loans'] },
  { key: 'other', type: 'expense', name: 'Other Expenses', emoji: '🧾', color: '#78716c',
    subs: [OTHER, 'Taxes', 'Church', 'Fees'] },
];

const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A fresh copy of the built-in tree. Built-in ids are stable so backups line up across devices. */
export function defaultCategories() {
  return DEFAULT_TREE.map((m) => {
    const id = `${m.type === 'income' ? 'inc' : 'exp'}.${m.key}`;
    return {
      id,
      type: m.type,
      name: m.name,
      emoji: m.emoji,
      color: m.color,
      enabled: true,
      custom: false,
      isSavings: m.isSavings === true,
      subs: m.subs.map((s) => {
        const sub = typeof s === 'string' ? { name: s } : s;
        return { id: `${id}.${slug(sub.name)}`, name: sub.name, emoji: '', color: '', enabled: true,
          custom: false, requiresNote: sub.requiresNote === true };
      }),
    };
  });
}

/** Swatches offered when adding or restyling a category. */
export const COLOR_CHOICES = [
  { name: 'Teal', hex: '#14b8a6' }, { name: 'Blue', hex: '#3b82f6' }, { name: 'Indigo', hex: '#6366f1' },
  { name: 'Purple', hex: '#a855f7' }, { name: 'Rose', hex: '#f43f5e' }, { name: 'Orange', hex: '#f97316' },
  { name: 'Amber', hex: '#f59e0b' }, { name: 'Lime', hex: '#84cc16' }, { name: 'Green', hex: '#10b981' },
  { name: 'Slate', hex: '#64748b' },
];

const FALLBACK_COLOR = '#64748b';
const NAME_MAX = 40;

/* ------------------------------------------------------------------ */
/* Cleaning helpers                                                    */
/* ------------------------------------------------------------------ */

function cleanName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new SchemaError('Please enter a name.');
  if (name.length > NAME_MAX) throw new SchemaError(`Names can be up to ${NAME_MAX} characters.`);
  return name;
}

/** Keep the first emoji (grapheme) only; anything else becomes ''. */
function cleanEmoji(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.trim();
  const first = typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)][0].segment
    : [...text][0];
  return first.length <= 12 ? first : '';
}

const cleanColor = (value) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '');
const sameName = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** Validate and normalise a tree from storage or a backup. Throws SchemaError if it is unusable. */
export function sanitizeCategories(raw) {
  if (!Array.isArray(raw)) throw new SchemaError('The category list is missing.');
  const seen = new Set();
  const claim = (id) => {
    if (typeof id !== 'string' || !id || id.length > 100) throw new SchemaError('A category has no valid id.');
    if (seen.has(id)) throw new SchemaError(`Category id "${id}" appears twice.`);
    seen.add(id);
    return id;
  };
  return raw.map((m) => {
    if (!m || typeof m !== 'object') throw new SchemaError('A category is malformed.');
    if (m.type !== 'income' && m.type !== 'expense') throw new SchemaError(`Category "${m.name}" has no valid type.`);
    return {
      id: claim(m.id),
      type: m.type,
      name: cleanName(m.name),
      emoji: cleanEmoji(m.emoji) || '🏷️',
      color: cleanColor(m.color) || FALLBACK_COLOR,
      enabled: m.enabled !== false,
      custom: m.custom === true,
      isSavings: m.type === 'expense' && m.isSavings === true,
      subs: (Array.isArray(m.subs) ? m.subs : []).map((s) => {
        if (!s || typeof s !== 'object') throw new SchemaError(`A sub-category of "${m.name}" is malformed.`);
        return {
          id: claim(s.id),
          name: cleanName(s.name),
          emoji: cleanEmoji(s.emoji),
          color: cleanColor(s.color),
          enabled: s.enabled !== false,
          custom: s.custom === true,
          requiresNote: s.requiresNote === true,
        };
      }),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export const findMain = (cats, id) => cats.find((m) => m.id === id) ?? null;
export const findSub = (cats, mainId, subId) => findMain(cats, mainId)?.subs.find((s) => s.id === subId) ?? null;

/** Locate a main or sub by id → { main, sub|null } or null. */
function locate(cats, id) {
  for (const main of cats) {
    if (main.id === id) return { main, sub: null };
    const sub = main.subs.find((s) => s.id === id);
    if (sub) return { main, sub };
  }
  return null;
}

/**
 * What the entry form should offer for a type: enabled mains with enabled subs.
 * `keep` lets the edit form still show the category an old transaction already uses,
 * even if it has since been switched off (flagged with `hidden`).
 */
export function visibleMains(cats, type, keep = {}) {
  return cats
    .filter((m) => m.type === type && (m.enabled || m.id === keep.mainId))
    .map((m) => ({
      ...m,
      hidden: !m.enabled,
      subs: m.subs
        .filter((s) => s.enabled || s.id === keep.subId)
        .map((s) => ({ ...s, hidden: !s.enabled })),
    }));
}

/** Names and styling for a transaction's category. Hidden or deleted-by-import categories still resolve. */
export function labelFor(cats, mainId, subId) {
  const main = findMain(cats, mainId);
  const sub = main && subId ? findSub(cats, mainId, subId) : null;
  return {
    known: Boolean(main),
    main: main?.name ?? 'Unknown category',
    sub: sub?.name ?? null,
    emoji: main?.emoji ?? '❔',
    subEmoji: sub?.emoji || '',
    color: sub?.color || main?.color || FALLBACK_COLOR,
    isSavings: main?.isSavings === true,
  };
}

/** True when the chosen sub-category demands a note ("Other (Specify)"). */
export const noteRequired = (cats, mainId, subId) => findSub(cats, mainId, subId)?.requiresNote === true;

/** Every category id (main and sub) referenced by any transaction, deleted ones included. */
export function usedCategoryIds(transactions) {
  const used = new Set();
  for (const t of transactions) {
    used.add(t.categoryId);
    if (t.subCategoryId) used.add(t.subCategoryId);
  }
  return used;
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

/** 'income' | 'savings' | 'spending' — savings is reported apart from spending. */
export function bucketOf(cats, tx) {
  if (tx.type === 'income') return 'income';
  return findMain(cats, tx.categoryId)?.isSavings ? 'savings' : 'spending';
}

/**
 * Month totals over the (already filtered, non-deleted) transactions given.
 *   net = income − spending − savings   (cash left after everything that went out)
 */
export function summarize(transactions, cats) {
  const totals = { income: 0, spending: 0, savings: 0, net: 0, count: 0 };
  for (const t of transactions) {
    totals[bucketOf(cats, t)] += t.amount;
    totals.count += 1;
  }
  totals.net = totals.income - totals.spending - totals.savings;
  return totals;
}

/* ------------------------------------------------------------------ */
/* Customizer                                                          */
/* ------------------------------------------------------------------ */

const clone = (cats) => structuredClone(cats);

function assertUniqueName(siblings, name, exceptId = null) {
  if (siblings.some((s) => s.id !== exceptId && sameName(s.name, name))) {
    throw new SchemaError(`"${name}" already exists here.`);
  }
}

/** Add a new main category to Income or Expenses. Placed after the last one of its type. */
export function addMain(cats, { type, name, emoji, color }) {
  if (type !== 'income' && type !== 'expense') throw new SchemaError('Choose Income or Expense.');
  const clean = cleanName(name);
  assertUniqueName(cats.filter((m) => m.type === type), clean);
  const next = clone(cats);
  const main = {
    id: `c.${newId()}`, type, name: clean, emoji: cleanEmoji(emoji) || '🏷️', color: cleanColor(color) || FALLBACK_COLOR,
    enabled: true, custom: true, isSavings: false, subs: [],
  };
  let at = next.length;
  for (let i = next.length - 1; i >= 0; i--) if (next[i].type === type) { at = i + 1; break; }
  next.splice(at, 0, main);
  return next;
}

/** Add a custom sub-category to an existing main category. */
export function addSub(cats, mainId, { name, emoji, color }) {
  const main = findMain(cats, mainId);
  if (!main) throw new SchemaError('That parent category no longer exists.');
  const clean = cleanName(name);
  assertUniqueName(main.subs, clean);
  const next = clone(cats);
  findMain(next, mainId).subs.push({
    id: `c.${newId()}`, name: clean, emoji: cleanEmoji(emoji), color: cleanColor(color),
    enabled: true, custom: true, requiresNote: false,
  });
  return next;
}

/** Rename, restyle, or switch on/off a main or sub: patch may hold name, emoji, color, enabled. */
export function updateItem(cats, id, patch) {
  const found = locate(cats, id);
  if (!found) throw new SchemaError('That category no longer exists.');
  const next = clone(cats);
  const target = locate(next, id);
  const item = target.sub ?? target.main;
  if ('name' in patch) {
    const clean = cleanName(patch.name);
    assertUniqueName(target.sub ? target.main.subs : next.filter((m) => m.type === target.main.type), clean, id);
    item.name = clean;
  }
  if ('emoji' in patch) item.emoji = cleanEmoji(patch.emoji) || (target.sub ? '' : '🏷️');
  if ('color' in patch) item.color = cleanColor(patch.color) || (target.sub ? '' : FALLBACK_COLOR);
  if ('enabled' in patch) item.enabled = Boolean(patch.enabled);
  return next;
}

/** Position among siblings, for enabling/disabling the up and down buttons. */
export function positionOf(cats, id) {
  const found = locate(cats, id);
  if (!found) return { index: 0, count: 0 };
  const siblings = found.sub ? found.main.subs : cats.filter((m) => m.type === found.main.type);
  return { index: siblings.findIndex((s) => s.id === id), count: siblings.length };
}

/** Move up (-1) or down (+1) among siblings of the same kind. */
export function moveItem(cats, id, direction) {
  const found = locate(cats, id);
  if (!found) throw new SchemaError('That category no longer exists.');
  const next = clone(cats);
  const target = locate(next, id);
  if (target.sub) {
    const list = target.main.subs;
    const i = list.findIndex((s) => s.id === id);
    const j = i + direction;
    if (j < 0 || j >= list.length) return next;
    [list[i], list[j]] = [list[j], list[i]];
    return next;
  }
  const sameType = next.filter((m) => m.type === target.main.type);
  const k = sameType.findIndex((m) => m.id === id);
  const neighbour = sameType[k + direction];
  if (!neighbour) return next;
  const a = next.indexOf(target.main);
  const b = next.indexOf(neighbour);
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/**
 * Hard-delete a custom category, but only if no transaction (even a soft-deleted one) uses it.
 * Built-in categories can only be hidden. `used` comes from usedCategoryIds().
 */
export function removeItem(cats, id, used) {
  const found = locate(cats, id);
  if (!found) throw new SchemaError('That category no longer exists.');
  const item = found.sub ?? found.main;
  if (!item.custom) throw new SchemaError(`"${item.name}" is built in. You can hide it, but not delete it.`);
  const inUse = used.has(id) || (!found.sub && found.main.subs.some((s) => used.has(s.id)));
  if (inUse) throw new SchemaError(`"${item.name}" has transactions, so it can't be deleted. Hide it instead.`);
  const next = clone(cats);
  if (found.sub) {
    const main = findMain(next, found.main.id);
    main.subs = main.subs.filter((s) => s.id !== id);
    return next;
  }
  return next.filter((m) => m.id !== id);
}

/**
 * Move a subcategory to a different parent category.
 * Useful for consolidating duplicates or reorganizing as your finances evolve.
 * Existing transactions stay tagged correctly (they reference the subcategory ID, not parent ID).
 */
export function moveSubcategoryToParent(cats, subId, newParentId) {
  const found = locate(cats, subId);
  if (!found) throw new SchemaError('That category no longer exists.');
  if (!found.sub) throw new SchemaError('Only subcategories can be moved. Main categories cannot.');

  const newParent = findMain(cats, newParentId);
  if (!newParent) throw new SchemaError('Target category not found.');
  if (newParent.type !== found.main.type) throw new SchemaError(`Cannot move between income and expense categories.`);
  if (newParent.id === found.main.id) throw new SchemaError('Already in this category.');

  // Check for duplicate name in new parent
  const duplicate = newParent.subs.find((s) => s.name === found.sub.name);
  if (duplicate) throw new SchemaError(`"${found.sub.name}" already exists in ${newParent.name}. Delete or rename the duplicate first.`);

  const next = clone(cats);
  const oldMain = findMain(next, found.main.id);
  const targetParent = findMain(next, newParentId);

  // Remove from old parent
  const index = oldMain.subs.findIndex((s) => s.id === subId);
  const [sub] = oldMain.subs.splice(index, 1);

  // Add to new parent
  targetParent.subs.push(sub);

  return next;
}

/**
 * Back to the built-in tree. Custom categories that transactions still point to are kept
 * (switched off) so those transactions never lose their label.
 */
export function resetToDefaults(cats, used) {
  const fresh = defaultCategories();
  for (const main of cats) {
    const usedSubs = main.subs.filter((s) => s.custom && used.has(s.id)).map((s) => ({ ...s, enabled: false }));
    if (main.custom) {
      if (used.has(main.id) || usedSubs.length) {
        fresh.push({ ...main, enabled: false, subs: usedSubs, custom: true });
      }
    } else if (usedSubs.length) {
      findMain(fresh, main.id)?.subs.push(...usedSubs);
    }
  }
  return fresh;
}

/** Union used when merging a backup: add categories and sub-categories this device lacks. */
export function mergeCategories(local, incoming) {
  const next = clone(local);
  for (const inMain of incoming) {
    const main = findMain(next, inMain.id);
    if (!main) { next.push(clone([inMain])[0]); continue; }
    for (const sub of inMain.subs) {
      if (!main.subs.some((s) => s.id === sub.id)) main.subs.push({ ...sub });
    }
  }
  return next;
}
