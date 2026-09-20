-- S.E.L.F — Step 4 sync. Paste this whole file into the Supabase SQL editor and run it.
-- Safe to run more than once.
--
-- WHAT THE SERVER CAN SEE: a user id, a row kind, a random salt, an IV, a ciphertext blob, a
-- timestamp and a deleted flag. The ciphertext is AES-GCM sealed on the device with a key derived
-- from the passphrase (Step 2). The server never receives the passphrase or the key, so nobody
-- holding this database — including you, and including Supabase — can read an amount, a note or a
-- category name.
--
-- WHAT IT STILL REVEALS (unavoidable with a server, and worth knowing): how many items you have,
-- roughly how big each one is, and when you last changed each one.

create table if not exists public.ledger_items (
  -- The item's own id. For a transaction this is the SAME uuid the device uses locally, so an
  -- item that syncs to two devices stays one item.
  id          uuid        not null,
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,

  -- 'transaction' — one logged transaction
  -- 'schema'      — the whole category tree, as one item
  -- 'settings'    — the synced settings (currency), as one item
  -- 'keyinfo'     — the key's salt plus a sealed check value, so a NEW device can derive the same
  --                 key from the passphrase. A salt is not a secret; it exists to make one
  --                 person's key unique. See the `salt` column below.
  kind        text        not null check (kind in ('transaction', 'schema', 'settings', 'keyinfo')),

  iv          text        not null,          -- base64, fresh random 12 bytes per save
  ciphertext  text        not null,          -- base64, AES-GCM sealed on the device

  -- Only the 'keyinfo' row uses this: base64 of the 16 random bytes the key is derived with.
  -- Null on every row that holds data.
  salt        text,

  -- The DEVICE's clock, carried from the item itself. This is what decides a conflict:
  -- newest updated_at wins, per item.
  updated_at  timestamptz not null,

  -- Soft delete, mirroring the local one, so a deletion reaches the other devices.
  deleted     boolean     not null default false,

  -- The SERVER's clock, set by the trigger below and never by the client. Devices page through
  -- changes with this. It has to be separate from updated_at: a device whose clock is a few
  -- minutes slow would otherwise write rows that other devices scroll straight past and never see.
  synced_at   timestamptz not null default now(),

  -- Two people who imported the SAME backup file both own an item with that uuid. A plain
  -- `id uuid primary key` would let the first one uploaded lock the second one out of syncing,
  -- with a confusing error. Scoping the key by owner costs nothing and removes that case.
  primary key (user_id, id)
);

-- The client may propose a synced_at; this overwrites it. It is the server's clock, always.
create or replace function public.ledger_items_stamp()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.synced_at := now();
  return new;
end;
$$;

drop trigger if exists ledger_items_stamp on public.ledger_items;
create trigger ledger_items_stamp
  before insert or update on public.ledger_items
  for each row execute function public.ledger_items_stamp();

-- Pulling changes: "my rows, in server order, since the last time I looked".
create index if not exists ledger_items_user_synced_idx on public.ledger_items (user_id, synced_at);
-- Asked for in the brief, and used for tie-breaking and inspection by device time.
create index if not exists ledger_items_user_updated_idx on public.ledger_items (user_id, updated_at);

-- ---------------------------------------------------------------------------
-- Row Level Security: every statement is filtered by the signed-in user's id.
-- ---------------------------------------------------------------------------
alter table public.ledger_items enable row level security;

-- Also apply the policies to the table's owner, so a mistake elsewhere (a function running as the
-- owner, a future migration) cannot quietly read across accounts.
alter table public.ledger_items force row level security;

drop policy if exists "ledger_items_select_own" on public.ledger_items;
create policy "ledger_items_select_own" on public.ledger_items
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "ledger_items_insert_own" on public.ledger_items;
create policy "ledger_items_insert_own" on public.ledger_items
  for insert to authenticated
  with check (auth.uid() = user_id);

-- USING decides which rows may be updated; WITH CHECK decides what they may become. Both are
-- needed: without WITH CHECK a user could hand a row to someone else by rewriting user_id.
drop policy if exists "ledger_items_update_own" on public.ledger_items;
create policy "ledger_items_update_own" on public.ledger_items
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "ledger_items_delete_own" on public.ledger_items;
create policy "ledger_items_delete_own" on public.ledger_items
  for delete to authenticated
  using (auth.uid() = user_id);

-- Signed-out callers have no business here at all. RLS already stops them (auth.uid() is null,
-- so no policy matches); revoking as well means they are refused before any policy is consulted.
revoke all on table public.ledger_items from anon;
grant select, insert, update, delete on table public.ledger_items to authenticated;
