---
id: buffertostream-helper-duplicated
title: bufferToStream helper duplicated verbatim in units.ts and mmsMedia.ts (move to a shared lib)
type: debt
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/routes/units.ts, app/src/routes/mmsMedia.ts
---

**Problem.** unit-photo-transcode (2026-07-21) copied the four-line
`bufferToStream(buf: Buffer): Readable` helper (wraps a finished transcode
buffer for MediaStore.put) from routes/mmsMedia.ts into routes/units.ts
verbatim. Two identical private helpers in two routers - harmless today, but
the next media-writing route makes three. Flagged by the 2026-07-21 planner
adversarial review (N4).

**Suggested fix.** Hoist into a shared module (lib/streams.ts, or export it
from adapters/mediaStore.ts beside the interface it serves) and import from
both routes. Pure refactor, no behavior change; fold into the next change
that touches either file rather than merging alone.
