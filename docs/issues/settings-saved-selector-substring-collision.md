---
id: settings-saved-selector-substring-collision
title: Settings E2E Saved locator collides with explanatory copy
type: bug
severity: med
status: resolved
area: e2e/settings
created: 2026-08-21
resolved: 2026-08-23
refs: e2e/tests/dashboard-next/settings.spec.ts:70, e2e/tests/dashboard-next/settings.spec.ts:81, e2e/tests/dashboard-next/settings.spec.ts:161, dashboard/src/routes/settings/TemplatesSection.tsx:215
---

**Resolution (2026-08-23, `fix/test-suite-wave3`).** Took the suggested fix at
all three call sites: `page.getByRole('status').filter({ hasText: /^Saved$/ })`.
Added the non-vacuity pin the substring version could never pass: BEFORE the
first save, the spec now asserts that the colliding prose ("saved" in the
Templates hint) IS on screen while the new locator matches NOTHING - so the
badge assertion cannot be satisfied by anything except a real save, and a
future locator that matches the hint fails the precondition immediately.
Verified: 3 passed (25.8s), isolated run.


**Problem.** The Settings admin E2E uses the substring locator
`getByText('Saved')` after three template saves. The Templates hint now contains the
lowercase word `saved`, while a successful save adds the exact `role="status"`
element `Saved`. Depending on render timing, the assertion can either pass against
the unrelated hint before the status appears or fail strict mode after both elements
exist. A bare full E2E run on feature head `709a5263` hit the two-match strict-mode
failure at line 70; the run finished with 250 passing and three failing tests in
27.1 minutes.

The spec and Settings UI/backend chain are byte-identical between base `165a267b`
and feature head `709a5263`. The colliding hint was introduced on main before that
base. An immediate isolated rerun exited successfully, but because the substring
hint itself satisfies the assertion, that pass does not prove the save-status check
worked.

**Suggested fix.** Change all three assertions to an exact role-and-text locator,
such as `page.getByRole('status').filter({ hasText: /^Saved$/ })`, then rerun the
admin Settings case and the full E2E suite. This is the same selector-hardening
pattern used for other Playwright substring collisions.
