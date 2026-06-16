// fake-twilio/test/engineEvents.test.ts
import { describe, expect, it } from 'vitest';
import { FakeTwilioEngine, type EngineEvent } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';

function makeEngine() {
  const events: EngineEvent[] = [];
  const engine = new FakeTwilioEngine({
    clock: new ManualClock('2026-06-15T00:00:00.000Z'),
    dispatcher: { post: async () => 200 },
  });
  const unsub = engine.subscribe((e) => events.push(e));
  return { engine, events, unsub };
}

describe('engine events', () => {
  it('emits message.appended for an inbound send-as-party', async () => {
    const { engine, events } = makeEngine();
    await engine.sendAsParty({ from: '+15550100001', body: 'hi' });
    const ev = events.find((e) => e.type === 'message.appended');
    expect(ev).toMatchObject({ type: 'message.appended', partyNumber: '+15550100001' });
    if (ev?.type === 'message.appended') expect(ev.message.direction).toBe('inbound');
  });

  it('emits message.appended then message.updated for an outbound + status progression', () => {
    const { engine, events } = makeEngine();
    const clock = (engine as unknown as { clock: ManualClock }).clock;
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'yo' });
    clock.flush();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message.appended');
    expect(types).toContain('message.updated');
  });

  it('emits persona.added and reset', () => {
    const { engine, events } = makeEngine();
    engine.addAdHoc({ label: 'X', role: 'tenant' });
    engine.reset();
    expect(events.some((e) => e.type === 'persona.added')).toBe(true);
    expect(events.some((e) => e.type === 'reset')).toBe(true);
  });

  it('unsubscribe stops delivery; a throwing listener does not break emit', async () => {
    const { engine, events, unsub } = makeEngine();
    engine.subscribe(() => { throw new Error('bad listener'); });
    await engine.sendAsParty({ from: '+15550100001', body: 'a' }); // must not throw
    unsub();
    await engine.sendAsParty({ from: '+15550100002', body: 'b' });
    expect(events.filter((e) => e.type === 'message.appended')).toHaveLength(1);
  });
});
