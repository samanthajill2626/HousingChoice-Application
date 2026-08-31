# Plan review - Error surface detail (continuity reviewer B)

Plan: `W:\tmp\error-surface-detail\docs\superpowers\plans\2026-08-24-error-surface-detail.md` (1659 lines, 15 tasks)
Spec: `docs/superpowers/specs/2026-08-24-error-surface-detail-design.md` (r6, final)
Adjudications: all 5 rounds
Repo: READ-ONLY; no tests, builds or e2e runs.

Question answered: **if a builder with no context executes this literally, do they
produce the spec?** Mostly yes - and the two places they do not are both in the
UI layer, which is where every previous round lost a decision.

---

## A. DECISION-DELIVERY WALK

Each decision traced to the task and step that delivers it. I read the code the
plan quotes.

| Decision I fought for | Delivered at | Verdict |
|---|---|---|
| `err` ALLOWLIST, not denylist | T6 S3 `ERR_ALLOWLIST` + `isAllowedKey` (plan 767-784); tests 704-717 assert `err.cause.config.headers.Authorization` dropped | **DELIVERED** |
| scalar-`err` clause | T6 S3 `if (key === 'err') return true` (780); test 719-723 | **DELIVERED**, and T4 mirrors it on the list path (560) |
| no raw `@message` for a parsed record | T6 S3 `DROPPED_KEYS` includes `'@message'` (776); rawText only when `appFieldCount === 0` (807); test 725-732 | **DELIVERED**, gate is fragile - F4 |
| second-granularity DISJOINT split | Global Constraints line 22 + T8 S3 `anchorSec` / `anchorSec + 1` (1096-1100); test 994-1002 asserts `after.startTime > before.endTime` | **DELIVERED**, and it is the best-specified thing in the plan |
| two opposite-sorted queries IN PARALLEL | T8 S3 `Promise.all` (1098) + the rationale at 1110 citing the bounded ~8s poll budget | **DELIVERED** |
| id-dependent bracket | T8 S3 `BRACKET_TIGHT_MS` / `BRACKET_WIDE_MS` (1026-1027, 1087); test 985-992 | **DELIVERED** |
| `pollRunId` -> envelope | T3 S3 (346) | **DELIVERED** |
| `pollRunId` -> projection | T4 S3 `pollRunId: str(parsed['pollRunId'])` (584) | **DELIVERED** |
| `pollRunId` -> wire type | T10 S1 (1236) | **DELIVERED** |
| `pollRunId` -> the link | T12 S3 `tracePivot` (1406-1411) | **DELIVERED** |
| four-value `source` union | T4 `sourceOf` (485-492); T10 mirror; T12 `SOURCE_LABEL: Record<SystemErrorEvent['source'], string>` (1413-1415) - the `Record` keying makes a missing branch a typecheck error | **DELIVERED** |
| per-field truncation flags RENDERED | T4 produces both; **T12 renders only `messageTruncated` (1437)** | **NOT DELIVERED - F3** |
| the trace view existing at all | T13 creates `ErrorTrace.tsx` (1494-1545) | **created, never mounted - F1** |
| environment scope check | T7 S3 `allowed.includes(record.logGroup)` (907-911); test 869-873 | **DELIVERED** |
| PII refusal on `req.path` | T2 S3 `routeLabel` (243-247); test 179-195 asserts `not.toContain('+14045551234')` | **DELIVERED**, and it is a real assertion, not a comment |
| perf source-citation ledger | T15 S2 (1615-1625) | **DELIVERED, and the line numbers are correct** - I verified all three: `e2e/performance/routes.ts:680` is the `/settings/system` base citing `useSystemStatus.ts:77-132`, `:762` is `systemAlarms: '...useSystemStatus.ts:124-132'`, and `e2e/performance/collect.test.ts:353` is the pinned literal. Nobody found this surface in five rounds of spec review. |

**Item 2 of the charge - did the layer-by-layer method work?** Largely yes. The
`pollRunId` chain reaches all four layers; `source` reaches all three; the scope
check, the allowlist and the split are each complete. The method failed in
exactly one place, and it is the same place as rounds 2, 3 and 5: the component
layer (F1, F3).

---

## B. FINDINGS

### F1. [BLOCKING] Task 12 renders an undefined `<TraceLink>` and commits; Task 13 never mounts the trace view

Plan 1446-1448, inside `ErrorRow`:

```tsx
{pivot !== null ? (
  <TraceLink kind={pivot.kind} id={pivot.id} at={event.timestamp} />
) : null}
```

`TraceLink` is defined nowhere in the plan and nowhere in the repo - I grepped
`dashboard/src` for `trace` and the only hit is the `traceparent` family in
`dashboard/src/api/types.ts`. So Task 12 ends at a commit (1459-1465) with a file
that does not compile, and **Task 12 Step 4 has no verification command at all** -
it is titled "Run tests and commit" and contains only the git block. No
`npm run typecheck`, no vitest invocation. Every other task in the plan runs
something before its commit.

Two of Task 12's own tests depend on it: "prefers requestId, then pollRunId, then
correlationId for the trace link" and "sends the row timestamp as `at` on the
trace link" (1381, 1383).

Task 13's Files block says "Modify: `RecentErrors.tsx` to mount it" (1473) and
Task 13 has **no step that does so**. Step 3 shows `ErrorTrace.tsx` only; Step 4
stages `RecentErrors.tsx` without an instruction describing the edit.

**Implies.** The tree is red between Tasks 12 and 13, which the plan's own
"green between tasks" contract forbids. More importantly this is the r5 F1
finding recurring one layer down: the spec now HAS a trace view (spec:516), and
the plan creates the component but never wires it to the link that opens it.
A builder must invent the mount, the open/close state, and where the trace
renders relative to the row - none of which the plan or the spec constrains.

Fix: define `TraceLink` (or inline the button) in Task 12, and give Task 13 an
explicit mount step plus a typecheck command in both tasks' verification steps.

---

### F2. [BLOCKING] Task 5's test cannot pass, and its stated RED is also wrong

Plan 627-633:

```ts
const svc = makeService({ config, cloudwatch: fakeSeam({ queryInsights: async () => [a, b] as never }) });
const res = await svc.getErrors('1h');
expect(res.available && res.events).toHaveLength(2);
```

`getErrors` calls `queryInsights` **three times** in one `Promise.all`
(`app/src/services/systemStatus.ts:227-234`), and one fake impl serves all three.
Two of the three results are then relabeled (`:239-240`), so the merged array is:

- `[a, b]` with `message: 'boom'`
- `[a, b]` with `message: OOM_APP_LABEL`
- `[a, b]` with `message: OOM_SYSTEM_LABEL`

Six rows. Under the new key `${ref}|${timestamp}|${message}|${errorCode ?? ''}`
all six are distinct (two refs x three messages), so `getErrors` returns **6**,
not 2. Step 4 says "Expected: PASS"; it cannot.

Step 2's RED is wrong too: it says "Expected: FAIL - one row, collapsed by
`timestamp|message|errorCode`". Under the CURRENT key the three relabeled pairs
collapse pairwise to **three** rows, not one.

The existing suite documents this exact trap and deliberately avoids asserting a
count - `app/test/systemStatus.service.test.ts:257-259`:

> `// Events from both pino query and OOM (same mock returns them all) - dedup will collapse same timestamp+message dupes`
> `// Just check the passed-through events are present`

**Implies.** A builder facing a test that stays red after a correct
implementation will either weaken the dedup key or edit the assertion to match
whatever it printed - and the assertion is the only thing proving the r3/AJ34
dedup decision. Fix: make the fake return the pair only for the pino filter
(the file already shows how at `:241`, matching on `c[1] === PINO_ERROR_INSIGHTS_FILTER`)
and `[]` otherwise.

---

### F3. [HIGH] `errMessageTruncated` is produced, mirrored, and never rendered - the spec names BOTH flags for the collapsed row

Spec 530-534:

> **TRUNCATION INDICATORS ARE RENDERED HERE - they have no other purpose.** Every
> flag the server produces is surfaced: **the two 300-char field flags in the
> collapsed row** (marking which field was cut, which is what invites the
> expander) ... A flag no slice renders is dead weight.

Plan Task 4 produces both (`messageTruncated` at 574-575, `errMessageTruncated`
at 582). Plan Task 12's row body renders one (1437):

```tsx
{event.messageTruncated ? <span className={styles.truncated}> (truncated)</span> : null}
```

and the test list is singular - "marks a truncated message and offers the
expander" (1379).

Note this is NOT the same question as whether `errMessage` is rendered. The spec
settled that separately and the plan follows it correctly: spec 520-522 says
`errMessage` is not rendered separately in the collapsed row, and plan 1457
repeats the reasoning faithfully. But the spec still requires the FLAG, because
`errMessage` is populated whenever `msg` exists and differs from it - i.e. on
every `job failed` row - and its truncation is what tells the operator the
expander has more.

The plan does deliver S4's two flags (1455: "a marker for each of
`rawTextTruncated` and `responseTruncated`") and S5's two (Task 13, 1524-1541).
`errMessageTruncated` is the one that fell out.

---

### F4. [HIGH] The `rawText` gate is keyed on guessed key names, and its test fixture cannot exercise the measured record

Task 6 (plan 796-811):

```ts
if (!isAllowedKey(key)) continue;
if (!key.startsWith('@')) appFieldCount++;
...
if (appFieldCount === 0) { /* populate rawText */ }
```

with `DROPPED_PREFIXES = ['@aws.', '@entity.', '@data_']` (775).

Fact 8 (spec 98-102) is the premise, and it describes the real record loosely:
"ONLY `@`-prefixed metadata (`@message`, `@log`, `@logStream`, `@ingestionTime`,
`@timestamp`, `@logGroupId`, **entity/account keys**) plus
`backwardToken`/`forwardToken`". The plan guesses those entity/account keys are
`@`-prefixed. If ANY key on a real non-JSON record does not start with `@` and is
not in `DROPPED_KEYS`, `appFieldCount` becomes 1 and **`rawText` is silently
`undefined` for every OOM row** - the whole reason the branch exists.

The plan's test cannot catch it. Line 735 builds a three-key record
`{'@log', '@message', '@timestamp'}` with none of the entity/account keys fact 8
actually measured, so it goes green against a shape the spike never saw.

This is precisely the failure mode the plan itself warns about at 407 and the
spec at 236-237: a permanently blank field in the ONLY environment that has data,
because the hermetic lane degrades to `unavailable_local`.

Fix, cheaply: the spike data exists - have fact 8 name the exact keys and assert
that list in the test; or gate `rawText` on something positive rather than the
absence of unknown keys (e.g. `@message` failing `JSON.parse`), which does not
depend on enumerating AWS's metadata.

---

### F5. [HIGH] Three TDD entry points name seams that do not exist, and Task 2 appends to a file that does not exist

All verified against the repo this round:

- **`app/test/errors.test.ts` DOES NOT EXIST** (`ls` returns "No such file or
  directory"). Task 2 Step 1 says "Append to" it and Step 2 runs
  `npx vitest run test/errors.test.ts` expecting "FAIL - the messages are the
  current fixed literals". The actual result is "no test files found". The
  snippet also carries no imports - `describe`/`it`/`expect`,
  `createExpressErrorHandler`, `type Logger` - so it cannot run even once created.
- **`_setLoggerForTests` does not exist.** The real seam is
  `configureJobsLogger(logger)` (`app/src/jobs/jobs.ts:82`), with
  `_resetForTests()` (`:340`) restoring `log = defaultLogger`. Task 1 Step 1 uses
  the invented name.
- **`_setOutboundQueueForTests({ send: ... })` is wrong twice.** The seam is
  `configureOutboundQueue(adapter)` (`jobs.ts:77`) and the adapter method is
  `enqueue(envelope, { delaySeconds })` (`jobs.ts:124`), not `send`. Task 3
  Step 1 uses both invented names.

The plan hedges honestly in two places ("If `_setLoggerForTests` does not exist
under that exact name, use whatever seam ... already uses"; "Mirror whatever
queue/context seams `app/test/jobs.test.ts` already uses"). That is better than
asserting them - but it leaves three of the first four backend RED steps to be
re-derived, and Task 2's file does not exist at all, which no hedge covers.

---

### F6. [HIGH] Tasks 12 and 13 have empty test bodies, so their RED state is green

Task 12 Step 1 (plan 1376-1384) is seven `it()` calls with empty or
comment-only bodies:

```ts
it('renders the source chip for all four values', () => { /* app | worker | system | unknown */ });
it('renders a jobName chip when present, else the event chip', () => {});
...
```

Task 13 Step 1 (1477-1484) is three empty bodies plus one with a comment.

An empty `it()` PASSES in Vitest. Task 12 Step 2 says "Run to verify they fail" -
all seven will pass, so the step proves nothing and the builder has no signal
that the implementation is needed. Task 13 Step 2's "Expected: FAIL - module does
not exist" is true only because the import throws, not because any assertion
fails; once `ErrorTrace.tsx` exists as an empty component, all four go green.

Every backend task in this plan writes real assertions with real expected values.
The two UI tasks - the layer that lost a decision in rounds 2, 3 and 5, and that
loses two more here (F1, F3) - are the only ones that do not.

---

### F7. [MEDIUM] Task 3's second test is a tautology over the `??` operator

Plan 1321-1324:

```ts
it('still resolves correlationId to jobRunId inside a dispatched job', async () => {
  const ctx = { pollRunId: 'poll-abc', jobRunId: 'run-1' };
  expect(ctx.jobRunId ?? ctx.pollRunId).toBe('run-1');
});
```

No repo code is imported or executed. It passes identically before and after
Task 3, and would pass if `jobs.ts` were deleted.

The spec's testing section asks for something real - that `correlationId`
resolution is unchanged inside a dispatched job - and it is testable: the mixin
at `app/src/lib/logger.ts:228-233` computes
`correlationId = jobRunId ?? pollRunId ?? requestId ?? bootId` and spreads the
whole context, so a line captured from inside `dispatchJob` should carry
`correlationId === <jobRunId>` **and** `pollRunId === 'poll-abc'` as separate
fields. That assertion would genuinely fail if S2 were implemented by overwriting
the ladder instead of adding a field.

---

### F8. [MEDIUM] The 64 KB response bound is not a bound when `err.stack` is absent

Task 6 (plan 812-817):

```ts
if (JSON.stringify(fields).length > RESPONSE_BOUND_BYTES) {
  const stack = fields['err.stack'];
  if (stack !== undefined) fields['err.stack'] = stack.slice(0, RESPONSE_BOUND_BYTES / 2);
  responseTruncated = true;
}
```

If the oversize comes from anywhere other than `err.stack` - a large app-authored
field, an `err.message` from an `AggregateError`, several big non-`err` fields -
nothing is truncated, `responseTruncated` is set to `true` anyway, and the
response still exceeds the bound. The flag reports a truncation that did not
happen, and the constraint the plan lists in Global Constraints ("The S4 response
bound is **64 KB**") is not enforced.

Also `.length` counts UTF-16 code units against a constant named
`RESPONSE_BOUND_BYTES`; a stack full of non-ASCII would pass the check while
exceeding 64 KB on the wire. Minor next to the first point, but the name asserts
bytes.

---

### F9. [MEDIUM] The new route tests omit the auth headers every existing test in the file sets

Task 7 Step 1 (plan 882-883) and Task 9 Step 1 (1141-1147):

```ts
await request(app).get('/api/system/errors/detail').expect(400);
await request(app).get('/api/system/trace?at=...').expect(400);
```

Every existing test in `app/test/system.routes.test.ts` sets both headers - e.g.
`:79`: `.set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE)`. The
router applies `requireRole('admin')` to every route
(`app/src/routes/system.ts:45`) and the app sits behind the origin-secret
middleware, so these requests answer 403, not 400 or 200.

The consequence is worse than a red test: they fail for a reason unrelated to the
code under test, and they keep failing after a correct implementation - the same
shape as F2.

---

### F10. [MEDIUM] Task 6 pre-stubs `queryTrace` against an interface that does not gain it until Task 8

Task 6 Step 4 (plan 833-838) adds to `fakeSeam`:

```ts
queryTrace: vi.fn(impl.queryTrace ?? (async () => [])),
```

`impl` is typed `Partial<CloudWatchClientSeam>`
(`app/test/systemStatus.service.test.ts:41`), and `queryTrace` is not added to
`CloudWatchClientSeam` until Task 8. So `impl.queryTrace` is
"Property 'queryTrace' does not exist on type 'Partial<CloudWatchClientSeam>'" -
a typecheck error at Task 6, whose Step 5 explicitly runs `npm run typecheck` and
expects PASS.

The plan's instinct is right (the fake should be edited once), but the forward
reference has to go the other way: add `queryTrace` to the seam interface in
Task 6 with its Task 8 signature, or move the stub to Task 8. The `getLogRecord`
half is correctly ordered and the plan's diagnosis of WHY it is a typecheck
failure rather than a runtime throw (831) is exactly right.

---

### F11. [LOW] The anchor-present guarantee has one unstated hole, and the anchor marker fails silently when it bites

BEFORE is `sort @timestamp desc | limit 25` over `[startSec, anchorSec]`
(plan 1099). It returns the 25 NEWEST rows in that window. If 25 or more lines
share the anchor's whole second AND carry a higher millisecond than the anchor,
the anchor is pushed out of its own trace.

That is rare but not absurd for the widest pivot: a `pollRunId` fan-out logs one
"job enqueued (SQS)" line per job (`app/src/jobs/jobs.ts:125-128`), and those can
land in a single second. When it happens, Task 13's marker
(`line.timestamp === at`, plan 1531) matches nothing and the view renders a
timeline with no "this failure" row - which reads as "the failure is not in its
own trace" with no explanation.

Worth one sentence in Task 13: if no line matches the anchor, say so.

---

### F12. [LOW] Task 11's imports are required by Task 15 and never added by Task 11

Task 15 Step 2 (plan 1617) says: "Task 11 added imports ABOVE the cited ranges in
`useSystemStatus.ts`, so these three MUST be updated TOGETHER" - the import shift
is the entire reason the ledger moves. Task 11 itself (1298-1354) shows only the
two hook bodies and never instructs the builder to import
`getSystemErrorDetail`, `getSystemTrace`, `SystemErrorDetailResult` or
`SystemTraceResult`. Same omission in Task 12 for `useState` and `useErrorDetail`
in `RecentErrors.tsx`, which currently imports neither.

Trivial for a builder, but Task 15's correctness depends on an edit Task 11 never
tells anyone to make.

---

## C. WHAT THE PLAN GETS RIGHT (do not re-litigate)

- **Global Constraints (15-31)** is the single best feature of this plan: the
  exact constants, the accessor-shape rule, the HTTP contract and the second
  boundary in one place, stated as values rather than prose. It is what makes
  most of section A come out green.
- **The second-granularity split** (22, 1090-1100) is correct, is explained with
  the reason `ceil` is wrong, and is pinned by a test that asserts disjointness
  directly (1001).
- **Task 2's "why this matters more than its size suggests"** (162) is exactly
  right and names the trap: a concrete path in `msg` typechecks, lints and
  renders fine, and only one assertion stands between it and a tenant's phone
  number in a field Task 15 simultaneously teaches operators to grep.
- **The perf ledger** (1615-1625) - all three citations verified correct, and the
  failure mode is stated precisely ("Leaving them stale keeps every gate green
  while the ledger silently lies; updating only `routes.ts` turns
  `collect.test.ts` red").
- **`SOURCE_LABEL: Record<SystemErrorEvent['source'], string>`** (1413) makes a
  missing fourth branch a compile error rather than a runtime blank. That is the
  right way to deliver AJ28.
- Task 14 correctly refuses to run terraform and defaults to the scoped statement.

---

## D. CAN A BUILDER EXECUTE THIS AS WRITTEN?

**No - but the gap is mechanical, not conceptual.**

Every decision from five review rounds is present in the plan except two, and
both of those are in the component layer: `errMessageTruncated` is produced and
not rendered (F3), and the trace view is created and not mounted (F1). The
backend is complete and, in the case of the two-query split, better specified
than the spec itself.

What stops literal execution:

- **F1 and F2 stop the tree being green.** Task 12 commits a file referencing an
  undefined component with no verification step; Task 5's test cannot pass after
  a correct implementation. Both are places where a builder without context will
  "fix" the wrong side - weakening the dedup key or the assertion.
- **F5, F6 and F9 mean the TDD loop does not work** for Tasks 1, 2, 3, 7, 9, 12
  and 13: three invented seams, one missing file, seven empty test bodies that
  pass, and route tests that 403.
- **F4 and F8 are silent-failure risks** that no gate can see, in exactly the
  environment shape the spec spent two rounds learning to distrust.

None of this requires a decision. It requires: define `TraceLink` and the trace
mount; fix Task 5's fake to answer per-filter; render the second truncation flag;
name fact 8's keys and assert them; create `app/test/errors.test.ts` with imports;
replace three seam names with `configureJobsLogger` / `configureOutboundQueue` /
`enqueue`; write real bodies for the fourteen UI tests; add the auth headers;
move the `queryTrace` stub; enforce the 64 KB bound on something other than
`err.stack`; and add a typecheck step to Tasks 12 and 13.

With those, I would call it executable. I would not hand it to a builder before
F1, F2, F5, F6 and F9 are fixed, because five of the fifteen tasks currently
cannot complete their own stated steps.
