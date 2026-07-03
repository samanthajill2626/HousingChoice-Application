---
id: excluded-field-edits-unsurfaced
title: Routine field edits are intentionally NOT surfaced on activity timelines (decision)
type: decision
severity: low
status: wontfix
area: app/observability
created: 2026-07-03
refs: app/src/routes/contactTimeline.ts, app/src/routes/units.ts
---

**Decision (human, 2026-07-03).** During the activity-coverage work, we deliberately
chose which state changes surface on the contact/property/landlord activity timelines
and which do NOT. Recording the exclusions here so a future reader knows they are a
choice, not an oversight.

**NOT surfaced on any activity timeline** (they remain in the `audit_events` trail as
provenance, readable via `listByEntity`, just not projected to a timeline):

- Tenant / landlord **name, voucher, and other contact field edits**, plus contact
  **delete / restore**. (`contact_updated` audit rows stay in the audit; only a
  `status` change on that edit emits a `contact_status_changed` milestone.)
- On the **landlord property-activity interleave**, property **field-edit churn** —
  `unit_updated`, `unit_created`, `unit_deleted`, `unit_restored` — is excluded from
  the landlord timeline so the "glance while texting" feed stays meaningful. (Those
  still appear on the property's own Activity card, which shows the full unit audit.)
  The landlord feed's lifecycle allowlist (`LANDLORD_FEED_TYPES`) is exactly:
  `broadcast_sent`, the six `tour_*`, `listing_status_changed`,
  `unit_contact_added/removed`, `listing_response_set`.

**Rationale.** The timelines exist so staff can see, at a glance while texting someone,
the state changes that matter (status, opt-out, placement stage, tours, broadcasts).
Routine field edits are audit-worthy provenance but timeline noise. If a future need
arises to surface a specific field edit, revisit this deliberately.
