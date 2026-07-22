---
id: shared-transcode-gate-couples-mms-and-photo-availability
title: Shared 2-slot transcode gate couples MMS media confirm availability to unit-photo transcode load (mutual 503 under saturation)
type: debt
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/lib/transcodeGate.ts, app/src/routes/mmsMedia.ts, app/src/routes/units.ts
---

**Problem.** unit-photo-transcode (2026-07-21) moved the MMS confirm's
router-local 2-slot transcode semaphore into ONE process-wide shared gate
(lib/transcodeGate.ts) so photo and MMS transcodes share a single raster
memory bound - deliberate, and correct for the 2GB box. The flip side is
availability coupling that did not exist before: a burst of >5MB photo
confirms (each slot holds a full source download + a sharp run, up to ~200MB
raster at the photo profile's 50MP cap) can hold both slots past the 20s
acquire timeout, so a concurrent MMS media confirm - part of the MESSAGE SEND
flow - returns 503 transcode_busy, and vice versa. Per-user limiters bound a
single abuser but several staff uploading big photos concurrently can
legitimately saturate 2 slots. Degrades to a retryable 503 with honest copy;
no data loss. Flagged by the 2026-07-21 planner adversarial review (P1);
Cameron chose to track it as a known issue rather than change the design.

**Suggested fix.** If it bites in practice: add a third slot (memory math:
3 x ~200MB peak raster on the 2GB box is tight but survivable now that
sharp.concurrency(1) keeps per-slot working memory flat), or split into two
gates with a shared parent bound, or reserve one slot for MMS (photo
transcodes may only take the second slot when the first is free). Revisit
with real contention data (the 503s log with route + unitId/key counts).
