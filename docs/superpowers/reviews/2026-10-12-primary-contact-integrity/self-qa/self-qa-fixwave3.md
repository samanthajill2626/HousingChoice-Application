# Live self-QA - fix wave 3 (the property box's one-click rule)

Date: 2026-10-13 (local; 2026-10-14 UTC). Driven by the build orchestrator
(Fable 5.1) on the hermetic `npm run e2e:session` lane 13 of
`W:\tmp\primary-contact-integrity` at code tip `d3f5089d` (app :10301,
dashboard :10311), through the project Playwright MCP (bundled Chromium,
isolated profile, 929 x 917 viewport). Never the human's :5174 / :8080.
Screenshots: `fixwave3-01..05-*.png` in this directory (copies of the MCP
output under the main checkout's `.playwright-mcp/fixwave3-selfqa/`). The
session was stopped afterwards (`npm run e2e:stop` exit 0: lane 13 tables
dropped, lease released, no listener left on the lane's ports).

World built through the REAL routes from the page context (the Vite proxy
injects the origin secret): three contacts via `POST /api/contacts` -
Tia234791 QaTenant (typed tenant, voucherSize 2), Mark234791 QaManager and
Dana234791 QaOwner (typed landlord) - then the dev seam
`POST /__dev/fixtures/zero-primary-property` three times (every create 201):

- unit T "234791 Tenant Only Terrace NW": rows `[Tia other]`;
- unit L "234791 Sole Manager Lane SW": rows `[Mark pm]`;
- unit M "234791 Mixed Roster Road SE": rows `[Tia other, Mark pm, Dana owner]`.

## Boundary proof (the wire, keys asserted PRESENT, never defaulted)

GET `/api/units/<id>` on all three before any click: no `landlordId`, no
`primary_contact`, `propertyContact: { contactId: null, reason: 'none',
heirIfPrimaryRemoved: null }`; no row carries `deleted` or `caseworker`.
The new flag (F1, spec 7.5): Tia's row has NO `autoEligible` key on T and
on M; Mark's and Dana's rows carry `autoEligible: true` on L and on M. The
type decides, not the role (Tia's role is `other`, Dana's `owner`).

## Walk 1 - tenant-only zero-primary property (unit T) - the findings' case

`/listings/<T>`: the Contacts card's `role="status"` box (border
`rgb(176, 106, 0)`) reads, in order: "No primary contact. New tours won't
include the landlord, and tour group texts use the general intro." then the
NEW line "Add a property manager or owner - they become the primary
automatically." then the one button "Choose a primary". Counts: one-click
`Make <Name> primary` buttons 0; `Choose a primary` 1; the old line ("Add
the landlord or property manager") 0. Measured: box `scrollWidth 226 =
clientWidth 226`, button right edge 788 < box right 877, document
`scrollWidth 929 = clientWidth 929` - nothing overflows
(`fixwave3-01-tenant-only-box.png`).

"Choose a primary" -> the card's edit mode ("Done editing contacts"
visible): Tia's row offers the type-agnostic hand pick - the button whose
accessible name is "Make Tia234791 QaTenant the primary contact" (visible
text "Make primary") - plus "Remove" and the role select (value Contact);
nothing was clicked further, nothing written
(`fixwave3-02-tenant-only-choose-edit-mode.png`). Observation, not a defect
of this wave: in edit mode the box stays visible with its "Choose a
primary" button, which merely re-enters the mode the card is already in -
the same as the pre-existing two-or-more case; cosmetic, noted for the
handback.

## Walk 2 - landlord-typed sole contact (unit L) - the findings' case

`/listings/<L>`: the box reads the lead and the effect sentence, then the
single button "Make Mark234791 QaManager primary"; `Choose a primary` 0; the
no-eligible line 0. Measured: box `232 = 232`, button right 883 < box right
892, button `white-space: normal` (the label wraps to two lines - the
acaea45a fix from the first self-QA holds), document `929 = 929`
(`fixwave3-03-landlord-typed-sole-one-click.png`).

Click -> the status box is detached from the DOM and the row reads
"Mark234791 QaManager (primary) / Property manager"
(`fixwave3-04-landlord-typed-after-one-click.png`). The wire afterwards:
`primary_contact = <Mark>`, the row `{ primaryContact: true, autoEligible:
true }`, `propertyContact: { contactId: <Mark>, heirIfPrimaryRemoved: null }`;
the Activity events hold ONE `unit_contact_added` and no
`unit_primary_contact_assigned` (an explicit click writes no "set
automatically" event - contract 2.4, as in the first self-QA).

## Walk 3 - mixed roster, two landlord-typed rows (unit M) - extra

`/listings/<M>`: the box reads the lead and the effect sentence, then
"Choose a primary" only - no one-click (the tenant never counts; two
`autoEligible` rows), no no-eligible line. Box `226 = 226`, document
`929 = 929` (`fixwave3-05-mixed-roster-choose-no-line.png`).

## Console

Zero errors or warnings after login. Before login, two `401` on `/auth/me`
- the isolated MCP profile starts logged out, as every session does.

## Not walked (covered elsewhere)

- Caseworker-only and all-deleted rosters (the line alone, no button):
  pinned by the dashboard unit tests (implementer A's report, ListingDetail
  tests "caseworkers only" and "every row deleted").
- F2, the delete hand-off of a no-flag landlord of record: no UI change;
  pinned against DynamoDB Local (`unitsRepoHandOffPrimary.integration.test.ts`,
  the parity table) and on the FakeWorld (route and service); the live walk
  was accepted out of scope (V9).
- F5a, the consistent restore reads: no UI surface; pinned at the BatchGet
  input and the restore route (`contactsRepoConsistentBatchRead.test.ts`,
  `unitsRestoreLandlord.test.ts`).
- F5b, the Delete-dialog sentence: pinned by `ContactDetail.test.tsx`; the
  dialog itself was walked in the first self-QA (screenshot 08 there).
