// Step 4: the SQL in supabase/schema.sql, run against real PostgreSQL, with the Row Level Security
// policies exercised the way two different accounts would actually hit them.
//
// This is the ONE test with a dependency, because there is no honest way to check a security
// boundary without a database behind it. It skips itself when the dependency is absent, so
// `node --test tests/*.test.mjs` still runs with nothing installed:
//
//     npm install --no-save @electric-sql/pglite
//     node --test tests/sql.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let PGlite = null;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* not installed */ }
const needsPglite = { skip: PGlite ? false : 'needs: npm install --no-save @electric-sql/pglite' };

const SQL = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** Stand in for the parts of Supabase the schema leans on: the auth schema and auth.uid(). */
async function freshDb() {
  const db = await PGlite.create();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key);
    -- Supabase's auth.uid() reads the signed-in user's id out of the request's JWT claims.
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
    $$;
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users (id) values ('${A}'), ('${B}');
  `);
  await db.exec(SQL);
  return db;
}

/** Run statements as a signed-in user, exactly as PostgREST does. */
async function as(db, userId, sql, params) {
  await db.exec('reset role;');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [userId ? JSON.stringify({ sub: userId, role: 'authenticated' }) : '']);
  await db.exec(`set role ${userId ? 'authenticated' : 'anon'};`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
}

const row = (id, user, over = {}) => ({
  id, user_id: user, kind: 'transaction', iv: 'aXY=', ciphertext: 'Y3Q=', updated_at: '2026-09-20T10:00:00Z', ...over,
});
const insert = (db, user, r) => as(db, user,
  `insert into public.ledger_items (id, user_id, kind, iv, ciphertext, updated_at, deleted)
   values ($1,$2,$3,$4,$5,$6,$7) returning id`,
  [r.id, r.user_id, r.kind, r.iv, r.ciphertext, r.updated_at, r.deleted ?? false]);

test('the schema applies cleanly, and twice (it is safe to re-run)', needsPglite, async () => {
  const db = await freshDb();
  await db.exec(SQL);
  const cols = await db.query(`select column_name, data_type, is_nullable from information_schema.columns
    where table_name = 'ledger_items' order by ordinal_position`);
  assert.deepEqual(cols.rows.map((c) => c.column_name),
    ['id', 'user_id', 'kind', 'iv', 'ciphertext', 'salt', 'updated_at', 'deleted', 'synced_at']);
  const pk = await db.query(`select a.attname from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.ledger_items'::regclass and i.indisprimary order by a.attname`);
  assert.deepEqual(pk.rows.map((r) => r.attname), ['id', 'user_id'], 'primary key is (user_id, id)');
  await db.close();
});

test('RLS is on, forced, and every statement has a policy', needsPglite, async () => {
  const db = await freshDb();
  const t = await db.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.ledger_items'::regclass`);
  assert.equal(t.rows[0].relrowsecurity, true, 'row level security enabled');
  assert.equal(t.rows[0].relforcerowsecurity, true, 'forced, so the owner is bound by it too');
  const p = await db.query(`select cmd, qual, with_check, roles::text from pg_policies where tablename = 'ledger_items' order by cmd`);
  assert.deepEqual(p.rows.map((r) => r.cmd).sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  for (const r of p.rows) {
    assert.equal(r.roles, '{authenticated}', `${r.cmd} is granted to authenticated only`);
    const guard = `${r.qual ?? ''}${r.with_check ?? ''}`;
    assert.match(guard, /auth\.uid\(\) = user_id/, `${r.cmd} is scoped to the signed-in user`);
  }
  assert.ok(p.rows.find((r) => r.cmd === 'UPDATE').with_check, 'UPDATE also restricts what a row may become');
  await db.close();
});

test('user A cannot read, change or delete user B\'s rows', needsPglite, async () => {
  const db = await freshDb();
  await insert(db, A, row('aaaaaaaa-0000-4000-8000-000000000001', A));
  await insert(db, B, row('bbbbbbbb-0000-4000-8000-000000000001', B, { ciphertext: 'QlNFQ1JFVA==' }));

  const mine = await as(db, A, 'select id, user_id from public.ledger_items');
  assert.equal(mine.rows.length, 1, 'A sees exactly one row');
  assert.equal(mine.rows[0].user_id, A, 'and it is A\'s own');

  // Naming B's row explicitly does not help: it is not merely hidden, it is not reachable.
  const targeted = await as(db, A, 'select * from public.ledger_items where user_id = $1', [B]);
  assert.equal(targeted.rows.length, 0, 'A cannot read B\'s row by asking for it directly');

  const upd = await as(db, A, `update public.ledger_items set ciphertext = 'hacked' where user_id = $1 returning id`, [B]);
  assert.equal(upd.rows.length, 0, 'A cannot update B\'s row');
  const del = await as(db, A, 'delete from public.ledger_items where user_id = $1 returning id', [B]);
  assert.equal(del.rows.length, 0, 'A cannot delete B\'s row');

  const untouched = await as(db, B, 'select ciphertext from public.ledger_items');
  assert.equal(untouched.rows[0].ciphertext, 'QlNFQ1JFVA==', 'B\'s data is exactly as B left it');
  await db.close();
});

test('A cannot write a row that belongs to B, nor hand one of their own over', needsPglite, async () => {
  const db = await freshDb();
  await assert.rejects(
    () => insert(db, A, row('aaaaaaaa-0000-4000-8000-000000000002', B)),
    /row-level security/i, 'inserting under B\'s user_id is refused',
  );
  await insert(db, A, row('aaaaaaaa-0000-4000-8000-000000000003', A));
  await assert.rejects(
    () => as(db, A, 'update public.ledger_items set user_id = $1', [B]),
    /row-level security/i, 'reassigning a row to B is refused by the update WITH CHECK',
  );
  await db.close();
});

test('the id default fills in the signed-in user, so a client need not send one', needsPglite, async () => {
  const db = await freshDb();
  await as(db, A, `insert into public.ledger_items (id, kind, iv, ciphertext, updated_at)
                   values ('aaaaaaaa-0000-4000-8000-000000000004', 'transaction', 'aXY=', 'Y3Q=', now())`);
  const r = await as(db, A, 'select user_id from public.ledger_items');
  assert.equal(r.rows[0].user_id, A);
  await db.close();
});

test('a signed-out caller gets nothing at all', needsPglite, async () => {
  const db = await freshDb();
  await insert(db, A, row('aaaaaaaa-0000-4000-8000-000000000005', A));
  await assert.rejects(() => as(db, null, 'select * from public.ledger_items'), /permission denied/i,
    'anon is refused before RLS is even consulted');
  await assert.rejects(() => as(db, null, `insert into public.ledger_items (id, user_id, kind, iv, ciphertext, updated_at)
    values ('aaaaaaaa-0000-4000-8000-000000000006', $1, 'transaction', 'aXY=', 'Y3Q=', now())`, [A]), /permission denied/i);
  await db.close();
});

test('two accounts may hold the same item id (the shared-backup case)', needsPglite, async () => {
  const db = await freshDb();
  const shared = 'cccccccc-0000-4000-8000-000000000001';
  await insert(db, A, row(shared, A));
  await insert(db, B, row(shared, B));           // would be a primary key violation with `id primary key`
  assert.equal((await as(db, A, 'select * from public.ledger_items')).rows.length, 1);
  assert.equal((await as(db, B, 'select * from public.ledger_items')).rows.length, 1);
  await db.close();
});

test('synced_at is the server\'s clock: a client cannot set it, and an update moves it', needsPglite, async () => {
  const db = await freshDb();
  const id = 'aaaaaaaa-0000-4000-8000-000000000007';
  await as(db, A, `insert into public.ledger_items (id, user_id, kind, iv, ciphertext, updated_at, synced_at)
                   values ($1, $2, 'transaction', 'aXY=', 'Y3Q=', '2020-01-01T00:00:00Z', '1999-01-01T00:00:00Z')`, [id, A]);
  const first = await as(db, A, 'select synced_at, updated_at from public.ledger_items');
  assert.ok(new Date(first.rows[0].synced_at).getUTCFullYear() >= 2024, 'the client\'s 1999 was ignored');
  assert.equal(new Date(first.rows[0].updated_at).toISOString(), '2020-01-01T00:00:00.000Z', 'the device clock is kept as sent');

  await new Promise((r) => setTimeout(r, 15));
  await as(db, A, `update public.ledger_items set ciphertext = 'bmV3' where id = $1`, [id]);
  const second = await as(db, A, 'select synced_at from public.ledger_items');
  assert.ok(new Date(second.rows[0].synced_at) > new Date(first.rows[0].synced_at), 'an edit moves synced_at forward');
  await db.close();
});

test('a device pulling "everything since I last looked" sees exactly the new rows', needsPglite, async () => {
  const db = await freshDb();
  await insert(db, A, row('aaaaaaaa-0000-4000-8000-00000000000a', A));
  const mark = (await as(db, A, 'select max(synced_at) as t from public.ledger_items')).rows[0].t;
  await new Promise((r) => setTimeout(r, 15));
  // A second device writes with a clock five minutes slow — the row must still be picked up.
  await insert(db, A, row('aaaaaaaa-0000-4000-8000-00000000000b', A, { updated_at: new Date(Date.now() - 300_000).toISOString() }));
  const since = await as(db, A, 'select id from public.ledger_items where synced_at > $1 order by synced_at', [mark]);
  assert.deepEqual(since.rows.map((r) => r.id), ['aaaaaaaa-0000-4000-8000-00000000000b'],
    'the slow-clock row is not skipped, which is why the pull watermark is the server clock');
  await db.close();
});

test('kind is constrained, and required columns really are required', needsPglite, async () => {
  const db = await freshDb();
  await assert.rejects(() => insert(db, A, row('aaaaaaaa-0000-4000-8000-00000000000c', A, { kind: 'plaintext' })), /check constraint/i);
  for (const [i, kind] of ['transaction', 'schema', 'settings', 'keyinfo'].entries()) {
    await insert(db, A, row(`aaaaaaaa-0000-4000-8000-00000000001${i}`, A, { kind }));
  }
  await assert.rejects(() => as(db, A, `insert into public.ledger_items (id, user_id, kind, iv, ciphertext)
    values ('aaaaaaaa-0000-4000-8000-00000000000d', $1, 'transaction', 'aXY=', 'Y3Q=')`, [A]), /not-null|null value/i,
  'updated_at cannot be omitted');
  await db.close();
});
