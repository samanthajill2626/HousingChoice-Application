---
id: quiet-hours-ungated-automated-paths
title: Three machine-timed send paths are not quiet-hours gated (relay intro, queued flush, auto-retry)
type: decision
severity: med
status: open
area: app
created: 2026-08-03
updated: 2026-09-02
refs: app/src/jobs/relayNumberReady.ts:171, app/src/services/relayQueuedMessages.ts, app/src/jobs/retrySend.ts:73, app/src/jobs/relayRetryLeg.ts
---

**Problem.** The quiet-hours feature
(spec `docs/superpowers/specs/2026-08-03-quiet-hours-design.md`) gates the two
scheduled pollers (tour reminders, placement nudges) and exempts paths that
"fire from a staff action". Research for the build found three paths where the
CONTENT is human- or webhook-originated but the SEND TIME is machine-chosen,
and none of them is gated:

1. **Deferred relay intro** - `app/src/jobs/relayNumberReady.ts:171` enqueues
   `RELAY_INTRO_JOB` from the Twilio A2P number-registration webhook. The staff
   action (group create) may be hours or days earlier; a group created at 4pm
   whose number registers at 2am texts every member at 2am. The spec's
   exemption rationale ("all fire from a staff action") is factually false for
   this path. Currently fenced: `RELAY_LIVE_PROVISIONING=false` pre-A2P, so the
   connecting/warming path is not live yet.

2. **Queued-message flush on a connecting relay group** -
   `app/src/services/relayQueuedMessages.ts` (`flushQueuedMessages`) releases
   staff-composed `queued_pending` messages right after the deferred intro
   above. Same timing decoupling, same fence.

3. **Automatic delivery-failure retry** - `app/src/jobs/retrySend.ts:73-77`
   (producer, enqueued from `app/src/routes/webhooks/twilio.ts` on a failed
   delivery-status callback; handler `:103`; sends `automated: true`). Bounded:
   backoff 60s/120s/240s with max 3 attempts, so a retry lands at most ~7
   minutes after the original send - it only enters quiet hours when the
   original fired at ~20:55.

   **2026-09-02 (feat/relay-30003-retry-lineage): a SECOND automatic retry path
   now exists and inherits this item unchanged.** A relay fan-out leg rejected
   with 30003 is retried to that member alone by `app/src/jobs/relayRetryLeg.ts`,
   claimed from the relay branch of `app/src/routes/webhooks/twilio.ts` on the
   failed delivery-status callback. It is deliberately NOT separately gated, and
   the ~7-minute bound still holds exactly: its ladder matches the 1:1 policy
   value for value - 60s/120s/240s, max 3 attempts (spec D6,
   `relayRetryBackoffMs` in `app/src/lib/relayRetryClaim.ts` mirroring
   `retrySend.ts`). The recommendation below therefore transfers with no change
   of reasoning; read "automatic delivery retries" as covering both paths. Note
   the retry job also carries a short TRANSIENT sub-ladder (5s then 10s) inside
   one rung, which does not extend the bound.

None of these is a regression from the quiet-hours build (its exempt-files rule
was honored; zero diff on all of them). This issue records the DECISION owed:
either accept each path as an explicit spec exemption with a one-line
rationale, or gate 1-2 before `RELAY_LIVE_PROVISIONING` flips on.

**Suggested fix.** (1)+(2): when relay live provisioning is enabled, hold the
deferred intro + flush until quiet-end - both already ride the job queue, so
scheduling `runAt` via `clampOutOfQuietHours` (`app/src/lib/quietHours.ts`)
at enqueue time is a small, claim-safe change. (3): accept with a spec
sentence ("automatic delivery retries inherit the original send's timing and
are not separately gated") - no code change; the ~7-minute bound makes gating
overkill.
