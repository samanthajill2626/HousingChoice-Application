---
id: undated-tour-wording
title: Undated tours read "Not booked" on the tour page and contact/property tour lists but "Undated" on the Past and All rows
type: improvement
severity: low
status: resolved
resolved: 2026-10-06
area: dashboard/tours
created: 2026-10-06
refs: dashboard/src/routes/tours/TourDetail.tsx:312, dashboard/src/routes/tours/TourDetail.tsx:783, dashboard/src/routes/contact/TenantFile.tsx:334, dashboard/src/routes/contact/LandlordFile.tsx:214, dashboard/src/routes/listing/ListingDetail.tsx:1082, dashboard/src/routes/tours/ToursPage.tsx:206
---

**Problem.** A tour with no date that is NOT a request - toured with the date
left blank ("already toured"), canceled before booking, or closed from one of
those - reads two different ways:

- "Undated" on the Tours page's Past tab (`ToursPage.tsx:206`, Cameron's copy
  ruling of 2026-09-27) and, from the tour-list (All tab) branch, on the All
  tab's rows;
- "Not booked" on its own tour page (`TourDetail.tsx:312`, and the Schedule
  card's When row, `:783`), and in the tenant file, landlord file and property
  page tour lists (`TenantFile.tsx:334-337`, `LandlordFile.tsx:214-217`,
  `ListingDetail.tsx:1082-1084`), which say "Not booked" for EVERY undated tour.

"Not booked" is accurate for a request; for a tour that happened (or ended)
without a date, "Undated" is the more precise word. The tour-list design review
(`docs/superpowers/reviews/2026-10-06-tour-list/design-review/`, rounds 2-3)
kept these four surfaces unchanged to keep that branch to the All tab, and
recorded both words in the GLOSSARY.

**Suggested fix.** On the four surfaces, keep "Not booked" for `requested` and
print "Undated" for any other tour without `scheduledAt` (one-line changes; the
existing tests cover requested tours only - `files.test.tsx:266-278, 458-470`,
`ListingDetail.test.tsx:432-433`), add a test per surface for an undated
toured tour, and update the GLOSSARY entry.

**Resolution (2026-10-06, feat/tour-list).** Fixed with the Tours page All tab
(spec `docs/superpowers/specs/2026-10-06-tour-list-design.md`, D8 and P7),
with DIFFERENT words from the Suggested fix above: Cameron ruled at the spec
gate that the actionable state gets one actionable name, so the shipped words
are "Needs booking" for a `requested` tour and "Undated" for any other tour
without a date. The old request label is gone from every surface - the
Problem and Suggested fix above are the record, not the design.

- One helper decides the words: `undatedTourLabel(tour)`
  (`dashboard/src/api/types.ts:920`, right after `tourStatusLabel`). Commit
  `68b94b20`.
- Eight readers call it, never their own string - the spec's six plus two:
  the All tab's date column (`dashboard/src/routes/tours/AllToursView.tsx:214`),
  the Past rows (`ToursPage.tsx:226`), the tour page's facts line and its
  Schedule card's When row (`TourDetail.tsx:326`, reused at `:797`), the
  tenant file (`TenantFile.tsx:338`), the landlord file
  (`LandlordFile.tsx:218`) and the property page (`ListingDetail.tsx:1085`);
  plus Today's past-tours row
  (`Today.tsx:216`, a literal "Undated" before - its output is unchanged) and
  the Closed tab's date column (`ToursPage.tsx:155`, which showed an EMPTY
  date for an undated closed or canceled tour and now reads "Undated").
  Line numbers are feat/tour-list's.
- The status badge still reads "Requested" (`TOUR_STATUS_LABELS`); the Active
  tab's section and the All tab's status chip say "Needs booking" too, so a
  request carries one status word and one work word (spec P12).
- A reader the spec missed, found in the build (ruling D-1, commit
  `e9e6229a`): `sortToursForPanel` (`dashboard/src/routes/listing/useListing.ts:85-100`)
  sorted EVERY undated tour first, as if it were a request. Only a request
  leads now; dated tours follow newest first, then any other undated tour.
- Tests: new or moved cases in `types.test.ts`, `TourDetail.test.tsx`,
  `files.test.tsx`, `ListingDetail.test.tsx`, `ToursPage.test.tsx` and
  `useListing.test.tsx` (a request reads "Needs booking"; an undated toured
  or canceled tour reads "Undated"), pins for Past and Today, and the e2e
  text moved to "Needs booking" (`e2e/tests/dashboard-next/tours-page.spec.ts`,
  `e2e/scenarios/steps.ts`, `e2e/tests/scenarios/tours.spec.ts`).
- Docs: the GLOSSARY entry for a requested tour, "Needs booking" and
  "Undated" (`documentation/GLOSSARY.md`, "Feature & label notes") and
  `documentation/sequence-diagram-to-test.md:262-263`. A case-insensitive
  `git grep` for the old label over `documentation`, `dashboard/src`, `e2e`
  and `app/src` prints nothing.

The title, refs and line numbers above the Resolution cite main @d839494a;
they are left as the record.
