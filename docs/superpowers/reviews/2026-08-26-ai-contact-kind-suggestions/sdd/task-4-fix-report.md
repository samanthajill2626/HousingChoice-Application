# Task 4 review fix wave report - contact kind reconciliation proof

## Commit

- `5c17222b test: cover contact kind reconciliation races`

## TDD red proof

- `npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/aiRunVerdicts.test.ts` exited `1` before the fake change: all three new route tests failed. The finalization handoff reproduced the review finding exactly: the later stored type decision remained `pending` because the shared fake `setVerdict` returned true without banking the in-flight marker.
- The two drain tests also established the real route boundaries. Their first assertions expected only the required reads, then failed because the production bounded drain correctly performs its final no-row consistent read after deletion: empty-snapshot is three consistent reads (pre-write, injected post-write, final empty); A -> B -> C is four (pre-write, B, C, final empty). The proof was corrected to pin those real counts, not a production defect.

## Delivered proof

- Empty pre-write type snapshot injects revision-0 only at the first post-write consistent read. The real PATCH drains it, clears repository/contact-suggestions/Today, and persists `superseded_by_human_edit` with route actor and exact candidate `createdAt`.
- A -> B -> C replacements occur only from the shared fake's actual guarded-delete hook. The test proves four consistent reads, three CAS calls in A/B/C identity order, cleared repository/contact-suggestions/Today, and terminal stored C verdict metadata.
- The shared `AiRunsRepo` fake now mirrors real run-row and in-flight-marker behavior for `setVerdict`: it honors an existing pending decision, banks one terminal marker during finalization, consumes it in `putRun`, and only creates a fallback marker for fresh, unexpired suggestions. The real PATCH-to-finalization test proves the later stored decision remains `outcome: suggested` and becomes `superseded_by_human_edit`, never `pending` or `not_presented`.
- Pure lower- and upper-case unsupported Property Manager roles and the lowercase route verdict are pinned as superseded, preserving exact byte matching.

## Verification

- RED: `npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/aiRunVerdicts.test.ts` - exit `1`; 3 expected regression failures (see above).
- GREEN: `npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts` - exit `0`; 5 files, 197 tests passed.
- GREEN: `npm run typecheck -w @housingchoice/app` - exit `0`; app, scripts, and test TypeScript configs passed.
- GREEN: `npx eslint app/test/contactKinds.test.ts app/test/aiRunVerdicts.test.ts app/test/helpers/twilioWebhookHarness.ts` - exit `0`.
- GREEN: `git diff --check` - exit `0` before commit.

## Files

- `app/test/contactKinds.test.ts`
- `app/test/aiRunVerdicts.test.ts`
- `app/test/helpers/twilioWebhookHarness.ts`

## Scope and unresolved items

- No production route, dashboard, schema/prompt activation, E2E, import/seed/migration, or infrastructure/configuration file changed.
- No unresolved S4 review finding remains. Full feature gates and the later mission steps remain owned by the orchestrator.
