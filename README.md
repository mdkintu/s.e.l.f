# S.E.L.F

A private, local-first personal finance tracker.

- **Works instantly.** No account, no signup, no server. Open it and log.
- **You own your data.** It lives in your browser. Nothing leaves the device unless you export it.
- **A calm utility.** No streaks, no shaming, no social features, no bank syncing, no live market data, no notifications.

This repo is at **Step 2**: the core app, with everything it stores encrypted behind a passphrase. Later steps add local AI insights (3) and optional sync (4).

## Run it

There is no build step, but ES modules need a web server (they don't load from `file://`):

```sh
python3 -m http.server 8000     # or: npx serve
# open http://localhost:8000
```

> **Encryption needs a secure context.** The Web Crypto API only exists on `https://` or
> `localhost`. Opened from a `file://` path, or over plain `http://` from another machine, the
> app still runs but Settings will say encryption is unavailable. Deploy over https.

Deploy by uploading the files as-is to Vercel or Netlify.

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
| `js/backup.js` | CSV builder and file download helper |
| `tests/logic.test.mjs` | Step 1 logic tests (money, categories, totals, storage, backups) |
| `tests/crypto.test.mjs` | Step 2 tests: what reaches disk, KDF parameters, lock/unlock, re-keying, restore |

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

## Privacy

`index.html` ships a Content-Security-Policy with `connect-src 'none'`, so the **browser itself** blocks any fetch, XHR, WebSocket or beacon. The only script origin allowed besides this site is the Tailwind CDN. A step that adds a network call (the Step 3 model download, Step 4 Supabase) must widen the policy on purpose. If you edit either inline `<script>` in `index.html`, update its `sha256-…` in the policy. `frame-ancestors` can't be set from a `<meta>`; add it as a response header on your host.

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

54 tests, no dependencies. The Step 2 file checks the security properties themselves, not just
that the code runs: that nothing readable reaches storage, that the key is non-extractable, that
the parameters actually used are the advertised ones (it re-derives the key independently and
opens the vault with it), and that no failure path can lose data.
