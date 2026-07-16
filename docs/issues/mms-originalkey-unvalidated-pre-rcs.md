---
id: mms-originalkey-unvalidated-pre-rcs
title: "MMS attachment originalKey is pattern-validated but not existence-checked; validate before the RCS seam presigns it"
type: improvement
severity: low
status: open
area: app
created: 2026-07-16
refs: app/src/routes/api.ts, app/src/lib/mmsRenditions.ts
---

**Problem (review, 2026-07-16).** `resolveAttachmentKeys` (routes/api.ts)
validates the client-supplied `attachmentOriginalKeys` correctly for what it
claims: the same strict `UPLOAD_KEY_PATTERN` own-prefix check plus a
`length === keys.length` index-alignment check (so `../`, absolute keys, foreign
prefixes, and desync are all rejected). Only `s3Key` (the deliverable rendition)
is HeadObject'd / type-checked; `originalKey` is persisted verbatim.

Today this is INERT and safe: only `s3Key` is ever presigned/served
(`renditionFor('mms', ...)` returns `s3Key`; the send route, relay fan-out, and
retry all presign `s3Key`). But `originalKey` is stored specifically so a FUTURE
RCS channel can presign it. A client can point `attachmentOriginalKeys[i]` at any
existing `uploads/<uuid>` object (e.g. a rejected webp/pdf, or another
attachment's key). When RCS ships and presigns `originalKey`, it could emit an
object that was never confirmed for that attachment.

Note: `originalKey` must NOT be type-checked against the deliverable set - for a
transcoded attachment the original is legitimately a webp/pdf. The right guard is
existence (HeadObject) + own-prefix (prefix is already enforced).

**Suggested fix (REQUIRED before RCS ships).** HeadObject-validate `originalKey`
(existence + own-prefix) - either in `resolveAttachmentKeys` at persist time, or
at the RCS send seam before presigning it. Tracked by the `TODO(mms-originalkey-
unvalidated-pre-rcs)` marker at the `renditionFor` seam.
