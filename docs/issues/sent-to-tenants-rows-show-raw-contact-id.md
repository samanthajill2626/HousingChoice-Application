---
id: sent-to-tenants-rows-show-raw-contact-id
title: Property "Sent to tenants" rows render the raw contactId instead of the tenant's name
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-10
refs: dashboard/src/routes/listing/ListingDetail.tsx, app/src/routes/units.ts
---

**Problem.** On the property page, each "Sent to tenants" row's identity link renders
the raw contactId (e.g. `contact-cast-searching-tenant`) instead of the tenant's
name. PRE-EXISTING (the pre-tour-chip code rendered `label={row.contactId}` the same
way); surfaced during the listing-response-tour-chip self-QA. The tenant-side
"Properties sent" card is fine (it shows unit addresses), and the contact ROSTER
card on the same page resolves names - only this card shows raw IDs.

**Suggested fix.** Enrich GET /api/units/:unitId/recipients rows with the tenant's
raw firstName/lastName/phone (same pattern as the broadcast results enrichment:
chunked contacts.getById, bounded concurrency, deleted contacts omit fields) and
compose the display name in the dashboard via contactDisplayName, with the current
contactId text as the final fallback. Mirrors the S5/S6 approach already merged for
broadcast results.
