---
id: outbound-mms-stalls-at-sent-with-no-receipt
title: An oversized outbound MMS is dropped by the carrier and shows as "sent" forever
type: bug
severity: high
status: resolved
area: app
created: 2026-08-20
resolved: 2026-08-20
refs: app/src/lib/outboundMediaLimits.ts, app/src/lib/mmsBatching.ts, app/src/routes/api.ts, dashboard/src/routes/contact/deliveryStatus.ts
---

**Problem.** A 2.93 MB outbound MMS is accepted by Twilio, handed to the
destination carrier, silently discarded there, and then sits at delivery status
`sent` indefinitely. No delivery receipt ever arrives, no error code is ever
returned, and nothing in the dashboard tells the sender the message did not
land. Staff reasonably read "sent" as "it went".

**Prod evidence, 2026-08-19/20** (contact-1ca650a6-ae2a-4afe-b583-3fc105c151ae,
1:1 thread conv-ad46e529-add3-4657-b93d-e190245147e0):

| when (UTC) | sid | attachments | payload | outcome |
| --- | --- | --- | --- | --- |
| 2026-08-19T21:28:59Z | MMadb9359... | 7 | 2.93 MB | stuck at `sent` |
| 2026-08-20T01:59:57Z | MM7d7ff7e6... | 7 | 2.93 MB | stuck at `sent` |

The status callbacks arrive normally and progress `queued` -> `sent`, then stop.
Querying the Twilio Messages resource directly returns `status=sent` with an
EMPTY `error_code` on both, hours later - so this is not a missed webhook on our
side and not a receipt we failed to process. Twilio never learned the outcome
either.

**Payload size is the cause; carrier and attachment count are not.** All twelve
outbound MMS ever sent from prod:

- 10 delivered, spanning 1 to 7 attachments and 0.13 MB to 1.53 MB
- 2 dropped, both 7 attachments at 2.93 MB

Two 7-attachment, 1.53 MB messages delivered to T-Mobile numbers, one of them
five minutes before the first failure. The failing recipient is also T-Mobile.
Same carrier, same attachment count, ~2x the bytes, opposite outcome.

**Why our limits allowed it.** `OUTBOUND_MMS_MAX_TOTAL_BYTES` was 5 MB and
`OUTBOUND_MMS_MAX_MEDIA` 10 - those are Twilio's API ceilings, not carrier
delivery limits. Compounding it, `PASSTHROUGH_MAX_BYTES` was 1 MB, so an image
under that was forwarded untouched: three ~920 KB PNG screenshots passed
straight through and accounted for 2.7 MB of the 2.93 MB by themselves.

**Resolution (2026-08-20).** Three commits on `fix/mms-carrier-size`:

1. **Never build an over-budget message.** Per-message total 5 MB -> 1 MB (under
   the 1.53 MB observed to deliver); passthrough 1 MB -> 250 KB so a screenshot
   is transcoded like anything else; per-file transcode target 1.5 MB -> 250 KB
   at the same 1600px edge; new `OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE` of 4.
2. **Split rather than refuse.** Tightening alone would have blocked the
   founder's ordinary 7-9 photo send. `planMmsBatches` packs a send into as many
   carrier-sized messages as it takes, preserving the sender's order; the 1:1
   route and the relay route each send one message per batch with the typed body
   on the first. Splitting the relay path required `sendRelayTeamMessage` to
   return its outcome instead of writing the HTTP response. A single file too
   big for any one message still refuses, where the sender can see it.
3. **Stop claiming delivery we do not have.** An outbound row still at `sent`
   after 15 minutes presents as "Sent - not confirmed", derived at render time
   from the row's own timestamp - no job, no schema, no backfill, and it
   self-corrects if a late receipt lands. Deliberately not marked a failure: no
   receipt is not proof of non-delivery, and a Retry there could double-send.

Not covered: there is still no way to re-send just the attachments that did not
land, because we cannot tell which ones did.
