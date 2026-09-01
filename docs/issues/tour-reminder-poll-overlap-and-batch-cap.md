---
id: tour-reminder-poll-overlap-and-batch-cap
title: The tour-reminder poll has no re-entrancy guard and listDue has no batch cap - benign today, but Phase B is what makes the batch non-empty again
type: debt
severity: low
status: open
area: app/jobs
created: 2026-09-01
refs: app/src/worker.ts:349, app/src/jobs/tourReminders.ts, app/src/repos/tourRemindersRepo.ts
---

**Problem.** `startPoll('tour reminder', ...)` (`app/src/worker.ts:349`) fires
`runDueTourReminders` on a fixed interval (`WORKER_POLL_INTERVAL_MS`, 30s by
default) with no overlap guard, and `listDue` returns every due row with no
cap. Both are PRE-EXISTING and were moot from 2026-08-20 to 2026-08-31 because
`MANUAL_ONLY_REMINDER_KINDS` held every auto-armed kind back, so `dueRows` was
always empty. Phase B (`feat/tour-reminder-ladder-phase-b`) lifts that pause,
so a tick can now do real per-row work - a tour read, name resolution, a claim
and a send - and after a worker outage the first tick sees the whole backlog.

Why it is BENIGN today, stated so nobody escalates it: every write on the path
is conditional (`claimSend` / `claimSkip`), so an overlapping tick loses the
claim race and sends nothing twice; the A2P token bucket paces the actual SMS
legs; and the fire-time past-tour gate retires stale backlog rows before any
send. Overlap costs duplicate reads, not duplicate texts.

**Suggested fix.** (a) A simple in-flight flag in `pollLoop` / `startPoll` so a
slow tick is skipped rather than overlapped - the same shape every other
poll in the worker would benefit from. (b) A `limit` on `listDue` with the
poll draining in pages, so a very large backlog is bounded per tick. Neither
is urgent; both belong together. Found by the plan-blind adversarial review of
Phase B (`docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/planner-review-adversarial.md`, A9).
