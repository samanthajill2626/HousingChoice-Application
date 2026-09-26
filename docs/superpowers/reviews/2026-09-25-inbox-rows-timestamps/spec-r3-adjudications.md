# Spec review round 3 - adjudications

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`
Reviewed: DRAFT 4 @0a1633db. Result: DRAFT 5.
Reviewer: A, continued (`spec-r3-reviewer-a.md`, 16 findings; 2 labelled
DECISION, 14 PRECISION). Nothing to contest from round 2 (all accepted).
Adjudicator: the planner (this session), 2026-09-25.

## Counts

- 16 accept, 0 reject.
- Decisions changed by this round, the planner's call: 1. The two DECISION
  findings resolve into one rule that section 3 already stated and 5.6 had
  contradicted: an incomplete head read (budget exit, truncated page) MERGES
  its rows in and removes nothing on every tab, and is never a failure. That
  corrects the mechanism to the decision; the product decision itself (7) is
  unchanged, but the rule as built changed, so it counts. Round 4 is the
  terminal round under the cap; it is expected to be precision-only.

## Findings

1. HIGH DECISION, model R's non-empty incomplete head shrank the list against
   the stated "never shrinks". ACCEPT. Branch I (incomplete head) is now one
   rule for every filter: head := P merged over the old head, tail kept minus
   P, old cursor kept including null (5.6). DECISION CHANGED (as above).
2. HIGH PRECISION, `overflow-anchor: none` on the `<ul>` leaves the button as
   the anchor; test 6 at `?limit=2` chains by design. ACCEPT. Verified the
   anchor-selection reading against the property's semantics as stated in
   section 2. The property moves to the page root (the scroll container's only
   child while the Inbox is mounted); test 6 uses `?limit=12` at 1280x400 with
   about 30 parties and asserts EXACTLY ONE cursor request per scroll (5.2,
   5.9, 7.3).
3. MEDIUM DECISION, the banner for Unknown's zero-row budget exit. ACCEPT.
   Folded into branch I: a successful incomplete head is never a failure; the
   banner is for rejected requests and the 404-with-rows case only (5.6, 5.7,
   decision 7's wording).
4. MEDIUM PRECISION, the re-walk underspecified. ACCEPT. Rewritten (5.8): it
   runs once per restore, triggered by the first head read that COMMITS after
   the restore; holds `loadingMore`; walks by RANGE (until the page's oldest
   row is at or older than the tail's oldest, the end, or a 5-page cap);
   folds once, dropping only rows inside the walked range that no page
   returned, keeping rows newer (slid in meanwhile) or older (cap); a head
   read landing meanwhile does not abandon it; a page failure folds what was
   read. The fold is pure and unit-tested.
5. MEDIUM PRECISION, save-gating holes (unmount save not gated on `ready`;
   the reset saves under a key). ACCEPT. Both saves gate on `statusRef ===
   'ready'` and `aliveRef`; the reset sets `loading` BEFORE committing the
   empty list (5.5, 5.8).
6. MEDIUM PRECISION, `aliveRef` never set true again after StrictMode's
   simulated unmount. ACCEPT. Set true in the effect body, false in cleanup
   (5.5); a test pins it.
7. MEDIUM PRECISION, kept additive rows filed as tail (duplicate on
   conversion, stale cursor, never dropped). ACCEPT. Kept additive rows stay
   HEAD rows and never touch the cursor or arming; an old additive row whose
   conversation returns under another kind is dropped (5.5, 5.6, invariant 9).
8. MEDIUM PRECISION, the Back promise is false on Unread/Unknown past 100.
   ACCEPT the restatement (invariant 2, 4.2, section 8). The alternative
   (re-reading their tail) would be a new decision and is explicitly not made.
9. LOW PRECISION, the row click's optimistic mark-read never reaches the
   unmount save. ACCEPT. `pendingRef` mirrors `pending` synchronously (5.5).
10. LOW PRECISION, `epoch` defined two ways. ACCEPT. `pageEpoch` bumps only on
    a committed head read, a committed loadMore page, and the re-walk's final
    fold (5.2, 5.5).
11. LOW PRECISION, the tie comment overstated. ACCEPT. Reworded (5.6, 8).
12. LOW PRECISION, the narrow query must reset the `.head` cap. ACCEPT (5.4).
13. LOW PRECISION, seeding `scrollTopRef` on PUSH saves a position never
    shown. ACCEPT. Seeded only on a `POP` arrival, else 0 (5.8).
14. LOW PRECISION, the contact-lookup cache contradicted the sequential
    try/catch. ACCEPT. `resolveContact(phone, email)` memoizes the PAIR
    operation exactly as today's block; the equivalence fixture adds a
    throwing phone lookup (5.10, 7.2).
15. LOW PRECISION, test 3 must count finished requests. ACCEPT (7.3 preamble).
16. LOW PRECISION, "badge cap" does not justify Unknown. ACCEPT. Unknown's
    rationale stated: the queue's front is the triage set and the client
    cannot reason about its order (5.6, 8).

Round 4 goes to reviewer A (continued) as the TERMINAL round: a decision
change there stops the loop and goes to Cameron as an open question.
