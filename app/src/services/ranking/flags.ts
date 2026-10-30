// Unlawful fair-housing flags as PROPERTY records (WP1 B2a spec D10; charter
// 7.2). The ranking job raises them (runBatch.ts); the read (readRanking.ts),
// the run detail (routes/adminRankings.ts) and the property page's notice
// (propertyFlags.ts) ask whether each is still OPEN, all through openFlags.
// Open is derived on read, never stored: the flagged field is on the
// property's CURRENT card and its trimmed text there still hashes to the
// stored textHash. So no unit writer knows about flags - an edit to the text
// closes one by construction, and a `landlord:<key>` flag closes when the
// landlord default leaves the card (switch off, or the property now records
// its own value). A closed record is replaced if the model raises it again
// (rankingRunsRepo.putFlagIfAbsentOrClosed, conditioned on the hash).
//
// Dismissal (dismissedAt / dismissedBy / textAtDismiss) is B4's and is
// DISPLAY-ONLY (charter 7.2): it never closes a flag here, so the cap stays
// suppressed while the text stands.
//
// Accommodation flags are never property records: they stay on the pair's
// match only.
//
// The record's `reason` is ALWAYS DEFAULT_FLAG_REASON (spec D10 rev 7,
// charter item 15): the model's against-reasons and unknowns describe the
// PAIR - often the tenant's own facts - and a property record has no TTL and
// is shown for every later tenant. The pair's own text stays on its match and
// its run.
import { createHash } from 'node:crypto';
import type { UnlawfulFlagInput, UnlawfulFlagRecord } from '../../repos/rankingRunsRepo.js';
import type { ParsedCandidate } from './parse.js';

/** The one reason every unlawful-flag record stores (spec D10 rev 7). */
export const DEFAULT_FLAG_REASON = 'flagged as a requirement fair housing does not allow';

/** sha256 hex of the field's TRIMMED text - the stamp a flag is raised with. */
export function textHashOf(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

/** The trimmed card text of a field, or undefined when the card holds none. */
function cardText(freeTextByField: Readonly<Record<string, string>>, field: string): string | undefined {
  const raw = freeTextByField[field];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** D10 "open": the field is on the current card and its text still hashes to textHash. */
export function isFlagOpen(
  flag: Pick<UnlawfulFlagRecord, 'field' | 'textHash'>,
  freeTextByField: Readonly<Record<string, string>>,
): boolean {
  const text = cardText(freeTextByField, flag.field);
  return text !== undefined && textHashOf(text) === flag.textHash;
}

export function openFlags(
  records: readonly UnlawfulFlagRecord[],
  freeTextByField: Readonly<Record<string, string>>,
): UnlawfulFlagRecord[] {
  return records.filter((record) => isFlagOpen(record, freeTextByField));
}

/** The fields of the open records, each once, in record order. */
export function openFlagFields(
  records: readonly UnlawfulFlagRecord[],
  freeTextByField: Readonly<Record<string, string>>,
): string[] {
  return [...new Set(openFlags(records, freeTextByField).map((record) => record.field))];
}

/**
 * The job-wide merge (D10: "merged across a job's batches by property and
 * field"). `raised` is the job's map, keyed `${unitId}#${field}`; the FIRST
 * raising run keeps its entry. Returns only the flags this call newly added -
 * the ones the calling batch writes. A field that holds no text on the card is
 * skipped (parse already drops such a flag and counts it; this keeps a record
 * from ever carrying the hash of nothing). Every entry's reason is
 * DEFAULT_FLAG_REASON: no pair text reaches the record (spec D10 rev 7).
 */
export function mergeRaisedFlags(
  raised: Map<string, UnlawfulFlagInput>,
  scored: Array<{ unitId: string; freeTextByField: Readonly<Record<string, string>>; result: ParsedCandidate }>,
  run: { runId: string; raisedAt: string },
): UnlawfulFlagInput[] {
  const added: UnlawfulFlagInput[] = [];
  for (const { unitId, freeTextByField, result } of scored) {
    for (const flag of result.fairHousingFlags) {
      if (flag.kind !== 'unlawful') continue;
      const key = `${unitId}#${flag.field}`;
      if (raised.has(key)) continue;
      const text = cardText(freeTextByField, flag.field);
      if (text === undefined) continue;
      const entry: UnlawfulFlagInput = {
        unitId,
        field: flag.field,
        textHash: textHashOf(text),
        reason: DEFAULT_FLAG_REASON,
        runId: run.runId,
        raisedAt: run.raisedAt,
      };
      raised.set(key, entry);
      added.push(entry);
    }
  }
  return added;
}
