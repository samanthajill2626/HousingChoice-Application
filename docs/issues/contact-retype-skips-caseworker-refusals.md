---
id: contact-retype-skips-caseworker-refusals
title: The generic contact type change has none of the caseworker conversion's refusals (open placement, open tour, landlord of record, roster seat)
type: decision
severity: low
status: open
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
