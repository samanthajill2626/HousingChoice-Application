# Task 11 fix wave 4 rereview findings

## Reviewed commit

`2470b871 fix: expose inbound Relay recipient accessibility` against `2949b231`.

## P2: Revealed inbound Relay announcement duplicated recipient facts

The new screen-reader-only inbound Relay summary remained mounted after the visible
recipient list was revealed. Both recited the same ordered recipient identity,
delivery state, normalized transport, and time, making a virtual-cursor user hear
every leg twice. The collapsed summary is needed only until the list is mounted.
