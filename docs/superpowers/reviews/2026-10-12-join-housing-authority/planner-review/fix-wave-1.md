# Planner fix wave 1 - handback (orchestrator)

Input: `planner-review/adjudications.md` (the complete FW-1..FW-5 list) and spec revision 5
(@09acd16b: D10 additions, new D12). AUTO mode; every child a fresh foreground opus agent.
Decisions where the list left a choice: `fix-wave-1-decisions.md`.

MERGE-READY @0eb44652 on feat/join-housing-authority (W:\tmp\join-housing-authority), 0 behind
main (@5c0d3f6a), UNMERGED (human gate). All five gates green on 0eb44652 (section 4). The
commit carrying this file adds records only. Post-merge ops unchanged: the RUNBOOK backfill
entry (dev, then prod, after each deploy). No infra.

## 1. The list, item by item

| Item | Result | Commits |
|---|---|---|
| FW-1 persisted --skip | SHIPPED. `--apply` appends one `housing_authority_backfill_excluded` event (payload `{ field: 'housingAuthority' }`, no actor) to each CANDIDATE it leaves out because of `--skip`, never a duplicate; every later run, dry run included, leaves it out as "excluded on an earlier run". A `--skip` id naming NO contact refuses an `--apply` right after the Scan, before any write (exit 1); a dry run reports it on its own line; an id naming an existing non-candidate stays "reported, ignored". A failed exclusion append counts the lead failed (exit 1) with "its exclusion may not have been recorded ... keep it in --skip and re-run the apply". A `--skip` lead never depends on a read (fw1 review F1). | 2d65fa58 d87ac6b7 d98f6e9f 0572828a |
| FW-2 pending suggestion | SHIPPED. "Pending" = the `sugg#<contactId>#housingAuthority` row exists (accept and dismiss delete it; a dismissal is a separate tombstone) - read with `getSuggestion(contactId, 'housingAuthority', { consistentRead: true })`, only for a candidate no earlier reason leaves out. Reason line: "has a pending housing authority suggestion (<value>) - accept or dismiss it first", the value escaped like names. | 37d02e42 |
| FW-3 failure wording | SHIPPED. A non-conditional write error: "FAILED: the write may or may not have landed (an ERROR line names this contactId) - re-run the dry run to see" (and its log line); a failed READ keeps "FAILED: nothing written ... re-run" (true - no write was attempted). | 738964fc |
| FW-4 D12 Settings note | SHIPPED. "Housing authority names appear on the public sign-up form." on: "Is this really new?" (`NewOrgDialog` - Settings "Add housing authority" AND every record form's "Add as new" and the AI suggestion's accept, per decision 6, only once the kind is or will be a housing authority), Rename of a housing authority, Change kind into Housing authorities (not while the move is blocked), "Not on the list" > Add as new for a housing authority. Wired with `aria-describedby`. Out of scope with reasons (unit B report): spellings, merge, delete, notes, the other settles. One e2e assertion in `org-lists.spec.ts`. | 16a0f963 d9cdba7b 99b14981 |
| FW-5 issues | SHIPPED. `join-repeat-signup-answer-unreachable.md` deleted (the RUNBOOK was its only live reference; records keep it as history); `join-backfill-ignores-pending-authority-suggestion.md` resolved (2026-10-12, names 37d02e42). | 9bb30403 |
| RUNBOOK | UPDATED: the five left-out reasons and their precedence, the refusal, the remembered exclusions (keep `--skip` until the first `--apply`; candidates only), the failure wording, the Atlanta-valued suggestion case, the cost line. | c7fa093a 4ede5b03 ae10bd9e |
| Rehearsal | RE-RUN on hermetic lane 4 with the new behavior; every step as expected, including a lead skipped on the first apply staying out on a second run WITHOUT `--skip`, and the pending-suggestion lead left out. Verbatim: `backfill-rehearsal-2.md` (supersedes plan Task 6.3a's expected text). Live D12 check on the same lane. | 83766228 |

Reason precedence (decision 2): named in --skip on this run > excluded on an earlier run >
signed up again > authority history > pending suggestion. Every reason leaves the lead out;
precedence picks the one printed.

## 2. Review (fresh eyes on every fix diff)

- `fw1-review.md` (fresh opus, fix diff 09acd16b..e16d408b): 0 HIGH, 3 MEDIUM, 4 LOW, 5 INFO;
  31/31 backfill and 16/17 dashboard mutants killed. Adjudications: `fw1-review-adjudications.md`.
  F1 (= the orchestrator's own O-2) and F4, F5, F7 fixed in micro wave FW-1b; F3 (the
  rehearsal) done by the orchestrator; F2 RUNBOOK wording now, option (a) for Cameron; F6
  accepted and noted.
- `fw1b-review.md` (fresh opus, FW-1b diff, terminal): 0 MEDIUM+, 1 LOW, 6 INFO; F1/F4/F5/F7
  closed; 10/12 mutants killed (the 2 survivors are log-count / duplicate-check paths that
  change no outcome). Nothing reopens. Noted, not fixed (LOW): RUNBOOK step 4 says the
  `--skip` value is no longer needed after an apply - not true for a lead whose exclusion
  append failed; the step-3 FAILED line already says to keep it in `--skip`.

## 3. For Cameron

- OPEN QUESTION (fw1 review F2): a PENDING suggestion whose value IS "Atlanta Housing
  Authority" - if staff DISMISS it (saying "not Atlanta"), the next run writes Atlanta
  anyway, because dismissal tombstones are not read. Built as ruled; the RUNBOOK now tells
  the operator to set the real authority or name the lead in `--skip`. Option (a): also
  leave out a lead holding a dismissal of Atlanta Housing Authority (one more GetItem per
  would-be target). Your call; not built.
- ACCEPTED EDGE (F6): an accept in flight, or one whose process died after claiming the
  suggestion, is invisible to the pending read for that window; the backfill can then write
  Atlanta and the accept is refused as superseded. Needs an accept in flight or crashed
  during the run.
- Decision 6 (superset): the D12 line also shows on the record forms' "Add as new" (the same
  dialog), because adding a housing authority there publishes it just the same.
- Gate 4 went red three times on the known blank-document failure before a clean fourth
  run, and the traces now show its mechanism - a dev-server module fetch lost to Windows
  WSAENOBUFS under sustained, concurrent suite load: section 4 and the issue. Worth its own
  look (it costs every Windows gate run), not part of this branch.

## Files and delta (vs 09acd16b, records excluded)

14 files, +1264 / -141: `app/scripts/backfill-join-housing-authority.ts`,
`app/test/backfillJoinHousingAuthority.test.ts`, `RUNBOOK.md`,
`dashboard/src/routes/orgs/` (orgCopy.ts, NewOrgDialog.tsx + test),
`dashboard/src/routes/settings/` (OrgEntryDialogs.tsx, NotOnListSection.tsx + test,
OrgListSection.test.tsx), `e2e/tests/dashboard-next/org-lists.spec.ts`, and docs/issues (one
deleted, one resolved, one appended). Code commits: 738964fc 2d65fa58 d87ac6b7 37d02e42
16a0f963 d9cdba7b d98f6e9f 0572828a 99b14981; docs: c7fa093a 9bb30403 4ede5b03 ae10bd9e and
the issue notes; records: 5f9fb91c 556675eb e16d408b 51970b91 1c4252b2 83766228 0f589643.

## 4. Gates

Bare, from the worktree, real exit codes; logs and markers under `.superpowers/sdd/gates/`
(`fwf-*` and `fw1-e2e-run4.*`). `git rev-list --count HEAD..main` = 0 (main @5c0d3f6a), so
no sync merge.

FINAL - all five on 0eb44652 (no commit between them):

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 32s |
| 2 | `npm test` (no AWS_* exported) | 0 | 130s; app `Test Files 440 passed (440)` / `Tests 9284 passed \| 1 skipped (9285)` (the pre-existing staticSmoke diagnostic); dashboard 239 / 4447; e2e workspace 22 / 503; fake-twilio 34 / 275; fake-twilio-web 13 / 111; no `[dynamoAdmin]` line |
| 3 | `npm run smoke` | 0 | `smoke-dist: OK - 1655 import specifier(s) across 287 emitted file(s) resolve under plain Node.` |
| 4 | `E2E_TRACE=1 timeout 2700 npm run e2e` | 0 | `340 passed (28.3m)` |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 0 | 32 files (the 7 dashboard files of FW-4 included), 0 errors, 0 warnings |

Every run of gate 4 in this wave, all reported:

| Run | Commit | Exit | Result | Lost test (passed alone right after) |
|---|---|---|---|---|
| 1 | 83766228 | 1 | 339 passed / 1 failed, 29.3m | landlord-onboarding.spec.ts:230 - 7/7 alone |
| 2 | 0f589643 | 1 | 338 / 2, 30.6m | pool-numbers-admin.spec.ts:132, sending-unit.spec.ts:102 - 4/4 alone |
| 3 | 7b0bc487 | 1 | 339 / 1, 34.1m | contact-create-relay-group.spec.ts:365 - 3/3 alone |
| 4 | 0eb44652 | 0 | 340 passed, 28.3m | - |

Commits 83766228..0eb44652 are records and issue notes only - the code under test was the same
in all four runs. Every lost test failed the same way, and for the first time the gate kept
TRACES (gate 4 runs with `E2E_TRACE=1`): one module request of the dev-mode page
(`/src/api/index.ts`, `/node_modules/.vite/deps/react-router-dom.js`,
`/src/app/EnvironmentIdentity.tsx`, `/@react-refresh`) failed with status -1, the console logged
`net::ERR_NO_BUFFER_SPACE` (Windows WSAENOBUFS), the module graph never evaluated, and the page
stayed blank - the open issue `e2e-blank-document-after-contact-navigation`, now with four
traced sightings appended (fourth to seventh). Runs 1-3 overlapped other worktrees' suites on
lanes 6 and 14 and left 2-3.6 thousand sockets in TIME_WAIT; run 4 started on a quiet host
(TIME_WAIT 279) and was clean. Not this branch: no production code is implicated, every
feature and fix-wave spec (org-lists 16/16, the /join test, the self-serve scenario) passed in
all four runs, and every lost test passed alone.
