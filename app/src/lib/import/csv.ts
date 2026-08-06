// RFC 4180 CSV parse + serialize for the M1.6 import (spec §4).
//
// A local parser rather than a dependency: the format is small and the quirks we
// must handle are already known from profiling the real exports, so they are
// directly testable here.
//
//   - UTF-8 BOM. Every Airtable export carries one; Quo's do not.
//   - Embedded newlines inside quoted fields. 4,180 of the 22,035 physical lines
//     in the Quo messages export are continuations of a multi-line message body —
//     a line-splitting parser silently mangles ~19% of the corpus.
//   - Doubled quotes ("") as an escaped quote, including in Airtable's
//     '"""1425 Joseph E Boone Blvd NW, Unit 104, Atlanta, GA 30314"""'.
//   - Ragged rows. Airtable emits trailing empty columns inconsistently; a short
//     row yields '' for the missing fields rather than throwing.
//
// Pure functions, no I/O.

/** A parsed row keyed by header name. Values are always strings (never undefined). */
export type CsvRow = Record<string, string>;

export interface ParsedCsv {
  /** Header names in file order (duplicates preserved as-is — see parseCsv). */
  header: string[];
  rows: CsvRow[];
}

/**
 * Parse CSV text into header + row objects.
 *
 * Blank lines are skipped. A row with fewer fields than the header gets ''
 * for the remainder; extra fields beyond the header are dropped (no export we
 * handle produces them, and inventing 'column_7' keys would hide a real defect).
 *
 * Duplicate header names: the LAST occurrence wins for row objects, which
 * matches how a spreadsheet round-trip behaves. The Airtable tenants export has
 * two 'Notes'-ish columns and one literal duplicate ('Tenants Table copy'), so
 * this is exercised by real data. `header` keeps every occurrence so a caller
 * can detect the situation.
 */
export function parseCsv(text: string): ParsedCsv {
  const fields = tokenize(stripBom(text));
  if (fields.length === 0) return { header: [], rows: [] };

  const header = fields[0]!;
  const rows: CsvRow[] = [];
  for (let i = 1; i < fields.length; i++) {
    const raw = fields[i]!;
    // Skip blank lines (a single empty field and nothing else).
    if (raw.length === 1 && raw[0]!.trim() === '') continue;
    const row: CsvRow = {};
    for (let c = 0; c < header.length; c++) row[header[c]!] = raw[c] ?? '';
    rows.push(row);
  }
  return { header, rows };
}

/** Strip a leading UTF-8 BOM (U+FEFF), which every Airtable export carries. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split CSV text into an array of records, each an array of raw field strings.
 * Handles quoted fields containing commas, CR/LF and doubled quotes.
 */
function tokenize(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      // Newlines inside quotes are literal content, not a record break.
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 2;
      continue;
    }
    if (ch === '\r') {
      // A LONE CR IS CONTENT, NOT A RECORD BREAK. The Quo messages export is
      // LF-terminated and contains 18 bare CRs sitting inside unquoted message
      // bodies — trailing whitespace in what a tenant typed. Treating those as
      // terminators (the classic pre-OSX Mac reading) split 15 real messages in
      // half, which surfaced as rows with an empty direction and manufactured a
      // phantom contact out of each tail. Verified against the real export:
      // 173 CR total, 155 of them CRLF, 18 lone.
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Trailing record without a final newline.
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/**
 * Serialize rows to CSV text with the given column order.
 *
 * Quoting rule: a field is quoted when it contains a comma, quote, CR or LF, or
 * has leading/trailing whitespace that would otherwise be lost. We deliberately
 * do NOT quote defensively everywhere — the founder opens this in a spreadsheet
 * and an all-quoted file reads badly in a plain text editor when she inspects it.
 *
 * Line ending is CRLF (RFC 4180, and what Excel expects on Windows).
 */
export function serializeCsv(columns: readonly string[], rows: readonly CsvRow[]): string {
  const lines: string[] = [columns.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(row[c] ?? '')).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function escapeField(value: string): string {
  const needsQuotes =
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim();
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
