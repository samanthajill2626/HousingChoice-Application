# Task 5 Relay source and fan-out slice report

## Shipped contract

New Relay source rows and source-time slots persist version-1 requested intent from
durable attachments and stable media availability. The worker splits immediately:
schema-absent sources retain the exact legacy send, retry, continuation, and
queued-pending release path, while version-1 sources preflight, track aggregation,
prepare current sends, and apply child-field results.

Versioned preflight distinguishes the full sender-excluded current roster from a
continuation's send subset, reconciles only genuinely removed never-attempted
members, and retains suppression exclusions across redelivery.

## Commits

- `dc6f1410 feat: track transport across relay fanout`
- `439621a4 fix: preserve Relay preflight exclusions`

## Focused proof

The initial Task 5 run proved red 7/83 then green 94/94 across relay API and
fan-out tests, with app typecheck and targeted ESLint exit 0. The correction proved
two intended red failures then `relayFanOut.test.ts` green 44/44 and app typecheck
exit 0. Initial sandbox Vite temp-file EPERM failures occurred before discovery;
allowed-environment reruns supplied all product proof.

## Review and resolution

Independent review confirmed legacy reachability but found a continuation subset
incorrectly excluding a current roster member and a suppressed exclusion reopening
on redelivery. Both fixes were accepted, committed, and independently cold-reviewed
as CONFORMS/PASS with no new reachable regression.

No persisted-announcement, native-group, non-live, projection, or UI file was
changed in this slice.
