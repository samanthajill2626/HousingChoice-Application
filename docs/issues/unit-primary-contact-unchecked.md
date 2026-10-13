---
id: unit-primary-contact-unchecked
title: A property's primary_contact is writable on unit create and PATCH with any contactId - no existence, type, caseworker or contact-list check
type: debt
severity: low
status: resolved
resolved: 2026-10-13
area: app/units
created: 2026-10-12
refs: app/src/lib/unitFields.ts:104, app/src/routes/units.ts:1072, app/src/repos/unitsRepo.ts:839, app/src/routes/webhooks/voice.ts:627, app/src/repos/conversationsRepo.ts:207, app/src/services/rosterProvision.ts:233
---

**Problem.** `primary_contact` is a property's scalar "default contact"
(relay groups and masked calls - the comment on `POST /api/units/:id/contacts`,
`app/src/routes/units.ts:1072-1075`). It is a plain writable string on BOTH
`POST /api/units` and `PATCH /api/units/:id` (`app/src/lib/unitFields.ts:104`,
validated by `validateUnitBody` in both modes), and any contactId is
accepted: nothing checks that the contact exists, what it is typed, whether
it is a caseworker, or whether it holds a seat on the property's contact
list. The contact-list writer (`POST /api/units/:id/contacts`, repo
`addContact`) keeps the scalar consistent with the list's `primaryContact`
flag (`app/src/repos/unitsRepo.ts:839-848`); a direct write bypasses that, so
the scalar can name a contact who is not on the list at all. No dashboard
screen writes it directly today.

Since `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, I4) a
caseworker cannot take a NEW contact-list seat (409
`contact_list_caseworker`), but a direct `primary_contact` write can still
name one as the property's default contact without ever taking a seat. Found
by that branch's plan review (round 1, reviewer A, F7) and deferred: it is
not a contact-list seat by the spec's definition, and nothing routes on the
SCALAR today - the readers that pick a property's contact use the contact
list's `primaryContact` flag with the landlord-of-record fallback
(`app/src/services/rosterProvision.ts:233` and `:525`,
`app/src/lib/tourContacts.ts:124`, `app/src/lib/rosterResolution.ts:293`).
The scalar's only other mentions are comments naming it as the future
landlord-leg target of the main-number masked call
(`app/src/routes/webhooks/voice.ts:627`, which says that path "stays M1.10";
`app/src/repos/conversationsRepo.ts:207`), and the comment at
`app/src/repos/unitsRepo.ts:840-841` that says the masked-call landlord leg
dials it today, which the voice route does not bear out. When that M1.10
path is built on the scalar, the gap becomes live: a caseworker, a deleted
contact, or a contact unrelated to the property could become the callee.

**Suggested fix.** Before anything routes on `primary_contact`: either stop
accepting it on the unit create / PATCH body (the contact list's Make primary
already sets it, and the repo keeps it consistent), or validate it on write -
the contact exists, is not a caseworker (`isCaseworker`,
`app/src/lib/caseworkers.ts`) and holds a seat on the property's contact
list - with the consistent contact read the contact-list checks use
(`app/src/services/contactTypeGuards.ts`). The voice route's own NOTE says
the M1.10 path must consult the THREAD roster, not the unit scalar
(`voice-business-number-roster`); if it does, the scalar's write path can be
removed outright. Correct the stale `unitsRepo.ts:840-841` comment either way.

**Resolution (2026-10-13, `feat/primary-contact-integrity`).** The first
suggested fix, as spec
`docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`
section 4.5 (P2b) rules it: `primary_contact` is no longer in the writable unit
field set (`app/src/lib/unitFields.ts`), so `POST /api/units` and
`PATCH /api/units/:id` refuse a body carrying it as an unknown field (400,
nothing written) - commit 02ccba0f, pinned in `app/test/unitFields.test.ts` and
`app/test/unitsApi.test.ts`. Only the roster writes set the scalar now
(`addContact`, `removeContact`, `restoreWithLandlord`, `handOffPrimaryFrom`,
and the one-time `app/scripts/assign-primary-contacts.ts` through
`assignPrimaryIfCurrent`), always to the contact-list row they flag or by
REMOVEing it, so it can no longer name a contact who holds no seat. Nothing
reads the scalar at runtime (spec 9.2): the property-contact lookup
(`app/src/lib/propertyContact.ts`) takes the live row marked primary, else the
live landlord of record. The stale comments are corrected: the `unitsRepo.ts`
`UnitContact` and `primary_contact` docblocks and the `conversationsRepo.ts`
placementId docblock no longer claim a masked call dials the scalar (commit
77aebbdf). The M1.10 masked-call path is still unbuilt; when it is, it consults
the thread roster (`voice-business-number-roster`). The refs above are the
pre-fix locations.
