---
id: extraction-stranded-claim-no-reaper
title: A process dying mid-run strands its extraction row claimed, with no reaper to re-arm it
type: bug
severity: med
status: open
area: app/extraction
created: 2026-08-16
refs: app/src/repos/extractionRepo.ts:315, app/src/repos/extractionRepo.ts:229, app/src/jobs/extraction.ts:400
---

**Pre-existing.** This is NOT created by the manual-extraction-trigger feature.
Found while specifying the withdrawn in-process runner (design section 9, item 3)
and filed rather than fixed.

**Problem.** `claim` is the point of no return. On success it REMOVEs BOTH
`byDueAt` key attributes:

```
app/src/repos/extractionRepo.ts:326
UpdateExpression: 'SET #claimedAt = :claimedAt REMOVE #dp, #dueAt, #manual, #requestId',
```

The GSI is truly sparse, so the row leaves the due index immediately and no
`listDue(now)` can ever return it again. Only two things put it back:
`scheduleExtraction` (`app/src/repos/extractionRepo.ts:229`), driven by a new
inbound message on that conversation, and `requestManualExtraction`
(`:258`), driven by a human pressing the button.

If the worker process dies between the claim (`app/src/jobs/extraction.ts:400`)
and either `complete` or `fail` - a container roll, an OOM, a deploy, a crash -
the row is left claimed, unscheduled, and invisible. There is no reaper, no
sweeper, and no staleness scan anywhere in the tree. Nothing re-arms it.

The consequence is silent and unbounded: that conversation's facts are never
extracted, its cursor never advances, and no log line, metric or run record is
written, because the process that would have written one is gone. Recovery is
accidental - the next inbound message on the thread, or a human who happens to
notice and presses the manual button.

The exposure window is as wide as one model call, which is currently unbounded:
see [`extraction-driver-call-unbounded`](./extraction-driver-call-unbounded.md)
(roughly thirty minutes of wall clock per row).

**Suggested fix.** A reaper that finds rows claimed longer than some bound and
re-arms them. Two prerequisites before that is safe:

1. `claimedAt` must become trustworthy first -
   [`extraction-claimedat-stamped-from-poll-clock`](./extraction-claimedat-stamped-from-poll-clock.md).
   Stamped from the poll-wide clock, it will read as already-stale for a late row
   in a long pass, so a naive reaper would re-arm runs that are still executing.
2. Re-arming must be conditional the way `fail` now is, so the reaper cannot
   clobber a press or an inbound that landed while it was deciding.

Finding the rows is itself a design problem: a claimed row is in NO sparse index,
so a reaper either needs a new index keyed on the claim or has to Scan, which the
repo's design deliberately avoids.
