# Adversarial review - CORRECTNESS OF A PAGED READ (filter=unknown)

Branch: `feat/inbox-unread-cluster`. Range reviewed: `0393c75e..HEAD` (the rework).
Lens: over the full sequence of pages, does every row appear EXACTLY ONCE?
Read-only review. No repository file was changed. All probes ran from the
scratchpad; the one DynamoDB Local probe table was created and dropped again.

## VERDICT ON THE EXACTLY-ONCE CLAIM

**FALSE as stated, under a write the queue's own operator performs.** Under a
STATIC partition the walk is exact - I could not break it, and the boundary
arithmetic, the roll-over, the LEK-means-Limit-reached handling and the
fill-past-residue loop are all correct. Under a CONCURRENT status write it is
not: I reproduced both a DUPLICATE and a SKIP through the real `aggregateInbox`
with the DynamoDB-faithful fake, on a seven-row queue.

Additionally, a TRANSIENT thread-read failure drops a row from the walk
permanently (zero appearances), which is a third exactly-once violation and does
not need any concurrent write at all.

Reachability today is nil for the concurrency shapes - the measured partitions
are 16 dev / 7 prod against a dashboard page of 30, so no multi-page walk exists
yet. The transient-failure loss is reachable today on any page.

Termination: PROVEN for every input the HTTP route can produce (`parseLimit`
clamps to 1..100). Two degenerate seam inputs spin - see F4.

## FINDINGS

---

### F1 - HIGH - exactly-once fails in BOTH directions when `status` moves mid-walk

`app/src/lib/unknownQueue.ts:187-193, 291-324`;
`app/src/routes/inbox.ts:1769-1791`

**What is wrong.** The walk is a fixed sequence of partitions keyed on `status`,
and `status` is the index's range key AND a mutable, operator-written field. A
row therefore does not merely move within a block, it CHANGES BLOCK - forward
into a block not yet read (served twice) or backward into a block already read
(never served). The only guard is `emitted`, a per-REQUEST Set, which by
construction cannot see across the page boundary where the damage happens.

**Failure scenario 1 - DUPLICATE (proved).** Queue: `c-n0..c-n3` needs_review,
`c-a0..c-a2` active. `limit=3`.
- Request 1 serves `c-n2, c-n1, c-n0`; cursor = block 0 after `c-n2`.
- Operator marks `c-n0` reviewed - the STATUS-ONLY PATCH that
  `unknownQueue.ts:56-72` itself identifies as the one UI-reachable manufacturer
  of `(unknown, active)`. `c-n0` leaves block 0 (behind the cursor, already
  served) and joins block 1 (not yet read).
- Request 2 serves `c-a1, c-a0, c-n3`. Request 3 serves `c-a2, c-n0`.
- `c-n0` ships on page 1 and page 3. The dashboard keys the wire row
  `c:<contactId>`, so this is a duplicate React key and a doubled row.

**Failure scenario 2 - SKIP (proved).** Same queue. After request 1 (cursor =
block 0 after `c-n2`) an already-reviewed contact is re-opened for triage
(`active -> needs_review`, permitted by `statusAllowlistFor('unknown')`). Its id
sorts before the block-0 cursor, so block 0 never reaches it and block 1 no
longer contains it. **`c-a2` is served on no page at all.** Note the coin flip:
`contactId` is `contact-<uuid>` (`app/src/services/contactCapture.ts:176`) and
the index order is not time-ordered, so roughly half of such flips land before
the cursor.

**Evidence.** `scratchpad/probe1.ts`, driving the real exported
`aggregateInbox` with `test/helpers/contactsPartitionFake.ts`:

```
PROBE1 pages: [["c-n2","c-n1","c-n0"],["c-a1","c-a0","c-n3"],["c-a2","c-n0"]]
PROBE1 duplicates: [ 'c-n0' ]
PROBE2 pages: [["c-n2","c-n1","c-n0"],["c-a1","c-a0","c-n3"],[]]
PROBE2 missing: [ 'c-a2' ]
```

**The in-code risk assessment is materially wrong, and that is half of this
finding.** `inbox.ts:1779-1783` says the duplicate "needs a multi-page walk
(>UNKNOWN_QUEUE_PAGE_SIZE unknown contacts) AND a write landing between two
sequential Queries; it is not a state anyone hits this week." Both halves are
false:

- the threshold is the request `limit` (30 from the dashboard, `useInbox.ts:94`),
  not `UNKNOWN_QUEUE_PAGE_SIZE` (100). My repro uses SEVEN contacts.
- the window is not "between two sequential Queries" (milliseconds inside one
  request - where `emitted` actually does protect). It is between two HTTP
  REQUESTS, i.e. the operator's own Load-more gap, and the write is the operator's
  own triage click. That is the most probable write in the system for these rows,
  not the least.

The regression test that is presented as covering this
(`app/test/inboxUnknownTab.test.ts:578-612`, "a DUPLICATED queue item ships ONE
row") drives `listByTypeOverride` returning `[dup, dup]` inside ONE page - the
shape `emitted` DOES catch. The reachable shape, across the page boundary, has
no test and no guard. See F7.

**Direction.** Either (a) drop the block decomposition and page the whole
`type='unknown'` partition with one Query, accepting that queue order is then
status-lexicographic (`active` before `needs_review`) and re-solving starvation
some other way - the row can then only move within one continuous key space; or
(b) keep blocks and carry a bounded cross-page seen-set of ids served from
LATER blocks in the cursor (the mirror of what the unread branch does), which
closes the duplicate but not the skip; or (c) accept it explicitly and correct
the comment so the next reader is not told this needs 100+ rows and a
millisecond race. Option (c) alone is defensible on today's data but the comment
must stop understating it.

---

### F2 - MED - a tampered cursor `k` returns 500, not 400; the decoder's docblock claims otherwise

`app/src/routes/inbox.ts:364-403` (esp. 398-402)

**What is wrong.** `decodeUnknownCursor` validates `k`'s VALUES (non-empty
strings) but neither its key NAMES nor its consistency with the block `b` names.
It then flows straight to `listByType`'s `ExclusiveStartKey`
(`contactsRepo.ts:1100-1102`), which has no catch; `readUnknownQueue` is LOUD by
contract and does not catch; the route only maps `InboxBadRequestError` to 400
and rethrows everything else (`inbox.ts:2282-2289`) - so a `ValidationException`
is a 500.

The docblock at `inbox.ts:366-370` states that the value check "is the one tamper
that turns a 400-by-design into a 500". It is not. I measured five more.

**Failure scenario.** `GET /api/inbox?filter=unknown&cursor=<base64url of>`:

| tampered payload | DynamoDB Local answer | route |
|---|---|---|
| `{q:1,b:0,k:{foo:"bar"}}` | ValidationException "The provided starting key is invalid" | 500 |
| `{q:1,b:0,k:{contactId:"c2"}}` (index keys missing) | same | 500 |
| `{q:1,b:0,k:{type,status,contactId,extra:"x"}}` | same | 500 |
| `{q:1,b:0,k:{type:"unknown",status:"active",contactId:"a1"}}` (k.status contradicts block 0) | ValidationException "The provided starting key does not match the range key predicate" | 500 |
| `{q:1,b:0,k:{type:"tenant",...}}` | same | 500 |

**Evidence.** `scratchpad/probe2.ts` against the running DynamoDB Local on
127.0.0.1:8000, on a table with a byTypeStatus-shaped GSI (created and dropped):

```
E ESK with WRONG status (active) on needs_review query => THREW ValidationException | The provided starting key does not match the range key predicate
F ESK with WRONG type (tenant)                          => THREW ValidationException | The provided starting key does not match the range key predicate
G ESK with contactId ONLY (missing index keys)          => THREW ValidationException | The provided starting key is invalid
H ESK with junk attribute                               => THREW ValidationException | The provided starting key is invalid
I ESK with EXTRA attribute alongside valid keys         => THREW ValidationException | The provided starting key is invalid
J ESK empty object                                      => THREW ValidationException | The provided starting key is invalid
```

Good news from the same probe: a key naming a DELETED or never-existing row
resolves POSITIONALLY and returns the rest of the partition cleanly (cases C, D)
- so the "resume key naming a row that no longer exists" boundary case is
genuinely safe, and the fake models that half faithfully.

**No cross-org leak.** There is no org dimension in this table, and a mismatched
hash key is refused rather than silently answered, so a hand-crafted cursor
cannot read another partition's rows. The exposure is availability + an
untruthful docblock, not disclosure.

**Test gap.** `inboxUnknownTab.test.ts:284-294` pins the out-of-range `b` and
the empty-string value - the two tampers that ARE caught - and stops. None of
the five above has a test, in unit or integration.

**Direction.** `k` is not repo-opaque here the way `decodeCursor`'s is: this
module MINTS it (`unknownQueue.ts:308-311`) from `UNKNOWN_QUEUE_BLOCKS`, so its
shape is fully known. Validate it as exactly `{type, status, contactId}`, all
non-empty strings, with `type === blocks[b].type` and `status ===
blocks[b].status`. That closes all five in one predicate - and, as a bonus,
makes the cursor self-describing enough to survive a reorder of
`UNKNOWN_QUEUE_BLOCKS` (today `b` is a bare ordinal into a DERIVED list; adding
a legal status for `unknown` renumbers the blocks and silently mis-resumes every
in-flight cursor, which the current range check cannot detect).

---

### F3 - MED - a TRANSIENT thread-read failure removes a row from the walk permanently

`app/src/routes/inbox.ts:1669-1684, 1792-1793, 1809-1826`

**What is wrong.** `resolveOpenThreads` returning `undefined` (the participant
GSI threw) `continue`s the row. The loop then keeps consuming, fills the page on
a LATER row, and mints the boundary from THAT row - which is past the failed
one. The cursor has now stepped over a row that was never served. The comment at
`inbox.ts:1663-1667` describes this as "withholds ONE row" and "a failure
withholds ONE row loudly ... instead of 500ing the whole tab", which reads as
"deferred". It is not deferred; it is dropped from the walk. Only restarting the
tab from page one can recover it.

**Failure scenario (proved).** Four needs_review contacts, `limit=2`. The
participant GSI throws for `c-n1` on request 1 only (a transient throttle /
timeout) and is healthy thereafter.

```
PROBE4 pages: [["c-n2","c-n0"],["c-n3"]]
PROBE4 missing: [ 'c-n1' ]
```

`c-n1` appears zero times across a complete walk that ends with
`nextCursor: null`, i.e. the feed reports the queue as fully drained while
having silently omitted a row. The operator gets a WARN in the server log and a
drop counter; the UI shows a complete, clean queue.

**Evidence.** `scratchpad/probe3.ts flaky`, real `aggregateInbox`.

**Direction.** A failed thread read should stop the page rather than step over
the row: set the boundary to the failed row's PREDECESSOR (or to the failed
row's own position minus one - i.e. mint from the last SUCCESSFUL row and break)
so the next request re-attempts it. That turns a silent loss into a short page,
which is the posture this branch already chose for the scan budget. If stepping
over is genuinely intended, say so in the comment - "withheld" is the wrong
word.

---

### F4 - LOW - two degenerate seam inputs never terminate

`app/src/lib/unknownQueue.ts:291-296`; `app/src/routes/inbox.ts:1726-1857`

Not reachable from the HTTP route (`parseLimit`, `inbox.ts:2242-2247`, clamps to
1..100 and `UNKNOWN_QUEUE_SCAN_BUDGET` defaults to 1000), but `aggregateInbox` is
exported and is called directly by `app/scripts/profile-inbox.ts:117` with a
case-supplied `limit`, and both seams are `deps`-settable.

1. **`limit <= 0` -> tight infinite loop, zero Queries.** `want = limit -
   keptContacts.length` is 0, `readUnknownQueue` breaks immediately on
   `rows.length >= opts.want` with `rows: []`, `next` = the UNCHANGED start
   position and `budgetSpent: false`; the outer `for(;;)` sees a defined `next`,
   a non-zero remaining budget and no fill, and re-enters with the same
   position forever. Proved: `scratchpad/probe3.ts zero` printed
   "calling aggregateInbox with limit 0 ..." and never returned inside a 10s
   timeout, with the instrumented `listByType` counter at 0 - so it is a pure
   microtask spin that no runaway guard downstream can trip.
2. **`unknownQueueScanBudget: 0` -> infinite Load-more.** `0 ?? DEFAULT` is 0
   (nullish, not falsy), so the reader marks `budgetSpent` before issuing any
   Query and returns the start position unchanged. Every request answers with an
   empty page and the SAME cursor the client sent. The client's Load more never
   advances and never ends.

**Direction.** One line in `readUnknownQueue`: refuse (or clamp) `want < 1` and
`budget < 1`, or assert them. The outer loop's own termination argument
(`inbox.ts:1721-1725`) is stated as if `want >= 1` and `budget >= 1` were
guaranteed; make them so.

---

### F5 - LOW - the fake pins an intra-status ordering DynamoDB Local does not produce

`app/test/helpers/contactsPartitionFake.ts:26-37, 92-102`;
`app/test/contactsPartitionFake.test.ts:95-121`

The docblock hedges the tie-break as "observed, not contracted" - correctly - and
then asserts as fact that "Ordering by `contactId` is what the storage layout
produces and **what DynamoDB Local does**". It does not.

**Evidence.** Four items with identical `(type='unknown', status='needs_review')`
and ids `c1..c4`, queried through the real byTypeStatus-shaped GSI on the running
DynamoDB Local (`scratchpad/probe2.ts`, case A):

```
A baseline no-ESK => OK items: [ 'c2', 'c4', 'c1', 'c3' ]
```

Not ascending, not seed order - the index's internal (hashed table key) order.
Resume from `c2` correctly returned `['c4','c1','c3']`, so the ordering IS stable
and ESK resume IS consistent with it; only the SHAPE of the order is fictional.

**Why it still matters even though nothing in production leans on it.** The
docblock positions this helper as "the one helper positioned as the authority on
partition semantics", and this is the sentence a future author will cite when
they reach for an ordering guarantee (the file's own warning notwithstanding).
And `contactsPartitionFake.test.ts:108-113` pins `['a-active','z-active',
'a-review','z-review']`, whose second and fourth positions assert the fiction as
if it were service behaviour. The downstream consequence is bounded but real:
every exact page-composition pin built on it (`inboxUnknownTab.test.ts:247-248`,
`:262`, `:269`) is a FAKE-order assertion, not a production one - which is
precisely why the real-index walk in `inbox.integration.test.ts` sorts before
comparing, and why that integration test is the one carrying the weight here.

**Direction.** Correct the docblock to say the `contactId` tie-break is a FAKE
CONVENTION chosen for determinism, contradicted by DynamoDB Local, and re-word
the rule-6 pin's second half to say so. Do not weaken the sort itself - the
`status`-ascending half is real and load-bearing.

---

### F6 - LOW - the scan-budget accounting is loose in both directions (bounded, so not a hazard)

`app/src/lib/unknownQueue.ts:293-304`; `app/src/routes/inbox.ts:1715, 1738`

- **Overshoot.** The budget is checked BEFORE a Query, so the last Query can
  start at `scanned == budget - 1` and charge a full `pageSize`. One request can
  therefore charge up to `budget + pageSize - 1` = 1099 rows against a stated
  budget of 1000. Correct by design, but "Raw index rows ONE request may
  examine" (`unknownQueue.ts:88-89`) is not what the code enforces.
- **Under-charge.** A page with no LastEvaluatedKey charges
  `page.items.length` - the count AFTER the soft-delete FilterExpression - not
  the rows examined. A terminal page that evaluated 99 residue rows and returned
  none charges ZERO. Bounded at `blocks.length * (pageSize - 1)` = 198 extra
  uncharged rows with today's two blocks; it grows linearly if a third status
  ever becomes legal for `unknown`.

Neither breaks termination (I checked: every outer iteration consumes at least
one row and charges at least one, and a zero-charge iteration necessarily
advances the block index, of which there are two). Reporting so the docblock's
claim and the code agree.

**Direction.** Charge `Math.max(page.items.length, ...)` is not available -
DynamoDB does not report ScannedCount for a filtered Query through this repo
method. Simplest honest fix is to reword the constant's docblock to
"approximately, +/- one page" rather than to change the arithmetic.

---

### F7 - LOW - two tests whose names promise more than their fixtures deliver

Read fixtures, not names. Most of this suite is genuinely non-vacuous - I checked
each. Two are not what they say:

- `app/test/inboxUnknownTab.test.ts:578-612` "a DUPLICATED queue item ships ONE
  row". Its own comment explains the reachable duplicate (a `status` flip between
  two READS moving a row past the cursor) and then tests a different thing: one
  Query returning `[dup, dup]`. That is the within-request shape `emitted`
  covers. The cross-page shape the comment describes is NOT covered, is NOT
  guarded, and is what F1 reproduces. The test cannot fail for the bug its
  comment names.
- `app/test/inboxUnknownTab.test.ts:273-299` "rejects a FOREIGN cursor". It
  covers the three foreign tags, out-of-range `b`, and an empty-string key value.
  It cannot fail for any of the five 500-producing tampers in F2, and its
  in-line comment ("the one tamper that would turn a 400-by-design into a 500")
  states the same wrong claim the decoder docblock does.

Everything else I examined holds up: THE FULL WALK (`:198-249`) really does span
three pages over seven rows; the scan-budget page (`:301-348`) really does hit
the budget and really does reach the row behind the residue wall; THE COST IS THE
PAGE (`:350-376`) really does exercise the early stop; and the real-index walk in
`inbox.integration.test.ts` (six rows at `limit=2`, four pages including the
exact-multiple empty tail) is the strongest pin on the branch and is not
order-dependent.

---

## WHAT I TRIED TO BREAK AND COULD NOT

Recorded so the next reviewer does not repeat it.

- **Boundary arithmetic.** All five cases are correct.
  - Page fills exactly at its last row -> cursor minted, next request returns an
    empty page and `nextCursor: null`. One spurious round trip, deliberate,
    documented at `inbox.ts:1816-1822`, and pinned end to end by the integration
    walk's `[2,2,2,0]`.
  - Block exhausts exactly as the page fills -> `after` still names the block
    just finished; the next request issues one empty Query there and rolls over.
    Correct, one wasted Query. Pinned by `unknownQueue.test.ts:147-162`.
  - Scan budget expires exactly at a block boundary -> `next = {block: b+1}` with
    no key, which is the same shape as "start of block". If the exhausted block
    was the LAST, the `while` condition wins and `next` is undefined, so a
    budget-spent walk that actually finished still reports `nextCursor: null`.
    Correct.
  - Empty block between two non-empty ones -> zero items, no LEK, block advances.
    Correct.
  - Resume key naming a row that no longer exists -> positional in real DynamoDB
    (probe2 cases C and D), positional in the fake (`contactsPartitionFake.ts:103-130`).
    The two agree, and the fake's comment explaining WHY it must be positional is
    right.
- **Losing rows between the page and the cursor.** No. When the page fills, the
  boundary is the last CONSUMED row and everything the reader read past it is
  simply re-read. When the page does not fill, every returned row was consumed
  and `read.next` is at or ahead of the last returned row, the only gap being
  filter-dropped residue. Neither loses a live row.
- **An infinite Load-more from budget expiry (with a legal budget).** No. Any
  `budget >= 1` guarantees at least one Query, and a Query either advances the
  key (LEK present) or advances the block (LEK absent), so the cursor strictly
  advances on every request. `inboxUnknownTab.test.ts:334-347` walks it under a
  budget of 4 and terminates.
- **`emitted` masking a fill.** No - the duplicate `continue` runs before the
  fill check, so a suppressed row cannot become the boundary.
- **Cursor namespace crossing.** All four directions are closed:
  `{q:1,...}` is rejected by `decodeCursor` (`inbox.ts:317-319`) and
  `decodeUnreadCursor` (`:454`) and by `decodeGroupCursor`'s `t`-tag check
  (`conversationsRepo.ts:471-486`); and `all` / `unread` / `groups` cursors are
  all rejected by `decodeUnknownCursor`'s `q !== 1`. Pinned at
  `inboxUnknownTab.test.ts:273-299` and once more against the live route in
  `inbox.integration.test.ts`.
- **`limit` changing between requests.** Harmless - positions are absolute, not
  ordinal.
- **The `roleFromContact` belt (`inbox.ts:1765-1768`).** Genuinely unreachable
  from a real Query, exactly as its own comment says. The test that exercises it
  says so too. Not a finding.

## PROBES

All in
`C:\Users\Cameron\AppData\Local\Temp\claude\w--AI-Projects-Housing-Choice-HC-Application\72ae0323-26a3-4865-a4bd-a72e7ca58ab6\scratchpad\`,
run with `npx tsx` from `W:\tmp\inbox-unread-cluster\app`:

- `probe1.ts` - F1 duplicate + F1 skip, through the real `aggregateInbox`.
- `probe2.ts` - F2 and F5, against DynamoDB Local on 127.0.0.1:8000. Creates
  `hc-probe-review-esk` under access key `hccleanrun001` and deletes it at the
  end (confirmed: "probe table dropped").
- `probe3.ts flaky` - F3 transient-failure row loss.
- `probe3.ts zero` - F4 case 1 (hangs; run under `timeout`).
