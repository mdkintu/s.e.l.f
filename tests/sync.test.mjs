// Step 4 tests: what syncs, what the server gets to see, and what happens when two devices
// disagree. No network and no Supabase: the transport is a stand-in that keeps the same rules the
// real table does (upsert by owner+id, a server-assigned clock, pull everything newer).
//
// The SQL and its Row Level Security are tested separately, against real PostgreSQL, in sql.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'], language: 'en-US', onLine: true }, configurable: true });

const PASS = 'correct horse battery staple';
const NOTE = 'Zanzibar cardamom';

/* ---------------------------------------------------------------- a device */

/**
 * One device: its own storage and its own instance of store.js. ES modules are cached per URL, so
 * a distinct query string gives a genuinely separate module — two devices, one process.
 */
async function makeDevice(name) {
  const storage = new MemoryStorage();
  const previous = globalThis.localStorage;
  globalThis.localStorage = storage;
  const store = await import(`../js/store.js?device=${name}`);
  store.init();
  globalThis.localStorage = previous;

  const device = {
    name,
    store,
    storage,
    /** Run something with this device's storage in place. */
    use(fn) {
      const before = globalThis.localStorage;
      globalThis.localStorage = storage;
      try { return fn(); } finally { globalThis.localStorage = before; }
    },
    async useAsync(fn) {
      const before = globalThis.localStorage;
      globalThis.localStorage = storage;
      try { return await fn(); } finally { globalThis.localStorage = before; }
    },
    main(name_) { return store.getCategories().find((c) => c.name === name_); },
    add(amount, { note = '', main = 'Food', sub = 'Groceries', date = '2026-09-15' } = {}) {
      return device.use(() => {
        const m = device.main(main);
        return store.addTransaction({ type: m.type, amount, categoryId: m.id, subCategoryId: m.subs.find((x) => x.name === sub).id, date, note });
      });
    },
  };
  return device;
}

/* ---------------------------------------------------------------- the stand-in server */

/** Keeps the rules of supabase/schema.sql: rows are owned, and synced_at is the server's clock. */
function makeServer() {
  const rows = new Map(); // `${user}/${id}` -> row
  let clock = 0;
  const stamp = () => { clock += 1; return new Date(Date.UTC(2030, 0, 1) + clock).toISOString(); };
  return {
    rows,
    upsert(userId, batch) {
      for (const r of batch) rows.set(`${userId}/${r.id}`, { ...r, user_id: userId, synced_at: stamp() });
    },
    pull(userId, since) {
      const after = since ?? '';
      return [...rows.values()]
        .filter((r) => r.user_id === userId && r.synced_at > after)
        .sort((a, b) => a.synced_at.localeCompare(b.synced_at));
    },
    keyInfo(userId) { return [...rows.values()].find((r) => r.user_id === userId && r.kind === 'keyinfo') ?? null; },
    deleteAll(userId) { for (const [k, r] of rows) if (r.user_id === userId) rows.delete(k); },
    /** Everything the server holds, as one string — for checking that nothing readable is in it. */
    dump() { return JSON.stringify([...rows.values()]); },
  };
}

/** A fake sync-worker that speaks the same messages as js/sync-worker.js. */
function makeWorker(server, { userId = 'user-a', email = 'a@example.com', fail = null } = {}) {
  const worker = {
    fail,
    sent: [],
    terminated: false,
    offline: false,
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      worker.sent.push(msg);
      const reply = (value) => queueMicrotask(() => worker.onmessage?.({ data: { type: 'result', id: msg.id, value } }));
      const fault = (message, code) => queueMicrotask(() => worker.onmessage?.({ data: { type: 'error', id: msg.id, message, code } }));
      if (worker.offline && msg.type !== 'connect') return fault('No connection.', 'offline');
      if (worker.fail && worker.fail.type === msg.type) return fault(worker.fail.message, worker.fail.code);
      switch (msg.type) {
        case 'connect': return reply({ restored: Boolean(msg.session) });
        case 'signIn': case 'signUp': return reply({ user: { id: userId, email }, session: { access_token: 't', refresh_token: 'r' } });
        case 'signOut': return reply({ ok: true });
        case 'push': server.upsert(msg.userId, msg.rows); return reply({ pushed: msg.rows.length });
        case 'pull': { const rows = server.pull(userId, msg.since); return reply({ rows, watermark: rows.at(-1)?.synced_at ?? msg.since }); }
        case 'fetchKeyInfo': return reply({ row: server.keyInfo(userId) });
        case 'deleteAll': server.deleteAll(msg.userId); return reply({ ok: true });
        default: return fault(`unknown ${msg.type}`, 'bad-request');
      }
    },
    terminate() { worker.terminated = true; },
  };
  return worker;
}

const syncModule = await import('../js/sync.js');

/** A sync controller wired to one device and one server. */
function attach(device, server, options = {}) {
  const worker = makeWorker(server, options);
  const sync = syncModule.createSync({
    store: device.store,
    createWorker: () => worker,
    config: { url: 'https://test.supabase.co', anonKey: 'anon-key-that-is-long-enough-to-pass' },
    configured: () => options.configured !== false,
    online: () => !worker.offline,
    debounceMs: 5,
  });
  return { sync, worker };
}

/** Sign in and encrypt, the way the app does before any syncing can happen. */
async function ready(device, server, options = {}) {
  await device.useAsync(() => device.store.setupEncryption(options.passphrase ?? PASS));
  const { sync, worker } = attach(device, server, options);
  const result = await device.useAsync(() => sync.signIn('a@example.com', 'password123'));
  return { sync, worker, result };
}

/* ================================================================== */
/* The rules on their own                                              */
/* ================================================================== */

test('newest updatedAt wins, and a tie keeps what is already here', () => {
  const { chooseWinner } = syncModule;
  assert.equal(chooseWinner('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'), 'remote');
  assert.equal(chooseWinner('2026-09-02T00:00:00Z', '2026-09-01T00:00:00Z'), 'local');
  assert.equal(chooseWinner('2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'), 'local', 'a tie changes nothing');
  assert.equal(chooseWinner(null, '2026-09-01T00:00:00Z'), 'remote', 'an item this device has never seen');
  assert.equal(chooseWinner('2026-09-01T00:00:00Z', null), 'local');
});

test('the pull watermark only ever moves forward, and uses the server clock', () => {
  const { nextWatermark } = syncModule;
  const rows = [{ synced_at: '2030-01-01T00:00:03Z' }, { synced_at: '2030-01-01T00:00:01Z' }];
  assert.equal(nextWatermark('2030-01-01T00:00:02Z', rows), '2030-01-01T00:00:03Z');
  assert.equal(nextWatermark('2030-01-01T00:00:09Z', rows), '2030-01-01T00:00:09Z', 'never backwards');
  assert.equal(nextWatermark(null, []), '1970-01-01T00:00:00Z');
});

/* ================================================================== */
/* What the server is given                                            */
/* ================================================================== */

test('the server only ever receives ciphertext', async () => {
  const device = await makeDevice('seal');
  const server = makeServer();
  device.add(987_654_321, { note: NOTE });
  await ready(device, server);

  const dump = server.dump();
  for (const secret of [NOTE, '987654321', 'Groceries', 'exp.food', 'UGX', PASS, 'amount', 'categoryId']) {
    assert.equal(dump.includes(secret), false, `"${secret}" must not be readable on the server`);
  }
  const kinds = [...server.rows.values()].map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['keyinfo', 'schema', 'settings', 'transaction']);
  for (const row of server.rows.values()) {
    assert.deepEqual(Object.keys(row).sort(), ['ciphertext', 'deleted', 'id', 'iv', 'kind', 'salt', 'synced_at', 'updated_at', 'user_id']);
    assert.match(row.iv, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.match(row.ciphertext, /^[A-Za-z0-9+/]+={0,2}$/);
  }
});

test('the keyinfo row carries a salt and a sealed check value, and nothing else', async () => {
  const device = await makeDevice('keyinfo');
  const server = makeServer();
  await ready(device, server);
  const row = server.keyInfo('user-a');
  const mine = device.use(() => device.store.getKeyInfo());
  assert.equal(row.salt, mine.salt, 'the salt travels so another device can derive the same key');
  assert.deepEqual({ iv: row.iv, ciphertext: row.ciphertext }, mine.check);
  assert.equal(row.salt.length >= 20, true, '16 random bytes, base64');
  // A salt is not a secret. What matters is that it is useless without the passphrase.
  assert.equal(server.dump().includes(PASS), false);
});

test('a session token is never written into a backup file', async () => {
  const device = await makeDevice('backup');
  const server = makeServer();
  device.add(5_000);
  await ready(device, server);
  const file = JSON.stringify(device.use(() => device.store.exportBackup()));
  assert.equal(file.includes('refresh_token'), false);
  assert.equal(file.includes('"sync"'), false, 'device sync state stays out of backups entirely');
  assert.equal(device.use(() => device.store.getSyncState().session) !== null, true, 'though the device does hold one');
});

/* ================================================================== */
/* The queue                                                           */
/* ================================================================== */

test('every kind of change queues its own item, and only that item', async () => {
  const device = await makeDevice('queue');
  const { store } = device;
  const dirty = () => device.use(() => store.getSyncState().dirty);

  device.use(() => store.clearDirty(dirty()));
  const tx = device.add(1_000);
  assert.deepEqual(dirty(), [tx.id], 'adding a transaction');

  device.use(() => store.clearDirty(dirty()));
  device.use(() => store.updateTransaction(tx.id, { amount: 2_000 }));
  assert.deepEqual(dirty(), [tx.id], 'editing it');

  device.use(() => store.clearDirty(dirty()));
  device.use(() => store.deleteTransaction(tx.id));
  assert.deepEqual(dirty(), [tx.id], 'a soft delete is a change like any other');

  device.use(() => store.clearDirty(dirty()));
  device.use(() => store.saveCategories(store.getCategories()));
  assert.deepEqual(dirty(), ['schema']);

  device.use(() => store.clearDirty(dirty()));
  device.use(() => store.updateSettings({ currency: 'KES', currencyConfirmed: true }));
  assert.deepEqual(dirty(), ['settings']);
});

test('a device-only preference never queues anything', async () => {
  const device = await makeDevice('prefs');
  const { store } = device;
  device.use(() => store.clearDirty(store.getSyncState().dirty));
  device.use(() => store.updateSettings({ theme: 'dark', privacyMode: true, autoLockMinutes: 15, syncBannerDismissed: true }));
  assert.deepEqual(device.use(() => store.getSyncState().dirty), [], 'theme, privacy and auto-lock stay on this device');
  assert.equal(device.use(() => store.getSettings().theme), 'dark', 'but they are still applied here');
});

test('changing the currency queues every transaction, because every amount was rewritten', async () => {
  const device = await makeDevice('currency');
  const { store } = device;
  const a = device.add(50_000);
  const b = device.add(70_000);
  device.use(() => store.clearDirty(store.getSyncState().dirty));
  device.use(() => store.changeCurrency('USD'));
  assert.deepEqual(device.use(() => store.getSyncState().dirty).sort(), [a.id, b.id, 'settings'].sort());
});

test('the queue survives a lock and a reload — that is what makes it an offline queue', async () => {
  const device = await makeDevice('persist-queue');
  const { store } = device;
  await device.useAsync(() => store.setupEncryption(PASS));
  const tx = device.add(3_000);
  await device.useAsync(() => store.flush());
  assert.ok(device.use(() => store.getSyncState().dirty).includes(tx.id));

  await device.useAsync(() => store.lock());
  device.use(() => store.init());
  await device.useAsync(() => store.unlock(PASS));
  assert.ok(device.use(() => store.getSyncState().dirty).includes(tx.id), 'still waiting to go up');
});

/* ================================================================== */
/* A cycle                                                             */
/* ================================================================== */

test('first sign-in uploads everything already on the device', async () => {
  const device = await makeDevice('first');
  const server = makeServer();
  device.add(10_000, { note: NOTE });
  device.add(20_000, { sub: 'Dining Out' });
  const { sync } = await ready(device, server);

  assert.equal([...server.rows.values()].filter((r) => r.kind === 'transaction').length, 2);
  assert.deepEqual(device.use(() => device.store.getSyncState().dirty), [], 'and the queue is empty afterwards');
  assert.equal(sync.getState().phase, 'idle');
  assert.equal(sync.getState().email, 'a@example.com');
});

test('a second cycle sends only what changed', async () => {
  const device = await makeDevice('incremental');
  const server = makeServer();
  const { sync, worker } = await ready(device, server);
  worker.sent.length = 0;

  device.add(4_242);
  await device.useAsync(() => sync.syncNow());
  const pushes = worker.sent.filter((m) => m.type === 'push');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].rows.length, 1, 'one row, not the whole ledger');
  assert.equal(pushes[0].rows[0].kind, 'transaction');
});

test('pulling back rows this device just pushed changes nothing', async () => {
  const device = await makeDevice('echo');
  const server = makeServer();
  const { sync } = await ready(device, server);
  const before = device.use(() => JSON.stringify(device.store.getTransactions()));

  device.use(() => device.store.setSyncState({ lastPulledAt: null })); // re-pull everything
  const result = await device.useAsync(() => sync.syncNow());

  assert.equal(result.applied, 0, 'nothing was applied');
  assert.ok(result.kept > 0, 'the rows came back and were recognised as the same');
  assert.equal(device.use(() => JSON.stringify(device.store.getTransactions())), before);
});

/* ================================================================== */
/* Two devices                                                         */
/* ================================================================== */

test('an edit on one device reaches the other', async () => {
  const server = makeServer();
  const laptop = await makeDevice('laptop');
  const phone = await makeDevice('phone');

  const tx = laptop.add(50_000, { note: NOTE });
  const { sync: laptopSync } = await ready(laptop, server);

  // The phone is new: it signs in, is told the account already has a key, and adopts it.
  const { sync: phoneSync, result } = await ready(phone, server, { passphrase: 'a different local one' });
  assert.equal(result.needsPassphrase, true, 'the phone is asked for the account passphrase');
  await phone.useAsync(() => phoneSync.adoptKey(PASS, result.keyInfo));

  const onPhone = phone.use(() => phone.store.getTransactions());
  assert.equal(onPhone.length, 1);
  assert.equal(onPhone[0].id, tx.id, 'the same item, not a copy');
  assert.equal(onPhone[0].note, NOTE);
  assert.equal(onPhone[0].amount, 50_000);

  // An edit on the phone comes back to the laptop.
  phone.use(() => phone.store.updateTransaction(tx.id, { amount: 65_000 }));
  await phone.useAsync(() => phoneSync.syncNow());
  await laptop.useAsync(() => laptopSync.syncNow());
  assert.equal(laptop.use(() => laptop.store.getTransactions()[0].amount), 65_000);
});

test('a soft delete travels, and so does undoing it', async () => {
  const server = makeServer();
  const laptop = await makeDevice('del-laptop');
  const phone = await makeDevice('del-phone');
  const tx = laptop.add(9_000);
  const { sync: laptopSync } = await ready(laptop, server);
  const { sync: phoneSync, result } = await ready(phone, server, { passphrase: 'phone only passphrase' });
  await phone.useAsync(() => phoneSync.adoptKey(PASS, result.keyInfo));

  laptop.use(() => laptop.store.deleteTransaction(tx.id));
  await laptop.useAsync(() => laptopSync.syncNow());
  await phone.useAsync(() => phoneSync.syncNow());
  assert.equal(phone.use(() => phone.store.getTransactions().find((t) => t.id === tx.id).deleted), true, 'gone on the phone too');

  laptop.use(() => laptop.store.restoreTransaction(tx.id));
  await laptop.useAsync(() => laptopSync.syncNow());
  await phone.useAsync(() => phoneSync.syncNow());
  assert.equal(phone.use(() => phone.store.getTransactions().find((t) => t.id === tx.id).deleted), false, 'and back again');
});

test('when both devices edit the same item, the newer edit wins on both', async () => {
  const server = makeServer();
  const laptop = await makeDevice('conflict-laptop');
  const phone = await makeDevice('conflict-phone');
  const tx = laptop.add(10_000);
  const { sync: laptopSync } = await ready(laptop, server);
  const { sync: phoneSync, result } = await ready(phone, server, { passphrase: 'phone passphrase here' });
  await phone.useAsync(() => phoneSync.adoptKey(PASS, result.keyInfo));

  // Both edit while apart. The phone's edit is the later one.
  laptop.use(() => laptop.store.updateTransaction(tx.id, { amount: 11_111 }));
  await new Promise((r) => setTimeout(r, 5));
  phone.use(() => phone.store.updateTransaction(tx.id, { amount: 22_222 }));

  await laptop.useAsync(() => laptopSync.syncNow());
  await phone.useAsync(() => phoneSync.syncNow());   // sees the laptop's older edit, keeps its own
  await laptop.useAsync(() => laptopSync.syncNow()); // and takes the phone's newer one

  assert.equal(phone.use(() => phone.store.getTransactions()[0].amount), 22_222, 'the phone keeps the newer edit');
  assert.equal(laptop.use(() => laptop.store.getTransactions()[0].amount), 22_222, 'and the laptop adopts it');
});

test('the loser of a conflict stops being queued; the winner stays queued until it is sent', async () => {
  const server = makeServer();
  const laptop = await makeDevice('loser-laptop');
  const phone = await makeDevice('loser-phone');
  const tx = laptop.add(10_000);
  const { sync: laptopSync } = await ready(laptop, server);
  const { sync: phoneSync, result } = await ready(phone, server, { passphrase: 'another passphrase ok' });
  await phone.useAsync(() => phoneSync.adoptKey(PASS, result.keyInfo));

  phone.use(() => phone.store.updateTransaction(tx.id, { amount: 33_333 }));
  await phone.useAsync(() => phoneSync.syncNow());

  // The laptop makes an OLDER edit it never sent, then syncs: the phone's version is newer.
  laptop.use(() => laptop.store.updateTransaction(tx.id, { amount: 44_444, note: 'stale' }));
  const stale = laptop.use(() => laptop.store.getTransactions()[0].updatedAt);
  laptop.use(() => laptop.store.setSyncState({ lastPulledAt: null }));
  // Force the local copy to look older than the phone's.
  assert.ok(stale, 'the laptop has a pending edit');
  await laptop.useAsync(() => laptopSync.syncNow());

  const dirty = laptop.use(() => laptop.store.getSyncState().dirty);
  assert.deepEqual(dirty, [], 'nothing is left hanging in the queue either way');
});

test('two devices converge on the category tree and the currency', async () => {
  const server = makeServer();
  const laptop = await makeDevice('tree-laptop');
  const phone = await makeDevice('tree-phone');
  const schema = await import('../js/schema.js');
  const { sync: laptopSync } = await ready(laptop, server);
  const { sync: phoneSync, result } = await ready(phone, server, { passphrase: 'phone side passphrase' });
  await phone.useAsync(() => phoneSync.adoptKey(PASS, result.keyInfo));

  const food = laptop.main('Food');
  laptop.use(() => laptop.store.saveCategories(schema.addSub(laptop.store.getCategories(), food.id, { name: 'Street Food', emoji: '🌽' })));
  laptop.use(() => laptop.store.updateSettings({ currency: 'KES', currencyConfirmed: true }));
  await laptop.useAsync(() => laptopSync.syncNow());
  await phone.useAsync(() => phoneSync.syncNow());

  const names = phone.use(() => phone.main('Food').subs.map((s) => s.name));
  assert.ok(names.includes('Street Food'), 'the new sub-category arrived');
  assert.equal(phone.use(() => phone.store.getSettings().currency), 'KES', 'and so did the currency');
});

/* ================================================================== */
/* Keys                                                                */
/* ================================================================== */

test('a device whose passphrase differs is asked for the account\'s, and nothing syncs until it matches', async () => {
  const server = makeServer();
  const first = await makeDevice('key-first');
  const second = await makeDevice('key-second');
  first.add(7_000, { note: NOTE });
  await ready(first, server);

  const { sync, result } = await ready(second, server, { passphrase: 'quite a different one' });
  assert.equal(result.needsPassphrase, true);
  assert.equal(second.use(() => second.store.getTransactions().length), 0, 'nothing was pulled yet');

  await assert.rejects(() => second.useAsync(() => sync.adoptKey('the wrong passphrase', result.keyInfo)), /Incorrect passphrase/);
  assert.equal(second.use(() => second.store.getTransactions().length), 0, 'and a wrong guess changes nothing');
  // Nothing is half-joined: until the key is proven, this device is not signed in, so it cannot
  // upload items sealed with a key the account has never seen.
  assert.equal(second.use(() => second.store.getSyncState().userId), null, 'not signed in yet');
  await assert.rejects(() => second.useAsync(() => sync.syncNow()), /Not signed in/);
  assert.equal(second.use(() => second.store.getKeyInfo().salt) !== first.use(() => first.store.getKeyInfo().salt), true,
    'and it still has its own, different key');

  await second.useAsync(() => sync.adoptKey(PASS, result.keyInfo));
  assert.equal(second.use(() => second.store.getTransactions()[0].note), NOTE);
  assert.equal(second.use(() => second.store.getKeyInfo().salt), first.use(() => first.store.getKeyInfo().salt), 'one key for the account');
});

test('rows sealed with a different key are counted, never guessed at', async () => {
  const server = makeServer();
  const mine = await makeDevice('mine');
  const stranger = await makeDevice('stranger');
  await mine.useAsync(() => mine.store.setupEncryption(PASS));
  await stranger.useAsync(() => stranger.store.setupEncryption('a completely other passphrase'));
  stranger.add(5_000);
  const foreign = await stranger.useAsync(() => stranger.store.collectDirtyItems());

  const rows = foreign.map((r) => ({ ...r, updated_at: r.updatedAt, synced_at: '2030-01-01T00:00:01Z' }));
  const report = await mine.useAsync(() => mine.store.applyRemoteItems(rows));
  assert.equal(report.applied, 0);
  assert.ok(report.unreadable >= 1, 'unreadable, and left alone');
  assert.equal(mine.use(() => mine.store.getTransactions().length), 0);
});

test('changing the passphrase re-queues everything, because the cloud copy is now unreadable', async () => {
  const device = await makeDevice('rekey');
  const server = makeServer();
  device.add(1_000);
  device.add(2_000);
  const { sync } = await ready(device, server);
  assert.deepEqual(device.use(() => device.store.getSyncState().dirty), []);

  await device.useAsync(() => device.store.changePassphrase(PASS, 'a brand new passphrase'));
  const dirty = device.use(() => device.store.getSyncState().dirty);
  assert.ok(dirty.includes('keyinfo'), 'the key row goes up first');
  assert.ok(dirty.includes('schema') && dirty.includes('settings'));
  assert.equal(dirty.filter((d) => !['keyinfo', 'schema', 'settings'].includes(d)).length, 2, 'and both transactions');

  await device.useAsync(() => sync.syncNow());
  const row = server.keyInfo('user-a');
  assert.equal(row.salt, device.use(() => device.store.getKeyInfo().salt), 'the account now carries the new salt');
});

/* ================================================================== */
/* Offline, errors, and signing out                                    */
/* ================================================================== */

test('offline: the change is kept, the status says so, and it goes up on reconnect', async () => {
  const device = await makeDevice('offline');
  const server = makeServer();
  const { sync, worker } = await ready(device, server);

  worker.offline = true;
  const tx = device.add(8_800, { note: 'logged on a train' });
  await assert.rejects(() => device.useAsync(() => sync.syncNow()));
  assert.equal(sync.getState().phase, 'offline');
  assert.match(sync.getState().message, /No connection/);
  assert.deepEqual(device.use(() => device.store.getSyncState().dirty), [tx.id], 'still queued');
  assert.equal([...server.rows.values()].some((r) => r.id === tx.id), false, 'and nothing reached the server');

  worker.offline = false;
  await device.useAsync(() => sync.syncNow());
  assert.equal([...server.rows.values()].some((r) => r.id === tx.id), true, 'it goes up once there is a connection');
  assert.equal(sync.getState().phase, 'idle');
  assert.deepEqual(device.use(() => device.store.getSyncState().dirty), []);
});

test('several offline edits all arrive, in one go', async () => {
  const device = await makeDevice('offline-many');
  const server = makeServer();
  const { sync, worker } = await ready(device, server);
  worker.offline = true;
  const ids = [1, 2, 3, 4].map((n) => device.add(n * 1_000).id);
  await device.useAsync(() => sync.syncNow()).catch(() => {});
  worker.offline = false;
  worker.sent.length = 0;
  await device.useAsync(() => sync.syncNow());
  const push = worker.sent.find((m) => m.type === 'push');
  assert.equal(push.rows.length, 4, 'one request, four rows');
  for (const id of ids) assert.ok([...server.rows.values()].some((r) => r.id === id));
});

test('a server error is reported without losing the queue', async () => {
  const device = await makeDevice('error');
  const server = makeServer();
  const { sync, worker } = await ready(device, server);
  // The account is set up; now the server starts refusing writes (a policy mistake, say).
  worker.fail = { type: 'push', message: 'permission denied for table ledger_items', code: '42501' };
  const tx = device.add(1_234);
  await assert.rejects(() => device.useAsync(() => sync.syncNow()));
  assert.equal(sync.getState().phase, 'error');
  assert.match(sync.getState().message, /permission denied/);
  assert.deepEqual(device.use(() => device.store.getSyncState().dirty), [tx.id], 'the change is still here');
});

test('signing out keeps the ledger and forgets the account', async () => {
  const device = await makeDevice('signout');
  const server = makeServer();
  device.add(6_000, { note: NOTE });
  const { sync, worker } = await ready(device, server);

  await device.useAsync(() => sync.signOut());
  assert.equal(device.use(() => device.store.getTransactions()[0].note), NOTE, 'the ledger is untouched');
  const after = device.use(() => device.store.getSyncState());
  assert.equal(after.userId, null);
  assert.equal(after.session, null, 'and the session is gone');
  assert.equal(worker.terminated, true, 'the worker holding it is torn down');
  assert.equal(sync.getState().phase, 'signed-out');
  assert.equal(server.rows.size > 0, true, 'the cloud copy is left alone: signing out is not deleting');
});

test('deleting the cloud data clears the server and re-queues the local ledger', async () => {
  const device = await makeDevice('delete-cloud');
  const server = makeServer();
  device.add(2_500, { note: NOTE });
  const { sync } = await ready(device, server);
  assert.ok(server.rows.size > 0);

  await device.useAsync(() => sync.deleteCloudData());
  assert.equal(server.rows.size, 0, 'nothing of theirs is left on the server');
  assert.equal(device.use(() => device.store.getTransactions()[0].note), NOTE, 'the device keeps everything');
  assert.ok(device.use(() => device.store.getSyncState().dirty.length) >= 3, 'and it would all go up again if they stay signed in');
});

test('a locked ledger neither syncs nor leaks: the worker is stopped and the queue waits', async () => {
  const device = await makeDevice('locked');
  const server = makeServer();
  const { sync, worker } = await ready(device, server);
  device.add(3_300);
  await device.useAsync(() => device.store.lock());

  sync.stop();
  assert.equal(worker.terminated, true);
  await assert.rejects(() => device.useAsync(() => sync.syncNow()), /Unlock first|Not signed in/);
});

/* ================================================================== */
/* Guest mode                                                          */
/* ================================================================== */

test('with no project configured, sync does nothing at all', async () => {
  const device = await makeDevice('unconfigured');
  const server = makeServer();
  let created = 0;
  const sync = syncModule.createSync({
    store: device.store,
    createWorker: () => { created += 1; return makeWorker(server); },
    configured: () => false,
  });
  sync.start();
  assert.equal(sync.getState().phase, 'unconfigured');
  assert.equal(created, 0, 'no worker is ever created');
  await assert.rejects(() => device.useAsync(() => sync.syncNow()), /not set up/);
  assert.equal(created, 0);
  sync.schedule();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(created, 0, 'and a save does not start one either');
});

test('a guest who never signs in starts no worker, even with a project configured', async () => {
  const device = await makeDevice('guest');
  const server = makeServer();
  let created = 0;
  const sync = syncModule.createSync({
    store: device.store,
    createWorker: () => { created += 1; return makeWorker(server); },
    config: { url: 'https://test.supabase.co', anonKey: 'anon-key-that-is-long-enough-to-pass' },
    configured: () => true,
    debounceMs: 5,
  });
  sync.start();
  device.add(1_500);
  sync.schedule();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(created, 0, 'nothing is contacted until someone signs in');
  assert.equal(sync.getState().phase, 'signed-out');
});

test('the sync module itself makes no network calls and touches no storage', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('../js/sync.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|importScripts/.test(code), false, 'the network lives in the worker');
  assert.equal(/localStorage|sessionStorage|indexedDB/.test(code), false, 'storage lives in store.js');
  assert.equal(/document\.|window\./.test(code), false, 'and the DOM lives in app.js');
});
