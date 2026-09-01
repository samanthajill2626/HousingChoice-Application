# Task 10 presenter review findings

## Reviewed commit

`be6f2f7f feat: present requested and actual transports` against `a738948b`.

## Findings

### P2: State-absent recipient slots blocked complete aggregate presentation

`dashboard/src/lib/messageTransport.ts` treated every non-excluded recipient as
expected. The approved design permits only `planned` and `attempted` slots to
participate in actual completeness, so a state-absent source-time slot incorrectly
kept a completed Relay message at requested-only.

### P2: Known actual evidence without a request rendered Unknown

The presenter discarded a uniform completed actual transport when the requested
field was absent. The approved design says requested-absent plus actual-known is
actual-only, including completed one-actual recipient aggregation.

### P2: Opted-out recipient rows lost requested transport

The recipient presenter returned no transport for every excluded row. An excluded
`contact_opted_out` row remains visible with its existing suppression copy and must
also show requested transport; only excluded rows without that code are hidden.
