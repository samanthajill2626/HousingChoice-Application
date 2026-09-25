---
id: voicemail-upgrade-and-transcript-lost-after-mirror
title: After a call recording is mirrored, a throw in the voicemail upgrade or the transcript request is never retried - the redelivery early-returns on the stored recording
type: bug
severity: med
status: open
area: app/voice
created: 2026-09-25
refs: app/src/routes/webhooks/voice.ts:1957, app/src/routes/webhooks/voice.ts:2013, app/src/routes/webhooks/voice.ts:2065, app/src/routes/webhooks/voice.ts:2109, app/src/routes/webhooks/voice.ts:2216, app/src/routes/webhooks/voice.ts:2217
---

**Problem.** The recording status callback (`/voice/recording`) claims the
recording with a conditional `setCallRecording`
(`app/src/routes/webhooks/voice.ts:2013`), which writes `recording_s3_key` onto
the call entry, then streams the media to S3. Once that succeeds, the handler
does two more things:

1. **The voicemail upgrade** - `upgradeCallOutcomeToVoicemail` (`:2065`), which
   flips the call from `missed` to `voicemail` and, on success, re-flags the
   inbox row and sends the "New voicemail" push.
2. **The transcript request** - `requestTranscription` (`:2109`), which stamps
   `transcript_status` pending (`:2216`), re-reads the call row (`:2217`) to emit
   the live update, and then creates the transcript or enqueues its fallback
   job.

Both awaits at `:2065` and `:2216-2217` are unguarded. A throw fails the
request, and Twilio redelivers the callback - but the redelivery hits the
layer-1 early return (`:1957-1961`): the entry already carries
`recording_s3_key`, so it answers 200 "recording already stored" and does
nothing else. The claim has done its job as a run-once marker, and the work
after it is gone.

Lost: the voicemail upgrade (no "Voicemail" re-flag on the inbox row, no push -
staff see a plain miss) and the transcription. If `:2216` lands and `:2217`
throws, the call shows "Transcribing..." forever: the status is pending and no
transcript was ever requested, so neither the create job nor the reconcile job
exists to finish it - the same user-visible symptom as the 2026-08-16 incident
recorded in
[retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md).

Distinct from
[recording-claim-redelivery-loss-window](./recording-claim-redelivery-loss-window.md),
which is about losing the RECORDING itself in the claim -> fetch -> release
window; here the recording is safe and what is lost is the work after it.
(That issue also gains the one sweep finding that sits inside its window: a
throw from `releaseCallRecording` at `:2042`.)

Filed as med (the sweep rated it low-to-medium): the voicemail is still
playable, but staff are not told it exists and the transcript never comes.

**Suggested fix.** Group: not a send - local error handling; no reconcile
involved (see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9). Make the post-mirror steps independent of the early return: guard each
and give a failed step its own recovery (the transcript create already has a
fallback job and a reconcile job - route a failed stamp into them, or order the
stamp so it cannot land without a request behind it), or make the layer-1
early return check "upgrade done / transcript requested" as well as "recording
stored".

**Related.**
[recording-claim-redelivery-loss-window](./recording-claim-redelivery-loss-window.md),
[provider-status-unenumerated-defaults](./provider-status-unenumerated-defaults.md)
(the transcript path's non-terminal bounds). Sweep finding F9 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
