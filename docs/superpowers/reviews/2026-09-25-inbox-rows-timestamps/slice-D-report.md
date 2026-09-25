# Slice D report - inbox rows + timestamps (plan Tasks 6 and 7)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`. Implementer: Claude
Opus 5.5 (1M context). I touched only the six named files and staged
nothing else. Task 7b was not built. Logs are in the ignored
`.superpowers/sdd/sliceD-*` files.

## Commits

- `afdd68b7` feat(inbox): auto-load consumes observer reports at arrival and
  re-observes on a commit (Task 6). It adds `useAutoLoad.ts` and
  `useAutoLoad.test.tsx`.
- `316f1717` feat(inbox): page-size param, auto-load sentinel, refresh
  banner, scroll restore (Task 7). It changes `Inbox.tsx`,
  `Inbox.module.css` and `Inbox.test.tsx`, and adds `Inbox.styles.test.ts`.

## Tests and gates

All commands ran bare from the worktree.

- **Task 6**
  - Red: exit 1, failing with `Failed to resolve import "./useAutoLoad.js"`.
  - Green: `useAutoLoad.test.tsx` 10 passed, exit 0.
  - Dashboard suite: 196 files, 3231 tests, exit 0.
  - Typecheck: exit 0.
  - eslint on both files: exit 0, no output.
- **Task 7**
  - Red: exit 1, 17 failed and 36 passed (53). The 15 new page tests failed
    (`limitFromParam is not a function`) and the 2 styles tests failed.
  - Green: `Inbox.test.tsx` 51 passed and `Inbox.styles.test.ts` 2 passed,
    exit 0. I re-ran them after the last comment edit, before committing.
  - Dashboard suite: 197 files, 3248 tests, exit 0. That is 3231 plus the 17
    new tests.
  - Typecheck: exit 0.
  - eslint on all five touched TS/TSX files: exit 0, no output.
- **Log noise:** the suite's stderr lines come from `ContactDetail.test.tsx`.
  The Task 6 run shows the same lines.
- **ASCII:**
  - 0 non-ASCII bytes in `useAutoLoad.ts`, `useAutoLoad.test.tsx`,
    `Inbox.styles.test.ts` and the whole `Inbox.tsx`.
  - 0 in the added lines of `Inbox.module.css` and `Inbox.test.tsx`. The
    CSS keeps its pre-existing U+2014 on untouched line 1.
  - The styles-test regex escapes survived verbatim
    (`Inbox.styles.test.ts:10`).

## Worklist S7 items

- **5.** I added only `seenLimit`, `seenOperator`, `seenRestoreScroll` and
  `noteScrollTop` (`Inbox.test.tsx:16-19`). `baseState` now uses
  `noteScrollTop,` (:43).
- **6.** Every listed comment is carried where its element survives. Live
  line -> committed line:

  | Live | Committed |
  |---|---|
  | :29-63 | :64-99 |
  | :67-70 | :105-109 |
  | :73-78 | :112-118 |
  | :112-127 and :129-134 | :234-255 |
  | :156-196 | :277-317 |
  | :208-219 | :329-339 |
  | :257-283 | :387-413 |

  The subtitle (:205) and the Loading label (:421) are ASCII.
- **7.** The counts match the worklist: 15 new tests, 51 in total, plus 2
  styles tests and 10 hook tests.

## Divergences from the plan

1. **Task 6: none.** Both files are byte-identical to plan 2584-2753 and
   2769-2886. The plan's lint directive stays at `useAutoLoad.ts:80`. It is
   used: with `--no-inline-config` the rule fires at :81.
2. **Task 7 code: none.** After stripping comments with the TypeScript
   printer, the page is identical to plan 3123-3391 (the whitespace-blind
   diff is empty). The CSS is identical to plan 3405-3415 and 3421-3441.
3. **Removed lint directive.** I removed the plan's
   `eslint-disable-next-line react-hooks/set-state-in-effect` (plan 3234)
   because eslint reported it as unused. I checked why by linting from
   stdin, with the working tree untouched:
   - With plugin 7.1.1 the rule stays silent when the setState has either a
     ref-derived guard or a value read from a ref.
   - It fires only when both are gone.

   A three-line note replaces the directive (`Inbox.tsx:165-167`).
4. **Test imports.** I merged `useNavigate`, `Routes` and `Route` into the
   existing react-router-dom import (`Inbox.test.tsx:3`) instead of adding a
   second import line. `useEffect` is at :2 and `cleanup` at :1. The
   appended describe block (:553-646) diffs byte-identical to plan
   2977-3070.
5. **Comment amendments (text only, no behavior change):**
   - "a page of 30" now reads "a page (30 rows at the time)" (:72-73),
     because the default is now 100.
   - The live A26 note said the group count was a server-page tally. That
     was already false on main: `groupRowsShown` counts the RENDERED rows
     (`useInbox.ts:729`). I rewrote the note to match (:105-109).
   - The early-end note's claim that "all caught up is the truth" predates
     the three-way copy split. It now says the empty-state block renders
     with the copy `empty` selects (:115-118).
   - "the banner below" now reads "the failure banner below" (:279, :298),
     because the page now has two banners.
   - The early-end surface note named `!truncated` as the empty state's
     matching gate. The real gate is `!serverEndedEarlyEmpty` (:333-334).
6. **Comment additions:**
   - the header adds a design-doc pointer and the pending clause (:1-9);
   - `filterFromParam` carries the fuller live doc (:21-25);
   - `selectFilter` carries the live note plus one sentence on the limit
     (:123-126);
   - there is a new note on the groups link (:135-136);
   - the sentinel note says it is gated like Load more and that the spec
     5.2 arming rule keeps an empty page manual (:378-382).

   I carried one sentence unchanged but could not verify it: "Same
   one-commit shape the error banner above already defends against"
   (:316-317). Today's error surface has no filter gate.

## Worth an eye (not blocking)

I ran 23 one-line mutants: 9 were killed and 14 survived. Both files were
restored hash-identical. The script and logs are in
`.superpowers/sdd/sliceD-mutants/`.

**Hook gaps:**

1. **Deleting `handledEpochRef.current = epoch` (`useAutoLoad.ts:106`)
   survives. This is the worst gap.**
   - After the first epoch move, every re-enable then re-observes. A FAILED
     page auto-retries in a loop while the sentinel stays in view, which
     breaks invariant 3.
   - Test :68 enables only at the mount epoch.
   - Fix: go to epoch 2, then disabled, then enabled again at epoch 2 with
     the sentinel in view. Expect `reobserved` 1 and no new load.
2. **Dropping `!enabled` from the re-observe guard (:105) survives.**
   - Re-observing while disabled discards the fresh report and marks the
     epoch handled. A page discarded by a head read is then never
     re-issued.
   - Test :94 is named for this shape, but it moves the epoch and `enabled`
     in the same rerender.
   - Fix: rerender disabled at epoch 2 with the sentinel in view and expect
     0 re-observes. Then enable and expect 1 re-observe and 1 load.
3. **The two NO_REPORT resets (:81, :94) are redundant.** Each report is
   consumed once by its seq, so a stale "in view" can never fire again.
   Test :145 passes with neither reset. The spec 5.2 reset bullet predates
   the seq design.
4. **The cleanup's `observerRef.current = undefined` (:93)** is backed by
   the `sentinel !== null` guard (:108).

**Page gaps:**

5. **The page's auto-load wiring has no unit test.** Each of these
   survives:
   - `enabled: true` (`Inbox.tsx:197`);
   - `epoch: 0` (:198);
   - a no-op `onLoad` (:199).

   jsdom has no IntersectionObserver, so only the Task 9 Playwright spec
   can catch them. A unit test could mock `./useAutoLoad.js` and assert the
   options the page passes.
6. **The restore-once latch (:187) survives.** Without it, the restore runs
   again whenever `hasRows` flips, for example when the Unread tab is
   cleared and then refilled.
7. **The store-only guard (:188) survives.** Without it, a fresh POP mount
   writes `scrollTop` and calls `noteScrollTop` with null.
8. **The scroll listener (:175) survives.** No test fires a scroll event, so
   nothing proves the spec 5.8 unmount save sees the scroll position.
9. **Smaller gaps:**
   - The sentinel's `aria-hidden` (:384) is not asserted, although spec 5.2
     requires it.
   - The resolve-once guard (:162) survives harmlessly.

**Other:** `Inbox.test.tsx:543` cites "Inbox.tsx:42" for
`serverEndedEarlyEmpty`. That citation was stale before this slice (it was
:79 on main) and is :119 now. It is not my test line, so I left it
unchanged.
