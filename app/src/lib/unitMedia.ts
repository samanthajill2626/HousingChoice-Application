// Property-photo (unit media) shared constants + display resolution (design
// spec 2026-07-15, S1/S3; same-origin reads 2026-07-21). The storage field
// stays `unit.media: string[]`: stored S3 keys (the primary case, minted at
// upload) OR legacy absolute URLs (tolerated, render-only). First entry = cover.
//
// SAME-ORIGIN READS (design 2026-07-21): a stored key resolves to the STABLE
// relative URL `/` + key (e.g. `/unit-media/<unitId>/<uuid>`) - the path IS the
// S3 object key. CloudFront's `/unit-media/*` behavior serves it straight from
// the bucket (OAC) in deployed envs; the app's own GET /unit-media route streams
// it everywhere else. Deterministic and cache-friendly: no media store, no async
// S3 call, no TTL, never a presigned/expiring URL (presign-per-read is retired).
// A foreign / out-of-namespace key still degrades to url-absent with a WARN.
// resolveUnitMedia below is store-independent; the MediaStore import feeds the
// deleteRemovedUnitMedia helper (best-effort S3 cleanup on photo removal, D1).
import type { MediaStore } from '../adapters/mediaStore.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import type { UnitItem } from '../repos/unitsRepo.js';

/**
 * Photos per unit cap. This is an ABUSE / RUNAWAY BACKSTOP, not a product limit
 * (D3): there is no hard technical constraint - a key is ~60B against a 400KB
 * item, and display resolution is a trivial local string build (no S3 round
 * trip). Raise it the day someone legitimately hits it.
 */
export const UNIT_MEDIA_MAX = 100;

/** The prefix all stored (non-URL) media entries for a unit must live under. */
export function unitMediaPrefix(unitId: string): string {
  return `unit-media/${unitId}/`;
}

/** One resolved gallery entry: the durable handle + its display URL when resolvable. */
export interface UnitMediaDisplay {
  /** The raw `unit.media` entry (an S3 key or a legacy URL) - the management handle. */
  entry: string;
  /** The display URL (same-origin `/`+key for a stored key, pass-through for a URL). Absent = unresolvable. */
  url?: string;
}

/** An absolute http(s) URL passes through unresolved; anything else is a stored key. */
function isAbsoluteUrl(entry: string): boolean {
  return /^https?:\/\//i.test(entry);
}

/**
 * Resolve a unit's `media` entries to display URLs (design 2026-07-21). A stored
 * key under THIS unit's own namespace resolves to the stable same-origin URL
 * `/` + key; absolute URLs pass through; a foreign / out-of-namespace key
 * degrades to a url-absent entry (logged WARN, never thrown - E4). SYNC and
 * deterministic: no media store, no S3 round trip, no TTL. A key that cannot be
 * served yields the same visible outcome as before (the URL simply 404s at the
 * serve route, an absent image) - minus the per-read presigning.
 */
export function resolveUnitMedia(
  unit: Pick<UnitItem, 'unitId' | 'media'>,
  opts: { logger?: Logger } = {},
): UnitMediaDisplay[] {
  const log = opts.logger ?? defaultLogger;
  const media = Array.isArray(unit.media)
    ? unit.media.filter((e): e is string => typeof e === 'string' && e.length > 0)
    : [];
  const ownPrefix = unitMediaPrefix(unit.unitId);
  return media.map((entry): UnitMediaDisplay => {
    if (isAbsoluteUrl(entry)) return { entry, url: entry };
    // NAMESPACE SCOPING (review hardening, 2026-07-15): only keys under THIS
    // unit's own `unit-media/<unitId>/` prefix become URLs. `media` stays
    // PATCH-writable (the raw seam, E5) and the bucket is SHARED with the MMS
    // attachment namespaces - without this check a foreign key (an MMS
    // `uploads/<uuid>` attachment, or another unit's photo) pasted into `media`
    // would be emitted as a served URL onto the PUBLIC flyer. A foreign key
    // degrades to url-absent.
    if (!entry.startsWith(ownPrefix)) {
      log.warn(
        { unitId: unit.unitId },
        'unit media: entry outside the unit media namespace - no display URL',
      );
      return { entry };
    }
    // SAME-ORIGIN URL (design 2026-07-21): the path IS the S3 object key. Served
    // by CloudFront's /unit-media/* behavior in deployed envs and by the app's
    // GET /unit-media route everywhere else. Stable and cache-friendly - never a
    // presigned, expiring URL.
    return { entry, url: `/${entry}` };
  });
}

/**
 * Best-effort S3 cleanup for entries REMOVED from unit.media (design 2026-07-21,
 * D1). Deletes ONLY stored keys inside THIS unit's own namespace - legacy
 * absolute URLs and foreign keys (an MMS uploads/ attachment, another unit's
 * photo) are never deleted. Fire-and-forget: every failure is a WARN and the
 * caller's response is never affected. A removed photo may keep serving from
 * CloudFront edge caches up to the 7-day TTL (accepted; manual invalidation is
 * the operator escape hatch). No-op when no media store is configured.
 *
 * PII posture (matches units.ts): the WARN logs { err, unitId } ONLY - never the
 * key or URL.
 */
export function deleteRemovedUnitMedia(
  mediaStore: MediaStore | undefined,
  unitId: string,
  removedEntries: string[],
  logger?: Logger,
): void {
  const log = logger ?? defaultLogger;
  if (!mediaStore) return;
  const ownPrefix = unitMediaPrefix(unitId);
  for (const entry of removedEntries) {
    if (isAbsoluteUrl(entry) || !entry.startsWith(ownPrefix)) continue;
    void mediaStore.deleteObject(entry).catch((err: unknown) => {
      log.warn({ err, unitId }, 'unit media: best-effort object delete failed (orphan remains)');
    });
  }
}
