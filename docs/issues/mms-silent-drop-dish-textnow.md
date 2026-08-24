---
id: mms-silent-drop-dish-textnow
title: Some destination lines never receive our outbound MMS, and we have no fallback
type: bug
severity: med
status: open
created: 2026-08-24
area: app
refs: docs/issues/outbound-mms-stalls-at-sent-with-no-receipt.md
---

**Problem.** An attachment we send by MMS reaches most numbers and never reaches
certain lines, whose plain SMS works perfectly the whole time. There are THREE
signatures, and the difference matters only to us - to staff and to the
recipient they are the same event, a picture that never arrived:

- **Silent.** Twilio hands off and learns nothing: the leg sits at `sent`
  forever, `error_code=null` (cases 1 and 2).
- **Honest.** The destination rejects immediately and says so: `undelivered`,
  error 30005 "Unknown destination handset", resolved in under a second
  (case 3).
- **Late tombstone.** Looks honest, is not: the same `undelivered` / 30005, but
  stamped at EXACTLY 72h + 1s after send - Twilio's validity period expiring on
  a leg nothing ever accepted. Distinguishable from the honest signature ONLY by
  `date_updated - date_sent` (case 4).

Cases 1 and 2 were found after the carrier-size fix deployed (2026-08-20 22:33
UTC, tag dev-46aef7f5). Scoped to THAT signature the original claim still holds
and is worth keeping because it is falsifiable: every outbound MMS leg that
stuck at `sent` forever went to one of two destination services, and every MMS
leg to a major carrier either delivered or failed loudly. Re-verified
account-wide 2026-08-24 - there are exactly five `sent`-forever MMS legs, three
to a TextNow line and two to a Dish line, and no others.

**Case 1: Dish Wireless (Boost Mobile), 2026-08-23.** Relay tour group
conv-07e4f611-0e7b-4646-acc6-f872f183e363, two members. The same photo (277 KB
original, transcoded to an 82 KB single JPEG - far under every carrier limit)
was sent twice:

| when (UTC) | Verizon member | Dish member (+1770256xxxx) |
| --- | --- | --- |
| 15:37:45 | delivered in 6s | `sent` forever, sid MM57cfe7af... |
| 19:13:14 | delivered in 6s | `sent` forever, sid MMb71e7707... |

Querying the Twilio Messages resource a day later returns `status=sent`,
`error_code=null` on both Dish legs - Twilio handed off to Dish and never
learned the outcome. Our webhook logs show exactly two callbacks each
(`queued` -> `sent`), then silence. Plain SMS to the same Dish number delivered
every time, including a dozen sends the same day. The number has NEVER
successfully received an MMS from us. The recipient confirmed non-receipt
out of band (kept asking to be called instead).

**Case 2: TextNow (non-fixed VoIP), 2026-08-20/21.** 1:1 thread
conv-24fe60a2-61ca-4d74-8a30-92da3fc778ac: three outbound MMS stuck at `sent`
(MMf8701d37..., MMb2e9d003..., MM025f4cfd...) while the same thread's inbound
MMS and outbound SMS all worked.

**Case 3: Verizon Wireless, honest 30005, 2026-08-20 through 2026-08-24.** This
paragraph previously read "Not this class - an honestly-reported failure,
different problem". That was right about the SIGNATURE and wrong about the
CLASS: it is the same product failure with a different DLR. 1:1 thread
0c010e92-bedc-5ea4-bc52-49e3b8f7443a, contact
f27d1be0-6567-5a84-b858-232092768df3, +1404319xxxx. Full Twilio history for
the number, all 24 legs:

| leg | count | outcome |
| --- | --- | --- |
| outbound SMS | 10 | 10 delivered |
| inbound SMS | 8 | received, every one `num_media=0` |
| outbound MMS | 6 | 0 delivered - 6x `undelivered` / 30005 |

Six failures over four days in three separate sessions (8/20 x3, 8/21, 8/24
x2), same MMS-capable sender +16782842537, same messaging service, while the
SMS legs interleaved with them all delivered - one pair 96 seconds apart on
8/20 (SMS delivered 20:45:09, MMS failed 20:46:45). Every one of the six was
stamped final within 0-1 SECOND of send: an immediate route or handset lookup
miss, not a delayed give-up (contrast case 4). Two different JPEGs were used
across the six (108,564 B four times, 218,786 B twice), so it is not one bad
file. Twilio Lookup reports the line `mobile`, Verizon Wireless, MCC/MNC
310/012, `valid: true`, no validation errors - not a landline, not VoIP, not a
bad number. The recipient has never sent us a picture either, which is what the
all-`num_media=0` inbound column means.

**Where the failure lives is UNKNOWN - do not repeat a mechanism as fact.**
An earlier draft of this paragraph asserted "the line has no MMS record at the
carrier's MMSC". The evidence does not support naming a network element. It
supports only "destination-side, on the MMS path". At least five rival
explanations fit every observation equally well: (a) no MMS provisioning at the
carrier; (b) a routing-table miss at an MMS aggregator BEFORE the carrier, since
SMS and MMS traverse different intermediaries; (c) a recently ported or
reassigned number with live SMS routing and stale MMS routing (Lookup's
`reassigned_number` add-on is not enabled, so this was never checked); (d) a
subscriber-level picture-messaging block, or a non-MMS-capable device that
Lookup still labels `mobile`; (e) an over-the-top or forwarding layer answering
SMS with no MMS path behind it, which Lookup cannot see. Every one of them is
destination-side, so "not our misconfiguration" survives all five - and the fix
below is correct under all five, which is exactly why naming one buys nothing.

**Ruled out.** Across the cases: our webhook handling (Twilio itself has no
outcome on cases 1-2), A2P registration (campaign C0PRYAU is VERIFIED and the
sends carried the messaging service SID), and retrying (case 1's second attempt
was a byte-identical re-upload and died the same way; case 3 failed six times).
Payload size is ruled out for cases 1 and 3 (82 KB single image; two JPEGs
under 220 KB) but is the LEADING explanation for case 4 - do not carry the
rule-out across cases. For case 3 also ruled out: sender MMS capability
(+16782842537 has `mms: true`), any sender/service difference between the SMS
and MMS legs (identical), and media fetch or content-type (11200/12300 fire
before handoff, not as a 30005).

The strongest sender-side rule-out is account-wide rather than per-thread, and
is worth stating because "SMS delivers on the same campaign" is the WEAK form of
the A2P argument (SMS and MMS are provisioned separately even inside one
campaign): as of 2026-08-24 this account has sent 42 outbound MMS of which 26
delivered, and three of those delivered destinations are OTHER Verizon 310/012
lines from the same sender. Nothing on our side is broken for Verizon MMS.

**Case 4: oversized payload, 72-hour expiry wearing a 30005 mask, 2026-08-19/20.**
Contact contact-1ca650a6-ae2a-4afe-b583-3fc105c151ae, +1678847xxxx, T-Mobile.
Two outbound MMS, both `undelivered` / 30005 - and for a while this was filed
alongside case 3 as the same mechanism. It is not. Three facts separate them:

- Both were stamped final at EXACTLY 72.00 hours after send, to the second
  (sent 8/19 21:29:05 -> updated 8/22 21:29:06; sent 8/20 02:00:03 -> updated
  8/23 02:00:04). Case 3's six all resolved in 0-1 second. 72h is Twilio's
  validity period, so this is an expiry tombstone, not a rejection.
- Each carried SEVEN attachments totalling 3,069,307 bytes (~3.0 MB), far over
  every carrier MMS limit. Payload size is the leading explanation.
- The line demonstrably HAS working MMS: she sent us three inbound MMS, the
  first 58 minutes after her first failure.

Kept here rather than split out because it produces the identical staff-facing
symptom and the identical wrong flag, and because the lesson is the trap itself:
a 30005 alone does not identify a mechanism. Check `date_updated - date_sent`
and `num_media`/total bytes before concluding anything from one.

**Why it matters.** Staff cannot distinguish "carrier ate it" from
"delivered, receipt withheld" - Dish is known in the A2P world both for
discarding application-originated MMS and for not returning MMS DLRs when it
does deliver. Either way the sender believes the photo went out, and the
recipient may never see it. Retries do not help. Cases 3 and 4 add that even a
REPORTED failure leaves staff no better off: nothing durable records that this
line cannot take attachments, so the next photo is attached, sent, and lost the
same way.

**Fixed already (branch `fix/mms-30005-flag`, 2026-08-24).** The app-side half
is closed. It is NOT the fallback below:

- `app/src/routes/webhooks/twilio.ts` flagged the CONTACT `sms_unreachable` on
  any 30005/30006, including one reported on an MMS leg. That flag is a HARD
  exclusion in `routes/broadcasts.ts` (lines 347 and 661) and
  `services/audienceResolution.ts` (line 141), and matching-property sends run
  through the same seeded broadcast pipeline, so the exposure covers both.
  30005 is now MMS-scoped. **30006 deliberately is NOT** - "landline or
  unreachable carrier" is a claim about the LINE TYPE, true whichever leg
  reports it, and every 30006 in the prod audit was a real landline; scoping it
  would only lose detection when a landline's first send happens to carry media.
  Self-correcting for 30005: every consumer of the flag sends TEXT-ONLY, so a
  number truly dead for SMS stays in the audience for at most one more
  broadcast, and that leg is SMS.
- **Prod audit and cleanup.** 8 contacts carried `sms_unreachable`; 6 were
  genuine (5 landlines and a non-fixed VoIP line, all caught on SMS legs, all
  with zero delivered SMS ever). 2 were false positives written by an MMS 30005
  - case 3's contact (`partner`) and case 4's contact (`tenant`, 36/36 SMS
  delivered, 45 inbound). Both cleared 2026-08-24, leaving 6.
  **NO SEND WAS ACTUALLY MISSED**, and an earlier draft of this file wrongly
  implied one was. Prod has run exactly two broadcasts ever (8/17 and 8/20); the
  8/20 one went TO case 4's contact and delivered, and her flag was not written
  until 8/22. Nothing has run since. Case 3's contact is `type: partner` and
  every one of those fences requires `tenant`, so his flag could not have
  affected a send at all. The EXPOSURE was real and would have bitten the next
  broadcast; the incident did not happen. Case 3's flag stood ~4 days, case 4's
  ~2.
- `dashboard/src/routes/contact/deliveryStatus.ts` read 30005 as "Number is
  invalid" on an attachment bubble, which sends staff chasing a working number.
  An MMS leg now reads "Attachment didn't get through, texts may still work".
  The hedge is deliberate: 30005 still fires for a genuinely dead number, so a
  first-ever send that happens to carry an attachment must not leave staff
  believing the number takes texts. "Attachment", not "picture", because MMS
  here also carries PDFs.
- `app/src/jobs/broadcastFanOut.ts` has the same arm and was deliberately LEFT
  ALONE: broadcast sends pass no media, so its legs are always SMS. Carries a
  `TODO(mms-silent-drop-dish-textnow):` marker, because per-recipient media on
  broadcasts is an OPEN proposal (`docs/issues/broadcast-mms.md`) and the day it
  lands, that arm re-creates this bug.

**Suggested fix.** What remains. Options, not yet chosen:

1. Carrier-aware fallback: when an MMS leg sits at `sent` past the existing
   15-minute "Sent - not confirmed" window, OR comes back 30005, offer or
   auto-send a "view photo" link by SMS, which is reliable to these lines.
   Case 3 shifts the design: the timeout trigger alone cannot see an honest
   30005 (that leg never sits at `sent`), so the trigger has to be the
   failure CLASS, not elapsed time. A proactive Twilio Lookup is also weaker
   than it looked - Lookup called case 3's number `mobile / Verizon Wireless`
   with no hint of the MMS gap, so it screens Dish/TextNow-class lines but
   cannot predict this one. Only an observed failure identifies it.
2. Remember the line, not just the message. Nothing durable records "this
   number cannot receive attachments", so staff re-attach a photo and re-fail
   indefinitely; the only trace is a chip on one old bubble. The MMS-scoped
   equivalent of `sms_unreachable` is what feeds option 1's automatic path
   and what warns the composer before the send. Note case 4's trap when
   designing the trigger: an oversized payload also reports 30005, so a flag
   written off a raw 30005 would mislabel "we sent 3 MB" as "their line cannot
   take attachments". Gate on total bytes and on
   `date_updated - date_sent` before writing anything durable.
3. **Model and surface "texts cannot reach this person, but calling can".**
   This is the bigger gap the MMS work exposed, and it is mostly about
   LANDLINES rather than MMS. A landline (or a dead mobile) takes neither SMS
   nor MMS, the contact has NOT opted out, and voice works fine. Today:

   - **Detection works.** 30006 on an SMS leg flags `sms_unreachable`, and 5 of
     the 6 legitimately-flagged prod contacts are exactly this - HD Carrier
     landlines.
   - **Calling works only by omission.** Nothing on the voice path consults
     `sms_unreachable`; `voice_opt_out` is a separate staff-set do-not-call flag
     (`app/src/repos/contactsRepo.ts`). So a landline-flagged contact stays
     callable - the right outcome, but nobody decided it.
   - **The "prompt voice" half does not exist.** That phrase appears in four
     comments (`repos/contactsRepo.ts`, `jobs/broadcastFanOut.ts` x2,
     `routes/webhooks/twilio.ts`) and in no executable code anywhere. No badge,
     no composer note, no Today item, nothing suggests calling.
   - **1:1 texting is not gated either.** `services/sendMessage.ts` refuses only
     on `sms_opt_out`. So staff can sit on a known landline's contact page
     texting into the void indefinitely, watch each send fail, and never be told
     the number cannot take texts - while the Call button beside it would work.
   - **The flag has NO contact-page surface at all.** Whole-tree grep of
     `dashboard/src` finds it in `api/types.ts` (type only) and one refusal
     string in `routes/broadcasts/RecipientPreview.tsx`. Zero under
     `routes/contact/`. By contrast `sms_opt_out` gets a standing composer note
     (`routes/contact/Timeline.tsx`, the `optedOut` prop) and `email_unreachable`
     gets one too (computed in `routes/contact/ContactCommsPane.tsx`, rendered by
     `routes/contact/EmailComposer.tsx`). This invisibility is why two wrong
     flags sat unnoticed for days.

   Whatever option 2 adds needs a surface too, or it reproduces the same blind
   spot one channel over.
4. Surface per-recipient delivery truth in the UI so staff can at least see
   WHICH leg is unconfirmed (tracked separately; that work is the immediate
   follow-up to this incident).
5. Twilio support ticket on the case-1 SIDs asking for Dish-side disposition
   (human action; sometimes exposes carrier feedback the API does not).
