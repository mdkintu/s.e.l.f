// app.js — UI wiring and rendering.
// All data goes through store.js; this file never touches storage. Category rules live in
// schema.js, money maths in money.js, files in backup.js.

import * as store from './store.js';
import * as schema from './schema.js';
import * as money from './money.js';
import { passphraseStrength, MIN_PASSPHRASE } from './crypto.js';
import * as insights from './insights.js';
import { donutChart, barChart, niceScale } from './charts.js';
import { buildCsv, download, stamp } from './backup.js';
import { createSync } from './sync.js';

/* ================================================================== */
/* Small helpers                                                       */
/* ================================================================== */

const $ = (selector, root = document) => root.querySelector(selector);

// html`…` escapes every interpolated value unless it is itself html`…` output. User text
// (notes, category names, imported data) can therefore never inject markup.
class Safe { constructor(s) { this.s = s; } }
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function part(v) {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return escapeHtml(v);
}
const html = (strings, ...values) => new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ''), ''));
const put = (el, safe) => { el.innerHTML = safe.s; };

const ICONS = {
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.5-1M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  cog: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  chart: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  shield: '<path d="M12 3l7 3v6c0 4.6-3 8.3-7 9-4-.7-7-4.4-7-9V6l7-3z"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
};
const icon = (name, size = 22) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${new Safe(ICONS[name])}</svg>`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- dates (all local; a transaction date is a plain 'YYYY-MM-DD') ---------- */

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => toDateStr(new Date());
const monthOf = (dateStr) => dateStr.slice(0, 7);
const dateFromStr = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const shiftMonth = (key, delta) => { const [y, m] = key.split('-').map(Number); return monthOf(toDateStr(new Date(y, m - 1 + delta, 1))); };

const locale = navigator.languages?.[0] || 'en';
const fmtDay = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtFull = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
const fmtStamp = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

function relativeDay(dateStr) {
  const today = new Date();
  if (dateStr === toDateStr(today)) return 'Today';
  if (dateStr === toDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return 'Yesterday';
  return null;
}
const dayLabel = (dateStr) => { const rel = relativeDay(dateStr); const d = fmtDay.format(dateFromStr(dateStr)); return rel ? `${rel} · ${d}` : d; };
const fullDateLabel = (dateStr) => relativeDay(dateStr) ?? fmtFull.format(dateFromStr(dateStr));

/* ---------- money on screen (Privacy Mode is enforced here, in one place) ---------- */

const privacyOn = () => store.getSettings().privacyMode;
const currencyCode = () => store.getSettings().currency;

/** Amount as HTML. With Privacy Mode on, no digits reach the DOM at all. */
function amountHtml(minor, sign = '') {
  if (privacyOn()) return html`<span aria-hidden="true">••••</span><span class="sr-only">amount hidden</span>`;
  return html`${sign}${money.formatMoney(minor, currencyCode())}`;
}

/* ---------- errors ---------- */

const isFriendly = (err) => err instanceof store.StoreError || err instanceof schema.SchemaError;

/** Run something that may throw a plain-language error and show it as a toast. */
function guard(fn) {
  try { return fn(); } catch (err) {
    if (!isFriendly(err)) throw err;
    toast(err.message);
    return undefined;
  }
}

/* ================================================================== */
/* UI state (not persisted)                                            */
/* ================================================================== */

const ui = {
  tab: 'add',
  month: monthOf(todayStr()),
  filterType: 'all',
  filterMain: 'all',
  settingsType: 'expense',
  openMains: new Set(),
  // On-device AI. Held in memory only: a summary holds figures, so it never touches storage.
  aiCached: null,    // is the model already on this device? (null = not checked yet)
  aiText: null,      // { signature, text, device, seconds } — valid only for the facts it was written from
  aiFail: null,      // { message } | { offenders }
  aiWorking: false,  // a summary is being written (includes loading the model for it)
};
let entryForm = null;
let bootInfo = { persistent: true, recovered: null };

/** Re-render a region but keep keyboard focus on the same control (found by data-key). */
function withFocus(container, render) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset.key : null;
  render();
  if (!key) return;
  const find = (k) => container.querySelector(`[data-key="${CSS.escape(k)}"]:not(:disabled)`);
  let target = find(key);
  if (!target) { // e.g. a move-up button that just became disabled at the top of the list
    const [kind, ...rest] = key.split(':');
    const twin = { up: 'down', down: 'up' }[kind];
    if (twin) target = find([twin, ...rest].join(':'));
  }
  target?.focus({ preventScroll: true });
}

/* ================================================================== */
/* Toast and dialogs                                                   */
/* ================================================================== */

let toastTimer = 0;

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').replaceChildren();
}

function toast(message, { action = null, onAction = null, ms = 6000 } = {}) {
  clearTimeout(toastTimer);
  const el = $('#toast');
  put(el, html`
    <div class="flex max-w-md items-center gap-2 rounded-2xl bg-slate-900 py-1 pl-4 pr-1 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
      <span class="py-2">${message}</span>
      ${action ? html`<button type="button" class="pointer-events-auto min-h-11 rounded-xl px-3 font-semibold text-teal-300 hover:bg-white/10 dark:text-teal-800 dark:hover:bg-slate-900/10" data-toast-action>${action}</button>` : ''}
    </div>`);
  $('[data-toast-action]', el)?.addEventListener('click', () => { hideToast(); onAction?.(); });
  toastTimer = setTimeout(hideToast, ms);
}

/**
 * Show a modal <dialog>. Buttons with data-close="value" close it with that value.
 * Resolves with the closing value ('' when dismissed with Esc or a backdrop click).
 */
function mountDialog(content, { dismissible = true } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.setAttribute('aria-labelledby', 'dlg-title');
  dlg.innerHTML = content.s;
  let pressedOnBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => { pressedOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) dlg.close(closer.dataset.close);
    else if (dismissible && e.target === dlg && pressedOnBackdrop) dlg.close('');
  });
  if (!dismissible) dlg.addEventListener('cancel', (e) => e.preventDefault());
  const done = new Promise((resolve) => {
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue); }, { once: true });
  });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, done };
}

async function confirmDialog({ title, message, confirmLabel, danger = false }) {
  const { done } = mountDialog(html`
    <div class="space-y-4 p-5">
      <h2 id="dlg-title" class="text-lg font-semibold">${title}</h2>
      <p class="muted">${message}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="" autofocus>Cancel</button>
        <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'}" data-close="yes">${confirmLabel}</button>
      </div>
    </div>`);
  return (await done) === 'yes';
}

async function alertDialog(title, message) {
  const { done } = mountDialog(html`
    <div class="space-y-4 p-5">
      <h2 id="dlg-title" class="text-lg font-semibold">${title}</h2>
      <p class="muted">${message}</p>
      <div class="flex justify-end"><button type="button" class="btn-primary" data-close="ok" autofocus>OK</button></div>
    </div>`);
  await done;
}

/* ================================================================== */
/* Transaction form (used for "Add" and for the edit dialog)           */
/* ================================================================== */

function amountMessage(error, code, decimals) {
  switch (error) {
    case 'empty': return 'Enter an amount.';
    case 'invalid': return decimals ? 'Use digits only, for example 1250.50.' : 'Use digits only, for example 50000.';
    case 'no-decimals': return `${code} has no decimal places. Enter a whole number.`;
    case 'too-many-decimals': return `${code} allows at most ${decimals} decimal places.`;
    case 'zero': return 'The amount must be more than zero.';
    default: return 'That amount is too large.';
  }
}

function createTxForm(root, { prefix, mode, tx = null, onSubmit, onCancel = null }) {
  const editing = mode === 'edit';
  const p = (name) => `${prefix}-${name}`;
  const st = {
    type: tx?.type ?? 'expense',
    mainId: tx?.categoryId ?? null,
    subId: tx?.subCategoryId ?? null,
    date: tx?.date ?? todayStr(),
    showDate: editing,
    showNote: Boolean(tx?.note),
  };

  put(root, html`
    <form novalidate autocomplete="off" class="space-y-5">
      <div class="seg-wrap" role="radiogroup" aria-label="Type">
        ${['expense', 'income'].map((t) => html`
          <label class="seg"><input type="radio" class="sr-only" name="${p('type')}" value="${t}" ${st.type === t ? 'checked' : ''}><span class="seg-face">${t === 'expense' ? 'Expense' : 'Income'}</span></label>`)}
      </div>

      <div>
        <label class="field-label" for="${p('amount')}">Amount</label>
        <div class="flex items-center rounded-2xl border border-slate-300 bg-white focus-within:ring-2 focus-within:ring-teal-600 dark:border-slate-600 dark:bg-slate-950">
          <span id="${p('symbol')}" class="pl-4 text-lg font-medium text-slate-600 dark:text-slate-400" aria-hidden="true"></span>
          <input id="${p('amount')}" type="text" style="outline: none" placeholder="0" autocomplete="off" autocapitalize="off" spellcheck="false"
                 enterkeyhint="done" aria-describedby="${p('hint')} ${p('error')}"
                 class="min-h-14 w-full min-w-0 bg-transparent px-3 text-3xl font-semibold tabular-nums placeholder:text-slate-400">
        </div>
        <p id="${p('hint')}" class="mt-1 min-h-5 text-sm muted"></p>
      </div>

      <fieldset>
        <legend class="field-label">Category</legend>
        <div id="${p('grid')}" class="grid grid-cols-3 gap-2 sm:grid-cols-4"></div>
      </fieldset>

      <fieldset id="${p('subs')}">
        <legend class="field-label">Sub-category</legend>
        <div id="${p('chips')}" class="flex flex-wrap gap-2"></div>
      </fieldset>

      <div>
        <div class="flex items-center justify-between gap-2" id="${p('date-row')}">
          <p class="text-sm"><span class="muted">Date:</span> <strong id="${p('date-label')}"></strong></p>
          <button type="button" class="btn-link" id="${p('date-toggle')}" data-act="toggle-date" aria-expanded="false" aria-controls="${p('date-field')}">Change date</button>
        </div>
        <div id="${p('date-field')}" class="mt-2" hidden>
          <label class="field-label" for="${p('date')}">Date</label>
          <input id="${p('date')}" type="date" class="input">
        </div>
      </div>

      <div>
        <button type="button" class="btn-link" id="${p('note-toggle')}" data-act="toggle-note" aria-expanded="false" aria-controls="${p('note-field')}">+ Add note</button>
        <div id="${p('note-field')}" hidden>
          <label class="field-label" id="${p('note-label')}" for="${p('note')}">Note (optional)</label>
          <input id="${p('note')}" type="text" class="input" maxlength="500" enterkeyhint="done" autocomplete="off">
        </div>
      </div>

      <div class="save-bar ${editing ? 'in-dialog' : ''}">
        <p id="${p('error')}" role="alert" class="save-error text-sm font-medium text-rose-700 dark:text-rose-300"></p>
        <div class="flex gap-2">
          <button type="submit" class="btn-primary flex-1" id="${p('save')}"></button>
          ${editing ? html`<button type="button" class="btn-secondary" data-act="cancel">Cancel</button>` : ''}
        </div>
      </div>
    </form>`);

  const el = (name) => root.querySelector(`#${p(name)}`);
  const form = root.querySelector('form');
  const amountEl = el('amount');
  const dateEl = el('date');
  const noteEl = el('note');
  const gridEl = el('grid');
  const chipsEl = el('chips');
  const errorEl = el('error');
  const categories = () => store.getCategories();
  const visible = () => schema.visibleMains(categories(), st.type, editing ? { mainId: st.mainId, subId: st.subId } : {});

  if (tx) {
    amountEl.value = money.minorToDecimalString(tx.amount, money.decimalsFor(tx.currency));
    noteEl.value = tx.note;
  }

  function drawAmount() {
    const info = money.currencyInfo(currencyCode());
    el('symbol').textContent = info.symbol;
    amountEl.inputMode = info.decimals === 0 ? 'numeric' : 'decimal';
    amountEl.classList.toggle('privacy-mask', privacyOn());
    updateHint();
  }

  function updateHint() {
    const parsed = money.parseAmount(amountEl.value, money.decimalsFor(currencyCode()));
    el('hint').textContent = !privacyOn() && parsed.minor ? money.formatMoney(parsed.minor, currencyCode()) : '';
  }

  function drawGrid() {
    const mains = visible();
    if (st.mainId && !mains.some((m) => m.id === st.mainId)) { st.mainId = null; st.subId = null; }
    put(gridEl, mains.length ? html`${mains.map((m) => html`
      <label class="tile" style="--cat: ${m.color}">
        <input type="radio" class="sr-only" name="${p('cat')}" value="${m.id}" ${st.mainId === m.id ? 'checked' : ''}>
        <span class="tile-face"><span class="tile-emoji" aria-hidden="true">${m.emoji}</span><span class="tile-name">${m.name}${m.hidden ? ' (hidden)' : ''}</span></span>
      </label>`)}` : html`<p class="col-span-full text-sm muted">Every category is switched off. Turn some on in Settings.</p>`);
  }

  function drawChips() {
    const main = visible().find((m) => m.id === st.mainId);
    if (main && st.subId && !main.subs.some((s) => s.id === st.subId)) st.subId = null;
    el('subs').hidden = !main || main.subs.length === 0;
    put(chipsEl, html`${(main?.subs ?? []).map((s) => html`
      <label class="chip" style="--cat: ${s.color || main.color}">
        <input type="radio" class="sr-only" name="${p('sub')}" value="${s.id}" ${st.subId === s.id ? 'checked' : ''}>
        <span class="chip-face">${s.emoji ? html`<span aria-hidden="true">${s.emoji}</span>` : ''}${s.name}${s.hidden ? ' (hidden)' : ''}</span>
      </label>`)}`);
  }

  function drawNote() {
    const required = schema.noteRequired(categories(), st.mainId, st.subId);
    if (required) st.showNote = true;
    el('note-field').hidden = !st.showNote;
    el('note-toggle').hidden = st.showNote;
    noteEl.required = required;
    noteEl.setAttribute('aria-required', String(required));
    el('note-label').textContent = required ? 'Note (required for this category)' : 'Note (optional)';
  }

  function drawDate() {
    el('date-label').textContent = fullDateLabel(st.date);
    dateEl.value = st.date;
    el('date-field').hidden = !st.showDate;
    el('date-row').hidden = editing;
    el('date-toggle').hidden = st.showDate;
  }

  function drawSave() {
    el('save').textContent = editing ? 'Save changes' : `Save ${st.type}`;
  }

  function drawAll() { drawAmount(); drawGrid(); drawChips(); drawNote(); drawDate(); drawSave(); }

  function clearError() {
    errorEl.textContent = '';
    for (const field of [amountEl, dateEl, noteEl]) field.removeAttribute('aria-invalid');
  }

  function fail(message, field = null) {
    errorEl.textContent = message;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }

  function submit() {
    clearError();
    const code = currencyCode();
    const decimals = money.decimalsFor(code);
    const parsed = money.parseAmount(amountEl.value, decimals);
    if (parsed.error) return fail(amountMessage(parsed.error, code, decimals), amountEl);
    if (!st.mainId) return fail('Choose a category.', gridEl.querySelector('input'));
    if (!st.date) { st.showDate = true; drawDate(); return fail('Choose a valid date.', dateEl); }
    const note = noteEl.value.trim();
    if (schema.noteRequired(categories(), st.mainId, st.subId) && !note) {
      return fail('Please add a note: "Other (Specify)" needs a description.', noteEl);
    }
    try {
      onSubmit({ type: st.type, amount: parsed.minor, categoryId: st.mainId, subCategoryId: st.subId, date: st.date, note });
    } catch (err) {
      if (!isFriendly(err)) throw err;
      return fail(err.message);
    }
    if (!editing) reset();
    return undefined;
  }

  /** Clear the form back to its defaults and put the cursor in Amount, ready for the next one. */
  function reset() {
    Object.assign(st, { type: 'expense', mainId: null, subId: null, date: todayStr(), showDate: false, showNote: false });
    amountEl.value = '';
    noteEl.value = '';
    form.querySelector(`input[name="${p('type')}"][value="expense"]`).checked = true;
    clearError();
    drawAll();
    amountEl.focus();
  }

  form.addEventListener('change', (e) => {
    const { name, value } = e.target;
    if (name === p('type')) { st.type = value; st.mainId = null; st.subId = null; drawGrid(); drawChips(); drawNote(); drawSave(); }
    else if (name === p('cat')) { st.mainId = value; st.subId = null; drawChips(); drawNote(); }
    else if (name === p('sub')) { st.subId = value; drawNote(); }
    else if (e.target === dateEl) { st.date = value; drawDate(); }
    clearError();
  });
  form.addEventListener('input', (e) => { if (e.target === amountEl) { updateHint(); clearError(); } });
  form.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle-date') { st.showDate = true; drawDate(); dateEl.focus(); }
    else if (act === 'toggle-note') { st.showNote = true; drawNote(); noteEl.focus(); }
    else if (act === 'cancel') onCancel?.();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  drawAll();
  return {
    /** Re-read categories, currency and privacy mode without touching what the person typed. */
    refresh: drawAll,
    focusAmount: () => {
      // If Amount is already the active element (e.g. a closing dialog just "restored" focus to it),
      // Chrome can leave it unable to take text until it is genuinely re-focused.
      if (document.activeElement === amountEl) amountEl.blur();
      amountEl.focus();
      if (editing) amountEl.select();
    },
  };
}

function editTransaction(id) {
  const tx = store.getTransactions().find((t) => t.id === id && !t.deleted);
  if (!tx) return;
  const { dlg } = mountDialog(html`
    <div class="p-5">
      <h2 id="dlg-title" class="mb-4 text-lg font-semibold">Edit transaction</h2>
      <div id="edit-root"></div>
    </div>`);
  const form = createTxForm($('#edit-root', dlg), {
    prefix: 'edit',
    mode: 'edit',
    tx,
    onSubmit: (payload) => {
      store.updateTransaction(id, payload);
      dlg.close('saved');
      toast('Transaction updated');
    },
    onCancel: () => dlg.close(''),
  });
  form.focusAmount();
}

/* ================================================================== */
/* Month view                                                          */
/* ================================================================== */

function tileHtml(label, minor, { note = '', wide = false } = {}) {
  return html`
    <div class="card ${wide ? 'col-span-2' : ''}">
      <dt class="text-sm font-medium muted">${label}${note ? html` <span class="font-normal">${note}</span>` : ''}</dt>
      <dd class="${wide ? 'text-3xl' : 'text-xl'} mt-1 break-words font-semibold tabular-nums">${amountHtml(minor)}</dd>
    </div>`;
}

function rowHtml(t, cats) {
  const label = schema.labelFor(cats, t.categoryId, t.subCategoryId);
  const title = label.sub ? `${label.main} › ${label.sub}` : label.main;
  const bucket = schema.bucketOf(cats, t);
  const tone = { income: 'text-emerald-700 dark:text-emerald-400', savings: 'text-sky-700 dark:text-sky-400', spending: '' }[bucket];
  return html`
    <li class="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0 px-3 py-2 sm:grid-cols-[auto_1fr_auto_auto]">
      <span class="dot" style="--cat: ${label.color}" aria-hidden="true">${label.subEmoji || label.emoji}</span>
      <div class="min-w-0">
        <p class="line-clamp-2 break-words font-medium">${title}</p>
        ${t.note ? html`<p class="line-clamp-2 break-words text-sm muted">${t.note}</p>` : ''}
      </div>
      <p class="text-right font-semibold tabular-nums ${tone}">${amountHtml(t.amount, t.type === 'income' ? '+' : '−')}</p>
      <div class="col-span-3 flex justify-end sm:col-span-1">
        <button type="button" class="icon-btn" data-act="edit-tx" data-id="${t.id}" data-key="edit:${t.id}" aria-label="Edit ${title}, ${dayLabel(t.date)}">${icon('pencil')}</button>
        <button type="button" class="icon-btn" data-act="delete-tx" data-id="${t.id}" data-key="del:${t.id}" aria-label="Delete ${title}, ${dayLabel(t.date)}">${icon('trash')}</button>
      </div>
    </li>`;
}

function monthHtml() {
  const { categories: cats, transactions } = store.getState();
  const live = transactions.filter((t) => !t.deleted);
  const months = [...live.map((t) => monthOf(t.date)), monthOf(todayStr()), ui.month].sort();
  const [first, last] = [months[0], months.at(-1)];

  const inMonth = live.filter((t) => monthOf(t.date) === ui.month);
  const totals = schema.summarize(inMonth, cats);

  const mainChoices = cats.filter((m) => ui.filterType === 'all' || m.type === ui.filterType);
  if (ui.filterMain !== 'all' && !mainChoices.some((m) => m.id === ui.filterMain)) ui.filterMain = 'all';
  const shown = inMonth
    .filter((t) => (ui.filterType === 'all' || t.type === ui.filterType) && (ui.filterMain === 'all' || t.categoryId === ui.filterMain))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const days = [];
  for (const t of shown) {
    if (days.at(-1)?.date !== t.date) days.push({ date: t.date, items: [] });
    days.at(-1).items.push(t);
  }
  const option = (m) => html`<option value="${m.id}" ${ui.filterMain === m.id ? 'selected' : ''}>${m.emoji} ${m.name}${m.enabled ? '' : ' (hidden)'}</option>`;
  const filtered = ui.filterType !== 'all' || ui.filterMain !== 'all';

  return html`
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <button type="button" class="icon-btn" data-act="prev-month" data-key="prev" aria-label="Previous month" ${ui.month <= first ? 'disabled' : ''}>${icon('left')}</button>
        <h2 id="h-month" tabindex="-1" class="text-lg font-semibold" aria-live="polite">${fmtMonth.format(dateFromStr(`${ui.month}-01`))}</h2>
        <button type="button" class="icon-btn" data-act="next-month" data-key="next" aria-label="Next month" ${ui.month >= last ? 'disabled' : ''}>${icon('right')}</button>
      </div>

      <dl class="grid grid-cols-2 gap-3">
        ${tileHtml('Income', totals.income)}
        ${tileHtml('Expenses', totals.spending, { note: 'excl. savings' })}
        ${tileHtml('Savings & investments', totals.savings)}
        ${tileHtml('Net balance', totals.net)}
      </dl>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="f-type">Type</label>
          <select id="f-type" class="input" data-filter="type" data-key="f-type">
            <option value="all" ${ui.filterType === 'all' ? 'selected' : ''}>All types</option>
            <option value="income" ${ui.filterType === 'income' ? 'selected' : ''}>Income</option>
            <option value="expense" ${ui.filterType === 'expense' ? 'selected' : ''}>Expenses</option>
          </select>
        </div>
        <div>
          <label class="field-label" for="f-main">Category</label>
          <select id="f-main" class="input" data-filter="main" data-key="f-main">
            <option value="all">All categories</option>
            ${ui.filterType === 'all'
              ? ['income', 'expense'].map((type) => html`<optgroup label="${type === 'income' ? 'Income' : 'Expenses'}">${cats.filter((m) => m.type === type).map(option)}</optgroup>`)
              : mainChoices.map(option)}
          </select>
        </div>
      </div>
      ${filtered ? html`<p class="text-sm muted" aria-live="polite">Showing ${shown.length} of ${plural(inMonth.length, 'transaction')}. Totals above cover the whole month.</p>` : ''}

      ${days.length ? html`<div class="space-y-4">${days.map((day) => html`
        <section aria-label="${dayLabel(day.date)}">
          <h3 class="mb-1 px-1 text-sm font-semibold muted">${dayLabel(day.date)}</h3>
          <ul class="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            ${day.items.map((t) => rowHtml(t, cats))}
          </ul>
        </section>`)}</div>`
      : html`<p class="card text-center muted">${inMonth.length ? 'Nothing matches these filters.' : 'Nothing logged this month yet.'}</p>`}
    </div>`;
}

function renderMonth() {
  const root = $('#view-month');
  withFocus(root, () => put(root, monthHtml()));
}

function wireMonth() {
  const root = $('#view-month');
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const { act, id } = btn.dataset;
    if (act === 'prev-month') { ui.month = shiftMonth(ui.month, -1); renderMonth(); }
    else if (act === 'next-month') { ui.month = shiftMonth(ui.month, 1); renderMonth(); }
    else if (act === 'edit-tx') editTransaction(id);
    else if (act === 'delete-tx') {
      guard(() => store.deleteTransaction(id));
      toast('Transaction deleted', { action: 'Undo', onAction: () => guard(() => store.restoreTransaction(id)) });
    }
  });
  root.addEventListener('change', (e) => {
    const which = e.target.dataset.filter;
    if (which === 'type') { ui.filterType = e.target.value; renderMonth(); }
    else if (which === 'main') { ui.filterMain = e.target.value; renderMonth(); }
  });
}

/* ================================================================== */
/* Insights: the numbers, the charts, and the optional on-device AI    */
/* ================================================================== */

// The AI is optional and off until asked for. Constructing the bridge starts nothing: no worker,
// no runtime file, no network. Everything a person sees here without AI is plain arithmetic.
const ai = insights.createAiBridge();
let aiViewDrawn = null;
let aiSignature = '';
let aiCanSummarise = false;
let aiReleaseTimer = 0;

const bytesText = insights.formatBytes;
const shortMonth = (key) => new Intl.DateTimeFormat(locale, { month: 'short' }).format(dateFromStr(`${key}-01`));

/** '' when this browser can run the model, otherwise the reason it can't. */
function aiSupport() {
  if (typeof Worker !== 'function' || typeof WebAssembly !== 'object') return 'This browser can\'t run the on-device AI.';
  if (!globalThis.caches) return 'The on-device AI needs a secure connection (https, or localhost) so the model can be kept on this device.';
  return '';
}

/** Which of the AI card's screens applies right now. */
function aiView() {
  const phase = ai.getState().phase;
  if (aiSupport()) return 'unsupported';
  if (phase === 'downloading') return 'downloading';
  if (phase === 'loading') return 'loading';
  if (ui.aiWorking || phase === 'writing') return 'writing';
  return phase === 'ready' || ui.aiCached ? 'ready' : 'off';
}

const wordsSoFar = (tokens) => Math.round(tokens * 0.75);

function insightsData() {
  const { categories: cats, transactions } = store.getState();
  const live = transactions.filter((t) => !t.deleted);
  const code = currencyCode();
  const facts = insights.computeInsights({ transactions: live, categories: cats, month: ui.month });
  const realFmt = insights.makeFormatter(code);
  const realLines = insights.factLines(facts, realFmt);
  return {
    cats, live, code, facts, realLines,
    labels: insights.labelFigures(facts, realFmt, code),
    canSummarise: insights.groupsOf(realLines).length > 0,
    signature: insights.factsSignature(realLines),
  };
}

/* ---------- the AI card ---------- */

function aiCardInner() {
  const s = ai.getState();
  const m = ai.model;
  const view = aiView();
  const shown = ui.aiText && ui.aiText.signature === aiSignature && !privacyOn() ? ui.aiText : null;
  const where = s.device === 'webgpu' ? 'your graphics chip (WebGPU)' : 'your processor (WebAssembly)';

  let body;
  if (view === 'unsupported') {
    body = html`<p class="text-sm muted">${aiSupport()}</p>`;
  } else if (view === 'downloading') {
    body = html`
      <div class="space-y-2">
        <p class="text-sm" id="ai-status" role="status">Downloading the model: <span id="ai-mb">${bytesText(s.loaded)} of ${bytesText(s.total)}</span></p>
        <progress id="ai-bar" class="h-3 w-full accent-teal-600" max="${s.total}" value="${s.loaded}" aria-labelledby="ai-status"></progress>
        <p class="text-sm muted">This happens once. You can keep using the app while it downloads.</p>
        <button type="button" class="btn-secondary" data-act="ai-stop" data-key="ai-stop" data-ai-primary>Cancel download</button>
      </div>`;
  } else if (view === 'loading') {
    body = html`
      <div class="space-y-2">
        <p class="text-sm" role="status">Getting the model ready…</p>
        <button type="button" class="btn-secondary" data-act="ai-stop" data-key="ai-stop" data-ai-primary>Cancel</button>
      </div>`;
  } else if (view === 'writing') {
    body = html`
      <div class="space-y-2">
        <p class="text-sm" role="status">Writing your summary… <span id="ai-words" class="muted">${s.tokens ? `about ${wordsSoFar(s.tokens)} words so far` : ''}</span></p>
        <p class="text-sm muted">On a phone this can take a minute. The rest of the app stays usable.</p>
        <button type="button" class="btn-secondary" data-act="ai-stop" data-key="ai-stop" data-ai-primary>Stop</button>
      </div>`;
  } else if (view === 'ready') {
    body = html`
      ${shown ? html`
        <div class="space-y-2">
          <p class="text-base leading-relaxed" id="ai-text">${shown.text}</p>
          <p class="text-sm text-emerald-800 dark:text-emerald-300">✓ Checked: each sentence uses only figures from its own numbers above.</p>
          ${shown.dropped ? html`<p class="text-sm muted">${plural(shown.dropped, 'sentence')} left out because ${shown.dropped === 1 ? 'it' : 'they'} didn't pass the check.</p>` : ''}
          <p class="text-xs muted">Written by ${m.name} on ${shown.device === 'webgpu' ? 'your graphics chip' : 'your processor'}, in ${shown.seconds}s. Nothing left this device.</p>
        </div>` : ''}
      ${ui.aiFail ? html`
        <p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status">${
  ui.aiFail.offenders
    ? html`The model's sentences didn't match the numbers above (${ui.aiFail.offenders.join('; ')}), so nothing was shown. The numbers above are still right. Try again, or just use them.`
    : ui.aiFail.message}</p>` : ''}
      ${privacyOn() ? html`<p class="text-sm muted">Summaries are hidden while Privacy Mode is on, because they contain your amounts.</p>` : ''}
      ${!aiCanSummarise ? html`<p class="text-sm muted">Nothing to summarise yet. Add a few transactions for this month.</p>` : ''}
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn-primary" data-act="ai-write" data-key="ai-write" data-ai-primary ${privacyOn() || !aiCanSummarise ? 'disabled' : ''}>${shown ? 'Write again' : 'Write summary'}</button>
        <button type="button" class="btn-link" data-act="ai-remove" data-key="ai-remove">Remove the model (frees ${bytesText(m.downloadBytes)})</button>
      </div>
      ${s.device ? html`<p class="text-xs muted">The model is loaded and runs on ${where}.</p>` : ''}`;
  } else {
    body = html`
      <div class="space-y-3">
        <p class="text-sm muted">Turns the numbers above into a few friendly sentences. It runs on this device, only when you ask, and every figure it writes is checked against the numbers above before you see it.</p>
        ${ui.aiFail && ui.aiFail.message ? html`<p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status">${ui.aiFail.message}</p>` : ''}
        <button type="button" class="btn-secondary" data-act="ai-enable" data-key="ai-enable" data-ai-primary>Enable AI insights</button>
      </div>`;
  }

  return html`
    <h3 id="ai-h" tabindex="-1" class="card-title">Plain-language summary <span class="text-sm font-normal muted">(optional)</span></h3>
    ${body}`;
}

/** Redraw just the AI card, keeping keyboard focus somewhere sensible if the button it was on went away. */
function renderAiCard() {
  const card = $('#ai-card');
  if (!card || store.isLocked()) return;
  const hadFocus = document.activeElement === document.body || card.contains(document.activeElement);
  aiViewDrawn = aiView();
  put(card, aiCardInner());
  if (hadFocus) ($('[data-ai-primary]', card) ?? $('#ai-h', card))?.focus({ preventScroll: true });
}

function wireAiState() {
  ai.subscribe((s) => {
    if (!$('#ai-card') || store.isLocked()) return;
    const view = aiView();
    if (view !== aiViewDrawn) { renderAiCard(); return; }
    // Same screen: only the numbers change, so patch them rather than rebuild (and lose focus).
    if (view === 'downloading') {
      const bar = $('#ai-bar');
      if (bar) { bar.max = s.total; bar.value = s.loaded; }
      const text = $('#ai-mb');
      if (text) text.textContent = `${bytesText(s.loaded)} of ${bytesText(s.total)}`;
    } else if (view === 'writing') {
      const words = $('#ai-words');
      if (words) words.textContent = s.tokens ? `about ${wordsSoFar(s.tokens)} words so far` : '';
    }
  });
}

async function refreshAiCached() {
  ui.aiCached = await ai.isCached();
  if (ui.tab === 'insights') renderAiCard();
}

/** Free the model's memory after a couple of quiet minutes; it reloads from the cache when next needed. */
function scheduleAiRelease() {
  clearTimeout(aiReleaseTimer);
  aiReleaseTimer = setTimeout(() => {
    if (!ui.aiWorking && ai.getState().phase === 'ready') ai.terminate();
  }, 120_000);
}

async function enableAi() {
  if (aiSupport()) return;
  const m = ai.model;
  const { done } = mountDialog(html`
    <div class="space-y-4 p-5">
      <h2 id="dlg-title" class="text-lg font-semibold">Download the on-device AI?</h2>
      <p class="muted">A small language model that turns your numbers into a few friendly sentences. It runs entirely on this device.</p>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li><strong>${bytesText(m.downloadBytes)}</strong> once, from Hugging Face (huggingface.co): the ${m.name} model, ${m.license}.</li>
        <li><strong>${bytesText(m.runtimeBytes)}</strong> once, from this app: the code that runs it.</li>
      </ul>
      <p class="text-sm"><strong>${bytesText(m.downloadBytes + m.runtimeBytes)} in total.</strong> It is kept in your browser afterwards, so it works offline and is never downloaded again. Use Wi-Fi if you are on mobile data.</p>
      <p class="text-sm muted">Nothing about your money is sent anywhere. Hugging Face will see that your device downloaded the model, as any website you visit would.</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="" autofocus>Not now</button>
        <button type="button" class="btn-primary" data-close="yes">Download ${bytesText(m.downloadBytes + m.runtimeBytes)}</button>
      </div>
    </div>`);
  if ((await done) !== 'yes') return;

  ui.aiFail = null;
  renderAiCard();
  try {
    await ai.load({ download: true });
    ui.aiCached = true;
    if (!store.isLocked()) toast('AI insights are ready. Everything stays on this device.');
  } catch (err) {
    if (err.code === 'cancelled') { if (!store.isLocked()) toast('Download cancelled.'); } else ui.aiFail = { message: err.message };
    ui.aiCached = await ai.isCached();
  }
  scheduleAiRelease();
  renderAiCard();
}

async function writeAiSummary() {
  if (privacyOn() || ui.aiWorking) return;
  const data = insightsData();
  if (!data.canSummarise) return;
  const started = performance.now();
  ui.aiFail = null;
  ui.aiText = null;
  ui.aiWorking = true;
  renderAiCard();
  try {
    // A returning visit: load from the cache only. This can never turn into a download.
    if (ai.getState().phase === 'idle') await ai.load({ download: false });
    const result = await insights.writeSummary({ lines: data.realLines, labels: data.labels, bridge: ai, currency: data.code });
    if (store.isLocked()) return;
    if (result.ok) {
      ui.aiText = { signature: data.signature, text: result.text, dropped: result.dropped.length, device: ai.getState().device, seconds: Math.max(1, Math.round((performance.now() - started) / 1000)) };
    } else {
      ui.aiFail = result.reason === 'figures' ? { offenders: result.offenders } : { message: 'The model didn\'t produce a usable summary. Try again.' };
    }
  } catch (err) {
    if (err.code === 'not-cached') { ui.aiCached = false; ui.aiFail = { message: err.message }; }
    else if (err.code !== 'cancelled') ui.aiFail = { message: err.message };
  } finally {
    ui.aiWorking = false;
    if (!store.isLocked()) { scheduleAiRelease(); renderAiCard(); }
  }
}

async function removeAiModel() {
  const m = ai.model;
  if (!(await confirmDialog({
    title: 'Remove the AI model?',
    message: `This frees about ${bytesText(m.downloadBytes)}. You can download it again whenever you like. Your numbers, charts and backups are not affected.`,
    confirmLabel: 'Remove model',
    danger: true,
  }))) return;
  await ai.removeModel();
  ui.aiCached = false;
  ui.aiText = null;
  ui.aiFail = null;
  renderAiCard();
  toast('AI model removed');
}

/** A lock forgets everything decrypted. A summary in progress holds figures, so it stops; a model download holds none, so it carries on. */
function releaseAiForLock() {
  clearTimeout(aiReleaseTimer);
  ui.aiText = null;
  ui.aiFail = null;
  if (ui.aiWorking) ai.terminate();
  ui.aiWorking = false;
}

/* ---------- the charts ---------- */

const chartCard = (title, body, note = '') => html`
  <section class="card" aria-label="${title}">
    <h3 class="card-title">${title}</h3>
    ${body}
    ${note ? html`<p class="mt-2 text-xs muted">${note}</p>` : ''}
  </section>`;

function donutCard(d) {
  const { facts, cats, code } = d;
  const hide = privacyOn();
  if (!facts.byMain.length) return chartCard('Spending by category', html`<p class="text-sm muted">No spending in ${fmtMonth.format(dateFromStr(`${ui.month}-01`))} yet.</p>`);

  const slices = facts.byMain.map((c) => ({
    name: c.name, value: c.amount, color: schema.findMain(cats, c.id)?.color,
    valueText: money.formatMoney(c.amount, code), sharePct: c.pct,
  }));
  const svg = donutChart({
    slices, showValues: !hide, totalText: money.formatMoney(facts.totals.spending, code), caption: 'spent',
    ariaLabel: `Spending by category: ${slices.map((s) => `${s.name} ${s.sharePct}%`).join(', ')}`,
  });
  return chartCard('Spending by category', html`
    <div class="grid items-center gap-4 sm:grid-cols-2">
      <div class="text-slate-700 dark:text-slate-300">${new Safe(svg)}</div>
      <ul class="space-y-1 text-sm">
        ${slices.map((s) => html`
          <li class="flex min-h-8 items-center gap-2">
            <span class="h-3 w-3 shrink-0 rounded-full" style="background: ${s.color}" aria-hidden="true"></span>
            <span class="min-w-0 flex-1 break-words">${s.name}</span>
            <span class="tabular-nums muted">${amountHtml(s.value)}</span>
            <span class="w-10 text-right font-medium tabular-nums">${s.sharePct}%</span>
          </li>`)}
      </ul>
    </div>`,
  `Savings & investments (${hide ? 'hidden' : money.formatMoney(facts.totals.savings, code)}) are counted apart from spending.`);
}

function barsCard(d) {
  const { live, cats, code } = d;
  const hide = privacyOn();
  const keys = Array.from({ length: 6 }, (_, i) => insights.shiftMonth(ui.month, i - 5));
  const rows = keys.map((key) => {
    const totals = schema.summarize(live.filter((t) => monthOf(t.date) === key), cats);
    return { key, income: totals.income, expenses: totals.spending };
  });
  const top = Math.max(...rows.flatMap((r) => [r.income, r.expenses]));
  if (top <= 0) return chartCard('Income and expenses, last 6 months', html`<p class="text-sm muted">Nothing logged in these six months yet.</p>`);

  const scale = niceScale(top);
  const svg = barChart({
    groups: rows.map((r) => ({ label: shortMonth(r.key), values: [r.income, r.expenses], valueTexts: [money.formatMoney(r.income, code), money.formatMoney(r.expenses, code)] })),
    series: [{ name: 'Income', color: '#0d9488' }, { name: 'Expenses', color: '#e11d48' }],
    ticks: scale.ticks.map((value) => ({ value, label: money.formatCompact(value, code) })),
    max: scale.max,
    showValues: !hide,
    ariaLabel: `Income and expenses for ${fmtMonth.format(dateFromStr(`${keys[0]}-01`))} to ${fmtMonth.format(dateFromStr(`${keys[5]}-01`))}. The table below has the figures.`,
  });
  return chartCard('Income and expenses, last 6 months', html`
    <div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-hidden="true">
      <span class="flex items-center gap-1.5"><span class="h-3 w-3 rounded-sm" style="background:#0d9488"></span>Income</span>
      <span class="flex items-center gap-1.5"><span class="h-3 w-3 rounded-sm" style="background:#e11d48"></span>Expenses</span>
    </div>
    <div class="text-slate-700 dark:text-slate-300">${new Safe(svg)}</div>
    <details class="mt-2">
      <summary class="btn-link">Show as a table</summary>
      <div class="overflow-x-auto">
        <table class="mt-2 w-full text-sm">
          <thead><tr class="text-left muted"><th class="py-1 pr-3 font-medium">Month</th><th class="py-1 pr-3 text-right font-medium">Income</th><th class="py-1 text-right font-medium">Expenses</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr class="border-t border-slate-200 dark:border-slate-800"><td class="py-1 pr-3">${fmtMonth.format(dateFromStr(`${r.key}-01`))}</td><td class="py-1 pr-3 text-right tabular-nums">${amountHtml(r.income)}</td><td class="py-1 text-right tabular-nums">${amountHtml(r.expenses)}</td></tr>`)}</tbody>
        </table>
      </div>
    </details>`,
  `Expenses don't include Savings & investments.${hide ? '' : ` Amounts in ${code}.`}`);
}

/* ---------- the view ---------- */

function insightsHtml() {
  const d = insightsData();
  aiSignature = d.signature;
  aiCanSummarise = d.canSummarise;
  const months = [...d.live.map((t) => monthOf(t.date)), monthOf(todayStr()), ui.month].sort();
  const [first, last] = [months[0], months.at(-1)];
  // Facts as the person sees them: amounts masked in Privacy Mode. The model is never shown these
  // (it gets the unmasked list, and only ever runs when Privacy Mode is off).
  const shownLines = insights.factLines(d.facts, insights.makeFormatter(d.code, { masked: privacyOn() }));

  return html`
    <div class="space-y-4">
      <h2 id="h-insights" tabindex="-1" class="text-lg font-semibold">Insights</h2>
      <div class="flex items-center justify-between">
        <button type="button" class="icon-btn" data-act="ins-prev" data-key="ins-prev" aria-label="Previous month" ${ui.month <= first ? 'disabled' : ''}>${icon('left')}</button>
        <p class="text-lg font-semibold" aria-live="polite">${fmtMonth.format(dateFromStr(`${ui.month}-01`))}</p>
        <button type="button" class="icon-btn" data-act="ins-next" data-key="ins-next" aria-label="Next month" ${ui.month >= last ? 'disabled' : ''}>${icon('right')}</button>
      </div>

      <section class="card" aria-labelledby="ins-facts-h">
        <h3 id="ins-facts-h" class="card-title">The numbers</h3>
        <ul class="list-disc space-y-1.5 pl-5 text-sm">${shownLines.map((l) => html`<li>${l.text}</li>`)}</ul>
        <p class="mt-3 text-xs muted">Worked out on this device from your transactions, with plain arithmetic. Savings & investments are counted apart from spending.</p>
      </section>

      <section id="ai-card" class="card space-y-3" aria-labelledby="ai-h">${aiCardInner()}</section>

      ${donutCard(d)}
      ${barsCard(d)}
    </div>`;
}

function renderInsights() {
  const root = $('#view-insights');
  withFocus(root, () => { put(root, insightsHtml()); aiViewDrawn = aiView(); });
}

function wireInsights() {
  const root = $('#view-insights');
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    switch (btn.dataset.act) {
      case 'ins-prev': ui.month = shiftMonth(ui.month, -1); renderInsights(); break;
      case 'ins-next': ui.month = shiftMonth(ui.month, 1); renderInsights(); break;
      case 'ai-enable': await enableAi(); break;
      case 'ai-write': await writeAiSummary(); break;
      case 'ai-stop': ai.interrupt(); break;
      case 'ai-remove': await removeAiModel(); break;
      default: break;
    }
  });
  wireAiState();
}

/* ================================================================== */
/* Currency                                                            */
/* ================================================================== */

/** Searchable ISO 4217 picker. Resolves with the chosen code, or null if cancelled. */
async function pickCurrency({ current, first = false }) {
  const list = money.listCurrencies();
  let selected = current;
  const { dlg, done } = mountDialog(html`
    <div class="space-y-4 p-5">
      <h2 id="dlg-title" class="text-lg font-semibold">${first ? 'Choose your currency' : 'Change currency'}</h2>
      ${first ? html`<p class="muted">S.E.L.F keeps everything on this device. Pick the currency you spend in. You can change it later in Settings.</p>` : ''}
      <div>
        <label class="field-label" for="cur-search">Search by code or name</label>
        <input id="cur-search" type="search" class="input" autocomplete="off" placeholder="UGX, shilling, dollar…" autofocus>
      </div>
      <div id="cur-list" role="radiogroup" aria-label="Currencies" class="max-h-64 overflow-y-auto rounded-xl border border-slate-300 p-1 dark:border-slate-700"></div>
      <div class="flex flex-wrap justify-end gap-2">
        ${first ? '' : html`<button type="button" class="btn-secondary" data-close="">Cancel</button>`}
        <button type="button" class="btn-primary" id="cur-ok" data-close="ok"></button>
      </div>
    </div>`, { dismissible: !first });

  const listEl = $('#cur-list', dlg);
  const okEl = $('#cur-ok', dlg);
  const searchEl = $('#cur-search', dlg);
  const drawOk = () => { okEl.textContent = first ? `Continue with ${selected}` : `Use ${selected}`; };
  const matches = () => money.searchCurrencies(list, searchEl.value);

  function drawList() {
    const rows = matches();
    put(listEl, rows.length ? html`${rows.map((c) => html`
      <label class="cur-row">
        <input type="radio" class="sr-only" name="cur" value="${c.code}" ${c.code === selected ? 'checked' : ''}>
        <span class="cur-face"><span><strong>${c.code}</strong> <span class="muted">${c.name}</span></span><span class="whitespace-nowrap text-sm muted">${c.symbol} · ${c.decimals} dp</span></span>
      </label>`)}` : html`<p class="p-3 text-sm muted">No currency matches that search.</p>`);
  }

  searchEl.addEventListener('input', drawList);
  searchEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const rows = matches();
    if (searchEl.value.trim() && rows.length) selected = rows[0].code;
    dlg.close('ok');
  });
  listEl.addEventListener('change', (e) => { selected = e.target.value; drawOk(); });
  drawList();
  drawOk();
  listEl.querySelector('input:checked')?.closest('label').scrollIntoView({ block: 'center' });

  return (await done) === 'ok' ? selected : null;
}

/** The mandatory warning before relabelling existing amounts. → 'relabel' | 'backup' | '' */
async function currencyWarning(from, to, info) {
  const before = money.currencyInfo(from);
  const after = money.currencyInfo(to);
  const example = privacyOn() ? '' : html`
    <p class="text-sm">For example, ${money.formatMoney(50000 * 10 ** before.decimals, from)} becomes ${money.formatMoney(50000 * 10 ** after.decimals, to)}.</p>`;
  const { done } = mountDialog(html`
    <div class="space-y-4 p-5">
      <h2 id="dlg-title" class="text-lg font-semibold">Change currency to ${to}?</h2>
      <div class="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <p class="font-semibold">Existing amounts will NOT be converted. They will be relabelled in the new currency.</p>
        <p class="text-sm">${from} has ${plural(before.decimals, 'decimal place')} and ${to} has ${after.decimals}, so values are adjusted to keep the same number: 50,000 stays 50,000, not 500.00.</p>
        ${example}
        ${info.rounded ? html`<p class="text-sm">${plural(info.rounded, 'transaction')} include${info.rounded === 1 ? 's' : ''} fractions that ${to} can't show and will be rounded to the nearest whole unit.</p>` : ''}
      </div>
      <p class="muted text-sm">${plural(info.count, 'transaction')} will be relabelled.</p>
      <div class="flex flex-col gap-2 sm:flex-row-reverse">
        <button type="button" class="btn-primary flex-1" data-close="relabel">Relabel only</button>
        <button type="button" class="btn-secondary flex-1" data-close="backup" autofocus>Cancel and export a backup first</button>
      </div>
    </div>`);
  return done;
}

async function changeCurrencyFlow() {
  const current = currencyCode();
  const code = await pickCurrency({ current });
  if (!code || code === current) return;
  const info = store.previewCurrencyChange(code);
  if (info.count === 0) {
    guard(() => store.changeCurrency(code));
    toast(`Currency set to ${code}`);
    return;
  }
  const choice = await currencyWarning(current, code, info);
  if (choice === 'relabel') {
    if (guard(() => { store.changeCurrency(code); return true; })) toast(`Relabelled ${plural(info.count, 'transaction')} as ${code}`);
  } else if (choice === 'backup') {
    exportJson();
    toast(`Backup downloaded. Your currency is still ${current}.`);
  }
}

/* ================================================================== */
/* Settings                                                            */
/* ================================================================== */

const switchHtml = ({ on, label, act, id = '', key }) => html`
  <button type="button" role="switch" class="switch" aria-checked="${String(on)}" aria-label="${label}"
          data-act="${act}" data-id="${id}" data-key="${key}"><span class="switch-track"><span class="switch-knob"></span></span></button>`;

function itemButtons(cats, item, used, isSub) {
  const pos = schema.positionOf(cats, item.id);
  const inUse = used.has(item.id) || (!isSub && item.subs.some((s) => used.has(s.id)));
  return html`
    <button type="button" class="icon-btn" data-act="move" data-dir="-1" data-id="${item.id}" data-key="up:${item.id}" aria-label="Move ${item.name} up" ${pos.index === 0 ? 'disabled' : ''}>${icon('up')}</button>
    <button type="button" class="icon-btn" data-act="move" data-dir="1" data-id="${item.id}" data-key="down:${item.id}" aria-label="Move ${item.name} down" ${pos.index === pos.count - 1 ? 'disabled' : ''}>${icon('down')}</button>
    <button type="button" class="icon-btn" data-act="rename" data-id="${item.id}" data-key="ren:${item.id}" aria-label="Rename or restyle ${item.name}">${icon('pencil')}</button>
    ${item.custom ? html`<button type="button" class="icon-btn ${inUse ? 'opacity-40' : ''}" data-act="delete-item" data-id="${item.id}" data-key="rm:${item.id}" aria-label="Delete ${item.name}${inUse ? ' (has transactions, hide it instead)' : ''}">${icon('trash')}</button>` : ''}`;
}

function mainCardHtml(cats, main, used) {
  const open = ui.openMains.has(main.id);
  return html`
    <li class="rounded-xl border border-slate-200 dark:border-slate-700">
      <div class="flex items-center gap-1 pl-1">
        <button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left" data-act="toggle-open" data-id="${main.id}" data-key="open:${main.id}" aria-expanded="${String(open)}">
          <span class="${open ? 'rotate-90' : ''} transition-transform" aria-hidden="true">${icon('right', 18)}</span>
          <span class="dot" style="--cat: ${main.color}" aria-hidden="true">${main.emoji}</span>
          <span class="min-w-0 truncate font-medium ${main.enabled ? '' : 'muted line-through'}">${main.name}</span>
          <span class="shrink-0 text-xs muted">${plural(main.subs.length, 'item')}</span>
        </button>
        ${switchHtml({ on: main.enabled, label: `Show ${main.name} in the entry form`, act: 'toggle-item', id: main.id, key: `tog:${main.id}` })}
      </div>
      ${open ? html`
        <div class="border-t border-slate-200 px-2 pb-2 dark:border-slate-700">
          <div class="flex flex-wrap items-center gap-1 py-1">
            <span class="mr-auto pl-1 text-sm muted">${main.name}${main.custom ? ' · custom' : ''}${main.isSavings ? ' · counted as savings' : ''}</span>
            ${itemButtons(cats, main, used, false)}
          </div>
          <ul class="space-y-1">
            ${main.subs.map((sub) => html`
              <li class="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 pl-3 dark:bg-slate-800">
                <span class="flex min-h-11 min-w-[7rem] flex-1 items-center gap-2 ${sub.enabled ? '' : 'muted line-through'}">
                  ${sub.emoji ? html`<span aria-hidden="true">${sub.emoji}</span>` : ''}<span>${sub.name}</span>
                  ${sub.requiresNote ? html`<span class="text-xs muted">note required</span>` : ''}${sub.custom ? html`<span class="text-xs muted">custom</span>` : ''}
                </span>
                ${switchHtml({ on: sub.enabled, label: `Show ${sub.name} in the entry form`, act: 'toggle-item', id: sub.id, key: `tog:${sub.id}` })}
                ${itemButtons(cats, sub, used, true)}
              </li>`)}
          </ul>
          <button type="button" class="btn-link mt-1" data-act="add-field" data-type="${main.type}" data-parent="${main.id}" data-key="addsub:${main.id}">+ Add sub-category to ${main.name}</button>
        </div>` : ''}
    </li>`;
}

function settingsHtml() {
  const { settings, categories: cats, transactions } = store.getState();
  const cur = money.currencyInfo(settings.currency);
  const used = schema.usedCategoryIds(transactions);
  const mains = cats.filter((m) => m.type === ui.settingsType);
  const live = transactions.filter((t) => !t.deleted).length;
  const kb = Math.max(1, Math.round(store.approxBytes() / 1024));

  return html`
    <div class="space-y-4">
      <h2 id="h-settings" tabindex="-1" class="text-lg font-semibold">Settings</h2>

      <section class="card" aria-labelledby="s-currency">
        <h3 id="s-currency" class="card-title">Currency</h3>
        <p><strong>${cur.code}</strong> <span class="muted">${cur.name}</span></p>
        <p class="text-sm muted">Symbol ${cur.symbol} · ${plural(cur.decimals, 'decimal place')}. Set automatically from the code.</p>
        <button type="button" class="btn-secondary mt-3" data-act="change-currency" data-key="change-currency">Change currency</button>
      </section>

      <section class="card space-y-3" aria-labelledby="s-look">
        <h3 id="s-look" class="card-title">Privacy and appearance</h3>
        <div class="flex items-center justify-between gap-3">
          <div><p class="font-medium">Privacy mode</p><p class="text-sm muted">Hides every amount on every screen.</p></div>
          ${switchHtml({ on: settings.privacyMode, label: 'Privacy mode', act: 'toggle-privacy', key: 'privacy-switch' })}
        </div>
        <fieldset>
          <legend class="field-label">Theme</legend>
          <div class="seg-wrap !grid-cols-3" role="radiogroup">
            ${['system', 'light', 'dark'].map((t) => html`
              <label class="seg"><input type="radio" class="sr-only" name="theme" value="${t}" data-setting="theme" data-key="theme:${t}" ${settings.theme === t ? 'checked' : ''}><span class="seg-face">${t[0].toUpperCase()}${t.slice(1)}</span></label>`)}
          </div>
        </fieldset>
      </section>

      ${securityHtml(settings)}

      ${syncCardHtml()}

      <section class="card" aria-labelledby="s-cats">
        <h3 id="s-cats" class="card-title">Categories</h3>
        <p class="mb-3 text-sm muted">Switch a category off to hide it from the entry form. Past transactions keep their label. Built-in categories can be hidden but not deleted.</p>
        <div class="seg-wrap mb-3" role="radiogroup" aria-label="Category type">
          ${['expense', 'income'].map((t) => html`
            <label class="seg"><input type="radio" class="sr-only" name="cat-type" value="${t}" data-setting="cat-type" data-key="cat-type:${t}" ${ui.settingsType === t ? 'checked' : ''}><span class="seg-face">${t === 'expense' ? 'Expenses' : 'Income'}</span></label>`)}
        </div>
        <ul class="space-y-2">${mains.map((m) => mainCardHtml(cats, m, used))}</ul>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="btn-secondary" data-act="add-field" data-type="${ui.settingsType}" data-key="add-field">+ Add custom field</button>
          <button type="button" class="btn-danger" data-act="reset-cats" data-key="reset-cats">Reset to defaults</button>
        </div>
      </section>

      <section class="card" aria-labelledby="s-backup">
        <h3 id="s-backup" class="card-title">Backup</h3>
        <p class="mb-3 text-sm muted">Your data lives only in this browser. Export a backup now and then, especially before clearing browser data or switching devices.</p>
        <div class="flex flex-wrap gap-2">
          ${store.isEncrypted() ? html`<button type="button" class="btn-primary" data-act="export-self" data-key="export-self">Export encrypted backup (.self)</button>` : ''}
          <button type="button" class="btn-secondary" data-act="export-json" data-key="export-json">Export JSON (unencrypted)</button>
          <button type="button" class="btn-secondary" data-act="export-csv" data-key="export-csv">Export CSV (unencrypted)</button>
          <button type="button" class="btn-secondary" data-act="import" data-key="import">Import a backup…</button>
        </div>
        ${store.isEncrypted() ? html`<p class="mt-3 text-sm muted">A <strong>.self</strong> file opens with this passphrase on any device. The JSON and CSV files are plain text that anyone can read — treat them like cash.</p>` : ''}
        <p class="mt-3 text-sm muted">${plural(live, 'transaction')} on this device · about ${kb} KB used of roughly 5 MB.</p>
      </section>
    </div>`;
}

const AUTO_LOCK_LABEL = (m) => (m === 0 ? 'Never (not recommended)' : plural(m, 'minute'));

function securityHtml(settings) {
  if (!store.isEncrypted()) {
    return html`
      <section class="card space-y-3" aria-labelledby="s-security">
        <h3 id="s-security" class="card-title">Security</h3>
        <p class="text-sm"><strong>This ledger is not encrypted.</strong> It is stored in this browser as plain text, so anyone who can open this browser profile can read it.</p>
        ${store.isCryptoAvailable()
    ? html`<button type="button" class="btn-primary" data-act="encrypt" data-key="encrypt"><span>${icon('shield', 20)}</span>Protect with a passphrase</button>`
    : html`<p class="text-sm muted">Encryption needs a secure connection. Open S.E.L.F over https, or from localhost.</p>`}
      </section>`;
  }
  return html`
    <section class="card space-y-3" aria-labelledby="s-security">
      <h3 id="s-security" class="card-title">Security</h3>
      <p class="text-sm"><strong>Encrypted on this device.</strong> AES-GCM 256. The key is derived from your passphrase with PBKDF2-SHA256 at 600,000 iterations and is never written down anywhere.</p>
      <div>
        <label class="field-label" for="s-autolock">Lock automatically after</label>
        <select id="s-autolock" class="input" data-setting="autolock" data-key="autolock">
          ${store.AUTO_LOCK_CHOICES.map((m) => html`<option value="${m}" ${settings.autoLockMinutes === m ? 'selected' : ''}>${AUTO_LOCK_LABEL(m)}</option>`)}
        </select>
        <p class="mt-1 text-sm muted">Also locks when this tab has been in the background that long.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-secondary" data-act="lock-now" data-key="lock-now">${icon('lock', 20)}Lock now</button>
        <button type="button" class="btn-secondary" data-act="change-passphrase" data-key="change-passphrase">Change passphrase</button>
      </div>
      <p class="text-sm muted">${FORGOTTEN}</p>
    </section>`;
}

function renderSettings() {
  const root = $('#view-settings');
  withFocus(root, () => put(root, settingsHtml()));
}

function swatchesHtml(name, current) {
  const options = [{ name: 'Automatic', hex: '' }, ...schema.COLOR_CHOICES];
  if (current && !options.some((c) => c.hex === current)) options.splice(1, 0, { name: 'Current colour', hex: current });
  return html`${options.map((c) => html`
    <label class="swatch">
      <input type="radio" class="sr-only" name="${name}" value="${c.hex}" ${c.hex === current ? 'checked' : ''}>
      <span class="swatch-dot ${c.hex ? '' : 'swatch-none'}" ${c.hex ? html`style="--sw: ${c.hex}"` : ''}></span>
      <span class="sr-only">${c.name}</span>
    </label>`)}`;
}

/** Dialog for "Add custom field" (sub-category or main category) and for rename/restyle. */
async function itemDialog({ item = null, type = 'expense', parentId = '' }) {
  const editing = Boolean(item);
  const cats = store.getCategories();
  let kind = type;
  const { dlg, done } = mountDialog(html`
    <form class="space-y-4 p-5" novalidate autocomplete="off">
      <h2 id="dlg-title" class="text-lg font-semibold">${editing ? `Rename or restyle "${item.name}"` : 'Add custom field'}</h2>
      ${editing ? '' : html`
        <fieldset>
          <legend class="field-label">Type</legend>
          <div class="seg-wrap">
            ${['expense', 'income'].map((t) => html`<label class="seg"><input type="radio" class="sr-only" name="af-type" value="${t}" ${t === kind ? 'checked' : ''}><span class="seg-face">${t === 'expense' ? 'Expense' : 'Income'}</span></label>`)}
          </div>
        </fieldset>
        <div><label class="field-label" for="af-parent">Parent category</label><select id="af-parent" class="input"></select></div>`}
      <div>
        <label class="field-label" for="af-name">Name</label>
        <input id="af-name" class="input" maxlength="40" required autofocus value="${editing ? item.name : ''}">
      </div>
      <div>
        <label class="field-label" for="af-emoji">Emoji <span class="font-normal muted">(optional)</span></label>
        <input id="af-emoji" class="input" maxlength="16" placeholder="e.g. 🌽" value="${editing ? item.emoji : ''}">
      </div>
      <fieldset>
        <legend class="field-label">Colour <span class="font-normal muted">(optional)</span></legend>
        <div class="flex flex-wrap">${swatchesHtml('af-color', editing ? item.color : '')}</div>
      </fieldset>
      <p id="af-error" role="alert" class="min-h-5 text-sm font-medium text-rose-700 dark:text-rose-300"></p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="">Cancel</button>
        <button type="submit" class="btn-primary">${editing ? 'Save' : 'Add'}</button>
      </div>
    </form>`);

  const parentEl = $('#af-parent', dlg);
  const errorEl = $('#af-error', dlg);
  if (!editing) {
    const drawParents = (selected) => {
      put(parentEl, html`
        ${cats.filter((m) => m.type === kind).map((m) => html`<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${m.emoji} ${m.name}${m.enabled ? '' : ' (hidden)'}</option>`)}
        <option value="__new">＋ New main category…</option>`);
    };
    drawParents(parentId);
    dlg.addEventListener('change', (e) => {
      if (e.target.name === 'af-type') { kind = e.target.value; drawParents(''); }
    });
  }

  $('form', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    const values = {
      name: $('#af-name', dlg).value,
      emoji: $('#af-emoji', dlg).value,
      color: dlg.querySelector('input[name="af-color"]:checked')?.value ?? '',
    };
    try {
      let next;
      if (editing) {
        next = schema.updateItem(cats, item.id, values);
      } else if (parentEl.value === '__new') {
        next = schema.addMain(cats, { type: kind, ...values });
        const created = next.find((m) => !cats.some((c) => c.id === m.id));
        ui.openMains.add(created.id);
      } else {
        next = schema.addSub(cats, parentEl.value, values);
        ui.openMains.add(parentEl.value);
      }
      store.saveCategories(next);
      if (!editing) ui.settingsType = kind;
    } catch (err) {
      if (!isFriendly(err)) throw err;
      errorEl.textContent = err.message;
      $('#af-name', dlg).focus();
      return;
    }
    dlg.close('saved');
    toast(editing ? 'Saved' : `Added "${values.name.trim()}". It's in the entry form now.`);
  });

  await done;
}

function wireSettings() {
  const root = $('#view-settings');

  root.addEventListener('change', (e) => {
    const setting = e.target.dataset.setting;
    if (setting === 'theme') guard(() => store.updateSettings({ theme: e.target.value }));
    else if (setting === 'autolock') guard(() => store.updateSettings({ autoLockMinutes: Number(e.target.value) }));
    else if (setting === 'cat-type') { ui.settingsType = e.target.value; renderSettings(); }
  });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    const cats = store.getCategories();

    switch (act) {
      case 'change-currency': await changeCurrencyFlow(); break;
      case 'toggle-privacy': guard(() => store.updateSettings({ privacyMode: !privacyOn() })); break;
      case 'toggle-open':
        if (ui.openMains.has(id)) ui.openMains.delete(id); else ui.openMains.add(id);
        renderSettings();
        break;
      case 'toggle-item': {
        const on = btn.getAttribute('aria-checked') === 'true';
        guard(() => store.saveCategories(schema.updateItem(cats, id, { enabled: !on })));
        break;
      }
      case 'move': guard(() => store.saveCategories(schema.moveItem(cats, id, Number(btn.dataset.dir)))); break;
      case 'rename': {
        const main = schema.findMain(cats, id);
        const sub = main ? null : cats.flatMap((m) => m.subs).find((s) => s.id === id);
        await itemDialog({ item: main ?? sub });
        break;
      }
      case 'delete-item': {
        const item = schema.findMain(cats, id) ?? cats.flatMap((m) => m.subs).find((s) => s.id === id);
        const used = schema.usedCategoryIds(store.getTransactions());
        try { schema.removeItem(cats, id, used); } catch (err) { // check the rules first so the message is specific
          if (!isFriendly(err)) throw err;
          toast(err.message);
          break;
        }
        if (await confirmDialog({ title: `Delete "${item.name}"?`, message: 'No transaction uses it, so it can be removed for good. This can\'t be undone.', confirmLabel: 'Delete', danger: true })) {
          guard(() => store.saveCategories(schema.removeItem(store.getCategories(), id, schema.usedCategoryIds(store.getTransactions()))));
        }
        break;
      }
      case 'add-field': await itemDialog({ type: btn.dataset.type, parentId: btn.dataset.parent ?? '' }); break;
      case 'reset-cats':
        if (await confirmDialog({
          title: 'Reset categories to defaults?',
          message: 'Names, order and on/off switches go back to the built-in list, and custom categories nobody uses are removed. Custom categories that transactions still use are kept but switched off. Your transactions are not changed.',
          confirmLabel: 'Reset to defaults',
          danger: true,
        })) {
          guard(() => store.saveCategories(schema.resetToDefaults(store.getCategories(), schema.usedCategoryIds(store.getTransactions()))));
          toast('Categories reset to defaults');
        }
        break;
      case 'encrypt': showLock('setup'); break;
      case 'sync-open': await syncSetupFlow(); break;
      case 'sync-now': await guardAsync(() => sync.syncNow()); break;
      case 'sync-signout': await syncSignOutFlow(); break;
      case 'sync-delete': await syncDeleteFlow(); break;
      case 'lock-now': await lockNow(); break;
      case 'change-passphrase': await changePassphraseFlow(); break;
      case 'export-self': await exportEncrypted(); break;
      case 'export-json': exportJson(); break;
      case 'export-csv': exportCsv(); break;
      case 'import': $('#import-file').click(); break;
      default: break;
    }
  });
}

/* ================================================================== */
/* Backup                                                              */
/* ================================================================== */

/** Like guard(), for the asynchronous crypto paths. */
async function guardAsync(fn) {
  try { return await fn(); } catch (err) {
    if (!isFriendly(err)) throw err;
    toast(err.message);
    return undefined;
  }
}

function exportJson() {
  download(`self-backup-${stamp()}.json`, JSON.stringify(store.exportBackup(), null, 2), 'application/json');
}

/** The sealed .self backup: the same document, encrypted with this device's key. */
async function exportEncrypted() {
  const text = await guardAsync(() => store.exportEncryptedBackup());
  if (text) {
    download(`self-backup-${stamp()}.self`, text, 'application/octet-stream');
    toast('Encrypted backup saved. It opens with your passphrase.');
  }
}

/** Ask for a passphrase in a dialog. → the passphrase, or null if cancelled. */
async function askPassphrase({ title, message, confirmLabel = 'Continue' }) {
  let entered = null;
  const { dlg, done } = mountDialog(html`
    <form class="space-y-4 p-5" novalidate>
      <h2 id="dlg-title" class="text-lg font-semibold">${title}</h2>
      <p class="muted">${message}</p>
      ${passphraseField({ id: 'ask-pass', label: 'Passphrase', autocomplete: 'current-password' })}
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="">Cancel</button>
        <button type="submit" class="btn-primary">${confirmLabel}</button>
      </div>
    </form>`);
  wirePeek(dlg);
  $('form', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    entered = $('#ask-pass', dlg).value;
    dlg.close('ok');
  });
  $('#ask-pass', dlg).focus();
  return (await done) === 'ok' ? entered : null;
}

async function changePassphraseFlow() {
  const { dlg, done } = mountDialog(html`
    <form class="space-y-4 p-5" novalidate>
      <h2 id="dlg-title" class="text-lg font-semibold">Change passphrase</h2>
      <p class="muted">Everything is re-encrypted with a brand new key. Backup files you already exported still open with the old passphrase.</p>
      ${passphraseField({ id: 'cp-old', label: 'Current passphrase', autocomplete: 'current-password' })}
      ${passphraseField({ id: 'cp-new', label: 'New passphrase', autocomplete: 'new-password', describedBy: 'cp-meter' })}
      <p id="cp-meter" class="min-h-10 text-sm muted" aria-live="polite"></p>
      ${passphraseField({ id: 'cp-confirm', label: 'Confirm new passphrase', autocomplete: 'new-password' })}
      <p id="cp-error" role="alert" class="min-h-5 text-sm font-medium text-rose-700 dark:text-rose-300"></p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="">Cancel</button>
        <button type="submit" class="btn-primary" id="cp-save">Change passphrase</button>
      </div>
    </form>`);
  wirePeek(dlg);

  const fail = (message, field) => { $('#cp-error', dlg).textContent = message; $(`#${field}`, dlg).focus(); };
  $('#cp-new', dlg).addEventListener('input', (e) => {
    const { score, label, bits, hint } = passphraseStrength(e.target.value);
    $('#cp-meter', dlg).textContent = e.target.value ? (score === 0 ? `${label} — ${hint}` : `${label} (roughly ${bits} bits) — ${hint}`) : '';
  });

  $('form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#cp-error', dlg).textContent = '';
    const next = $('#cp-new', dlg).value;
    if (next.length < MIN_PASSPHRASE) return fail(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`, 'cp-new');
    if (next !== $('#cp-confirm', dlg).value) return fail('The new passphrases do not match.', 'cp-confirm');
    try {
      await busy($('#cp-save', dlg), 'Re-encrypting…', () => store.changePassphrase($('#cp-old', dlg).value, next));
    } catch (err) {
      if (!isFriendly(err)) throw err;
      return fail(err.message, 'cp-old');
    }
    dlg.close('done');
    toast('Passphrase changed. Export a fresh backup.');
    return undefined;
  });

  await done;
}

function exportCsv() {
  const csv = buildCsv(store.getState());
  download(`self-transactions-${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
}

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/**
 * Read a backup file, asking for its passphrase if it is a sealed .self.
 * → a parsed backup, or null if the person gave up. A wrong passphrase can be retried.
 */
async function readBackupFile(file) {
  if (file.size > MAX_IMPORT_BYTES) throw new store.StoreError('That file is too large to be a S.E.L.F backup.');
  const text = await file.text();
  if (!store.looksEncrypted(text)) return store.parseBackup(text);

  for (;;) {
    const passphrase = await askPassphrase({
      title: 'This backup is encrypted',
      message: `Enter the passphrase that ${file.name} was exported with. It does not have to match this device's passphrase.`,
      confirmLabel: 'Open backup',
    });
    if (passphrase === null) return null;
    try {
      return await store.parseEncryptedBackup(text, passphrase);
    } catch (err) {
      if (!isFriendly(err)) throw err;
      await alertDialog('Couldn\'t open that backup', err.message);
    }
  }
}

async function importFile(file) {
  let parsed;
  let report;
  try {
    parsed = await readBackupFile(file);
    if (!parsed) return;
    report = store.previewImport(parsed);
  } catch (err) {
    if (!isFriendly(err)) throw err;
    await alertDialog('Couldn\'t import that file', err.message);
    return;
  }

  const { done } = mountDialog(html`
    <div class="space-y-4 p-5">
      <h2 id="dlg-title" class="text-lg font-semibold">${plural(report.found, 'transaction')} found. Merge or replace?</h2>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li><strong>${report.added}</strong> new to this device</li>
        <li><strong>${report.updated}</strong> newer than the copy you have (would update it)</li>
        <li><strong>${report.same}</strong> already here, unchanged</li>
        ${report.removed ? html`<li>${plural(report.removed, 'deleted record')} included (kept so nothing is lost)</li>` : ''}
        <li>Currency in the backup: <strong>${report.currency}</strong> · ${plural(report.customCategories, 'custom category', 'custom categories')}</li>
        ${report.exportedAt ? html`<li>Exported ${fmtStamp.format(new Date(report.exportedAt))}</li>` : ''}
      </ul>
      ${report.skipped ? html`<p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">${plural(report.skipped, 'record')} in the file ${report.skipped === 1 ? 'is' : 'are'} invalid and will be skipped.</p>` : ''}
      <p class="text-sm muted"><strong>Merge</strong> keeps what is here and adds or updates by ID; the newer edit wins. <strong>Replace</strong> makes this device exactly match the backup. It has ${plural(report.localCount, 'transaction')} now.</p>
      ${report.mergeBlocked ? html`<p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">This backup is in ${report.currency} but this device uses ${report.localCurrency}. Merging would mix currencies, so only Replace is available.</p>` : ''}
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="" autofocus>Cancel</button>
        <button type="button" class="btn-danger" data-close="replace">Replace</button>
        <button type="button" class="btn-primary" data-close="merge" ${report.mergeBlocked ? 'disabled' : ''}>Merge</button>
      </div>
    </div>`);
  const mode = await done;
  if (!mode) return;

  if (mode === 'replace' && report.localCount > 0) {
    const sure = await confirmDialog({
      title: 'Replace everything on this device?',
      message: `Your ${plural(report.localCount, 'current transaction')} will be removed and replaced by the backup. Export a backup first if you are unsure.`,
      confirmLabel: 'Replace everything',
      danger: true,
    });
    if (!sure) return;
  }
  const ok = guard(() => { store.applyImport(parsed, mode); return true; });
  if (!ok) return;
  ui.filterType = 'all';
  ui.filterMain = 'all';
  toast(mode === 'merge'
    ? `Merged: ${report.added} added, ${report.updated} updated.`
    : `Restored ${plural(report.found, 'transaction')}.`);
}

function wireImport() {
  const input = $('#import-file');
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = ''; // so choosing the same file again still fires "change"
    if (file) await importFile(file);
  });
}

/* ================================================================== */
/* Lock screen: unlock, first-run setup, auto-lock                     */
/* ================================================================== */

const FORGOTTEN = 'If you forget this passphrase, your data cannot be recovered. Nobody can reset it — not us, not your browser. Keep an exported backup.';

let lockKind = null;     // 'unlock' | 'setup' | 'damaged' | null when the ledger is open
let countdownTimer = 0;

const lockEl = () => $('#lock');

/** Let the show/hide button work inside any container (the lock screen, or a dialog). */
function wirePeek(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="peek"]');
    if (!btn) return;
    const field = $(`#${btn.dataset.target}`, root);
    const show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
    put(btn, icon(show ? 'eyeOff' : 'eye'));
    field.focus();
  });
}

/** A passphrase box with a show/hide button. Never rendered with a value in the markup. */
const passphraseField = ({ id, label, autocomplete, describedBy = '' }) => html`
  <div>
    <label class="field-label" for="${id}">${label}</label>
    <div class="flex gap-2">
      <input id="${id}" type="password" class="input" autocomplete="${autocomplete}" autocapitalize="off"
             autocorrect="off" spellcheck="false" ${describedBy ? html`aria-describedby="${describedBy}"` : ''}>
      <button type="button" class="btn-secondary !px-3" data-act="peek" data-target="${id}"
              aria-pressed="false" aria-label="Show passphrase">${icon('eye')}</button>
    </div>
  </div>`;

const lockFrame = (title, subtitle, body) => html`
  <div class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-4 py-8">
    <div class="text-center">
      <span class="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-700 text-white dark:bg-teal-400 dark:text-slate-950" aria-hidden="true">${icon('lock', 28)}</span>
      <h1 id="lock-title" tabindex="-1" class="text-xl font-bold tracking-tight">${title}</h1>
      <p class="mt-1 text-sm muted">${subtitle}</p>
    </div>
    ${body}
  </div>`;

function unlockHtml(message) {
  return lockFrame('S.E.L.F is locked', 'Enter your passphrase to open your ledger.', html`
    <form class="space-y-4" novalidate>
      ${message ? html`<p class="rounded-xl border border-slate-300 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900" role="status">${message}</p>` : ''}
      ${passphraseField({ id: 'lk-pass', label: 'Passphrase', autocomplete: 'current-password', describedBy: 'lk-error' })}
      <p id="lk-error" role="alert" class="min-h-5 text-sm font-medium text-rose-700 dark:text-rose-300"></p>
      <button type="submit" class="btn-primary w-full" id="lk-submit">Unlock</button>
      <div class="border-t border-slate-200 pt-3 dark:border-slate-800">
        <p class="text-sm muted">${FORGOTTEN}</p>
        <button type="button" class="btn-link !px-0" data-act="erase">Forgotten it? Start a new ledger…</button>
      </div>
    </form>`);
}

function setupHtml() {
  const count = store.getTransactions().filter((t) => !t.deleted).length;
  return lockFrame('Protect your ledger', 'A passphrase encrypts everything this app stores on this device.', html`
    <form class="space-y-4" novalidate>
      <ul class="space-y-1 text-sm muted">
        <li>Your ledger is encrypted with AES-GCM before it is written to this browser.</li>
        <li>The passphrase never leaves this device and is never stored anywhere.</li>
        <li id="lk-existing" ${count ? '' : 'hidden'}><strong>${plural(count, 'transaction')} already on this device will be encrypted.</strong></li>
      </ul>
      ${passphraseField({ id: 'lk-pass', label: 'Passphrase', autocomplete: 'new-password', describedBy: 'lk-meter-text' })}
      <div>
        <div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden="true">
          <div id="lk-meter-bar" class="h-full w-0 rounded-full transition-all"></div>
        </div>
        <p id="lk-meter-text" class="mt-1 min-h-10 text-sm muted" aria-live="polite">At least ${MIN_PASSPHRASE} characters. Four unrelated words are easy to remember and hard to guess.</p>
      </div>
      ${passphraseField({ id: 'lk-pass2', label: 'Confirm passphrase', autocomplete: 'new-password' })}
      <p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <strong>${FORGOTTEN}</strong>
      </p>
      <p id="lk-error" role="alert" class="min-h-5 text-sm font-medium text-rose-700 dark:text-rose-300"></p>
      <button type="submit" class="btn-primary w-full" id="lk-submit">Encrypt my ledger</button>
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
        <button type="button" class="btn-secondary" data-act="skip">Skip for now</button>
        <button type="button" class="btn-link" data-act="restore">Restore from a backup…</button>
      </div>
    </form>`);
}

function damagedHtml() {
  return lockFrame('This ledger can\'t be opened', 'The encrypted data in this browser is damaged, so no passphrase will open it.', html`
    <div class="space-y-4">
      <p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        Nothing has been deleted. If you have a backup file, restore it into a new ledger.
      </p>
      <button type="button" class="btn-primary w-full" data-act="restore">Restore from a backup…</button>
      <button type="button" class="btn-danger w-full" data-act="erase">Erase this ledger and start again</button>
    </div>`);
}

function renderLock() {
  const root = lockEl();
  if (lockKind === 'setup') put(root, setupHtml());
  else if (lockKind === 'damaged') put(root, damagedHtml());
  else put(root, unlockHtml(root.dataset.message || ''));
  applyTheme();
  const focus = $('#lk-pass', root) ?? $('[data-act]', root);
  focus?.focus({ preventScroll: true });
  if (lockKind === 'unlock') tickCountdown();
}

function showLock(kind, message = '') {
  lockKind = kind;
  stopAutoLock();
  const root = lockEl();
  root.dataset.message = message;
  root.hidden = false;
  $('#app-shell').hidden = true;
  $('#app-nav').hidden = true;
  renderLock();
}

function hideLock() {
  lockKind = null;
  clearTimeout(countdownTimer);
  lockEl().replaceChildren();
  lockEl().hidden = true;
  $('#app-shell').hidden = false;
  $('#app-nav').hidden = false;
}

/** While the throttle is running, the Unlock button is disabled and counts down. */
function tickCountdown() {
  clearTimeout(countdownTimer);
  const btn = $('#lk-submit');
  if (!btn) return;
  const left = store.lockoutRemaining();
  if (left <= 0) {
    btn.disabled = false;
    btn.textContent = 'Unlock';
    return;
  }
  btn.disabled = true;
  btn.textContent = `Try again in ${Math.ceil(left / 1000)}s`;
  countdownTimer = setTimeout(tickCountdown, 250);
}

function lockError(message) {
  const el = $('#lk-error');
  if (el) el.textContent = message;
}

async function busy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function submitUnlock() {
  const input = $('#lk-pass');
  lockError('');
  try {
    await busy($('#lk-submit'), 'Unlocking…', () => store.unlock(input.value));
  } catch (err) {
    if (!isFriendly(err)) throw err;
    input.value = '';
    lockError(err.message);
    tickCountdown();
    input.focus();
    return;
  }
  input.value = '';
  await openLedger();
}

function drawMeter() {
  const value = $('#lk-pass').value;
  const bar = $('#lk-meter-bar');
  const text = $('#lk-meter-text');
  if (!value) {
    bar.style.width = '0';
    text.textContent = `At least ${MIN_PASSPHRASE} characters. Four unrelated words are easy to remember and hard to guess.`;
    return;
  }
  const { score, label, bits, hint } = passphraseStrength(value);
  const colors = ['#dc2626', '#dc2626', '#f59e0b', '#0d9488', '#15803d'];
  bar.style.width = `${Math.max(6, score * 25)}%`;
  bar.style.background = colors[score];
  text.textContent = score === 0 ? `${label} — ${hint}` : `${label} (roughly ${bits} bits) — ${hint}`;
}

async function submitSetup() {
  const first = $('#lk-pass');
  const second = $('#lk-pass2');
  lockError('');
  if (first.value.length < MIN_PASSPHRASE) {
    lockError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
    first.focus();
    return;
  }
  if (first.value !== second.value) {
    lockError('Those two passphrases do not match.');
    second.focus();
    return;
  }
  if (passphraseStrength(first.value).score <= 1) {
    const go = await confirmDialog({
      title: 'Use this passphrase anyway?',
      message: 'It would not take long to guess. Anyone who can guess it can read your ledger. A few unrelated words would be much stronger.',
      confirmLabel: 'Use it anyway',
      danger: true,
    });
    if (!go) { first.focus(); return; }
  }
  try {
    await busy($('#lk-submit'), 'Encrypting…', () => store.setupEncryption(first.value));
  } catch (err) {
    if (!isFriendly(err)) throw err;
    lockError(err.message);
    return;
  }
  first.value = '';
  second.value = '';
  await openLedger();
  toast('Your ledger is encrypted on this device');
  // A passphrase with no backup is a single point of failure, so ask straight away.
  if (await confirmDialog({
    title: 'Export a backup now?',
    message: 'An encrypted backup file is the only way back if this browser\'s data is cleared. It opens with the same passphrase.',
    confirmLabel: 'Export encrypted backup',
  })) await exportEncrypted();
}

async function eraseFlow() {
  const { dlg, done } = mountDialog(html`
    <form class="space-y-4 p-5" novalidate>
      <h2 id="dlg-title" class="text-lg font-semibold">Erase this ledger?</h2>
      <p class="muted">This deletes the encrypted data in this browser for good. It cannot be undone, and without the passphrase there is no way to read it anyway.</p>
      <div>
        <label class="field-label" for="erase-word">Type ERASE to confirm</label>
        <input id="erase-word" class="input" autocomplete="off" autocapitalize="characters" spellcheck="false">
      </div>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="" autofocus>Cancel</button>
        <button type="submit" class="btn-danger">Erase everything</button>
      </div>
    </form>`);
  $('form', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('#erase-word', dlg).value.trim().toUpperCase() === 'ERASE') dlg.close('yes');
    else $('#erase-word', dlg).focus();
  });
  if (await done !== 'yes') return;
  store.eraseEverything();
  await openLedger();
  toast('This ledger has been erased');
}

function wireLock() {
  const root = lockEl();
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    if (lockKind === 'setup') submitSetup(); else submitUnlock();
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'lk-pass' && lockKind === 'setup') drawMeter();
    if (e.target.type === 'password') lockError('');
  });
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act } = btn.dataset;
    if (act === 'skip') {
      guard(() => store.updateSettings({ encryptionSkipped: true }));
      await openLedger();
      toast('Not encrypted. You can turn this on later in Settings.');
    } else if (act === 'restore') {
      // From the setup screen the ledger is already open, so the file can go straight in.
      // From the damaged screen there is nothing to import into until this device is cleared.
      if (lockKind === 'damaged') await restoreIntoNewLedger(); else $('#import-file').click();
    } else if (act === 'erase') {
      await eraseFlow();
    }
  });
  wirePeek(root);
}

async function restoreIntoNewLedger() {
  const go = await confirmDialog({
    title: 'Start again and restore a backup?',
    message: 'The damaged data in this browser is deleted first, then your backup is restored into a new ledger. Have your backup file and its passphrase ready.',
    confirmLabel: 'Erase and restore',
    danger: true,
  });
  if (!go) return;
  store.eraseEverything();
  hideLock();
  mountLedger();
  $('#import-file').click();
}

/* ---------- auto-lock ---------- */

let idleTimer = 0;
let hiddenSince = 0;

const autoLockMs = () => (store.getSettings().autoLockMinutes || 0) * 60_000;

function stopAutoLock() {
  clearTimeout(idleTimer);
  idleTimer = 0;
}

/** (Re)start the idle countdown. No timer runs unless the ledger is open and encrypted. */
function startAutoLock() {
  stopAutoLock();
  if (!store.isEncrypted() || store.isLocked()) return;
  const ms = autoLockMs();
  if (ms) idleTimer = setTimeout(() => lockNow('Locked after a few minutes without activity.'), ms);
}

async function lockNow(message = '') {
  if (!store.isEncrypted() || store.isLocked()) return;
  stopAutoLock();
  await store.lock();
  teardownLedger();
  showLock('unlock', message);
}

function wireAutoLock() {
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focusin']) {
    window.addEventListener(type, () => { if (idleTimer) startAutoLock(); }, { passive: true });
  }
  // A backgrounded tab's timers are throttled, so measure the elapsed time instead of trusting one.
  document.addEventListener('visibilitychange', () => {
    if (!store.isEncrypted() || store.isLocked()) return;
    if (document.hidden) { hiddenSince = Date.now(); stopAutoLock(); return; }
    const ms = autoLockMs();
    if (ms && hiddenSince && Date.now() - hiddenSince > ms) {
      lockNow('Locked while this tab was in the background.');
      return;
    }
    hiddenSince = 0;
    startAutoLock();
  });
}

/* ---------- putting the ledger UI up and taking it down ---------- */

/** Nothing decrypted may survive a lock: forms, lists and toasts all go. */
function teardownLedger() {
  entryForm = null;
  hideToast();
  releaseAiForLock();
  sync.stop(); // the worker holds the session, so locking takes it down too
  for (const id of ['#entry', '#view-month', '#view-insights', '#view-settings', '#banner']) $(id).replaceChildren();
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close('');
}

/** Build the ledger UI. No dialogs: the setup screen may still be sitting on top of it. */
function mountLedger() {
  if (!entryForm) entryForm = createTxForm($('#entry'), { prefix: 'add', mode: 'add', onSubmit: saveFromEntry });
  showTab(ui.tab, { focus: false });
  renderChrome();
  startAutoLock();
  sync.start(); // picks up anything queued from last time, once the ledger is open
}

/** Everything that may open a dialog, once the lock screen is out of the way. */
async function finishOpen() {
  if (!store.getSettings().currencyConfirmed) {
    const code = await pickCurrency({ current: store.getSettings().currency, first: true });
    guard(() => store.updateSettings({ currency: code, currencyConfirmed: true }));
  }
  // Unlocking returns to whichever tab was open, so the focus has to follow it there.
  if (ui.tab === 'add') entryForm?.focusAmount();
  else $(`#h-${ui.tab}`)?.focus({ preventScroll: true });
}

/** Leave the lock screen and hand the app back to the person. */
async function openLedger() {
  hideLock();
  mountLedger();
  await finishOpen();
}

/* ================================================================== */
/* Sync: an optional account, and the same ledger on another device    */
/* ================================================================== */

// Like the AI, sync is off until asked for, and constructing this starts nothing: no worker, no
// Supabase library, no request. A guest never touches it.
const sync = createSync({ store });

const SYNC_PITCH = 'Access your ledger on any device. Backups are encrypted before they leave this device.';

const STATUS = {
  syncing: { label: 'Syncing…', tone: 'text-slate-600 dark:text-slate-400' },
  idle: { label: 'Synced', tone: 'text-emerald-800 dark:text-emerald-300' },
  pending: { label: 'Waiting to sync', tone: 'text-slate-600 dark:text-slate-400' },
  offline: { label: 'Offline', tone: 'text-amber-800 dark:text-amber-300' },
  error: { label: 'Error', tone: 'text-rose-800 dark:text-rose-300' },
  'signed-out': { label: 'Not signed in', tone: 'muted' },
  unconfigured: { label: 'Not set up', tone: 'muted' },
};

/** Re-render whatever shows sync status, without disturbing anything else. */
function onSyncState() {
  if (store.isLocked()) return;
  if (ui.tab === 'settings') renderSettings();
  renderChrome();
}

const syncAvailable = () => sync.isConfigured();
const signedIn = () => !store.isLocked() && Boolean(store.getSyncState().userId);

/** Sync needs the Step 2 key: there is nothing to encrypt an item with otherwise. */
const syncNeedsPassphrase = () => !store.isEncrypted();

function syncBannerHtml() {
  if (!syncAvailable() || signedIn() || store.getSettings().syncBannerDismissed) return '';
  return html`
    <div class="mb-4 rounded-xl border border-teal-300 bg-teal-50 p-3 dark:border-teal-800 dark:bg-teal-950" role="status">
      <p class="text-sm font-medium text-teal-950 dark:text-teal-100">${SYNC_PITCH}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <button type="button" class="btn-primary !min-h-11 !py-1" data-act="sync-open" data-key="sync-open">Set up sync</button>
        <button type="button" class="btn-secondary !min-h-11 !py-1" data-act="sync-dismiss" data-key="sync-dismiss">Not now</button>
      </div>
    </div>`;
}

function syncCardHtml() {
  const s = sync.getState();
  const status = STATUS[s.phase] ?? STATUS.error;
  const state = store.getSyncState();

  if (!syncAvailable()) {
    return html`
      <section class="card space-y-2" aria-labelledby="s-sync">
        <h3 id="s-sync" class="card-title">Sync</h3>
        <p class="text-sm muted">This copy of the app has no Supabase project set up, so there is nothing to sync to. Everything stays on this device.</p>
        <p class="text-sm muted">To turn it on: create a project, run <code>supabase/schema.sql</code> in its SQL editor, and put the project URL and anon key in <code>js/sync-config.js</code>.</p>
      </section>`;
  }

  if (!signedIn()) {
    return html`
      <section class="card space-y-3" aria-labelledby="s-sync">
        <h3 id="s-sync" class="card-title">Sync <span class="text-sm font-normal muted">(optional)</span></h3>
        <p class="text-sm muted">${SYNC_PITCH} Your passphrase never leaves this device, so the server stores only sealed data it cannot read.</p>
        ${syncNeedsPassphrase() ? html`
          <p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            Sync needs a passphrase first: it is what encrypts each item before it goes up.
          </p>
          <button type="button" class="btn-primary" data-act="encrypt" data-key="sync-encrypt">${icon('shield', 20)}Set a passphrase</button>`
    : html`<button type="button" class="btn-primary" data-act="sync-open" data-key="sync-open">Sign in or create an account</button>`}
      </section>`;
  }

  return html`
    <section class="card space-y-3" aria-labelledby="s-sync">
      <h3 id="s-sync" class="card-title">Sync</h3>
      <p class="text-sm"><strong>${state.email}</strong></p>
      <p class="text-sm ${status.tone}" role="status" data-key="sync-status">
        ${status.label}${s.queued ? ` · ${plural(s.queued, 'change')} waiting` : ''}${s.phase === 'idle' && s.lastSyncAt ? ` · ${fmtStamp.format(new Date(s.lastSyncAt))}` : ''}
      </p>
      ${s.message ? html`<p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">${s.message}</p>` : ''}
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-secondary" data-act="sync-now" data-key="sync-now" ${s.phase === 'syncing' ? 'disabled' : ''}>Sync now</button>
        <button type="button" class="btn-secondary" data-act="sync-signout" data-key="sync-signout">Sign out</button>
        <button type="button" class="btn-danger" data-act="sync-delete" data-key="sync-delete">Delete cloud data</button>
      </div>
      <p class="text-xs muted">Signing out leaves everything on this device. The server only ever holds sealed items; it has never had your passphrase.</p>
    </section>`;
}

/* ---------- the flows ---------- */

/** Email + password, for signing in or creating an account. */
async function accountDialog() {
  let mode = 'in';
  const liveCount = store.getTransactions().filter((t) => !t.deleted).length;
  const { dlg, done } = mountDialog(html`
    <form class="space-y-4 p-5" novalidate>
      <h2 id="dlg-title" class="text-lg font-semibold">Sync across devices</h2>
      <div class="seg-wrap" role="radiogroup" aria-label="Account">
        ${[['in', 'I have an account'], ['up', 'Create an account']].map(([v, label]) => html`
          <label class="seg"><input type="radio" class="sr-only" name="acct-mode" value="${v}" ${v === mode ? 'checked' : ''}><span class="seg-face">${label}</span></label>`)}
      </div>
      <p class="rounded-xl border border-slate-300 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
        <strong>This password is not your passphrase.</strong> The password signs you in to the server. The passphrase
        encrypts your ledger and never leaves this device. The server cannot read your ledger with either of them alone,
        and nobody can reset the passphrase for you.
      </p>
      ${liveCount ? html`<p id="acct-upload" class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        The ${plural(liveCount, 'transaction')} already on this device will be uploaded to whichever account you sign in to.
        If this ledger is not yours, sign in to your own account rather than creating a new one here.
      </p>` : ''}
      <div>
        <label class="field-label" for="acct-email">Email</label>
        <input id="acct-email" type="email" class="input" autocomplete="email" autocapitalize="off" spellcheck="false" required>
      </div>
      ${passphraseField({ id: 'acct-pass', label: 'Account password', autocomplete: 'current-password' })}
      <p id="acct-error" role="alert" class="min-h-5 text-sm font-medium text-rose-700 dark:text-rose-300"></p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-secondary" data-close="">Cancel</button>
        <button type="submit" class="btn-primary" id="acct-go">Sign in</button>
      </div>
    </form>`);
  wirePeek(dlg);

  const go = $('#acct-go', dlg);
  dlg.addEventListener('change', (e) => {
    if (e.target.name !== 'acct-mode') return;
    mode = e.target.value;
    go.textContent = mode === 'in' ? 'Sign in' : 'Create account';
    $('#acct-pass', dlg).setAttribute('autocomplete', mode === 'in' ? 'current-password' : 'new-password');
  });

  let outcome = null;
  $('form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (m) => { $('#acct-error', dlg).textContent = m; };
    fail('');
    const email = $('#acct-email', dlg).value.trim();
    const password = $('#acct-pass', dlg).value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid email address.');
    if (password.length < 8) return fail('Use a password of at least 8 characters.');
    try {
      outcome = await busy(go, mode === 'in' ? 'Signing in…' : 'Creating…', () => (mode === 'in' ? sync.signIn(email, password) : sync.signUp(email, password)));
    } catch (err) {
      return fail(err.message);
    }
    dlg.close('done');
    return undefined;
  });

  await done;
  return outcome;
}

async function syncSetupFlow() {
  if (syncNeedsPassphrase()) { showLock('setup'); return; }
  const result = await guardAsync(() => accountDialog());
  if (!result) { onSyncState(); return; }

  if (result.needsConfirmation) {
    await alertDialog('Check your email', 'The account is created. Open the confirmation link we sent, then come back and sign in.');
    return;
  }
  if (result.needsPassphrase) {
    // This account's items were sealed with a different passphrase than this device uses. Until
    // that passphrase is given, the sign-in is not recorded and nothing syncs either way.
    let joined = null;
    while (!joined) {
      const passphrase = await askPassphrase({
        title: 'Enter this account\'s passphrase',
        message: 'This account\'s ledger was encrypted with a passphrase that does not match this device\'s. Enter the account\'s passphrase to join it. Everything already on this device will be re-encrypted with it and uploaded.',
        confirmLabel: 'Join and sync',
      });
      if (passphrase === null) { await guardAsync(() => sync.signOut()); onSyncState(); return; }
      joined = await guardAsync(() => sync.adoptKey(passphrase, result.keyInfo));
    }
  }
  toast('Sync is on. Your ledger is sealed before it leaves this device.');
  onSyncState();
}

async function syncSignOutFlow() {
  const go = await confirmDialog({
    title: 'Sign out of sync?',
    message: 'Everything stays on this device, and the copy on the server is left alone. You can sign back in whenever you like.',
    confirmLabel: 'Sign out',
  });
  if (!go) return;
  await guardAsync(() => sync.signOut());
  toast('Signed out. Your ledger is still here.');
  onSyncState();
}

async function syncDeleteFlow() {
  const go = await confirmDialog({
    title: 'Delete the copy on the server?',
    message: 'Every item this account has on the server is removed for good. Your ledger stays on this device, untouched. If you stay signed in, it will be uploaded again on the next sync.',
    confirmLabel: 'Delete cloud data',
    danger: true,
  });
  if (!go) return;
  if (await guardAsync(() => sync.deleteCloudData())) toast('The server copy has been deleted.');
  onSyncState();
}

/* ================================================================== */
/* Shell: theme, banner, tabs, privacy button                          */
/* ================================================================== */

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = store.getSettings().theme;
  document.documentElement.classList.toggle('dark', pref === 'dark' || (pref === 'system' && darkQuery.matches));
}

function renderChrome() {
  applyTheme();
  const on = privacyOn();
  const btn = $('#privacy-btn');
  btn.setAttribute('aria-pressed', String(on));
  $('[data-icon]', btn).innerHTML = icon(on ? 'eyeOff' : 'eye').s;

  const notes = [];
  if (!bootInfo.persistent) notes.push('Your browser is blocking storage, so nothing you enter will be saved. Export a backup before closing this tab.');
  if (bootInfo.recovered && !store.isEncrypted()) notes.push(`The saved data couldn't be read (${bootInfo.recovered}). It was set aside in this browser under "self.data.corrupt" and the app started fresh.`);
  // Encrypted saves happen after the change is on screen, so a failure has to be reported here.
  if (store.getWriteError()) notes.push(`${store.getWriteError()} Your last change is on screen but not saved.`);
  put($('#banner'), html`
    ${notes.map((n) => html`<p class="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status">${n}</p>`)}
    ${syncBannerHtml()}`);
}

/**
 * Keep the setup screen's count honest when the ledger changes underneath it — restoring a
 * backup from that screen is the case that matters. Only this line is touched, so a
 * half-typed passphrase survives.
 */
function refreshSetupCount() {
  const el = $('#lk-existing');
  if (!el) return;
  const count = store.getTransactions().filter((t) => !t.deleted).length;
  el.hidden = count === 0;
  put(el, html`<strong>${plural(count, 'transaction')} already on this device will be encrypted.</strong>`);
}

function renderAll() {
  if (store.isLocked()) return; // nothing to draw, and nothing decrypted to draw it from
  if (lockKind === 'setup') refreshSetupCount();
  renderChrome();
  startAutoLock(); // any change counts as activity, and may have changed the timeout itself
  sync.schedule(); // debounced, and a no-op when there is nothing queued
  entryForm?.refresh();
  // Views that are not on screen are emptied rather than left stale: showTab() redraws them on demand,
  // and it keeps amounts from lingering in hidden DOM after Privacy Mode is switched on.
  if (ui.tab === 'month') renderMonth(); else $('#view-month').replaceChildren();
  if (ui.tab === 'insights') renderInsights(); else $('#view-insights').replaceChildren();
  if (ui.tab === 'settings') renderSettings(); else $('#view-settings').replaceChildren();
}

function showTab(tab, { focus = true } = {}) {
  ui.tab = tab;
  for (const name of ['add', 'month', 'insights', 'settings']) $(`#view-${name}`).hidden = name !== tab;
  for (const btn of document.querySelectorAll('[data-tab]')) {
    if (btn.dataset.tab === tab) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  }
  if (tab === 'month') renderMonth();
  if (tab === 'insights') { renderInsights(); refreshAiCached(); }
  if (tab === 'settings') renderSettings();
  $('#toast').style.bottom = `calc(${tab === 'add' ? '9.25rem' : '5rem'} + env(safe-area-inset-bottom))`;
  if (focus) {
    if (tab === 'add') entryForm.focusAmount();
    else $(`#h-${tab}`)?.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
}

function wireShell() {
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon).s;
  $('#banner').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'sync-open') await syncSetupFlow();
    else if (act === 'sync-dismiss') guard(() => store.updateSettings({ syncBannerDismissed: true }));
  });
  sync.subscribe(onSyncState);
  for (const btn of document.querySelectorAll('[data-tab]')) btn.addEventListener('click', () => showTab(btn.dataset.tab));
  $('#privacy-btn').addEventListener('click', () => guard(() => store.updateSettings({ privacyMode: !privacyOn() })));
  darkQuery.addEventListener('change', applyTheme);
}

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

function saveFromEntry(payload) {
  const tx = store.addTransaction(payload);
  const label = schema.labelFor(store.getCategories(), tx.categoryId, tx.subCategoryId);
  toast(`${tx.type === 'income' ? 'Income' : 'Expense'} saved · ${label.main}${label.sub ? ` › ${label.sub}` : ''}`, {
    action: 'Undo',
    onAction: () => { guard(() => store.deleteTransaction(tx.id)); entryForm.focusAmount(); },
  });
}

/** Offer encryption on a device that has never been asked and could actually use it. */
const shouldOfferEncryption = () => !store.isEncrypted()
  && store.isCryptoAvailable()
  && store.isPersistent()
  && !store.getSettings().encryptionSkipped;

async function start() {
  bootInfo = store.init();
  wireShell();
  wireMonth();
  wireInsights();
  wireSettings();
  wireImport();
  wireLock();
  wireAutoLock();
  store.subscribe(renderAll);

  // An encrypted device always comes up locked: a refresh is not a way past the passphrase.
  if (store.isLocked()) {
    showLock(store.isVaultDamaged() ? 'damaged' : 'unlock');
    return;
  }
  mountLedger();
  // First run: offer encryption before anything else, then pick the currency.
  if (shouldOfferEncryption()) {
    showLock('setup');
    return;
  }
  await finishOpen();
}

start();
