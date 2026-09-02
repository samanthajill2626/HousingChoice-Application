# Planner-review fix wave - implementer record (M7)

Worktree `W:\tmp\npm-test-soundness`, branch `feat/npm-test-soundness`. Base
tip `3d47e2c6` (the adjudications commit). One implementer, one pass.

Commits:

| hash | what |
|---|---|
| `6b4d712e` | code half - W1, W2, W3, W5(a)(b), W6, W7, with the tests |
| `51dc753d` | docs half - W4, W5(c), W8 |
| (this file) | the record |

Every ACCEPT row in `planner-fix-wave-adjudications.md` is implemented. The
DECLINE inside finding 12 (`db-update-gsis.ts:80`) was left alone as directed;
`db-update-gsis.ts` is untouched by this wave.

## Per finding

### 1 (HIGH, W1) - wait-until-gone on the retried-tolerated delete

- `app/src/lib/dynamoAdmin.ts:409` - new `TableNotGoneError` (fields
  `tableName`, `observedStatus`), the mirror of `TableNotActiveError`.
- `app/src/lib/dynamoAdmin.ts:491` - new exported `pollUntilTableGone`, same
  `PollOptions` seams and the same backoff as the ACTIVE poll. Only a
  `ResourceNotFoundException` from `DescribeTable` returns; a successful read
  records the observed `TableStatus`; ANY other read failure counts as
  "maybe still there" and is polled again. No endpoint gate of its own, for
  the reason the ACTIVE poll gives.
- `app/src/lib/dynamoAdmin.ts:679` - `deleteTableIfExists` calls the poll ONLY
  on the `retried && ResourceInUseException` path, catches `TableNotGoneError`
  and rethrows the ORIGINAL conflict with the poll message appended. The split
  mirrors `ensureTable`'s exactly. The un-retried path is byte-identical to
  before (case 18 unchanged and green).
- `deleteTableIfExists` opts gained `poll?: PollOptions`.
- The comment block now says the wait is what makes the tolerance safe for
  delete-then-create callers, naming `importApply.integration.test.ts`.

### 2 (MED, W2) - verify on the final attempt

- `app/src/lib/dynamoAdmin.ts:300-323` - the catch is reordered to
  retryable -> endpoint gate (lazy, unchanged semantics) -> verify -> attempt
  bound -> deadline -> `onRetry` -> `sleep`. The gate stays AHEAD of the hook,
  so a non-local endpoint still spends zero extra sends.
- `app/src/lib/dynamoAdmin.ts:119` - the hook contract in the module preamble
  now says EXACTLY once per failed attempt, the final one included, and that
  the bound and the deadline stop RE-SENDS only.
- `app/src/lib/dynamoAdmin.ts:321` - the in-loop comment states the WHY in one
  line: a mutation that lands on attempt 4 must not be reported failed, the
  same argument as the deadline reorder immediately below it.
- Grepped for the old rule across `dynamoAdmin.ts`, `db-update-gsis.ts` and the
  acceptance suite; no other statement of it survived.

### 3 (MED, W3) - poll backoff

- `app/src/lib/dynamoAdmin.ts:268` - `pollDelay(baseMs, reads)` doubles from the
  injected base and caps at 8x (defaults 100 -> 200 -> 400 -> 800 -> 800). Used
  by both polls (`:468`, `:513`). Ceilings unchanged.
- `PollOptions`' doc (`:151`) now says `intervalMs` is the FIRST delay.
- Cases 2, 17 and 19 inject `intervalMs: 1` and assert script-driven counts;
  all three pass unchanged.

### 4, 6, 7 (W4) - text

- `AGENTS.md:163-166` - "was not faster" replaced with the slightly-FASTER
  reading plus the declining-e2e-neighbour attribution and the note that the
  supersession rests on the code reading, not wall clock. Nothing else in the
  paragraph changed.
- `app/src/lib/dynamoAdmin.ts:187` - the TTL-legs sentence now says the WORKERS
  skip the legs (`test.env` reaches workers only) while `globalSetup` runs them
  on every `npm test`, citing
  `docs/issues/globalsetup-reenables-ttl-on-shared-tables.md`, as do `db:create`
  and the e2e lanes.
- `app/src/lib/dynamoAdmin.ts:199` - "which the same diff introduced" ->
  "which predates this change (1448b130, 2026-08-16)". Commit verified present.

### 5 (HIGH, W5) - the SDK-retry claim and its arithmetic

- `app/src/lib/dynamoAdmin.ts:88-99` - the preamble now asserts only what the
  issue history proves (both faults have repeatedly ESCAPED to callers and
  failed gates) and records the nesting question as UNKNOWN, naming the smithy
  transient set, the missing `$retryable` trait on `InternalServerError`, and
  the fact that no recorded sighting captured `$metadata.httpStatusCode`.
- `app/src/lib/dynamoAdmin.ts:174` - the deadline arithmetic: one helper attempt
  is one `client.send`, which may itself contain up to 3 nested SDK attempts, so
  the lock-timeout signature may cost ~30s per helper attempt rather than ~10s;
  size hook budgets pessimistically and do not derive them from the constant.
  `DEFAULT_DEADLINE_MS` is still 20_000.
- `docs/issues/npm-test-dynamodb-local-contention.md:50` - the 2026-09-01 block
  now names the two `$metadata` fields the next sighting must record.

### 12 (PARTIAL, W6) - causes

- `app/src/lib/dynamoAdmin.ts:316` - the verify-hook catch names the hook error
  and attaches it as `cause` on the rethrown original, only when the original
  has none.
- `TableNotActiveError` and `TableNotGoneError` both take an options object and
  carry the LAST read error as `cause` (`:468`, `:513` construct them).
- `db-update-gsis.ts` untouched, as adjudicated.

### 10, 11 (LOW, W7)

- `app/test/staticSmoke.test.ts:383` - the two unreachable `for` loops are gone;
  the `identityHolds` guard plus `ctx.skip` IS the whole test, with one comment
  saying so and why a failing condition must SKIP rather than FAIL.
- `app/test/dynamoAdminRetry.test.ts:625` - case 21 reshaped deterministic.

### 8, 9, conf-5 (W8) - records

- `measurements/s2-guard-cost.md:233` - addendum "logCallSiteGuard inside the S0
  full runs", quoting the four per-file duration lines read from the gitignored
  `.superpowers/sdd/s0-warmup.log` and `s0-run{1,2,3}.log`, each beside its S0
  snapshot label. Provenance for the "31.5s worst loaded" figure is now
  committed. NOTE: the closure's "~5.7x" is 180s budget / 31.5s, not a
  loaded-vs-quiet ratio - the addendum states it that way.
- `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md:543` -
  bracketed C1-style supersession at the "No traversal decoys" paragraph.
- `s3-static-smoke.md:116` - dated bracketed note in the traversal section.
- `design-review/plan-r3-reviewer-c.md:324,329,330` - the three U+2713 are now
  `OK`; the file is 0 non-ASCII bytes (byte-counted, not grepped).

## RED then GREEN

Tests were written before the implementation in every case below. Logs under
`.superpowers/sdd/reports/` (gitignored).

| case | RED (before) | GREEN (after) |
|---|---|---|
| 23 - retried delete waits until gone | FAIL: 0 `DescribeTable` observed, 3 expected - the tolerated path returned with no poll at all (`w1-red.log`) | PASS: 2 `DeleteTable`, 3 `DescribeTable` |
| 24 - never gone rethrows the conflict | FAIL: resolved undefined where the original `ResourceInUseException` instance was expected (`w1-red.log`) | PASS: identity, `instanceof`, message carries `stub-c24` and `DELETING` |
| 25 - lands on the FINAL attempt | FAIL: rejected `InternalFailure`; the bound was read before the hook so the 5th read never happened (`w2-red.log`) | PASS: resolves 'created', 4 `UpdateTimeToLive`, 5 `DescribeTimeToLive` |
| 10 - updated to hook 4x | FAIL as rewritten: 8-element interleave, no trailing re-read (`w2-red.log`) | PASS: 4 sends, 9-element interleave ending on `DescribeTimeToLive` |
| 21 - deterministic reshape | n/a - green before and after; the reshape replaces a ratio with an equality, so it has no red phase. Teeth checked by construction: a third send both breaks `toBe(2)` and rejects with a different error | PASS: exactly 2 sends, original fault by identity |

One case NOT in the brief had to change, and it is the only behaviour-visible
collateral of W1:

- case 4 (`app/test/dynamoAdminRetry.test.ts:315`) drove the retried-tolerated
  delete with no `DescribeTable` script, so after W1 it polled the default
  ACTIVE answer for the full 10s default ceiling and then failed. It now
  scripts one `ResourceNotFoundException` read and injects the poll options -
  the table is already gone when the conflict is handled, so the wait costs
  exactly one read. Its meaning is preserved (retried -> tolerated) and case 23
  is the still-DELETING variant. Recorded because it means case 4 no longer
  pins "returns immediately"; nothing does, deliberately.

## Verify

All bare, foreground, from `W:\tmp\npm-test-soundness\app` unless noted, on the
final committed state.

| command | exit | result |
|---|---|---|
| `npx vitest run test/dynamoAdminRetry.test.ts` | 0 | 25 passed |
| `npx vitest run test/staticSmoke.test.ts` | 0 | 12 passed (dist present, no skip) |
| `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` | 0 | 15 passed |
| `npx vitest run test/dynamo.integration.test.ts` | 0 | 2 passed |
| `npx vitest run test/importApply.integration.test.ts` | 0 | 31 passed (the caller W1 protects) |
| `npx vitest run test/globalSetupEnsure.test.ts` | 0 | 5 passed |
| `npm run typecheck` (root) | 0 | all five workspaces |
| `npx eslint app/src/lib/dynamoAdmin.ts app/test/dynamoAdminRetry.test.ts app/test/staticSmoke.test.ts` | 0 | no output |
| ASCII scan of every added line in the wave's diff | - | 0 bytes above 0x7E |
| non-ASCII byte count, `plan-r3-reviewer-c.md` | - | 0 |

Not run, as instructed: full `npm test`, `npm run e2e`, `npm run smoke` (the
orchestrator's gates). No container restart, no `E2E_CHILD_LOG_DIR`, nothing
backgrounded. `git status --short` carries nothing this wave created.

STOP conditions: none triggered. In particular the W2 reorder did NOT break
cases 11/12 - the endpoint gate is evaluated before the hook, so a non-local
endpoint still makes exactly one send.

## Seen, not fixed

1. **The acceptance suite's case count is cited in prose in two places** and was
   stale after this wave (22 -> 25). Corrected in `AGENTS.md:171` and
   `docs/issues/npm-test-dynamodb-local-contention.md:19` as part of W4's text
   pass. Flagged because it is the second wave in a row to move that number;
   a count in prose rots by construction.
2. **`DEFAULT_POLL_CEILING_MS`'s comment argues the 10s ceiling for the ACTIVE
   poll only** (`app/src/lib/dynamoAdmin.ts:203-224`). `pollUntilTableGone`
   shares the constant and the argument transfers - a local table still
   DELETING after 10s is stuck, not busy - but the comment does not say so. Not
   changed: no ACCEPT row covers it and the wave's rule was to touch what was
   adjudicated.
3. **Finding 5's DECLINED half is still open**: nothing sets `maxAttempts` on
   the local client (`app/src/lib/dynamo.ts`, outside this mission's permitted
   runtime file), so if the container does answer 5xx, SDK attempts still nest
   under ours. The comment now says so and the issue names the fields that
   would settle it; the code change remains a handback item.
4. **Case 21 now costs ~2.5s of wall clock** by design (its second send sleeps
   2500ms against a 2000ms deadline). That is the price of removing the ratio
   assertion. The file's total runtime is ~3s of tests; well inside the 5s
   default per-test timeout, but it is the one case in the file that spends
   real time and should not be copied as a pattern.
