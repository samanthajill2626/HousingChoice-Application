# Task 12 E2E review findings

## Reviewed commit

`1cfc5d70 test: cover message transport fidelity end to end` against `c3f4aa39`.

## P2: Transport assertions accepted required-state transitions

The browser helper matched the beginning of a transport label, so required exact
requested-only, agreement, and native Group MMS claims also passed for a later
`REQUESTED -> ACTUAL` label. Pending callback and incomplete-recipient proof must
distinguish their initial requested-only states from fallback.

## P2: Excluded-recipient absence regex used a literal backspace

The JavaScript template string used `\b`, producing U+0008 rather than a regular
expression word-boundary escape. Its zero-count assertion therefore passed even if
the excluded recipient were visible. Use a correct escaped boundary or exact
accessible-name matcher.
