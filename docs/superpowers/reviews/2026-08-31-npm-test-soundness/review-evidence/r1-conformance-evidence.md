# R1 conformance review - verbose evidence (gitignored, not committed)

Reviewer: conformance pass over S1/S2/S3 at tip `796b8632`.

## Commands run (all bare, foreground, from `W:\tmp\npm-test-soundness\app`
unless noted)

```
npx vitest run test/dynamoAdminRetry.test.ts
  -> RUN v3.2.6, 1 file passed, 17 passed (17), 221ms tests / 1.21s
  -> [globalSetup] ensured hc-local- tables (key=hctestcdb4fe): 22 created
  -> [globalTeardown] dropped hc-local- tables (key=hctestcdb4fe): 23

npx vitest run test/staticSmoke.test.ts
  -> 1 file passed, 12 passed (12), 173ms tests / 4.23s
  -> NOTE: 12/12, not 11+1 skipped, because this worktree currently HAS a
     built dashboard/dist (left fresh by S3.4). Branch (c) took its PASS arm.

npx vitest run test/__review_conformance_probe.test.ts   (THROWAWAY, deleted)
  -> 1 file passed, 2 passed (2), 48ms tests / 1.07s

npm run issues   (from the worktree root)
  -> [issues] 276 open, 156 closed, 432 total -> docs/issues/INDEX.md
  -> [issues] open by severity: 11 high, 122 med, 143 low
  -> [issues] 1 warning(s):
       - perf-selfqa-route-contract-drift.md: unknown severity "medium"
     (pre-existing, unrelated file; the new issue draws no warning)

git status --short   -> empty before and after the probe
```

## ASCII scan

Non-ASCII byte counts on the branch's touched files:

```
app/src/lib/dynamoAdmin.ts                            3
app/scripts/db-update-gsis.ts                         0
app/test/dynamoAdminRetry.test.ts                     0
app/test/logCallSiteGuard.test.ts                     0
app/test/staticSmoke.test.ts                          0
docs/issues/built-dashboard-identity-tags-unasserted.md  0
```

The 3 bytes are one em dash on `app/src/lib/dynamoAdmin.ts:1`, a
pre-existing header line the branch does not touch. A scan of every ADDED
line in `git diff 5ce9912f..HEAD` over all five code files found zero
non-ASCII characters.

## The throwaway probe (deleted before returning)

Written to `app/test/__review_conformance_probe.test.ts`, run once, removed.
It covered the two shipped branches no committed test reaches. Both PASSED,
i.e. the shipped behaviour matches the plan.

Probe A - `ensureTable`'s half of the poll-exhaustion split
(`dynamoAdmin.ts:383-389`). Stub: local endpoint; `CreateTable` scripted
`[InternalFailure, ResourceInUseException]`; `DescribeTable` always
CREATING; `ensureTable` called with `retry: { backoffMs: () => 0 }` and
`poll: { intervalMs: 1, ceilingMs: 5 }`.

```
expect(err).toBeInstanceOf(ResourceInUseException)      PASS
expect(err.message).toContain('Table already exists')   PASS   (the ORIGINAL text)
expect(err.message).toContain('stub-tbl')               PASS   (spliced from the poll)
expect(err.message).toContain('CREATING')               PASS   (observed status)
```

So the caller sees a `ResourceInUseException` instance - not a
`TableNotActiveError` - carrying both halves of the story, exactly as plan
S1.3 specifies. Nothing committed asserts this.

Probe B - the per-call `retried` local under real concurrency
(`dynamoAdmin.ts:349-353`, `:380`). Two stub clients driven through
`Promise.all`: one scripted `[InternalFailure, ResourceInUseException]` with
DescribeTable answering ACTIVE, one scripted `[ResourceInUseException]`
alone.

```
retried client:  resolves 'exists', DescribeTable count > 0     PASS
clean client:    resolves 'exists', DescribeTable count === 0   PASS
```

A module-level flag would have made the clean call poll. It does not. Note
that the 17 committed cases are all sequential, so none of them could have
detected the difference - which is precisely what the plan's watch item
warned about.

## Cross-checks read out of the live tree

- `retryLocalControlPlane` order of operations, `dynamoAdmin.ts:205-229`:
  retryable test (`:210`) -> attempt bound (`:211`) -> endpoint gate
  (`:212-213`) -> verify hook (`:214-225`) -> `onRetry` (`:226`) -> sleep
  (`:227`). The bound BEFORE the hook is what makes case 10's "hook called 3
  times across 4 attempts" true; the gate AFTER the bound is behaviourally
  irrelevant (a non-local client throws on its first retryable error either
  way).
- `local ??= await isLocalDynamoEndpoint(client)` caches a `false` correctly
  (`false` is not nullish), but the loop throws immediately after a `false`,
  so the cache only ever matters on the local path.
- `dropAllTables` is the `npm test` teardown path and does call
  `deleteTableIfExists` then `waitUntilTableNotExists({maxWaitTime: 60})`:
  `app/scripts/db-create.ts:58`, `:63-64`, `:75-76`. This is the reachability
  argument behind finding 4.
- `logCallSiteGuard.test.ts` live line anchors: budget rationale comment
  `:139-156`, hook `:159-162` with the 180_000 third argument on `:162`,
  health-`it` rationale `:164-171`, the `it` itself `:172`, the sourceCount
  assertion `:176`, the TS2307 rationale `:179-181`, `getPreEmitDiagnostics`
  `:183`. No `performance.now`, `hrtime` or `console.time` anywhere in the
  file - the S2 instrumentation is gone.
- `staticSmoke.test.ts` has no `statSync` and no mtime comparison anywhere,
  confirming S3.3's "no mtime predicate of any kind".
- `app/test/unreadIndexRepo.integration.test.ts` does not appear in
  `git diff --name-only 5ce9912f..HEAD`, confirming S1.4's do-not-touch.
