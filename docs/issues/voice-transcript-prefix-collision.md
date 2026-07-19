---
id: voice-transcript-prefix-collision
title: toUtterances can mis-parse a voicemail line that literally starts with "Staff:"/"Client:"/"Speaker N:"
type: bug
severity: low
status: open
area: app
created: 2026-07-18
refs: app/src/jobs/extraction.ts:110
---

**Problem.** `toUtterances` (app/src/jobs/extraction.ts) parses per-line speaker
prefixes from the stored call transcript STRING. For a voicemail (single channel),
`joinViSentences` produces an UNPREFIXED transcript (the caller is the client by
construction, spec section 4), so `toUtterances` is meant to attribute every line
to the client. But it still runs the prefix regexes, so a voicemail whose raw VI
text happens to begin a line with `Staff: `, `Client: `, or `Speaker 1: ` is
mis-parsed:
- `Staff: <text>` -> speaker `staff` -> the client's fact is DROPPED (extractor
  treats it as staff speech).
- `Speaker 1: <text>` -> speaker `unknown` -> spuriously demotes the whole run to
  suggest-only (SAFE, but over-cautious - an extra human click).
- `Client: <text>` -> speaker `client` -> harmless (correct anyway).

Reachability is LOW: Twilio VI does not add speaker labels to a single-channel
recording, so this requires the CALLER to literally start a voicemail with one of
those `Word:` prefixes. Worst case is a rare dropped fact; it can never produce a
WRONG write (the mis-parse is either drop or safe-demote). Found by the slice-2
adversarial review (voice-extraction-adapter).

**Suggested fix.** Thread the call's channel count (or a `single-channel` flag)
into `toUtterances` so a single-channel/voicemail transcript is attributed wholly
to the client WITHOUT prefix parsing. The call MessageItem already carries
`transcript_channel_roles` for stamped calls; alternatively persist a
`transcript_channel_count` (or reuse the roles-map presence) and skip prefix
parsing when the recording was single-channel. Keep prefix parsing for genuine
dual-channel bridges only.
