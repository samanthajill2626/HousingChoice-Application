// Task 13: the missed-branch voicemail flow.
//
// When a missed INBOUND founder-bridge call's <Dial action> summary POST returns the
// app's voicemail TwiML (Say+Record+Say+Hangup), the engine follows the <Record>: it
// "records" for the scenario duration, POSTs the completed recording callback (which the
// app classifies as a voicemail), registers the recording for VI (single-channel), then
// POSTs the Record action (/voicemail-done) and ends the call 'completed'. scenario
// voicemail:false hangs up at the beep (no recording). Masked missed calls get no
// <Record> from the app (goodbye say/hangup), so the engine records nothing - the
// standing masked never-record invariant is preserved.
import { describe, expect, it } from 'vitest';
import { CallEngine } from '../src/engine/callEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';
import type { WebhookParams } from '../src/engine/signer.js';
import type { EngineEvent } from '../src/engine/engineEvents.js';

const FOUNDER_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Dial callerId="+15550199001" record="record-from-answer-dual" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status"><Number url="https://app/webhooks/twilio/voice/whisper?leg=founder">+15551230000</Number></Dial></Response>`;
const MASKED_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?callerLabel=Tenant&leg=callee" statusCallback="https://app/webhooks/twilio/voice/status">+15550199001</Number></Dial></Response>`;
const WHISPER_GATHER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate?leg=founder" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
// The EXACT missed inbound founder-bridge /status TwiML (slice 3 report): self-closing
// <Record/> wrapped by Say(prompt) + Say(thanks) + Hangup.
const VOICEMAIL_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry we missed your call. Please leave a message after the tone.</Say><Record maxLength="120" playBeep="true" action="https://app/webhooks/twilio/voice/voicemail-done" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" recordingStatusCallbackEvent="completed"/><Say>Thank you.</Say><Hangup/></Response>`;
// Masked/outbound missed keep the goodbye (no <Record>).
const GOODBYE_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry we missed your call. Please text us. Goodbye.</Say><Hangup/></Response>`;

const RECORDING_BASE = 'http://recording-host:9999';

interface Recorded {
  method: 'postForResponse' | 'post' | 'postJson';
  path: string;
  params?: WebhookParams;
  body?: Record<string, unknown>;
}

/** A stub whose /status action returns `statusNoAnswerBody` for a missed (no-answer)
 *  Dial summary and empty TwiML for a completed one - mirroring the app's /status branch. */
function makeStubDispatcher(inboundBody: string, statusNoAnswerBody: string) {
  const calls: Recorded[] = [];
  const reply = (path: string): string => {
    if (path.startsWith('/webhooks/twilio/voice/whisper-gate')) return '';
    if (path.startsWith('/webhooks/twilio/voice/whisper')) return WHISPER_GATHER;
    if (path === '/webhooks/twilio/voice') return inboundBody;
    return '';
  };
  const dispatcher = {
    async postForResponse(path: string, params: WebhookParams) {
      calls.push({ method: 'postForResponse', path, params });
      if (path.startsWith('/webhooks/twilio/voice/status')) {
        return { status: 200, body: params['DialCallStatus'] === 'no-answer' ? statusNoAnswerBody : '' };
      }
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

function makeEngine(inboundBody: string, statusNoAnswerBody: string) {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const { dispatcher, calls } = makeStubDispatcher(inboundBody, statusNoAnswerBody);
  const registry = new NumberRegistry();
  registry.provision(); // mints +15550190001 (masked `to`)
  const hub = new EventHub();
  const events: EngineEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const engine = new CallEngine({ clock, dispatcher, hub, registry, recordingServeBase: RECORDING_BASE });
  return { engine, clock, calls, events };
}

describe('CallEngine missed-branch voicemail (Task 13)', () => {
  it('a missed founder-bridge whose Dial-action offers <Record> leaves a voicemail (duration, single-channel VI)', async () => {
    const { engine, clock, calls, events } = makeEngine(FOUNDER_DIAL, VOICEMAIL_TWIML);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000', // not a pool number -> founder
      scenario: { digit: null, transcript: 'Please call me back. Thanks so much.' },
    });
    clock.flush();
    await engine.settle();

    // The Dial-action status POST was a missed one, and the recording callback fired.
    const rec = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/recording'));
    expect(rec).toBeDefined();
    expect(rec?.params?.['RecordingDuration']).toBe('6');
    expect(rec?.params?.['RecordingUrl']?.endsWith('.mp3')).toBe(true);
    // The Record action (/voicemail-done) closed the call.
    expect(calls.some((c) => c.path.startsWith('/webhooks/twilio/voice/voicemail-done'))).toBe(true);

    const call = engine.getCalls()[0]!;
    expect(call.recordingSid).toBeDefined();
    expect(call.status).toBe('completed');
    expect(events.map((e) => e.type)).toContain('call.recording');

    // The voicemail recording is single-channel: every sentence stays on channel 1.
    const created = engine.createViTranscript({ serviceSid: 'GAfakeservice', customerKey: call.callSid, sourceSid: call.recordingSid! });
    const channels = created.sentences.map((s) => s.mediaChannel);
    expect(channels.length).toBeGreaterThan(1);
    expect(channels.every((c) => c === 1)).toBe(true);
  });

  it('scenario.voicemail:false hangs up at the beep - no recording callback, call stays no-answer', async () => {
    const { engine, clock, calls } = makeEngine(FOUNDER_DIAL, VOICEMAIL_TWIML);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000',
      scenario: { digit: null, transcript: 'ignored', voicemail: false },
    });
    clock.flush();
    await engine.settle();

    expect(calls.some((c) => c.path.startsWith('/webhooks/twilio/voice/recording'))).toBe(false);
    expect(calls.some((c) => c.path.startsWith('/webhooks/twilio/voice/voicemail-done'))).toBe(false);
    const call = engine.getCalls()[0]!;
    expect(call.recordingSid).toBeUndefined();
    expect(call.status).toBe('no-answer');
  });

  it('a masked missed call gets no voicemail (app returns say/hangup - engine records nothing)', async () => {
    const { engine, clock, calls } = makeEngine(MASKED_DIAL, GOODBYE_TWIML);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15550190001', // pool number -> masked
      scenario: { digit: null, transcript: 'should never record' },
    });
    clock.flush();
    await engine.settle();

    expect(calls.some((c) => c.path.startsWith('/webhooks/twilio/voice/recording'))).toBe(false);
    expect(calls.some((c) => c.path.startsWith('/webhooks/twilio/voice/voicemail-done'))).toBe(false);
    expect(calls.some((c) => c.method === 'postJson')).toBe(false);
    const call = engine.getCalls()[0]!;
    expect(call.recordingSid).toBeUndefined();
    expect(call.status).toBe('no-answer');
  });
});
