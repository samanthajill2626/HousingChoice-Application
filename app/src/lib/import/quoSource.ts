// Load + normalize the Quo export (spec §2.1).
//
// Quo emits ONE export job per entity, each into its own directory whose name is
// an opaque job id, and each job redundantly re-exports users + phone_numbers.
// So the layout on disk is:
//
//   <root>/<jobId>/<orgId>_contacts.csv        828 rows
//   <root>/<jobId>/<orgId>_messages.csv     17,854 rows
//   <root>/<jobId>/<orgId>_calls.csv         1,571 rows
//   <root>/<jobId>/<orgId>_{users,phone_numbers}.csv   (in every job)
//
// We glob by FILENAME SUFFIX rather than trusting the directory names, because
// the job ids change on every export and the founder will re-export before
// cutover. A missing entity file is an error, not an empty import — silently
// importing zero messages would read as success.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeToE164 } from '../phone.js';
import { parseCsv, type CsvRow } from './csv.js';

export interface QuoUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
}

export interface QuoPhoneNumber {
  id: string;
  number: string;
  sid: string;
  entityId: string;
  name: string;
}

export interface QuoContact {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  company: string;
  /** E.164, or undefined when absent/unparseable (2 malformed in the real export). */
  phone?: string;
  /** The raw phone string as exported, kept for the workbook's evidence columns. */
  rawPhone: string;
  email?: string;
  /** Every name-ish field joined for marker detection ("firstName lastName"). */
  displayName: string;
  /** Derived from the Mongo ObjectId prefix — Quo exports no created_at column. */
  createdAt: string;
}

export interface QuoMessage {
  id: string;
  conversationId: string;
  body: string;
  /** ISO 8601. `sentAt` is blank on 93.7% of rows, so `createdAt` is the clock. */
  createdAt: string;
  to: string[];
  from: string;
  direction: 'incoming' | 'outgoing';
}

export interface QuoCall {
  id: string;
  conversationId: string;
  durationSeconds: number;
  createdAt: string;
  to: string;
  from: string;
  direction: 'incoming' | 'outgoing';
}

export interface QuoExport {
  user: QuoUser;
  /** The org's own numbers — every one of these is "us", never a counterparty. */
  ownNumbers: Set<string>;
  contacts: QuoContact[];
  messages: QuoMessage[];
  calls: QuoCall[];
  /** Non-fatal data problems worth reporting in the plan summary. */
  warnings: string[];
}

/** Recursively collect files under `root` whose name ends with `suffix`. */
function findBySuffix(root: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(suffix)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Read the single file matching `suffix`. Every Quo job re-exports users and
 * phone_numbers identically, so for those we take the first and ignore the rest;
 * for entity files more than one match means an ambiguous export directory
 * (e.g. two exports unpacked on top of each other) and we refuse to guess.
 */
function readOne(root: string, suffix: string, opts: { allowDuplicates?: boolean } = {}): CsvRow[] {
  const matches = findBySuffix(root, suffix);
  if (matches.length === 0) {
    throw new Error(
      `Quo export is missing a *${suffix} file under ${root}. ` +
        `Expected the three export jobs (contacts, messages, calls) unpacked side by side.`,
    );
  }
  if (matches.length > 1 && !opts.allowDuplicates) {
    throw new Error(
      `Found ${matches.length} *${suffix} files under ${root}; expected exactly one. ` +
        `Two exports unpacked into the same directory? Paths:\n  ${matches.join('\n  ')}`,
    );
  }
  return parseCsv(readFileSync(matches[0]!, 'utf8')).rows;
}

/**
 * Mongo ObjectId -> creation timestamp. The first 4 bytes are seconds since the
 * epoch, which recovers a created_at Quo does not export (contacts reach back to
 * 2026-01-08, three months before the earliest exported message).
 */
export function objectIdTimestamp(id: string): string | undefined {
  if (!/^[0-9a-f]{24}$/i.test(id)) return undefined;
  const seconds = Number.parseInt(id.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** Split a `to` cell into E.164 numbers. Multi-recipient rows are comma-joined. */
function splitRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeDirection(raw: string): 'incoming' | 'outgoing' | undefined {
  const v = raw.trim().toLowerCase();
  if (v === 'incoming' || v === 'inbound') return 'incoming';
  if (v === 'outgoing' || v === 'outbound') return 'outgoing';
  return undefined;
}

export function loadQuoExport(root: string): QuoExport {
  const warnings: string[] = [];

  const userRows = readOne(root, '_users.csv', { allowDuplicates: true });
  if (userRows.length === 0) throw new Error('Quo users export is empty.');
  if (userRows.length > 1) {
    warnings.push(
      `Quo export lists ${userRows.length} users; the import assumes a single-operator org. ` +
        `Threads belonging to other users may be missing from this export.`,
    );
  }
  const u = userRows[0]!;
  const user: QuoUser = {
    id: u.id ?? '',
    email: (u.email ?? '').trim(),
    firstName: (u.firstName ?? '').trim(),
    lastName: (u.lastName ?? '').trim(),
    role: (u.role ?? '').trim(),
    status: (u.status ?? '').trim(),
  };

  const numberRows = readOne(root, '_phone_numbers.csv', { allowDuplicates: true });
  const ownNumbers = new Set<string>();
  for (const row of numberRows) {
    const e164 = normalizeToE164(row.number ?? '');
    if (e164) ownNumbers.add(e164);
  }
  if (ownNumbers.size === 0) throw new Error('Quo export lists no org phone number.');

  // --- contacts ---
  const contacts: QuoContact[] = [];
  for (const row of readOne(root, '_contacts.csv')) {
    const rawPhone = (row.phone_number_1 ?? '').trim();
    const phone = rawPhone ? normalizeToE164(rawPhone) : undefined;
    if (rawPhone && !phone) {
      warnings.push(`Contact ${row.id}: unparseable phone ${JSON.stringify(rawPhone)} — skipped.`);
    }
    const first = (row.firstName ?? '').trim();
    const last = (row.lastName ?? '').trim();
    const displayName = `${first} ${last}`.replace(/\s+/g, ' ').trim();
    const email = (row.email_1 ?? '').trim();
    contacts.push({
      id: row.id ?? '',
      userId: row.userId ?? '',
      firstName: first,
      lastName: last,
      // `company` is NOT an employer — Quo's export mirrors a near-duplicate of
      // the display name into it ("L'Oreal Cleveland-4bed"). Kept only as a name
      // fallback; never imported as an organization (spec §2.3).
      company: (row.company ?? '').trim(),
      ...(phone && { phone }),
      rawPhone,
      ...(email && { email }),
      displayName,
      createdAt: objectIdTimestamp(row.id ?? '') ?? '',
    });
  }

  // --- messages ---
  const messages: QuoMessage[] = [];
  let badDirection = 0;
  for (const row of readOne(root, '_messages.csv')) {
    const direction = normalizeDirection(row.direction ?? '');
    if (!direction) {
      badDirection += 1;
      continue;
    }
    const createdAt = (row.createdAt ?? '').trim();
    if (!createdAt) continue;
    messages.push({
      id: row.id ?? '',
      conversationId: (row.conversationId ?? '').trim(),
      body: row.body ?? '',
      createdAt,
      to: splitRecipients(row.to ?? ''),
      from: (row.from ?? '').trim(),
      direction,
    });
  }
  if (badDirection > 0) {
    warnings.push(`${badDirection} message rows had an unrecognized direction and were skipped.`);
  }

  // --- calls ---
  const calls: QuoCall[] = [];
  for (const row of readOne(root, '_calls.csv')) {
    const direction = normalizeDirection(row.direction ?? '');
    if (!direction) continue;
    const createdAt = (row.createdAt ?? '').trim();
    if (!createdAt) continue;
    calls.push({
      id: row.id ?? '',
      conversationId: (row.conversationId ?? '').trim(),
      durationSeconds: Number.parseInt(row.duration ?? '0', 10) || 0,
      createdAt,
      to: (row.to ?? '').trim(),
      from: (row.from ?? '').trim(),
      direction,
    });
  }

  return { user, ownNumbers, contacts, messages, calls, warnings };
}

/**
 * The counterparties on one message — every participant that is not us.
 *
 * Inbound group MMS lists our own number among the recipients (1,773 of the
 * 1,773 inbound multi-`to` rows in the real export do), which is how we know she
 * is using carrier group messaging today. Filtering own-numbers from BOTH ends
 * yields the true outside-participant set regardless of direction.
 */
export function counterpartiesOf(
  msg: Pick<QuoMessage, 'to' | 'from' | 'direction'>,
  ownNumbers: ReadonlySet<string>,
): string[] {
  const all = msg.direction === 'outgoing' ? msg.to : [...msg.to, msg.from];
  const out: string[] = [];
  for (const raw of all) {
    const e164 = normalizeToE164(raw);
    if (e164 && !ownNumbers.has(e164) && !out.includes(e164)) out.push(e164);
  }
  return out;
}
