# Task 11 fix wave 2 rereview findings

## Reviewed commit

`6270d2cb fix: align recipient transport accessibility` against `1190e180`.

## P1: Collapsed delivery summary omitted per-recipient leg times

The collapsed delivery chip is the only accessibility path when the non-keyboard
bubble disclosure is not opened. Its summary recited recipient identity and state
but omitted `RecipientRow.when`, even though revealed rows render that delivery or
sent time. A screen-reader user therefore could not access an already-rendered
per-recipient delivery fact from the required collapsed summary.
