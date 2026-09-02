# Code review round 2 - adjudications (orchestrator)

Reviewed tip `b783804a` (fix wave 1). Reports `r2-adversarial.md` (0 blocker /
1 must-fix / 4 should-fix / 4 note) and `r2-conformance.md` (0 / 0 / 2 / 5),
both by the round-1 reviewers on continuation. Round-1 closures: A1, A2, A3,
A9, C1, C2, C3, C8, C9 CLOSED by both; A4 PARTIAL; the rest RECORD/deferred as
adjudicated. The round-2 findings are almost all against the wave's NEW code -
the class of defect the plan's last watch item predicted. A second, targeted
wave follows (code-review/r2-fix-wave.md), then a final re-review of that diff
only.

Key: ACCEPT = fixed in wave 2; DECLINE = not changed, reason given; RECORD =
carried to S7/S8.

## Adversarial round 2

| # | sev | verdict | disposition |
|---|---|---|---|
| N1 | must-fix | CONFIRMED | **ACCEPT.** The deadline check (`dynamoAdmin.ts:238`) sits BEFORE the verify block, so an expiry throws without asking whether the mutation landed - the exact hazard the module exists to remove, reached earlier than the attempt bound and preferentially on the slow lock-timeout fault. Fix: check the deadline AFTER the verify block and before `onRetry`, so every failed non-final attempt still asks "did it land?" and the deadline only stops RE-SENDS. Add case 22: deadline already expired AND the hook reports landed -> resolves with no re-send. This also dissolves conformance N4 (the hook is no longer pre-empted). |
| N2 | should-fix | CONFIRMED | **ACCEPT.** `CONTAINER_REACHING` misses `createAllTables`/`dropAllTables` (`app/scripts/db-create.ts`) and the `globalSetup`/`globalTeardown` entry points, so a `none` suite could game the guard by importing a table-creating helper. Fix: add import specifiers `/db-create.js`, `/db-seed.js`, `/globalSetup.js`, `/globalTeardown.js` and calls to `createAllTables|dropAllTables|ensureKeyedLocalTables|dropKeyedLocalTables`; soften "the ONLY thing that reaches the container" and state plainly that the check is a one-file source scan that does not follow imports (conformance N3). |
| N3 | should-fix | CONFIRMED | **ACCEPT the comment fix; DECLINE threading one deadline through `ensureTable`** (a design change; the per-send bound is still a bound). The `DEFAULT_DEADLINE_MS` comment must say: per retried SEND, checked before a re-send (so the real bound is deadline + one attempt); one `ensureTable` on a TTL-bearing spec runs up to three retried sends plus a 10s poll, and the success path's SDK waiter (60s) is outside all of them; drop the "22-table loop cannot lose more than ~20s" arithmetic. (Same as conformance N2.) |
| N4 | should-fix | CONFIRMED | **ACCEPT a one-sentence comment; DECLINE replacing the waiter.** The plan pins "the success path keeps `waitUntilTableExists` unchanged". Say at the poll's docblock that the success path deliberately keeps the SDK waiter (its first poll is immediate, so a fresh empty table normally returns on the first check; the flat-20s second tick bites only when the create itself is slow), and that this mission changed only the retried-conflict path. |
| N5 | should-fix | CONFIRMED | **ACCEPT.** Case 21's 20ms slack is a load-sensitive false red inside the mission's own acceptance suite (also conformance N1, reproduced by both). Fix: make the deadline the binding constraint by a wide margin - `attempts: 12`, `delayMs: 20`, `deadlineMs: 200`, `backoffMs: () => 0`; assert `2 <= sends < 12` and the original error. The lower bound has ~180ms of slack; the upper bound proves the deadline fired at all (without it: 12 sends). |
| N6 | note | CONFIRMED | **DECLINE.** The guard walks `app/test` on disk by design; an untracked scratch test IS a test file vitest would run, and exempting `__`-prefixed basenames would create a hiding place. A reviewer's throwaway reddening the guard is the guard working. RECORD in the handback as a known sharp edge. |
| N7 | note | PLAUSIBLE | **ACCEPT (comment).** The `..%5c` probe's decoy target exists on Windows only; on POSIX the backslashes are one filename inside dist and the probe is a shape probe. One clause in the traversal comment and in the inline probe note. Falsifiability is 4/6 Windows, 3/6 Linux - say so. |
| N8 | note | CONFIRMED | **ACCEPT.** Remove the unreachable `<root>/site/package.json` decoy and its comment lines (also conformance N5 - the v2 decoy mistake, reintroduced). |
| N9 | note | CONFIRMED | **ACCEPT.** Case 20 pins its interleaving: both stubs record into one shared timeline; assert the plain client's first `CreateTable` index is greater than the retried client's SECOND `CreateTable` index. |

Challenges: **A6** - agreed that wave 1 widened the exposure; N1's reorder
removes the widening and needs no design change; A6's residue (no verify hook
on `CreateTable` at all) stays an open item for the human, and the handback
will say the deadline reduces the number of attempts that could draw the
`ResourceInUseException` recovery for the lock-timeout signature. **A5** -
behaviour DECLINE stands (returning `'exists'` at the ceiling is the hole item
1A closes); the comment is narrowed: the exclusivity claim holds for the vitest
key scheme across worktrees, not for `db-create` on the human's ambient
database or a lane mid-`db:update-gsis`, where a table can be UPDATING for
minutes - and in that case a RETRIED conflict now fails after 10s with a named
status where the base code failed immediately on the `InternalFailure` (a
base failure, not a base success); reads that fail inside the poll count as
not-ACTIVE by design and are not retried. (Same as conformance N7.) **A3** -
upheld by both reviewers; N7/N8 refine the comment and the fixture.

## Conformance round 2

| # | sev | verdict | disposition |
|---|---|---|---|
| N1 | should-fix | CONFIRMED | **ACCEPT** = adversarial N5. |
| N2 | should-fix | CONFIRMED | **ACCEPT** = adversarial N3 (comment). |
| N3 | note | CONFIRMED | **ACCEPT** folded into adversarial N2 (state the one-file, no-import-following limitation). |
| N4 | note | CONFIRMED | **ACCEPT** dissolved by adversarial N1's reorder; the hook contract is back to "not called on the final attempt only". Note for the handback beside A4. |
| N5 | note | CONFIRMED | **ACCEPT** = adversarial N8. |
| N6 | note | CONFIRMED | **ACCEPT.** With the dead decoy gone, the only directory is `<root>/site/dist/assets`; create it with one explicit recursive `mkdirSync` BEFORE any write, so the fixture is order-independent. |
| N7 | note | CONFIRMED | **ACCEPT** = the A5 comment narrowing above. |

Challenges 1-5 (A3, A2, A4, A5, A6): all upheld or agreed with, as recorded
above; the A4 caveats are N1/N3/N5 and are fixed in wave 2.

## Wave 2 scope

`app/src/lib/dynamoAdmin.ts` (deadline reorder; three comment corrections),
`app/test/dynamoAdminRetry.test.ts` (case 21 rework; case 22; case 20
timeline), `app/test/setup/dynamoAccessKeyGuard.test.ts` (`CONTAINER_REACHING`
widened; comment), `app/test/staticSmoke.test.ts` (dead decoy removed;
explicit mkdir; Windows clause). Record `code-review/r2-fix-wave.md`. Final
re-review: both reviewers, continuation, wave-2 diff only, with the same
"misses first" order.
