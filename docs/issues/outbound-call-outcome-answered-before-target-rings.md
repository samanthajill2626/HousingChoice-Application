---
id: outbound-call-outcome-answered-before-target-rings
title: An outbound originate is stored call_outcome 'answered' as soon as the navigator presses 1 - before the target's phone rings - so an unanswered outbound call is classified answered
type: bug
severity: med
status: open
area: app
created: 2026-08-17
refs: app/src/routes/webhooks/voice.ts, app/test/voiceOutbound.test.ts, docs/issues/inbound-calls-invisible-in-inbox.md
---

**Problem.** The whisper-gate press-1 handler stamps `answered_at` +
`call_status: 'in-progress'` on the PARENT CallSid regardless of leg. On the
INBOUND founder bridge that is correct: the gate runs on the dialed founder leg,
so press-1 means the bridge connected. On the OUTBOUND originate the gate runs on
the NAVIGATOR's own leg, and press-1 is what CAUSES the target to be dialed - so
`answered_at` is set before the target has rung at all. The terminal `<Dial
action>` summary then sees `bridgeAccepted === true` and classifies the call
`answered` (with `call_duration` from `DialCallDuration`, often 0) even when the
target never picked up / was busy / failed. `app/test/voiceOutbound.test.ts`
("press-1 stamps the outbound call answered") pins the current behaviour.

Surfaced by the call-inbox-unread adversarial review (r2 HIGH 1): the inbox
preview would have read "Outgoing call - 0s" for a rung-out outbound call. The
PREVIEW was fixed on that branch by reading the Dial summary's own status for
outbound legs (completed/in-progress = answered, else no answer); the stored
`call_outcome` / timeline card still say "answered".

**Suggested fix.** On an outbound entry, derive `bridgeAccepted` from the Dial
summary's own signal (a terminal `completed`, or the in-progress summary that
`answerOnBridge` only produces once the target answers) instead of from
`answered_at`; stamp the navigator's press-1 as something else (e.g.
`navigator_accepted_at`) if that instant is worth keeping. Re-pin the
voiceOutbound test to the new meaning, and check the missed-outbound goodbye /
voicemail-offer guards in `/voice/status` still route correctly.
