---
id: e2e-documentelement-overflow-check-vacuous
title: Hand-rolled documentElement overflow checks are vacuous in this app shell - migrate the stragglers onto the shared helper
type: debt
severity: low
status: resolved
area: e2e
created: 2026-08-06
resolved: 2026-08-21
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:150, e2e/support/viewport.ts:72, e2e/tests/roster-quiet-hours.spec.ts:302
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).** Stragglers 1 and 2 are
migrated and the idiom is now GUARDED so it cannot return.

- **1** - `outbound-mms.spec.ts` now calls `expectNoHorizontalOverflow(page,
  'composer at 360px')`. Its narrow-viewport claim is real for the first time;
  the inline expression it replaced could not fail.
- **2** - `roster-quiet-hours.spec.ts` imports `NARROW_360` / `WIDE_RESTORE`
  instead of re-typing the byte-identical literals.
- **The guard** - `e2e/support/viewport.guard.test.ts` fails if
  `documentElement.scrollWidth` appears anywhere under `e2e/` outside
  `support/viewport.ts`. Verified by probe: appending the expression to a spec
  fails the guard naming that file; removing it goes green again.

The guard is the point. Migrating the last copy is a one-time event - the next
person writing a narrow-viewport spec would reach for the obvious expression and
get a green assertion that proves nothing. Making it enforceable rather than
remembered is the same move as `DYNAMO_DISABLE_TTL` and the smoke gate's
self-check.

**Point 3 deliberately NOT done.** Those are narrow-viewport blocks that assert
geometry and never claimed anything about overflow, so adding the helper would
ADD an assertion rather than fix a lie - and, as this issue itself says, "an
unnecessary assertion on a surface nobody promised is flake surface, not
coverage". Left to whoever owns those surfaces.

**Problem.** `document.documentElement.scrollWidth -
document.documentElement.clientWidth` can never be non-zero in the dashboard, so
any assertion built on it passes unconditionally. The shell clamps the document
to the viewport and hands the scrolling to an inner box:

- `dashboard/src/index.css:12-16` - `html, body, #root { height: 100% }`
- `dashboard/src/app/AppFrame.module.css:5-8` - `.shell { display: flex; height: 100% }`
- `:307-317` - `.main { flex: 1; min-width: 0; height: 100% }` (`min-width: 0` is
  what stops a wide child from widening the flex row instead)
- `:362-366` - `.content { flex: 1; overflow-y: auto }`, and per CSS Overflow L3 a
  `visible` other axis computes to `auto` once one axis is not `visible`/`clip`,
  so `.content` is an x-scroll container on BOTH axes
- `dashboard/src/app/AppFrame.tsx:166` - `<main class=.content><Outlet /></main>`
  wraps every routed page

Route content that runs too wide therefore scrolls INSIDE `<main>`, and the
document never moves.

The contact-rosters branch fixed the shared helper
(`e2e/support/viewport.ts` - `expectNoHorizontalOverflow` now measures the
document AND `<main>` and asserts on the worse of the two, and the new
`expectNoHorizontalOverflowIn(locator, where)` measures one element's own box for
`position: fixed` dialogs, which contribute to the scrollable overflow of neither
page-level box). The stragglers elsewhere in the suite were left alone as
out-of-scope.

Straggler inventory, whole suite, as of 2026-08-06:

1. `e2e/tests/dashboard-next/outbound-mms.spec.ts:149-153` - the only remaining
   hand-rolled copy. Its narrow-viewport claim ("the document itself does not
   scroll horizontally at 360px") is unproven. Low impact in practice: `:146-147`
   asserts the attach button's right edge is inside the viewport, which is a real
   clipping check.
2. `e2e/tests/roster-quiet-hours.spec.ts:302,330` - hard-codes
   `{width: 360, height: 800}` / `{width: 1280, height: 900}` instead of importing
   `NARROW_360` / `WIDE_RESTORE`, which are byte-identical. Same ONE-definition
   rule, and the block asserts no overflow at all today - the three-button confirm
   there is a natural `expectNoHorizontalOverflowIn(confirm, ...)` site.
3. Narrow-viewport blocks that assert geometry but never overflow, so adopting the
   helper would ADD coverage rather than fix a lie:
   `e2e/tests/dashboard-next/composer-mobile.spec.ts:67,94,126`,
   `e2e/tests/dashboard-next/placements-page.spec.ts:101,283,303`,
   `e2e/scenarios/steps.ts:2409`.

**Suggested fix.** Point 1 and 2 at `e2e/support/viewport.ts` (import
`NARROW_360` / `WIDE_RESTORE` / the two helpers; delete the inline expressions).
Then decide per block in 3 whether an overflow claim is worth making - the helper
is cheap, but an unnecessary assertion on a surface nobody promised is flake
surface, not coverage. Note the pre-existing element-scoped checks in
`e2e/tests/flows/voice-extraction.spec.ts:229-236` are already correct (they
measure the chip's own box) and need no migration beyond optional de-duplication
onto `expectNoHorizontalOverflowIn`.

Once every copy is migrated, grep-guarding the idiom (`documentElement.scrollWidth`
must not appear under `e2e/`) would keep it from coming back.
