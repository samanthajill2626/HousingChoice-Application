# Task 4 metadata correction re-review

## Result

PASS - no findings. Every `pendingTypeRun` caller supplies the defined canonical
proposal belonging to its suggestion, the empty-snapshot and finalization-handoff
proofs now assert that proposal in the stored decision, and the correction does
not weaken the A/B/C identity or exact Property Manager marker semantics.

## Static review evidence

- The helper requires a defined `tenant | landlord | partner` proposal and stores
  it directly as `decisions.type.proposedValue`
  (`app/test/aiRunVerdicts.test.ts:98-118`). There are exactly five code callers:
  empty snapshot `tenant` (`:2044`), race A `tenant` (`:2087`), race B `landlord`
  (`:2088`), race C `partner` (`:2089`), and finalization handoff `tenant`
  (`:2173`).
- The empty-snapshot fixture publishes a tenant suggestion (`:2050-2057`) and its
  terminal stored-decision assertion now requires `proposedValue: 'tenant'`
  alongside `suggested`, `superseded_by_human_edit`, and the route actor
  (`:2072-2076`). Removing or undefining that proposal therefore breaks the proof.
- The finalization fixture publishes a tenant suggestion (`:2156-2160`), banks the
  real PATCH verdict with the pending/freshness fence (`:2169-2171`), and after
  `putRun` requires `proposedValue: 'tenant'` together with the terminal verdict,
  actor, and exact banked verdict time (`:2172-2176`). The faithful marker merge
  spreads the pending decision and changes only terminal verdict fields
  (`app/test/helpers/twilioWebhookHarness.ts:3340-3367`), so the assertion makes
  proposal retention load-bearing through the handoff.
- A/B/C remain distinct end to end: their runs are tenant/landlord/partner
  (`app/test/aiRunVerdicts.test.ts:2087-2089`), their rows use the matching values
  and exact A/B/C timestamps (`:2091-2110`), and guarded deletes are asserted in
  A/B/C run-id order (`:2116-2123`). The stored decisions retain the same three
  proposals and ownership outcomes (`:2129-2149`). Repository replacement still
  returns the displaced row (`app/test/helpers/twilioWebhookHarness.ts:3230-3265`),
  extraction-side displacement stamps use that row's exact run/timestamp
  (`app/test/aiRunVerdicts.test.ts:80-95`), and guarded deletion still compares
  exact identity before deleting (`app/test/helpers/twilioWebhookHarness.ts:3298-3311`).
- Exact preset semantics remain pinned: only byte-exact `Property Manager` maps to
  `property_manager`, while lowercase, uppercase, padded, and other custom roles
  remain unsupported (`app/test/contactKinds.test.ts:8-35`). Route verdict cases
  still accept exact casing and supersede lowercase/plain-landlord shapes
  (`app/test/aiRunVerdicts.test.ts:1928-1958`). The correction commit changes none
  of those lines.

## Verification

- `git diff --check fdd46af1..42313627`: exit 0, no output.
- Static diff scope: only `app/test/aiRunVerdicts.test.ts`; 4 insertions and 4
  deletions. The four semantic changes are the two required `tenant` arguments and
  the two stored-decision `proposedValue: 'tenant'` assertions.
- Per the mission's exhausted EPERM recovery budget, no Vite or Vitest command was
  run in this review.
- Prior permitted TDD evidence from
  `task-4-metadata-fix-report.md`: adding the two assertions first failed exactly
  the empty-snapshot and finalization tests with `proposedValue` undefined; adding
  the two caller arguments then passed those 2 tests. The same report records the
  broader S4 focused run as 5 files / 197 tests passed, app typecheck exit 0, and
  touched-file ESLint exit 0.

## Verdict

PASS. The metadata correction closes the prior Important finding without reopening
the A/B/C fidelity, finalization-marker, exact-identity, or Property Manager casing
proofs.
