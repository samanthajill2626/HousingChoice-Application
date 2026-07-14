// POST /__dev/relay/replay-intros — the dev-only seam that re-fires the REAL
// relay.intro job for every OPEN relay_group conversation with a pool number AND
// a well-formed participants roster (member objects carrying phones). It
// materializes the seeded live relay group in the fake-phones UI at startup: the
// intro legs flow FROM the pool number through the real fan-out, and the fake
// infers the group from that traffic (no static mirror). This suite mirrors
// devGating.test.ts (supertest + createDevRouter with injected deps).
//
// Two concerns:
//   A. Route behavior — gating (404 when the dev router is absent), replay only
//      well-formed OPEN groups (skip bare-id cast rosters, empty matrix rosters,
//      pool-less groups; closed groups are excluded by the 'open' query),
//      response shape { replayed, skipped }, one enqueue per replayed group.
//   B. The spec's load-bearing claim: the real relay.intro job persists NO
//      message rows. Wire the route's enqueue to the REAL job machinery
//      (InProcess dispatch) and assert the message store is untouched after the
//      POST — only fake outbound legs were sent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createDevRouter } from '../src/routes/dev.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import { RELAY_INTRO_JOB, registerRelayFanOutJobHandler } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = 'test-origin-secret';

/** A well-formed relay member: object with a non-empty phone. */
function member(contactId: string, phone: string, name?: string): ConversationParticipant {
  return name === undefined ? { contactId, phone } : { contactId, phone, name };
}

/** Build a curated relay_group conversation for the list fake. */
function relayGroup(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    conversationId: 'conv-x',
    participant_phone: '+15550160001',
    pool_number: '+15550160001',
    status: 'open',
    last_activity_at: '2026-07-06T00:00:00.000Z',
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [member('c-diana', '+15550170001', 'Diana Osei')],
    created_at: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

/** A conversationsRepo fake exposing ONLY listRelayGroups (status-filtered),
 *  recording the status it was queried with. Mirrors the real repo: the 'open'
 *  partition returns only open relay groups. */
function makeConversationsRepo(all: ConversationItem[]): {
  repo: ConversationsRepo;
  queriedStatuses: string[];
} {
  const queriedStatuses: string[] = [];
  const repo = {
    listRelayGroups: async (status: 'open' | 'closed') => {
      queriedStatuses.push(status);
      return {
        items: all.filter((c) => c.type === 'relay_group' && c.status === status),
        truncated: false,
      };
    },
  } as unknown as ConversationsRepo;
  return { repo, queriedStatuses };
}

describe('POST /__dev/relay/replay-intros — route behavior', () => {
  const config = () => loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });

  // Cast bare-id roster (seed/cast.ts) — array of contactId STRINGS, not member
  // objects. Violates the ConversationParticipant type by design (real seed data
  // shape), so cast through unknown.
  const bareIdRoster = ['contact-searching', 'contact-landlord-0001'] as unknown as ConversationParticipant[];

  function buildApp404() {
    // No devRouter → the route must not exist.
    return buildApp({ config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }) });
  }

  it('is absent (404) when the dev router is not mounted', async () => {
    const app = buildApp404();
    const res = await request(app)
      .post('/__dev/relay/replay-intros')
      .set('x-origin-verify', SECRET)
      .send();
    expect(res.status).toBe(404);
  });

  it('replays ONLY well-formed open groups; skips bare-id/empty/pool-less; returns { replayed, skipped }', async () => {
    const items: ConversationItem[] = [
      // well-formed open → replayed
      relayGroup({ conversationId: 'conv-live-relay-group', pool_number: '+15550160001' }),
      // bare-id cast roster (open) → skipped
      relayGroup({ conversationId: 'conv-cast-relay', pool_number: '+15550109001', participants: bareIdRoster }),
      // empty matrix roster (open) → skipped
      relayGroup({ conversationId: 'conv-matrix-relay', pool_number: '+15550200001', participants: [] }),
      // pool-less (open, well-formed roster) → skipped
      relayGroup({ conversationId: 'conv-nopool', pool_number: undefined }),
      // closed well-formed → excluded by the 'open' query (neither replayed nor skipped)
      relayGroup({ conversationId: 'conv-closed-relay', pool_number: '+15550160002', status: 'closed' }),
    ];
    const { repo, queriedStatuses } = makeConversationsRepo(items);
    const enqueued: string[] = [];
    const cfg = config();
    const devRouter = createDevRouter({
      config: cfg,
      relayReplayDeps: { conversationsRepo: repo, enqueueIntro: async (id) => void enqueued.push(id) },
    });
    const app = buildApp({ config: cfg, devRouter });

    const res = await request(app).post('/__dev/relay/replay-intros').send();
    expect(res.status).toBe(200);
    // 1 replayed (live), 3 skipped (cast bare-id + matrix empty + pool-less).
    expect(res.body).toEqual({ replayed: 1, skipped: 3 });
    // Only the well-formed open group's intro was enqueued (exactly once).
    expect(enqueued).toEqual(['conv-live-relay-group']);
    // The route queried the OPEN partition (closed groups never entered the pool).
    expect(queriedStatuses).toEqual(['open']);
  });

  it('reports { replayed: 0, skipped: 0 } when there are no open relay groups', async () => {
    const { repo } = makeConversationsRepo([]);
    const cfg = config();
    const devRouter = createDevRouter({
      config: cfg,
      relayReplayDeps: { conversationsRepo: repo, enqueueIntro: async () => {} },
    });
    const app = buildApp({ config: cfg, devRouter });

    const res = await request(app).post('/__dev/relay/replay-intros').send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replayed: 0, skipped: 0 });
  });

  it('re-fires on repeat POSTs (idempotent for a dev tool — enqueues again each call)', async () => {
    const { repo } = makeConversationsRepo([
      relayGroup({ conversationId: 'conv-live-relay-group' }),
    ]);
    const enqueued: string[] = [];
    const cfg = config();
    const devRouter = createDevRouter({
      config: cfg,
      relayReplayDeps: { conversationsRepo: repo, enqueueIntro: async (id) => void enqueued.push(id) },
    });
    const app = buildApp({ config: cfg, devRouter });

    await request(app).post('/__dev/relay/replay-intros').send();
    await request(app).post('/__dev/relay/replay-intros').send();
    // Two POSTs → the intro is enqueued twice (more fake legs; acceptable).
    expect(enqueued).toEqual(['conv-live-relay-group', 'conv-live-relay-group']);
  });
});

describe('POST /__dev/relay/replay-intros — the real relay.intro job persists no message rows', () => {
  // Wire the route's enqueue to the REAL job machinery so the POST runs the
  // actual relay.intro handler in-process (InProcess dispatch), then assert the
  // spec's load-bearing claim: the message-row store is UNCHANGED. A real
  // provisioning intro now PERSISTS a system-announcement row (founder decision
  // 2026-07-14), so the replay seam passes persist:false — legs-only, keeping
  // the seeded DB byte-stable across replays.
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    // InProcess adapter dispatches immediate jobs IN-PROCESS (no real queue), so
    // the intro runs synchronously within the route's `await enqueueImmediate`.
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it('sends the intro legs from the pool but leaves the message store empty', async () => {
    const POOL = '+15550160001';
    const DIANA = '+15550170001';
    const GLORIA = '+15550170003';
    world.conversations.set('conv-live-relay-group', {
      conversationId: 'conv-live-relay-group',
      participant_phone: POOL,
      pool_number: POOL,
      status: 'open',
      last_activity_at: '2026-07-06T00:00:00.000Z',
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [member('c-diana', DIANA, 'Diana Osei'), member('c-gloria', GLORIA, 'Gloria Mensah')],
      created_at: '2026-07-06T00:00:00.000Z',
    });

    const cfg = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });
    const { repo } = makeConversationsRepo([
      world.conversations.get('conv-live-relay-group') as ConversationItem,
    ]);
    const devRouter = createDevRouter({
      config: cfg,
      relayReplayDeps: {
        conversationsRepo: repo,
        // The REAL enqueue → InProcess dispatch → real relay.intro handler.
        // persist:false mirrors the route's default seam (dev.ts): the replay
        // is legs-only so the seeded DB never grows.
        enqueueIntro: async (id) =>
          void (await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: id, persist: false })),
      },
    });
    const app = buildApp({ config: cfg, devRouter });

    const res = await request(app).post('/__dev/relay/replay-intros').send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replayed: 1, skipped: 0 });

    // The intro fired: one leg per member, all FROM the pool number.
    expect(world.sent.map((s) => s.to).sort()).toEqual([DIANA, GLORIA].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);

    // The load-bearing claim: NO message rows were persisted (the intro is not a
    // relayed message). The seeded DB is byte-stable across replays.
    expect(world.messages).toHaveLength(0);
    // The idempotency marker is a separate item (NOT a message row).
    expect(world.jobExecutionMarkers.size).toBe(1);
  });
});
