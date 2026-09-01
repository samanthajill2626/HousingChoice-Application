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

Pending.
