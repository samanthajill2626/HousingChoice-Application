// Pure, unit-testable helpers for the M1.8 "Share Listings" broadcast harness.
// Kept apart from the views so the formatting + labeling rules can be tested
// without rendering. Honest identity throughout: a recipient with no resolved
// name shows their formatted phone, never a fabricated name.
import { formatPhone } from '../thread/identity';
import type {
  BroadcastRecipientStatus,
  BroadcastStats,
  BroadcastSummary,
  DeliveryStatus,
  UnitItem,
} from '../../api';
import { formatAddress } from '../records/Address';
import { formatRentRange } from '../records/records';

/** The supported merge tokens (app/src/lib/mergeFields.ts) shown as composer
 *  hints. [TenantName] is per-recipient; the rest derive from the unit. */
export const MERGE_TOKENS = [
  { token: '[TenantName]', hint: "recipient's first name (else “there”)" },
  { token: '[Beds]', hint: 'the unit’s bedroom count' },
  { token: '[Address]', hint: 'the unit’s one-line address' },
  { token: '[Rent]', hint: 'the unit’s asking-rent range' },
  { token: '[FlyerLink]', hint: 'the public flyer URL' },
] as const;

/**
 * The default Share-Listings template, pre-filled when a broadcast is opened
 * from a unit. Ends with [FlyerLink] so the flyer is appended by default (the
 * server snapshots the unit's flyer URL into that token at send).
 */
export function defaultShareTemplate(unit: Pick<UnitItem, 'beds'> | undefined): string {
  const beds = typeof unit?.beds === 'number' ? `${unit.beds}-bedroom ` : '';
  return (
    `Hi [TenantName], we have a ${beds}home that may fit your voucher — ` +
    `[Address], [Rent]. See photos + details here: [FlyerLink]`
  );
}

/** The unit-derived merge-context preview the composer shows below the textarea
 *  (so the operator sees what the tokens will resolve to). Empty strings for
 *  unknown values — a missing value never fabricates anything. */
export interface UnitTokenPreview {
  beds: string;
  address: string;
  rent: string;
}

export function unitTokenPreview(unit: UnitItem | undefined): UnitTokenPreview {
  return {
    beds: typeof unit?.beds === 'number' ? String(unit.beds) : '',
    address: formatAddress(unit?.address) ?? '',
    rent: formatRentRange(unit?.rent_min, unit?.rent_max) ?? '',
  };
}

/** The five summary stat chips the results view renders, in display order.
 *  `key` indexes BroadcastStats; `tone` maps onto the Badge palette. */
export const STAT_CHIPS = [
  { key: 'audience', label: 'Audience', tone: 'info' },
  { key: 'sent', label: 'Sent', tone: 'info' },
  { key: 'delivered', label: 'Delivered', tone: 'success' },
  { key: 'failed', label: 'Failed', tone: 'danger' },
  { key: 'skipped_opted_out', label: 'Skipped (opted out)', tone: 'warning' },
  { key: 'queued', label: 'Queued', tone: 'neutral' },
] as const satisfies ReadonlyArray<{
  key: keyof BroadcastStats;
  label: string;
  tone: 'info' | 'success' | 'danger' | 'warning' | 'neutral';
}>;

/**
 * The honest display label for a recipient contactKey (contactId else
 * `phone#<E164>`), resolved against the preview sample names when available.
 * A `phone#<E164>` key always yields the formatted phone; an unresolved
 * contactId falls back to a short id stub (never a fabricated name).
 */
export function recipientLabel(
  contactKey: string,
  names: ReadonlyMap<string, string>,
): string {
  if (contactKey.startsWith('phone#')) {
    return formatPhone(contactKey.slice('phone#'.length));
  }
  const name = names.get(contactKey);
  if (name !== undefined && name.length > 0) return name;
  return `Contact ${contactKey.slice(0, 8)}`;
}

/**
 * Map a broadcast recipient status onto the shared DeliveryStatus so the
 * existing DeliveryBadge renders it. `skipped` has no DeliveryStatus peer
 * (it was never sent) — callers render those separately; this maps the
 * send/delivery states 1:1.
 */
export function recipientDeliveryStatus(
  status: BroadcastRecipientStatus,
): DeliveryStatus | undefined {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'failed';
    case 'skipped':
      return undefined;
  }
}

/** Human label for a broadcast lifecycle status (the results header badge). */
export function broadcastStatusLabel(status: BroadcastSummary['status']): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'sending':
      return 'Sending';
    case 'sent':
      return 'Sent';
    case 'failed':
      return 'Failed';
  }
}

/** Badge tone for a broadcast lifecycle status. */
export function broadcastStatusTone(
  status: BroadcastSummary['status'],
): 'neutral' | 'info' | 'success' | 'danger' {
  switch (status) {
    case 'draft':
      return 'neutral';
    case 'sending':
      return 'info';
    case 'sent':
      return 'success';
    case 'failed':
      return 'danger';
  }
}
