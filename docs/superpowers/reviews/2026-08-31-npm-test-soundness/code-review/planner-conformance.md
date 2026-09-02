# Planner's independent SPEC-CONFORMANCE review

- Branch `feat/npm-test-soundness`, tip `91c831d6`, diff `main...HEAD`
  (main @ `1af02926`).
- Spec `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v5).
- Plan `docs/superpowers/plans/2026-09-01-npm-test-soundness.md` (v5 FINAL).
- Handback `docs/superpowers/reviews/2026-08-31-npm-test-soundness/handback.md`.
- Method: STATIC ONLY - reading, `git`, `grep`. **No suite, npm script, vitest,
  playwright or Docker command was run**, because the planner was running the
  five gates on this same worktree concurrently. Everything below is either a
  file:line I read or is marked UNVERIFIED.

**Verdict: 5 findings - 1 high, 3 medium, 1 low. 0 blocking. Coverage is
clean: every plan slice and every spec decision is delivered, all 17 plan
acceptance cases exist and assert what the plan says they assert, and the
scope question resolves in the branch's favour.** Four of the five findings
are recording defects, not code defects; three of them are the mission's own
failure class (a claim whose stated reason does not hold) landing in text this
mission shipped.

---

## FINDINGS

### 1. HIGH - `AGENTS.md:163-165` states the negation of the measurement it cites

The rewritten first-diagnostic paragraph says:

> re-measured 2026-09-01 on a fresh container the explicit-key arm was
> **not faster** (default 231/190s vs explicit 189/165s, app workspace, light
> load - the spread tracked neighbour load, not the key)

189 < 231 and 165 < 190. The explicit-key arm was faster in **both** paired
runs, by 18% and 13%. The sentence asserts the opposite of the four numbers
inside its own parenthesis.

The branch's own measurement record says so plainly and warned against exactly
this sentence:

- `measurements/s5-clean-key.md:42-43` - "the explicit-key arm was not slower;
  it was slightly faster (189/165s vs 231/190s)".
- `measurements/s5-clean-key.md:64-69` - "**The rewrite must not claim the
  explicit key is slow on a quiet box - it measurably was not, today** - but
  that it silently restores the one-database regime and skips 2 guard
  assertions".

Spec Deliverable 6 (`spec:664-666`) requires the paragraph be rewritten "to
the numbers this container actually produces. **Only what is proven.**"

Why this is high and not cosmetic: `AGENTS.md` is the canonical file every
agent loads at session start, the paragraph is the FIRST thing it says about a
red `npm test`, and the mission's whole thesis is `spec:101-103` - "a wrong
reason for a right-looking decision is worse than none". A reader who checks
the arithmetic has no way to tell which half of the paragraph to trust, and
the conclusion (the recipe is superseded on the CODE reading) is correct and
did not need the speed claim at all.

The sibling texts are clean: `docs/issues/npm-test-dynamodb-local-contention.md:136-146`
makes no speed claim, and `docs/issues/_CLUSTERS.md` (M7 block) makes none
either. Only `AGENTS.md` carries it.

**Fix:** one clause. Either delete "the explicit-key arm was not faster" and
keep the confound sentence, or state what was measured - "the explicit-key arm
was slightly FASTER on a quiet box (189/165s vs 231/190s), tracking a declining
e2e neighbour rather than the key; the recipe is superseded on the code
reading, not on wall clock".

---

### 2. MEDIUM - the "31.5s worst loaded" figure in a shipped issue closure is in no committed record

`docs/issues/logcallsiteguard-hook-budget-equals-its-own-cost.md:51-54` closes
a Tier-2 issue on this:

> inside a fully contended five-workspace `npm test` (host CPU 100%, a
> concurrent vitest run plus two e2e suites) it ran **31.5s** - against the
> unchanged 180s hook budget. The budget was therefore ~27x the solo cost and
> **~5.7x the worst loaded observation**

`handback.md:20` repeats it ("31.5s worst loaded") and cites
`measurements/s2-guard-cost.md` as the evidence.

That record does not contain the number. Its only load datum is the opposite
scale, and it says so in terms - `measurements/s2-guard-cost.md:188-195`:

> One post-strip window was contended and it is informative. [...] The health
> `it` tracks it exactly: 2.497 -> 2.688 -> 2.909s and wall 10.06 -> 10.42 ->
> 11.21s. A **single light neighbour costs ~11%** on this file. Extrapolating
> from one point is not evidence, but it is **the only direct load datum this
> slice produced**.

`measurements/s0-baseline.md` records no per-file durations at all (grep for
`logCallSite` in it returns nothing), and `31.5` appears nowhere else under
`docs/`.

The provenance exists, but only in gitignored run state -
`.superpowers/sdd/progress.md:29`: "10.1s solo, **31.5s in S0 run1 at host CPU
100%**". So the figure is real and was honestly obtained; it is simply not
landed. When this worktree is removed, the sole quantitative support for a
closed issue's "~5.7x" claim disappears, and the record the closure points at
contradicts it in spirit. That is precisely the failure `AGENTS.md`'s own
records rule and `FEATURE-DEVELOPMENT-WORKFLOW.md` section 8 exist to prevent
(a 2026-08-21 sweep destroyed 16 worktrees' history the same way).

Note the arithmetic is internally consistent (180 / 31.5 = 5.71), so this is a
provenance gap, not a wrong number.

**Fix:** add the S0-run-1 per-file observation to
`measurements/s2-guard-cost.md` (or to `s0-baseline.md`) with its run label and
snapshot, and point the closure and the handback at it.

---

### 3. MEDIUM - the declared decoy deviation is sound, but both documents a future reader lands on still say the opposite, unmarked

The deviation itself I judge **correct on the merits and well evidenced**. The
spec argued (`spec:542-548`) that `send` rejects any normalized `..` before the
filesystem is touched, so "There is no depth at which a decoy could be read".
That is true and is not the question. The probes exist to catch a FUTURE
static-serving change, and the r1 adversarial reproduction settles it:
`code-review/r1-adjudications.md:19` records a hand-rolled leaky static layer
failing **4/6 with a target present and 0/6 without one**. Without a target the
six assertions are unfalsifiable by construction. The implementation is
correspondingly careful: one decoy, at the one depth four probes resolve to,
inside the `mkdtemp` root (`app/test/staticSmoke.test.ts:67-72`, written at
`:98`, removed by `afterAll` at `:101-106`), and the comment states the
Windows-vs-POSIX asymmetry and which two probes remain shape probes
(`:258-276`). The spec's load-bearing negative constraint survives - the decoy
is a separate file that is never served, and `FIXTURE_INDEX_HTML` (`:63-65`)
still carries none of `"version"`, `"private"`, `root:`.

The problem is where it is recorded. It is declared in `handback.md:56-66` and
adjudicated at `r1-adjudications.md:19`. It is NOT marked in either document a
reader actually arrives at:

- **The spec.** `spec:542-548` still reads "**No traversal decoys. The whole
  decoy idea is dropped, and this is the third revision it has broken in.**"
  with no supersession note - while this same branch DID add one, four
  paragraphs earlier, for the much smaller C1 fixture-marker change
  (`spec:528-530`, "[Superseded by plan S3.1 after plan review round 1: ...]").
  Marking the lesser change and not the greater one is worse than marking
  neither: it teaches a reader that unmarked spec text is live. The plan's own
  rule (`plan:21`) is "Where the two disagree, the spec wins and the
  disagreement is a finding", so a future reader following the rule as written
  is required to call the shipped code wrong.
- **The S3 slice record, which the shipped code itself cites.**
  `app/test/staticSmoke.test.ts:279-281` sends the reader to "the S3 record"
  for the `send` version. Arriving there they find, in the same section:
  `s3-static-smoke.md:106` "**There are no decoys and no reason for any.**
  Installed `send` is 1.2.1", plus `:84` and `:110` saying the same. Records
  commit AS PRODUCED and that record was true at `796b8632`, before the wave-1
  fix at `b81ceb23` - but nothing in it says so, and the code points at it.

**Fix:** one bracketed ASCII sentence at `spec:548` in the C1 style, and one at
`s3-static-smoke.md:106` naming `b81ceb23` and `r1-adjudications.md` A3.

---

### 4. MEDIUM - false provenance in a shipped runtime comment: `app/src/lib/dynamoAdmin.ts:174-175`

> NOT a contradiction of db-update-gsis.ts's 900s timeout, **which the same
> diff introduced**: that one waits on a GSI BACKFILL over a populated local
> table, which legitimately takes minutes.

The 900s ceiling is `waitUntilIndexActive`'s default and it is pre-existing:
`git log -S "900_000" -- app/scripts/db-update-gsis.ts main` returns
`1448b130` ("feat(scripts): add missing local GSIs without dropping tables",
2026-08-16), which `git merge-base --is-ancestor 1448b130 main` confirms is an
ancestor of main. It sits at `db-update-gsis.ts:158` on main and `:115` on this
branch, and this branch's diff of that file never touches it. `1448b130` also
did not introduce the old `sendWithInternalFailureRetry`, so the charitable
re-reading ("the same diff as the original retry") does not rescue it either.

The branch knew this. Its own S1 record says at `s1-retry.md:160-163`:
"`waitUntilIndexActive` (`db-update-gsis.ts:158`) still defaults to a 900s
ceiling and `ensureGsis` still calls it with no override. **Untouched by this
slice**, and out of its scope".

The comment's actual argument - that a 10s poll on a table this call just
created is not in tension with a 900s wait on a GSI backfill - is correct and
is what `r1-adjudications.md:21` (A5) asked for. Only the provenance clause is
false, and it is the kind of detail a reader uses to decide whether to trust
the paragraph.

**Fix:** delete "which the same diff introduced", or replace with "which
predates this change (`1448b130`)".

---

### 5. LOW - three non-ASCII characters in a committed review record

`docs/superpowers/reviews/2026-08-31-npm-test-soundness/design-review/plan-r3-reviewer-c.md`
adds three lines ending in U+2713 (check mark). Plan rule `plan:24-27` is
"ASCII only in new or touched lines of specs, plans, prompts, issues, comments,
log strings and test names. Captured tool output is preserved verbatim as the
exception"; a reviewer's own tick is not captured output.

Scope of the check, so the result is usable: a scan of **every added line in
the whole `main...HEAD` diff** (739,390 bytes) found exactly **3** code points
above 0x7F, all of them that check mark, all in that one file. `app/`,
`AGENTS.md`, `docs/issues/`, the spec and the plan are **clean - zero**.

---

## WHAT I CHECKED AND FOUND CLEAN

### Q1 - Coverage: the plan's 17 acceptance cases

All 17 exist in `app/test/dynamoAdminRetry.test.ts` and assert what
`plan:194-210` specifies. Mapping, verified by reading each case body:

| plan case | file:line | asserts as specified |
|---|---|---|
| 1 CreateTable IF x2 then ok | `:264` | resolves `'created'`, `CreateTable` sent 3x |
| 2 accepted-but-unanswered -> poll to ACTIVE | `:277` | `'exists'`, 3 `DescribeTable` (CREATING/CREATING/ACTIVE) |
| 3 plain conflict, ZERO DescribeTable | `:296` | `'exists'`, 1 send, **0** `DescribeTable` |
| 4 DeleteTable IF then RIU | `:306` | resolves undefined, 2 sends |
| 5 UTTL re-read between attempts | `:318` | exact ttlLog interleave, one hook read |
| 6 re-read ENABLED -> no re-send | `:335` | 1 `UpdateTimeToLive`; first guard read is DISABLED, so the case cannot pass by early return |
| 7 re-read THROWS -> original rethrown | `:354` | rejects `name: 'InternalFailure'`, 1 send |
| 8 `InternalServerError` lock signature | `:368` | retried identically, 2 sends |
| 9 PRE-SEND DescribeTimeToLive retried | `:377` | ttlLog `[DTTL, DTTL, UTTL]` |
| 10 bound 4 sends, hook 3x, not on the final | `:393` | count 4 + the literal 8-element interleave, no trailing read |
| 11 non-local endpoint | `:412` | rejects, 1 send |
| 12 no endpoint provider | `:423` | rejects, 1 send |
| 13 REAL `DynamoDBClient` local + region-only | `:434` | predicate true / false, both destroyed |
| 14 localhost / 127.0.0.1 / ::1 / [::1] | `:446` | all true, plus 3 negatives, plus absent and throwing providers |
| 15 `ensureGsis` still retries `UpdateTable` | `:463` | 2 `UpdateTable`, index reported added |
| 16 `ensureGsis` stays FAIL-OPEN | `:479` | verification read throws, re-send still happens |
| 17 poll called directly, never ACTIVE | `:499` | `TableNotActiveError`, message names table + status, `observedStatus` field |

The stub honours all five contract clauses `plan:169-190` demands: per-command
per-call scripting (`:139-148`), an ordered send log that distinguishes hook
reads from sends by position (`:115-116`, `:161-165`, and the reasoning at
`:18-22`), post-send `DescribeTable` answering table+index ACTIVE via
`fallback` (`:145-148`, `:469`, `:489`) so `waitUntilIndexActive`'s 900s
ceiling cannot hang cases 15/16, real SDK exception instances (`:227-239`), and
a settable resolvable endpoint provider (`:167-182`).

The handback's "22 cases" is accurate and honestly qualified: the extra five
(18 un-retried DeleteTable conflict still throws `:517`; 19 `ensureTable`'s
half of the exhaustion split `:534`; 20 per-call `retried` under concurrency
with a shared answer-ordered timeline `:561`; 21 elapsed-time deadline `:605`;
22 an expired deadline still asks the hook `:636`) came from review, and
`handback.md:19` says "red-first proven **11/17**" rather than claiming 22 -
matching `s1-retry.md:36-59`, which tabulates the red run case by case
including the six that passed and WHY each passed (three vacuously, three as
regression guards).

### Q1 - Coverage: every spec decision and plan slice

- **S0** - `measurements/s0-baseline.md`: 3 runs at `5ce9912f` (580/452/463s),
  install + discarded warm-up (`:11-14`), the three-filter read-only neighbour
  count reproduced without pruning (`:19-27`), both sweep modes derived
  (`:36-42`), scope labelled five-workspace (`:7-10`), and the skipped counts
  plan S0 step 5 requires (`:58-60`, `:156-159`).
- **S4** - `measurements/s4-groupcrosscheck.md`: 10/10 solo green, 26/26 each,
  file NOT edited (`:7`), and the strike is narrow - it names the two anchor
  cases, the TTL-diagnosed third, the two 2026-08-18 cases, AND what the
  evidence does not cover (`:55-73`). The anchor text carries that narrowness
  through (`npm-test-dynamodb-local-contention.md:26-39`).
- **S1** - the helper conforms to `plan:216-267` clause for clause:
  `sendWithRetry<TOut>` returns `TOut` and accepts no hook (`dynamoAdmin.ts:302`),
  `sendWithRetryVerified` returns `void` with a required hook (`:326`), one
  private loop (`:239`), 4 attempts + linear `n*250` + injectable backoff
  (`:248-250`), retryable names (`:225`), lazy fail-closed endpoint gate
  resolved at most once (`:254`, `:263`, `:212-221`), and the hook contract
  exactly as tabulated - true returns, false re-sends, throws rethrows the
  ORIGINAL, absent re-sends, bound checked BEFORE the hook (`:262` above
  `:265-276`). The send-to-function assignment matches `plan:246-252` row for
  row (`:422` CreateTable, `:541` DeleteTable, `:508` pre-send read, `:510`
  UpdateTimeToLive verified, `db-update-gsis.ts` UpdateTable verified). The
  `onRetry` per-call seam is the plan's literal shape (`:420-431`, `:447`;
  `:539-550`, `:565`), with the concurrency reason in the comment. The poll is
  100ms/10s, exported, injectable, its own reads unretried, no second endpoint
  gate (`:168`, `:193`, `:374-394`). The exhaustion split lands where the plan
  put it (`:447-457` rethrows the ORIGINAL conflict with the poll's observation
  appended; the poll throws its own type). `waitUntilTableExists` on the
  success path is unchanged (`:432`). `indexStatus`'s swallow stayed in the
  caller with the mandated comment line. S1.0's enumeration was re-run (31 hits)
  and its two unclassifiable sites are carried to the handback, not silently
  decided (`s1-retry.md:23-34`, `handback.md:100-103`).
- **S2** - comments-only, verified from the diff (the only additions to
  `app/test/logCallSiteGuard.test.ts` are three comment blocks); instrumentation
  removed. Every number in the shipped comment reconciles with
  `measurements/s2-guard-cost.md:29-32,39-42,58,64-75`: hook 6.46-6.56s,
  buildProgram 5.52-5.66, scanProgram 0.91-0.93, `createProgram` 4.81,
  `getTypeChecker` 0.70, `getTypeAtLocation` 0.73/1204 calls, the `:97` hoist
  4ms over 1217 calls (284 wasted), health `it` 2.46-2.59s. 180/6.5 = 27.7x, so
  the >= 4x rule holds with the budget UNCHANGED; the health `it` at 4x = 10.3s
  sits inside the 60s global, so plan S2.4's conditional per-test budget
  correctly did not fire. The probe was not hollowed out (S2.3) - the TS2307
  check is intact and gained the `include: ["src"]` explanation. The pivot from
  "cut" to "measurement only" is a premise failure, declared at
  `handback.md:20` and in the closure.
- **S3** - 9 `it`s -> 12, verified by reading: eight in the first describe
  (`:123, :131, :141, :180, :198, :206, :216, :242`), two CSP (`:320, :335`),
  (b) at `:353`, (c) at `:378`. Only (c) can skip. Every row of `plan:462-470`
  lands where the table says. The positive control the file lacked exists and
  asserts the BODY plus `not.toContain(FIXTURE_MARKER)` (`:131-139`) - the
  vacuity the plan called out. The `HousingChoice` tautology is gone
  (`:45-48`). The SKIP message (`:371-375`) matches `plan:533-537` and names a
  slug that exists: `docs/issues/built-dashboard-identity-tags-unasserted.md`
  is present and substantive. No mtime predicate anywhere. `send` 1.2.1 is
  recorded in the slice report (`s3-static-smoke.md:106`) and I confirmed the
  installed version is 1.2.1; vitest is 3.2.6, which supports `ctx.skip(note)`.
  The three live (c) branches are claimed observed at
  `s3-static-smoke.md:116-140` - UNVERIFIED by me (running them is forbidden
  here).
- **S5** - `measurements/s5-clean-key.md`: 4 interleaved arms at one named
  commit `09d624e9`, app-workspace scope labelled and declared non-comparable
  to S0/S6, all three plan confounds recorded including the 2-test skip delta,
  and the TTL probe run AFTER the arms with a drop between them, on the
  `messages` table (a spec that carries `ttlAttribute`) with `contacts` as the
  no-TTL control. The ENABLED/DISABLED contrast is decisive and the control row
  is what makes it so.
- **S6** - `measurements/s6-post-fix.md`: one sync, gate table, gate-5 file
  list of six, 3 post-fix runs, and **all four** S0/S6 confounds stated with
  the mixed-pair use restriction quoted (`:51-68`). The cwd-reset incident is
  disclosed rather than buried (`:28-33`).
- **S7** - all four registry deliverables land. Verified: statuses flipped in
  both medium issue files (`logcallsiteguard...:6-9`,
  `static-smoke...:6-11`); the anchor stays `open` with the new numbers and an
  unchanged reopen condition; the clean-key recipe is superseded in **all
  three** files - `AGENTS.md:152-174`, `npm-test-dynamodb-local-contention.md:136-146`,
  `_CLUSTERS.md` (both the M7 `high` row and the "run its gates under a clean
  access key" advice); both new issues exist and are substantive; and
  `docs/issues/INDEX.md` is regenerated - it lists both new slugs and shows
  `open` / `resolved` / `resolved` correctly at `:16`, `:312`, `:316`.
- **S8** - the handback names both SHAs (`b4ba463a` gated, `91c831d6` final),
  the drift, and five open items.

### Q2 - Other deviations, checked and NOT findings

- **`deleteTableIfExists` tolerates `ResourceInUseException` only when
  `retried`.** Spec `:138` and `plan:320-321` say "tolerate it" unqualified.
  The gating is narrower - but it is adjudicated (`r1-adjudications.md:18`,
  A2, explicitly logged as a "Spec-vs-tree call"), commented at the site
  (`dynamoAdmin.ts:553-564`), and pinned by cases 4 and 18. Decisively: I
  diffed `git show main:app/src/lib/dynamoAdmin.ts` and the un-retried path is
  now **byte-equivalent in behaviour to main** (RNF swallowed, everything else
  thrown), where the unqualified reading would have silently changed
  `db-create.ts` and ~50 delete-then-create hooks. Strictly safer, correctly
  reasoned, adequately recorded. Not a deviation worth a finding.
- **`RetrySchedule.deadlineMs` (default 20s) is new; neither spec nor plan
  mentions a time bound.** It is an addition, not a contradiction, and the
  spec's own rationale invites it (`spec:165-166`: "A retry loop that can
  outlive a test budget trades one false red for another"). Adjudicated at
  `r1-adjudications.md:20` (A4), named in `handback.md:19`, named again in the
  anchor issue's update, documented at `dynamoAdmin.ts:144-167`, and pinned by
  cases 21 and 22. R2 then caught the deadline pre-empting the verify hook and
  R3's NEW-1 caught the resulting arithmetic being one term short - both fixed
  (`:279-286`, `:153-158`). Well handled.
- **Spec "What this mission does NOT do" (`:626-636`)** - all clear. No runtime
  code outside `dynamoAdmin.ts`; no `e2e/` file in the diff; `seedLive`,
  `seedProfile.integration`, `unreadIndexRepo.integration` untouched; both
  filed-not-fixed items filed; no merge, deploy, infra or cleanup. The
  container restart was done by someone outside the mission and is disclosed
  three times (`s5-clean-key.md:47-52`, `s6-post-fix.md:66-68`,
  `handback.md:108-109`).
- **Commit trailers.** Every code commit carries
  `Co-Authored-By: Claude Opus 5 (1M context)`. Eleven records carry
  `Claude Fable 5` - the orchestrator's own commits, which is correct
  attribution under `AGENTS.md` ("naming the authoring model"). Only the merge
  commit `b4ba463a` has no trailer, which is normal for a merge.

### Q3 - Claims vs facts, cross-checked

Beyond findings 1, 2 and 4, everything I could check statically holds:

- `handback.md:35` "6 touched .ts files" - `git diff --name-only
  --diff-filter=d main...HEAD -- '*.ts' ...` returns exactly those six, and
  `s6-post-fix.md:24-26` lists the same six.
- `handback.md:19` "red-first proven 11/17" = `s1-retry.md:38-39`.
- `handback.md:18` S4 "10/10 green (13.4-22.9s)" = `s4-groupcrosscheck.md:20-29`.
- `handback.md:32` gate-2 counts = `s6-post-fix.md:42-49` exactly.
- `handback.md:70-73` logCallSiteGuard closure - matches the issue text
  (`:48-81`), including that the budget is UNCHANGED, no cut was made, and the
  RPC fault is credited to `maxWorkers: 4` and not to this work.
- `handback.md:74-76` staticSmoke closure - matches the issue text (`:67-83`),
  including "not the suggested mtime predicate (git defeats it)".
- `handback.md:77-81` anchor - the file is still `status: open` and the reopen
  condition is untouched.
- `handback.md:82-84` two new issues - both files exist, both are complete
  Tier-2 documents with mechanism, evidence and a suggested fix, and the
  built-dashboard slug matches the string shipped at
  `staticSmoke.test.ts:375` byte for byte.
- `AGENTS.md:158-159`'s "446-509s loaded vs 75-95s" traces to
  `npm-test-dynamodb-local-contention.md:349-350`; its "2
  `dynamoAccessKeyGuard` assertions" traces to `s5-clean-key.md:32-34`; its
  "22-case acceptance suite" matches the file.
- The five gate exit codes, the e2e 262-passed line and `npm run issues` being
  clean are **UNVERIFIED** - they are runtime claims and running anything was
  forbidden. `s6-post-fix.md` quotes them consistently with the handback, and
  `INDEX.md` on disk is consistent with a regeneration having happened.

### Q4 - Scope

**Both scope questions resolve in the branch's favour.**

- **The sixth file.** `app/test/setup/dynamoAccessKeyGuard.test.ts` is not in
  the plan's five, and the reason is that the plan could not have known: the
  branch's own new acceptance suite tripped the guard's `createsTables`
  predicate (it names `ensureTable` and `CreateTableCommand` while creating
  nothing), turning gate 2 red - the very gate this mission exists to make
  trustworthy. Recorded as the R1 **blocker** at `r1-adjudications.md:17`,
  including the rejected alternative (salting stub names with `randomUUID` to
  satisfy the regex mechanically) and the scope argument ("the guard is test
  infrastructure, not app runtime; the spec's 'no runtime code other than
  dynamoAdmin.ts' holds"). The edit is proportionate: a third declared marker
  `hc:dynamo-lane none` matched as a whole comment LINE so the file's own prose
  cannot self-exempt (`:60-70` of the diff), plus a rot-proof case that fails
  if a `none` suite ever reaches a container. Its two known holes - it does not
  follow imports, and a bare SDK `DynamoDBClient` is deliberately unmatched for
  case 13 - are documented in the file rather than left to be discovered. This
  is justified and recorded, not scope creep.
- **`dynamoAdmin.ts` +444.** I read the file end to end. Roughly 40% is comment
  the spec and plan explicitly require (the failure-mode preamble `:75-119`,
  the deadline and poll-ceiling rationale `:144-193`, the hot-path and
  fail-closed explanations). The remainder is exactly the specified surface:
  `RetrySchedule` / `PollOptions` / `EnsureTableOptions`, the private
  `retryLocalControlPlane` loop, the two public entry points, the exported
  predicate, `TableNotActiveError` + `pollUntilTableActive`, and the changes
  inside `ensureTable` / `enableTtlIfNeeded` / `deleteTableIfExists`. The
  removed-lines list for this file is 13 lines, every one of them a line the
  refactor replaces. Nothing unrelated rode along. `ensureGsis`'s new trailing
  `opts` is optional and no existing caller passes it
  (`db-update-gsis.ts:253`, `unreadIndexRepo.integration.test.ts:764/803/812`).

---

## Note on what this review could not do

The five gates, the e2e run, `npm run issues`, and S3.4's three live (c)
branches are all runtime claims. This review ran nothing, by instruction, so
those are UNVERIFIED here and rest on `measurements/s6-post-fix.md` and
`s3-static-smoke.md`. Nothing I read statically contradicts any of them.
