# S4 - e2e and docs (Tasks 4.1-4.3) - build report (feat/matching-blast-rules)

Implementer S4 (Claude Opus 5.5), 2026-10-18. Plan section 8, Tasks 4.1-4.3,
with the binding rulings AR11, AR17, AR22, AR31, AR43 and worklist OR-S4-1,
OR-S4-2, OR-S4-3, OR-S4-5. Tasks 4.4-4.5 (gates, sync, handback) are the
orchestrator's (OR-S4-4) and were NOT done. Base 4e096e7f (S3b tip c59a03d2 +
the S3 -> S4 worklist hand-down). Run state (gitignored):
`.superpowers/gates/<label>/{e2e.log,exit.txt}`, `.superpowers/gates/s4-4*-*.log`,
`.superpowers/sdd/S4-end-typecheck.log`. Every e2e run used the plan's runner
`.superpowers/gates/run-e2e-files.sh` verbatim (per-file, `timeout 1500`, the
e2e workspace), launched detached and waited on IN-TURN; nothing was edited or
committed while a run was live.

## Commits

| Task | Commit | One-liner |
|---|---|---|
| 4.1 | bd9b9243 | repair the five Matching specs and selectors.md (run-unique authorities, explicit statuses, consent; a2p exceptions kept); the AR22 draft-delete repair |
| 4.2 | ae97dd30 | the new spec `e2e/tests/dashboard-next/matching-blast-rules.spec.ts` |
| 4.3 | 9418c720 | GLOSSARY (+ OR-S4-2 sentence), RUNBOOK, truncation issue resolved, 422 issue refreshed (OR-S4-3) |

## e2e runs (each on its own fresh lane 10: app 10001, dashboard 10011, fake 10021, public 10031)

| Label | What | Launched -> exit.txt | exit.txt | e2e.log summary |
|---|---|---|---|---|
| s4-41-red | the five specs on the S3 tip, before any edit | 23:04:58 -> 23:10:24 | EXIT:1 | 7 failed, 41 passed (5.4m) |
| s4-41-green | the five specs after Task 4.1 | 23:15:09 -> 23:16:38 | EXIT:0 | 48 passed (1.5m); 0 flaky, 0 retries |
| s4-42-red | the new spec with the AR11 mutation | 23:18:15 -> 23:18:43 | EXIT:1 | 1 failed (test 17.7s) |
| s4-42-green | the new spec, mutation reverted | 23:19:13 -> 23:19:30 | EXIT:0 | 1 passed (16.0s; test 6.9s) |

## Task 4.1 - repair the Matching specs

RED (s4-41-red): exactly the seven tests Step 2 predicts, each read in e2e.log:
1. `a2p-compliance.spec.ts:324` (8.3 test 1) - `:387` the no-consent badge not
   found: the row is not listed (no authority under the Atlanta prefill).
2. `broadcasts.spec.ts:96` (test 1) - `:165` list `Candidate recipients` not
   found. A zero-row preview renders the `No candidates` paragraph instead of
   the list (`RecipientPreview.tsx:537`), so "keep/drop not listed" surfaces
   one locator earlier than the plan words it - same cause (no authority under
   the Atlanta prefill; Tasha Placing).
3. `broadcasts.spec.ts:231` (test 2) - `:247` `Send to N recipient(s)` never
   enabled in 60 s (Send to 0: the lane-dependent case, F16).
4. `matching-entry-points.spec.ts:272` - `:325` no element labeled exactly
   `Housing authority`.
5. `org-lists.spec.ts:321` and 6. `:450` - fill timed out on combobox
   `Housing authority` (exact).
7. `review-recipients-heard-from.spec.ts:119` - `:160` list not found (zero
   rows, as 2).
Pins green: every other test in the five files, incl. the a2p path (c) test
(`skipped_no_consent`) and the draft-delete test (the AR22 race did not bite).

Applied Steps 3a-3o, 4a-4d, 5a-5f, 6a-6e, 7a-7b, 8a-8e as the plan gives them,
plus the AR22 repair. Static checks: e2e typecheck EXIT:0; eslint on the five
specs EXIT:0; every added line ASCII; no literal `\u`; LF. AR31:
`grep -n "TASHA\|Tasha\|tashaConsent"` prints TWO comment lines (`:27` from 3b,
`:140` from 3h). Step 6 check: `'Housing authority'` remains only at the
contact-form / Settings sites (`org-lists.spec.ts:241`, `:434`, `:467`, `:960`,
`:962`).

AR22 / OR-S4-1 (`broadcasts.spec.ts:451-467`, `:1`): a `page.on('response')`
recorder of every `POST /api/broadcasts`, armed before the `page.goto`; fill the
message; `Preview recipients` toBeEnabled (15 s); the draft id is the LAST
recorded create whose request `body_template` contains the typed message, its
JSON read before navigating away; `type Response` added to the import.

GREEN (s4-41-green): 48 passed, 0 failed.

## Task 4.2 - the new spec

Step 1 file byte-identical to the plan block (cmp vs plan lines 12017-12343).
Static: e2e typecheck EXIT:0, eslint EXIT:0, non-ASCII bytes 0, LF.
RED by mutation (AR11): `startChecked = [searching, onboarding, notFit, touring]`
-> the one test failed at `:266` `getByText('Reaches 4 recipients', { exact: true })`;
its error-context snapshot shows the reach line `Reaches 3 recipients`, both
authority chips, `2-BR - matches property` pressed and the full three-sentence
caption - setup, the D9 picker, the D3 prefill and the D8 caption all passed
before the mutated line. Reverted: `grep -n "notFit, touring\]"` prints nothing
and the file is byte-identical to the plan block again. GREEN: 1 passed (the
run asserts AR43's `Tour requested <d>, no date yet` tag and its lower-cased
checkbox cue against the live UI, `:278-299`).

## Task 4.3 - docs

Steps 1-4 as the plan gives them, DATE `2026-10-18` (`date +%F`).
- OR-S4-2: one sentence appended to the GLOSSARY "Who a blast reaches" text,
  before its Design line: if tours or Not interested replies cannot be read, a
  filter blast's review waits with Try again (and the API's no-body filter send
  answers 503 `audience_rules_unavailable`), while a direct send from a
  contact's page goes ahead with a notice that the labels could not be loaded.
- OR-S4-3: `docs/issues/composer-org-422-offer-renamed-entry.md` refreshed -
  title, refs (`BroadcastComposer.tsx:62-67`, `:245-268`, `:533-538`;
  `broadcasts.ts:643-679`), the Problem rewritten for the D3b one-member
  removal and its copy (the old whole-filter clear kept as history), the
  Suggested fix adapted (put the one candidate in place of the removed
  member); status stays `open`; `updated: 2026-10-18` added.
Checks: the `TODO(broadcast-audience-truncation-drops-searching-tenants)` grep
over app dashboard e2e scripts prints nothing; `npm run issues` EXIT:0 with no
warning line (420 open, 210 closed); added lines ASCII, LF;
`grep -n byHousingAuthority RUNBOOK.md documentation/GLOSSARY.md` = exactly
`RUNBOOK.md:1459` and `GLOSSARY.md:340`, the two edited mentions, each saying
the GSI is kept and not read by the blast. No GSI issue filed; AGENTS.md
untouched; the gitignored INDEX.md not staged.

## Ruling table

| Ruling | Applied |
|---|---|
| AR11 | Task 4.2 RED by mutation (above); Task 4.3 has no test step |
| AR17 | per-file runs under `timeout 1500` (the plan's runner) |
| AR22 / OR-S4-1 | draft-delete repair (above; deviation 1) |
| AR31 | two comment lines (above) |
| AR43 / OR-S4-5 | selectors.md 8d tag/cue copy and the spec's `requestedLabel` as the plan has them; proved by s4-42-green |
| OR-S4-2, OR-S4-3 | Task 4.3 (above) |
| OR-S4-4 | Tasks 4.4-4.5 left to the orchestrator |

## Deviations from the plan text

1. AR22 has no step text (R4-2). Implemented per AR22 / OR-S4-1 with R4's
   stricter variant (R4 reference section 9): the LAST recorded create whose
   `body_template` CONTAINS the typed message (`includes`, not equality: a fill
   that straddles the prefill commit can append the typed text to the prefill,
   `docs/issues/a2p-consent-reinclude-fill-races-prefill.md`). It is the same
   draft as `creates.at(-1)` whenever responses arrive in request order, and
   stays right if a superseded create's response lands after the current
   one's. `created?.json()` after `expect(created).toBeDefined()` (no `!`).
2. Task 4.1's commit message is the plan's plus "; the draft-delete test ...
   (AR22, OR-S4-1)".
3. Task 4.3 commits a fourth file (the 422 issue, OR-S4-3); its message names
   OR-S4-2 and OR-S4-3.
Every other edit is the plan's old/new text verbatim.

## Notes for the orchestrator (before the full gate run)

- Lane state: lane 10 was torn down after every run (netstat: no listener on
  10001/10011/10021/10031). `e2e/.artifacts/session.pid` (69344) and
  `lane.json` are leftovers of the last run's launcher - that process is gone.
  No `e2e:session` was started; nothing of S4's is running.
- No flaky signal: 0 flaky, 0 retries, no ENOBUFS / ERR_NO_BUFFER_SPACE in any
  run. The five files take 1.5 min green on this host (RED 5.4 min: three 60 s
  timeouts); the new spec takes 6.9 s alone (`test.slow()`, 180 s cap).
- The draft-delete test passed on the unrepaired S3 tip too; the AR22 repair
  is robustness, not a fix of an observed failure.
- Every repaired list/count assertion and the new spec create what they
  assert per run (run-unique `Bcast Compose`, `Bcast Warn`, `Heard Review`,
  `A2P Consent`, `Plover`, `Pipit`, `Wagtail`, `Wren Rules`, `Finch Rules`
  authorities), so a fuller lane cannot change them. One cost note: broadcasts
  test 1's prior send still creates a filter draft with NO authority
  (`bedroomSize: 2` only, plan 3h-3j unchanged), whose create-time estimate
  reads every 2-BR Searching/Onboarding tenant in the lane - harmless (its
  send is path (a) to `prior` only), just more reads in the full suite.
- Slice-end root `npm run typecheck` EXIT:0 (0 `error TS`). The six e2e specs
  S4 touched lint clean; S4 touched no app or dashboard source.

## Not done

Tasks 4.4 (the five gates, the gate-5 baseline, the lint record) and 4.5 (the
single main sync, the handback) - the orchestrator's (OR-S4-4).
