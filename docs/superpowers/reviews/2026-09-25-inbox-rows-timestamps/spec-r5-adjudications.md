# Spec review round 5 - adjudications (the Option B trim)

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`
Reviewed: DRAFT 7 @05d94cc5 (the removal of tail persistence after Cameron
chose Option B at the spec gate). Result: DRAFT 8, review CLOSED.
Reviewer: A, continued (`spec-r5-reviewer-a.md`, 6 findings, all PRECISION;
the reviewer states the round is precision-only and the removal left nothing
dangling).
Adjudicator: the planner (this session), 2026-09-25.

## Counts

- 6 accept, 0 reject. Decisions changed: 0.

## Findings

1. HIGH PRECISION, tests 2 and 3 asserted no auto-load after the page-one
   refresh, but the shrunken list leaves the sentinel in view and the head
   read's epoch bump fires it (chaining at `limit=2`). ACCEPT. Both tests now
   assert the ORDER in the finished-request log (one head read, then cursor
   requests, none before) and the settled final list; invariant 2 and the
   5.8 return paragraph say the same (7.3, 6, 5.8).
2. MEDIUM PRECISION, the Outcome and section 2 overclaimed: today's SSE
   reconcile never enters `loading`, so page one and the scroll position
   already survive a live update. ACCEPT. Verified against `useInbox.ts`
   (only the filter effect and `retry()` set `loading`). The Outcome now
   names the Back restore as the new behavior and the live-update gains as
   page size, branch I and the banner; section 2 corrected; the anchoring
   give-up is stated as a trade-off in section 8 (1, 2, 8).
3. MEDIUM PRECISION, the issue file and the spec pointed at DRAFT 5
   @b53a9e8a; DRAFT 6 @35843a25 carries the round-4 fixes, unreviewed.
   ACCEPT. Both point at DRAFT 6 and the issue says one more review round is
   owed before building it.
4. LOW PRECISION, a restored `autoLoadArmed` fires a cursor request at mount
   that the restore's head read discards. ACCEPT. `autoLoadArmed` is no
   longer saved; a restore mounts unarmed and the first complete head read
   arms (5.2, 5.8).
5. LOW PRECISION, "does not starve" was left over from the tail model.
   ACCEPT. Reworded for Option B (8).
6. LOW PRECISION, the `ListState.head` comment was inexact after branch I.
   ACCEPT (5.5).

## Review totals across five rounds

86 + 6 = 92 findings; 89 accepted, 1 rejected (conceded), 2 partial
(conceded). Decisions changed: 13, all in rounds 1-3; rounds 4 and 5 were
precision-only. The spec is approved for planning under Cameron's Option B
ruling of 2026-09-25.
