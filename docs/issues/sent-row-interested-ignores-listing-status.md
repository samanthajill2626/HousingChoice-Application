---
id: sent-row-interested-ignores-listing-status
title: A properties-sent row offers Interested (books a tour) on a home that is no longer Available
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-27
refs: app/src/routes/units.ts:1574, dashboard/src/routes/contact/Card.tsx:351, dashboard/src/routes/listing/listingFormat.ts:353
---

**Problem.** A row on a contact's properties-sent list (and on the property's
Sent to card) shows no listing status, and its Interested action books a
requested tour without checking the property's status
(`POST /api/units/:unitId/recipients/:contactId/outcome`, units.ts ~1574-1664,
checks only missing / deleted). So a row for an Occupied, Off market or On
hold home offers "Interested" / "Request a tour" exactly like an Available one.

This is reachable today: a home that left Available after it was sent keeps
its rows. The permanent-flyer-links change
(docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md, D5/D9)
adds a second way: a flyer sign-up from a non-Available home now writes a
`flyer` share entry, so `Signed up` rows appear on non-Available homes too.
Staff see the status in the sign-up pin (D6) but not on the row.

**Suggested fix.** Show the property's status on the row when it is not
Available, and decide with Sam whether Interested on a non-Available home
should warn, be hidden, or stay as is (a lead for similar homes).
