# Spec review round 1 - adjudications

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`
Reviewed: DRAFT 1 @463a1f0e. Result: DRAFT 3 (DRAFT 2 folded B, DRAFT 3 folded A).
Reviewers: A (`spec-r1-reviewer-a.md`, 27 findings), B (`spec-r1-reviewer-b.md`, 18 findings).
Adjudicator: the planner (this session), 2026-09-25.

Verdicts: ACCEPT = the spec changed; REJECT = it did not, with the reason;
DEFER = filed or noted for a later change. "Decision changed" is the
planner's call, not the reviewer's severity.

## Counts

- A: 23 accept, 2 reject, 2 overtaken (fixed by DRAFT 2 before A landed).
- B: 16 accept, 1 reject, 1 partial.
- Decisions changed by this round: 7 (listed at the end). Round 2 is required.

## Reviewer B

1. BLOCKING, merge rule slices `base` by index while page one mixes contact
   and additive group rows. ACCEPT. Verified: `limit` counts contact rows
   (inbox.ts:2298-2303), page one is re-sorted with relay rows (2418-2424).
   The whole model is replaced: head/tail by PROVENANCE (5.5), a merge that
   classifies rows as additive (All-tab relay/group) or paged and keeps rows
   that slid past the head boundary (5.6). The head read is always `limit`
   rows, so the `?limit` knob now tunes every read. DECISION CHANGED.
2. HIGH, invariant 1 not delivered for short heads. ACCEPT. `headComplete`
   distinguishes a budget-short page with a cursor (keep everything) from a
   feed that ended (drop absent rows). Invariant 1 restated honestly.
   DECISION CHANGED (part of 1).
3. HIGH, observer lifecycle contradictions. ACCEPT. One stable observer per
   mount, callback reads state through refs, growth-triggered re-observe is
   the only programmatic re-check, arming lives in the hook and in the store
   (5.2). DECISION CHANGED.
4. HIGH, Retry refresh blanks the list and a failed retry strands a spinner.
   ACCEPT. `retry()` with rows keeps `ready`; a failed retry keeps the banner
   (5.7). DECISION CHANGED.
5. MEDIUM, 5.10 misdescribes where the dedupe lives; cache race. ACCEPT.
   Verified: value-memoized check-then-await-then-set (inbox.ts:842-865),
   dedupe inside `rowForConversation` (1150, 1189). 5.10 is rewritten as a
   PREFETCH through promise-memoized caches; the decision loop is untouched,
   so telemetry and dedupe are byte-identical. DECISION CHANGED (mechanism).
6. MEDIUM, passive-effect unmount reads `scrollTop` 0. ACCEPT. Scroll
   listener into a ref + layout-effect cleanup save (5.8).
7. MEDIUM, empty snapshots, mis-keyed saves, unspecified mount bypass. ACCEPT.
   Saves only at commit points while `ready`, key captured at commit;
   `restoredKeyRef` rule that survives StrictMode (5.8).
8. MEDIUM, store row shape stated two ways. ACCEPT. One shape: `patched`,
   server order, not narrowed, not sorted (5.8).
9. MEDIUM, actions box reserves width; times ragged. ACCEPT. The actions box
   becomes an absolute overlay with no layout width (5.4). Sam approved the
   aligned-column mockup, so this is what delivers it. DECISION CHANGED
   (layout mechanism).
10. MEDIUM, Playwright plan wrong about the lean world. ACCEPT. Reseed in
    `beforeEach`, counts include the two multi-party rows, test 3 proves the
    container scrolled at a 500px viewport (7.3).
11. MEDIUM, perf:pages harness not enumerated. ACCEPT. Section 5.11 and the
    hermetic self-QA as a gate. Analysis of the harness flows (goto source,
    one click) shows no flow visits `/inbox` twice, so no restore occurs.
12. LOW, seen-set zero margin now on the live path. PARTIAL. The issue's
    reachability paragraph is updated (section 9); the pinning boundary test
    stays out of this mission (scope).
13. LOW, exclusion list not in the spec. ACCEPT. Listed in 4.2.
14. LOW, `limit` clamp vs fall back; groups link drops `limit`. ACCEPT. Fall
    back everywhere (matches the server below its range); the groups link and
    `selectFilter` preserve it (5.1).
15. LOW, factual slips (860 vs 768, "same window today", `savedAt`). ACCEPT.
    Section 2 corrected; the stale-count window is described as new; `savedAt`
    removed.
16. LOW, 404 arm empties a healthy list; `refreshFailed` not reset on filter
    change. ACCEPT. A 404 with rows rendered is a refresh failure; the reset
    clears `refreshFailed` (5.7).
17. LOW, UTC-day boundary test is TZ-dependent. ACCEPT. Cases built with local
    constructors; the offset case is guarded (7.1).
18. LOW, bigger heads starve paging. ACCEPT as a stated trade-off (section 8);
    the head read is `limit` rows, not `min(loaded, 100)`, and the growth
    re-check re-issues a discarded page.

## Reviewer A

1. BLOCKING, merge rule loses the row pushed off the head; fires on page one.
   ACCEPT. Same as B1. DECISION CHANGED.
2. HIGH, invariant 1 is a slogan. ACCEPT. Same as B2.
3. HIGH, Retry refresh spinner strands. ACCEPT. Same as B4.
4. HIGH, sign-out `clear()` broken by parent-first deletion order. ACCEPT.
   Verified against A's citation of react-dom's deletion traversal. `clear()`
   runs from a PASSIVE effect in `AuthGate` on the unauthenticated transition
   (after every deleted child's cleanup), and the store key carries the
   operator id as a second lock (5.8). DECISION CHANGED (store key).
5. HIGH, auto-load mechanism contradictions. ACCEPT. Same as B3.
6. HIGH, "cannot emit twice" false; `?? conv` fallback. ACCEPT. The prefetch
   rewrite leaves the loop untouched; the equivalence fixture now includes a
   failing conversation-set lookup (5.10).
7. MEDIUM, telemetry not untouched under concurrency. ACCEPT. Same as B5;
   the loop is unchanged so counts are identical by construction.
8. MEDIUM, kept unread cursor's seen-set re-emits contacts. ACCEPT. Verified:
   the unread path's identity is the seen-set (inbox.ts:1434-1438) and
   `loadMore` appends without dedupe (useInbox.ts:343). `loadMore` now
   dedupes appended rows by `rowKey` against `base` (5.5).
9. MEDIUM, store save/load underspecified. ACCEPT. Same as B7/B8.
10. MEDIUM, `scrollTop` read after the route swap. ACCEPT. Same as B6.
11. MEDIUM, restore fires on every mount, not only Back. ACCEPT. Rows restore
    on any mount; SCROLL restores only under `useNavigationType() === 'POP'`
    (5.8). DECISION CHANGED (a product rule the draft made by accident).
12. MEDIUM, latency claim covers one tab. ACCEPT. Stated in 5.10 and section
    8; `inbox-unread-page-hydration-sequential` filed (section 9).
13. MEDIUM, row layout arithmetic. ACCEPT. Actions overlay (as B9); the name
    can shrink in the one-line layout (`max-width: 40%`, ellipsis); time
    `min-width: 5rem`; the narrow breakpoint moves to 767px (the shell's), so
    the one-line layout never runs on a drawer-mode width; test 4 adds a
    bounding-box check at 800px (5.4, 7.3).
14. MEDIUM, auto-loaded pages land above page one's old group rows. ACCEPT as
    a stated consequence of decision 4 (5.9). Not a decision change: the
    deferral to tracker #24 stands.
15. MEDIUM, module-level store makes existing tests order-dependent. ACCEPT.
    `clear()` in `beforeEach` of every inbox test file (7.1).
16. MEDIUM, Playwright cases cannot run as written. ACCEPT (same as B10); the
    "Unread empty-page-with-cursor" case was already replaced in DRAFT 2 by a
    unit-only proof of the disarm rule.
17. MEDIUM, exclusion list missing; visual contract depends on a mockup.
    ACCEPT the list (4.2). REJECT the mockup half: 5.4 describes both layouts
    in words a builder can build from (elements, order, widths, breakpoint,
    weights); the mockup is Sam's approval record, not the contract.
18. LOW, "same stale window exists today" false. ACCEPT. Same as B15.
19. LOW, seen-set boundary not cited or pinned. PARTIAL. Same as B12.
20. LOW, U+202F before AM/PM. ACCEPT. Both helpers normalize to U+0020 the
    way `localTime.ts` does (5.3).
21. LOW, TZ-dependent unit test. ACCEPT. Same as B17.
22. LOW, `?limit` dropped by the nav link. ACCEPT as wording: the knob is a
    URL you open, the nav resets to the default (5.1).
23. LOW, `R` must be read through a ref. OVERTAKEN. `R` no longer exists; the
    head read requests `limit`, a hook parameter.
24. LOW, breakpoint facts. ACCEPT. Section 2 corrected; the 767px choice and
    its reason are stated (5.4).
25. LOW, `savedAt` never read. ACCEPT. Removed.
26. LOW, perf harness warm-mode readiness. ACCEPT. Same as B11; 5.11 records
    that no harness flow visits `/inbox` twice.
27. LOW, `lastActivityAt` is not the last message's time. ACCEPT as one
    sentence in section 2 and 5.3 so nobody "fixes" it.

## Decisions changed this round (planner's list)

1. List model: head/tail by provenance with a classifying merge (was: index
   slicing with a size-to-loaded reconcile).
2. Head read size: always `limit` (was: `min(max(loaded, limit), 100)`).
3. Auto-load: one stable observer, growth re-check, arming in the hook and the
   store (was: unspecified lifecycle).
4. Retry with rows keeps `ready`; a 404 with rows is a refresh failure (was:
   today's `retry()`).
5. Actions box becomes an overlay with no layout width (was: in-flow).
6. Store key includes the operator id; `clear()` from `AuthGate`'s passive
   effect; scroll restore only on `POP` (was: filter+limit key, unspecified
   seam, restore on every mount).
7. Server slice: prefetch through promise-memoized caches with the decision
   loop untouched (was: concurrent hydration with a sequential dedupe pass).

Round 2 goes to reviewer A (more unique accepted findings), with B's report.
