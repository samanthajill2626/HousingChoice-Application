---
id: listing-detail-dialogs-survive-property-navigation
title: The property page's "Delete property?" confirm survives a move to another property and would delete that one
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-12
refs: dashboard/src/routes/listing/ListingDetail.tsx:214, dashboard/src/routes/listing/ListingDetail.tsx:225, dashboard/src/App.tsx:271
---

**Problem.** The `/listings/:unitId` route element is not keyed
(`dashboard/src/App.tsx:271`), so a history move from property A to property
B (browser Back or Forward while a dialog is open) re-renders the SAME
`ListingDetail` instance, and its per-property UI state survives the move. The
"Delete property?" confirm is a plain boolean (`confirmingDelete`,
`dashboard/src/routes/listing/ListingDetail.tsx:214`) with no reset: opened on
A, it is open again once B has loaded, and its Delete calls
`deleteUnit(unit.unitId)` - B's id - so confirming it deletes B (a soft
delete; B can be restored from the Deleted view). This predates
`fix/caseworker-integrity`. Its R1 code review (dashboard finding 8) found the
same shape in the branch's new restore dialog, and the fix wave fixed that one
only (item FW-11: `restoreNeeds` records the unit it opened for and is reset
during render when the route's unitId differs, `ListingDetail.tsx:225`),
leaving this confirm alone on purpose. Other per-property state in the
component has no reset either (for example `removingEntry`,
`removingContact`, `editing`).

**Suggested fix.** Reset the per-property dialog state when the unitId
changes (the restore dialog's pattern), or key the route element by unitId so
a move to another property mounts a fresh page (that also resets the other
per-property state - check what the roster and photo state expect).
Regression test in the style of FW-11's
(`dashboard/src/routes/listing/ListingDetail.test.tsx`, "the landlord dialog
is reset by a history move to another property ..."): open "Delete
property?" on u1, move to u2, expect no dialog and `deleteUnit` never called
for u2.
