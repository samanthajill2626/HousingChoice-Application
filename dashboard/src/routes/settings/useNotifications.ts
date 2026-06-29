// useNotifications — this-device push state + actions for the Notifications
// section. Drives the on/off toggle off Notification.permission +
// pushManager.getSubscription(), subscribes/unsubscribes with the VAPID key, and
// runs the self-test. Feature-detects everything (degrades to a clear reason on
// unsupported browsers), and treats a 503 push_not_configured as "not configured
// in this environment" (controls disabled).
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  getVapidPublicKey,
  sendPushTest,
  subscribePush,
  unsubscribePush,
} from '../../api/index.js';

/** Why push is unavailable on THIS device/environment (drives the disabled UI). */
export type PushUnsupportedReason =
  | 'unsupported' // no serviceWorker / PushManager / Notification API
  | 'not_configured' // server 503 push_not_configured (no VAPID)
  | 'denied'; // the user blocked notifications in the browser

export interface NotificationsState {
  /** Feature-support gate; false → render the unsupported/disabled message. */
  supported: boolean;
  reason: PushUnsupportedReason | null;
  /** This device currently has a push subscription. */
  enabled: boolean;
  busy: boolean;
  error: string | null;
  /** The last self-test tally, when run. */
  testResult: { sent: number; failed: number } | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  sendTest: () => Promise<void>;
}

/** Convert a base64url VAPID public key to the Uint8Array applicationServerKey
 *  pushManager.subscribe expects. Standard helper. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  // Back the view with a plain ArrayBuffer (not ArrayBufferLike) so it satisfies
  // BufferSource for pushManager.subscribe's applicationServerKey.
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function detectSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function getRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return (await navigator.serviceWorker.ready) ?? undefined;
  } catch {
    return undefined;
  }
}

export function useNotifications(): NotificationsState {
  const supported = detectSupport();
  const [reason, setReason] = useState<PushUnsupportedReason | null>(
    supported ? null : 'unsupported',
  );
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ sent: number; failed: number } | null>(null);

  // Probe the current subscription state on mount.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      const reg = await getRegistration();
      if (cancelled || reg === undefined) return;
      try {
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setEnabled(sub !== null);
      } catch {
        /* leave enabled=false; the toggle still works */
      }
      if (!cancelled && Notification.permission === 'denied') setReason('denied');
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  /** Map a thrown error to a user message (+ flip reason on a 503). */
  const handleError = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 503 && err.code === 'push_not_configured') {
      setReason('not_configured');
      setError(null);
      return;
    }
    setError(fallback);
  }, []);

  const enable = useCallback(async () => {
    if (!supported || busy) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setReason(permission === 'denied' ? 'denied' : null);
        setError(permission === 'denied' ? null : 'Notifications permission was not granted.');
        return;
      }
      const reg = await getRegistration();
      if (reg === undefined) {
        setError('This device has no service worker registered for push.');
        return;
      }
      // Fetch the VAPID key first (503 here → not configured).
      const key = await getVapidPublicKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      await subscribePush(sub.toJSON());
      setEnabled(true);
    } catch (err) {
      handleError(err, "Couldn't enable notifications on this device.");
    } finally {
      setBusy(false);
    }
  }, [supported, busy, handleError]);

  const disable = useCallback(async () => {
    if (!supported || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await getRegistration();
      const sub = reg !== undefined ? await reg.pushManager.getSubscription() : null;
      if (sub !== null) {
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setEnabled(false);
    } catch (err) {
      handleError(err, "Couldn't disable notifications on this device.");
    } finally {
      setBusy(false);
    }
  }, [supported, busy, handleError]);

  const sendTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await sendPushTest();
      setTestResult({ sent: result.sent, failed: result.failed });
    } catch (err) {
      handleError(err, "Couldn't send a test notification.");
    } finally {
      setBusy(false);
    }
  }, [busy, handleError]);

  return {
    supported: supported && reason !== 'not_configured' && reason !== 'unsupported',
    reason,
    enabled,
    busy,
    error,
    testResult,
    enable,
    disable,
    sendTest,
  };
}
