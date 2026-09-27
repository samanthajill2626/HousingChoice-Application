# Plan review round 1 - adjudications

Plan: `docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md`
Reviewed: v1 @d74bea0e against spec DRAFT 8. Result: plan v2 and spec
DRAFT 8.1 (precision edits the plan findings forced back into the spec).
Reviewers: A (`plan-r1-reviewer-a.md`, 20 findings), B
(`plan-r1-reviewer-b.md`, 16 findings). Heavy overlap; listed by theme.
Adjudicator: the planner (this session), 2026-09-25.

## Counts

- 36 findings; 33 accepted, 1 rejected, 2 accepted as wording only.
- Spec precision edits forced: 5.2 (the auto-load hook fires only from an
  observer REPORT; an epoch change re-observes), 5.8 (`restoreScroll` seeds
  the scroll ref inside the hook), 5.10 (the shared raw-message cache's effect
  on the unread branch stated), 5.11 (the perf classifier and the profiler
  plan hard-code the page size and move to 100; warm-sample readiness rule),
  4.1, 7.1 (the CSS-source test), 7.3 (rows are named by formatted phone;
  tests 2/3 assert request ORDER and chain-first at a tiny limit; test 4's
  long name moves to self-QA; test 6 at limit 15). No product decision
  changed.

## Themes and verdicts

1. jsdom has no `document.scrollingElement` (A3, B1; BLOCKING). ACCEPT.
   Verified: jsdom 25 leaves it undefined. `scrollParentOf` falls back to
   `document.documentElement`; the page test assigns through the same
   fallback (Task 7).
2. Fake-Twilio parties are unknown rows named by formatted phone (A2, B2;
   BLOCKING). ACCEPT. `registerParty` registers a persona on the fake only;
   the app has no contact. Task 9 locates rows by `displayOf(number)`; the
   long-name/placement-tag case cannot be minted and moves to live self-QA
   (spec 7.3 test 4 revised).
3. The perf classifier accepts only `limit=30` (A1, B4; BLOCKING). ACCEPT.
   Verified at `collect.ts:183-190` and `collect.test.ts`. New Task 10b moves
   the classifier and the profiler plan to 100; spec 4.1/5.11 revised; Task
   11's "do not edit the harness" replaced by the rule in spec 5.11.
4. Auto-load re-checks stale intersection after a page commit and loads two
   pages per scroll (A4; BLOCKING). ACCEPT. The hook now records observer
   REPORTS; an epoch change re-observes and fires only from the fresh report
   (Task 6 rewritten; spec 5.2 revised). This also settles A6/B6 (the
   `lastFiredEpochRef = -1` bug): there is no epoch comparison any more.
5. The existing test at `useInbox.test.tsx:781` pins the old failure rule
   (A5, B5; HIGH). ACCEPT. Task 5 names it and supplies its rewrite on the
   path that still sets `loading` (the filter effect); every OTHER failing
   test remains a regression to fix in the hook.
6. Tests 2 and 3 at `?limit=2` race auto-load (A9, B3; HIGH). ACCEPT. Both
   assert the SETTLED chain and request ORDER (a head read first, cursor
   requests only after it), never an exact head-read count (A12 as well).
7. Task 5's typecheck fails on `Inbox.test.tsx`'s `baseState` (A10, B7).
   ACCEPT. The five fields are added in Task 5; Task 7 only re-points
   `noteScrollTop` at a spy.
8. Task 8's `splitSeed()` out of scope (A8, B8). ACCEPT. Fixture inlined.
9. Task 8's red step and DynamoDB requirement (A11, A16, B9). ACCEPT. The
   step now says what is honestly red (typecheck) and that the equivalence
   tests are a regression net; `npm run db:start` first. The stop-flag bound
   is made a property of the code with `slowReads` (macrotask reads) and a
   sequential-arm control.
10. 404 arm saves an empty ready snapshot; reset zeroes the epoch (A18, B10,
    B11). ACCEPT. Status before the empty commit; the epoch is carried on
    both paths; the epoch test asserts the reset.
11. Seeded `scrollTop` under StrictMode (B12). ACCEPT. A fourth hook argument
    `restoreScroll` seeds the ref at lazy init (spec 5.8 revised); the page
    passes `navigationType === 'POP'`; the page test asserts it.
12. No unit pin for `overflow-anchor: none` (A13, B12). ACCEPT.
    `Inbox.styles.test.ts` on the CSS source, the repo's own pattern.
13. `inboxDiagnostics.ts` profiles 30-row pages (B13). ACCEPT. Task 10b.
14. Task 8 touches the unread branch through the shared raw-message cache
    (B14). ACCEPT as wording: spec 5.10 now states the exposure exactly (one
    fewer read of the same value within a request).
15. Whole-file replacement deletes the guard comments (A15, B15). ACCEPT.
    Task 5 lists the six comment blocks to carry over verbatim from `main`
    and names the one that is replaced because its residue is resolved.
16. Commit trailer hard-coded to Fable (A19, B16). ACCEPT. `<authoring
    model>` placeholder with the rule in Global Constraints.
17. InboxRow test expected "Jun 30" 26 hours before the pinned clock (A7).
    ACCEPT. Fixture moved to Jun 25.
18. Tests not matching their names; missing degraded-fallback memoization
    test (A17). ACCEPT. The epoch test now asserts the reset; the
    throwing-phone test asserts the lookup count matches the sequential arm.
19. Test 4 drops the placement tag and long name (A14). ACCEPT as the spec
    revision in theme 2: the lean world cannot mint it; self-QA covers it.
20. Warm perf samples can revisit `/inbox` (A20). ACCEPT. Spec 5.11 and Task
    11 now make the hermetic run the arbiter and name the harness change
    allowed if a warm sample fails.
21. REJECT (A17, part): "the 404-with-rows test does not check what its name
    claims". The test drives a 404 through Retry with rows present and
    asserts `ready` + `refreshFailed` + the rows kept, which is spec 5.7's
    404-with-rows rule; the reviewer's reading assumed the 404 had to arrive
    through the SSE path. Either path exercises the same failure arm.

Round 2 goes to reviewer A (continued; it found the stale-report chain and
the perf classifier first), with B's report path.
