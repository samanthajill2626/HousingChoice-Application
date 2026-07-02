---
id: relay-group-no-dashboard-surface
title: Masked relay-group threads have no dashboard surface to view or post into
type: improvement
severity: med
status: open
area: dashboard
created: 2026-07-02
refs: app/src/routes/inbox.ts:23, dashboard/src/routes/tours/TourDetail.tsx, dashboard/src/App.tsx, docs/issues/group-threads-across-multiple-tours.md
---

**Problem.** A tour's masked relay group is fully functional at the API level — Team can
open it from TourDetail ('Open group thread'), members negotiate through it, intros and
(now) reminders land in it, and staff can post via `POST /api/conversations/:id/messages` —
but there is **no dashboard surface that shows the thread**:

- The Inbox **explicitly excludes** `relay_group` conversations (`app/src/routes/inbox.ts:23-24`,
  enforced in both query paths) — "C8 has no group row kind".
- TourDetail's 'View group thread' link navigates to bare `/inbox` (no conversation
  deep-link exists — `App.tsx` has no `/inbox/:conversationId` route), so it lands on a feed
  that cannot contain the thread. A dead end.
- Contact timelines key off 1:1 conversations, so relayed group traffic doesn't render
  there either.

**Impact.** Team can create and use the group blind (everything works over SMS), but the
diagram's "negotiate in the group thread" has no staff-visible record in the dashboard —
today it is verifiable only via the API (`GET /api/conversations/:id/messages`) or the
fake-twilio store in e2e. As tours scale this becomes a real observability gap for
coordinators.

**Suggested fix (when prioritized).** Either an Inbox row kind for relay groups + a
conversation view route (`/inbox/:conversationId`), or a thread panel embedded on
TourDetail (the tour owns the thread — `groupThreadId` — so the tour page is arguably the
natural home). Interacts with [[group-threads-across-multiple-tours]] (presentation across
multiple concurrent tours) — decide the two together.

Filed during the tours-sequence e2e build (the suite asserts group traffic via the fake
threads + API precisely because no dashboard surface exists).
