// insights.js — the numbers, the prompt, the number guard, and the bridge to the AI worker.
//
// THE DIVISION OF LABOUR (this is the design; everything below serves it):
//
//   1. Plain JavaScript computes every figure.          computeInsights()
//   2. Those figures become a short list of facts.      factLines()
//   3. A small model may rewrite the facts as prose.    buildMessages() → ai-worker.js
//   4. Every number in that prose is checked against    verifyNumbers()
//      the facts. If one is not there, the text is
//      thrown away and never shown.
//
// Step 4 exists because a 360M-parameter model WILL sometimes invent, round or "helpfully"
// recompute a figure, however firmly it is told not to. The prompt asks; the guard enforces.
//
// Money is integers in the currency's smallest unit, here as everywhere. Percentages and ratios
// are worked out with integer (BigInt) maths and round half up — no float ever touches a total.
// This module has no DOM and no storage. It only reads the arrays it is handed.

import { formatMoney, currencyInfo } from './money.js';
import { bucketOf, findMain, summarize } from './schema.js';

/* ================================================================== */
/* The model — one constant, so swapping it is one edit                */
/* ================================================================== */

/**
 * The on-device model. To use a smaller one on a weak device, change ONLY this object, e.g.:
 *   id: 'HuggingFaceTB/SmolLM2-135M-Instruct', dtype: 'q4', downloadBytes: 185_000_000,
 *   and a new `revision` (the commit sha of that repo).
 *
 * `revision` pins the exact files, so what is downloaded can't change underneath us.
 * `dtype` is one quantisation for every device (WebGPU and CPU alike): the same single download
 * works whichever one ends up running it, and a WebGPU failure falls back to CPU without a
 * second download. (q4f16 is ~115 MB smaller but needs WebGPU + shader-f16, so it can't fall back.)
 * `downloadBytes` is what the size prompt shows BEFORE anything is fetched; keep it honest.
 */
export const AI_MODEL = {
  id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
  revision: 'a10cc1512eabd3dde888204e902eca88bddb4951',
  dtype: 'q4',
  name: 'SmolLM2 360M',
  license: 'Apache-2.0',
  downloadBytes: 390_000_000,   // model + tokenizer, from huggingface.co
  runtimeBytes: 22_528_676,     // the vendored Transformers.js + WebAssembly runtime, from this app
};

/** Decimal megabytes, the way Hugging Face and download managers count. */
export const formatBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/* ================================================================== */
/* Integer maths                                                       */
/* ================================================================== */

/** Round-half-up n / d for non-negative n and positive d, without floats. */
const divRound = (n, d) => Number((2n * BigInt(n) + BigInt(d)) / (2n * BigInt(d)));

/** Whole percent of n in d, rounded half up. null when d is 0. */
const pct = (n, d) => (d > 0 ? divRound(BigInt(n) * 100n, d) : null);

/* ================================================================== */
/* Months                                                              */
/* ================================================================== */

const pad = (n) => String(n).padStart(2, '0');

export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const monthOf = (dateStr) => dateStr.slice(0, 7);
const userLocale = () => globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'en';

/* ================================================================== */
/* The facts                                                           */
/* ================================================================== */

// Built-in category ids (stable across devices; see schema.js). Forex is an expense, Trading
// Income is income, and the spec wants them set side by side.
export const FOREX_SUB_ID = 'exp.housing-tech.forex';
export const TRADING_SUB_ID = 'inc.investment.trading-income';

/** A transaction must be more than this many times its category's usual amount to count as unusual. */
export const UNUSUAL_FACTOR = 2;
/** …and there must be at least this many OTHER transactions to establish what "usual" is. */
export const MIN_BASELINE = 3;

const TOP_SUBS = 3;
const TOP_UNUSUAL = 3;

/**
 * Everything the app can say about one month, as integers. No formatting, no wording.
 *
 * "Spending" excludes Savings & Investments, exactly as the Month screen does; savings is its
 * own figure. Only live (non-deleted) transactions count.
 *
 * "Unusual": a spending transaction in this month that is MORE than twice the average of the
 * OTHER transactions in the same sub-category (across all months, itself left out so a single
 * huge one can't inflate its own baseline), when there are at least MIN_BASELINE others.
 */
export function computeInsights({ transactions, categories, month }) {
  const live = transactions.filter((t) => !t.deleted);
  const cur = live.filter((t) => monthOf(t.date) === month);
  const prevMonth = shiftMonth(month, -1);
  const prevTx = live.filter((t) => monthOf(t.date) === prevMonth);

  const totals = summarize(cur, categories);
  const prev = prevTx.length ? summarize(prevTx, categories) : null;

  const nameOf = (id) => findMain(categories, id)?.name ?? 'Unknown category';
  const subNameOf = (t) => (t.subCategoryId ? findMain(categories, t.categoryId)?.subs.find((s) => s.id === t.subCategoryId)?.name ?? null : null);

  // Spending by main category.
  const mains = new Map();
  // Spending by sub-category (or by the main when no sub was chosen).
  const subs = new Map();
  for (const t of cur) {
    if (bucketOf(categories, t) !== 'spending') continue;
    mains.set(t.categoryId, (mains.get(t.categoryId) ?? 0) + t.amount);
    const key = `${t.categoryId}|${t.subCategoryId ?? ''}`;
    const entry = subs.get(key) ?? { mainName: nameOf(t.categoryId), subName: subNameOf(t), amount: 0 };
    entry.amount += t.amount;
    subs.set(key, entry);
  }
  const byMain = [...mains].map(([id, amount]) => ({ id, name: nameOf(id), amount, pct: pct(amount, totals.spending) }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const topSubs = [...subs.values()].sort((a, b) => b.amount - a.amount || a.mainName.localeCompare(b.mainName)).slice(0, TOP_SUBS);

  const change = (now, before) => {
    if (!prev || before <= 0) return null;
    const delta = now - before;
    return { delta, pct: pct(Math.abs(delta), before) };
  };

  const sumFor = (list, subId) => list.filter((t) => t.subCategoryId === subId).reduce((n, t) => n + t.amount, 0);
  const forex = sumFor(cur.filter((t) => t.type === 'expense'), FOREX_SUB_ID);
  const trading = sumFor(cur.filter((t) => t.type === 'income'), TRADING_SUB_ID);

  return {
    month,
    prevMonth,
    empty: cur.length === 0,
    totals,
    prev,
    spendingChange: change(totals.spending, prev?.spending ?? 0),
    incomeChange: change(totals.income, prev?.income ?? 0),
    savingsRate: totals.income > 0 ? { pct: pct(totals.savings, totals.income) } : null,
    byMain,
    topSubs,
    unusual: findUnusual(cur, live, categories, nameOf, subNameOf),
    forexTrading: forex > 0 || trading > 0 ? { forex, trading, diff: trading - forex } : null,
  };
}

function findUnusual(cur, live, categories, nameOf, subNameOf) {
  const keyOf = (t) => `${t.categoryId}|${t.subCategoryId ?? ''}`;
  const all = new Map(); // key -> { sum, count } over EVERY live spending transaction
  for (const t of live) {
    if (bucketOf(categories, t) !== 'spending') continue;
    const g = all.get(keyOf(t)) ?? { sum: 0n, count: 0 };
    g.sum += BigInt(t.amount);
    g.count += 1;
    all.set(keyOf(t), g);
  }

  const found = [];
  for (const t of cur) {
    if (bucketOf(categories, t) !== 'spending') continue;
    const g = all.get(keyOf(t));
    const others = g.count - 1;
    if (others < MIN_BASELINE) continue;
    const othersSum = g.sum - BigInt(t.amount);
    // amount > UNUSUAL_FACTOR × (othersSum / others), cross-multiplied so nothing is divided.
    if (BigInt(t.amount) * BigInt(others) <= BigInt(UNUSUAL_FACTOR) * othersSum) continue;
    found.push({
      id: t.id,
      date: t.date,
      name: subNameOf(t) ?? nameOf(t.categoryId),
      amount: t.amount,
      average: divRound(othersSum, others),
      timesTenths: divRound(BigInt(t.amount) * 10n * BigInt(others), othersSum),
    });
  }
  return found.sort((a, b) => b.amount - a.amount).slice(0, TOP_UNUSUAL);
}

/* ================================================================== */
/* Facts as text                                                       */
/* ================================================================== */

/** Formatting for fact lines. Privacy Mode passes `masked: true`: amounts become ••••, nothing else changes. */
export function makeFormatter(currency, { masked = false } = {}) {
  const locale = userLocale();
  const fmtDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const fmtMonth = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  const at = (s) => { const [y, m, d = 1] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  return {
    money: (minor) => (masked ? '••••' : formatMoney(minor, currency)),
    date: (dateStr) => fmtDate.format(at(dateStr)),
    month: (key) => fmtMonth.format(at(key)),
  };
}

const tenths = (t) => `${Math.floor(t / 10)}.${t % 10}`;

/**
 * The facts as an ordered list of { id, text, group }. This exact list is what the model is given
 * AND what the person sees beside its answer, so the two can never drift apart.
 *
 * `group` is what binds a sentence to its sources. The model writes ONE sentence per group and the
 * guard checks each sentence against only that group's figures — so it can't borrow the savings
 * rate's neighbour (the income change) and call it the savings rate. Groups are lettered A, B, C…
 * in order of appearance; '*' marks context every sentence may draw on (the month).
 *
 * The wording avoids numbering ("1.", "2.") on purpose: every digit here becomes a figure the
 * model is allowed to repeat, so there are no digits that do not mean something.
 */
export function factLines(facts, fmt) {
  const lines = [];
  const add = (id, text, kind) => lines.push({ id, text, kind });
  const { totals } = facts;
  const monthName = fmt.month(`${facts.month}-01`);
  const prevName = fmt.month(`${facts.prevMonth}-01`);

  add('period', `Month: ${monthName}`, 'context');
  if (facts.empty) {
    add('empty', `No transactions were recorded in ${monthName}.`, 'context');
    return withGroups(lines);
  }

  add('income', `Income: ${fmt.money(totals.income)}`, 'headline');
  add('spending', `Spending, not counting savings: ${fmt.money(totals.spending)}`, 'headline');
  add('savings', `Saved or invested: ${fmt.money(totals.savings)}`, 'headline');
  add('net', `Net balance, meaning income minus spending and savings: ${fmt.money(totals.net)}`, 'headline');

  if (facts.savingsRate) {
    add('savings-rate', `Savings rate: ${facts.savingsRate.pct}% of income went to savings and investments`, 'change');
  }

  const compare = (label, c, id) => {
    if (!c) return;
    const how = c.delta === 0 ? 'unchanged'
      : `${c.delta > 0 ? 'up' : 'down'} ${c.pct}% (${fmt.money(Math.abs(c.delta))} ${c.delta > 0 ? 'more' : 'less'})`;
    add(id, `${label} compared with ${prevName}: ${how}`, 'change');
  };
  if (facts.spendingChange) compare('Spending', facts.spendingChange, 'spending-change');
  else add('spending-change', `No spending was recorded in ${prevName}, so there is nothing to compare with.`, 'change');
  compare('Income', facts.incomeChange, 'income-change');

  if (facts.byMain.length) {
    const shown = facts.byMain.slice(0, 4);
    const rest = facts.byMain.slice(4);
    const parts = shown.map((c) => `${c.name} ${fmt.money(c.amount)} (${c.pct}%)`);
    if (rest.length) {
      const amount = rest.reduce((n, c) => n + c.amount, 0);
      parts.push(`all other categories ${fmt.money(amount)} (${pct(amount, totals.spending)}%)`);
    }
    add('by-category', `Spending by category: ${parts.join(', ')}`, 'categories');
  }

  if (facts.topSubs.length) {
    const label = (s) => (s.subName ? `${s.subName} (${s.mainName})` : `${s.mainName} (no sub-category)`);
    const order = ['Largest', 'next', 'then'];
    add('top-subs', `Top spending sub-categories: ${facts.topSubs.map((s, i) => `${order[i]}: ${label(s)} ${fmt.money(s.amount)}`).join('; ')}`, 'categories');
  }

  facts.unusual.forEach((u, i) => {
    add(`unusual-${i}`, `Unusual: ${u.name} on ${fmt.date(u.date)} was ${fmt.money(u.amount)}, about ${tenths(u.timesTenths)} times its usual ${fmt.money(u.average)}`, 'unusual');
  });

  if (facts.forexTrading) {
    const f = facts.forexTrading;
    add('forex-trading', `Forex spending: ${fmt.money(f.forex)}. Trading Income: ${fmt.money(f.trading)}. Trading Income minus Forex spending: ${fmt.money(f.diff)}`, 'forex');
  }
  return withGroups(lines);
}

/** Letter the groups A, B, C… in order of appearance; context lines get '*'. */
function withGroups(lines) {
  const order = [];
  for (const l of lines) if (l.kind !== 'context' && !order.includes(l.kind)) order.push(l.kind);
  return lines.map(({ kind, ...l }) => ({ ...l, group: kind === 'context' ? '*' : String.fromCharCode(65 + order.indexOf(kind)) }));
}

/** [{ letter, lines }] for every lettered group, in order. */
export function groupsOf(lines) {
  const groups = [];
  for (const l of lines) {
    if (l.group === '*') continue;
    let g = groups.find((x) => x.letter === l.group);
    if (!g) { g = { letter: l.group, lines: [] }; groups.push(g); }
    g.lines.push(l);
  }
  return groups;
}

/** Same facts, same wording → same signature. Used to notice that a saved summary has gone stale. */
export const factsSignature = (lines) => lines.map((l) => l.text).join('\n');

/* ================================================================== */
/* The prompt                                                          */
/* ================================================================== */

/** The instruction the spec requires, word for word. */
export const INSTRUCTION = 'Use only these numbers. Do not calculate or invent any figures.';

const SYSTEM = [
  'You write short, friendly summaries of personal-finance facts.',
  'The facts come in labelled groups: [A], [B], and so on.',
  'Write exactly one short sentence for each group, in order, and start each sentence with its group letter in square brackets, for example [A].',
  INSTRUCTION,
  'Copy every number exactly as it is written in the facts, using digits.',
  'Be kind and neutral: no advice, no judgement, no scolding.',
].join(' ');

/**
 * A worked example, because SmolLM2-360M given only instructions re-prints the list instead of
 * writing prose (measured, not assumed). It is deliberately about things that are NOT in this
 * app — "Pets", "Books", June 2024 — so anything that leaks from it into an answer is obvious
 * and is refused (EXAMPLE_TERMS below), and its figures are made-up round numbers.
 */
export const EXAMPLE_TERMS = ['Pets', 'Books', 'June 2024'];

function exampleTurn(currency) {
  const { decimals } = currencyInfo(currency);
  const m = (major) => formatMoney(major * 10 ** decimals, currency);
  const facts = [
    '- Month: June 2024',
    '[A]', `- Income: ${m(1_111_000)}`, `- Spending, not counting savings: ${m(555_000)}`,
    '[B]', '- Savings rate: 22% of income went to savings and investments',
    '[C]', `- Spending by category: Pets ${m(300_000)} (54%), Books ${m(255_000)} (46%)`,
  ].join('\n');
  const answer = [
    `[A] In June 2024 you earned ${m(1_111_000)} and spent ${m(555_000)}, not counting savings.`,
    '[B] Around 22% of your income went to savings and investments.',
    `[C] Pets took the biggest share of your spending at ${m(300_000)}, or 54%.`,
  ].join('\n');
  return { facts, answer };
}

/** The facts as the model reads them: context first, then each lettered group. */
function renderFacts(lines) {
  const out = lines.filter((l) => l.group === '*').map((l) => `- ${l.text}`);
  for (const g of groupsOf(lines)) out.push(`[${g.letter}]`, ...g.lines.map((l) => `- ${l.text}`));
  return out.join('\n');
}

/** Roughly how many tokens the answer needs: a short sentence per group, plus its tag. */
export const tokenBudget = (groupCount) => 36 * groupCount + 12;

/**
 * Chat messages for the model: instructions, one worked example, then the real facts as a list
 * followed by the required instruction. `offenders` is set on a retry.
 */
export function buildMessages(lines, { currency = 'UGX', offenders = [] } = {}) {
  const example = exampleTurn(currency);
  const retry = offenders.length
    ? `\nYour last answer had problems: ${offenders.join('; ')}. Write it again using only the facts.`
    : '';
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `FACTS:\n${example.facts}\n\n${INSTRUCTION}` },
    { role: 'assistant', content: example.answer },
    { role: 'user', content: `FACTS:\n${renderFacts(lines)}\n\n${INSTRUCTION}${retry}` },
  ];
}

/* ================================================================== */
/* The number guard                                                    */
/* ================================================================== */

const NUMBER = /\d(?:[\d,.  ]*\d)?/g;

/**
 * A number's value as a canonical string, independent of how it was punctuated:
 * "1,250,000" / "1.250.000" / "1 250 000" → "1250000";  "3.5" → "3.5";  "1,250.50" → "1250.5".
 * A single separator followed by exactly three digits is grouping; otherwise it is a decimal point.
 */
export function canonicalNumber(raw) {
  const s = raw.replace(/[  ]/g, '');
  const at = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let whole = s;
  let frac = '';
  if (at !== -1) {
    const sep = s[at];
    const other = sep === '.' ? ',' : '.';
    const after = s.slice(at + 1);
    const isDecimal = s.includes(other) || (s.split(sep).length === 2 && after.length !== 3);
    if (isDecimal) { whole = s.slice(0, at); frac = after; }
  }
  whole = whole.replace(/[.,]/g, '').replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** [{ raw, value, kind }] for every number in the text. kind: 'money' | 'percent' | 'plain'. */
export function numbersIn(text, currency) {
  const { symbol, code } = currencyInfo(currency);
  const marks = [...new Set([symbol, code].filter(Boolean))].map(escapeRegExp);
  const before = marks.length ? new RegExp(`(?:${marks.join('|')})\\s?[-−+]?\\s?$`, 'i') : null;
  const after = marks.length ? new RegExp(`^\\s?(?:${marks.join('|')})(?![A-Za-z])`, 'i') : null;

  const found = [];
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index;
    const end = start + m[0].length;
    const tail = text.slice(end, end + 12);
    const head = text.slice(Math.max(0, start - 12), start);
    let kind = 'plain';
    if (/^\s?(?:%|percent\b|per cent\b)/i.test(tail)) kind = 'percent';
    else if ((before && before.test(head)) || (after && after.test(tail))) kind = 'money';
    found.push({ raw: m[0], value: canonicalNumber(m[0]), kind });
  }
  return found;
}

// Words that carry a figure of their own. A model that writes "three" or "half" has produced a
// number the digit check would never see, so these are refused outright. Ordinals ("first") and
// "one" are left alone: they are ordinary English and not claims about the data.
const NUMBER_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|halves|quarter|quarters|double|doubled|triple|tripled|twice|thrice|dozen)\b|[½¼¾⅓⅔]/gi;
const SHORTHAND = /\d\s?[kKmMbB]\b/g; // "90k", "1.2M"

/**
 * Check every figure in `text` against the facts it was written from.
 *   • a number next to the currency must equal a money figure in the facts
 *   • a number followed by % (or "percent") must equal a percentage in the facts
 *   • any other number must equal some figure in the facts
 *   • spelled-out figures ("three", "half") and shorthand ("90k") are refused
 * → { ok, offenders: [strings to show/report] }
 */
export function verifyNumbers(text, lines, currency) {
  const allowed = { money: new Set(), percent: new Set(), plain: new Set() };
  for (const n of numbersIn(lines.map((l) => l.text).join('\n'), currency)) allowed[n.kind].add(n.value);
  const anywhere = new Set([...allowed.money, ...allowed.percent, ...allowed.plain]);

  const offenders = [];
  for (const n of numbersIn(text, currency)) {
    const ok = n.kind === 'plain' ? anywhere.has(n.value) : allowed[n.kind].has(n.value);
    if (!ok) offenders.push(n.raw);
  }
  for (const m of text.matchAll(NUMBER_WORDS)) offenders.push(m[0]);
  for (const m of text.matchAll(SHORTHAND)) offenders.push(m[0]);
  return { ok: offenders.length === 0, offenders: [...new Set(offenders)] };
}

/* ================================================================== */
/* The label guard                                                     */
/* ================================================================== */

// verifyNumbers() proves a figure EXISTS in the facts. It cannot tell that "Food at USh 47,000"
// has borrowed the figure that belongs to Housing & Technology. This closes that gap, best effort:
// wherever a known category name sits directly in front of a figure, that figure must be one the
// facts actually pair with that name. Wording it can't pin to a name is left alone rather than
// guessed at, because a false alarm costs the person a summary and a missed one costs nothing new
// (the facts are always shown beside the text).

/**
 * label (lower-case) → the figures the facts pair with it: Map<string, Set<canonical number>>.
 * A main category is also credited with its sub-categories' figures, because the facts print
 * them as "Groceries (Food) USh 90,000" and a model will copy that shape.
 */
export function labelFigures(facts, fmt, currency) {
  const map = new Map();
  map.names = new Map(); // lower-case key → the name as written, for messages
  const val = (minor) => numbersIn(fmt.money(minor), currency)[0]?.value;
  const put = (label, ...figures) => {
    const key = label.toLowerCase();
    map.names.set(key, label);
    const set = map.get(key) ?? new Set();
    for (const f of figures) if (f !== undefined) set.add(f);
    map.set(key, set);
  };
  for (const c of facts.byMain) put(c.name, val(c.amount), String(c.pct));
  for (const s of facts.topSubs) { put(s.subName ?? s.mainName, val(s.amount)); if (s.subName) put(s.mainName, val(s.amount)); }
  for (const u of facts.unusual) put(u.name, val(u.amount), val(u.average));
  if (facts.forexTrading) {
    const f = facts.forexTrading;
    put('Forex', val(f.forex), val(f.diff));
    put('Trading Income', val(f.trading), val(f.diff));
  }
  return map;
}

// A claim is a stretch of a sentence split on conjunctions and semicolons: "Food was 63%, and
// spending rose 74%" is two claims, and the 74% is not pinned on Food. Commas do NOT split a claim
// ("Groceries was the largest, accounting for 100%"): what follows a comma usually describes the
// name before it. (Commas inside "1,250,000" are never breaks anyway.)
const CLAIM_BREAK = /;|\b(?:and|but|while|whereas|although|though)\b/i;
const SOFT_BREAK = /,(?!\d)|(?<!\d),/;
// A segment that is only a connective and a figure ("or 63%") continues the previous segment.
const CONTINUES = /^[\s,;:()-]*(?:(?:or|which is|that is|about|around|roughly|so)(?:\s+|$))?[\s,;:()-]*$/i;

/**
 * → offender strings for each figure that a known name doesn't own.
 *
 * Within one claim, if exactly ONE known name appears, every figure in it belongs to that name,
 * however many words lie between ("Groceries took the biggest share of your spending at USh 90,000,
 * or 63%"). If the claim names two things, it is split at its commas and each piece is checked on
 * its own terms — a piece naming one thing owns its figures, and a bare "or 63%" continues the piece
 * before it. Anything still ambiguous ("Trading Income was USh 35,000 against USh 20,000 of Forex")
 * is left alone, because attributing it would be a guess.
 */
export function checkLabels(text, labels, currency) {
  if (!labels?.size) return [];
  const { symbol, code } = currencyInfo(currency);
  const marks = [...new Set([symbol, code].filter(Boolean))].map(escapeRegExp);
  const tidy = marks.length ? new RegExp(`\\s*(?:${marks.join('|')})\\s*[-−+]?\\s*$`, 'i') : /$^/;
  const names = [...labels.keys()];
  const namesIn = (chunk) => names.filter((name) => new RegExp(`(?<![A-Za-z])${escapeRegExp(name)}(?![A-Za-z])`, 'i').test(chunk));
  const figuresIn = (chunk) => numbersIn(chunk, currency).filter((n) => n.kind !== 'plain');
  const offenders = [];
  const hold = (entity, figures) => {
    for (const n of figures) {
      if (labels.get(entity).has(n.value)) continue;
      offenders.push(`${n.kind === 'percent' ? `${n.raw}%` : n.raw} doesn't belong to ${labels.names?.get(entity) ?? entity}`);
    }
  };

  for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/)) {
    for (const claim of sentence.split(CLAIM_BREAK)) {
      const figures = figuresIn(claim);
      if (!figures.length) continue;
      const mentioned = namesIn(claim);
      if (mentioned.length === 1) { hold(mentioned[0], figures); continue; }
      if (mentioned.length === 0) continue;

      let carried = null;
      for (const piece of claim.split(SOFT_BREAK)) {
        const here = figuresIn(piece);
        const named = namesIn(piece);
        let entity = null;
        if (named.length === 1) [entity] = named;
        else if (named.length === 0 && carried && here.length && CONTINUES.test(piece.slice(0, piece.indexOf(here[0].raw)).replace(tidy, ''))) entity = carried;
        if (entity && here.length) hold(entity, here);
        if (named.length || here.length) carried = entity;
      }
    }
  }
  return offenders;
}

/**
 * A "sentence" that is really a list entry ("Forex spending: USh 20,000") is the model re-printing
 * the facts rather than writing about them. The figures in it are right, but it isn't a summary.
 */
export function isListEcho(text, currency) {
  const { symbol, code } = currencyInfo(currency);
  const marks = [...new Set([symbol, code].filter(Boolean))].map(escapeRegExp).join('|');
  return new RegExp(`[A-Za-z)]:\\s*(?:${marks ? `(?:${marks})\\s*` : ''})?[-−]?\\d`, 'i').test(text);
}

/* ================================================================== */
/* Writing the summary                                                 */
/* ================================================================== */

/** Tidy one sentence group from a small model: no bullets or markdown, at most `max` sentences. */
export function cleanSummary(raw, max = 5) {
  const text = String(raw ?? '')
    .replace(/^[\s>*•-]+/gm, '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/).filter(Boolean).slice(0, max).join(' ');
}

/** "[A] one. [B] two." → Map { A → 'one.', B → 'two.' }. Anything before the first tag is ignored. */
export function parseGroups(text) {
  const parts = String(text ?? '').split(/\[([A-Z])\]/);
  const found = new Map();
  for (let i = 1; i < parts.length; i += 2) if (!found.has(parts[i])) found.set(parts[i], parts[i + 1].trim());
  return found;
}

/**
 * Ask the model for one sentence per group of facts, then hold each sentence to ITS OWN group.
 *
 * A sentence is kept only if every figure in it is one its group's facts contain (with the month
 * as shared context), no known name is attached to another name's figure, and nothing has leaked
 * from the worked example. Sentences that fail are dropped individually: one bad sentence does
 * not cost the person the rest, and nothing unchecked is ever returned.
 *
 * → { ok: true, text, sentences: [{group, text}], dropped: [{group, offenders}], attempts }
 *   { ok: false, reason: 'nothing' | 'empty' | 'figures', offenders, attempts }
 */
export async function writeSummary({ lines, labels = null, bridge, currency, maxAttempts = 1 }) {
  const groups = groupsOf(lines);
  if (!groups.length) return { ok: false, reason: 'nothing', offenders: [], attempts: 0 };
  const context = lines.filter((l) => l.group === '*');
  const factsText = lines.map((l) => l.text).join('\n');
  const inFacts = (term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(factsText);

  let last = { reason: 'empty', offenders: [] };
  let feedback = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await bridge.write(buildMessages(lines, { currency, offenders: feedback }), { maxNewTokens: tokenBudget(groups.length) });
    const parsed = parseGroups(raw);
    const sentences = [];
    const dropped = [];
    for (const g of groups) {
      const text = cleanSummary(parsed.get(g.letter), 2);
      if (!text) { dropped.push({ group: g.letter, offenders: [] }); continue; }
      const figures = verifyNumbers(text, [...context, ...g.lines], currency).offenders;
      if (isListEcho(text, currency)) { dropped.push({ group: g.letter, offenders: ['repeats the list instead of writing a sentence'] }); continue; }
      const found = [
        ...figures,
        // A figure already refused as "not in the facts" needn't be refused again for its label.
        ...checkLabels(text, labels, currency).filter((o) => !figures.some((f) => o.startsWith(f))),
        ...EXAMPLE_TERMS.filter((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i').test(text) && !inFacts(t)),
      ];
      if (found.length) dropped.push({ group: g.letter, offenders: [...new Set(found)] });
      else sentences.push({ group: g.letter, text });
    }
    if (sentences.length) return { ok: true, text: sentences.map((x) => x.text).join(' '), sentences, dropped, attempts: attempt };
    const offenders = [...new Set(dropped.flatMap((d) => d.offenders))];
    last = { reason: offenders.length ? 'figures' : 'empty', offenders };
    feedback = offenders;
  }
  return { ok: false, ...last, attempts: maxAttempts };
}

/* ================================================================== */
/* The bridge to ai-worker.js                                          */
/* ================================================================== */

/** A failure with a code the UI can act on: 'not-cached' | 'cancelled' | 'stopped' | 'failed'. */
export class AiError extends Error {
  constructor(message, code = 'failed') { super(message); this.code = code; }
}

const CACHE_NAME = 'transformers-cache'; // Transformers.js keeps downloaded model files here

/**
 * Everything the UI needs to drive the model, with the worker kept out of sight.
 *
 *   phase: 'idle' → 'downloading' | 'loading' → 'ready' ⇄ 'writing'      (or 'idle' again)
 *
 * The worker is created lazily, on the first load() — a person who never enables AI never
 * starts one, never fetches a runtime file, and never touches the network.
 */
export function createAiBridge({
  model = AI_MODEL,
  createWorker = () => new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' }),
  cacheStorage = globalThis.caches,
} = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let state = { phase: 'idle', loaded: 0, total: model.downloadBytes, device: null, tokens: 0 };

  const set = (patch) => { state = { ...state, ...patch }; for (const fn of listeners) fn(state); };

  function settle(id, how, value) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p[how](value);
  }

  function rejectAll(error) {
    for (const [id] of pending) settle(id, 'reject', error);
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'progress': set({ loaded: msg.loaded, total: Math.max(msg.total, model.downloadBytes) }); break;
      case 'phase': set({ phase: msg.phase }); break;
      case 'tokens': set({ tokens: msg.n }); break;
      case 'loaded': set({ phase: 'ready', device: msg.device }); settle(msg.id, 'resolve', { device: msg.device }); break;
      case 'result': set({ phase: 'ready', tokens: 0 }); settle(msg.id, 'resolve', msg.text); break;
      case 'interrupted': set({ phase: 'ready', tokens: 0 }); settle(msg.id, 'reject', new AiError('Stopped.', 'cancelled')); break;
      case 'error': {
        set({ phase: state.device ? 'ready' : 'idle', tokens: 0 });
        settle(msg.id, 'reject', new AiError(msg.message, msg.code ?? 'failed'));
        break;
      }
      default: break;
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = (e) => onMessage(e.data);
    worker.onerror = () => fail(new AiError('The AI worker stopped unexpectedly. Try again.', 'failed'));
    worker.onmessageerror = worker.onerror;
    return worker;
  }

  function fail(error) {
    worker?.terminate();
    worker = null;
    set({ phase: 'idle', device: null, tokens: 0 });
    rejectAll(error);
  }

  function request(type, payload) {
    const id = nextId;
    nextId += 1;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ensureWorker().postMessage({ type, id, ...payload });
    return promise;
  }

  /** Are the files for this exact model + revision already in the browser's cache? */
  async function isCached() {
    if (!cacheStorage) return false;
    try {
      // has() first: open() CREATES the cache when it is missing, and merely asking whether the
      // model is here must not leave anything behind.
      if (!(await cacheStorage.has(CACHE_NAME))) return false;
      const cache = await cacheStorage.open(CACHE_NAME);
      const urls = (await cache.keys()).map((r) => r.url);
      const base = `/${model.id}/resolve/${model.revision}/`;
      return ['tokenizer.json', 'config.json', `onnx/model_${model.dtype}.onnx`].every((f) => urls.some((u) => u.includes(base) && u.endsWith(f)));
    } catch {
      return false;
    }
  }

  return {
    model,
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    isCached,

    /**
     * Start the worker and get the model ready. With `download: false` this can only ever use
     * files already on the device — the worker refuses any network request — so a returning
     * visit can never turn into a silent 390 MB download.
     */
    async load({ download }) {
      if (state.phase === 'ready' || state.phase === 'writing') return { device: state.device };
      set({ phase: download ? 'downloading' : 'loading', loaded: 0, tokens: 0 });
      try {
        return await request('load', { model, download });
      } catch (err) {
        set({ phase: 'idle' });
        throw err;
      }
    },

    /** One completion. Resolves with the raw text (the guard is applied by writeSummary()). */
    write(messages, { maxNewTokens = 220 } = {}) {
      if (state.phase !== 'ready') return Promise.reject(new AiError('The model is not ready.', 'failed'));
      set({ phase: 'writing', tokens: 0 });
      return request('write', { messages, maxNewTokens });
    },

    /** Stop what is running. Generation stops at the next token; a download is abandoned. */
    interrupt() {
      if (state.phase === 'writing') worker?.postMessage({ type: 'interrupt' });
      else if (state.phase === 'downloading' || state.phase === 'loading') this.terminate();
    },

    /** Drop the worker, and with it the model and anything it was holding in memory. */
    terminate() {
      worker?.terminate();
      worker = null;
      set({ phase: 'idle', device: null, tokens: 0 });
      rejectAll(new AiError('Stopped.', 'cancelled'));
    },

    /** Delete the downloaded model from the browser. */
    async removeModel() {
      this.terminate();
      if (!cacheStorage || !(await cacheStorage.has(CACHE_NAME))) return;
      const cache = await cacheStorage.open(CACHE_NAME);
      const base = `/${model.id}/`;
      for (const req of await cache.keys()) if (req.url.includes(base)) await cache.delete(req);
    },
  };
}
