// The action-id contract between the missed-call push and the quick-reply sheet,
// plus the pure helpers the sheet uses to honour it. No React, no I/O - all of
// the fiddly parsing lives here so it can be tested directly.
//
// THE CONTRACT. app/src/routes/webhooks/voice.ts builds the Android notification
// action buttons as:
//
//     orgSettings.quickReplies.slice(0, 2).map((title, i) => ({ action: `qr-${i}` }))
//
// so an action id is 'qr-' + the reply's index into the RAW settings array. That
// is the only stable handle available: OrgSettings.quickReplies is a bare
// string[] with no server-side ids. Two consequences the helpers below encode:
//
//   - Indices are RAW. Dropping a blank reply from the rendered list must NOT
//     renumber the rest, or 'qr-1' would resolve to the wrong body. Options
//     therefore carry the original index rather than their display position.
//   - Indices are STALE-ABLE. An operator can edit the replies between the push
//     and the tap, so an id may point past the end of the array (or at a reply
//     that is now blank). That resolves to nothing, and the sheet falls back to
//     waiting for a manual tap - it never sends a guess.

/** Prefix of every quick-reply action id. Mirrored in voice.ts. */
export const QUICK_REPLY_ACTION_PREFIX = 'qr-';

/** One tappable canned reply: the body to send plus its RAW settings index. */
export interface QuickReplyOption {
  /** Index into OrgSettings.quickReplies - what 'qr-<n>' refers to. */
  index: number;
  /** The trimmed message body that gets sent. */
  body: string;
}

/** The action id for the Nth configured quick reply. */
export function quickReplyActionId(index: number): string {
  return `${QUICK_REPLY_ACTION_PREFIX}${index}`;
}

/**
 * Turn the configured replies into tappable options: trimmed, blanks dropped,
 * each keeping its ORIGINAL index so an action id still resolves correctly.
 */
export function buildQuickReplyOptions(
  replies: readonly string[] | undefined,
): QuickReplyOption[] {
  const options: QuickReplyOption[] = [];
  (replies ?? []).forEach((reply, index) => {
    const body = typeof reply === 'string' ? reply.trim() : '';
    if (body.length === 0) return;
    options.push({ index, body });
  });
  return options;
}

/**
 * Pull `action=<id>` out of a URL hash, or null when it carries none. The
 * service worker writes '#action=qr-0'; extra hash params are tolerated.
 */
export function parseActionHash(hash: string): string | null {
  const match = /(?:^#|&)action=([^&]+)/.exec(hash);
  const raw = match?.[1];
  if (raw === undefined) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape is not worth throwing over - the raw value
    // simply will not match an option, and the sheet waits for a tap.
    return raw;
  }
}

/**
 * Resolve an incoming action id to the option it names, or undefined when it
 * names nothing we can send (absent, malformed, or an index the current
 * settings no longer cover).
 */
export function optionForAction(
  options: readonly QuickReplyOption[],
  actionId: string | null | undefined,
): QuickReplyOption | undefined {
  if (typeof actionId !== 'string' || actionId.length === 0) return undefined;
  return options.find((option) => quickReplyActionId(option.index) === actionId);
}
