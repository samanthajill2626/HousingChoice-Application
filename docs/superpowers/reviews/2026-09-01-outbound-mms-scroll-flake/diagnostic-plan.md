# Outbound MMS Viewer Scroll Diagnostic Plan

Date: 2026-09-01
Branch: `fix/outbound-mms-scroll-flake`
Base: `f27aabbfddbfe38f54ed91930e41070f0610744f`
Lane: authorized small diagnostic fix

## Decision

Treat the two issue records as one unresolved defect. Do not change the image
viewer, Timeline behavior, or the disputed assertion until a failing run identifies
the first scroll or geometry event. The two historical failures moved in opposite
directions, and neither retained artifacts, so the current evidence cannot select a
safe fix.

## Instrumentation contract

The diagnostic recorder is enabled only when `E2E_TRACE=1`. It observes the two
scroll owners and route root from inside the browser, caps its event buffer, and
records phase, native scroll, DOM mutation, and resize samples. Each sample includes
raw offsets and enough geometry to distinguish a direct write, clamping after a
shrink, bottom repinning after growth, or unrelated layout movement.

The recorder attaches JSON immediately before the known assertion. A passing test
also attaches a final sample after dismissal. The recorder must not dispatch input,
write scroll positions, add waits, or change the assertion.

## Validation

1. `npm run typecheck -w @housingchoice/e2e`
2. `E2E_TRACE=1 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/outbound-mms.spec.ts`
3. `E2E_TRACE=1 npm run e2e`
4. ESLint on the touched TypeScript file, compared with the merge-base result if
   any error appears.
5. Adversarial review of instrumentation side effects, diagnostic completeness,
   issue accuracy, and preserved artifacts.
6. Rerun the focused checks after any review fix.

The full run is explicitly authorized by the human. `E2E_CHILD_LOG_DIR` stays unset
because redirected child output would alter the timing under investigation.

## Artifact rule

Before any rerun after a failure, copy `e2e/.artifacts/test-results`,
`e2e/.artifacts/results.json`, and any HTML report into a timestamped directory
under the worktree's root `.artifacts/` directory. Record the preserved path and
the failing assertion in the diagnostic run report.
