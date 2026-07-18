---
id: relay-open-path-stop-not-processed
title: Relay-member STOP to a pool number is not processed on the OPEN group path
type: debt
severity: med
status: resolved
area: app
created: 2026-07-17
resolved: 2026-07-18
refs: app/src/routes/webhooks/twilio.ts:325
---

**Problem.** A relay-group member who texts STOP (or any opt-out keyword) to the
pool number while their group is OPEN never has the keyword processed. The open
inbound path `handleRelayInbound` (app/src/routes/webhooks/twilio.ts, approx
lines 325-443) only persists the message and enqueues the fan-out; it runs no
STOP/HELP/opt-in keyword logic and never reaches the `/sms` handler section (4)
keyword block (the relay branch returns before it). So relay members have never
been able to opt out by texting STOP to their pool number - relay opt-out relies
entirely on `contact.sms_opt_out` being set via the 1:1 or broadcast paths
(relayAnnouncements.ts / relayFanOut.ts read that contact flag to suppress).
This is an A2P/compliance exposure: a member who texts STOP to the group number
keeps receiving relayed messages and announcements until they also STOP on the
main number.

This is systemic and pre-existing (adversarial review finding PE-2), NOT
introduced by the relay-number-lifecycle branch. That branch DID fix the
closed-group continuation of the same gap (finding AF-4): a closed-group
member's STOP now routes through the shared `processInboundKeywords` path and
sets both the conversation and (primary-number) contact opt-out flags. Open-path
parity is the outstanding follow-up.

**Suggested fix.** Run the same keyword detection (OPT_OUT_KEYWORDS / OptOutType
via `processInboundKeywords`, the seam AF-4 already reuses) inside
`handleRelayInbound` before/while persisting the inbound relay message, so a
relay member's STOP on the OPEN path sets `contact.sms_opt_out` (and the
conversation flag) exactly like the 1:1 and closed-group paths. Decide the reply
behavior (a STOP confirmation TwiML vs empty) and whether the STOP should also
suppress the current message's own fan-out. Keep the single keyword source of
truth (lib/smsCompliance.ts) - do not fork a parallel keyword list.

**Resolved (2026-07-18, feat/relay-open-path-stop).** The open path now runs
the shared keyword logic: classifyInboundKeyword (lib/smsCompliance.ts) +
processInboundKeywords against the sender's own 1:1; bare STOP/HELP never fan
out; opt-in keywords are commands only from a currently-suppressed sender
(human ruling); isMemberSuppressed also honors the member phone's 1:1
conversation flag (BE1 per-phone corner). Follow-ups spun out:
relay-open-keyword-phantom-1to1, staff-unmute-vs-per-phone-optout,
fake-phones-no-twiml-replies.
