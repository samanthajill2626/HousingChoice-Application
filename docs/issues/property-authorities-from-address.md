---
id: property-authorities-from-address
title: Suggest a property's housing authorities from its address (county and city limits)
type: improvement
severity: low
status: open
area: app/units
created: 2026-10-07
refs: app/src/lib/orgStartingList.ts, dashboard/src/routes/orgs/OrgPicker.tsx
---

**Problem.** A property's housing authorities (`unit.accepted_authorities`) are picked by
hand from the housing authority list (clean-org-names, spec D6). Which authorities CAN
serve a property follows from where it is: DCA runs vouchers in 149 of Georgia's 159
counties but not Fulton, DeKalb, Clayton, Cobb, Bibb, Chatham, Glynn, Muscogee, Richmond
or Sumter; Clayton County vouchers are Jonesboro Housing Authority's and Cobb County's
are Marietta Housing Authority's; a city authority (Atlanta, Decatur, East Point, College
Park) serves inside its city limits. Staff have to know all of this, and a property that
lists an authority that cannot serve it - or misses one that can - is counted under the
wrong authority on the Properties page and reached by the wrong blasts.

**Suggested fix.** Geocode the property address to its county and city, keep a table of
which authority serves which county or city (seeded from the 2026-10-06 research in
Appendix B of `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`),
and SUGGEST the matching authorities on the property forms. Never write them
automatically: whether the landlord accepts an authority's vouchers stays the landlord's
choice. Needs a geocoding source decision first (license, cost, Windows and Linux ARM64
behavior). Out of scope for clean-org-names (spec section 2 non-goals; section 12).
