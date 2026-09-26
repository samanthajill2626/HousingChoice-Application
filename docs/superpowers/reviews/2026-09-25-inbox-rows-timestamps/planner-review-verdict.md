# Planner verdict - inbox rows + timestamps (Sam's item #17)

Branch: `feat/inbox-rows-timestamps` at `W:\tmp\inbox-rows-timestamps`, cut
from main @cd8e8ddd, main merged once at 887f0685. Reviewed tip: bc1efe1e
(the planner's fix wave on 967ef4ab; runtime code last changed at d9339c08).
Main at review time: da04d0cb, 0 commits ahead of the branch's merge base,
so no further sync was needed. Spec DRAFT 8.6, plan v5.

## Verdict: MERGE-READY, UNMERGED (human gate)

The branch delivers every spec item (94 items: 86 delivered as written, 8
delivered with recorded deviations, 0 missing). Two independent reviewers,
the planner's own read of the riskiest diffs, gates 1, 2, 3 and 5 green on
the final commit, gate 4 green on the identical runtime code earlier the
same day (and twice for the build), and a live QA pass found no defect that
blocks the merge. Gate 4 on the final commit itself came back 282/284 twice
with a different pair of untouched, already-tracked flaky specs each time;
the table below names them, and the call whether to demand a clean re-run
first is Cameron's. What else remains is product judgment (section "For
Cameron's eye"), not engineering.

## Gates on bc1efe1e (planner, bare, from the worktree; logs under `.superpowers/planner/gates2/`)

| Gate | Result | Log |
| --- | --- | --- |
| 1 `npm run typecheck` | EXIT=0 | `gates2/typecheck.log` |
| 2 `npm test` | EXIT=0; app 369 files / 6934 passed / 1 skipped; dashboard 199 / 3304 (one more than the handback: the Groups branch-I case); e2e-unit 21 / 499; fake-twilio 34 / 245; web 13 / 111; zero `[dynamoAdmin]` lines | `gates2/test.log` |
| 3 `npm run smoke` | EXIT=0 | `gates2/smoke.log` |
| 4 `npm run e2e` | run A: EXIT=124 (the planner's own 25-minute outer timeout; 259 of 284 reached, 2 failed). Run B with a 40-minute timeout: EXIT=1, 282 passed, 2 failed (28.0m). Details below | `gates2/e2e.log`, `gates2/e2e-run2.log` |
| 5 `npx eslint <branch files>` | EXIT=1 with exactly the two pre-existing `e2e/performance/collect.test.ts:1218` errors (main: `:1204`); PASS by baseline | `gates2/eslint.log` |

**Gate 4 on bc1efe1e is not clean, and here is exactly what failed.** The
runtime code at bc1efe1e is byte-identical to 967ef4ab (the fix wave is
tests, one comment and docs), and 967ef4ab passed 284/284 in 24.9 minutes at
16:20Z on this machine; b242b7d6 passed 284/284 twice for the build. Over
the afternoon the runs slowed (24.9m, then killed at 25m, then 28.0m) and
each run failed a DIFFERENT pair of specs, none touched by the branch:

| Run | Failed | Alone | Tracked |
| --- | --- | --- | --- |
| A (killed at 25m) | `matching-entry-points.spec.ts:270` (typeahead re-opened after the guard, click intercepted 60s) | FAILED alone once, then passed inside run B | `matching-entry-points-property-first-e2e-flake` - REOPENED with the evidence and a component-side fix; the area (`BroadcastComposer.tsx`) is on this branch's exclusion list |
| A | `scheduled-visibility.spec.ts:179` | passed alone (7/7 in the two-file run) | a cascade of the slow run; not filed |
| B (28.0m) | `group-text-per-recipient-delivery.spec.ts:63` and `group-text-reply-all.spec.ts:45` (per-member rollup never finalized live, SSE push missing) | passed alone (3/3, 42.1s) | `group-reply-live-rollup-full-suite-flake` - REOPENED on its own stated trigger; messaging and SSE are untouched here |

Machine conditions during runs A and B: 15-49% CPU with about 32 node
processes from other sessions (mostly idle `@playwright/mcp` servers) and a
DynamoDB Local container 38 hours up. The planner did not restart that
container (it serves Cameron's live lane 0) and did not stop other
sessions' processes. Reading: environmental, the same shape as the
2026-08-21 sick-machine day, and NOT proven, which is why it is stated
rather than excused. If a clean gate 4 on the final commit is wanted before
the merge, run it from the worktree on a quiet machine:

```powershell
cd W:\tmp\inbox-rows-timestamps; npm run e2e
```


Also on 967ef4ab (same runtime code) the same five ran green on 2026-09-26:
typecheck EXIT=0; test EXIT=0 (app 369 files / 6934 passed / 1 skipped,
dashboard 199 / 3303, e2e-unit 21 / 499, fake-twilio 34 / 245, web 13 / 111,
zero `[dynamoAdmin]` lines); smoke EXIT=0; eslint EXIT=1 with exactly the two
pre-existing `e2e/performance/collect.test.ts:1218` errors that main carries
at `:1204` (PASS by baseline); e2e EXIT=0, 284 passed (24.9m).

The build's gates on b242b7d6 are in `handback.md` (e2e run 2: EXIT=0, 284
passed; `perf:pages` self-QA pass).

## Per spec section

| Spec | State | Where |
| --- | --- | --- |
| 5.1 `?limit=` 1..100, default 100, server max 100 | delivered | `Inbox.tsx limitFromParam`, `useInbox DEFAULT_PAGE_LIMIT`, `inbox.ts MAX_INBOX_LIMIT` |
| 5.2 auto-load: one observer, consume at arrival, re-observe on epoch, page-root `overflow-anchor: none` | delivered (AD-5 drain added) | `useAutoLoad.ts`, `Inbox.module.css:11`, e2e tests 2/3/6 |
| 5.3 four tiers, local days, U+202F normalized | delivered (AD-1 module-level formatters, written back) | `inboxTime.ts` |
| 5.4 row: time right, overlay actions, chip rule, two-line phone grid | delivered; overflow rule changed at build review (R2-1, R3-1, SQ-1) | `InboxRow.tsx`, `InboxRow.module.css`; measured in `planner-live-qa.md` |
| 5.5 one authoritative list, `commitList` single writer | delivered | `useInbox.ts`, `inboxListMerge.ts` |
| 5.6 branch C replaces, branch I merges (AD-4 cursor rule) | delivered, spec amended | `inboxListMerge.ts mergeHeadRead`, 27 merge tests |
| 5.7 failed refresh keeps rows + banner + Retry | delivered | `useInbox.ts` error arm, `Inbox.tsx`, e2e test 5 |
| 5.8 store restore, POP-only scroll, unmount save, sign-out clear | delivered (7b dropped by ruling) | `inboxListStore.ts`, `Inbox.tsx`, `AuthGate.tsx`; back-button measured live |
| 5.9 group rows page-one only | delivered (unchanged behavior) | `inbox.ts` relay/group merge |
| 5.10 prefetch through promise caches, loop untouched | delivered (JSON key; overshoot + seam noted) | `inbox.ts startPrefetch`, equivalence suite + stop-flag test |
| 5.11 perf classifier `limit=100`, profiler plan 100, self-QA gate | delivered | `e2e/performance/collect.ts`, `perf:pages` pass on b242b7d6 |
| 6 invariants | held under both reviewers' walk-throughs | adjudications |
| 7 tests | delivered plus the review wave's three additions | see gates |
| 9 issues | 10 filed by the build, 1 by the planner | `docs/issues/` |

## The planner's own read (riskiest diffs)

Read in full: `useInbox.ts`, `inboxListMerge.ts`, `useAutoLoad.ts`,
`inboxListStore.ts`, `inboxTime.ts`, the `Inbox.tsx` scroll and observer
wiring, and the `app/src/routes/inbox.ts` diff. No must-fix. Notes:

- The prefetch mirrors the loop's read chain (`resolveContact` ->
  `contactConversations` -> `newestOf(convs) ?? conv` -> `latestRaw`). The
  loop reads the latest message only for the representative conversation;
  the prefetch may read one extra for a deleted contact's fast path
  (harmless, per-request cache).
- `useAutoLoad`: the NO_REPORT reset on sentinel unmount sets the consumed
  seq to 0 while the observer seq keeps counting, so the next real report
  is always consumed exactly once.
- A restored mount plus an INCOMPLETE reconcile keeps auto-load unarmed
  until a complete head read (spec 5.2 as written; Load more is the
  fallback). Filed as a low residue with the Unread truncation case.
- A tab switch does not restore from the store (reset on key change); only
  a mount does. Spec 5.8 as written.
- `rows = sortByActivity(head ++ tail)` on every render; fine at 100-300
  rows.

## Review findings (both reviewers), one line each

Full adjudications: `planner-review-adjudications.md`. Conformance: 12
findings, none a code defect; 9 accepted as write-backs, tests and record
fixes; 2 product calls to Cameron; 1 note. Adversarial: 11 findings; 6
accepted (one test that could not fail, now mutant-proven; one stale
comment; one styles pin; one issue filed; two spec notes), 2 rejected as
defects because they are the ruled trade-offs (page-root anchoring, Option
B), 3 already filed by the build. Decisions changed: 0.

## For Cameron's eye (product, not defects)

1. **The row overflow rule is not what Sam saw.** Sam approved the mockups
   at 390 and 1280. Build review then changed how rows behave when they run
   out of room: the name area never yields to the preview (R2-1), the
   placement tag and Needs triage chip shrink first down to a 4em floor
   (R3-1), Closed and Deleted never shrink, a phone-number name never
   shrinks (SQ-1). At 1280 nothing clips. At 768 with the sidebar open
   (rows about 370px of content) long names ellipsize and a stale Closed
   relay row keeps three letters of its name; at 360 names and chips both
   ellipsize but stay readable (`planner-live-qa.md`). Recommendation:
   merge as is; the 768 band with the sidebar open is the awkward middle
   and the sidebar collapses. The one-rule revert (let the chips clip
   before the name) is written in `handback.md` if Sam prefers it.
2. **Scroll anchoring is off on the inbox page.** Chosen in spec 5.2 and
   section 8, re-argued at build review AD-2: with rows as anchor
   candidates, a page appended above the group wall would make the browser
   hold a group row still and auto-load would chain. The cost, which the
   adversarial reviewer put more sharply than the spec did: any live
   update above a scrolled operator's viewport shifts the rows under her
   pointer by one row, and since opening a row also marks it read, a click
   a moment after a reconcile can open the neighbor. This is how the
   Messages app behaves too. Recommendation: keep it; revisit if Sam
   reports mis-opens. The alternative (anchoring on, `overflow-anchor:
   none` only on the sentinel and Load more) is a two-line CSS change
   whose group-wall chaining would need a new guard.
3. **Rows past page one drop on a refresh** (Option B, your 2026-09-25
   ruling; `docs/issues/inbox-loaded-pages-survive-refresh.md`).

## Filed issues (11 filed, 2 reopened)

By the build: `contact-timeline-time-format-differs-from-inbox`,
`inbox-labels-do-not-roll-over-at-midnight`,
`inbox-unread-page-hydration-sequential` (now also names the All-tab
placement-label read), `inbox-profiler-total-ms-overcounts-with-prefetch`,
`inbox-time-title-unreachable-under-actions-overlay`,
`inbox-restore-shows-row-read-after-mark-unread-jump`,
`group-text-inbox-spec-depends-on-leftover-conversations`,
`e2e-waitforurl-does-not-prove-route-rendered`,
`inbox-time-formatters-pin-time-zone-at-load`,
`inbox-loaded-pages-survive-refresh` (the deferred design). By the planner:
`inbox-incomplete-head-read-keeps-stale-rows`. Reopened by the planner on
their own stated triggers, from gate 4's failures in untouched areas:
`matching-entry-points-property-first-e2e-flake` and
`group-reply-live-rollup-full-suite-flake`. Not filed, noted only:
`isPhoneName` matches NANP formatting only (US-only product; the server
formats no other shape).

## Post-merge obligations

None. No new dependency, no env or infra change, no message-catalog copy,
no data migration. The three live branches' excluded files were not
touched and the three hub files have no diff.

## Process record

Build: AUTO dispatch 2026-09-25, 30-minute watchdog cadence (Cameron's
ask), about 8.5 hours, 0 child recoveries; the orchestrator died on a Fable
429 while waiting on e2e run 2, which completed unattended (EXIT=0, 284
passed) and the planner finalized the handback (recovery 1 of 2). Planner
review 2026-09-26: gates on 967ef4ab, two reviewers, live QA, fix wave
bc1efe1e, gates again on bc1efe1e.

## Merge (Cameron, from the shared main checkout; nothing else is owed)

```powershell
cd "W:\AI Projects\Housing Choice\HC Application"; git status --short; git merge --no-ff feat/inbox-rows-timestamps -m "Merge feat/inbox-rows-timestamps: inbox page 100 + auto-load, a time on every row, list survives live updates and the back button (Sam's item #17)"
```

Cleanup (worktree, branch) only on a separate explicit ask.
