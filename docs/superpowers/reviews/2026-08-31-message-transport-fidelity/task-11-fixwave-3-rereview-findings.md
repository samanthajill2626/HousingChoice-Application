# Task 11 fix wave 3 rereview findings

## Reviewed commit

`e8d747f8 fix: include recipient times in accessibility` against `baf6f6a7`.

## P1: Collapsed inbound Relay bubble had no recipient accessibility summary

Inbound Relay sources legitimately disclose outbound recipient legs after reveal, but
their main source chip has no outbound delivery rollup and therefore received neither
the rollup nor all-opted-out accessible summary. Because the bubble reveal is not a
keyboard control, a screen-reader user could not obtain the recipient identity,
delivery state, normalized leg transport, or recorded leg time before interaction.
