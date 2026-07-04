// FlagPills — the go-live readiness flags (doc §6). Each flag renders as an
// accessible pill: a label + a text state (state is NEVER conveyed by colour
// alone). The two A2P kill-switches (smsSendingEnabled, relayLiveProvisioning),
// when OFF, show an amber "Off - pre-A2P" pill — the EXPECTED pre-launch state,
// deliberately distinct from a red/error pill and clearly labeled. The
// the push flag reads on/off; env + driver are info pills. Flags always load
// (no AWS call).
import { useSystemFlags } from './useSystemStatus.js';
import { Button, Spinner } from '../../ui/index.js';
import styles from './SystemStatusSection.module.css';

/** A pill tone — drives the colour family AND is reflected in the visible text. */
type PillTone = 'on' | 'preA2p' | 'off' | 'info';

const TONE_CLASS: Record<PillTone, string> = {
  on: styles.pillOn ?? '',
  preA2p: styles.pillPreA2p ?? '',
  off: styles.pillOff ?? '',
  info: styles.pillInfo ?? '',
};

/** One labeled status pill. The state text makes the tone legible without colour. */
function Pill({ label, state, tone }: { label: string; state: string; tone: PillTone }): React.JSX.Element {
  return (
    <li className={styles.pill}>
      <span className={styles.pillLabel}>{label}</span>
      <span className={`${styles.pillState} ${TONE_CLASS[tone]}`}>{state}</span>
    </li>
  );
}

export function FlagPills(): React.JSX.Element {
  const { status, flags, retry } = useSystemFlags();

  return (
    <div className={styles.block} aria-labelledby="system-flags-heading">
      <h3 id="system-flags-heading" className={styles.blockHeading}>
        Go-live flags
      </h3>

      {status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' || flags === null ? (
        <div role="alert" className={styles.errorBlock}>
          <p className={styles.errorText}>Couldn't load the go-live flags.</p>
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : (
        <ul className={styles.pills}>
          <Pill label="Environment" state={flags.env} tone="info" />
          <Pill label="Messaging driver" state={flags.messagingDriver} tone="info" />
          {/* A2P kill-switches: OFF is the EXPECTED pre-launch state (amber, not red). */}
          <Pill
            label="SMS sending"
            state={flags.smsSendingEnabled ? 'On' : 'Off - pre-A2P'}
            tone={flags.smsSendingEnabled ? 'on' : 'preA2p'}
          />
          <Pill
            label="Relay provisioning"
            state={flags.relayLiveProvisioning ? 'On' : 'Off - pre-A2P'}
            tone={flags.relayLiveProvisioning ? 'on' : 'preA2p'}
          />
          <Pill
            label="Push notifications"
            state={flags.pushConfigured ? 'Configured' : 'Not configured'}
            tone={flags.pushConfigured ? 'on' : 'off'}
          />
        </ul>
      )}
    </div>
  );
}
