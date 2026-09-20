# S.E.L.F

A private, local-first personal finance tracker.

- **Works instantly.** No account, no signup, no server. Open it and log.
- **You own your data.** It lives in your browser. Nothing leaves the device unless you export it.
- **A calm utility.** No streaks, no shaming, no social features, no bank syncing, no live market data, no notifications.

This repo is **Step 1**: the core app on plain `localStorage`. Later steps add encryption (2), local AI insights (3) and optional sync (4).

## Run it

There is no build step, but ES modules need a web server (they don't load from `file://`):

```sh
python3 -m http.server 8000     # or: npx serve
# open http://localhost:8000
```

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
| `js/backup.js` | CSV builder and file download helper |
| `tests/logic.test.mjs` | Dependency-free tests for everything that isn't the DOM |

`money.js` and `backup.js` are small pure modules added beside the planned structure so `app.js` stays UI-only and the logic is testable in Node.

## Data

One `localStorage` key, `self.data`, holds one JSON document (so every save is atomic):

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

## Privacy

`index.html` ships a Content-Security-Policy with `connect-src 'none'`, so the **browser itself** blocks any fetch, XHR, WebSocket or beacon. The only script origin allowed besides this site is the Tailwind CDN. A step that adds a network call (the Step 3 model download, Step 4 Supabase) must widen the policy on purpose. If you edit either inline `<script>` in `index.html`, update its `sha256-…` in the policy. `frame-ancestors` can't be set from a `<meta>`; add it as a response header on your host.

Privacy Mode (header button or Settings) removes every amount from the DOM, including screen-reader text, and masks the amount fields.

## Backups

Browser storage can be cleared by you or, on some browsers, evicted after long inactivity. **Export a JSON backup now and then.** *Settings → Export JSON* is the full backup; *Export CSV* is for spreadsheets. Import previews first and offers Merge (by UUID, newer edit wins) or Replace.

## Tests

```sh
node --test tests/logic.test.mjs
```
