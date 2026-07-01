---
id: landlord-lead-status-and-park
title: No landlord lead-status (interested/declined) or "parked" terminal + decline reason
type: decision
severity: high
status: open
area: app
created: 2026-06-30
refs: app/src/lib/statusModel.ts, app/src/routes/contacts.ts:117, app/src/routes/statusTransition.ts:189, documentation/landlord-onboarding-sequence.mermaid
---

**Problem.** The landlord-onboarding sequence marks a lead **interested** (both first-touch
paths converge on it) and, on every negative terminal (declines / not-a-fit / never-signs),
**logs a reason and PARKS the lead**. The current model has no home for either: landlords have
no lead-status concept, no parked/declined terminal, and no reason storage.

**Evidence (2026-06-30, code + live).**
- Non-tenant contacts (landlord/team_member/unknown) share a **two-value** lifecycle:
  `NON_TENANT_STATUSES = ['needs_review','active']` (`app/src/routes/contacts.ts:117`). There is
  **no `LANDLORD_STATUSES`** enum and no landlord override/terminal states
  (`statusModel.ts` — `on_hold`/`inactive` are TENANT-only; there is no `LANDLORD_OVERRIDE_STATES`).
- No structured **reason** is stored on a contact for a status change. The generic `reason?` on
  `PATCH /api/contacts/:id/tenant-status` is audit-logged only, not persisted on the contact.
  (Tenants have `lost_reason`, but only on the placement `lost` stage.)
- `lead_status`/`contract_status` exist as **ad-hoc seed document fields** with no validation,
  no setter, no UI (see [[landlord-onboarding-record-fields]]).
- **Inconsistency found:** `PATCH /api/contacts/:landlordId/tenant-status { toStatus:'on_hold' }`
  and `'inactive'` return **200** on a landlord — the `/tenant-status` route only checks
  `isTenantStatus(...)` and does NOT apply the type-scoped allowlist the generic contact PATCH
  does (`contacts.ts` status branch). So a landlord can be pushed into tenant-only states today.
  That is a leak, not a feature — do not build "park" on top of it.

**Decision needed (before building).**
1. **Model "interested" and "parked/declined":** a dedicated `lead_status` field
   (`interested | declined | parked | ...`) on the landlord contact, OR new landlord contact
   statuses (extend the non-tenant lifecycle with e.g. `parked`/`declined`), OR reuse a generic
   `on_hold`-style override for non-tenants. The seed's `lead_status` hints at the field approach.
2. **Where the decline/park REASON lives:** a first-class `park_reason`/`status_reason` on the
   contact, vs a customField/note. The diagram asserts the reason is *logged*.
3. **Close the `/tenant-status` type-guard leak** so landlord status transitions are validated
   against a landlord allowlist (part of whichever model we choose).

**e2e impact.** `expectLeadParked` / the "mark interested" verb assert against whatever we pick.
Related: [[landlord-onboarding-record-fields]].
