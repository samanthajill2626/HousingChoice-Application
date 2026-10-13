# RA - S1 (D1 accept fence) live-tree drift check - findings

Reader: RA (read-only research reader), caseworker-integrity build mission,
2026-10-12. Tree: `W:\tmp\caseworker-integrity` @670fb701. No app/, dashboard/,
e2e/ or scripts/ change since the base 19607658 (every commit since is docs),
so the S1 anchors written at 54f9e6ed still describe the live code.

Method: every Edit / Create / Append instruction in plan lines 266-3294 was
applied IN ORDER to scratch copies of the live files (line endings
normalized); every symbol the new source and tests use was traced to its
definition; each Step 2 RED and Step 4 GREEN was traced by hand against the
live code; consumers of the widened union and the changed functions were
grepped across app/, dashboard/, e2e/ and scripts/. Quotes, the consumer list
and the per-task trace are in the reference file
`.superpowers/sdd/research/RA-S1-reference.md` (gitignored).

Headline: 0 BLOCKER, 0 CORRECTION, 8 NOTE. S1 is executable as written. The
plan's 47 operations are 38 old_string/new_string edits, 3 creates and 6
appends. Every one of the 38 edits finds its anchor verbatim and uniquely at
its point in the sequence; the two `replace_all` edits hit exactly 2 and 7
occurrences, as the plan says; every grep-count check in the plan holds on the simulated tree;
every RED fails for the stated reason and every GREEN passes as traced; the
widened union compiles at every consumer; the code meets spec section 2
changes 1-7 and the section 8 D1 list (with the plan-review adjudications).
The NOTEs are context and two optional comment fixes.

---

## N1 - Task 1.10 - NOTE: a test comment goes stale (optional one-line fix)

- Plan: Task 1.10 adds `['suggestion_contact_reclassified', 409]` as a fourth
  row of the refetch `it.each` and rewrites the SOURCE comment to "These four"
  (`dashboard/src/routes/contact/ContactDetail.tsx:708-719`).
- Tree: the TEST comment right above that `it.each` still says "The SERVER
  answers these three with a list ..." and "for the refused accept"
  (`dashboard/src/routes/contact/ContactDetail.test.tsx:700-706`).
- Fix (optional, same Task 1.10 edit, file already in the S1 lint list):
  "these three" -> "these four", and "for the refused accept" -> "for both
  refused accepts (a field edit or a reclassification)". No test depends on it.

## N2 - Task 1.1 - NOTE: another comment describes the plan read as eventually consistent

- Tree: `app/test/aiRunVerdicts.test.ts:645-651` ("the contact read that builds
  the plan and its attribute guard is eventually consistent") and `:657-658`.
  After Task 1.1 that read is consistent.
- The test itself stays valid and green: its edit lands inside the `claimed`
  boundary hook, after the plan read, which is still the race it pins.
- Leave it, or reword it. If reworded, add `app/test/aiRunVerdicts.test.ts` to
  the S1 slice-gate lint list, or the section 0 coverage check stops on it (W1).

## N3 - check 6 - NOTE: what the recovery paths reach and answer (no task missing)

- `recoverAbandoned` (`app/src/services/suggestionResolution.ts:676-716`) runs
  `applyJournal(..., { helping: true })`. `commitContactEffect` answers
  `superseded_by_reclassification`, which is neither `phone_conflict` nor
  `stale` (`:494`, `:578`), so `stateChanged` is set (`:579`). The stored
  outcome is `superseded_by_human_edit` (repo `journalSuperseded` `:389-405`;
  fake after Task 1.6), so the activity is skipped (`:602-633`), the run-log
  verdict is `superseded_by_human_edit` (`:645-648`), and the journal
  completes. It counts as `recovered`; the read route then emits
  `suggestion.updated` and answers 200 with the list
  (`app/src/routes/suggestions.ts:124-129`).
- The daily sweep calls the same `recoverAbandoned`
  (`app/src/jobs/journalSweep.ts:244`): counted in `recovered`,
  `suggestion.updated` emitted (`:249`), and the truth check (`:251-280`)
  finds no active journal.
- `resolve()` help path (`suggestionResolution.ts:748-754`): the refusal flags
  are ignored and only `stateChanged` -> `helpedCommitted` is used. A requester
  who retries their OWN abandoned identity helps it to completion and then
  answers 200 `completedNow: false` from the completed-row branch
  (`:756-770`). This is pre-existing and spec section 2 change 5 accepts it
  ("a request that only helps or replays a journal keeps today's answers").
- Tasks 1.3 (FakeWorld read + sweep), 1.6 (FakeWorld legacy read) and 1.7
  (DynamoDB Local read, sweep and legacy) prove these paths.

## N4 - Tasks 1.5-1.7 - NOTE: a known intermediate state between commits

From the Task 1.5 commit until the Task 1.7 commit, the real repo (and, after
1.6, the fake) answer `superseded_by_reclassification`, but `applyJournal`
does not yet flag it. So a requester's own reclassified accept answers 200
`completedNow: true`. No authority is written, and the journal and verdict
are already correct. The Task 1.7 RED depends on exactly this state. Nothing
to do; a mid-slice reviewer should not read it as a regression.

## N5 - cross-reference RF1 F1 (owned by RF1) - NOTE: how it lands next to S1's dashboard edits

RF1 (`build-research/RF1-invariants-I1-I2-findings.md`, F1) records a team
member's housing-authority chip. Through "Is this really new?" ->
`editHousingAuthorityTo`, it writes the authority by PATCH and never reaches
D1's 409. I confirmed the premise: `team_member` renders the tenant file
(`dashboard/src/routes/contact/ContactDetail.tsx:574-584`). If the
orchestrator adopts RF1's fix:

- It lives in `onAcceptSuggestion` (`ContactDetail.tsx:816-823`). That does not
  overlap Task 1.10's anchor (`:708-725`) or Task 2.8's anchors (`onTriage`,
  state, imports).
- Only `housingAuthority` goes through `reviewHousingAuthority`, so the
  dashboard needs no copy of the seven-target set. The guard can be
  `target === 'housingAuthority' && contact.type !== 'tenant'`, which skips
  the dialog and calls `acceptSuggestionValue(target)`, so the server answers
  409 `suggestion_contact_not_tenant` with Task 1.9's copy.
- Its test can sit beside Task 1.10's not-a-tenant PIN, in the "suggestion
  accept/dismiss failures" describe.

## N6 - spec 8 coverage - NOTE: the prior-authority tie on DynamoDB Local is repo-level only

On DynamoDB Local, the "accept over a prior authority spanning a conversion"
case runs only at the repo level (Task 1.5, "classification wins the tie",
conversion simulated by `putContact(contactId, CONVERTED)`). The real
conversion service does not drive it. Plan review R1 row 8 added only the
voucherSize generic re-type and the status case to the real-repo suite
(Task 1.7), so this matches the adjudications. FakeWorld covers the
prior-authority case through the real conversion route (Task 1.7).

## N7 - Task 1.4 - NOTE: one export beyond binding section 2

`CLASSIFICATION_GUARD_KEYS` is exported from
`app/src/repos/suggestionResolutionRepo.ts` (Task 1.4). It is not among
section 2's names and nothing else imports it. It is harmless; leave it or
make it module-private, and either choice lints clean.

## N8 - all tasks - NOTE: the worktree checks files out with CRLF

`core.autocrlf=true`, and every S1 file is CRLF in the working tree (for
example `app/src/services/suggestionResolution.ts`: 862 of 862 lines). The
Edit tool matches regardless, and new files come out LF. Both are fine:
- The plan's ASCII checks (`tr -d '\11\12\15\40-\176'`) strip CR.
- The Task 1.6 source-pin regexes (`[^}]*`, `\.plan\.guard\b`,
  `effectiveGuard\(journal\)`) are not affected by CR.

No action.
