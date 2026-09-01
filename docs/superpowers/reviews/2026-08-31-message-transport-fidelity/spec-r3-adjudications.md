# Message transport fidelity design - round 3 adjudications

Spec reviewed: v3
Reviewer: spec review round 3 A
Findings: 2

Disposition counts:

- ACCEPT: 2
- REJECT: 0
- DEFER: 0

## 1. Relay retry rule contradicts continuation-slot semantics

Disposition: ACCEPT

The broad retry sentence was wrong. The v4 contract follows each existing
storage path: a manual direct 30003 retry creates a new message row and intent,
while a relay continuation reuses the same member-key slot, requested value,
delivery state, SID pointer, and callback route. No per-attempt relay storage is
introduced.

## 2. Post-seed team-member addition lacks a requested slot

Disposition: ACCEPT

All relay executions, not only inbound relay executions, now require a
conditional pre-send slot initializer for a current roster member whose slot is
absent. Team-authored and persisted-announcement sources copy the source's
immutable requested transport; inbound sources use adapter-classified intent.
The initializer is absent-only and preserves an existing slot on races. Focused
verification must cover a member added after source append but before worker
execution.

## Resulting invariant

Transport observation follows the current relay storage model. It neither
snapshots recipients nor invents per-attempt slots, and every newly discovered
current recipient gains immutable requested intent before suppression or
provider handling.
