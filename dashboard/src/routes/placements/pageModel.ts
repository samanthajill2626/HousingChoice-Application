// pageModel - PURE helpers for the placements page (no React, no I/O), tested in
// isolation so PlacementsPage stays declarative. Replaces board.ts's role:
// instead of drag columns, the page is a FILTER (all / one phase / closed) over
// one ledger list, grouped by phase only in the all-view.
import {
  PLACEMENT_PHASES,
  STAGE_PHASE,
  TERMINAL_STAGES,
  type Contact,
  type PlacementItem,
  type PlacementPhase,
  type UnitItem,
} from '../../api/index.js';
import { isPorting, listingAddress, tenantName } from './placementsFormat.js';

/** The page's filter: everything active, one phase's slice, or the closed bucket. */
export type LedgerFilter =
  | { kind: 'all' }
  | { kind: 'phase'; phase: PlacementPhase }
  | { kind: 'closed' };

/** phase -> URL slug (?phase=<slug>). Kebab-case of the display name. */
export const PHASE_SLUG: Readonly<Record<PlacementPhase, string>> = {
  Application: 'application',
  RTA: 'rta',
  Inspection: 'inspection',
  'Rent Determination': 'rent-determination',
  Contract: 'contract',
  Administrative: 'administrative',
  Closure: 'closure',
};

/** Parse the filter from the page's search params. Unknown values -> all
 *  (never a crash or a redirect). */
export function parseFilter(params: URLSearchParams): LedgerFilter {
  if (params.get('view') === 'closed') return { kind: 'closed' };
  const slug = params.get('phase');
  const phase = PLACEMENT_PHASES.find((p) => PHASE_SLUG[p] === slug);
  if (phase !== undefined) return { kind: 'phase', phase };
  return { kind: 'all' };
}

/** The search-string for a filter ('' for all) - the Link target is
 *  `/placements${filterSearch(f)}`. */
export function filterSearch(filter: LedgerFilter): string {
  if (filter.kind === 'phase') return `?phase=${PHASE_SLUG[filter.phase]}`;
  if (filter.kind === 'closed') return '?view=closed';
  return '';
}

/** One placement, resolved for display. tenant/listing are the same strings the
 *  row renders, so search matches exactly what staff see. (The old board's
 *  tenant-status badge was DROPPED 2026-07-15 - on active rows the tenant is
 *  always 'placing', so it read as a stuck duplicate of the page itself.) */
export interface LedgerRow {
  placement: PlacementItem;
  tenant: string;
  listing: string;
  porting: boolean;
}

/** A renderable section: phase is set (with a heading) only in the all-view;
 *  a flat phase/closed slice has phase null. */
export interface LedgerGroup {
  phase: PlacementPhase | null;
  rows: LedgerRow[];
}

export interface LedgerCounts {
  all: number;
  byPhase: Record<PlacementPhase, number>;
  closed: number;
}

/** Terminal (moved_in / lost) OR unknown/legacy stage -> the Closed bucket.
 *  (Same fallback the old board's Closed area had: never silently drop a row.) */
function isClosedRow(c: PlacementItem): boolean {
  return TERMINAL_STAGES.has(c.stage) || STAGE_PHASE[c.stage] === undefined;
}

function rowOf(c: PlacementItem, contacts: Map<string, Contact>, units: Map<string, UnitItem>): LedgerRow {
  return {
    placement: c,
    tenant: tenantName(contacts, c.tenantId),
    listing: listingAddress(units, c.unitId),
    porting: isPorting(contacts, c.tenantId),
  };
}

/** Filter-entry counts (rail/chips). Reflects the UNSEARCHED totals. */
export function ledgerCounts(placements: PlacementItem[]): LedgerCounts {
  const byPhase = {} as Record<PlacementPhase, number>;
  for (const p of PLACEMENT_PHASES) byPhase[p] = 0;
  let all = 0;
  let closed = 0;
  for (const c of placements) {
    if (isClosedRow(c)) {
      closed += 1;
      continue;
    }
    all += 1;
    byPhase[STAGE_PHASE[c.stage]] += 1;
  }
  return { all, byPhase, closed };
}

function matches(row: LedgerRow, q: string): boolean {
  if (q === '') return true;
  return row.tenant.toLowerCase().includes(q) || row.listing.toLowerCase().includes(q);
}

/** The renderable ledger for a filter + search query. Preserves API order within
 *  each group; the all-view omits phases with no (matching) rows. */
export function buildLedger(
  placements: PlacementItem[],
  contacts: Map<string, Contact>,
  units: Map<string, UnitItem>,
  filter: LedgerFilter,
  query: string,
): LedgerGroup[] {
  const q = query.trim().toLowerCase();
  if (filter.kind === 'closed') {
    const rows = placements.filter(isClosedRow).map((c) => rowOf(c, contacts, units)).filter((r) => matches(r, q));
    return rows.length > 0 ? [{ phase: null, rows }] : [];
  }
  if (filter.kind === 'phase') {
    const rows = placements
      .filter((c) => !isClosedRow(c) && STAGE_PHASE[c.stage] === filter.phase)
      .map((c) => rowOf(c, contacts, units))
      .filter((r) => matches(r, q));
    return rows.length > 0 ? [{ phase: null, rows }] : [];
  }
  const groups: LedgerGroup[] = [];
  for (const phase of PLACEMENT_PHASES) {
    const rows = placements
      .filter((c) => !isClosedRow(c) && STAGE_PHASE[c.stage] === phase)
      .map((c) => rowOf(c, contacts, units))
      .filter((r) => matches(r, q));
    if (rows.length > 0) groups.push({ phase, rows });
  }
  return groups;
}
