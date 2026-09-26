# Spec review round 2 - adjudications

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`
Reviewed: DRAFT 3 @dcedfcc9. Result: DRAFT 4.
Reviewer: A, continued (`spec-r2-reviewer-a.md`, 17 findings). A conceded both
round-1 rejections (the mockup half of A17, the pinning test in A19).
Adjudicator: the planner (this session), 2026-09-25.

## Counts

- 17 accept, 0 reject.
- Decisions changed by this round: 5 (listed at the end). Round 3 is required
  and is expected to be the terminal round.

## Findings

1. HIGH, auto-load can chain at the group wall (growth re-check + scroll
   anchoring + pages inserting above old group rows). ACCEPT. Verified: the
   scroller has no `overflow-anchor` rule; the timeline opts out on its own
   stream. The list gets `overflow-anchor: none`, the re-check moves from a
   row-count trigger to a commit `epoch`, and e2e test 6 proves a bounded
   cursor count at the group-wall shape (5.2, 5.9, 7.3). DECISION CHANGED.
2. HIGH, the boundary rule assumes page one is cut by `lastActivityAt`; false
   on Unknown (queue order) and Unread (walk key vs displayed time). ACCEPT.
   Verified against the cited inbox.ts comments. The merge now has two
   models: provenance on All and Groups, replace-on-complete-head on Unread
   and Unknown, with an incomplete head changing nothing (5.6). DECISION
   CHANGED.
3. HIGH, tail rows are never refreshed; the stated exits do not exist. ACCEPT.
   The mount reconcile now RE-WALKS the tail (one read per tail page) so
   every return to the page refreshes the whole list, including the row the
   operator just triaged; the residue (non-activity changes while staying on
   the page) is stated in 4.2, 8 and filed (5.8, 9). DECISION CHANGED.
4. MEDIUM, `cursor ?? C` re-walks a fully loaded list. ACCEPT. A kept tail
   keeps its cursor INCLUDING null; e2e test 2 asserts no cursor request
   after the inbound (5.6, 7.3).
5. MEDIUM, a zero-row budget-exit head on Unread with `C === null` wipes the
   list. ACCEPT. `headComplete` now requires `!truncated`; a zero-row
   incomplete head with rows present changes nothing and shows the banner
   (5.6, 5.7).
6. MEDIUM, `rowsVersion` is the wrong re-check trigger. ACCEPT. Replaced by
   `epoch`, bumped on every committed head read or loadMore, never on failure
   (5.2, 5.5).
7. MEDIUM, commit-point saves outlive the hook. ACCEPT. `aliveRef` gates
   every commit and save; loadMore is aborted on unmount (5.5, 5.8).
8. MEDIUM, commit-point saves have no source for the committed value. ACCEPT.
   `commitList` is the single writer over an authoritative `listRef`; no
   functional updater touches the list, so the saved snapshot is the committed
   value (5.5). DECISION CHANGED (state mechanism).
9. MEDIUM, the scroll ref is not seeded. ACCEPT. Seeded from the restored
   snapshot at mount (5.8).
10. MEDIUM, `.name { max-width: 40% }` resolves against `.head`. ACCEPT. The
    cap moves to `.head` (a child of the link); wide-viewport assertion that an
    ordinary name is not ellipsized (5.4, 7.3).
11. LOW, refs written every render fail `react-hooks/refs`; the passive
    alternative reopens a stale window. ACCEPT. The observer callback only
    records `intersecting`; an effect over `[intersecting, enabled, epoch]`
    fires `loadMore`, which is current by construction; no ref written in
    render and no stale closure (5.2).
12. LOW, the mount reconcile re-arms immediately. ACCEPT. Arming is set only
    by the read that installs the current chain; on Unread/Unknown the head
    read replaces the chain (so re-arming is right); on All/Groups a head read
    that keeps a tail leaves `autoLoadArmed` unchanged (5.2, 5.6).
13. LOW, boundary ties. ACCEPT. `<=`, ties kept (5.6).
14. LOW, "the server returns every additive row on every head read" is false.
    ACCEPT. Absent additive rows are dropped only when their kind returned at
    least one row; group texts outside the page-one cap are kept under
    `groupsTruncated`; the residue is stated (5.6, 8).
15. LOW, 5.10 details. ACCEPT. Memoize the RAW message read, not the derived
    result; new contact-lookup caches (no existing one); a `stop` flag ends
    scheduling when the page fills; the shared caches and the lagged-retry
    delete are addressed; the equivalence test excludes WARN counts (5.10).
16. LOW, factual slips. ACCEPT. `me.userId`; `useOptionalAuth()` so the hook
    tests need no provider; `AuthGate.tsx`/`AuthContext.tsx` in scope; the
    sidebar is 240px and the tightest band is 768px; `767.98px` (2, 4.1, 5.1,
    5.4, 7.3).
17. LOW, "never detached" needs an ElementHandle. ACCEPT (7.3 test 2).

## Decisions changed this round (planner's list)

1. Two merge models by tab (provenance on All/Groups, replace on
   Unread/Unknown) instead of one boundary rule for all tabs.
2. The tail is re-walked on every return to the page (one read per tail
   page), so a return refreshes the whole list.
3. Auto-load re-checks on a commit epoch, from an effect, with
   `overflow-anchor: none` on the list; arming is owned by the read that
   installs the live chain.
4. `commitList` over an authoritative ref is the single list writer, with an
   `aliveRef` gate; no functional updaters on the list.
5. A kept tail keeps its cursor including null; `headComplete` honors
   `truncated`.

Round 3 goes to reviewer A (continued) under the re-review charge.
