# R1 code review - SPEC/PLAN CONFORMANCE (S1, S2, S3)

- Mission: M7 "npm test soundness". Branch `feat/npm-test-soundness`,
  worktree `W:\tmp\npm-test-soundness`, tip `796b8632`, merge base `5ce9912f`.
- Contract reviewed against: plan
  `docs/superpowers/plans/2026-09-01-npm-test-soundness.md` (v5 FINAL),
  sections S1.0-S1.5, S2.1-S2.5, S3.1-S3.4; spec
  `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v5),
  items 1A, 2 and 3.
- Method: every verdict is read from the LIVE tree, not from the diff
  package. Empirical work actually run, all bare and foreground from
  `W:\tmp\npm-test-soundness\app`:
  - `npx vitest run test/dynamoAdminRetry.test.ts` -> exit 0, 17/17.
  - `npx vitest run test/staticSmoke.test.ts` -> exit 0, 12/12 (this
    worktree currently HAS a built `dashboard/dist`, so branch (c) took its
    PASS arm, not its skip).
  - one THROWAWAY probe file, since deleted, covering the two branches no
    committed test reaches (findings 2 and 3). `git status --short` is empty
    and no `__review_*` file remains.
  - `npm run issues` -> 276 open / 156 closed; ONE warning, and it belongs
    to a pre-existing unrelated file (`perf-selfqa-route-contract-drift.md`,
    `severity: medium`). The new issue file draws no warning.
  - byte scan for non-ASCII on all five touched files plus the new issue:
    3 non-ASCII bytes total, all on `app/src/lib/dynamoAdmin.ts:1`, which is
    a pre-existing untouched header line. Every ADDED line in the branch
    diff is pure ASCII.
- NOT run, per the brief: full `npm test`, `npm run e2e`, `npm run smoke`.
  The DynamoDB Local container was not restarted; `E2E_CHILD_LOG_DIR` was
  never set; nothing is left running in the background.
- Scope note: the branch tip is the S3 record. **S5, S6, S7 and S8 have not
  run yet** - there is no `s5-clean-key.md`, `AGENTS.md` and
  `docs/issues/_CLUSTERS.md` are untouched, and no issue carries a
  Resolution stamp. Those are not counted as misses here; where a shipped
  decision creates an obligation for a later slice, it is listed as a
  forward note.

Verdict key: CONFORMS / PARTIAL / MISSING / DEVIATED.

---

## S1 - dynamoAdmin control-plane retry

### S1.0 - re-run the enumeration

| requirement | verdict | evidence | note |
|---|---|---|---|
| Enumeration command re-run live; work from ITS output | CONFORMS | `.superpowers/sdd/worklist.md:162-260`; `s1-retry.md:9-21` | 31 hits, 30 under `app/`, 1 under root `scripts/`, 0 under `e2e/`. Table matches the worklist hit for hit |
| Anything the disposition rule does not cover is a HANDBACK finding, not a silent decision | CONFORMS (obligation open) | `s1-retry.md:23-34` | Six flags recorded; two (`unreadIndexRepo.integration.test.ts:729`, `scripts/wipe-dev-data.mjs:170`) genuinely unclassified. See finding 6 |

### S1.1 - acceptance suite first, red before any edit

| requirement | verdict | evidence | note |
|---|---|---|---|
| Suite written FIRST, red before any source edit | CONFORMS | `s1-retry.md:36-65`; commit order `de7288e8` | 11 failed / 6 passed of 17 on the pre-edit run; each of the 6 pre-existing passes is explained and none is a behaviour this slice introduces |
| No container, no network | CONFORMS | `app/test/dynamoAdminRetry.test.ts:90-162` (stub), `:3-9` | Only case 13 constructs real SDK clients, and it sends nothing |
| Stub: scripted per command AND per call | CONFORMS | `dynamoAdminRetry.test.ts:98-119`, `:153-161` | Per-command ordered script with a per-command fallback |
| Stub: counters distinguish SENDS from HOOK CALLS | CONFORMS | `dynamoAdminRetry.test.ts:91-92`, `:142-147` | Ordered send log plus a TTL-only projection; cases 5-10 assert the exact interleave, which is strictly stronger than two counters |
| Stub satisfies what `ensureGsis` does AFTER the send (table ACTIVE, index ACTIVE) | CONFORMS | `dynamoAdminRetry.test.ts:207-210`, `:421`, `:441` | The post-send `DescribeTable` fallback reports both ACTIVE, so neither SDK waiter nor `waitUntilIndexActive` can spin past the timeout |
| Stub throws REAL SDK exception instances | CONFORMS | `dynamoAdminRetry.test.ts:179-191`, `:23-33` | Real `ResourceInUseException` and real `InternalServerError`. `InternalFailure` is synthesised (`:171-176`) because the SDK has no such class - worklist drift flag 15 |
| Stub exposes a settable, resolvable endpoint provider | CONFORMS | `dynamoAdminRetry.test.ts:94-96`, `:121-136` | local default plus hostname / absent / throwing variants |

The 17 cases:

| case | requirement | verdict | evidence |
|---|---|---|---|
| 1 | CreateTable, two InternalFailures then ok; resolves, 3 sends | CONFORMS | `dynamoAdminRetry.test.ts:216-227` |
| 2 | InternalFailure then ResourceInUse; returns exists AND polls until ACTIVE | CONFORMS | `:229-246` (asserts 2 CreateTable, 3 DescribeTable) |
| 3 | Plainly pre-existing table: exists with ZERO DescribeTable | CONFORMS | `:248-256`; guarded in product code at `app/src/lib/dynamoAdmin.ts:380` |
| 4 | DeleteTable InternalFailure then ResourceInUse; resolves | CONFORMS | `:258-268` |
| 5 | UpdateTimeToLive retried; status re-read between attempts, hook once | CONFORMS | `:270-285` (4-element interleave) |
| 6 | Re-read reports ENABLED; returns with NO re-send; first guard read DISABLED | CONFORMS | `:287-304` (1 UpdateTimeToLive, 3-element interleave) |
| 7 | Re-read THROWS; ORIGINAL error rethrown, no re-send | CONFORMS | `:306-318` |
| 8 | InternalServerError lock-timeout retried identically | CONFORMS | `:320-327`, real SDK class from `:179-184` |
| 9 | PRE-SEND DescribeTimeToLive guard itself retried | CONFORMS | `:329-343` |
| 10 | Exactly 4 sends then throw; hook 3 times, never on the final attempt | CONFORMS | `:345-362` (literal 8-element interleave); bound-before-hook at `dynamoAdmin.ts:211` vs `:214` |
| 11 | Non-local endpoint: throws immediately, ONE send | CONFORMS | `:364-373` |
| 12 | No endpoint provider: same as 11 | CONFORMS | `:375-384` |
| 13 | REAL DynamoDBClient, localhost vs region-only | CONFORMS | `:386-396`; both clients destroyed in `finally` |
| 14 | localhost / 127.0.0.1 / ::1 / [::1] all local | CONFORMS | `:398-413`; also pins three negatives plus absent and throwing providers |
| 15 | ensureGsis still retries UpdateTable after the refactor | CONFORMS | `:415-429` (2 UpdateTable, index reported added) |
| 16 | ensureGsis stays FAIL-OPEN when the verification read throws | CONFORMS | `:431-449` |
| 17 | Poll called directly throws its OWN error type at the ceiling, naming table and status | CONFORMS | `:451-467`; type, message and the `observedStatus` field all asserted |

### S1.2 - the shared helper

| requirement | verdict | evidence | note |
|---|---|---|---|
| 4 attempts max, linear `attempt * 250ms`, backoff INJECTABLE | CONFORMS | `dynamoAdmin.ts:126-131`, `:139`, `:199-201` | Injected as a function, so a test can zero the delay without changing the attempt count |
| Endpoint predicate EXPORTED | CONFORMS | `dynamoAdmin.ts:163` | Reachable by case 13 with a real client |
| Endpoint gate resolved LAZILY, only on the first retryable error | CONFORMS | `dynamoAdmin.ts:203`, `:210-213` | Resolved at most once per call and only after the retryable test |
| Local means localhost / 127.0.0.1 / ::1 / [::1] | CONFORMS | `dynamoAdmin.ts:151` | |
| FAIL CLOSED on no provider, throwing provider, other hostname | CONFORMS | `dynamoAdmin.ts:164-171` | |
| Retryable names: InternalFailure, InternalServerError | CONFORMS | `dynamoAdmin.ts:174-177` | |
| TWO functions so the constraint is a TYPE, not a comment | CONFORMS | `dynamoAdmin.ts:241-257`, `:265-278` | Both delegate to one private loop at `:190`; the public signatures still carry the constraint. Documented as a design decision in `s1-retry.md:119-123` |
| `sendWithRetry<TOut>` returns TOut, accepts NO hook | CONFORMS | `dynamoAdmin.ts:241-245` | |
| `sendWithRetryVerified` returns void, hook required | CONFORMS | `dynamoAdmin.ts:265-270` | |
| Which-send-uses-which: CreateTable -> plain | CONFORMS | `dynamoAdmin.ts:355-364` | No hook, so `ensureTable` still falls into its own catch (the `'created'`-vs-`'exists'` trap the plan warned about) |
| DeleteTable -> plain | CONFORMS | `dynamoAdmin.ts:471-475` | |
| DescribeTimeToLive pre-send read -> plain, output consumed | CONFORMS | `dynamoAdmin.ts:441` | |
| UpdateTimeToLive -> verified, status re-read as hook | CONFORMS | `dynamoAdmin.ts:443-461` | |
| UpdateTable in `ensureGsis` -> verified, `indexStatus` as hook | CONFORMS | `app/scripts/db-update-gsis.ts:197-212` | |
| Hook contract: true -> return success, no re-send | CONFORMS | `dynamoAdmin.ts:224` | |
| Hook contract: false -> re-send subject to the bound | CONFORMS | `dynamoAdmin.ts:214-227` | |
| Hook contract: throws -> rethrow the ORIGINAL error, no re-send | CONFORMS | `dynamoAdmin.ts:217-223` | Catches and rethrows `err`, not the hook's error |
| Hook contract: absent -> re-send subject to the bound | CONFORMS | `dynamoAdmin.ts:214` | |
| Hook called at most once per failed attempt, never itself retried | CONFORMS | `dynamoAdmin.ts:214-225` | Single call, no loop, no nested retry |
| Hook NOT called on the final attempt (bound checked first) | CONFORMS | `dynamoAdmin.ts:211` precedes `:214`; asserted by case 10 | |
| Predicate DEFINED in `dynamoAdmin.ts`; `lib` does not import from `scripts` | CONFORMS | `dynamoAdmin.ts:7-20` imports only the SDK and `./tables.js` | |
| Not a copy of `isLocalEndpoint` (URL string vs resolved object) | CONFORMS | `dynamoAdmin.ts:146-151` comment; distinct name `isLocalDynamoEndpoint` | Rationale in `s1-retry.md:109-113` |

### S1.3 - apply it

| requirement | verdict | evidence | note |
|---|---|---|---|
| CreateTable retried | CONFORMS | `dynamoAdmin.ts:355-364` | |
| ACTIVE poll runs ONLY when the conflict followed a RETRIED attempt | CONFORMS | `dynamoAdmin.ts:380` | Case 3 pins it; `dynamo.integration.test.ts:60-65` is the live guardrail |
| PER-CALL local via `onRetry`, never a module-level flag | CONFORMS | `dynamoAdmin.ts:349-353`, `:360-362` | No module-level mutable state anywhere in the file. Verified under real concurrency by throwaway probe - see finding 3 |
| Poll: DescribeTable, 100ms interval, 10s ceiling | CONFORMS | `dynamoAdmin.ts:140`, `:144`, `:312-313` | |
| Poll exported with injectable interval/ceiling | CONFORMS | `dynamoAdmin.ts:307-311`; used by case 17 | |
| The poll's own reads are NOT retried; a failed read counts as "not ACTIVE yet" | CONFORMS | `dynamoAdmin.ts:317-323` | |
| Exhaustion split: poll throws its OWN error; `ensureTable` rethrows the ORIGINAL conflict with the status appended | CONFORMS | `dynamoAdmin.ts:281-291`, `:324`, `:383-389` | Behaviour reproduced by throwaway probe; no committed test covers the `ensureTable` half - finding 2 |
| The poll carries no endpoint gate of its own | CONFORMS | `dynamoAdmin.ts:300-305` comment; no gate in `:307-327` | |
| Success path keeps `waitUntilTableExists` unchanged | CONFORMS | `dynamoAdmin.ts:365` | Same waiter, same 60s |
| RECORD, do not fix: a genuinely CREATING pre-existing table is still `'exists'` with no wait | CONFORMS | `dynamoAdmin.ts:377-379`; `s1-retry.md:143-149` | |
| DeleteTable retried; catch additionally tolerates ResourceInUseException | CONFORMS | `dynamoAdmin.ts:471-483` | Unconditional tolerance, as the plan and spec both specify. Downstream cost noted in finding 4 |
| DescribeTimeToLive: PRE-SEND read retried, hook invocation not | CONFORMS | `dynamoAdmin.ts:437-441` (retried) vs `:456-459` (hook, not retried) | Two call sites, explicitly commented |
| UpdateTimeToLive retried with the status re-read as its hook | CONFORMS | `dynamoAdmin.ts:443-461` | |
| Success condition ENABLED or ENABLING | CONFORMS | `dynamoAdmin.ts:458` (hook) and `:442` (pre-send guard) | |
| The TTL hook does NOT swallow | CONFORMS | `dynamoAdmin.ts:452-459` | No try/catch inside the hook, so a throwing re-read reaches the helper's fail-closed branch. Case 7 pins it |

### S1.4 - refactor `db-update-gsis.ts`

| requirement | verdict | evidence | note |
|---|---|---|---|
| `ensureGsis` moved onto the shared helper; the old private retry deleted | CONFORMS | `db-update-gsis.ts:197-212`; the old helper is gone from the file | |
| The verify hook is `indexStatus` answering CREATING or ACTIVE | CONFORMS | `db-update-gsis.ts:207-210` | |
| `indexStatus` keeps its own catch returning undefined | CONFORMS | `db-update-gsis.ts:76-84` | |
| A comment saying the tolerance lives in the caller's hook | CONFORMS (exceeds) | `db-update-gsis.ts:58-70`, `:81` | The plan asked for one line; the docblock was rewritten. Case 16 pins the behaviour |
| The new endpoint gating of `ensureGsis` is stated as an intended tightening | CONFORMS | `db-update-gsis.ts:157-163` | |
| Cases 15/16 use a LOCAL endpoint | CONFORMS | `dynamoAdminRetry.test.ts:83-96` default; neither case changes the hostname | |
| Do NOT touch `unreadIndexRepo.integration.test.ts:728` | CONFORMS | file absent from `git diff --name-only 5ce9912f..HEAD` | |

### S1.5 - verify against existing tests

| requirement | verdict | evidence | note |
|---|---|---|---|
| Five named files run bare from `app/` | CONFORMS | `s1-retry.md:67-79` | All exit 0; the acceptance file re-verified 17/17 by this review |
| `dynamo.integration.test.ts` confirmed to cover the rewritten branch | CONFORMS | `s1-retry.md:89-93`; worklist section 6C | Also names the 22-times `'created'` guardrail against hooking CreateTable |
| Commit + record | CONFORMS | `de7288e8`, `38c167a6`; `s1-retry.md` | |

---

## S2 - logCallSiteGuard

| requirement | verdict | evidence | note |
|---|---|---|---|
| S2.1 time `buildProgram`, `scanProgram` and the health `it` separately | CONFORMS | `measurements/s2-guard-cost.md:25-32` | |
| S2.1 file alone, 3 runs, machine state RECORDED | CONFORMS | `s2-guard-cost.md:6-14`, `:158-186` | All four pre-cut runs QUIET (0 other live vitest runs at both ends), which is better than the brief's upper-bound fallback |
| S2.1 instrument the three checker sites | CONFORMS | `s2-guard-cost.md:34-42` | `:97`, `:106`, and both calls inside `isErrorTyped` |
| S2.1 do NOT instrument `isCatchDeclared` | CONFORMS | `s2-guard-cost.md:44-45` | |
| S2.1 instrumentation REMOVED before handback | CONFORMS | no `performance.now` / `hrtime` / `console.time` anywhere in `app/test/logCallSiteGuard.test.ts` | Verified by grep on the live file |
| S2.2 cut the measured dominant cost | CONFORMS (conditional not triggered) | `s2-guard-cost.md:62-97` | `buildProgram` dominates at 85-86%, for which the plan pre-commits NO remedy and requires a returned decision. The one pre-committed remedy (`:97`) measured 4ms and was declined on the measurement. See finding 5 for the downstream S7 obligation |
| S2.2 `:97` hoist only if material | CONFORMS | `s2-guard-cost.md:73-84`; the shipped file still calls it eagerly at `:97` | 1217 calls, 284 of them wasted, total 4ms |
| S2.2 do not "fix" the already-short-circuiting `||` | CONFORMS | no change to `:98` / `:106` | |
| S2.2 buildProgram remedy returned as a DECISION | CONFORMS | `s2-guard-cost.md:207-213` | Sub-split identifies `ts.createProgram` (4.81s) as the only lever |
| S2.3 health probe not hollowed out | CONFORMS | `logCallSiteGuard.test.ts:172-186` unchanged in substance; comment added `:179-181` | No cheaper replacement was proposed, so none needed the break-module-resolution validation; probe left intact |
| S2.4 hook budget >= 4x measured, ceiling 600s | CONFORMS | `logCallSiteGuard.test.ts:162` (180s unchanged); arithmetic at `s2-guard-cost.md:107-115` | 180s is ~27x the 6.562s slowest measured hook and inside the 600s ceiling |
| S2.4 health `it` gets its own budget if measured near 60s | CONFORMS | `logCallSiteGuard.test.ts:164-171` | Measured 2.46-2.59s; no explicit budget added, and the file records the ~15s threshold at which one would be |
| S2.4 shipped comments cite ONLY this mission's measurements, with date and machine state | CONFORMS | `logCallSiteGuard.test.ts:139-156`, `:164-171` | Dated 2026-09-01, names the QUIET machine state, and carries no inherited 196.2s / 179.1s figure |
| S2.5 3 post-cut runs, instrumentation removed, commit | CONFORMS | `s2-guard-cost.md:142-156`; commits `30642595`, `022bbe92` | 3/3 `it`s green each run, canary positive control included |

---

## S3 - staticSmoke

| requirement | verdict | evidence | note |
|---|---|---|---|
| All nine old `it`s assigned; none dropped | CONFORMS | `s3-static-smoke.md:21-49`; live file `app/test/staticSmoke.test.ts:94-332` | 9 -> 12; 11 can never skip, exactly one can |
| S3.1 fixture via `mkdtemp`, FILE-scoped | CONFORMS | `staticSmoke.test.ts:67-74` | Both describes read the same `distDir` |
| S3.1 fixture created BEFORE `buildApp`; the first describe restructured | CONFORMS | `staticSmoke.test.ts:69-74`, `:80-92` | App now built per test, so nothing is constructed at collection time |
| S3.1 cleaned up with `rmSync` | CONFORMS | `staticSmoke.test.ts:76-78` | |
| S3.1 fixture MUST contain `<div id="root">` | CONFORMS | `staticSmoke.test.ts:63-65`; asserted at `:175`, `:244` | |
| S3.1 the `HousingChoice` tautology REPLACED by a distinctive marker | CONFORMS to plan, DEVIATED from spec text | `staticSmoke.test.ts:45-48`, `:100` | The spec's fixture paragraph still demands `HousingChoice`; see finding 1 |
| S3.1 fixture MUST NOT contain "version", "private" or `root:` | CONFORMS | `staticSmoke.test.ts:56-65` | The literal with a colon does not occur; the id attribute is not a match |
| S3.1 traversal assertions carry over UNCHANGED | CONFORMS | `staticSmoke.test.ts:227-246` | Six probes, same accepted-status set, same three leak markers, same SPA-shell body check |
| S3.1 the traversal COMMENT rewritten to what the probes now pin | CONFORMS | `staticSmoke.test.ts:213-225` | States the composition property; the old "realistic exfiltration target on this exact tree" claim is gone |
| S3.1 no decoys; `send` version recorded in the slice report | CONFORMS | `s3-static-smoke.md:106-114`; also in-code at `staticSmoke.test.ts:218` | 1.2.1, single copy; see finding 9 on the in-code copy |
| S3.1 positive control asserting the BODY | CONFORMS | `staticSmoke.test.ts:50-54`, `:103-111` | Asserts the asset body AND that it is not the SPA marker, so a fallthrough cannot pass |
| S3.2 five conditions against tracked `dashboard/index.html`, never skips | CONFORMS | `staticSmoke.test.ts:31-36`, `:42`, `:289-299` | Exactly three present + two absent; no skip guard |
| S3.3 (c) can PASS or SKIP, never FAIL | CONFORMS | `staticSmoke.test.ts:314-332` | `ctx.skip` throws, so both skip branches abort before any expect. Vitest 3.2.6 types the note argument |
| S3.3 absent dist -> SKIP with the build instruction | CONFORMS | `staticSmoke.test.ts:316-318` | Branch observed live, `s3-static-smoke.md:127-134` |
| S3.3 present + all five hold -> PASS | CONFORMS | `staticSmoke.test.ts:322-330` | Observed, and re-observed by this review (12/12 with a fresh dist present) |
| S3.3 present + any fails -> SKIP with the two-cause message | CONFORMS | `staticSmoke.test.ts:308-312`, `:322-324` | Message carries both causes and the real slug |
| S3.3 no literal `<slug>` in the shipped string | CONFORMS | `staticSmoke.test.ts:312` names `docs/issues/built-dashboard-identity-tags-unasserted.md`, which is the actual committed filename | |
| S3.3 the second new issue FILED HERE, in S3 | CONFORMS | `docs/issues/built-dashboard-identity-tags-unasserted.md:1-10`; committed in the S3 wave | Frontmatter valid: `npm run issues` reports no warning for it (its one warning is a pre-existing unrelated file) |
| S3.3 no mtime predicate of any kind | CONFORMS | `staticSmoke.test.ts:301-307`, `:314-332` | No `statSync`, no mtime comparison anywhere in the file |
| S3.4 build once, record the PASS branch; STOP if a fresh build fails the five | CONFORMS | `s3-static-smoke.md:135-137` | Fresh build satisfied all five, so no STOP condition fired |
| S3.4 break the built file in place, record the SKIP branch and its message | CONFORMS | `s3-static-smoke.md:138-157` | Observed under BOTH the verbose and the default reporter |
| S3.4 restore by rebuilding | CONFORMS | `s3-static-smoke.md:159-161`, `:214-221`; `git status --short` empty | `dashboard/dist` left present and fresh, so a later `npm test` exercises the PASS arm |

---

## Spec-level rollups

| spec item | verdict | note |
|---|---|---|
| Item 1A - retry the unprotected control-plane surface, gated, with an acceptance suite that can fail | CONFORMS | All ten spec cases are present as a subset of the plan's 17. The spec's exhaustion wording ("rethrow the original ResourceInUseException with the observed status appended") is what `ensureTable` actually does; the plan's two-layer split preserves that observable, which I reproduced |
| Item 2 - logCallSiteGuard's self-defeating budget | CONFORMS as a measurement; the ITEM'S PREMISE did not survive | The file costs 10.1s wall / 6.5s hook here against the issue's 196.2s, so the 180s budget was already ~27x, not ~1x. The slice escalated this rather than deciding it. Finding 5 |
| Item 3 - staticSmoke must not depend on a gitignored artifact | CONFORMS | No `it` in the file now depends on `dashboard/dist` for its colour; the only skippable case is the diagnostic, and it cannot fail |

---

# FINDINGS

Counts: **0 blocker, 0 must-fix, 2 should-fix, 7 note.**

Nothing in S1, S2 or S3 contradicts the plan in a way that changes shipped
behaviour. The two should-fix items are obligations this work creates for
later slices; the notes are coverage and documentation gaps.

1. **note - CONFIRMED - `app/test/staticSmoke.test.ts:45-48` (and spec
   `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md:526`).**
   The plan states that where plan and spec disagree the SPEC wins and the
   disagreement is itself a finding. They disagree here: the spec's fixture
   paragraph requires the fixture `index.html` to carry `HousingChoice`,
   while plan S3.1 replaces that assertion with a distinctive fixture
   marker. The builder followed the PLAN. That is the right call - the
   spec's own watch item about tautological assertions is exactly what the
   plan applied, and asserting `HousingChoice` against a fixture the test
   itself writes proves nothing - so this is a stale SPEC line, not a code
   defect. Failure scenario: a later reader reconciles the code to the spec,
   restores the `HousingChoice` assertion, and re-introduces the tautology
   the plan removed. Remedy: note the supersession in the handback (or stamp
   the spec line) so the spec cannot be read as the live contract.

2. **note - CONFIRMED - `app/src/lib/dynamoAdmin.ts:383-389`.** The plan
   splits poll exhaustion across two layers and assigns an acceptance case
   only to the poll half (case 17). The `ensureTable` half - catch the
   poll's own error, rethrow the ORIGINAL `ResourceInUseException` with the
   observed status appended - is executed by no committed test. I
   reproduced it with a throwaway probe (since deleted): it behaves exactly
   as specified, rejecting with a `ResourceInUseException` instance whose
   message carries both the original conflict text and the table name plus
   CREATING. Conforms to the letter of the plan; recorded because failure
   scenario: a later edit that rethrows the poll error instead of the
   original, or drops the message splice, ships with all 17 cases green and
   the caller then sees a `TableNotActiveError` where every existing catch
   in the repo discriminates on `ResourceInUseException`.

3. **note - CONFIRMED - `app/src/lib/dynamoAdmin.ts:349-353` and `:380`.**
   The per-call `retried` local is the plan's single most emphasised seam
   (its watch item states plainly that a module-level flag would pass all 17
   cases because they are sequential), yet no committed test exercises two
   concurrent `ensureTable` calls. Case 3 pins the no-retry path only in
   isolation. The one live concurrent site,
   `app/test/todayUnmatchedNonRegression.test.ts:105-109`, asserts nothing
   about `DescribeTable`. I verified the shipped behaviour with a throwaway
   probe (deleted): a retried call and a clean call running concurrently
   poll and do-not-poll respectively. Failure scenario: a future refactor
   hoists `retried` to module scope for convenience; the entire suite stays
   green and every concurrent `ensureTable` starts paying an unnecessary
   `DescribeTable` poll - or throws where it used to return instantly. A
   two-line concurrency case in the acceptance suite would close it.

4. **note - CONFIRMED - `app/src/lib/dynamoAdmin.ts:481`, reached from
   `app/scripts/db-create.ts:63-64` and `:75-76`.** `deleteTableIfExists`
   now tolerates `ResourceInUseException` unconditionally (as plan S1.3 and
   the spec both require). `dropAllTables` - the `npm test` teardown path -
   calls it and then `waitUntilTableNotExists` with a 60s ceiling, whose
   second poll is a flat 20s. A busy/DELETING table that previously threw
   immediately now falls into that waiter. The spec accepts this trade
   explicitly and plan S7.2 requires the observation to be RECORDED and
   measured only if it shows in teardown timing. Failure scenario: teardown
   silently gains 20-60s per busy table on the very gate this mission exists
   to speed up, and nobody looks because the change reads as a pure
   improvement. This is an outstanding S7 obligation, not a code defect.

5. **should-fix - CONFIRMED -
   `docs/superpowers/reviews/2026-08-31-npm-test-soundness/measurements/s2-guard-cost.md:199-206`
   and `app/test/logCallSiteGuard.test.ts:162`.** S2 shipped comments, not a
   cut, and the plan permits that (no remedy is pre-committed for the phase
   that actually dominates). But the measurement retired item 2's premise:
   the file costs 6.5s in the hook here against the issue's recorded 196.2s,
   so the 180s budget was never ~1x. Plan S7.1 nevertheless calls for a
   Resolution stamp on
   `docs/issues/logcallsiteguard-hook-budget-equals-its-own-cost.md`.
   Failure scenario: S7 stamps that issue resolved in language implying a
   cut or a budget raise fixed it; the next `Hook timed out in 180000ms`
   under genuine load reopens a closed issue with no new information, and
   the 27x headroom - which is deliberate and load-justified, not slack -
   gets trimmed by someone reading the solo number. The closure must say
   what was actually established: unreproducible premise on a QUIET box on
   this date, budget unchanged and deliberately not lowered, no cut made,
   two remedies returned as decisions.

6. **should-fix - CONFIRMED -
   `docs/superpowers/reviews/2026-08-31-npm-test-soundness/s1-retry.md:30-34`.**
   Plan S1.0 requires that any enumeration hit the disposition rule does not
   reach becomes a finding for the HANDBACK, not a silent decision. Two are
   genuinely unclassified: `app/test/unreadIndexRepo.integration.test.ts:729`
   (a `waitUntilTableExists` immediately after the `CreateTable` the plan
   forbids touching) and `scripts/wipe-dev-data.mjs:170` (root `scripts/`,
   `.mjs`, and it targets the human's AMBIENT dev environment, which no rule
   in spec or plan addresses). Both are correctly recorded in the slice
   record and both were left untouched, which is right. Failure scenario:
   S8's handback omits them, and the next mission rediscovers - on the
   human's live dev data, in the `wipe-dev-data` case - that the control
   plane there was never classified. They must appear in `handback.md`.

7. **note - CONFIRMED - `app/test/staticSmoke.test.ts:82-92`, `:258`,
   `:273`.** Plan S3.1 says the SECOND describe "needs only the file-scoped
   `distDir`, not restructuring". It was restructured anyway: its private
   app builder was deleted and both describes now share one `fixtureApp`
   helper taking an env override. Assertions are unchanged and both CSP
   cases pass. A benign simplification that arguably improves the file, but
   it is a deviation from the plan's stated minimal change and should be
   named rather than discovered.

8. **note - CONFIRMED - `app/test/staticSmoke.test.ts:190` shadowing the
   import at `:18`.** The hardening-headers case reuses `path` as its loop
   variable while `node:path` is imported under the same name at module
   scope. Carried over unchanged from the pre-rewrite file and flagged by
   the builder. Harmless today because that block only uses the string, but
   the file now depends on the real `node:path` at module scope for the
   fixture, so any future `path.join` added inside that loop body silently
   resolves to a string. One rename closes it.

9. **note - CONFIRMED - `app/test/staticSmoke.test.ts:218`.** The traversal
   comment hard-codes the installed `send` version. The plan asked for the
   version in the SLICE REPORT (where it also is, correctly). The in-code
   copy is a claim that will silently go stale on the next transitive bump,
   and the whole no-decoys argument rests on it. Failure scenario: `send` is
   bumped, the comment still names 1.2.1, and a reader trusts a version
   assertion nothing verifies. Either drop the version from the comment and
   point at the slice record, or accept it as a dated observation and say
   so.

---

## What this review did NOT cover

- S0, S4 and S5 measurement methodology (read as inputs only; S5 has not
  run).
- Gates 1-5, which are S6 and have not run on this branch.
- Issue closures, `AGENTS.md` and `_CLUSTERS.md` (S7, not run).
- Any judgement on whether the anchor issue may be closed - that depends on
  S5/S6 evidence that does not exist yet.
