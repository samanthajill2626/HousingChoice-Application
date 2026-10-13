---
id: mount-time-clocks-on-long-lived-surfaces
title: Last-heard-from labels and Follow up day counts read a clock captured once per mount
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-13
refs: dashboard/src/routes/contacts/ContactsList.tsx, dashboard/src/routes/broadcasts/FollowUpView.tsx, dashboard/src/routes/listing/ListingDetail.tsx, dashboard/src/routes/contact/TenantFile.tsx, dashboard/src/routes/contact/PartnerFile.tsx
---

**Problem.** The last-heard-from surfaces capture `now` once per mount, and
ContactsList stays mounted across the contact filter routes. A tab left open
across midnight shows yesterday's inbound as "Today h:mm" and the Follow up
chips under-count days until a navigation remounts the view (code review round
1, ADV-6). Spec non-goal: the surfaces refresh on navigation, so this is
cosmetic.

**Suggested fix.** Capture the clock per data load (alongside the fetched rows)
rather than per mount.
