---
id: one-to-one-sender-not-pinned-to-ported-number
title: 1:1 SMS lets Twilio pick the sender, so tenants may not see the ported number
type: bug
severity: high
status: open
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

**Suggested fix.** Give the 1:1 path an explicit sender, from config:

1. Add a config value for the business sending number (e.g. `SMS_FROM_NUMBER`, or
   derive it from `OUR_PHONE_NUMBERS[0]` which is already the outbound voice caller
   ID - see below).
2. Pass it as `from` on the non-relay send path in `sendMessage`, exactly as relay
   already does. The number is in the service's sender pool, so A2P registration
   still applies - this pins WHICH sender, it does not bypass the service.
3. Leave relay alone; it correctly pins its own pool number.

**Related trap - `OUR_PHONE_NUMBERS` ordering.** That variable is NOT the sending
number: its documented job is the inbound webhook echo/author defense (drop our
own outbound projected back) plus timeline display. But
`webhooks/voice.ts:295` takes `config.ourPhoneNumbers[0]` as the **outbound voice
caller ID**. So when the ported number is added to that list it must go **first**,
or masked calls keep presenting the old (404) number even after the port. Worth
stating in the cutover procedure, because appending to a comma-separated list is
the natural thing to do and it would be wrong.

Related: `ported-number-not-on-a2p-campaign`.
