---
id: relay-provisioning-sentinel-leak
title: A crashed provision can leak the provisioning:<id> sentinel pointer - now with a wider blast radius
type: bug
severity: med
status: open
area: app
created: 2026-08-05
refs: app/src/services/rosterProvision.ts
---

**Problem.** Tour provisioning claims the thread pointer with a transient
`provisioning:<tourId>` sentinel, released on failure - but a hard crash
between the claim write and the release leaks the sentinel forever. That is
pre-existing relay behavior; the contact-rosters feature widens its blast
radius: a leaked sentinel makes the roster resolver answer `unavailable`
(pointer set, thread unreadable), which by SPEC (the cardinal rule: never
fall through to plan/default) means the People card renders unavailable and
reminder/nudge rungs are left UNCLAIMED and re-listed every poll,
indefinitely - no send, no skip, no bound. Both ladders WARN on every such
poll (rung id + owner), so the wedge is visible in worker logs, but nothing
self-heals. Before this feature the same leak merely made reminders fall
back to 1:1 delivery; the spec deliberately outranks wrong-roster sends over
missed sends, so the new behavior is the intended trade - the LEAK is the
bug, not the refusal.

**Suggested fix.** A janitor: on poll (or on resolver hit), a sentinel
pointer older than a generous provisioning timeout (say 15 minutes, judged
from the pointer's write time or the tour's audit trail) is released and the
failure audited - restoring the pre-claim state the crash lost. Belt-and-
suspenders: the provision flow could write the sentinel with a TTL-style
timestamp embedded so age is self-evident.
