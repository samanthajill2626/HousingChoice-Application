# Rework fix wave - implementer report

Branch: `feat/inbox-unread-cluster`, worktree `W:\tmp\inbox-unread-cluster`.
Scope: items M1-M8 of `.superpowers/review/rework-adjudications.md`, plus the
two issues the "FILE, DO NOT FIX HERE" section names. The ESCALATED question
(whether the dashboard should stop re-sorting the accumulation) was NOT touched.

## Commits

| hash | what |
| --- | --- |
| `bbc553db` | `docs(issues)`: the two filed issues |
| `30ba7eef` | `fix(inbox)`: M1-M8 |

Base was `1ceb2e52`. Working tree clean after both; nothing else staged, no
`git add -A`, `docs/issues/INDEX.md` never staged.

## Per item

### M1 - the dead end (BEHAVIOUR, dashboard)

`dashboard/src/routes/inbox/Inbox.tsx`. The rows `<ul>` and the Load more
button were one fragment under `status === 'ready' && rows.length > 0`. They are
now two siblings: the list keeps its `rows.length > 0` gate, and Load more is
gated on `status === 'ready' && inbox.hasMore` ALONE, so a page that returned no
rows but did return a cursor is continuable.

The copy moves with it. `dashboard/src/routes/inbox/inboxFilters.ts` gains
`emptyMoreCopy()` - "Nothing on this page yet" / "This search stopped early to
stay fast. Load more to keep looking." - and `Inbox.tsx` picks
`inbox.hasMore ? emptyMoreCopy() : emptyCopy(filter)`. It is deliberately NOT
per-filter: the sentence is a statement about the SERVER's answer, not about the
tab. "No unknown numbers" over a live Load more is the reading an operator takes
for a broken app, and it talks them out of the one correct action.

Noted in the code: Load more can now also render alongside the `filter=unread`
early-end failure banner (rows 0 + `truncated` + a cursor). A cursor and a
truncation are independent server statements and offering the continuation does
not make the banner less true. No existing test covered that pairing and none
changed.

Pins added to `dashboard/src/routes/inbox/Inbox.test.tsx` (the Unknown-tab
empty-state describe): Load more renders and fires on `rows: [], hasMore: true`;
the copy is the "nothing yet" copy, not "No unknown numbers"; and the real empty
copy with NO Load more survives once `hasMore` is false.

### M2 - the false claim (comment only)

`app/src/routes/inbox.ts`, the per-page sort. The paragraph claiming "the TOTAL
order across pages is QUEUE order" now says the block order governs FETCH order
- which rows are retrieved first - and that the dashboard accumulates every page
and re-sorts the whole accumulation newest-first with no filter gate
(`useInbox.ts`, `sortByActivity` over `visible`), so untriaged-first is a
property of the fetch and of any single page, never of the rendered list. The
client's sort was NOT changed, and the comment says the question is with the
human and that neither side should be "fixed" unilaterally.

### M3 - transient thread-read failure (BEHAVIOUR, app)

`app/src/routes/inbox.ts`, the unknown branch's fill loop.

- New `retryFrom: UnknownQueuePosition`, initialised to `resume ?? { block: 0 }`
  and advanced to each row's `after` as that row is consumed (on every path that
  does not break: the retype belt, the `emitted` skip, the no-open-thread drop,
  and a kept row that did not fill the page). It is the position that RE-READS
  the row about to be consumed.
- `resolveOpenThreads` returning `undefined` no longer `continue`s. It sets
  `boundary = retryFrom`, sets `threadReadStopped`, breaks the row loop, and
  breaks the outer fill loop. The rows already kept still ship.
- `{ block: 0 }` rather than `undefined` is the start-of-queue value on purpose:
  an undefined boundary is the wire's "queue exhausted" signal, so a failure on
  the very first row of the very first request must still mint a real cursor.
- The WARN and the `unknownThreadReadFailed` drop counter are unchanged in kind;
  the message text changed from "a triage row is withheld from this page" (which
  was untrue - it was withheld from everything) to "the page STOPS here and
  resumes AT this row". The `thread read FAILED` substring the test keys on is
  preserved.
- The comment states the trade plainly: a PERMANENTLY failing row becomes a
  short page whose Load more does not advance - visible-stuck rather than
  silent-loss, the same posture the scan-budget exit already takes, and
  diagnosable from the first WARN because the line names the contactId.

No new wedge: the walk cannot spin, because a stuck page returns the cursor the
client sent and stops. The client stops advancing (visible), the server does not
loop. Termination of `readUnknownQueue` and the outer loop is unchanged, and M6
now enforces the two preconditions that argument assumed.

### M4 - the decoder that returned 500s

`decodeUnknownCursor` in `app/src/routes/inbox.ts`. `k` is now validated as
exactly `contactId,status,type` (sorted key-name join), all three non-empty
Strings, AND `k.type === UNKNOWN_QUEUE_BLOCKS[b].type` with
`k.status === ...status`. That closes all five measured shapes - junk names,
missing index keys, an extra attribute, a contradicting `k.status`, a wrong
`type` - in one predicate, plus the reorder hazard (`b` is a bare ordinal into a
DERIVED list).

The docblock was rewritten to explain why this departs from `decodeCursor`'s
opaque-key posture (this module MINTS the key, and it is the only namespace
where the KeyCondition and the ExclusiveStartKey come from different cursor
fields), and it states explicitly that this is ROBUSTNESS, NOT SECURITY: no org
dimension, and DynamoDB refuses a start key inconsistent with the predicate
rather than answering from it, so no cross-partition read was possible before
either.

The foreign-cursor test now drives a table of seven tampered payloads (the two
it already had plus all five measured ones) and, critically, one HONEST cursor
that must still resolve - a validator that refuses everything would otherwise
pass every negative assertion and silently break paging.

### M5 - the materially wrong duplicate/skip comment

`app/src/routes/inbox.ts`, at the `emitted` guard. Now states: the threshold is
the request `limit` (30 from the dashboard), not `UNKNOWN_QUEUE_PAGE_SIZE`
(100); the window is the OPERATOR'S gap between Load-more clicks, seconds to
minutes, not the milliseconds between two sequential Queries (which is the
window `emitted` actually covers); the common triage direction produces a
VISIBLE duplicate (doubled row under a duplicate React key) and the rare
un-triage direction an INVISIBLE skip; the defect STAYS because a cross-page
seen-set means an unbounded cursor, which is the boundedness this feed exists to
escape. Points at
`docs/issues/unknown-queue-status-flip-duplicates-across-pages.md`.

### M6 - `limit <= 0`

`app/src/lib/unknownQueue.ts`, at the top of `readUnknownQueue`: THROW on
`want < 1` (or non-integer) and on `budget < 1`, before any Query.

Chosen over a no-op page for the reason stated in the docblock: this reader is
LOUD BY CONTRACT precisely so "the triage queue is empty" and "the read did not
work" never look alike, and a no-op page is the second one wearing the first
one's face. A caller asking for zero rows is a programming error and should read
like one.

DEVIATION, stated for the record: the ruling names `limit <= 0` only; I also
guarded `budget < 1`, which is the second half of the same finding (F4 case 2 -
`unknownQueueScanBudget: 0` answers every request with an empty page and the
same cursor, an endless Load more). It is the identical one-line predicate on
the identical seam, no caller passes either value today, and leaving one of two
spins guarded seemed worse than the small scope stretch. Both are pinned in
`app/test/unknownQueue.test.ts`, including that neither costs a Query.

### M7 - the fake's overclaimed tie-break

`app/test/helpers/contactsPartitionFake.ts` rule 6. The tie-break is now stated
as the FAKE'S OWN convention, chosen so page-composition pins are deterministic
and readable, and CONTRADICTED by the service: the measured
`c1..c4 -> c2, c4, c1, c3` result is quoted, along with the fact that the real
order is stable and ESK-resume-consistent (so only its SHAPE is invented). The
"status ascending" half is unchanged and still labelled as real. The note also
records why the integration walk sorts before comparing.

`app/test/contactsPartitionFake.test.ts`'s rule-6 test was renamed to "status
ascending is REAL service behaviour; the contactId tie-break is this FAKE'S OWN
convention" and its comment now says which assertion positions are the fake's
convention and which are production.

### M8 - test honesty and stale comments

(a) The duplicate test is renamed "a WITHIN-REQUEST duplicate ships ONE row: the
block loop consults `emitted` (it does NOT cover the cross-page shape)" and its
comment now describes the fixture it actually drives, says the cross-page shape
cannot fail this test, and points at the new issue. It also says why no test for
the cross-page shape exists: it would have to assert the defect.

(b) The foreign-cursor test is extended by M4 above.

(c) Rule 6's "WHY THIS RULE EXISTS" paragraph in the fake no longer describes
the deleted result cap and page budget or cite the deleted "cap starves
needs_review" pin. It states what the sort model buys NOW - BLOCK ORDER is
expressible at all, and the replacement pin ("the UNTRIAGED block is exhausted
BEFORE the reviewed block is read") is a range-key-order statement that a
seed-order fake makes vacuous.

(d) The `contactId`-only resume fallback THROWS instead of
`findIndex(...) + 1`. Deleting it outright would have left `start = 0` - the
same silent restart by another route - so a positionless key is now a loud test
failure with a message pointing at the KEY SHAPE note. The KEY SHAPE paragraph
was updated to match. Pinned by a new case in
`app/test/contactsPartitionFake.test.ts`.

### The two issues

- `docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` (bug, med,
  open) - the mid-walk `status` flip. Carries the reviewer's probe output for
  both directions, the two reachability conditions (>`limit` = 30 live rows,
  plus a status write in the operator's Load-more gap), the
  visible-duplicate/invisible-skip asymmetry, why a cross-page seen-set was
  rejected, three suggested fixes, and a reopen trigger. Referenced from the M5
  comment and from the M8(a) test comment.
- `docs/issues/contacts-create-does-not-require-status.md` (bug, low, open) -
  `create`/`createIfAbsent` neither require nor default `status`, so the
  byTypeStatus invariant is enforced on `update` only. Latent (all eight live
  call sites enumerated). States the complication up front: pointer rows are
  written by a raw `PutCommand` and are UN-INDEXED on purpose, so the invariant
  is "every row created through create/createIfAbsent", never "every row" - any
  audit written against the stronger statement flags every pointer row and gets
  abandoned as noise. Notes the existing detector in
  `measure-unread-contact-coverage.ts`.

`npm run issues` was run; `INDEX.md` is gitignored and was not staged.

## Red-then-green evidence

### M3 - RED (before the fix)

`cd W:\tmp\inbox-unread-cluster\app` then
`npx vitest run test/inboxUnknownTab.test.ts`:

```
 x requirement 4: a THROWN thread read STOPS the page AT that row ...
   -> expected null not to be null
 x a TRANSIENT thread-read failure costs a SHORT PAGE, not a lost row ...
   -> expected [ 'c-t3', 'c-t1' ] to deeply equal [ 'c-t1' ]

 Test Files  1 failed (1)
      Tests  2 failed | 12 passed (14)
```

The second failure IS the defect, printed: page 1 came back
`['c-t3','c-t1']` - the loop stepped over the failing `c-t2` and filled from a
LATER row, which is exactly how the cursor then advanced past a row that was
never served. The first failure is the same defect's other face: the walk ended
with `nextCursor: null` on a page that had dropped a row.

### M3 - GREEN (after the fix)

```
 Test Files  4 passed (4)
      Tests  42 passed (42)
```
(`test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts
test/unknownQueue.test.ts test/contactsPartitionFake.test.ts`)

### M1 - RED (before the fix)

`cd W:\tmp\inbox-unread-cluster\dashboard` then
`npx vitest run src/routes/inbox/Inbox.test.tsx`:

```
 x renders Load more on an EMPTY page that still carries a cursor ...
   -> TestingLibraryElementError: Unable to find an accessible element
      with the role "button" and name /load more/i
 x says the page found nothing YET - not that the queue is empty ...
   -> expected <p class="_emptyTitle_...">No unknown numbers</p> to be null

 Test Files  1 failed (1)
      Tests  2 failed | 32 passed (34)
```

### M1 - GREEN (after the fix)

```
 Test Files  3 passed (3)
      Tests  74 passed (74)
```
(`Inbox.test.tsx inboxFilters.test.ts useInbox.test.tsx`)

## Verify - all bare, none piped into a gate decision

App unit set, `cd W:\tmp\inbox-unread-cluster\app`:

```
npx vitest run test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts \
  test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts \
  test/unknownQueue.test.ts test/contactsPartitionFake.test.ts

 Test Files  7 passed (7)
      Tests  175 passed (175)
```

THE PARITY SUITE IS GREEN (7 tests) - it was watched specifically, per the stop
condition.

Integration, after `npm run db:start` (`hc-dynamodb-local already running`):

```
npx vitest run test/inbox.integration.test.ts

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Dashboard, `cd W:\tmp\inbox-unread-cluster\dashboard`:

```
npx vitest run src/routes/inbox/

 Test Files  4 passed (4)
      Tests  90 passed (90)
```

Typecheck, `cd W:\tmp\inbox-unread-cluster`:

```
npm run typecheck
-> app (3 projects), dashboard, e2e, fake-twilio, fake-twilio-web: all clean, exit 0
```

Issues index:

```
npm run issues
[issues] 260 open, 152 closed, 412 total -> docs/issues/INDEX.md
[issues] open by severity: 9 high - 113 med - 138 low
[issues] 1 warning(s):
  - perf-selfqa-route-contract-drift.md: unknown severity "medium"
```

That warning is PRE-EXISTING and is in a file this wave did not touch; both new
issues parsed cleanly.

Lint (gate 5, the branch's own touched files, run bare):

```
npx eslint app/src/lib/unknownQueue.ts app/src/routes/inbox.ts \
  app/test/contactsPartitionFake.test.ts app/test/helpers/contactsPartitionFake.ts \
  app/test/inboxUnknownTab.test.ts app/test/unknownQueue.test.ts \
  dashboard/src/routes/inbox/Inbox.test.tsx dashboard/src/routes/inbox/Inbox.tsx \
  dashboard/src/routes/inbox/inboxFilters.ts

-> no output, exit 0
```

NOT run, per the brief: `npm run e2e`, `npm run e2e:session`, the full
`npm test`, `npm run smoke`. No server was started. `npm run db:start` was the
only permitted infrastructure command used.

## Disagreements and caveats

**No disagreement with any ruling.** Two things to flag rather than argue:

1. **M6 scope stretch** - I guarded `budget < 1` alongside `want < 1`. Reasoning
   in the M6 section above. Revert the budget half if the orchestrator wants the
   ruling read literally; it is two lines and one assertion.
2. **One non-ASCII character on a touched line.** `Inbox.tsx`'s
   `{inbox.loadingMore ? 'Loading...' : 'Load more'}` carries a real ellipsis
   character in the shipped string. That literal is UNCHANGED - the line moved
   when the button was hoisted out of the fragment - and the file is already a
   pre-existing non-ASCII file (its header copy uses em dashes). I moved it
   byte-for-byte rather than editing shipped UI typography inside a fix wave. If
   the ASCII ratchet is to be read as covering a relocated literal, say so and I
   will change it to three dots as its own one-line change.

**One thing the orchestrator should know that is not in any item.** M1's Load
more now renders on `status === 'ready' && hasMore` with no other gate, which
means it can appear under the `filter=unread` early-end failure banner
(`rows: []`, `truncated`, plus a cursor). That state is reachable - the unread
branch's budget exit mints a cursor AND sets `truncated` - and no test covered
it before or after. I judged it an improvement (the rows are genuinely
reachable, and the banner's claim is still true) and said so in the code
comment, but it is a second filter's behaviour changed by an item written about
the first, so it is called out here rather than buried.
