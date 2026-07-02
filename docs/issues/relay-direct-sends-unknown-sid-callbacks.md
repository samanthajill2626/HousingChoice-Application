---
id: relay-direct-sends-unknown-sid-callbacks
title: Unpersisted relay direct sends (intros, group reminders) log error-level unknown-SID status callbacks
type: debt
severity: low
status: open
area: app
created: 2026-07-02
refs: app/src/jobs/relayFanOut.ts, app/src/jobs/tourReminders.ts, app/src/routes/webhooks/twilio.ts
---

**Problem.** The relay `[AUTO]` intro messages and (since the tours build) group-routed
tour reminders are sent **directly via the messaging adapter** from the pool number and
are deliberately NOT persisted as app messages (system-announcement precedent — there is
no source message row). Their provider delivery **status callbacks** therefore find no
`sid#` pointer and log `status callback for unknown provider SID` at error level — once
per member per send.

**Impact.** Benign but noisy: every tours e2e run and every real group send emits
error-level lines that (a) pollute the error-log alarm signal and (b) read as failures to
anyone triaging logs. The class predates tours (relay intros always did this); group
reminders multiply it.

**Suggested fix (either).**
1. Teach the status-callback handler to recognize-and-downgrade: when the SID is unknown
   AND the `From` is a pool number, log at debug ("unpersisted relay system send —
   expected") instead of error.
2. Or persist a minimal system-message row for direct relay sends so callbacks resolve
   (heavier; changes the "announcements aren't messages" decision).

Until then: treat these lines as known noise in e2e logs, not a failure signal (documented
in the playbook's tours section).
