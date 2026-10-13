---
id: contact-retype-skips-caseworker-refusals
title: The generic contact type change has none of the caseworker conversion's refusals (open placement, open tour, landlord of record, roster seat)
type: decision
severity: low
status: resolved
resolved: 2026-10-12
area: app/contacts
created: 2026-10-08
refs: app/src/routes/contacts.ts, app/src/services/caseworkerConversion.ts, dashboard/src/routes/contact/ContactEditForm.tsx, dashboard/src/routes/contact/UnknownFile.tsx
---

**Problem.** The caseworker conversion (`feat/caseworkers`, spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
D19) refuses a contact with an open placement, an open tour as the tenant, a
property it is the landlord of record for, or a seat on a property's contact
list. The generic type change - the edit form's kind change and the Unknown
card's Mark as Tenant / Landlord / Property Manager / Partner, all through
the contacts PATCH `type` - has none of these checks: a tenant with an open
placement or a scheduled tour can be re-typed to Landlord or Partner today,
and a landlord of record can be re-typed to Tenant. Branch B kept that path
unchanged on purpose (D16, D21): it guards only the conversion, and it kept
the generic path's thread rule (only `unknown_1to1` threads flip), so tour
reminders and placement nudges still find a mistakenly re-typed tenant's
`tenant_1to1` thread. Pre-existing.

**Suggested fix.** Decide (Sam and Cameron) whether a type change AWAY from
tenant or landlord should run the conversion's refusal reads (the four
checks in `app/src/services/caseworkerConversion.ts`) and refuse, or only
warn in the edit form, or stay as it is. Related:
`tours-placements-no-contact-type-check` (the other direction: a tour or
placement created for a non-tenant).

**Resolution (2026-10-12).** Decided and fixed on `fix/caseworker-integrity`
(spec `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D2;
Cameron, 2026-10-12): the generic type change REFUSES, it does not warn. A
contacts PATCH that changes `type` answers 409
`{ error: 'type_change_refused', refusals }` when the new type is not
`tenant` and the contact is the tenant of an open placement (`open_placement`)
or an open tour (`open_tour`), or when the new type is not `landlord` and the
contact is the landlord of record of a LIVE property (`landlord_of_record`; a
soft-deleted property is fenced at restore instead). A contact-list seat never
refuses a type change, a role-only change is not checked, and 409
`caseworker_use_conversion` still answers first. The reads are the
conversion's own, extracted to `app/src/services/contactHoldings.ts`; the
conversion's behavior, codes, order and copy are unchanged. The edit form
keeps the draft and shows each refusal's sentence and View link beside the
kind picker - the conversion's sentences for a placement or a tour; for a
landlord of record, "This contact is the landlord of record for a property,
so they must stay a landlord. Changing a property's landlord isn't available
in the dashboard yet." (no dashboard path reassigns a property's landlord:
filed `landlord-of-record-no-reassign-ui`). The Unknown card's Mark as ...
buttons no longer swallow failures: a refusal shows the same sentences on the
card. The checks read before they write (spec L1; RUNBOOK "The contact-type
checks are reads, not locks"), and existing records were not swept (L2). The
importer's re-type is outside this fence: filed
`import-bypasses-contact-type-rules`.
