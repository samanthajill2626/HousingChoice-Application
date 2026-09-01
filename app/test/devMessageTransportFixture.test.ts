import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { createDevRouter } from '../src/routes/dev.js';

function rig() {
  const puts: Record<string, unknown>[] = [];
  const doc = {
    send: async (command: { input?: { Item?: Record<string, unknown> } }) => {
      if (command.input?.Item !== undefined) puts.push(command.input.Item);
      return {};
    },
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: '1',
    DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
    CF_ORIGIN_SECRET: 'test-origin-secret',
  });
  const app = express();
  app.use(createDevRouter({ config, doc: doc as never }));
  return { app, puts };
}

const base = {
  conversationId: 'conversation-fixture',
  body: 'old message',
  createdAt: '2026-08-01T00:00:00.000Z',
};

describe('dev message transport fixture', () => {
  it('defaults to a deliberate versioned inbound SMS without a pointer write', async () => {
    const { app, puts } = rig();
    const response = await request(app).post('/__dev/extraction/message-fixture').send(base);
    expect(response.status).toBe(200);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      type: 'sms',
      direction: 'inbound',
      transport_schema_version: 1,
      actual_transport: 'sms',
    });
    expect(puts[0]).not.toHaveProperty('requested_transport');
  });

  it.each([
    [{ mode: 'legacy' }, {}],
    [{ mode: 'versioned', requested: 'rcs' }, { transport_schema_version: 1, requested_transport: 'rcs' }],
    [{ mode: 'versioned', requested: 'rcs', actual: 'sms' }, { transport_schema_version: 1, requested_transport: 'rcs', actual_transport: 'sms' }],
    [{ mode: 'versioned' }, { transport_schema_version: 1 }],
  ])('accepts explicit transport fixture %j', async (transport, expected) => {
    const { app, puts } = rig();
    const direction = 'requested' in transport ? 'outbound' : 'inbound';
    const response = await request(app).post('/__dev/extraction/message-fixture').send({ ...base, direction, transport });
    expect(response.status).toBe(200);
    expect(puts[0]).toMatchObject(expected);
    if (transport.mode === 'legacy') expect(puts[0]).not.toHaveProperty('transport_schema_version');
  });

  it.each([
    { direction: 'inbound', transport: { mode: 'versioned', requested: 'sms' } },
    { direction: 'outbound', transport: { mode: 'versioned', actual: 'email' } },
    { direction: 'outbound', transport: { mode: 'legacy', actual: 'sms' } },
  ])('rejects invalid transport fixture %j', async (invalid) => {
    const { app, puts } = rig();
    const response = await request(app).post('/__dev/extraction/message-fixture').send({ ...base, ...invalid });
    expect(response.status).toBe(400);
    expect(puts).toHaveLength(0);
  });
});
