# Plan review R3 - reviewer C (adversarial)

- Plan: `docs/superpowers/plans/2026-09-01-npm-test-soundness.md` (v3, `0253a0a7`)
- Held: rounds 1 and 2 (mine and reviewer D's), both adjudication files.
- Read-only. `node_modules` still absent, so SDK internals stay **UNVERIFIED**.
  No suite, script, npm command or Docker command was run; no file edited.

## Verdict: (B) NOT TERMINAL - but only just, and nothing needs a human

Two findings are above LOW. Both are mechanical one-liners in text that v3
added, and neither reopens a decision or needs a human call:

- **S5's TTL probe now runs, but its second arm cannot produce a contrast.**
  Steps 1-3 never drop between arms, so `ensureTable` short-circuits on
  `ResourceInUseException` and skips `enableTtlIfNeeded` entirely under
  `DYNAMO_DISABLE_TTL=1` - leaving TTL ENABLED from arm 1. Both arms report
  ENABLED, and S7.2's first issue would be filed on a result that appears to
  prove something stronger and wronger than the truth. Round 2 replaced an
  unexecutable probe with an executable one that answers incorrectly. **Third
  instance of the running theme.**
- **The "list the markers, do not prune" instruction over-counts live
  neighbours**, and the mislabel runs in the one direction that matters: a
  QUIET S6 arm labelled CONTENDED makes a contended-vs-quiet pair look matched,
  which is exactly the bias the spec's use restriction exists to block.

Everything else this round is precision. If those two lines are fixed, I would
call the next revision terminal without another full pass.

**The two new code shapes are sound.** The `onRetry` seam and the two-function
split were the coordinator's stated concerns; I checked both against the code
and they hold - details in "Checked and sound" below. Case 10's arithmetic in
particular is now exactly calibrated to `db-update-gsis.ts:110-126`.

---

## 1. [HIGH] S5's TTL probe has no drop between arms, so step 3 reports ENABLED for the wrong reason

**What is wrong.** S5's probe:

```
1. call ensureKeyedLocalTables() where DYNAMO_DISABLE_TTL is UNSET
2. DescribeTimeToLive on one of the tables it created, record the status
3. repeat with DYNAMO_DISABLE_TTL=1 set in the process, for contrast
4. drop what you created (dropKeyedLocalTables)
```

Step 3 runs against the tables step 1 created. Nothing is dropped until step 4.

**Evidence.** `app/src/lib/dynamoAdmin.ts:86-119`:

- `:88` `CreateTable` on an existing table throws `ResourceInUseException`;
  `:91-92` swallows it and sets `result = 'exists'`.
- `:116` `const ttlDisabled = env['DYNAMO_DISABLE_TTL'] === '1';`
- `:117-119` `if (spec.ttlAttribute && !ttlDisabled) await enableTtlIfNeeded(...)`.

With the flag set, `enableTtlIfNeeded` is **skipped entirely** - it does not
disable anything, it declines to enable. So the TTL that step 1 turned on stays
on, and step 3's `DescribeTimeToLive` reports `ENABLED`.

`app/vitest.config.ts:103-110` already documents exactly this and calls it out
by name: "this flag does not DISABLE TTL, it declines to ENABLE it. On a table
that already has TTL on - from an earlier run under the same key - the reaper
keeps running ... the immunity is real for a fresh table and NOT retroactive."

**What it implies.** The probe returns ENABLED / ENABLED and reads as "the flag
does nothing, anywhere". That is false, and it is a STRONGER claim than the one
S7.2 item 1 is entitled to. The true claim is narrow and correct: `globalSetup`
runs outside `test.env`, so it enables the reaper on FRESH shared tables before
any test starts. Filing the issue on a two-ENABLED result would overstate it in
the register the mission exists to clean up - a confident number supporting a
wrong conclusion.

**Fix, two sentences.** Drop BETWEEN the arms, and say why:

```
1. ensureKeyedLocalTables() with DYNAMO_DISABLE_TTL unset
2. DescribeTimeToLive -> expect ENABLED
3. dropKeyedLocalTables()            <-- the arms must not share tables
4. ensureKeyedLocalTables() with DYNAMO_DISABLE_TTL=1
5. DescribeTimeToLive -> expect DISABLED on a FRESH table
6. dropKeyedLocalTables()
```

A freshly created DynamoDB Local table has TTL `DISABLED`, so step 5 is a real
contrast. Add the note that the flag is not retroactive, citing
`vitest.config.ts:103-110`, so the record cannot be misread later.

---

## 2. [HIGH] The marker-count instruction over-counts neighbours, and the mislabel points at the anchor's use restriction

**What is wrong.** S0 step 3: "**LIST the marker directory, do not prune it.**
... Count the marker files with a plain directory listing and say that is what
you did". A plain count is not the same measurement `otherLiveRuns()` makes, and
the difference is systematically upward.

**Evidence.** `app/test/helpers/testRunRegistry.ts`:

- `:66-67` - a marker's FILENAME is the pid: `path.join(dir, String(process.pid))`.
- `:78-81` - the unregister closure `rmSync`s the marker, and it is called as
  the LAST teardown step (`globalSetup.ts:218`). A run killed by Ctrl-C,
  SIGKILL, an agent teardown or a reboot never reaches it and **leaves its
  marker behind**.
- `:93-122` - `otherLiveRuns` counts a marker only when `!expired && pidAlive(pid)`:
  `pidAlive` is `process.kill(pid, 0)` (`:51-58`) and `expired` is
  `mtime > MARKER_BACKSTOP_MS` = 6h (`:48`). Everything else it PRUNES.
- Its own docblock: "Dead markers are pruned as they are found, so the directory
  stays bounded." The only pruner is a run that calls it - and the plan now
  correctly forbids this mission from calling it, so across this mission's ~12
  full runs the directory only accumulates.

**What it implies.** A stale marker makes a genuinely QUIET machine count as
CONTENDED. That is the dangerous direction. The spec's item 1D makes the label a
**use restriction, not a caveat**: "a contended-vs-quiet pair is biased toward
the fix by more than any effect it could measure. **A mixed pair may NOT be used
to close the anchor issue.**" S6 step 3 repeats it. If S6's arm is really quiet
but three dead markers say otherwise, the pair reads as contended-vs-contended,
the restriction never fires, and the anchor can be closed on precisely the
comparison the spec forbids.

**Fix.** The marker name IS the pid, so liveness is available read-only and
without touching the directory: for each all-digit filename, `process.kill(pid, 0)`
(or `Get-Process -Id` in PowerShell) plus an mtime-age check against the 6h
backstop. Count only markers that pass both, and record the raw count and the
live count separately so a later reader can see the difference. That reproduces
`otherLiveRuns`'s arithmetic exactly while writing nothing.

---

## 3. [MEDIUM] S7.2 still says "file two NEW issues" and lists the one S3.3 now files

**What is wrong.** S3.3 (lines 503-510) moves the built-dashboard issue into S3:
"**S7.2's SECOND issue (the built-dashboard coverage gap) is FILED HERE, in S3,
not in S7.**" S7.2's heading (line 647) still reads "**file two NEW issues**" and
its numbered item 2 is that same issue, with no note that it has already been
filed.

**What it implies.** A builder working S7 from S7.2 alone copies
`_TEMPLATE.md` a second time and produces a duplicate registry entry, which
`npm run issues` (S7.4) will then index twice. Retitle S7.2 to "file the
remaining NEW issue" and leave item 2 as a back-reference: "filed in S3 - see
S3.3; confirm the slug in the shipped SKIP string matches the filename."

---

## 4. [MEDIUM] Every TTL case reaches `UpdateTimeToLive` only through the pre-send guard, and per-command counters cannot express "hook called N times"

**What is wrong.** Cases 5, 6, 7, 9 and 10 all drive `UpdateTimeToLive`, and
three of them assert HOOK CALL COUNTS. The stub contract offers "per-command
call counters". For TTL, the hook IS a `DescribeTimeToLive` - the same command
as the pre-send guard - so a per-command counter conflates them.

**Evidence.** `app/src/lib/dynamoAdmin.ts:123-138`:

- `:128-130` sends `DescribeTimeToLiveCommand` BEFORE anything else;
- `:131` `if (ttl?.TimeToLiveStatus === 'ENABLED' || 'ENABLING') return;` -
  it returns without ever sending `UpdateTimeToLive`;
- `:132-137` only then sends `UpdateTimeToLive`.

Two consequences:

- **Case 6 can pass with ZERO `UpdateTimeToLive` sends.** Its stub must make the
  re-read report `ENABLED`. If the stub answers `ENABLED` uniformly, the guard
  at `:131` returns and `UpdateTimeToLive` is never sent at all - so "helper
  returns WITHOUT re-sending" is trivially true, the helper is never involved,
  and the case that exists to stop an always-`false` hook shipping
  (*"Without this, a hook that always returns `false` passes every other
  case"*) proves nothing. This would be the fifth tautology in this document's
  history. The pre-send read must be scripted NOT-enabled and the assertion must
  be `UpdateTimeToLive` sent **exactly once**, not "not re-sent".
- **The hook counts are off by one against a per-command counter.** Case 5's
  "hook called once" is 2 `DescribeTimeToLive` sends (guard + hook); case 10's
  "hook called 3 times" is 4. Specify a distinct hook counter (the stub can wrap
  the `verify` callback), or state the +1 explicitly.

---

## 5. [MEDIUM] The poll's endpoint gate is unreachable through `ensureTable`, and case 17 does not say what endpoint the direct call gets

**What is wrong.** S1.3 requires the poll to be "gated on the local endpoint
like the retry". But the poll now runs only when `retried` is true, and `retried`
can only be true if the retry already resolved the endpoint as LOCAL. Through
`ensureTable` the gate is dead code.

Case 17 is the only caller that can reach it: "the exported poll directly,
injected interval/ceiling, never ACTIVE | throws at the ceiling carrying the
observed status". It says nothing about the endpoint the stub exposes.

**What it implies.** If the builder implements the gate and case 17's stub has a
non-local or absent endpoint provider, the poll refuses instead of polling and
case 17 fails - or worse, the builder makes the gate's non-local branch
"return quietly", case 17 passes for the wrong reason, and the exhaustion path
is never exercised. The plan also never states what the gate DOES on a non-local
endpoint (skip the poll? throw?).

**Fix.** Either drop the poll's gate as redundant and say why (`retried` implies
local), or keep it, state the non-local behaviour, and give case 17 a local
endpoint explicitly.

---

## 6. [MEDIUM] S5's probe mutates and then drops this worktree's shared tables, with no sequencing against S5's own four full runs

**What is wrong.** The probe calls `ensureKeyedLocalTables()` and
`dropKeyedLocalTables()`. S5 also runs four full app-suite runs (2 arms x 2
runs). The plan says only "Also run the TTL probe here."

**Evidence.** `app/test/globalTeardown.ts:234-300` - `dropKeyedLocalTables` with
no `key` option resolves to `testAccessKeyId()` (`:260`) and drops every
`hc-local-` table under the worktree key via `dropAllTables` (`:279`). Those are
the shared tables the `SHARED_LOCAL_TABLES_MARKER` suites use. The plan is right
that the worktree key is private to this worktree
(`globalTeardown.ts:283-285`), so neighbours are safe - but this worktree's own
concurrent run is not.

**What it implies.** One sentence: run the probe with NO vitest run live in this
worktree, before the first arm or after the last, and say which. The repo
already forbids two simultaneous runs in one worktree; the probe is a third
writer that the rule does not obviously cover.

---

## 7. [LOW] v3 dropped v2's ban on shipping a literal `<slug>`, while still quoting a message that contains one

v2 line 422 carried "**A literal `<slug>` must not reach the shipped string.**"
v3 quotes the message as "...see `docs/issues/<slug>`" (line 501) and that
sentence is gone; the following paragraph implies it without saying it. The
ordering fix removed the guard it was paired with. Restore the sentence, or
better, put the actual slug in the quoted message now that S3 files the issue.

---

## 8. [LOW] The S3 assignment table still routes `HousingChoice` to (a) after S3.1 replaced it with a marker

Line 429: "`:38` | serves index.html at / | **SPLIT** - status/content-type/`HousingChoice`
to (a)". Line 453-458 then says the `HousingChoice` assertion "becomes a
TAUTOLOGY once we write the fixture ourselves" and must be replaced by a
distinctive marker. The table row should read "status/content-type/fixture
marker to (a)", or a builder working from the table ships the tautology the
prose just removed.

---

## 9. [LOW] "restructure both describes accordingly" over-prescribes - the second one is already correct

S3.1 says the file "constructs the app in the DESCRIBE BODY at collection time
(`:29`) ... restructure both describes accordingly." That is true of the first
describe only. The second (`staticSmoke.test.ts:177-215`) defines `buildWith` at
`:178-187` and calls it INSIDE each `it` (`:190`, `:205`), so it already builds
lazily; all it needs is that the file-scoped `distDir` is assigned before its
tests run. Say "restructure the FIRST describe; the second already builds per
test and needs only the shared `distDir`", so the builder does not churn working
code.

---

## 10. [LOW] S1.2 says the predicate is "local to `dynamoAdmin.ts`" 44 lines after saying it is EXPORTED

Line 202-204: "**The endpoint predicate is EXPORTED**, so case 13 can reach it".
Line 246-248: "The predicate is local to `dynamoAdmin.ts`; `lib` must not import
from `scripts`." The second bullet means "defined in that module, not imported
from `scripts`" and is not actually a contradiction - but "local" against
"EXPORTED" is the wrong word for a document a builder scans. Reword the later
bullet to "defined in `dynamoAdmin.ts` (exported for case 13); `lib` must not
import from `scripts`", and it stops reading as a conflict.

---

## 11. [LOW] S2.1 now measures three checker sites; S2.2's decision tree still covers two

The instrumentation list is right - `:97`, `:106`, and `:79-80` including
`typeToString`. S2.2's branches are: `:97` is material (remedy pre-committed);
`isErrorTyped`'s `getTypeAtLocation` dominates (no remedy, return as a
decision); `buildProgram` dominates (no remedy, return as a decision). There is
no branch for `:106` `getSymbolAtLocation` dominating. The catch-all covers it
in spirit, but add `:106` to the second bullet by name so a measurement that
lands there has a stated destination.

---

## 12. [LOW] Two record-hygiene items

- `globalSetup.ts:216` (S5, line 554) is off by two: the returned teardown's
  `await dropKeyedLocalTables();` is at **`globalSetup.ts:214`**
  (`sweepPerFileResidue('globalTeardown')` is `:215`, `unregister()` is `:218`).
  The `globalTeardown.ts:279` half is correct. This citation came from my own R2
  report and I got it wrong there; correcting it here.
- The S5 probe is specified as "a throwaway script (not a committed test)". Its
  source is the only thing that makes the probe result reproducible, and the
  mission's own rule sends byte-exact material to `.superpowers/sdd/`. Say the
  script is preserved there and referenced from
  `<records>/measurements/s5-clean-key.md`.

---

## Checked this round and found SOUND

The coordinator asked specifically about the two places new code shapes entered
the plan. Both hold.

**The `onRetry` seam (S1.3).** Correct, and correctly pinned.

- The per-call local plus callback is concurrency-safe by construction, and the
  named trap is the right one: `ensureTable` is genuinely called concurrently
  (`app/test/todayUnmatchedNonRegression.test.ts:107`,
  `app/test/performanceSeed.integration.test.ts:247-248`).
- **Case 2 pins the firing point without anyone having to state it.** The other
  plausible reading - `onRetry` fires after a SUCCESSFUL re-send - would leave
  `retried` false in case 2 (whose re-send throws `ResourceInUseException`), so
  no poll, so case 2 fails. The correct reading (fire when a retryable error is
  caught and the bound permits a re-send) is the only one that passes. That is a
  well-constructed case.
- Case 3 is clean: `ResourceInUseException` is not retryable, so the helper
  throws before `onRetry`, `retried` stays false, no poll. `enableTtlIfNeeded`
  still runs afterwards but sends `DescribeTimeToLive`, not `DescribeTable`, so
  "ZERO `DescribeTable` calls" holds.
- Setting `result = 'exists'` before the poll is harmless: if `pollUntilActive`
  throws on exhaustion the throw propagates and the value is discarded.

**The two-function split (S1.2).** Compatible with all five sends, verified one
by one.

- `DescribeTimeToLive` is the only send whose output is consumed
  (`dynamoAdmin.ts:128-130`) and it is on `sendWithRetry` with no hook. OK
- `UpdateTimeToLive` (`:132-137`) and `ensureGsis`'s `UpdateTable`
  (`db-update-gsis.ts:227-233`) both discard their output, so
  `sendWithRetryVerified` returning `void` fits; today's
  `sendWithInternalFailureRetry` is already `Promise<void>`
  (`db-update-gsis.ts:103-109`) and `ensureGsis` discards it. OK
- `CreateTable` and `DeleteTable` discard output and take no hook. OK
- One implementation note, not a defect: `sendWithRetry<TOut>` with an
  unconstrained `TOut` will infer `unknown`, so the `DescribeTimeToLive` call
  site needs an explicit type argument (or the signature must take
  `Command<..., TOut, ...>`). Under `strict` + `noUncheckedIndexedAccess`
  (`tsconfig.base.json`) that is a one-token annotation, and gate 1 catches it
  immediately. **UNVERIFIED** against the exact SDK typings - `node_modules` is
  absent.

**Case 10's arithmetic is exactly right.** Against
`db-update-gsis.ts:110-126` with `attempts = 4`: attempts 1-3 fail, pass
`:117`'s bound check, and call the status read at `:121`; attempt 4 fails and
`4 >= 4` throws at `:117` before any read. That is 4 sends and 3 hook calls -
precisely what the case asserts, and it preserves today's behaviour rather than
quietly improving it.

**Other round-2 accepts implemented in substance:** the `ensureGsis` post-send
stub requirements now name `waitUntilTableExists` (`:234`) and
`waitUntilIndexActive` (`:235`, 900s at `:158`); the predicate is exported; the
backoff is injectable; cases 8 and 10 name their commands; the send/hook table
is complete and its stated hazard (a hook on `CreateTable` flipping `'exists'`
to `'created'`) is exactly right; S2.1's instrumentation targets the three real
checker sites and explicitly excludes `isCatchDeclared` (`:74-77`, no checker
work - confirmed); the S3 fixture is file-scoped; S6 names both confounds; S7.1
states the loaded-arm straddle where the strike is decided;
`RUN_REGISTRY_DIR` is named and both sweep modes are recorded.

**Still sound from earlier rounds, re-confirmed:** S7.3's three files are the
complete set (`grep -rn "hccleanrun001"` over tracked files returns exactly
`AGENTS.md:156`, `npm-test-dynamodb-local-contention.md:103`,
`_CLUSTERS.md:236`); no test reads a `.md` from disk and
`scripts/issues.mjs:88` writes only the gitignored `docs/issues/INDEX.md`
(`.gitignore:62`), so docs-after-gates is safe now that S3.3's slug no longer
depends on S7.

## Scope check

Nothing above proposes work the spec's non-goals exclude. Findings 1, 2 and 6
concern measurement procedure; 3, 7, 8, 9, 10, 11 and 12 are precision in text
v3 added; 4 and 5 tighten acceptance cases the plan already mandates.
