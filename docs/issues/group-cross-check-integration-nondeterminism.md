---
id: group-cross-check-integration-nondeterminism
title: groupCrossCheck.test.ts fails nondeterministically under DynamoDB Local contention
type: bug
severity: med
status: open
area: app/group-rail
created: 2026-08-18
refs: app/test/groupCrossCheck.test.ts
---

**Problem.** `app/test/groupCrossCheck.test.ts` (landed with the cross-check
fix @564712c2 on main) fails nondeterministically when the shared
`hc-dynamodb-local` container is under load, and the failing TEST DIFFERS run
to run - observed on 2026-08-18 during the contact-create-relay-group gates,
with a second full battery running concurrently against the same container:

- full `npm test` run 1: "RAPID SAME-AUTHOR messages match one-for-one, in
  order" failed (file duration 67.6s)
- paired isolation run: "a DUPLICATE redelivery of the same IM SID is deduped,
  not double-counted" failed (spy called-with mismatch)
- solo isolation run: 26/26 GREEN, exit 0 (16.6s)
- full `npm test` run 2: "ONE lost filing reconciles ONE row - a later row
  outside its window still alarms" failed (file duration 64.2s)

The contact-create-relay-group branch touches no cross-check runtime or test
file (`git diff main...HEAD` is empty for the area), so this is not a
regression from that branch - it is either timing assumptions in the suite
(spy-order/window assertions racing real DynamoDB Local latency) or genuine
sensitivity to a busy shared container. Note the file's duration roughly
QUADRUPLES under contention (16.6s solo vs ~65s in a loaded full run), which
is consistent with latency-dependent assertions.

**Suggested fix.** Make the suite's ordering/window assertions robust to
latency (explicit waits on state rather than call-order spies, or widened
windows), or give the file a dedicated table prefix AND serialize it away from
other DynamoDB-heavy suites. Until then, treat it like the other known
DynamoDB Local flakes: re-run once and report both runs before blaming a
branch.
