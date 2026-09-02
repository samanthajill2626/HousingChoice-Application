# Plan adversarial review - round 1 adjudications

- Doc: `docs/superpowers/plans/2026-09-01-npm-test-soundness.md`
- Reviewers: C (`plan-r1-reviewer-c.md`, 17 findings) and D
  (`plan-r1-reviewer-d.md`, 21 findings), independent, opus, given the plan
  + the spec + the repo and nothing else.
- Adjudicated by the planner, 2026-09-01.

**Outcome: 36 ACCEPT, 2 ACCEPT-MODIFIED, 0 REJECT.** The round changed
decisions across every slice; not terminal.

**Both reviewers independently found the same two blockers.** That is the
strongest signal available from a two-reviewer round, and both are mine.

## The two blockers

**C1 / D2 - the ACTIVE poll taxes the hot path it was meant to protect.**
ACCEPT. The plan put the new `DescribeTable` poll on `ensureTable`'s
`ResourceInUseException` path unconditionally. That path is the COMMON one:
`globalSetup` runs ~23 tables through it on every `npm test`, and it is
reached from ~75 call sites. As written, a table that is merely
pre-existing now costs a `DescribeTable`, and under the container stress
this mission targets it could spin 10s and then THROW where today it
returns `'exists'` instantly.

Fixing a rare hole by taxing the commonest call is precisely the failure
mode this mission exists to end. **The poll now runs ONLY when the
`ResourceInUseException` followed a retried attempt** - the plain
pre-existing-table path is byte-identical to today. The pre-existing hole
(a genuinely CREATING table returned as `'exists'` with no wait) is
recorded as an observation rather than fixed under cover of this change.

**C2 / D1 - S4, S6 and S7 are circularly ordered.** ACCEPT. S4's loaded
arm consumes S7's post-fix runs; S6.1's closures consume S4's verdict; S7
depends on S6. No return path existed. **Resolved by moving all registry
and closure work AFTER the gates**, with an explicit note that docs-only
commits land after the gated commit and the handback names both SHAs.

## Accepted - S1 (the retry)

| # | finding | verdict |
|---|---|---|
| C3 | Acceptance cases 9 and 10 are UNBUILDABLE - `ensureGsis` throws in `liveIndexNames` (`db-update-gsis.ts:188-191`) before the retry is reached, and the stub contract specifies no per-command sequencing | ACCEPT, and it is the round's sharpest finding. Two cases written to prove the retry survives could not have run at all. The stub now needs scripted per-command, per-call sequencing, and case 10 must let the FIRST `DescribeTable` succeed and only the VERIFICATION read throw. |
| C4 | The TTL hook's SUCCESS condition (`ENABLED \|\| ENABLING`) is never stated and no case pins it - **a hook that always returns `false` passes all 11 cases** | ACCEPT. The hook contract defined every failure branch and never the one that makes it useful. Condition stated, and a case added where the re-read reports ENABLED and the helper must return WITHOUT re-sending. |
| C5 / D9 | `InternalServerError` and the `DescribeTimeToLive` PRE-SEND retry have no acceptance case at all; both can ship inert | ACCEPT. `InternalServerError` is the `waiting for a lock` signature - the one actually sighted in this issue's history - and it had no case. Added, with the 4-attempt bound and exact send count on exhaustion. |
| C10 / D9 | Unspecified whether the hook runs on the FINAL failed attempt; `db-update-gsis.ts:117` checks the bound first, and case 9 cannot tell the readings apart | ACCEPT. Specified: the bound is checked first, so no hook call on the final attempt - matching today's behaviour - and a case distinguishes them. |
| C9 | The endpoint gate is specified against an UNVERIFIED SDK shape, and every case supplies the stub's own provider, so a wrong assumption stays green | ACCEPT, and the remedy is better than the finding asks. Two cases now construct REAL `DynamoDBClient`s - one with `{endpoint: 'http://localhost:8000'}`, one region-only - and assert the predicate's verdict. That proves the `Provider<Endpoint>` assumption against the actual SDK without needing the container. |
| D8 | The helper's signature and RETURN value are unspecified, and `enableTtlIfNeeded` consumes a response the hook-returned-true branch cannot produce | ACCEPT. The helper returns the command output; the hook-true branch cannot. Resolved by a stated CONSTRAINT: **a call whose output is consumed may not supply a verification hook.** Verified against all five retried sends - only `DescribeTimeToLive` consumes output, and it uses no hook. |
| D7 | Case 11 (10s poll exhaustion) has no injection seam - `ensureTable` takes no options - so it is a real 10s sleep inside `npm test` or an unspecified fake-timer design | ACCEPT. The poll is exported with injectable interval/ceiling and tested directly. |
| C13 | S1.5 omits `dynamo.integration.test.ts:60-64`, the ONLY existing test of the branch S1.3 rewrites, plus `globalSetupEnsure` and `dynamoKeyLedger` | ACCEPT. Rewriting a branch without running its existing test is how a regression ships green. |
| D2 (part) | The poll is not gated on the local endpoint either | ACCEPT. Gated, same predicate as the retry. |

## Accepted - S2 (the guard)

| # | finding | verdict |
|---|---|---|
| C7 / D6 | S2's only pre-committed cut saves the CHEAPEST checker call, while the plausibly dominant cost - `isErrorTyped`'s `getTypeAtLocation` at `:98`/`:106` - is explicitly ruled out; and the lazy checker means the two-way branch does not partition the cost | ACCEPT. The plan confused "these `\|\|` already short-circuit, do not "fix" them" with "this cost is off-limits". Corrected: the short-circuits are not defects, AND `isErrorTyped`'s cost is fair game if measurement names it. Like the `buildProgram` branch, no remedy is pre-committed there - it returns to the planner as a decision. |
| D12 | S2.1 demands an "otherwise-quiet machine" while S0's premise is live neighbours, and the table lets S2 start straight after S0 - skewing S2.4's 4x arithmetic | ACCEPT. Sequenced explicitly, with the machine state recorded alongside the number that becomes a permanent budget. |
| D14 | The issue's second named symptom - `[vitest-worker]: Timeout calling "onTaskUpdate"` - is birpc coordinator starvation and cannot be fixed by a budget raise, yet S6.1 stamps the issue resolved | ACCEPT-MODIFIED. That symptom belongs to `npm-test-runner-rpc-starves-under-concurrent-e2e`, which is RESOLVED (`maxWorkers: 4`, `vitest.config.ts:44`). So it is already addressed - but the closure must SAY so rather than appear to claim a budget raise fixed an RPC fault. |

## Accepted - S3 (staticSmoke)

| # | finding | verdict |
|---|---|---|
| C6 / D4 | S3.1's enumeration omits two of the file's cases - `:38` (root serving) and `:88` (legacy `/manifest.webmanifest` redirect, including its 403 origin-secret guard) - so a literal builder DROPS them | ACCEPT. Verified: nine `it`s across two describes. `:38` additionally needs SPLITTING, since it mixes serving behaviour with the identity assertions that move to (b)/(c). Every case is now assigned by line number. |
| C14 / D15 | The traversal probes' shipped COMMENT (`:144-147`) names `dashboard/dist/../../package.json` as the realistic target - which does not exist under a `mkdtemp` fixture - while S3.1 says the probes carry over unchanged | ACCEPT. The comment is part of the test; carrying it over unchanged would ship a lie. Rewritten to say what the probes now pin. |
| D15 | `staticSmoke` builds the app in the DESCRIBE BODY at collection time, so only one of the two cited `mkdtemp` precedents is structurally compatible, and fixture cleanup is never mentioned (both precedents `rmSync`) | ACCEPT. Fixture creation must happen before `buildApp`, and cleanup is specified. |
| C12 | S3.4 assumes the PASS branch occurs on a fresh build; the five byte-exact substrings against Vite output are UNVERIFIED, with no branch if it skips | ACCEPT. If a FRESH build does not satisfy the five conditions, that is itself the discovery - stop and report rather than tuning the assertions to fit. |

## Accepted - measurement and records

| # | finding | verdict |
|---|---|---|
| C8 / D5 | The S0-vs-S7 wall-clock pairing is confounded by THIS MISSION's own change to the test set - S3 un-skips ~9 `it`s and S2 changes one file's cost - and the plan enumerates confounds for S5's arms only | ACCEPT, and it is the most embarrassing of the round: a mission about honest measurement built a before/after pair that does not compare the same work. Named as a confound, with the un-skipped case count recorded so the delta can be read. |
| D3 | The misleading clean-key recipe lives in THREE files; the plan fixes `AGENTS.md` and `_CLUSTERS.md` and leaves it intact at `npm-test-dynamodb-local-contention.md:100-106` - the very issue being closed | ACCEPT. Verified. Leaving the wrong recipe in the issue that documents it would be the whole mission failing at its own thesis. |
| D10 | "Record which mode `sweepLedgerResidue` took" has no observable output - `globalSetup.ts:166-175` prints nothing when the sweep finds nothing, and S0 forbids editing the tree | ACCEPT. Derived from the contention snapshot instead (other live runs > 0 implies spare-young mode). |
| D11 | The `globalSetup`-re-enables-TTL claim is filed as a new issue on an INFERENCE from a comment, verified by no task - and it is what makes item 1A's TTL work non-inert | ACCEPT. A read-only probe is added: `DescribeTimeToLive` on an `hc-local-` table under the worktree key after a run. File the issue on the probe's result, not on the inference. |
| C11 | S5's arms are not pinned to a commit, yet their numbers are written into `AGENTS.md` | ACCEPT. Both arms at one named commit, recorded. |
| D13 | S4's solo arm has no defined position relative to S1, whose `ensureTable` / `deleteTableIfExists` changes sit in `groupCrossCheck`'s own setup path | ACCEPT. Sequenced before S1, so the two arms cannot straddle a code change. |
| C15 | S4 authorises striking the suite-A remedy on a TTL fix that addresses a DIFFERENT failing case than the two the anchor records | ACCEPT-MODIFIED. The strike is narrowed: it may only cover what the evidence covers, and must name the cases it does not. |
| D17 | S0's pass criterion "tree still unedited, `git status` clean" contradicts S0's own instruction to commit the record | ACCEPT. Reworded to "no changes under `app/` or `dashboard/`". |
| D18 | "the base commit" is undefined - the plan names `5ce9912f` while HEAD is a docs commit, and S7.4 says "merge base" | ACCEPT. Defined once, with the note that the intervening commits are docs-only and cannot move a test number. |
| C17 / D16 | `npm test` (five workspaces) and `cd app && npx vitest run` scopes sit unlabelled in adjacent records; assorted citation drift (`:41` vs `:42`, comment-line citations) | ACCEPT. Every record states its scope; citations corrected. |
| D19 | The no-decoys argument rests on `node_modules/send/index.js`, unverifiable in this worktree and pinned to an unnamed transitive version | ACCEPT. The version is recorded, and the argument is restated so it does not depend on a line number in someone else's package. |
| D20 | `_CLUSTERS.md:231`'s M7 row also goes stale - it still lists suite B's retry as owed work | ACCEPT. |
| D21 | The contention snapshot's `otherLiveRuns()` prunes markers in a machine-global directory other missions read, and no invocation seam is given | ACCEPT, and it matters more than its severity suggests: a snapshot that MUTATES shared state could perturb another mission's run. A read-only listing is specified instead. |
| D16 (part) | S6.2's issue 1 must lead with the new claim | ACCEPT. |

## Status

Not terminal. Round 2 continues reviewer C (holding D's report and these
adjudications). Hard cap 4, as for the spec.
