---
id: staff-unmute-vs-per-phone-optout
title: Staff clearing a contact's DNC flag does not restore relay legs after the person's own STOP - deliberate precedence, no staff override exists
type: decision
severity: low
status: open
area: app
created: 2026-07-18
refs: app/src/routes/contacts.ts:1428, app/src/services/relayAnnouncements.ts:70, app/src/routes/webhooks/twilio.ts:570
---

**Problem.** Since relay-open-path-stop widened the per-leg gate, relay
suppression truth is the contact `sms_opt_out` flag OR the member phone's
own 1:1 conversation `sms_opt_out` flag (BE1 per-phone scope). The 1:1
conversation flag's ONLY writer is `processInboundKeywords` - i.e. the
person texting STOP/START themselves. Consequence: after a member texts
STOP, staff clearing the DNC toggle on the contact page does NOT restore
relay legs (fan-out, announcements, group-routed tour reminders) - the
contact page shows the person reachable while every leg stays skipped and
the Today "Opted out of a group text" item keeps live-confirming true. No
staff surface clears the per-phone conversation flag; only the person
texting START does.

**This is the intended A2P precedence** (recorded in the feature plan as a
watch item): the person's own opt-out outranks staff, and the same
precedence has always applied on the 1:1 send path (`sendMessage` checks
the conversation flag too). Do NOT silently "fix" it.

**Revisit trigger / candidates** (only if staff genuinely need an
override):

1. Surface "reply START to re-enable" in the Today attention item copy so
   staff know the remediation channel.
2. Make the contact-page DNC clear show a confirmation that names the
   still-set per-phone opt-out ("This person opted out by text; only they
   can opt back in by replying START").
3. An explicit, audited staff override that clears the conversation flag
   (compliance review required first - overriding a consumer's own STOP
   is the risky direction).
