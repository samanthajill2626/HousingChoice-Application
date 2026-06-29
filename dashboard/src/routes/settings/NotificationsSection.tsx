// NotificationsSection — push notifications for THIS device (all users). Toggles
// the device's subscription on/off and runs a self-test. Degrades clearly when
// push is unsupported, not configured in the environment (503), or blocked, and
// shows the iOS "Add to Home Screen first" hint when relevant.
//
// FUTURE: no device list in v1 (no endpoint to enumerate a user's devices).
import { useNotifications } from './useNotifications.js';
import { Button } from '../../ui/index.js';
import styles from './NotificationsSection.module.css';

/** iOS Safari that is NOT running as an installed PWA — push needs Add to Home
 *  Screen first. Feature-detect only (no version sniffing beyond the platform). */
function needsIosInstallHint(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // navigator.standalone is the iOS-Safari installed-PWA flag (non-standard).
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

export function NotificationsSection(): React.JSX.Element {
  const { supported, reason, enabled, busy, error, testResult, enable, disable, sendTest } =
    useNotifications();

  const iosHint = needsIosInstallHint();

  return (
    <section className={styles.section} aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" className={styles.heading}>
        Notifications
      </h2>

      <p className={styles.lede}>Push notifications are configured per device.</p>

      {iosHint ? (
        <p className={styles.hint}>Add this app to your Home Screen first to enable push on iOS.</p>
      ) : null}

      {reason === 'unsupported' ? (
        <p className={styles.unsupported}>
          This browser doesn't support push notifications.
        </p>
      ) : reason === 'not_configured' ? (
        <p className={styles.unsupported}>Push isn't configured in this environment.</p>
      ) : reason === 'denied' ? (
        <p className={styles.unsupported}>
          Notifications are blocked for this site. Allow them in your browser settings, then
          reload.
        </p>
      ) : (
        <>
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>
              Push on this device: <strong>{enabled ? 'On' : 'Off'}</strong>
            </span>
            {enabled ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() => void disable()}
                disabled={busy || !supported}
              >
                {busy ? 'Working…' : 'Turn off'}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                onClick={() => void enable()}
                disabled={busy || !supported}
              >
                {busy ? 'Working…' : 'Turn on'}
              </Button>
            )}
          </div>

          <div className={styles.testRow}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void sendTest()}
              disabled={busy || !enabled}
            >
              Send test notification
            </Button>
            {testResult !== null ? (
              <span role="status" className={styles.testResult}>
                {testResult.sent} sent, {testResult.failed} failed.
              </span>
            ) : null}
          </div>
        </>
      )}

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
