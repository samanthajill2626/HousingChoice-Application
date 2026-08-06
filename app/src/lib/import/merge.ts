// Merge 828 Quo contact rows + 40 Airtable landlords + 17 Airtable tenants +
// 80 orphan phone numbers into ONE reviewable person per phone (spec §2.3, §3.1).
//
// The merge key is the E.164 phone because our byPhone GSI is one contact per
// number. That is not a preference — a second contact on the same number is
// unreachable by the hottest lookup in the system (inbound phone -> person).
//
// Every judgment this module makes is a SUGGESTION that lands in the review
// workbook for the founder to overrule. Where it cannot decide (4 conflicting
// bed sizes, 33 unclassified names) it flags rather than guesses, which is the
// same rule auto-capture already follows: never record a guess as fact.

import type { ContactType } from '../../repos/contactsRepo.js';
import { contactIdForPhone, rowKey } from './ids.js';
import { bestDisplayName, parseName, voucherSizesSeen } from './names.js';
import { deriveStatus, DEFAULT_ACTIVE_WINDOW_DAYS } from './status.js';
import type { AirtableExport, AirtableLandlord, AirtableTenant } from './airtableSource.js';
import type { QuoContact, QuoExport } from './quoSource.js';
import type { ThreadIndex, TrafficStats } from './threads.js';

/**
 * Why a row needs the founder's eyes. These drive both the `needs_your_input`
 * column and the workbook sort order — flagged rows go to the top so she can
 * review ~150 of 543 and spot-check the rest.
 */
export type PersonFlag =
  | 'bed_size_conflict'
  | 'unclassified'
  | 'no_contact_record'
  | 'no_traffic'
  | 'star_marker'
  | 'caseworker'
  | 'non_person'
  | 'no_name'
  | 'no_inbound_consent'
  | 'opted_out'
  | 'airtable_only';

const FLAG_EXPLANATIONS: Readonly<Record<PersonFlag, string>> = {
  bed_size_conflict: 'Saved with two different voucher sizes - which is right?',
  star_marker: 'Name has a * - what does that mean?',
  caseworker: 'Looks like a caseworker - imported as a partner contact. Correct?',
  non_person: 'Looks like a test or system contact rather than a real person - drop it?',
  airtable_only: 'In Airtable but no Quo contact and no messages - still current?',
  unclassified: 'Could not tell tenant from landlord - which is it?',
  no_contact_record: 'You texted this number but never saved it - who is it?',
  opted_out: 'Sent STOP - imported with texting switched off',
  no_traffic: 'Saved contact with no messages or calls',
  no_name: 'No usable name in any source',
  no_inbound_consent: 'Never texted you first',
};

/**
 * How much a flag is worth ASKING HER about, which is not the same as how
 * unusual it is. Sorting by flag COUNT put anonymous one-message numbers (four
 * weak flags each) above a voucher-size conflict on a tenant with 100 messages —
 * exactly backwards for someone reviewing top-down with limited time.
 */
const FLAG_SEVERITY: Readonly<Record<PersonFlag, number>> = {
  bed_size_conflict: 100, // real person, real ambiguity, drives matching
  star_marker: 90, // decodes a convention covering 18 people
  caseworker: 70, // classification we cannot make for her
  non_person: 60,
  airtable_only: 50,
  unclassified: 40, // only worth asking when there is real traffic
  no_contact_record: 30, // ditto
  opted_out: 20, // informational: already handled correctly
  no_traffic: 15,
  no_name: 10,
  no_inbound_consent: 5,
};

/** Flags that are always worth her time, regardless of how busy the thread is. */
const ALWAYS_ASK: ReadonlySet<PersonFlag> = new Set<PersonFlag>([
  'bed_size_conflict',
  'star_marker',
  'caseworker',
  'non_person',
  'airtable_only',
]);

/**
 * Flags worth asking about ONLY when the relationship is substantial. Below the
 * threshold these people still import as `unknown`/`needs_review` and land in
 * the dashboard's in-app triage queue — which is the designed home for exactly
 * this, and a far better place to resolve them than a spreadsheet row.
 */
const ASK_IF_ENGAGED: ReadonlySet<PersonFlag> = new Set<PersonFlag>([
  'unclassified',
  'no_contact_record',
]);

/** Messages+calls at or above which an ASK_IF_ENGAGED flag earns her attention. */
const ENGAGEMENT_THRESHOLD = 5;

export interface MergedPerson {
  /** Workbook join column (`HC-0001`). Opaque on purpose — see ids.ts. */
  rowKey: string;
  /** Our deterministic contactId. */
  contactId: string;
  phone: string;

  suggestedName: string;
  suggestedType: ContactType;
  suggestedVoucherBeds?: number;
  suggestedStatus: string;

  /** Every raw name variant seen, for the workbook's evidence column. */
  rawNamesSeen: string[];
  /** Every Quo contact row that folded into this person. */
  quoContactIds: string[];
  /** All distinct voucher sizes parsed; length > 1 is a conflict. */
  voucherSizesSeen: number[];

  traffic: TrafficStats;
  flags: PersonFlag[];

  /** Structured enrichment when Airtable knew about this person. */
  airtableTenant?: AirtableTenant;
  airtableLandlord?: AirtableLandlord;

  hasStarMarker: boolean;
  optedOut: boolean;
}

export interface MergeResult {
  people: MergedPerson[];
  warnings: string[];
  stats: {
    quoContactRows: number;
    mergedPeople: number;
    duplicateRowsCollapsed: number;
    orphansAdded: number;
    airtableOnlyAdded: number;
    byType: Record<string, number>;
    flagged: number;
  };
}

interface Accumulator {
  phone: string;
  rawNames: string[];
  quoContactIds: string[];
  airtableTenant?: AirtableTenant;
  airtableLandlord?: AirtableLandlord;
  sawQuoContact: boolean;
}

export interface MergeOptions {
  /** The clock for status derivation. Defaults to the export's newest activity. */
  asOf?: string;
  activeWindowDays?: number;
  optOutPhones?: ReadonlySet<string>;
}

export function mergePeople(
  quo: QuoExport,
  airtable: AirtableExport,
  threads: ThreadIndex,
  options: MergeOptions = {},
): MergeResult {
  const warnings: string[] = [];
  const acc = new Map<string, Accumulator>();

  const get = (phone: string): Accumulator => {
    let a = acc.get(phone);
    if (!a) {
      a = { phone, rawNames: [], quoContactIds: [], sawQuoContact: false };
      acc.set(phone, a);
    }
    return a;
  };

  // --- Quo contacts (828 rows -> the bulk of the people) ---
  let skippedOwnNumber = 0;
  for (const c of quo.contacts) {
    if (!c.phone) continue; // unparseable/absent; already warned by the loader
    if (quo.ownNumbers.has(c.phone)) {
      // Self-contacts: 2 rows in the real export carry Sam's own Quo number.
      skippedOwnNumber += 1;
      continue;
    }
    const a = get(c.phone);
    a.sawQuoContact = true;
    a.quoContactIds.push(c.id);
    pushName(a, c);
  }
  if (skippedOwnNumber > 0) {
    warnings.push(`${skippedOwnNumber} Quo contacts carry the org's own number — skipped.`);
  }

  // --- orphan phones (traffic, no contact row) ---
  let orphansAdded = 0;
  for (const phone of threads.orphanPhones) {
    if (quo.ownNumbers.has(phone)) continue;
    if (!acc.has(phone)) orphansAdded += 1;
    get(phone);
  }

  // --- Airtable enrichment ---
  const quoContactById = new Map<string, QuoContact>();
  for (const c of quo.contacts) quoContactById.set(c.id, c);

  let airtableOnlyAdded = 0;
  for (const l of airtable.landlords) {
    const phone = l.phone ?? phoneFromQuoId(l.quoId, quoContactById);
    if (!phone || quo.ownNumbers.has(phone)) continue;
    const existed = acc.has(phone);
    const a = get(phone);
    if (!existed) airtableOnlyAdded += 1;
    // Airtable landlord names carry the same handshake convention; keep them as
    // name variants so the marker is picked up even when Quo's row lacks it.
    if (l.name) a.rawNames.push(l.name);
    // Several numbers carry 2+ different names in Airtable (7 in the real
    // export). First one wins for structured enrichment; every name still shows
    // in the workbook's evidence column so the founder can see the collision.
    a.airtableLandlord ??= l;
  }

  for (const t of airtable.tenants) {
    const phone = t.phone ?? phoneFromQuoId(t.quoId, quoContactById);
    if (!phone || quo.ownNumbers.has(phone)) continue;
    const existed = acc.has(phone);
    const a = get(phone);
    if (!existed) airtableOnlyAdded += 1;
    if (t.name) a.rawNames.push(t.name);
    a.airtableTenant ??= t;
  }

  // --- resolve each accumulator into a suggested person ---
  const asOf = options.asOf ?? newestActivity(threads) ?? new Date(0).toISOString();
  const optOutPhones = options.optOutPhones ?? new Set<string>();
  const activeWindowDays = options.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;

  const people: MergedPerson[] = [];
  for (const a of acc.values()) {
    const traffic = threads.traffic.get(a.phone) ?? {
      messageCount: 0,
      inboundMessageCount: 0,
      callCount: 0,
    };
    const sizes = voucherSizesSeen(a.rawNames);
    const parsed = a.rawNames.map(parseName);
    const hasStarMarker = parsed.some((p) => p.hasStarMarker);
    const optedOut = optOutPhones.has(a.phone);

    const suggestedType = classify(a, parsed, sizes);
    const suggestedName = resolveName(a);
    const suggestedVoucherBeds = resolveVoucherBeds(a, sizes);

    const flags: PersonFlag[] = [];
    if (sizes.length > 1) flags.push('bed_size_conflict');
    if (suggestedType === 'unknown') flags.push('unclassified');
    if (!a.sawQuoContact && traffic.messageCount + traffic.callCount > 0) {
      flags.push('no_contact_record');
    }
    if (traffic.messageCount + traffic.callCount === 0) flags.push('no_traffic');
    if (hasStarMarker) flags.push('star_marker');
    if (parsed.some((p) => p.isCaseworkerMarked) || isAirtableCaseworker(a.airtableTenant)) {
      flags.push('caseworker');
    }
    if (parsed.some((p) => p.isNonPerson)) flags.push('non_person');
    if (!suggestedName) flags.push('no_name');
    if (traffic.inboundMessageCount === 0 && traffic.callCount === 0) {
      flags.push('no_inbound_consent');
    }
    if (optedOut) flags.push('opted_out');
    if (!a.sawQuoContact && traffic.messageCount + traffic.callCount === 0) {
      flags.push('airtable_only');
    }

    people.push({
      rowKey: '', // assigned after sorting, so keys read top-to-bottom
      contactId: contactIdForPhone(a.phone),
      phone: a.phone,
      suggestedName,
      suggestedType,
      ...(suggestedVoucherBeds !== undefined && { suggestedVoucherBeds }),
      suggestedStatus: deriveStatus({
        type: suggestedType,
        ...(traffic.lastContactAt && { lastContactAt: traffic.lastContactAt }),
        asOf,
        activeWindowDays,
      }),
      rawNamesSeen: dedupe(a.rawNames),
      quoContactIds: a.quoContactIds,
      voucherSizesSeen: sizes,
      traffic,
      flags,
      ...(a.airtableTenant && { airtableTenant: a.airtableTenant }),
      ...(a.airtableLandlord && { airtableLandlord: a.airtableLandlord }),
      hasStarMarker,
      optedOut,
    });
  }

  // Sort by how much her answer is worth: severity of the strongest flag first,
  // then by engagement, then by recency. Reviewing top-down, she hits the real
  // questions in the first screenful and can stop whenever she runs out of time.
  people.sort((x, y) => {
    const px = reviewPriority(x);
    const py = reviewPriority(y);
    if (px !== py) return py - px;
    const ex = engagement(x);
    const ey = engagement(y);
    if (ex !== ey) return ey - ex;
    const xl = x.traffic.lastContactAt ?? '';
    const yl = y.traffic.lastContactAt ?? '';
    if (xl !== yl) return yl.localeCompare(xl);
    return x.phone.localeCompare(y.phone);
  });
  people.forEach((p, i) => {
    p.rowKey = rowKey('HC', i);
  });

  const byType: Record<string, number> = {};
  for (const p of people) byType[p.suggestedType] = (byType[p.suggestedType] ?? 0) + 1;

  // Duplicates collapsed is a statement about the QUO ROWS ONLY: how many
  // importable contact rows folded away. Measuring it against acc.size would be
  // wrong, because acc also holds orphans and Airtable-only people who never had
  // a Quo row to collapse — that understated the number by exactly those counts.
  const quoRowsWithPhone = quo.contacts.filter(
    (c) => c.phone && !quo.ownNumbers.has(c.phone),
  ).length;
  const distinctQuoPhones = new Set(
    quo.contacts.filter((c) => c.phone && !quo.ownNumbers.has(c.phone)).map((c) => c.phone!),
  ).size;

  return {
    people,
    warnings,
    stats: {
      quoContactRows: quo.contacts.length,
      mergedPeople: people.length,
      duplicateRowsCollapsed: quoRowsWithPhone - distinctQuoPhones,
      orphansAdded,
      airtableOnlyAdded,
      byType,
      // Must agree with the workbook's `needs_your_input` column — reporting a
      // different number than the sheet shows is how an operator loses trust in
      // both.
      flagged: people.filter((p) => needsFounderInput(p)).length,
    },
  };
}

/**
 * Push every name-ish field from a Quo contact row.
 *
 * `company` is included as a NAME variant, not an employer: Quo's export mirrors
 * a near-duplicate of the display name into it, so it is often the only place a
 * surname or a -Nbed suffix survives on a row whose firstName is blank.
 */
function pushName(a: Accumulator, c: QuoContact): void {
  if (c.displayName) a.rawNames.push(c.displayName);
  if (c.company) a.rawNames.push(c.company);
}

/**
 * Suggest a contact type.
 *
 * Precedence is deliberate: the handshake marker is the founder's own explicit
 * landlord signal and beats everything, including a -Nbed suffix that may be
 * left over from an earlier use of the same number. An unmarked, unsized contact
 * stays `unknown` — the honest answer, and it is what puts the row at the top of
 * her review list.
 */
function classify(
  a: Accumulator,
  parsed: readonly ReturnType<typeof parseName>[],
  sizes: readonly number[],
): ContactType {
  if (parsed.some((p) => p.isLandlordMarked)) return 'landlord';
  if (a.airtableLandlord) return 'landlord';
  if (parsed.some((p) => p.isCaseworkerMarked) || isAirtableCaseworker(a.airtableTenant)) {
    // No `caseworker` ContactType exists yet (docs/issues/caseworker-contact-type.md).
    // `partner` is the closest honest mapping and the workbook lets her correct it.
    return 'partner';
  }
  if (sizes.length > 0) return 'tenant';
  if (a.airtableTenant) return 'tenant';
  return 'unknown';
}

function isAirtableCaseworker(t: AirtableTenant | undefined): boolean {
  // The founder's own spelling in the Airtable `tenant type` column is
  // "Casewoker" — match loosely rather than correcting her data.
  return t !== undefined && /case\s*wo?rker/i.test(t.tenantType);
}

/** Prefer Airtable's typed name, then the longest Quo variant. */
function resolveName(a: Accumulator): string {
  const airtable = a.airtableTenant?.name ?? a.airtableLandlord?.name;
  if (airtable) {
    const { clean } = parseName(airtable);
    if (clean) return clean;
  }
  return bestDisplayName(a.rawNames);
}

/**
 * Resolve the voucher size.
 *
 * A single parsed size wins. A CONFLICT deliberately yields no suggestion: the
 * row is flagged and the founder fills it in. Guessing "the largest" or "the most
 * recent" here would bury a real question under a plausible-looking number, and
 * voucher size is the attribute that drives matching.
 */
function resolveVoucherBeds(a: Accumulator, sizes: readonly number[]): number | undefined {
  if (sizes.length === 1) return sizes[0];
  if (sizes.length === 0) {
    const fromAirtable = Number.parseInt(a.airtableTenant?.voucherSize ?? '', 10);
    return Number.isInteger(fromAirtable) && fromAirtable > 0 ? fromAirtable : undefined;
  }
  return undefined;
}

function phoneFromQuoId(
  quoId: string | undefined,
  byId: ReadonlyMap<string, QuoContact>,
): string | undefined {
  if (!quoId) return undefined;
  return byId.get(quoId)?.phone;
}

function newestActivity(threads: ThreadIndex): string | undefined {
  let newest: string | undefined;
  for (const s of threads.traffic.values()) {
    if (s.lastContactAt && (!newest || s.lastContactAt > newest)) newest = s.lastContactAt;
  }
  return newest;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Total two-way volume — the proxy for "is this a real relationship?". */
export function engagement(p: MergedPerson): number {
  return p.traffic.messageCount + p.traffic.callCount;
}

/**
 * Sort weight for the review workbook: the strongest flag's severity, nudged by
 * engagement so that among equally-flagged rows the busiest threads come first.
 * The nudge is capped well below one severity step so it can never reorder
 * across flag classes.
 */
export function reviewPriority(p: MergedPerson): number {
  const strongest = p.flags.reduce((max, f) => Math.max(max, FLAG_SEVERITY[f]), 0);
  const nudge = Math.min(9, Math.log10(engagement(p) + 1) * 4);
  return strongest + nudge;
}

/**
 * Does this row genuinely need the founder, or can the in-app triage queue
 * handle it? Keeping low-signal rows out of the workbook is what makes the
 * review a ~2-hour job instead of a 629-row slog.
 */
export function needsFounderInput(p: MergedPerson): boolean {
  if (p.flags.some((f) => ALWAYS_ASK.has(f))) return true;
  return p.flags.some((f) => ASK_IF_ENGAGED.has(f)) && engagement(p) >= ENGAGEMENT_THRESHOLD;
}

/**
 * The read-only `why` column: the questions we are actually asking, strongest
 * first. Informational flags are deliberately EXCLUDED once a real question is
 * present — an orphan number was previously getting four clauses that all
 * restated "we do not know who this is", which buried the one that mattered.
 */
export function explainFlags(flags: readonly PersonFlag[]): string {
  const ranked = [...flags].sort((a, b) => FLAG_SEVERITY[b] - FLAG_SEVERITY[a]);
  const questions = ranked.filter((f) => ALWAYS_ASK.has(f) || ASK_IF_ENGAGED.has(f));
  const chosen = questions.length > 0 ? questions : ranked;
  return chosen.map((f) => FLAG_EXPLANATIONS[f]).join('; ');
}
