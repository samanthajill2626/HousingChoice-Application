// Task 5.4: scenario runner + step API + click-to-call (outbound origination).
//
// 1. Step API: placeCall WITHOUT a scenario pauses after the inbound TwiML is
//    interpreted (legs created, no auto-run). Explicit step calls
//    (pressDigit/answerLeg/hangup) drive it to the SAME terminal state + webhook
//    sequence the equivalent scenario auto-run produces.
// 2. originateCall: click-to-call outbound — fetches the app TwiML at `url` via
//    POST (CallSid/From/To/CallStatus), then drives the SAME lifecycle. Generic:
//    whatever TwiML the url returns is interpreted (not hardcoded).
import { describe, expect, it } from 'vitest';
import { CallEngine } from '../src/engine/callEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';
import type { WebhookParams } from '../src/engine/signer.js';
import type { EngineEvent } from '../src/engine/engineEvents.js';

const MASKED_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?callerLabel=Tenant&leg=callee" statusCallback="https://app/webhooks/twilio/voice/status">+15550199001</Number></Dial></Response>`;
const WHISPER_GATHER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate?leg=callee" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
const GATE_ACCEPT = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/></Response>`;
// Outbound click-to-call TwiML returned for an arbitrary app url path.
const OUTBOUND_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?leg=callee">+15550555000</Number></Dial></Response>`;

interface Recorded { method: 'postForResponse' | 'post'; path: string; params: WebhookParams }

function makeStubDispatcher(opts: { inboundBody?: string; outboundUrlPath?: string; outboundBody?: string } = {}) {
  const calls: Recorded[] = [];
  const reply = (path: string): string => {
    if (path.startsWith('/webhooks/twilio/voice/whisper-gate')) return GATE_ACCEPT;
    if (path.startsWith('/webhooks/twilio/voice/whisper')) return WHISPER_GATHER;
    if (path.startsWith('/webhooks/twilio/voice/status')) return '';
    if (opts.outboundUrlPath !== undefined && path.startsWith(opts.outboundUrlPath)) {
      return opts.outboundBody ?? OUTBOUND_DIAL;
    }
    if (path === '/webhooks/twilio/voice') return opts.inboundBody ?? MASKED_DIAL;
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
    async postJson(_path: string, _body: Record<string, unknown>) {
      return 200;
    },
  };
  return { dispatcher, calls };
}

function makeEngine(opts: Parameters<typeof makeStubDispatcher>[0] = {}) {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const { dispatcher, calls } = makeStubDispatcher(opts);
  const registry = new NumberRegistry();
  registry.provision(); // mints +15550190001
  const hub = new EventHub();
  const events: EngineEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const engine = new CallEngine({ clock, dispatcher, hub, registry });
  return { engine, clock, calls, events, registry };
}

const seqOf = (calls: Recorded[]): string[] => calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);

describe('CallEngine step API (Task 5.4)', () => {
  it('placeCall WITHOUT a scenario pauses after inbound interpret (legs, no auto-run)', async () => {
    const { engine, clock, calls } = makeEngine();
    const call = await engine.placeCall({ from: '+15550100001', to: '+15550190001' });
    // After flushing the clock, with no scenario nothing auto-runs.
    clock.flush();
    await engine.settle();

    // Inbound was fetched + interpreted; the dialed leg exists.
    expect(seqOf(calls)).toEqual(['postForResponse /webhooks/twilio/voice']);
    const stored = engine.getCall(call.callSid);
    expect(stored?.legs.some((l) => l.phone === '+15550199001')).toBe(true);
    // Still ringing (paused), not terminal.
    expect(stored?.status).toBe('ringing');
  });

  it('manual steps drive to the SAME terminal state + webhook sequence as the auto-run', async () => {
    // Auto-run reference.
    const auto = makeEngine();
    await auto.engine.placeCall({
      from: '+15550100001',
      to: '+15550190001',
      scenario: { answerLeg: 'callee', digit: '1', outcome: 'answered' },
    });
    auto.clock.flush();
    await auto.engine.settle();
    const autoSeq = seqOf(auto.calls);
    const autoStatus = auto.engine.getCalls()[0]?.status;

    // Manual: no scenario, then explicit steps.
    const manual = makeEngine();
    const call = await manual.engine.placeCall({ from: '+15550100001', to: '+15550190001' });
    await manual.engine.pressDigit(call.callSid, '1');
    await manual.engine.settle();

    expect(seqOf(manual.calls)).toEqual(autoSeq);
    expect(manual.engine.getCall(call.callSid)?.status).toBe(autoStatus);
    expect(autoStatus).toBe('completed');
  });

  it('hangup before press → no-answer terminal', async () => {
    const { engine, calls } = makeEngine();
    const call = await engine.placeCall({ from: '+15550100001', to: '+15550190001' });
    await engine.hangup(call.callSid);
    await engine.settle();
    const status = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/status'));
    expect(status?.params['DialCallStatus']).toBe('no-answer');
    expect(engine.getCall(call.callSid)?.status).toBe('no-answer');
  });
});

describe('CallEngine click-to-call originateCall (Task 5.4)', () => {
  it('originates an outbound call: fetches app TwiML at url via POST, runs the chain', async () => {
    const { engine, clock, calls, events } = makeEngine({
      outboundUrlPath: '/api/voice/click-to-call',
    });
    const call = await engine.originateCall({
      to: '+15550555000',
      from: '+15550199001',
      url: 'https://app/api/voice/click-to-call?listingId=abc',
      scenario: { answerLeg: 'callee', digit: '1', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    // Minted a CA… sid, kind outbound.
    expect(call.callSid.startsWith('CA')).toBe(true);
    expect(call.kind).toBe('outbound');

    // The FIRST webhook is a POST-for-response to the url's PATH carrying inbound params.
    const first = calls[0];
    expect(first?.method).toBe('postForResponse');
    expect(first?.path.startsWith('/api/voice/click-to-call')).toBe(true);
    expect(first?.params['CallSid']).toBe(call.callSid);
    expect(first?.params['From']).toBe('+15550199001');
    expect(first?.params['To']).toBe('+15550555000');
    expect(first?.params['CallStatus']).toBeDefined();

    // It ran the SAME interpret→whisper→gate→status lifecycle to a terminal state.
    const seq = seqOf(calls);
    expect(seq).toContain('postForResponse /webhooks/twilio/voice/whisper');
    expect(seq).toContain('postForResponse /webhooks/twilio/voice/whisper-gate');
    expect(seq).toContain('post /webhooks/twilio/voice/status');
    expect(engine.getCall(call.callSid)?.status).toBe('completed');
    expect(events.map((e) => e.type)).toContain('call.placed');
    expect(events.map((e) => e.type)).toContain('call.completed');
  });

  it('originateCall is generic: a Hangup TwiML yields a non-dial terminal call', async () => {
    const HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    const { engine, clock } = makeEngine({
      outboundUrlPath: '/api/voice/click-to-call',
      outboundBody: HANGUP,
    });
    const call = await engine.originateCall({
      to: '+15550555000',
      from: '+15550199001',
      url: 'https://app/api/voice/click-to-call',
    });
    clock.flush();
    await engine.settle();
    expect(engine.getCall(call.callSid)?.status).toBe('completed');
  });
});
