// fake-twilio/test/eventHub.test.ts
import { describe, expect, it } from 'vitest';
import { EventHub } from '../src/engine/eventHub.js';
import type { EngineEvent } from '../src/engine/engineEvents.js';

const RESET: EngineEvent = { type: 'reset' };
const CALL_PLACED: EngineEvent = {
  type: 'call.placed',
  call: {
    callSid: 'CAfake00000001',
    from: '+15550100001',
    to: '+15550009999',
    kind: 'masked',
    status: 'ringing',
    legs: [],
    createdAt: 0,
    updatedAt: 0,
  },
};

describe('EventHub', () => {
  it('delivers events to all subscribed listeners', () => {
    const hub = new EventHub();
    const a: EngineEvent[] = [];
    const b: EngineEvent[] = [];
    hub.subscribe((e) => a.push(e));
    hub.subscribe((e) => b.push(e));
    hub.emit(RESET);
    hub.emit(CALL_PLACED);
    expect(a).toEqual([RESET, CALL_PLACED]);
    expect(b).toEqual([RESET, CALL_PLACED]);
  });

  it('a throwing listener does not break emit — other listeners still receive the event', () => {
    const hub = new EventHub();
    const received: EngineEvent[] = [];
    hub.subscribe(() => {
      throw new Error('bad listener');
    });
    hub.subscribe((e) => received.push(e));
    expect(() => hub.emit(CALL_PLACED)).not.toThrow();
    expect(received).toEqual([CALL_PLACED]);
  });

  it('the unsubscribe fn returned by subscribe stops further delivery to that listener', () => {
    const hub = new EventHub();
    const received: EngineEvent[] = [];
    const unsub = hub.subscribe((e) => received.push(e));
    hub.emit(RESET);
    unsub();
    hub.emit(CALL_PLACED);
    expect(received).toEqual([RESET]);
  });
});
