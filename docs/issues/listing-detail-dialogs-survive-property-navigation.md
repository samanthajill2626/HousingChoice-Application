---
id: listing-detail-dialogs-survive-property-navigation
title: The property page's "Delete property?" confirm survives a move to another property and would delete that one
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-12
refs: dashboard/src/routes/listing/ListingDetail.tsx:214, dashboard/src/routes/listing/ListingDetail.tsx:225, dashboard/src/App.tsx:271, dashboard/src/routes/listing/ListingDetail.tsx:407, dashboard/src/routes/listing/ListingDetail.tsx:1425
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

**Update 2026-10-12 (fix wave 2 FW2-5; R2 code review, dashboard finding
A1).** The PERMANENT SPINNER is fixed at the root - only that: a property write
that answers after the move (the banner Restore, a status change, a roster
write, a photo write, the edit form, or the restore dialog's two writes) used
to call the `setUnit` held for the old property, which stamped the old id over
the new page's state and left it on a permanent spinner. `useListing.setUnit` is now
bound to its own unitId and is a no-op once the hook has moved on
(`dashboard/src/routes/listing/useListing.ts:168`, the `useContact.setContact`
precedent), pinned by the two cases in
`dashboard/src/routes/listing/useListing.test.tsx:303`. Corrected by the R3
code review (dashboard finding A2): this note first said the whole in-flight
half was fixed at the root. It is not - the guard covers the page's `unit`
only, and a late answer still lands on the next property through the rest of
its per-property state: the Contacts card's roster and the restore dialog (the
R3 update below), failure messages (the status pill, Photos, a roster row
whose contact is seated on both properties), busy flags that keep the next
property's controls disabled until the old request settles, a late delete
success that navigates to the Properties list, and late successes that close
the next property's open confirms and forms (each with its location in
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/code-review/R3-dashboard.md`,
finding A2). None leaves a stuck page. Also still open is the half this issue
is titled for: the pre-existing "Delete property?" confirm (and the other
un-reset per-property state above) surviving the move while open.

**Update 2026-10-12 (R3 code review, dashboard finding A1; filed by fix wave
3 FW3-3).** A late answer from the restore dialog still overwrites the NEXT
property's local roster state. The dialog's two callbacks are bound to no
property: `onRestored`
(`dashboard/src/routes/listing/ListingDetail.tsx:1425-1428`) runs
`setRestoreNeeds(null)` and `applyRosterUnit(updated)`, and `onConflict`
(`:1429-1443`) runs `applyRosterUnit(fresh)` and `setRestoreNeeds(null)`.
`applyRosterUnit` (`:407-410`) is guarded only in its `setUnit` half (FW2-5);
its `setRosterUnit(updated)` (`:408`) is not. Scenario (reproduced by the
reviewer's throwaway probe, cases X1 and X2): on deleted property A staff
press "Restore without a landlord" and the request stalls; they press browser
Back to live property B, make a different contact the primary there, and B's
answer shows it "(primary)". Then A's answer lands: `setRosterUnit` replaces
B's own answer with A's unit, the card's unitId guard (`:306`) drops it, and
the card falls back to B's LOAD-TIME roster (`setUnit` never re-derives it,
`useListing.ts:168`). Three consequences:

1. B's card shows the OLD "(primary)" again (and a Make primary button on the
   real one) while the server says otherwise.
2. The next re-role on that stale card posts the row's stale flag
   (`onSetContactRole`, `:471-478`, sends `primaryContact:
   row.primaryContact`): re-roling the old primary posts `true` and the server
   makes it primary again, demoting the real one; re-roling the real primary
   posts `false` and leaves B with no row marked primary (routing falls back to
   the landlord of record).
3. When B is itself deleted and its own restore dialog is open, A's late
   `onRestored` (or a late `onConflict` re-read of a live A) runs
   `setRestoreNeeds(null)` and closes B's dialog although B was not restored -
   a pick there is lost, and if B's own write was in flight its refusal
   message is dropped with the unmounted dialog.

LOW: only the dialog's two paths can do it (a roster write on A cannot -
`rosterBusy` carries across the move and blocks B's roster writes until A's
settles, `:430`); it needs A's restore to stay in flight across Back, B's
whole load and a completed roster write on B; the wrong write is visible
afterwards and audited (`unit_contact_added`), and nothing is lost. Not a fix
wave 2 regression: the unguarded calls are the branch's original build.

**Suggested fix (R3).** Bind the dialog's callbacks and the roster state to
the property they were created for - in both callbacks
`setRestoreNeeds((prev) => (prev?.unitId === unit.unitId ? null : prev))`,
and drop an `applyRosterUnit` answer whose `unitId` is not the route's current
one (or hold `rosterUnit` per unitId) - or key the `/listings/:unitId` route
element by unit id (`dashboard/src/App.tsx:271`), which retires this and every
leftover listed above at once. Regression tests: the probe's two cases
inverted (B's card keeps the real "(primary)" and a re-role of the OLD
primary posts `primaryContact: false`; B's dialog stays open after A's late
answer).
