# Code review R1 - spec conformance (inbox rows + timestamps)

Date: 2026-09-25. Reviewer: spec-conformance, read-only on code. Branch
`feat/inbox-rows-timestamps` @156022b7, merge base `main` @cd8e8ddd. Contract:
spec DRAFT 8.4 (Task 7b dropped: only back/history navigations restore).
Inputs read: the spec, plan v5, `research-drift-worklist.md`, slice reports
A-G, `.superpowers/review/package.md`, and the live files.

## 1. Verdict summary

- BLOCKERS: none. MUST-FIX: none.
- CODE: every work-map item and every spec rule is implemented. One NOTE-level
  code edge (SC-14, observer keyed on `root`). Three deviations from the
  plan's code honor the spec BETTER and are conformant: the head-read failure
  path refuses on the filter axis only (worklist item 1,
  `useInbox.ts:369-388`); the `resolveContact` cache key is
  `JSON.stringify([phone, email])`, injective where the spec's joined key is
  not (`inbox.ts:901-907`); the pager also stops the prefetch at page-full,
  ahead of the boundary Query (`inbox.ts:2440`).
- WORK MAP (11 items): CONFORMS 5, PARTIAL 6, MISSING 0. All six PARTIALs
  are gaps in the TEST contract; the code of all 11 conforms.
- SPEC RULES (70 enumerated in 5.1-5.11): CONFORMS 60, PARTIAL 9 (8 test
  pins that do not discriminate + 1 NOTE code edge), MISSING 0, not assessed
  1 (5.11c, the perf gate, belongs to S11).
- INVARIANTS (10): CONFORMS 7 (inv 10's gate evidence is pending S11),
  PARTIAL 3 (inv 2, 3 and 7: the code conforms, but the pins the spec asks
  for do not discriminate), MISSING 0.
- TEST CONTRACT: 11 gaps were reproduced independently with throwaway
  mutants. In each case the COMMITTED suite passes against a one-edit mutant,
  and a proposed pin kills the mutant and passes on the committed code
  (SC-1..SC-11).
- PROCESS INCIDENT (not a branch finding; see the end): my throwaway cleanup
  briefly deleted `dashboard/src/routes/inbox/zz-review-null-cursor.test.tsx`,
  an untracked file that I did NOT create. It belongs to a concurrent
  reviewer, and it has since reappeared (its owner recreated it).

Throwaway evidence. All of my throwaway files were deleted; the only
untracked file of mine is this report.
- `useAutoLoad`:
  - Committed hook: passes both committed test shapes and all 3 pins (A, B,
    B').
  - Mutant with `useAutoLoad.ts:106` deleted: passes both committed test
    shapes and fails pin A (3 loads vs 2).
  - Mutant without `!enabled` at `:105`: passes both committed shapes and
    fails pins B/B' (it re-observes while disabled, and the discarded page
    is never re-issued: 1 load vs 2).
- `useInbox`:
  - The 6 proposed pins: 6/6 pass on the committed hook.
  - The COMMITTED `useInbox.test.tsx` (53 tests) passes against each of the
    mutants M05, M08, M12, M14, M19 and M30 (318 passed).
  - Each mutant fails its pin.
- `Inbox` page: the committed `Inbox.test.tsx` (51 tests) passes against a
  copy of `Inbox.tsx` with `enabled: true`. The pin (mock `useAutoLoad` and
  assert the options) passes on the committed page and fails 3 of 4 cases on
  the mutant.
- `inboxListMerge`: the committed 23 tests pass against the `filter !==
  'groups'` isAdditive mutant. The pin kills the mutant and passes on the
  committed code.
- `inboxTime`: the committed 14 tests pass against a mutant that checks the
  year before Yesterday. The pin kills the mutant and passes on the
  committed code.
- Server: `npx vitest run test/inboxFeed.test.ts -t "prefetch equivalence"`
  (from `app/`): 6 passed.

## 2. Work-map table

| Item | Rating | Code evidence | Test gaps |
|---|---|---|---|
| S1 Task 1 formatter | PARTIAL (test) | `inboxTime.ts:13-62` (4 local-day tiers, `isoOf`, `''` on unparseable input, NBSP/NNBSP -> space, full stamp) | Yesterday across a year boundary not pinned (SC-11) |
| S2 Task 2 row | PARTIAL (test, minor) | `InboxRow.tsx:63-66, :125-129`; `InboxRow.module.css:68-83` (head shrink), `:150-161` (time), `:166-184` (overlay), `:206-238` (767.98px two-row grid) | relay/group rows assert the label only, not `dateTime`/`title` (SC-12). Layout is proven only by e2e test 4 (vitest runs `css: false`). |
| S3 Task 3 store + optional auth + AuthGate | CONFORMS | `inboxListStore.ts:9-35`; `AuthContext.tsx:65-70` (additive); `AuthGate.tsx:21-23` (passive clear on anonymous) | none (`inboxListStore.test.ts`, `AuthGate.test.tsx:45-64`) |
| S4 Task 4 merge | PARTIAL (test) | `inboxListMerge.ts:54-56, :72-92, :95-138, :142-156` | "every filter" not met: no Unread branch C, no Groups branch I, no Unread row of an additive kind; an isAdditive-on-Unread mutant survives (SC-5) |
| S5 Task 5 useInbox | PARTIAL (test) | `useInbox.ts:300-306` (commitList), `:315-415` (fetchHead), `:433-466` (key effect), `:470-490` (alive, unmount save), `:496-502` (retry), `:504-547` (loadMore) | SC-3, SC-6, SC-7, SC-8, SC-9, SC-10 |
| S6 Task 6 useAutoLoad | PARTIAL (test) | `useAutoLoad.ts:78-117` (report at arrival, epoch re-observe, discard, reset on unmount) | SC-1, SC-2 |
| S7 Task 7 page | PARTIAL (test) | `Inbox.tsx:33-39` (limitFromParam), `:58-62`, `:121-143`, `:161-200`, `:222-231`, `:383-385`; `Inbox.module.css:11`; `Inbox.styles.test.ts:16-18` | page-level auto-load wiring unpinned (SC-4); sentinel `aria-hidden` unasserted (SC-12) |
| S8 Task 8 server prefetch | CONFORMS | `inbox.ts:216, :239, :793-795, :865-942, :1146, :2373-2403, :2424-2465` | none; equivalence, cache, fallback and stop tests at `inboxFeed.test.ts:2492-2570` |
| S9 Task 9 Playwright | CONFORMS | `inbox-rows-timestamps.spec.ts:132-360`: all six tests; the test-7 statement is in the header at `:31-34` | weak spots SC-4, SC-13 |
| S10 Task 10 issues | CONFORMS | reconcile issue resolved (`:6, :10, :13-22`); seen-set issue updated, with citations re-verified against the live `inbox.ts:223, :272, :562, :1393, :1578, :1612, :1654, :1715, :2711-2716` and the test names at `inboxFeed.test.ts:1469, :1489`; 4 follow-ups filed plus the deferred design | none |
| S10b Task 10b perf | CONFORMS | `collect.ts:183-190` (limit 100 on all four filters); `collect.test.ts:273, :289, :299-321, :334, :456`; `inboxDiagnostics.ts:58-73`; its test `:11-20, :37-40`; `e2e/README.md:205-213, :411` | none; the gate is S11 |

## 3. Spec rule-by-rule (code / pin / overall)

The Pin column shows how well the tests fix each rule in place: "pinned",
"e2e" (proven only by Playwright), "partial" (the pin exists but does not
discriminate), or "none". Overall is the worse of Code and Pin wherever the
spec asks for a pin.

| Rule | Code | Evidence | Pin | Overall |
|---|---|---|---|---|
| 5.1a useInbox(filter, limit, operatorId); limitFromParam honors 1..100, else 100; DEFAULT/MAX constants | CONFORMS | `useInbox.ts:59-62, :194-202`; `Inbox.tsx:33-39` | pinned (`Inbox.test.tsx:554-567`) | CONFORMS |
| 5.1b operator id via useOptionalAuth, 'anon' without a provider | CONFORMS | `Inbox.tsx:58` | pinned (`:569-576`) | CONFORMS |
| 5.1c selectFilter and the groups link keep `limit`, built from params | CONFORMS | `Inbox.tsx:121-143` | pinned (`:604-611`) | CONFORMS |
| 5.1d every getInbox call uses the hook's `limit` | CONFORMS | `useInbox.ts:321, :528` | pinned (`useInbox.test.tsx:929-938`) | CONFORMS |
| 5.2a armed in state, not persisted; epoch bumps only on head/page commits | CONFORMS | `inboxListMerge.ts:119, :136, :154`; `useInbox.ts:189-190, :410, :456` | pinned (`useInbox.test.tsx:1070-1087`) | CONFORMS |
| 5.2b sentinel: aria-hidden, after the list and before Load more, only while hasMore | CONFORMS | `Inbox.tsx:383-385` | pinned (presence); aria-hidden none | CONFORMS |
| 5.2c ONE observer per sentinel mount; root resolved once; 400px | PARTIAL (NOTE) | `useAutoLoad.ts:32, :78-96`; `Inbox.tsx:161-169` | pinned (`useAutoLoad.test.tsx:52-60`) | PARTIAL (SC-14) |
| 5.2d report consumed at arrival: fire while enabled, discard while disabled | CONFORMS | `useAutoLoad.ts:112-117` | pinned (`:68-75, :112-123`) | CONFORMS |
| 5.2e re-observe when enabled and the epoch moved since last handled | CONFORMS | `useAutoLoad.ts:104-109` | partial | PARTIAL (SC-1, SC-2) |
| 5.2f `enabled` alone neither re-observes nor fires | CONFORMS | `useAutoLoad.ts:105-106` | partial (mount epoch only) | PARTIAL (SC-1) |
| 5.2g discard unconsumed reports before re-observing | CONFORMS | `useAutoLoad.ts:107` | pinned (`:133-142`) | CONFORMS |
| 5.2h intersecting reset when the sentinel unmounts | CONFORMS | `useAutoLoad.ts:79-82, :94` | pinned (`:145-158`; the seq design is the load-bearing half) | CONFORMS |
| 5.2i enabled = hasMore && autoLoadArmed && !loadingMore | CONFORMS | `Inbox.tsx:197` | none at unit level; e2e cannot discriminate | CONFORMS (pin gap SC-4) |
| 5.2j overflow-anchor: none on the page root | CONFORMS | `Inbox.module.css:11` | pinned (`Inbox.styles.test.ts:16-18`) + e2e 6 | CONFORMS |
| 5.2k arming rule (C: P>0; I: unchanged unless empty; append: new rows; failure: unchanged) | CONFORMS | `inboxListMerge.ts:118, :135, :153`; `useInbox.ts:536-538` | pinned (merge tests, `useInbox.test.tsx:1051-1068`) | CONFORMS |
| 5.2l consequences "each pinned by unit tests" | CONFORMS | as above | partial (failed-page and discarded-page shapes) | PARTIAL (SC-1, SC-2) |
| 5.2m jsdom installs nothing; injectable factory | CONFORMS | `useAutoLoad.ts:41, :66, :84` | pinned (`:160-169`) | CONFORMS |
| 5.3a four tiers by LOCAL calendar day | CONFORMS | `inboxTime.ts:24-47` | partial | PARTIAL (SC-11) |
| 5.3b formatter options | CONFORMS | `inboxTime.ts:37, :42, :45` | pinned | CONFORMS |
| 5.3c unparseable -> '' and no `<time>` | CONFORMS | `inboxTime.ts:35, :52`; `InboxRow.tsx:125` | pinned | CONFORMS |
| 5.3d formatInboxTimeFull | CONFORMS | `inboxTime.ts:50-62` | pinned | CONFORMS |
| 5.3e isoOf applied | CONFORMS | `inboxTime.ts:16` | pinned (`inboxTime.test.ts:54-56`) | CONFORMS |
| 5.3f U+202F / U+00A0 -> U+0020 | CONFORMS | `inboxTime.ts:13, :20-22` | pinned (`inboxTime.test.ts:86-96`) | CONFORMS |
| 5.4a `<time>` with dateTime and title, inside the Link, after the count | CONFORMS | `InboxRow.tsx:125-129` | pinned (contact row) | CONFORMS |
| 5.4b desktop time column; unread dark semibold, read muted | CONFORMS | `InboxRow.module.css:150-161` | e2e 4 | CONFORMS |
| 5.4c head shrink: 45% cap, name ellipsis, chips nowrap | CONFORMS | `InboxRow.module.css:68-83, :87-110` | e2e 4 | CONFORMS |
| 5.4d actions overlay, no layout width | CONFORMS | `InboxRow.module.css:163-184` | names pinned; layout e2e | CONFORMS |
| 5.4e 767.98px two-row grid, head max-width none, one `<time>` | CONFORMS | `InboxRow.module.css:204-238` | e2e 4 | CONFORMS |
| 5.4f `now` taken at render | CONFORMS | `InboxRow.tsx:65` | pinned | CONFORMS |
| 5.5a ListState; base = head ++ tail feeds serverRowCount and the narrowing | CONFORMS | `inboxListMerge.ts:17-25, :50-52`; `useInbox.ts:713-727` | pinned | CONFORMS |
| 5.5b commitList is the only writer; saves when alive && ready under keyRef | CONFORMS | `useInbox.ts:300-306` (the only `setList`) | pinned (`:973-985, :987-999`) | CONFORMS |
| 5.5c pendingRef mirrored synchronously | CONFORMS | `useInbox.ts:566-585` | pinned (`:1034-1049`) | CONFORMS |
| 5.5d aliveRef true in the effect body, false in cleanup; loadMore aborted; no post-unmount commit | CONFORMS | `useInbox.ts:470-476, :530, :660, :702` | pinned for loadMore; markUnread none | CONFORMS (SC-9) |
| 5.5e reset: `loading` BEFORE the empty commit | CONFORMS | `useInbox.ts:448-461` | pinned (`:987-999`) | CONFORMS |
| 5.5f loadMore dedupe/cursor/epoch/arm, two staleness guards | CONFORMS | `inboxListMerge.ts:142-156`; `useInbox.ts:519, :527, :530` | pinned (`:1051-1068, :158-245`) | CONFORMS |
| 5.5g dedupeConversations after every merge and append | CONFORMS | `inboxListMerge.ts:72-92, :111, :128, :146` | pinned (`inboxListMerge.test.ts:179-224`) | CONFORMS |
| 5.5h head reads request `limit` | CONFORMS | `useInbox.ts:321` | pinned | CONFORMS |
| 5.6a additive / pagedP / headComplete | CONFORMS | `inboxListMerge.ts:54-56, :105-106` | partial ("every filter") | PARTIAL (SC-5) |
| 5.6b branch C | CONFORMS | `inboxListMerge.ts:110-121` | pinned (all/groups/unknown) | CONFORMS |
| 5.6c branch I | CONFORMS | `inboxListMerge.ts:123-137` | pinned (all/unread/unknown) | CONFORMS |
| 5.7a refreshFailed in state | CONFORMS | `useInbox.ts:125-126, :210` | pinned | CONFORMS |
| 5.7b "rows rendered" read through refs at settle | CONFORMS | `useInbox.ts:395, :499` | pinned | CONFORMS |
| 5.7c failure with rows -> banner (404 included); without rows -> error/pending | CONFORMS | `useInbox.ts:388-413` | pinned (`:1089-1104, :1112-1158, :1188-1193`) | CONFORMS |
| 5.7d incomplete success never shows the banner | CONFORMS | `useInbox.ts:363` | pinned (`:1175-1186`) | CONFORMS |
| 5.7e cleared by a committed head read AND by the reset | CONFORMS | `useInbox.ts:363, :459` | commit pinned; reset none | PARTIAL (SC-7) |
| 5.7f retry(): no spinner with rows; a failing retry stays ready | CONFORMS | `useInbox.ts:496-502` | pinned (`:1098-1103, :1160-1172`) | CONFORMS |
| 5.7g banner: role=status, exact copy, "Retry refresh", above the notices | CONFORMS | `Inbox.tsx:222-231` | pinned (`Inbox.test.tsx:578-592`) + e2e 5 | CONFORMS |
| 5.7h banner leaves Load more alone; loadMore failures stay silent | CONFORMS | `useInbox.ts:536-538`; `Inbox.tsx:414-423` | pinned | CONFORMS |
| 5.7i issue set to resolved | CONFORMS | `docs/issues/inbox-reconcile-failure-blanks-list.md:6, :10, :13-22` | n/a | CONFORMS |
| 5.8a store key, snapshot shape, save/load/clear | CONFORMS | `inboxListStore.ts:9-35` | pinned | CONFORMS |
| 5.8b clear from a PASSIVE AuthGate effect | CONFORMS | `AuthGate.tsx:21-23` | pinned (`AuthGate.test.tsx:45-64`) | CONFORMS |
| 5.8c save only from commitList (alive && ready) and the unmount save (ready only) | CONFORMS | `useInbox.ts:303-305, :483` | unmount ready gate: none | PARTIAL (SC-3) |
| 5.8d unmount save in a layout cleanup with pendingRef, scrollTopRef, the listener, the POP seed | CONFORMS | `useInbox.ts:248, :481-494`; `Inbox.tsx:171-177` | pinned (`:1034-1049, :1206-1216`) + e2e 3 | CONFORMS |
| 5.8e lazy restore: ready on the first render; restoredKeyRef | CONFORMS | `useInbox.ts:203-209, :242` | pinned (`:940-960`) | CONFORMS |
| 5.8f the filter-effect rule, which sets restoredKeyRef in both branches | CONFORMS | `useInbox.ts:448-464` | update: none | PARTIAL (SC-6) |
| 5.8g the return: unarmed; C replaces and arms; I merges | CONFORMS | `useInbox.ts:189`; `inboxListMerge.ts:118, :135` | pinned (`:940-971`) | CONFORMS |
| 5.8h scroll: POP -> saved value; any other store-backed mount -> explicit 0 | CONFORMS | `Inbox.tsx:184-192` | pinned (`Inbox.test.tsx:613-646`) + e2e 3 | CONFORMS |
| 5.8i in-app "Back to inbox" stays PUSH; nothing outside the Inbox changes | CONFORMS | no navigation file is in the diff | n/a | CONFORMS |
| 5.8j another filter or limit loads fresh; the other key is kept | CONFORMS | store Map; `useInbox.ts:448` | pinned (`:987-999`) | CONFORMS |
| 5.8k stale count for one round trip (accepted) | CONFORMS | by design | n/a | CONFORMS |
| 5.9 group/relay rows get the time; paging unchanged | CONFORMS | `InboxRow.tsx:65-66`; server merge untouched | pinned (label) | CONFORMS |
| 5.10a decision loop byte-identical | CONFORMS | `git diff -w`: only `inbox.ts:2420-2425, :2436-2440, :2444` (comment dash), `:2463-2465` | pinned (`inboxFeed.test.ts:2492-2512`) | CONFORMS |
| 5.10b three promise caches; rejections never cached | CONFORMS | `inbox.ts:793-795, :865-891, :897-923, :928-942` | pinned (`:2514-2543`) | CONFORMS |
| 5.10c prefetch window of 8 with a stop flag | CONFORMS | `inbox.ts:239, :2373-2403, :2424, :2440, :2464` | pinned (`:2545-2569`) | CONFORMS |
| 5.10d telemetry: assembled line identical | CONFORMS | `inbox.ts:2602-2623` untouched | pinned | CONFORMS |
| 5.10e unread/unknown branches not restructured; they share the caches | CONFORMS | only cache reads changed (`inbox.ts:1037, :1448, :1552, :1651`) | existing suites | CONFORMS |
| 5.10f route tests | CONFORMS | `inboxFeed.test.ts:2418-2570` | pinned | CONFORMS |
| 5.11a classifier 30 -> 100 | CONFORMS | `collect.ts:183-190` | pinned (`collect.test.ts:299-321`) | CONFORMS |
| 5.11b profiler plan -> 100 | CONFORMS | `inboxDiagnostics.ts:69-73` | pinned | CONFORMS |
| 5.11c hermetic perf self-QA gate | not assessed | S11 (not to be run here) | - | - |

| Invariant | Code | Pin | Overall |
|---|---|---|---|
| 1 complete head replaces; incomplete removes nothing; no scroll reset | CONFORMS (`inboxListMerge.ts:110-137`; no live-update path writes scrollTop; the restore is latched once, `Inbox.tsx:186-187`) | pinned + e2e 2 | CONFORMS |
| 2 back restores instantly, then ONE head read; no cursor request before it | CONFORMS (`useInbox.ts:189, :448-464`; `Inbox.tsx:197`) | unit: one live head read, unarmed; page wiring none; e2e 3 does not discriminate | PARTIAL (SC-4) |
| 3 never fire on an empty page, during loadingMore, without hasMore, on a failed page; no chaining | CONFORMS (`useAutoLoad.ts:104-117`; `Inbox.tsx:197`; `Inbox.module.css:11`) | failed-page and discarded-page pins do not discriminate | PARTIAL (SC-1, SC-2) |
| 4 a failed head read never blanks rows; a failed Retry stays ready; an incomplete read is no failure | CONFORMS (`useInbox.ts:388-399, :496-502`) | pinned, including the worklist item-1 interleaving | CONFORMS |
| 5 a failed initial load keeps the existing error surface | CONFORMS (`useInbox.ts:413`; `Inbox.tsx:341-348`) | pinned | CONFORMS |
| 6 narrowing and notices keep server-quantity gates; the store holds server-shaped rows | CONFORMS (`useInbox.ts:166-179, :713-727`) | pinned (existing composed cases) | CONFORMS |
| 7 sign-out clears; saves only under the right key; none before the first commit or from a reset; none after unmount | CONFORMS (`AuthGate.tsx:21-23`; `useInbox.ts:303, :446, :483`) | the unmount ready gate is unpinned | PARTIAL (SC-3) |
| 8 never two kinds for one conversation | CONFORMS (`inboxListMerge.ts:72-92`) | pinned | CONFORMS |
| 9 server page identical with and without prefetch | CONFORMS | pinned | CONFORMS |
| 10 perf harness: one page request per sample, no cursor | CONFORMS in code (`collect.ts:183-190`) | gate pending (S11) | CONFORMS (gate pending) |

## 4. Test contract (7.1-7.3) gaps, ranked

1. SC-1 (7.1 useAutoLoad "does not fire when only enabled changes (the
   failed-page case)"; spec 5.2 "each pinned by unit tests"; invariant 3).
   The pin works only at the mount epoch.
2. SC-2 (7.1 / 5.2: a discarded page is re-issued once). The committed shape
   moves the epoch and `enabled` in one render.
3. SC-3 (7.1 "saves happen only ... while ready"; invariant 7). Nothing pins
   the unmount save's ready gate.
4. SC-4 (7.3 test 3 and invariant 2). No unit pin covers the page's
   `useAutoLoad` options, and e2e test 3 cannot discriminate the
   `autoLoadArmed` term.
5. SC-5 (7.1 merge "on every filter"). Neither Unread branch C nor Groups
   branch I is tested, and the isAdditive-on-Unread mutant survives.
6. SC-6 (5.8 filter-effect rule). The `restoredKeyRef` update is unpinned.
7. SC-7 (7.1 "refreshFailed set and cleared per 5.7"). The reset's clear is
   unpinned.
8. SC-8 (the key effect's `setLoadingMore(false)`). It is unpinned, and
   deleting it strands Load more.
9. SC-9 (section 6 writers). `markUnread` has no hook-level test.
10. SC-10 (pre-existing). The success-path generation-guard test is too weak.
11. SC-11 (7.1 "Dec 31 vs Jan 1 across a year"). Yesterday across a year
    boundary is not pinned.
12. SC-12 and SC-13: minor unit and e2e assertions that are unasserted or
    weakened.

What is present and sufficient:
- 7.1: `inboxListStore.test.ts`, `AuthGate.test.tsx`, `Inbox.styles.test.ts`,
  the `limitFromParam` table, banner, sentinel presence, POP/PUSH scroll,
  the limit-preserving links.
- 7.1 `useInbox` additions: every item named, except the pins above.
- 7.2: all four named tests (equivalence including the throwing phone,
  one-read-for-two-misses via call-count parity, degraded-fallback
  memoization, the stop flag).
- 7.3: all six tests plus the header statement for test 7.

The e2e spec deviates from the plan in six places (slice G). All were
checked, and each is conformant or a strengthening. The `afterEach` reseed
(worklist 27) is an accepted deviation from "mark read before the test ends".

## 5. Constraints check

- Excluded files (spec 4.2). `git diff --name-only cd8e8ddd...HEAD`
  touches none of them. PASS.
- Hub files. `dashboard/src/api/types.ts`, `client.ts` and `endpoints.ts`
  have a 0-line diff. PASS.
- Message catalog. No catalog file is touched; the banner copy is inline, as
  the spec says. PASS.
- Wire shape. `InboxRow`/`InboxPage` are unchanged: `types.ts` is untouched,
  and the server's row literals are outside the `-w` diff. PASS.
- ASCII.
  - The added lines of all 35 code/issue/e2e/README files carry 0 non-ASCII
    bytes (full scan). PASS.
  - The records are clean except one line, `plan-r1-reviewer-b.md:203`,
    which quotes an existing describe title with a U+2014 (3 bytes; NOTE,
    SC-18).
- Co-Authored-By. 32 of 32 commits carry exactly one trailer: 19 "Claude
  Opus 5.5 (1M context)" and 13 "Claude Fable 5.1". PASS.

## 6. Traced paths

### (a) POP return

1. `Inbox.tsx:59` (navigation type 'POP') -> `:62`
   `useInbox(filter, limit, operatorId, true)`.
2. Lazy init at `useInbox.ts:203-209`: `loadInboxList(key)` hits
   (`inboxListStore.ts:29-31`), so status is 'ready' and the list comes from
   `listFromSnapshot` (`useInbox.ts:181-192`: autoLoadArmed false,
   pageEpoch 0). `:242` sets restoredKeyRef = key; `:248` seeds scrollTopRef
   with `snapshot.scrollTop`.
3. Render 1 shows the rows (`Inbox.tsx:364-376`), plus the sentinel if the
   snapshot has a cursor (`:383-385`).
   - Layout phase: `:161-169` resolves `main.content` and calls
     `setScrollRoot`, which forces a synchronous re-render before paint.
   - In that re-render, `:184-192` applies `scrollTop = restoredScrollTop`
     and calls `noteScrollTop`.
4. Passive effects are flushed before that synchronous render. The key
   effect (`useInbox.ts:433-466`) sees key == restoredKeyRef, so it skips
   the reset; `:464` fetchHead -> `:321` `getInbox({ filter, limit })`, with
   no cursor.
   - Under StrictMode (the e2e harness), the cleanup at `:465` aborts that
     read, and the simulated unmount save (`:481-490`) writes the restored
     list with the SEEDED scrollTop.
   - The replay then issues the one live head read.
5. `useAutoLoad.ts:78-96` creates the observer (root main, 400px margin)
   once both the sentinel and the root are set. Its initial report is
   consumed at `:112-117` while the hook is disabled (`Inbox.tsx:197`,
   armed false), so it is discarded. No cursor request is issued.
6. When the head read lands, fetchHead runs these checks and steps:
   - `useInbox.ts:322` not aborted;
   - `:342` gen guard;
   - `:355` filter;
   - `:358` alive;
   - `:359` firstPageGen++;
   - `:361` status 'ready';
   - `:363` clear the banner;
   - `:364` `commitList(mergeHeadRead(...))`.
7. `inboxListMerge.ts:105-121` takes branch C (complete): head = P, tail
   [], cursor C, armed if P is non-empty, epoch 0 -> 1. `useInbox.ts:303-305`
   saves.
8. `useAutoLoad.ts:104-109`: enabled, and epoch 1 != handled 0, so it
   discards unconsumed reports and re-observes. The fresh report runs
   `:116` `onLoad` -> `useInbox.ts:504` loadMore -> `:528` `getInbox({...,
   cursor })`, but only if the sentinel is still within 400px (the
   operator's position was past page one and the scroll clamped).

Surprises:
- (i) An INCOMPLETE mount reconcile leaves the restored list UNARMED until a
  complete head read or a manual Load more (`inboxListMerge.ts:135`). This
  is spec-conformant (SC-15).
- (ii) A mark-read committed on the restored list before the reconcile
  lands makes `:342` discard the reconcile. The list stays restored and
  unarmed until the mark-read's own SSE reconcile, about 300 ms later
  (bounded).
- (iii) The restored list's Load more button is live before the reconcile.
  A click sends the OLD cursor, and `:527` drops that page when the head
  read commits. This is operator-initiated, so it is allowed.
- (iv) The StrictMode simulated unmount save runs BEFORE the scroll
  restore. It is correct only because of the POP seed at `:248`.

### (b) Failed SSE reconcile with rows rendered

1. `useInbox.ts:563` -> `:553-559` (300 ms debounce) -> `:315` fetchHead ->
   `:321` rejects.
2. The catch at `:365`: the request was not aborted, and `:388` finds the
   filter still current. There is deliberately NO generation check
   (worklist item 1). `:395` sees rows rendered (statusRef 'ready' and base
   non-empty), so `:397` calls `setRefreshFailed(true)` and returns.
   - Status stays 'ready' and the list is untouched.
   - A 404 takes the same arm, because `:396` runs before the 404 arm at
     `:400`.
3. `Inbox.tsx:224-231` renders the banner: role=status, "Couldn't refresh
   the inbox.", button "Retry refresh". It sits below the tabs and above the
   notices; Load more is unaffected.
4. The click runs `Inbox.tsx:227` retry -> `useInbox.ts:496-502`. Rows are
   rendered, so there is no `applyStatus('loading')`; fetchHead runs
   directly.
   - On success, `:361-364` sets ready, clears the banner and merges.
   - On failure, `:397` keeps the banner and the status stays ready.
   - No spinner appears on any branch.

Surprise: a Retry refresh whose read started before a mark-read commit is
discarded at `:342`, even though it succeeded. The banner stays up until the
mark-read's SSE reconcile commits, about 300 ms later (SC-17, bounded).

### (c) Server filter=all, prefetch on vs off

1. The pager at `inbox.ts:2405` starts a prefetch for each chunk
   (`:2424`, `startPrefetch(chunk.items)`) unless `deps.inboxPrefetch ===
   false` (`:216`).
2. `:2425-2465` wraps the loop in try/finally. Inside it, the loop is
   unchanged:
   - `:2428` rowForConversation -> `:1146` resolveContact
     (`:897-923`) -> `:1211` contactConversations (`:865-891`) ->
     latestMessageOf (`:968-971`) -> latestRaw (`:928-942`);
   - page fill at `:2434-2460`, including the `:2440` stop, the boundary
     Query at `:2450-2457` and the cursor at `:2459`;
   - `finally` at `:2464` stops the prefetch.
3. `git diff -w cd8e8ddd...HEAD -- app/src/routes/inbox.ts` shows only
   these changes inside the pager:
   - the prefetch start and the `try`;
   - the page-full `stop()` and its comment;
   - one comment's dash (`:2444`);
   - the `finally`.
4. No decision, count (`drops`, `rawQueries`, `rawScanned`), cursor or log
   line changed. The assembled line at `:2602-2623` is untouched.
5. Both arms read through the memoized `resolveContact` and `latestRaw`, so
   the equivalence tests compare like with like. The existing `filter=all`
   suites are the net for cache-key bugs (worklist 13).

Surprises:
- (i) Memoizing the degraded fallback differs from MAIN (not from the off
  arm) under a transient lookup failure, when two open conversations share
  one (phone, email) pair (SC-16; the spec mandates it).
- (ii) Workers also stop between the steps of a chain (`:2383, :2386`).
  This is stricter than "chains in flight finish" and wastes fewer reads.
- (iii) Chains still in flight outlive the response, so their WARN lines
  can follow the assembled line.

## 7. Findings

SC-1 SHOULD-FIX (test)
- Where: `dashboard/src/routes/inbox/useAutoLoad.test.tsx:68-75`; hook line
  `useAutoLoad.ts:106`.
- Spec: 5.2 says a FAILED loadMore does not retry until the sentinel leaves
  and re-enters the margin or the operator clicks, "each pinned by unit
  tests"; invariant 3.
- Code: correct.
- Test: the failed-page shape enables only at the mount epoch, where
  deleting `:106` changes nothing. Reproduced: a copy of the hook without
  `:106` passes the committed shape and then auto-retries a failed page (3
  loads vs 2).
- Fix: add a test that enables at epoch 1 and fires, disables, enables at
  epoch 2 (fires), disables, then enables again at epoch 2 with the sentinel
  in view. Expect no new load and no re-observe.

SC-2 SHOULD-FIX (test)
- Where: `useAutoLoad.test.tsx:94-110`; hook `useAutoLoad.ts:105`.
- Spec: 5.2 says a head read that discarded an in-flight loadMore bumps the
  epoch, and the page is re-issued once if the sentinel is still in the
  margin. The epoch moves WHILE loadingMore is true.
- Code: correct.
- Test: the test moves the epoch and `enabled` in one render. Reproduced: a
  copy without `!enabled` passes it, re-observes while disabled, and never
  re-issues the page (1 load vs 2).
- Fix: rerender (disabled, epoch 2) and expect 0 re-observes; then
  (enabled, epoch 2) and expect 1 re-observe and 1 load.

SC-3 SHOULD-FIX (test)
- Where: `dashboard/src/routes/inbox/useInbox.ts:483`. The only StrictMode
  and unmount tests are store HITS (`useInbox.test.tsx:940-960, :1206-1216`).
- Spec: 5.8 "an empty pre-first-page snapshot is never written";
  invariant 7; 7.1 "saves ... only while ready".
- Code: correct.
- Test: reproduced: the committed suite (53) passes without `:483`. That
  copy saves an empty snapshot, which the next mount would restore as a
  'ready' empty list.
- Fix: a StrictMode store miss with a hanging getInbox, then unmount;
  expect `loadInboxList(key)` to be undefined.

SC-4 SHOULD-FIX (test)
- Where: `dashboard/src/routes/inbox/Inbox.tsx:194-200`;
  `e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts:198-257`.
- Spec: 5.2 `enabled = hasMore && autoLoadArmed && !loadingMore`;
  invariant 2 "no cursor request precedes that head read"; 7.3 test 3.
- Code: correct.
- Unit tests: `Inbox.test.tsx` mocks `useInbox` and never observes the
  options passed to `useAutoLoad`, and jsdom has no IntersectionObserver.
  Reproduced: all 51 committed page tests pass against `enabled: true`.
  Slice D reports that `epoch: 0` and a no-op `onLoad` survive the same way.
- E2E: test 3 cannot catch `enabled: true`.
  - Part 1 runs at limit=10, where the cursor is null and there is no
    sentinel.
  - The Option B part restores a list whose chain had already finished
    (cursor null).
  - So "a head read FIRST" holds whatever the arming gate does.
- Fix: in `Inbox.test.tsx`, `vi.mock('./useAutoLoad.js')` and assert
  `enabled`, `epoch` and `onLoad` over the (hasMore, autoLoadArmed,
  loadingMore) combinations. Optionally, add an e2e return with a LIVE
  cursor and the sentinel in view: test 6's world after one scroll (32
  rows, cursor live), open the last contact row, go back, and assert that
  the first finished request is a head read.

SC-5 SHOULD-FIX (test)
- Where: `dashboard/src/routes/inbox/inboxListMerge.test.ts:68-177`; code
  `inboxListMerge.ts:54-56`.
- Spec: 7.1 "branch C on every filter ... Branch I on every filter".
- Code: correct.
- Test: there is no Unread branch C case, no Groups branch I case, and no
  Unread case with a relay or group row. Reproduced: `filter !== 'groups'`
  in isAdditive passes all 23 tests. On Unread, where group rows count
  toward `limit`, that mutant would classify full pages as incomplete and
  never drop stale rows.
- Fix: add an Unread case with one contact and one group_text at limit 2,
  with a cursor. Expect branch C: tail emptied, cursor replaced.

SC-6 SHOULD-FIX (test)
- Where: `useInbox.ts:463`.
- Spec: 5.8 "In both cases it then sets restoredKeyRef.current = key".
- Code: correct.
- Test: reproduced: the committed suite passes without `:463`. After
  restoring All, switching to Unread and back, that copy skips the reset and
  shows the Unread rows as 'ready' on the All tab.
- Fix: restore All, switch to Unread (the page commits), then switch back
  with a hanging read. Expect 'loading' and no Unread rows.

SC-7 SHOULD-FIX (test, low risk)
- Where: `useInbox.ts:459`.
- Spec: 5.7 "A filter or limit change clears it with the rest of the
  reset"; 7.1.
- Code: correct.
- Test: reproduced: the committed suite passes without `:459`. The effect
  is latent today: the banner is gated on 'ready', and every path back to
  'ready' clears the flag at `:363`.
- Fix: raise the banner, switch the filter with a hanging read, and expect
  `refreshFailed` false.

SC-8 SHOULD-FIX (test)
- Where: `useInbox.ts:462`. `useInbox.test.tsx:158-190` never asserts
  `loadingMore`.
- Spec: 5.5 says loadMore keeps its two staleness guards; the filter guard
  relies on the effect resetting the flag (`useInbox.ts:520-526`). Per 5.2,
  `enabled` needs `!loadingMore`.
- Code: correct.
- Test: reproduced: the committed suite passes without `:462`. That copy
  leaves `loadingMore` true on the new tab forever, so Load more and
  auto-load are both dead there.
- Fix: in the `:158` test, assert `loadingMore` is 'false' after the switch
  and after releasing the stale page.

SC-9 SHOULD-FIX (test)
- Where: `useInbox.ts:699-707`. The Probe has `unread:` buttons
  (`useInbox.test.tsx:98`), but no test clicks them.
- Spec: section 6 names markUnread's commit as a `commitList` writer; 5.5
  sets the alive gate.
- Code: correct.
- Test: reproduced: the committed suite passes with `:702` deleted. The row
  then flips back to read once the POST settles, and nothing is saved.
- Fix: click `unread:<key>` and let it settle. Expect unread 1 in the render
  and in the store. Add a post-unmount settle that saves nothing.

SC-10 NOTE (test, pre-existing)
- Where: `useInbox.ts:342`; `useInbox.test.tsx:332-354`.
- Test: the test asserts through `waitFor` right after releasing the stale
  page, and that assertion passes before the stale page commits.
  Reproduced: the suite passes without `:342`. Releasing inside an async
  `act`, waiting 50 ms and then asserting kills the mutant. `main` has the
  same test shape.
- Fix: as slice C proposed.

SC-11 NOTE (test)
- Where: `dashboard/src/routes/inbox/inboxTime.test.ts:29-32` (now = Sep 25);
  code `inboxTime.ts:39-41`.
- Spec: 7.1 "Dec 31 vs Jan 1 across a year".
- Code: correct.
- Test: reproduced: the 14 committed tests pass against a copy that checks
  the year before Yesterday.
- Fix: now = Jan 1 00:30. Expect Dec 31 23:59 -> "Yesterday" and Jan 1
  00:01 -> "12:01 AM".

SC-12 NOTE (unit tests, minor)
- `InboxRow.test.tsx:228-256`: the relay and group rows assert the label
  only, not `dateTime`/`title`.
- The sentinel's `aria-hidden` (`Inbox.tsx:384`) is not asserted
  (`Inbox.test.tsx:594-602`).
- `Inbox.test.tsx` does not call `clearInboxLists()` in `beforeEach`, as
  7.1 says literally. This is harmless, because the hook is mocked there.

SC-13 NOTE (e2e, minor)
- Test 3 checks "the same rows" by count only (`spec.ts:229, :237`).
- Test 2 does not assert that the new row is at the top after the limit=2
  inbound (`:179-183`).
- Test 4 checks the time box's x-bounds and bottom, but not its top edge
  (`:283-296`).

SC-14 NOTE (code)
- Spec: 5.2 "ONE IntersectionObserver per mount of the sentinel ... root
  resolved once at mount".
- Code: the root is resolved on the first render with rows
  (`Inbox.tsx:161-169`), and the observer effect is keyed on `root`
  (`useAutoLoad.ts:96`). When page one is empty but carries a cursor (the
  Unknown budget exit), the sentinel mounts against a viewport-rooted
  observer, and a second observer is created when rows arrive.
- Impact: harmless today. That state is disarmed, and at most one load
  follows the manual click.
- Fix: none required. Optionally, resolve the container from the page root
  or the sentinel.

SC-15 NOTE (spec residual, for the handback)
- A POP restore whose mount reconcile is INCOMPLETE stays unarmed
  (`inboxListMerge.ts:135`) until a complete head read or a manual Load
  more. This conforms to 5.2's arming rule; the Unread and Unknown returns
  can hit it.

SC-16 NOTE (a spec-mandated change vs main)
- `inbox.ts:897-923` memoizes the degraded contact fallback per (phone,
  email) pair.
- Effect: a TRANSIENT lookup failure now degrades every conversation that
  shares the pair for the rest of the request, where main re-read per
  conversation. For example, one participant on two pool numbers becomes an
  unknown row for that request. The next reconcile re-reads.

SC-17 NOTE
- A successful Retry refresh whose read started before a mark-read commit
  is discarded at `useInbox.ts:342`. The banner stays up until the
  mark-read's own SSE reconcile, about 300 ms later.

SC-18 NOTE (docs and records)
- `plan-r1-reviewer-b.md:203` carries a U+2014 (a byte-exact quote of an
  existing describe title).
- The plan's Global Constraints bullet (`plan.md:49-53`) still describes the
  superseded `[intersecting, enabled, epoch]` model; Task 6 and the code
  follow spec 5.2.
- Stale text already reported by slices D and F:
  - `Inbox.test.tsx:543` cites `Inbox.tsx:42`;
  - `inboxFeed.test.ts:1448` calls 30 "the dashboard's page size";
  - the `useInbox.ts` fingerprints in `e2e/performance/routes.ts`;
  - `thread-hooks-refetch-whole-page-per-event.md:124`.
- None of this blocks the branch.

SC-19 NOTE (e2e gate)
- Slice G found that `group-text-inbox.spec.ts:33` passes only on residue
  from earlier specs; it fails deterministically right after a reseed.
- This is pre-existing and not caused by this branch. File an issue before
  trusting a reordered suite.

## Process note

- What happened: I deleted my first batch of throwaway files with one glob,
  `rm -f dashboard/src/routes/inbox/zz-review-*`. The glob also removed
  `zz-review-null-cursor.test.tsx`, an untracked file that I did not
  create. That batch was 28 files of mine; the glob matched 29. I deleted
  the later SC-4 batch (4 files) by exact name.
- Consequence: the file had reappeared by the time this report was written,
  so its owner recreated it. A run the owner made during that gap could have
  seen it missing; the owner should confirm that its evidence is intact.
- Possible confusion the other way: my throwaways (mutants built to fail)
  existed under the same prefix for roughly 20 minutes. Any prefix-filtered
  run by another agent in that window may have picked them up.
- Current state: nothing else was touched. Three other untracked
  `zz-review-*` files belong to other agents and were left alone:
  `app/test/zz-review-prefetch-readahead.test.ts`,
  `dashboard/src/app/zz-review-cleanup-order.test.tsx`, and the re-created
  `zz-review-null-cursor.test.tsx`. My only untracked file is this report.
  No e2e artifact, server or process was touched.
