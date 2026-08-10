---
id: group-mms-including-pool-numbers
title: A carrier group MMS that includes a relay pool number is handled by the relay branch with the group envelope dropped
type: improvement
severity: medium
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
