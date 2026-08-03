// Event Streams registration webhook (relay-number-buying T3): POST
// /webhooks/twilio/events promotes a `warming` pool number to `active` when
// Twilio confirms its A2P 10DLC registration. Correlation is by PN SID (D2);
// the payload field names are concatenated-lowercase (D1); the body is a
// CloudEvents JSON ARRAY (D3, looped not [0]-indexed); every handled / ignored /
// unknown / de-registration outcome returns HTTP 200 (D5). A promoted number
// that was earmarked to a connecting group enqueues the `relay.numberReady` JOB
// (D6). Auth (D4 pragmatic form) is a shared secret in the Authorization header,
// SKIPPED when unconfigured (hermetic/test) so the fake sink can POST without it.
//
// Runs on the in-memory webhook harness + a real poolNumbersService wired to an
// in-memory pool repo (no Twilio, no DynamoDB), with the jobs machinery wired so
// the relay.numberReady enqueue lands in a recording dispatch.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
} from '../src/jobs/jobs.js';
import type { MessagingAdapter } from '../src/adapters/messaging.js';
import type { AppConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { PoolNumberItem, PoolNumbersRepo } from '../src/repos/poolNumbersRepo.js';
import { createPoolNumbersService, type PoolNumbersService } from '../src/services/poolNumbers.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  emitNumberRegistered,
  makeWebhookHarness,
  postEvents,
  registrationEvent,
} from './helpers/twilioWebhookHarness.js';

const logger = createLogger({ destination: createLogCapture().stream });

const DEREG_TYPE = 'com.twilio.messaging.compliance.number-deregistration.successful';
const WARMING_NUMBER = '+15550009001';
const WARMING_SID = 'PNwarm000000000000000000000000001';
const MG_SID = 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

/** In-memory pool repo mirroring the burn-model semantics (copied from the pool
 *  service tests): the warming/promote primitives onNumberRegistered exercises. */
function makeFakeRepo(): PoolNumbersRepo & { store: Map<string, PoolNumberItem> } {
  const store = new Map<string, PoolNumberItem>();
  const SENTINEL = '0000-00-00T00:00:00.000Z';
  return {
    store,
    async get(poolNumber) {
      return store.get(poolNumber);
    },
    async create(input) {
      const now = new Date().toISOString();
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: 'active',
        quarantine_until: SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        ...(input.burn.length > 0 && { burned_phones: new Set(input.burn) }),
        ...(input.tag !== undefined && { placement_tag: input.tag }),
        provisioned_at: now,
      };
      store.set(item.poolNumber, item);
      return item;
    },
    async listActive() {
      return [...store.values()].filter((i) => i.lifecycle_state === 'active');
    },
    async listByState(state) {
      return [...store.values()].filter((i) => i.lifecycle_state === state);
    },
    async burnClaim(poolNumber, phones, tag) {
      if (phones.length === 0) return undefined;
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'active') return undefined;
      const burned =
        item.burned_phones instanceof Set ? item.burned_phones : new Set(item.burned_phones ?? []);
      if (phones.some((p) => burned.has(p))) return undefined;
      for (const p of phones) burned.add(p);
      item.burned_phones = burned;
      if (tag !== undefined) item.placement_tag = tag;
      return item;
    },
    async noteGroupClosed(poolNumber, closedAt) {
      const item = store.get(poolNumber);
      if (!item) return;
      const existing = item.last_group_closed_at;
      if (existing === undefined || existing < closedAt) item.last_group_closed_at = closedAt;
    },
    async beginRelease(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'active') return undefined;
      item.lifecycle_state = 'releasing';
      return item;
    },
    async abortRelease(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'releasing') return undefined;
      item.lifecycle_state = 'active';
      return item;
    },
    async releaseNumber(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'releasing') return undefined;
      item.lifecycle_state = 'released';
      item.released_at = new Date().toISOString();
      return item;
    },
    async createWarming(input) {
      const now = new Date().toISOString();
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: 'warming',
        quarantine_until: SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        sid: input.sid,
        warming_started_at: now,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        ...(input.tag !== undefined && { placement_tag: input.tag }),
        ...(input.conversationId !== undefined && {
          pending_conversation_id: input.conversationId,
        }),
        provisioned_at: now,
      };
      store.set(item.poolNumber, item);
      return item;
    },
    async promoteToActive(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'warming') return false;
      item.lifecycle_state = 'active';
      delete item.warming_started_at; // pending_conversation_id left intact
      return true;
    },
    async listWarming() {
      return [...store.values()].filter((i) => i.lifecycle_state === 'warming');
    },
    async findWarmingBySid(sid) {
      return [...store.values()].find((i) => i.lifecycle_state === 'warming' && i.sid === sid);
    },
    async countFreshSpares() {
      return [...store.values()].filter((i) => {
        if (i.lifecycle_state !== 'active') return false;
        const burned = i.burned_phones;
        const burnedCount =
          burned instanceof Set ? burned.size : Array.isArray(burned) ? burned.length : 0;
        return burnedCount === 0 && i.pending_conversation_id === undefined;
      }).length;
    },
    async countWarming() {
      return [...store.values()].filter((i) => i.lifecycle_state === 'warming').length;
    },
    async findByPendingConversationId(conversationId) {
      return [...store.values()].filter(
        (i) =>
          (i.lifecycle_state === 'warming' || i.lifecycle_state === 'active') &&
          i.pending_conversation_id === conversationId,
      );
    },
    async clearPendingConversation(poolNumber) {
      const item = store.get(poolNumber);
      if (item) delete item.pending_conversation_id;
    },
  };
}

/**
 * Minimal service config: onNumberRegistered reads only messagingDriver (source
 * tag) and twilioMessagingServiceSid (the optional mismatch sanity-check, left
 * undefined so it never fires here). adapter + conversationsRepo are never
 * touched by onNumberRegistered, so stubs are safe.
 */
function makeServiceConfig(): AppConfig {
  return {
    messagingDriver: 'console',
    relayLiveProvisioning: true,
    relayNumberReleaseEnabled: false,
    // Typed explicitly: a bare [] infers never[], which is NOT comparable to
    // AppConfig's string[] and makes tsc reject this `as AppConfig` cast.
    relayPreferredAreaCodes: [] as string[],
  } as AppConfig;
}

function makeService(repo: PoolNumbersRepo): PoolNumbersService {
  return createPoolNumbersService({
    poolNumbersRepo: repo,
    adapter: {} as unknown as MessagingAdapter,
    conversationsRepo: {} as unknown as ConversationsRepo,
    logger,
    config: makeServiceConfig(),
  });
}

async function seedWarming(repo: PoolNumbersRepo, conversationId?: string): Promise<void> {
  await repo.createWarming({
    poolNumber: WARMING_NUMBER,
    sid: WARMING_SID,
    voiceCapable: true,
    smsCapable: true,
    provisionedVia: 'console',
    ...(conversationId !== undefined && { conversationId }),
  });
}

describe('POST /webhooks/twilio/events - Event Streams registration promotion', () => {
  let captured: Array<{ jobName: string; payload: unknown }>;
  let queue: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    captured = [];
    queue = new InProcessOutboundQueueAdapter({
      dispatch: async (raw) => {
        const e = raw as { jobName: string; payload: unknown };
        captured.push({ jobName: e.jobName, payload: e.payload });
      },
    });
    configureOutboundQueue(queue);
  });

  afterEach(() => {
    _resetForTests();
  });

  it('promotes a warming number whose PN SID matches a registration event (200)', async () => {
    const repo = makeFakeRepo();
    await seedWarming(repo);
    const { app } = makeWebhookHarness({ poolNumbersService: makeService(repo) });

    const res = await postEvents(app, [
      registrationEvent({ phonenumbersid: WARMING_SID, phonenumber: '15550009001', messagingservicesid: MG_SID }),
    ]);

    expect(res.status).toBe(200);
    expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('active');
    const active = await repo.listActive();
    expect(active.map((r) => r.poolNumber)).toContain(WARMING_NUMBER);
    await queue.settle();
    expect(captured).toHaveLength(0); // no earmark -> no relay.numberReady
  });

  it('emitNumberRegistered(app, {phoneNumber, phoneNumberSid}) drives a warming number to active', async () => {
    // The shared convenience helper the T12 e2e-support + fake-twilio's
    // /control/register-number mirror: one PN-sid-correlated batch, one promotion.
    const repo = makeFakeRepo();
    await seedWarming(repo);
    const { app } = makeWebhookHarness({ poolNumbersService: makeService(repo) });

    const res = await emitNumberRegistered(app, {
      phoneNumber: '15550009001',
      phoneNumberSid: WARMING_SID,
      messagingServiceSid: MG_SID,
    });

    expect(res.status).toBe(200);
    expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('active');
  });

  it('ignores a registration event whose PN SID matches no warming record (200, nothing promoted)', async () => {
    const repo = makeFakeRepo();
    await seedWarming(repo);
    const { app } = makeWebhookHarness({ poolNumbersService: makeService(repo) });

    const res = await postEvents(app, [registrationEvent({ phonenumbersid: 'PNunknown0000000000000000000000000' })]);

    expect(res.status).toBe(200);
    expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('warming'); // untouched
  });

  it('ignores a non-registration event type (200)', async () => {
    const repo = makeFakeRepo();
    await seedWarming(repo);
    const { app } = makeWebhookHarness({ poolNumbersService: makeService(repo) });

    const res = await postEvents(app, [
      registrationEvent({
        phonenumbersid: WARMING_SID,
        type: 'com.twilio.messaging.compliance.number-registration.pending',
      }),
    ]);

    expect(res.status).toBe(200);
    expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('warming');
  });

  it('logs but does not promote on a de-registration event (200)', async () => {
    const repo = makeFakeRepo();
    await seedWarming(repo);
    const { app } = makeWebhookHarness({ poolNumbersService: makeService(repo) });

    const res = await postEvents(app, [registrationEvent({ phonenumbersid: WARMING_SID, type: DEREG_TYPE })]);

    expect(res.status).toBe(200);
    expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('warming');
  });

  it('enqueues relay.numberReady {conversationId, poolNumber} when the promoted record was earmarked', async () => {
    const repo = makeFakeRepo();
    await seedWarming(repo, 'conv-connecting-1');
    const { app } = makeWebhookHarness({ poolNumbersService: makeService(repo) });

    const res = await postEvents(app, [
      registrationEvent({ phonenumbersid: WARMING_SID, messagingservicesid: MG_SID }),
    ]);

    expect(res.status).toBe(200);
    expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('active');
    await queue.settle();
    expect(captured).toContainEqual({
      jobName: 'relay.numberReady',
      payload: { conversationId: 'conv-connecting-1', poolNumber: WARMING_NUMBER },
    });
  });

  it('loops the batch (does not index [0]) - promotes a later element too', async () => {
    const repo = makeFakeRepo();
    await seedWarming(repo);
    const { app } = makeWebhookHarness({ poolNumbersService: makeService(repo) });

    const res = await postEvents(app, [
      registrationEvent({ phonenumbersid: 'PNother0000000000000000000000000000', type: DEREG_TYPE }),
      registrationEvent({ phonenumbersid: WARMING_SID, messagingservicesid: MG_SID }),
    ]);

    expect(res.status).toBe(200);
    expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('active');
  });

  describe('auth (shared secret configured)', () => {
    const SECRET = 'events-shared-secret-xyz';
    const basic = (user: string, pass: string): string =>
      `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

    it('rejects with 403 when the Authorization header is absent', async () => {
      const repo = makeFakeRepo();
      await seedWarming(repo);
      const { app } = makeWebhookHarness({
        poolNumbersService: makeService(repo),
        env: { TWILIO_EVENTS_WEBHOOK_SECRET: SECRET },
      });

      const res = await postEvents(app, [registrationEvent({ phonenumbersid: WARMING_SID })]);

      expect(res.status).toBe(403);
      expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('warming'); // never processed
    });

    it('rejects with 403 on a wrong shared secret', async () => {
      const repo = makeFakeRepo();
      await seedWarming(repo);
      const { app } = makeWebhookHarness({
        poolNumbersService: makeService(repo),
        env: { TWILIO_EVENTS_WEBHOOK_SECRET: SECRET },
      });

      const res = await postEvents(app, [registrationEvent({ phonenumbersid: WARMING_SID })], {
        authorization: basic('twilio', 'WRONG-secret'),
      });

      expect(res.status).toBe(403);
      expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('warming');
    });

    it('processes the batch when the Basic-auth password matches the secret', async () => {
      const repo = makeFakeRepo();
      await seedWarming(repo);
      const { app } = makeWebhookHarness({
        poolNumbersService: makeService(repo),
        env: { TWILIO_EVENTS_WEBHOOK_SECRET: SECRET },
      });

      const res = await postEvents(app, [registrationEvent({ phonenumbersid: WARMING_SID, messagingservicesid: MG_SID })], {
        authorization: basic('twilio', SECRET),
      });

      expect(res.status).toBe(200);
      expect(repo.store.get(WARMING_NUMBER)?.lifecycle_state).toBe('active');
    });
  });
});
