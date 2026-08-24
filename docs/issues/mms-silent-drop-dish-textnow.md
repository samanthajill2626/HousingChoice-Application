---
id: mms-silent-drop-dish-textnow
title: Dish Wireless and TextNow silently drop carrier-sized outbound MMS with no error DLR
type: bug
severity: med
status: open
created: 2026-08-24
area: app
refs: docs/issues/outbound-mms-stalls-at-sent-with-no-receipt.md
---

**Problem.** Since the carrier-size fix deployed (2026-08-20 22:33 UTC, tag
dev-46aef7f5), every outbound MMS leg that stuck at `sent` forever went to one
of two destination services; every MMS leg to a major carrier delivered.

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

**Not this class.** 0c010e92-bedc-5ea4-bc52-49e3b8f7443a got 4x `undelivered`
with error 30005 (unknown destination handset) - an honestly-reported failure,
different problem.

**Ruled out.** Payload size (82 KB single image), our webhook handling (Twilio
itself has no outcome), A2P registration (campaign C0PRYAU is VERIFIED, and the
sends carried the messaging service SID), and retrying (the second attempt was
a byte-identical re-upload and died the same way).

**Why it matters.** Staff cannot distinguish "carrier ate it" from "delivered,
receipt withheld" - Dish is known in the A2P world both for discarding
application-originated MMS and for not returning MMS DLRs when it does deliver.
Either way the sender believes the photo went out, and the recipient may never
see it. Retries do not help.

**Suggested fix.** Options, not yet chosen:

1. Carrier-aware fallback: when an MMS leg sits at `sent` past the existing
   15-minute "Sent - not confirmed" window - or proactively, via a Twilio
   Lookup identifying Dish/TextNow-class lines - offer or auto-send a
   "view photo" link by SMS, which is reliable to these lines.
2. Surface per-recipient delivery truth in the UI so staff can at least see
   WHICH leg is unconfirmed (tracked separately; that work is the immediate
   follow-up to this incident).
3. Twilio support ticket on the case-1 SIDs asking for Dish-side disposition
   (human action; sometimes exposes carrier feedback the API does not).
