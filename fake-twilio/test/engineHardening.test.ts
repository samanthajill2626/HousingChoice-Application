// fake-twilio/test/engineHardening.test.ts
import { describe, expect, it } from 'vitest';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';
import type { WebhookParams } from '../src/engine/signer.js';

function makeEngine(post?: (path: string, params: WebhookParams) => Promise<number>) {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const dispatcher = {
    post:
      post ??
      (async (path: string, params: WebhookParams) => {
        posted.push({ path, params });
        return 200;
      }),
  };
  const engine = new FakeTwilioEngine({ clock, dispatcher });
  return { engine, clock, posted };
}

describe('FIX 1 — reset() cancels in-flight scheduled status callbacks', () => {
  it('a pending delivery timer does not fire after reset() + flush()', async () => {
    const { engine, clock, posted } = makeEngine();
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'hi' });
    engine.reset();
    clock.flush();
    await Promise.resolve();
    const statusPosts = posted.filter((p) => p.path === '/webhooks/twilio/status');
    expect(statusPosts).toHaveLength(0);
    expect(engine.listThreads()).toHaveLength(0);
  });
});

describe('FIX 2 — surface dispatch failures', () => {
  it('(a) sendAsParty throws when the inbound webhook post is non-2xx (403)', async () => {
    const { engine } = makeEngine(async () => 403);
    await expect(engine.sendAsParty({ from: '+15550100001', body: 'x' })).rejects.toThrow();
  });

  it('(b) a 500 on a status post is recorded in getDispatchErrors', async () => {
    const { engine, clock } = makeEngine(async (path) => (path === '/webhooks/twilio/status' ? 500 : 200));
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'hi' });
    clock.flush();
    await new Promise((r) => setTimeout(r, 0));
    const errors = engine.getDispatchErrors();
    expect(errors.some((e) => e.path === '/webhooks/twilio/status' && e.status === 500)).toBe(true);
  });

  it('(c) a rejecting status post produces no unhandled rejection and is recorded', async () => {
    const { engine, clock } = makeEngine(async (path) => {
      if (path === '/webhooks/twilio/status') throw new Error('network down');
      return 200;
    });
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'hi' });
    clock.flush();
    await new Promise((r) => setTimeout(r, 0));
    const errors = engine.getDispatchErrors();
    expect(errors.some((e) => e.path === '/webhooks/twilio/status' && e.error?.includes('network down'))).toBe(true);
  });
});

describe('FIX 3 — strictly-increasing step delays', () => {
  it('status callbacks arrive in planned order even with a 3-state progression', async () => {
    const { engine, clock, posted } = makeEngine();
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'hi' });
    clock.flush();
    await Promise.resolve();
    const statuses = posted.filter((p) => p.path === '/webhooks/twilio/status').map((p) => p.params['MessageStatus']);
    // FIX 4: 'queued' callback is skipped; normal profile emits sent, delivered.
    expect(statuses).toEqual(['sent', 'delivered']);
  });
});

describe('FIX 4 — drop the queued status callback', () => {
  it('normal profile emits sent then delivered (no queued callback)', async () => {
    const { engine, clock, posted } = makeEngine();
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'hi' });
    clock.flush();
    await Promise.resolve();
    const statuses = posted.filter((p) => p.path === '/webhooks/twilio/status').map((p) => p.params['MessageStatus']);
    expect(statuses).toEqual(['sent', 'delivered']);
    const thread = engine.listThreads().find((t) => t.partyNumber === '+15550100001');
    expect(thread?.messages[0]?.state).toBe('delivered');
  });
});

describe('FIX 5 — E.164 validation + app-number near-miss', () => {
  it('addAdHoc rejects a non-E.164 number', () => {
    const { engine } = makeEngine();
    expect(() => engine.addAdHoc({ label: 'x', role: 'tenant', number: 'not-a-number' })).toThrow();
  });

  it('addAdHoc rejects an app-number near-miss with trailing whitespace', () => {
    const { engine } = makeEngine();
    expect(() => engine.addAdHoc({ label: 'x', role: 'tenant', number: '+15550009999 ' })).toThrow();
  });

  it('sendAsParty rejects a non-http mediaUrl', async () => {
    const { engine } = makeEngine();
    const p = engine.addAdHoc({ label: 'Unknown', role: 'tenant' });
    await expect(
      engine.sendAsParty({ from: p.number, body: 'x', mediaUrls: ['ftp://evil/cat.jpg'] }),
    ).rejects.toThrow();
  });
});

describe('FIX 6 — modest input caps', () => {
  it('sendAsParty rejects an oversized body', async () => {
    const { engine } = makeEngine();
    const p = engine.addAdHoc({ label: 'Unknown', role: 'tenant' });
    await expect(engine.sendAsParty({ from: p.number, body: 'a'.repeat(10001) })).rejects.toThrow();
  });

  it('sendAsParty rejects an oversized mediaUrls array', async () => {
    const { engine } = makeEngine();
    const p = engine.addAdHoc({ label: 'Unknown', role: 'tenant' });
    const urls = Array.from({ length: 26 }, (_, i) => `https://x/${i}.jpg`);
    await expect(engine.sendAsParty({ from: p.number, mediaUrls: urls })).rejects.toThrow();
  });
});
