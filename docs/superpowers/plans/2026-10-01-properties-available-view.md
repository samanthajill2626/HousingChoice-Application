# Properties page: available now vs. coming soon - implementation plan

> **Amended 2026-10-02 after code review round 1** (records:
> `docs/superpowers/reviews/2026-10-01-properties-available-view/review-adjudications-r1.md`).
> The tasks below are kept as PLANNED. What changed in the build: code names
> are unit-based (`propertyFacets` -> `unitListFacets`, `Property*` types and
> functions -> `UnitList*`, `PropertySummary` -> `AuthoritySummary`); Task 3's
> state model became local urgent state with the URL as persistence (chips and
> dropdown write at once, search writes on blur, a summary count pushes and
> applies locally); and the default view's empty state, the summary's
> not-counted line, the perf resolver/terminal fixes, and a frozen-router test
> (`ListingsList.urgentState.test.tsx`) were added. See design note 3.2, 3.3, 3.4,
> 3.5, 6 and 7.

Design: `docs/superpowers/specs/2026-10-01-properties-available-view-design.md`.
Worktree `W:\tmp\properties-available-view`, branch
`feat/properties-available-view` (from main @ae04122d). Small-fix lane: the
planner session builds this plan itself, test-first, so the code lives in the
commits rather than being pre-written here. Records:
`docs/superpowers/reviews/2026-10-01-properties-available-view/`.

## Global constraints

- Dashboard-only. No change under `app/` or to any seed.
- ASCII only on every added line (source, tests, docs, copy).
- Every piece of list filter state derives from the URL (the component stays
  mounted across `/listings` and `/listings/deleted`).
- Filter writes use `setSearchParams(params, { replace: true })`.
- Status default: Active `available`, Deleted `all`. "Coming soon" = `setup`.
- Stored spellings only; `humanizeAuthority` is deleted.
- No bedroom fallback for voucher size.
- Gates run bare from the worktree; e2e under `timeout 1500`; never edit source
  while that worktree's e2e runs; DynamoDB Local is never restarted.

## Task 1 - one voucher bucket rule + `voucherSizesOf`

Files: `dashboard/src/routes/contacts/tenantFacets.ts`,
`dashboard/src/routes/contacts/tenantFacets.test.ts`,
`dashboard/src/routes/listing/listingFormat.ts`,
`dashboard/src/routes/listing/listingFormat.test.ts`.

1. Red: tests for `voucherBucketOfSize(size: unknown)`: 0 -> '0', 2 -> '2',
   2.7 -> '2', 4 -> '4plus', 9 -> '4plus', -1 -> '0', Infinity -> '4plus',
   NaN -> null, '2' -> null, undefined -> null. Tests for
   `voucherSizesOf(unit)`: 2 -> [2]; [2, 3] -> [2, 3]; [2, 'x', null, 3] ->
   [2, 3]; NaN -> []; '2' -> []; absent -> []; [] -> [].
2. Green: extract `export function voucherBucketOfSize` from `voucherBucketOf`
   (which now delegates); add `voucherSizesOf` beside `authoritiesOf`.
3. Run `npx vitest run src/routes/contacts src/routes/listing/listingFormat.test.ts`
   in `dashboard/` - all green (the tenant suites prove the delegation).
4. Commit.

## Task 2 - the pure `propertyFacets` module

Files: `dashboard/src/routes/listings/propertyFacets.ts` (+ `.test.ts`).

Exports:

- `type PropertyView = 'active' | 'deleted'`; `type StatusFilter = UnitStatus | 'all'`.
- `defaultStatus(view)`: 'available' | 'all'.
- `interface PropertySelection { status: StatusFilter; ha: ReadonlySet<string>; voucher: ReadonlySet<string>; q: string }`.
- `parsePropertySelection(params, view)` / `applyPropertySelection(params, sel, view)` (in place; touches only `status`, `ha`, `voucher`, `q`).
- `authorityOptions(units)`: `{ options: {key, label}[] (sorted by key), hasUnrecorded: boolean }`.
- `pruneSelection(sel, authority)`: drops `ha` keys not in the options (and `__none__` unless `hasUnrecorded`).
- `unitAuthorityKeys(unit)`: distinct non-empty normalized keys.
- `unitVoucherBuckets(unit)`: set of bucket keys (via `voucherSizesOf` + `voucherBucketOfSize`).
- `matchesVoucher(unit, keys)`, `matchesAuthority(unit, keys)`, `applyPropertyFilters(units, sel)` (status, voucher, authority, search on `shortAddress`).
- `buildAuthoritySummary(units, voucherKeys, labels)`: `{ all: {available, comingSoon}, rows: {key, label, available, comingSoon}[] }` - rows sorted by key, `__none__` last, zero/zero rows dropped; `all` counts each unit once.
- `countSelection(current, status, key | null)`: the selection a count link
  applies (status set, `ha` = {key} or empty, voucher kept, `q` cleared).

Red first for each: defaults per view; unknown status -> default; repeated
params; unknown voucher dropped; `q` round-trip; default status omitted on
write; unrelated params kept; prune of a stale key and of `__none__`; a unit
listing two spellings of one authority counts once; a multi-authority unit
counts under each row but once in All; a no-authority unit lands in
`__none__`; zero/zero rows hidden; summary follows the voucher keys; voucher
list [2, 3] matches '2' and '3' but not '4plus'; Not recorded matches only a
unit with no bucket; filters AND across facets.

Commit when green.

## Task 3 - `ListingsList` on the URL, voucher chips, summary table

Files: `dashboard/src/routes/listings/ListingsList.tsx`,
`ListingsList.module.css`, `ListingsList.test.tsx`, new
`PropertySummary.tsx` (+ CSS module).

1. Red: update/add component tests (mocked `useListings(deleted)` returning a
   per-view state; a `LocationProbe` for the URL):
   - Active opens on Available: an occupied unit is hidden until "All statuses".
   - Deleted opens on All statuses and renders no summary.
   - The summary renders the All row, per-authority rows (stored spelling),
     the no-authority row, hides zero rows, and the note line.
   - Clicking a count sets status + authority, keeps voucher, clears search,
     and the list shows exactly the counted rows; a zero count is not a link.
   - Voucher chips filter (a number and a list value; Not recorded), and the
     summary counts follow them.
   - Initial URL `?status=setup&voucher=2&ha=<key>&q=...` restores every control.
   - Chips show stored spellings ('atlanta_housing', 'Atlanta (AHA)').
   - Lock regression: select an authority on Active, click the Deleted tab
     (deleted units carry none) -> rows are not filtered to zero; a stale
     `?ha=` on load does not empty the list.
2. Green: rewrite the component's state on `useSearchParams` via
   `propertyFacets`; add the voucher group and the Not recorded authority chip;
   delete `humanizeAuthority`; add `PropertySummary` (table, links via
   `<Link to={{ search }} replace>`); tabs carry the query only on the active
   view's own tab; subtitle copy.
3. CSS: summary card + table (tabular numbers, right-aligned counts, wraps at
   360px under the existing container query style).
4. Run `npx vitest run src/routes/listings src/routes/contacts src/routes/listing`
   in `dashboard/`; then `npm run typecheck` at the root. Commit.

## Task 4 - docs and ledgers

- `docs/issues/properties-authority-filter-invisible-lock.md`: status resolved
  with a resolution note.
- `docs/issues/retire-humanize-authority.md`: progress note (step 2 done here;
  steps 1, 3, 4 remain, owned by tracker #2); refresh its refs.
- `e2e/performance/routes.ts`: refresh the `/listings` and `/listings/deleted`
  terminal citations to the new line numbers.
- Commit.

## Task 5 - e2e spec

File: `e2e/tests/dashboard-next/properties-available-view.spec.ts`
(dashboard-next dialect: local NEXT + devLogin, raw `page.request` setup,
accessibility-first locators, self-cleaning, no reseed).

Setup: a landlord contact; a run-unique authority A and a second run-unique
authority B; units: U1 available / A / voucher 2; U2 available / [A, B] /
voucher 3; U3 setup / A / voucher 2.

Steps: `/listings` opens with Status = Available; the summary row for A reads
Available 2, Coming soon 1; B reads Available 1, Coming soon 0 (zero is not a
link); click A's Coming soon count -> Status = Setup, one row (U3); reload ->
same; click A's Available count -> rows U1 + U2; pick 3-BR -> only U2, and A's
row now reads Available 1; open U2 and go Back -> filters intact; Deleted tab ->
bare URL, Status = All statuses; at 360px the Active page has no sideways
overflow (then restore).

Run it alone first (`npm run e2e:session` lane via the e2e workspace), then the
full gate.

## Task 6 - gates, live QA, review, handback

1. Gates (bare, real exit codes): `npm run typecheck`, `npm test`,
   `npm run smoke`, `timeout 1500 npm run e2e`,
   `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.
2. Live QA: `npm run e2e:session`, Playwright MCP, dev-login, the lean world
   plus API-created properties; desktop and 360px screenshots under
   `.playwright-mcp/`.
3. Review: an adversarial plan-blind reviewer (diff + repo + charter only) and
   a conformance check against the design note, both `model: opus`; adjudicate
   to `<records>/review-adjudications.md`; one fix wave; re-review the fix diff
   with the SAME reviewer.
4. Sync main once; re-run gates if main moved.
5. Handback `<records>/handback.md`; memory topic + index; tracker #1 note text;
   notification.
