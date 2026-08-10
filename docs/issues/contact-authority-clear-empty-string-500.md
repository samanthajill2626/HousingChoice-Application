---
id: contact-authority-clear-empty-string-500
title: Clearing a tenant's housing authority writes an empty string to a GSI hash key and fails
type: bug
severity: med
status: open
area: app
created: 2026-08-10
refs: dashboard/src/routes/contact/ContactEditForm.tsx:323,app/src/routes/contacts.ts:520,app/src/repos/contactsRepo.ts:906
---

**Problem.** `contact.housingAuthority` is the hash key of the `byHousingAuthority` GSI, and
DynamoDB rejects an empty string for an indexed key attribute. The contact edit form sends the
emptied field as `''` (a string, not `null`), the PATCH parser accepts any string
(`app/src/routes/contacts.ts:520-525`), and the repo's update builder SETs it - so clearing a
tenant's housing authority attempts to write `housingAuthority = ''` and the request fails.

This violates the repo's OWN documented convention, which the update builder states in a comment
at `app/src/repos/contactsRepo.ts:906-908`: "SET non-null fields; REMOVE explicit-null fields
(the null -> REMOVE convention lets callers clear an attribute, e.g. `role: null` removes the
role attribute entirely rather than storing '')". The clear path simply never routes through it
for this field. `app/src/lib/unitFields.ts`'s `tour_type` case shows the intended shape on the
unit side: `''` or `null` is normalized to a `null` patch value so the repo REMOVEs the attribute.

**PRE-EXISTING and NOT widened by the tenant-list-visibility feature**, verified twice:

- `trimJsonBody()` (`app/src/app.ts:100`, referenced by name at `app/src/routes/contacts.ts:407`)
  deep-trims every string value in every inbound JSON body, so a whitespace-only entry already
  arrived as `''` before that feature existed.
- The feature's new `collapseOrgInput` sends `''` for an emptied field, which is byte-identical to
  what the previous raw comparison sent.

An adversarial reviewer contested this on the basis that no trim exists on the field; that is
mistaken - the trim is global middleware, not field-specific. What the feature DOES change is how
often the path is reached: the housing authority is now visible on every tenant row and filterable
by a facet, so it will be edited - and cleared - far more than before.

**Suggested fix.** Normalize an empty authority to a `null` patch value in the PATCH parser so the
repo's existing null -> REMOVE branch clears the attribute, mirroring `unitFields.ts`'s
`tour_type` CLEAR-to-absent case. Note that `housingAuthority` is in `PROVENANCE_FIELDS`, so the
clear must still count as a real change and consume provenance normally. A route test should pin:
PATCH `{ housingAuthority: '' }` on a contact that has one returns 2xx, and a follow-up GET shows
the attribute ABSENT rather than empty. The fake repo in `app/test/helpers/twilioWebhookHarness.ts`
does not model the GSI key constraint, so a unit test alone cannot reproduce the failure - the
integration layer is where it must be proven.

Found by the adversarial reviewer (finding F4) during the tenant-list-visibility mission and
confirmed against the repo's update builder by the orchestrator.
