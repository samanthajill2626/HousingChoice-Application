---
id: error-log-alarm-blind-to-slow-failures
title: The error-log alarm cannot see a slow, steady failure - a full pipeline outage never paged
type: bug
severity: high
status: open
area: observability
created: 2026-08-16
refs: infra/
---

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

**Suggested fix.** Add a companion alarm for SUSTAINED low-rate errors rather
than retuning this one - the burst alarm is still useful on its own terms.
Something like `Sum(ErrorLogs) >= 1` with `EvaluationPeriods` 3 of 3 (or M-of-N
such as 3-of-5 to tolerate a single stray) over 300s: any error recurring
across ~15 minutes pages, while a one-off stays quiet. Consider the same shape
for the jobs DLQ, whose depth alarm has likewise not changed state since
2026-06-12.

Worth checking at the same time whether a job that exhausts `maxReceiveCount`
and lands in the DLQ reliably raises `NumberOfMessagesSent` on
`hc-prod-jobs-dlq`; during this incident the queue drained to 0 with no DLQ
datapoint recorded in the window, which was never explained.

Both `hc-dev-*` and `hc-prod-*` carry the same alarm definitions, so any change
applies to both.
