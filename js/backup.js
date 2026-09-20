// backup.js — turning data into files the person can keep: the CSV builder and the download helper.
// (The JSON backup document itself, and everything about importing it, lives in store.js.)

import { labelFor } from './schema.js';
import { decimalsFor, minorToDecimalString } from './money.js';

const CSV_HEADER = ['date', 'type', 'main category', 'sub-category', 'amount', 'note'];

// Spreadsheets run text that starts with = + - @ as a formula. Prefix a quote so a note
// like "=HYPERLINK(...)" stays plain text when someone opens the export in Excel or Sheets.
const defuse = (text) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

const csvCell = (text) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/**
 * CSV of every non-deleted transaction, oldest first: date, type, main category, sub-category,
 * amount, note. Amounts are plain decimals ("1250.00", "50000"), with no symbol or separators.
 */
export function buildCsv({ categories, transactions }) {
  const rows = transactions
    .filter((t) => !t.deleted)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .map((t) => {
      const label = labelFor(categories, t.categoryId, t.subCategoryId);
      return [
        t.date,
        t.type === 'income' ? 'Income' : 'Expense',
        defuse(label.main),
        defuse(label.sub ?? ''),
        minorToDecimalString(t.amount, decimalsFor(t.currency)),
        defuse(t.note),
      ];
    });
  const lines = [CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(','));
  // The BOM makes Excel read the file as UTF-8, so emoji and accents in notes survive.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Local date as YYYY-MM-DD, for file names. */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Save text as a file through the browser. Nothing is uploaded anywhere. */
export function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
