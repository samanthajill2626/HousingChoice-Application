# R5 - build research: S7 (e2e, docs, completion)

- Reader: R5 (read-only live-tree drift check, per `.superpowers/sdd/research/CHARTER.md`).
- Slices: S7 (Tasks 7.1-7.10), plus the S5 / S6 accessible names and markup S7's
  selectors depend on.
- Plan lines read: 1-913 (sections 0-4, in full); 24830-26814 (S7, in full);
  S5 / S6 excerpts: 13695-13712, 13844-13954, 14295-14347, 15163-15197 (the
  35-row form list), 15985-16105 (TaggedField), 16313-16428 (VoucherSizePicker),
  16760-16939 (RequirementsFields), 18395-18440 and 19846-19870 (the forms' Notes),
  18516-18530, 19474-19490 (New form note / Create), 21200-21279
  (PropertyRequirementsCard), 21641-21661 (Property details rows), 22485-22517
  (defaultCheckedItems, rowIsChecked), 22960-23005 (landlord card), 23462-23472
  (landlord fieldset), 24180-24416 (ApplyRequirementsDialog); S1 2443-2805
  (planUnitApply + its tests), 4015-4200 (flyer projection); S4 10935-10960,
  11080-11090 (voucherSizeMatches + tests).
- Tree commit: `b0b07a5a080b5303b74e77d91e02977d503584e0` (worktree
  `W:/tmp/property-requirements`, = main @1d7a4667 + docs). Main tip at read
  time: `3df43172` (8 commits ahead of the branch).

Counts: 0 BLOCKER, 0 MAJOR, 6 MINOR.

## Findings

**R5-F1** - Task 7.1 - KIND: BREAKS-TEST / COMMAND - SEVERITY: MINOR (only on
the task's fallback branch).
- Plan: Task 7.1 Step 1 branch "endpoints.ts lists it, the catalog does not:
  continue"; Files = `e2e/performance/mutationCatalog.ts` only; Step 3 adds the
  entry line; Step 4 expects GREEN (plan 25122-25151).
- Tree: the same test also pins the DISCOVERED count:
  `e2e/performance/mutationCatalog.test.ts:382`
  `...toHaveLength(121);` (with its comment list at :366-381). S5 Task 5.1 Step 1
  owns bumping it to 122 (plan 13861-13882). The pin runs BEFORE the two-way
  `toEqual` (:385), so if S5 shipped the endpoint without its catalog edits, 7.1's
  RED fails on the length (121 vs 122), not on the named fingerprint, and Step 3
  alone leaves the suite red.
- Instruction: in Task 7.1 Step 1 also run
  `grep -n "toHaveLength(12" e2e/performance/mutationCatalog.test.ts`; on the
  fallback branch, if the pin was not moved by S5, apply S5 Task 5.1 Step 1's pin
  edit (plan 13865-13879: add the two comment lines, 121 -> 122, or current + 1)
  and add `e2e/performance/mutationCatalog.test.ts` to Task 7.1's Files and its
  `git add`.

**R5-F2** - Task 7.8 (and S7 fact F14, plan 25021-25027) - KIND: FACT -
SEVERITY: MINOR.
- Plan: "main has moved since the base ... lists c1bbd67b, 1c8d2380, 452189c0,
  b13d458d ... None is an S1-S6 file ... Re-check at Task 7.8".
- Tree: `git rev-list --count HEAD..main` = 8. Added since plan time:
  15532983, b222a4ac, 1456261b, 3df43172. b222a4ac changes
  `dashboard/src/api/client.ts` (+15: `requestWithStatus` now awaits one
  microtask before a SIGNALLED request and drops it, rejecting with the
  signal's reason, when it aborted in that tick) and adds
  `dashboard/src/api/client.abort.test.ts`; the rest are docs, issues and
  `docs/superpowers/reviews/2026-10-20-e2e-connection-churn/tools/*` (including
  `.mjs` / `.js` / `.ts` files). No plan task edits any of these paths (the plan
  only cites `client.ts:39-40,74-80`), so the 7.8 merge should still be
  conflict-free and `npm ci` is not needed (no package file changed). No S4-S6
  test stubs `fetch` directly (all mock `endpoints` / `request`), so the client
  change does not break their unit tests.
- Instruction: in Task 7.8 expect 8+ commits and no conflict; the handback's
  "main brought" line names b222a4ac as a behavior change (every signalled read
  S5/S6 add - the Apply dialog's `Promise.all([getContact, getAllUnits], signal)`,
  `useListing`'s landlord re-read, the New form's locked `getContact` - now
  dispatches one microtask later), which only the post-sync gates 2 and 4
  exercise. Gate 5 is unaffected: after the merge `main...HEAD` starts at the
  merged main, so main's new tool files are not in the lint list.

**R5-F3** - Task 7.2 Step 3 and Task 7.5 Step 2 (row 2) - KIND: OTHER (selector
robustness) - SEVERITY: MINOR.
- Plan: 7.2 Step 3 replaces the landlord form's Notes with
  `dialog.getByLabel('Notes', { exact: true })` (plan 25233-25240); 7.5 row 2
  says "on these forms ALWAYS `getByLabel(<label>, { exact: true })`"
  (plan 26135).
- Tree: the landlord (contact) form's Notes is a WRAPPING label around its
  textarea - `ContactEditForm.tsx:986-993`
  `<label className={styles.field}><span ...>Notes</span><textarea ...value={notes}`
  - and S6 Task 6.9 does not touch it. React 19.2.7 keeps a controlled
  textarea's text content equal to its value (`updateTextarea` sets
  `element.defaultValue = value`), and Playwright 1.61's exact `getByLabel`
  compares the label's FULL text, descendants included (strict internal matcher
  `elementText.normalized === selector`; `getElementLabels` returns the
  `<label>`'s `elementText`). So the exact selector matches that Notes box only
  while it is EMPTY. Today it is empty at that step (a fresh landlord; the e2e
  extraction driver is `fake` and writes nothing without an `EXTRACT:` text, and
  extraction never writes landlord fields - `app/src/services/extraction/apply.ts:137-142`),
  so 7.2 passes; it breaks the day a flow re-edits a non-empty landlord Notes.
  The PROPERTY forms are fine: S5 puts Notes in `TaggedField` (`<label htmlFor>`
  with the control outside, plan 16034-16039, 18423, 19862), so
  `listing-activity.spec.ts:293` with `{ exact: true }` is robust.
- Instruction: in Task 7.2 Step 3 use `dialog.getByLabel(/^Notes/)` (the label's
  full text starts with "Notes" whatever the box holds; "Deposit notes" does not)
  - or keep exact and note the empty-box precondition in the comment. In Task
  7.5 row 2 add one sentence: "Exception: the landlord form's `Notes` is a
  wrapping label around its textarea, so an exact `getByLabel('Notes')` only
  matches while the box is empty - use `getByLabel(/^Notes/)` there."

**R5-F4** - Task 7.9 Step 6 / e2e docs (hunt 3) - KIND: OTHER (doc drift the
implementer may read) - SEVERITY: MINOR.
- Plan: every S7 e2e run uses the one-hop form
  `npm run e2e -w @housingchoice/e2e -- <files>` (correct; F2, plan 24965-24969).
- Tree: `e2e/README.md:191` still documents
  `npm run e2e -- --grep "<name>"` as "run a subset". Root `e2e` is
  `npm run e2e -w @housingchoice/e2e` (`package.json:41`), so the appended
  `--grep` lands on the INNER npm as its own config flag and Playwright runs the
  whole suite (the e2e workspace script is `playwright test`,
  `e2e/package.json:7`).
- Instruction: no plan change needed. Optional, docs-only in Task 7.5 (S7 owns
  the e2e docs): correct README:191 to
  `npm run e2e -w @housingchoice/e2e -- --grep "<name>"`. Never use the root
  `--grep` form when isolating a gate-4 failure (Task 7.9 Step 6 already gives
  the right form).

**R5-F5** - Task 7.2 Steps 5 and 6 - KIND: ANCHOR (cosmetic) - SEVERITY: MINOR.
- Plan: Step 5 "Anchor (exact, 5 lines)" shows 6 lines; Step 6 "Anchor (exact,
  6 lines)" shows 5 lines (plan 25254-25281).
- Tree: both quoted blocks match byte-exact (`steps.ts:1732-1737` and
  `steps.ts:1742-1746`); only the stated counts are swapped.
- Instruction: use the quoted text as the anchor; ignore the line counts.

**R5-F6** - Task 7.7 - KIND: FACT (cosmetic) - SEVERITY: MINOR.
- Plan: "How to close: `docs/issues/README.md:83-87`" (plan 26308-26309).
- Tree: the Lifecycle rule is `docs/issues/README.md:82-85`; valid statuses are
  `open in-progress deferred resolved wontfix` (`scripts/issues.mjs:18`);
  `updated:` / `resolved:` are not validated keys (only
  `id title type severity status` are required, `scripts/issues.mjs:15`), so the
  added `resolved:` / `updated:` lines raise no warning.
- Instruction: none beyond reading :82-85.

## Confirmed

- Task 7.1: anchor `e2e/performance/mutationCatalog.ts:145` byte-exact (2-space
  indent, unique); `placeholderFor` derives `:contactId` from
  `encodeURIComponent(contactId)` (`mutationCatalog.test.ts:185-192`); S5 Task 5.1
  already adds the same entry and the pin (plan 14320-14333, 13861-13879), so 7.1
  is expected to be a PIN.
- Task 7.2 anchors: 6/6 byte-exact in `e2e/scenarios/steps.ts` (pickOrgName tail
  :161-164; `softTermsNote` :1515; voucher fill :1682-1684 - unique, the second
  `if (opts.voucherSizeAccepted ...)` at :1700 does not carry the getByLabel line;
  `expectUnitVoucherSizeAccepted` :1732-1737; `expectUnitAvailableWithListingLink`
  doc + signature :1742-1746; `getByText('Voucher size accepted')` :1760);
  `landlord-onboarding.spec.ts` call sites :92 and :271 (2 occurrences, 2-space
  indent); :88 and :268 both record size 2; the spec holds 7 tests ("7 passed");
  `Locator` and `expect` are already imported (`steps.ts:14`);
  `expectUnitAvailableWithListingLink` has no caller outside that spec.
- Task 7.2 helper vs S5 Task 5.5 code: group `role="group"` named by
  `aria-labelledby` -> "Voucher sizes accepted"; chips are buttons whose text is
  `Studio` / `1`..`12` with `aria-pressed`; `More sizes (5-12)` shown while no
  5+ is selected; the summary `<p>` is one text node from `acceptsSummary`
  (`Accepts: 3 BR, 5 BR`) - the helper's names and summary format match.
- Task 7.2 baseline RED (Step 1): the five named failures and their first failing
  lines are right against S5/S6 code; the cold-call / inbound flows fail at
  Notes before reaching the masked `Voucher size accepted` fill, which 7.2 Step 4
  then fixes.
- Task 7.3 anchors: 4/4 byte-exact (`contact-detail.spec.ts:134` title with one
  U+2014; body :137-155; `broadcasts.spec.ts:320`; `listing-activity.spec.ts:293`).
  The lean landlord `contact-landlord-0001` (Marcus Bell) has no `notes` and no
  `req_` keys (`app/src/lib/seed/lean.ts:136-157`), and no e2e spec writes his
  notes, so `No notes yet - use + Add.` holds in the full suite. The landlord
  fieldset is `isLandlord`-gated (plan 23462), so the TENANT `getByLabel('Pets')`
  / `'Evictions'` (`steps.ts:907-908`) stay single matches.
- Task 7.3 new assertions vs S5/S6 code: legend `<legend>` "Requirements /
  Qualifications" (plan 23464); `FlyerLegend` lines are `<li>` single text nodes
  (plan 16198-16213); all 16 field labels are `TaggedField` `<label htmlFor>` or
  `TaggedCheckbox` wrapping labels around an `<input>` (no textarea text in the
  label), so exact `getByLabel` + `toHaveCount(1)` holds even for Qualifications /
  Tour process (textareas outside their labels); Pet fee's description is tag +
  public note, matching `/On property flyers/`.
- Task 7.4 setup: dev-login `va@example.com` is a seed persona with role `va`
  (`app/src/routes/dev.ts:208-212`); adding an org entry is open to every
  signed-in user (`app/src/routes/organizations.ts:24-27`; admin only for
  name/kind/spellings); `OrgKind` includes `housing_authority`
  (`app/src/lib/orgNames.ts:7`); tenant `voucherSize` 6 is valid
  (`contacts.ts:581-586`, 0..12); POST contacts 201 `{ contact }`
  (`contacts.ts:1183`), PATCH `{ contact }` (:2046), POST units 201 `{ unit }`
  (`units.ts:834`), GET unit `{ unit }` (:854), flyer
  `{ flyer: { ...toUnitFlyer(unit), media, contact_number } }`
  (`public.ts:463`); the tenant-creation and composer pattern is
  `matching-blast-rules.spec.ts:84-150,262-298` verbatim; imports exist
  (`fixtures/orgFixture.ts:81` addOrg, `support/today.ts:43` expectTodayReady,
  `scenarios/steps.ts` exports ORG_PICKER / pickOrgName; five dashboard-next specs
  already import from steps.js); everything is run-unique, no seeded record is
  read or written.
- Task 7.4 spec vs S5/S6 markup (each selector traced): New form note text and
  `Create` / `Creating...` gating (plan 19474-19490); prefill fields disabled
  rules (`Fixed amount` when One month's rent, `Application fee` when No
  application fee, plan 16836-16853); Requirements card title + `Edit property
  requirements`, h4 groups only, value / tag / landlord line each one text node
  (plan 21234-21272); Apply dialog: named list "Which properties" via
  `aria-labelledby`, one checkbox per `<li>`, ` (own value)` once per own item,
  `Update <N> properties` button text, default items = every non-blank landlord
  item (`defaultCheckedItems`, plan 22485-22489), body
  `units: [{ unitId, ownItems }]` exactly (`applyRequestBody`, plan
  `ownItems: [...row.own]`) - so the `arrayContaining` objects match; Property
  details row `Voucher sizes accepted` as a KV with `formatVoucherSizes` (plan
  21652); flyer projection keeps `deposit: null`, `voucher_size` = first of
  `voucher_sizes` (S1 Task 1.6, plan 4190-4196; tree `unitFields.ts:343-370`).
- Task 7.4 mutants (PR1-4, PR1-5): M1 anchor = S1 Task 1.3 code plan 2794-2795
  (6-space indent, unique); liveness file `app/test/requirementsApply.test.ts`
  (NEW in Task 1.3) with the case at plan 2592-2603, whose `toEqual` patch
  carries the two `null`s the mutant drops; M2 anchor = S4 Task 4.1 plan 11088
  (2-space), cases `[[4],5,true]`, `[[4],12,true]`, `[[2,4],6,true]` in
  `app/test/blastAudienceRules.test.ts` (exists today) fail under it; M3 anchor =
  S6 Task 6.7 plan 22517 (2-space, the only `return row.own.length === 0;`),
  liveness `applyRequirementsModel.test.ts` `describe('rowIsChecked'` (plan
  22321-22327). Expected first failures traced: R1 test 1 at `Cats OK` (the
  flyer reads `No pets (Cats OK)`; nothing earlier fails - B and C still write),
  test 2 at the 6-bedroom checkbox; R2 test 1 at row A `not.toBeChecked()`,
  test 2 passes. The app and worker run from source under tsx
  (`scripts/e2e-session.mjs:430-433`) and Vite serves the dashboard source, so a
  cold boot after the edit runs the mutant. Reverts cover all three files, and
  Step 7's single `git diff --exit-code` names all three.
- Task 7.4 Steps 2-3: the verbatim spec block (plan 25486-26000) is 0 non-ASCII
  bytes; `e2e/tsconfig.json` is `noEmit` and includes `tests/**`, so typecheck
  leaves no untracked file; the lint config for e2e `.ts` is
  `tseslint.configs.recommended` (not type-aware) and the spec has no unused
  binding.
- Task 7.5 anchors: 2/2 byte-exact and unique (`selectors.md:148` phrase;
  `selectors.md:133` row start, right after the `:132` housing-authorities row);
  the five new rows carry no `|`; no other selectors.md row cites the changed
  copy (the only `Tour type` mention, :137, is the Tours page). The file holds 27
  pre-existing non-ASCII bytes, so the added-lines rule applies.
- Task 7.6 anchors: 6/6 byte-exact (`GLOSSARY.md:141-142`, :172, :176 start,
  :187 end, :481 start, :495 end); the 176-187 bullet's only non-ASCII is the
  em dash on :185; total is 72 today, so 69 after Step 3 is right; GLOSSARY has
  no existing requirements / copy only / tags entry. Mermaid
  `landlord-onboarding-sequence.mermaid:82` byte-exact; the replacement has no
  `;`; no code parses the diagram text.
- Task 7.7 frontmatter: `status: open` + `created: 2026-10-01`
  (`unit-voucher-size-readers-diverge.md`, 0 non-ASCII), `status: open` +
  `created: 2026-08-10` (`broadcast-4plus-exact-match-underreach.md`, 0),
  title line 3 with one U+2014 + `created: 2026-06-30` + `refs:` line
  (`unit-onboarding-fields.md`, 42 non-ASCII - added-lines rule). `resolved` is a
  valid status (`scripts/issues.mjs:18`).
- Task 7.8: merge steps sound (`--no-ff --no-commit`, MERGE_HEAD check, explicit
  adds); see R5-F2 for the current drift.
- Task 7.9: matches AGENTS.md "Required completion gates" - sync first (AR44),
  five bare gates each last on its line with the exit code on the next, hard
  outer timeouts, gate 2 drops exported AWS keys (none exported in this
  environment), gate 5 lists `main...HEAD` and SKIPS on an empty list, gate 5
  attribution by per-file per-rule BASELINE counts (not line numbers). The brief's
  ESLint 9 formatter trap does not apply: `lint-compare.mjs` uses the Node API
  (`new ESLint()`, `lintFiles`, `lintText` with `filePath`), and `eslint`
  (9.39.4) resolves from the worktree root `node_modules` when the script runs
  from `.superpowers/gates/`. `npm run db:start` / `npm run s3:start` exist
  (`package.json:22,27`); the smoke OK line is `smoke-dist: OK - ...`
  (`scripts/smoke-dist.mjs:179`); the lint backlog anchor paragraph
  `**Status 2026-10-19` is at `docs/issues/lint-backlog-repo-wide.md:13` and its
  title carries `20` / `17`; AGENTS.md is not edited (AR46).
- S7 facts F1, F4-F13, F15: true against the tree (playwright.config
  `DEFAULT_TEST_TIMEOUT_MS = 60_000`, expect 15 s, workers 1, retries 0; Card /
  CardAction / Modal shapes `Card.tsx:20-54`, `Modal.tsx:166-172`;
  `TOUR_TYPE_LABELS.landlord_led = 'Landlord-led'`; UnitCreateForm sr-only address
  labels and `contactDisplayName`; LandlordFile `:171` Notes copy and `:179`
  action; ContactEditForm `isTenant` / `isLandlord` gates and wrapping-label
  Notes; response shapes; `broadcastFormat.ts:33-48` chips and labels;
  `AudienceFilters.tsx:187-196` tag and note). F14 is stale (R5-F2).
- Commands (check 8): every e2e run in S7 uses
  `npm run e2e -w @housingchoice/e2e -- <files>` from the root (one hop into
  `playwright test`, file paths relative to `e2e/` are right); no other slice runs
  e2e; e2e unit runs use `cd e2e && npx vitest run ...` or
  `npm test -w @housingchoice/e2e`; app / dashboard vitest from their
  workspaces.

## Invariant sweep (check 6, e2e): every selector and assertion on a changed surface

(a) Selectors against the new labels / copy. "Substring" = Playwright lax match;
note that `getByLabel` also matches any element by `aria-label` /
`aria-labelledby`, so the new per-item `role="group" aria-label=<item label>`
divs on the property and landlord pages (plan 21259, 23004) are reachable by an
UNSCOPED `page.getByLabel` - no e2e selector does that on those pages.

| Where | Selector | Verdict | Task |
|---|---|---|---|
| `steps.ts:1515` | landlord form `getByLabel('Notes')` | BREAKS (Notes + Deposit notes) | 7.2 Step 3 (see R5-F3) |
| `steps.ts:1683` | New form `getByLabel('Voucher size accepted').fill` | BREAKS (no such label; picker group is "Voucher sizes accepted", not a substring match) | 7.2 Step 4 |
| `steps.ts:1760` | Property details `getByText('Voucher size accepted')` | BREAKS (row renamed) | 7.2 Step 6 |
| `steps.ts:1737` | API `voucher_size_accepted` `toBe(2)` | BREAKS (`[2]`) | 7.2 Step 5 |
| `listing-activity.spec.ts:293` | edit form `getByLabel('Notes')` | BREAKS (Notes + Deposit notes) | 7.3 Step 4 |
| `contact-detail.spec.ts:144` | landlord Notes `getByText(/live on each property/)` | BREAKS (D9 copy) | 7.3 Step 2 |
| `contact-detail.spec.ts:149-152` | unscoped `page.getByLabel` Accepted vouchers / Lease terms / Pet policy / Expected rent `toHaveCount(0)` | still 0 (no new label contains them); rewritten dialog-scoped | 7.3 Step 2 |
| `broadcasts.spec.ts:320` | old pre-fill note | BREAKS (D12 copy) | 7.3 Step 3 |
| `steps.ts:1675-1681,1685-1688` | New form Beds / Baths / Rent min / Rent max / Public listing link / Street address / City / State / ZIP (substring) | no collision against the 35 labels (plan 15163-15197) | none needed |
| `steps.ts:1490,1512-1514,1529-1532,1588-1590` | landlord form Contract status, Registered landlord, Submits RTA within 48h, Passes inspection first try, Voucher counts as income, Field label/value 1, combobox Status exact, Park reason | no collision | none |
| `steps.ts:907-911,1161,4112-4115`; `contact-detail.spec.ts:63,77`; `org-lists.spec.ts:292,466` | TENANT form Pets / Evictions / Notes / Voucher size (bedrooms) | no collision (fieldset `isLandlord` only) | none |
| `listing-activity.spec.ts:28,319` | edit form `getByLabel(/Utilities/i)` | one match (`Tenant-paid utilities`; the public note is a `<p>`, not a label) | none |
| `tours-page.spec.ts:329` | edit form `getByLabel('Tour type')` | one match (Tour process does not contain it) | none |
| `send-outcome-cards.spec.ts:266`; `steps.ts:1887`; `tours-page.spec.ts:130,357` | Schedule tour dialog Tour type | not a property form | none |
| `org-lists.spec.ts:314-339` | edit form Housing authorities picker, Save | combobox name unchanged (tag via labelAside) | none |
| `steps.ts:1664-1665,1691` | `Add a property for this landlord`, dialog `New property`, `/^Create$/` | unchanged (`LandlordFile.tsx:179`; idle text `Create`) | none |
| 17 sites (`steps.ts:904,957,993,1158,3099,3925,4109`; `contact-detail.spec.ts:60,76,97,118,147`; `contact-create.spec.ts:279`; `org-lists.spec.ts:235,288,432,464`) | button `Edit contact details` (substring) | no collision (`Edit requirements`, `Edit property requirements`, AR41) | none |
| heading selectors `Details` (27 sites, e.g. `steps.ts:1477-1479`), `Notes` (`contact-detail.spec.ts:142`, `listing-activity.spec.ts:286`), `Landlord onboarding` (2), `Property details` (`steps.ts:1759`), `Tours` (6), `Activity` (4) | substring | no collision: new h3s are "Requirements Edit property requirements" and "Requirements / Qualifications Apply to properties Edit requirements"; new h4s Screening, Pets, Move-in costs, Touring | none |
| `listing-photos.spec.ts:87,293` | property page button `+ Add` (substring) | no collision (new action's name is its aria-label) | none |
| `property-roster.spec.ts:132,195,246,357,418` | property page `Edit contacts` | no collision | none |
| `listing-activity.spec.ts:26,317`; `org-lists.spec.ts:317`; `tours-page.spec.ts:327` | menuitem / dialog `/Edit property/i` | the new action is a button, not a menuitem / dialog | none |
| `listing-activity.spec.ts:288,299` | property Notes card `No notes yet.` | unchanged (only the landlord copy changes, plan 20171) | none |
| `public-pages.spec.ts:159-174` | flyer intake `getByLabel(/Voucher size/)` | the flyer gains no label | none |
| `public-pages.spec.ts:221,239-250,383-410,426` | flyer Deposit / Application fee / Pets / Lease terms / `$N` / `Fits a N-bedroom voucher` | still single matches (no $0 fee, no pet fee, no washer/dryer on these units) | none (7.3 Step 6 runs it) |
| `broadcasts.spec.ts:171-172,316-319`; `matching-entry-points.spec.ts:211-212`; `matching-blast-rules.spec.ts:269` | composer chips `/2-BR/`, `/^3-BR/`, `/matches property/i` | still valid (one size pre-filled; no single-select interaction is asserted) | none |
| `properties-available-view.spec.ts:168,192,202`; `contacts-list-facets.spec.ts:113-127` | list facet chips | not the composer / forms | none |

(b) Assertions on old shapes (API writers included).

| Old shape | e2e site | Verdict | Task |
|---|---|---|---|
| voucher number read back | `steps.ts:1737` | breaks | 7.2 Step 5 |
| voucher number written | `steps.ts:1717`, `broadcasts.spec.ts:311`, `properties-available-view.spec.ts:65`, `public-pages.spec.ts:375` | accepted, stored `[n]` (D4) | none |
| `voucher_size_accepted: null` | `public-pages.spec.ts:402-405` | REMOVE unchanged | none |
| `Fits a N-bedroom voucher` | `public-pages.spec.ts:221,394-395,409-410` | one-size wording unchanged | none |
| `$0` fee / subzone on flyer | none in e2e | - | new spec (7.4) pins D11 |
| Notes empty state | `contact-detail.spec.ts:144` | breaks | 7.3 |
| single-select chips / old note | `broadcasts.spec.ts:320` | breaks (note) | 7.3 |
| Property details rows Deposit / Pets / Application fee; Tour & application card rows | none in e2e | - | - |
| Activity copy | `listing-activity.spec.ts:311,329-330` (`Property updated`, `Utilities`, plain PATCH path) | unchanged | none |
| legacy `bedroomSize: 2` POSTs | `a2p-compliance.spec.ts:530`, `broadcasts.spec.ts:152,359`, `landlord-activity.spec.ts:85`, `listing-activity.spec.ts:105,186`, `send-outcome-cards.spec.ts:117` | accepted (D12); no spec reads `bedroomSize` back | none |
| unit `pets` / `deposit` / `application_fee` writes | `public-pages.spec.ts:121-140,370-376` (string pets, numbers) | valid kinds | none |
| contact `pets` / `evictions` (TENANT) | `ai-run-log.spec.ts:467`, `event-bridge.spec.ts:69-70`, `voice-extraction.spec.ts:68`, `conversation-fact-extraction.spec.ts:112` | tenant path untouched (S3 watch) | none |

Writers / readers of the e2e-visible state the plan's 3.1 lists, as e2e touches
them: IN-PLAN for every row above that needs a change (7.2, 7.3); the new spec
(7.4) is the e2e reader of `requirement_sources`, the `req_` keys, the Apply
route, the D11 flyer keys and `bedroomSizes`. NOT-IN-PLAN: none found.
