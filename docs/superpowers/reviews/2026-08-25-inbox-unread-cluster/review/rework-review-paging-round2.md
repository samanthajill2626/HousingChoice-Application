# Adversarial re-review - the fix wave (30ba7eef), paging-correctness lens

Branch: `feat/inbox-unread-cluster`. Range reviewed COLD: `1ceb2e52..30ba7eef`
(plus the issues in `bbc553db`). Read-only; no repository file changed, no
commit. Probes ran from the scratchpad; both DynamoDB Local probe tables were
created and dropped again.

## SUMMARY

The wave is mostly a good one. M4 and M6 are real, enforced, and I could not
re-break either. M3's headline claim - a transient failure no longer loses a row
- is true and pinned; I re-ran my own round-1 repro and it comes back clean. M1
is real and pinned dashboard-side.

Three things are wrong with it, one of them a NEW defect introduced by the wave:

- M3's accepted trade has an UNBOUNDED blast radius that the ruling's own
  wording ("a short page") excludes, and it reproduces the exact
  never-advancing-Load-more shape M6 THREW to outlaw, one file over. Nothing
  pins it.
- M1's copy change (`Inbox.tsx:33`) gates on the wrong quantity and regresses
  the Unread tab's most ordinary end state.
- One round-1 finding (A6) was never adjudicated at all - the A-numbering skips
  it.

And the FILED issue's standing remedy is argued on a false premise.

## NEW FINDINGS

---

### N1 - MED - the thread-failure stop is unbounded: one bad row can empty the whole tab, forever

`app/src/routes/inbox.ts:1873-1888` (the stop), `:1774` (`retryFrom` seed);
`app/src/lib/unknownQueue.ts:305-315` (the guard that forbids the same shape)

**The mechanism is correct.** I attacked `retryFrom` hard and could not make it
re-serve or skip a live row. It is monotone in reader order (`:1829`, `:1869`,
`:1896`, `:1924` all assign `after` of a row that has been CONSUMED), so
`boundary = retryFrom` always names a position at or after everything already
served on this page and at or before the failed row. The roll-over case is safe
too: `retryFrom` can lag `read.next` into a previous block, but the only rows
between them are filter-dropped residue.

**What is wrong is the blast radius, and it is not what the ruling described.**
M3 says: "A permanently-failing row then shows as a short page whose Load more
does not advance - VISIBLE-stuck, which beats SILENT-loss." A SHORT page is one
of three outcomes, and the other two are worse than the loss they replace:

| failure position | old behaviour | new behaviour |
|---|---|---|
| first row of the FIRST page | tab shows every row but that one | **tab shows ZERO rows, forever** |
| first row after a block roll-over | tab shows every row but that one | **every row in the later block is unreachable** |
| a middle row | tab shows every row but that one | rows before it ship; everything after is unreachable |

Measured, driving the real exported `aggregateInbox` (`scratchpad/probe6.ts`):

```
A permanent-fail-on-first-row: [{"rows":[],"cursor":"eyJxIjoxLCJiIjowfQ"},
                                {"rows":[],"cursor":"eyJxIjoxLCJiIjowfQ"},
                                {"STUCK":"cursor did not advance"}]
   (5 live rows in the queue; the tab renders none of them, on every request)

B permanent-fail-on-row-4: pages ["c-01","c-00"], ["c-02"], [], STUCK
   (c-04 and c-05 unreachable)

D rollover-fail (fail the FIRST row of block 1): page 1 ["c-02","c-01","c-00"],
   page 2 [], STUCK.  missing: a-00, a-01, a-02  - the ENTIRE reviewed block

F budget wall + permanent fail: [], [], [] then STUCK, and each attempt
   re-pays the full scan budget walking the same residue
```

Contrast the healthy and transient cases, which are clean - the fix does what it
says on those:

```
C transient (fails on request 1 only): missing: []  dupes: []
E healthy full walk:                   missing: []  dupes: []
```

**And the shape is one this very wave declared unacceptable.** `unknownQueue.ts`
now THROWS on `budget < 1`, and its own docblock (`:322-329` in the new file)
gives the reason: "every request answers with an empty page and the SAME cursor
the client sent - a Load more that never advances and never ends." Probes A, B,
D and F produce byte-identical behaviour - same cursor in, same cursor out,
empty page - by design, from the caller in the adjacent file. One of the two
positions has to be wrong. Combined with M1, the operator now sees a Load more
button that looks live, does nothing, and sits under copy blaming speed
("This search stopped early to stay fast").

**Nothing enforces or even characterises the trade.** The two new pins
(`inboxUnknownTab.test.ts`, "requirement 4..." and "a TRANSIENT thread-read
failure...") both use a failure that clears or a failure with rows already kept
ahead of it. There is no fixture where the failure is permanent, and none where
it lands on the first consumed row. The three rows in the table above are all
untested.

**Direction (bounded, no cursor growth).** Stop-at-row is right the FIRST time
and wrong forever after. The request already knows whether it is the first time:
if the failing row is the first row CONSUMED and `keptContacts` is empty, then
the incoming cursor already pointed at this row and the previous request already
retried it - so step over it (the old behaviour) and escalate the log line from
WARN to ERROR. That is one predicate, needs no extra cursor state, and converts
"the queue is unreachable" back into "one row is lost after one retry, and it
said so twice". Whatever is chosen, the three rows above need fixtures, and the
ruling's "short page" wording needs correcting - it is the case that does NOT
happen when the failure is at a page head.

---

### N2 - LOW - the new empty-state copy gates on `hasMore` alone, and regresses the Unread tab's normal end state

`dashboard/src/routes/inbox/Inbox.tsx:29-33`;
`dashboard/src/routes/inbox/inboxFilters.ts:21-40`

```ts
const empty = inbox.hasMore ? emptyMoreCopy() : emptyCopy(filter);
```

`hasMore` says a cursor exists. It does NOT say this page came back empty - and
`inbox.rows` is the CLIENT-filtered list, which the Unread tab empties as the
operator marks rows read (`useInbox.ts:533`, `visible = filter === 'unread' ?
patched.filter((r) => r.unreadCount > 0) : patched`). `serverRowCount` is the
server quantity (`useInbox.ts:543`).

**Failure scenario.** Unread tab. The server returns 30 rows and a cursor. The
operator triages all 30. Now `rows.length === 0`, `serverRowCount === 30`,
`hasMore === true`, `truncated` false, so `serverEndedEarlyEmpty` is false and
the empty block at `Inbox.tsx:203` renders - with `emptyMoreCopy()`:

> **Nothing on this page yet** - This search stopped early to stay fast. Load
> more to keep looking.

The previous copy was "You're all caught up / Switch to All to browse." The new
sentence is false on both halves: the search did not stop early, and the reason
the page is empty is that the operator cleared it. A successful triage session
now ends by telling the operator the app degraded.

**This file already states the rule, twice, in the exact words that forbid the
new gate.** `Inbox.tsx:143-150`: "Gated on `serverRowCount`, NOT `rows.length`
... `rows` is the client-filtered list the Unread tab EMPTIES as the operator
marks rows read." And `:182-186` again, citing adversarial finding 4, which was
this same bug in the failure banner. The fix wave reintroduced it one element
over.

**Why the suite stayed green.** `Inbox.test.tsx:136` is the pin for exactly this
state ("a truncated page whose rows were all marked read is caught up, NOT an
error") and it asserts `/all caught up/`. It passes only because `baseState`
defaults `hasMore: false` (`Inbox.test.tsx:22`) and the fixture does not set it.
Add `hasMore: true` - which `Inbox.tsx:129-141` documents as genuinely reachable
alongside `truncated` and which `Inbox.test.tsx:328` already pins as reachable -
and it goes red.

**Direction.** The predicate the copy actually wants is "the SERVER page was
empty and there is more": `inbox.serverRowCount === 0 && inbox.hasMore`. That is
the same server-quantity discipline the two blocks above it use, it leaves the
budget-stopped Unknown page (where `serverRowCount` IS 0) reading exactly as
intended, and it restores "all caught up". Then set `hasMore: true` on the
`Inbox.test.tsx:136` fixture so the pin can see it.

---

### N3 - LOW - the fake's resume still ignores the start key's `type`, where the service refuses a mismatch

`app/test/helpers/contactsPartitionFake.ts:145-159`

M8 correctly removed the `contactId`-only silent-restart fallback and made a
positionless key THROW - that is a real improvement and it now agrees with the
service in kind (measured round 1: `{contactId}` alone is "The provided starting
key is invalid"). But the resume still reads only `status` + `contactId`. A key
carrying a WRONG `type` (`{type:'tenant', status:'needs_review', contactId:'x'}`)
resolves positionally in the fake and is a `ValidationException` at the service
("does not match the range key predicate", measured round 1, case F).

No route path can produce it any more - `decodeUnknownCursor` now enforces
`key.type === block.type` - so this is residual, not live. It matters only
because this helper is explicitly positioned as "the authority on partition
semantics", and the wave just spent effort removing the other kindness in the
same function. Cheap to close: compare `type` too and throw with the same
message.

---

## CONTESTED ADJUDICATIONS

---

### C1 - the FILED issue's standing remedy is argued on a false premise

`docs/issues/unknown-queue-status-flip-duplicates-across-pages.md:96-100`

The filing itself is excellent - it reproduces both directions, states both
reachability conditions honestly, and names the visible/invisible asymmetry. I do
not contest the decision to file rather than fix; the seen-set objection is
sound.

I contest option 2, which the issue calls "the standing plan for this reader":

> **Denormalize `last_activity_at` onto the contact and page an activity-ordered
> GSI.** The range key stops being an operator-written field, which removes the
> mechanism entirely.

It does not remove the mechanism. It swaps a mutable range key for a **more
frequently mutable** one, and it removes the visible half while amplifying the
invisible half - the half the same issue argues is worse.

- The mechanism is not "operator-written", it is "the cursor is a position in an
  ordering keyed on a MUTABLE attribute". `last_activity_at` is mutated by every
  inbound and outbound message on the contact's thread. For a queue of unknown
  numbers, an unknown contact texting in again is the single most common event
  the system sees - far more frequent than an operator's triage click, and it
  needs no operator at all.
- Under newest-first paging, `last_activity_at` only ever moves a row TOWARD the
  head, i.e. toward positions the cursor has already passed. So the DUPLICATE
  direction genuinely disappears. But a row the walk has not reached yet - older
  than the cursor - that receives a message jumps ahead of the cursor and is
  **SKIPPED**. That is precisely the direction this issue documents as
  invisible: "the feed reports the queue as fully drained while omitting a row"
  (`:75-79`).
- And option 2 does not escape the objection that ruled out the fix here.
  Stable paging over a mutable sort key needs either a seen-set or a snapshot
  predicate - the same unbounded-cursor cost the ruling declined - so "removes
  the mechanism entirely" understates what option 2 still owes.

**Direction.** Reword option 2 to say what it actually buys: it eliminates the
duplicate and converts the operator-triggered skip into a message-triggered one,
which is more frequent but is also the ordinary semantics of an
activity-ordered feed (a row that just got a new message is not "missed", it is
at the top). Then make the reopen trigger cite BOTH keys, not just `status`.
Right now a reader who lands on that issue after the denormalization ships will
believe the defect is closed.

---

### C2 - round-1 finding A6 was never adjudicated

`.superpowers/review/rework-adjudications.md` (MUST FIX / FILE lists);
`app/src/lib/unknownQueue.ts:86-103`, `:329`

The adjudication maps A1, A2, A3, A4, A5 and A7 to M5, M4, M3, M6, M7 and M8.
**A6 appears nowhere** - not in MUST FIX, not in FILE, not in ESCALATED. The
numbering gap is the tell. It was my finding 6: the scan budget can charge up to
`budget + pageSize - 1` (1099 against a stated 1000) because the check runs
BEFORE the Query, and a terminal page charges `page.items.length` - the count
AFTER the soft-delete FilterExpression - so up to `blocks.length * (pageSize-1)`
= 198 rows are examined and charged zero.

I graded it LOW and I still do; the recommendation was to reword the constant's
docblock ("Raw index rows ONE request may examine", `:88-89`) rather than change
the arithmetic. The diff leaves both the docblock and the arithmetic untouched.
That is a defensible outcome - it is just not a RULING, and the next reviewer
will re-derive it. Record it as accepted-as-is, or reword the two sentences.

**Not contested:** A5/M7 and A7/M8 were comment-and-test findings and got
comment-and-test fixes, which is the right shape. The A1 file-don't-fix decision
is right on its merits.

---

## VERDICT PER FIX - real, or merely plausible?

| fix | verdict | what ENFORCES it |
|---|---|---|
| **M1** dead-end Load more | REAL | 3 new pins in `Inbox.test.tsx:404-429` (renders on an empty page with a cursor; copy switches; copy and button both go away once the walk ends). Behaviour verified by code walk. Carries N2 alongside it. |
| **M2** "total order across pages is QUEUE order" was false | PROSE ONLY, appropriately | Nothing can enforce a comment about the client's sort. The correction is accurate: `useInbox.ts:534` does sort the whole accumulation with no filter gate. The product question stays escalated, so this comment is the only thing standing between the next reader and the same wrong belief - acceptable for a comment finding. |
| **M3** stop at the failed row | REAL for the case it was filed for; UNBOUNDED for the case it was not | 2 rewritten/new pins. My round-1 repro comes back clean (probe6 C: `missing: [] dupes: []`), and the healthy walk is unchanged (probe6 E). The accepted trade is unenforced and mis-scoped - see N1. |
| **M4** tampered cursor 500s | REAL | `inboxUnknownTab.test.ts:284-330` now drives all five measured shapes plus the two originals, AND a positive round-trip (`{q:1,b:1,k:{...active...}}` resolves) so an over-strict validator cannot pass by refusing everything. I tried to re-break it: oversize (2049 and 10000 char `contactId`), a lone surrogate, and an embedded NUL all pass validation and are ACCEPTED by DynamoDB Local without error (`scratchpad/probe5.ts`, cases L-P), so they are not a new 500. The server can never mint a cursor its own decoder rejects - both `after` (`unknownQueue.ts:308-311`) and `read.next` (a GSI `LastEvaluatedKey`, which is index keys plus the single table key) are exactly `{type,status,contactId}` agreeing with the block; confirmed empirically by the multi-page round trips in probe6 C/E/F. **Could not re-break.** |
| **M5** duplicate/skip comment was wrong | PROSE + a filed issue, appropriately | `inbox.ts:1836-1866` now states the right threshold (`limit`, not `UNKNOWN_QUEUE_PAGE_SIZE`), the right window (the operator's Load-more gap), and the visible/invisible asymmetry; the misnamed test was renamed and its comment corrected to say it CANNOT fail for this shape. Correct on every point I raised. See C1 for the issue's remedy section. |
| **M6** degenerate `want`/`budget` spin | REAL, and the unruled `budget` half is correct | `unknownQueue.test.ts:223-249` pins both, plus `calls` length 0 (it refuses before spending a Query). The scope expansion is justified: nothing legitimately passes `budget < 1`, because the caller breaks on `remainingBudget === 0` (`inbox.ts:1946`) before it can re-enter, and `want >= 1` holds because the fill check breaks at `keptContacts.length >= limit` so a re-entry always has `keptContacts.length < limit`. `Number.isInteger` also closes NaN/fractional, which I had not raised. |
| **M7** the fake's tie-break claim | REAL | Docblock now states it as the fake's own convention, quotes the measurement (`c2, c4, c1, c3`), and the rule-6 pin was renamed to say which half is service behaviour and which is invented. |
| **M8** tests that cannot fail; dead resume fallback | REAL | The positionless fallback now throws with its own pin; both misnamed tests renamed with comments that say what they do and do not cover; rule 6's stale cap rationale replaced with the block-order one. |

## WHAT I TRIED AND COULD NOT BREAK

- `retryFrom` re-serving a row already on the page: no. It is monotone in reader
  order and only ever assigned from a CONSUMED row's `after`.
- `retryFrom` skipping a live row: no. Everything between it and the failed row
  was consumed and either served or legitimately dropped.
- The lagging-`retryFrom` case across a block roll-over: safe, costs one extra
  empty Query on the exhausted block (visible in probe6 D's page 2).
- Budget expiry and a thread failure in the same request: the thread-stop wins
  and is the more conservative (earlier) boundary, so nothing is lost - probe6 F.
- A 500 out of the new `decodeUnknownCursor`: no, across 6 tamper families plus
  oversize and malformed-unicode values.
- A cursor the server mints that its own decoder rejects: none exists, by
  construction and by round trip.
- `readUnknownQueue`'s new guards firing on a legitimate call: no.

## PROBES

All in
`C:\Users\Cameron\AppData\Local\Temp\claude\w--AI-Projects-Housing-Choice-HC-Application\72ae0323-26a3-4865-a4bd-a72e7ca58ab6\scratchpad\`,
run with `npx tsx` from `W:\tmp\inbox-unread-cluster\app`:

- `probe6.ts A|B|C|D|E|F` - N1 and the M3 verification, through the real
  `aggregateInbox`.
- `probe5.ts` - M4 re-attack (oversize / unicode / NUL start keys) against
  DynamoDB Local. Creates `hc-probe-review-esk2` under access key
  `hccleanrun001` and deletes it (confirmed: "probe table dropped").
- `probe1.ts`, `probe2.ts`, `probe3.ts` - round 1, retained; probe1 (the A1
  repro) still reproduces, as expected for a filed-not-fixed defect.
