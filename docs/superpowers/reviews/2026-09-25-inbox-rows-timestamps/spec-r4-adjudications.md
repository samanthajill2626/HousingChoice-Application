# Spec review round 4 - adjudications (terminal round)

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`
Reviewed: DRAFT 5 @b53a9e8a. Result: DRAFT 6, review CLOSED.
Reviewer: A, continued (`spec-r4-reviewer-a.md`, 8 findings, all labelled
PRECISION by the reviewer; the reviewer states the round is precision-only).
Adjudicator: the planner (this session), 2026-09-25.

## Counts

- 8 accept, 0 reject.
- Decisions changed by this round: 0. Under the skill's stop rule (a round of
  precision edits alone is the terminal round) the loop ends here, one round
  inside the four-round cap.

## Findings

1. MEDIUM, the re-walk fold's range started at the first page's newest row,
   so a gone row at the top of the tail survived. ACCEPT. The walked range is
   `[freshOldest, headBoundary)`, bounded above by the triggering head's
   boundary (5.8).
2. MEDIUM, `loadingMore` is a shared flag; a discarded loadMore's `.finally`
   released the hold mid-walk. ACCEPT. The walk aborts any in-flight loadMore
   when it starts and holds its own `rewalking` flag, which `enabled` (5.2)
   and the button honor (5.5, 5.8).
3. MEDIUM, a store-hit PUSH does not start at the top because nothing resets
   the container's `scrollTop`. ACCEPT. The layout effect sets 0 explicitly
   on a non-POP store-backed mount, which also makes the 0 seed true (5.8).
4. MEDIUM, the re-walk's `start` was ambiguous (the kept tail's cursor after
   branch P). ACCEPT. `start` is the head read's own page cursor `C`; the hook
   test asserts the first re-walk request's cursor (5.8, 7.1).
5. LOW, gating the unmount save on `aliveRef` could silence it. ACCEPT. The
   unmount save gates on `ready` only (5.8).
6. LOW, `rewalkDueRef` never cleared when no walk is owed. ACCEPT. Cleared by
   the walk starting, a committing head read that leaves no paged tail, or a
   reset (5.8).
7. LOW, invariant 9 held only in branch P. ACCEPT. `dedupeConversations` runs
   after every merge branch, every loadMore append and the fold (5.5, 5.6).
8. LOW, `intersecting` survived the sentinel's unmount. ACCEPT. Reset to false
   when the sentinel unmounts (5.2, 7.1).

## Review totals across four rounds

- Round 1 (two reviewers): 45 findings, 39 accepted, 1 rejected (the mockup as
  build contract; conceded by the reviewer in round 2), 2 partial (the
  seen-set pinning test kept out of scope; conceded), 2 overtaken, 1 accepted
  as wording. 7 decisions changed.
- Round 2: 17 findings, all accepted. 5 decisions changed.
- Round 3: 16 findings, all accepted. 1 decision changed (the incomplete-head
  rule made consistent with decision 7).
- Round 4: 8 findings, all accepted. 0 decisions changed. Terminal.

Rejections standing at the gate: none. Two partial acceptances stand (the
`seen-set-max-equals-max-inbox-limit` pinning test stays out of this mission;
the mockup is the approval record, section 5.4 is the build contract).
