---
id: self-guided-group-reminder-gate
title: Group text on a self_guided tour - reminder routing ignores it (tourType gates group rungs)
type: decision
severity: med
status: open
area: app
created: 2026-08-05
refs: app/src/jobs/tourReminders.ts
---

**Problem.** The People card can open a group text on a `self_guided` tour,
but reminder ROUTING still gates group-rung delivery on `tourType` - so the
group exists while the reminder ladder keeps texting 1:1 as if it did not.
Operators see a live group and reasonably assume reminders go there. Filed
per the contact-rosters spec (section 12).

**Suggested fix.** Decide one of: (a) hide/disable [Open group text] on
self_guided tours with a reason, or (b) widen the reminder gate to "a group
thread exists", making the pointer - not the tourType - the routing truth.
(b) matches the rosters feature's direction (the thread roster is the fact),
but it changes reminder copy targeting and needs its own tests either way.
