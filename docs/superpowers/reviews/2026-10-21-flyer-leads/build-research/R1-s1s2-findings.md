# R1 delta findings - S1 (plan section 5) and S2 (plan section 6)

Reader: R1 (build research, phase 1). Live tree: W:\tmp\flyer-leads
(feat/flyer-leads @031a46d6; app/dashboard/e2e/scripts/fake-twilio identical
to b7959e2a - `git diff --stat b7959e2a HEAD` on those dirs is empty).
Rules: .superpowers/sdd/research/RESEARCH-RULES.md. Reference quotations:
.superpowers/sdd/research/R1-s1s2-reference.md.

Counts: BLOCKER 1, MAJOR 0, MINOR 3, NOTE 4.

What was checked and holds (no finding):
- Every S1 anchor (Tasks 1.1, 1.2) exists verbatim after stripping the bullet
  indent: unitFields.ts :72-73, :81, :86, :93-94, :98, :356, :375-378,
  :394-395, :406-422, :482-489, :500-501, :507-514; requirements.ts :84-97,
  :535-536, :542-543; unitsRepo.ts :423, :442, :452-454, :515, :517, :519,
  :521; requirements.test.ts :85-90, :98; propertyFormFlyerParity.test.ts
  :183-184, :190-191, :200-205, :262-267; unitFields.test.ts :581-584,
  :602-610, :653-654, :660-667, :688-689, :710-720, :724-740, :794-820,
  :827-839; publicIntake.test.ts :281-282, :320-321, :328-360, :362-363,
  :376; similarUnits.ts :52-60; similarUnits.test.ts tail.
- S1 counts: requirements.test.ts 37 its + 1 = 38; parity 9 + 1 = 10;
  unitFields.test.ts 69 its + 12 INHERITED it.each rows = 81 (net zero);
  similarUnits.test.ts 16 + 5 = 21. The 11-case RED list and the strengthened
  "catches a wrong tag" PIN (12 mismatches before and after) both hold. The
  D9 numbers (60 / 50 / 35) and unitId tie order hold against
  similarUnits.ts:36-39, :170, :187-189.
- S1 still-compiles: no app/src, app/test, app/scripts, e2e, scripts or
  fake-twilio reader of the ten UnitFlyer keys beyond the files Task 1.1
  edits (`toUnitFlyer` readers: routes/public.ts:463 spread only;
  e2e/scenarios/steps.ts:1784 reads `ok()` only).
- S2 FlyerPage.tsx sequence 2.3 -> 2.4 -> 2.5 -> 2.6 simulated on paper:
  every later anchor survives the earlier replacements (2.4 (e) consts stay
  adjacent after 2.3 (f); 2.4 (h) / 2.5 (d) chain on the header text 2.3 (i)
  / 2.4 (h) write; 2.5 (a) anchor is 2.4 (f)'s last two lines at the same
  indent; 2.6 anchors at :9, :449-451, :455-459 are untouched by 2.3-2.5;
  2.6 (b)'s 12-space `<h2 ...>Interested in this home?</h2>` is unique as a
  multi-line anchor although :433 holds the same element at 14 spaces). The
  FlyerPage.test.tsx, FlyerPage.module.css and FlyerPage.styles.test.ts
  sequences hold too (2.6 (a) replace_all hits exactly :184, :369, :375).
- S2 pinned copy and names: sr-only suffix ` - open in Google Maps`
  (FlyerPage.tsx:345), `rel="noreferrer"` (:343), thank-you heading
  `Thanks - you&apos;re all set!` (:447), detail labels (:361, :367, :373,
  :403, :409, :419), IntakeForm `submitLabel` (IntakeForm.tsx:25, :44, :290).
  Tokens exist (dashboard/src/ui/tokens.css:14-80). expect-type 1.3.0 has
  `toBeNever`; `expectTypeOf` precedent dashboard/src/api/types.test.ts:382.
  The styles-test regex matches InboxRow.styles.test.ts:16. The drift test
  mechanism is `toEqual` on REQUIREMENT_ITEMS and PROPERTY_FORM_FIELDS
  (requirementsMirror.test.ts:81, :88) over the imported app module (:18).
- S2 still-compiles: `PublicFlyer` is read only by FlyerPage.tsx and its
  test (plus publicApi.test.ts after 2.3); `rentRange`, `petsLabel`,
  `depositLabel`, `addressLines` are module-private and named nowhere else
  except the FlyerPage.test.tsx:148 comment 2.4 (c) replaces. e2e readers of
  the removed rows / copy / tags (public-pages, listing-photos,
  property-requirements, contact-detail, selectors.md) are all edited by S6
  Task 6.1 / 6.3.
- ASCII claims for every S1/S2 file hold (pure-ASCII ones read 0; the others
  carry the counts the plan states). Lint baseline: S1's nine files are
  clean; of S2's files only FlyerPage.tsx reports, exactly the two
  `react-hooks/set-state-in-effect` errors at :192 and :210.

---

## F1 - BLOCKER - Task 2.2 cannot go green: the dashboard requirements.test.ts carries a SECOND verbatim copy of the app tables

Plan: section 6, Task 2.2 Step 1 (a)/(b), Step 2, Step 4; section 6 B
"Pinned shapes in dashboard/src/routes/listing/requirements.test.ts: :41-57
... and :224-262".

Evidence:
- dashboard/src/routes/listing/requirements.test.ts:307-316 - a block that
  says the app suites' cases are "copied VERBATIM (same `it` names, inputs
  and expected values ...)" and "When an app case changes, copy the change
  here."
- :343 `describe('REQUIREMENT_ITEMS - the eight items (D1)'`, :358
  `it('gives every field its unit key, landlord key, label, kind and flyer visibility'`,
  rows :369-374 end `'on_flyer'],` (the app tuple shape with the item id
  first - identical to app/test/requirements.test.ts:85-90).
- :591 `describe('PROPERTY_FORM_FIELDS - the D10a tag table'`, :592
  `it('lists every property-form field in form order with its tag (D10, D10a, plan AR1) - 35 rows'`,
  rows :601-602 (Rent min / max), :608-609 (Accessibility / Lease terms),
  :618-623 (the six Pets / Deposit rows), all `'on_flyer'` - identical to
  app/test/propertyFormFlyerParity.test.ts:183-205.

Task 2.2 Step 1 edits only the first pair (:48-53, :231-253). Step 3 then
re-tags the mirror, so the two copied cases above go RED, and Step 4's "The
Step 2 command: all green" fails (the Step 2 command and
`npx vitest run src/routes/listing src/routes/contact` both run this file).

Correction (Task 2.2, same commit, file already in its `git add`):
- Step 1 (g): in :369-374 make exactly S1 Task 1.1 Step 1a's replacement
  (the six tuples ending `'staff_only'],` and its leading comment line).
- Step 1 (h): insert S1 Task 1.1 Step 1b's new case
  ('flyer-leads D2: Application fee is the only requirement field On flyer')
  verbatim directly before :382
  `  it('flattens the 15 unit keys and the 15 req_ keys in item, then field, order', () => {`
  (unique in the file), as the block's own copy rule requires.
- Step 1 (i): make S1 Task 1.1 Step 1c's three replacements at :601-602,
  :608-609 and :618-623 (the same anchors and replacement text, including
  the two-line comment above Rent min; the indent is identical).
- Step 2 RED list: add these three cases (they read the not-yet-re-tagged
  mirror), so requirements.test.ts fails 5, not 2.
- Section 6 B: name both pinned pairs (:41-57 / :224-262 AND :358-380 /
  :592-632).

## F2 - MINOR - S1 commit template double-quotes the body, but both S1 bodies contain double quotes

Plan: section 5 C "Commit" step 4
`git commit -m "<subject>" -m "<body>" -m "Co-Authored-By: ..."`; Task 1.1
Step 6 body (`the "only ADDS keys" comment ...`); Task 1.2 Step 6 body
(`("se11", " SE11 " and "SE 11" are one subzone)`, `the "Same subzone" reason text`).

Pasting either body into the double-quoted `-m "<body>"` ends the argument
at the first inner quote and breaks the command. Correction: in section 5 C
single-quote every `-m` argument (neither S1 body contains an apostrophe),
the convention section 6 C already states.

## F3 - MINOR - dashboard/src/api/types.ts still says the trimmed fields are on the flyer; no slice edits these comments

Plan: Task 1.1 Step 3g fixes the app twin (unitsRepo.ts); no S2 (or other)
step touches the dashboard twin.

Evidence (the `Unit` wire type):
- dashboard/src/api/types.ts:2570-2571 lease_terms
  `PUBLIC: on the flyer (spec 2026-10-20 D10a). */`
- :2607 `/** Pets item: "No pets". On the flyer. */`
- :2609 pet_fee `... On the flyer. */`
- :2611 deposit_one_month `... On the flyer. */`
- :2613 deposit_flexible `... On the flyer. */`

Correction: add a comment-only step to Task 2.3 (it owns the D1 dashboard
type change; add types.ts to its Files and `git add`): end each of the five
with `Staff only (flyer-leads D1).` in place of the "on the flyer" claim,
ASCII, mirroring Step 3g's wording. S5 also edits types.ts (unions), so the
S5 builder must re-read the file, not revert it.

## F4 - MINOR - Task 2.4 (c) leaves a stale sentence in the mapsHref doc

Plan: section 6, Task 2.4 Step 3 (c) (two anchors only).

Evidence: dashboard/src/routes/public/FlyerPage.tsx:93-95 - "The parts are
joined with ', ' rather than reusing the DISPLAYED string, whose ' - '
separators are a presentation choice". The DISPLAYED string is
`addressLines`' ` - ` join (:85), which 2.4 (b) deletes; after 2.4 the
heading shows ', '-joined street and city lines, so the sentence describes
code that no longer exists.

Correction: in 2.4 (c) also replace that sentence, e.g. "The parts are
joined with ', ' into one free-text query (the heading shows the same parts
as a street line and a city line - flyerHeading)." Comment-only.

## N1 - NOTE - /join reuses FlyerPage.module.css, so 2.4 (i)'s `.title` change reaches it

dashboard/src/routes/public/HousingFairIntake.tsx:48 imports
`./FlyerPage.module.css` and uses `styles.title` (:159, :176), `card`,
`muted`, `cta`. Adding `overflow-wrap: anywhere` to `.title` is harmless
there, but section 6 E lists `.title`'s users without /join; the S2 builder
should not be surprised by it, and nobody should later "scope" `.title` to
the flyer without checking /join.

## N2 - NOTE - the stale-payload case never looks for an Address row

Spec section 5 "Flyer page" lists "no ... address row, even when a stale
payload is hand-fed those keys". Task 2.3 (c)'s stale case loops only
`['Deposit', 'Pets', 'Pet fee', 'Accessibility', 'Lease terms']` (2.3 lands
before 2.4 removes the row). The Address row's absence is pinned by 2.4's
dt-order case on the normal fixture, so coverage exists; optionally, in 2.4,
make the stale case assert the exact `dt` list too.

## N3 - NOTE - the "smaller" city line has no pin

Spec D3 item 2 says the second line is smaller. 2.4 (i) gives `.subline`
`--fs-md` against the h1's `--fs-xl`, but neither the DOM tests nor
FlyerPage.styles.test.ts pin it. Optional one-line pin in the styles test
(`bodyOf('.subline')` matches `font-size:\s*var\(--fs-(?:sm|md)\)`).

## N4 - NOTE - inline anchors carry presentation escapes that are not in the files; one count is off by one

Plan section 0 tells builders to strip the bullet indent only. Many inline
anchors also carry escapes the files do not hold: a backslash before a
backtick (S1 3e, 3g - e.g. unitsRepo.ts:423 holds a bare backtick), a
backslash before a double quote (S2 2.2 (d)/(e), 2.3 (c)/(e), 2.4 (c)/(d)),
and a literal backslash-n standing for a line break (S2 2.1 (d), 2.4 (c),
2.6 (c)). Strip them before an Edit. Also 2.3 (d) says "the four Pets cases" plus the
legacy-boolean and blank-pet-fee cases; the range :434-481 holds three
"Pets:" cases plus those two (five). The explicit line range is right; only
the count is off.
