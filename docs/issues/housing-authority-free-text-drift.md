---
id: housing-authority-free-text-drift
title: Housing authority is unvalidated free text stored under two names (contact.housingAuthority vs unit.jurisdiction)
type: debt
severity: med
status: open
area: app
created: 2026-08-06
refs: app/src/repos/contactsRepo.ts, app/src/repos/unitsRepo.ts, dashboard/src/routes/contact/ContactEditForm.tsx, dashboard/src/routes/broadcasts/AudienceFilters.tsx, dashboard/src/routes/listings/ListingsList.tsx
---

**Problem.** One real-world entity - the housing authority / jurisdiction that administers a
voucher or covers a property - is stored under two different field names, and neither value is
validated:

- `contact.housingAuthority` (camelCase) - the `byHousingAuthority` GSI hash, tenant-sparse.
- `unit.jurisdiction` - the `byJurisdiction` GSI hash. Documented as "the primary HCV
  jurisdiction string (free text, no geocoding)".

Both are set by a bare text input. `ContactEditForm` renders a plain `<input>` with placeholder
`e.g. atlanta_housing`; nothing enforces the slug convention the seeds actually use
(`atlanta_housing`, `dekalb_housing`, `fulton_housing`, `ga_dca`).

Four consequences, in rough order of how much they cost:

1. **Broadcast targeting silently under-reaches.** Audience resolution queries
   `byHousingAuthority` with an exact hash match, and `AudienceFilters` takes the authority as
   free text. A tenant whose authority is spelled any other way is simply absent from the
   audience, and nothing reports that anyone was skipped. This is the failure mode with real
   consequences for a person - they do not get told about a property.
2. **Facet fragmentation.** Any list deriving filter options from distinct values - the
   Properties list today, the Tenants list as of the tenant-list-visibility work - renders
   "Atlanta Housing" and `atlanta_housing` as two separate authorities. Every typo becomes a
   permanent phantom facet that never goes away on its own.
3. **Tenant-to-property cross-referencing is impossible.** Matching a tenant against properties
   in their own jurisdiction requires the two fields to agree on a vocabulary. Nothing makes
   them agree - not even the field name.
4. **Import populates only the unit side.** The review workbook has a `housing_authority` column
   for UNITS (`apply.ts` writes it to `jurisdiction`) and no equivalent for contacts, so
   imported tenants arrive with no authority at all.

**Suggested fix.** A decision first, then a small build:

- **Decide the canonical vocabulary:** a shared list of authority slugs plus display labels - a
  constant, or org settings if it needs to be founder-editable. `humanizeAuthority()` is being
  lifted out of `ListingsList` into a shared module for the tenant-list work, which is the
  natural home for the list too.
- **Make both edit surfaces a combobox** over that list. Free-text entry can stay, but as an
  explicit "add a new authority" rather than a silent typo.
- **Then decide** whether to rename one field so the two agree, or keep both names and record the
  mapping in `documentation/GLOSSARY.md`. A rename touches two GSI key attributes and needs a
  backfill, so it is not free - and per GLOSSARY discipline, if they stay split the split needs
  to be written down as intentional.
- **Normalize existing values** as part of whichever rename lands.

**Explicit non-goal.** The tenant-list visibility work does NOT fix this. It derives its filter
options from whatever is already in the data, so it inherits the fragmentation above rather than
introducing or correcting it.

**Adjacent open question.** `voucher_program` has the same half-existing quality: the seeds write
`voucher_program: 'HCV'` on every cast tenant, but it is absent from the `Contact` type, the edit
form, the tenant file, and the import, so nothing ever reads it. The Airtable source does carry a
real `voucherProgram` column ("Georgia Housing Voucher, GHV", "HUD VASH", "Claratel",
"Hope Atlanta") that the import currently surfaces as read-only evidence and then drops. Whether
program is a second dimension alongside authority is a question outstanding with the founder.
