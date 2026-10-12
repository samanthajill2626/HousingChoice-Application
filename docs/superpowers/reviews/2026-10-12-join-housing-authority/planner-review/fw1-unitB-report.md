# Planner fix wave 1 - unit B (FW-4, spec D12 Settings note) - implementer report

Branch feat/join-housing-authority, worktree W:/tmp/join-housing-authority.
Contract: spec revision 5 D12 + orchestrator decision 6
(`planner-review/fix-wave-1-decisions.md`), finding A10 (`adversarial.md` section 10).
Copy only; no behavior change.

## Commits

- `16a0f963` feat(org-settings): say a housing authority name appears on the public
  sign-up form (FW-4, D12) - the copy constant, the four surfaces, their unit tests.
- `d9cdba7b` test(e2e): the admin rename of a housing authority carries the public
  sign-up note (D12) - one assertion in the existing rename test.

## The copy - one place

`dashboard/src/routes/orgs/orgCopy.ts:96` `HOUSING_AUTHORITY_PUBLIC_NOTE` =
"Housing authority names appear on the public sign-up form." (exact D12 string, ASCII).
orgCopy is the org lists' existing client-copy module, so it lives there. Each surface
renders it as `<p id=... className={styles.dialogMuted}>` (the dialogs' existing muted-text
class) and wires it with `aria-describedby` (the spread-when-present idiom NewOrgDialog
already used for its problem text). Tests pin the literal string, not the constant.

## Surfaces found (enumerated from the code) and what was done

Shown only while the entry is, or will become, a housing authority (`housing_authority`).

1. "Is this really new?" - `NewOrgDialog` (`orgs/NewOrgDialog.tsx:151`, render :262,
   Name describedby :248, Yes describedby :152-157). ONE component shared by:
   - Settings "Add housing authority" (`settings/OrgListSection.tsx:392`, mode settings);
   - contact form "Add <text> as a new housing authority" (`contact/ContactEditForm.tsx:1020`,
     kind from `newOrgDialogKind`, so housingAuthority -> HA, agency -> agency,
     organization -> organization mode);
   - property forms (`listing/ListingEditForm.tsx:597`, `listing/UnitCreateForm.tsx:611`,
     always HA);
   - caseworker dialog (`contact/CaseworkerDialog.tsx:414`, organization mode);
   - AI housing authority suggestion Accept (`contact/ContactDetail.tsx:1241`, suggestion
     mode, HA).
   Per decision 6 the line shows in all of them when an HA is being added. Rule:
   `chosenKind === 'housing_authority'` - an HA kind at once; organization mode only once
   the Kind radio is Housing authority (unset or Agency shows nothing). It describes the
   Name field; the suggestion mode has no Name field (the heard text is fixed), so there
   it describes "Yes, add it" (joined after the problem id when a problem shows).
2. Rename (`settings/OrgEntryDialogs.tsx:292`, describes "New name" :342, render :348):
   shown when `entry.kind === 'housing_authority'`; an agency rename shows nothing.
3. Change kind (`settings/OrgEntryDialogs.tsx:471`, describes the move button :503,
   render :518): shown when the move is INTO Housing authorities and NOT blocked. The
   dialog has no field, so it describes "Move to Housing authorities".
4. "Not on the list" > Add as new (`settings/NotOnListSection.tsx:335`, describes Name
   :462, render :470): shown when `settle.action === 'add' && addKind === 'housing_authority'`
   - a Housing authority value and a property (accepted_authorities) value at once
   (their addKind starts as housing_authority); an organization value once Housing
   authority is picked in Kind; an agency value never.

Judged OUT of scope (no new HA name reaches the public list), each with its reason:

- Edit spellings: `housingAuthorityNames` (`app/src/services/publicOrgList.ts:40-50`)
  publishes NAMES only - spellings never reach /join.
- Merge: the merged name LEAVES the list; the target's name is already listed.
- Delete, Edit notes: remove a name / touch no name.
- "Not on the list" Use (with "Remember this spelling"), Use another name, Split, Move to
  Housing authority as <name>, Clear: each uses a name already on the list or adds only a
  spelling; none adds an entry. A negative test pins Move to Housing authority.
- OrgPicker / OrgKindChoice themselves: the picker never adds (its "Add ... as new"
  option opens the host's NewOrgDialog); OrgKindChoice is a radio group reused by both
  add surfaces, which carry the note themselves, so the shared radio stays copy-free.
- The blast composer picker: no add step (spec D7).
- Server-side writers (the /join sign-up, the backfill, the cleanup script): no UI; out
  of this unit's scope (nothing in app/).

## TDD - RED / GREEN

New tests (12): `orgs/NewOrgDialog.test.tsx:263` (4), `settings/OrgListSection.test.tsx:823`
(4), `settings/NotOnListSection.test.tsx:593` (4).

- RED (new tests only, `-t "public sign-up note"`): 8 failed, 4 passed. Every failure was
  the missing line ("Unable to find an element with the text: Housing authority names
  appear on the public sign-up form." or an empty accessible description). The 4 that
  passed are the negatives (agency add, agency Add as new, Move to Housing authority,
  out-of-HA/blocked kind change) - they cannot go RED before any line exists; they pin
  the "agencies show nothing" half.
- GREEN: the 3 files 127/127; then
  `npx vitest run src/routes/orgs src/routes/settings src/routes/contact src/routes/listing`
  114 files / 2265 tests passed (baseline before the change: 114 / 2253; +12, no existing
  test broke, no exact-text or count assertion needed changing). Re-run at final HEAD
  `d9cdba7b`: 114 / 2265 passed. stderr noise identical to baseline (122 lines both).

## E2E

`e2e/tests/dashboard-next/org-lists.spec.ts`: `UI.publicNote` (:85) and, in the existing
"an admin renames an entry" test, the New name textbox `toHaveAccessibleDescription(UI.publicNote)`
(:639-641) before the fill. No new selector query (a description assertion on a locator the
test already used), so no `e2e/support/selectors.md` row.

- Run 1: session booted at `16a0f963` (the source HEAD), spec uncommitted:
  16 passed (38.5s). Session stopped (`e2e:stop` exit 0), then the spec committed.
- Run 2 (to remove any doubt about "final HEAD"): session booted at `d9cdba7b`:
  16 passed (40.8s); test 10 (the rename, :605) ok. Stopped, exit 0.
- After each stop: no listener on lane 4 ports 9401/9411/9421/9431, the launcher and app
  pids gone, `session.pid`/`lane.json` removed. No session or background command left.

## Gates

- `npm run typecheck` exit 0 (run after the source commit and again at `d9cdba7b`).
- `npx eslint` on all 8 touched .ts/.tsx files exit 0 (no output).
- ASCII: no non-ASCII character on any added line (checked on the diff before each commit).
  orgCopy.ts's existing `\u` regex escapes were not touched (diff: +10 / -0).

## Worries and judgment calls (findings for the reviewer)

1. Change kind while BLOCKED shows no line. I read "shown only while the entry will
   become a housing authority" as excluding a move the dialog cannot make (the button is
   disabled and the text explains why). While usage is still loading `blocked` is false,
   so the line can show and then drop once usage says blocked - minor. The other reading
   (show it for any agency -> HA dialog) is a one-condition change at
   `OrgEntryDialogs.tsx:471`.
2. Suggestion mode describes "Yes, add it" rather than a field (it has none). Field and
   settings modes deliberately do NOT add the note to the button: two existing tests pin
   that button's exact description ("Cannot add it: ..."), and the Name field is the
   better anchor.
3. The record forms show the line through the shared dialog with no host-level test of
   their own; NewOrgDialog's tests cover every mode they use (field HA, field agency,
   organization, suggestion). If the reviewer wants one host proof, ContactEditForm is the
   natural place.
4. Lane hygiene: the stale `session.pid`/`lane.json` from an earlier unit (launcher 66756,
   lane 4, no live process, no listener) was self-healed by the first `e2e:session`. The
   second `e2e:stop` reported "killed orphan(s) on lane 4 :9401 (app): 46628" after
   stopping the launcher - the app child outlived the launcher tree-kill and e2e-stop
   reaped it. Ports confirmed free afterwards.

## Next step

Orchestrator: review and commit this report; FW-4 is done pending review. No follow-up
owed by this unit.
