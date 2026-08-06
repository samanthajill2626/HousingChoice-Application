---
id: one-to-one-sender-not-pinned-to-ported-number
title: 1:1 SMS lets Twilio pick the sender, so tenants may not see the ported number
type: bug
severity: high
status: open
confirmed: 2026-08-06
area: app/messaging
created: 2026-08-06
refs: app/src/services/sendMessage.ts:326, app/src/adapters/messaging.ts:590, app/src/lib/config.ts:1130
---

**Problem.** The whole point of porting `+1 678-284-2537` at the M1.11 cutover is
that the founder's tenants and landlords already know that number. But nothing in
the app decides which number a 1:1 message is sent FROM.

`sendMessage` passes `from` only when a caller supplies it, and the only callers
that do are the relay paths (`relayFanOut.ts`, `relayAnnouncements.ts`, both
pinning a pool number). For an ordinary 1:1 send it is omitted, and the Twilio
driver then sends with `messagingServiceSid` alone. The adapter says so outright:

> Relay fan-out (M1.7): pin the send to a specific pool number while staying
> inside the A2P service... **Omitted for the 1:1 path - the service picks the
> sender.**

After cutover that Messaging Service's sender pool contains the main opt-in number
**(404) 982-4978**, the newly ported **678** number, and **every relay pool
number**. Twilio chooses between them (Sticky Sender, then Geomatch, then Round
Robin).

Sticky Sender does not save us here: it reuses whichever number last messaged that
recipient *from our Twilio account*, and these 629 imported contacts have never
been messaged from our account at all - their entire history was in Quo. So the
FIRST message each of them receives from the new system is sent from a
service-chosen number, which may well not be the 678 number they recognise.

The failure is quiet and the wrong way round: everything is delivered, nothing
errors, and the tenant simply gets a text from a stranger.

**TWO call sites, not one.** `adapter.sendMessage` has four callers. Two already
pin correctly (`relayFanOut.ts:482`, `relayAnnouncements.ts:231` - both the pool
number). The two that do NOT pin are:

- `services/sendMessage.ts:326` - the shared send service, which everything
  funnels through (broadcasts, missed-call auto-text, placement nudges, tour
  reminders, retries, the api + public routes)
- `routes/voiceApi.ts:245` - the **staff cell-verification SMS**, which calls the
  adapter DIRECTLY and bypasses the send service entirely

Fixing only the first would leave verification codes still service-routed. Low
harm (they go to our own staff) but it is the same defect and the campaign's
Sample 5 describes them, so pin both.

**Suggested fix.** Give the unpinned paths an explicit sender, from config:

1. Add a config value for the business sending number (e.g. `SMS_FROM_NUMBER`, or
   derive it from `OUR_PHONE_NUMBERS[0]` which is already the outbound voice caller
   ID - see below).
2. Pass it as `from` on the non-relay send path in `sendMessage`, exactly as relay
   already does. The number is in the service's sender pool, so A2P registration
   still applies - this pins WHICH sender, it does not bypass the service.
3. Leave relay alone; it correctly pins its own pool number.

**What `OUR_PHONE_NUMBERS` actually drives.** It IS the app's notion of "our
business numbers", and it feeds more than first appears. The WHOLE LIST answers
"is this us?":

- `webhooks/twilio.ts:278` - inbound SMS echo/author defense (an inbound whose
  From is one of ours is our own outbound projected back; dropped, never processed)
- `webhooks/voice.ts:291` - the same defense on the voice webhook
- `webhooks/voice.ts:382` - call routing ("To is a business number -> founder")
- `webhooks/voice.ts:1215` - `teamNumbers`

And `ourPhoneNumbers[0]` specifically is treated as THE main business number:

- `originateCall.ts:96` and `webhooks/voice.ts:295,1119` - the **outbound voice
  caller ID**
- `public.ts:175` + `app.ts:136` - the **public flyer's "text us" CTA number**
- `contactTimeline.ts:340` - which side of a thread renders as us

Plus a boot guard: prod + the twilio driver + an empty list fails fast
(`config.ts:1144`).

**So the ordering matters twice over.** The ported number must go FIRST in that
list or outbound calls keep presenting the old (404) number AND the public flyer
keeps advertising it. Appending to a comma-separated list is the natural thing to
do, and it would be wrong.

**Why it has always worked so far (asked 2026-08-06).** Two different mechanisms
that happen to agree today:

- **Voice IS pinned, by design.** `originateCall.ts:96` reads `ourPhoneNumbers[0]`
  and passes it as the caller ID. Adding a second entry changes nothing; `[0]`
  still wins.
- **SMS is NOT pinned, and `OUR_PHONE_NUMBERS` has no bearing on it** - no code on
  the send path reads it. Outbound 1:1 has gone from the one number because that
  is what the Messaging Service's sender pool offers, not because the variable
  lists one number. The two facts coincide; they are not connected.

That is what makes the cutover steps asymmetric: adding the ported number to
`OUR_PHONE_NUMBERS` fixes voice caller ID, the flyer CTA and the echo defense but
does nothing for SMS sending, while adding it to the Messaging Service (required
for A2P) is precisely the step that introduces sender ambiguity.

**CONFIRMED 2026-08-06 (Cameron, from the Twilio console): at least two relay
numbers are already attached to that same Messaging Service.** So this is not a
cutover risk in waiting - the pool ALREADY has multiple senders and a 1:1 send can
already draw a relay pool number today. We have been carried by Sticky Sender and
low volume, not by design. The port raises the stakes (it adds the number every
tenant recognises, and prod SMS turns on) but the defect is live now.

**And note the assumption this issue breaks.** `public.ts:161` describes
`ourPhoneNumbers[0]` as "the SAME main number all 1:1 Twilio traffic uses". That
is an assumption the send path never enforces - it was simply true while the
Messaging Service had effectively one sender to choose from. Relay pool numbers
already sit in that same service, so the invariant is arguably already soft today;
the port makes it acute, and makes the flyer's promise ("text us at this number")
something we can no longer guarantee we send from.

Related: `ported-number-not-on-a2p-campaign`.
