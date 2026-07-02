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

  it('recordOutboundFromApp AUTO-REGISTERS a persona for an unknown recipient (pops up in the UI)', () => {
    const { engine } = makeEngine();
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.type));
    engine.recordOutboundFromApp({ to: '+14045550137', from: '+15550009999', body: 'Your code is 123456' });
    // The persona materializes: labeled by the BARE NUMBER (no invented name),
    // role 'unknown', ad-hoc — so the send is visible + usable (read the code, reply).
    const persona = engine.list().find((p) => p.number === '+14045550137');
    expect(persona).toMatchObject({ label: '+14045550137', role: 'unknown', adHoc: true });
    // persona.added must reach the UI BEFORE the message lands on its thread.
    expect(events.indexOf('persona.added')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('persona.added')).toBeLessThan(events.indexOf('message.appended'));
    const thread = engine.listThreads().find((t) => t.partyNumber === '+14045550137');
    expect(thread?.messages[0]).toMatchObject({ direction: 'outbound', body: 'Your code is 123456' });
  });

  it('recordOutboundFromApp does NOT duplicate a persona for a known recipient', () => {
    const { engine } = makeEngine();
    const before = engine.list().length;
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'hi' }); // seeded Tasha
    expect(engine.list().length).toBe(before);
  });

  it('recordOutboundFromApp to a malformed number records the send without registering', () => {
    const { engine } = makeEngine();
    const before = engine.list().length;
    const sid = engine.recordOutboundFromApp({ to: 'not-a-number', from: '+15550009999', body: 'hi' });
    expect(sid).toMatch(/^SM/); // the send itself still succeeds (old behavior preserved)
    expect(engine.list().length).toBe(before);
  });

  it('a fresh engine starts SIDs above the low range, so a restarted fake cannot reuse a prior run\'s SIDs', async () => {
    // The dedup bug: fake-twilio used to mint SMfake00000001… from 0 on every process
    // start, so a restart re-emitted SIDs already persisted as sid# dedup pointers in a
    // reused DB → the inbound was dropped. A fresh engine must start its counter high so
    // a restart lands in a different range than any prior run's low SIDs.
    const { engine } = makeEngine();
    const sid = await engine.sendAsParty({ from: '+15550100001', body: 'x' });
    const n = Number(sid.replace(/^SMfake/, ''));
    expect(n).toBeGreaterThanOrEqual(10_000_000);
  });

  it('sidSeqStart pins the counter for deterministic, reproducible SIDs', async () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const dispatcher = { post: async () => 200 };
    const engine = new FakeTwilioEngine({ clock, dispatcher, hub: new EventHub(), sidSeqStart: 42 });
    const sid = await engine.sendAsParty({ from: '+15550100001', body: 'x' });
    expect(sid).toBe('SMfake00000043');
  });
});
