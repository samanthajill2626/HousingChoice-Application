# Seed data — entity lifecycle history / trails — implementation plan

Executes `docs/superpowers/specs/2026-07-02-seed-history-design.md` (source of truth).
Grounding research: `.superpowers/sdd/seed-history-research.md` (SURFACES / WRITE-SHAPES /
SEED-GAP — implementers read the sections named per task).

## Global Constraints (bind every task)

- **Profile isolation is load-bearing.** History is applied **only in the FULL profile**.
  `seedAll(endpoint, 'lean')` must NOT call the history post-pass. The lean profile's output
  stays **byte-identical** — the existing `app/test/seedData.test.ts` lean contract must keep
  passing UNCHANGED (extend, never weaken). This is what keeps `/__dev/reseed` + the e2e suite
  stable (the regression gate).
- **Import the canonical enums** from `statusModel.ts` / `toursModel.ts` (`PLACEMENT_STAGES`,
  `STAGE_PHASE`, `deriveStatuses`, `TENANT_STATUSES`, `LANDLORD_STATUSES`, `LISTING_STATUSES`,
  `TOUR_STATUSES`). Never hardcode a status list or a derivation.
- **Deterministic generator, fixed timestamps.** No `Math.random()`, no `new Date()` inside the
  generator core (the live caller injects `now`). Audit SK `ts = <ISO>#<deterministic suffix>`
  (stable per entity+hop; distinct so rows on one `entityKey` sort correctly newest-first).
  `actorId` hoisted from `payload.actor` (omit for derived/system rows). activity SK
  `tsEventId = <ISO at>#<eventId>` with deterministic `evt-*` ids.
- **Faithful mirror.** Match the real write shapes in `statusTransition.ts` exactly
  (`placement_stage_changed` / `tenant_status_changed` / `listing_status_changed` payload keys +
  `source` values). Do NOT invent an event_type the app never emits — where uncertain (landlord
  status), grep the real write path and match it.
- **Monotonic + anchored:** each entity's hops strictly increase and the **final hop equals the
  entity's stored anchor**; earlier hops walk backward via a plausible per-stage duration table.
- **Single source of truth (spec §4.7):** in the full profile, `history.ts` supersedes the
  pre-existing hand-authored lifecycle rows (lean's 2 audit, matrix's 4 activity) via dedupe —
  no duplicate/contradictory rows. Leave lean's dead `contact.profile_edited` row alone.
- Verify with REAL exit codes (output to file + `echo EXIT=$?`; never pipe through tail).
- Stage EXPLICIT paths; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  NEVER deploy/terraform/secrets/.env/.docx. Do NOT merge. Touch only files in each task's list.

---

## Task 1: `history.ts` core generator — placement + derived + standalone AUDIT trails, wired into `seedAll('full')`

**Files:** create `app/src/lib/seed/history.ts`; modify `app/src/lib/seed/index.ts` (call the
post-pass in the full branch only). Tests: extend `app/test/seedData.test.ts` (audit-trail
coverage + lean byte-stability) — or a new `app/test/seedHistory.test.ts` if cleaner; follow the
neighboring `app/test/` convention (tests live in `app/test/`, not `src/`).

Read: research §SEED-GAP.1–4, §WRITE-SHAPES.1–2; `statusModel.ts` (`PLACEMENT_STAGES`,
`STAGE_PHASE`, `deriveStatuses`, `LISTING_STATUSES`, `TENANT_STATUSES`, `LANDLORD_STATUSES`);
`statusTransition.ts:252-410` (the exact audit shapes); `auditRepo.ts` (item shape + SK rule);
`seed/index.ts` (how `tables` is assembled), `seed/matrix.ts` (entity id conventions, fixed date
pool `D.T*`), `seed/lean.ts:203,255-270` (pinned placement + its pre-existing audit rows).

Build:
1. A per-stage **duration table** (fixed day-gaps per transition; plausible per §4.2) + a pure
   helper that, given a target stage index and an anchor ISO, returns the ordered hop timestamps
   (final == anchor, strictly increasing). Same helper generalizes to the tenant/landlord/unit
   linear ladders.
2. `placementAuditTrail(placement)` → `placements#<id>` `placement_stage_changed` rows over
   `PLACEMENT_STAGES.slice(0, idx+1)` consecutive pairs; `lost` → active prefix then `→ lost`
   with `lost_reason_category` (from the placement doc) on the final hop; `actor` set to the
   pinned seed user for manual hops.
3. **Derived side-effects** at each hop: `deriveStatuses(from)` vs `deriveStatuses(to)`; on a
   tenant flip emit `contacts#<tenantId>` `tenant_status_changed` `source:'derived'` (no actor);
   on a unit flip emit `units#<unitId>` `listing_status_changed` `source:'derived'`; **same
   timestamp as the placement hop**; skip no-op/override-pinned flips.
4. **Unit publish hop:** `setup → available` `listing_status_changed` `source:'manual'` before
   the derived hops; `available`-only units (no placement) get just this one row.
5. **Standalone tenant/landlord status trails** (matrix rows not placement-linked): linear
   ladder rows on `contacts#<id>`; override branches (`on_hold`/`inactive`/`parked`) = prefix +
   branch hop (`source:'manual'`, `park_reason` on the parked final hop). **Verify + match the
   real landlord-status event_type** before emitting (grep the write path; §4.5).
6. `historyItems(tables)` — the pure orchestrator: takes the assembled full item map
   (`{contacts, units, placements, …}`), returns `{ audit_events, activity_events }` (activity
   left to Task 2 — return `[]` or the deduped pre-existing for now), deduped vs pre-existing
   lifecycle rows (§4.7). Export a lower-level `entityHistory(entity, ctx)` too for live reuse.
7. Wire into `seedAll`: in the `profile === 'full'` branch, after cast+matrix merge and BEFORE
   the Put loop, merge `historyItems(tables)` into `tables.audit_events` (+ dedupe). Lean branch
   untouched.

**Tests (the point):** for every non-start placement in the full set, the generated
`placements#<id>` trail equals its `PLACEMENT_STAGES.slice(0, idx+1)` consecutive-pair sequence
(oldest-first, monotonic, final ts == `stage_entered_at`); derived tenant/unit rows appear
exactly where `deriveStatuses` flips and share the hop timestamp; every unit past `setup` has a
publish row; every standalone tenant/landlord past `needs_review` has a trail; **lean profile
output byte-unchanged**.

**Verify:** typecheck; `npm test -w app -- test/seedData.test.ts` (or seedHistory.test.ts) +
full app suite (real exit codes); a scripted `seedAll(endpoint,'full')` against DynamoDB Local
completes without error and the pinned placement's history reads back as a coherent trail.

---

## Task 2: `activity_events` milestone timelines (Contact Timeline surface)

**Files:** modify `app/src/lib/seed/history.ts` (add the activity-milestone generator + fold
into `historyItems`); modify `app/src/lib/seed/matrix.ts` ONLY if standing down its 4-row
`buildActivityEvents` is the chosen dedupe path (§4.7 — otherwise dedupe inside `historyItems`
and leave matrix alone). Tests: extend the Task 1 test file.

Read: research §SURFACES.2, §WRITE-SHAPES.4; `activityEventsRepo.ts:33-67` (type union + item
shape); `matrix.ts:902-923` (the existing 4 rows + `evt-*` id pattern); `routes/placements.ts`
(`recordPlacementMilestone` — the real label strings/refTypes to mirror), `contactTimeline.ts`
(how milestones render).

Build the per-contact milestone timeline (spec §4.6), mirroring the real milestone writers'
labels/refTypes:
- Placement-linked tenant: `placement_opened` (hop 0, refType `placement`) → `stage_changed`
  per phase boundary ("Stage → <label>") → `placement_closed` at terminal.
- Tour-owning tenant (cast/matrix/live tours past `requested`): `tour_scheduled` (at the
  `scheduled` hop) → `tour_took_place` (at `toured`).
- `listing_sent`/`listing_reviewed`, `number_added`, `added_to_group_text` where the entity's
  story warrants (multi-phone contacts, relay-group members, listing-send rows).
- Timestamps align with the corresponding audit hop timestamps from Task 1 (one coherent clock).
- Dedupe/supersede the pre-existing matrix 4 (§4.7) so no contact gets a duplicate milestone.

**Tests:** every lifecycle contact (placement-linked tenant, tour-owning tenant) has a non-empty
`activity_events` timeline; the 4 previously-seeded contacts are not duplicated; tour milestones
present for toured tours; milestone `at` values align with the Task-1 audit hop timestamps.

**Verify:** typecheck; test file + full app suite (real exit codes); scripted full seed → the
pinned/searching tenant timeline reads back non-empty via `activityEventsRepo.listByContact`.

---

## Task 3: Fidelity test + live now-relative wiring + full gate run

**Files:** add the fidelity test to the Task-1/2 test file (or a focused
`app/test/seedHistoryFidelity.test.ts`); modify `app/src/lib/seed/live.ts` (run the generator
over its now-anchored entities and write the trail rows, mirroring its `armTourReminders`
replay). No new prod files.

Read: research §WRITE-SHAPES.1,5; `statusTransition.ts` (`createStatusTransitionService` deps +
`transitionPlacement`); `seed/live.ts` (how it wires repos from `doc` + injects `now` + already
writes reminder rows); `app/test/globalSetup.ts` (keyed-DB bootstrap so DynamoDB-Local tables
exist for the fidelity test).

Build:
1. **Fidelity test (anti-drift pin):** against DynamoDB Local, construct
   `createStatusTransitionService({placementsRepo, unitsRepo, contactsRepo, auditRepo, events})`
   from the doc client, `transitionPlacement` one sample placement one hop, read back the
   `audit_events` row via `auditRepo.listByEntity`, and assert the **generator's** row for that
   same `(from,to,source)` hop matches on `event_type` + payload keys. A change to the real
   service's audit shape must fail this test.
2. **Live wiring:** in `live.ts`, after its entities are constructed, run the history generator
   with the injected `now` anchor so the overdue-RTA + follow-up placements (and their derived
   tenant/unit rows + tour milestones) carry now-relative trails. Write directly (same pattern as
   its reminder rows). Extend the live deterministic-`now` test if present.

**Verify (full gate — real exit codes, output to file + `echo EXIT=$?`):**
- `npm run typecheck` (worktree root) → EXIT=0.
- `npm test -w app` → EXIT=0 (note any known DynamoDB-Local/`devOutbox` flakes; re-run in
  isolation to confirm they're pre-existing, not new).
- `npm test -w dashboard` → EXIT=0 (should be untouched — confirm no regression).
- Warm containers first: `npm run db:start && npm run s3:start`. Then the **e2e FULL suite**
  (`npm run e2e:stop` first for a fresh stack; the human dev stack is lane 0 — the suite picks
  its own lane) → EXIT=0. **A green e2e run is the lean-regression proof** (e2e seeds lean).
  If a lane's tables carry a stale pre-GSI schema, delete `hc-local-<L>-*` and re-run
  (see [[e2e-lane-stale-schema-footgun]]).

---

## Task 4: Final gates + adversarial review (orchestrator-led)

Whole-branch review (spec §5 both intents): full profile gets rich, coherent, same-clock trails
on all three surfaces; **lean profile byte-untouched**; generator faithful to the real audit
shapes (fidelity test real); determinism (no random/now in the core); no PII in rows/logs; no
duplicate/contradictory rows; YAGNI. Fix loop for Critical/Important. Leave branch ready — do
NOT merge. On the user's word: sync main, final gates, close branch + worktree, stamp historical
banners on this spec+plan, update memory.
