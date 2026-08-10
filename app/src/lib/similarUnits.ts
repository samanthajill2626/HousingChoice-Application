// BE5/C6 — similar-properties ranking. A PURE, deterministic function that ranks
// `available` units by attribute similarity to a target unit, for the property
// detail page's "Similar" panel. No I/O, no clock, no randomness — the same
// inputs always produce the same order + matchPct (unit-tested), so the route
// is a thin shell over this.
//
// The scoring is a weighted sum over four dimensions (weights sum to 1.0):
//   beds  0.35  — the heaviest signal (a 2-bed seeker wants 2-beds)
//   area  0.25  — same subzone (1.0) > same area (0.6) > neither (0)
//   rent  0.20  — payment_standard (or rent_min..rent_max midpoint) proximity
//   auth  0.20  - Jaccard overlap of the accepted-authority sets
// A dimension the TARGET doesn't specify contributes 0 (it can't discriminate).
// matchPct = round(score * 100). Ordering: matchPct DESC, tie-break unitId ASC.
import type { Address } from './address.js';
import { authoritiesOf } from './unitFields.js';
import type { UnitItem, UnitStatus } from '../repos/unitsRepo.js';

/**
 * A ranked similar unit (BE5/C6 — contract verbatim; the frontend imports the
 * same shape). `address` reuses the legacy unit address field (structured or a
 * legacy plain string); `status` reuses the legacy status.
 */
export interface SimilarUnit {
  unitId: string;
  address?: Address | string;
  status: UnitStatus;
  matchPct: number;
  summary: string;
}

export interface RankSimilarOptions {
  /** Top-N cap on the returned list (default 5). */
  limit?: number;
}

const WEIGHT_BEDS = 0.35;
const WEIGHT_AREA = 0.25;
const WEIGHT_RENT = 0.2;
const WEIGHT_AUTHORITIES = 0.2;

const DEFAULT_LIMIT = 5;

/** beds: 1.0 equal, 0.5 off-by-one, else 0. Target must have beds to score. */
function scoreBeds(target: UnitItem, c: UnitItem): number {
  if (typeof target.beds !== 'number' || typeof c.beds !== 'number') return 0;
  const diff = Math.abs(target.beds - c.beds);
  if (diff === 0) return 1;
  if (diff === 1) return 0.5;
  return 0;
}

/** area: 1.0 same subzone, 0.6 same area (different subzone), else 0. */
function scoreArea(target: UnitItem, c: UnitItem): number {
  if (
    typeof target.subzone === 'string' &&
    target.subzone.length > 0 &&
    target.subzone === c.subzone
  ) {
    return 1;
  }
  if (typeof target.area === 'string' && target.area.length > 0 && target.area === c.area) {
    return 0.6;
  }
  return 0;
}

/** The unit's representative rent: payment_standard, else rent_min..rent_max midpoint. */
function rentOf(u: UnitItem): number | undefined {
  if (typeof u.payment_standard === 'number') return u.payment_standard;
  const hasMin = typeof u.rent_min === 'number';
  const hasMax = typeof u.rent_max === 'number';
  if (hasMin && hasMax) return ((u.rent_min as number) + (u.rent_max as number)) / 2;
  if (hasMin) return u.rent_min;
  if (hasMax) return u.rent_max;
  return undefined;
}

/**
 * rent: 1.0 within ~10% of the target, scaling LINEARLY down to 0 at ~40%
 * relative difference and beyond. Both units must have a comparable rent.
 */
function scoreRent(target: UnitItem, c: UnitItem): number {
  const t = rentOf(target);
  const o = rentOf(c);
  if (typeof t !== 'number' || t <= 0 || typeof o !== 'number') return 0;
  const rel = Math.abs(o - t) / t;
  if (rel <= 0.1) return 1;
  if (rel >= 0.4) return 0;
  // Linear ramp between 10% (→1) and 40% (→0).
  return 1 - (rel - 0.1) / (0.4 - 0.1);
}

/**
 * authorities: Jaccard overlap (intersection / union) of the two accepted-
 * authority sets, read through `authoritiesOf` so a legacy unit that stores only
 * `jurisdiction` still scores (spec section 8 - read-time synthesis, no
 * backfill). Cameron's ruling: the old program list WAS the authority list all
 * along, so this is a rename of the dimension, not a change to how it scores.
 * DELIBERATE consequence: the dimension was dormant while nothing wrote
 * `accepted_programs` and is now live for every unit that has an authority, so
 * similar-unit rankings shift in seeded/demo worlds.
 */
function scoreAuthorities(target: UnitItem, c: UnitItem): number {
  const a = new Set(authoritiesOf(target));
  const b = new Set(authoritiesOf(c));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const p of a) if (b.has(p)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compose a short, deterministic human summary from the dimensions that scored
 * high - e.g. "2 bed - Same area - Accepts Atlanta (AHA), DCA". Always leads with
 * the candidate's bed count (the primary signal) when known.
 */
function buildSummary(
  c: UnitItem,
  scores: { beds: number; area: number; rent: number; authorities: number },
): string {
  const parts: string[] = [];
  if (typeof c.beds === 'number') {
    parts.push(`${c.beds} bed`);
  }
  if (scores.area >= 1) parts.push('Same subzone');
  else if (scores.area > 0) parts.push('Same area');
  if (scores.rent >= 1) parts.push('Similar rent');
  if (scores.authorities > 0) {
    // The SYNTHESIZED list, so a legacy `jurisdiction`-only unit still renders.
    const authorities = authoritiesOf(c);
    if (authorities.length > 0) parts.push(`Accepts ${authorities.join(', ')}`);
  }
  // Never emit an empty-summary card: when no dimension part accumulated (e.g.
  // an available unit with no comparable attributes), fall back to a neutral,
  // non-empty label rather than ''.
  if (parts.length === 0) return 'Available unit';
  return parts.join(' - ');
}

/**
 * Rank `candidates` by similarity to `target`. EXCLUDES the target itself and
 * any non-`available` candidate (defensive — the caller passes available only).
 * Returns the top `limit` (default 5) as SimilarUnit[], ordered matchPct DESC
 * then unitId ASC (deterministic, reproducible).
 */
export function rankSimilarUnits(
  target: UnitItem,
  candidates: UnitItem[],
  opts: RankSimilarOptions = {},
): SimilarUnit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const ranked: SimilarUnit[] = [];

  for (const c of candidates) {
    if (c.unitId === target.unitId) continue; // never rank self
    if (c.status !== 'available') continue; // only available alternatives

    const scores = {
      beds: scoreBeds(target, c),
      area: scoreArea(target, c),
      rent: scoreRent(target, c),
      authorities: scoreAuthorities(target, c),
    };
    const score =
      scores.beds * WEIGHT_BEDS +
      scores.area * WEIGHT_AREA +
      scores.rent * WEIGHT_RENT +
      scores.authorities * WEIGHT_AUTHORITIES;
    const matchPct = Math.round(score * 100);

    // A 0% match shares NO scored dimension with the target — it is not
    // "similar". Drop it (removes noise and avoids emitting a card whose only
    // honest summary would be the neutral fallback) BEFORE taking the top-N.
    if (matchPct === 0) continue;

    ranked.push({
      unitId: c.unitId,
      ...(c.address !== undefined && { address: c.address }),
      status: c.status as UnitStatus,
      matchPct,
      summary: buildSummary(c, scores),
    });
  }

  // Deterministic order: matchPct DESC, tie-break unitId ASC.
  ranked.sort((a, b) =>
    b.matchPct - a.matchPct || (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0),
  );
  return ranked.slice(0, limit);
}
