<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-04).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Approval & Move-in Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and e2e-verify the final placements sequence — from the housing authority receiving the RTA (`awaiting_authority_approval`) through the ~4-week window to `moved_in` — wiring the data capture and dashboard UI the existing stage ladder still lacks.

**Architecture:** The downstream stage ladder, `inspection_outcome`, and `final_rent` already exist. This plan adds three placement data points (inspection date, determined rent, a 3-item paperwork checklist), captures them through the **existing** transition choke point + gate/modal pattern (the same one `finalRent`/`inspectionOutcome` use) and the general `PATCH /:placementId` allowlist, surfaces them on `PlacementDetail`, and adds an e2e conformance suite that walks every stamped stage.

**Tech Stack:** TypeScript ESM, Express, DynamoDB (Local for tests), Vitest, React + Vite dashboard, Playwright e2e (lane-isolated), fake-twilio.

## Global Constraints

- **SEQUENCE SOURCE OF TRUTH:** `documentation/approval-and-move-in-sequence.mermaid` + its writeup. Code moves toward the diagram; NEVER edit the flow to match code — stop and report.
- **Stages walked IN ORDER, no skips:** `awaiting_authority_approval` → `schedule_inspection` → `awaiting_inspection` → `determine_rent` → `awaiting_rent_acceptance` → `awaiting_hap_contract` → `complete_paperwork` → `awaiting_move_in` → `moved_in`. The e2e must move the placement into and out of EACH, skipping none.
- **The whole downstream ladder already exists in `app/src/lib/statusModel.ts`** — do NOT add stages, phases, labels, derivation, or thresholds. This plan adds DATA + WIRING + UI + TESTS only.
- **Endpoint = `moved_in`.** Invoicing (Track 7) is OUT OF SCOPE (its own later sequence). A single inspection — no move-in "final inspection".
- **Masked relay only** — no unmasked group text. The Housing Authority is off the relay (Team records its milestones).
- **The LANDLORD schedules the inspection**, not the Team — the inspection date is a recorded value, not a Team action.
- **`complete_paperwork` = a tracked 3-item checklist:** `lease_signed` (required), `move_in_details` (required), `lif` (conditional on the tenant contact's `lifEligible`, OPTIONAL even then — never blocks). Advance to `awaiting_move_in` is a **deliberate "Ready for move-in?" confirmation** the app surfaces once the required items are recorded — NOT an all-checked auto-advance.
- **Automation:** reuse the generic per-stage stuck-nudge only (already armed). NO new nudge rungs.
- **Marked deviations** (each = one exit-asserting e2e test): inspection **fails**; landlord **rejects** the determined rent; global **backout** (Lost from any stage). Voucher-expiry is NOT marked.
- **Terminology:** "Team" never a founder name; staff copy "property", tenant copy "home", code `unit` (GLOSSARY.md). PII: log IDs only — never phones/names/bodies/amounts-as-labels.
- **TDD every task** (superpowers:test-driven-development): failing test first, watch it fail, minimal code, green, commit. Commit EXPLICIT paths only; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (subagents keep this trailer too).
- **Worktree `w:/tmp/approval-move-in`, branch `feat/approval-and-move-in`.** NEVER touch the main checkout; NEVER merge into main. e2e runs on this worktree's own lane, FRESH stack (`npm run e2e:stop` first). Never pipe test runs through `tail` (masks exit codes) — redirect to a file and `echo EXIT=$?`.
- **Subagents dispatched for tasks are pinned `model: opus`** (CLAUDE.md usage-limit rule).
- **No new infra.** All new fields are flexible-document attributes (no GSI keys) — no `tables.ts` / terraform change. Do NOT run terraform, secrets, SSM, or deploys (see the `no-infra-without-explicit-ask` rule).

## Data-model decision (RATIFIED AT TASK 1 — the build tasks assume this)

The recommended, precedent-matching shape the audit presents for human ratification:

- **`inspection_date`** — first-class placement attribute (ISO date string). Captured through the **transition input + gate modal**, exactly like `inspectionOutcome`, on the `schedule_inspection → awaiting_inspection` move.
- **`rent_determined`** — first-class placement attribute (finite number > 0). Captured through the transition input + gate modal on the `determine_rent → awaiting_rent_acceptance` move. Distinct from `final_rent` (the ACCEPTED amount, already written to the unit on the `awaiting_rent_acceptance` exit).
- **`lease_signed` / `lif` / `move_in_details`** — first-class placement booleans, toggled via the general `PATCH /api/placements/:placementId` allowlist (independent of any stage move). The `complete_paperwork → awaiting_move_in` move is gated by a new **"Ready for move-in?" confirmation** modal (no data payload; it flags unconfirmed LIF for a LIF-eligible tenant).

If Task 1's audit surfaces a reason to deviate (e.g. an existing field already covers one of these), STOP and get the human's revised decision before the affected task.

---

## File Structure

**Backend (`app/`)**
- `app/src/repos/placementsRepo.ts` — add the five attributes to `PlacementItem` (Task 2).
- `app/src/services/statusTransition.ts` — capture `inspection_date` + `rent_determined` on their moves (Task 3).
- `app/src/routes/statusTransition.ts` — validate + forward `inspectionDate` + `rentDetermined` (Task 4).
- `app/src/routes/placements.ts` — allow the checklist booleans in `validatePlacementUpdate` (Task 5).

**Dashboard (`dashboard/`)**
- `dashboard/src/api/*` — thread the new fields/inputs through the client types (Task 6).
- `dashboard/src/routes/placements/transitionGate.ts` — new gates (Task 7).
- `dashboard/src/routes/placements/MovePromptModal.tsx` — new modes (Task 7).
- `dashboard/src/routes/placements/PlacementDetail.tsx` — show fields + the checklist card + wire the move-in-ready gate (Task 8).

**e2e (`e2e/`)**
- `e2e/scenarios/steps.ts` — new verbs (Task 9).
- `e2e/tests/scenarios/approval-and-move-in.spec.ts` — the suite (Task 10).

**Docs (already committed at 56cba37):** `documentation/approval-and-move-in-sequence.{mermaid,-writeup.md}`, `docs/superpowers/specs/2026-07-03-approval-and-move-in-design.md`.

---

## Task 1: Live-stack audit + data-model decision (GATE — read-only, no code)

**Files:**
- Create: `docs/issues/approval-move-in-audit.md` (findings) + one `docs/issues/<slug>.md` per real gap.

**This is the method's mandated gate** (`documentation/sequence-diagram-to-test.md` §4 + the landlord-onboarding precedent: "when the audit shows a substantial data-model choice, STOP and get a human decision before building"). No production code. Deliverable: findings + the presented decision.

- [ ] **Step 1: Boot the hermetic session stack**

Run: `npm run e2e:stop; npm run e2e:session`
Expected: the stack comes up on this worktree's lane; note the resolved ports from `e2e/.artifacts/lane.json`.

- [ ] **Step 2: Walk every diagram step against the live stack**

Using the Playwright MCP browser (dev-login as the seeded VA) + authenticated `page.request`, confirm with evidence for EACH stamped move whether it already works and what data it can/can't capture:
- The `PlacementDetail` "Move to…" picker lists every downstream stage (it maps `PLACEMENT_STAGES`) — drive each move `awaiting_authority_approval`→…→`moved_in` and confirm it persists + the derivations fire (`Finalizing` at Contract, `Occupied`/`Placed` at `moved_in`).
- Confirm `inspectionOutcome` (pass/fail) and `finalRent` capture already work via the `MovePromptModal` gates on their moves.
- Confirm there is NO capture today for: the inspection DATE, the DETERMINED rent amount (pre-acceptance), and the paperwork checklist (`lease_signed`/`lif`/`move_in_details`).
- Confirm the tenant contact carries `lifEligible` and that PlacementDetail can read the linked tenant (it already loads `getContact`).

- [ ] **Step 3: File the gaps + write the findings doc**

Write `docs/issues/approval-move-in-audit.md` summarizing wired-vs-gap with evidence. File a `docs/issues/<slug>.md` for each real gap (inspection-date capture, determined-rent capture, paperwork-checklist). Copy `docs/issues/_TEMPLATE.md`.

- [ ] **Step 4: Present the data-model decision + STOP**

Present the "Data-model decision" block above to the human for ratification (transition-input+gate-modal for inspection_date & rent_determined; first-class booleans + PATCH + a confirmation gate for the checklist). **Do not start Task 2 until ratified.** Record the ratified decision in the findings doc.

- [ ] **Step 5: Commit the docs**

```bash
git add docs/issues/approval-move-in-audit.md docs/issues/
git commit -m "docs(approval-move-in): live-stack audit findings + data-model decision"
```

---

## Task 2: Placement data fields (repo types)

**Files:**
- Modify: `app/src/repos/placementsRepo.ts` (the `PlacementItem` interface, near `lease_date`/`move_in_date` at ~:151)
- Test: `app/test/placementsRepo.test.ts` (or the existing repo round-trip test)

**Interfaces:**
- Produces: `PlacementItem` gains `inspection_date?: string`, `rent_determined?: number`, `lease_signed?: boolean`, `lif?: boolean`, `move_in_details?: boolean`.

- [ ] **Step 1: Write the failing test** — a round-trip through `create` + `update` + `getById` preserves the five new fields.

```ts
it('round-trips the approval/move-in fields (inspection_date, rent_determined, checklist)', async () => {
  const repo = createPlacementsRepo({ /* test deps as in sibling tests */ });
  const created = await repo.create({ tenantId: 't1', unitId: 'u1', stage: 'schedule_inspection' });
  const updated = await repo.update(created.placementId, {
    inspection_date: '2026-07-20',
    rent_determined: 1850,
    lease_signed: true,
    lif: false,
    move_in_details: true,
  });
  expect(updated.inspection_date).toBe('2026-07-20');
  expect(updated.rent_determined).toBe(1850);
  expect(updated.lease_signed).toBe(true);
  expect(updated.lif).toBe(false);
  expect(updated.move_in_details).toBe(true);
});
```

- [ ] **Step 2: Run it, watch it fail** — `npm test -w @housingchoice/app -- placementsRepo` → FAIL (TS: properties don't exist / values dropped).

- [ ] **Step 3: Add the fields** to `PlacementItem` (flexible-doc attributes; `update` already passes arbitrary allowed fields through):

```ts
  /** Approval & Move-in — the LANDLORD-scheduled HQS inspection date (ISO date). */
  inspection_date?: string;
  /** Approval & Move-in — the authority's DETERMINED rent (pre-acceptance; distinct
   *  from the accepted final_rent written onto the unit on rent acceptance). */
  rent_determined?: number;
  /** Approval & Move-in — Complete-paperwork checklist (unordered). lease_signed +
   *  move_in_details are required; lif is conditional on the tenant's lifEligible
   *  and optional even then. */
  lease_signed?: boolean;
  lif?: boolean;
  move_in_details?: boolean;
```

- [ ] **Step 4: Run it, watch it pass** — `npm test -w @housingchoice/app -- placementsRepo` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/repos/placementsRepo.ts app/test/placementsRepo.test.ts
git commit -m "feat(placements): approval/move-in fields (inspection_date, rent_determined, paperwork checklist)"
```

---

## Task 3: Transition service — capture inspection_date + rent_determined

**Files:**
- Modify: `app/src/services/statusTransition.ts` (the `transitionPlacement` input destructure at ~:273; the capture blocks near the `inspection_outcome` block at ~:301 and the `final_rent` block at ~:339)
- Test: `app/test/statusTransition.test.ts`

**Interfaces:**
- Consumes: `PlacementItem` fields from Task 2.
- Produces: `transitionPlacement` input gains `inspectionDate?: string`, `rentDetermined?: number`. `inspection_date` is written on the `schedule_inspection` exit; `rent_determined` on the `determine_rent` exit.

- [ ] **Step 1: Write the failing tests**

```ts
it('captures inspection_date on schedule_inspection → awaiting_inspection', async () => {
  const svc = makeService(world);
  const c = await world.placementsRepo.create({ tenantId: 't1', unitId: 'u1', stage: 'schedule_inspection' });
  const updated = await svc.transitionPlacement(c.placementId, {
    toStage: 'awaiting_inspection', source: 'manual', inspectionDate: '2026-07-20',
  });
  expect(updated.inspection_date).toBe('2026-07-20');
});

it('captures rent_determined on determine_rent → awaiting_rent_acceptance', async () => {
  const svc = makeService(world);
  const c = await world.placementsRepo.create({ tenantId: 't1', unitId: 'u1', stage: 'determine_rent' });
  const updated = await svc.transitionPlacement(c.placementId, {
    toStage: 'awaiting_rent_acceptance', source: 'manual', rentDetermined: 1850,
  });
  expect(updated.rent_determined).toBe(1850);
});

it('ignores inspectionDate / rentDetermined on an unrelated move', async () => {
  const svc = makeService(world);
  const c = await world.placementsRepo.create({ tenantId: 't1', unitId: 'u1', stage: 'awaiting_hap_contract' });
  const updated = await svc.transitionPlacement(c.placementId, {
    toStage: 'complete_paperwork', source: 'manual', inspectionDate: '2026-07-20', rentDetermined: 1850,
  });
  expect(updated.inspection_date).toBeUndefined();
  expect(updated.rent_determined).toBeUndefined();
});
```

- [ ] **Step 2: Run, watch fail** — `npm test -w @housingchoice/app -- statusTransition` → FAIL (input has no such fields).

- [ ] **Step 3: Implement.** Add the two fields to the input type (`StatusTransitionInput`) and the destructure at ~:273:

```ts
const { toStage, source, reason, lostReason, finalRent, inspectionOutcome, inspectionDate, rentDetermined, actor } = input;
```

After the `inspection_outcome` capture block (~:313), add — mirroring its `from`-gated shape:

```ts
      // Approval & Move-in: the LANDLORD-scheduled inspection date is recorded on
      // the move INTO the inspection wait (OUT of `schedule_inspection`), the same
      // "captured on the relevant move" shape as inspection_outcome/final_rent.
      if (from === 'schedule_inspection' && inspectionDate !== undefined) {
        if (typeof inspectionDate !== 'string' || inspectionDate.length === 0) {
          throw new TransitionRefusedError('bad_inspection_date', 'inspectionDate must be a non-empty date string');
        }
        patch.inspection_date = inspectionDate;
      }
      // The authority's DETERMINED rent is recorded on the move OUT of
      // `determine_rent`. Distinct from final_rent (the ACCEPTED amount written to
      // the unit on the awaiting_rent_acceptance exit, unchanged below).
      if (from === 'determine_rent' && rentDetermined !== undefined) {
        if (!Number.isFinite(rentDetermined) || rentDetermined <= 0) {
          throw new TransitionRefusedError('bad_rent_determined', 'rentDetermined must be a finite number > 0');
        }
        patch.rent_determined = rentDetermined;
      }
```

(These write into the same `patch` object that is applied by `placementsRepo.update(placementId, patch)` at ~:315, so they persist on the same write.)

- [ ] **Step 4: Run, watch pass** — `npm test -w @housingchoice/app -- statusTransition` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/services/statusTransition.ts app/test/statusTransition.test.ts
git commit -m "feat(placements): capture inspection_date + rent_determined at their stage moves"
```

---

## Task 4: Transition route — validate + forward the new inputs

**Files:**
- Modify: `app/src/routes/statusTransition.ts` (the POST `/placements/:placementId/transition` validation block ~:89-149 and the `service.transitionPlacement` call ~:163)
- Test: `app/test/statusTransitionRoutes.test.ts` (the existing route test)

**Interfaces:**
- Consumes: the service input from Task 3.
- Produces: the route accepts `inspectionDate?: string`, `rentDetermined?: number` in the POST body.

- [ ] **Step 1: Write the failing tests** — POST transition with `inspectionDate` on the schedule_inspection→awaiting_inspection move returns 200 and the field persists; a non-numeric `rentDetermined` returns 400 `rentDetermined must be a finite number > 0`; a bad `inspectionDate` (empty) returns 400.

```ts
it('accepts inspectionDate on schedule_inspection → awaiting_inspection', async () => {
  // seed a placement at schedule_inspection via the repo, then:
  const res = await request(app)
    .post(`/api/placements/${id}/transition`)
    .set('Cookie', TEST_SESSION_COOKIE)
    .send({ toStage: 'awaiting_inspection', source: 'manual', inspectionDate: '2026-07-20' });
  expect(res.status).toBe(200);
  expect(res.body.placement.inspection_date).toBe('2026-07-20');
});

it('rejects a non-positive rentDetermined with 400', async () => {
  const res = await request(app)
    .post(`/api/placements/${id}/transition`)
    .set('Cookie', TEST_SESSION_COOKIE)
    .send({ toStage: 'awaiting_rent_acceptance', source: 'manual', rentDetermined: 0 });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run, watch fail** — FAIL (fields ignored / not validated).

- [ ] **Step 3: Implement.** After the `inspectionOutcome` validation block (~:149) add:

```ts
    // inspectionDate (when supplied) must be a non-empty string; the service writes
    // it only on the schedule_inspection exit.
    let inspectionDate: string | undefined;
    if (b['inspectionDate'] !== undefined) {
      if (typeof b['inspectionDate'] !== 'string' || b['inspectionDate'].length === 0) {
        res.status(400).json({ error: 'inspectionDate must be a non-empty date string' });
        return;
      }
      inspectionDate = b['inspectionDate'];
    }
    // rentDetermined (when supplied) must be a finite number > 0 (the authority's
    // determined rent); the service writes it only on the determine_rent exit.
    let rentDetermined: number | undefined;
    if (b['rentDetermined'] !== undefined) {
      if (typeof b['rentDetermined'] !== 'number' || !Number.isFinite(b['rentDetermined']) || b['rentDetermined'] <= 0) {
        res.status(400).json({ error: 'rentDetermined must be a finite number > 0' });
        return;
      }
      rentDetermined = b['rentDetermined'];
    }
```

Then thread them into the `service.transitionPlacement` call (~:163):

```ts
        ...(inspectionDate !== undefined && { inspectionDate }),
        ...(rentDetermined !== undefined && { rentDetermined }),
```

- [ ] **Step 4: Run, watch pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/statusTransition.ts app/test/statusTransitionRoutes.test.ts
git commit -m "feat(api): transition route accepts inspectionDate + rentDetermined"
```

---

## Task 5: PATCH /:placementId — allow the paperwork checklist booleans

**Files:**
- Modify: `app/src/routes/placements.ts` (`validatePlacementUpdate` — the allowlist validator used by `PATCH /:placementId` at ~:668)
- Test: `app/test/placementsRoutes.test.ts` (the existing PATCH test)

**Interfaces:**
- Produces: `PATCH /api/placements/:id` accepts `lease_signed`, `lif`, `move_in_details` booleans (each optional).

- [ ] **Step 1: Write the failing test** — PATCH with `{ lease_signed: true }` returns 200 and persists; PATCH with `{ lease_signed: 'yes' }` returns 400.

```ts
it('PATCH accepts the paperwork checklist booleans', async () => {
  const res = await request(app).patch(`/api/placements/${id}`)
    .set('Cookie', TEST_SESSION_COOKIE).send({ lease_signed: true, move_in_details: true, lif: false });
  expect(res.status).toBe(200);
  expect(res.body.placement.lease_signed).toBe(true);
  expect(res.body.placement.move_in_details).toBe(true);
  expect(res.body.placement.lif).toBe(false);
});
it('PATCH rejects a non-boolean checklist value', async () => {
  const res = await request(app).patch(`/api/placements/${id}`)
    .set('Cookie', TEST_SESSION_COOKIE).send({ lease_signed: 'yes' });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run, watch fail** — FAIL (field rejected as unknown, or silently dropped).

- [ ] **Step 3: Implement.** Read the existing `validatePlacementUpdate` to match its exact allowlist style, then add a boolean branch for each of `lease_signed`, `lif`, `move_in_details` mirroring how an existing boolean/known field is validated (return `{ ok: false, error: '<field> must be a boolean' }` on mismatch; add to the accepted `fields` on success). Follow the file's existing pattern verbatim — do not invent a new validation shape.

- [ ] **Step 4: Run, watch pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/placements.ts app/test/placementsRoutes.test.ts
git commit -m "feat(api): PATCH placement accepts the paperwork checklist booleans"
```

---

## Task 6: Dashboard API client — thread the new fields

**Files:**
- Modify: `dashboard/src/api/*` (the `PlacementItem` type + the `transitionPlacement` input type + the `updatePlacement`/PATCH input type — locate via `grep -rn "inspection_outcome\|transitionPlacement" dashboard/src/api`)
- Test: the api client's existing type/unit test if present; otherwise covered by Task 7/8 component tests.

**Interfaces:**
- Consumes: backend shapes from Tasks 2–5.
- Produces: client `PlacementItem` gains the five fields; `transitionPlacement` input gains `inspectionDate?: string`, `rentDetermined?: number`; the placement PATCH input gains the three booleans.

- [ ] **Step 1:** Add `inspection_date?: string`, `rent_determined?: number`, `lease_signed?: boolean`, `lif?: boolean`, `move_in_details?: boolean` to the client `PlacementItem` type (mirror where `inspection_outcome`/`lease_date` are declared).
- [ ] **Step 2:** Add `inspectionDate?: string` and `rentDetermined?: number` to the `transitionPlacement` input type (mirror `finalRent`/`inspectionOutcome`), and pass them through in the request body.
- [ ] **Step 3:** Ensure the placement PATCH client (`updatePlacement` or equivalent) accepts the three booleans (mirror how it passes other placement fields).
- [ ] **Step 4:** Typecheck — `npm run -w @housingchoice/dashboard typecheck` (or the repo's dashboard typecheck script) → clean.
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/api
git commit -m "feat(dashboard-api): thread approval/move-in placement fields + transition inputs"
```

---

## Task 7: transitionGate + MovePromptModal — inspectionDate, rentDetermined, moveInReady

**Files:**
- Modify: `dashboard/src/routes/placements/transitionGate.ts` (`gateFor(from, to)` + the `TransitionGate` union)
- Modify: `dashboard/src/routes/placements/MovePromptModal.tsx` (+ its `MovePromptResult` type)
- Test: `dashboard/src/routes/placements/transitionGate.test.ts`, `MovePromptModal.test.tsx`

**Interfaces:**
- Consumes: the api input fields from Task 6.
- Produces: `TransitionGate` gains `'inspectionDate' | 'rentDetermined' | 'moveInReady'`. `MovePromptResult` gains `inspectionDate?: string`, `rentDetermined?: number`. `MovePromptModal` gains matching `mode`s. `gateFor` returns the new gates on their moves.

- [ ] **Step 1: Write failing tests** for `gateFor`:

```ts
expect(gateFor('schedule_inspection', 'awaiting_inspection')).toBe('inspectionDate');
expect(gateFor('determine_rent', 'awaiting_rent_acceptance')).toBe('rentDetermined');
expect(gateFor('complete_paperwork', 'awaiting_move_in')).toBe('moveInReady');
// existing gates unchanged:
expect(gateFor('awaiting_inspection', 'determine_rent')).toBe('inspectionOutcome');
expect(gateFor('awaiting_rent_acceptance', 'awaiting_hap_contract')).toBe('finalRent');
```

- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** the three new gates in `gateFor` (guard on the exact `from`+`to` pair) and extend the `TransitionGate` union + `MovePromptResult`. In `MovePromptModal.tsx` add three modes: `inspectionDate` (a `<input type="date">`, returns `{ inspectionDate }`), `rentDetermined` (a money input mirroring the existing `finalRent` mode, returns `{ rentDetermined }`), and `moveInReady` (a confirmation with NO data payload; accepts an optional `lifPending: boolean` prop and, when true, shows "LIF is not marked for a LIF-eligible tenant — proceed anyway?"). Match the existing `finalRent`/`inspectionOutcome` mode markup + a11y (labelled controls, dialog role).
- [ ] **Step 4: Run, watch pass.**
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/placements/transitionGate.ts dashboard/src/routes/placements/MovePromptModal.tsx dashboard/src/routes/placements/transitionGate.test.ts dashboard/src/routes/placements/MovePromptModal.test.tsx
git commit -m "feat(dashboard): move gates for inspection date, determined rent, move-in-ready confirm"
```

---

## Task 8: PlacementDetail — show fields + the paperwork checklist card

**Files:**
- Modify: `dashboard/src/routes/placements/PlacementDetail.tsx`
- Modify: `dashboard/src/routes/placements/PlacementDetail.module.css` (checklist styles)
- Test: `dashboard/src/routes/placements/PlacementDetail.test.tsx`

**Interfaces:**
- Consumes: `gateFor`/`MovePromptModal` (Task 7), api fields (Task 6), `updatePlacement` PATCH (Task 6).

- [ ] **Step 1: Write failing tests** (mirror the existing PlacementDetail test harness):
  - When `placement.inspection_date` / `rent_determined` are present, the Placement card renders "Inspection date" and "Determined rent" KV rows.
  - When `placement.stage === 'complete_paperwork'`, a "Paperwork" checklist renders: `Lease signed` + `Move-in details shared` checkboxes always; the `LIF` checkbox renders ONLY when the loaded tenant's `lifEligible` is true (and shows a "confirm if included" hint), and is absent/N-A otherwise.
  - Toggling a checkbox calls the placement PATCH with the field.
  - Selecting "Awaiting move-in" from the picker at `complete_paperwork` opens the `moveInReady` confirmation (with the LIF-pending note when the tenant is LIF-eligible and `lif` is not set), and confirming runs the transition.

- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement:**
  - Add KV rows after the `Inspection`/`Final rent` rows (~:279-282): `{placement.inspection_date ? <KV k="Inspection date" v={shortDate(placement.inspection_date)} /> : null}` and `{typeof placement.rent_determined === 'number' ? <KV k="Determined rent" v={\`${formatMoney(placement.rent_determined)}/mo\`} /> : null}`.
  - Add a `PaperworkCard` (rendered only when `placement.stage === 'complete_paperwork'`) with the three checkboxes; `lif` row gated on `tenant?.lifEligible === true`. On toggle, call the placement PATCH and update state in place (mirror `setPlacement`).
  - Extend the pending-move modal block (~:299) so the `moveInReady` gate renders `MovePromptModal mode="moveInReady"` with `lifPending={tenant?.lifEligible === true && placement.lif !== true}`; on confirm, `runTransition(pending.toStage, {})`.
  - Keep "Mark moved in" as the existing picker → `moved_in` (no new control needed; the derivations already fire server-side).
- [ ] **Step 4: Run, watch pass** — component tests green; `npm run -w @housingchoice/dashboard typecheck` clean.
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/placements/PlacementDetail.tsx dashboard/src/routes/placements/PlacementDetail.module.css dashboard/src/routes/placements/PlacementDetail.test.tsx
git commit -m "feat(dashboard): PlacementDetail shows inspection date + determined rent + paperwork checklist"
```

---

## Task 9: e2e step-library verbs

**Files:**
- Modify: `e2e/scenarios/steps.ts`
- (No standalone test — exercised by Task 10.)

**Interfaces:**
- Consumes: the built backend + UI. Reuses the existing `teamMovesPlacementTo`, `expectPlacementStage`, `expectPlacementLost`, `expectTenantSearching`, relay-close verbs, and the Post-Tour conversion helper (`teamConvertsTourToPlacement`) + PTA stage-walk to REACH `awaiting_authority_approval`.
- Produces new verbs (accessibility-first selectors; drive the real UI for Team actions, API for setup/reads):
  - `teamMovesPlacementToWithInspectionDate(date)` — pick `Awaiting inspection`, fill the date modal, confirm.
  - `teamRecordsInspectionOutcome('pass'|'fail')` — the move to `Determine rent` (pass) via the existing inspectionOutcome modal, or the fail path.
  - `teamMovesPlacementToWithRentDetermined(amount)` — pick `Awaiting rent acceptance`, fill the determined-rent modal.
  - `teamAcceptsRent(finalAmount)` — the move to `Awaiting HAP contract` via the existing finalRent modal.
  - `teamTicksPaperwork('lease'|'moveInDetails'|'lif')` — toggle a checklist checkbox on PlacementDetail.
  - `teamConfirmsMoveInReady()` — pick `Awaiting move-in`, confirm the readiness modal.
  - `expectInspectionDateShown(date)`, `expectDeterminedRentShown(amount)`, `expectFinalRentShown(amount)`, `expectPaperworkChecklist({ lif: boolean })`, `expectPropertyFinalizing(unit)`, `expectPropertyOccupied(unit)`, `expectTenantPlaced(tenant)` — scoped rendered assertions + API read-backs.

- [ ] **Step 1:** Add the verbs, matching the existing `Scenario` class idioms (scoped `getByRole`/`getByLabel`, `NEXT` base URL, `this.page.request` for API reads, `step(...)` wrappers). Reuse `expectPlacementStage` for un-gated moves.
- [ ] **Step 2:** Typecheck the e2e workspace clean.
- [ ] **Step 3: Commit**

```bash
git add e2e/scenarios/steps.ts
git commit -m "test(e2e): approval-and-move-in step verbs"
```

---

## Task 10: e2e conformance suite

**Files:**
- Create: `e2e/tests/scenarios/approval-and-move-in.spec.ts`
- (Reference template: `e2e/tests/scenarios/post-tour-application.spec.ts`.)

**Interfaces:**
- Consumes: all Task 9 verbs + the existing conversion/stage helpers.

- [ ] **Step 1: Write the happy-path test** (`test.slow()`): reach `awaiting_authority_approval` (reuse the PTA conversion + stage-walk helpers, or seed a placement at that stage via authenticated `page.request`), then walk EVERY stage in order to `moved_in`, asserting each stamped transition and:
  - inspection date recorded + rendered; `pass` recorded; determined rent recorded + rendered; `final_rent` written to the unit + rendered; property reads `Finalizing` at the HAP-contract stage.
  - at `complete_paperwork`: tick lease + move-in details; for a **LIF-eligible** tenant the LIF checkbox shows and the readiness confirm notes unconfirmed LIF; confirm readiness → `awaiting_move_in`.
  - move-in → `moved_in`; tenant reads `Placed`, property reads `Occupied`.
- [ ] **Step 2: Write the marked-deviation tests:**
  - **Inspection fails:** record `fail` on the `awaiting_inspection` exit; assert the exit (Lost with `landlord_lost_inspection`, or the fail outcome + re-inspect back to `schedule_inspection` — assert whichever the diagram's marked exit encodes; the writeup says re-inspect OR Lost, so assert the Lost exit for a deterministic test).
  - **Landlord rejects rent:** at `awaiting_rent_acceptance` → Lost with `landlord_lost_rent`; assert `final_rent` is NOT written to the unit.
  - **Backout mid-window:** Lost from a mid-window stage → tenant `Searching`, property `Available`, relay closed.
  - **LIF non-eligible branch:** a non-LIF-eligible tenant advances through `complete_paperwork` with the LIF checkbox absent and the readiness confirm not flagging LIF.
- [ ] **Step 3: Go green** (inner loop): `npm run e2e:session` + `npm run e2e -w @housingchoice/e2e -- --grep "approval"`; after backend changes `npm run e2e:restart`.
- [ ] **Step 4: Commit**

```bash
git add e2e/tests/scenarios/approval-and-move-in.spec.ts
git commit -m "test(e2e): approval-and-move-in scenario suite — full stage walk + marked deviations"
```

---

## Task 11: Full gate + branch hygiene

**Files:** none (verification).

- [ ] **Step 1:** Sync latest `main` into the branch (`git merge main`), resolve conflicts keeping both sides' intent.
- [ ] **Step 2:** Full backend + dashboard suites: `npm test` (all workspaces) → EXIT 0.
- [ ] **Step 3:** FULL e2e twice on a quiet lane: `npm run e2e:stop; npm run e2e` → all passed, EXIT 0, 0 flaky (re-run once to confirm stability). Never pipe through `tail`.
- [ ] **Step 4:** Report green + the marked-deviation/gap coverage. **Do NOT merge — that is the human's call.** Post-merge (human-run) follow-ups: none infra (no schema/tf change); stamp this plan + the design spec HISTORICAL after merge.

---

## Self-Review (author checklist)

1. **Spec coverage:** every design-doc "gap to build" maps to a task — inspection date (T2/T3/T4/T7/T8), determined rent (T2/T3/T4/T7/T8), checklist + confirmation gate (T2/T5/T6/T7/T8), dashboard walk (T8), "mark moved in" (existing picker, confirmed in T1/T8/T10). Marked deviations → T10. Audit gate → T1.
2. **No placeholders:** backend tasks carry concrete code (read from the live files); frontend/e2e tasks name exact files + the pattern to mirror (the existing `finalRent`/`inspectionOutcome` gate is the verbatim precedent). Task 5 defers to the file's existing validator shape by design (mirror, don't invent).
3. **Type consistency:** field names are identical across tasks — snake_case on the wire/repo (`inspection_date`, `rent_determined`, `lease_signed`, `lif`, `move_in_details`), camelCase transition inputs (`inspectionDate`, `rentDetermined`); gates `'inspectionDate' | 'rentDetermined' | 'moveInReady'`.
