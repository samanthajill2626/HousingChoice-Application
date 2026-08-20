---
id: outbound-mms-stalls-at-sent-with-no-receipt
title: An oversized outbound MMS is dropped by the carrier and shows as "sent" forever
type: bug
severity: high
status: open
area: app
created: 2026-08-20
refs: app/src/lib/outboundMediaLimits.ts, app/src/lib/mediaTypes.ts, app/src/adapters/messaging.ts
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

**Why our limits allowed it.** `OUTBOUND_MMS_MAX_TOTAL_BYTES` is 5 MB and
`OUTBOUND_MMS_MAX_MEDIA` is 10 - those are Twilio's API ceilings, not carrier
delivery limits. Compounding it, `PASSTHROUGH_MAX_BYTES` is 1 MB, so an image
under that is forwarded untouched: three ~920 KB PNG screenshots passed straight
through and accounted for 2.7 MB of the 2.93 MB by themselves.

**Suggested fix.** Two parts, both needed:

1. Size the send to carrier reality rather than Twilio's ceiling. Cap the total
   payload per message well under the 1.53 MB observed to deliver, transcode
   instead of passing through near-1 MB images, and split a set of attachments
   across MULTIPLE messages so that every message fits under the cap on its own
   - rather than refusing the send or silently truncating the set.
2. Surface a stalled send. A message still at `sent` after some bounded interval
   should stop reading as delivered in the dashboard, so staff can resend or
   fall back to a link. Today the only signal is the recipient saying nothing
   arrived.

Related: [[mms-uploads-no-lifecycle-orphans]],
[[shared-transcode-gate-couples-mms-and-photo-availability]].
