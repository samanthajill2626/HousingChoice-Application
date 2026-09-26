# Research drift worklist - inbox rows + timestamps (build phase 1)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps` @a554dcd5 (docs only on
top of `main` @cd8e8ddd). Three read-only readers (dashboard, app server,
e2e + issues) checked every anchor the plan's Tasks 1-11 rely on against the
live tree. Byte-exact reference backing these citations lives in the ignored
`.superpowers/sdd/research-reference.md`.

Headline: NO anchor the plan's code depends on has drifted. Every quoted
line, import, CSS class, test helper, fixture field and env name matches the
live tree. The corrections below are in the plan's INSTRUCTIONS, counts and
two behavioral gaps, and each is bound to the slice that owns it.

## Binding corrections, by slice

### S5 (Task 5, useInbox rebuild)

1. **A failed refresh must never be swallowed by the mutation-generation guard
   (spec decision 7, 5.7, invariant 4).** The plan's `fetchHead` catch (plan
   line 1807) returns early on `gen !== genRef.current` BEFORE the rows-rendered
   check that raises the banner. Reachable with no filter change: a mark-read
   POST in flight, a background head read in flight, the POST commits (gen
   bumps), the read fails -> stale list, no banner. The live guard
   (`dashboard/src/routes/inbox/useInbox.ts:265`) exists only to stop a failed
   pre-mutation read from BLANKING a list; under the new rule the rows are
   kept, so the gen axis has nothing left to protect on the failure path.
   RULE: the failure path refuses on the FILTER axis only
   (`filter !== activeFilterRef.current`); with rows rendered it raises
   `refreshFailed` regardless of `gen`; with no rows rendered it takes the
   existing error / 404-pending arms. Add a unit test for the interleaving
   above (rows kept, `refreshFailed` true, status `ready`).
2. The six carried comment blocks name `fetchFirstPage`
   (`useInbox.ts:162, :164, :174, :322`); the plan renames it `fetchHead`.
   Update the names in the carried text. Block (1) at `:164-165` says the
   read "installs its page wholesale" - amend to "a complete page replaces
   the list; an incomplete one merges in (spec 5.6)". Block (5): the sentence
   to amend ("The filter and cursor are captured...") is its SECOND sentence
   (`:322-323`); the first is "Same abort + generation pattern as
   fetchFirstPage above (C2)." - keep it, renamed.
3. Carry over every other explanatory comment whose code survives the
   rewrite, not only the six the plan lists: `useInbox.ts:144-148, :151-158,
   :182-186, :282-295, :303-306, :345-347, :354-357, :405-415, :458-469,
   :485-489, :504-506` and the `InboxState` field notes at `:41-80`. The old
   failure-path block `:248-264` is replaced by the spec 5.7 comment as the
   plan says.
4. Expected counts: Task 5 Step 3(f) adds 16 tests, so the file totals 52
   (plan says 15/51).

### S7 (Task 7, Inbox page)

5. `Inbox.test.tsx:14` already declares `let seenFilter`; Task 7(a) (plan
   2943-2947) redeclares it. Add ONLY `seenLimit`, `seenOperator`,
   `seenRestoreScroll`, `noteScrollTop`.
6. Carry over the display-condition comments from the live `Inbox.tsx`
   (`:29-63, :67-78, :112-134, :156-196, :208-219, :257-283`) wherever the
   element survives; the plan's replacement keeps every element and drops
   only comments.
7. Expected counts: 10 `it.each` rows + 5 tests = 15 new, 51 total (plan
   says 16/52).

### S8 (Task 8, server prefetch)

8. **The `slowReads` delay must go AFTER the call counter**, not "as the first
   line" of `makeDeps`'s `listByConversation` (`app/test/inboxFeed.test.ts:234`
   is the counter). Placed first, the counter counts only FINISHED reads and
   the stop-flag test's `toBeGreaterThan(1)` stays red even with a working
   prefetch (Node runs pending promise jobs after each timer, and the request
   completes on the first 1 ms timer at `limit: 1`).
9. `inboxPrefetch?: boolean` goes after `unknownQueueScanBudget`
   (`app/src/routes/inbox.ts:210`, the last field), not after
   `unknownQueuePageSize` (:209), so the shared "TEST SEAMS" doc comment
   (:199-208) is not split.
10. Carry the FULL live `contactConversations` comment (`inbox.ts:848-858`,
    beginning "Email channel v1 (invariant rule): resolve across BOTH phones
    AND emails") word for word; the plan's replacement shortens it.
11. The `finally { prefetch?.stop() }` fires only after `break pager`
    (`inbox.ts:2349`), which follows the extra boundary query
    (`:2339-2346`), so workers can start chains during that query. Keep the
    `finally` AND also call `prefetch?.stop()` at the point the loop knows the
    page is full (before the boundary query) if that can be done without
    touching any decision, count or cursor line; otherwise keep the `finally`
    alone and state the residual in the slice report.
12. There is no Prettier in the repo; re-indent the wrapped inner loop by
    hand (ESLint has no formatting rules).
13. The `inboxPrefetch: false` arm is NOT the old code path: `resolveContact`
    and `latestRaw` are memoized in both arms, so the equivalence tests cannot
    catch a bad cache KEY. The existing `filter=all` tests, which now all run
    with prefetch on, are that net - so the slice gate is the WHOLE app suite
    (`npm run test -w app`), not `inboxFeed.test.ts` alone. Files that reach
    the pager: inboxGroups, inboxUnknownParity, inboxUnknownTab,
    inboxUnreadParity, inboxApi, inboxEmail, voiceInboxActivity,
    inbox.integration, performanceSeed.integration.
14. The plan's comment at 3627-3629 overstates when call counts can differ:
    they also differ for conversations the loop consumes but drops before the
    latest-message read (`notNewestConv` :1168, `deletedNoUnread` :1181,
    `noContactNoPhone` :1094). The fixture at limit 25 has none, so the
    assertion holds; word the comment accurately.

### S10 (Task 10, issues)

15. `docs/issues/seen-set-max-equals-max-inbox-limit.md`: the plan's new
    paragraph cites `inboxFeed.test.ts:1397` and `:1417`, which are STALE
    (today those lines sit inside an unrelated test). The two depth-cap tests
    are `DEPTH CAP: past SEEN_SET_MAX ids on a page that EXHAUSTED the supply
    is a natural end, NOT truncated` and `DEPTH CAP: past SEEN_SET_MAX ids
    with supply REMAINING withholds rows and says truncated` (at :1453 and
    :1473 before Task 8; Task 8 shifts them). Cite by TEST NAME with the
    line numbers re-grepped after Task 8 lands. Replace the WHOLE paragraph
    at lines 51-55 (the plan's text ends with the same closing sentence, so a
    partial replace duplicates it). The frontmatter already has
    `updated: 2026-08-25` at line 9 - replace the value, never add a second
    key. Optional: the `refs:` lines cite `inbox.ts:196, :238, :1386`; the
    live lines are `:217` (MAX_INBOX_LIMIT), `:259` (SEEN_SET_MAX), `:1655`
    (the strict cap).
16. `inbox-reconcile-failure-blanks-list.md` resolution wording: the built
    behavior is options 1 AND 2 of the issue's list together (option 2 is
    exactly "error solely when no rows are rendered"; option 1's stale-data
    marker is made visible). Say "Options 1 and 2 together, with the failure
    made visible (what option 3 wanted preserved)".
17. File one extra low/debt issue this research found:
    `inbox-profiler-total-ms-overcounts-with-prefetch` -
    `app/scripts/profile-inbox.ts:117` calls `aggregateInbox` without
    `inboxPrefetch`, so the manual all-page profile now includes the
    prefetch's read-ahead, and `summarizeInboxTrace.totalMs`
    (`app/src/lib/inboxDiagnostics.ts:143, :160`) sums per-read durations that
    now overlap, so it exceeds wall time. Suggested fix: pass
    `inboxPrefetch: false` for a sequential profile or report wall time.
18. `scripts/issues.mjs` accepts comma-separated `refs:` and free-text
    `area:`; `resolved:` is a documented key; all three planned files are
    valid as written.

### S10b (Task 10b, perf classifier + profiler plan)

19. **Two more `limit=30` tuples sit OUTSIDE the `classifyInboxRequest` block
    in `e2e/performance/collect.test.ts` and go red once the classifier moves:
    `:273` (test "keeps unread page traffic distinct from the standard-route
    badge completion identity", expects `inbox_page_unread` at :279) and
    `:442` (test "keeps the inbox destination load required and labels its
    later SSE repeat background_refresh"; with a null class the repeat stays
    `required` and :448 fails).** Move both to `limit=100`. Inside the block:
    `:289` moves to 100; `:306-308` (double filter) and `:320` (cursor,
    refused by arity) stay. The comment at `:299-302` must be replaced too:
    it says a `limit=100` read is a contract mismatch and "the dashboard never
    asks /api/inbox for 100 rows".
20. `e2e/README.md` is stale and no task edits it: `:205-211` says the initial
    page requests are `limit=30` and describes the badge as
    `filter=unread&limit=100` "not the 30-row page request" (already wrong:
    the badge is path-only `/api/inbox/unread-count`,
    `dashboard/src/api/endpoints.ts:1742-1751`); `:409-410` says "page 1
    renders 30 contact rows". Update those lines (ASCII-only) in S10b.
21. `app/test/inboxDiagnostics.test.ts` also carries "30" in the test title
    (`:11`, "four dashboard pages at 30 rows") and a comment (`:37`); update
    both. Rewrap the docblock sentence at `app/src/lib/inboxDiagnostics.ts:60`.
22. Collector tests run as
    `npm run test -w @housingchoice/e2e -- performance/collect.test.ts`
    (there is no root vitest config; the plan's bare `npx vitest run
    e2e/performance/collect.test.ts` bypasses `e2e/vitest.config.ts`).

### S9 (Task 9, Playwright spec)

23. **A fake-Twilio party is a STUB CONTACT row, not a `kind:'unknown'` row**:
    every 1:1 inbound runs `captureContact`
    (`app/src/routes/webhooks/twilio.ts:2498-2500`), which creates a
    `type:'unknown'` contact, so the inbox emits `kind:'contact'`,
    `role:'unknown'`, `needsTriage:true`, name = formatted phone
    (`app/src/routes/inbox.ts:1033-1047`), href `/contacts/contact-<uuid>`,
    and it CARRIES `phone` (:1038). Every locator in the plan still holds
    (name, Needs triage chip, the `waitForURL(/\/(contacts|conversations)\//)`,
    the `rows.find((r) => r.phone === number)`); fix the spec-file header
    comment's wording and never assert `kind === 'unknown'`.
24. **Minted numbers can collide with the lean seed's `+15550100001..3`**
    (Tasha, Marcus, Renee; `app/src/lib/seed/lean.ts:96, :133, :165`) when
    `stamp.slice(-4) === '0100'`, and the derived stamps (`${stamp.slice(1)}4`
    etc.) can repeat the base block. Use a scheme that never yields a `010`
    prefix and gives each mint CALL its own block, e.g.
    `+1555${block}${stamp.slice(-4)}${String(i).padStart(2, '0')}` with a
    distinct `block` digit (9, 8, 7, 6) per call and `i < 100`.
25. The lean group text row is named "With Tasha & Marcus" and the relay row
    "With Marcus Bell & Renee Carter" (`app/src/lib/groupTitle.ts:40-63,
    :161-179`); the plan's `/Group text/` locator matches the "Group text"
    CHIP inside the link (`InboxRow.tsx:64-70, :101`), which works. Row order
    with everything on page one: Tasha, group text, relay; at `?limit=2` the
    appended pages sort above the group rows, so the LAST row is a group row.
26. Commits made while an `e2e:session` lane is live make the lane stale
    (the launcher stamps the launch commit; preflight refuses a mismatch,
    `e2e/support/preflight.ts:105-128`; `e2e:restart` keeps the old stamp).
    Order: run, `e2e:stop`, then commit; or commit first and start the lane
    after.
27. The `afterEach` reseed is a deliberate strengthening of spec 7.3's
    "mark read before the test ends" (a deviation, noted, accepted). "Load
    more gone" can pass transiently while the button reads "Loading..."; safe
    as written because every such check follows an exact final row count.
28. Sanctioned single-spec command against a live lane:
    `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/inbox-rows-timestamps.spec.ts`
    (file paths pass through; `--grep` does not).

### S11 (gates + self-QA; the orchestrator's)

29. **The perf gate command in the plan does not run as written**: bare
    `npm run perf:pages` throws `target must be hermetic, local, or hosted-dev`
    (`e2e/performance/config.ts:141-144`), and the two inbox self-QA checks
    (one finished initial page request per inbox sample,
    `e2e/performance/selfQa.ts:345-350`; no `cursor` key, `:352-354`) run only
    under `--self-qa=full`, which also requires scale 1 and exactly one cold
    and one warm repeat. The gate is
    `npm run perf:pages -- hermetic --self-qa=full --cold-repeats=1 --warm-repeats=1`;
    a violation exits 1 with status `self_qa_mismatch` in `summary.json`
    (`report.ts:1595-1603`). It refuses to start while a session or full
    suite is live in the worktree.
30. Recent full e2e suites took 17-26 min; a 1500 s cap can kill a healthy
    run (and a killed run orphans its stack - confirm the lane's ports are
    free before the next run). Run with the mission's 1500 s cap first; a
    timeout kill with evidence of progress is not a verdict.
31. Spec 5.11's reason for "auto-load does not fire on the perf seed" is
    wrong (the All page is not 100 rows tall): the scale-1 perf world has 20
    relay groups and about two dozen contacts, so page one is SHORT with no
    cursor and no sentinel renders. The conclusion holds.

## Spec wording drift (no code change; for the handback)

- Spec 5.1/5.8 say the nav badge navigates; it is a plain `<span>` beside the
  NavLink (`dashboard/src/app/NavContents.tsx:65-69`); only the NavLink
  navigates.
- Spec 5.8's list of in-app links to `/inbox` misses
  `dashboard/src/routes/quickReply/QuickReply.tsx:220` ("Open the inbox") and
  `:242` ("Back to the inbox"); both are forward navigations and open at the
  top under the general rule.
- Spec 2 (line 158) names `useMe` as the operator-id source; `useMe` is the
  voice profile (`dashboard/src/app/useMe.ts:3-4`); the plan correctly reads
  `AuthContext.me`.
- Spec 5.10 says the unread branch's exposure to the new raw-message cache is
  "the whole of" the change outside the pager; the UNKNOWN branch's
  `buildContactRow` (`inbox.ts:2207`) also reaches `latestMessageOf`
  (`:970`). Harmless: each kept contact has distinct conversations.
- Spec 5.10 says WARN counts differ "only for conversations the loop never
  consumed"; they also drop when two consumed conversations share one
  phone+email pair (today's lookups are uncached).
- Spec 2 says the `dropped(...)` telemetry lives inside `rowForConversation`;
  the pager's `filtered` count is written directly at `inbox.ts:2325`.
- Spec 7.3 test 1 / plan 3964-3968 call a minted party an "UNKNOWN row"; see
  item 23.

## Invariant surfaces (spec section 6) - confirmed complete

Writers of the list/pending/status all sit in `useInbox.ts` and are rewritten
(`:239, :269, :300, :343, :470, :512`). The only renderer of `InboxState` is
`Inbox.tsx`. Sign-out has ONE path (`AppFrame.tsx:43-57` -> `AuthContext`
anonymous -> `AuthGate` unmounts the tree); no 401 handler flips auth
(`client.ts:119-121` throws), so an expired session shows the banner, not a
blank. Navigations to `/inbox` are all forward (nav link, two "Back to inbox"
arrows, two mark-unread jumps, two QuickReply links); the only `navigate(-1)`
is the image viewer's. Other pages that change read state and so make a
restored list briefly stale until the mount reconcile: `ContactDetail.tsx:347,
:370`, `useMarkContactRead.ts:147`, `ThreadUnreadToggle.tsx:147, :163`,
`useMarkThreadRead.ts:52`, `usePlacementChannels.ts:312, :344`,
`useTourChannels.ts:302, :334` - the class spec 5.8 accepts. The event
stream has 28 subscribers; only `useInbox` writes the list. No e2e locator
on an inbox row uses an exact-string name, so the appended `<time>` text
breaks nothing; `inbox-mark-unread-header.spec.ts:173-180` becomes a
store-backed PUSH mount and must still flip its row within 15 s.

## Importers ("still compiles" checklist)

`rowKey`: `Inbox.tsx:13`, `useInbox.test.tsx:35`. `useInbox`: `Inbox.tsx:13`,
`useInbox.test.tsx:35`, mocked in `Inbox.test.tsx:38-47`. `InboxState`:
`Inbox.test.tsx:11`. `Inbox`: `App.tsx:26`, `AppFrame.test.tsx:26-28` (mock),
both test files. `AuthGate`: `App.tsx:9`, `AuthContext.test.tsx:4` (renders
the real gate). `useAuth`: eight call sites; five settings tests mock
`AuthContext.js` wholesale without `useOptionalAuth` but never render the
Inbox or AuthGate. `aggregateInbox`/`InboxRouterDeps`: `api.ts:1175-1185`
(excluded file; needs no change for an optional field), `profile-inbox.ts`,
six app test files; nothing uses `satisfies`/`Required<>` on the deps type.
No spec infra reads the `inbox feed assembled` line outside tests.
