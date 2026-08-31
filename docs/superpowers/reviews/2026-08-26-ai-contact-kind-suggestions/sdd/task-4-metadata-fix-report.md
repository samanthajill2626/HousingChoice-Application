# Task 4 metadata fixture correction report

## Scope

- Changed only `app/test/aiRunVerdicts.test.ts`.
- Preserved parent commit `fdd46af1`; correction commit is recorded below.
- No production, helper, dashboard, schema, prompt, E2E, config, infra, seed, or
  migration files changed.

## TDD evidence

RED after adding only the two stored-decision `proposedValue: 'tenant'`
assertions, before correcting either fixture caller:

```text
npm run test -w @housingchoice/app -- test/aiRunVerdicts.test.ts -t "drains an older row injected|banks the real PATCH"
exit 1; 1 file failed; 2 tests failed; 70 skipped.
run-empty-snapshot: expected proposedValue "tenant", received undefined.
run-finalizing: expected proposedValue "tenant", received undefined.
```

GREEN after adding `'tenant'` as the third argument at the two remaining
callers:

```text
npm run test -w @housingchoice/app -- test/aiRunVerdicts.test.ts -t "drains an older row injected|banks the real PATCH"
exit 0; 1 file passed; 2 tests passed; 70 skipped.
```

## pendingTypeRun caller audit

All callers now supply a defined canonical proposal:

- `run-empty-snapshot` at `app/test/aiRunVerdicts.test.ts:2044`: `tenant`,
  matching the injected tenant suggestion.
- `run-race-a` at `:2087`: `tenant`.
- `run-race-b` at `:2088`: `landlord`.
- `run-race-c` at `:2089`: `partner`.
- `run-finalizing` at `:2173`: `tenant`, matching the finalization suggestion.

The A/B/C tenant/landlord/partner handling remains unchanged. The two corrected
stored decision assertions explicitly retain `proposedValue: 'tenant'` alongside
their outcome, verdict, actor, and existing verdict-time metadata. Exact Property
Manager casing proof was not changed.

## Focused verification

```text
npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts
exit 0; 5 files passed; 197 tests passed.

npm run typecheck -w @housingchoice/app
exit 0.

npx eslint app/test/aiRunVerdicts.test.ts
exit 0.
```

## Commit and unresolved items

- `42313627 test: pin pending type run proposals`
- Net change: 4 insertions, 4 deletions in one test file.
- Unresolved items: none within this task's S4 metadata-correction scope.
