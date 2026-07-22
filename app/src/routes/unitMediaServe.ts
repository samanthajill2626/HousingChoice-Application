// GET /unit-media/<unitId>/<object> - same-origin unit-photo serving
// (design docs/superpowers/specs/2026-07-21-unit-media-cloudfront-design.md).
// In deployed envs CloudFront's /unit-media/* behavior (S3 origin + OAC)
// serves these objects WITHOUT reaching the app - this route is the fallback
// that makes every non-CloudFront environment work (local MinIO, hermetic
// e2e, live-mode local dev) and covers a deploy-before-apply window.
//
// PUBLIC READ POSTURE - KNOWN AND DESIGNED (spec D5, Cameron 2026-07-21):
// unauthenticated by design. Unit photos are public-flyer content; keys are
// unguessable server-minted uuids. Namespace scoping is enforced by SHAPE
// (exactly two safe segments after /unit-media/), so the PII namespaces
// (media/, recordings/, uploads/) can never be addressed through this route,
// matching CloudFront, whose behavior+OAC grant cover unit-media/* only.
//
// INLINE-TYPE HARDENING - rationale docs/issues/media-serve-stored-xss.md: the
// same stored-XSS defense the MMS media route (routes/api.ts) applies. Serve
// INLINE only for the raster-image allowlist (isImageMediaType); force anything
// else to an octet-stream ATTACHMENT, and stamp nosniff + a locked-down CSP on
// every response. Upload pins each object's Content-Type to the image allowlist
// at mint time, so a non-image type should never exist here - belt-and-suspenders.
import { Router } from 'express';
import type { MediaStore } from '../adapters/mediaStore.js';
import type { Logger } from '../lib/logger.js';
import { isImageMediaType } from '../lib/mediaTypes.js';
// One SHARED per-segment guard (review C1): the SAME check resolveUnitMedia uses
// when emitting display URLs, so this route and the URL emitter never disagree on
// what a valid key is. See lib/unitMedia.ts.
import { isSafeUnitMediaSegment } from '../lib/unitMedia.js';

/** Parity with the CloudFront response-headers policy (7 days, immutable keys). */
const UNIT_MEDIA_CACHE_CONTROL = 'public, max-age=604800';

export function createUnitMediaServeRouter(deps: {
  mediaStore?: MediaStore;
  logger: Logger;
}): Router {
  const { mediaStore, logger: log } = deps;
  const router = Router();

  router.get('/:unitId/:object', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const object = String(req.params['object'] ?? '');
    if (!isSafeUnitMediaSegment(unitId) || !isSafeUnitMediaSegment(object)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!mediaStore) {
      // Same posture as photos/presign: storage is not configured here.
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const key = `unit-media/${unitId}/${object}`;
    const object_ = await mediaStore.getStream(key);
    if (!object_) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Content-Type is trusted-by-construction (pinned to the image allowlist
    // by the presigned-POST policy at upload) - the non-image branch is
    // belt-and-suspenders, mirroring the MMS media route's XSS hardening.
    const stored = object_.contentType;
    const inline = isImageMediaType(stored);
    res.setHeader('Content-Type', inline ? stored! : 'application/octet-stream');
    if (!inline) {
      res.setHeader('Content-Disposition', 'attachment; filename="unit-media"');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', UNIT_MEDIA_CACHE_CONTROL);
    if (object_.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object_.contentLength));
    }
    object_.body.on('error', (err) => {
      log.error({ err, unitId }, 'unit media: stream errored mid-flight');
      res.destroy(err);
    });
    object_.body.pipe(res);
  });

  return router;
}
