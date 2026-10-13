# join-housing-authority - spec-conformance re-review (round 2, spec revision 5)

- Contract: spec revision 5 (@09acd16b). The new items are: the D10 earlier-run exclusion,
  the pending-suggestion leave-out, the `--skip` typo rules, the failure wording, the
  widened "safe to re-run" list, and D12 (the Settings note).
- Code reviewed: `git diff 15c1676f 0eb44652 -- . ":!docs/superpowers"` (15 files) plus
  the docs/issues changes in that range. The worktree HEAD (f563e68d) has no code change
  after 0eb44652, and the spec has no change after 09acd16b, so every `file:line` below is
  valid at HEAD.
- Method: I read the code and the tests only. I ran nothing: no suites, scripts, database
  or network. A cited test means the test exists and asserts the behavior. Whether it
  passes comes from the mission's gate record, which this review did not re-run.

## Verdict counts (revision-5 rows only)

20 rows: **18 CONFORMS, 2 DEVIATES (both immaterial), 0 MISSING.** Nothing is blocking.
The fix wave regressed none of the round-1 rows (section 2).

## 1. Revision-5 items

| # | Item | Verdict | Code | Test |
|---|---|---|---|---|
| R1 | D10: every `--apply` appends a `housing_authority_backfill_excluded` event (no actor) to each candidate it leaves out because of `--skip` | DEVIATES (immaterial) | `app/scripts/backfill-join-housing-authority.ts:114`, `:683-704` (`recordExclusion`), `:796-803` (apply + `skipped` only). Payload `{ field: 'housingAuthority' }`, no actor. The code appends only when the lead's history holds NO exclusion yet (`:686`, `already_recorded`). A second `--apply` naming the same lead appends nothing, where the spec reads "every `--apply` appends". Later runs behave the same, so nothing is lost. See F1. | `app/test/backfillJoinHousingAuthority.test.ts:1159` (one event `{ field }` with no actor, on the `--skip` lead only; a re-run adds no second), `:1500`, `:1244`, `:1276`, `:1327`, `:1359` |
| R2 | D10: every later run, dry run included, leaves a candidate holding an exclusion out, reason "excluded on an earlier run" | CONFORMS | `backfill...ts:186, 199` (first in `leftOutReasonFromAudit`), reason copy `:271` (REASON_TEXT, exact). The exclusion is not authority history: `touchesHousingAuthority` defaults to false for the new type. | `test:234` (wins over a re-sign-up and an authority history; is not history), `:900`, `:920`, `:1159` (later dry run AND apply with no `--skip` leave it out, print the exact line, and write nothing) |
| R3 | D10: a candidate with a PENDING `housingAuthority` suggestion, read with `getSuggestion(contactId, 'housingAuthority')`, is left out; the reason shows the value: "has a pending housing authority suggestion (<value>) - accept or dismiss it first" | CONFORMS (exact copy) | `backfill...ts:596-604` (one consistent GetItem, only for a candidate no earlier reason leaves out), `:277-280` (copy; the value is escaped like a name). "Pending = a row exists" holds: `sugg#<id>#<target>` exists only while pending; accept and dismiss delete it, and a dismissal is a separate `dism...` tombstone (`app/src/repos/extractionRepo.ts:699-751`). The stage env is honored (`createExtractionRepo` uses `tableName('ai_extraction', deps.env)`, `extractionRepo.ts:319`; wired at `backfill...ts:435`). The precedence note is under F3. | `test:790`, `:931` (read only when nothing earlier applies; consistent read; a dismissed one is not pending), `:1429` (value shown escaped; dry run and apply; nothing written), `:1468` (a failed read is a read failure, exit 1) |
| R4 | D10: a `--skip` id naming an EXISTING contact that is not a candidate is reported and otherwise ignored | CONFORMS | `backfill...ts:540` (the Scan collects every non-pointer contactId, deleted ones included), `:766` | `test:1776` (flyer lead, a lead holding an authority, the marker, a deleted contact: reported, apply goes ahead) |
| R5 | D10: on `--apply`, a `--skip` id naming NO contact refuses the run (exit 1, nothing written) | CONFORMS | `backfill...ts:755-761` (after the Scan, before any history read or write); `main` prints the refusal and exits 1 (`:922-925`) | `test:1750` (nothing written, nothing printed), `:2048` (apply exit 1 with the refusal printed) |
| R6 | D10: a dry run reports a typo id | CONFORMS | `backfill...ts:370-372` (one line per id) | `test:376`, `:2048` (dry run exits 0 and reports it) |
| R7 | D10: any other write error is a failure whose report line says the write "may or may not have landed - re-run the dry run to see", never "nothing written" | DEVIATES (wording, immaterial) | `backfill...ts:287-288`: the line reads `FAILED: the write may or may not have landed (an ERROR line names this contactId) - re-run the dry run to see`. The parenthetical splits the quoted phrase, so the spec's string is not a substring of the line. The log line has it verbatim (`:652`). The meaning is intact and "nothing written" never appears on a write failure. See F2. | `test:1567` (a failed WRITE never says nothing written), `:1624` (a timeout after the write landed: `write_failed`; the dry run then shows where the lead stands) |
| R8 | D10: safe to re-run; never touches an earlier-run exclusion or a pending suggestion (added to the list) | CONFORMS | rows R2-R3; the conditional write itself is unchanged (`backfill...ts:632-654`) | `test:1159` (re-runs with and without `--skip`) |
| R9 | D12 surface: Settings > Add housing authority | CONFORMS | `OrgListSection.tsx:391-406` opens `NewOrgDialog` with `kind = SEGMENT_KIND[segment]`, and `chosenKind = kind` (`NewOrgDialog.tsx:105`). The note shows when `chosenKind === 'housing_authority'` (`:151, 262-266`) and describes Name (`:248`). | `OrgListSection.test.tsx` "Add housing authority says so under the Name field; Add agency does not"; `NewOrgDialog.test.tsx` D12 block |
| R10 | D12 surface: Rename a housing authority | CONFORMS | `OrgEntryDialogs.tsx:292` (`entry.kind === 'housing_authority'`), `:342, 348-352` | `OrgListSection.test.tsx` "renaming a housing authority says so under New name; renaming an agency does not"; e2e `org-lists.spec.ts:638-642` (accessible description on New name) |
| R11 | D12 surface: kind change agency -> housing authority | CONFORMS | `OrgEntryDialogs.tsx:471`: `to === 'housing_authority' && !blocked` describes the Move button (`:503, 518-522`). Hidden while the move is blocked, because then the entry cannot become a housing authority. | `OrgListSection.test.tsx` "a kind change INTO Housing authorities says so" and "a kind change out of Housing authorities, or a move into them that is blocked, shows nothing new" |
| R12 | D12 surface: "Not on the list" > Add as new | CONFORMS | `NotOnListSection.tsx:335`: `settle.action === 'add' && addKind === 'housing_authority'`. `addKind` is `housing_authority` for a housingAuthority, `accepted_authorities` or `audience_filter` row (`kindsForField`, `orgCopy.ts:34-42`). An organization row starts at null and shows the note only once Housing authority is chosen (`:262`). The note describes Name (`:462, 470-474`). | `NotOnListSection.test.tsx` D12 block: HA value and property value say so; agency value does not; organization value only after the choice |
| R13 | D12: agencies show nothing new | CONFORMS | Agency add (chosenKind `agency`), agency rename (`entry.kind`), HA -> agency move (`to = agency`), and agency Add as new (`addKind = agency`) all show nothing | the tests in R9-R12 each pin the agency side |
| R14 | D12: the line shows ONLY where an entry is added, renamed or re-kinded into a housing authority. I enumerated every Settings surface from the code. | CONFORMS | The `OrgListSection.tsx:409-453` dialogs: Notes, Spellings and Delete add no list name. Merge is same-kind only (`OrgEntryDialogs.tsx` MergeDialog, `targets` filtered by `e.kind === entry.kind`) and adds no name. "Not on the list" Use, Use another name, Move to Housing authority/Agency, Split and Clear all pick EXISTING names: the OrgPickers there pass no `onRequestAdd`, so they have no add path. "Remember this spelling" adds a spelling, and spellings are never served to /join (D1). None shows the note. | `NotOnListSection.test.tsx` "a settle that adds no entry shows nothing new" (Move to Housing authority, Use, Clear) |
| R15 | D12: copy only, no behavior change | CONFORMS | Only `<p>` lines and `aria-describedby` change. The Add button's description still carries `problemId` exactly when it did (`NewOrgDialog.tsx:152-157`). The note joins it only in the AI-suggestion mode, which has no Name field. | n/a |
| R16 | D12 copy "Housing authority names appear on the public sign-up form." | CONFORMS (exact) | `dashboard/src/routes/orgs/orgCopy.ts:96` (one constant, three importers) | e2e `org-lists.spec.ts` `UI.publicNote` |
| R17 | RUNBOOK: the five left-out reasons, in the code's order, with exact reason text | CONFORMS | `RUNBOOK.md:456-461`. They match REASON_TEXT and reasonText. The pending bullet adds the Atlanta-valued-suggestion caveat (dismissing does not keep the backfill away), which is accurate. | n/a |
| R18 | RUNBOOK: the typo refusal (`--apply`) and the dry-run line | CONFORMS | `RUNBOOK.md:470` (refusal text matches `backfill...ts:757-760`), `:478` (matches `:371`) | n/a |
| R19 | RUNBOOK: failure wording (write may or may not have landed; a read failure says nothing was written; a failed exclusion append) | CONFORMS | `RUNBOOK.md:477, 483-485` match `backfill...ts:286-293` verbatim | n/a |
| R20 | RUNBOOK: remembered exclusions in steps 2-4 and the widened re-run-safety list | CONFORMS (see F4) | `RUNBOOK.md:480` (keep `--skip` until the first `--apply`), `:481` (REMEMBERS: once, a read failure still appends, non-candidates not remembered), `:489` (step 4), `:492` (cost) | n/a |

Not counted as a spec row: the FW-5 issue work, which was Cameron's ruling in
`planner-review/adjudications.md`, not a spec item.
- `docs/issues/join-repeat-signup-answer-unreachable.md` is deleted, with no live reference
  left. A grep of `*.md`, `*.ts` and `*.tsx` outside the mission records finds only the
  gitignored `.superpowers/` handbacks.
- `join-backfill-ignores-pending-authority-suggestion.md` is resolved, and its Resolution
  names `37d02e42`.

## 2. Regression check of the round-1 rows against the new code

- **D1-D9, `/join` and flyer boundaries (round-1 rows 1-17, 29-38, 39-54):** the fix wave
  touches no file under `app/src`, `dashboard/src/routes/public`, `app.ts` or `public.ts`
  (diff stat). IntakeForm and FlyerPage are unchanged. No regression is possible there.
- **Row 18 (CLI):** `parseStageArgs` and `BACKFILL_ARGS` are unchanged; only the USAGE text
  grew (`:865-869`). Still conforms.
- **Row 19 (list refusals, no lock):** `checkBackfillList` is unchanged (`:449` on). The
  header and docblock now separate the pre-Scan refusals ("no contact read") from the
  post-Scan typo refusal ("nothing written"). The RUNBOOK keeps them apart too
  (`:465-470`). Still conforms.
- **Row 20 (candidates):** `isCandidate` and the Scan filter are unchanged; the Scan also
  collects contactIds (`:540`). Still conforms.
- **Row 22 (dry run writes nothing; names never in logs):** `recordExclusion` runs only
  when `opts.apply` (`:796`). A dry run makes no read at all for a `--skip` lead (`:598`;
  `test:1378`). The new log lines carry contactId and reason only. The suggested value goes
  to the printed report, never to a log line. Still conforms.
- **Row 23 (apply):** the guarded update and the `housing_authority_backfill` event are
  unchanged (`:632-664`); only the failure label changed (R7). Still conforms.
- **Row 24 (round-1 F1, post-apply re-read only after a write):** unchanged (`:816`). An
  apply that records exclusions but writes nothing still skips the re-read. That is
  harmless, because exclusions do not depend on the list name.
- **Row 26 (exit codes):** the new failure kinds all count in `failed`: read failure, write
  failure, and exclusion-append failure (`:781, 646-653, 798-801`). Each gives exit 1. The
  typo refusal is a `BackfillRefusedError` and gives exit 1. A dry run with a typo gives
  exit 0, which matches "a dry run reports it". Still conforms.
- **Rows 27-28 (agent rule, D11 steps):** dry run, read the list, apply, dev before prod are
  all intact (`RUNBOOK.md:474-490`). Still conforms.

No round-1 row regressed.

## 3. Findings

**F1 [LOW] - The exclusion is appended once per lead, not "on every --apply"
(R1, DEVIATES immaterial).**
- `recordExclusion` reads the history and skips the append when an exclusion is already
  recorded (`backfill...ts:684-686`).
- The spec's sentence "every `--apply` appends ... to each candidate it leaves out because
  of `--skip`" reads as one event per apply.
- Every later run decides the same way either way, and duplicates add nothing.
- Orchestrator decision 3 chose "no duplicates", and `test:1500` pins it.
- Fix: amend the spec ("records one ... unless one is already recorded"), or accept as is.

**F2 [LOW] - The write-failure report line does not contain the spec's quoted phrase
verbatim (R7, DEVIATES wording).**
- The spec quotes "may or may not have landed - re-run the dry run to see". The line inserts
  "(an ERROR line names this contactId)" between the two halves (`backfill...ts:288`).
- The log line (`:652`) and the RUNBOOK (`:484`) are consistent with the code.
- The meaning is preserved, and "nothing written" never appears on a write failure.
- Fix: amend the spec quote, or accept as is.

**F3 [LOW] - The reason precedence can hide what the spec says the line shows.** Every
reason still leaves the lead out; this only affects which one is printed.
- The pending suggestion is printed LAST (orchestrator decision 2), and it is read only
  when no earlier reason applies (`backfill...ts:598-604`). A lead with both an authority
  history and a pending suggestion therefore prints "its housing authority was set or
  removed before". The suggested value is never shown, though spec R3 says "the reason
  shows the suggested value".
- A lead with an earlier exclusion that is named in `--skip` again prints "named in --skip",
  not "excluded on an earlier run" (`:598`; `test:920`).
- Nothing is written to either lead, and the RUNBOOK states the order (`RUNBOOK.md:456`).

**F4 [LOW] - RUNBOOK step 4 can send an operator to apply a lead they skipped.**
- Step 4 (`RUNBOOK.md:489`) says "the `--skip` value is no longer needed", and that a lead
  which shows up again "had its write SKIPPED or FAILED in step 3: apply again".
- A `--skip` lead whose exclusion was NOT recorded also shows up again as a target in that
  dry run. Two ways this happens: its append failed, or the apply was killed before reaching
  it. Exclusions are recorded in candidate order, interleaved with the writes.
- Following step 4 literally (apply again, no `--skip`) then gives that lead Atlanta Housing
  Authority.
- Step 3's FAILED-exclusion line does say "keep it in --skip and re-run the apply". The two
  instructions disagree, and a killed run prints no line at all.
- Suggested fix: step 4's "apply again" should read "apply again with the same `--skip`".
  Better still, check that none of the reappearing leads is one you skipped.

**F5 [LOW] - Scope beyond revision 5: the D12 note also appears outside Settings.**
- `NewOrgDialog` is shared, and its note shows in every mode (`NewOrgDialog.tsx:146-151`,
  orchestrator decision 6). It therefore appears on these record forms' "Is this really
  new?" dialogs: ContactEditForm, ListingEditForm, UnitCreateForm and CaseworkerDialog. It
  also appears on the contact page's AI-suggestion "Yes, add it" (ContactDetail), where it
  describes the button. Tests: `NewOrgDialog.test.tsx` "in Settings and on a record form",
  and the AI-suggestion case.
- D12's wording scopes the note to "Settings > Housing authorities & agencies" surfaces.
- The statement is true wherever it shows, since these dialogs do put a housing authority
  on /join.
- Fix: accept, or have Cameron confirm and amend D12 to "every surface that adds ...".

**F6 [LOW] - Scope beyond revision 5: two new FAILED (exit 1) cases, both sensible.**
- A failed exclusion append is a FAILED lead with its own line: "its exclusion may not have
  been recorded ... keep it in --skip". By contrast, a failed `housing_authority_backfill`
  append stays a WARNING with exit 0. The asymmetry is justified: an unrecorded exclusion
  is what a later run would overwrite.
- A failed pending-suggestion read is a read failure, exit 1.
- The spec is silent on both. Both are tested (`test:1244, 1276, 1359, 1468`).

**F7 [LOW, carried from round 1] - The post-apply list re-read still runs only after an
apply that wrote (`backfill...ts:816`).** This is unchanged and immaterial.

No BLOCKING, HIGH or MEDIUM findings. No revision-5 item is MISSING.
