# Scheduled-send sources — exhaustive backend map

Research for `docs/issues/scheduled-message-visibility.md`. Goal: enumerate every
durable mechanism that persists a row/record with a future fire time and later emits
an outbound SMS (or a board deadline). A planner builds directly off this — every
claim carries a `file:line` citation.

## TL;DR — the mechanism inventory

| # | Mechanism | Durable queryable row? | Sends SMS? | Body fidelity | Poller |
|---|-----------|------------------------|------------|---------------|--------|
| 1 | **Tour reminder ladder** | YES (`tourReminders` table, `dueAt` on `byDueAt` GSI) | YES | Canned template, resolved AT SEND from `REMINDER_BODIES[kind]` — NOT stored on row | `runDueTourReminders`, 60s |
| 2 | **Placement application nudge** | YES (`placementNudges` table, `dueAt` on `byDueAt` GSI) | YES | Canned template, resolved AT SEND from `NUDGE_RUNGS[stage].body` — NOT stored on row | `runDuePlacementNudges`, 60s |
| 3 | **Placement `next_deadline` slot** | YES (`placements` table, `byNextDeadline` sparse composite GSI) | **NO — board deadline only** | n/a (no body) | none — read by the Today route only |
| 4 | **`messaging.retrySend`** | NO — ephemeral SQS/EventBridge job envelope (not a queryable DB row) | YES (re-send of a failed msg) | Faithful: body re-read from `messages` table at run time | worker job handler |
| 5 | **Broadcasts** | Not future-scheduled — fired immediately (`draft→sending→sent`, no `send_at`) | YES (bulk) | n/a for "future" | fan-out job, immediate |

**Only #1 and #2 are durable, queryable, future-dated outbound-SMS rows** — the two
the issue names. #3 is a durable future-dated row but it is a *board* clock that never
sends a text. #4 is a real scheduled send but ephemeral (lives in the queue, not a DB
row) and self-heals its body. #5 is not future-scheduled at all.

Also note the shared A2P suppression truth (#6, below): a scheduled send to an
opted-out / breaker-tripped / manual-mode / sms-disabled contact is refused at send
time by `sendMessageService`, so any "future item" preview must be honest about
possible suppression.

---

## 1. Tour reminder ladder — `tourReminders` table

### 1.1 Row shape
`app/src/repos/tourRemindersRepo.ts:36-51`:
```ts
export interface TourReminderItem {
  reminderId: string;          // PK  (`reminder-${randomUUID()}`, :83)
  tourId: string;              // byTour GSI hash key
  kind: ReminderKind;          // enum, 5 values
  dueAt: string;               // ISO 8601 — byDueAt GSI range key
  _reminderPartition: 'reminders'; // byDueAt GSI hash key (fixed literal)
  sentAt?: string;             // ISO — set when sent (also the claim marker)
  canceledAt?: string;         // ISO — set when canceled
  createdAt: string;
}
```
- **PK** = `reminderId`. **GSIs**: `byDueAt` (hash `_reminderPartition`='reminders',
  range `dueAt`) for the due-poll; `byTour` (hash `tourId`) for bulk cancel
  (`tourRemindersRepo.ts:6-8`, `:101-111`).
- **`kind` enum** (`:29-34`): `'confirmation' | 'day_before' | 'morning_of' |
  'en_route' | 'no_show_checkin'`.
- **State fields**: `sentAt?`, `canceledAt?`. There is NO `status` field and NO body
  field on the row — state is derived from presence/absence of `sentAt`/`canceledAt`,
  and the body is computed at send time (see 1.2).

### 1.2 Body production — **canned template, NOT stored on the row**
`app/src/jobs/tourReminders.ts:48-54`:
```ts
const REMINDER_BODIES: Record<ReminderKind, string> = {
  confirmation: "[AUTO] Your tour is confirmed. We'll send reminders as it approaches.",
  day_before: '[AUTO] Reminder: your property tour is tomorrow.',
  morning_of: '[AUTO] Good morning! Your property tour is today.',
  en_route: '[AUTO] Your tour is coming up soon. Text us when you\'re on the way!',
  no_show_checkin: '[AUTO] Hi! We noticed you may have missed your tour. Want to reschedule?',
};
```
The body is looked up from this constant at send time — `const body =
REMINDER_BODIES[row.kind]` (`:290` for the 1:1 path, `:432` for the group path). It is
**static per-kind, fully non-personalized** (no name/date/property interpolation). So a
future-item preview can render the exact string from `kind` with **perfect fidelity** —
there is no send-time variation to worry about.

### 1.3 Target conversation resolution
Decided per-row in `processReminderRow` (`app/src/jobs/tourReminders.ts:232-351`):
1. **Group route** (founder decision 2026-07-02, `:245-257`): if `tour.tourType !==
   'self_guided'` AND the tour has a **usable group thread**, the rung goes to the
   tour's masked `relay_group` thread. "Usable" = `tour.groupThreadId` set, conversation
   exists, `type === 'relay_group'`, not `closed`, has a `pool_number` and a non-empty
   member roster (`resolveUsableGroup`, `:370-399`). Group sends are **direct per-member
   `adapter.sendMessage({ to: member.phone, from: poolNumber, body })`** from the pool
   number (`:467`) and are **deliberately NOT persisted as app messages** (`:412-423`) —
   they mirror the relay.intro announcement pattern. **Implication for the timeline:** a
   group-routed reminder has no 1:1 conversation and never lands as a stored message.
2. **Tenant 1:1 route** (`:259-288`): `self_guided`, OR any non-self_guided tour whose
   group is unusable, falls back here. Resolves `contact = contactsRepo.getById(
   tour.tenantId)` → `contact.phone` → `conversationsRepo.findByParticipantPhone(phone)`
   → first conv whose `type` is `'tenant_1to1'` or `'unknown_1to1'` (`:280-281`). Sends
   via `sendMessageService({ conversationId, body, author:'teammate', automated:true })`
   (`:310-315`). If no 1:1 conversation exists, the reminder is **skipped** (`:283-288`)
   — unlike placement nudges, tour reminders do NOT create the 1:1 on demand.

### 1.4 Cancel / reschedule semantics
- **Arm**: `armTourReminders(tour, now, deps)` (`:106-137`) loops all 5 kinds, computes
  `dueAt` per kind (see 1.6), **skips any rung whose `dueAt < now`** (`:127-130`;
  `confirmation` is always `now` so always armed), and `create`s a row per surviving
  rung. Called on tour **create** (`routes/tours.ts:210`) and on **reschedule/revival**
  (`routes/tours.ts:453`).
- **Reschedule = cancel-then-re-arm** (`routes/tours.ts:451-453`): on a time change or
  an explicit move into `scheduled`, it calls `cancelTourReminders(tourId)` THEN
  `armTourReminders(...)`. So the old ladder rows keep their `canceledAt` and a brand-new
  set of rows is created — **rows are never updated in place**; a reschedule leaves
  canceled rows + new pending rows for the same tour.
- **Cancel**: `cancelTourReminders(tourId)` → `tourRemindersRepo.cancelForTour(tourId)`
  (`jobs/tourReminders.ts:152-159`; repo `:182-218`) lists `byTour`, filters to pending
  (`sentAt === undefined && canceledAt === undefined`), and conditionally stamps
  `canceledAt` on each. Triggered when a tour goes `canceled`/`closed`/`toured`
  (`routes/tours.ts:454-462`). **Exception:** `no_show` is deliberately NOT cancel-swept
  — its pending `no_show_checkin` rung is the point.

### 1.5 Firing path + how `sentAt` is stamped
- Poller `runDueTourReminders(now, deps)` (`jobs/tourReminders.ts:207-230`). Registered
  as a **60s `setInterval`** in `app/src/worker.ts:123-127` (only when the worker runs a
  poll loop; deps built lazily at first poll, `:103-123`). Deterministic e2e/dev seam:
  `POST /__dev/tour-reminders/tick { now? }` runs exactly one pass
  (`app/src/routes/dev.ts:186-199`).
- `listDue(now)` (repo `:113-147`) queries `byDueAt` for `dueAt <= now` with a
  `FilterExpression` excluding rows that already have `sentAt` or `canceledAt`; paginated.
- **Claim-before-send**: `claimSend(reminderId, now)` (repo `:149-180`) atomically `SET
  sentAt` under `attribute_not_exists(sentAt) AND attribute_not_exists(canceledAt)`.
  `sentAt` doubles as the send marker — it is stamped **before** the provider call
  (`jobs/tourReminders.ts:298-305` for 1:1, `:436-443` for group). A lost claim (a
  concurrent tick, or a cancel that raced in) is a benign skip. There is no separate
  "delivered" timestamp on the row.

### 1.6 The rungs / kinds and their offsets (`computeDueAt`, `jobs/tourReminders.ts:65-84`)
| kind | dueAt offset relative to `scheduledAt` |
|------|-----------------------------------------|
| `confirmation` | `now` — immediate (always armed) |
| `day_before` | `scheduledAt − 24h` |
| `morning_of` | **08:00 UTC** on the calendar day of the tour |
| `en_route` | `scheduledAt − 2h` |
| `no_show_checkin` | `scheduledAt + 30m` |

Rungs whose computed `dueAt` is already past at arm time are skipped, so a
tour booked <24h out simply has fewer rows.

---

## 2. Placement application nudge — `placementNudges` table

A near-clone of the tour-reminder machinery (the repo header even says "rename-clone of
tourRemindersRepo", `placementNudgesRepo.ts:12-13`).

### 2.1 Row shape
`app/src/repos/placementNudgesRepo.ts:37-53`:
```ts
export interface PlacementNudgeItem {
  nudgeId: string;         // PK  (`nudge-${randomUUID()}`, :86)
  placementId: string;     // byPlacement GSI hash key
  kind: NudgeKind;         // enum, 4 values
  dueAt: string;           // ISO — byDueAt GSI range key
  _nudgePartition: 'nudges'; // byDueAt GSI hash key (fixed literal)
  sentAt?: string;         // ISO — set when sent (also claim marker)
  canceledAt?: string;     // ISO — set when canceled
  createdAt: string;
  [key: string]: unknown;
}
```
- **PK** `nudgeId`. **GSIs**: `byDueAt` (hash `_nudgePartition`='nudges', range `dueAt`),
  `byPlacement` (hash `placementId`) (`:5-8`, `:104-114`).
- **`kind` enum** (`:31-35`): `'receipt_check' | 'completion_check' | 'approval_check' |
  'rta_window_closing'`.
- Same state model: no `status`, no body on the row; state = presence of
  `sentAt`/`canceledAt`; body computed at send.

### 2.2 Body production — **canned template on the ladder config, NOT the row**
Bodies live on `NUDGE_RUNGS`, keyed by placement **stage** (`app/src/jobs/placementNudges.ts:56-81`):
```ts
export const NUDGE_RUNGS: Partial<Record<PlacementStage, NudgeRung>> = {
  awaiting_receipt:    { kind: 'receipt_check',      recipient: 'tenant',   delayMs: 24*HOUR,
    body: '[AUTO] Just checking in — did the rental application come through? Let us know if you need it re-sent.' },
  awaiting_completion: { kind: 'completion_check',   recipient: 'tenant',   delayMs: 24*HOUR,
    body: '[AUTO] How is the application coming along? Text us here if you are stuck on anything.' },
  awaiting_approval:   { kind: 'approval_check',     recipient: 'landlord', delayMs: 24*HOUR,
    body: '[AUTO] Checking in — any decision yet on the application we sent over?' },
  awaiting_landlord_submission: { kind: 'rta_window_closing', recipient: 'landlord', delayMs: 36*HOUR,
    body: '[AUTO] Friendly reminder — the 48-hour RTA window is closing. Have you been able to submit it?' },
};
```
The send uses `rung.body` resolved at poll time via `STAGE_BY_KIND[row.kind] → NUDGE_RUNGS`
(`:224-225`, `:349-354`). **Static per-kind, non-personalized** → a preview from `kind`
is faithful. (The `recipient` field also determines target party — see 2.3.)

### 2.3 Target conversation resolution
`processNudgeRow` (`app/src/jobs/placementNudges.ts:208-390`):
- **Recipient party** comes from `rung.recipient` (`:250-270`): `'tenant'` → `contactId
  = placement.tenantId`; `'landlord'` → resolve `unit = unitsRepo.getById(
  placement.unitId)` then `contactId = unit.landlordId`.
- Then `contact = contactsRepo.getById(contactId)` → `contact.phone` →
  `conversationsRepo.findByParticipantPhone(phone)` → first conv whose `type` matches the
  wanted type (`tenant_1to1` for a tenant rung, `landlord_1to1` for a landlord rung) or
  `unknown_1to1` (`:294-296`). **Never the masked group** (founder 2026-07-02, `:293`).
- **Creates the 1:1 on demand** when none exists (`:297-330`) via
  `conversationsRepo.createOrGetByParticipantPhone(phone, conversationTypeFor(contact))`,
  plus a best-effort display-name denorm. This is the landlord-1:1 fix
  (`placement-nudge-needs-landlord-1to1`): landlord rungs used to silently skip because
  all prior landlord traffic went through the pool number. **Contrast with tour
  reminders, which skip when no 1:1 exists.**
- Sends via `sendMessageService({ conversationId, body: rung.body, author:'teammate',
  automated:true })` (`:349-354`).

### 2.4 Cancel / reschedule semantics — **one row per stage; re-key on every move**
- **Arm**: `armNudgeForStage(placement, toStage, nowIso, deps)`
  (`jobs/placementNudges.ts:121-152`). It **ALWAYS `cancelForPlacement` first** (the old
  chase is moot the instant the stage moves), then creates ONE new row iff
  `NUDGE_RUNGS[toStage]` exists (terminal/rung-less stages are cancel-only). `dueAt =
  now + rung.delayMs`. So there is **at most one pending nudge row per placement**.
- Invoked as the best-effort `armStageNudge` hook on EVERY placement transition
  (`services/statusTransition.ts:422-428`, wired via `deps.armStageNudge`). A hook
  failure never fails the transition.
- **Cancel**: `cancelForPlacement(placementId)` (repo `:185-221`) — same list-pending +
  conditional-stamp-`canceledAt` pattern as tour reminders.
- **"Reschedule"** here is really "stage moved": there is no time-edit; any stage change
  cancels the old row and arms the new stage's row. Rows are never updated in place.

### 2.5 Firing path + `sentAt`
- Poller `runDuePlacementNudges(now, deps)` (`jobs/placementNudges.ts:183-206`), 60s
  `setInterval` in `worker.ts:156-160` (deps lazily built `:144-156`). Deterministic seam:
  `POST /__dev/placement-nudges/tick { now? }` (`routes/dev.ts:227-240`).
- `listDue` / `claimSend` / stamping are **identical in shape to §1.5** (repo
  `:116-183`). Extra guard: a **stale-stage** row (placement has left the rung's stage) is
  claimed-to-retire and NOT sent (`jobs/placementNudges.ts:236-246`), and an
  unknown-kind row is retired too (`:224-234`).

### 2.6 The rungs / kinds
| stage (arm trigger) | kind | recipient | delay after entry |
|---------------------|------|-----------|-------------------|
| `awaiting_receipt` | `receipt_check` | tenant | 24h |
| `awaiting_completion` | `completion_check` | tenant | 24h |
| `awaiting_approval` | `approval_check` | landlord | 24h |
| `awaiting_landlord_submission` | `rta_window_closing` | landlord | 36h |

v1 is a **single nudge per stage** (no repeats); the existing `stuck_placement`
machinery (§3) is the escalation (`jobs/placementNudges.ts:6-9`).

---

## 3. Placement `next_deadline` slot — a BOARD clock, NOT a texter

The issue explicitly asks whether the `statusTransition` "next_deadline" slot is a text
or just a board deadline. **Answer: purely a board deadline. Nothing polls it to send an
SMS.**

### 3.1 Row shape (one slot on the `placements` row)
`app/src/repos/placementsRepo.ts:56-118`:
- `PLACEMENT_DEADLINE_TYPES` (`:56-69`): `'tour_reminder' | 'rta_window' |
  'voucher_expiration' | 'stuck_placement' | 'follow_up'` (that last one appears in
  `today.ts:104` as well).
- Fields `next_deadline_type?` + `next_deadline_at?` (ISO), a **sparse composite** on the
  `byNextDeadline` GSI. They move **both-or-neither** only through `setNextDeadline`
  (`:204-217`, `:359`); `update()` refuses them (`:319-323`) to avoid a half-set,
  silently-unqueryable index row. A placement holds **at most one** deadline — the single
  most-urgent pending clock (`:56-58`).

### 3.2 It never sends anything
- The only readers of the `byNextDeadline` GSI are the **Today board** route
  (`routes/today.ts:302`, `:401`, via `placements.listByNextDeadline`) and the placement
  list filter (`routes/placements.ts:404`). There is **no poller and no job** that reads
  `byNextDeadline` and calls a send service — grep for `listByNextDeadline`/`byNextDeadline`
  finds only route reads. So these deadlines render as urgency chips on the dashboard; a
  human acts on them. No `[AUTO]` text is emitted from this slot.

### 3.3 Who SETS which type — and the `tour_reminder` / `voucher_expiration` orphans
`statusTransition.ts` is the only writer of `setNextDeadline` in a service:
- `stuck_placement` — `scheduleStuckNudge` sets `{ type:'stuck_placement', at: now +
  STAGE_STUCK_THRESHOLDS[toStage] }` when no hard-clock deadline holds the slot
  (`:257-268`).
- `rta_window` — entering `awaiting_landlord_submission` sets `{ type:'rta_window', at:
  now + 48h }` (`:377-381`); leaving that stage clears it (`:398-406`).
- **`tour_reminder` and `voucher_expiration` are NEVER SET by any current code path.**
  They appear only in (a) the `HARD_CLOCK_DEADLINE_TYPES` never-clobber set
  (`:40-44`), (b) comments, and (c) Today's label map (`today.ts:98-120`). A repo-wide
  grep for the string `'tour_reminder'` finds no `setNextDeadline({ type:'tour_reminder' …})`
  writer. **Confirmed orphan (the issue's suspicion):** now that tours own their own
  reminder ladder (§1), the placement `tour_reminder` deadline type is dead — nothing
  writes it. `voucher_expiration` is likewise unwritten today (no current setter). The
  manual `PATCH /placements/:id/deadline` route (`routes/placements.ts:749-760`) can set
  ANY valid type including `tour_reminder`, but no automated flow does.

**Planner takeaway:** "next tour reminder" on the Today board should read from the tour
ladder (§1) rather than this orphan slot (see `case-single-next-deadline-slot.md`).

---

## 4. `messaging.retrySend` — scheduled, but ephemeral (no durable dueAt row)

`app/src/jobs/retrySend.ts`. This IS a future-dated outbound send, but it is **not a
durable queryable row** — it is a job envelope living in SQS/EventBridge, so it can't be
listed for a contact the way §1/§2 rows can.

- **Trigger**: the Twilio status webhook enqueues one backed-off retry on a transient
  failure (30003). `enqueueSendRetry` → `jobs.enqueue(RETRY_SEND_JOB, payload, { runAt:
  now + retryBackoffMs(attempt) })` (`:62-67`). Backoff = 60s/120s/240s for attempts 1–3
  (`:29-32`), capped at `MAX_SEND_RETRY_ATTEMPTS = 3` (`:27`).
- **Payload** (`:34-40`): `{ providerSid, conversationId, attempt }` — **IDs only, no
  body** (PII note `:8-10`).
- **Body fidelity**: the handler **re-reads the original message body/media from the
  `messages` table** by `providerSid` at run time (`:87`, `:129-135`) — so it is always
  the faithful current body, never a stale copy. It keeps the original author and sends
  `automated:true`.
- **Transport**: rides the generic scheduler (§5 below), NOT a per-message DynamoDB row.
  It won't appear as a queryable "future item" without a new index. Because the backoff
  is ≤240s, these are effectively near-immediate and low-value to surface as "upcoming".

## 5. `adapters/scheduler.ts` — the transport, not a message scheduler

`app/src/adapters/scheduler.ts` is the delayed-job plumbing behind `jobs.enqueue()`, not
a message-scheduling feature in itself:
- ≤12min (`JOBS_SQS_MAX_DELAY_SECONDS=720`) delayed jobs → SQS `SendMessage` with
  `DelaySeconds` (`SqsOutboundQueueAdapter`, `:284-310`); local/tests use
  `InProcessOutboundQueueAdapter` (`:125-172`).
- Longer horizons → `EventBridgeSchedulerAdapter.scheduleOnce` creates a one-off
  `at(...)` schedule delivering to the jobs queue (`:229-253`), `ActionAfterCompletion:
  DELETE`. **No Phase-1 caller uses the long-horizon EventBridge path** — the comment
  says "future long-horizon jobs; no Phase-1 callers" (`:35-36`). Consumers of the
  short-delay path are `retrySend` (§4) and relay/broadcast fan-out continuations
  (5/10/20s). None of these are durable, queryable, contact-addressable future rows.

## 6. Broadcasts — NOT future-scheduled

`app/src/repos/broadcastsRepo.ts`: `BroadcastStatus = 'draft' | 'sending' | 'sent' |
'failed'` (`:37`) — there is **no `send_at`/`scheduledAt` and no `scheduled` status**.
A broadcast is created `draft` (`:317`) and fanned out immediately on send; grep for
`schedule`/`send_at` in `routes/broadcasts.ts` returns nothing. So broadcasts are not a
future-scheduled-send source for this feature.

---

## 7. Cross-cutting: suppression honesty at send time (all SMS mechanisms)

Every mechanism that goes through `sendMessageService` (§1 1:1 route, §2, §4) is gated at
send time by `app/src/services/sendMessage.ts`. A scheduled row can be pending and
looking deliverable, yet be **refused** when it fires. `SendRefusedError` codes
(`sendMessage.ts:40-131`):
- `sms_sending_disabled` (pre-A2P global kill switch),
- `contact_opted_out` (`sms_opt_out` on conversation and/or contact, `:229`),
- `breaker_open` (per-conversation automated-send breaker, automated-only `:260-275`),
- `manual_mode` (conversation is humans-only),
- `contact_no_consent` (NOT thrown for automated system sends — `automated:true` bypasses
  the JIT consent gate, `:243-250`),
- plus `RelaySendNotSupportedError` — `sendMessageService` **throws** for `relay_group`
  conversations (`:223`), which is exactly why §1's group route uses the raw adapter
  instead of the send service.

The reminder/nudge pollers catch `SendRefusedError`, keep the already-stamped `sentAt`
claim, and do **not** retry (`jobs/tourReminders.ts:326-350`,
`jobs/placementNudges.ts:366-389`). **Planner takeaway:** a future-item preview must show
these can be **suppressed/skipped**, not falsely promise delivery — and the honest state
is only knowable at send time (opt-out/breaker/manual can flip between arm and fire).

## 8. Deterministic test seams (for e2e coverage of any new surface)

- `POST /__dev/tour-reminders/tick { now? }` → one `runDueTourReminders(now)` pass
  (`routes/dev.ts:186-199`).
- `POST /__dev/placement-nudges/tick { now? }` → one `runDuePlacementNudges(now)` pass
  (`routes/dev.ts:227-240`).
- `GET /__dev/outbox` asserts what SMS would have gone out. All triple-gated
  hermetic-LOCAL-only.

## 9. Existing read capability vs. gaps (for the two real mechanisms)

| capability | tour reminders | placement nudges |
|------------|----------------|------------------|
| list-all-for-parent repo method | `listByTour(tourId)` + `byTour` GSI (`tourRemindersRepo.ts:101-111`) | `listByPlacement(placementId)` + `byPlacement` GSI (`placementNudgesRepo.ts:104-114`) |
| HTTP route exposing it | **none** — data-layer only | **none** |
| client type / fetcher | none | none |
| query BY CONVERSATION / phone | **none** — rows key on `tourId`/`placementId`, not conversationId. Resolving "which scheduled sends target this 1:1 thread" requires resolving tour→tenant→phone→conv (or placement→party→phone→conv) — the same resolution the poller does at fire time (§1.3 / §2.3), which is **not** a cheap index lookup. |

This is the core build gap: to thread scheduled items into the contact timeline
(issue Part B), the plan needs either a new by-conversation/by-contact read that mirrors
the poller's target resolution, or a denormalized target-conversation field written at
arm time. Group-routed tour reminders (§1.3) have **no** 1:1 conversation and are not
stored as messages — decide whether/where they surface.
