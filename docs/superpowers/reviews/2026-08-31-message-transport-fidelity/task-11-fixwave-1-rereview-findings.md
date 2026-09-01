# Task 11 fix wave 1 rereview findings

## Reviewed commit

`043f1197 fix: preserve legacy recipient transport copy` against `78d2dc13`.

## P1: Collapsed delivery-chip accessible names still announced legacy Unknown

The revealed recipient row used the parent schema gate, but the independent
`recipientSummaryName` helper used by collapsed rollup and all-opted-out chip labels
did not. Schema-absent Relay and native Group MMS summaries therefore still appended
unsupported `Unknown` recipient transport for screen-reader users.

## P1: Existing inbound Relay delivery test contradicted approved disclosure

`Timeline.delivery.test.tsx` still asserted that a disclosed inbound Relay source
had no recipient list. The approved contract and Task 11 implementation allow its
progressively populated outbound-leg disclosure, so the unchanged assertion made the
focused delivery suite red and misdescribed intended behavior.
