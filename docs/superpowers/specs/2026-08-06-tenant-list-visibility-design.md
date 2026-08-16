<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-16).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Tenant list visibility: voucher size + housing authority

**Date:** 2026-08-06 (revised through 2026-08-10: four adversarial review rounds, the founder
taxonomy, and Cameron's spec-gate rulings - the agency field, the unit consolidation, the
humanize retirement)
**Status:** at the human spec gate
**Origin:** founder feature request - "Visibility things missing: want to see all tenants by
voucher size and housing authority/voucher program. Some of the eligibility criteria too" -
since widened at the gate into delivering the decided authority/agency data shape on tenants
AND units
**Review:** spec rounds 1-4 (capped); adjudications at
`.superpowers/design-review/adjudications.md`; the gate-ruling sections (agency field, section
8) postdate the capped loop and get one targeted round
**Base:** branch synced with `main` on 2026-08-10 (post quo-airtable-import merge - the import
now writes `contact.housingAuthority`; earlier revisions predate that and are superseded here)

## 1. Problem

The Contacts list can only be searched by name and phone. `ContactsList` renders exactly three
meta chips per row - kind badge, phone, status - so a tenant's voucher size and housing authority
are invisible until you open their file. The founder cannot answer "who are my 2 BR Atlanta
tenants" without opening records one at a time.

## 2. The domain model (founder-decided, 2026-08-09/10)

This section is authoritative for every naming decision below. Recorded in full in
`docs/issues/housing-authority-free-text-drift.md`.

- **Housing authority** - the government organization that issues the voucher, determines rent,
  and pays the landlord. **Every tenant has exactly one.** Porting means moving a voucher from
  one authority to another. "Voucher program" is NOT a separate dimension - that concept
  dissolves into housing authority.
- **Agency** - a helper organization (nonprofits included: Hope Atlanta, HUD VASH, Claratel,
  Step Up are agencies, NOT authorities). Agencies help tenants get or use a voucher. Case
  workers in this app are tied to agencies. A unit is never tied to an agency. A tenant can have
  an authority AND an agency ("HUD VASH and AHA").
- **Units** accept vouchers from one or more authorities - at least one, chosen by the landlord.
  Jurisdiction ("is this unit in authority X's area?") and acceptance ("does this landlord take
  X's vouchers?") are two different QUESTIONS but deliberately ONE stored thing (Cameron,
  2026-08-10): the future unit build tracks only the accepted-authorities list, never a separate
  jurisdiction field beside it. Landlords themselves have no authority.

**What this feature does with that model (Cameron, 2026-08-10 gate rulings).** The feature
DELIVERS the decided data shape on BOTH entities:

- **Tenants** get the two-field shape: `housingAuthority` (the voucher issuer) AND a new
  `agency` field (the helper org they may work with).
- **Units** get the one-field shape: a new `accepted_authorities` string list replaces BOTH
  `unit.jurisdiction` (single string) and `unit.accepted_programs` (the dissolved "program"
  concept - its `HCV` / `Section 8` / `VASH` values are program-type labels from the old
  vocabulary, deliberately NOT folded into the new field). Section 8 specifies the
  consolidation surface-by-surface.

Historical mixed values - agency spellings the importer wrote into `housingAuthority` - are a
DATA-CLEANUP job on the operations side, explicitly not this feature's: the UI does not
disclose, flag, or work around them ("we don't need to build the feature to support out-of-date
data that isn't even production data today"). The facet shows current data as it is. The agency
field here is the FIELD only - editable and visible on the tenant file; an agency facet, the
caseworker-to-agency link, and the extraction-vocabulary split stay with the drift issue. The
build DOES add the taxonomy to `documentation/GLOSSARY.md` (housing authority + agency +
accepted authorities), per the glossary rule.

**The live vocabulary.** The merged import (`app/src/lib/import/apply.ts:327-366`) normalizes
the founder's tenant-side "voucher program" column onto canonical spellings
(`CANONICAL_AUTHORITY` / `KNOWN_AUTHORITIES`) and writes them to `contact.housingAuthority`;
unknown values pass through verbatim with a warning. Its authority-kind spellings are:

`Atlanta (AHA)`, `Jonesboro (JHA)`, `Dekalb County Housing`, `DCA`, `Fulton County`,
`Clayton County`, `East Point`, `McDonough`

It also emits agency-kind values (`HUD VASH`, `Claratel`, `Hope Atlanta`, `Step Up`) and
`Georgia Housing Voucher (GHV)` into the same field - a known model gap (drift issue), truthfully
displayed until the agency split lands. Whether stored `Georgia Housing Voucher (GHV)` values
merge into `DCA` (GHV is DCA's program) is an open data decision in the drift issue - this
feature displays stored values as-is and pre-empts nothing.

Slugs (`atlanta_housing`, `ga_dca`, ...) are dev-seed residue (first commit `01371194`, the M0.3
local-dev fixtures) and exist only in seed worlds. **Display rule: render the stored value
AS-IS, everywhere, with no transformation.** This feature does NOT lift, wrap, or extend
`humanizeAuthority` - by Cameron's gate ruling that helper is display machinery that "really
only works for seeded data" and is to be RETIRED, not spread: seeds get normalized to the
canonical human-readable spellings and the function deleted, filed as
`docs/issues/retire-humanize-authority.md`. Until that lands, seed worlds show raw slugs in the
tenant list (dev-only cosmetics; the properties list keeps its existing humanize behavior
untouched until the retire issue removes it).

## 3. Scope

**In.**

- Facet controls above the Tenants list: voucher size, housing authority, porting.
- Voucher size + housing authority on every tenant row (exact facts).
- Filter state in the URL; per-chip counts.
- A datalist-backed authority input on the contact edit form offering the eight authority-kind
  canonical spellings above (free text still accepted - a new authority is typed and saved
  as-is).
- **The `agency` field on tenants** (the gate ruling's second half): a new optional string on
  the contact - PATCH-allowlisted server-side following the `housingAuthority` block at
  `contacts.ts:520-525` (string accepted, `changedFields` tracked; deliberately NOT added to the
  `PROVENANCE_FIELDS` gate at `:850` - no extraction writes it), plus the dashboard type mirror,
  an edit-form input with a datalist of the four known agencies (`HUD VASH`, `Claratel`,
  `Hope Atlanta`, `Step Up`; free text accepted, same idiom as the authority input), and an
  "Agency" row in the tenant file's Details card. No GSI, no facet, no row chip - the FIELD, not
  a filter. Name-collision sweep: clean (nothing in the repo reads or writes a contact field
  named `agency`).
- **The unit `accepted_authorities` consolidation** (section 8): one list field replaces
  `jurisdiction` + `accepted_programs` across the PATCH allowlist, both unit forms, the
  properties-list facet, the property detail, the public flyer's "Accepts:" line, similar-unit
  matching, the import's unit writer, seeds, and the e2e steps - with read-time synthesis from
  legacy `jurisdiction` so no backfill is needed, and removal of the caller-less
  `?jurisdiction=` API param + repo method.
- The contact authority placeholder drops its slug example for `e.g. Atlanta (AHA)` (an issuer
  name - the field is the voucher issuer). The unit forms' single-authority input is replaced
  wholesale by section 8's list input, so their old placeholders go with it.
- GLOSSARY entries: housing authority, agency, accepted authorities.

**Out, by founder/Cameron decision.** Agency modelling BEYOND the plain contact field (the
entity, the caseworker-to-agency link); the free-text eligibility fields
(`pets`/`evictions`/`tenure` - later filtered-columns view); GHV-into-DCA data decision.

**Out, by build-side judgment.** "Voucher expiring soon" chip (no soon-window policy exists
anywhere - `deadlineRelative` has no threshold; inventing urgency policy does not belong here);
LIF filter (zero records anywhere); grouped-sections rendering; the extraction-vocabulary split
(the vocab mixes both kinds and is missing DeKalb entirely - drift issue); seed SPELLING
normalization and deleting `humanizeAuthority` (`docs/issues/retire-humanize-authority.md` -
filed at the gate on Cameron's ruling; section 8's seed change switches the FIELD, that issue
fixes the VALUES); an agency FACET or row chip (the field ships, the filter does not -
ask-first if she wants it); historical mixed-value cleanup in `housingAuthority`
(operations-side data work, not feature work); tenant-to-unit authority MATCHING (the new unit
field enables it; building it is its own feature). The `byJurisdiction` GSI schema removal IS in
scope (section 8); only the `terraform apply` that realizes it stays an owed post-merge op on
explicit ask.

## 4. Data - one small backend addition

| Field | Shape | Notes |
| --- | --- | --- |
| `contact.voucherSize` | number (bedrooms) | `0` = Studio. PATCH accepts 0..12 |
| `contact.housingAuthority` | string | `byHousingAuthority` GSI hash; canonical spellings post-import. Coverage: in-repo measurements CONFLICT (a 2026-08-06 run measured 17 of 629; the 2026-08-09 table comment says 533 of 666 populated, ~450 one Atlanta spelling). Expected high post-cutover; re-measure at the next import run rather than trusting either number |
| `contact.porting` | boolean | Informational; = voucher moving between authorities |
| `contact.agency` | string, NEW | Optional; the helper org (section 2). PATCH-allowlisted this feature; no GSI, no facet |

The one backend change is the `agency` PATCH allowlist entry (+ `changedFields` tracking,
mirroring `housingAuthority`'s block at `contacts.ts:520-525` - the earlier `:498-502` citation
was stale, that block is `notes` now) and the dashboard type mirror.
**No other API, route, repo, or GSI changes.** The repo stores flexible documents, so no schema
or table work.

`GET /api/contacts` returns whole items (no projection), and `useContacts` already walks every
page of every type (`nextCursor` loop, cap `MAX_PAGES = 40`, warned). Each page is ONE DynamoDB
Query on the `byTypeStatus` GSI - never a Scan. The hook does not pass `?limit=`, so pages
default to 50 while the server caps at `MAX_PAGE_LIMIT = 100` (`contacts.ts:319`): pass
`limit=100` in `getAllContactPages` to halve the round trips (a one-line change, in scope). All
filtering is client-side; counts describe loaded records; a page-cap truncation inherits the
existing console warning.

## 5. Facet controls

Rendered - and APPLIED - only when `filter === 'tenant'`. Facet params present on any other view
are inert: they filter nothing and no control renders. Follows `ListingsList` (chips,
`aria-pressed`, per-facet Clear).

- **Voucher size** - multi-select chips, a FIXED five-bucket set (`Studio`, `1-BR`, `2-BR`,
  `3-BR`, `4+ BR`, labels from `voucherSizeLabel`, `broadcastFormat.ts:35-39`) plus
  `Not recorded`. Fixed, not derived: buckets are a closed enumeration and stable chips scan
  better; an empty bucket is handled by the zero-count rule. `4+ BR` selects every size >= 4;
  membership is `min(voucherSize, 4)`.
- **Housing authority** - multi-select chips, options DERIVED from loaded data (open
  vocabulary). **Facet key = the NORMALIZED stored value**: trim, collapse internal whitespace,
  case-fold, and fold underscores to spaces - so `atlanta_housing`, `Atlanta_Housing`,
  `Atlanta Housing`, and `Atlanta  Housing` (doubled interior space) all group as ONE chip with
  summed counts, and selecting it matches every member value. The chip DISPLAYS the most frequent
  raw member spelling, untransformed (ties broken by sort order, deterministic). Byte-identical
  merging alone is not enough - INTERIOR whitespace, case, and underscore/slug spellings all
  produce variants that would otherwise render indistinguishable duplicate chips with split
  counts (and a Playwright strict-mode collision; `selectors.md` documents that bug class), and
  legacy STORED rows predate any write-side rule. RATIONALE CORRECTED on-branch 2026-08-10: an
  earlier draft justified this with "the PATCH path stores strings untrimmed", which is FALSE -
  `trimJsonBody()` (`app/src/app.ts:100`) has deep-trimmed every inbound JSON string value since
  2026-07-14, so an END-whitespace duplicate is unreachable from the human write path. The rule
  ships unchanged on the four grounds above. The importer also trims/folds on its side
  (`housingAuthorityFor`); this rule is the read-side equivalent, and the edit form additionally
  collapses interior whitespace before PATCHing (section 7).
- **Porting** - single toggle chip. Label and title match the existing placement chip
  (`PlacementRow.tsx:41-45`: text `Porting`, title `Tenant is porting`).

**Presence rules.** `voucherSize` presence is `typeof v === 'number'` - NEVER truthiness
(`ListingsList`'s idiom copied to a number silently drops Studio; a unit test pins `0`).
`porting` presence is `=== true` (`porting: false` is seeded widely; a field-presence test would
render a permanently dead toggle). An authority is recorded when it is a non-empty string.

**Rendering rules.** The two value facets ALWAYS render on the Tenants view once loaded. Each
carries a final `Not recorded (N)` option (sentinel `__none__` in the URL) - without it,
selecting any value silently excludes the unrecorded population, whatever its size (coverage is
genuinely uncertain - section 4). When a facet has ZERO recorded values it renders a muted
explanatory line instead of chips ("No housing authorities recorded yet" / "No voucher sizes
recorded yet") - the promised control must not silently vanish. Porting alone hides unless some
tenant has `porting === true` (a toggle with nothing to match is dead UI).

**Counts - standard faceted-search semantics.** A facet's counts reflect every OTHER active
facet and the search query, but not its own selection: a chip's number always states what
clicking it does. OR within a facet (a second chip ADDS its rows), AND across facets; empty
selection = unconstrained. The OPTION LIST derives once from the full loaded set and never
re-derives as facets change (chips must not vanish mid-interaction; pinned by test). An
unselected chip whose contextual count is 0 renders inert with `(0)`: `aria-disabled="true"` on
an ENABLED button (it stays in the tab order so keyboard/screen-reader users can reach the
explanation), click a no-op, plus a muted `.chipDisabled` visual variant (`ListingsList`'s chips
have no disabled styling to inherit - this is new CSS). The variant must also NEUTRALIZE the
interactive affordances at equal-or-higher specificity - `cursor: default` and a hover reset
(e.g. `.chip.chipDisabled:hover`) - or the base `.chip:hover` rule outranks it and an inert chip
still lights up under the pointer. A selected chip is always clickable (deselection must never
lock).

**Layout.** The control block sits between the filter tabs and the search box, wraps at narrow
width (`flex-wrap`, as `ListingsList.controls`), and follows the search input's
`status !== 'ready'` gating.

**Empty result.** `ContactsList.tsx:187` is unconditional (`No matches for ""` with facets and
an empty query); it gains `ListingsList.tsx:244-248`'s conditional including its precedence
(query message wins when both are active).

## 6. Row layout

**Predicate.** Facts render when `contact.type === 'tenant'` AND `filter !== 'deleted'` -
`filter` is threaded into `Row` (today it receives only `{ contact }`). On `/contacts` (All),
tenant rows DO show facts while controls do not render - stated deliberately.

**Skeleton.** The existing row link keeps its two spans; nothing is removed:

```
WIDE (>560px container):
  [ name ............ ] [ kind | phone | status | facts | Porting ]
    .name (flex 1 1 auto)   .meta (right-aligned; facts is the ONLY shrinkable chip)

NARROW (<=560px container):
  [ name (wraps in full) .......................... ]
  [ kind | phone | status | facts | Porting (wraps) ]
```

- Kind badge, phone, and status stay exactly as today, in order (`ContactsList.test.tsx:86`
  keeps passing).
- **Facts are exact, not bucketed**: `Studio` for 0, else `` `${n} BR` `` - `6 BR`, never
  `4+ BR`. The bucket label belongs to the filter chip (a control); the row is a fact and
  `TenantFile` one click away already says `6 BR`. This deliberately narrows the earlier
  "one label everywhere" call to controls only - flagged for the human at the spec gate.
- Facts and authority join with a middot (U+00B7) with spaces - rendered `3 BR`, middot,
  `Dekalb County Housing` - because a hyphen separator collides with `voucherSizeLabel`'s
  internal hyphen, and the approved mockup used middots. ONE construction form, everywhere
  (source AND tests): `String.fromCharCode(0xB7)` - the SAME construction form the selectors.md
  em-dash row already records - never a literal middot character, and never an HTML entity (an
  entity inside a JS string renders literally as text). The ASCII gate covers new code and test
  lines. The facts are ONE text span
  (one accessible-name token stream; nothing needs `aria-hidden`). Missing values collapse:
  only-size reads `3 BR`; only-authority reads the name alone; neither = no facts span. The
  separator never leads or trails.
- **Wide pane:** five unshrinkable chips would crush the ellipsizing name in the pane band just
  above 560px - the exact failure the container query was written to prevent. The fix has THREE
  required declarations, all scoped to tenant rows (the naive version - a shrinkable facts span
  alone - cannot fire: `.meta` is `flex: 0 0 auto`, so a shrinkable CHILD never receives
  compression, and `flex-shrink` only arbitrates between siblings, so "facts shrink before the
  name" is not expressible across two containers):
  1. `.meta` becomes `flex: 0 1 auto; min-width: 0` - shrinkable, never growing;
  2. the facts span gets `min-width: 0; overflow: hidden; text-overflow: ellipsis;
     white-space: nowrap` - inside `.meta` it is the only compressible child, so ALL of `.meta`'s
     compression lands on it (kind/phone/status keep `flex: 0 0 auto`);
  3. `.name` becomes `flex: 1 0 auto` (grow, NEVER shrink) with `max-width: 55cqw` + its existing
     ellipsis - a shrink factor of any size would make the name co-degrade with the facts from
     the first pixel of deficit (shrink distributes proportionally; a min-width floor bounds how
     FAR it shrinks, not WHEN it starts). With shrink 0 the name cedes nothing until the facts
     span is exhausted, and only a name longer than its own container-relative cap ever
     ellipsizes. The cap (55cqw starting value) is tuned in live QA; below it, the arithmetic is
     guarded by the 560px stack.
  Sacrifice order delivered: facts truncate first and fully; the name gives only past its own
  cap. The facts span carries the full value in `title`.
- **Narrow pane:** the name wraps in full instead of truncating (`ListingsList.module.css:292-299`
  idiom). Density tightens to `var(--sp-2) var(--sp-3)` padding / `var(--sp-1)` row gap -
  **scoped to the tenant ROUTE** (`filter === 'tenant'`), not the row type, so no view ever
  mixes densities (`/contacts` interleaves all three types in one list).
- Porting chip: text `Porting`, title `Tenant is porting`.

**Acceptance criteria - live QA ONLY, never the component test** (jsdom does no layout: no
container queries, no ellipsis, `getBoundingClientRect` returns zeros - a jsdom assertion here
would be vacuously green):

1. 375px viewport: a 32-character name + `Dekalb County Housing` + Porting shows the complete
   name un-ellipsized; row height >= 44px.
2. ~700px content pane (laptop window, expanded sidebar): the same row keeps the name fully
   readable; the facts span truncates first with the full value on `title`.

## 7. Authority + agency inputs on the contact edit form

Replace the bare authority input (`ContactEditForm.tsx:481-488`) with the established datalist
idiom (`CustomFieldsEditor.tsx:62-82`, `KindPicker.tsx:83`), and add the NEW agency input
directly below it in the same idiom:

- Authority `<datalist>`: the eight authority-kind canonical spellings (section 2). Agency-kind
  values are deliberately excluded - they belong to the agency field now.
- Agency `<datalist>`: the four known agencies (`HUD VASH`, `Claratel`, `Hope Atlanta`,
  `Step Up`), placeholder `e.g. Hope Atlanta`, tenant-only like the authority input.
- Free text fully accepted in both; the datalists suggest, never constrain.
- Both inputs TRIM and collapse INTERIOR whitespace before PATCHing (the importer already does
  this on its side via `housingAuthorityFor`). RATIONALE CORRECTED on-branch 2026-08-10: an
  earlier draft said "the human write path currently has no equivalent", which is FALSE for END
  whitespace - `trimJsonBody()` (`app/src/app.ts:100`) already deep-trims every inbound JSON
  string. What the form-side collapse earns is the INTERIOR case (`Atlanta  Housing`), a value
  that matches what section 5's normalized key groups by, and - collapsing BOTH sides before the
  comparison - keeping an effectively-unchanged `housingAuthority` off the wire, which the
  provenance rules require.
- Datalist ids from `useId()` (the module-constant collision is a documented fix at
  `CustomFieldsEditor.tsx:22-24`).
- The `autoComplete="off"` attribute on the current input is DROPPED (whether it suppresses
  `list=` suggestions is browser-dependent; the two precedent datalists set no such attribute).
  Live QA verifies the suggestions actually appear.
- The list is a dashboard-side constant with a source-of-truth comment pointing at
  `app/src/lib/import/apply.ts` `CANONICAL_AUTHORITY` and the drift issue. The mirror has no
  mechanical drift guard (cross-workspace imports are not available to either test suite) -
  accepted and recorded in the drift issue.

## 8. Unit data change: `accepted_authorities` replaces `jurisdiction` + `accepted_programs`

The decided model: a unit accepts vouchers from ONE OR MORE authorities (at least one, chosen by
the landlord), stored as ONE field. `accepted_authorities: string[]` is that field. The single
`jurisdiction` string cannot hold the plural, and `accepted_programs` records the dissolved
"program" concept - its values (`HCV`, `Section 8`, `VASH`) are old-vocabulary program-type
labels, NOT authorities, so they are retired with the field, never folded into the new one.

**Read-time synthesis, no backfill.** `authoritiesOf(unit)` returns `accepted_authorities` when
present, else `[jurisdiction]` when the legacy string exists, else `[]`. One tiny helper on each
side (app lib for the flyer/matching, dashboard for the views - the same hand-mirror pattern as
the vocabulary list, 3 lines each). Every stored legacy unit keeps working; new writes use only
the new field.

**Every surface, enumerated (writers then readers - the invariant rule):**

| Surface | Change |
| --- | --- |
| `unitFields.ts` allowlist (the unit PATCH) | Add `accepted_authorities: 'string[]'`; retire `jurisdiction` and `accepted_programs` as writable. CORRECTION (targeted review): unlike the contact route, the unit parser REJECTS unknown keys with a 400 (`unitFields.ts:130-134`), so a hard removal would fail a stale cached dashboard bundle's save. The two legacy keys become explicit ACCEPT-AND-IGNORE tombstones (parsed, discarded, commented) for the transition; the tombstones die with `retire-humanize-authority` |
| `UnitCreateForm` / `ListingEditForm` | The single "Housing authority" input AND the "Accepted programs" comma input are replaced by ONE "Housing authorities" comma-separated input (the exact idiom `accepted_programs` uses today: split on comma, trim, drop empties), placeholder `e.g. Atlanta (AHA), DCA` |
| Import unit writer (`apply.ts:790-793`) | `jurisdiction = value` becomes `accepted_authorities = [canonical]`, routed through the same `housingAuthorityFor` canonicalizer the contact side uses (the workbook column comes from the founder's authority-named "Voucher Type" data) |
| Seeds (`cast.ts` x5, `lean.ts` x2, `live.ts` x3, `matrix.ts` x7) | `jurisdiction: X` becomes `accepted_authorities: [X]` - FIELD switch only; the slug VALUES are normalized by `retire-humanize-authority`, not here |
| e2e `steps.ts:816-828` (`seedAvailableUnit`) + `:1440-1458` (the create-form step) + the ~14 specs seeding `jurisdiction` | Mechanical follow: the dev seam takes `accepted_authorities`, the form step fills the new list input |
| `GET /api/units?jurisdiction=` + `listByJurisdiction` (`units.ts:400-408`, `unitsRepo.ts:313,545`) | REMOVED - zero PRODUCTION callers (the dashboard never passes it and walks pages client-side; no app-internal caller). Three TEST-SIDE references go with it, enumerated so the typecheck gate does not ambush the builder: `unitsRepo.integration.test.ts:147-149` (deleted), the schema tests' GSI lists, and `twilioWebhookHarness.ts:1402` (the units-repo stub implements the interface - removing the method leaves an excess property that fails `npm run typecheck`) |
| Tests pinning the REMOVED fields (invariant-rule completion) | `publicIntake.test.ts:322-330` asserts the flyer's EXACT key list (carries `accepted_programs` - becomes `accepted_authorities`); `listingFormat.test.ts:70` pins jurisdiction in the area phrase (assertion inverts); `ListingDetail` / `ListingEditForm` / `UnitCreateForm` / `FlyerPage` tests seed or assert the old fields and follow their surfaces |
| The `byJurisdiction` GSI (`tables.ts:109`) | REMOVED from the schema in this feature (Cameron's ruling: DESIGNING an infra change is feature work; only APPLYING it needs the explicit ask). Full reference sweep confirmed dead: the repo method above, two schema tests (`tables.test.ts:150-154`, `genTables.test.ts:181`), one `unitsRepo` integration test, and the GENERATED tfvars (`infra/envs/{dev,prod}/tables.auto.tfvars.json`, written by `gen-tables.ts` from `tables.ts` - regenerate, commit both). OWED POST-MERGE OP: `terraform apply` on dev (and prod at its gate) to drop the index - non-destructive, a GSI is a projection. Stale local lanes keep a harmless extra index; fresh lanes create without it |
| `ListingsList` authority facet | Derives from `authoritiesOf(unit)` - a unit now appears under EACH authority it accepts. Grouping reuses section 5's normalized-key rule |
| `ListingDetail` | The `Jurisdiction` KV and the programs display become one "Housing authorities" row (the synthesized list, joined) |
| `listingFormat.ts:53` (`buildListingFacts`) | `jurisdiction` DROPS out of the address/area phrase - it was an issuer name in an area slot; `unit.area` alone carries the area |
| `toUnitFlyer` (`unitFields.ts:252`) + the PUBLIC flyer "Accepts:" line (`FlyerPage.tsx:253-254`) + `publicApi.ts:36` | The flyer projects `accepted_authorities` (synthesized) instead of `accepted_programs`. USER-VISIBLE on a public page: "Accepts: HCV, VASH" becomes "Accepts: Atlanta (AHA), DCA" - a deliberate improvement (it now answers the tenant's actual question: will this unit take MY voucher). DELIBERATE consequence, stated: on a legacy unit the synthesized list IS the old `jurisdiction` value, so that value becomes public through the new field even though `jurisdiction` itself was never on the flyer allowlist - it is the unit's only authority datum, and hiding it would blank the line for every pre-feature unit. The flyer allowlist-wall test updates consciously |
| `similarUnits.ts:94-120` (the programs-overlap score) | Same overlap logic over `authoritiesOf()` instead of `accepted_programs`. Cameron's ruling: the program list WAS the authority list all along, so this is a rename, not a semantic change. DELIBERATE side effect of synthesis, stated: the score is DORMANT today (no seed writes `accepted_programs`) and becomes live for every unit, since every seeded/imported unit synthesizes at least one authority - similar-unit rankings shift in demo worlds |
| The flyer "Accepts:" line dormancy | Same always-on effect: today the line is hidden for every seeded unit (empty programs); post-feature every unit with an authority shows it on the PUBLIC flyer. Dev/demo flyers show raw slug values until `retire-humanize-authority` normalizes seeds; real units show the founder's spellings |
| One authority, two spellings across import generations | The cutover import (pre-feature `main`) wrote `jurisdiction` as the RAW trimmed cell value; the post-feature import writes canonical spellings. `Atlanta Housing` (raw) and `Atlanta (AHA)` (canonical) do NOT normalize together, so the properties facet can show one authority as two chips until unit values are cleaned - operations-side data cleanup, per the gate ruling, accepted and stated |
| Types (`unitsRepo.ts` `UnitItem` + the dashboard mirror) | Add `accepted_authorities?: string[]`; `jurisdiction` stays typed as a LEGACY read-only field with a comment pointing here |
| `units.ts:5` route doc comment | Drop `jurisdiction=` from the query-param list |

**Stored `accepted_programs` data** (no seeds write it; only hand-entered units carry it) stays
on the documents untouched and simply stops rendering - consistent with the gate ruling that
historical values are operations-side cleanup.

## 9. Components

| Unit | Responsibility |
| --- | --- |
| `tenantFacets` (new, pure) | Options + counts from `Contact[]` + selection; applies selections. Owns bucketing, label-merge, presence, Not-recorded, zero-count rules. No React. |
| `TenantFilters` (new) | Renders the three controls. Props in, callback out. |
| `app/src/routes/contacts.ts` (edited) | The `agency` PATCH allowlist block (mirrors `housingAuthority`'s). |
| `ContactsList` (edited) | URL state; renders `TenantFilters` on the tenant view; threads `filter` into `Row`; facts span; `noMatches` conditional. |
| `ContactEditForm` (edited) | Section 7 input. |
| `TenantFile` (edited) | The "Agency" Details-card row. All existing authority readers stay untouched - values display as stored (section 2's display rule). |

## 10. URL state

Params, absent when unset - **repeated params, not comma-joined** (no CANONICAL value contains
a comma, but passthrough values can - the founder's raw cells demonstrably do, e.g.
`"dca, department of community affairs"` - and `searchParams.getAll` handles both): `voucher`
(bucket keys `0|1|2|3|4plus|__none__`), `ha` (NORMALIZED facet keys per section 5, or
`__none__`), `porting` (presence-only; `?porting=false` is treated as absent).

Bucket keys map through an EXPLICIT two-way table (`0|1|2|3` and `4plus`), on write as well as
read - a writer built as `String(min(v, 4))` emits `"4"`, which the unknown-value rule would
then silently drop, losing the `4+ BR` selection on every reload. Reads are STRING comparison
against the literal key set - never numeric coercion or truthiness, which would drop Studio from
a shared link while every in-memory test stays green (the same falsy-zero class section 5
hardens one layer down). The component round-trip test includes `?voucher=0` AND
`?voucher=4plus`.

- Writes use `{ replace: true }` (matches `FlyerPage.tsx:129`, the only existing writer; Back
  leaves the page rather than walking chip toggles) and MERGE the query string (`?phone=` must
  survive).
- Unknown values drop individually; the rest still filter. A stale link never empties the list.
- **Only the Tenants tab link carries facet params.** Other tabs keep bare paths, and facets
  never apply off the tenant view (section 5) - so a carried param can neither silently filter
  Landlords nor survive as invisible state. Re-clicking the active Tenants tab preserves state
  (the round-1 silent-reset fix, now bounded). Consequence, deliberate and stated: navigating
  Tenants -> Landlords -> Tenants CLEARS the facets - the URL is the only state carrier, and
  leaving the view drops it. Cross-navigation persistence would need session storage, which is
  out of scope.

## 11. Testing and verification

- **Unit** (`tenantFacets`): bucketing incl. `min(v,4)` and Studio=0 pinned; the explicit
  bucket-key table both directions (`4 -> '4plus'`, never `String()`); key normalization (slug +
  typed same label merge; trailing-space variant merges; case variant merges; underscore variant
  `Atlanta_Housing` merges; display spelling = most frequent member); counts vs
  other-facets+query; OR/AND; Not-recorded; zero-recorded empty state per facet; porting
  `=== true`; fixed-five voucher buckets vs derived authority options (each pinned per its own
  rule); unknown URL values; sentinel round-trip; `voucher=0` string-matched (never coerced).
- **Unit** (app, `contacts.ts`): the `agency` PATCH allowlist - string accepted, non-string
  rejected, `changedFields` tracked.
- **Unit** (app, unit side): `unitFields` allowlist accepts `accepted_authorities` and
  TOMBSTONES `jurisdiction`/`accepted_programs` (accepts and discards, per section 8 - and a
  save supplying ONLY tombstoned keys returns a 200 no-op, not the no-updatable-fields 400);
  `authoritiesOf` synthesis (new field wins;
  legacy `jurisdiction` synthesizes to a one-item list; neither yields `[]`); `toUnitFlyer`
  projects the synthesized list; `similarUnits` scores authority overlap incl. a legacy-vs-new
  pair; the import unit writer canonicalizes into the list (`importApply` integration test
  extended).
- **Component** (unit side): both unit forms round-trip the comma-separated authorities input;
  `ListingDetail` renders the "Housing authorities" row from synthesis; `ListingsList`'s facet
  lists a legacy-jurisdiction unit under its synthesized authority; `FlyerPage` renders
  "Accepts:" from the new projection.
- **Component**: controls on Tenants only; facts on tenant rows only (not landlord, not
  deleted); kind/phone/status retained; URL round-trip INCLUDING `?voucher=0`; active-tab
  preservation; other tabs bare; zero-count chips are `aria-disabled` yet focusable; the
  authority datalist renders the eight values and the agency datalist the four, free text still
  PATCHes in both, PATCHed values are trimmed; the tenant file shows the Agency row; `noMatches`
  precedence. Structure/class assertions
  only - layout is live-QA's job. Accessibility-first selectors; add the new controls to
  `e2e/support/selectors.md`, including the middot construction rule
  (`String.fromCharCode(0xB7)` in specs/tests, the same form as the em-dash convention already
  recorded there).
- **e2e**: lean holds ONE tenant, so the spec creates its own tenants via
  `teamCreatesTenant` (`e2e/scenarios/steps.ts:604-651`; `voucherSize`/`housingAuthority`
  supported): apply a facet,
  list narrows, reload, filter survives. New spec file (none exists for the contacts list).
- **Live self-QA** at 375px AND ~700px pane against a hermetic `npm run e2e:session` lane
  (never lane 0 / the live stack), asserting section 6's two criteria plus the datalist
  dropdown. Reseed `?profile=full`; reseeding logs the browser out. Screenshots under
  `.playwright-mcp/`.
- **Gates**, bare, never piped, from the worktree, on a base synced with `main`:
  `npm run typecheck` (required separate gate), `npm test`, `timeout 1500 npm run e2e` (outer
  cap mandatory; warm containers first; e2e ONLY from the worktree). Known flakes re-run before
  blame, both runs reported: `tour-reminders-panel-e2e-flake`,
  `conversationdetail-members-mock-suite-flake`.

## 12. Open questions for the founder

1. ~~Voucher program vs housing authority~~ **RESOLVED 2026-08-10** (section 2). Remaining data
   decision, not blocking: do stored `Georgia Housing Voucher (GHV)` values merge into `DCA`?
2. **Which eligibility criteria** she actually sorts by (drives the deferred filtered-columns
   view; if pets, a derived has-pets toggle beats surfacing free text).
