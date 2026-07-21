---
id: email-identity-collision-followup
title: Email addresses are one-contact-only (shared/forwarded addresses not modeled)
type: improvement
severity: med
status: open
area: app
created: 2026-07-21
refs: app/src/repos/contactsRepo.ts, app/src/repos/conversationsRepo.ts, app/src/services/inboundEmail.ts, docs/issues/email-as-first-class-channel.md
---

**Problem.** Email channel v1 enforces ONE contact per address. `addEmail` writes an
`emailref#<address>` pointer with a conditional put and returns `email_in_use` on
conflict, and the `email#<address>` claim in `conversationsRepo` makes each address
the SOLE property of exactly one conversation (the claim arbiter). That is correct and
safe for v1 - there is no silent cross-contact leakage, and an inbound always threads
to a single, unambiguous owner - but it does NOT model addresses that legitimately
belong to more than one party: a shared inbox (`info@agency.org` used by several
caseworkers), a couple sharing one address, or a forwarding alias. Today the second
contact that tries to claim such an address is simply refused with `email_in_use`, and
inbound mail from a shared address always threads to whichever contact claimed it
first - the others never see it.

**Suggested fix (spec B9).** Model shared/ambiguous addresses deliberately: allow an
address to map to multiple contacts with an explicit disambiguation step - staff pick
the party on inbound, or the address is marked "shared" and its mail lands in a chooser
rather than auto-threading. Keep the v1 unique-claim as the DEFAULT (so the safe path
is never weakened) and add the many-contacts case as an opt-in shape. Revisit the
`email#` / `emailref#` claim arbiter and the tier-6 `findByEmail` routing together, and
decide how the timeline/unread model attributes a shared-address thread.
