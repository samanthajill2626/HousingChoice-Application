// usePushControl — the Settings "Notifications on this device" state machine.
// Wraps the foundation src/push helpers (subscribeToPush / unsubscribeFromPush)
// and the sendPushTest endpoint into a small, testable hook that the Settings
// screen renders. Handles every typed SubscribeResult reason gracefully:
//   subscribed | not_subscribed | denied | unsupported | not_configured | error
//
// We never throw for the expected cases — subscribeToPush() already returns a
// typed { ok:false, reason } for unsupported/denied/push_not_configured/error,
// and we map those onto a display state with clear guidance in the UI.
import { useCallback, useEffect, useState } from 'react';
import { sendPushTest, type PushTestResult } from '../../api/index.js';
import { isPushSupported, subscribeToPush, unsubscribeFromPush } from '../../push/index.js';

export type PushState =
  | 'checking'
  | 'subscribed'
  | 'not_subscribed'
  | 'denied'
  | 'unsupported'
  | 'not_configured'
  | 'error';

export interface PushControl {
  state: PushState;
  busy: boolean;
  testing: boolean;
  supported: boolean;
  enable: () => void;
  disable: () => void;
  test: () => void;
}

/**
 * @param onTestResult called with the PushTestResult after a successful test
 *   send so the screen can surface attempted/sent counts.
 * @param onError called with a friendly message when a push action fails.
 */
export function usePushControl(
  onTestResult: (result: PushTestResult) => void,
  onError: (message: string) => void,
): PushControl {
  const supported = isPushSupported();
  const [state, setState] = useState<PushState>(supported ? 'checking' : 'unsupported');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  // On mount, read the current browser subscription + permission so the UI
  // opens in the right state (subscribed / not / denied) without a click.
  useEffect(() => {
    let active = true;
    if (!supported) {
      setState('unsupported');
      return;
    }
    void (async () => {
      try {
        if (Notification.permission === 'denied') {
          if (active) setState('denied');
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (active) setState(existing ? 'subscribed' : 'not_subscribed');
      } catch {
        if (active) setState('not_subscribed');
      }
    })();
    return () => {
      active = false;
    };
  }, [supported]);

  const enable = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await subscribeToPush();
        if (result.ok) {
          setState('subscribed');
        } else {
          switch (result.reason) {
            case 'denied':
              setState('denied');
              break;
            case 'unsupported':
              setState('unsupported');
              break;
            case 'push_not_configured':
              setState('not_configured');
              break;
            default:
              setState('error');
              onError("Couldn't enable notifications. Please try again.");
          }
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [onError]);

  const disable = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        await unsubscribeFromPush();
        setState('not_subscribed');
      } catch {
        onError("Couldn't turn off notifications. Please try again.");
      } finally {
        setBusy(false);
      }
    })();
  }, [onError]);

  const test = useCallback(() => {
    setTesting(true);
    void (async () => {
      try {
        const result = await sendPushTest();
        onTestResult(result);
      } catch {
        onError("Couldn't send a test notification. Please try again.");
      } finally {
        setTesting(false);
      }
    })();
  }, [onError, onTestResult]);

  return { state, busy, testing, supported, enable, disable, test };
}
