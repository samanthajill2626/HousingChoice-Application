// fake-twilio/test/engine.test.ts
import { describe, expect, it } from 'vitest';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import type { WebhookParams } from '../src/engine/signer.js';

function makeEngine() {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const dispatcher = { post: async (path: string, params: WebhookParams) => { posted.push({ path, params }); return 200; } };
  const engine = new FakeTwilioEngine({ clock, dispatcher, hub: new EventHub() });
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
    // FIX 4: the 'queued' state has no status callback (real Twilio starts at 'sent').
    expect(statuses).toEqual(['sent', 'undelivered']);
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
