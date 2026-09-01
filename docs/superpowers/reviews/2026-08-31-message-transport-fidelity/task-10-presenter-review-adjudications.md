# Task 10 presenter review adjudications

## P2 state-absent completeness: accepted

Fix the expected-set predicate so only `planned` and `attempted` slots participate
in transport completeness and actual aggregation. Keep state-absent slots visible
and counted by delivery presentation as required by the design.

## P2 known actual without request: accepted

Use the approved design section 9.3 rule: requested absent plus actual known renders
the known actual. Correct the conflicting Task 10 plan table row in the same records
commit so later work does not reintroduce the wrong expectation.

## P2 opted-out recipient transport: accepted

Preserve the existing opted-out delivery wording and return requested-only transport
for an excluded `contact_opted_out` row. Retain null only for excluded rows without
the suppression code.
