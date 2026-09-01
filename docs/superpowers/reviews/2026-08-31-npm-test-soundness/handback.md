# M7 npm test soundness - handback

Date: 2026-09-01. Branch `feat/npm-test-soundness`, worktree
`W:\tmp\npm-test-soundness`. Base `5ce9912f`; ONE mainline sync `b4ba463a`
(main @ `1af02926`, tour-reminder Phase B; zero overlap with this mission's
files; no dependency changes).

**MERGE-READY. Gates ran on `b4ba463a`; docs-only commits follow it (S7
registry edits + this handback), final tip = the handback commit. 0 behind
main at handback time. UNMERGED (human gate). NO infra / NO post-merge ops
owed.**

## Verdict per work-map item

| item | verdict |
|---|---|
| S0 contended baseline | SHIPPED - 3 runs at `5ce9912f` (580/452/463s, EXIT 0, 0 failing files), snapshots both ends, registry listed with all three filters reproduced, never pruned (`measurements/s0-baseline.md`) |
| S4 groupCrossCheck solo x10 | SHIPPED - 10/10 green (13.4-22.9s), file NOT edited; neither arm failed, so the anchor strike is the deliverable (`measurements/s4-groupcrosscheck.md`) |
| S1 retry + acceptance suite | SHIPPED - `dynamoAdmin.ts` control-plane retry (fail-closed local gate, verification hooks, per-send 20s deadline), `db-update-gsis.ts` refactored onto it, **22-case** suite (plan's 17 + 5 from review), red-first proven 11/17 (`s1-retry.md`) |
| S2 logCallSiteGuard | SHIPPED AS MEASUREMENT - the 196.2s premise did not reproduce (6.5s hook, 27x headroom; 31.5s worst loaded); comments-only diff; no cut (the pre-committed `:97` hoist measured 4ms) (`measurements/s2-guard-cost.md`) |
| S3 staticSmoke split | SHIPPED - 9 `it`s -> 12, eleven can never skip, (c) PASS-or-SKIP only, all three branches observed live; issue `built-dashboard-identity-tags-unasserted` filed before the SKIP string (`s3-static-smoke.md`) |
| S5 clean-key + TTL probe | SHIPPED - 4 interleaved arms at `09d624e9`; recipe superseded ON THE CODE READING (`accessKeyForTestFile:120`); TTL probe DECISIVE: flag-unset arm ENABLED `expires_at` on `hc-local-messages`, flag-set DISABLED, control DISABLED both (`measurements/s5-clean-key.md`) |
| S6 sync + gates + post-fix runs | SHIPPED - below |
| S7 registry | SHIPPED - two mediums resolved, anchor updated and OPEN, TTL issue filed, recipe superseded in AGENTS.md + anchor + _CLUSTERS.md, `npm run issues` clean for every touched file (one pre-existing unrelated warning) |
| S8 handback | this file |

## Gates - all on `b4ba463a`, bare, from the worktree

| gate | exit | evidence (quoted) |
|---|---|---|
| 1 `npm run typecheck` | **0** | all five workspaces (re-run from a pwd-verified shell after a cwd-reset incident; see s6-post-fix.md) |
| 2 `npm test` x3 | **0, 0, 0** | 238/223/254s; app `349 passed (349)` files, `6436 passed (6436)` tests, 0 skipped; dashboard 183/2871; e2e 19/492; fake-twilio 34/240; fake-twilio-web 13/111; 0 failing files any run |
| 3 `npm run smoke` | **0** | `smoke-dist: OK - 1365 import specifier(s) across 239 emitted file(s) resolve under plain Node.` |
| 4 `npm run e2e` | **0** | `262 passed (20.9m)`, wall 1255s under a hard 1500s cap, lane 11, no orphaned listeners |
| 5 `npx eslint <6 touched .ts files>` | **0** | zero errors reported; merge-base baseline also clean, so nothing to attribute |

Nothing flaked; no re-runs were needed beyond the three gate-2 runs the plan
itself required.

## Review: 3 rounds, 2 fix waves, 32 findings, 0 outstanding must-fix

- R1 (conformance + PLAN-BLIND adversarial): 1 blocker (the branch's own
  acceptance suite tripped `dynamoAccessKeyGuard` - gate 2 was red), 2
  must-fix (ungated `deleteTableIfExists` tolerance; traversal probes made
  unfalsifiable by the temp fixture), 4 should-fix, 11 notes.
- Wave 1 fixed 10 accepted findings; R2 then found **1 new must-fix in wave-1's
  own code** (the new retry deadline pre-empted the verification hook - the
  exact defect class the plan's watch item predicted), plus 6 should-fix/notes.
- Wave 2 fixed those; R3: both reviewers "NO REMAINING MUST-FIX"; the last two
  comment-level notes folded in at `09d624e9`.
- All adjudications with reasons: `code-review/r1-adjudications.md`,
  `r2-adjudications.md`; reviewers re-ran their own reproductions to verify
  closures (guard red->green; ungated tolerance repro flipped; leaky-layer
  4/6 vs 0/6).

**One deliberate, recorded SPEC DEVIATION (human should know):** spec v4/v5
says "No decoys" in staticSmoke. The plan-blind reviewer PROVED the six
traversal probes were unfalsifiable without a target (a hand-rolled leaky
static layer passed all six under the temp fixture, failed 4/6 when a target
existed). Decoys now live INSIDE the mkdtemp root at exactly the probed
depths, nothing is ever written outside it, and the comment states what the
probes can and cannot see (4/6 falsifiable on Windows, 3/6 on Linux - the
`..%5c` target is Windows-only; `/etc/passwd` stays a shape probe). Both
reviewers upheld the deviation; the spec carries a supersession note for the
related fixture-marker change (C1) but its "No decoys" section is
deliberately left as history - r1-adjudications A3 is the record.

## Issue closures - what each claims, on what evidence

- `logcallsiteguard-hook-budget-equals-its-own-cost` -> **resolved**: premise
  unreproducible (6.5s hook vs 196.2s recorded; 27x headroom; invariant
  holds); budget UNCHANGED and deliberately not lowered; no cut made; the RPC
  fault named in the issue is credited to `maxWorkers: 4`, not to this work.
- `static-smoke-fails-on-stale-dashboard-dist` -> **resolved**: structural
  split, not the suggested mtime predicate (git defeats it); all three
  diagnostic branches observed live.
- `npm-test-dynamodb-local-contention` (anchor) -> **stays OPEN, as the spec
  predicted**: the retry landed but no sighting occurred to prove cured, and
  the S0/S6 pair is contended-vs-quiet, which the protocol forbids using to
  close. Suite A's latency remedy STRUCK narrowly (13 green runs; caveats
  named in the strike text). Reopen condition unchanged.
- NEW: `built-dashboard-identity-tags-unasserted` (S3's honest cost),
  `globalsetup-reenables-ttl-on-shared-tables` (filed on the S5 probe's
  ENABLED/DISABLED contrast).
- Recipe superseded in ALL THREE files: `AGENTS.md`, the anchor's
  first-diagnostic block, `_CLUSTERS.md` M7 (both `:231` row and the
  clean-key advice).

## Open items for the human (none blocking merge)

1. **A6 (declined design change):** `CreateTable` has no verification hook,
   so a create that lands while every response is lost (4x `InternalFailure`)
   still fails; the deadline slightly narrows the window in which the
   `ResourceInUseException` recovery can trigger. A one-row design change if
   ever wanted; contradicts a plan table eight rounds ratified, so left to
   you. (With A8: that path also reports `'exists'` for a table it created.)
2. **S2's two returned decisions:** `ts.createProgram` dominates the guard
   (75% of a 6.5s hook) and `isErrorTyped.getTypeAtLocation` is 11% - no
   pre-committed remedy for either; nothing needs doing at 27x headroom.
3. **Two enumeration hits the spec's disposition rule never reaches** (S1.0,
   recorded not changed): `unreadIndexRepo.integration.test.ts:729` (SDK
   waiter beside the CreateTable the plan forbids touching) and
   `scripts/wipe-dev-data.mjs:170` (root script, ambient human dev env).
4. **Known sharp edge (declined by design):** `dynamoAccessKeyGuard` walks
   `app/test` on disk, so any untracked scratch `*.test.ts` naming
   `ensureTable` reds gate 2 - it did so twice during review, correctly.
   Gate 2 needs a scratch-free tree.
5. The container was restarted mid-mission by someone outside it (recorded as
   a measurement confound; no action needed).

## Commits / delta

Code commits: `de7288e8` (S1), `30642595` (S2), `a9b7124d` (S3), `43641296`
+ `1bdb5f34` + `b81ceb23` (wave 1), `0eaa20a3` (wave 2), `09d624e9` (r3
comment notes). Sync: `b4ba463a`. Everything else is committed records (S0/S4
/S5/S6 measurements, three review rounds, adjudications, fix-wave records).
Net vs base over `app/` + `AGENTS.md` + `docs/issues/`: 62 files, +7593/-974
(the bulk is the 22-case suite, the staticSmoke rewrite, and issue text).

Self-QA note: this mission has no UI surface; the "live" layer here is the
harness itself, exercised by the gates and by S5's probe run against the real
container. The e2e gate (262 passed) is the live Playwright result.

**MERGE-READY @ the handback commit (parent `6ba4af3d`) on
`feat/npm-test-soundness` (`W:\tmp\npm-test-soundness`), 0 behind main
(`1af02926`), UNMERGED (human gate). No infra, no deploys, no post-merge ops.
Worktree left at the final commit; cleanup only on your explicit go.**

---

# Addendum: planner-review fix wave (2026-09-01, same day)

The planner's independent review (reports `code-review/planner-conformance.md`
and `planner-adversarial.md`; five gates independently re-run green on
`91c831d6`) returned 12 findings and no rejection. All adjudicated in
`code-review/planner-fix-wave-adjudications.md` (committed as produced): 11
accepted (2 reshaped), 1 partial, with two explicit declines - `maxAttempts`
on the local client (runtime code outside the mission's one permitted runtime
file, and it would change every local data-plane send) and a `cause` in
`indexStatus` (fail-open by design; nothing surfaces to carry one).

Landed as `6b4d712e` (code), `51dc753d` (docs), `2fdb0dd8` (record; full
detail in `code-review/planner-fix-wave.md`):

- **[1 HIGH]** the retried-tolerated `DeleteTable` conflict now WAITS - a new
  exported `pollUntilTableGone` (backoff, 10s ceiling, `TableNotGoneError`
  with the last read error as `cause`) runs on that path only, rethrowing the
  original conflict with the observed status on exhaustion; the un-retried
  path is byte-identical to main. Cases 23/24 pin both directions (red-first).
- **[2 MED]** the verification hook now runs once per failed attempt
  INCLUDING the final (a mutation landing on attempt 4 is no longer reported
  failed); the endpoint gate stays ahead of it, so cases 11/12's
  zero-extra-sends property holds. Case 10 updated; case 25 pins the
  final-attempt recovery (red-first). This is a recorded, planner-directed
  deviation from the plan's ratified "never on the final attempt" row.
- **[3 MED]** both polls back off (base doubling, capped 8x; ~16 reads per
  10s instead of ~100); ceilings unchanged.
- **[4/6/7 HIGH+MED]** the three self-contradicting texts corrected:
  `AGENTS.md` now says the explicit-key arm was in fact slightly FASTER
  (189/165s vs 231/190s, tracking a declining neighbour); the TTL-legs
  comment now matches our own probe (workers skip, globalSetup runs); the
  900s ceiling is attributed to `1448b130`, not "the same diff".
- **[5 HIGH]** the unverifiable SDK-retry claim NARROWED to the proven
  history (the faults escaped to callers); the possible 3x nesting under the
  SDK's transient retry (HTTP 5xx) is stated as UNKNOWN, the deadline
  arithmetic carries it (~30s worst per attempt), `DEFAULT_DEADLINE_MS`
  unchanged, and the anchor issue now instructs the next sighting to record
  `$metadata.httpStatusCode` / `$metadata.attempts`.
- **[8/9 MED]** the 31.5s "worst loaded" figure is now COMMITTED
  (`measurements/s2-guard-cost.md` addendum quoting the four S0 per-file
  lines), and the decoy deviation is marked in both places a reader lands
  (the spec's "No traversal decoys" paragraph and the S3 record).
- **[10/11/12 LOW]** the (c) diagnostic's unreachable loops removed (the
  guard is the assertion); case 21 reshaped fully deterministic (exactly 2
  sends); swallowed hook/poll errors now travel as `cause`; the three U+2713
  in `plan-r3-reviewer-c.md` are ASCII.

Gates re-run BARE on `2fdb0dd8` (quiet, scratch-free tree): gate 1 exit 0;
gate 2 exit 0 (app `349 passed (349)` files, `6439 passed (6439)` tests - +3
for the new acceptance cases - dashboard 2871, e2e 492, fake-twilio 240,
fake-twilio-web 111; wall 309s; zero failing files); gate 3 exit 0
(`smoke-dist: OK`); gate 5 exit 0 on the same six touched files. Gate 4 NOT
re-run, per the planner's stated exemption: no file outside `app/test/**`,
`app/src/lib/dynamoAdmin.ts` and `.md` documentation changed in this wave.
The acceptance suite is now 25 cases.

Open items carried forward unchanged, plus one: SDK attempt-nesting remains
unverified (declined `maxAttempts` change) - the anchor issue tells the next
sighting exactly which two fields settle it.

**MERGE-READY @ the addendum commit (parent `2fdb0dd8`) on
`feat/npm-test-soundness`, UNMERGED (human gate). Gates 1/2/3/5 green on
`2fdb0dd8`; gate 4 green on `b4ba463a` and exempt for this wave. No infra, no
post-merge ops. Cleanup only on your explicit go.**
