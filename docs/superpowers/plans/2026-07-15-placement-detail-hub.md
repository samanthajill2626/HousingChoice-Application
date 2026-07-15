# Placement Detail Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remake /placements/:placementId into a two-pane info + communications hub mirroring the tour detail page, per the approved spec `docs/superpowers/specs/2026-07-15-placement-detail-hub-design.md` (read it FIRST - it is the contract; this plan is the sequence).

**Architecture:** Reuse the shared twoPaneShell + tour-page patterns (channel pill rail, lazy transcripts, consent gate, dueAt-anchored self-refetch). New backend surface is ONLY nudge list + cancel/restore, mirroring the tour-reminder endpoints. A static 18-stage descriptor map drives the new Now card.

**Tech Stack:** Express + DynamoDB (app), React 19 + vitest/RTL (dashboard), Playwright (e2e). No new dependencies.

## Global Constraints

- Worktree: `git worktree add w:/tmp/placement-hub -b feat/placement-detail-hub main` then `npm install` there. NEVER move HEAD in the primary repo.
- Gates run BARE (never piped) from the WORKTREE ROOT: `npm run typecheck` + `npm test` + `npm run e2e`. cd + pwd explicitly on every shell command.
- Playwright/e2e commands ONLY from the e2e/ workspace dir or via root npm scripts - a stray playwright run from elsewhere hits the founder's LIVE :5174 stack.
- Staff-facing copy says "property" (never "unit"), plain-hyphen punctuation, plain ASCII in all new copy.
- CSS: tokens only (var(--...)), CSS modules, no hard-coded colors. Mobile: everything new must behave at the twoPaneShell 860px breakpoint (spec section 7).
- Tests: accessibility-first selectors (getByRole/getByLabel). vitest footgun: file-level clearAllMocks does NOT clear mockResolvedValueOnce queues - use mockReset when reusing mocks across tests.
- Dashboard API client (`dashboard/src/api/client.ts`) serializes `body` itself - pass objects, never JSON.stringify.
- Sub-agents (if orchestrating): pass an explicit model, default opus. Never Fable silently.
- Templates: when a task says "mirror <file>", READ that file completely first and copy its idioms (comment density, error taxonomy, test structure).

---

### Task 0: Worktree + baseline

**Files:** none (setup)

- [ ] `cd /w/tmp && git -C "/w/AI Projects/Housing Choice/HC Application" worktree add /w/tmp/placement-hub -b feat/placement-detail-hub main`
- [ ] `cd /w/tmp/placement-hub && pwd && npm install`
- [ ] Baseline gates BARE: `npm run typecheck` then `npm test`. Expected: green (if red, STOP - report, do not build on a red base).
- [ ] Read the spec + these templates end-to-end: `app/src/routes/tourReminders.ts`, `app/src/repos/tourRemindersRepo.ts`, `app/src/jobs/placementNudges.ts`, `app/src/repos/placementNudgesRepo.ts`, `dashboard/src/routes/tours/TourDetail.tsx`, `TourConversation.tsx`, `useTourChannels.ts`, `RemindersPanel.tsx`, `dashboard/src/routes/placements/PlacementDetail.tsx`.

### Task 1: Repo - nudge listByPlacement + cancel/uncancel

**Files:**
- Modify: `app/src/repos/placementNudgesRepo.ts`
- Test: `app/test/placementNudgesRepo.test.ts` (extend existing repo tests if present; else create)

**Interfaces:**
- Consumes: existing `placementNudges` table shape `{nudgeId, placementId, kind, dueAt, sentAt?, canceledAt?}`, byPlacement GSI, existing claim-before-send helpers.
- Produces (later tasks rely on these exact names):
  - `listByPlacement(placementId: string): Promise<PlacementNudgeItem[]>`
  - `cancel(nudgeId: string, canceledAt: string): Promise<boolean>`
  - `uncancel(nudgeId: string): Promise<boolean>`

- [ ] **Step 1: Failing tests.** Mirror `app/test` coverage of tourRemindersRepo cancel/uncancel: cancel succeeds on a pending row; cancel returns false when sentAt already set (lost race) and when already canceled; uncancel removes canceledAt only when present and never resurrects a sent row; listByPlacement returns only that placement's rows.
- [ ] **Step 2: Run to verify FAIL** (`cd /w/tmp/placement-hub && npm test --workspace app -- placementNudgesRepo`).
- [ ] **Step 3: Implement.** Copy the conditional-write idiom from `tourRemindersRepo.cancel/uncancel` verbatim, renamed to nudge fields: cancel = UpdateCommand SET canceledAt with `attribute_not_exists(sentAt) AND attribute_not_exists(canceledAt)`; uncancel = REMOVE canceledAt with `attribute_exists(canceledAt) AND attribute_not_exists(sentAt)`; ConditionalCheckFailedException -> return false.
- [ ] **Step 4: Run to PASS.**
- [ ] **Step 5: Commit** (explicit paths, gating `git status` first).

### Task 2: Routes - GET nudges + PATCH cancel/restore

**Files:**
- Modify: `app/src/routes/placements.ts` (or a sibling `placementNudges` router if placements.ts is unwieldy - follow how tourReminders.ts is mounted), `app/src/routes/api.ts` (deps forwarding)
- Test: `app/test/placementNudgesApi.test.ts`

**Interfaces:**
- Consumes: Task 1 repo functions; `events.emit('scheduled.updated', {contactId})`; unitsRepo (landlord resolution).
- Produces (dashboard relies on these exact shapes):
  - `GET /api/placements/:placementId/nudges` -> 200 `{nudges: PlacementNudgeView[]}` sorted dueAt descending; 404 `placement_not_found`.
  - `PATCH /api/placements/:placementId/nudges/:nudgeId` body `{canceled: boolean}` -> 200 `{nudge}`; 400 non-boolean; 404 unknown placement / nudge-not-of-this-placement; 409 `{error: 'nudge_not_cancelable' | 'nudge_not_restorable', nudge}` with the honestly re-read row.
  - `PlacementNudgeView = {nudgeId, placementId, kind, recipient: 'tenant'|'landlord', dueAt, state: 'upcoming'|'sent'|'canceled', sentAt?, canceledAt?}`. recipient derives from kind: approval_check + rta_window_closing -> landlord, else tenant (matches NUDGE_RUNGS routing in `app/src/jobs/placementNudges.ts` - verify there, do not trust this line).

- [ ] **Step 1: Failing tests.** Mirror `app/test/tourRemindersApi.test.ts` case-for-case: cancel happy path (200 + canceledAt + scheduled.updated emitted), restore happy path, 409 lost-race (pre-stamp sentAt), 400/404 taxonomy, GET returns views with recipient mapping.
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement.** Mirror `app/src/routes/tourReminders.ts` PATCH structure. scheduled.updated emit keys on the RECIPIENT's contactId: tenant kinds -> placement.tenantId; landlord kinds -> unit.landlordId (best-effort lookup; if unresolvable, emit with tenantId - the dashboard panels refetch on any scheduled.updated anyway).
- [ ] **Step 4: Run to PASS**, then `npm run typecheck` BARE.
- [ ] **Step 5: Commit.**

### Task 3: Dashboard API bindings + types

**Files:**
- Modify: `dashboard/src/api/endpoints.ts`, `dashboard/src/api/types.ts` (mirror PlacementNudgeView; add relay/deadline response types)
- Test: colocated endpoint tests if the repo has them; otherwise covered by consumer tests in Tasks 6-8.

**Interfaces:**
- Consumes: Task 2 routes; existing `POST /api/placements/:id/relay` (409 relay_exists, 503 relay_pool_unavailable/kill-switch) and `POST /api/placements/:id/deadline` (`{type:'follow_up', at}` | `{clear:true}`).
- Produces (exact client names used by Tasks 5-8):
  - `getPlacementNudges(placementId, signal?): Promise<PlacementNudgeView[]>` (unwraps `{nudges}`)
  - `patchPlacementNudge(placementId, nudgeId, canceled: boolean): Promise<PlacementNudgeView>` (body `{canceled}` - the client serializes)
  - `provisionPlacementRelay(placementId): Promise<{conversationId: string}>` (verify the route's actual response shape in placements.ts and unwrap accordingly)
  - `setPlacementFollowUp(placementId, at: string): Promise<void>` and `clearPlacementFollowUp(placementId): Promise<void>`

- [ ] Steps: write bindings mirroring `getTourReminders`/`patchTourReminder` in the same file; `npm run typecheck` BARE; commit.

### Task 4: Date vocabulary formatters

**Files:**
- Modify: `dashboard/src/routes/placements/placementsFormat.ts`
- Test: `dashboard/src/routes/placements/placementsFormat.test.ts` (extend)

**Interfaces:**
- Produces: `scheduledFor(iso)`, `expiresOn(iso)`, `closesAt(iso)`, `sinceWhen(iso)`, `wasDue(iso)` - each returns the full verb phrase per spec section 6 (e.g. `scheduledFor` -> "scheduled for Thu Jul 17, 10am (in 2 days)"). Automated sends REUSE the existing shared `sendRelative` ("sends in Nh") - do not duplicate it.

- [ ] **Step 1: Failing tests** with fixed `now` injection (every formatter takes an explicit `now: number` param or uses the file's existing now-injection idiom - check first): future, past-relative, and boundary (under 1h, under 1 day, multi-day) cases per formatter.
- [ ] **Step 2: FAIL. Step 3: Implement (compose from the file's existing date helpers - DRY). Step 4: PASS. Step 5: Commit.**

### Task 5: Stage descriptor map

**Files:**
- Create: `dashboard/src/routes/placements/stageDescriptors.ts`
- Test: `dashboard/src/routes/placements/stageDescriptors.test.ts`

**Interfaces:**
- Consumes: the dashboard's existing stage/phase constants (find where PlacementDetail/pageModel get stage labels - reuse, do not redeclare the ladder).
- Produces:
```ts
export type StageRecordKind = 'none' | 'inspection_date' | 'inspection_review' | 'rent_determined' | 'accepted_rent' | 'paperwork';
export interface StageDescriptor {
  gate: { kind: 'us'; move: string } | { kind: 'them'; waitingOn: string } | { kind: 'terminal' };
  record: StageRecordKind;
  // date the gate line shows, resolved by the Now card:
  gateDate: 'none' | 'inspection_date' | 'move_in_date' | 'stage_entered_at';
}
export const STAGE_DESCRIPTORS: Record<PlacementStage, StageDescriptor>;
```
- The copy (names interpolated by the Now card, ASCII, staff-facing):

| stage | gate | waitingOn / move | record | gateDate |
|---|---|---|---|---|
| send_application | us | Send the application packet to {tenant} | none | none |
| awaiting_receipt | them | {tenant} to confirm receipt of the application | none | stage_entered_at |
| awaiting_completion | them | {tenant} to complete the application | none | stage_entered_at |
| awaiting_approval | them | {landlord} to approve the application | none | stage_entered_at |
| collect_rta | us | Collect the RTA from {tenant} | none | none |
| review_rta | us | Review the RTA | none | none |
| send_rta_to_landlord | us | Send the RTA to {landlord} | none | none |
| awaiting_landlord_submission | them | {landlord} to submit the RTA to the housing authority | none | stage_entered_at |
| awaiting_authority_approval | them | the housing authority to approve the RTA | none | stage_entered_at |
| schedule_inspection | us | Schedule the inspection | inspection_date | none |
| awaiting_inspection | them | the housing authority inspection | inspection_review | inspection_date |
| determine_rent | them | the housing authority to determine rent | rent_determined | stage_entered_at |
| awaiting_rent_acceptance | them | {landlord} to accept the determined rent | accepted_rent | stage_entered_at |
| awaiting_hap_contract | them | the housing authority HAP contract | none | stage_entered_at |
| complete_paperwork | us | Finish the closing checklist | paperwork | none |
| awaiting_move_in | them | move-in day | none | stage_entered_at |
| moved_in | terminal | - | none | none |
| lost | terminal | - | none | none |

- [ ] **Step 1: Failing completeness test**: `Object.keys(STAGE_DESCRIPTORS)` set-equals the full stage ladder; every 'them' gate has non-empty waitingOn; recording stages match today's StageDataCard/PaperworkCard set (the five above).
- [ ] **Steps 2-5: FAIL -> implement the table -> PASS -> commit.**

### Task 6: usePlacementChannels + PlacementConversation

**Files:**
- Create: `dashboard/src/routes/placements/usePlacementChannels.ts`, `dashboard/src/routes/placements/PlacementConversation.tsx`
- Test: `dashboard/src/routes/placements/usePlacementChannels.test.tsx`, behavior covered further in Task 7's page tests
- Modify: none yet (wired in Task 7)

**Interfaces:**
- Consumes: `useTourChannels.ts` + `TourConversation.tsx` as line-for-line templates; `placement.group_thread`, `placement.tenantId`, `unit.landlordId`; Task 3's `provisionPlacementRelay`.
- Produces: `usePlacementChannels(placement, landlordId)` returning the same channel-state shape as useTourChannels (group/tenant/landlord, unread, markRead, setConversationId); `<PlacementConversation placement unit tenant landlord channels onConsentRefused/>` mirroring TourConversation's props pattern.

- [ ] **Step 1: Failing hook tests** mirroring useTourChannels.test.tsx: group from group_thread, tenant/landlord resolved to most-recent non-relay 1:1, setConversationId injection survives refetch.
- [ ] **Step 2-4: FAIL -> implement as mirrors -> PASS.** Differences from the tour versions, and ONLY these: channel source fields (group_thread), no pm_team label branch (labels: "Group text" / "Tenant - {first}" / "Landlord - {first}"), group empty-state button calls provisionPlacementRelay then setConversationId('group', id). Everything else (lazy single mount, remount on switch, per-tab markRead, unread dots, consent-refusal bubble-up) copies the template.
- [ ] **Step 5: Commit.**

### Task 7: Page rebuild - twoPaneShell, header, right-pane assembly

**Files:**
- Modify: `dashboard/src/routes/placements/PlacementDetail.tsx` (+ its module CSS), keeping HistoryPanel/modals/transitionGate imports
- Test: `dashboard/src/routes/placements/PlacementDetail.test.tsx` (extend the existing suite - keep every currently-green assertion alive or consciously rewrite it)

**Interfaces:**
- Consumes: `dashboard/src/ui/twoPaneShell.module.css` (compose, do not fork), TourDetail.tsx as the structural template, Task 5 descriptors (next-stage lookup for the CTA label), Task 6 conversation, existing requestMove/gateFor pipeline + StatusMenu + modals.
- Produces: header CTA `Advance to {nextStageLabel}` calling `requestMove(nextStage)` (existing gates fire untouched); kebab menu (mirror TourActionsMenu popover) = Move to... (existing StatusMenu content), Mark lost, Open group text (hidden when group_thread set), Set follow-up (opens Task 8's modal); facts line via Task 4 vocabulary; mobile segmented toggle defaulting to Details.

- [ ] **Step 1: Failing tests**: header renders title + stage pill + facts line; CTA label = next ladder stage and absent at moved_in/lost; kebab exposes the four actions with correct gating; mobile toggle switches panes (match TourDetail.test.tsx's pattern).
- [ ] **Step 2-4: FAIL -> rebuild the page -> PASS.** Right pane order: NowCard placeholder slot (Task 9), DeadlinesNudges placeholder slot (Task 8), People and provenance card (tenant/landlord/property Links + "converted from tour toured {date} ->" via fromTourId when present), Placement facts (today's read-only fields reworded with Task 4 vocabulary), HistoryPanel. Placeholders = render nothing yet, NOT dummy cards.
- [ ] **Step 5: BARE typecheck + dashboard suite. Commit.**

### Task 8: Deadlines and nudges card

**Files:**
- Create: `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx` (+ module CSS), follow-up modal (inline or `FollowUpModal.tsx` per TourModals.tsx's DateTimeModal-wrapping pattern)
- Test: `dashboard/src/routes/placements/DeadlinesNudgesCard.test.tsx`
- Modify: `PlacementDetail.tsx` (fill the slot)

**Interfaces:**
- Consumes: Task 3 bindings; `RemindersPanel.tsx` as the template - REUSE its exported `nextReminderRefetchDelay` for the dueAt-anchored self-refetch (import it; do not copy).
- Produces: `<DeadlinesNudgesCard placementId tenantName landlordName />` - deadlines block (voucher expiration + RTA window read-only via Task 4 vocabulary; follow-up row with Set/Change/Clear) + nudges block (rows with kind label, recipient, "sends ..." chip, Cancel/Restore buttons, busyId single-flight, 409 -> silent refetch).

- [ ] **Step 1: Failing tests** mirroring RemindersPanel.test.tsx: rows render states; Cancel PATCHes {canceled:true} then refetches; Restore likewise; busy disables both; scheduled.updated triggers refetch; UI copy includes the re-arm caveat ("A stage move re-arms this stage's nudge").
- [ ] **Step 2-4: FAIL -> implement -> PASS. Step 5: Commit.**

### Task 9: Now card

**Files:**
- Create: `dashboard/src/routes/placements/PlacementNowCard.tsx` (+ module CSS)
- Test: `dashboard/src/routes/placements/PlacementNowCard.test.tsx`
- Modify: `PlacementDetail.tsx` (fill the slot; DELETE the now-absorbed StageDataCard + PaperworkCard render paths and migrate their tests)

**Interfaces:**
- Consumes: Task 5 descriptors, Task 4 formatters, Task 8's nudge data (lift the nudges fetch into PlacementDetail or a small shared hook so NowCard's safety-net line and DeadlinesNudgesCard share ONE fetch - do not fetch twice), existing StageDataCard/PaperworkCard recorder logic (move, do not rewrite).
- Produces: `<PlacementNowCard placement unit tenant landlord nudges onAdvance />` rendering the spec's 5-part anatomy; gate line amber for 'them' / blue accent for 'us' (tokens only); "Record: nothing at this stage" when record === 'none'; missing expected gate date renders "no date recorded".

- [ ] **Step 1: Failing tests** for the three shapes: waiting stage (awaiting_inspection with and without inspection_date), our-move stage (send_application), recording stage (complete_paperwork checklist incl. LIF gating on tenant.lifEligible); terminal stages render completed/lost summary and NO Advance.
- [ ] **Step 2-4: FAIL -> implement -> PASS. Step 5: Commit.** Then run the FULL dashboard suite BARE - the StageDataCard/PaperworkCard migration must leave zero orphaned tests.

### Task 10: E2e + mobile pass + full gates

**Files:**
- Modify: `e2e/tests/dashboard-next/placements*.spec.ts` (find the exact spec name), `e2e/scenarios/steps.ts` (new steps only if the vocabulary lacks them)

- [ ] **Step 1: Extend the e2e scenario:** from a seeded placement - open group text from the empty state (button disappears, thread mounts); advance a stage via the header CTA through a gate modal; armed nudge visible in the Deadlines and nudges card AND in the tenant 1:1 Upcoming bucket; cancel then restore it. Accessibility-first selectors.
- [ ] **Step 2: Full gates BARE from the worktree root:** `npm run typecheck`, `npm test`, `npm run e2e`. All green on the CURRENT base.
- [ ] **Step 3: Live QA on a hermetic lane** (`npm run e2e:session`, reseed profile=full, dev-login again after reseed): walk the page desktop-width, then `browser_resize` to phone width (390x844) and verify spec section 7 - header wraps with long stage names (put the placement in awaiting_landlord_submission), no horizontal scroll, pill rail scrolls, Now card lines wrap. Screenshots into .playwright-mcp/.
- [ ] **Step 4: Commit any fixes; final gates if anything changed. Report with a where-to-test list.** Do NOT merge to main - the founder merges.

---

## Task order and review gates

Tasks 1-2 (backend) -> 3-5 (pure dashboard logic, parallelizable) -> 6 -> 7 -> 8 -> 9 -> 10. Review gate after 2 (API contract), after 7 (page skeleton), after 9 (feature-complete), after 10 (done). If any template file diverges from what a task asserts about it, TRUST THE FILE and adapt - note the divergence in the commit message.
