---
id: relay-duplicate-warning-stale-after-defer
title: The duplicate warning is preview-time only, so preview-to-create is check-then-act on every path
type: improvement
severity: low
status: open
area: app
created: 2026-08-18
refs: app/src/jobs/rosterActions.ts, app/src/services/relayGroupDuplicates.ts:109
---

**Problem.** Duplicate detection runs at PREVIEW time only. Preview and create
are two separate requests with no lock between them, so EVERY open is a
check-then-act. Quiet hours does not create that window; it only widens it.

The IMMEDIATE path has the window too. Nothing here is quiet-hours specific:
operator A GETs `preview-open` at t0 and sees no duplicate; operator B POSTs
`/api/relay-groups` for the same set of people at t0+1s; operator A confirms at
t0+3s. Two live groups, two numbers, and the warning was never capable of
firing. Seconds is a short window, but two operators working the same tenant is
exactly when it is entered. Do not read this issue as "the synchronous path is
safe and only the deferral is stale".

Quiet hours WIDENS the same window from seconds to hours. Inside the window the
confirm dialog's default action is a DEFERRAL: the open is queued and applied at
quiet-end, which can be many hours after the operator read the dialog. The
warning they saw - or did not see - is a statement about the world at preview
time, and nothing re-checks it before the group is actually created.

Both directions go stale, on either path:

- A duplicate created by someone else in the interval is never warned about. The
  operator confirmed against a preview that honestly said there was no existing
  group, and one appeared afterwards.
- A duplicate that WAS warned about may have been closed in the interval. The
  operator was told about a conflict that no longer exists by the time their
  group opens, and may have backed out for nothing.

This is staleness, not a wrong refusal. Nothing refuses on this path (spec D5),
so the failure mode is an absent or unnecessary piece of advice, never a blocked
action or a lost deferral. That is what keeps it low severity. But it is a real
limit of a preview-time-only check and it should not be discovered later as a
surprise.

**Suggested fix.** Options, cheapest first. Do nothing and accept it - the harm
of a missed warning is a confusing week, not a misdelivered message. Or re-run
detection in the deferred-open job and record the result on the activity trail,
so the duplicate is at least VISIBLE after the fact even though nobody was there
to be warned. Do NOT make the deferred job refuse on a duplicate: that would
turn a warning into a refusal on the ordinary evening path, which is precisely
the design the spec deleted.

Closing the immediate-path window means MUTUAL EXCLUSION across preview and
create - a lock, a reservation on the participant set, or a conditional write on
a stored roster digest - and that was judged mis-priced for what it buys. The
thing being protected is a piece of advice, not a delivery decision: the loss is
a confusing week for one household, and the cost is a new persisted key plus a
lock-holder failure mode on the create path that can refuse a legitimate open.
Recorded so the trade is on the record, not so it gets built.
