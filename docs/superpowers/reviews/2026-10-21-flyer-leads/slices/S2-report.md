# S2 slice report - flyer-leads (Tasks 2.1-2.6 and worklist OR-6..OR-10)

Branch feat/flyer-leads. Commits, oldest first: 2d59cb55 (Task 2.1),
2be2451a (Task 2.2, with OR-6), fe2ce925 (Task 2.3, with OR-7), 53fdabd4
(Task 2.4, with OR-8 and OR-9), 6d607bfa (Task 2.5), 7faf3e88 (Task 2.6).
They sit directly on S1's last commit 028cbe20. Findings only; code cited by
`file:line` at 7faf3e88.

## Contract deviations

None. Every plan 1.1 string is as written. The heading link reuses
`mapsHref` with `target="_blank" rel="noreferrer"` and the old sr-only
` - open in Google Maps` (dashboard/src/routes/public/FlyerPage.tsx:320,
:323). The fallback reads `Home for rent` (:142), the highlight line is at
:334, the sign-up heading and button at :436 and :441, and the thank-you
heading and text at :426 and :429. `PublicFlyer` (publicApi.ts:31-55) now
holds exactly the 16 keys of the app's `UnitFlyer` plus `contact_number`.
The names S2 creates are the module-private ones plan 6 E lists: in
FlyerPage.tsx `addressPart` :107, `streetLine` :113, `cityLine` :121,
`flyerHeading` :136 and the `FlyerHeading` type; in TaggedField.tsx
`showNote` :51.

## Plan corrections

- OR-6 (R1 F1, BLOCKER) is in Task 2.2's commit. Three edits in
  dashboard/src/routes/listing/requirements.test.ts:
  - :369-375: S1's comment line and the six Pets / Deposit tuples;
  - :383-387: the new case 'flyer-leads D2: Application fee is the only
    requirement field On flyer';
  - :608-632: the two-line comment (:608-609), Rent min / max (:610-611),
    Accessibility / Lease terms (:617-618) and the six Pets / Deposit rows
    (:627-632).

  The text was copied from d44fe975. The copied regions diff byte-identical
  against app/test/requirements.test.ts:74-105 and
  app/test/propertyFormFlyerParity.test.ts:174-214. S1's two parity-walk
  cases are NOT copied: they run `toUnitFlyer`, which the copy block's own
  header excludes (requirements.test.ts:308-316).
- RED counts that differ from plan 6 because of the worklist:
  - Task 2.2 had 14 failures, all because the mirror still said
    `on_flyer`: mirror 2, requirements.test 5 (OR-6), RequirementsFields 2,
    ListingEditForm 2, UnitCreateForm 2, ContactEditForm 1.
  - Task 2.4 had 18 failures, not 16. OR-9 adds two:
    - the stale-payload case's exact `dt` list
      (FlyerPage.test.tsx:289-298) was red with first `dt` 'Address';
    - the city-line pin (FlyerPage.styles.test.ts:47-50) was red with
      "missing CSS rule for .addressTitle".

    That pin also holds `.addressTitle` at `--fs-xl`, so "smaller" is
    checked against the h1 rather than as a bare value.
- Every other RED step matched the plan:
  - Task 2.1: 1 failure.
  - Task 2.3: one runtime failure (the stale case: the `Deposit` dt was
    found) and ONE type error, TS2349 on `toBeNever` at
    publicApi.test.ts:127.
  - Task 2.5: 4 failures; both PINs passed.
  - Task 2.6: 3 failures; the PIN passed.
- OR-7 is in Task 2.3's commit, so that commit has 5 files where the plan
  lists 4, and the exit check's eslint list has 16 files where plan 6 lists
  15 (it adds dashboard/src/api/types.ts). Those 16 are exactly the .ts /
  .tsx files `git diff --name-only 028cbe20..HEAD` lists. The 17th changed
  file, FlyerPage.module.css, is not linted.
- OR-7 wording: the worklist quotes `Staff only (flyer-leads D2).`, so
  dashboard/src/api/types.ts:2571, :2607, :2609, :2611 and :2613 say D2.
  S1's app twins say `Staff only (flyer-leads D1).`
  (app/src/repos/unitsRepo.ts:423, :442, :515, :517, :519, :521). Both are
  true (D1 removes the keys, D2 tags them). The edits are comment-only and
  nothing reads them.
- OR-8 is applied at FlyerPage.tsx:86-96 (the `mapsHref` doc).
- Every quoted anchor matched verbatim once OR-1's presentation escapes were
  stripped (2.1 (d), 2.2 (d)/(e), 2.3 (c)/(e), 2.4 (c)/(d), 2.6 (c)). No
  anchor, count or compile fix was needed. R1 N4's count slip is confirmed
  (2.3 (d) held three "Pets:" cases plus the legacy-boolean and blank-fee
  cases); the line range was right.
- GREEN counts per task (2.3-2.6 run the whole src/routes/public folder,
  /join's tests included):

  | Task | Tests | Files |
  |---|---|---|
  | 2.1 | 224 | 4 |
  | 2.2 | 378 | 6 |
  | 2.2, listing + contact folders | 2448 | 101 |
  | 2.3 | 104 | 8 |
  | 2.4 | 120 | 9 |
  | 2.5 | 126 | 9 |
  | 2.6 | 128 | 9 |

- Exit check:
  - whole dashboard suite: 264 files, 5369 tests, EXIT:0, including
    requirementsMirror.test.ts (10) and requirements.test.ts (59);
  - `npm run typecheck` across all five workspaces: EXIT:0;
  - the greps in exit-check steps 4 and 5 print exactly the expected test
    lines.

## Risks and residuals

- The 320px wrap and the whole-block tap target are owed to S6. Only CSS
  source pins hold them:
  - FlyerPage.styles.test.ts:21-29 checks `.headingLink`'s `display: block`
    and `overflow-wrap: anywhere` (FlyerPage.module.css:43-47) and the
    `overflow-wrap` on `.title` (:25);
  - the one-link DOM assertions are at FlyerPage.test.tsx:509-529.

  `css: false` means no unit test can measure layout. S6's flyer spec should
  set a 320px viewport, use a long street line, and assert that the heading
  link stays inside the card (plan 6 E, last bullet).
- The flyer page is safe to load again. From fe2ce925 on, the branch's page
  reads only the projected keys: a grep for `rentRange`, `petsLabel`,
  `depositLabel` and the ten D1 keys over FlyerPage.tsx and publicApi.ts
  finds nothing. That closes the white-page window S1's report named, so
  e2e and self-QA of /p/:unitId are safe on 7faf3e88.
- e2e stays red until S6. These are plan 6 E's lines, re-checked at
  7faf3e88:
  - e2e/tests/dashboard-next/public-pages.spec.ts:
    - :217 finds the heading by the area;
    - :219 reads the rent;
    - :239, :244, :246 and :248 read the Deposit, Pets, Accessibility and
      Lease terms rows;
    - :285 clicks /I'm interested/, which must become 'Sign up'.
  - listing-photos.spec.ts:242 (same folder, as are the next two) uses the
    same old button.
  - property-requirements.spec.ts:
    - :262 expects /On flyer/ on Pet fee;
    - :383-386 read the deposit and No pets rows;
    - :406 lists the removed keys in a `toMatchObject`.
  - contact-detail.spec.ts:187 expects /On property flyers/ on Pet fee; it
    is now Staff only.
  - e2e/support/selectors.md:137 still lists the removed rows.
- OR-26, the rent legend (for Cameron). After Task 2.2 the property forms
  tag Rent min / Rent max Staff only
  (dashboard/src/routes/listing/requirements.ts:264-265). The legend says
  "Staff only - never leaves the dashboard."
  (dashboard/src/routes/listing/FlyerTag.tsx:36). Yet the Matching blast
  default still texts the rent
  (dashboard/src/routes/broadcasts/resolveTemplate.ts:31, "... is available
  for [Rent]/mo ..."). Built per the spec (option c, R6 F1); the GLOSSARY
  line is S6's (OR-21).
- OR-10, /join shares the stylesheet. HousingFairIntake.tsx:48 imports
  FlyerPage.module.css and uses `.title` (:159, :176), which now carries
  `overflow-wrap: anywhere` (FlyerPage.module.css:25). This is harmless, and
  /join's tests are green. `.authorities` and `.highlight` are flyer-only.
- D10: no untrimmed value is stored or compared in S2's surfaces. The area
  and every address part are trimmed at display (FlyerPage.tsx:59-63
  `neighborhood`, :107-109 `addressPart`), and the server trims every JSON
  body (AR16). Two display-only reads stay untrimmed, as the spec and AR6
  leave them. A real payload never reaches them, because `validateAddress`
  trims and drops blank parts:
  - `mapsHref` filters out blank parts but joins the RAW parts into the
    Maps query (FlyerPage.tsx:97-101);
  - `interestedPrefill` tests `line1 !== ''` untrimmed (FlyerPage.tsx:149).
- Two comments are stale and were kept as the plan wrote them. The
  `textOrNull` doc says "the edit form PATCHes untrimmed values"
  (FlyerPage.tsx:164-166), and the plan's own test title keeps "(edit form
  saves untrimmed)" (FlyerPage.test.tsx:257). Since AR16 the server stores
  those values trimmed, as S1's report also notes. The guard itself is
  harmless.
- `publicNote` now has no effect on a Staff only field
  (TaggedField.tsx:51). The only hand-set props left are on Tenant-paid
  utilities (ListingEditForm.tsx:531, UnitCreateForm.tsx:666).
  RequirementsFields derives the prop (RequirementsFields.tsx:153). The only
  requirement field still On flyer is the money fee, and the note applies to
  text fields only, so no requirement field shows it any more.

## Pre-existing lint

dashboard/src/routes/public/FlyerPage.tsx has two
react-hooks/set-state-in-effect errors, both pre-existing and not S2's:
- :210:5 `setVariant(...)` in the cta effect;
- :228:7 `setStage({ kind: 'unavailable', contactNumber: null })` in the
  unit effect.

They are the two plan 6 B measured on main at :192 and :210; the lines moved
with S2's new helpers. The other 15 linted files report nothing. S6-gates.md
stays the authority for gate 5's baseline attribution.
