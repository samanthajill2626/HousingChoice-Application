// Outbound MMS media: direct-to-S3 presign + confirm-transcode (spec 2026-07-16).
// Replaces the busboy through-EC2 /uploads endpoint. Presign mints a grant so the
// BROWSER uploads the original straight to S3 (EC2 byte-free). Confirm decides on
// HeadObject alone whether to flow the original through (gif / small jpeg-png) or
// download + transcode (webp / oversized jpeg-png / pdf) into a deliverable JPEG,
// bounded by a process-wide semaphore. The original is always retained.
//
// PII (doc Sec 9): log s3Key + byte counts + transcodedFrom only; never filenames
// or bytes; presigned URLs are bearer tokens (never logged).
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { isInlineMediaType, planMmsMedia } from '../lib/mediaTypes.js';
import {
  MMS_UPLOAD_SOURCE_MAX_BYTES,
  MMS_TRANSCODE_WAIT_TIMEOUT_MS,
  OUTBOUND_MMS_MAX_FILE_BYTES,
} from '../lib/outboundMediaLimits.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { transcodeForMms } from '../adapters/mediaTranscode.js';
import { sharedTranscodeGate } from '../lib/transcodeGate.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';

const UPLOAD_KEY_RE = /^uploads\/[0-9a-f-]+$/;

// MediaStore.put wants a Readable; wrap the finished transcode buffer.
function bufferToStream(buf: Buffer): Readable {
  return Readable.from([buf]);
}

export interface MmsMediaRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Undefined when MEDIA_BUCKET is unset (the endpoints then answer 503). */
  mediaStore?: MediaStore;
}

export function createMmsMediaRouter(deps: MmsMediaRouterDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const transcodeGate = sharedTranscodeGate;

  const router = Router();

  // Same 30/min per-user fence the busboy endpoint (and unit-photo presign)
  // carried: a cheap mint fence, NOT the memory bound - the semaphore is the
  // concurrency bound. ONE instance per router (per-request would reset it).
  const presignLimiter = createUserRateLimit({
    routeKey: 'mms_media_presign',
    max: 30,
    windowMs: 60_000,
    logger: log,
  });

  // Confirm is the EXPENSIVE endpoint (downloads up to the source cap + burns CPU
  // in sharp/pdfium behind the 2-slot semaphore). The semaphore bounds memory but
  // is the only backpressure - without a per-user fence one caller can keep both
  // slots + both cores pinned and 503 everyone else. A low per-user ceiling caps
  // that cross-user DoS. ONE instance per router.
  const confirmLimiter = createUserRateLimit({
    routeKey: 'mms_media_confirm',
    max: 20,
    windowMs: 60_000,
    logger: log,
  });

  // POST /api/media/presign { contentType } -> { key, post }
  router.post('/presign', presignLimiter, async (req, res) => {
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as { contentType?: unknown };
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
    if (!isInlineMediaType(contentType)) {
      res.status(400).json({ error: 'unsupported_media_type' });
      return;
    }
    const key = `uploads/${randomUUID()}`;
    const post = await mediaStore.createPresignedPost(key, {
      contentType,
      maxBytes: MMS_UPLOAD_SOURCE_MAX_BYTES,
    });
    log.info({ key, contentType }, 'mms media presign minted');
    res.json({ key, post });
  });

  // POST /api/media/confirm { key } -> { attachment }
  router.post('/confirm', confirmLimiter, async (req, res) => {
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as { key?: unknown };
    const key = typeof body.key === 'string' ? body.key : '';
    if (!UPLOAD_KEY_RE.test(key)) {
      res.status(400).json({ error: 'invalid_attachment_key' });
      return;
    }
    const meta = await mediaStore.head(key);
    if (!meta) {
      res.status(400).json({ error: 'unknown_attachment' });
      return;
    }
    const sourceType = (meta.contentType ?? '').trim().toLowerCase();
    const size = meta.size ?? 0;
    const plan = planMmsMedia(sourceType, size);

    if (plan === 'reject') {
      res.status(400).json({ error: 'unsupported_media_type' });
      return;
    }

    if (plan === 'deliver') {
      // gif / small jpeg-png: the original IS the deliverable rendition.
      res.json({ attachment: { s3Key: key, contentType: sourceType, size, originalKey: key } });
      return;
    }

    // transcode-image / transcode-pdf: bounded download + transcode + derivative put.
    let release: (() => void) | undefined;
    try {
      release = await transcodeGate.acquire(MMS_TRANSCODE_WAIT_TIMEOUT_MS);
    } catch {
      res.status(503).json({ error: 'transcode_busy' });
      return;
    }
    try {
      const bytes = await mediaStore.getBytes(key);
      if (!bytes) {
        res.status(400).json({ error: 'unknown_attachment' });
        return;
      }
      const result = await transcodeForMms(bytes, sourceType);
      if (result.bytes.length > OUTBOUND_MMS_MAX_FILE_BYTES) {
        res.status(400).json({ error: 'file_too_large_after_fit' });
        return;
      }
      const deliverableKey = `uploads/${randomUUID()}`;
      await mediaStore.put(deliverableKey, bufferToStream(result.bytes), result.contentType);
      log.info(
        { originalKey: key, deliverableKey, transcodedFrom: result.transcodedFrom, byteCount: result.bytes.length, pdfPageCount: result.pdfPageCount },
        'mms media transcoded',
      );
      res.json({
        attachment: {
          s3Key: deliverableKey,
          contentType: result.contentType,
          size: result.bytes.length,
          originalKey: key,
          transcodedFrom: result.transcodedFrom,
          ...(result.pdfPageCount !== undefined && { pdfPageCount: result.pdfPageCount }),
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err, s3Key: key }, 'mms media transcode failed');
      res.status(400).json({ error: 'transcode_failed', detail });
    } finally {
      release();
    }
  });

  return router;
}
