// Logic tests for everything that is not the DOM. No dependencies: run with `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';

// store.js only touches `localStorage`, so a Map-backed stand-in is enough.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new MemoryStorage();
// Amounts follow the browser's locale, so pin one for stable expectations.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'], language: 'en-US' }, configurable: true });

const money = await import('../js/money.js');
const schema = await import('../js/schema.js');
const store = await import('../js/store.js');
const { buildCsv } = await import('../js/backup.js');

const fresh = () => { localStorage.clear(); store.init(); };
const catOf = (name) => store.getCategories().flatMap((m) => [m, ...m.subs]).find((c) => c.name === name);
const mainOf = (name) => store.getCategories().find((m) => m.name === name);
const subOf = (main, name) => mainOf(main).subs.find((s) => s.name === name);

function add(mainName, subName, amount, extra = {}) {
  const main = mainOf(mainName);
  return store.addTransaction({
    type: main.type, amount, categoryId: main.id,
    subCategoryId: subName ? subOf(mainName, subName).id : null,
    date: '2026-09-15', note: '', ...extra,
  });
}

/* ---------------------------------------------------------------- money */

test('currency info comes from Intl, not manual input', () => {
  assert.equal(money.decimalsFor('UGX'), 0);
  assert.equal(money.decimalsFor('USD'), 2);
  assert.equal(money.decimalsFor('KWD'), 3);
  assert.equal(money.decimalsFor('JPY'), 0);
});

test('formatting uses Intl grouping and the local symbol', () => {
  assert.equal(money.formatMoney(50000, 'UGX').replace(/\s/g, ' '), 'USh 50,000');
  assert.equal(money.formatMoney(125000, 'USD'), '$1,250.00');
  assert.equal(money.formatMoney(-125000, 'USD').replace('−', '-'), '-$1,250.00');
  assert.equal(money.formatMoney(1, 'USD'), '$0.01');
  assert.equal(money.formatMoney(1234, 'KWD').replace(/\s/g, ' '), 'KWD 1.234');
});

test('parseAmount: whole-number currencies', () => {
  assert.deepEqual(money.parseAmount('50000', 0), { minor: 50000 });
  assert.deepEqual(money.parseAmount('50,000', 0), { minor: 50000 });
  assert.deepEqual(money.parseAmount('1 250 000', 0), { minor: 1250000 });
  assert.deepEqual(money.parseAmount('1.250', 0), { minor: 1250 }, 'three digits after a separator is grouping');
  assert.equal(money.parseAmount('12.5', 0).error, 'no-decimals');
  assert.equal(money.parseAmount('12,50', 0).error, 'no-decimals');
});

test('parseAmount: currencies with decimals never go through floats', () => {
  assert.deepEqual(money.parseAmount('1,250.50', 2), { minor: 125050 });
  assert.deepEqual(money.parseAmount('1.250,50', 2), { minor: 125050 });
  assert.deepEqual(money.parseAmount('12,50', 2), { minor: 1250 });
  assert.deepEqual(money.parseAmount('1250.5', 2), { minor: 125050 });
  assert.deepEqual(money.parseAmount('.5', 2), { minor: 50 });
  assert.deepEqual(money.parseAmount('1,250', 2), { minor: 125000 });
  assert.deepEqual(money.parseAmount('1,25,000', 2), { minor: 12500000 }, 'lakh grouping');
  assert.deepEqual(money.parseAmount('0.29', 2), { minor: 29 }, '0.29*100 is 28.999… in floats');
  assert.deepEqual(money.parseAmount('1.005', 3), { minor: 1005 });
  assert.equal(money.parseAmount('1.234', 2).error, undefined, 'three digits = grouping → 1234.00');
  assert.equal(money.parseAmount('1.2345', 2).error, 'too-many-decimals');
});

test('parseAmount: rejects rubbish', () => {
  assert.equal(money.parseAmount('', 2).error, 'empty');
  assert.equal(money.parseAmount('abc', 2).error, 'invalid');
  assert.equal(money.parseAmount('12a', 2).error, 'invalid');
  assert.equal(money.parseAmount('0', 2).error, 'zero');
  assert.equal(money.parseAmount('0.00', 2).error, 'zero');
  assert.equal(money.parseAmount('-5', 2).error, 'invalid');
  assert.equal(money.parseAmount('1.2,3.4', 2).error, 'invalid');
  assert.equal(money.parseAmount('999999999999999999', 0).error, 'too-large');
});

test('rescale keeps face value when decimals change', () => {
  assert.deepEqual(money.rescale(50000, 0, 2), { minor: 5000000, rounded: false });
  assert.deepEqual(money.rescale(5000000, 2, 0), { minor: 50000, rounded: false });
  assert.deepEqual(money.rescale(5050, 2, 0), { minor: 51, rounded: true }, 'half rounds up');
  assert.deepEqual(money.rescale(5049, 2, 0), { minor: 50, rounded: true });
  assert.deepEqual(money.rescale(7, 3, 3), { minor: 7, rounded: false });
});

test('currency list includes the pinned East African codes first', () => {
  const list = money.listCurrencies();
  assert.deepEqual(list.slice(0, 4).map((c) => c.code), ['UGX', 'KES', 'TZS', 'RWF']);
  assert.ok(list.some((c) => c.code === 'USD'));
  assert.deepEqual(money.searchCurrencies(list, 'shilling').map((c) => c.code).slice(0, 3), ['UGX', 'KES', 'TZS']);
});

/* --------------------------------------------------------------- schema */

test('default tree matches the spec exactly', () => {
  const cats = schema.defaultCategories();
  const shape = (type) => cats.filter((m) => m.type === type).map((m) => [m.name, m.subs.map((s) => s.name)]);
  assert.deepEqual(shape('income'), [
    ['Employment Income', ['Salary / Wages', 'Bonuses', 'Commissions']],
    ['Investment Income', ['Dividends', 'Interest', 'Capital Gains', 'Trading Income']],
    ['Other Income', ['From Previous Month', 'Rental Income', 'Loans', 'Other (Specify)']],
  ]);
  assert.deepEqual(shape('expense'), [
    ['Housing & Technology', ['Data', 'IT Stuff', 'Forex', 'Education']],
    ['Transportation', ['Public Transportation', 'Gas', 'Car Payments', 'Insurance']],
    ['Food', ['Dining Out', 'Groceries']],
    ['Healthcare', ['Medical Expenses', 'Life Insurance', 'Prescription Drugs']],
    ['Personal Expenses', ['Entertainment', 'Gifts', 'Clothing', 'Hobbies']],
    ['Savings & Investments', ['Investment Accounts', 'Savings Accounts', 'Retirement Contributions']],
    ['Debt Payments', ['Credit Card Payments', 'Personal Loans', 'Student Loans']],
    ['Other Expenses', ['Other (Specify)', 'Taxes', 'Church', 'Fees']],
  ]);
  const ids = cats.flatMap((m) => [m.id, ...m.subs.map((s) => s.id)]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual(cats.filter((m) => m.isSavings).map((m) => m.name), ['Savings & Investments']);
  const needNote = cats.flatMap((m) => m.subs.filter((s) => s.requiresNote).map((s) => `${m.name}/${s.name}`));
  assert.deepEqual(needNote, ['Other Income/Other (Specify)', 'Other Expenses/Other (Specify)']);
  assert.deepEqual(schema.sanitizeCategories(cats), cats, 'the defaults are valid under their own validator');
});

test('hiding a category removes it from the form but keeps its label for history', () => {
  let cats = schema.defaultCategories();
  const groceries = cats.find((m) => m.name === 'Food').subs.find((s) => s.name === 'Groceries');
  cats = schema.updateItem(cats, groceries.id, { enabled: false });
  const food = schema.visibleMains(cats, 'expense').find((m) => m.name === 'Food');
  assert.deepEqual(food.subs.map((s) => s.name), ['Dining Out']);
  assert.equal(schema.labelFor(cats, food.id, groceries.id).sub, 'Groceries', 'history still resolves the label');
  const kept = schema.visibleMains(cats, 'expense', { mainId: food.id, subId: groceries.id }).find((m) => m.name === 'Food');
  assert.deepEqual(kept.subs.map((s) => [s.name, s.hidden]), [['Dining Out', false], ['Groceries', true]]);
  cats = schema.updateItem(cats, food.id, { enabled: false });
  assert.ok(!schema.visibleMains(cats, 'expense').some((m) => m.name === 'Food'));
});

test('customizer: add, rename, reorder, duplicate names, delete rules', () => {
  let cats = schema.defaultCategories();
  const food = cats.find((m) => m.name === 'Food');
  cats = schema.addSub(cats, food.id, { name: '  Street   snacks ', emoji: '🌽 extra', color: '#F97316' });
  const snacks = schema.findMain(cats, food.id).subs.at(-1);
  assert.deepEqual([snacks.name, snacks.emoji, snacks.color, snacks.custom], ['Street snacks', '🌽', '#f97316', true]);
  assert.throws(() => schema.addSub(cats, food.id, { name: 'groceries' }), /already exists/);
  assert.throws(() => schema.addSub(cats, food.id, { name: '   ' }), /enter a name/);
  cats = schema.moveItem(cats, snacks.id, -1);
  assert.deepEqual(schema.findMain(cats, food.id).subs.map((s) => s.name), ['Dining Out', 'Street snacks', 'Groceries']);
  cats = schema.moveItem(cats, food.id, -1);
  assert.deepEqual(cats.filter((m) => m.type === 'expense').slice(0, 3).map((m) => m.name),
    ['Housing & Technology', 'Food', 'Transportation'], 'Food swapped with Transportation');
  assert.deepEqual(schema.positionOf(cats, food.id), { index: 1, count: 8 });
  assert.deepEqual(schema.positionOf(cats, snacks.id), { index: 1, count: 3 });
  cats = schema.updateItem(cats, snacks.id, { name: 'Roadside snacks' });
  assert.equal(schema.findSub(cats, food.id, snacks.id).name, 'Roadside snacks');

  cats = schema.addMain(cats, { type: 'expense', name: 'Pets', emoji: '🐕' });
  const pets = cats.find((m) => m.name === 'Pets');
  assert.equal(cats.lastIndexOf(pets), cats.length - 1, 'a new expense main goes after the last expense main');
  assert.throws(() => schema.addMain(cats, { type: 'expense', name: 'food' }), /already exists/);
  assert.doesNotThrow(() => schema.addMain(cats, { type: 'income', name: 'Food' }), 'same name is fine under the other type');

  const used = new Set([snacks.id, food.id]);
  assert.throws(() => schema.removeItem(cats, snacks.id, used), /has transactions/);
  assert.throws(() => schema.removeItem(cats, food.id, used), /built in/);
  const withoutPets = schema.removeItem(cats, pets.id, new Set());
  assert.ok(!withoutPets.some((m) => m.name === 'Pets'), 'an unused custom category can be deleted');
  const withoutSnacks = schema.removeItem(cats, snacks.id, new Set());
  assert.ok(!schema.findMain(withoutSnacks, food.id).subs.some((s) => s.id === snacks.id));
});

test('reset to defaults keeps custom categories that transactions still use, switched off', () => {
  let cats = schema.defaultCategories();
  cats = schema.addMain(cats, { type: 'expense', name: 'Pets' });
  cats = schema.addMain(cats, { type: 'expense', name: 'Unused' });
  const food = cats.find((m) => m.name === 'Food');
  cats = schema.addSub(cats, food.id, { name: 'Snacks' });
  cats = schema.addSub(cats, food.id, { name: 'Unused sub' });
  cats = schema.updateItem(cats, food.id, { name: 'Eats', enabled: false });
  const pets = cats.find((m) => m.name === 'Pets');
  const snacks = schema.findMain(cats, food.id).subs.find((s) => s.name === 'Snacks');

  const reset = schema.resetToDefaults(cats, new Set([pets.id, snacks.id, food.id]));
  assert.equal(reset.find((m) => m.id === food.id).name, 'Food', 'built-ins get their names and switches back');
  assert.equal(reset.find((m) => m.id === food.id).enabled, true);
  assert.equal(reset.find((m) => m.id === pets.id).enabled, false, 'used custom main survives, hidden');
  assert.ok(!reset.some((m) => m.name === 'Unused'), 'unused custom main is dropped');
  const foodSubs = reset.find((m) => m.id === food.id).subs;
  assert.equal(foodSubs.find((s) => s.id === snacks.id).enabled, false, 'used custom sub survives, hidden');
  assert.ok(!foodSubs.some((s) => s.name === 'Unused sub'));
  assert.equal(schema.labelFor(reset, pets.id, null).main, 'Pets', 'history still resolves');
});

test('sanitizeCategories rejects damaged trees', () => {
  assert.throws(() => schema.sanitizeCategories({}), /missing/);
  const dup = schema.defaultCategories();
  dup[1].id = dup[0].id;
  assert.throws(() => schema.sanitizeCategories(dup), /twice/);
  assert.throws(() => schema.sanitizeCategories([{ id: 'x', type: 'nope', name: 'X', subs: [] }]), /valid type/);
});

/* ---------------------------------------------------------------- store */

test('totals are correct after adding, editing and deleting (savings shown apart)', () => {
  fresh();
  const summary = () => {
    const month = store.getTransactions().filter((t) => !t.deleted && t.date.startsWith('2026-09'));
    return schema.summarize(month, store.getCategories());
  };
  assert.deepEqual(summary(), { income: 0, spending: 0, savings: 0, net: 0, count: 0 });

  const salary = add('Employment Income', 'Salary / Wages', 2_000_000);
  const food = add('Food', 'Groceries', 150_000);
  const rent = add('Housing & Technology', 'Data', 50_000);
  const saved = add('Savings & Investments', 'Savings Accounts', 300_000);
  assert.deepEqual(summary(), { income: 2_000_000, spending: 200_000, savings: 300_000, net: 1_500_000, count: 4 });

  store.updateTransaction(food.id, { amount: 175_000 });
  assert.deepEqual(summary(), { income: 2_000_000, spending: 225_000, savings: 300_000, net: 1_475_000, count: 4 });

  store.updateTransaction(saved.id, { categoryId: mainOf('Food').id, subCategoryId: subOf('Food', 'Dining Out').id });
  assert.deepEqual(summary(), { income: 2_000_000, spending: 525_000, savings: 0, net: 1_475_000, count: 4 },
    're-categorising moves the amount between spending and savings');

  store.deleteTransaction(rent.id);
  assert.deepEqual(summary(), { income: 2_000_000, spending: 475_000, savings: 0, net: 1_525_000, count: 3 });
  store.restoreTransaction(rent.id);
  assert.equal(summary().spending, 525_000);

  assert.equal(salary.currency, 'UGX', 'currency is saved inside every transaction');
  const later = add('Food', null, 1000, { date: '2026-10-01' });
  assert.equal(summary().count, 4, 'other months are not counted');
  assert.equal(later.subCategoryId, null, 'a sub-category is optional');
});

test('every transaction carries a UUID, timestamps and a soft-delete flag', () => {
  fresh();
  const tx = add('Food', 'Groceries', 5000);
  assert.match(tx.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(tx.deleted, false);
  assert.ok(!Number.isNaN(Date.parse(tx.createdAt)) && tx.createdAt === tx.updatedAt);
  store.deleteTransaction(tx.id);
  const gone = store.getTransactions().find((t) => t.id === tx.id);
  assert.equal(gone.deleted, true, 'soft delete keeps the record');
  assert.ok(gone.updatedAt >= tx.updatedAt);
  assert.throws(() => store.updateTransaction(tx.id, { amount: 1 }), /no longer exists/);
});

test('validation: no floats, no bad dates, note required for "Other (Specify)"', () => {
  fresh();
  const food = mainOf('Food');
  const base = { type: 'expense', categoryId: food.id, date: '2026-09-15' };
  assert.throws(() => store.addTransaction({ ...base, amount: 12.5 }), /whole number/);
  assert.throws(() => store.addTransaction({ ...base, amount: 0 }), /above zero/);
  assert.throws(() => store.addTransaction({ ...base, amount: 100, date: '2026-02-30' }), /bad date/);
  assert.throws(() => store.addTransaction({ ...base, amount: 100, categoryId: 'nope' }), /Choose a category/);
  assert.throws(() => store.addTransaction({ ...base, amount: 100, subCategoryId: subOf('Debt Payments', 'Student Loans').id }),
    /does not belong/);
  const other = mainOf('Other Expenses');
  const otherSub = subOf('Other Expenses', 'Other (Specify)');
  const spec = { type: 'expense', amount: 100, categoryId: other.id, subCategoryId: otherSub.id, date: '2026-09-15' };
  assert.throws(() => store.addTransaction({ ...spec, note: '   ' }), /needs a description/);
  assert.equal(store.addTransaction({ ...spec, note: 'Passport photos' }).note, 'Passport photos');
  const taxes = store.addTransaction({ ...spec, subCategoryId: subOf('Other Expenses', 'Taxes').id });
  assert.throws(() => store.updateTransaction(taxes.id, { subCategoryId: otherSub.id }), /needs a description/);
});

test('persistence: data survives a reload; nothing is written until the first change', () => {
  localStorage.clear();
  store.init();
  assert.equal(localStorage.getItem('self.data'), null);
  add('Food', 'Groceries', 5000);
  const saved = JSON.parse(localStorage.getItem('self.data'));
  assert.equal(saved.schemaVersion, store.SCHEMA_VERSION);
  assert.deepEqual(Object.keys(saved).sort(),
    ['categories', 'schemaUpdatedAt', 'schemaVersion', 'settings', 'settingsUpdatedAt', 'sync', 'transactions']);
  store.init();
  assert.equal(store.getTransactions().length, 1);
});

test('storage failures are reported and the in-memory state is not corrupted', () => {
  fresh();
  add('Food', 'Groceries', 5000);
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  assert.throws(() => add('Food', 'Groceries', 7000), /storage is full/);
  localStorage.setItem = real;
  assert.equal(store.getTransactions().length, 1, 'the failed write did not leak into memory');
});

test('unreadable or newer data is parked, not destroyed', () => {
  localStorage.clear();
  localStorage.setItem('self.data', '{not json');
  assert.equal(store.init().recovered !== null, true);
  assert.equal(localStorage.getItem('self.data.corrupt'), '{not json');
  assert.equal(store.getTransactions().length, 0);

  localStorage.clear();
  localStorage.setItem('self.data', JSON.stringify({ schemaVersion: 99, transactions: [] }));
  const boot = store.init();
  assert.match(boot.recovered, /newer version/);
  assert.ok(localStorage.getItem('self.data.corrupt'));
});

test('migration: unversioned data is upgraded to the current schema', () => {
  const old = { transactions: [{ id: 'aaaaaaaa-1', type: 'expense', amount: 500, currency: 'UGX', categoryId: 'exp.food', date: '2026-01-02' }] };
  const migrated = store.migrate(old);
  assert.equal(migrated.schemaVersion, store.SCHEMA_VERSION);
  assert.equal(migrated.transactions[0].deleted, false);
  assert.throws(() => store.migrate({ schemaVersion: store.SCHEMA_VERSION + 1 }), /newer version/);
  assert.throws(() => store.migrate('nope'), /not S\.E\.L\.F/);
});

test('changing currency relabels without converting, and adjusts for decimals', () => {
  fresh();
  const a = add('Food', 'Groceries', 50_000);
  const b = add('Employment Income', 'Bonuses', 1_200_000);
  const preview = store.previewCurrencyChange('USD');
  assert.deepEqual(preview, { count: 2, rounded: 0, fromDecimals: 0, toDecimals: 2 });

  store.changeCurrency('USD');
  const byId = (id) => store.getTransactions().find((t) => t.id === id);
  assert.equal(byId(a.id).amount, 5_000_000, '50,000 UGX → 50,000.00 USD, not 500.00');
  assert.equal(money.formatMoney(byId(a.id).amount, 'USD'), '$50,000.00');
  assert.equal(byId(b.id).currency, 'USD');
  assert.equal(store.getSettings().currency, 'USD');
  assert.ok(byId(a.id).updatedAt >= a.updatedAt);

  add('Food', 'Dining Out', 1_299); // $12.99
  assert.equal(store.previewCurrencyChange('UGX').rounded, 1, 'cents that cannot survive in UGX are counted');
  store.changeCurrency('UGX');
  assert.deepEqual(store.getTransactions().map((t) => t.amount), [50_000, 1_200_000, 13]);
  assert.ok(store.getTransactions().every((t) => t.currency === 'UGX'));
});

test('soft-deleted transactions are relabelled too, so a restore never mixes currencies', () => {
  fresh();
  const tx = add('Food', 'Groceries', 1000);
  store.deleteTransaction(tx.id);
  assert.equal(store.previewCurrencyChange('USD').count, 0);
  store.changeCurrency('USD');
  store.restoreTransaction(tx.id);
  assert.deepEqual(store.getTransactions().map((t) => [t.currency, t.amount]), [['USD', 100000]]);
});

/* --------------------------------------------------------------- backup */

test('export → clear storage → import restores everything exactly', () => {
  fresh();
  store.updateSettings({ currency: 'UGX', currencyConfirmed: true, privacyMode: true, theme: 'dark' });
  let cats = store.getCategories();
  const food = mainOf('Food');
  cats = schema.addSub(cats, food.id, { name: 'Street snacks', emoji: '🌽', color: '#f97316' });
  cats = schema.updateItem(cats, subOf('Food', 'Groceries').id, { enabled: false });
  cats = schema.addMain(cats, { type: 'income', name: 'Side hustle', emoji: '🛠️' });
  store.saveCategories(cats);
  add('Food', 'Groceries', 50_000, { note: 'Naalya, "market" — café, x,y' });
  const gone = add('Food', 'Dining Out', 9_000);
  store.deleteTransaction(gone.id);
  add('Other Income', 'Other (Specify)', 1_000_000, { note: 'Refund', date: '2026-08-31' });

  const before = store.getState();
  const file = JSON.stringify(store.exportBackup());

  localStorage.clear();
  store.init();
  assert.equal(store.getTransactions().length, 0, 'storage really is empty');

  const parsed = store.parseBackup(file);
  const report = store.previewImport(parsed);
  assert.equal(report.found, 2, 'the preview counts live transactions');
  assert.equal(report.removed, 1);
  assert.equal(report.added, 3);
  assert.equal(report.customCategories, 2);
  assert.equal(report.mergeBlocked, false);
  store.applyImport(parsed, 'replace');

  const after = store.getState();
  assert.deepEqual(after.settings, { ...before.settings, currencyConfirmed: true });
  assert.deepEqual(after.categories, before.categories);
  assert.deepEqual(after.transactions, before.transactions);
  assert.equal(after.schemaUpdatedAt, before.schemaUpdatedAt, 'the tree keeps its edit time');
  // copied before sorting: getState() hands back the live document, and sorting it in place
  // would quietly reorder what the next assertion re-reads from storage
  assert.deepEqual([...after.sync.dirty].sort(), [...before.transactions.map((t) => t.id), 'schema', 'settings'].sort(),
    'and the restored ledger is queued for upload');
  store.init(); // and it persisted
  assert.deepEqual(store.getState(), after);
});

test('merge is by UUID; the newer updatedAt wins; nothing is duplicated', () => {
  fresh();
  const a = add('Food', 'Groceries', 1000);
  const b = add('Food', 'Groceries', 2000);
  const backupText = JSON.stringify(store.exportBackup());

  store.updateTransaction(a.id, { amount: 1111 });          // local is newer than the backup
  const backup = JSON.parse(backupText);
  backup.transactions.find((t) => t.id === b.id).amount = 2222;
  backup.transactions.find((t) => t.id === b.id).updatedAt = new Date(Date.now() + 60_000).toISOString(); // backup newer
  const extra = { ...backup.transactions[0], id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', amount: 3333 };
  backup.transactions.push(extra);

  const parsed = store.parseBackup(JSON.stringify(backup));
  const report = store.previewImport(parsed);
  assert.deepEqual([report.added, report.updated, report.same], [1, 1, 1]);
  store.applyImport(parsed, 'merge');

  const amounts = Object.fromEntries(store.getTransactions().map((t) => [t.id, t.amount]));
  assert.deepEqual(amounts, { [a.id]: 1111, [b.id]: 2222, [extra.id]: 3333 });
  store.applyImport(parsed, 'merge');
  assert.equal(store.getTransactions().length, 3, 're-importing the same file adds nothing');
});

test('merge brings in custom categories the backup needs', () => {
  fresh();
  const cats = schema.addMain(store.getCategories(), { type: 'expense', name: 'Pets' });
  store.saveCategories(cats);
  const pets = cats.find((m) => m.name === 'Pets');
  store.addTransaction({ type: 'expense', amount: 5000, categoryId: pets.id, date: '2026-09-01' });
  const file = JSON.stringify(store.exportBackup());

  fresh(); // a second device that has never heard of "Pets"
  store.applyImport(store.parseBackup(file), 'merge');
  assert.equal(schema.labelFor(store.getCategories(), pets.id, null).main, 'Pets');
  assert.equal(store.getTransactions().length, 1);
});

test('merge refuses to mix currencies; an empty device adopts the backup currency', () => {
  fresh();
  store.changeCurrency('USD');
  add('Food', 'Groceries', 1000);
  const usdFile = JSON.stringify(store.exportBackup());

  fresh();
  add('Food', 'Groceries', 5000); // UGX data on this device
  const parsed = store.parseBackup(usdFile);
  const report = store.previewImport(parsed);
  assert.equal(report.mergeBlocked, true);
  assert.throws(() => store.applyImport(parsed, 'merge'), /uses UGX/);
  store.applyImport(parsed, 'replace');
  assert.equal(store.getSettings().currency, 'USD');

  fresh(); // empty device
  store.applyImport(parsed, 'merge');
  assert.equal(store.getSettings().currency, 'USD');
});

test('import validation: bad files are refused, bad records are skipped and counted', () => {
  fresh();
  assert.throws(() => store.parseBackup('nope'), /not valid JSON/);
  assert.throws(() => store.parseBackup('[]'), /does not look like/);
  assert.throws(() => store.parseBackup('{"transactions":{}}'), /does not look like/);
  assert.throws(() => store.parseBackup('{"app":"Other","transactions":[]}'), /different app/);
  assert.throws(() => store.parseBackup(JSON.stringify({ schemaVersion: store.SCHEMA_VERSION + 1, transactions: [] })), /newer version/);
  assert.throws(() => store.parseBackup(JSON.stringify({ transactions: [], categories: [{ id: 'x', type: 'bad' }] })), /damaged/);

  const good = add('Food', 'Groceries', 1000);
  const file = store.exportBackup();
  file.transactions.push(
    { ...good, id: 'bbbbbbbb-1', amount: 12.5 },
    { ...good, id: 'bbbbbbbb-2', date: '2026-13-01' },
    { ...good, id: 'bbbbbbbb-3', currency: 'EUR' },
    { ...good },
    'junk',
  );
  const parsed = store.parseBackup(JSON.stringify(file));
  assert.equal(parsed.backup.transactions.length, 1);
  assert.equal(parsed.skipped.length, 5);
  assert.equal(store.previewImport(parsed).skipped, 5);
});

test('CSV export: the six columns, plain amounts, escaping, and formula defusing', () => {
  fresh();
  add('Food', 'Groceries', 50_000, { note: 'Milk, "fresh"\nand bread', date: '2026-09-02' });
  add('Employment Income', 'Salary / Wages', 2_000_000, { date: '2026-09-01' });
  add('Other Expenses', 'Other (Specify)', 7_000, { note: '=HYPERLINK("http://x")', date: '2026-09-03' });
  const gone = add('Food', 'Dining Out', 1, { date: '2026-09-04' });
  store.deleteTransaction(gone.id);

  const csv = buildCsv(store.getState());
  assert.ok(csv.startsWith('﻿date,type,main category,sub-category,amount,note\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[1], '2026-09-01,Income,Employment Income,Salary / Wages,2000000,');
  assert.equal(lines[2], '2026-09-02,Expense,Food,Groceries,50000,"Milk, ""fresh""\nand bread"');
  assert.equal(lines[3], `2026-09-03,Expense,Other Expenses,Other (Specify),7000,"'=HYPERLINK(""http://x"")"`);
  assert.ok(!csv.includes('Dining Out'), 'deleted transactions are not exported');

  store.changeCurrency('USD');
  assert.ok(buildCsv(store.getState()).includes('2026-09-01,Income,Employment Income,Salary / Wages,2000000.00,'));
});
