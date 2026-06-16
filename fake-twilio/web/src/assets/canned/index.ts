// Canned MMS assets for the fake-phones dev UI. These are small, committed SVGs
// served as same-origin STATIC FILES from the host's public/ dir (public/canned/)
// — deliberately NOT imported through Vite. Vite inlines any asset under
// `assetsInlineLimit` (4 KB) as a `data:image/svg+xml;base64,…` URI, and a data:
// URL (a) fails the engine's http(s)-only media guard (sendAsParty throws) and
// (b) is itself the SVG-XSS vector that guard exists to block. Serving them as
// files keeps each `url` a real http(s) URL the guard accepts and the dashboard
// browser can fetch when it renders the inbound MMS.
//
// Each `url` is ABSOLUTE (origin + path), not root-relative: the engine validates
// with `new URL(s)`, which THROWS on a bare path like `/canned/room.svg` (no
// base) and so would reject it. The Composer picker offers these; MessageBubble
// matches a message's mediaUrls back to a label here (falling back to the raw URL).

// Same origin the UI is served from (the fake-twilio host under e2e/--mock, or
// the Vite dev server under `npm run dev` — both serve public/ at the root).
// Guarded for non-browser test envs without throwing at import time.
const origin = typeof window !== 'undefined' ? window.location.origin : '';

function cannedUrl(file: string): string {
  return `${origin}/canned/${file}`;
}

export interface CannedAsset {
  id: string;
  /** Absolute, same-origin static-file URL — what goes into mediaUrls. */
  url: string;
  /** Human label for the picker button + the rendered thumbnail alt text. */
  label: string;
}

export const cannedAssets: readonly CannedAsset[] = [
  { id: 'room', url: cannedUrl('room.svg'), label: 'Room' },
  { id: 'kitchen', url: cannedUrl('kitchen.svg'), label: 'Kitchen' },
  { id: 'lease-doc', url: cannedUrl('lease-doc.svg'), label: 'Lease doc' },
];

/** Resolve a mediaUrl back to its canned label, for thumbnail alt text. */
export function cannedLabelFor(url: string): string {
  return cannedAssets.find((a) => a.url === url)?.label ?? 'Attachment';
}
