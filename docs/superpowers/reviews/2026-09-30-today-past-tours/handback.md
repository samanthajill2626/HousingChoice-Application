# Handback - feat/today-past-tours (Sam's #18, Today follow-ups)

Branch `feat/today-past-tours`, worktree `W:\tmp\today-past-tours`, cut from
main @f93b7381 (main has not moved since). Small-fix lane (dashboard only, no
endpoint, index or data change), all five gates plus a new e2e spec.
UNMERGED - Cameron's gate.

## What it does

Today gains a "Past tours needing an outcome" section after "Follow-ups due":
the Tours page's Past-tab rows (same loader, same window, same rule) minus
no-shows. Up to five, most recent first; a "See all N on the Past tab" link
(N = what the Past tab lists) or "Open the Past tab". Each row: tenant,
property, date and time, and the Past tab's state chip (Not marked / Needs
outcome / Needs placement). A Needs-outcome row opens its tour with Record
outcome up; the tour page's back arrow reads "Back to Today" and returns
there - for every tour opened from Today (queue rows and the relay close-nag
"Open" too). Live: a tour change reloads the section and the queue; a failed
reload keeps the rows and says so. Tenants soft-deleted are left out, as on
every Today row. No count or badge anywhere.

Decisions (Cameron, 2026-09-30): no-shows off Today (no exit yet, open with
Sam); the Past tab's window (Today follows it if it changes); cap 5, most
recent first, after Follow-ups due; no badge.

Design: client-side, reusing `usePastTours` + a filter on its SELECTED rows
(`selectTodayPastTours`) - one rule. Server-side assembly was ruled out: app
and dashboard share no code, so it would be a second copy of the rule.

## Commits

82ea97a3 feature - 9a202434 / 560ace84 / e5007eb6 / 30cb18b5 review records -
d955c00f / 47e7d1fe / f2334402 / d40d02ed fix waves - plus this record set.

## Independent review (plan-blind, 4 rounds - the cap)

One reviewer, continued each round. Round 1: 0 blocking/high, 2 medium, 11
low, 2 plausible. Rounds 2-4: nothing above low. Every finding ruled in the
`adjudications*.md` / `*-and-rulings.md` files beside this one. Rejected, with
the reviewer conceding each: M1 (all-history toured read - the app closes
decided tours), L4 (ordering is Cameron's ruling), L6, N3's event filter, P-b
(no client timeouts is app-wide). Round 3's "hold the lower groups" fix was
reverted in round 4 (it made core queue content wait on best-effort lookups).

Residual, by choice: when the section lands a moment after the queue, "AI
suggestions to review" (the one group below it) can shift down; the section
labels in one round trip after its reads, so the shift is brief.

## Gates (final, HEAD d40d02ed) - details in gate-runs.md

typecheck 0 - npm test 1 (only `e2e/support/maintenancePage.test.ts`:
Terraform not on PATH on the new PC) - smoke 0 - e2e 1 (292 passed; the new
spec passed in the suite; failures are the machine's socket exhaustion, shared
with a full main baseline run, plus a pre-existing contact-create failure that
reproduces alone on main) - lint 1 (6 errors, all pre-existing on main, none
added).

## Issues filed / updated

- NEW `today-page-no-refetch-on-reconnect-or-midnight` (low)
- NEW `fact-extraction-spec-vacuous-today-absence-checks` (low)
- NEW `contact-create-link-relationship-e2e-fails-on-rerun` (med, on main)
- UPDATED `tours-scheduled-range-query-unpaginated` (Today now reads it too)

## Owed by Cameron

1. Merge (and deploy when ready).
2. New-PC environment, found by these gates:
   - Terraform >=1.15 on PATH (npm test and one e2e spec fail without it);
   - the project Playwright MCP browser (`npx @playwright/mcp install-browser
     chrome-for-testing` - a download);
   - the full e2e hits Windows ephemeral-port exhaustion (default dynamic
     range 49152+16384; 5-10k sockets in TIME_WAIT after a run) - a system
     setting, your call.
3. Cleanup on your go: the scratch baseline worktree
   `W:\tmp\today-past-tours-base` (detached at main, no branch, no changes),
   and this worktree after merge.

## For the Improvements Tracker (#18), written to Sam

Your Today page now has a "Past tours needing an outcome" list: the five most
recent tours that were never marked toured, are waiting on an outcome, or are
waiting on their placement, with a link to see all of them on the Tours
page's Past tab. Click one to open the tour, and a tour that is waiting on an
outcome opens straight to Record outcome. No-shows stay on the Past tab only
for now, until you decide how a no-show should come off the list.
