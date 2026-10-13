---
id: import-bypasses-contact-type-rules
title: The importer's re-type and landlordId writes skip the contact-type rules, and its re-type does not bump classification_revision
type: debt
severity: low
status: open
area: app/import
created: 2026-10-12
updated: 2026-10-13
refs: app/src/lib/import/apply.ts:883, app/src/lib/import/apply.ts:1065, app/src/lib/import/apply.ts:1110, app/src/lib/import/apply.ts:1137, app/src/lib/import/apply.ts:1519, app/src/lib/import/apply.ts:1552, app/src/repos/contactsRepo.ts:1501, app/src/repos/unitsRepo.ts:1331, app/src/jobs/placementNudges.ts:443, app/src/services/contactHoldings.ts
---

**Problem.** `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, section 1)
made the app keep four rules: a tenant-only AI suggestion commits only onto a
contact typed `tenant` whose classification did not change since the accept
read it (I1); the tenant of an open tour or placement is typed `tenant` (I2);
a live property's `landlordId` names a contact typed `landlord` (I3); and no
new contact-list seat goes to a caseworker (I4). The importer
(`import:apply`, `app/src/lib/import/apply.ts`) writes contacts and
properties directly and applies none of them:

- its contact upsert re-types a contact from the reviewed workbook (the type
  is resolved at `apply.ts:883-893` and written at `:1110`) without the
  contacts PATCH's refusals, so a tenant with an open tour or placement can be
  re-typed and a landlord of record can stop being a landlord (I2, I3);
- that re-type never bumps `classification_revision` - the attribute the
  contacts PATCH and the caseworker conversion bump in the same write as a
  type or role change (`app/src/repos/contactsRepo.ts:1501`) - so a staff
  accept of a tenant-only suggestion claimed before an import re-typed the
  contact is not fenced by I1 and can still commit tenant facts onto the
  re-typed contact;
- it writes `voucherSize` and overwrites `notes` on every run with no
  `type_source: 'manual'` gate, converted caseworkers included
  (`apply.ts:1137-1144`); the stamp, read at `:1073`, gates only type,
  status, housing authority and agency (`:1110`, `:1088`, `:1150`, `:1156`);
- its property upsert sets `landlordId` (`apply.ts:1519`) from the merge
  plan's SUGGESTED type, not the reviewed type the contact upsert wrote, and
  never reads the contact's stored type (I3).

A contact whose `type_source` is `manual` (a staff re-type, every caseworker
conversion) keeps its type, status, housing authority and agency
(`apply.ts:1065-1073`), which covers converted caseworkers for those four
fields (not `voucherSize` or `notes`, above); it does not cover a contact
staff created directly as a caseworker, or any other typed contact. Out of
scope for `fix/caseworker-integrity` by decision (spec section 10). Related:
`reimport-reverts-unknown-triage` (the same importer `#type` write,
`apply.ts:1110`).

**Suggested fix.** Before the import writes a contact's type, run the same
holdings reads the contacts PATCH uses (`typeChangeRefusals`,
`app/src/services/contactHoldings.ts`) and skip-and-report a refused re-type
in the run's summary instead of writing it; write a re-type with
`classification_revision` bumped in the same update; and set a property's
`landlordId` only when the matched contact's resolved type is `landlord`.
Rehearse the dry run on a copy of production data first: the importer is the
one writer that touches every record at once.

**First to fix before the next `import:apply` run (2026-10-13; final review
A1, rated MEDIUM by the plan-blind adversarial reviewer:
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/final-review/adversarial.md`
finding 1).** Re-running the importer puts back a landlord that "Restore
without a landlord" removed. `fix/caseworker-integrity` makes a live property
with no landlord of record a deliberate state: `restoreWithLandlord` with
`next: null` REMOVEs `landlordId` (`app/src/repos/unitsRepo.ts:1331`). The
importer's property upsert matches the landlord by the import plan's
`suggestedType === 'landlord'` and the name (`app/src/lib/import/apply.ts:1512-1520`),
never by the contact's stored type, and a unit that carries `updated_at` - a
restored unit always does - fails the first write's
`attribute_not_exists(updated_at)` (`:1542`) and takes the human-owned branch
(`:1548-1554`), which writes `landlordId = if_not_exists(landlordId, :landlordId)`.
Scenario: L is the imported landlord of property U. Staff soft-delete U,
re-type L to tenant (stamped `type_source: manual`, which the importer
keeps), and restore U with "Restore without a landlord". The next import run
finds no `landlordId` on U and writes L back: U is live with a landlord of
record typed tenant - exactly the state I3 and the restore fence exist to
prevent - and the contact list is not updated (L has no row; auto-primary and
the sole-landlord promotion never run). Placement nudges route landlord rungs
to `unit.landlordId` (`app/src/jobs/placementNudges.ts:436-443`), so L, now a
tenant, starts getting landlord nudges for U. The reviewer's two fix options:
(1) drop `landlordId` from the human-owned branch's `if_not_exists` facts
entirely - a property a human has touched never gets its owner from the
import; or (2), if that is too strong, write it only when the matched
contact's STORED type is `landlord`, read consistently before the write.
