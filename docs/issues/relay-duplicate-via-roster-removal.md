---
id: relay-duplicate-via-roster-removal
title: Removing a member can land a group on an existing roster with no warning
type: improvement
severity: low
status: open
area: app
created: 2026-08-18
refs: app/src/services/relayMembers.ts, app/src/services/relayGroupDuplicates.ts:109
---

**Problem.** The duplicate warning runs in the OPEN preview only. Removing a
member creates the same end state by a path that never previews an open:
remove C from a live `{A, B, C}` while a live `{A, B}` already exists, and there
are now two live threads for exactly `{A, B}` - the state the warning exists to
flag - without anything having been created.

Verified as reachable but low-risk: every `removeMemberFromRelay` caller is an
operator route, and no system or job path converges rosters on its own. So this
needs a person to do it deliberately, and it cannot happen in the background.

**Suggested fix.** Not simply "run the same check on remove". The interaction is
different in kind: the operator has just CONVERGED two conversations rather than
forked one, so the useful message is not "a duplicate already exists" but
something closer to "these two threads now hold the same people - do you want to
merge them?". That wants different copy and probably a real merge operation
underneath, which is a larger piece of work than the removal path itself.
Warning with the open-path copy here would be actively misleading.
