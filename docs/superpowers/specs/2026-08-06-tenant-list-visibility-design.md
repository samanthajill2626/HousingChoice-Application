# Tenant list visibility: voucher size + housing authority

**Date:** 2026-08-06 (revised after adversarial review round 1)
**Status:** approved design, not yet built
**Origin:** founder feature request - "Visibility things missing: want to see all tenants by
voucher size and housing authority/voucher program. Some of the eligibility criteria too"
**Review:** spec round 1, two parallel reviewers; adjudications at
`.superpowers/design-review/adjudications.md`

## 1. Problem

The Contacts list can only be searched by name and phone. `ContactsList` renders exactly three
meta chips per row - kind badge, phone, status - so a tenant's voucher size and housing authority
are invisible until you open their file, where `ContactDetail:698-711` builds a header subtitle
like `Voucher 3BR - atlanta_housing` and `TenantFile:143-165` shows both in the Details card.

So the founder cannot answer "who are my 2 BR Atlanta Housing tenants" without opening records one
at a time.

## 2. Scope

**In scope.**

- Filter controls above the Tenants list: voucher size, housing authority, porting.
- Voucher size and housing authority visible on every tenant row.
- Filter state carried in the URL.
- Per-chip counts.
- A suggestion-backed housing-authority input on the contact edit form (section 7). Small, and
  load-bearing: without it the facet cannot be trusted (section 3).

**Out of scope, by founder-facing decision.**

- **Voucher program as a distinct dimension.** Use `housingAuthority` alone. Open question for the
  founder (section 10). Seeds already write `voucher_program: 'HCV'` on every cast tenant while
  nothing reads it, and the Airtable import carries a real `voucherProgram` column it currently
  drops - so the field name is effectively spoken for if we do add it.
- **The free-text eligibility fields** - `pets`, `evictions`, `tenure`. Three of the six
  eligibility fields are free text and cannot become facets without producing one facet per
  distinct string. Deferred to a later filtered-columns view.

**Out of scope, by build-side judgment.**

- **A "voucher expiring soon" chip.** No soon-window policy exists: `deadlineRelative`
  (`placementsFormat.ts:48-56`) returns "due in Nd" for any future date and "overdue" once past,
  with no threshold; `urgencyOf` (`app/src/routes/today.ts:192-203`) is likewise a coarse bucket.
  A row chip would require inventing urgency policy, which does not belong in a visibility change.
- **A LIF eligible filter.** `lifEligible` is written by zero seed records. Covered by the
  hide-when-absent rule in section 5 - if the founder starts recording it, the control appears.
- **Grouped-with-counts sections** (a second list rendering mode). Per-chip counts deliver most of
  that value for none of the layout cost.
- **Normalizing the stored authority vocabulary** (seeds, placeholders, retiring
  `humanizeAuthority`, backfilling existing rows). Tracked in
  `docs/issues/housing-authority-free-text-drift.md`. Section 3 explains what this spec does
  instead, and why that is enough for a trustworthy facet.
- **Making imported tenants render a name.** The import writes `display_name` and nothing reads
  it, so imported tenants render as their phone number. Real, material to the cutover, and NOT
  caused by this work. Filed as `docs/issues/import-display-name-unread.md`.

## 3. The housing-authority vocabulary - what is true, and what this spec relies on

This drove the largest revision after review, so it is stated before the design that depends on it.

**Human-readable names are the canonical form. Slugs are an accident.**

- The founder's real data is human-readable. Her Airtable "Voucher Type" column IS the housing
  authority - `airtableSource.ts:41` documents the values in a comment: `"Atlanta Housing"`,
  `"Dekalb Housing"`, `"Jonesboro Housing"`. The import feeds it into the workbook's
  `housing_authority` column (`workbook.ts:291`).
- The AI extraction vocabulary is human-readable: `HOUSING_AUTHORITY_VOCAB`
  (`app/src/services/extraction/schema.ts:45-58`) is `'Jonesboro (JHA)'`, `'Fulton County'`,
  `'Atlanta (AHA)'`, `'Clayton County'`, `'College Park'`,
  `'Georgia Housing Voucher (GHV)'`, `'Step Up'`, `'Claratel'`, `'Hope Atlanta'`, `'HUD VASH'`,
  `'DCA'`, `'McDonough'`, `'East Point'`. `extraction/apply.ts:97-102` validates against it and
  stores the value verbatim; extraction is on by default outside production
  (`app/src/lib/config.ts:775`).
- Slugs originate in dev seed fixtures - `atlanta_housing` first appears in commit `01371194`
  ("M0.3: local dev environment", whose payload is `app/scripts/db-seed.ts`). They then leaked
  into two input placeholders and into `humanizeAuthority`, which exists only to convert them
  back.
- The unit side confirms the original intent: `listingFormat.ts:53` joins `unit.jurisdiction` into
  an ADDRESS/AREA line ("123 Main St, Atlanta"), which only reads correctly with a place name. The
  tests are split - `ListingDetail.test.tsx:86` and `listingFormat.test.ts:70` use `'Atlanta'`,
  while `ListingsList.test.tsx` uses `'atlanta_housing'`.

**What this means for the facet.** Facet chips are derived from distinct stored values, so two
spellings of one authority would show as two chips with the counts split between them - and the
founder's literal question would get a confidently wrong answer. Three facts bound that risk:

1. The import writes NO contact-side authority (`import/apply.ts` writes only `display_name` and
   `voucherSize` on contacts), so no real tenant will carry a slug.
2. Going forward there are exactly two writers of `contact.housingAuthority`: AI extraction
   (curated vocabulary) and staff typing into the edit form (`contacts.ts:498-502` accepts any
   string).
3. Therefore aligning the human entry point with the vocabulary the machine already uses removes
   the collision at its only live source. That is what section 7's suggestion-backed input does,
   and it is why that input is in scope rather than deferred.

**Display rule.** Render the stored value AS-IS. Apply `humanizeAuthority` only as a legacy
fallback, to values still matching a slug shape (`/^[a-z0-9]+(_[a-z0-9]+)+$/`), so dev and seed
worlds keep reading correctly. This is the opposite polarity from a first-pass reading: humanize is
a compatibility shim on the way out, not the display path. Note the helper is unsafe on free text -
it uppercases any token of 3 characters or fewer, so `'Step Up'` would become `'Step UP'` - which
is precisely why it must not be applied to non-slug values.

## 4. Data - no backend work

| Field | Shape | Notes |
| --- | --- | --- |
| `contact.voucherSize` | number (bedrooms) | `0` means Studio. PATCH accepts 0..12 (`contacts.ts:449-455`) |
| `contact.housingAuthority` | string | `byHousingAuthority` GSI hash. Also carried by a `team_member` in the lean seed (`lean.ts:118-124`), which these views never fetch |
| `contact.porting` | boolean | Informational; gates nothing (`statusTransition.ts:517-522`) |

`GET /api/contacts` returns whole items with no `ProjectionExpression` (`contacts.ts:893-900`,
`contactsRepo.ts:742-758`), so all three are already on the wire. `useContacts` walks every page of
every type via the `nextCursor` loop, bounded at `MAX_PAGES = 40` with a console warning
(`useContacts.ts:17,32`). All filtering is client-side over that array. **No API, route, repo, or
GSI changes.**

Counts describe LOADED records. If the page cap is ever hit the list is already truncated and the
counts inherit that; the existing warning is the signal.

## 5. Filter controls

Rendered only when `filter === 'tenant'` - every field here is tenant-only. Follows `ListingsList`
(derived options, client-side filter, `aria-pressed` chips, a Clear affordance per facet).

- **Voucher size** - multi-select chips. Options are the distinct values present, sorted ascending.
- **Housing authority** - multi-select chips, distinct values present, sorted, displayed per
  section 3's rule.
- **Porting** - a single toggle chip.

**Labels reuse `voucherSizeLabel`** (`broadcasts/broadcastFormat.ts:35-39`, test-locked at
`broadcastFormat.test.ts:16-20`): `0 -> 'Studio'`, `1..3 -> 'N-BR'`, `>= 4 -> '4+ BR'`. Consequence,
accepted deliberately: sizes 4 and above collapse into ONE `4+ BR` chip that selects all of them.
One spelling everywhere beats an exact-but-fourth spelling. (Two other spellings survive on the
detail surfaces - `TenantFile.tsx:143` and `ContactDetail.tsx:705` - and are out of scope here.)

**Numeric zero must not be dropped.** `ListingsList`'s presence idiom is a truthiness guard
(`typeof u.jurisdiction === 'string' && u.jurisdiction`). Copied to a number, `0` is falsy and
Studio would vanish from the facet, the row and the counts. Presence for `voucherSize` is
`typeof v === 'number'`, never truthiness. No seed writes `voucherSize: 0`, so only a unit test can
catch a regression here - section 9 requires one.

**Hide when absent.** A control renders only when at least one loaded tenant carries that field.
For the boolean, "carries" means `=== true` - `porting: false` is written by lean, cast and matrix
seeds, so a presence test would render a permanently dead toggle, the exact failure the rule
exists to prevent.

**"Not recorded" bucket.** Each of the two value facets carries a final `Not recorded (N)` option
matching tenants with no value. Required, not optional: since the import writes no contact
authority, most post-cutover tenants will have none, and without this option selecting any
authority silently excludes that entire population.

**Counts.** Each chip shows the number of tenants it would contribute. A facet's counts reflect
every OTHER active facet and the search query, but NOT its own selection - standard faceted-search
semantics. So with nothing else selected in that facet, `Atlanta Housing (12)` means clicking it
leaves 12 rows. Because multi-select within a facet is OR, clicking a second value in the SAME
facet ADDS its count rather than narrowing to it.

**Semantics.** OR within a facet, AND across facets. Empty selection means unconstrained, never
"match nothing".

**Layout and gating.** The control block sits between the filter tabs and the search box. It wraps
at narrow width (`flex-wrap: wrap`, as `ListingsList`'s `.controls`/`.chips` already do) and
follows the existing `status !== 'ready'` gating the search input uses.

**Empty result.** `ContactsList.tsx:187` currently renders `No matches for "{query}"`
unconditionally, so facets with an empty search box would render `No matches for "".` It must gain
`ListingsList`'s conditional (`ListingsList.tsx:244-248`), including its precedence: the query
message wins when both a query and facets are active.

## 6. Row layout

**Predicate.** The fact line renders when `contact.type === 'tenant'` AND `filter !== 'deleted'`.
This requires threading `filter` into `Row` (section 8), because `Row` receives only `{ contact }`
today. Consequence, stated deliberately: on `/contacts` (the `all` view) tenant rows DO show fact
lines while the filter controls do NOT render - the facts are useful there, the tenant-only
controls would be nonsense above a mixed list.

**Row skeleton.** Two spans inside the existing row link.

```
WIDE (>560px container):
  [ name ..................... ] [ kind | phone | status | facts | Porting ]
     .name (flex 1 1 auto)          .meta (flex 0 0 auto, right-aligned)

NARROW (<=560px container):
  [ name (wraps in full) ....................................... ]
  [ kind | phone | status | facts | Porting ...... (wraps) ...... ]
     .meta (flex 1 1 100%)
```

- The kind badge, phone and status chips are **kept, unchanged, in their current order**. The
  facts (`3 BR - DeKalb Housing`) and the `Porting` chip are appended to the same `.meta` group.
  `ContactsList.test.tsx:86` asserts the phone renders inside the row link and must keep passing.
- "Wide pane unchanged" therefore means: still one right-aligned `.meta` line, now with more chips
  in it. There is no separate second line at wide width.
- At narrow width `.meta` already wraps to its own full-width line
  (`ContactsList.module.css:200-208`); the added chips wrap within it.
- **The name wraps rather than truncating** at narrow width, in `ListingsList`'s exact idiom
  (`ListingsList.module.css:292-299`: `flex: 1 1 100%; white-space: normal; overflow: visible;
  text-overflow: clip`). Rationale: an ellipsized long name loses the row's identity, and the name
  matters more than a line of height.

**Missing values collapse; they never render as placeholders.** Unlike `EligibilityIntakeCard`,
which deliberately renders every field as BLANK so staff can see what is missing, a list row is
scanned and a column of dashes is noise. With only a size the facts read `3 BR`; with only an
authority, `DeKalb Housing`; with neither, no facts chip renders. The `-` separator appears only
between two present values, never leading or trailing.

**Density, in tokens (not raw px - the stylesheet header mandates tokens).** Inside the existing
`@container (max-width: 560px)` block only: `.row` padding `var(--sp-2) var(--sp-3)`, `.rowItem`
margin-bottom `var(--sp-1)`.

**Scoping.** `.row`/`.rowItem` are shared by all five filter routes, so an unscoped change would
also retighten landlord, unknown and deleted rows. The density change is scoped to tenant rows via
a modifier class applied by the same predicate above.

**Acceptance criterion** (replacing an unreproducible visual claim): at a 375px viewport, a tenant
row whose name is 32 characters and whose authority is "Marietta Housing Authority" shows the
complete name with no ellipsis, and the row's height is at least 44px. Checkable in live QA and
assertable in the component test.

## 7. Housing-authority input on the contact edit form

`ContactEditForm.tsx:481-488` is today a bare text input placeheld `e.g. atlanta_housing`. Replace
with a suggestion-backed input following the established idiom in `CustomFieldsEditor.tsx:62-82`
and `KindPicker.tsx:83` - a `<datalist>` of known values attached to a normal text input:

- Free text remains fully accepted. A new authority not on the list is typed and saved as-is; the
  datalist suggests, it does not constrain.
- Suggestions are the extraction vocabulary. The dashboard cannot import from `app/src`, so the
  list is mirrored dashboard-side with a comment pointing at
  `app/src/services/extraction/schema.ts` as the source of truth - the same hand-mirror pattern
  `api/types.ts` already uses for `OrgSettings`.
- The datalist id must come from `useId()`, not a module constant - `CustomFieldsEditor.tsx:22-24`
  records this fix (a module-level id collides across instances).
- The placeholder changes from `e.g. atlanta_housing` to `e.g. Atlanta (AHA)`, per section 3.

Only the CONTACT form is in scope. The two unit-side inputs (`UnitCreateForm.tsx:301`,
`ListingEditForm.tsx:223`, both placeheld `e.g. ga_dca`) keep their current behavior; changing them
belongs to the drift issue.

## 8. Components

| Unit | Responsibility |
| --- | --- |
| `tenantFacets` (new, pure) | Derives options + counts from `Contact[]` + the active selection, and applies a selection. No React; unit-testable alone. Owns the numeric-zero, boolean-true and not-recorded rules. |
| `TenantFilters` (new) | Renders the three facet controls. Props in, callback out; no fetching. |
| `authorityLabel` (new, shared) | Section 3's display rule; wraps the lifted `humanizeAuthority` behind the slug-shape test. |
| `humanizeAuthority` (moved) | Lifted out of `ListingsList.tsx:36-42` into the shared module, unchanged, and consumed through `authorityLabel`. |
| `ContactsList` (edited) | URL state, renders `TenantFilters` when `filter === 'tenant'`, threads `filter` into `Row`, extends `Row` with the facts chip. |
| `ContactEditForm` (edited) | Section 7's datalist input. |

Keeping derivation and filtering in a pure module is what stops `ContactsList` growing a third
responsibility beside search and create.

## 9. URL state

Filter state lives in the query string via `useSearchParams`. It survives refresh and
back-navigation, is shareable, and fits the direction of a later filtered-columns view.
`ListingsList` keeps its own filters in local `useState` (`ListingsList.tsx:81-85`); this
deliberately departs from that precedent, and the two lists will differ on filter persistence
until the properties list follows.

Params, absent when unset: `voucher` (comma-separated sizes), `ha` (comma-separated authorities),
`porting` (presence-only).

- **Writes use `{ replace: true }`**, matching the only existing param writer
  (`public/FlyerPage.tsx:129`). Push would make every chip toggle a history entry, so Back would
  walk chip-by-chip instead of leaving the page.
- **Writes MERGE the existing query string**, never replace it wholesale - `?phone=` is read at
  `ContactsList.tsx:97-102` and must survive a facet toggle.
- **`porting` is presence-only**, so `?porting=false` must be treated as ABSENT, not as on.
- **Unknown values in a multi-value param are dropped individually**; the remaining known values
  still filter. A stale link must never silently empty the list.
- **`Not recorded` is a reserved sentinel value** in `voucher` and `ha` (`__none__`), so it round-
  trips like any other selection.
- **The filter tabs must preserve filter params.** `FILTERS` entries are bare paths
  (`ContactsList.tsx:38-44`), so today re-clicking the active "Tenants" tab would silently reset
  every facet. Tab links carry the current params forward.

## 10. Testing and verification

- **Unit** (`tenantFacets`): option derivation and sort order; `voucherSize: 0` present and
  labelled "Studio" (pinned explicitly - no seed provides it); counts reflect other facets and the
  query but not their own facet; OR-within / AND-across; empty selection unconstrained;
  not-recorded bucket; boolean hide-unless-true; unknown URL values dropped individually.
- **Unit** (`authorityLabel`): a slug humanizes; a free-text value with a short token
  (`'Step Up'`) passes through UNCHANGED.
- **Component** (`ContactsList.test.tsx`): controls present on Tenants, absent on
  Landlords/Unknown/All/Deleted; a tenant row shows the facts chip and keeps its kind/phone/status
  chips; a landlord row shows no facts; deleted tenant rows show none; URL round-trip; the active
  tab preserves params. Accessibility-first selectors per `e2e/support/selectors.md`, and add the
  new controls to that file.
- **Component** (`ContactEditForm.test.tsx`): the datalist renders the vocabulary, and a
  free-text authority not on the list still PATCHes.
- **e2e**: the harness reseeds the DEFAULT profile (`e2e/support/preflight.ts:140` posts
  `/__dev/reseed` with no profile; `app/src/routes/dev.ts:220` defaults to `lean`), and lean holds
  exactly ONE tenant - so facets cannot narrow anything. The spec MUST create its own tenants via
  the existing `voucherSize`/`housingAuthority` support in `e2e/scenarios/steps.ts:581-647`. There
  is no existing contacts-list e2e spec to extend; this creates one.
- **Live self-QA at 375px** through the project Playwright MCP against a hermetic
  `npm run e2e:session` lane, before handback, asserting section 6's acceptance criterion. Lane 0
  is the human's live stack - never touch it. Reseed with `POST /__dev/reseed?profile=full`; never
  let full-profile work leak into the byte-stable `lean` world. Reseeding logs the browser out.
  Screenshots need an explicit `.playwright-mcp/` prefix or they resolve at the repo root.
- **Gates**, bare and never piped, from the worktree, green on a base synced with `main`:
  - `npm run typecheck` - a REQUIRED separate gate. `npm test` and e2e run through esbuild/tsx,
    which strip types without checking them.
  - `npm test` - all workspaces.
  - `timeout 1500 npm run e2e` - the outer cap is mandatory; the suite can wedge with zero output
    and no per-test timeout. Warm containers first (`npm run db:start` / `npm run s3:start`). e2e
    runs ONLY from the worktree - a stray root run silently targets the live dev stack on :5174.
- **Known flakes** to re-run the full suite against before blaming this change, reporting both
  runs: `tour-reminders-panel-e2e-flake` and `conversationdetail-members-mock-suite-flake`.

## 11. Open questions for the founder

Neither blocks this build:

1. **Voucher program.** Is program a second dimension alongside housing authority, or the same
   thing? The Airtable values ("Georgia Housing Voucher, GHV", "HUD VASH", "Claratel",
   "Hope Atlanta") look like funders and sponsors rather than PHAs, which suggests two axes - but
   her phrasing joined them with a slash. Note the extraction vocabulary already mixes both kinds
   into one field, which is evidence the distinction has never been drawn anywhere.
2. **Which eligibility criteria.** "Some of the eligibility criteria" needs to become specific
   before the deferred view is designed. If the answer is pets, that argues for a derived
   `has pets / no pets` toggle rather than surfacing the free text.
