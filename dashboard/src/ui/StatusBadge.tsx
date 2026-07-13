// StatusBadge — a small pill for a tenant or property lifecycle status (the F1
// status model). One shared primitive so the same status reads identically on a
// PlacementCard, a TenantFile/LandlordFile Details row, a ListingDetail header, and a
// ContactsList row. Labels come from the F1 maps (TENANT_STATUS_LABELS /
// LISTING_STATUS_LABELS); an off-list/legacy value falls back to a humanized
// form so the badge never renders blank. A `tone` drives the colour family
// (derived from the status by the per-kind tone maps below).
import {
  LISTING_STATUS_LABELS,
  TENANT_STATUS_LABELS,
  TOUR_STATUS_LABELS,
  type LandlordStatus,
  type ListingStatus,
  type TenantStatus,
  type TourStatus,
} from '../api/index.js';
import { contactStatusLabel, humanize } from '../routes/contact/format.js';
import styles from './StatusBadge.module.css';

export type BadgeTone = 'neutral' | 'positive' | 'progress' | 'muted' | 'warn' | 'info' | 'danger';

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

/** landlord lead status → tone. `needs_review` is the triage front door (warn);
 *  a pursued lead is `interested` (progress); a SIGNED landlord being onboarded is
 *  `onboarding` (progress -- same tone the tenant `onboarding` status uses); an
 *  onboarded landlord is `active` (positive); a declined/dead lead is `parked`
 *  (muted). */
const LANDLORD_TONE: Record<LandlordStatus, BadgeTone> = {
  needs_review: 'warn',
  interested: 'progress',
  onboarding: 'progress',
  active: 'positive',
  parked: 'muted',
};

/** property status → tone (colour family). `available` is the publicly-shareable
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

/** tour status -> tone. requested = attention (warn/amber); scheduled = active
 *  (info/blue); toured = progress; closed = neutral; canceled = danger (red);
 *  no_show = muted. Mirrors the 2026-07-08 tour-detail-page decision. */
const TOUR_TONE: Record<TourStatus, BadgeTone> = {
  requested: 'warn',
  scheduled: 'info',
  toured: 'progress',
  closed: 'neutral',
  canceled: 'danger',
  no_show: 'muted',
};

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: styles.neutral ?? '',
  positive: styles.positive ?? '',
  progress: styles.progress ?? '',
  muted: styles.muted ?? '',
  warn: styles.warn ?? '',
  info: styles.info ?? '',
  danger: styles.danger ?? '',
};

export interface StatusBadgeProps {
  /** Which lifecycle the status belongs to (drives the label + tone maps). */
  kind: 'tenant' | 'listing' | 'tour';
  /** The stored status value (snake_case wire string). */
  status: string;
}

/** Resolve the display label for a status (kind-aware), falling back to a
 *  humanized form for an off-list value. */
function labelFor(kind: 'tenant' | 'listing' | 'tour', status: string): string {
  if (kind === 'tenant') return TENANT_STATUS_LABELS[status as TenantStatus] ?? humanize(status);
  if (kind === 'tour') return TOUR_STATUS_LABELS[status as TourStatus] ?? humanize(status);
  return LISTING_STATUS_LABELS[status as ListingStatus] ?? humanize(status);
}

/** Resolve the tone for a status (kind-aware), defaulting to neutral. */
function toneFor(kind: 'tenant' | 'listing' | 'tour', status: string): BadgeTone {
  if (kind === 'tenant') return TENANT_TONE[status as TenantStatus] ?? 'neutral';
  if (kind === 'tour') return TOUR_TONE[status as TourStatus] ?? 'neutral';
  return LISTING_TONE[status as ListingStatus] ?? 'neutral';
}

export function StatusBadge({ kind, status }: StatusBadgeProps): React.JSX.Element {
  const label = labelFor(kind, status);
  const tone = toneFor(kind, status);
  return <span className={`${styles.badge} ${TONE_CLASS[tone]}`}>{label}</span>;
}

/** Resolve a CONTACT's status tone across every audience the contact page shows:
 *  tenant + landlord get their own lifecycle maps; every other type (unknown / pm /
 *  team_member) carries the coarse needs_review|active pair, where only the triage
 *  front door (`needs_review`) warns. Off-list values fall back to neutral. This is
 *  the single source of truth for "does this status want attention?" (tone === 'warn'). */
export function contactStatusTone(type: string | undefined, status: string): BadgeTone {
  if (type === 'tenant') return TENANT_TONE[status as TenantStatus] ?? 'neutral';
  if (type === 'landlord') return LANDLORD_TONE[status as LandlordStatus] ?? 'neutral';
  return status === 'needs_review' ? 'warn' : 'neutral';
}

/** A status pill for a CONTACT (any type) — mirrors {@link StatusBadge} but resolves
 *  its label + tone from the contact's `type`, so it reads correctly for tenants,
 *  landlords, and untriaged contacts alike. Used for the prominent header badge. */
export function ContactStatusBadge({
  type,
  status,
}: {
  type: string | undefined;
  status: string;
}): React.JSX.Element {
  const label = contactStatusLabel(type, status);
  const tone = contactStatusTone(type, status);
  return <span className={`${styles.badge} ${TONE_CLASS[tone]}`}>{label}</span>;
}
