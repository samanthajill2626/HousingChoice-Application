// Email attachment media: direct-to-S3 presign + confirm (email-channel v1).
// DISTINCT from routes/mmsMedia.ts (review F1): the MMS pipeline is NOT reusable
// because its presign hard-gates on isInlineMediaType (images + pdf only) and its
// confirm ALWAYS runs planMmsMedia, which RASTERIZES a PDF to a JPEG page-1 - that
// would destroy document exchange, the core email use case. Here the browser
// uploads the original straight to S3 (EC2 byte-free) and confirm only
// HEAD-verifies it, then the ORIGINAL is retained VERBATIM: no planMmsMedia, no
// transcode, no derivative put.
//
// PII (doc Sec 9): log s3Key + byte counts only; never filenames or bytes;
// presigned URLs are bearer tokens (never logged).
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { EMAIL_MAX_TOTAL_BYTES, isEmailAttachmentType } from '../lib/mediaTypes.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';
import type { AuthedRequest } from '../middleware/auth.js';

// email-media/<userId>/<uuid>: the userId segment attributes the upload; the
// randomUUID is the unguessable object id. The route mints EXACTLY this shape,
// and confirm rejects anything else so a client can never point us at a foreign
// bucket key (parity with mmsMedia's UPLOAD_KEY_RE).
const EMAIL_MEDIA_KEY_RE = /^email-media\/[^/]+\/[0-9a-f-]+$/;

export interface EmailMediaRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Undefined when MEDIA_BUCKET is unset (the endpoints then answer 503). */
  mediaStore?: MediaStore;
}

export function createEmailMediaRouter(deps: EmailMediaRouterDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });

  const router = Router();

  // Per-user mint/confirm fences (the mmsMedia posture). Confirm here is CHEAP
  // (a single HeadObject - no download, no transcode, no semaphore), so it
  // carries the same 30/min ceiling as presign rather than the tighter MMS one.
  const presignLimiter = createUserRateLimit({
    routeKey: 'email_media_presign',
    max: 30,
    windowMs: 60_000,
    logger: log,
  });
  const confirmLimiter = createUserRateLimit({
    routeKey: 'email_media_confirm',
    max: 30,
    windowMs: 60_000,
    logger: log,
  });

  // POST /api/email-media/presign { contentType, sizeBytes } -> { key, post }
  router.post('/presign', presignLimiter, async (req, res) => {
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as { contentType?: unknown; sizeBytes?: unknown };
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
    if (!isEmailAttachmentType(contentType)) {
      res.status(400).json({ error: 'unsupported_media_type' });
      return;
    }
    const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : NaN;
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      res.status(400).json({ error: 'invalid_size' });
      return;
    }
    if (sizeBytes > EMAIL_MAX_TOTAL_BYTES) {
      res.status(400).json({ error: 'too_large' });
      return;
    }
    const userId = String((req as AuthedRequest).user?.userId ?? 'unknown');
    const key = `email-media/${userId}/${randomUUID()}`;
    // maxBytes is the per-message total cap: S3/MinIO enforces content-length-range
    // [1, maxBytes] at the edge, so an over-size POST stores nothing.
    const post = await mediaStore.createPresignedPost(key, {
      contentType,
      maxBytes: EMAIL_MAX_TOTAL_BYTES,
    });
    log.info({ key, contentType }, 'email media presign minted');
    res.json({ key, post });
  });

  // POST /api/email-media/confirm { key } -> { s3Key, contentType, size }
  router.post('/confirm', confirmLimiter, async (req, res) => {
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as { key?: unknown };
    const key = typeof body.key === 'string' ? body.key : '';
    if (!EMAIL_MEDIA_KEY_RE.test(key)) {
      res.status(400).json({ error: 'invalid_attachment_key' });
      return;
    }
    const meta = await mediaStore.head(key);
    if (!meta) {
      res.status(400).json({ error: 'unknown_attachment' });
      return;
    }
    const contentType = (meta.contentType ?? '').trim().toLowerCase();
    const size = meta.size ?? 0;
    if (!isEmailAttachmentType(contentType)) {
      res.status(400).json({ error: 'unsupported_media_type' });
      return;
    }
    if (size > EMAIL_MAX_TOTAL_BYTES) {
      res.status(400).json({ error: 'too_large' });
      return;
    }
    // Store the ORIGINAL VERBATIM (review F1): the object the browser uploaded IS
    // the attachment. No getBytes, no put, no planMmsMedia - document fidelity.
    log.info({ s3Key: key, contentType, size }, 'email media confirmed');
    res.json({ s3Key: key, contentType, size });
  });

  return router;
}
