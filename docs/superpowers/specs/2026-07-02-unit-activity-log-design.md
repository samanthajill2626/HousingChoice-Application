<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Unit activity log — read path + property-page Activity card

**Date:** 2026-07-02
**Status:** Approved (built same day)
**Branch:** `feat/unit-activity-log` (worktree `w:/tmp/unit-activity`)

## Problem

The property detail page's "Activity" card is a construction-era placeholder
(`ListingDetail.tsx` renders a `PendingPanel`: "The property's activity log
arrives with the backend"). The backend records plenty of unit history but
never grew a read endpoint to serve it.

## Investigation — what is actually recorded today (anchors verified)

The task brief assumed `activityEventsRepo` holds unit activity. Verified
reality is different, and it changes the design:

- **`activity_events` is contact-keyed** (PK `contactId`, SK `tsEventId`, no
  GSI — `lib/tables.ts`). The `activityEvents.record` call in `units.ts`
  (~line 601) writes a `listing_reviewed` milestone **for the tenant's
  timeline**, merely *referencing* the unit (`refType:'unit'`). There is no
  unit-keyed query surface, and adding one would need a new GSI (Terraform
  apply) while still only covering 2 event types (`listing_reviewed`,
  `listing_sent`).
- **The unit-keyed activity log already exists: the audit trail.**
  `audit_events` (PK `entityKey` = `units#<unitId>`, SK `ts` =
  `<ISO>#<suffix>`) is written by every unit mutation, and
  `auditRepo.listByEntity` is already a newest-first, bounded, pageable read
  (built for exactly this, previously unconsumed by any route).

Unit audit events recorded today (the honest event inventory):

| event_type              | writer                                        | payload details               |
| ----------------------- | --------------------------------------------- | ----------------------------- |
| `unit_created`          | POST /api/units                               | actor, landlordId, status     |
| `unit_updated`          | PATCH /api/units/:id                          | actor, fields[]               |
| `unit_contact_added`    | POST /api/units/:id/contacts                  | actor, contactId, role, primaryVoice |
| `unit_contact_removed`  | DELETE /api/units/:id/contacts/:contactId     | actor, contactId              |
| `listing_response_set`  | PATCH /api/units/:id/recipients/:contactId    | actor, contactId, response    |
| `listing_status_changed`| statusTransition service (manual + derived)   | actor?, from?, to, source     |
| `unit_deleted`          | DELETE /api/units/:id                         | actor, deletedAt              |
| `unit_restored`         | POST /api/units/:id/restore                   | actor                         |

## Decision

**Serve `GET /api/units/:unitId/activity` from the audit trail.** Zero
schema/GSI change, covers every recorded unit event, and matches the card's
semantics (the property's record trail). The rejected alternative — a GSI on
`activity_events.refId` — costs an infra apply and misses edits, status
changes, roster changes, create/delete/restore entirely.

Known gap (accepted, documented): "property sent to tenant" is not a
unit-keyed audit event (broadcast sends audit under `broadcasts#<id>`), so
sends don't appear in this card — the adjacent "Sent to tenants" card already
shows exactly that, per-recipient with responses.

## Backend

`GET /api/units/:unitId/activity?limit=` in `app/src/routes/units.ts`
(sibling style of `/recipients`, `/related`, `/similar`, `/placements`):

- 404 `unit_not_found` for an unknown unit (matches siblings); 400 on an
  invalid `limit` (reuses `parseLimit`, 1..100, default 50).
- One `audit.listByEntity('units#<unitId>', { limit })` Query — newest-first.
  Bounded-limit, no cursor in v1 (a unit's trail is small; the repo's
  `before` bound is there when paging is ever needed).
- Wire shape `{ events: UnitActivityEvent[] }`:

  ```ts
  interface UnitActivityEvent {
    id: string;        // the audit ts SK — unique within the unit
    at: string;        // ISO — the ts prefix
    type: string;      // event_type (open set; the 8 above today)
    actorId?: string;
    // whitelisted per-type details (NEVER the raw payload):
    contactId?: string;
    contactName?: string; // read-time enrichment, best-effort
    role?: string;         // unit_contact_added
    response?: string;     // listing_response_set
    fields?: string[];     // unit_updated
    from?: string;         // listing_status_changed
    to?: string;           // listing_status_changed
    source?: string;       // listing_status_changed (manual | derived)
  }
  ```

- Details are **whitelisted per known type**, never a raw `payload` dump — a
  future audit payload carrying a phone can't leak through this endpoint.
- `contactName` is resolved at read time (deduped map, try/catch → omitted,
  never 500) — mirrors the `/placements` tenantName enrichment.
- PII: log lines carry unitId/counts only.

**Test harness:** the fake `auditRepo.listByEntity` returns copies without a
`ts` (the real repo's SK, always present). Extend the fake to stamp a real
monotonic `ts` (`<ISO>#<seq>`, hidden non-enumerable key like `__seq`, added
onto the returned copies) so the route's at/id derivation is exercised
honestly. `world.auditEvents` assertion shape is unchanged.

## Dashboard

- `api/types.ts`: `UnitActivityEvent` (mirrors the wire shape verbatim).
- `api/endpoints.ts`: `getUnitActivity(unitId, signal)` unwrapping
  `{ events }` — 404s on older deployed backends → the card renders the
  honest pending state (same `loadSlice` degradation as recipients/similar).
- `useListing.ts`: `activity: Slice<UnitActivityEvent>` loaded in the
  existing `Promise.all` via `loadSlice`.
- `listingFormat.ts`: pure `describeUnitActivity(evt)` → `{ label, sub?, to? }`
  mapping the 8 known types to staff copy (GLOSSARY: "property", never
  "listing"/"unit") — e.g. "Property created", "Property updated" (+ humanized
  field list), "Contact added" (+ name/role, links to the contact),
  "Tenant response · Interested", "Status changed · Setup → Available"
  (via `LISTING_STATUS_LABELS`), "Property deleted"/"restored". Unknown types
  fall back to `humanize(type)` — never a blank row.
- `ListingDetail.tsx` Activity card: ready → `Row` per event (label + sub,
  right side "Mon Jun 8 · 9:14a" via the existing `formatDayDivider` +
  `formatTime`); ready+empty → "No activity yet."; error → "We couldn't load
  activity."; pending → `PendingPanel` (older deployed envs degrade honestly).

## Tests

- `app/test/unitsApiActivity.test.ts` (in-memory harness, mirrors
  `unitsApiPlacements.test.ts`): 404 unknown unit; `{ events: [] }` empty;
  events generated **through the real API writes** (PATCH unit, roster add,
  response set) come back newest-first with honest types/details; contactName
  enrichment (+ null-safe when the contact is gone); no `payload` key on the
  wire; limit validation + bounding.
- Dashboard: `useListing.test.tsx` (slice ready/pending), `listingFormat.test.ts`
  (`describeUnitActivity` per type + unknown fallback), `ListingDetail.test.tsx`
  (rows render, empty state, pending state).
- Live: Playwright MCP against `npm run dev -- --mock --local` — dev-login,
  open a property, edit it + change status, confirm rows appear.
