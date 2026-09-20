// sync-config.js — where YOUR Supabase project goes. Empty means sync is switched off entirely:
// the app runs exactly as it did in Steps 1–3, and the Sync card explains that it isn't configured.
//
// HOW TO FILL THIS IN
//   1. Create a project at supabase.com.
//   2. Run supabase/schema.sql in the project's SQL editor.
//   3. Project Settings → API → copy "Project URL" and the "anon public" key below.
//
// BOTH OF THESE ARE MEANT TO BE PUBLIC. The anon key only says "this is which project"; it grants
// nothing on its own, because every row is behind Row Level Security tied to the signed-in user
// (see supabase/schema.sql). It is safe in a static site, in this repo, and in a browser.
//
// The `service_role` key is the opposite: it bypasses RLS completely and can read every user's
// rows. It must NEVER appear in this file, in this repo, or anywhere a browser can reach it.
// If you ever paste one here by mistake, treat it as leaked and rotate it in the dashboard.

export const SUPABASE = {
  url: '',
  anonKey: '',
};

/** The table from supabase/schema.sql. */
export const TABLE = 'ledger_items';

/** How many rows to move per request when pushing or pulling. */
export const PAGE_SIZE = 200;

// https everywhere, except a Supabase you are hosting yourself on this machine.
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
export const isConfigured = () => (/^https:\/\/[^\s]+$/.test(SUPABASE.url) || LOCAL.test(SUPABASE.url)) && SUPABASE.anonKey.length > 20;
