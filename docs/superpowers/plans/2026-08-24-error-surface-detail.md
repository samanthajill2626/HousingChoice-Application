# Error Surface Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin System Status error panel troubleshootable - name the failing job or route in the message, widen the projection past its four-field allowlist, add a full-record detail expander and a correlation trace pivot.

**Architecture:** The data is already in CloudWatch; `projectErrorEvent` throws it away. Three read paths with DIFFERENT field shapes: the LIST and TRACE paths parse raw `@message` JSON (nested `err`), while the DETAIL path uses `GetLogRecord` (dot-flattened `err.message`). Vendor SDK error nests are excluded by an ALLOWLIST under `err`, never a denylist.

**Tech Stack:** TypeScript, Node 24, Express 5, pino 9, React, Vitest, Playwright, Terraform, AWS SDK v3 (`@aws-sdk/client-cloudwatch-logs`).

**Spec:** `docs/superpowers/specs/2026-08-24-error-surface-detail-design.md`

**Decision record:** `docs/superpowers/reviews/2026-08-24-error-surface-detail-design-review.md`. 87 findings are already adjudicated there, and the spec's Appendix A lists 9 alternatives considered and REJECTED. Read before proposing a change to any decision below.

## Global Constraints

Exact values from the spec. Every task implicitly includes this section.

- **Truncation:** `message` and `errMessage` cap at **300 characters**, each with its OWN boolean flag. `rawText` caps at **4000 characters** with its own flag. The detail response bound is **65536 BYTES** (measured with `Buffer.byteLength`, not string length) with its own flag.
- **Trace row budget:** **25 rows per side**, 50 max merged.
- **Trace bracket, id-dependent:** `correlationId` -> `at - 5 min` to `at + 5 min`. `requestId` or `pollRunId` -> `at - 30 min` to `at + 5 min`.
- **Trace second boundary:** BEFORE `endTime = Math.floor(atMs / 1000)`. AFTER `startTime = Math.floor(atMs / 1000) + 1`. Windows MUST be disjoint. Never `ceil` for BEFORE's end.
- **`source` union:** `'app' | 'worker' | 'system' | 'unknown'`, derived by comparing the normalised `@log` against the three CONFIGURED group names, never by suffix matching.
- **`err` allowlist (detail path only):** `message`, `stack`, `type`, `name`, `code`, `status`, `response.status`. Everything else beneath `err` dropped AT ANY DEPTH. A SCALAR string `err` is KEPT.
- **Field presence:** `source` and `ref` are REQUIRED and non-null. Everything else follows the existing `errorCode?: string | null` convention.
- **Accessor shapes:** LIST and TRACE parse raw `@message` JSON - `err` is NESTED. DETAIL uses `GetLogRecord` - `err` is dot-FLATTENED. Never conflate.
- **HTTP contract:** a MISSING required query parameter is **400**. A PRESENT but malformed one takes the **degraded 200**. Never a 500.
- **ASCII only** in all new/touched lines (AGENTS.md).
- **Commit discipline:** bare `git status` before every commit; EXPLICIT paths only, never `git add -A`; `Co-Authored-By` trailer.
- **Green between tasks:** every task ends with `npm run typecheck` passing and a commit. A task that leaves the tree red is not done.
- **Gates (bare, never piped):** `npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e`. `npm test` needs `npm run db:start`.
- **NEVER run terraform apply, deploys, secrets pushes, or SSM writes.** Task 14 writes terraform; the human applies it.

### Verified facts you do not need to re-derive

Measured against the real AWS account on 2026-08-24:

- Insights `endTime` IS INCLUSIVE at second granularity: a query with `startTime == endTime == floor(eventMs/1000)` returns that second's events. This is what makes the BEFORE query's anchor guarantee real.
- `@ptr` is byte-STABLE across separate queries, which is why it can be dedup identity and a React key.
- `@log` is `<accountId>:<logGroupName>`.
- A non-JSON record returns ONLY `@`-prefixed metadata plus `backwardToken`/`forwardToken`.

### Real test seams (do not invent others)

- `app/src/jobs/jobs.ts` exports `configureJobsLogger(logger)`, `configureOutboundQueue(adapter)`, `configureJobsClock(clock)`, `_resetForTests()`. The queue adapter's method is `enqueue(envelope, { delaySeconds })`, NOT `send`.
- `app/test/cloudwatch.adapter.test.ts` uses `fakeCw(output)` -> `{ send: vi.fn().mockResolvedValue(output) }` and `createCloudWatchClient({ config: CONFIG, cloudwatch: cw as never, logs: ... as never })`. For a two-call `queryInsights` flow, chain `mockResolvedValueOnce` - copy the pattern from that file's existing `queryInsights` tests.
- `app/test/system.routes.test.ts` builds an app with `makeWebhookHarness()` and authenticates with `.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_ADMIN_COOKIE)`. A request without BOTH gets 401/403, not your asserted status.
- `app/test/errors.test.ts` DOES NOT EXIST. Task 2 creates `app/test/expressErrorHandler.test.ts`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `app/src/jobs/jobs.ts` | Dispatcher message; envelope correlation context | 1, 3 |
| `app/src/lib/errors.ts` | Express handler messages; route-template rule | 2 |
| `app/src/adapters/cloudwatch.ts` | ALL three read paths + the SDK boundary | 4, 6, 8 |
| `app/src/services/systemStatus.ts` | Merge/dedup; detail + trace service methods | 5, 7, 9 |
| `app/src/routes/system.ts` | The two new routes and their validation | 7, 9 |
| `dashboard/src/api/types.ts` | Hand-maintained mirror of backend contracts | 10 |
| `dashboard/src/api/endpoints.ts` | Client functions | 10 |
| `dashboard/src/routes/settings/useSystemStatus.ts` | Fetching, state, abort | 11 |
| `dashboard/src/routes/settings/RecentErrors.tsx` | List rows, chips, expander | 12 |
| `dashboard/src/routes/settings/ErrorTrace.tsx` (NEW) | The trace timeline | 13 |
| `infra/modules/ec2/main.tf` | `logs:GetLogRecord` grant | 14 |
| 16 comment sites, `RUNBOOK.md`, perf ledger | Truth-up | 15 |
| `e2e/tests/dashboard-next/settings.spec.ts` | Hermetic coverage | 16 |

---

### Task 1: Self-describing job dispatcher message

**Files:** Modify `app/src/jobs/jobs.ts:332`; Test `app/test/jobs.test.ts`

**Interfaces:** Produces the message format `job failed: <jobName>`. Task 15 updates two docs quoting the old literal.

- [ ] **Step 1: Write the failing test**

Append to `app/test/jobs.test.ts`. Uses the REAL seams:

```ts
it('names the failing job in the job failed message', async () => {
  const errors: { obj: Record<string, unknown>; msg: string }[] = [];
  configureJobsLogger({
    info: () => {},
    warn: () => {},
    error: (obj: Record<string, unknown>, msg: string) => { errors.push({ obj, msg }); },
  } as unknown as Logger);
  defineJobHandler('test.explodes', async () => { throw new Error('boom'); });
  await expect(
    dispatchJob({
      v: 1,
      jobId: 'j-1',
      jobName: 'test.explodes',
      payload: {},
      correlationContext: {},
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      hopCount: 1,
      enqueuedAt: '2026-08-24T10:00:00.000Z',
    }),
  ).rejects.toThrow('boom');
  const failure = errors.find((l) => l.msg.startsWith('job failed'));
  expect(failure?.msg).toBe('job failed: test.explodes');
  expect(failure?.obj['jobName']).toBe('test.explodes');
});
```

Confirm the file's existing `afterEach(_resetForTests)` (or add one) so the logger swap does not leak into other tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/jobs.test.ts -t "names the failing job"`
Expected: FAIL - received `'job failed'`.

- [ ] **Step 3: Implement**

`app/src/jobs/jobs.ts`, the catch at 324-335 - change ONLY the message argument, keep every structured field:

```ts
        `job failed: ${envelope.jobName}`,
```

- [ ] **Step 4: Verify**

Run: `cd app && npx vitest run test/jobs.test.ts`
Then: `npm run typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/jobs/jobs.ts app/test/jobs.test.ts
git commit -m "feat(observability): name the failing job in the job failed message"
```

---

### Task 2: Express handler messages and the PII refusal

**Files:** Modify `app/src/lib/errors.ts:137-164`; **Create** `app/test/expressErrorHandler.test.ts`

**Interfaces:** `routeLabel(req)` is INTERNAL to `errors.ts` - do not export.

**Why this matters more than its size:** `req.path` can carry a raw E.164 (`app/src/routes/contacts.ts:2317`, `:2376`, `app/src/routes/relayGroups.ts:467`). Putting it in `msg` writes a tenant's phone into a low-cardinality field Task 15 teaches operators to grep. Step 1's first test is the only thing that asserts this; a concrete path in `msg` typechecks, lints and renders fine.

- [ ] **Step 1: Write the failing tests**

Create `app/test/expressErrorHandler.test.ts`. Note the `res` fixtures are typed FIRST and then assigned, because `const res = { status: () => res }` is a TS7022 self-referential initializer and will not compile:

```ts
import { describe, expect, it } from 'vitest';
import { createExpressErrorHandler } from '../src/lib/errors.js';
import { type Logger } from '../src/lib/logger.js';

interface Line { obj: Record<string, unknown>; msg: string }

function capture(): { lines: Line[]; log: Logger } {
  const lines: Line[] = [];
  const log = {
    error: (obj: Record<string, unknown>, msg: string) => { lines.push({ obj, msg }); },
    warn: (obj: Record<string, unknown>, msg: string) => { lines.push({ obj, msg }); },
  };
  return { lines, log: log as unknown as Logger };
}

interface FakeRes { headersSent: boolean; status: (c: number) => FakeRes; json: (b: unknown) => FakeRes }

function fakeRes(headersSent: boolean): FakeRes {
  const res: FakeRes = {
    headersSent,
    status: () => res,
    json: () => res,
  };
  return res;
}

describe('express error handler messages', () => {
  it('does NOT put a concrete phone-bearing path in msg - it uses the route template', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = {
      method: 'DELETE',
      path: '/api/contacts/c-1/phones/+14045551234',
      baseUrl: '/api/contacts',
      route: { path: '/:contactId/phones/:phone' },
    };
    handler(new Error('boom'), req as never, fakeRes(false) as never, () => {});
    const line = lines[0];
    expect(line).toBeDefined();
    expect(line!.msg).not.toContain('+14045551234');
    expect(line!.msg).toContain('/api/contacts/:contactId/phones/:phone');
    expect(line!.msg).toContain('DELETE');
    // path REMAINS a structured field - only its promotion into msg is refused.
    expect(line!.obj['path']).toBe('/api/contacts/c-1/phones/+14045551234');
  });

  it('uses the (unrouted) token when req.route is unset', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = { method: 'POST', path: '/api/whatever', baseUrl: '' };
    handler(new Error('boom'), req as never, fakeRes(false) as never, () => {});
    expect(lines[0]!.msg).toContain('(unrouted)');
  });

  it('gives the headers-already-sent branch a DISTINCT message', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = { method: 'GET', path: '/api/x', baseUrl: '' };
    handler(new Error('boom'), req as never, fakeRes(true) as never, () => {});
    handler(new Error('boom'), req as never, fakeRes(false) as never, () => {});
    expect(lines).toHaveLength(2);
    expect(lines[0]!.msg).not.toBe(lines[1]!.msg);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/expressErrorHandler.test.ts`
Expected: FAIL - messages are fixed literals with no method or template.

- [ ] **Step 3: Implement**

Add above `createExpressErrorHandler`:

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
 * `req.route.path` alone is MOUNT-RELATIVE, so it is prefixed with `req.baseUrl`.
 * `req.route` is unset for middleware, body-parser and URIError failures, which
 * take the literal `(unrouted)` token.
 */
function routeLabel(req: { baseUrl?: string; route?: { path?: string } }): string {
  const path = req.route?.path;
  if (typeof path !== 'string' || path.length === 0) return '(unrouted)';
  return `${req.baseUrl ?? ''}${path}`;
}
```

Then the three messages (structured fields unchanged in all three):

```ts
        `unhandled error after response started: ${req.method} ${routeLabel(req)}`,
```
```ts
        `malformed URI in request - rejected as 400: ${req.method} ${routeLabel(req)}`,
```
```ts
      `unhandled error while handling request: ${req.method} ${routeLabel(req)}`,
```

The middle one also converts the existing em-dash to ASCII.

- [ ] **Step 4: Verify**

Run: `cd app && npx vitest run test/expressErrorHandler.test.ts test/errorSummary.test.ts`
Then: `cd app && LC_ALL=C tr -d '\11\12\15\40-\176' < src/lib/errors.ts | wc -c` (expect `0`)
Then: `npm run typecheck`

If any pre-existing test asserts an old literal, update the TEST - do not weaken the message.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/lib/errors.ts app/test/expressErrorHandler.test.ts
git commit -m "feat(observability): name method and route template in handler errors"
```

---

### Task 3: Propagate pollRunId through the job envelope

**Files:** Modify `app/src/jobs/jobs.ts:174-179`; Test `app/test/jobs.test.ts`

**Interfaces:** Produces `pollRunId` on the envelope's `correlationContext`, and therefore on every log line of a poll-enqueued job. Task 4 projects it; Task 8 pivots on it.

**Why:** without this the trace pivot is dead for the entire worker-poll class - tour reminders, placement nudges, roster actions, extraction, group guardrails.

- [ ] **Step 1: Write the failing test**

Uses the REAL seam. Note the adapter method is `enqueue`, not `send`:

```ts
it('propagates pollRunId into the envelope so a poll-enqueued job can be traced back', async () => {
  const captured: JobEnvelope[] = [];
  configureOutboundQueue({
    enqueue: async (envelope: JobEnvelope) => { captured.push(envelope); },
  } as unknown as OutboundQueueAdapter);
  defineJobHandler('test.polled', async () => {});
  await runWithContext({ pollRunId: 'poll-abc' }, async () => {
    await enqueue('test.polled', { hello: 'world' });
  });
  expect(captured).toHaveLength(1);
  expect(captured[0]!.correlationContext).toEqual({ pollRunId: 'poll-abc' });
});

it('does not invent a pollRunId when the context has none', async () => {
  const captured: JobEnvelope[] = [];
  configureOutboundQueue({
    enqueue: async (envelope: JobEnvelope) => { captured.push(envelope); },
  } as unknown as OutboundQueueAdapter);
  defineJobHandler('test.requested', async () => {});
  await runWithContext({ requestId: 'req-1' }, async () => {
    await enqueue('test.requested', {});
  });
  expect(captured[0]!.correlationContext).toEqual({ requestId: 'req-1' });
  expect(captured[0]!.correlationContext).not.toHaveProperty('pollRunId');
});
```

The second test replaces a tautology: it exercises real repo code and would go red under an unconditional copy or an inverted ladder.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/jobs.test.ts -t "pollRunId"`
Expected: the first FAILS (`correlationContext` is `{}`); the second passes already, which is correct - it is the regression guard.

- [ ] **Step 3: Implement**

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

`CorrelationContext` already declares `pollRunId` (`app/src/lib/context.ts`); confirm before adding it.

- [ ] **Step 4: Verify**

Run: `cd app && npx vitest run test/jobs.test.ts test/scheduler.test.ts test/sqsJobConsumer.test.ts test/twilioStatusWebhook.test.ts`
Then: `npm run typecheck`
Expected: PASS. None of these pins the context key set.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/jobs/jobs.ts app/test/jobs.test.ts
git commit -m "feat(observability): carry pollRunId through the job envelope"
```

---

### Task 4: Widen the list projection

**Files:** Modify `app/src/adapters/cloudwatch.ts`; Test `app/test/cloudwatch.adapter.test.ts`; **also update the 8 `ErrorEventView` fixtures in** `app/test/systemStatus.service.test.ts`

**Interfaces:** Produces (all EXPORTED - the tests import them):

```ts
export type ErrorSource = 'app' | 'worker' | 'system' | 'unknown';
export const FIELD_CAP = 300;
export function normalizeLogGroup(atLog: string): string;
export function projectErrorEvent(row: { field?: string; value?: string }[], config: AppConfig): ErrorEventView;

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
```

`projectErrorEvent` changes from `(rawMessage: string, ts: number)` to `(row, config)` - it reads `@ptr` and `@log` off the row, and needs `config` to compare `@log` against the three CONFIGURED group names. Suffix matching would give a foreign environment's record a real chip instead of `unknown`.

**CRITICAL:** this path parses raw `@message` JSON, where `err` is NESTED. `obj['err.message']` is `undefined` here.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/cloudwatch.adapter.test.ts`, using that file's `CONFIG`:

```ts
describe('projectErrorEvent - widened projection', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const row = (msg: string, ptr = 'PTR1', atLog = `9:${CONFIG.errorLogGroupName}`) => [
    { field: '@timestamp', value: '2026-08-24 10:00:00.000' },
    { field: '@message', value: msg },
    { field: '@ptr', value: ptr },
    { field: '@log', value: atLog },
  ];

  it('reads a NESTED err object, not a dotted key', () => {
    const ev = projectErrorEvent(
      row(line({ level: 50, msg: 'job failed: relay.warm', err: { message: 'boom', type: 'RestException' } })),
      CONFIG,
    );
    expect(ev.errMessage).toBe('boom');
    expect(ev.errType).toBe('RestException');
  });

  it('derives source from the CONFIGURED group names, not a suffix', () => {
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), 'P', `9:${CONFIG.workerLogGroupName}`), CONFIG).source).toBe('worker');
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), 'P', `9:${CONFIG.systemLogGroupName}`), CONFIG).source).toBe('system');
    // A DIFFERENT environment's app group must NOT read as 'app'.
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), 'P', '9:/hc/otherenv/app'), CONFIG).source).toBe('unknown');
  });

  it('caps message and errMessage independently, each with its own flag', () => {
    const ev = projectErrorEvent(row(line({ level: 50, msg: 'x'.repeat(400), err: { message: 'short' } })), CONFIG);
    expect(ev.message).toHaveLength(300);
    expect(ev.messageTruncated).toBe(true);
    expect(ev.errMessage).toBe('short');
    expect(ev.errMessageTruncated).toBe(false);
  });

  it('falls back msg -> event -> err.message -> placeholder', () => {
    expect(projectErrorEvent(row(line({ level: 50, event: 'relay_provisioning_failed' })), CONFIG).message).toBe('relay_provisioning_failed');
    expect(projectErrorEvent(row(line({ level: 50, err: { message: 'only this' } })), CONFIG).message).toBe('only this');
    expect(projectErrorEvent(row(line({ level: 50 })), CONFIG).message).toBe('(unparseable log line)');
  });

  it('does not duplicate the text when message came FROM err.message', () => {
    const ev = projectErrorEvent(row(line({ level: 50, err: { message: 'only this' } })), CONFIG);
    expect(ev.message).toBe('only this');
    expect(ev.errMessage).toBeNull();
  });

  it('carries ref, requestId and pollRunId', () => {
    const ev = projectErrorEvent(row(line({ level: 50, msg: 'x', requestId: 'r-1', pollRunId: 'p-1' })), CONFIG);
    expect(ev.ref).toBe('PTR1');
    expect(ev.requestId).toBe('r-1');
    expect(ev.pollRunId).toBe('p-1');
  });
});
```

Plus, in the existing `queryInsights` describe, assert the clause change:

```ts
    expect(startCmd.input.queryString).toContain('@ptr');
    expect(startCmd.input.queryString).toContain('@log');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts`
Expected: FAIL - `projectErrorEvent` takes a string and the fields do not exist.

- [ ] **Step 3: Implement**

```ts
export type ErrorSource = 'app' | 'worker' | 'system' | 'unknown';

/** Field cap for `message` and `errMessage`. Each carries its OWN flag. */
export const FIELD_CAP = 300;

/** `@log` is `<accountId>:<logGroupName>` - take everything after the last ':'. */
export function normalizeLogGroup(atLog: string): string {
  const at = atLog.lastIndexOf(':');
  return at === -1 ? atLog : atLog.slice(at + 1);
}

function sourceOf(atLog: string | undefined, config: AppConfig): ErrorSource {
  if (atLog === undefined) return 'unknown';
  const name = normalizeLogGroup(atLog);
  // Compare against the CONFIGURED names, not suffixes: /hc/prod/app must not
  // read as 'app' when this process is dev.
  if (name === config.errorLogGroupName) return 'app';
  if (name === config.workerLogGroupName) return 'worker';
  if (name === config.systemLogGroupName) return 'system';
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
 * admin-only and server-enforced. Credentials are handled separately, by the
 * allowlist on the DETAIL path (getLogRecord below).
 *
 * ACCESSOR SHAPE: this path parses the raw `@message` JSON, where `err` is a
 * NESTED object. `obj['err.message']` is undefined here; the dotted form
 * belongs to the GetLogRecord path only.
 */
export function projectErrorEvent(
  row: { field?: string; value?: string }[],
  config: AppConfig,
): ErrorEventView {
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

  const base = {
    timestamp: new Date(parseInsightsTimestamp(tsValue)).toISOString(),
    correlationId: null as string | null,
    errorCode: null as string | null,
    source: sourceOf(atLog, config),
    ref: ptr,
  };

  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) throw new Error('not an object');
    parsed = p as Record<string, unknown>;
  } catch {
    // The LIST path deliberately does NOT surface raw text - that property is
    // preserved and pinned by an existing assertion. Raw text is reachable
    // through the detail path instead.
    return {
      ...base,
      level: 50,
      message: '(unparseable log line)',
      messageTruncated: false,
      errMessageTruncated: false,
    };
  }

  const err =
    typeof parsed['err'] === 'object' && parsed['err'] !== null
      ? (parsed['err'] as Record<string, unknown>)
      : undefined;
  // A SCALAR err is the message itself - six call sites log `err: e.message`.
  const errMessageRaw = err !== undefined ? str(err['message']) : str(parsed['err']);

  const chosen =
    str(parsed['msg']) ?? str(parsed['message']) ?? str(parsed['event']) ?? errMessageRaw ?? '(unparseable log line)';
  const msgCap = capped(chosen);
  // When `message` came FROM err.message they are the same string; leave
  // errMessage null so the row does not render the same text twice.
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
    errType: err !== undefined ? (str(err['type']) ?? str(err['name'])) : null,
    errMessage: errCap?.value ?? null,
    errMessageTruncated: errCap?.truncated ?? false,
    requestId: str(parsed['requestId']),
    pollRunId: str(parsed['pollRunId']),
  };
}
```

`createCloudWatchClient` already holds `config`, so pass it through. In `queryInsights`:

```ts
      const queryString = `fields @timestamp, @message, @ptr, @log | filter ${filterExpr} | sort @timestamp desc | limit ${limit}`;
```
```ts
          return rows.map((row) => projectErrorEvent(row, config)).slice(0, limit);
```

- [ ] **Step 4: Fix the 8 existing fixtures - this task is NOT green without it**

`app/test/systemStatus.service.test.ts` builds 8 `ErrorEventView` literals. `source` and `ref` are REQUIRED, so every one fails typecheck until updated. Add `source: 'app'` and a DISTINCT `ref` (`'PTR-1'`, `'PTR-2'`, ...) to each, plus `messageTruncated: false` and `errMessageTruncated: false`. Distinct refs matter - Task 5 dedups on them.

- [ ] **Step 5: Verify**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts`
Then: `npm run typecheck`
Expected: both PASS. The existing `'(unparseable log line)'` assertion MUST still pass.

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/adapters/cloudwatch.ts app/test/cloudwatch.adapter.test.ts app/test/systemStatus.service.test.ts
git commit -m "feat(observability): widen the error projection past the four-field allowlist"
```

---

### Task 5: Dedup on ref

**Files:** Modify `app/src/services/systemStatus.ts:244-253`; Test `app/test/systemStatus.service.test.ts`

- [ ] **Step 1: Write the failing test**

`getErrors` issues THREE `queryInsights` calls and merges them, so a single-value fake is returned to ALL THREE. Drive the calls apart by filter expression:

```ts
it('keeps two same-instant rows from different log groups apart', async () => {
  const view = (ref: string, source: 'app' | 'worker') => ({
    timestamp: '2026-08-24T10:00:00.000Z',
    level: 50,
    message: 'boom',
    messageTruncated: false,
    correlationId: null,
    errorCode: null,
    errMessageTruncated: false,
    source,
    ref,
  });
  const seam = fakeSeam({
    queryInsights: async (_groups: string[], filterExpr: string) =>
      filterExpr === PINO_ERROR_INSIGHTS_FILTER ? [view('PTR-A', 'app'), view('PTR-B', 'worker')] : [],
  });
  const svc = makeService({ config: CONFIG, cloudwatch: seam });
  const res = await svc.getErrors('1h');
  expect(res.available).toBe(true);
  expect(res.available && res.events).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts -t "same-instant rows"`
Expected: FAIL - 1 row, collapsed by `timestamp|message|errorCode`.

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Verify**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts` then `npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/systemStatus.ts app/test/systemStatus.service.test.ts
git commit -m "feat(observability): dedup error rows on the log-event pointer"
```

---

### Task 6: GetLogRecord seam with the err allowlist

**Files:** Modify `app/src/adapters/cloudwatch.ts`; Test `app/test/cloudwatch.adapter.test.ts`; update `fakeSeam` in `app/test/systemStatus.service.test.ts`

**Interfaces:** Produces

```ts
export interface LogRecordView {
  fields: Record<string, string>;
  rawText?: string;
  rawTextTruncated?: boolean;
  responseTruncated: boolean;
  logGroup: string;
}
export const ERR_ALLOWLIST: readonly string[];
export const RAW_TEXT_CAP = 4000;
export const RESPONSE_BOUND_BYTES = 65536;
// added to CloudWatchClientSeam:
getLogRecord(ref: string): Promise<LogRecordView>;
```

Do NOT stub `queryTrace` here - it does not exist until Task 8, and referencing it now fails this task's own typecheck.

**CRITICAL:** this path sees DOT-FLATTENED keys.

- [ ] **Step 1: Write the failing tests**

Using the file's real fake idiom:

```ts
describe('cloudwatch adapter - getLogRecord', () => {
  const seamFor = (logRecord: Record<string, string>) =>
    createCloudWatchClient({
      config: CONFIG,
      cloudwatch: fakeCw({}) as never,
      logs: fakeCw({ logRecord }) as never,
    });

  it('keeps the allowlisted err fields including response.status', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      'err.message': 'boom',
      'err.type': 'RestException',
      'err.response.status': '404',
      msg: 'job failed: relay.warm',
    }).getLogRecord('PTR');
    expect(out.fields['err.message']).toBe('boom');
    expect(out.fields['err.response.status']).toBe('404');
    expect(out.fields['msg']).toBe('job failed: relay.warm');
  });

  it('drops every other err nest AT ANY DEPTH, including err.cause', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      'err.message': 'boom',
      'err.config.params': 'To=%2B14045551234',
      'err.config.url': 'https://api.twilio.com/x',
      'err.cause.config.headers.Authorization': 'Basic c2lkOnNlY3JldA==',
    }).getLogRecord('PTR');
    expect(out.fields['err.config.params']).toBeUndefined();
    expect(out.fields['err.config.url']).toBeUndefined();
    expect(out.fields['err.cause.config.headers.Authorization']).toBeUndefined();
  });

  it('KEEPS a scalar string err - six call sites log err as a message', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      err: 'Insights query failed',
      msg: 'system status: Logs Insights query failed',
    }).getLogRecord('PTR');
    expect(out.fields['err']).toBe('Insights query failed');
  });

  it('never returns @message or AWS transport metadata for a PARSED record', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      '@message': '{"msg":"x","err":{"config":{"url":"secret"}}}',
      '@logGroupId': 'g',
      backwardToken: 'b/1',
      forwardToken: 'f/1',
      msg: 'x',
    }).getLogRecord('PTR');
    expect(out.fields['@message']).toBeUndefined();
    expect(out.fields['@logGroupId']).toBeUndefined();
    expect(out.fields['backwardToken']).toBeUndefined();
    expect(out.rawText).toBeUndefined();
  });

  it('does NOT hand back the raw line when a JSON record had all its err nests denied', async () => {
    // The record parses and has app fields, but EVERY err.* key was dropped.
    // Gating rawText on "no app fields" instead of "not parseable" would return
    // @message here - which still contains the nest the allowlist just removed.
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      '@message': '{"err":{"config":{"url":"https://api.twilio.com/secret"}}}',
      'err.config.url': 'https://api.twilio.com/secret',
    }).getLogRecord('PTR');
    expect(out.rawText).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('returns capped rawText for a NON-JSON record', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.systemLogGroupName}`,
      '@message': 'Out of memory: Killed process 123 (node)',
      '@timestamp': '1787000000000',
    }).getLogRecord('PTR');
    expect(out.rawText).toContain('Out of memory');
    expect(out.rawTextTruncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts -t "getLogRecord"`
Expected: FAIL - not a function.

- [ ] **Step 3: Implement**

Import `GetLogRecordCommand` alongside the other logs commands, then:

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
export const ERR_ALLOWLIST: readonly string[] = [
  'err.message', 'err.stack', 'err.type', 'err.name', 'err.code', 'err.status', 'err.response.status',
];

export const RAW_TEXT_CAP = 4000;
export const RESPONSE_BOUND_BYTES = 65536;

/** AWS transport metadata - never returned to the client. */
const DROPPED_PREFIXES = ['@aws.', '@entity.', '@data_'];
const DROPPED_KEYS = new Set([
  '@message', '@timestamp', '@logGroupId', '@logStreamId', 'backwardToken', 'forwardToken',
]);

function isAllowedKey(key: string): boolean {
  if (key === 'err') return true;                        // scalar err: the message itself
  if (key.startsWith('err.')) return ERR_ALLOWLIST.includes(key);
  if (DROPPED_KEYS.has(key)) return false;
  if (DROPPED_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;                                           // app-authored field
}

/** Trim `fields` until the serialized response is within the byte bound. */
function enforceBound(fields: Record<string, string>): boolean {
  if (Buffer.byteLength(JSON.stringify(fields), 'utf8') <= RESPONSE_BOUND_BYTES) return false;
  // Longest-first, so one huge stack is trimmed before many small fields.
  const keys = Object.keys(fields).sort((a, b) => fields[b]!.length - fields[a]!.length);
  for (const key of keys) {
    if (Buffer.byteLength(JSON.stringify(fields), 'utf8') <= RESPONSE_BOUND_BYTES) break;
    fields[key] = fields[key]!.slice(0, 512);
  }
  return true;
}
```

In `createCloudWatchClient`'s returned object:

```ts
    async getLogRecord(ref) {
      const out = await logs.send(new GetLogRecordCommand({ logRecordPointer: ref }));
      const record = (out.logRecord ?? {}) as Record<string, string>;
      const atLog = record['@log'] ?? '';
      // PARSEABILITY, not field count, decides rawText. A JSON record whose err
      // nests were ALL denied still has zero surviving err fields - returning
      // its raw line would hand back exactly what the allowlist just removed.
      const rawMessage = record['@message'] ?? '';
      let isJson = false;
      try {
        const p: unknown = JSON.parse(rawMessage);
        isJson = typeof p === 'object' && p !== null;
      } catch {
        isJson = false;
      }

      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!isAllowedKey(key)) continue;
        fields[key] = String(value);
      }

      let rawText: string | undefined;
      let rawTextTruncated = false;
      if (!isJson && rawMessage.length > 0) {
        rawTextTruncated = rawMessage.length > RAW_TEXT_CAP;
        rawText = rawTextTruncated ? rawMessage.slice(0, RAW_TEXT_CAP) : rawMessage;
      }

      return {
        fields,
        ...(rawText !== undefined && { rawText, rawTextTruncated }),
        responseTruncated: enforceBound(fields),
        logGroup: normalizeLogGroup(atLog),
      };
    },
```

Add `getLogRecord(ref: string): Promise<LogRecordView>;` to `CloudWatchClientSeam`.

- [ ] **Step 4: Update the test fake**

`app/test/systemStatus.service.test.ts:38-50` returns a hardcoded literal typed as the FULL seam, so a new required method is a TYPECHECK failure. Add to both the return-type annotation and the literal:

```ts
    getLogRecord: vi.fn(
      impl.getLogRecord ??
        (async () => ({ fields: {}, responseTruncated: false, logGroup: CONFIG.errorLogGroupName })),
    ),
```

- [ ] **Step 5: Verify**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts`
Then: `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/adapters/cloudwatch.ts app/test/cloudwatch.adapter.test.ts app/test/systemStatus.service.test.ts
git commit -m "feat(observability): add GetLogRecord seam with an err allowlist"
```

---

### Task 7: The detail route

**Files:** Modify `app/src/services/systemStatus.ts`, `app/src/routes/system.ts`; Test both test files

**Interfaces:** Produces

```ts
export type DetailResult =
  | { available: true; record: LogRecordView }
  | { available: false; reason: 'unavailable_local' | 'invalid_ref' | 'out_of_scope' | 'cloudwatch_error' };
// added to SystemStatusService:
getErrorDetail(ref: string): Promise<DetailResult>;
```

The interface member and the result type MUST be declared, or the route wiring fails typecheck.

- [ ] **Step 1: Write the failing tests**

Service tests:

```ts
it('rejects a record from a foreign log group', async () => {
  const svc = makeService({
    config: CONFIG,
    cloudwatch: fakeSeam({
      getLogRecord: async () => ({ fields: { msg: 'x' }, responseTruncated: false, logGroup: '/hc/prod/app' }),
    }),
  });
  expect(await svc.getErrorDetail('A'.repeat(32))).toEqual({ available: false, reason: 'out_of_scope' });
});

it('returns the record for an in-scope log group', async () => {
  const svc = makeService({
    config: CONFIG,
    cloudwatch: fakeSeam({
      getLogRecord: async () => ({ fields: { msg: 'x' }, responseTruncated: false, logGroup: CONFIG.errorLogGroupName }),
    }),
  });
  const res = await svc.getErrorDetail('A'.repeat(32));
  expect(res.available).toBe(true);
});

it('degrades a malformed ref without calling AWS', async () => {
  const getLogRecord = vi.fn();
  const svc = makeService({ config: CONFIG, cloudwatch: fakeSeam({ getLogRecord }) });
  expect(await svc.getErrorDetail('!!!')).toEqual({ available: false, reason: 'invalid_ref' });
  expect(getLogRecord).not.toHaveBeenCalled();
});
```

Route tests - these MUST use the harness and BOTH auth headers or they 401:

```ts
describe('GET /api/system/errors/detail', () => {
  it('400s when ref is missing', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/system/errors/detail')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(400);
  });

  it('is admin-only', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/system/errors/detail?ref=AAAA')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(403);
  });

  it('degrades at 200 when a ref is present', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get(`/api/system/errors/detail?ref=${encodeURIComponent('A+B/C=')}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts test/system.routes.test.ts`
Expected: FAIL - method and route do not exist (404, not 400).

- [ ] **Step 3: Implement the service method**

Declare `getErrorDetail` on `SystemStatusService` and export `DetailResult`, then:

```ts
/** Base64-family pointer, bounded. Insights pointers observed at 220 chars. */
const REF_PATTERN = /^[A-Za-z0-9+/=]{16,512}$/;

    async getErrorDetail(ref) {
      if (isLocalEnv(config)) return { available: false, reason: 'unavailable_local' };
      if (!REF_PATTERN.test(ref)) return { available: false, reason: 'invalid_ref' };
      try {
        const record = await cloudwatch.getLogRecord(ref);
        // A ref is an ACCOUNT-scoped pointer bound to nothing. This check makes
        // the route's scope independent of which IAM branch the grant landed on
        // - without it, a pointer from another environment resolves here.
        const allowed = [config.errorLogGroupName, config.workerLogGroupName, config.systemLogGroupName];
        if (!allowed.includes(record.logGroup)) {
          log.warn({ logGroup: record.logGroup }, 'system status: detail record out of scope');
          return { available: false, reason: 'out_of_scope' };
        }
        return { available: true, record };
      } catch (err) {
        log.error(
          { kind: classifyCloudWatchError(err), err: (err as Error).message },
          'system status: GetLogRecord failed',
        );
        return { available: false, reason: 'cloudwatch_error' };
      }
    },
```

- [ ] **Step 4: Implement the route**

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
    res.json(await service.getErrorDetail(ref));
  });
```

- [ ] **Step 5: Verify**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts test/system.routes.test.ts` then `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/services/systemStatus.ts app/src/routes/system.ts app/test/systemStatus.service.test.ts app/test/system.routes.test.ts
git commit -m "feat(observability): add the full-record detail route"
```

---

### Task 8: The trace seam - two queries, id-dependent bracket

**Files:** Modify `app/src/adapters/cloudwatch.ts`; Test `app/test/cloudwatch.adapter.test.ts`; update `fakeSeam`

**Interfaces:** Produces

```ts
export type TraceIdKind = 'correlationId' | 'requestId' | 'pollRunId';
export interface TraceLineView {
  timestamp: string; level: number; message: string; source: ErrorSource;
  method?: string | null; path?: string | null; statusCode?: number | null;
  durationMs?: number | null; jobName?: string | null; jobId?: string | null; hopCount?: number | null;
}
export interface TraceResult { lines: TraceLineView[]; truncatedBefore: boolean; truncatedAfter: boolean }
export const TRACE_SIDE_LIMIT = 25;
// added to CloudWatchClientSeam:
queryTrace(groups: string[], kind: TraceIdKind, id: string, atMs: number): Promise<TraceResult>;
```

**THE TWO HARDEST RULES IN THIS PLAN:**

1. Insights applies `limit` INSIDE the sort. A single ascending query returns the EARLIEST 25 rows and can drop the failure out of its own trace. Two queries with OPPOSITE sorts are required.
2. `StartQuery` takes epoch SECONDS but `at` is milliseconds, so a split exactly at `at` is inexpressible. The anchor's WHOLE SECOND belongs to the BEFORE query. `endTime` is INCLUSIVE (measured), so `endTime = floor(at/1000)` does contain the anchor. Using `ceil` instead overlaps the windows by a second and returns the failure line from BOTH queries.

- [ ] **Step 1: Write the failing tests**

The logs fake must answer StartQuery then GetQueryResults; chain `mockResolvedValueOnce` per call, mirroring the file's existing `queryInsights` tests. Capture the `StartQueryCommand` inputs:

```ts
describe('cloudwatch adapter - queryTrace', () => {
  function traceSeam(beforeRows: unknown[], afterRows: unknown[]) {
    const starts: StartQueryCommand[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof StartQueryCommand) {
        starts.push(command);
        return { queryId: `q${starts.length}` };
      }
      const id = (command as GetQueryResultsCommand).input.queryId;
      return { status: 'Complete', results: id === 'q1' ? beforeRows : afterRows };
    });
    const seam = createCloudWatchClient({
      config: CONFIG,
      cloudwatch: fakeCw({}) as never,
      logs: { send } as never,
    });
    return { seam, starts };
  }
  const row = (iso: string) => [
    { field: '@timestamp', value: iso },
    { field: '@message', value: JSON.stringify({ level: 30, msg: 'x' }) },
    { field: '@log', value: `9:${CONFIG.errorLogGroupName}` },
  ];

  it('uses a -5min bracket for correlationId and -30min for the cross-hop ids', async () => {
    const atMs = Date.parse('2026-08-24T10:00:00.000Z');
    const a = traceSeam([], []);
    await a.seam.queryTrace([CONFIG.errorLogGroupName], 'correlationId', 'c-1', atMs);
    expect(a.starts[0]!.input.startTime).toBe(Math.floor((atMs - 5 * 60_000) / 1000));
    const b = traceSeam([], []);
    await b.seam.queryTrace([CONFIG.errorLogGroupName], 'pollRunId', 'p-1', atMs);
    expect(b.starts[0]!.input.startTime).toBe(Math.floor((atMs - 30 * 60_000) / 1000));
  });

  it('splits at second granularity with DISJOINT windows - the anchor second is in BEFORE', async () => {
    const atMs = Date.parse('2026-08-24T10:00:00.500Z');
    const { seam, starts } = traceSeam([], []);
    await seam.queryTrace([CONFIG.errorLogGroupName], 'correlationId', 'c-1', atMs);
    const before = starts.find((s) => s.input.queryString!.includes('desc'))!;
    const after = starts.find((s) => s.input.queryString!.includes('asc'))!;
    expect(before.input.endTime).toBe(Math.floor(atMs / 1000));
    expect(after.input.startTime).toBe(Math.floor(atMs / 1000) + 1);
    expect(after.input.startTime!).toBeGreaterThan(before.input.endTime!);
  });

  it('merges ascending across the two sides', async () => {
    const { seam } = traceSeam(
      [row('2026-08-24 09:59:59.000'), row('2026-08-24 09:59:58.000')], // desc side
      [row('2026-08-24 10:00:01.000')],
    );
    const out = await seam.queryTrace([CONFIG.errorLogGroupName], 'requestId', 'r-1', Date.parse('2026-08-24T10:00:00.000Z'));
    const times = out.lines.map((l) => l.timestamp);
    expect([...times].sort()).toEqual(times);
  });

  it('flags per-side truncation when a side fills its budget', async () => {
    const full = Array.from({ length: 25 }, () => row('2026-08-24 09:59:59.000'));
    const { seam } = traceSeam(full, []);
    const out = await seam.queryTrace([CONFIG.errorLogGroupName], 'requestId', 'r-1', Date.parse('2026-08-24T10:00:00.000Z'));
    expect(out.truncatedBefore).toBe(true);
    expect(out.truncatedAfter).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts -t "queryTrace"`
Expected: FAIL - not a function.

- [ ] **Step 3: Implement**

Extract the existing StartQuery-then-poll body of `queryInsights` into a private `runInsights(groups, queryString, startTimeSec, endTimeSec, limit): Promise<Row[]>` returning RAW rows, and have both `queryInsights` and `queryTrace` call it. Then:

```ts
export const TRACE_SIDE_LIMIT = 25;
const BRACKET_TIGHT_MS = 5 * 60_000;
const BRACKET_WIDE_MS = 30 * 60_000;
const BRACKET_AHEAD_MS = 5 * 60_000;

/**
 * Project one trace row. Like the LIST path and UNLIKE the detail path, this
 * parses the raw `@message` JSON, so `err` is a NESTED object here.
 */
function traceLine(row: { field?: string; value?: string }[], config: AppConfig): TraceLineView {
  let raw = '';
  let tsValue: string | undefined;
  let atLog: string | undefined;
  for (const cell of row) {
    if (cell.field === '@message') raw = cell.value ?? '';
    else if (cell.field === '@timestamp') tsValue = cell.value ?? undefined;
    else if (cell.field === '@log') atLog = cell.value ?? undefined;
  }
  const timestamp = new Date(parseInsightsTimestamp(tsValue)).toISOString();
  const source = sourceOf(atLog, config);
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

```ts
    async queryTrace(groups, kind, id, atMs) {
      // The cross-hop ids reach BACKWARDS by construction: a job's failure can
      // be ~8 min after its first attempt (SQS 120s visibility x 5 receives)
      // and ~20 min from its enqueue. A tight symmetric bracket reaches none of
      // that, which is the case pollRunId propagation exists to serve.
      const back = kind === 'correlationId' ? BRACKET_TIGHT_MS : BRACKET_WIDE_MS;
      const startSec = Math.floor((atMs - back) / 1000);
      const endSec = Math.ceil((atMs + BRACKET_AHEAD_MS) / 1000);
      // SECOND-GRANULARITY SPLIT. `at` is milliseconds; StartQuery is seconds,
      // so a split exactly at `at` is inexpressible. Insights `endTime` is
      // INCLUSIVE (measured), so giving BEFORE the anchor's whole second
      // guarantees the anchor line is present, and starting AFTER at the NEXT
      // second keeps the windows DISJOINT - no row appears twice, so no merge
      // dedup rule is needed. Do NOT use ceil here: that overlaps by a second
      // and returns the failure line itself from both queries.
      const anchorSec = Math.floor(atMs / 1000);
      const fields = 'fields @timestamp, @message, @log';
      const filter = `filter ${kind} = "${id}"`;
      // Parallel: each Insights poll has a bounded ~8s budget, so sequential
      // would double the worst-case wait on a user-initiated click.
      const [beforeRows, afterRows] = await Promise.all([
        runInsights(groups, `${fields} | ${filter} | sort @timestamp desc | limit ${TRACE_SIDE_LIMIT}`, startSec, anchorSec, TRACE_SIDE_LIMIT),
        runInsights(groups, `${fields} | ${filter} | sort @timestamp asc | limit ${TRACE_SIDE_LIMIT}`, anchorSec + 1, endSec, TRACE_SIDE_LIMIT),
      ]);
      return {
        lines: [
          ...beforeRows.map((r) => traceLine(r, config)).reverse(),
          ...afterRows.map((r) => traceLine(r, config)),
        ],
        truncatedBefore: beforeRows.length >= TRACE_SIDE_LIMIT,
        truncatedAfter: afterRows.length >= TRACE_SIDE_LIMIT,
      };
    },
```

- [ ] **Step 4: Update the fake and verify**

Add `queryTrace` to `fakeSeam`'s literal and return type:

```ts
    queryTrace: vi.fn(
      impl.queryTrace ?? (async () => ({ lines: [], truncatedBefore: false, truncatedAfter: false })),
    ),
```

Run: `cd app && npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts` then `npm run typecheck`
Expected: PASS, including the pre-existing `sort @timestamp desc` assertion for the LIST query.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/adapters/cloudwatch.ts app/test/cloudwatch.adapter.test.ts app/test/systemStatus.service.test.ts
git commit -m "feat(observability): add the two-query correlation trace seam"
```

---

### Task 9: The trace route

**Files:** Modify `app/src/services/systemStatus.ts`, `app/src/routes/system.ts`; Test both

**Interfaces:** Produces

```ts
export type TraceServiceResult =
  | { available: true; lines: TraceLineView[]; truncatedBefore: boolean; truncatedAfter: boolean }
  | { available: false; reason: 'unavailable_local' | 'invalid_id' | 'cloudwatch_error' };
// added to SystemStatusService:
getTrace(kind: TraceIdKind, id: string, atMs: number): Promise<TraceServiceResult>;
```

- [ ] **Step 1: Write the failing tests**

The hermetic harness is a LOCAL env, so the service short-circuits to `unavailable_local` BEFORE any validation. Assert id validation at the SERVICE level with a non-local config, and assert only the 400s through the route:

```ts
const UUID = '11111111-2222-4333-8444-555555555555';

it('validates the id before calling AWS', async () => {
  const queryTrace = vi.fn();
  const svc = makeService({ config: DEPLOYED_CONFIG, cloudwatch: fakeSeam({ queryTrace }) });
  expect(await svc.getTrace('correlationId', 'not-a-uuid', Date.now()))
    .toEqual({ available: false, reason: 'invalid_id' });
  expect(queryTrace).not.toHaveBeenCalled();
});

it('queries app and worker but NOT the system group', async () => {
  const seen: string[][] = [];
  const svc = makeService({
    config: DEPLOYED_CONFIG,
    cloudwatch: fakeSeam({
      queryTrace: async (g: string[]) => { seen.push(g); return { lines: [], truncatedBefore: false, truncatedAfter: false }; },
    }),
  });
  await svc.getTrace('correlationId', UUID, Date.parse('2026-08-24T10:00:00.000Z'));
  expect(seen[0]).toEqual([DEPLOYED_CONFIG.errorLogGroupName, DEPLOYED_CONFIG.workerLogGroupName]);
});
```

`DEPLOYED_CONFIG` is `loadConfig` with an `appEnv` that is not `local` and a non-console messaging driver, so `isLocalEnv` is false. Build it beside the file's existing `CONFIG`.

Route tests (harness + BOTH headers):

```ts
describe('GET /api/system/trace', () => {
  const auth = (r: request.Test) => r.set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
  const AT = '2026-08-24T10:00:00.000Z';

  it('400s with no id, with several ids, and with a bad at', async () => {
    const { app } = makeWebhookHarness();
    expect((await auth(request(app).get(`/api/system/trace?at=${AT}`))).status).toBe(400);
    expect((await auth(request(app).get(`/api/system/trace?correlationId=${UUID}&requestId=${UUID}&at=${AT}`))).status).toBe(400);
    expect((await auth(request(app).get(`/api/system/trace?correlationId=${UUID}&at=nonsense`))).status).toBe(400);
  });

  it('returns 200 for a well-formed request', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get(`/api/system/trace?correlationId=${UUID}&at=${AT}`));
    expect(res.status).toBe(200);
  });

  it('is admin-only', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get(`/api/system/trace?correlationId=${UUID}&at=${AT}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts test/system.routes.test.ts -t trace`
Expected: FAIL - 404 from a missing route; service method absent.

- [ ] **Step 3: Implement the service method**

Declare `getTrace` on `SystemStatusService` and export `TraceServiceResult`, then:

```ts
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    async getTrace(kind, id, atMs) {
      if (isLocalEnv(config)) return { available: false, reason: 'unavailable_local' };
      if (!UUID_PATTERN.test(id)) return { available: false, reason: 'invalid_id' };
      try {
        // app + worker only. The system group's kernel lines carry no
        // correlation id at all, so scanning it costs bytes for nothing.
        const trace = await cloudwatch.queryTrace(
          [config.errorLogGroupName, config.workerLogGroupName],
          kind,
          id,
          atMs,
        );
        return { available: true, ...trace };
      } catch (err) {
        log.error(
          { kind: classifyCloudWatchError(err), err: (err as Error).message },
          'system status: trace query failed',
        );
        return { available: false, reason: 'cloudwatch_error' };
      }
    },
```

- [ ] **Step 4: Implement the route**

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

- [ ] **Step 5: Verify**

Run: `cd app && npx vitest run test/systemStatus.service.test.ts test/system.routes.test.ts` then `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/services/systemStatus.ts app/src/routes/system.ts app/test/systemStatus.service.test.ts app/test/system.routes.test.ts
git commit -m "feat(observability): add the correlation trace route"
```

---

### Task 10: Dashboard wire layer

**Files:** Modify `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`, `dashboard/src/routes/settings/RecentErrors.test.tsx`

**Interfaces:** Produces `SystemErrorEvent` (widened), `SystemLogRecord`, `SystemTraceLine`, `SystemErrorDetailResult`, `SystemTraceResult`, `getSystemErrorDetail`, `getSystemTrace`.

The two result types MUST be DISCRIMINATED UNIONS on `available`, or Task 13's `result.lines` access does not narrow and will not compile.

- [ ] **Step 1: Mirror the types**

```ts
/** Mirrors the backend ErrorSource union - all four values. */
export type SystemErrorSource = 'app' | 'worker' | 'system' | 'unknown';

export interface SystemErrorEvent {
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
  /** REQUIRED: every row has one. An optional field would add a fifth state. */
  source: SystemErrorSource;
  /** REQUIRED: the opaque log-event pointer. Row key and detail handle. */
  ref: string;
}

export interface SystemLogRecord {
  fields: Record<string, string>;
  rawText?: string;
  rawTextTruncated?: boolean;
  responseTruncated: boolean;
  logGroup: string;
}

export interface SystemTraceLine {
  timestamp: string;
  level: number;
  message: string;
  source: SystemErrorSource;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  jobName?: string | null;
  jobId?: string | null;
  hopCount?: number | null;
}

/** DISCRIMINATED on `available` so the component narrows. */
export type SystemErrorDetailResult =
  | { available: true; record: SystemLogRecord }
  | { available: false; reason: string };

export type SystemTraceResult =
  | { available: true; lines: SystemTraceLine[]; truncatedBefore: boolean; truncatedAfter: boolean }
  | { available: false; reason: string };
```

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

`source` and `ref` are REQUIRED, so `RecentErrors.test.tsx:67-68` and `:88-92` fail typecheck. Add `source: 'app'`, a distinct `ref`, `messageTruncated: false` and `errMessageTruncated: false` to each. Do NOT weaken the types.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck`

```bash
git status
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/routes/settings/RecentErrors.test.tsx
git commit -m "feat(observability): mirror the widened error contracts in the dashboard"
```

---

### Task 11: Detail and trace hooks

**Files:** Modify `dashboard/src/routes/settings/useSystemStatus.ts`

**Interfaces:** Produces `useErrorDetail()` and `useErrorTrace()`.

Fetching lives here, not in a component - mirror `useSystemErrors`'s `abortRef` pattern at `:183-210`. Note for Task 15: this step ADDS imports at the top of the file, which shifts the line ranges the perf ledger pins.

- [ ] **Step 1: Add the hooks**

Add `getSystemErrorDetail`, `getSystemTrace`, `SystemErrorDetailResult`, `SystemTraceResult` to the file's existing import block, then:

```ts
export function useErrorDetail(): {
  status: FetchStatus;
  result: SystemErrorDetailResult | null;
  load: (ref: string) => void;
  reset: () => void;
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
      .then((next) => {
        if (controller.signal.aborted) return;
        setResult(next);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setStatus('error');
      });
  }, []);
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setResult(null);
    setStatus('ready');
  }, []);
  return { status, result, load, reset };
}

export function useErrorTrace(): {
  status: FetchStatus;
  result: SystemTraceResult | null;
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
        .then((next) => {
          if (controller.signal.aborted) return;
          setResult(next);
          setStatus('ready');
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          setStatus('error');
        });
    },
    [],
  );
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setResult(null);
    setStatus('ready');
  }, []);
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

**Files:** Modify `dashboard/src/routes/settings/RecentErrors.tsx`, `SystemStatusSection.module.css`, `RecentErrors.test.tsx`

**PRESERVE what the row already renders.** `RecentErrors.test.tsx:79`, `:81` and `:100` assert the `errorCode` chip ("error 30034"), the `correlationId` line ("id: ...") and warn-level styling. The new row ADDS to `ErrorRow`; it does not replace those.

- [ ] **Step 1: Write the failing tests**

Real assertions, not empty bodies:

```ts
const base = {
  timestamp: '2026-08-24T10:00:00.000Z',
  level: 50,
  message: 'job failed: relay.warmNumber',
  messageTruncated: false,
  correlationId: 'c-1',
  errMessageTruncated: false,
  source: 'worker' as const,
  ref: 'PTR-1',
};

it('renders the source chip for all four values', () => {
  for (const [source, label] of [['app', 'app'], ['worker', 'worker'], ['system', 'host'], ['unknown', 'unknown']] as const) {
    const { unmount } = render(<RecentErrorsHarness events={[{ ...base, source, ref: `R-${source}` }]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    unmount();
  }
});

it('renders a jobName chip when present, else the event chip', () => {
  render(<RecentErrorsHarness events={[{ ...base, jobName: 'relay.warmNumber' }]} />);
  expect(screen.getByText('relay.warmNumber')).toBeInTheDocument();
});

it('marks a truncated message', () => {
  render(<RecentErrorsHarness events={[{ ...base, messageTruncated: true }]} />);
  expect(screen.getByText(/truncated/i)).toBeInTheDocument();
});

it('renders errMessage alongside message when they differ, with its own flag', () => {
  render(
    <RecentErrorsHarness
      events={[{ ...base, message: 'job failed: relay.warmNumber', errMessage: 'RestException [HTTP 404]', errMessageTruncated: true }]}
    />,
  );
  expect(screen.getByText(/job failed: relay.warmNumber/)).toBeInTheDocument();
  expect(screen.getByText(/RestException \[HTTP 404\]/)).toBeInTheDocument();
  expect(screen.getAllByText(/truncated/i)).toHaveLength(1);
});

it('does not render errMessage when the ladder already put it in message', () => {
  render(<RecentErrorsHarness events={[{ ...base, message: 'only this', errMessage: null }]} />);
  expect(screen.getAllByText(/only this/)).toHaveLength(1);
});

it('prefers requestId, then pollRunId, then correlationId for the trace link', () => {
  render(<RecentErrorsHarness events={[{ ...base, requestId: 'r-1', pollRunId: 'p-1' }]} />);
  const link = screen.getByRole('button', { name: /trace/i });
  fireEvent.click(link);
  expect(screen.getByTestId('trace-kind')).toHaveTextContent('requestId');
});

it('renders NO trace control when all three ids are null', () => {
  render(<RecentErrorsHarness events={[{ ...base, correlationId: null }]} />);
  expect(screen.queryByRole('button', { name: /trace/i })).toBeNull();
});

it('toggles the expander with aria-expanded', () => {
  render(<RecentErrorsHarness events={[base]} />);
  const toggle = screen.getByRole('button', { name: /show all/i });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
});
```

Mock `getSystemErrorDetail` and `getSystemTrace` with `vi.mock` on the endpoints module, returning resolved values - NOT bare `vi.fn()`, which returns `undefined` and kills the component on `.then()` (a known past failure in this repo).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run dashboard/src/routes/settings/RecentErrors.test.tsx`
Expected: FAIL - no chips, no expander, no trace control.

- [ ] **Step 3: Implement**

Change the row key at `:127` to `key={ev.ref}`. Add the helpers:

```ts
/**
 * Which id drives the trace link. requestId and pollRunId are the CROSS-HOP
 * ids - they reach back to the request or the poll tick that enqueued the work -
 * so they win over correlationId, which for a job line is just that one job run.
 *
 * OOM rows are non-JSON, so all three are null there. That is not an edge case:
 * those rows are synthesized by the service and are exactly the ones an operator
 * clicks. With no id, render NO control - never `?correlationId=null`.
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

Then extend `ErrorRow`, KEEPING its existing `errorCode` chip, `correlationId` line and warn styling:

```tsx
function ErrorRow({ event }: { event: SystemErrorEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [tracing, setTracing] = useState(false);
  const detail = useErrorDetail();
  const isWarn = event.level < 50;
  const code = event.errorCode;
  const pivot = tracePivot(event);
  const chip = event.jobName ?? event.event;
  return (
    <li className={styles.errorRow}>
      <div className={styles.errorMeta}>
        <span className={styles.errorWhen}>{formatWhen(event.timestamp)}</span>
        <span className={`${styles.errorLevel} ${isWarn ? (styles.errorLevelWarn ?? '') : ''}`}>
          {levelLabel(event.level)}
        </span>
        <span className={styles.errorChip}>{SOURCE_LABEL[event.source]}</span>
        {chip != null && chip.length > 0 ? <span className={styles.errorChip}>{chip}</span> : null}
        {event.errType != null ? <span className={styles.errorChip}>{event.errType}</span> : null}
        {code !== null && code !== undefined && code.length > 0 ? (
          <span className={styles.errorCode}>error {code}</span>
        ) : null}
      </div>
      <p className={styles.errorMessage}>
        {event.message}
        {event.messageTruncated ? <span className={styles.truncated}> (truncated)</span> : null}
      </p>
      {/*
        errMessage is non-null ONLY when it differs from `message` (Task 4), and
        that is the COMMON case for a job failure: `message` is
        "job failed: relay.warmNumber" while errMessage is the vendor text that
        actually says what went wrong. Rendering it here is the point of the
        feature, and it is also the only place errMessageTruncated is surfaced.
      */}
      {event.errMessage != null ? (
        <p className={styles.errorDetail}>
          {event.errMessage}
          {event.errMessageTruncated ? <span className={styles.truncated}> (truncated)</span> : null}
        </p>
      ) : null}
      {event.correlationId !== null ? (
        <span className={styles.errorCorrelation}>id: {event.correlationId}</span>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { if (!open) detail.load(event.ref); setOpen(!open); }}
      >
        {open ? 'Hide details' : 'Show all'}
      </button>
      {pivot !== null ? (
        <button type="button" onClick={() => setTracing(!tracing)}>
          {tracing ? 'Hide trace' : 'Trace'}
        </button>
      ) : null}
      {open ? <ErrorDetail state={detail} /> : null}
      {tracing && pivot !== null ? (
        <ErrorTrace kind={pivot.kind} id={pivot.id} at={event.timestamp} />
      ) : null}
    </li>
  );
}
```

`ErrorDetail` renders `detail.result`: on `available:false` the degraded notice; otherwise the `fields` map as a key/value list, `err.stack` in its own scroll container, `rawText` when present, and a marker for `rawTextTruncated` and `responseTruncated`.

`ErrorTrace` arrives in Task 13. Until then this file does not compile - so implement Task 13 BEFORE running this task's Step 4, or temporarily render a placeholder and replace it in Task 13. Prefer doing 13 first and committing them together if you are executing strictly task-by-task.

- [ ] **Step 4: Add the CSS classes**

`SystemStatusSection.module.css` has no `.errorChip` or `.truncated`. Add both, following the file's existing `.errorCode` / `.errorLevel` conventions.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run dashboard/src/routes/settings/RecentErrors.test.tsx` then `npm run typecheck`

```bash
git status
git add dashboard/src/routes/settings/RecentErrors.tsx dashboard/src/routes/settings/RecentErrors.test.tsx dashboard/src/routes/settings/SystemStatusSection.module.css
git commit -m "feat(observability): widen the error row and add the detail expander"
```

---

### Task 13: The trace view

**Files:** Create `dashboard/src/routes/settings/ErrorTrace.tsx` and `ErrorTrace.test.tsx`; add CSS classes

Task 12 imports this component. If you are executing strictly one task at a time, do THIS task first and commit the pair together.

- [ ] **Step 1: Write the failing tests**

```ts
const line = (timestamp: string, message: string, source: 'app' | 'worker' = 'app') => ({
  timestamp, level: 30, message, source,
});

it('renders lines in the order given, each with a source chip', () => {
  mockTrace({ available: true, lines: [line('2026-08-24T09:59:59.000Z', 'job started', 'worker'), line('2026-08-24T10:00:00.000Z', 'job failed: relay.warm', 'worker')], truncatedBefore: false, truncatedAfter: false });
  render(<ErrorTrace kind="requestId" id="r-1" at="2026-08-24T10:00:00.000Z" />);
  const items = screen.getAllByRole('listitem');
  expect(items[0]).toHaveTextContent('job started');
  expect(items[1]).toHaveTextContent('job failed: relay.warm');
  expect(screen.getAllByText('worker')).toHaveLength(2);
});

it('marks the anchor row by TEXT, not colour alone', () => {
  mockTrace({ available: true, lines: [line('2026-08-24T09:59:59.000Z', 'before'), line('2026-08-24T10:00:00.000Z', 'the failure')], truncatedBefore: false, truncatedAfter: false });
  render(<ErrorTrace kind="requestId" id="r-1" at="2026-08-24T10:00:00.000Z" />);
  expect(screen.getByText('this failure')).toBeInTheDocument();
});

it('surfaces per-side truncation', () => {
  mockTrace({ available: true, lines: [line('2026-08-24T10:00:00.000Z', 'x')], truncatedBefore: true, truncatedAfter: false });
  render(<ErrorTrace kind="requestId" id="r-1" at="2026-08-24T10:00:00.000Z" />);
  expect(screen.getByText(/Earlier lines were cut off/i)).toBeInTheDocument();
  expect(screen.queryByText(/Later lines were cut off/i)).toBeNull();
});

it('distinguishes an EMPTY trace from a DEGRADED one', () => {
  mockTrace({ available: true, lines: [], truncatedBefore: false, truncatedAfter: false });
  const { unmount } = render(<ErrorTrace kind="requestId" id="r-1" at="2026-08-24T10:00:00.000Z" />);
  expect(screen.getByText(/No lines found/i)).toBeInTheDocument();
  unmount();
  mockTrace({ available: false, reason: 'unavailable_local' });
  render(<ErrorTrace kind="requestId" id="r-1" at="2026-08-24T10:00:00.000Z" />);
  expect(screen.getByText(/Available in deployed environments/i)).toBeInTheDocument();
  expect(screen.queryByText(/No lines found/i)).toBeNull();
});
```

`mockTrace` sets the resolved value of a `vi.mock`ed `getSystemTrace`. Never a bare `vi.fn()`.

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
  // blank panel is the failure mode this view exists to avoid.
  if (!result.available) return <p className={styles.degraded}>Available in deployed environments.</p>;
  if (result.lines.length === 0) return <p className={styles.empty}>No lines found around this event.</p>;

  return (
    <div>
      {result.truncatedBefore ? (
        <p className={styles.truncated}>Earlier lines were cut off (limit reached).</p>
      ) : null}
      <ol className={styles.traceList}>
        {result.lines.map((l: SystemTraceLine, i: number) => (
          <li
            key={`${l.timestamp}-${i}`}
            className={l.timestamp === at ? styles.traceAnchor : styles.traceLine}
          >
            <span className={styles.errorWhen}>{l.timestamp}</span>
            <span className={styles.errorChip}>{l.source}</span>
            <span>{l.message}</span>
            {l.timestamp === at ? <span className={styles.errorChip}>this failure</span> : null}
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

Add `.traceList`, `.traceLine`, `.traceAnchor` to the CSS module. The anchor is marked by TEXT ("this failure") as well as styling - the panel's existing rule is that status is never conveyed by colour alone.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run dashboard/src/routes/settings/` then `npm run typecheck`

```bash
git status
git add dashboard/src/routes/settings/ErrorTrace.tsx dashboard/src/routes/settings/ErrorTrace.test.tsx dashboard/src/routes/settings/SystemStatusSection.module.css
git commit -m "feat(observability): add the correlation trace view"
```

---

### Task 14: IAM grant for GetLogRecord

**Files:** Modify `infra/modules/ec2/main.tf`

**DO NOT RUN TERRAFORM PLAN OR APPLY.** Write the change only; the human applies it.

- [ ] **Step 1: Add the statement**

`GetLogRecord` takes only an opaque `logRecordPointer` - no log group appears in the request, so IAM has nothing to scope on. It belongs with `GetQueryResults` and `StopQuery`, which this file already pins to `"*"` for the same reason. Defaulting to a SCOPED statement would produce an AccessDenied that no gate can catch: the route degrades to `{ available: false }`, which is indistinguishable from "no AWS".

Add to the existing `SystemStatusInsightsResults` statement:

```hcl
  statement {
    sid = "SystemStatusInsightsResults"
    # GetQueryResults + StopQuery + GetLogRecord do NOT support resource-level
    # permissions. GetLogRecord takes only an opaque logRecordPointer - no log
    # group is present in the request for IAM to match on. Env scoping for the
    # detail route is enforced IN THE APP instead (services/systemStatus.ts
    # rejects any record whose @log is not one of this env's three groups), so
    # this "*" is not the security boundary.
    actions   = ["logs:GetQueryResults", "logs:StopQuery", "logs:GetLogRecord"]
    resources = ["*"]
  }
```

If the AWS Service Authorization Reference shows `GetLogRecord` DOES support a `log-group` resource type, prefer a scoped statement instead and cite the reference inline. Verify before committing.

- [ ] **Step 2: Validate without applying**

Run: `cd infra && terraform fmt -check && terraform validate`
Expected: PASS. Do NOT run plan or apply.

- [ ] **Step 3: Commit**

```bash
git status
git add infra/modules/ec2/main.tf
git commit -m "feat(infra): grant logs:GetLogRecord for the error detail route"
```

---

### Task 15: Truth-up comments, docs, and the perf ledger

**Files:** comment sites, `RUNBOOK.md`, `e2e/performance/routes.ts`, `e2e/performance/collect.test.ts`, a new `docs/issues/` entry

- [ ] **Step 1: Update the perf source-citation ledger**

Task 11 added imports ABOVE the ranges the harness pins, so these three MUST change TOGETHER:

- `e2e/performance/routes.ts:680` - `useSystemStatus.ts:77-132`
- `e2e/performance/routes.ts:762` - `useSystemStatus.ts:124-132`
- `e2e/performance/collect.test.ts:353` - the same string, pinned as a literal

Open `useSystemStatus.ts`, find the real new line numbers for the `/settings/system` base block and the `systemAlarms` background block, and update all three. Leaving them stale keeps every gate green while the ledger silently lies - `routes.test.ts:401-434`'s `cited()` helper only regex-checks citation SHAPE, never that the lines exist. Updating only `routes.ts` turns `collect.test.ts` red.

Endpoint TEMPLATES are conditional: only if a profiler walk reaches the expander, and then with `conditional(...)`, never `required(...)`.

- [ ] **Step 2: Rewrite the retired PII guarantee**

Tasks 4 and 6 already rewrote the `cloudwatch.ts` docblocks they replaced. The remaining sites:

`app/src/adapters/cloudwatch.ts:12-14` (file header); `app/src/services/systemStatus.ts:15-22`; `app/src/routes/system.ts:14-18`, `:63`; `dashboard/src/api/endpoints.ts:2095`; `dashboard/src/routes/settings/RecentErrors.tsx:1-7`; `RecentErrors.test.tsx:2`, `:63`; `app/src/adapters/messaging.ts:700`; `docs/issues/fake-twilio-messaging-attach-404.md:45`.

Rewrite each to the new posture - admin-only, may contain PII, credentials handled by the detail-path allowlist. Do not delete them.

**NOT a correction:** `app/test/cloudwatch.adapter.test.ts:7`, `:129`. "PII-safety: raw text never surfaced" is still TRUE of the list path. EXTEND it to note the detail path surfaces raw text; do not "fix" it.

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

### Task 16: Extend the hermetic e2e coverage

**Files:** Modify `e2e/tests/dashboard-next/settings.spec.ts:131-137`

The spec's testing section requires this and no other task delivers it.

- [ ] **Step 1: Extend the System status assertions**

The hermetic stack has no AWS, so the errors block degrades - that is the only reachable state, and it is what must stay true. Add assertions that the Recent errors block still renders its heading and the degraded notice after this change, using accessibility-first selectors per `e2e/support/selectors.md`.

- [ ] **Step 2: Run the lane**

Run: `npm run e2e`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git status
git add e2e/tests/dashboard-next/settings.spec.ts
git commit -m "test(e2e): cover the widened System Status errors block"
```

---

## Final gates

Run BARE from `W:\tmp\error-surface-detail`, never piped. Read the verdict from the log, not a wrapper exit code.

- [ ] `npm run db:start`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run smoke`
- [ ] `npm run e2e`
- [ ] Sync `main` into the branch ONCE, at the end, then re-run the gates.

If `npm test` is red on DynamoDB Local suites, re-run under a clean key BEFORE blaming the change: `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run`.

**Owed to the human at handback:** terraform plan and apply, dev AND prod, before deploy. Until applied, the detail expander 403s and degrades.
