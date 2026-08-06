// FlagPills — the go-live readiness flags (doc §6). Each flag renders as an
// accessible pill: a label + a text state (state is NEVER conveyed by colour
// alone). The two A2P kill-switches (smsSendingEnabled, relayLiveProvisioning),
// when OFF, show an amber "Off - pre-A2P" pill — the EXPECTED pre-launch state,
// deliberately distinct from a red/error pill and clearly labeled. The
// the push flag reads on/off; env + driver are info pills. Flags always load
// (no AWS call).
//
// The "Sending from" pill shows OUR one business number (BUSINESS_PHONE_NUMBER)
// - the number this app is CONFIGURED to text and call from. HONEST SCOPE: that
// is not proof a send will succeed, so a caveat sentence sits beneath the pill
// list saying what this row cannot check (Messaging Service attachment + A2P
// campaign coverage). The caveat is a SIBLING <p>, not a pill: `Pill` takes
// three primitive props and has no slot for a sentence.
import { useSystemFlags } from './useSystemStatus.js';
import { Button, Spinner } from '../../ui/index.js';
import { formatPhoneDisplay } from '../../lib/phone.js';
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
        <>
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
            {/* OUR business number. UNSET IS AN EXPLICIT BRANCH: the backend omits
                the key when the env has no number (never `null`) and
                formatPhoneDisplay(undefined) returns '', which would render an
                empty pill. The unconfigured copy is "Not set", NOT "Not
                configured" - the push pill above already owns that literal and a
                second one breaks its singular getByText assertion. */}
            <Pill
              label="Sending from"
              state={
                flags.businessPhoneNumber === undefined
                  ? 'Not set'
                  : formatPhoneDisplay(flags.businessPhoneNumber)
              }
              tone={flags.businessPhoneNumber === undefined ? 'off' : 'info'}
            />
          </ul>
          {/* REQUIRED by the spec (HONEST SCOPE, G4): a readiness row that implies
              more than it checks is worse than no row. This row proves only what
              the app is configured to send FROM. */}
          <p className={styles.caveat}>
            Outbound texts and calls present this number. It must also be attached to the
            Messaging Service and covered by the A2P campaign before sends succeed - this
            row cannot check either.
          </p>
        </>
      )}
    </div>
  );
}
