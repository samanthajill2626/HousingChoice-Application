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
      conversationId?: string;             // the resolved 1:1 thread, if one already exists;
                                           // ABSENT for a landlord nudge whose 1:1 is created
                                           // on demand at fire time (item still shows — see M4)
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
    build gap.** There is no contact→reminder index. The gather resolves the *viewed
    contact's* scheduled rows directly (we know the contact; we do NOT require a
    pre-existing conversation). Three **independent walks**, each `Promise.all`-parallelized
    internally and with each other (verified index-backed, not scans — review confirmed):
    1. **Tour reminders (tenant only — tours only ever target the tenant):**
       `toursRepo.listByTenant(contactId)` (`byTenant` GSI) → per tour `listByTour` in
       parallel → keep rows that are (a) upcoming (`!sentAt && !canceledAt`) AND (b) will
       route to a **1:1**. Route predicate MUST reuse the **exact** poller function — extract
       and export `resolveUsableGroup` from `jobs/tourReminders.ts` and call it (a
       non-self_guided tour with a `groupThreadId` whose group is *unusable* — closed / no
       pool / empty roster — actually 1:1-sends; a cheap `!groupThreadId` proxy would wrongly
       hide it, M3). Group-routed rungs are dropped (no 1:1). Attach to the tenant's 1:1
       resolved the **same way the poller does** — from `contact.phone` (scalar primary) →
       `findByParticipantPhone` → first `tenant_1to1|unknown_1to1` (mirror
       `tourReminders.ts:270-281`, not the multi-phone `convById`, m4).
    2. **Placement nudges — tenant rungs:** `placementsRepo.listByTenant(contactId)` → per
       placement `listByPlacement` → keep upcoming rows whose `rung.recipient === 'tenant'`.
       Attach to the tenant 1:1 (as above).
    3. **Placement nudges — landlord rungs:** `unitsRepo.listByLandlord(contactId)`
       (`byLandlord` GSI) → `placementsRepo.listByUnit` per unit → `listByPlacement` → keep
       upcoming rows whose `rung.recipient === 'landlord'`. Attach to the landlord 1:1 if one
       exists; **else surface with `conversationId` absent** (landlord nudges create the 1:1
       on demand at fire time — `placementNudges.ts:294-330` — so requiring a pre-existing
       conversation would make the feature invisible for the common landlord case it was
       built for, M4). Cap the unit walk (e.g. first 50 units) and `log` if truncated (no
       silent cap).
  - **Perf (M2).** This N+1 fan-out runs only when `upcoming` is returned (first page; the
    client never paginates, so effectively every contact-timeline load + every
    `scheduled.updated`/`message.persisted` refetch). All walks + per-parent `listBy*` are
    `Promise.all`-parallelized; worst case is a landlord owning many units. Acceptable at
    Phase-1 data volumes; the honest scale answer (a denormalized target-conversation field
    written at arm time → one indexed read) is recorded as a follow-up if load warrants it.
    Skip the whole gather when a `kinds` filter is present and excludes `scheduled`.
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
  `upcoming?: TimelineScheduled[]` to `ContactTimelinePage`. Thread `upcoming` through
  `useContactTimeline`'s `loadTimeline` return type → hook state → renderer (today it drops
  everything but `items`, `useContactTimeline.ts:94-132`). The 404 `buildTimelineFallback`
  branch produces no scheduled data → default `upcoming` to `[]` there so the pinned section
  simply doesn't render on the fallback path (m1).

- **Renderer `dashboard/src/routes/contact/Timeline.tsx`:** render `page.upcoming` as a
  **pinned "Upcoming (N)" section** between the scrollable `div.stream` and the reply
  composer. Each item: a clock icon, the fire time, the body, a source tag (tour reminder /
  nudge), and — when `suppression` is present — a distinct **"Will be skipped — <reason>"**
  treatment (amber/danger, not the normal send styling). **Fire-time display has two
  branches (m3):** `dueAt > now` → "sends <relative + absolute>" (e.g. "sends in 3h");
  `dueAt <= now` → "sending shortly / due now" (the `confirmation` rung is always armed with
  `dueAt = now` and only sends on the next poll tick, so it is a past-`dueAt` pending row).
  New `ScheduledCard` component. `page.upcoming` is rendered directly by the pinned section,
  not through `StreamItem`; since `TimelineItem` now includes `'scheduled'`, `StreamItem`'s
  switch gets a defensive `case 'scheduled': return null` (main-stream `items` never contains
  scheduled rows). Empty `upcoming` → section not rendered.

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
- **The refactor MUST NOT change real send behavior (M1 — the review's top risk).** Do NOT
  collapse `sendMessage`'s five sequential gate throws into one top-of-function call — that
  would (a) reorder the relay-guard (0b, `sendMessage.ts:223`) relative to opt-out so a
  `relay_group`+opted-out send throws the wrong error *code*, and (b) risk enforcing
  manual-mode on human sends (it is deliberately `if (automated)`-only, `:260`). Instead,
  extract the **individual boolean predicates** (`isKillSwitchOff(config)`,
  `isOptedOut(conversation, contact)`, `isManualMode(conversation)`) and have `sendMessage`
  call them **at their existing positions**, preserving the exact ordering, the `if (automated)`
  guards, the WARN logs (`:217`, `:230-237` — which stay in `sendMessage`, NOT the helper, so
  timeline loads don't spam "send refused" warnings), and the distinct throw types. The pure
  `evaluateScheduledSendSuppression` composes the same predicates for the preview (evaluating
  manual-mode unconditionally, since every previewed item is automated). Pin them together
  with a regression test asserting the exact error **code** for (a) relay+opted-out and
  (b) a human send into a manual-mode conversation (must still succeed).
- The timeline gather + the tour-reminders endpoint both call the helper to populate
  `suppression`. The UI always caveats implicitly: state is a current estimate (opt-out /
  manual / kill-switch can flip before fire); when it fires or is retired the item
  transitions in place.

### D. Live updates

- **future → sent:** already free. The poller's `sendMessageService` emits
  `message.persisted` → the timeline already refetches → the re-gather drops the now-`sentAt`
  row from `upcoming` and the real sent bubble appears in `items`. No new code.
- **arm / reschedule / cancel:** add one new SSE event **`scheduled.updated`** to
  `AppEventMap` (`app/src/lib/events.ts`), payload `{ contactId?: string }` (IDs only — PII
  rule). **Keep the payload cheap (m2):** the client consumer refetches *unconditionally*
  (mirroring `message.persisted`, `useContactTimeline.ts:246-248`), so a precise id is
  advisory only — do NOT spend an extra `unitsRepo.getById` to chase a landlord rung's
  contactId that the client ignores. Emit:
  - tour: at the `armTourReminders` / `cancelTourReminders` call sites in `routes/tours.ts`
    (create ~L210, reschedule cancel+arm ~L452-453, cancel ~L461) with `tour.tenantId` (in
    hand). One emit after the cancel+arm pair for reschedule.
  - nudge: at `armNudgeForStage` / `cancelForPlacement`. The nudge arm hook is currently
    wired with only `{placementNudgesRepo, logger}` (`api.ts:517-521`) — **thread `events`
    into it** so it can emit. Use `placement.tenantId` (trivially in hand); don't resolve the
    landlord id. A hook failure must still never fail the transition (best-effort, as today).
  - SSE route `routes/api.ts` `GET /api/events`: add the `onScheduledUpdated` subscribe/off
    pair. Client `EventStreamProvider` + `EventStreamHandlers`: add `onScheduledUpdated`.
    `useContactTimeline` wires `onScheduledUpdated: scheduleRefetch` (300ms-debounced).

## Data / infra

- **No new tables or GSIs.** Part A reuses `byTour`; Part B reuses `byTour` + `byPlacement`
  + existing tour/placement/unit reads. No schema change → **no Terraform apply required.**
- The by-contact resolution walks **existing, verified index-backed reads** (review
  confirmed): `toursRepo.listByTenant` (`byTenant` GSI, `toursRepo.ts:117,234`),
  `unitsRepo.listByLandlord` (`byLandlord` GSI, `unitsRepo.ts:283,476`) →
  `placementsRepo.listByUnit` (`placementsRepo.ts:221`), `placementsRepo.listByTenant`, and
  the existing `listByTour` / `listByPlacement`. No scans. `byLandlord` indexes the primary
  `landlordId`, which is exactly the field nudge routing uses (`unit.landlordId`) — so the
  gather and the poller agree on the target.

## Testing

- **Unit (vitest):** `evaluateScheduledSendSuppression` truth table; the M1 regression test
  (relay+opted-out error code; human send into manual-mode still succeeds); the tour-reminders
  endpoint mapping (state derivation, `next`); the timeline gather (upcoming bucket; a
  non-self_guided tour with an *unusable* group still surfaces as a 1:1 upcoming item, M3;
  group-routed rungs excluded; landlord nudge surfaces with `conversationId` absent, M4;
  suppression populated; cursor pages return empty `upcoming`).
- **e2e (Playwright)** — extend `e2e/scenarios/steps.ts` + specs, using the deterministic
  tick seams:
  - (a) book a tour → contact timeline shows the future reminder item(s) with body + time
    *before* any tick (note: the `confirmation` rung is past-`dueAt` pre-tick → renders as
    "due now / sending shortly", m3).
  - (b) `tickTourReminders(justAfter(rung))` → item transitions to a sent message (live).
  - (c) reschedule → tour Reminders panel shows old rungs canceled + fresh ladder; timeline
    upcoming re-armed; `expectReminderTo1to1('confirmation', tenant, 2)` at the send layer.
  - (d) opt the contact out (`postInboundSms {body:'STOP'}`) → the future item reads
    **suppressed**, and `expectNoOutboxMessageContaining(...)` confirms nothing delivered.
  - Part A: tour detail Reminders panel renders the ladder states.
  - Placement nudge (tenant): move a placement into `awaiting_receipt` → tenant timeline
    shows the future nudge → `devPlacementNudgeTick(hoursFromNow(25))` → transitions to sent.
- Full `npm test` + `npm run e2e` green on latest `main`.

## Sub-issues to file

- `scheduled-send-surface-cues` — Today-queue + tour/placement-row next-send chips.
- `today-next-tour-reminder-from-ladder` — repoint Today's "next tour reminder" at the tour
  ladder; retire the orphaned placement `tour_reminder` deadline type.
- (Perf watch, only if load warrants) denormalize a target-conversation field on the
  scheduled-send rows at arm time → collapse the Part-B gather to one indexed read (M2).

## Build sequence

1. `evaluateScheduledSendSuppression` helper + refactor `sendMessage` gates onto it (TDD).
2. Part A: tour reminders endpoint + client type/fetcher + `RemindersPanel` (TDD, e2e).
3. Part B server: `TimelineScheduled` + gather + `upcoming[]` envelope + suppression (TDD).
4. Part B client: types + `ScheduledCard` pinned section (e2e).
5. Live updates: `scheduled.updated` event end-to-end.
6. e2e specs (a)-(d) + Part A; sync `main`; full suite green.
