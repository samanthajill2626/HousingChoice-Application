---
id: contact-search-popover-below-viewport
title: Contact search options can be placed entirely below the viewport and cannot be clicked
type: bug
severity: med
status: open
area: dashboard/contacts
created: 2026-10-08
refs: dashboard/src/routes/contact/ContactSearchField.tsx:128, dashboard/src/routes/contact/ContactSearchField.module.css:64, e2e/tests/dashboard-next/matching-entry-points.spec.ts:228, docs/superpowers/reviews/2026-10-07-caseworkers/S10-recipient-picker-baseline.md
---

**Problem.** ContactSearchField puts its document.body fixed listbox below
the input, with a 9rem minimum max-height, without checking whether any
viewport space remains. In Matching's Review recipients page, a populated
candidate list pushes Add a tenant to the bottom of a 1280x720 viewport.
The matching option exists and is enabled, but its listbox starts at
722.797px and cannot receive a pointer click. The route scroll container
cannot move the fixed portal into view. This is a product reachability
failure, not slow data or a missing search result.

**Reproduction and attribution.** On 2026-10-08, the property-page hand-picked
recipient browser test failed at its option click after the same six preceding
share/activity tests, on both feat/caseworkers and detached merge base
1861e154. Both runs: 6 pass / 1 fail, same 60s click timeout, identical
1280x720 viewport and listbox top 722.797px / left 264px / width 992px.
The baseline retained its old nav and tenant-worded tests. The isolated case
passes with fewer preview rows, which does not excuse the populated case.
Exact commands, preserved traces and checkout verification are in the
[baseline finding](../superpowers/reviews/2026-10-07-caseworkers/S10-recipient-picker-baseline.md).
No production or test source was changed during diagnosis.

**Suggested fix.** Position the contact search list above its input when
there is insufficient room below, and constrain the resulting box to the
available viewport space. Preserve keyboard selection, portal behavior and
the existing moved-anchor scroll dismissal rule. Prove the populated Matching
case with ordinary pointer clicks and add focused below/above placement tests.
Do not use force clicks or a larger test viewport as a substitute.

This is separate from the resolved
[late-scroll dismissal](./contact-create-link-relationship-e2e-fails-on-rerun.md)
(the list disappeared) and
[property-first overlay](./matching-entry-points-property-first-e2e-flake.md)
(UnitSearchField intercepted another control's click). No source fix has been
approved or implemented in this issue record.
