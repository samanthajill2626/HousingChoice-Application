// Task 5.3 (recording) + Task 12 (Voice Intelligence model).
//
// Pins that after a founder bridge reaches `completed`, the engine posts the
// recording callback (RecordingUrl ending in `.mp3`) AFTER the <Dial action>
// /voice/status post, and registers a pending VI entry keyed on the RecordingSid.
// A subsequent VI create (POST /v2/Transcripts, modelled here by calling the
// engine's createViTranscript directly the way the REST route does) mints a
// GTfake transcript, sets call.viTranscriptSid, emits call.transcript, and - when
// scenario.viWebhook is 'deliver' (default) - fires the signed JSON completion
// webhook to /webhooks/twilio/voice/intelligence. 'drop' registers the transcript
// but posts no webhook (exercises the app's reconcile leg). Masked calls
// (record="do-not-record", no recordingStatusCallback) fire NEITHER a recording
// NOR any VI. The legacy text-in-body /voice/transcription flow is GONE.
import { describe, expect, it } from 'vitest';
import { CallEngine } from '../src/engine/callEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';
import type { WebhookParams } from '../src/engine/signer.js';
import type { EngineEvent } from '../src/engine/engineEvents.js';

// --- Founder TwiML fixtures (per Task 5.3 spec) ---
const FOUNDER_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Dial callerId="+15550199001" record="record-from-answer-dual" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status"><Number url="https://app/webhooks/twilio/voice/whisper?leg=founder">+15551230000</Number></Dial></Response>`;
const WHISPER_GATHER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate?leg=founder" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
const GATE_ACCEPT = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/></Response>`;

// Masked fixture (no recording): record="do-not-record", no recordingStatusCallback.
const MASKED_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?callerLabel=Tenant&leg=callee" statusCallback="https://app/webhooks/twilio/voice/status">+15550199001</Number></Dial></Response>`;

interface Recorded {
  method: 'postForResponse' | 'post' | 'postJson';
  path: string;
  params?: WebhookParams;
  body?: Record<string, unknown>;
}

const RECORDING_BASE = 'http://recording-host:9999';
const VI_SERVICE = 'GAfakeservice';

function makeStubDispatcher(inboundBody: string) {
  const calls: Recorded[] = [];
  const reply = (path: string): string => {
    if (path.startsWith('/webhooks/twilio/voice/whisper-gate')) return GATE_ACCEPT;
    if (path.startsWith('/webhooks/twilio/voice/whisper')) return WHISPER_GATHER;
    if (path.startsWith('/webhooks/twilio/voice/status')) return '';
    if (path.startsWith('/webhooks/twilio/voice/recording')) return '';
    if (path === '/webhooks/twilio/voice') return inboundBody;
    return '';
  };
  const dispatcher = {
    async postForResponse(path: string, params: WebhookParams) {
      calls.push({ method: 'postForResponse', path, params });
      return { status: 200, body: reply(path) };
    },
    async post(path: string, params: WebhookParams) {
      calls.push({ method: 'post', path, params });
      return 200;
    },
    async postJson(path: string, body: Record<string, unknown>) {
      calls.push({ method: 'postJson', path, body });
      return 200;
    },
  };
  return { dispatcher, calls };
}

function makeEngine(inboundBody: string) {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const { dispatcher, calls } = makeStubDispatcher(inboundBody);
  const registry = new NumberRegistry();
  registry.provision(); // mints +15550190001 (used as masked `to`)
  const hub = new EventHub();
  const events: EngineEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const engine = new CallEngine({ clock, dispatcher, hub, registry, recordingServeBase: RECORDING_BASE });
  return { engine, clock, calls, events, registry };
}

/** Simulate the app's inline VI create (POST /v2/Transcripts) the way the REST
 *  route delegates: pass the recording's source_sid + the callSid as CustomerKey. */
function driveViCreate(engine: CallEngine, clock: ManualClock, callSid: string, recordingSid: string) {
  const record = engine.createViTranscript({ serviceSid: VI_SERVICE, customerKey: callSid, sourceSid: recordingSid });
  clock.flush();
  return record;
}

describe('CallEngine recording + Voice Intelligence (Task 5.3 + Task 12)', () => {
  it('founder bridge: records (.mp3) after /voice/status; a VI create fires the signed JSON webhook (deliver)', async () => {
    const { engine, clock, calls, events } = makeEngine(FOUNDER_DIAL);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000', // not a pool number -> founder
      scenario: { answerLeg: 'founder', digit: '1', record: true, transcript: 'hi', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    const seq = calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    const statusIdx = seq.indexOf('post /webhooks/twilio/voice/status');
    const recIdx = seq.indexOf('post /webhooks/twilio/voice/recording');
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(recIdx).toBeGreaterThan(statusIdx);
    // The legacy text-in-body transcription callback is GONE.
    expect(seq.some((s) => s.includes('/webhooks/twilio/voice/transcription'))).toBe(false);

    const rec = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/recording'));
    expect(rec?.params?.['RecordingUrl']?.endsWith('.mp3')).toBe(true);
    expect(rec?.params?.['RecordingUrl']?.startsWith(RECORDING_BASE)).toBe(true);
    const recordingSid = rec?.params?.['RecordingSid'];
    expect(recordingSid?.startsWith('RE')).toBe(true);

    const call = engine.getCalls()[0]!;
    // The app drives VI create in the recording callback; model that here.
    const created = driveViCreate(engine, clock, call.callSid, recordingSid!);
    await engine.settle();

    expect(created?.sid.startsWith('GTfake')).toBe(true);
    expect(call.viTranscriptSid).toBe(created?.sid);
    expect(call.transcript).toBe('hi');

    // The signed JSON completion webhook fired to /webhooks/twilio/voice/intelligence.
    const hook = calls.find((c) => c.method === 'postJson' && c.path.startsWith('/webhooks/twilio/voice/intelligence'));
    expect(hook).toBeDefined();
    expect(hook?.body?.['transcript_sid']).toBe(created?.sid);
    expect(hook?.body?.['customer_key']).toBe(call.callSid);

    expect(events.map((e) => e.type)).toContain('call.recording');
    expect(events.map((e) => e.type)).toContain('call.transcript');
  });

  it('viWebhook drop: the VI create registers the transcript but posts NO webhook', async () => {
    const { engine, clock, calls } = makeEngine(FOUNDER_DIAL);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000',
      scenario: { answerLeg: 'founder', digit: '1', record: true, transcript: 'hi', outcome: 'answered', viWebhook: 'drop' },
    });
    clock.flush();
    await engine.settle();

    const call = engine.getCalls()[0]!;
    const recordingSid = call.recordingSid!;
    const created = driveViCreate(engine, clock, call.callSid, recordingSid);
    await engine.settle();

    expect(created?.sid.startsWith('GTfake')).toBe(true);
    expect(call.viTranscriptSid).toBe(created?.sid);
    // Reconcile leg: no completion webhook was delivered.
    expect(calls.some((c) => c.method === 'postJson')).toBe(false);
  });

  it('masked bridge: fires NEITHER a recording NOR any VI', async () => {
    const { engine, clock, calls } = makeEngine(MASKED_DIAL);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15550190001', // pool number -> masked
      scenario: { answerLeg: 'callee', digit: '1', record: true, transcript: 'hi', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    const paths = calls.map((c) => c.path);
    expect(paths.some((p) => p.startsWith('/webhooks/twilio/voice/recording'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/webhooks/twilio/voice/transcription'))).toBe(false);
    expect(calls.some((c) => c.method === 'postJson')).toBe(false);
    const call = engine.getCalls()[0]!;
    expect(call.recordingSid).toBeUndefined();
    expect(call.viTranscriptSid).toBeUndefined();
    expect(call.transcript).toBeUndefined();
  });

  it('founder bridge with no scenario.transcript: records; the VI create yields an empty transcript', async () => {
    const { engine, clock, calls } = makeEngine(FOUNDER_DIAL);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000',
      scenario: { answerLeg: 'founder', digit: '1', record: true, outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    const call = engine.getCalls()[0]!;
    expect(call.recordingSid).toBeDefined();
    // No engine-driven transcription happens until the app calls VI create.
    expect(calls.some((c) => c.method === 'postJson')).toBe(false);

    const created = driveViCreate(engine, clock, call.callSid, call.recordingSid!);
    await engine.settle();
    expect(created?.sid.startsWith('GTfake')).toBe(true);
    expect(created?.sentences.length).toBe(0);
  });
});
