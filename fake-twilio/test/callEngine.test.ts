import { describe, expect, it } from 'vitest';
import { CallEngine } from '../src/engine/callEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';
import type { WebhookParams } from '../src/engine/signer.js';
import type { EngineEvent } from '../src/engine/engineEvents.js';

// --- TwiML fixtures (shapes reused from twimlInterpreter.test.ts) ---
const MASKED_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?callerLabel=Tenant&leg=callee" statusCallback="https://app/webhooks/twilio/voice/status">+15550199001</Number></Dial></Response>`;
const WHISPER_GATHER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate?leg=callee" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
const GATE_ACCEPT = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/></Response>`;
const GATE_HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
const GATE_TEAM_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550009999" action="https://app/webhooks/twilio/voice/status"><Number>+15550009999</Number></Dial></Response>`;

interface Recorded { method: 'postForResponse' | 'post'; path: string; params: WebhookParams }

function makeStubDispatcher(gateBodyFor: (digit: string) => string) {
  const calls: Recorded[] = [];
  const reply = (path: string): string => {
    if (path.startsWith('/webhooks/twilio/voice/whisper-gate')) return gateBodyFor(path);
    if (path.startsWith('/webhooks/twilio/voice/whisper')) return WHISPER_GATHER;
    if (path.startsWith('/webhooks/twilio/voice/status')) return '';
    if (path === '/webhooks/twilio/voice') return MASKED_DIAL;
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

function makeEngine(gateBodyFor: (digit: string) => string) {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const { dispatcher, calls } = makeStubDispatcher(gateBodyFor);
  const registry = new NumberRegistry();
  // Provision so the seeded pool number used as `to` routes as masked.
  registry.provision(); // mints +15550190001
  const hub = new EventHub();
  const events: EngineEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const engine = new CallEngine({ clock, dispatcher, hub, registry });
  return { engine, clock, calls, events, registry };
}

describe('CallEngine', () => {
  it('masked answered: place -> whisper -> gate(Digits=1) -> status completed', async () => {
    const { engine, clock, calls } = makeEngine(() => GATE_ACCEPT);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15550190001',
      scenario: { answerLeg: 'callee', digit: '1', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();

    const seq = calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(seq).toEqual([
      'postForResponse /webhooks/twilio/voice',
      'postForResponse /webhooks/twilio/voice/whisper',
      'postForResponse /webhooks/twilio/voice/whisper-gate',
      'post /webhooks/twilio/voice/status',
    ]);
    const gate = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/whisper-gate'));
    expect(gate?.params['Digits']).toBe('1');
    const status = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/status'));
    expect(status?.params['DialCallStatus']).toBe('completed');

    const call = engine.getCalls()[0];
    expect(call?.kind).toBe('masked');
    expect(call?.status).toBe('completed');
  });

  it('no-answer: gather times out (no press) -> status no-answer, no Digits=1', async () => {
    const { engine, clock, calls } = makeEngine(() => GATE_HANGUP);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15550190001',
      scenario: { digit: null, outcome: 'no-answer' },
    });
    clock.flush();
    await engine.settle();

    const status = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/status'));
    expect(status?.params['DialCallStatus']).toBe('no-answer');
    // No gate-accept: never injected Digits=1.
    const acceptedGate = calls.find(
      (c) => c.path.startsWith('/webhooks/twilio/voice/whisper-gate') && c.params['Digits'] === '1',
    );
    expect(acceptedGate).toBeUndefined();
    expect(engine.getCalls()[0]?.status).toBe('no-answer');
  });

  it('press-0 (masked): gate(Digits=0) -> team Dial followed -> terminal status', async () => {
    const { engine, clock, calls } = makeEngine(() => GATE_TEAM_DIAL);
    // Snapshot the call.status at the instant call.answered is emitted, so we can
    // assert the team-escape path transitions to 'in-progress' (not stale 'ringing')
    // before the event fires — mirroring the normal markAnswered accept path.
    let statusAtAnswered: string | undefined;
    engine.hub.subscribe((e) => {
      if (e.type === 'call.answered' && statusAtAnswered === undefined) {
        statusAtAnswered = e.call.status;
      }
    });
    await engine.placeCall({
      from: '+15550100001',
      to: '+15550190001',
      scenario: { answerLeg: 'team', digit: '0' },
    });
    clock.flush();
    await engine.settle();

    const gate = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/whisper-gate'));
    expect(gate?.params['Digits']).toBe('0');
    // The call.answered event for the team escape carried a consistent status.
    expect(statusAtAnswered).toBe('in-progress');
    // A terminal status was posted.
    const status = calls.find((c) => c.path.startsWith('/webhooks/twilio/voice/status'));
    expect(status).toBeDefined();
    // The team leg was followed (a leg for the team number exists).
    const call = engine.getCalls()[0];
    expect(call?.legs.some((l) => l.phone === '+15550009999')).toBe(true);
    expect(['completed', 'no-answer', 'busy', 'in-progress']).toContain(call?.status);
  });

  it('routes to founder kind when `to` is not a pool number', async () => {
    const { engine, clock } = makeEngine(() => GATE_ACCEPT);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15551230000',
      scenario: { answerLeg: 'callee', digit: '1', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();
    expect(engine.getCalls()[0]?.kind).toBe('founder');
  });

  it('emits call.placed and call.completed through the hub', async () => {
    const { engine, clock, events } = makeEngine(() => GATE_ACCEPT);
    await engine.placeCall({
      from: '+15550100001',
      to: '+15550190001',
      scenario: { answerLeg: 'callee', digit: '1', outcome: 'answered' },
    });
    clock.flush();
    await engine.settle();
    const types = events.map((e) => e.type);
    expect(types).toContain('call.placed');
    expect(types).toContain('call.completed');
  });
});
