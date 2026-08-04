---
id: placement-nudge-suppression-opt-out-parity
title: Placement-nudge suppression estimate skips per-recipient opt-out and manual mode
type: improvement
severity: low
status: open
area: app
created: 2026-08-03
refs: app/src/routes/placementNudges.ts, app/src/routes/tourReminders.ts, app/src/routes/contactTimeline.ts
---

**Problem.** `GET /api/placements/:placementId/nudges` gained its FIRST
suppression estimate with quiet hours (spec `docs/superpowers/specs/2026-08-03-quiet-hours-design.md`),
but it is a SUBSET of what the other two evaluator callers compute. It feeds
`evaluateScheduledSendSuppression` only the inputs already in hand for that
request:

- `quietNow` (org quiet-hours window vs. the server wall clock),
- `smsSendingEnabled` (the kill switch, from config),
- `staleStage` (the placement is already loaded).

It deliberately leaves `convOptOut`, `contactOptOut` and `aiMode` **undefined**.
Those three live on the RECIPIENT's 1:1 conversation/contact, and a nudge
ladder's recipient varies per rung (`receipt_check`/`completion_check` route to
the tenant; `approval_check`/`rta_window_closing` route to the landlord via
`unit.landlordId`), so resolving them is a new per-row IO chain
(units -> contacts -> `findByParticipantPhone`) that this read does not do today.

Consequence: a nudge to an opted-out recipient, or into a conversation in
`manual_mode`, shows NO chip on the placement detail hub, while the same person's
tour reminders (`routes/tourReminders.ts`) and their contact timeline
(`routes/contactTimeline.ts` -> `gatherUpcoming`) DO show `contact_opted_out` /
`manual_mode`. The nudge card is honest about quiet hours and stale stages and
silent about the harder reasons - a consistency gap, not a send-path bug (the
send itself is still refused correctly by `sendMessageService` at fire time).

**Suggested fix.** Reuse the poller's recipient resolution
(`jobs/placementNudges.ts` `processNudgeRow` steps 4-6, mirrored by the router's
existing `recipientContactId` helper) to resolve tenant vs. landlord contact +
1:1 conversation per DISTINCT recipient (at most two per placement, so cache the
lookups per request), then pass `convOptOut` / `contactOptOut` / `aiMode` into
the evaluator alongside the inputs already threaded. That would make the nudge
estimate exactly as complete as the tour-reminder one. Add the corresponding
cases to `app/test/placementNudgesApi.test.ts`.
