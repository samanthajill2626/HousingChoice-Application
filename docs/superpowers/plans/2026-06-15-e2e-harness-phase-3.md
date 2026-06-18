<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# E2E Harness — Phase 3: Recording driver, outbox & reseed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make outbound messages observable and the local stack resettable for tests: a dev-only recording messaging driver persists every outbound send to a `hc-local-dev-outbox` DynamoDB table (shared by app + worker), a gated `GET /__dev/outbox` exposes them, and a gated `POST /__dev/reseed` resets local data — proven by an e2e test that triggers a synchronous send and asserts it lands in the outbox, then reseeds and asserts it's gone.

**Architecture:** A `RecordingMessagingDriver` *decorates* the existing console/twilio driver — delegating every method, and additionally persisting each `sendMessage` to the outbox table. It is selected by wrapping inside `createMessagingAdapter` when a new dev-only `config.recordOutbox` flag is set (`MESSAGING_RECORD_OUTBOX`, with a production fail-fast, mirroring `DEV_AUTH_ENABLED`). The outbox table is created lazily (`ensureTable`) and is NEVER added to the shared `TABLES`/terraform defs. The outbox + reseed endpoints live in the existing gated dev router. `reseed` calls a guarded `resetLocalData()` that refuses to run against anything but a hermetic `hc-local-` + local-endpoint stack.

**Tech Stack:** Express 5, TypeScript ESM (NodeNext, `.js` imports), AWS SDK v3 DynamoDB DocumentClient, Vitest (+ integration tests against DynamoDB Local), Playwright.

**Working directory:** worktree `w:/tmp/hc-e2e-worktree` on branch `e2e-testing-harness`. Do NOT switch branches or touch the main checkout. Commit on the current branch. **Docker must be running** (DynamoDB Local) for the integration + e2e steps.

---

## Spec reference

Implements **Phase 3** of `docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md` (§3 dev endpoints, §5 recording driver, §11). Resolves the §14 open question in favor of a separate `MESSAGING_RECORD_OUTBOX` flag + decorator (not a new `MESSAGING_DRIVER` value). Builds on the Phase 1/2 gated dev router.

## Facts this plan relies on (verified against the codebase)

- **Adapter** (`app/src/adapters/messaging.ts`): `interface MessagingAdapter { sendMessage(p: SendMessageParams): Promise<SendMessageResult>; getMediaStream(url): Promise<Readable>; getRecordingStream(url): Promise<Readable>; provisionPhoneNumber(o:{voiceCapable:true;areaCode?:string}): Promise<ProvisionPhoneNumberResult>; setVoiceWebhook(phone,url): Promise<void>; initiateCall(p: InitiateCallParams): Promise<InitiateCallResult>; }`. `SendMessageParams = { to: string; body?: string; mediaUrls?: string[]; idempotencyKey?: string; from?: string }`. `SendMessageResult = { providerSid: string; status: DeliveryStatus; providerTs: string }`. `createMessagingAdapter(deps)` switches on `config.messagingDriver` and returns the console or twilio driver. Called from `jobs/relayFanOut.ts`, `routes/webhooks/twilio.ts`, `routes/webhooks/voice.ts`, `services/poolNumbers.ts`, and (via default) the send path.
- **Config** (`app/src/lib/config.ts`): `tableName(base, env=process.env) = `${env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX}${base}``. `MessagingDriverName='twilio'|'console'` (leave unchanged). `devAuthEnabled` + its top-of-`loadConfig` fail-fast already exist — add `recordOutbox` right beside them. `config.dynamodbEndpoint` and `config.awsRegion` exist.
- **Dynamo** (`app/src/lib/dynamo.ts`): `createDynamoClient({config|endpoint})` and `createDocumentClient({config})` (the doc client sets `removeUndefinedValues: true`).
- **Table admin** (`app/src/lib/dynamoAdmin.ts`): `ensureTable(client, spec: TableSpec, physicalName): Promise<...>` — idempotent (tolerates `ResourceInUseException`), waits until active. `TableSpec` (in `app/src/lib/tables.ts`) has `{ baseName, hashKey:{name,type}, rangeKey?, gsis?, ttlAttribute?, ... }`. `TABLES` is the exported array of shared specs.
- **Seed** (`app/scripts/db-seed.ts`): exports `seedAll(endpoint: string): Promise<number>` (idempotent PutCommands; does NOT clear first). Top-level script calls it.
- **Synchronous send** (`app/src/routes/public.ts` `POST /public/housing-fair`): on a first-time signup it `await sendMessage({ conversationId, body: renderWelcome(firstName), automated: true })` IN-REQUEST (via `services/sendMessage.ts`, which calls `adapter.sendMessage` synchronously and the adapter is built from `createMessagingAdapter`). Unauthenticated. The `to` is the signup phone; the body contains the first name.
- **Vite proxy** (`dashboard/vite.config.ts`): `appProxy` (target `:8080`, header `x-origin-verify`) is applied to `/api`, `/auth`, `/public` — NOT `/__dev`. Add `/__dev`.
- **Gating**: the dev router is mounted before the origin-secret validator and `/__dev/` is exempt; reachable without the header. Recording flag must be set on the e2e `webServer` (like `DEV_AUTH_ENABLED`).
- **Integration test pattern**: files named `*.integration.test.ts` (e.g. `app/test/dynamo.integration.test.ts`) connect to DynamoDB Local. FOLLOW that file's exact setup for endpoint/prefix/client construction in the new integration tests below.
- ESM NodeNext: `.js` on all relative imports. `removeUndefinedValues` is on, but prefer conditional spreads for optional fields to keep records clean.

---

## File structure (what this phase creates/changes)

- Modify `app/src/lib/config.ts` — add `recordOutbox: boolean` + `MESSAGING_RECORD_OUTBOX` parse + prod fail-fast.
- Create `app/src/adapters/recordingMessaging.ts` — `RecordingMessagingDriver` + `OUTBOX_TABLE_BASE` + `OutboxRecord`.
- Modify `app/src/adapters/messaging.ts` — wrap the base driver in `createMessagingAdapter` when `config.recordOutbox`.
- Create `app/src/lib/devReset.ts` — guarded `resetLocalData()` + generic `clearTable()`.
- Modify `app/src/routes/dev.ts` — `GET /__dev/outbox`, `POST /__dev/reseed` (+ deps for a doc client).
- Modify `app/scripts/db-seed.ts` — export `clearAllSeedTables(endpoint)` (used by reset) if not trivially expressible via clearTable (see Task 3).
- Modify `dashboard/vite.config.ts` — proxy `/__dev` to the app.
- Modify `e2e/playwright.config.ts` — add `MESSAGING_RECORD_OUTBOX: '1'` to `webServer.env`.
- Create `e2e/fixtures/outbox.ts`, `e2e/fixtures/reseed.ts`, `e2e/tests/flows/outbox.spec.ts`.
- Tests: `app/test/recordingMessaging.integration.test.ts`, `app/test/devOutbox.integration.test.ts`, plus config cases in `app/test/devGating.test.ts`.

---

## Task 1: `recordOutbox` config flag + prod fail-fast (TDD)

**Files:** Test `app/test/devGating.test.ts`; Modify `app/src/lib/config.ts`

- [ ] **Step 1: Add failing config tests** — append to the `describe('dev gating — config', ...)` block in `app/test/devGating.test.ts`:

```ts
  it('parses MESSAGING_RECORD_OUTBOX truthy values outside production', () => {
    for (const v of ['true', '1', 'yes', 'TRUE']) {
      expect(
        loadConfig({ NODE_ENV: 'test', MESSAGING_RECORD_OUTBOX: v, CF_ORIGIN_SECRET: SECRET }).recordOutbox,
      ).toBe(true);
    }
    expect(loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }).recordOutbox).toBe(false);
  });

  it('fails fast when MESSAGING_RECORD_OUTBOX is set in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', MESSAGING_RECORD_OUTBOX: '1' }),
    ).toThrow(/MESSAGING_RECORD_OUTBOX/);
  });
```

- [ ] **Step 2: Run → FAIL** — `npm run test -w @housingchoice/app -- devGating` (property undefined; prod case throws wrong/no error).

- [ ] **Step 3: Add the field to `AppConfig`** — in `app/src/lib/config.ts`, next to `devAuthEnabled`:

```ts
  /** Dev-only: when true, outbound messages are also persisted to the
   *  hc-local-dev-outbox table for inspection. MUST be false in production. */
  recordOutbox: boolean;
```

- [ ] **Step 4: Parse + fail-fast** — directly AFTER the existing `devAuthEnabled` fail-fast block near the top of `loadConfig`, add:

```ts
  const recordOutbox = ['true', '1', 'yes'].includes((env.MESSAGING_RECORD_OUTBOX ?? '').toLowerCase());
  if (recordOutbox && nodeEnv === 'production') {
    throw new Error(
      'MESSAGING_RECORD_OUTBOX is set while NODE_ENV=production — refusing to start. The dev ' +
        'message outbox persists message bodies (PII) and must never run in production.',
    );
  }
```

- [ ] **Step 5: Return it** — add `recordOutbox,` to the returned object (beside `devAuthEnabled`).

- [ ] **Step 6: Run → PASS**; then `npm run typecheck -w @housingchoice/app` clean.

- [ ] **Step 7: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add app/src/lib/config.ts app/test/devGating.test.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(app): MESSAGING_RECORD_OUTBOX dev flag + production fail-fast

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: RecordingMessagingDriver + factory wrap (TDD, integration test)

**Files:** Test `app/test/recordingMessaging.integration.test.ts`; Create `app/src/adapters/recordingMessaging.ts`; Modify `app/src/adapters/messaging.ts`

- [ ] **Step 1: Write the failing integration test**

First READ `app/test/dynamo.integration.test.ts` to copy its exact DynamoDB-Local connection/setup (endpoint, TABLE_PREFIX, how it builds a config/client, and any skip-if-down guard). Then create `app/test/recordingMessaging.integration.test.ts` following that setup:

```ts
import { describe, expect, it } from 'vitest';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { RecordingMessagingDriver, OUTBOX_TABLE_BASE } from '../src/adapters/recordingMessaging.js';
import type { MessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig, tableName } from '../src/lib/config.js';
import { createDocumentClient } from '../src/lib/dynamo.js';

// Use the SAME env/endpoint the other *.integration.test.ts files use (copy it).
const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 's', DYNAMODB_ENDPOINT: '<from dynamo.integration.test.ts>', TABLE_PREFIX: 'hc-local-' });

const fakeInner: MessagingAdapter = {
  sendMessage: async (p) => ({ providerSid: `SMtest-${p.idempotencyKey ?? 'x'}`, status: 'sent', providerTs: '2026-06-15T00:00:00.000Z' }),
  getMediaStream: async () => { throw new Error('n/a'); },
  getRecordingStream: async () => { throw new Error('n/a'); },
  provisionPhoneNumber: async () => { throw new Error('n/a'); },
  setVoiceWebhook: async () => {},
  initiateCall: async () => { throw new Error('n/a'); },
};

describe('RecordingMessagingDriver (integration)', () => {
  it('delegates to inner and persists the send to the outbox table', async () => {
    const driver = new RecordingMessagingDriver({ inner: fakeInner, config });
    const to = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
    const res = await driver.sendMessage({ to, body: 'hello outbox', idempotencyKey: 'k1' });
    expect(res.providerSid).toBe('SMtest-k1'); // delegated to inner

    const doc = createDocumentClient({ config });
    const scan = await doc.send(new ScanCommand({ TableName: tableName(OUTBOX_TABLE_BASE) }));
    const mine = (scan.Items ?? []).filter((m) => m.to === to);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ to, body: 'hello outbox', providerSid: 'SMtest-k1', status: 'sent' });
  });
});
```

NOTE: if `dynamo.integration.test.ts` uses a shared helper to get the endpoint/config or to skip when DynamoDB is down, reuse it instead of hardcoding — match the established pattern exactly.

- [ ] **Step 2: Run → FAIL** — `npm run test -w @housingchoice/app -- recordingMessaging` (module missing).
  (Ensure DynamoDB Local is up first: `npm run db:start` from the worktree root.)

- [ ] **Step 3: Create `app/src/adapters/recordingMessaging.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName, type AppConfig } from '../lib/config.js';
import { createDocumentClient, createDynamoClient } from '../lib/dynamo.js';
import { ensureTable } from '../lib/dynamoAdmin.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type {
  InitiateCallParams,
  InitiateCallResult,
  MessagingAdapter,
  ProvisionPhoneNumberResult,
  SendMessageParams,
  SendMessageResult,
} from './messaging.js';

/** Base name; physical table is `${TABLE_PREFIX}dev-outbox` (e.g. hc-local-dev-outbox). */
export const OUTBOX_TABLE_BASE = 'dev-outbox';

export interface OutboxRecord {
  id: string;
  to: string;
  from?: string;
  body?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  providerSid: string;
  status: string;
  createdAt: string;
}

export interface RecordingMessagingDriverDeps {
  inner: MessagingAdapter;
  config: AppConfig;
  logger?: Logger;
  client?: DynamoDBClient;
  doc?: DynamoDBDocumentClient;
}

/**
 * Decorates a MessagingAdapter: delegates every method to `inner`, and after a
 * successful send also persists the outbound message to the dev-only outbox
 * table so e2e tests (and humans) can see what would have been sent. Dev-only;
 * the table is created lazily and never lives in prod/terraform.
 */
export class RecordingMessagingDriver implements MessagingAdapter {
  private readonly inner: MessagingAdapter;
  private readonly log: Logger;
  private readonly client: DynamoDBClient;
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private ensured?: Promise<unknown>;

  constructor(deps: RecordingMessagingDriverDeps) {
    this.inner = deps.inner;
    this.log = deps.logger ?? defaultLogger;
    this.client = deps.client ?? createDynamoClient({ config: deps.config });
    this.doc = deps.doc ?? createDocumentClient({ config: deps.config });
    this.table = tableName(OUTBOX_TABLE_BASE);
  }

  private ensureTable(): Promise<unknown> {
    return (this.ensured ??= ensureTable(
      this.client,
      { baseName: OUTBOX_TABLE_BASE, hashKey: { name: 'id', type: 'S' } },
      this.table,
    ));
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const result = await this.inner.sendMessage(params);
    try {
      await this.ensureTable();
      const record: OutboxRecord = {
        id: randomUUID(),
        to: params.to,
        ...(params.from !== undefined && { from: params.from }),
        ...(params.body !== undefined && { body: params.body }),
        ...(params.mediaUrls !== undefined && { mediaUrls: params.mediaUrls }),
        ...(params.idempotencyKey !== undefined && { idempotencyKey: params.idempotencyKey }),
        providerSid: result.providerSid,
        status: result.status,
        createdAt: result.providerTs,
      };
      await this.doc.send(new PutCommand({ TableName: this.table, Item: record }));
    } catch (err) {
      // Recording is best-effort: never let outbox failures break a real send.
      this.log.error({ err }, 'recording driver: failed to persist outbox record');
    }
    return result;
  }

  getMediaStream(url: string): Promise<Readable> {
    return this.inner.getMediaStream(url);
  }
  getRecordingStream(url: string): Promise<Readable> {
    return this.inner.getRecordingStream(url);
  }
  provisionPhoneNumber(opts: { voiceCapable: true; areaCode?: string }): Promise<ProvisionPhoneNumberResult> {
    return this.inner.provisionPhoneNumber(opts);
  }
  setVoiceWebhook(phoneNumber: string, voiceUrl: string): Promise<void> {
    return this.inner.setVoiceWebhook(phoneNumber, voiceUrl);
  }
  initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    return this.inner.initiateCall(params);
  }
}
```

If `TableSpec` requires a field beyond `{ baseName, hashKey }`, add the minimal value (e.g. no rangeKey/gsis). If `ensureTable`'s spec type genuinely needs more, report it.

- [ ] **Step 4: Wrap inside `createMessagingAdapter` (`app/src/adapters/messaging.ts`)**

Add a type-only-safe import at the top:
```ts
import { RecordingMessagingDriver } from './recordingMessaging.js';
```
Refactor `createMessagingAdapter` so it builds the base driver into a `const base`, then wraps:
```ts
export function createMessagingAdapter(deps: CreateMessagingAdapterDeps = {}): MessagingAdapter {
  const config = deps.config ?? loadConfig();
  const base: MessagingAdapter = (() => {
    if (config.messagingDriver === 'console') {
      return new ConsoleMessagingDriver({ logger: deps.logger });
    }
    if (
      !config.twilioAccountSid ||
      !config.twilioApiKeySid ||
      !config.twilioApiKeySecret ||
      !config.twilioMessagingServiceSid
    ) {
      throw new Error('createMessagingAdapter: messagingDriver=twilio but twilio* config is incomplete');
    }
    return new TwilioMessagingDriver({
      accountSid: config.twilioAccountSid,
      apiKeySid: config.twilioApiKeySid,
      apiKeySecret: config.twilioApiKeySecret,
      messagingServiceSid: config.twilioMessagingServiceSid,
      ...(config.publicBaseUrl !== undefined && { publicBaseUrl: config.publicBaseUrl }),
      client: deps.twilioClient,
      logger: deps.logger,
    });
  })();
  if (config.recordOutbox) {
    return new RecordingMessagingDriver({ inner: base, config, logger: deps.logger });
  }
  return base;
}
```
(`recordingMessaging.ts` imports only TYPES from `messaging.ts`, so there is no runtime import cycle.)

- [ ] **Step 5: Run → PASS** — `npm run test -w @housingchoice/app -- recordingMessaging`; then full suite `npm run test -w @housingchoice/app` green; `npm run typecheck -w @housingchoice/app` clean.

- [ ] **Step 6: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add app/src/adapters/recordingMessaging.ts app/src/adapters/messaging.ts app/test/recordingMessaging.integration.test.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(app): RecordingMessagingDriver decorator -> dev outbox table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `/__dev/outbox`, `/__dev/reseed`, and guarded `resetLocalData` (TDD, integration test)

**Files:** Test `app/test/devOutbox.integration.test.ts`; Create `app/src/lib/devReset.ts`; Modify `app/src/routes/dev.ts`, `app/scripts/db-seed.ts` (export a clear helper if needed)

- [ ] **Step 1: Write the failing integration test** (copy DynamoDB-Local setup from `dynamo.integration.test.ts`). Create `app/test/devOutbox.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { createDevRouter } from '../src/routes/dev.js';
import { RecordingMessagingDriver, OUTBOX_TABLE_BASE } from '../src/adapters/recordingMessaging.js';
import type { MessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';

const SECRET = 's';
const ENDPOINT = '<from dynamo.integration.test.ts>';
const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', MESSAGING_RECORD_OUTBOX: '1', CF_ORIGIN_SECRET: SECRET, DYNAMODB_ENDPOINT: ENDPOINT, TABLE_PREFIX: 'hc-local-' });

const fakeInner: MessagingAdapter = {
  sendMessage: async (p) => ({ providerSid: `SMt-${p.idempotencyKey ?? 'x'}`, status: 'sent', providerTs: new Date().toISOString() }),
  getMediaStream: async () => { throw new Error('n/a'); },
  getRecordingStream: async () => { throw new Error('n/a'); },
  provisionPhoneNumber: async () => { throw new Error('n/a'); },
  setVoiceWebhook: async () => {},
  initiateCall: async () => { throw new Error('n/a'); },
};

describe('/__dev/outbox + /__dev/reseed (integration)', () => {
  it('records a send, lists it via /__dev/outbox, then /__dev/reseed clears it', async () => {
    const app = buildApp({ config, devRouter: createDevRouter({ config }) });
    const driver = new RecordingMessagingDriver({ inner: fakeInner, config });
    const to = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
    await driver.sendMessage({ to, body: 'outbox e2e', idempotencyKey: 'z1' });

    const list = await request(app).get(`/__dev/outbox?to=${encodeURIComponent(to)}`);
    expect(list.status).toBe(200);
    expect(list.body.messages.some((m: { body?: string }) => m.body === 'outbox e2e')).toBe(true);

    const reset = await request(app).post('/__dev/reseed');
    expect(reset.status).toBe(200);

    const after = await request(app).get(`/__dev/outbox?to=${encodeURIComponent(to)}`);
    expect(after.body.messages).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `npm run test -w @housingchoice/app -- devOutbox` (routes missing).

- [ ] **Step 3: Create `app/src/lib/devReset.ts`**

```ts
// Dev-only: wipe the hermetic local DynamoDB to a clean, freshly-seeded slate.
// HARD safety guard: refuses to run against anything but a hc-local- + local
// endpoint stack, so it can never touch dev-cloud or prod tables even if the
// gated endpoint were somehow reached.
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { seedAll } from '../../scripts/db-seed.js';
import { tableName, type AppConfig } from './config.js';
import { createDynamoClient, createDocumentClient } from './dynamo.js';
import { TABLES } from './tables.js';
import { OUTBOX_TABLE_BASE } from '../adapters/recordingMessaging.js';
import { logger as defaultLogger, type Logger } from './logger.js';

async function clearTable(doc: DynamoDBDocumentClient, client: ReturnType<typeof createDynamoClient>, physical: string): Promise<void> {
  let keyNames: string[];
  try {
    const desc = await client.send(new DescribeTableCommand({ TableName: physical }));
    keyNames = (desc.Table?.KeySchema ?? []).map((k) => k.AttributeName!).filter(Boolean);
  } catch {
    return; // table doesn't exist (e.g. outbox never created) — nothing to clear
  }
  let startKey: Record<string, unknown> | undefined;
  do {
    const scan = await doc.send(new ScanCommand({ TableName: physical, ExclusiveStartKey: startKey }));
    const items = scan.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map((it) => ({
        DeleteRequest: { Key: Object.fromEntries(keyNames.map((k) => [k, it[k]])) },
      }));
      if (batch.length > 0) await doc.send(new BatchWriteCommand({ RequestItems: { [physical]: batch } }));
    }
    startKey = scan.LastEvaluatedKey;
  } while (startKey);
}

export async function resetLocalData(deps: { config: AppConfig; logger?: Logger }): Promise<void> {
  const { config } = deps;
  const log = deps.logger ?? defaultLogger;
  const prefix = tableName(''); // the TABLE_PREFIX
  if (!config.dynamodbEndpoint || !prefix.startsWith('hc-local-')) {
    throw new Error(
      `resetLocalData refused: not a hermetic local stack (endpoint=${config.dynamodbEndpoint ?? 'unset'}, prefix=${prefix}).`,
    );
  }
  const client = createDynamoClient({ config });
  const doc = createDocumentClient({ config });
  const bases = [...TABLES.map((t) => t.baseName), OUTBOX_TABLE_BASE];
  for (const base of bases) {
    await clearTable(doc, client, tableName(base));
  }
  const count = await seedAll(config.dynamodbEndpoint);
  log.info({ tables: bases.length, seeded: count }, 'resetLocalData: cleared + reseeded');
}
```

If `TABLES` is not exported from `app/src/lib/tables.ts`, find its actual export name and use it. If `seedAll`'s import path differs, fix it. If a `KeySchema` attribute name could be undefined per TS, keep the `!`/filter as written.

- [ ] **Step 4: Add the endpoints to `app/src/routes/dev.ts`**

Add imports:
```ts
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient } from '../lib/dynamo.js';
import { tableName } from '../lib/config.js';
import { OUTBOX_TABLE_BASE, type OutboxRecord } from '../adapters/recordingMessaging.js';
import { resetLocalData } from '../lib/devReset.js';
```
Add `doc?: DynamoDBDocumentClient;` to `DevRouterDeps`. In `createDevRouter`, after the existing `const users = ...`:
```ts
  const doc = deps.doc ?? createDocumentClient({ config });
```
Add the two routes (after dev-login):
```ts
  // GET /__dev/outbox?to=&since= — recorded outbound messages (newest last).
  router.get('/__dev/outbox', async (req, res) => {
    const table = tableName(OUTBOX_TABLE_BASE);
    let items: OutboxRecord[] = [];
    try {
      const out = await doc.send(new ScanCommand({ TableName: table }));
      items = (out.Items ?? []) as OutboxRecord[];
    } catch {
      items = []; // table not created yet (nothing sent) — empty outbox
    }
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    if (to) items = items.filter((m) => m.to === to);
    if (since) items = items.filter((m) => m.createdAt >= since);
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    res.status(200).json({ messages: items });
  });

  // POST /__dev/reseed — wipe local tables (incl. outbox) and re-seed.
  router.post('/__dev/reseed', async (_req, res) => {
    await resetLocalData({ config, logger: log });
    res.status(200).json({ ok: true });
  });
```

- [ ] **Step 5: Run → PASS** — `npm run test -w @housingchoice/app -- devOutbox`; then full suite green; typecheck clean. Also re-run `-- devGating` to confirm no regression.

- [ ] **Step 6: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add app/src/lib/devReset.ts app/src/routes/dev.ts app/scripts/db-seed.ts app/test/devOutbox.integration.test.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(app): /__dev/outbox + /__dev/reseed with guarded resetLocalData

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: e2e proof — synchronous send → outbox → reseed

**Files:** Modify `dashboard/vite.config.ts`, `e2e/playwright.config.ts`; Create `e2e/fixtures/outbox.ts`, `e2e/fixtures/reseed.ts`, `e2e/tests/flows/outbox.spec.ts`

- [ ] **Step 1: Proxy `/__dev` in Vite** — in `dashboard/vite.config.ts`, add `'/__dev': appProxy,` to the `proxy` object (next to `/api`, `/auth`, `/public`).

- [ ] **Step 2: Enable recording on the e2e server** — in `e2e/playwright.config.ts` `webServer.env`, add `MESSAGING_RECORD_OUTBOX: '1'` (keep `DEV_AUTH_ENABLED: '1'`):
```ts
    env: { DEV_AUTH_ENABLED: '1', MESSAGING_RECORD_OUTBOX: '1' },
```

- [ ] **Step 3: Outbox + reseed fixtures**

`e2e/fixtures/outbox.ts`:
```ts
import type { APIRequestContext } from '@playwright/test';

export interface OutboxMessage {
  id: string;
  to: string;
  from?: string;
  body?: string;
  providerSid: string;
  status: string;
  createdAt: string;
}

// Queries /__dev/outbox (proxied to the app via :5173). request.baseURL is the
// Playwright baseURL (http://localhost:5173).
export async function getOutbox(
  request: APIRequestContext,
  opts: { to?: string; since?: string } = {},
): Promise<OutboxMessage[]> {
  const qs = new URLSearchParams();
  if (opts.to) qs.set('to', opts.to);
  if (opts.since) qs.set('since', opts.since);
  const res = await request.get(`/__dev/outbox${qs.toString() ? `?${qs}` : ''}`);
  if (!res.ok()) throw new Error(`/__dev/outbox failed: ${res.status()}`);
  return (await res.json()).messages as OutboxMessage[];
}
```

`e2e/fixtures/reseed.ts`:
```ts
import type { APIRequestContext } from '@playwright/test';

export async function reseed(request: APIRequestContext): Promise<void> {
  const res = await request.post('/__dev/reseed');
  if (!res.ok()) throw new Error(`/__dev/reseed failed: ${res.status()}`);
}
```

- [ ] **Step 4: The proving spec** `e2e/tests/flows/outbox.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import { getOutbox } from '../../fixtures/outbox.js';
import { reseed } from '../../fixtures/reseed.js';

// A housing-fair signup sends a welcome SMS synchronously (in-request). Use a
// unique phone each run so the assertion is independent of prior state.
test('synchronous welcome send is recorded in the outbox, and reseed clears it', async ({ request }) => {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const submit = await request.post('/public/housing-fair', {
    data: { firstName: 'Pat', lastName: 'Tester', phone, voucherSize: 2 },
  });
  expect(submit.ok()).toBeTruthy();

  await expect
    .poll(async () => (await getOutbox(request, { to: phone })).length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const messages = await getOutbox(request, { to: phone });
  expect(messages[0]?.body ?? '').toContain('Pat');

  await reseed(request);
  expect(await getOutbox(request, { to: phone })).toHaveLength(0);
});
```

NOTE: the housing-fair POST body must match `parseHousingFairBody` — if the field names/shape differ from `{firstName,lastName,phone,voucherSize}`, READ `app/src/routes/public.ts` `parseHousingFairBody` and use the exact expected shape. The welcome body must contain the first name per `renderWelcome`; if it doesn't include the literal first name, assert on a stable substring of `renderWelcome` instead.

- [ ] **Step 5: Run the e2e suite → GREEN** — from the worktree root, `npm run e2e`. Expect: setup + housing-fair smoke + the two auth specs + the new outbox flow, all passing. Then `npm run typecheck -w @housingchoice/e2e` clean.

- [ ] **Step 6: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add dashboard/vite.config.ts e2e/playwright.config.ts e2e/fixtures/outbox.ts e2e/fixtures/reseed.ts e2e/tests/flows/outbox.spec.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(e2e): outbox + reseed fixtures and synchronous-send proof

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 exit gate (per spec §12)

1. **Build + test:** Tasks 1–4 complete.
2. **Verification gate (evidence required):** `npm run test -w @housingchoice/app` green (incl. the two new integration tests, with DynamoDB Local up); `npm run e2e` green incl. the outbox flow; both typechecks clean. Capture summary lines.
3. **Adversarial review:** fresh independent reviewer over the Phase 3 diff, off-the-leash, focusing on: can the recording driver or outbox/reseed run/leak in production (flag fail-fast + gate)? Is `resetLocalData`'s safety guard airtight (could it ever wipe a non-local table — prefix/endpoint checks, race, partial deletes)? PII in the outbox (message bodies persisted) — acceptable for dev-only, but flag exposure paths. Does the decorator faithfully delegate ALL adapter methods (no behavior change to real sends, errors swallowed correctly)? Outbox query correctness (scan pagination, filters). Test quality + regressions.
4. **Done** only on green + clean review. Then proceed to Phase 4.

## Notes for later phases (do NOT do them now)

- Phase 4 (session mode launcher) will reuse `/__dev/reseed` for the agent's `e2e:reseed` command and the recording flag for the persistent stack.
- Phase 5 (cross-UI flow) relies on the worker's relay send ALSO being recorded — it is, because the worker's `createMessagingAdapter` honors `recordOutbox` and writes to the same shared table. Phase 5 still must verify local async job dispatch (R1).
