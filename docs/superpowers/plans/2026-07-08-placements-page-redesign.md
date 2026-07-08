# Placements Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the /placements kanban board with a responsive phase-filter + single ledger list (rail on desktop, chip strip on mobile), Today-style amber attention stripe, and a desktop-only full-stage-ladder row action menu. No drag-and-drop.

**Architecture:** One data model rendered responsively. Pure helpers (pageModel.ts) turn the loaded placements into filter counts and grouped/flat row lists; PlacementsPage composes PhaseFilter (one component, two CSS layouts), PlacementRow (stretched-link row + attention stripe), and StageMenu (kebab, full 18-stage ladder), and ports the existing gate-modal state machine from PlacementsBoard/PlacementDetail unchanged. Spec: docs/superpowers/specs/2026-07-08-placements-page-redesign-design.md (read it before starting a task).

**Tech Stack:** React 18 + react-router (useSearchParams), CSS Modules with ui/tokens.css variables, vitest + @testing-library/react, Playwright e2e.

## Global Constraints

- Work in worktree w:/tmp/placements-page (branch feat/placements-page). Never switch branches; never touch files outside this worktree.
- NO backend/API/schema changes. Do not modify PlacementDetail.tsx, Today, Tours, or anything under app/.
- All CSS values come from ui/tokens.css variables (var(--sp-3), var(--c-warning), ...). No hard-coded colors/sizes. CSS Modules only.
- The dashboard mobile breakpoint is `@media (max-width: 767.98px)` (matches AppFrame.module.css).
- New source files must be plain ASCII. Where a glyph is needed use escapes: the kebab glyph is the string literal backslash-u22EF escape in JSX (renders as the same midline-ellipsis ContactActionsMenu shows), and new copy uses plain ASCII "...". Do not edit existing copy elsewhere.
- Accessibility-first: real roles/labels; e2e selectors via getByRole/getByLabel (see e2e/support/selectors.md).
- Commit after each task with the exact message given; run `git status --porcelain` first and `git add` ONLY the listed paths. End every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run unit tests from the dashboard workspace: `cd /w/tmp/placements-page/dashboard && npx vitest run <file>`. Typecheck from the repo root: `npm run typecheck`.
- Reference files for conventions (read, do not modify): dashboard/src/routes/placements/PlacementsBoard.tsx (gate machinery to port), dashboard/src/routes/placements/PlacementDetail.tsx lines 140-382 (FULL gate set + modal prefill), dashboard/src/routes/contact/ContactActionsMenu.tsx (kebab pattern), dashboard/src/routes/today/Today.module.css lines 104-117 (attention stripe).

---

### Task 1: pageModel.ts pure helpers

**Files:**
- Create: `dashboard/src/routes/placements/pageModel.ts`
- Create: `dashboard/src/routes/placements/pageModel.test.ts`

**Interfaces:**
- Consumes: PLACEMENT_PHASES, STAGE_PHASE, TERMINAL_STAGES, PlacementItem, PlacementPhase, Contact, UnitItem from `../../api/index.js`; tenantName, listingAddress, isPorting from `./placementsFormat.js`.
- Produces (later tasks import these EXACT names from `./pageModel.js`):
  - `type LedgerFilter = { kind: 'all' } | { kind: 'phase'; phase: PlacementPhase } | { kind: 'closed' }`
  - `PHASE_SLUG: Readonly<Record<PlacementPhase, string>>`
  - `parseFilter(params: URLSearchParams): LedgerFilter`
  - `filterSearch(filter: LedgerFilter): string` (the query-string, '' for all)
  - `interface LedgerRow { placement: PlacementItem; tenant: string; listing: string; porting: boolean; tenantStatus?: string }`
  - `interface LedgerGroup { phase: PlacementPhase | null; rows: LedgerRow[] }`
  - `interface LedgerCounts { all: number; byPhase: Record<PlacementPhase, number>; closed: number }`
  - `ledgerCounts(placements: PlacementItem[]): LedgerCounts`
  - `buildLedger(placements, contacts, units, filter, query): LedgerGroup[]`

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/src/routes/placements/pageModel.test.ts
// pageModel - pure ledger helpers for the placements page. No React, no I/O.
import { describe, expect, it } from 'vitest';
import type { Contact, PlacementItem, UnitItem } from '../../api/index.js';
import {
  PHASE_SLUG,
  buildLedger,
  filterSearch,
  ledgerCounts,
  parseFilter,
} from './pageModel.js';

function mk(over: Partial<PlacementItem> & Pick<PlacementItem, 'placementId' | 'stage'>): PlacementItem {
  return { tenantId: 't1', unitId: 'u1', ...over } as PlacementItem;
}

const contacts = new Map<string, Contact>([
  ['t1', { contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen', status: 'placing' } as Contact],
  ['t2', { contactId: 't2', type: 'tenant', firstName: 'Omar', lastName: 'Reyes', porting: true } as Contact],
]);
const units = new Map<string, UnitItem>([
  ['u1', { unitId: 'u1', landlordId: 'l1', status: 'available', address: { line1: '12 Oak St' } } as UnitItem],
]);

describe('parseFilter / filterSearch', () => {
  it('round-trips all, each phase slug, and closed', () => {
    expect(parseFilter(new URLSearchParams(''))).toEqual({ kind: 'all' });
    expect(parseFilter(new URLSearchParams('?phase=rent-determination'))).toEqual({
      kind: 'phase',
      phase: 'Rent Determination',
    });
    expect(parseFilter(new URLSearchParams('?view=closed'))).toEqual({ kind: 'closed' });
    expect(filterSearch({ kind: 'all' })).toBe('');
    expect(filterSearch({ kind: 'phase', phase: 'RTA' })).toBe('?phase=rta');
    expect(filterSearch({ kind: 'closed' })).toBe('?view=closed');
  });

  it('unknown phase slug falls back to all', () => {
    expect(parseFilter(new URLSearchParams('?phase=bogus'))).toEqual({ kind: 'all' });
  });

  it('every phase has a unique slug', () => {
    const slugs = Object.values(PHASE_SLUG);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('ledgerCounts', () => {
  it('counts actives per phase; terminals and legacy stages count as closed', () => {
    const counts = ledgerCounts([
      mk({ placementId: 'a', stage: 'collect_rta' }),
      mk({ placementId: 'b', stage: 'review_rta' }),
      mk({ placementId: 'c', stage: 'awaiting_inspection' }),
      mk({ placementId: 'd', stage: 'moved_in' }),
      mk({ placementId: 'e', stage: 'lost' }),
      mk({ placementId: 'f', stage: 'zombie_stage' as PlacementItem['stage'] }),
    ]);
    expect(counts.all).toBe(3);
    expect(counts.byPhase['RTA']).toBe(2);
    expect(counts.byPhase['Inspection']).toBe(1);
    expect(counts.byPhase['Contract']).toBe(0);
    expect(counts.closed).toBe(3);
  });
});

describe('buildLedger', () => {
  const placements = [
    mk({ placementId: 'a', stage: 'send_application' }),
    mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
    mk({ placementId: 'c', stage: 'lost' }),
  ];

  it('all: groups by phase in canonical order, omits empty phases, excludes closed', () => {
    const groups = buildLedger(placements, contacts, units, { kind: 'all' }, '');
    expect(groups.map((g) => g.phase)).toEqual(['Application', 'RTA']);
    expect(groups[0]!.rows.map((r) => r.placement.placementId)).toEqual(['a']);
    expect(groups[0]!.rows[0]!.tenant).toBe('Tasha Nguyen');
    expect(groups[0]!.rows[0]!.listing).toBe('12 Oak St');
    expect(groups[0]!.rows[0]!.tenantStatus).toBe('placing');
    expect(groups[1]!.rows[0]!.porting).toBe(true);
  });

  it('phase: one flat group (phase null) with only that slice', () => {
    const groups = buildLedger(placements, contacts, units, { kind: 'phase', phase: 'RTA' }, '');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.phase).toBeNull();
    expect(groups[0]!.rows.map((r) => r.placement.placementId)).toEqual(['b']);
  });

  it('closed: one flat group with terminal rows', () => {
    const groups = buildLedger(placements, contacts, units, { kind: 'closed' }, '');
    expect(groups[0]!.rows.map((r) => r.placement.placementId)).toEqual(['c']);
  });

  it('search matches tenant OR address case-insensitively and drops emptied groups', () => {
    const byName = buildLedger(placements, contacts, units, { kind: 'all' }, 'omar');
    expect(byName.map((g) => g.phase)).toEqual(['RTA']);
    const byAddr = buildLedger(placements, contacts, units, { kind: 'all' }, 'oak st');
    // Both actives resolve unit u1 (12 Oak St), so both groups survive.
    expect(byAddr.map((g) => g.phase)).toEqual(['Application', 'RTA']);
    expect(buildLedger(placements, contacts, units, { kind: 'all' }, 'zzz')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/pageModel.test.ts`
Expected: FAIL (Cannot find module './pageModel.js').

- [ ] **Step 3: Implement pageModel.ts**

```ts
// dashboard/src/routes/placements/pageModel.ts
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
 *  row renders, so search matches exactly what staff see. */
export interface LedgerRow {
  placement: PlacementItem;
  tenant: string;
  listing: string;
  porting: boolean;
  tenantStatus?: string;
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
  const status = contacts.get(c.tenantId)?.status;
  return {
    placement: c,
    tenant: tenantName(contacts, c.tenantId),
    listing: listingAddress(units, c.unitId),
    porting: isPorting(contacts, c.tenantId),
    ...(status !== undefined && { tenantStatus: status }),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/pageModel.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/placements-page && git status --porcelain
git add dashboard/src/routes/placements/pageModel.ts dashboard/src/routes/placements/pageModel.test.ts
git commit -m "feat(placements): pageModel pure helpers for the filter + ledger page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: PhaseFilter component (rail / chip strip)

**Files:**
- Create: `dashboard/src/routes/placements/PhaseFilter.tsx`
- Create: `dashboard/src/routes/placements/PhaseFilter.module.css`
- Create: `dashboard/src/routes/placements/PhaseFilter.test.tsx`

**Interfaces:**
- Consumes: LedgerCounts, LedgerFilter, PHASE_SLUG, filterSearch from `./pageModel.js` (Task 1); PLACEMENT_PHASES from `../../api/index.js`.
- Produces: `PhaseFilter({ counts, filter }: { counts: LedgerCounts; filter: LedgerFilter }): JSX` - a `<nav aria-label="Placement phases">` of react-router Links; selected entry has `aria-current="true"`. ONE component; the rail-vs-chips difference is pure CSS at the 767.98px breakpoint.

- [ ] **Step 1: Write the failing tests**

```tsx
// dashboard/src/routes/placements/PhaseFilter.test.tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PhaseFilter } from './PhaseFilter.js';
import type { LedgerCounts } from './pageModel.js';

const counts: LedgerCounts = {
  all: 3,
  byPhase: {
    Application: 1,
    RTA: 2,
    Inspection: 0,
    'Rent Determination': 0,
    Contract: 0,
    Administrative: 0,
    Closure: 0,
  },
  closed: 4,
};

function renderFilter(filter: Parameters<typeof PhaseFilter>[0]['filter']): void {
  render(
    <MemoryRouter>
      <PhaseFilter counts={counts} filter={filter} />
    </MemoryRouter>,
  );
}

describe('PhaseFilter', () => {
  it('renders all entries with counts inside a labeled nav', () => {
    renderFilter({ kind: 'all' });
    const nav = screen.getByRole('navigation', { name: 'Placement phases' });
    expect(within(nav).getByRole('link', { name: /All active.*3/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /RTA.*2/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Closed.*4/ })).toBeInTheDocument();
  });

  it('marks the selected entry with aria-current and targets the right URLs', () => {
    renderFilter({ kind: 'phase', phase: 'RTA' });
    const rta = screen.getByRole('link', { name: /RTA.*2/ });
    expect(rta).toHaveAttribute('aria-current', 'true');
    expect(rta).toHaveAttribute('href', '/placements?phase=rta');
    expect(screen.getByRole('link', { name: /All active/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /Closed/ })).toHaveAttribute('href', '/placements?view=closed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/PhaseFilter.test.tsx`
Expected: FAIL (Cannot find module './PhaseFilter.js').

- [ ] **Step 3: Implement PhaseFilter**

```tsx
// dashboard/src/routes/placements/PhaseFilter.tsx
// PhaseFilter - the placements page's filter: All active / each phase / Closed,
// each with a live count. ONE component, TWO layouts (CSS only): a vertical rail
// on desktop, a horizontally scrollable chip strip under the search box on
// mobile (max-width: 767.98px). Entries are Links (the filter lives in the URL);
// the selected entry carries aria-current.
import { Link } from 'react-router-dom';
import { PLACEMENT_PHASES } from '../../api/index.js';
import { filterSearch, type LedgerCounts, type LedgerFilter } from './pageModel.js';
import styles from './PhaseFilter.module.css';

export interface PhaseFilterProps {
  counts: LedgerCounts;
  filter: LedgerFilter;
}

interface Entry {
  key: string;
  label: string;
  count: number;
  to: string;
  selected: boolean;
  muted?: boolean;
}

export function PhaseFilter({ counts, filter }: PhaseFilterProps): React.JSX.Element {
  const entries: Entry[] = [
    {
      key: 'all',
      label: 'All active',
      count: counts.all,
      to: '/placements',
      selected: filter.kind === 'all',
    },
    ...PLACEMENT_PHASES.map((phase) => ({
      key: phase,
      label: phase,
      count: counts.byPhase[phase],
      to: `/placements${filterSearch({ kind: 'phase', phase })}`,
      selected: filter.kind === 'phase' && filter.phase === phase,
    })),
    {
      key: 'closed',
      label: 'Closed',
      count: counts.closed,
      to: `/placements${filterSearch({ kind: 'closed' })}`,
      selected: filter.kind === 'closed',
      muted: true,
    },
  ];

  return (
    <nav className={styles.nav} aria-label="Placement phases">
      <ul className={styles.list}>
        {entries.map((e) => (
          <li key={e.key} className={e.muted ? styles.mutedItem : undefined}>
            <Link
              className={`${styles.entry} ${e.selected ? styles.selected : ''} ${e.muted ? styles.muted : ''}`}
              to={e.to}
              {...(e.selected && { 'aria-current': 'true' as const })}
            >
              <span className={styles.label}>{e.label}</span>
              <span className={styles.count}>{e.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

```css
/* dashboard/src/routes/placements/PhaseFilter.module.css */
/* PhaseFilter - vertical rail on desktop, horizontal chip strip on mobile.
 * Tokens only. */

.nav {
  flex: 0 0 auto;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-md);
  color: var(--c-text);
  font-size: var(--fs-sm);
  text-decoration: none;
}

.entry:hover {
  background: var(--c-surface-hover);
}

.entry:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}

.selected {
  background: var(--c-brand);
  color: var(--c-on-brand);
}

.selected:hover {
  background: var(--c-brand);
}

.selected .count {
  color: inherit;
}

.muted {
  color: var(--c-text-muted);
}

.mutedItem {
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--c-border);
}

.label {
  white-space: nowrap;
}

.count {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--c-text-subtle);
}

/* Mobile: the same DOM as a horizontally scrollable chip strip. */
@media (max-width: 767.98px) {
  .list {
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: var(--sp-1);
  }

  .entry {
    border: 1px solid var(--c-border);
    border-radius: var(--radius-pill);
    padding: 0 var(--sp-3);
    gap: var(--sp-1);
  }

  .selected {
    border-color: var(--c-brand);
  }

  .mutedItem {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }
}
```

NOTE: before using `--c-surface-hover` / `--c-on-brand`, check they exist in `dashboard/src/ui/tokens.css` (grep). If a token is missing, use the closest existing token (e.g. what AppFrame nav links use for hover, and `#fff`-equivalent brand-contrast token used by primary Button) - do NOT invent new tokens.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/PhaseFilter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/placements-page && git status --porcelain
git add dashboard/src/routes/placements/PhaseFilter.tsx dashboard/src/routes/placements/PhaseFilter.module.css dashboard/src/routes/placements/PhaseFilter.test.tsx
git commit -m "feat(placements): PhaseFilter - responsive rail/chip filter with counts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: PlacementRow (stretched-link row + attention stripe)

**Files:**
- Create: `dashboard/src/routes/placements/PlacementRow.tsx`
- Create: `dashboard/src/routes/placements/PlacementRow.module.css`
- Create: `dashboard/src/routes/placements/PlacementRow.test.tsx`

**Interfaces:**
- Consumes: LedgerRow from `./pageModel.js`; STAGE_LABELS from `../../api/index.js`; shortDate from `./placementsFormat.js`; DeadlineChip from `./DeadlineChip.js`; StatusBadge from `../../ui/index.js`.
- Produces: `PlacementRow({ row, pending?, menu? }: { row: LedgerRow; pending?: boolean; menu?: React.ReactNode }): JSX` - renders an `<li>`; the primary Link's accessible name is `"<tenant> - <stage label>"`; `menu` (the kebab, provided by PlacementsPage in Task 5) renders in a desktop-only actions slot.

- [ ] **Step 1: Write the failing tests**

```tsx
// dashboard/src/routes/placements/PlacementRow.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PlacementItem } from '../../api/index.js';
import { PlacementRow } from './PlacementRow.js';
import type { LedgerRow } from './pageModel.js';

function mkRow(over: Partial<LedgerRow> = {}, placement: Partial<PlacementItem> = {}): LedgerRow {
  return {
    placement: {
      placementId: 'p1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'collect_rta',
      ...placement,
    } as PlacementItem,
    tenant: 'Tasha Nguyen',
    listing: '12 Oak St',
    porting: false,
    ...over,
  };
}

function renderRow(row: LedgerRow, menu?: React.ReactNode): void {
  render(
    <MemoryRouter>
      <ul>
        <PlacementRow row={row} {...(menu !== undefined && { menu })} />
      </ul>
    </MemoryRouter>,
  );
}

describe('PlacementRow', () => {
  it('renders the row link named "<tenant> - <stage>", address, and stage label', () => {
    renderRow(mkRow());
    const link = screen.getByRole('link', { name: 'Tasha Nguyen - Collect RTA' });
    expect(link).toHaveAttribute('href', '/placements/p1');
    expect(screen.getByText('12 Oak St')).toBeInTheDocument();
    expect(screen.getByText('Collect RTA')).toBeInTheDocument();
  });

  it('flags attention with sr-only text (the stripe is CSS)', () => {
    renderRow(mkRow({}, { attention: { reason: 'flagged', at: '2026-07-08T00:00:00Z' } }));
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('no attention -> no sr text; porting renders its chip; menu slot renders', () => {
    renderRow(mkRow({ porting: true }), <button type="button">kebab</button>);
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.getByText('Porting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kebab' })).toBeInTheDocument();
  });

  it('shows tenant status badge and tour date when present', () => {
    renderRow(mkRow({ tenantStatus: 'placing' }, { tour_date: '2026-07-16' }));
    expect(screen.getByText(/Tour Jul 16/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/PlacementRow.test.tsx`
Expected: FAIL (Cannot find module './PlacementRow.js').

- [ ] **Step 3: Implement PlacementRow**

```tsx
// dashboard/src/routes/placements/PlacementRow.tsx
// PlacementRow - one placement in the ledger list. The WHOLE row opens the
// placement detail via a stretched Link overlay (position:absolute inset:0)
// so the kebab menu button is a SIBLING layered above it - never an
// interactive-inside-interactive nesting. "Needs attention" = the Today-page
// treatment: a 4px var(--c-warning) stripe down the row's left edge
// (::before on .flagged) + visually-hidden text for AT. The old red dot is
// retired on this page.
import { Link } from 'react-router-dom';
import { STAGE_LABELS } from '../../api/index.js';
import { StatusBadge } from '../../ui/index.js';
import { DeadlineChip } from './DeadlineChip.js';
import { shortDate } from './placementsFormat.js';
import type { LedgerRow } from './pageModel.js';
import styles from './PlacementRow.module.css';

export interface PlacementRowProps {
  row: LedgerRow;
  /** True while an optimistic move for THIS row is in flight (dimmed). */
  pending?: boolean;
  /** The desktop-only actions slot (the StageMenu kebab). */
  menu?: React.ReactNode;
}

export function PlacementRow({ row, pending = false, menu }: PlacementRowProps): React.JSX.Element {
  const { placement } = row;
  const stageLabel = STAGE_LABELS[placement.stage] ?? placement.stage;
  const flagged = Boolean(placement.attention);
  const tourDate = shortDate(placement.tour_date);

  return (
    <li
      className={`${styles.row} ${flagged ? styles.flagged : ''} ${pending ? styles.pending : ''}`}
    >
      {flagged ? <span className={styles.srOnly}>Needs attention</span> : null}
      <Link
        className={styles.overlay}
        to={`/placements/${placement.placementId}`}
        aria-label={`${row.tenant} - ${stageLabel}`}
      />
      <span className={styles.main}>
        <span className={styles.tenant}>{row.tenant}</span>
        {row.porting ? (
          <span className={styles.porting} title="Tenant is porting">
            Porting
          </span>
        ) : null}
        <span className={styles.listing} title={row.listing}>
          {row.listing}
        </span>
      </span>
      <span className={styles.meta}>
        <span className={styles.stage}>{stageLabel}</span>
        {tourDate ? <span className={styles.metaItem}>Tour {tourDate}</span> : null}
        <DeadlineChip placement={placement} />
        {row.tenantStatus ? <StatusBadge kind="tenant" status={row.tenantStatus} /> : null}
      </span>
      {menu !== undefined && menu !== null ? <span className={styles.actions}>{menu}</span> : null}
    </li>
  );
}
```

```css
/* dashboard/src/routes/placements/PlacementRow.module.css */
/* PlacementRow - a ledger row. Stretched-link overlay + Today-style attention
 * stripe. Tokens only. */

.row {
  position: relative; /* anchors the overlay link and the attention stripe */
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  background: var(--c-surface);
  overflow: hidden; /* clips the stripe */
}

.row:hover {
  background: var(--c-surface-hover);
}

.pending {
  opacity: 0.6;
}

/* Attention = the Today treatment: 4px amber stripe down the LEFT edge. */
.flagged::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--c-warning);
}

/* The whole-row link: an absolutely positioned overlay UNDER the actions. */
.overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.overlay:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: -2px;
}

.main {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  flex: 1 1 auto;
}

.tenant {
  font-weight: var(--fw-semibold);
  font-size: var(--fs-sm);
  color: var(--c-text);
  white-space: nowrap;
}

.porting {
  flex: 0 0 auto;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-pill);
  background: var(--c-evt-purple-bg);
  border: 1px solid var(--c-evt-purple-border);
  color: var(--c-evt-purple-text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
}

.listing {
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  flex: 0 0 auto;
}

.stage {
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  color: var(--c-text);
}

.metaItem {
  font-size: var(--fs-xs);
  color: var(--c-text-subtle);
}

/* Actions (the kebab) sit ABOVE the overlay so they are clickable. */
.actions {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
}

.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Mobile: stack the text block over the meta chips; hide the actions slot
 * (stage moves happen on the detail page). */
@media (max-width: 767.98px) {
  .row {
    flex-wrap: wrap;
    align-items: flex-start;
    row-gap: var(--sp-1);
  }

  .main {
    flex-wrap: wrap;
  }

  .listing {
    flex-basis: 100%;
  }

  .meta {
    flex-basis: 100%;
  }

  .actions {
    display: none;
  }
}
```

Same token caveat as Task 2 for `--c-surface-hover`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/PlacementRow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/placements-page && git status --porcelain
git add dashboard/src/routes/placements/PlacementRow.tsx dashboard/src/routes/placements/PlacementRow.module.css dashboard/src/routes/placements/PlacementRow.test.tsx
git commit -m "feat(placements): PlacementRow - stretched-link ledger row with attention stripe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: StageMenu (desktop kebab, full stage ladder)

**Files:**
- Create: `dashboard/src/routes/placements/StageMenu.tsx`
- Create: `dashboard/src/routes/placements/StageMenu.module.css`
- Create: `dashboard/src/routes/placements/StageMenu.test.tsx`

**Interfaces:**
- Consumes: PLACEMENT_PHASES, PLACEMENT_STAGES, STAGE_PHASE, STAGE_LABELS, PlacementStage from `../../api/index.js`.
- Produces: `StageMenu({ tenant, currentStage, busy?, onSelect }: { tenant: string; currentStage: PlacementStage; busy?: boolean; onSelect: (toStage: PlacementStage) => void }): JSX`. Kebab button aria-label `"Actions for <tenant>"`. Menu = every stage grouped under phase headers ('lost' excluded from the groups), current stage disabled with a " (current)" suffix, then a divider and a danger "Mark lost..." item that calls `onSelect('lost')`.

- [ ] **Step 1: Write the failing tests**

```tsx
// dashboard/src/routes/placements/StageMenu.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StageMenu } from './StageMenu.js';

describe('StageMenu', () => {
  it('opens the full ladder; current stage disabled; picking a stage fires onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StageMenu tenant="Tasha Nguyen" currentStage="collect_rta" onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();

    // Full ladder: 17 stage items (18 minus lost, which is the danger item) + Mark lost.
    expect(screen.getAllByRole('menuitem')).toHaveLength(18);
    expect(screen.getByRole('menuitem', { name: /Collect RTA \(current\)/ })).toBeDisabled();

    await user.click(screen.getByRole('menuitem', { name: 'Schedule inspection' }));
    expect(onSelect).toHaveBeenCalledWith('schedule_inspection');
    // The menu closes after selection.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Mark lost... fires onSelect("lost"); Escape closes the menu', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StageMenu tenant="Tasha Nguyen" currentStage="collect_rta" onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark lost...' }));
    expect(onSelect).toHaveBeenCalledWith('lost');

    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/StageMenu.test.tsx`
Expected: FAIL (Cannot find module './StageMenu.js').

- [ ] **Step 3: Implement StageMenu**

```tsx
// dashboard/src/routes/placements/StageMenu.tsx
// StageMenu - the desktop-only kebab on a ledger row. Opens the FULL stage
// ladder grouped under phase headers (the same ladder the detail page's picker
// shows) so a move is one-shot accurate - the old phase-level move always
// landed on a phase's first stage and needed a second correction. 'lost' is
// pulled out of the groups into a danger "Mark lost..." item at the bottom.
// Outside-click + Escape close, mirroring ContactActionsMenu. The menu is a
// child of the button's wrapper (position:relative) and scrolls when tall.
import { useEffect, useRef, useState } from 'react';
import {
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  type PlacementStage,
} from '../../api/index.js';
import styles from './StageMenu.module.css';

export interface StageMenuProps {
  tenant: string;
  currentStage: PlacementStage;
  /** True while a transition for this row is in flight (disables all items). */
  busy?: boolean;
  onSelect: (toStage: PlacementStage) => void;
}

export function StageMenu({ tenant, currentStage, busy = false, onSelect }: StageMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(stage: PlacementStage): void {
    setOpen(false);
    onSelect(stage);
  }

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.kebab}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${tenant}`}
        onClick={() => setOpen((v) => !v)}
      >
        {'\u22EF'}
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={`Move ${tenant} to stage`}>
          {PLACEMENT_PHASES.map((phase) => {
            const stages = PLACEMENT_STAGES.filter((s) => STAGE_PHASE[s] === phase && s !== 'lost');
            if (stages.length === 0) return null;
            return (
              <div key={phase} className={styles.group} role="presentation">
                <div className={styles.groupHead} role="presentation" aria-hidden="true">
                  {phase}
                </div>
                {stages.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitem"
                    className={styles.item}
                    disabled={busy || s === currentStage}
                    onClick={() => pick(s)}
                  >
                    {STAGE_LABELS[s]}
                    {s === currentStage ? ' (current)' : ''}
                  </button>
                ))}
              </div>
            );
          })}
          <div className={styles.divider} role="presentation" />
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${styles.danger}`}
            disabled={busy || currentStage === 'lost'}
            onClick={() => pick('lost')}
          >
            Mark lost...
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

```css
/* dashboard/src/routes/placements/StageMenu.module.css */
/* StageMenu - kebab + grouped stage-ladder popover. Mirrors
 * ContactActionsMenu.module.css idioms. Tokens only. */

.wrap {
  position: relative;
  display: inline-flex;
}

.kebab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--sp-6);
  height: var(--sp-6);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-text-muted);
  font-size: var(--fs-md);
  line-height: 1;
  cursor: pointer;
}

.kebab:hover {
  color: var(--c-text);
}

.kebab:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}

.menu {
  position: absolute;
  right: 0;
  top: calc(100% + var(--sp-1));
  z-index: 20;
  min-width: 220px;
  max-height: min(60vh, 480px);
  overflow-y: auto;
  padding: var(--sp-1);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.groupHead {
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--c-text-subtle);
}

.item {
  display: block;
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
}

.item:hover:not(:disabled) {
  background: var(--c-surface-hover);
}

.item:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: -2px;
}

.item:disabled {
  color: var(--c-text-subtle);
  cursor: default;
}

.danger {
  color: var(--c-danger);
}

.divider {
  margin: var(--sp-1) 0;
  border-top: 1px solid var(--c-border);
}
```

Check `ContactActionsMenu.module.css` for the exact hover/danger token names it uses and match them (same caveat as Task 2 - reuse, never invent).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/StageMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/placements-page && git status --porcelain
git add dashboard/src/routes/placements/StageMenu.tsx dashboard/src/routes/placements/StageMenu.module.css dashboard/src/routes/placements/StageMenu.test.tsx
git commit -m "feat(placements): StageMenu - desktop kebab with the full grouped stage ladder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: PlacementsPage (composition + gate machinery + route swap)

**Files:**
- Create: `dashboard/src/routes/placements/PlacementsPage.tsx`
- Create: `dashboard/src/routes/placements/PlacementsPage.module.css`
- Create: `dashboard/src/routes/placements/PlacementsPage.test.tsx`
- Modify: `dashboard/src/App.tsx` (lines ~20 and ~138: swap PlacementsBoard for PlacementsPage)

**Interfaces:**
- Consumes: everything from Tasks 1-4; usePlacements from `./usePlacements.js`; gateFor from `./transitionGate.js`; LostReasonModal, MovePromptModal (+ MovePromptResult) from their modules; PlacementCreateForm; transitionPlacement, LostReason, PlacementStage, STAGE_PHASE from `../../api/index.js`; Button, Spinner from `../../ui/index.js`.
- Produces: `PlacementsPage(): JSX` - the /placements route element.
- CRITICAL: handle the FULL 7-gate set the way PlacementDetail does (lines 351-381): gate 'lost' -> LostReasonModal; gates 'finalRent' | 'inspectionOutcome' | 'inspectionDate' | 'rentDetermined' | 'moveInReady' -> MovePromptModal with `mode={gate}`, `initial` prefill (finalRent from `units.get(unitId)?.final_rent`, inspectionOutcome/inspectionDate/rentDetermined from the placement) and `lifPending` on moveInReady (`contacts.get(tenantId)?.lifEligible === true && placement.lif !== true`). The OLD board only handled 3 gates because phase-level drops could not reach the others; stage-level moves reach ALL of them.

- [ ] **Step 1: Write the failing tests**

```tsx
// dashboard/src/routes/placements/PlacementsPage.test.tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PlacementItem, Contact, UnitItem } from '../../api/index.js';
import type { PlacementsState } from './usePlacements.js';

const usePlacements = vi.fn<() => PlacementsState>();
vi.mock('./usePlacements.js', () => ({ usePlacements: () => usePlacements() }));

const transitionPlacement = vi.fn();
const getContacts = vi.fn();
const getUnits = vi.fn();
const getPlacementsBy = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    transitionPlacement: (...a: unknown[]) => transitionPlacement(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getPlacementsBy: (...a: unknown[]) => getPlacementsBy(...a),
  };
});

import { PlacementsPage } from './PlacementsPage.js';

function mk(over: Partial<PlacementItem> & Pick<PlacementItem, 'placementId' | 'stage'>): PlacementItem {
  return { tenantId: 't1', unitId: 'u1', ...over } as PlacementItem;
}

function baseState(placements: PlacementItem[]): PlacementsState {
  const contacts = new Map<string, Contact>([
    ['t1', { contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen', status: 'placing' } as Contact],
    ['t2', { contactId: 't2', type: 'tenant', firstName: 'Omar', lastName: 'Reyes' } as Contact],
  ]);
  const units = new Map<string, UnitItem>([
    ['u1', { unitId: 'u1', landlordId: 'l1', status: 'available', address: { line1: '12 Oak St' } } as UnitItem],
  ]);
  return { status: 'ready', placements, contacts, units, applyPlacement: vi.fn() };
}

function renderPage(initialEntry = '/placements'): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/placements" element={<PlacementsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePlacements.mockReset();
  transitionPlacement.mockReset();
  getContacts.mockReset();
  getUnits.mockReset();
  getPlacementsBy.mockReset();
  getContacts.mockResolvedValue({ contacts: [], nextCursor: null });
  getUnits.mockResolvedValue({ units: [], nextCursor: null });
  getPlacementsBy.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('PlacementsPage', () => {
  it('all-view: groups under phase headings; closed rows excluded; counts in the filter', () => {
    usePlacements.mockReturnValue(
      baseState([
        mk({ placementId: 'a', stage: 'send_application' }),
        mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
        mk({ placementId: 'c', stage: 'lost' }),
      ]),
    );
    renderPage();
    expect(screen.getByRole('heading', { name: 'Placements' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Application/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /RTA/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tasha Nguyen - Send application' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Inspection/ })).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Placement phases' });
    expect(within(nav).getByRole('link', { name: /All active.*2/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Closed.*1/ })).toBeInTheDocument();
  });

  it('phase filter via URL shows only that slice, flat (no group heading)', () => {
    usePlacements.mockReturnValue(
      baseState([
        mk({ placementId: 'a', stage: 'send_application' }),
        mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
      ]),
    );
    renderPage('/placements?phase=rta');
    expect(screen.getByRole('link', { name: 'Omar Reyes - Collect RTA' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tasha Nguyen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^RTA/ })).not.toBeInTheDocument();
  });

  it('closed view lists terminal placements', () => {
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'c', stage: 'lost' })]));
    renderPage('/placements?view=closed');
    expect(screen.getByRole('link', { name: 'Tasha Nguyen - Lost' })).toBeInTheDocument();
  });

  it('search narrows rows within the current filter', async () => {
    const user = userEvent.setup();
    usePlacements.mockReturnValue(
      baseState([
        mk({ placementId: 'a', stage: 'send_application' }),
        mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
      ]),
    );
    renderPage();
    await user.type(screen.getByRole('searchbox', { name: 'Search placements' }), 'omar');
    expect(screen.getByRole('link', { name: /Omar Reyes/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tasha Nguyen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Application/ })).not.toBeInTheDocument();
  });

  it('ungated menu move fires transitionPlacement with source manual', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mk({ placementId: 'a', stage: 'review_rta' }));
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review RTA' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('a', { toStage: 'review_rta', source: 'manual' }),
    );
  });

  it('gated move (out of awaiting_inspection) opens the outcome prompt first, then transitions', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mk({ placementId: 'a', stage: 'determine_rent' }));
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'awaiting_inspection' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Determine rent' }));
    expect(transitionPlacement).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Record inspection outcome' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Pass' }));
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('a', {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'pass',
      }),
    );
  });

  it('Mark lost opens the LostReasonModal (no transition until confirmed)', async () => {
    const user = userEvent.setup();
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark lost...' }));
    expect(screen.getByRole('heading', { name: 'Mark placement lost' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();
  });

  it('a rejected move shows the inline error and rolls back', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockRejectedValue(new Error('409'));
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review RTA' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Tasha Nguyen - Collect RTA' })).toBeInTheDocument();
  });

  it('empty states: all-active empty and searched-empty messages', async () => {
    const user = userEvent.setup();
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.type(screen.getByRole('searchbox', { name: 'Search placements' }), 'zzz');
    expect(screen.getByText("No matches for 'zzz'.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/PlacementsPage.test.tsx`
Expected: FAIL (Cannot find module './PlacementsPage.js').

- [ ] **Step 3: Implement PlacementsPage + CSS**

```tsx
// dashboard/src/routes/placements/PlacementsPage.tsx
// PlacementsPage - /placements: a phase FILTER (rail on desktop, chips on
// mobile) + ONE ledger list. Replaces the kanban PlacementsBoard: no drag; the
// row link opens the placement detail; the desktop-only StageMenu kebab moves a
// placement by exact stage. Jobs (per the 2026-07-08 spec): pipeline overview +
// fast lookup - triage lives on Today.
//
// MOVE PIPELINE (ported from PlacementsBoard, widened to the FULL gate set the
// way PlacementDetail handles it - stage-level moves can hit every gate):
//   1. gateFor(from, to): 'lost' -> LostReasonModal; finalRent /
//      inspectionOutcome / inspectionDate / rentDetermined / moveInReady ->
//      MovePromptModal(mode=gate, prefilled); 'none' -> fire immediately.
//   2. OPTIMISTIC: the row regroups/dims immediately (pendingMove overrides its
//      stage); success applies the authoritative PlacementItem; failure rolls
//      back and shows a non-blocking inline error banner.
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  transitionPlacement,
  type LostReason,
  type PlacementStage,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { gateFor, type TransitionGate } from './transitionGate.js';
import { buildLedger, ledgerCounts, parseFilter } from './pageModel.js';
import { PhaseFilter } from './PhaseFilter.js';
import { PlacementRow } from './PlacementRow.js';
import { StageMenu } from './StageMenu.js';
import { LostReasonModal } from './LostReasonModal.js';
import { MovePromptModal, type MovePromptResult } from './MovePromptModal.js';
import { PlacementCreateForm } from './PlacementCreateForm.js';
import { usePlacements } from './usePlacements.js';
import styles from './PlacementsPage.module.css';

/** A move awaiting its gate prompt and/or its in-flight transition. */
interface PendingMove {
  placementId: string;
  fromStage: PlacementStage;
  toStage: PlacementStage;
  gate: TransitionGate;
}

const PROMPT_GATES = new Set<TransitionGate>([
  'finalRent',
  'inspectionOutcome',
  'inspectionDate',
  'rentDetermined',
  'moveInReady',
]);

export function PlacementsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { status, placements, contacts, units, applyPlacement } = usePlacements();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<Map<string, PlacementStage>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const filter = useMemo(() => parseFilter(searchParams), [searchParams]);

  // Optimistic stage overrides applied BEFORE grouping so an in-flight move
  // shows the row in its target group immediately (same trick as the board).
  const effective = useMemo(
    () =>
      optimistic.size === 0
        ? placements
        : placements.map((c) =>
            optimistic.has(c.placementId) ? { ...c, stage: optimistic.get(c.placementId)! } : c,
          ),
    [placements, optimistic],
  );
  const counts = useMemo(() => ledgerCounts(effective), [effective]);
  const groups = useMemo(
    () => buildLedger(effective, contacts, units, filter, query),
    [effective, contacts, units, filter, query],
  );

  function runTransition(move: PendingMove, extra: { lostReason?: LostReason } & MovePromptResult): void {
    setError(null);
    setOptimistic((prev) => new Map(prev).set(move.placementId, move.toStage));
    void transitionPlacement(move.placementId, {
      toStage: move.toStage,
      source: 'manual',
      ...(extra.lostReason !== undefined && { lostReason: extra.lostReason }),
      ...(extra.finalRent !== undefined && { finalRent: extra.finalRent }),
      ...(extra.inspectionOutcome !== undefined && { inspectionOutcome: extra.inspectionOutcome }),
      ...(extra.inspectionDate !== undefined && { inspectionDate: extra.inspectionDate }),
      ...(extra.rentDetermined !== undefined && { rentDetermined: extra.rentDetermined }),
    })
      .then((updated) => {
        applyPlacement(updated);
      })
      .catch(() => {
        setError('That move was rejected. The placement kept its stage.');
      })
      .finally(() => {
        setOptimistic((prev) => {
          const next = new Map(prev);
          next.delete(move.placementId);
          return next;
        });
        setPending(null);
      });
  }

  function requestMove(placementId: string, fromStage: PlacementStage, toStage: PlacementStage): void {
    if (fromStage === toStage) return;
    const gate = gateFor(fromStage, toStage);
    const move: PendingMove = { placementId, fromStage, toStage, gate };
    if (gate === 'none') {
      runTransition(move, {});
      return;
    }
    setPending(move);
  }

  if (status === 'loading') {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Placements</h1>
        <Spinner center />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Placements</h1>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load placements. Please try again.
        </p>
      </div>
    );
  }

  const pendingPlacement =
    pending !== null ? placements.find((c) => c.placementId === pending.placementId) : undefined;
  const pendingTenant =
    pendingPlacement !== undefined ? contacts.get(pendingPlacement.tenantId) : undefined;

  const trimmed = query.trim();
  const emptyText =
    trimmed !== ''
      ? `No matches for '${trimmed}'.`
      : filter.kind === 'phase'
        ? `No placements in ${filter.phase}.`
        : filter.kind === 'closed'
          ? 'No closed placements.'
          : 'No active placements.';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Placements</h1>
        <Button variant="primary" size="sm" type="button" onClick={() => setCreateOpen(true)}>
          New placement
        </Button>
      </div>

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}

      <div className={styles.search}>
        <input
          type="search"
          className={styles.searchInput}
          aria-label="Search placements"
          placeholder="Search tenant or property..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className={styles.layout}>
        <PhaseFilter counts={counts} filter={filter} />
        <div className={styles.listArea}>
          {groups.length === 0 ? (
            <p className={styles.empty}>{emptyText}</p>
          ) : (
            groups.map((group) => (
              <section key={group.phase ?? 'flat'} className={styles.group}>
                {group.phase !== null ? (
                  <h2 className={styles.groupHead}>
                    {group.phase}
                    <span className={styles.groupCount}>{group.rows.length}</span>
                  </h2>
                ) : null}
                <ul
                  className={styles.rows}
                  aria-label={group.phase !== null ? `${group.phase} placements` : 'Placements'}
                >
                  {group.rows.map((row) => (
                    <PlacementRow
                      key={row.placement.placementId}
                      row={row}
                      pending={optimistic.has(row.placement.placementId)}
                      menu={
                        <StageMenu
                          tenant={row.tenant}
                          currentStage={row.placement.stage}
                          busy={optimistic.has(row.placement.placementId)}
                          onSelect={(toStage) =>
                            requestMove(row.placement.placementId, row.placement.stage, toStage)
                          }
                        />
                      }
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>

      {pending !== null && pending.gate === 'lost' ? (
        <LostReasonModal
          subject={tenantName(contacts, pendingPlacement?.tenantId ?? '')}
          onClose={() => setPending(null)}
          onConfirm={(reason) => runTransition(pending, { lostReason: reason })}
          busy={optimistic.has(pending.placementId)}
        />
      ) : null}

      {pending !== null && PROMPT_GATES.has(pending.gate) && pendingPlacement !== undefined ? (
        <MovePromptModal
          mode={pending.gate as 'finalRent' | 'inspectionOutcome' | 'inspectionDate' | 'rentDetermined' | 'moveInReady'}
          initial={{
            finalRent: units.get(pendingPlacement.unitId)?.final_rent,
            inspectionOutcome: pendingPlacement.inspection_outcome,
            inspectionDate: pendingPlacement.inspection_date,
            rentDetermined: pendingPlacement.rent_determined,
          }}
          {...(pending.gate === 'moveInReady' && {
            lifPending: pendingTenant?.lifEligible === true && pendingPlacement.lif !== true,
          })}
          onClose={() => setPending(null)}
          onConfirm={(result) => runTransition(pending, result)}
          busy={optimistic.has(pending.placementId)}
        />
      ) : null}

      {createOpen ? (
        <PlacementCreateForm
          onClose={() => setCreateOpen(false)}
          onCreated={(p) => {
            setCreateOpen(false);
            void navigate('/placements/' + p.placementId);
          }}
        />
      ) : null}
    </div>
  );
}
```

VERIFY BEFORE COMMITTING:
- Add `import { tenantName } from './placementsFormat.js';` (used by the LostReasonModal subject).
- Check LostReasonModal's actual prop names in `LostReasonModal.tsx` before wiring (the board passed `subject`, `onClose`, `onConfirm`, `busy` - confirm they still match).
- `final_rent` on UnitItem: confirm the field name in api/types.ts (PlacementDetail line 369 uses `unit?.final_rent`).

```css
/* dashboard/src/routes/placements/PlacementsPage.module.css */
/* PlacementsPage - header + search + (rail | chips) + ledger. Tokens only. */

.page {
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  color: var(--c-text);
  line-height: var(--lh-tight);
}

.error {
  margin: 0 0 var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-danger);
  font-size: var(--fs-sm);
}

.search {
  margin-bottom: var(--sp-3);
}

.searchInput {
  width: 100%;
  max-width: 420px;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-text);
  font-size: var(--fs-sm);
}

.searchInput:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}

.layout {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-5);
}

.listArea {
  flex: 1 1 auto;
  min-width: 0;
}

.group {
  margin-bottom: var(--sp-4);
}

.groupHead {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  background: var(--c-bg);
  border-bottom: 1px solid var(--c-border);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--c-text-muted);
}

.groupCount {
  color: var(--c-text-subtle);
  font-weight: var(--fw-semibold);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--c-surface);
}

.empty {
  padding: var(--sp-5) var(--sp-3);
  color: var(--c-text-muted);
  font-size: var(--fs-sm);
}

/* Mobile: the filter chips stack ABOVE the list (nav is first in the DOM). */
@media (max-width: 767.98px) {
  .layout {
    flex-direction: column;
    gap: var(--sp-3);
  }
}
```

(Verify `--c-bg` exists in tokens.css; AppFrame's content background token may be named differently - reuse whatever Today.module.css uses behind its sticky headers, or fall back to `var(--c-surface)`.)

Update `dashboard/src/App.tsx`:

```tsx
// line ~20 - replace:
import { PlacementsBoard } from './routes/placements/PlacementsBoard.js';
// with:
import { PlacementsPage } from './routes/placements/PlacementsPage.js';

// line ~138 - replace:
<Route path="placements" element={<PlacementsBoard />} />
// with:
<Route path="placements" element={<PlacementsPage />} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run src/routes/placements/PlacementsPage.test.tsx`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/placements-page && git status --porcelain
git add dashboard/src/routes/placements/PlacementsPage.tsx dashboard/src/routes/placements/PlacementsPage.module.css dashboard/src/routes/placements/PlacementsPage.test.tsx dashboard/src/App.tsx
git commit -m "feat(placements): PlacementsPage - phase filter + ledger replaces the board route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Delete the old board + drop @dnd-kit

**Files:**
- Delete: `dashboard/src/routes/placements/PlacementsBoard.tsx`, `PlacementsBoard.module.css`, `PlacementsBoard.test.tsx`, `Column.tsx`, `Column.module.css`, `PlacementCard.tsx`, `PlacementCard.module.css`, `ClosedArea.tsx` (+ its .module.css / test if present), `board.ts`, `board.test.ts`
- Modify: `dashboard/package.json` (remove `@dnd-kit/core` and `@dnd-kit/sortable` from dependencies; also `@dnd-kit/utilities` if present)
- Modify: root `package-lock.json` (via npm install)

- [ ] **Step 1: Verify nothing else imports the deleted modules or dnd-kit**

```bash
cd /w/tmp/placements-page
grep -rn "PlacementsBoard\|from './board.js'\|ClosedArea\|PlacementCard\|from './Column.js'" dashboard/src --include=*.ts --include=*.tsx | grep -v "routes/placements/"
grep -rn "dnd-kit" dashboard/src app e2e --include=*.ts --include=*.tsx | grep -v "routes/placements/"
```
Expected: no output from either. If a file outside routes/placements imports one of these, STOP and re-plan (do not delete blind).

- [ ] **Step 2: Delete the files and the dependency**

```bash
cd /w/tmp/placements-page
git rm dashboard/src/routes/placements/PlacementsBoard.tsx dashboard/src/routes/placements/PlacementsBoard.module.css dashboard/src/routes/placements/PlacementsBoard.test.tsx dashboard/src/routes/placements/Column.tsx dashboard/src/routes/placements/Column.module.css dashboard/src/routes/placements/PlacementCard.tsx dashboard/src/routes/placements/PlacementCard.module.css dashboard/src/routes/placements/board.ts dashboard/src/routes/placements/board.test.ts
git rm dashboard/src/routes/placements/ClosedArea.tsx
# Also remove ClosedArea.module.css / ClosedArea.test.tsx IF they exist (ls first).
```
Then edit `dashboard/package.json`: delete the `"@dnd-kit/core"` and `"@dnd-kit/sortable"` dependency lines (and `"@dnd-kit/utilities"` if listed). Run `npm install` from the repo root to update package-lock.json.

- [ ] **Step 3: Typecheck + full dashboard unit suite**

Run: `cd /w/tmp/placements-page && npm run typecheck`
Expected: exit 0. Fix any straggler imports (e.g. an index barrel re-exporting a deleted file).

Run: `cd /w/tmp/placements-page/dashboard && npx vitest run`
Expected: PASS - and note the old PlacementsBoard tests are gone; the new suites from Tasks 1-5 cover the page.

- [ ] **Step 4: Commit**

```bash
cd /w/tmp/placements-page && git status --porcelain
git add -A dashboard/src/routes/placements dashboard/package.json package-lock.json
git commit -m "refactor(placements): delete the kanban board and drop @dnd-kit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: E2E updates + full gates

**Files:**
- Rewrite: `e2e/tests/dashboard-next/placement-board.spec.ts` -> rename to `e2e/tests/dashboard-next/placements-page.spec.ts` (git mv)
- Modify: `e2e/tests/dashboard-next/lost-modal.spec.ts`
- Modify: `e2e/tests/dashboard-next/placement-history.spec.ts` (lines 29-33: the "Open" link is gone)
- Verify only: `e2e/tests/dashboard-next/placement-create.spec.ts` (the "New placement" button and heading are unchanged - the spec should pass as-is)

**Interfaces (the accessible contract the new page exposes - built in Tasks 2-5):**
- Filter: `getByRole('navigation', { name: 'Placement phases' })` containing links "All active N", "<Phase> N", "Closed N"; selected has `aria-current="true"`.
- Rows: `getByRole('link', { name: '<Tenant> - <Stage label>' })` (e.g. 'Tasha Nguyen - Awaiting inspection').
- Search: `getByRole('searchbox', { name: 'Search placements' })`.
- Kebab: `getByRole('button', { name: 'Actions for <Tenant>' })`; items via `getByRole('menuitem', { name: '<Stage label>' })` and 'Mark lost...'.
- Group headings: `getByRole('heading', { name: /Inspection/ })` (all-view only).

- [ ] **Step 1: Rewrite placement-board.spec.ts as placements-page.spec.ts**

`git mv e2e/tests/dashboard-next/placement-board.spec.ts e2e/tests/dashboard-next/placements-page.spec.ts` then replace its contents:

```ts
import { test, expect, type Page } from '@playwright/test';

// Placements page (:5174) against the real status-model backend. The kanban
// board is gone: the page is a phase FILTER (rail on desktop / chips on mobile)
// + one ledger list. Rows link to the placement detail; the desktop kebab menu
// moves a placement by exact stage (gated prompts still apply). The seeded
// placement (placement-0001) is tenant Tasha Nguyen on unit A; each test resets
// it to `awaiting_inspection` (Inspection phase).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLoginAndReset(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const res = await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
  expect(res.ok()).toBeTruthy();
}

test('all-view groups by phase; the row appears under its phase heading', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await expect(page.getByRole('heading', { name: 'Placements' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Inspection/ })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }),
  ).toBeVisible();
});

test('phase filter narrows the list and lands in the URL', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  const nav = page.getByRole('navigation', { name: 'Placement phases' });
  await nav.getByRole('link', { name: /^Inspection/ }).click();
  await expect(page).toHaveURL(/\?phase=inspection$/);
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();
  // A slice is flat: no group heading.
  await expect(page.getByRole('heading', { name: /^Inspection \d/ })).toHaveCount(0);
  // The selected entry is marked.
  await expect(nav.getByRole('link', { name: /^Inspection/ })).toHaveAttribute('aria-current', 'true');
});

test('search narrows rows by tenant name', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await page.getByRole('searchbox', { name: 'Search placements' }).fill('tasha');
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search placements' }).fill('zzz-no-such');
  await expect(page.getByText("No matches for 'zzz-no-such'.")).toBeVisible();
});

test('kebab menu moves by exact stage through the gate prompt and persists', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  // Moving OUT of awaiting_inspection requires the inspection outcome.
  await page.getByRole('button', { name: 'Actions for Tasha Nguyen' }).click();
  await page.getByRole('menuitem', { name: 'Determine rent' }).click();
  await expect(page.getByRole('heading', { name: 'Record inspection outcome' })).toBeVisible();
  await page.getByRole('radio', { name: 'Pass' }).click();
  await page.getByRole('button', { name: 'Confirm move' }).click();

  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Determine rent' })).toBeVisible();

  // Persisted across a reload.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Determine rent' })).toBeVisible();
});

test('mobile: chip filter works, no kebab, row navigates to the detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  // The filter renders as chips (same accessible nav) and still filters.
  const nav = page.getByRole('navigation', { name: 'Placement phases' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: /^Inspection/ }).click();
  await expect(page).toHaveURL(/\?phase=inspection$/);

  // No row actions on mobile (the kebab is display:none below 768px).
  await expect(page.getByRole('button', { name: 'Actions for Tasha Nguyen' })).not.toBeVisible();

  // The whole row opens the placement detail.
  await page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }).click();
  await expect(page).toHaveURL(/\/placements\/placement-0001$/);
});
```

- [ ] **Step 2: Update lost-modal.spec.ts**

Keep the file's header comment intent and devLoginAndReset; replace the test body:

```ts
test('Lost modal: blocks until a reason is given, then closes the placement', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();

  // Mark lost now lives in the row's kebab menu - it opens the modal and does
  // NOT transition yet.
  await page.getByRole('button', { name: 'Actions for Tasha Nguyen' }).click();
  await page.getByRole('menuitem', { name: 'Mark lost...' }).click();
  await expect(page.getByRole('heading', { name: 'Mark placement lost' })).toBeVisible();

  const confirm = page.getByRole('button', { name: 'Mark lost' });
  await expect(confirm).toBeDisabled();

  await page.getByRole('radio', { name: 'Tenant withdrew' }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // Terminal -> the row leaves the active ledger...
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toHaveCount(0);

  // ...and appears under the Closed filter with its stage label.
  await page
    .getByRole('navigation', { name: 'Placement phases' })
    .getByRole('link', { name: /^Closed/ })
    .click();
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Lost' })).toBeVisible();
});
```

- [ ] **Step 3: Update placement-history.spec.ts**

Replace the board-card "Open" navigation (lines ~29-33) with the row link:

```ts
  // Open the seeded placement from its ledger row.
  await page.goto(`${NEXT}/placements`);
  await page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }).click();
```

- [ ] **Step 4: Run the full gates**

```bash
cd /w/tmp/placements-page
npm run typecheck        # REQUIRED - tests do not type-check
npm test                 # all workspaces
npm run e2e              # hermetic stack; requires Docker running
```
Expected: all exit 0. NEVER pipe a test run through `| tail` (it masks the exit code). If an e2e spec fails that looks unrelated to this branch, check the lane's DynamoDB tables for stale schemas first (docs/issues/e2e-lane-tables-stale-schema.md) before assuming a regression.

- [ ] **Step 5: Commit**

```bash
cd /w/tmp/placements-page && git status --porcelain
git add e2e/tests/dashboard-next/placements-page.spec.ts e2e/tests/dashboard-next/lost-modal.spec.ts e2e/tests/dashboard-next/placement-history.spec.ts
git commit -m "test(e2e): placements page specs - filter, search, kebab moves, mobile viewport

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Self-QA through the live harness (both viewports)

No new files. Drive the REAL UI before claiming done (repo rule: don't make the human the bug-finder).

- [ ] **Step 1:** `cd /w/tmp/placements-page && npm run e2e:session` (persistent stack), then use the Playwright MCP browser against `http://127.0.0.1:5174` (or the lane's dashboard URL printed by the session): dev-login, open /placements.
- [ ] **Step 2:** Desktop pass (default viewport): verify the rail + counts, grouped all-view with sticky headers, a phase slice, the Closed view, search, one gated kebab move (reset placement-0001 after), the amber attention stripe (PATCH a placement's attention via the seeded data if none is flagged - or use a seeded flagged placement), and the New placement dialog opening.
- [ ] **Step 3:** Mobile pass (`browser_resize` to 390x844): chip strip scrolls horizontally, no kebab, rows stack cleanly (no horizontal page scroll), row tap opens the detail.
- [ ] **Step 4:** Take screenshots of both passes into `.playwright-mcp/` (auto-named) for the review record. `npm run e2e:stop` when done.
- [ ] **Step 5:** Fix anything found (each fix = its own commit); re-run `npm run typecheck && npm test` if code changed.

---

## Final gate (orchestrator)

- Merge latest `main` into feat/placements-page, resolve keeping both sides' intent, re-run ALL gates (`npm run typecheck` + `npm test` + `npm run e2e`) green on the updated base.
- Code review (spec-conformance + adversarial) before declaring merge-ready. Never merge into main without explicit human approval.
