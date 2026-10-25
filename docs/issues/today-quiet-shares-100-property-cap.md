---
id: today-quiet-shares-100-property-cap
title: Past 100 available properties, Today never reads All caught up - the Quiet shares walk stops at 100 and a truncated read is never done
type: improvement
severity: low
status: open
area: app/today
created: 2026-10-25
refs: app/src/services/followUps.ts, dashboard/src/routes/today/Today.tsx, dashboard/src/routes/today/QuietShares.tsx, dashboard/src/routes/matching/FollowUpView.tsx, e2e/performance/routes.ts
---

**Problem.** The Follow up core that feeds Today's Quiet shares
(`collectWaitingFollowUps`, `app/src/services/followUps.ts` ~146-164) walks
at most 100 available properties and sets `truncated` when more exist. Since
the tracker #31 planner review (fix PFW1-1, finding ADV-1), Today treats a
truncated read as unknown, not done: the Quiet shares section shows its
heading and the note "Only the first 100 available properties were
checked." even with no rows, and the page never reads "All caught up"
(`Today.tsx` `quietTruncated`; `QuietShares.tsx`). That is right for one
load, but the walk ALWAYS stops at 100, so once the organization has more
than 100 available properties every Today load is truncated: "All caught
up" becomes permanently unreachable and the checklist carries a section
nobody can act on. Found independently by both planner reviewers (ADV-8,
R2-1). Not reachable today: prod has tens of available properties.

Three smaller shapes of the same cap, recorded here so they move together:

- The Follow up tab (`FollowUpView.tsx` ~221-232) returns its empty state
  before its own truncated note, so a truncated empty read there says
  "Nothing waiting on a reply." (pre-existing; the tab was deliberately left
  unchanged by tracker #31). ADV-10.
- The perf contract (`e2e/performance/routes.ts` TODAY_TERMINAL ~405-416)
  has no state for the truncated-empty section, so a perf sample in that
  world would read `unknown`. The perf seed cannot produce it today. ADV-11,
  R2-2.
- `settling` in `Today.tsx` (~546) ignores the truncated flag, so the
  spinner can show above the note while past tours label. Cosmetic. ADV-9,
  R2-3.

**Trigger.** Fix before available properties reach about 80 (prod), or when
a seed or import would push any environment past 100.

**Suggested fix.** Page the properties walk to completion (bounded by a
higher hard cap with a WARN, as the unread walk does) so `truncated` means a
genuine overflow, not a routine state; then decide with Cameron whether a
genuine overflow should block "All caught up". Fix the Follow up tab's empty
state, the perf terminal and `settling` in the same change.
