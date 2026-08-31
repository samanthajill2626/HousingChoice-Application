---
id: media-mirror-reverts-backfilled-types
title: media.mirror's read-modify-write can silently revert a backfilled content type
type: bug
severity: med
status: open
area: app/media
created: 2026-08-27
refs: app/jobs/mediaMirror.ts:150-160, app/scripts/backfill-media-content-types.ts:555-586
---

**Problem.** The one-time content-type backfill closed the lost-update race on
ITS side: before writing a row it re-reads `media_attachments` and merges the
staged repairs onto the current list by `s3Key`, so an attachment the deferred
`media.mirror` job appended between the Scan and the write is preserved
(`app/scripts/backfill-media-content-types.ts:555-586`).

The other side is unguarded. `media.mirror` does its own
read-modify-write: it reads the message, merges its newly mirrored
attachments into the existing array, and `annotateMessage`s the whole list back
(`app/src/jobs/mediaMirror.ts:150-160`). If it read the row BEFORE the backfill
committed and writes AFTER, its snapshot still carries
`application/octet-stream` for the attachments the backfill just repaired, and
`annotateMessage` SETs `media_attachments` wholesale - so the repair is
reverted.

Neither side notices. The backfill has already counted those attachments in
`written`, and its re-scan predicate is the row's own contentType, so a
re-run would pick them up again only if someone re-runs it. The S3 object keeps
the correct type, so the object and the row disagree until something rewrites
the row.

**How likely.** Small. It needs a `media.mirror` rung for an OLD message
(the backfill only selects octet-stream rows, which are by definition not
recent) to be in flight across the exact moment the backfill writes that same
row. The deferred job's rungs run at +5s/+15s/+45s/+2min after an inbound MMS,
so the exposure is a couple of minutes per affected message.

**Suggested fix.** Give the row write an optimistic-concurrency condition
rather than widening the re-read window. `annotateMessage` could take an
expected-version or a condition on the attachment list, and the backfill could
retry its re-read-and-merge on a conditional-check failure. That closes both
sides with one mechanism, and it is the same shape the repo already uses for
the SID-pointer transaction.

**Workaround until then.** Run the backfill at a quiet hour, and re-run it
afterwards: it is idempotent, and a second pass repairs anything that was
reverted. The report's `written` count is the number to compare between runs -
a non-zero second run is the signal this happened.

Found by the planner's plan-blind adversarial review, run retroactively after
`feat/media-content-type-fidelity` had already merged.
