# Code review round 1 - adjudications

Branch `feat/properties-available-view` at ddeb6b58. Reviewers (both `model: opus`):
adversarial plan-blind (`code-review-adversarial-r1.md`, A1-A13) and spec-conformance
(`code-review-conformance-r1.md`, C1-C6; 48/53 design items delivered, the rest
wording, process, or the two deliberate deviations). Adjudicated by the planner,
2026-10-02. ACCEPT = fixed in the fix wave; DEFER = filed; REJECT = reason given.

Claims checked in the code before ruling: the perf resolver and `bindResolved`
exact-link check (`e2e/performance/routes.ts:1030-1038,1090-1103`); the terminal
helper's alternatives (`routes.ts:167-205`); BrowserRouter's transition wrapping
(`node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:10391-10414`);
no `Property*` code identifiers existed in the dashboard before this branch, and
`propertyId` already names the parent group (`app/src/lib/unitFields.ts:105-110`);
no app code writes the string "Not recorded" (`app/src` grep empty); tokens
`--c-text-muted` #5b6472, `--c-text-subtle` #8a93a3, `--c-brand` #1f6feb,
`--c-surface-2` #f1f3f6 (`dashboard/src/ui/tokens.css:10-22`).

## Decisions that changed

The fix wave changes how the list holds its filter state, so this round CHANGED
decisions and a re-review round follows:

- Filter state (status, authorities, voucher sizes, search) is now LOCAL component
  state, updated urgently, and the URL is its persistence. Chips and the dropdown
  write the URL at once (replace); the search box writes it on BLUR (and with any
  other filter write), never per keystroke. The URL is adopted into local state on
  mount and on every non-REPLACE navigation (Back/Forward, tab switch, a summary
  count, a nav link). A summary count also applies its selection locally on a
  plain left click, so a same-URL count (which the router turns into a REPLACE)
  still clears the search. Design note 3.2 / 3.3 / watch item 6 amended.
- New copy: the default view with nothing Available says "No available properties
  right now." with a "Show all statuses" button; under a voucher filter that leaves
  out Not recorded, the summary says how many available or coming-soon properties
  have no voucher size and are not counted.
- Code identifiers say `unit`, per the glossary: `propertyFacets` ->
  `unitListFacets`, `PropertySummary` -> `AuthoritySummary`, and the Property*
  types/functions follow. Staff-facing copy still says "property".

## Adversarial (plan-blind)

| # | Sev | Finding | Ruling |
|---|---|---|---|
| A1 | MED | Every search keystroke writes history; Safari's replaceState cap (100 per 10 s) then throws and kills URL-driven filters | ACCEPT. Search persists to the URL on blur and with other filter writes; a write is skipped when the serialized query is unchanged. |
| A2 | MED | The voucher filter silently drops unrecorded properties from the list AND the summary | ACCEPT IN PART. The summary now states how many available/coming-soon properties have no voucher size and are not counted whenever a voucher filter excludes Not recorded. REJECT chip counts (Cameron approved "no counts on the chips; the summary has them", C5) and REJECT un-following the voucher filter (Cameron approved C3). The list itself is a filter the user chose; the Not recorded chip sits beside the size chips. |
| A3 | MED | Voucher size has two rules across the app (composer pre-fill and flyer use beds; property page and edit form read one number; the edit form would overwrite a stored list) | DEFER: filed `docs/issues/unit-voucher-size-readers-diverge.md`. Those surfaces are out of scope by design (section 4: #12 owns the write path and display; #6 owns the Matching audience rules). The no-beds rule is Cameron's decision for this filter. |
| A4 | MED | Perf: (a) the `/listings` terminal lacks the new empty state; (b) the unit-detail resolver may pick a unit the default list does not show | ACCEPT both. (a) the terminal gains "No available properties right now."; (b) `resolveUnitDetail` binds an Available unit, with a test. |
| A5 | LOW | A second tap or keystroke before the router's transition commits drops the first | ACCEPT. Local urgent state removes the window: every handler reads the latest committed local state (discrete events flush synchronously). |
| A6 | LOW | The REPLACE guard in the URL-to-box sync is unpinned and keeps stale text alive | ACCEPT IN PART. Pinned: typing never pushes history (Back after typing leaves the page) and a same-URL count click clears the search. The guard's remaining job - ignoring a stale REPLACE commit of the component's OWN earlier write - needs a transition that lags past a newer event, which act() cannot produce in jsdom; documented in code, not pinned. |
| A7 | LOW | The default view says "No properties match the selected filters" when the user selected nothing | ACCEPT (copy + one-click "Show all statuses"). |
| A8 | LOW | Long raw slugs make authority chips unbreakable at 360px | ACCEPT. Chips wrap anywhere and the control column can shrink; the e2e 360px check adds a long unbroken authority. |
| A9 | LOW | Zero counts and All-row links under AA contrast; color-only link cue; square corners; Clear drops focus | ACCEPT. Zeros use `--c-text-muted`; count links are underlined; the All row drops its tinted background (fixes the 4.2:1 link contrast and the corner artifact); Clear moves focus to the group's first chip. |
| A10 | LOW | Stale references (tenantFacets docblock, drift issue, selectors.md PUSH claim, sync comment) | ACCEPT all four. |
| A11 | LOW | Chip UI restated from TenantFilters; "cannot drift apart" overclaims | ACCEPT IN PART: `NONE_LABEL` is exported and reused, and the claim now covers the shared RULES only. REJECT extracting a shared ChipGroup: it rewrites the shipped Tenants filters for no user-visible gain in #1. |
| A12 | LOW | New code names the unit entity "property", which code already uses for the parent group (`propertyId`) | ACCEPT: unit-based identifiers. |
| A13 | LOW | A stored authority named "Not recorded" / "All authorities" collides with the page's own labels | REJECT. No code path writes those strings; only a staff member typing one could, the shipped Tenants facet has the same property, and #2's master name list makes such a name a "new name" prompt. |

## Conformance

| # | Sev | Finding | Ruling |
|---|---|---|---|
| C1 | MED | Perf unit-detail warm sample likely skips `fixture_not_navigable` | ACCEPT (= A4b). |
| C2 | LOW | Deviation: a summary count pushes history | ACCEPT the deviation; design 3.2 and plan Task 3 amended (now with the local-state model). |
| C3 | LOW | Deviation: the search box keeps its own text | ACCEPT; design 3.3 and watch item 6 amended. |
| C4 | LOW | 3.1 says "a non-finite size has no bucket"; the shared rule buckets +/-Infinity | ACCEPT: note reworded; the rule is unchanged (it would alter the Tenants facet). |
| C5 | LOW | Delivered behaviors no test pins | ACCEPT items 1-6 as tests: URL not rewritten on load and a stale key dropped on the next write; the summary ignores the search; chips, dropdown and search replace history; the dropdown and badge still read "Setup"; the "Housing authority" header and a 0/0 All row with no links; the Deleted subtitle; the summary above the controls. The e2e default step now asserts the Setup property is hidden. The Deleted-tab "All statuses" assertion stays out of e2e: its controls render only when a deleted unit exists. |
| C6 | LOW | Stale references; record the "Coming soon (Setup)" label | ACCEPT (= A10), plus a GLOSSARY label note. |
