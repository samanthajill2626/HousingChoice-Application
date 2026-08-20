---
id: manual-only-nudge-chip-still-says-sending-shortly
title: "Manual-only application nudges still chip 'sending shortly' forever - the placement card promises a send that will never happen"
type: bug
severity: med
status: open
area: app
created: 2026-08-20
refs: app/src/routes/placementNudges.ts, dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64
---

**Problem.** Application nudges have been manual-only since 2026-08-18
(`MANUAL_ONLY_NUDGE_KINDS`, founder decision): the ladder still arms a rung on
every stage entry, but the poll never sends one. The rows are deliberately LEFT
PENDING rather than claim-skipped, so "Send now" keeps working.

Nothing tells the UI that, though. `routes/placementNudges.ts` computes its
suppression estimate from recipient/thread state only, so a held-back rung comes
back with no estimate at all - and once its `dueAt` passes, the placement hub's
Deadlines and nudges card chips the amber "sending shortly" for a send that is
never coming. That is exactly the perpetual-"sending shortly" lie `claimSkip`
was built to end, reintroduced through a different door: every armed nudge on
every placement now carries it, permanently, for as long as "temporary" lasts.

The same defect existed on the tour ladder and was fixed on 2026-08-20 when tour
reminders were paused - the machinery is already in place and unused here.

**Suggested fix.** One line in the nudge read route, mirroring
`routes/tourReminders.ts`: derive `paused` from the rung's kind against
`MANUAL_ONLY_NUDGE_KINDS` and pass it into `evaluateScheduledSendSuppression`,
which already ranks the `paused` reason (below every reason that would also
refuse a human send, above quiet hours). `DeadlinesNudgesCard`'s
`NUDGE_SUPPRESSION_LABELS` already carries the `paused` label - it is currently
unreachable, and this is what would reach it. `suppressionLead` already renders
it as "Paused - send manually".

Check the contact-page Upcoming bucket in the same change:
`routes/contactTimeline.ts` previews both ladders, and its nudge walk has the
same gap (its tour walk was fixed on 2026-08-20).
