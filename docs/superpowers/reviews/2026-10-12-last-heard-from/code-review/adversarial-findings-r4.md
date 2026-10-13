# Code review round 4 - Reviewer B (adversarial, plan-blind) - R3-1 closure check

Scope: `git diff -w dec2346a..7e2a2cb8`. ba87df0e is the Undo change in
`app/src/routes/units.ts`; 78063be9 is a test-only PIN; the rest is the decisions
record. I read it cold and proved it with one throwaway file,
`app/test/adv-r4.review-tmp.test.ts`. It was run singly
(`.superpowers/review/adv-r4-run1.txt`, 4/4 passed) and then deleted;
`git status --short` is clean.

Counts: BLOCKER 0, MAJOR 0, MINOR 0, NIT 0 new. R3-1: CLOSED.

## 1. R3-1 - CLOSED (proved)

`units.ts` clear branch: the Undo now compare-and-clears the decline it READ, using
`expectedAt: row.declined.at`. When it read no decline it makes no clear call at all.
`wrote` and `listing_decline_cleared` both follow only a clear that answered 'ok'.

- **Re-decline during an Undo survives.** A reads D1 and Undoes it; B's `setDeclined`
  (`staffId usr_b`) is injected between A's row read and A's clear. Result: B's
  decline is stored, the answer is 200 `not_interested`, and events are `[]` (R4a).
- **An Undo that read no decline writes nothing.** B's decline is recorded
  meanwhile; it survives and events are `[]` (R4b).
- **No regression on the plain path.** The Undo clears the decline and records
  one `listing_decline_cleared`; outcome `no_reply`. A second Undo (a double click)
  is 200 `no_reply`, not a 404, and records no second event (R4c).

Shapes the change introduced:
- **The dropped 404 on a lost compare is safe.** `send_not_found` remains the
  pre-write ledger check's answer (`ledgerRowCounted`). A row that stopped counting
  after the read now reaches the re-projection and answers the PLAIN 503 (R4d:
  `{"error":"outcome_unavailable"}`, no `saved`), where it used to be a 404. Both map
  to the same dashboard copy (`outcomeErrorCopy` -> "Couldn't save - try again."),
  so no client branch changes.
- **`wrote`/saved is correct on every clear outcome:** 'ok' -> true; lost compare ->
  false; nothing read -> false (no write was made). Matches the A-3 contract.
- **The event fires only on 'ok'** - never for a lost compare or an empty Undo.

One residual, below NIT and not a finding: unlike the Interested branch, Undo records
`listing_decline_cleared` even when the decline it removed was already superseded
(ineffective). It is reachable only from a stale page, since an Undo button only
shows on a not-interested row, and the event still truthfully records that a stored
decline was removed.

## 2. Anything else in the outcome route to block on

Nothing. I re-read the route end to end on 7e2a2cb8:
- Every clear is now a compare-and-clear on the record read: both the Interested
  and the Undo branch.
- `setDeclined` is a last-writer-wins overwrite of a decline. That is harmless,
  because both writes mean "not interested".
- The try-guard keeps a pre-write throw at the generic 500 and turns a post-write
  throw into 503 `saved: true`.
- The concurrent double-Interested duplicate tour remains the acknowledged I3 / filed
  issue.

No open adversarial finding blocks the merge.
