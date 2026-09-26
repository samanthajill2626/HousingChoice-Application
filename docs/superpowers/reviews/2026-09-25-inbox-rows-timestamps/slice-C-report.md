# Slice C report - inbox rows + timestamps (plan Task 5)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`. Implementer: Claude
Opus 5.5 (1M context). Scope held to the three named files. Nothing else is
staged.

## Commit

- `662a203c` feat(inbox): rebuild useInbox around one committed list with a
  restore-and-reconcile store (Task 5). It touches `useInbox.ts` (a
  whole-file replacement), `useInbox.test.tsx`, and in `Inbox.test.tsx` only
  the five `baseState` fields (:34-38).

## Tests and gates

All commands ran bare from the worktree. Logs are in the ignored
`.superpowers/sdd/sliceC-*` files.

- **Baseline before any edit:** `useInbox.test.tsx` had 36 passing tests.
  `npx eslint` on the three files exited 0 with no output.
- **Step 2 did not match the plan's single failure.** The plan's hook against
  the old test file gave 7 failed and 29 passed. All 7 were 5 s `waitFor`
  timeouts caused by module-store leakage between tests:
  - The unmount save from "appends a page on loadMore" left `anon:all:100`
    with a null cursor.
  - The next test mounted from that store hit. Its incomplete reconcile kept
    the null cursor, so `hasMore` never became true.
- **The fix the plan anticipated:** as the plan's fallback (plan 2166-2169)
  and the brief direct, I added the `clearInboxLists()` beforeEach line
  first (`useInbox.test.tsx:106`, with Step 3(a)-(c)). The re-run gave 1
  failed and 35 passed. The failure was exactly the test the plan names: it
  expected `error` and got `ready`.
- **Item 1, red then green:** with the plan's catch guard, the run gave 52
  passed and 1 failed, the item-1 test (`refreshFailed` stayed false). After
  the change, all 53 passed.
- **Gates on the committed bytes** (file hashes were identical before and
  after):
  1. `npx vitest run src/routes/inbox/useInbox.test.tsx --root dashboard`:
     53 passed (53), exit 0.
  2. `npm run test -w @housingchoice/dashboard`: 195 files and 3221 tests
     passed, exit 0. That is slice B's 3204 plus the 17 new tests.
  3. `npm run typecheck`: exit 0.
  - An extra check, not a slice gate: `npx eslint` on the three files exited
    0 with no output, the same as the baseline (see divergence 3).
- **ASCII:** `useInbox.ts` has 0 non-ASCII bytes, and so do the lines added
  to both test files. The live hook's em dashes and arrow became ASCII.

## Worklist S5 items

1. **Failure path refuses on the filter only.** At `useInbox.ts:388` the
   catch refuses on the FILTER axis only.
   - With rows rendered, it raises `refreshFailed` whatever the generation
     (:395-398).
   - With no rows rendered, it takes the unchanged 404-pending and error arms
     (:400-413).
   - The explaining comment is at :369-387. The success path keeps its
     generation guard at :342.
   - The test is at `useInbox.test.tsx:1106-1158`, in the new describe block
     (:923). It proves the POST committed before the read failed by checking
     the store: a commit saves `unreadCount` 0 there, and a pending patch
     alone is never saved.
   - Putting the plan's guard back fails this test and no other.
2. **Renames and amendments.** Every carried block now says `fetchHead`
   instead of `fetchFirstPage` (:224, :274-276, :508).
   - Block (1) (:273-285) says a complete page replaces the list and an
     incomplete one merges in (spec 5.6).
   - Block (5) (:508-513) keeps its first sentence, renamed, and amends the
     second.
   - Block (3) (:323-341) carries the plan's replacement example.
3. **Every listed comment is carried** (live line -> committed line):

   | Live | Committed | What |
   |---|---|---|
   | :41-80, :86-91 | :73-123 | InboxState field notes |
   | :144-148 | :256-260 | C2 defense-in-depth pair |
   | :151-158 | :263-271 | SSE-reconcile axis |
   | :182-186 | :287-290 | debounce ref |
   | :282-295 | :417-432, :435-444 | filter effect |
   | :303-306 | :451-455 | truncated reset |
   | :345-347 | :531-533 | truncated replace |
   | :354-357 | :540-544 | loadMore finally |
   | :405-415 | :591-602 | per-kind read |
   | :458-469 | :647-659 | badge clear and commit |
   | :485-489 | :675-679 | markUnread addressing |
   | :504-506 | :694-696 | markUnread epoch |

   - Also carried, though not listed:
     - the header facts (:4-6, :21-24)
     - the countGroupRows doc (:142-143)
     - the pending and badge notes (:212-218)
     - the 404 arm's `truncated` note (:404-407)
     - the SSE section note (:550-552)
     - clearPatch's note (:572-573)
     - the return-site notes (:715-716, :725-728)
   - The old failure-path block (live :248-264) is replaced by the spec 5.7
     comment (:389-394, which names the issue it resolves) and the item-1
     note.
4. **Counts.** The plan's Step 3(f) block has 16 tests. With the item-1 test
   that is 17 new, and 36 existing (one rewritten) + 17 = 53.

## Divergences from the plan's code

- **One code line differs** from plan 1559-2050: `useInbox.ts:388`
  (item 1). Proof: after stripping comments and blank lines from both files,
  the diff is a single one-line hunk. The test additions match the plan byte
  for byte, apart from the one inserted item-1 test:
  - Probe = plan 2211-2250
  - the RETRY rewrite = plan 2104-2157
  - the describe block = plan 2268-2508
- **Comments:**
  - the carried blocks listed above;
  - three short, checked notes (:356-357, :369-371, :629-632);
  - `InboxState.truncated` (:91-98) keeps the live wording "replaced (never
    OR-ed) by each page", because `appendPage` replaces it too
    (`inboxListMerge.ts:152`). The plan said "by each head read";
  - `serverRowCount` now says that a committed head read or a loaded page
    moves it.
- **Removed the plan's `eslint-disable-next-line
  react-hooks/set-state-in-effect`** (plan 1843). In the rebuilt effect,
  eslint reported it as an unused directive: a warning on a file whose
  baseline was clean. I checked why by linting from stdin with
  `--no-inline-config`, so the working tree was untouched:
  - `main`'s hook errors at its unconditional `applyStatus` (main :299).
  - The committed hook reports nothing.
  - Making the reset block unconditional makes the rule fire inside it.
  - Moving `setLoadingMore(false)` above the `if` makes it fire on that line.

  So with plugin 7.1.1 the rule reports once per effect, at the first
  setState, and it accepts a first setState under a ref-derived condition
  (`restoredKeyRef`). The worklist's "placed right" missed that exemption.
  The comment at :423-432 says why no suppression is needed and which
  reordering would need one.
- **Process:**
  - `clearInboxLists()` went in before Step 2's green run (see above).
  - The item-1 test sits after the plan's first `refreshFailed` test.

## Worth an eye (not blocking)

I ran 31 one-line mutants of the committed code against the hook tests:
8 killed and 23 survived. The script and logs are in
`.superpowers/sdd/sliceC-mutants/`. Its `summary.txt` line numbers predate my
final comment edits; the code is the same, and this report cites committed
lines. The hook was restored hash-identical.

For items 1 and 2 below, I checked each suggested fix against its mutant
with a throwaway copy of the test file. The copy is deleted and the tree is
clean.

Gaps, where no test pins the behavior:

1. **The success-path generation guard (:342) can be deleted with all 53
   green.** Only its spinner half is pinned, by the rewritten RETRY test
   (:797).
   - The test meant to pin the rest (:332) asserts through `waitFor` right
     after releasing the stale page (:352-353).
   - `waitFor` checks once synchronously, and that check passes before the
     stale page's continuation commits.
   - `main` has the same shape.
   - Fix: release inside an async `act` that waits 50 ms, then assert unread
     is 0. That version fails when the guard is deleted.
2. **The key effect's `setLoadingMore(false)` (:462) can be deleted.**
   - A Load more that is in flight across a tab switch then leaves
     `loadingMore` true on the new tab, because the stale page's `finally`
     skips it. Load more is dead on that tab.
   - Fix: assert `loadingMore` is false after the switch in the test at
     :158. That fails on the mutant.
3. **`markUnread` has no hook-level test.** Deleting its commit (:702), its
   epoch scoping (:701) or its alive gate all survive. The plan wired
   `markInboxUnread` and an `unread:` Probe button, but no test clicks it.
4. **Unpinned reset and restore lines:**
   - the reset's `pendingRef` clear (:457);
   - its `refreshFailed` clear (:459, which spec 5.7 names);
   - its scroll zeroing (:460);
   - the unmount save's ready gate (:483, invariant 7). A StrictMode mount
     that misses the store, with a hanging read, would pin it;
   - the `restoredKeyRef` update (:463). Without it, a restored mount that
     leaves its tab and comes back skips the reset and shows the other tab's
     rows until the head read lands.

Surviving by design:

- **Commit-point locks backed by aborts:**
  - both filter refusals (:355, per its HONEST STATUS note, and :388);
  - the success-path `aliveRef` check (:358);
  - loadMore's `aliveRef` checks (:530, :545);
  - the aborts behind them (:439, :474).

  Notes are at :356-357 and :369-371.
- **The two `aliveRef` gates back each other up:** the one in `commitList`
  (:303) and the one in markRead's commit (:660). Either one deleted alone
  survives. A probe that settles a POST after unmount and
  `clearInboxLists()` fails only when both are gone. Nothing pins the pair,
  which covers the sign-out ordering case.
- **Epoch scoping (:655, :701)** is now a second lock on the spinner strand
  it was written for (note at :629-632). The "PREVIOUS filter" test (:740)
  passes without it.
- **Checks that change nothing today, and a rare path:**
  - The `ready` half of both rows-rendered checks (:395, :499) changes
    nothing today: `base` is non-empty only while the status is ready.
  - The 404 arm's `firstPageGen` bump (:408) matters only for a Load more in
    flight on an empty list that has a cursor.

Other notes:

- **A restored mount's reconcile can be discarded.** If a mark-read commits
  before the reconcile page lands, the generation guard discards the page,
  because the status is already ready. The list stays restored and unarmed
  until the mark-read's own `conversation.updated` reconcile. This is the
  same class as any background reconcile today.
- **`restoredScrollTop`** holds the mount-time value for the whole mount.
  Task 7 applies it once (plan 3251-3259), so this is harmless.
- **One carried claim is not re-checked.** The adversarial-29 text says a
  reconcile-stale cursor is one "the next Load more 400s on". I carried it
  word for word and did not verify it for a same-filter cursor.
