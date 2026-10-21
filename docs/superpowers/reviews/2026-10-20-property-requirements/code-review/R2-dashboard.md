# R2 code review - DASHBOARD + E2E (reviewer R2D, fresh, round 2)

- Branch `feat/property-requirements`, HEAD `83ec4ee3` (after fix wave FW1b), merge base
  `3df43172`.
- Read: `R1-adversarial-dashboard.md`, `adjudications.md`, `build/FW1b-dashboard.md` (claims
  treated as claims), `.superpowers/review/pkg-fw1-dashboard.txt` (the fix diff, all of it),
  the feature's dashboard + e2e diff, the spec, plan 1.1's binding copy, and the source of
  every dashboard file the feature touches plus the app routes the dashboard calls
  (`contactRequirementsApply.ts`, the contacts list route, the units Activity projection).
- Gates observed before any test or file was created: `.superpowers/gates/fw1/summary.txt` at
  `83ec4ee3` ended `2026-10-21T04:13:27`: typecheck 0, test 0, smoke 0, e2e 0 (367 passed,
  18.8m), lint 1 = the same 5 pre-existing react-hooks errors R1 named
  (`BroadcastComposer.tsx:426`, `:445`, `useComposerDraft.ts:155`, `FlyerPage.tsx:177`, `:195`).
- Proof method: 7 throwaway files `zz-review-r2d-*` under `dashboard/src/` (20 tests), run with
  `cd W:/tmp/property-requirements/dashboard && npx vitest run src/<path>`; 19 one-line mutants
  applied and reverted with the Edit tool, each revert proven with
  `git -C W:/tmp/property-requirements diff --exit-code -- <file>`. All throwaways deleted by
  exact name; at the end `git diff --exit-code -- dashboard e2e app` was clean and
  `find dashboard/src -name 'zz-review-r2d-*'` empty. The load-bearing assertions are quoted
  below so each proof can be rebuilt.

## Counts

| Severity | Count | Ids |
|---|---|---|
| BLOCKER | 0 | - |
| HIGH | 0 | - |
| MEDIUM | 1 | R2D-1 |
| LOW | 8 | R2D-2 .. R2D-9 |
| INFO | 4 | R2D-10 .. R2D-13 |

## New findings

### R2D-1 - MEDIUM - Apply: a property staff UNCHECKED by hand comes back CHECKED after a failed, stopped or deposit_conflict Update, and "press Update again" writes it

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:152` - every successful read,
  including the re-read after a failure, runs `setHand(new Map())`; with no hand choice a row
  falls back to `rowIsChecked`'s default (`applyRequirementsModel.ts:86-91`: checked when no
  changing item is an own value). The re-read is triggered by every failure branch
  (`ApplyRequirementsDialog.tsx:220-237`), and the notices tell staff to press Update again
  (`applyRequirementsModel.ts:205-218`).
- Scenario: three properties with no own values (all start checked). Staff uncheck
  "2 Many St" - they want it left as it is - and press "Update 2 properties". The first
  request fails (a 5xx or a network blip): "Couldn't update the properties. Review the list and
  press Update again." The re-read puts "2 Many St" back to CHECKED and the button now reads
  "Update 3 properties"; pressing Update, as told, overwrites the property staff excluded.
  The same happens after a stopped run ("Review the rest and press Update again") and after a
  409 deposit_conflict. What is overwritten is a non-own value (a copied value the landlord has
  since changed, or a blank), and Activity records only field names, so the old value is gone.
- The defect is an asymmetry inside OR-17's own rule: the LEFT column carry "only ever copies
  LESS than staff chose" (`applyRequirementsModel.ts:47-62`, an item staff unchecked is never
  re-checked), but the RIGHT column re-checks a row staff unchecked. D8's hand rule ("A row
  staff UNCHECKED by hand stays unchecked") is written for left-column changes; nothing in the
  spec asks for an uncheck to be undone by a re-read.
- Proof: `zz-review-r2d-apply.test.tsx`, "R2D-8: comes back CHECKED, and press Update again then
  writes it" - PASSED on HEAD: first call `units` = `['u1', 'u3']`; after the re-read
  `getByRole('checkbox', { name: '2 Many St' })` is checked; the second call's `units` =
  `['u1', 'u2', 'u3']`. "R2D-8b" - PASSED: the same row is re-checked after a 409
  deposit_conflict re-read.
- Fix: carry the hand UNCHECKS across a re-read (keep `false` entries for rows that still exist
  and are not "Already matches"; drop the `true` ones, which is the safe direction - staff
  confirm a check again). That keeps "never writes more than staff chose" for rows too. A
  regression test: the R2D-8 scenario expecting "2 Many St" unchecked and "Update 2 properties".
- Severity note: rare trigger (a failed request), but normal operation, the dialog itself asks
  for the triggering click, and the loss is silent and unrecoverable. It is OR-17's explicit
  choice ("The row hand choices still reset"), which this finding challenges with evidence.

### R2D-2 - LOW - A Delete still in flight when the operator moves to another contact writes its error into that contact's Delete dialog, or navigates away from it

- Confidence: CONFIRMED.
- Where: `dashboard/src/routes/contact/ContactDetail.tsx:961-974` (`onConfirmDelete`: the
  `.catch` sets `deleteError` and the `.then` calls `navigate('/contacts')`, neither guarded by
  the contact it was pressed for) vs the RD-4 reset at `:370-371`, which clears `deleteError` at
  the change - and is then undone when the request settles. `deleteBusy` is not reset either
  (FW1b report: left alone as "request state"), so the next contact's Delete / Restore stay
  disabled until the old request settles.
- Scenario A: Delete on landlord L1, then Back to tenant z99 while the request is out; it fails;
  z99's Delete dialog opens with "Couldn't delete - please try again." under z99's name.
  Scenario B: it succeeds instead; the operator, now reading z99, is yanked to the Contacts list.
- Proof: `zz-review-r2d-contactdetail.test.tsx` (harness = ContactDetail.test.tsx lines
  1-369 verbatim) - "R2D-1a" PASSED: after `reject(new ApiError(500, ...))` lands on z99's page,
  `within(other).getByText('Bob Other')` and `within(other).getByRole('alert')` has
  `/Couldn.t delete/`. "R2D-1b" PASSED: after `resolve(...)`, `findByText('CONTACTS-LIST-PAGE')`.
- Same class, not new: the New property / New placement / Schedule a tour `onCreated` handlers
  (`:1451-1454`, `:1418-1421`, `:1439-1443`) navigate to the created record from whatever
  contact is on screen when an in-flight create resolves.
- Fix: the generation guard this page already uses for unread and extraction
  (`unreadGenerationRef`): capture it at the press and drop the resolution when the contact
  changed; reset `deleteBusy` with the other per-contact flags.

### R2D-3 - LOW - A later batch answering 409 deposit_conflict replaces D8's stop sentence: the count of properties already updated is lost

- Confidence: CONFIRMED (by code and by the committed test, which asserts the absence).
- Where: `ApplyRequirementsDialog.tsx:220-228` - the deposit_conflict branch is tested BEFORE
  `index > 0`, so on a later batch `stoppedNotice(...)` is never shown;
  `ApplyRequirementsDialog.test.tsx:511` pins `queryByText(/before this stopped/)` null.
- Contract: spec D8 and plan 1.1:198 - "If a later request answers 409 or fails, the dialog
  sends no more, re-reads ... and says 'Updated N properties before this stopped. Review the
  rest and press Update again.'" OR-31 says the deposit sentence is shown on any batch; it does
  not say the stop sentence is dropped. Batch 1 really did write 100 properties; nothing tells
  staff so (the re-read rows then read "Already matches", which looks like nothing happened).
  FW1b flagged this as "the same trade as RD-3"; it is a second loss on top of RD-3's (RD-3 drops
  the skips; this drops N).
- Fix: on a later batch show both - `stoppedNotice(n)` followed by the deposit sentence - and
  widen `docs/issues/apply-stopped-run-drops-earlier-skips.md` if left as is.

### R2D-4 - LOW - The RD-9 "one landlord name rule" is not applied in the picker path of the same New property dialog: one landlord, two names

- Confidence: CONFIRMED.
- Where: `UnitCreateForm.tsx:413-419` renders `ContactSearchField`, whose options and committed
  value use `contactDisplayName(first, last, primary ?? legacy phone)`
  (`ContactSearchField.tsx:82-83`, `:213`) - no company - and whose search matches only that
  name and the phone (`:76-89`); the note under it uses `landlordDisplayName` (`:98`, `:378`).
- Scenario: a company-only landlord "Kim Realty" with a primary phone. Typing "Kim" finds
  nothing; typing "555" finds "(404) 555-0100"; after the pick the owner field reads
  "(404) 555-0100" while the line under the Requirements heading reads "Filled in from Kim
  Realty's requirements." Before RD-9 both said the phone.
- Proof: `zz-review-r2d-unitcreate.test.tsx`, "R2D-2" PASSED:
  `queryByRole('option', { name: /Kim|555-0100/ })` null after typing "Kim";
  `owner` has value `'(404) 555-0100'`; `findByText("Filled in from Kim Realty's requirements.
  ...")` resolves.
- Name agreement across surfaces for that landlord (for Cameron's call): landlord page header =
  phone (`ContactDetail.tsx:660-662`), its facts line = company (`:1529`); property header facts
  = roster company (`ListingDetail.tsx:396`); property Requirements card note = company
  (`PropertyRequirementsCard.tsx:48`); New form locked box / loading / failure / note = company;
  New form picker = phone; Tours / Placements / TourDetail = `contactDisplayName(first, last,
  legacy phone)` (e.g. `TourDetail.tsx:210`) = legacy phone or "Unknown contact".
- Fix: use `landlordDisplayName` for the picker's option label and committed value (and let the
  search match the company), or keep the note on the picker's name.

### R2D-5 - LOW - The Application fee box disables itself while staff are still typing, whenever the partial value reads as 0

- Confidence: CONFIRMED.
- Where: `RequirementsFields.tsx:51` (`noFee = isNoApplicationFee(values)`, which is true for
  any text whose `Number()` is 0, `requirementForm.ts:65-68`) and `:99` (the amount input is
  `disabled` while `noFee`). The checkbox state is DERIVED from the typed text, so typing a 0
  first ticks "No application fee" and disables the field under the caret.
- Scenario: a $0.50 fee - typing stops at "0", the box is disabled and "No application fee" is
  ticked; or editing a stored "40" by deleting its leading 4 lands on "0" and locks the box.
  The way out (untick, which clears the amount, then retype) is not obvious. Same on the New,
  Edit and landlord forms (shared component).
- Proof: `zz-review-r2d-fields.test.tsx` - "R2D-4a" PASSED: after `user.type(fee, '0.50')`,
  `fee` has value `0`, is disabled, and "No application fee" is checked. "R2D-4b" PASSED: initial
  `application_fee: '40'`, `{Home}{Delete}` -> "No application fee" checked, `fee` disabled.
- Fix: keep "No application fee" as its own boolean in the form state (set by the checkbox
  only); the amount box is disabled only by the checkbox; a typed 0 stays an amount of 0.

### R2D-6 - LOW - The New form's D7 failure line is a live region inserted already filled - the RD-7 pattern, not swept

- Confidence: CONFIRMED (structure); PLAUSIBLE (assistive-technology effect, as RD-7).
- Where: `UnitCreateForm.tsx:726-741` - the loading line is a `<p role="status">` that is
  REPLACED by a new `<p role="status">` holding "Couldn't load <L>'s requirements, so this
  property starts without them. ..." when the read fails (same for the success path, where the
  status disappears).
- Why: the round-1 ruling accepted RD-7 for the landlord card ("a region inserted already
  filled may not be announced"); the same reasoning applies here, to a FAILURE message that also
  silently re-enables Create.
- Proof: `zz-review-r2d-unitcreate.test.tsx`, "R2D-6" PASSED: the loading element has
  `role="status"`; after the rejection the failure element has `role="status"`,
  `loading.isConnected === false`, and `failed !== loading`.
- Fix: one always-mounted `role="status"` region in the section whose text changes (or
  `role="alert"` for the failure).

### R2D-7 - LOW - Try again after a failed D7 read silently replaces what staff typed into the Requirements section

- Confidence: CONFIRMED.
- Where: `UnitCreateForm.tsx:223-240` (the read effect's success path runs
  `setRequirements(fill.values)` unconditionally) with `retryLandlordRead` at `:255-258`; while
  the read is retried the section is hidden (`:726-729`), so the replacement is never seen.
- Scenario: the locked landlord fails to load; the form says it starts without them and keeps
  the fields usable (D7); staff type "650 minimum" and "2x rent"; they press Try again; the read
  lands and the section is refilled from the landlord - "2x rent" is gone (the landlord has no
  income requirement), "650 minimum" became "600+", under "Filled in from ...".
- Proof: `zz-review-r2d-unitcreate.test.tsx`, "R2D-7" PASSED: after Try again,
  `getByLabelText('Credit score')` has `'600+'` and `getByLabelText('Income requirements')`
  has `''`.
- Fix: refill only fields still blank (or untouched since the failure), or confirm before
  replacing typed values; D7 specifies replacement only for a DIFFERENT landlord pick.

### R2D-8 - LOW - Public flyer: "Fits a 8-bedroom voucher", "Fits a 11-bedroom voucher", "Fits a 8- or 9-bedroom voucher"

- Confidence: CONFIRMED.
- Where: `FlyerPage.tsx:307` (`Fits a <strong>{voucher}</strong> voucher`) with `voucherPhrase`
  at `:65-72`; the binding copy (plan 1.1, "Fits a ..." for every case) has no "an" case.
  Picker B now offers chips 8 and 11 on every property form (D4), and the tenant-facing line
  prints the wrong article for them. The single-size case predates the branch; the multi-size
  phrase is new.
- Proof: `zz-review-r2d-flyer.test.tsx`, "R2D-5" x3 PASSED, e.g. `voucher_sizes: [8]` renders
  the facts item `Fits a 8-bedroom voucher`; `[8, 9]` renders `Fits a 8- or 9-bedroom voucher`.
- Fix: "an" when the phrase starts with 8, 11 or 18 (8 and 11 within 0..12); add the cases to
  the D11 table. A copy decision for Cameron.

### R2D-9 - LOW - Three of the nine RD-4 resets are unpinned (mutants survive the committed suite), and one of them guards a real cross-tenant leak

- Confidence: CONFIRMED (mutation evidence below).
- Where: `ContactDetail.tsx:366-368` (`setStartingPlacement(false)`, `setSchedulingTour(false)`,
  `setTourUnitOverride(undefined)`); FW1b listed them as "a known gap".
- Evidence: each line commented out alone -> the committed `ContactDetail.test.tsx` stays
  145/145 green; my throwaways kill each:
  - MD (placement) -> killed only by "R2D-T1" (the "New placement" dialog re-mounts for z99);
  - ME (schedule) -> killed only by "R2D-T2";
  - MF (override) -> killed only by "R2D-T3": k1's Interested on "1450 Joseph Blvd" sets the
    override, the operator moves to tenant z99 and presses "Schedule a tour", and the dialog
    pre-commits k1's property instead of z99's latest send ("88 Sycamore St").
- Fix: add the three tenant-page rows (the R2D-T1..T3 shapes) to the RD-4 describe.

## INFO

### R2D-10 - INFO - Sub-cent requirement money still shows a difference nobody can see (RD-2 residual)

- `requirements.ts:328-331`: `formatRequirementMoney(1250.004)` = `$1,250.00`, and
  `requirementDisplay(unit({ deposit: 1250.004 }), landlord({ req_deposit: 1250 }), 'deposit')`
  = `{ tag: 'set_here', landlordLine: 'Landlord: $1,250' }`; `formatRequirementMoney(1250.999)`
  = `$1,251.00` against a property's `$1,251`; a 0.004 fee reads `$0.00` beside the 0 that reads
  "No application fee". D1 money accepts any finite number and the inputs take `step="any"`.
  Proof: `zz-review-r2d-money.test.ts`, 3 tests PASSED. Fix if wanted: round to cents at the
  form boundary (or compare money to the cent).

### R2D-11 - INFO - On a record holding BOTH deposit forms, the edit forms' refusal copy says "Reload ... and try again", which cannot help

- `ContactEditForm.tsx:121-122` and `ListingEditForm.tsx:59-60`. A save that touches another
  Deposit key (e.g. ticks Flexible) on such a record gets 400 deposit_conflict and
  "A deposit can be one month's rent or a fixed amount, not both. Reload the landlord and try
  again." - a reload shows the same record. The remedy works (checked sound, below): untick
  "One month's rent" and save. Reachable only by a direct data edit since OR-30. Proof:
  `zz-review-r2d-editform.test.tsx` "R2D-F2" PASSED (`updateContact` body
  `{ req_deposit_flexible: true }`, then that sentence).

### R2D-12 - INFO - Narrow viewports: the nowrap tag can overflow the property Requirements card in its multi-item groups

- PLAUSIBLE (CSS reasoning; Playwright is outside this review's rules).
  `PropertyRequirementsCard.module.css:32-36` (label `flex: 0 0 auto; min-width: 120px`),
  `:38-44` (body `min-width: 0`), `:52-61` (tag `white-space: nowrap`, 12px semibold plus 16px
  padding, about 140px for "Set on this property"). With 12px card padding, at a 320-340px
  viewport the body beside "Income requirements" is roughly 125-140px, so the tag can stick out
  of the card. Fix if confirmed: let `.item` wrap below a breakpoint, or allow the tag to wrap.

### R2D-13 - INFO - The deposit_conflict notice says "then press Update again", but the fix is behind the modal

- `applyRequirementsModel.ts:217-218`. "Edit requirements" is on the card behind the dialog,
  so staff must Cancel, fix, and open Apply to properties again; there is no Update to press
  again in the dialog that showed the sentence. Copy for Cameron's eye (OR-31 flagged it).

## Adjudication challenges

- C1 - OR-17 (worklist ruling, the row hand-choice reset): challenged by R2D-1 - the reset
  re-checks rows staff unchecked and the notices then ask for the click that writes them. The
  ruling's own left-column principle (copy only LESS) should apply to rows.
- C2 - RD-1 / OR-31 (ACCEPT): the implementation drops D8's stop sentence on a later batch
  (`ApplyRequirementsDialog.tsx:220-228`, pinned absent at `ApplyRequirementsDialog.test.tsx:511`).
  The ruling authorized a new sentence, not the removal of a spec'd one (R2D-3).
- C3 - RD-4 (ACCEPT): met in code for all nine flags, but three are unpinned (R2D-9) and the
  Delete error reset is undone by an in-flight request (R2D-2). Verdict for the item: partly
  REAL, partly PLAUSIBLE (table below).
- C4 - RD-9 (ACCEPT): the ruling's two clauses disagree for a company-only landlord - "the name
  the landlord page itself shows" is the phone (`ContactDetail.tsx:660-662`), while "company /
  primary phone fallbacks" puts the company first. FW1b chose the company (flagged for Cameron).
  The "ONE rule" also misses the New form's own picker (R2D-4).
- C5 - RD-7 (ACCEPT, "cheap a11y"): scoped to the landlord card; the same pattern ships in the
  New form's D7 lines (R2D-6). Not a wrong ruling - an incomplete sweep.
- C6 - RD-3 (FILE): agree with the reason (the skips that vanish from the re-read are rows no
  longer this landlord's, deleted or gone) - but the filed issue should also name R2D-3.
- RD-2's flyer carve-out: the reason is right (plan 1.1:221 "`$N` uses the flyer's EXISTING
  dollar formatter"); note only that the public flyer therefore prints `$1250.5` and `$1800`
  (no grouping), pre-existing. RD-10, RD-11, RD-12, RD-13 and RA-10: agree.

## Per-fix verdicts (mutant evidence)

| Fix | Verdict | Evidence |
|---|---|---|
| RD-1 dialog (OR-31) | REAL | A2 (`index === 0 &&` on the deposit branch) KILLED by `:498` (later batch). A3 (deposit branch `carryRef.current = null`) KILLED by `:524` (FW1b M1 confirmed). A5 (deposit branch returns before the re-read) KILLED by 3 (`:478`, `:498`, `:524`). Residuals: R2D-1, R2D-3, R2D-13. |
| RD-1 display (both forms) | REAL | D1 (restore the `else`) KILLED by `requirements.display.test.ts` both-forms case and dialog `:478`, `:498`. The server's 409 condition (`hasDepositConflict`, app `lib/requirements.ts:285-291`) and the display agree for every non-negative amount. |
| RD-2 cents | REAL | R1 (`? 2 : 2`, always cents) KILLED by 6 display cases; R3 (`Math.round`) KILLED by 3 (incl. `Landlord: $1,250.40`). Residual R2D-10 (sub-cent). |
| RD-6 cycle | REAL | Import graph re-read: no cycle among requirements / listingFormat / contact/format / contactPhones / buildListingFile / requirementForm / applyRequirementsModel. R6 (re-add the import plus a top-level use) KILLED only by the source guard - no runtime TDZ even then (formatMoney is a hoisted function declaration), so the guard is the only detector, as FW1b said. |
| RD-4 reset | REAL x6, PLAUSIBLE x3 | KILLED by committed rows: MA editing, MB managingPhones, MC creatingRelayGroup, MG addingProperty, MH confirmingDelete (also by R2D-1a), MI deleteError. SURVIVED the committed suite (145/145) and KILLED only by throwaways: MD startingPlacement (R2D-T1), ME schedulingTour (R2D-T2), MF tourUnitOverride (R2D-T3). Plus R2D-2. |
| RD-5 copy | REAL | Exact `getByText` pin plus absence of the old sentence (`ListingDetail.test.tsx:343-347`); not re-mutated (killed by construction). |
| RD-7 live region | REAL | L1 (`role` only with a result) KILLED by `LandlordRequirementsCard.test.tsx:93` and the ContactDetail OR-18 case. The region survives `file.refetch()` (useContactFile keeps committed state on a reload) and `onLandlordRead`. AT effect remains PLAUSIBLE. |
| RD-8 contrast | REAL | `#92400e` on `#ffffff` computed 7.09:1 (needs 4.5:1). The test is a CSS source-text check (FW1b M9 killed); not re-mutated. |
| RD-9 name rule | REAL (card + locked New form) | N1 (company step disabled) KILLED by 5 (format x2, card x1, New form x2). Not applied to the picker path (R2D-4). |
| RD-10 comment | REAL (doc) | Matches the code: no AbortSignal on the apply calls; `liveRef` gates only UI. |
| RD-12 doc | REAL (doc) | Matches `app/src/routes/units.ts:384-390`. |
| RC-11 | REAL (PIN) | Green on unchanged code by design; title prints correctly. |
| O-1 titles | REAL | Verbose reporter: `Deposit {"deposit":1800} reads "$1800"`; across the 10 feature test files with each() tables (556 tests) the only title containing "undefined" is the legitimate "leaves name undefined for a deleted contact". |

## Checked and found sound

- Server order matches the dialog: 400 body, then 409 deposit_conflict decided regardless of
  whether Deposit is listed, then 409 requirements_changed (`contactRequirementsApply.ts:154-176`).
  So unticking Deposit cannot help, the notice does not suggest it, and "any batch" is right.
  `ApiError.code` is the body's `error` (`client.ts:75-80`).
- OR-31's remedy is actionable: a both-forms landlord's edit form shows "One month's rent"
  checked and "Fixed amount" 1400 disabled; unticking and saving sends exactly
  `{ req_deposit_one_month: null }` (`zz-review-r2d-editform.test.tsx` "R2D-F1" PASSED).
- RD-4: every dialog flag ContactDetail owns is in the reset (`useState` list at `:202-285`);
  dialog state held by child components resets by unmount (the loading early return at
  `:621-627`); `pane` is correctly kept; no dialog is opened from the URL, so the mount-time run
  of the reset cannot close a deep-linked dialog; StrictMode's double mount run is harmless.
- Tag and notice contrast on white: Clears 7.09:1; "Landlord updated" 6.37:1; "Set on this
  property" 7.1:1; "On flyer" 5.09:1; "Staff only" 5.36:1; the dialog's amber notice 6.37:1.
- e2e after FW1b: gate 4 green (367); FW1b changed only `selectors.md` there; no spec asserts
  the presence of the landlord card's status region.

## Consumer sweep of what FW1b changed

| Changed | Writers | Readers | Verdict |
|---|---|---|---|
| `formatItemValue('deposit')` shows both forms | - | LandlordRequirementsCard value, PropertyRequirementsCard value, Apply left column, `requirementDisplay` landlord lines; the flyer has its own label (one month wins, `FlyerPage.tsx:141`) | OK |
| `formatRequirementMoney` | - | only `formatItemValue`'s `money()`; rent / payment standard keep `formatMoney`, the flyer keeps `$N` | OK (R2D-10) |
| `landlordDisplayName` | - | `PropertyRequirementsCard.tsx:48`, `UnitCreateForm.tsx:98`, `:212`; NOT ContactSearchField, ContactDetail header, tours / placements | R2D-4 |
| `DEPOSIT_CONFLICT_NOTICE` | dialog catch `:224` | dialog alert; `selectors.md` | R2D-3, R2D-13 |
| Always-mounted `role="status"` | ContactDetail `applyDone` | LandlordRequirementsCard; e2e reads by text | OK |
| ContactDetail reset (9 setters) | `:363-371` | the nine dialogs | R2D-2, R2D-9 |
| `contactPhones.ts` type-only import path | - | format.ts (and the e2e compile of it) | OK |
