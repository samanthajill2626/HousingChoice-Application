# Slice B report - inbox rows + timestamps (plan Tasks 3 and 4)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`. Implementer: Claude
Opus 5.5 (1M context). Scope held to the seven named files; nothing else
staged. `useInbox.ts` is untouched.

## Commits

- `e027136e` feat(inbox): per-operator list store, cleared by AuthGate on
  sign-out (Task 3)
- `ac1ee332` feat(inbox): pure list model - complete heads replace,
  incomplete heads merge (Task 4)

## Tests and gates

All run bare from the worktree; output captured under the ignored
`.superpowers/sdd/sliceB-*.log`.

- Task 3 store red: `Failed to resolve import "./inboxListStore.js"`, as
  predicted. Green: `inboxListStore.test.ts` 4 passed.
- Task 3 gate red: 1 failed / 1 passed. The first test failed on its last
  assertion (`AuthGate.test.tsx:63`) with the saved snapshot (`scrollTop: 7`)
  still in the store, which proves the child's layout-cleanup save ran and
  nothing cleared it. Green: `AuthGate.test.tsx` 2 passed. The existing
  `AuthContext.test.tsx`, which renders the real gate, still passes (2).
- Task 4 red: `Failed to resolve import "./inboxListMerge.js"`. Green:
  `inboxListMerge.test.ts` 22 passed.
- `npm run test -w @housingchoice/dashboard`: exit 0 before each commit.
  194 files / 3182 tests after Task 3 (+2 files, +6 tests over slice A), and
  195 files / 3204 tests after Task 4 (+1 file, +22 tests).
- `npm run typecheck`: exit 0 before each commit (all five workspaces).
- Extra, not a slice gate: `npx eslint` on all seven touched files, exit 0,
  no findings.
- ASCII: the five new files have 0 non-ASCII bytes. So does the replaced
  `AuthGate.tsx`, and so do the 7 lines added to `AuthContext.tsx`. That
  file's pre-existing non-ASCII bytes (lines 1 and 36) are untouched.

## Divergences from the plan

- Content: none. Every file was byte-compared to the plan by script:
  `inboxListStore.test.ts` = plan 775-839, `inboxListStore.ts` = 855-889,
  `AuthGate.test.tsx` = 905-979, `AuthGate.tsx` = 1010-1041,
  `inboxListMerge.test.ts` = 1100-1323 and `inboxListMerge.ts` = 1339-1501.
  The `useOptionalAuth` block at `AuthContext.tsx:65-70` = plan 999-1004. It
  sits after `useAuth` and removes no lines. The `Me` fixture needed no
  extension (`types.ts:10-14` is exactly userId, email, role).
- The two deleted lines in the Task 3 commit are AuthGate's old header lines
  1-2: their em dash and arrow became ASCII `-` and `->`. The header keeps
  its meaning and gains the spec 5.8 paragraph, as the plan wrote it.
- Process: none. No file has a backslash escape, and the Write tool changed
  nothing.

## Worth an eye (not blocking)

1. Nothing tests the filter check in `isAdditive` (`inboxListMerge.ts:54-56`).
   No test uses `filter: 'groups'`, and every test with a relay or group row
   runs under `'all'`. Proof: a mutant that treats those rows as additive on
   every filter passed all 22 tests (`sliceB-t4-mutant-isAdditive.log`). I
   reverted it, and the file is byte-identical to the commit. On the Groups
   tab, group_text rows ARE the paged rows. That regression would make every
   Groups head read with a cursor look incomplete, so stale rows would never
   drop. Spec 7.1 asks for both branches "on every filter". Suggested test,
   one Groups case: two group_text rows plus a cursor at limit 2 must take
   branch C (tail emptied, cursor replaced). I left it to the fix wave
   rather than add to the planned 22.
2. `rowKey` now has two identical definitions (`inboxListMerge.ts:32`,
   `useInbox.ts:104`) until Task 5 makes the second a re-export, as planned.
3. `dedupeConversations` (`inboxListMerge.ts:72`) keys on `conversationId`.
   Today only relay and group rows carry that field. The server's contact row
   (`app/src/routes/inbox.ts:1035-1048`) and both unknown rows (`:1103-1114`,
   `:1494-1505`) omit it, so the dedupe cannot drop a 1:1 row. A future wire
   change that adds `conversationId` to 1:1 rows would bring them into it.
4. Checked, consistent:
   - `appendPage` (`inboxListMerge.ts:142`) replaces `truncated` and keeps
     `groupsTruncated`, exactly as today's loadMore does
     (`useInbox.ts:343-348`).
   - Only `filter=all` reaches the server's additive relay and group merge
     (`app/src/routes/inbox.ts:2411`, `:2444`), which matches the spec's
     all-only `isAdditive`.
5. The AuthGate test's second case passes before the implementation. It is a
   regression guard, consistent with the plan's "FAIL on the first test". The
   gate also clears the store on a cold load that resolves anonymous
   (loading -> anonymous). The store is empty then, so the clear does
   nothing.
