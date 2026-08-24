---
id: inbox-nav-badge-reconcile-guard-timing-red
title: inbox-nav-badge's anti-vacuity reconcile guard enforced its precondition by timing, so full-suite load fired a deliberate red with no bug present
type: bug
severity: low
status: resolved
area: e2e
created: 2026-08-24
resolved: 2026-08-24
refs: e2e/tests/dashboard-next/inbox-nav-badge.spec.ts:74
---

**Reported by a concurrent agent (2026-08-24), adjudicated and fixed the same
day.** Their gate run (voice-pool-multiplex worktree, unrelated voice-webhook
change, 27.6m, 252/253) failed one "instant a row is acted on" test with the
spec's own guard message:

```
the server reconcile beat the snapshot - the optimistic assertion below would
prove nothing
```

Their isolated re-run: 3/3 in 40s, same commit. Correctly diagnosed in the
report: `expectBadgeAfter` snapshots the badge in the gap between act() and the
server's unread-count response, and GUARDS that the response has not landed -
because the retrying assertion would otherwise pass on a build with no
optimistic layer at all, cleared by the reconcile for the wrong reason. Under
load the act()-to-snapshot window stretches and the response lands inside it.

**Ruling: the guard stays a hard red - soft-skipping would drop the optimistic
assertion exactly when load makes it interesting - but a correctness
precondition must be enforced BY CONSTRUCTION, not by winning a race.** The
helper now intercepts `COUNT_PATH` with `page.route` and holds the response
until the snapshot is taken (released in a `finally` so a failed assertion
cannot strand the app's fetch), then lets the reconcile land and asserts the
server agrees. The guard remains as a backstop: it can now fire only if the
hold itself is broken (a renamed endpoint, a second un-intercepted path
feeding the badge) - which is a bug worth a red.

Probed in both directions, on the exact conditions from the report:

- A 2,000ms delay injected between act() and the snapshot - the stretched
  window load produced - passes 3/3 WITH the hold (it failed the gate without).
- Breaking the hold (releasing before act()) with the same delay fires the
  guard with the reported message verbatim. Teeth intact.

Restored, 3/3 clean (23.2s).

Third distinct failure mode of this one spec, after
[`inbox-nav-badge-geometry-measured-mid-animation`](./inbox-nav-badge-geometry-measured-mid-animation.md)
(fixed by polling) - both times the cure was the same shape: replace a
timing assumption with a mechanism.
