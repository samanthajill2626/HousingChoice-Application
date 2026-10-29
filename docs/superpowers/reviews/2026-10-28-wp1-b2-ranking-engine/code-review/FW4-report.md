# B2a code review round 4 - fix wave FW4 report

- Implementer: FW4 child (Claude Opus 5.5), 2026-10-29.
- Branch feat/wp1-b2-ranking-engine, worktree W:/tmp/wp1-b2-ranking-engine.
  Start: fc587096 (the R4 records commit). End: this report's commit, on top
  of 04d81a9c.
- Scope: the FIX rows FW4-1 and FW4-2 and the FILE row of
  `R4-adjudications.md`. Files touched: the hook
  (`dashboard/src/routes/settings/rankings/useAnchorRanking.ts`), its test
  file (`useAnchorRanking.test.tsx`), `docs/issues/rankings-page-hook-edges.md`,
  this report.
- Method: FW4-1 test first - P1 and P1b written into the hook test file and
  run RED on the hook at fc587096 for the finding's reason, then the one-line
  change, then GREEN. Two mutants were applied TEMPORARILY in place (the fixed
  hook copied first to the session scratch dir `.../scratchpad/fw4/`, one
  `sed` substitution, `diff` showing exactly that line, the tests run, the
  copy put back and `cmp` confirming it); no mutant was committed. The
  reviewer's scratch hook copies and logs under `.../scratchpad/r4/` were read
  as reference only; nothing was copied from them into the worktree.
- Before any edit: no `e2e/.artifacts/session.pid`, and no node process
  running from this worktree other than the mission's transcript mirror. No
  e2e run (the orchestrator's next step).

## Rows

### FW4-1 - R4-dashboard-1 - a press's job goes through the order rules - commit 7fb7b723

The change, `useAnchorRanking.ts:400` (in `rank`):

- was: `const change = cur.jobView?.generation !== res.job.generation ? applyJob(cur, res.job, issue()) : null;`
- now: `const change = applyJob(cur, res.job, issue());`

The press's job takes the newest issue number as its answer lands, so
`applyJob`'s rules alone decide: of another generation (or with none shown) it
is applied as before; of the generation on screen it is applied unless it is
behind the view on screen (FW2-5's order). A fresh press's claim record
(queued) therefore still never steps back a newer view of its generation - the
gate's purpose - and a join's view ahead of the one on screen (running over
`expired`) is applied at once, which makes the job on screen live and starts
the poll again.

Tests (new block "useAnchorRanking - ordering, round 4", test file :848):

| Test (line) | On fc587096 (RED) | Gate restored on the fixed hook | Order-rule mutant |
|---|---|---|---|
| :853 P1 - a press that joins the generation on screen while it reads expired is applied: with no event the poll resumes and follows the job to its end | RED at :878, `expected { status: 'expired', ...(7) } to match object { status: 'running', ...(2) }` - the gate dropped the join's running 1 of 2 | RED, same message | green |
| :893 P1b - the same join, then the next ranking.updated event: the press already shows the job running, and the event read and the poll go on from it | RED at :916, same message - the line is wrong until the event's read | RED, same message | green |
| :939 guard - a fresh press whose claim record answers after a running view of its generation leaves the running view on screen (A2-2) | green (by the gate) | green | RED, `expected { status: 'queued', ...(7) } to match object { status: 'running', ...(2) }` |

- Gate restored (mutant mN: :400 back to the fc587096 line): hook file 2
  failed / 36 passed (38) - exactly P1 and P1b.
- Order-rule mutant (mO: `applyJob`'s `if (order < 0 || (order === 0 &&
  issued <= cur.jobIssued))` -> `if (order === 0 && issued <= cur.jobIssued)`,
  :226): 4 failed / 34 passed - the guard plus the three tests that already
  pin FW2-5's order (round 2 "within one generation a job view behind ...",
  round 2 "a stalled job read that answers after its successor ...", round 3
  FW3-4 "... pool is not built ..."). So the guard rests on the rule that
  replaced the gate.
- P1 keeps R4's asserted points (status `running` right after the join, the
  next JOB_POLL_MS reads the job, `getRanking` once more for the join's
  finished batch) and extends to the job's end: the poll's `done` view reads
  the ranking once more, clears the joined mark (the page followed the job),
  and the poll stops. P1b differs from R4's probe P1b on purpose: R4's
  asserted only the recovery after the event (green at fc587096); this one
  asserts the press's view at once (RED at fc587096 for the finding's reason),
  then that the event's level, later-issued view and the poll carry on from
  it with no extra full read until a batch finishes.

### FW4-2 - R4-dashboard-4 - comments made exact - commit 7fb7b723

Each sentence below was checked against the code at 7fb7b723.

- Header :14-17: a press takes an issue number when its job lands (the "only
  if its job is offered" clause is gone with the gate).
- Header :23-30: the job-view bullet names the press as a source of views of
  the generation on screen, ordered like the others.
- Header :31-34 (was :31-35): the press bullet shrinks to the rule: the newest
  number, applied unless of the generation on screen and behind it; once
  applied, a view of another generation (or of none) from a read issued
  before its answer is dropped. No "never applied, whatever its progress".
- Header :35 and `applyJob` :230-234 (R4 cited :36, :229): "a generation the
  page has not shown" -> "a generation other than the one on screen (or with
  none on screen)" - the code tests `next !== null && !sameGeneration`.
- `loadRead` :262-267 (was :259-261): its job is applied when it is a view of
  the generation on screen ahead of the view on screen, whatever its number;
  never when behind it; any other view (level, another generation, or none)
  only if no view applied so far came from a press answered, or a read sent,
  after this read - i.e. `issued > cur.jobIssued`. Replaces "never over a
  press or a job read issued after this read", which P4 showed false for a
  same-generation view ahead.
- Press comment :389-399 (was :383-395, R4 cited :388): rewritten for the new
  line - the order rules decide; a fresh claim record never steps back a newer
  view; a join's view ahead (running over queued or over expired) shows at
  once, and over expired, where nothing polls, applying it starts the poll
  again; once applied, earlier reads' views of another generation (or of
  none) are dropped; applied, it reads the ranking again when its finished
  batches grew or it ended. No join caveat.
- `jobProgress` docblock :133-140 - R4-dashboard-4's OPTIONAL third bullet,
  taken: "in this order it is level with queued, not an end" now adds "It is
  still not live: applied, it ends a follow as done or failed would, and
  nothing polls while it is on screen". Checked: `ended`, `followedEnded`,
  `wasLive` and the poll effect all key on `isJobLive`, which is false for
  expired, done and failed alike.
- Test file :507-511 (the round 2 describe comment): the same FW2-era phrase
  "a generation the page has not shown" -> "a generation other than the one
  on screen" (not cited by R4; same finding, same wording). The round 2 TEST
  NAME at :531 ("a generation the page never showed") is left: in that test
  the generation really was never shown.

### FILE row - rankings-page-hook-edges - commit 04d81a9c

- Item 5 (R4-dashboard-2), appended under a new "Update (2026-10-29, ... R4
  ...)" paragraph: the followed job replaced on screen by a new generation
  still queued or running is never counted as ended - its last batches are
  not read until the new job finishes a batch or ends, and the joined mark
  moves to the new job; R4's verified `leftLive` fix and its test. Re-checked
  at 7fb7b723 with a throwaway probe (P3's shape, written fresh as
  `dashboard/src/zz-fw4-probe.test.tsx`, run once, deleted, tree clean after):
  after the event whose job read answers gen-2 queued the full-read count
  stays 2 and `joined` stays true - the edge holds after FW4.
- Item 3's second path (R4-dashboard-3), appended as a paragraph: the first
  read (or Retry), sent before a press refused 409, can clear the 409 copy;
  item 3's suggested fix covers it.
- The hook line numbers in items 1 to 4 and the frontmatter `refs` were
  re-pointed to 7fb7b723 (FW4 grew three comments below line 134: :382->388,
  :211->213, :200->202, :397->401, :406->410, :225-226->227-228,
  :262->268), as FW3's append did; new refs added for item 5
  (useAnchorRanking.ts:239, :245; RankAnchorPanel.tsx:184; job.ts:179, :211 -
  the server refs checked at HEAD, app/ unchanged since fc587096). The title
  gains item 5's clause. Items 1 to 4 still hold at 7fb7b723 (by reading:
  FW4 changed only the ordering of a press's job of the generation on screen;
  item 2's join, behind the finished view on screen, is now dropped by the
  order rules instead of the gate and still sets `joined`).

## Commits

- 7fb7b723 fix(rankings page): a press's job goes through the order rules
  like any other view; a join under expired shows at once and the poll
  resumes (B2a FW4-1, FW4-2) - hook + test file.
- 04d81a9c docs(issues): file the B2a code review R4 out-of-scope findings
  (B2a FW4 FILE row) - the issue file.
- This report.

Before each commit: a bare `git status` read and the MERGE_HEAD check (ok);
explicit paths staged; ASCII messages with the trailer.

## Gates run (all foreground, bare, output to scratch files)

| Command | Result |
|---|---|
| `cd dashboard && npx vitest run src/routes/settings/rankings/useAnchorRanking.test.tsx` at fc587096 (baseline) | 35 passed (35) |
| the same with the new tests, hook unchanged (RED) | 2 failed, 36 passed (38) - P1, P1b |
| the same after the fix (GREEN) | 38 passed (38), exit 0 |
| `cd dashboard && npx vitest run src/routes/settings/rankings` | 8 files, 126 passed (126), exit 0 |
| `cd dashboard && npx vitest run` (whole dashboard workspace) | 282 files, 5807 passed (5807), exit 0, 61.6 s |
| `npm run typecheck` (worktree root) | exit 0 |
| `npx eslint dashboard/src/routes/settings/rankings/useAnchorRanking.ts dashboard/src/routes/settings/rankings/useAnchorRanking.test.tsx` | exit 0, no output |
| ASCII: added lines of the hook, the test file and the issue; both commit messages | 0 non-ASCII; both source files ASCII, LF |

Not run (the orchestrator's): the root `npm test`, `npm run smoke`, `npm run
e2e`.

## Deviations from the dispatch text

1. A third test (the guard at :939) beyond P1 and P1b - it pins the dropped
   gate's purpose (A2-2) on the rule that replaces it; proven by mutant mO.
2. P1 extends R4's probe to the job's end (done: one more full read, joined
   cleared, poll stopped); P1b asserts the press's view at once, not only the
   recovery after the event (see FW4-1).
3. Two comment edits beyond R4's cited lines: the `jobProgress` clause
   (R4-dashboard-4's optional bullet) and the round 2 describe comment in the
   test file (the same phrase).
4. The issue's in-body and frontmatter hook refs re-pointed to 7fb7b723, and
   its title extended for item 5.

## Questions

None.
