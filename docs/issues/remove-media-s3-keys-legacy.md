---
id: remove-media-s3-keys-legacy
title: Retire the legacy media_s3_keys field (pre-media_attachments) once data is migrated
type: debt
severity: low
status: open
area: app/messages
created: 2026-06-18
refs: app/src/repos/messagesRepo.ts:238, app/src/routes/api.ts, dashboard/src/api/types.ts
---

**Problem.** `media_s3_keys` is a `@deprecated` legacy parallel key array, superseded by
`media_attachments`. It's read only via `mediaAttachmentsOf()`, which folds it into the new
shape (as `application/octet-stream`) for backward compatibility with pre-migration records.

**Suggested fix.** Once any pre-`media_attachments` message records are migrated (or aged
out), remove the field and its compat handling:
- the field + `@deprecated` on `MessageItem` (`app/src/repos/messagesRepo.ts:238`);
- the `media_s3_keys` fold in `mediaAttachmentsOf()`;
- the reads in `app/src/routes/api.ts` (media-serve legacy fallback) and tests
  (`apiRoutes.test.ts`, `contactMedia.test.ts`, `mediaAttachments.test.ts`);
- the mirrored field in `dashboard/src/api/types.ts` (the legacy dashboard that also
  mirrored it has since been deleted) + `MessageBubble.tsx`.

**Gated on a data migration** — don't remove the read path while old records still carry
only `media_s3_keys`. Low priority.

Graduated 2026-06-18 from `@deprecated` JSDoc tags (non-TODO flag sweep).
