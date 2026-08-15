// CSV serialization for spreadsheet-facing exports (Wave 3 3d / #5B-a). Client-safe pure
// functions (no I/O), unit-tested. Two orthogonal concerns:
//
//  1. CSV SYNTAX — a value containing a comma, double-quote, CR or LF must be double-quoted
//     with internal quotes doubled, or it breaks the row/field structure.
//  2. SPREADSHEET FORMULA INJECTION — Excel / Google Sheets treat a cell whose first character
//     is = + - @ (or a leading tab / CR / LF that hides one) as a FORMULA, so member-supplied
//     text like `=HYPERLINK("http://evil","click")` would execute on open. Neutralize it by
//     prefixing a single quote so the spreadsheet shows the literal text.
//
// This neutralization is also why the export is NOT a lossless re-import format (a neutralized
// cell no longer equals its source) — see server/services/memberExportService.ts.

// ASCII formula leads plus their full-width CJK counterparts (＝＋－＠): this is a
// Traditional-Chinese dataset, and OWASP notes some locales/apps evaluate the full-width forms.
const FORMULA_LEAD = /^[=+\-@＝＋－＠\t\r\n]/

// Prefix a spreadsheet-dangerous cell with ' (applied BEFORE CSV quoting).
export function neutralizeSpreadsheetCell(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value
}

// Quote a field iff it needs it (comma / quote / CR / LF), doubling internal quotes.
export function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

const BOM = '﻿'

// Build a spreadsheet-friendly CSV: UTF-8 BOM (so Excel reads CJK as UTF-8), CRLF rows, every
// cell neutralized then escaped. `rows` are string[][] the caller has already stringified.
export function toSpreadsheetCsv(headers: string[], rows: string[][]): string {
  const line = (r: string[]) => r.map(v => escapeCsvCell(neutralizeSpreadsheetCell(v))).join(',')
  return BOM + [headers, ...rows].map(line).join('\r\n') + '\r\n'
}

// The download filename for the roster export, parsed from the (same-origin) response's
// Content-Disposition. Accepts ONLY our own generated shape (members-YYYYMMDD.csv), so a
// surprising or malformed header can't drive the saved filename — anything else → members.csv.
// (A blob: download does NOT inherit Content-Disposition, so the client must set a.download.)
export function parseExportFilename(contentDisposition: string | null): string {
  const m = contentDisposition?.match(/filename="?(members-\d{8}\.csv)"?/)
  return m ? m[1] : 'members.csv'
}
