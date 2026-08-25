# Error Surface Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin System Status error panel troubleshootable - name the failing job or route in the message, widen the projection past its four-field allowlist, add a full-record detail expander and a correlation trace pivot.

**Architecture:** The data is already in CloudWatch; `projectErrorEvent` throws it away. Three read paths with DIFFERENT field shapes: the LIST and TRACE paths parse raw `@message` JSON (nested `err`), while the DETAIL path uses `GetLogRecord` (dot-flattened `err.message`). Vendor SDK error nests are excluded by an ALLOWLIST under `err`, never a denylist.

**Tech Stack:** TypeScript, Node 24, Express 5, pino 9, React, Vitest, Playwright, Terraform, AWS SDK v3 (`@aws-sdk/client-cloudwatch-logs`).

**Spec:** `docs/superpowers/specs/2026-08-24-error-surface-detail-design.md`

**Decision record:** `docs/superpowers/reviews/2026-08-24-error-surface-detail-design-review.md` - read this before proposing a change to any decision below. 87 findings across 5 rounds are already adjudicated there, and Appendix A of the spec lists 9 alternatives that were considered and REJECTED.

## Global Constraints

Exact values, copied from the spec. Every task's requirements implicitly include this section.

- **Truncation:** `message` and `errMessage` cap at **300 characters**, each with its OWN boolean flag. `rawText` caps at **4000 characters** with its own flag. The S4 response bound is **64 KB** with its own flag.
- **Trace row budget:** **25 rows per side**, 50 max merged.
- **Trace bracket, id-dependent:** `correlationId` -> `at - 5 min` to `at + 5 min`. `requestId` or `pollRunId` -> `at - 30 min` to `at + 5 min`.
- **Trace second boundary:** BEFORE uses `endTime = Math.floor(atMs / 1000)`. AFTER uses `startTime = Math.floor(atMs / 1000) + 1`. Windows MUST be disjoint. Never `ceil` for BEFORE's end.
- **`source` union:** `'app' | 'worker' | 'system' | 'unknown'`. Four values everywhere - type, derivation, chip, tests.
- **`err` allowlist (S4 only):** `message`, `stack`, `type`, `name`, `code`, `status`, `response.status`. Everything else beneath `err` dropped AT ANY DEPTH. A SCALAR string `err` is KEPT.
- **Field presence:** `source` and `ref` are REQUIRED and non-null. Everything else follows the existing `errorCode?: string | null` convention.
- **Accessor shapes:** LIST and TRACE parse raw `@message` JSON - `err` is NESTED, read `(obj.err as ...).message`. DETAIL uses `GetLogRecord` - `err` is FLATTENED, read `rec['err.message']`. Never conflate.
- **HTTP contract:** a MISSING required query parameter is **400**. A PRESENT but malformed one takes the **degraded 200** (`{ available: false, reason }`). Never a 500.
- **ASCII only** in all new/touched lines - code, comments, test names, log strings (AGENTS.md).
- **Commit discipline:** bare `git status` before every commit; stage EXPLICIT paths only, never `git add -A`; `Co-Authored-By` trailer naming the authoring model.
- **Gates (bare, never piped):** `npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e`. `npm test` needs `npm run db:start`.
- **NEVER run terraform apply, deploys, secrets pushes, or SSM writes.** Task 15 writes terraform; the human applies it.

## File Structure

**Backend - app/**

| File | Responsibility | Tasks |
|---|---|---|
| `app/src/jobs/jobs.ts` | Dispatcher message; envelope correlation context | 1, 3 |
| `app/src/lib/errors.ts` | Express handler messages; route-template rule | 2 |
| `app/src/adapters/cloudwatch.ts` | ALL three read paths + the SDK boundary | 4, 6, 8 |
| `app/src/services/systemStatus.ts` | Merge/dedup; detail + trace service methods | 5, 7, 9 |
| `app/src/routes/system.ts` | The two new routes and their validation | 7, 9 |

**Frontend - dashboard/**

| File | Responsibility | Tasks |
|---|---|---|
| `dashboard/src/api/types.ts` | Hand-maintained mirror of backend contracts | 10 |
| `dashboard/src/api/endpoints.ts` | Client functions for the two new routes | 10 |
| `dashboard/src/routes/settings/useSystemStatus.ts` | Fetching, loading/error state, abort | 11 |
| `dashboard/src/routes/settings/RecentErrors.tsx` | List rows, chips, expander | 12 |
| `dashboard/src/routes/settings/ErrorTrace.tsx` (NEW) | The trace timeline view | 13 |

**Infra + docs**

| File | Responsibility | Tasks |
|---|---|---|
| `infra/modules/ec2/main.tf` | `logs:GetLogRecord` grant | 14 |
| `e2e/performance/routes.ts`, `collect.test.ts` | Source-citation ledger | 15 |
| 16 comment sites + `RUNBOOK.md` | Retire the PII-SAFE guarantee | 15 |

---

### Task 1: Self-describing job dispatcher message

**Files:**
- Modify: `app/src/jobs/jobs.ts:332`
- Test: `app/test/jobs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the log message format `job failed: <jobName>`. Task 15 updates two docs quoting the old literal.

- [ ] **Step 1: Write the failing test**

Append to `app/test/jobs.test.ts` inside the existing top-level `describe`:

```ts
it('names the failing job in the job failed message', async () => {
  const lines: { obj: Record<string, unknown>; msg: string }[] = [];
  const log = {
    info: () => {},
    warn: () => {},
    error: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }),
  };
  _setLoggerForTests(log as unknown as Logger);
  defineJobHandler('test.explodes', async () => {
    throw new Error('boom');
  });
  await expect(
    dispatchJob({
      v: 1,
      jobId: 'j-1',
      jobName: 'test.explodes',
      payload: {},
      correlationContext: {},
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      hopCount: 1,
      enqueuedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow('boom');
  const failure = lines.find((l) => l.msg.startsWith('job failed'));
  expect(failure?.msg).toBe('job failed: test.explodes');
  expect(failure?.obj['jobName']).toBe('test.explodes');
});
```

If `_setLoggerForTests` does not exist under that exact name, use whatever seam `app/test/jobs.test.ts` already uses to capture logger output - read the file's existing setup first and mirror it rather than inventing a new seam.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/jobs.test.ts -t "names the failing job"`
Expected: FAIL - received `'job failed'`, expected `'job failed: test.explodes'`.

- [ ] **Step 3: Write minimal implementation**

In `app/src/jobs/jobs.ts`, the `catch` block at 324-335. Change ONLY the message argument:

```ts
    } catch (err) {
      log.error(
        {
          err,
          jobName: envelope.jobName,
          jobId: envelope.jobId,
          durationMs: Math.round(performance.now() - startedAt),
        },
        `job failed: ${envelope.jobName}`,
      );
      throw err;
    }
```

Leave the structured fields exactly as they are - `jobName` stays a field as well as being in the message.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/jobs.test.ts`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/jobs/jobs.ts app/test/jobs.test.ts
git commit -m "feat(observability): name the failing job in the job failed message"
```

---

### Task 2: Express handler messages and the PII refusal

**Files:**
- Modify: `app/src/lib/errors.ts:137-164`
- Test: `app/test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `routeLabel(req)` is INTERNAL to `errors.ts` - do not export or reuse it elsewhere.

**Why this task matters more than its size suggests:** `req.path` can carry a raw E.164 (`app/src/routes/contacts.ts:2317`, `:2376`, `app/src/routes/relayGroups.ts:467`). Putting it in `msg` writes a tenant's phone number into a low-cardinality field that Task 15 simultaneously teaches operators to grep. Nothing but Step 1's second test asserts this, and a concrete path in `msg` typechecks, lints and renders fine.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/errors.test.ts`:

```ts
describe('express error handler messages', () => {
  function capture() {
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    const log = {
      error: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }),
    };
    return { lines, log: log as unknown as Logger };
  }

  it('does NOT put a concrete phone-bearing path in msg - it uses the route template', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = {
      method: 'DELETE',
      path: '/api/contacts/c-1/phones/+14045551234',
      baseUrl: '/api/contacts',
      route: { path: '/:contactId/phones/:phone' },
      headers: {},
    };
    const res = { headersSent: false, status: () => res, json: () => res };
    handler(new Error('boom'), req as never, res as never, () => {});
    const line = lines[0]!;
    expect(line.msg).not.toContain('+14045551234');
    expect(line.msg).toContain('/api/contacts/:contactId/phones/:phone');
    expect(line.msg).toContain('DELETE');
  });

  it('uses the (unrouted) token when req.route is unset', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = { method: 'POST', path: '/api/whatever', baseUrl: '', headers: {} };
    const res = { headersSent: false, status: () => res, json: () => res };
    handler(new Error('boom'), req as never, res as never, () => {});
    expect(lines[0]!.msg).toContain('(unrouted)');
  });

  it('gives the headers-already-sent branch a DISTINCT message', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = { method: 'GET', path: '/api/x', baseUrl: '', headers: {} };
    const sent = { headersSent: true, status: () => sent, json: () => sent };
    const notSent = { headersSent: false, status: () => notSent, json: () => notSent };
    handler(new Error('boom'), req as never, sent as never, () => {});
    handler(new Error('boom'), req as never, notSent as never, () => {});
    expect(lines[0]!.msg).not.toBe(lines[1]!.msg);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/errors.test.ts -t "express error handler messages"`
Expected: FAIL - the messages are the current fixed literals with no method or template.

- [ ] **Step 3: Write minimal implementation**

In `app/src/lib/errors.ts`, add above `createExpressErrorHandler`:

```ts
/**
 * A STABLE, low-cardinality route label for a log message.
 *
 * DELIBERATELY NOT `req.path`: three routes mount a raw E.164 as a path segment
 * (routes/contacts.ts `/:contactId/phones/:phone`, routes/relayGroups.ts
 * `/conversations/:conversationId/members/:phone`), so a concrete path would put
 * a tenant's phone number into `msg` - a field operators are taught to grep and
 * that must stay groupable. `path` remains a structured FIELD on the line.
 *
 * `req.route.path` alone is MOUNT-RELATIVE (contacts registers
 * `/:contactId/phones/:phone`, not the full path), so it is prefixed with
 * `req.baseUrl`. `req.route` is unset for middleware, body-parser and URIError
 * failures, which take the literal `(unrouted)` token.
 */
function routeLabel(req: { baseUrl?: string; route?: { path?: string } }): string {
  const path = req.route?.path;
  if (typeof path !== 'string' || path.length === 0) return '(unrouted)';
  return `${req.baseUrl ?? ''}${path}`;
}
```

Then change the three log calls. Headers-already-sent branch (`:140-143`):

```ts
      log.error(
        { err: toError(err), method: req.method, path: req.path },
        `unhandled error after response started: ${req.method} ${routeLabel(req)}`,
      );
```

`URIError` branch (`:152-155`) - note the em-dash becomes ASCII:

```ts
      log.warn(
        { err: toError(err), method: req.method, path: req.path },
        `malformed URI in request - rejected as 400: ${req.method} ${routeLabel(req)}`,
      );
```

Normal branch (`:159-162`):

```ts
    log.error(
      { err: toError(err), method: req.method, path: req.path },
      `unhandled error while handling request: ${req.method} ${routeLabel(req)}`,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/errors.test.ts`
Expected: PASS. If a pre-existing test asserts one of the old literals, update it to the new string - do not weaken the new message to satisfy it.

- [ ] **Step 5: Verify no non-ASCII survives**

Run: `cd app && LC_ALL=C tr -d '\11\12\15\40-\176' < src/lib/errors.ts | wc -c`
Expected: `0`

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/lib/errors.ts app/test/errors.test.ts
git commit -m "feat(observability): name method and route template in handler errors"
```

---

### Task 3: Propagate pollRunId through the job envelope

**Files:**
- Modify: `app/src/jobs/jobs.ts:174-179`
- Test: `app/test/jobs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pollRunId` on the envelope's `correlationContext`, and therefore on every log line of a poll-enqueued job. Task 4 projects it; Task 8 pivots on it.

**Why:** without this, the trace pivot is dead for the entire worker-poll class - tour reminders, placement nudges, roster actions, extraction, group guardrails. A poll-enqueued job's `job failed` line has `correlationId = jobRunId` and NOTHING linking back to the tick.

- [ ] **Step 1: Write the failing test**

```ts
it('propagates pollRunId into the envelope so a poll-enqueued job can be traced back', async () => {
  const enqueued: JobEnvelope[] = [];
  _setOutboundQueueForTests({ send: async (e: JobEnvelope) => void enqueued.push(e) });
  await runWithContext({ pollRunId: 'poll-abc' }, async () => {
    await enqueue('test.job', { hello: 'world' });
  });
  expect(enqueued[0]!.correlationContext).toMatchObject({ pollRunId: 'poll-abc' });
});

it('still resolves correlationId to jobRunId inside a dispatched job', async () => {
  const ctx = { pollRunId: 'poll-abc', jobRunId: 'run-1' };
  expect(ctx.jobRunId ?? ctx.pollRunId).toBe('run-1');
});
```

Mirror whatever queue/context seams `app/test/jobs.test.ts` already uses; read its existing `enqueue` tests first and match them rather than inventing `_setOutboundQueueForTests` if a different seam exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/jobs.test.ts -t "propagates pollRunId"`
Expected: FAIL - `correlationContext` has no `pollRunId`.

- [ ] **Step 3: Write minimal implementation**

`app/src/jobs/jobs.ts:174-179`:

```ts
  const correlationContext: CorrelationContext = {
    ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    // pollRunId travels so a poll-enqueued job's failure can be traced back to
    // the tick that enqueued it. Without it the whole worker-poll class (tour
    // reminders, placement nudges, roster actions, extraction, group
    // guardrails) has NO upstream id on its log lines, because dispatchJob
    // mints a fresh jobRunId that wins the correlationId ladder.
    ...(ctx.pollRunId !== undefined && { pollRunId: ctx.pollRunId }),
    ...(ctx.conversationId !== undefined && { conversationId: ctx.conversationId }),
    ...(ctx.tenantId !== undefined && { tenantId: ctx.tenantId }),
    ...(ctx.placementId !== undefined && { placementId: ctx.placementId }),
  };
```

If `CorrelationContext` does not already declare `pollRunId`, it does - see `app/src/lib/context.ts`. Confirm before adding it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/jobs.test.ts test/scheduler.test.ts test/sqsJobConsumer.test.ts`
Expected: PASS. These three files touch `correlationContext`; none pins its key set, so none should break.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/jobs/jobs.ts app/test/jobs.test.ts
git commit -m "feat(observability): carry pollRunId through the job envelope"
```

---

### Task 4: Widen the list projection

**Files:**
- Modify: `app/src/adapters/cloudwatch.ts` - `ErrorEventView` (79-94), `projectErrorEvent` (123-148), `queryInsights` (225-264)
- Test: `app/test/cloudwatch.adapter.test.ts`

**Interfaces:**
- Consumes: Task 3's `pollRunId` on the log line.
- Produces:

```ts
export type ErrorSource = 'app' | 'worker' | 'system' | 'unknown';

export interface ErrorEventView {
  timestamp: string;
  level: number;
  message: string;
  messageTruncated: boolean;
  correlationId: string | null;
  errorCode?: string | null;
  jobName?: string | null;
  event?: string | null;
  errType?: string | null;
  errMessage?: string | null;
  errMessageTruncated: boolean;
  requestId?: string | null;
  pollRunId?: string | null;
  source: ErrorSource;
  ref: string;
}

export function normalizeLogGroup(atLog: string): string;
export const FIELD_CAP = 300;
```

`projectErrorEvent` changes signature from `(rawMessage: string, ts: number)` to `(row: { field?: string; value?: string }[])` - it now reads `@ptr` and `@log` off the row itself.

**CRITICAL:** the LIST path parses raw `@message` JSON, where `err` is a NESTED object. `obj['err.message']` is `undefined` here. That dotted form belongs to Task 6 only.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/cloudwatch.adapter.test.ts`:

```ts
describe('projectErrorEvent - widened projection', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const row = (msg: string, ts = '2026-08-24 10:00:00.000', ptr = 'PTR1', log = '9:/hc/dev/app') => [
    { field: '@timestamp', value: ts },
    { field: '@message', value: msg },
    { field: '@ptr', value: ptr },
    { field: '@log', value: log },
  ];

  it('reads a NESTED err object, not a dotted key', () => {
    const ev = projectErrorEvent(row(line({ level: 50, msg: 'job failed: relay.warm', err: { message: 'boom', type: 'RestException' } })));
    expect(ev.errMessage).toBe('boom');
    expect(ev.errType).toBe('RestException');
  });

  it('derives source from @log, stripping the account prefix', () => {
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), undefined, 'P', '938565869261:/hc/dev/worker')).source).toBe('worker');
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), undefined, 'P', '938565869261:/hc/dev/system')).source).toBe('system');
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), undefined, 'P', '938565869261:/hc/dev/nope')).source).toBe('unknown');
  });

  it('caps message and errMessage independently at 300 chars with their own flags', () => {
    const long = 'x'.repeat(400);
    const ev = projectErrorEvent(row(line({ level: 50, msg: long, err: { message: 'short' } })));
    expect(ev.message).toHaveLength(300);
    expect(ev.messageTruncated).toBe(true);
    expect(ev.errMessageTruncated).toBe(false);
  });

  it('falls back msg -> event -> err.message -> placeholder', () => {
    expect(projectErrorEvent(row(line({ level: 50, event: 'relay_provisioning_failed' }))).message).toBe('relay_provisioning_failed');
    expect(projectErrorEvent(row(line({ level: 50, err: { message: 'only this' } }))).message).toBe('only this');
    expect(projectErrorEvent(row(line({ level: 50 }))).message).toBe('(unparseable log line)');
  });

  it('carries ref, requestId and pollRunId', () => {
    const ev = projectErrorEvent(row(line({ level: 50, msg: 'x', requestId: 'r-1', pollRunId: 'p-1' })));
    expect(ev.ref).toBe('PTR1');
    expect(ev.requestId).toBe('r-1');
    expect(ev.pollRunId).toBe('p-1');
  });
});

it('asks Insights for @ptr and @log', async () => {
  // reuse this file's existing fake-client setup; assert on the StartQuery input
  expect(startCmd.input.queryString).toContain('@ptr');
  expect(startCmd.input.queryString).toContain('@log');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts`
Expected: FAIL - `projectErrorEvent` takes a string, and the new fields do not exist.

- [ ] **Step 3: Write the implementation**

Replace `projectErrorEvent` and update the query and row loop:

```ts
export type ErrorSource = 'app' | 'worker' | 'system' | 'unknown';

/** Field cap for `message` and `errMessage`. Each carries its OWN flag. */
export const FIELD_CAP = 300;

/** `@log` is `<accountId>:<logGroupName>` - take everything after the last ':'. */
export function normalizeLogGroup(atLog: string): string {
  const at = atLog.lastIndexOf(':');
  return at === -1 ? atLog : atLog.slice(at + 1);
}

function sourceOf(atLog: string | undefined): ErrorSource {
  if (atLog === undefined) return 'unknown';
  const name = normalizeLogGroup(atLog);
  if (name.endsWith('/app')) return 'app';
  if (name.endsWith('/worker')) return 'worker';
  if (name.endsWith('/system')) return 'system';
  return 'unknown';
}

function capped(value: string): { value: string; truncated: boolean } {
  return value.length > FIELD_CAP
    ? { value: value.slice(0, FIELD_CAP), truncated: true }
    : { value, truncated: false };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Project one Insights result ROW to the view the dashboard renders.
 *
 * PII POSTURE (changed 2026-08-24): this is a DISPLAY control, not a storage
 * control - every field here was already at rest in CloudWatch. The panel is
 * admin-only and server-enforced (routes/system.ts requireRole('admin')), and
 * may render contact PII deliberately. Credentials are handled separately, by
 * the allowlist on the DETAIL path - see getLogRecord in this file.
 *
 * ACCESSOR SHAPE: this path parses the raw `@message` JSON, where `err` is a
 * NESTED object. `obj['err.message']` is undefined here; the dotted form
 * belongs to the GetLogRecord path only.
 */
export function projectErrorEvent(row: { field?: string; value?: string }[]): ErrorEventView {
  let raw = '';
  let tsValue: string | undefined;
  let ptr = '';
  let atLog: string | undefined;
  for (const cell of row) {
    if (cell.field === '@message') raw = cell.value ?? '';
    else if (cell.field === '@timestamp') tsValue = cell.value ?? undefined;
    else if (cell.field === '@ptr') ptr = cell.value ?? '';
    else if (cell.field === '@log') atLog = cell.value ?? undefined;
  }

  const timestamp = new Date(parseInsightsTimestamp(tsValue)).toISOString();
  const base = {
    timestamp,
    correlationId: null as string | null,
    errorCode: null as string | null,
    source: sourceOf(atLog),
    ref: ptr,
  };

  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) throw new Error('not an object');
    parsed = p as Record<string, unknown>;
  } catch {
    // Non-JSON line. The list path deliberately does NOT surface raw text -
    // that property is preserved and pinned by an existing assertion. Raw text
    // is reachable through the detail path instead.
    return {
      ...base,
      level: 50,
      message: '(unparseable log line)',
      messageTruncated: false,
      errMessageTruncated: false,
    };
  }

  const err = typeof parsed['err'] === 'object' && parsed['err'] !== null
    ? (parsed['err'] as Record<string, unknown>)
    : undefined;
  // A SCALAR err is the message itself - six call sites log `err: e.message`.
  const errMessageRaw = err !== undefined ? str(err['message']) : str(parsed['err']);

  // Ladder: msg -> event -> err.message -> placeholder.
  const chosen =
    str(parsed['msg']) ?? str(parsed['message']) ?? str(parsed['event']) ?? errMessageRaw ?? '(unparseable log line)';
  const msgCap = capped(chosen);
  // When `message` came FROM err.message they are the same string; the row
  // renders one of them (see RecentErrors), so do not also populate errMessage.
  const errCap = errMessageRaw !== null && errMessageRaw !== chosen ? capped(errMessageRaw) : null;

  const ec = parsed['errorCode'];
  return {
    ...base,
    level: typeof parsed['level'] === 'number' ? parsed['level'] : 50,
    message: msgCap.value,
    messageTruncated: msgCap.truncated,
    correlationId: str(parsed['correlationId']),
    errorCode: typeof ec === 'number' ? String(ec) : str(ec),
    jobName: str(parsed['jobName']),
    event: str(parsed['event']),
    errType: err !== undefined ? str(err['type']) ?? str(err['name']) : null,
    errMessage: errCap?.value ?? null,
    errMessageTruncated: errCap?.truncated ?? false,
    requestId: str(parsed['requestId']),
    pollRunId: str(parsed['pollRunId']),
  };
}
```

In `queryInsights`, change the query string and the row loop:

```ts
      const queryString = `fields @timestamp, @message, @ptr, @log | filter ${filterExpr} | sort @timestamp desc | limit ${limit}`;
```

```ts
          return rows.map((row) => projectErrorEvent(row)).slice(0, limit);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts`
Expected: PASS. The existing `'(unparseable log line)'` assertion at `:129` MUST still pass - that behavior is deliberately preserved.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/adapters/cloudwatch.ts app/test/cloudwatch.adapter.test.ts
git commit -m "feat(observability): widen the error projection past the four-field allowlist"
```

---

### Task 5: Dedup on ref

**Files:**
- Modify: `app/src/services/systemStatus.ts:244-253`
- Test: `app/test/systemStatus.service.test.ts`

**Interfaces:**
- Consumes: `ErrorEventView.ref` from Task 4.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

```ts
it('keeps two same-instant rows from different log groups apart', async () => {
  const a = { timestamp: '2026-08-24T10:00:00.000Z', message: 'boom', ref: 'PTR-A', source: 'app' };
  const b = { timestamp: '2026-08-24T10:00:00.000Z', message: 'boom', ref: 'PTR-B', source: 'worker' };
  const svc = makeService({ config, cloudwatch: fakeSeam({ queryInsights: async () => [a, b] as never }) });
  const res = await svc.getErrors('1h');
  expect(res.available && res.events).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts -t "same-instant rows"`
Expected: FAIL - one row, collapsed by `timestamp|message|errorCode`.

- [ ] **Step 3: Write minimal implementation**

```ts
          .filter((e) => {
            // `ref` (the Insights @ptr) is unique per log event AND stable
            // across separate queries (measured 2026-08-24), so it is the real
            // identity here. The remaining components are retained for the
            // contract they used to carry; with a ref present they never decide.
            const key = `${e.ref}|${e.timestamp}|${e.message}|${e.errorCode ?? ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/systemStatus.ts app/test/systemStatus.service.test.ts
git commit -m "feat(observability): dedup error rows on the log-event pointer"
```

---

### Task 6: GetLogRecord seam with the err allowlist

**Files:**
- Modify: `app/src/adapters/cloudwatch.ts`
- Test: `app/test/cloudwatch.adapter.test.ts`

**Interfaces:**
- Consumes: `normalizeLogGroup` from Task 4.
- Produces:

```ts
export interface LogRecordView {
  fields: Record<string, string>;
  rawText?: string;
  rawTextTruncated?: boolean;
  responseTruncated: boolean;
  logGroup: string;
}
// on CloudWatchClientSeam:
getLogRecord(ref: string): Promise<LogRecordView>;
export const ERR_ALLOWLIST: readonly string[];
export const RAW_TEXT_CAP = 4000;
export const RESPONSE_BOUND_BYTES = 65536;
```

**CRITICAL:** this path sees DOT-FLATTENED keys (`err.message`), unlike Tasks 4 and 8.

- [ ] **Step 1: Write the failing tests**

```ts
describe('getLogRecord - err allowlist', () => {
  const rec = (logRecord: Record<string, string>) => ({ logRecord });

  it('keeps the allowlisted err fields including response.status', async () => {
    const seam = seamWithLogs({ send: async () => rec({ '@log': '9:/hc/dev/app', 'err.message': 'boom', 'err.type': 'RestException', 'err.response.status': '404', msg: 'job failed: x' }) });
    const out = await seam.getLogRecord('PTR');
    expect(out.fields['err.message']).toBe('boom');
    expect(out.fields['err.response.status']).toBe('404');
  });

  it('drops every other err nest AT ANY DEPTH, including err.cause', async () => {
    const seam = seamWithLogs({ send: async () => rec({ '@log': '9:/hc/dev/app', 'err.message': 'boom', 'err.config.params': 'To=%2B14045551234', 'err.config.url': 'https://api.twilio.com/x', 'err.cause.config.headers.Authorization': 'Basic c2lkOnNlY3JldA==' }) });
    const out = await seam.getLogRecord('PTR');
    expect(out.fields['err.config.params']).toBeUndefined();
    expect(out.fields['err.config.url']).toBeUndefined();
    expect(out.fields['err.cause.config.headers.Authorization']).toBeUndefined();
  });

  it('KEEPS a scalar string err - six call sites log err as a message', async () => {
    const seam = seamWithLogs({ send: async () => rec({ '@log': '9:/hc/dev/app', err: 'Insights query failed', msg: 'system status: Logs Insights query failed' }) });
    const out = await seam.getLogRecord('PTR');
    expect(out.fields['err']).toBe('Insights query failed');
  });

  it('never returns @message for a parsed record, and drops AWS transport metadata', async () => {
    const seam = seamWithLogs({ send: async () => rec({ '@log': '9:/hc/dev/app', '@message': '{"msg":"x","err":{"config":{"url":"secret"}}}', backwardToken: 'b/1', forwardToken: 'f/1', '@logGroupId': 'g', msg: 'x' }) });
    const out = await seam.getLogRecord('PTR');
    expect(out.fields['@message']).toBeUndefined();
    expect(out.fields['backwardToken']).toBeUndefined();
    expect(out.fields['@logGroupId']).toBeUndefined();
    expect(out.rawText).toBeUndefined();
  });

  it('returns rawText for a NON-JSON record, capped', async () => {
    const seam = seamWithLogs({ send: async () => rec({ '@log': '9:/hc/dev/system', '@message': 'Out of memory: Killed process 123', '@timestamp': '1' }) });
    const out = await seam.getLogRecord('PTR');
    expect(out.rawText).toContain('Out of memory');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts -t "getLogRecord"`
Expected: FAIL - `getLogRecord` is not a function.

- [ ] **Step 3: Write the implementation**

Import `GetLogRecordCommand` alongside the existing logs commands, then:

```ts
/**
 * The ONLY `err.*` paths that leave this adapter.
 *
 * AN ALLOWLIST, NOT A DENYLIST, and the distinction is load-bearing. Write-time
 * credential redaction (lib/logger.ts) is a BEST-EFFORT PATH LIST - it names
 * three literal `err.config` paths and no wildcard, so `err.config.url`,
 * `err.config.params`, `err.config.baseURL` and `err.config.auth` are NOT
 * redacted at rest. A denylist here would inherit that failure mode and
 * `err.cause.config.headers.Authorization` would walk straight through it.
 * An allowlist closes the class by construction, including nests nobody has met.
 *
 * `response.status` is kept deliberately: lib/errors.ts reads it as the vendor
 * discriminator and `status` is one of the three fields in the repo's
 * adjudicated ErrorSummary allowlist.
 */
export const ERR_ALLOWLIST = [
  'err.message', 'err.stack', 'err.type', 'err.name', 'err.code', 'err.status', 'err.response.status',
] as const;

export const RAW_TEXT_CAP = 4000;
export const RESPONSE_BOUND_BYTES = 65536;

/** AWS transport metadata - never returned to the client. */
const DROPPED_PREFIXES = ['@aws.', '@entity.', '@data_'];
const DROPPED_KEYS = new Set(['@message', '@timestamp', '@logGroupId', '@logStreamId', 'backwardToken', 'forwardToken']);

function isAllowedKey(key: string): boolean {
  if (key === 'err') return true;                       // scalar err: the message itself
  if (key.startsWith('err.')) return (ERR_ALLOWLIST as readonly string[]).includes(key);
  if (DROPPED_KEYS.has(key)) return false;
  if (DROPPED_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;                                          // app-authored field
}
```

In `createCloudWatchClient`'s returned object:

```ts
    async getLogRecord(ref) {
      const out = await logs.send(new GetLogRecordCommand({ logRecordPointer: ref }));
      const record = out.logRecord ?? {};
      const atLog = record['@log'] ?? '';
      const fields: Record<string, string> = {};
      let appFieldCount = 0;
      for (const [key, value] of Object.entries(record)) {
        if (!isAllowedKey(key)) continue;
        if (!key.startsWith('@')) appFieldCount++;
        fields[key] = String(value);
      }
      // Fact 8: a NON-JSON record returns no application fields at all, so its
      // raw text is the only content. A parsed record NEVER gets rawText -
      // returning the original line would hand back the very nests the
      // allowlist above just dropped.
      let rawText: string | undefined;
      let rawTextTruncated = false;
      if (appFieldCount === 0) {
        const text = String(record['@message'] ?? '');
        rawTextTruncated = text.length > RAW_TEXT_CAP;
        rawText = rawTextTruncated ? text.slice(0, RAW_TEXT_CAP) : text;
      }
      let responseTruncated = false;
      if (JSON.stringify(fields).length > RESPONSE_BOUND_BYTES) {
        const stack = fields['err.stack'];
        if (stack !== undefined) fields['err.stack'] = stack.slice(0, RESPONSE_BOUND_BYTES / 2);
        responseTruncated = true;
      }
      return {
        fields,
        ...(rawText !== undefined && { rawText, rawTextTruncated }),
        responseTruncated,
        logGroup: normalizeLogGroup(atLog),
      };
    },
```

Add `getLogRecord(ref: string): Promise<LogRecordView>;` to `CloudWatchClientSeam`.

- [ ] **Step 4: Update the test fake**

`app/test/systemStatus.service.test.ts:38-50` returns a hardcoded two-property literal typed as the full seam, so adding a required method is a TYPECHECK failure, not a runtime throw:

```ts
    getLogRecord: vi.fn(impl.getLogRecord ?? (async () => ({ fields: {}, responseTruncated: false, logGroup: '/hc/local/app' }))),
    queryTrace: vi.fn(impl.queryTrace ?? (async () => [])),
```

Add both keys to the helper's return-type annotation as well. `queryTrace` lands in Task 8; stub it now so the fake compiles once.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts`
Then: `npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/adapters/cloudwatch.ts app/test/cloudwatch.adapter.test.ts app/test/systemStatus.service.test.ts
git commit -m "feat(observability): add GetLogRecord seam with an err allowlist"
```

---

### Task 7: The detail route

**Files:**
- Modify: `app/src/services/systemStatus.ts`, `app/src/routes/system.ts`
- Test: `app/test/systemStatus.service.test.ts`, `app/test/system.routes.test.ts`

**Interfaces:**
- Consumes: `getLogRecord` from Task 6.
- Produces: `GET /api/system/errors/detail?ref=<encoded>` -> `{ available: true, record } | { available: false, reason }`. Service method `getErrorDetail(ref: string): Promise<DetailResult>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects a record from a foreign log group', async () => {
  const svc = makeService({ config, cloudwatch: fakeSeam({ getLogRecord: async () => ({ fields: { msg: 'x' }, responseTruncated: false, logGroup: '/hc/prod/app' }) }) });
  const res = await svc.getErrorDetail('PTR');
  expect(res).toEqual({ available: false, reason: 'out_of_scope' });
});

it('returns the record for an in-scope log group', async () => {
  const svc = makeService({ config, cloudwatch: fakeSeam({ getLogRecord: async () => ({ fields: { msg: 'x' }, responseTruncated: false, logGroup: config.errorLogGroupName }) }) });
  const res = await svc.getErrorDetail('PTR');
  expect(res).toMatchObject({ available: true });
});

it('400s a MISSING ref and degrades a malformed one', async () => {
  await request(app).get('/api/system/errors/detail').expect(400);
  await request(app).get('/api/system/errors/detail?ref=' + encodeURIComponent('!'.repeat(5))).expect(200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts test/system.routes.test.ts`
Expected: FAIL - route and method do not exist.

- [ ] **Step 3: Write the service method**

```ts
/** Base64-family pointer, bounded. Insights pointers observed at 220 chars. */
const REF_PATTERN = /^[A-Za-z0-9+/=]{16,512}$/;

    async getErrorDetail(ref) {
      if (isLocalEnv(config)) return { available: false, reason: 'unavailable_local' };
      if (!REF_PATTERN.test(ref)) return { available: false, reason: 'invalid_ref' };
      try {
        const record = await cloudwatch.getLogRecord(ref);
        // A ref is an ACCOUNT-scoped pointer bound to nothing. This check makes
        // the route's scope independent of whether the IAM grant landed on the
        // scoped or the "*" branch - without it, a pointer from another
        // environment would resolve here.
        const allowed = [config.errorLogGroupName, config.workerLogGroupName, config.systemLogGroupName];
        if (!allowed.includes(record.logGroup)) {
          log.warn({ logGroup: record.logGroup }, 'system status: detail record out of scope');
          return { available: false, reason: 'out_of_scope' };
        }
        return { available: true, record };
      } catch (err) {
        log.error({ kind: classifyCloudWatchError(err), err: (err as Error).message }, 'system status: GetLogRecord failed');
        return { available: false, reason: 'cloudwatch_error' };
      }
    },
```

- [ ] **Step 4: Write the route**

In `app/src/routes/system.ts`, BEFORE the `/errors` route so ordering is obvious (Express matches exact paths, so order does not actually matter here):

```ts
  // GET /api/system/errors/detail?ref=... - the complete log record behind one
  // row. A MISSING ref is a 400 (matching the `since` precedent); a PRESENT but
  // malformed one takes the degraded 200, like every other failure here.
  router.get('/errors/detail', async (req, res) => {
    const ref = req.query['ref'];
    if (typeof ref !== 'string' || ref.length === 0) {
      res.status(400).json({ error: 'ref is required' });
      return;
    }
    const result = await service.getErrorDetail(ref);
    res.json(result);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts test/system.routes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/services/systemStatus.ts app/src/routes/system.ts app/test/systemStatus.service.test.ts app/test/system.routes.test.ts
git commit -m "feat(observability): add the full-record detail route"
```

---

### Task 8: The trace seam - two queries, id-dependent bracket

**Files:**
- Modify: `app/src/adapters/cloudwatch.ts`
- Test: `app/test/cloudwatch.adapter.test.ts`

**Interfaces:**
- Produces:

```ts
export type TraceIdKind = 'correlationId' | 'requestId' | 'pollRunId';
export interface TraceLineView {
  timestamp: string; level: number; message: string; source: ErrorSource;
  method?: string | null; path?: string | null; statusCode?: number | null;
  durationMs?: number | null; jobName?: string | null; jobId?: string | null; hopCount?: number | null;
}
export interface TraceResult { lines: TraceLineView[]; truncatedBefore: boolean; truncatedAfter: boolean; }
// on the seam:
queryTrace(groups: string[], kind: TraceIdKind, id: string, atMs: number): Promise<TraceResult>;
export const TRACE_SIDE_LIMIT = 25;
```

**THE TWO HARDEST RULES IN THIS PLAN:**

1. Insights applies `limit` INSIDE the sort. A single ascending query returns the EARLIEST 25 rows and can drop the failure out of its own trace. Two queries with OPPOSITE sorts are required.
2. `StartQuery` takes epoch SECONDS but `at` is a millisecond timestamp, so a split exactly at `at` is inexpressible. The anchor's WHOLE SECOND belongs to the BEFORE query. Using `ceil` for BEFORE's `endTime` - the convention the existing list query uses - overlaps the windows by up to a second and returns the failure line from BOTH queries, rendering it twice.

- [ ] **Step 1: Write the failing tests**

```ts
describe('queryTrace', () => {
  it('uses a -5min bracket for correlationId and -30min for the cross-hop ids', async () => {
    const atMs = Date.parse('2026-08-24T10:00:00.000Z');
    await seam.queryTrace(['/hc/dev/app'], 'correlationId', 'c-1', atMs);
    expect(starts[0].input.startTime).toBe(Math.floor((atMs - 5 * 60_000) / 1000));
    starts.length = 0;
    await seam.queryTrace(['/hc/dev/app'], 'pollRunId', 'p-1', atMs);
    expect(starts[0].input.startTime).toBe(Math.floor((atMs - 30 * 60_000) / 1000));
  });

  it('splits at second granularity with DISJOINT windows - the anchor second belongs to BEFORE', async () => {
    const atMs = Date.parse('2026-08-24T10:00:00.500Z');
    await seam.queryTrace(['/hc/dev/app'], 'correlationId', 'c-1', atMs);
    const before = starts.find((s) => s.input.queryString.includes('desc'))!;
    const after = starts.find((s) => s.input.queryString.includes('asc'))!;
    expect(before.input.endTime).toBe(Math.floor(atMs / 1000));
    expect(after.input.startTime).toBe(Math.floor(atMs / 1000) + 1);
    expect(after.input.startTime).toBeGreaterThan(before.input.endTime);
  });

  it('issues both queries with opposite sorts and merges ascending', async () => {
    const out = await seam.queryTrace(['/hc/dev/app'], 'requestId', 'r-1', Date.now());
    const times = out.lines.map((l) => l.timestamp);
    expect([...times].sort()).toEqual(times);
  });

  it('flags per-side truncation when a side fills its budget', async () => {
    // fake returns TRACE_SIDE_LIMIT rows for the before query
    expect((await seam.queryTrace(['/hc/dev/app'], 'requestId', 'r-1', Date.now())).truncatedBefore).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts -t "queryTrace"`
Expected: FAIL - not a function.

- [ ] **Step 3: Write the implementation**

```ts
export const TRACE_SIDE_LIMIT = 25;
const BRACKET_TIGHT_MS = 5 * 60_000;
const BRACKET_WIDE_MS = 30 * 60_000;
const BRACKET_AHEAD_MS = 5 * 60_000;

/**
 * Project one trace row. Like the LIST path and UNLIKE the detail path, this
 * parses the raw `@message` JSON, so `err` is a NESTED object here.
 */
function traceLine(row: { field?: string; value?: string }[]): TraceLineView {
  let raw = '';
  let tsValue: string | undefined;
  let atLog: string | undefined;
  for (const cell of row) {
    if (cell.field === '@message') raw = cell.value ?? '';
    else if (cell.field === '@timestamp') tsValue = cell.value ?? undefined;
    else if (cell.field === '@log') atLog = cell.value ?? undefined;
  }
  const timestamp = new Date(parseInsightsTimestamp(tsValue)).toISOString();
  const source = sourceOf(atLog);
  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) throw new Error('not an object');
    parsed = p as Record<string, unknown>;
  } catch {
    return { timestamp, level: 30, message: '(unparseable log line)', source };
  }
  const err =
    typeof parsed['err'] === 'object' && parsed['err'] !== null
      ? (parsed['err'] as Record<string, unknown>)
      : undefined;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    timestamp,
    level: typeof parsed['level'] === 'number' ? parsed['level'] : 30,
    message:
      str(parsed['msg']) ??
      str(parsed['message']) ??
      str(parsed['event']) ??
      (err !== undefined ? str(err['message']) : str(parsed['err'])) ??
      '(unparseable log line)',
    source,
    method: str(parsed['method']),
    path: str(parsed['path']),
    statusCode: num(parsed['statusCode']),
    durationMs: num(parsed['durationMs']),
    jobName: str(parsed['jobName']),
    jobId: str(parsed['jobId']),
    hopCount: num(parsed['hopCount']),
  };
}
```

Extract the existing StartQuery-then-poll body of `queryInsights` into a private `runInsights(groups, queryString, startTimeSec, endTimeSec, limit)` returning raw rows, and have BOTH `queryInsights` and `queryTrace` use it. Then:

```ts
    async queryTrace(groups, kind, id, atMs) {
      // The cross-hop ids reach BACKWARDS by construction: a job's failure can
      // be ~8 min after its first attempt (SQS 120s visibility x 5 receives)
      // and ~20 min from its enqueue (delayed enqueue reaches ~12 min). A tight
      // symmetric bracket cannot reach any of that.
      const back = kind === 'correlationId' ? BRACKET_TIGHT_MS : BRACKET_WIDE_MS;
      const startSec = Math.floor((atMs - back) / 1000);
      const endSec = Math.ceil((atMs + BRACKET_AHEAD_MS) / 1000);
      // SECOND-GRANULARITY SPLIT. `at` is milliseconds; StartQuery is seconds,
      // so a split exactly at `at` is inexpressible. The anchor's whole second
      // goes to BEFORE and AFTER starts at the NEXT second, so the windows are
      // DISJOINT: no row can appear twice and no merge dedup rule is needed.
      // Do NOT use ceil here - that overlaps by a second and returns the
      // anchor line, i.e. the failure itself, from both queries.
      const anchorSec = Math.floor(atMs / 1000);
      const filter = `${kind} = "${id}"`;
      const [beforeRows, afterRows] = await Promise.all([
        runInsights(groups, `fields @timestamp, @message, @log | filter ${filter} | sort @timestamp desc | limit ${TRACE_SIDE_LIMIT}`, startSec, anchorSec, TRACE_SIDE_LIMIT),
        runInsights(groups, `fields @timestamp, @message, @log | filter ${filter} | sort @timestamp asc | limit ${TRACE_SIDE_LIMIT}`, anchorSec + 1, endSec, TRACE_SIDE_LIMIT),
      ]);
      return {
        lines: [...beforeRows.map(traceLine).reverse(), ...afterRows.map(traceLine)],
        truncatedBefore: beforeRows.length >= TRACE_SIDE_LIMIT,
        truncatedAfter: afterRows.length >= TRACE_SIDE_LIMIT,
      };
    },
```

The two queries run under `Promise.all` because each Insights poll has a bounded ~8s budget; sequential would double the worst-case wait on a user click.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts`
Expected: PASS, including the pre-existing `sort @timestamp desc` assertion for the LIST query.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/adapters/cloudwatch.ts app/test/cloudwatch.adapter.test.ts
git commit -m "feat(observability): add the two-query correlation trace seam"
```

---

### Task 9: The trace route

**Files:**
- Modify: `app/src/services/systemStatus.ts`, `app/src/routes/system.ts`
- Test: `app/test/systemStatus.service.test.ts`, `app/test/system.routes.test.ts`

**Interfaces:**
- Consumes: `queryTrace` from Task 8.
- Produces: `GET /api/system/trace?correlationId|requestId|pollRunId=<uuid>&at=<ISO>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('400s when no id, several ids, or a bad at', async () => {
  await request(app).get('/api/system/trace?at=2026-08-24T10:00:00.000Z').expect(400);
  await request(app).get('/api/system/trace?correlationId=' + UUID + '&requestId=' + UUID + '&at=2026-08-24T10:00:00.000Z').expect(400);
  await request(app).get('/api/system/trace?correlationId=' + UUID + '&at=nonsense').expect(400);
});

it('degrades (200) on a present-but-non-UUID id', async () => {
  await request(app).get('/api/system/trace?correlationId=not-a-uuid&at=2026-08-24T10:00:00.000Z').expect(200);
});

it('queries app and worker but NOT the system group', async () => {
  const seen: string[][] = [];
  const svc = makeService({ config, cloudwatch: fakeSeam({ queryTrace: async (g) => { seen.push(g); return { lines: [], truncatedBefore: false, truncatedAfter: false }; } }) });
  await svc.getTrace('correlationId', UUID, Date.parse('2026-08-24T10:00:00.000Z'));
  expect(seen[0]).toEqual([config.errorLogGroupName, config.workerLogGroupName]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/system.routes.test.ts -t trace`
Expected: FAIL - route does not exist.

- [ ] **Step 3: Write the service method**

```ts
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    async getTrace(kind, id, atMs) {
      if (isLocalEnv(config)) return { available: false, reason: 'unavailable_local' };
      if (!UUID_PATTERN.test(id)) return { available: false, reason: 'invalid_id' };
      try {
        // app + worker only. The system group's kernel lines carry no
        // correlation id at all, so scanning it costs bytes for nothing.
        const groups = [config.errorLogGroupName, config.workerLogGroupName];
        const trace = await cloudwatch.queryTrace(groups, kind, id, atMs);
        return { available: true, ...trace };
      } catch (err) {
        log.error({ kind: classifyCloudWatchError(err), err: (err as Error).message }, 'system status: trace query failed');
        return { available: false, reason: 'cloudwatch_error' };
      }
    },
```

- [ ] **Step 4: Write the route**

```ts
  const TRACE_ID_KINDS = ['correlationId', 'requestId', 'pollRunId'] as const;

  // GET /api/system/trace - the lines around one failure. Exactly one id kind
  // plus a required `at` anchor; MISSING or ambiguous parameters are a 400
  // (matching `since`), while a present-but-malformed id degrades at 200.
  router.get('/trace', async (req, res) => {
    const present = TRACE_ID_KINDS.filter((k) => typeof req.query[k] === 'string');
    if (present.length !== 1) {
      res.status(400).json({ error: 'exactly one of correlationId, requestId, pollRunId is required' });
      return;
    }
    const rawAt = req.query['at'];
    const atMs = typeof rawAt === 'string' ? Date.parse(rawAt) : Number.NaN;
    if (Number.isNaN(atMs)) {
      res.status(400).json({ error: 'at must be an ISO 8601 timestamp' });
      return;
    }
    const kind = present[0]!;
    res.json(await service.getTrace(kind, String(req.query[kind]), atMs));
  });
```

- [ ] **Step 5: Run tests and commit**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts test/system.routes.test.ts`
Expected: PASS

```bash
git status
git add app/src/services/systemStatus.ts app/src/routes/system.ts app/test/systemStatus.service.test.ts app/test/system.routes.test.ts
git commit -m "feat(observability): add the correlation trace route"
```

---

### Task 10: Dashboard wire layer

**Files:**
- Modify: `dashboard/src/api/types.ts:335-346`, `dashboard/src/api/endpoints.ts:2088-2108`
- Test: typecheck is the gate; no new test file.

**Interfaces:**
- Consumes: the backend shapes from Tasks 4, 6, 7, 8, 9.
- Produces: `getSystemErrorDetail(ref, signal?)`, `getSystemTrace(kind, id, at, signal?)`.

The dashboard does NOT share backend types - it hand-maintains a mirror.

- [ ] **Step 1: Mirror the types**

In `dashboard/src/api/types.ts`, extend `SystemErrorEvent` and add the two result types. Mirror `ErrorEventView`, `LogRecordView`, `TraceLineView` and `TraceResult` field-for-field, including `source: 'app' | 'worker' | 'system' | 'unknown'` and required non-null `source` and `ref`.

- [ ] **Step 2: Add the client functions**

```ts
/**
 * GET /api/system/errors/detail?ref=... - the complete log record behind one row.
 * `ref` is a raw CloudWatch pointer containing `+` and `=`; it MUST go through
 * `request()`'s `query` option, which builds the string with URLSearchParams and
 * percent-encodes them. A hand-rolled URL would let Express's `qs` parser decode
 * a literal `+` as a space and corrupt the pointer.
 */
export function getSystemErrorDetail(ref: string, signal?: AbortSignal): Promise<SystemErrorDetailResult> {
  return request<SystemErrorDetailResult>('/api/system/errors/detail', {
    query: { ref },
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/system/trace - the lines around one failure, anchored on its timestamp. */
export function getSystemTrace(
  kind: 'correlationId' | 'requestId' | 'pollRunId',
  id: string,
  at: string,
  signal?: AbortSignal,
): Promise<SystemTraceResult> {
  return request<SystemTraceResult>('/api/system/trace', {
    query: { [kind]: id, at },
    ...(signal !== undefined && { signal }),
  });
}
```

- [ ] **Step 3: Fix the broken fixtures**

`source` and `ref` are REQUIRED, so `dashboard/src/routes/settings/RecentErrors.test.tsx:67-68` and `:88-92` will fail typecheck. Add `source: 'app'` and a distinct `ref` to each fixture. Do NOT weaken the types to avoid this.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git status
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/routes/settings/RecentErrors.test.tsx
git commit -m "feat(observability): mirror the widened error contracts in the dashboard"
```

---

### Task 11: Detail and trace hooks

**Files:**
- Modify: `dashboard/src/routes/settings/useSystemStatus.ts`

**Interfaces:**
- Produces: `useErrorDetail()` and `useErrorTrace()`, each `{ status, result, load, reset }` with abort handling.

Fetching lives here, not improvised inside a component - mirror `useSystemErrors`'s `abortRef` pattern at `:183-210`.

- [ ] **Step 1: Add the hooks**

```ts
export function useErrorDetail(): {
  status: FetchStatus; result: SystemErrorDetailResult | null;
  load: (ref: string) => void; reset: () => void;
} {
  const [status, setStatus] = useState<FetchStatus>('ready');
  const [result, setResult] = useState<SystemErrorDetailResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const load = useCallback((ref: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('loading');
    void getSystemErrorDetail(ref, controller.signal)
      .then((next) => { if (!controller.signal.aborted) { setResult(next); setStatus('ready'); } })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setStatus('error');
      });
  }, []);
  const reset = useCallback(() => { abortRef.current?.abort(); setResult(null); setStatus('ready'); }, []);
  return { status, result, load, reset };
}
```

And the trace hook - written out rather than described, because you may be reading this task without Task 12 in front of you:

```ts
export function useErrorTrace(): {
  status: FetchStatus; result: SystemTraceResult | null;
  load: (kind: 'correlationId' | 'requestId' | 'pollRunId', id: string, at: string) => void;
  reset: () => void;
} {
  const [status, setStatus] = useState<FetchStatus>('ready');
  const [result, setResult] = useState<SystemTraceResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const load = useCallback(
    (kind: 'correlationId' | 'requestId' | 'pollRunId', id: string, at: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('loading');
      void getSystemTrace(kind, id, at, controller.signal)
        .then((next) => { if (!controller.signal.aborted) { setResult(next); setStatus('ready'); } })
        .catch((err: unknown) => {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          setStatus('error');
        });
    },
    [],
  );
  const reset = useCallback(() => { abortRef.current?.abort(); setResult(null); setStatus('ready'); }, []);
  return { status, result, load, reset };
}
```

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck`

```bash
git status
git add dashboard/src/routes/settings/useSystemStatus.ts
git commit -m "feat(observability): add detail and trace fetch hooks"
```

---

### Task 12: Widen the error row and add the expander

**Files:**
- Modify: `dashboard/src/routes/settings/RecentErrors.tsx`, `SystemStatusSection.module.css`
- Test: `dashboard/src/routes/settings/RecentErrors.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it('renders the source chip for all four values', () => { /* app | worker | system | unknown */ });
it('renders a jobName chip when present, else the event chip', () => {});
it('marks a truncated message and offers the expander', () => {});
it('keys rows on ref so expander state survives a refresh', () => {});
it('prefers requestId, then pollRunId, then correlationId for the trace link', () => {});
it('renders NO trace link when all three ids are null', () => {});
it('sends the row timestamp as `at` on the trace link', () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run dashboard/src/routes/settings/RecentErrors.test.tsx`

- [ ] **Step 3: Implement**

Change the row key at `:127` from `${ev.timestamp}-${ev.correlationId ?? ''}-${ev.message}` to `ev.ref`.

The id-precedence helper, which is the piece most easily got wrong:

```ts
/**
 * Which id drives the trace link. requestId and pollRunId are the CROSS-HOP
 * ids - they reach back to the request or the poll tick that enqueued the work -
 * so they win over correlationId, which for a job line is just that one job run.
 *
 * OOM rows are non-JSON, so all three are null there. That is not an edge case:
 * those rows are synthesized by the service and are exactly the ones an operator
 * clicks. With no id, render NO link - never `?correlationId=null`.
 */
function tracePivot(ev: SystemErrorEvent): { kind: 'requestId' | 'pollRunId' | 'correlationId'; id: string } | null {
  if (ev.requestId != null && ev.requestId.length > 0) return { kind: 'requestId', id: ev.requestId };
  if (ev.pollRunId != null && ev.pollRunId.length > 0) return { kind: 'pollRunId', id: ev.pollRunId };
  if (ev.correlationId != null && ev.correlationId.length > 0) return { kind: 'correlationId', id: ev.correlationId };
  return null;
}

const SOURCE_LABEL: Record<SystemErrorEvent['source'], string> = {
  app: 'app', worker: 'worker', system: 'host', unknown: 'unknown',
};
```

And the row body:

```tsx
function ErrorRow({ event }: { event: SystemErrorEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detail = useErrorDetail();
  const pivot = tracePivot(event);
  const chip = event.jobName ?? event.event;
  return (
    <li className={styles.errorRow}>
      <div className={styles.errorMeta}>
        <span className={styles.errorWhen}>{formatWhen(event.timestamp)}</span>
        <span className={styles.errorLevel}>{levelLabel(event.level)}</span>
        <span className={styles.errorChip}>{SOURCE_LABEL[event.source]}</span>
        {chip != null && chip.length > 0 ? <span className={styles.errorChip}>{chip}</span> : null}
        {event.errType != null ? <span className={styles.errorChip}>{event.errType}</span> : null}
      </div>
      <p className={styles.errorMessage}>
        {event.message}
        {event.messageTruncated ? <span className={styles.truncated}> (truncated)</span> : null}
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { if (!open) detail.load(event.ref); setOpen(!open); }}
      >
        {open ? 'Hide details' : 'Show all'}
      </button>
      {pivot !== null ? (
        <TraceLink kind={pivot.kind} id={pivot.id} at={event.timestamp} />
      ) : null}
      {open ? <ErrorDetail state={detail} /> : null}
    </li>
  );
}
```

`ErrorDetail` renders `detail.result`: on `available:false` the degraded notice, otherwise the `fields` map as a key/value list, `err.stack` in its own `overflow-y: auto` container with a bounded `max-height`, `rawText` when present, and a marker for each of `rawTextTruncated` and `responseTruncated`.

Do NOT render `errMessage` as a separate line in the collapsed row: when the fallback ladder sourced `message` from `err.message` the two are the same string, and Task 4 already leaves `errMessage` null in that case.

- [ ] **Step 4: Run tests and commit**

```bash
git status
git add dashboard/src/routes/settings/RecentErrors.tsx dashboard/src/routes/settings/RecentErrors.test.tsx dashboard/src/routes/settings/SystemStatusSection.module.css
git commit -m "feat(observability): widen the error row and add the detail expander"
```

---

### Task 13: The trace view

**Files:**
- Create: `dashboard/src/routes/settings/ErrorTrace.tsx`, `ErrorTrace.test.tsx`
- Modify: `RecentErrors.tsx` to mount it

- [ ] **Step 1: Write the failing tests**

```ts
it('renders lines in ascending order with a source chip each', () => {});
it('marks the anchor row so the operator can find the failure they came from', () => {});
it('surfaces per-side truncation', () => {});
it('distinguishes an EMPTY trace from a degraded one', () => {
  // available:true with lines:[] -> "No lines found in this window"
  // available:false -> the degraded notice. These must not look the same.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run dashboard/src/routes/settings/ErrorTrace.test.tsx`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

```tsx
import { useEffect } from 'react';
import { useErrorTrace } from './useSystemStatus.js';
import { Spinner } from '../../ui/index.js';
import type { SystemTraceLine } from '../../api/index.js';
import styles from './SystemStatusSection.module.css';

interface ErrorTraceProps {
  kind: 'correlationId' | 'requestId' | 'pollRunId';
  id: string;
  /** The anchor row's timestamp - bounds the query AND marks the anchor line. */
  at: string;
}

export function ErrorTrace({ kind, id, at }: ErrorTraceProps): React.JSX.Element {
  const { status, result, load } = useErrorTrace();
  useEffect(() => { load(kind, id, at); }, [load, kind, id, at]);

  if (status === 'loading') return <div className={styles.center}><Spinner /></div>;
  if (status === 'error') return <p role="alert">Couldn&apos;t load the trace.</p>;
  if (result === null) return <p className={styles.empty}>No trace loaded.</p>;
  // DEGRADED and EMPTY must read differently. An empty trace that looks like a
  // blank panel is the failure mode this whole view exists to avoid.
  if (!result.available) return <p className={styles.degraded}>Available in deployed environments.</p>;
  if (result.lines.length === 0) {
    return <p className={styles.empty}>No lines found around this event.</p>;
  }

  return (
    <div>
      {result.truncatedBefore ? (
        <p className={styles.truncated}>Earlier lines were cut off (limit reached).</p>
      ) : null}
      <ol className={styles.traceList}>
        {result.lines.map((line: SystemTraceLine, i: number) => (
          <li
            key={`${line.timestamp}-${i}`}
            className={line.timestamp === at ? styles.traceAnchor : styles.traceLine}
          >
            <span className={styles.errorWhen}>{line.timestamp}</span>
            <span className={styles.errorChip}>{line.source}</span>
            <span>{line.message}</span>
            {line.timestamp === at ? <span className={styles.errorChip}>this failure</span> : null}
          </li>
        ))}
      </ol>
      {result.truncatedAfter ? (
        <p className={styles.truncated}>Later lines were cut off (limit reached).</p>
      ) : null}
    </div>
  );
}
```

Add `.traceList`, `.traceLine`, `.traceAnchor` and `.truncated` to `SystemStatusSection.module.css`, following the existing class naming. The anchor row must be distinguishable by TEXT as well as colour ("this failure"), not colour alone - the panel's existing a11y rule.

- [ ] **Step 4: Run tests and commit**

```bash
git status
git add dashboard/src/routes/settings/ErrorTrace.tsx dashboard/src/routes/settings/ErrorTrace.test.tsx dashboard/src/routes/settings/RecentErrors.tsx
git commit -m "feat(observability): add the correlation trace view"
```

---

### Task 14: IAM grant for GetLogRecord

**Files:**
- Modify: `infra/modules/ec2/main.tf`

**DO NOT RUN TERRAFORM. Write the change only.** The human runs plan and apply.

- [ ] **Step 1: Check whether the action supports resource-level permissions**

Consult the AWS Service Authorization Reference for CloudWatch Logs and note whether `GetLogRecord` has a resource type. DEFAULT TO THE SCOPED STATEMENT; use `resources = ["*"]` only if the reference says the action does not support resource-level permissions, and cite it inline as the neighbouring statements do.

- [ ] **Step 2: Add the statement**

If scopable, add beside `SystemStatusInsightsStart`:

```hcl
  statement {
    sid     = "SystemStatusGetLogRecord"
    actions = ["logs:GetLogRecord"]
    resources = [
      "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/hc/${var.env}/*",
      "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/hc/${var.env}/*:*",
    ]
  }
```

If not scopable, add `"logs:GetLogRecord"` to the existing `SystemStatusInsightsResults` statement and extend its comment with the citation.

- [ ] **Step 3: Validate without applying**

Run: `cd infra && terraform fmt -check && terraform validate`
Expected: PASS. Do NOT run plan or apply.

- [ ] **Step 4: Commit**

```bash
git status
git add infra/modules/ec2/main.tf
git commit -m "feat(infra): grant logs:GetLogRecord for the error detail route"
```

---

### Task 15: Truth-up comments, docs, and the perf ledger

**Files:** 16 comment sites, `RUNBOOK.md`, `e2e/performance/routes.ts`, `e2e/performance/collect.test.ts`, `docs/issues/<new>.md`

- [ ] **Step 1: Rewrite the retired PII guarantee at every site**

Rewrite each to the new posture - admin-only, may contain PII, credentials handled by the S4 allowlist. Do not delete them.

`app/src/adapters/cloudwatch.ts:12-14`, `:78`, `:84-85`, `:90-92`, `:104`, `:116-122`; `app/src/services/systemStatus.ts:15-22`; `app/src/routes/system.ts:14-18`, `:63`; `dashboard/src/api/endpoints.ts:2095`; `dashboard/src/api/types.ts:334-346`; `dashboard/src/routes/settings/RecentErrors.tsx:1-7`; `RecentErrors.test.tsx:2`, `:63`; `app/src/adapters/messaging.ts:700`; `docs/issues/fake-twilio-messaging-attach-404.md:45`.

**NOT a correction:** `app/test/cloudwatch.adapter.test.ts:7`, `:129`. "PII-safety: raw text never surfaced" is still TRUE of the list path. EXTEND it to note the detail path surfaces raw text; do not "fix" it.

- [ ] **Step 2: Update the perf source-citation ledger**

Task 11 added imports ABOVE the cited ranges in `useSystemStatus.ts`, so these three MUST be updated TOGETHER:

- `e2e/performance/routes.ts:680` - `useSystemStatus.ts:77-132`
- `e2e/performance/routes.ts:762` - `useSystemStatus.ts:124-132`
- `e2e/performance/collect.test.ts:353` - the pinned literal string

Read the file, find the real new line numbers, update all three. Leaving them stale keeps every gate green while the ledger silently lies; updating only `routes.ts` turns `collect.test.ts` red.

Endpoint templates are CONDITIONAL: only if a profiler walk reaches the expander, and then with `conditional(...)`, never `required(...)`.

- [ ] **Step 3: Update RUNBOOK**

The DLQ alarm row teaches that `job failed` lines carry "the originating request's correlation IDs". ADD the panel's new detail and trace affordances; PRESERVE that technique - it is broader than the pivot.

- [ ] **Step 4: File the encoding issue**

Copy `docs/issues/_TEMPLATE.md` to `docs/issues/cloudwatch-log-cp1252-mojibake.md`. Record: source holds a clean UTF-8 em-dash (`E2 80 94`) at `app/src/index.ts:162` and `app/src/worker.ts:530`, but the stored CloudWatch event has a lone `0x97`; isolated past the PowerShell console AND the AWS CLI's own stdout encoding (`PYTHONIOENCODING=utf-8` reproduced it). Then run `npm run issues`.

- [ ] **Step 5: Commit**

```bash
git status
git add <explicit paths>
git commit -m "docs(observability): retire the PII-safe projection guarantee"
```

---

## Final gates

Run BARE from `W:\tmp\error-surface-detail`, never piped, in this order. Read the verdict from the log, not from a wrapper exit code.

- [ ] `npm run db:start`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run smoke`
- [ ] `npm run e2e`
- [ ] Sync `main` into the branch ONCE, at the end, then re-run the gates.

If `npm test` is red on DynamoDB Local suites, re-run under a clean key BEFORE blaming the change: `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run`.

**Owed to the human at handback:** terraform plan and apply, dev AND prod, before deploy. Until applied, the detail expander 403s and degrades.
