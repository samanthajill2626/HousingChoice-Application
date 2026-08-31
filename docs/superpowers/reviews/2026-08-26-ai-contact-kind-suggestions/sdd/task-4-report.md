# Task 4 report - full contact-kind PATCH reconciliation

## Commit

- `20638a46 feat: resolve AI suggestions by full contact kind`

## TDD evidence

- Red pure resolver command: `npm run test -w @housingchoice/app -- test/contactKinds.test.ts` exited `1` because `../src/services/extraction/contactKinds.js` was absent.
- Red route command: `npm run test -w @housingchoice/app -- test/contactTriage.test.ts test/aiRunVerdicts.test.ts` exited `1`, with the intended failures: Property Manager was stamped superseded, custom landlord role was stamped accepted, and role-only PATCHes left type rows pending.
- The first green integration run exposed a genuine ordering defect (drain read `updated` and `verdictAt` before their declarations). The route's 500s were reproduced in 28 focused failures, traced to that placement, and corrected by moving the drain after the committed contact write and retained generic cleanup.

## Focused verification

- `npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts` - exit `0`; `5` files and `191` tests passed.
- `npm run typecheck -w @housingchoice/app` - exit `0`; `tsc -p tsconfig.json --noEmit`, script config, and test config all passed.

## Delivered behavior

- Added exact-byte `PROPERTY_MANAGER_ROLE` and a no-trim/no-case-fold canonical full-kind resolver.
- Kept the existing contacts PATCH surface as classification writer. Type or role changes use a consistent pre-read plus a best-effort, four-attempt, post-write guarded-delete drain of older type rows.
- Only a retained pre-write identity can be accepted; all replacements are superseded. Legacy rows without `runId` are removed without an AI-run verdict stamp. Same/newer classification revisions are retained.
- The existing non-type suggestion cleanup, generic type-accept refusal, conversation behavior, status mappings, and tenant-only immediate extraction remain unchanged.
- Harness hooks run at the actual fake consistent-read and guarded-delete boundaries. Tests cover full kinds, role-only writers, replacement cleanup across repository/Today/AI-run surfaces, and a reopened Unknown epoch.

## Import and surface sweep

- Verified route dependencies against Task 1-3 contracts: `SuggestedContactKind`, `contactClassificationRevision`, `sameSuggestionIdentity`, and `deleteTypeSuggestionIfCurrentAtContactRevision` are reused, not reimplemented.
- Searched route writers/readers and targeted tests: the contacts PATCH remains the sole writer; generic suggestion accept still rejects `type`; Today consumes pending rows from `listPending`; existing unknown-only conversation rewrite and tenant-only schedule paths remain in the same route blocks.

## Scope and incomplete work

- Touched only Task 4 route/helper/test files plus the new resolver and unit test. No dashboard, schema/prompt activation, E2E, infrastructure, imports/seeds/migrations, configuration, or production data change.
- The implementation contains the empty-pre-read post-write read, four-attempt drain, replacement retry, revision stop, and run-finalization verdict call. This slice adds executable coverage for one replacement and reopened-epoch interleavings, but does not yet add separate named regressions for every requested empty-pre-read, two-sequential-replacement, and finalization-marker handoff permutation. Controller review should treat those as remaining Task 4 test coverage to close rather than infer them from the implementation.
- No product-plan divergence. The full mission still owes later slices and final gates.
