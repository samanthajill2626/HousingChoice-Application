# Fake-Twilio Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a standalone `fake-twilio` service that impersonates Twilio's REST API and fires correctly-signed webhooks back to the app, so we can drive multi-party SMS/MMS flows at full HTTP-seam fidelity — the app's real `TwilioMessagingDriver` and `twilioSignature` middleware run unchanged.

**Architecture:** Approach A (standalone service) over a reusable, framework-agnostic engine (Approach C's discipline). The engine (persona registry, in-memory conversation store, webhook signer + dispatcher, delivery-profile state machine) is a pure module; a thin Express host exposes a Twilio-REST-impersonation surface + a control API and runs as its own tsx process in the e2e stack. The app gets one new optional config (`TWILIO_API_BASE_URL`) that redirects the real Twilio SDK to the fake host via a custom `httpClient`. This plan is backend-only and fully testable without any UI (the fake-phones UI is Plan 2).

**Tech Stack:** Node ≥24, TypeScript via `tsx`, Express, `twilio` v6 (for signature parity), Vitest + supertest. New workspace package `fake-twilio/`. Integrates with the existing `scripts/e2e-session.mjs` launcher and Playwright harness.

---

## Reference facts (verified against the codebase)

These are load-bearing; tasks below depend on them.

- **Driver seam:** `TwilioMessagingDriver` in [`app/src/adapters/messaging.ts`](../../../app/src/adapters/messaging.ts) builds its client as
  `this.client = deps.client ?? twilio(deps.apiKeySid, deps.apiKeySecret, { accountSid: deps.accountSid })`.
  `TwilioMessagingDriverDeps` already has `accountSid, apiKeySid, apiKeySecret, messagingServiceSid, publicBaseUrl?, sendingEnabled?, client?, logger?`.
- **Factory:** `createMessagingAdapter({ config, logger, twilioClient })` selects driver by `config.messagingDriver` and wraps in `RecordingMessagingDriver` when `config.recordOutbox`.
- **`twilio` v6** (`"twilio": "^6.0.2"` in `app/package.json`) accepts a custom HTTP client: `twilio(sid, secret, { accountSid, httpClient })`. The client's `httpClient.request(opts)` receives a fully-built request (method, uri, params/data, headers) and returns a promise resolving to `{ statusCode, body, headers }`. Default base hosts are `https://api.twilio.com` (Messages live under `/2010-04-01/Accounts/{Sid}/Messages.json`).
- **Signature middleware** [`app/src/middleware/twilioSignature.ts`](../../../app/src/middleware/twilioSignature.ts): validates `X-Twilio-Signature` via `twilio.validateRequest(authToken, signature, url, params)` where `url = ${publicBaseUrl}${req.originalUrl}` and `params` is the parsed `application/x-www-form-urlencoded` body. Production fails closed (403) when `authToken`/`publicBaseUrl` unset; dev allows unsigned with a WARN.
- **Inbound SMS handler** `POST /webhooks/twilio/sms` ([`app/src/routes/webhooks/twilio.ts`](../../../app/src/routes/webhooks/twilio.ts)) requires `MessageSid` + `From`; reads `To`, `Body`, `OptOutType`, `NumMedia`, `MediaUrl{i}`, `MediaContentType{i}`. Responds `200` with empty TwiML `<?xml version="1.0" encoding="UTF-8"?><Response/>`.
- **Status handler** `POST /webhooks/twilio/status` requires `MessageSid` + `MessageStatus`; reads optional `ErrorCode`. Responds `200`.
- **Webhook router** mounts under `/webhooks` ([`app/src/routes/webhooks/index.ts`](../../../app/src/routes/webhooks/index.ts)); `/twilio/voice` first, then `/twilio` (owns `/sms` + `/status`).
- **Config** [`app/src/lib/config.ts`](../../../app/src/lib/config.ts) is a hand-rolled validator. Twilio fields are optional in the `AppConfig` interface and validated as a group when `messagingDriver === 'twilio'`. Prod fail-closed pattern (e.g. `DEV_AUTH_ENABLED`): parse, then `if (flag && nodeEnv === 'production') throw`.
- **E2E stack** is `scripts/e2e-session.mjs` (spawns tsx processes, **not** Docker): DynamoDB Local (:8000) → tables → seed → app (:8080) → worker → Vite (:5173). It currently sets `MESSAGING_DRIVER` to the dev default (`console`), `DEV_AUTH_ENABLED=1`, `MESSAGING_RECORD_OUTBOX=1`, `PUBLIC_BASE_URL=http://localhost:5173`, `DYNAMODB_ENDPOINT=http://localhost:8000`, `TABLE_PREFIX=hc-local-`. Restart sentinel `e2e/.artifacts/.restart` bounces app+worker only.
- **Seed roster** [`app/src/lib/seedData.ts`](../../../app/src/lib/seedData.ts): tenant `+15550100001` (Tasha Nguyen), landlord `+15550100002` (Marcus Bell), HA-staff `+15550100003` (Renee Carter). The app's own number in tests is `+15550009999` (`OUR_PHONE_NUMBERS`).
- **SSE precedent** exists (`GET /api/events`, `dashboard/src/api/useEventStream.ts`) — relevant to Plan 2, not this plan.

---

## File structure (Plan 1)

**New workspace package `fake-twilio/`:**

- `fake-twilio/package.json` — `@housingchoice/fake-twilio`; deps `express`, `twilio`; run via tsx.
- `fake-twilio/tsconfig.json` — mirrors `app/`'s tsconfig (NodeNext, strict).
- `fake-twilio/src/index.ts` — standalone host entry: boot guard (refuse `NODE_ENV=production`) + `listen`.
- `fake-twilio/src/server.ts` — `buildFakeTwilioApp(deps)` → Express app (testable, mirrors `buildApp`).
- `fake-twilio/src/config.ts` — `loadFakeConfig(env)` → typed config (ports, app target URLs, shared auth token).
- `fake-twilio/src/engine/types.ts` — `Persona`, `Role`, `Thread`, `ThreadMessage`, `DeliveryProfile`, `DeliveryState`, control DTOs.
- `fake-twilio/src/engine/registry.ts` — `PersonaRegistry`: seeded roster + `addAdHoc`.
- `fake-twilio/src/engine/store.ts` — `ConversationStore`: in-memory threads keyed by party number.
- `fake-twilio/src/engine/signer.ts` — `signTwilioWebhook(...)`: build form body + compute `X-Twilio-Signature`.
- `fake-twilio/src/engine/dispatcher.ts` — `WebhookDispatcher`: POST signed webhooks to the app.
- `fake-twilio/src/engine/clock.ts` — injectable `Clock` + `Scheduler` (deterministic in tests).
- `fake-twilio/src/engine/delivery.ts` — delivery-profile state machine.
- `fake-twilio/src/engine/engine.ts` — `FakeTwilioEngine`: ties the above together; control verbs.
- `fake-twilio/src/routes/rest.ts` — Twilio REST impersonation (`Messages.json`; `501` stubs for voice/numbers).
- `fake-twilio/src/routes/control.ts` — control API.
- `fake-twilio/test/*.test.ts` — unit + integration tests.

**Modified in `app/`:**

- `app/src/lib/config.ts` — add `twilioApiBaseUrl` (prod fail-closed).
- `app/src/adapters/twilioHttpClient.ts` — **new**: custom `httpClient` that rewrites the host to `apiBaseUrl`.
- `app/src/adapters/messaging.ts` — thread `apiBaseUrl` through `TwilioMessagingDriverDeps` + factory.
- `app/src/adapters/recordingMessaging.ts` — `@deprecated` JSDoc.
- `app/src/routes/dev.ts` — deprecation comment on `/__dev/outbox`.
- `e2e/fixtures/outbox.ts` — `@deprecated` JSDoc.

**Modified at repo root:**

- `package.json` — add `fake-twilio` to workspaces; add `fake-twilio` test script.
- `scripts/e2e-session.mjs` — start the fake-twilio process; set app env to drive it.

---

## Phase 0 — Scaffold the `fake-twilio` workspace

### Task 0.1: Create the package skeleton

**Files:**
- Create: `fake-twilio/package.json`
- Create: `fake-twilio/tsconfig.json`
- Modify: `package.json` (root — workspaces + scripts)

- [ ] **Step 1: Read the existing app tsconfig and root package.json to match conventions**

Run: read `app/tsconfig.json` and the root `package.json` `workspaces` + `scripts` blocks. Confirm the module setting (NodeNext) and the test runner (Vitest).

- [ ] **Step 2: Write `fake-twilio/package.json`**

```json
{
  "name": "@housingchoice/fake-twilio",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --import tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^4.21.2",
    "twilio": "^6.0.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

(Match the EXACT versions already used in `app/package.json` — read it first and align; the versions above are placeholders to be reconciled with the repo's lockfile in Step 1.)

- [ ] **Step 3: Write `fake-twilio/tsconfig.json`**

Copy `app/tsconfig.json`'s compiler options (NodeNext module/resolution, `strict`, `noUncheckedIndexedAccess` if present), with `"include": ["src", "test"]`. Match the app exactly so types behave identically.

- [ ] **Step 4: Add the package to the root workspaces and a convenience test script**

In root `package.json`, add `"fake-twilio"` to the `workspaces` array, and add:

```json
"test:fake-twilio": "npm run test -w @housingchoice/fake-twilio"
```

- [ ] **Step 5: Install and verify the workspace resolves**

Run: `npm install`
Expected: completes; `npm ls -w @housingchoice/fake-twilio` shows the package.

- [ ] **Step 6: Commit**

```bash
git add fake-twilio/package.json fake-twilio/tsconfig.json package.json package-lock.json
git commit -m "chore(fake-twilio): scaffold workspace package"
```

### Task 0.2: Boot guard + health endpoint (the standalone host shell)

**Files:**
- Create: `fake-twilio/src/config.ts`
- Create: `fake-twilio/src/server.ts`
- Create: `fake-twilio/src/index.ts`
- Test: `fake-twilio/test/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/server.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';

function cfg(env: Record<string, string> = {}) {
  return loadFakeConfig({
    NODE_ENV: 'test',
    FAKE_TWILIO_PORT: '8889',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
    TWILIO_AUTH_TOKEN: 'test-token',
    ...env,
  });
}

describe('fake-twilio host', () => {
  it('responds 200 on GET /health', async () => {
    const app = buildFakeTwilioApp({ config: cfg() });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'fake-twilio' });
  });

  it('loadFakeConfig throws when NODE_ENV=production', () => {
    expect(() => cfg({ NODE_ENV: 'production' })).toThrow(/production/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio`
Expected: FAIL (`Cannot find module '../src/server.js'`).

- [ ] **Step 3: Write `fake-twilio/src/config.ts`**

```ts
// Typed config for the fake-twilio standalone service. Dev/test only — the
// service must NEVER run in production (it impersonates Twilio).
export interface FakeTwilioConfig {
  /** Port the fake REST + control API listens on. */
  port: number;
  /** Where to POST webhooks (the app's real address, e.g. http://localhost:8080). */
  appBaseUrl: string;
  /** The value of the app's PUBLIC_BASE_URL — used to compute the signed URL the
   *  app's signature middleware will reconstruct. May differ from appBaseUrl. */
  appPublicBaseUrl: string;
  /** Shared Twilio auth token used to sign webhooks (must match the app's). */
  authToken: string;
}

export function loadFakeConfig(env: NodeJS.ProcessEnv = process.env): FakeTwilioConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error(
      'fake-twilio refuses to start while NODE_ENV=production — it impersonates Twilio and must ' +
        'never run in a deployed environment.',
    );
  }
  const appBaseUrl = env.APP_BASE_URL ?? 'http://localhost:8080';
  const appPublicBaseUrl = env.APP_PUBLIC_BASE_URL ?? appBaseUrl;
  const authToken = env.TWILIO_AUTH_TOKEN ?? '';
  return {
    port: Number(env.FAKE_TWILIO_PORT ?? 8889),
    appBaseUrl: appBaseUrl.replace(/\/$/, ''),
    appPublicBaseUrl: appPublicBaseUrl.replace(/\/$/, ''),
    authToken,
  };
}
```

- [ ] **Step 4: Write `fake-twilio/src/server.ts`**

```ts
import express, { type Express } from 'express';
import type { FakeTwilioConfig } from './config.js';

export interface FakeTwilioAppDeps {
  config: FakeTwilioConfig;
}

export function buildFakeTwilioApp(deps: FakeTwilioAppDeps): Express {
  const app = express();
  // Twilio posts application/x-www-form-urlencoded; the control API uses JSON.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'fake-twilio' });
  });

  // Routes are mounted in later phases.
  void deps;
  return app;
}
```

- [ ] **Step 5: Write `fake-twilio/src/index.ts`**

```ts
import { buildFakeTwilioApp } from './server.js';
import { loadFakeConfig } from './config.js';

const config = loadFakeConfig(); // throws if NODE_ENV=production (boot guard)
const app = buildFakeTwilioApp({ config });
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`fake-twilio listening on :${config.port} → app ${config.appBaseUrl}`);
});
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio`
Expected: PASS (both tests).

- [ ] **Step 7: Manually confirm the boot guard**

Run: `NODE_ENV=production npm run start -w @housingchoice/fake-twilio`
Expected: process exits with the "refuses to start while NODE_ENV=production" error.

- [ ] **Step 8: Commit**

```bash
git add fake-twilio/src/config.ts fake-twilio/src/server.ts fake-twilio/src/index.ts fake-twilio/test/server.test.ts
git commit -m "feat(fake-twilio): host shell with health endpoint and prod boot guard"
```

---

## Phase 1 — SPIKE: redirect the real Twilio SDK to a fake host

**This phase de-risks the one non-obvious mechanism before anything depends on it.** It proves that the real `twilio` v6 client, given a custom `httpClient`, sends `messages.create` to our host and parses a Twilio-shaped response.

### Task 1.1: Custom Twilio httpClient that rewrites the host

**Files:**
- Create: `app/src/adapters/twilioHttpClient.ts`
- Test: `app/test/twilioHttpClient.test.ts`

- [ ] **Step 1: Write the failing test (round-trips through a throwaway HTTP server)**

```ts
// app/test/twilioHttpClient.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import twilio from 'twilio';
import { createRedirectingHttpClient } from '../src/adapters/twilioHttpClient.js';

let server: Server | undefined;
afterEach(() => server?.close());

async function startCapture(): Promise<{ url: string; lastPath: () => string; lastBody: () => string }> {
  let lastPath = '';
  let lastBody = '';
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          sid: 'SMfake12345',
          status: 'queued',
          date_created: 'Sun, 15 Jun 2026 14:00:00 +0000',
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server!.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${addr.port}`, lastPath: () => lastPath, lastBody: () => lastBody };
}

describe('createRedirectingHttpClient', () => {
  it('routes messages.create to the fake host and parses the response', async () => {
    const capture = await startCapture();
    const client = twilio('SKtest', 'secrettest', {
      accountSid: 'ACtest',
      httpClient: createRedirectingHttpClient({ baseUrl: capture.url }),
    });

    const msg = await client.messages.create({
      to: '+15550100001',
      from: '+15550009999',
      body: 'hello from the real SDK',
    });

    expect(msg.sid).toBe('SMfake12345');
    expect(msg.status).toBe('queued');
    // The SDK built the canonical Messages path; our client rewrote only the host.
    expect(capture.lastPath()).toContain('/2010-04-01/Accounts/ACtest/Messages.json');
    expect(capture.lastBody()).toContain('To=%2B15550100001');
    expect(capture.lastBody()).toContain('Body=hello');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w app -- twilioHttpClient`
Expected: FAIL (`Cannot find module '../src/adapters/twilioHttpClient.js'`).

- [ ] **Step 3: Implement the redirecting client**

twilio v6's default `RequestClient` exposes `request(opts)` and uses `axios` internally. The cleanest override is to subclass `RequestClient` and rewrite `opts.uri`'s origin to our base URL before delegating to `super.request(opts)`. This keeps the SDK's request building, retries, and response parsing intact — we change only the destination host.

```ts
// app/src/adapters/twilioHttpClient.ts
import RequestClient from 'twilio/lib/base/RequestClient.js';

export interface RedirectingHttpClientOpts {
  /** Base URL of the fake host, e.g. http://localhost:8889 (no trailing slash). */
  baseUrl: string;
}

/**
 * A twilio-node HTTP client that sends every REST request to `baseUrl` instead of
 * the real Twilio hosts, preserving the SDK's canonical path
 * (e.g. /2010-04-01/Accounts/{Sid}/Messages.json), method, params, and response
 * parsing. DEV/TEST ONLY — used to point the real TwilioMessagingDriver at the
 * fake-twilio service so the production driver code path is exercised verbatim.
 */
export function createRedirectingHttpClient(opts: RedirectingHttpClientOpts): RequestClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  const client = new RequestClient();
  const original = client.request.bind(client);
  // twilio's RequestClient.request takes { method, uri, ... } and returns a
  // promise of { statusCode, body, headers }. Rewrite only the origin of `uri`.
  client.request = (requestOpts: { uri: string; [k: string]: unknown }) => {
    const incoming = new URL(requestOpts.uri);
    const rewritten = `${base}${incoming.pathname}${incoming.search}`;
    return original({ ...requestOpts, uri: rewritten });
  };
  return client;
}
```

> **Spike note:** If `twilio/lib/base/RequestClient.js` is not importable as ESM in this toolchain, the fallback is to implement the minimal `httpClient` interface directly (an object with a `request(opts)` method returning `{ statusCode, body, headers }`, using `fetch` against the rewritten URL and serializing `opts.params`/`opts.data` as form-urlencoded). The TEST in Step 1 is the contract — make it pass by whichever import works. Record the working approach in a code comment so the rest of the plan relies on a proven mechanism.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -w app -- twilioHttpClient`
Expected: PASS — `msg.sid === 'SMfake12345'`, path contains `Messages.json`, body contains the encoded `To`/`Body`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w app`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/adapters/twilioHttpClient.ts app/test/twilioHttpClient.test.ts
git commit -m "feat(messaging): redirecting Twilio httpClient (HTTP-seam spike, proven)"
```

---

## Phase 2 — Engine: types + persona registry

### Task 2.1: Engine types

**Files:**
- Create: `fake-twilio/src/engine/types.ts`

- [ ] **Step 1: Write the types (no test — pure declarations, exercised by later tasks)**

```ts
// fake-twilio/src/engine/types.ts
export type Role = 'landlord' | 'tenant' | 'pm' | 'staff';

export interface Persona {
  id: string;
  label: string;
  role: Role;
  /** E.164, e.g. +15550100001. */
  number: string;
  /** Optional pointer to seeded app data (contactId), for humans reading the roster. */
  seededRef?: string;
  adHoc: boolean;
}

export type DeliveryState = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** How the fake should drive an outbound message's status callbacks. */
export interface DeliveryProfile {
  kind: 'normal' | 'stall' | 'fail';
  /** For kind==='stall': the last state to emit before stopping (default 'sent'). */
  stallAt?: DeliveryState;
  /** For kind==='fail': 'failed' | 'undelivered' (default 'failed') + an ErrorCode. */
  failState?: 'failed' | 'undelivered';
  errorCode?: string;
}

export interface ThreadMessage {
  /** Twilio-style SID: SM... (or MM... when media is present). */
  sid: string;
  direction: 'inbound' | 'outbound';
  /** Sender E.164 (app number for outbound, party number for inbound). */
  from: string;
  /** Recipient E.164. */
  to: string;
  body?: string;
  mediaUrls?: string[];
  state: DeliveryState;
  createdAt: string;
  updatedAt: string;
}

/** A conversation thread between the app and exactly one party number. */
export interface Thread {
  /** The party's E.164 number (the non-app side). */
  partyNumber: string;
  messages: ThreadMessage[];
}

// ---- Control API DTOs ----
export interface SendAsPartyInput {
  /** Party number (must be a known persona or ad-hoc). */
  from: string;
  /** App number the text is sent to (defaults to the configured app number). */
  to?: string;
  body?: string;
  mediaUrls?: string[];
}

export interface SetDeliveryOutcomeInput {
  /** Party number whose NEXT outbound message uses this profile. */
  partyNumber: string;
  profile: DeliveryProfile;
}

export interface AddAdHocInput {
  label: string;
  role: Role;
  /** Optional explicit E.164; otherwise the registry mints one. */
  number?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @housingchoice/fake-twilio`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add fake-twilio/src/engine/types.ts
git commit -m "feat(fake-twilio): engine domain types"
```

### Task 2.2: Persona registry (seeded roster + ad-hoc)

**Files:**
- Create: `fake-twilio/src/engine/registry.ts`
- Test: `fake-twilio/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/registry.test.ts
import { describe, expect, it } from 'vitest';
import { PersonaRegistry, SEEDED_PERSONAS, APP_NUMBER } from '../src/engine/registry.js';

describe('PersonaRegistry', () => {
  it('loads the seeded roster with the known seed phone numbers', () => {
    const reg = new PersonaRegistry();
    expect(reg.byNumber('+15550100001')?.role).toBe('tenant');
    expect(reg.byNumber('+15550100002')?.role).toBe('landlord');
    expect(reg.list().length).toBe(SEEDED_PERSONAS.length);
  });

  it('knows the app number is not a party', () => {
    const reg = new PersonaRegistry();
    expect(reg.isAppNumber(APP_NUMBER)).toBe(true);
    expect(reg.byNumber(APP_NUMBER)).toBeUndefined();
  });

  it('mints a deterministic ad-hoc number when none is given', () => {
    const reg = new PersonaRegistry();
    const a = reg.addAdHoc({ label: 'Unknown Caller', role: 'tenant' });
    const b = reg.addAdHoc({ label: 'Another', role: 'landlord' });
    expect(a.number).toBe('+15550199001');
    expect(b.number).toBe('+15550199002');
    expect(a.adHoc).toBe(true);
    expect(reg.byNumber(a.number)?.label).toBe('Unknown Caller');
  });

  it('rejects an ad-hoc number that collides with an existing persona', () => {
    const reg = new PersonaRegistry();
    expect(() => reg.addAdHoc({ label: 'x', role: 'tenant', number: '+15550100001' })).toThrow(/exists/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- registry`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the registry**

```ts
// fake-twilio/src/engine/registry.ts
import type { AddAdHocInput, Persona } from './types.js';

/** The app's own business number in the hermetic stack (mirrors OUR_PHONE_NUMBERS). */
export const APP_NUMBER = '+15550009999';

/**
 * Seeded roster — mirrors the phone numbers in app/src/lib/seedData.ts (source of
 * truth for the data the app itself holds). Kept as a small standalone list so the
 * fake-twilio service stays decoupled from the app package.
 */
export const SEEDED_PERSONAS: ReadonlyArray<Persona> = [
  { id: 'seed-tenant', label: 'Tasha Nguyen (tenant)', role: 'tenant', number: '+15550100001', seededRef: 'contact-tenant-0001', adHoc: false },
  { id: 'seed-landlord', label: 'Marcus Bell (landlord)', role: 'landlord', number: '+15550100002', seededRef: 'contact-landlord-0001', adHoc: false },
  { id: 'seed-hastaff', label: 'Renee Carter (HA staff)', role: 'pm', number: '+15550100003', seededRef: 'contact-hastaff-0001', adHoc: false },
];

const AD_HOC_BASE = 199000; // +1555019900X range, distinct from seed +1555010000X

export class PersonaRegistry {
  private readonly byNum = new Map<string, Persona>();
  private adHocSeq = 0;

  constructor() {
    for (const p of SEEDED_PERSONAS) this.byNum.set(p.number, { ...p });
  }

  list(): Persona[] {
    return [...this.byNum.values()];
  }

  byNumber(number: string): Persona | undefined {
    return this.byNum.get(number);
  }

  isAppNumber(number: string): boolean {
    return number === APP_NUMBER;
  }

  addAdHoc(input: AddAdHocInput): Persona {
    let number = input.number;
    if (number === undefined) {
      this.adHocSeq += 1;
      number = `+1555${String(AD_HOC_BASE + this.adHocSeq).padStart(7, '0')}`;
    }
    if (this.byNum.has(number) || number === APP_NUMBER) {
      throw new Error(`addAdHoc: a persona for ${number} already exists`);
    }
    const persona: Persona = { id: `adhoc-${number}`, label: input.label, role: input.role, number, adHoc: true };
    this.byNum.set(number, persona);
    return persona;
  }
}
```

> Verify against [`app/src/lib/seedData.ts`](../../../app/src/lib/seedData.ts) that the three numbers and `contactId`s above still match the seed before committing. If the seed changes, update `SEEDED_PERSONAS`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- registry`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add fake-twilio/src/engine/registry.ts fake-twilio/test/registry.test.ts
git commit -m "feat(fake-twilio): persona registry (seeded roster + ad-hoc)"
```

---

## Phase 3 — Engine: conversation store

### Task 3.1: In-memory thread store

**Files:**
- Create: `fake-twilio/src/engine/store.ts`
- Test: `fake-twilio/test/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/store.test.ts
import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/engine/store.js';
import type { ThreadMessage } from '../src/engine/types.js';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    sid: 'SM1', direction: 'outbound', from: '+15550009999', to: '+15550100001',
    body: 'hi', state: 'queued', createdAt: '2026-06-15T00:00:00.000Z', updatedAt: '2026-06-15T00:00:00.000Z',
    ...over,
  };
}

describe('ConversationStore', () => {
  it('appends messages into a per-party thread', () => {
    const store = new ConversationStore();
    store.append('+15550100001', msg({ sid: 'SM1' }));
    store.append('+15550100001', msg({ sid: 'SM2', direction: 'inbound', from: '+15550100001', to: '+15550009999' }));
    expect(store.thread('+15550100001').messages.map((m) => m.sid)).toEqual(['SM1', 'SM2']);
  });

  it('updates a message state by sid', () => {
    const store = new ConversationStore();
    store.append('+15550100001', msg({ sid: 'SM1', state: 'queued' }));
    store.updateState('SM1', 'delivered');
    expect(store.thread('+15550100001').messages[0]?.state).toBe('delivered');
  });

  it('lists all threads and resets cleanly', () => {
    const store = new ConversationStore();
    store.append('+15550100001', msg());
    store.append('+15550100002', msg({ to: '+15550100002' }));
    expect(store.listThreads().length).toBe(2);
    store.reset();
    expect(store.listThreads()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- store`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the store**

```ts
// fake-twilio/src/engine/store.ts
import type { DeliveryState, Thread, ThreadMessage } from './types.js';

/** In-memory conversation store, keyed by the party (non-app) E.164 number. */
export class ConversationStore {
  private readonly threads = new Map<string, Thread>();
  private readonly bySid = new Map<string, ThreadMessage>();

  append(partyNumber: string, message: ThreadMessage): void {
    let thread = this.threads.get(partyNumber);
    if (!thread) {
      thread = { partyNumber, messages: [] };
      this.threads.set(partyNumber, thread);
    }
    thread.messages.push(message);
    this.bySid.set(message.sid, message);
  }

  updateState(sid: string, state: DeliveryState): ThreadMessage | undefined {
    const m = this.bySid.get(sid);
    if (!m) return undefined;
    m.state = state;
    // `updatedAt` is stamped by the engine (which owns the clock), not here.
    return m;
  }

  thread(partyNumber: string): Thread {
    return this.threads.get(partyNumber) ?? { partyNumber, messages: [] };
  }

  listThreads(): Thread[] {
    return [...this.threads.values()];
  }

  reset(): void {
    this.threads.clear();
    this.bySid.clear();
  }
}
```

> Note: `updatedAt` is stamped by the engine (which owns the clock), not the store. The store just holds state; Task 6 sets `updatedAt` when it calls `updateState`. Keep the store clock-free so it stays trivially testable.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- store`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add fake-twilio/src/engine/store.ts fake-twilio/test/store.test.ts
git commit -m "feat(fake-twilio): in-memory conversation store"
```

---

## Phase 4 — Engine: webhook signer (the crux)

### Task 4.1: Build + sign Twilio webhook payloads, verified by `twilio.validateRequest`

**Files:**
- Create: `fake-twilio/src/engine/signer.ts`
- Test: `fake-twilio/test/signer.test.ts`

- [ ] **Step 1: Write the failing test (the contract: our signature must satisfy the app's validator)**

```ts
// fake-twilio/test/signer.test.ts
import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { signTwilioWebhook, buildInboundSmsParams, buildStatusParams } from '../src/engine/signer.js';

const TOKEN = 'shared-secret-token';

describe('signTwilioWebhook', () => {
  it('produces a signature the app validator accepts (inbound SMS)', () => {
    const url = 'http://localhost:5173/webhooks/twilio/sms';
    const params = buildInboundSmsParams({
      messageSid: 'SMinbound1', from: '+15550100001', to: '+15550009999', body: 'hello',
    });
    const signature = signTwilioWebhook({ authToken: TOKEN, url, params });
    expect(twilio.validateRequest(TOKEN, signature, url, params)).toBe(true);
  });

  it('produces a signature the validator REJECTS when the body is tampered', () => {
    const url = 'http://localhost:5173/webhooks/twilio/sms';
    const params = buildInboundSmsParams({ messageSid: 'SMinbound1', from: '+15550100001', to: '+15550009999', body: 'hello' });
    const signature = signTwilioWebhook({ authToken: TOKEN, url, params });
    expect(twilio.validateRequest(TOKEN, signature, url, { ...params, Body: 'tampered' })).toBe(false);
  });

  it('encodes MMS media fields (NumMedia + MediaUrl{i})', () => {
    const params = buildInboundSmsParams({
      messageSid: 'MM1', from: '+15550100001', to: '+15550009999',
      mediaUrls: ['http://localhost:8889/media/cat.jpg'],
    });
    expect(params['NumMedia']).toBe('1');
    expect(params['MediaUrl0']).toBe('http://localhost:8889/media/cat.jpg');
  });

  it('builds status params with optional ErrorCode', () => {
    const p = buildStatusParams({ messageSid: 'SMout1', status: 'failed', errorCode: '30005' });
    expect(p).toMatchObject({ MessageSid: 'SMout1', MessageStatus: 'failed', ErrorCode: '30005' });
    const ok = buildStatusParams({ messageSid: 'SMout1', status: 'delivered' });
    expect(ok['ErrorCode']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- signer`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the signer (Twilio's documented HMAC-SHA1 scheme)**

```ts
// fake-twilio/src/engine/signer.ts
import { createHmac } from 'node:crypto';

export type WebhookParams = Record<string, string>;

export interface BuildInboundSmsInput {
  messageSid: string;
  from: string;
  to: string;
  body?: string;
  mediaUrls?: string[];
  optOutType?: string;
}

/** Build the application/x-www-form-urlencoded params Twilio sends for inbound SMS/MMS. */
export function buildInboundSmsParams(input: BuildInboundSmsInput): WebhookParams {
  const params: WebhookParams = {
    MessageSid: input.messageSid,
    From: input.from,
    To: input.to,
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
  };
  if (input.body !== undefined) params['Body'] = input.body;
  const media = input.mediaUrls ?? [];
  params['NumMedia'] = String(media.length);
  media.forEach((url, i) => {
    params[`MediaUrl${i}`] = url;
    params[`MediaContentType${i}`] = 'image/jpeg';
  });
  if (input.optOutType !== undefined) params['OptOutType'] = input.optOutType;
  return params;
}

export interface BuildStatusInput {
  messageSid: string;
  status: 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';
  errorCode?: string;
}

/** Build the params Twilio sends for a delivery status callback. */
export function buildStatusParams(input: BuildStatusInput): WebhookParams {
  const params: WebhookParams = {
    MessageSid: input.messageSid,
    MessageStatus: input.status,
    ApiVersion: '2010-04-01',
  };
  if (input.errorCode !== undefined) params['ErrorCode'] = input.errorCode;
  return params;
}

export interface SignInput {
  authToken: string;
  /** The exact URL the app reconstructs: `${PUBLIC_BASE_URL}${path}`. */
  url: string;
  params: WebhookParams;
}

/**
 * Compute X-Twilio-Signature exactly as Twilio does: start from the full URL,
 * append each POST param's key+value sorted by key, HMAC-SHA1 with the auth
 * token, base64. The signer.test.ts contract asserts twilio.validateRequest()
 * accepts the result — that is the real guarantee of correctness.
 */
export function signTwilioWebhook(input: SignInput): string {
  const sortedKeys = Object.keys(input.params).sort();
  let data = input.url;
  for (const key of sortedKeys) data += key + input.params[key];
  return createHmac('sha1', input.authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- signer`
Expected: PASS (all 4 tests). If the first test fails, the signing scheme is wrong — do not proceed; fix until `validateRequest` returns true.

- [ ] **Step 5: Commit**

```bash
git add fake-twilio/src/engine/signer.ts fake-twilio/test/signer.test.ts
git commit -m "feat(fake-twilio): webhook payload builders + Twilio-compatible signer"
```

---

## Phase 5 — Engine: clock, dispatcher, delivery state machine

### Task 5.1: Injectable clock + scheduler

**Files:**
- Create: `fake-twilio/src/engine/clock.ts`
- Test: `fake-twilio/test/clock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/clock.test.ts
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/engine/clock.js';

describe('ManualClock', () => {
  it('returns a fixed ISO time and advances deterministically', () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-06-15T00:00:00.000Z');
    clock.advance(1500);
    expect(clock.nowIso()).toBe('2026-06-15T00:00:01.500Z');
  });

  it('runs scheduled callbacks in order when flushed', () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const order: string[] = [];
    clock.schedule(200, () => order.push('b'));
    clock.schedule(100, () => order.push('a'));
    clock.flush();
    expect(order).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- clock`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement clock + scheduler**

```ts
// fake-twilio/src/engine/clock.ts
export interface Clock {
  nowIso(): string;
  /** Schedule a callback after `delayMs`. Returns a cancel function. */
  schedule(delayMs: number, fn: () => void): () => void;
}

/** Production clock: real time + real timers (used by the running service). */
export class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
  schedule(delayMs: number, fn: () => void): () => void {
    const t = setTimeout(fn, delayMs);
    return () => clearTimeout(t);
  }
}

/** Deterministic clock for tests: time advances only on advance()/flush(). */
export class ManualClock implements Clock {
  private ms: number;
  private queue: Array<{ at: number; fn: () => void }> = [];
  constructor(startIso: string) {
    this.ms = Date.parse(startIso);
  }
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  schedule(delayMs: number, fn: () => void): () => void {
    const entry = { at: delayMs, fn };
    this.queue.push(entry);
    return () => {
      this.queue = this.queue.filter((e) => e !== entry);
    };
  }
  /** Run all queued callbacks in ascending delay order (then clear the queue). */
  flush(): void {
    const pending = [...this.queue].sort((a, b) => a.at - b.at);
    this.queue = [];
    for (const e of pending) e.fn();
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- clock`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fake-twilio/src/engine/clock.ts fake-twilio/test/clock.test.ts
git commit -m "feat(fake-twilio): injectable clock + scheduler (deterministic in tests)"
```

### Task 5.2: Webhook dispatcher

**Files:**
- Create: `fake-twilio/src/engine/dispatcher.ts`
- Test: `fake-twilio/test/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test (captures the POST the app would receive)**

```ts
// fake-twilio/test/dispatcher.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import twilio from 'twilio';
import { WebhookDispatcher } from '../src/engine/dispatcher.js';
import { buildInboundSmsParams } from '../src/engine/signer.js';

let server: Server | undefined;
afterEach(() => server?.close());

describe('WebhookDispatcher', () => {
  it('POSTs a signed, form-encoded inbound SMS the app validator accepts', async () => {
    const TOKEN = 'shared-secret-token';
    let received: { path: string; sig: string; body: string } | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        received = {
          path: req.url ?? '',
          sig: String(req.headers['x-twilio-signature'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.statusCode = 200;
        res.end('<Response/>');
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;

    const dispatcher = new WebhookDispatcher({
      appBaseUrl: `http://127.0.0.1:${port}`,
      appPublicBaseUrl: `http://127.0.0.1:${port}`,
      authToken: TOKEN,
    });
    const params = buildInboundSmsParams({ messageSid: 'SMin1', from: '+15550100001', to: '+15550009999', body: 'hi' });
    const status = await dispatcher.post('/webhooks/twilio/sms', params);

    expect(status).toBe(200);
    expect(received?.path).toBe('/webhooks/twilio/sms');
    // The app reconstructs `${appPublicBaseUrl}/webhooks/twilio/sms` and validates.
    const url = `http://127.0.0.1:${port}/webhooks/twilio/sms`;
    const parsed = Object.fromEntries(new URLSearchParams(received!.body));
    expect(twilio.validateRequest(TOKEN, received!.sig, url, parsed)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- dispatcher`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the dispatcher**

```ts
// fake-twilio/src/engine/dispatcher.ts
import { signTwilioWebhook, type WebhookParams } from './signer.js';

export interface WebhookDispatcherDeps {
  /** Where to actually POST (the app's real address). */
  appBaseUrl: string;
  /** The app's PUBLIC_BASE_URL — used to compute the signed URL the app reconstructs. */
  appPublicBaseUrl: string;
  authToken: string;
}

/**
 * POSTs correctly-signed, form-encoded webhooks to the app. Signs against
 * `${appPublicBaseUrl}${path}` (what the app's signature middleware reconstructs)
 * while POSTing to `${appBaseUrl}${path}` (its real address) — the two may differ
 * in the e2e stack (sign vs deliver).
 */
export class WebhookDispatcher {
  constructor(private readonly deps: WebhookDispatcherDeps) {}

  async post(path: string, params: WebhookParams): Promise<number> {
    const signedUrl = `${this.deps.appPublicBaseUrl}${path}`;
    const signature = signTwilioWebhook({ authToken: this.deps.authToken, url: signedUrl, params });
    const body = new URLSearchParams(params).toString();
    const res = await fetch(`${this.deps.appBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
        // The hermetic app sits behind an origin-secret check; mirror the Vite dev header.
        'x-origin-verify': this.deps.originSecret ?? 'dev-placeholder-not-a-secret',
      },
      body,
    });
    return res.status;
  }
}
```

> **Origin-secret note:** the app rejects requests lacking `x-origin-verify` with 403 *before* routing (see `app/test/app.test.ts`). The Vite proxy injects `'dev-placeholder-not-a-secret'` in dev. Add `originSecret?: string` to `WebhookDispatcherDeps` (defaulting as shown) and confirm the e2e stack's `CF_ORIGIN_SECRET` matches this value — reconcile in Phase 10 (Task 10.1). If the hermetic app uses a different origin secret, thread it through here.

- [ ] **Step 4: Add `originSecret` to the deps interface**

Update `WebhookDispatcherDeps` to include `originSecret?: string;` so Step 3 typechecks.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- dispatcher`
Expected: PASS — status 200, validator accepts the signature.

- [ ] **Step 6: Commit**

```bash
git add fake-twilio/src/engine/dispatcher.ts fake-twilio/test/dispatcher.test.ts
git commit -m "feat(fake-twilio): signed webhook dispatcher"
```

### Task 5.3: Delivery-profile state machine

**Files:**
- Create: `fake-twilio/src/engine/delivery.ts`
- Test: `fake-twilio/test/delivery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/delivery.test.ts
import { describe, expect, it } from 'vitest';
import { plannedTransitions } from '../src/engine/delivery.js';

describe('plannedTransitions', () => {
  it('normal → queued, sent, delivered', () => {
    expect(plannedTransitions({ kind: 'normal' })).toEqual(['queued', 'sent', 'delivered']);
  });

  it('stall stops at the configured state (default sent)', () => {
    expect(plannedTransitions({ kind: 'stall' })).toEqual(['queued', 'sent']);
    expect(plannedTransitions({ kind: 'stall', stallAt: 'queued' })).toEqual(['queued']);
  });

  it('fail → queued, sent, then the fail state', () => {
    expect(plannedTransitions({ kind: 'fail' })).toEqual(['queued', 'sent', 'failed']);
    expect(plannedTransitions({ kind: 'fail', failState: 'undelivered' })).toEqual(['queued', 'sent', 'undelivered']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- delivery`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the transition planner**

```ts
// fake-twilio/src/engine/delivery.ts
import type { DeliveryProfile, DeliveryState } from './types.js';

/**
 * The ordered status states the fake emits for an outbound message under a given
 * delivery profile. Each non-initial state becomes a status callback to the app.
 */
export function plannedTransitions(profile: DeliveryProfile): DeliveryState[] {
  switch (profile.kind) {
    case 'normal':
      return ['queued', 'sent', 'delivered'];
    case 'stall': {
      const stallAt = profile.stallAt ?? 'sent';
      const full: DeliveryState[] = ['queued', 'sent', 'delivered'];
      const idx = full.indexOf(stallAt);
      return full.slice(0, idx < 0 ? full.length : idx + 1);
    }
    case 'fail':
      return ['queued', 'sent', profile.failState ?? 'failed'];
  }
}

/** Per-step delay (ms) — seeded constants, NOT Math.random, so runs are deterministic. */
export const STEP_DELAYS_MS: Record<number, number> = { 0: 0, 1: 150, 2: 350 };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- delivery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fake-twilio/src/engine/delivery.ts fake-twilio/test/delivery.test.ts
git commit -m "feat(fake-twilio): delivery-profile transition planner"
```

---

## Phase 6 — Engine: assemble `FakeTwilioEngine` with control verbs

### Task 6.1: The engine facade

**Files:**
- Create: `fake-twilio/src/engine/engine.ts`
- Test: `fake-twilio/test/engine.test.ts`

- [ ] **Step 1: Write the failing test (uses ManualClock + a stub dispatcher)**

```ts
// fake-twilio/test/engine.test.ts
import { describe, expect, it } from 'vitest';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';
import type { WebhookParams } from '../src/engine/signer.js';

function makeEngine() {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const dispatcher = { post: async (path: string, params: WebhookParams) => { posted.push({ path, params }); return 200; } };
  const engine = new FakeTwilioEngine({ clock, dispatcher });
  return { engine, clock, posted };
}

describe('FakeTwilioEngine', () => {
  it('sendAsParty records an inbound message and dispatches a signed /sms webhook', async () => {
    const { engine, posted } = makeEngine();
    const sid = await engine.sendAsParty({ from: '+15550100001', body: 'I want a 2BR' });
    expect(sid).toMatch(/^SM/);
    expect(posted[0]?.path).toBe('/webhooks/twilio/sms');
    expect(posted[0]?.params).toMatchObject({ From: '+15550100001', To: '+15550009999', Body: 'I want a 2BR' });
    const thread = engine.listThreads().find((t) => t.partyNumber === '+15550100001');
    expect(thread?.messages[0]).toMatchObject({ direction: 'inbound', body: 'I want a 2BR' });
  });

  it('recordOutboundFromApp drives status callbacks per the active delivery profile', async () => {
    const { engine, clock, posted } = makeEngine();
    engine.setDeliveryOutcome({ partyNumber: '+15550100001', profile: { kind: 'fail', failState: 'undelivered', errorCode: '30005' } });
    const sid = engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'hi' });
    clock.flush();
    await Promise.resolve(); // let scheduled async callbacks settle
    const statuses = posted.filter((p) => p.path === '/webhooks/twilio/status').map((p) => p.params['MessageStatus']);
    expect(statuses).toEqual(['queued', 'sent', 'undelivered']);
    const last = posted.filter((p) => p.path === '/webhooks/twilio/status').at(-1);
    expect(last?.params).toMatchObject({ MessageSid: sid, ErrorCode: '30005' });
  });

  it('reset clears threads and delivery overrides', async () => {
    const { engine } = makeEngine();
    await engine.sendAsParty({ from: '+15550100001', body: 'x' });
    engine.reset();
    expect(engine.listThreads()).toHaveLength(0);
  });

  it('addAdHoc lets an unknown caller send', async () => {
    const { engine, posted } = makeEngine();
    const persona = engine.addAdHoc({ label: 'Unknown', role: 'tenant' });
    await engine.sendAsParty({ from: persona.number, body: 'hello' });
    expect(posted[0]?.params['From']).toBe(persona.number);
  });

  it('rejects sendAsParty from an unknown number', async () => {
    const { engine } = makeEngine();
    await expect(engine.sendAsParty({ from: '+15559999999', body: 'x' })).rejects.toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- engine`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the engine**

```ts
// fake-twilio/src/engine/engine.ts
import type { Clock } from './clock.js';
import { PersonaRegistry, APP_NUMBER } from './registry.js';
import { ConversationStore } from './store.js';
import { buildInboundSmsParams, buildStatusParams, type WebhookParams } from './signer.js';
import { plannedTransitions, STEP_DELAYS_MS } from './delivery.js';
import type {
  AddAdHocInput, DeliveryProfile, Persona, SendAsPartyInput, SetDeliveryOutcomeInput, Thread, ThreadMessage,
} from './types.js';

/** The dispatcher surface the engine needs (real WebhookDispatcher in prod, stub in tests). */
export interface Dispatcher {
  post(path: string, params: WebhookParams): Promise<number>;
}

export interface FakeTwilioEngineDeps {
  clock: Clock;
  dispatcher: Dispatcher;
  /** Defaults to APP_NUMBER. */
  appNumber?: string;
  registry?: PersonaRegistry;
  store?: ConversationStore;
}

export class FakeTwilioEngine {
  private readonly clock: Clock;
  private readonly dispatcher: Dispatcher;
  private readonly appNumber: string;
  private readonly registry: PersonaRegistry;
  private readonly store: ConversationStore;
  private readonly nextProfile = new Map<string, DeliveryProfile>();
  private sidSeq = 0;

  constructor(deps: FakeTwilioEngineDeps) {
    this.clock = deps.clock;
    this.dispatcher = deps.dispatcher;
    this.appNumber = deps.appNumber ?? APP_NUMBER;
    this.registry = deps.registry ?? new PersonaRegistry();
    this.store = deps.store ?? new ConversationStore();
  }

  private mintSid(prefix: 'SM' | 'MM'): string {
    this.sidSeq += 1;
    return `${prefix}fake${String(this.sidSeq).padStart(8, '0')}`;
  }

  list(): Persona[] {
    return this.registry.list();
  }
  listThreads(): Thread[] {
    return this.store.listThreads();
  }
  addAdHoc(input: AddAdHocInput): Persona {
    return this.registry.addAdHoc(input);
  }
  setDeliveryOutcome(input: SetDeliveryOutcomeInput): void {
    this.nextProfile.set(input.partyNumber, input.profile);
  }
  reset(): void {
    this.store.reset();
    this.nextProfile.clear();
  }

  /** A party sends an inbound text to the app: record it + POST a signed /sms webhook. */
  async sendAsParty(input: SendAsPartyInput): Promise<string> {
    const persona = this.registry.byNumber(input.from);
    if (!persona) throw new Error(`sendAsParty: unknown party number ${input.from}`);
    const to = input.to ?? this.appNumber;
    const hasMedia = (input.mediaUrls?.length ?? 0) > 0;
    const sid = this.mintSid(hasMedia ? 'MM' : 'SM');
    const now = this.clock.nowIso();
    const message: ThreadMessage = {
      sid, direction: 'inbound', from: input.from, to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
      state: 'delivered', createdAt: now, updatedAt: now,
    };
    this.store.append(input.from, message);
    const params = buildInboundSmsParams({
      messageSid: sid, from: input.from, to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
    });
    await this.dispatcher.post('/webhooks/twilio/sms', params);
    return sid;
  }

  /**
   * Called by the REST impersonation route when the app sends an outbound message
   * (messages.create). Records it into the recipient's thread and schedules the
   * status-callback progression for the active delivery profile. Returns the SID.
   */
  recordOutboundFromApp(input: { to: string; from?: string; body?: string; mediaUrls?: string[] }): string {
    const hasMedia = (input.mediaUrls?.length ?? 0) > 0;
    const sid = this.mintSid(hasMedia ? 'MM' : 'SM');
    const now = this.clock.nowIso();
    const message: ThreadMessage = {
      sid, direction: 'outbound', from: input.from ?? this.appNumber, to: input.to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
      state: 'queued', createdAt: now, updatedAt: now,
    };
    this.store.append(input.to, message);

    const profile = this.nextProfile.get(input.to) ?? { kind: 'normal' as const };
    this.nextProfile.delete(input.to);
    const states = plannedTransitions(profile);
    states.forEach((state, i) => {
      if (i === 0) return; // 'queued' is the create response state; callbacks start at 'sent'
      this.clock.schedule(STEP_DELAYS_MS[i] ?? 350, () => {
        const updated = this.store.updateState(sid, state);
        if (updated) updated.updatedAt = this.clock.nowIso();
        const params = buildStatusParams({
          messageSid: sid, status: state,
          ...(profile.kind === 'fail' && state === (profile.failState ?? 'failed') && profile.errorCode !== undefined
            ? { errorCode: profile.errorCode }
            : {}),
        });
        void this.dispatcher.post('/webhooks/twilio/status', params);
      });
    });
    return sid;
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- engine`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Typecheck the whole package**

Run: `npm run typecheck -w @housingchoice/fake-twilio`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add fake-twilio/src/engine/engine.ts fake-twilio/test/engine.test.ts
git commit -m "feat(fake-twilio): engine facade with control verbs + status progression"
```

---

## Phase 7 — REST impersonation route (`Messages.json`)

### Task 7.1: Mount the Twilio Messages endpoint + 501 stubs

**Files:**
- Create: `fake-twilio/src/routes/rest.ts`
- Modify: `fake-twilio/src/server.ts`
- Test: `fake-twilio/test/rest.test.ts`

- [ ] **Step 1: Write the failing test (the real driver's call shape)**

```ts
// fake-twilio/test/rest.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';

function makeApp() {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', APP_BASE_URL: 'http://localhost:8080', APP_PUBLIC_BASE_URL: 'http://localhost:5173' });
  const engine = new FakeTwilioEngine({ clock: new ManualClock('2026-06-15T00:00:00.000Z'), dispatcher: { post: async () => 200 } });
  return { app: buildFakeTwilioApp({ config, engine }), engine };
}

describe('REST impersonation: POST /2010-04-01/Accounts/:sid/Messages.json', () => {
  it('accepts a form-encoded create and returns a Twilio-shaped Message', async () => {
    const { app, engine } = makeApp();
    const res = await request(app)
      .post('/2010-04-01/Accounts/ACtest/Messages.json')
      .type('form')
      .send({ To: '+15550100001', From: '+15550009999', Body: 'hello tenant' });
    expect(res.status).toBe(201);
    expect(res.body.sid).toMatch(/^SM/);
    expect(res.body.status).toBe('queued');
    expect(res.body.to).toBe('+15550100001');
    // Recorded into the recipient's thread.
    const thread = engine.listThreads().find((t) => t.partyNumber === '+15550100001');
    expect(thread?.messages[0]).toMatchObject({ direction: 'outbound', body: 'hello tenant' });
  });

  it('accepts MessagingServiceSid instead of From (the app uses a Messaging Service)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/2010-04-01/Accounts/ACtest/Messages.json')
      .type('form')
      .send({ To: '+15550100001', MessagingServiceSid: 'MGtest', Body: 'hi' });
    expect(res.status).toBe(201);
  });

  it('returns a Twilio-shaped 400 when To is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ Body: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(21604); // Twilio's "a 'To' phone number is required"
  });

  it('501s voice + number-provisioning stubs (deferred channels)', async () => {
    const { app } = makeApp();
    const calls = await request(app).post('/2010-04-01/Accounts/ACtest/Calls.json').type('form').send({});
    expect(calls.status).toBe(501);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- rest`
Expected: FAIL (`buildFakeTwilioApp` doesn't accept `engine`, route missing).

- [ ] **Step 3: Implement the REST route**

```ts
// fake-twilio/src/routes/rest.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';

/** Twilio REST impersonation: only the subset the app's driver calls today. */
export function createRestRouter(engine: FakeTwilioEngine): Router {
  const router = Router();

  // POST /2010-04-01/Accounts/:accountSid/Messages.json  (messages.create)
  router.post('/2010-04-01/Accounts/:accountSid/Messages.json', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const to = body['To'];
    if (!to) {
      res.status(400).json({ code: 21604, message: "A 'To' phone number is required.", status: 400 });
      return;
    }
    const mediaUrls = typeof body['MediaUrl'] === 'string' ? [body['MediaUrl']] : undefined;
    const sid = engine.recordOutboundFromApp({
      to,
      ...(body['From'] !== undefined && { from: body['From'] }),
      ...(body['Body'] !== undefined && { body: body['Body'] }),
      ...(mediaUrls !== undefined && { mediaUrls }),
    });
    // Twilio-shaped Message resource (snake_case JSON, as the SDK expects).
    res.status(201).json({
      sid,
      status: 'queued',
      to,
      from: body['From'] ?? null,
      body: body['Body'] ?? null,
      messaging_service_sid: body['MessagingServiceSid'] ?? null,
      date_created: new Date().toUTCString(),
      num_media: mediaUrls ? String(mediaUrls.length) : '0',
    });
  });

  // Deferred channels — visible 501 seams (voice, number provisioning).
  const notImplemented = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(501).json({ code: 0, message: 'not-implemented-in-v1 (fake-twilio: SMS/MMS only)', status: 501 });
  router.post('/2010-04-01/Accounts/:accountSid/Calls.json', notImplemented as never);
  router.get('/2010-04-01/Accounts/:accountSid/AvailablePhoneNumbers/:country/Local.json', notImplemented as never);
  router.post('/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers.json', notImplemented as never);

  return router;
}
```

- [ ] **Step 4: Wire the engine + router into `buildFakeTwilioApp`**

Modify `fake-twilio/src/server.ts`:

```ts
import express, { type Express } from 'express';
import type { FakeTwilioConfig } from './config.js';
import { FakeTwilioEngine } from './engine/engine.js';
import { RealClock } from './engine/clock.js';
import { WebhookDispatcher } from './engine/dispatcher.js';
import { createRestRouter } from './routes/rest.js';

export interface FakeTwilioAppDeps {
  config: FakeTwilioConfig;
  /** Injectable for tests; defaults to a real-clock engine with a real dispatcher. */
  engine?: FakeTwilioEngine;
}

export function buildFakeTwilioApp(deps: FakeTwilioAppDeps): Express {
  const engine =
    deps.engine ??
    new FakeTwilioEngine({
      clock: new RealClock(),
      dispatcher: new WebhookDispatcher({
        appBaseUrl: deps.config.appBaseUrl,
        appPublicBaseUrl: deps.config.appPublicBaseUrl,
        authToken: deps.config.authToken,
      }),
    });

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'fake-twilio' });
  });

  app.use(createRestRouter(engine));
  return app;
}
```

> The `index.ts` entry needs the engine to be reachable by the control router too (Phase 8). Refactor `buildFakeTwilioApp` to construct the engine once and pass it to BOTH routers; expose it on the return if helpful. Keep a single engine instance per process.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- rest`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Commit**

```bash
git add fake-twilio/src/routes/rest.ts fake-twilio/src/server.ts fake-twilio/test/rest.test.ts
git commit -m "feat(fake-twilio): Twilio REST impersonation for Messages.json + 501 seams"
```

---

## Phase 8 — Control API

### Task 8.1: Control routes (sendAsParty, listThreads, reset, addAdHoc, setDeliveryOutcome)

**Files:**
- Create: `fake-twilio/src/routes/control.ts`
- Modify: `fake-twilio/src/server.ts` (mount control router with the shared engine)
- Test: `fake-twilio/test/control.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/control.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';
import type { WebhookParams } from '../src/engine/signer.js';

function makeApp() {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', APP_BASE_URL: 'http://localhost:8080', APP_PUBLIC_BASE_URL: 'http://localhost:5173' });
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const engine = new FakeTwilioEngine({
    clock: new ManualClock('2026-06-15T00:00:00.000Z'),
    dispatcher: { post: async (path, params) => { posted.push({ path, params }); return 200; } },
  });
  return { app: buildFakeTwilioApp({ config, engine }), posted };
}

describe('control API', () => {
  it('POST /control/send-as-party dispatches an inbound webhook and returns the sid', async () => {
    const { app, posted } = makeApp();
    const res = await request(app).post('/control/send-as-party').send({ from: '+15550100001', body: 'hi there' });
    expect(res.status).toBe(200);
    expect(res.body.sid).toMatch(/^SM/);
    expect(posted[0]?.path).toBe('/webhooks/twilio/sms');
  });

  it('GET /control/threads returns the conversation store', async () => {
    const { app } = makeApp();
    await request(app).post('/control/send-as-party').send({ from: '+15550100001', body: 'hi' });
    const res = await request(app).get('/control/threads');
    expect(res.status).toBe(200);
    expect(res.body.threads.find((t: { partyNumber: string }) => t.partyNumber === '+15550100001')).toBeTruthy();
  });

  it('POST /control/personas/ad-hoc mints a persona', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/personas/ad-hoc').send({ label: 'Unknown', role: 'tenant' });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^\+1555/);
  });

  it('POST /control/delivery-outcome sets the next outbound profile', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/delivery-outcome').send({ partyNumber: '+15550100001', profile: { kind: 'fail', errorCode: '30005' } });
    expect(res.status).toBe(200);
  });

  it('POST /control/reset clears threads', async () => {
    const { app } = makeApp();
    await request(app).post('/control/send-as-party').send({ from: '+15550100001', body: 'hi' });
    await request(app).post('/control/reset').send({});
    const res = await request(app).get('/control/threads');
    expect(res.body.threads).toHaveLength(0);
  });

  it('400s send-as-party from an unknown number', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/send-as-party').send({ from: '+15559999999', body: 'x' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w @housingchoice/fake-twilio -- control`
Expected: FAIL (route missing).

- [ ] **Step 3: Implement the control router**

```ts
// fake-twilio/src/routes/control.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';
import type { AddAdHocInput, SendAsPartyInput, SetDeliveryOutcomeInput } from '../engine/types.js';

/** The control surface shared by scripted tests and (in Plan 2) the fake-phones UI. */
export function createControlRouter(engine: FakeTwilioEngine): Router {
  const router = Router();

  router.get('/control/personas', (_req, res) => {
    res.status(200).json({ personas: engine.list() });
  });

  router.post('/control/personas/ad-hoc', (req, res) => {
    try {
      const persona = engine.addAdHoc(req.body as AddAdHocInput);
      res.status(201).json(persona);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/control/send-as-party', async (req, res) => {
    try {
      const sid = await engine.sendAsParty(req.body as SendAsPartyInput);
      res.status(200).json({ sid });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/control/threads', (_req, res) => {
    res.status(200).json({ threads: engine.listThreads() });
  });

  router.post('/control/delivery-outcome', (req, res) => {
    engine.setDeliveryOutcome(req.body as SetDeliveryOutcomeInput);
    res.status(200).json({ ok: true });
  });

  router.post('/control/reset', (_req, res) => {
    engine.reset();
    res.status(200).json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Mount the control router in `buildFakeTwilioApp`**

Add to `fake-twilio/src/server.ts` after the REST router:

```ts
import { createControlRouter } from './routes/control.js';
// ...
app.use(createRestRouter(engine));
app.use(createControlRouter(engine));
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npm run test -w @housingchoice/fake-twilio -- control`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Run the full package suite + typecheck**

Run: `npm run test -w @housingchoice/fake-twilio` then `npm run typecheck -w @housingchoice/fake-twilio`
Expected: all green, types clean.

- [ ] **Step 7: Commit**

```bash
git add fake-twilio/src/routes/control.ts fake-twilio/src/server.ts fake-twilio/test/control.test.ts
git commit -m "feat(fake-twilio): control API for scripted scenarios"
```

---

## Phase 9 — App wiring: config + driver redirection

### Task 9.1: Add `TWILIO_API_BASE_URL` to config (prod fail-closed)

**Files:**
- Modify: `app/src/lib/config.ts`
- Test: `app/test/config.test.ts` (add cases; create if a focused config test file doesn't exist — check first)

- [ ] **Step 1: Confirm the config test location**

Run: search for an existing `app/test/config*.test.ts`. If present, extend it. If not, create `app/test/configTwilioApiBaseUrl.test.ts`.

- [ ] **Step 2: Write the failing test**

```ts
// app/test/configTwilioApiBaseUrl.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

describe('TWILIO_API_BASE_URL config', () => {
  it('is read in non-production', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', TWILIO_API_BASE_URL: 'http://localhost:8889' });
    expect(cfg.twilioApiBaseUrl).toBe('http://localhost:8889');
  });

  it('defaults to undefined when unset', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.twilioApiBaseUrl).toBeUndefined();
  });

  it('is REJECTED (throws) when set in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', TWILIO_API_BASE_URL: 'http://evil', MESSAGING_DRIVER: 'console' }),
    ).toThrow(/TWILIO_API_BASE_URL/);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm run test -w app -- configTwilioApiBaseUrl`
Expected: FAIL (`twilioApiBaseUrl` undefined on the type / no throw in prod).

- [ ] **Step 4: Add the field to the `AppConfig` interface**

In `app/src/lib/config.ts`, after the `twilioMessagingServiceSid?: string;` declaration:

```ts
  /**
   * Dev-only override of the Twilio REST base URL (e.g. http://localhost:8889 for
   * the fake-twilio service). Redirects the real TwilioMessagingDriver to a fake
   * host so the production driver path is exercised in tests. REJECTED in
   * production (fail-closed) — deployed stacks always use the real Twilio host.
   */
  twilioApiBaseUrl?: string;
```

- [ ] **Step 5: Add the prod fail-closed guard in the loader**

In the loader, alongside the other dev-only gates (mirroring the `DEV_AUTH_ENABLED` pattern):

```ts
  const twilioApiBaseUrl = env.TWILIO_API_BASE_URL?.trim();
  if (twilioApiBaseUrl !== undefined && twilioApiBaseUrl.length > 0 && nodeEnv === 'production') {
    throw new Error(
      'TWILIO_API_BASE_URL is set while NODE_ENV=production — refusing to start. It is a dev-only ' +
        'override that redirects Twilio REST calls to a fake host; production must use the real Twilio endpoint.',
    );
  }
```

And in the returned object, near the other `twilio*` assignments:

```ts
    twilioApiBaseUrl: twilioApiBaseUrl !== undefined && twilioApiBaseUrl.length > 0 ? twilioApiBaseUrl : undefined,
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `npm run test -w app -- configTwilioApiBaseUrl`
Expected: PASS (all 3).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/config.ts app/test/configTwilioApiBaseUrl.test.ts
git commit -m "feat(config): TWILIO_API_BASE_URL dev override (fail-closed in production)"
```

### Task 9.2: Thread `apiBaseUrl` into the driver + factory

**Files:**
- Modify: `app/src/adapters/messaging.ts`
- Test: `app/test/messagingApiBaseUrl.test.ts`

- [ ] **Step 1: Write the failing test (the driver builds a redirected client)**

```ts
// app/test/messagingApiBaseUrl.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createMessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';

let server: Server | undefined;
afterEach(() => server?.close());

describe('messaging driver honors TWILIO_API_BASE_URL', () => {
  it('sends messages.create to the fake host when apiBaseUrl is set', async () => {
    let hitPath = '';
    server = createServer((req, res) => {
      hitPath = req.url ?? '';
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sid: 'SMfake1', status: 'queued', date_created: 'Sun, 15 Jun 2026 14:00:00 +0000' }));
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 's',
      MESSAGING_DRIVER: 'twilio',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_API_KEY_SID: 'SKtest',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
      TWILIO_API_BASE_URL: `http://127.0.0.1:${addr.port}`,
      OUR_PHONE_NUMBERS: '+15550009999',
    });
    const adapter = createMessagingAdapter({ config });
    const result = await adapter.sendMessage({ to: '+15550100001', body: 'hi', idempotencyKey: 'k1' });

    expect(result.providerSid).toBe('SMfake1');
    expect(hitPath).toContain('/2010-04-01/Accounts/ACtest/Messages.json');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -w app -- messagingApiBaseUrl`
Expected: FAIL (driver still hits real Twilio host / `apiBaseUrl` not honored).

- [ ] **Step 3: Add `apiBaseUrl` to `TwilioMessagingDriverDeps` and use the redirecting client**

In `app/src/adapters/messaging.ts`:

```ts
import { createRedirectingHttpClient } from './twilioHttpClient.js';
```

Add to `TwilioMessagingDriverDeps`:

```ts
  /** Dev-only: redirect REST calls to this base URL (the fake-twilio host). */
  apiBaseUrl?: string;
```

Change the client construction in the constructor:

```ts
    this.client =
      deps.client ??
      twilio(deps.apiKeySid, deps.apiKeySecret, {
        accountSid: deps.accountSid,
        ...(deps.apiBaseUrl !== undefined && {
          httpClient: createRedirectingHttpClient({ baseUrl: deps.apiBaseUrl }),
        }),
      });
```

- [ ] **Step 4: Pass `apiBaseUrl` from the factory**

In `createMessagingAdapter`, in the `TwilioMessagingDriver` construction, add:

```ts
      ...(config.twilioApiBaseUrl !== undefined && { apiBaseUrl: config.twilioApiBaseUrl }),
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npm run test -w app -- messagingApiBaseUrl`
Expected: PASS — `providerSid === 'SMfake1'`, path hit the fake host.

- [ ] **Step 6: Run the existing messaging tests to ensure no regression**

Run: `npm run test -w app -- messaging`
Expected: all green (the new branch only activates when `apiBaseUrl` is set).

- [ ] **Step 7: Commit**

```bash
git add app/src/adapters/messaging.ts app/test/messagingApiBaseUrl.test.ts
git commit -m "feat(messaging): redirect driver to TWILIO_API_BASE_URL when configured"
```

---

## Phase 10 — Integrate the fake-twilio service into the e2e stack

### Task 10.1: Start fake-twilio in `e2e-session.mjs` and point the app at it

**Files:**
- Modify: `scripts/e2e-session.mjs`

- [ ] **Step 1: Read `scripts/e2e-session.mjs` fully**

Confirm: `spawnNode(label, args, cwd?)`, the `childEnv` block, the `startApp`/`startWorker`/`startVite` functions, `restartBackend()`, `shutdown()`, and `waitForHealth()`. Note the actual value used for the app's origin-secret (search for `CF_ORIGIN_SECRET` / `x-origin-verify`). The dispatcher's `originSecret` (Task 5.2) must equal whatever the hermetic app expects.

- [ ] **Step 2: Add fake-twilio env + a start function**

Extend `childEnv` so the APP runs the real Twilio driver pointed at the fake, with signatures enforced:

```js
  // --- fake-twilio (HTTP-seam messaging mock) ---
  MESSAGING_DRIVER: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACfake000000000000000000000000000',
  TWILIO_API_KEY_SID: 'SKfake000000000000000000000000000',
  TWILIO_API_KEY_SECRET: 'fake-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGfake000000000000000000000000000',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? 'hermetic-shared-twilio-token',
  TWILIO_API_BASE_URL: 'http://localhost:8889',
  OUR_PHONE_NUMBERS: '+15550009999',
```

> This replaces the previous reliance on `MESSAGING_DRIVER=console`. Keep `MESSAGING_RECORD_OUTBOX: '1'` so the deprecated outbox specs still pass during the transition (Phase 12).

Add a start function and a fake-twilio child env:

```js
function startFakeTwilio() {
  spawnNode('fake-twilio', ['--import', 'tsx', path.join('fake-twilio', 'src', 'index.ts')], undefined, {
    ...childEnv,
    FAKE_TWILIO_PORT: '8889',
    APP_BASE_URL: 'http://localhost:8080',           // POST webhooks to the app directly
    APP_PUBLIC_BASE_URL: childEnv.PUBLIC_BASE_URL,    // sign against the app's reconstructed URL (5173)
    // CF_ORIGIN_SECRET is inherited so the dispatcher can satisfy the origin check.
  });
}
```

> If `spawnNode` doesn't currently accept a per-child env override, extend its signature to `spawnNode(label, args, cwd, envOverride)` and merge `envOverride` over `childEnv`. Make the dispatcher read `CF_ORIGIN_SECRET` (Task 5.2's `originSecret`) — set `originSecret: deps.config.originSecret` and add `originSecret` to `FakeTwilioConfig`/`loadFakeConfig` from `env.CF_ORIGIN_SECRET`.

- [ ] **Step 3: Boot fake-twilio before the app and restart it with the backend**

In `main()`, start fake-twilio after DynamoDB/seed and before/alongside the app (order isn't critical since the app only calls it on send, but starting it first avoids a race on the very first outbound). Add `waitForHealth('http://localhost:8889/health')` (generalize `waitForHealth` to take a URL if it's currently hardcoded to :8080). In `restartBackend()`, also kill+respawn fake-twilio so a code change to it is picked up. In `shutdown()`, confirm the `spawnNode` child is killed (it is, if tracked in the children list).

- [ ] **Step 4: Manually verify the stack boots end-to-end**

Run: `npm run e2e:session`
Expected: logs show DynamoDB up, tables, seed, `fake-twilio listening on :8889`, app health OK, Vite up. In another shell:

```bash
curl -s http://localhost:8889/health
curl -s -X POST http://localhost:8889/control/send-as-party -H 'content-type: application/json' -d '{"from":"+15550100001","body":"e2e smoke"}'
curl -s 'http://localhost:8080/__dev/outbox' # (origin header handled by direct call may 403 — use the Vite-proxied :5173 if so)
```

Expected: `send-as-party` returns a `{ sid }`; the app processes the inbound (check app logs for the inbound pipeline). Then `npm run e2e:stop`.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-session.mjs
git commit -m "feat(e2e): run fake-twilio in the hermetic stack; app uses the real driver against it"
```

---

## Phase 11 — End-to-end proof: a scripted multi-party flow

### Task 11.1: A control-API-driven integration test (the convention)

**Files:**
- Create: `e2e/fixtures/fakeTwilio.ts`
- Create: `e2e/tests/flows/fake-twilio-sms.spec.ts`

- [ ] **Step 1: Write the fake-twilio fixture (control-API client)**

```ts
// e2e/fixtures/fakeTwilio.ts
import type { APIRequestContext } from '@playwright/test';

const FAKE_BASE = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

export interface FakeThread {
  partyNumber: string;
  messages: Array<{ sid: string; direction: 'inbound' | 'outbound'; body?: string; state: string }>;
}

export async function sendAsParty(request: APIRequestContext, input: { from: string; body?: string; to?: string }): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/send-as-party`, { data: input });
  if (!res.ok()) throw new Error(`send-as-party failed: ${res.status()}`);
  return (await res.json()).sid as string;
}

export async function listThreads(request: APIRequestContext): Promise<FakeThread[]> {
  const res = await request.get(`${FAKE_BASE}/control/threads`);
  if (!res.ok()) throw new Error(`threads failed: ${res.status()}`);
  return (await res.json()).threads as FakeThread[];
}

export async function setDeliveryOutcome(
  request: APIRequestContext,
  input: { partyNumber: string; profile: { kind: 'normal' | 'stall' | 'fail'; failState?: string; errorCode?: string; stallAt?: string } },
): Promise<void> {
  const res = await request.post(`${FAKE_BASE}/control/delivery-outcome`, { data: input });
  if (!res.ok()) throw new Error(`delivery-outcome failed: ${res.status()}`);
}

export async function resetFake(request: APIRequestContext): Promise<void> {
  await request.post(`${FAKE_BASE}/control/reset`, { data: {} });
}
```

- [ ] **Step 2: Write the failing spec (inbound text → app conversation → outbound delivered)**

```ts
// e2e/tests/flows/fake-twilio-sms.spec.ts
import { test, expect } from '../../fixtures/auth.js';
import { sendAsParty, listThreads } from '../../fixtures/fakeTwilio.js';

// HTTP-seam proof: an inbound SMS from the seeded tenant, delivered through the
// fake-twilio service with a REAL signature, is processed by the real app
// (signature middleware + inbound pipeline). Then a staff reply goes out through
// the real TwilioMessagingDriver → fake REST → status callbacks land back.
test('inbound SMS via fake-twilio reaches the staff inbox; reply round-trips', async ({ request, vaPage }) => {
  const tenant = '+15550100001';
  const stamp = `${Date.now()}`.slice(-7);
  const inbound = `Looking for a 2BR ${stamp}`;

  // 1) Tenant texts in through the fake (signed webhook → app /webhooks/twilio/sms).
  await sendAsParty(request, { from: tenant, body: inbound });

  // 2) The message surfaces in the staff dashboard inbox (proves the app accepted
  //    the SIGNED webhook and ran the inbound pipeline).
  await vaPage.goto('/');
  await expect(vaPage.getByText(inbound)).toBeVisible({ timeout: 10_000 });

  // 3) Staff opens the thread and replies; the reply goes out via the real driver.
  await vaPage.getByText(inbound).click();
  const reply = `Yes — touring this week? ${stamp}`;
  await vaPage.getByRole('textbox', { name: /message/i }).fill(reply);
  await vaPage.getByRole('button', { name: /send/i }).click();

  // 4) PROOF OF SEND: the outbound reply landed in the tenant's fake thread, and
  //    its delivery status progressed (status callbacks were accepted by the app).
  await expect
    .poll(async () => {
      const threads = await listThreads(request);
      const t = threads.find((x) => x.partyNumber === tenant);
      return t?.messages.some((m) => m.direction === 'outbound' && m.body === reply && m.state === 'delivered') ?? false;
    }, { timeout: 10_000 })
    .toBe(true);
});
```

> Selector names (`textbox name=/message/i`, `button name=/send/i`, the inbox text target) must be reconciled against the real dashboard — consult [`e2e/support/selectors.md`](../../../e2e/support/selectors.md) and existing specs like `intake-to-reply.spec.ts` for the exact accessible names. Adjust to match; do not invent selectors.

- [ ] **Step 3: Run the spec against a live session**

Run: `npm run e2e:session` (separate shell), then `npm run e2e -- fake-twilio-sms`
Expected: PASS. If step 2 fails, check app logs for a 403 (signature/origin mismatch) — that points to a token or `PUBLIC_BASE_URL` mismatch between the app and the dispatcher (Phase 10).

- [ ] **Step 4: Add a failure-injection assertion**

Append a second test to the same spec: call `setDeliveryOutcome({ partyNumber: tenant, profile: { kind: 'fail', failState: 'undelivered', errorCode: '30005' } })` BEFORE the staff reply, then assert the outbound message ends in state `undelivered` in the fake thread AND that the app surfaced the failure (e.g. the conversation/message shows a failed indicator — reconcile the exact UI affordance against the dashboard; if none exists yet, assert via the app API the message status is `undelivered`).

```ts
test('a staff reply that Twilio reports undelivered is reflected as failed', async ({ request, vaPage }) => {
  const tenant = '+15550100001';
  const stamp = `${Date.now()}`.slice(-7);
  await sendAsParty(request, { from: tenant, body: `ping ${stamp}` });
  await setDeliveryOutcome(request, { partyNumber: tenant, profile: { kind: 'fail', failState: 'undelivered', errorCode: '30005' } });

  await vaPage.goto('/');
  await vaPage.getByText(`ping ${stamp}`).click();
  const reply = `reply ${stamp}`;
  await vaPage.getByRole('textbox', { name: /message/i }).fill(reply);
  await vaPage.getByRole('button', { name: /send/i }).click();

  await expect
    .poll(async () => {
      const threads = await listThreads(request);
      const t = threads.find((x) => x.partyNumber === tenant);
      return t?.messages.find((m) => m.body === reply)?.state;
    }, { timeout: 10_000 })
    .toBe('undelivered');
});
```

- [ ] **Step 5: Run both specs**

Run: `npm run e2e -- fake-twilio-sms`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add e2e/fixtures/fakeTwilio.ts e2e/tests/flows/fake-twilio-sms.spec.ts
git commit -m "test(e2e): control-API-driven SMS round-trip + failure injection through fake-twilio"
```

---

## Phase 12 — Deprecate `/__dev/outbox`

### Task 12.1: Signpost the outbox as deprecated (keep it green)

**Files:**
- Modify: `app/src/adapters/recordingMessaging.ts`
- Modify: `app/src/routes/dev.ts`
- Modify: `e2e/fixtures/outbox.ts`

- [ ] **Step 1: Add `@deprecated` JSDoc to `RecordingMessagingDriver`**

Prepend to the class doc comment in `app/src/adapters/recordingMessaging.ts`:

```ts
/**
 * @deprecated Outbound-only proof-of-send log. New tests should assert against the
 * fake-twilio thread store (`GET /control/threads`), which captures BOTH directions
 * plus delivery-status progression. Retained only so the three pre-existing green
 * specs (outbox / intake-to-reply / boards) don't churn. Do not add new reliance.
 *
 * Decorates a MessagingAdapter: delegates every method to `inner`, and after a
 * successful send also persists the outbound message to the dev-only outbox table…
 */
```

- [ ] **Step 2: Add a deprecation header comment to the `/__dev/outbox` handler**

In `app/src/routes/dev.ts`, above `router.get('/__dev/outbox', …)`:

```ts
  // DEPRECATED proof-of-send log — outbound-only. New tests should assert against
  // the fake-twilio thread store (GET /control/threads on the fake-twilio service),
  // which captures both directions + delivery status. Retained only so the three
  // pre-existing green specs don't churn; do not extend.
  // GET /__dev/outbox?to=&since= — recorded outbound messages (newest last).
```

- [ ] **Step 3: Add `@deprecated` JSDoc to the `getOutbox` fixture**

In `e2e/fixtures/outbox.ts`, above `export async function getOutbox`:

```ts
/**
 * @deprecated Outbound-only proof-of-send. Prefer e2e/fixtures/fakeTwilio.ts
 * (`listThreads`), which captures both directions + delivery status via the
 * fake-twilio control API. Kept for the three pre-existing specs only.
 */
```

- [ ] **Step 4: Verify nothing broke (the three specs still pass)**

Run: `npm run e2e:session` (separate shell), then `npm run e2e -- outbox intake-to-reply boards`
Expected: all three specs PASS unchanged (the outbox decorator still records sends; the new driver path doesn't remove it).

> Note: with Phase 10 switching the app to `MESSAGING_DRIVER=twilio` against the fake, confirm the outbox decorator still wraps the Twilio driver (it does — `createMessagingAdapter` wraps when `config.recordOutbox`, regardless of driver). If any of the three specs now fail because outbound sends route through the fake, treat it as a real integration finding: the sends still occur (the fake's REST endpoint returns a SID), so the decorator still records them. Debug via app logs before changing the specs.

- [ ] **Step 5: Commit**

```bash
git add app/src/adapters/recordingMessaging.ts app/src/routes/dev.ts e2e/fixtures/outbox.ts
git commit -m "docs(deprecate): mark /__dev/outbox superseded by fake-twilio thread store"
```

---

## Phase 13 — Final verification

### Task 13.1: Full green sweep

- [ ] **Step 1: fake-twilio unit/integration suite**

Run: `npm run test -w @housingchoice/fake-twilio`
Expected: all green.

- [ ] **Step 2: app suite (no regressions)**

Run: `npm run test -w app`
Expected: all green (including the new config + messaging tests; existing twilioWebhookHarness tests unaffected).

- [ ] **Step 3: typecheck both packages**

Run: `npm run typecheck -w app` and `npm run typecheck -w @housingchoice/fake-twilio`
Expected: clean.

- [ ] **Step 4: full e2e suite**

Run: `npm run e2e`
Expected: all specs green, including the new `fake-twilio-sms` flow and the three (now deprecated) outbox specs.

- [ ] **Step 5: Update the RUNBOOK**

Per the RUNBOOK-ownership convention, add a short "fake-twilio (HTTP-seam messaging mock)" section to `RUNBOOK.md`: what it is, that it's dev/e2e-only and refuses to boot in production, the `:8889` port, the control-API endpoints, and how the app is pointed at it (`TWILIO_API_BASE_URL`). Keep it to the operational facts.

- [ ] **Step 6: Commit**

```bash
git add RUNBOOK.md
git commit -m "docs(runbook): document the fake-twilio HTTP-seam messaging mock"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** engine/registry/store/signer/dispatcher/delivery/control (Phases 2–8) ✓; HTTP-seam REST impersonation (Phase 7) ✓; signed webhooks exercising real middleware (Phases 4–5, 11) ✓; seeded+ad-hoc personas (Phase 2) ✓; configurable async delivery with stall/fail (Phases 5–6, 11) ✓; control-API convention (Phases 8, 11) ✓; app wiring + prod fail-closed (Phase 9) ✓; e2e-stack integration (Phase 10) ✓; outbox deprecation (Phase 12) ✓; three-guard prod-safety = separate artifact (Phase 0) + boot guard (Task 0.2) + config fail-closed (Task 9.1) ✓. **Out of scope by design (Plan 2):** the fake-phones web UI, SSE streaming, canned MMS image set, per-thread UI delivery toggle. **Deferred (501 seams):** voice, RCS, number provisioning.
- **Known reconciliation points** (verify against the live code, don't assume): the exact `twilio` `RequestClient` import path (Task 1.1 spike); the hermetic app's origin-secret value vs the dispatcher header (Tasks 5.2 + 10.1); dashboard selector accessible names (Task 11.1); whether `spawnNode` needs a per-child env arg (Task 10.1).
- **Type consistency:** `WebhookParams` (signer) is the single param type used by signer/dispatcher/engine; `DeliveryProfile`/`DeliveryState` (types.ts) are used by delivery/engine/control; `Dispatcher` interface (engine.ts) is satisfied by the real `WebhookDispatcher` and the test stub.
```
