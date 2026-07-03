<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Landlord contact preferences — design

**Date:** 2026-07-02
**Status:** approved (built same day)

## Problem

The landlord contact file's "Preferences & notes" card promises structured
landlord preferences — its pending note reads "Accepts-programs / lease terms /
pet policy arrive with the backend" — but the three structured fields were never
modeled. Free-text `notes` now render there; the structured fields exist nowhere
on the landlord contact.

## Modeling decision: contact-level defaults vs unit-level facts

Units already carry `accepted_programs` / `pets` / `utilities`
(`app/src/lib/unitFields.ts`) — those are **per-unit facts**. The new fields are
**person-level defaults/policies**: what the landlord generally accepts across
their properties, captured on the onboarding call, often before any unit exists.

This split is already how the model treats contact vs unit data:

- The landlord contact carries person-level deal terms + approval criteria
  (`contract_status`, `expected_rent`, `registered_landlord`, `rta_within_48h`,
  `pass_inspection_first_try`, `income_includes_voucher`) — first-class optional
  fields on the flexible contact document.
- The tenant contact carries person-level intake (`pets`, `evictions`, `tenure`).
- Units carry the per-unit facts.

So the fields go on the CONTACT, following the established convention:
**first-class optional fields, NOT type-gated, validated only when supplied**
(mirrors `company` / `contract_status` handling in `app/src/routes/contacts.ts`).

## Field set

| Field | Type | Meaning |
|---|---|---|
| `accepts_programs` | `string[]` (optional) | Programs the landlord generally accepts (e.g. HCV, VASH). Person-level default; a unit's `accepted_programs` remains the per-unit fact. |
| `lease_terms` | `string` (optional) | Free-text lease-terms policy ("12-month minimum, month-to-month after"). |
| `pet_policy` | `string` (optional) | Free-text pet policy ("small dogs OK, $300 deposit"). |

### Naming rationale

- **`accepts_programs`, not `accepted_programs`:** the distinct name separates
  the person-level DEFAULT from the unit-level FACT, so future copy-down code
  (`unit.accepted_programs ?? landlord.accepts_programs`) stays unambiguous. It
  also matches the shipped card copy ("Accepts-programs").
- **`pet_policy`, not `pets`:** `ContactItem.pets` is already taken — it is the
  TENANT eligibility-intake answer ("1 cat"). The landlord policy needs its own
  key on the same entity.

### Alternatives considered

1. **Reuse `accepted_programs` on the contact** — rejected: same name for
   default-vs-fact invites conflation across the two entities.
2. **Model per-unit only (skip contact level)** — rejected: the card promise is
   landlord-level, and navigators capture the blanket policy before units exist.
3. **Structured pet policy (enums/booleans)** — rejected (YAGNI): navigators
   capture nuance; free text mirrors the unit's `pets` string and `lease_terms`.

## Validation

- `accepts_programs`: must be an array of strings (`isStringArray`, mirroring
  `unitFields.ts`). An empty array clears the field.
- `lease_terms` / `pet_policy`: must be strings. Empty string clears (same
  semantics as `company`).
- Accepted on both the generic PATCH (`parseTriageBody`) and manual create
  (`parseCreateBody`), like the other landlord fields.

## Backend changes

- `app/src/repos/contactsRepo.ts` — add the three optional fields to
  `ContactItem` beside the landlord deal-terms block (flexible document, no
  schema change).
- `app/src/routes/contacts.ts` — validate + allowlist in `parseTriageBody` and
  the create parser, following the `company` / `contract_status` pattern.
- Tests: extend `app/test/landlordContactFields.test.ts` — PATCH persists +
  GET returns; rejects non-array / non-string-element / non-string values;
  POST create accepts them.

## Dashboard changes

- `dashboard/src/api/types.ts` — mirror the fields on `Contact`,
  `ContactPatch`, and `ContactCreate`.
- `dashboard/src/routes/contact/ContactEditForm.tsx` — landlord-only
  "Preferences" fieldset: "Accepted vouchers / programs" as a comma-separated
  text input (the exact `ListingEditForm` pattern — normalize trim/drop-empties,
  send only when the normalized array changed), plus "Lease terms" and
  "Pet policy" text inputs. Dirty-tracked: only changed fields ride the PATCH.
- `dashboard/src/routes/contact/LandlordFile.tsx` — "Preferences & notes" card
  renders, in order: `Chips` for `accepts_programs`, KV rows for "Lease terms"
  and "Pet policy", then `NotesText` for the free-text notes. Each piece renders
  only when present; the pending panel shows ONLY when all four are empty, and
  its copy no longer claims the backend is missing.
- Tests: `ContactEditForm.test.tsx` — dirty-tracking (changed fields sent,
  untouched omitted, programs normalization); new `LandlordFile.test.tsx` —
  card shows chips/KV/notes when present, pending panel only when all empty.

## Out of scope

- Copy-down of landlord defaults into new units (future; the naming keeps it easy).
- Any GSI/index or reporting on these fields.
- Gleaning preferences from message history.
