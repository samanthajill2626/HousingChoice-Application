// Unlawful fair-housing flags as PROPERTY records (WP1 B2a spec D10; charter
// 7.2). The ranking job raises them (runBatch.ts); the read (readRanking.ts)
// and the run detail (routes/adminRankings.ts) ask whether each is still
// OPEN. Open is derived on read, never stored: the flagged field is on the
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
import { createHash } from 'node:crypto';
import type { UnlawfulFlagInput, UnlawfulFlagRecord } from '../../repos/rankingRunsRepo.js';
import type { ParsedCandidate } from './parse.js';

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

function fieldWords(field: string): string {
  const key = field.startsWith('landlord:') ? field.slice('landlord:'.length) : field;
  return key.replace(/_/g, ' ').toLowerCase();
}

function folded(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * D10's reason: the model's against-reason, else its unknown, whose text names
 * the field (the field key with underscores as spaces, case and spacing
 * folded; a landlord: flag by its plain key), else the default sentence.
 */
export function flagReason(field: string, result: Pick<ParsedCandidate, 'against' | 'unknowns'>): string {
  const words = fieldWords(field);
  const against = result.against.find((reason) => folded(reason.text).includes(words));
  if (against !== undefined) return against.text;
  const unknown = result.unknowns.find((text) => folded(text).includes(words));
  if (unknown !== undefined) return unknown;
  return DEFAULT_FLAG_REASON;
}

/**
 * The job-wide merge (D10: "merged across a job's batches by property and
 * field"). `raised` is the job's map, keyed `${unitId}#${field}`; the FIRST
 * raising run keeps its entry. Returns only the flags this call newly added -
 * the ones the calling batch writes. A field that holds no text on the card is
 * skipped (parse already drops such a flag and counts it; this keeps a record
 * from ever carrying the hash of nothing).
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
        reason: flagReason(flag.field, result),
        runId: run.runId,
        raisedAt: run.raisedAt,
      };
      raised.set(key, entry);
      added.push(entry);
    }
  }
  return added;
}
