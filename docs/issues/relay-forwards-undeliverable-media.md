---
id: relay-forwards-undeliverable-media
title: Relay fan-out forwards received media Twilio cannot carry, failing the whole leg
type: bug
severity: high
status: open
area: app/relay
created: 2026-08-26
refs: app/src/jobs/relayFanOut.ts:494-509, app/src/lib/mediaTypes.ts:211-225, app/src/routes/api.ts:2252, docs/issues/mms-forward-received-media.md
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
Everything we ORIGINATE is confined to `TWILIO_DELIVERABLE_MMS_TYPES` - jpeg,
png and gif (`app/src/lib/mediaTypes.ts:216-220`) - because the same file
records that Twilio rejects the types we send outside it with error 12300. That
set is our own send-side rule and is NARROWER than what Twilio actually accepts,
so it does not by itself predict this path's outcome; what it does establish is
that a leg carrying a type Twilio refuses fails, and a video is the clearest
such case. So a member who sends a video very likely produces a leg Twilio
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
and from the comment at `mediaTypes.ts:211-215`, not from an observed prod
failure. A prod check would be relay legs sitting at `failed`/`undelivered`
with error code 12300 on messages whose source was an inbound MMS.

**Suggested fix.** Needs design, not a one-liner - there is no correct silent
behavior:

- Filter at fan-out to deliverable types only, and tell the SENDER (and the
  thread) that their attachment was not forwarded. Losing the body text is the
  worst part and is fixable immediately by sending the text leg without the
  media.
- Or transcode on the way out, reusing the `planMmsMedia` machinery that
  already exists for uploads (`app/src/lib/mediaTypes.ts:230-249`). That covers
  HEIC and PDF but not video, which has no rendition path.
- Or forward a link to the authed media route instead of the bytes, which
  raises the privacy question that
  `docs/issues/mms-forward-received-media.md` already parks: relayed media can
  be an ID photo or a benefit letter.

Found while fixing `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
(inbound media content-type fidelity), which is deliberately scoped to the
dashboard read path and does NOT change this fan-out code.

It DOES change what Twilio sees on this path. The stored Content-Type of
forwarded inbound media becomes the true type (`video/mp4`, `text/vcard`,
`application/pdf`, `image/heic`) instead of `application/octet-stream`, both for
new media and - after the one-time backfill - for the historical population.
NEITHER outcome has been observed, before or after, and there are TWO:

1. **The leg still fails.** Do NOT ground this in
   `TWILIO_DELIVERABLE_MMS_TYPES`. That set (jpeg/png/gif,
   `app/src/lib/mediaTypes.ts:216-220`) is OUR SELF-IMPOSED SEND-SIDE rule for
   media we originate, and `relayFanOut` never consults it - it presigns every
   stored attachment unconditionally. It is not Twilio's accepted-media list,
   which is materially broader than jpeg/png/gif. So "outside our allowlist"
   predicts nothing about what Twilio does here. If the leg does still fail, the
   observable most likely to have moved is the ERROR CODE: an unreadable
   `application/octet-stream` and a readable-but-undeliverable `video/mp4` need
   not produce the same one.
2. **The leg now SUCCEEDS**, for any type Twilio accepts. This is the outcome
   worth checking first, because it is a behavior change nobody asked for: it
   would mean relayed inbound media (PDFs, vCards, HEIC and other images) starts
   REACHING the other members of a relay group where it previously did not. That
   collides directly with `docs/issues/mms-forward-received-media.md`, which
   parks staff-initiated forwarding of received media on the ground that the
   gallery can hold "ID photos, benefit letters, and other PII" and that
   forwarding it needs a deliberate privacy story. Nothing in this fan-out path
   has that story; it would simply start doing it.

So the check is one leg on dev, before the prod deploy: send a non-image MMS
into a relay group and read the forwarded leg's status and error code. It is a
step in RUNBOOK.md's media content-type backfill sequence. Whoever picks this
issue up should run that check rather than inherit either assumption - and
either way, the type data any fix here would need is finally present.
