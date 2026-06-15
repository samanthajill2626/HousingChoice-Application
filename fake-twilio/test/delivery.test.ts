// fake-twilio/test/delivery.test.ts
import { describe, expect, it } from 'vitest';
import { plannedTransitions } from '../src/engine/delivery.js';

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
