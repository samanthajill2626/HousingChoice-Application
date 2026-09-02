# Planner-review fix wave brief (M7)

Begin by using tools - do not reply until the work is committed.

Worktree `W:\tmp\npm-test-soundness`, branch `feat/npm-test-soundness`, tip
`5f224289` plus one adjudications commit landing before your dispatch. PIN THE
WORKTREE PATH: `cd W:\tmp\npm-test-soundness` (or `...\app`) explicitly in
EVERY shell command - two sessions have had a bare git command silently run
against the main checkout.

## Read first

1. `docs/superpowers/reviews/2026-08-31-npm-test-soundness/code-review/planner-fix-wave-adjudications.md`
   - BINDING. Every ACCEPT row is your work list; DECLINE/PARTIAL rows are
   final.
2. The two planner reports beside it (`planner-adversarial.md`,
   `planner-conformance.md`) for the findings' full reasoning and line cites.
3. `AGENTS.md` (repo rules), and the live files you will touch, in full:
   `app/src/lib/dynamoAdmin.ts`, `app/test/dynamoAdminRetry.test.ts`,
   `app/test/staticSmoke.test.ts`.

## Work, in order (TDD where a test can lead)

### W1 (finding 1, HIGH) - wait-until-gone on the retried-tolerated delete

- Cases 23 + 24 FIRST (style of case 4): 23 - local, `DeleteTable`
  `[InternalFailure, ResourceInUseException]`, `DescribeTable` scripted
  `[DELETING, DELETING, throw ResourceNotFoundException]`, tiny poll
  intervals -> `deleteTableIfExists` RESOLVES; assert 2 `DeleteTable` and 3
  `DescribeTable`. 24 - same but `DescribeTable` fallback always DELETING,
  tiny ceiling -> REJECTS with the ORIGINAL `ResourceInUseException`
  INSTANCE whose message contains the table name and `DELETING`, and is
  `instanceof ResourceInUseException`. Confirm both RED.
- Implement `pollUntilTableGone(client, physicalName, opts?)` exported beside
  `pollUntilTableActive`, same `PollOptions` seams and the SAME backoff you
  add in W3: `DescribeTable` until it throws `ResourceNotFoundException`
  (= gone -> return); any OTHER read failure counts as "maybe still there";
  a successful read records the observed `TableStatus`. On the ceiling throw
  a `TableNotGoneError` (name it that; fields `tableName`, `observedStatus`)
  - and in `deleteTableIfExists` call the poll ONLY on the
  `retried && ResourceInUseException` path, catching `TableNotGoneError` and
  rethrowing the ORIGINAL conflict with the poll's message appended (mirror
  `ensureTable`'s split exactly). The un-retried path stays byte-identical.
  Update the comment block to say the wait is what makes the tolerance safe
  for delete-then-create callers, naming `importApply.integration.test.ts`.
- `deleteTableIfExists` gains `poll?: PollOptions` in its opts.

### W2 (finding 2, MED) - verify on the final attempt

- Case 25 FIRST: local, TTL spec, `UpdateTimeToLive` always `InternalFailure`
  (fallback), `DescribeTimeToLive` scripted `[DISABLED, DISABLED, DISABLED,
  DISABLED, ENABLED]` (pre-send guard + four hook reads, the LAST reporting
  ENABLED) -> `ensureTable` RESOLVES with exactly 4 `UpdateTimeToLive`
  sends. Confirm RED (today: rejects, hook only 3x).
- Reorder the catch in `retryLocalControlPlane` to: `isRetryableContainerFault`
  -> endpoint gate (lazy, unchanged semantics) -> verify block (once per
  failed attempt, INCLUDING the final; landed -> return; hook throws ->
  rethrow original, attaching the hook error as `cause` when the original has
  none - that is W6) -> attempt bound -> deadline -> `onRetry` -> `sleep`.
  Cases 7, 11, 12, 21, 22 must stay green as written; case 10 must be
  UPDATED: title and assertions become "4 sends, hook 4x, including the final
  attempt" with the 9-element `ttlLog` interleave (trailing
  `DescribeTimeToLive`).
- Update every comment that states the old rule ("not called on the final
  attempt - the bound is checked first"): the hook now runs once per failed
  attempt including the final; the bound and deadline stop only RE-SENDS.
  State in one line WHY (a mutation that lands on attempt 4 must not be
  reported failed - the same argument as the deadline reorder one line
  earlier).

### W3 (finding 3, MED) - poll backoff

Both polls: the read interval DOUBLES per read from the injected base,
capped at 8x base (defaults 100 -> 200 -> 400 -> 800 -> 800...). Ceiling
UNCHANGED. One comment line: a container that is already buckling should not
receive ~100 extra reads in 10s from the path reacting to its buckling.
Existing cases (2, 17, 19) inject `intervalMs: 1` and assert script-driven
counts - verify they still pass unchanged.

### W4 (findings 4, 6, 7 - text in AGENTS.md and dynamoAdmin.ts)

- `AGENTS.md` first-diagnostic paragraph: replace the "was not faster" clause
  with: "re-measured 2026-09-01 on a fresh container the explicit-key arm was
  in fact slightly FASTER (default 231/190s vs explicit 189/165s, app
  workspace) - tracking a declining e2e neighbour across the interleave, not
  the key scheme; the supersession rests on the code reading, not on wall
  clock". Nothing else in the paragraph changes.
- `dynamoAdmin.ts` TTL-legs sentence (currently "the two TTL legs do not run
  at all (DYNAMO_DISABLE_TTL=1); db:create and the e2e lanes do reach them"):
  correct to - WORKERS skip the TTL legs (`test.env` reaches workers only);
  `globalSetup` runs them on every `npm test`
  (docs/issues/globalsetup-reenables-ttl-on-shared-tables.md), as do
  `db:create` and the e2e lanes.
- `dynamoAdmin.ts` "which the same diff introduced" -> "which predates this
  change (1448b130, 2026-08-16)".

### W5 (finding 5, HIGH) - narrow the SDK-retry claim; fix the arithmetic it carries

- Rewrite the module preamble's "The AWS SDK's default retry policy covers
  neither code, so both escape to the caller" to what is PROVEN: both faults
  have repeatedly ESCAPED to callers and failed gates (the anchor issue's
  recorded history). Add: whether the SDK's own transient retry had already
  fired underneath is UNKNOWN - the SDK classifies HTTP 500/502/503/504 as
  TRANSIENT and retries up to 3 attempts by default
  (`@smithy/core` `TRANSIENT_ERROR_STATUS_CODES`), `InternalServerError`
  carries no `$retryable` trait so classification hangs on
  `$metadata.httpStatusCode`, and NO recorded sighting captured that field.
- In the `DEFAULT_DEADLINE_MS` comment: one helper attempt is one
  `client.send`, which may itself contain up to 3 nested SDK attempts if the
  container answers 5xx (unverified either way) - so the lock-timeout
  signature may cost ~30s per helper attempt, not ~10s. Size hook budgets
  pessimistically; do not derive them from this constant. Keep the 20s value
  itself UNCHANGED.
- Append one line to the 2026-09-01 update block in
  `docs/issues/npm-test-dynamodb-local-contention.md`: the next sighting must
  record `err.$metadata.httpStatusCode` and `err.$metadata.attempts` - they
  settle whether the SDK's transient retry nests under ours.

### W6 (finding 12 PARTIAL) - causes

- The verify-hook catch: `if (err instanceof Error && err.cause === undefined) err.cause = hookErr;`
  before rethrowing the original (name the caught hook error).
- `TableNotActiveError` and the new `TableNotGoneError`: carry the LAST read
  error (if any) as `{ cause }`.
- Do NOT touch `db-update-gsis.ts` (declined).

### W7 (findings 10, 11 - staticSmoke + case 21)

- `staticSmoke.test.ts` (c): delete the two unreachable `for` loops; leave
  the `identityHolds` guard + skip as the whole test with one comment saying
  the guard IS the assertion (a failing condition must SKIP, never FAIL).
- Case 21 reshape (deterministic): `CreateTable` script
  `[fail after 5ms, fail after 2500ms]` with a fast-failing fallback,
  `attempts: 12`, `backoffMs: () => 0`, `deadlineMs: 2000` -> assert EXACTLY
  2 sends and the original `InternalFailure` identity; comment: the deadline
  is only read in the catch, send 1 completes at ~5ms << 2000 so it cannot
  fire early, and after send 2 elapsed >= 2505 > 2000 always - deterministic
  in both directions; removing the deadline gives 12 sends.

### W8 (findings 8, 9, conf-5 - records)

- `measurements/s2-guard-cost.md`: append an addendum section "logCallSiteGuard
  inside the S0 full runs (added 2026-09-01, planner fix wave)": warm-up
  12.6s; run 1 31.5s (CONTENDED - host CPU 100%, 1 vitest neighbour + 2 e2e
  suites, per s0-baseline.md's run-1 snapshot); run 2 10.0s; run 3 13.4s.
  Read from the gitignored S0 run logs
  (`.superpowers/sdd/s0-warmup.log`, `s0-run{1,2,3}.log` - grep
  `logCallSiteGuard`); QUOTE the four per-file lines into the addendum so the
  provenance is committed. Note this is the "31.5s worst loaded / ~5.7x"
  figure the logcallsiteguard closure and handback cite.
- Spec `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`, at
  the paragraph beginning "**No traversal decoys. The whole decoy idea is
  dropped**": append one bracketed ASCII sentence in the C1 style:
  "[Superseded 2026-09-01 by the build's review fix wave 1 (b81ceb23,
  r1-adjudications A3): an adversarial reproduction showed the probes are
  unfalsifiable without a target (4/6 leak with one, 0/6 without), so decoys
  now live INSIDE the mkdtemp fixture root at the probed depths. The claim
  that send rejects '..' before the filesystem remains true and is why the
  decoys are never read today.]"
- `docs/superpowers/reviews/2026-08-31-npm-test-soundness/s3-static-smoke.md`,
  in the traversal section: one bracketed dated note - "[Note added
  2026-09-01: the no-decoys statements in this section were true as of
  796b8632 and were superseded by fix wave 1 (b81ceb23) - decoys were added
  inside the fixture root after a review reproduction proved the probes
  unfalsifiable without a target. See code-review/r1-adjudications.md A3.]"
- `design-review/plan-r3-reviewer-c.md`: replace the three U+2713 characters
  with `OK` (find them: `grep -nP "[^\x00-\x7F]"` or a node one-liner).

## Verify (from `W:\tmp\npm-test-soundness\app`, bare, foreground, output to
## files under `W:\tmp\npm-test-soundness\.superpowers\sdd\reports\`)

- `npx vitest run test/dynamoAdminRetry.test.ts` - 25 cases green
- `npx vitest run test/staticSmoke.test.ts` - 12 green (dist present)
- `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` - 15 green
- `npx vitest run test/dynamo.integration.test.ts`
- `npx vitest run test/importApply.integration.test.ts` (the caller W1
  protects)
- `npx vitest run test/globalSetupEnsure.test.ts`
- root: `npm run typecheck`;
  `npx eslint app/src/lib/dynamoAdmin.ts app/test/dynamoAdminRetry.test.ts app/test/staticSmoke.test.ts`
- ASCII scan of every added line in your diff (0 hits above 0x7E), and confirm
  `design-review/plan-r3-reviewer-c.md` now has zero non-ASCII bytes.

Do NOT run the full `npm test` / `npm run e2e` / `npm run smoke` (the
orchestrator runs gates after you). No container restart, no
`E2E_CHILD_LOG_DIR`, nothing backgrounded, no scratch left (`git status
--short` clean of anything you created; the access-key guard walks app/test
on disk).

## Rules

ASCII on touched lines; Edit tool only, never PowerShell rewrite pipelines;
bare `git status` before every commit; `.git/MERGE_HEAD` absent; explicit
paths, never `git add -A`. Commits: (1) code W1-W3+W5-W7 with tests, (2)
docs W4+W8, (3) the record. Trailer:
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
Record: `docs/superpowers/reviews/2026-08-31-npm-test-soundness/code-review/planner-fix-wave.md`
(ASCII; per finding what changed `file:line`; RED-then-GREEN for cases 23/24/25
and updated 10/21; verify table with exit codes; anything seen, not fixed).
No byte-exact code quotation in the record; verbose output to
`W:\tmp\npm-test-soundness\.superpowers\review\planner-fix-wave-evidence.md`
(gitignored).

## STOP conditions

Any verify-list suite fails on an ASSERTION (not a timeout) after your
change - stop, report both runs. The reorder in W2 breaks case 11/12's
zero-extra-sends property - stop, report (the gate must stay ahead of the
hook). Low on context - commit what is green, report the next step.

## Return

ONLY: commit hashes + one-liners; W1-W8 one-line status; RED/GREEN lines for
cases 23/24/25 and updated 10/21; the verify table; the record path; open
findings (one line each).
