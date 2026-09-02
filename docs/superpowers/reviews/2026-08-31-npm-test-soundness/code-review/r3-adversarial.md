# r3 adversarial code review - feat/npm-test-soundness @1079bf05

Final narrow round. Inputs: the wave-2 diff (`ad47aec1..1079bf05`),
`r2-adjudications.md`, `r2-fix-wave.md` and the repository. Verbose evidence in
the gitignored `.superpowers/review/r3-adversarial-evidence.md`.

Verdict up front: wave 2 broke nothing I can find in the four files it touched.
Every accepted item landed as adjudicated, my three r2 reproductions all flip,
and all 49 cases across the three suites are green on a clean tree. Two
comment-accuracy notes remain, neither of which blocks.

---

## NEW FINDINGS

0 blocker / 0 must-fix / 0 should-fix / 2 note.

### R1. NOTE - CONFIRMED - `app/src/lib/dynamoAdmin.ts:154-156`

**Claim.** The comment wave 2 wrote to fix N3 says "It is read only before a
RE-SEND, never during one, so an attempt already in flight is not interrupted:
the effective bound is deadlineMs PLUS one attempt." That was true of the wave-1
ordering. The same wave moved the deadline check to `:283`, after the verify
block at `:263-275`, so a verification READ now also runs inside the
pre-deadline region and extends the wall clock too. The bound is deadline plus
one attempt plus one verify read.

**Failure scenario.** Not a behaviour defect - the reorder is right and I asked
for it. The risk is that this comment is the one place a maintainer sizes a hook
timeout from, and the wave's own N3 fix exists precisely because the previous
number was trusted rather than re-derived. Under the lock-timeout signature both
the attempt and the hook's `DescribeTable` can cost ~10s, so the real per-send
worst case is ~deadline + 20s, not ~deadline + 10s.

**Verified.** Stub with `deadlineMs: 10`, a 60ms attempt and a 120ms hook read:
the call took 184ms, against the ~70ms the comment's formula gives. Evidence R1.

**Fix shape.** One clause: "...plus one attempt and, on a hooked send, one
verification read."

### R2. NOTE - CONFIRMED - `app/test/setup/dynamoAccessKeyGuard.test.ts:118-121`

**Claim.** The widened check and its new limitation paragraph (`:94-116`) are
honest about the one-hop IMPORT gap, but the comment's other exemption - "a bare
DynamoDBClient from the SDK is NOT caught here, and should not be" (`:409-411`)
- is paired only with "and never sends". A `none` suite could construct that
bare client at `http://localhost:8000` and hand it to `ensureTable(client, spec,
tableName(spec.baseName))`: no listed import, no listed constructor, no quoted
`hc-local-` literal, so nothing flags it, and it creates fixed-name container
tables. Deliberate effort is required and the guard is now explicitly labelled a
source scan, so this is completeness of the record rather than a defect.

**Verified.** Read `CONTAINER_REACHING` at `:122-134` against that shape; none
of the eight alternatives matches it.

**Fix shape.** Extend the existing limitation paragraph by one sentence, or add
`\bensureTable\s*\(` paired with `\btableName\s*\(` to the pattern.

---

## WHAT I CHECKED AND FOUND CLEAN

- **Deadline reorder (`:283`).** No double-verify - one hook call per failed
  attempt, then the deadline read. `onRetry` is correctly skipped on an expiry,
  because no re-send happens; the `retried` flag it feeds is only consulted on a
  `ResourceInUseException`, which is non-retryable and exits at `:257` well
  before the deadline read, so `ensureTable`'s poll gate and
  `deleteTableIfExists`'s tolerance are untouched. Cases 7 and 10 keep their
  semantics: verify still precedes the deadline, and the default 20_000 deadline
  cannot fire in a millisecond-scale test. Both green.
- **Case 22 (`:636`).** Non-vacuous - it is exactly my r2 reproduction, and the
  wave-1 ordering makes it reject.
- **Case 21 (`:628`).** Measured five runs of the shipped parameters: 5 sends
  every time, against an asserted band of `>= 2` and `< 12`. The lower bound now
  needs attempt 1 alone to exceed 200ms (~180ms of slack, versus ~20ms in the r2
  shape); the upper bound is more than twice the observed count and still fails
  if the deadline is removed (12 sends). The load-sensitive flake is gone.
- **Case 20 (`:575-604`).** The shared answer-ordered timeline genuinely pins
  the interleaving: if B's delayed send answered before A's retry, `plainFirst >
  retriedSecond` FAILS rather than passing silently, and `retriedSecond > -1`
  guards the `indexOf`. Answer-order tracks catch-order to within a microtask,
  which is what the per-call-flag question turns on. N9's vacuity is closed.
- **Widened `CONTAINER_REACHING` (`:122-134`).** No false positives: it applies
  only to `none` declarers, of which the tree has exactly one
  (`app/test/dynamoAdminRetry.test.ts:24`), and that file matches none of the
  eight alternatives - `db-update-gsis.js` is deliberately unlisted and the
  reason is recorded at `:109-116`. Every existing file is still classified
  correctly: the creates-tables case and the rot-proof case are both green
  across the whole tree.
- **Fixture mkdir / decoy removal (`app/test/staticSmoke.test.ts:85-97`).** One
  recursive `mkdirSync` of the single deepest directory before any write, so the
  three writes are order-independent; `<root>/site/package.json` is gone;
  nothing is written outside `root`; `afterAll` is still guarded. 12/12 green.
- **Success-path waiter (`app/src/lib/dynamoAdmin.ts:359-364`).** The declined
  behaviour change is now stated at the poll's docblock with its reason, so the
  docblock no longer reads as if the waiter had been removed.

---

## N1-N9 CLOSURE VERDICTS

| # | verdict | evidence |
|---|---|---|
| N1 | **CLOSED** | Deadline moved to `dynamoAdmin.ts:283`, after the verify block. My r2 reproduction, unchanged, now resolves `'created'` with two `DescribeTimeToLive` reads (pre-send guard AND hook); at `b783804a` it rejected with one. Case 22 pins it. |
| N2 | **CLOSED** | `CONTAINER_REACHING` widened (`guard:122-134`). My r2 gamed file - `none` marker plus `createAllTables`/`dropAllTables` from `../scripts/db-create.js` - is now flagged by the rot-proof case; at `b783804a` it appeared in neither list. Residual one-hop import gap documented at `:109-116`; see R2 for one more shape. |
| N3 | **CLOSED (residue R1)** | The 22-table arithmetic is gone; `dynamoAdmin.ts:152-166` now states per-retried-send, deadline plus one attempt, three retried sends per TTL `ensureTable`, the 10s poll, and the 60s waiter outside all of them. Only the verify read is unaccounted for - R1. |
| N4 | **CLOSED** | Behaviour DECLINE stands, as adjudicated; `dynamoAdmin.ts:359-364` now says the success path deliberately keeps `waitUntilTableExists`, with its first-poll-is-immediate reason. The comment-vs-code gap is closed. |
| N5 | **CLOSED** | New shape measured over five runs: 5 sends each against a `[2, 12)` band. Lower-bound slack ~180ms versus ~20ms before; upper bound still detects a removed deadline. |
| N6 | **NOT CLOSED (declined)** | Guard walks `app/test` on disk by design; an untracked scratch test is a test vitest would run, and a `__`-prefix exemption would be a hiding place. I accept the DECLINE - the reasoning is stronger than my finding. Recorded as a sharp edge. |
| N7 | **CLOSED** | `staticSmoke.test.ts:258-265` states the `..%5c` probe's target is Windows-only and that falsifiability is 4/6 Windows, 3/6 Linux; the inline note at the probe says the same. |
| N8 | **CLOSED** | `<root>/site/package.json` removed; one decoy, at the one depth four probes reach, with the "a decoy no probe reaches is dead scaffolding" rationale kept. |
| N9 | **CLOSED** | Shared answer-ordered timeline; the ordering assertion fails if the interleaving is lost. |

---

## REMAINING CHALLENGES

None. My two standing challenges are resolved to my satisfaction: A6's widening
was removed by N1's reorder (the residual `CreateTable`-without-a-hook path is a
design row for the human, and I agree it is not a fix-wave change), and A5's
comment now scopes its exclusivity claim to the vitest key scheme, names
`db-create.ts` and the e2e lanes as the callers it does not cover, bounds what
they lose (a slower failure, not a lost success), and states plainly that an
unreadable poll ends a retried conflict in a hard failure. That is the record I
asked for. I accept the DECLINE on N6 outright.

**NO REMAINING MUST-FIX.**
