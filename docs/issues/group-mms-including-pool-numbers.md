---
id: group-mms-including-pool-numbers
title: A carrier group MMS that includes a relay pool number is handled by the relay branch with the group envelope dropped
type: improvement
severity: med
status: open
area: app/messaging
created: 2026-08-10
refs: app/src/routes/webhooks/twilio.ts, docs/superpowers/specs/2026-08-10-group-texting-design.md
---

**Problem.** Inbound routing resolves pool-number traffic (To = pool number)
through the relay branch before group detection runs. If a contact starts a
carrier group text that includes a pool number they know, the relay branch
files/fans out per relay rules and the `OtherRecipients{N}` envelope is
dropped - the group is undetected. Pool numbers are real numbers contacts
have in their phones, so this is reachable, though the primary group-texting
population (business-number groups) is unaffected.

**v1 decision (group-texting spec, 2026-08-10):** documented limitation.
Changing relay routing is out of that mission's scope ("relay untouched").

**Possible later fix.** Teach the pool-number branch to notice
OtherRecipients and at minimum log/flag group-origin inbound on pool numbers,
or route such messages to group detection when the sender is not a member of
any group fronted by that pool number. Needs care: the relay closed-group
intercept and fan-out semantics must not regress.

**Update, 2026-08-11 (fix wave 2 + wave 4, adjudication A6).** The ROUTING is
still exactly as described above and deliberately so - relay behavior is
unchanged (spec invariant 13.6) - but the filing is NO LONGER SILENT. Every
envelope-bearing inbound that lands on a number group detection does not own
is now MARKED with `group_ambiguous_origin` (so AI fact extraction never reads
possible group content as one contact's own speech) and ALARMED, on three
named, rate-limited WARNs:

- `group_envelope_off_business_number` - the pool-number / other-org-number
  fall-through this issue is about;
- `group_envelope_via_closed_relay_group` - the same envelope arriving on a
  pool number whose every group is CLOSED, intercepted into the sender's 1:1;
- `group_detection_unconfigured` - BUSINESS_PHONE_NUMBER unset, so detection
  is structurally off and EVERY group inbound takes this path.

Spec invariant 13.1 now enumerates all five marked 1:1 filings. So the
remaining gap is narrower than when this was filed: the group is still
undetected and gets no native thread, but nobody is misattributed and the
occurrence is visible in the logs. That makes the "possible later fix" a
product decision about detection coverage rather than a data-integrity fix.
