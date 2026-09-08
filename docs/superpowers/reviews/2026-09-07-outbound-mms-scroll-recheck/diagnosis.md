# Populated-timeline viewer setup: diagnosis and fix plan

## Scope

Authorized small fix on `codex/outbound-mms-scroll-recheck`, initially based on
`f82c149c`. No product change, aggregate tests, merge, deploy, or worktree cleanup.
Use `E2E_TRACE=1`; leave `E2E_CHILD_LOG_DIR` unset. Preserve artifacts before reruns.

## Evidence before implementation

- Exact `fake records media` case alone: 1 passed, exit 0, 38.0s.
- Outbound-MMS file alone: 6 passed, exit 0, 49.5s.
- The two `mms-transcode` cases followed by the exact outbound case: 2 passed,
  1 failed, exit 1, 22.6s. Failure: `trigger is not visible` in setup, before
  the viewer opens. This matches the preserved maintenance-branch full-run trace.
- Adding geometry-only instrumentation reproduced the same sequence failure:
  2 passed, 1 failed, exit 1, 22.2s.
- A real inbound message with 70 history lines makes the exact case fail alone
  against the old setup. This is the permanent regression fixture, not DOM
  cloning or a dependency on another spec.

## Measured root cause

`outbound-mms.spec.ts` enlarges the route to exercise AppFrame scrolling, then
caps the Timeline at 180px only if it does not already overflow. With prior MMS
attachments, enlarging the route grows the Timeline from 623px to 1171px while
its content is 1297px tall. The cap is skipped despite the stream exceeding the
900px viewport. Chromium clamps Timeline scrollTop from 660 to 126.

The thumbnail moves from y=713 to y=1247 during sizing. `scrollIntoView(center)`
then scrolls AppFrame to 548 AND the document to 251, placing it at y=448.
Forcing AppFrame back to 20 shifts the thumbnail to y=976, below the viewport.
The test throws before installing its viewer recorder or clicking the trigger.

The self-contained history fixture reproduces the same sequence with content
height 1911, Timeline offset 740, document offset 252, and thumbnail y=976.
This is data-dependent test geometry, not viewer pointer leakage or a resource
contention diagnosis. One Playwright worker reproduces it in three tests.

The earlier `e06b133c` Delivered checkpoint fixes a different demonstrated
failure (512 to 500 after delivery re-anchoring). Keep that lifecycle wait.

Main sync subsequently brought in the separately filed
`e2e-outbound-mms-viewer-trigger-not-visible` issue. It is canonical for this
visibility failure. Restore the older scroll-offset issue to its resolved
state and keep its existing duplicate pointer; do not conflate mechanisms.
The initial reopening in this branch is superseded by that issue reconciliation.

## Fix and validation plan

1. Bound the arranged Timeline consistently, regardless of existing overflow.
2. Position the thumbnail by scrolling the named Timeline only; do not scroll
   the document while arranging AppFrame and Timeline baselines.
3. Keep nonzero-owner preconditions, real thumbnail clicks, and all exact
   equality checks after open, zoom, each pan, and Escape. No sleeps/tolerance.
4. Keep the long-history fixture so isolated runs exercise populated history.
5. Run E2E workspace typecheck, targeted viewer/Timeline units, the exact case,
   the three-test sequence, and the outbound-MMS file. Touched-file lint uses
   baseline attribution. Obtain independent adversarial review after proof.
6. Sync main once before final targeted verification; commit durable findings
   and issue reconciliation, and leave the branch unmerged.

## Local raw evidence (not committed)

Under `W:\tmp\outbound-mms-scroll-recheck\.superpowers\scroll-recheck\`:

- `focused-run/results.json` and `outbound-file-run/results.json`: passing controls.
- `failing-sequence/`: unchanged three-test RED and trace.
- `diagnostic-red/`: geometry-instrumented three-test RED and trace.
- `history-fixture-red/`: isolated permanent regression fixture RED and trace.

The exact focused command is:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/outbound-mms.spec.ts --grep "fake records media"
```

The minimal order-dependent reproducer is:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/mms-transcode.spec.ts tests/dashboard-next/outbound-mms.spec.ts --grep "a webp attachment|a small png|fake records media"
```
