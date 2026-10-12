---
id: landlord-of-record-no-reassign-ui
title: No dashboard path changes a property's landlord of record after it is created
type: improvement
severity: low
status: open
area: dashboard/listing
created: 2026-10-12
refs: app/src/lib/unitFields.ts:46, app/src/routes/units.ts, app/src/repos/unitsRepo.ts, dashboard/src/routes/listing/ListingDetail.tsx, dashboard/src/routes/listing/UnitCreateForm.tsx, dashboard/src/lib/holdingRefusals.ts
---

**Problem.** A property's landlord of record (`landlordId`) is picked on New
property (`dashboard/src/routes/listing/UnitCreateForm.tsx`), and no
dashboard screen changes it on a live property afterwards. The API can:
`landlordId` is writable on `PATCH /api/units/:id`
(`app/src/lib/unitFields.ts:46`, `app/src/routes/units.ts`). That API-only
PATCH changes the landlord of record without the contact-list row swap - the
old owner keeps a "Landlord" row, often the primary one, and the new owner
gets none (`app/src/routes/units.ts` PATCH -> `unitsRepo.update`) - so the
future "Change landlord of record" action should reuse
`restoreWithLandlord`'s single conditional write (or a row-swap helper
extracted from it), not the bare PATCH. The property page's Contacts card can
only FILL an empty slot - adding a contact with the Landlord role claims it on
an ownerless property (`addContact`, `app/src/repos/unitsRepo.ts`) - and with
an owner in place it answers "This property already has a landlord of record
- reassign it before choosing Landlord." with nothing in the dashboard to
reassign it with. Since `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D2) this
matters more: a contact who is the landlord of record of a live property
cannot be re-typed (409 `type_change_refused`, refusal `landlord_of_record`),
and the edit form has to say "Changing a property's landlord isn't available
in the dashboard yet." (`dashboard/src/lib/holdingRefusals.ts`) - a dead end
for staff correcting a mistyped landlord or handing a property to a new owner.
Restoring a deleted property whose landlord is no longer a landlord does offer
a landlord picker (spec section 4, Restore); a live property has none.

**Suggested fix.** A "Change landlord of record" action on the property page
(the Contacts card or the property kebab): a picker of contacts typed
`landlord` (the New property picker's source), then ONE conditional write, as
`restoreWithLandlord` does - the new `landlordId` (refused for a contact not
typed `landlord`, as the PATCH has been since `fix/caseworker-integrity`), the
old owner's contact-list row demoted or removed and the new owner's row added
with role `landlord`, the primary contact kept consistent - and an audit entry
naming both. Then the edit form's landlord-of-record refusal can drop "isn't
available in the dashboard yet" and link straight to that action.
