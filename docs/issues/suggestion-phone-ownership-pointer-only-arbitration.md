---
id: suggestion-phone-ownership-pointer-only-arbitration
title: Phone-accept ownership is arbitrated on the pointer row only, so a number held as another contact's primary can end up double-owned
type: bug
severity: med
status: open
area: app/suggestion-resolution
created: 2026-08-09
refs: app/src/repos/suggestionResolutionRepo.ts:789, app/src/repos/contactsRepo.ts:687, app/src/repos/contactsRepo.ts:962, app/src/services/suggestionResolution.ts:334, app/test/suggestionResolutionRepo.integration.test.ts:752, app/test/aiRunVerdicts.test.ts:854
---

**Problem.** `commitPhoneEffect` decides whether a suggested number already
belongs to somebody else by reading the `phoneref#<E.164>` POINTER row alone
(`suggestionResolutionRepo.ts:789-803`). A contact's PRIMARY number deliberately
has no pointer: `addPhone` writes pointers only for non-primary numbers
(`contactsRepo.ts:962-990`), and `commitPhoneEffect` deletes the pointer when the
number is this contact's own primary. A number held as some OTHER contact's
primary is therefore invisible to the conflict check, and the fenced transaction
proceeds: it attaches the number to this contact's `phones[]` and writes a
`phoneref#` row owned by this contact.

The `byPhone` GSI then carries TWO items for that number - the other contact's
row (via its `phone` scalar) and this contact's pointer row - and `findByPhone`
returns "the FIRST item the GSI yields (arbitrary order)"
(`contactsRepo.ts:686-713`, its own comment). Inbound SMS and voice for that
number route nondeterministically to either contact. That is misrouted tenant
communication, not a cosmetic duplicate.

**Why it is not simply fixed here.** DynamoDB cannot condition a transaction on a
GSI, and "is this number somebody else's primary" is only answerable through the
eventually consistent `byPhone` GSI (or a Scan). A durable fix means changing the
data model so a primary also carries a pointer - a migration across every
existing contact, plus new `removePhone`/`setPhone` invariants.

**What is already in place.** The ordinary accept path has always run an advisory
`contactsRepo.findByPhone` pre-check before claiming
(`suggestionResolution.ts:555-560`), and that check DOES see a primary scalar. As
of this branch the HELP path - a journal replayed after a crash, reached through
`resolve()`'s takeover or through `recoverAbandoned` on the contact's suggestions
read - runs the same advisory pre-check (`suggestionResolution.ts:328-336`), so
the two entry points are no longer asymmetric. Because that read is eventually
consistent it narrows reachability rather than proving ownership: a number that
changes hands inside the read-to-transaction window still slips through.

**Repro (the characterized shape).**
`app/test/suggestionResolutionRepo.integration.test.ts:752` "does NOT detect a
number held as another contact primary (reported gap)" claims a phone journal
against a number that another contact holds as its primary scalar, calls
`commitPhoneEffect` directly, and pins that it returns `committed` and mints a
pointer owned by the wrong contact. The service-level mitigation is pinned at
`app/test/aiRunVerdicts.test.ts:854` "does NOT attach a number that became another
contact PRIMARY while a journal was abandoned". Both go red when the gap is
closed, which is the intended forcing function.

**Suggested fix.** Give primary numbers a pointer row too (one-time migration,
then `commitPhoneEffect`'s existing pointer arbitration becomes total), or move
phone ownership into a dedicated single-owner item that every writer conditions
on. Until then the failure is repairable after the fact: `removePhone` deletes the
pointer and restores single-owner resolution.
