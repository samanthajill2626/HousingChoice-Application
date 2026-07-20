# Cross-Process Event Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker-process emits reach app-process SSE clients via an authenticated
internal HTTP notify route, with unchanged event names/payloads (zero frontend
change).

**Architecture:** The worker attaches a forwarder to its in-process `appEvents`
bus that fire-and-forgets `POST /internal/events` to the app; the app validates
an HKDF-derived bridge token and re-emits on its own bus, from which the existing
SSE route delivers. Best-effort by construction: 2s timeout, no retry, no queue.

**Tech Stack:** Node 24 built-ins only (`node:crypto` hkdfSync/timingSafeEqual,
global `fetch`, `AbortSignal.timeout`). Express router. Vitest + supertest.
Playwright e2e. NO new dependencies.

**Spec:** docs/superpowers/specs/2026-07-20-event-bridge-design.md (committed in
this worktree). Read it first - it carries the decision record and invariants.

## Global Constraints

- Worktree: w:\tmp\event-bridge, branch feat/event-bridge. Never touch the main
  checkout or other worktrees.
- ASCII-only in every ADDED line (code, comments, tests, docs):
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0.
- Never rewrite source files with PowerShell Get-Content/-replace/Set-Content -
  use the Edit tool.
- Commit discipline: bare `git status` read before EVERY commit; stage EXPLICIT
  paths only; `Co-Authored-By:` trailer naming the authoring model.
- Gates (bare, real exit codes, never piped): `npm run typecheck`, `npm test`,
  `timeout 1500 npm run e2e` (from the worktree only).
- No new runtime deps. If one seems needed, STOP - the design is built-ins-only.
- No infra actions ever (terraform/secrets:push/SSM/deploy/.env.* edits).
- Comment style: match the repo's dense header-comment idiom (see
  app/src/lib/events.ts) - explain constraints, not narration.

## Deviations from the spec (decided at planning, carry into the handback)

1. The e2e harness does NOT lower WORKER_POLL_INTERVAL_MS (spec suggested ~1.5s).
   Reason: existing specs drive extraction/reminder work through in-app dev
   ticks whose clock jumps past the debounce; the worker polls REAL time, so at
   60s cadence tick-vs-worker claim races are ~negligible today - lowering the
   cadence multiplies the race odds against `tick.processed >= 1` assertions in
   existing specs (conversation-fact-extraction, voice-extraction). Instead the
   bridge e2e spec uses an IMMEDIATELY-due row (the /__dev/voice/transcript-fixture
   seam schedules dueAt=now) and waits out one real 60s poll cycle with a
   generous expect timeout. The WORKER_POLL_INTERVAL_MS knob is still added
   (config + worker) for manual QA and future use; the harness leaves it default.
2. A second, fast e2e spec proves the app-side pipe (route auth -> re-emit ->
   SSE wire) in milliseconds by POSTing /internal/events directly from the test
   and reading the browser's EventSource - so the slow cross-process spec is the
   only 60s-class test.

---

### Task 1: Bridged-names array + eventBridge module (worker-side forwarder)

**Files:**
- Modify: `app/src/lib/events.ts` (add APP_EVENT_NAMES next to AppEventMap)
- Create: `app/src/lib/eventBridge.ts`
- Test: `app/test/eventBridge.test.ts`

**Interfaces:**
- Consumes: `EventBus`, `AppEventMap`, `AppEventName` from `lib/events.ts`;
  `Logger` from `lib/logger.ts`.
- Produces (later tasks rely on these EXACT names):
  - `APP_EVENT_NAMES: readonly AppEventName[]` (exported from `lib/events.ts`)
  - `deriveBridgeToken(sessionSecret: string): string` (hex, 64 chars)
  - `attachEventBridge(bus: EventBus, opts: { targetUrl: string; bridgeToken:
    string; originSecret: string; logger: Logger; fetchImpl?: typeof fetch }): void`

- [ ] **Step 1: Add APP_EVENT_NAMES to events.ts with a type-level exhaustiveness lock**

In `app/src/lib/events.ts`, directly below the `AppEventName` type alias:

```typescript
// Every event name, as a VALUE (the bridge + internal route iterate/validate
// at runtime; AppEventMap is types-only). Record<AppEventName, true> makes this
// exhaustive BY CONSTRUCTION: adding an eighth event to AppEventMap without
// listing it here is a compile error - which is what keeps a future event from
// silently missing the cross-process bridge (lib/eventBridge.ts).
const ALL_APP_EVENTS: Record<AppEventName, true> = {
  'conversation.updated': true,
  'message.persisted': true,
  'broadcast.updated': true,
  'placement.updated': true,
  'scheduled.updated': true,
  'tour.updated': true,
  'suggestion.updated': true,
};
export const APP_EVENT_NAMES = Object.keys(ALL_APP_EVENTS) as readonly AppEventName[];
```

- [ ] **Step 2: Write the failing tests**

`app/test/eventBridge.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { APP_EVENT_NAMES, createEventBus } from '../src/lib/events.js';
import { attachEventBridge, deriveBridgeToken } from '../src/lib/eventBridge.js';
import { createLogCapture } from './helpers/logCapture.js';

const OPTS = {
  targetUrl: 'http://127.0.0.1:9999',
  bridgeToken: deriveBridgeToken('test-session-secret'),
  originSecret: 'test-origin-secret',
};

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
}

describe('deriveBridgeToken', () => {
  it('is deterministic, hex, 64 chars, and secret-dependent', () => {
    const a = deriveBridgeToken('secret-a');
    expect(a).toBe(deriveBridgeToken('secret-a'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(deriveBridgeToken('secret-b'));
  });
});

describe('attachEventBridge', () => {
  it('subscribes exactly one listener per AppEventMap name', () => {
    const bus = createEventBus();
    attachEventBridge(bus, { ...OPTS, logger: createLogCapture().logger, fetchImpl: okFetch() });
    expect(APP_EVENT_NAMES).toHaveLength(7);
    for (const name of APP_EVENT_NAMES) {
      expect(bus.listenerCount(name)).toBe(1);
    }
  });

  it('POSTs name+payload to /internal/events with both auth headers', async () => {
    const bus = createEventBus();
    const fetchImpl = okFetch();
    attachEventBridge(bus, { ...OPTS, logger: createLogCapture().logger, fetchImpl });
    bus.emit('suggestion.updated', { contactId: 'c-1' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:9999/internal/events');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-origin-verify']).toBe('test-origin-secret');
    expect(headers['x-bridge-token']).toBe(OPTS.bridgeToken);
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'suggestion.updated',
      payload: { contactId: 'c-1' },
    });
  });

  it('a rejected fetch never throws into the emitter and warns WITHOUT the payload', async () => {
    const bus = createEventBus();
    const capture = createLogCapture();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    attachEventBridge(bus, { ...OPTS, logger: capture.logger, fetchImpl });
    expect(() => bus.emit('suggestion.updated', { contactId: 'pii-guard' })).not.toThrow();
    await vi.waitFor(() => expect(capture.lines('warn')).toHaveLength(1));
    const line = JSON.stringify(capture.lines('warn')[0]);
    expect(line).toContain('suggestion.updated');
    expect(line).not.toContain('pii-guard');
  });

  it('a non-2xx response warns (name only) and never throws', async () => {
    const bus = createEventBus();
    const capture = createLogCapture();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    attachEventBridge(bus, { ...OPTS, logger: capture.logger, fetchImpl });
    bus.emit('tour.updated', { tourId: 't-1', status: 'scheduled' });
    await vi.waitFor(() => expect(capture.lines('warn')).toHaveLength(1));
    const line = JSON.stringify(capture.lines('warn')[0]);
    expect(line).toContain('tour.updated');
    expect(line).toContain('403');
    expect(line).not.toContain('t-1');
  });
});
```

NOTE: check `app/test/helpers/logCapture.ts` for the capture helper's REAL
shape before writing (the devGating tests import `createLogCapture` from it);
adapt `capture.lines('warn')` to its actual API if it differs - the assertions
(one warn line, contains event name + status, never payload values) are the
contract, not the helper call shape.

- [ ] **Step 3: Run tests to verify they fail**

Run (from the worktree root): `npm test -w app -- eventBridge`
Expected: FAIL - `attachEventBridge`/`deriveBridgeToken`/`APP_EVENT_NAMES` not found.

- [ ] **Step 4: Implement app/src/lib/eventBridge.ts**

```typescript
// Cross-process event bridge, WORKER side (spec:
// docs/superpowers/specs/2026-07-20-event-bridge-design.md).
//
// attachEventBridge subscribes one listener per AppEventMap name on the
// worker's in-process bus and fire-and-forgets each emit to the app process's
// POST /internal/events (routes/internal.ts), which re-emits for its SSE
// clients. Best-effort BY DESIGN: 2s timeout, no retry, no queue - SSE is a
// refresh hint; dashboards reconcile via GET. Failures warn with the event
// NAME only (payloads may carry the conversation preview - PII posture, doc
// section 9: never logged).
//
// The bridge token is DERIVED from SESSION_SECRET (HKDF, distinct info label)
// so both processes - which share one .env - agree with ZERO new secret
// material. CloudFront/browsers can never compute it, which is what keeps the
// internal route internal (see routes/internal.ts for the full posture).
import { hkdfSync } from 'node:crypto';
import type { Logger } from './logger.js';
import { APP_EVENT_NAMES, type EventBus } from './events.js';

/** HKDF info label - a distinct subkey purpose, never reused elsewhere. */
const BRIDGE_HKDF_INFO = 'hc-event-bridge';

/** Derive the shared bridge token (hex, 32 bytes) from SESSION_SECRET. */
export function deriveBridgeToken(sessionSecret: string): string {
  return Buffer.from(hkdfSync('sha256', sessionSecret, '', BRIDGE_HKDF_INFO, 32)).toString('hex');
}

export interface AttachEventBridgeOptions {
  /** The app process's base URL (EVENT_BRIDGE_URL - http://app:8080 in compose). */
  targetUrl: string;
  /** deriveBridgeToken(config.sessionSecret). */
  bridgeToken: string;
  /** config.cfOriginSecret - passes the app's locked origin-secret chain. */
  originSecret: string;
  logger: Logger;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** Forward every bus emit to the app process. Attach ONLY in worker.ts - the
 *  app process must never forward (no echo path exists by construction). */
export function attachEventBridge(bus: EventBus, opts: AttachEventBridgeOptions): void {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL('/internal/events', opts.targetUrl);
  for (const name of APP_EVENT_NAMES) {
    bus.on(name, (payload) => {
      // Detached on purpose: the emitting job must never wait on the bridge.
      void doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-origin-verify': opts.originSecret,
          'x-bridge-token': opts.bridgeToken,
        },
        body: JSON.stringify({ name, payload }),
        signal: AbortSignal.timeout(2000),
      })
        .then((res) => {
          if (!res.ok) {
            // Name + status only - NEVER the payload (PII posture above).
            opts.logger.warn({ event: name, status: res.status }, 'event bridge post rejected');
          }
        })
        .catch((err: unknown) => {
          opts.logger.warn({ event: name, err }, 'event bridge post failed');
        });
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w app -- eventBridge`
Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git status   # gating read - stage ONLY the paths below
git add app/src/lib/events.ts app/src/lib/eventBridge.ts app/test/eventBridge.test.ts
git commit -m "feat(events): APP_EVENT_NAMES + worker-side event bridge forwarder

Co-Authored-By: <authoring model>"
```

---

### Task 2: Internal notify route + app mount + header redaction

**Files:**
- Create: `app/src/routes/internal.ts`
- Modify: `app/src/app.ts` (mount at route stage; add '/internal' to the SPA
  reserved list at app.ts:195)
- Modify: `app/src/lib/logger.ts:26-33` (redact x-bridge-token)
- Test: `app/test/internalRoute.test.ts`

**Interfaces:**
- Consumes: `deriveBridgeToken` (Task 1), `APP_EVENT_NAMES`, `EventBus`,
  `AppEventMap`, `AppEventName`, `appEvents` from `lib/events.ts`.
- Produces: `createInternalRouter(deps: { config: AppConfig; events: EventBus;
  logger: Logger }): Router` - mounted by app.ts at `/internal`.

- [ ] **Step 1: Write the failing tests**

`app/test/internalRoute.test.ts` - use the repo's route-test pattern
(devGating.test.ts: `buildApp` + `loadConfig({ NODE_ENV: 'test',
CF_ORIGIN_SECRET: SECRET, ... })` + supertest). Inject a fresh bus via the
existing `deps.api.events` seam so assertions see re-emits:

```typescript
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createEventBus } from '../src/lib/events.js';
import { deriveBridgeToken } from '../src/lib/eventBridge.js';
import { createLogCapture } from './helpers/logCapture.js';

const ORIGIN = 'test-origin-secret';
const SESSION = 'test-session-secret';
const TOKEN = deriveBridgeToken(SESSION);

function makeApp() {
  const events = createEventBus();
  const capture = createLogCapture();
  const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN, SESSION_SECRET: SESSION });
  const app = buildApp({ config, logger: capture.logger, api: { events } });
  return { app, events, capture };
}

describe('POST /internal/events', () => {
  it('403 without the CloudFront origin secret (locked chain holds)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/internal/events')
      .set('x-bridge-token', TOKEN)
      .send({ name: 'suggestion.updated', payload: { contactId: 'c1' } });
    expect(res.status).toBe(403);
  });

  it('403 on missing and on wrong bridge token - and never logs the provided value', async () => {
    const { app, events, capture } = makeApp();
    let received = 0;
    events.on('suggestion.updated', () => { received += 1; });
    const missing = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .send({ name: 'suggestion.updated', payload: { contactId: 'c1' } });
    expect(missing.status).toBe(403);
    const wrong = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .set('x-bridge-token', 'attacker-guess-value')
      .send({ name: 'suggestion.updated', payload: { contactId: 'c1' } });
    expect(wrong.status).toBe(403);
    expect(received).toBe(0);
    expect(JSON.stringify(capture.all())).not.toContain('attacker-guess-value');
  });

  it('400 on an unknown event name and on a non-object payload', async () => {
    const { app } = makeApp();
    for (const body of [
      { name: 'not.a.real.event', payload: {} },
      { name: 'suggestion.updated', payload: 'string' },
      { name: 'suggestion.updated', payload: ['array'] },
      { name: 'suggestion.updated' },
      {},
    ]) {
      const res = await request(app)
        .post('/internal/events')
        .set('x-origin-verify', ORIGIN)
        .set('x-bridge-token', TOKEN)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('204 + the exact payload re-emits on the app bus', async () => {
    const { app, events } = makeApp();
    const seen: unknown[] = [];
    events.on('suggestion.updated', (p) => seen.push(p));
    const res = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .set('x-bridge-token', TOKEN)
      .send({ name: 'suggestion.updated', payload: { contactId: 'c-204' } });
    expect(res.status).toBe(204);
    expect(seen).toEqual([{ contactId: 'c-204' }]);
  });
});
```

VERIFY FIRST (read, do not assume): (a) `routes/api.ts` ApiRouterDeps really
exposes `events` (it does - api.ts:217/391) and buildApp threads `deps.api`
into it; the internal router must emit on the SAME instance - see Step 3's
buildApp change. (b) loadConfig test-env requirements (DYNAMODB_ENDPOINT etc.)
- copy whatever minimal env devGating's `disabled()` uses if loadConfig
demands more.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w app -- internalRoute`
Expected: FAIL (404s where 403/400/204 expected - route does not exist).

- [ ] **Step 3: Implement the route + mount**

`app/src/routes/internal.ts`:

```typescript
// POST /internal/events - the cross-process event bridge, APP side (spec:
// docs/superpowers/specs/2026-07-20-event-bridge-design.md). The worker's
// forwarder (lib/eventBridge.ts) is the ONLY intended caller.
//
// Trust posture (two independent fences, both required):
//   1. The locked middleware chain: this router mounts at the ROUTE stage, so
//      the CloudFront origin-secret validator (stage 2) already ran - a
//      direct-to-EC2 probe without CF_ORIGIN_SECRET died there.
//   2. x-bridge-token: HKDF-derived from SESSION_SECRET (lib/eventBridge.ts).
//      A via-CloudFront probe carries a valid origin stamp but can never
//      compute this token - CloudFront and browsers do not have it.
// NEVER mount this ahead of the origin validator, and NEVER under /api
// requireAuth (process-to-process: no session exists).
//
// The payload is passed through OPAQUELY: the peer is this same codebase
// authenticated by the token, so the route validates the event NAME against
// APP_EVENT_NAMES and the payload's SHAPE (plain object) only. Payloads are
// never logged (they may carry the conversation preview - PII, doc section 9).
import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import { APP_EVENT_NAMES, type AppEventMap, type AppEventName, type EventBus } from '../lib/events.js';
import { deriveBridgeToken } from '../lib/eventBridge.js';

const EVENT_NAME_SET: ReadonlySet<string> = new Set(APP_EVENT_NAMES);

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface InternalRouterDeps {
  config: AppConfig;
  /** MUST be the same bus instance the SSE route subscribes (buildApp resolves it). */
  events: EventBus;
  logger: Logger;
}

export function createInternalRouter(deps: InternalRouterDeps): Router {
  const { config, events, logger } = deps;
  const expectedToken = deriveBridgeToken(config.sessionSecret);
  const router = Router();

  router.post('/events', (req: Request, res: Response) => {
    const provided = req.headers['x-bridge-token'];
    if (typeof provided !== 'string' || !tokensMatch(provided, expectedToken)) {
      // NEVER log the provided value (mirrors middleware/originSecret.ts).
      logger.warn(
        {
          remoteIp: req.socket.remoteAddress ?? null,
          reason: typeof provided === 'string' ? 'bridge token mismatch' : 'bridge token missing',
        },
        'internal events post rejected',
      );
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const body: unknown = req.body;
    const name = (body as { name?: unknown } | null)?.name;
    const payload = (body as { payload?: unknown } | null)?.payload;
    if (
      typeof name !== 'string' ||
      !EVENT_NAME_SET.has(name) ||
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      res.status(400).json({ error: 'bad request' });
      return;
    }
    // The ONE narrowing seam: name is proven in APP_EVENT_NAMES and payload is
    // a plain object built by this same codebase's typed emit (worker side).
    events.emit(name as AppEventName, payload as AppEventMap[AppEventName]);
    res.status(204).end();
  });

  return router;
}
```

`app/src/app.ts` changes (three spots):

1. Imports: add
```typescript
import { appEvents } from './lib/events.js';
import { createInternalRouter } from './routes/internal.js';
```
2. Route stage - directly after the `/webhooks` mount (app.ts:100), add:
```typescript
  // Cross-process event bridge (routes/internal.ts): the worker's forwarder
  // posts here. Route stage on purpose - BEHIND the origin-secret validator,
  // NEVER under /api requireAuth. Emits on the SAME bus the SSE route serves
  // (the injected test bus, or the appEvents singleton both default to).
  const bridgeEvents = deps.api?.events ?? appEvents;
  app.use('/internal', createInternalRouter({ config, events: bridgeEvents, logger: log }));
```
3. SPA fallback reserved list (app.ts:195): add `'/internal'` to the array so
an unmatched GET under /internal can never stream index.html:
```typescript
      const reserved = ['/api', '/webhooks', '/auth', '/public', '/__dev', '/internal'].some(
```

`app/src/lib/logger.ts` redact paths (line 26-33): add the two bridge-token
entries alongside the origin-verify pair:
```typescript
        'headers["x-bridge-token"]',
        'req.headers["x-bridge-token"]',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w app -- internalRoute`
Expected: PASS (4 tests). Also run `npm test -w app -- eventBridge` - still green.

- [ ] **Step 5: Commit**

```bash
git status   # gating read
git add app/src/routes/internal.ts app/src/app.ts app/src/lib/logger.ts app/test/internalRoute.test.ts
git commit -m "feat(events): POST /internal/events - app-side bridge route behind the locked chain

Co-Authored-By: <authoring model>"
```

---

### Task 3: Config knobs + worker attach + poll-interval knob

**Files:**
- Modify: `app/src/lib/config.ts` (AppConfig interface + loadConfig; put the
  EVENT_BRIDGE_URL parse near the TWILIO_API_BASE_URL block at config.ts:400-421
  and the interval near `port` at config.ts:442-445)
- Modify: `app/src/worker.ts` (attach bridge; use the interval knob in the
  three setInterval calls at worker.ts:127/160/214; fix the stale seam comment
  at worker.ts:175-178)
- Test: extend `app/test/config.test.ts` (or the file where PORT/TWILIO_API_BASE_URL
  parsing is tested - find it with `rg "TWILIO_API_BASE_URL" app/test/`)

**Interfaces:**
- Consumes: `attachEventBridge`, `deriveBridgeToken` (Task 1).
- Produces: `config.eventBridgeUrl?: string`, `config.workerPollIntervalMs: number`
  (Task 4's harness env vars and Task 5's docs reference these exact names).

- [ ] **Step 1: Write the failing config tests**

Add to the config test file located above:

```typescript
describe('EVENT_BRIDGE_URL / WORKER_POLL_INTERVAL_MS', () => {
  const base = { NODE_ENV: 'test', CF_ORIGIN_SECRET: 'test-origin-secret' };

  it('eventBridgeUrl is undefined when unset or blank', () => {
    expect(loadConfig({ ...base }).eventBridgeUrl).toBeUndefined();
    expect(loadConfig({ ...base, EVENT_BRIDGE_URL: '  ' }).eventBridgeUrl).toBeUndefined();
  });

  it('eventBridgeUrl parses a valid URL and is ALLOWED in production', () => {
    expect(loadConfig({ ...base, EVENT_BRIDGE_URL: 'http://app:8080' }).eventBridgeUrl).toBe(
      'http://app:8080',
    );
    // Production-legal on purpose: it IS the production path (unlike the
    // dev-only TWILIO_API_BASE_URL posture). Production config needs its
    // required envs - reuse however the existing prod-config tests build one.
  });

  it('eventBridgeUrl rejects a malformed URL at boot', () => {
    expect(() => loadConfig({ ...base, EVENT_BRIDGE_URL: 'not a url' })).toThrow(/EVENT_BRIDGE_URL/);
  });

  it('workerPollIntervalMs defaults to 60000 and validates', () => {
    expect(loadConfig({ ...base }).workerPollIntervalMs).toBe(60000);
    expect(loadConfig({ ...base, WORKER_POLL_INTERVAL_MS: '1500' }).workerPollIntervalMs).toBe(1500);
    for (const bad of ['0', '-5', 'abc', '1.5']) {
      expect(() => loadConfig({ ...base, WORKER_POLL_INTERVAL_MS: bad })).toThrow(
        /WORKER_POLL_INTERVAL_MS/,
      );
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w app -- config`
Expected: FAIL (unknown properties / no validation error thrown).

- [ ] **Step 3: Implement config**

AppConfig interface additions (doc-comment style matches neighbors):

```typescript
  /**
   * Cross-process event bridge target (lib/eventBridge.ts): the APP process's
   * base URL the WORKER fire-and-forgets POST /internal/events to. Set to
   * http://app:8080 by docker-compose (worker service) and to the lane's app
   * URL by the local runners (scripts/dev.mjs, scripts/e2e-session.mjs).
   * Unset -> the worker attaches no bridge (emits stay in-process). Non-secret.
   */
  eventBridgeUrl?: string;
  /**
   * Cadence for the worker's three stateless polls (tour reminders, placement
   * nudges, extraction - worker.ts). Default 60000. Lowering it is a QA/dev
   * affordance; the e2e harness deliberately keeps the default (see the bridge
   * e2e spec's race rationale in docs/superpowers/plans/2026-07-20-event-bridge.md).
   */
  workerPollIntervalMs: number;
```

loadConfig additions - EVENT_BRIDGE_URL near the TWILIO_API_BASE_URL block
(NO production rejection - mirror only the URL-parse guard, config.ts:415-421):

```typescript
  // Cross-process event bridge target (non-secret; production-legal - compose
  // sets it). Validate the parse at boot so a malformed value fails fast.
  const eventBridgeUrl = env.EVENT_BRIDGE_URL?.trim();
  if (eventBridgeUrl !== undefined && eventBridgeUrl.length > 0) {
    try {
      new URL(eventBridgeUrl);
    } catch {
      throw new Error(`EVENT_BRIDGE_URL must be a valid URL, got: ${eventBridgeUrl}`);
    }
  }

  const workerPollIntervalMs = Number(env.WORKER_POLL_INTERVAL_MS ?? 60000);
  if (!Number.isInteger(workerPollIntervalMs) || workerPollIntervalMs <= 0) {
    throw new Error(
      `WORKER_POLL_INTERVAL_MS must be a positive integer (milliseconds), got: ${env.WORKER_POLL_INTERVAL_MS}`,
    );
  }
```

Return-object additions (spread-conditional like the other optionals - find the
pattern near `anthropicApiKey` in the return literal):

```typescript
    ...(eventBridgeUrl !== undefined && eventBridgeUrl.length > 0 && { eventBridgeUrl }),
    workerPollIntervalMs,
```

- [ ] **Step 4: Wire worker.ts**

After `const config = loadConfig();` (worker.ts:34) - the attach block:

```typescript
// Cross-process event bridge (lib/eventBridge.ts): forward EVERY emit on this
// worker's in-process bus to the app process, whose SSE clients are the ones
// that matter. Attached ONLY here - the app never forwards (no echo path).
// Unset EVENT_BRIDGE_URL (bare local runs) -> emits stay in-process, exactly
// the pre-bridge behavior.
if (config.eventBridgeUrl) {
  const { attachEventBridge, deriveBridgeToken } = await import('./lib/eventBridge.js');
  const { appEvents } = await import('./lib/events.js');
  attachEventBridge(appEvents, {
    targetUrl: config.eventBridgeUrl,
    bridgeToken: deriveBridgeToken(config.sessionSecret),
    originSecret: config.cfOriginSecret,
    logger,
  });
  runWithContext(bootContext, () => {
    // Operational, non-secret (the URL names a container/port, never a token).
    logger.info({ target: config.eventBridgeUrl }, 'event bridge attached - worker emits forward to the app process');
  });
}
```

Replace the three `}, 60_000).unref();` setInterval closers (worker.ts:127-132,
160-165, 214-219) with `}, config.workerPollIntervalMs).unref();` - the tour
reminder, placement nudge, and extraction polls; leave the keepAlive interval
(worker.ts:224-226) at its literal.

Fix the stale seam comment (worker.ts:175-178): replace the four lines
beginning `// SINGLE-INSTANCE SEAM:` with:

```typescript
// Cross-process bridge (lib/eventBridge.ts): apply.ts's `suggestion.updated`
// emit lands on THIS worker's bus and - when EVENT_BRIDGE_URL is set (all
// deployed envs + local runners) - forwards to the app process's SSE clients.
// Bare unset-URL runs keep the old visible-on-next-fetch behavior.
```

- [ ] **Step 5: Run the gates on the touched surface**

Run: `npm test -w app -- config` -> PASS.
Run: `npm run typecheck` -> exit 0 (worker.ts + config.ts type-clean).

- [ ] **Step 6: Commit**

```bash
git status   # gating read
git add app/src/lib/config.ts app/src/worker.ts app/test/<config test file>
git commit -m "feat(worker): attach event bridge from EVENT_BRIDGE_URL; WORKER_POLL_INTERVAL_MS knob

Co-Authored-By: <authoring model>"
```

---

### Task 4: Compose + local-runner wiring

**Files:**
- Modify: `docker-compose.yml:50-52` (worker environment block)
- Modify: `scripts/e2e-session.mjs` (childEnv, near `PORT: String(ports.app)` at :181)
- Modify: `scripts/dev.mjs` (the childEnv the app/worker commands receive - locate
  the `childEnv` construction; the app binds :8080 there)

**Interfaces:**
- Consumes: `EVENT_BRIDGE_URL` (Task 3's env var).
- Produces: every environment that runs a real worker process has the bridge on.

- [ ] **Step 1: docker-compose.yml** - worker service `environment:` gains one line:

```yaml
    environment:
      NODE_ENV: production
      HC_PROCESS: worker
      # Cross-process event bridge (lib/eventBridge.ts): the worker forwards
      # bus emits to the app container's internal route over the compose
      # network. In-repo on purpose - operational wiring, not a secret.
      EVENT_BRIDGE_URL: "http://app:8080"
```

- [ ] **Step 2: scripts/e2e-session.mjs** - childEnv, next to `PORT: String(ports.app)`:

```javascript
  // Cross-process event bridge: the worker process forwards its bus emits to
  // the app's POST /internal/events so SSE clients see worker-side writes live
  // (the event-bridge e2e spec proves this path). WORKER_POLL_INTERVAL_MS is
  // deliberately NOT lowered here: in-app dev ticks jump their clock past the
  // debounce, the worker polls real time - a fast cadence would let the worker
  // race tick-driven specs for due rows (tick.processed assertions).
  EVENT_BRIDGE_URL: `http://127.0.0.1:${ports.app}`,
```

- [ ] **Step 3: scripts/dev.mjs** - same var in ITS childEnv: `EVENT_BRIDGE_URL:
'http://127.0.0.1:8080'` (the dev app's fixed port - verify against the PORT
the script actually sets/uses before hardcoding; if dev.mjs computes a port
variable, use it). Same comment style, one line of rationale.

- [ ] **Step 4: Verify ASCII + boot smoke**

Run: `for f in docker-compose.yml scripts/e2e-session.mjs scripts/dev.mjs; do tr -d '\11\12\15\40-\176' < $f | wc -c; done`
Expected: 0 for each (whole files were ASCII before; keep them so).
Boot check rides Task 5's e2e run (the harness now exports the var).

- [ ] **Step 5: Commit**

```bash
git status   # gating read
git add docker-compose.yml scripts/e2e-session.mjs scripts/dev.mjs
git commit -m "feat(events): wire EVENT_BRIDGE_URL - compose worker + local runners

Co-Authored-By: <authoring model>"
```

---

### Task 5: E2E proof + doc corrections + issue resolution

**Files:**
- Create: `e2e/tests/flows/event-bridge.spec.ts`
- Modify: `app/src/lib/events.ts` (header + SuggestionUpdatedEvent comment)
- Modify: `app/src/jobs/extraction.ts:10-17` (stale seam comment)
- Modify: `docs/issues/extraction-writes-no-live-push.md` (resolve)

**Interfaces:**
- Consumes: the full bridge (Tasks 1-4) running in the hermetic stack; existing
  fixtures `reseed`, `planTranscribedCall` (e2e/fixtures/extraction.ts:94),
  `postInboundSms` conventions; `deriveBridgeToken` logic (recomputed inline
  with node:crypto - the e2e workspace does not import app source).

- [ ] **Step 1: Verify the two env preconditions (read, do not assume)**

(a) `scripts/e2e-session.mjs` childEnv does NOT set SESSION_SECRET or
CF_ORIGIN_SECRET -> the stack runs the dev placeholders
(`dev-placeholder-session-secret`, `dev-placeholder-not-a-secret` -
config.ts:331/338). If either IS set, import/replicate those exact values in
the spec instead. (b) confirm how existing e2e code reaches the APP directly
(e2e/support/urls.ts) - the /internal route is NOT proxied by the dashboard
dev server, so the spec posts to the app's own URL.

- [ ] **Step 2: Write the spec**

`e2e/tests/flows/event-bridge.spec.ts` (adapt helper imports to what Step 1
found; devLogin/createTenant copied from conversation-fact-extraction.spec.ts's
local helpers - keep them local to this file, matching that file's pattern):

```typescript
import { hkdfSync } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { planTranscribedCall } from '../../fixtures/extraction.js';

// Cross-process event bridge (spec 2026-07-20-event-bridge-design.md): worker
// emits reach app SSE clients. Two proofs:
//  1. WIRE (fast): POST /internal/events directly -> the browser's EventSource
//     sees the event. Proves route auth + re-emit + SSE delivery.
//  2. CROSS-PROCESS (slow, ~<=75s): a planted immediately-due extraction row is
//     claimed by the REAL worker process's next poll (60s cadence - deliberately
//     NOT lowered; see the plan's race rationale), whose suggestion.updated
//     crosses the bridge and updates an OPEN contact page with no reload.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const APP = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:8080'; // adapt to support/urls.ts
// The hermetic stack runs the dev placeholder secrets (config.ts defaults;
// e2e-session.mjs sets neither) - recompute the bridge token the same way
// lib/eventBridge.ts derives it.
const ORIGIN_SECRET = 'dev-placeholder-not-a-secret';
const BRIDGE_TOKEN = Buffer.from(
  hkdfSync('sha256', 'dev-placeholder-session-secret', '', 'hc-event-bridge', 32),
).toString('hex');

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

let seq = 0;
function uniquePhone(): string {
  seq += 1;
  const stamp = `${Date.now()}`.slice(-5);
  return `+1555${stamp}${String(seq).padStart(2, '0')}`;
}

async function createTenant(request: APIRequestContext, firstName: string) {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Bridge', phone },
  });
  expect(res.ok()).toBeTruthy();
  return { contactId: (await res.json()).contact.contactId as string, phone };
}

test.beforeAll(async ({ request }) => {
  await reseed(request);
});

test('wire: an authenticated /internal/events post reaches the browser SSE stream', async ({
  page,
  request,
}) => {
  await devLogin(page);
  // Listen on the SSE stream from the BROWSER (the dashboard origin proxies
  // /api to the app), then fire the internal post and await the event.
  const listen = page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const es = new EventSource('/api/events');
        const timer = setTimeout(() => { es.close(); reject(new Error('no SSE event within 15s')); }, 15000);
        es.addEventListener('suggestion.updated', (e) => {
          clearTimeout(timer); es.close(); resolve((e as MessageEvent).data as string);
        });
        es.onerror = () => { /* EventSource retries; the timeout is the failure path */ };
      }),
  );
  const post = await request.post(`${APP}/internal/events`, {
    headers: { 'x-origin-verify': ORIGIN_SECRET, 'x-bridge-token': BRIDGE_TOKEN },
    data: { name: 'suggestion.updated', payload: { contactId: 'bridge-wire-proof' } },
  });
  expect(post.status()).toBe(204);
  const data = JSON.parse(await listen) as { contactId: string };
  expect(data.contactId).toBe('bridge-wire-proof');
});

test('wire: missing token 403s; unknown name 400s', async ({ request }) => {
  const noToken = await request.post(`${APP}/internal/events`, {
    headers: { 'x-origin-verify': ORIGIN_SECRET },
    data: { name: 'suggestion.updated', payload: {} },
  });
  expect(noToken.status()).toBe(403);
  const badName = await request.post(`${APP}/internal/events`, {
    headers: { 'x-origin-verify': ORIGIN_SECRET, 'x-bridge-token': BRIDGE_TOKEN },
    data: { name: 'not.an.event', payload: {} },
  });
  expect(badName.status()).toBe(400);
});

test('cross-process: a worker-poll extraction updates an open contact page live', async ({
  page,
  request,
}) => {
  // One real 60s worker poll cycle + pipeline margin. Deliberate - see header.
  test.setTimeout(150_000);
  await devLogin(page);
  const { contactId } = await createTenant(page.request, 'BridgeLive');
  const conv = await page.request.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(conv.ok()).toBeTruthy();
  const conversationId = (await conv.json()).conversation.conversationId as string;

  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(
    page.locator('section').filter({ has: page.getByRole('heading', { name: 'Eligibility intake' }) }),
  ).toBeVisible();

  // Immediately-due extraction row (the transcript-fixture seam schedules
  // dueAt=now) - the REAL worker claims it on its next poll; we never tick.
  await planTranscribedCall(request, {
    conversationId,
    callSid: `CAbridge${Date.now()}`,
    sentences: [
      { text: 'EXTRACT:{"fields":{"pets":{"op":"suggest","value":"cat","reason":"mentioned a cat"}}}', mediaChannel: 1 },
    ],
  });

  // NO reload, NO tick: the suggestion chip appears only if worker-side
  // suggestion.updated crossed the bridge and this page refetched on SSE.
  await expect(page.getByRole('group', { name: /AI suggestion for/i })).toBeVisible({
    timeout: 90_000,
  });
});
```

VERIFY the response-shape assumptions against existing specs before running:
the `POST /api/contacts/:id/conversation` body key (`conversation.conversationId`
- check how voice-extraction.spec.ts or planTranscribedCall callers resolve it)
and the chip's accessible name (`AI suggestion for <label>` per
conversation-fact-extraction.spec.ts:16). Adapt if the real shapes differ.

- [ ] **Step 3: Doc corrections (same change, per spec)**

(a) `app/src/lib/events.ts` header (lines 5-13): rewrite the single-instance
paragraph to state: the app process serves SSE; the WORKER process's emits
arrive via the cross-process bridge (lib/eventBridge.ts -> POST
/internal/events, routes/internal.ts); and KEEP the multi-instance note that
scaling past one app instance means replacing this module's internals with a
DynamoDB-streams consumer while emitters + the SSE route keep their contracts.
(b) `app/src/lib/events.ts` SuggestionUpdatedEvent comment (lines 231-234):
replace the "does NOT reach app SSE clients" sentences with: poll-driven emits
now cross the bridge when EVENT_BRIDGE_URL is set (all deployed envs + local
runners); bare unset runs surface on the next fetch.
(c) `app/src/jobs/extraction.ts` seam comment (lines 10-17): same correction -
delete the "intentional for v1 - do NOT try to bridge it here" instruction,
point to lib/eventBridge.ts.

- [ ] **Step 4: Resolve the issue**

`docs/issues/extraction-writes-no-live-push.md`: frontmatter `status: open` ->
`status: resolved`; append at the bottom:

```markdown
**Resolution (2026-07-20).** Fixed by the cross-process event bridge
(feat/event-bridge): the worker forwards every bus emit to the app process via
authenticated POST /internal/events (lib/eventBridge.ts -> routes/internal.ts),
which re-emits to its SSE clients - same names/payloads, zero dashboard change.
Covers extraction suggestion.updated, tour-reminder/placement-nudge
scheduled.updated, and relay-announcement message.persisted/conversation.updated.
Design: docs/superpowers/specs/2026-07-20-event-bridge-design.md. Proven
end-to-end (real worker process -> open page updates with no reload) by
e2e/tests/flows/event-bridge.spec.ts.
```

- [ ] **Step 5: Run the full gates**

From the worktree root, in order, BARE:
- `npm run typecheck` -> exit 0
- `npm test` -> exit 0
- `timeout 1500 npm run e2e` -> exit 0 (warm containers first: `npm run db:start`,
  `npm run s3:start`; known flakes per profile - re-run before blaming the change)

- [ ] **Step 6: Commit**

```bash
git status   # gating read
git add e2e/tests/flows/event-bridge.spec.ts app/src/lib/events.ts app/src/jobs/extraction.ts docs/issues/extraction-writes-no-live-push.md
git commit -m "test(e2e)+docs: bridge wire + cross-process proofs; resolve extraction-writes-no-live-push

Co-Authored-By: <authoring model>"
```

---

### Task 6: Live self-QA (per profile), main sync, final gates

- [ ] **Step 1: Live self-QA** - `npm run e2e:session` from the worktree (it
picks its own lane; note ports). Dev-login via the button. With the session
stack up: create a tenant, open its contact page, run the Task 5 cross-process
scenario BY HAND via the transcript-fixture seam (curl/Invoke the /__dev route)
and WATCH the chip appear without reload. Screenshot to `.playwright-mcp/`.
Also grep the worker process output for the `event bridge attached` boot line.
`npm run e2e:stop` when done. (Reviewers must not run suites while this
session is live.)

- [ ] **Step 2: Main sync** - `git merge main` in the worktree (ONE sync,
per the repo rule; keep both sides' intent on conflicts), then re-run ALL
gates green on the merged base: `npm run typecheck`, `npm test`,
`timeout 1500 npm run e2e`.

- [ ] **Step 3: Memory + handback prep** - per the profile's memory contract
and the orchestrator's manual (handback.md with per-spec-item table, quoted
exit codes, deviations - including the two planning deviations at the top of
this plan - and owed ops: NONE).

## Explicitly NOT in scope

- No dashboard/ changes of any kind (a diff under dashboard/src is a review
  finding).
- No changes to routes/api.ts (no new event names -> its two SSE handler
  lists are untouched; reviewers assert this).
- No .env.example / .env.* edits (compose + runner scripts own the new var).
- No retries/queues/batching in the bridge; no DynamoDB Streams work.
- No new dependencies in any package.json.
