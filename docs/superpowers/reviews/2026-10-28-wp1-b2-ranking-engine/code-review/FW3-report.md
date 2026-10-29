# B2a code review round 3 - fix wave FW3 report

- Implementer: FW3 child (Claude Opus 5.5), 2026-10-29.
- Branch feat/wp1-b2-ranking-engine, worktree W:/tmp/wp1-b2-ranking-engine.
  Start: 4ce4746d (the R3 records commit). End: this report's commit, on top
  of e132fdf7.
- Scope: every FIX row (FW3-1 .. FW3-4) and the FILE row of
  `R3-adjudications.md`. Files touched: the hook, its test file, the issue
  file, this report.
- Method: FW3-1 and FW3-2 test first - each regression test written and run
  RED on the hook at 4ce4746d for the finding's reason, then the fix, then
  GREEN. FW3-4's tests pass on the hook and were each run against the mutant
  R3-dashboard-5 describes. Every mutant below was applied TEMPORARILY in
  place: the hook was first copied to the session scratch dir
  (`C:/Users/Cameron/AppData/Local/Temp/claude/W--AI-Projects-Housing-Choice-HC-Application/1f0c0695-9acd-40ad-b991-190e2c6c0770/scratchpad/fw3/`),
  one `sed` substitution was applied, `diff` against the copy showed exactly
  that one line, the tests ran, the copy was put back and `cmp` / `git diff
  --quiet` confirmed the file was back (for mD and mE: the committed hook of
  b04e21f5). No mutant was committed; the tree was clean after each.
- Before any edit: no `e2e/.artifacts/session.pid`, no listener on lane 7.
  The e2e spec ran after the last source commit; nothing was edited while it
  ran.

## Rows

### FW3-1 - R3-dashboard-1 - the press marks clear only when the FOLLOWED job ends - commit b04e21f5

`dashboard/src/routes/settings/rankings/useAnchorRanking.ts`, `applyJob`:

- :242 `const followedEnded = cur.wasLive && (next === null ||
  !isJobLive(next.status));` - computed before `cur.wasLive` is overwritten
  (:245).
- :246 the press's error and joined mark clear on `followedEnded` (was
  `ended`).
- :236 `ended` unchanged: FW2-1's wider end (`wasLive || newGeneration`)
  still drives the full read (`return { grew, ended }`).
- Comments made exact with it: :228-231 (FW2-1's end is for reading the
  ranking again, not for the press marks), :237-241 (A2-8 as now coded), the
  `wasLive` docblock :121-125.

Tests (`useAnchorRanking.test.tsx`, new block "useAnchorRanking - ordering,
round 3", :711):

| Test (line) | RED on 4ce4746d | Mutation on the fixed hook |
|---|---|---|
| :712 (it.each) a press refused 429 before the first read keeps its message when that read lands with the last finished job | `expected null to be 'Too many rankings. Wait a minute and ...'` (the job shown had become 'done'; the 429 copy was wiped) | mA (FW3-1 reverted: `...(ended && { rankError: null, joined: false })`): RED, same message |
| :712 (it.each) the same with the press lost on the network (`TypeError('Failed to fetch')`) | `expected null to be 'The ranking could not be started. Try...'` | mA: RED, same message |
| :736 a first job view of a ranking that ended unseen, with no batch finished, reads the ranking again and leaves a refused press its message | `expected null to be 'Too many rankings. ...'` (its read-again assertion passed) | mA: RED (message wiped). mC (FW2-1's wider end dropped: `const ended = cur.wasLive && (...)`): RED, `expected "spy" to be called 2 times, but got 1 times` (getRanking) |

Hook file under mA: 3 failed / 30 passed (33) - exactly these three. Under
mC: 1 failed / 32 passed - exactly :736.

### FW3-2 - R3-dashboard-2 - `expired` is level with `queued` - commit b04e21f5

- :140 `jobProgress`: `const stage = view.status === 'queued' ||
  view.status === 'expired' ? 0 : view.status === 'running' ? 1 : 2;` (was
  `queued ? 0 : ...`). Docblock :133-138: `expired` is a queued record read
  past its expiry, and a poll tick that started before the expiry can still
  claim it and run the same generation (checked: job.ts:596-617 takes the
  tick's `nowIso` once; rankingRunsRepo.ts:309 claims on `#qexp > :now`).
- Test :759 a queued job read as expired and then claimed in the same
  generation is followed: press (gen-1 queued); the poll reads `expired`
  (one full read, the poll stops); an event reads running 0 of 2 -> applied;
  the resumed poll reads running 1 of 2 -> applied, one full read.
- RED on 4ce4746d: `expected { status: 'expired', ...(7) } to match object
  { status: 'running', ...(2) }` (the running view dropped as behind).
- Mutation mB (FW3-2 reverted): 1 failed / 32 passed (33) - exactly :759,
  same message.

### FW3-3 - R3-dashboard-4 - the header and the press comment made exact - commit b04e21f5

Comments only. The press gate (:396) is unchanged: the adjudication took the
wording fix, not R3-dashboard-4's "drop the gate" alternative.

- Header :14-46. A full read and a job read take their issue number when
  sent; a press takes one when its answer lands, and only if its job is
  offered. The same-generation progress rule names its sources (a job read,
  a read that adopts its job - not a press) and its status order (queued or
  expired, then running, then done or failed). A new bullet for the press:
  offered only when its generation is not the one on screen (or none is
  shown), then the newest number, so applied; a press's job of the
  generation on screen is never applied, whatever its progress. The A2-8
  rule as FW3-1 codes it.
- Press comment :383-395. The premise "read after the claim, so as new or
  newer" now held to a FRESH press (its generation is new, so the view on
  screen was read after the claim). A JOIN's job can be ahead of the view on
  screen (queued on screen, running 2 of 4 in the answer); the page catches
  up with the next job read - the poll's, while the view on screen is live,
  or an event's.
- Every claim re-read against the code and the server's claim
  (job.ts:211-223: a fresh press answers with the claim record; a join with
  a consistent read of the live record; a queued record past its expiry is
  reclaimed, never joined).

### FW3-4 - R3-dashboard-5 - two pinning tests - commit 7a6f6d92

GREEN on the hook; each RED on its mutant with every other rankings test
green:

| Test (line) | Mutant | Rankings directory under the mutant |
|---|---|---|
| :790 within one generation a view whose pool is not built is behind one whose pool is, even when issued later: "Ranking..." never replaces "0 of 3" (FW2-5) - the first read (its job snapshot taken after the pool: running 0 of 3) lands first, then a later-issued job read served before the pool (running, batchCount 0) | mD: `jobProgress` returns `[stage, finishedBatchCount(view), 0]` (the pool-built tier replaced with 0) | 1 failed / 122 passed (123): `expected { status: 'running', ...(8) } to match object { status: 'running', batchCount: 3 }` |
| :816 a job read out when the clock goes back no longer holds the next one: a negative age counts as stalled (FW2-2) - an event's job read never answers; `vi.setSystemTime(Date.now() - 1 h)`, no time passes; a second event | mE: `if (age < JOB_READ_STALL_MS)` (the `age >= 0 &&` removed) | 1 failed / 122 passed (123): `expected "spy" to be called 2 times, but got 1 times` (getRankingJob) |

### FILE - rankings-page-hook-edges - commit e132fdf7

- Item 4 appended under "Update (2026-10-29, WP1 B2a code review R3,
  finding R3-dashboard-3)": the cross-generation late snapshot in both
  landing orders; its cost (the old Done, no poll, events only); the
  suggested fix (order views of different generations by the record's
  (requestedAt, startedAt), issue order as the tie-break and for a null
  view); the test (R3's probe P3 inverted, and order (b)). Refs verified at
  HEAD: useAnchorRanking.ts:225-226 and :262; readRanking.ts:357 then :365;
  job.ts:194; rankingRunsRepo.ts:334.
- FW3's comments moved the hook's lines, so the issue's earlier refs were
  re-pointed in the frontmatter and the body: :363 -> :382, :197 -> :211,
  :186 -> :200, :371 -> :397, :380 -> :406 (RankAnchorPanel.tsx :152 / :160
  unchanged; that file is untouched). Items 1-3 still hold at HEAD: FW3
  changes none of their paths (item 3 clears through the `wasLive` a 409
  sets, which FW3-1 keeps).
- Frontmatter: `updated: 2026-10-29`, and the title names the new item.
  `npm run issues`: indexed (459 open), no frontmatter error.

## Suites and gates

- Hook file: 35/35 (29 earlier + 6). Rankings directory (`cd dashboard &&
  npx vitest run src/routes/settings/rankings`): 8 files, 123/123.
- Dashboard workspace (`cd dashboard && npx vitest run`, foreground): exit 0
  - 282 files, 5804 tests (FW2: 5798; +6), 61.6 s.
- `npm run typecheck` (root, bare): exit 0 after the fixes, and again at
  e132fdf7 (all code of the wave).
- ESLint on the wave's .ts / .tsx (`git diff --name-only --diff-filter=d
  4ce4746d..HEAD`, 2 files): exit 0, no output.
- ASCII: 0 non-ASCII characters in the added lines of `git diff -U0
  4ce4746d..HEAD` and in the wave's commit messages.
- e2e, lane 7, foreground, after the last source commit:
  `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/rankings.spec.ts`
  exit 0, 5 passed (21.4 s). A stale `session.pid` remained (no listener):
  `npm run e2e:stop` -> "no running session found; retained state is stale
  or absent - nothing to stop". Afterwards no `session.pid`, no listener on
  9701 / 9711 / 9721 / 9731, tree clean.
- Not run (orchestrator gates): root `npm test`, `npm run smoke`, the full
  e2e suite.

## Interpretations and deviations

1. One test beyond the adjudicated list: :736 (FW3-1, the job-read path).
   FW3-1 keeps FW2-1's wider `ended` for the full read, but no test pinned
   that half: probe before any edit, at 4ce4746d with only the
   new-generation end dropped (mC's line), all 117 rankings tests passed
   (restored from the scratch copy). With `followedEnded` now beside
   `ended`, swapping one for the other is the obvious slip; :736 is the only
   test that catches it. It also covers the second path R3-dashboard-1
   names (the first view is a job read that finds someone else's generation
   finished).
2. The adjudicated FW3-1 test is parametrized over both refusals
   R3-dashboard-1 names (429 and a network error): 2 cases.
3. FW3-1 also ends FW2-1's incidental clearing of a REUSED slice's stale
   rankError / joined (R3 "Swept and fine"): after a window toggle away and
   back they now carry over, as item 1 of `rankings-page-hook-edges`
   already says ("A stale `rankError` or `joined` carries over the same
   way"). Not a new edge.
4. FW3-3 also covers the `wasLive` docblock and applyJob's FW2-1 / A2-8
   comments, which FW3-1 made inexact.

## Note for the orchestrator (no action taken)

- N1. FW3-2 fixes R3-dashboard-2's running views, not its second press.
  When the straddled expiry leaves `expired` on screen (not live, so no
  poll) and the admin presses Rank, the press JOINS the now-running
  generation; the press gate (:396) drops its running view (same
  generation), so only `joined: true` lands: "... not picked up. Press Rank
  again. (joined the ranking already running)". The next event's job read
  now applies (running is ahead of expired), so the page recovers on the
  first event; with the events lost it stays until a reload. Needs the
  straddled expiry, a page read inside it, a press, and lost events.
  R3-dashboard-4's alternative (pass every press view through applyJob)
  would cover it. Not filed; your call.

## Questions

None.

## Commits

- b04e21f5 fix(rankings page): a refused press keeps its message until the job the page followed ends; a job read as expired is level with queued (B2a FW3-1, FW3-2, FW3-3)
- 7a6f6d92 test(rankings page): pin FW2-5's pool-built tier and FW2-2's negative-age rule (B2a FW3-4)
- e132fdf7 docs(issues): file the B2a code review R3 out-of-scope finding (B2a FW3 FILE row)
- this report (docs(records))
