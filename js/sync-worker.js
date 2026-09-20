// sync-worker.js — the only file in the app that talks to Supabase.
//
// WHY A WORKER. The page's Content-Security-Policy is `connect-src 'none'`: the page itself cannot
// open a connection to anywhere, and that has been true since Step 1. A <meta> policy does not
// reach a Worker loaded from a URL, so the network lives here instead, and this file gets its own
// CSP as a response header (see _headers / vercel.json) naming the one host it may reach. The page
// keeps its guarantee; a guest who never signs in never even loads this file.
//
// WHAT CROSSES THIS BOUNDARY. Only sealed rows: { id, kind, iv, ciphertext, salt?, updated_at,
// deleted }. The ciphertext is AES-GCM, sealed in store.js with the passphrase-derived key. This
// worker has no key and could not read a row if it tried. The one thing it does hold is the
// Supabase session (the access and refresh tokens), which it is handed on connect and hands back
// when it changes, so the main thread can keep it inside the encrypted vault rather than on disk.
//
// Messages in:  connect · signUp · signIn · signOut · pull · push · fetchKeyInfo · deleteAll
// Messages out: result · error · session

importScripts('../vendor/supabase/supabase.js');

/* ------------------------------------------------------------------ */
/* Network guard                                                       */
/* ------------------------------------------------------------------ */

// Belt and braces with the CSP header: even if a future edit asked this worker to fetch something
// else, it would be refused here. Set once, when the project URL arrives, and never widened.
let allowedOrigin = null;

const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, self.location.href);
  if (url.origin !== self.location.origin && url.origin !== allowedOrigin) {
    return Promise.reject(new TypeError(`Blocked a request to ${url.origin}`));
  }
  return nativeFetch(input, init);
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let client = null;
let table = 'ledger_items';
let pageSize = 200;

const post = (message) => self.postMessage(message);

/** Supabase errors carry codes and hints; keep them, but never echo a row's contents. */
function describe(error) {
  if (!error) return { message: 'Something went wrong.', code: 'unknown' };
  const message = String(error.message ?? error).slice(0, 300);
  const offline = /failed to fetch|networkerror|load failed|blocked a request/i.test(message);
  return {
    message: offline ? 'No connection.' : message,
    code: offline ? 'offline' : (error.code ?? error.status ?? 'error'),
  };
}

function connect({ url, anonKey, table: name, pageSize: size, session }) {
  allowedOrigin = new URL(url).origin;
  table = name ?? table;
  pageSize = size ?? pageSize;
  client = self.supabase.createClient(url, anonKey, {
    auth: {
      // The session is NOT written to disk here. It lives in the encrypted vault, handed over on
      // connect and handed back below whenever Supabase refreshes it.
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: { headers: { 'x-client-info': 'self-ledger/4' } },
  });
  client.auth.onAuthStateChange((event, next) => {
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') post({ type: 'session', session: next });
  });
  return session ? client.auth.setSession(session).then(() => ({ restored: true })) : { restored: false };
}

const userOf = (data) => (data?.user ? { id: data.user.id, email: data.user.email } : null);

async function signUp({ email, password }) {
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;
  // With email confirmation switched on (Supabase's default) there is no session yet.
  return { user: userOf(data), session: data.session ?? null, needsConfirmation: !data.session };
}

async function signIn({ email, password }) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { user: userOf(data), session: data.session ?? null };
}

async function signOut() {
  await client.auth.signOut().catch(() => {}); // a failed round trip must not trap someone signed in
  return { ok: true };
}

/** Everything the server has seen since `since` (a server clock value), oldest first. */
async function pull({ since }) {
  const rows = [];
  let after = since ?? '1970-01-01T00:00:00Z';
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select('id, kind, iv, ciphertext, salt, updated_at, deleted, synced_at')
      .gt('synced_at', after)
      .order('synced_at', { ascending: true })
      .limit(pageSize);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) break;
    const last = data[data.length - 1].synced_at;
    if (last === after) break; // same millisecond across a page boundary: stop rather than loop
    after = last;
  }
  return { rows, watermark: rows.length ? rows[rows.length - 1].synced_at : since ?? null };
}

/** Upsert sealed rows. The conflict target is the table's composite primary key. */
async function push({ rows, userId }) {
  for (let i = 0; i < rows.length; i += pageSize) {
    const batch = rows.slice(i, i + pageSize).map((r) => ({ ...r, user_id: userId }));
    const { error } = await client.from(table).upsert(batch, { onConflict: 'user_id,id', returning: 'minimal' });
    if (error) throw error;
  }
  return { pushed: rows.length };
}

/** The salt and sealed check value a new device needs to derive the same key. */
async function fetchKeyInfo() {
  const { data, error } = await client.from(table).select('id, iv, ciphertext, salt, updated_at').eq('kind', 'keyinfo').limit(1);
  if (error) throw error;
  return { row: data[0] ?? null };
}

async function deleteAll({ userId }) {
  const { error } = await client.from(table).delete().eq('user_id', userId);
  if (error) throw error;
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const HANDLERS = { connect, signUp, signIn, signOut, pull, push, fetchKeyInfo, deleteAll };

self.onmessage = async (event) => {
  const { type, id, ...payload } = event.data;
  const handler = HANDLERS[type];
  if (!handler) { post({ type: 'error', id, message: `Unknown request: ${type}`, code: 'bad-request' }); return; }
  if (type !== 'connect' && !client) { post({ type: 'error', id, message: 'Sync is not connected.', code: 'no-client' }); return; }
  try {
    post({ type: 'result', id, value: await handler(payload) });
  } catch (err) {
    post({ type: 'error', id, ...describe(err) });
  }
};
