# Fake-Twilio Voice (+ RCS seams) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the fake-twilio mock to drive the app's real Programmable Voice flows (masked-relay + founder-triage, whisper/press-1 gate, press-0 escape, `<Dial action>` bridge outcome, founder-bridge recording + transcription) at HTTP-seam fidelity, plus the number-provisioning REST masked-relay depends on, plus real `Calls.json`/click-to-call — all driven by control-API endpoints. RCS ships as a documented contract + `501` seams only.

**Architecture:** A new `CallEngine` (per-call state + step-drivable, scenario-runnable lifecycle) sibling to the messaging engine, plus a standalone `twimlInterpreter` (parses the app's actual returned TwiML with a small XML dep and walks the ~6 used verbs). Both reuse the existing signed `WebhookDispatcher`, injectable `Clock`, and a shared event bus. One dev-only app change: widen the media-fetch SSRF guard to accept the `TWILIO_API_BASE_URL` host (so the app can fetch a fake recording). The fake-phones **voice UI is a separate follow-up plan**.

**Tech Stack:** Node ≥24, TypeScript (strict, `noUncheckedIndexedAccess`), Express 5, `twilio` v6 (signature parity), `fast-xml-parser` (new, pinned), Vitest + supertest. Builds on the merged fake-twilio SMS mock now on `main`.

---

## Reference facts (verified — exact current code these tasks extend)

- **Media SSRF guard** `app/src/adapters/messaging.ts` — `TWILIO_MEDIA_HOST = 'api.twilio.com'` (L145), `MAX_MEDIA_CONTENT_LENGTH = 25MB` (L148). `fetchTwilioMediaStream(mediaUrl, op)` (L558-605) uses a **raw `fetch`** (NOT the redirected httpClient) and rejects unless `url.protocol === 'https:' && url.hostname === 'api.twilio.com'` (throws `MediaFetchRefusedError('host_not_allowed')`). `getRecordingStream` (L540-550) appends `.mp3` when the URL lacks `.mp3/.wav`. `getMediaStream` (L536-538) shares the guard. The driver already receives `deps.apiBaseUrl` (= `config.twilioApiBaseUrl`, L341/361; wired into the redirecting client at L375-389).
- **Voice routes** `app/src/routes/webhooks/voice.ts` (all behind the same `twilioSignatureMiddleware` as SMS; voice router mounts at `/webhooks/twilio/voice`):
  - `POST /` inbound — reads `CallSid`,`From`,`To`; routes by `conversations.getByPoolNumber(To)` → masked, else founder.
  - **Masked TwiML:** `<Dial callerId=pool record=do-not-record answerOnBridge action=/voice/status><Number url=/voice/whisper?callerLabel=…&conversationId=…&parentCallSid=… statusCallback=/voice/status statusCallbackEvent=ringing>calleePhone</Number>…</Dial>`.
  - **Founder TwiML:** `<Pause length=preRing/><Dial callerId=business record=record-from-answer-dual recordingStatusCallback=/voice/recording recordingStatusCallbackEvent=completed answerOnBridge action=/voice/status><Number url=/voice/whisper?…&leg=founder statusCallback=/voice/status statusCallbackEvent=ringing>founderCell</Number></Dial>`.
  - `POST /whisper` (body `CallSid`; query `callerLabel,conversationId,parentCallSid,leg`) → `<Gather numDigits=1 timeout=8 action=/voice/whisper-gate method=POST><Say>…press 1[…press 0]</Say></Gather><Hangup/>`.
  - `POST /whisper-gate` (body `Digits`; query `conversationId,parentCallSid,leg`) → `1` → `<Pause length=1/>`; `0` (masked only) → `<Dial callerId=team><Number>team</Number></Dial>`; else → `<Hangup/>`.
  - `POST /status` — `<Dial action>` summary shape (`CallSid`,`DialCallStatus`,`DialCallDuration`, NO `ParentCallSid`) is authoritative; per-leg shape (`CallSid`,`ParentCallSid`,`CallStatus`, NO `DialCallStatus`) is logged only.
  - `POST /recording` — `CallSid`,`RecordingSid`,`RecordingStatus`,`RecordingUrl`,`RecordingDuration` → founder-bridge only; fetch via `getRecordingStream` → media store.
  - `POST /transcription` — `CallSid` + one of `Transcript`/`TranscriptionText`/`transcript`/`transcript_text` → `setCallTranscript` verbatim; founder-bridge only.
- **Adapter voice calls** (`messaging.ts`): `initiateCall` → `client.calls.create({to,from,url})` (L523-534, uses the redirected client); `provisionPhoneNumber` → `availablePhoneNumbers('US').local.list({voiceEnabled,smsEnabled,areaCode?,limit:1})` + `incomingPhoneNumbers.create({phoneNumber,smsUrl,voiceUrl})` (L454-506); `setVoiceWebhook` → `incomingPhoneNumbers.list({phoneNumber,limit:1})` + `incomingPhoneNumbers(sid).update({voiceUrl})` (L508-521).
- **Fake current modules** (`fake-twilio/src/`): `engine/signer.ts` (`signTwilioWebhook`, `buildInboundSmsParams`, `buildStatusParams`, `WebhookParams`); `engine/dispatcher.ts` (`WebhookDispatcher.post(path, params) → Promise<number>`); `engine/engine.ts` (`FakeTwilioEngine` with `subscribe`/private `emit`/`EngineEvent` union; deps `{clock, dispatcher}`); `engine/clock.ts` (`Clock`, `RealClock`, `ManualClock`); `routes/rest.ts` (`Messages.json` + the three `501` stubs `Calls.json`/`AvailablePhoneNumbers/:country/Local.json`/`IncomingPhoneNumbers.json`); `routes/control.ts`; `routes/events.ts` (SSE over `engine.subscribe`); `server.ts` (`buildFakeTwilioApp({config, engine?})`); `config.ts` (`FakeTwilioConfig`, `loadFakeConfig`); `vitest.config.ts` (scoped to `test/`).
- **Pool-number recognition:** the app routes a call to masked-relay only when `conversations.getByPoolNumber(To)` finds a relay with `pool_number === To`. So an end-to-end masked-relay test must FIRST set up a relay (which provisions a pool number through the fake), THEN place a call to that number.
- **Regression target** `e2e/tests/dashboard/boards.spec.ts`: "Set up relay thread" → provisions a pool number (`availablePhoneNumbers` + `incomingPhoneNumbers.create`) → intro SMS to `TENANT_PHONE=+15550100001` + `LANDLORD_PHONE=+15550100002`, asserted via the dev outbox. Currently fails because provisioning `501`s in the fake.

---

## File structure

**New in `fake-twilio/src/`:**
- `engine/eventHub.ts` — extracted shared event bus (`EventHub`: `subscribe`/`emit`), used by both engines.
- `engine/voiceTypes.ts` — `CallScenario`, `CallState`, `CallLeg`, voice `EngineEvent` variants.
- `engine/twimlInterpreter.ts` — parse TwiML → structured plan (uses `fast-xml-parser`).
- `engine/callEngine.ts` — per-call state + lifecycle (place/inbound, whisper, gate, outcome, recording, transcription, scenario runner, masked-vs-founder + click-to-call).
- `engine/numberRegistry.ts` — provisioned pool numbers (number + smsUrl/voiceUrl).
- `routes/voiceRest.ts` — `Calls.json` (click-to-call) + provisioning REST (replaces the 3 `501`s) + `recordings/:callSid/:recordingSid.mp3` serve.
- `routes/voiceControl.ts` — `place-call` + step endpoints + `GET /control/calls`.
- `routes/rcs.ts` — RCS `501` seams + `POST /control/send-rcs` stub.
- `assets/canned-recording.mp3` — a tiny committed dev audio blob.

**Modified in `fake-twilio/src/`:**
- `engine/signer.ts` — voice webhook builders.
- `engine/dispatcher.ts` — add `postForResponse(path, params) → {status, body}` (TwiML-returning webhooks).
- `engine/engine.ts` — use the shared `EventHub` (move `subscribe`/`emit` out); extend `EngineEvent`.
- `routes/rest.ts` — remove the 3 `501` stubs (moved to `voiceRest.ts`).
- `server.ts` — construct the `CallEngine` + `numberRegistry`, mount `voiceRest`/`voiceControl`/`rcs`.
- `config.ts` — no change expected (reuses `appBaseUrl`/`appPublicBaseUrl`/`authToken`/`originSecret`).
- `package.json` — add `fast-xml-parser` (pinned).

**Modified in `app/`:**
- `src/adapters/messaging.ts` — widen the media-fetch SSRF guard for the dev-override host (Phase 1).

**Docs/e2e:**
- `e2e/fixtures/fakeVoice.ts` — control-API client for voice.
- `e2e/tests/flows/fake-voice.spec.ts` — scripted voice proofs (code; live run joint).
- `docs/RCS-integration-contract.md` — the §9 contract.
- `RUNBOOK.md` — voice section.

---

## Phase 1 — SPIKE: media-fetch SSRF dev-override (the one app change)

### Task 1.1: Allow the `TWILIO_API_BASE_URL` host for media/recording fetch (dev-only)

**Files:** Modify `app/src/adapters/messaging.ts`; Test `app/test/mediaFetchDevOverride.test.ts`

- [ ] **Step 1: Write the failing test** (a fake http host serves bytes; assert fetch succeeds when `apiBaseUrl` matches, still rejected otherwise)

```ts
// app/test/mediaFetchDevOverride.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { TwilioMessagingDriver } from '../src/adapters/messaging.js';

let server: Server | undefined;
afterEach(() => server?.close());

async function startAudioHost(): Promise<{ origin: string; port: number }> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '3' });
    res.end(Buffer.from([0x49, 0x44, 0x33]));
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const addr = server!.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { origin: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

function driver(apiBaseUrl?: string) {
  return new TwilioMessagingDriver({
    accountSid: 'ACx', apiKeySid: 'SKx', apiKeySecret: 'secret', messagingServiceSid: 'MGx',
    ...(apiBaseUrl !== undefined && { apiBaseUrl }),
    client: {} as never, // not used for media fetch (raw fetch)
  });
}

describe('media-fetch dev-override', () => {
  it('fetches a recording from the fake host when apiBaseUrl matches it', async () => {
    const { origin } = await startAudioHost();
    const stream = await driver(origin).getRecordingStream(`${origin}/recordings/CA1/RE1.mp3`);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBe(3);
  });

  it('still REFUSES a non-allowed host even with apiBaseUrl set', async () => {
    const { origin } = await startAudioHost();
    await expect(driver(origin).getRecordingStream('http://evil.example/x.mp3')).rejects.toThrow(/host_not_allowed|refusing media/i);
  });

  it('without apiBaseUrl, only https api.twilio.com is allowed (http fake refused)', async () => {
    const { origin } = await startAudioHost();
    await expect(driver(undefined).getRecordingStream(`${origin}/x.mp3`)).rejects.toThrow(/host_not_allowed|refusing media/i);
  });
});
```

- [ ] **Step 2: Run it; confirm it fails** — `npm run test -w app -- mediaFetchDevOverride` → FAIL (the fake http host is refused even when `apiBaseUrl` matches).

- [ ] **Step 3: Implement the override** in `fetchTwilioMediaStream` (`app/src/adapters/messaging.ts`). Replace the guard block:

```ts
    const url = new URL(mediaUrl);
    // Dev-only: when the driver is redirected to a fake Twilio host
    // (deps.apiBaseUrl, set ONLY when config.twilioApiBaseUrl is configured —
    // which is rejected in production), also accept that exact origin for media
    // fetch. The fake serves recordings over http on localhost, so this widens
    // BOTH the protocol and host checks, but ONLY for the configured dev origin.
    const devOrigin = this.deps.apiBaseUrl !== undefined ? new URL(this.deps.apiBaseUrl).origin : undefined;
    const isRealTwilio = url.protocol === 'https:' && url.hostname === TWILIO_MEDIA_HOST;
    const isDevFake = devOrigin !== undefined && url.origin === devOrigin;
    if (!isRealTwilio && !isDevFake) {
      throw new MediaFetchRefusedError(
        `${op}: refusing media URL outside https://${TWILIO_MEDIA_HOST}` +
          (devOrigin !== undefined ? ` or ${devOrigin}` : '') +
          ` (got ${url.protocol}//${url.hostname})`,
        'host_not_allowed',
      );
    }
```

(Leave the basic-auth, size caps, and `capStreamBySize` exactly as-is — they still apply to the dev host harmlessly.)

- [ ] **Step 4: Run the test; green.** Then `npm run test -w app -- messaging` (no regression to existing media tests) + `npm run typecheck -w app`.

- [ ] **Step 5: Add a prod-safety test** `app/test/mediaFetchProdLocked.test.ts`: construct the driver with NO `apiBaseUrl` (the production shape — `config.twilioApiBaseUrl` is rejected in prod) and assert any non-`api.twilio.com` host is refused. (The Task-1.1 third test already covers this; add an explicit one asserting the error `code === 'host_not_allowed'` for clarity.)

- [ ] **Step 6: Commit** — `git add app/src/adapters/messaging.ts app/test/mediaFetchDevOverride.test.ts app/test/mediaFetchProdLocked.test.ts && git commit -m "feat(messaging): allow TWILIO_API_BASE_URL host for media fetch (dev-only; recording spike)"`

> **GATE:** This is the make-or-break app change. Confirm green before building the recording flow on it.

---

## Phase 2 — XML dep + `twimlInterpreter`

### Task 2.1: Add `fast-xml-parser`

**Files:** Modify `fake-twilio/package.json`

- [ ] **Step 1:** Add `"fast-xml-parser": "^4.5.0"` to `fake-twilio/package.json` dependencies (pin; reconcile the exact 4.x in the lockfile if already present elsewhere). Run `npm install`.
- [ ] **Step 2:** `npm run typecheck -w @housingchoice/fake-twilio` (clean). **Commit** — `chore(fake-twilio): add fast-xml-parser`.

### Task 2.2: `twimlInterpreter` — parse the used verb subset

**Files:** Create `fake-twilio/src/engine/twimlInterpreter.ts`, `fake-twilio/test/twimlInterpreter.test.ts`

- [ ] **Step 1: Write the failing test** (real TwiML fixtures from the app)

```ts
// fake-twilio/test/twimlInterpreter.test.ts
import { describe, expect, it } from 'vitest';
import { interpretTwiml } from '../src/engine/twimlInterpreter.js';

const MASKED = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?callerLabel=Tenant&parentCallSid=CA1" statusCallback="https://app/webhooks/twilio/voice/status" statusCallbackEvent="ringing">+15550100002</Number></Dial></Response>`;
const FOUNDER = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Dial callerId="+15550009999" record="record-from-answer-dual" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status"><Number url="https://app/webhooks/twilio/voice/whisper?leg=founder&parentCallSid=CA2">+15551230000</Number></Dial></Response>`;
const WHISPER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
const GATE_ACCEPT = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/></Response>`;
const GATE_HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

describe('interpretTwiml', () => {
  it('parses a masked Dial with a Number+whisper leg', () => {
    const plan = interpretTwiml(MASKED);
    expect(plan.kind).toBe('dial');
    if (plan.kind !== 'dial') throw new Error('x');
    expect(plan.callerId).toBe('+15550199001');
    expect(plan.record).toBe('do-not-record');
    expect(plan.actionUrl).toContain('/voice/status');
    expect(plan.recordingStatusCallback).toBeUndefined();
    expect(plan.numbers).toHaveLength(1);
    expect(plan.numbers[0]).toMatchObject({ phone: '+15550100002' });
    expect(plan.numbers[0]?.whisperUrl).toContain('/voice/whisper?');
  });
  it('parses a founder Pause+Dial with recording callback', () => {
    const plan = interpretTwiml(FOUNDER);
    if (plan.kind !== 'dial') throw new Error('x');
    expect(plan.record).toBe('record-from-answer-dual');
    expect(plan.recordingStatusCallback).toContain('/voice/recording');
    expect(plan.numbers[0]?.whisperUrl).toContain('leg=founder');
  });
  it('parses a whisper Gather', () => {
    const plan = interpretTwiml(WHISPER);
    expect(plan.kind).toBe('gather');
    if (plan.kind !== 'gather') throw new Error('x');
    expect(plan.actionUrl).toContain('/voice/whisper-gate');
    expect(plan.numDigits).toBe(1);
    expect(plan.sayContainsPress0).toBe(true);
  });
  it('classifies gate accept (Pause) vs hangup', () => {
    expect(interpretTwiml(GATE_ACCEPT).kind).toBe('pause');
    expect(interpretTwiml(GATE_HANGUP).kind).toBe('hangup');
  });
  it('parses a press-0 team Dial (no whisper) as dial', () => {
    const teamDial = `<Response><Dial callerId="+15550009999"><Number>+15550009999</Number></Dial></Response>`;
    const plan = interpretTwiml(teamDial);
    if (plan.kind !== 'dial') throw new Error('x');
    expect(plan.numbers[0]?.whisperUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it; confirm it fails** (module missing).

- [ ] **Step 3: Implement** `twimlInterpreter.ts`:

```ts
// fake-twilio/src/engine/twimlInterpreter.ts
import { XMLParser } from 'fast-xml-parser';

export interface DialNumber {
  phone: string;
  whisperUrl?: string;
  statusCallback?: string;
}
export type TwimlPlan =
  | { kind: 'dial'; callerId?: string; record?: string; actionUrl?: string; recordingStatusCallback?: string; pauseBeforeMs: number; numbers: DialNumber[] }
  | { kind: 'gather'; actionUrl?: string; numDigits: number; timeoutSec: number; sayContainsPress0: boolean }
  | { kind: 'pause'; lengthSec: number }
  | { kind: 'hangup' }
  | { kind: 'say'; text: string }
  | { kind: 'empty' };

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'Number' });

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Parse the subset of TwiML the app emits into a structured plan. Reads real
 *  attributes/URLs — no hardcoded flow. */
export function interpretTwiml(xml: string): TwimlPlan {
  const root = parser.parse(xml) as { Response?: Record<string, unknown> };
  const r = root.Response ?? {};
  if ('Dial' in r) {
    const dial = r['Dial'] as Record<string, unknown>;
    const numbers: DialNumber[] = asArray(dial['Number'] as unknown).map((n) => {
      if (typeof n === 'string') return { phone: n };
      const o = n as Record<string, unknown>;
      const phone = String(o['#text'] ?? '').trim();
      const whisperUrl = o['@_url'] !== undefined ? String(o['@_url']) : undefined;
      const statusCallback = o['@_statusCallback'] !== undefined ? String(o['@_statusCallback']) : undefined;
      return { phone, ...(whisperUrl !== undefined && { whisperUrl }), ...(statusCallback !== undefined && { statusCallback }) };
    });
    const pauseLen = 'Pause' in r ? Number((r['Pause'] as Record<string, unknown>)['@_length'] ?? 0) : 0;
    return {
      kind: 'dial',
      ...(dial['@_callerId'] !== undefined && { callerId: String(dial['@_callerId']) }),
      ...(dial['@_record'] !== undefined && { record: String(dial['@_record']) }),
      ...(dial['@_action'] !== undefined && { actionUrl: String(dial['@_action']) }),
      ...(dial['@_recordingStatusCallback'] !== undefined && { recordingStatusCallback: String(dial['@_recordingStatusCallback']) }),
      pauseBeforeMs: pauseLen * 1000,
      numbers,
    };
  }
  if ('Gather' in r) {
    const g = r['Gather'] as Record<string, unknown>;
    const say = String((g['Say'] as unknown) ?? '');
    return { kind: 'gather', ...(g['@_action'] !== undefined && { actionUrl: String(g['@_action']) }), numDigits: Number(g['@_numDigits'] ?? 1), timeoutSec: Number(g['@_timeout'] ?? 5), sayContainsPress0: /press 0/i.test(say) };
  }
  if ('Pause' in r) return { kind: 'pause', lengthSec: Number((r['Pause'] as Record<string, unknown>)['@_length'] ?? 1) };
  if ('Hangup' in r) return { kind: 'hangup' };
  if ('Say' in r) return { kind: 'say', text: String(r['Say']) };
  return { kind: 'empty' };
}
```

- [ ] **Step 4: Run the test; green.** Typecheck clean. **Commit** — `feat(fake-twilio): TwiML interpreter for the voice verb subset`.

---

## Phase 3 — Voice signer builders + dispatcher response body

### Task 3.1: Voice webhook param builders

**Files:** Modify `fake-twilio/src/engine/signer.ts`; Test `fake-twilio/test/voiceSigner.test.ts`

- [ ] **Step 1: Write the failing test** (verified against the real `twilio.validateRequest`)

```ts
// fake-twilio/test/voiceSigner.test.ts
import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { signTwilioWebhook } from '../src/engine/signer.js';
import { buildInboundVoiceParams, buildWhisperGateParams, buildDialStatusParams, buildRecordingParams, buildTranscriptionParams } from '../src/engine/signer.js';

const TOKEN = 'shared-secret-token';
function accepts(url: string, params: Record<string,string>) {
  return twilio.validateRequest(TOKEN, signTwilioWebhook({ authToken: TOKEN, url, params }), url, params);
}

describe('voice signer builders', () => {
  it('inbound voice params validate', () => {
    const p = buildInboundVoiceParams({ callSid: 'CA1', from: '+15550100001', to: '+15550199001' });
    expect(p).toMatchObject({ CallSid: 'CA1', From: '+15550100001', To: '+15550199001', CallStatus: 'ringing' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice', p)).toBe(true);
  });
  it('whisper-gate Digits validate', () => {
    const p = buildWhisperGateParams({ callSid: 'CA1', digits: '1' });
    expect(p['Digits']).toBe('1');
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/whisper-gate?leg=founder', p)).toBe(true);
  });
  it('dial-status summary params validate', () => {
    const p = buildDialStatusParams({ callSid: 'CA1', dialCallStatus: 'completed', dialCallDuration: 42 });
    expect(p).toMatchObject({ CallSid: 'CA1', DialCallStatus: 'completed', DialCallDuration: '42' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/status', p)).toBe(true);
  });
  it('recording params validate', () => {
    const p = buildRecordingParams({ callSid: 'CA1', recordingSid: 'RE1', recordingUrl: 'http://localhost:8889/recordings/CA1/RE1.mp3', durationSec: 12 });
    expect(p).toMatchObject({ CallSid: 'CA1', RecordingSid: 'RE1', RecordingStatus: 'completed' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/recording', p)).toBe(true);
  });
  it('transcription params validate', () => {
    const p = buildTranscriptionParams({ callSid: 'CA1', transcript: 'hello there' });
    expect(p).toMatchObject({ CallSid: 'CA1', TranscriptionText: 'hello there' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/transcription', p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it; fail.** **Step 3: Implement** (append to `signer.ts`):

```ts
export interface BuildInboundVoiceInput { callSid: string; from: string; to: string; callStatus?: string; }
export function buildInboundVoiceParams(i: BuildInboundVoiceInput): WebhookParams {
  return { CallSid: i.callSid, From: i.from, To: i.to, CallStatus: i.callStatus ?? 'ringing', ApiVersion: '2010-04-01' };
}
export function buildWhisperGateParams(i: { callSid: string; digits: string }): WebhookParams {
  return { CallSid: i.callSid, Digits: i.digits, ApiVersion: '2010-04-01' };
}
export function buildDialStatusParams(i: { callSid: string; dialCallStatus: string; dialCallDuration?: number }): WebhookParams {
  return { CallSid: i.callSid, DialCallStatus: i.dialCallStatus, ...(i.dialCallDuration !== undefined && { DialCallDuration: String(i.dialCallDuration) }), ApiVersion: '2010-04-01' };
}
export function buildRecordingParams(i: { callSid: string; recordingSid: string; recordingUrl: string; durationSec?: number; status?: string }): WebhookParams {
  return { CallSid: i.callSid, RecordingSid: i.recordingSid, RecordingStatus: i.status ?? 'completed', RecordingUrl: i.recordingUrl, ...(i.durationSec !== undefined && { RecordingDuration: String(i.durationSec) }), ApiVersion: '2010-04-01' };
}
export function buildTranscriptionParams(i: { callSid: string; transcript: string; status?: string }): WebhookParams {
  return { CallSid: i.callSid, TranscriptionText: i.transcript, TranscriptionStatus: i.status ?? 'completed', ApiVersion: '2010-04-01' };
}
```

- [ ] **Step 4: Green + typecheck. Commit** — `feat(fake-twilio): voice webhook param builders`.

### Task 3.2: Dispatcher — return the response body for TwiML webhooks

**Files:** Modify `fake-twilio/src/engine/dispatcher.ts`; Test `fake-twilio/test/dispatcherResponse.test.ts`

- [ ] **Step 1: Failing test** — a stub HTTP server returns a TwiML body; assert `postForResponse` returns `{status, body}` with a valid signature (reuse the existing dispatcher test's server pattern). Assert the signed inbound voice POST is accepted (validate via `twilio.validateRequest`) and the returned body is the TwiML string.
- [ ] **Step 2: Implement** — add to `WebhookDispatcher`:

```ts
  /** Like post(), but also returns the response body — for TwiML-returning voice
   *  webhooks (/voice, /voice/whisper, /voice/whisper-gate) the CallEngine must read. */
  async postForResponse(path: string, params: WebhookParams): Promise<{ status: number; body: string }> {
    const signedUrl = `${this.deps.appPublicBaseUrl}${path}`;
    const signature = signTwilioWebhook({ authToken: this.deps.authToken, url: signedUrl, params });
    const res = await fetch(`${this.deps.appBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature, 'x-origin-verify': this.deps.originSecret ?? 'dev-placeholder-not-a-secret' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.text() };
  }
```

(Keep `post()` as-is for status/recording/transcription callbacks where only the code matters; or refactor `post` to call `postForResponse().then(r=>r.status)` — DRY, but verify the existing dispatcher test stays green.)

- [ ] **Step 3: Green + typecheck. Commit** — `feat(fake-twilio): dispatcher.postForResponse for TwiML webhooks`.

---

## Phase 4 — Shared event hub + voice event variants

### Task 4.1: Extract `EventHub`; route both engines through it

**Files:** Create `fake-twilio/src/engine/eventHub.ts`; Modify `engine/engine.ts`, `routes/events.ts`, `server.ts`; Test `fake-twilio/test/eventHub.test.ts`

- [ ] **Step 1: Failing test** — `EventHub.subscribe`/`emit` delivers events to listeners; a throwing listener doesn't break emit; unsubscribe stops delivery (mirror the existing engineEvents exception-isolation test).
- [ ] **Step 2: Implement `eventHub.ts`:**

```ts
// fake-twilio/src/engine/eventHub.ts
import type { EngineEvent } from './engineEvents.js'; // move the EngineEvent union here (see Step 3)
export type EngineListener = (event: EngineEvent) => void;
export class EventHub {
  private readonly listeners = new Set<EngineListener>();
  subscribe(l: EngineListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(event: EngineEvent): void {
    for (const l of this.listeners) { try { l(event); } catch { /* a dead SSE socket must never break the engine */ } }
  }
}
```

- [ ] **Step 3:** Move the `EngineEvent` union into `engine/engineEvents.ts` and **extend it** with voice variants:

```ts
// fake-twilio/src/engine/engineEvents.ts  (existing SMS variants + new voice ones)
import type { CallState } from './voiceTypes.js';
export type EngineEvent =
  | { type: 'message.appended'; partyNumber: string; message: import('./types.js').ThreadMessage }
  | { type: 'message.updated'; partyNumber: string; message: import('./types.js').ThreadMessage }
  | { type: 'persona.added'; persona: import('./types.js').Persona }
  | { type: 'reset' }
  | { type: 'call.placed'; call: CallState }
  | { type: 'call.whisper'; call: CallState }
  | { type: 'call.answered'; call: CallState }
  | { type: 'call.completed'; call: CallState }
  | { type: 'call.recording'; call: CallState }
  | { type: 'call.transcript'; call: CallState };
```

- [ ] **Step 4:** Refactor `FakeTwilioEngine` to take an injected `EventHub` (constructor `{clock, dispatcher, hub}`) and call `this.hub.emit(...)` instead of its private `emit`; keep a `subscribe` delegating to the hub for back-compat. Update `routes/events.ts` to subscribe to the hub (pass the hub to `createEventsRouter`). Update `server.ts` to create one `EventHub` shared by both engines + the events router. Update the existing `engineEvents.test.ts` wiring to pass a hub.
- [ ] **Step 5:** Full fake suite + typecheck green (the existing SMS event tests still pass via the hub). **Commit** — `refactor(fake-twilio): shared EventHub for messaging + voice events`.

---

## Phase 5 — `CallEngine`

> The core. Build it in sub-tasks, each TDD with a `ManualClock` + a **stub dispatcher** that returns canned TwiML fixtures (the real app isn't in these unit tests). The stub records every `postForResponse`/`post` call so tests assert the exact webhook sequence + params.

### Task 5.1: Voice types + number registry

**Files:** Create `engine/voiceTypes.ts`, `engine/numberRegistry.ts`; Tests alongside.
- [ ] Define `CallScenario { answerLeg?: 'callee'|'founder'|'team'; digit?: '0'|'1'|null; ringMs?: number; record?: boolean; transcript?: string; outcome?: 'answered'|'no-answer'|'busy' }`, `CallLeg { phone; whisperUrl?; answered: boolean }`, `CallState { callSid; from; to; kind: 'masked'|'founder'|'outbound'; status: 'ringing'|'in-progress'|'completed'|'no-answer'|'busy'; digit?: string; legs: CallLeg[]; recordingSid?; recordingUrl?; transcript?; createdAt; updatedAt }`.
- [ ] `NumberRegistry`: `provision({areaCode?}) → {phoneNumber, sid}` (mint from a deterministic `+1555019xxxx` pool), `setWebhooks(number, {smsUrl?, voiceUrl?})`, `get(number)`, `list()`, `isPool(number)`. TDD: provision returns distinct numbers; isPool true after provision.
- [ ] Green + commit — `feat(fake-twilio): voice types + number registry`.

### Task 5.2: `CallEngine` — place + inbound + interpret + bridge outcome (no recording yet)

**Files:** Create `engine/callEngine.ts`; Test `fake-twilio/test/callEngine.test.ts`
- [ ] **Failing test:** with a stub dispatcher returning the MASKED `<Dial>`+whisper`<Gather>`+gate`<Pause>` fixtures in sequence keyed by path, `engine.placeCall({from, to, scenario:{answerLeg:'callee', digit:'1', outcome:'answered'}})` then `clock.flush()` results in this recorded webhook sequence: `postForResponse /webhooks/twilio/voice` → `postForResponse …/voice/whisper?…` → `postForResponse …/voice/whisper-gate (Digits=1)` → `post …/voice/status (DialCallStatus=completed)`. Assert `GET`-able call state reaches `status:'completed'`. A `{digit:null, outcome:'no-answer'}` scenario yields `DialCallStatus=no-answer` and no gate-accept. A `{digit:'0'}` masked scenario follows the gate's team `<Dial>`.
- [ ] **Implement** `CallEngine` (constructor `{clock, dispatcher, hub, registry, appNumberFor?}`):
  - `placeCall(input)` mints `CA…`, builds inbound-voice params, `dispatcher.postForResponse('/webhooks/twilio/voice', …)`, `interpretTwiml(body)`.
  - If `dial`: create legs from `plan.numbers`; for the answering leg (per scenario) with a `whisperUrl`, schedule (via `clock.schedule`, deterministic increasing delays) → `postForResponse(whisperPath, whisperParams)` → `interpretTwiml` → if `gather`, `postForResponse(gatePath, buildWhisperGateParams(digit))` → interpret gate; on `pause` (accept) mark answered; on `dial` (press-0 team) follow the team leg; on `hangup`/timeout → no-answer.
  - Emit the `<Dial action>` summary: `post(plan.actionUrl-path, buildDialStatusParams({callSid, dialCallStatus, dialCallDuration}))`. Map scenario `outcome` → `DialCallStatus`.
  - Emit `call.*` events on the hub at each transition. Track `CallState`; expose `getCalls()`.
  - **URL handling:** the TwiML carries absolute app URLs; extract the PATH (`new URL(u).pathname + search`) to pass to the dispatcher (which prepends `appBaseUrl`). Add a small `pathOf(url)` helper.
- [ ] Green + commit — `feat(fake-twilio): CallEngine place/inbound/whisper/gate/outcome`.

### Task 5.3: `CallEngine` — founder-bridge recording + transcription

**Files:** Modify `engine/callEngine.ts`; extend `callEngine.test.ts`
- [ ] **Failing test:** with the FOUNDER fixtures (`<Pause>`+`<Dial record=record-from-answer-dual recordingStatusCallback=…>`), a `{answerLeg:'founder', digit:'1', record:true, transcript:'hi'}` scenario, after the bridge `completed` the engine ALSO `post`s `/webhooks/twilio/voice/recording` (RecordingUrl ending in `.mp3`, on the fake host) then `/webhooks/twilio/voice/transcription` (TranscriptionText='hi'). A masked scenario (record=do-not-record) fires NEITHER.
- [ ] **Implement:** when `plan.record === 'record-from-answer-dual'` and `plan.recordingStatusCallback` set and the bridge answered: mint `RE…`, set `recordingUrl = ${recordingServeBase}/recordings/${callSid}/${recordingSid}.mp3` (the fake-host origin, passed in via deps so it matches `apiBaseUrl`), `post(recordingPath, buildRecordingParams(...))`; then if `scenario.transcript`, `post(transcriptionPath, buildTranscriptionParams(...))`. Honor `record='do-not-record'` (skip). Emit `call.recording`/`call.transcript`.
- [ ] Green + commit — `feat(fake-twilio): founder-bridge recording + transcription`.

### Task 5.4: `CallEngine` — scenario runner + step API + click-to-call (outbound)

**Files:** Modify `engine/callEngine.ts`; extend tests
- [ ] **Failing test:** (a) `placeCall` WITHOUT a scenario pauses after inbound; `pressDigit(callSid,'1')`/`answerLeg`/`hangup` drive it stepwise to the same outcome. (b) `originateCall({to, from, url, scenario})` (click-to-call): fetches the app TwiML at `url` via `postForResponse` and drives it through the same interpreter/lifecycle.
- [ ] **Implement** the step methods + `originateCall` (used by `Calls.json` in Phase 6). The scenario runner just calls the step methods in order on scheduled ticks.
- [ ] Green + full fake suite + typecheck. Commit — `feat(fake-twilio): CallEngine scenario runner + step API + click-to-call`.

---

## Phase 6 — REST impersonation: Calls.json + provisioning + recording-serve

### Task 6.1: Replace the 501s with real handlers + recording-serve

**Files:** Create `routes/voiceRest.ts`, `assets/canned-recording.mp3`; Modify `routes/rest.ts` (remove the 3 stubs), `server.ts`; Test `fake-twilio/test/voiceRest.test.ts`
- [ ] **Add the canned audio:** create `fake-twilio/src/assets/canned-recording.mp3` — a tiny valid MP3 (a few hundred bytes; commit it). The recording-serve route streams it as `audio/mpeg`.
- [ ] **Failing test** (supertest against `buildFakeTwilioApp` with an injected `CallEngine`/`NumberRegistry`):
  - `POST /2010-04-01/Accounts/AC/Calls.json` (form `To,From,Url`) → 201 `{ sid: 'CA…' }` and triggers `engine.originateCall`.
  - `GET …/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&SmsEnabled=true` → 200 with `available_phone_numbers: [{ phone_number, capabilities:{voice:true,sms:true} }]`.
  - `POST …/IncomingPhoneNumbers.json` (form `PhoneNumber,SmsUrl,VoiceUrl`) → 201 `{ sid:'PN…', phone_number, capabilities:{voice:true,sms:true} }` and registers it (registry.isPool true).
  - `GET /recordings/CA1/RE1.mp3` → 200 `audio/mpeg` with the canned bytes.
- [ ] **Implement** `voiceRest.ts` returning Twilio-shaped snake_case JSON (mirror the SMS `Messages.json` shape + the 400/`more_info` error convention). Mount it in `server.ts`; remove the three `501` lines from `rest.ts`.
- [ ] Green + typecheck. Commit — `feat(fake-twilio): real Calls.json + number provisioning + recording-serve`.

---

## Phase 7 — Voice control API + RCS seams + server wiring

### Task 7.1: Voice control endpoints

**Files:** Create `routes/voiceControl.ts`; Modify `server.ts`; Test `fake-twilio/test/voiceControl.test.ts`
- [ ] **Failing test:** `POST /control/place-call {from,to,scenario}` → 200 `{callSid}` and drives the engine; `GET /control/calls` → the call list with status; `POST /control/calls/:sid/press {digit}` advances a paused call. Bad input → 400 `{error}` (mirror `control.ts`).
- [ ] **Implement** `voiceControl.ts` (mirror `control.ts` error handling); mount in `server.ts`.
- [ ] Green + commit — `feat(fake-twilio): voice control API (place-call + steps + list)`.

### Task 7.2: RCS 501 seams + control stub + contract doc

**Files:** Create `routes/rcs.ts`, `docs/RCS-integration-contract.md`; Modify `server.ts`; Test `fake-twilio/test/rcs.test.ts`
- [ ] **Failing test:** any RCS-shaped REST path → 501 `{message:/rcs-not-wired/}`; `POST /control/send-rcs` → 501 `{error:/RCS not implemented/, see:/RCS-integration-contract/}`.
- [ ] **Implement** the thin seams; write `docs/RCS-integration-contract.md` (the §9 contract: app needs a Content API send path + `/webhooks/twilio/rcs` inbound + adapter methods; then the fake adds REST impersonation + builders + control + UI). Mount in `server.ts`.
- [ ] Green + commit — `feat(fake-twilio): RCS 501 seams + integration-contract doc`.

---

## Phase 8 — Integration / e2e proof + boards regression

### Task 8.1: Voice fixture + scripted flows (code; live run is the joint step)

**Files:** Create `e2e/fixtures/fakeVoice.ts`, `e2e/tests/flows/fake-voice.spec.ts`
- [ ] `fakeVoice.ts` — control-API client (`placeCall`, `getCalls`, `pressDigit`) against `process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889'`.
- [ ] `fake-voice.spec.ts` — TWO scripted proofs (code; do not run live here):
  1. **Founder-triage:** place a call from a caller to a business number with `{answerLeg:'founder',digit:'1',record:true,transcript:'…'}`; poll the app (via API/dashboard) that the call entry is answered with a stored recording (`recording_s3_key`) + saved transcript.
  2. **Masked-relay:** set up a relay thread first (provisions a pool number through the fake), then place a call to that pool number with `{answerLeg:'callee',digit:'1'}`; assert the bridge is recorded as answered (masked → no recording).
- [ ] `npm run typecheck -w @housingchoice/e2e` clean. Commit — `test(e2e): scripted voice flows (code; live run deferred)`.

### Task 8.2: Verify the boards relay-intro regression

- [ ] Reason + (at live-run time) confirm: with provisioning implemented, `e2e/tests/dashboard/boards.spec.ts` relay-intro now passes (the pool number is minted, the intro SMS fans out, the outbox records both). Note the result in the final report; if it passes, mark `docs/KNOWN_ISSUES.md` item #2 resolved.

---

## Phase 9 — Final sweep + RUNBOOK

### Task 9.1
- [ ] `npm run test -w @housingchoice/fake-twilio` + `-w app` green; all typechecks clean; `node --check scripts/e2e-session.mjs` (if touched — voice needs no new launcher wiring; the fake already serves on :8889).
- [ ] Add a "Voice (fake-twilio)" RUNBOOK subsection: the control endpoints (`/control/place-call`, `/control/calls`, step APIs), that recording media is fetched from the fake via the `TWILIO_API_BASE_URL` media-host override (dev-only), and the masked-vs-founder behavior. Note RCS is contract-only (`docs/RCS-integration-contract.md`).
- [ ] Commit — `docs(runbook): fake-twilio voice section`.

---

## Self-review notes (for the implementer)

- **Spec coverage:** SSRF dev-override (Phase 1) ✓; XML dep + interpreter (Phase 2) ✓; signer builders + dispatcher body (Phase 3) ✓; shared event bus + voice events (Phase 4) ✓; CallEngine masked/founder/whisper/gate/press-0/outcome/recording/transcription/scenario/step/click-to-call (Phase 5) ✓; real Calls.json + provisioning + recording-serve (Phase 6) ✓; control API + RCS seams + contract doc (Phase 7) ✓; integration/e2e + boards regression (Phase 8) ✓; prod-safety (Phase 1 test asserts prod stays locked to api.twilio.com; all fake routes dev-only) ✓. **Deferred:** the fake-phones voice UI (separate plan), real RCS (future).
- **Reconciliation points (verify against live code):** the exact `fast-xml-parser` parse shape for `<Number>` text+attrs (Task 2.2 — adjust the `#text`/`@_` access to the installed version's output); whether the app's whisper/gate URLs carry query strings the dispatcher must preserve (use `pathname + search`); the recording-serve route param vs the `.mp3` suffix (`getRecordingStream` appends `.mp3`, so the fake's `RecordingUrl` must already end in `.mp3` and the route must match it).
- **Type consistency:** `TwimlPlan`/`DialNumber` (interpreter) consumed by `CallEngine`; `CallState`/`CallScenario` (voiceTypes) used by engine + control + events; `WebhookParams` (signer) shared by all builders + dispatcher; `EngineEvent` union (engineEvents.ts) extended with `call.*` and emitted via the shared `EventHub`.
- **The one app change is the only production-code touch** and is gated on `apiBaseUrl` (set only when the prod-rejected `TWILIO_API_BASE_URL` is configured); a test asserts prod stays locked.
```
