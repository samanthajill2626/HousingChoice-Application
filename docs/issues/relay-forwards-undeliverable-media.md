---
id: relay-forwards-undeliverable-media
title: Relay fan-out forwards received media Twilio cannot carry, failing the whole leg
type: bug
severity: high
status: open
area: app/relay
created: 2026-08-26
refs: app/src/jobs/relayFanOut.ts:494-509, app/src/lib/mediaTypes.ts:65-74, app/src/routes/api.ts:2251
---

**Problem.** When a relay-group member texts in media, `relayFanOut` presigns
EVERY stored attachment and hands the URLs to Twilio with no content-type
filter at all:

```
legMediaUrls = await Promise.all(
  sourceMedia.map((a) => store.presign(a.s3Key, RELAY_PRESIGN_TTL_SECONDS)),
);
```

(`app/src/jobs/relayFanOut.ts:494-499`, then passed straight into
`adapter.sendMessage` at :504-509.)

Twilio fetches each presigned URL and reads the S3 object's Content-Type.
Only `TWILIO_DELIVERABLE_MMS_TYPES` - jpeg, png and gif
(`app/src/lib/mediaTypes.ts:65-69`) - can actually be carried as MMS; the same
file records that Twilio rejects anything else with error 12300. So a member
who sends a video, a HEIC photo, a PDF or a document produces a leg Twilio
refuses.

The consequence is worse than losing the attachment: 12300 fails the MESSAGE,
so the other members of the relay group receive NOTHING - not the media and not
the accompanying body text. The sender sees their message delivered into the
thread and has no signal that nobody else got it.

There is no `isTwilioDeliverableType` guard anywhere on this path. The outbound
composer path is gated at upload (`app/src/routes/mmsMedia.ts:78`) and the
send path re-checks; the RELAY FORWARD path inherited neither check because it
sources its media from the inbound mirror rather than from an upload.

UNVERIFIED against production: the 12300 attribution is derived from the code
and from the comment at `mediaTypes.ts:65-69`, not from an observed prod
failure. A prod check would be relay legs sitting at `failed`/`undelivered`
with error code 12300 on messages whose source was an inbound MMS.

**Suggested fix.** Needs design, not a one-liner - there is no correct silent
behavior:

- Filter at fan-out to deliverable types only, and tell the SENDER (and the
  thread) that their attachment was not forwarded. Losing the body text is the
  worst part and is fixable immediately by sending the text leg without the
  media.
- Or transcode on the way out, reusing the `planMmsMedia` machinery that
  already exists for uploads (`app/src/lib/mediaTypes.ts:89-98`). That covers
  HEIC and PDF but not video, which has no rendition path.
- Or forward a link to the authed media route instead of the bytes, which
  raises the privacy question that
  `docs/issues/mms-forward-received-media.md` already parks: relayed media can
  be an ID photo or a benefit letter.

Found while fixing `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
(inbound media content-type fidelity), which is deliberately scoped to the
dashboard read path and does NOT change this behavior. That work does make the
stored Content-Type truthful, so after it lands the object Twilio refuses says
`video/mp4` rather than `application/octet-stream` - the leg still fails, but
the data any fix here would need is finally present.
