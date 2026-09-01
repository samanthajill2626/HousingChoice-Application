# Task 6 persisted announcement slice report

## Shipped

Persisted Relay announcements now use version-1 requested intent, planned/attempted/
excluded recipient slots, prepared sends, and child-field results. Suppressed legs
remain excluded with existing diagnostics and no actual evidence. `persist:false`
announcements stay legs-only with their original adapter path and no transport row.

## Commit and proof

- `e26226b3 feat: track transport on relay announcements`
- Red proof: 4 expected failures with 12 passes; green focused announcement test
  16/16; app typecheck exit 0.

The initial Vite temp-file EPERM occurred before discovery; allowed-environment
runs supplied the red/green evidence.

## Review

Independent review CONFORMS/PASS. It swept persisted/persist-false branches,
sender contract callers/fakes, slot transitions, result preservation, aggregate
compatibility, and safe logs. The route/job type updates are minimal required
carrier-sender compatibility plumbing; no unrelated behavior changed.
