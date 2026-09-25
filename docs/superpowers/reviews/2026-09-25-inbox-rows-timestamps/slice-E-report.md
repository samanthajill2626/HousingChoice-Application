# Slice E report - inbox rows + timestamps (plan Task 8, server prefetch)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`. Implementer: Claude
Opus 5.5 (1M context). I touched only `app/src/routes/inbox.ts` and
`app/test/inboxFeed.test.ts`. No excluded file (spec 4.2) was needed. The
separability rule did not trigger: the loop's order, decisions and telemetry
are unchanged. Logs are in the ignored `.superpowers/sdd/sliceE-*` files.

## Commit

- `b90ab890` perf(inbox): prefetch per-row reads on the all-tab pager
  through promise caches. 357 lines added, 73 removed.

## Tests and gates

All commands ran bare from the worktree.

- **Red (Step 3):** `-t "prefetch equivalence"` exited 1 with 1 failed,
  5 passed and 62 skipped. The only red was the stop-flag test's
  `toBeGreaterThan(1)` ("expected 1 to be greater than 1").
- **Green:** `inboxFeed.test.ts` passed 68 tests (62 existing plus 6 new),
  exit 0. The HEAD baseline was 62 passed.
- **Whole app suite (`npm run test -w app`):** two runs.
  - Run 1: exit 0. 366 files, 6876 passed, 1 skipped. Vitest reported
    122.85 s; wall time was about 2m05s.
  - Run 2: exit 0 with the same counts. Vitest reported 133.32 s; wall time
    was about 2m15s. I re-ran because I made throwaway probe and mutant
    edits after run 1. The blob hashes of both files were the same before
    and after run 2, and the committed blobs match them.
  - Neither run printed a `[dynamoAdmin]` line.
  - The 1 skip is the existing "built dashboard identity tags" diagnostic.
    It skips because no dashboard build exists.
  - All ten files that reach the pager passed: inboxFeed 68, inboxApi 58,
    voiceInboxActivity 23, inboxGroups 21, inboxUnknownTab 19,
    performanceSeed.integration 12, inbox.integration 11,
    inboxUnknownParity 7, inboxUnreadParity 6 and inboxEmail 4.
- **Typecheck:** exit 0.
- **eslint on the two files:** exit 0, no output. The HEAD baseline was also
  clean.
- **ASCII:** the 357 added lines contain 0 non-ASCII bytes. One re-indented
  comment line had a U+2014 (the boundary-Query comment, old :2333). It now
  has a hyphen.

## Worklist S8 items 8-14

- **8.** The `slowReads` delay is at `inboxFeed.test.ts:250`, after the
  counter at :245. A comment explains why it comes after.
- **9.** `inboxPrefetch` is at `inbox.ts:216`, after
  `unknownQueueScanBudget`. The TEST SEAMS doc comment at :199-208 is not
  split.
- **10.** I carried the full live comment into the promise version word for
  word, only re-indented (`inbox.ts:871-881`).
- **11.** `prefetch?.stop()` runs as the first statement of the page-full
  block (`inbox.ts:2440`), before the boundary Query. The `finally` stop
  remains at :2464. No decision, count or cursor line changed. The only
  changes in the loop are the 2-space re-indent and the dash fix.
  - Residual: no new chain can start after the page fills. At most 8
    in-flight chains finish their current cache read. Also, a read chain
    that has already started finishes its remaining reads, for example
    `conversationsForContact`'s per-phone loop, or `findByEmail` after a
    phone miss. This is the spec's "chains in flight finish".
  - Measured in the stop-flag fixture: 8 latest-message reads, 9
    `findByPhone` and 9 `findByParticipantPhone`. A 9th chain started before
    the page filled and stopped at the check before its latest-message read.
  - A `finally`-only variant measured the same, because the in-memory
    boundary query resolves in microtasks. The early stop matters against a
    real boundary-Query round trip.
- **12.** I re-indented the wrapped inner loop by hand (`inbox.ts:2425-2465`).
- **13.** The whole app suite was the gate, and it was green twice. I also
  checked that the tests catch a wrong cache key with two throwaway mutants
  (both reverted, hashes verified):
  - M1 keyed the contact lookup by email only. 7 existing `filter=all` tests
    went red, plus 2 prefetch tests whose failures did not come from
    comparing the two arms.
  - M2 gave the raw-message cache a constant key. 4 existing tests and 5
    prefetch tests went red. Aliasing makes the result depend on read order.
  - Neither net can catch a key bug that does not depend on read order, such
    as `''` versus absent. The first divergence below makes the key
    injective, so that class cannot happen.
- **14.** The reworded comment is at `inboxFeed.test.ts:2516-2524`. It says
  the counts can differ only upward on the prefetch arm, and names both
  causes: conversations the loop never reaches, and the three drops that
  happen before the latest-message read.

## Divergences from the plan's code

1. **`resolveContact` key** (`inbox.ts:901-907`). I use
   `JSON.stringify([phone ?? null, email ?? null])` instead of the plan's
   pipe-joined string. The joined key treats an absent value and `''` as
   the same key, but the two take different branches. An absent phone skips
   `findByPhone`. An empty phone calls it, which throws on DynamoDB and
   skips the email lookup. The joined key also assumes no phone contains
   `|`. JSON is injective over `string | undefined`, and item 13 shows no
   test could detect this difference.
2. **Cache-block comment** (`inbox.ts:784-792`). I folded it under the
   existing "Per-request memoization" line instead of adding a second one.
   It also notes that `placementLabelCache` stays a value cache, which the
   prefetch never reads.
3. **Item 11 additions.** I added the page-full `stop()` and its comment,
   plus a comment above the prefetch start (`inbox.ts:2420-2423`).
4. **Dash fix.** I replaced U+2014 with a hyphen on the re-indented boundary
   comment, because of the ASCII rule for touched lines.
5. **Test comments only.**
   - I moved the fixture's JSDoc from `mixedBase` to `mixedSeed`, the
     function it describes.
   - I reworded "(this is the red line before Step 5)" so it does not cite
     plan steps.
   - I added the slowReads comment (item 8) and the item 14 wording.

Everything else is the plan's code as written.

## Worth an eye (not blocking)

- **Shared keys.** The loop and a worker can ask for the same key in the
  same tick. The promise is stored immediately after the async IIFE's
  synchronous prefix, with no await between the get and the set, so both
  callers share one read. That prefix cannot re-enter the same cache.
- **Reads the loop would not make.** Each is bounded by one chunk, and spec
  5.10 accepts them:
  - the latest message for conversations dropped as `notNewestConv`,
    `deletedNoUnread` or `noContactNoPhone`;
  - up to 8 chains past the end of the page;
  - a conversation-set lookup for already-emitted contacts, which is a cache
    hit in practice.

  WARNs from these degraded paths can come from conversations the loop never
  consumed. They can also be logged after the `inbox feed assembled` line,
  because in-flight chains outlive the response.
- **First writer of `contactConvsCache`.** A later conversation's chain can
  now win the race to fill the cache for a contactId. With static data the
  result is identical. Under a concurrent contact write, the cache holds a
  different but valid snapshot, the same class of race as today's cache.
- **Unread and unknown branches.** The raw-message cache also serves these
  branches (spec 5.10 and the worklist's spec-drift note). A failed read's
  fallback is now reused within the request instead of being re-read.
- **Profiler.** `app/scripts/profile-inbox.ts:117` now runs with prefetch
  on. S10 files that as worklist item 17. I did not touch it here.
