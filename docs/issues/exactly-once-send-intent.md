---
id: exactly-once-send-intent
title: No send path has exactly-once semantics - a lost HTTP response plus a staff re-click can duplicate any outbound message
type: improvement
severity: low
status: open
area: app/messaging
created: 2026-08-10
updated: 2026-09-27
refs: app/src/services/sendMessage.ts, app/src/repos/sendAttemptsRepo.ts:329, app/src/jobs/broadcastFanOut.ts:833, app/src/jobs/relayFanOut.ts:1942, app/src/jobs/sendReconcile.ts:731, app/src/routes/api.ts:1430, docs/superpowers/specs/2026-08-10-group-texting-design.md, docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md
---

**Problem.** Raised during the group-texting external design review: if the
provider accepts a send but the HTTP response is lost, a retry (or a staff
re-click after an error surface) duplicates the message. This is true of
EVERY send path today (1:1, relay fan-out, broadcasts, and the new group
sends) - none carries a durable send intent or client-dedupe identifier.

**Scope note.** Deliberately NOT fixed inside the group-texting mission
(2026-08-10): holding one new path to a stronger standard than the rest of
the app hides the real, app-wide shape of the problem. Group sends ship
with documented parity.

**Sketch.** A durable send-intent record (client-generated idempotency key
persisted before the provider call; recovery by key + provider history on
ambiguous outcomes), applied uniformly across send services.

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

**Substantially built, for the callers that adopted it.** The per-recipient
send-attempt record is the durable send intent sketched above (spec D8a),
applied to both fan-outs and the relay retry rung:

- **Claim before send.** One conditional write claims the recipient before
  every provider call (`app/src/repos/sendAttemptsRepo.ts:329-352`; claimed at
  `app/src/jobs/broadcastFanOut.ts:833-843` and
  `app/src/jobs/relayFanOut.ts:1942-1952`). A live attempt defers a second
  one, a terminal one skips it, and a record holding a SID refuses every later
  claim, so a redelivery, a continuation or a re-drive never sends twice.
- **The fence.** Every later write by the same attempt is conditioned on its
  `attemptNo` and `attemptedAt` (`sendAttemptsRepo.ts:377-427`), so a stale
  writer cannot overwrite a newer attempt.
- **The takeover.** An `attempting` record older than the 30 s claim TTL (the
  provider request timeout) is moved to `reconciling` and handed to the
  reconcile, never re-sent (`:347-349`, `:421-427`).
- **Recovery by provider history.** An ambiguous outcome goes to
  `send.reconcile`, which lists the provider's messages to that recipient from
  that sender in a window around the attempt, adopts a message that matches
  the attempt's recorded fingerprint (spec D13), and re-drives only after a
  `never_sent` verdict, at most once (`app/src/jobs/sendReconcile.ts:731-808`,
  `:1029-1054`). There is no client-generated key: Twilio ignores an
  `Idempotency-Key` header on message creation (spec Sec 1).

**What remains.** The sweeper for records a crash or a strand leaves open
([send-attempt-sweeper](./send-attempt-sweeper.md)); the send sites that claim
no record yet - `retrySend`
([retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md),
Stage 1b) and the send-shaped sites in the sweep table of
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md);
and this issue's own case, which no adopted caller covers: a staff send
(`app/src/routes/api.ts:1430-1462`), the manual Retry (`:1673-1694`) or a
native group send (`app/src/services/groupSend.ts:298`) whose response is lost
can still be re-clicked into a second text.
[manual-retry-double-send-residual-windows](./manual-retry-double-send-residual-windows.md)
suggests having the manual Retry claim the same record.
