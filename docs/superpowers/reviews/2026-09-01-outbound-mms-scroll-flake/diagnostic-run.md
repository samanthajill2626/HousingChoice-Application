# Outbound MMS Viewer Scroll Diagnostic Run

Date: 2026-09-01
Branch: `fix/outbound-mms-scroll-flake`
Base: `f27aabbfddbfe38f54ed91930e41070f0610744f`

## Clean-main focused baseline

- `npm run typecheck -w @housingchoice/e2e`: PASS.
- `E2E_TRACE=1 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/outbound-mms.spec.ts`:
  PASS, 6/6 in 1.3 minutes.

No source edits were present for this baseline.

## Instrumented focused proof

- `git diff --check`: PASS after removing two Markdown EOF blanks.
- `npm run typecheck -w @housingchoice/e2e`: PASS after correcting one recorder-only
  `EventTarget` type narrowing error.
- Traced focused spec: PASS, 6/6 in 1.0 minute.

The passing test attached two JSON records to `e2e/.artifacts/results.json`:

- before assertion: 15 samples (13 phase, 1 mutation, 1 resize);
- after dismissal: 16 samples (14 phase, 1 mutation, 1 resize).

All required phases were present. No native scroll event occurred while the viewer
was open. Every phase reported AppFrame `top=20` and Timeline `top=193`. Timeline
also reported `maximumTop=193` and `distanceFromBottom=0`, proving that this passing
case began pinned to the bottom. The single mutation did not change owner geometry.

## Full traced run

- Command: `E2E_TRACE=1 npm run e2e` with `E2E_CHILD_LOG_DIR` unset.
- Commit: `86db0010eebf9614bc86357e0857a7623babdcdd`.
- Result: FAIL, 258 passed and 4 failed in 41.0 minutes.
- All 6 tests in `outbound-mms.spec.ts` passed. The target desktop viewer case
  passed in 10.235 seconds and produced both recorder attachments.

The four failures were outside the changed spec and had different signatures:

1. `group-text-per-recipient-delivery.spec.ts:63`: the live per-recipient rollup
   did not settle at 2/3 before its budget expired.
2. `group-text-reply-all.spec.ts:45`: the live per-member delivery rollup did not
   finalize before its budget expired.
3. `group-text-stop.spec.ts:48`: the live delivery rollup around the opted-out leg
   did not finalize before its budget expired.
4. `matching-entry-points.spec.ts:266`: a property suggestion option intercepted
   the property-row click until the test timed out.

This run does not attribute those failures to pre-existing behavior, tracing, or
the diagnostic change. Each failure retained a screenshot, video, error context,
and trace.

The target recorder contained 17 samples before the assertion and 18 after
dismissal: 14 phase samples, 3 mutations, 1 resize, and no native scroll events.
AppFrame stayed at `top=20`. Timeline stayed at `top=509`, while three background
mutations changed its `scrollHeight` from `989` to `997`, then `975`, and finally
`977`. The Timeline maximum therefore moved from `809` to `817`, then `795`, and
finally `797`. The final `distanceFromBottom` was `288`.

That final maximum is exactly the historical 2026-09-01 failure's received value:
expected `509`, received `797`. This makes a Timeline bottom repin after background
mutation the strongest explanation for the newer occurrence. It is not proof of
the triggering write because the control remained at `509`, and it cannot explain
the older opposite-direction Timeline movement plus AppFrame reset.

## Artifact preservation

Before any rerun, the full run was copied to:

`W:\tmp\outbound-mms-scroll-flake\.artifacts\full-trace-20260901-1239-86db0010`

The preserved directory contains `html-report`, `test-results`, `lane.json`, and
`results.json`. The report includes all four failure traces and the passing target's
two JSON recorder attachments.

## Post-review proof

The adversarial review found that mutation targets were too generic to identify a
future content change. After adding compact node descriptions and Timeline context:

- `git diff --check`: PASS.
- `npm run typecheck -w @housingchoice/e2e`: PASS.
- `npx eslint e2e/tests/dashboard-next/outbound-mms.spec.ts`: the branch and main
  each report only the same pre-existing unused `DIANA_ID`; no new lint error.
- `E2E_TRACE=1 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/outbound-mms.spec.ts`:
  PASS, 6/6 in 1.0 minute.

The first sandboxed browser launch could not access Docker's named pipe and stopped
before Playwright started. The identical command passed after it was given Docker
access; this was an execution-permission failure, not a test retry.

The final attachment contained the new fields. Its one mutation identified the
Timeline status element (`span._status..._toneSuccess...`) and reported unchanged
stream geometry, no upcoming panel, no load-older control, no new-messages pill,
and stable child counts. This proves the richer payload is active and remains
read-only in the focused control.
