// Cross-workspace media-type MIRROR DRIFT GUARD.
//
// dashboard/src/routes/contact/media.ts HAND-COPIES two collections from
// app/src/lib/mediaTypes.ts (the dashboard is a separate package and cannot
// import app code at runtime). media.test.ts spot-checks individual entries;
// nothing compared the SETS, so the header's "Source of truth:
// app/src/lib/mediaTypes.ts" was a comment rather than a constraint.
//
// THIS IS THE DEFECT THE FEATURE ITSELF FIXED. Both galleries used to branch on
// `contentType.startsWith('image/')`, which agreed with the server allowlist
// right up until the server began storing `image/heic` - at which point the
// dashboard rendered a broken <img>. Replacing one un-pinned copy with two
// un-pinned copies would leave the same hole: add `image/avif` to
// IMAGE_MEDIA_TYPES and the app's own guardrail test still passes, the server
// serves it inline, and the gallery silently shows a file tile for a perfectly
// renderable photo.
//
// MECHANISM: the same one app/test/consentDrift.test.ts uses for the consent
// strings - import both copies and compare the RESOLVED values. DIRECTION is
// the other way round, deliberately: this test lives in the DASHBOARD workspace
// because the app's test tsconfig has no `jsx` option, so pulling
// contact/media.ts into it would drag the dashboard's api barrel - and the .tsx
// module it re-exports - into `npm run typecheck` and fail it. The app module
// imported here is a near-leaf (one pure constants import), so the traffic goes
// the cheap way.
import { describe, expect, it } from 'vitest';
import {
  DECLARABLE_MEDIA_TYPES,
  IMAGE_MEDIA_TYPES,
} from '../../../../app/src/lib/mediaTypes.js';
import { INLINE_RENDERABLE_TYPES, KIND_WORDS } from './media.js';

/** Sorted, so a comparison failure names the exact type that drifted. */
const sorted = (types: Iterable<string>): string[] => [...types].sort();

describe('dashboard media type tiers mirror app/src/lib/mediaTypes.ts', () => {
  it('the inline-renderable set IS the app IMAGE set - not the app INLINE set', () => {
    // The divergence from INLINE_MEDIA_TYPES is DELIBERATE and must stay: the
    // server serves application/pdf inline (a browser's PDF viewer sandboxes
    // it), while the dashboard shows a PDF as a file link because an <img>
    // cannot decode one. IMAGE_MEDIA_TYPES is the set of things a browser can
    // actually put in an <img>, which is the question this predicate asks.
    expect(sorted(INLINE_RENDERABLE_TYPES)).toEqual(sorted(IMAGE_MEDIA_TYPES));
    expect(INLINE_RENDERABLE_TYPES.has('application/pdf')).toBe(false);
  });

  it('the kind-word map covers EXACTLY the app declarable set', () => {
    // Both directions matter. A type the app declares and the dashboard does
    // not gets no kind word and reads as an unknown "Attachment N"; a type the
    // dashboard names and the app does not is a label for a file the server
    // still serves as an opaque download - the dashboard pretending to know
    // what it is.
    expect(sorted(KIND_WORDS.keys())).toEqual(sorted(DECLARABLE_MEDIA_TYPES));
  });

  it('does not compare two empty sets', () => {
    // The floor that stops the two assertions above passing VACUOUSLY if an
    // import ever resolves to an empty namespace.
    expect(IMAGE_MEDIA_TYPES.size).toBeGreaterThan(0);
    expect(DECLARABLE_MEDIA_TYPES.size).toBeGreaterThan(0);
  });
});
