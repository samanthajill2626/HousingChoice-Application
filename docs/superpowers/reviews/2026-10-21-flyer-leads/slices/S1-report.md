# S1 slice report - flyer-leads (Tasks 1.1, 1.2 and worklist OR-5)

Branch feat/flyer-leads. Commits: d44fe975 (Task 1.1, with OR-5 folded in),
533e4c9d (Task 1.2). Findings only; code cited by `file:line` at 533e4c9d.

## Contract deviations

None. S1 creates or consumes no plan section 2 interface. The names it
creates are the private / test-local ones plan 5 E lists: `subzoneKey`
(app/src/lib/similarUnits.ts:58, not exported) and `TRIMMED_FLYER_KEYS`
(app/test/unitFields.test.ts:584, test-local). The flyer route now returns
exactly the 16 keys plan 5 E names for S2's `PublicFlyer`
(app/test/publicIntake.test.ts:338, with the ten D1 keys asserted absent at
:359).

## Plan corrections

- Commit template (plan 5 C step 4) double-quotes `-m`, and both S1 bodies
  contain double quotes (R1 F2). Applied OR-3: single-quoted `-m` arguments.
- MERGE_HEAD check run as `git rev-parse --git-path MERGE_HEAD` (rules file);
  it resolves to the path plan 5 C names.
- OR-5 is in Task 1.1's commit (app/src/lib/address.ts:110-111, comment
  only), so that commit has 8 files where plan 5 Task 1.1 Step 6 lists 7, and
  the exit check's eslint list has 10 files where plan 5 lists 9. The 10 are
  exactly what `git diff --name-only --diff-filter=d main...HEAD` lists.
- Line-number hint only: plan 5 B puts `UnitFlyer`'s rent_min / rent_max at
  unitFields.ts:400-401; the tree held them at :394-395 (as R1 read). Every
  quoted anchor matched verbatim; no anchor, count or compile fix was needed.
- Counts held exactly. RED: 11 cases (Task 1.1), 3 (Task 1.2), each for the
  stated reason; the strengthened "catches a wrong tag" PIN and the two D9
  PINs passed at RED. GREEN: requirements 38, parity 10, unitFields 81,
  publicIntake 58 (unchanged), similarUnits 21, unitsApiSimilar 4.
- The Edit tool kept both `\t` escapes literal
  (app/test/similarUnits.test.ts:260, :282); the file holds no raw TAB.

## Risks and residuals

- EXPECTED RED until S2 Task 2.2 (AR4):
  dashboard/src/routes/listing/requirementsMirror.test.ts:80-81 "the items,
  ids and key lists are identical" and :87-88 "the D10a property-form table
  is identical (...)". Exit-check run: 2 failed, 8 passed. It is the only
  cross-workspace importer of an S1 module (requirementsMirror.test.ts:18).
- OR-6, for S2: dashboard/src/routes/listing/requirements.test.ts (the
  verbatim copy of the app cases) is GREEN after S1 (58 passed) because it
  tests the still-unchanged mirror; it goes red the moment S2 re-tags the
  mirror unless the same commit copies S1's case changes. Source text:
  commit d44fe975, app/test/requirements.test.ts:85-91 and :99-103, and
  app/test/propertyFormFlyerParity.test.ts:183-186, :192-193, :202-207.
- The branch's own flyer page crashes between S1 and S2 (spec D1's old-bundle
  crash, inside the branch). dashboard/src/routes/public/FlyerPage.tsx still
  reads the removed keys: `textOrNull(flyer.pets)` :137,
  `textOrNull(flyer.pet_fee)` :282, `textOrNull(flyer.accessibility)` :290,
  `textOrNull(flyer.lease_terms)` :291 (`undefined.trim()` throws), and
  `flyerMoney(flyer.deposit)` on undefined at :156. Dashboard unit tests are
  unaffected (hand-fed fixtures), but the real page against the real API is
  a white page. Do not run e2e or self-QA the flyer page on a tree that has
  S1 without S2; S2 Tasks 2.3-2.4 remove these reads.
- The safety claim written into the "Removed keys" comment
  (app/src/lib/unitFields.ts:388-401) was checked against the code:
  FlyerPage.tsx:129-131 is `v === null || v.trim() === ''`, which throws on
  undefined.
- Rent still reaches tenants through the `[Rent]` merge field (OR-26, for
  Cameron); the new rent_min / rent_max comment says so
  (app/src/lib/unitFields.ts:73-75).
- D10: no untrimmed typed-input path in S1's surfaces. `area` and `subzone`
  are written only by the HTTP unit routes, behind `trimJsonBody`
  (app/src/app.ts:146); subzone is also trimmed by its kind
  (app/src/lib/unitFields.ts:306-315). No script, job, service or importer
  writes either (grep of app/scripts, app/src/jobs, app/src/services). The
  area branch of `scoreArea` (app/src/lib/similarUnits.ts:71) stays EXACT and
  case-sensitive by spec D9 ("east" != "East", pinned at
  app/test/similarUnits.test.ts:306): a matching choice, not a trim gap.
- For S2, no S1 change: FlyerPage.tsx:126-128 says "the edit form PATCHes
  untrimmed values". Since AR16 the server stores them trimmed
  (`trimJsonBody`), so a whitespace-only value is never stored; the
  defensive trim stays harmless.
- Left as is, still accurate: app/src/routes/public.ts:26 and :449 ("the FULL
  public payload") describe the payload as the projection; S4 owns
  public.ts.

## Pre-existing lint

None: `npx eslint` on the 10 S1 files exits 0 with no output.
