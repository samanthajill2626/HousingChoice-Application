---
id: ha-review-close-name-patch-unfenced
title: The housing-authority review's close-name edit is a plain contacts PATCH - tenant-only fields accepted for any type, unfenced on the classification the page read
type: bug
severity: low
status: open
area: app
created: 2026-10-13
refs: app/src/routes/contacts.ts:654, app/src/routes/contacts.ts:1523, app/src/routes/contacts.ts:1540, dashboard/src/routes/contact/ContactDetail.tsx:295, dashboard/src/routes/contact/ContactDetail.tsx:836, dashboard/src/routes/contact/ContactDetail.tsx:860, dashboard/src/routes/contact/ContactDetail.tsx:1290, app/src/services/audienceResolution.ts:149, dashboard/src/routes/contact/useContact.ts:60, app/src/routes/contacts.ts:1851, app/src/services/caseworkerConversion.ts:372
---

**Problem.** "Is this really new?" (spec 2026-10-06 D8) settles a housing
authority suggestion three ways, and picking a CLOSE name (a different list
name than the one heard) is a normal contact edit: `editHousingAuthorityTo`
sends `updateContact(contactId, { housingAuthority })`
(`dashboard/src/routes/contact/ContactDetail.tsx:836-849`, reached from the
dialog's `onUse`, `:1290`). The contacts PATCH accepts `housingAuthority`
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
(`ContactDetail.tsx:295`), and a non-tenant's chip skips the review
(`:860`). The window that remains is a page that has not received the change
- no re-read since it (a dropped event stream, or the change landing between
the re-read and the click) - and any caller of the API other than the
dashboard.

**The plain re-type case (2026-10-13; final review round 2 R2-2, FWF
re-review F2).** That window is wider than a dropped stream: it is every
generic re-type made after the page loaded. The page re-reads a contact
changed by someone else only through `useContact`'s `suggestion.updated`
listener (`dashboard/src/routes/contact/useContact.ts:60-71`). The caseworker
conversion emits that event (it supersedes the pending suggestions,
`app/src/services/caseworkerConversion.ts:358-372`), so a conversion closes
the review. A generic contacts PATCH that re-types the tenant (for example
to landlord, from the edit form or the Unknown card) emits it only when it
superseded a pending suggestion for a field in the PATCH or drained a pending
`type` suggestion (`app/src/routes/contacts.ts:1818-1853`; `type` itself is
never snapshotted, `:1757`) - a pending housing-authority chip is neither. So
after such a re-type the review stays open on the stale page (which can also
re-open it from the chip, `ContactDetail.tsx:860`), and its close-name pick
still sends the plain PATCH, writing the authority onto the landlord. Wrong
data, as above. The client close was not extended (round 2 ruled a comment,
`ContactDetail.tsx:280-295`, and this note); the server-side fence below
closes this case fully.

**Suggested fix.** Either refuse a non-null `housingAuthority` (and the
other tenant-only fields) in the contacts PATCH when the stored or resulting
type is not `tenant`, or fence the write on the classification revision the
page read (the client sends the revision it rendered, and the PATCH
conditions its write on it, as the accept fence does). Both change the
contacts-PATCH contract, so each needs a spec ruling and its own tests
before it is built.
