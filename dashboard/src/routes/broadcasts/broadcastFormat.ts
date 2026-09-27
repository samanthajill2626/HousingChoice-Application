// Pure presentation helpers for the Broadcasts surface — voucher-size labels,
// the audience summary line, the broadcast-status pill tone, recipient-status
// presentation (reusing the comms deliveryStatus model), and the flattening of
// the results recipients map into renderable rows. Pure + unit-testable so the
// views stay declarative. No PII is logged anywhere (phones render in the UI
// only — never console.log them).
import type {
  AudienceFilter,
  BroadcastRecipient,
  BroadcastRecipientView,
  BroadcastStats,
  BroadcastStatus,
} from '../../api/index.js';
import {
  deliveryReason,
  NOT_CONFIRMED_PRESENTATION,
  presentDeliveryStatus,
  SEND_UNCONFIRMED_CODE,
  shareSkipReason,
  type DeliveryPresentation,
} from '../contact/deliveryStatus.js';
import { contactDisplayName } from '../contact/format.js';

/** The voucher-size chip choices (bedroomSize 0..4; "4+" means 4-or-more). */
export interface VoucherSizeChoice {
  /** The bedroomSize value sent to the backend (0 = Studio). */
  value: number;
  /** The chip label. */
  label: string;
}

export const VOUCHER_SIZE_CHOICES: readonly VoucherSizeChoice[] = [
  { value: 0, label: 'Studio' },
  { value: 1, label: '1-BR' },
  { value: 2, label: '2-BR' },
  { value: 3, label: '3-BR' },
  { value: 4, label: '4+ BR' },
];

/** A short label for a bedroom size (0 → "Studio"; 4 → "4+ BR" since 4 is the
 *  top chip). Used in the audience summary + the "matches this N-bedroom
 *  property" tag. */
export function voucherSizeLabel(bedroomSize: number): string {
  if (bedroomSize <= 0) return 'Studio';
  if (bedroomSize >= 4) return '4+ BR';
  return `${bedroomSize}-BR`;
}

/** A plain "N-bedroom" phrase for the property-match tag ("matches this
 *  2-bedroom property"). Studio reads "studio". */
export function bedroomPhrase(beds: number): string {
  if (beds <= 0) return 'studio';
  return `${beds}-bedroom`;
}

/** A human audience summary for a list row / results header, e.g.
 *  "Tenants - 2-BR - Atlanta Housing". Always leads with "Tenants" (the only
 *  audience M1.8 targets); appends the size + authority narrowers when set. */
export function audienceSummary(filter: AudienceFilter): string {
  const parts: string[] = ['Tenants'];
  if (filter.bedroomSize !== undefined) parts.push(voucherSizeLabel(filter.bedroomSize));
  if (filter.housing_authority !== undefined && filter.housing_authority.length > 0) {
    parts.push(filter.housing_authority);
  }
  return parts.join(' - ');
}

/** Reach line for a seeds-only send, where the audience filter says nothing. */
export function sendReachLabel(count: number): string {
  return `To ${count} ${count === 1 ? 'tenant' : 'tenants'}`;
}

/** Broadcast status → a human label. */
export const BROADCAST_STATUS_LABELS: Readonly<Record<BroadcastStatus, string>> = {
  draft: 'Draft',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
};

export type BroadcastStatusTone = 'neutral' | 'progress' | 'positive' | 'danger';

/** Broadcast status → tone (colour family). */
export const BROADCAST_STATUS_TONE: Readonly<Record<BroadcastStatus, BroadcastStatusTone>> = {
  draft: 'neutral',
  sending: 'progress',
  sent: 'positive',
  failed: 'danger',
};

/** share-skip-fix D6: the share's label for the list row and the results
 *  header. A finished share (`sent`) whose EVERY recipient was skipped reached
 *  nobody, and "Sent" would be a lie (Sam's #5: one-to-one shares that read
 *  Sent with a Skipped row). Presentation ONLY: the stored status, the list's
 *  status filter and the tab it lists under are unchanged. A share with any
 *  sent / delivered / failed / queued slot keeps its status label. */
export function presentShareLabel(
  status: BroadcastStatus,
  stats?: BroadcastStats,
): { label: string; tone: BroadcastStatusTone } {
  if (status === 'sent' && stats !== undefined && stats.audience > 0) {
    if (skippedTotal(stats) >= stats.audience) return { label: 'Not sent', tone: 'neutral' };
  }
  return { label: BROADCAST_STATUS_LABELS[status], tone: BROADCAST_STATUS_TONE[status] };
}

/** Every skipped recipient across the three skip buckets - the ONE dashboard
 *  definition of "skipped", shared by the Skipped chip and the "Not sent" label
 *  so a fourth bucket changes both at once. `skipped_other` is optional (stats
 *  persisted before 2026-09-25 lack it). The `unconfirmed` bucket (SOR D22) is
 *  NOT a skip and never joins this sum: those recipients MAY have been texted,
 *  so a share of them must never read "Not sent". */
export function skippedTotal(stats: BroadcastStats): number {
  return stats.skipped_opted_out + stats.skipped_no_consent + (stats.skipped_other ?? 0);
}

/** The recipient-status -> comms DeliveryPresentation map. `skipped` has no comms
 *  equivalent (nothing was sent: a fan-out fence or the send wrapper refused the
 *  recipient), so it is presented explicitly; WHY it was skipped rides the
 *  slot's errorCode and is rendered beside the label by shareRecipientReason
 *  below (spec D7). Every other recipient status maps onto the shared delivery
 *  model (queued -> sent -> delivered | failed).
 *
 *  The 'sent' nuance: the fan-out stamps a slot 'sent' at DISPATCH (its
 *  idempotency claim), which is EARLIER than the message's own queued → sent
 *  carrier transition. Until the carrier's sent callback lands (carrierSentAt,
 *  webhook rollup), that slot's message still reads "Sending…" on its 1:1
 *  bubble — so the recipient row must too, or the two surfaces disagree about
 *  the same message at the same instant. */
export function presentRecipientStatus(
  status: BroadcastRecipient['status'],
  carrierSentAt?: string,
  errorCode?: string,
): DeliveryPresentation {
  // SOR D20/D22: `send_unconfirmed` is presented by the CODE ALONE, ahead of
  // the status - the same "Not confirmed" (danger, not a failure) the relay
  // row reads. The badge renders its reason through shareRecipientReason, which
  // is not gated on isFailure; the results row keeps its failed styling and
  // sort (both key on the status) and drops only the retry hint.
  if (errorCode === SEND_UNCONFIRMED_CODE) return { ...NOT_CONFIRMED_PRESENTATION };
  if (status === 'skipped') {
    return { label: 'Skipped', tone: 'neutral', isFailure: false };
  }
  if (status === 'sent' && carrierSentAt === undefined) {
    // Dispatched, carrier not yet confirmed — the same instant the 1:1 bubble
    // presents as queued/"Sending…".
    return { label: 'Sending…', tone: 'neutral', isFailure: false };
  }
  // queued / sent / delivered / failed all exist in the comms DeliveryStatus.
  return (
    presentDeliveryStatus(status) ?? { label: 'Sending…', tone: 'neutral', isFailure: false }
  );
}

/** The reason a share recipient was NOT texted or NOT delivered - one sentence
 *  per row, for skipped AND failed slots (spec D7). Skipped rows read the
 *  share-skip map in deliveryStatus.ts; failed rows keep the shared
 *  deliveryReason (carrier codes, the fan-out's transient_cap / enqueue_failed,
 *  and the 30003 wording, which is owned elsewhere), with `no_contact` - the
 *  fan-out's own "nothing to send to" - as the one share-specific failure line.
 *  Undefined for queued / sent / delivered. */
export function shareRecipientReason(
  status: BroadcastRecipient['status'],
  errorCode: string | undefined,
): string | undefined {
  if (status === 'skipped') return shareSkipReason(errorCode);
  if (status === 'failed') {
    if (errorCode === 'no_contact') return 'No contact or phone on file';
    return deliveryReason(errorCode) ?? 'Delivery failed';
  }
  return undefined;
}

/** Split a results recipients-map key into its contactId / phone form. A key is
 *  either a bare contactId (usual) or `phone#<E164>` (a contact-less recipient).
 *  Returns the matching field set so the row can link (contactId) or render
 *  link-less (phone). */
export function splitContactKey(key: string): { contactId?: string; phone?: string } {
  if (key.startsWith('phone#')) {
    return { phone: key.slice('phone#'.length) };
  }
  return { contactId: key };
}

/** Flatten the results recipients map into renderable rows (stable order: the
 *  map's insertion order, which the backend builds from the resolved audience).
 *  Failed rows sort FIRST so the operator's disposition work is up top. The row
 *  name is composed with contactDisplayName over the server-projected first/last
 *  name (the SAME helper the composer's review rows use); the phone prefers the
 *  server projection and falls back to the `phone#<E164>` key. A row with neither
 *  a name nor a phone carries neither field (the view renders the "Tenant"
 *  fallback). */
export function toRecipientViews(
  recipients: Record<string, BroadcastRecipient>,
): BroadcastRecipientView[] {
  const rows: BroadcastRecipientView[] = Object.entries(recipients).map(([key, slot]) => {
    const split = splitContactKey(key);
    // Prefer the server-provided phone; fall back to the phone# key's number.
    const phone = slot.phone ?? split.phone;
    // Compose the name only when the server actually resolved one - an empty
    // first+last must NOT collapse to contactDisplayName's phone/"Unknown"
    // fallbacks (the row handles those itself, incl. the "Tenant" label).
    const hasName = Boolean((slot.firstName ?? '').trim() || (slot.lastName ?? '').trim());
    const name = hasName ? contactDisplayName(slot.firstName, slot.lastName, phone) : undefined;
    return {
      contactKey: key,
      ...(split.contactId !== undefined && { contactId: split.contactId }),
      ...(name !== undefined && { name }),
      ...(phone !== undefined && { phone }),
      status: slot.status,
      ...(slot.carrierSentAt !== undefined && { carrierSentAt: slot.carrierSentAt }),
      ...(slot.errorCode !== undefined && { errorCode: slot.errorCode }),
      ...(slot.conversationId !== undefined && { conversationId: slot.conversationId }),
    };
  });
  // Failures first (action items), then the rest in their natural order.
  return rows.sort((a, b) => {
    const af = a.status === 'failed' ? 0 : 1;
    const bf = b.status === 'failed' ? 0 : 1;
    return af - bf;
  });
}

/** A short date label for a list row / header ("Jun 30, 2:14 PM"). Falls back to
 *  the raw string on an unparseable instant (honest — never mangle). */
export function formatBroadcastDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
