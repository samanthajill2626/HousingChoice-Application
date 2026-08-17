// pushText - server-side caps for push notification copy (spec D12).
//
// WHY: a web-push payload over ~4KB is REJECTED by the push service with
// a non-Gone status, so pushService counts it `failed`, KEEPS the
// subscription, and the notification is silently lost - and would be
// lost again on every send. An uncapped matched-email push body can be
// the stored body text (up to 100KB), so the cap must run server-side
// at the send site. Counted in CODE POINTS so a surrogate pair (emoji)
// is never split mid-character.
//
// Pure function, no I/O, no logging.

/** Max code points for a push title (spec D12). */
export const PUSH_TITLE_MAX = 100;
/** Max code points for a push body (spec D12). */
export const PUSH_BODY_MAX = 300;

/**
 * Cap `text` at `maxCodePoints`. Over-cap input is truncated so the
 * result INCLUDING the ASCII "..." suffix is exactly the cap.
 */
export function capPushText(text: string, maxCodePoints: number): string {
  const points = Array.from(text);
  if (points.length <= maxCodePoints) return text;
  // A cap too small to hold the suffix degrades to a hard slice - the
  // result NEVER exceeds the cap (spec D12).
  if (maxCodePoints <= 3) return points.slice(0, maxCodePoints).join('');
  return points.slice(0, maxCodePoints - 3).join('') + '...';
}
