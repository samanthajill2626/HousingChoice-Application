---
id: contact-timeline-time-format-differs-from-inbox
title: The contact timeline prints "9:14a" while the inbox prints "9:14 AM"
type: improvement
severity: low
status: open
area: dashboard
created: 2026-09-25
refs: dashboard/src/routes/contact/format.ts, dashboard/src/routes/inbox/inboxTime.ts
---

**Problem.** Two clock formats in one dashboard. `contact/format.ts`
(`formatTime`) renders "9:14a" on the timeline and its call cards (and on the
property activity log, `listing/ListingDetail.tsx`); `inbox/inboxTime.ts`
renders "9:14 AM" on inbox rows, chosen because the inbox is the screen Sam
compares to her phone (spec `2026-09-25-inbox-rows-timestamps-design.md`,
decision 5). A new staffer sees both.

**Suggested fix.** Decide once (the phone convention is the recommendation)
and align `formatTime` / `formatTimeWithSeconds` / their accessible names,
updating the timeline specs that pin the short form.
