# Code review round 1 - adjudications (orchestrator)

Branch `feat/npm-test-soundness`, reviewed tip `796b8632`. Reports:
`r1-conformance.md` (0 blocker / 0 must-fix / 2 should-fix / 7 note) and
`r1-adversarial.md` (1 blocker / 2 must-fix / 3 should-fix / 3 note), both
committed as produced at `895bc3f2`. 18 findings, adjudicated below. ONE fix
wave follows; its diff is re-reviewed by the SAME two reviewers on
continuation.

Key: ACCEPT = fixed in the wave; DECLINE = not changed, reason given; RECORD =
no code change, carried to S7/S8.

## Adversarial

| # | sev | verdict | disposition |
|---|---|---|---|
| A1 | blocker | CONFIRMED | **ACCEPT.** `app/test/dynamoAdminRetry.test.ts` trips `app/test/setup/dynamoAccessKeyGuard.test.ts:264-306` (its source mentions `ensureTable`/`CreateTableCommand`, has no marker, no random prefix). The suite creates no container tables, so the guard is a false positive - but gate 2 is red, and this mission's subject is gate 2. Fix: the guard's own extension mechanism is a DECLARED, greppable marker in the suite's source, so add a third marker `hc:dynamo-lane none` ("this suite never opens a DynamoDB Local database") to the guard, honoured in the `createsTables` predicate, with a rot-proof check that a `none` suite does not import `../src/lib/dynamo.js` (the only container-reaching client factory) - and declare it in the acceptance suite. Rejected alternative: salting the stub table names with `randomUUID` to satisfy the regex mechanically - it would pass the guard by pretending the names are container tables. Scope note: the guard is test infrastructure, not app runtime; the spec's "no runtime code other than dynamoAdmin.ts" holds. |
| A2 | must-fix | CONFIRMED | **ACCEPT.** `deleteTableIfExists` (`dynamoAdmin.ts:471-483`) tolerates `ResourceInUseException` on the FIRST attempt, any endpoint, while its own comment justifies it only for a retried send. The spec's stated hole is "attempt 2 against a DELETING table" and the plan's wording ("additionally tolerates") did not say unconditional on purpose - both readings honour intent, and the gated one is strictly safer: it leaves every un-retried caller (`db-create.ts:63/:75`, ~50 suites) on today's behaviour. Fix: thread the same per-call `onRetry -> retried` seam `ensureTable` uses; tolerate RIU only when `retried`; add acceptance case 18 (un-retried RIU on DeleteTable still throws). Spec-vs-tree call recorded here per the manual. |
| A3 | must-fix | CONFIRMED | **ACCEPT - a deliberate, recorded deviation from spec v4 ("No decoys").** The spec argued a decoy is unreachable through `send` and therefore useless. The reviewer's reproduction (evidence E3) shows the opposite of useless: with a hand-rolled leaky static layer, the six probes fail 4/6 when a target file exists at the probed depth and 0/6 under the temp fixture where nothing does. The probes' only job is to detect a FUTURE static-serving change, and without a target they cannot. The spec conflated "unreachable through today's mechanism" with "no value"; four review rounds did not have this reproduction. Fix: make the fixture dist a subdirectory TWO levels inside the mkdtemp root (`<root>/site/dist`), write decoys INSIDE the root at the depths the probes resolve to (`<root>/package.json` for `../../package.json` and `assets/../../../package.json`; `<root>/site/package.json` for a one-level probe if any), each carrying the leak markers `"version"`/`"private"`; never write outside the mkdtemp root; `rmSync(root)` cleans all. The `/etc/passwd` probe resolves outside the root and stays a shape probe - the comment must say so. Rewrite the traversal comment to state exactly this, and PROVE falsifiability in the wave record by re-running the reviewer's leaky-layer throwaway against the new fixture (must show failures) and against the real app (must pass). Flagged for the human in the handback as a spec deviation. |
| A4 | should-fix | PLAUSIBLE | **ACCEPT.** The retry bounds attempts, not time; a lock-timeout fault costs ~10s per attempt by the code's own account, so 4 attempts can spend ~41.5s of a 60s hook that loops 22 tables. The spec's own reason for bounding the retry was "a retry loop that can outlive a test budget trades one false red for another" - a deadline serves that reason directly. Fix: `deadlineMs` on `RetrySchedule`, default 20_000 (one full lock-timeout retry, several fast `InternalFailure` retries), checked BEFORE each re-send (`if elapsed >= deadlineMs throw err`); acceptance case 21 with a slow stub send and a tiny deadline proving the loop stops early and rethrows the original error. Threaded to callers through the existing `opts`. |
| A5 | should-fix | PLAUSIBLE | **DECLINE the behaviour change; ACCEPT a one-line comment.** The apparent contradiction (10s poll ceiling vs `db-update-gsis`'s 900s) compares different things: the poll waits only on a table THIS call just created (empty, per-worktree or per-run-random key - the guard and the key scheme exclude another process creating the same table in the same database), while 900s is a GSI backfill on the human's populated local table. Returning `'exists'` at the ceiling would hand back a still-CREATING table, which is the exact hole the spec fixes. Add one comment line at `DEFAULT_POLL_CEILING_MS` saying why the two figures differ. |
| A6 | should-fix | PLAUSIBLE | **DECLINE for this branch; OPEN ITEM for the human.** A create that landed on attempt 1 followed by three more `InternalFailure`s is lost. Not a regression (base failed on the first fault). The remedy - a `DescribeTable` verify hook on `CreateTable` - contradicts the plan's explicit "CreateTable uses `sendWithRetry`, no hook" row that eight review rounds accepted; it would also change the return value on that path to `'created'` (arguably more correct - see A8). Too large a design change for a fix wave without the human. Carried to the handback with the reviewer's scenario. |
| A7 | note | CONFIRMED | **RECORD.** `static-smoke-fails-on-stale-dashboard-dist.md` stays `open` until S7, which closes it on the S3 evidence. |
| A8 | note | CONFIRMED | **RECORD.** `'exists'` is returned for a table this call created on the retried path; case 2 pins it; the plan specified it. Carried to the handback beside A6 (the same design row). |
| A9 | note | CONFIRMED | **ACCEPT.** Guard the `afterAll` `rmSync` on the root having been created. |

## Conformance

| # | sev | verdict | disposition |
|---|---|---|---|
| C1 | note | CONFIRMED | **ACCEPT (docs).** Spec v5 line ~526 still says the fixture must carry `HousingChoice`; plan S3.1 (round 1) replaced that with a distinctive marker because it was a tautology. Add one bracketed ASCII sentence to that spec line noting the supersession, so the spec cannot be read as the live contract on this point. |
| C2 | note | CONFIRMED | **ACCEPT.** Add acceptance case 19: CreateTable `InternalFailure` then `ResourceInUseException`, `DescribeTable` never ACTIVE, tiny poll ceiling -> rejects with a `ResourceInUseException` INSTANCE whose message names the table and the observed status (the `ensureTable` half of the exhaustion split). |
| C3 | note | CONFIRMED | **ACCEPT.** Add acceptance case 20: two `ensureTable` calls run concurrently (`Promise.all`) on two stub clients - one retried (InternalFailure then RIU, then ACTIVE), one plainly pre-existing whose first send is delayed until after the other's retry has fired - and assert the plain one issued ZERO `DescribeTable`. A module-level `retried` would fail it. |
| C4 | note | CONFIRMED | **RECORD** (S7: the `dropAllTables` waiter observation, per plan S7.2). Note A2's gating narrows this: only a RETRIED delete can now reach the waiter's slow path. |
| C5 | should-fix | CONFIRMED | **RECORD** (S7 closure wording for `logcallsiteguard-hook-budget-equals-its-own-cost`: unreproducible premise, no cut, budget unchanged and deliberately not lowered, two remedies returned as decisions, the RPC fault credited to `maxWorkers: 4`). |
| C6 | should-fix | CONFIRMED | **RECORD** (S8: the two unclassified enumeration hits go in `handback.md`). |
| C7 | note | CONFIRMED | **RECORD.** The second describe was folded onto the shared `fixtureApp`; assertions unchanged; benign. |
| C8 | note | CONFIRMED | **ACCEPT.** Rename the hardening-headers loop variable from `path` to `route`. |
| C9 | note | CONFIRMED | **ACCEPT.** Date the in-code `send` version ("1.2.1 when this was written, 2026-09-01; see the S3 record") so it reads as an observation, not an invariant. |

## Fix wave scope (one fresh child)

Code: `app/src/lib/dynamoAdmin.ts` (A2 gate + A4 deadline + A5 comment),
`app/test/dynamoAdminRetry.test.ts` (marker; cases 18-21), `app/test/setup/dynamoAccessKeyGuard.test.ts`
and wherever its marker constants live (A1), `app/test/staticSmoke.test.ts`
(A3 decoys + comment, A9, C8, C9), spec line (C1). Record:
`code-review/r1-fix-wave.md`. Re-review by the same two reviewers on
continuation, charged first with what round 1 MISSED, then with the fix diff
as new unreviewed code.
