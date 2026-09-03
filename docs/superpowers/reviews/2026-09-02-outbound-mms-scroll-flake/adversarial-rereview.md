# Outbound MMS Scroll Flake Adversarial Re-review

Date: 2026-09-02
Branch: `fix/outbound-mms-scroll-flake`
Lane: authorized small-fix adversarial re-review

## Scope and evidence

This re-review inspected the current worktree after the review fix wave,
including `e2e/tests/dashboard-next/outbound-mms.spec.ts`, the canonical issue,
the resolved duplicate pointer, and the prior review findings. It did not run
Playwright or any E2E command and did not modify implementation, issue, or other
record files.

The implementation owner reports that the earlier exact traced focused E2E,
E2E workspace typecheck, and 33 targeted dashboard tests passed. This re-review
does not re-claim those checks as fresh reviewer runs.

## Finding closure

### P2 - Recorder evidence and cleanup are not failure-safe - closed

`attachViewerScrollDiagnostics` now returns without attaching when the page has
no installed recorder (`e2e/tests/dashboard-next/outbound-mms.spec.ts:397`). A
describe-level `afterEach` calls that helper with `stop=true` before the page
fixture is torn down (`e2e/tests/dashboard-next/outbound-mms.spec.ts:508`).

The resulting control flow is sound:

- An intermediate failure after recorder installation reaches `afterEach`,
  which copies the buffered canvas, pointer, mutation, resize, and owner samples,
  attaches them as `viewer-scroll-after-test.json`, and disconnects the
  listeners and observers.
- The normal success path still attaches `viewer-scroll-before-assertion.json`,
  then attaches `viewer-scroll-final.json` with `stop=true`
  (`e2e/tests/dashboard-next/outbound-mms.spec.ts:750`). That stop deletes the
  installed-recorder marker, so `afterEach` returns `null` and creates no third,
  empty attachment.
- Other tests in the describe never install this recorder. With `E2E_TRACE=1`,
  their `afterEach` calls therefore no-op; with the flag absent, the helper
  returns before page evaluation.

This closes both halves of P2: failure-path evidence is durable and recorder
cleanup no longer depends solely on fixture teardown.

### P3 - The canonical issue contradicts the captured red evidence - closed

`docs/issues/e2e-image-viewer-scroll-flake.md:1` is now resolved and records the
exact `512 -> 500` Timeline movement, unchanged maximum, success-tone mutation,
native Timeline scroll event, stable AppFrame, pointer/canvas evidence, delayed
delivery re-anchor root cause, terminal `Delivered` lifecycle wait, and focused
checks.

`docs/issues/outbound-mms-viewer-scroll-capture-flake.md:1` remains a resolved
pointer to the canonical record and now states that the canonical issue contains
the failing trace, root cause, fix, and verification. There is one canonical
history without breaking old references.

## New actionable findings

None.

## Attacked but held

- **The afterEach fallback cannot duplicate successful attachments.** The
  explicit final stop removes `__hcViewerScrollStop`; the helper checks that
  marker before copying or attaching anything.
- **The fallback does not add artifacts to unrelated tests.** It is trace-gated,
  and an enabled trace still requires an installed recorder marker.
- **The fallback preserves the decisive pre-assertion attachment.** The known
  while-open equality still attaches its snapshot before asserting, while the
  fallback covers failures at the earlier open, wheel, pan, and later Escape or
  restoration boundaries.
- **The recorder remains read-only with respect to product state.** Cleanup
  disconnects scroll, pointer, mutation, and resize listeners; it does not write
  an owner or dispatch input.
- **The lifecycle fix remains correctly scoped.** The test waits for exact
  `Delivered` text inside the exact token-bearing outbound bubble before
  arranging the two scroll owners. Equality remains exact after open, wheel,
  every pan, and dismissal.
- **Issue reconciliation is complete.** The canonical issue is resolved with
  current evidence, and the duplicate is only a resolved pointer.
- **No production viewer behavior changed.** The fix wave is confined to the
  E2E spec and durable records, so zoom, pan, focus restoration, Back/Escape,
  authenticated media, and viewer scroll restoration retain their existing
  implementation and coverage.

## Residual risk

- If the page crashes or navigates to a new document before `afterEach`, no
  page-local recorder can be recovered. Playwright's ordinary trace and failure
  artifacts remain the evidence path for that distinct failure class.
- The recorder's `buttons` field remains a last-pointer-move sample and can show
  `1` in a phase recorded after `mouse.up`. Coordinates and
  `elementFromPoint` are sampled at record time; this advisory field does not
  affect the causal finding or the scroll assertions.
- Final post-review commands remain owned by the primary agent. This re-review
  intentionally did not start a competing browser lane.

## Verdict

**PASS.** P2 and P3 are closed, and no new actionable finding remains. The
diagnostic lifecycle, exact scroll contract, durable failure evidence, issue
history, and product boundary are internally consistent. The primary agent may
rerun the affected targeted checks for final small-fix handback.
