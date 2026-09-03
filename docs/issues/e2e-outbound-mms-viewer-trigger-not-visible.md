---
id: e2e-outbound-mms-viewer-trigger-not-visible
title: outbound-mms viewer case fails in EVERY full-suite run on main - "trigger is not visible" (not the closed scroll flake)
type: bug
severity: med
status: open
area: e2e
created: 2026-09-02
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:591, docs/issues/e2e-image-viewer-scroll-flake.md
---

**Problem.** `outbound-mms.spec.ts:517` ("(a) attach + send an image: the fake
records media AND the timeline renders it") fails in EVERY full-suite run
observed on 2026-09-02, on `main` and on a branch, with a byte-identical error:

```
Error: locator.evaluate: Error: trigger is not visible
    at e2e/tests/dashboard-next/outbound-mms.spec.ts:591
```

The spec resolves the "View Attachment 1" button, calls
`scrollIntoViewIfNeeded()`, asserts no dialog is open, then calls
`trigger.evaluate(...)` on the NEXT line - and the element is not visible by the
time `evaluate` runs. Everything before it succeeded: the send, the fake
provider's media record, the authenticated image response, and the rendered
Timeline thumbnail (the preceding `naturalWidth > 0` assertion passed).

**This is NOT the flake closed the same day.**
[`e2e-image-viewer-scroll-flake`](e2e-image-viewer-scroll-flake.md) (resolved
2026-09-02, the `fix/outbound-mms-scroll-flake` merge) was a scroll OFFSET
MISMATCH - expected Timeline `scrollTop` 512, received 500. This is an element
VISIBILITY failure one line earlier, at the capture site rather than in the
captured value. Same spec, same neighbourhood, different mechanism. Reopening
that issue would bury the distinction.

**Reproduces in the full suite only.** Running the file alone passes:
`npx playwright test tests/dashboard-next/outbound-mms.spec.ts` from the e2e
workspace was green (21 tests, 3.8m), so the trigger's visibility depends on
cross-spec process state, machine load, or timing that only the full suite
produces. That also means it cannot be diagnosed by re-running the file.

**Evidence (2026-09-02, three full `npm run e2e` runs).**

| Run | Commit | Result | outbound-mms:517 |
|---|---|---|---|
| branch run 1 | `docs/media-cache-risk-accepted` | 5 failed / 261 passed | FAILED, this signature |
| merge base | `main` @ d4298abe | 1 failed / 265 passed | FAILED, this signature |
| branch run 2 | `docs/media-cache-risk-accepted` | 3 failed / 263 passed | FAILED, this signature |
| relay-30003 gate 4 | `feat/relay-30003-retry-lineage` @ 17bf49a7 (main @ f82c149c merged in) | 1 failed / 266 passed (17.7m) | FAILED, this signature (`:591`, byte-identical) |

The branch carried a one-header change to an unrelated route, so the base run is
the load-bearing row: **main alone reproduces it.** 3/3 full runs, 0/1 isolated
runs.

**Sighting 4 (2026-09-02, `feat/relay-30003-retry-lineage`).** The same case
was the ONLY red in that branch's full battery, with this exact signature, and
the file then passed alone twice on the same code (`6 passed (59.9s)` and
`6 passed (41.0s)`, both via `npm run e2e -- tests/dashboard-next/outbound-mms.spec.ts`
from the e2e workspace, lane 9, no orphaned listener). That branch touches the
relay delivery presenter and the shared Timeline, but every one of its hunks is
gated on relay-only fields (`relay_retry_of`, a relay roster kind) that a 1:1
composer send never sets, and its earlier checkpoint run at the pre-sync base
showed the CLOSED scroll-offset signature instead - so this is now 4/4 full
runs on three different trees, 0/3 isolated. Not attributable to that branch.

**Suggested fix.** Diagnose why the trigger goes non-visible between
`scrollIntoViewIfNeeded()` and `evaluate()` - a re-render/re-anchor of the
Timeline between the two calls is the obvious candidate, and is the same CLASS
of lifecycle race the closed issue fixed one line further on. A trace is the
decisive artifact here, not a log: note that `retries: 0` with
`trace: 'on-first-retry'` collects nothing, so a gate failure currently carries
no trace at all.

**Do not treat this as a flake to re-run past.** AGENTS.md's named-flake re-run
list is empty by design; this is a deterministic full-suite failure on main,
which means the gate is currently red for everyone.
