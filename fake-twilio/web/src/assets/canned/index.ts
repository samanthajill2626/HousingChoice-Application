// Canned MMS assets for the fake-phones dev UI. These are small, committed,
// same-origin SVGs (no remote media — the spec's XSS/media guard). The Composer
// picker offers them; MessageBubble renders an outgoing message's mediaUrls by
// matching the URL back to its label here (falling back to the raw URL).
import roomUrl from './room.svg';
import kitchenUrl from './kitchen.svg';
import leaseDocUrl from './lease-doc.svg';

export interface CannedAsset {
  id: string;
  /** Vite-resolved, same-origin asset URL — what goes into mediaUrls. */
  url: string;
  /** Human label for the picker button + the rendered thumbnail alt text. */
  label: string;
}

export const cannedAssets: readonly CannedAsset[] = [
  { id: 'room', url: roomUrl, label: 'Room' },
  { id: 'kitchen', url: kitchenUrl, label: 'Kitchen' },
  { id: 'lease-doc', url: leaseDocUrl, label: 'Lease doc' },
];

/** Resolve a mediaUrl back to its canned label, for thumbnail alt text. */
export function cannedLabelFor(url: string): string {
  return cannedAssets.find((a) => a.url === url)?.label ?? 'Attachment';
}
