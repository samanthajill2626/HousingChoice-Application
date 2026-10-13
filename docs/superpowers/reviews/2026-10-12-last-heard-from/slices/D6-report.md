# D6 - S4 Tasks 4.1-4.6: decisions record

Dispatch D6 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: the shared dashboard `heardFrom` helpers, the Tenants tab's Status
facet, sort and row line, the contact header's "Last heard from" span, and
the perf harness rebind. Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md`
(S4 Tasks 4.1-4.6, sections 3.3 and 3.4 #9/#10). Binding correction
applied: tenants-F2 (4.6). Contract N1 (plan 3.4 #9) held on both surfaces.

## Commits

- bac543cc Task 4.1 - `dashboard/src/lib/heardFrom.ts` (`NameLike` :19,
  `HeardFromLabel` :27, `formatHeardFrom` :48, `compareByName` :65,
  `sortByHeardFrom` :76, `daysSince` :92) + `heardFrom.test.ts`.
- a7f28329 Task 4.2 - status facet and sort param in
  `dashboard/src/routes/contacts/tenantFacets.ts` (`STATUS_EMPTY_KEY` :60,
  `ALL_STATUS_SET` :66, `DEFAULT_STATUS_SET` :70, `TenantSort` :75,
  `TenantSelection.status` :85, `TenantFacetModel.status` :115,
  `parseStatus` :179, `applyToParams` :224, `parseSort` :239,
  `applySortToParams` :244, `matchesStatus` :270, `hiddenByStatusOnly` :277,
  the status options :385); every TenantSelection construction site updated.
- 28cd6c9e Task 4.3 - `ChipGroup` `baseline`
  (`dashboard/src/routes/contacts/FilterChips.tsx:36`, rule documented
  :44-49); Status group (`TenantFilters.tsx:61`, toggle helper :44);
  hidden-match hint (`ContactsList.tsx:285`, button :394); `.showAll`
  (`ContactsList.module.css:356`).
- ecbaf966 Task 4.4 - Sort by select (`TenantFilters.tsx:107-116`,
  `.select` in `TenantFilters.module.css:102`); sorted `visible` memo
  (`ContactsList.tsx:264-273`), `updateSort` :299, list clock :213; row
  line (`ContactsList.tsx:186`, `.heardFrom` in `ContactsList.module.css:253`);
  dated paragraph in `docs/issues/tenant-row-longname-midpane-overflow.md:60`.
- 2be47b32 Task 4.5 - header span (`dashboard/src/routes/contact/ContactDetail.tsx:995`,
  component :1613; `.heardFrom` in `ContactDetail.module.css:102`).
- 17b1f2d8 Task 4.6 - `resolveContactDetail` skips inactive/placed
  (`e2e/performance/routes.ts:1130`, :1139); tenants-F2 in
  `contactListTerminal` (`routes.ts:402`); ledger citation (`routes.ts:812`);
  tests `e2e/performance/routes.test.ts:707` and the describe at :897.

`npm run typecheck` exited 0 after every commit.

## RED / GREEN evidence

- 4.1 RED: import resolution failure (module absent). GREEN 14/14.
- 4.2 RED: 9 failed (new exports undefined; parseSelection carried no
  status; buildFacets carried no status options). GREEN: tenantFacets +
  TenantFilters + ContactsList 94/94; contacts/ + listings/ 213/213.
- 4.3 RED: 8 failed (Clear shown at the baseline; 3 groups not 4; no Status
  group; no hint). Three new ContactsList cases were already green after
  4.2 and are kept as pins. GREEN: routes/contacts/ 132/132.
- 4.4 RED: 5 failed (no "Sort by"; fixture order; no row line). Two new
  cases are pins. GREEN: routes/contacts/ 139/139.
- 4.5 RED: 1 failed (no header text). GREEN: ContactDetail.test.tsx 129/129.
- 4.6 RED: 2 failed (resolver skipped as fixture_not_navigable; Tenants
  terminal had one empty state). GREEN: e2e performance/ 476/476.
- Final dashboard run over every affected test file: 14 files, 398/398.

## Decisions and divergences (all contract-preserving)

1. Site count (4.2): 19 TenantSelection construction sites edited (12 in
   tenantFacets.test.ts, 4 in TenantFilters.test.tsx, 3 in source). The
   build worklist's "20" header over-counts by one; a grep confirmed none
   was missed and typecheck is green.
2. Header comment (4.1): the plan's note that tourTime.ts already shares
   inboxTime is false (tenants-F5); the module comment records instead that
   this is the first lib-to-routes runtime import.
3. Stale-count comment fix (4.3): the ChipGroup doc said "all three" groups;
   a fourth exists now.
4. Test typing (4.3): `tenantRowNames` annotates its map parameter as
   HTMLElement; tsc reported an implicit any on the plan's text because the
   `rowsOf` helper returns loosely typed queries.
5. Comment citation (4.4): the Sort by select cites the Properties list's
   Status select by name, not by a line range that would rot.
6. Header CSS comment (4.5): the plan's comment claimed the span stays whole
   while the facts text ellipsizes. An inline span inside the nowrap +
   ellipsis `.facts` line is clipped at the line's END, so on a narrow pane
   a long facts string can hide "Last heard from" first. The CSS rule is
   unchanged; the comment now says what happens. Spec 14.5 F6 asks only for
   its own span on the facts line. Flagged for self-QA at 360px (a landlord
   with a long company and property count, or a tenant with a long
   authority).
7. Extra assertion (4.5): the Never header span carries NO title attribute
   (contract N1), beyond the plan's case.
8. tenants-F2 (4.6): the second empty state is added only for the Tenants
   heading (the facets render on that view alone, so no other contact list
   can reach the filter-miss line), with a source-copy pin like the
   Properties one. The ledger citation for `/contacts/tenants` now points at
   the real terminal region; the other four contact-list citations keep
   their pre-existing (stale but format-valid) line numbers, untouched.

## Lint

Gate-5 shape run on the 14 touched .ts/.tsx files: one error, pre-existing
- `dashboard/src/routes/contacts/ContactsList.tsx:208`
react-hooks/set-state-in-effect on the phone-param effect (main :184, one of
the 23 baseline react-hooks errors). Nothing new.
