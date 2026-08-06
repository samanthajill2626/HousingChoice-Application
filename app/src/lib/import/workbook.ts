// The review workbook: three CSVs the founder edits, and the contract
// import:apply reads back (spec §3.3).
//
// Division of authority is absolute. The WORKBOOK is authoritative for every
// human-judgment field (name, type, status, voucher size, whether to import at
// all, which groups go live). The RAW EXPORT is authoritative for everything
// mechanical (message bodies, timestamps, directions, durations, membership).
// That split is why she reviews ~150 decisions instead of 17,854 messages.
//
// THE JOIN COLUMN IS `row_key`, NEVER `phone`. Excel reads a leading `+` in an
// E.164 cell as a formula and hands back a bare integer, so a phone-keyed join
// would silently corrupt on every row she touches. `phone` is display-only, and
// a phone that disagrees with the one we issued for a row_key is a flagged
// conflict for a human — never a silent trust of either value.

import { parseCsv, serializeCsv, type CsvRow } from './csv.js';
import { explainFlags, needsFounderInput, type MergedPerson } from './merge.js';
import {
  baseAddressKey,
  bestSpelling,
  findUnitAmbiguousKeys,
  looseAddressKey,
  type AddressCandidate,
} from './addresses.js';
import type { AirtableProperty } from './airtableSource.js';
import type { ImportedThread } from './threads.js';
import { rowKey } from './ids.js';

export const CONTACTS_FILE = 'contacts.csv';
export const GROUPS_FILE = 'groups.csv';
export const UNITS_FILE = 'units.csv';

/** Editable columns. Everything else in the file is read-only evidence. */
export const CONTACT_EDITABLE = ['name', 'type', 'voucher_beds', 'status', 'drop', 'notes'] as const;

export const CONTACT_COLUMNS = [
  'row_key',
  'needs_your_input',
  'change',
  // --- editable ---
  'name',
  'type',
  'voucher_beds',
  'status',
  'drop',
  'notes',
  // --- read-only evidence ---
  'why',
  'phone',
  'last_contact',
  'messages',
  'calls',
  'quo_names_seen',
  'airtable_program',
  'airtable_caseworker_org',
  'airtable_note',
] as const;

export const GROUP_COLUMNS = [
  'row_key',
  'needs_your_input',
  'change',
  // --- editable ---
  'connect_day_one',
  'label',
  'notes',
  // --- read-only evidence ---
  'why',
  'participants',
  'participant_phones',
  'messages',
  'last_activity',
  'composition',
] as const;

export const UNIT_COLUMNS = [
  'row_key',
  'needs_your_input',
  'change',
  // --- editable ---
  'address',
  'landlord_name',
  'beds',
  'baths',
  'status',
  'housing_authority',
  'drop',
  'notes',
  // --- read-only evidence ---
  'why',
  'source',
  'times_texted',
  'threads',
  'last_seen',
  'also_written_as',
] as const;

/** How a row compares to the previously reviewed workbook (spec §3.3). */
export type ChangeMark = 'new' | 'unchanged' | 'conflict' | '';

export interface WorkbookSheets {
  contacts: CsvRow[];
  groups: CsvRow[];
  units: CsvRow[];
}

/** A previously reviewed workbook, keyed by row_key, used for carry-forward. */
export interface PriorReview {
  contacts: Map<string, CsvRow>;
  groups: Map<string, CsvRow>;
  units: Map<string, CsvRow>;
  /** row_key -> phone as issued in the PRIOR run, for identity checks. */
  contactPhones: Map<string, string>;
}

const YES = 'YES';

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildContactRows(people: readonly MergedPerson[], prior?: PriorReview): CsvRow[] {
  return people.map((p) => {
    const suggested: CsvRow = {
      row_key: p.rowKey,
      needs_your_input: needsFounderInput(p) ? YES : '',
      change: '',
      name: p.suggestedName,
      type: p.suggestedType,
      voucher_beds: p.suggestedVoucherBeds === undefined ? '' : String(p.suggestedVoucherBeds),
      status: p.suggestedStatus,
      drop: '',
      notes: '',
      why: explainFlags(p.flags),
      phone: p.phone,
      last_contact: (p.traffic.lastContactAt ?? '').slice(0, 10),
      messages: String(p.traffic.messageCount),
      calls: String(p.traffic.callCount),
      quo_names_seen: p.rawNamesSeen.join(' | '),
      airtable_program: p.airtableTenant?.voucherProgram ?? '',
      airtable_caseworker_org: p.airtableTenant?.caseworkerOrganization ?? '',
      airtable_note: p.airtableTenant?.note.replace(/\s+/g, ' ').trim() ?? '',
    };
    return applyCarryForward(suggested, prior?.contacts, CONTACT_EDITABLE, {
      priorPhone: prior?.contactPhones.get(p.rowKey),
      currentPhone: p.phone,
    });
  });
}

export function buildGroupRows(threads: readonly ImportedThread[], prior?: PriorReview): CsvRow[] {
  const groups = threads.filter((t) => t.isGroup);
  return groups.map((t, i) => {
    const suggested: CsvRow = {
      row_key: rowKey('GRP', i),
      // Every group needs a yes/no on day-one connection, so all of them are
      // "your input" — but they are cheap: the default N is almost always right.
      needs_your_input: YES,
      change: '',
      connect_day_one: 'N',
      label: '',
      notes: '',
      why: 'Group texting changes at cutover - connect only what must work on day one',
      participants: String(t.participants.length),
      participant_phones: t.participants.join(' | '),
      messages: String(t.messages.length),
      last_activity: t.lastActivityAt.slice(0, 10),
      composition: '',
    };
    return applyCarryForward(suggested, prior?.groups, ['connect_day_one', 'label', 'notes']);
  });
}

/**
 * One workbook row per PROPERTY, not per address spelling.
 *
 * Airtable rows and mined spellings that share a property key fold into a single
 * row: the Airtable record (a property she already confirmed) wins the editable
 * fields, and the mined evidence contributes the send counts that tell her how
 * active it is. Every spelling seen is listed read-only so the fold is visible
 * and checkable rather than something she has to take on faith.
 */
interface PropertyGroup {
  key: string;
  airtable?: AirtableProperty;
  mined: AddressCandidate[];
  spellings: string[];
}

export function buildUnitRows(
  properties: readonly AirtableProperty[],
  mined: readonly AddressCandidate[],
  prior?: PriorReview,
  options: { minSendCount?: number } = {},
): CsvRow[] {
  const minSendCount = options.minSendCount ?? 1;
  const groups = new Map<string, PropertyGroup>();
  const group = (address: string): PropertyGroup => {
    const key = looseAddressKey(address);
    let g = groups.get(key);
    if (!g) {
      g = { key, mined: [], spellings: [] };
      groups.set(key, g);
    }
    if (address && !g.spellings.includes(address)) g.spellings.push(address);
    return g;
  };

  for (const p of properties) {
    const g = group(p.address);
    g.airtable ??= p;
  }
  for (const c of mined) group(c.display).mined.push(c);

  const ambiguous = findUnitAmbiguousKeys(groups.keys());

  const rows: CsvRow[] = [];
  for (const g of groups.values()) {
    const sendCount = g.mined.reduce((s, c) => s + c.sendCount, 0);
    const threadCount = g.mined.reduce((s, c) => s + c.threadCount, 0);

    // A property she confirmed in Airtable is always offered. A purely mined one
    // must clear the relevance threshold on its COMBINED send count across every
    // spelling.
    if (!g.airtable && sendCount < minSendCount) continue;
    const lastSeen = g.mined.map((c) => c.lastSeenAt).sort().pop() ?? '';
    const source = g.airtable
      ? g.mined.length > 0
        ? 'airtable+texts'
        : 'airtable'
      : 'found-in-texts';

    const why: string[] = [];
    if (!g.airtable) {
      why.push(
        `Found in ${sendCount} of your sent texts across ${threadCount} conversations - is this a property?`,
      );
    }
    if (ambiguous.has(g.key)) {
      const siblings = [...groups.keys()].filter(
        (k) => k !== g.key && baseAddressKey(k) === g.key,
      );
      why.push(
        `You also text this address WITH a unit number (${siblings.length} of them) - ` +
          `is this row the building, or one of those units?`,
      );
    }

    rows.push({
      row_key: '',
      needs_your_input: why.length > 0 ? YES : '',
      change: '',
      address: g.airtable?.address ?? bestSpelling(g.spellings),
      landlord_name: g.airtable?.landlord ?? '',
      beds: g.airtable?.beds ?? '',
      baths: g.airtable?.bathrooms ?? '',
      status: g.airtable?.availableStatus ?? '',
      housing_authority: g.airtable?.voucherType ?? '',
      drop: '',
      notes: '',
      why: why.join('; '),
      source,
      times_texted: sendCount > 0 ? String(sendCount) : '',
      threads: threadCount > 0 ? String(threadCount) : '',
      last_seen: lastSeen.slice(0, 10),
      also_written_as: g.spellings.length > 1 ? g.spellings.join(' | ') : '',
    });
  }

  // Confirmed properties first, then by how often she texts the address — the
  // top of this tab is her active inventory.
  rows.sort((a, b) => {
    const aConfirmed = (a.source ?? '').startsWith('airtable') ? 1 : 0;
    const bConfirmed = (b.source ?? '').startsWith('airtable') ? 1 : 0;
    if (aConfirmed !== bConfirmed) return bConfirmed - aConfirmed;
    return Number(b.times_texted || 0) - Number(a.times_texted || 0);
  });

  rows.forEach((r, i) => {
    r.row_key = rowKey('UNIT', i);
  });
  return rows.map((r) =>
    applyCarryForward(r, prior?.units, [
      'address',
      'landlord_name',
      'beds',
      'baths',
      'status',
      'housing_authority',
      'drop',
      'notes',
    ]),
  );
}

/**
 * Carry a prior review forward onto a freshly generated row (spec §3.3).
 *
 * Without this the founder reviews 543 rows twice — once against the 2026-08-05
 * export and again against the cutover export. With it she reviews a diff:
 * between now and 8/10 that is expected to be 20-40 genuinely new people.
 *
 * Rules:
 *   - no prior row               -> `change: new`, keep our suggestions
 *   - prior row, edits preserved -> `change: unchanged`, her values win
 *   - identity disagreement      -> `change: conflict`, flagged for a human
 */
function applyCarryForward(
  row: CsvRow,
  priorRows: ReadonlyMap<string, CsvRow> | undefined,
  editable: readonly string[],
  identity?: { priorPhone?: string; currentPhone: string },
): CsvRow {
  if (!priorRows) return row;
  const prior = priorRows.get(row.row_key ?? '');
  if (!prior) return { ...row, change: 'new' };

  // The row_key is a POSITION-derived key, so a changed export can slide a
  // different person onto the same key. Verifying the phone catches that, and it
  // is the reason we keep phone in the file at all.
  if (identity?.priorPhone && identity.priorPhone !== identity.currentPhone) {
    return {
      ...row,
      change: 'conflict',
      needs_your_input: YES,
      why:
        `${row.why ?? ''}${row.why ? '; ' : ''}` +
        `This row key held a different phone in the last review (${identity.priorPhone}) - ` +
        `your earlier edits were NOT carried over`,
    };
  }

  const merged: CsvRow = { ...row, change: 'unchanged' };
  for (const col of editable) {
    const priorValue = prior[col];
    if (priorValue !== undefined && priorValue !== '') merged[col] = priorValue;
  }
  // She has reviewed it; stop demanding attention unless something new fired.
  if (merged.needs_your_input === YES && prior.needs_your_input === YES) {
    merged.needs_your_input = '';
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Read back
// ---------------------------------------------------------------------------

export function serializeWorkbook(sheets: WorkbookSheets): Record<string, string> {
  return {
    [CONTACTS_FILE]: serializeCsv(CONTACT_COLUMNS, sheets.contacts),
    [GROUPS_FILE]: serializeCsv(GROUP_COLUMNS, sheets.groups),
    [UNITS_FILE]: serializeCsv(UNIT_COLUMNS, sheets.units),
  };
}

/** Load a reviewed (or previously generated) workbook for carry-forward or apply. */
export function parseWorkbook(files: {
  contacts?: string;
  groups?: string;
  units?: string;
}): PriorReview {
  const index = (text: string | undefined): Map<string, CsvRow> => {
    const map = new Map<string, CsvRow>();
    if (!text) return map;
    for (const row of parseCsv(text).rows) {
      const key = (row.row_key ?? '').trim();
      if (key) map.set(key, row);
    }
    return map;
  };

  const contacts = index(files.contacts);
  const contactPhones = new Map<string, string>();
  for (const [key, row] of contacts) {
    const phone = (row.phone ?? '').trim();
    if (phone) contactPhones.set(key, phone);
  }

  return { contacts, groups: index(files.groups), units: index(files.units), contactPhones };
}

/** True when the founder marked this row to be excluded from the import. */
export function isDropped(row: CsvRow): boolean {
  return /^(y|yes|true|1|x)$/i.test((row.drop ?? '').trim());
}

/** True when the founder asked for this group to go live at cutover. */
export function wantsDayOneConnect(row: CsvRow): boolean {
  return /^(y|yes|true|1|x)$/i.test((row.connect_day_one ?? '').trim());
}
