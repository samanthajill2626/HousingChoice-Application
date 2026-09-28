---
id: share-retry-rollup-lost-past-reread-bound
title: A share slot or ledger write lost past its retries (a retry receipt's rollup, a reconcile or job-arm slot write, a ledger race) is healed only by a re-run of the repair - no schedule, no alarm
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-09-28
refs: app/src/routes/webhooks/twilio.ts:3955, app/src/services/shareAttemptOutcome.ts:262, app/src/services/shareAttemptOutcome.ts:285, app/src/services/shareLedger.ts:192, app/src/routes/webhooks/twilio.ts:3582, app/scripts/repair-share-outcomes.ts, RUNBOOK.md
---

**Found by.** `feat/share-sent-outcome` spec section 8 ("A lost retry
rollup", "A dropped slot write at one of the job's two arms" as amended, "A
lost ledger race past the retry bound"), accepted there; the plan-blind
adversarial review (round 1, ADV-2 (b)) found the webhook's retry path
single-shot and no operator trigger for the "the repair heals it" lines. Fix
wave 1 bounded the webhook path and named the lines in the RUNBOOK; the
residual stays and is filed here (plan T15). Anchors at that fix wave.

**Problem.** Every live writer of a share slot or its ledger row gives up
after a small bound and leaves the slot or the pair as it was:

- the status webhook routes a retry row's receipt through the bounded
  transition (`app/src/routes/webhooks/twilio.ts:3955`): a thrown write is
  retried twice, then ONE ERROR `share slot write failed after retries`
  (`app/src/services/shareAttemptOutcome.ts:285`); a condition that keeps
  losing to a concurrent writer past 1 + 3 writes is `lost` with ONE WARN
  `share attempt outcome: the slot write lost its condition past the re-read
  bound` (`:262`); anything else is the rollup's own ERROR
  `broadcast delivery rollup failed` (`twilio.ts:3582`). The webhook answers
  200 either way, so the carrier never redelivers;
- the reconcile's two sites and the retry job's two arms drop a failed slot
  write the same way (spec section 8, amended at the plan);
- a ledger write lost past its re-read bound is ONE ERROR `share ledger: the
  entry write lost its condition past the re-read bound`
  (`app/src/services/shareLedger.ts:192`).

Then the retry's row exists but the slot never learns it. Past D1's 24-minute
row bound the recipient reads the slot's last outcome: a FINAL failure
although the retry delivered - the retry-side twin of the original's
stuck-`sent` class - so the composer does not flag them "Already sent" and the
next blast of the property can text them again; "Properties sent" and "Sent to
N tenants" miss them too.

**The only healer is a re-run of the repair** (`app/scripts/repair-share-outcomes.ts`,
census then `--apply`), which re-derives every slot from its rows and records
and the ledger from the slot. Nothing schedules it and one such line trips no
alarm (`hc-<env>-error-logs` needs 5 errors in 5 minutes); the RUNBOOK section
"Share outcomes repair (2026-09-28)" names every line that means "re-run the
repair" and gives the Logs Insights query.

**Why accepted.** Each case needs a DynamoDB fault that survives the SDK's
own retries and the writer's bound (or a concurrent writer that wins four
times running); the permanent case (the 400 KB item limit on a share stored
above today's 1000-recipient cap) cannot be healed by any retry, and the
repair names it on its own ERROR line (`slotsFailed`). A double text is at
most HIGH on the standing scale; this is LOW.

**Directions (not taken).** A scheduled census that alarms on a non-zero
`*To*` counter; a metric filter on the lines above; or a durable outbox for
share slot writes that a worker drains.

**Related.** [broadcast-30003-retry-never-updates-slot](./broadcast-30003-retry-never-updates-slot.md)
(resolved by the branch), [share-retry-late-send-flag-window](./share-retry-late-send-flag-window.md),
[send-attempt-sweeper](./send-attempt-sweeper.md).
