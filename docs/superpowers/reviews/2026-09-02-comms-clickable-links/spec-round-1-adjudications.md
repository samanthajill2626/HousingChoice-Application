# Spec round 1 adjudications

Date: 2026-09-02
Spec reviewed: `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md` v1
Reviewers: A and B

## A1. Localhost exclusion has no enforcing mechanism

Decision: ACCEPT

The reviewer is correct that `linkify-it` and `safeHttpUrl` both accept an explicit
HTTP(S) localhost destination. The exclusion was an unnecessary inferred policy,
not a product requirement. Spec v2 now distinguishes bare single-label text from an
explicit URL: bare `localhost` remains text, while `http://localhost`,
`https://localhost`, and `//localhost` follow the ordinary HTTP(S) contract. Tests
must cover both sides.

## A2. Unmatched-email plain-text detail is an omitted reader

Decision: ACCEPT

The outcome was broader than the enumerated reader set. Spec v2 adds the expanded
plain-text body in `UnmatchedRow` to the common component and focused tests. Its
collapsed snippet is explicitly excluded because it is a preview nested inside the
existing row-toggle button; placing an anchor there would create invalid nested
interactive controls and would disagree with the non-interactive Inbox preview.

## B1. Unsupported-scheme literal-text guarantee has no enforcing mechanism

Decision: ACCEPT

The v1 language overpromised that an entire surrounding token would remain literal.
The actual security invariant is that no generated destination has an unsupported
scheme. Spec v2 states that invariant precisely and records parser-owned behavior:
an independently valid bare domain after a delimiter can still become a safe HTTPS
link. This preserves mature parser semantics without creating a second source-
context URL grammar. Tests cover both rejected destination schemes and the delimited
bare-domain case.

## B2. Email snippet contract omits trailing-whitespace trimming

Decision: ACCEPT

The current `EmailCard` applies `trimEnd()` to the first 140 source characters before
adding `...`. Spec v2 now preserves that exact behavior by deriving the visible end
from the trimmed slice while parsing the complete original body for destination
integrity. A focused regression test is required.

## Round result

- Accepted: 4
- Rejected: 0
- Deferred: 0

All four findings changed or clarified the spec. Round 2 is therefore required.
