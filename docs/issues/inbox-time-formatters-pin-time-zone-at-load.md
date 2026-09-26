---
id: inbox-time-formatters-pin-time-zone-at-load
title: The inbox time label's formatters fix the time zone at page load, so an OS zone change mid-session mislabels rows until a reload
type: debt
severity: low
status: open
area: dashboard/inbox
created: 2026-09-25
refs: dashboard/src/routes/inbox/inboxTime.ts, docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/code-review-r2.md
---

**Problem.** `dashboard/src/routes/inbox/inboxTime.ts` builds its four
`Intl.DateTimeFormat` instances once, at module load (build review AD-1, a
render-cost fix). Each one resolves the default time zone when it is
constructed. The tier logic (`sameLocalDay`, the Yesterday and same-year
checks) reads `Date` getters, which follow the CURRENT zone. After the OS
time zone changes mid-session (travel, a manual change), the tier is chosen
in the new zone and the text is printed in the old one: a row whose activity
is 11:30 PM locally can print "12:30 AM", and a date label can disagree with
its tier, until the page is reloaded. The `toLocale*String` calls the
formatters replaced resolved the zone on every call. Found by build review
round 2 (R2-5 in `code-review-r2.md`), filed rather than fixed.

**Suggested fix.** Rebuild the four formatters when
`Intl.DateTimeFormat().resolvedOptions().timeZone` differs from the zone they
were built in (one cheap check per call or per Inbox render), or accept it:
the window is one session on a machine whose zone changed, and a reload
clears it.
