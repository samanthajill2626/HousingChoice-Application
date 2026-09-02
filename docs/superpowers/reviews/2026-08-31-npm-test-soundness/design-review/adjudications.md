# Spec adversarial review - round 1 adjudications

- Doc: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`
- Reviewers: A (`spec-r1-reviewer-a.md`, 25 findings), B
  (`spec-r1-reviewer-b.md`, 20 findings), independent, plan-blind, opus.
- Adjudicated by the planner, 2026-08-31.

**Outcome: 24 ACCEPT, 2 ACCEPT-MODIFIED, 1 REJECT.** The round changed
decisions in all three items, so a round 2 is required. Severity labels
below are the reviewers'; the "decision changed" column is the planner's.

Findings that both reviewers raised independently are marked BOTH - four
of the five most consequential are in that set, which is the strongest
signal in the round.

## Accepted - Item 1A (the retry)

| # | finding | verdict |
|---|---|---|
| A1/B6 BOTH | `CreateTable` retry-safety claim is false: `ensureTable`'s catch (`dynamoAdmin.ts:87-93`) returns `'exists'` WITHOUT `waitUntilTableExists`, so a retry after an accepted-but-unanswered attempt hands back a still-CREATING table | ACCEPT. Verified. The retry must wait for ACTIVE on the `ResourceInUseException` path. This is a real hole in TODAY's code too, not only under retry. |
| A2 | `DeleteTable` re-send against a DELETING table raises `ResourceInUseException`, which `deleteTableIfExists` does not catch (`:146-149`) | ACCEPT. Verified. The catch must tolerate it - a DELETING table means the delete landed. |
| A3/B5 BOTH | `UpdateTimeToLive` "re-send is a no-op" is unevidenced: the ENABLED/ENABLING guard (`:128-131`) is read ONCE, outside the send - the exact read-once-above-the-loop defect `db-update-gsis.ts:70-86` documents | ACCEPT. Verified. The status read moves INSIDE the retry, as a verification hook. |
| A4/B7 BOTH | Two of the four call sites never run under `npm test`: `DYNAMO_DISABLE_TTL: '1'` (`vitest.config.ts:119`) skips `enableTtlIfNeeded` | ACCEPT. Verified. "Hot path of every integration suite" is false for the two TTL sends; they are live only under `db:create` and the e2e lanes. Claim corrected, coverage kept. |
| A5/B3 BOTH | The local-endpoint gate is not "three lines": `client.config.endpoint` is an async `Provider<Endpoint>` returning an object, not the URL string `isLocalEndpoint` takes (`db-create.ts:22-29`) | ACCEPT. The ACCEPTED TRADE rested on a false premise. The gate is now specified concretely, with both branches under test so it cannot ship inert. |
| A6/B3 BOTH | Item 1A has NO acceptance criterion: no unit test, no fault-injection seam, `dynamoAdmin.ts` has no test file, and 1D's before/after `npm test` pair cannot observe a retry | ACCEPT, and this is the round's most useful finding. A fault-injecting stub client and a dedicated test file are now spec'd. Without it the whole item could ship inert with five green gates. |
| B8 | ~11 unenumerated local control-plane sends, including suite B's own raw `CreateTable` (`unreadIndexRepo.integration.test.ts:728`) and the teardown sweep (`globalTeardown.ts:144`) | ACCEPT. Enumerated (9 sites, listed in the revised spec); each is now explicitly covered or explicitly excluded with a reason. |
| B4 | 1A misidentifies the open tail - the named `UpdateTable InternalFailure` IS already retried (`db-update-gsis.ts:103-127`), and no record shows dynamoAdmin's four sends ever failing | ACCEPT. The spec claimed to close a tail that is closed. Reframed honestly: 1A is class-level hardening of the same failure mode on an unprotected surface, justified by the class, not by a specific open sighting. |
| A23 | Unstated: does the shared helper's fail-closed gate now apply to `ensureGsis`, whose retry is currently UNGATED | ACCEPT. Stated: `ensureGsis` keeps its behaviour because its CLI is already hard-gated to localhost; the gate is additive, not a change to it. |
| B9 | `waitUntilTableExists` excluded on an unestablished mechanism claim (self-marked UNVERIFIED) | ACCEPT-MODIFIED. The exclusion stays but stops being asserted: the revised spec makes verifying the waiter's retry behaviour a build-time task whose answer is recorded, not a premise. |

## Accepted - Item 1C/1D (measurement)

| # | finding | verdict |
|---|---|---|
| A8/B2 BOTH | 1C's arms vary the ISOLATION MODEL, not residue: an explicit `AWS_ACCESS_KEY_ID` collapses every file onto one database (`dynamoAccessKey.ts:118-120`), so `hccleanrun001` is the OLD arm of the per-file-keys experiment | ACCEPT, and it inverts the deliverable. AGENTS.md's "first diagnostic" now recommends the WORSE configuration while describing it as a clean database. That is the finding, provable by code plus one measurement pair - not something to measure blind. |
| A9/B19 BOTH | Arm scopes differ - root `npm test` is five workspaces (`package.json:39`) vs AGENTS.md's `cd app && npx vitest run` | ACCEPT. Arms pinned to the app workspace, matching the numbers being re-tested. |
| A10 | 1C never mentions `sweepLedgerResidue`, the on-the-way-IN sweep (`globalSetup`/`globalTeardown.ts:20-25`) most likely to have already killed the residue effect | ACCEPT. Named as the prime alternative explanation. |
| A11 | Contention flips the residue sweep into spare-young-tables mode (`globalTeardown.ts:33-45`), so baseline and post-fix runs are not held constant | ACCEPT. The sweep MODE is now recorded per run as part of the run record. |
| A12 | Arm 2 changes the test SET, not just timings: `describe.skipIf(!reachable || explicitKey)` (`dynamoAccessKeyGuard.test.ts:308`) | ACCEPT. Expected skip-count delta documented so it is not read as a failure. |
| A7 | 1D specifies n=1 per arm while the Risks section forbids single observations - a direct self-contradiction the closure verdict hangs on | ACCEPT. Run counts fixed at 3 per arm; wall clock and failing FILES are the durable signals. |
| A24 | "contended" has no operational definition | ACCEPT. Defined and recorded per run. |
| A25/B15 BOTH | The worktree has no `node_modules`, so a "before any edit" baseline pays a cold install and cold transform cache | ACCEPT. Install happens BEFORE the baseline, and one warm-up run is discarded. |
| A25/B19 BOTH | 1C's command is POSIX inline-env syntax, a parse error in PowerShell | ACCEPT. Both shell forms given. |
| B16 | 1B's strike-the-remedy decision rests on the solo arm, which by construction removes the latency the remedy is about | ACCEPT. The decision rule now requires the LOADED arm as well as the solo arm. |
| B13 | The spec never says which key the five gates run under, and contradicts `_CLUSTERS.md:235-237`; no adjudication rule for a contended gate-2 red | ACCEPT. Gates run bare under the default per-file keys; the clean-key run is EVIDENCE, never a gate. Adjudication rule stated. |
| B17 | Correction 2's grep claim is false as written - `lane.mjs:202` and `dynamoAccessKey.ts:9` also match | ACCEPT. Precision fix: the grep matches comments elsewhere; the RETRY exists in one file. |

## Accepted - Item 2 (logCallSiteGuard)

| # | finding | verdict |
|---|---|---|
| B1/A13 BOTH, BLOCKING | The spec puts `getPreEmitDiagnostics` inside the `beforeAll`. It is not there - it runs in the first `it` (`:152` vs `:140-143`), so the named cut removes ZERO hook cost | ACCEPT. Verified by reading. My prior was simply wrong; the hook is `buildProgram` + `scanProgram` and nothing else. |
| A14 | That phase cannot be dominant anyway: tests are capped at 60s (`vitest.config.ts:60`) against 179.1s "in tests", so the hook is >= ~2/3 of the cost - refuted before instrumentation | ACCEPT. The arithmetic holds and narrows the search before a single measurement is taken. |
| A15/B12 BOTH | "sourceCount > 50 already catches resolves-nothing" is false: `include: ["src"]` (`app/tsconfig.json`) makes every `app/src` file a program ROOT regardless of module resolution | ACCEPT. Verified. The TS2307 probe is load-bearing; any replacement must be validated against a DELIBERATELY broken program, not by reasoning. |
| A16 | Item 2 budgets only the hook and never the 60s `testTimeout` the health case runs under | ACCEPT. If `getPreEmitDiagnostics` is near 60s the health TEST is the next false red. Budgeted explicitly. |
| A17 | The fallback yields a ~500-700s hook budget in a required gate with no ceiling | ACCEPT. Ceiling stated. |
| A14/B14 BOTH | "the hook consumes its entire budget" is an inference from a figure that aggregates hook plus three tests - and it would be baked into a permanent comment | ACCEPT. The shipped comment cites only what this mission measures directly. |

## Accepted - Item 3 (staticSmoke)

| # | finding | verdict |
|---|---|---|
| A18 | "No outcome depends on an untracked artifact" is contradicted by the mtime tie-breaker: git does not preserve mtimes, and the mandated `main` sync alone flips a genuine FAIL to SKIP | ACCEPT, and it removes a mechanism. The mtime tie-breaker is deleted outright. |
| A19/B10 BOTH | The traversal decoy is planted one level too high - the probes escape TWO and THREE levels above the served root (`staticSmoke.test.ts:148-154`), so the "no leak" assertions stay vacuous | ACCEPT. Fixture depth and decoy placement now specified against the actual probe strings. |
| A20/B11 BOTH | 3(c) is never exercised by the mission's own gates: nothing builds `dashboard/dist` (`package.json:68`; e2e runs the Vite dev server) and this worktree has none | ACCEPT. 3(c) is a diagnostic that can only SKIP or PASS - never FAIL - and the mission must build a dist ONCE by hand to prove both of its live branches. |
| A21 | 3(c) does not define "the identity tags"; a Vite build injects a stylesheet link and, under e2e, an `x-app-commit` meta | ACCEPT. Defined as an exact set. |
| B20 | `'HousingChoice'` (`:42`) and the four `<div id="root">` assertions are unassigned to any bucket, and the fixture's required contents are unspecified | ACCEPT. Every existing assertion is now assigned to (a), (b) or (c) explicitly. |

## Accepted - presentation

| # | finding | verdict |
|---|---|---|
| A22/B18 BOTH | The spec cites a "mission's file list" and an option "offered and not chosen" that appear nowhere in it - the sole justification for the duplication trade is unresolvable by its reader | ACCEPT. Both references removed and replaced with the reasoning itself. |

## Rejected

**A13's implied remedy - "instrument anyway and let the numbers decide".**
REJECT as written. A14's own arithmetic (60s test cap vs 179.1s aggregate)
already bounds `getPreEmitDiagnostics` below one third of the cost, and the
phase boundary is settled by reading `:140-143` against `:152`. Spending a
measurement round to re-derive what two reviewers established statically
is the kind of ceremony that makes people skip measurement when it matters.
The instrumentation stays - but its job is to split `buildProgram` from
`scanProgram` INSIDE the hook, which is genuinely unknown, not to re-test a
settled boundary.

## What this round did NOT find

Neither reviewer challenged the three "corrections to the record" in the
spec's own preamble - A states explicitly that all three check out. So the
mission's premise (there is no soak clause; the retry exists in one file;
the degraded-key numbers are unverified under tmpfs) stands unrefuted after
two independent adversarial passes.
