---
id: scheduled-send-surface-cues
title: Surface a "next scheduled send" cue beyond the timeline — Today queue + tour/placement rows
type: improvement
severity: low
status: open
area: dashboard
created: 2026-07-03
refs: docs/issues/scheduled-message-visibility.md, dashboard/src/routes/tours/RemindersPanel.tsx, dashboard/src/routes/contact/ScheduledCard.tsx
---

**Problem.** [scheduled-message-visibility](./scheduled-message-visibility.md) made scheduled
outbound sends (tour reminders + placement nudges) visible in two deep surfaces: the tour
detail Reminders panel (Part A) and the contact 1:1 timeline's pinned "Upcoming" section
(Part B). It deliberately scoped OUT the lighter "at-a-glance" cues the issue floated under
"reach beyond the timeline": a compact **next reminder/nudge** chip on the **Today** queue and
on the **tour / placement rows** in their list views. A navigator scanning Today or a list
can't yet see "next text goes out in 3h" without opening the detail.

**Suggested fix.** Reuse the `DeadlineChip`-style affordance already in the placements feature.
The read is cheap: the tour Reminders endpoint (`GET /api/tours/:id/reminders`) already returns
a `next` field; the timeline gather already computes per-contact upcoming items. A row/queue
chip can render `next.dueAt` + kind. Decide whether Today reads the tour ladder directly (see
[today-next-tour-reminder-from-ladder](./today-next-tour-reminder-from-ladder.md)) or a
dedicated lightweight "next send" read. Keep suppression honesty (a suppressed next-send should
not read as a confident promise).
