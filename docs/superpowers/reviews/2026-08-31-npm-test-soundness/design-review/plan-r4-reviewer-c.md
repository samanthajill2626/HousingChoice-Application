# Plan review R4 - reviewer C (adversarial, HARD CAP)

- Plan: `docs/superpowers/plans/2026-09-01-npm-test-soundness.md` (v4, `71826349`)
- Held: rounds 1-3 (mine and reviewer D's), all three adjudication files.
- Read-only. `node_modules` still absent, so SDK and `send` internals stay
  **UNVERIFIED**. No suite, npm script or Docker command was run; no file edited.

## Verdict: (B) NOT TERMINAL - and NOTHING needs a human

One finding is above precision. It is not a wording item: executed literally,
S5's probe most likely returns a FALSE NEGATIVE, and the plan's own escape
hatch then kills a true issue and writes a wrong finding into the handback.
That is the **fourth consecutive round in which a fix introduced a defect of the
class it closed**, and it is on the same probe as round 3's.

But the coordinator's (B) branch asks which findings need a person rather than
another round. **The answer is none of them.** All six below are mechanical
edits to the plan document. None reopens a decision, none requires judgment, and
every fact that settles them is in the repository and cited below. There is
nothing here for the human to arbitrate.

Because this is the cap, I have written the **exact replacement text** for the
three items above LOW, so the planner can apply them without a further review
pass. That is the right disposition: apply the clauses, hand the plan over, do
not escalate.

**The two deletions were both correct.** Details in "Checked and sound"; the
gate removal is right for a reason stronger than the one the plan gives.

---

## 1. [HIGH] S5's probe does not name the table it describes, and only 4 of 22 specs carry a TTL attribute - the likeliest pick reports DISABLED in BOTH arms

**What is wrong.** S5 step 2: "`DescribeTimeToLive` on one of the tables it
created and record the status." Most tables cannot report ENABLED under any
conditions, because `enableTtlIfNeeded` is never called for them.

**Evidence.**

- `app/src/lib/dynamoAdmin.ts:117` -
  `if (spec.ttlAttribute && !ttlDisabled) await enableTtlIfNeeded(...)`. No
  `ttlAttribute` on the spec means the function is never reached and TTL stays
  `DISABLED` on a fresh table regardless of the flag.
- `app/src/lib/tables.ts` declares **22 specs**
  (`grep -c "baseName: '"` = 22) and exactly **four** carry `ttlAttribute`:
  `messages` (`:231`), `matches` (`:246`), `unmatched_email` (`:615`),
  `ai_runs` (`:648`). The remaining 18 - `contacts`, `units`, `conversations`,
  `placements`, `invoices`, `users`, `audit_events`, `settings`,
  `pool_numbers`, `broadcasts`, `activity_events`, `listing_sends`,
  `tourReminders`, `placementNudges`, `placementDeadlines`,
  `pendingRosterActions`, `tours`, `ai_extraction` - have none.
- The most natural reading of "one of the tables it created" picks the first
  spec, `contacts` (`tables.ts:78`), which has no TTL attribute.

**Why this is not merely imprecise.** Plan lines 606-608: "**If the probe shows
TTL is NOT enabled, the claim is wrong, the issue is not filed, and that is a
finding for the handback.**" That escape hatch was added in round 2 for the
right reason - so the issue could not be filed on an inference. With an
arbitrary table it fires on a measurement artefact: arm 1 reports DISABLED not
because `globalSetup` failed to enable the reaper but because that table has no
reaper to enable. The mission then deletes a TRUE Tier-2 issue and records in
the handback that its own established claim was disproved.

Round 3's version of this probe produced a false POSITIVE (both arms ENABLED).
This one produces a false NEGATIVE (both arms DISABLED). Same probe, same slice,
opposite direction, fourth round running.

**Exact fix.** Replace step 2 with:

> 2. `DescribeTimeToLive` on **`hc-local-messages`** - it must be a spec that
>    carries `ttlAttribute`, because `dynamoAdmin.ts:117` guards
>    `enableTtlIfNeeded` on exactly that field and only 4 of the 22 specs in
>    `tables.ts` have one (`messages` `:231`, `matches` `:246`,
>    `unmatched_email` `:615`, `ai_runs` `:648`). Any other table reports
>    DISABLED in BOTH arms and the contrast is meaningless in the opposite
>    direction to step 3's.

Add to step 4: "expect **DISABLED** on this same table - that is the real
contrast."

---

## 2. [MEDIUM] The liveness fix transcribed one of `otherLiveRuns`'s two filters, and the missing one fails in the same direction as the bug it replaced

**What is wrong.** S0 step 3 now says to "check each one's liveness yourself -
the filename IS the pid". That is the pid half. `otherLiveRuns` applies two
independent filters, and the second exists precisely for the case a bare
`kill(pid, 0)` gets wrong.

**Evidence.** `app/test/helpers/testRunRegistry.ts:93-122`:

- `:104` `if (!/^\d+$/.test(name)) continue;` - non-numeric entries are not
  markers. The directory is machine-global, so a stray file counts as a
  neighbour under a plain listing.
- `:110-112` `expired = nowMs - statSync(...).mtimeMs > MARKER_BACKSTOP_MS`,
  with `MARKER_BACKSTOP_MS = 6h` (`:48`).
- `:115` a marker counts live only when `!expired && pidAlive(pid)` - **both**.
- The docblock at `:42-47` states why the backstop exists: "Backstop for a
  marker whose dead pid the OS recycled onto an unrelated process: no vitest run
  lasts anywhere near this long, so an older marker is treated as dead no matter
  what `kill(0)` says."

**What it implies.** A recycled pid makes a corpse answer `kill(pid, 0)`
successfully, so the pid-only check counts it live - over-counting, which is the
exact direction round 3's finding was about: a QUIET S6 arm labelled CONTENDED
makes a contended-vs-quiet pair look matched, and the anchor's one use
restriction never fires. The registry directory is `os.tmpdir()/hc-vitest-runs`
(`:41`), which survives reboots while pids reset, so recycling is a live
possibility on this box - and the plan forbids the only code that prunes, so
markers accumulate across this mission's ~12 full runs.

**Exact fix.** Append to the bullet:

> Reproduce BOTH of `otherLiveRuns`'s filters, not just the pid one: skip any
> filename that is not all digits (`:104`), and treat a marker whose mtime is
> older than `MARKER_BACKSTOP_MS` (6h, `:48`) as dead even if `kill(pid, 0)`
> succeeds (`:110-115`) - that backstop exists for a pid the OS recycled onto an
> unrelated process (`:42-47`), which is the one case the pid check gets wrong,
> and it gets it wrong in the over-counting direction. Record the raw marker
> count and the live count separately.

---

## 3. [MEDIUM] The exported poll's exhaustion contract contradicts the signature the plan shows for it

**What is wrong.** Two statements in S1.3 cannot both hold.

**Evidence.**

- Line 285 shows the call site: `if (retried) await pollUntilActive(client, physicalName);`
  - two arguments, no error.
- Lines 291-292 specify the exhaustion behaviour: "On exhaustion rethrow the
  original `ResourceInUseException` with the observed status." With that
  signature the poll has never seen that exception - it lives in `ensureTable`'s
  catch at `dynamoAdmin.ts:91`.
- Case 17 (line 199) calls the poll **directly** and asserts it "throws at the
  ceiling carrying the observed status", naming no error type - so the case
  cannot distinguish the two resolutions either.

A builder must either pass the original error into the poll (a third parameter
the shown code does not have) or throw a different class and let it propagate,
which is not what the plan says. Neither is wrong on its own; the plan asserts
both.

Still unstated after four rounds, and part of the same clause: whether "with the
observed status" means mutating the SDK exception instance's `message` or
constructing a fresh `ResourceInUseException` (which requires a `$metadata`
argument). Nothing downstream does `instanceof` on it, so the consequence is
legibility rather than correctness - but the plan chose to specify the error
class, and as written it cannot be honoured.

**Exact fix.** Replace the exhaustion clause with:

> On exhaustion throw. The poll takes the original error so it can preserve the
> class: `pollUntilActive(client, name, { cause, pollMs, ceilingMs })`, and on
> exhaustion it rethrows `cause` with the last observed status appended to its
> `message`. Case 17 supplies a `ResourceInUseException` as `cause` and asserts
> both the class and the status text.

and update the code block at line 285 to pass `err` as `cause`.

---

## 4. [LOW] S7.2's item 2 was retitled but not converted to a back-reference, and nothing checks the shipped slug against the filed filename

The heading (line 678) now reads "file the ONE remaining new issue" and the note
below it says the built-dashboard issue "was already filed in S3.3 ... Do not
file it again here." But the numbered list still carries item 2 (lines 691-694)
in its original imperative form - "Name the remedy ... and its cost" - so the
section says ONE and lists TWO. Make item 2 a back-reference in the imperative
that is actually left: "Filed in S3.3. Verify the slug in the shipped SKIP
string (`staticSmoke.test.ts`) matches the filename under `docs/issues/`."

That verification is the part with real value and it is currently nowhere: S3.3
writes a slug into a shipped test message and S3 creates the file; no step
confirms the two agree, and `npm run issues` (S7.4) will not notice a message
pointing at a slug that does not exist.

---

## 5. [LOW] The stub contract still ends with the bullet the new one supersedes

Line 165-167 adds "**counters must distinguish SENDS from HOOK CALLS.** ...
per-command send counters cannot express" it. Line 179 still lists
"per-command call counters" as a plain requirement. The superseded bullet was
not removed - the same add-without-remove shape as findings 4 and 8 of round 3.
Delete line 179 or fold it into the new bullet.

---

## 6. [LOW] The tautology watch item was not updated, though the round-2 adjudication recorded that it was

`plan-adjudications-r2.md:63` states "This is the fourth tautology found in this
document's history; **the pattern is now explicit in the watch items**." The
watch item (plan lines 740-743) is unchanged from v1: it still says "three
revisions running" and names only the traversal decoy and its replacement.
Neither the `HousingChoice` fixture tautology (round 3 finding 14) nor case 6's
zero-send near-miss (round 3 finding 4) is there. Changes nothing - noting it
because an adjudication that records an edit which did not happen is the same
bookkeeping failure the mission is cleaning up elsewhere.

---

## The two deletions - both correct

The coordinator flagged these as where to look first. I looked, and neither is a
finding.

**Deleting the poll's endpoint gate (lines 295-299) is right, and for a stronger
reason than the plan gives.** The plan's argument is that the gate would be dead
code reached only when `retried` is true, which is true of the internal path.
The stronger reason is that the poll issues `DescribeTable` - a READ - and the
spec's own disposition rule (item 1A, "The control-plane surface") already
excludes reads from coverage and from gating: "READS (`DescribeTable`,
`ListTables`, `DescribeTimeToLive`) are NOT covered on their own." Gating this
one read and no other would have been the inconsistency, not the omission. The
export widens the callable surface, but `dynamoAdmin.ts:1-6` states the whole
module is "LOCAL/DEV tooling only ... Nothing in the app's request path calls
these", and a bounded 10s read loop is not a mutation. The watch item at lines
734-736 remains accurate because it speaks about the RETRY, which is still
gated. Nothing here reads as a live safeguard that is not one.

**Narrowing "restructure both describes" to the first (lines 460-467) is right,
and I verified the closure argument the narrowing depends on.** Describe 1
(`staticSmoke.test.ts:28-36`) builds its app in the describe BODY at `:29`, so
it must move into a `beforeAll`. Describe 2 (`:177-215`) defines `buildWith` at
`:178-187` and only CALLS it inside each `it` (`:190`, `:205`), so its reference
to `distDir` at `:182` is captured by closure and resolved at test time - after
a file-scoped `beforeAll` has assigned it. The narrowing is therefore not just
less work, it is correct: restructuring describe 2 would have been churn on
working code.

## Other round-3 accepts, implemented in substance

Checked one by one, not by presence of text.

- **Case 6's guard note (line 188) is placed exactly where it is needed and
  nowhere else.** Cases 5, 7 and 10 also reach `UpdateTimeToLive` only through
  the `DescribeTimeToLive` guard at `dynamoAdmin.ts:131`, but each of those
  asserts something about `UpdateTimeToLive` sends, so a guard that
  short-circuits makes them fail loudly. Only case 6 - "returns WITHOUT
  re-sending" - could have passed at zero sends. Putting the warning on 6 alone
  is the correct call, not an omission.
- **Hook-vs-send counters** (line 165-167): stated, and it is the requirement
  case 10 actually needs.
- **`:106`'s destination in S2.2** (lines 388-392): correct, including the
  observation that the call is already inside `!legal &&`
  (`logCallSiteGuard.test.ts:105-106`) so there is no ordering win - verified.
- **S5 probe drop between arms** (lines 591-596), with the mechanism written
  into the plan so a shortened script cannot lose it. `dynamoAdmin.ts:116-119`
  is cited correctly.
- **S5 probe sequenced after the four runs, script to `.superpowers/sdd/`**
  (lines 601-604).
- **Literal-`<slug>` guardrail restored** (lines 520-521).
- **S3 table row reconciled with S3.1** (line 446).
- **Predicate wording reconciled with its export** (lines 253-255).
- **`globalSetup.ts:214`** (line 574) - correct; `dropKeyedLocalTables()` is at
  `:214` and `globalTeardown.ts:279` is `await dropAllTables(endpoint)`.

## Still sound, re-confirmed across rounds

- The `onRetry` seam is concurrency-correct and case 2 pins its firing point
  (an "after a successful re-send" reading fails case 2, whose re-send throws
  `ResourceInUseException`).
- The two-function split fits all five sends; only `DescribeTimeToLive` consumes
  output (`dynamoAdmin.ts:128-130`) and it takes no hook.
- Case 10's arithmetic matches `db-update-gsis.ts:110-126` exactly: 4 sends,
  3 hook calls, bound checked at `:117` before the read at `:121`.
- S7.3's three files are the complete set of clean-key recipe sites
  (`AGENTS.md:156`, `npm-test-dynamodb-local-contention.md:103`,
  `_CLUSTERS.md:236`).
- Docs-after-gates is safe: no test reads a `.md` from disk,
  `scripts/issues.mjs:88` writes only the gitignored `docs/issues/INDEX.md`
  (`.gitignore:62`), gate 5's extension filter excludes `.md`, and S3.3's slug
  no longer depends on S7.
- Every spec decision and all seven spec deliverables still map to a slice; the
  two Tier-2 issues are now split across S3.3 and S7.2 and still total two.

## Disposition, given the cap

Apply findings 1, 2 and 3 as the replacement text above; apply 4, 5 and 6 or
don't - they change nothing. Then the plan is done. I would not spend a fifth
round on it, and there is nothing in it to put to the human.

## Scope check

Nothing above proposes work the spec's non-goals exclude. Findings 1 and 2
correct measurement procedure; 3 resolves a self-contradiction in code the plan
already mandates; 4, 5 and 6 are document hygiene.
