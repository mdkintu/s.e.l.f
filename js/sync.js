// sync.js — deciding WHAT to sync and WHEN. No network here (that is sync-worker.js) and no DOM.
//
// THE RULES, in one place:
//   • An item is a transaction, the category tree ('schema'), or the synced settings ('settings').
//   • Every change marks its item dirty, in the encrypted document. That IS the offline queue: it
//     survives a reload, a lock and a closed laptop, and it does not depend on any clock.
//   • A cycle pushes every dirty item, then pulls everything the server has seen since last time.
//   • Conflicts are resolved per item, newest updatedAt wins. A local item that loses is replaced;
//     a local item that wins stays dirty and goes up on the next push.
//   • Deletes are soft, so they sync like any other change.
//
// Nothing here ever sees a plaintext amount: store.js hands over sealed rows and takes sealed rows
// back, so the key and the ledger stay behind that one door.

import { SUPABASE, TABLE, PAGE_SIZE, isConfigured } from './sync-config.js';

export class SyncError extends Error {
  constructor(message, code = 'error') { super(message); this.code = code; }
}

/** How long to wait after a change before syncing, so a burst of edits is one round trip. */
export const DEBOUNCE_MS = 2500;
/** Retry delays after a failed cycle: back off, then keep trying every couple of minutes. */
export const RETRY_MS = [5_000, 15_000, 60_000, 120_000];

/* ================================================================== */
/* Merge rules (pure, so they can be tested on their own)              */
/* ================================================================== */

/**
 * Which version of an item to keep. Newest `updatedAt` wins; ties keep what is already here, so a
 * cycle that pulls back the rows it just pushed changes nothing.
 * → 'remote' | 'local'
 */
export function chooseWinner(localUpdatedAt, remoteUpdatedAt) {
  if (!localUpdatedAt) return 'remote';
  if (!remoteUpdatedAt) return 'local';
  return remoteUpdatedAt > localUpdatedAt ? 'remote' : 'local';
}

/** The next pull watermark: the newest server clock we have actually seen. */
export function nextWatermark(current, rows) {
  return rows.reduce((max, r) => (r.synced_at > max ? r.synced_at : max), current ?? '1970-01-01T00:00:00Z');
}

/* ================================================================== */
/* The controller                                                      */
/* ================================================================== */

/**
 * @param store       the store.js module (the only thing that holds the key)
 * @param createWorker so tests can hand in a stand-in for sync-worker.js
 * @param config      so tests can point at a local server instead of Supabase
 */
export function createSync({
  store,
  createWorker = () => new Worker(new URL('./sync-worker.js', import.meta.url)),
  config = SUPABASE,
  table = TABLE,
  pageSize = PAGE_SIZE,
  configured = isConfigured,
  online = () => globalThis.navigator?.onLine !== false,
  debounceMs = DEBOUNCE_MS,
} = {}) {
  let worker = null;
  let connected = false;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  let state = { phase: 'unconfigured', email: null, lastSyncAt: null, queued: 0, message: '' };
  let debounceTimer = 0;
  let retryTimer = 0;
  let retries = 0;
  let running = null;
  // A signed-in account whose key this device does not have yet. Held here, NOT written to the
  // store, so a device that never gets the passphrase right is simply not signed in.
  let pendingAccount = null;

  const emit = () => { for (const fn of listeners) fn(state); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  /* ---------- the worker bridge ---------- */

  function handle(message) {
    if (message.type === 'session') {
      // Supabase refreshed the tokens. They belong in the encrypted vault, not on disk.
      if (store.isLocked()) return;
      try { store.setSyncState({ session: message.session }); } catch { /* locked mid-flight */ }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === 'result') entry.resolve(message.value);
    else entry.reject(new SyncError(message.message, message.code));
  }

  function failAll(error) {
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  }

  function ask(type, payload = {}) {
    if (!worker) {
      worker = createWorker();
      worker.onmessage = (e) => handle(e.data);
      worker.onerror = () => {
        const error = new SyncError('The sync worker stopped unexpectedly.', 'worker');
        failAll(error);
        worker?.terminate();
        worker = null;
        connected = false;
      };
      worker.onmessageerror = worker.onerror;
    }
    const id = nextId;
    nextId += 1;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    worker.postMessage({ type, id, ...payload });
    return promise;
  }

  async function ensureConnected() {
    if (!configured()) throw new SyncError('Sync is not set up for this copy of the app.', 'unconfigured');
    if (connected) return;
    const session = store.getSyncState().session ?? null;
    await ask('connect', { url: config.url, anonKey: config.anonKey, table, pageSize, session });
    connected = true;
  }

  /* ---------- status ---------- */

  const queuedCount = () => (store.isLocked() ? 0 : store.getSyncState().dirty.length);

  /**
   * Work out the status from what the store says.
   * `settled` is passed by a cycle that has just finished; without it, a status refresh triggered
   * by something else (a save, going offline) leaves a cycle in progress showing as syncing.
   */
  function refreshStatus({ settled = false } = {}) {
    if (!configured()) { set({ phase: 'unconfigured' }); return; }
    if (store.isLocked()) return;
    const { userId, email, lastSyncAt } = store.getSyncState();
    if (!userId) { set({ phase: 'signed-out', email: null, queued: 0 }); return; }
    if (!settled && state.phase === 'syncing') { set({ email, queued: queuedCount() }); return; }
    const queued = queuedCount();
    const phase = !online() && queued ? 'offline' : queued ? 'pending' : 'idle';
    set({ phase, email, lastSyncAt, queued, message: '' });
  }

  /* ---------- a cycle ---------- */

  async function cycle({ uploadEverything = false } = {}) {
    if (!configured()) throw new SyncError('Sync is not set up for this copy of the app.', 'unconfigured');
    if (store.isLocked()) throw new SyncError('Unlock first.', 'locked');
    const { userId } = store.getSyncState();
    if (!userId) throw new SyncError('Not signed in.', 'signed-out');
    await ensureConnected();
    if (uploadEverything) store.markAllDirty();

    // Push first, so what we have is on the server before we ask what changed.
    const outgoing = await store.collectDirtyItems();
    if (outgoing.length) {
      await ask('push', { rows: outgoing.map(toRow), userId });
      store.clearDirty(outgoing.map((item) => item.queueKey));
    }

    const since = store.getSyncState().lastPulledAt;
    const { rows } = await ask('pull', { since });
    const applied = rows.length ? await store.applyRemoteItems(rows) : { applied: 0, kept: 0, unreadable: 0 };

    store.setSyncState({
      lastPulledAt: nextWatermark(since, rows),
      lastSyncAt: new Date().toISOString(),
    });
    return { pushed: outgoing.length, pulled: rows.length, ...applied };
  }

  const toRow = (item) => ({
    id: item.id,
    kind: item.kind,
    iv: item.iv,
    ciphertext: item.ciphertext,
    salt: item.salt ?? null,
    updated_at: item.updatedAt,
    deleted: item.deleted === true,
  });

  /** One cycle at a time; a request while one is running waits for that one. */
  function runCycle(options) {
    if (running) return running;
    clearTimeout(retryTimer);
    set({ phase: 'syncing', message: '' });
    running = (async () => {
      try {
        const result = await cycle(options);
        retries = 0;
        refreshStatus({ settled: true });
        return result;
      } catch (err) {
        const code = err.code ?? 'error';
        if (code === 'offline') set({ phase: 'offline', message: 'No connection. Your changes are saved here and will go up when you are back online.', queued: queuedCount() });
        else if (code === 'locked') refreshStatus({ settled: true });
        else set({ phase: 'error', message: err.message, queued: queuedCount() });
        if (code === 'offline' || code === 'worker') scheduleRetry();
        throw err;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
    retries += 1;
    retryTimer = setTimeout(() => { if (canSync()) runCycle().catch(() => {}); }, wait);
    retryTimer?.unref?.(); // a pending retry must not hold a test runner (or any host) open
  }

  const canSync = () => configured() && !store.isLocked() && Boolean(store.getSyncState().userId);

  /* ---------- the outside world ---------- */

  function onOnline() {
    if (canSync() && queuedCount()) runCycle().catch(() => {});
    else refreshStatus();
  }
  function onOffline() { refreshStatus(); }

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    isConfigured: configured,
    refreshStatus: () => refreshStatus(),

    /** Call once the ledger is open: restores status and syncs anything left over. */
    start() {
      globalThis.addEventListener?.('online', onOnline);
      globalThis.addEventListener?.('offline', onOffline);
      refreshStatus();
      if (canSync()) runCycle().catch(() => {});
    },

    /** Call on lock or teardown: the worker holds the session, so it goes too. */
    stop() {
      globalThis.removeEventListener?.('online', onOnline);
      globalThis.removeEventListener?.('offline', onOffline);
      clearTimeout(debounceTimer);
      clearTimeout(retryTimer);
      failAll(new SyncError('Stopped.', 'stopped'));
      worker?.terminate();
      worker = null;
      connected = false;
      running = null;
      set({ phase: configured() ? 'signed-out' : 'unconfigured', email: null, queued: 0, message: '' });
    },

    /** After a save: wait for the typing to stop, then sync. */
    schedule() {
      if (!canSync()) { refreshStatus(); return; }
      refreshStatus();
      // Nothing queued means this change was sync's own bookkeeping (a watermark, a refreshed
      // token). Waking up for that would have every cycle schedule the next one, forever.
      if (!queuedCount()) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { if (canSync()) runCycle().catch(() => {}); }, debounceMs);
      debounceTimer?.unref?.();
    },

    syncNow: () => runCycle(),

    async signUp(email, password) {
      await ensureConnected();
      const result = await ask('signUp', { email, password });
      if (result.session) await adopt(result);
      return result;
    },

    /**
     * Sign in, then work out whether this device's key matches the account's.
     * → { needsPassphrase: true, keyInfo } when the account was set up with a different passphrase
     *   (or this device has no passphrase yet); the caller collects it and calls adoptKey().
     */
    async signIn(email, password) {
      await ensureConnected();
      const result = await ask('signIn', { email, password });
      return adopt(result);
    },

    /**
     * A new device, or one whose passphrase differs from the account's. The sign-in is only
     * recorded once the key is proven, so a wrong passphrase leaves nothing half-joined: this
     * device cannot then upload items sealed with a key the account cannot read.
     */
    async adoptKey(passphrase, keyInfo) {
      if (!pendingAccount) throw new SyncError('Sign in first.', 'signed-out');
      await store.adoptCloudKey(passphrase, keyInfo); // throws on a wrong passphrase
      store.setSyncState({ userId: pendingAccount.user.id, email: pendingAccount.user.email, session: pendingAccount.session });
      pendingAccount = null;
      await runCycle({ uploadEverything: true });
      return { ok: true };
    },

    async signOut() {
      pendingAccount = null;
      try { await ask('signOut'); } catch { /* leaving is allowed to fail */ }
      store.setSyncState({ userId: null, email: null, session: null, lastPulledAt: null, lastSyncAt: null });
      connected = false;
      worker?.terminate();
      worker = null;
      refreshStatus();
    },

    async deleteCloudData() {
      const { userId } = store.getSyncState();
      if (!userId) throw new SyncError('Not signed in.', 'signed-out');
      await ensureConnected();
      await ask('deleteAll', { userId });
      // Everything local is now unknown to the server, so it all needs to go up again if they stay.
      store.setSyncState({ lastPulledAt: null, lastSyncAt: null });
      store.markAllDirty();
      refreshStatus();
      return { ok: true };
    },
  };

  /** Shared by signUp and signIn: record who we are, then check the account's key against ours. */
  async function adopt({ user, session, needsConfirmation }) {
    if (!session || !user) return { needsConfirmation: needsConfirmation === true, user: user ?? null };

    // The worker is holding the session now, so this works before anything is recorded here.
    const { row } = await ask('fetchKeyInfo');
    const mine = store.getKeyInfo();
    const join = async () => {
      store.setSyncState({ userId: user.id, email: user.email, session });
      refreshStatus();
    };

    if (!row) {
      // First device on this account: this key's salt becomes the account's.
      if (!mine) throw new SyncError('Set a passphrase before turning on sync.', 'no-key');
      await join();
      await runCycle({ uploadEverything: true });
      return { ok: true, user };
    }
    if (mine && mine.salt === row.salt) {
      await join();
      await runCycle();
      return { ok: true, user };
    }
    // The account was set up with a different passphrase. Stay signed out until it is given.
    pendingAccount = { user, session };
    return { needsPassphrase: true, keyInfo: { salt: row.salt, check: { iv: row.iv, ciphertext: row.ciphertext }, rowId: row.id }, user };
  }
}
