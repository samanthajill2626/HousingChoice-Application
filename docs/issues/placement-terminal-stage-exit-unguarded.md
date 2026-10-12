---
id: placement-terminal-stage-exit-unguarded
title: A placement can move out of Lost or Moved in to any stage; whether that is allowed is undecided
type: decision
severity: low
status: open
area: app/placements
created: 2026-10-12
updated: 2026-10-12
refs: app/src/lib/statusModel.ts:118, app/src/services/statusTransition.ts, app/src/routes/statusTransition.ts, dashboard/src/routes/placements/PlacementDetail.tsx, dashboard/src/routes/placements/StageMenu.tsx:155, e2e/tests/dashboard-next/lost-modal.spec.ts:27, e2e/tests/dashboard-next/placement-history.spec.ts:16, app/src/repos/placementsRepo.ts:347, app/src/routes/tours.ts:1421
---

**Problem.** `lost` and `moved_in` are the placement ladder's terminal stages
(`TERMINAL_STAGES`, `app/src/lib/statusModel.ts:118`), but nothing stops a
placement leaving them. `transitionPlacement`
(`app/src/services/statusTransition.ts`) accepts any stage from any stage, the
transition route (`POST /api/placements/:placementId/transition`,
`app/src/routes/statusTransition.ts`) adds no rule, and both dashboard stage
pickers offer every stage on a terminal placement: the placement page's
Move to menu says so in a NOTE beside `requestMove`
(`dashboard/src/routes/placements/PlacementDetail.tsx`: "an allowed
re-open"), and the Placements list's row menu offers every stage but the
current one (`dashboard/src/routes/placements/StageMenu.tsx:155-157`). A
placement marked Lost by mistake can be put back, which is useful. But a
Moved in placement can also be dragged back into the application phase - the
move re-derives the tenant's and the property's statuses for the new stage
wherever no manual status pins them, as if the move-in never happened - and a
Lost placement can be revived months later without anyone deciding it should
be. The e2e specs rely on the escape today: `lost-modal.spec.ts:27-34` and
`placement-history.spec.ts:16-24` reset the seeded placement out of `lost`
through the API.

`fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, section 4)
added ONE check on this path - a move from a terminal stage to an open one
refuses a tenant who is no longer typed `tenant` (409 `contact_not_tenant`) -
and deliberately decided nothing else (spec section 10).

**Suggested fix.** Decide (Sam and Cameron) between: (a) keep the free
re-open as a feature and say so in the stage menus; (b) allow leaving `lost`
only (a mistaken Lost) and make `moved_in` final; or (c) route any exit from a
terminal stage through a confirm that names what it re-derives. Whatever is
chosen belongs in the transition service, so every caller is covered, and the
two e2e resets above must move to whatever path stays legal.

**The tenant check's write is not conditioned on the stage it read
(2026-10-12, R1 code review of `fix/caseworker-integrity`).** The
terminal-exit tenant check decides on the placement read at
`app/src/services/statusTransition.ts:408` (the check at `:420-421`), but the
stage write at `:477` goes through `placementsRepo.update`, whose only
condition is `attribute_exists(placementId)`
(`app/src/repos/placementsRepo.ts:347`). So a concurrent move landing between
that read and that write defeats the check, and a consistent read would not
help: a move that read the placement open (no check) writes its new stage
after someone else moved it to Lost and re-typed its tenant, leaving an open
placement on a contact that is not a tenant. The fix, when this issue is
decided, is a `stage = :from` condition on the stage write, a lost condition
answering 409 like the tours PATCH's `expectedStatus`
(`app/src/routes/tours.ts:1421`) - a change to every transition's
concurrency semantics, so it was not made in that branch.
