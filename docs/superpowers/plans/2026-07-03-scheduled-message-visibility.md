# Scheduled-message Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scheduled outbound SMS visible before it fires — a tour Reminders panel (Part A) and future/scheduled items in the contact's 1:1 comms timeline (Part B), with honest suppression and live transitions.

**Architecture:** Two durable scheduled-send sources (tour reminders, placement nudges) are exposed via new read paths. Part A adds `GET /api/tours/:id/reminders` + a panel. Part B adds a `kind:'scheduled'` timeline member returned in a separate first-page-only `upcoming[]` envelope bucket (a future `dueAt` would corrupt the DESC-take-limit pagination if interleaved). A shared pure suppression evaluator keeps preview and real send honest. One new `scheduled.updated` SSE event drives live arm/reschedule/cancel updates; future→sent already refetches on `message.persisted`.

**Tech Stack:** TypeScript, Node 24, Express, DynamoDB (Local for dev/e2e), Vitest, React (dashboard), Playwright (e2e).

## Global Constraints

- **Sub-agent model:** default `opus`; `sonnet` only for trivial mechanical sweeps; Fable only on deliberate high-value call (per CLAUDE.md).
- **Terminology:** the leased dwelling is `unit` in code; human copy uses "home" (tenant) / "property" (landlord+staff). Don't rename.
- **No new tables/GSIs / no Terraform.** All reads reuse existing indexes: `tourRemindersRepo.listByTour` (`byTour`), `placementNudgesRepo.listByPlacement` (`byPlacement`), `toursRepo.listByTenant` (`byTenant`), `unitsRepo.listByLandlord` (`byLandlord`), `placementsRepo.listByUnit` / `listByTenant`.
- **PII:** SSE payloads and logs carry IDs/counts only — never bodies or phones.
- **Bodies are canned per-`kind`/`stage` templates** (`REMINDER_BODIES` `jobs/tourReminders.ts:48`, `NUDGE_RUNGS[stage].body` `jobs/placementNudges.ts:56`) — preview renders them verbatim (faithful).
- **TDD, DRY, YAGNI, frequent commits.** Every task ends green (`npm run typecheck` + the task's tests).
- **Branch:** `feat/scheduled-message-visibility`, worktree `w:/tmp/sched-msg-visibility`. Commit after each task.
- **Test commands:** app unit — `npm run test -w app`; dashboard unit — `npm run test -w dashboard`; typecheck — `npm run typecheck`; e2e — `npm run e2e` (needs Docker; hermetic stack).

---

## File Structure

**New files:**
- `app/src/services/scheduledSendSuppression.ts` — pure suppression predicates + `evaluateScheduledSendSuppression`.
- `app/src/services/scheduledSendSuppression.test.ts` — its unit tests + the M1 sendMessage regression tests.
- `app/src/routes/tourReminders.ts` — `GET /api/tours/:id/reminders` router + `TourReminderView` mapping.
- `app/src/routes/tourReminders.test.ts`.
- `dashboard/src/routes/tours/RemindersPanel.tsx` — Part A panel.
- `dashboard/src/routes/contact/ScheduledCard.tsx` — Part B pinned-section item.

**Modified files:**
- `app/src/services/sendMessage.ts` — call the extracted predicates at existing gate positions (no reorder).
- `app/src/jobs/tourReminders.ts` — export `resolveUsableGroup`.
- `app/src/routes/contactTimeline.ts` — `TimelineScheduled` union member + gather + `upcoming[]` envelope.
- `app/src/routes/contactTimeline.test.ts` — gather tests.
- `app/src/lib/events.ts` — `scheduled.updated` in `AppEventMap` + payload type.
- `app/src/routes/api.ts` — SSE subscribe/off for `scheduled.updated`; wire `events` into nudge arm hook (`~L517`); mount tourReminders router.
- `app/src/routes/tours.ts` — emit `scheduled.updated` at arm/cancel sites (~L210/452/461).
- `app/src/jobs/placementNudges.ts` — emit `scheduled.updated` from `armNudgeForStage`/`cancelForPlacement` (accept `events` dep).
- `dashboard/src/api/types.ts` — `TimelineScheduled`, `upcoming?` on `ContactTimelinePage`, `TourReminderView`, `onScheduledUpdated` handler type.
- `dashboard/src/api/client.ts` (or the fetchers module) — `getTourReminders`.
- `dashboard/src/api/EventStreamProvider.tsx` — `scheduled.updated` listener + handler.
- `dashboard/src/routes/contact/useContactTimeline.ts` — thread `upcoming`; wire `onScheduledUpdated`.
- `dashboard/src/routes/contact/Timeline.tsx` — pinned "Upcoming" section; defensive switch case.
- `dashboard/src/routes/tours/TourDetail.tsx` — mount `RemindersPanel`.
- `e2e/scenarios/steps.ts` + `e2e/tests/scenarios/*.spec.ts` — new verbs + specs.

---

## Task 1: Shared suppression evaluator + sendMessage predicate extraction

**Files:**
- Create: `app/src/services/scheduledSendSuppression.ts`
- Create: `app/src/services/scheduledSendSuppression.test.ts`
- Modify: `app/src/services/sendMessage.ts:216-261`

**Interfaces:**
- Produces:
  ```ts
  // scheduledSendSuppression.ts
  export type ScheduledSuppressionReason =
    | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage';
  export interface ScheduledSuppression { reason: ScheduledSuppressionReason; }

  // pure predicates (no I/O, no logging) — sendMessage calls these at its existing gate positions
  export function isKillSwitchOff(smsSendingEnabled: boolean | undefined): boolean; // true ⇒ suppress
  export function isOptedOut(convOptOut: boolean | undefined, contactOptOut: boolean | undefined): boolean;
  export function isManualMode(aiMode: string | undefined): boolean;

  // preview composer — evaluates the read-only gates in precedence order
  export function evaluateScheduledSendSuppression(input: {
    smsSendingEnabled: boolean | undefined;
    convOptOut: boolean | undefined;
    contactOptOut: boolean | undefined;
    aiMode: string | undefined;
    staleStage?: boolean; // nudge-only: placement.stage !== STAGE_BY_KIND[kind]
  }): ScheduledSuppression | undefined;
  ```
- Consumes (later tasks): Task 2 (tour endpoint) and Task 4 (gather) call `evaluateScheduledSendSuppression`.

- [ ] **Step 1: Write the failing test** — `app/src/services/scheduledSendSuppression.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { evaluateScheduledSendSuppression, isKillSwitchOff, isOptedOut, isManualMode } from './scheduledSendSuppression.js';

describe('suppression predicates', () => {
  it('kill switch: only explicit false suppresses', () => {
    expect(isKillSwitchOff(false)).toBe(true);
    expect(isKillSwitchOff(true)).toBe(false);
    expect(isKillSwitchOff(undefined)).toBe(false); // absent ⇒ enabled (mirrors sendMessage === false)
  });
  it('opt-out: either flag suppresses', () => {
    expect(isOptedOut(true, false)).toBe(true);
    expect(isOptedOut(false, true)).toBe(true);
    expect(isOptedOut(false, false)).toBe(false);
    expect(isOptedOut(undefined, undefined)).toBe(false);
  });
  it('manual mode', () => {
    expect(isManualMode('manual')).toBe(true);
    expect(isManualMode('auto')).toBe(false);
    expect(isManualMode(undefined)).toBe(false);
  });
});

describe('evaluateScheduledSendSuppression precedence', () => {
  const base = { smsSendingEnabled: true, convOptOut: false, contactOptOut: false, aiMode: 'auto' as string | undefined };
  it('returns undefined when nothing suppresses', () => {
    expect(evaluateScheduledSendSuppression(base)).toBeUndefined();
  });
  it('kill switch wins first', () => {
    expect(evaluateScheduledSendSuppression({ ...base, smsSendingEnabled: false, convOptOut: true }))
      .toEqual({ reason: 'sms_sending_disabled' });
  });
  it('opt-out before manual', () => {
    expect(evaluateScheduledSendSuppression({ ...base, contactOptOut: true, aiMode: 'manual' }))
      .toEqual({ reason: 'contact_opted_out' });
  });
  it('manual mode', () => {
    expect(evaluateScheduledSendSuppression({ ...base, aiMode: 'manual' })).toEqual({ reason: 'manual_mode' });
  });
  it('stale stage (nudge)', () => {
    expect(evaluateScheduledSendSuppression({ ...base, staleStage: true })).toEqual({ reason: 'stale_stage' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm run test -w app -- scheduledSendSuppression` → FAIL (module not found).

- [ ] **Step 3: Implement `scheduledSendSuppression.ts`**

```ts
export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage';
export interface ScheduledSuppression { reason: ScheduledSuppressionReason; }

/** kill-switch is off only on an explicit `false` (mirrors sendMessage's `=== false`). */
export function isKillSwitchOff(smsSendingEnabled: boolean | undefined): boolean {
  return smsSendingEnabled === false;
}
export function isOptedOut(convOptOut: boolean | undefined, contactOptOut: boolean | undefined): boolean {
  return convOptOut === true || contactOptOut === true;
}
export function isManualMode(aiMode: string | undefined): boolean {
  return aiMode === 'manual';
}

/** Read-only preview of whether a scheduled (automated) send will be suppressed.
 *  Precedence matches sendMessage's gate order: kill-switch → opt-out → manual.
 *  stale_stage is nudge-only and lowest precedence (the send would be retired unsent).
 *  Deliberately omits JIT-consent (never applies to automated) and live-breaker (unevaluable). */
export function evaluateScheduledSendSuppression(input: {
  smsSendingEnabled: boolean | undefined;
  convOptOut: boolean | undefined;
  contactOptOut: boolean | undefined;
  aiMode: string | undefined;
  staleStage?: boolean;
}): ScheduledSuppression | undefined {
  if (isKillSwitchOff(input.smsSendingEnabled)) return { reason: 'sms_sending_disabled' };
  if (isOptedOut(input.convOptOut, input.contactOptOut)) return { reason: 'contact_opted_out' };
  if (isManualMode(input.aiMode)) return { reason: 'manual_mode' };
  if (input.staleStage === true) return { reason: 'stale_stage' };
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npm run test -w app -- scheduledSendSuppression` → PASS.

- [ ] **Step 5: Refactor `sendMessage.ts` to call the predicates AT THEIR EXISTING POSITIONS**

Replace the inline boolean expressions ONLY — do NOT move, merge, or reorder the gates, and keep every `log.warn`/`log.error`, `if (automated)` guard, and distinct throw exactly where they are:
- `sendMessage.ts:216` → `if (isKillSwitchOff(config.smsSendingEnabled)) {` (keep the WARN + `throw new SmsSendingDisabledError()`).
- `sendMessage.ts:229` → `if (isOptedOut(conversation.sms_opt_out, contact?.sms_opt_out)) {` (keep the WARN + `throw new ContactOptedOutError`).
- `sendMessage.ts:261` → `if (isManualMode(conversation.ai_mode)) throw new ManualModeError(conversationId);` (still inside `if (automated)` at :260).
- Relay guard (:223) and JIT consent (:250) are UNCHANGED and stay between opt-out and manual. Add the import at the top of `sendMessage.ts`.

- [ ] **Step 6: Add the M1 regression tests** — append to `scheduledSendSuppression.test.ts` a `describe('sendMessage gate ordering (M1 regression)')` that builds a `sendMessage` via `createSendMessageService` with fakes (mirror the existing `sendMessage` test setup — check `app/src/services/sendMessage.test.ts` for the fixture pattern) and asserts:
  - a `relay_group` conversation whose contact is also opted out rejects with the **relay** error (`RelaySendNotSupportedError` / code `relay_not_supported`), NOT `contact_opted_out` — proving order preserved.
  - a human send (`automated: false`) into an `ai_mode: 'manual'` conversation **succeeds** (manual-mode is automated-only).

- [ ] **Step 7: Run full app suite** — Run: `npm run test -w app` and `npm run typecheck` → PASS (no behavior change to sendMessage).

- [ ] **Step 8: Commit**

```bash
git add app/src/services/scheduledSendSuppression.ts app/src/services/scheduledSendSuppression.test.ts app/src/services/sendMessage.ts
git commit -m "feat(comms): shared scheduled-send suppression evaluator + sendMessage predicate extraction"
```

---

## Task 2: Tour reminders read endpoint (Part A server)

**Files:**
- Create: `app/src/routes/tourReminders.ts`
- Create: `app/src/routes/tourReminders.test.ts`
- Modify: `app/src/routes/api.ts` (mount the router)

**Interfaces:**
- Consumes: `tourRemindersRepo.listByTour` (`app/src/repos/tourRemindersRepo.ts:101`), `REMINDER_BODIES` (export it from `jobs/tourReminders.ts:48` if not already exported), `evaluateScheduledSendSuppression` (Task 1), `toursRepo.getById`, `contactsRepo`, `conversationsRepo`, `config`.
- Produces:
  ```ts
  export interface TourReminderView {
    reminderId: string;
    kind: ReminderKind;
    dueAt: string;
    state: 'upcoming' | 'sent' | 'canceled';
    sentAt?: string;
    canceledAt?: string;
    body: string;
    suppression?: ScheduledSuppression; // only computed for 'upcoming' 1:1-routed rungs
  }
  // GET /api/tours/:tourId/reminders → { reminders: TourReminderView[]; next?: TourReminderView }
  export function createTourRemindersRouter(deps: TourRemindersRouterDeps): Router;
  ```

- [ ] **Step 1: Write the failing test** — `app/src/routes/tourReminders.test.ts`. Use the existing route-test harness pattern (supertest against an express app built from `createTourRemindersRouter` with fake repos — mirror `app/src/routes/contactTimeline.test.ts` setup). Cases:
  - three rows for a tour (`confirmation` sent, `day_before` upcoming, `morning_of` canceled) → response `reminders` sorted by `dueAt` asc with `state` `sent|upcoming|canceled`, bodies = `REMINDER_BODIES[kind]`, and `next` = the `day_before` (earliest upcoming).
  - a self_guided tour with an opted-out tenant → the upcoming rung carries `suppression:{reason:'contact_opted_out'}`.
  - unknown tour id → 404.

- [ ] **Step 2: Run test to verify it fails** — Run: `npm run test -w app -- tourReminders` → FAIL.

- [ ] **Step 3: Implement `tourReminders.ts`**

Router with `GET /:tourId/reminders`: load tour (404 if missing), `listByTour`, map each row → `TourReminderView` (`state`: `canceledAt`→canceled, else `sentAt`→sent, else upcoming; `body = REMINDER_BODIES[kind]`). For **upcoming** rows that route 1:1 (reuse the exported `resolveUsableGroup` from Task 4's export — if Task 4 not yet done, compute suppression only when `tour.tourType === 'self_guided'`; Task 4 tightens this), resolve tenant conversation and call `evaluateScheduledSendSuppression({ smsSendingEnabled: config.smsSendingEnabled, convOptOut, contactOptOut, aiMode })`. Sort asc by `dueAt`; `next` = first upcoming. Respond `{ reminders, next }`.

- [ ] **Step 4: Mount + run** — In `api.ts`, mount `app.use('/api/tours', createTourRemindersRouter(deps))` alongside the existing tours router (confirm it composes with the existing `/api/tours` mount — if `routes/tours.ts` already owns `/api/tours`, add the sub-route there instead or mount the reminders router after). Run: `npm run test -w app -- tourReminders` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/tourReminders.ts app/src/routes/tourReminders.test.ts app/src/routes/api.ts app/src/jobs/tourReminders.ts
git commit -m "feat(tours): GET /api/tours/:id/reminders read endpoint with state + suppression"
```

---

## Task 3: Tour reminders client type + fetcher + RemindersPanel (Part A client)

**Files:**
- Modify: `dashboard/src/api/types.ts`, the fetchers module (`dashboard/src/api/client.ts` or equivalent — grep for `getTour(`)
- Create: `dashboard/src/routes/tours/RemindersPanel.tsx`
- Modify: `dashboard/src/routes/tours/TourDetail.tsx`

**Interfaces:**
- Consumes: `GET /api/tours/:id/reminders` (Task 2).
- Produces: `TourReminderView` type, `getTourReminders(tourId): Promise<{reminders: TourReminderView[]; next?: TourReminderView}>`, `<RemindersPanel tourId=... />`.

- [ ] **Step 1:** Add `TourReminderView` + `ReminderKind` (if absent) to `types.ts` mirroring the server shape verbatim. Add `getTourReminders` fetcher next to the existing tour fetchers (follow the existing fetch/error pattern).

- [ ] **Step 2:** Build `RemindersPanel.tsx` — fetch on mount (or accept data as a prop if TourDetail already has a query layer). Render a titled "Reminders" panel: each rung a row with the kind label (human copy: "Confirmation", "Day before", "Morning of", "En route", "No-show check-in"), a state chip mirroring `dashboard/src/routes/placements/DeadlineChip.tsx` tone pattern (upcoming=amber/neutral with relative time; sent=green with absolute sent-at; canceled=muted/struck), the body as secondary text, and — when `suppression` present — a "Will be skipped — <reason>" amber note. Highlight `next`. Empty list → "No reminders armed."

- [ ] **Step 3:** Mount `<RemindersPanel tourId={tour.tourId} />` in `TourDetail.tsx` under the existing Status/Scheduled block.

- [ ] **Step 4: Verify** — `npm run typecheck`; `npm run test -w dashboard` (add a light render test if the dashboard has component tests, else rely on the Task 8 e2e). Run: → PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/api/types.ts dashboard/src/api/client.ts dashboard/src/routes/tours/RemindersPanel.tsx dashboard/src/routes/tours/TourDetail.tsx
git commit -m "feat(tours): Reminders panel on tour detail (ladder state + next + suppression)"
```

---

## Task 4: Part B server — TimelineScheduled + gather + upcoming envelope

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (export `resolveUsableGroup`)
- Modify: `app/src/routes/contactTimeline.ts` (union member, deps, gather, envelope)
- Modify: `app/src/routes/contactTimeline.test.ts`

**Interfaces:**
- Consumes: `resolveUsableGroup(tour, deps)` (newly exported), `tourRemindersRepo`, `placementNudgesRepo`, `toursRepo.listByTenant`, `unitsRepo.listByLandlord`, `placementsRepo.listByUnit`/`listByTenant`, `REMINDER_BODIES`, `NUDGE_RUNGS`/`STAGE_BY_KIND`, `evaluateScheduledSendSuppression`, `config`.
- Produces: `TimelineScheduled` (see spec §B), envelope `{ items, nextCursor, upcoming: TimelineScheduled[] }`.

- [ ] **Step 1: Export `resolveUsableGroup`** — change `function resolveUsableGroup` (`jobs/tourReminders.ts:370`) to `export function resolveUsableGroup`. Run `npm run typecheck`.

- [ ] **Step 2: Write the failing gather tests** — extend `contactTimeline.test.ts`. Build the router via `createContactTimelineRouter` with fake repos. Cases:
  - tenant with a self_guided tour that has 2 upcoming rungs → `upcoming` has 2 `kind:'scheduled'` items (asc by dueAt), `source:'tour_reminder'`, correct `body`, `conversationId` = the tenant 1:1.
  - a non-self_guided tour whose group is **unusable** (getById returns closed/no-pool) → its upcoming rungs DO appear (1:1-routed, M3).
  - a non-self_guided tour with a **usable** group → its rungs do NOT appear.
  - a landlord contact with an `awaiting_approval` placement nudge and NO existing landlord 1:1 → one `upcoming` item, `source:'placement_nudge'`, `conversationId` **undefined** (M4).
  - opted-out tenant → the tour-reminder `upcoming` item carries `suppression:{reason:'contact_opted_out'}`.
  - a request WITH a `cursor` → `upcoming` is `[]`.
  - `kinds=message` (excludes scheduled) → `upcoming` is `[]` and the gather is skipped.

- [ ] **Step 3: Run to verify fail** — Run: `npm run test -w app -- contactTimeline` → FAIL.

- [ ] **Step 4: Implement the gather** — in `contactTimeline.ts`:
  1. Add `TimelineScheduled` interface (spec §B) to the union at L88 and `'scheduled'` to `ALL_KINDS` (L133).
  2. Add the new repos to `ContactTimelineRouterDeps` + `createContactTimelineRouter`.
  3. In the handler, after building the response, if `cursor === undefined` AND (`kinds` absent OR includes `'scheduled'`): run the gather (spec §B.1–3), `Promise.all`-parallelizing the three walks and their per-parent `listBy*`. Resolve the tenant 1:1 from `contact.phone` (primary) → `findByParticipantPhone` → first `tenant_1to1|unknown_1to1` (mirror `tourReminders.ts:270-281`); landlord 1:1 similarly (`landlord_1to1`), else `conversationId` undefined. Compute `suppression` per item via `evaluateScheduledSendSuppression` (for nudges pass `staleStage = placement.stage !== STAGE_BY_KIND[nudgeKind]`). Cap the landlord unit walk at 50 units and `log.info` if truncated. Sort `upcoming` asc by `dueAt`.
  4. Emit `res.json({ items: ..., nextCursor, upcoming })` (default `upcoming: []` on cursor pages).

- [ ] **Step 5: Run to verify pass** — Run: `npm run test -w app -- contactTimeline` and `npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/jobs/tourReminders.ts app/src/routes/contactTimeline.ts app/src/routes/contactTimeline.test.ts
git commit -m "feat(timeline): gather scheduled sends into a first-page upcoming[] bucket (Part B server)"
```

---

## Task 5: Part B client — types, hook threading, ScheduledCard pinned section

**Files:**
- Modify: `dashboard/src/api/types.ts`
- Modify: `dashboard/src/routes/contact/useContactTimeline.ts`
- Create: `dashboard/src/routes/contact/ScheduledCard.tsx`
- Modify: `dashboard/src/routes/contact/Timeline.tsx`

**Interfaces:**
- Consumes: the `upcoming` envelope (Task 4).
- Produces: rendered pinned "Upcoming" section.

- [ ] **Step 1:** In `types.ts` add `TimelineScheduled` to the `TimelineItem` union (verbatim from server, `conversationId?` optional) and `upcoming?: TimelineScheduled[]` to `ContactTimelinePage`.

- [ ] **Step 2:** In `useContactTimeline.ts` thread `upcoming` through `loadTimeline`'s return (`:94-132`) → hook state → returned value; default `upcoming: []` on the 404 `buildTimelineFallback` branch (m1). No cursor/paging interaction (client reads first page only).

- [ ] **Step 3:** Build `ScheduledCard.tsx` — one upcoming item: clock icon; fire-time line with two branches (m3): `new Date(item.at) > now` → "sends " + relative ("in 3h") + absolute; else → "sending shortly"; the `body`; a source tag ("Tour reminder" / "Nudge"); when `item.suppression` present, an amber "Will be skipped — <human reason>" line (map `contact_opted_out`→"contact opted out", `manual_mode`→"conversation in manual mode", `sms_sending_disabled`→"SMS sending paused", `stale_stage`→"no longer applies"). Distinct dashed/muted styling — visibly NOT a sent message.

- [ ] **Step 4:** In `Timeline.tsx` render a pinned `<section aria-label="Upcoming scheduled messages">` between `div.stream` and the reply composer, shown only when `upcoming.length > 0`: a "Upcoming (N)" header + `upcoming.map(ScheduledCard)`. Add the defensive `case 'scheduled': return null;` to `StreamItem`'s switch (main-stream `items` never contains scheduled rows; satisfies TS exhaustiveness).

- [ ] **Step 5: Verify** — `npm run typecheck`; `npm run test -w dashboard` → PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/contact/useContactTimeline.ts dashboard/src/routes/contact/ScheduledCard.tsx dashboard/src/routes/contact/Timeline.tsx
git commit -m "feat(timeline): pinned Upcoming section renders scheduled future items (Part B client)"
```

---

## Task 6: Live updates — scheduled.updated event end-to-end

**Files:**
- Modify: `app/src/lib/events.ts`, `app/src/routes/api.ts`, `app/src/routes/tours.ts`, `app/src/jobs/placementNudges.ts`
- Modify: `dashboard/src/api/types.ts`, `dashboard/src/api/EventStreamProvider.tsx`, `dashboard/src/routes/contact/useContactTimeline.ts`

**Interfaces:**
- Produces: `AppEventMap['scheduled.updated'] = { contactId?: string }`; client `onScheduledUpdated?` handler.

- [ ] **Step 1: Write the failing test** — in an app test (e.g. extend `tours` route test or a small `events` test) assert that booking/rescheduling a tour emits `scheduled.updated` with `{contactId: tour.tenantId}`, and that entering a nudge-arming stage emits it with `{contactId: placement.tenantId}`. Use an in-memory `appEvents` spy.

- [ ] **Step 2: Run to verify fail** — `npm run test -w app -- tours` (or the chosen test) → FAIL.

- [ ] **Step 3: Implement**
  - `events.ts:192` add `'scheduled.updated': ScheduledUpdatedEvent;` to `AppEventMap` + `export interface ScheduledUpdatedEvent { contactId?: string }`.
  - `routes/tours.ts` at the arm/cancel sites (~L210 create, ~L452-453 reschedule cancel+arm, ~L461 cancel) → `events.emit('scheduled.updated', { contactId: tour.tenantId })` (one emit after the cancel+arm pair on reschedule).
  - `jobs/placementNudges.ts` — give `armNudgeForStage`/`cancelForPlacement` an `events` dep and emit `{ contactId: placement.tenantId }` best-effort (never throw). In `api.ts:~517` thread `events` into the nudge arm hook deps.
  - `api.ts` `GET /api/events` (~L1121) add `onScheduledUpdated` subscribe + matching `events.off` in the close handler (~L1142).

- [ ] **Step 4: Client** — `types.ts` add `ScheduledUpdatedEvent` + `onScheduledUpdated?` to `EventStreamHandlers`. `EventStreamProvider.tsx` add `source.addEventListener('scheduled.updated', ...)` dispatch block (mirror `message.persisted`). `useContactTimeline.ts:246` add `onScheduledUpdated: scheduleRefetch`.

- [ ] **Step 5: Run** — `npm run test -w app` + `npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/events.ts app/src/routes/api.ts app/src/routes/tours.ts app/src/jobs/placementNudges.ts dashboard/src/api/types.ts dashboard/src/api/EventStreamProvider.tsx dashboard/src/routes/contact/useContactTimeline.ts
git commit -m "feat(comms): scheduled.updated SSE event drives live arm/reschedule/cancel"
```

---

## Task 7: e2e coverage

**Files:**
- Modify: `e2e/scenarios/steps.ts`
- Create/modify: `e2e/tests/scenarios/scheduled-visibility.spec.ts` (+ extend `tours.spec.ts` for Part A if cleaner)

**Interfaces:**
- Consumes: existing verbs `login`, `teamCreatesTourFromInterest`, `teamBooksTour`, `tourSchedule`, `justAfter`, `tickTourReminders`, `teamReschedulesTour`, `devPlacementNudgeTick`, `hoursFromNow`, `postInboundSms`, `expectReminderTo1to1`, `expectNoOutboxMessageContaining`, `region "Communications and activity"`.

- [ ] **Step 1: Add verbs to `steps.ts`** — `expectUpcomingItem(contactId, { bodyContains, source })` (goto `/contacts/:id`, scope to the "Upcoming scheduled messages" section, assert an item with the body + a fire-time affordance); `expectUpcomingSuppressed(contactId, bodyContains)` (same, asserts the "Will be skipped" treatment); `openTourReminders(tourId)` + `expectReminderRung(kind, state)` (goto `/tours/:id`, scope to the Reminders panel).

- [ ] **Step 2: Spec (a)+(b) tour reminder future→sent** — book a tour (`tourSchedule()`), goto tenant contact → `expectUpcomingItem` for the `day_before` rung (pre-tick; note `confirmation` shows "sending shortly"); `tickTourReminders(justAfter(times.dayBefore))` → assert the item is gone from Upcoming and a sent message appears; cross-check `expectReminderTo1to1('day_before', tenant)`.

- [ ] **Step 3: Spec (c) reschedule** — book → tick a rung → `openTourReminders` assert states → `teamReschedulesTour(tourSchedule(72))` → assert the panel shows old rungs canceled + a fresh upcoming ladder, and `expectReminderTo1to1('confirmation', tenant, 2)`.

- [ ] **Step 4: Spec (d) suppression** — self-seed tenant → `postInboundSms({from: tenant.phone, body: 'STOP'})` → book + goto contact → `expectUpcomingSuppressed(tenant, TOUR_REMINDER_BODIES.day_before)` → `tickTourReminders(...)` → `expectNoOutboxMessageContaining(tenant, TOUR_REMINDER_BODIES.day_before)`.

- [ ] **Step 5: Spec (e) tenant nudge** — move a placement into `awaiting_receipt` → goto tenant contact → `expectUpcomingItem(tenant, {bodyContains: 'application come through', source: 'nudge'})` → `devPlacementNudgeTick(hoursFromNow(25))` → assert transitioned to sent.

- [ ] **Step 6: Run e2e** — Run: `npm run e2e -- scheduled-visibility` (session mode for iteration; full `npm run e2e` before done). Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add e2e/scenarios/steps.ts e2e/tests/scenarios/scheduled-visibility.spec.ts
git commit -m "test(e2e): scheduled-message visibility — future items, transition, reschedule, suppression, nudge"
```

---

## Task 8: Sync main, full suite, deliverables

- [ ] **Step 1:** `git merge main` (resolve conflicts keeping both intents; re-run affected tests). If `main` advanced significantly, ASK before finishing.
- [ ] **Step 2:** Full `npm test` + `npm run e2e` green on the updated base.
- [ ] **Step 3:** Verify in the real dashboard via `npm run e2e:session` + Playwright MCP (the four scenarios + Part A panel). Screenshot the Upcoming section + Reminders panel into `.playwright-mcp/`.
- [ ] **Step 4:** File sub-issues `scheduled-send-surface-cues` and `today-next-tour-reminder-from-ladder` (copy `docs/issues/_TEMPLATE.md`). Update `docs/issues/scheduled-message-visibility.md` status → resolved with a Resolution note (or in-progress with what's left). Remove the two `TODO(scheduled-message-visibility)` anchors now that they're implemented.
- [ ] **Step 5:** Stamp the design + plan docs; write the summary of decisions + anything deferred. Do NOT merge to main (human gate).

---

## Self-Review notes

- **Spec coverage:** Part A (Task 2-3), Part B server/client (Task 4-5), suppression (Task 1), live updates (Task 6), e2e incl. all four deliverables + tenant nudge (Task 7), sub-issues + issue update (Task 8). All spec sections mapped.
- **M-fixes:** M1 (Task 1 predicate extraction + regression tests), M2 (Task 4 Promise.all + cap), M3 (Task 4 Step 1 export + unusable-group test), M4 (Task 4 landlord `conversationId?` undefined + test). m1/m3 (Task 5), m2 (Task 6 payload = tenantId only).
- **Type consistency:** `TourReminderView`, `TimelineScheduled`, `ScheduledSuppression`, `ScheduledUpdatedEvent` names are used identically across server + client tasks.
- **Ordering dependency:** Task 4 Step 1 (export `resolveUsableGroup`) is needed by Task 2's tightest suppression path — Task 2 notes the fallback if run first; either order works.
