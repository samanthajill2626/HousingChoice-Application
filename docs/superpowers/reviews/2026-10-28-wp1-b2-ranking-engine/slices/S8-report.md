# S8 slice report - The merge-gate scripts and the docs (WP1 B2a)

- Slice: plan section 12, S8 - the head (Scope, C1-C13, Cross-slice notes;
  plan 35514-35715) and tasks S8.1-S8.11 with the S8 coverage table (plan
  35716-39630). Spec D17 (the commands), D19, spec 5 docs, spec 7 rollout.
  Watch items WI7, WI12, WI13. WORKLIST section G and WL-S8-1..WL-S8-16.
- Two children. S8a built S8.1-S8.5 (the counterfactual check, `--timing`,
  the stub-driver tests): its report is
  [`S8a-report.md`](S8a-report.md) and stands as written (tasks, RED/GREEN
  evidence, C1-C13 as built, WL-S8-10/11/12). S8b (this report's author,
  Claude Opus 5.5, 2026-10-29) built S8.6-S8.11: the env examples and their
  layout test, the gate sheet, RUNBOOK, GLOSSARY, the issue registry and the
  close. This file covers the whole slice.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
- Verdict: every S8 task done, one commit each. S8.6 RED for its stated
  reason, then GREEN; S8.7-S8.10 docs-only. No behavior, ruling or spec
  decision changed; no one-value test fix; no QUESTION. Close evidence:
  typecheck exit 0; the five slice test files 92 / 92; eslint on the twelve
  slice files exit 0; ASCII 0 everywhere; the dry run and its timing twin
  exit 0 with no call; WI7 / WI12 / WI13 hold.

## 1. Tasks and commits

| Task | Commit | Files |
|---|---|---|
| S8.1 records and the nine swaps | a561977f | S8a |
| S8.2 tolerance, noise, cap and control rules | a8477ebb | S8a |
| S8.3 card adapter and call plan | 549f0384 | S8a |
| S8.4 verdict, record, CLI | 82e491cf | S8a |
| S8.5 `--timing` (+ dry-run pin e4d99015) | ba30dcdb | S8a |
| S8a report | 4023335d | `slices/S8a-report.md` |
| S8.6 env examples + layout test | e5022b08 | `.env.example`, `.env.dev.example`, `.env.prod.example`, `app/test/rankingEnvExamples.test.ts` (new) |
| S8.7 gate sheet (docs-only) | 94969d57 | `gate-run-commands.md` (new) |
| S8.8 RUNBOOK (docs-only) | a09830cf | `RUNBOOK.md` |
| S8.9 GLOSSARY (docs-only) | 719a1b0a | `documentation/GLOSSARY.md` |
| S8.10 issue registry (docs-only) | ee67ee89 | five issue edits + `docs/issues/perf-pages-settings-rankings-surface.md` (new, WL-S8-14) |
| S8.11 close + this report | this commit | `slices/S8-report.md` |

File ownership: every S8b file is PR2's S8 list (`.env*.example`,
`gate-run-commands.md`, RUNBOOK, GLOSSARY, `docs/issues/`) or the test the
S8.6 task names. `git diff --stat 4023335d..HEAD` lists exactly those 13
files. No app, dashboard, e2e or script source changed in S8b.

## 2. Test commands and counts (S8b, every run, in order)

App form: `cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run test/<file>`,
foreground, hard timeout. No `npm ci`, `npm install` or `npm run db:start`
(G1). Nothing left running (G7).

1. S8.6 RED `test/rankingEnvExamples.test.ts`: 6 failed / 5 passed (11).
   Failing, each "expected undefined to be ..." (no file holds a ranking
   key yet; the comment regex finds nothing): the three files' "sets every
   mode-independent D19 variable" and "sets the mode-dependent keys" cases.
   Passing at RED: the three "never sets a ranking variable to a blank
   value" cases (nothing to check yet - D8-3 predicted it; G4, test
   unchanged) and the two loadConfig cases (PINs, as the plan says).
2. S8.6 GREEN: 11 passed (11). eslint on the test: exit 0.
3. A read-only parse of the three examples through the real
   `scripts/lib/secretsCore.mjs` `parseDotenv` (a scratch script outside the
   worktree; no real `.env` touched): ranking keys `.env.example` 19,
   `.env.dev.example` 20 (+ `RANKING_DRIVER`), `.env.prod.example` 21
   (+ `RANKING_WORKER_POLL`); `AI_PRICE_TABLE` kept verbatim in all three;
   dev's `RANKING_WORKER_POLL` and both of `.env.example`'s mode keys
   absent (comments). Matches D8's sync simulation (20 / 21 new keys).
4. `npm run issues` (S8.10): exit 0, "452 open, 217 closed, 669 total";
   the new issue lists open, the two closed ones resolved. INDEX.md stays
   gitignored (`.gitignore:62`), not committed.
5. S8.11 step 1 `npm run typecheck` (bare, root): exit 0, 0 `error TS`
   (app src + scripts + test configs, dashboard, e2e, fake-twilio,
   fake-twilio-web).
6. S8.11 step 2, the five files: 5 files, 92 passed (rankingEnvExamples 11,
   rankingCounterfactualData 17, rankingCounterfactualEvaluate 14,
   rankingCounterfactualPlan 14, rankingCounterfactual 36).
7. S8.11 step 3, the dry run (section 6): exit 0. The timing twin: exit 0.
   `git status` clean afterwards (a dry run writes nothing).
8. S8.11 step 4, eslint on the plan's twelve files: exit 0.
9. S8.11 step 5, ASCII: every one of the twelve code/test files, the gate
   sheet and the new issue print 0; the edited files' added lines over
   `main...HEAD` (RUNBOOK, GLOSSARY, the three examples, docs/issues) print
   0; S8b's commit messages print 0.

Only `rankingEnvExamples.test.ts` reads any file S8b edited (a grep of
every test that calls `readFileSync` / `readFile` for RUNBOOK, GLOSSARY,
docs/issues or the env examples), so the five-file run covers the slice.

## 3. Watch items

- WI7 (no test or agent-run script reaches the network or reads
  `ANTHROPIC_API_KEY`) - HOLDS.
  - `git grep -n "process\.env" -- 'app/test/rankingCounterfactual*.test.ts' app/test/rankingEnvExamples.test.ts`:
    no hit (exit 1). The env test passes literal env objects to
    `loadConfig` (its one key is the string `sk-test-not-a-real-key`).
  - `git grep -n "createRankingDriver\|new Anthropic\|@anthropic-ai/sdk"`
    over the same files: no hit. Every CLI test injects `createDriver`
    (the harness, `rankingCounterfactual.test.ts:135`, and the per-case
    overrides :193, :386, :437, :513); the default at
    `ranking-counterfactual-check.ts:200` is never reached by a test.
  - No agent ran either script without `--dry-run` (S8a: two dry runs;
    S8b: the two below). No `printenv`; no `ANTHROPIC_*` value read,
    echoed or logged (G6, WL-S8-1).
- WI12 (one card definition) - HOLDS. `git grep -n "tenantCard(\|propertyCard(" -- app/scripts`
  lists only `app/scripts/rankingCounterfactual/cards.ts:65`
  (`tenantCard(contact, ctx)`) and `:72` (`propertyCard(unit, ctx)`). The
  plan's name form also hits comments only (`ranking-counterfactual-check.ts:7`,
  `cards.ts:2`, `:10`, `:30`) and the import (`cards.ts:20`) - D8-2. Cases:
  `rankingCounterfactualPlan.test.ts:72` "every batch is the production
  prompt: system text, fingerprint, landlord switch off (PR7)" and `:80`
  "every tenant card is the production tenantCard (WI12)".
- WI13 (one cap function) - HOLDS. `git grep -n "capOf(" -- app/scripts`
  lists only `app/scripts/rankingCounterfactual/evaluate.ts:75`
  (`return capOf({`, in `runCapped`). The name form also hits comments and
  a record string (`ranking-counterfactual-check.ts:8`, `evaluate.ts:14`,
  `records.ts:325`, `report.ts:246`) and the import (`evaluate.ts:18`).
  Cases: the S8.2 describe "a run's cap comes from that run's own output
  (production capOf)" (`rankingCounterfactualEvaluate.test.ts:102-120`,
  four cases) and S8.4's "the cap comes from the run's own output: a
  no-kids failure with its own unlawful flag is not capped"
  (`rankingCounterfactual.test.ts:282`).

## 4. WORKLIST items

- G1: complied. G2: the two plan blocks holding backslashes were copied
  byte-exact with `sed -n` (the S8.6 test, plan 38526-38643, 118 lines,
  its `\r?\n` intact; the gate sheet, plan 38858-38965, its two
  `W:\tmp\...` lines intact), then edited only on lines without one. G3:
  nothing S8b wrote says `failedBatches` is calls only, that an unwritten
  match throws, that the fingerprint is the system text only, or that
  unlawful flags group by item (the gate sheet's Pets bullet now cites
  PR29 / PR40 "for an accommodation flag"). G4: section 2 item 1. G6 /
  G7: complied.
- WL-S8-1: DONE. The dry run was exactly
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL npx tsx app/scripts/ranking-counterfactual-check.ts --model claude-sonnet-5-5 --dry-run`
  from the worktree root, and the same prefix for `--timing --dry-run`.
- WL-S8-2: DONE (section 3, call form).
- WL-S8-3: DONE. `git grep -lw "notes_stale" -- app/test` ->
  `app/test/contactNotesGuard.test.ts` only;
  `git grep -lw -e "notes_stale" -e "since you opened this form" -- e2e/tests dashboard/src`
  -> `dashboard/src/api/types.ts`, `ContactEditForm.tsx`,
  `ContactEditForm.test.tsx`, `e2e/tests/dashboard-next/contact-notes-conflict.spec.ts`
  (the closed issue cites the three tests, not the two sources);
  `git grep -l "toOneLine" -- app/test` -> singleLine, extractionNoteLines,
  extractionSchema (cited) and propertyLabel (a comment only, not cited).
- WL-S8-4: DONE. The resolution quotes `NOTES_STALE_COPY` as built
  (`dashboard/src/routes/contact/ContactEditForm.tsx:137-138`): "Nothing
  was saved. These notes were changed since you opened this form. The
  current notes are below, and your text is still in the box. Save again to
  replace them, or Cancel to keep them." - shown above the Notes box, the
  current notes below the copy.
- WL-S8-5: DONE. `.env.dev.example:209-212` and `.env.prod.example:234-237`
  carry D8 reference D8-6's text verbatim; `RUNBOOK.md:1488` (the
  ANTHROPIC_API_KEY row) likewise.
- WL-S8-6: DONE. `RUNBOOK.md:1349-1353` names seven shared-cadence polls
  (the journal sweep and the ranking poll added, matching config.ts:408-417
  and worker.ts:290 "seven shared-cadence call sites") and that a Rank
  press waits for the next tick; `:1365-1369` rewords the idle-cost sentence
  so it stays true for the ranking poll (two Queries on `byEntity`,
  rankingRunsRepo.ts:61-63, job.ts:583, :617) and the journal sweep (one
  refused claim, journalSweep.ts:142). The env examples' comments
  (`.env.dev.example:273-284`, `.env.prod.example:294-305`) say the same.
- WL-S8-7: DONE. The RUNBOOK checklist (`RUNBOOK.md:1905`) and the gate
  sheet's deploy note name the new keys: the `RANKING_*` lines,
  `AI_RANKING_MODEL`, `AI_PRICE_TABLE` and `RATE_LIMIT_RANK_PER_MIN`.
- WL-S8-8: DONE. The gate sheet's "Before you start" says only the
  counterfactual check prints the endpoint line (the compile check prints
  none, `extraction-schema-compile-check.ts:93`; its SDK still honors
  `ANTHROPIC_BASE_URL`), so it is read on the dry run.
- WL-S8-9: DONE. GLOSSARY: the requirements entry (`:289-294`) no longer
  says "Nothing ... ranks on them yet" - since B2a the ranking reads them
  on the property card, a failed Evictions, Qualifications or Pets
  requirement caps (cap.ts:25-31), credit and income never reach a card
  (cardFields.ts:296-297, :320); Pool (`:881`) "Not a relay pool number";
  Match (`:901`) "Not Matching, the staff section that sends properties";
  Staff notes (`:165-180`) "nothing machine-writes it ... One machine
  READS it: the ranking's tenant card" (D15; contactsRepo.ts:170-180,
  cardFields.ts:133) and the Notes box's `notes_updated_at` (D14.3).
- WL-S8-10 / WL-S8-11 / WL-S8-12: code is S8a's (S8a report section 4).
  S8b's gate sheet uses the same wording: the record holds every run's
  score and each group's cap COUNT, a swap row has no per-run cap and no
  flags (WL-S8-11); the `--out` pre-check (exit 2, nothing spent, file
  created empty) and the unsaved-record fallback (verdict and record on
  stdout, exit 1 even on PASS) (WL-S8-12). WL-S8-10's other half (the S8
  scope bullet's "uncommented" wording) is plan text, not a file; the
  files follow PR39.
- WL-S8-13: DONE. The `units-contacts-batchget-walk-duplicated` update
  names the third copy (`unitsRepo.getManyByIds`, marked at
  unitsRepo.ts:1353), `matchesRepo.getPairs` (a composite key,
  consistent, complete-only; matchesRepo.ts:219-245) and the run listing's
  `batchGetRuns` (rankingRunsRepo.ts:709, a report-unread mode copied
  from aiRunsRepo.ts:202-232); neither of the last two carries the TODO
  marker (S2 report section "For S8").
- WL-S8-14: DONE. `docs/issues/perf-pages-settings-rankings-surface.md`,
  modeled on `perf-pages-settings-organizations-surface.md`, refs the pins
  (`e2e/performance/routes.test.ts:385`, `:411`), the TODO
  (`e2e/performance/routes.ts:693`) and the route (`dashboard/src/App.tsx:234`),
  and lists the four mount GETs S7b named: the runs list, the cost read
  (12 ISO weeks, up to 50 pages; adminRankings.ts:68, :109), every unit
  (`GET /api/units`) and every tenant (`GET /api/contacts?type=tenant`)
  (useRankCandidates.ts:22-25), plus the `rank=` / `run=` reads and the 5 s
  job poll (useAnchorRanking.ts:28). The suggested fix models the row on
  the admin-only `/settings/ai-runs` row (routes.ts:677).
- WL-S8-15: DONE. `RUNBOOK.md:1918-1924` "A deploy (or any worker restart)
  mid-ranking": shutdown stops only the SQS consumers, the one takeover
  re-runs the job from the start and is spent (a second lapse fails it
  "stopped before it finished", job.ts:620-625), up to 2 x 4 = 8 in-flight
  calls are billed and never logged; the extraction poll has the same shape
  (S5 report WL-S5-8).
- WL-S8-16: DONE. "Local" is a LOOPBACK `DYNAMODB_ENDPOINT` (localhost,
  127.0.0.1, [::1]; config.ts:672-681) in the RUNBOOK caveat
  (`RUNBOOK.md:103-116`, which also says the launcher counts any set
  endpoint as local, so a non-loopback local endpoint fails safe), the
  ranking section's refusal paragraph and env table, and the `.env.example`
  comment (`.env.example:228-241`).

## 5. C1-C13 as built (S8a built the code; recorded here per S8.11)

- C1, the card adapter: `app/scripts/rankingCounterfactual/cards.ts` is the
  only script file that reaches S3's code. It calls `tenantCard(contact,
  ctx)` and `tenantMissing(contact)` (`prepareTenant`, :63-66) with
  `TenantCardCtx` `{ now: new Date(COUNTERFACTUAL_NOW), seenMax: 8, seen:
  [] }` (:59-61), and `propertyCard(unit, ctx)`, `propertyMissing(unit,
  ctx)`, `propertyFacts(unit, ctx)` (`prepareProperty`, :68-76) with
  `PropertyCardCtx` `{ orgEntries: counterfactualOrgEntries(),
  landlordCard: false, landlord: null }` (:55-57); the org entries are
  `buildStartingEntries(COUNTERFACTUAL_NOW, cf-org-N ids)` (:44-50).
- C2-C12: as S8a recorded (S8a report section 5): controls in both
  directions (PR25); one subject at `c1` plus the same two fillers; nine
  swaps; address swaps keep city and zip; any ungraded call fails, no
  stage two for that pair and direction, no retry; stage one compares with
  group A's first three runs; exit 0 PASS / dry run, 1 FAIL or DECIDE or a
  failed append, 2 usage / no key / unwritable `--out`; the estimate at 4
  characters a token and 2,500 output tokens on the built-in table;
  `--concurrency` default 4; `COUNTERFACTUAL_REQUEST` pinned to
  `loadConfig`'s development values; `--out` required except with
  `--dry-run`, each run appending a dated section.
- C13: PR29 / PR41 / PR45 cases green (S8a); PR30 / PR35 / PR39 / R2F7 /
  R2B8 / R3B2 / FB11 / FB23 applied in S8.6-S8.10 (sections 4, 7).

## 6. The dry run (S8.11 step 3)

Command: section 4 WL-S8-1. Exit 0. Printed:

```
ranking-counterfactual-check - model claude-sonnet-5-5; key (not read); endpoint default; ANTHROPIC_AUTH_TOKEN set: no
Rubric r1, examples e1, prompt fingerprint 33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9 (28926 system characters)
Suite: 6 base pairs x 2 directions, 9 swaps (name, address, children, marital_status, credit_income, religion, disability, sogi, authority), 3 controls
Planned calls, stage one: 414 (estimated $16.80 on claude-sonnet-5-5)
Stage two, only for misses: at most 660 more calls (estimated at most $26.78)
Dry run: no call made.
```

Timing twin (`--timing --dry-run`), exit 0:

```
ranking-counterfactual-check --timing - model claude-sonnet-5-5; key (not read); endpoint default; ANTHROPIC_AUTH_TOKEN set: no
Planned calls, timing: 3 batches of 40 candidates (estimated $0.15 on claude-sonnet-5-5)
Dry run: no call made.
```

The fingerprint equals the S4 report's landlord-off
`rankingPromptFingerprint` (S4-report.md section 5). The estimates equal
S8a's runs.

## 7. RUNBOOK copy cross-checks (S8.8) and what differed

The plan's four greps, run before the commit:
- Job and read messages
  (`git grep -n "Pool too large to rank\|was not picked up\|stopped before it finished\|could not be read and were not scored\|could not be scored\|could not be saved\|could not finish\|Could not read this\|not scored by the model" -- app/src`):
  `job.ts:41-43` (MSG_NOT_PICKED_UP, MSG_STOPPED, MSG_ERROR), `:49-67`
  (the four count builders), `:273`, `:275` (PR38 / PR43), `pool.ts:225`
  (pool too large). Every quoted string in the plan's text matches.
- "Include tenants not heard from": `RankAnchorPanel.tsx:153`
  "Include tenants not heard from in {ranking.poolWindowDays} days" (PR26).
- PR30 defaults: `config.ts:672` `isLocalDynamoTarget` (loopback only),
  `:792-798` (driver default), `:845-847` (poll default).
- e2e-session env: `scripts/e2e-session.mjs:271-272` (`RANKING_DRIVER:
  'fake'`, `RANKING_WORKER_POLL: 'off'`), `:198`
  (`RATE_LIMIT_RANK_PER_MIN` 100000, WL-S5-6).
After writing, every double-quoted message and log line in the new
section was grepped verbatim in `app/src` / `dashboard/src` (24 strings,
each found).

Where the built tree differed from the plan's text (the code won):
1. The caveat's operator-script list "(import-apply, the backfills,
   retirePoolNumbers, rail-verify, import-convert-groups)": of the
   backfills only `backfill-media-content-types.ts` calls `loadConfig`
   (a grep of `app/scripts`); the caveat names the five scripts that do.
   Its "from a `--local` session" is dropped: `scripts/dev.mjs` sets no
   `RANKING_*` variable and never exports into the user's shell.
2. The "Reading a ranking that went wrong" list lacked cases the code has;
   added, each quoted from code: "Waiting for a free slot"
   (rankingFormat.ts:115) and the boot line `ranking poll not started -
   RANKING_WORKER_POLL is off` (worker.ts:537); the 409 "A ranking is
   running for this record. Try again when it finishes." (job.ts:40, route
   rankings.ts:135); the run-write log line `ranking run write failed -
   usage and cost logged here` (runBatch.ts:247); the pool failures "The
   organization list could not be read, ..." and "This record was not
   found." (pool.ts:223-224, finished as the job message at job.ts:384);
   the read's 503 messages "The ranking could not be read. Try again."
   (readRanking.ts:53) and "This record could not be read in full. Try
   again." (assemble.ts:222), and the row label "could not check whether
   this match is current" (rankingFormat.ts:41).
3. The intro said "an admin pressing Rank": the tab is admin only but the
   rank API also accepts a VA (rankings.ts:1-3, api.ts:907); both said.
4. The checks paragraph's "About 400 small calls, about 10-20 dollars" is
   now the dry run's 414 and $16.80 (and up to 660 more), with exit codes.
5. "delete the line to use the built-in default": `secrets:push` and
   `secrets:check` then print a key-set WARNING only (secrets.mjs:137-155);
   said.

## 8. Deviations from the plan text (S8b; each with its reason)

1. S8.6 `.env.example` comment (`:228-241`), comment only: "On DynamoDB
   Local (a DYNAMODB_ENDPOINT on localhost, 127.0.0.1 or [::1]: `npm run dev
   -- --local`)" instead of "With DynamoDB Local (`--local`, the hermetic
   lanes)" (WL-S8-16; the hermetic lanes do not take the console / on
   defaults - e2e-session sets fake / off); "the hermetic lanes, which set
   both"; one 91-column line rewrapped. Values and the two `# KEY=` lines
   are the plan's.
2. S8.6 also carries the env halves of WL-S8-5 and WL-S8-6 (section 4) -
   D8-6 assigns them to S8.6; the commit body says so.
3. S8.6 RED: 6 failed / 5 passed where the plan says "the per-file cases
   fail" (section 2 item 1; D8-3).
4. S8.7: `<commit>` and `<fingerprint>` are left as placeholders (the
   dispatch: S9.1 fills them after the main sync), not filled at writing
   time as the plan's Step 3 says. Edits: WL-S8-8, WL-S8-11, WL-S8-12,
   WL-S8-7 (section 4); the cost table and item 1 carry the dry run's
   numbers (414, $16.80; 660, $26.78; timing $0.15, under $0.60 at the
   16,000-token ceiling per S8a section 8) instead of "about $10-20" and
   "under $1"; "Before you start" adds how to clear the two variables;
   item 3 adds exit 2; item 4 adds the timing exit codes; the controls
   item adds "graded in all three runs" (report.ts:4-6); a Choices bullet
   for WL-S8-12; the Pets bullet cites PR40 (G3).
5. S8.8: the additions in section 7 items 1-5, plus WL-S8-7 / WL-S8-15 /
   WL-S8-16 / WL-S8-5 / WL-S8-6 (section 4); "Hermetic lanes and local
   dev" adds `RATE_LIMIT_RANK_PER_MIN=100000` and the tick's loopback-only
   mount (dev.ts:808-813), and says the live laptop "resolves anthropic
   ... makes no ranking call" (worker.ts:527-538: no driver is built with
   the poll off) instead of "uses anthropic on `.env.dev`'s key".
6. S8.9: beyond WL-S8-9, the anchor notes are quoted as the page shows
   them (rankingFormat.ts:56-58); Card adds the charter's "not a screen
   element" (charter section 3); Properties seen names `RANKING_SEEN_MAX`
   and tells it from B1's "properties sent"; Match says "(the charter's
   match percentage)" instead of "(shown as a percentage)" - the B2a page
   shows the bare number (RankingTable.tsx:31); Band names the cap-eligible
   items (cap.ts:25-31); Matches store adds the charter's "never 'the
   matches table' near UI text"; Ranking job names `RANKING_BATCH_SIZE` and
   when a second press is refused (job.ts:211-223).
7. S8.10: citations as section 4 WL-S8-3; 3b quotes the built copy and
   says "above the Notes box" (WL-S8-4); 3c names `seenFeedback.ts`; 3d adds
   WL-S8-13 and that `getDisplaysByIds` has had `requireComplete` since B1
   (unitsRepo.ts:679-688; the issue body's "that the units walk lacks" is
   stale); 3e cites `upsertContact` and adds one sentence (the ranking card
   reads the box). Plus WL-S8-14's new file.
8. Mechanism: the MERGE_HEAD check used the brief's
   `test -e "$(git rev-parse --git-path MERGE_HEAD)"` form (printed `ok`
   before every commit); each commit body carries one line naming its
   WORKLIST items.

## 9. QUESTIONS

None.

## 10. For S9 (the orchestrator) and the handback

- S9.1 fills `gate-run-commands.md`'s `<commit>` (line 10) and
  `<fingerprint>` (line 12) after the main sync. At this report's commit
  the dry run prints fingerprint
  `33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9`; take
  the value from the dry run AFTER the sync (WL-S8-1's command), and check
  the sheet's dry-run lines (item 1: 414 / $16.80, 660 / $26.78) and cost
  table still match what it prints.
- PR39 is listed for Cameron (departs from his "every var uncommented with
  its default" rule): `.env.example` leaves `RANKING_DRIVER` and
  `RANKING_WORKER_POLL` as comments, `.env.dev.example` leaves
  `RANKING_WORKER_POLL` as a comment; `.env.prod.example` sets both. Pinned
  by `rankingEnvExamples.test.ts`.
- Deploy facts for the handback (RUNBOOK `:1905-1924`): after
  `secrets:sync` dev gains 20 and prod 21 keys, every one EMPTY; give each
  its example value or delete the line before `secrets:push`; a deploy
  mid-ranking spends that job's one takeover and up to 8 in-flight calls
  are billed but not logged.
- Observation, not acted on (S2's `config.ts`, outside S8): `npm run
  db:seed` writes to DynamoDB Local by its own default
  (`db-seed.ts:25`) but calls `loadConfig()` on `process.env`
  (`db-seed.ts:29`); with no `DYNAMODB_ENDPOINT` exported the ranking
  defaults read "real tables" (config.ts:792, :910). Harmless unless the
  shell carries `RANKING_DRIVER=fake|console`, in which case db:seed
  refuses to start - it fails safe. Read from code, not run.
- Pre-existing RUNBOOK drift left alone (outside the WORKLIST): "Worker
  clock polls" still says "60-second `setInterval` polls" and "AI
  extraction" says "a third 60-second `setInterval`" (both run on the
  shared 30 s cadence through `startPoll`).
- Untrimmed input: none new (S8b added no input path).
