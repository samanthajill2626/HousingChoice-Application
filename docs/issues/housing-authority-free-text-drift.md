---
id: housing-authority-free-text-drift
title: Housing authority has two vocabularies (human-readable vs seed slugs) and two field names (contact.housingAuthority vs unit.jurisdiction)
type: debt
severity: med
status: open
area: app
created: 2026-08-06
refs: app/src/services/extraction/schema.ts, app/src/lib/import/airtableSource.ts, dashboard/src/routes/listings/ListingsList.tsx, dashboard/src/routes/listing/listingFormat.ts, app/src/repos/contactsRepo.ts, app/src/repos/unitsRepo.ts
---

**Problem.** One real-world entity - the housing authority administering a voucher or covering a
property - is stored under two field names, in two different vocabularies, with no validation on
either.

**Two names.** `contact.housingAuthority` (the `byHousingAuthority` GSI hash) and
`unit.jurisdiction` (the `byJurisdiction` GSI hash). Nothing makes them agree, so matching a tenant
to properties in their own jurisdiction is not possible today.

**Two vocabularies, and the human-readable one is correct.** This is the part that is easy to get
backwards:

- **Human-readable is what every real data source uses.** The founder's Airtable "Voucher Type"
  column IS the housing authority - `airtableSource.ts:41` documents the values in a comment:
  `"Atlanta Housing"`, `"Dekalb Housing"`, `"Jonesboro Housing"`. The import feeds it into the
  workbook's unit-side `housing_authority` column (`workbook.ts:291`).
- **The AI extraction vocabulary is also human-readable and curated**:
  `HOUSING_AUTHORITY_VOCAB` (`app/src/services/extraction/schema.ts:45-58`) holds
  `'Jonesboro (JHA)'`, `'Fulton County'`, `'Atlanta (AHA)'`, `'Clayton County'`, `'College Park'`,
  `'Georgia Housing Voucher (GHV)'`, `'Step Up'`, `'Claratel'`, `'Hope Atlanta'`, `'HUD VASH'`,
  `'DCA'`, `'McDonough'`, `'East Point'`. `extraction/apply.ts:97-102` validates against it and
  stores verbatim; extraction is on by default outside production (`config.ts:775`). That file's
  own comment calls these "EXACT strings as stored in our data" - which is false against every
  seed.
- **Slugs are dev-fixture residue, never a product decision.** `atlanta_housing` first appears in
  commit `01371194` ("M0.3: local dev environment"), whose payload is `app/scripts/db-seed.ts`.
  From there they leaked into two input placeholders (`ContactEditForm.tsx:486`,
  `UnitCreateForm.tsx:301` / `ListingEditForm.tsx:223`, all `e.g. atlanta_housing` / `e.g. ga_dca`)
  and into `humanizeAuthority` (`ListingsList.tsx:36-42`), a helper whose entire job is converting
  slugs back into the readable names they should have been.
- **The unit side proves the original intent.** `listingFormat.ts:53` joins `unit.jurisdiction`
  into an ADDRESS/AREA line ("123 Main St, Atlanta"), which only reads correctly with a place name;
  a slug renders "123 Main St, atlanta_housing". Even the tests are split -
  `ListingDetail.test.tsx:86` and `listingFormat.test.ts:70` use `'Atlanta'`, while
  `ListingsList.test.tsx` uses `'atlanta_housing'`.

**Consequences, worst first.**

1. **Broadcast targeting silently under-reaches.** Audience resolution queries
   `byHousingAuthority` with an exact hash match and `AudienceFilters` takes the authority as free
   text. A tenant whose authority is spelled any other way is absent from the audience with no
   report that anyone was skipped - a person does not get told about a property.
2. **`humanizeAuthority` corrupts free text.** It uppercases any token of 3 characters or fewer,
   which is right for slugs and wrong for names: `'Step Up'` renders `'Step UP'`, and a typed
   `'Housing Authority of the City of Atlanta'` renders `'Housing Authority OF THE City OF
   Atlanta'`. Any surface that humanizes a non-slug value invents a string.
3. **Facet fragmentation.** Lists deriving filter options from distinct values render each spelling
   as its own authority with the counts split between them.
4. **Import populates only the unit side.** ~~`import/apply.ts` writes `jurisdiction` for units and
   no contact-side authority at all, so imported tenants arrive with none.~~
   **ADDRESSED 2026-08-06** (`import-display-name-unread` resolution): `apply.ts`
   now writes `contact.housingAuthority`, mapped onto the EXACT
   `HOUSING_AUTHORITY_VOCAB` strings via `housingAuthorityFor`, with unmapped
   values reported and left unset rather than guessed into the GSI. The import
   spec had justified the omission by calling her values "programs, not
   authorities" - wrong, since GHV, HUD VASH, Claratel and Hope Atlanta are all
   in that vocabulary verbatim.

   THIS ISSUE STAYS OPEN: the import now writes the human-readable vocabulary on
   BOTH sides, but that does not resolve the two field names
   (`contact.housingAuthority` vs `unit.jurisdiction`), the slug-vs-readable split
   in seeds and placeholders, or `humanizeAuthority` corrupting free text
   (consequences 1-3). Real coverage is also thin for a founder-data reason
   rather than a code one: only 17 of 629 imported contacts carry any authority
   value.

**Suggested fix.** Treat human-readable as canonical and normalize toward it:

- Adopt `HOUSING_AUTHORITY_VOCAB` as the shared suggestion list for BOTH entry points (the tenant
  list work does this for the contact form only - see below).
- Change the three input placeholders from slug examples to real names.
- Normalize seed fixtures to human-readable values, then delete `humanizeAuthority` and its
  callers - once no stored value is slug-shaped, the helper has no job.
- Backfill existing slug-shaped rows in dev.
- Decide whether to rename one field so the two agree, or keep both names and record the split as
  intentional in `documentation/GLOSSARY.md`. A rename touches two GSI key attributes and needs a
  backfill, so it is not free.

**Partially addressed by the tenant-list visibility work**
(`docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md`), which does two things and
deliberately not the rest: it makes the CONTACT edit form a suggestion-backed input over the
extraction vocabulary (aligning the only human writer with the only machine writer), and it demotes
`humanizeAuthority` to a legacy fallback applied only to slug-shaped values, so free text is never
mangled. Everything above - the unit-side inputs, the seeds, deleting the helper, the backfill, and
the field-name decision - remains open here.

**Adjacent open question.** `voucher_program` half-exists: seeds write `voucher_program: 'HCV'` on
every cast tenant, but it is absent from the `Contact` type, the edit form, the tenant file, and
the import, so nothing reads it. The Airtable source carries a real `voucherProgram` column
("Georgia Housing Voucher, GHV", "HUD VASH", "Claratel", "Hope Atlanta") that the import surfaces
as read-only evidence and then drops. Note the extraction vocabulary above already mixes PHAs and
program sponsors into one field, which is evidence the distinction has never been drawn. Whether
program is a second dimension is outstanding with the founder.

---

**Founder clarification (email via Cameron, 2026-08-09).** The taxonomy is now
authoritative, from the person who runs the book:

- **Housing authorities**: Atlanta (AHA), Jonesboro (JHA), DeKalb, Fulton,
  Clayton, East Point, McDonough - and **DCA**, "a unique one for Georgia which
  is a 'housing authority' that governs 120+ counties/larger area of Georgia."
- **Agencies / non-profits** (NOT authorities): Hope Atlanta, HUD VASH, Claratel,
  Step Up.
- **They coexist**: "Someone can be HUD VASH (veteran org) AND AHA. But someone
  can also be just AHA. Then someone could be HUD VASH AND DCA."

So the single `housingAuthority` field genuinely cannot represent her world - a
person can hold one from EACH column. The AI-extraction vocabulary
(`HOUSING_AUTHORITY_VOCAB`) mixes both kinds in one list, and is also missing
**DeKalb** entirely - 19 tenants in the full Airtable export carry
"Dekalb County Housing" and the extractor could never emit it.

**Import posture (2026-08-09, Cameron):** free field. The importer normalizes
known variant spellings to one canonical form each (consistency is what the
exact-match byHousingAuthority GSI actually needs) and passes unknown values
through verbatim with a once-per-value warning. The two-field/two-kind modelling
decision stays open here.
