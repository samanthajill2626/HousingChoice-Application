# Slice G report - inbox rows + timestamps (plan Task 9, the Playwright spec)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`. Implementer: Claude
Opus 5.5 (1M context). Touched one file,
`e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts` (new, 361 lines). No
dashboard or app source was edited. Logs and evidence are in the ignored
`.superpowers/sdd/sliceG-*` files.

## Commit

- `c4188224` test(e2e): inbox rows, timestamps, auto-load, back-button
  restore and the refresh banner. One explicit path. `git status` was read
  first, there was no MERGE_HEAD, and the file has 0 non-ASCII bytes.
- Before the lane started: e2e workspace typecheck exit 0, and `npx eslint`
  on the file exit 0 with no output. Both were run again after the last
  edit, with the same result.

## Lane

- **Lane 16**: app :10601, dashboard :10611, fake :10621, public base
  :10631, prefix `hc-local-16-`, launcher pid 70404.
- **Before**: there was no `e2e/.artifacts/` directory, so no lane record.
  - A stray probe of mine (`node e2e/support/lane.mjs`) had reserved lane 16
    for a moment. I released it with the module's own `releaseLane`, keyed
    by its token, before the session started.
  - The only other lease is `lane-3`, which belongs to
    relay-gate-refusal-warn. I left it untouched.
- **Start**: `npm run e2e:session` ran in the background, logging to
  `sliceG-session.log` (log created 19:01:08). The ready line was in the log
  by 19:01:28.
- **Stop**: `npm run e2e:stop` exit 0 (`sliceG-e2e-stop.log`). It stopped
  launcher 70404 and its children, dropped the `hc-local-16-*` tables and
  released the lease.
  - The background session command then exited, as expected. Its log ends
    at the stop's `/__dev/ping`.
  - Nothing listens on the four ports (checked with `netstat` and
    `Get-NetTCPConnection`).
  - `lane.json` and `session.pid` are gone.
  - The only node process naming this worktree is the orchestrator's
    transcript-tail mirror, which is not mine.

## Spec runs (all through the item-28 command, lane 16)

- **run1** (the plan file with items 23-24 applied): 5 passed, 1 failed, in
  31.6 s. Per-test times: 1.9, 5.1, 12.1 (test 3 FAILED), 1.7, 1.9 and
  5.3 s.
  - Test 3 failed at the "a head read followed the return" poll: 0 within
    10 s.
- **run2** (test 3 alone, `E2E_TRACE=1`): the same failure (12.4 s), so it
  is deterministic. The trace is `sliceG-run2-test3-trace.zip`.
- **run3** (test 3 alone, after the fix): pass, 3.6 s.
- **run4** (test 3 alone, with a temporary print): pass, 3.5 s. The
  destination (the connecting relay's `/conversations/...` page) had
  scrollTop 0 and scrollHeight = clientHeight = 400. The saved position was
  285, so the restore is real.
- **run5** (all six, with a temporary geometry probe in test 6): 6 passed,
  20.6 s.
- **run6** (the final file): 6 passed, 20.3 s. Per-test times: 1.6, 4.9,
  3.5, 1.6, 1.9 and 5.4 s.
- **run7** (the final file, a confirmation run): 6 passed, 20.5 s. Per-test
  times: 1.6, 4.8, 3.5, 1.7, 2.4 and 5.3 s.

Both probes were removed before the final runs. The committed file is
byte-for-byte what run6 and run7 ran.

## Sibling inbox specs (one command, lane 16, after run7)

20 tests: 19 passed and 1 failed, in 46.3 s (`sliceG-siblings-run1.log`).

| File | Result |
| --- | --- |
| inbox.spec.ts | 1/1 passed |
| inbox-comms.spec.ts | 1/1 passed |
| inbox-markread.spec.ts | 2/2 passed |
| inbox-nav-badge.spec.ts | 3/3 passed |
| inbox-mark-unread-header.spec.ts | 3/3 passed; the store-backed PUSH mount still flips its row |
| call-inbox-unread.spec.ts | 4/4 passed |
| group-text-conversion.spec.ts | 1/1 passed |
| unknown-caller-triage.spec.ts | 2/2 passed |
| deleted-contact-resurfacing.spec.ts | 1/1 passed |
| group-text-inbox.spec.ts | FAILED :33; :114 passed |

**The group-text-inbox failure.** The test at :33 fails at :96: "the open
partition must page, or this guard proves nothing", Received: null.

- **Re-run alone once** (`sliceG-siblings-rerun-group-text-inbox.log`): the
  same failure, with 1 failed and 1 passed. It is deterministic after a
  reseed. The screenshot is `sliceG-sibling-group-text-inbox-failed.png`.
- **Cause: pre-existing coupling to lane state, not this branch.**
  - The test neither reseeds nor mints a 1:1 of its own.
  - After a reseed, the lean `open` byLastActivity partition holds only
    Tasha's 1:1 (`app/src/lib/seed/lean.ts:228`). The group text lives in
    `group_open` (:243) and the relay lives in `connecting` (:261).
  - So `filter=all&limit=1` fills on the chunk's last item, the chunk has no
    LastEvaluatedKey, and nextCursor is null
    (`app/src/routes/inbox.ts:2448, :2459, :2467`). The branch diff only
    re-indents that logic inside the prefetch try/finally. It is otherwise
    identical to main.
  - The guard passes only on residue from earlier specs. In full-suite
    order, group-text-crosscheck and group-text-detection run between
    group-text-conversion's afterAll reseed and this file. My batch ran it
    directly after that reseed, and the solo run ran it directly after the
    preflight reseed.
- **Not fixed** (out of scope). Suggest filing an issue: the spec should
  mint a second 1:1 before asserting the open cursor.
- **The S11 full suite is probably green here**, because of that residue. I
  have not verified it.

## Worklist items 23-28

- **23.** The header now says a minted party is a stub contact row named by
  its formatted phone, carrying the Needs triage chip (`spec:8-13`). Nothing
  asserts a row's kind or href shape. Test 4's row is `stubRow` (:291).
- **24.** `mintNumber` (:59) builds +1 555, then the block digit (6-9), the
  last 4 stamp digits and a 2-digit index (0-99). Out-of-range blocks and
  indexes throw.
  - The exchange code is 6xx-9xx, so it can never hit +1555010000x (lean),
    +155501990xx (the fake's ad-hoc range) or +15550009999.
  - Blocks per mint call:
    - Test 1: 9.
    - Test 2: 9 (three parties), 8 (the fourth), 7 (the fifth).
    - Test 3: 9.
    - Test 4: 9, plus the long-name contact at block 8, index 0 (:267).
    - Test 5: 9 and 8.
    - Test 6: 9 (35 parties).
  - The plan's derived stamps are gone. Persona labels carry the block and
    the index.
- **25.** The `/Group text/` locator is kept. At limit=10 and limit=2, the
  last row opened the connecting relay's `/conversations/...` page (run4).
- **26.** I followed the order: write, start the lane, iterate uncommitted,
  `e2e:stop`, then commit.
- **27.** The `afterEach` reseed is kept. Every "Load more gone" check
  follows an exact final count.
- **28.** I used it verbatim. The file:line form (`...spec.ts:192`) also
  passes through for a single test. A stale line number reports "No tests
  found", so after an edit the line has to be re-grepped.

## Test 6 geometry (run5, 1280x400)

- `main` clientHeight is 400. A row is 48.5 px tall with a 56.5 px pitch.
  The first row sits 152.3 px below main's top.
- On page one (17 rows), the sentinel is at 1112.8 px, which is 312.8 px
  past the 800 px edge (viewport plus margin).
- A 15-row page is 847.5 px. The limit, the party count and the 17/32/38
  counts are unchanged. The comment now says "about 850px", where the plan
  said 700 (:342).

## Divergences from the plan's file

1. **Items 23 and 24**, as above.
2. **Test 3 waits for the Inbox to unmount** after each row click, before
   `goBack`: the list gone (:220, :250). This was the root cause of run1.
   - The trace shows `waitForURL` resolving inside the click and `goBack`
     3.3 ms later, with no `/api/conversations` request and no inbox
     request afterwards.
   - React Router 7.18's `BrowserRouter` commits location changes inside
     `React.startTransition`
     (`node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:10411`).
     The back press superseded the uncommitted transition, so the Inbox
     never unmounted. Nothing was saved, restored or reconciled, and the
     scroll check passed vacuously.
3. **Test 3 scrolls the destination to the top before `goBack`**
   (`scrollToTop`, :117 and :224). The shell's `main` keeps its offset
   across routes, so this makes the restore check independent of the
   destination's height. Today the destination is short anyway (run4).
4. **Test 3 now checks the scroll after the reconcile settles** (:238-239).
   Spec 7.3 asks for this; the plan's file omitted it.
5. **`inboxList` uses an exact name** (:105), and `rows` is built on it. The
   plan matched on a substring; it is the same element today. The
   `listHandle` in test 2 (:176) keeps the plan's substring locator.
6. **The test 6 comment** carries the measured pitch.

## Dashboard defects

None. The run1 failure was a spec timing defect, fixed in the spec.

## Worth an eye (not blocking)

- **`waitForURL` does not prove the route rendered** under React Router 7
  transitions. Any spec that presses back, or acts, right after a URL wait
  can race the commit. A sweep for `goBack` after `waitForURL` may be worth
  a small issue.
- **The group-text-inbox:33 order dependence** above.
- **Test 6 and test 2's head-first order** assume no stray SSE-triggered
  head read lands mid-test. A complete head read drops the loaded pages.
  Seeding finishes before the page opens, and none appeared in four green
  runs.
- **The absence waits** (1000, 800, 1500 and 800 ms) are inherent to
  proving that no request came, and add about 4.1 s. Test 1 compares
  `datetime` against a second API read, which a mid-test activity bump
  would break. None was seen.
