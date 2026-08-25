# Log Hygiene (C3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

v2 after adversarial plan review round 1 (adjudications:
.superpowers/design-review/adjudications.md).

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
- Run `npm run typecheck` (worktree root, bare) BEFORE EVERY COMMIT - the
  embedded snippets in this plan were written against read code, not
  compiled; the type gate is per-task, not end-loaded.
- Commit discipline: bare `git status` before EVERY commit; stage and commit
  EXPLICIT paths only (never `git add -A`); every commit carries
  `Co-Authored-By:` naming your model.
- LINE NUMBERS DRIFT. Every `:NNN` anchor in this plan was read at branch
  base 6e707348 - re-locate by the quoted code, not the number.
- TEST-FILE NAMES: where this plan says "create <file>", create it; where it
  says "extend", grep first (`ls app/test | grep -i <topic>`) and put the
  cases beside the closest existing coverage; if none exists, create the
  named file. Never invent expectations about files you have not opened.
- Tests: `npm test` needs DynamoDB Local (`npm run db:start` once). Single
  files: `cd app && npx vitest run test/<file>.test.ts`.
- Never run `npm run e2e` and commit at the same time; never touch ports
  :5174/:8080.
- No infra mutations, no new dependencies, no message-catalog entries.
- Constants (spec values, verbatim): REFRESH_RETRY_FLOOR_MS = 30_000;
  syssid marker TTL = 30 days (epoch SECONDS); JOURNAL_SWEEP_MIN_AGE_MS =
  24h; MAX_CONTACTS_PER_RUN = 25; MAX_RECOVERY_CALLS_PER_RUN = 100;
  MAX_SCAN_PAGES = 20; SCAN_PAGE_LIMIT = 200; recoverAbandoned maxAttempts
  default 2, sweep passes 12; serializer cause depth 3, aggregate cap 5.
- ADJUDICATED SPEC DEVIATIONS (do not "fix" these back): (1) the
  e2e/performance/routes.ts:691,:745 "citation refresh" from spec section
  12 is DROPPED - those strings are frozen pin-table data
  (CONTRACT_SOURCE_LEDGER), format-checked only, and editing them is a
  perf-contract change; rot is cosmetic and accepted. (2) Pre-existing
  syssid# markers (a handful of cell-verification rows) do NOT get a TTL
  backfill - only new writes carry expires_at; stated in the tables.ts
  comment.

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

Naming rule (decided HERE, not by the builder): the emitted `type` field
prefers the DECLARED `err.name` when it is present and not the generic
'Error', else the constructor name, else 'Error' - the same
most-identifying-field preference `summarizeError` uses. So an AxiosError
(declared name 'AxiosError') emits `type: 'AxiosError'`; a TypeError emits
'TypeError'; a plain `new Error(...)` emits 'Error'.

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

  it('allowlists an Error: no config/request/response survive; type prefers the declared name', () => {
    const out = serializeLoggedError(axiosLikeError()) as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
    expect(json).not.toContain('15551230000');
    expect(out['type']).toBe('AxiosError');
    expect(out['message']).toContain('ECONNRESET');
    expect(typeof out['stack']).toBe('string');
    expect(out['code']).toBe('ECONNRESET');
    expect(out['status']).toBe(500); // lifted from response.status pre-drop
    expect(Object.keys(out).every((k) =>
      ['type', 'message', 'stack', 'code', 'status', 'statusCode', 'moreInfo', '$metadata', 'cause', 'aggregateErrors'].includes(k),
    )).toBe(true);
  });

  it('a plain Error and a TypeError keep their identities', () => {
    expect((serializeLoggedError(new Error('x')) as Record<string, unknown>)['type']).toBe('Error');
    expect((serializeLoggedError(new TypeError('x')) as Record<string, unknown>)['type']).toBe('TypeError');
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
// 3. `instanceof Error` values emit ONLY the allowlist below. `type` prefers
//    the DECLARED name when present and not the generic 'Error' (the
//    most-identifying-field preference summarizeError uses), else the
//    constructor name.
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
  const declared = typeof err.name === 'string' && err.name.length > 0 ? err.name : undefined;
  const constructed = err.constructor?.name;
  const out: Record<string, unknown> = {
    // pino's field name for the error class is `type` - kept so existing
    // CloudWatch queries keep working. Declared-name preference: rule 3.
    type:
      declared !== undefined && declared !== 'Error'
        ? declared
        : typeof constructed === 'string' && constructed.length > 0 && constructed !== 'Object'
          ? constructed
          : 'Error',
    message: err.message,
    ...(typeof err.stack === 'string' && { stack: err.stack }),
  };
  if (typeof raw.code === 'string' && raw.code.length > 0) out['code'] = raw.code;
  else if (typeof raw.code === 'number') out['code'] = String(raw.code);
  // Lift status from the two places vendors put it, BEFORE response is
  // dropped (the same two-source lift summarizeError does).
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

- [ ] **Step 4: Run to verify it passes, then typecheck**

Run: `cd app && npx vitest run test/logSerializers.test.ts` -> PASS.
Run (worktree root): `npm run typecheck` -> EXIT 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/lib/logSerializers.ts app/test/logSerializers.test.ts
git commit -m "feat(logging): safe error serializer - allowlist for instanceof Error, pass-through otherwise" -- app/src/lib/logSerializers.ts app/test/logSerializers.test.ts
```

---

### Task 2: Wire the serializer into createLogger + runtime guard + errorSummary.test rewrite

**Files:**
- Modify: `app/src/lib/logger.ts` (the `createLogger` options object)
- Modify: `app/test/errorSummary.test.ts` (the `[REDACTED]` assertions at
  ~:107-141)
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

function capture(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  return { lines, stream: { write(line: string) { lines.push(line); } } };
}

function syntheticAxiosError(): Error {
  const err = new Error('connect ECONNRESET') as Error & Record<string, unknown>;
  err.name = 'AxiosError';
  err.code = 'ECONNRESET';
  err.config = { headers: { Authorization: FAKE_BASIC }, data: 'To=%2B15551230000&Body=hello' };
  err.request = { _header: `POST /x HTTP/1.1\r\nAuthorization: ${FAKE_BASIC}\r\n\r\n` };
  err.response = { status: 500, config: { headers: { Authorization: FAKE_BASIC } }, data: 'To=%2B15551230000' };
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
Expected: FAIL - the `error`/`cause`/`reason` cases leak the sentinel (no
serializer yet); the `err` case shows `[REDACTED]` instead of absence.

- [ ] **Step 3: Wire the serializer**

In `app/src/lib/logger.ts`: add the import and the `serializers` option.
The redact block STAYS EXACTLY AS IS. Add after the existing imports:

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

- [ ] **Step 4: Rewrite the errorSummary assertions**

In `app/test/errorSummary.test.ts` (:107-117 and :119-141), replace BOTH
`expect(line).toContain('[REDACTED]')` assertions with:

```ts
    // The serializer (lib/logSerializers.ts) strips config/request/response
    // before redaction runs - the credential is ABSENT, not censored.
    expect(line).not.toContain('[REDACTED]');
```

(keeping each case's setup and its existing not-toContain lines). Do NOT
add a `not.toContain('config')` assertion - stack traces are uncontrolled
text and 'config' can legitimately appear in a path.

- [ ] **Step 5: Run both files, sweep for other pinners, typecheck**

Run: `cd app && npx vitest run test/logSanitization.test.ts test/errorSummary.test.ts` -> PASS.
Run: `grep -rn "REDACTED" app/test` - any OTHER case pinning `[REDACTED]`
on an `err`-key line gets the same rewrite (record each in the build
report). Then the full app suite: `cd app && npx vitest run` -> PASS.
Then `npm run typecheck` -> EXIT 0.

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
  workspace hoisting (`import ts from 'typescript'`); `LOG_SERIALIZER_KEYS`
  (Task 1); the REAL `app/tsconfig.json` (spec requires the real compiler
  options, not hand-rolled ones).
- Produces: nothing runtime - a ratchet test.

Three correctness rules from review, all load-bearing:
- ESM: this package has no `__dirname` - use `import.meta.url`.
- Shorthand `{ err }` properties resolve their VALUE symbol via
  `checker.getShorthandAssignmentValueSymbol(prop)`, NOT
  `getSymbolAtLocation(prop.name)` (which answers the property symbol) -
  without this the canary itself is invisible.
- The allowlist matches EXACT `file:line key` strings, never substrings.

- [ ] **Step 1: Write the guard**

```ts
// app/test/logCallSiteGuard.test.ts
// STATIC GUARD (log-hygiene spec section 3 guard 2): parse app/src with the
// TypeScript compiler and FAIL when an identifier DECLARED BY A CATCH CLAUSE
// (or any Error-typed value) is assigned to a logger-call property that is
// not a top-level wired key.
//
// WHY CATCH-CLAUSE, NOT TYPES ALONE: under `strict: true` every bare
// `catch (e)` binding is `unknown` (464 sites, zero annotations), so a
// purely type-based check flags nothing, forever; a name-regex check
// false-positives on domain uses (`refusal: err.code`,
// `message: errorMessage(err)`). A BARE identifier whose declaration is a
// CatchClause is exactly "an error", regardless of its static type.
//
// KNOWN LIMITS - do not mistake a green run for proof (the
// tourCopyCallSites.test.ts precedent): a payload hoisted into a const and
// passed as an identifier, a spread of a helper's return, a catch variable
// laundered through a local, and an error stringified into `msg` are all
// invisible to this guard. Accepted: the serializer (Task 1) plus the sweep
// baseline (Task 4) carry those; this is a ratchet against the common
// literal form, not a proof.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { LOG_SERIALIZER_KEYS } from '../src/lib/logSerializers.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(TEST_DIR, '..');
const WIRED = new Set<string>(LOG_SERIALIZER_KEYS);
const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const CANARY_NAME = '__guard_canary__.ts';
const CANARY_SOURCE = [
  'declare const log: { error(payload: object, msg: string): void };',
  'export function canary(): void {',
  '  try { JSON.parse("x"); } catch (err) { log.error({ ctx: { err } }, "boom"); }',
  '}',
  '',
].join('\n');

interface GuardProgram { program: ts.Program; checker: ts.TypeChecker }

/** Build over the REAL app tsconfig; optionally overlay the canary file. */
function buildProgram(withCanary: boolean): GuardProgram {
  const configPath = join(APP_DIR, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('failed to parse app/tsconfig.json');
  const canaryPath = join(APP_DIR, 'src', CANARY_NAME);
  const rootNames = withCanary ? [...parsed.fileNames, canaryPath] : parsed.fileNames;
  const host = ts.createCompilerHost(parsed.options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, langVersion, ...rest) =>
    fileName.endsWith(CANARY_NAME)
      ? ts.createSourceFile(fileName, CANARY_SOURCE, langVersion, true)
      : realGetSourceFile(fileName, langVersion, ...rest);
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName.endsWith(CANARY_NAME) || realFileExists(fileName);
  const program = ts.createProgram(rootNames, parsed.options, host);
  return { program, checker: program.getTypeChecker() };
}

/** Exact-format findings: `<relative-file>:<line> <key>`. */
function scanProgram({ program, checker }: GuardProgram): string[] {
  const findings: string[] = [];

  const isCatchDeclared = (sym: ts.Symbol | undefined): boolean => {
    const decl = sym?.valueDeclaration;
    return decl !== undefined && ts.isVariableDeclaration(decl) && ts.isCatchClause(decl.parent);
  };
  const isErrorTyped = (node: ts.Node): boolean => {
    const type = checker.getTypeAtLocation(node);
    return type.getSymbol()?.getName() === 'Error' || checker.typeToString(type) === 'Error';
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const inScope = sf.fileName.includes('/src/') || sf.fileName.includes('\\src\\') || sf.fileName.endsWith(CANARY_NAME);
    if (!inScope) continue;
    const report = (node: ts.Node, key: string): void => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      const rel = sf.fileName.slice(sf.fileName.lastIndexOf('src'));
      findings.push(`${rel}:${line + 1} ${key}`);
    };
    const walkPayload = (obj: ts.ObjectLiteralExpression, depth: number): void => {
      for (const prop of obj.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          const keyName = prop.name.text;
          const legal = depth === 0 && WIRED.has(keyName);
          const valueSym = checker.getShorthandAssignmentValueSymbol(prop);
          if (!legal && (isCatchDeclared(valueSym ?? undefined) || isErrorTyped(prop.name))) {
            report(prop, keyName);
          }
        } else if (ts.isPropertyAssignment(prop)) {
          const keyName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : '<computed>';
          const legal = depth === 0 && WIRED.has(keyName);
          const value = prop.initializer;
          if (!legal && ts.isIdentifier(value)
              && (isCatchDeclared(checker.getSymbolAtLocation(value) ?? undefined) || isErrorTyped(value))) {
            report(prop, keyName);
          }
          if (ts.isObjectLiteralExpression(value)) walkPayload(value, depth + 1);
        }
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        LOG_METHODS.has(node.expression.name.text) &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0]!)
      ) {
        walkPayload(node.arguments[0] as ts.ObjectLiteralExpression, 0);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

describe('logger call-site guard', () => {
  it('the real program is healthy: files resolved, no unresolved-module diagnostics', () => {
    const gp = buildProgram(false);
    const sourceCount = gp.program.getSourceFiles().filter((f) => !f.isDeclarationFile).length;
    expect(sourceCount).toBeGreaterThan(50);
    // TS2307 = cannot find module. A misconfigured program resolves nothing,
    // reports these, and would otherwise scan an empty world and pass.
    const unresolved = ts
      .getPreEmitDiagnostics(gp.program)
      .filter((d) => d.code === 2307)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
    expect(unresolved).toEqual([]);
  });

  it('the canary overlaid into the REAL program is flagged (positive control)', () => {
    const findings = scanProgram(buildProgram(true));
    expect(findings.some((f) => f.includes(CANARY_NAME))).toBe(true);
  });

  it('app/src has no error logged outside a wired key (allowlist starts EMPTY)', () => {
    const findings = scanProgram(buildProgram(false));
    // Reviewed exceptions: EXACT `file:line key` strings with a justifying
    // comment each. Starts empty (spec section 3).
    const ALLOWLIST = new Set<string>([]);
    const unexpected = findings.filter((f) => !ALLOWLIST.has(f));
    expect(unexpected).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd app && npx vitest run test/logCallSiteGuard.test.ts`
Expected: all three PASS (review found zero members of this class). If the
empty-allowlist case reports findings, each is a REAL discovery - fix the
call site in a SEPARATE commit staged WITH this test (rewire to a wired
key; record in the Task 4 sweep table); never allowlist to get green. If
the canary case fails, the guard is broken - fix the guard, never the
canary. NOTE this test compiles app/src twice; if it exceeds the default
vitest timeout, raise the per-test timeout in this file (e.g.
`it('...', { timeout: 120_000 }, ...)`) rather than shrinking the program.
Then `npm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git status
git add app/test/logCallSiteGuard.test.ts
git commit -m "test(logging): static AST guard - catch-clause errors must ride a wired key" -- app/test/logCallSiteGuard.test.ts
```

(If Step 2 forced call-site fixes, add those exact source paths to the same
commit and name them in the message.)

---

### Task 4: The sweep (audit + the four pushService payload conversions)

**Files:**
- Modify: `app/src/services/pushService.ts` (four log payloads; anchors
  below were read at base - re-locate by message text)
- Create: `.superpowers/sdd/reports/sweep-table.md` (mkdir -p the directory
  first; gitignored build artifact whose CONTENT is copied into the final
  handback - gitignored artifacts die with the worktree)
- Test: extend `app/test/pushService.test.ts`

**Interfaces:**
- Consumes: Task 2 (the serializer makes `{ err }` safe).
- Produces: the audit baseline; the err-object WARN shapes Task 9 builds on.

- [ ] **Step 1: The audit.** Enumerate every error-carrying log payload:

```bash
mkdir -p .superpowers/sdd/reports
grep -rnE "\{ err\b|, err[,} ]|err:" app/src --include='*.ts' > .superpowers/sdd/reports/sweep-raw.txt
```

Classify EVERY hit into `.superpowers/sdd/reports/sweep-table.md`
(`file | line | class | action`):
- `WIRED-OK` - error under a wired key at top level: safe now, no action.
- `KEPT-STRICTER` - the `errFields` spreads in
  `app/src/services/inboundEmail.ts` and
  `app/src/services/sendEmailMessage.ts` (helper definitions + all spread
  call sites): a deliberate 200-char PII bound on the email path. DO NOT
  CONVERT (spec section 2).
- `KEPT-SUMMARY` - `summarizeError(...)` sites and the `err: { name: ... }`
  name-only sites: deliberate postures, no action.
- `EXCLUDED-C1` - hits in the five forbidden files: record, do not touch.
- `CONVERTED` - a real finding rewired to a wired key. Expected: only the
  four pushService payload conversions below (the review found no others;
  if you find one, Task 3's guard should have flagged it - cross-check).

- [ ] **Step 2: Write the failing test for the conversions.** The existing
pushService tests do not pin these payload fields, so the NEW cases are the
red state. Add to `app/test/pushService.test.ts`, using the file's existing
harness (fake adapter + fake users repo + injected logger fake - copy a
neighboring case's setup):

```ts
it('a transient device failure logs the error OBJECT and pushStatusCode', async () => {
  // adapter.sendToSubscription rejects with:
  const failure = Object.assign(new Error('Received unexpected response code'), { statusCode: 413 });
  // ...drive sendToUser at one subscription; then assert on the logger fake:
  // warn was called with a payload whose `err` is the SAME failure object
  // (or, if the harness captures serialized lines, whose err.statusCode is 413)
  // and whose `pushStatusCode` is 413.
});
it('a failed Gone-prune logs the error object under err', async () => {
  // users.removePushSubscription rejects; assert the warn payload's `err`
  // is the rejection object, not a string.
});
```

Make both concrete against the file's real harness shape (open the file
first; if its logger is a vi.fn()-backed fake, assert on `mock.calls`; if
it captures serialized lines, parse them). Run red:
`cd app && npx vitest run test/pushService.test.ts`.

- [ ] **Step 3: Convert the four payloads.** In each, ONLY the payload
object changes - message strings are NOT retyped (two contain non-ASCII
dashes):
1. WARN 'push: pruning a non-allowlisted endpoint failed - kept, not sent'
   (binding `err`): payload becomes `{ userId, kind, err }`.
2. WARN 'push: pruning a Gone endpoint failed - kept, retried on the next
   send' (binding `pruneErr`): payload becomes `{ userId, kind, err: pruneErr }`.
3. WARN 'push: send to one device failed (transient) - kept subscription'
   (binding `err`): payload becomes
   `{ userId, kind, err, pushStatusCode: (err as { statusCode?: number }).statusCode }`.
   (`pushStatusCode`, NOT `statusCode` - the request logger owns top-level
   `statusCode` for HTTP responses. This delivers spec 6.2.)
4. WARN 'push: broadcast to one user failed - continuing' (binding `err`):
   payload becomes `{ userId: user.userId, kind: notification.kind, err }`.
   (Site 4 is sanctioned by spec section 2's sweep rules - same
   string-under-err class as the three named sites.)

- [ ] **Step 4: Run green + typecheck + commit**

```bash
git status
git add app/src/services/pushService.ts app/test/pushService.test.ts
git commit -m "feat(push): per-device failure WARNs log the error object + pushStatusCode" -- app/src/services/pushService.ts app/test/pushService.test.ts
```

---

### Task 5: maskPhonesInText in lib/phone.ts

**Files:**
- Modify: `app/src/lib/phone.ts` (append)
- Test: `app/test/phone.test.ts` if it exists (check:
  `ls app/test | grep -i phone`), else create `app/test/phoneMask.test.ts`;
  stage WHICHEVER file you actually touched.

**Interfaces:**
- Produces: `maskPhonesInText(text: string): string` for Tasks 6-7.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { maskPhonesInText } from '../src/lib/phone.js';

describe('maskPhonesInText', () => {
  it('masks a bare E.164 path segment to first digit + last two', () => {
    expect(maskPhonesInText('/api/contacts/abc/phones/+14045551234')).toBe('/api/contacts/abc/phones/+1...34');
  });
  it('masks the URL-encoded %2B variant, both casings', () => {
    expect(maskPhonesInText('/x?phone=%2B14045551234')).toBe('/x?phone=%2B1...34');
    expect(maskPhonesInText('/x?phone=%2b14045551234')).toBe('/x?phone=%2b1...34');
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

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement** (append to `app/src/lib/phone.ts`):

```ts
// maskPhonesInText - SERVER-ONLY log/span masking helper (log-hygiene spec
// section 4). NOT part of the dashboard mirror contract declared at the top
// of this file: the dashboard copy does NOT gain it (it masks log sinks and
// span attributes, which only the server has).
//
// Masks E.164-shaped runs - `+` (or its URL-encoded `%2B`/`%2b`) followed by
// 8-15 digits - down to first digit + `...` + last two, e.g. `+14045551234`
// -> `+1...34` (the leading digit is the NANP country code in this app's
// traffic; non-NANP numbers keep their first digit the same way). 8 is the
// floor so short non-phone tokens (`+123`) survive untouched.
const PHONE_RUN_RE = /(\+|%2[Bb])(\d{8,15})/g;

/** Mask every E.164-shaped run in a string; phone-free input is returned as-is. */
export function maskPhonesInText(text: string): string {
  return text.replace(PHONE_RUN_RE, (_m, prefix: string, digits: string) => {
    return `${prefix}${digits.charAt(0)}...${digits.slice(-2)}`;
  });
}
```

- [ ] **Step 4: Run green, typecheck, commit** (stage the test file you
actually touched):

```bash
git status
git add app/src/lib/phone.ts app/test/phoneMask.test.ts
git commit -m "feat(pii): maskPhonesInText - E.164 masking for log sinks and spans" -- app/src/lib/phone.ts app/test/phoneMask.test.ts
```

---

### Task 6: Apply masking at every request-path log sink

**Files (re-locate every anchor by the quoted expression):**
- Modify: `app/src/middleware/requestLogger.ts` (both `path: req.path`
  fields - the "request received" and "request completed" lines)
- Modify: `app/src/lib/errors.ts` (three `path: req.path` fields in
  createExpressErrorHandler)
- Modify: `app/src/middleware/rateLimit.ts`,
  `app/src/middleware/csrfOrigin.ts`, `app/src/middleware/originSecret.ts`,
  `app/src/middleware/twilioSignature.ts` - every `path: req.path` (or
  equivalent `req.path` value) inside a LOGGER payload. All six
  twilioSignature sinks log `req.path` (review-verified) - there is no
  full-URL log sink there; the `url` locals feed signature computation,
  never a logger.
- Create: `app/test/requestLoggerMask.test.ts` (no requestLogger test file
  exists today - review-verified)
- Modify: `app/test/errorSummary.test.ts` (one new case beside the
  existing createExpressErrorHandler coverage; grep
  `createExpressErrorHandler` under app/test to confirm where that lives
  and put the case there)

**Interfaces:**
- Consumes: `maskPhonesInText` (Task 5).

- [ ] **Step 1: Failing test** (complete and concrete - no harness exists
to copy):

```ts
// app/test/requestLoggerMask.test.ts
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DestinationStream } from 'pino';
import { createLogger } from '../src/lib/logger.js';
import { requestLoggerMiddleware } from '../src/middleware/requestLogger.js';

describe('requestLogger phone masking', () => {
  it('masks E.164 segments in the logged path on both lines', () => {
    const lines: string[] = [];
    const stream: DestinationStream = { write(line: string) { lines.push(line); } };
    const log = createLogger({ destination: stream, level: 'info' });
    const middleware = requestLoggerMiddleware(log);
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;
    const req = {
      method: 'DELETE',
      path: '/api/contacts/c1/phones/+14045551234',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    middleware(req as never, res as never, () => {});
    res.emit('finish');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).not.toContain('14045551234');
    }
    expect(lines[0]).toContain('/api/contacts/c1/phones/+1...34');
    expect(lines[1]).toContain('/api/contacts/c1/phones/+1...34');
  });
});
```

And one case beside the express-error-handler coverage: build
`createExpressErrorHandler(log)` over a capture logger, invoke it with
`(new Error('boom'), { method: 'PATCH', path: '/api/contacts/c1/phones/+14045551234' } as never, resFake, next)`
where resFake has `headersSent: false`, `status()` returning
`{ json() {} }`; assert the captured ERROR line contains `+1...34` and not
the raw digits.

- [ ] **Step 2: Run red** (the masking helper exists but the sinks are
unmasked - both new cases fail on the raw digits).

- [ ] **Step 3: Apply the edit at every sink.** Pattern everywhere:
`path: req.path` -> `path: maskPhonesInText(req.path)`, with the import
added per file (`from '../lib/phone.js'` in middleware/, `from './phone.js'`
in lib/). Enumerate the full set mechanically and mask every hit inside a
logger payload:

```bash
grep -rn "req.path" app/src --include='*.ts'
```

Skip: hits in the five C1-excluded files (record in the sweep table);
functional uses (route matching, comparisons, signature computation) - only
LOGGER payload fields change.

- [ ] **Step 4: Run green + suites + typecheck**

`cd app && npx vitest run test/requestLoggerMask.test.ts test/errorSummary.test.ts`
then the full app suite (middleware suites may pin raw paths - update any
red case WITH its file). Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/middleware/requestLogger.ts app/src/lib/errors.ts app/src/middleware/rateLimit.ts app/src/middleware/csrfOrigin.ts app/src/middleware/originSecret.ts app/src/middleware/twilioSignature.ts app/test/requestLoggerMask.test.ts app/test/errorSummary.test.ts
git commit -m "feat(pii): mask E.164 segments at every request-path log sink" -- app/src/middleware/requestLogger.ts app/src/lib/errors.ts app/src/middleware/rateLimit.ts app/src/middleware/csrfOrigin.ts app/src/middleware/originSecret.ts app/src/middleware/twilioSignature.ts app/test/requestLoggerMask.test.ts app/test/errorSummary.test.ts
```

(Add any updated middleware test files to the same commit.)

---

### Task 7: OTel span-attribute masking hooks

**Files:**
- Modify: `app/src/lib/otel.ts`
- Test: extend `app/test/otel.test.ts`

**Interfaces:**
- Consumes: `maskPhonesInText` (Task 5; phone.ts is pure - safe pre-logger).
- Produces: `maskIncomingSpanAttributes(request)`,
  `maskOutgoingSpanAttributes(request)` - exported pure functions.

SEMCONV RULE (review round 1: the instrumentation defaults to the OLD
attribute family and only sets `url.*` when `OTEL_SEMCONV_STABILITY_OPT_IN`
enables the stable/dup mode; returning a key the instrumentation never set
FABRICATES it): the hooks ALWAYS emit the old family (`http.url`,
`http.target`) and ADDITIONALLY emit the stable family (`url.path`/
`url.query` incoming, `url.full` outgoing) ONLY when
`process.env.OTEL_SEMCONV_STABILITY_OPT_IN` is a non-empty string
containing `http`. State this in the module comment.

- [ ] **Step 1: Failing tests**

```ts
import { maskIncomingSpanAttributes, maskOutgoingSpanAttributes } from '../src/lib/otel.js';

describe('span attribute masking hooks', () => {
  it('incoming (default semconv): masks and emits ONLY the old family', () => {
    delete process.env['OTEL_SEMCONV_STABILITY_OPT_IN'];
    const attrs = maskIncomingSpanAttributes({
      url: '/api/contacts/c1/phones/+14045551234?x=%2B15551230000',
      headers: { host: 'app.example.com' },
    } as never);
    expect(attrs).toEqual({
      'http.url': 'http://app.example.com/api/contacts/c1/phones/+1...34?x=%2B1...00',
      'http.target': '/api/contacts/c1/phones/+1...34?x=%2B1...00',
    });
  });
  it('incoming (stable opt-in): also emits masked url.path/url.query', () => {
    process.env['OTEL_SEMCONV_STABILITY_OPT_IN'] = 'http';
    try {
      const attrs = maskIncomingSpanAttributes({
        url: '/a/+14045551234?x=1',
        headers: { host: 'h' },
      } as never) as Record<string, string>;
      expect(attrs['url.path']).toBe('/a/+1...34');
      expect(attrs['url.query']).toBe('x=1');
    } finally {
      delete process.env['OTEL_SEMCONV_STABILITY_OPT_IN'];
    }
  });
  it('outgoing (default semconv): masks and emits ONLY the old family', () => {
    delete process.env['OTEL_SEMCONV_STABILITY_OPT_IN'];
    const attrs = maskOutgoingSpanAttributes({
      hostname: 'api.twilio.com',
      path: '/2010-04-01/Messages.json?To=%2B15551230000',
      protocol: 'https:',
    } as never);
    expect(attrs).toEqual({
      'http.url': 'https://api.twilio.com/2010-04-01/Messages.json?To=%2B1...00',
      'http.target': '/2010-04-01/Messages.json?To=%2B1...00',
    });
  });
  it('never throws on malformed request objects (no-op-safe)', () => {
    expect(maskIncomingSpanAttributes({} as never)).toEqual({});
    expect(maskOutgoingSpanAttributes(undefined as never)).toEqual({});
  });
});
```

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement in otel.ts.** The hook option types accept
`(request) => Attributes`; type the parameters LOOSELY and defensively -
the instrumentation hands `http.IncomingMessage` / `http.RequestOptions`
whose fields can be `string | string[] | null | undefined`, so every read
below is guarded (review: a tight interface here is a compile error at the
wiring):

```ts
import { maskPhonesInText } from './phone.js';
import type { Attributes } from '@opentelemetry/api';

// SPAN URL MASKING (log-hygiene spec section 4). Hook attributes are
// Object.assign'd LAST by the instrumentation, so a masked value OVERWRITES
// the raw one. SEMCONV: the instrumentation emits the OLD family
// (http.url/http.target) by default and the stable url.* family only under
// OTEL_SEMCONV_STABILITY_OPT_IN - emitting a key the active mode never sets
// would FABRICATE it, so the stable keys are gated on that env. No-op-safe:
// any failure returns {} and the span exports with raw attributes rather
// than not at all (the log sinks are masked independently).

function stableSemconvActive(): boolean {
  const v = process.env['OTEL_SEMCONV_STABILITY_OPT_IN'];
  return typeof v === 'string' && v.includes('http');
}

export function maskIncomingSpanAttributes(request: unknown): Attributes {
  try {
    const req = request as { url?: unknown; headers?: { host?: unknown } };
    if (typeof req?.url !== 'string' || req.url.length === 0) return {};
    const masked = maskPhonesInText(req.url);
    const host = typeof req.headers?.host === 'string' ? req.headers.host : 'localhost';
    const out: Record<string, string> = {
      'http.url': `http://${host}${masked}`,
      'http.target': masked,
    };
    if (stableSemconvActive()) {
      const q = masked.indexOf('?');
      out['url.path'] = q === -1 ? masked : masked.slice(0, q);
      if (q !== -1) out['url.query'] = masked.slice(q + 1);
    }
    return out;
  } catch {
    return {};
  }
}

export function maskOutgoingSpanAttributes(request: unknown): Attributes {
  try {
    const req = request as { host?: unknown; hostname?: unknown; path?: unknown; protocol?: unknown };
    if (typeof req?.path !== 'string' || req.path.length === 0) return {};
    const path = maskPhonesInText(req.path);
    const host =
      typeof req.hostname === 'string' && req.hostname.length > 0
        ? req.hostname
        : typeof req.host === 'string' && req.host.length > 0
          ? req.host
          : 'unknown';
    const protocol = typeof req.protocol === 'string' ? req.protocol : 'https:';
    const full = `${protocol}//${host}${path}`;
    const out: Record<string, string> = { 'http.url': full, 'http.target': path };
    if (stableSemconvActive()) out['url.full'] = full;
    return out;
  } catch {
    return {};
  }
}
```

Wire at the construction:
```ts
    instrumentations: [
      new HttpInstrumentation({
        startIncomingSpanHook: maskIncomingSpanAttributes,
        startOutgoingSpanHook: maskOutgoingSpanAttributes,
      }),
      new ExpressInstrumentation(),
    ],
```
If the option names differ in the installed version, check
`node_modules/@opentelemetry/instrumentation-http/build/src/types.d.ts`
(they were review-verified present) and adapt the wiring only.

- [ ] **Step 4: Run green (`npx vitest run test/otel.test.ts`), typecheck, commit:**

```bash
git status
git add app/src/lib/otel.ts app/test/otel.test.ts
git commit -m "feat(pii): mask phone-bearing URL attributes on http spans (semconv-aware)" -- app/src/lib/otel.ts app/test/otel.test.ts
```

---

### Task 8: System-SID markers - TTL, debug downgrade, persist:false legs

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (putSystemSidMarker - locate by
  the function name)
- Modify: `app/src/services/relayAnnouncements.ts` (per-member send loop)
- Modify: `app/src/lib/tables.ts` (the messages-table TTL-family comment at
  ~:213-223)
- Test: grep `putSystemSidMarker` under app/test; extend the file(s) that
  cover it (verification-SMS coverage exists - `grep -rln putSystemSidMarker
  app/test`); for the announcement half, grep `sendRelayAnnouncement` under
  app/test and extend that suite. If either has NO existing coverage,
  create `app/test/systemSidMarker.test.ts` using the messagesRepo
  integration harness pattern (copy the harness from any
  `*.integration.test.ts` that builds `createMessagesRepo`).

**Interfaces:** none new.

- [ ] **Step 1: Failing tests**

(a) marker TTL: after `putSystemSidMarker('SMx', 'relay.intro')`, read the
raw item (doc client Get on the syssid key - copy the key shape from
`getSystemSidMarker`) and assert `typeof Item.expires_at === 'number'` and
`Item.expires_at` is within [now/1000 + 29d, now/1000 + 31d] in SECONDS.
(b) debug downgrade: with an injected logger fake
(`createMessagesRepo({ logger: fake })` - RepoDeps.logger exists), assert
`fake.info` was NOT called with the marker message and `fake.debug` WAS.
Build the fake as `{ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }`
cast to Logger - check how neighboring repo tests fake loggers first and
copy that shape.
(c) relayAnnouncements persist:false: with a fake messagesRepo + adapter
(copy the suite's existing fakes), a successful send calls
`putSystemSidMarker(result.providerSid, kind)`; a REJECTED
putSystemSidMarker logs WARN, does NOT mark the send failed, does NOT
reduce sentCount; with persist:true NO marker is written.

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement.**

messagesRepo `putSystemSidMarker` becomes:
```ts
    async putSystemSidMarker(providerSid, kind) {
      // 30-day TTL, EPOCH SECONDS (the messages table's TTL attribute is
      // expires_at; DynamoDB TTL silently ignores non-numeric values, so an
      // ISO string here would never fire). syssid# markers are read-only
      // acks with NO consume step - TTL is deliberately their ONLY reaper
      // (log-hygiene spec section 5). Rows written before this change carry
      // no TTL and persist; the count is tiny (cell verifications).
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
      // debug, not info: the dev intro replay writes one per member per
      // boot - a log-hygiene change must not trade an ERROR for an INFO.
      log.debug({ providerSid, kind }, 'system-send SID marker written');
    },
```

relayAnnouncements - inside the per-member `try`, immediately after
`sentCount += 1;` and before the `if (persist && tsMsgId !== undefined)`
block:

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

tables.ts TTL-family comment: (1) soften the universal - the sentence
"each with its own authoritative consume step - TTL is only the backstop"
becomes "each (except syssid#, below) with its own authoritative consume
step - TTL is only the backstop"; (2) append the fourth family:

```
   - syssid# system-send SID markers (messagesRepo.putSystemSidMarker):
     READ-ONLY acks with NO consume step - getSystemSidMarker never
     deletes. TTL (30d) is deliberately their ONLY reaper; the stated
     exception to the rule above (log-hygiene spec 2026-08-24). Rows
     written before 2026-08 carry no expires_at and persist; the count is
     tiny.
```

- [ ] **Step 4: Run green + neighbors + typecheck.** Run the touched
suites plus `npx vitest run test/twilioStatusWebhook.test.ts` (the webhook
marker->INFO branch is untouched and must stay green). Then perform spec
section 5's verification: re-grep `\.sendMessage\(` under app/src - the
four known sites plus `groupConversations.postGroupMessage` (Conversations
rail, different webhook, out of scope) must be the complete set; record the
proof in the build report.

- [ ] **Step 5: Commit** (stage the exact test files you touched):

```bash
git status
git add app/src/repos/messagesRepo.ts app/src/services/relayAnnouncements.ts app/src/lib/tables.ts
git add <the test files you extended or created>
git commit -m "feat(relay): system-SID markers for persist:false legs + 30d TTL + debug downgrade" -- app/src/repos/messagesRepo.ts app/src/services/relayAnnouncements.ts app/src/lib/tables.ts <same test files>
```

---

### Task 9: pushService refresh-attempt floor

**Files:**
- Modify: `app/src/services/pushService.ts` (sendToAll refresh block;
  declarations near `usersCache`)
- Test: extend `app/test/pushService.test.ts`

**Interfaces:**
- Consumes: the existing `deps.now` clock seam (already used by tests).

- [ ] **Step 1: Failing tests.** Drive with the fake clock and assert on
BEHAVIOR (listAll call counts + returned tallies + warn/error call
absence), NOT on debug lines - the existing harness captures at info level
and the new floor lines are debug by design:

(a) listAll fails once; a second sendToAll 10s later does NOT call listAll
again (`listAll` fake called exactly once) and fans out to the cached list
(non-zero attempted), with NO second warn/error logged;
(b) a third call 31s after the failed attempt DOES call listAll again;
(c) with NO cache ever fetched and repeated failures inside the floor:
first call logs ERROR (existing behavior) and returns zeroed; second call
10s later returns zeroed WITHOUT calling listAll and WITHOUT a second
error log;
(d) after a SUCCESSFUL refresh, a call made past the 60s cache TTL
attempts listAll immediately (the floor never delays a post-success
refresh, because the floor stamp is older than the TTL by then).

- [ ] **Step 2: Run red** (the floor does not exist: call counts differ).

- [ ] **Step 3: Implement.** Next to `usersCache`:

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

Refresh block restructure:

```ts
      if (usersCache === undefined || now() - usersCache.fetchedAt >= USERS_CACHE_TTL_MS) {
        const floored =
          lastRefreshAttemptAt !== undefined && now() - lastRefreshAttemptAt < REFRESH_RETRY_FLOOR_MS;
        if (!floored) {
          lastRefreshAttemptAt = now();
          try {
            usersCache = { items: await users.listAll(), fetchedAt: now() };
          } catch (err) {
            // ...the existing three-arm catch body stays EXACTLY as it is...
          }
        } else {
          // Inside the floor after a failed attempt: the window-opening line
          // already told the operator. Serve the cache when it is inside the
          // stale bound; otherwise drop quietly (debug, not warn/error).
          if (usersCache === undefined || now() - usersCache.fetchedAt >= STALE_SERVE_MAX_MS) {
            log.debug({ kind: notification.kind }, 'push: refresh floored and no servable cache - broadcast dropped');
            return { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
          }
          log.debug({ kind: notification.kind }, 'push: refresh floored - fanning out to the cached list');
        }
      }
```

TS NARROWING (review): the floored no-cache arm must EARLY-RETURN exactly
as shown or the later `usersCache.items` read loses narrowing. The
existing catch arms (levels, `fetchedAt` semantics) are pinned by existing
tests - do not touch them. NOTE case (a): the existing catch's stale-serve
WARN fires on the FAILED attempt itself; the floor only silences the
SUBSEQUENT calls - assert counts accordingly.

- [ ] **Step 4: Run green (`npx vitest run test/pushService.test.ts`), typecheck, commit:**

```bash
git status
git add app/src/services/pushService.ts app/test/pushService.test.ts
git commit -m "feat(push): 30s retry floor on the users-list refresh - one alarm per window, not per message" -- app/src/services/pushService.ts app/test/pushService.test.ts
```

---

### Task 10: Voice push identity (role kept + full identity)

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` - replace `pushCallerLabel`
  with an EXPORTED `pushCallerIdentity`; update its three consumer sites
  (pre-ring; sendMissedCallPush; sendVoicemailPush)
- Test: `app/test/founderTriage.test.ts` (assertion updates + three new
  unit cases + one new voicemail-body case).
  `app/test/voiceRecording.test.ts` is NOT touched (review-verified its
  assertions stay green).

**Interfaces:**
- Consumes: `contactDisplayName` (app/src/lib/contactName.ts),
  `roleWordForContact` + `UNKNOWN_CALLER_LABEL` (app/src/lib/voiceMasking.ts),
  `formatPhoneForDisplay` (app/src/lib/phone.ts), `contacts.findByPhone`,
  `ContactItem`, `ConversationItem` (types already imported in voice.ts -
  verify).
- Produces: `export function pushCallerIdentity(contact, conversation,
  phone): string` (exported for direct unit tests).

- [ ] **Step 1: New unit cases first (red).** In founderTriage.test.ts (or
a new `app/test/pushCallerIdentity.test.ts` importing from
`../src/routes/webhooks/voice.js` - check that import does not drag heavy
router construction; if it does, put the cases in founderTriage.test.ts
which already imports the module):

```ts
describe('pushCallerIdentity', () => {
  const tenant = { contactId: 'c1', type: 'tenant', firstName: 'Jane', lastName: 'Doe' } as never;
  const namelessTenant = { contactId: 'c2', type: 'tenant' } as never;
  it('known, named: role + full name', () => {
    expect(pushCallerIdentity(tenant, undefined, '+15550177777')).toBe('Tenant - Jane Doe');
  });
  it('known, nameless: role + formatted number (never less than today)', () => {
    expect(pushCallerIdentity(namelessTenant, undefined, '+15550177777')).toBe('Tenant - (555) 017-7777');
  });
  it('an EMPTY participant_display_name is skipped, not selected', () => {
    const conv = { participant_display_name: '' } as never;
    expect(pushCallerIdentity(undefined, conv, '+15550177777')).toBe('(555) 017-7777');
  });
  it('terminal fallback: never empty, never undefined', () => {
    expect(pushCallerIdentity(undefined, undefined, undefined)).toBe('Unknown caller');
  });
});
```

Then update the FOUR existing assertions to the new copy (re-locate each by
its quoted string; the fixture contact is Jane Doe, a tenant):
- pre-ring known body: `'Incoming call <DASH> Tenant - Jane Doe'` where
  <DASH> is the file's EXISTING em-dash separator at that assertion - copy
  it from the file, never retype it. Only the label half changes.
- pre-ring unknown-caller case: outcome UNCHANGED (formatted number in the
  payload, number absent from logs) - re-run and only adjust if the
  conversation fixture carries a display name (then the expected label is
  that name - decide from the fixture, and note it in the build report).
- missed-call body assertions (two): `'Missed call <DASH> Tenant - Jane Doe'`
  (same copied-dash rule).
- NEW voicemail-body case (copy the missed-call harness): asserts
  `payload.body === 'New voicemail - Tenant - Jane Doe'` (this line's
  existing separator is an ASCII hyphen at the source - verify at the
  sendVoicemailPush body template and match exactly; the doubled
  " - " separator in the label is deliberate and accepted).

Run: `cd app && npx vitest run test/founderTriage.test.ts` -> RED.

- [ ] **Step 2: Implement.** Replace the `pushCallerLabel` function block
with (exported; add the `contactDisplayName` import):

```ts
/**
 * The PUSH-ONLY caller label (log-hygiene spec section 7; operator ruling
 * D4 2026-08-16 + role-word amendment 2026-08-25): staff-facing pushes carry
 * FULL caller identity like a native phone app - lock-screen privacy is the
 * DEVICE's job. The ROLE word is kept (load-bearing context on a call); the
 * identity half is the message pushes' naming chain plus a terminal fallback
 * so the label is never empty or undefined.
 *
 * The STORED call_party_label, the whisper, thread rendering, and the
 * outbound originate path all keep the masked posture (voiceMasking.ts) -
 * this label exists ONLY in the ephemeral push payload. Logs never carry it.
 * Exported for direct unit tests.
 */
export function pushCallerIdentity(
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

Consumer sites:
- Pre-ring: the `pushCallerLabel(callerLabel, From)` call becomes
  `pushCallerIdentity(callerContact, conversation, From)` (both in scope -
  verify against the surrounding code; `conversation` is the
  createOrGetByParticipantPhone result).
- sendMissedCallPush: replace the storedLabel + pushCallerLabel block with:

```ts
    const conversation = await conversations.getById(conversationId);
    // Best-effort contact resolve for the full name; any failure falls
    // through the chain to the number.
    let callerContact: ContactItem | undefined;
    const callerPhone = conversation?.participant_phone;
    if (typeof callerPhone === 'string' && callerPhone.length > 0) {
      try {
        callerContact = (await contacts.findByPhone(callerPhone)) ?? undefined;
      } catch {
        callerContact = undefined;
      }
    }
    const callerLabel = pushCallerIdentity(callerContact, conversation, callerPhone);
```

  Remove the now-unused `messages.getByProviderSid(callSid)` read and
  `storedLabel` IF nothing else in the function uses `entry` (check;
  the quick-replies block does not).
- sendVoicemailPush: identical replacement.
- Rewrite the doc comments on both send functions (they assert the masked
  posture as current law - cite D4 + the 2026-08-25 role-word amendment,
  as the new helper's comment does).
- Check `UNKNOWN_CALLER_LABEL` is still used somewhere in voice.ts after
  the edit; if the import goes unused, the new helper uses it - it will
  not.

- [ ] **Step 3: Run green + typecheck**

`cd app && npx vitest run test/founderTriage.test.ts test/voiceRecording.test.ts`
Expected: founderTriage PASS with the new copy; voiceRecording PASS
UNCHANGED (a red there means you changed behavior the spec excludes - stop
and re-check).

- [ ] **Step 4: Commit**

```bash
git status
git add app/src/routes/webhooks/voice.ts app/test/founderTriage.test.ts
git commit -m "feat(voice): push labels carry role + full identity (D4 + role-word amendment)" -- app/src/routes/webhooks/voice.ts app/test/founderTriage.test.ts
```

(Stage pushCallerIdentity.test.ts too if you created it.)

---

### Task 11: ai-runs `unavailable` state

**Files:**
- Modify: `app/src/repos/aiRunsRepo.ts` (batchGetRuns; the AiRunListEntry
  union; the listByEntity mapping)
- Modify: `app/src/routes/aiRuns.ts` (the expired serialization arm)
- Modify: `dashboard/src/api/types.ts` (AiRunListRow)
- Modify: `dashboard/src/routes/settings/aiRuns/AiRunList.tsx` (expired row)
- Modify (only if red): `app/test/aiRunsRepo.test.ts`,
  `app/test/aiRunsRepo.integration.test.ts`, `app/test/aiRunsApi.test.ts`,
  `dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx`,
  `dashboard/src/routes/settings/aiRuns/useAiRuns.test.ts`

**Interfaces:**
- Produces (server AND wire - the two move together):
  `{ runId: string; sortKey: string; expired: true; unavailable?: true }`
  as the SINGLE non-live union member (optional discriminant; two separate
  members do NOT typecheck at the truthiness-narrowed renderers).

- [ ] **Step 1: Failing repo test** (fake doc client, copy the file's
existing fake pattern): a BatchGet whose UnprocessedKeys echo two
`run#`-prefixed keys on EVERY attempt yields, after the 4-attempt budget,
listByEntity entries `{ expired: true, unavailable: true }` for those
runIds; a genuinely-absent runId maps to `{ expired: true }` with NO
`unavailable` key; found runs unaffected. Plus cross-chunk accumulation:
150 keys where chunk 2's leftovers persist -> both chunks' leftovers
reported.

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement.**

Union:
```ts
export type AiRunListEntry =
  | { runId: string; sortKey: string; expired: false; run: AiRunRecord }
  | { runId: string; sortKey: string; expired: true; unavailable?: true };
```
Near `runItemId` add the inverse:
```ts
export const runIdOfItemId = (itemId: string): string => itemId.slice('run#'.length);
```
`batchGetRuns` returns
`{ found: Map<string, AiRunRecord>; unprocessedRunIds: Set<string> }`:
declare `const unprocessedRunIds = new Set<string>();` beside `found`;
after each chunk's attempt loop,
`for (const k of keys) unprocessedRunIds.add(runIdOfItemId(k.itemId));`
(replacing the `unprocessed += keys.length` counter; the once-per-call WARN
keys on `unprocessedRunIds.size`). Grep the file for other `batchGetRuns`
callers and destructure at each.

listByEntity mapping:
```ts
      const { found: byRunId, unprocessedRunIds } = await batchGetRuns(pointers.map((p) => p.runId));
      const entries: AiRunListEntry[] = pointers.map((p) => {
        const run = byRunId.get(p.runId);
        if (run !== undefined) return { runId: p.runId, sortKey: p.sortKey, expired: false, run };
        // Unprocessed-after-4-attempts is sustained pressure, NOT a TTL
        // reap - the forensic surface must not call a throttled row expired.
        return unprocessedRunIds.has(p.runId)
          ? { runId: p.runId, sortKey: p.sortKey, expired: true, unavailable: true }
          : { runId: p.runId, sortKey: p.sortKey, expired: true };
      });
```

routes/aiRuns.ts expired arm (house `!== undefined` spread form):
```ts
        ? { runId: entry.runId, sortKey: entry.sortKey, expired: true as const,
            ...(entry.unavailable !== undefined && { unavailable: true as const }) }
```

dashboard types.ts:
```ts
export type AiRunListRow = AiRunListRowLive | { runId: string; sortKey: string; expired: true; unavailable?: true };
```

AiRunList.tsx expired branch (the `row.expired ?` ternary):
```tsx
        {rows.map((row) => row.expired ? <li key={row.runId} className={styles.expired}>{row.unavailable ? `Run ${row.runId} temporarily unavailable - reload the page to retry` : `Expired run ${row.runId}`}</li> : <li key={row.runId}>
```
("reload the page" means the BROWSER - deliberately NO new button: a third
button breaks the e2e one-button-per-row pin and the singular Retry query,
and useAiRuns.retry() resets to page 1.)

- [ ] **Step 4: Route + dashboard tests.** Add: a route case asserting the
serialized unavailable row; a dashboard component case asserting the
unavailable row's text renders and is NOT a button
(`queryByRole('button', ...)` inside that li is null). Run the five
pinning files + the two new cases; review verified the existing assertions
tolerate the optional key - a red there is unexpected, investigate before
editing. Then `npm run typecheck` (covers dashboard too - verify the root
script includes the dashboard workspace; if not, run
`cd dashboard && npx tsc --noEmit` as well).

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/repos/aiRunsRepo.ts app/src/routes/aiRuns.ts dashboard/src/api/types.ts dashboard/src/routes/settings/aiRuns/AiRunList.tsx
git add <touched test files>
git commit -m "feat(ai-runs): distinct unavailable row state for throttled BatchGet leftovers" -- app/src/repos/aiRunsRepo.ts app/src/routes/aiRuns.ts dashboard/src/api/types.ts dashboard/src/routes/settings/aiRuns/AiRunList.tsx <same test files>
```

---

### Task 12: Abandoned-journal sweep

**Files:**
- Modify: `app/src/repos/settingsRepo.ts`
- Modify: `app/src/repos/suggestionResolutionRepo.ts`
- Modify: `app/src/services/suggestionResolution.ts`
- Create: `app/src/jobs/journalSweep.ts`
- Modify: `app/src/worker.ts`
- Modify: `app/src/routes/dev.ts` (+ DevRouterDeps)
- Tests: `app/test/journalSweep.test.ts` (new); extend the settingsRepo
  coverage (grep `claimGroupPeriod` under app/test for the file) and the
  suggestionResolution coverage (grep `recoverAbandoned` under app/test).

**Interfaces (all produced here, consumed here and by tests):**
- settingsRepo: `JOURNAL_SWEEP_LAST_RUN_AT_ID = 'journal_sweep_last_run_at'`
  added to the `GroupPeriodRecordId` union;
  `getJournalSweepCursor(): Promise<string | undefined>` and
  `putJournalSweepCursor(cursor: string | undefined): Promise<void>`
  (undefined = clear) on a dedicated record `journal_sweep_scan_cursor`
  with a `cursor` string attribute.
- suggestionResolutionRepo:
  `listActiveResolutionRows(opts: { cursor?: string; limit: number }):
  Promise<{ rows: Array<{ contactId: string; target: string;
  leaseExpiresAt: string; claimedAt: string }>; nextCursor?: string }>` -
  ONE Scan page: `FilterExpression: 'begins_with(#id, :p) AND #state = :active'`,
  names `{ '#id': 'itemId', '#state': 'state' }` (`state` is reserved),
  values `{ ':p': 'resolve#', ':active': 'active' }`, `Limit: opts.limit`,
  `ExclusiveStartKey: JSON.parse(opts.cursor)` when present, `nextCursor:
  JSON.stringify(LastEvaluatedKey)` when present. NO age filter server-side
  (the age gate is app-side so fail-toward-scrub is implementable).
  Confirm `listJournals(contactId)` is on the exported repo interface (it
  is used by the service); if not exported, export it.
- suggestionResolution service:
  `recoverAbandoned(contactId: string, opts?: { maxAttempts?: number })` -
  default 2 (MAX_RECOVERIES_PER_READ; read path unchanged).
- journalSweep.ts: `runJournalSweep(nowIso, deps?, opts?)` + the constants
  from Global Constraints + `SWEEP_MAX_ATTEMPTS_PER_CALL = 12`.

- [ ] **Step 1: settingsRepo (TDD).** Failing tests: the new period id
claims independently of the four group ids (existing claim tests show the
harness); cursor round-trips (put string -> get; put undefined -> get
undefined). Implement the constant + union member + the two methods
(Get/Put on the settings table; putJournalSweepCursor(undefined) issues a
Delete or REMOVEs the attribute - either, tested). Run green; typecheck;
commit (`feat(settings): journal-sweep cadence id + scan cursor record`,
explicit paths).

- [ ] **Step 2: listActiveResolutionRows (TDD, integration).** Copy the
harness of an existing suggestionResolutionRepo integration test. Seed one
ACTIVE journal (via the repo's own `claim()`), one COMPLETED (claim then
complete), plus a `sugg#` row (extractionRepo.putSuggestion or a raw Put
copying the test harness); assert a full-page call returns ONLY the active
row's projection; with `limit: 1` and 2 active journals, `nextCursor`
round-trips through a second call to reach the second row. Implement. Run
green; typecheck; commit.

- [ ] **Step 3: recoverAbandoned maxAttempts (TDD).** Failing test: 3
lease-expired journals whose takeovers all fail -> default stops after 2
attempts; with `{ maxAttempts: 12 }` all 3 attempted. Implement:
`async recoverAbandoned(contactId, opts) {` ... replace the budget
comparison with `const budget = opts?.maxAttempts ?? MAX_RECOVERIES_PER_READ;`
/ `if (attempted >= budget) break;` and widen the interface signature +
JSDoc. Run green (`npx vitest run` on the file that covers
recoverAbandoned - grep found it in Step 0); typecheck; commit.

- [ ] **Step 4: journalSweep.ts (TDD with fakes).** Failing tests in
`app/test/journalSweep.test.ts` (plain object fakes for the four deps):
1. cadence: claim -> false: nothing runs, outcome.ran false. force: true
   -> notBefore = now -> runs.
2. app-side age gate: lease-expired row claimed 1h ago does NOT qualify;
   25h ago DOES; claimedAt 'garbage' DOES (fail-toward-scrub).
3. contact dedup: 12 rows for one contact -> ONE contact visited.
4. contact cap mid-page: a page with 30 qualifying contacts -> 25 visited,
   deferral logged INFO (assert `info` fake called with the deferral
   message), and the persisted cursor is the cursor that LED INTO that page
   (re-examined next run), not past it.
5. clean exhaustion: pages run out -> putJournalSweepCursor(undefined).
6. recovery loop + SSE: recoverAbandoned returns {recovered:2,
   stateChanged:true} then {recovered:0, stateChanged:false} -> called
   twice with `{ maxAttempts: 12 }`, ONE `suggestion.updated` emit.
7. budget exhaustion: MAX_RECOVERY_CALLS_PER_RUN reached mid-contact ->
   outer loop stops, remaining contacts NOT visited, NO persistent-actives
   ERROR for them, deferral INFO logged.
8. truth check: post-loop listJournals shows a still-active, lease-expired,
   past-age journal -> ERROR with counts; listJournals THROWS -> WARN, not
   silent, not ERROR.
9. body throw (listActiveResolutionRows rejects) -> ERROR logged, promise
   RESOLVES (never rejects to the poll), cadence already stamped.

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
// persisted so caps DEFER work rather than orphaning it. The cursor only
// advances past pages whose qualifying rows were all COLLECTED - a page cut
// short by the contact cap is re-examined next run (idempotent: recovered
// journals are no longer active).
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
import { createContactsRepo } from '../repos/contactsRepo.js';
import { createExtractionRepo } from '../repos/extractionRepo.js';
import { createAiRunsRepo } from '../repos/aiRunsRepo.js';
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

function buildDefaultService(log: Logger): SuggestionResolutionService {
  // The exact construction routes/suggestions.ts uses (its factory needs
  // all four repos; the seams default).
  return createSuggestionResolutionService({
    contactsRepo: createContactsRepo({ logger: log }),
    extractionRepo: createExtractionRepo({ logger: log }),
    aiRunsRepo: createAiRunsRepo({ logger: log }),
    resolutionRepo: createSuggestionResolutionRepo({ logger: log }),
    logger: log,
  });
}

export async function runJournalSweep(
  nowIso: string,
  deps: JournalSweepDeps = {},
  opts: { force?: boolean } = {},
): Promise<JournalSweepOutcome> {
  const log = deps.logger ?? defaultLogger;
  const outcome: JournalSweepOutcome = { ran: false, contactsVisited: 0, recovered: 0, deferred: false, persistentContacts: 0 };
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: log });
  const now = new Date(nowIso).toISOString();
  const nowMs = Date.parse(now);
  // Claim OUTSIDE the body's catch: a claim-throw propagates to the poll
  // loop's ordinary swallow (the groupGuardrails shape) instead of minting
  // a daily alarm out of a DynamoDB blip on every 30s poll.
  const notBefore = opts.force === true ? now : new Date(nowMs - JOURNAL_SWEEP_PERIOD_MS).toISOString();
  if (!(await settings.claimGroupPeriod(JOURNAL_SWEEP_LAST_RUN_AT_ID, now, notBefore))) return outcome;
  outcome.ran = true;
  try {
    const repo = deps.resolutionRepo ?? createSuggestionResolutionRepo({ logger: log });
    const service = deps.resolutionService ?? buildDefaultService(log);
    const events = deps.events ?? appEvents;

    // Enumerate: cursor-resumed pages, APP-SIDE age gate (a server-side
    // FilterExpression could never see an excluded row, so fail-toward-scrub
    // would be unimplementable, and a non-ISO claimedAt would be decided by
    // ASCII ordering).
    const qualifies = (row: { leaseExpiresAt: string; claimedAt: string }): boolean => {
      if (Date.parse(row.leaseExpiresAt) > nowMs) return false; // live lease
      const claimedMs = Date.parse(row.claimedAt);
      // Unparseable -> NaN -> comparison false -> QUALIFIES (fail-toward-scrub).
      return !(Number.isFinite(claimedMs) && nowMs - claimedMs < JOURNAL_SWEEP_MIN_AGE_MS);
    };
    const contacts: string[] = [];
    const seen = new Set<string>();
    let cursor = await settings.getJournalSweepCursor();
    let pages = 0;
    let exhausted = false;
    let pageCutShort = false;
    while (pages < MAX_SCAN_PAGES) {
      const cursorBeforePage = cursor;
      const page = await repo.listActiveResolutionRows({ ...(cursor !== undefined && { cursor }), limit: SCAN_PAGE_LIMIT });
      pages += 1;
      for (const row of page.rows) {
        if (!qualifies(row)) continue;
        if (seen.has(row.contactId)) continue;
        if (contacts.length >= MAX_CONTACTS_PER_RUN) {
          // This page holds qualifying work we cannot take - the cursor must
          // NOT advance past it, or the dropped rows wait a full table cycle.
          pageCutShort = true;
          cursor = cursorBeforePage;
          break;
        }
        seen.add(row.contactId);
        contacts.push(row.contactId);
      }
      if (pageCutShort) break;
      cursor = page.nextCursor;
      if (cursor === undefined) { exhausted = true; break; }
    }
    await settings.putJournalSweepCursor(exhausted ? undefined : cursor);

    let calls = 0;
    let budgetExhausted = false;
    for (const contactId of contacts) {
      if (calls >= MAX_RECOVERY_CALLS_PER_RUN) { budgetExhausted = true; break; }
      outcome.contactsVisited += 1;
      let stateChanged = false;
      let completedCleanly = false;
      for (;;) {
        if (calls >= MAX_RECOVERY_CALLS_PER_RUN) { budgetExhausted = true; break; }
        calls += 1;
        const result = await service.recoverAbandoned(contactId, { maxAttempts: SWEEP_MAX_ATTEMPTS_PER_CALL });
        outcome.recovered += result.recovered;
        stateChanged = stateChanged || result.stateChanged;
        if (result.recovered === 0) { completedCleanly = true; break; }
      }
      if (stateChanged) events.emit('suggestion.updated', { contactId });
      if (!completedCleanly) continue; // budget cut - deferral, not poison
      // POST-LOOP TRUTH CHECK on the contact's closed 12-key journal set.
      // Persistent actives past the gate = poison journals nothing will
      // scrub without attention -> ERROR (alarm). A failed READ here is
      // WARN - loud, not silent, not a false poison alarm.
      try {
        const journals = await repo.listJournals(contactId);
        const remaining = journals.filter(
          (j) => j.state === 'active' && qualifies({ leaseExpiresAt: j.leaseExpiresAt, claimedAt: j.claimedAt }),
        );
        if (remaining.length > 0) {
          outcome.persistentContacts += 1;
          log.error(
            { contactId, remaining: remaining.length },
            'journal sweep: journals still active after recovery - persistent failure, will retry tomorrow',
          );
        }
      } catch (err) {
        log.warn({ err, contactId }, 'journal sweep: truth-check read failed (best-effort)');
      }
    }

    outcome.deferred = pageCutShort || !exhausted || budgetExhausted || contacts.length >= MAX_CONTACTS_PER_RUN;
    if (outcome.deferred) {
      // Routine rate limiting - the cursor carries the progress. INFO, never
      // ERROR: a standing daily alarm nothing can clear is the exact noise
      // class this mission removes.
      log.info(
        { contactsVisited: outcome.contactsVisited, pages, exhausted, budgetExhausted },
        'journal sweep: work deferred to the next run (caps/pages) - cursor persisted',
      );
    }
    log.info(
      { contactsVisited: outcome.contactsVisited, recovered: outcome.recovered, persistentContacts: outcome.persistentContacts },
      'journal sweep: run complete',
    );
    return outcome;
  } catch (err) {
    // The cadence record is already stamped (claim-first IS the cross-process
    // dedup) - a failure here waits until tomorrow or a force tick. Accepted
    // ON CONDITION it is loud (alarm-feeding).
    log.error({ err }, 'journal sweep: run failed - next natural retry is tomorrow (or a force tick)');
    return outcome;
  }
}
```

(TYPE CHECK the `listJournals` element shape: the service filters
`j.state !== 'active'` on the same items, so the union has `state`,
`leaseExpiresAt`, `claimedAt` on the active member - narrow with
`j.state === 'active'` FIRST as shown so `claimedAt` is present. If the
completed member lacks those fields the filter as written narrows
correctly; adjust only if tsc disagrees.)

- [ ] **Step 5: worker + dev tick.**
worker.ts, after the group-guardrail poll block:
```ts
// Abandoned-journal sweep (log-hygiene spec section 9): daily cadence behind
// a settings-record claim; the poll itself is the shared interval.
{
  const { runJournalSweep } = await import('./jobs/journalSweep.js');
  startPoll('journal sweep', (now) => runJournalSweep(now, { logger }));
}
```
dev.ts: add `journalSweepDeps?: JournalSweepDeps` to DevRouterDeps (import
the type from `../jobs/journalSweep.js`) and the route, modeled on the
group-guardrails tick above it:
```ts
  // POST /__dev/journal-sweep/tick { now?, force? } - app-side driver for
  // the abandoned-journal sweep (A16: worker logs never reach /__dev/logtail
  // and the worker shares the cadence record - force defaults TRUE, same
  // rationale as the group-guardrails tick).
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
(Add the `runJournalSweep` import beside the other job imports in dev.ts.)

- [ ] **Step 6: Run the new suite + the app suite + typecheck; commit:**

```bash
git status
git add app/src/jobs/journalSweep.ts app/src/worker.ts app/src/routes/dev.ts app/src/repos/settingsRepo.ts app/src/repos/suggestionResolutionRepo.ts app/src/services/suggestionResolution.ts app/test/journalSweep.test.ts
git add <the settingsRepo / suggestionResolution test files you extended>
git commit -m "feat(extraction): daily abandoned-journal sweep - cursor-resumed scan + recovery budget widening" -- app/src/jobs/journalSweep.ts app/src/worker.ts app/src/routes/dev.ts app/src/repos/settingsRepo.ts app/src/repos/suggestionResolutionRepo.ts app/src/services/suggestionResolution.ts app/test/journalSweep.test.ts <same test files>
```

---

### Task 13: Issue-file mutations + docs

**Files:**
- Modify (resolved stamps, `status: resolved` + a dated resolution note
  naming the branch and mechanism):
  `docs/issues/twilio-sdk-error-logs-leak-credentials.md`,
  `docs/issues/telemetry-phone-in-url-pii.md`,
  `docs/issues/relay-intro-dlr-unknown-sid-noise.md` (+ stale-production
  note), `docs/issues/relay-direct-sends-unknown-sid-callbacks.md` (same),
  `docs/issues/push-users-scan-failure-logs-error-per-message.md`,
  `docs/issues/push-failure-status-not-surfaced.md`,
  `docs/issues/voice-push-pii-masking-outdated.md`,
  `docs/issues/ai-runs-throttled-batchget-renders-expired.md`,
  `docs/issues/abandoned-journal-pii-until-next-contact-read.md` (decision
  reversal + constants).
- Create: `docs/issues/phone-in-url-paths-structural.md` (copy
  `docs/issues/_TEMPLATE.md`; low; the SIX-route surface list from spec
  section 4).
- Modify: `docs/issues/consolidate-contact-display-name-helpers.md` (one
  line: voice pushes are a second push-copy consumer).
- Grep `TODO(` for each resolved slug; update/remove inline markers.
- Run `npm run issues` (regenerates the gitignored INDEX - run, never
  commit INDEX.md).

- [ ] Commit:
```bash
git status
git add docs/issues/
git commit -m "docs(issues): resolve the nine C3 issues; re-file the structural phone-in-URL remainder" -- docs/issues/
```

---

### Task 14: Gates + main sync (final, in order)

- [ ] Sync main ONCE: from the worktree `git merge main` - preserve both
  sides' intent; if main moved under the C1 merge and conflicts touch the
  five excluded files, STOP and report rather than resolving unilaterally.
  After the merge, re-run the Task 4 audit grep over files main's advance
  added and close any new error-log sites per the sweep rules (the static
  guard will also catch the literal form).
- [ ] `npm run typecheck` - bare, from the worktree. EXIT 0.
- [ ] `npm test` - bare (DynamoDB Local up). EXIT 0.
- [ ] `npm run smoke` - bare. EXIT 0.
- [ ] `npm run e2e` - bare, hard outer timeout 1500s, NEVER commit while it
  runs. EXIT 0.
- [ ] Gate 5:
  `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
  - if the list is EMPTY, SKIP (never run eslint with no paths); attribute
  errors by BASELINE COMPARISON at the merge base; yours are blocking,
  pre-existing are named in the handback.
- [ ] Handback per the orchestrator manual: per-spec-item table, quoted
  exit codes, the sweep table's CONTENT (it lives in gitignored
  .superpowers/ and dies with the worktree), deviations (the two
  adjudicated ones in Global Constraints + anything new), owed operator
  actions (none expected).
