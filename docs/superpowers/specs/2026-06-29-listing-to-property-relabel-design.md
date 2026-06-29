# Listing → Property relabel — design spec

> Date: 2026-06-29 · Status: approved (brainstorm) → ready for implementation plan
> Relabels the unit entity's human word from **"listing" to "property"** for
> landlords and staff/internal. Tenants keep **"home."** Copy + comments only — no
> code identifiers, no data layer, no `unit` rename, no migration.

## 1. Goal & decisions

Today the one dwelling entity (`unit` in code) is shown as **home** to tenants and
**listing** to landlords + staff (GLOSSARY). We are changing the landlord/staff word
from **listing → property**. Agreed decisions:

1. **Audience.** Landlords + staff/internal: `listing` → `property`. Tenants: keep
   `home` (unchanged). The `unit` code/data entity (`unitId`, `unitsRepo`, `UnitItem`,
   `units` table) is **unchanged** — this targets the word "listing," not "unit."
2. **Depth = copy + comments.** Change (a) user-visible display strings and (b) code
   **comments**. Do **not** rename code identifiers, types, components, routes, the
   data layer, or event/audit strings. No Terraform/table change; typecheck is
   unaffected by definition.
3. **External-market "listing" stays "listing."** `listing_link` (the external listing
   URL — field *and* the copy describing it), "public listing," and the shareable
   flyer keep "listing" — they refer to the external (Zillow-style) market listing,
   not the internal entity.
4. **Feature label flips:** "Share Listings" → "Share Properties" (display + comments).
   This reverts a prior Properties→Listings rename. The broadcast entity/routes/jobs
   and all identifiers are unchanged. (Note: the new dashboard's broadcast UI is not
   built yet, so today this is realized in the glossary + comments; the future UI
   inherits "Share Properties.")
5. **"Copy link to listing"** button (`ListingActionsMenu`) → **"Copy link to
   property"** (display only; it still copies the `listing_link` URL — the identifier
   is unchanged).
6. **Reverses the glossary's "Why not property" stance.** "Property" becomes the
   blessed landlord/staff word. Reserve **"building"/"parcel"** for any *future*
   multi-unit parent layer, so the original "property = parent of units" collision
   concern is handled by a different word rather than lost.

## 2. The one rule (display strings AND comments)

Change the **word** "listing"/"Listing"/"listings"/"Listings" → "property"/
"Property"/"properties"/"Properties" **only** where it means the **entity as a
human concept** for landlords/staff. **Keep "listing"** where it:

- **names a code symbol** — `ListingStatus`, `ListingDetail`, `ListingsList`,
  `LISTING_STATUS_LABELS`, `listing_sends`, `listingSendsRepo`, `StatusBadge
  kind="listing"`, the `/listings` route, the `'listings'` icon key, file/dir names
  (`routes/listing/`, `routes/listings/`), CSS classes — these are identifiers, NOT
  words on screen; OR
- **refers to the external market listing** — `listing_link`, "public listing,"
  the flyer, "the external listing URL."

This identifier-and-external awareness is the discipline (the inverse of the
case→placement trap list): word-boundary, concept-vs-symbol aware, never blind sed.

## 3. In scope — what changes

### 3a. Display strings (concentrated in the staff dashboard)
- Nav label `'Listings'` → `'Properties'` (`dashboard/src/app/nav.ts`); the route
  `/listings` and icon key `'listings'` stay.
- `routes/listing/ListingDetail.tsx`: `aria-label="Listing status"` → "Property
  status"; `Card title="Listing details"` → "Property details"; `title="Placements
  on this listing"` → "…on this property"; empty rows ("No contacts/placements on
  this listing yet") and the activity-log pending note → "property"; **"Copy link to
  listing"** (`ListingActionsMenu.tsx`) → "Copy link to property."
- `routes/listings/ListingsList.tsx`: H1 `"Listings"` → "Properties" + empty state.
- Panel titles "Listings sent" → "Properties sent" and "Similar listings" → "Similar
  properties" (tenant file + listing page).
- Any landlord-facing copy (SMS/notification templates) — **minimal/none today**
  (survey found no landlord-facing "listing" display copy in `app/src`); the plan
  re-greps to be sure and changes any that exist.

### 3b. Code comments
Prose "listing" that means the entity-concept → "property," across `app/src`,
`dashboard/src`, `infra/`, and `scripts/` comments — e.g. "// the listing's activity
log" → "// the property's activity log"; "Share Listings" → "Share Properties." Keep
comments that name a symbol or describe the external listing/URL/flyer (e.g.
"`listing_link` — the unit's public/external listing URL" is unchanged).

### 3c. Tests
Component + e2e tests assert the changed strings via **accessible names** (e.g.
`getByRole('heading', { name: 'Listings' })`, the AppFrame nav list, ListingDetail
copy). Update those assertions to "Properties"/"Property" in lockstep. Identifiers in
test code (component imports, `kind="listing"`, file names) are unchanged.

### 3d. Docs
- **GLOSSARY.md** — flip the audience table (landlord + staff → **property**);
  replace the **"Why not property"** section with **"Why property"**; add the
  **"building"/"parcel"** reservation for a future parent layer; update the "Share
  Listings → Share Properties" feature note and the "For the future AI layer" mapping
  ("property" to landlords + staff). Keep the "What is genuinely a 'listing' in code"
  (external-URL) section.
- **STATUS-MODEL.md** — prose "Listing" (the staff-facing coarse lifecycle in §6 and
  the "(tenant, placement, listing/unit)" references) → "Property"; the `ListingStatus`
  identifier and the status *values* (`under_application`, `finalizing`, …) are
  unchanged.
- **.claude/CLAUDE.md** — replace the "never use 'property' … normalize stray
  'property' back to unit" rule with the new convention (property = the landlord/staff
  word for the `unit` entity; "building"/"parcel" reserved for a future parent).
- **README.md / RUNBOOK.md / docs/issues/** — entity-concept "listing" prose →
  "property" where it appears; keep identifier/external references.

## 4. Out of scope — KEEP as "listing"

All code identifiers (§2 list), the `unit` entity, tenant **"home,"** and the
external-market uses (`listing_link`, "public listing," the flyer). No data-layer,
Terraform, or behavior change.

## 5. Verification

- **Typecheck** (app + dashboard) clean — the safety net proving no identifier moved.
- **Backend + dashboard tests** green; the display-asserting tests updated to the new
  accessible names.
- **e2e** green (nav "Properties," the listing page reads "Property," "Copy link to
  property"); self-QA the dashboard via the Playwright harness.
- **Fresh grep** confirms: zero `Listing*`/`listing_*` *identifiers* changed;
  `listing_link` / "public listing" / flyer untouched; no stray entity-concept
  "listing" text remains in the changed display surfaces.

## 6. Testing notes (per §5)

- Component: the dashboard suites that assert `name: 'Listings'` / "Listing …" copy
  (App, AppFrame, ListingsList, ListingDetail, the tenant-file panels) flip to the
  property wording.
- e2e: the dashboard-next specs that navigate to or assert the Listings nav / listing
  page accessible names update; the suite stays green.
- No new test files are required — this is a relabel; existing display assertions move
  with the copy.

## 7. Risks / notes

- **Low risk** — copy + comments only; no identifiers, data, or behavior change, so
  typecheck + the existing test suites are a strong backstop.
- The one discipline to enforce is **concept-vs-symbol** discernment in comments and
  strings (don't rename `ListingStatus`, don't touch `listing_link`). Adversarial
  review checks both directions: missed entity-concept "listing," and any wrongly
  touched identifier/external use.
