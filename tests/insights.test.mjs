// Step 3 tests: the computed facts, the prompt, the number guard, the bridge, and the charts.
// No dependencies, no model, no network: run with `node --test tests/*.test.mjs`.
//
// The model itself is exercised in a real browser (see README); what is tested here is
// everything AROUND it, which is where the guarantees live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'], language: 'en-US' }, configurable: true });

const schema = await import('../js/schema.js');
const money = await import('../js/money.js');
const ins = await import('../js/insights.js');
const charts = await import('../js/charts.js');

/* ---------------------------------------------------------------- fixtures */

const cats = schema.defaultCategories();
const id = (main, sub) => {
  const m = cats.find((c) => c.name === main);
  return { categoryId: m.id, subCategoryId: sub ? m.subs.find((s) => s.name === sub).id : null };
};

let n = 0;
function tx(type, amount, main, sub, date, extra = {}) {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, type, amount, currency: 'UGX',
    ...id(main, sub), date, note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    deleted: false, ...extra,
  };
}

const SEP = '2026-09';
const AUG = '2026-08';

// A month with something to say about every fact.
const data = [
  tx('income', 250_000, 'Employment Income', 'Salary / Wages', '2026-09-01'),
  tx('income', 35_000, 'Investment Income', 'Trading Income', '2026-09-03'),
  tx('expense', 60_000, 'Food', 'Groceries', '2026-09-04'),
  tx('expense', 30_000, 'Food', 'Groceries', '2026-09-11'),
  tx('expense', 40_000, 'Transportation', 'Public Transportation', '2026-09-05'),
  tx('expense', 20_000, 'Housing & Technology', 'Forex', '2026-09-06'),
  tx('expense', 27_000, 'Housing & Technology', 'Data', '2026-09-07'),
  tx('expense', 30_000, 'Savings & Investments', 'Savings Accounts', '2026-09-08'),
  // August, for month-over-month and for the "usual" baseline of Dining Out.
  tx('income', 250_000, 'Employment Income', 'Salary / Wages', '2026-08-01'),
  tx('expense', 100_000, 'Food', 'Groceries', '2026-08-10'),
  tx('expense', 10_000, 'Food', 'Dining Out', '2026-08-02'),
  tx('expense', 12_000, 'Food', 'Dining Out', '2026-08-09'),
  tx('expense', 14_000, 'Food', 'Dining Out', '2026-08-16'),
  tx('expense', 60_000, 'Food', 'Dining Out', '2026-09-12'), // 5× the usual 12,000
  tx('expense', 9_999, 'Food', 'Groceries', '2026-09-20', { deleted: true }), // must never count
];
const facts = computeFor(SEP);
function computeFor(month, list = data) { return ins.computeInsights({ transactions: list, categories: cats, month }); }

const real = ins.makeFormatter('UGX');
const lines = ins.factLines(facts, real);
const textOf = (which) => lines.find((l) => l.id === which)?.text;

/* ---------------------------------------------------------------- computed facts */

test('totals: income, spending (savings apart), savings and net match the Month screen', () => {
  // income 250,000 + 35,000; spending = groceries 90k + transport 40k + forex 20k + data 27k + dining 60k
  assert.deepEqual({ income: facts.totals.income, spending: facts.totals.spending, savings: facts.totals.savings, net: facts.totals.net },
    { income: 285_000, spending: 237_000, savings: 30_000, net: 18_000 });
});

test('soft-deleted transactions never count, anywhere', () => {
  const without = computeFor(SEP, data.filter((t) => !t.deleted));
  assert.deepEqual(facts.totals, without.totals);
  assert.deepEqual(facts.byMain, without.byMain);
});

test('spending by category: largest first, savings excluded, shares are whole percents', () => {
  assert.deepEqual(facts.byMain.map((c) => c.name), ['Food', 'Housing & Technology', 'Transportation']);
  assert.equal(facts.byMain[0].amount, 150_000); // 60k + 30k groceries + 60k dining
  assert.equal(facts.byMain[0].pct, 63);          // 150/237 = 63.29 → 63
  assert.equal(facts.byMain.some((c) => c.name === 'Savings & Investments'), false);
});

test('top 3 spending sub-categories, largest first', () => {
  assert.deepEqual(facts.topSubs.map((s) => [s.subName, s.amount]),
    [['Groceries', 90_000], ['Dining Out', 60_000], ['Public Transportation', 40_000]]);
});

test('savings rate is savings ÷ income, rounded half up', () => {
  assert.equal(facts.savingsRate.pct, 11); // 30,000 / 285,000 = 10.53% → 11
  assert.equal(computeFor('2026-07').savingsRate, null, 'no income, no rate');
});

test('month-over-month change: direction, whole percent, and the difference', () => {
  // August spending: groceries 100k + dining 36k = 136,000. September 237,000.
  assert.deepEqual(facts.spendingChange, { delta: 101_000, pct: 74 }); // 101/136 = 74.26%
  assert.equal(facts.incomeChange.delta, 35_000);
  assert.equal(facts.incomeChange.pct, 14);                            // 35/250 = 14%
  assert.equal(computeFor(AUG).spendingChange, null, 'no July data to compare with');
});

test('unusual: more than 2× the average of the OTHER transactions, with a baseline of at least 3', () => {
  assert.equal(facts.unusual.length, 1);
  const u = facts.unusual[0];
  assert.deepEqual([u.name, u.amount, u.average, u.timesTenths], ['Dining Out', 60_000, 12_000, 50]);

  // Exactly 2× is not "more than" 2×.
  const edge = [...data.filter((t) => t.subCategoryId?.endsWith('dining-out') === false || t.date < '2026-09'),
    tx('expense', 24_000, 'Food', 'Dining Out', '2026-09-12')];
  assert.equal(computeFor(SEP, edge).unusual.length, 0, '24,000 is exactly twice 12,000');

  // Too little history to say what is usual.
  const thin = [data[13], tx('expense', 1_000, 'Food', 'Dining Out', '2026-08-02'), tx('expense', 1_000, 'Food', 'Dining Out', '2026-08-03')];
  assert.equal(computeFor(SEP, thin).unusual.length, 0, 'only 2 others: not enough to call anything unusual');
});

test('unusual: the transaction is left out of its own baseline', () => {
  // With itself included the average would be 27,500 and 60,000 would NOT be more than twice it.
  assert.equal(facts.unusual[0].average, 12_000);
});

test('Forex spending vs Trading Income', () => {
  assert.deepEqual(facts.forexTrading, { forex: 20_000, trading: 35_000, diff: 15_000 });
  assert.equal(computeFor(AUG).forexTrading, null, 'neither present: nothing to say');
  const loss = computeFor(SEP, [tx('income', 5_000, 'Investment Income', 'Trading Income', '2026-09-02'), tx('expense', 20_000, 'Housing & Technology', 'Forex', '2026-09-03')]);
  assert.equal(loss.forexTrading.diff, -15_000, 'a shortfall is negative, not clamped');
});

test('an empty month says so plainly, and nothing else', () => {
  const empty = computeFor('2026-01');
  assert.equal(empty.empty, true);
  const l = ins.factLines(empty, real);
  assert.deepEqual(l.map((x) => x.id), ['period', 'empty']);
});

test('every figure in the facts is an integer — money, percentages and ratios alike', () => {
  const walk = (v, path) => {
    if (typeof v === 'number') assert.ok(Number.isInteger(v), `${path} = ${v} must be an integer`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(facts, 'facts');
});

test('percentages round half up with integers only (no 0.1 + 0.2 surprises)', () => {
  const f = computeFor(SEP, [tx('income', 200, 'Employment Income', 'Bonuses', '2026-09-01'), tx('expense', 25, 'Savings & Investments', 'Savings Accounts', '2026-09-02')]);
  assert.equal(f.savingsRate.pct, 13, '12.5% rounds up to 13');
  const g = computeFor(SEP, [tx('income', 3, 'Employment Income', 'Bonuses', '2026-09-01'), tx('expense', 1, 'Savings & Investments', 'Savings Accounts', '2026-09-02')]);
  assert.equal(g.savingsRate.pct, 33, '33.33…% rounds to 33');
});

/* ---------------------------------------------------------------- the fact lines and the prompt */

test('fact lines read as plain sentences with the figures in them', () => {
  const norm = (s) => s.replace(/[  ]/g, ' ');
  assert.equal(norm(textOf('income')), 'Income: USh 285,000');
  assert.equal(norm(textOf('spending')), 'Spending, not counting savings: USh 237,000');
  assert.equal(textOf('savings-rate'), 'Savings rate: 11% of income went to savings and investments');
  assert.match(norm(textOf('spending-change')), /^Spending compared with August 2026: up 74% \(USh 101,000 more\)$/);
  assert.match(norm(textOf('by-category')), /^Spending by category: Food USh 150,000 \(63%\), Housing & Technology USh 47,000 \(20%\), Transportation USh 40,000 \(17%\)$/);
  assert.match(norm(textOf('top-subs')), /Largest: Groceries \(Food\) USh 90,000; next: Dining Out \(Food\) USh 60,000; then: Public Transportation \(Transportation\) USh 40,000/);
  assert.match(norm(textOf('unusual-0')), /^Unusual: Dining Out on Sep 12 was USh 60,000, about 5.0 times its usual USh 12,000$/);
  assert.match(norm(textOf('forex-trading')), /Forex spending: USh 20,000\. Trading Income: USh 35,000\. Trading Income minus Forex spending: USh 15,000/);
});

test('categories beyond the fourth are rolled into "all other categories" with their own total', () => {
  const many = ['Food', 'Transportation', 'Healthcare', 'Personal Expenses', 'Debt Payments', 'Other Expenses']
    .map((m, i) => tx('expense', 10_000 * (6 - i), m, null, '2026-09-02'));
  const f = computeFor(SEP, many);
  const line = ins.factLines(f, real).find((l) => l.id === 'by-category').text.replace(/[  ]/g, ' ');
  assert.match(line, /all other categories USh 30,000 \(14%\)$/, '20k + 10k of a 210k total');
});

test('facts are lettered into groups; the month is shared context', () => {
  assert.deepEqual(lines.map((l) => [l.id, l.group]), [
    ['period', '*'],
    ['income', 'A'], ['spending', 'A'], ['savings', 'A'], ['net', 'A'],
    ['savings-rate', 'B'], ['spending-change', 'B'], ['income-change', 'B'],
    ['by-category', 'C'], ['top-subs', 'C'],
    ['unusual-0', 'D'],
    ['forex-trading', 'E'],
  ]);
  assert.deepEqual(ins.groupsOf(lines).map((g) => [g.letter, g.lines.length]), [['A', 4], ['B', 3], ['C', 2], ['D', 1], ['E', 1]]);
  // A month with less to say gets fewer groups, still lettered from A.
  const thin = ins.factLines(computeFor(SEP, [tx('income', 5_000, 'Employment Income', 'Bonuses', '2026-09-01')]), real);
  assert.deepEqual(ins.groupsOf(thin).map((g) => g.letter), ['A', 'B']);
  assert.deepEqual(ins.groupsOf(ins.factLines(computeFor('2026-01'), real)), [], 'an empty month has nothing to write about');
});

test('the prompt holds the facts as a list AND the required instruction, word for word', () => {
  const messages = ins.buildMessages(lines, { currency: 'UGX' });
  const [system, exampleUser, exampleAnswer, user] = messages;
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(ins.INSTRUCTION, 'Use only these numbers. Do not calculate or invent any figures.');
  assert.ok(user.content.includes(ins.INSTRUCTION), 'in the real request');
  assert.ok(system.content.includes(ins.INSTRUCTION), 'and in the system message');
  assert.ok(exampleUser.content.includes(ins.INSTRUCTION), 'and in the example, so it learns them together');
  for (const l of lines) assert.ok(user.content.includes(`- ${l.text}`), `fact present verbatim as a list item: ${l.id}`);
  assert.equal(user.content.split('\n').filter((x) => x.startsWith('- ')).length, lines.length, 'one bullet per fact');
  for (const letter of ['[A]', '[B]', '[C]', '[D]', '[E]']) assert.ok(user.content.includes(letter), `group ${letter}`);
  assert.match(system.content, /exactly one short sentence for each group/);
  assert.match(system.content, /no advice, no judgement, no scolding/i, 'calm, not shaming');
  assert.match(exampleAnswer.content, /^\[A\] .*\n\[B\] .*\n\[C\] /, 'the example shows the format asked for');
});

test('the worked example is about things this app does not have, so leaks are recognisable', () => {
  const [, exampleUser] = ins.buildMessages(lines);
  for (const term of ins.EXAMPLE_TERMS) assert.ok(exampleUser.content.includes(term), `example mentions ${term}`);
  const names = new Set(cats.flatMap((c) => [c.name, ...c.subs.map((s) => s.name)]));
  for (const term of ['Pets', 'Books']) assert.equal(names.has(term), false, `${term} is not a default category`);
  // and the example is written in the person's own currency, so it doesn't teach the wrong symbol
  const usd = ins.buildMessages(lines, { currency: 'USD' })[1].content.replace(/[  ]/g, ' ');
  assert.match(usd, /Income: \$1,111,000\.00/);
});

test('a retry names what was wrong', () => {
  const user = ins.buildMessages(lines, { offenders: ['48,000', 'half'] }).at(-1);
  assert.match(user.content, /had problems: 48,000; half/);
});

test('privacy: the on-screen facts can be masked without touching the wording', () => {
  const masked = ins.factLines(facts, ins.makeFormatter('UGX', { masked: true }));
  const joined = masked.map((l) => l.text).join('\n');
  assert.equal(/USh|\d{1,3},\d{3}/.test(joined), false, 'no amounts');
  assert.match(joined, /Savings rate: 11%/, 'percentages are not amounts');
  assert.equal(masked.length, lines.length);
});

/* ---------------------------------------------------------------- the number guard */

const check = (text) => ins.verifyNumbers(text, lines, 'UGX');

test('guard: text that only repeats the facts passes', () => {
  const good = 'You earned USh 285,000 in September 2026 and spent USh 237,000, not counting savings. '
    + '11% of your income went to savings and investments. Food was the biggest category at USh 150,000, or 63%. '
    + 'Trading Income was USh 35,000 against USh 20,000 of Forex spending.';
  assert.deepEqual(check(good), { ok: true, offenders: [] });
});

test('guard: an invented or recalculated figure is caught', () => {
  assert.deepEqual(check('You spent USh 240,000 this month.'), { ok: false, offenders: ['240,000'] });
  assert.deepEqual(check('Savings were 12% of income.'), { ok: false, offenders: ['12'] });
  assert.equal(check('Net balance was USh 18,001.').ok, false, 'off by one is still wrong');
});

test('guard: figures may be punctuated differently, but their value has to match', () => {
  assert.equal(check('Income was USh 285000.').ok, true, 'no separator');
  assert.equal(check('Income was 285.000 USh.').ok, true, 'other separator, code after');
  assert.equal(check('Income was UGX 285,000.').ok, true, 'the currency code');
  assert.equal(check('Income was 285,001 USh.').ok, false);
});

test('guard: a number must be the right KIND of number', () => {
  // 63 appears in the facts only as a percentage, so it is not a valid money figure or a plain count.
  assert.equal(check('Food was 63%.').ok, true);
  assert.deepEqual(check('Food was USh 63.'), { ok: false, offenders: ['63'] }, '63 is a percent, not an amount');
  // 150,000 appears in the facts only as money, so "150,000%" is nonsense.
  assert.equal(check('Food was up 150,000%.').ok, false);
  assert.equal(check('It rose by 74 percent.').ok, true, '"percent" counts as a percentage');
});

test('guard: a bare number equal to a money figure is fine (people drop the symbol)', () => {
  assert.equal(check('Food came to 150,000 for the month.').ok, true);
});

test('guard: spelled-out figures and shorthand are refused, because the digit check cannot see them', () => {
  for (const bad of ['Food took about half of your spending.', 'You spent three times more.', 'A quarter went to travel.',
    'Spending doubled.', 'You saved twice as much.', 'Food was 150k.', 'About a hundred thousand shillings.', 'That was ½ of it.']) {
    assert.equal(check(bad).ok, false, bad);
  }
  assert.equal(check('The first thing to notice is your income.').ok, true, 'ordinals are ordinary words');
});

test('guard: a date or count that IS in the facts is allowed; one that is not, is not', () => {
  assert.equal(check('The Dining Out on Sep 12 stood out.').ok, true, '12 is in the facts');
  assert.equal(check('The Dining Out on Sep 13 stood out.').ok, false);
  assert.equal(check('There were 4 unusual purchases.').ok, false);
});

test('guard: canonical numbers ignore punctuation but keep decimals', () => {
  assert.equal(ins.canonicalNumber('1,250,000'), '1250000');
  assert.equal(ins.canonicalNumber('1.250.000'), '1250000');
  assert.equal(ins.canonicalNumber('1 250 000'.replace(/ /g, ' ')), '1250000');
  assert.equal(ins.canonicalNumber('1,250.50'), '1250.5');
  assert.equal(ins.canonicalNumber('1.250,50'), '1250.5');
  assert.equal(ins.canonicalNumber('3.5'), '3.5');
  assert.equal(ins.canonicalNumber('5.0'), '5');
  assert.notEqual(ins.canonicalNumber('3.5'), ins.canonicalNumber('35'), '3.5 times is not 35 times');
});

test('guard: works for a two-decimal currency too', () => {
  const usd = ins.factLines(computeFor(SEP, data.map((t) => ({ ...t, currency: 'USD' }))), ins.makeFormatter('USD'));
  const income = usd.find((l) => l.id === 'income').text.replace(/[  ]/g, ' ');
  assert.equal(income, 'Income: $2,850.00');
  assert.equal(ins.verifyNumbers('Income was $2,850.00 this month.', usd, 'USD').ok, true);
  assert.equal(ins.verifyNumbers('Income was $2,850.10 this month.', usd, 'USD').ok, false);
});

/* ---------------------------------------------------------------- writeSummary() */

const labels = ins.labelFigures(facts, real, 'UGX');
const fakeBridge = (...replies) => {
  const calls = [];
  return { calls, write: async (messages, opts) => { calls.push({ messages, opts }); return replies[Math.min(calls.length - 1, replies.length - 1)]; } };
};

const GOOD = [
  '[A] In September 2026 you earned USh 285,000 and spent USh 237,000, not counting savings.',
  '[B] About 11% of your income went to savings and investments, and spending was up 74% on August 2026.',
  '[C] Food was the biggest category at USh 150,000, or 63% of spending.',
  '[D] Dining Out on Sep 12 was USh 60,000, about 5.0 times its usual USh 12,000.',
  '[E] Trading Income was USh 35,000 against USh 20,000 of Forex spending.',
].join('\n');

const run = (reply, extra = {}) => ins.writeSummary({ lines, labels, bridge: fakeBridge(reply), currency: 'UGX', ...extra });

test('writeSummary: one sentence per group, all checked, all kept', async () => {
  const out = await run(GOOD);
  assert.equal(out.ok, true);
  assert.deepEqual(out.sentences.map((s) => s.group), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.text.includes('[A]'), false, 'the tags are stripped from what is shown');
  assert.equal(out.attempts, 1);
});

test('writeSummary: the request asks for a token budget sized to the groups', async () => {
  const bridge = fakeBridge(GOOD);
  await ins.writeSummary({ lines, labels, bridge, currency: 'UGX' });
  assert.equal(bridge.calls[0].opts.maxNewTokens, ins.tokenBudget(5));
  assert.ok(ins.tokenBudget(5) < 220, 'no rambling: a fifth of the old open-ended cap per group');
});

test('writeSummary: a figure borrowed from ANOTHER group is refused — the mistake a plain check misses', async () => {
  // 14% exists in the facts (it is the INCOME change), so a check of "is this number anywhere?" passes it.
  // But the savings-rate sentence belongs to group B, which also holds 74% and 11% — 14% is in group B too!
  // So put a figure from group C (63%) into group B instead: it exists, but not for this sentence.
  const bad = GOOD.replace('About 11% of your income', 'About 63% of your income');
  const out = await run(bad);
  assert.equal(out.ok, true, 'the other four sentences survive');
  assert.deepEqual(out.dropped.map((d) => d.group), ['B']);
  assert.deepEqual(out.dropped[0].offenders, ['63']);
  assert.equal(out.sentences.some((s) => s.group === 'B'), false);
  assert.equal(out.text.includes('63% of your income'), false, 'the bad sentence is not in the text');
});

test('writeSummary: a sentence about a group\'s facts cannot use a figure that only another group has', async () => {
  const bad = GOOD.replace('spent USh 237,000', 'spent USh 150,000'); // 150,000 is Food's total, not group A's
  const out = await run(bad);
  assert.deepEqual(out.dropped.map((d) => d.group), ['A']);
  assert.deepEqual(out.dropped[0].offenders, ['150,000']);
});

test('writeSummary: an invented figure drops only its own sentence', async () => {
  const out = await run(GOOD.replace('USh 35,000 against', 'USh 36,000 against'));
  assert.deepEqual(out.dropped.map((d) => [d.group, d.offenders]), [['E', ['36,000']]]);
  assert.equal(out.sentences.length, 4);
});

test('writeSummary: a name attached to another name\'s figure is refused (the label guard)', async () => {
  const out = await run(GOOD.replace('Food was the biggest category at USh 150,000, or 63%', 'Food came to USh 47,000, or 20%'));
  assert.deepEqual(out.dropped.map((d) => d.group), ['C']);
  assert.deepEqual(out.dropped[0].offenders, ["47,000 doesn't belong to Food", "20% doesn't belong to Food"]);
});

test('writeSummary: content leaked from the worked example is refused', async () => {
  const out = await run(GOOD.replace('Food was the biggest category at USh 150,000, or 63% of spending.', 'Pets took the biggest share of your spending.'));
  assert.deepEqual(out.dropped.map((d) => [d.group, d.offenders]), [['C', ['Pets']]]);
});

test('writeSummary: spelled-out figures are refused', async () => {
  const out = await run(GOOD.replace('[E] Trading Income was USh 35,000 against USh 20,000 of Forex spending.', '[E] Trading Income was about double Forex spending.'));
  assert.deepEqual(out.dropped.map((d) => [d.group, d.offenders]), [['E', ['double']]]);
});

test('writeSummary: a missing group is dropped quietly; talk before the first tag is ignored', async () => {
  const out = await run("Sure! Here you go:\n" + GOOD.split('\n').filter((l) => !l.startsWith('[D]')).join('\n'));
  assert.equal(out.ok, true);
  assert.deepEqual(out.dropped, [{ group: 'D', offenders: [] }]);
  assert.equal(out.text.includes('Sure'), false);
});

test('writeSummary: the model just re-printing the list yields NOTHING, not a "summary"', async () => {
  const echo = 'FACTS:\n' + lines.map((l) => `- ${l.text}`).join('\n');
  const out = await run(echo);
  assert.deepEqual(out, { ok: false, reason: 'empty', offenders: [], attempts: 1 });
});

test('writeSummary: if every sentence fails there is nothing to show, and it says why', async () => {
  const out = await run('[A] You spent USh 999,999.\n[B] It went up 5%.');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'figures');
  assert.ok(out.offenders.includes('999,999'));
  assert.equal('text' in out, false, 'the rejected text is never exposed');
});

test('writeSummary: an empty month has nothing to write about, and never asks the model', async () => {
  const bridge = fakeBridge(GOOD);
  const out = await ins.writeSummary({ lines: ins.factLines(computeFor('2026-01'), real), bridge, currency: 'UGX' });
  assert.deepEqual(out, { ok: false, reason: 'nothing', offenders: [], attempts: 0 });
  assert.equal(bridge.calls.length, 0);
});

test('writeSummary: one attempt by default; a retry, when asked for, is told what was wrong', async () => {
  const bridge = fakeBridge('[A] You spent USh 999,999.', GOOD);
  const one = await ins.writeSummary({ lines, labels, bridge, currency: 'UGX' });
  assert.equal(one.ok, false);
  assert.equal(bridge.calls.length, 1, 'no silent second multi-minute run');

  const bridge2 = fakeBridge('[A] You spent USh 999,999.', GOOD);
  const two = await ins.writeSummary({ lines, labels, bridge: bridge2, currency: 'UGX', maxAttempts: 2 });
  assert.equal(two.ok, true);
  assert.equal(two.attempts, 2);
  assert.match(bridge2.calls[1].messages.at(-1).content, /had problems: 999,999/);
});

test('parseGroups reads tags, keeps the first of a repeat, and ignores everything before the first tag', () => {
  assert.deepEqual([...ins.parseGroups('hi [A] one. [B] two. [A] again.')], [['A', 'one.'], ['B', 'two.']]);
  assert.deepEqual([...ins.parseGroups('no tags here')], []);
  assert.deepEqual([...ins.parseGroups(undefined)], []);
});

test('cleanSummary strips bullets and markdown and stops at the limit', () => {
  assert.equal(ins.cleanSummary('- **Income** was fine.\n- Spending was fine.'), 'Income was fine. Spending was fine.');
  const long = Array.from({ length: 8 }, (_, i) => `Sentence number ${i}.`).join(' ');
  assert.equal(ins.cleanSummary(long).split('. ').length, 5, 'five by default');
  assert.equal(ins.cleanSummary(long, 2).split('. ').length, 2);
  assert.equal(ins.cleanSummary('Rate was 3.5 times. Next.'), 'Rate was 3.5 times. Next.', 'a decimal point is not a sentence end');
});

/* ---------------------------------------------------------------- the label guard */

test('label guard: a name in front of a figure must own that figure', () => {
  const check = (text) => ins.checkLabels(text, labels, 'UGX');
  assert.deepEqual(check('Food came to USh 150,000, or 63% of spending.'), []);
  assert.deepEqual(check('Housing & Technology was USh 47,000, or 20%.'), []);
  assert.deepEqual(check('Groceries (Food) came to USh 90,000.'), [], 'a main is credited with its sub-categories');
  assert.deepEqual(check('Food at USh 47,000.'), ["47,000 doesn't belong to Food"]);
  assert.deepEqual(check('Housing & Technology was USh 47,000, or 63%.'), ["63% doesn't belong to Housing & Technology"], 'a chained percent inherits the name');
});

test('label guard: the closest name owns the figure however many words lie between (a real model mistake)', () => {
  // Measured with the real model: 90,000 is Groceries, but 63% is Food's share. Both are in the same
  // group, so per-group checking passes it; only binding the figure to its name catches it.
  const check = (text) => ins.checkLabels(text, labels, 'UGX');
  assert.deepEqual(check('Groceries took the biggest share of your spending at USh 90,000, or 63%.'), ["63% doesn't belong to Groceries"]);
  assert.deepEqual(check('Spending on Food rose 74%.'), ["74% doesn't belong to Food"], '74% is total spending, not Food');
  assert.deepEqual(check('Food took the biggest share of your spending at USh 150,000, or 63%.'), [], 'and the correct version passes');
});

test('label guard: a comma does not detach a description from its name (a second real model mistake)', () => {
  // Measured with the real model for a month with one Food sub-category: "Groceries, accounting for 100%".
  // 100% is Food's share; Groceries is a part of it.
  const check = (text) => ins.checkLabels(text, labels, 'UGX');
  assert.deepEqual(check('The largest spending sub-category was Groceries, accounting for 63% of your spending.'), ["63% doesn't belong to Groceries"]);
  assert.deepEqual(check('Food was the largest category, accounting for 63% of your spending.'), [], 'the correct version passes');
});

test('label guard: clauses are separate claims, so a name is not pinned on a later figure', () => {
  const check = (text) => ins.checkLabels(text, labels, 'UGX');
  assert.deepEqual(check('Food made up most of it, and spending rose 74%.'), []);
  assert.deepEqual(check('Food was 63% of spending, and Groceries were USh 90,000.'), []);
  assert.deepEqual(check('Food was big. Then income rose 14%.'), [], 'a new sentence starts fresh');
  assert.deepEqual(check('Housing & Technology was USh 47,000, or 20%, and Food USh 150,000.'), []);
  assert.deepEqual(check('Income was USh 1,250,000 this month.'), [], 'commas inside a number do not split a clause');
  assert.deepEqual(ins.checkLabels('anything USh 1', new Map(), 'UGX'), []);
});

test('label guard: a clause naming TWO things is not attributed — it would be a guess', () => {
  const check = (text) => ins.checkLabels(text, labels, 'UGX');
  // 20,000 belongs to the name AFTER it (Forex); pinning it on the first name would be a false alarm.
  assert.deepEqual(check('Trading Income was USh 35,000 against USh 20,000 of Forex spending.'), []);
  assert.deepEqual(check('Dining Out (Food) came to USh 60,000.'), [], 'a sub-category and its main together are two names');
});

test('label guard: Forex and Trading Income are tied to their own figures, and to their difference', () => {
  const check = (text) => ins.checkLabels(text, labels, 'UGX');
  assert.deepEqual(check('Forex was USh 20,000.'), []);
  assert.deepEqual(check('Trading Income was USh 35,000.'), []);
  assert.deepEqual(check('Trading Income was USh 20,000.'), ["20,000 doesn't belong to Trading Income"]);
  assert.deepEqual(check('Forex was USh 15,000.'), [], 'the difference is credited to both');
});

test('echo guard: a list entry is not a sentence', () => {
  assert.equal(ins.isListEcho('Forex spending: USh 20,000.', 'UGX'), true);
  assert.equal(ins.isListEcho('Savings rate: 11% of income went to savings.', 'UGX'), true);
  assert.equal(ins.isListEcho('Income: 285,000', 'UGX'), true, 'even without the symbol');
  assert.equal(ins.isListEcho('You spent USh 20,000 on Forex.', 'UGX'), false);
  assert.equal(ins.isListEcho('In June 2024: you earned a lot.', 'UGX'), false, 'a colon is fine; a colon then a figure is a list');
});

test('writeSummary: a group that just re-prints its fact line is dropped, and the rest are kept (a real model habit)', async () => {
  const echoed = GOOD.replace('[E] Trading Income was USh 35,000 against USh 20,000 of Forex spending.',
    '[E]\n- Forex spending: USh 20,000. Trading Income: USh 35,000. Trading Income minus Forex spending: USh 15,000.');
  const out = await run(echoed);
  assert.equal(out.ok, true);
  assert.deepEqual(out.dropped, [{ group: 'E', offenders: ['repeats the list instead of writing a sentence'] }]);
  assert.equal(out.sentences.length, 4);
});

test('writeSummary: the exact sentence a real model wrote (Groceries with Food\'s 63%) is refused', async () => {
  const measured = GOOD.replace('Food was the biggest category at USh 150,000, or 63% of spending.',
    'Groceries took the biggest share of your spending at USh 90,000, or 63%.');
  const out = await run(measured);
  assert.deepEqual(out.dropped, [{ group: 'C', offenders: ["63% doesn't belong to Groceries"] }]);
  assert.equal(out.text.includes('Groceries took'), false);
});

/* ---------------------------------------------------------------- the bridge (with a fake worker) */

function fakeWorker() {
  const w = { sent: [], terminated: false, onmessage: null, onerror: null, onmessageerror: null,
    postMessage(m) { w.sent.push(m); }, terminate() { w.terminated = true; },
    say(m) { w.onmessage({ data: m }); } };
  return w;
}

test('bridge: no worker exists until AI is enabled', () => {
  let created = 0;
  ins.createAiBridge({ createWorker: () => { created += 1; return fakeWorker(); }, cacheStorage: null });
  assert.equal(created, 0, 'constructing the bridge starts nothing');
});

test('bridge: load → progress → ready, and it sends the model spec and the download flag', async () => {
  const w = fakeWorker();
  const bridge = ins.createAiBridge({ createWorker: () => w, cacheStorage: null });
  const seen = [];
  bridge.subscribe((s) => seen.push(s.phase));

  const loading = bridge.load({ download: true });
  assert.equal(bridge.getState().phase, 'downloading');
  assert.equal(w.sent[0].type, 'load');
  assert.equal(w.sent[0].download, true);
  assert.equal(w.sent[0].model.id, 'HuggingFaceTB/SmolLM2-360M-Instruct');

  w.say({ type: 'progress', loaded: 1000, total: 400_000_000 });
  assert.equal(bridge.getState().loaded, 1000);
  w.say({ type: 'phase', phase: 'loading' });
  w.say({ type: 'loaded', id: w.sent[0].id, device: 'wasm' });
  assert.deepEqual(await loading, { device: 'wasm' });
  assert.equal(bridge.getState().phase, 'ready');
  assert.deepEqual(seen, ['downloading', 'downloading', 'loading', 'ready']);
});

test('bridge: a returning visit loads WITHOUT permission to download', async () => {
  const w = fakeWorker();
  const bridge = ins.createAiBridge({ createWorker: () => w, cacheStorage: null });
  const loading = bridge.load({ download: false });
  assert.equal(w.sent[0].download, false);
  assert.equal(bridge.getState().phase, 'loading');
  w.say({ type: 'error', id: w.sent[0].id, code: 'not-cached', message: 'gone' });
  await assert.rejects(loading, (e) => e.code === 'not-cached');
  assert.equal(bridge.getState().phase, 'idle');
});

test('bridge: write returns the text; only one thing runs at a time', async () => {
  const w = fakeWorker();
  const bridge = ins.createAiBridge({ createWorker: () => w, cacheStorage: null });
  const loading = bridge.load({ download: true });
  w.say({ type: 'loaded', id: w.sent[0].id, device: 'webgpu' });
  await loading;

  const writing = bridge.write([{ role: 'user', content: 'hi' }]);
  assert.equal(bridge.getState().phase, 'writing');
  await assert.rejects(bridge.write([]), (e) => /not ready/.test(e.message), 'no second job while one runs');
  w.say({ type: 'tokens', n: 12 });
  assert.equal(bridge.getState().tokens, 12);
  w.say({ type: 'result', id: w.sent[1].id, text: 'done' });
  assert.equal(await writing, 'done');
  assert.equal(bridge.getState().phase, 'ready');
});

test('bridge: interrupt stops writing at the next token; on a download it abandons the worker', async () => {
  const w = fakeWorker();
  const bridge = ins.createAiBridge({ createWorker: () => w, cacheStorage: null });
  const loading = bridge.load({ download: true });
  w.say({ type: 'loaded', id: w.sent[0].id, device: 'wasm' });
  await loading;
  const writing = bridge.write([]);
  bridge.interrupt();
  assert.deepEqual(w.sent.at(-1), { type: 'interrupt' });
  w.say({ type: 'interrupted', id: w.sent[1].id });
  await assert.rejects(writing, (e) => e.code === 'cancelled');
  assert.equal(bridge.getState().phase, 'ready', 'the model stays loaded for next time');

  const w2 = fakeWorker();
  const b2 = ins.createAiBridge({ createWorker: () => w2, cacheStorage: null });
  const dl = b2.load({ download: true });
  b2.interrupt();
  await assert.rejects(dl, (e) => e.code === 'cancelled');
  assert.equal(w2.terminated, true, 'cancelling a download tears the worker down');
  assert.equal(b2.getState().phase, 'idle');
});

test('bridge: terminate() (used on lock) kills the worker and rejects anything in flight', async () => {
  const w = fakeWorker();
  const bridge = ins.createAiBridge({ createWorker: () => w, cacheStorage: null });
  const loading = bridge.load({ download: true });
  w.say({ type: 'loaded', id: w.sent[0].id, device: 'wasm' });
  await loading;
  const writing = bridge.write([{ role: 'user', content: 'a figure: USh 285,000' }]);
  bridge.terminate();
  assert.equal(w.terminated, true);
  await assert.rejects(writing, (e) => e.code === 'cancelled');
  assert.equal(bridge.getState().phase, 'idle');
  assert.equal(bridge.getState().device, null);
});

test('bridge: a crashing worker becomes a plain error, not a hang', async () => {
  const w = fakeWorker();
  const bridge = ins.createAiBridge({ createWorker: () => w, cacheStorage: null });
  const loading = bridge.load({ download: true });
  w.onerror(new Event('error'));
  await assert.rejects(loading, /stopped unexpectedly/);
  assert.equal(bridge.getState().phase, 'idle');
});

test('bridge: "is it downloaded?" reads the browser cache and needs every file', async () => {
  const base = `https://huggingface.co/${ins.AI_MODEL.id}/resolve/${ins.AI_MODEL.revision}/`;
  const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', `onnx/model_${ins.AI_MODEL.dtype}.onnx`];
  const cacheOf = (urls) => ({ has: async () => true, open: async () => ({ keys: async () => urls.map((url) => ({ url })), delete: async () => true }) });

  assert.equal(await ins.createAiBridge({ cacheStorage: cacheOf(files.map((f) => base + f)) }).isCached(), true);
  assert.equal(await ins.createAiBridge({ cacheStorage: cacheOf(files.slice(0, 3).map((f) => base + f)) }).isCached(), false, 'the model file is missing');
  assert.equal(await ins.createAiBridge({ cacheStorage: cacheOf(files.map((f) => base.replace(ins.AI_MODEL.revision, 'oldsha') + f)) }).isCached(), false, 'a different revision does not count');
  assert.equal(await ins.createAiBridge({ cacheStorage: null }).isCached(), false);
});

test('bridge: asking whether the model is downloaded never CREATES the cache', async () => {
  let opened = 0;
  const storage = { has: async () => false, open: async () => { opened += 1; return { keys: async () => [] }; } };
  assert.equal(await ins.createAiBridge({ cacheStorage: storage }).isCached(), false);
  assert.equal(opened, 0, 'caches.open() would have made an empty cache behind the person\'s back');
});

test('bridge: removeModel deletes only this model\'s files', async () => {
  const deleted = [];
  const keep = { url: 'https://huggingface.co/someone/else/resolve/main/x.onnx' };
  const mine = { url: `https://huggingface.co/${ins.AI_MODEL.id}/resolve/${ins.AI_MODEL.revision}/onnx/model_q4.onnx` };
  const bridge = ins.createAiBridge({ cacheStorage: { has: async () => true, open: async () => ({ keys: async () => [keep, mine], delete: async (r) => { deleted.push(r.url); return true; } }) } });
  await bridge.removeModel();
  assert.deepEqual(deleted, [mine.url]);
});

/* ---------------------------------------------------------------- the model constant */

test('the model is one constant, pinned to a revision, with sizes to show BEFORE downloading', () => {
  assert.equal(ins.AI_MODEL.id, 'HuggingFaceTB/SmolLM2-360M-Instruct');
  assert.match(ins.AI_MODEL.revision, /^[0-9a-f]{40}$/, 'a commit sha, not "main"');
  assert.ok(ins.AI_MODEL.downloadBytes > 1e8);
  assert.equal(ins.formatBytes(390_000_000), '390 MB');
  assert.equal(ins.formatBytes(1_449_600_000), '1.4 GB');
  // …and the id is written in exactly one place: nothing else may hard-code a model.
  const code = (f) => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((code('insights.js').match(/HuggingFaceTB\//g) ?? []).length, 1, 'one occurrence in insights.js');
  for (const f of ['app.js', 'ai-worker.js']) assert.equal(/HuggingFaceTB|SmolLM/.test(code(f)), false, `${f} must not name a model`);
});

/* ---------------------------------------------------------------- charts */

const slices = [
  { name: 'Food', value: 150_000, color: '#f59e0b', valueText: 'USh 150,000', sharePct: 63 },
  { name: 'Housing & Technology', value: 47_000, color: '#6366f1', valueText: 'USh 47,000', sharePct: 20 },
  { name: 'Transportation', value: 40_000, color: '#0ea5e9', valueText: 'USh 40,000', sharePct: 17 },
];

/** Everything a person or a screen reader could read out of the markup, without the geometry. */
const readable = (svg) => [...svg.matchAll(/>([^<]+)</g)].map((m) => m[1]).concat([...svg.matchAll(/(?:aria-label|title)="([^"]*)"/g)].map((m) => m[1])).join(' | ');

test('donut: one arc per slice, largest share drawn to scale', () => {
  const svg = charts.donutChart({ slices, showValues: true, totalText: 'USh 237,000', caption: 'spent', ariaLabel: 'Spending' });
  assert.equal((svg.match(/<circle/g) ?? []).length, 3);
  const circ = 2 * Math.PI * 78;
  const dashes = [...svg.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => Number(m[1]));
  assert.ok(Math.abs(dashes[0] - (150 / 237) * circ + 2) < 0.1, 'Food is 150/237 of the ring (less the 2px gap)');
  assert.match(svg, /role="img"/);
});

test('donut: Privacy Mode leaves shapes only — no amount in a label, tooltip or centre', () => {
  const svg = charts.donutChart({ slices, showValues: false, totalText: 'USh 237,000', caption: 'spent', ariaLabel: 'Spending by category' });
  assert.equal(/USh|150,000|47,000|237,000|<title>/.test(svg), false);
  assert.equal((svg.match(/<circle/g) ?? []).length, 3, 'the chart itself is still drawn');
  const shown = charts.donutChart({ slices, showValues: true, totalText: 'USh 237,000', caption: 'spent', ariaLabel: 'x' });
  assert.match(shown, /<title>Food: USh 150,000 \(63%\)<\/title>/, 'control: with values on, the tooltip is there');
});

test('donut: a single slice is a full ring, and no slices is no chart', () => {
  const one = charts.donutChart({ slices: [slices[0]], showValues: false, ariaLabel: 'x' });
  assert.equal((one.match(/<circle/g) ?? []).length, 1);
  assert.equal(charts.donutChart({ slices: [], showValues: false, ariaLabel: 'x' }), '');
  assert.equal(charts.donutChart({ slices: [{ ...slices[0], value: 0 }], showValues: false, ariaLabel: 'x' }), '');
});

test('charts escape category names and refuse odd colours', () => {
  const svg = charts.donutChart({
    slices: [{ name: '<img src=x onerror=alert(1)>', value: 5, color: 'url(javascript:1)', valueText: '"><script>', sharePct: 100 }],
    showValues: true, ariaLabel: '"><svg onload=1>',
  });
  // Whatever the names say, the only elements in the output are the ones the chart itself draws.
  assert.deepEqual([...new Set([...svg.matchAll(/<([a-z]+)/g)].map((m) => m[1]))].sort(), ['circle', 'svg', 'title']);
  assert.ok(svg.includes('aria-label="&quot;&gt;&lt;svg onload=1&gt;"'), 'a quote cannot end the attribute early');
  assert.equal(/javascript:/.test(svg), false, 'a hostile colour is replaced, not passed through');
  assert.match(svg, /stroke="#64748b"/, '…with the neutral fallback');
});

test('niceScale: integer steps of 1, 2 or 5 × a power of ten', () => {
  assert.deepEqual(charts.niceScale(237_000), { max: 300_000, step: 100_000, ticks: [0, 100_000, 200_000, 300_000] }, 'at most 4 intervals');
  assert.equal(charts.niceScale(1).max, 1);
  assert.equal(charts.niceScale(0).max >= 1, true);
  for (const max of [7, 99, 1_000, 123_456, 9_999_999]) {
    const s = charts.niceScale(max);
    assert.ok(s.max >= max, `${max} fits`);
    assert.ok(s.ticks.every(Number.isInteger));
    assert.ok(s.ticks.length <= 6);
  }
});

const months = [
  { label: 'Apr', values: [0, 0], valueTexts: ['USh 0', 'USh 0'] },
  { label: 'Aug', values: [250_000, 136_000], valueTexts: ['USh 250,000', 'USh 136,000'] },
  { label: 'Sep', values: [285_000, 237_000], valueTexts: ['USh 285,000', 'USh 237,000'] },
];
const scale = charts.niceScale(285_000);
const ticks = scale.ticks.map((value) => ({ value, label: money.formatCompact(value, 'UGX') }));
const series = [{ name: 'Income', color: '#14b8a6' }, { name: 'Expenses', color: '#f43f5e' }];

test('bars: two bars per month, heights in proportion, empty months draw nothing', () => {
  const svg = charts.barChart({ groups: months, series, ticks, max: scale.max, showValues: true, ariaLabel: 'Income vs expenses' });
  const rects = [...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(rects.length, 4, 'April is empty: no zero-height bars');
  assert.ok(Math.abs(rects[2] / rects[0] - 285_000 / 250_000) < 0.02, 'September income vs August income');
});

test('bars: Privacy Mode drops axis values and tooltips, keeps the bars', () => {
  const svg = charts.barChart({ groups: months, series, ticks, max: scale.max, showValues: false, ariaLabel: 'Income vs expenses, last 3 months' });
  assert.equal(/USh|<title>|250,000|300K|100K/.test(svg), false, 'no amounts, no axis labels');
  assert.equal((svg.match(/<rect/g) ?? []).length, 4, 'shapes remain');
  assert.equal(/<text[^>]*text-anchor="end"/.test(svg), false, 'no y-axis labels at all');
  const shown = charts.barChart({ groups: months, series, ticks, max: scale.max, showValues: true, ariaLabel: 'x' });
  assert.match(shown, /<title>Sep · Income: USh 285,000<\/title>/, 'control: values on shows tooltips');
  assert.match(shown, /text-anchor="end"[^>]*>300K</, 'and axis labels');
});

test('bars: nothing to draw is an empty string, not a broken chart', () => {
  assert.equal(charts.barChart({ groups: [], series, ticks, max: 1, showValues: true, ariaLabel: 'x' }), '');
  assert.equal(charts.barChart({ groups: months, series, ticks, max: 0, showValues: true, ariaLabel: 'x' }), '');
});

test('formatCompact: short axis labels from exact decimals', () => {
  assert.equal(money.formatCompact(1_250_000, 'UGX'), '1.3M');
  assert.equal(money.formatCompact(50_000, 'UGX'), '50K');
  assert.equal(money.formatCompact(125_000_00, 'USD'), '125K', 'USD cents are scaled by its 2 decimals');
});

/* ---------------------------------------------------------------- no stray network, no logging, no storage */

test('the new modules make no network calls of their own and touch no storage', () => {
  const code = (f) => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['insights.js', 'charts.js']) {
    assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|https?:\/\//.test(code(f)), false, `${f}: no network`);
    assert.equal(/localStorage|sessionStorage|indexedDB/.test(code(f)), false, `${f}: no storage (store.js is the only module that may)`);
  }
});
