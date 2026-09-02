---
id: full-seed-ladder-fires-in-live-dev
title: The full-profile demo seed's reminder ladder now actually fires in a LIVE-comms dev loop, against +1555 fixture numbers
type: debt
severity: low
status: open
area: app/seed
created: 2026-09-01
refs: app/src/lib/seed/matrix.ts, app/src/lib/seed/live.ts, app/src/jobs/tourReminders.ts
---

**Problem.** The `full` reseed profile (the demo world) seeds tours with future
`scheduledAt`s and a pending reminder ladder, on contacts carrying `+1555...`
fixture phones. From 2026-08-20 to 2026-08-31 nothing fired because
`MANUAL_ONLY_REMINDER_KINDS` held every auto-armed kind back. Phase B
(`feat/tour-reminder-ladder-phase-b`) lifts the pause, so a developer running
`npm run dev` in LIVE mode (real Twilio - see `dev-live-comms` in the RUNBOOK)
on the demo seed will now have the worker attempt real sends to those fixture
numbers as their dueAts pass.

Impact is noise, not cost or harm: Twilio rejects a `+1555` number as invalid
(error 21211), no message leaves the network, and the failed leg is logged and
the rung marked. But it is a new source of failed-send ERROR lines and alarm
feed in a live dev loop that did not exist before, and it is the same class as
the standing foot-gun that live-mode local dev shares the dev S3 bucket. The
`lean` (e2e) profile is unaffected: the e2e stack runs mock comms.

**Suggested fix.** Either seed the demo ladder's rungs already-terminal (sent
or skipped) in the `full` profile, or have the live-mode dev boot log a loud
one-line warning when it finds pending reminder rows on fixture-pattern phones.
Filed from the plan-blind adversarial review of Phase B (A17); not a merge
blocker.
