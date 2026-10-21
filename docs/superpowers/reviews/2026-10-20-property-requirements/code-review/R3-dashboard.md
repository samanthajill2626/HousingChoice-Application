# R3 code review - DASHBOARD (reviewer R3, fresh, round 3)

- Branch `feat/property-requirements`, HEAD `1009a5e1` (after fix waves FW2 and FW3), merge
  base `3df43172`. Scope: the dashboard state FW2 (round-2 findings) and FW3 (live self-QA
  QA-1, QA-2) changed, reviewed cold, then the fixes themselves.
- Read: `R2-dashboard.md`, `adjudications.md` (rounds 1 and 2, OR-17 / OR-31 / OR-32 /
  OR-33), `build/FW2-dashboard.md` and `build/FW3-selfqa.md` (claims treated as claims),
  `self-qa.md`, `.superpowers/review/pkg-fw2-dashboard.txt` (the whole fix diff),
  `build/U12-S6b.md` (OR-17's recorded consequences), spec D1 and D5-D12, plan 1.1
  (binding copy) and 2.6 (binding interfaces), and the current source of every touched
  file plus their callers (ContactDetail, ListingDetail, ContactSearchField, the three
  forms, LandlordRequirementsCard, FlyerPage, the e2e spec and selectors).
- Gates observed before any file was created or test run: `.superpowers/gates/final2/
  summary.txt` at `1009a5e1` ended `2026-10-21T06:25:50`: typecheck 0, test 0, smoke 0,
  e2e 0 (367 passed, 21.1m), lint 1 = the same 5 pre-existing react-hooks errors
  (`BroadcastComposer.tsx:426`, `:445`, `useComposerDraft.ts:155`, `FlyerPage.tsx:185`,
  `:203` - the last two are R2's `:177` / `:195` moved down by R2D-8's 8 added lines).
  Before the first edit the gate's e2e launcher (pid 65216, lane 10) was gone and ports
  10001 / 10011 / 10021 / 10031 had no listener.
- Proof method: 3 throwaway files `zz-review-r3-*` under `dashboard/src/` (11 tests:
  `listing/zz-review-r3-card.test.tsx` cases a-c, `contact/zz-review-r3-apply.test.tsx`
  cases RCa, RCb, SM-1, Clears-a, Clears-b, `listing/zz-review-r3-picker.test.tsx` cases
  SM-2, picker-a, picker-b), run with
  `cd W:/tmp/property-requirements/dashboard && npx vitest run src/<path>`; 15 source edits
  (14 mutants and one fix probe) applied and reverted with the Edit tool, each revert proven
  with `git -C W:/tmp/property-requirements diff --exit-code -- <file>`. Baseline of the 12
  touched suites at HEAD: 649/649. All throwaways deleted by exact name; at the end
  `git diff --exit-code -- dashboard e2e app` was clean, `git status --short` empty and
  `find dashboard/src -name 'zz-review-r3-*'` empty. The load-bearing assertions are quoted
  so each proof can be rebuilt.

## Counts

| Severity | Count | Ids |
|---|---|---|
| BLOCKER | 0 | - |
| HIGH | 0 | - |
| MEDIUM | 1 | R3-1 |
| LOW | 2 | R3-2, R3-3 |
| INFO | 2 | R3-4, R3-5 |

## New findings

### R3-1 - MEDIUM - Apply: a first-request 409 requirements_changed re-checks the properties and items staff excluded, and "press Update again" writes them

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:251-253` - the
  requirements_changed branch sets `carryRef.current = null`, so the next read
  (`:169-173`) starts the left column from `defaultCheckedItems` and the rows from
  `new Map()`. Pinned AS INTENDED by `ApplyRequirementsDialog.test.tsx:446-462` (an item
  staff unchecked comes back checked) and `:652-668` (a row staff unchecked comes back
  checked, "Update 3 properties").
- Scenario (rows): three properties with no own values; staff uncheck "2 Many St" - they
  want it left as it is - and press "Update 2 properties". A colleague changed the
  landlord's pet fee while staff were reviewing: 409 requirements_changed. The re-read
  shows "2 Many St" CHECKED, the button reads "Update 3 properties" and the notice says
  "This landlord's requirements changed. Review the updated list and press Update again."
  Pressing it, as told, overwrites the property staff excluded. Scenario (items): staff
  leave an item out (OR-17's own example is Touring - copying a tour type changes how an
  interested reply routes, spec section 4); the same 409 re-checks it and the next Update
  copies it everywhere. What is overwritten is a non-own value, and Activity records only
  field names, so the old value is gone - exactly R2D-1's harm.
- Why this is a defect and not the spec: OR-32 states the invariant "no re-read ever writes
  more than staff chose, rows and items alike", then exempts this path citing "the spec's
  'Review the updated list'". Spec D8
  (`docs/superpowers/specs/2026-10-20-property-requirements-design.md:554-556`) only says the
  dialog re-reads and shows that sentence; it never says the choices reset. D8's hand rule
  ("A row staff UNCHECKED by hand stays unchecked (unless it becomes 'Already matches')",
  same file `:534-535`) has no exception. The left-column half is OR-17's round-1 carve-out,
  the row half OR-32's; both live in the one line above. The plan's dialog reset the
  choices on EVERY read; OR-17 and OR-32 rejected that for the failure paths, whose notice
  says the same thing ("Review the list and press Update again"). R2D-1's severity rationale (rare trigger, normal operation, the dialog asks
  for the writing click, the loss is silent and unrecoverable) applies unchanged, and a
  colleague editing the landlord while the dialog is open is at least as likely as a 5xx.
  No recorded Cameron decision covers it (grep of intent, design and plan reviews).
- Proof: `zz-review-r3-apply.test.tsx`, both PASSED on HEAD:
  - "R3-RCa": `getContact` `.mockResolvedValueOnce(LANDLORD).mockResolvedValue({ ...LANDLORD,
    req_pet_fee: '$350' })`, apply `.mockRejectedValueOnce(new ApiError(409,
    'requirements_changed', ...))`; first call `units` = `['u0', 'u2']`; after the re-read
    `getByRole('checkbox', { name: '2 Many St' })` is checked; after a click on
    `Update 3 properties` the second call's `units` = `['u0', 'u1', 'u2']`.
  - "R3-RCb": staff uncheck Credit score; first call `items` excludes
    `credit_requirements`; after the re-read Credit score is checked; the second call's
    `items` contains `credit_requirements`.
- Fix (one line, probed): `ApplyRequirementsDialog.tsx:253` `carryRef.current = goesOn;`
  (keep `REQUIREMENTS_CHANGED_NOTICE`). Probe: with that line, exactly the two carve-out pins
  (`:446`, `:652`) and the two RC throwaways flip; everything else in that run (201 tests:
  the whole dialog, model and ContactDetail suites plus the other throwaways) stays green.
  Result: the left column is what staff had checked that the new landlord still holds (a
  changed value stays checked and shows its new text - what "Review the updated list" asks
  staff to look at; an item the landlord newly filled starts unchecked - staff never chose
  it); rows keep their unchecks; hand checks drop as on every other re-read. Update the two pins and the OR-17 / OR-32 comments
  (`:24-35`, `applyRequirementsModel.ts:47-57`, `:117-126`).

### R3-2 - LOW - QA-2's period drop makes a real difference invisible on the property card: a tag over two identical lines

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/listing/requirements.ts:400-405` (FW3 `77abd659`), read by
  the card's value (`PropertyRequirementsCard.tsx:64`) and its landlord line
  (`requirementDisplay`, `requirements.ts:422`). Equality stays exact (D1,
  `itemValuesEqual`), so the tag is right; only the text hiding why is new.
- Scenario: landlord Pets = No pets, "Service animals only", "$300"; property Pets = No
  pets, "Service animals only." (one period - human-typed free text; the full demo cast's
  landlord holds exactly `req_pets: 'Service animals only.'`, `app/src/lib/seed/cast.ts:1337`,
  and self-QA added a pet fee to it). The card shows purple "Set on this property", the
  value `No pets; Service animals only; pet fee $300` and the line
  `Landlord: No pets; Service animals only; pet fee $300` - the same text under a tag that
  says they differ. The copied case shows orange "Landlord updated" over
  `Landlord now: <the same text>`. A details part that is only "." vanishes, so "." and
  blank details collide too. The Apply dialog then lists that property's Pets as an
  own-value change with no visible reason. Before FW3 the period showed (`only.; pet fee`).
  This is the RD-2 class ("a tag / an Apply change nobody can see", ACCEPTED LOW and fixed in
  FW1b) reintroduced by a cosmetic self-QA call. It also departs from plan 2.6's binding
  description of `formatItemValue` ("the parts below joined by '; '"); FW3's own ".." for a
  trailing ellipsis is the same rule's other cost.
- Proof: `zz-review-r3-card.test.tsx`, 3 cases PASSED on HEAD - (a)
  `within(pets).getByText('Set on this property')`, `getByText(SAME)` and
  `getByText('Landlord: ' + SAME)` with `SAME = 'No pets; Service animals only; pet fee $300'`
  while `itemValuesEqual(...)` is false; (b) the copied / Landlord updated twin; (c)
  `formatItemValue('pets', own) === formatItemValue('pets', theirs)` and the "." vs blank
  collision. With QA-2 reverted (the QA-2 mutant in the verdict table) all three FAIL - the
  collision is new with `77abd659`.
- Fix: revert QA-2 (".;" is cosmetic, a hidden difference is not), or keep it and, in
  `requirementDisplay`, fall back to the plain join for both texts whenever the two
  formatted strings are equal while `itemValuesEqual` is false.

### R3-3 - LOW - A "Clears" item staff checked on purpose is dropped by every preserving re-read; after a mid-run stop the continued run silently omits it

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/contact/applyRequirementsModel.ts:58-63` -
  `carryCheckedItems` = `defaultCheckedItems(landlord)` INTERSECT `previous`, and the
  defaults never hold a blank item. Recorded as a consequence in `build/U12-S6b.md`
  Divergence 1 ("even a 'Clears' item staff had checked on purpose") but never reviewed as
  a finding; R2D-3's restored stop sentence now tells staff the run continues.
- Scenario: the landlord's Touring is blank ("Clears"). Staff check it to clear Touring on
  every property, with the filled items, and press "Update 150 properties". Batch 1 (100)
  lands with `touring`; batch 2 fails on a network blip; "Updated 100 properties before this
  stopped. Review the rest and press Update again." The re-read unchecks Touring although the
  landlord did not change; pressing Update sends the last 50 without it; the run finishes.
  One Apply leaves 100 properties cleared and 50 not, and the done line says only
  "Updated N". OR-17's stated purpose ("never a surprise Clears") is an item the landlord
  BLANKED since the click; an item that was blank when staff checked it is no surprise.
- Proof: `zz-review-r3-apply.test.tsx` case Clears-a PASSED (150 units with
  `tour_type: 'self_guided'`, `requirement_sources: { touring: 'copied' }`):
  `toHaveAccessibleDescription('Clears')` then a click; calls 0 and 1 `items` contain
  `touring`; after the re-read Touring is not checked (Pets still is); calls 2 and 3 `items`
  do not contain `touring`. Case Clears-b PASSED (a first-request 500: the same drop).
- Fix: carry a checked item whose landlord value is unchanged since the click, blank
  included (keep the click-time landlord in `ApplyCarry`, compare with `itemValuesEqual`);
  uncheck only an item whose value changed to blank. Or Cameron accepts it and the
  `apply-stopped-run-drops-earlier-skips` issue names it.

### R3-4 - INFO - OR-33's "its picker agrees" holds only when the landlord has a name or a primary phone

- Confidence: CONFIRMED.
- Where: `ContactSearchField.tsx:82-83`, `:212-213`, `:294-295` name a contact by
  `primary ?? legacy phone`; `contactHeaderName` (`format.ts:156-158`) by `defaultPhone` -
  the primary, else the most recent `lastSeenAt`, else the first of phones[], before the
  legacy phone. FW2 named this residual ("the dev zero-primary fixture shape").
- Scenario: a nameless landlord whose phones[] has no primary (most recent +14045550122) and
  a legacy +14045550199: the New form's owner field commits "(404) 555-0199" while its note
  reads "Filled in from (404) 555-0122's requirements. ..." and the landlord page header
  shows (404) 555-0122. With no legacy phone the picker reads "Unknown contact".
- Proof: `zz-review-r3-picker.test.tsx` case picker-a `contactHeaderName(NO_PRIMARY)` =
  `'(404) 555-0122'`; case picker-b PASSED: after typing `555-0199` and picking the option,
  `owner` has value `'(404) 555-0199'` and
  `findByText("Filled in from (404) 555-0122's requirements. ...")` resolves.
- Fix if wanted: ContactSearchField's label through `contactHeaderName` (one expression for
  every picker), else leave it; `e2e/support/selectors.md` row 134 should then not say "else
  the primary phone ... and the New form's landlord picker too" (it is the default phone,
  and the picker agrees only with a primary).

### R3-5 - INFO - The later-batch deposit_conflict alert gives two opposite instructions, and following the operative one discards the only record of N

- `ApplyRequirementsDialog.tsx:240`, `:246`: "Updated 100 properties before this stopped.
  Review the rest and press Update again." then "Close this, fix it with Edit requirements,
  then open Apply to properties again." FW2 flagged the pairing for Cameron. Added here:
  closing, as told, calls only `onClose(true)` (`ContactDetail.tsx:1469-1472`) - no
  `applyDone`, so the landlord card never shows "Updated 100 properties", and reopening
  starts fresh. Every stop behaves so today (the RD-3 class), but this sentence is the one
  that instructs the close. A merged later-batch sentence (copy for Cameron) would carry the
  count and the remedy together.

## Adjudication challenges

- C1 - OR-32 (and OR-17) carve-out for a first-request 409 requirements_changed: challenged by
  R3-1 (MEDIUM) - it re-creates R2D-1's hazard on a sibling path, breaks OR-32's own stated
  invariant, and rests on notice wording the spec does not tie to a reset
  (`ApplyRequirementsDialog.tsx:251-253`, pins `ApplyRequirementsDialog.test.tsx:446-462`,
  `:652-668`). One-line fix probed above.
- C2 - OR-33: its premise "so the card, the New form's note / loading / failure lines, its
  picker and the landlord page agree" is not met for a phones[] list without a primary
  (R3-4). And on the property page itself the header facts name a company-only landlord by
  its roster company (`ListingDetail.tsx:396` -> `buildListingFacts`) while the Requirements
  card names the same landlord by its phone or "Unknown contact"
  (`PropertyRequirementsCard.tsx:49`): one page, two names. Not a reversal request - plan
  1.1's "display name" reading is defensible - but both belong in the handback next to the
  company-first product change OR-33 already names.
- C3 - OR-17's recorded sub-rule that a checked "Clears" item never carries (U12-S6b
  Divergence 1): challenged by R3-3 (LOW) - the rule's purpose covers an item the landlord
  blanked since the click, not one that was blank when staff chose it.
- C4 - QA-2 (an orchestrator self-QA call, not a table ruling): challenged by R3-2 (LOW) -
  revert, or add the equal-text fallback.
- Agree: OR-32 dropping hand CHECKS on a preserving re-read (the safe direction, visible
  under "Review the rest"); R2D-2 FILE; R2D-10 and R2D-11 NO ACTION; R2D-12 deferred to
  self-QA and fixed as QA-1; R2D-13's copy; R2D-8's two-number rule (a legacy 18 still reads
  "a 18-", outside D4, as FW2 says).

## Per-fix verdicts (mutant evidence)

Each mutant reverts the fix (or breaks its core rule) in one small edit (one line, except the
OR-33 and QA-2 reverts, which restore the old function body); counts are failed / total of
the committed suites named; every revert was proven clean with `git diff --exit-code`.

| Fix | Verdict | Evidence |
|---|---|---|
| R2D-1 / OR-32 (`5dcbaef0`) | REAL | MUT-1 `setHand(new Map())` at `ApplyRequirementsDialog.tsx:173`: dialog + model 3/52 (the three OR-32 dialog cases: first-request failure, deposit_conflict, mid-run stop). NM-B `carryHandUnchecks` carrying hand checks too (`applyRequirementsModel.ts:130`): 2/52 (dialog and model "checked by hand goes back" PINs). StrictMode probe SM-1 (throwaway): the uncheck survives the re-read under double effects; the aborted mount read never touches the carry (`:161` returns before `:169`). Residuals: R3-1, R3-3. |
| R2D-3 (`696e63fb`) | REAL | MUT-2 `setNotice([DEPOSIT_CONFLICT_NOTICE])` at `:246`: 1/29 (the later-batch case). The first-batch "deposit sentence alone" case pins the other direction. Copy residual R3-5. |
| R2D-13 (`8fc45f8a`) | REAL | MUT-3 the old sentence at `applyRequirementsModel.ts:239`: 4/52 (model copy test + dialog cases reading the constant). |
| R2D-4 / OR-33 (`63d9562c`) | REAL (residual R3-4) | MUT-4 the company step restored in `landlordDisplayName` (`format.ts:167`): format + card + New form 7/114. `contactHeaderName` is byte-for-byte the header's previous expression (`contactPhones` + `defaultPhone`), so the header did not change. |
| R2D-5 (`1d357edd`) | REAL | MUT-5 `noApplicationFeeChecked` always derived from the text (`requirementForm.ts:84`): 11/339 across requirementForm, RequirementsFields, ListingEditForm, UnitCreateForm and ContactEditForm, including the exact-body send pins (`ListingEditForm.test.tsx:798`, `:808`, `ContactEditForm.test.tsx:1522`, `UnitCreateForm.test.tsx:850`). NM-D the checkbox no longer writes the flag (`RequirementsFields.tsx:89`, so a box cannot be ticked after typing an amount): 1/304 - killed only by the component's "only the checkbox sets the flag" case; no form-level case covers tick-after-typing (adequate, the component is shared). |
| R2D-6 (`f3d5dd31`) | REAL | MUT-6 `key={landlordRead}` on the status `<p>` (`UnitCreateForm.tsx:752`, a new element per state = "inserted already filled"): 1/81 (the region `toBe(region)` case). |
| R2D-7 (`95b6acea`) | REAL | MUT-7 `setRequirements(fill.values)` at `UnitCreateForm.tsx:241`: 2/81 (both Try again cases). StrictMode probe SM-2 (throwaway): typed Credit score kept, blank items filled, Create body has no key containing `form:` and carries the snapshot. |
| R2D-8 (`508f34fa`) | REAL | MUT-8 `Fits a <strong>` at `FlyerPage.tsx:315`: 5/51 (the five "an" rows). |
| R2D-9 (`b5b97a70`, tests only) | REAL | Each reset commented out alone at `ContactDetail.tsx:366` / `:367` / `:368`: whole ContactDetail suite 1/148 (New placement row), 2/148 (Schedule a tour row + override case), 1/3 with `-t R2D-9` (the override case). |
| QA-2 (`77abd659`) | REAL as a fix; it introduces R3-2 | QA-2 mutant: the plain `parts.join('; ')` at `requirements.ts:400-405`: display 3/26 committed, and the three R3-2 throwaway cases fail with it too (the collision exists only with QA-2). |
| QA-1 (`a34ce83c`, CSS) | REAL by reading (jsdom runs `css: false`; FW3's harness and the lane re-measure stand) | Sound: `.item` is a flex row whose label is `flex: 0 0 auto; min-width: 120px` and whose `.itemBody` has `min-width: 0`, so the body shrinks to the remaining width; the tag is a flex item (default `flex-shrink: 1`) with `max-width: 100%` of that body, and `white-space: normal` + `overflow-wrap: anywhere` cut its min-content contribution to about one character, so it shrinks and wraps inside the card instead of overflowing. Flex line breaking uses the items' max-content hypothetical sizes, so wherever the tag fit on one line before it lays out identically (FW3: identical boxes from a 255px card up) - no breakpoint needed. `text-align: center` is inert on one line. Mid-word breaks start only below about 66px of column (longest word + 16px padding), i.e. below FW3's 149px card floor. The class names are used only by this card (grep). |

## Checked and found sound

- The fee flag never reaches the wire: every builder iterates `REQUIREMENT_FIELDS`
  (`requirementForm.ts:113`, `:140`), `toLandlordPatch` maps only patch keys, and no form
  spreads its values object into a body (UnitCreateForm `buildBody`, ListingEditForm
  `buildPatch`, ContactEditForm `buildPatch`). No test fixture sends values carrying it; the
  exact-body pins above would catch a leak.
- Dirty-checking: neither edit form has a guard beyond "an empty patch closes"
  (`ListingEditForm.tsx:251`, `ContactEditForm.tsx:524`); `recordedText` makes a tick /
  untick / retype round trip back to the stored value produce an empty patch.
- The flag's state machine: the amount is enabled only while the flag reads false, so the
  amount edit's pin always writes false; the checkbox always writes `'0'` with true and
  `''` with false; `fillBlankRequirementItems` re-derives the flag for a filled fee item; the
  picker path's whole refill drops any flag, so the new landlord's fee derives afresh.
- R2D-7: the fields are not rendered while the read runs (`UnitCreateForm.tsx:763`), so no
  typing races the functional updater; the updater is pure (StrictMode double-invoke safe);
  the snapshot is the landlord's values; the picker path keeps D7's replacement.
- R2D-6 CSS: the empty region takes no space (`.hint` margin 0, `.sectionHead` no gap);
  `.sectionStatus` `margin-top: var(--sp-3)` equals the form's gap, so the filled line sits
  where the old one did.
- Apply hand capture: `goesOn` holds the click-time `checkedItems` / `hand`; every control is
  disabled while sending, and `reload()` sets loading synchronously in the catch, so no
  choice can change between the failure and the re-read.
- The flyer article: only the facts line renders the phrase; the e2e flyer specs use sizes 2
  and 3; legacy 8.5 / 11.5 read "an" correctly.
- e2e: gate 4 green at `1009a5e1` (367/367); no spec reads the dialog's alert or the New
  form's status by role; the spec's pets details carry no trailing period, so QA-2 changes
  no asserted string.
