# Cold adversarial review - plan `2026-08-24-error-surface-detail.md`

Reviewer had no prior context. Every claim below cites a file:line actually read in
`W:\tmp\error-surface-detail`. Read-only: no source edited, no gate run.

Question answered: **if a builder with no context executes this plan literally, do
they produce the spec?** Answer: no. Three tasks do not compile as written, one
required spec deliverable (the e2e extension) has no task at all, and four tasks
end in a commit that leaves a required gate red.

The plan is unusually strong on the two hardest mechanisms (the second-granularity
trace split and the `err` allowlist). The failures are concentrated in the places
where it stopped verifying against the repo: test-file existence, test harness
shape, the service interface, and the dashboard component's existing contract.

---

## BLOCKING

### B1. Task 4 leaves `npm run typecheck` red, and Task 6 Step 5 asserts it passes

`app/package.json:13` runs three projects:
`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.scripts.json && tsc -p tsconfig.test.json`.
So `app/test/**` **is** typechecked (this is also what makes the spec's `fakeSeam`
argument at S4 true).

Task 4 makes `source`, `ref`, `messageTruncated` and `errMessageTruncated` REQUIRED
on `ErrorEventView`. `app/test/systemStatus.service.test.ts` builds eight
`ErrorEventView` literals that carry only four keys:

- `:250`, `:251` (the `events` passthrough fixture)
- `:317` (the Twilio `fail` fixture)
- `:343`, `:346`, `:349` (the OOM merge fixture)
- `:394` (the V8 label fixture)
- `:408` (`dup`, the dedup fixture)

Each is contextually typed against `fakeSeam(impl: Partial<CloudWatchClientSeam>)`
(`:40-50`), so each becomes a hard assignability error the moment Task 4 lands.

Task 4's file list, its Step 4 (`npx vitest run ...` - esbuild strips types, so it
is GREEN), and its Step 5 commit (`git add app/src/adapters/cloudwatch.ts
app/test/cloudwatch.adapter.test.ts`) all omit this file. The branch is therefore
typecheck-red across Task 4 and Task 5, and **Task 6 Step 5's "Then: `npm run
typecheck` / Expected: both PASS" is factually wrong** - the builder hits eight
errors in a file Task 6 never told them to touch and has no instruction for what
`ref`/`source` those fixtures should carry.

Note the trap inside the trap: `:408`'s `dup` is a SINGLE object returned twice, so
giving it one `ref` keeps the dedup test passing; giving each returned row a
distinct `ref` (the obvious "make them realistic" move) makes Task 5's own dedup
change break that test. The plan says nothing.

**Fix:** Task 4 must enumerate and update those eight literals and stage
`app/test/systemStatus.service.test.ts`, and must run `npm run typecheck` in its own
Step 4.

### B2. `TraceLink` is rendered by Task 12 and defined by no task

Task 12 Step 3's `ErrorRow` body contains:

```tsx
{pivot !== null ? (
  <TraceLink kind={pivot.kind} id={pivot.id} at={event.timestamp} />
) : null}
```

`TraceLink` appears nowhere else in the plan, in `dashboard/src/routes/settings/`,
or anywhere in `dashboard/src`. Task 13 creates `ErrorTrace` with a different
contract (`{kind, id, at}` but it is the trace VIEW, self-fetching via
`useErrorTrace`) and its Step 3 gives no mounting code at all - only the file list
line "Modify: `RecentErrors.tsx` to mount it".

Consequence: Task 12 does not compile, so its Step 4 commit is red, and Task 13
inherits an undefined symbol it was never told to resolve. The spec (S6) requires
both a trace LINK on the collapsed row and a trace VIEW; the plan delivers the view
and leaves the link as a dangling identifier.

### B3. Neither Task 7 nor Task 9 extends the `SystemStatusService` interface

`app/src/services/systemStatus.ts:109-121` declares `SystemStatusService` with
exactly `getFlags` / `getAlarms` / `getErrors`, and
`createSystemStatusService(deps): SystemStatusService` (`:152`) returns an OBJECT
LITERAL. TypeScript applies excess-property checking to an object literal returned
against a declared return type, so adding `getErrorDetail` (Task 7 Step 3) or
`getTrace` (Task 9 Step 3) to that literal is an error, and
`service.getErrorDetail(ref)` in `app/src/routes/system.ts` (Task 7 Step 4) is
"Property 'getErrorDetail' does not exist on type 'SystemStatusService'".

The plan's "Interfaces / Produces" line for Task 7 names
`getErrorDetail(ref: string): Promise<DetailResult>` but **never declares
`DetailResult`**, and Task 9 never declares the trace-side result type at all. Both
tasks' "Expected: PASS" verification steps are unachievable.

Related: `getTrace`'s implementation snippet returns `{ available: true, ...trace }`,
which spreads `lines | truncatedBefore | truncatedAfter` - a union member the plan
never writes down, and which Task 10 is then asked to mirror.

---

## HIGH

### H1. `app/test/errors.test.ts` does not exist, and the test code it contains does not typecheck

Task 2 says "Append to `app/test/errors.test.ts`" and Step 2 predicts a specific
assertion failure. `ls app/test/` has no `errors.test.ts`; the only related files
are `app/test/errorSummary.test.ts` and `app/test/app.test.ts` (the only file
importing `createExpressErrorHandler`, `app/src/app.ts:17`, `:300`). Step 2's RED
state is a module-not-found, and because the plan assumed "append", it supplies no
`import { describe, it, expect } from 'vitest'`, no
`import { createExpressErrorHandler } from '../src/lib/errors.js'`, and no
`import type { Logger } from '../src/lib/logger.js'`.

Worse, once the file exists the code still fails `tsc -p tsconfig.test.json`:

```ts
const res = { headersSent: false, status: () => res, json: () => res };
const sent = { headersSent: true, status: () => sent, json: () => sent };
```

These are self-referential initializers - TS7022/7023, "'res' implicitly has type
'any' because it does not have a type annotation and is referenced directly or
indirectly in its own initializer" - under `strict: true`
(`tsconfig.base.json:3`). All three of Task 2's tests use this shape.

The PII refusal is, by the plan's own Step-0 prose, "the highest-consequence rule in
the slice" and "nothing but Step 1's second test asserts this." Shipping it behind a
test file that does not compile is exactly the failure the prose warns about.

### H2. The route tests in Tasks 7 and 9 cannot pass - the harness needs an origin header and an admin cookie

`app/test/system.routes.test.ts:9-40` shows the real idiom:

```ts
const { app } = makeWebhookHarness();
await request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE)
```

Every `/api/system/*` route sits behind `requireRole('admin')`
(`app/src/routes/system.ts:45`) plus the CloudFront origin-secret validator. The
plan's tests are bare:

```ts
await request(app).get('/api/system/errors/detail').expect(400);
```

`app` is never constructed, and without the two `.set(...)` calls the response is
401, not 400 - so the test is red before AND after the implementation, for the wrong
reason.

### H3. Task 9's "degrades on a non-UUID id" test can never be red, so the validation ships untested

`makeWebhookHarness()` builds the hermetic stack with the console messaging driver,
so `isLocalEnv(config)` (`app/src/services/systemStatus.ts:137-139`) is TRUE and
`getTrace`/`getErrorDetail` return `{available:false, reason:'unavailable_local'}`
**before** `UUID_PATTERN` / `REF_PATTERN` are ever evaluated. Therefore:

```ts
it('degrades (200) on a present-but-non-UUID id', async () => {
  await request(app).get('/api/system/trace?correlationId=not-a-uuid&at=...').expect(200);
});
```

is green against a route with *no id validation whatsoever*. Same for Task 7's
`?ref=!!!!!` -> 200. The spec calls the 400-vs-degraded-200 split a required test for
both S4 and S5; the plan's version asserts nothing. The id check is the one guarding
"attacker-influencable input entering a query language" (spec S5), and Task 8
interpolates it raw: `` const filter = `${kind} = "${id}"` ``.

The service-level tests have the mirror problem: Task 7 and Task 9 both write
`makeService({ config, ... })` with a bare `config`, but this file's default
(`localConfig()`, `:29-31`) short-circuits. Both need `deployedConfig()` (`:34-37`).

### H4. Task 12 silently deletes existing UI and turns three passing tests red

Current `ErrorRow` (`dashboard/src/routes/settings/RecentErrors.tsx`, the
`function ErrorRow` block) renders three things Task 12's replacement drops:

1. the `error <code>` chip (`{code} -> <span className={styles.errorCode}>error {code}</span>`)
2. the `id: <correlationId>` line (`<span className={styles.errorCorrelation}>`)
3. the warn-level styling (`isWarn ? styles.errorLevelWarn : ''`)

`dashboard/src/routes/settings/RecentErrors.test.tsx` pins all of them:

- `:79` `expect(screen.getByText(/id:\s*corr-9/)).toBeInTheDocument()`
- `:81` `expect(screen.getAllByText(/^id:/)).toHaveLength(1)`
- `:100` `expect(screen.getByText('error 30034')).toBeInTheDocument()`

Task 12 never mentions preserving them or updating the tests, and its commit stages
`RecentErrors.test.tsx`, so the builder is nudged toward deleting the assertions.
Losing the `errorCode` chip is a real regression: it is the Twilio failure-code
affordance the panel was extended for (`app/test/systemStatus.service.test.ts:313+`
still asserts the backend surfaces it). Spec S6's collapsed-row list is additive
prose, not a mandate to remove existing fields.

### H5. `errMessageTruncated` (and `errMessage`) are produced and rendered nowhere

Spec S6 is explicit: "**TRUNCATION INDICATORS ARE RENDERED HERE - they have no other
purpose.** Every flag the server produces is surfaced: **the two 300-char field
flags in the collapsed row** (marking which field was cut) ... A flag no slice
renders is dead weight."

Task 4 produces `errMessage` + `errMessageTruncated`. Task 12 renders
`messageTruncated` only, and its prose actively forbids the other: "Do NOT render
`errMessage` as a separate line in the collapsed row." The expanded view reads
`err.message` from the S4 DETAIL record, not from `errMessage`. Task 12's test list
has no assertion for it either. Net: one of the two mandated flags is dead, and
`errMessage` itself is a wire field with zero readers.

Either Task 12 must render an `errMessage`-truncated marker (the flag's stated
purpose) or Task 4 must stop emitting the pair - but the plan cannot both produce
and ignore it while the spec says otherwise.

### H6. No task extends the e2e System Status spec

Spec §7: "**e2e**: the panel degrades to 'Available in deployed environments.' on
the hermetic stack - the only reachable state without AWS. **Extend the existing
System Status spec.**" That spec exists:
`e2e/tests/dashboard-next/settings.spec.ts:131-137` drives the System status tab.

No task in the plan touches `e2e/tests/`. Task 15 covers `e2e/performance/` only.
The Final Gates run `npm run e2e` but running an unextended suite is not the
deliverable. A named spec obligation is simply undelivered.

### H7. Task 6's 64 KB "bound" does not bound anything

```ts
let responseTruncated = false;
if (JSON.stringify(fields).length > RESPONSE_BOUND_BYTES) {
  const stack = fields['err.stack'];
  if (stack !== undefined) fields['err.stack'] = stack.slice(0, RESPONSE_BOUND_BYTES / 2);
  responseTruncated = true;
}
```

Three defects:

1. When `err.stack` is absent the payload is returned **unchanged and oversized**,
   with a flag claiming it was truncated. Spec S4: "RESPONSE SIZE BOUND: 64 KB, with
   a flag when truncated."
2. Even with a stack, there is no re-check: a record with a 60 KB stack and 40 KB of
   app-authored fields still exits at ~70 KB.
3. `.length` counts UTF-16 code units, not bytes, on a constant literally named
   `RESPONSE_BOUND_BYTES`. Log text is a UTF-8 wire payload.

The flag is also the one the UI shows, so the operator is told the record was cut
when it was not - the opposite of the "a trace that silently omits lines is worse
than no trace" principle the spec applies to S5.

### H8. Task 14 defaults `logs:GetLogRecord` to the branch that breaks the feature

`infra/modules/ec2/main.tf` already records the answer for this exact action family:

```hcl
# StartQuery IS resource-scopable to this env's groups;
# GetQueryResults + StopQuery do NOT support resource-level permissions ("*").
...
statement {
  sid       = "SystemStatusInsightsResults"
  actions   = ["logs:GetQueryResults", "logs:StopQuery"]
  resources = ["*"]
}
```

`logs:GetLogRecord` is in that same non-resource-scopable family (no resource type
in the Service Authorization Reference). An IAM statement that scopes an action
which does not support resource-level permissions denies the action outright.

Task 14 Step 1 tells the builder to "DEFAULT TO THE SCOPED STATEMENT" and consult
AWS docs - a call the builder may not be able to make offline. Step 3 runs only
`terraform fmt -check && terraform validate`, which cannot see this. No gate reaches
AWS. So a wrong guess ships, the human applies it, and the expander degrades
FOREVER, indistinguishable from the plan's own documented "until applied, the detail
expander 403s and degrades" note in the handback.

The spec's fallback wording ("only on a cited AWS Service Authorization Reference
entry") is the right rule but the default is inverted for this action. At minimum
Task 14 must record the evidence for whichever branch it takes, and the handback
must tell the human to verify the expander resolves a real record post-apply.

---

## MEDIUM

### M1. Task 1 and Task 3 name test seams that do not exist

- Task 1 uses `_setLoggerForTests(log as unknown as Logger)`. The real seam is
  `configureJobsLogger(logger)` (`app/src/jobs/jobs.ts:82`), and
  `app/test/jobs.test.ts:46` uses
  `configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }))`
  - a pino instance writing to a stream, **not** an `(obj, msg)` callback pair. The
  plan's `lines.push({obj,msg})` capture shape does not exist in this file at all;
  the builder must go read `test/helpers/logCapture.ts` and rewrite the assertion
  against serialized JSON lines.
- Task 3 uses `_setOutboundQueueForTests({ send: async (e) => ... })`. The real seam
  is `configureOutboundQueue(adapter: OutboundQueueAdapter)` (`jobs.ts:77`) and the
  adapter method is `enqueue(envelope, { delaySeconds })`, not `send`
  (`jobs.ts:124`).

Both are hedged with "mirror whatever seam exists" - which is the plan outsourcing
its own verification step to the builder in the middle of a TDD RED phase, exactly
where a wrong seam produces a confusing failure.

### M2. Task 3's second test is a tautology

```ts
it('still resolves correlationId to jobRunId inside a dispatched job', async () => {
  const ctx = { pollRunId: 'poll-abc', jobRunId: 'run-1' };
  expect(ctx.jobRunId ?? ctx.pollRunId).toBe('run-1');
});
```

This asserts the behavior of `??` on a locally-declared literal. It imports nothing,
calls nothing under test, and is green before the change, after the change, and
after a change that inverted the ladder. Spec §7 S2 requires "correlationId
resolution is unchanged inside a dispatched job"; the real thing to assert is the
mixin at `app/src/lib/logger.ts:231`
(`ctx.jobRunId ?? ctx.pollRunId ?? ctx.requestId ?? ctx.bootId`) observed on a line
logged INSIDE `dispatchJob`, which the file already has the machinery for.

### M3. `getLogRecord`'s "no rawText for a parsed record" is enforced by a proxy that can be false

The plan's own comment states the rule: "A parsed record NEVER gets rawText -
returning the original line would hand back the very nests the allowlist above just
dropped." The guard implements something else:

```ts
if (appFieldCount === 0) { rawText = String(record['@message'] ?? ''); }
```

A JSON record whose only non-`@` keys are dropped `err.*` nests yields
`appFieldCount === 0` and returns the complete raw line - including
`err.config.params`, the exact bypass spec S4 forbids ("Returning the raw `@message`
alongside allowlisted fields would defeat the allowlist completely"). In practice
pino always emits `level`/`time`/`pid`/`hostname`, so this is hard to reach - but the
security invariant is holding by coincidence rather than by construction, which is
the whole argument for the allowlist in the first place (spec §6, A.4). Gate on an
actual `JSON.parse` of `@message` instead of on a field count.

### M4. `sourceOf` matches suffixes, not the three configured log-group names

Spec S3: "Derive by normalising `@log` per fact 7 and **matching the three
configured names**; anything else is `unknown`."

Plan Task 4:

```ts
if (name.endsWith('/app')) return 'app';
if (name.endsWith('/worker')) return 'worker';
if (name.endsWith('/system')) return 'system';
```

`config.ts` builds those names from `appEnv`
(`errorLogGroupName = `/hc/${appEnv}/app``, `:524-526`), so `/hc/prod/app` read
from a dev box maps to the `app` chip rather than `unknown`. That matters precisely
on the surface S4's environment scope check exists to defend. The structural reason
the plan deviated is that `projectErrorEvent` is a free module function with no
`config` in scope - a plumbing decision the plan makes implicitly and never states.

### M5. The dashboard result types' SHAPE is unspecified, and Task 13 depends on it

Task 10 Step 1 says only "Mirror `ErrorEventView`, `LogRecordView`, `TraceLineView`
and `TraceResult` field-for-field." The existing mirror precedent is a NON-union
interface:

```ts
export interface SystemErrorsResult {
  available: boolean;
  events?: SystemErrorEvent[];
  reason?: string;
}
```
(`dashboard/src/api/types.ts`, the `SystemErrorsResult` block)

Task 13 then writes narrowing that only compiles against a DISCRIMINATED UNION:

```ts
if (!result.available) return <p>...</p>;
if (result.lines.length === 0) { ... }
```

Follow the precedent and `result.lines` is `SystemTraceLine[] | undefined`;
`.length` is a typecheck error. Task 10 must state the union shape explicitly.

### M6. Task 13 imports `SystemTraceLine`, a name no task creates

`import type { SystemTraceLine } from '../../api/index.js';` Task 10 names only
`SystemErrorDetailResult` and `SystemTraceResult`. The barrel does
`export * from './types.js'` (`dashboard/src/api/index.ts:3`) so the re-export is
fine, but the type itself never gets declared under that name.

### M7. Tasks 6 and 8 write tests against scaffolding that does not exist and does not typecheck

- Task 6 uses `seamWithLogs({ send: ... })` and `rec({...})`. Neither exists in
  `app/test/cloudwatch.adapter.test.ts`; the file's idiom is
  `createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: { send } as never })`
  with `vi.fn().mockResolvedValueOnce(...)` chains.
- Task 8 uses a bare `seam` and a bare `starts` array with no construction at all.
  Building `queryTrace`'s fake is materially harder than the plan implies: two
  `StartQuery` + at least two `GetQueryResults` calls, issued CONCURRENTLY under
  `Promise.all`, so `mockResolvedValueOnce` ordering is not deterministic - the fake
  must dispatch on `command instanceof StartQueryCommand` / on `queryId`. The plan's
  `starts.find((s) => s.input.queryString.includes('desc'))` implies this but never
  says it.
- `expect(starts[0].input.startTime)` violates `noUncheckedIndexedAccess: true`
  (`tsconfig.base.json:12`) - needs `starts[0]!`. Task 2 gets this right (`lines[0]!`),
  Task 8 does not.

### M8. The trace anchor's presence rests on an unverified `endTime` inclusivity assumption

BEFORE ends at `Math.floor(atMs / 1000)`; AFTER starts at `+ 1`. The spec asserts
"the anchor line is guaranteed present because its own second is in the BEFORE
half." That holds only if Insights' `StartQuery.endTime` is INCLUSIVE. §3's spike
measured pointer lifetime, charset, flattening, stringification and `@log` shape -
it did not measure range inclusivity. If `endTime` is exclusive the anchor second
falls in NEITHER window, the failure line vanishes from its own trace, and Task 13's
`line.timestamp === at` marker silently never renders. Every test uses an injected
fake, and the hermetic lane never reaches CloudWatch, so nothing catches it.

This is not Appendix A.9 (that is about single-vs-two queries). It is a distinct,
unmeasured boundary fact that the whole S5 guarantee rests on.

---

## LOW

### L1. Task 4 never states that `projectErrorEvent` must be exported, or imported by the test

Today it is module-private: `function projectErrorEvent(rawMessage, eventTimestampMs)`
(`app/src/adapters/cloudwatch.ts:123`), and `app/test/cloudwatch.adapter.test.ts`
imports only `createCloudWatchClient` and the four filter constants. Step 1's tests
call `projectErrorEvent(...)` directly with no import line; the `export` appears
later, buried in Step 3's implementation blob.

### L2. Task 12 uses two CSS classes that no task adds

`styles.errorChip` and `styles.truncated` do not exist in
`dashboard/src/routes/settings/SystemStatusSection.module.css` (it has
`.errorCorrelation:292` and `.errorCode:308`). Only Task 13 says to add
`.truncated`. CSS-module index access is `string | undefined`, so `className`
accepts it silently - the source chip, the jobName chip, the errType chip and the
"(truncated)" marker all render unstyled with no error anywhere.

### L3. Task 15 re-lists comment sites that Task 4 already rewrote

`app/src/adapters/cloudwatch.ts:78`, `:84-85`, `:90-92` are inside the
`ErrorEventView` interface that Task 4 replaces wholesale, and `:116-122` is the
`projectErrorEvent` docblock that Task 4's Step 3 replaces with the new PII posture.
By Task 15 those line numbers point somewhere else entirely. Only `:12-14` (file
header) and `:104` (seam doc) genuinely survive to Task 15.

### L4. Perf-ledger citations rot between Task 11 and Task 15

Task 11 adds four imports to `dashboard/src/routes/settings/useSystemStatus.ts:12-20`,
shifting the ranges pinned at `e2e/performance/routes.ts` (`'/settings/system'`
base: `useSystemStatus.ts:77-132`; `background.systemAlarms`:
`useSystemStatus.ts:124-132`) and mirrored at `e2e/performance/collect.test.ts:353`.
Task 15 fixes them four tasks later. No gate goes red in between - which IS the rot
the spec describes - so this is a discipline risk only, but it means the ledger is
knowingly wrong across four commits.

### L5. Global Constraints attributes terraform to the wrong task

"Task 15 writes terraform; the human applies it." Terraform is Task 14. The File
Structure table gets it right.

### L6. Spec-named tests with no task

Three §7 obligations have no corresponding step anywhere:

- S4 "stringified coercion" (fact 5: `level` came back as the STRING `"30"`). Task 6
  applies `String(value)` blindly and never tests it.
- S5 "the two queries run in parallel".
- S6 "every truncation indicator renders" (see H5).

### L7. Task 6 drops `@timestamp` from the detail response

`DROPPED_KEYS` includes `'@timestamp'`. Spec §3 fact 6 lists it as present on the
record and the S4 stated key set neither includes nor excludes it. Dropping the log
event's own timestamp from a "full record" detail view is a defensible call but an
undocumented one.

---

## What IS verified and correct (so a fix wave does not churn it)

Checked against the repo and confirmed accurate:

- `app/src/jobs/jobs.ts:332` `'job failed'`; `:174-179` the four-field
  `correlationContext`; `CorrelationContext.pollRunId` exists
  (`app/src/lib/context.ts:33`).
- `app/src/lib/errors.ts:140-143` / `:152-155` / `:159-162` - three log calls, the
  two error branches DO share the literal, and `:154` DOES carry a real em-dash.
- `app/src/adapters/cloudwatch.ts:227` query string; `:254-261` row loop discarding
  every cell but two; `:123-148` `projectErrorEvent`; `:79-94` `ErrorEventView`.
- `app/src/services/systemStatus.ts:247` dedup key; `:239-240` OOM relabel;
  `:137-139` `isLocalEnv`.
- `app/test/systemStatus.service.test.ts:40-50` `fakeSeam` returns a hardcoded
  literal typed as the full seam - adding a required method IS a typecheck failure.
- `dashboard/src/api/client.ts` `buildUrl` uses `URLSearchParams`, which
  percent-encodes `+`, `/` and `=`; the pointer transport reasoning holds.
- `dashboard/src/routes/settings/RecentErrors.test.tsx:67-68`, `:88-92` are the
  four/five-key fixtures the spec predicts; the dashboard `tsconfig.json` includes
  `src`, so they DO break typecheck at Task 10.
- `infra/modules/jobs/main.tf` `visibility_timeout_seconds = 120`,
  `maxReceiveCount = 5`; `infra/modules/ec2/main.tf` `SystemStatusInsightsStart`
  scoped to `/hc/${var.env}/*` and using `data.aws_region.current.region`;
  `/var/log/messages` -> `/hc/${var.env}/system`.
- `RUNBOOK.md:2169` DLQ row; `app/src/adapters/messaging.ts:700`;
  `docs/issues/fake-twilio-messaging-attach-404.md:45`; nothing else asserts the
  literal `job failed`.
- `app/src/routes/contacts.ts` `/:contactId/phones/:phone` (PATCH and DELETE) and
  `app/src/routes/relayGroups.ts` `/conversations/:conversationId/members/:phone` -
  the E.164-in-path claim is real.
- `app/src/lib/logger.ts` redact list (three literal `err.config` paths, no wildcard)
  and the mixin's `jobRunId ?? pollRunId ?? requestId ?? bootId` ladder.
- Express route ordering: `router.get('/errors')` matches exactly, so
  `/errors/detail` cannot be shadowed. The plan's parenthetical is correct.
- The second-granularity split (`floor` for BEFORE's end, `+1` for AFTER's start)
  and the `err` allowlist-not-denylist reasoning are both right and well argued.
