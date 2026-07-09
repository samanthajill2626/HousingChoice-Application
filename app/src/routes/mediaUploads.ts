// Outbound MMS upload endpoint (design Sec 3) - mounted at /api/media, behind
// the /api requireAuth gate. POST /api/media/uploads accepts ONE file field of
// multipart/form-data and streams it STRAIGHT into the private media bucket at a
// server-minted key `uploads/<uuid>` (a namespace distinct from the inbound
// mirror's media/<conversationId>/<sid>/<i>). No whole-file buffering: busboy
// hands us the file as a stream that flows into MediaStore.put (lib-storage
// Upload). Validation: content-type must pass the shared inline allowlist; 5MB
// per-file cap enforced by ABORTING the stream past the limit (the S3 upload is
// aborted too - a truncated stream makes MediaStore.put reject, so no orphan
// partial is committed); empty files are rejected.
//
// PII (doc Sec 9): log the minted key + byte count only - never the filename or
// any request body.
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Router } from 'express';
import busboy from 'busboy';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { isInlineMediaType } from '../lib/mediaTypes.js';
import { OUTBOUND_MMS_MAX_FILE_BYTES } from '../lib/outboundMediaLimits.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';

export interface MediaUploadsRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Undefined when MEDIA_BUCKET is unset (the endpoint then answers 503). */
  mediaStore?: MediaStore;
}

export function createMediaUploadsRouter(deps: MediaUploadsRouterDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });

  const router = Router();

  // Own per-user bucket, 30/min (mirrors the manual-send ceiling). ONE instance
  // created with the router (per-request creation would reset the window).
  const uploadLimiter = createUserRateLimit({
    routeKey: 'media_upload',
    max: 30,
    windowMs: 60_000,
    logger: log,
  });

  router.post('/uploads', uploadLimiter, (req, res) => {
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }

    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: OUTBOUND_MMS_MAX_FILE_BYTES },
      });
    } catch {
      // Not a multipart/form-data request (busboy throws on a bad content-type).
      res.status(400).json({ error: 'expected_multipart' });
      return;
    }

    let sawFile = false;
    let typeRejected = false;
    let limitHit = false;
    let bytes = 0;
    let key: string | undefined;
    let contentType: string | undefined;
    let putPromise: Promise<void> | undefined;
    let putError: unknown;
    let responded = false;

    const finish = async (): Promise<void> => {
      if (responded) return;
      responded = true;
      // Surface the store outcome first: a rejected put (including a
      // limit-triggered abort) must not read as success. The rejection is
      // captured synchronously into putError below, so putPromise itself always
      // resolves - awaiting it here never rejects and is never a momentarily-
      // unhandled rejection.
      if (putPromise) await putPromise;
      if (typeRejected) {
        res.status(400).json({ error: 'unsupported_media_type' });
        return;
      }
      if (limitHit) {
        res.status(413).json({ error: 'file_too_large' });
        return;
      }
      if (!sawFile || bytes === 0) {
        res.status(400).json({ error: 'empty_file' });
        return;
      }
      if (putError !== undefined || key === undefined || contentType === undefined) {
        log.error({ err: putError, byteCount: bytes }, 'media upload: store put failed');
        res.status(502).json({ error: 'upload_failed' });
        return;
      }
      log.info({ s3Key: key, byteCount: bytes }, 'media upload stored');
      res.status(201).json({ key, contentType, size: bytes });
    };

    bb.on('file', (_name, fileStream, info) => {
      if (sawFile) {
        // Extra file fields (files:1 already caps busboy, but be defensive).
        fileStream.resume();
        return;
      }
      sawFile = true;
      const type = typeof info.mimeType === 'string' ? info.mimeType.trim().toLowerCase() : '';
      if (!isInlineMediaType(type)) {
        typeRejected = true;
        fileStream.resume(); // drain so busboy can reach 'close'
        return;
      }
      contentType = type;
      key = `uploads/${randomUUID()}`;
      // Feed the store through a PassThrough WE own, so the size cap can abort
      // the upload by destroying OUR stream - never busboy's file stream (which
      // would throw back into the req->busboy pipe). The put's stream consumer
      // sees the error and rejects (lib-storage aborts any multipart upload), so
      // no orphan partial object is committed.
      const pass = new PassThrough();
      // Async iteration inside MediaStore.put consumes the abort error; a noop
      // listener guards against an 'error' with no listener in edge timings.
      pass.on('error', () => {});
      fileStream.pipe(pass);
      // Capture any put rejection SYNCHRONOUSLY (never a momentarily-unhandled
      // rejection); finish() awaits this resolved promise and reads putError.
      putPromise = mediaStore.put(key, pass, type).then(undefined, (err: unknown) => {
        putError = err;
      });
      fileStream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      fileStream.on('limit', () => {
        // Past the 5MB cap (busboy truncates at fileSize and emits this): stop
        // feeding the store, abort the in-flight put, then drain the truncated
        // remainder so busboy still reaches 'close' cleanly.
        limitHit = true;
        fileStream.unpipe(pass);
        pass.destroy(new Error('file exceeds OUTBOUND_MMS_MAX_FILE_BYTES'));
        fileStream.resume();
      });
    });

    bb.on('error', (err) => {
      log.error({ err }, 'media upload: multipart parse error');
      if (!responded) {
        responded = true;
        res.status(400).json({ error: 'upload_parse_error' });
      }
    });

    bb.on('close', () => {
      void finish();
    });

    req.pipe(bb);
  });

  return router;
}
