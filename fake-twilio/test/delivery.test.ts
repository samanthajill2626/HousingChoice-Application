// fake-twilio/test/delivery.test.ts
import { describe, expect, it } from 'vitest';
import { plannedTransitions, stepDelayMs } from '../src/engine/delivery.js';

describe('plannedTransitions', () => {
  it('normal → queued, sent, delivered', () => {
    expect(plannedTransitions({ kind: 'normal' })).toEqual(['queued', 'sent', 'delivered']);
  });

  it('stall stops at the configured state (default sent)', () => {
    expect(plannedTransitions({ kind: 'stall' })).toEqual(['queued', 'sent']);
    expect(plannedTransitions({ kind: 'stall', stallAt: 'queued' })).toEqual(['queued']);
  });

  it('fail → queued, sent, then the fail state', () => {
    expect(plannedTransitions({ kind: 'fail' })).toEqual(['queued', 'sent', 'failed']);
    expect(plannedTransitions({ kind: 'fail', failState: 'undelivered' })).toEqual(['queued', 'sent', 'undelivered']);
  });
});

describe('stepDelayMs', () => {
  it('is strictly increasing for any progression length (FIX 3)', () => {
    const delays = Array.from({ length: 8 }, (_, i) => stepDelayMs(i));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });
});
