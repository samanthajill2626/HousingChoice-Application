# Code review r3 - orchestrator adjudications (feat/tour-list @ 567d2c30)

Report: `r3-review.md` (fresh reviewer on the fix-wave-2 diff: 0 HIGH, 0
MEDIUM, 3 LOW; all six fix items confirmed real by the reviewer's own
mutants, including a 234,080-input comparison of the new bound parser with
the old one and an exhaustive 22,620-string check of the surrogate test
against `isWellFormed`; the five implementer divergences verified).

- R3-1 [LOW] a bound whose canonical form has an extended year
  (`9999-12-31T23:59:59-04:00` -> `+010000-...`, which sorts below every
  digit) silently empties or floods a range and turns a valid pair into a
  "from must be on or before to" 400; the dashboard reaches it when To is
  9999-12-31 in a zone west of UTC - FIX, both halves, one line each:
  the server refuses a bound whose canonical instant is not a plain
  four-digit year (the existing ISO 8601 message); the dashboard's
  `localDayEndIso` clamps an end instant that overflows year 9999 to
  `9999-12-31T23:59:59.999Z`, so the furthest pickable day still works.
  Tests for both. Dates from fix wave 1 (SC-2), not wave 2.
- R3-2 [LOW] seven field checks of the R2-1 builder are unpinned (the leap
  rule, month 00, day 00, minute 60, second 60, offset hour > 23, offset
  minute > 59) - FIX (tests only): one parse row per check, each proven by
  the reviewer's mutant M3 shape (the check removed -> the row red).
- R3-3 [LOW] a lone LOW surrogate is never tested - FIX (tests only): one
  decoder row built with `String.fromCharCode(0xdc00)`.

## Fix wave 3 (micro)

One implementer; the orchestrator verifies this wave by reading its diff and
re-running the affected suites (two one-line code changes and test rows -
no fourth review round), then the main sync and the full battery.
