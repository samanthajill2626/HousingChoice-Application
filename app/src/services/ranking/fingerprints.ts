// WP1 B2a (spec D13; charter 10.3): the three fingerprints a match stores -
// sha256 over a STABLE serialization (object keys sorted at every depth,
// array order kept, undefined dropped).
//
// - unitCard: the property card as sent (landlord defaults included when the
//   switch is on).
// - pairHistory: the declined record and the tours (the tour projection);
//   never the send dates (age covers time since the last send).
// - tenantCard: NOT the card as arranged for the prompt (the arrangement
//   moves with sends: their order and the bound). It covers the card's own
//   fields WITHOUT `notes` and `propertiesSeen`; the Notes box text AS STORED
//   (every feedback line is a Notes line, so a new line or a staff edit
//   changes it wherever it would be arranged); and, for every property in the
//   UNBOUNDED seen set with a STORED outcome (a decline or a tour), sorted by
//   unitId, { unitId, label, unitCard, declined, tours }. So a bare send, a
//   re-send, an eviction from the listed entries and a line re-attaching
//   under a newly sent home change nothing; a decline, a tour or a feedback
//   line about ANY property, or an edit to any card field of a home with a
//   decline or a tour, changes every match of that tenant. Recency enters only
//   as its bucket (the card's lastHeardFrom).
import { createHash } from 'node:crypto';
import { PROPERTIES_SEEN_KEY, TENANT_NOTES_KEY } from './cards.js';
import type { SeenHome } from './seenSet.js';
import type { Card, PairHistory } from './types.js';

/** JSON with object keys sorted at every depth; undefined values dropped (null in an array). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Spec D13: the property card as sent. */
export function unitCardFingerprint(card: Card): string {
  return sha256Hex(stableStringify(card));
}

/** Spec D13: the declined record and the tours, never the sends. */
export function pairHistoryFingerprint(history: Pick<PairHistory, 'declined' | 'tours'>): string {
  return sha256Hex(stableStringify({ declined: history.declined, tours: history.tours }));
}

export interface TenantFingerprintInput {
  /** The tenant card (tenantCard). */
  card: Card;
  /** The contact's stored Notes box. */
  notesText: unknown;
  /** The UNBOUNDED seen set. */
  seen: readonly SeenHome[];
  /** A seen home's card fingerprint (null: a home a complete read did not find). Asked only for outcome homes. */
  homeCardFingerprint: (unitId: string) => string | null;
}

/** Spec D13: the tenant card fingerprint. */
export function tenantCardFingerprint(input: TenantFingerprintInput): string {
  const fields: Card = {};
  for (const [key, value] of Object.entries(input.card)) {
    if (key === TENANT_NOTES_KEY || key === PROPERTIES_SEEN_KEY) continue;
    fields[key] = value;
  }
  const seenOutcomes = input.seen
    .filter((home) => home.declined !== null || home.tours.length > 0)
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0))
    .map((home) => ({
      unitId: home.unitId,
      label: home.label,
      unitCard: input.homeCardFingerprint(home.unitId),
      declined: home.declined,
      tours: home.tours,
    }));
  return sha256Hex(
    stableStringify({
      fields,
      notes: typeof input.notesText === 'string' ? input.notesText : '',
      seenOutcomes,
    }),
  );
}
