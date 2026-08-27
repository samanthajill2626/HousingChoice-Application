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

// --- Type tiers, MIRRORED from app/src/lib/mediaTypes.ts -------------------
// The dashboard cannot import from app/, so these are copies. THREE things are
// mirrored, not one, because the label rules below are tier-based:
//   1. the raster types the browser can decode inline,
//   2. which types are "declarable" (typed, but downloaded), and
//   3. a kind word per declarable type.
//
// A media-type PREFIX test is NOT a substitute for 2 and 3: it collides on
// application/octet-stream against the OOXML application/... types, and on
// text/vcard against text/plain. Source of truth: app/src/lib/mediaTypes.ts.

/** Everything before the first `;`, trimmed and lowercased. */
function essenceOf(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/** The raster types a browser renders in an <img>. NOT the server's inline
 *  allowlist, which also contains application/pdf - a PDF is a file link
 *  here. */
const INLINE_RENDERABLE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Declarable type -> the word we put in front of the positional fallback. */
const KIND_WORDS: ReadonlyMap<string, string> = new Map([
  ['video/mp4', 'Video'],
  ['video/quicktime', 'Video'],
  ['video/3gpp', 'Video'],
  ['video/3gpp2', 'Video'],
  ['video/webm', 'Video'],
  ['audio/mpeg', 'Audio'],
  ['audio/mp4', 'Audio'],
  ['audio/aac', 'Audio'],
  ['audio/ogg', 'Audio'],
  ['audio/amr', 'Audio'],
  ['audio/wav', 'Audio'],
  ['image/heic', 'Image'],
  ['image/heif', 'Image'],
  ['image/bmp', 'Image'],
  ['image/tiff', 'Image'],
  ['text/vcard', 'Contact card'],
  ['text/x-vcard', 'Contact card'],
  ['text/plain', 'Document'],
  ['text/csv', 'Document'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Document'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Document'],
]);

/** True when this attachment can be shown in an <img>. */
export function isInlineRenderable(contentType: string): boolean {
  return INLINE_RENDERABLE_TYPES.has(essenceOf(contentType));
}

/** The kind word for a declarable type; undefined on the opaque tier, where we
 *  genuinely do not know what the file is and must not pretend. */
export function mediaKindWord(contentType: string): string | undefined {
  return KIND_WORDS.get(essenceOf(contentType));
}

/** True when the server will serve this type truthfully (declarable tier).
 *  Every declarable type has a kind word, so this shares the map - but callers
 *  asking a yes/no question get a yes/no answer rather than a label. */
export function isDeclarableMediaType(contentType: string): boolean {
  return KIND_WORDS.has(essenceOf(contentType));
}
