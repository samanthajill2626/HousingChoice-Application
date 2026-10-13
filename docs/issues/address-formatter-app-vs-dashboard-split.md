---
id: address-formatter-app-vs-dashboard-split
title: The app and dashboard address formatters spell one property two ways
type: debt
severity: low
status: open
area: app
created: 2026-10-13
refs: app/src/lib/address.ts:121, dashboard/src/routes/contact/format.ts:102, dashboard/src/routes/listing/listingFormat.ts:137, app/src/services/followUps.ts, app/src/routes/units.ts
---

**Problem.** The app's `formatAddress` joins `City, ST ZIP`; the dashboard's
`formatAddress` / `shortAddress` join `City, ST, ZIP`. The last-heard-from
feature (spec 5.6 / 14.3) deliberately uses the SERVER formatter for the Follow
up `unitLabel` and the outcome timeline labels, so the same property reads
"12 Oak St, Atlanta, GA 30314" on the Follow up tab and in the contact timeline
but "12 Oak St, Atlanta, GA, 30314" on the property card and in its action
buttons' accessible names (code review round 1, finding A-2,
`docs/superpowers/reviews/2026-10-12-last-heard-from/code-review/`).

**Suggested fix.** Pick one spelling and make both formatters produce it (or
have the dashboard consume a server-formatted label everywhere). Cosmetic;
check e2e specs that match addresses before changing either.
