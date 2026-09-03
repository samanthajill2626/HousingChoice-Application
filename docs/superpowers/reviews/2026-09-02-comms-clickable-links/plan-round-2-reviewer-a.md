# Plan Review - Reviewer A, Round 2

## 1. [LOW] Required bracket and Unicode-punctuation parser cases remain untested

### What is wrong

The approved focused-unit contract requires punctuation, balanced parentheses,
brackets, and Unicode punctuation. The revised S1 plan still names only trailing
period/comma and balanced parentheses. Its international-domain case is an IDN
recognition check, not a Unicode-punctuation boundary check. A builder following
the plan literally can omit square-bracket and Unicode-punctuation cases, leaving
part of the selected parser-boundary contract unproved.

### Evidence

- The specification requires focused tests for sentence punctuation, balanced
  parentheses, brackets, and Unicode punctuation:
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:266-283`.
- The S1 test instructions require only a trailing period/comma and balanced
  parentheses at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:223-228`.
- The next required case checks `housing.zip/path` plus an international domain,
  which covers full-TLD/IDN recognition rather than Unicode punctuation:
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:229-231`.
- The implementation deliberately delegates boundary handling to linkify-it by
  iterating parser matches without an application boundary grammar:
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:305-330`.

### Implication

The feature may still work because the selected parser owns these boundaries, but
the required regression proof is incomplete. Add explicit assertions for a
bracket-delimited URL and a URL followed by Unicode sentence punctuation, each
verifying that only the URL is linked and the delimiters remain text.
