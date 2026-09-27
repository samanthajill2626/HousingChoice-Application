---
id: send-attempt-facts-dead-and-duplicated
title: Send-attempt facts are built twice and read once - the typed errors' facts are dead, the broadcast claim hardcodes mediaCount 0 (every broadcast reconcile breaks the day shares carry media), and the never_sent outcome is never written
type: debt
severity: low
status: open
area: app/messaging
created: 2026-09-27
refs: app/src/services/sendMessage.ts:607, app/src/services/sendMessage.ts:613, app/src/services/sendMessage.ts:232, app/src/services/sendMessage.ts:266, app/src/jobs/broadcastFanOut.ts:868, app/src/jobs/broadcastFanOut.ts:876, app/src/jobs/broadcastFanOut.ts:1039, app/src/repos/sendAttemptsRepo.ts:61, app/src/jobs/sendReconcile.ts:552
---

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding L-4
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577` (the code is identical to the code-final commit
`52220729`).

**Problem.** Three loose ends in how an attempt's facts (the destination
digest, the sender, the body hash and the media count a reconcile matches on,
spec D12/D13) are carried.

1. **The facts on the typed errors are dead.** `sendMessage` builds the facts
   on every send (`app/src/services/sendMessage.ts:607-614`) and attaches
   them - plus the attempt start - to `ProviderSendFailedError` (`.facts`,
   `.attemptedAt`, `:232-259`) and to `SendAcceptedNotRecordedError`
   (`.facts`, `:266-286`). No production code reads either field: the only
   reader of the typed errors takes `.classification`
   (`app/src/jobs/broadcastFanOut.ts:1039`).
2. **The broadcast claim recomputes the facts, with `mediaCount: 0`
   hardcoded.** The broadcast pass builds its own facts for the claim
   (`broadcastFanOut.ts:868-877`, the literal at `:876`) instead of taking
   the wrapper's `mediaUrls?.length ?? attachments?.length ?? 0`
   (`sendMessage.ts:613`). Correct today - shares carry no media. The day
   [broadcast-mms](./broadcast-mms.md) lands, every broadcast attempt record
   says 0 while the provider's message carries the real media count; the
   reconcile's match compares both (`matches`,
   `app/src/jobs/sendReconcile.ts:552-554`), never matches, and every
   ambiguous media share ends "Not confirmed" - silently, with no test
   naming the coupling.
3. **The `never_sent` outcome is never written.** `SendAttemptOutcome` lists
   `never_sent` (`app/src/repos/sendAttemptsRepo.ts:61`), but a `never_sent`
   verdict moves the record to `redriven` (`markRedriven`) rather than
   closing it with that outcome, and nothing else writes it (every record
   close passes another outcome). The reconcile's own VERDICT kind of the
   same name (`app/src/jobs/sendReconcile.ts:307`) is live; only the record
   outcome is dead. A reader (for
   example the planned [send-attempt-sweeper](./send-attempt-sweeper.md))
   that branches on it would branch on a value that never occurs.

**Suggested fix.** One source of truth for the facts: either have the
broadcast claim read them from the send wrapper (compute them in one shared
helper that both the claim and `sendMessage` call, so the media count cannot
diverge), or drop `.facts` / `.attemptedAt` from the typed errors if no
caller is meant to read them. At minimum, add a test that fails when a
broadcast carries media and the claim's `mediaCount` does not match it, so
`broadcast-mms` cannot land without meeting this. Remove `never_sent` from
the outcome union, or document it as reserved.

**What this is NOT.** Not a double text and not a visible defect today: the
media count is right for every share that exists (none carries media), and
the dead fields cost only an allocation per send. The risk is a silent
regression when broadcast media ships - a safe-direction one ("Not
confirmed", never re-sent).

**Related.** [broadcast-mms](./broadcast-mms.md),
[send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md)
(item 5, the media half of the fingerprint against real Twilio),
[send-attempt-sweeper](./send-attempt-sweeper.md).
