---
id: error-log-alarm-blind-to-slow-failures
title: The error-log alarm cannot see a slow, steady failure - a full pipeline outage never paged
type: bug
severity: high
status: resolved
area: observability
created: 2026-08-16
resolved: 2026-08-17
refs: infra/modules/observability/main.tf
---

**Resolution (2026-08-17).** The companion alarm
(`${name_prefix}error-logs-sustained`: threshold 1, `Sum(ErrorLogs)`, 300s
periods, 3-of-3, `treat_missing_data = notBreaching`) is merged to `main` in
`infra/modules/observability/main.tf` and APPLIED to dev and prod (operator
confirmed 2026-08-17). The burst alarm keeps its own threshold and was not
retuned, per the decision recorded below. Branch `fix/orphan-logs` has been
retired; read the module for current truth.

The give-up paths that this alarm was the missing surface for were promoted to
ERROR under
[`give-up-paths-inconsistently-levelled-and-unsurfaced`](./give-up-paths-inconsistently-levelled-and-unsurfaced.md),
so the existing `{ $.level >= 50 }` metric filter now feeds them into it with no
further terraform. The DLQ-companion question below was decided NOT to add, and
the `NumberOfMessagesSent` note is kept as guidance for future SQS alarms -
neither is outstanding work.

**Problem.** `hc-<env>-error-logs` fires on `Sum(ErrorLogs) >= 5` in a single
300s period, 1 evaluation period. That shape only detects a BURST. A failure
that produces errors steadily but slowly never fills one bucket, so it never
pages - no matter how long it runs or how badly it is breaking things.

This is not hypothetical. On 2026-08-16 the worker's
`voice.reconcileTranscript` job failed five consecutive times (17:32:34,
17:34:34, 17:36:34, 17:38:34, 17:40:34 UTC) with
`jobs.enqueue: no OutboundQueueAdapter configured`. Five ERROR logs, spaced
120s apart by the SQS visibility timeout, so each 5-minute bucket held only
2-3. `hc-prod-error-logs` stayed OK throughout; its `StateUpdatedTimestamp`
was still 2026-08-15. The underlying defect had disabled EVERY worker-side job
continuation and retry in production (see the fix at a755c6f8), and the alarm
that exists to catch exactly this said nothing. It was found only because a
human noticed a voicemail stuck on "Transcribing..." in the dashboard.

The 120s spacing is the general case, not a coincidence: an SQS-redelivered
job handler is rate-limited by the queue's visibility timeout, so ANY
persistently failing job produces errors at a cadence the current threshold is
structurally unable to see. The louder the failure is over time, the less
likely it is to trip this alarm relative to a brief harmless blip.

**What DID work, and why this is still worth fixing.** `hc-prod-jobs-dlq-depth`
(`Maximum(ApproximateNumberOfMessagesVisible) > 0`, 300s, 1 period) caught it:
the exhausted envelope landed in the DLQ around 17:42 UTC and the alarm went to
ALARM at 17:45:23 UTC, where it remains. So the incident WAS observable - just
~20 minutes after the first error, via the queue rather than via the errors
themselves, and only because the job happened to exhaust `maxReceiveCount`. A
failing path that retries forever, swallows its error, or is driven by a poll
loop instead of SQS produces no DLQ message at all and would still be silent.
The error-log alarm is the control that is supposed to cover that gap, and it
did not.

**Suggested fix.** Add a companion alarm for SUSTAINED low-rate errors rather
than retuning the burst one - the burst alarm is still useful on its own terms.
Something like `Sum(ErrorLogs) >= 1` with `EvaluationPeriods` 3 of 3 (or M-of-N
such as 3-of-5 to tolerate a single stray) over 300s: any error recurring
across ~15 minutes pages, while a one-off stays quiet. That would have fired
around 17:42 UTC on the log lines themselves, independent of the DLQ.

Note for anyone building further SQS alarms: a redrive to the DLQ does NOT
publish `NumberOfMessagesSent` on the destination queue. That metric reported
no datapoints across the whole incident window even though the DLQ demonstrably
received a message and still holds it. Alarm on the DEPTH metric
(`ApproximateNumberOfMessagesVisible`), as the existing DLQ alarm correctly
does - a sent-rate alarm on a DLQ would never fire.

Both `hc-dev-*` and `hc-prod-*` carry the same alarm definitions, so any change
applies to both.

**Decided 2026-08-16 (operator).** 3-of-3 over 300s at threshold 1, added as a
SECOND alarm (`${name_prefix}error-logs-sustained`); the burst alarm keeps its
own threshold and was not retuned. 3-of-5 was considered and rejected as a
fuzzier signal for little extra reach.

**DLQ companion: decided NOT to add.** The depth alarm already fires on any
non-empty DLQ with a single evaluation period and was observed working during
this incident (above), and the note about `NumberOfMessagesSent` confirms a
sent-rate alarm on a DLQ would never fire at all. Nothing to add there.
