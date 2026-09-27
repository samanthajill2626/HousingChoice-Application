# Planner review - spec conformance (inbox rows + timestamps)

Reviewer: independent spec-conformance reviewer for the planner, 2026-09-26.
Branch `feat/inbox-rows-timestamps`, worktree `W:\tmp\inbox-rows-timestamps`,
tip 967ef4ab (b242b7d6 + the handback record only; `git diff --stat
b242b7d6 HEAD` touches handback.md alone). `main` = merge base = da04d0cb;
the branch is 0 behind, 59 ahead; one merge of main (887f0685). Working tree
clean at review time. Read-only: no npm, no tests, no servers, no git state
changes. Spec: DRAFT 8.5. Diff under review: `git diff main...HEAD`.

Verdict key: DELIVERED (cited), DEVIATED (what differs; amended or not;
sound or not), MISSING.

## 1. Gate verification (handback section "Gates on b242b7d6")

Every claim below was read from the named log; quotes are verbatim.

| Gate | Handback claim | Evidence found | Status |
|---|---|---|---|
| 1 typecheck | EXIT=0 | `.superpowers/sdd/final2-typecheck.exit`: "typecheck EXIT=0"; log shows all five workspaces' tsc with no error output. File time 23:48 local, after b242b7d6 (23:47:41). | VERIFIED (commit inferred from timestamp) |
| 2 npm test | EXIT=0; app 369/6934/1 skipped; dashboard 199/3303; e2e-unit 21/499; fake-twilio 34/245; web 13/111; zero `[dynamoAdmin]` | `final2-test.done`: "EXIT=0 at 2026-09-26T03:52:51Z on b242b7d6". `final2-test.log`:2183-2184 "Test Files 369 passed (369)" / "Tests 6934 passed / 1 skipped (6935)"; :5483-5484 "199 passed" / "3303 passed"; :5541-5542 "21 passed" / "499 passed"; :5588-5589 "34 passed" / "245 passed"; tail "13 passed" / "111 passed". `grep -c "[dynamoAdmin]"` = 0. | VERIFIED |
| 3 smoke | EXIT=0; 1413 specifiers / 248 files | `final2-smoke.exit`: "smoke EXIT=0"; log: "smoke-dist: OK - 1413 import specifier(s) across 248 emitted file(s) resolve under plain Node." | VERIFIED (commit inferred from timestamp) |
| 4 e2e run 1 | dc0390e4: EXIT=1, 283 passed, 1 failed (21.5 m), relay-number-lifecycle.spec.ts:307 | `final-e2e.done`: "EXIT=1 at 2026-09-26T03:30:22Z on dc0390e4"; `final-e2e.log`:84498-84500 "1 failed ... relay-number-lifecycle.spec.ts:307:1 ... late text" / "283 passed (21.5m)". | VERIFIED |
| 4 isolation re-run | "Re-run ALONE on a fresh lane at HEAD: 6 passed (48.0 s)" | `isolation-relay-run1.log`: "6 passed (48.0s)" BUT also "[playwright] reusing the live e2e:session on lane 16" - not a fresh lane; file time 23:32, when HEAD was dc0390e4 (d9339c08 committed 23:47). | PARTLY VERIFIED (result true; "fresh lane at HEAD" is not) |
| 4 e2e run 2 | b242b7d6: EXIT=0, 284 passed (23.0 m) | `final2-e2e.done`: "EXIT=0 at 2026-09-26T04:18:50Z on b242b7d6"; `final2-e2e.log`:83567 "284 passed (23.0m)"; header "Running 284 tests using 1 worker"; this branch's six tests at :11840-12979 all "ok". | VERIFIED |
| 5 eslint | 27 files; EXIT=1 with 2 pre-existing errors; baseline shows the same pair | `final2-eslint.files`: 27 paths; `final2-eslint.exit`: "eslint EXIT=1"; log: collect.test.ts 1218:36 'mode' / 1218:42 'repeat' no-unused-vars, "2 problems (2 errors, 0 warnings)"; `final2-eslint-baseline.log`: same two at 1204:36/1204:42 in main's file, "baseline e2e/performance/collect.test.ts rc=1", every other baseline rc=0. | VERIFIED - PASS by baseline |
| 6 perf:pages | hermetic --self-qa=full; EXIT=0; selfQa pass; 62 samples; three inbox flags true; profiler commit b242b7d6 | `final2-perf.exit`: "perf EXIT=0"; `final2-perf.log`: "performance_report=20260926T035508618Z-8b9bf041". `e2e/.artifacts/performance/<that id>/summary.json`: selfQa.status "pass", sampleCount 62, coldOk 31, warmOk 31, inboxRequestClassesMatch/inboxNoCursor/inboxSurfaceSetMatches true; revisions.profilerCommit and targetAppCommit "b242b7d6". | VERIFIED |

Order note: the final perf run finished (report 03:55:08Z, exit file 23:55
local) BEFORE e2e run 2 started (`final2-e2e.start` 2026-09-26T03:55:48Z).
Spec 5.11 says "after the e2e gate". No overlap, same commit; see finding 6.

## 2. Scope checks (spec 4.2)

| Item | Verdict | Evidence |
|---|---|---|
| No file on the 4.2 exclusion list changed | DELIVERED | `git diff --name-only main...HEAD --` sendMessage.ts, scheduledSendSuppression.ts, broadcasts.ts, broadcastsRepo.ts, messagesRepo.ts, conversationsRepo.ts, broadcastFanOut.ts, retrySend.ts, `app/src/jobs/relay*`, messaging.ts, webhooks/twilio.ts, api.ts, contactTimeline.ts, `app/src/lib/import`, `app/src/lib/seed`, contact/Timeline.tsx, contact/deliveryStatus.ts, `dashboard/src/routes/broadcasts`, RUNBOOK.md, contact/format.ts -> empty. The 45 non-record paths are all inside 4.1 (plus e2e/README.md, three pin tests, and extra issue files). Note: `app/src/routes/inbox.ts`:2021-2032 edits a COMMENT inside the unknown branch (30 -> 100, and the appendPage-dedupe consequence); no code in that branch changed. |
| Hub files types.ts / client.ts / endpoints.ts: no diff | DELIVERED | Same command on `dashboard/src/api/{types,client,endpoints}.ts` -> empty. The only type added is the server-internal `InboxRouterDeps.inboxPrefetch` test seam (`app/src/routes/inbox.ts`:216); wire shape unchanged. |

## 3. Per-item table

### Section 3 - locked decisions

| Item | Verdict | Evidence |
|---|---|---|
| D1 page size 100 + auto-load + Load more kept | DELIVERED | `useInbox.ts`:60 `DEFAULT_PAGE_LIMIT = 100`; `Inbox.tsx`:202-208 `useAutoLoad`; button unchanged `Inbox.tsx`:430-439. |
| D2 four tiers, local days, no weekday | DELIVERED | `inboxTime.ts`:43-60 (`sameLocalDay`, Yesterday via local date arithmetic :56, year compare :58). |
| D3 placement: right edge, two lines on phone, unread time dark+semibold, as Sam approved | DEVIATED (amended in 8.5, human sign-off pending) | Layout as approved: `InboxRow.module.css`:201-212, :257-289. But the approved row CSS changed in overflow cases by build-review adjudication: `.head` never yields (:73-80, R2-1), placement tag + Needs triage yield to a 4em floor (:132-161, R3-1/R2-6), phone-named row never shrinks (:96-98, SQ-1). Spec 5.4 amended (spec:452-473) and the status line says so; the handback asks for the human's eye. Finding 1. |
| D4 group/relay paging unchanged, same time | DELIVERED | No diff to the relay/group merge blocks in `inbox.ts`; `InboxRow.tsx`:146-150 renders the time for every kind; test `InboxRow.test.tsx`:233. |
| D5 `2:14 PM` format; timeline untouched | DELIVERED | `inboxTime.ts`:19; `contact/format.ts` no diff. |
| D6 in-memory store keyed operator/filter/limit; Option B | DELIVERED | `inboxListStore.ts`:21-23; `inboxListMerge.ts`:110-121 (complete head drops the tail). |
| D7 failed background refresh keeps rows + banner + Retry | DELIVERED | `useInbox.ts`:395-399; `Inbox.tsx`:239-246. |
| D8 `?limit` 1..100, fallback 100 | DELIVERED | `Inbox.tsx`:33-39; table test `Inbox.test.tsx`:574-587. |
| D9 bounded-concurrency prefetch on filter=all | DELIVERED | `inbox.ts`:239, :2375-2405, :2426. Separability rule not triggered (equivalence tests green). |

### Section 5 - mechanisms

| Item | Verdict | Evidence |
|---|---|---|
| 5.1a `useInbox(filter, limit, operatorId)`; `limitFromParam`; `MAX_PAGE_LIMIT` with server pointer; operator via `useOptionalAuth` | DELIVERED | `useInbox.ts`:59-62, :194-202; `Inbox.tsx`:33-39, :57-58, :62. |
| 5.1b `selectFilter` and the groups link keep a present `limit`; groups link built from params | DELIVERED | `Inbox.tsx`:121-134, :137-143; test `Inbox.test.tsx`:628-635. |
| 5.1c every `getInbox` uses the hook limit | DELIVERED | `useInbox.ts`:321 (every head read), :528 (loadMore); test `useInbox.test.tsx`:940. |
| 5.2a sentinel `<div aria-hidden>` after the list, before Load more, only while hasMore | DELIVERED | `Inbox.tsx`:399-401 (also gated on `status === 'ready'`, as the button is). |
| 5.2b `useAutoLoad`: one observer per sentinel mount, root resolved once, 400px margin; report consumed at arrival; re-observe on epoch move while enabled; unconsumed report discarded first; takeRecords drain + live flag (AD-5); intersecting reset on unmount | DELIVERED | `useAutoLoad.ts`:37, :45-75, :95-113, :121-126, :129-134; root `Inbox.tsx`:44-52, :169-177. API takes the sentinel ELEMENT (state) instead of `sentinelRef` - cosmetic. |
| 5.2c `enabled = hasMore && autoLoadArmed && !loadingMore` | DELIVERED | `Inbox.tsx`:205. |
| 5.2d `overflow-anchor: none` on the page root | DELIVERED | `Inbox.module.css`:2-12 (:11). |
| 5.2e arming rule + `pageEpoch` bumped only by committed head/page | DELIVERED | `inboxListMerge.ts`:118-119, :138-139, :156-157; reset and 404 carry the epoch `useInbox.ts`:410, :456; `patchUnread` no bump :162-166. |
| 5.2f jsdom no-op; injectable factory | DELIVERED | `useAutoLoad.ts`:46, :83, :101. |
| 5.3a `formatInboxTime` via `toLocaleTimeString`/`toLocaleDateString` | DEVIATED (not amended; sound) | AD-1: four module-level `Intl.DateTimeFormat` instances (`inboxTime.ts`:19-32) replace per-call `toLocale*String`. Same locale/options, same strings; side effect filed as `inbox-time-formatters-pin-time-zone-at-load`. Spec 5.3 text still names the per-call methods. Finding 3. |
| 5.3b `formatInboxTimeFull`; `''` when unparseable; no `<time>` then | DELIVERED | `inboxTime.ts`:63-67; `InboxRow.tsx`:146. |
| 5.3c U+202F and U+00A0 -> plain space | DELIVERED | `inboxTime.ts`:13, :39-41; tests `inboxTime.test.ts`:101-119. |
| 5.4a `<time className dateTime title>` after the count pill, inside the Link | DELIVERED | `InboxRow.tsx`:141-150. |
| 5.4b desktop time rule; read muted; unread dark semibold | DELIVERED | `InboxRow.module.css`:201-212. |
| 5.4c head min(content,45%) never shrinks; name ellipsis; chip rule with 4em floor; `.numberName` | DEVIATED (amended in 8.5) | `InboxRow.module.css`:73-98, :115-174; `InboxRow.tsx`:74, :115, :128. Matches the AMENDED 5.4 letter; differs from DRAFT 8.4 (`flex: 0 1 auto`) and from the mockup in overflow cases. Same root as D3. |
| 5.4d actions box is an overlay (absolute, right sp-3, surface bg, pointer-events none until revealed) | DELIVERED | `InboxRow.module.css`:217-235; `.row` keeps `position: relative` :11. |
| 5.4e narrow two-row grid at 767.98px; head max-width none; one `<time>` element | DELIVERED | `InboxRow.module.css`:257-289. |
| 5.5a `ListState`; `commitList` the only writer, saves while alive+ready | DELIVERED | `inboxListMerge.ts`:17-25; `useInbox.ts`:300-306; every mutation reads `listRef.current` (:364, :410, :456, :534, :660, :702). |
| 5.5b `pendingRef` written synchronously | DELIVERED | `useInbox.ts`:236, :566-585. |
| 5.5c `aliveRef` true in mount effect body, false in cleanup; loadMore aborted | DELIVERED | `useInbox.ts`:470-476; commit guards :358, :530, :660, :702. |
| 5.5d reset: `loading` first, then empty commit | DELIVERED | `useInbox.ts`:448-461. |
| 5.5e loadMore dedupe vs base, cursor, epoch, arm on new rows, both staleness guards | DELIVERED | `inboxListMerge.ts`:145-159; `useInbox.ts`:517-535. |
| 5.5f `dedupeConversations` after every merge branch and append | DELIVERED | `inboxListMerge.ts`:72-92, :111, :131, :149. |
| 5.6a `additive`/`pagedP`/`headComplete` | DELIVERED | `inboxListMerge.ts`:54-56, :105-106. |
| 5.6b branch C | DELIVERED | `inboxListMerge.ts`:110-121. |
| 5.6c branch I; cursor rule | DEVIATED (amended, AD-4; sound) | `inboxListMerge.ts`:128-140; cursor :135 keeps only a NON-NULL old cursor. Spec 5.6 (spec:625-630) and section 8 (spec:1162-1171) amended to match. |
| 5.7a failure with rows rendered (404 included) -> `refreshFailed`, list untouched | DELIVERED | `useInbox.ts`:388-399. |
| 5.7b failure with no rows -> `error` / `pending`+empty | DELIVERED | `useInbox.ts`:400-413. |
| 5.7c any committed head read clears; reset clears | DELIVERED | `useInbox.ts`:363, :459. |
| 5.7d `retry()` without `loading` when rows rendered | DELIVERED | `useInbox.ts`:496-502. |
| 5.7e banner: role=status, copy, `Retry refresh`, above notices, below tabs | DELIVERED | `Inbox.tsx`:239-246 (after tabs :222-235, before notices :248). |
| 5.7f loadMore failure stays silent | DELIVERED | `useInbox.ts`:536-538. |
| 5.8a store module, key, snapshot shape, autoLoadArmed not saved | DELIVERED | `inboxListStore.ts`:9-35 (function names `saveInboxList/loadInboxList/clearInboxLists`, cosmetic). |
| 5.8b `clear()` from a passive effect in AuthGate; additive `useOptionalAuth` | DELIVERED | `AuthGate.tsx`:23-25; `AuthContext.tsx`:68-70. |
| 5.8c save only via `commitList` (alive+ready) and the unmount layout cleanup (ready only), key from `keyRef` | DELIVERED | `useInbox.ts`:300-306, :481-490. |
| 5.8d `scrollTopRef` seeded only when `restoreScroll`; passive scroll listener | DELIVERED | `useInbox.ts`:248; `Inbox.tsx`:62, :179-185. |
| 5.8e lazy restore (first render ready); `restoredKeyRef`; filter-effect reset-vs-reconcile rule | DELIVERED | `useInbox.ts`:205-209, :242, :433-466. |
| 5.8f scroll restore: POP -> saved, other store-backed -> explicit 0, once | DELIVERED | `Inbox.tsx`:192-200. |
| 5.8g in-app "Back to inbox" actions stay PUSH (Task 7b dropped) | DELIVERED | No diff to ConversationDetail.tsx, GroupTextView.tsx, ContactDetail.tsx, ThreadUnreadToggle.tsx. |
| 5.9 group/relay rows: time rendered, paging/notices unchanged | DELIVERED | `InboxRow.tsx`:146-150; notices `Inbox.tsx`:248-290 unchanged in substance except the `groupsHref`. |
| 5.10a promise caches: `resolveContact` keyed on phone and email joined by a pipe, `contactConvsCache` as promises, raw-message cache; degraded fallback, never a rejection | DEVIATED (not amended; sound) | `inbox.ts`:793-795, :865-890, :897-925, :928-942, :968-971, :1146. Key is `JSON.stringify([phone ?? null, email ?? null])` (injective) instead of the spec's pipe-joined string. Finding 4. |
| 5.10b prefetch pass, window 8, stop flag checked per chain, set at page-full and on every chunk exit | DELIVERED | `inbox.ts`:239, :2375-2405, :2426, :2442, :2465-2466. |
| 5.10c decision loop, dedupe, drop telemetry, assembled line unchanged; disable seam via deps | DELIVERED | Loop body `inbox.ts`:2427-2463 is the old body re-indented plus `prefetch?.stop()`; seam :216, :2426. |
| 5.11a classifier `limit=30` -> `100` + test | DELIVERED | `e2e/performance/collect.ts`:183-190; `collect.test.ts`:300-315. |
| 5.11b profiler plan 30 -> 100 + test | DELIVERED | `app/src/lib/inboxDiagnostics.ts`:69-72; `app/test/inboxDiagnostics.test.ts`:16-19. |
| 5.11c hermetic perf self-QA as a gate, bare, after e2e | DEVIATED (sound) | Ran as `npm run perf:pages -- hermetic --self-qa=full --cold-repeats=1 --warm-repeats=1` (the bare command throws; `research-drift-worklist.md` item 29), and before e2e run 2 rather than after. Green on b242b7d6 (section 1). Finding 6. |

### Section 6 - invariants

| Item | Verdict | Evidence |
|---|---|---|
| I1 complete replaces; incomplete removes nothing, not a failure; no scroll reset | DELIVERED | `inboxListMerge.ts`:110-140; no `loading` on reconcile (`useInbox.ts`:361, filter effect resets only on key change :448); e2e test 2 (`isConnected`) `inbox-rows-timestamps.spec.ts`:194-202. |
| I2 back restores instantly, one head read, no cursor before it | DELIVERED | Unarmed restore `useInbox.ts`:189; tests `useInbox.test.tsx`:951, :973; e2e test 3 :219-287. |
| I3 auto-load never on zero-row-with-cursor / while loadingMore / !hasMore / failed page without re-intersection; no chain unless short in pixels | DELIVERED | `inboxListMerge.ts`:138, :156; `Inbox.tsx`:205; `useAutoLoad.ts`:121-134; unit tests `useAutoLoad.test.tsx`:68, :115; e2e test 6. |
| I4 failed head read never blanks rows; failed Retry keeps ready; incomplete never banners | DELIVERED | `useInbox.ts`:395-399, :496-502; tests `useInbox.test.tsx`:1100, :1123, :1186. |
| I5 failed initial load -> existing error surface | DELIVERED | `useInbox.ts`:413; `Inbox.tsx`:356-363; test `useInbox.test.tsx`:1199. |
| I6 server-quantity gating; store holds server-shaped rows | DELIVERED | `useInbox.ts`:166-179 (unsorted, unnarrowed, patches folded), :727. |
| I7 sign-out clears; key-correct saves; no pre-first-page or reset snapshot; nothing after unmount | DELIVERED | `AuthGate.tsx`:23-25; `useInbox.ts`:303, :483; tests `useInbox.test.tsx`:998, :1012, :1233; `AuthGate.test.tsx`:47. |
| I8 one row per conversation across kinds | DELIVERED | `inboxListMerge.ts`:72-92; tests `inboxListMerge.test.ts`:213-230, `useInbox.test.tsx`:1062. |
| I9 filter=all page identical with/without prefetch | DELIVERED | `app/test/inboxFeed.test.ts`:2493, :2500, :2508, :2531. |
| I10 perf harness: one page request per sample, no cursor | DELIVERED | summary.json selfQa flags (section 1). |

### Section 7 - tests

| Item | Verdict | Evidence |
|---|---|---|
| 7.1 `inboxTime.test.ts` | DELIVERED | Tiers, midnight, year boundary, UTC-differs case guarded by `getTimezoneOffset() === 0` skip (:54-61, as the spec prescribes; it only diverges in west-of-UTC zones), unparseable, U+202F, full stamp (:10-119). |
| 7.1 `inboxListMerge.test.ts` | DEVIATED (minor gap) | Branch C on all four filters (:68-145); branch I on unread/unknown/all (:147-211) but NOT groups ("Branch I on every filter"); AD-4 cursor rule :172; conversion dedupe both branches :223. Finding 5. |
| 7.1 `useInbox.test.tsx` additions | DELIVERED | :940 limit; :951 StrictMode one live read; :973 no cursor after restore; :984 committed value; :998 reset writes nothing; :1012 post-unmount; :1029 alive after replay; :1045 and :1217 pendingRef + seeded scrollTop; :1062 dedupe + arm; :1081 epoch; :1100 404-with-rows + failing retry with rows; :1123 failure after mark-read; :1171; :1186 incomplete no banner; :1199 no-rows error. |
| 7.1 `useAutoLoad.test.tsx` | DELIVERED | :52-193 (12 cases, injected factory). |
| 7.1 `InboxRow.test.tsx` additions | DELIVERED | :214, :224, :233, :266, :271. |
| 7.1 `Inbox.test.tsx` additions | DELIVERED | :574 limit table; :598 banner; :614 sentinel; :628 limit preserved; :637 POP vs PUSH with MemoryRouter and a pre-scrolled container. |
| 7.1 `Inbox.styles.test.ts` | DELIVERED | :16-18. |
| 7.1 `inboxListStore.test.ts` | DELIVERED | :39-63. |
| 7.1 store `clear()` in beforeEach of hook/page tests | DELIVERED | `useInbox.test.tsx`:105-106; `Inbox.test.tsx`:102-104 (AppFrame.test mocks the Inbox). |
| 7.1 `AuthGate.test.tsx` | DELIVERED | :23-38 layout-cleanup saver, :47-66. |
| 7.2 route tests (equivalence incl. throwing phone, one read per key, degraded memoized, stop flag) | DELIVERED | `app/test/inboxFeed.test.ts`:2493-2570. The "one read for two concurrent misses" proof is indirect (call-count parity with the sequential arm, :2515). |
| 7.3 test 1 times render | DELIVERED | spec file :148-173. Unread rows are cleaned by an afterEach reseed (:144-146) instead of mark-read - stronger. |
| 7.3 test 2 paging + page-one refresh | DELIVERED | :175-217. "No spinner" is implied by the `isConnected` handle (:194, :202), not asserted separately. Counts follow the merged lean seed (Dario). |
| 7.3 test 3 back button + Option B | DELIVERED | :219-287. |
| 7.3 test 4 widths | DEVIATED | 360, 768 (stub + long-name + 304-char preview), WIDE_RESTORE delivered (:289-361). The placement-tag row at the 768 band, delegated by the spec to the live self-QA, was NOT measured: `self-qa.md` section 7 says the full profile offers no such row. Finding 2. |
| 7.3 test 5 refresh-failure banner | DELIVERED | :363-385. |
| 7.3 test 6 no chain at the group wall | DELIVERED | :387-416. |
| 7.3 test 7 disarm is unit-only, said in the header | DELIVERED | :40-42; unit `useInbox.test.tsx`:1062 (empty page with a cursor disarms). |
| 7.4 five AGENTS.md gates | DELIVERED | Section 1 (e2e: run 2 green on b242b7d6). |
| 7.4 live self-QA at both widths | DELIVERED (with disclosed limit) | `self-qa.md` sections 1-6 at 1280/768/360; IntersectionObserver never fired in the hidden pane (stated at :11-20); auto-load proven by e2e 2/3/6. |

### Section 9 - issues

| Item | Verdict | Evidence |
|---|---|---|
| File `inbox-loaded-pages-survive-refresh` (deferred) | DELIVERED | added, `status: deferred`. |
| Resolve `inbox-reconcile-failure-blanks-list` | DELIVERED | `status: resolved`, `resolved: 2026-09-25`, Resolution block naming section 5.7 (:13-21). |
| Update `seen-set-max-equals-max-inbox-limit` reachability | DELIVERED | `updated: 2026-09-25`; :54-57 says the dashboard now requests `limit=100`. |
| File `contact-timeline-time-format-differs-from-inbox` (low, improvement) | DELIVERED | added, `type: improvement`, `severity: low`. |
| File `inbox-labels-do-not-roll-over-at-midnight` (low, debt) | DELIVERED | added, `type: debt`, `severity: low`. |
| File `inbox-unread-page-hydration-sequential` (low, debt) | DELIVERED | added, `type: debt`, `severity: low`. |
| File `inbox-all-page-hydration-sequential` only if 5.10 dropped | DELIVERED (correctly not filed) | 5.10 shipped; file absent. |

## 4. Review records

`docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/` holds 39
committed records at 967ef4ab (`git ls-files` count): spec rounds r1-r5 with adjudications, plan
rounds r1-r3 with adjudications, code review r1 (spec-conformance +
adversarial) / r2 / r3 with adjudications, slice reports A-H, fix-wave
reports 1-3, `research-drift-worklist.md`, `self-qa.md`, `handback.md`. All
tracked (`git diff --name-only main...HEAD -- docs/superpowers`). The
`.superpowers/sdd/` tree holds only the ledger, logs and markers.

## 5. Findings

1. MEDIUM - The row CSS Sam approved "as drawn" changed in overflow cases
   by build-review adjudication (R2-1 head never yields, R3-1/R2-6
   placement tag and Needs triage yield to a 4em floor, SQ-1 phone-named
   row never shrinks; `InboxRow.module.css`:73-98, :132-161) and spec 5.4
   was amended to match (spec:452-473) without a recorded Sam or Cameron
   ruling. The handback flags it ("The chip rule you should look at") and
   gives the one-rule revert for the triage yield. Not a code defect; a
   merge-gate product call.
2. MEDIUM - Spec 7.3 test 4 delegates the placement-tag row at the 768 band
   to the live self-QA, and both `code-review-r3-adjudications.md` (:20-25)
   and `fix-wave-3-report.md` (:68-70) say the full-profile self-QA would
   prove the R3-1 geometry (placement, Closed, Deleted). `self-qa.md`
   section 7 records that the full profile has no such inbox row, so the
   shipped chip rule was never measured in a browser on the shipped tree
   for those three chips. Mitigation: the round-3 reviewer measured the
   same rule as a proposal (`code-review-r3.md` section 1) and
   `InboxRow.styles.test.ts`:39-53 pins the declarations. Closable by one
   lane check with a DB-seeded placement/Closed/Deleted row at 768 and 360.
3. LOW - 5.3 deviation not written back: the spec still prescribes per-call
   `toLocaleTimeString`/`toLocaleDateString`/`toLocaleString`; the code uses
   four module-level `Intl.DateTimeFormat`s (`inboxTime.ts`:19-32, AD-1).
   Same strings; the time-zone-pinned-at-load side effect is filed
   (`inbox-time-formatters-pin-time-zone-at-load`).
4. LOW - 5.10 deviation not written back: spec says `resolveContact` is
   keyed `${phone}|${email}`; code keys `JSON.stringify([phone ?? null,
   email ?? null])` (`inbox.ts`:897-925). Sound (injective, absent vs empty
   distinguished), stated in the handback.
5. LOW - 7.1 asks for branch I "on every filter"; `inboxListMerge.test.ts`
   has no Groups-filter branch-I case. Branch I is filter-independent except
   the All-only additive rule, so the risk is small.
6. LOW - Perf gate deviates from 5.11 in two harmless ways: it cannot run
   bare (explicit `-- hermetic --self-qa=full --cold-repeats=1
   --warm-repeats=1`, `research-drift-worklist.md` item 29, which the
   handback calls "research D1"), and the final run finished before e2e run
   2 started rather than after the e2e gate. Same commit, no overlap.
7. LOW - Handback accuracy (none changes the verdict): (a) "Issues: 16
   files" - the diff has 15 `docs/issues` files (10 added, 5 modified);
   (b) "+10186 / -463 including the spec, plan and 30+ review records" -
   10186 is code + spec + plan only (4245 + 1199 + 4742); with the review
   records it is +18045 / -463 at b242b7d6; (c) "96 on the branch after the
   spec/plan tip a554dcd5" - 45 first-parent non-merge commits
   a554dcd5..b242b7d6 (95 counts main's commits brought in by the merge);
   (d) the relay isolation re-run was not "on a fresh lane at HEAD": its log
   says "reusing the live e2e:session on lane 16" and it ran at 23:32 on
   dc0390e4 (+ a working tree), before the tip existed. Run 2's clean 284/284
   on b242b7d6 carries the attribution on its own.
8. LOW - `handback.md`:224 still reads `MERGE-READY-PLACEHOLDER` at
   967ef4ab; the planner's verdict is owed there.
9. LOW - Stale line refs in the filed issue
   `inbox-time-title-unreachable-under-actions-overlay`: frontmatter and
   body cite `InboxRow.tsx:128` and `InboxRow.module.css:150` / `:166`; on
   the shipped tree the `<time>` is at `InboxRow.tsx`:147, `.time` at
   `InboxRow.module.css`:201 and `.actions` at :217.
10. LOW - Spec DRAFT 8.5 still carries the builder-reported wording drift
    (handback "Spec wording drift"): the nav badge does not itself navigate;
    5.8's PUSH list omits the QuickReply links; section 2 names `useMe`
    where the code reads `AuthContext.me`; 5.11's reason auto-load cannot
    fire on the perf seed ("100 rows tall") is wrong (short page, no
    cursor); section 2 places `dropped(...)` wholly inside
    `rowForConversation`. No code impact; amend or accept.
11. LOW - One non-ASCII added line in the branch: a review record,
    `plan-r1-reviewer-b.md`, quoting an existing `describe` title that
    contains an em dash. Every other added line in `git diff main...HEAD` is
    ASCII.
12. LOW (process, caller-side) - `.superpowers/planner/planner-diff-read.md`
    is a findings note ("No must-fix found. Notes: ...") in the gitignored
    tree; AGENTS.md puts findings in the records path.

Conformance: 86 delivered / 8 deviated / 0 missing of 94 items
(9 decisions, 2 scope checks, 46 mechanisms, 10 invariants, 20 tests,
7 issue actions). No BLOCKING or HIGH item; every handback gate claim was
confirmed from its log except the "fresh lane at HEAD" wording of the
isolation re-run.
