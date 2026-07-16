---
id: unit-photo-presign-empty-filetype
title: "Unit-photo presign rejects the WHOLE wave when a browser reports an empty File.type"
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-15
refs: dashboard/src/api/endpoints.ts, dashboard/src/routes/listing/ListingDetail.tsx, app/src/routes/units.ts:460
---

**Problem (review NOTE, 2026-07-15).** The direct-upload presign request sends
`files.map((f) => f.type)` as the content-type list. If a browser reports an
empty string for a file's `type` (rare, but it happens - some OSes/browsers
fail to sniff a MIME type for an image), the server's presign allowlist check
rejects the ENTIRE wave with `400 unsupported_media_type`, not just that one
file. A staff member selecting 10 good photos plus one type-less one gets
nothing uploaded, with a blanket "unsupported type" error.

Not a security issue (the server still enforces the real type at S3 via the
HeadObject re-check on confirm); a UX foot-gun only.

**Suggested fix.** Client: derive a fallback content-type from the file
extension (or the image's sniffed bytes) when `File.type` is empty, before
building the presign request; OR drop the type-less file from the wave with an
inline "skipped N unreadable file(s)" note rather than failing the batch. Keep
the server allowlist strict - the fix is to not send an empty type.
