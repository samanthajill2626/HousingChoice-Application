---
id: landlord-onboarding-record-fields
title: Landlord record has no fields for onboarding-call deal terms, approval criteria, or contract-signed
type: decision
severity: high
status: open
area: app
created: 2026-06-30
refs: app/src/routes/contacts.ts, app/src/lib/contactProfile.ts, app/src/repos/contactsRepo.ts, dashboard/src/routes/contact/LandlordFile.tsx, documentation/landlord-onboarding-sequence.mermaid
---

**Problem.** The Landlord & Unit Onboarding sequence has the Team capture a checklist of deal
terms + approval criteria on the ~10-min onboarding call, and record whether the DocuSign
contract was signed. **None of these have a home on the landlord contact today** — there is no
API/UI to set them, and they are not in the create/PATCH validation allowlist.

**Missing fields (diagram → app).** Deal terms: **expected rent**, **utilities on tenant**,
**hold fee**, **deposit**, **LIF** (as a landlord deal term), **tour logistics**, **comms
prefs** (text / group-text), **registered-landlord** (bool), **will-submit-RTA-within-48h**
(bool), **will-pass-inspection-first-try** (bool). Approval criteria: how they treat
**evictions**, **utility debt**, **credit**, **references**, and **income rules** (the voucher
counts as income). Plus **contract-signed** status.

**Evidence (2026-06-30, code + live `--mock --local`).**
- A landlord contact today supports only: identity, phone(s), `company`, `address`, `role`,
  `relationships`, `notes` (free-form), `customFields` (`{label,value}[]`), status
  (`needs_review|active`). The eligibility fields (`pets`/`evictions`/`tenure`/`lifEligible`/
  `voucherSize`/`housingAuthority`) are tenant-centric (`app/src/routes/contacts.ts` PATCH
  allowlist; `contactProfile.ts`).
- The seed's landlord (`contact-landlord-0001`) carries ad-hoc `lead_status:'registered'`,
  `contract_status:'signed'`, `authorities_served:[...]` — but these are **document-only** seed
  fields: `PATCH /api/contacts/:id { contract_status, lead_status }` → `400 "no updatable
  fields supplied"`. So they exist in stored data but there is **no API path to set them** and
  no UI to show/edit them (`LandlordFile.tsx` "Preferences & notes" is a pending placeholder).

**Decision needed (before building).** How to model these — this is the product/data-model
call the tenant intake precedent doesn't settle:
1. **Structured first-class fields** (like tenant intake `pets/evictions/tenure/lifEligible`):
   schema + validation + edit-form UI + a "Landlord terms" / "Approval criteria" card. Highest
   fidelity + queryable, but ~15 new fields is a large schema commitment.
2. **Free-form `notes` + `customFields`** (already available on the contact): zero schema, ship
   immediately, but not structured/queryable and the "approval criteria feed matching later"
   goal weakens.
3. **Hybrid:** structure the few fields that drive later logic (e.g. contract-signed, expected
   rent, registered-landlord, income rules) and leave the softer ones in notes/customFields.

Also: **contract-signed** — a first-class boolean/enum (`contract_status`) the Team sets, or a
customField? (The diagram asserts recording it, not a DocuSign integration — see
[[email-as-first-class-channel]] for why email/DocuSign stay external.)

**Not a blocker for the e2e suite's SHAPE** — the scenarios can drive whatever surface we choose;
this issue is the schema decision they'll assert against. Related: [[landlord-lead-status-and-park]].
