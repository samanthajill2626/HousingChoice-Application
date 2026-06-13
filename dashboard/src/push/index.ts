// Web Push plumbing (M1.4). The FOUNDATION builds this module; Feature Agent 4
// wires the UI (an enable/disable control + the missed-call flows) to it.
//
// Flow (subscribeToPush): ensure the service worker is registered → fetch the
// VAPID public key (GET /api/push/vapid-public-key) → pushManager.subscribe with
// it → POST the subscription to the server (POST /api/push/subscriptions). All
// same-origin under the app CSP (connect-src 'self'); no external push library.
//
// Push is a FEATURE, not core: when VAPID is unconfigured the key endpoint 503s
// 'push_not_configured' — subscribeToPush surfaces that as a typed result rather
// than throwing, so the UI can show "push unavailable" cleanly.
import {
  ApiError,
  createPushSubscription,
  deletePushSubscription,
  getVapidPublicKey,
} from '../api/index.js';

/** Where the service worker file lives (served statically from dashboard/dist). */
const SERVICE_WORKER_URL = '/sw.js';

export type SubscribeResult =
  | { ok: true; subscriptionCount: number }
  | { ok: false; reason: 'unsupported' | 'denied' | 'push_not_configured' | 'error' };

/** True when this browser can do Web Push at all (SW + PushManager + Notification). */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Register the service worker. Idempotent — returns the existing registration
 * if already registered. Call this from main.tsx on boot (guarded to
 * prod/https or localhost) so the SW is ready before any push subscribe.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch {
    return undefined;
  }
}

/**
 * Subscribe THIS device for push. Requests notification permission if needed,
 * subscribes via the SW's PushManager, and registers the subscription with the
 * server. Returns a typed result (never throws for the expected
 * unsupported/denied/not-configured cases).
 */
export async function subscribeToPush(): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  let publicKey: string;
  try {
    publicKey = await getVapidPublicKey();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'push_not_configured') {
      return { ok: false, reason: 'push_not_configured' };
    }
    return { ok: false, reason: 'error' };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    // Reuse an existing browser subscription when present, else create one.
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));
    const subscriptionCount = await createPushSubscription(subscription.toJSON());
    return { ok: true, subscriptionCount };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Unsubscribe THIS device: drop the browser subscription and tell the server to
 * forget the endpoint. Safe to call when not subscribed.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  try {
    await deletePushSubscription(endpoint);
  } catch {
    // Best-effort server cleanup — the browser subscription is already gone.
  }
}

/**
 * Convert a base64url VAPID public key into the Uint8Array
 * pushManager.subscribe expects (applicationServerKey). The standard helper.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  // Allocate over a concrete ArrayBuffer (not ArrayBufferLike) so the result is
  // assignable to BufferSource for pushManager.subscribe's applicationServerKey.
  const output = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}
