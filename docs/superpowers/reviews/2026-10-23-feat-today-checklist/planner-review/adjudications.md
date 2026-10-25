# Planner handback review - adjudications (round 1)

Reviewed tip: 4508f61f (gated f082374f). Reviewers (opus, read-only, no test
runs): spec-conformance (spec r8 + work map) -> spec-conformance.md;
plan-blind adversarial (diff + repo only) -> adversarial.md. Neither saw the
plan, the build records or the planner's conversation checklist.

Totals: spec-conformance 134 points - 131 CONFORMS, 3 PARTIAL, 0 MISSING, 0
DEVIATES; findings 0 blocking / 0 high / 0 medium / 2 low / 4 info.
Adversarial 0 blocking / 0 high / 0 medium / 3 low / 4 info.

## Rulings

- ADV-1 (low, CONFIRMED by the planner at QuietShares.tsx:179, :206 and
  Today.tsx:509-536) - ACCEPT, fix wave PFW1-1. With `truncated` true and no
  quiet person in the first 100 available properties, Quiet shares returns
  null (the note never renders) and "All caught up" can show although
  properties beyond the first 100 were never read. An unknown state is not
  "done" (the same principle as spec 2.3/2.5 and code review R3-1). Fix:
  (a) a truncated read is never caught up - `allCaughtUp` requires
  `!quietShares.truncated`; (b) with `truncated` true the section renders
  (heading + the note) even when it has no property lines; (c) the note says
  what was read, in the Follow up tab's wording style (FollowUpView.tsx ~232),
  e.g. "Only the first 100 properties were checked." - ASCII, final copy the
  fixer's choice in that style. Unit tests RED first for (a) and (b). Not
  reachable in prod today (tens of available properties), so low.
- ADV-2 (low) - NO CHANGE, by design. Spec 7.3 stamps on provider
  acceptance; Cameron's ruling (2026-10-24) is that a call counts on ANY
  attempt, and the clock measures staff reaching out, not delivery. A
  filtered text (30007) or a bounce is a delivery problem the thread already
  shows. Reported to Cameron as info in the verdict.
- ADV-3 (low) - NO CHANGE. The fail-open on a failed owner read is
  documented at today.ts ~984-990 and transient (the next refetch corrects
  it); the row opens the contact page, which shows the contact's type before
  anyone marks it Inactive. Failing closed would hide real unknown callers on
  a read error, which is worse for a must-do list.
- ADV-4 (info) - ACCEPT, fix wave PFW1-2 (trivial). In sendEmailMessage.ts
  move the W3 recordStaffOutreach call down to the post-send bookkeeping's
  end (after the SES-id alias write), keeping the one contact.updated as the
  send's last event and still never throwing. Existing W3 tests must stay
  green; add or adjust one ordering assertion if one exists.
- ADV-5 (info) - NO CHANGE. Display-only, self-healing, already tracked in
  docs/issues/pane-override-stale-refetch-race.md; PFW1-3 adds one line
  there naming the new trigger.
- ADV-6 (info) - NO CHANGE. The 20-row AI suggestion cap predates the
  branch.
- ADV-7 (info) - ACCEPT as docs, PFW1-3: add the two points (useToday aborts
  while the server keeps computing; Tours to book's per-row point reads are
  sequential) to docs/issues/today-quiet-shares-read-cost.md.
- SC-1 (low, PARTIAL 2.3/5.3) - NO CHANGE. Already filed by the build as
  docs/issues/today-past-tours-labeling-settle-window.md (R4-2); one round
  trip, pre-existing shape.
- SC-2 (low, PARTIAL 7.5) - NO CHANGE. Body matching is plan ruling PR38,
  which the planner made and Cameron's plan approval covered; the dry run
  DOES report the exclusions (`excluded_nudge_body`,
  `excluded_reminder_body` and the time-matched sub-count,
  backfill-last-reached-out.ts ~147-171). Over-exclusion needs a staff text
  identical to a catalog nudge body - negligible, and it only makes a
  person show a little early.
- SC-3 (info) - NO CHANGE. Matches spec 7.3's letter; recorded as residue
  R-1 in the handback; such rows predate the 14-day window.
- SC-4 (info) - NO CHANGE. Recorded in the handback and RUNBOOK.
- SC-5 (info) - NO CHANGE. Same behavior.
- SC-6 (info) - NO CHANGE, recorded. A staff Retry of an AI-authored row
  stamps live (a person chose to resend) while the backfill skips non-teammate
  authors; the difference only affects the 14 days before the deploy.

## Fix wave PFW1 scope

PFW1-1 (ADV-1), PFW1-2 (ADV-4), PFW1-3 (docs: ADV-5, ADV-7). Run by the build
orchestrator (one fresh foreground child), RED-first tests, the affected
workspace tests, typecheck, lint on touched files, and the Today e2e spec.
Then both planner reviewers are continued with the re-review charge, and the
planner runs the five gates on the final commit.
