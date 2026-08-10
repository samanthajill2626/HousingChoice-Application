---
id: inbound-group-mms-detection
title: Inbound group MMS is invisible as a group - detection is needed regardless of any outbound feature
type: bug
severity: high
status: open
area: app/messaging
created: 2026-08-09
refs: app/src/routes/webhooks/twilio.ts, docs/issues/regular-group-texting-for-imported-groups.md
---

**Problem.** When someone includes our number in a carrier group text, the app
has no idea. The inbound webhook models every message as 1:1 from its sender:
the group envelope (who else is on the thread) is not read, not stored, and not
shown. Two failure modes follow:

1. **Blind spot** (Cameron, 2026-08-09: "We need to be able to see if someone
   adds us to a group text number and see those messages" - "I didn't realize
   that was a blind spot"). A tenant adds us to a group with their caseworker,
   or a landlord loops us in with a contractor - staff see what looks like a
   normal 1:1 and never know two other people are reading it.
2. **Group forking.** A staff reply from the app goes only to the sender as a
   1:1, silently splitting the conversation the other participants still see as
   one thread. This gets acute at cutover (2026-08-17): the founder's contacts
   are USED to group-texting her 678 number - the imported corpus has 132 such
   threads, and new ones will arrive on day one.

**Scope: detection only.** This issue is deliberately independent of outbound
group sending (`regular-group-texting-for-imported-groups`). Cameron's ruling:
detection "should live REGARDLESS of if we have new outbound group texts" -
seeing that a message arrived on a group, and who else is on it, is table
stakes even if replying to the group is not yet possible.

**Verify first - what Twilio actually delivers.** The design hinges on what an
inbound group MMS looks like at our webhook: whether the other recipients are
exposed (and under what parameters), and whether that requires enabling
Twilio's group-texting capability on the number. Evidence that the envelope IS
recoverable upstream: Quo's export lists the full recipient set on inbound
group messages (`to` = our number plus the other members - that is how the 132
imported groups were reconstructed at all). Step one is empirical: send a group
MMS to a test number and inspect the webhook payload.

**Sketch once verified.**

- Recognize group inbound; resolve/create the group thread (participant-set
  identity, exactly as the importer keys imported groups) instead of filing the
  message into the sender's 1:1.
- Render it as a group in the dashboard with the member list visible.
- Until outbound exists: composer disabled (or clearly marked staff-to-sender
  only) on such threads, so a reply cannot silently fork the group.
- Imported `connecting` threads and newly detected groups should share one
  representation - this issue and the importer must agree on identity.

**Interim if detection cannot land by 2026-08-17:** at minimum an operator rule
("group texts to the business number will look like 1:1s - check before
replying") in the RUNBOOK/cutover notes.
