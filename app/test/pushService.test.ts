// M1.4 unit tests: services/pushService.ts — send to all of a user's devices,
// prune the Gone (404/410) ones, and the no-VAPID no-op. The web-push adapter
// is FAKED (a typed WebPushAdapter) so no network/VAPID crypto runs; the
// usersRepo is the in-memory fake from authSession.
//
// PII assertion: the service must never put a payload BODY in a log line — only
// userId + kind + counts.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createPushService } from '../src/services/pushService.js';
import type { PushSubscription, SendOutcome, WebPushAdapter } from '../src/adapters/webPush.js';
import type { PushSubscriptionRecord, UsersRepo } from '../src/repos/usersRepo.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_USER } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const VAPID_ENV = {
  NODE_ENV: 'test',
  VAPID_PUBLIC_KEY: 'BPublicKeyPlaceholderForTestsOnly',
  VAPID_PRIVATE_KEY: 'privateKeyPlaceholderForTestsOnly',
  VAPID_SUBJECT: 'mailto:ops@housingchoice.org',
} as NodeJS.ProcessEnv;

function sub(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: `p256-${endpoint}`, auth: `auth-${endpoint}` } };
}

/** A fake adapter whose per-endpoint outcome is scripted. */
function fakeAdapter(
  outcomes: Record<string, SendOutcome | 'throw'>,
): { adapter: WebPushAdapter; sentTo: string[] } {
  const sentTo: string[] = [];
  return {
    sentTo,
    adapter: {
      async sendToSubscription(subscription) {
        sentTo.push(subscription.endpoint);
        const outcome = outcomes[subscription.endpoint] ?? { result: 'sent', statusCode: 201 };
        if (outcome === 'throw') throw new Error('boom (transient 500)');
        return outcome;
      },
    },
  };
}

describe('pushService.sendToUser', () => {
  it('sends to every subscription a user has and tallies them', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [
          { ...sub('https://fcm.googleapis.com/fcm/send/a'), created_at: '2026-06-01T00:00:00.000Z' },
          { ...sub('https://fcm.googleapis.com/fcm/send/b'), created_at: '2026-06-02T00:00:00.000Z' },
        ],
      }),
    ]);
    const { adapter, sentTo } = fakeAdapter({});
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'missed_call',
      payload: { title: 'x', body: 'Keisha Jones — 123 Main St' },
    });

    expect(result).toEqual({ configured: true, attempted: 2, sent: 2, pruned: 0, failed: 0 });
    expect(sentTo.sort()).toEqual(['https://fcm.googleapis.com/fcm/send/a', 'https://fcm.googleapis.com/fcm/send/b']);
  });

  it('forwards ttlSeconds to the adapter, and sends NO options when unset', async () => {
    // TTL is the stale-pre-ring guard (observed 2026-08-16: Android deferred a
    // high-urgency push under doze, then flushed it MINUTES after its call
    // ended). Time-sensitive kinds declare a TTL; everything else must keep
    // web-push's late-is-better-than-never default, so unset must reach the
    // adapter as undefined - not as { ttlSeconds: undefined }.
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [
          { ...sub('https://fcm.googleapis.com/fcm/send/a'), created_at: '2026-06-01T00:00:00.000Z' },
        ],
      }),
    ]);
    const seenOptions: unknown[] = [];
    const adapter: WebPushAdapter = {
      async sendToSubscription(_subscription, _payload, options) {
        seenOptions.push(options);
        return { result: 'sent', statusCode: 201 };
      },
    };
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'pre_ring',
      payload: { title: 'Incoming call' },
      ttlSeconds: 60,
    });
    await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'missed_call',
      payload: { title: 'Missed call' },
    });

    expect(seenOptions).toEqual([{ ttlSeconds: 60 }, undefined]);
  });

  it('prunes Gone (404/410) subscriptions from the user record', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [
          { ...sub('https://fcm.googleapis.com/fcm/send/live'), created_at: '2026-06-01T00:00:00.000Z' },
          { ...sub('https://fcm.googleapis.com/fcm/send/dead'), created_at: '2026-06-02T00:00:00.000Z' },
        ],
      }),
    ]);
    const { adapter } = fakeAdapter({
      'https://fcm.googleapis.com/fcm/send/dead': { result: 'gone' },
    });
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'test',
      payload: { title: 'x' },
    });

    expect(result).toMatchObject({ sent: 1, pruned: 1, failed: 0 });
    // The dead subscription is removed; the live one remains.
    const user = fakeUsers.users.get(TEST_SESSION_USER.userId);
    expect(user?.push_subscriptions?.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/live']);
  });

  it('keeps (does not prune) a subscription on a transient send failure', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [{ ...sub('https://fcm.googleapis.com/fcm/send/x'), created_at: '2026-06-01T00:00:00.000Z' }],
      }),
    ]);
    const { adapter } = fakeAdapter({ 'https://fcm.googleapis.com/fcm/send/x': 'throw' });
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'test',
      payload: { title: 'x' },
    });

    expect(result).toMatchObject({ sent: 0, pruned: 0, failed: 1 });
    // Still present — a transient failure is not a prune signal.
    expect(fakeUsers.users.get(TEST_SESSION_USER.userId)?.push_subscriptions).toHaveLength(1);
  });

  it('NEVER sends to a stored endpoint whose host is not allowlisted — prunes it instead (C1 defense in depth)', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [
          // A bad endpoint that predates the subscribe-time guard (e.g. cloud
          // metadata) — must never be POSTed to.
          { ...sub('https://169.254.169.254/x'), created_at: '2026-06-01T00:00:00.000Z' },
          { ...sub('https://fcm.googleapis.com/fcm/send/good'), created_at: '2026-06-02T00:00:00.000Z' },
        ],
      }),
    ]);
    const { adapter, sentTo } = fakeAdapter({});
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'missed_call',
      payload: { title: 'x' },
    });

    // The disallowed endpoint was pruned, NOT sent; the good one was sent.
    expect(sentTo).toEqual(['https://fcm.googleapis.com/fcm/send/good']);
    expect(result).toMatchObject({ sent: 1, pruned: 1, failed: 0 });
    expect(
      fakeUsers.users.get(TEST_SESSION_USER.userId)?.push_subscriptions?.map((s) => s.endpoint),
    ).toEqual(['https://fcm.googleapis.com/fcm/send/good']);
  });

  it('is a no-op (configured:false) when VAPID is unset, never throwing', async () => {
    const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [{ ...sub('https://fcm.googleapis.com/fcm/send/x'), created_at: '2026-06-01T00:00:00.000Z' }],
      }),
    ]);
    const capture = createLogCapture();
    // No adapter injected: createWebPushAdapter returns undefined when off.
    const service = createPushService({
      config,
      usersRepo: fakeUsers.repo,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'missed_call',
      payload: { title: 'x' },
    });

    expect(result).toEqual({ configured: false, attempted: 0, sent: 0, pruned: 0, failed: 0 });
    // WARN (not ERROR) so the orphan/error-log alarm never trips on a known
    // unconfigured state.
    expect(capture.atLevel(50)).toHaveLength(0);
    expect(capture.atLevel(40).some((l) => /push not configured/.test(String(l['msg'])))).toBe(true);
  });

  it('returns zeroed tally when the user has no subscriptions', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([testUserItem()]); // no push_subscriptions
    const { adapter, sentTo } = fakeAdapter({});
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'test',
      payload: { title: 'x' },
    });
    expect(result).toEqual({ configured: true, attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(sentTo).toEqual([]);
  });

  it('NEVER logs the payload body (PII posture)', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [{ ...sub('https://fcm.googleapis.com/fcm/send/a'), created_at: '2026-06-01T00:00:00.000Z' }],
      }),
    ]);
    const capture = createLogCapture();
    const { adapter } = fakeAdapter({});
    const service = createPushService({
      config,
      usersRepo: fakeUsers.repo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'missed_call',
      payload: { title: 'Notification', body: 'Keisha Jones — tenant, 123 Main St' },
    });

    const serialized = JSON.stringify(capture.lines);
    expect(serialized).not.toContain('Keisha Jones');
    expect(serialized).not.toContain('123 Main St');
    // The non-PII kind IS logged.
    expect(serialized).toContain('missed_call');
  });

  it('a transient device failure logs the error OBJECT and pushStatusCode', async () => {
    // Log-hygiene spec 6.2. This WARN used to carry `err: <string>`, throwing
    // away the push service's status code - the one field that separates a 413
    // payload-too-large from a 500 blip. The safe serializer makes the OBJECT
    // loggable, and the code is ALSO lifted to a top-level field for cheap
    // querying: pushStatusCode, NOT statusCode, because the request logger owns
    // top-level statusCode for HTTP response statuses.
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [
          { ...sub('https://fcm.googleapis.com/fcm/send/a'), created_at: '2026-06-01T00:00:00.000Z' },
        ],
      }),
    ]);
    const capture = createLogCapture();
    const adapter: WebPushAdapter = {
      async sendToSubscription() {
        throw Object.assign(new Error('Received unexpected response code'), { statusCode: 413 });
      },
    };
    const service = createPushService({
      config,
      usersRepo: fakeUsers.repo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'missed_call',
      payload: { title: 'x' },
    });

    expect(result).toMatchObject({ sent: 0, pruned: 0, failed: 1 });
    const warn = capture.atLevel(40).find((l) => /send to one device failed/.test(String(l['msg'])));
    expect(warn).toBeDefined();
    // FIELDS, never object identity: the serializer transforms Error values on
    // their way to the line, so the captured `err` is the allowlist projection.
    const err = warn!['err'] as Record<string, unknown>;
    expect(err['type']).toBe('Error');
    expect(err['statusCode']).toBe(413);
    expect(String(err['message'])).toContain('Received unexpected response code');
    expect(warn!['pushStatusCode']).toBe(413);
  });

  it('a failed Gone-prune logs the error under err with its message intact', async () => {
    // The sibling conversion: the prune-write WARN carried the message string
    // only, so a DynamoDB fault arrived with no type, no code and no stack.
    const config = loadConfig(VAPID_ENV);
    const usersRepo = {
      async findById(userId: string) {
        return {
          userId,
          email: `${userId}@example.com`,
          role: 'admin',
          status: 'active',
          created_at: '2026-08-16T00:00:00.000Z',
          push_subscriptions: [
            {
              ...sub('https://fcm.googleapis.com/fcm/send/dead'),
              created_at: '2026-06-01T00:00:00.000Z',
            },
          ],
        };
      },
      async removePushSubscription() {
        throw new Error('prune-boom');
      },
    } as unknown as UsersRepo;
    const capture = createLogCapture();
    const { adapter } = fakeAdapter({
      'https://fcm.googleapis.com/fcm/send/dead': { result: 'gone' },
    });
    const service = createPushService({
      config,
      usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'test',
      payload: { title: 'x' },
    });

    expect(result).toMatchObject({ sent: 0, pruned: 0, failed: 1 });
    const warn = capture
      .atLevel(40)
      .find((l) => /pruning a Gone endpoint failed/.test(String(l['msg'])));
    expect(warn).toBeDefined();
    const err = warn!['err'] as Record<string, unknown>;
    expect(err['type']).toBe('Error');
    expect(err['message']).toBe('prune-boom');
  });
});

/** An allowlisted (FCM) push endpoint for the named device. */
function ep(name: string): string {
  return `https://fcm.googleapis.com/fcm/send/${name}`;
}

/**
 * A stored endpoint whose host is NOT an allowlisted push vendor (cloud
 * metadata). The shared loop prunes it BEFORE any POST, so it is how a test
 * reaches the allowlist prune WRITE.
 */
const BAD_HOST_ENDPOINT = 'https://169.254.169.254/x';

/**
 * A stored subscription record whose `endpoint` is an accessor that THROWS.
 * The shared per-device loop reads it in `isAllowedPushEndpoint(record.endpoint)`
 * BEFORE entering any per-device try, so this is the one fault shape that can
 * still reject out of sendToDevices - i.e. the only way to exercise sendToAll's
 * per-USER catch now that every per-device fault is isolated.
 */
function unreadableSubscription(): PushSubscriptionRecord {
  const record = {
    keys: { p256dh: 'p256-hostile', auth: 'auth-hostile' },
    created_at: '2026-08-16T00:00:00.000Z',
  };
  Object.defineProperty(record, 'endpoint', {
    enumerable: true,
    get(): string {
      throw new Error('unreadable subscription record');
    },
  });
  return record as unknown as PushSubscriptionRecord;
}

/**
 * A purpose-made multi-user UsersRepo fake for the fan-out tests. It exists
 * (rather than reusing makeFakeUsersRepo, which IS multi-user) because these
 * tests need two things that helper does not offer: a listAll CALL COUNTER
 * (the TTL cache asserts "did not re-scan") and failure injection on listAll
 * and on the prune write. Only the three members pushService touches are
 * implemented, so the whole literal is cast once.
 *
 * removePushSubscription bumps findByIdCalls on purpose: the real repo re-reads
 * the user inside that write (usersRepo.ts:613), so the "no per-user read on
 * the SEND path" assertion means what the spec says it means.
 */
function makeBroadcastWorld(userSpecs: { userId: string; endpoints: string[] }[]) {
  const state = new Map(
    userSpecs.map((u) => [
      u.userId,
      u.endpoints.map((endpoint) => ({
        endpoint,
        keys: { p256dh: `p256-${endpoint}`, auth: `auth-${endpoint}` },
        created_at: '2026-08-16T00:00:00.000Z',
      })),
    ]),
  );
  let listAllCalls = 0;
  let findByIdCalls = 0;
  let failListAll = false;
  let failRemoveFor: string | undefined;
  let failRemoveEndpoint: string | undefined;
  const usersRepo = {
    async listAll() {
      listAllCalls += 1;
      if (failListAll) throw new Error('scan down');
      return userSpecs.map((u) => ({
        userId: u.userId,
        email: `${u.userId}@example.com`,
        role: 'admin',
        status: 'active',
        created_at: '2026-08-16T00:00:00.000Z',
        ...(state.get(u.userId)!.length > 0 && {
          push_subscriptions: [...state.get(u.userId)!],
        }),
      }));
    },
    async findById(userId: string) {
      findByIdCalls += 1;
      const subs = state.get(userId);
      if (subs === undefined) return undefined;
      return {
        userId,
        email: `${userId}@example.com`,
        role: 'admin',
        status: 'active',
        created_at: '2026-08-16T00:00:00.000Z',
        push_subscriptions: [...subs],
      };
    },
    async removePushSubscription(userId: string, endpoint: string) {
      findByIdCalls += 1;
      if (
        failRemoveFor === userId &&
        (failRemoveEndpoint === undefined || failRemoveEndpoint === endpoint)
      ) {
        throw new Error('prune write failed');
      }
      state.set(
        userId,
        (state.get(userId) ?? []).filter((s) => s.endpoint !== endpoint),
      );
    },
  } as unknown as UsersRepo;
  return {
    usersRepo,
    state,
    calls: {
      get listAll() {
        return listAllCalls;
      },
      get findById() {
        return findByIdCalls;
      },
    },
    setFailListAll(v: boolean) {
      failListAll = v;
    },
    /**
     * Make the prune write (removePushSubscription) throw for ONE user - and,
     * when `endpoint` is given, for only that ONE of that user's endpoints, so
     * a test can prune one device successfully and fail the next.
     */
    setFailRemoveFor(userId: string | undefined, endpoint?: string) {
      failRemoveFor = userId;
      failRemoveEndpoint = endpoint;
    },
  };
}

describe('pushService.sendToAll', () => {
  it('fans out to every user with subscriptions and aggregates the tally', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([
      { userId: 'usr_a', endpoints: [ep('a1'), ep('a2')] },
      { userId: 'usr_b', endpoints: [ep('b1')] },
      { userId: 'usr_c', endpoints: [] },
    ]);
    const { adapter, sentTo } = fakeAdapter({});
    const service = createPushService({ config, usersRepo: world.usersRepo, adapter });

    const result = await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    // users counts only the users that HAD a subscription (usr_c is skipped).
    expect(result).toEqual({ configured: true, users: 2, attempted: 3, sent: 3, pruned: 0, failed: 0 });
    expect(sentTo.slice().sort()).toEqual([ep('a1'), ep('a2'), ep('b1')].sort());
  });

  it('never calls findById on a fan-out with no Gone endpoints', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([
      { userId: 'usr_a', endpoints: [ep('a1')] },
      { userId: 'usr_b', endpoints: [ep('b1')] },
    ]);
    const { adapter } = fakeAdapter({});
    const service = createPushService({ config, usersRepo: world.usersRepo, adapter });

    await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    // listAll already returns full items; the SEND path must not re-read users.
    expect(world.calls.listAll).toBe(1);
    expect(world.calls.findById).toBe(0);
  });

  it('skips zero-subscription users with no log line', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([
      { userId: 'usr_has', endpoints: [ep('a1')] },
      { userId: 'usr_none', endpoints: [] },
    ]);
    const capture = createLogCapture();
    const { adapter } = fakeAdapter({});
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    // Subscription PRESENCE is the filter: a user with none costs no I/O and
    // no log noise.
    expect(JSON.stringify(capture.lines)).not.toContain('usr_none');
  });

  it('emits ONE aggregate info line per notification (kind + counts, never payload)', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([
      { userId: 'usr_a', endpoints: [ep('a1'), ep('a2')] },
      { userId: 'usr_b', endpoints: [ep('b1')] },
    ]);
    const capture = createLogCapture();
    const { adapter } = fakeAdapter({});
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    await service.sendToAll({
      kind: 'message',
      payload: { title: 'Keisha Jones', body: '123 Main St' },
    });

    const infoLines = capture.atLevel(30);
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toMatchObject({
      msg: 'push: sendToAll complete',
      kind: 'message',
      users: 2,
      attempted: 3,
      sent: 3,
      pruned: 0,
      failed: 0,
    });
    const serialized = JSON.stringify(capture.lines);
    expect(serialized).not.toContain('Keisha Jones');
    expect(serialized).not.toContain('123 Main St');
  });

  it('isolates a failing DEVICE: an adapter throw is tallied and the next user still gets sent', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([
      { userId: 'usr_a', endpoints: [ep('a1')] },
      { userId: 'usr_b', endpoints: [ep('b1')] },
    ]);
    const { adapter, sentTo } = fakeAdapter({ [ep('a1')]: 'throw' });
    const service = createPushService({ config, usersRepo: world.usersRepo, adapter });

    const result = await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    expect(result).toEqual({ configured: true, users: 2, attempted: 2, sent: 1, pruned: 0, failed: 1 });
    // The adapter was still ASKED for both; only B succeeded.
    expect(sentTo).toEqual([ep('a1'), ep('b1')]);
    // A transient failure is never a prune signal.
    expect(world.state.get('usr_a')!.map((s) => s.endpoint)).toEqual([ep('a1')]);
  });

  it('isolates a failing PRUNE WRITE: later devices of the SAME user still send, and the tally is honest', async () => {
    const config = loadConfig(VAPID_ENV);
    // A THREE-device user is the boundary the one-device case cannot see: a
    // prune write that rejects must be booked as that ONE device's failure,
    // never as a whole-user failure that discards the devices already
    // delivered and skips the ones after it.
    const world = makeBroadcastWorld([
      { userId: 'usr_a', endpoints: [ep('gone'), BAD_HOST_ENDPOINT, ep('live')] },
      { userId: 'usr_b', endpoints: [ep('b1')] },
    ]);
    // Only the ALLOWLIST prune (the non-vendor host) fails; the Gone prune
    // before it succeeds.
    world.setFailRemoveFor('usr_a', BAD_HOST_ENDPOINT);
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({ [ep('gone')]: { result: 'gone' } });
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    // gone -> pruned, bad host -> failed (prune write rejected), live -> sent,
    // and usr_b is untouched by any of it.
    expect(result).toEqual({ configured: true, users: 2, attempted: 4, sent: 2, pruned: 1, failed: 1 });
    // The device AFTER the failing prune was still attempted, and the one
    // before it was really delivered.
    expect(sentTo).toEqual([ep('gone'), ep('live'), ep('b1')]);
    // The endpoint whose prune write failed is kept (nothing proves it dead).
    expect(world.state.get('usr_a')!.map((s) => s.endpoint)).toEqual([BAD_HOST_ENDPOINT, ep('live')]);
    // One device failing is a per-DEVICE warn, not a whole-user abort.
    expect(
      capture.atLevel(40).some((l) => /broadcast to one user failed/.test(String(l['msg']))),
    ).toBe(false);
  });

  it('keeps endpoints pruned BEFORE a failing prune write out of the cached item', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([
      { userId: 'usr_a', endpoints: [ep('gone'), BAD_HOST_ENDPOINT, ep('live')] },
    ]);
    world.setFailRemoveFor('usr_a', BAD_HOST_ENDPOINT);
    const { adapter, sentTo } = fakeAdapter({ [ep('gone')]: { result: 'gone' } });
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    await service.sendToAll(note);

    sentTo.length = 0;
    t = 30_000;
    const second = await service.sendToAll(note);

    // Same cached list (no re-scan), and the endpoint pruned on the first pass
    // is NOT re-attempted for the rest of the TTL even though a later device's
    // prune write failed in the same loop.
    expect(world.calls.listAll).toBe(1);
    expect(sentTo).toEqual([ep('live')]);
    expect(second).toEqual({ configured: true, users: 1, attempted: 2, sent: 1, pruned: 0, failed: 1 });
  });

  it('fans out to the STALE cached list when the refresh scan fails, and retries the scan next time', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({});
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(1);

    // TTL lapses and the refresh scan is down: a 60s-old list is still in hand,
    // so the broadcast must reach it rather than nobody.
    sentTo.length = 0;
    t = 60_000;
    world.setFailListAll(true);
    const stale = await service.sendToAll(note);

    expect(world.calls.listAll).toBe(2);
    expect(stale).toEqual({ configured: true, users: 1, attempted: 1, sent: 1, pruned: 0, failed: 0 });
    expect(sentTo).toEqual([ep('a1')]);
    // WARN, not ERROR: serving a stale list is degraded, not a failure.
    expect(capture.atLevel(50)).toHaveLength(0);
    expect(
      capture.atLevel(40).some((l) => /refreshing the user list failed/.test(String(l['msg']))),
    ).toBe(true);

    // fetchedAt was left untouched, so the scan IS retried - but the 30s
    // attempt floor (log-hygiene 6.1) governs when: a send at t=60_000 would be
    // floored, so the retry lands on the first send past 60_000 + 30_000.
    world.setFailListAll(false);
    t = 91_000;
    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(3);
  });

  it('STOPS serving the stale list once it reaches 5x the TTL: ERROR, and nobody is sent', async () => {
    // The fallback is bounded by the AGE OF THE SERVED LIST. Inside the bound a
    // failed refresh is a blip and the cached list is still worth serving. Past
    // it the list is a liability: a user whose only device was Gone-pruned and
    // who then re-subscribed is invisible in it, and an offboarded user's
    // device keeps receiving names and message text. So the fan-out gives up
    // exactly as spec 3.1 always said - ERROR, zeroed result, never a throw.
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({});
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    await service.sendToAll(note);
    world.setFailListAll(true);

    // One millisecond INSIDE the bound: still served, WARN only.
    sentTo.length = 0;
    t = 299_999;
    const inside = await service.sendToAll(note);
    expect(inside).toEqual({ configured: true, users: 1, attempted: 1, sent: 1, pruned: 0, failed: 0 });
    expect(sentTo).toEqual([ep('a1')]);
    expect(capture.atLevel(50)).toHaveLength(0);

    // PAST the bound - and past the 30s attempt floor (log-hygiene 6.1), so the
    // retry actually runs and its catch can reach the give-up arm. At t=300_000
    // the previous attempt is 1ms old, so the floor would skip the Scan
    // entirely and the ERROR below would never fire.
    sentTo.length = 0;
    t = 330_000;
    const past = await service.sendToAll(note);
    expect(past).toEqual({ configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(sentTo).toEqual([]);
    // What the error-log alarm sees (repo precedent 436c0388: a give-up site is
    // ERROR so it reaches the alarm), and NOT another cheerful stale WARN.
    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!['msg'])).toMatch(/listing users failed/);
    expect(String(errors[0]!['msg'])).toMatch(/too stale/);
  });

  it('isolates a failing USER: a fault the per-device loop cannot catch never aborts the fan-out', async () => {
    // The shared loop isolates every fault it can SEE, so the only way to reach
    // sendToAll's per-USER catch is a throw before the per-device try - here the
    // allowlist guard reading `record.endpoint`. Spec 3.1 requires per-user
    // isolation and spec 6 pins it; this test is what keeps that guard live
    // rather than merely present, and it records the pessimistic tally
    // (failed += subs.length) as a decision instead of an assumption.
    const config = loadConfig(VAPID_ENV);
    const usersRepo = {
      async listAll() {
        return [
          {
            userId: 'usr_bad',
            email: 'bad@example.com',
            role: 'admin',
            status: 'active',
            created_at: '2026-08-16T00:00:00.000Z',
            push_subscriptions: [unreadableSubscription()],
          },
          {
            userId: 'usr_good',
            email: 'good@example.com',
            role: 'admin',
            status: 'active',
            created_at: '2026-08-16T00:00:00.000Z',
            push_subscriptions: [
              {
                endpoint: ep('g1'),
                keys: { p256dh: 'p256-g1', auth: 'auth-g1' },
                created_at: '2026-08-16T00:00:00.000Z',
              },
            ],
          },
        ];
      },
    } as unknown as UsersRepo;
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({});
    const service = createPushService({
      config,
      usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    // The bad user is booked pessimistically (all of their devices) and the
    // fan-out CONTINUES to the next user.
    expect(result).toEqual({ configured: true, users: 2, attempted: 2, sent: 1, pruned: 0, failed: 1 });
    expect(sentTo).toEqual([ep('g1')]);
    expect(
      capture.atLevel(40).some((l) => /broadcast to one user failed/.test(String(l['msg']))),
    ).toBe(true);
  });

  it('a failing GONE prune write logs a PRUNE failure, never a transient SEND failure', async () => {
    // The send answered correctly - the device is definitively dead - and the
    // fault is entirely ours (DynamoDB). Reporting it as a transient send
    // failure sends an operator after FCM instead of the repo write that
    // actually broke, while the dead endpoint is re-POSTed on every message.
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('gone'), ep('live')] }]);
    world.setFailRemoveFor('usr_a', ep('gone'));
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({ [ep('gone')]: { result: 'gone' } });
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    // Counted the same way wave 1 counted the allowlist prune write: ONE device
    // failed, nothing pruned, and the device after it still sent.
    expect(result).toEqual({ configured: true, users: 1, attempted: 2, sent: 1, pruned: 0, failed: 1 });
    expect(sentTo).toEqual([ep('gone'), ep('live')]);
    const warns = capture.atLevel(40).map((l) => String(l['msg']));
    expect(warns.some((m) => /pruning a Gone endpoint failed/.test(m))).toBe(true);
    expect(warns.some((m) => /send to one device failed/.test(m))).toBe(false);
    // Nothing proved the write happened, so the subscription stays.
    expect(world.state.get('usr_a')!.map((s) => s.endpoint)).toEqual([ep('gone'), ep('live')]);
  });

  it('returns a zeroed result and logs error when listAll throws with NO cache to fall back on', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    // Failing from the very first send, so there has never been a successful
    // list: this is the branch where dropping the broadcast is the only option.
    world.setFailListAll(true);
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({});
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    expect(result).toEqual({ configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(sentTo).toEqual([]);
    expect(capture.atLevel(50).some((l) => /listing users failed/.test(String(l['msg'])))).toBe(true);
  });

  it('is a single-log no-op when VAPID is unconfigured', async () => {
    const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const world = makeBroadcastWorld([
      { userId: 'usr_a', endpoints: [ep('a1')] },
      { userId: 'usr_b', endpoints: [ep('b1')] },
    ]);
    const capture = createLogCapture();
    // No adapter injected: createWebPushAdapter returns undefined when off.
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });

    const result = await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    expect(result).toEqual({ configured: false, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 });
    // ONE line for the whole broadcast, never one per user, and WARN not ERROR.
    expect(capture.lines).toHaveLength(1);
    expect(capture.atLevel(50)).toHaveLength(0);
    expect(capture.atLevel(40).some((l) => /push not configured/.test(String(l['msg'])))).toBe(true);
    // The user list is not even read when push is off.
    expect(world.calls.listAll).toBe(0);
  });

  it('caches the user list for 60s: a second send does not re-scan', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    const { adapter } = fakeAdapter({});
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(1);

    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(1);

    t = 59_999;
    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(1);

    t = 60_000;
    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(2);
  });

  it('prunes a Gone endpoint from the repo AND does not re-attempt it within the TTL', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('live'), ep('dead')] }]);
    const { adapter, sentTo } = fakeAdapter({ [ep('dead')]: { result: 'gone' } });
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    const first = await service.sendToAll(note);
    expect(first).toEqual({ configured: true, users: 1, attempted: 2, sent: 1, pruned: 1, failed: 0 });
    expect(world.state.get('usr_a')!.map((s) => s.endpoint)).toEqual([ep('live')]);

    sentTo.length = 0;
    t = 30_000;
    const second = await service.sendToAll(note);

    // Same cached list, but the dead endpoint was dropped from the cached item
    // too - so it is never re-attempted.
    expect(world.calls.listAll).toBe(1);
    expect(sentTo).toEqual([ep('live')]);
    expect(second).toEqual({ configured: true, users: 1, attempted: 1, sent: 1, pruned: 0, failed: 0 });
  });

  it('passes undefined options when ttlSeconds is unset (message pushes have no TTL)', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1'), ep('a2')] }]);
    // The shared fakeAdapter drops options, so D9 needs the inline shape.
    const seenOptions: unknown[] = [];
    const adapter: WebPushAdapter = {
      async sendToSubscription(_subscription, _payload, options) {
        seenOptions.push(options);
        return { result: 'sent', statusCode: 201 };
      },
    };
    const service = createPushService({ config, usersRepo: world.usersRepo, adapter });

    await service.sendToAll({ kind: 'message', payload: { title: 'x' } });

    expect(seenOptions).toEqual([undefined, undefined]);
  });

  // Log-hygiene spec 6.1: the refresh ATTEMPT floor. Before it, a down Scan
  // produced one ERROR/WARN and one Scan attempt per INBOUND MESSAGE; now it is
  // one per ~30s window per instance. These cases assert BEHAVIOUR - listAll
  // call counts, returned tallies, and the ABSENCE of repeat warn/error lines -
  // never the new debug lines, which this capture (info level) cannot see.

  it('floors the refresh RETRY: a send inside the 30s window does not re-attempt listAll', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({});
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    await service.sendToAll(note);
    t = 60_000;
    world.setFailListAll(true);
    await service.sendToAll(note);

    // The FAILED attempt itself still opens the window with its stale-serve
    // WARN - the floor silences the sends that follow, not the first alarm.
    expect(world.calls.listAll).toBe(2);
    const warnsAfterTheFailure = capture.atLevel(40).length;
    expect(warnsAfterTheFailure).toBeGreaterThan(0);

    // 10s later the TTL is still lapsed, but the floor is not: no second Scan,
    // no second alarm line, and the cached list is still served.
    sentTo.length = 0;
    t = 70_000;
    const floored = await service.sendToAll(note);

    expect(world.calls.listAll).toBe(2);
    expect(floored).toEqual({
      configured: true,
      users: 1,
      attempted: 1,
      sent: 1,
      pruned: 0,
      failed: 0,
    });
    expect(sentTo).toEqual([ep('a1')]);
    expect(capture.atLevel(40)).toHaveLength(warnsAfterTheFailure);
    expect(capture.atLevel(50)).toHaveLength(0);
  });

  it('re-attempts listAll once the 30s floor has elapsed', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    const { adapter } = fakeAdapter({});
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    await service.sendToAll(note);
    t = 60_000;
    world.setFailListAll(true);
    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(2);

    // Inside the floor: skipped.
    t = 70_000;
    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(2);

    // 31s after the failed ATTEMPT (not after the last send): retried.
    world.setFailListAll(false);
    t = 91_000;
    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(3);
  });

  it('floors the repeat ERROR too when no list has ever been fetched', async () => {
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    world.setFailListAll(true);
    const capture = createLogCapture();
    const { adapter } = fakeAdapter({});
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    const first = await service.sendToAll(note);
    expect(first).toEqual({ configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(world.calls.listAll).toBe(1);
    expect(capture.atLevel(50)).toHaveLength(1);

    // The zeroed drop is UNCHANGED - what the floor removes is the second Scan
    // and the second ERROR (the line that used to fire per inbound message).
    t = 10_000;
    const second = await service.sendToAll(note);
    expect(second).toEqual({ configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(world.calls.listAll).toBe(1);
    expect(capture.atLevel(50)).toHaveLength(1);
  });

  it('never delays a refresh that follows a SUCCESSFUL one', async () => {
    // Non-regression guard: the floor is stamped only when an attempt FAILS,
    // so a successful one leaves no stamp at all and the 60s cache TTL is the
    // only thing deciding when the next Scan runs.
    const config = loadConfig(VAPID_ENV);
    const world = makeBroadcastWorld([{ userId: 'usr_a', endpoints: [ep('a1')] }]);
    const { adapter } = fakeAdapter({});
    let t = 0;
    const service = createPushService({
      config,
      usersRepo: world.usersRepo,
      adapter,
      now: () => t,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(1);

    t = 60_000;
    await service.sendToAll(note);
    expect(world.calls.listAll).toBe(2);
  });

  it('does NOT drop a second broadcast issued while the first COLD-START scan is in flight', async () => {
    // The floor was once stamped BEFORE `await users.listAll()`, which made it
    // fence in-flight attempts as well as failed ones. On a cold process the
    // second call then saw no cache AND a millisecond-old stamp, took the
    // floored arm, found nothing servable, and dropped the notification at
    // debug - invisible in both deployed envs, where LOG_LEVEL is info. The
    // window is the length of a users-table Scan and it opens on every process
    // start and every deploy, i.e. exactly when a burst of queued webhooks
    // lands. listAll is held on a gate here so both calls are provably inside
    // that window.
    const config = loadConfig(VAPID_ENV);
    let release: () => void = () => {};
    const scanInFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listAllCalls = 0;
    const usersRepo = {
      async listAll() {
        listAllCalls += 1;
        await scanInFlight;
        return [
          {
            userId: 'usr_a',
            email: 'usr_a@example.com',
            role: 'admin',
            status: 'active',
            created_at: '2026-08-16T00:00:00.000Z',
            push_subscriptions: [
              {
                endpoint: ep('a1'),
                keys: { p256dh: 'p256-a1', auth: 'auth-a1' },
                created_at: '2026-08-16T00:00:00.000Z',
              },
            ],
          },
        ];
      },
    } as unknown as UsersRepo;
    const capture = createLogCapture();
    const { adapter, sentTo } = fakeAdapter({});
    const service = createPushService({
      config,
      usersRepo,
      adapter,
      logger: createLogger({ level: 'info', destination: capture.stream }),
      now: () => 0,
    });
    const note = { kind: 'message', payload: { title: 'x' } };

    // Both issued before either can resolve: A suspends inside listAll, then B
    // runs its gate check with the cache still empty.
    const a = service.sendToAll(note);
    const b = service.sendToAll(note);
    release();
    const [resultA, resultB] = await Promise.all([a, b]);

    // Neither call is fenced by the other: each runs its own Scan (the
    // pre-floor behavior) and each fans out.
    expect(listAllCalls).toBe(2);
    expect(resultA).toMatchObject({ users: 1, attempted: 1, sent: 1 });
    expect(resultB).toMatchObject({ users: 1, attempted: 1, sent: 1 });
    expect(sentTo).toEqual([ep('a1'), ep('a1')]);
    // A dropped broadcast was silent; a delivered one raises nothing either.
    expect(capture.atLevel(40)).toHaveLength(0);
    expect(capture.atLevel(50)).toHaveLength(0);
  });
});
