---
id: tour-outcome-close-not-backend-enforced
title: "Tour exit gate: 'not a fit closes the tour' is dashboard-composed, not backend-derived"
type: debt
severity: low
status: open
area: app
created: 2026-07-08
refs: app/src/routes/tours.ts:527, dashboard/src/routes/tours/TourDetail.tsx:250
---

**Problem (review finding, 2026-07-08 - robustness).** The exit-gate PATCH
handler sets outcome/moveForward/convertible but never derives status 'closed'
from a not-a-fit outcome; the close only happens because the dashboard's
Record-outcome modal adds status:'closed' into the same PATCH. Any other
client recording {outcome:'not_a_fit', moveForward:false} WITHOUT the status
leaves the tour stuck at 'toured' with an outcome set, convertible false, no
primary CTA on the page, and no obvious way forward. The shipped UI path is
correct end-to-end; this is an API-robustness gap only.

Related nit (same review): the Schedule card's reminder-routing chip keys off
groupThreadId presence, while the backend's resolveUsableGroup also treats a
CLOSED/degraded group as unusable (falls back to 1:1) - so a tour with an
existing-but-closed group shows "reminders -> group" while reminders actually
go 1:1. The "no usable group" warning under-fires in that narrow edge.

**Suggested fix.** Derive status 'closed' server-side when a not-a-fit outcome
lands on a toured tour (keeping the combined-PATCH path idempotent), and align
the routing chip with resolveUsableGroup semantics (expose "usable" on the
tour GET or a shared predicate).
