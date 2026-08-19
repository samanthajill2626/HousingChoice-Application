---
id: outbound-call-outcome-answered-before-target-rings
title: An outbound originate is stored call_outcome 'answered' as soon as the navigator presses 1 - before the target's phone rings - so an unanswered outbound call is classified answered
type: bug
severity: med
status: resolved
area: app
created: 2026-08-17
resolved: 2026-08-18
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

**Resolution (2026-08-18).** Fixed on `feat/comms-panel-call-direction` (spec
`docs/superpowers/specs/2026-08-18-comms-panel-call-direction-design.md` section
6.2, decision D5). The narrower fix was taken deliberately:

- `bridgeAccepted` was left INTACT. It still means "the navigator pressed 1",
  and `answered_at` / `call_status: 'in-progress'` are still stamped at the
  whisper gate on both directions. Nothing was renamed to
  `navigator_accepted_at`, so no other reader of that instant moved.
- Only the STORED outbound `call_outcome` (and its paired `call_duration`)
  changed. `/voice/status` now derives them from the Dial summary's own status -
  `completed` gives `answered` plus the reported duration, anything else gives
  `missed` with no duration - instead of from `bridgeAccepted`.
- The substitution is GATED to a terminal OUTBOUND Dial summary on a non-masked
  `call` row (`isDialSummary && terminal && entry.type === 'call' &&
  entry.masked !== true && entry.direction === 'outbound'`), read off the
  pre-write `entry`. A non-terminal summary, an inbound row, a masked row, or an
  unknown CallSid all fall through to the previous behavior untouched.
- The inbox preview computation was left exactly where it was; it keeps reading
  the same values it read before.
- The missed-founder-bridge trigger, the unread rule, and the voicemail upgrade
  are all direction-gated and were not touched. `app/test/voiceOutbound.test.ts`
  gained the press-1 + `no-answer` regression test this issue describes, plus a
  characterization test that a NON-terminal in-progress outbound summary still
  writes no outcome.

What remains open is a different thing, filed separately: an originate the
navigator never accepts still has no durable terminal status of its own, and is
resolved read-side by derivation. See
[`originate-leg-status-callback`](./originate-leg-status-callback.md).
