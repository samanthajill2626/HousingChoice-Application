---
id: unit-photo-oversize-gif-png-flatten
title: A >5MB animated GIF or transparent PNG photo flattens to a static opaque JPEG rendition (recorded decision)
type: decision
severity: low
status: wontfix
area: app
created: 2026-07-21
refs: app/src/adapters/mediaTranscode.ts, app/src/lib/mediaTypes.ts
---

**Behavior.** unit-photo-transcode fits every >5MB source to a JPEG rendition,
so a >5MB animated GIF becomes a static first-frame JPEG and a >5MB
transparent PNG is flattened opaque - while the <=5MB sibling of the same type
passes through untouched. Inconsistent within a type, by design.

**Why accepted (Cameron, 2026-07-21 review N1).** MMS handles GIF differently
- planMmsMedia passes EVERY gif through untouched to preserve animation -
but MMS can afford that because its size budget is enforced at SEND time
(carrier limits), not as a stored invariant. Photos carry a 5MB
stored-photo invariant, so a >5MB GIF passthrough is not available; the
flatten is the coherent choice. (MMS flattens oversize/transparent PNG to
JPEG exactly as the photo path does, so PNG behavior matches across both.)
Listing photos are photographic content; >5MB animated GIFs are a
vanishing edge case.

**Revisit only if** listing media ever legitimately needs animation or
transparency at >5MB source sizes (e.g. a future gif-rendition profile that
re-encodes gif-to-gif under the cap).
