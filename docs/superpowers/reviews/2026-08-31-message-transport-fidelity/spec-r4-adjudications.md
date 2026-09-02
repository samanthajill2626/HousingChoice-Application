# Message transport fidelity design - round 4 adjudications

Spec reviewed: v4
Reviewer: spec review round 4 A
Findings: 1

Disposition counts:

- ACCEPT: 1
- REJECT: 0
- DEFER: 0

## 1. Outbound completeness has no coherent dynamic membership set

Disposition: ACCEPT

Source-time relay slots are not a truthful aggregation set because the worker
routes to membership-at-execution. V5 adds per-slot transport aggregation state:
`planned`, `attempted`, or `excluded`. Before the first provider send, the worker
initializes all current-member slots and marks the current candidates planned.
It excludes a stale planned leg that leaves before attempt, includes a member
added for a later execution, and permanently retains a leg once the application
reaches its provider-call boundary.

This state is observational only. It does not choose recipients or move the
existing per-member suppression check. A failed partial preflight aborts before
provider sends, preventing a subset from appearing complete. The presenter
aggregates planned and attempted slots, excludes state-absent and excluded slots,
and shows requested only when no slot participates.

## Review cap

This was the fourth and final allowed specification review round. The accepted
finding is resolved in v5 and is disclosed at the human specification gate; no
fifth review round was opened.
