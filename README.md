# S.E.L.F — Secure Encrypted Ledger Finance

A private, local-first personal finance tracker.

- **Works instantly.** No account, no signup, no server. Open it and log.
- **You own your data.** It lives in your browser. Nothing leaves the device unless you export it.
- **A calm utility.** No streaks, no shaming, no social features, no bank syncing, no live market data, no notifications.

This repo is **complete through Step 4**: the core app, encrypted at rest, with charts, optional on-device AI insights, and optional end-to-end encrypted sync across devices. Every step after the first is opt-in, and the app works fully without any of them.

## Run it

There is no build step, but ES modules need a web server (they don't load from `file://`):

```sh
python3 -m http.server 8000     # or: npx serve
# open http://localhost:8000
```

> **Encryption needs a secure context.** The Web Crypto API only exists on `https://` or
> `localhost`. Opened from a `file://` path, or over plain `http://` from another machine, the
> app still runs but Settings will say encryption is unavailable. Deploy over https.

### Deploy

**Option 1: Namecheap (or any shared hosting)**

Upload these folders to `public_html/` via FTP or your host's file manager:
- `index.html`
- `js/` folder
- `vendor/` folder  
- `supabase/` folder

Then visit your domain. HTTPS is required for encryption to work.

**Option 2: Netlify or Vercel**

Push to GitHub and import your repo. Both platforms auto-deploy on every push.

> **First load needs a network connection** for the Tailwind CDN script. After that the app itself makes no network calls. Vendor Tailwind locally (and add a service worker) when you want true offline first-load.

## Files

| File | Role |
| --- | --- |
| `index.html` | Shell, Tailwind (CDN, pinned), styles, Content-Security-Policy |
| `js/app.js` | UI wiring and rendering. Never touches storage. |
| `js/schema.js` | The category tree **as data**, plus the pure customizer functions (add, rename, reorder, hide, delete rules, reset) and month totals |
| `js/store.js` | **The only module that reads or writes storage.** Persistence, migrations, validation, soft delete, currency relabel, backup import/merge |
| `js/money.js` | Pure money helpers: `Intl` formatting, string-based amount parsing, decimal rescaling, currency list |
| `js/crypto.js` | **Step 2.** Web Crypto primitives: key derivation, seal/open, the passphrase check value, the strength meter |
| `js/insights.js` | **Step 3.** The computed facts, the prompt, the number guard, and the bridge to the AI worker. No DOM, no storage |
| `js/ai-worker.js` | **Step 3.** Runs the model in a Web Worker so the UI never freezes. The only file that touches the network for AI |
| `js/charts.js` | **Step 3.** Hand-built SVG donut and bar charts. Pure functions, no library |
| `vendor/transformers/` | **Step 3.** Transformers.js and its WebAssembly binary, served from this app (see its README) |
| `js/sync.js` | **Step 4.** What syncs and when: the queue, the merge rules, the status. No network, no DOM |
| `js/sync-worker.js` | **Step 4.** The only file that talks to Supabase. Holds the session, never the key |
| `js/sync-config.js` | **Step 4.** Your project URL and anon key. Empty means sync is off |
| `supabase/schema.sql` | **Step 4.** The table, its Row Level Security policies and indexes. Paste into the SQL editor |
| `vendor/supabase/` | **Step 4.** The Supabase client, served from this app rather than a CDN |
| `_headers`, `vercel.json` | A Content-Security-Policy header for each Worker (Netlify / Vercel) |
| `js/backup.js` | CSV builder and file download helper |
| `tests/logic.test.mjs` | Step 1 logic tests (money, categories, totals, storage, backups) |
| `tests/crypto.test.mjs` | Step 2 tests: what reaches disk, KDF parameters, lock/unlock, re-keying, restore |
| `tests/insights.test.mjs` | Step 3 tests: the facts, the prompt, the number guard, the bridge, the charts |
| `tests/sync.test.mjs` | Step 4 tests: the queue, conflicts, two devices, offline, keys |
| `tests/sql.test.mjs` | Step 4: the SQL and its policies, against real PostgreSQL (optional dependency) |

`money.js` and `backup.js` are small pure modules added beside the planned structure so `app.js` stays UI-only and the logic is testable in Node.

## Data

Unencrypted, one `localStorage` key, `self.data`, holds one JSON document (so every save is
atomic). Once a passphrase is set this becomes `self.vault`, holding only the sealed form
described under [Encryption](#encryption) — the plaintext key is deleted. The document inside
is the same either way:

```jsonc
{
  "schemaVersion": 1,
  "settings":     { "currency": "UGX", "currencyConfirmed": true, "privacyMode": false, "theme": "system" },
  "categories":   [ /* the tree from schema.js, plus your edits */ ],
  "transactions": [ {
    "id": "uuid", "type": "expense", "amount": 50000, "currency": "UGX",
    "categoryId": "exp.food", "subCategoryId": "exp.food.groceries",
    "date": "2026-09-20", "note": "",
    "createdAt": "…ISO…", "updatedAt": "…ISO…", "deleted": false
  } ]
}
```

- **Money is an integer in the currency's smallest unit** (UGX `50000` = USh 50,000; USD `125000` = $1,250.00). Never a float. Decimal places and symbol come from the ISO 4217 code via `Intl`.
- **Deleting is soft** (`deleted: true`), which Step 4 sync needs. Categories in use are never hard-deleted.
- **Changing currency relabels, it does not convert.** Values keep their face amount and are rescaled for the decimals difference (50,000 UGX stays 50,000 in USD).
- **Net balance = income − expenses − savings & investments.** Savings is reported as its own total, apart from spending.
- **Migrations:** bump `SCHEMA_VERSION` in `store.js` and add `MIGRATIONS[n]`. Data from a *newer* app is refused, not overwritten. Unreadable data is set aside under `self.data.corrupt`, never deleted.

## Encryption

Set a passphrase and everything S.E.L.F stores is sealed before it is written:

```jsonc
// localStorage["self.vault"] — and the same shape as a .self backup file
{
  "schemaVersion": 1,                    // pins the whole cipher suite; see below
  "salt":       "…16 random bytes, base64…",
  "check":      { "iv": "…", "ciphertext": "…" },   // a known string, sealed with the same key
  "iv":         "…12 random bytes, base64…",        // fresh on every single save
  "ciphertext": "…the whole ledger…"
}
```

| | |
| --- | --- |
| Key derivation | PBKDF2-SHA256, **600,000 iterations**, random 16-byte salt |
| Encryption | **AES-GCM 256**, a fresh random 12-byte IV per save |
| The key | A non-extractable `CryptoKey`, in memory only. Never written anywhere, in any form |
| Randomness | `crypto.getRandomValues` only. Never `Math.random()` |

**Why the parameters are not stored next to the data.** An attacker holding the file can rewrite
anything in it, so reading the iteration count back out of the file would let them ask for one
iteration. `schemaVersion` pins the entire suite instead: version 1 *means* the table above, as
written in `crypto.js`. A future version 2 can change the numbers and still open a version 1 vault.

**The check value** is a known string sealed with the same key. AES-GCM would already reject a
wrong passphrase, so this is not what makes a wrong passphrase safe. What it buys is a precise
diagnosis: if the check opens but the ledger does not, the passphrase was *right* and the stored
data is damaged — a different message and a different remedy ("restore a backup", not "try again").

**What this protects against:** someone who gets at the bytes — a shared laptop, a stolen phone, a
copied browser profile, a backup file in cloud storage. **What it does not:** malicious code running
inside the page itself. Once the ledger is unlocked, the key is in memory by definition.

### Flows

- **First run** offers "Protect your ledger", with a strength meter and a plain warning. *Skip for
  now* leaves it unencrypted and is remembered; Settings then carries a standing reminder.
- **Step 1 data migrates** on setup: the vault is written, then **proved readable** by deriving a
  second key from the passphrase and decrypting what actually landed in storage, and only then is
  the plaintext copy deleted. If anything fails, the vault is removed and the plaintext is left
  untouched, so a failure cannot cost data.
- **Every load is locked.** A refresh is not a way past the passphrase.
- **Auto-lock** after idle minutes (default 5, configurable, *Never* available), and when the tab
  has been in the background that long. Locking forgets the key and the decrypted ledger, and
  clears the screen.
- **Changing the passphrase** re-encrypts everything under a brand new salt. On failure the
  previous vault is put back.
- **Wrong attempts** are throttled in the UI with an increasing delay — two slips are free, then
  5s, 15s, 30s, 1m, 2m, 5m. This slows a person at the keyboard; the 600,000 iterations are what
  slow an offline attack on a copied file.
- **Forgotten passphrase:** there is no recovery. The lock screen offers to erase and start over,
  behind typing `ERASE`.

## Insights

The **Insights** tab shows one month at a time (same switcher as *Month*). Everything on it except the
optional AI summary is plain arithmetic done on this device.

**The numbers.** Integers all the way down; percentages and ratios use `BigInt` maths and round half up,
so no float ever touches a total. "Spending" excludes Savings & Investments, exactly as the Month screen does.

| Fact | Definition |
| --- | --- |
| Totals | Income, spending, saved or invested, net (income − spending − savings) |
| Savings rate | Savings & Investments ÷ income, whole percent. Left out when there is no income |
| Month-over-month | Spending and income against the previous month: direction, whole percent, and the difference. Says so plainly when there is nothing to compare with |
| By category | Spending per main category, largest first. The top four are listed; the rest are rolled into "all other categories" with their own total |
| Top 3 sub-categories | Largest spending sub-categories (a main with no sub-category chosen counts as itself) |
| Unusual | A spending transaction **more than 2×** the average of the *other* transactions in its sub-category across all months, when there are **at least 3** others. The transaction is left out of its own baseline so one huge purchase can't inflate its own "usual". Exactly 2× is not unusual |
| Forex vs Trading Income | Forex spending, Trading Income, and the difference (negative when Forex cost more). Left out when neither appears |

**Charts.** A donut of this month's spending by main category (savings are shown apart, in the caption) and grouped
bars of income against expenses for the six months ending at the selected month. They are **hand-built SVG**, not
Chart.js: a CDN library would have put a third-party request on every page load, and building the markup here means
every value passes through one switch, `showValues`.

**Privacy Mode** hides every amount on this tab: no amount in the facts, legend or table, no axis values, no tooltips
(`<title>`), and no amount in any text a screen reader could read. Shapes and percentages remain (a percentage is not
an amount), and the AI summary is hidden and its button disabled, because the text would contain your amounts.

## On-device AI

Optional, **off until you tap *Enable AI insights***, and the app is complete without it: with AI never enabled there
is no worker, no runtime file fetched, no request, and no cache entry.

### The division of labour

1. **Plain JavaScript computes every figure** (`computeInsights`, above).
2. Those become a short list of **facts**, grouped `[A]` headline, `[B]` changes, `[C]` categories, `[D]` unusual, `[E]` Forex.
3. A small model (SmolLM2-360M) writes **one sentence per group**, tagged `[A]`, `[B]`… The prompt holds the facts as a
   list and the instruction *"Use only these numbers. Do not calculate or invent any figures."*
4. **Every sentence is checked against only its own group's facts** before it is shown, and a sentence that fails is
   dropped on its own. Nothing unchecked is ever displayed.
5. The raw facts are **always shown right above** the AI text.

Step 4 is the point. Measured against the real model: given only instructions it re-prints the fact list instead of
writing prose; given one worked example it writes prose but leaks the example's content and borrows figures from the
wrong fact ("14% of income went to savings", where 14% is the income *change*). A check of "does this number appear
anywhere?" passes that. Binding each sentence to its own group does not.

| Check (`js/insights.js`) | Refuses |
| --- | --- |
| **Number guard** `verifyNumbers` | A figure not in the sentence's group. Money next to the currency must be a money figure, a `%` must be a percentage, anything else must be *some* figure of the group. `1,250,000`, `1.250.000` and `1 250 000` are the same value; `3.5` is not `35` |
| **Spelled-out figures** | `three`, `half`, `double`, `twice`, `a quarter`, `½`, `90k`, `1.2M` — figures the digit check can't see |
| **Label guard** `checkLabels` | A known category name directly in front of another name's figure ("Food at USh 47,000"). `or 20%` inherits the name of the amount before it. Wording it can't pin to a name is left alone rather than guessed at |
| **Example-leak guard** | Words that exist only in the worked example (`Pets`, `Books`, `June 2024`) |
| **Staleness** | A summary is tied to the exact facts it was written from; change the month or a transaction and it is hidden |

**What it does not do:** it checks figures and the names attached to them, not the meaning of the sentence around them.
A 360M-parameter model can still write a sentence that is *arithmetically* faithful and subtly off. That is why the
facts sit beside the text, and why the checkmark says only what is true: *each sentence uses only figures from its own
numbers above.* If you need more, swap in a larger model (below); the guards stay.

### The model

One constant, `AI_MODEL` in `js/insights.js`:

```js
export const AI_MODEL = {
  id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
  revision: 'a10cc1512eabd3dde888204e902eca88bddb4951',   // pinned commit: what is downloaded can't change under us
  dtype: 'q4',
  downloadBytes: 390_000_000,                              // shown BEFORE anything is fetched
  runtimeBytes: 22_528_676,
  ...
};
```

**To use SmolLM2-135M on a weak device**, change only that object: `id: 'HuggingFaceTB/SmolLM2-135M-Instruct'`,
its `revision` (the commit sha shown on the repo page or from `https://huggingface.co/api/models/<id>`), `dtype: 'q4'`
(or `'quantized'`), `downloadBytes` (sum of the ONNX file and tokenizer; ~185 MB for q4), and the `name`. A test asserts
that no other file names a model. One `dtype` serves every device on purpose: a WebGPU failure falls back to the CPU
with no second download (`q4f16` is ~115 MB smaller but needs WebGPU, so it can't fall back).

**WebGPU if available, otherwise WebAssembly**, chosen automatically in the worker (`navigator.gpu.requestAdapter()`).
If a GPU reports itself but can't run the model, or is lost mid-summary, it rebuilds on the CPU from the cached files.

### Speed, honestly

Measured in headless Chromium on a CPU-only Linux machine (no WebGPU, single-threaded WebAssembly):

| | |
| --- | --- |
| Download + load, 390 MB, first time | ~4 minutes on a ~2 MB/s link |
| Load from the browser cache | ~2 seconds |
| Prefill (reading the prompt) | 20–30 seconds |
| Decode | **~1 token per second** |
| A whole summary, end to end, through the UI (model already cached) | **~80 s for 3 groups, ~160 s for 5** |
| Longest main-thread stall, across download, model load and generation | 30 ms (0 timer delays over 100 ms in 4,449 samples); 6 ms while writing (3,324 samples) |
| Key press to field update while it writes | 3–7 ms |

The interface stays responsive, because the model lives in a Web Worker, but **on a CPU-only device a summary takes
minutes.** WebGPU should be much faster, but **that path is untested**: this machine has no WebGPU, so the worker's
WebGPU branch (and its automatic fall-back to the CPU) has been reviewed and unit-tested at the message level but never
run against a real GPU. Multi-threaded WebAssembly would likely help CPU-only devices too, but needs cross-origin
isolation (`COOP`/`COEP` headers on the whole site), which is a hosting decision left for you rather than made
silently here; the worker already asks for extra threads when the page is isolated, and that too is untested.

### Download, offline, and memory

- **Tapping *Enable AI insights* shows the size first** (390 MB from Hugging Face + 23 MB from this app = 413 MB) and
  downloads nothing until you confirm. *Cancel* tears the worker down.
- Files go into the browser's Cache API (`transformers-cache`) and are reused forever after: **works offline**.
- A returning visit loads with downloads *forbidden*: the worker refuses every non-local request, so it can never
  quietly re-download 390 MB. If the browser evicted the cache it says so and offers the download again.
- **Remove the model** (in the AI card) deletes only this model's cache entries.
- The model is released from memory after two idle minutes and reloads from the cache in ~2 seconds.
- Asking "is it downloaded?" never creates the cache (`caches.has` before `caches.open`).
- It needs a secure context (https or localhost) so the model can be kept; otherwise the card says so.

### What leaves the device

With AI **never enabled: nothing but the page itself** (plus the Tailwind CDN from Step 1). With AI enabled, the
**only third-party requests are the model download** from `huggingface.co` (redirected to `*.hf.co`). Measured in a
real browser, the complete list for enabling AI, downloading, loading and writing was:

```
127.0.0.1  /js/ai-worker.js  /vendor/transformers/{transformers.min.js, ort-wasm-simd-threaded.jsep.mjs, …jsep.wasm}
huggingface.co        …/resolve/<revision>/{tokenizer.json, tokenizer_config.json, config.json, generation_config.json, onnx/model_q4.onnx}
us.aws.cdn.hf.co      (the redirect target for the model file)
```

Your figures are given to the model in memory, in a worker on this device, and are never sent anywhere. Hugging Face
sees that your device downloaded the model, as any website you visit would. The runtime (Transformers.js + its
WebAssembly binary) is **vendored** in `vendor/transformers/` and served from this app, so no CDN is contacted; see its README.

Three layers enforce this, so no single one is trusted alone:

1. The page's `<meta>` policy keeps `connect-src 'none'`: **the page itself can't make requests at all.**
2. The worker's own guard (`js/ai-worker.js`) refuses every non-local request unless a download was just confirmed,
   and even then allows only `huggingface.co` and `*.hf.co`.
3. `_headers` (Netlify) and `vercel.json` give the worker a **`Content-Security-Policy` response header**:
   `connect-src 'self' https://huggingface.co https://*.hf.co`. A `<meta>` policy does not reach a worker loaded from
   a URL, so this header is what makes the *browser* enforce it. Keep those hosts in step with `MODEL_HOSTS` in the worker.

### With encryption and Privacy Mode

- **Locking** discards any summary and stops one that is being written (it holds your figures). A model *download*
  carries on through a lock: it holds no user data.
- Summaries are held in memory only. They are never written to storage, encrypted or not.
- With Privacy Mode on, the summary is hidden and can't be requested.

## Sync (optional)

Off unless you set it up, and the app is complete without it. **With no project configured, the
Supabase client is never fetched, no worker is started, and no request is made** — verified in a
real browser, below.

### Setting it up

1. Create a project at [supabase.com](https://supabase.com).
2. Paste [`supabase/schema.sql`](supabase/schema.sql) into the project's SQL editor and run it.
3. Put the project URL and the **anon** key in [`js/sync-config.js`](js/sync-config.js).

The anon key is meant to be public: it names the project and grants nothing on its own, because
every row sits behind Row Level Security tied to the signed-in user. The **`service_role` key
bypasses RLS entirely and must never appear in the frontend, this repo, or anywhere a browser can
reach.** Sync needs a passphrase first (Step 2): the passphrase is what encrypts each item.

### Two secrets, and only one of them can be reset

| | What it does | Who has it |
| --- | --- | --- |
| **Account password** | Signs you in to Supabase | The server (hashed). Resettable by email |
| **Passphrase** | Encrypts every item before it leaves the device | You, only. **Nobody can reset it** |

The server holds sealed rows and has never seen the passphrase, so neither secret alone opens the
ledger — and an attacker with the whole database has ciphertext and nothing else. The sign-in
dialog says this in as many words, because people reasonably assume one password unlocks everything.

### What the table holds

```
id  user_id  kind  iv  ciphertext  salt  updated_at  deleted  synced_at
```

`kind` is `transaction`, `schema` (the category tree), `settings` (currency only), or `keyinfo`.
The `keyinfo` row carries the key's **salt** and a sealed check value, which is how a *new* device
derives the same key from the passphrase. A salt is not a secret; it exists so one person's key is
unique, and it is useless without the passphrase.

**What the server still learns, unavoidably:** how many items you have, roughly how large each one
is, and when you last changed each one. Not what any of them say.

Two deliberate differences from a plain reading of the brief, both explained in the SQL:

- **`primary key (user_id, id)`**, not `id` alone. Two people who imported the same backup file both
  own an item with that uuid; a global key would let whoever synced first lock the other out with a
  confusing error.
- **A server-set `synced_at` column**, which is what devices page through. `updated_at` is the
  device's clock and decides conflicts, but paging by it means a device whose clock is a few minutes
  slow writes rows every other device scrolls straight past and never sees. There is a test for
  exactly that.

### How syncing works

- **Every change queues its own item**, inside the encrypted document. That *is* the offline queue:
  it survives a reload, a lock and a closed laptop, and it does not depend on any clock.
- **A cycle pushes the queue, then pulls everything the server has seen since last time.**
- **Conflicts resolve per item: newest `updatedAt` wins.** The timestamp used comes from *inside*
  the ciphertext, not the plaintext column, because the sealed copy is the one AES-GCM guarantees
  nobody edited. A local item that loses is replaced; one that wins stays queued and goes up next.
- **Soft deletes sync like any other change**, so a deletion — and undoing it — reaches every device.
- **It runs on unlock, a few seconds after each save, on *Sync now*, and when a connection returns.**
  Status: *Synced · Syncing · Waiting to sync · Offline · Error*.
- **Only the ledger syncs.** Theme, auto-lock, privacy mode and the dismissed banners stay on the
  device that set them.

**Sign out** keeps everything on the device and leaves the server copy alone. **Delete cloud data**
removes every row for that account, keeps the device's ledger, and re-queues it in case you stay
signed in.

### A new device

Sign in, then enter the account's passphrase. The device derives the same key from the `keyinfo`
salt, re-seals its own ledger under it, and pulls everything down. **The sign-in is only recorded
once that key is proven** — a wrong passphrase leaves the device signed out rather than half-joined,
which matters because a half-joined device would otherwise upload items sealed with a key the
account cannot read.

Changing the passphrase re-keys the vault *and* re-queues every item, because everything already on
the server was sealed with the old key.

### Where the network lives

The page keeps `connect-src 'none'` — **it still cannot open a connection to anything.** All network
access is in `js/sync-worker.js`, which gets its own Content-Security-Policy response header naming
Supabase and nothing else (`_headers`, `vercel.json`), plus a guard inside the worker itself. The
Supabase client is **vendored** in `vendor/supabase/`, so no CDN is involved; the brief suggested a
CDN, and switching back is one `importScripts` line plus a host in the header.

The session tokens live **inside the encrypted vault**, not in `localStorage` where the Supabase
client would normally put them. So they are only available while the ledger is unlocked, a lock
takes the worker down with them, and a backup file never contains one.

## Privacy
## Privacy

`index.html` ships a Content-Security-Policy with `connect-src 'none'`, so the **browser itself** blocks any fetch, XHR, WebSocket or beacon from the page. The only script origin allowed besides this site is the Tailwind CDN. Step 3's model download does not widen that policy: it runs in a Worker, which a `<meta>` policy can't reach, so the worker gets its own response header (see [On-device AI](#on-device-ai)). Step 4 (Supabase) will need to widen `connect-src` on purpose. If you edit either inline `<script>` in `index.html`, update its `sha256-…` in the policy. `frame-ancestors` can't be set from a `<meta>`; add it as a response header on your host.

Privacy Mode (header button or Settings) removes every amount from the DOM, including screen-reader text, and masks the amount fields. It is a shoulder-surfing guard, not a security control — that is what [Encryption](#encryption) is for.

## Backups

Browser storage can be cleared by you or, on some browsers, evicted after long inactivity, and a
forgotten passphrase cannot be recovered. **Export a backup now and then.**

| *Settings →* | File | Contents |
| --- | --- | --- |
| Export encrypted backup | `.self` | The full backup, sealed. Opens with the passphrase it was exported with, on any device. |
| Export JSON | `.json` | The full backup, **unencrypted** — readable by anything. |
| Export CSV | `.csv` | Transactions only, **unencrypted**, for spreadsheets. |

Import takes any of the two backup formats. A `.self` file asks for its own passphrase first,
which need not match the receiving device's. Either way it previews what it found and offers
Merge (by UUID, newer edit wins) or Replace.

## Tests

```sh
node --test tests/*.test.mjs
```

157 tests, no dependencies. The Step 2 file checks the security properties themselves, not just
that the code runs: that nothing readable reaches storage, that the key is non-extractable, that
the parameters actually used are the advertised ones (it re-derives the key independently and
opens the vault with it), and that no failure path can lose data.
