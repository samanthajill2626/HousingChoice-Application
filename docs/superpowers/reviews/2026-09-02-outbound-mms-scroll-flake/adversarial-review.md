# Outbound MMS Scroll Flake Adversarial Review

Date: 2026-09-02
Branch: `fix/outbound-mms-scroll-flake`
Branch head reviewed: `6adbb2e73d249af87d92b65d52479e3cf5c7cc8c`
Current main reviewed: `b45e6fdca1ca9fc986df02e9d7b768c6aad1de19`
Lane: authorized small-fix adversarial review

## Scope and evidence

This review inspected the committed `main...HEAD` change and the current
uncommitted test fix. It did not edit implementation or issue files and did not
run Playwright or any E2E command. The primary agent owns that test lane.

The preserved red result at
`.artifacts/red-scroll-512-to-500-20260902/results.json` proves the original
failure precisely. Timeline began at `top=512`, `maximumTop=512`. While the
dialog was visible and the pointer was inside the viewer canvas, a Timeline text
mutation plus status-class change to `toneSuccess` changed Timeline to `top=500`
while `maximumTop` remained `512`; a native Timeline scroll event followed.
AppFrame remained at `top=20`. Every later pan phase stayed at `500`, and each
out-of-bounds endpoint resolved to no element under the pointer.

The current focused result in `e2e/.artifacts/results.json`, produced by the
primary agent after the fix, reports one expected test and zero unexpected
tests. Its two recorder attachments contain all named success-path phases. Both
owners remain exactly stable through open, wheel zoom, all four pans, Escape,
and dismissal restoration: AppFrame `20/548`, Timeline `512/512`.

The primary agent also reports the E2E workspace typecheck passing and 33
targeted unit tests passing. Those commands were not rerun by this reviewer.

## Findings

### P2 - Recorder evidence and cleanup are not failure-safe

The new exact assertions after open, wheel zoom, and every pan can terminate the
test at `e2e/tests/dashboard-next/outbound-mms.spec.ts:634`,
`e2e/tests/dashboard-next/outbound-mms.spec.ts:714`, or
`e2e/tests/dashboard-next/outbound-mms.spec.ts:734` before the first recorder
attachment at `e2e/tests/dashboard-next/outbound-mms.spec.ts:742`. Likewise, an
Escape, focus, URL, or restoration failure after
`e2e/tests/dashboard-next/outbound-mms.spec.ts:745` exits before the only
explicit stop at `e2e/tests/dashboard-next/outbound-mms.spec.ts:754`.

That loses the custom canvas, pointer, mutation, and owner chronology on exactly
the newly isolated failure boundary. It also relies on Playwright page teardown,
rather than the recorder's own stop path, to release the listeners and observers.
This repeats the evidence-loss class that motivated the recorder. Make final
attachment and stop failure-safe, such as with a guarded `finally` or equivalent
test cleanup that can distinguish an installed recorder. Preserve the existing
pre-assertion attachment for the known final while-open mismatch.

### P3 - The canonical issue contradicts the captured red evidence

The duplicate pointer is correctly resolved in
`docs/issues/outbound-mms-viewer-scroll-capture-flake.md:1`, but the canonical
record still says the first changing event is missing and the cause is open at
`docs/issues/e2e-image-viewer-scroll-flake.md:67`. That is now false: the
preserved red recorder identifies the status mutation, resulting `512 -> 500`
Timeline movement, unchanged maximum, native scroll event, stable AppFrame, and
non-background pan targets.

Before completion, update the canonical issue with that evidence and the
lifecycle-wait resolution, then resolve it if post-review proof remains green.
Keep the duplicate as the resolved pointer so old references continue to work.

## Attacked but held

- **Waiting for Delivered is the correct lifecycle boundary.** The fake's normal
  profile is deterministic `queued -> sent -> delivered`
  (`fake-twilio/src/engine/delivery.ts:8`), and the app permits transitions into
  `delivered` only from `queued` or `sent`
  (`app/src/repos/messagesRepo.ts:128`). Once the matching UI chip is visible,
  the status-driven React commit and Timeline layout effect have run. The wait is
  condition-based, not an arbitrary sleep.
- **The selector is scoped to the send under test.** The exact token excludes the
  inbound setup body, its parent is the message bubble rendered by
  `dashboard/src/routes/contact/Timeline.tsx:1014`, and the exact `Delivered`
  lookup is made inside that bubble
  (`e2e/tests/dashboard-next/outbound-mms.spec.ts:570`). A stale or unrelated
  delivered message cannot satisfy it.
- **The fix preserves the exact contract.** Equality remains exact; the change
  adds owner equality immediately after opening, after wheel zoom, and after
  every pan (`e2e/tests/dashboard-next/outbound-mms.spec.ts:634`,
  `e2e/tests/dashboard-next/outbound-mms.spec.ts:714`, and
  `e2e/tests/dashboard-next/outbound-mms.spec.ts:734`). No arbitrary delay or
  tolerance was introduced.
- **The recorder is read-only with respect to product state.** It observes
  pointer movement, scroll, mutation, resize, geometry, and DOM descriptions;
  its only writes are bounded diagnostic data on `window`
  (`e2e/tests/dashboard-next/outbound-mms.spec.ts:178`). It does not dispatch
  input or write a scroll owner.
- **Pointer leakage is not supported.** The red event occurred with the pointer
  inside the canvas, while later out-of-bounds pan endpoints hit no element.
  AppFrame never moved. This fits the Timeline delivery refetch and anchoring
  path at `dashboard/src/routes/contact/Timeline.tsx:2029`, not gesture delivery
  to the inert background.
- **No production viewer regression or remaining product defect is demonstrated.**
  The branch changes only the E2E spec and diagnostic records. The viewer still
  captures and restores connected scroll owners, restores focus with
  `preventScroll`, uses history-backed dismissal, and keeps the background inert
  (`dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:86` and
  `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:168`). The captured
  movement was a live message status settling behind an inert dialog, and the
  viewer restores its captured offsets on dismissal.

## Residual risk

- An unrelated live Timeline event can still occur after the terminal status.
  The strengthened exact assertions will expose it rather than hide it.
- `Delivered` deliberately makes cross-spec contamination of the fake's next
  delivery profile fail loudly. Generalizing to any terminal label would weaken
  this test's normal-delivery contract.
- The recorder's `buttons` value is last sampled on `pointermove`, so a phase
  recorded after `mouse.up` can still show `buttons=1`. Coordinates and the
  element-under-pointer result remain current because `elementFromPoint` is
  evaluated when each sample is recorded. Treat `buttons` as advisory unless
  pointer up/down sampling is added.

## Verdict

**FAIL.** The causal diagnosis, lifecycle wait, scoped selector, exact scroll
assertions, and no-product-change decision hold. Completion is blocked on making
the diagnostic attachment/stop path failure-safe and updating the canonical
issue to match the captured evidence. After those fixes, rerun only the affected
targeted checks selected for this small-fix lane.
