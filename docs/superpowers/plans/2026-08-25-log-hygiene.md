# Log Hygiene (C3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the C3 log-hygiene cluster: structurally safe vendor-error
logging with two enforcement guards, phone masking at every request-path log
sink and OTel span, system-SID markers for unpersisted relay legs, push-retry
floor + push status surfacing, full-identity voice push labels (role kept),
a distinct ai-runs "unavailable" row state, and the sanctioned daily
abandoned-journal sweep.

**Architecture:** One safe pino serializer bound to the four error-carrying
keys (primitives and non-Error objects pass through; `instanceof Error` gets
an allowlist); a runtime credential-probe test plus a catch-clause-aware
static AST guard keep the class closed. Riders ride the same branch as
self-contained slices. The journal sweep is a cursor-resumed daily Scan on
the worker's cadence-claim pattern.

**Tech Stack:** TypeScript (NodeNext), pino 9, Vitest, DynamoDB
DocumentClient, @opentelemetry/instrumentation-http, React (dashboard).

**Spec:** docs/superpowers/specs/2026-08-24-log-hygiene-design.md (v5 - READ
IT FIRST; it carries the decision history and the exact semantics each task
delivers).

## Global Constraints

- Worktree: W:\tmp\log-hygiene, branch feat/log-hygiene. NEVER touch the
  shared main checkout; run everything from the worktree.
- ASCII-ONLY in every new/edited line of specs, plans, issues, comments,
  test names, and log strings. Existing non-ASCII lines you do not touch may
  stay. Never rewrite files with PowerShell pipelines; use edit tools.
- DO NOT TOUCH these files (another agent's in-flight C1 mission):
  app/src/lib/unreadFeed.ts, app/src/routes/inbox.ts,
  app/src/routes/contacts.ts, app/src/repos/conversationsRepo.ts,
  app/src/repos/contactsRepo.ts. (Reading them is fine.)
- Commit discipline: bare `git status` before EVERY commit; stage and commit
  EXPLICIT paths only (never `git add -A`); every commit carries
  `Co-Authored-By:` naming your model.
- Tests: `npm test` needs DynamoDB Local (`npm run db:start` from the
  worktree root, once). Run single files with
  `cd app && npx vitest run test/<file>.test.ts`.
- Never run `npm run e2e` and commit at the same time; never test against
  ports :5174/:8080 (the human's live stack).
- No infra mutations, no new dependencies, no message-catalog entries.
- Constants (spec values, verbatim): REFRESH_RETRY_FLOOR_MS = 30_000;
  syssid marker TTL = 30 days (epoch SECONDS); JOURNAL_SWEEP_MIN_AGE_MS =
  24h; MAX_CONTACTS_PER_RUN = 25; MAX_RECOVERY_CALLS_PER_RUN = 100;
  MAX_SCAN_PAGES = 20; SCAN_PAGE_LIMIT = 200; recoverAbandoned maxAttempts
  default 2, sweep passes 12; serializer cause depth 3, aggregate cap 5;
  push TTL/stale bounds unchanged.

---

### Task 1: Safe error serializer module

**Files:**
- Create: `app/src/lib/logSerializers.ts`
- Test: `app/test/logSerializers.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module - NO imports from logger.ts or errors.ts;
  logger.ts will import THIS, and errors.ts imports logger.ts, so any import
  back into those files is a cycle).
- Produces: `serializeLoggedError(value: unknown): unknown` and
  `LOG_SERIALIZER_KEYS = ['err','error','cause','reason'] as const` -
  Task 2 wires them into createLogger; Task 3's tests import both.

- [ ] **Step 1: Write the failing test**

```ts
// app/test/logSerializers.test.ts
import { describe, expect, it } from 'vitest';
import { LOG_SERIALIZER_KEYS, serializeLoggedError } from '../src/lib/logSerializers.js';

const FAKE_BASIC = 'Basic U0tmYWtlOnNlY3JldGZha2U='; // base64('SKfake:secretfake')

function axiosLikeError(): Error {
  const err = new Error('connect ECONNRESET 3.229.1.1:443') as Error & Record<string, unknown>;
  err.name = 'AxiosError';
  err.code = 'ECONNRESET';
  err.config = {
    url: 'https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages.json',
    headers: { Authorization: FAKE_BASIC },
    data: 'To=%2B15551230000&Body=hello',
  };
  err.request = { _header: `POST /x HTTP/1.1\r\nAuthorization: ${FAKE_BASIC}\r\n\r\n` };
  err.response = { status: 500, data: 'To=%2B15551230000' };
  return err;
}

describe('serializeLoggedError', () => {
  it('exports the four wired keys', () => {
    expect([...LOG_SERIALIZER_KEYS]).toEqual(['err', 'error', 'cause', 'reason']);
  });

  it('passes primitives through unchanged (domain reason/error fields)', () => {
    expect(serializeLoggedError('signature mismatch')).toBe('signature mismatch');
    expect(serializeLoggedError(30007)).toBe(30007);
    expect(serializeLoggedError(undefined)).toBeUndefined();
    expect(serializeLoggedError(null)).toBeNull();
  });

  it('passes non-Error objects through unchanged (summarizeError / err:{name} shapes)', () => {
    const summary = { name: 'RestException', code: '30007', status: 400 };
    expect(serializeLoggedError(summary)).toBe(summary);
    const nameOnly = { name: 'ProvisioningRefused' };
    expect(serializeLoggedError(nameOnly)).toBe(nameOnly);
  });

  it('allowlists an Error: no config/request/response survive, stack+message do', () => {
    const out = serializeLoggedError(axiosLikeError()) as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
    expect(json).not.toContain('15551230000');
    expect(out['type']).toBe('Error'); // constructor name; declared name rides message? NO:
    // AxiosError above is a plain Error whose .name was reassigned - type falls
    // back to the DECLARED name when the constructor is bare Error.
    expect(out['message']).toContain('ECONNRESET');
    expect(typeof out['stack']).toBe('string');
    expect(out['code']).toBe('ECONNRESET');
    expect(out['status']).toBe(500); // lifted from response.status pre-drop
    expect(Object.keys(out).every((k) =>
      ['type', 'message', 'stack', 'code', 'status', 'statusCode', 'moreInfo', '$metadata', 'cause', 'aggregateErrors'].includes(k),
    )).toBe(true);
  });

  it('projects AWS $metadata and Twilio moreInfo', () => {
    const err = new Error('boom') as Error & Record<string, unknown>;
    err.$metadata = { httpStatusCode: 400, requestId: 'r-1', attempts: 3, totalRetryDelay: 120, extra: 'DROP-ME' };
    err.moreInfo = 'https://www.twilio.com/docs/errors/30007';
    const out = serializeLoggedError(err) as Record<string, unknown>;
    expect(out['$metadata']).toEqual({ httpStatusCode: 400, requestId: 'r-1', attempts: 3, totalRetryDelay: 120 });
    expect(out['moreInfo']).toBe('https://www.twilio.com/docs/errors/30007');
  });

  it('recurses Error causes to depth 3 and DROPS non-Error causes', () => {
    const leaf = new Error('leaf');
    const mid = new Error('mid');
    (mid as Error & { cause?: unknown }).cause = leaf;
    const top = new Error('top');
    (top as Error & { cause?: unknown }).cause = mid;
    const out = serializeLoggedError(top) as { cause?: { message?: string; cause?: { message?: string } } };
    expect(out.cause?.message).toBe('mid');
    expect(out.cause?.cause?.message).toBe('leaf');

    const smuggler = new Error('outer');
    (smuggler as Error & { cause?: unknown }).cause = { config: { headers: { Authorization: FAKE_BASIC } } };
    const smuggled = serializeLoggedError(smuggler) as Record<string, unknown>;
    expect(JSON.stringify(smuggled)).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
    expect(smuggled['cause']).toBeUndefined();
  });

  it('caps AggregateError members at 5 and serializes each', () => {
    const agg = new AggregateError([1, 2, 3, 4, 5, 6, 7].map((n) => new Error(`e${n}`)), 'many');
    const out = serializeLoggedError(agg) as { aggregateErrors?: Array<{ message?: string }> };
    expect(out.aggregateErrors).toHaveLength(5);
    expect(out.aggregateErrors?.[0]?.message).toBe('e1');
  });

  it('normalizes numeric codes to strings (Twilio RestException)', () => {
    const err = new Error('rest') as Error & Record<string, unknown>;
    err.code = 30007;
    const out = serializeLoggedError(err) as Record<string, unknown>;
    expect(out['code']).toBe('30007');
  });

  it('never throws, even on hostile getters', () => {
    const hostile = new Error('h');
    Object.defineProperty(hostile, 'code', { get() { throw new Error('trap'); }, enumerable: true });
    expect(() => serializeLoggedError(hostile)).not.toThrow();
    const out = serializeLoggedError(hostile) as Record<string, unknown>;
    expect(out['type']).toBe('UnserializableError');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/logSerializers.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

```ts
// app/src/lib/logSerializers.ts
// THE SAFE PINO SERIALIZER for the error-carrying log keys (log-hygiene spec
// section 1). pino's default `err` serializer copies EVERY enumerable own key
// of an error-like value; an axios-backed vendor error (the Twilio SDK's
// network-failure path) carries config.headers.Authorization (a live Basic
// credential), config.data (form body), and request._header. This serializer
// makes that class structurally unloggable through the wired keys.
//
// RULES (each is load-bearing; see the spec's review history before changing):
// 1. Primitives pass through UNCHANGED - `reason`/`error` are live DOMAIN
//    string fields on 25+ production lines.
// 2. Non-Error objects pass through UNCHANGED - `{ err: summarizeError(x) }`
//    (11 sites) and `err: { name }` (7 sites) are deliberate summary shapes
//    whose fields must keep reaching the line. Every member of the dangerous
//    class extends Error (AxiosError, RestException, AWS ServiceException),
//    so `instanceof Error` is the allowlist trigger - NOT a structural
//    message-check, which would gut domain objects carrying a `message`.
// 3. `instanceof Error` values emit ONLY the allowlist below.
// 4. Inside cause/aggregate recursion, a non-Error value is DROPPED, never
//    passed through - nothing deliberate nests under `cause`.
// 5. Never throws; degrades to { type: 'UnserializableError' }.
//
// LEAF MODULE: no imports (logger.ts imports this; errors.ts imports
// logger.ts - anything imported here must not close that cycle).

export const LOG_SERIALIZER_KEYS = ['err', 'error', 'cause', 'reason'] as const;

const MAX_CAUSE_DEPTH = 3;
const MAX_AGGREGATE_ERRORS = 5;

function allowlist(err: Error, depth: number): Record<string, unknown> {
  const raw = err as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    moreInfo?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown; attempts?: unknown; totalRetryDelay?: unknown };
    response?: { status?: unknown };
    cause?: unknown;
  };
  const constructed = err.constructor?.name;
  const declared = typeof err.name === 'string' && err.name.length > 0 ? err.name : undefined;
  const out: Record<string, unknown> = {
    // pino's field name for the constructor is `type` - kept so existing
    // CloudWatch queries keep working. Falls back to the declared name.
    type: typeof constructed === 'string' && constructed.length > 0 && constructed !== 'Object'
      ? constructed
      : (declared ?? 'Error'),
    message: err.message,
    ...(typeof err.stack === 'string' && { stack: err.stack }),
  };
  if (typeof raw.code === 'string' && raw.code.length > 0) out['code'] = raw.code;
  else if (typeof raw.code === 'number') out['code'] = String(raw.code);
  // Lift status from the two places vendors put it, BEFORE response is dropped
  // (the same two-source lift summarizeError does).
  if (typeof raw.status === 'number') out['status'] = raw.status;
  else if (typeof raw.response?.status === 'number') out['status'] = raw.response.status;
  if (typeof raw.statusCode === 'number') out['statusCode'] = raw.statusCode;
  if (typeof raw.moreInfo === 'string') out['moreInfo'] = raw.moreInfo;
  const meta = raw.$metadata;
  if (meta !== null && typeof meta === 'object') {
    const projected: Record<string, unknown> = {};
    if (typeof meta.httpStatusCode === 'number') projected['httpStatusCode'] = meta.httpStatusCode;
    if (typeof meta.requestId === 'string') projected['requestId'] = meta.requestId;
    if (typeof meta.attempts === 'number') projected['attempts'] = meta.attempts;
    if (typeof meta.totalRetryDelay === 'number') projected['totalRetryDelay'] = meta.totalRetryDelay;
    if (Object.keys(projected).length > 0) out['$metadata'] = projected;
  }
  if (depth < MAX_CAUSE_DEPTH && raw.cause instanceof Error) {
    out['cause'] = allowlist(raw.cause, depth + 1);
  }
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    out['aggregateErrors'] = err.errors
      .slice(0, MAX_AGGREGATE_ERRORS)
      .filter((e): e is Error => e instanceof Error)
      .map((e) => allowlist(e, depth + 1));
  }
  return out;
}

/** The serializer bound to every LOG_SERIALIZER_KEYS entry in createLogger. */
export function serializeLoggedError(value: unknown): unknown {
  try {
    if (value instanceof Error) return allowlist(value, 0);
    // Primitives AND non-Error objects pass through - rules 1-2 above.
    return value;
  } catch {
    return { type: 'UnserializableError' };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && npx vitest run test/logSerializers.test.ts`
Expected: PASS. NOTE the first assertion in the allowlist test expects
`type: 'Error'` for a plain-Error-with-reassigned-name; if you find the
implementation yields 'AxiosError' via the declared-name fallback order,
the TEST is wrong, not the code - the fallback prefers the constructor
UNLESS it is 'Object'/empty; a bare Error construct has constructor
'Error'. Fix whichever side disagrees with the comment in the module and
keep them consistent.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/lib/logSerializers.ts app/test/logSerializers.test.ts
git commit -m "feat(logging): safe error serializer - allowlist for instanceof Error, pass-through otherwise" -- app/src/lib/logSerializers.ts app/test/logSerializers.test.ts
```

---

### Task 2: Wire the serializer into createLogger + runtime guard + errorSummary.test rewrite

**Files:**
- Modify: `app/src/lib/logger.ts` (the `createLogger` options object,
  currently lines ~177-241)
- Modify: `app/test/errorSummary.test.ts:106-141` (two assertions)
- Create: `app/test/logSanitization.test.ts`

**Interfaces:**
- Consumes: `serializeLoggedError`, `LOG_SERIALIZER_KEYS` (Task 1).
- Produces: every logger built by `createLogger` serializes the four keys
  safely; all later tasks rely on `{ err }` being safe.

- [ ] **Step 1: Write the failing runtime guard**

```ts
// app/test/logSanitization.test.ts
// END-TO-END CREDENTIAL PROBE (log-hygiene spec section 3 guard 1): a real
// createLogger over a capture stream, fed a synthetic AxiosError-shaped
// Error carrying a FAKE credential sentinel, under each wired key and as the
// first-arg form. The sentinel is clearly fake - never a real credential.
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../src/lib/logger.js';
import { LOG_SERIALIZER_KEYS } from '../src/lib/logSerializers.js';
import { summarizeError } from '../src/lib/errors.js';

const FAKE_BASIC = 'Basic U0tmYWtlOnNlY3JldGZha2U=';
const FORM_BODY = 'To=%2B15551230000&Body=hello';

function capture(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  return { lines, stream: { write(line: string) { lines.push(line); } } };
}

function syntheticAxiosError(): Error {
  const err = new Error('connect ECONNRESET') as Error & Record<string, unknown>;
  err.name = 'AxiosError';
  err.code = 'ECONNRESET';
  err.config = { headers: { Authorization: FAKE_BASIC }, data: FORM_BODY };
  err.request = { _header: `POST /x HTTP/1.1\r\nAuthorization: ${FAKE_BASIC}\r\n\r\n` };
  err.response = { status: 500, config: { headers: { Authorization: FAKE_BASIC } }, data: FORM_BODY };
  return err;
}

describe('log sanitization - the credential class is structurally closed', () => {
  for (const key of LOG_SERIALIZER_KEYS) {
    it(`a raw vendor error under '${key}' leaks neither credential nor body`, () => {
      const { lines, stream } = capture();
      const log = createLogger({ destination: stream, level: 'warn' });
      log.warn({ [key]: syntheticAxiosError() }, 'vendor call failed');
      const joined = lines.join('');
      expect(joined).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
      expect(joined).not.toContain('15551230000');
      expect(joined).toContain('ECONNRESET'); // message survives
    });
  }

  it('the first-arg form (logger.warn(err, msg)) is covered too', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'warn' });
    log.warn(syntheticAxiosError(), 'vendor call failed');
    expect(lines.join('')).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
  });

  it('a primitive under each wired key passes through unchanged', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'warn' });
    log.warn({ reason: 'signature mismatch', error: 'refused' }, 'domain line');
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['reason']).toBe('signature mismatch');
    expect(parsed['error']).toBe('refused');
  });

  it('a summarizeError object under err passes through with its name intact', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'warn' });
    const restLike = new Error('x') as Error & Record<string, unknown>;
    restLike.code = 30007;
    restLike.status = 400;
    log.warn({ err: summarizeError(restLike) }, 'terse line');
    const parsed = JSON.parse(lines[0]!) as { err?: { name?: string; code?: string } };
    expect(parsed.err?.name).toBe('Error');
    expect(parsed.err?.code).toBe('30007');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/logSanitization.test.ts`
Expected: FAIL - the wired-key cases for `error`/`cause`/`reason` leak the
sentinel (no serializer yet), and possibly the `err` case shows
`[REDACTED]` instead of absence.

- [ ] **Step 3: Wire the serializer**

In `app/src/lib/logger.ts`: add the import and the `serializers` option.
The redact block STAYS EXACTLY AS IS (defense in depth for a future
serializer regression; the comment there already says the serializer is
the fix). Add after the existing imports:

```ts
import { LOG_SERIALIZER_KEYS, serializeLoggedError } from './logSerializers.js';
```

and inside `createLogger`'s `options` object (alongside `redact` and
`mixin`):

```ts
    // THE SAFE ERROR SERIALIZER (log-hygiene spec section 1): the four
    // error-carrying keys emit an allowlist for `instanceof Error` values and
    // pass everything else through untouched. The redact list below stays as
    // belt-and-suspenders; the serializer is the fix.
    serializers: Object.fromEntries(
      LOG_SERIALIZER_KEYS.map((key) => [key, serializeLoggedError]),
    ),
```

- [ ] **Step 4: Rewrite the two errorSummary assertions**

In `app/test/errorSummary.test.ts`, the two cases at :107-117 and :119-141
assert `expect(line).toContain('[REDACTED]')`. With the serializer, nothing
reaches the redactor on the `err` path, so `[REDACTED]` never appears -
replace BOTH `toContain('[REDACTED]')` assertions with the STRONGER
property, keeping each case's setup and its existing not-toContain lines:

```ts
    // The serializer (lib/logSerializers.ts) now strips config/request/
    // response before redaction runs - the credential is ABSENT, not
    // censored. [REDACTED] would only reappear if the serializer regressed
    // AND the redact backstop caught it.
    expect(line).not.toContain('[REDACTED]');
    expect(line).not.toContain('config');
```

- [ ] **Step 5: Run both files, then the app suite**

Run: `cd app && npx vitest run test/logSanitization.test.ts test/errorSummary.test.ts`
Expected: PASS both.
Run: `cd app && npx vitest run` (full app suite; DynamoDB Local must be up)
Expected: PASS. If any OTHER test asserts on serialized error shapes (grep
`toContain('[REDACTED]')` and `err.config` under app/test to check), fix it
with the same stronger-property rewrite and note it in the build report.

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/lib/logger.ts app/test/logSanitization.test.ts app/test/errorSummary.test.ts
git commit -m "feat(logging): wire the safe serializer into createLogger + credential guard test" -- app/src/lib/logger.ts app/test/logSanitization.test.ts app/test/errorSummary.test.ts
```

---

### Task 3: Static AST guard (catch-clause identifiers under non-wired keys)

**Files:**
- Create: `app/test/logCallSiteGuard.test.ts`

**Interfaces:**
- Consumes: the `typescript` package - a ROOT devDependency resolved via
  workspace hoisting (`import ts from 'typescript'`). `LOG_SERIALIZER_KEYS`
  from Task 1.
- Produces: nothing runtime - a ratchet test later sweeps rely on.

- [ ] **Step 1: Write the guard (it doubles as its own failing test via the canary)**

```ts
// app/test/logCallSiteGuard.test.ts
// STATIC GUARD (log-hygiene spec section 3 guard 2): parse app/src with the
// TypeScript compiler and FAIL when an identifier DECLARED BY A CATCH CLAUSE
// is assigned to a logger-call property that is not a top-level wired key.
//
// WHY CATCH-CLAUSE, NOT TYPES: under `strict: true` every bare `catch (e)`
// binding is `unknown` (464 sites, zero annotations), so a purely type-based
// check flags nothing, forever; a name-regex check false-positives on domain
// uses (`refusal: err.code`, `message: errorMessage(err)`). A BARE identifier
// whose declaration is a CatchClause is exactly "an error", regardless of its
// static type. `summarizeError(err)` / `errFields(err)` results are call
// expressions, not catch identifiers - unflagged by design.
//
// KNOWN LIMITS - do not mistake a green run here for proof (the
// tourCopyCallSites.test.ts precedent): a payload hoisted into a const and
// passed as an identifier, a spread of a helper's return, a catch variable
// laundered through a local, and an error stringified into `msg` are all
// invisible to this guard. Accepted: the serializer (Task 1) plus the sweep
// baseline (Task 4) carry those; this is a ratchet against the common
// literal form, not a proof.
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { LOG_SERIALIZER_KEYS } from '../src/lib/logSerializers.js';

const APP_SRC = join(__dirname, '..', 'src');
const WIRED = new Set<string>(LOG_SERIALIZER_KEYS);
const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const CANARY_NAME = '__guard_canary__.ts';
const CANARY_SOURCE = [
  'declare const log: { error(payload: object, msg: string): void };',
  'try { JSON.parse("x"); } catch (err) { log.error({ ctx: { err } }, "boom"); }',
  '',
].join('\n');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Findings: "<file>:<line> <key>" for every violation in the program. */
function scanProgram(program: ts.Program, checker: ts.TypeChecker): string[] {
  const findings: string[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.includes('src') && !sf.fileName.endsWith(CANARY_NAME)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        LOG_METHODS.has(node.expression.name.text) &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0]!)
      ) {
        // Walk the payload literal at every depth. Depth 0 properties named a
        // wired key are LEGAL; everything else that binds a catch identifier
        // or an Error-typed value is a finding.
        const walk = (obj: ts.ObjectLiteralExpression, depth: number): void => {
          for (const prop of obj.properties) {
            if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
              const keyName = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : undefined;
              const value = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
              const legal = depth === 0 && keyName !== undefined && WIRED.has(keyName);
              if (!legal && value !== undefined && isErrorish(value)) {
                const { line } = sf.getLineAndCharacterOfPosition(prop.getStart());
                findings.push(`${sf.fileName}:${line + 1} ${keyName ?? '<computed>'}`);
              }
              if (value !== undefined && ts.isObjectLiteralExpression(value)) walk(value, depth + 1);
            }
          }
        };
        walk(node.arguments[0] as ts.ObjectLiteralExpression, 0);
      }
      ts.forEachChild(node, visit);
    };
    const isErrorish = (value: ts.Expression): boolean => {
      if (ts.isIdentifier(value)) {
        const sym = checker.getSymbolAtLocation(value);
        const decl = sym?.valueDeclaration;
        if (decl !== undefined && ts.isVariableDeclaration(decl) && ts.isCatchClause(decl.parent)) {
          return true;
        }
      }
      // Error-TYPED values (explicitly annotated / narrowed) are also findings.
      const type = checker.getTypeAtLocation(value);
      const sym = type.getSymbol();
      return sym?.getName() === 'Error' || checker.typeToString(type) === 'Error';
    };
    visit(sf);
  }
  return findings;
}

function buildProgram(withCanary: boolean): { program: ts.Program; checker: ts.TypeChecker } {
  const files = listTsFiles(APP_SRC);
  const canaryPath = join(APP_SRC, CANARY_NAME);
  const rootNames = withCanary ? [...files, canaryPath] : files;
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, langVersion, ...rest) =>
    fileName.endsWith(CANARY_NAME)
      ? ts.createSourceFile(fileName, CANARY_SOURCE, langVersion, true)
      : realGetSourceFile(fileName, langVersion, ...rest);
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName.endsWith(CANARY_NAME) || realFileExists(fileName);
  const program = ts.createProgram(rootNames, options, host);
  return { program, checker: program.getTypeChecker() };
}

describe('logger call-site guard', () => {
  it('the real program is healthy (positive control half 1)', () => {
    const { program } = buildProgram(false);
    expect(program.getSourceFiles().filter((f) => !f.isDeclarationFile).length).toBeGreaterThan(50);
  });

  it('the canary overlaid into the REAL program is flagged (positive control half 2)', () => {
    const { program, checker } = buildProgram(true);
    const findings = scanProgram(program, checker);
    expect(findings.some((f) => f.includes(CANARY_NAME))).toBe(true);
  });

  it('app/src has no error logged outside a wired key (allowlist starts EMPTY)', () => {
    const { program, checker } = buildProgram(false);
    const findings = scanProgram(program, checker);
    // Reviewed exceptions go here as 'path:line key' strings, WITH a comment
    // saying why each is safe. It starts empty (spec section 3).
    const ALLOWLIST: string[] = [];
    const unexpected = findings.filter((f) => !ALLOWLIST.some((a) => f.includes(a)));
    expect(unexpected).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd app && npx vitest run test/logCallSiteGuard.test.ts`
Expected: the two positive controls PASS; the empty-allowlist case should
PASS (round-2/3 review found zero members of this class). If it reports
findings: each is a REAL discovery - fix the call site (rewire to a wired
key) rather than allowlisting, and record it in the Task 4 sweep table.
If the canary case FAILS, the guard or the program construction is broken -
do not weaken the canary; fix the host wiring.

- [ ] **Step 3: Commit**

```bash
git status
git add app/test/logCallSiteGuard.test.ts
git commit -m "test(logging): static AST guard - catch-clause errors must ride a wired key" -- app/test/logCallSiteGuard.test.ts
```

---

### Task 4: The sweep (audit + the three pushService conversions)

**Files:**
- Modify: `app/src/services/pushService.ts:186-238` (three per-device WARNs)
- Create: `.superpowers/sdd/reports/sweep-table.md` (gitignored build
  artifact - NOT committed)
- Test: extend `app/test/pushService.test.ts` (existing WARN-shape cases)

**Interfaces:**
- Consumes: Task 2 (the serializer makes `{ err }` safe).
- Produces: the audit baseline the guards ratchet against; the err-object
  WARN shape Task 9's statusCode field lands on.

- [ ] **Step 1: The audit.** Enumerate every error-carrying log payload:

Run from the worktree root (Git Bash):
```bash
grep -rnE "\{ err\b|, err[,} ]|err:" app/src --include='*.ts' > .superpowers/sdd/reports/sweep-raw.txt
wc -l .superpowers/sdd/reports/sweep-raw.txt
```

Classify EVERY hit into `.superpowers/sdd/reports/sweep-table.md` with
columns `file | line | class | action`, using these classes:
- `WIRED-OK` - error under `err`/`error`/`cause`/`reason` at top level: safe
  now, no action.
- `KEPT-STRICTER` - the `errFields` spreads (7 in
  `app/src/services/inboundEmail.ts`, 4 in
  `app/src/services/sendEmailMessage.ts` + the 2 helper definitions): a
  deliberate 200-char PII bound on the email path. DO NOT CONVERT (spec
  section 2; converting was rejected in review as a PII regression).
- `KEPT-SUMMARY` - `summarizeError(...)` sites and the `err: { name: ... }`
  sites (api.ts:1435, relayGroups.ts:378,:387,
  rosterProvision.ts:366,:376,:667,:678): deliberate postures, no action.
- `EXCLUDED-C1` - any hit in the five forbidden files: record, do not touch.
- `CONVERTED` - a real finding rewired to a wired key (expected count: 0
  beyond the three pushService sites below; the review found none).

- [ ] **Step 2: Convert the three pushService string-under-err WARNs.**

In `app/src/services/pushService.ts` replace, at the three sites:

:186-190 (allowlist-prune-failed):
```ts
          log.warn(
            { userId, kind, err },
            'push: pruning a non-allowlisted endpoint failed - kept, not sent',
          );
```
:217-221 (gone-prune-failed) - `err: (pruneErr as Error).message` becomes:
```ts
            log.warn(
              { userId, kind, err: pruneErr },
              'push: pruning a Gone endpoint failed - kept, retried on the next send',
            );
```
:233-237 (transient send failure) - keep the message text EXACTLY as it is
in the file (it contains a non-ASCII dash; do not retype the string - only
change the payload object):
```ts
        log.warn(
          { userId, kind, err, pushStatusCode: (err as { statusCode?: number }).statusCode },
          <the existing message string, unchanged>,
        );
```
(`pushStatusCode`, NOT `statusCode` - the request logger owns top-level
`statusCode` for HTTP responses. This delivers spec 6.2; the WebPushError's
own statusCode also rides `err` via the serializer allowlist.)
ALSO :378-381 (broadcast per-user catch) - `err: (err as Error).message`
becomes `err` likewise.

- [ ] **Step 3: Update the pushService tests that pin those WARN payloads.**

Run: `cd app && npx vitest run test/pushService.test.ts`
Any case asserting `err: expect.any(String)` or a message-string err field
on those four lines updates to expect the error OBJECT (and for the
transient case, `pushStatusCode`). Add one NEW case: a rejected send whose
error carries `statusCode: 413` yields a WARN payload with
`pushStatusCode: 413`.

- [ ] **Step 4: Run + commit**

Run: `cd app && npx vitest run test/pushService.test.ts test/logCallSiteGuard.test.ts`
Expected: PASS.
```bash
git status
git add app/src/services/pushService.ts app/test/pushService.test.ts
git commit -m "feat(push): per-device failure WARNs log the error object + pushStatusCode" -- app/src/services/pushService.ts app/test/pushService.test.ts
```

---

### Task 5: maskPhonesInText in lib/phone.ts

**Files:**
- Modify: `app/src/lib/phone.ts` (append; also append the server-only note)
- Test: extend `app/test/phone.test.ts` (create the describe block; the file
  exists - check with `ls app/test/phone*.test.ts`; if the unit tests for
  phone.ts live elsewhere, put the new describe beside them, and if none
  exist create `app/test/phoneMask.test.ts`)

**Interfaces:**
- Produces: `maskPhonesInText(text: string): string` - Tasks 6 and 7 import
  it from `../lib/phone.js` / `./phone.js`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { maskPhonesInText } from '../src/lib/phone.js';

describe('maskPhonesInText', () => {
  it('masks a bare E.164 path segment to country code + last two digits', () => {
    expect(maskPhonesInText('/api/contacts/abc/phones/+14045551234')).toBe('/api/contacts/abc/phones/+1...34');
  });
  it('masks the URL-encoded %2B variant', () => {
    expect(maskPhonesInText('/x?phone=%2B14045551234')).toBe('/x?phone=%2B1...34');
  });
  it('masks phone: memberKey segments', () => {
    expect(maskPhonesInText('/api/tours/t1/members/phone:+14045551234')).toBe('/api/tours/t1/members/phone:+1...34');
  });
  it('masks every phone in a multi-phone string (the span case)', () => {
    expect(maskPhonesInText('https://x/a/+14045551234/b?to=%2B15551230000'))
      .toBe('https://x/a/+1...34/b?to=%2B1...00');
  });
  it('passes phone-free text through unchanged', () => {
    const clean = '/api/units?limit=25&status=active';
    expect(maskPhonesInText(clean)).toBe(clean);
  });
  it('does not mask short digit runs that are not phones', () => {
    expect(maskPhonesInText('/api/things/+123')).toBe('/api/things/+123');
  });
});
```

- [ ] **Step 2: Run red**

Run: `cd app && npx vitest run test/phoneMask.test.ts` (or the file you
extended). Expected: FAIL (export missing).

- [ ] **Step 3: Implement** (append to `app/src/lib/phone.ts`):

```ts
// maskPhonesInText - SERVER-ONLY log/span masking helper (log-hygiene spec
// section 4). NOT part of the dashboard mirror contract declared at the top
// of this file: the dashboard copy does NOT gain it (it masks log sinks and
// span attributes, which only the server has).
//
// Masks E.164-shaped runs - `+` (or its URL-encoded `%2B`) followed by 8-15
// digits - down to `<country-ish prefix>...<last two digits>`, e.g.
// `+14045551234` -> `+1...34`. 8 is the floor so short non-phone tokens
// (`+123`) survive untouched.
const PHONE_RUN_RE = /(\+|%2B)(\d{8,15})/g;

/** Mask every E.164-shaped run in a string; phone-free input is returned as-is. */
export function maskPhonesInText(text: string): string {
  return text.replace(PHONE_RUN_RE, (_m, prefix: string, digits: string) => {
    return `${prefix}${digits.charAt(0)}...${digits.slice(-2)}`;
  });
}
```

- [ ] **Step 4: Run green, commit**

```bash
git status
git add app/src/lib/phone.ts app/test/phoneMask.test.ts
git commit -m "feat(pii): maskPhonesInText - E.164 masking for log sinks and spans" -- app/src/lib/phone.ts app/test/phoneMask.test.ts
```

---

### Task 6: Apply masking at every request-path log sink

**Files (verify each anchor before editing - line numbers can drift):**
- Modify: `app/src/middleware/requestLogger.ts:34,:58` (both `path:` fields)
- Modify: `app/src/lib/errors.ts:141,:153,:160` (three `path: req.path`)
- Modify: `app/src/middleware/rateLimit.ts:113`
- Modify: `app/src/middleware/csrfOrigin.ts:61`
- Modify: `app/src/middleware/originSecret.ts:53`
- Modify: `app/src/middleware/twilioSignature.ts:44,:51,:75,:110,:117,:141`
- Test: extend `app/test/requestLogger.test.ts` (exists? check; else the
  middleware's existing test file - grep `requestLogger` under app/test)

**Interfaces:**
- Consumes: `maskPhonesInText` (Task 5).

- [ ] **Step 1: Failing test** (requestLogger, representative for the class):

```ts
it('masks E.164 segments in the logged path (both lines)', async () => {
  // Drive the middleware with req.path = '/api/contacts/c1/phones/+14045551234'
  // using the file's existing harness pattern, then:
  // expect both captured log payloads' `path` to be '/api/contacts/c1/phones/+1...34'
  // and expect neither line to contain '14045551234'.
});
```
Write it concretely against the file's existing test harness (it already
captures log lines for the two request lines; copy an existing case's
setup). Add the equivalent single case to the express error handler's tests
(`app/test/errorSummary.test.ts` hosts createExpressErrorHandler cases -
grep `createExpressErrorHandler` under app/test and put it beside them).

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Apply the edit at every sink.** The pattern is identical
everywhere: `path: req.path` becomes `path: maskPhonesInText(req.path)` with
the import added (`import { maskPhonesInText } from '../lib/phone.js';` -
adjust the relative path per file: from `middleware/` it is `../lib/phone.js`,
from `lib/` it is `./phone.js`). In `twilioSignature.ts` some sites log a
full URL variable rather than `req.path` - mask THAT expression the same way.
Confirm the complete sink list by grepping, and mask every hit that reaches
a logger:
```bash
grep -rn "req.path" app/src --include='*.ts'
```
(Skip the five C1-excluded files if any hit lands there; record in the sweep
table. Functional uses of req.path - route matching, comparisons - are NOT
log sinks; only logger payload fields change.)

- [ ] **Step 4: Run green + suite**

Run: `cd app && npx vitest run test/requestLogger.test.ts test/errorSummary.test.ts`
then the full app suite. Expected: PASS. Any middleware test pinning a raw
phone-bearing path in a log assertion updates with it.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/middleware/requestLogger.ts app/src/lib/errors.ts app/src/middleware/rateLimit.ts app/src/middleware/csrfOrigin.ts app/src/middleware/originSecret.ts app/src/middleware/twilioSignature.ts app/test/requestLogger.test.ts app/test/errorSummary.test.ts
git commit -m "feat(pii): mask E.164 segments at every request-path log sink" -- app/src/middleware/requestLogger.ts app/src/lib/errors.ts app/src/middleware/rateLimit.ts app/src/middleware/csrfOrigin.ts app/src/middleware/originSecret.ts app/src/middleware/twilioSignature.ts app/test/requestLogger.test.ts app/test/errorSummary.test.ts
```

---

### Task 7: OTel span-attribute masking hooks

**Files:**
- Modify: `app/src/lib/otel.ts` (export two hooks; wire them at the
  `new HttpInstrumentation()` construction, currently line ~61)
- Test: extend `app/test/otel.test.ts`

**Interfaces:**
- Consumes: `maskPhonesInText` (Task 5). NOTE otel.ts is loaded before the
  logger - phone.ts is pure with no logging, so the import is safe.
- Produces: `maskIncomingSpanAttributes(request)`,
  `maskOutgoingSpanAttributes(request)` - exported for direct unit tests.

- [ ] **Step 1: Failing tests**

```ts
import { maskIncomingSpanAttributes, maskOutgoingSpanAttributes } from '../src/lib/otel.js';

describe('span attribute masking hooks', () => {
  it('incoming: masks and emits ONLY the server-span attribute family', () => {
    const attrs = maskIncomingSpanAttributes({
      url: '/api/contacts/c1/phones/+14045551234?x=%2B15551230000',
      headers: { host: 'app.example.com' },
    } as never);
    expect(attrs).toEqual({
      'http.url': 'http://app.example.com/api/contacts/c1/phones/+1...34?x=%2B1...00',
      'http.target': '/api/contacts/c1/phones/+1...34?x=%2B1...00',
      'url.path': '/api/contacts/c1/phones/+1...34',
      'url.query': 'x=%2B1...00',
    });
  });
  it('outgoing: masks and emits ONLY the client-span attribute family', () => {
    const attrs = maskOutgoingSpanAttributes({
      host: 'api.twilio.com',
      path: '/2010-04-01/Messages.json?To=%2B15551230000',
      protocol: 'https:',
    } as never);
    expect(attrs).toEqual({
      'http.url': 'https://api.twilio.com/2010-04-01/Messages.json?To=%2B1...00',
      'http.target': '/2010-04-01/Messages.json?To=%2B1...00',
      'url.full': 'https://api.twilio.com/2010-04-01/Messages.json?To=%2B1...00',
    });
  });
  it('never throws on a malformed request object (no-op-safe)', () => {
    expect(maskIncomingSpanAttributes({} as never)).toEqual({});
    expect(maskOutgoingSpanAttributes(undefined as never)).toEqual({});
  });
});
```

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement in otel.ts** (above buildOtelSdkConfig):

```ts
import { maskPhonesInText } from './phone.js';
import type { Attributes } from '@opentelemetry/api';

// SPAN URL MASKING (log-hygiene spec section 4). startIncomingSpanHook /
// startOutgoingSpanHook attributes are Object.assign'd LAST by the
// instrumentation, so returning a masked value OVERWRITES the raw one. Each
// direction emits ONLY its own attribute family - returning a key the
// instrumentation never sets for that direction would FABRICATE it. Both
// hooks are no-op-safe: a masking failure returns {} and the span exports
// with raw attributes rather than not at all (accepted; the log sinks are
// masked independently).
export function maskIncomingSpanAttributes(request: { url?: string; headers?: { host?: string } }): Attributes {
  try {
    const rawUrl = typeof request?.url === 'string' ? request.url : undefined;
    if (rawUrl === undefined) return {};
    const masked = maskPhonesInText(rawUrl);
    const q = masked.indexOf('?');
    const path = q === -1 ? masked : masked.slice(0, q);
    const query = q === -1 ? undefined : masked.slice(q + 1);
    const host = typeof request?.headers?.host === 'string' ? request.headers.host : 'localhost';
    return {
      'http.url': `http://${host}${masked}`,
      'http.target': masked,
      'url.path': path,
      ...(query !== undefined && { 'url.query': query }),
    };
  } catch {
    return {};
  }
}

export function maskOutgoingSpanAttributes(request: { host?: string; hostname?: string; path?: string; protocol?: string }): Attributes {
  try {
    const path = typeof request?.path === 'string' ? maskPhonesInText(request.path) : undefined;
    if (path === undefined) return {};
    const host = request.hostname ?? request.host ?? 'unknown';
    const protocol = typeof request.protocol === 'string' ? request.protocol : 'https:';
    const full = `${protocol}//${host}${path}`;
    return { 'http.url': full, 'http.target': path, 'url.full': full };
  } catch {
    return {};
  }
}
```

and change the construction in buildOtelSdkConfig:

```ts
    instrumentations: [
      new HttpInstrumentation({
        startIncomingSpanHook: maskIncomingSpanAttributes,
        startOutgoingSpanHook: maskOutgoingSpanAttributes,
      }),
      new ExpressInstrumentation(),
    ],
```

If the installed instrumentation's option names differ (check
`node_modules/@opentelemetry/instrumentation-http/build/src/types.d.ts` -
they were verified present in review), adapt the wiring, never the exported
pure functions. The incoming test's exact expected strings depend on your
implementation's host handling - keep test and implementation consistent.

- [ ] **Step 4: Run green** (`npx vitest run test/otel.test.ts`), commit:

```bash
git status
git add app/src/lib/otel.ts app/test/otel.test.ts
git commit -m "feat(pii): mask phone-bearing URL attributes on incoming and outgoing spans" -- app/src/lib/otel.ts app/test/otel.test.ts
```

---

### Task 8: System-SID markers - TTL, debug downgrade, persist:false legs

**Files:**
- Modify: `app/src/repos/messagesRepo.ts:2883-2896` (putSystemSidMarker)
- Modify: `app/src/services/relayAnnouncements.ts` (the per-member loop,
  ~:255-275)
- Modify: `app/src/lib/tables.ts:213-223` (the TTL-family comment)
- Test: extend `app/test/relayAnnouncements.test.ts` (grep for the file's
  real name: `ls app/test | grep -i announce`) and the messagesRepo suite
  covering markers (grep `putSystemSidMarker` under app/test).

**Interfaces:**
- Consumes: nothing new.
- Produces: markers now expire; the dev-replay legs stop ERRORing on DLRs.

- [ ] **Step 1: Failing tests**

(a) messagesRepo: `putSystemSidMarker` writes `expires_at` as EPOCH SECONDS
~30 days out (DynamoDB TTL silently ignores non-numeric values - assert
`typeof Item.expires_at === 'number'` and it is within [now+29d, now+31d]
in seconds), and logs at DEBUG, not info (assert via an injected logger fake
that `info` was NOT called for the marker line).

(b) relayAnnouncements: with `persist: false`, a successful per-member send
calls `messagesRepo.putSystemSidMarker(result.providerSid, kind)`; a
REJECTED putSystemSidMarker logs WARN and does NOT mark the send failed and
does NOT reduce sentCount; with `persist: true` NO marker is written (the
pointer path is unchanged).

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement.**

messagesRepo (`putSystemSidMarker`):
```ts
    async putSystemSidMarker(providerSid, kind) {
      // 30-day TTL, EPOCH SECONDS (tables.ts documents expires_at as epoch
      // seconds; an ISO string would be silently ignored by DynamoDB TTL).
      // syssid# markers are read-only acks with NO consume step - TTL is
      // deliberately their ONLY reaper (log-hygiene spec section 5).
      const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: sysSidPk(providerSid),
            tsMsgId: 'ptr',
            kind,
            created_at: new Date().toISOString(),
            expires_at: expiresAt,
          },
        }),
      );
      // debug, not info: under the dev intro replay this fires once per member
      // per boot - a log-hygiene change must not trade an ERROR for an INFO.
      log.debug({ providerSid, kind }, 'system-send SID marker written');
    },
```

relayAnnouncements - in the per-member try, immediately AFTER `sentCount += 1;`
and BEFORE the `if (persist && tsMsgId !== undefined)` block, add:

```ts
      if (!persist) {
        // Legs-only mode (the dev intro replay) skips the delivery slot AND
        // the relaysid pointer, so this leg's DLRs would terminate in the
        // webhook's alarm-feeding unknown-SID ERROR. A system-SID marker
        // resolves them to the INFO ack instead. OWN try/catch, WARN on
        // failure: a marker write must never fail the announcement and must
        // never fall into the send catch below (which would log a spurious
        // send-failure ERROR) - the voiceApi cell-verification precedent.
        try {
          await deps.messagesRepo.putSystemSidMarker(result.providerSid, kind);
        } catch (err) {
          log.warn(
            { err, conversationId, kind, memberKey: logSafeMemberKey(member) },
            'relayAnnouncement: system-SID marker write failed (best-effort) - DLRs for this leg will ERROR',
          );
        }
      }
```

tables.ts:213-223 - extend the enumerated TTL-family comment with a fourth
entry (match the comment's existing list style):

```
   - syssid# system-send SID markers (messagesRepo.putSystemSidMarker):
     READ-ONLY acks with NO consume step - getSystemSidMarker never deletes.
     TTL (30d) is deliberately their ONLY reaper; the exception to the
     "TTL is only the backstop" rule above, accepted in the log-hygiene
     spec (2026-08-24) because a marker's job ends when its DLRs stop.
```

- [ ] **Step 4: Run green + verify the webhook path needs no change**

Run the two test files + `npx vitest run test/twilioStatusWebhook.test.ts`.
The webhook already resolves markers to INFO (twilio.ts:2438-2447) - no
edit there. Then re-grep for any OTHER direct provider SMS/MMS send that
persists neither message, pointer, nor marker (spec section 5's
verification task): the four `.sendMessage(` sites plus
`groupConversations.postGroupMessage` (Conversations rail - different
webhook, explicitly out of scope). Record the proof in the build report.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/repos/messagesRepo.ts app/src/services/relayAnnouncements.ts app/src/lib/tables.ts app/test/relayAnnouncements.test.ts <messagesRepo test file>
git commit -m "feat(relay): system-SID markers for persist:false legs + 30d TTL + debug downgrade" -- <same paths>
```

---

### Task 9: pushService refresh-attempt floor

**Files:**
- Modify: `app/src/services/pushService.ts` (sendToAll refresh block,
  ~:293-334; declarations near :141)
- Test: extend `app/test/pushService.test.ts`

**Interfaces:**
- Consumes: the existing `deps.now` clock seam (already used by tests).

- [ ] **Step 1: Failing tests** (drive with the fake clock):

(a) users repo listAll fails; second sendToAll call 10s later does NOT call
listAll again (floor active) and serves the cached list, logging at DEBUG;
(b) a third call 31s after the failed attempt DOES retry listAll;
(c) with NO cache and repeated failures inside the floor, the broadcast is
dropped with a DEBUG line and only the window-opening call logged ERROR;
(d) a SUCCESSFUL refresh resets the floor (next call within 30s but past
the 60s TTL retries normally... note the TTL is 60s so within 30s the cache
is fresh anyway - assert instead that after success the NEXT post-TTL call
attempts a refresh immediately).

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement.** Next to `usersCache` (:141):

```ts
  /**
   * Floor between listAll ATTEMPTS after a failure (log-hygiene spec 6.1):
   * one ERROR/WARN + one Scan attempt per ~30s window PER INSTANCE (about
   * six instances exist per process), instead of one per inbound message.
   * Stamped on every attempt; a successful refresh naturally resets the
   * cadence because the TTL then governs.
   */
  const REFRESH_RETRY_FLOOR_MS = 30_000;
  let lastRefreshAttemptAt: number | undefined;
```

Rework the refresh block (:293-334). The structure becomes:

```ts
      if (usersCache === undefined || now() - usersCache.fetchedAt >= USERS_CACHE_TTL_MS) {
        const floored =
          lastRefreshAttemptAt !== undefined && now() - lastRefreshAttemptAt < REFRESH_RETRY_FLOOR_MS;
        if (!floored) {
          lastRefreshAttemptAt = now();
          try {
            usersCache = { items: await users.listAll(), fetchedAt: now() };
          } catch (err) {
            // ... the existing three-arm catch stays EXACTLY as is ...
          }
        } else {
          // Inside the floor after a failed attempt: the window-opening line
          // already told the operator. Serve the cache when it is still
          // inside the stale bound; otherwise drop quietly.
          if (usersCache === undefined || now() - usersCache.fetchedAt >= STALE_SERVE_MAX_MS) {
            log.debug({ kind: notification.kind }, 'push: refresh floored and no servable cache - broadcast dropped');
            return { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
          }
          log.debug({ kind: notification.kind }, 'push: refresh floored - fanning out to the cached list');
        }
      }
```

TS NARROWING NOTE (from review): the floored no-cache arm must EARLY-RETURN
exactly as shown, or the `usersCache.items` read at :345 loses its
narrowing. The three existing catch arms are untouched (their levels and
`fetchedAt` semantics are pinned by existing tests). Success path stamps
`lastRefreshAttemptAt` BEFORE the await (shown) so a hung Scan also floors.

- [ ] **Step 4: Run green** (`npx vitest run test/pushService.test.ts`), commit:

```bash
git status
git add app/src/services/pushService.ts app/test/pushService.test.ts
git commit -m "feat(push): 30s retry floor on the users-list refresh - one alarm per window, not per message" -- app/src/services/pushService.ts app/test/pushService.test.ts
```

---

### Task 10: Voice push identity (role kept + full identity)

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` - delete `pushCallerLabel`
  (:128-143), add `pushCallerIdentity`, update its three consumer sites
  (:700 pre-ring; sendMissedCallPush :2248-2254; sendVoicemailPush
  :2311-2317)
- Test: `app/test/founderTriage.test.ts:174,:331-353,:590,:769` updates +
  ONE NEW voicemail-push-body case. `app/test/voiceRecording.test.ts` is
  NOT touched (its assertions stay green - verified in review).

**Interfaces:**
- Consumes: `contactDisplayName` (app/src/lib/contactName.ts:65),
  `roleWordForContact` + `UNKNOWN_CALLER_LABEL`
  (app/src/lib/voiceMasking.ts), `formatPhoneForDisplay`
  (app/src/lib/phone.ts), `contacts.findByPhone`.

- [ ] **Step 1: Update the four founderTriage assertions to the new copy
and add the voicemail case - run red.** New expected strings (the fixture
contact is Jane Doe, a tenant; the unknown-caller fixture has no contact):
- pre-ring known: `'Incoming call <DASH> Tenant - Jane Doe'` where <DASH>
  is the EXISTING (non-ASCII em dash) separator the file already has at
  :174 between "call" and the label - copy it from the file, never retype
  it; only the label half changes.
- pre-ring unknown (:331-353): `(555) 017-7777` still IN the payload, still
  NOT in logs - the label for a contact-less caller is the formatted number
  (unchanged outcome, assert as today).
- :590 and :769 (missed-call body): `'Missed call <DASH> Tenant - Jane Doe'`
  (same rule: <DASH> is the file's existing em-dash separator, copied not
  retyped).
- NEW voicemail case (copy the missed-call test's harness): drives the
  voicemail push and asserts `payload.body === 'New voicemail - Tenant - Jane Doe'`
  (this file's existing voicemail line uses an ASCII hyphen - check the
  source string at voice.ts:2320 and match it exactly).

- [ ] **Step 2: Implement.** Replace `pushCallerLabel` (:128-143) with:

```ts
/**
 * The PUSH-ONLY caller label (log-hygiene spec section 7; operator ruling
 * D4 2026-08-16 + role-word amendment 2026-08-25): staff-facing pushes carry
 * FULL caller identity like a native phone app - lock-screen privacy is the
 * DEVICE's job. The ROLE word is kept (it is load-bearing context on a
 * call); the identity half is the message pushes' naming chain with a
 * terminal fallback so the label is never empty/undefined.
 *
 * The STORED call_party_label, the whisper, thread rendering, and the
 * outbound originate path all keep the masked posture (voiceMasking.ts) -
 * this label exists ONLY in the ephemeral push payload. Logs never carry it.
 */
function pushCallerIdentity(
  contact: ContactItem | undefined,
  conversation: ConversationItem | undefined,
  phone: string | undefined,
): string {
  const identity =
    contactDisplayName(contact) ??
    (typeof conversation?.participant_display_name === 'string' &&
    conversation.participant_display_name.length > 0
      ? conversation.participant_display_name
      : undefined) ??
    formatPhoneForDisplay(phone) ??
    phone;
  const role = roleWordForContact(contact);
  if (role !== undefined && identity !== undefined) return `${role} - ${identity}`;
  return role ?? identity ?? UNKNOWN_CALLER_LABEL;
}
```

Add the needed imports (`contactDisplayName` from `../../lib/contactName.js`;
`ConversationItem` type is already imported in this file - verify).

Consumer sites:
- Pre-ring (:700 region): the call is
  `pushCallerLabel(callerLabel, From)` today - replace with
  `pushCallerIdentity(callerContact, conversation, From)` (both in scope at
  that point; verify against the surrounding code).
- sendMissedCallPush: replace :2248-2254's storedLabel+pushCallerLabel with:

```ts
    const conversation = await conversations.getById(conversationId);
    // Best-effort contact resolve for the full name; a lookup failure falls
    // through the chain to the number.
    let callerContact: ContactItem | undefined;
    try {
      callerContact = (await contacts.findByPhone(conversation?.participant_phone ?? '')) ?? undefined;
    } catch {
      callerContact = undefined;
    }
    const callerLabel = pushCallerIdentity(callerContact, conversation, conversation?.participant_phone);
```
  (The `messages.getByProviderSid` read and `storedLabel` are no longer
  needed at this site - remove them; check nothing else in the function
  uses `entry`. `findByPhone('')` must not throw - check its guard; if it
  can, skip the call when the phone is undefined/empty.)
- sendVoicemailPush (:2311-2317): identical replacement.
- Rewrite the doc comments on both functions and on the deleted helper's
  block to cite D4 + the role-word amendment (they currently assert the
  masked posture as current product law).

- [ ] **Step 3: Run green**

Run: `cd app && npx vitest run test/founderTriage.test.ts test/voiceRecording.test.ts`
Expected: PASS both (voiceRecording UNCHANGED - if it goes red you changed
behavior the spec says not to; stop and re-check).

- [ ] **Step 4: Commit**

```bash
git status
git add app/src/routes/webhooks/voice.ts app/test/founderTriage.test.ts
git commit -m "feat(voice): push labels carry role + full identity (D4 + role-word amendment)" -- app/src/routes/webhooks/voice.ts app/test/founderTriage.test.ts
```

---

### Task 11: ai-runs `unavailable` state

**Files:**
- Modify: `app/src/repos/aiRunsRepo.ts` (batchGetRuns :156-180; the union
  :84-86; listByEntity mapping :325-331)
- Modify: `app/src/routes/aiRuns.ts:195-218` (expired arm)
- Modify: `dashboard/src/api/types.ts:242`
- Modify: `dashboard/src/routes/settings/aiRuns/AiRunList.tsx:54`
- Modify (only if red): `app/test/aiRunsRepo.test.ts`,
  `app/test/aiRunsRepo.integration.test.ts`, `app/test/aiRunsApi.test.ts`,
  `dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx`,
  `dashboard/src/routes/settings/aiRuns/useAiRuns.test.ts`
- Comment refresh: `e2e/performance/routes.ts:691,:745` (citation comments
  only - NO contract change; the pin tables must NOT change)

**Interfaces:**
- Produces: server union member
  `{ runId: string; sortKey: string; expired: true; unavailable?: true }`
  (single non-live member, optional discriminant - two separate members do
  NOT typecheck at the truthiness-narrowed renderers); wire union matches.

- [ ] **Step 1: Failing repo test** (fake doc client): a BatchGet whose
UnprocessedKeys echo two `run#`-prefixed keys on EVERY attempt yields, after
4 attempts, `listByEntity` entries for those runIds of
`{ expired: true, unavailable: true }` while a genuinely-absent runId maps
to `{ expired: true }` with NO `unavailable` key, and found runs are
unaffected. Also assert cross-chunk accumulation: 150 keys where chunk 2's
leftovers persist -> both chunks' leftovers in the set.

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement.**

aiRunsRepo union (:84-86):
```ts
export type AiRunListEntry =
  | { runId: string; sortKey: string; expired: false; run: AiRunRecord }
  | { runId: string; sortKey: string; expired: true; unavailable?: true };
```
batchGetRuns: add near runItemId (:130) the inverse
`const runIdOfItemId = (itemId: string): string => itemId.slice('run#'.length);`
change the signature to
`Promise<{ found: Map<string, AiRunRecord>; unprocessedRunIds: Set<string> }>`,
accumulate leftovers across chunks
(`for (const k of keys) unprocessedRunIds.add(runIdOfItemId(k.itemId));`
after each chunk's attempt loop), keep the once-per-call WARN keyed on the
set's size. listByEntity mapping (:325-331):
```ts
      const { found: byRunId, unprocessedRunIds } = await batchGetRuns(pointers.map((p) => p.runId));
      const entries: AiRunListEntry[] = pointers.map((p) => {
        const run = byRunId.get(p.runId);
        if (run !== undefined) return { runId: p.runId, sortKey: p.sortKey, expired: false, run };
        // Unprocessed-after-4-attempts is sustained pressure, NOT a TTL reap -
        // the forensic surface must not call a throttled row "expired".
        return unprocessedRunIds.has(p.runId)
          ? { runId: p.runId, sortKey: p.sortKey, expired: true, unavailable: true }
          : { runId: p.runId, sortKey: p.sortKey, expired: true };
      });
```
Check the file for OTHER batchGetRuns callers (grep) and destructure at each.

routes/aiRuns.ts:196-197 expired arm (house `!== undefined` spread form):
```ts
        ? { runId: entry.runId, sortKey: entry.sortKey, expired: true as const,
            ...(entry.unavailable !== undefined && { unavailable: true as const }) }
```
dashboard types.ts:242:
```ts
export type AiRunListRow = AiRunListRowLive | { runId: string; sortKey: string; expired: true; unavailable?: true };
```
AiRunList.tsx:54 expired branch:
```tsx
        {rows.map((row) => row.expired ? <li key={row.runId} className={styles.expired}>{row.unavailable ? `Run ${row.runId} temporarily unavailable - reload the page to retry` : `Expired run ${row.runId}`}</li> : <li key={row.runId}>
```
("reload the page" means the BROWSER - deliberately NO new button: a third
button breaks the e2e one-button-per-row pin and the singular Retry query,
and useAiRuns.retry() resets to page 1.)

- [ ] **Step 4: Route + dashboard tests.** Add: a route case asserting the
serialized unavailable row `{ runId, sortKey, expired: true, unavailable: true }`;
a dashboard component case rendering an unavailable row's text and asserting
it is NOT a button. Run the five pinning files; fix any red per the shape
(review verified the existing assertions tolerate the optional key - reds
are unexpected, investigate before editing them).

Run: `cd app && npx vitest run test/aiRunsRepo.test.ts test/aiRunsRepo.integration.test.ts test/aiRunsApi.test.ts`
and `cd dashboard && npx vitest run src/routes/settings/aiRuns`
Expected: PASS.

- [ ] **Step 5: Refresh the two perf citation comments**
(`e2e/performance/routes.ts:691,:745`) to point at the lines the edited
files now have. Comments only; `cd e2e && npx vitest run performance/routes.test.ts`
must stay green with ZERO pin-table changes.

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/repos/aiRunsRepo.ts app/src/routes/aiRuns.ts dashboard/src/api/types.ts dashboard/src/routes/settings/aiRuns/AiRunList.tsx e2e/performance/routes.ts <touched test files>
git commit -m "feat(ai-runs): distinct unavailable row state for throttled BatchGet leftovers" -- <same paths>
```

---

### Task 12: Abandoned-journal sweep

**Files:**
- Modify: `app/src/repos/settingsRepo.ts` (one new period id + cursor pair)
- Modify: `app/src/repos/suggestionResolutionRepo.ts` (new
  `listActiveResolutionRows`)
- Modify: `app/src/services/suggestionResolution.ts` (recoverAbandoned
  `maxAttempts` option)
- Create: `app/src/jobs/journalSweep.ts`
- Modify: `app/src/worker.ts` (startPoll registration)
- Modify: `app/src/routes/dev.ts` (+ `DevRouterDeps`) - POST
  /__dev/journal-sweep/tick
- Test: `app/test/journalSweep.test.ts` (new), plus small additions to the
  settingsRepo and suggestionResolution suites.

**Interfaces:**
- Produces:
  - `JOURNAL_SWEEP_LAST_RUN_AT_ID = 'journal_sweep_last_run_at'` added to
    the `GroupPeriodRecordId` union (settingsRepo).
  - `SettingsRepo.getJournalSweepCursor(): Promise<string | undefined>` and
    `putJournalSweepCursor(cursor: string | undefined): Promise<void>`
    (undefined = clear) - a dedicated record `journal_sweep_scan_cursor`
    holding the JSON-stringified LastEvaluatedKey.
  - `SuggestionResolutionRepo.listActiveResolutionRows(opts: { cursor?:
    string; limit: number }): Promise<{ rows: Array<{ contactId: string;
    target: string; leaseExpiresAt: string; claimedAt: string }>;
    nextCursor?: string }>` - ONE Scan page:
    `FilterExpression: 'begins_with(#id, :p) AND #state = :active'`,
    `ExpressionAttributeNames: { '#id': 'itemId', '#state': 'state' }`
    (`state` is reserved), `:p = 'resolve#'`, `Limit: opts.limit`,
    `ExclusiveStartKey` parsed from opts.cursor, `nextCursor` from
    `LastEvaluatedKey` (JSON.stringify). NO age filter server-side - the
    age gate is app-side so fail-toward-scrub is implementable.
  - `recoverAbandoned(contactId, opts?: { maxAttempts?: number })` -
    default 2 (`MAX_RECOVERIES_PER_READ`, read path unchanged); the sweep
    passes 12 so a poison pair cannot starve the other ten targets.
  - `runJournalSweep(nowIso: string, deps, opts?: { force?: boolean })` in
    journalSweep.ts, exported constants
    `JOURNAL_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000`,
    `MAX_CONTACTS_PER_RUN = 25`, `MAX_RECOVERY_CALLS_PER_RUN = 100`,
    `MAX_SCAN_PAGES = 20`, `SCAN_PAGE_LIMIT = 200`,
    `JOURNAL_SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000`.

- [ ] **Step 1: settingsRepo additions (TDD each).** Failing tests: the new
id claims independently of the four group ids; cursor round-trips
(put string -> get it; put undefined -> get undefined). Implement: add the
constant + union member; `getJournalSweepCursor`/`putJournalSweepCursor`
as a plain Get/Put(+Delete-on-undefined) on record id
`journal_sweep_scan_cursor` with attribute `cursor`. Run green. Commit
(`feat(settings): journal-sweep cadence id + scan cursor record`).

- [ ] **Step 2: listActiveResolutionRows (TDD).** Failing integration test
(DynamoDB Local, this repo's integration-test pattern - copy the harness
from an existing suggestionResolutionRepo integration case): seed one
ACTIVE journal, one COMPLETED journal, one `sugg#` row; a full-page call
returns only the active row's projection; with `limit: 1` and 2 active
rows, `nextCursor` round-trips through a second call to reach the second
row. Implement per the interface above. Run green. Commit.

- [ ] **Step 3: recoverAbandoned maxAttempts (TDD).** Failing unit test:
with 3 lease-expired journals whose takeovers all FAIL, default budget
stops after 2 attempts (existing behavior pinned); with
`{ maxAttempts: 12 }` all 3 are attempted. Implement: signature
`recoverAbandoned(contactId, opts?: { maxAttempts?: number })`; replace the
`MAX_RECOVERIES_PER_READ` comparison at :583 with
`const budget = opts?.maxAttempts ?? MAX_RECOVERIES_PER_READ;` ...
`if (attempted >= budget) break;`. Interface doc updated. Run green +
`npx vitest run test/suggestionResolution*.test.ts`. Commit.

- [ ] **Step 4: journalSweep.ts (TDD with fakes).** Failing tests
(fake settingsRepo/resolutionRepo/service/events/logger):
1. cadence: claim false -> nothing runs; `force: true` -> runs.
2. app-side age gate: a lease-expired row claimed 1h ago does NOT qualify;
   25h ago DOES; an UNPARSEABLE claimedAt ('garbage') DOES (fail-toward-scrub).
3. contact dedup: 12 rows for one contact -> ONE contact processed.
4. caps: 30 qualifying contacts -> 25 processed, deferral logged at INFO
   (not ERROR), cursor persisted when pages remain.
5. cursor: run starts from the stored cursor; a run that exhausts the table
   clears it.
6. loop + SSE: recoverAbandoned returning
   `{recovered:2, stateChanged:true}` then `{recovered:0, stateChanged:false}`
   -> called twice, ONE `suggestion.updated` emit for the contact (OR'd).
7. truth check: after the loop, a re-read (listJournals fake) showing a
   still-active, lease-expired, past-age journal -> ERROR with counts;
   all-clear -> no ERROR.
8. throw inside the body -> ERROR logged, nothing re-thrown to the poll.

Implement:

```ts
// app/src/jobs/journalSweep.ts
// The sanctioned daily abandoned-journal sweep (log-hygiene spec section 9;
// operator decision 2026-08-24). Finds ACTIVE resolve# journals whose lease
// expired and whose claim is older than 24h, and drives them through the
// EXISTING recoverAbandoned machinery - which COMMITS the abandoned human
// decision (contact/phone writes, permanent dism# tombstones, audit rows
// backdated to claimedAt) and then scrubs the PII snapshot. Enumeration is
// a cursor-resumed bounded Scan: resolve# rows are deliberately in NO GSI
// (indexing them would copy their PII snapshot into a projection-ALL index),
// so a Scan is the only enumeration - once daily, pages bounded, cursor
// persisted so caps DEFER work rather than orphaning it.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { appEvents, type EventBus } from '../lib/events.js';
import {
  createSettingsRepo,
  JOURNAL_SWEEP_LAST_RUN_AT_ID,
  type SettingsRepo,
} from '../repos/settingsRepo.js';
import {
  createSuggestionResolutionRepo,
  type SuggestionResolutionRepo,
} from '../repos/suggestionResolutionRepo.js';
import {
  createSuggestionResolutionService,
  type SuggestionResolutionService,
} from '../services/suggestionResolution.js';

export const JOURNAL_SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;
export const JOURNAL_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_CONTACTS_PER_RUN = 25;
export const MAX_RECOVERY_CALLS_PER_RUN = 100;
export const MAX_SCAN_PAGES = 20;
export const SCAN_PAGE_LIMIT = 200;
/** The closed DECISION_TARGETS key-set size - one recovery call can attempt
 *  every target, so a poison pair cannot starve the rest. */
export const SWEEP_MAX_ATTEMPTS_PER_CALL = 12;

export interface JournalSweepDeps {
  settingsRepo?: Pick<SettingsRepo, 'claimGroupPeriod' | 'getJournalSweepCursor' | 'putJournalSweepCursor'>;
  resolutionRepo?: Pick<SuggestionResolutionRepo, 'listActiveResolutionRows' | 'listJournals'>;
  resolutionService?: Pick<SuggestionResolutionService, 'recoverAbandoned'>;
  events?: EventBus;
  logger?: Logger;
}

export interface JournalSweepOutcome {
  ran: boolean;
  contactsVisited: number;
  recovered: number;
  deferred: boolean;
  persistentContacts: number;
}

export async function runJournalSweep(
  nowIso: string,
  deps: JournalSweepDeps = {},
  opts: { force?: boolean } = {},
): Promise<JournalSweepOutcome> {
  const log = deps.logger ?? defaultLogger;
  const outcome: JournalSweepOutcome = { ran: false, contactsVisited: 0, recovered: 0, deferred: false, persistentContacts: 0 };
  try {
    const settings = deps.settingsRepo ?? createSettingsRepo({ logger: log });
    const repo = deps.resolutionRepo ?? createSuggestionResolutionRepo({ logger: log });
    const service = deps.resolutionService ?? createSuggestionResolutionService(/* the same
      construction routes/suggestions.ts uses - copy its deps block */);
    const events = deps.events ?? appEvents;
    const now = new Date(nowIso).toISOString();
    const nowMs = Date.parse(now);
    const notBefore = opts.force === true ? now : new Date(nowMs - JOURNAL_SWEEP_PERIOD_MS).toISOString();
    if (!(await settings.claimGroupPeriod(JOURNAL_SWEEP_LAST_RUN_AT_ID, now, notBefore))) return outcome;
    outcome.ran = true;

    // Enumerate: cursor-resumed pages, APP-SIDE age gate (a server-side
    // FilterExpression could never see an excluded row, so fail-toward-scrub
    // would be unimplementable - and a non-ISO claimedAt would be decided by
    // ASCII ordering).
    const contacts: string[] = [];
    const seen = new Set<string>();
    let cursor = await settings.getJournalSweepCursor();
    let pages = 0;
    let exhausted = false;
    while (pages < MAX_SCAN_PAGES && contacts.length < MAX_CONTACTS_PER_RUN) {
      const page = await repo.listActiveResolutionRows({ ...(cursor !== undefined && { cursor }), limit: SCAN_PAGE_LIMIT });
      pages += 1;
      for (const row of page.rows) {
        if (Date.parse(row.leaseExpiresAt) > nowMs) continue; // live lease
        const claimedMs = Date.parse(row.claimedAt);
        // Unparseable -> NaN -> comparison false -> QUALIFIES (fail-toward-scrub).
        if (Number.isFinite(claimedMs) && nowMs - claimedMs < JOURNAL_SWEEP_MIN_AGE_MS) continue;
        if (!seen.has(row.contactId) && contacts.length < MAX_CONTACTS_PER_RUN) {
          seen.add(row.contactId);
          contacts.push(row.contactId);
        }
      }
      cursor = page.nextCursor;
      if (cursor === undefined) { exhausted = true; break; }
    }
    await settings.putJournalSweepCursor(exhausted ? undefined : cursor);

    let calls = 0;
    for (const contactId of contacts) {
      outcome.contactsVisited += 1;
      let stateChanged = false;
      for (;;) {
        if (calls >= MAX_RECOVERY_CALLS_PER_RUN) break;
        calls += 1;
        const result = await service.recoverAbandoned(contactId, { maxAttempts: SWEEP_MAX_ATTEMPTS_PER_CALL });
        outcome.recovered += result.recovered;
        stateChanged = stateChanged || result.stateChanged;
        if (result.recovered === 0) break;
      }
      if (stateChanged) events.emit('suggestion.updated', { contactId });
      // POST-LOOP TRUTH CHECK: a consistent re-read of the contact's closed
      // 12-key journal set. Persistent actives past the gate = poison
      // journals nothing will ever scrub without attention -> ERROR (alarm).
      const journals = await repo.listJournals(contactId);
      const remaining = journals.filter((j) => {
        if (j.state !== 'active') return false;
        if (Date.parse(j.leaseExpiresAt) > nowMs) return false;
        const claimedMs = Date.parse(j.claimedAt);
        return !Number.isFinite(claimedMs) || nowMs - claimedMs >= JOURNAL_SWEEP_MIN_AGE_MS;
      });
      if (remaining.length > 0) {
        outcome.persistentContacts += 1;
        log.error(
          { contactId, remaining: remaining.length },
          'journal sweep: journals still active after recovery - persistent failure, will retry tomorrow',
        );
      }
    }

    outcome.deferred = !exhausted || contacts.length >= MAX_CONTACTS_PER_RUN;
    if (outcome.deferred) {
      // Routine rate limiting - the cursor carries the progress. INFO, never
      // ERROR: a standing daily alarm nothing can clear is the exact noise
      // class this mission removes.
      log.info(
        { contactsVisited: outcome.contactsVisited, pages, exhausted },
        'journal sweep: work deferred to the next run (caps/pages) - cursor persisted',
      );
    }
    log.info(
      { contactsVisited: outcome.contactsVisited, recovered: outcome.recovered, persistentContacts: outcome.persistentContacts },
      'journal sweep: run complete',
    );
    return outcome;
  } catch (err) {
    // The cadence record is already stamped (claim-first is the cross-process
    // dedup) - a failure here waits until tomorrow or a force tick. That is
    // accepted ON CONDITION it is loud (alarm-feeding).
    log.error({ err }, 'journal sweep: run failed - next natural retry is tomorrow (or a force tick)');
    return outcome;
  }
}
```

(Adjust the service construction to the REAL factory name/signature in
services/suggestionResolution.ts - copy how routes/suggestions.ts builds it.
`listJournals` visibility: it is repo-level (:527) - confirm it is on the
exported interface; if not, add it to the Pick from what IS exported.
`suggestion.updated`'s payload is `{ contactId }` - verified in review.)

- [ ] **Step 5: worker + dev tick.**
worker.ts - a new block after the group-guardrail poll:
```ts
// Abandoned-journal sweep (log-hygiene spec section 9): daily cadence behind
// a settings-record claim; the poll itself is the shared interval.
{
  const { runJournalSweep } = await import('./jobs/journalSweep.js');
  startPoll('journal sweep', (now) => runJournalSweep(now, { logger }));
}
```
dev.ts - add `journalSweepDeps?: JournalSweepDeps` to DevRouterDeps and the
route, copying the group-guardrails tick verbatim minus `duties`:
```ts
  // POST /__dev/journal-sweep/tick { now?, force? } - app-side driver for the
  // abandoned-journal sweep (A16: worker logs never reach /__dev/logtail, and
  // the worker shares the cadence record - force defaults TRUE, same
  // rationale as the group-guardrails tick above).
  router.post('/__dev/journal-sweep/tick', json(), async (req, res) => {
    const body = (req.body ?? {}) as { now?: unknown; force?: unknown };
    let nowIso = new Date().toISOString();
    if (body.now !== undefined) {
      if (typeof body.now !== 'string' || !Number.isFinite(Date.parse(body.now))) {
        res.status(400).json({ error: 'now must be a valid ISO 8601 datetime' });
        return;
      }
      nowIso = new Date(body.now).toISOString();
    }
    const force = body.force === undefined ? true : body.force === true;
    const outcome = await runJournalSweep(nowIso, deps.journalSweepDeps ?? { logger: log }, { force });
    log.info({ now: nowIso, ...outcome }, 'dev journal-sweep tick ran');
    res.status(200).json({ ok: true, ...outcome });
  });
```

- [ ] **Step 6: Run the new suite + the app suite; commit.**

```bash
git status
git add app/src/jobs/journalSweep.ts app/src/worker.ts app/src/routes/dev.ts app/src/repos/settingsRepo.ts app/src/repos/suggestionResolutionRepo.ts app/src/services/suggestionResolution.ts app/test/journalSweep.test.ts <touched test files>
git commit -m "feat(extraction): daily abandoned-journal sweep - cursor-resumed scan + recoverAbandoned budget widening" -- <same paths>
```

---

### Task 13: Issue-file mutations + docs

**Files:**
- Modify (resolved stamps): `docs/issues/twilio-sdk-error-logs-leak-credentials.md`,
  `docs/issues/telemetry-phone-in-url-pii.md`,
  `docs/issues/relay-intro-dlr-unknown-sid-noise.md`,
  `docs/issues/relay-direct-sends-unknown-sid-callbacks.md`,
  `docs/issues/push-users-scan-failure-logs-error-per-message.md`,
  `docs/issues/push-failure-status-not-surfaced.md`,
  `docs/issues/voice-push-pii-masking-outdated.md`,
  `docs/issues/ai-runs-throttled-batchget-renders-expired.md`,
  `docs/issues/abandoned-journal-pii-until-next-contact-read.md`
- Create: `docs/issues/phone-in-url-paths-structural.md` (copy
  `docs/issues/_TEMPLATE.md`; low; the SIX-route surface list from spec
  section 4)
- Modify: `docs/issues/consolidate-contact-display-name-helpers.md` (one
  line: voice pushes are a second push-copy consumer)

Rules: each resolved stamp is `status: resolved` + a dated resolution note
naming the branch and the mechanism; the two relay issues note the stale
production half; the abandoned-journal issue records the decision reversal
and constants; telemetry notes the structural re-file. ASCII-only. Grep
`TODO(` for each slug and update/remove inline markers. Run
`npm run issues` (regenerates the gitignored INDEX - run, do not commit
INDEX.md).

- [ ] Commit:
```bash
git status
git add docs/issues/
git commit -m "docs(issues): resolve the nine C3 issues; re-file the structural phone-in-URL remainder" -- docs/issues/
```

---

### Task 14: Gates + main sync (final, in order)

- [ ] Sync main ONCE: `git fetch` is not needed (local repo); from the
  worktree `git merge main` - resolve preserving both sides' intent; if
  main moved under C1's merge and conflicts touch the five excluded files,
  STOP and report rather than resolving unilaterally. Then re-run the
  Task 4 audit grep over any files main's advance added (new error-log
  sites since the branch base) and close them per the sweep rules.
- [ ] `npm run typecheck` - bare, from the worktree. EXIT 0.
- [ ] `npm test` - bare (DynamoDB Local up). EXIT 0.
- [ ] `npm run smoke` - bare. EXIT 0.
- [ ] `npm run e2e` - bare, hard outer timeout 1500s, NEVER commit while it
  runs. EXIT 0.
- [ ] Gate 5: `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
  - attribute any errors by BASELINE COMPARISON (same command at the merge
  base); yours are blocking, pre-existing are named in the handback.
- [ ] Handback per the orchestrator manual: per-spec-item table, quoted
  exit codes, sweep table location, deviations, owed operator actions
  (none expected).
