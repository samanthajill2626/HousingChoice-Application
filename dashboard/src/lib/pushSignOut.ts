// pushSignOut - keep the browser's push subscription and the server's record
// of it in agreement across sign-out and boot.
//
// WHY: sign-out is global revocation on the server, and that write also DROPS
// the user's push subscriptions - ALL devices (a subscription is a device
// credential; message pushes carry contact names + bodies). The browser that
// signed out unsubscribes its own copy so its Settings toggle does not keep
// reading On (forgetBrowserPushSubscription). Every OTHER device still holds
// a live browser subscription the server no longer knows about - and the
// Settings toggle derives its state from the BROWSER, so it would read On
// while nothing arrives, silently, including the voice pre-ring. So on boot
// every device re-POSTs the subscription it holds
// (reconcileBrowserPushSubscription): idempotent on the server (dedupe by
// endpoint, replace), it converges browser and server after any revocation
// or subscription rotation without a Settings visit.
//
// BOTH are best-effort and NEVER throw or hang: sign-out and boot must never
// be blocked by the push service, a missing service worker, or a denied
// permission.
//
// NEVER `navigator.serviceWorker.ready` here: it never settles when nothing
// is registered (main.tsx documents this), and a forever-pending promise is
// not a rejection - try/catch cannot save a caller that awaits it.
// getRegistration() resolves undefined in that case, which is what we want,
// and the lookup is bounded by a timeout as belt-and-braces.

/** How long the WHOLE operation (registration lookup, getSubscription, and
 *  the unsubscribe / re-POST) may take before it resolves false. Bounds every
 *  await, not only the first - the unsubscribe is the one call that talks to
 *  the push service, and it sits in front of logout(). */
const OPERATION_TIMEOUT_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Test seam: bound the whole operation tighter than the default. */
export interface PushSyncOptions {
  timeoutMs?: number;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined || registration === null) return null;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ?? null;
}

/** Run `work` under the operation timeout; any throw or hang resolves false. */
async function bounded(work: () => Promise<boolean>, opts?: PushSyncOptions): Promise<boolean> {
  const result = await withTimeout(
    work().catch(() => false),
    opts?.timeoutMs ?? OPERATION_TIMEOUT_MS,
  );
  return result === true;
}

/** Unsubscribe the current browser push subscription, if any. Never throws
 *  or hangs. Resolves true when a subscription was unsubscribed. */
export function forgetBrowserPushSubscription(opts?: PushSyncOptions): Promise<boolean> {
  return bounded(async () => {
    const subscription = await currentSubscription();
    if (subscription === null) return false;
    return await subscription.unsubscribe();
  }, opts);
}

/** Re-POST the current browser push subscription to the server, if any.
 *  `post` is injected (the API's subscribePush) so the module stays pure.
 *  Never throws or hangs. Resolves true when a subscription was posted. */
export function reconcileBrowserPushSubscription(
  post: (subscription: PushSubscriptionJSON) => Promise<unknown>,
  opts?: PushSyncOptions,
): Promise<boolean> {
  return bounded(async () => {
    const subscription = await currentSubscription();
    if (subscription === null) return false;
    await post(subscription.toJSON());
    return true;
  }, opts);
}
