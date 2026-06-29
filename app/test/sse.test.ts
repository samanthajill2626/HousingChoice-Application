// M1.2 — GET /api/events (SSE live updates). A REAL http server + fetch
// stream client (supertest buffers, so it cannot read an open SSE stream):
// headers, typed event frames, heartbeats, disconnect cleanup, and the full
// loop (signed Twilio webhook in → bus → SSE frame out). The status-callback
// emit gate (real transitions only) is covered at the bus level.
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  inboundSmsParams,
  makeWebhookHarness,
  ORIGIN_SECRET,
  signedTwilioPost,
  statusParams,
  TENANT_PHONE,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const servers: Server[] = [];
const aborters: AbortController[] = [];

afterEach(async () => {
  for (const controller of aborters) controller.abort();
  aborters.length = 0;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

async function startServer(app: Express): Promise<number> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no listening port');
  return address.port;
}

interface SseClient {
  response: Response;
  abort: () => void;
  received: () => string;
  waitFor: (needle: string, timeoutMs?: number) => Promise<void>;
}

/** Connect to /api/events and accumulate the raw stream text. */
async function connectSse(port: number): Promise<SseClient> {
  const controller = new AbortController();
  aborters.push(controller);
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    // M1.3: the SSE stream sits behind requireAuth like every /api route —
    // the session rides the cookie header, exactly as EventSource sends it.
    headers: { 'x-origin-verify': ORIGIN_SECRET, cookie: TEST_SESSION_COOKIE },
    signal: controller.signal,
  });
  let buffer = '';
  void (async () => {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted — expected at the end of every test
    }
  })();
  return {
    response,
    abort: () => controller.abort(),
    received: () => buffer,
    async waitFor(needle, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (!buffer.includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${JSON.stringify(needle)} — stream so far: ${buffer}`);
        }
        await delay(10);
      }
    },
  };
}

describe('GET /api/events — stream mechanics', () => {
  it('opens with SSE headers + a connected comment, then streams typed event frames', async () => {
    const { app, world } = makeWebhookHarness();
    const port = await startServer(app);
    const client = await connectSse(port);

    expect(client.response.status).toBe(200);
    expect(client.response.headers.get('content-type')).toBe('text/event-stream');
    // no-transform keeps proxies/CloudFront from compressing or buffering.
    expect(client.response.headers.get('cache-control')).toBe('no-cache, no-transform');
    await client.waitFor(': connected');

    world.events.emit('conversation.updated', {
      conversationId: 'conv-sse-1',
      last_activity_at: '2026-06-12T12:00:00.000Z',
      unread_count: 3,
      preview: 'hi there',
      type: 'tenant_1to1',
      assignment: null,
      participant_display_name: null,
    });
    world.events.emit('message.persisted', {
      conversationId: 'conv-sse-1',
      tsMsgId: '2026-06-12T12:00:00.000Z#SMsse1',
      direction: 'inbound',
      deliveryStatus: 'delivered',
    });

    await client.waitFor('event: conversation.updated');
    await client.waitFor('event: message.persisted');
    expect(client.received()).toContain(
      `data: ${JSON.stringify({
        conversationId: 'conv-sse-1',
        last_activity_at: '2026-06-12T12:00:00.000Z',
        unread_count: 3,
        preview: 'hi there',
        type: 'tenant_1to1',
        assignment: null,
        participant_display_name: null,
      })}`,
    );
  });

  it('sends heartbeat comments on the configured interval', async () => {
    const { app } = makeWebhookHarness({ sseHeartbeatMs: 20 });
    const port = await startServer(app);
    const client = await connectSse(port);

    await client.waitFor(': heartbeat');
  });

  it('cleans up bus listeners on client disconnect (no leak across connects)', async () => {
    const { app, world } = makeWebhookHarness();
    const port = await startServer(app);

    // The harness itself holds one recorder listener per event.
    const baseline = world.events.listenerCount('conversation.updated');

    const client = await connectSse(port);
    await client.waitFor(': connected');
    // Every forwarded event registers a listener — including placement.updated and
    // broadcast.updated (a missing off() for either leaks one per disconnect).
    expect(world.events.listenerCount('conversation.updated')).toBe(baseline + 1);
    expect(world.events.listenerCount('message.persisted')).toBe(baseline + 1);
    expect(world.events.listenerCount('broadcast.updated')).toBe(baseline + 1);
    expect(world.events.listenerCount('placement.updated')).toBe(baseline + 1);

    client.abort();
    const deadline = Date.now() + 3_000;
    while (world.events.listenerCount('conversation.updated') > baseline) {
      if (Date.now() > deadline) throw new Error('SSE listeners were not removed after disconnect');
      await delay(10);
    }
    expect(world.events.listenerCount('conversation.updated')).toBe(baseline);
    expect(world.events.listenerCount('message.persisted')).toBe(baseline);
    expect(world.events.listenerCount('broadcast.updated')).toBe(baseline);
    expect(world.events.listenerCount('placement.updated')).toBe(baseline);
  });
});

describe('event bus — listener isolation (M1.2)', () => {
  it('a throwing listener never breaks the emit or the other listeners (correlated ERROR instead)', () => {
    const capture = createLogCapture();
    const bus = createEventBus({ logger: createLogger({ level: 'info', destination: capture.stream }) });
    const seen: string[] = [];
    bus.on('conversation.updated', () => {
      seen.push('first');
      throw new Error('listener exploded');
    });
    bus.on('conversation.updated', () => {
      seen.push('second');
    });

    // The emitter's caller (a webhook/send pipeline in production) must
    // never observe the listener's throw.
    expect(() =>
      bus.emit('conversation.updated', {
        conversationId: 'conv-iso',
        last_activity_at: '2026-06-12T12:00:00.000Z',
        unread_count: 0,
        type: 'unknown_1to1',
        assignment: null,
        participant_display_name: null,
      }),
    ).not.toThrow();

    expect(seen).toEqual(['first', 'second']); // the second listener still ran
    const err = capture.atLevel(50).find((l) => String(l['msg']).includes('event bus listener threw'))!;
    expect(err).toBeDefined();
    expect(err['event']).toBe('conversation.updated');
    // The payload (PII: preview) is never logged.
    expect(JSON.stringify(err)).not.toContain('conv-iso');
  });
});

describe('GET /api/events — connection cap (H4 partial)', () => {
  it('beyond SSE_MAX_CONNECTIONS → 503 + correlated WARN; a close frees the slot', async () => {
    const { app, capture } = makeWebhookHarness({ env: { SSE_MAX_CONNECTIONS: '1' } });
    const port = await startServer(app);

    const first = await connectSse(port);
    expect(first.response.status).toBe(200);
    await first.waitFor(': connected');

    const second = await connectSse(port);
    expect(second.response.status).toBe(503);
    const warn = capture
      .atLevel(40)
      .find((l) => String(l['msg']).includes('sse connection cap reached'))!;
    expect(warn).toBeDefined();
    expect(typeof warn['correlationId']).toBe('string');

    // Disconnecting the first stream frees its slot (close is async — poll).
    first.abort();
    const deadline = Date.now() + 3_000;
    let reconnected = false;
    while (!reconnected && Date.now() < deadline) {
      const retry = await connectSse(port);
      if (retry.response.status === 200) {
        reconnected = true;
        break;
      }
      await delay(10);
    }
    expect(reconnected).toBe(true);
  });
});

describe('GET /api/events — full loop (webhook in → SSE frame out)', () => {
  it('a signed inbound webhook reaches a connected SSE client as both event frames', async () => {
    const { app, world } = makeWebhookHarness();
    const port = await startServer(app);
    const client = await connectSse(port);
    await client.waitFor(': connected');

    await signedTwilioPost(app, '/webhooks/twilio/sms', inboundSmsParams({ MessageSid: 'SMlive01' }));

    await client.waitFor('event: message.persisted');
    await client.waitFor('event: conversation.updated');
    const conv = [...world.conversations.values()][0]!;
    expect(client.received()).toContain(`"conversationId":"${conv.conversationId}"`);
    expect(client.received()).toContain('"unread_count":1');
  });

  it('a placement mutation reaches a connected SSE client as a placement.updated frame (no PII on the wire)', async () => {
    const { app, world } = makeWebhookHarness();
    await world.contactsRepo.create({ contactId: 't-sse', type: 'tenant', status: 'searching' });
    await world.unitsRepo.create({ unitId: 'u-sse', landlordId: 'll-1', status: 'available' });
    const port = await startServer(app);
    const client = await connectSse(port);
    await client.waitFor(': connected');

    await request(app)
      .post('/api/placements')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ tenantId: 't-sse', unitId: 'u-sse', placement_tag: 'Keisha @ 123 Main' });

    await client.waitFor('event: placement.updated');
    expect(client.received()).toContain('"tenantId":"t-sse"');
    // The placement_tag (a name) must never cross the wire (doc §9).
    expect(client.received()).not.toContain('Keisha');
  });
});

describe('SSE emit gates — delivery status callbacks (bus level)', () => {
  async function seedOutbound(world: FakeWorld, sid: string): Promise<string> {
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(
      TENANT_PHONE,
      'tenant_1to1',
    );
    await world.messagesRepo.append({
      conversationId: conversation.conversationId,
      providerSid: sid,
      providerTs: '2026-06-12T10:00:00.000Z',
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'outbound body',
      deliveryStatus: 'queued',
    });
    return conversation.conversationId;
  }

  it('emits message.persisted on a REAL transition only — duplicates and regressions stay silent', async () => {
    const { app, world } = makeWebhookHarness();
    const conversationId = await seedOutbound(world, 'SMstatus-sse');

    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMstatus-sse', MessageStatus: 'sent' }));
    expect(world.emitted).toEqual([
      {
        event: 'message.persisted',
        payload: {
          conversationId,
          tsMsgId: '2026-06-12T10:00:00.000Z#SMstatus-sse',
          direction: 'outbound',
          deliveryStatus: 'sent',
        },
      },
    ]);

    // Redelivered duplicate: no transition → no emit.
    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMstatus-sse', MessageStatus: 'sent' }));
    expect(world.emitted).toHaveLength(1);

    // Forward transition emits again…
    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMstatus-sse', MessageStatus: 'delivered' }));
    expect(world.emitted).toHaveLength(2);
    expect(world.emitted[1]!.payload).toMatchObject({ deliveryStatus: 'delivered' });

    // …but a late regression never does.
    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMstatus-sse', MessageStatus: 'sent' }));
    expect(world.emitted).toHaveLength(2);
  });

  it('emits nothing for an unknown SID (the dropped-outcome ERROR path)', async () => {
    const { app, world } = makeWebhookHarness({ statusUnknownSidRetryDelayMs: 10 });
    await signedTwilioPost(app, '/webhooks/twilio/status', statusParams({ MessageSid: 'SMghost-sse', MessageStatus: 'delivered' }));
    expect(world.emitted).toHaveLength(0);
  });
});
