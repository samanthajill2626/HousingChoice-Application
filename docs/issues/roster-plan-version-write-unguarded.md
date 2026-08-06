---
id: roster-plan-version-write-unguarded
title: setRoster VERSION-conditional write path carries no thread-pointer guard (double-failure residual)
type: bug
severity: low
status: open
area: app
created: 2026-08-06
refs: app/src/repos/toursRepo.ts, app/src/repos/placementsRepo.ts, app/src/services/rosterEdits.ts
---

**Problem.** The contact-rosters MF-C fix pointer-guards the MATERIALIZE
branch of setRoster (attribute_not_exists(roster) AND no thread pointer), so
a plan edit racing a concurrent open can no longer re-materialize a plan onto
a thread-bearing owner. The VERSION-conditional branch (an edit applied onto
an EXISTING override with the rosterVersion guard) still has no pointer
guard: if a provision's clearRoster failed (leaving a stale override) AND a
plan edit races in, the versioned write lands a v2 plan on a thread-bearing
owner and the route answers 200. Probe-proven during the planner-wave
re-verify - the interleaving run (clearRoster deliberately not run) ended at:

```
{ status: 200, groupThreadId: 'conv-raced-open',
  roster: [contact-tenant-1, c-pm, c-caseworker], rosterVersion: 2 }
```

Requires a prior clearRoster failure PLUS the race; the written plan is INERT
(D1: a thread-bearing owner resolves from participants -
lib/rosterResolution.ts returns source 'participants' whenever the pointer is
set, and the tour-to-placement conversion explicitly refuses to carry a plan
off a thread-bearing tour), so the blast radius is a misleading 200 and a
stale attribute - not a wrong roster.

**Suggested fix.** Mirror MF-C on the version branch: add the same
attribute_not_exists pointer condition to the versioned UpdateExpression,
and map the disambiguated conflict to the existing 409 thread_exists. Or,
if lazy-delete is preferred end-to-end, have the plan-edit path re-read the
owner before answering and refuse when a pointer appeared mid-write.
