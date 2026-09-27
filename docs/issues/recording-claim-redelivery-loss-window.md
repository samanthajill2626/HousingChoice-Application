---
id: recording-claim-redelivery-loss-window
title: Call recording can be silently lost in the claim->fetch->release window under Twilio redelivery
type: bug
severity: med
status: open
area: app
created: 2026-07-18
refs: app/src/routes/webhooks/voice.ts
---

**Problem.** The recording callback claims the RecordingSid (conditional
setCallRecording, claim-before-fetch) BEFORE fetching the media. The layer-1
early return treats any entry with recording_s3_key set as already-stored and
acks 200. Interleaving: delivery A claims, then fetches slowly (large media,
exceeding Twilio's ~15s webhook timeout so Twilio retries); the retry B reads
the claimed entry, early-returns 200 (Twilio stops retrying); A's fetch then
fails and releaseCallRecording clears the claim. Net: no recording stored, no
key, and no delivery left to re-fetch - the recording (and its transcript) is
silently lost. Requires a redelivery landing inside A's fetch window AND A
ultimately failing, so the window is narrow - but the loss is silent and the
audio is a real business-line call or voicemail.

PRE-EXISTING on main (the claim/release machinery predates the
voice-transcription-voicemail branch); surfaced by that branch's adversarial
review 2026-07-18.

**Suggested fix.** Options, roughly in order of preference: (a) make the
layer-1 early return distinguish "claimed but media not yet mirrored" (e.g. a
mirrored_at stamp set only after the S3 put; a redelivery seeing claimed-but-
unmirrored waits/409s or re-verifies the S3 object exists before acking); or
(b) on release, enqueue a delayed self-heal job that re-fetches the recording
from Twilio by RecordingSid via the REST API instead of relying on webhook
redelivery.

**Update 2026-09-25 - a second way into the same loss.** The 2026-09-24 marker
sweep (`feat/send-outcome-reconcile`, finding F9) found that the release itself
is unguarded: `releaseCallRecording` runs inside the mirror-failure catch
(`app/src/routes/webhooks/voice.ts:2042`), and if it throws, the handler fails
with the claim still in place. The call entry keeps `recording_s3_key` for an
object that was never written, and Twilio's redelivery hits the layer-1 early
return (`:1957-1961`, "recording already stored") - no redelivery race needed.
Both fix options above cover it, provided the release failure is handled. The
rest of F9 (a throw AFTER a successful mirror, in the voicemail upgrade or the
transcript request) is a different loss and is filed as
[voicemail-upgrade-and-transcript-lost-after-mirror](./voicemail-upgrade-and-transcript-lost-after-mirror.md).
