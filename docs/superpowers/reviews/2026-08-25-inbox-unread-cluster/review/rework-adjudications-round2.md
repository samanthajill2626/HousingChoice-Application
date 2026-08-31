# Rework review round 2 - adjudications

Both reviewers continued (manual mode). Neither found anything BLOCKING, and
they CONVERGED independently on the empty-copy defect - which is the signal this
is converging rather than thrashing. Two of the MEDs trace directly to MY
rulings, not to implementer error.

## MUST FIX

**F1 (MED, paging-N1) - MY M3 RULING CREATED AN UNBOUNDED STALL.**
I ruled "stop the page at the failed row so the next request retries it", and
called the consequence a "short page". That describes the one case that does NOT
happen at a page HEAD. Proven: fail on row 1 of page 1 and the tab renders ZERO
rows forever with a cursor that never advances; fail on the first row after a
block roll-over and the whole `active` block is unreachable. Worse, the shape is
byte-identical to one `unknownQueue.ts:305-315` already THROWS to outlaw ("a Load
more that never advances and never ends") - the codebase had a rule and my
ruling walked into it. Neither new fixture can see it.
RULING: bound the retry. If the failing row is the FIRST consumed AND zero rows
are kept, the previous request already retried it - step OVER it and escalate the
log from WARN to ERROR. One retry, then guaranteed progress. Pin the page-head
case specifically; that is the one nothing currently covers.

**F2 (MED, paging-N2 AND blast-N1 - found independently by both) - the empty
copy switched to the wrong quantity.** `Inbox.tsx:33` gates on `hasMore` (a
statement about the SERVER page) while the empty block at `:203` gates on
`rows.length` (the CLIENT-filtered list). On `filter=unread`, marking every row
read - the ordinary gesture, the entire point of that tab - now renders "This
search stopped early to stay fast" when the search did not stop early and the
operator emptied the list themselves. This file has ALREADY fixed this exact
drift twice and written the doctrine down (`useInbox.ts:41-57`, `Inbox.tsx:52-57`
and `:178-182`): a claim about the SERVER page is gated on `serverRowCount`,
never on `rows`. RULING: gate on `serverRowCount === 0 && hasMore`, and fix the
adversarial-4 pin (`Inbox.test.tsx:136-143`), which currently goes green only
because `baseState` inherits `hasMore: false` and therefore cannot see this.

**F3 (MED, blast-N3) - COMMENT ONLY, and the restraint is the ruling.** The
reason recorded at `inbox.ts:1629` for nulling the unread cursor on an empty page
("a Load more the client has nothing to hang off") became false the moment M1
removed that client limitation - and that line is now the ONLY thing making the
banner-plus-Load-more pairing unreachable. Correct the comment to say what is
now true: the line is load-bearing for a state it was not written to guard.
Do NOT change the unread branch's cursor behaviour. That is a different filter,
a different decision, and changing it would ship a state nobody has reviewed.

**F4 (paging-C1) - a filed issue tells its future implementer something false,
and it is the issue Cameron just approved as a follow-up.**
`unknown-queue-status-flip-duplicates-across-pages.md:96-100` claims
denormalizing `last_activity_at` "removes the mechanism entirely". It does not:
it swaps a mutable range key for a MORE frequently mutable one. Duplicates do
vanish (activity only moves rows toward the head), but the invisible SKIP half -
which that same issue argues is the worse half - gets MORE frequent, driven by
any inbound message instead of an operator click. Correct it in BOTH files,
including `denormalize-contact-last-activity-for-ordered-paging.md`, because this
materially changes that follow-up's value: it buys ordering, it does not buy
correctness, and it owes the same seen-set cost.

**F5 (paging-C2) - a procedural catch, upheld.** Round-1 finding A6 (the scan
budget can charge `budget + pageSize - 1`, and terminal pages under-charge by up
to 198 rows) was never adjudicated - my numbering skipped it. Adjudicating now:
ACCEPT the looseness (bounded, termination unaffected) and fix the docblock,
which currently overstates the bound.

**F6 (cheap, blast-N4 + blast-N6 + paging-N3)** - a route test whose name asserts
two things that both died at `1ceb2e52`; the perf harness's `inboxTerminal` has
no alternative matching the new copy, so a budget-stopped sample would fail as
`ready_timeout`; and the fake's resume still ignores the start key's `type`,
which the real service refuses.

**F7 (blast-N5, LOW but take it if cheap)** - `retryFrom` does not advance across
a zero-row read, so a persistently failing thread read re-pays the whole residue
walk on every Load more. Correct but not cheap.

## ESCALATION TO THE HUMAN - now better informed

Blast-radius is right that my M2 escalation was incomplete. The question is not
"queue order versus newest-first". Today's RENDERED order is NEITHER: it is
"newest of whatever happens to have been fetched". And `unknown` is the FIRST
filter where the client sort actually REORDERS the accumulation, so Load more
makes the existing list reflow under the operator. One of the two sorts is dead
weight either way. Put that to Cameron properly.
