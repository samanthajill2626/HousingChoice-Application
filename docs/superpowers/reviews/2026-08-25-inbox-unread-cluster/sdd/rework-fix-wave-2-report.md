# Rework fix wave 2 - implementation report

Branch: `feat/inbox-unread-cluster`, worktree `W:\tmp\inbox-unread-cluster`.
Scope: `.superpowers/review/rework-adjudications-round2.md`, items F1-F7.

**Commit: `30e1b9f5`** - "fix(inbox): bound the thread-read retry and gate the
empty copy on the server page" (11 files, +371/-30). One commit; every item is
in it.

Baseline before the wave: `30ba7eef`.

---

## F1 - bound the retry (BEHAVIOUR)

`app/src/routes/inbox.ts`

- New `retryFromMoved` flag beside `retryFrom` (declared with the docblock that
  states WHY it is the bound: `boundary = retryFrom` is progress only when the
  boundary is not the cursor the client sent). It is set at every one of the
  five `retryFrom` assignment sites - retyped drop, `emitted` duplicate,
  no-open-thread drop, the normal per-row advance, and the new F7 advance - so
  it means exactly "some row was consumed".
- The thread-read failure branch now forks:
  - `!retryFromMoved && keptContacts.length === 0` -> the PAGE HEAD case. The
    row is dropped: `retryFrom = after`, `continue`, and an **ERROR** line
    (`inbox: unknown-queue thread read FAILED at the PAGE HEAD - the row is
    DROPPED and the walk steps over it`).
  - otherwise -> unchanged stop-and-retry, with the existing **WARN**.
- The log line MOVED from `resolveOpenThreads` to the caller, because the level
  now depends on a decision the helper does not make. The helper keeps the
  counter and the `dropped('unknownThreadReadFailed')` discrimination and
  records the cause in `lastThreadReadErr`; both docblocks say so.

Bounded, by construction: each request either keeps a row, advances `retryFrom`
past its incoming cursor, or drops one row and continues - never answers with
the cursor it was handed.

### RED then GREEN

Two new pins in `app/test/inboxUnknownTab.test.ts` (plus `makeDeps` widened to
accept an `error` spy):

- "a thread read that fails AT THE PAGE HEAD is STEPPED OVER, not retried
  forever"
- "a page-head failure AFTER A BLOCK ROLL-OVER does not strand the whole later
  block"

RED, at `30ba7eef` behaviour (both run before the source change):

```
FAIL test/inboxUnknownTab.test.ts > a thread read that fails AT THE PAGE HEAD is STEPPED OVER, not retried forever
AssertionError: expected [] to deeply equal [ 'c-h2', 'c-h3' ]
  561|     expect(page.rows.map((r) => r.contactId).sort()).toEqual(['c-h2', ...

FAIL test/inboxUnknownTab.test.ts > a page-head failure AFTER A BLOCK ROLL-OVER does not strand the whole later block
AssertionError: expected 'eyJxIjoxLCJiIjowLCJrIjp7InR5cGUiOiJ1b...' to be null
- Expected: null
+ Received: "eyJxIjoxLCJiIjowLCJrIjp7InR5cGUiOiJ1bmtub3duIiwic3RhdHVzIjoibmVlZHNfcmV2aWV3IiwiY29udGFjdElkIjoiYy1yMiJ9fQ"
  606|     expect(cursor).toBeNull();
```

The second failure IS the stall: eight successive requests, same cursor in, same
cursor out, and `c-r4` never served.

GREEN, after the change:

```
> npx vitest run test/inboxUnknownTab.test.ts
 v test/inboxUnknownTab.test.ts (16 tests) 16ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

---

## F2 - gate the empty copy on the server page (BEHAVIOUR)

`dashboard/src/routes/inbox/Inbox.tsx:33` (now the `empty` selection):

```ts
const empty = inbox.serverRowCount === 0 && inbox.hasMore ? emptyMoreCopy() : emptyCopy(filter);
```

The comment above it now names the failure it prevents and cross-references the
same server-quantity doctrine the truncation notice and the failure banner
carry. It also records, explicitly, that the client-emptied-with-more-behind
state deliberately keeps `emptyCopy` next to a live Load more - inventing a
third string is a copy decision nobody has taken, so it was not taken here.

`dashboard/src/routes/inbox/Inbox.test.tsx`:

- The adversarial-4 pin ("a truncated page whose rows were all marked read is
  caught up, NOT an error") now sets `hasMore: true`, with a comment saying that
  inheriting `baseState`'s `false` is the only reason it stayed green through
  fix wave 1.
- New pin: "says all caught up - NOT 'stopped early' - after the operator clears
  a full unread page" (`rows: []`, `serverRowCount: 30`, `hasMore: true`,
  `truncated: false`), asserting the caught-up copy, the ABSENCE of both halves
  of `emptyMoreCopy()`, and that Load more still renders.

### RED then GREEN

RED, against the `30ba7eef` gate (both pins, before the source change):

```
> npx vitest run src/routes/inbox/Inbox.test.tsx
 Test Files  1 failed (1)
      Tests  2 failed | 33 passed (35)

  ... rendered:
    <p class="_emptyTitle_...">Nothing on this page yet</p>
    <p class="_emptyBody_...">This search stopped early to stay fast. Load more to keep looking.</p>
    <button class="_loadMore_...">Load more</button>
  178|     expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
```

GREEN, after the change:

```
> npx vitest run src/routes/inbox/
 Test Files  4 passed (4)
      Tests  91 passed (91)
```

Also corrected in the same file: the Load-more block's comment claimed the
button "can now render ... alongside the early-end failure banner". It cannot -
`app/src/routes/inbox.ts`'s empty-page invariant guarantees a zero-row unread
page carries no cursor. The comment now says the pairing is server-unreachable
today, by that one line, and points at it. (Round-2 blast-radius N3's
design-record half; the ruling's F3 covers the server side of the same fact.)

---

## F3 - comment only, `app/src/routes/inbox.ts` (the unread empty-page invariant)

Behaviour UNCHANGED - `if (unreadRows.length === 0) unreadCursor = null;` still
stands exactly as it was. The comment now:

- retires the dead reason ("a Load more the client has nothing to hang off"),
  naming the 2026-08-26 client change that killed it;
- states what is true now: this line is the ONLY reason the early-end failure
  banner and a live Load more cannot render together, because the banner needs
  `serverRowCount === 0 && truncated` and this guarantees `hasMore` is false
  there;
- warns that deleting it on the strength of the obsolete reason ships that
  unreviewed pairing, plus the dead end the budget branch above argues against;
- records that keeping it is a RULING, not inertia: different filter, different
  empty-page posture, and flipping it is a product decision nobody has taken.

## F4 - the two filed issues

`docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` - option 2
rewritten. It no longer says the denormalization "removes the mechanism
entirely"; it states that the mechanism is a cursor into an ordering keyed on a
MUTABLE attribute, that `last_activity_at` is mutated by every message (more
often than a triage click and with no operator involved), that the duplicate
half genuinely disappears under newest-first paging while the invisible SKIP
half gets MORE frequent, and that the seen-set cost is unchanged. Closes with
"it buys ORDERING, not correctness."

Also added a reopen note: the defect follows whichever mutable attribute is the
range key - `status` today, `last_activity_at` after - so option 2 landing is
not grounds to close it.

`docs/issues/denormalize-contact-last-activity-for-ordered-paging.md` - new
section "WHAT THIS DOES NOT BUY: paging correctness", carrying the same argument
from the other side and telling whoever specs it not to plan on closing that
issue. The value proposition is stated as ordering, with the honest defence
("a row that just got a new message is at the top, not missed").

## F5 - the scan-budget docblock

`app/src/lib/unknownQueue.ts`, `UNKNOWN_QUEUE_SCAN_BUDGET`. The opening line is
now "Roughly how many raw index rows ONE request may examine", and the docblock
states both directions of the looseness: OVER-SPEND up to `budget + pageSize -
1` (the check runs before the Query - 1099 against a stated 1000), UNDER-CHARGE
up to `blocks.length * (pageSize - 1)` = 198 (a terminal page is charged
`items.length`, the post-FilterExpression count). It records that neither
affects TERMINATION and that both are accepted rather than fixed - i.e. the
adjudication, so the next reviewer does not re-derive A6.

## F6 - three cheap ones

(a) `app/test/inboxApi.test.ts` - renamed to "400 on filter=unknown with a
FOREIGN cursor - a cursor minted by another feed is never Queried here", with a
comment recording that both claims in the old name died at `1ceb2e52` and that
the assertion itself was always about `{idx:0}`, the `all` feed's shape.

(b) `e2e/performance/routes.ts` - `inboxTerminal` now carries TWO empty
alternatives, the per-filter title and `'Nothing on this page yet'`. The default
`'any'` combine makes each locator its own alternative, so a budget-stopped
sample resolves as `empty` instead of falling through `terminalStateFor` to
`'unknown'` and failing as `ready_timeout`. Commented with the reachability
(none on today's perf seed) so it reads as a latent pin, not a live fix.

(c) `app/test/helpers/contactsPartitionFake.ts` - a complete positional
`exclusiveStartKey` must now also name the queried partition; a mismatched
`type` throws instead of resolving positionally, matching the service's
ValidationException. Ordered AFTER the existing positionless check so that pin's
`/status and contactId/` assertion is untouched. New pin in
`app/test/contactsPartitionFake.test.ts`: "an exclusiveStartKey naming a
DIFFERENT type THROWS - the hash key is not advisory".

## F7 - taken, and it is two lines

`app/src/routes/inbox.ts`, in the fill-or-exhaust loop right after
`position = read.next`:

```ts
retryFrom = read.next;
retryFromMoved = true;
```

Reaching that point means every row the read returned was consumed, so the
reader's own resume point is a valid retry boundary by the same argument the
adjacent `boundary = read.next` already makes: whatever lies between the last
consumed row and `read.next` is soft-deleted residue that was never emitted, so
re-reading it duplicates nothing and skipping it loses nothing. It matters most
on a zero-row read. No contorting of the loop was needed.

---

## Verify (all bare, from the worktree)

```
> cd W:\tmp\inbox-unread-cluster\app
> npx vitest run test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts test/unknownQueue.test.ts test/contactsPartitionFake.test.ts
 Test Files  7 passed (7)
      Tests  178 passed (178)

> npx vitest run test/inbox.integration.test.ts        (DynamoDB Local up)
 Test Files  1 passed (1)
      Tests  11 passed (11)

> cd W:\tmp\inbox-unread-cluster\dashboard
> npx vitest run src/routes/inbox/
 Test Files  4 passed (4)
      Tests  91 passed (91)

> cd W:\tmp\inbox-unread-cluster
> npm run typecheck
 app (tsconfig + scripts + test), dashboard, e2e, fake-twilio, fake-twilio-web - all clean, exit 0

> npx eslint app/src/lib/unknownQueue.ts app/src/routes/inbox.ts app/test/contactsPartitionFake.test.ts app/test/helpers/contactsPartitionFake.ts app/test/inboxApi.test.ts app/test/inboxUnknownTab.test.ts dashboard/src/routes/inbox/Inbox.test.tsx dashboard/src/routes/inbox/Inbox.tsx e2e/performance/routes.ts
 (no output, exit 0)

> npm run issues
 [issues] 260 open, 152 closed, 412 total -> docs/issues/INDEX.md
 [issues] 1 warning: perf-selfqa-route-contract-drift.md unknown severity "medium"  (pre-existing, not mine)
```

The parity suite (`test/inboxUnknownParity.test.ts`) is green - it is inside the
seven-file run above.

Every added line is ASCII (verified by scanning `git diff -U0`'s `+` lines: 0
non-ASCII). `dashboard/src/routes/inbox/Inbox.tsx`'s pre-existing `'Loading...'`
ellipsis and the em-dashes in its shipped copy were not touched.

NOT RUN, per instruction: `npm run e2e`, `npm run e2e:session`, the full
`npm test`, `npm run smoke`. No server started.

---

## Disagreement / caveat - one, and it is a caveat rather than a deviation

**F1's predicate gives ZERO retries, not one, to a row that sits immediately
after a page boundary.** The ruling's justification is "if the failing row is
the first row CONSUMED and `keptContacts` is empty, then the incoming cursor
already pointed at this row and the previous request already retried it"
(`rework-review-paging-round2.md:100-104`). That inference holds when the
incoming cursor was minted BY a thread-read stop. It does not hold when the
previous page ended FULL: `app/src/routes/inbox.ts`'s page-full exit sets
`boundary = after` of the last kept row, so the next request's first consumed
row is a row nothing has ever attempted - and if its thread read throws, this
build drops it on sight.

I implemented the ruling as written anyway, and I think that is right:

- Distinguishing the two cases needs the cursor to carry "I stopped here because
  of a failure", i.e. extra cursor state, which the ruling explicitly rules out
  ("needs no extra cursor state").
- The cost is bounded and LOUD: one row, logged at ERROR with its `contactId`,
  which is strictly better than the pre-`30ba7eef` behaviour (a WARN that
  misdescribed the loss) and far better than the alternative it replaces (an
  unreachable block, or an empty tab, forever).
- The common shape the M3 fix was filed for - a transient failure mid-page - is
  untouched and still pinned.

Recorded here rather than acted on. If the retry-once guarantee is wanted for
the page-boundary case too, the cheapest honest way is a one-bit flag in the
cursor, which is a wire change and a new review.
