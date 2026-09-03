# Outbound MMS Scroll Flake Verification

Date: 2026-09-02
Branch: `fix/outbound-mms-scroll-flake`
Lane: authorized small fix

## Before-fix red

Trace enabled, child-log redirection disabled:

`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/outbound-mms.spec.ts --grep "fake records media"`

Exit 1. The exact focused case failed with expected Timeline 512 and received
500. The complete failure artifacts were preserved before rerun under
`.artifacts/red-scroll-512-to-500-20260902`.

## Focused implementation proof

- `npm run typecheck -w @housingchoice/e2e`: exit 0.
- `npm test -w @housingchoice/dashboard -- src/routes/contact/streamAnchor.test.ts src/ui/imageViewer/scroll.test.ts src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/ImageViewer.test.tsx`: exit 0; 4 files and 33 tests passed.
- Exact focused E2E command above with trace enabled and child logs disabled:
  exit 0; 1 passed in 21.8 seconds, test body 7.9 seconds.

The green recorder contained every required phase, no native scroll event, and
stable AppFrame 20 and Timeline 512 through viewer open, zoom, four pan bounds,
Escape, and dismissal restoration.

## Adversarial review fix proof

- `npm run typecheck -w @housingchoice/e2e`: exit 0.
- Exact focused E2E command above with trace enabled and child logs disabled:
  exit 0; 1 passed in 33.8 seconds, test body 12.1 seconds.
- `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/history.test.ts src/ui/imageViewer/fitImage.test.ts`: exit 0; 2 files and 27 tests passed.
- Independent focused re-review: PASS; no remaining findings.

## Lint attribution

`npx eslint e2e/tests/dashboard-next/outbound-mms.spec.ts` reports the same one
pre-existing `DIANA_ID` unused-variable error on this branch and current main.
There is no new touched-file lint error.

## Scope guard

No aggregate `npm test` or full E2E suite was run. No product source file was
changed. The `feat/message-transport-fidelity` worktree and branch were not
modified.

The branch synced main at `a2602e32`. Main later advanced by the unrelated
`b45e6fdc` message-transport documentation cleanup and `bb54fdaa` public-flyer
change, with no path intersection with this fix. Per the single-sync worktree
rule, that later drift is reported rather than merged again.
