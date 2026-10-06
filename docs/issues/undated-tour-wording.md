---
id: undated-tour-wording
title: Undated tours read "Not booked" on the tour page and contact/property tour lists but "Undated" on the Past and All rows
type: improvement
severity: low
status: open
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
