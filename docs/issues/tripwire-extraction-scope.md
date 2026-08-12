---
id: tripwire-extraction-scope
title: The missing-envelope tripwire permanently removes ordinary subject-only 1:1 MMS from AI fact extraction
type: bug
severity: med
status: open
area: app
created: 2026-08-11
refs: app/src/services/groupEnvelope.ts:108, app/src/routes/webhooks/twilio.ts:1723, app/src/repos/messagesRepo.ts:1322, app/src/jobs/extraction.ts:425
---

**Problem.** `isMissingEnvelopeGroupShape`
(`app/src/services/groupEnvelope.ts:108-117`) is a tripwire for a group-detection
OUTAGE: it matches any inbound whose provider SID is MM-prefixed, whose
`NumMedia` is 0, and which carries no `OtherRecipients` envelope - the shape a
carrier group inbound would take if Twilio stopped sending the undocumented
envelope. Its own docstring concedes the overlap: "a subject-only 1:1 MMS matches
it too - which is exactly why the caller files the message (fail open) and WARNs
rather than erroring".

But the caller does more than warn. `app/src/routes/webhooks/twilio.ts:1723-1735`
sets `groupAmbiguousOrigin = true`, which is PERSISTED on the message row
(`messagesRepo.ts:1322`), and `app/src/jobs/extraction.ts:425-432` filters every
message carrying that marker out of the transcript window - for the LIFE of the
message, not just for the current run.

**Failure walk.** A tenant on an iPhone sends an ordinary 1:1 message with a
subject line to the business number. Twilio delivers `MessageSid=MM...`,
`NumMedia=0`, and no `OtherRecipients`. The tripwire fires. The message is filed
to the tenant's 1:1 and renders normally in the inbox and the contact timeline -
staff see it, everything looks fine - but AI fact extraction never sees it. Any
voucher size, move-in date, income figure or landlord decision stated in that
message is silently never extracted. The only trace is a rate-limited WARN saying
"possible group-detection outage", which does not say and does not resemble "we
dropped this tenant's message from extraction".

**What is right and what is wrong here.** The fail-open FILING decision is right:
if the envelope really has stopped arriving, filing the message and alarming
beats dropping it. What is being deferred is the coupling of a PERMANENT
extraction marker to a heuristic the code itself documents as matching legitimate
1:1 traffic. No cheap partial was identified that keeps the safety property (a
real envelope outage must not let group content be read as one contact's own
speech), which is why this is filed rather than fixed.

**UNVERIFIED, and it is the thing that decides the severity.** What fraction of
real 1:1 traffic arrives as `MM` with `NumMedia=0`? Subject lines are an iOS
convenience feature; if a meaningful share of tenants use them, this is high, not
med. Measuring it needs nothing but a count over the existing message rows:
inbound, MM-prefixed SID, `NumMedia=0`, no envelope, on the business number.
Do that first.

**Sibling path, already fixed - do not re-file it.** Finding 32 identified the
same permanent marker being applied on the pre-existing closed-relay-group
intercept (`twilio.ts:833-841, :868-872`). That one WAS fixed on
`feat/group-texting` (the marker is removed on that path, restoring prior relay
behavior). THIS issue is the TRIPWIRE path only.

**Suggested fix.** Directions, none of them free:

1. **Narrow the heuristic.** Anything that distinguishes a subject-only 1:1 MMS
   from an envelope-less group inbound at the wire level (a `Subject` parameter,
   segment characteristics) would shrink the false-positive population without
   giving up the tripwire. Needs a live sample to design against - see the
   measurement above.
2. **Decouple duration from detection.** Make the extraction exclusion
   REVERSIBLE: keep the marker, but have the group-detection health signal clear
   it once the envelope is confirmed to be arriving normally again, so a false
   positive costs a delay rather than a permanent loss.
3. **Make the loss visible.** At minimum, the operator-facing WARN should say
   what was actually done to the message ("excluded from fact extraction"), and
   the count of excluded messages should be a queryable number rather than a log
   line, so the cost of the tradeoff is measurable instead of assumed.
