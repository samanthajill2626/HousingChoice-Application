# Caseworkers (branch B) - plan review round 1 - fix report

Plan: `docs/superpowers/plans/2026-10-07-caseworkers.md` (edited in place,
uncommitted). Rulings: `adjudications.md` in this folder. Every anchor the
fixes introduced was checked against the code at HEAD (exists, one line or
an exact multi-line block, unique - or, where a plan step anchors on text an
earlier task writes, against that task's text in the plan).

Final checks: `LC_ALL=C grep -c '[^ -~]'` on the plan prints 0; no "CONTRACT
ISSUES", "contract issue", "CI-<n>" or "CI-n" citation remains.

## One line per ruling row

- A1, B9: every citation replaced - headings 2.4/2.5/3.1/3.8/6.5, S2/S6/S7/S8/S9/S10 intros, Task 1.3, 1.4 ("verified note at the end of CONTRACT ISSUES" deleted), the two code comments in 3.6 (now "plan 3.3") and 4.4 (now "plan 3.2: a userId"), the S10 selector table and its "CI-n" legend; the header defines the id scheme ("assembly ruling S1/S2-3", S10 items by subject).
- A2: plan 3.2 rewritten (CASEWORKER_ROLE DEFINED in leaf `lib/caseworkers.ts`, `contactKinds.ts` imports + re-exports it, why); Task 1.1 now creates `lib/caseworkers.ts` with the constant and edits `contactKinds.ts` (import + `export { CASEWORKER_ROLE }`; anchor verified) and stages it; Task 1.2 replaces the file (no contactKinds import; RED reason corrected); Task 1.4 comment and GREEN carry an import-line proof (two app files only).
- A3: section 0 gains "e2e pins move with their copy"; pins moved verbatim from Task 10.4 into Task 6.5 (step 4), 9.1 (step 4 a-d), 9.3 (a-b), 9.4 (step 4 a-d), each with Files, e2e-workspace typecheck + eslint and staging; S9 intro and the S9->S10 handoff restated as a record; Task 10.4 is now a skip-if-done verification (stale-wording grep, then the pinned-test run, commit only if a missed pin was fixed).
- A4: Task 10.12 step 3 issue (`tours-placements-no-contact-type-check`) widened - title, refs (`routes/units.ts`, `lib/unitFields.ts`, `services/rosterEdits.ts`), problem and suggested fix name the landlord-of-record write and roster adds.
- A5, A6, B1: Task 9.6 step 1 adds the three props to Task 8.9's `renderPartner` in the same step (anchor = 8.9's text, unique); the header-comment edit now anchors on 8.9's fourth header line; the typecheck claim names all four `<PartnerFile` sites (verified 2 at HEAD + 2 added).
- A7: Task 9.6 states it owns line 45 and the two share rows (one regex each); Task 10.9 step 1 is a skip-if-done grep of them, its duplicate "Partner page" and "Property page" rows are removed (the partner_1to1 / consent caveat folded into its share-wording row).
- A8: GLOSSARY.md:120 -> Task 10.10 step 4; sequence-diagram-to-test.md:135 -> Task 10.11 step 3 (non-ASCII line, placeholder + unique ASCII substring); handoff names both.
- A9, B4: `isCaseworkerContact` defined in `caseworkerRole.ts` by Task 8.3 GREEN (c) (structurally typed, keeps the module's import rule); removed from CaseworkerDialog; imports fixed in the 8.3 test, 8.5, 8.8 and 8.12; 8.3 Files and staging updated.
- A10, S7: display "+N deleted" and the confirm-sentence count read `inUse.deleted` - switched in Task 7.4 (with a new "+1 deleted, never +2" RED case), not 7.1 (A's Settings fixtures lack `inUse` until 7.4; noted in 7.1); 7.1 test fixtures carry `inUse`; plan 3.6, the 7.1 dashboard type doc and the 5.3 server doc say the per-column `deleted` is wire-compatibility only.
- A11: Task 10.7 `findUnknownContactId` uses `?phone=<encoded>` (exact byPhone lookup, `contacts.ts` route verified) and checks `type === 'unknown'`.
- A12: Card.tsx:193-195 comment edit added to Task 9.1 (Files, step 3, staging); RUNBOOK 179/376/386/415 added to Task 10.11 step 2 (179 has an em dash: placeholder + ASCII prefix); all anchors verified unique.
- A13: Task 8.13's test matches child links by accessible name (`getAllByRole('link', { name: /^(Tenants|Landlords|Caseworkers|Unknown)$/ })`, document order) and reads `textContent`.
- A14: Task 8.9 GREEN (d) scopes `conversation-fact-extraction.spec.ts:342` to the Details card, exact (Files, eslint, staging added).
- A15, B2: Task 8.3 test and code use plan 3.9's "... without a type ..." sentences; a plural-sentences case added.
- A16, B5: Task 10.1 rewritten as verification (greps + e2e-workspace unit run; no RED, no edit, never re-create the issue); Task 10.2 drops its RED and the :201 edit (skip-if-done grep), keeps the preset test and frame list as PINs; S10 assembly notes and "Expected state at S10 start" corrected; plan 3.8 now says the catalog entries are S8 Task 8.1; Task 10.12's two "filed in Task 10.1" references fixed. Applied the same start-state correction to Task 10.3 (skip-if-done; S5 owns its edits) - see open question 6.
- A17, B6: both `CaseworkerConversionRecord.by` docs (Task 2.1, Task 8.1) say userId.
- S1: new Task 10.8a - one test appended to org-lists.spec.ts's "Not on the list" describe: run-unique partners, `setOffListValue({ field: 'organization' })`, row labelled Organization, Add as new disabled until a Kind radio, the added kind checked, Use of an agency name, no count anywhere; Task 10.13's new-test count updated to 7.
- S2: Task 5.5 RED 2b - a lapsed organization Use of an agency name is CLAIMED (RED: refused at HEAD), refused once the name left both lists; anchors verified.
- S3: Task 5.6 replaces the real three consecutive lines (check header, list read, resolution) as one block (verified).
- S4: Task 7.5 places `<OrgKindChoice>` once - a sibling after the Name block's whole ternary, anchored on a verified 5-line block.
- S5, S6: Task 7.2 header edit anchors on OrgPicker.tsx:38 (one line); Task 5.2 header edit anchors on orgRecords.ts:23 (one line); Task 7.5 doc edit anchors on NotOnListSection.tsx:53 and the doc's last line; 7.5's two `kindForField` lines are told apart (first/second occurrence).
- S8: Task 7.3 - `orgErrorCopy(err, { organization })` option in orgCopy.ts (organization: "Pick one of them.", never Split; anchors verified); NewOrgDialog passes it; RED case for a refused compound add.
- S9: Task 7.3 step 5 updates selectors.md's org-picker row (organization add option, the Kind group, `Organization` label; substrings verified unique).
- S10: Task 5.2's RED reason corrected (the conditional agency write misses -> `skipped: 1`, no `organization` key).
- S11: no change (the plan already says "first occurrence").
- B3: section 0 legend added (`{--}`, `{->}`, `{...h}`, `{"}` + the Read-copy-retype procedure); every placeholder anchor (Tasks 6.4 x2, 9.1 x3, 9.3, 9.4, 9.5, and the new 10.11 ones) now names its unique ASCII substring.
- B7: spec revision 15 already amended; plan header now cites revision 15; plan 3.7 / 3.9 already match.
- B8: Task 8.3 - on `alreadyCaseworker` the dialog hides the Organization picker, shows "This contact is already a caseworker. Confirming re-runs the cleanup." and sends `{}`; test added; plan 3.9 copy row and the 10.9 selectors row updated.
- B10: "Checkpoint after S9" (typecheck + npm test, bare) added; Task 10.14: sync main once (MERGE_HEAD check, merge-tree pre-check, trailer, npm ci on lockfile change), then gates 1-5 bare - e2e as `timeout 2700 npm run e2e`, gate 5 over `git diff --name-only --diff-filter=d "$BASE"...HEAD` with the explicit merge base, an EMPTY-list STOP and baseline attribution; work map updated.

## Found but not ruled (open questions - no behavior invented)

1. Task 10.12 step 8 repeats Task 8.9 GREEN (c) on `docs/issues/staff-notes-on-landlord-partner-files.md`: after 8.9 its "Current" title no longer exists, and a literal build would append a second Update paragraph. Make step 8 skip-if-done?
2. Task 7.5's Settle dialog "Add as new" on an ORGANIZATION row still calls `orgErrorCopy(err)` (NotOnListSection.tsx:345): a server-refused compound add would read "Use Split instead." - the S8 defect, on the Settings side. Pass `{ organization: row.field === 'organization' }` there too?
3. `e2e/tests/flows/conversation-fact-extraction.spec.ts:60-76` has its own `findUnknownContactId` with the same page-1 `?type=unknown` scan A11 fixed in Task 10.7 (pre-existing).
4. Plan 3.9 "UNCHANGED" row and the Task 10.9 share-wording selectors row write "No candidates - add a tenant below." but the UI keeps its em dash (unchanged on purpose) - a spec copying the selectors text would not match.
5. `documentation/sequence-diagram-to-test.md:133` still names the kebab menuitem "Broadcast to tenants" (stale before this branch; now "Send this property"); only :135 was ruled.
6. Task 10.3 was also made skip-if-done (its RED step contradicted the corrected S10 start state, since S5 Tasks 5.3/5.7 make its edits) - confirm this reading of A16.
