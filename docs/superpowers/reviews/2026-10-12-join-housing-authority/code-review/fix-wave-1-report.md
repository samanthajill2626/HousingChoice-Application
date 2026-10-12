# Fix wave 1 - report (implementer)

Branch feat/join-housing-authority, started at 59999afc (R1 records commit). Work list:
the "Fix wave 1" table of `R1-adjudications.md`, nothing else. Six commits, one per item.
Logs under `.superpowers/sdd/fw1-*.log` (gitignored run state).

| Item | Commit | Files |
|---|---|---|
| R1-C1 | 33848c33 | app/test/backfillJoinHousingAuthority.test.ts |
| R1-ADV-4 | ce79d0fa | app/scripts/backfill-join-housing-authority.ts, app/test/backfillJoinHousingAuthority.test.ts |
| R1-C3 | 955b01f8 | dashboard/src/routes/public/IntakeForm.props.test.tsx |
| R1-C4 | 3993c693 | app/src/routes/public.ts (comment only) |
| R1-ADV-2 (doc part) + R1-ADV-7 | 6c7b018a | RUNBOOK.md (2 lines, the backfill section only) |
| R1-C6 | 514538d2 | documentation/STATUS-MODEL.md (landlord Needs review bullet) |

## R1-C1 - child-process usage test names no --env (33848c33)

- Change: app/test/backfillJoinHousingAuthority.test.ts:1418 (line as of the tip, after
  the R1-ADV-4 test landed above it) now spawns the CLI with `--bogus` alone (was
  `--env dev --bogus`); comment at :1416-1417 says why (no --env is a
  usage error by itself, `parseStageArgs` app/scripts/lib/stageClient.ts:205-206, so even a
  parser that tolerated the unknown flag could not reach a deployed target). Exit-2 and
  usage-text assertions unchanged.
- GREEN: the child-process case alone 1 passed; the whole file 74 passed / 0 skipped
  (real DynamoDB Local).
- Mutation proof (script sha256 d11096ff...c1aa recorded before, identical after; `git
  status` showed only the test file modified):
  - M-a: usage branch `return 2;` -> `return 0;` (backfill script :682 at 33848c33; :699
    at the tip). Test FAILED:
    `{"status":0,...}: expected +0 to be 2`.
  - M-b: usage branch prints nothing (`printError(USAGE)` removed, `return 2` kept). Test
    FAILED: `{"status":2,"signal":null,"stderr":""}: expected '' to contain 'Usage: npx tsx
    app/scripts/backfill-j...'`.
  - Restored with Edit; sha256 back to d11096ff...c1aa (byte-exact).

## R1-ADV-4 - control characters in report names shown escaped (ce79d0fa)

- RED first: new test app/test/backfillJoinHousingAuthority.test.ts:339-373 (in the
  formatBackfillReport block). Every special character is built with String.fromCharCode
  (a newline name carrying a forged "contactId c-forged" tail, an ESC [2K + CR name, and a
  last name with tab, 127, 155, 159, then a no-break space 160 and `~`; a first name with an
  accented e (233) and double quotes, an apostrophe in the last name). Expected escapes are
  written as `${BS}x0a` with BS = char code 92 - no backslash-u typed anywhere. RED reason
  seen: the received report split "Mallory" / "  Forged Line ... contactId c-forged X ..."
  across two lines and carried the raw ESC and CR - exactly the finding.
- Fix: `visibleName` app/scripts/backfill-join-housing-authority.ts:230-245 (doc comment
  and function), used by `leadLine` :247-248. Iterates the string, `charCodeAt(0)`; code <= 31 or 127..159 becomes
  backslash + `x` + two lowercase hex digits (`toString(16).padStart(2, '0')`); everything
  else unchanged. Verified the source bytes are a literal `\\x` in a template (od -c) and
  that neither touched file contains a backslash-u sequence (`grep -cF` = 0).
- GREEN: whole file 75 passed / 0 skipped. Every pre-existing report expectation unchanged
  and green. The test also asserts no line of the report contains a control character.
- Choice made: the name is escaped BEFORE `.trim()`, so a control at a name's edge (the tab
  in the test) is shown, not silently trimmed. The public route already trims names, so
  this only matters for names stored another way. Pinned by the test.

## R1-C3 - direct form submit while submitBlocked (955b01f8)

- New test dashboard/src/routes/public/IntakeForm.props.test.tsx:112-133: fills every
  field validly, checks consent, `fireEvent.submit(form)` with `submitBlocked` -> onSubmit
  not called, no alert, button still disabled; then rerenders with `submitBlocked={false}`
  and the same direct submit DOES call onSubmit once (positive control, so the negative is
  not vacuous). `fireEvent` added to the existing testing-library import.
- Mutation proof (IntakeForm.tsx sha256 38d4a8a5...461a recorded before, identical after):
  removed `if (submitBlocked) return;` (IntakeForm.tsx:100) -> props file 1 failed / 7
  passed; the failure is the NEW test only ("expected spy to not be called at all, but
  actually been called 1 times"); the existing Enter-key test stayed green, confirming the
  review's reading. Restored with Edit, hash back to 38d4a8a5...461a.
- GREEN: props file 8/8; `npx vitest run src/routes/public` 8 files, 75 passed.

## R1-C4 - public.ts comment (3993c693)

- app/src/routes/public.ts:209-217 now says: default createOrgListRepo(); when one is
  injected (deps.public in app.ts - the tests) app.ts hands that same repo to
  createPublicHousingAuthoritiesRouter too; otherwise each router builds its own default,
  which reads the same stored item the same way (one consistent read per call, nothing
  cached - per app/src/repos/orgListRepo.ts:8 and :114). Comment only.

## RUNBOOK - R1-ADV-2 doc part (a), R1-ADV-7 (b), (c) (6c7b018a)

- Exactly 2 lines changed (`git diff --stat`: 2+/2-), both inside "/join leads: the
  housing authority backfill" (RUNBOOK.md:454 and :458). ASCII.
- (a) :454 - after "gets the authority too": a backfilled lead holds Atlanta Housing
  Authority like any held value; an authority it states later arrives as an AI suggestion
  for staff to accept, never an overwrite - same as a /join lead left on the default (spec
  section 4).
- (b) :454 - the marker parenthetical now reads: any lead that signed up after the deploy
  with no housing authority is never touched - an answer of "Not sure", a list that failed
  to load, or a page loaded before the deploy.
- (c) :458 - the `signed up again after the change` bullet: a /join answer is kept only in
  the lead's audit history, which no staff screen shows (issue
  `join-repeat-signup-answer-unreachable`, tracked); a flyer re-sign-up never saw the
  question and is left out too, erring safe.

## R1-C6 - STATUS-MODEL landlord Needs review (514538d2)

- documentation/STATUS-MODEL.md:194-197: "the same front door auto-captured and untriaged
  contacts land at, flyer sign-ups included; a tenant from a `/join` sign-up starts at
  `Onboarding` instead". Anchor copied from Read output; only those lines changed; added
  text ASCII (the file's pre-existing non-ASCII lines untouched).

## Gates run at the end

- `npm run typecheck` (bare, worktree root): exit 0.
- `npx eslint app/test/backfillJoinHousingAuthority.test.ts
  app/scripts/backfill-join-housing-authority.ts
  dashboard/src/routes/public/IntakeForm.props.test.tsx app/src/routes/public.ts`: exit 0,
  no output.
- No full suite, no e2e, no smoke (out of brief). The backfill script was never run
  against any environment; the only CLI spawn is the test's `--bogus` usage error.

## Remarks / concerns (findings for the orchestrator to weigh)

1. RUNBOOK step 1 (RUNBOOK.md:471) still describes each report line's name as "first and
   last name" with no word about escaped control characters. Left as is (brief: the three
   wording changes only). A one-clause addition there would tell the operator what
   `\x0a` in a name means.
2. A name that literally contains the four characters backslash, x, 0, a prints the same
   as an escaped newline. It cannot forge a line or move the cursor; it is only visually
   ambiguous. Backslashes were deliberately left unchanged per the brief.
3. Characters above 159 print raw by design (the adjudicated range is 0-31 and 127-159):
   that includes U+2028/U+2029 and the bidi controls (U+202E right-to-left override),
   which some terminals render as a visual reorder of the line. Not a new line in common
   terminals; noted so it is a decision, not an oversight.
4. The existing props test name "submitBlocked disables the submit button and an Enter in
   a field sends nothing" was kept; its Enter assertion is still true behavior but proves
   only the disabled button. The new test carries the guard's coverage and its comment says
   so.

Next step: orchestrator commits this report, then runs the final gate pass (second full
`npm run e2e`, with `E2E_TRACE=1` per the adjudication).
