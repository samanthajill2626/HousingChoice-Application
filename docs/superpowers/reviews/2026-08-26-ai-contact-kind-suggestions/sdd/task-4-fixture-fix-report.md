# Task 4 fixture correction report

## Scope

Changed only `app/test/aiRunVerdicts.test.ts`; no production code, schema,
dashboard, seed, configuration, or infrastructure files changed.

## Red proof

Before the fixture correction, the tightened A -> B -> C retry test failed:

```text
expected { proposedValue: 'tenant', ... } to match object
{ proposedValue: 'tenant', verdict: 'superseded_by_human_edit' }
Received verdict: 'pending'
```

The focused command exited 1 because the direct B/C repository replacement
left `run-race-a/type` pending. It also exposed that the shared helper had
seeded every type decision as `tenant`, despite B and C publishing `landlord`
and `partner` respectively.

## Corrected run-state handling

- `pendingTypeRun` now receives the exact proposed kind. The A/B/C records are
  tenant, landlord, and partner.
- The retry hook now uses a test-local extraction replacement helper. It calls
  the repository replacement first, obtains the exact displaced row, and then
  models the extraction job's post-record `superseded` stamp using that row's
  run ID and `createdAt`. It does not mutate a run record directly.
- After the real PATCH bounded retry, the test proves A and B are terminal
  `superseded`; C remains a `partner`/`suggested` decision and is terminal
  `superseded_by_human_edit` with the route actor, C's exact freshness timestamp,
  and the route verdict time persisted to the record.
- Existing exact A/B/C guarded-delete identities, consistent-read count,
  repository deletion, contact suggestions absence, and Today absence remain
  asserted.

## Green evidence

```text
npm run test -w @housingchoice/app -- test/aiRunVerdicts.test.ts -t "re-reads and exact-deletes"
exit 0: 1 file passed, 1 test passed, 71 skipped

npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts
exit 0: 5 files passed, 197 tests passed

npm run typecheck -w @housingchoice/app
exit 0

npx eslint app/test/aiRunVerdicts.test.ts
exit 0
```

## Unresolved items

None in this narrow fixture scope. Full mission gates were intentionally not
run by this slice.
