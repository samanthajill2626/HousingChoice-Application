# Code review round 1 - adjudications and the fix-wave charter

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`, reviewed @156022b7
(merge base `main` @cd8e8ddd). Reviews: `code-review-r1-spec-conformance.md`
(SC-1..SC-19) and `code-review-r1-adversarial.md` (AD-1..AD-16, plan-blind).
Gates on 156022b7 before the wave: typecheck 0, smoke 0, `npm test` 0
(app 366 files / 6876 passed / 1 skipped; dashboard 197 / 3251; e2e-unit
21 / 499; fake-twilio 34 / 245 and 13 / 111), eslint = 2 pre-existing errors
at `e2e/performance/collect.test.ts` (identical at the merge base), full
e2e `281 passed (19.0m)` exit 0.

Adjudicator: the build orchestrator. Rule applied: a finding is FIXED in
this wave when it is confirmed against the spec's intent or is a test pin
the spec section 7 asks for; a finding that contradicts an accepted,
human-ruled trade-off is REJECTED with the rationale; a finding outside the
mission's scope is FILED as an issue; the rest are NOTED for the handback.

## Adversarial findings

| # | Sev | Decision | Rationale |
|---|---|---|---|
| AD-1 | MUST-FIX | FIX | Two `toLocale*String` calls with options per row per render build fresh `DateTimeFormat`s; measured 11 ms per render at 100 rows, 177 ms at 1000. Replace with module-level `Intl.DateTimeFormat` instances (same strings; keep `plainSpaces`) and wrap `InboxRow` in `React.memo` (its callbacks are stable `useCallback`s and unpatched rows keep identity). The NBSP pin test that spies `toLocaleTimeString` must move its spy to `Intl.DateTimeFormat.prototype.format`. |
| AD-2 | SHOULD-FIX | REJECT | The reviewer proposes `overflow-anchor: none` on the sentinel and button only, leaving rows as anchor candidates. Spec 5.2/5.9 and section 8 chose the page root ON PURPOSE (human-accepted trade-off): on the All tab an appended page sorts ABOVE the old group rows at the bottom of page one, so when the operator is at the group wall the anchor is a visible group row, the browser would raise `scrollTop` to hold it, the sentinel would stay inside the margin and auto-load would chain - exactly what e2e test 6 pins against. The reviewer was plan-blind to 5.9. The one-row-per-inbound drift it describes is the accepted cost (spec 8). Surfaced in the handback for the human's eye. |
| AD-3 | SHOULD-FIX | FILE | With one action button the hover overlay covers the `<time>`, so its `title` tooltip is unreachable by mouse on every row that offers an action. Spec 5.4 / section 8 accepted the overlay covering the time as Sam approved the drawn layout; the tooltip loss is a consequence the spec did not spell out and changing the overlay's offset alters the approved visual. Filed as `inbox-time-title-unreachable-under-actions-overlay` (low, improvement) with the two candidate fixes; flagged in the handback. |
| AD-4 | SHOULD-FIX | FIX (spec refinement) | Spec 5.6 branch I says "keep the old cursor, INCLUDING null". Reproduced: a fully loaded list (null cursor) that then gets an incomplete head read with a cursor keeps null, so `hasMore` is false, no Load more and no sentinel render, while the Unread notice says older threads exist - a dead end that survives every restore. Installing the read's cursor when the old one is null honors the intent (nothing lost, not a failure, the feed stays reachable) and costs at most one page of already-present rows, which `appendPage`'s rowKey dedupe absorbs. Rule becomes: keep the old cursor when it is NON-NULL; a null cursor takes the read's cursor. Spec 5.6 amended on-branch in the same wave; a merge test pins null-over-cursor. |
| AD-5 | NOTE | FIX (hardening) | Drain queued entries with `takeRecords()` inside `reobserve` and before `disconnect`, and ignore callbacks after the effect's cleanup via a `live` flag, in the DEFAULT factory only. Makes the spec 5.2 residual smaller; the fake observer and the unit tests are unchanged. |
| AD-6 | NOTE | NOTE | Read-ahead WARNs for rows not on the page and reads outliving the response are the spec 5.10 accepted cost ("wasted reads, bounded by one chunk"); Express never cancelled `aggregateInbox` before this branch either. Handback. |
| AD-7 | NOTE | FIX (docs) | Update the 30-row numbers in `docs/issues/thread-hooks-refetch-whole-page-per-event.md` and `docs/issues/inbox-parselimit-empty-one-row.md` to the 100-row page. |
| AD-8 | NOTE | FIX (pin) | Pin `MAX_PAGE_LIMIT` (dashboard) == `MAX_INBOX_LIMIT` (app) with a source-reading test so the mirror cannot drift silently. |
| AD-9 | NOTE | FIX (comments/docs) | `app/src/routes/inbox.ts` comment "30 from the dashboard" -> 100; the "doubled row ... VISIBLE" comment and `docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` now describe the wrong symptom (`appendPage` dedupes by rowKey, so the stale page-one copy silently wins until the next head read) - reword both. Perf ledger citations: NOTE only (format-checked strings). |
| AD-10 | NOTE | FIX (comments) | The AuthGate header and test header claim a parent cleanup runs before the child's unmount save; React 19's proven order is child LAYOUT cleanup, parent PASSIVE cleanup, child passive cleanup. The code is right (a passive EFFECT in the surviving gate); reword both comments and the matching spec 5.8 sentence. |
| AD-11 | NOTE | NOTE | Perf harness: a cursor request would fail a sample, but the perf seed's Unread/Unknown pages carry no cursor (research D9) - the Phase 5 `perf:pages` self-QA is the arbiter. Warm inbox-all measuring a restore is inherent to spec 5.11; handback. |
| AD-12 | NOTE | NOTE | The "error with rows" shape is unreachable (the error arm needs no rows rendered; a loadMore in flight across a head commit is `reconcileStale`). The two-place POP rule is by design (the hook seeds, the page applies). Handback. |
| AD-13 | NOTE | FILE | A PUSH to `/inbox` right after marking a row unread on its contact/thread page restores the snapshot that folded in the earlier mark-read patch, so that row shows read for one round trip. The symmetric case of the spec 5.8 accepted staleness, but it is the navigation whose purpose is to show the row unread. Out of scope by the Task 7b ruling (nothing outside the Inbox page changes for navigation); filed as `inbox-restore-shows-row-read-after-mark-unread-jump` (low, improvement). |
| AD-14 | NOTE | NOTE | Branch I keeps rows read elsewhere showing unread until a complete head read - spec 5.6 ("replaced by the next complete head read"). Handback. |
| AD-15 | NOTE | FIX (docs) | Add the boundary-page reload cost (two requests and 100 rows re-added per SSE event for a reader parked past page one; a tiny `?limit` re-chains) to `docs/issues/inbox-loaded-pages-survive-refresh.md`. The behavior itself is the Option B trade the human accepted (spec 8). |
| AD-16 | NOTE | FIX (trivial) | `useInbox.test.tsx` builds the store key with `inboxListKey()`; `app/test/inboxFeed.test.ts` uses `HYDRATE_CONCURRENCY + 1` instead of the literal 9. The CSS-source test and the class-name assertions are by spec design (7.1). |

## Spec-conformance findings

SC-1..SC-11 are test-contract gaps, each reproduced with a mutant that the
committed suite does not catch. ALL are FIXED in this wave as new or
strengthened tests (no production change unless a test exposes a real
defect, which none did):

- SC-1 (= slice D gap 1): `useAutoLoad` - after an epoch move, a failed page
  (enabled flips without an epoch move) must NOT re-observe or fire.
- SC-2 (= slice D gap 2): an epoch that moves while DISABLED re-observes only
  once the hook is enabled, and fires once if still in view.
- SC-3: the unmount save's `ready` gate (invariant 7): a StrictMode mount with
  no snapshot and a head read that never settles leaves the store empty.
- SC-4 (= slice D gap 5): `Inbox.tsx` passes `enabled = hasMore &&
  autoLoadArmed && !loadingMore`, `epoch = pageEpoch`, `onLoad = loadMore` to
  `useAutoLoad` (mock the module, assert the options for each combination).
- SC-5: `isAdditive` on every filter - on Unread/Unknown/Groups a relay or
  group row is a PAGED row (a mutant treating it additive on Unread must fail).
- SC-6 (= slice C gap): `restoredKeyRef` update - a restored mount that
  switches tab and back resets (spinner) instead of showing the other tab's
  rows.
- SC-7 (= slice C gap): the reset clears `refreshFailed`, `pendingRef` and the
  scroll seed.
- SC-8 (= slice C gap 2): the key effect's `setLoadingMore(false)` - Load more
  is live on the new tab after a switch mid-page.
- SC-9 (= slice C gap 3): `markUnread` hook-level: optimistic patch, commit
  (epoch unchanged), rollback on failure, no commit after unmount.
- SC-10 (= slice C gap 1): the success-path generation guard - release the
  stale page inside an async act and assert the post-mutation count.
- SC-11: "Yesterday" across a local year boundary (Jan 1 now, Dec 31 yesterday).
- SC-12, SC-13: the small unit/e2e assertion gaps the report lists (read it).
- Slice D gaps 6-9 (restore-once latch, store-only guard, the scroll listener
  reporting `noteScrollTop`, the sentinel's `aria-hidden`) are pinned too.
- SC-14..SC-19: NOTES (SC-19 = the pre-existing `group-text-inbox.spec.ts:33`
  order dependence, FILED as `group-text-inbox-spec-depends-on-leftover-conversations`).

## Slice-G note

Under React Router 7 a `waitForURL` resolves before the route renders
(`startTransition`), so a back press right after it can cancel the
navigation. Filed as `e2e-waitforurl-does-not-prove-route-rendered` (low,
debt) so sibling specs can be swept later.

## Wave scope summary

Production code: `inboxTime.ts` (formatters), `InboxRow.tsx` (memo),
`inboxListMerge.ts` (null-cursor rule), `useAutoLoad.ts` (default factory
hardening), `app/src/routes/inbox.ts` (two comments), `AuthGate.tsx` (comment).
Spec: 5.6 (cursor rule) and 5.8 (cleanup-order sentence). Tests: the list
above. Docs: three existing issues updated, four issues filed. Re-review
follows as a FRESH reviewer briefed with this file and both round-1 reports.
