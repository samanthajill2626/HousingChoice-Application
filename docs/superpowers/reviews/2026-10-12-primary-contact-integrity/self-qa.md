# Live self-QA - primary contact integrity

Date: 2026-10-13. Driven by the build orchestrator (Fable 5.1) on the hermetic
`npm run e2e:session` lane 13 of W:\tmp\primary-contact-integrity (app
:10301 at e6fec584, dashboard :10311 with fix-wave-2 and the one CSS fix
below hot-reloaded), through the project Playwright MCP (bundled Chromium,
isolated profile, 929 x 917 viewport). Never the human's :5174 / :8080.
Screenshots (gitignored): `.playwright-mcp/selfqa/selfqa-01..10-*.png` in the
worktree (copies of the MCP output under the main checkout's
`.playwright-mcp/`).

World built through the REAL routes from the page context (the Vite proxy
injects the origin secret): three contacts via `POST /api/contacts` (Mark
Passmore394482 and Dana Owner394482 typed landlord, Tamika Brooks394482
typed tenant with voucherSize 2), then the dev seam
`POST /__dev/fixtures/zero-primary-property` twice - unit 1 with a
deliberately long street ("394482 Boltonshire-Upon-Thames Boulevard
Northwest Extension Unit 470B") and Mark as a non-primary PM; unit 2
("394482 Second Bolton Street SW") with Mark as a non-primary PM. All four
creates answered 201.

## Boundary proofs (network layer, not the UI)

- GET `/api/units/<unit1>` on the seeded shape: no `landlordId`, no
  `primary_contact`, the one row `{ role: 'pm', primaryContact: false, name }`
  with NO `deleted` flag, `propertyContact: { contactId: null, reason: 'none',
  heirIfPrimaryRemoved: null }` (null because no row is flagged - the accepted
  D-2 reading).
- POST `/api/units/<unit1>/contacts` adding Dana as a NON-primary owner past a
  live primary: 200, rows `[Mark pm true, Dana owner false]` (P2 promoted
  nobody), and the write's own answer carried `propertyContact: { contactId:
  <Mark>, heirIfPrimaryRemoved: { contactId: <Dana>, name: 'Dana
  Owner394482' } }`.
- GET `/api/tours/<tour>/roster/preview-open` on unit 2 before the fix: the
  general intro body and `introFallback: { reasons: ['no_property_contact'],
  unitId: <unit2>, street: '394482 Second Bolton Street SW' }` - one reason,
  no tour reason (the tour is booked +48h).
- After the explicit Make primary on unit 1: `primary_contact = <Mark>`, row
  `primaryContact: true`, block `{ contactId: <Mark>, heirIfPrimaryRemoved:
  null }`, and the Activity events held ONE new event, `unit_contact_added`
  (no `unit_primary_contact_assigned` - contract 2.4).
- After removing Mark (primary) from unit 1: `primary_contact = <Dana>`, Dana
  flagged, block `{ contactId: <Dana> }`, events in order
  `unit_primary_contact_assigned { reason: 'handoff_on_remove', contactId:
  <Dana>, from: <Mark>, contactName }`, `unit_contact_removed`, the two
  `unit_contact_added`.
- After deleting Mark (contact page): the app logged the hand-off summary
  `targets: 1, moved: [], unchanged: [<unit2>], notPrimary: [], unknown: [],
  failed: [], scanFailed: false`; GET `/api/units/<unit2>` shows the row
  `{ primaryContact: true, deleted: true }` with the scalar still Mark (spec
  4.6: no heir -> nothing changes) and `propertyContact: { contactId: null,
  reason: 'deleted', heirIfPrimaryRemoved: null }`; no audit event was
  appended (nothing moved).

## Walk (a) - the property box (spec 7.4)

`/listings/<unit1>`: the Contacts card renders a `role="status"` box
(border `rgb(176, 106, 0)` = `--c-warning`) reading "No primary contact. New
tours won't include the landlord, and tour group texts use the general
intro." with the single button "Make Mark Passmore394482 primary" (one
eligible row; no "Choose a primary"). The h1 carried the long street without
page overflow (`documentElement` scrollWidth = clientWidth).

MEASURED DEFECT, FIXED ON-BRANCH (acaea45a): the shared `Button` is
`white-space: nowrap`, so the label measured 246 px inside the box's 226 px
content width - `box.scrollWidth 254 > clientWidth 226`, the button's right
edge at x=904 past the box (877) and past the card (890). Screenshot
`selfqa-01-property-box.png` shows it poking out. Fix: `.noPrimaryBox p >
button { max-width: 100%; white-space: normal; overflow-wrap: anywhere;
text-align: left; line-height: 1.3 }` (the OrgPicker "Use <name>" precedent).
Re-measured after HMR: `white-space: normal`, button right edge 868 < 877,
box scrollWidth 226 = clientWidth 226, the label wraps to two lines
(`selfqa-02-property-box-wrapped.png`).

Click: the box disappears, the row reads "Mark Passmore394482 (primary)
Property manager".

## Walk (b) - the open-group dialog (spec 7.1, 7.2)

`/tours/<tour>` on unit 2 (tenant Tamika; Mark added to the people list by
hand, as the e2e walk does): the reminders already read without a landlord
name. Relay group tab -> "Open relay group" -> dialog "Open the relay
group?" with a `role="status"` box above "Message preview":
"Using the general intro, not the tour intro." then "394482 Second Bolton
Street SW has no primary contact, so the intro can't name the landlord." with
the link "Set a primary contact" -> `/listings/<unit2>`, `target="_blank"`,
`rel="noreferrer"`; then the "Check again" button. No overflow (444 = 444;
dialog 478 = 478). `selfqa-03-dialog-fallback-box.png`.

Edited-draft rule: I appended " QA EDIT KEPT." to the draft, fixed the
property through the real add route (Mark primary on unit 2), pressed Check
again: the preview re-fetched (a second `preview-open` 200), the box went
away, the draft KEPT my edit (234 / 480), and "The intro changed." with "Use
the updated intro" appeared under the message (`selfqa-04-dialog-after-
check-again.png`). "Use the updated intro" replaced the draft with the TOUR
intro: "Hey Tamika! It's Sam. Putting you in a group text with Mark to tour
394482 Second Bolton Street SW on Thu, Oct 15 at 6:46 PM. ..." - the note
gone, zero status nodes. Cancelled: no group opened, nothing texted.

## Walk (c) - the remove hand-off notice (spec 4.6, 7.3)

`/listings/<unit1>` (Mark primary, Dana owner, no landlord): Edit contacts ->
the edit rows show "Remove Mark Passmore394482 from this property" and, on
Dana's row, "Make Dana Owner394482 the primary contact" (the edit-row name,
distinct from the box button). Remove Mark -> dialog "Remove the primary
contact?" with exactly "Dana Owner394482 becomes the primary contact - new
tours and relay groups for this property will use them." (the heir from the
server block), no overflow (`selfqa-05-remove-notice.png`). Confirm -> Dana's
row reads "(primary)" (`selfqa-06-after-remove-handoff.png`).

Activity: the card did not refetch after the roster write (it shows the
load-time rows) - the same as `main`, where `useListing.ts` loads the
activity slice once in its initial `Promise.all` and no roster write refetches
it; a reload rendered the S4.11 line "Primary contact set automatically -
Dana Owner394482 - the previous primary contact was removed" linking to Dana,
above "Contact removed - Mark Passmore394482"
(`selfqa-07-activity-after-reload.png`). Pre-existing refresh behavior, noted
for the handback, not changed.

## The Delete dialog (spec 7.6) and the delete fan-out (spec 4.6)

`/contacts/<Mark>` -> More actions -> "Delete contact": the dialog carries
the non-tenant sentence "If they're a property's primary contact, the
landlord or another contact on that property takes over, and restoring them
won't change that back." (`selfqa-08-delete-dialog-sentence.png`). Confirm:
redirected to `/contacts`; the fan-out summary above.

`/listings/<unit2>` afterwards: the box lead is "This property's contact was
deleted." + the effect sentence, NO button, the line "Add the landlord or
property manager - they become the primary automatically." (no eligible row
left); the row reads "Mark Passmore394482 (deleted) (primary) Property
manager" (`selfqa-09-deleted-lead.png`). Edit mode: the row keeps its role
select ("Role for Mark Passmore394482", value pm, enabled) and "Remove Mark
Passmore394482 from this property", with ZERO Make-primary buttons
(`selfqa-10-deleted-row-edit-mode.png`).

## Not walked (covered elsewhere)

- The 409 `primary_contact_deleted` and 503 `roster_read_failed` copy: not
  reachable through the UI on a healthy lane; pinned by dashboard tests
  (ListingDetail.test.tsx, RestoreLandlordDialog.test.tsx) and the API tests
  of S2a.
- The restore paths (clear / swap heir): API + repo tests (S2b) and
  `unitsRestoreLandlord.test.ts`; the property-roster e2e spec covers the
  lean-seed restore flows.
- The backfill script: unit, CLI and one real-wiring DynamoDB-Local test
  (S5a); its first real run is the owed post-merge operation.

## Observations for the handback (not defects)

- The Contacts card's Activity list refreshes on reload only (as on `main`).
- Mark's contact page "Properties" card said "No properties yet." while he was
  unit 2's primary PM: that card lists properties where the contact is the
  landlord of RECORD (spec 9.2, unchanged on purpose).
- The seeded lean world logs two pre-existing ERROR lines at boot
  (relayAnnouncement aggregation "missing"; the seeded relay group "stuck
  connecting") on files this branch does not touch (S5b W4).
