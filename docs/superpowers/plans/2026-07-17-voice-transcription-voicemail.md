<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-18).** This document describes how
> this work was *designed/planned at the time of writing*. The work shipped to the main line and
> its feature branch + worktree were deleted during cleanup. **This file is NOT current
> documentation and the live code may have drifted from it - do not treat it as authoritative
> guidance on how the system should be built or behaves today.** For current truth read the code
> and RUNBOOK.md (Voice Intelligence section). Kept only as a point-in-time record of intent.

# Voice Transcription (Voice Intelligence) + Platform Voicemail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make founder-bridge call recordings and new platform voicemails actually transcribe via Twilio Voice Intelligence (VI), with a persisted transcript lifecycle status driving a live "Transcribing..." indicator, and delete the dead legacy transcription endpoint.

**Architecture:** Layered reuse per the spec (docs/superpowers/specs/2026-07-17-voice-transcription-voicemail-design.md - READ IT FIRST). New JSON webhook + VI adapter methods funnel into the existing idempotent `setCallTranscript` seam; voicemail is a call entry using the reserved `voicemail` outcome riding the existing recording mirror; fake-twilio grows a VI model + `<Record>` support so hermetic e2e proves the real wire shapes.

**Tech Stack:** Node 24 / TypeScript / Express 5 / DynamoDB / twilio SDK v6 (`intelligence.v2` - already a dep, NO new npm deps) / Vitest / Playwright.

## Global Constraints

- Gates run BARE from the worktree, never piped: `npm run typecheck` + `npm test` + `timeout 1500 npm run e2e`. typecheck is a REQUIRED separate gate.
- ASCII-only in every added line (specs, code comments, catalog copy, test names): `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0.
- NEVER rewrite files with PowerShell Get-Content/Set-Content - use the Edit tool.
- Commit discipline: bare `git status` READ before EVERY commit; stage EXPLICIT paths only; `Co-Authored-By:` trailer naming the authoring model on every commit.
- New automated user-facing copy ONLY via the message catalog (`app/src/messages/catalog.ts`).
- NO infra actions ever (terraform, secrets:push, deploys, real .env edits). `.env.*.example` template edits are allowed (template-first rule).
- Masked relay calls are NEVER recorded/transcribed - every new code path must refuse masked, and existing masked guardrails must stay untouched.
- PII: NEVER log transcript text or push bodies - lengths and sids only.
- Domain language: the entity is `unit` in code; this feature adds no new domain nouns.
- e2e runs ONLY from the worktree (a stray root playwright run targets the human's LIVE :5174 stack).

**Interface cheat-sheet from planning research (verified against the tree at branch time):**

- `app/src/routes/webhooks/voice.ts`: factory `createTwilioVoiceRouter(deps: TwilioVoiceWebhookDeps = {})` (line ~255); recording handler `router.post('/recording', verifySignature, ...)` (~1385); missed goodbye TwiML (~1364-1369); `onFounderBridgeMissed` (~1597); `sendMissedCallPush` (~1621); `sendTwiml(res, twiml)` (~301); `const { VoiceResponse } = twilio.twiml` (~81).
- `app/src/repos/messagesRepo.ts`: `MessageItem` (~237-330, has `[key: string]: unknown`), `CallOutcome = 'answered'|'missed'|'voicemail'` (~55), `setCallTranscript(callSid, transcript): Promise<boolean>` (~829, condition `attribute_not_exists(transcript) OR transcript = :empty`), `getByProviderSid(sid)` (~530), `setCallRecording` / `releaseCallRecording` / `updateCallStatus` / `putJobExecutionMarker`.
- Jobs: `defineJobHandler(name, handler)` + `enqueue(jobName, payload, { runAt })` + `enqueueImmediate` in `app/src/jobs/jobs.ts`; delays <= 720s ride SQS DelaySeconds EXACTLY (no scheduler floor); registrars wired in `app/src/jobs/registerHandlers.ts` `registerAllJobHandlers`; template job `app/src/jobs/missedCallAutoText.ts`; test template `app/test/missedCallAutoText.test.ts` (uses `_resetForTests`, `configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }))`, `InMemorySchedulerAdapter`).
- Config: `app/src/lib/config.ts` `loadConfig(env)`; optional-var pattern = typed `field?: string` + `field: env.VAR` in the return; `TWILIO_API_BASE_URL` read ~342 (prod-rejected ~343-350), surfaced ~680.
- Twilio client: ONE instance, `app/src/adapters/messaging.ts` `TwilioMessagingDriver` constructor (~375-389) with `createRedirectingHttpClient({ baseUrl })` from `app/src/adapters/twilioHttpClient.ts` - it rewrites ONLY the origin, so `client.intelligence.v2.*` (host intelligence.twilio.com) rides the same redirect automatically.
- Raw body: `app/src/app.ts` (~88-92) already stashes `req.rawBody` for BOTH json and urlencoded parsers.
- Catalog: `app/src/messages/catalog.ts` - add to `MessageId` union AND `MESSAGE_CATALOG`; `resolveMessage(id, vars?)` is sync.
- SSE: `events.emit('message.persisted', { conversationId, tsMsgId, direction, deliveryStatus })`; contact timeline refetches on it (`dashboard/src/routes/contact/useContactTimeline.ts` ~291).
- Dashboard: single call renderer `CallCard` in `dashboard/src/routes/contact/Timeline.tsx` (~491-523); outcome label is `charAt(0).toUpperCase()+slice(1)` (line ~511) so `voicemail` -> "Voicemail" needs no mapping work; transcript collapsible ~515-520; NO recording player exists; server streaming endpoint `GET /api/calls/:callId/recording` exists (`app/src/routes/api.ts` ~1189-1227, auth-gated, streams S3). Serialization whitelist: `toTimelineCall` in `app/src/routes/contactTimeline.ts` (~349-374) + app `TimelineCall` type (~140-148) + dashboard `TimelineCall`/`Message` in `dashboard/src/api/types.ts` (~1245-1350).
- App test harness: `app/test/helpers/twilioWebhookHarness.ts` - `createFakeWorld()` (fake `messagesRepo` ~466-626 - EVERY new repo method must be mirrored there), `makeWebhookHarness(opts)` (~2054; `webhooks` dep injection ~2169-2194), `signedTwilioPost(app, path, params, opts)` (~2209, form-encoded ONLY), constants `AUTH_TOKEN='test-twilio-auth-token'`, `PUBLIC_BASE_URL='https://dxxxx.cloudfront.example'`, `ORIGIN_SECRET`.
- fake-twilio: `CallEngine` `fake-twilio/src/engine/callEngine.ts` (~637 lines; `fireRecordingAndTranscription` ~533-564; legacy transcription block ~553-563; missed Dial action fired via `dispatcher.post` which DISCARDS the response body - `runDialChain` ~476); `interpretTwiml` in `fake-twilio/src/engine/twimlInterpreter.ts` (fast-xml-parser; NO `Record` branch today; `TwimlPlan` union ~8-14); signer `fake-twilio/src/engine/signer.ts` (form-only; `buildTranscriptionParams` ~100-102 to DELETE); dispatcher `fake-twilio/src/engine/dispatcher.ts` (form-only `post`/`postForResponse`); REST pattern `fake-twilio/src/routes/voiceRest.ts` (`createVoiceRestRouter`); server mount + SPA reserved prefixes `fake-twilio/src/server.ts` (~111-130, prefix list ~153 - `/v2` MUST be added); control API validation `fake-twilio/src/routes/voiceControl.ts` `validateScenario` (~45); scenario type `fake-twilio/src/engine/voiceTypes.ts` `CallScenario` (~22-42), `CallState` (~46-61).
- e2e voice fixtures: `e2e/fixtures/fakeVoice.ts` (`placeCall`, `tenantCallNoAnswer`, local `CallScenario` mirror ~11-18); voice spec `e2e/tests/dashboard-next/voice-outbound.spec.ts`.

Line numbers are from planning research; verify with a quick read before editing - they drift.

---

### Task 1: Config - `TWILIO_VI_SERVICE_SID` + reconcile delay knob

**Files:**
- Modify: `app/src/lib/config.ts`
- Modify: `app/test/config.test.ts` (or the existing config test file - find with `rg "loadConfig" app/test`)
- Modify: `.env.local.example`, `.env.dev.example`, `.env.prod.example` (whichever exist - `rg -l "TWILIO_AUTH_TOKEN" --hidden -g ".env*example*"`)

**Interfaces:**
- Produces: `config.twilioViServiceSid?: string` (undefined = VI feature OFF) and `config.voiceTranscriptReconcileSeconds: number` (default 600). Later tasks read both off `AppConfig`.

- [ ] **Step 1: Write the failing test** (in the existing config test file, following its pattern):

```ts
describe('voice intelligence config', () => {
  it('twilioViServiceSid is undefined when unset and read when set', () => {
    expect(loadConfig(baseEnv()).twilioViServiceSid).toBeUndefined();
    expect(loadConfig({ ...baseEnv(), TWILIO_VI_SERVICE_SID: 'GAxxxxfake' }).twilioViServiceSid).toBe('GAxxxxfake');
  });
  it('voiceTranscriptReconcileSeconds defaults to 600 and parses an override', () => {
    expect(loadConfig(baseEnv()).voiceTranscriptReconcileSeconds).toBe(600);
    expect(loadConfig({ ...baseEnv(), VOICE_TRANSCRIPT_RECONCILE_SECONDS: '5' }).voiceTranscriptReconcileSeconds).toBe(5);
  });
});
```

(`baseEnv()` = whatever minimal-env helper the existing config tests use; reuse it.)

- [ ] **Step 2: Run to verify it fails:** `npm test -w app -- config` -> FAIL (property does not exist).
- [ ] **Step 3: Implement.** In `AppConfig` add:

```ts
/** Voice Intelligence service SID (GAxxxx). Absent => transcription feature OFF. */
twilioViServiceSid?: string;
/** Delay before the transcript reconcile job re-checks Twilio (seconds). Default 600; e2e sets it tiny. */
voiceTranscriptReconcileSeconds: number;
```

In `loadConfig`'s return object add:

```ts
twilioViServiceSid: env.TWILIO_VI_SERVICE_SID?.trim() || undefined,
voiceTranscriptReconcileSeconds: Number(env.VOICE_TRANSCRIPT_RECONCILE_SECONDS ?? '600') || 600,
```

Add both vars, commented, to each `.env.*.example` (values empty/absent by default; note in the comment that VI SID is per-env and optional).

- [ ] **Step 4: Run:** `npm test -w app -- config` -> PASS.
- [ ] **Step 5: Commit** `feat(config): optional TWILIO_VI_SERVICE_SID + reconcile delay knob`.

---

### Task 2: Repo - `transcript_status` field + status/outcome conditional writes

**Files:**
- Modify: `app/src/repos/messagesRepo.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (fake messagesRepo mirror)
- Test: `app/test/messagesRepo.callTranscript.test.ts` (create; or extend the existing repo test file if one covers setCallTranscript - `rg -l "setCallTranscript" app/test`)

**Interfaces:**
- Produces (on `MessagesRepo` interface AND the harness fake):
  - `type TranscriptStatus = 'pending' | 'completed' | 'failed'` (exported)
  - `MessageItem.transcript_status?: TranscriptStatus`
  - `setTranscriptPending(callSid: string): Promise<boolean>` - conditional `attribute_not_exists(transcript_status)`; false if already stamped.
  - `setTranscriptFailed(callSid: string): Promise<boolean>` - conditional `transcript_status = 'pending'`; false otherwise (completed is terminal).
  - `upgradeCallOutcomeToVoicemail(callSid: string): Promise<boolean>` - conditional `call_outcome = 'missed'`; false otherwise (idempotent on redelivery).
  - `setCallTranscript(callSid, transcript)` EXTENDED: same condition as today, but the update expression also stamps `transcript_status = 'completed'` (this is how failed -> completed late-upgrade works: the condition is on `transcript`, not on status).

- [ ] **Step 1: Write failing tests:**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
// If real-DynamoDB repo tests exist for setCallTranscript, mirror this suite there too,
// following that file's local-dynamo setup pattern. Otherwise the fake (contract mirror)
// plus the route tests in later tasks carry the coverage.

describe('transcript_status + voicemail outcome conditional writes (fake contract)', () => {
  let world: ReturnType<typeof createFakeWorld>;
  beforeEach(() => { world = createFakeWorld(); });

  function seedCall(over: Record<string, unknown> = {}) {
    world.messages.push({
      conversationId: 'c1', tsMsgId: 'CAtest1', type: 'call', direction: 'inbound',
      provider_sid: 'CAtest1', delivery_status: 'delivered', masked: false,
      call_outcome: 'missed', ...over,
    } as never);
  }

  it('setTranscriptPending stamps once, false on repeat', async () => {
    seedCall();
    expect(await world.messagesRepo.setTranscriptPending('CAtest1')).toBe(true);
    expect(await world.messagesRepo.setTranscriptPending('CAtest1')).toBe(false);
    expect(world.messages[0]!.transcript_status).toBe('pending');
  });

  it('setTranscriptFailed only from pending; completed is terminal', async () => {
    seedCall();
    expect(await world.messagesRepo.setTranscriptFailed('CAtest1')).toBe(false); // not pending yet
    await world.messagesRepo.setTranscriptPending('CAtest1');
    expect(await world.messagesRepo.setTranscriptFailed('CAtest1')).toBe(true);
    // late text still completes (condition is on transcript, not status):
    expect(await world.messagesRepo.setCallTranscript('CAtest1', 'late text')).toBe(true);
    expect(world.messages[0]!.transcript_status).toBe('completed');
    expect(await world.messagesRepo.setTranscriptFailed('CAtest1')).toBe(false); // terminal
  });

  it('setCallTranscript stamps completed and never overwrites', async () => {
    seedCall();
    expect(await world.messagesRepo.setCallTranscript('CAtest1', 'first')).toBe(true);
    expect(world.messages[0]!.transcript_status).toBe('completed');
    expect(await world.messagesRepo.setCallTranscript('CAtest1', 'second')).toBe(false);
    expect(world.messages[0]!.transcript).toBe('first');
  });

  it('upgradeCallOutcomeToVoicemail only from missed, once', async () => {
    seedCall();
    expect(await world.messagesRepo.upgradeCallOutcomeToVoicemail('CAtest1')).toBe(true);
    expect(world.messages[0]!.call_outcome).toBe('voicemail');
    expect(await world.messagesRepo.upgradeCallOutcomeToVoicemail('CAtest1')).toBe(false);
  });

  it('upgrade refuses an answered call', async () => {
    seedCall({ call_outcome: 'answered' });
    expect(await world.messagesRepo.upgradeCallOutcomeToVoicemail('CAtest1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run:** `npm test -w app -- messagesRepo.callTranscript` -> FAIL (methods missing).
- [ ] **Step 3: Implement in the REAL repo** (`app/src/repos/messagesRepo.ts`), modeled exactly on `setCallTranscript`'s resolve-pointer-then-conditional-Update shape (~829-866):

```ts
export type TranscriptStatus = 'pending' | 'completed' | 'failed';
// MessageItem gains: transcript_status?: TranscriptStatus;

async function conditionalCallUpdate(
  callSid: string,
  update: { expression: string; condition: string; values: Record<string, unknown> },
): Promise<boolean> {
  const item = await getByProviderSid(callSid);
  if (!item) return false;
  try {
    await client.send(new UpdateCommand({
      TableName: table,
      Key: { conversationId: item.conversationId, tsMsgId: item.tsMsgId },
      UpdateExpression: update.expression,
      ConditionExpression: update.condition,
      ExpressionAttributeValues: update.values,
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// setTranscriptPending:
//   expression 'SET transcript_status = :p', condition 'attribute_not_exists(transcript_status)',
//   values { ':p': 'pending' }
// setTranscriptFailed:
//   expression 'SET transcript_status = :f', condition 'transcript_status = :p',
//   values { ':f': 'failed', ':p': 'pending' }
// upgradeCallOutcomeToVoicemail:
//   expression 'SET call_outcome = :v', condition 'call_outcome = :m',
//   values { ':v': 'voicemail', ':m': 'missed' }
```

Write the three as real methods on the repo object + interface (match the file's existing naming/JSDoc style; the helper above is a suggestion - inline per-method is fine if it matches the file's idiom better). EXTEND `setCallTranscript`'s UpdateExpression to `'SET transcript = :t, transcript_status = :c'` with `':c': 'completed'` added to the values; condition unchanged. Mirror ALL of it in the harness fake `messagesRepo` (in-memory semantics matching the conditions above - the test in Step 1 runs against the fake, keeping the two honest).

- [ ] **Step 4: Run:** `npm test -w app -- messagesRepo.callTranscript` -> PASS; also `npm test -w app -- voiceRecording` -> still PASS (setCallTranscript extension is additive).
- [ ] **Step 5: Commit** `feat(repo): transcript_status lifecycle + voicemail outcome conditional writes`.

---

### Task 3: Adapter - Voice Intelligence client methods

**Files:**
- Modify: `app/src/adapters/messaging.ts` (interface `MessagingAdapter` + `TwilioMessagingDriver` + console driver)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (world.adapter fake)
- Test: `app/test/voiceIntelligenceAdapter.test.ts`

**Interfaces:**
- Produces on `MessagingAdapter` (all later tasks consume these exact names):

```ts
export interface ViTranscriptSummary {
  transcriptSid: string;
  status: string;                 // 'queued' | 'in-progress' | 'completed' | 'failed' (Twilio's strings, passed through)
  customerKey?: string;
}
export interface ViSentence { text: string; mediaChannel: number }

// on MessagingAdapter:
createViTranscript(input: { serviceSid: string; recordingSid: string; customerKey: string }): Promise<{ transcriptSid: string }>;
fetchViTranscript(transcriptSid: string): Promise<ViTranscriptSummary>;
listViSentences(transcriptSid: string): Promise<ViSentence[]>;
```

- Consumes: the driver's existing `this.client` (twilio SDK instance with the redirecting httpClient - Intelligence calls MUST go through this same client to hit the fake locally).

- [ ] **Step 1: Write failing tests** (inject a fake twilio client into `TwilioMessagingDriver` via its existing `deps.client` seam):

```ts
import { describe, it, expect, vi } from 'vitest';
import { TwilioMessagingDriver } from '../src/adapters/messaging.js';

function fakeTwilioClient() {
  const create = vi.fn().mockResolvedValue({ sid: 'GTfake1' });
  const fetch = vi.fn().mockResolvedValue({ sid: 'GTfake1', status: 'completed', customerKey: 'CAtest1' });
  const list = vi.fn().mockResolvedValue([
    { transcript: 'hello there', mediaChannel: 1 },
    { transcript: 'hi back', mediaChannel: 2 },
  ]);
  const transcripts = Object.assign((sid: string) => ({ fetch, sentences: { list } }), { create });
  return { client: { intelligence: { v2: { transcripts } } }, create, fetch, list };
}

describe('VI adapter methods', () => {
  it('createViTranscript posts serviceSid + recording source + customerKey and returns the sid', async () => {
    const f = fakeTwilioClient();
    const driver = new TwilioMessagingDriver({ /* copy the minimal deps the existing driver tests use */ client: f.client as never });
    const out = await driver.createViTranscript({ serviceSid: 'GAsvc', recordingSid: 'REfake1', customerKey: 'CAtest1' });
    expect(out).toEqual({ transcriptSid: 'GTfake1' });
    expect(f.create).toHaveBeenCalledWith({
      serviceSid: 'GAsvc',
      channel: { media_properties: { source_sid: 'REfake1' } },
      customerKey: 'CAtest1',
    });
  });
  it('fetchViTranscript maps status + customerKey', async () => {
    const f = fakeTwilioClient();
    const driver = new TwilioMessagingDriver({ client: f.client as never });
    expect(await driver.fetchViTranscript('GTfake1')).toEqual({ transcriptSid: 'GTfake1', status: 'completed', customerKey: 'CAtest1' });
  });
  it('listViSentences maps text + mediaChannel', async () => {
    const f = fakeTwilioClient();
    const driver = new TwilioMessagingDriver({ client: f.client as never });
    expect(await driver.listViSentences('GTfake1')).toEqual([
      { text: 'hello there', mediaChannel: 1 },
      { text: 'hi back', mediaChannel: 2 },
    ]);
  });
});
```

(Adjust the driver-constructor deps to whatever the existing driver unit tests pass - copy their minimal fixture. VERIFY at build time the exact twilio v6 `intelligence.v2.transcripts` create/fetch/sentences shapes - spec section 9 item 1 - and adjust the fake + mapping to the SDK's REAL parameter casing, e.g. if v6 wants `channel: JSON.stringify(...)` or camelCase `mediaProperties`; the test pins whatever the SDK truly needs. Check `node_modules/twilio/lib/rest/intelligence/v2/transcript.d.ts` FIRST and write both fake and impl against it.)

- [ ] **Step 2: Run:** `npm test -w app -- voiceIntelligenceAdapter` -> FAIL.
- [ ] **Step 3: Implement** on `TwilioMessagingDriver` (thin mappers over `this.client.intelligence.v2.transcripts`); the console driver implements the same three methods by throwing `new Error('voice intelligence unavailable on console driver')` (the console driver is never used with VI configured; route/job code guards on config before calling). Mirror in the harness `world.adapter` with an inspectable fake:

```ts
// twilioWebhookHarness.ts world additions:
viCreates: Array<{ serviceSid: string; recordingSid: string; customerKey: string }>,
viTranscripts: Map<string, { status: string; customerKey?: string; sentences: Array<{ text: string; mediaChannel: number }> }>,
viCreateError: undefined as Error | undefined,   // set by a test to force inline-create failure
// adapter methods:
createViTranscript: async (input) => {
  if (world.viCreateError) throw world.viCreateError;
  world.viCreates.push(input);
  const sid = `GTfake${world.viCreates.length}`;
  if (!world.viTranscripts.has(sid)) world.viTranscripts.set(sid, { status: 'completed', customerKey: input.customerKey, sentences: [] });
  return { transcriptSid: sid };
},
fetchViTranscript: async (sid) => {
  const t = world.viTranscripts.get(sid);
  if (!t) throw new Error(`no such transcript ${sid}`);
  return { transcriptSid: sid, status: t.status, customerKey: t.customerKey };
},
listViSentences: async (sid) => (world.viTranscripts.get(sid)?.sentences ?? []).slice(),
```

- [ ] **Step 4: Run:** `npm test -w app -- voiceIntelligenceAdapter` -> PASS; `npm run typecheck` -> PASS (interface additions ripple to the console driver + harness).
- [ ] **Step 5: Commit** `feat(adapter): voice intelligence create/fetch/sentences via the shared twilio client`.

---

### Task 4: JSON-body Twilio signature middleware

**Files:**
- Modify: `app/src/middleware/twilioSignature.ts` (add a sibling export)
- Test: `app/test/twilioJsonSignature.test.ts`

**Interfaces:**
- Produces: `twilioJsonSignatureMiddleware(opts: TwilioSignatureOptions): RequestHandler` (same opts type as the existing form middleware). Validates the documented Twilio JSON scheme: the webhook URL carries a `bodySHA256` query param; the signature is computed over the FULL URL (including that param) with NO form params. Validation = `twilio.validateRequestWithBody(authToken, signatureHeader, url, rawBody)`. Unconfigured behavior mirrors the form middleware (prod 403, dev warn+next). Reads `req.rawBody` (already captured globally in app.ts).
- Consumes: `RequestWithRawBody` typing from wherever app.ts declares it (import, do not redeclare).

- [ ] **Step 1: Write failing tests:**

```ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createHash } from 'node:crypto';
import { twilioJsonSignatureMiddleware } from '../src/middleware/twilioSignature.js';

const AUTH_TOKEN = 'test-twilio-auth-token';
const PUBLIC_BASE_URL = 'https://dxxxx.cloudfront.example';

function makeApp() {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
  app.post('/hook', twilioJsonSignatureMiddleware({ authToken: AUTH_TOKEN, publicBaseUrl: PUBLIC_BASE_URL, nodeEnv: 'production' }), (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

function signedJsonPost(app: express.Express, path: string, body: unknown, opts: { tamper?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
  const pathWithSha = `${path}?bodySHA256=${sha}`;
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${pathWithSha}`, {});
  let req = request(app).post(pathWithSha).set('content-type', 'application/json');
  if (!opts.tamper) req = req.set('x-twilio-signature', signature);
  else req = req.set('x-twilio-signature', `${signature}TAMPERED`);
  return req.send(raw);
}

describe('twilioJsonSignatureMiddleware', () => {
  it('accepts a correctly signed JSON post', async () => {
    const res = await signedJsonPost(makeApp(), '/hook', { transcript_sid: 'GTfake1' });
    expect(res.status).toBe(200);
  });
  it('rejects a tampered signature', async () => {
    const res = await signedJsonPost(makeApp(), '/hook', { transcript_sid: 'GTfake1' }, { tamper: true });
    expect(res.status).toBe(403);
  });
  it('rejects a body that does not match bodySHA256', async () => {
    const app = makeApp();
    const raw = JSON.stringify({ transcript_sid: 'GTfake1' });
    const sha = createHash('sha256').update('DIFFERENT', 'utf8').digest('hex');
    const url = `/hook?bodySHA256=${sha}`;
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${url}`, {});
    const res = await request(app).post(url).set('content-type', 'application/json').set('x-twilio-signature', signature).send(raw);
    expect(res.status).toBe(403);
  });
  it('rejects a missing signature header', async () => {
    const app = makeApp();
    const res = await request(app).post('/hook').set('content-type', 'application/json').send(JSON.stringify({ a: 1 }));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run:** `npm test -w app -- twilioJsonSignature` -> FAIL (export missing).
- [ ] **Step 3: Implement** beside the form middleware, mirroring its structure/logging:

```ts
export function twilioJsonSignatureMiddleware(opts: TwilioSignatureOptions): RequestHandler {
  const { authToken, publicBaseUrl, nodeEnv, logger } = opts;
  const configured = Boolean(authToken) && Boolean(publicBaseUrl);
  return (req, res, next) => {
    if (!configured) { /* same prod-403 / dev-warn+next behavior as the form middleware - copy it */ }
    const signature = req.get('x-twilio-signature');
    const raw = (req as RequestWithRawBody).rawBody?.toString('utf8') ?? '';
    const url = `${publicBaseUrl}${req.originalUrl}`;
    const valid = Boolean(signature) && twilio.validateRequestWithBody(authToken!, signature!, url, raw);
    if (!valid) {
      logger?.warn({ path: req.path, hasSignature: Boolean(signature) }, 'twilio JSON webhook signature rejected');
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
```

(Confirm `twilio.validateRequestWithBody` exists in v6 - it does in `twilio/lib/webhooks/webhooks.js`; it checks the `bodySHA256` query param against the raw body and validates the URL signature with empty params. If its exact behavior differs, adjust the fake-signing helper in Step 1 to whatever the real function validates - app and fake must agree on the twilio-documented scheme, and spec section 9 flags live verification against real Twilio. Note the resilience posture: if real VI signing ever differs, the reconcile job still delivers transcripts - webhook validation failures are visible in logs, not fatal to the feature.)

- [ ] **Step 4: Run:** `npm test -w app -- twilioJsonSignature` -> PASS.
- [ ] **Step 5: Commit** `feat(middleware): JSON-body twilio signature validation (bodySHA256 scheme)`.

---

### Task 5: VI webhook route + shared persist helper (and the transcript text format)

**Files:**
- Create: `app/src/services/voiceTranscripts.ts`
- Modify: `app/src/routes/webhooks/voice.ts` (new route `POST /intelligence`; deps unchanged - adapter/messages/events/config already injected)
- Test: `app/test/voiceIntelligenceWebhook.test.ts`

**Interfaces:**
- Produces `app/src/services/voiceTranscripts.ts`:

```ts
export function joinViSentences(sentences: ViSentence[]): string;
// Single channel -> sentence texts joined with '\n'.
// >1 distinct mediaChannel -> each line prefixed 'Speaker <n>: ' where n is the 1-based
// order of first appearance of that channel (stable, channel-number-agnostic).

export interface PersistViTranscriptDeps {
  adapter: Pick<MessagingAdapter, 'fetchViTranscript' | 'listViSentences'>;
  messages: MessagesRepo; events: EventBus; logger: Logger;
}
export type PersistViOutcome =
  | 'saved' | 'already-saved' | 'not-ours' | 'masked-refused' | 'not-completed' | 'failed-stamped';
export async function persistViTranscript(deps: PersistViTranscriptDeps, transcriptSid: string): Promise<PersistViOutcome>;
// fetches the transcript; resolves callSid from customerKey ONLY (missing -> 'not-ours');
// status 'failed' -> setTranscriptFailed + 'failed-stamped'; other non-completed -> 'not-completed';
// completed -> resolve entity via messages.getByProviderSid (missing/type!=='call' -> 'not-ours';
// masked===true -> warn + 'masked-refused'); listViSentences -> joinViSentences ->
// setCallTranscript (false -> 'already-saved'); on BOTH a save and a failed-stamp emit
// message.persisted { conversationId, tsMsgId, direction, deliveryStatus: entry.delivery_status }
// (spec 3.7: every status transition emits SSE) and log transcriptLength ONLY (never the
// text). Twilio API errors are NOT caught here - they throw.
```

The route (in `createTwilioVoiceRouter`):

```ts
// POST /webhooks/twilio/voice/intelligence - Voice Intelligence event callback (JSON).
// Trusts ONLY transcript_sid; everything else re-fetched from the API. 500 on Twilio API
// failure so Twilio redelivers (persist is idempotent). See spec 3.3.
router.post('/intelligence', verifyJsonSignature, async (req, res) => {
  const transcriptSid = (req.body as { transcript_sid?: unknown })?.transcript_sid;
  if (typeof transcriptSid !== 'string' || transcriptSid.length === 0) {
    res.status(400).json({ error: 'bad request' }); return;
  }
  try {
    await persistViTranscript({ adapter, messages, events, logger: log }, transcriptSid);
    res.status(200).end();
  } catch (err) {
    log.error({ err, transcriptSid }, 'vi webhook: twilio api failure - 500 for redelivery');
    res.status(500).end();
  }
});
```

where `verifyJsonSignature = twilioJsonSignatureMiddleware({ authToken: config.twilioAuthToken, publicBaseUrl: config.publicBaseUrl, nodeEnv: config.nodeEnv, logger: log })` built beside the existing `verifySignature`.

- Consumes: Task 2 repo methods, Task 3 adapter methods, Task 4 middleware.

- [ ] **Step 1: Write failing tests** in `app/test/voiceIntelligenceWebhook.test.ts` using the harness + a `signedJsonPost` helper (add it to the harness file next to `signedTwilioPost`, exact code from Task 4's test but using harness constants and taking `app` from `makeWebhookHarness`). Seed a founder-bridge call via the same `seedFounderBridge(world)` fixture style `voiceRecording.test.ts` uses (copy it). Cases (each a real test - these MIGRATE the guardrail intents from the legacy endpoint suite):

```ts
it('rejects an unsigned / tampered POST (403)', ...);
it('400s when transcript_sid is missing', ...);
it('persists joined sentences on a completed transcript and emits message.persisted', async () => {
  // world.viTranscripts.set('GTfake1', { status: 'completed', customerKey: 'CAbiz0001',
  //   sentences: [{ text: 'hello', mediaChannel: 1 }, { text: 'hi', mediaChannel: 2 }] });
  // POST { transcript_sid: 'GTfake1' } -> 200
  // expect(entry.transcript).toBe('Speaker 1: hello\nSpeaker 2: hi');
  // expect(entry.transcript_status).toBe('completed');
  // expect(world.emitted.some(e => e.event === 'message.persisted')).toBe(true);
});
it('single-channel sentences join without speaker prefixes', ...); // voicemail shape
it('a redelivered webhook never overwrites (transcript unchanged, 200)', ...);
it('a transcript with no customerKey is ignored with 200 (not ours)', ...);
it('a MASKED call transcript is refused (200, nothing saved)', ...); // seed masked call, customerKey -> its sid
it('status failed stamps transcript_status=failed (200)', ...);     // seed pending first via setTranscriptPending
it('a Twilio API failure returns 500', async () => {
  // world.viTranscripts has no 'GTmissing' -> fetchViTranscript throws -> 500
});
it('never logs transcript text', ...); // capture.lines pattern from voiceRecording.test.ts
```

- [ ] **Step 2: Run:** `npm test -w app -- voiceIntelligenceWebhook` -> FAIL (route missing).
- [ ] **Step 3: Implement** `voiceTranscripts.ts` (joinViSentences + persistViTranscript per the interface block above - that block IS the logic, write it out) and the route + `verifyJsonSignature` in voice.ts.
- [ ] **Step 4: Run:** `npm test -w app -- voiceIntelligenceWebhook` -> PASS.
- [ ] **Step 5: Commit** `feat(voice): /voice/intelligence webhook - fetch VI sentences, persist via idempotent seam`.

---

### Task 6: Jobs - `createVoiceTranscript` + `reconcileVoiceTranscript`

**Files:**
- Create: `app/src/jobs/voiceTranscript.ts`
- Modify: `app/src/jobs/registerHandlers.ts`
- Test: `app/test/voiceTranscriptJobs.test.ts`

**Interfaces:**
- Produces (modeled EXACTLY on `missedCallAutoText.ts`'s shape - name constant, payload parser, deps interface, registrar):

```ts
export const CREATE_VOICE_TRANSCRIPT_JOB = 'voice.createTranscript';
export interface CreateVoiceTranscriptPayload { callSid: string; recordingSid: string }
export const RECONCILE_VOICE_TRANSCRIPT_JOB = 'voice.reconcileTranscript';
export interface ReconcileVoiceTranscriptPayload { callSid: string; transcriptSid: string; attempt: number }
export interface VoiceTranscriptJobDeps { config?; adapter?; messagesRepo?; events?; logger? }
export function registerVoiceTranscriptJobHandlers(deps: VoiceTranscriptJobDeps = {}): void;
export const RECONCILE_MAX_ATTEMPTS = 3;
```

Behavior:
- `createVoiceTranscript` handler: parse payload; resolve entity (`getByProviderSid`); SKIP silently (log info) when: no entity / not a call / `masked === true` / `transcript` already present / `config.twilioViServiceSid` unset. Else `adapter.createViTranscript({ serviceSid, recordingSid, customerKey: callSid })` - API failure THROWS (SQS redelivery -> DLQ). On success: `enqueue(RECONCILE_VOICE_TRANSCRIPT_JOB, { callSid, transcriptSid, attempt: 1 }, { runAt: new Date(Date.now() + config.voiceTranscriptReconcileSeconds * 1000) })`.
- `reconcileVoiceTranscript` handler: parse; entity transcript already present -> done (info). Else `persistViTranscript(...)` (from Task 5 - REUSE, do not duplicate): outcome `'saved'`/`'already-saved'`/`'failed-stamped'`/`'masked-refused'`/`'not-ours'` -> done; `'not-completed'` -> `attempt < RECONCILE_MAX_ATTEMPTS` ? re-enqueue `{ ...payload, attempt: attempt + 1 }` with the same delay : `setTranscriptFailed(callSid)` + WARN with sids. Twilio API errors propagate (throw) -> jobs redelivery/DLQ.
- Registrar wired into `registerAllJobHandlers` in `registerHandlers.ts` (no tokenBucket needed - follow the retrySend example).

- [ ] **Step 1: Write failing tests** following `app/test/missedCallAutoText.test.ts` verbatim in structure (`_resetForTests`, `configureJobsLogger`, `configureScheduler(new InMemorySchedulerAdapter())`, `configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }))`, `registerVoiceTranscriptJobHandlers({ config: testConfig, adapter: world.adapter, messagesRepo: world.messagesRepo, events: world.events, logger })`, `await queueAdapter.settle()`), with `testConfig = { ...loadConfig(harnessEnv), twilioViServiceSid: 'GAsvc', voiceTranscriptReconcileSeconds: 1 }`. Cases:

```ts
it('create: happy path creates with customerKey=callSid and enqueues reconcile attempt 1', ...);
it('create: skips masked / missing / already-transcribed / VI-unset (no adapter call)', ...);
it('create: adapter failure throws (queue redelivers)', ...); // world.viCreateError = new Error('boom')
it('reconcile: transcript already present -> no adapter fetch', ...);
it('reconcile: completed -> persists via the shared helper (transcript saved + status completed)', ...);
it('reconcile: in-progress re-enqueues until attempt 3 then stamps failed', async () => {
  // world.viTranscripts.set('GTfake1', { status: 'in-progress', customerKey: 'CAbiz0001', sentences: [] });
  // enqueueImmediate(RECONCILE..., { callSid, transcriptSid: 'GTfake1', attempt: 1 }); settle();
  // -> after settle chain (attempts 1..3), entry.transcript_status === 'failed'
});
it('reconcile: VI status failed stamps transcript_status failed immediately', ...);
```

- [ ] **Step 2: Run:** `npm test -w app -- voiceTranscriptJobs` -> FAIL.
- [ ] **Step 3: Implement** `voiceTranscript.ts` per the behavior block + wire the registrar.
- [ ] **Step 4: Run:** `npm test -w app -- voiceTranscriptJobs` -> PASS.
- [ ] **Step 5: Commit** `feat(jobs): createVoiceTranscript + reconcileVoiceTranscript (retry + self-heal)`.

---

### Task 7: Recording handler - pending stamp + inline VI create + fallback enqueue

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` (recording handler, after the S3 mirror success + `message.persisted` emit)
- Test: extend `app/test/voiceRecording.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3, 6. Produces the create-leg behavior every transcript depends on.

- [ ] **Step 1: Write failing tests** (extend the recording-callback describe block; reuse `founderHarness`/`seedFounderBridge`/`recordingParams` fixtures; make the harness config set `twilioViServiceSid: 'GAsvc'` via `makeWebhookHarness`'s env/config seam - add `TWILIO_VI_SERVICE_SID` to the harness default env or pass per-test):

```ts
it('completed founder-bridge recording stamps transcript_status=pending, creates VI inline, enqueues reconcile', async () => {
  // after signedTwilioPost /voice/recording:
  // entry.transcript_status === 'pending'
  // world.viCreates[0] === { serviceSid: 'GAsvc', recordingSid: 'REbiz0001', customerKey: 'CAbiz0001' }
  // one enqueued reconcile job (assert via the InProcess queue or world jobs seam used by existing tests)
});
it('inline create failure falls back to the createVoiceTranscript job and still 200s', async () => {
  // world.viCreateError = new Error('twilio down'); POST -> 200;
  // entry.transcript_status === 'pending'; a create job was enqueued (not reconcile)
});
it('VI unset -> no pending stamp, no create, no jobs (recording still stored)', ...);
it('masked recording still refused before any VI activity', ...); // existing test extended: viCreates stays empty
it('a redelivered recording callback does not double-create (recording_s3_key present -> early 200)', ...);
```

- [ ] **Step 2: Run:** `npm test -w app -- voiceRecording` -> new tests FAIL.
- [ ] **Step 3: Implement.** In the recording handler, insert AFTER the successful mirror/emit (and ALSO in Task 10's voicemail branch - write it once as a local helper):

```ts
/** Create leg (spec 3.2): pending stamp + inline VI create, job fallback. Recording is already safe. */
async function requestTranscription(entryCallSid: string, recordingSid: string): Promise<void> {
  if (!config.twilioViServiceSid) return;
  await messages.setTranscriptPending(entryCallSid); // idempotent; emit below regardless of first/repeat
  const fresh = await messages.getByProviderSid(entryCallSid);
  if (fresh) {
    events.emit('message.persisted', { conversationId: fresh.conversationId, tsMsgId: fresh.tsMsgId, direction: fresh.direction, deliveryStatus: fresh.delivery_status });
  }
  try {
    const { transcriptSid } = await adapter.createViTranscript({ serviceSid: config.twilioViServiceSid, recordingSid, customerKey: entryCallSid });
    await enqueue(RECONCILE_VOICE_TRANSCRIPT_JOB, { callSid: entryCallSid, transcriptSid, attempt: 1 }, { runAt: new Date(Date.now() + config.voiceTranscriptReconcileSeconds * 1000) });
    log.info({ callSid: entryCallSid, transcriptSid }, 'vi transcript requested inline');
  } catch (err) {
    log.warn({ err, callSid: entryCallSid, recordingSid }, 'inline vi create failed - falling back to job');
    try {
      await enqueue(CREATE_VOICE_TRANSCRIPT_JOB, { callSid: entryCallSid, recordingSid });
    } catch (enqueueErr) {
      log.error({ err: enqueueErr, callSid: entryCallSid }, 'vi create fallback enqueue failed');
    }
  }
}
```

Call `await requestTranscription(entryCallSid, RecordingSid)` at the end of the successful-mirror path (never before the mirror; never for masked - the masked refusal already returned earlier).

- [ ] **Step 4: Run:** `npm test -w app -- voiceRecording` -> PASS.
- [ ] **Step 5: Commit** `feat(voice): recording handler requests VI transcription (inline fast path + job fallback)`.

---

### Task 8: DELETE the legacy `/voice/transcription` endpoint (app side)

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` (delete the `router.post('/transcription', ...)` handler ~1514-1588 + the header comment line ~7 + M1.9c comment block)
- Modify: `app/test/voiceRecording.test.ts` (delete the legacy `describe('transcription callback ...')` block + `transcriptionParams` helper)

**Interfaces:**
- Consumes: Task 5 (the VI suite now carries the guardrail coverage - verify BEFORE deleting: signature-403, never-overwrite, masked-refusal, empty/no-op cases all exist in `voiceIntelligenceWebhook.test.ts`).

- [ ] **Step 1: Confirm coverage migration** - `rg "masked|overwrite|403" app/test/voiceIntelligenceWebhook.test.ts` shows the migrated cases. If any legacy test asserts an intent the VI suite lacks, ADD it to the VI suite first.
- [ ] **Step 2: Delete** the route handler + legacy tests + helper. `rg "voice/transcription|TranscriptionText" app/src app/test` -> zero hits.
- [ ] **Step 3: Run:** `npm test -w app` (full app workspace) -> PASS; `npm run typecheck` -> PASS.
- [ ] **Step 4: Commit** `feat(voice)!: remove legacy /voice/transcription endpoint (real Twilio never had a path to it)`.

---

### Task 9: Voicemail TwiML - catalog copy + missed-branch `<Record>` + record-action route

**Files:**
- Modify: `app/src/messages/catalog.ts` (2 new entries)
- Modify: `app/src/routes/webhooks/voice.ts` (missed branch in `/status`; new `POST /voicemail-done` route)
- Test: extend `app/test/voiceWebhook.test.ts` (or the file holding the missed-branch TwiML assertions - `rg -l "missed_call_goodbye" app/test`)

**Interfaces:**
- Produces catalog ids (exact copy, ASCII):

```ts
'voice.voicemail_prompt': {
  id: 'voice.voicemail_prompt',
  default:
    'Sorry we missed your call. Please leave a message after the tone, and we will get back to you as soon as we can.',
  class: 'voice', editable: false, channel: 'voice', vars: [],
},
'voice.voicemail_thanks': {
  id: 'voice.voicemail_thanks',
  default: 'Thank you. We got your message and will get back to you soon. Goodbye.',
  class: 'voice', editable: false, channel: 'voice', vars: [],
},
```

- Produces TwiML: the `if (isMissed)` goodbye block becomes (INBOUND founder-bridge only - the enclosing guard `fresh.type === 'call' && fresh.masked !== true && fresh.direction !== 'outbound'` already scopes the `onFounderBridgeMissed` call; the TwiML branch must use the SAME condition, keeping masked/outbound on the old goodbye+hangup):

```ts
if (isMissed && isInboundFounderBridge) {
  reply.say(resolveMessage('voice.voicemail_prompt'));
  reply.record({
    maxLength: 120,
    playBeep: true,
    action: `${baseUrl}/webhooks/twilio/voice/voicemail-done`,
    recordingStatusCallback: `${baseUrl}/webhooks/twilio/voice/recording`,
    recordingStatusCallbackEvent: ['completed'],
  });
  reply.say(resolveMessage('voice.voicemail_thanks')); // reached only if <Record> falls through without recording
  reply.hangup();
} else if (isMissed) {
  reply.say(resolveMessage('voice.missed_call_goodbye'));
  reply.hangup();
}
```

(`baseUrl` = the same base the existing recordingStatusCallback URLs use at ~581/~1111 - reuse that variable/derivation. Twilio VoiceResponse `.record()` camelCase attrs are correct for the v6 twiml builder.)

- New route:

```ts
// <Record action> - fires when the caller finishes (hash/timeout/hangup mid-record).
// The voicemail itself arrives via the recordingStatusCallback; this route only closes the call politely.
router.post('/voicemail-done', verifySignature, (_req, res) => {
  const reply = new VoiceResponse();
  reply.say(resolveMessage('voice.voicemail_thanks'));
  reply.hangup();
  sendTwiml(res, reply);
});
```

- [ ] **Step 1: Write failing tests:**

```ts
it('missed INBOUND founder-bridge TwiML offers voicemail: prompt + Record(maxLength 120, playBeep, callbacks)', async () => {
  // drive the seeded founder-bridge to a missed Dial summary (existing fixture flow), then assert on the
  // /status response body: contains '<Record', 'maxLength="120"', 'playBeep="true"',
  // 'voicemail-done', '/webhooks/twilio/voice/recording', and the voicemail_prompt copy.
});
it('missed OUTBOUND founder-bridge and masked calls keep goodbye + hangup (no <Record>)', ...);
it('POST /voicemail-done returns thanks + hangup TwiML (signature required)', ...);
it('catalog: voicemail entries resolve', () => {
  expect(resolveMessage('voice.voicemail_prompt')).toMatch(/leave a message after the tone/);
  expect(resolveMessage('voice.voicemail_thanks')).toMatch(/got your message/);
});
```

- [ ] **Step 2: Run:** target file -> FAIL.
- [ ] **Step 3: Implement** catalog entries (MessageId union + MESSAGE_CATALOG) + TwiML branch + route.
- [ ] **Step 4: Run:** target file -> PASS; also the full `npm test -w app` (catalog snapshot/exhaustiveness tests may assert on the union - fix any such test additively).
- [ ] **Step 5: Commit** `feat(voice): missed business-line calls offer voicemail (Record TwiML + catalog copy)`.

---

### Task 10: Voicemail recording classification - outcome upgrade + push + min-duration discard

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` (recording handler + new `sendVoicemailPush` beside `sendMissedCallPush`)
- Test: extend `app/test/voiceRecording.test.ts`

**Interfaces:**
- Consumes: Task 2 `upgradeCallOutcomeToVoicemail`, Task 7 `requestTranscription`, the existing `sendMissedCallPush` shape (~1621-1670: resolveFounders + pushCallerLabel + pushService.sendToUser loop).
- Produces: recording handler behavior - BEFORE the recording claim, for a founder-bridge (masked false) INBOUND call whose `call_outcome === 'missed'`:
  - `Number(RecordingDuration) < 2` -> log info `{ callSid, recordingSid, duration }` 'voicemail below minimum duration - discarded', 200, NO store, NO outcome change.
  - Otherwise proceed with the normal claim/mirror flow; after the successful mirror: `const upgraded = await messages.upgradeCallOutcomeToVoicemail(entryCallSid)`; if `upgraded` -> emit `message.persisted` + fire-and-forget `sendVoicemailPush(entry.conversationId, entryCallSid)` (best-effort, try/catch log, exactly the missed-push posture); `requestTranscription(...)` runs for voicemail recordings exactly as for bridge recordings (Task 7's call site is shared).

```ts
/** Best-effort "New voicemail" push - sibling of sendMissedCallPush, same masked posture. */
async function sendVoicemailPush(conversationId: string, callSid: string): Promise<void> {
  // copy sendMissedCallPush's body: resolveFounders(); load entry for call_party_label;
  // callerLabel = pushCallerLabel(storedLabel, conversation?.participant_phone);
  // payload = { title: 'New voicemail', body: `New voicemail - ${callerLabel}`,
  //             kind: 'voicemail' as const, callId: callSid, conversationId };
  // for each founder: await pushService.sendToUser(founder.userId, { kind: 'voicemail', payload });
  // wrap in the same never-throws error handling.
}
```

(Also check `dashboard/public/sw.js`: if the service worker routes strictly by `kind`, add a `voicemail` case mirroring `missed_call`'s notification display - keep it minimal, no new actions.)

- [ ] **Step 1: Write failing tests:**

```ts
it('a completed recording on a MISSED inbound founder-bridge call becomes a voicemail: outcome upgraded, push sent, transcription requested', async () => {
  // drive seeded founder-bridge to missed (digit:null flow fixtures), then POST /voice/recording
  // with RecordingDuration '6'. Assert: entry.call_outcome === 'voicemail';
  // world.pushSends has one { kind: 'voicemail' }; world.viCreates.length === 1;
  // recording stored (mediaPuts) as usual.
});
it('a redelivered voicemail recording callback upgrades/pushes only once', ...); // second POST: pushSends still 1
it('a sub-2s voicemail is discarded: no store, outcome stays missed, no push, no VI', ...); // RecordingDuration '1'
it('an ANSWERED call recording never upgrades outcome or fires the voicemail push', ...); // existing answered fixture + assertions
it('voicemail push failure never breaks the callback (200, recording stored)', ...); // make pushService throw
```

- [ ] **Step 2: Run:** -> FAIL.
- [ ] **Step 3: Implement** per the Produces block (min-duration check placed before the claim; upgrade+push after successful mirror; reuse `requestTranscription`).
- [ ] **Step 4: Run:** `npm test -w app -- voiceRecording` -> PASS.
- [ ] **Step 5: Commit** `feat(voice): voicemail classification - outcome upgrade, New-voicemail push, min-duration discard`.

---

### Task 11: Serialization + dashboard - transcript_status, Voicemail label, indicator, audio player

**Files:**
- Modify: `app/src/routes/contactTimeline.ts` (app `TimelineCall` type ~140-148 + `toTimelineCall` whitelist ~349-374)
- Modify: `dashboard/src/api/types.ts` (`TimelineCall` ~1342-1350 and `Message` call fields ~1266-1273: add `transcript_status?: 'pending' | 'completed' | 'failed'`)
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (`CallCard` ~491-523) + `Timeline.module.css`
- Test: `app/test/contactTimeline.test.ts` (serialization) + `dashboard/src/routes/contact/Timeline.test.tsx` (rendering)

**Interfaces:**
- Consumes: Task 2's field; the existing streaming endpoint `GET /api/calls/:callId/recording` (`TimelineCall.id` IS the callSid/provider_sid - VERIFY by reading how `toTimelineCall` sets `id` before wiring the src).
- Produces CallCard rendering (replace the transcript-collapsible block):

```tsx
{call.recording_s3_key ? (
  <audio className={styles.recordingPlayer} controls preload="none"
    src={`/api/calls/${call.id}/recording`} aria-label="Call recording" />
) : null}
{call.transcript_status === 'pending' ? (
  <p className={styles.transcriptPendingNote}>Transcribing...</p>
) : call.transcript_status === 'failed' ? (
  <p className={styles.transcriptPendingNote}>Transcript unavailable</p>
) : call.transcript ? (
  <details className={styles.transcript}>
    <summary className={styles.transcriptToggle}>Transcript</summary>
    <p className={styles.transcriptBody}>{call.transcript}</p>
  </details>
) : null}
```

CSS: `.recordingPlayer { width: 100%; max-width: 320px; }` and `.transcriptPendingNote` = the muted/secondary text style the module already uses (copy an existing muted class's properties). NOTE the label: outcome already renders "Voicemail" via the existing capitalize expression - assert it, do not re-implement. Verify `styles.voicemail` exists in `Timeline.module.css`; if the class is missing, add a variant consistent with `.missed`/`.answered`.

Serialization: in `toTimelineCall`, inside the existing non-masked-only block that emits `recording_s3_key`/`transcript`, add `transcript_status: item.transcript_status` (masked calls never expose any of the three).

- [ ] **Step 1: Write failing tests.** App side (`contactTimeline.test.ts`, following its ~304-349 masked/non-masked pattern):

```ts
it('serializes transcript_status on non-masked calls and never on masked', ...);
```

Dashboard side (`Timeline.test.tsx`, following the existing CALL fixture test at ~108-117):

```tsx
it('renders Transcribing... while a transcript is pending (no collapsible)', () => {
  renderTimeline({ items: [{ ...CALL, transcript: undefined, transcript_status: 'pending' }] });
  expect(screen.getByText('Transcribing...')).toBeInTheDocument();
  expect(screen.queryByText(/Transcript$/)).not.toBeInTheDocument();
});
it('renders Transcript unavailable on failed', () => {
  renderTimeline({ items: [{ ...CALL, transcript: undefined, transcript_status: 'failed' }] });
  expect(screen.getByText('Transcript unavailable')).toBeInTheDocument();
});
it('renders a Voicemail call card with an audio player pointed at the recording endpoint', () => {
  renderTimeline({ items: [{ ...CALL, call_outcome: 'voicemail', recording_s3_key: 'recordings/CA1/RE1', transcript_status: 'completed' }] });
  expect(screen.getByText(/Voicemail/)).toBeInTheDocument();
  const player = screen.getByLabelText('Call recording');
  expect(player).toHaveAttribute('src', expect.stringContaining('/recording'));
});
```

- [ ] **Step 2: Run:** `npm test -w app -- contactTimeline` + `npm test -w dashboard -- Timeline` -> FAIL.
- [ ] **Step 3: Implement** the type threading + CallCard changes + CSS.
- [ ] **Step 4: Run:** both -> PASS. `npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(dashboard): call recording player + transcript status indicator + voicemail card`.

---

### Task 12: fake-twilio - VI REST + JSON webhook + engine flow + legacy removal

**Files:**
- Create: `fake-twilio/src/routes/intelligenceRest.ts`
- Modify: `fake-twilio/src/engine/callEngine.ts` (VI state + webhook firing; DELETE the legacy transcription block ~553-563 + import)
- Modify: `fake-twilio/src/engine/signer.ts` (DELETE `buildTranscriptionParams`; ADD `signTwilioJsonWebhook`)
- Modify: `fake-twilio/src/engine/dispatcher.ts` (ADD `postJson`)
- Modify: `fake-twilio/src/engine/voiceTypes.ts` (`CallScenario.viWebhook?: 'deliver' | 'drop'`; `CallState.viTranscriptSid?`)
- Modify: `fake-twilio/src/routes/voiceControl.ts` (`validateScenario`: `viWebhook` in `{deliver,drop}`)
- Modify: `fake-twilio/src/server.ts` (mount the VI router; add `'/v2'` to the SPA reserved-prefix list ~153)
- Modify: `fake-twilio/test/callEngineRecording.test.ts` + `fake-twilio/test/voiceSigner.test.ts` (migrate legacy assertions)
- Test: `fake-twilio/test/intelligenceRest.test.ts`

**Interfaces:**
- Produces the fake VI surface the app SDK hits (via the origin-rewriting client - paths must match twilio SDK v6's intelligence.v2 request paths EXACTLY; verify in `node_modules/twilio/lib/rest/intelligence/v2/` before coding):
  - `POST /v2/Transcripts` (SDK create; body includes `ServiceSid`/`Channel`/`CustomerKey` - verify casing/encoding from the SDK source) -> registers `{ sid: 'GTfake<n>', status: 'completed', customer_key, source_sid }`, responds with the instance JSON (snake_case), and schedules the webhook.
  - `GET /v2/Transcripts/:sid` -> instance JSON `{ sid, status, customer_key, ... }`.
  - `GET /v2/Transcripts/:sid/Sentences` -> list JSON `{ sentences: [{ transcript, media_channel, sentence_index }...], meta: { key: 'sentences', page: 0, page_size: 50, first_page_url: '', url: '', next_page_url: null, previous_page_url: null } }` (the SDK's Page parser needs `meta.key` + `next_page_url: null` - match what the SDK's version.ts/page.ts expects).
- Engine additions:
  - When a recording fires (bridge today, voicemail in Task 13), the engine records `pendingVi: Map<recordingSid, { callSid, text?: string, viWebhook: 'deliver' | 'drop' }>` from `scenario.transcript` + `scenario.viWebhook ?? 'deliver'`.
  - `createViTranscript({ serviceSid, customerKey, sourceSid })` (called by the REST route): mints `GTfake<n>`, builds sentences from the pending entry's `text` (split on sentence-ending punctuation into 1-3 sentences; channel = 1 for all, EXCEPT for bridge recordings where alternate sentences get channel 2 to exercise speaker labels - deterministic: odd index -> 2), stores the transcript, sets `call.viTranscriptSid`, emits `call.transcript` hub event, and if `viWebhook === 'deliver'` fires (async, on the injected clock/immediate) `dispatcher.postJson('/webhooks/twilio/voice/intelligence', { transcript_sid: sid, status: 'completed', customer_key: customerKey, service_sid: serviceSid, event_type: 'voice_intelligence_transcript_available' })`.
  - `getViTranscript(sid)` / `getViSentences(sid)` accessors for the REST router.
- `dispatcher.postJson(path, body)`: raw = `JSON.stringify(body)`; `sha256hex(raw)`; url = `${appBaseUrl}${path}?bodySHA256=${sha}`; sign with `signTwilioJsonWebhook({ authToken, url: `${appPublicBaseUrl}${path}?bodySHA256=${sha}` })` = `twilio.getExpectedTwilioSignature(authToken, url, {})` equivalent (fake-twilio already depends on the same HMAC scheme in `signTwilioWebhook` - implement JSON variant as HMAC-SHA1 over the URL with no params, matching Task 4's validator); headers `content-type: application/json`, `x-twilio-signature`, `x-origin-verify`.

- [ ] **Step 1: Write failing tests** (`intelligenceRest.test.ts` - follow `callEngineRecording.test.ts`'s stub-dispatcher pattern):

```ts
it('POST /v2/Transcripts registers a transcript from the pending recording and fires the signed JSON webhook', ...);
it('viWebhook: drop registers the transcript but never posts the webhook', ...);
it('GET /v2/Transcripts/:sid and /Sentences serve SDK-shaped JSON (meta.key sentences, next_page_url null)', ...);
it('bridge recordings alternate media_channel 1/2; single-channel otherwise', ...);
it('the JSON webhook signature validates with the bodySHA256 scheme', ...); // recompute expected signature in the test
```

Also migrate: in `callEngineRecording.test.ts` replace the legacy `/voice/transcription` stub + `TranscriptionText==='hi'` assertions with: recording fires -> pendingVi populated; after REST create -> webhook fired (or dropped); masked -> never any VI. In `voiceSigner.test.ts` remove `buildTranscriptionParams` cases, add `signTwilioJsonWebhook` shape test.

- [ ] **Step 2: Run:** `npm test -w fake-twilio` -> FAIL.
- [ ] **Step 3: Implement** all of the above; DELETE `buildTranscriptionParams` + the engine legacy block; `rg "buildTranscriptionParams|TranscriptionText" fake-twilio/` -> zero hits.
- [ ] **Step 4: Run:** `npm test -w fake-twilio` -> PASS; `npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(fake-twilio): voice intelligence model (REST + signed JSON webhook) replaces legacy transcription`.

---

### Task 13: fake-twilio - `<Record>` verb + missed-branch voicemail flow

**Files:**
- Modify: `fake-twilio/src/engine/twimlInterpreter.ts` (new `record` plan)
- Modify: `fake-twilio/src/engine/callEngine.ts` (`runDialChain` missed path: switch the Dial-action POST to `postForResponse`, interpret, follow a record plan)
- Modify: `fake-twilio/src/engine/voiceTypes.ts` (`CallScenario.voicemail?: { durationSec?: number } | false` - default: leave a ~6s voicemail when the missed TwiML offers one; `false` = hang up at the beep)
- Modify: `fake-twilio/src/routes/voiceControl.ts` (validate the new knob)
- Test: extend `fake-twilio/test/callEngineRecording.test.ts` (or a new `callEngineVoicemail.test.ts`)

**Interfaces:**
- Produces `TwimlPlan` addition:

```ts
| { kind: 'record'; maxLength?: number; playBeep?: boolean; actionUrl?: string;
    recordingStatusCallback?: string }
```

`interpretTwiml`: check for a `Record` element BEFORE the say/hangup fallbacks (a voicemail response is Say+Record+Say+Hangup - the presence of `Record` wins). Attributes via `@_maxLength` (Number), `@_playBeep`, `@_action`, `@_recordingStatusCallback`.

- Engine missed path (in `runDialChain`, where the terminal `<Dial action>` summary posts): use `postForResponse` for the Dial-action POST; when the interpreted response is a `record` plan AND `scenario.voicemail !== false`: mint a recordingSid, POST the recording callback (`buildRecordingParams` with `durationSec: scenario.voicemail?.durationSec ?? 6`) to `plan.recordingStatusCallback`, register `pendingVi` for it (single-channel), then POST `plan.actionUrl` (form, `postForResponse`, params `buildDialStatusParams`-style minimal `{ CallSid }` plus `RecordingDuration` - verify what the app's `/voicemail-done` route actually reads: nothing, so `{ CallSid: call.callSid, ApiVersion: '2010-04-01' }` suffices) and set `call.status = 'completed'`. When `scenario.voicemail === false` or the plan is not `record`: today's behavior (discard, status per dialStatus).

- [ ] **Step 1: Write failing tests:**

```ts
it('a missed founder-bridge whose Dial-action response offers <Record> leaves a voicemail: recording callback fired with duration, pendingVi single-channel', ...);
it('scenario.voicemail:false hangs up at the beep - no recording callback', ...);
it('a masked missed call gets no voicemail (app returns no <Record> - engine sees say/hangup and stops)', ...);
it('interpretTwiml parses Say+Record+Say+Hangup into a record plan with attrs', ...);
```

- [ ] **Step 2: Run:** -> FAIL.
- [ ] **Step 3: Implement** interpreter + engine + knob validation + e2e fixture mirror type (Task 14 consumes it).
- [ ] **Step 4: Run:** `npm test -w fake-twilio` -> PASS.
- [ ] **Step 5: Commit** `feat(fake-twilio): Record verb + missed-branch voicemail flow`.

---

### Task 14: e2e - transcription + voicemail end-to-end (real VI shapes)

**Files:**
- Modify: `e2e/fixtures/fakeVoice.ts` (scenario mirror: replace `transcript?: string` semantics doc; add `viWebhook?: 'deliver'|'drop'`, `voicemail?: { durationSec?: number } | false`)
- Create: `e2e/tests/dashboard-next/voice-transcription.spec.ts`
- Modify: the e2e stack env so `VOICE_TRANSCRIPT_RECONCILE_SECONDS=2` and `TWILIO_VI_SERVICE_SID=GAfakeservice` are set for the app under test (find where the harness passes `FOUNDER_CELL`/`OUR_PHONE_NUMBERS` - `rg "FOUNDER_CELL" scripts/` - and add the two vars in `scripts/e2e-session.mjs` + `scripts/dev.mjs` the same way)

**Interfaces:**
- Consumes: Tasks 12-13 fake behavior, Task 11 UI, the `Scenario`/steps vocabulary in `e2e/scenarios/steps.ts` and fixtures (`placeCall`, `tenantCallNoAnswer`).

- [ ] **Step 1: Write the spec** (accessibility-first selectors per `e2e/support/selectors.md`; scope bubbles to `getByRole('region', { name: 'Communications and activity' })` on the contact page; the answered-call flow mirrors `voice-outbound.spec.ts`'s inbound-business-call setup):

```ts
test('an answered business-line call gets a transcript in the call card', async ({ page, request }) => {
  // placeCall(request, { from: TENANT, to: BUSINESS, scenario: { digit: '1', transcript: 'Hello about the unit. Sounds good.' } })
  // open the tenant contact page; within the Communications region:
  // await expect(region.getByText('Transcribing...')).toBeVisible({ timeout: 15_000 }); // pending stamp beats webhook
  // await region.getByText('Transcript').click();
  // await expect(region.getByText(/Speaker 1: /)).toBeVisible({ timeout: 15_000 });
  // await expect(region.getByLabel('Call recording')).toBeVisible();
});
test('a missed business-line call takes a voicemail: Voicemail card + transcript + auto-text still sent', async ({ page, request }) => {
  // placeCall(request, { from: TENANT, to: BUSINESS, scenario: { digit: null, transcript: 'Please call me back.' } })
  // assert /__dev/outbox contains the missed-call auto-text (existing outbox fixture helpers);
  // contact page: await expect(region.getByText('Voicemail')).toBeVisible({ timeout: 15_000 });
  // expand Transcript -> 'Please call me back.' (single-channel: NO 'Speaker' prefix);
  // audio player visible.
});
test('a dropped VI webhook still transcribes via reconcile, showing Transcribing... meanwhile', async ({ page, request }) => {
  // scenario: { digit: '1', transcript: 'Reconciled text.', viWebhook: 'drop' }
  // assert 'Transcribing...' visible; then (reconcile delay is 2s in the lane)
  // transcript appears within ~20s without any webhook delivery.
});
test('a missed masked relay call still gets no voicemail', async ({ request }) => {
  // masked pool-number miss (existing masked fixtures); poll /control/calls: no recordingSid on the call.
});
```

- [ ] **Step 2: Run the suite** from the worktree: `timeout 1500 npm run e2e` -> new spec passes, full suite green (re-run once before blaming a change for the two known flakes: tour-reminders-panel, conversationdetail-members).
- [ ] **Step 3: Commit** `test(e2e): voice transcription + voicemail end-to-end against real VI shapes`.

---

### Task 15: RUNBOOK + docs + final gates

**Files:**
- Modify: `RUNBOOK.md` (Voice section: VI operator setup per spec section 8; latency expectations from spec 3.8; founder-facing voicemail behavior; note that the fake's voice section changes: transcription now rides the VI model)
- Modify: `.env.*.example` (verify Task 1 covered all envs)
- Verify: `rg "voice/transcription" --type ts` across the repo -> zero code hits (docs/specs history may mention it - leave historical docs alone)

**Steps:**
- [ ] **Step 1: Write the RUNBOOK section** (operational only - no issue content): create a VI service per env in the Twilio console (Voice Intelligence -> Services), set the webhook URL to `<env base URL>/webhooks/twilio/voice/intelligence` with the transcript-available event, put the `GAxxxx` sid in `TWILIO_VI_SERVICE_SID` (template-first: `.env.<stage>.example` then real env + deploy - operator action, NOT the agent's); cost note (billed per transcribed hour; only business-line calls + voicemails); the reconcile safety net (lost webhook -> ~10 min, never lost); voicemail behavior (missed business-line call -> prompt + up to 2 min message -> "New voicemail" push + transcript; auto-text unchanged).
- [ ] **Step 2: Full gates, bare, from the worktree:** `npm run typecheck` then `npm test` then `timeout 1500 npm run e2e` - all green, exit codes quoted in the handback.
- [ ] **Step 3: Commit** `docs(runbook): voice intelligence setup + voicemail behavior + transcript latency`.

---

## Post-merge obligations (recorded for the handback - HUMAN-gated, never the agent's)

- Create VI services (dev + prod) in Twilio; set webhook URLs; add `TWILIO_VI_SERVICE_SID` to real env secrets; deploy.
- Until then the feature is silently OFF in deployed envs (recordings/voicemails still work; no transcripts, no pending indicator - `transcript_status` stays absent).
- No terraform/schema ops; no new npm deps.

## Watch items for the builder (spec section 9 restated)

- twilio v6 `intelligence.v2` exact request/response shapes - read the SDK source in node_modules FIRST (Tasks 3, 12 both depend on it; keep the app fake-client fixture, the harness fake, and the fake-twilio REST all aligned with the SDK, not with guesses).
- `validateRequestWithBody` mechanics (Task 4) - app validator and fake signer must agree; live behavior against real Twilio is a post-merge operator verification, and the reconcile job covers a mismatch.
- `<Record>` action/callback ordering quirks (Task 13's engine model is deterministic; the app handles either order because classification keys on the stored outcome, not arrival order).
- Timeline `styles.voicemail` CSS class existence (Task 11).
- The two known e2e flakes (profile): re-run before attributing failures.
