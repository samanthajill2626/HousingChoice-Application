// Task 5.3: founder-bridge recording + transcription.
//
// Pins that after a founder bridge reaches `completed`, the engine ALSO posts the
// recording callback (RecordingUrl ending in `.mp3`) then the transcription, in
// that order AFTER the <Dial action> /voice/status post — and that masked calls
// (record="do-not-record", no recordingStatusCallback) fire NEITHER.
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

interface Recorded { method: 'postForResponse' | 'post'; path: string; params: WebhookParams }

const RECORDING_BASE = 'http://recording-host:9999';

function makeStubDispatcher(inboundBody: string) {
  const calls: Recorded[] = [];
  const reply = (path: string): string => {
    if (path.startsWith('/webhooks/twilio/voice/whisper-gate')) return GATE_ACCEPT;
    if (path.startsWith('/webhooks/twilio/voice/whisper')) return WHISPER_GATHER;
    if (path.startsWith('/webhooks/twilio/voice/status')) return '';
    if (path.startsWith('/webhooks/twilio/voice/recording')) return '';
    if (path.startsWith('/webhooks/twilio/voice/transcription')) return '';
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

describe('CallEngine recording + transcription (Task 5.3)', () => {
  it('founder bridge: records (.mp3) then transcribes, in order after /voice/status', async () => {
    const { engine, clock, calls, events } = makeEngine(FOUNDER_DIAL);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000', // not a pool number → founder
      scenario: { answerLeg: 'founder', digit: '1', record: true, transcript: 'hi', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    const seq = calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    // The recording + transcription posts come AFTER the <Dial action> /voice/status post.
    const statusIdx = seq.indexOf('post /webhooks/twilio/voice/status');
    const recIdx = seq.indexOf('post /webhooks/twilio/voice/recording');
    const txIdx = seq.indexOf('post /webhooks/twilio/voice/transcription');
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(recIdx).toBeGreaterThan(statusIdx);
    expect(txIdx).toBeGreaterThan(recIdx);

    // RecordingUrl ends in `.mp3` and points at the fake recording host.
    const rec = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/recording'));
    expect(rec?.params['RecordingUrl']).toBeDefined();
    expect(rec?.params['RecordingUrl']?.endsWith('.mp3')).toBe(true);
    expect(rec?.params['RecordingUrl']?.startsWith(RECORDING_BASE)).toBe(true);
    expect(rec?.params['RecordingSid']?.startsWith('RE')).toBe(true);

    const tx = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/transcription'));
    expect(tx?.params['TranscriptionText']).toBe('hi');

    const call = engine.getCalls()[0];
    expect(call?.recordingSid).toBeDefined();
    expect(call?.recordingUrl?.endsWith('.mp3')).toBe(true);
    expect(call?.transcript).toBe('hi');

    const types = events.map((e) => e.type);
    expect(types).toContain('call.recording');
    expect(types).toContain('call.transcript');
  });

  it('masked bridge: fires NEITHER recording nor transcription', async () => {
    const { engine, clock, calls } = makeEngine(MASKED_DIAL);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15550190001', // pool number → masked
      scenario: { answerLeg: 'callee', digit: '1', record: true, transcript: 'hi', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    const paths = calls.map((c) => c.path);
    expect(paths.some((p) => p.startsWith('/webhooks/twilio/voice/recording'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/webhooks/twilio/voice/transcription'))).toBe(false);
    const call = engine.getCalls()[0];
    expect(call?.recordingSid).toBeUndefined();
    expect(call?.transcript).toBeUndefined();
  });

  it('founder record:true but transcript omitted: records, does NOT transcribe', async () => {
    const { engine, clock, calls } = makeEngine(FOUNDER_DIAL);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000',
      scenario: { answerLeg: 'founder', digit: '1', record: true, outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    const paths = calls.map((c) => c.path);
    expect(paths.some((p) => p.startsWith('/webhooks/twilio/voice/recording'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/webhooks/twilio/voice/transcription'))).toBe(false);
    const call = engine.getCalls()[0];
    expect(call?.recordingSid).toBeDefined();
    expect(call?.transcript).toBeUndefined();
  });
});
