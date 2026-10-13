---
id: ha-review-close-name-patch-unfenced
title: The housing-authority review's close-name edit is a plain contacts PATCH - tenant-only fields accepted for any type, unfenced on the classification the page read
type: bug
severity: low
status: open
area: app
created: 2026-10-13
refs: app/src/routes/contacts.ts:654, app/src/routes/contacts.ts:1523, app/src/routes/contacts.ts:1540, dashboard/src/routes/contact/ContactDetail.tsx:289, dashboard/src/routes/contact/ContactDetail.tsx:830, dashboard/src/routes/contact/ContactDetail.tsx:854, dashboard/src/routes/contact/ContactDetail.tsx:1284, app/src/services/audienceResolution.ts:149
---

**Problem.** "Is this really new?" (spec 2026-10-06 D8) settles a housing
authority suggestion three ways, and picking a CLOSE name (a different list
name than the one heard) is a normal contact edit: `editHousingAuthorityTo`
sends `updateContact(contactId, { housingAuthority })`
(`dashboard/src/routes/contact/ContactDetail.tsx:830-843`, reached from the
dialog's `onUse`, `:1284`). The contacts PATCH accepts `housingAuthority`
for any contact type (`app/src/routes/contacts.ts:654-659`) and applies the
classification fence only when the PATCH itself classifies - `type` or
`role` in the body (`:1523`, the guard at `:1540-1542`). So that write is
not fenced on the classification the page read, and a housing authority - a
tenant fact (spec 2026-10-12 I1) - can land on a contact that is no longer a
tenant: staff A opens the review on tenant T, staff B converts T to a
caseworker (the conversion removes the authority), A picks a close name, and
the plain PATCH writes it back onto the caseworker. That is the outcome the
accept fence (`effectiveGuard`) closes for accepts, reached by the sibling
path. Wrong data, not a misrouted send: a filter-resolved audience is
tenants only (`app/src/services/audienceResolution.ts:149`). Found by the
caseworker-integrity final review (A5,
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/final-review/adversarial.md`
finding 5).

**Client side, done (2026-10-13, fix wave FWF-4).** The page closes the
review when the loaded contact stops being typed tenant while it is open
(`ContactDetail.tsx:289`), and a non-tenant's chip skips the review
(`:854`). The window that remains is a page that has not received the change
- no re-read since it (a dropped event stream, or the change landing between
the re-read and the click) - and any caller of the API other than the
dashboard.

**Suggested fix.** Either refuse a non-null `housingAuthority` (and the
other tenant-only fields) in the contacts PATCH when the stored or resulting
type is not `tenant`, or fence the write on the classification revision the
page read (the client sends the revision it rendered, and the PATCH
conditions its write on it, as the accept fence does). Both change the
contacts-PATCH contract, so each needs a spec ruling and its own tests
before it is built.
