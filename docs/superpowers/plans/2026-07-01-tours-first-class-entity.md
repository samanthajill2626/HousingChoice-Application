# Tours — First-Class Tour Entity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Do Task 0 (audit) first** — it locks the exact repo conventions/signatures this plan references at the pattern level; refine later tasks with what you find (mirrors how the landlord-onboarding build worked).

**Goal:** Make Tours a first-class entity (separate from placements): a tenant can have many tours; each carries its own schedule, type, group thread, auto-reminders, and outcome; the tour loop exits on the tenant's "yes/no, move forward".

**Architecture:** New `Tour` entity + repo + `/api/tours` routes (backend-first). Auto-reminders as **durable DynamoDB reminder rows + a worker poll tick** (the architecture doc's DynamoDB-deadline pattern; not EventBridge). Generalize the existing masked relay/group-thread so a thread can own to a tour, a placement, or stand alone (re-parentable). A Tours dashboard surface; repoint the tenant/landlord "Tours" card off the legacy `placement.tours[]`. The tour→placement **conversion is NOT built here** — this feature captures the exit decision and leaves the tour convertible (the gate to the downstream Post-Tour & Application sequence).

**Tech Stack:** Express + DynamoDB (app), a worker container (`app/src/worker.ts`) for scheduled jobs, React/Vite (dashboard), Vitest, Playwright. Follow existing repo patterns: `contactsRepo`/`unitsRepo` (repos), `app/src/routes/units.ts` (routes), `app/src/lib/statusModel.ts` (enums/guards), `app/src/jobs/missedCallAutoText.ts` (the scheduled-send pattern), `app/src/services/sendMessage.ts` (sends).

## Global Constraints

- **Source of truth:** `docs/superpowers/specs/2026-07-01-tours-first-class-entity-design.md`. Every task implicitly includes its decisions.
- **Tours are separate from placements.** Do NOT add a touring placement stage. Tenant status is untouched by tours (stays `searching`).
- **Do NOT build the tour→placement conversion.** Capture the exit decision ("yes/no move forward") + leave the tour convertible only.
- **Reminders = durable DynamoDB rows + worker poller.** No EventBridge. Must be testable against DynamoDB Local with a controllable clock (no real AWS).
- **`placement.tours[]` has no real data** → clean repoint of the "Tours" card + retire the field. No data migration.
- **Group threads become owner-agnostic** (tour | placement | none), re-parentable. Reuse the existing masked-relay feature — do not invent a second group mechanism.
- **Out of scope (documented):** multi-concurrent-tour group-thread numbering/UX (`docs/issues/group-threads-across-multiple-tours.md`); lockbox vendor; email; the e2e scenario suite + the Tours sequence diagram/writeup, which are a follow-on **authored after** this ships (no diagram exists yet — an earlier draft was struck as inaccurate).
- **TDD, backend-first, frequent commits.** End commit messages with the project's Co-Authored-By line. Do NOT merge to main without human approval.

---

## Task 0: Conformance audit (lock the conventions before building)

**Files:** none (produces notes + refined task signatures).

- [ ] Read the repo patterns this plan builds on and record exact signatures/paths:
  - A repo: `app/src/repos/unitsRepo.ts` + `contactsRepo.ts` (item shape, GSI helpers, create/get/list/patch, the single-table key conventions, `TABLE_PREFIX`).
  - Routes: `app/src/routes/units.ts` (validation allowlist pattern, auth gate, error shapes).
  - Enums/guards: `app/src/lib/statusModel.ts` (how enums + type guards + labels are structured).
  - The scheduled-send job: `app/src/jobs/missedCallAutoText.ts` + `registerHandlers.ts` + `app/src/worker.ts` (how a job is registered/enqueued/run; how the worker ticks).
  - The masked relay / group thread: `app/src/routes/relayGroups.ts`, `app/src/jobs/relayFanOut.ts`, and wherever the pool-number↔placement binding + group-thread model live (grep `relay`, `pool`, `group_thread`, `poolNumber`). **This is the delicate area — map it fully before Task 5.**
  - The "Tours" card: `dashboard/src/routes/contact/buildContactFile.ts` (`tenantTours`), `TenantFile.tsx`/`LandlordFile.tsx`, and `PlacementItem.tours` in `app/src/repos/placementsRepo.ts` + `dashboard/src/api/types.ts`.
  - Whether any existing deadline mechanism exists to reuse (grep `next_deadline`, `byNextDeadline`; see `docs/issues/case-single-next-deadline-slot.md`) — if so, mirror it; if not, the reminder rows are net-new.
- [ ] Confirm/adjust the exact names used below (`toursRepo`, `TourItem`, route paths, job names). Note any deviations at the top of the plan.
- [ ] Commit the audit notes (`.superpowers/` scratch or a short `docs/issues/` note is fine).

---

## Task 1: `Tour` entity + `toursRepo`

**Files:**
- Create: `app/src/repos/toursRepo.ts`
- Test: `app/test/toursRepo.integration.test.ts` (mirror an existing `*.integration.test.ts` that uses DynamoDB Local)
- Modify: table creation script (`app/scripts/db-create.ts`) + seed if the repo needs a table/GSIs

**Interfaces — Produces:**
- `TourItem`: `{ tourId, tenantId, unitId, scheduledAt (ISO), tourType: 'self_guided'|'landlord_led'|'pm_team', status: TourStatus, groupThreadId?: string, outcome?: TourOutcome, moveForward?: boolean, convertible?: boolean, createdAt, updatedAt }`
- `createToursRepo(deps)` → `{ create, get, listByTenant, listByUnit, listByScheduledRange, patch }`
- GSIs: `byTenant`, `byUnit`, `byScheduledAt` (sparse — powers the "tours today" + reminder/no-show clock).

- [ ] **Step 1 — RED:** test `create` then `get` round-trips a TourItem; `listByTenant` returns a tenant's tours; `listByScheduledRange` returns tours in a datetime window.
- [ ] **Step 2:** run it, watch it fail (repo missing).
- [ ] **Step 3 — GREEN:** implement `toursRepo` mirroring `unitsRepo` (keys, GSIs, marshalling). Add the table/GSIs to `db-create`.
- [ ] **Step 4:** tests pass. **Step 5:** commit.

---

## Task 2: Tour status model (enum + guards + transitions)

**Files:**
- Modify: `app/src/lib/statusModel.ts` (add `TOUR_STATUSES`, labels, guard) OR create `app/src/lib/toursModel.ts` if the file is already large (audit decides).
- Test: `app/test/toursModel.test.ts`

**Interfaces — Produces:**
- `TOUR_STATUSES = ['scheduled','confirmed','toured','no_show','canceled','closed']`; `TourStatus`; `isTourStatus`; `TOUR_STATUS_LABELS`.
- `TourOutcome` for the exit gate (e.g. `'move_forward' | 'not_a_fit'`).
- Rule: `canceled`/`no_show` are **reschedulable** (→ `scheduled`); `closed` is the terminal for a finished-and-decided tour; `moveForward=true` marks convertible.

- [ ] **RED:** test the guard accepts the six statuses + rejects unknowns; test a helper `canReschedule(status)` returns true for `canceled`/`no_show`/`scheduled`/`confirmed` and false for `closed`.
- [ ] Run → fail → implement → pass → commit.

---

## Task 3: `/api/tours` routes (incl. the exit gate)

**Files:**
- Create: `app/src/routes/tours.ts`; mount in `app/src/app.ts`
- Test: `app/test/toursApi.test.ts` (mirror `app/test/unitsApi.test.ts`)

**Interfaces — Consumes:** `toursRepo` (Task 1), the status model (Task 2). **Produces (HTTP):**
- `POST /api/tours` `{ tenantId, unitId, scheduledAt, tourType }` → 201 `{ tour }` (status `scheduled`).
- `GET /api/tours/:tourId` → `{ tour }`; `GET /api/tours?tenantId=&unitId=&from=&to=` → `{ tours }`.
- `PATCH /api/tours/:tourId` — reschedule (`scheduledAt`), set `status`, set `outcome`+`moveForward` (the **exit gate**), cancel. Reject illegal transitions per Task 2.

- [ ] **RED:** route tests — create a tour; reschedule a `no_show` back to `scheduled`; record the exit gate (`PATCH { outcome:'move_forward', moveForward:true }` → `convertible:true`); reject `closed → scheduled`.
- [ ] Run → fail → implement (validation allowlist like `units.ts`; auth gate) → pass → commit.
- [ ] Note: do NOT create a placement here (conversion is downstream). The exit gate only marks the tour.

---

## Task 4: Auto-reminder rows + worker poller

**Files:**
- Create: `app/src/repos/tourRemindersRepo.ts` (durable reminder rows: `{ reminderId, tourId, kind, dueAt, sentAt?, canceledAt? }`, GSI `byDueAt` sparse), `app/src/jobs/tourReminders.ts` (arm/cancel/re-arm + the poll handler).
- Modify: `app/src/jobs/registerHandlers.ts`, `app/src/worker.ts` (register a recurring tick), `app/src/routes/tours.ts` (arm on create, re-arm on reschedule, cancel on cancel/closed).
- Test: `app/test/tourReminders.test.ts`

**Interfaces — Consumes:** `toursRepo`, `sendMessage` service. **Produces:**
- `armTourReminders(tour)` writes the ladder rows (`confirmation` immediate, `day_before`, `morning_of`, `en_route`, plus a `no_show_checkin`), each with a computed `dueAt`.
- `cancelTourReminders(tourId)` marks/deletes pending rows; re-arm = cancel + arm.
- `runDueTourReminders(now)` (the poll handler): query `byDueAt <= now && sentAt == null`, send via `sendMessage`, stamp `sentAt`. Idempotent per reminder row (a redelivery is a no-op).

- [ ] **RED:** with an injected clock, arm reminders on a tour scheduled for T+2d; assert the rows + their `dueAt`s. Advance the clock to the day-before `dueAt`, run `runDueTourReminders` → one text sent (assert via the fake/console send seam) + `sentAt` stamped; a second run sends nothing. Reschedule the tour → old rows canceled, new rows armed. Cancel the tour → pending rows canceled.
- [ ] Run → fail → implement (mirror `missedCallAutoText` for the send + idempotency). **Durability:** state is the DynamoDB rows; the poll tick is stateless. **Testability:** clock is injected; runs against DynamoDB Local.
- [ ] pass → commit.

---

## Task 5: Group-thread owner generalization (reuse the masked relay)

**Files:** (audit-driven — Task 0 maps these) the relay/group-thread repo + `app/src/routes/relayGroups.ts` + `relayFanOut.ts`; add an owner ref (`ownerType: 'tour'|'placement'|null`, `ownerId?`) to the group-thread model.
- Test: extend the relay tests.

**Interfaces — Produces:**
- A group thread can be created with `owner = {type:'tour', id}` , `{type:'placement', id}`, or unowned; and **re-parented** (`rebindOwner(threadId, newOwner)`), preserving the pool number + membership.
- `toursRepo`/route: a tour can create/attach a group thread (`groupThreadId`).

- [ ] **RED:** create a group thread owned by a tour (no placement); assert it exists + relays with masked pool number (reuse existing relay assertions). Create an unowned thread. `rebindOwner` a tour-owned thread to a placement → same pool number/members, new owner. Existing placement-owned relay behavior unchanged (regression).
- [ ] Run → fail → implement the owner generalization minimally (don't rewrite relay; add the optional owner + rebind). pass → commit.
- [ ] Guardrail: the multi-concurrent-tour numbering/UX is OUT OF SCOPE — one thread per tour is fine; do not build a reconciliation UI (`group-threads-across-multiple-tours`).

---

## Task 6: Dashboard — Tours surface + repoint the "Tours" card

**Files:**
- Create: a Tours list/detail surface under `dashboard/src/routes/` (schedule/reschedule/cancel, log outcome, the exit-gate feedback, the tour's group thread), + `dashboard/src/api/endpoints.ts` client fns + `types.ts` `Tour` type.
- Modify: `dashboard/src/routes/contact/buildContactFile.ts` + `TenantFile.tsx`/`LandlordFile.tsx` — repoint the "Tours" card from `placement.tours[]` to `GET /api/tours?tenantId=` (and `?unitId=` for landlord); remove `PlacementItem.tours` reads.
- Modify: `app/src/repos/placementsRepo.ts` + `types.ts` — retire the `tours` field (no data migration).
- Test: component tests (mirror `files.test.tsx`, `PlacementCreateForm.test.tsx`).

- [ ] **RED:** component test — the tenant "Tours" card renders tours from the tours API (not `placement.tours`), one row per tour linking to the tour detail, showing status + scheduledAt. A schedule form POSTs `/api/tours`.
- [ ] Run → fail → implement → pass → commit.
- [ ] **RED:** the tour detail renders status, reschedule/cancel, the exit-gate ("Moving forward? yes/no"), and the group-thread link. Implement → pass → commit.

---

## Task 7: Integration + verification

**Files:** none new — wire-up + full-suite green.

- [ ] Confirm the whole path against a live `npm run dev -- --mock --local` (or `e2e:session`): create a tour → reminders armed → advance/trigger a reminder send (via the mock seam) → record the exit gate → tour is `convertible` (no placement created).
- [ ] Run the FULL backend + dashboard suites (`npm test`) green; run the existing `npm run e2e` green (no regressions — especially relay/group-text specs after Task 5).
- [ ] superpowers:requesting-code-review; superpowers:verification-before-completion (show green output); finish with superpowers:finishing-a-development-branch. Do NOT merge to main without human approval.

---

## Not in this plan (follow-on)
- The tour→placement **conversion** (downstream Post-Tour & Application sequence).
- The Tours **sequence diagram + writeup**, authored post-build against the real entities (the earlier draft was struck as inaccurate), and the **e2e scenario suite** (built via the sequence-diagram→test playbook), and updating sending-unit's placeholder `expectHandoffToTours`.
- Multi-concurrent-tour group-thread strategy (`group-threads-across-multiple-tours`).
