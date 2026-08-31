# Rework slice 3 - the Unknown tab becomes pageable and unbounded

Commit: **1ceb2e52** `feat(inbox): page the Unknown tab in queue order, untriaged block first`
Branch: `feat/inbox-unread-cluster` (on top of `3029fe63`, slice 2)
Files: 10 changed, +1330 / -804

---

## What shipped

The `filter=unknown` branch no longer reads the whole `(type='unknown')`
partition, sorts it in memory and serves one window with `nextCursor: null`. It
now reads STATUS BLOCKS in queue order and pages them with the index's own
cursor.

### 1. Blocks, in one named decision

`app/src/lib/unknownQueue.ts` exports `UNKNOWN_QUEUE_BLOCKS` - an ordered
`readonly {type, status}[]`, derived (never hand-listed) from two exhaustive
maps:

- `UNKNOWN_TAB_TYPE_DECISIONS` - `satisfies Record<ContactType, ...>` (kept from
  the previous slice; still the only 'queried' type is `unknown`).
- `UNKNOWN_QUEUE_STATUS_ORDER` - new, `satisfies Record<UnknownQueueStatus,
  number>` where `UnknownQueueStatus = (typeof NON_TENANT_STATUSES)[number]`.
  `needs_review: 0`, `active: 1`.

`NON_TENANT_STATUSES` is exactly what `statusAllowlistFor('unknown')` returns,
so the compile-time tie is to the same array. The RUNTIME half is pinned too
(`unknownQueue.test.ts`, "the block statuses ARE statusAllowlistFor('unknown')")
because a change made INSIDE `statusAllowlistFor` - a special case for `unknown`
- would not move the type alias.

Requirement 9 (stay swappable) is satisfied by keeping this the ONLY place that
knows which partitions in what order; the comment on it names
`docs/issues/denormalize-contact-last-activity-for-ordered-paging.md` as the
change that would replace it.

**Coverage did not narrow.** Both blocks are read, so class (f) -
`(unknown, active)` contacts - is on the tab exactly as before. The parity suite
confirms this without a single pin changing.

### 2. Cursor format, and why

`{ q: 1, b: <block index>, k?: <byTypeStatus ExclusiveStartKey> }`, base64url'd.

- `q` is the NAMESPACE TAG, matching the file's existing convention: `all` is a
  bare LastEvaluatedKey (no tag), `groups` carries a string `t`, `unread` a
  numeric `u`. Every decoder rejects the tags that are not its own, so a foreign
  cursor is an `InboxBadRequestError` (400) and never a wrong-partition Query.
  I added the reverse guard too - `decodeCursor` (the `all` path) now 400s a
  numeric `q`.
- `b` is fully ours so it is fully validated: integer, `0 <= b <
  UNKNOWN_QUEUE_BLOCKS.length`. Out of range is a 400, which is also the right
  answer for an OLD-but-honest cursor after a status leaves the allowlist.
- `k` is a repo-defined ExclusiveStartKey, so its KEY NAMES are deliberately not
  pinned (same posture `decodeCursor` documents). Its VALUES are checked to be
  non-empty strings - that is the one tamper that turns a 400-by-design into a
  500, because DynamoDB permits an empty String on non-key attributes only and
  the resulting ValidationException is unmapped. This is the same trap the
  unread decoder's adversarial-A4 fix closed.
- Absent `k` means "the block's first page", which is ALSO how a roll-over is
  expressed - one shape covers both states, so a block boundary needs no special
  case on either side of the wire.

**Where `k` comes from, and why it is not a page LastEvaluatedKey.** Each row the
reader returns carries its own `after` position, synthesized as
`{ type, status, contactId }` from the BLOCK's type/status plus the contact's own
id. That is a valid byTypeStatus ExclusiveStartKey (index keys + table key) and
it lets the branch stop EXACTLY where its page filled. A page LastEvaluatedKey
could only name a PAGE boundary, so a caller filling mid-page would have to
either overshoot `limit` or discard rows it had already read. Using the block's
type/status (rather than the item's) means a malformed stored image cannot
produce a key pointing into a different partition.

### 3. How block roll-over works

`readUnknownQueue` loops while `block < blocks.length`, breaking on `want`
reached or budget spent:

- Query `listByType(type, { status, limit: pageSize, exclusiveStartKey })`.
- Push every returned item as a row with its `after`.
- **No `lastEvaluatedKey` -> the block is exhausted:** `block += 1`, `key =
  undefined`, keep going (so a half-empty needs_review block flows straight into
  `active` within one request).
- **`lastEvaluatedKey` present:** `key = lastEvaluatedKey`, same block.

At the end, `next = block >= blocks.length ? undefined : { block, key }`.
`next === undefined` is the ONE and ONLY thing that ends paging.

The inbox branch drives an outer fill loop over that: consume rows, apply the
type belt / `emitted` guard / thread resolution, stop at `limit` kept and set the
boundary to that row's `after`; otherwise take `read.next` as the boundary (it is
ahead of the last row's `after` when the final page ended in residue, which saves
re-reading it) and go again.

### 4. Scan-budget behaviour

`UNKNOWN_QUEUE_SCAN_BUDGET = 1000` raw index rows per REQUEST, seam
`deps.unknownQueueScanBudget`.

Charged in rows EXAMINED, not returned: DynamoDB applies `Limit` before the
FilterExpression and returns a LastEvaluatedKey exactly when the Limit was
reached, so a page WITH a key examined precisely `pageSize` rows however few it
returned. Charging rows returned would make a residue-only partition free and the
budget unable to stop it. (Pinned: "charges the budget in index rows EXAMINED".)

On expiry the request returns the rows found SO FAR plus the cursor it stopped
at. It does **not** set the wire `truncated` flag - commented at the break, with
the reason: `truncated` is the unread branch's contract and lights the
dashboard's failure banner, which is not filter-gated. The cursor is the
continuation signal; `truncated` is an error signal.

Named honestly in the code and in the test: a budget-stopped page that keeps ZERO
rows returns an EMPTY page WITH a cursor, so the dashboard shows its ordinary
empty state plus a live Load more. Odd-looking, honest, and not the failure
banner.

Also recorded (new, found by the integration test): at an EXACT page multiple the
walk costs one extra empty round trip. A queue of `n * limit` rows fills its last
page at its last row, so a cursor is minted and the next request returns
`rows: [], nextCursor: null`. Proving "nothing is behind this position" costs a
Query; the spurious Load more is the accepted trade - the same one DynamoDB's own
LastEvaluatedKey makes. Commented at the mint site and pinned in the integration
test.

### 5. Hydration

`buildContactRow` moved OUT of the filtering loop. During filtering only the
thread resolution runs (it decides "kept"); the kept contacts are held as
`{contact, open, maxConv, unreadSum}` and hydrated after the loop, once per row
RETURNED. Pinned by "THE COST IS THE PAGE, NOT THE PARTITION": a 10-contact
queue at `limit: 2` costs 1 block Query, 2 `findByParticipantPhone`, 2
`listByConversation`.

### 6. Kept

- The live type re-check (`roleFromContact !== 'unknown'` -> `unknownQueueRetyped`)
  - still structurally unreachable from a real Query, still cheap, still tested
  through an override.
- The `emitted` duplicate guard, with a new comment stating it is PER-REQUEST and
  cannot dedupe across pages (the cursor carries a position, not a set; the
  unread branch pays for its cross-page seen-set with a hard depth cap, which is
  the boundedness this feed exists to escape).
- Requirement 4's thread-read failure discrimination: `resolveOpenThreads` still
  calls `conversationsForContact` directly (not the best-effort seam), still
  withholds ONE row with its own WARN and its own `unknownThreadReadFailed`
  counter, still distinct from `unknownNoOpenThread`.
- LOUD-BY-CONTRACT: a failed block Query propagates to the route's 500.

### 7. Deleted

| Deleted | Where |
| --- | --- |
| `UNKNOWN_QUEUE_MAX_ROWS` (result cap) | `unknownQueue.ts` |
| `UNKNOWN_QUEUE_MAX_PAGES` (page budget) | `unknownQueue.ts` - subsumed by the scan budget |
| `collectUnknownTriageQueue`, `UnknownQueueResult` (`contacts`/`pagesWalked`/`truncated`) | `unknownQueue.ts` |
| The truncation WARN + `keptNeedsReview` / `collectedNeedsReview` | `unknownQueue.ts` |
| The "could not show every triage row" window WARN | `inbox.ts` |
| `unknownQueueMaxRows`, `unknownQueueMaxPages` seams | `InboxRouterDeps` |
| Log fields `queueContacts`, `queuePages`, `queueTruncated` | `inbox.ts` |
| Test `THE CAP STARVES needs_review` | `unknownQueue.test.ts` |
| Tests `a cap-cut queue`, `windows the sorted result ... and WARNs` | `inboxUnknownTab.test.ts` |

Added seams: `unknownQueuePageSize` (kept), `unknownQueueScanBudget` (new).
Added log fields: `queueRows` (contacts consumed), `queueQueries`,
`queueScanned`, `hasMore`, `budgetStopped`. No orphaned imports or constants -
gate 5 is clean on every touched file (see below).

---

## Tests

### Parity: UNCHANGED, all 7 green

No pin edited, no fixture edited. `test/inboxUnknownParity.test.ts` passes
byte-identical - which is the safety net working: classes (a), (b), (c), (d),
(e), (f) and the core case are mechanism-independent and stayed that way across
a total rewrite of the read.

### New pins

`app/test/unknownQueue.test.ts` (11 tests, was 8):

- blocks read in queue order, narrowing on nothing else (probes for
  `excludeOrigin` / `deleted` intact)
- **the UNTRIAGED block is exhausted BEFORE the reviewed block is read** - the
  replacement for the deleted starvation pin. With a `want` only one block can
  satisfy, `calls` has length 1 and its `status` is `needs_review`: the reviewed
  block is never queried.
- fill past soft-deleted residue (kept, retuned for the block count)
- ROLLS OVER between blocks; only the LAST block ending stops paging
- an exhausted block that fills `want` EXACTLY hands back the NEXT block, not
  `undefined` (the boundary case that would otherwise strand every `active` row
  behind a null cursor)
- the SCAN BUDGET hands back a position and the row behind the wall is reachable
- budget charged in rows EXAMINED
- every row's resume point is exact (replay yields the next row, never a repeat)
- constants; class (g) map/derivation; blocks-equal-allowlist

`app/test/inboxUnknownTab.test.ts` (13 tests):

- **THE FULL WALK** - see evidence below
- a filled page mints a cursor that resumes exactly after its last row, and that
  cursor ROUND-TRIPS through this branch
- foreign cursors 400: `all`, `unread`, `groups`, plus tampered `{q,b}` (bad
  block index) and `{q,b,k}` with an empty key attribute; AND the reverse
  direction (an unknown cursor under `filter=all` 400s)
- the budget-stopped SHORT PAGE shape: `rows: []`, `nextCursor` non-null, no
  `truncated`, `budgetStopped: true` on the log line, and continued paging
  reaches the hidden row
- THE COST IS THE PAGE, NOT THE PARTITION (hydration/thread-resolution counts)
- the retired log fields are absent, not zeroed

`app/test/inbox.integration.test.ts` (+1 test, against DynamoDB Local): pages the
REAL byTypeStatus index across the block boundary. This is the only place cursor
round-tripping is proved against DynamoDB rather than a fake.

### Full-walk evidence

Unit (`THE FULL WALK`, fixture 4 `needs_review` + 3 `active`, `limit: 3`):

```
pages          = [ [c-n2, c-n1, c-n0], [c-n3, c-a0, c-a1]* , [c-a2] ]
page lengths   = [3, 3, 1]
union (sorted) = [c-a0, c-a1, c-a2, c-n0, c-n1, c-n2, c-n3]   == expected  (no skips)
new Set(seen).size === seen.length                             (no duplicates)
last untriaged page index (0..1) <= first reviewed page index   (queue order)
page 3 = [c-a2] - the NEWEST row in the whole queue, on the LAST page
```

(* page 2's internal order is the per-page activity sort; the assertion pins page
1 and page 3 exactly and the boundary property across all pages.)

Integration (real index, 6 unknown contacts - 4 `needs_review` incl.
`it-contact-unk` from the preceding test, 2 `active` - `limit: 2`):

```
page lengths   = [2, 2, 2, 0]   <- the exact-multiple extra round trip, pinned
union (sorted) = [it-contact-unk, it-unk-a1, it-unk-a2, it-unk-n1, it-unk-n2, it-unk-n3]
                 == expected                                   (no skips)
no duplicates
lastUntriagedPage <= firstReviewedPage                          (queue order across the boundary)
body.truncated === undefined on every page
foreign (unread) cursor -> HTTP 400
final nextCursor === null (the walk ENDED; the 10-iteration guard did not stop it)
```

---

## Dashboard finding - NO CHANGE NEEDED

Read, not assumed:

- `dashboard/src/routes/inbox/useInbox.ts:546` - `hasMore: cursor !== null`,
  where `cursor` is `pageData.nextCursor` installed at `:240` (first page) and
  `:344` (load more). No filter gate anywhere.
- `dashboard/src/routes/inbox/Inbox.tsx:219` - the Load more button renders on
  `inbox.hasMore` alone.
- `loadMore` (`useInbox.ts:319`) appends `pageData.rows` to `base` and reinstalls
  the cursor, guarded by the filter-generation and first-page-generation checks.

So Load more lights up on the Unknown tab with zero dashboard code.

**One behaviour worth knowing, not a blocker and not part of this slice.**
`useInbox.ts:534` does `const rows = sortByActivity(visible)` over the ACCUMULATED
list. So after a Load more, the client re-sorts every page it has together by
activity - an `active` row from page 2 can render above a `needs_review` row from
page 1. Nothing is lost or duplicated, and the server's queue order still decides
WHICH rows arrive and in what order they are FETCHED; only the rendered ordering
of already-fetched rows is activity-based. Whether the Unknown tab should keep
server order in the accumulated list (or group visibly by block) is a product
question for a separate slice.

---

## Verify output

All bare, from `W:\tmp\inbox-unread-cluster`.

```
app> npx vitest run test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts \
       test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts \
       test/unknownQueue.test.ts test/contactsPartitionFake.test.ts

 v contactsPartitionFake.test.ts   (8)
 v unknownQueue.test.ts           (11)
 v inboxUnknownParity.test.ts      (7)
 v inboxGroups.test.ts            (18)
 v inboxUnknownTab.test.ts        (13)
 v inboxFeed.test.ts              (62)
 v inboxApi.test.ts               (53)
 Test Files  7 passed (7)
      Tests  172 passed (172)
```

```
app> npx vitest run test/inbox.integration.test.ts        # DynamoDB Local up
 v test/inbox.integration.test.ts (11 tests) 562ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Adjacent suites, run because they touch the same branch/log line:

```
app> npx vitest run test/inboxDiagnostics.test.ts test/inboxEmail.test.ts \
       test/inboxUnreadParity.test.ts test/voiceInboxActivity.test.ts
 Test Files  4 passed (4)
      Tests  39 passed (39)
```

```
> npm run typecheck
  @housingchoice/app        tsc -p tsconfig.json --noEmit && tsconfig.scripts && tsconfig.test   OK
  @housingchoice/dashboard  OK
  @housingchoice/e2e        OK
  @housingchoice/fake-twilio, fake-twilio-web  OK
  (exit 0, no diagnostics)
```

```
> npm run smoke
  smoke-dist: OK - 1342 import specifier(s) across 236 emitted file(s) resolve under plain Node.
```

```
> npx eslint app/src/lib/unknownQueue.ts app/src/routes/inbox.ts \
      app/scripts/measure-unread-contact-coverage.ts app/test/unknownQueue.test.ts \
      app/test/inboxUnknownTab.test.ts app/test/inboxFeed.test.ts \
      app/test/helpers/contactsPartitionFake.ts
  (clean, exit 0)

> npx eslint app/test/inbox.integration.test.ts
  200:7  error  'convBId' is assigned a value but never used   @typescript-eslint/no-unused-vars
```

That one error is **PRE-EXISTING and attributed by BASELINE COMPARISON**: the
identical error at the identical line is reported by the same command on a
`git stash` of my changes (i.e. at `3029fe63`). I left it - fixing unrelated
errors in a shared repo is its own change - and I am naming it here so the next
person does not re-diagnose it as mine.

NOT RUN, per instructions: `npm test` (full), `npm run e2e`, `e2e:session`. No
server was started; `npm run db:start` only (the container was already up).

---

## Also changed

- `app/test/helpers/contactsPartitionFake.ts` - **resume is now POSITIONAL, not
  identity-based.** DynamoDB does not require an ExclusiveStartKey to name an
  item that still exists; it seeks to the key's POSITION. The branch now mints
  its cursor from a CONSUMED contact's own `(type, status, contactId)`, so a
  contact re-typed or soft-deleted between two requests is the ordinary case -
  and the old `findIndex(...) + 1` returned `-1 + 1 = 0`, silently RESTARTING the
  partition, i.e. modelling the paging bug (duplicate rows on page 2) as correct
  behaviour. Now compares the `(status, contactId)` tuple, matching rule 6's
  sort; a key carrying `contactId` alone still resolves by identity.
- `app/test/inboxFeed.test.ts` - one call-count pin `listByType: 1 -> 2` (one
  Query per block), with the reason in a comment.
- `app/scripts/measure-unread-contact-coverage.ts` - the status-breakdown header
  said "the cap fills from the TOP of this list". There is no cap; retitled and
  the comment now explains what the breakdown is still for. Print-only, no
  measured value changed.
- `docs/issues/unknown-queue-cap-starves-needs-review.md` -> `status: resolved`,
  with a resolution block naming the fix taken (its own suggested option 2),
  what replaced the cap, and where the pins moved. The original record is kept
  below it because the mechanism is still true of the index.
- `docs/issues/inbox-filter-tabs-full-walk.md` - four sections rewritten: the
  "what shipped" summary, "TWO different cuts and neither has a Load-more" (both
  cuts gone), the collector-truncation residual (now the budget-stopped empty
  page, which carries a cursor), the named reopen point (closed), and the
  hydration deferral (closed, with the pin that was its stated blocker).

---

## Surprises

1. **The exact-page-multiple extra round trip.** Not predicted; found by the
   integration test, which expected `[2,2,2]` and got `[2,2,2,0]`. It is correct
   and unavoidable without paying a Query to prove emptiness, so I pinned and
   documented it rather than engineering it away. Same trade DynamoDB's own
   LastEvaluatedKey makes, and the same one the fake's rule 5 already documents.

2. **The block-exhausted-exactly-at-`want` boundary is load-bearing.** If
   `readUnknownQueue` reported exhaustion when a block drained at the same
   moment the page filled, every `active` row would sit behind a null cursor
   forever - a silent, total loss of the second block. The loop advances `block`
   BEFORE the `want` check re-evaluates, so `next` is `{block: b+1}`. It has its
   own pin because it is one `break` placement away from being wrong.

3. **The fake was modelling a bug as correct.** See the positional-resume note
   above. Worth flagging: it means the old identity-based resume could not have
   caught a duplicate-on-page-2 defect in ANY test built on that helper.

4. **The dashboard's accumulated-list re-sort** (see the dashboard finding). It
   does not block paging, but it means "untriaged before reviewed" is a property
   of the FETCH order and of each page as served, not of what the operator ends
   up looking at after several Load mores.
