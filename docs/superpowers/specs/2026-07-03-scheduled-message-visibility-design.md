# Design — Scheduled-message visibility (reminder ladder + future timeline items)

- **Issue:** [docs/issues/scheduled-message-visibility.md](../../issues/scheduled-message-visibility.md)
- **Research:** [docs/research/scheduled-message-visibility/](../../research/scheduled-message-visibility/README.md)
- **Date:** 2026-07-03
- **Branch:** `feat/scheduled-message-visibility` (worktree `w:/tmp/sched-msg-visibility`)

## Goal

Make scheduled outbound SMS visible *before* it fires, in two places:

- **Part A** — a **Reminders panel** on the tour detail page showing the 5-rung ladder,
  each rung's state (upcoming / sent / canceled) + times.
- **Part B** — **future items** in a contact's 1:1 comms timeline: every not-yet-sent
  scheduled outbound (tour reminders + placement nudges) shown as a distinct FUTURE item
  (what it will say, when, and whether it will be suppressed), transitioning in place to a
  sent message when it fires and updating on reschedule/cancel.

## Scope decisions (locked)

| Question | Decision |
|---|---|
| Scheduled-send sources in scope | **Tour reminders + placement nudges only.** `next_deadline` (board clock, no SMS), `retrySend` (ephemeral ≤240s, no queryable row), broadcasts (fire immediately) are out — justified in research §1. |
| Timeline rendering of future items | **Pinned "Upcoming" section** below the message stream, above the composer. Fed by a separate `upcoming[]` envelope bucket. |
| Reach beyond timeline (Today/row chips) | **Out of scope** this pass — filed as sub-issue `scheduled-send-surface-cues`. |
| Placement `tour_reminder` orphan / Today repoint | **Deferred** — filed as sub-issue `today-next-tour-reminder-from-ladder`. |
| Body fidelity | Bodies are canned `[AUTO]` per-`kind`/`stage` templates, never personalized at send → **preview renders the exact template string** with perfect fidelity. |
| Group-routed tour reminders (landlord_led/pm_team) | Route to the masked group thread, have **no 1:1 conversation**, are not stored as messages → they appear **only in Part A's panel**, never in a Part B 1:1 timeline. Accepted consequence. |

## Architecture

### A. Tour reminders read endpoint + panel

- **New route** `GET /api/tours/:tourId/reminders` (behind `requireAuth`) → returns the
  tour's reminder rows mapped to a stable wire shape:
  ```ts
  interface TourReminderView {
    reminderId: string;
    kind: ReminderKind;                    // confirmation | day_before | morning_of | en_route | no_show_checkin
    dueAt: string;                         // ISO
    state: 'upcoming' | 'sent' | 'canceled';
    sentAt?: string;
    canceledAt?: string;
    body: string;                          // REMINDER_BODIES[kind] (faithful preview)
    suppression?: ScheduledSuppression;    // only meaningful for 'upcoming' (see §C)
  }
  // response: { reminders: TourReminderView[], next?: TourReminderView }
  ```
  `state` derived: `canceledAt` → canceled; `sentAt` → sent; else upcoming. `next` = the
  earliest-`dueAt` upcoming rung. Ordered by `dueAt` ascending. Reuses
  `tourRemindersRepo.listByTour` (already exists; `byTour` GSI).
- **Client:** `getTourReminders(tourId)` fetcher + `TourReminderView` type in
  `dashboard/src/api/types.ts`.
- **UI:** a `RemindersPanel` component on `TourDetail.tsx`. Each rung a compact row —
  kind label, a state chip (mirror the `DeadlineChip` red/amber/neutral pattern), relative
  fire time for upcoming ("in 3h"), absolute sent-at for sent, struck/muted for canceled;
  the body as secondary text. The **next** rung highlighted. After a reschedule the panel
  shows the old rungs canceled + a fresh upcoming ladder.

### B. Future items in the 1:1 timeline (`kind:'scheduled'`)

- **Server builder `app/src/routes/contactTimeline.ts`:**
  - New union member `TimelineScheduled` (fills the planted `TODO` anchor at ~L118):
    ```ts
    interface TimelineScheduled extends TimelineBase {
      kind: 'scheduled';
      // id = `sched#${source}#${rowId}`, at = dueAt
      conversationId: string;              // the resolved 1:1 thread this item belongs to
      source: 'tour_reminder' | 'placement_nudge';
      reminderKind?: ReminderKind;
      nudgeKind?: NudgeKind;
      body: string;                        // the canned template that WILL send
      suppression?: ScheduledSuppression;  // absent = will send; present = will be skipped + reason
      refType: 'tour' | 'placement';
      refId: string;
    }
    ```
  - **Gather (fills the `TODO` anchor at ~L346), the by-conversation resolution — the core
    build gap.** There is no contact→reminder index, so for the contact's resolved 1:1
    conversation set (already computed at L325-337, `relay_group` excluded):
    1. **Tour reminders:** find tours where the contact is the tenant (`toursRepo` by
       tenantId), for each `listByTour` → keep rows that are (a) upcoming
       (`!sentAt && !canceledAt`) AND (b) will route to a **1:1** (i.e. the tour is
       self_guided **or** has no usable group — mirror `resolveUsableGroup`). Group-routed
       rungs are dropped (they have no 1:1). Map each surviving row → `TimelineScheduled`
       on the tenant's resolved 1:1 conversationId.
    2. **Placement nudges:** find placements where the contact is tenant OR landlord
       (tenant via `placement.tenantId`; landlord via units the contact owns →
       placements on those units). For each `listByPlacement` → keep upcoming rows whose
       `rung.recipient` party == this contact, map → `TimelineScheduled` on the matching
       1:1 conversationId. (A nudge whose 1:1 does not yet exist — created-on-demand at
       fire time — resolves to the same `conversationTypeFor` thread; if absent, we still
       surface it against the conversation it *will* target if we can resolve the phone,
       else skip. v1: only surface when a 1:1 already exists in `convById`, matching what
       the timeline can show.)
  - **Ordering carve-out (the pagination hazard):** scheduled items are **NOT** merged
    into the DESC-take-`limit` `candidates` slice (a future `dueAt` would corrupt the
    slice + cursor). Instead they are gathered separately and returned in a new envelope
    field **only on the first page** (`cursor === undefined`):
    ```ts
    res.json({ items, nextCursor, upcoming: TimelineScheduled[] /* asc by dueAt */ });
    ```
    `upcoming` is `[]` on paginated (cursor) requests. Cursor math is untouched.
  - `'scheduled'` added to `ALL_KINDS` so it is a valid `kinds` filter token; when a
    `kinds` filter is given and excludes `scheduled`, `upcoming` is `[]`.
  - New deps on `ContactTimelineRouterDeps`: `tourRemindersRepo`, `placementNudgesRepo`,
    `toursRepo`, `placementsRepo`, `unitsRepo`, plus the suppression evaluator (§C) inputs.

- **Client types `dashboard/src/api/types.ts`:** add `TimelineScheduled` to the union +
  `upcoming?: TimelineScheduled[]` to `ContactTimelinePage`.

- **Renderer `dashboard/src/routes/contact/Timeline.tsx`:** render `page.upcoming` as a
  **pinned "Upcoming (N)" section** between the scrollable `div.stream` and the reply
  composer. Each item: a clock icon, "sends <relative + absolute time>", the body, a
  source tag (tour reminder / nudge), and — when `suppression` is present — a distinct
  **"Will be skipped — <reason>"** treatment (amber/danger, not the normal send styling).
  New `ScheduledCard` component. `page.upcoming` is rendered directly by the pinned
  section, not through `StreamItem`; since `TimelineItem` now includes `'scheduled'`,
  `StreamItem`'s switch gets a defensive `case 'scheduled': return null` (main-stream
  `items` never contains scheduled rows). Empty `upcoming` → section not rendered.

### C. Suppression honesty — shared evaluator

- **New pure helper** `evaluateScheduledSendSuppression(input): ScheduledSuppression | undefined`
  (co-located with `sendMessage.ts` or a new `app/src/services/scheduledSendSuppression.ts`):
  ```ts
  type ScheduledSuppression = {
    reason: 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage';
  };
  ```
  Evaluates only the **read-only** gates: global kill-switch (`config.smsSendingEnabled === false`),
  opt-out (`conversation.sms_opt_out || contact.sms_opt_out`), manual-mode
  (`conversation.ai_mode === 'manual'` — which also subsumes a tripped breaker), and for
  nudges the stale-stage guard (`placement.stage !== STAGE_BY_KIND[kind]`). **Excludes**
  JIT-consent (never applies to automated) and live-breaker prediction (unevaluable).
- **`sendMessage`'s Gates 0/1/2a are refactored to call the same helper** so preview and
  real send share one definition and cannot drift. (Breaker + audit side-effects stay in
  `sendMessage`; the helper is the pure predicate portion.)
- The timeline gather + the tour-reminders endpoint both call the helper to populate
  `suppression`. The UI always caveats implicitly: state is a current estimate (opt-out /
  manual / kill-switch can flip before fire); when it fires or is retired the item
  transitions in place.

### D. Live updates

- **future → sent:** already free. The poller's `sendMessageService` emits
  `message.persisted` → the timeline already refetches → the re-gather drops the now-`sentAt`
  row from `upcoming` and the real sent bubble appears in `items`. No new code.
- **arm / reschedule / cancel:** add one new SSE event **`scheduled.updated`** to
  `AppEventMap` (`app/src/lib/events.ts`), payload `{ contactId?: string; conversationId?: string }`
  (IDs only — PII rule). Emit it at the arm + cancel sites:
  - tour: `armTourReminders` / `cancelTourReminders` call sites in `routes/tours.ts`
    (create ~L210, reschedule cancel+arm ~L452-453, cancel ~L461). One emit after the
    cancel+arm pair for reschedule.
  - nudge: `armNudgeForStage` / `cancelForPlacement` (invoked from `statusTransition.ts`).
    Resolve the affected contactId(s) for the payload.
  - SSE route `routes/api.ts` `GET /api/events`: add the `onScheduledUpdated` subscribe/off
    pair. Client `EventStreamProvider` + `EventStreamHandlers`: add `onScheduledUpdated`.
    `useContactTimeline` wires `onScheduledUpdated: scheduleRefetch` (300ms-debounced).

## Data / infra

- **No new tables or GSIs.** Part A reuses `byTour`; Part B reuses `byTour` + `byPlacement`
  + existing tour/placement/unit reads. No schema change → **no Terraform apply required**.
- The by-contact resolution walks existing indexes (tours by tenant, placements by
  tenant/landlord-unit). If a contact→tour / contact→placement lookup turns out to need an
  index that doesn't exist, that becomes a build-time finding (note in the plan); the
  expectation from research is these lookups already exist for the dashboard's contact page.

## Testing

- **Unit (vitest):** `evaluateScheduledSendSuppression` truth table; the tour-reminders
  endpoint mapping (state derivation, `next`); the timeline gather (upcoming bucket, group
  routed rungs excluded, suppression populated, cursor pages return empty `upcoming`).
- **e2e (Playwright)** — extend `e2e/scenarios/steps.ts` + specs, using the deterministic
  tick seams:
  - (a) book a tour → contact timeline shows the future reminder item(s) with body + time
    *before* any tick.
  - (b) `tickTourReminders(justAfter(rung))` → item transitions to a sent message (live).
  - (c) reschedule → tour Reminders panel shows old rungs canceled + fresh ladder; timeline
    upcoming re-armed; `expectReminderTo1to1('confirmation', tenant, 2)` at the send layer.
  - (d) opt the contact out (`postInboundSms {body:'STOP'}`) → the future item reads
    **suppressed**, and `expectNoOutboxMessageContaining(...)` confirms nothing delivered.
  - Part A: tour detail Reminders panel renders the ladder states.
- Full `npm test` + `npm run e2e` green on latest `main`.

## Sub-issues to file

- `scheduled-send-surface-cues` — Today-queue + tour/placement-row next-send chips.
- `today-next-tour-reminder-from-ladder` — repoint Today's "next tour reminder" at the tour
  ladder; retire the orphaned placement `tour_reminder` deadline type.
- (Possibly) `scheduled-nudge-preview-before-1to1-exists` — surfacing a nudge whose 1:1 is
  created-on-demand only at fire time, if v1 skipping proves insufficient.

## Build sequence

1. `evaluateScheduledSendSuppression` helper + refactor `sendMessage` gates onto it (TDD).
2. Part A: tour reminders endpoint + client type/fetcher + `RemindersPanel` (TDD, e2e).
3. Part B server: `TimelineScheduled` + gather + `upcoming[]` envelope + suppression (TDD).
4. Part B client: types + `ScheduledCard` pinned section (e2e).
5. Live updates: `scheduled.updated` event end-to-end.
6. e2e specs (a)-(d) + Part A; sync `main`; full suite green.
