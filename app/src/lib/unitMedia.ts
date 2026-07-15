// Property-photo (unit media) shared constants + display resolution (design
// spec 2026-07-15, S1/S3). The storage field stays `unit.media: string[]`:
// stored S3 keys (the primary case, minted at upload) OR legacy absolute URLs
// (tolerated, render-only). First entry = cover.
//
// PRESIGN PER READ (D5): a stored key is resolved to a short-lived presigned
// GET URL at SERVE time and NEVER persisted - the same presign-per-attempt rule
// the MMS send path follows, applied to reads. A per-entry presign failure
// degrades that entry to url-absent (never 500s the read - E4).
import type { MediaStore } from '../adapters/mediaStore.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import type { UnitItem } from '../repos/unitsRepo.js';

/**
 * Photos per unit cap. This is an ABUSE / RUNAWAY BACKSTOP, not a product limit
 * (D3): there is no hard technical constraint - a key is ~60B against a 400KB
 * item, and presigning is local SigV4 signing (no S3 round trip). Raise it the
 * day someone legitimately hits it.
 */
export const UNIT_MEDIA_MAX = 100;

/**
 * Presign TTL for a property photo served to the staff gallery or the public
 * flyer: 1 hour (the same short-lived exposure class the outbound-MMS presign
 * uses). Long enough to render a page, short enough that a leaked URL expires.
 */
export const UNIT_MEDIA_PRESIGN_TTL_SECONDS = 3600;

/**
 * Aggregate in-memory bytes ONE photo-upload request may buffer (review
 * hardening, 2026-07-15). The route buffers the whole validated batch before
 * any S3 put (E3), so per-request memory = sum of file sizes; without this cap
 * the bound was 5MB x 100 files = ~500MB per request on a 2GB single-process
 * box. 60MB comfortably fits the dashboard's 10-file upload batches (10 x 5MB
 * = 50MB) while keeping the per-request worst case small.
 */
export const UNIT_PHOTO_MAX_REQUEST_BYTES = 60 * 1024 * 1024;

/**
 * Concurrent photo-upload REQUESTS the app process admits (review hardening,
 * 2026-07-15). The 30/min per-user limiter counts requests per MINUTE, not
 * concurrency - without this gate ~30 buffering uploads could be in flight at
 * once (30 x 60MB = 1.8GB, i.e. the whole t4g.small). 3 concurrent x 60MB caps
 * photo-upload memory at ~180MB while never queueing a human (the dashboard
 * uploads batches SEQUENTIALLY, so one operator occupies one slot).
 */
export const UNIT_PHOTO_MAX_CONCURRENT_UPLOADS = 3;

/** The prefix all stored (non-URL) media entries for a unit must live under. */
export function unitMediaPrefix(unitId: string): string {
  return `unit-media/${unitId}/`;
}

/** One resolved gallery entry: the durable handle + its display URL when resolvable. */
export interface UnitMediaDisplay {
  /** The raw `unit.media` entry (an S3 key or a legacy URL) - the management handle. */
  entry: string;
  /** The display URL (presigned for a stored key, pass-through for a URL). Absent = unresolvable. */
  url?: string;
}

/** An absolute http(s) URL passes through unresolved; anything else is a stored key. */
function isAbsoluteUrl(entry: string): boolean {
  return /^https?:\/\//i.test(entry);
}

/**
 * Resolve a unit's `media` entries to display URLs (S3, design spec S3). Stored
 * keys presign fresh (TTL 1h); absolute URLs pass through; a per-entry presign
 * failure degrades to a url-absent entry (logged WARN, never thrown - E4). When
 * `mediaStore` is undefined (local loop with no S3), stored keys resolve to
 * url-absent and only legacy URLs carry through.
 *
 * PRESIGN-PER-READ: never persist the returned URLs - this runs per request.
 */
export async function resolveUnitMedia(
  mediaStore: MediaStore | undefined,
  unit: Pick<UnitItem, 'unitId' | 'media'>,
  opts: { logger?: Logger; unitId?: string } = {},
): Promise<UnitMediaDisplay[]> {
  const log = opts.logger ?? defaultLogger;
  const media = Array.isArray(unit.media)
    ? unit.media.filter((e): e is string => typeof e === 'string' && e.length > 0)
    : [];
  const ownPrefix = unitMediaPrefix(unit.unitId);
  return Promise.all(
    media.map(async (entry): Promise<UnitMediaDisplay> => {
      if (isAbsoluteUrl(entry)) return { entry, url: entry };
      if (!mediaStore) return { entry };
      // NAMESPACE SCOPING (review hardening, 2026-07-15): presign ONLY keys
      // under THIS unit's own `unit-media/<unitId>/` prefix. `media` stays
      // PATCH-writable (the raw seam, E5) and the bucket is SHARED with the MMS
      // attachment namespaces - without this check a foreign key (an MMS
      // `uploads/<uuid>` attachment, or another unit's photo) pasted into
      // `media` would be presigned onto the PUBLIC flyer. A foreign key
      // degrades to url-absent, exactly like a presign failure.
      if (!entry.startsWith(ownPrefix)) {
        log.warn(
          { unitId: unit.unitId },
          'unit media: entry outside the unit media namespace - not presigned',
        );
        return { entry };
      }
      try {
        const url = await mediaStore.presign(entry, UNIT_MEDIA_PRESIGN_TTL_SECONDS);
        return { entry, url };
      } catch (err) {
        // E4: a presign failure degrades this ONE entry (no url) - never 500s
        // the unit read or the flyer. Log the fact only (never the URL).
        log.warn({ err, ...(opts.unitId !== undefined && { unitId: opts.unitId }) }, 'unit media: presign failed (entry degraded)');
        return { entry };
      }
    }),
  );
}
