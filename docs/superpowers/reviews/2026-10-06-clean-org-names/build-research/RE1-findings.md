# RE1 - build research findings (S11 Tasks 11.1-11.10)

- Reader: RE1 (read-only on the repository; the only repo writes are this
  file and the optional reference under `.superpowers/`).
- Plan range: `docs/superpowers/plans/2026-10-06-clean-org-names.md` lines
  16212-21692 (S11 header and Tasks 11.1-11.10), plus sections 0-3 and 12;
  the S1/S3/S5/S7 plan code read where the dashboard consumes its shapes
  (plan:649-668, 790-822, 1025-1035, 1176-1215, 2659-2690, 2768-2805,
  5116-5134, 7740-7811, 8197-8290, 8590-8660, 13376-13550).
- Tree: `W:/tmp/clean-org-names` @ bef84c54 (docs-only on main @d839494a), so
  the live source equals the plan's base.
- Method: static reading of every anchor, symbol and contract, PLUS a
  mechanical execution of the range on SCRATCH copies outside the repo (the
  session scratchpad): `dashboard/src` and `e2e/performance` were copied, every
  edit of Tasks 11.1-11.10 was applied from the plan's own fenced blocks in plan
  order (94 operations: replaces, appends, creates, the Task 11.7 (e) range
  delete, the `git rm` of `orgVocabulary.ts` done as a plain file delete on
  the copy), then:
  - `tsc` with the dashboard's compiler options (strict,
    noUncheckedIndexedAccess, bundler resolution, react-jsx) against the
    worktree's node_modules (read-only);
  - ESLint with the repo's `eslint.config.mjs`, fed through `--stdin
    --stdin-filename` (nothing written), on the applied AND the base version of
    every touched file;
  - vitest with the dashboard's test config (jsdom, globals, setup.ts,
    css:false) on the applied copy, and on per-task RED stage copies (all
    earlier tasks complete + only the task's RED edits).
  No `npm test`, e2e, server, seed or repo script was run; nothing in the
  repository or any other worktree was modified.
- Counts: BLOCKER 0, MAJOR 0, MINOR 6.

## Per-check result

1. ANCHORS - clean. The anchor check's 80 rows in the range (68 OK, 10
   SEVERAL-FILES, 2 MULTI-IN-FILE) plus the anchors the heuristic does not
   list (Task 11.7 (e)'s start-marker delete, Task 11.8 GREEN (b)'s two
   prose-referenced "same block as GREEN (a)" edits) all applied: replayed in
   plan order, every `Current` block was found exactly once in the file its
   task names, including after the earlier edits of the same task (e.g.
   ListingEditForm.tsx `onSaved(updated);\n    } catch {` once Task 11.7 has
   changed ContactEditForm's copy to `catch (err)`).
   - SEVERAL-FILES rows: plan:19465 / 19514 / 19772 (ContactEditForm.test.tsx
     `:4`, `:43`; ContactEditForm.tsx `:10`), plan:20118 / 20135 / 20150
     (ContactDetail.test.tsx `:45`, `:114`, `:302-303` - the same lines also
     exist in useSuggestions.test.tsx, which Task 11.2 edits elsewhere),
     plan:20490 (ListingEditForm.test.tsx `:30`), plan:20767 (the authorities
     `<div className={styles.row}>` block - UnitCreateForm.tsx `:302-313` and
     the byte-identical ListingEditForm.tsx `:224-235`), plan:20931
     (ListingEditForm.tsx `:197-198`): each task names its file and the block is
     unique there. plan:20414 is the one whose file is only implied - RE1-3.
   - MULTI-IN-FILE rows plan:20057 and 20808 (`      </form>` + 3 lines):
     the multiplicity is TourModals.tsx (x3), never targeted; the 4-line tail
     is unique in ContactEditForm.tsx, UnitCreateForm.tsx and
     ListingEditForm.tsx, each the file's last four lines (verified).
   - Line citations: all accurate at base except AudienceFilters.tsx `:31-33`
     (RE1-2); the lint note's `useComposerDraft.ts:116` is stale after the
     task's own inserts (RE1-1).
2. SYMBOLS - clean. `request(path, { method?, body?, query?, signal? })`
   and `ApiError(status, code, message, body?)` with `.status/.code/.body`,
   message = raw code (`dashboard/src/api/client.ts:13-33, 37-49, 146-148`);
   barrel re-exports types + endpoints + ApiError (`api/index.ts:3-5`); no
   name collision for any new type or function in the barrel;
   `Button` forwards `type`, `aria-describedby`, `disabled`
   (`ui/Button.tsx:45-79`); `Modal({ title, onClose, footer, children })`,
   no portal, Escape honours `defaultPrevented` (`routes/contact/Modal.tsx:96-104`);
   `CONTACT_TYPE_LABEL` (`routes/contact/contactProfile.ts`), `authoritiesOf`
   (`routes/listing/listingFormat.ts:61-69`), `ApiError` already imported in
   `useComposerDraft.ts:22` and `BroadcastComposer.tsx:20`; every CSS token
   in `OrgPicker.module.css` is defined in `ui/tokens.css`. The scratch `tsc`
   run of the fully applied range reports no error beyond 4 pre-existing
   scratch-location artifacts (`*Mirror.test.ts` relative imports into `app/`),
   identical on an unmodified copy.
3. CONTRACTS - clean. `types.ts` additions mirror plan 3.2-3.6 and the S1
   code (OrgEntry/OrgRef/OrgField plan:649-668, 1025-1029; NameProblem codes
   plan:1176-1181; SpellingProblem incl. `invalid` plan:2675-2687;
   OrgResolution statuses plan:790-795). Endpoints match the S5 router: GET `/`
   -> `{ version, entries, lastRewrite? }` (plan:7740-7750), `{ usage }`,
   `{ rows }`, `/not-on-list/records?field=&value=` -> `{ records }`
   (plan:7768-7781), `/check` -> the service result (plan:5116-5134), POST
   201 `{ entry }` (plan:8231), rename 202 (plan:8287), merge / resolve /
   run-again 202 (plan:8606, 8641, 8659), DELETE 204. Refusal bodies read by
   `orgErrorCopy` match their producers: `org_name_taken.entry`,
   `org_name_compound.spans`, `org_spelling_shared.{spelling,entries}`,
   `org_spelling_refused.{spelling,problem,entries?}` (plan:2768-2805),
   `org_in_use.uses.{active,deleted}` (plan:8202),
   `org_value_is_name_variant.entry` (plan:6763). The accept body
   `{ ...identity, value }` matches the S7 parser (plan:13376). Plan 3.11's
   `useOrgList()` shape and endpoint list are implemented exactly.
4. FALLOUT - complete for the range. Whole dashboard suite on the applied
   copy: 211 files pass; the 8 files that fail there fail identically on an
   unmodified copy (they read `app/` or repo files by relative path - scratch
   artifacts; they run normally in the worktree). The e2e
   `mutationCatalog.test.ts` (pinned 118) and `firewall.test.ts` pass against
   the applied dashboard; every new mutating client function
   (checkOrgText, addOrg, patchOrg, mergeOrg, deleteOrg, resolveNotOnList,
   runOrgRewriteAgain) is cataloged with the fingerprint discovery derives,
   and no S11 file outside `endpoints.ts` calls `request`/`fetch`.
   Importers of the retired `orgVocabulary.ts`: only ContactEditForm.tsx (and
   the files.test.tsx comment) - both handled; `docs/issues/*` mentions are
   S16 Task 16.2's. Unit tests that type org text into these forms are all
   named by the plan (ContactEditForm.test, UnitCreateForm.test 4b,
   ListingEditForm.test x3, AudienceFilters.test); suites that render the
   forms through a parent get mocks (ContactDetail.test, ListingDetail.test,
   BroadcastComposer.test + .prefill). No other dashboard test opens these
   forms (ListingsList / ContactDetail "New property" paths are unexercised).
   e2e specs that drive the changed forms are S14's and S14 names each:
   contact-detail.spec.ts:94/109 (Task 14.2), steps.ts
   `teamCreatesUnitFromIntake` :1586-1612 and `editTenantIdentity` :4054-4055
   (Task 14.1), matching-entry-points.spec.ts:287/322 (Task 14.3). The
   parallel `feat/tour-list` branch edits the same api files mid-file (not at
   the EOF this range appends to) and does not touch the mutation catalog.
5. TDD VALIDITY - clean. Every RED reproduced on a staged copy for its stated
   reason: 11.1 catalog `expected length 118 but got 111` (and the client
   exports missing); 11.2 three failures (bare identity, three-argument call,
   `value_not_from_suggestion` gets the generic sentence); 11.7 eleven
   failures (no list-name option, no hint, Save sends typed text, no chip /
   mark / load message); 11.8 ten (no `Housing authorities` combobox / chip /
   mark); 11.9 four (no combobox, no alert); 11.10 two (the GONE copy never
   appears); 11.3-11.6 module missing. Every GREEN passes (605 tests in the
   range's 25 files); the new composer tests run 1.5 s and 2.1 s against
   their 4 s waits. Lint: no new error in any touched or created file (RE1-1
   lists the baseline ones).
6. SPEC - conforms: D6 (names + spellings, add only when nothing matches,
   "Is this really new?" outside the form, other kind -> "Put it in Agency" on
   the tenant form only, off-list chips, unchanged values never sent), D7 (no
   add option, commit only on pick/clear, 422 at create or Preview clears the
   pick), D8 accept `value`, section 7 help text, plan 3.11 labels.

## Findings

RE1-1 | Task 11.10 GREEN, plan:21686-21689 | MINOR | The lint expectation
"no error beyond the pre-existing react-hooks/refs at useComposerDraft.ts:116"
is wrong twice: (a) `BroadcastComposer.tsx` already carries 4 pre-existing
`react-hooks/set-state-in-effect` errors at base (`BroadcastComposer.tsx:167`
setUnit(null), `:192` and `:211` the two setMessage prefill effects, `:226`
the voucher-size setFilter pre-fill; after this task's edits they sit at
:190, :215, :234, :249); (b) the refs error moves from `:116` to `:128`
(this task inserts 12 lines above it). An implementer told to expect one
error sees five and may stop or "fix" unrelated debt. Correction: replace the
sentence with "no error beyond 5 pre-existing ones, all present at the merge
base: useComposerDraft.ts react-hooks/refs at the `disposableRef.current =`
write, and BroadcastComposer.tsx react-hooks/set-state-in-effect x4 (setUnit(null)
and the three prefill effects)". For S17 gate 5, the other pre-existing
errors in files this range touches are: ContactDetail.test.tsx
no-unused-vars `PlacementsPage` (:8) and `UnitsPage` (:11);
BroadcastComposer.test.tsx no-unused-vars `ContactsPage`, `UnitsPage` (:11)
and `DEFAULT_SEND_TEMPLATE` (:37 at base, :41 after Tasks 11.9-11.10). Every
other touched or new file lints clean before and after.

RE1-2 | Task 11.9 GREEN, plan:21232 | MINOR | Citation drift: the
`truncated` prop block quoted as `AudienceFilters.tsx:31-33` is at `:32-34`
(`/** True when the reach estimate hit ... */` is line 32). The quoted text is
unique, so the edit applies. Correction: cite `:32-34`.

RE1-3 | Task 11.8 RED (a), plan:20412-20422 | MINOR | "Also add `within` to
the testing-library import. Current (`:1`)" names no file. The identical line
is also `ListingEditForm.test.tsx:1`, which RED (b) rewrites as part of its
`:1-12` block (plan:20428); applying this edit to ListingEditForm.test.tsx
first would make RED (b)'s anchor miss. Correction: "In
`UnitCreateForm.test.tsx`, current (`:1`)".

RE1-4 | Task 11.8 RED (a), plan:20177-20184 | MINOR | Stale comment left
behind: `UnitCreateForm.test.tsx:74-76` still says "ONE comma-separated
authorities input replaces the retired single 'Housing authority' field ..."
above the label-presence assertions the task keeps; after GREEN the field is
the multi-picker. Correction (comment only, ASCII): "The housing authorities
picker (spec 2026-10-06 D6) replaces the retired single 'Housing authority'
field and the 'Accepted vouchers / programs' list (spec section 8)."

RE1-5 | Tasks 11.5/11.6, plan:18822-18843 and 19221-19239 | MINOR | Text over
200 characters: the picker input has no length cap, its add option passes
the typed text to `NewOrgDialog`, and `POST /check` refuses it 400 before any
check (plan 3.6; router plan:7803-7806). The dialog then shows "Couldn't check
the list - you can still add the name ..." with a Try again that fails the
same way; "Yes, add it" ends in 400 `org_name_too_long` (mapped copy). No bad
data, misleading copy. Optional correction: in `NewOrgDialog`, when
`trimmed.length > 120` skip the check and render
`Cannot add it: ${nameProblemCopy('org_name_too_long')}` with Yes disabled
(the D13 cap; the server stays the authority), plus one test.

RE1-6 | Tasks 11.7/11.8 tests | MINOR (noise only) | The forms now read the
list on mount, so the synchronous ContactEditForm tests (9: e.g. "shows
tenant fields (voucher) and hides company for a tenant") and ListingEditForm
tests (3: "prefills current values", "renders the new public-flyer inputs",
"tells staff which facts are publicly visible on the flyer") print React's
"An update to ... was not wrapped in act(...)" when the mocked
`getOrgList` resolves after their last assertion (52 new stderr lines; all
pass). No action required; if the noise matters, end each of those tests
with `await act(async () => {})` (flushes the already-resolved read; `act`
from '@testing-library/react'), or leave as is.
