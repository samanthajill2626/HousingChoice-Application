# Tenant list visibility: voucher size + housing authority

**Date:** 2026-08-06
**Status:** approved design, not yet built
**Origin:** founder feature request - "Visibility things missing: want to see all tenants by
voucher size and housing authority/voucher program. Some of the eligibility criteria too"

## 1. Problem

The Contacts list can only be searched by name and phone. `ContactsList` renders exactly three
meta chips per row - kind badge, phone, status - so a tenant's voucher size and housing authority
are invisible until you open their file, where `ContactDetail` builds a header subtitle like
`Voucher 3BR - atlanta_housing` and `TenantFile` shows both in the Details card.

So the founder cannot answer "who are my 2 BR Atlanta Housing tenants" without opening records one
at a time.

## 2. Scope

**In scope.**

- Filter controls above the Tenants list: voucher size, housing authority, porting.
- Voucher size and housing authority visible on every tenant row.
- Filter state carried in the URL.
- Selected-count labels on the filter chips.

**Out of scope, by founder-facing decision (Cameron, 2026-08-06).**

- **Voucher program as a distinct dimension.** Use `housingAuthority` alone for now. Whether
  program is a second axis is an open question for the founder (see section 9). Note that seeds
  already write `voucher_program: 'HCV'` on every cast tenant while nothing reads it, and the
  Airtable import carries a real `voucherProgram` column it currently drops - so the field name is
  effectively spoken for if we do add it.
- **The free-text eligibility fields** - `pets`, `evictions`, `tenure`. Three of the six
  eligibility fields are free text and cannot become filter facets without producing one facet per
  distinct string. Cameron's call: "anything with free text we could probably ignore and talk
  about a new view later."

**Out of scope, by build-side judgment.**

- **A "voucher expiring soon" chip.** There is no soon-window policy anywhere in the codebase:
  `deadlineRelative` returns "due in Nd" for any future date and "overdue" once past, with no
  threshold. A row chip would require inventing urgency policy, which does not belong in a
  visibility change.
- **A LIF eligible filter.** `lifEligible` is populated by zero seed records, so the control would
  render permanently empty. Covered instead by the hide-when-absent rule in section 4.
- **Grouped-with-counts sections** (a second list rendering mode). The per-chip counts in section
  4 deliver most of that value for none of the layout cost.
- **Fixing the housing-authority vocabulary drift.** Filed separately as
  `docs/issues/housing-authority-free-text-drift.md`. This work derives its facets from whatever
  is in the data and therefore inherits that fragmentation; it neither introduces nor corrects it.

## 3. Data - no backend work

Every field needed already exists and is already served.

| Field | Shape | Notes |
| --- | --- | --- |
| `contact.voucherSize` | number (bedrooms) | `0` means Studio, per the AudienceFilter convention |
| `contact.housingAuthority` | string, free text | `byHousingAuthority` GSI hash; tenant-sparse |
| `contact.porting` | boolean | Informational only - gates nothing since the 2026-06-19 decision |

`useContacts` already walks every page of every contact type via the `nextCursor` loop (bounded at
`MAX_PAGES = 40`), so the complete tenant list is in memory before the list renders. All filtering
is client-side over that array. **No API, route, repo, or GSI changes.**

## 4. Filter controls

Rendered **only** when `filter === 'tenant'`. Every field here is tenant-only, so these controls
would be meaningless above the Landlords, Unknown, or All lists.

Follows the established precedent in `ListingsList` (status select + housing-authority multi-select
chips, options derived from loaded data, filtered client-side).

- **Voucher size** - multi-select chips. Options are the distinct `voucherSize` values present in
  the loaded tenants, sorted ascending. `0` labels as "Studio", everything else as "N BR".
- **Housing authority** - multi-select chips. Options are the distinct `housingAuthority` values
  present, sorted, displayed through the shared `humanizeAuthority()` (section 6).
- **Porting** - a single toggle chip. Populated across roughly a third of matrix-seeded tenants,
  so it is live data rather than a dead control.

**Counts.** Each chip carries the number of currently-loaded tenants matching it, e.g.
`Atlanta Housing (14)`. Counts reflect the full loaded tenant set, not the
already-filtered-by-other-facets subset - a count that changes as you click elsewhere reads as a
bug rather than a feature.

**Hide when absent.** A control renders only when at least one loaded tenant carries that field.
This generalizes what the Properties list already does for its authority chips: it keeps
never-populated fields (`lifEligible` today) from showing as permanently empty UI, and means such
a control appears on its own the moment the founder starts recording that field.

**Multi-select semantics.** Within one facet, selections are OR (2 BR or 3 BR). Across facets they
are AND (2 BR **and** Atlanta Housing). Empty selection means no constraint, not "match nothing".
Each facet gets a Clear affordance when non-empty, matching `ListingsList`.

**Empty result.** The existing `noMatches` line already distinguishes a search miss from a filter
miss ("No properties match the selected filters"); mirror that wording for tenants.

## 5. Row layout

Tenant rows only. Landlord, unknown, and deleted rows are untouched.

- **Line 1:** name, then status - exactly as today.
- **Line 2:** `3 BR - DeKalb Housing`, plus a `Porting` chip when set.

**Missing values collapse; they never render as placeholders.** Unlike the tenant file's
Eligibility intake card - which deliberately renders every field as BLANK so staff can see what is
still missing - a list row is scanned, so a column of dashes is noise. With only a voucher size the
line reads `3 BR`; with only an authority, `DeKalb Housing`; with neither, the fact line does not
render at all and the row is a single line. The separator appears only between two present values,
never leading or trailing.
- **Wide pane:** unchanged. Chips right-align on a single line as they do now.
- **Narrow pane** (`@container (max-width: 560px)`, the existing query container on `.page`):
  8x12 row padding, 4px between rows, and no gap between the two lines.

**The name wraps rather than truncates** at narrow width. This was validated visually against a
deliberate worst case - a long hyphenated name plus "Marietta Housing Authority" plus two warning
chips - where an ellipsized name became "Christopher Vandenberg-Whitf...". Losing a tenant's name
is worse than gaining a line. `ListingsList` already made this exact call for the property address
("on its own line, let it wrap in full (city + zip) instead of truncating"). Status stays
baseline-aligned to the first line, so it remains visually top-right.

Row height at 375px stays comfortably above a 44px touch target.

**Why not a single line.** Chips cannot break mid-token, so a long authority forces a wrap
regardless of padding. Two predictable lines beat one line that unpredictably becomes three.

## 6. URL state and shared code

**URL-backed filters.** Filter state lives in the query string via `useSearchParams`, not local
`useState`. This survives refresh and back-navigation, is shareable, and fits the direction Cameron
described ("in the future we might be moving towards a more filtered view where we can filter by
specific columns"). It also composes with the existing `?phone=` deep link that
Inbox/Today/conversation links already use, which the component reads today.

Proposed params, absent when unset: `voucher` (comma-separated sizes), `ha` (comma-separated
authorities), `porting` (present when on). Unknown or stale values are ignored rather than treated
as "match nothing" - an authority that no longer exists in the data must not silently empty the
list.

**Shared `humanizeAuthority()`.** Currently private inside `ListingsList.tsx`. Lift it into a
shared module both lists import. The properties list and the tenants list must agree on how
`ga_dca` is spelled on screen, or one authority reads two different ways in two places. This is the
one refactor in scope; it is not a general cleanup of either list.

## 7. Components

| Unit | Responsibility |
| --- | --- |
| `TenantFilters` (new) | Renders the three facet controls from derived options + counts. Props in, callback out - no data fetching. |
| `tenantFacets` (new, pure) | Derives options + counts from a `Contact[]`, and applies a selection to filter it. No React, unit-testable in isolation. |
| `humanizeAuthority` (moved) | Shared slug-to-label formatting. |
| `ContactsList` (edited) | Wires URL state to `tenantFacets`, renders `TenantFilters` when `filter === 'tenant'`, extends `Row` with the tenant fact line. |

Keeping the derivation and filtering in a pure module is what keeps `ContactsList` from growing a
third responsibility on top of search and create.

## 8. Testing and verification

- **Unit** (`tenantFacets`): option derivation and sort order; Studio labeling for `0`; counts;
  OR-within-facet and AND-across-facet semantics; empty selection means unconstrained; unknown URL
  values ignored; hide-when-absent.
- **Component** (`ContactsList.test.tsx`): controls appear on the Tenants view and are absent on
  Landlords/Unknown/All; a tenant row shows voucher size and authority; a landlord row does not;
  URL round-trip. Accessibility-first selectors per `e2e/support/selectors.md`.
- **e2e**: drive the real Tenants view - apply a facet, assert the list narrows, reload and assert
  the filter survived.
- **Live self-QA at 375px** through the Playwright MCP against the hermetic `e2e:session` lane,
  before handback, per CLAUDE.md. Never against the live stack.
- **Gates:** `npm run typecheck` + `npm test` + `npm run e2e`, green on a base synced with `main`.

## 9. Open questions for the founder

Both are hers to answer, and neither blocks this build:

1. **Voucher program.** Is program a second dimension alongside housing authority, or the same
   thing? The Airtable values ("Georgia Housing Voucher, GHV", "HUD VASH", "Claratel",
   "Hope Atlanta") look like funders and sponsors rather than PHAs, which suggests two axes - but
   her phrasing joined them with a slash. If it is a second axis, the import can start landing data
   it currently discards.
2. **Which eligibility criteria.** "Some of the eligibility criteria" needs to become specific
   before the deferred view is designed. Worth asking what she actually sorts people by. If the
   answer is pets, that argues for a derived `has pets / no pets` toggle rather than surfacing the
   free text.
