---
id: reimport-reverts-unknown-triage
title: A re-import reverts staff triage of imported unknown contacts
type: bug
severity: low
status: open
area: app/import
created: 2026-10-07
refs: app/src/lib/import/apply.ts
---

**Problem.** The importer SETs `type` on every run for every contact it imports
(`upsertContact` in `app/src/lib/import/apply.ts`), and re-writes `status` while the
stored status is still the import's own (`status_source` is the import's). So when staff
triage an imported `unknown` contact in the app (Mark as Tenant, Landlord or Partner), the
next import run puts the importer's type back - and the importer's status too, when the
triage left the import-owned status in place. Branch B of the clean-org-names design
(`feat/caseworkers`, spec D21) protects only contacts whose type staff OVERRODE: it stamps
`type_source: 'manual'` on a type change between tenant, landlord and partner, and the
importer then leaves type, status, housing authority and agency alone. Triage of an
`unknown` contact is deliberately NOT stamped, so it stays unprotected. Pre-existing;
whether another import will run against production is unknown.

**Suggested fix.** Before the next production import, decide whether triage should
stamp `type_source: 'manual'` too, or whether the importer should change the type only of
a contact still typed `unknown`. Either way the import report should count the contacts
whose type or status it changed.
