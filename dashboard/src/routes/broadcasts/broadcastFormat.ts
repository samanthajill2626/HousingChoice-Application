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
  BroadcastStatus,
} from '../../api/index.js';
import { presentDeliveryStatus, type DeliveryPresentation } from '../contact/deliveryStatus.js';
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

/** The recipient-status → comms DeliveryPresentation map. `skipped` has no comms
 *  equivalent (opted out between resolve + send) — present it explicitly; every
 *  other recipient status maps onto the shared delivery model (queued → sent →
 *  delivered | failed). */
export function presentRecipientStatus(
  status: BroadcastRecipient['status'],
): DeliveryPresentation {
  if (status === 'skipped') {
    return { label: 'Skipped', tone: 'neutral', isFailure: false };
  }
  // queued / sent / delivered / failed all exist in the comms DeliveryStatus.
  return (
    presentDeliveryStatus(status) ?? { label: 'Sending…', tone: 'neutral', isFailure: false }
  );
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
