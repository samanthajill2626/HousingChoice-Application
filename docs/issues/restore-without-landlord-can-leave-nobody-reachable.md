---
id: restore-without-landlord-can-leave-nobody-reachable
title: Restore without a landlord can bring a property back with nobody reachable, and nothing says so
type: decision
severity: low
status: open
area: app
created: 2026-10-12
refs: app/src/routes/units.ts:445, app/src/repos/unitsRepo.ts:1292, app/test/helpers/twilioWebhookHarness.ts:3145, app/src/lib/rosterResolution.ts:294, dashboard/src/routes/listing/RestoreLandlordDialog.tsx:122
---

**Problem.** After "Restore without a landlord" (`POST /api/units/:id/restore`
with `{ landlordId: null }`, added by `fix/caseworker-integrity`) a property
can come back live with no contact-list row marked primary and no landlord of
record. Every property-contact resolver takes the row marked primary, else the
landlord of record (`app/src/lib/rosterResolution.ts:292-294`,
`app/src/lib/tourContacts.ts:124-129`,
`app/src/services/rosterProvision.ts:232-234`, `:524-525`), so with neither
they find no one: new relay groups and tour copy for the property lose the
property party - in the words of the page's own ruled copy for the same
state, calls and new relay groups for it reach no one. Nothing tells staff.
The branch's R3 code review found two shapes.

1. **The cleared landlord was the routing fallback, but no row was flagged
   (R3 backend finding A2, challenge C-1).** Cameron's Q5 ruling (the
   sole-landlord promotion, spec revision 5 section 4 "Restore") fires only
   when "the cleared landlord was the property's primary contact",
   implemented as its row flagged or the `primary_contact` scalar naming it:
   the route's gate (`app/src/routes/units.ts:445-447`), the repo's
   `oldWasPrimary` (`app/src/repos/unitsRepo.ts:1292-1293`) and its FakeWorld
   mirror (`app/test/helpers/twilioWebhookHarness.ts:3145-3146`). That is the
   spec's own definition of "no primary contact" (section 4 "Contact list":
   no contact-list row marked primary). But on a list with NO row flagged,
   the landlord of record IS the property's contact everywhere (the fallback
   above; the SA-1 test says this shape is reachable only through it,
   `app/test/unitsRepoAutoPrimary.integration.test.ts:163-165`), yet clearing
   them never counts as clearing the primary - so even the ONE remaining
   contact typed landlord is not promoted. The shape is legacy or rare: a
   landlord claim written before the auto-primary rule took the request's
   flag (false from the dashboard), and a restore WITH a landlord on such a
   list seats the new landlord unflagged (`app/src/repos/unitsRepo.ts:1303-1309`;
   re-flagged only when the old one was primary, `:1317`). Example: a deleted
   property, landlord of record L (since re-typed tenant), list
   `[L (role landlord, not flagged), PM (typed landlord)]`, no scalar. Before
   the restore every resolver routes the property to L; after "Restore
   without a landlord" it is live and ownerless with PM unflagged, and every
   resolver finds no one - although exactly one landlord-typed contact
   remains. Reproduced by the reviewer through the real route and the real
   `resolveRoster` on the FakeWorld (probe F2) and through the real router
   and repo on DynamoDB Local (probe R2). Not a regression: before the ruling
   nobody was ever promoted.
2. **Zero or two-plus landlord-typed contacts remain (R3 dashboard challenge
   C2).** By Cameron's Q5 ruling nobody is promoted then
   (`docs/superpowers/reviews/2026-10-12-caseworker-integrity/code-review/R2-adjudications.md:79-91`),
   so a property whose landlord was its primary contact comes back with no
   row marked primary and no landlord of record. The outcome is ruled; what
   is missing is any word of it. The dialog's only sentence is the spec's
   (`dashboard/src/routes/listing/RestoreLandlordDialog.tsx:122`) and the page
   shows no notice - the only signal is the absence of "(primary)" on the
   Contacts card. The Remove-contact confirm already says it for a removal
   that leaves the same state (`dashboard/src/routes/listing/ListingDetail.tsx:542`:
   "...calls and new relay groups for it will reach no one until someone on
   its contact list is made the primary contact or a new contact is added.");
   the restore path has no such sentence.

**Suggested fix.** Both need Cameron.

- Shape 1 needs a ruling: does "no row flagged" count as "the cleared
  landlord was the primary"? If yes, the reviewer's one-disjunct fix, scoped
  to `next === null` (for a swap it would change nothing that routes - the
  fallback already reaches the new landlord): `|| !rows.some((row) =>
  row.primaryContact === true)` in the route's gate
  (`app/src/routes/units.ts:445-446`), the matching disjunct in the repo's
  `oldWasPrimary` (`app/src/repos/unitsRepo.ts:1292-1293`) and in the
  FakeWorld (`app/test/helpers/twilioWebhookHarness.ts:3145-3146`), with the
  reviewer's probes F2 (FakeWorld route) and R2 (the route on DynamoDB Local)
  as the regression tests. If no, record the exception in the spec (section
  4 "Restore").
- Shape 2 is copy: when the restore's answer has no row marked primary and
  no landlord of record, say so - in the dialog before the click, or as a
  page notice after it - in the Remove confirm's words. New copy, so
  Cameron's; it needs a dashboard test that fails today.

Records: `docs/superpowers/reviews/2026-10-12-caseworker-integrity/code-review/R3-backend.md`
(finding A2, challenge C-1), `R3-dashboard.md` (challenge C2) and
`R3-adjudications.md` (rows R3B-A2 / C-1 and R3D-C2) in the same folder.
