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
          { ...sub('https://push.example/a'), created_at: '2026-06-01T00:00:00.000Z' },
          { ...sub('https://push.example/b'), created_at: '2026-06-02T00:00:00.000Z' },
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
    expect(sentTo.sort()).toEqual(['https://push.example/a', 'https://push.example/b']);
  });

  it('prunes Gone (404/410) subscriptions from the user record', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [
          { ...sub('https://push.example/live'), created_at: '2026-06-01T00:00:00.000Z' },
          { ...sub('https://push.example/dead'), created_at: '2026-06-02T00:00:00.000Z' },
        ],
      }),
    ]);
    const { adapter } = fakeAdapter({
      'https://push.example/dead': { result: 'gone' },
    });
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'test',
      payload: { title: 'x' },
    });

    expect(result).toMatchObject({ sent: 1, pruned: 1, failed: 0 });
    // The dead subscription is removed; the live one remains.
    const user = fakeUsers.users.get(TEST_SESSION_USER.userId);
    expect(user?.push_subscriptions?.map((s) => s.endpoint)).toEqual(['https://push.example/live']);
  });

  it('keeps (does not prune) a subscription on a transient send failure', async () => {
    const config = loadConfig(VAPID_ENV);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [{ ...sub('https://push.example/x'), created_at: '2026-06-01T00:00:00.000Z' }],
      }),
    ]);
    const { adapter } = fakeAdapter({ 'https://push.example/x': 'throw' });
    const service = createPushService({ config, usersRepo: fakeUsers.repo, adapter });

    const result = await service.sendToUser(TEST_SESSION_USER.userId, {
      kind: 'test',
      payload: { title: 'x' },
    });

    expect(result).toMatchObject({ sent: 0, pruned: 0, failed: 1 });
    // Still present — a transient failure is not a prune signal.
    expect(fakeUsers.users.get(TEST_SESSION_USER.userId)?.push_subscriptions).toHaveLength(1);
  });

  it('is a no-op (configured:false) when VAPID is unset, never throwing', async () => {
    const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const fakeUsers = makeFakeUsersRepo([
      testUserItem({
        push_subscriptions: [{ ...sub('https://push.example/x'), created_at: '2026-06-01T00:00:00.000Z' }],
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
        push_subscriptions: [{ ...sub('https://push.example/a'), created_at: '2026-06-01T00:00:00.000Z' }],
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
});
