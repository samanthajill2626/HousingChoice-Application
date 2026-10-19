// Matching blast audience rules - the PURE half (spec
// docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md).
// No I/O and no clock: callers pass `nowMs`. ONE home for the rules the
// resolver, the preview, draft create and send path (c) share, so they
// cannot drift:
//   D1  the tenant statuses a filter blast reads, in read order;
//   D2  the housing authority list: its shape guard, the ONE reader of a
//       stored filter's authorities (authoritiesOfFilter - a legacy
//       one-string row included) and the wire shape every response carries;
//   D4  the tour hold rule: one tour, the pick among several, per tenant;
//   D5  the default-checked rule.
import type { AudienceFilter } from '../repos/broadcastsRepo.js';
import type { TenantStatus } from './statusModel.js';

/** D4: a tour request holds for 14 days (336 h) from its createdAt. */
export const TOUR_REQUEST_HOLD_MS = 14 * 24 * 60 * 60 * 1000;

/** D1: the statuses a filter blast reads, IN READ ORDER (searching first). */
export const BLAST_TENANT_STATUSES = ['searching', 'onboarding'] as const satisfies readonly TenantStatus[];

/** D2: shape guard on audience_filter.housing_authorities. */
export const MAX_FILTER_AUTHORITIES = 100;

/** D4: why a tenant is held (left unchecked by default). */
export type TourHoldKind =
  | 'needs_placement'
  | 'upcoming'
  | 'needs_outcome'
  | 'not_marked'
  | 'no_show'
  | 'requested';

/** D4: the order the ONE shown hold is picked in when a tenant has several. */
export const TOUR_HOLD_KIND_ORDER: readonly TourHoldKind[] = [
  'needs_placement',
  'upcoming',
  'needs_outcome',
  'not_marked',
  'no_show',
  'requested',
];

/** A tour hold: its kind, the tour it comes from, and the date shown (`at`,
 *  an ISO string; absent when the tour has no readable date). */
export interface TourHold {
  kind: TourHoldKind;
  tourId: string;
  at?: string;
}

/** The tour fields the rule reads (a stored TourItem satisfies it). */
export interface TourHoldInput {
  tourId: string;
  tenantId: string;
  status: unknown;
  scheduledAt?: unknown;
  createdAt?: unknown;
  outcome?: unknown;
  convertible?: unknown;
}

/** Epoch ms of a non-empty ISO string, or null (an unreadable date reads as missing). */
function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A hold dated by the tour's scheduledAt when it has a readable one. */
function scheduledHold(kind: TourHoldKind, tour: TourHoldInput): TourHold {
  if (isoMs(tour.scheduledAt) === null) return { kind, tourId: tour.tourId };
  return { kind, tourId: tour.tourId, at: tour.scheduledAt as string };
}

/**
 * D4 table for ONE tour at `nowMs`:
 *   scheduled, scheduledAt later than now           -> upcoming (at = scheduledAt)
 *   scheduled, scheduledAt now or earlier, or none   -> not_marked
 *   toured, convertible === true                     -> needs_placement
 *   toured, no outcome (and not convertible)         -> needs_outcome
 *   no_show                                          -> no_show
 *   requested, created less than 336 h before now    -> requested (at = createdAt)
 *   anything else - canceled, closed (any reason), toured with an outcome
 *   and not convertible, a request 336 h old or older, an unknown status
 *   -> no hold.
 * Every kind but `requested` is dated by scheduledAt when it has one. An
 * unparseable scheduledAt counts as missing (`not_marked`, no `at`); an
 * unparseable or missing createdAt on a request holds nothing. "No outcome"
 * is an outcome that is absent (undefined or null).
 */
export function tourHoldOf(tour: TourHoldInput, nowMs: number): TourHold | undefined {
  switch (tour.status) {
    case 'scheduled': {
      const atMs = isoMs(tour.scheduledAt);
      if (atMs !== null && atMs > nowMs) {
        return { kind: 'upcoming', tourId: tour.tourId, at: tour.scheduledAt as string };
      }
      return scheduledHold('not_marked', tour);
    }
    case 'toured':
      if (tour.convertible === true) return scheduledHold('needs_placement', tour);
      if (tour.outcome === undefined || tour.outcome === null) return scheduledHold('needs_outcome', tour);
      return undefined;
    case 'no_show':
      return scheduledHold('no_show', tour);
    case 'requested': {
      const createdMs = isoMs(tour.createdAt);
      if (createdMs === null || nowMs - createdMs >= TOUR_REQUEST_HOLD_MS) return undefined;
      return { kind: 'requested', tourId: tour.tourId, at: tour.createdAt as string };
    }
    default:
      return undefined;
  }
}

/** Negative when `a` is the better hold to show (the D4 tie-break). */
function compareHolds(a: TourHold, b: TourHold): number {
  const byKind = TOUR_HOLD_KIND_ORDER.indexOf(a.kind) - TOUR_HOLD_KIND_ORDER.indexOf(b.kind);
  if (byKind !== 0) return byKind;
  const aMs = a.at === undefined ? null : isoMs(a.at);
  const bMs = b.at === undefined ? null : isoMs(b.at);
  if (aMs !== bMs) {
    // A missing date loses.
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    // upcoming: the EARLIEST date; every other kind: the LATEST date.
    return a.kind === 'upcoming' ? aMs - bMs : bMs - aMs;
  }
  return a.tourId < b.tourId ? -1 : a.tourId > b.tourId ? 1 : 0;
}

/** D4: the ONE hold shown for a tenant with several - kind order
 *  (TOUR_HOLD_KIND_ORDER); within `upcoming` the earliest `at`, within the
 *  others the latest `at` (a missing `at` loses; dates compare as instants);
 *  then tourId ascending. */
export function pickTourHold(holds: readonly TourHold[]): TourHold | undefined {
  let best: TourHold | undefined;
  for (const hold of holds) {
    if (best === undefined || compareHolds(hold, best) < 0) best = hold;
  }
  return best;
}

/** D4: group by the tour's tenantId - with no assumption about that
 *  contact's type (an older tour may name a non-tenant) - and keep one
 *  picked hold per tenant. A tenant whose tours hold nothing is absent; a
 *  tour with no tenantId is skipped. */
export function tourHoldsByTenant(tours: readonly TourHoldInput[], nowMs: number): Map<string, TourHold> {
  const byTenant = new Map<string, TourHold[]>();
  for (const tour of tours) {
    if (typeof tour.tenantId !== 'string' || tour.tenantId.length === 0) continue;
    const hold = tourHoldOf(tour, nowMs);
    if (hold === undefined) continue;
    const list = byTenant.get(tour.tenantId);
    if (list === undefined) byTenant.set(tour.tenantId, [hold]);
    else list.push(hold);
  }
  const out = new Map<string, TourHold>();
  for (const [tenantId, holds] of byTenant) {
    const picked = pickTourHold(holds);
    if (picked !== undefined) out.set(tenantId, picked);
  }
  return out;
}

/** The flags the D5 rule reads for one review row. */
export interface DefaultCheckFlags {
  hasConsent: boolean;
  seeded: boolean;
  alreadySent: boolean;
  declined: boolean;
  held: boolean;
}

/** D5: hasConsent && (seeded || (!alreadySent && !declined && !held)). A hand
 *  pick (seed) starts checked whatever its flags; a row without recorded
 *  consent never does. */
export function checkedByDefault(f: DefaultCheckFlags): boolean {
  return f.hasConsent && (f.seeded || (!f.alreadySent && !f.declined && !f.held));
}

/** D2 normalizer - the ONLY reader of a stored filter's authorities:
 *  housing_authorities (trimmed, blanks dropped, de-duplicated - first wins,
 *  non-strings ignored) when present, even when empty; else the legacy
 *  housing_authority string (trimmed) as one member; else []. */
export function authoritiesOfFilter(
  filter: Pick<AudienceFilter, 'housing_authorities' | 'housing_authority'> | undefined,
): string[] {
  if (filter === undefined) return [];
  const list: unknown = filter.housing_authorities;
  if (Array.isArray(list)) {
    const out: string[] = [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const member = raw.trim();
      if (member === '' || out.includes(member)) continue;
      out.push(member);
    }
    return out;
  }
  const legacy: unknown = filter.housing_authority;
  if (typeof legacy === 'string' && legacy.trim() !== '') return [legacy.trim()];
  return [];
}

/** D2 wire shape: never housing_authority; housing_authorities only when non-empty. */
export interface WireAudienceFilter {
  contact_type: 'tenant';
  housing_authorities?: string[];
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}

/** D2: the filter every response carries (the create echo, the results and
 *  list projections) - normalized through authoritiesOfFilter, so a legacy
 *  row answers its string as a one-member list and the dashboard reads ONE
 *  shape. The booleans pass through as stored. */
export function wireAudienceFilter(filter: AudienceFilter): WireAudienceFilter {
  const housing_authorities = authoritiesOfFilter(filter);
  return {
    contact_type: 'tenant',
    ...(housing_authorities.length > 0 && { housing_authorities }),
    ...(typeof filter.bedroomSize === 'number' && { bedroomSize: filter.bedroomSize }),
    excludeOptedOut: filter.excludeOptedOut,
    excludeUnreachable: filter.excludeUnreachable,
  };
}
