// StatusBadge — a small pill for a tenant or listing lifecycle status (the F1
// status model). One shared primitive so the same status reads identically on a
// PlacementCard, a TenantFile/LandlordFile Details row, a ListingDetail header, and a
// ContactsList row. Labels come from the F1 maps (TENANT_STATUS_LABELS /
// LISTING_STATUS_LABELS); an off-list/legacy value falls back to a humanized
// form so the badge never renders blank. A `tone` drives the colour family
// (derived from the status by the per-kind tone maps below).
import {
  LISTING_STATUS_LABELS,
  TENANT_STATUS_LABELS,
  type ListingStatus,
  type TenantStatus,
} from '../api/index.js';
import { humanize } from '../routes/contact/format.js';
import styles from './StatusBadge.module.css';

export type BadgeTone = 'neutral' | 'positive' | 'progress' | 'muted' | 'warn';

/** tenant status → tone (colour family). */
const TENANT_TONE: Record<TenantStatus, BadgeTone> = {
  needs_review: 'warn',
  onboarding: 'progress',
  searching: 'progress',
  placing: 'progress',
  placed: 'positive',
  on_hold: 'muted',
  inactive: 'muted',
};

/** listing status → tone (colour family). `available` is the publicly-shareable
 *  status (positive/green); the in-flight ones read as progress; the closed/held
 *  ones read muted. */
const LISTING_TONE: Record<ListingStatus, BadgeTone> = {
  setup: 'neutral',
  available: 'positive',
  under_application: 'progress',
  finalizing: 'progress',
  occupied: 'positive',
  on_hold: 'muted',
  off_market: 'muted',
};

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: styles.neutral ?? '',
  positive: styles.positive ?? '',
  progress: styles.progress ?? '',
  muted: styles.muted ?? '',
  warn: styles.warn ?? '',
};

export interface StatusBadgeProps {
  /** Which lifecycle the status belongs to (drives the label + tone maps). */
  kind: 'tenant' | 'listing';
  /** The stored status value (snake_case wire string). */
  status: string;
}

/** Resolve the display label for a status (kind-aware), falling back to a
 *  humanized form for an off-list value. */
function labelFor(kind: 'tenant' | 'listing', status: string): string {
  if (kind === 'tenant') return TENANT_STATUS_LABELS[status as TenantStatus] ?? humanize(status);
  return LISTING_STATUS_LABELS[status as ListingStatus] ?? humanize(status);
}

/** Resolve the tone for a status (kind-aware), defaulting to neutral. */
function toneFor(kind: 'tenant' | 'listing', status: string): BadgeTone {
  if (kind === 'tenant') return TENANT_TONE[status as TenantStatus] ?? 'neutral';
  return LISTING_TONE[status as ListingStatus] ?? 'neutral';
}

export function StatusBadge({ kind, status }: StatusBadgeProps): React.JSX.Element {
  const label = labelFor(kind, status);
  const tone = toneFor(kind, status);
  return <span className={`${styles.badge} ${TONE_CLASS[tone]}`}>{label}</span>;
}
