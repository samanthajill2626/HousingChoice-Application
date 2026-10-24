// POST /__dev/voice/transcript-fixture - last heard from (spec 5.1 / 14.2):
// the fixture's call append touches through the SAME rule and writer as the
// live voice paths, so e2e state built through it obeys the rule. Injected
// fakes only - no DynamoDB.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { appEvents } from '../src/lib/events.js';
import { createDevRouter } from '../src/routes/dev.js';

type TouchResult = 'written' | 'skipped' | 'failed';

function rig(
  threads: Record<string, Record<string, unknown>> = {},
  touchResult: TouchResult = 'written',
  reachedOutResult: TouchResult = 'written',
) {
  const puts: Record<string, unknown>[] = [];
  const touches: { contactId: string; at: string }[] = [];
  // today-checklist W8: the outbound twin's stamps, recorded like the touches.
  const reachedOut: { contactId: string; at: string }[] = [];
  const appends: { conversationId: string; providerTs: string; providerSid: string }[] = [];
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
      touchLastHeardFrom: async (contactId: string, at: string): Promise<TouchResult> => {
        touches.push({ contactId, at });
        return touchResult;
      },
      touchLastReachedOut: async (contactId: string, at: string): Promise<TouchResult> => {
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

const body = {
  conversationId: 'conversation-fixture',
  callSid: 'CAfixture-heard',
  sentences: [{ text: 'hello', mediaChannel: 1 }],
};

describe('dev transcript fixture - last heard from (spec 5.1 / 14.2)', () => {
  it('an inbound call fixture touches the thread participant at the append instant', async () => {
    const { app, touches, appends } = rig(TENANT_THREAD);
    const response = await request(app).post('/__dev/voice/transcript-fixture').send(body);
    expect(response.status).toBe(200);
    expect(appends).toHaveLength(1);
    expect(touches).toEqual([{ contactId: 'c-t', at: appends[0]!.providerTs }]);
  });

  it('an outbound call fixture touches nobody', async () => {
    const { app, touches } = rig(TENANT_THREAD);
    const response = await request(app)
      .post('/__dev/voice/transcript-fixture')
      .send({ ...body, direction: 'outbound' });
    expect(response.status).toBe(200);
    expect(touches).toEqual([]);
  });

  it('a failed touch still answers 200', async () => {
    const { app, touches } = rig(TENANT_THREAD, 'failed');
    const response = await request(app).post('/__dev/voice/transcript-fixture').send(body);
    expect(response.status).toBe(200);
    expect(touches).toHaveLength(1);
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

// today-checklist W8 (spec 7.3, PR14, C1): an OUTBOUND call fixture stands for
// a staff call, so it stamps the one-to-one thread's contact at the append
// instant and emits ONE contact.updated when written. The fixture's author is
// 'unknown' for both directions, so the gate is the direction alone.
describe('dev transcript fixture - last reached out (today-checklist W8)', () => {
  it('an outbound call fixture stamps the thread participant at the append instant and emits ONE contact.updated', async () => {
    const { app, reachedOut, appends, touches } = rig(TENANT_THREAD);
    const seen = await contactUpdatesDuring(async () => {
      const response = await request(app)
        .post('/__dev/voice/transcript-fixture')
        .send({ ...body, direction: 'outbound' });
      expect(response.status).toBe(200);
    });
    expect(reachedOut).toEqual([{ contactId: 'c-t', at: appends[0]!.providerTs }]);
    expect(seen).toEqual([{ contactId: 'c-t' }]);
    // last_heard_from_at never moves on outbound (spec 7.1).
    expect(touches).toEqual([]);
  });

  it('an inbound call fixture stamps nobody', async () => {
    const { app, reachedOut } = rig(TENANT_THREAD);
    const response = await request(app).post('/__dev/voice/transcript-fixture').send(body);
    expect(response.status).toBe(200);
    expect(reachedOut).toEqual([]);
  });

  it('a failed stamp still answers 200 and emits nothing', async () => {
    const { app, reachedOut } = rig(TENANT_THREAD, 'written', 'failed');
    const seen = await contactUpdatesDuring(async () => {
      const response = await request(app)
        .post('/__dev/voice/transcript-fixture')
        .send({ ...body, direction: 'outbound' });
      expect(response.status).toBe(200);
    });
    expect(reachedOut).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});
