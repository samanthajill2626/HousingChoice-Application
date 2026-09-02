# Plan round 1 adjudications

Date: 2026-09-02
Plan reviewed: `docs/superpowers/plans/2026-09-02-comms-clickable-links.md` v1
Reviewers: A and B

## A1. Full-TLD configuration and proof are unverified

Decision: ACCEPT

The target 6.1.0 documentation does recognize `tlds` as a constructor option, so
the reviewer's inference from the installed 5.0.2 constructor is not valid for the
target version. The proof gap is valid: `museum` belongs to the built-in list and
cannot prove the external list was loaded. Plan v2 uses the stable public
`parser.tlds(tlds)` method in both implementation and Linux ARM64 probe, and tests
`housing.zip/path`, whose suffix is present in the full list but absent from the
documented built-in list.

## A2. Browser red proof is ordered after integration

Decision: ACCEPT

S1-S3 already provide focused red-to-green tests before their implementations. E1
is ordered after those slices and is therefore a post-integration acceptance test,
not a valid red test. Plan v2 removes the false red expectation, expects the first
targeted e2e run to pass, and adds an exact lane-listener teardown check.

## A3. Clean Windows install proof is missing

Decision: ACCEPT

An ordinary `npm install` can leave an existing hoisted tree masking a lockfile
problem. Plan v2 runs bare `npm ci` immediately after the manifest/lock update and
requires its exit 0 before graph inspection, tests, or builds.

## A4. The `safeHttpUrl` rejection branch has no executable test

Decision: ACCEPT

Disabled schemes do not force a parser match through the final boundary's null
branch. Plan v2 uses a scoped Vitest mock that rejects the recognized
`reject.com/path` candidate and asserts the exact original source is returned as
text with no link token.

## A5. Native-group attribution is claimed but not tested

Decision: ACCEPT

The Relay team-label test does not exercise `rosterKind: 'group_text'`. Plan v2 adds
an exact phone-scoped native-group roster fixture and requires the resolved member
name to remain next to its linkified body.

## B1. Full-TLD list is not demonstrably loaded

Decision: ACCEPT

This independently identifies the same proof defect as A1. Plan v2 calls
`parser.tlds(tlds)` explicitly and uses `.zip` to distinguish the complete list from
the parser defaults. The target v6 constructor-option subclaim is corrected as
described in A1; the accepted proof finding still changes the plan.

## B2. Truncated all-whitespace email snippet disappears

Decision: ACCEPT

The proposed `snippetEnd > 0` guard would omit the three-period suffix that current
`EmailCard` renders for a body longer than 140 characters whose visible slice trims
to empty. Plan v2 renders the snippet when `snippetEnd > 0 || truncated` and adds a
141-space regression fixture that must render exactly `...`.

## Round result

- Accepted: 7
- Rejected: 0
- Deferred: 0

All seven findings changed proof, coverage, or an implementation mechanism. Round 2
is therefore required.
