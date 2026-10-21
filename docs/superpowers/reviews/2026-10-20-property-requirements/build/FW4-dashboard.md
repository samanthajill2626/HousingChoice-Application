# FW4 (dashboard) - code review round 3 micro fix wave: R3-1 (OR-34), R3-3 (OR-35), R3-2 (revert QA-2)

- Unit: FW4, implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `98512bf6` (the round 3 adjudications commit).
- Work list (binding): `code-review/adjudications.md` "Round 3" - R3-1 via
  OR-34, R3-3 via OR-35, R3-2 = revert QA-2 (plan 2.6 plain join). Findings,
  proofs and probed fixes: `code-review/R3-dashboard.md`. Code built by
  `build/U12-S6b.md` (dialog, OR-17 carry), `build/FW2-dashboard.md` (OR-32
  carryHandUnchecks), `build/FW3-selfqa.md` (QA-2).
- STOP items: none. Only the files the brief names and their tests were
  touched. No e2e file changed (see "e2e").
- Live lane check before any edit: `e2e/.artifacts/session.pid` = 65216, no
  such process; no listener on lane 10's ports 10001 / 10011 / 10021 / 10031.
  Nothing served this worktree's source, so the mutants were applied in place
  with the Edit tool (FW3 had to use sibling copies).

## Per item

| Item | Result | Commit |
|---|---|---|
| 1. R3-1 via OR-34 - a first-request 409 requirements_changed reset both columns | FIXED (every failure carries) | `29dc15b3` |
| 2. R3-3 via OR-35 - a Clears staff checked was dropped by every re-read | FIXED (new carry rule + click-time landlord in the carry) | `e649bbd8` |
| 3. R3-2 - QA-2's period drop hid a real difference | REVERTED (plain '; ' join) + visible-difference test | `1c6af57d` |

### 1. OR-34 (R3-1) - every re-read inside one open dialog carries

- `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:248`: the catch
  sets the carry ONCE, above the notice branches, for every failure; the four
  per-branch assignments (three `goesOn`, one `null` in the
  requirements_changed branch) are gone. The requirements_changed branch
  (`:260-261`) keeps `REQUIREMENTS_CHANGED_NOTICE` unchanged. So a
  first-request 409 requirements_changed now carries the left column (OR-17 /
  OR-35) and the hand UNCHECKS (OR-32, `carryHandUnchecks` at the read,
  `:182`); hand checks drop as on every other re-read. Only the dialog's first
  read (and Try again after it failed) starts from the defaults.
- Comments updated to say every re-read carries: dialog header `:24-36`,
  `ApplyCarry` doc `:99-103`, `carryRef` comment `:143-147`, the catch
  `:244-247`; `applyRequirementsModel.ts` `carryCheckedItems` doc (rewritten
  again in item 2) and `carryHandUnchecks` doc `:131-140`; the model test's
  OR-17 describe comment.
- Tests (`ApplyRequirementsDialog.test.tsx`), the two reset pins flipped into
  R3's scenarios (a colleague changed the pet fee, `getContact` second read
  `req_pet_fee: '$350'`):
  - `:453` (was the "starts the left column from the defaults again" pin):
    staff uncheck Credit score; call 0 `items` = `['pets']`; after the
    re-read Credit score is NOT checked, Pets is checked with the new
    description `No pets; pet fee $350`; "Update 2 properties" sends call 1
    with `items` = `['pets']` (R3-RCb).
  - `:724` (was the "still resets every row" pin): staff uncheck "2 Many St";
    call 0 `units` = `['u0', 'u2']`; after the re-read "2 Many St" is NOT
    checked, 1 and 3 are; "Update 2 properties" sends call 1 with `units` =
    `['u0', 'u2']` and onDone gets `{ updated: 2, skipped: [] }` (R3-RCa).
  - Describe comments of the OR-17 block (`:367-375`) and the OR-32 block
    (`:624-631`) restated for OR-34.
- RED (unchanged dialog): dialog 2 failed / 29 - both "Received element is
  checked": Credit score at `:470`, "2 Many St" at `:688` (line numbers of
  that run).
- GREEN: dialog + model 52 / 52; `src/routes/contact src/routes/listing` 101
  files 2438 / 2438; typecheck 0; eslint 0.

### 2. OR-35 (R3-3) - the left-column carry rule

- `dashboard/src/routes/contact/applyRequirementsModel.ts:66`
  `carryCheckedItems(previous, landlord, seen)` (was `(previous, landlord)`):
  for each item staff had CHECKED (`:72`, `orderedItems(previous)` - the carry
  never adds an item), keep it when the re-read landlord's value is not blank
  OR equals (`itemValuesEqual`) the value in `seen`, the landlord the dialog
  showed at the Update click (`:74`). So a checked Clears of an unchanged
  blank survives; a checked item comes back unchecked only when it turned
  blank since; an unchecked item stays unchecked; a newly filled item staff
  never chose stays unchecked. Doc `:47-65` states the rule (OR-17 + OR-34 +
  OR-35).
- Dialog: `ApplyCarry` gains `landlord: Contact` (`:104-108`, doc `:99-103`);
  the catch stores the click-time landlord with the choices (`:248`, the
  `landlord` onUpdate read from `ready`); the read passes it as `seen`
  (`:179`, inside the carried computation `:175-180`; comment `:170-174`).
  Header comment `:28-32` states OR-35.
- Tests:
  - `applyRequirementsModel.test.ts:116`, the carry describe rewritten for the
    new signature, 5 cases: `:117` unchecked stays unchecked, blank or not;
    `:124` a checked item with a value stays checked, a changed value
    included (and a Clears the landlord filled since - a value now, kept);
    `:140` turned blank -> unchecked; `:150` (R3-3) a Clears checked on
    purpose stays checked while the blank is unchanged, also when another
    item changed; `:160` an item the landlord filled since is not checked.
    The old OR-17 sub-assertion "a Clears item staff had checked comes back
    unchecked too" is the one flipped (it is now `:150`).
  - `ApplyRequirementsDialog.test.tsx:486`, R3's Clears-a: 150 properties
    with a copied `self_guided` tour type, landlord Touring blank (Clears);
    staff check Touring; batch 1 lands, batch 2 fails; calls 0 and 1 `items`
    = `['credit_requirements', 'pets', 'touring']`; the re-read (the first 100
    as batch 1 wrote them, so they read Already matches) shows Touring STILL
    checked and still "Clears"; "Update 50 properties" sends call 2 with the
    same three items and the last 50 units; onDone `{ updated: 50 }`.
- Parameter order: `seen` is LAST on purpose - the old two-argument function
  ignores a third argument, so the RED run isolates the new behavior instead
  of failing the pins for a signature reason.
- RED (old helper + dialog): 2 failed / 55 - model `:151` expected
  `['evictions', 'pets', 'touring']`, received `['pets']`; dialog `:521`
  Touring "Received element is not checked". The four pin cases passed on the
  old code by design.
- GREEN: dialog + model 55 / 55; contact + listing 101 files 2441 / 2441;
  typecheck 0; eslint 0.

### 3. R3-2 - revert QA-2 (plain '; ' join, plan 2.6)

- `dashboard/src/routes/listing/requirements.ts:400` back to the pre-QA-2
  return (`git diff 77abd659~1` shows only the doc). Doc `:333-336`: QA-2's
  three lines out; one note in (a trailing '.' stays before the '; ',
  because values compare exactly, D1) so the cosmetic is not re-applied
  unseen.
- Tests (`requirements.display.test.ts`): QA-2's four cases removed; one case
  `:217` (comment `:212-216`): property Pets "Service animals only." vs
  landlord "Service animals only", both with No pets and a $300 fee, format
  to `No pets; Service animals only.; pet fee $300` and `No pets; Service
  animals only; pet fee $300` - two different strings; the card's
  `requirementDisplay` is `set_here` with the landlord's text; and details
  that are only "." print `No pets; .; pet fee $300`, not the blank-details
  `No pets; pet fee $300` (R3-2's second collision). `type ItemValue` import
  added for the typed literals.
- RED (QA-2 code): display 1 failed / 23 at `:219` (received `No pets; Service
  animals only; pet fe...`; that run's line - `:220` after the one-line
  `ItemValue` import below).
- GREEN: display 23 / 23; contact + listing 101 files 2438 / 2438; eslint 0.
  The first typecheck of this item exited 2 (TS2345 x4 at
  `requirements.display.test.ts:219-221`, that run's lines: the untyped
  object literals widen `true` to `boolean`, not an `ItemValue`) - vitest
  does not type-check; fixed with the `ItemValue` annotations before the
  commit; typecheck 0.

## e2e

Grepped `e2e/tests/dashboard-next/property-requirements.spec.ts` and
`e2e/support/selectors.md` (requirements_changed, "Review the updated list",
reset, carry, Clears, OR-17 / OR-32 / QA-2, ".;", "press Update again", the
joined pets / Landlord lines). Nothing asserts the reset or the QA-2 join:
the spec runs one successful Apply (no 409, no failure, `:334-372`) and its
requirement values carry no trailing period (the REQ fixture `:206-215`);
selectors.md row 136 names the deposit and stop sentences only, no reset
claim. No e2e change.

## Verification

| Run | Result |
|---|---|
| baseline at `98512bf6`: dialog + model + display | 3 files, 78 / 78 |
| item 1 RED: `ApplyRequirementsDialog.test.tsx` | 2 failed / 29 |
| item 1 GREEN: dialog + model | 52 / 52 |
| item 1: `npx vitest run src/routes/contact src/routes/listing` | 101 files, 2438 / 2438 |
| item 2 RED: dialog + model | 2 failed / 55 |
| item 2 GREEN: dialog + model | 55 / 55 |
| item 2: contact + listing | 101 files, 2441 / 2441 |
| item 3 RED: `requirements.display.test.ts` | 1 failed / 23 |
| item 3 GREEN: display | 23 / 23 |
| item 3: contact + listing | 101 files, 2438 / 2438 |
| whole dashboard suite `npx vitest run` (once, at `1c6af57d`) | 263 files, 5340 / 5340, exit 0 |
| after the mutant reverts: dialog + model + display | 3 files, 78 / 78 |
| `npm run typecheck` (all workspaces), items 1 and 2 | exit 0 |
| `npm run typecheck`, item 3 | exit 2 (TS2345, test literals) -> fixed -> exit 0 |
| `npx eslint` on the 6 touched files (per item) | exit 0, no findings (none of the 5 pre-existing errors live in them) |
| ASCII, added lines of every touched file; `grep -nF '\u'` | 0 non-ASCII bytes; no `\u` |

Not run, per the brief: the full `npm test`, any Playwright e2e.

## Mutant check

Each applied with the Edit tool to the committed file, run, reverted with
the Edit tool, revert proven with `git diff --exit-code -- <file>`. At the
end `git status --short` and `git diff --stat` were empty.

| # | Mutant | Where | Test run | Result |
|---|---|---|---|---|
| M1 | the requirements_changed branch resets the carry again (`carryRef.current = null` after the notice) | `ApplyRequirementsDialog.tsx:261` | dialog 2 failed / 30 (the two OR-34 cases `:453`, `:724`) | KILLED |
| M2 | the read drops the carried hand unchecks (rows always reset) | `ApplyRequirementsDialog.tsx:182` | dialog 4 failed / 30 (OR-32: first-request failure, deposit_conflict, mid-run stop; OR-34 row case `:724`) | KILLED |
| M3 | the Clears-unchanged keep removed (the `itemValuesEqual` disjunct disabled) | `applyRequirementsModel.ts:74` | dialog + model 2 failed / 55 (model `:150`, dialog `:486`) | KILLED |
| M4 | the turned-blank drop removed (every checked item carries) | `applyRequirementsModel.ts:74` | 2 failed / 55 (model `:140`, dialog `:381`) | KILLED |
| M5 | the dialog compares with the re-read landlord, not the click-time one (`seen` = `landlord`) | `ApplyRequirementsDialog.tsx:179` | dialog 1 failed / 30 (`:381`, Income requirements blanked since) | KILLED |
| M6 | the carry ignores what staff checked (every registry item judged) | `applyRequirementsModel.ts:72` | 12 failed / 55 | KILLED |
| M7 | QA-2's trailing-period drop re-applied to the join | `requirements.ts:400` | display 1 failed / 23 (`:217`) | KILLED |
| M8 | a part that is only "." dropped from the join | `requirements.ts:400` | display 1 failed / 23 (`:232`, the "." vs blank line) | KILLED |

No survivor, so no follow-up test. M5 is killed by one dialog case only
(`:381`, the only dialog case where a checked item turns blank); adequate,
since the helper's own cases pin the rule.

## Divergences from the brief / plan text

- OR-34's fix is R3's probed line in its structural form: one carry
  assignment above the notice branches (`ApplyRequirementsDialog.tsx:248`)
  instead of `carryRef.current = goesOn` in the requirements_changed branch.
  Same behavior (every branch carried the same value after the one-line
  fix); a future branch can no longer forget the carry. The `goesOn` local is
  gone.
- `carryCheckedItems` takes the click-time landlord as a THIRD parameter
  (`seen`), for the RED isolation reason above; the brief allowed "its
  successor".
- The R3-2 case also pins R3-2's "." vs blank-details collision, beside the
  brief's "Service animals only." vs "Service animals only" pair.

## Contract shipped

- `carryCheckedItems(previous: ReadonlySet<RequirementItemId>, landlord:
  Contact, seen: Contact): Set<RequirementItemId>` - signature CHANGED (was
  two parameters); exported from `applyRequirementsModel.ts`; the dialog is
  its only caller (grep of dashboard, e2e and app).
- `ApplyCarry` (dialog-internal) gains `landlord: Contact`.
- `carryHandUnchecks` unchanged (doc only).
- `formatItemValue` is back to plan 2.6: the parts joined by '; ', 'blank'
  when none; no part is altered.
- No copy, accessible name, error string or new file changed;
  `REQUIREMENTS_CHANGED_NOTICE` is unchanged.

## For the orchestrator (and Cameron's eye)

- After a first-request 409 requirements_changed the dialog now keeps staff's
  choices: an item still holding a value stays checked and shows its new text
  (what "Review the updated list" asks staff to look at); an item the
  landlord newly filled starts UNCHECKED (staff never chose it - they check it
  if they want it); the rows staff unchecked stay unchecked.
- OR-35's "not blank -> kept" also keeps a Clears staff checked when the
  landlord has filled that item since: the next Update copies the new value
  instead of clearing (the re-read shows it). This follows the ruling's text
  and is pinned at `applyRequirementsModel.test.ts:124`.
- R3-2: the ".;" cosmetic ("Service animals only.; pet fee $300") is back and
  goes to Cameron's list, per the ruling. `build/FW3-selfqa.md` and
  `self-qa.md` still describe QA-2 as fixed; they are as-produced records,
  superseded by `1c6af57d` (not edited).
- Gates: the full gate run on the final code commit (`1c6af57d`) is the
  orchestrator's (round 3 terminal rule).
