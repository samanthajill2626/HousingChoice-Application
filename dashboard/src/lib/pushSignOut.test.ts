import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBrowserPushSubscription } from './pushSignOut.js';

function stubServiceWorker(getSubscription: () => Promise<unknown>): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription } }) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('forgetBrowserPushSubscription (sign-out best-effort unsubscribe)', () => {
  it('unsubscribes the browser subscription when one exists and reports true', async () => {
    const unsubscribe = vi.fn(async () => true);
    stubServiceWorker(async () => ({ unsubscribe }));
    await expect(forgetBrowserPushSubscription()).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports false and does not throw when there is no subscription', async () => {
    stubServiceWorker(async () => null);
    await expect(forgetBrowserPushSubscription()).resolves.toBe(false);
  });

  it('never throws: an unsubscribe failure resolves false', async () => {
    stubServiceWorker(async () => ({
      unsubscribe: async () => {
        throw new Error('push service down');
      },
    }));
    await expect(forgetBrowserPushSubscription()).resolves.toBe(false);
  });

  it('never throws when the platform has no service worker at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: undefined });
    await expect(forgetBrowserPushSubscription()).resolves.toBe(false);
  });
});
