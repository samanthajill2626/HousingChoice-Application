---
id: relay-duplicate-across-contact-handsets
title: The duplicate warning compares phones, so the same people on different numbers do not match
type: improvement
severity: low
status: open
area: app
created: 2026-08-18
refs: app/src/services/relayGroupDuplicates.ts:45, app/src/services/groupMembers.ts:32
---

**Problem.** `findOpenGroupWithSamePhones` compares E.164 phone numbers, not
contact identities. So a live group holding Dana on her cell and Marcus on his
office line does NOT match a proposed group holding the same two humans on any
other pair of numbers, and no warning renders. The operator creates the second
group believing it is the first one for that relationship.

Comparing phones is a deliberate decision, not an oversight (spec D3). Two
independent reasons hold it in place:

- `app/src/services/groupMembers.ts:32` already rules against the
  contactId-preferring `relayMemberKey` for roster identity, because one contact
  owning TWO numbers would collapse into a single delivery slot.
- Inbound SMS resolves on `(To, From)`, so PHONES are what relay routing
  actually keys on. A duplicate-detection rule that disagreed with the routing
  key would be describing a different system than the one running.

So this is a real gap in coverage rather than a bug in the comparison. The
warning under-fires here; it never over-fires, which is the correct direction
for an advisory that operators must not learn to click through.

**Suggested fix.** A second, weaker pass that matches on resolved contactId sets
and renders a differently-worded warning ("these people already have a group,
reached on other numbers"). It must stay separate from the exact-phone match:
merging them would mean a single warning whose claim is sometimes about numbers
and sometimes about people. Wants a real example from operations before it is
worth building - it is not clear how often one household is reached on two
handsets in practice.
