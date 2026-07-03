---
id: scheduled-message-visibility
title: Surface scheduled outbound texts (tour reminders, placement nudges) — as a reminder ladder AND as future items in the contact's 1:1 timeline
type: improvement
severity: high
status: open
area: app+dashboard (comms / tours / placements)
created: 2026-07-03
refs: app/src/jobs/tourReminders.ts, app/src/repos/tourRemindersRepo.ts, app/src/jobs/placementNudges.ts, app/src/repos/placementNudgesRepo.ts, app/src/routes/contactTimeline.ts, app/src/routes/tours.ts, dashboard/src/api/types.ts:1099, dashboard/src/routes/contact/Timeline.tsx, dashboard/src/routes/tours/TourDetail.tsx
---

**Problem.** The system schedules a fair amount of outbound SMS ahead of time — tour
reminder ladders and placement nudge ladders — and **none of it is visible before it
fires.** A navigator cannot see what is queued to go out, what it will say, or when.
Today the only trace of a scheduled text is the `[AUTO]` message that appears in the
conversation *after* it has already been sent; anything still upcoming (or canceled by a
reschedule) is invisible outside the DynamoDB rows and log lines. This is a trust/visibility
gap: staff can't confirm a tenant is actually being reminded, can't anticipate what's next,
and can't verify that a reschedule re-armed the ladder correctly.

There are two coupled deliverables. They share the same underlying data (durable "scheduled
send" rows with a `dueAt`, a `kind`, a templated body, and `sentAt`/`canceledAt` state), so
they should be designed together.

---

### Part A — Tour reminder ladder view (on the tour)

The tour detail page (`dashboard/src/routes/tours/TourDetail.tsx`, `/tours/:tourId`) shows
Status / Scheduled / Type / exit-gate but **nothing about reminders**, even though a full
5-rung ladder is armed on scheduling (`armTourReminders` in `app/src/jobs/tourReminders.ts`):
`confirmation` (immediate), `day_before` (−24h), `morning_of` (08:00 day-of), `en_route`
(−2h), `no_show_checkin` (+30m). Each row (`tourRemindersRepo`) carries `dueAt`, `kind`,
`sentAt?`, `canceledAt?`.

- The repo already has `listByTour(tourId)` + a `byTour` GSI — but **no HTTP route exposes
  it** and there is no client type/fetcher. So the read capability exists at the data layer
  only.
- Add a read endpoint (e.g. `GET /api/tours/:id/reminders`) and a **Reminders panel** on the
  tour detail: each rung with its state — **upcoming** (with the scheduled fire time),
  **sent** (with the sent-at time), or **canceled** — and the body it will/did send. Show the
  **next** reminder prominently. Reflect reschedule (old ladder canceled, new armed) and cancel.

### Part B — Future / scheduled messages in the contact's 1:1 comms timeline (the bigger ask)

Anywhere an outbound text is scheduled to send in the future — a tour reminder, a placement
nudge, or any other scheduled auto-send — it should appear in that contact's **1:1
communications timeline as a distinct FUTURE item**, clearly marked as not-yet-sent, showing:

1. **that it will be sent** (a future/pending affordance, unmistakably different from a
   delivered message),
2. **what it will say** (the actual body that will send — not a stale guess), and
3. **when it will send** (the scheduled instant, in the reader's timezone).

When the item fires it should transition in place to a normal sent message (ideally live via
SSE); when it is canceled/rescheduled (e.g. a tour reschedule), the future item should update
or disappear accordingly.

**Known scheduled-send sources** (the implementer must sweep for the complete set — do not
assume these are all):
- **Tour reminders** — `app/src/jobs/tourReminders.ts` + `app/src/repos/tourRemindersRepo.ts`.
- **Placement nudges** — `app/src/jobs/placementNudges.ts` + `app/src/repos/placementNudgesRepo.ts`
  (tenant rungs + landlord-facing rungs `approval_check` / `rta_window_closing`; target 1:1
  resolved per-contact — see [placement-nudge-needs-landlord-1to1](./placement-nudge-needs-landlord-1to1.md)).
- Sweep also: `app/src/services/statusTransition.ts` (stuck-placement nudge / `next_deadline`
  slot — is it a *text* or just a board deadline?), `app/src/jobs/retrySend.ts`,
  `app/src/adapters/scheduler.ts`, and any other durable `dueAt`/`send_at` row.

**Integration point.** The comms timeline is a `kind`-discriminated union
(`message | call | milestone`) built server-side in `app/src/routes/contactTimeline.ts` and
typed in `dashboard/src/api/types.ts` (`TimelineMessage` et al., ~line 1099), rendered by
`dashboard/src/routes/contact/Timeline.tsx`. A future item is a new member — e.g.
`kind: 'scheduled'` — merged into the timeline from the scheduled-send rows for that contact's
conversation(s), rendered distinctly and ordered by its `dueAt`.

---

**Design questions / decisions to resolve in the plan (not exhaustive):**

- **Ordering & placement.** Future items are in the *future*, so a purely chronological stream
  would sort them after the newest message. Decide the rendering: an "Upcoming" affordance
  pinned at the bottom (newest-at-bottom stream) or a distinct section, vs. inline-by-time.
- **Body fidelity.** Some bodies are canned `[AUTO]` templates; confirm whether any are
  personalized at send time. The preview must show what **will actually send** (or a faithful,
  clearly-labeled render), never a misleading stale string.
- **Suppression honesty.** A scheduled send to a now-opted-out / do-not-contact / breaker-tripped
  / manual-mode contact **won't go out** (`sendMessageService` gates at send time). The future
  item should reflect that it will be **suppressed/skipped**, not falsely promise delivery.
- **Which conversation.** A contact can have multiple 1:1 threads (one per number) and relay
  group threads. Decide which thread a given scheduled item belongs to (mirror how the poller
  resolves its target today) and only show it there.
- **Live updates.** Emit/consume events so future→sent, reschedule, and cancel reflect without
  a manual refetch (the timeline already refetches on `message.persisted`; scheduling changes
  need their own signal).
- **Reach beyond the timeline.** Consider a compact "next reminder/nudge" cue on the Today
  queue and/or the tour + placement rows (a `DeadlineChip`-style affordance already exists).
- **Placement `tour_reminder` orphan.** Now that tours own their reminder ladder, the placement
  `tour_reminder` deadline type is essentially unused; decide whether "next tour reminder" in
  Today should read from the tour ladder instead (see the deadline-setters backend work and
  [case-single-next-deadline-slot](./case-single-next-deadline-slot.md)).

**Why it's more than a frontend.** It needs: read endpoints over the scheduled-send rows (tours
+ nudges, ideally a unified "scheduled sends for this conversation" read), a new timeline item
kind threaded through the server timeline builder + client types + renderer, live-update events
on schedule/cancel/send, and honest suppression/consent reflection — plus e2e coverage using
the existing deterministic seams (`POST /__dev/tour-reminders/tick`, the placement-nudge tick).

**Related.** [placement-nudge-needs-landlord-1to1](./placement-nudge-needs-landlord-1to1.md),
[case-single-next-deadline-slot](./case-single-next-deadline-slot.md),
[transition-service-no-activity-milestones](./transition-service-no-activity-milestones.md),
[relay-group-no-dashboard-surface](./relay-group-no-dashboard-surface.md).
