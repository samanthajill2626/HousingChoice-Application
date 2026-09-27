// app/src/routes/serveMediaObject.ts
// Stream ONE media-store object to an authed dashboard response with byte-range
// support. Extracted from GET /api/calls/:callId/recording so the voicemail
// greeting audio route (routes/settings.ts) serves the same way; the recording
// route's behavior (range forwarding, 206/416/404, Accept-Ranges on every
// success, the declared cache posture) is byte-identical to before.
import type { Request, Response } from 'express';
import { RangeNotSatisfiableError, type MediaObject, type MediaStore } from '../adapters/mediaStore.js';
import type { Logger } from '../lib/logger.js';

export interface ServeMediaObjectOptions {
  mediaStore: MediaStore;
  key: string;
  /** Used when the stored object carries no Content-Type. */
  defaultContentType: string;
  /** e.g. 'private, max-age=3600' - the caller states its posture explicitly. */
  cacheControl: string;
  /** The { error } value for a missing object. */
  notFoundError: string;
  log: Logger;
  /** Merged into every log line (IDs only - never bytes, names or URLs). */
  logContext: Record<string, unknown>;
  /** Log texts: WARN object gone, INFO stream start, ERROR mid-stream failure. */
  messages: { missing: string; streaming: string; errored: string };
}

/**
 * A SINGLE well-formed byte range only ("bytes=0-1023", "bytes=1024-",
 * "bytes=-500"). A multi-range value, another unit, or a malformed one is
 * IGNORED and answered with the full 200 - RFC 7233 explicitly lets a server
 * ignore a Range it does not wish to satisfy, and the browser then falls back
 * to a normal read rather than erroring.
 */
function singleByteRange(req: Request): string | undefined {
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range.trim() : undefined;
  return rangeHeader !== undefined && /^bytes=(\d+-\d*|-\d+)$/.test(rangeHeader) ? rangeHeader : undefined;
}

/**
 * Answers the request in full: 200/206 streaming, 416, or 404. Resolves once
 * the body is piped (the response may still be streaming - the caller must not
 * touch `res` afterwards). Any store error other than RangeNotSatisfiableError
 * rejects, for the caller's async handler to surface to Express.
 */
export async function serveMediaObject(req: Request, res: Response, opts: ServeMediaObjectOptions): Promise<void> {
  const { mediaStore, key, log, logContext } = opts;
  const range = singleByteRange(req);
  let object: MediaObject | undefined;
  try {
    object =
      range !== undefined
        ? await mediaStore.getStream(key, { range })
        : await mediaStore.getStream(key);
  } catch (err) {
    if (err instanceof RangeNotSatisfiableError) {
      // 416 must carry the object size so the client can re-ask correctly.
      // HeadObject is best-effort and only on this malformed-client path -
      // a 416 without Content-Range still beats a 500.
      const meta = await mediaStore.head(key).catch(() => undefined);
      res.setHeader('Accept-Ranges', 'bytes');
      if (meta?.size !== undefined) res.setHeader('Content-Range', `bytes */${meta.size}`);
      res.status(416).json({ error: 'range_not_satisfiable' });
      return;
    }
    throw err;
  }
  if (!object) {
    // The caller holds the key but the object is gone (lifecycle/deletion) -
    // 404 rather than a hanging stream.
    log.warn(logContext, opts.messages.missing);
    res.status(404).json({ error: opts.notFoundError });
    return;
  }
  res.setHeader('Content-Type', object.contentType ?? opts.defaultContentType);
  // Accept-Ranges on EVERY successful response (the plain 200 included) is
  // what tells the browser the audio is SEEKABLE. Without it the native
  // scrubber renders but refuses to move - the recording route's original bug.
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', opts.cacheControl);
  if (object.contentLength !== undefined) {
    res.setHeader('Content-Length', String(object.contentLength));
  }
  // DEFENSIVE DEGRADE: a range was forwarded but the store answered without
  // a ContentRange - serve the full 200 rather than a malformed 206.
  if (range !== undefined && object.contentRange !== undefined) {
    res.setHeader('Content-Range', object.contentRange);
    res.status(206);
  }
  log.info(logContext, opts.messages.streaming);
  object.body.on('error', (err) => {
    log.error({ err, ...logContext }, opts.messages.errored);
    res.destroy(err);
  });
  object.body.pipe(res);
}
