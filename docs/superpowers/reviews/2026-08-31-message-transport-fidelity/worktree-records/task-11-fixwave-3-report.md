# Task 11 fix wave 3 report

## Scope and rule

Implemented accepted P1 only: every non-empty already formatted `RecipientRow.when`
is appended to the collapsed chip recital through the existing ASCII ` - ` separator,
which `speakDeliveryText` presents as `, `. This applies to both the ordinary rollup
chip and the all-opted-out message-chip branch. The legacy parent-schema transport
gate, version-1 `Unknown`, recipient identity and status, all-opted-out behavior,
and visual presentation are unchanged.

## TDD evidence

- Initial focused run: exit 1 before test collection because Vite could not create
  `dashboard/node_modules/.vite-temp/vite.config.ts.timestamp-...mjs` (`EPERM`).
- Separate rerun with the generated Vite config writable: exit 1; 2 test files,
  155 passed and 2 expected accessibility-name failures. The ordinary rollup omitted
  `10:47a` and `11:03a`; the all-opted-out message chip omitted the same retained
  leg times.
- After the minimal production change: exit 0; 2 test files passed, 157 tests passed.

## Verification

- `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/contact/Timeline.delivery.test.tsx`: exit 0, 2 files passed, 157 tests passed.
- `npm run typecheck -w @housingchoice/dashboard`: exit 0.
- `git diff --check`: exit 0.
- ASCII check of added lines: passed.

## Files and commit

- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.delivery.test.tsx`
- `e8d747f8 fix: include recipient times in accessibility`

## Divergence

None. `Timeline.test.tsx` did not need fixture changes.
