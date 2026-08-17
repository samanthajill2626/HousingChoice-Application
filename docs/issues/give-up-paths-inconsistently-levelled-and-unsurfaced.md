---
id: give-up-paths-inconsistently-levelled-and-unsurfaced
title: Capped give-up paths are inconsistently levelled, so most of them reach no alarm at all
type: bug
severity: med
status: open
area: observability
created: 2026-08-16
refs: app/src/jobs/voiceTranscript.ts:225, app/src/jobs/voiceTranscript.ts:303, app/src/jobs/tourReminders.ts:737, app/src/jobs/tourReminders.ts:782, app/src/jobs/tourReminders.ts:942, app/src/jobs/placementNudges.ts:571, app/src/jobs/broadcastFanOut.ts:479, app/src/jobs/relayFanOut.ts:559
---

**Problem.** A capped retry that exhausts its attempts and closes is a
SUCCESSFUL job: the handler stamps the failure, returns normally, and SQS
deletes the message. Nothing reaches the DLQ - the DLQ only ever sees jobs that
keep THROWING. So the entire class of "we tried N times and gave up" is
invisible to the DLQ depth alarm by construction.

That leaves the error-log alarms as the only automated surface, and most of
these paths do not reach them either, because they log at WARN (level 40) while
the `ErrorLogs` metric filter is `{ $.level >= 50 }`. Two sites already log at
ERROR; six comparable ones do not:

| site | what it means | level |
| --- | --- | --- |
| `broadcastFanOut.ts:479` | transient cap reached, recipients marked failed | error |
| `relayFanOut.ts:559` | transient cap reached, recipients marked failed | error |
| `voiceTranscript.ts:225` | create exhausted, transcript abandoned | warn |
| `voiceTranscript.ts:303` | reconcile exhausted, transcript abandoned | warn |
| `tourReminders.ts:737` | roster unreadable past the grace window, rung dropped | warn |
| `tourReminders.ts:782` | reminder body uncomposable, rung dropped | warn |
| `tourReminders.ts:942` | reminder body uncomposable, rung dropped | warn |
| `placementNudges.ts:571` | roster unreadable past the grace window, nudge dropped | warn |

The only other surface is the UI, and it is passive and per-record: an
abandoned transcript renders "Transcript unavailable" on that one call bubble,
a failed broadcast recipient shows on that one broadcast. There is no aggregate
anywhere, so "eleven transcripts were abandoned today" is not visible to anyone
who is not already looking at the specific conversation.

This got sharper after a755c6f8. The 2026-08-16 incident was detectable only
because the job kept throwing (repeated errors + a DLQ message). That fix
correctly converted the same breakage into a clean give-up - which means an
identical systemic failure today produces NO DLQ message and, on the voice
paths, NO error-level log. It would be quieter than the incident that exposed
it.

**Suggested fix (operator-agreed 2026-08-16).** Raise the six WARN sites above
to ERROR so every genuine give-up matches the convention the two fan-out
handlers already follow. This needs NO new metric filter and NO terraform: the
existing `{ $.level >= 50 }` filter already spans the app and worker log
groups, so the sustained alarm from
`error-log-alarm-blind-to-slow-failures.md` covers them the moment it is
applied. A single give-up stays quiet (one datapoint cannot satisfy 3-of-3);
give-ups recurring across ~15 minutes page.

**Boundary that must hold, or this backfires.** Only promote give-ups where we
FAILED TO DO SOMETHING WE INTENDED. The other cluster retires work whose intent
became MOOT and is normal operation, not failure - leave these at INFO:

- `tourReminders.ts:244` / `:268` / `:648` - rung superseded by a later one, or
  it lands at/past tour start
- `tourReminders.ts:751`, `placementNudges.ts:585` - the tenant is no longer on
  the roster
- `rosterActions.ts:341` / `:389` / `:534` - wrong thread type, or the group was
  already open
- `rosterActions.ts:487` - roster action retired without applying (already a
  deliberate VISIBLE skip)

Promoting those would fire the sustained alarm during routine operation, and an
alarm that cries wolf is worse than no alarm - it would also discredit the
sustained alarm for the failure it was added to catch.

**Not doing:** a dedicated `$.event`-tagged metric filter per give-up type was
considered and dropped as more machinery for the same signal, once it was clear
the level fix reuses the existing filter and alarm.
