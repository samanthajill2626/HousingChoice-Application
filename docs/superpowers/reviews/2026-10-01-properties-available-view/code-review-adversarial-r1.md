# Code review r1 - adversarial, plan-blind - feat/properties-available-view

Reviewer: adversarial plan-blind reviewer (Claude Opus 5.5), 2026-10-01.
Scope: main...HEAD at ddeb6b58 (the r1 plan-blind diff package; design docs not read).
Versions read: react / react-dom 19.2.7, react-router / react-router-dom 7.18.0.
Method: code reading plus throwaway vitest probes (now deleted). The probe sources
and the mutation recipe are kept, byte-exact, in
`.superpowers/sdd/adversarial-reference.md`. Anything not proven by a probe or by
code reading is marked UNVERIFIED.

Severity = consequence if it ships unfixed. 13 findings: 0 BLOCKING, 0 HIGH,
4 MEDIUM, 9 LOW.

---

## F1. MEDIUM - Every search keystroke writes browser history; Safari's History API cap turns that into dead filters and full-page reloads

**What is wrong.** The search box's onChange calls `update()` on every keystroke
(`dashboard/src/routes/listings/ListingsList.tsx:290-293`). `update()` is
`setSearchParams(params, { replace: true })` (`ListingsList.tsx:185-189`), so every
keystroke is one `history.replaceState`, with no throttle or debounce. This is new
on this branch. Before it, the search was local state only, and the Tenants list
still keeps it that way (`dashboard/src/routes/contacts/ContactsList.tsx:146,277`).

- **The cap.** WebKit caps pushState/replaceState. Current Safari allows 100 calls
  per 10 s (older builds allowed 100 per 30 s). Past the cap it throws
  `SecurityError`.
- **replace has no try/catch.** In react-router 7.18, `replace` does not guard
  `replaceState` (`node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:322-333`).
  The exception escapes the event handler before the router's listener runs.
- **push falls back to a full page load.** `push` catches any error that is not a
  DataCloneError and falls back to `window.location.assign(url)`
  (`chunk-4ZMWKKQ3.mjs:303-320`).
- **Every filter control depends on the URL write.** The status dropdown, both chip
  groups and both Clears act only through the URL (`ListingsList.tsx:252, 267, 275`).
  Once the cap is spent, they do nothing.

**Evidence (probe).** BrowserRouter in jsdom:
- Typing `Peachtree` made exactly 9 `replaceState` calls.
- With `replaceState` made to throw a `SecurityError`, clicking the 2-BR chip left
  it unpressed and the URL unchanged.
- React 19 reported the error as an uncaught window `error` event.

**Failure scenario.** Sam is on Safari. The build targets iOS Safari
(`dashboard/vite.config.ts:127`).
1. She types an address, holds Backspace to clear it, and types another. Auto-repeat
   fires one onChange per character, so one `replaceState` per character.
2. She can pass 100 writes within about 10 s.
3. Chip and status taps now do nothing, each with an uncaught SecurityError.
4. Typed text stops reaching the URL, so the box and the URL disagree until a later
   write succeeds.
5. Any summary count, tab or row link (all PUSH) reloads the whole SPA through
   `location.assign`. This lasts until the window passes, and it affects every page
   of the app, not just this one.

**Suggested fix.**
- Keep `q` local while typing. Persist it to the URL throttled or trailing-debounced
  (about 300 ms), or on idle/blur.
- Skip a write when the serialized search equals `location.search`.
- Optionally wrap URL writes so a `SecurityError` degrades to "not persisted" instead
  of an uncaught exception.

Sources for the WebKit cap:
- https://github.com/react-navigation/react-navigation/issues/11086
- https://github.com/backstage/backstage/issues/34941
- https://github.com/backstage/backstage/pull/34942
- https://github.com/mdn/content/issues/35504

---

## F2. MEDIUM - The voucher filter silently drops every property without `voucher_size_accepted` from the list AND from the by-authority counts

**What is wrong.** Four pieces combine:
- `voucherSizesOf` reads `voucher_size_accepted` only, never `beds`
  (`dashboard/src/routes/listing/listingFormat.ts:71-87`).
- A unit with no usable size matches only the Not recorded chip
  (`dashboard/src/routes/listings/propertyFacets.ts:181-189`).
- The summary's counts follow the voucher selection (`propertyFacets.ts:242-266`;
  `ListingsList.tsx:178-181`).
- The property chips have no counts and no "nothing recorded" state, unlike the
  Tenants facet (`ListingsList.tsx:46-50, 262-268`; `e2e/support/selectors.md:116`:
  "NO counts in these chip names (unlike the tenant facets)"). The summary also has
  no line saying how many properties a size filter excluded for lacking a size.

On real data the field is mostly absent:
- **Imports.** The importer writes only address, beds, baths, accepted_authorities,
  notes, landlordId and imported_landlord_name
  (`app/src/lib/import/apply.ts:1316-1380`). Its comment at 1318-1322 records 65
  imported units.
- **Lean seed.** Its units have none (`app/src/lib/seed/lean.ts:204-252`).
- **Setup properties.** Setup is the incomplete-intake state, and its canonical
  example lacks the size (`app/src/lib/seed/cast.ts:1214, 1225`). So the Coming soon
  column is hit hardest.

**Evidence (probe).** Three imported-shape units (beds 2, DCA, no voucher size; two
Available, one Setup):
- The All row reads `[2, 1]`.
- After clicking 2-BR it reads `[0, 0]`, and every authority row disappears.
- Nothing on the page says three properties were excluded.

**Failure scenario.** A tenant with a 2-BR voucher calls, and Sam clicks 2-BR to see
how many 2-BR properties DCA has available now. The summary says DCA has 1 available
and 0 coming soon: the one property someone typed a voucher size into. Ten 2-bed DCA
properties with no recorded size are not counted. The numbers look authoritative and
are wrong.

**Suggested fix.**
- Show contextual counts on the voucher chips, including `Not recorded (N)`, as the
  Tenants facet does.
- Under an active voucher filter, add a summary note such as "N properties have no
  voucher size recorded" (or a Not recorded column).
- At minimum, do not let the summary follow the voucher filter until the field is
  populated.

This keeps the explicit no-beds-fallback rule and makes the exclusion visible.

---

## F3. MEDIUM - "Which voucher size fits this property" now has two rules (and two value shapes) across the app

**What is wrong.** The new filter sets two rules:
- No fallback to beds: "bedrooms are not a voucher size" (`listingFormat.ts:76-77`).
- List-shaped values count (`listingFormat.ts:71-87`). The test comment at
  `dashboard/src/routes/listing/listingFormat.test.ts:159-161` says "every reader must
  take both shapes".

Existing readers break one rule or the other:
- **Matching composer.** It pre-fills the tenant audience's voucher size from the
  property's beds (`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:219-226`).
  It labels that chip "- matches property" and shows "Pre-filled to match this
  N-bedroom property" (`dashboard/src/routes/broadcasts/AudienceFilters.tsx:9-11,
  63-64, 91, 98`).
- **Public flyer.** It tells tenants "Fits a N-bedroom voucher", computed from beds
  (`app/src/lib/unitFields.ts:294-306`; `dashboard/src/routes/public/FlyerPage.tsx:265-267`).
- **Property page.** It shows "Voucher size accepted" only when the value is a number
  (`dashboard/src/routes/listing/ListingDetail.tsx:752-754`).
- **Edit form.** It reads a list as `''`
  (`dashboard/src/routes/listing/ListingEditForm.tsx:30-32, 68`), so saving
  a typed size overwrites a stored list.

**Failure scenario.** Take a property with beds 3 and `voucher_size_accepted` 2, the
case the rule exists for.
1. Properties lists it under 2-BR only.
2. Sam opens it and clicks Send to tenants.
3. The composer pre-fills 3-BR voucher holders and labels 3-BR "matches property".
4. The flyer tells those tenants it fits a 3-bedroom voucher.

The full demo seed shows the shape split too. Its managed unit has beds 3 and
`voucher_size_accepted` [2, 3] (`cast.ts:1350-1359`). The list files it under 2-BR
and 3-BR, but its own property page shows no voucher size at all.

**Suggested fix.**
- Use one shared reader for "voucher sizes this property fits" (`voucherSizesOf`) in
  the composer pre-fill and tag and on the property page and edit form.
- Record a decision for the server's flyer projection.
- Until then, file the divergence in `docs/issues/` rather than leave the surfaces
  disagreeing silently.

---

## F4. MEDIUM - The Available default breaks two perf-harness contracts that this branch touched but did not update

**What is wrong.**

(a) **The /listings terminal no longer covers the default view.**
- `unitListTerminal(false)` recognizes only list `Properties` (populated) and text
  `No properties yet` (empty) (`e2e/performance/routes.ts:399-401`).
- A world with properties but no Available one now renders "No properties match the
  selected filters." on the default view (`ListingsList.tsx:322-330`). That matches
  neither.
- `terminalStateFor` then answers `unknown` (`e2e/performance/cli.ts:483-507`), and
  the sample fails as `ready_timeout`.
- This is the misattributed-timeout class that the inboxTerminal comment warns about
  (`routes.ts:415-424`).
- The branch changed only the citation lines (`routes.ts:766-767`).

(b) **The Property-detail warm sample will usually find no link.**
- Its source is the bare `/listings` page (`routes.ts:634`).
- Its resolver binds the first non-deleted unit of an unfiltered Scan, whatever its
  status (`routes.ts:1090-1103`). GET /api/units with no filter is a Scan
  (`app/src/routes/units.ts:384-428`).
- The warm DOM check waits for `a[href="/listings/<id>"]` (`cli.ts:1367-1377`).
  Otherwise it returns `fixture_not_navigable` (`routes.ts:1030-1038`), which
  `compare.ts:129-135` reports as skipped.
- The default list no longer renders non-Available rows. The perf seed cycles
  statuses, so only units with `index % 7 == 1` are Available
  (`app/src/lib/seed/performance.ts:590, 606`).

**Failure scenario.**
- `npm run perf:pages -- hosted-dev` or `-- local` on a dataset with no Available
  property: `/listings` fails as `ready_timeout`.
- On the hermetic seed: whenever the first Scan unit is not Available (most
  non-deleted perf units are not), every warm Property-detail sample is skipped after
  burning `sourceTimeoutMs`.
- UNVERIFIED which unit the hermetic Scan returns first. That needs DynamoDB Local,
  which was not run per the charter.

**Suggested fix.**
- Add the no-match copy (or the default-aware copy from F7) as a terminal
  alternative for `/listings`.
- Make `resolveUnitDetail` prefer an Available unit (`GET /api/units?status=available`),
  or source the warm sample from `/listings?status=all`.

---

## F5. LOW - Interactions that land before the previous navigation's transition commits are dropped or garbled

**What is wrong.**
- BrowserRouter applies every location update inside `React.startTransition`
  (`chunk-4ZMWKKQ3.mjs:10391-10414`). MemoryRouter does the same (`6951-6990`).
- Every handler builds the next URL from the last committed `searchParams` and
  `selection`: `update()` (`ListingsList.tsx:185-189`, fed by the memo at 172-175) and
  `countLink()` (193-198).
- A Link whose target equals the committed location is forced to REPLACE
  (`chunk-4ZMWKKQ3.mjs:10796`).
- The functional form of `setSearchParams` would not help. Its updater receives the
  same closure `searchParams` (`chunk-4ZMWKKQ3.mjs:10850-10858`).
- The header comment's guarantee (`ListingsList.tsx:152-158`) covers only the typed
  text.

**Evidence (probe).** Each case fires two events inside one `act()`, so the second
lands before the first transition commits. The control, with separate acts, keeps
both.
- **2-BR then 3-BR.** The URL ends `?status=all&voucher=3`. 2-BR is lost.
- **2-BR then keystroke `A`.** The URL ends `?status=all&q=A`. 2-BR is lost.
- **Count "Show 1 coming soon property for DCA", then a keystroke.**
  - The drill-down is lost: status is back to Available and DCA is unpressed.
  - The keystroke's REPLACE overwrote the history entry the count had pushed, so Back
    skips to the pre-count entry.
- **Keystroke `Two`, then "Show 2 available properties for all authorities", on a
  bare `/listings`.**
  - The count resolves to the committed URL, so it is a REPLACE to `/listings`.
  - The sync skips REPLACE navigations (`ListingsList.tsx:164`), so the box and rows
    keep filtering by `Two` while the URL has no `q`.
  - This breaks the count's promise to clear the search (`propertyFacets.ts:280-296`),
    and the list shows fewer rows than the count said.

**Failure scenario.** On a slow phone with a few hundred rows, every location change
re-renders every row Link. A quick second tap or immediate typing lands inside that
window. The tap silently does nothing, or the drill-down shows a different number of
rows than its count. Outcomes are visible and recoverable, hence LOW, but the window
grows with list size and device speed.

**Suggested fix.**
- Build the next URL from the latest written state: a ref updated synchronously on
  each write, or `window.location.search` read at event time.
- Adopt the URL `q` whenever it differs from what this component last wrote, instead
  of skipping every REPLACE (see F6).

---

## F6. LOW - The REPLACE guard in the URL-to-box sync is unpinned, buys nothing for typing, and keeps stale text alive

**What is wrong.** The only branch protecting the typed text is
`navigationType !== 'REPLACE'` (`ListingsList.tsx:162-165`).
- **No test pins it.** A mutation probe removed it, adopting the URL `q` on every
  location change. All 31 ListingsList tests stayed green. The comment says the guard
  stops dropped characters (`ListingsList.tsx:152-158`); no test covers that.
- **It does not do that job.** Each keystroke's urgent `setQuery` interrupts any
  in-flight transition render. React then renders all pending transition lanes
  together (`node_modules/react-dom/cjs/react-dom-client.development.js:976-1006`,
  where `getHighestPriorityLanes` returns `lanes & 261888`). So the committed
  location after a typing burst always carries the latest keystroke's `q`.
- **It causes the F5 stale-text case.** On the same mutant, the stale-text
  interleaving from F5 resolves consistently: the box is empty and matches the URL.
- **Typing-as-REPLACE is unpinned too.** "Back from a property page returns to the
  same filtered view" passes whether typing pushes or replaces. No test asserts that
  Back after typing leaves the page.

**Failure scenario.** A later simplification of the sync breaks nothing visible in
tests. If the guard stays, the F5 disagreement stays reachable.

**Suggested fix.**
- Decide what the guard is for. Either drop it (adopt whenever the URL `q` differs
  from the last value this component wrote), or pin it with a test that drives a
  lagging transition.
- Add a test that Back after typing leaves `/listings`.

---

## F7. LOW - The default view says no properties match "the selected filters" when the user selected nothing

**What is wrong.** With properties loaded but none Available, the Active tab opens on
"No properties match the selected filters." (`ListingsList.tsx:322-330`). The only
filter in play is the default status, which the user never chose. The lean e2e world
reproduces it (`lean.ts:220` under_application, `lean.ts:242` occupied), with an All
0/0 summary.

**Evidence (probe).** Lean-shaped units:
- no Properties list and no "No properties yet";
- the "selected filters" sentence;
- summary All `[0, 0]`.

**Failure scenario.** A new environment, or a quiet week with nothing Available.
Staff open Properties and are told that filters they never set exclude everything.

**Suggested fix.** When the only active constraint is the default status, say so ("No
available properties right now - change the status filter to see the rest") and
offer one-click All statuses.

---

## F8. LOW - Raw stored spellings make long slug chips unbreakable; the chips lack the wrap rule the summary got

**What is wrong.**
- **The old wrap points are gone.** The deleted `humanizeAuthority` split slugs on
  `[_\s]+` and rejoined them with spaces, which gave them wrap points. Chips now render
  the stored spelling unchanged (`propertyFacets.ts:131-150`).
- **The chip CSS cannot wrap it.**
  - `.chip` has no overflow-wrap (`ListingsList.module.css:118-127`).
  - `.control` is a column flex item with the default `min-width: auto` (`80-84`),
    inside a wrapping row (`72-78`). So its min-content is the longest chip.
- **The summary already handles this.** It uses `overflow-wrap: anywhere`, with a
  comment naming "one long unbroken token" (`PropertySummary.module.css:54-60`). The
  chips have no such rule.
- **The e2e check cannot see it.** The new 360 px check uses spaced names.

**Failure scenario.** A property stored with `housing_authority_of_the_city_of_atlanta`
(or any long value with no spaces) pushes the Housing authority group wider than a
360 px pane. Phones get horizontal page scroll. UNVERIFIED: jsdom has no layout.

**Suggested fix.** Add `overflow-wrap: anywhere` to `.chip`, matching the summary,
and add a long-slug authority to the e2e 360 px check.

---

## F9. LOW - Summary table: contrast below AA, color-only link cue, square-corner artifact, Clear drops focus

**What is wrong.**
- **Contrast below AA.** Every case below is under the 4.5:1 AA minimum for 13 px
  text (`tokens.css:53`).
  - Zero counts use `--c-text-subtle` #8a93a3 (`PropertySummary.module.css:95-97`,
    `tokens.css:16`). That is about 3.1:1 on white.
  - On the All row's `--c-surface-2` background (#f1f3f6;
    `PropertySummary.module.css:73-77`, `tokens.css:10`) it is about 2.8:1.
  - The All row's count links are `--c-brand` #1f6feb (`tokens.css:20`), 13 px
    semibold, on that same background: about 4.2:1.
- **Color-only link cue.** Linked counts differ from plain counts only by color and
  weight. There is no underline until hover (`PropertySummary.module.css:79-87`).
- **Square corners.** Sometimes the All row is the last row: no authority rows, as in
  the lean world or under a voucher filter that matches nothing (the F2 and F7
  probes). Its cell backgrounds then paint square corners over the table's rounded
  border, because the table uses separate borders and a radius with no clipping
  (`PropertySummary.module.css:13-22`). UNVERIFIED visually.
- **Focus loss.** Activating either Clear unmounts the focused button
  (`ListingsList.tsx:115-124`), dropping keyboard focus to body.

**Suggested fix.**
- Use `--c-text-muted` for zeros.
- Give count links a non-color cue, such as an underline.
- Clip the table (`overflow: hidden`) or round the corner cells.
- After Clear, move focus to the group's first chip.

---

## F10. LOW - Stale or inaccurate references left behind

- `dashboard/src/routes/contacts/tenantFacets.ts:197-200` says
  `routes/listings/ListingsList.tsx` tallies raw spellings and asks `displaySpelling`
  for the label. That code now lives in `propertyFacets.ts:131-150`.
- `docs/issues/housing-authority-free-text-drift.md` is still open, and still
  describes `humanizeAuthority` as live code at `ListingsList.tsx:36-42`, listing its
  corruption as a current consequence (lines 48, 62, 85, 97). The branch updated
  `retire-humanize-authority.md` but not this issue.
- `e2e/support/selectors.md:117` says "A count click is a PUSH (Back undoes it)". A
  count whose target equals the current URL is a REPLACE
  (`chunk-4ZMWKKQ3.mjs:10796`), so Back then leaves the page.
- `ListingsList.tsx:156-158` lists "a summary count (PUSH or POP)" among the
  navigations that adopt the URL `q`. A same-URL count is a REPLACE and is not
  adopted; that is the F5 disagreement.

**Suggested fix.** Update the four references.

---

## F11. LOW - The chip UI is restated, and the two facet lists already behave differently despite the "cannot drift" claim

**What is wrong.** `propertyFacets.ts:6-9` says every Tenants rule is reused "so the
two lists cannot drift apart". But ListingsList restates three things:
- `toggled()`: `ListingsList.tsx:52-57` vs `TenantFilters.tsx:22-27`.
- The ChipGroup markup: `ListingsList.tsx:79-128` vs `TenantFilters.tsx:29-87`, with
  fixed ids instead of `useId`.
- The "Not recorded" copy: `ListingsList.tsx:43-44` vs `tenantFacets.ts:13-14`, which
  is not exported.

The behavior already diverges. Tenants chips show live counts, make zero-count chips
inert, and replace an all-unrecorded facet with a muted line. Properties chips do none
of that, which is the root of F2.

**Suggested fix.** Extract one shared ChipGroup/Chip (counts optional) and export the
Not recorded label from tenantFacets, or reword the claim.

---

## F12. LOW - New code names the unit entity "property", a word code already uses for the parent group

**What is wrong.** `documentation/GLOSSARY.md` (the unit/home/property table) blesses
`unit` for code and data, and reserves a separate word for any future parent layer.
This branch adds:
- `propertyFacets.ts`;
- `PropertySelection` and `PropertyView` (`propertyFacets.ts:21-25, 42`);
- `applyPropertyFilters`, `parsePropertySelection` and `applyPropertySelection`;
- `PropertySummary`.

Code already uses "property" for the parent building group: `propertyId` and the
`byProperty` GSI (`app/src/lib/unitFields.ts:105-110`). The same word now names two
entities in code.

**Suggested fix.** Use unit-based names for code identifiers (`unitFacets`,
`UnitListSelection`, `UnitListView`, ...) and keep "property" for staff-facing copy.

---

## F13. LOW - Stored authority text can collide with the page's own sentinel labels

**What is wrong.** Authorities are free text, and they share a namespace with the
page's built-in labels:
- The Not recorded chip is appended to the stored labels under the same visible name
  (`ListingsList.tsx:201-203`).
- The summary's "All authorities" row header (`PropertySummary.tsx:68-70`) and "No
  authority recorded" row header (`propertyFacets.ts:33`) share the namespace with
  stored names.

**Evidence (probe).** An authority stored as "Not recorded", plus a unit with no
authority, renders two buttons named "Not recorded" in the Housing authority group.

**Failure scenario.** Two chips or rows that look identical but mean different things.
Any Playwright spec that selects them by name hits a strict-mode collision.

**Suggested fix.** Give the sentinel a distinct presentation (for example
"(none recorded)", styled differently, or an aria-description), or suffix stored
labels that collide.
