// WP1 B2a (spec D2.3; charter 6.2): the SEEN SET - every property a tenant was
// sent (each listed listing_sends row, a flyer sign-up included) or toured,
// UNBOUNDED. The attach step (seenFeedback.ts) and the tenant fingerprint
// (fingerprints.ts) work over all of it; only the card's propertiesSeen list
// is bounded (cards.ts, RANKING_SEEN_MAX).
//
// The units come from ONE complete batch read for the whole set
// (unitsRepo.getManyByIds with requireComplete - assemble.ts): a unit absent
// from a COMPLETE read does not exist and is listed under MISSING_UNIT_LABEL,
// keeping its sends, decline and tours. A soft-deleted unit is still read and
// listed like any other. A unit whose address yields no label (no line 1 or
// city; a legacy string address) is listed under NO_ADDRESS_LABEL. Only a REAL
// label (`attachLabel`) ever attaches a Notes line.
import { propertyLabel } from '../../lib/propertyLabel.js';
import type { ListingSendItem } from '../../repos/listingSendsRepo.js';
import type { TourItem } from '../../repos/toursRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import { declinedOf, instantMs, sendFactsOf, tourProjection } from './pairHistory.js';
import type { SendFact, TourProjection } from './types.js';

export const MISSING_UNIT_LABEL = 'a property no longer on file';
export const NO_ADDRESS_LABEL = 'a property with no address on file';

export interface SeenHome {
  unitId: string;
  /** null: a COMPLETE read found no such unit. */
  unit: UnitItem | null;
  /** What the card shows: the property label, else a placeholder. */
  label: string;
  /** The real property label, the only text the attach step matches; undefined for a placeholder. */
  attachLabel: string | undefined;
  /** Every counted send, oldest first. */
  sends: SendFact[];
  lastSendAt: string | null;
  declined: { by: string; at: string } | null;
  /** Tour projections, in tour creation order. */
  tours: TourProjection[];
  /** The newest of the decline, the last send and each tour's creation and scheduled time. */
  activityAt: string | null;
}

export interface SeenSetInput {
  sends: readonly ListingSendItem[];
  tours: readonly TourItem[];
  units: ReadonlyMap<string, UnitItem>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every unit id the sends and tours name, once each, ascending. */
export function seenUnitIds(sends: readonly ListingSendItem[], tours: readonly TourItem[]): string[] {
  const ids = new Set<string>();
  for (const row of sends) if (typeof row.unitId === 'string' && row.unitId.length > 0) ids.add(row.unitId);
  for (const tour of tours) if (typeof tour.unitId === 'string' && tour.unitId.length > 0) ids.add(tour.unitId);
  return [...ids].sort(compareText);
}

/** The latest of the given instants (as written), or null when none parses. */
function latestOf(values: readonly (string | null | undefined)[]): string | null {
  let best: { at: string; ms: number } | null = null;
  for (const value of values) {
    const ms = instantMs(value);
    if (ms === undefined || typeof value !== 'string') continue;
    if (best === null || ms > best.ms) best = { at: value, ms };
  }
  return best === null ? null : best.at;
}

/** Spec D2.3: one entry per seen property, by unit id. */
export function buildSeenSet(input: SeenSetInput): SeenHome[] {
  const rowByUnit = new Map<string, ListingSendItem>();
  for (const row of input.sends) if (!rowByUnit.has(row.unitId)) rowByUnit.set(row.unitId, row);
  const toursByUnit = new Map<string, TourItem[]>();
  for (const tour of input.tours) {
    const list = toursByUnit.get(tour.unitId) ?? [];
    list.push(tour);
    toursByUnit.set(tour.unitId, list);
  }
  return seenUnitIds(input.sends, input.tours).map((unitId): SeenHome => {
    const unit = input.units.get(unitId) ?? null;
    const realLabel = unit === null ? undefined : propertyLabel(unit);
    const row = rowByUnit.get(unitId);
    const sends = row === undefined ? [] : sendFactsOf(row);
    const tours = [...(toursByUnit.get(unitId) ?? [])].sort(
      (a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.tourId, b.tourId),
    );
    const declined = declinedOf(row);
    const lastSendAt = latestOf(sends.map((send) => send.at));
    return {
      unitId,
      unit,
      label: unit === null ? MISSING_UNIT_LABEL : (realLabel ?? NO_ADDRESS_LABEL),
      attachLabel: realLabel,
      sends,
      lastSendAt,
      declined,
      tours: tours.map(tourProjection),
      activityAt: latestOf([declined?.at, lastSendAt, ...tours.flatMap((tour) => [tour.createdAt, tour.scheduledAt])]),
    };
  });
}
