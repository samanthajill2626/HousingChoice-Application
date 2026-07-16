---
id: mms-uploads-no-lifecycle-orphans
title: "MMS uploads/ prefix accumulates orphan objects (no S3 lifecycle; transcode confirm is non-idempotent)"
type: improvement
severity: low
status: open
area: infra
created: 2026-07-16
refs: app/src/routes/mmsMedia.ts, infra/modules/s3_media/main.tf
---

**Problem (review, 2026-07-16).** The outbound-MMS media flow leaves orphaned
objects under the `uploads/` prefix and nothing ages them out:

- Every transcode `POST /api/media/confirm` PUTs a FRESH `uploads/<uuid>`
  derivative and always retains the original, so a REPLAYED confirm on the same
  source key mints a duplicate derivative (the transcode path is not idempotent;
  the flow-through path is - it returns the original key). Abandoned confirms and
  sends that fail the send-route guard also orphan objects.
- `infra/modules/s3_media` has NO `aws_s3_bucket_lifecycle_configuration`, and
  bucket versioning is enabled, so nothing ever expires.

Blast radius is confined to `uploads/` (own-prefix), and every original is
retained by design (RCS-forward + record), so this is cost/hygiene, not a
security or correctness hole. It matches the unit-photos "orphans decay as
accepted" posture EXCEPT there is no lifecycle rule to actually make them decay.

**Suggested fix.** Add an `aws_s3_bucket_lifecycle_configuration` to the
`s3_media` module expiring the `uploads/` prefix (e.g. 7-30 days), plus
`abort_incomplete_multipart_upload`. This is an infra change (terraform apply,
gated) - not done in the feature branch. Optionally make the transcode confirm
idempotent by keying the derivative on a content hash of the source, so a replay
returns the existing derivative instead of minting a new one.
