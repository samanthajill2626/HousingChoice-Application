// StatusChip — a small pill showing an outbound message's DeliveryState, mapped
// onto the shared --hc-* delivery palette (queued→neutral, sent→info,
// delivered→success, undelivered/failed→danger). Mirrors the dashboard Badge
// idiom (CSS Module + tone classes + status dot). Exposed as role="status" with
// an accessible name so getByRole('status') + getByText work; failures append
// the Twilio ErrorCode to the accessible name for debuggability.
import styles from './StatusChip.module.css';
import type { DeliveryState } from '../api/types.js';

type Tone = 'neutral' | 'info' | 'success' | 'danger';

const PRESENT: Record<DeliveryState, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  undelivered: { label: 'Undelivered', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
};

export interface StatusChipProps {
  state: DeliveryState;
  /** Twilio error code — surfaced (failures only) in the accessible name + title. */
  errorCode?: string;
}

function classes(tone: Tone): string {
  return [styles.chip, styles[tone]].filter(Boolean).join(' ');
}

export function StatusChip({ state, errorCode }: StatusChipProps): React.JSX.Element {
  const { label, tone } = PRESENT[state];
  const isFailure = state === 'failed' || state === 'undelivered';
  const showCode = isFailure && errorCode !== undefined && errorCode !== '';
  const accessibleName = showCode ? `${label} (error ${errorCode})` : label;
  return (
    <span
      role="status"
      className={classes(tone)}
      aria-label={accessibleName}
      {...(showCode && { title: `Error ${errorCode}` })}
    >
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
