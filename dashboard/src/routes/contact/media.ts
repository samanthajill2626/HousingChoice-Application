// media - the contact file's "Media from comms" gallery items.
//
// 2026-08-18: the gallery is fed by GET /api/contacts/:id/media (the media
// pointer index, paged by cursor - see useContactMedia), no longer derived from
// the loaded timeline page. Deriving it from the timeline meant an attachment
// older than the loaded page (50 items) was simply not in the gallery; the
// index has no such horizon. The two URL helpers stay here because the
// timeline bubbles use them too - there is ONE way to address a mirrored
// attachment: the authed, same-origin GET /api/messages/:sid/media/:index.
import type { ContactMediaItem, TimelineMessage } from '../../api/index.js';

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

/** One gallery item from one indexed attachment: the same key/src shape the
 *  bubbles use, so a thumbnail and its bubble address the same bytes. */
export function toCommsMediaItem(item: ContactMediaItem): CommsMediaItem {
  return {
    key: `${item.providerSid}:${item.index}`,
    src: messageMediaSrc(item.providerSid, item.index),
    contentType: item.contentType,
    at: item.at,
  };
}
