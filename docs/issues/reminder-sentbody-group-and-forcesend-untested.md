---
id: reminder-sentbody-group-and-forcesend-untested
title: sentBody is snapshotted on all three claimSend paths but only the 1:1 poll path is test-covered
type: debt
severity: med
status: open
area: app
created: 2026-08-06
refs: app/src/jobs/tourReminders.ts:788, app/src/jobs/tourReminders.ts:935, app/src/jobs/tourReminders.ts:1148, app/src/repos/tourRemindersRepo.ts:129, app/test/tourReminders.test.ts:707
---

**Problem.** `claimSend(reminderId, claimedAt, sentBody?)`
(`repos/tourRemindersRepo.ts:129`) snapshots the body composed for THIS send
onto the row in the same conditional write, so the dashboard can show what
was actually sent rather than re-deriving it from a template that may have
changed since. There are THREE call sites in `jobs/tourReminders.ts`:

- `:788` in `processReminderRow` - the tenant-1:1 poll path
- `:935` in `sendGroupReminder` - the group-routed poll path
- `:1148` in `forceSendReminder` - the human "Send now" path

Only the FIRST is covered for the snapshot. `app/test/tourReminders.test.ts`
around `:680-708` asserts `sentBody` is stored when a body is passed and
absent when it is not - a repo-level pair, exercised through the 1:1 poll.
Nothing asserts that the group path or the force-send path passes a body at
all. Both would keep passing every existing test if their `body` argument
were dropped, silently degrading the feature to "the 1:1 rung remembers what
it sent; the other two forget".

`sentBody` is main's feature (feat/tour-reminder-details, merged @60e7c319),
not the contact-rosters branch's. It surfaced during the contact-rosters
second main sync (2026-08-06), where the ladder seam was resolved GATE-FIRST
and all three sites were hand-verified to still pass a body after the merge.
That verification was a one-time human read, not a regression pin - the next
refactor through this area has nothing stopping it.

Reachability of the silent-loss case: any edit that reorders or extracts the
compose step on the group or force-send path (exactly what the roster merge
just did to the 1:1 path) can drop the argument without a single red test.

**Suggested fix.** Two assertions mirroring the existing 1:1 pair:

1. Group path - arm a `landlord_led`/`pm_team` tour with a usable group, run
   the poll, assert the claimed row's `sentBody` equals the composed group
   body (not merely that it is defined).
2. Force-send path - `POST` the send-now route for a pending rung, assert the
   same on the claimed row.

Prefer composing the expected string through the shared composer
(`composeTourReminderBody` / the e2e `tourReminderBody` helper) rather than a
literal, so a copy change updates the expectation instead of breaking the
test - the same convention the reminder-assert steps already use.
