---
id: outbound-answering-machine-detection
title: Outbound "Connected" cannot tell a human from the target's carrier voicemail - AMD is deferred
type: decision
severity: low
status: deferred
area: app/voice
created: 2026-08-18
refs: app/src/routes/webhooks/voice.ts, app/src/adapters/messaging.ts, dashboard/src/routes/contact/presentCallState.ts
---

**Problem.** On an outbound masked call, a completed `<Dial>` with a non-zero
duration is produced IDENTICALLY by a human answering and by the target's carrier
voicemail answering. Twilio reports the same terminal `DialCallStatus: completed`
and the same `DialCallDuration` either way, so the app cannot distinguish them.

The comms-panel call-direction work (decision D9) chose the honest label rather
than a guess: the outbound card says "Connected", never "Answered", precisely
because "Connected" claims only what a completed Dial actually proves - the call
reached something at the other end. Inbound voicemails are a different and solved
case (the caller records into OUR line, and the row is upgraded to a real
`voicemail` outcome), so this gap is outbound-only.

The cost to an operator is real but bounded: an outbound call that went to the
target's voicemail reads exactly like one that reached the person, and only the
duration hints at the difference. Every consumer call log has the same limit.

**Suggested fix.** Twilio Answering Machine Detection on the DIALED leg
(`machineDetection` on the `<Number>`/`<Dial>`, with `AnsweredBy` arriving on the
callback) would classify human vs machine and let the card say so. Two open
questions have to be answered before it can be adopted, and neither has been
priced:

1. **Per-call fee.** AMD is billed per call it runs on, on top of the call
   itself. At our outbound volume, what is the monthly delta, and is it worth it
   for a distinction that is advisory rather than actionable?
2. **Added pre-bridge latency.** AMD listens to the start of the answered leg
   before handing the call over, which delays the moment the navigator and the
   target are actually connected. That delay is paid on EVERY outbound call,
   including the majority that reach a human immediately. How much silence is
   acceptable to a navigator on a live call, and does async AMD (which returns
   the classification AFTER the bridge, leaving the label to be corrected later)
   buy the classification without the latency?

Answer (2) first: if async AMD is good enough, the latency objection disappears
and this becomes a pure cost question, plus a fifth `CallOutcome`-adjacent value
or a separate `answered_by` field to carry the classification. Note the
interaction with
[`originate-leg-status-callback`](./originate-leg-status-callback.md) - both want
a richer terminal vocabulary on the outbound row, and doing them together avoids
two contract changes.
