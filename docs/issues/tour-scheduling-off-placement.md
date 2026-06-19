---
id: tour-scheduling-off-placement
title: Move tour scheduling off the placement (case) — tours happen during tenant Searching, before a placement exists
type: debt
severity: med
status: open
area: app
created: 2026-06-19
refs: documentation/STATUS-MODEL.md, app/src/lib/seedData.ts, app/src/routes/cases.ts
---

**Problem.** In the entity status model
([documentation/STATUS-MODEL.md](../../documentation/STATUS-MODEL.md)), a **placement
begins only after a tour, once the tenant affirms a specific unit** — interest and
touring are **tenant `Searching`** activity, not placement stages. But the current code
models tours **on the case**: `tour_date`, `tour_history`, and the `tour_reminder`
deadline type all live on the `cases` entity (see the seed `case-0001` and the case
route/deadline logic). That means tour scheduling is attached to an entity that, per the
model, does not yet exist when a tour is booked.

This was deliberately **deferred** out of the status-model backend-foundation build
(which keeps existing tour fields intact and focuses on the placement/tenant/listing
status spine) so the two changes don't get coupled. Tracking it here so it isn't lost.

**Suggested fix.** Relocate tour scheduling to the **tenant `Searching`** context
(tenant-/unit-level, pre-placement): move `tour_date` / `tour_history` and the
`tour_reminder` deadline off `cases`, decide where they live (likely a tenant↔unit
tour record or fields on the contact during Searching), and update any deadline/reminder
logic that currently keys on the case. Reconcile the seed accordingly. Coordinate with
whatever Searching-phase UI/flow is built. No data backfill expected (dev/seed only at
time of filing).
