---
id: voicemail-greeting-format-normalization
title: Voicemail greeting - no transcoding; Twilio behavior on an unplayable <Play> file is unverified
type: improvement
severity: low
status: open
area: app/voice
created: 2026-09-27
refs: app/src/routes/webhooks/voice.ts, app/src/lib/voicemailGreeting.ts, docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md
---

**Problem.** The recorded voicemail greeting (spec 2026-09-26) accepts MP3 and
WAV by content type and header sniff, and plays the stored bytes as-is via
`<Play>`. Two gaps are accepted and recorded here:

1. No normalization or transcoding. A WAV encoding Twilio cannot decode (for
   example 32-bit float, or an unusual sample rate) passes the sniff and is
   stored. Twilio's documented `<Play>` support is MP3 and PCM/u-law WAV; the
   sniff cannot tell a playable WAV from an unplayable one.
2. UNVERIFIED: what Twilio does when a `<Play>` URL cannot be fetched or
   decoded at call time (skip to the next verb and record, or end the call).
   The app-side fallback (spec 4.6) covers lookup-time failures only: a
   greeting that exists but cannot be played, or one removed between the
   webhook's HEAD and Twilio's fetch, is outside it.
3. The header sniff (`sniffGreetingHeader`) proves only the first bytes. An
   ID3v2 tag is a container prefix, so an ID3-prefixed body whose audio is not
   MPEG (for example ID3 followed by ADTS AAC, which some encoders write)
   passes as MP3 and is stored; so does anything that merely begins with a
   valid-looking MPEG frame header (code review round 1, finding A4). The
   TINY-body form of this gap is closed: since fix wave R1 (FW2) the upload
   gate refuses every non-empty body shorter than the 12-byte sniff window
   (`VOICEMAIL_GREETING_SNIFF_BYTES`) with `invalid_format`, so a 3-byte `ID3`
   or a 4-byte frame header alone can no longer become the live greeting.

**Suggested fix.** Settle (2) with the dev check in the spec's section 7
(upload a 32-bit float WAV, call, do not answer, note what the caller hears
and what the Twilio debugger logs) and record the answer here. If Twilio
ends the call on a bad `<Play>`, the cheapest closure is a server-side
probe at upload time (decode the header's format/bit-depth fields for WAV and
refuse what Twilio does not list); a full transcode step (ffmpeg or a WASM
decoder) is a dependency decision and out of scope until the check says it
is needed. The same upload-time probe could close (3) for MP3: skip the ID3
tag (its size is the syncsafe integer in header bytes 6-9) and require an
MPEG frame sync with non-zero layer bits where the audio begins.
