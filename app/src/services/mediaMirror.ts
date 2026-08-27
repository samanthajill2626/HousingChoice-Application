// The inbound-media MIRROR: fetch a provider media URL as a stream and put it
// under our own S3 key, so the dashboard serves bytes we hold rather than a
// provider URL it never renders. ONE implementation for the webhook (inline,
// fast) and the media.mirror job (deferred, long tail).
//
// WHY A RETRY POLICY (prod, 2026-08-17/18). Twilio serves an inbound MMS's
// media a beat AFTER it fires the message webhook. The webhook fetched once,
// ~140ms after the message existed, got a 404, logged ERROR and kept the
// provider URL - and 2 of the day's 6 inbound MMS lost their photo from the
// thread for good, although both media were present on re-read minutes later.
// So a TRANSIENT failure is retried: a few quick tries here, inside the
// webhook's own budget (Twilio waits 15s for the ack and the mirror runs before
// it), then the job with minutes of tail. A PERMANENT refusal (an SSRF/size
// refusal, any other 4xx) is reported once and never retried.
//
// PII (doc 9): SIDs, indexes and counts only - never the URL or the bytes.
import type { Readable } from 'node:stream';
import {
  MediaFetchHttpError,
  MediaFetchRefusedError,
  type MessagingAdapter,
} from '../adapters/messaging.js';
import type { MediaStore } from '../adapters/mediaStore.js';
import { normalizeStoredMediaType } from '../lib/mediaTypes.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { MediaAttachment } from '../repos/messagesRepo.js';

/**
 * The INLINE tail: 3 tries over ~1.2s per attachment. Long enough for the
 * observed race (~140ms), short enough that a 10-attachment MMS whose media
 * never turns up still acks well inside Twilio's 15s.
 */
export const INLINE_MIRROR_DELAYS_MS: readonly number[] = [400, 800];

export interface MediaMirrorTarget {
  /** Position in the provider's MediaUrl{i} list; part of the S3 key. */
  index: number;
  url: string;
  /** The SENDER-supplied MediaContentType{i}; normalized before storing. */
  contentType?: string | undefined;
}

export interface MediaMirrorDeps {
  adapter: Pick<MessagingAdapter, 'getMediaStream'>;
  mediaStore: Pick<MediaStore, 'put'>;
  logger?: Logger;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MediaMirrorInput {
  conversationId: string;
  messageSid: string;
  targets: MediaMirrorTarget[];
  /** Waits BETWEEN tries; `delaysMs.length + 1` tries per target. */
  delaysMs: readonly number[];
}

export interface MediaMirrorOutcome {
  /** Every target that landed, with the attachment record to persist. */
  attachments: { index: number; attachment: MediaAttachment }[];
  /** Every target that did not, and whether a later attempt could. */
  failed: { index: number; retryable: boolean }[];
}

/** The S3 key an inbound attachment mirrors under - ONE definition. */
export function inboundMediaKey(conversationId: string, messageSid: string, index: number): string {
  return `media/${conversationId}/${messageSid}/${index}`;
}

/**
 * Could a later fetch of the same URL succeed? A 404 is the observed "not
 * served yet" beat; 408/425/429 and 5xx are the provider's own transient
 * family; a thrown fetch (DNS, reset, timeout) is the network's. Everything
 * else is permanent: the SSRF/size refusals by construction, and any other 4xx
 * (401/403 = our credentials, 410 = gone for good, 415...).
 */
export function isRetryableMediaFetchError(err: unknown): boolean {
  if (err instanceof MediaFetchRefusedError) return false;
  if (err instanceof MediaFetchHttpError) {
    const s = err.status;
    return s === 404 || s === 408 || s === 425 || s === 429 || s >= 500;
  }
  // A put that threw (S3 5xx, network) or a fetch that threw before a status.
  return true;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mirror every target, each with its own retry ladder, and report per target.
 * Never throws: a mirror failure must never cost the message it decorates.
 */
export async function mirrorMediaSet(deps: MediaMirrorDeps, input: MediaMirrorInput): Promise<MediaMirrorOutcome> {
  const log = deps.logger ?? defaultLogger;
  const sleep = deps.sleep ?? defaultSleep;
  const out: MediaMirrorOutcome = { attachments: [], failed: [] };
  for (const target of input.targets) {
    const key = inboundMediaKey(input.conversationId, input.messageSid, target.index);
    // Normalize the SENDER-supplied type before storing: keep the allowlist's
    // OWN canonical string when the type resolves to the INLINE tier (raster
    // images + PDF, rendered same-origin) or the DECLARABLE tier (video, audio,
    // vCard, office documents - served truthfully but ALWAYS as a download);
    // collapse everything else to octet-stream, so a script-capable type
    // (text/html, image/svg+xml) never enters S3 metadata (stored-XSS guard;
    // defense-in-depth with the serve-time allowlist). The tier decision lives
    // in lib/mediaTypes.ts (resolveMediaTier) and is the SAME one the serve
    // route makes, so the two can never disagree.
    const contentType = normalizeStoredMediaType(target.contentType);
    let landed = false;
    for (let attempt = 0; attempt <= input.delaysMs.length; attempt += 1) {
      let stream: Readable | undefined;
      try {
        stream = await deps.adapter.getMediaStream(target.url);
        await deps.mediaStore.put(key, stream, contentType);
        out.attachments.push({ index: target.index, attachment: { s3Key: key, contentType } });
        landed = true;
        break;
      } catch (err) {
        // Destroy the source stream so a failed put (S3 5xx, network drop) does
        // not leak the upstream socket/handle - lib-storage will not on a
        // caller stream.
        if (stream !== undefined && !stream.destroyed) stream.destroy();
        const retryable = isRetryableMediaFetchError(err);
        const delay = input.delaysMs[attempt];
        if (retryable && delay !== undefined) {
          log.info(
            { providerSid: input.messageSid, mediaIndex: target.index, attempt: attempt + 1, retryInMs: delay },
            'media mirror: transient fetch failure - retrying',
          );
          await sleep(delay);
          continue;
        }
        out.failed.push({ index: target.index, retryable });
        break;
      }
    }
    if (!landed && !out.failed.some((f) => f.index === target.index)) {
      // Unreachable by construction (the loop either lands or records a
      // failure), kept so a future edit cannot silently drop a target.
      out.failed.push({ index: target.index, retryable: true });
    }
  }
  return out;
}
