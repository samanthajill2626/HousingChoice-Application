# R3 code review - SPEC/PLAN CONFORMANCE (fix wave 2, narrow)

- Branch `feat/npm-test-soundness`, tip `1079bf05`, wave-2 base `ad47aec1`.
  Code commit `0eaa20a3`; record `code-review/r2-fix-wave.md`.
- Scope: the wave-2 diff only, plus a re-verdict on every requirement it could
  have disturbed and closure verdicts on my r2 findings N1-N7.
- Method, all bare and foreground from `W:\tmp\npm-test-soundness\app`:
  - `npx vitest run test/dynamoAdminRetry.test.ts` -> exit 0, **22/22**.
  - `npx vitest run test/staticSmoke.test.ts` -> exit 0, **12/12, 0 skipped**.
  - `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` -> **1 failed /
    14 passed, twice.** The single offender is
    `app/test/__review_adv3_gamed.test.ts`, an UNTRACKED scratch file belonging
    to the adversarial reviewer working this same tip (its name changed between
    my two runs, so that agent is live). It is not mine and I did not touch it.
    This is exactly the sharp edge adversarial N6 DECLINED and sent to the
    handback: the guard walks `app/test` on disk, so any reviewer's throwaway
    reds it. **Not a wave-2 defect** - but S6's gate 2 must run on a quiet tree
    with no scratch files present, or it will red on this and name a file that
    does not exist in the branch.
  - ASCII scan of every ADDED line in `ad47aec1..1079bf05`: **zero** above 0x7E.
- No throwaway of my own was needed this round; `__review_conf3_*` was never
  created. Nothing backgrounded, no container restart, no full suites.

---

# 1. NEW FINDINGS

Counts: **0 blocker, 0 must-fix, 0 should-fix, 1 note.**

**NEW-1. note - CONFIRMED - `app/src/lib/dynamoAdmin.ts:153-155`.** The
`DEFAULT_DEADLINE_MS` docblock, written in this wave, states that because the
deadline is read only before a re-send "the effective bound is deadlineMs PLUS
one attempt". The same commit moved the check from before the verify block to
after it (`:283`, now below `:262-272`), so for the two hooked callers
(`UpdateTimeToLive`, `ensureGsis`'s `UpdateTable`) the worst case is deadline
plus one attempt **plus one verification read** - and that read is itself a
control-plane call, which under the lock-timeout signature this comment is
sized against can cost ~10s of its own. The sentence was accurate before the
reorder and is now one term short. Failure scenario: the same one N2/N3 were
raised for - somebody sizes a hook budget from the stated arithmetic. This is
the plan's last watch item in miniature (a fix introducing a smaller defect of
the class it closed), and the remedy is one clause.

---

# 2. RE-VERDICTS on requirements wave 2 could have disturbed

| requirement | verdict | evidence |
|---|---|---|
| Hook contract: called AT MOST ONCE per failed attempt | CONFORMS | one `if (opts.verify)` block, `dynamoAdmin.ts:262-272`, no loop; case 10 (`dynamoAdminRetry.test.ts:393`) still asserts the exact 8-element interleave and passes |
| Hook contract: NEVER ITSELF RETRIED | CONFORMS | `:262-272` is a bare call inside a try that rethrows the ORIGINAL error; case 7 (`:354`) green |
| Hook contract: NOT CALLED ON THE FINAL ATTEMPT ("the bound is checked first") | CONFORMS, with the reading made explicit | the ATTEMPT bound at `:259` still precedes the hook at `:262`, so attempt 4 is never hooked - case 10 proves it. The DEADLINE at `:283` now sits AFTER the hook, so when the deadline is what ends the loop the last EXECUTED attempt does get its one hook call. That is the adjudicated intent (adversarial N1) and it is strictly safer: case 22 (`:636`) shows an already-expired deadline still converting an accepted mutation into a success (1 `UpdateTimeToLive`, 2 `DescribeTimeToLive`, resolves). The plan's clause is anchored to the attempt bound and remains exactly true |
| Hook contract: true -> success / false -> re-send / throws -> rethrow ORIGINAL / absent -> re-send | CONFORMS | `:262-272` unchanged in substance; only the deadline moved out from above it |
| "4 attempts max, linear backoff, injectable" | CONFORMS | `DEFAULT_ATTEMPTS` still 4 at `:144`; bound at `:259`. Case 21 injects `attempts: 12`, which is a TEST override of an always-optional field and does not move the product default - case 10 still pins 4 sends on the default schedule |
| Endpoint gate lazy, fail-closed, before the hook | CONFORMS | `:260` still precedes `:262`, so a non-local client never reaches the hook; cases 11/12 green |
| Case 3's ZERO-DescribeTable hot path | CONFORMS | `ensureTable` is NOT in the wave-2 diff (its five hunks are the two constant blocks, two inside `retryLocalControlPlane`, and the poll docblock); case 3 (`:296`) green, and case 20 (`:561`) now additionally pins it under concurrency with a shared answer-ordered timeline |
| Poll: 100ms / 10s, exported, injectable, own reads not retried, no endpoint gate | CONFORMS | `pollUntilTableActive` body untouched (`:371`); the wave added only docblock text at `:359-364` recording that the SUCCESS path keeps the SDK waiter deliberately - which is the plan's own row, now stated rather than implied |
| S1.3 exhaustion split; DeleteTable gated on `retried`; per-call `retried` | CONFORMS | none of those lines is in the wave-2 diff; cases 18/19/20 green |
| S3.1 fixture positive constraint (`<div id="root">`) | CONFORMS | `staticSmoke.test.ts:63-65` unchanged |
| S3.1 fixture negative constraint (no `"version"` / `"private"` / `root:`) | CONFORMS | fixture HTML unchanged; the single decoy (`:72`, written at `:98`) is a separate file that is never served |
| S3.1 nothing written outside the temp root | CONFORMS | four writes, all under `<root>`; one recursive `mkdirSync` at `:95` now precedes every write (r2 N6) |
| S3.1 traversal assertions carried over UNCHANGED | CONFORMS | filtering the wave-2 diff for the assertion text returns NO `+`/`-` line; the four assertions at `:301-306` and the six probe strings are byte-identical. Only comments moved (`:247`, `:258`) |
| S3.2 (b) and S3.3 (c) PASS-or-SKIP-only | CONFORMS | neither describe is in the wave-2 diff; 12/12 with (c) on its PASS arm |
| Guard's three-marker scheme | CONFORMS | `SHARED_LOCAL_TABLES_MARKER` and `WORKTREE_DERIVED_KEYS_MARKER` (`:58`) untouched; `NO_CONTAINER_TABLES_MARKER` (`:73`) and its declaration-line matcher (`:83`) untouched. Wave 2 widened only `CONTAINER_REACHING` (`:122-133`) and the prose. The widened set does not flag the one declaring suite - the rot-proof case at `:392` is green in both runs |
| Spec "no runtime code other than dynamoAdmin.ts" | CONFORMS | wave 2 touched `dynamoAdmin.ts` plus three test files; no spec/plan file changed |

---

# 3. N1-N7 CLOSURE VERDICTS

| # | verdict | evidence |
|---|---|---|
| N1 (case 21 load-fragile, 20ms margin) | **CLOSED** | `dynamoAdminRetry.test.ts:605-634`: `attempts: 12`, 20ms sends, 200ms deadline - ~180ms of slack on the lower bound - and `< 12` now proves the deadline fired at all. It also asserts the original fault BY IDENTITY (`rejects.toBe(fault)`), which is stronger than the shape match it replaced |
| N2 (deadline comment arithmetic wrong) | **CLOSED, one residue** | `:145-163` drops the "22-table loop cannot lose more than ~20s" claim and now states the per-retried-send scope, the three retried sends on a TTL spec, the 10s poll, the 60s SDK waiter outside all of them, and which callers reach the TTL legs. The residue is NEW-1 |
| N3 (rot-proof check is a one-file scan) | **CLOSED** | `dynamoAccessKeyGuard.test.ts:97-99` states the limitation in terms, `:109-115` names the live one-hop gap (this file -> `db-update-gsis.js` -> the factory) and why that module is deliberately not listed, and `:122-133` widens the set to the table-creating script/setup entry points and their helpers |
| N4 (deadline pre-empted the verify hook) | **CLOSED / dissolved** | the check moved to `dynamoAdmin.ts:283`, below the verify block at `:262-272`; case 22 (`:636-664`) pins that an already-expired deadline still asks the hook and returns success with no re-send |
| N5 (decoy no probe reaches) | **CLOSED** | the `<root>/site/package.json` write is gone from `:85-99`; `:66-71` now says in terms that a decoy at an unreached depth is dead scaffolding that reads as coverage |
| N6 (order-dependent fixture writes) | **CLOSED** | `staticSmoke.test.ts:90-95`: one recursive `mkdirSync` of the deepest directory before any write, with the reason recorded |
| N7 (poll-ceiling exclusivity overstated) | **CLOSED** | `dynamoAdmin.ts:169-192` narrows the claim to the vitest key scheme across worktrees, names `db-create.ts` on the ambient database and `e2e-session.mjs`'s lane as the callers it does not cover, and bounds what they lose (only a RETRIED conflict reaches the poll; a slower failure, not a lost success) |

---

# 4. STATE

Wave 2 is a clean, narrow wave: six adjudicated items, all landed, nothing
outside their scope touched, and the two behaviour changes (the deadline
reorder and case 21's reshape) are both pinned by cases that would fail without
them. No requirement that was CONFORMS at r2 is disturbed.

Still owed by later slices, unchanged: S5, S6, S7, S8; C4/C5/C6 records; the
A3 spec deviation, A6/A8 and the guard's scratch-file sharp edge (N6) in the
handback. Gate 2 must be run on a tree with no untracked scratch tests.

**NO REMAINING MUST-FIX.**
