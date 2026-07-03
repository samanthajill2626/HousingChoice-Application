---
id: transition-service-no-activity-milestones
title: Status-transition service writes audit provenance but no activity-timeline milestones
type: debt
severity: med
status: resolved
area: app/status-model
created: 2026-06-19
resolved: 2026-07-03
refs: app/src/services/statusTransition.ts, app/src/routes/placements.ts
---

**Resolution (2026-07-03).** Resolved by the activity-coverage feature. The
status-transition service now has `activityEventsRepo` injected
(`StatusTransitionDeps`, wired through `routes/statusTransition.ts` + `routes/api.ts`)
and emits activity-timeline milestones alongside its `audit_events` provenance writes:
`transitionPlacement` emits `stage_changed` (non-terminal) / `placement_closed`
(terminal `moved_in`/`lost`, folding only the lost **category** into the label, never
the free text) mapped via `STAGE_LABELS`; and `setTenantStatus` + `deriveTenantStatus`
emit `contact_status_changed` (both explicit and derived changes, per product decision).
All emitters are best-effort (a milestone write never fails the transition) and
idempotent (only on a real `from !== to` change). See
`app/src/services/statusTransition.ts` and
`docs/superpowers/plans/2026-07-03-activity-coverage-implementation.md` (WS1).

**Problem.** Before the status-model backend, a placement stage change went through
`PATCH /api/placements/:id`, which emitted an **activity-timeline milestone**
(`stage_changed` / `placement_closed`) via `activityEventsRepo` — these are what the
dashboard placement timeline renders. The new model makes
`POST /api/placements/:placementId/transition` (the one transition service, §8) the sole
path for stage changes, and `stage` was removed from the legacy PATCH allowlist. The
transition service records a `placement_stage_changed` row in **`audit_events`**
(provenance, queried by entity / `byActor`) but is **not** wired to `activityEventsRepo`,
so stage changes no longer produce activity-timeline milestones. Net effect: the dashboard
placement timeline will lose stage-change/closure entries once the frontend is migrated to
drive transitions. The legacy milestone-emitting code in `routes/placements.ts` is left
intact but is now unreachable for stage moves.

This is tied to [frontend-status-model-migration](./frontend-status-model-migration.md):
the timeline is a frontend surface, and whether stage transitions should appear on the
activity timeline (in addition to the audit provenance log) is a product decision.

**Suggested fix.** If stage-change activity-timeline milestones are required product
behavior, inject `activityEventsRepo` into the transition service and emit a milestone
alongside the `audit_events` provenance write on each `transitionPlacement` (mapping
`placement_stage_changed` → the timeline label via `STAGE_LABELS`, and the terminal
`moved_in`/`lost` → a closure milestone). Decide deliberately rather than restoring the
old path, since the audit log already captures `{from,to,source,actor,reason?}`.
