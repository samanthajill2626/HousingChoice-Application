<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` (including the post-review fix wave: rta_window stage-scoped clear, atomic conversion
> claim, rendered Today-board asserts, landlord 1:1 create-on-demand) and its feature branch +
> worktree were deleted during worktree cleanup. **This file is NOT current documentation, and
> the live code may have drifted from it. Do not treat it as authoritative guidance on how the
> system should be built or how it behaves today.** For current truth read the code and the
> living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/post-tour-application-sequence.mermaid` + writeup).
# Post-Tour & Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the founder-approved Post-Tour & Application sequence real — tour→placement conversion, the stage-keyed application nudge ladder, the RTA 48-hour clock, and the e2e scenario suite that walks every placement stage without skipping.

**Architecture:** Conversion is a new `POST /api/placements/from-tour` that reuses the existing placement-create path (provenance, milestone, derive-on-create) and finalizes the tour (closed + `convertedPlacementId` + reminder cancel + relay `rebindOwner` → placement). The nudge ladder clones the tour-reminders durable-rows + worker-poll + claim-before-send pattern into a new `placementNudges` table/repo/job, armed from the ONE status-transition choke point (`services/statusTransition.ts`) via an optional injected hook. The 48h clock is a hard-clock `rta_window` deadline armed in that same choke point on entering `awaiting_landlord_submission` (type + Today rendering + hard-clock precedence already exist — only the arming is new). Lost placements also close their relay thread via an injected hook reusing the relayGroups close pattern.

**Tech Stack:** TypeScript ESM, Express, DynamoDB (Local for tests), Vitest, Playwright e2e (lane-isolated), fake-twilio.

## Global Constraints

- SEQUENCE SOURCE OF TRUTH: `documentation/post-tour-application-sequence.mermaid` + its writeup. Code moves toward the diagram; NEVER edit the flow to match code — stop and report instead.
- Placement stages walked IN ORDER, no skips: born `send_application` → `awaiting_receipt` → `awaiting_completion` → `awaiting_approval` → `collect_rta` → `review_rta` → `send_rta_to_landlord` → `awaiting_landlord_submission` → `awaiting_authority_approval`.
- Tenant stays `searching` until conversion; conversion moves them to `placing` via the EXISTING `deriveForStage` (do not hand-set statuses).
- Masked relay only — NO unmasked group text anywhere (founder 2026-07-02). Nudges go to the PARTY's 1:1 thread (tenant rungs → tenant, landlord rungs → landlord), NOT the group (per the approved diagram arrows).
- Quiet conversion: no announcement message is sent at convert time.
- Terminology: "Team" never a founder name; staff copy "property", tenant copy "home", code `unit` (GLOSSARY.md). PII: log IDs only — never phones/names/bodies.
- TDD every task (superpowers:test-driven-development): failing test first, watch it fail, minimal code, green, commit. Commit EXPLICIT paths only; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (subagents keep this trailer too).
- Worktree `w:/tmp/post-tour-app`, branch `feat/post-tour-application`. NEVER touch the main checkout; NEVER merge into main. e2e runs on this worktree's own lane, FRESH stack (`npm run e2e:stop` first). Never pipe test runs through `tail` (masks exit codes) — redirect to a file and `echo EXIT=$?`.
- Subagents dispatched for tasks are pinned `model: opus` (CLAUDE.md usage-limit rule).
- New infra (the `placementNudges` table) is DECLARED in `app/src/lib/tables.ts` + `infra/envs/{dev,prod}/tables.auto.tfvars.json` only — never run terraform. Hermetic/local tables are created from tables.ts automatically.

---

## Task 0: Audit anchors (read-only — no code)

Facts verified 2026-07-03 against this worktree; every later task's code is written against these:

- `PLACEMENT_STAGES` — `app/src/lib/statusModel.ts:37-63`. `deriveStatuses`, `isPlacementStage`, `TERMINAL_STAGES`, `STAGE_STUCK_THRESHOLDS` all exported there.
- `transitionPlacement(placementId, input)` — `app/src/services/statusTransition.ts:252` (service interface line 136). `scheduleStuckNudge` at ~:225 defers to pending HARD-CLOCK types (`rta_window` in the set at :40-44) and clears the slot on terminal stages. `deriveForStage(tenantId, unitId, stage)` exists on the same service (used by the placements create route at `app/src/routes/placements.ts:473`).
- `POST /api/placements` create — `app/src/routes/placements.ts:425`: `validatePlacementCreate` (stage defaults `send_application`), referential-integrity 404s, `placements.create({... stage_entered_at, stage_source:'manual'})`, audit `placement_created`, `recordPlacementMilestone(tenantId,'placement_opened',…)` (:327 — its type union ALREADY includes `'tour_took_place'`), `events.emit('placement.updated', …)`, best-effort `transitions.deriveForStage`.
- `CreatePlacementInput = Partial<PlacementItem> & {tenantId, unitId, stage}` (`placementsRepo.ts:186`) — `PlacementItem` has an index signature, so `fromTourId` and `group_thread` (:120) flow through create.
- `setNextDeadline(placementId, {type, at} | null)` — the ONLY legal writer of the composite byNextDeadline key (`placementsRepo.ts:204-206`). `'rta_window'` is a valid `PlacementDeadlineType` (:63) and Today already renders it as "RTA window closing" (`routes/today.ts:119`). NOTHING arms it in prod code today (only seeds).
- Tours: `TourItem` (`toursRepo.ts:62`) has `convertible?`, `groupThreadId?`, index signature (→ `convertedPlacementId` flows through `tours.patch`). Exit gate sets `convertible` (`routes/tours.ts:415-416`); PATCH refuses changes on `closed` tours; NO convert route exists.
- `cancelTourReminders(tourId, {tourRemindersRepo, logger})` — `app/src/jobs/tourReminders.ts:137`.
- `conversationsRepo.rebindOwner(conversationId, newOwner: RelayOwner)` — metadata-only, preserves pool + members (`conversationsRepo.ts:389,1119`). `setRelayStatus(id,'closed',null,'open')` + `poolNumbers.release(oldPoolNumber)` with idempotent `ConditionalCheckFailedException` handling — mirror `routes/relayGroups.ts:346-365`.
- Durable-row job pattern to clone: `tourReminders` table def (`lib/tables.ts:342-354` — PK reminderId, GSIs byTour + byDueAt with fixed `_reminderPartition`), `tourRemindersRepo` (create/listDue/claimSend/cancelForTour), poller `runDueTourReminders` (claim-BEFORE-send, `SendRefusedError` = claim kept, no retry), worker interval (`worker.ts:105-128`), dev tick seam `POST /__dev/tour-reminders/tick` (`routes/dev.ts:152-196`).
- `activityEventsRepo.record({contactId, type, label, refType?, refId?})` (`activityEventsRepo.ts:70-88`); `ActivityEventType` already includes `'tour_took_place'` (:39); `ActivityEventRefType = 'placement'|'unit'|'conversation'|'broadcast'` (:46) — needs `'tour'` added.
- Dashboard: `PlacementDetail.tsx` has the full "Move to…" stage picker calling `transitionPlacement` through `gateFor` gates; route `placements/:placementId` in `App.tsx` (detail imported :20, board :137). `TourDetail.tsx` renders `convertible` but has NO convert action.
- e2e verbs already built (tours suite): `tenantAsksToTour`, `teamCreatesTourFromInterest`, `teamOpensTourGroup`, `teamBooksTour`, `teamConfirmsTour`, `teamMarksToured`, `expectTourConvertible`, `expectNoPlacement` (`e2e/scenarios/steps.ts`). Reaching a convertible tour is fully scripted.

---

## Task 1: Conversion — `POST /api/placements/from-tour`

**Files:**
- Modify: `app/src/routes/placements.ts` (new route after the POST `/` create route; extend `PlacementsRouterDeps` with `toursRepo`, `tourRemindersRepo`, `poolNumbersService` if not present — `conversationsRepo` already is, check and reuse)
- Modify: `app/src/routes/api.ts` (wire the new deps into `createPlacementsRouter`)
- Test: `app/test/placementConvert.test.ts` (new — copy harness idioms from `app/test/toursApi.test.ts`: same buildApp/injected-repos/dev-login pattern)

**Interfaces:**
- Consumes: `toursRepo.get/patch`, `placements.create`, `recordPlacementMilestone`, `transitions.deriveForStage`, `cancelTourReminders`, `conversations.rebindOwner`, audit + events (all existing).
- Produces: `POST /api/placements/from-tour` — body `{ tourId: string }` (strict allowlist, unknown fields → 400) → `201 { placement, tour }`. Errors: 404 `tour_not_found`/`tenant_not_found`/`unit_not_found`, 409 `tour_not_convertible`, 409 `tour_already_converted`. Placement gets `fromTourId` + (when the tour has a thread) `group_thread`; tour gets `status:'closed'` + `convertedPlacementId`; thread owner rebinds to `{type:'placement', id}`.

- [ ] **Step 1: Write failing tests** in `app/test/placementConvert.test.ts` (mirror toursApi.test.ts setup — throwaway-prefix tables, injected clocks where needed). Test list, each a real HTTP call through the app:
  1. happy path: seed tenant+unit+tour (`convertible:true`, `groupThreadId` set to a seeded relay_group owned `{type:'tour'}`) → POST returns 201; placement stage `send_application`, `fromTourId===tourId`, `group_thread===groupThreadId`; tour now `closed` with `convertedPlacementId===placementId`; conversation owner is `{type:'placement', id: placementId}`; tenant contact's derived status is `placing`; the tour's pending reminder rows are canceled.
  2. no `groupThreadId` on the tour → 201, placement has NO `group_thread`, no rebind attempted.
  3. tour not convertible (`convertible` absent) → 409 `tour_not_convertible`, no placement created.
  4. second convert of the same tour → 409 `tour_already_converted` (first call set `convertedPlacementId`).
  5. unknown body field → 400; missing tourId → 400; ghost tourId → 404 `tour_not_found`.
- [ ] **Step 2: Run** `npx vitest run test/placementConvert.test.ts --root app` → expect FAIL (404 route not found).
- [ ] **Step 3: Implement the route.** Shape (inside `createPlacementsRouter`, reusing the file's local helpers — `recordPlacementMilestone`, `transitions`, `audit`, `events`, `log`):

```ts
// POST /api/placements/from-tour — the Post-Tour & Application conversion.
// Creates the placement from a CONVERTIBLE tour (exit gate said move forward),
// finalizes the tour (closed + convertedPlacementId + reminders canceled) and
// re-parents the tour's masked relay thread to the placement. QUIET: no
// announcement message is sent (founder 2026-07-02).
router.post('/from-tour', async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const unknownFields = Object.keys(b).filter((k) => k !== 'tourId');
  if (unknownFields.length > 0) {
    res.status(400).json({ error: `unknown field(s): ${unknownFields.join(', ')}` });
    return;
  }
  if (typeof b['tourId'] !== 'string' || b['tourId'].length === 0) {
    res.status(400).json({ error: 'tourId (non-empty string) is required' });
    return;
  }
  const tour = await tours.get(b['tourId']);
  if (!tour) { res.status(404).json({ error: 'tour_not_found' }); return; }
  if (tour.convertible !== true) { res.status(409).json({ error: 'tour_not_convertible' }); return; }
  if (typeof tour['convertedPlacementId'] === 'string') {
    res.status(409).json({ error: 'tour_already_converted' }); return;
  }
  if (!(await contacts.getById(tour.tenantId))) { res.status(404).json({ error: 'tenant_not_found' }); return; }
  if (!(await units.getById(tour.unitId))) { res.status(404).json({ error: 'unit_not_found' }); return; }

  const created = await placements.create({
    tenantId: tour.tenantId,
    unitId: tour.unitId,
    stage: 'send_application',
    stage_entered_at: new Date().toISOString(),
    stage_source: 'manual',
    fromTourId: tour.tourId,
    ...(typeof tour.groupThreadId === 'string' && { group_thread: tour.groupThreadId }),
  });
  mergeContext({ placementId: created.placementId });

  // Finalize the tour BEFORE returning — this is what makes a second convert 409.
  await tours.patch(tour.tourId, { status: 'closed', convertedPlacementId: created.placementId });
  await cancelTourReminders(tour.tourId, { tourRemindersRepo: reminders, logger: log });

  // Re-parent the masked relay thread (metadata-only; pool + members preserved).
  if (typeof tour.groupThreadId === 'string') {
    try {
      await conversations.rebindOwner(tour.groupThreadId, { type: 'placement', id: created.placementId });
    } catch (err) {
      log.error({ err, placementId: created.placementId }, 'convert: thread rebind failed (best-effort)');
    }
  }

  await audit.append(`placements#${created.placementId}`, 'placement_created', {
    actor: req.user?.userId, tenantId: created.tenantId, unitId: created.unitId,
    stage: created.stage, fromTourId: tour.tourId,
  });
  await recordPlacementMilestone(created.tenantId, 'placement_opened', 'Placement opened', created.placementId);
  events.emit('placement.updated', toPlacementUpdatedEvent(created));
  try {
    await transitions.deriveForStage(created.tenantId, created.unitId, created.stage);
  } catch (err) {
    log.error({ err, placementId: created.placementId }, 'derive-on-convert failed (best-effort)');
  }
  const finalTour = await tours.get(tour.tourId);
  log.info({ placementId: created.placementId, tourId: tour.tourId }, 'tour converted to placement');
  res.status(201).json({ placement: created, tour: finalTour });
});
```

  Route-order note: register `/from-tour` BEFORE `router.get('/:placementId')`? Not required (different methods), but it MUST come before any `router.post('/:placementId/...')`-style catch-alls — place it directly under the POST `/` create route. Wire `toursRepo`/`tourRemindersRepo` deps through `createPlacementsRouter` defaults exactly like the tours router does (`deps.toursRepo ?? createToursRepo({logger})`).
- [ ] **Step 4: Run tests** → PASS; run the full app suite `npm run test -w @housingchoice/app` → no regressions.
- [ ] **Step 5: Commit** `feat(placements): tour→placement conversion — POST /api/placements/from-tour` (explicit paths: the route file, api.ts, the test).

## Task 2: `tour_took_place` milestone re-wire (resolves the open issue)

**Files:**
- Modify: `app/src/repos/activityEventsRepo.ts:46` (add `'tour'` to `ActivityEventRefType`)
- Modify: `app/src/routes/tours.ts` (PATCH handler: emit on transition INTO `toured`; extend `ToursRouterDeps` with `activityEventsRepo`)
- Modify: `app/src/routes/api.ts` (wire the dep)
- Modify: `docs/issues/tour-took-place-milestone.md` (status → resolved + resolution note)
- Test: extend `app/test/toursApi.test.ts`

**Interfaces:**
- Produces: PATCHing a tour to `status:'toured'` (from any non-toured status) records ONE activity event `{contactId: tour.tenantId, type:'tour_took_place', label:'Tour took place', refType:'tour', refId: tourId}`. Idempotent per transition (re-PATCHing an already-`toured` tour does not re-emit — guard on `currentStatus !== 'toured'`).

- [ ] **Step 1: Failing test** in toursApi.test.ts: PATCH a scheduled tour to `toured` → `activityEvents.listByContact(tenantId)` contains exactly one `tour_took_place` (refType `tour`, refId tourId). Second identical PATCH → still exactly one.
- [ ] **Step 2:** Watch it fail. **Step 3:** Implement — in the PATCH handler after the successful `tours.patch`, mirror the best-effort try/catch style:

```ts
if (newStatus === 'toured' && currentStatus !== 'toured') {
  try {
    await activityEvents.record({
      contactId: current.tenantId, type: 'tour_took_place', label: 'Tour took place',
      refType: 'tour', refId: tourId,
    });
  } catch (err) {
    log.error({ err, tourId }, 'tour_took_place milestone record failed (best-effort)');
  }
}
```

- [ ] **Step 4:** Tests green (app workspace). Dashboard Timeline already renders the type (`Timeline.tsx:98`) — no dashboard change.
- [ ] **Step 5:** Update the issue file (frontmatter `status: resolved`, add "Resolved 2026-07-03: emitted from routes/tours.ts on the transition into toured, refType tour"). Commit `feat(tours): emit tour_took_place milestone on toured — resolves tour-took-place-milestone`.

## Task 3: `placementNudges` table + repo

**Files:**
- Modify: `app/src/lib/tables.ts` (new table def after `tourReminders`), `infra/envs/dev/tables.auto.tfvars.json` + `infra/envs/prod/tables.auto.tfvars.json` (declaration only — copy the tourReminders entries' shape verbatim with the new names)
- Create: `app/src/repos/placementNudgesRepo.ts`
- Test: `app/test/placementNudgesRepo.integration.test.ts` (copy `toursRepo.integration.test.ts` harness idioms)

**Interfaces:**
- Produces: table `placementNudges` — PK `nudgeId`, GSIs `byPlacement` (hash `placementId`) and `byDueAt` (hash `_nudgePartition` fixed `'nudges'`, range `dueAt`). Repo (mirror `tourRemindersRepo` exactly, renamed):

```ts
export type NudgeKind = 'receipt_check' | 'completion_check' | 'approval_check' | 'rta_window_closing';
export interface PlacementNudgeItem { nudgeId: string; placementId: string; kind: NudgeKind; dueAt: string;
  _nudgePartition: 'nudges'; sentAt?: string; canceledAt?: string; createdAt: string; [key: string]: unknown; }
export interface PlacementNudgesRepo {
  create(input: { placementId: string; kind: NudgeKind; dueAt: string }): Promise<PlacementNudgeItem>;
  listDue(nowIso: string): Promise<PlacementNudgeItem[]>;           // dueAt <= now, unsent, uncanceled
  claimSend(nudgeId: string, nowIso: string): Promise<boolean>;      // conditional: not sent AND not canceled
  cancelForPlacement(placementId: string): Promise<void>;            // stamp canceledAt on pending rows
}
```

- [ ] Steps: failing integration test (create → listDue boundary inclusive/exclusive → claimSend wins once → cancelForPlacement hides from listDue — copy the assertions tourRemindersRepo's tests make) → fail → implement repo as a rename-clone of `tourRemindersRepo.ts` (keep the conditional-expression semantics identical) → green (also `app/test/tables.test.ts` + `genTables.test.ts` will assert the new table — update their expected counts/names as those tests demand) → commit `feat(placements): placementNudges table + repo (durable nudge rows)`.

## Task 4: Nudge job — rungs, arming, poller

**Files:**
- Create: `app/src/jobs/placementNudges.ts`
- Test: `app/test/placementNudges.test.ts` (unit-style with injected repos/clock — copy the structure of the tourReminders job tests)

**Interfaces:**
- Consumes: `placementNudgesRepo` (Task 3), `placementsRepo.getById`, `contactsRepo.getById`, `unitsRepo.getById`, `conversationsRepo.findByParticipantPhone`, `sendMessageService`.
- Produces:

```ts
export const NUDGE_RUNGS: Partial<Record<PlacementStage, { kind: NudgeKind; recipient: 'tenant' | 'landlord'; delayMs: number; body: string }>> = {
  awaiting_receipt:             { kind: 'receipt_check',      recipient: 'tenant',   delayMs: 24*60*60*1000,
    body: '[AUTO] Just checking in — did the rental application come through? Let us know if you need it re-sent.' },
  awaiting_completion:          { kind: 'completion_check',   recipient: 'tenant',   delayMs: 24*60*60*1000,
    body: '[AUTO] How is the application coming along? Text us here if you are stuck on anything.' },
  awaiting_approval:            { kind: 'approval_check',     recipient: 'landlord', delayMs: 24*60*60*1000,
    body: '[AUTO] Checking in — any decision yet on the application we sent over?' },
  awaiting_landlord_submission: { kind: 'rta_window_closing', recipient: 'landlord', delayMs: 36*60*60*1000,
    body: '[AUTO] Friendly reminder — the 48-hour RTA window is closing. Have you been able to submit it?' },
};
export async function armNudgeForStage(placement: PlacementItem, toStage: PlacementStage, nowIso: string,
  deps: { placementNudgesRepo: PlacementNudgesRepo; logger?: Logger }): Promise<void>;
  // ALWAYS cancelForPlacement first (stage moved on ⇒ old chase is moot), then create
  // the new stage's row (dueAt = now + delayMs) IFF the stage has a rung. Terminal or
  // rung-less stages = cancel-only. One row per stage entry (v1: single nudge, no repeats —
  // the EXISTING stuck_placement machinery is the escalation).
export async function runDuePlacementNudges(nowIso: string, deps: RunDuePlacementNudgesDeps): Promise<void>;
  // listDue → per row: resolve placement (skip if stage no longer matches the rung's stage —
  // a late row for a stage the placement already left is CANCELED, not sent) → recipient
  // contact (tenant = placement.tenantId; landlord = unit.landlordId via unitsRepo) → phone →
  // 1:1 conversation via findByParticipantPhone (tenant_1to1|landlord_1to1|unknown_1to1) →
  // claimSend BEFORE send → sendMessageService({conversationId, body, author:'teammate', automated:true}).
  // SendRefusedError ⇒ claim kept, warn, no retry. Missing entities ⇒ warn + skip. Mirror
  // jobs/tourReminders.ts processReminderRow EXACTLY for the claim/error semantics. PII: ids only.
```

- [ ] Steps: failing tests (arm creates the right kind/dueAt per stage; arm cancels prior rows; rung-less stage cancels only; poller claim-wins-once; stale-stage row canceled not sent; refusal keeps claim; landlord recipient resolves via unit.landlordId) → fail → implement → green → commit `feat(placements): stage-keyed application nudge job (arm + claim-before-send poller)`.

## Task 5: Wire the choke point — nudge arming + RTA 48h clock + relay-close-on-lost

**Files:**
- Modify: `app/src/services/statusTransition.ts` (two optional deps + logic in `transitionPlacement`)
- Create: `app/src/services/placementRelayLifecycle.ts` (the lost-close hook impl)
- Modify: `app/src/routes/api.ts` (wire hooks where the service is constructed)
- Test: extend the existing statusTransition tests (find them: `grep -rl statusTransition app/test`) + new `app/test/placementRelayLifecycle.test.ts`

**Interfaces:**
- `StatusTransitionDeps` gains: `armStageNudge?: (placement: PlacementItem, toStage: PlacementStage, nowIso: string) => Promise<void>` and `closeRelayForLostPlacement?: (placement: PlacementItem) => Promise<void>`. Both OPTIONAL and best-effort (try/catch + log; a hook failure must never fail the transition) so every existing test/ caller is untouched.
- In `transitionPlacement`, after the stage patch + derived writes:

```ts
// RTA 48h HARD CLOCK (Post-Tour & Application): entering awaiting_landlord_submission
// arms rta_window at +48h. Hard clock owns the single next_deadline slot, so the
// stuck nudge is SKIPPED for this stage (scheduleStuckNudge reads the pre-transition
// item and would otherwise clobber the clock we just set).
if (toStage === 'awaiting_landlord_submission') {
  await placementsRepo.setNextDeadline(stored.placementId, {
    type: 'rta_window', at: new Date(Date.parse(now) + 48 * 60 * 60 * 1000).toISOString(),
  });
} else {
  await scheduleStuckNudge(stored, toStage);
}
if (toStage === 'lost' && closeRelayForLostPlacement) {
  try { await closeRelayForLostPlacement(updated); } catch (err) { log.error({ err, placementId }, 'lost relay close failed (best-effort)'); }
}
if (armStageNudge) {
  try { await armStageNudge(updated, toStage, now); } catch (err) { log.error({ err, placementId }, 'stage nudge arm failed (best-effort)'); }
}
```

  (Adapt names to the function's real locals — `stored`/`updated` per the actual code; terminal-stage slot clearing already lives in `scheduleStuckNudge`, and `lost`/`moved_in` ARE terminal, so route `lost` through `scheduleStuckNudge` too — i.e. the rta_window branch applies ONLY to `awaiting_landlord_submission`.)
- `placementRelayLifecycle.ts`: `createPlacementRelayLifecycle({conversationsRepo, poolNumbersService, auditRepo, logger})` returning `closeForLost(placement)` — no-op unless `placement.group_thread` is a string; then mirror `routes/relayGroups.ts:346-365`: `setRelayStatus(id,'closed',null,'open')` with `ConditionalCheckFailedException` → idempotent no-op; then `poolNumbers.release(oldPoolNumber)` best-effort; audit `relay_group_closed` with `{reason:'placement_lost', placementId}`.
- api.ts wiring: `armStageNudge: (p, s, now) => armNudgeForStage(p, s, now, { placementNudgesRepo, logger })`, `closeRelayForLostPlacement: relayLifecycle.closeForLost`.

- [ ] Steps: failing tests — (a) transition into `awaiting_landlord_submission` sets `next_deadline_type='rta_window'` at exactly +48h and does NOT get clobbered by a stuck nudge; (b) transition into `awaiting_receipt` calls the arm hook with the updated placement; (c) transition to `lost` on a placement with `group_thread` closes the relay (status closed, pool released) and cancels pending nudge rows (the arm hook's cancel-only path); (d) hooks absent ⇒ all existing tests still green — → fail → implement → green → commit `feat(placements): arm nudges + rta_window 48h clock + relay close on lost at the transition choke point`.

## Task 6: Worker interval + dev tick seam

**Files:**
- Modify: `app/src/worker.ts` (second interval mirroring `worker.ts:105-128`), `app/src/routes/dev.ts` (clone the tick route :152-196 as `POST /__dev/placement-nudges/tick` with `runDuePlacementNudges` + its deps, lazily built), plus the dev router deps type.
- Test: extend the dev-routes test file (find via `grep -rl "tour-reminders/tick" app/test`) with the same assertions for the new endpoint (400 on bad `now`, 200 runs a pass).

- [ ] Steps: failing test → implement (60s interval, `.unref()`, error-logged catch; tick normalizes `now` via `new Date(x).toISOString()` exactly like the tour tick) → green → commit `feat(worker): placement-nudge poll + /__dev/placement-nudges/tick seam`.

## Task 7: Dashboard — Start placement from a convertible tour

**Files:**
- Modify: `dashboard/src/api/endpoints.ts` (+`createPlacementFromTour(tourId): Promise<{placement: Placement; tour: Tour}>` calling `POST /api/placements/from-tour`), `dashboard/src/api/types.ts` (Tour gains `convertedPlacementId?: string`; Placement gains `fromTourId?: string` if the type is field-listed), `dashboard/src/routes/tours/TourDetail.tsx`
- Test: `dashboard/src/routes/tours/TourDetail.test.tsx` (extend) + `dashboard/src/api/endpoints.test.ts` (extend)

**Interfaces:** TourDetail behavior — when `tour.convertible === true && tour.convertedPlacementId === undefined`: render `<button aria-label="Start placement from this tour">Start placement</button>`; on click call `createPlacementFromTour`, then `navigate(\`/placements/${placement.placementId}\`)`. When `convertedPlacementId` is set: render a `Link` "View placement" to `/placements/<id>` instead (and no button). Errors surface via the existing `actionError` pattern. Staff copy says "placement" (already the blessed word).

- [ ] Steps: failing component tests (button renders only when convertible+unconverted; click fires the endpoint + navigates; converted tour shows the link) → fail → implement → green (`npm run test -w @housingchoice/dashboard`) → commit `feat(dashboard): Start placement action on convertible tours (TourDetail)`.

## Task 8: e2e verbs + `post-tour-application.spec.ts`

**Files:**
- Modify: `e2e/scenarios/steps.ts` (new verbs; follow the existing tour-verb idioms — UI for Team actions, API for inbound/assert, a11y locators)
- Create: `e2e/tests/scenarios/post-tour-application.spec.ts`

**New verbs (exact names later tasks/tests use):**
- `teamConvertsTourToPlacement(): Promise<string>` — UI: TourDetail → "Start placement" → waits for the PlacementDetail page; returns the placementId (from the URL). Stores it as the scenario's active placement.
- `teamMovesPlacementTo(stageLabel: string): Promise<void>` — UI: PlacementDetail "Move to…" picker (drive it exactly as PlacementDetail.test does its accessible names; handle the LostReasonModal when the target is Lost via a `lostReason` option arg).
- `expectPlacementStage(stageLabel: string): Promise<void>` — asserts the rendered stage on PlacementDetail (scoped, getByRole).
- `devPlacementNudgeTick(nowIso?: string): Promise<void>` — POST the tick seam.
- `expectOutboxMessageContaining(text: string, opts?: {toRole?: 'tenant'|'landlord'}): Promise<void>` — via `GET /__dev/outbox` (reuse the existing outbox helper if one exists — check for tour-reminder assertions in tours.spec.ts and mirror).
- `expectRtaClockArmed(): Promise<void>` — API: `GET /api/placements/:id` → `next_deadline_type === 'rta_window'` and `next_deadline_at` ≈ +48h (±5 min tolerance).
- `expectTenantBackSearching()` / reuse existing status-assert verbs where present (grep steps.ts for the tours suite's tenant-status assertions and reuse).
- `expectPlacementLost(): Promise<void>` — placement stage `lost` via API + PlacementDetail shows Lost.

**Spec — 4 tests (self-cleaning, fresh contacts, NO per-test reseed, own lane):**
1. **Happy path — the full ladder walk.** Reuse tours verbs to reach a convertible tour WITH a group thread (`teamCreatesTourFromInterest` → `teamOpensTourGroup` → `teamBooksTour` → `teamConfirmsTour` → `teamMarksToured` → exit gate yes → `expectTourConvertible`). Then: convert (assert placement at `Send application`, tenant `Placing` — and the group thread survives, now placement-owned) → walk EVERY stamp in order with `teamMovesPlacementTo`: Awaiting receipt (tick +24h ⇒ receipt_check nudge in outbox to the tenant) → Awaiting completion → Awaiting approval (tick ⇒ approval_check to the landlord) → Collect RTA → Review RTA → Send RTA to landlord → Awaiting landlord submission (`expectRtaClockArmed`; tick +36h ⇒ rta_window_closing to the landlord) → Awaiting authority approval (`expectPlacementStage`). No stage skipped — this test IS the founder's no-skip requirement.
2. **Landlord denies (marked).** Walk to Awaiting approval → move to Lost (reason category via the modal) → assert: placement lost, tenant back `Searching`, unit back `Available`, relay thread closed, pending nudges canceled (tick fires nothing new).
3. **48h window blown (marked).** Walk to Awaiting landlord submission → `devPlacementNudgeTick(now + 37h)` ⇒ the closing nudge; assert Today board shows the RTA deadline ("RTA window closing" — overdue rendering when ticked past +48h is display-only, assert the deadline row exists) → then late submit: move to Awaiting authority approval (recommit path).
4. **Party backs out early (marked).** From Awaiting receipt → Lost → same bounce-back assertions as test 2 (proves lost-from-any-stage).
- [ ] Steps: write the spec first against the verbs (it will fail on missing verbs) → build verbs → `npm run e2e:stop` then targeted run `npx playwright test tests/scenarios/post-tour-application.spec.ts` via the harness (check e2e/README for the single-spec invocation) → then FULL `npm run e2e` green → commit `test(e2e): post-tour-application scenario suite — walks every placement stage`.

## Task 9: Docs + ops

**Files:** `RUNBOOK.md` (new worker poller + new `placementNudges` table + "dev terraform apply needed post-merge; prod rides M1.11"), `docs/issues/tour-took-place-milestone.md` (already resolved in Task 2 — verify), `documentation/GLOSSARY.md` only if a new noun appeared (nudge ≈ internal term; skip unless reviewer disagrees).
- [ ] Update RUNBOOK (Claude owns it), commit `docs(runbook): placement nudge poller + placementNudges table ops notes`.

## Task 10: Verification gates (in order)

- [ ] `npm test` all workspaces → file + `echo EXIT=$?` → EXIT=0.
- [ ] `npm run e2e:stop` then FULL `npm run e2e` → EXIT=0 (89 existing + 4 new = 93 expected).
- [ ] Self-QA the UI paths live (e2e:session + MCP): convert button, stage picker walk, nudge in fake-phones.
- [ ] Branch hygiene: `git merge main`, resolve keeping both sides, re-run BOTH suites green on the updated base (main moves fast — re-check right before reporting).
- [ ] Report: what shipped per task, issues resolved/filed, test totals, infra note (dev apply for `placementNudges`). DO NOT merge.

## Self-Review (done at plan time)

- Spec coverage: every writeup "Known gap" has a task (conversion=1, ladder=3-6, clock=5); the diagram's stamps map to spec test 1; three marked deviations map to tests 2-4; tour_took_place=2; quiet-conversion honored (no announcement anywhere); nudge recipients match the diagram's arrows (tenant/landlord 1:1). 
- Placeholder scan: none — every step names exact files/fns; test scaffolding anchors to named existing files to copy idioms from.
- Type consistency: `NudgeKind` (T3) = rungs (T4) = tick deps (T6); `armNudgeForStage` name identical in T4/T5; `createPlacementFromTour` identical in T7/T8.
