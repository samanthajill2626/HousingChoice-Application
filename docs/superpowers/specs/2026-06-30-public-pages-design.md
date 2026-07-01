<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-01).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Public pages surface — design spec

> Date: 2026-06-30 · Status: approved (brainstorm) → ready for implementation plan
> The last stubbed surface: the UNAUTHENTICATED public pages — a low-friction
> **teaser** unit flyer and a **housing-fair intake** — plus a **post-intake
> "full details" reveal** (the founder's richer field set). Mounts OUTSIDE the auth
> gate. Adds new unit fields + a fuller flyer projection + listing-edit-form inputs;
> the intake captures the unit-of-interest. **App-only — no new infra.**

## 1. Goal & decisions

The public flyer is a JSON endpoint today (M1.5) with no page; the housing-fair
intake has no UI on the new dashboard. Build the public surface. Decisions:

1. **Unauthenticated, mobile-first**, in a standalone public shell (HousingChoice
   brand, NO dashboard nav), mounted OUTSIDE the auth gate.
2. **Funnel:** **teaser flyer** (public, minimal — nothing to self-deny on) →
   **"I'm interested"** → **intake** (name / phone / optional voucher) → **full
   details revealed after submit** (SOFT reveal — a conversion funnel, not a token
   gate). The teaser **drops** the external "See full listing" link (there often
   isn't one, and it would bypass capture).
3. **Teaser** = the EXISTING minimal flyer allowlist (`toUnitFlyer`): photos,
   neighborhood (area/subzone), beds/baths, rent range, voucher size, accepted
   programs. No address/fees/external link.
4. **Full details (reveal)** = a richer projection: the teaser fields + **address**,
   **utilities** (tenant pays), **video tour**, **application fee**, **same-day
   RTA**. Reachable only via the flyer→intake path (we have the unitId); a plain
   housing-fair signup gets the generic thank-you.
5. **New unit fields:** `video_url` (string), `application_fee` (number ≥ 0),
   `same_day_rta` (boolean). `address` + `utilities` + `baths` already exist —
   exposed in the details projection.
6. **Listing edit form** gains inputs for the new fields so staff can populate the
   flyer (the new fields flow through the existing `/api/units` PATCH once
   allowlisted).
7. **Intake** gains an optional `unitId` → stamps `capture_source:'flyer'` +
   `unit_of_interest` on the contact (else `capture_source:'housing_fair'`), so
   staff see which home prompted the signup.
8. **No new infra** (no GSI, no IAM) — unlike Settings/Broadcasts, app-only.

## 2. Routing & public shell

- `main.tsx` already mounts `<BrowserRouter><App/></BrowserRouter>`. In `App.tsx`,
  split the tree: **public routes render WITHOUT** `AuthProvider`/`AuthGate`/
  `AppFrame`; the existing authed app is the sibling branch. (Mirrors the legacy
  "BrowserRouter above AuthProvider" approach.)
- A **`PublicLayout`** (brand header/footer, mobile-first, no nav) wraps the public
  routes:
  - **`/p/:unitId`** — the **FlyerFunnel**: one route, a client state machine
    (teaser → intake → reveal) for a single unit / one shareable URL.
  - **`/join`** (standalone housing-fair intake, no unit) → thank-you.
- **The flyer URL must match `flyerUrl()`** (`app/src/lib/mergeFields.ts`) — the
  broadcast `[FlyerLink]` merge field generates it, so every shared link must land
  on this route. Verify `flyerUrl`'s format and align the route (update both
  together if needed) — see §6.

## 3. Backend changes (app)

- **`app/src/lib/unitFields.ts`:**
  - `WRITABLE_FIELDS` gains `video_url: 'string'`, `application_fee: 'number'`,
    `same_day_rta: 'boolean'` (add a `'boolean'` `FieldKind`).
  - `toUnitFlyer` (teaser) — **unchanged** minimal allowlist.
  - **`toUnitFlyerDetails` (NEW)** + a `UnitFlyerDetails` type — the teaser fields
    PLUS `address`, `utilities`, `video_url`, `application_fee`, `same_day_rta`.
    Still a strict allowlist (NEVER landlord/contact/internal status/notes/
    payment_standard/deposit/LIF).
- **`app/src/routes/public.ts`:**
  - `GET /public/units/:unitId/flyer` — teaser (existing; `SHAREABLE_STATUSES` gate
    + opaque 404 stays).
  - **`GET /public/units/:unitId/details` (NEW)** — the full-details projection
    (same shareable gate + opaque 404; soft reveal, no token).
  - `POST /public/housing-fair` — gains optional `unitId`: when present + a
    shareable unit, stamp `capture_source:'flyer'` + `unit_of_interest:unitId` on
    the created/deduped contact; else `capture_source:'housing_fair'` (today's
    behavior). Validation generic, rate-limit + idempotent welcome unchanged.
- Units PATCH (`/api/units`) needs NO new route — the new fields ride
  `WRITABLE_FIELDS`.

## 4. Frontend — public views (dashboard)

New `dashboard/src/routes/public/`:
- **`PublicLayout`** — brand header/footer, no nav; the unauth shell.
- **`FlyerFunnel`** (`/p/:unitId`) — teaser (`GET …/flyer`) → "I'm interested" →
  `IntakeForm` → submit (`POST /public/housing-fair` with `unitId`) → `GET …/details`
  → the reveal. A missing/not-shareable unit → a friendly "this home is no longer
  available" (the opaque 404). Mobile-first photo gallery; video embed/link on the
  reveal.
- **`HousingFairIntake`** (`/join`) — the standalone intake (no unit) → thank-you.
- Shared **`IntakeForm`** (first/last/phone/optional voucher) + validation +
  thank-you/reveal states.
- **Public API client** (no auth/CSRF — public): `getFlyer(unitId)`,
  `getFlyerDetails(unitId)`, `submitHousingFair({firstName,lastName,phone,voucherSize?,unitId?})`.

## 5. Listing edit form (dashboard)

- `ListingEditForm` gains inputs: **video URL**, **application fee** (number),
  **same-day RTA** (toggle); ensure **utilities** + **address** are editable. All
  PATCH through the existing `/api/units/:id` (now accepting the new fields).
- The Listing detail read view may surface the new fields too (follow existing
  patterns) — nice-to-have, not required.

## 6. The flyer URL (shared links must resolve)

`flyerUrl(publicBaseUrl, unitId)` (`app/src/lib/mergeFields.ts`) is what the
broadcast `[FlyerLink]` puts in tenant texts. The `/p/:unitId` route MUST be the
URL `flyerUrl` produces. Read `flyerUrl`; if its path differs, align them (point
the route at it, or update `flyerUrl` + the route together) so every shared link
lands on the funnel teaser.

## 7. Validation & errors

- Intake: reuse the backend's existing name/phone validation; optional `unitId`
  must be a shareable unit (else treat as a generic signup). Generic public
  messages; rate-limited; idempotent welcome.
- Flyer/details: opaque **404** for missing OR not-shareable (no existence oracle —
  the existing pattern); the funnel renders a friendly unavailable state.
- New fields validated (`application_fee` ≥ 0; `same_day_rta` boolean; `video_url`
  a string).
- **PII (doc §9):** public responses carry ONLY allowlisted shareable fields; logs
  stay markers/IDs/counts (the existing `public.ts` posture — `phoneMarker`, never
  raw PII).

## 8. Components (each one job)

`PublicLayout` · `FlyerFunnel` (teaser→intake→reveal state machine) · `IntakeForm`
· `HousingFairIntake` · public API client. Backend: `unitFields` new fields +
`toUnitFlyerDetails` + the `/details` route + the housing-fair `unitId`/source
stamp. `ListingEditForm` new inputs.

## 9. Testing

- **Component (dashboard):** funnel transitions (teaser → intake → submit → reveal);
  teaser shows NO address/fees/external link; reveal shows address/video/utilities/
  app-fee/same-day-RTA; a 404/not-shareable unit shows the friendly state; the
  standalone `/join` intake works without a unit; `ListingEditForm` sets + persists
  the new fields.
- **Backend:** `WRITABLE_FIELDS` accepts the 3 new fields (+ rejects bad types);
  `toUnitFlyerDetails` exposes the richer set but an allowlist test proves it NEVER
  leaks internal fields; `/public/units/:id/details` gates on `SHAREABLE_STATUSES`
  + opaque 404; `POST /housing-fair` with `unitId` stamps `capture_source:'flyer'`
  + `unit_of_interest` (and validates the unit), else `'housing_fair'`; rate-limit
  holds.
- **e2e:** open a flyer link (teaser, unauthenticated) → "I'm interested" → submit →
  see the reveal (address + app fee); the contact is captured with the flyer source
  + unit (assert via the dashboard/API); a staff edit of the new fields shows on the
  reveal. Public routes reachable WITHOUT a session.

## 10. Phasing

- **Phase A — backend + edit form:** new unit fields, `toUnitFlyerDetails` + the
  `/details` route, the housing-fair `unitId`/source stamp, `ListingEditForm`
  inputs. App + dashboard test-covered. No infra.
- **Phase B — public surface:** `PublicLayout` + `FlyerFunnel` + `IntakeForm`
  mounted OUTSIDE the auth gate + the public API client + e2e.

## 11. Notes / future

- **Soft reveal** by design (no token gate) — revisit only if leads need protecting.
- Teaser keeps the existing minimal allowlist; `listing_link` stays a field but the
  teaser stops linking to it.
- **No new infra** (no GSI/IAM) — nothing for the operator to `terraform apply`.
- Mobile-first throughout (phones at fairs + shared links).
- Naming: dwelling = `unit` (code) / `home` (tenant-facing copy on these pages) /
  `property` (staff); these are tenant-facing pages → "home".
