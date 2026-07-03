---
id: case-single-next-deadline-slot
title: A placement has one next_deadline slot, so stuck_placement nudges yield to hard-clock deadlines
type: debt
severity: med
status: resolved
area: app
created: 2026-06-19
resolved: 2026-07-03
refs: app/src/repos/placementsRepo.ts, app/src/services/statusTransition.ts:scheduleStuckNudge
---

> **RESOLVED (2026-07-03) — placement-deadline-model refactor.** The single
> overloaded `next_deadline` slot (and the `byNextDeadline` GSI + `setNextDeadline`)
> is retired. Real due-dates are now first-class **`placementDeadlines`** items (one
> per `(placement, type)`; the placement surfaces the soonest, with the flat
> `next_deadline_*` wire shape preserved as a computed projection). The internal
> **stuck flag** moved OUT of deadlines entirely — it is now DERIVED from
> time-in-stage in `today.ts` (`scheduleStuckNudge` deleted), so a placement on a
> hard clock AND going stale surfaces on **both** queues at once (no more deferral).
> Design + plan:
> [spec](../superpowers/specs/2026-07-03-placement-deadline-model-design.md),
> [plan](../superpowers/plans/2026-07-03-placement-deadline-model.md). Coexistence is
> pinned by e2e (`e2e/tests/scenarios/post-tour-application.spec.ts` — the
> voucher + rta_window + derived-stuck walk).

**Problem.** A placement carries exactly ONE `next_deadline` slot (the
`byNextDeadline` composite GSI key — `next_deadline_type` +
`next_deadline_at`, set/cleared both-or-neither via `placementsRepo.setNextDeadline`).
The status model uses that same slot for two purposes:

- **Hard-clock deadlines** — `rta_window`, `voucher_expiration`, `tour_reminder`
  (real external clocks; surfaced in Today's `needs_you_now`).
- **Soft stuck-placement nudges** — `stuck_placement` (time-in-stage; STATUS-MODEL.md §8;
  surfaced in Today's `follow_ups`).

Because there is only one slot, the transition service
(`statusTransition.ts` → `scheduleStuckNudge`) deliberately **defers** scheduling
a `stuck_placement` nudge whenever a hard-clock deadline is already pending — it must
not clobber an `rta_window`/`voucher_expiration`/`tour_reminder` clock (that
would silently drop a real deadline). The consequence: a placement that is both
on a hard clock AND going stale will **not** get its stuck nudge until the
hard-clock deadline is cleared/fires. This is an accepted Phase-1 contention,
not a bug — but it means a stuck placement sitting behind a hard clock can be
under-nudged.

**Suggested fix.** If under-nudging proves to matter operationally, model
**multiple concurrent deadlines** per placement — e.g. a `deadlines` map (type →
instant) with a derived "soonest pending" projected onto the existing
`byNextDeadline` key for query compatibility, or a separate per-type deadline
GSI. Both are larger changes (schema + Today aggregation + the pull-based
deadline mechanism), hence parked here rather than built now.
