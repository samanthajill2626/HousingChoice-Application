---
id: outcome-actions-act-on-server-read-decline
title: A stale card's Undo or Interested acts on the decline the server reads, not the one the card showed
type: bug
severity: low
status: open
area: app
created: 2026-10-13
refs: app/src/routes/units.ts, app/src/repos/listingSendsRepo.ts, dashboard/src/routes/contact/Card.tsx, dashboard/src/routes/broadcasts/FollowUpView.tsx
---

**Problem.** `POST /api/units/:unitId/recipients/:contactId/outcome` clears a
decline with a compare-and-clear on the record the SERVER read at request time
(last-heard-from spec 14.7). That closes the in-request race (a decline recorded
while the request runs survives) but not the stale-card one: staff A's card
still shows decline D1; staff B undoes D1 and later staff C records D2; A's
Undo (or Interested) then removes D2, which A never saw. Both events stay on
the contact timeline, so nothing is silently lost from history (code review
round 3, A R3-1 / B R3-1,
`docs/superpowers/reviews/2026-10-12-last-heard-from/code-review/`).

**Suggested fix.** The client sends the `declined.at` it displayed (absent when
it showed none) with `interested` / `clear`; the route compares against that
instead of its own read and answers a conflict when they differ. A contract
addition on the route and both card surfaces.
