# Research findings - what carrier error 30003 means, and when we retry

Read-only research, 2026-09-24, by a research subagent for the planner session
(Cameron asked: "If a phone has a dead battery, would these fail to be sent? We
don't retry sent-but-not-delivered, do we? When would a dead phone lead to a failed
delivery?"). Punctuation normalized to ASCII; content as reported. Line numbers are
at `main` @`cd8e8ddd`.

## Answers

1. **Dead battery.** Our send always goes out: Twilio hands the leg to the carrier
   and it reads `sent`. Then it depends on the carrier.
   - If the carrier stores it, the leg stays `sent` ("Sent - not confirmed" after
     15 minutes on the dashboard) and flips to `delivered` when the phone comes
     back. No retry fires.
   - If the carrier rejects it as unreachable, that is 30003 - Twilio lists
     "device is powered off" as the first cause. We then resend 60, 120 and 240
     seconds after each failure. A phone dead for more than about 7 minutes fails
     all three, the leg ends `cap_exhausted` at ERROR with up to four
     `delivery_failed` events (`app/src/routes/webhooks/twilio.ts:3027-3036`), and
     Twilio bills every attempt.
2. **Sent-but-not-delivered is never retried.** A retry needs an explicit failure
   callback carrying 30003 (`twilio.ts:2685-2686`) and a leg already
   failed/undelivered (`twilio.ts:2744-2752`). A stale `sent` leg is display-only:
   `STALE_SENT_AFTER_MS` = 15 minutes (`dashboard/src/routes/contact/deliveryStatus.ts:64`),
   deliberately not a failure because retrying could double-send (`:73-83`).
   Status polling was put out of scope (`docs/issues/relay-30003-retry-lineage.md:104-106`).
   - Caveat: a LATE 30003 on a `sent` leg is still accepted
     (`app/src/repos/messagesRepo.ts:140`, `sent -> undelivered` is allowed) and
     still triggers a retry. There is no age check anywhere; the only pre-send
     gates are group closed, member removed, number changed and opted out
     (`app/src/jobs/relayRetryLeg.ts:491-545`). Backoff counts from each callback,
     not from the original send (`relayRetryLeg.ts:225-233`), so a 30003 that
     arrives hours late resends hours-old content a minute later.
   - Verified by the planner in the code the same day: no age or time condition in
     the claim path or in `app/src/lib/relayRetryClaim.ts`.
3. **When a dead phone produces a failed delivery.** (a) The carrier does not store
   the message and rejects it right away as unreachable (30003); or (b) the phone
   stays off longer than the carrier keeps messages (24-72 hours is common per
   Twilio; Verizon keeps them up to 5 days). At expiry there is either a late
   failure receipt - not necessarily 30003 - or no receipt at all, leaving the leg
   at `sent` forever. Nothing found documents which US carriers do (a) versus (b)
   for business texting.

## What triggers a retry

A status callback on a relay member leg (a fan-out or team leg, not an
announcement) reading `undelivered` or `failed` with error code exactly `30003`;
the member's slot must be failed/undelivered with 30003 or no code, and fewer than
3 retries used (`twilio.ts:2685-2759`). The rung is queued at +60, +120 or +240
seconds (`app/src/lib/relayRetryClaim.ts:13-18`, `twilio.ts:2842`). The one-to-one
path (`twilio.ts:3350-3369`, `app/src/jobs/retrySend.ts`) uses the same schedule.

## Primary sources (verified)

- 30003: "the destination handset is unavailable... usually happens when the device
  is powered off, has no service"; suggested fix: send again -
  https://www.twilio.com/docs/api/errors/30003
- `sent` normally resolves within seconds or minutes; past 72 hours a further
  status is unlikely, but Twilio still updates the record if one arrives -
  https://help.twilio.com/articles/223134347
- Billing: the full fee applies whenever the status is sent, delivered, undelivered
  or delivery unknown - https://help.twilio.com/articles/223181728
- Verizon stores texts for an off or out-of-coverage phone for up to 5 days -
  https://www.verizon.com/support/text-messaging-faqs/
- Carrier retention of 24-72 hours is common -
  https://www.twilio.com/en-us/blog/sms-delivery-reports-overview
- Twilio's own validity period covers only Twilio's outgoing queue (10-hour
  maximum) - https://www.twilio.com/docs/messaging/api/message-resource

## Inferred or unverified

- Immediate 30003 versus store-and-forward, per carrier for our traffic, is not
  documented anywhere found.
- Which code a carrier expiry reports: one sample in the repo, and it was 30005
  (`docs/issues/mms-silent-drop-dish-textnow.md:117-125`).
- The repo docs record no 30003 counts; Cameron states real 30003s DID occur in
  production and were looked up at the time (2026-09-24).
