// media — deriving the contact's "Media from comms" gallery from the SAME
// timeline the comms pane renders. Sourcing it here (not the one-shot
// /api/contacts/:id/media slice) means it updates LIVE as messages arrive: the
// timeline refetches on SSE message.persisted, so a just-sent MMS shows up in the
// gallery without a reload. Reuses the bubbles' authed media URL so there's one
// way to address a mirrored attachment.
import type { TimelineItem, TimelineMessage } from '../../api/index.js';

/** The provider SID is the suffix of tsMsgId (`<provider_ts>#<sid>`). Empty when
 *  it can't be derived — then there's no servable media URL for that message. */
export function messageSid(msg: Pick<TimelineMessage, 'tsMsgId'>): string {
  const { tsMsgId } = msg;
  return tsMsgId.includes('#') ? tsMsgId.slice(tsMsgId.indexOf('#') + 1) : '';
}

/** Authed, same-origin URL for a mirrored attachment (the session cookie rides
 *  along) — never the provider URL or a data: URI. */
export function messageMediaSrc(sid: string, index: number): string {
  return `/api/messages/${encodeURIComponent(sid)}/media/${index}`;
}

export interface CommsMediaItem {
  /** Stable React key + identity (sid:index). */
  key: string;
  src: string;
  contentType: string;
  /** ISO instant of the carrying message (for newest-first ordering). */
  at: string;
}

/** Flatten every message attachment in the timeline into a newest-first media
 *  list for the "Media from comms" gallery. Skips messages whose SID can't be
 *  derived (no servable URL). */
export function commsMedia(items: TimelineItem[]): CommsMediaItem[] {
  const out: CommsMediaItem[] = [];
  for (const item of items) {
    if (item.kind !== 'message') continue;
    const attachments = item.media_attachments ?? [];
    if (attachments.length === 0) continue;
    const sid = messageSid(item);
    if (sid.length === 0) continue;
    attachments.forEach((att, i) => {
      out.push({
        key: `${sid}:${i}`,
        src: messageMediaSrc(sid, i),
        contentType: att.contentType,
        at: item.at,
      });
    });
  }
  // Newest first (the gallery leads with the most recent media).
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
