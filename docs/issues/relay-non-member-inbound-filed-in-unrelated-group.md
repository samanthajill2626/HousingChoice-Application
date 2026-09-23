---
id: relay-non-member-inbound-filed-in-unrelated-group
title: A non-member text or call to a pool number is filed into whichever open relay group is newest, an unrelated group
type: bug
severity: med
status: open
area: app/relay
created: 2026-09-23
refs: app/src/services/relayInboundResolution.ts:93, app/src/routes/webhooks/twilio.ts:2282, app/src/routes/webhooks/twilio.ts:948, app/src/routes/webhooks/twilio.ts:980, app/src/routes/webhooks/voice.ts:509, app/test/relayWebhook.test.ts:567, app/test/voiceWebhook.test.ts:266, docs/superpowers/specs/2026-07-17-relay-number-lifecycle-design.md:141
---

**Problem.** When someone who is on NO roster texts or calls a pool number
that still fronts at least one open group, the shared ladder's rung (c)
`non_member_open` picks the NEWEST open group on that number
(`relayInboundResolution.ts:93`) and both channels file the inbound there:

- SMS: `handleRelayInbound` appends the text to that group's transcript
  (`twilio.ts:2282`). It is NOT fanned out (`twilio.ts:948`, "persisted, no
  fan-out"), so no participant receives it. It does increment unread, bump
  `last_activity_at`, overwrite `last_message_preview`, and fire an inbound
  push labeled as that group's thread (`twilio.ts:980-1003`).
- Voice: the masked refusal ("Not connected") row is filed on the same group
  (`voice.ts:509-513`).

The group chosen has no relationship to the sender. The rung came from the
relay-number-lifecycle spec, which said to "keep today's behavior for a
non-member inbound" (spec line 141). That behavior made sense when a pool
number fronted ONE group. The same spec then made pool numbers front MANY
participant-disjoint groups, so "the group on this number" became "whichever
open group was created last". The caller-identity spec already concedes this
for voice (its invariant I1: the selection "determines where the record
lives, not which group the caller intended"). SMS has no equivalent framing:
the stranger's text renders in the group transcript as ordinary inbound
content.

Who hits this:

1. Strangers. Pool numbers are bought from Twilio and are often recycled, so
   people who saved the number for its previous owner text and call it.
2. A roster member texting from a NEW phone. They are a non-member by
   `participant.phone === From`, so they land in the newest open group. With
   several open groups on the number, that is usually SOMEONE ELSE'S group,
   and staff reading it there see a message in the wrong placement's context.
3. A removed member (already listed as item 2 of
   [relay-inbound-resolution-residuals](relay-inbound-resolution-residuals.md)).

Rung (d) `all_closed_non_member` already rejects this for the all-closed
case (AF-5: "do not bury the contact in a dead group transcript - it could
hide a real message from a stranger, a second phone, or a member from a NEW
phone"). The same argument applies when open groups exist. The open group
is not dead, but it is still the wrong conversation.

**Evidence (prod, 2026-09-23).** Pool number +14049744616 fronted four open
groups (conv-86d12199, conv-b813fa3f, conv-b049fcc2, conv-a470f3bc). Between
18:40Z and 19:28Z, two phones that match no contact and no conversation sent
four unsolicited texts (one an auto-reply, three inappropriate) and placed
two calls. All six rows were filed on conv-a470f3bc, only because it was
created last (2026-09-17 21:23Z). Its `last_message_preview` became the final
stranger text. Every text row carries an EMPTY `delivery_recipients` map (0
legs, versus 1 leg on every real member text in the thread), confirming
nothing was relayed. Staff closed the group at 19:30:44Z. The next stranger
inbound on that number now lands in conv-b049fcc2, an equally unrelated
group. The pool number was provisioned 2026-09-08, consistent with (but not
proof of) a recycled number.

**Suggested fix.** A product call is needed first; the options are:

- (A, recommended) Make rung (c) behave like rung (d). The ladder returns "no
  group" for any non-member, and each channel falls through to its intake
  path. For SMS that is the 1:1 path: stub contact, needs-triage inbox row,
  and a staff reply from the business number, which is the honest identity
  for someone who is not in a group. Record provenance on the 1:1 row
  ("arrived on relay number X") so staff can see where it came in; that is
  the analogue of the closed-member intercept's provenance. For voice, (d)
  currently means founder call-triage, which would ring the founder's cell
  for every stranger or spam call. Voice may instead keep the refusal TwiML
  and file the row on the caller's 1:1. Decide that per channel. Keep the
  selection change inside `relayInboundResolution.ts` so SMS and voice move
  together.
- (B) Keep filing on the group, but mark non-member rows as clearly foreign:
  no unread, no preview, no push, and a "not a member of this group" framing
  on the SMS row, matching the voice card's copy. This is cheaper, but the
  choice of group stays arbitrary, and case 2 above (a member on a new phone
  shown in another placement's group) is not fixed.

Either way, the current behavior is PINNED by tests that must change with
it; expect them to go red, and do not read that as a regression:
`relayInboundResolution.test.ts:81` (rung c picks the newest open group),
`relayWebhook.test.ts:567` (SMS persisted on the newest open group),
`voiceWebhook.test.ts:266` (voice refusal on the newest open group), and
`inboundMessagePush.test.ts:467` (push fires on the newest open group).
