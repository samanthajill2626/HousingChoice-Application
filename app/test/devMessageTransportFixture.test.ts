import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { appEvents } from '../src/lib/events.js';
import { createDevRouter } from '../src/routes/dev.js';

// Injected fakes (last heard from, spec 5.1 / 14.2): the fixture touches
// through the live rule, so the rig records touches and appends - and every
// case stays off the default DynamoDB client.
function rig(
  threads: Record<string, Record<string, unknown>> = {},
  reachedOutResult: 'written' | 'skipped' | 'failed' = 'written',
) {
  const puts: Record<string, unknown>[] = [];
  const touches: { contactId: string; at: string }[] = [];
  // today-checklist W8: the outbound twin's stamps, recorded like the touches.
  const reachedOut: { contactId: string; at: string }[] = [];
  const appends: Record<string, unknown>[] = [];
  const doc = {
    send: async (command: { input?: { Item?: Record<string, unknown> } }) => {
      if (command.input?.Item !== undefined) puts.push(command.input.Item);
      return {};
    },
  };
  const heardFromRepos = {
    contactsRepo: {
      findByPhone: async () => undefined,
      findByEmail: async () => undefined,
      touchLastHeardFrom: async (contactId: string, at: string) => {
        touches.push({ contactId, at });
        return 'written' as const;
      },
      touchLastReachedOut: async (contactId: string, at: string) => {
        reachedOut.push({ contactId, at });
        return reachedOutResult;
      },
    },
    conversationsRepo: { getById: async (id: string) => threads[id] as never },
  };
  const voiceFixtureRepos = {
    messages: {
      append: async (m: { conversationId: string; providerTs: string; providerSid: string }) => {
        appends.push(m);
        return { deduped: false, tsMsgId: `${m.providerTs}#${m.providerSid}`, conversationId: m.conversationId };
      },
      setCallTranscript: async () => undefined,
    },
    extraction: { scheduleExtraction: async () => undefined },
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: '1',
    DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
    CF_ORIGIN_SECRET: 'test-origin-secret',
  });
  const app = express();
  app.use(createDevRouter({ config, doc: doc as never, heardFromRepos, voiceFixtureRepos: voiceFixtureRepos as never }));
  return { app, puts, touches, appends, reachedOut };
}

const TENANT_THREAD = {
  'conversation-fixture': { type: 'tenant_1to1', participants: [{ contactId: 'c-t', phone: '+15550100001' }] },
};

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
    { direction: 'outbound', transport: { mode: 'versioned' } },
    { direction: 'outbound', transport: { mode: 'versioned', actual: 'email' } },
    { direction: 'outbound', transport: { mode: 'legacy', actual: 'sms' } },
  ])('rejects invalid transport fixture %j', async (invalid) => {
    const { app, puts } = rig();
    const response = await request(app).post('/__dev/extraction/message-fixture').send({ ...base, ...invalid });
    expect(response.status).toBe(400);
    expect(puts).toHaveLength(0);
  });
});

describe('dev message fixture - last heard from (spec 5.1 / 14.2)', () => {
  it('direct-Put branch, inbound: touches the thread participant at the planted instant', async () => {
    const { app, touches } = rig(TENANT_THREAD);
    const response = await request(app).post('/__dev/extraction/message-fixture').send(base);
    expect(response.status).toBe(200);
    expect(touches).toEqual([{ contactId: 'c-t', at: '2026-08-01T00:00:00.000Z' }]);
  });

  it('direct-Put branch, outbound: touches nobody', async () => {
    const { app, touches } = rig(TENANT_THREAD);
    const response = await request(app)
      .post('/__dev/extraction/message-fixture')
      .send({ ...base, direction: 'outbound', transport: { mode: 'versioned', requested: 'sms' } });
    expect(response.status).toBe(200);
    expect(touches).toEqual([]);
  });

  it('append branch: touches the thread participant', async () => {
    const { app, touches, appends } = rig(TENANT_THREAD);
    const response = await request(app)
      .post('/__dev/extraction/message-fixture')
      .send({ ...base, providerSid: 'SM' + 'a'.repeat(32) });
    expect(response.status).toBe(200);
    expect(appends).toHaveLength(1);
    expect(touches).toEqual([{ contactId: 'c-t', at: '2026-08-01T00:00:00.000Z' }]);
  });

  it('a relay sender key on a relay thread names that member', async () => {
    const { app, touches } = rig({
      'conversation-fixture': { type: 'relay_group', participants: [{ contactId: 'c-r', phone: '+15550100002' }] },
    });
    const response = await request(app)
      .post('/__dev/extraction/message-fixture')
      .send({ ...base, relaySenderKey: 'c-r' });
    expect(response.status).toBe(200);
    expect(touches).toEqual([{ contactId: 'c-r', at: '2026-08-01T00:00:00.000Z' }]);
  });

  it('an unknown conversation answers 200 and touches nobody', async () => {
    const { app, touches } = rig();
    const response = await request(app).post('/__dev/extraction/message-fixture').send(base);
    expect(response.status).toBe(200);
    expect(touches).toEqual([]);
  });
});

/** Run `post` with a listener on the module bus the dev router emits on. */
async function contactUpdatesDuring(post: () => Promise<unknown>): Promise<{ contactId: string }[]> {
  const seen: { contactId: string }[] = [];
  const listener = (payload: { contactId: string }): void => {
    seen.push(payload);
  };
  appEvents.on('contact.updated', listener);
  try {
    await post();
  } finally {
    appEvents.off('contact.updated', listener);
  }
  return seen;
}

// today-checklist W8 (spec 7.3, PR14): an OUTBOUND message fixture stands for a
// staff text, so it stamps the one-to-one thread's contact at the planted
// instant and emits ONE contact.updated when written. Inbound rows and
// multi-party threads stamp nobody (C2).
describe('dev message fixture - last reached out (today-checklist W8)', () => {
  const OUTBOUND = { ...base, direction: 'outbound', transport: { mode: 'versioned', requested: 'sms' } };

  it('direct-Put branch, outbound: stamps the thread participant at the planted instant and emits ONE contact.updated', async () => {
    const { app, reachedOut, touches } = rig(TENANT_THREAD);
    const seen = await contactUpdatesDuring(async () => {
      const response = await request(app).post('/__dev/extraction/message-fixture').send(OUTBOUND);
      expect(response.status).toBe(200);
    });
    expect(reachedOut).toEqual([{ contactId: 'c-t', at: '2026-08-01T00:00:00.000Z' }]);
    expect(seen).toEqual([{ contactId: 'c-t' }]);
    expect(touches).toEqual([]);
  });

  it('append branch, outbound: stamps the thread participant', async () => {
    const { app, reachedOut, appends } = rig(TENANT_THREAD);
    const response = await request(app)
      .post('/__dev/extraction/message-fixture')
      .send({ ...OUTBOUND, providerSid: 'SM' + 'b'.repeat(32) });
    expect(response.status).toBe(200);
    expect(appends).toHaveLength(1);
    expect(reachedOut).toEqual([{ contactId: 'c-t', at: '2026-08-01T00:00:00.000Z' }]);
  });

  it('an inbound fixture stamps nobody', async () => {
    const { app, reachedOut } = rig(TENANT_THREAD);
    const response = await request(app).post('/__dev/extraction/message-fixture').send(base);
    expect(response.status).toBe(200);
    expect(reachedOut).toEqual([]);
  });

  it('an outbound team post on a relay thread stamps nobody (no single contact)', async () => {
    const { app, reachedOut } = rig({
      'conversation-fixture': { type: 'relay_group', participants: [{ contactId: 'c-r', phone: '+15550100002' }] },
    });
    const response = await request(app)
      .post('/__dev/extraction/message-fixture')
      .send({ ...OUTBOUND, relaySenderKey: 'team' });
    expect(response.status).toBe(200);
    expect(reachedOut).toEqual([]);
  });

  it('a skipped stamp emits no contact.updated', async () => {
    const { app, reachedOut } = rig(TENANT_THREAD, 'skipped');
    const seen = await contactUpdatesDuring(async () => {
      await request(app).post('/__dev/extraction/message-fixture').send(OUTBOUND);
    });
    expect(reachedOut).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});
