# Rework review - adjudications

Two plan-blind adversarial reviewers, different lenses. No spec-conformance pass
this round: requirements 2 and 3 were deliberately superseded by human ruling, so
conformance-to-spec was the wrong question.

- PAGING CORRECTNESS: `rework-review-paging.md`. Verdict on exactly-once: sound
  under a STATIC partition (boundary arithmetic, block roll-over, LEK semantics,
  fill-past-residue all hold and could not be broken); FALSE under a concurrent
  `status` write or a transient thread-read failure.
- BLAST RADIUS: `rework-review-blast-radius.md`. Swept clean: all nine
  `update` callers, the guard's narrowness, the deleted sweep's compensating
  surface end to end, every response-contract consumer, cursor namespacing, all
  six consumers of the changed helper, termination.

## MUST FIX

**M1 (HIGH, B2) - the dead end I created in my own brief.**
`dashboard/src/routes/inbox/Inbox.tsx:206-230` nests Load more inside
`rows.length > 0`. So the branch's deliberate budget-stopped EMPTY-page-with-a-
cursor renders the empty state with NO Load more - unreachable rows, which is
the exact defect this rework was chartered to remove. My slice-3 brief asserted
the dashboard would "show the empty state plus Load more"; I was wrong, and the
implementer verified `hasMore` without checking where the button renders. The
app-side pin exists; the dashboard-side one does not. Fix the render condition
and pin it dashboard-side.

**M2 (HIGH, B1a) - a false claim in the design record.** `inbox.ts:1903-1905`
says "the TOTAL order across pages is QUEUE order". `useInbox.ts:534` sorts the
whole ACCUMULATION newest-first with no filter gate, so that is false as
rendered. The server's queue order governs FETCH order only. Correct the comment.
Whether the CLIENT should preserve queue order is a product question - escalated,
not decided here.

**M3 (MED, A3) - a transient thread-read failure drops a row from the WALK.**
Reachable today, no scale needed: the read throws, the row is skipped, the page
fills on a later row, and the cursor steps PAST it - so it appears on no page and
the walk still ends `nextCursor: null`. The comment says "withheld from this
page"; it is withheld from everything. FIX: on a thread-read failure, stop
filling the page and set the boundary AT the failed row, so the next request
retries it. A permanently-failing row then shows as a short page whose Load more
does not advance - VISIBLE-stuck, which beats SILENT-loss. Say that in the
comment.

**M4 (MED, A2 + B3) - a decoder built to guarantee 400s returns 500s.** Five
tampered `k` shapes reach DynamoDB and produce 500 (measured against DynamoDB
Local), and `b` is never cross-checked against `k`. Validate the key fully -
names and the block/key agreement - so a tampered cursor is a 400. No cross-org
leak exists (a mismatched hash key is refused), so this is robustness, not
security.

**M5 (A1 comment) - the duplicate/skip comment is materially wrong.** It claims
the threshold is `UNKNOWN_QUEUE_PAGE_SIZE` (100) and the window is "between two
sequential Queries". Both false: the threshold is `limit` (30) and the window is
the OPERATOR'S Load-more gap - seconds to minutes, not milliseconds. That is a
much larger window than the comment admits. The DEFECT stays (a cross-page
seen-set means an unbounded cursor, which is the boundedness this feed exists to
escape) but it must be documented truthfully and filed.

**M6 (LOW, A4)** `limit <= 0` is a tight infinite spin with zero Queries. Not
route-reachable (`parseLimit` clamps) but `aggregateInbox` is exported and
`profile-inbox.ts` passes a case-supplied limit. Guard it.

**M7 (LOW, A5)** the fake still overclaims: it asserts the `contactId` tie-break
is "what DynamoDB Local does", and it measurably is not (`c1..c4` came back
`c2, c4, c1, c3`). We already weakened this claim once and it is still wrong.
State it as the FAKE'S OWN deterministic convention, not a service behaviour.

**M8 (LOW, A7 + B4 + B5)** two tests that cannot fail for the bug their comments
name; rule 6's rationale still describes the deleted cap; the `contactId`-only
resume fallback is unreachable AND still carries the silent-restart bug.

## FILE, DO NOT FIX HERE

- **A1's defect** - a mid-walk `status` flip duplicates or skips a row across
  pages. Proven at `limit=3`; needs >30 unknown contacts plus a write in the
  Load-more gap. Note the asymmetry when filing: the COMMON operator action
  (triaging, `needs_review -> active`) produces a DUPLICATE, which is visible;
  the rare one (un-triaging) produces a SKIP, which is not.
- **B6** - `create()` neither requires nor defaults `status`, so the byTypeStatus
  invariant is enforced on `update` only. Latent (all eight live call sites set
  it). Slice 1 reported it; it needs its own issue rather than a third mention.

## ESCALATED TO THE HUMAN

Whether the dashboard should stop re-sorting the accumulation for this filter, so
that "untriaged first" is what the operator SEES rather than only what the client
FETCHES. Both readings are defensible and it is a product call.
