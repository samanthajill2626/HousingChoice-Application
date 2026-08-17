import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetBrowserPushSubscription,
  reconcileBrowserPushSubscription,
} from './pushSignOut.js';

function stubServiceWorker(getRegistration: () => Promise<unknown>): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: {
      getRegistration,
      // `.ready` is deliberately a promise that NEVER settles: the module must
      // not depend on it (it never resolves when nothing is registered).
      ready: new Promise(() => {}),
    },
  });
}

function registrationWith(subscription: unknown): { pushManager: { getSubscription: () => Promise<unknown> } } {
  return { pushManager: { getSubscription: async () => subscription } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('forgetBrowserPushSubscription (sign-out best-effort unsubscribe)', () => {
  it('unsubscribes the browser subscription when one exists and reports true', async () => {
    const unsubscribe = vi.fn(async () => true);
    stubServiceWorker(async () => registrationWith({ unsubscribe }));
    await expect(forgetBrowserPushSubscription()).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports false and does not throw when there is no subscription', async () => {
    stubServiceWorker(async () => registrationWith(null));
    await expect(forgetBrowserPushSubscription()).resolves.toBe(false);
  });

  it('reports false when NO service worker is registered (getRegistration resolves undefined) - never touches .ready', async () => {
    stubServiceWorker(async () => undefined);
    await expect(forgetBrowserPushSubscription()).resolves.toBe(false);
  });

  it('never hangs: a registration lookup that never settles is bounded by the timeout', async () => {
    stubServiceWorker(() => new Promise(() => {}));
    await expect(forgetBrowserPushSubscription({ timeoutMs: 20 })).resolves.toBe(false);
  });

  it('never throws: an unsubscribe failure resolves false', async () => {
    stubServiceWorker(async () =>
      registrationWith({
        unsubscribe: async () => {
          throw new Error('push service down');
        },
      }),
    );
    await expect(forgetBrowserPushSubscription()).resolves.toBe(false);
  });

  it('never throws when the platform has no service worker API at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: undefined });
    await expect(forgetBrowserPushSubscription()).resolves.toBe(false);
  });
});

describe('reconcileBrowserPushSubscription (boot-time re-POST so the server matches the device)', () => {
  it('re-POSTs the browser subscription to the server when one exists', async () => {
    const json = { endpoint: 'https://fcm.googleapis.com/send/x', keys: { p256dh: 'k', auth: 'a' } };
    stubServiceWorker(async () => registrationWith({ toJSON: () => json }));
    const post = vi.fn(async () => ({ subscriptionCount: 1 }));
    await expect(reconcileBrowserPushSubscription(post)).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith(json);
  });

  it('does nothing when there is no browser subscription or no registration', async () => {
    const post = vi.fn(async () => ({ subscriptionCount: 0 }));
    stubServiceWorker(async () => registrationWith(null));
    await expect(reconcileBrowserPushSubscription(post)).resolves.toBe(false);
    stubServiceWorker(async () => undefined);
    await expect(reconcileBrowserPushSubscription(post)).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('never throws: a failing POST (e.g. 503 push_not_configured) resolves false', async () => {
    stubServiceWorker(async () => registrationWith({ toJSON: () => ({ endpoint: 'e', keys: {} }) }));
    const post = vi.fn(async () => {
      throw new Error('push_not_configured');
    });
    await expect(reconcileBrowserPushSubscription(post)).resolves.toBe(false);
  });

  it('never hangs: a registration lookup that never settles is bounded by the timeout', async () => {
    stubServiceWorker(() => new Promise(() => {}));
    const post = vi.fn(async () => ({ subscriptionCount: 1 }));
    await expect(reconcileBrowserPushSubscription(post, { timeoutMs: 20 })).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
