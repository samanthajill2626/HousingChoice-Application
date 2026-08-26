# Inbound media content-type fidelity - design

Date: 2026-08-26
Status: DRAFT (spec review)
Branch: `feat/media-content-type-fidelity` (cut from `main` @3c2962a4)

## 1. Problem

Media that arrives from a contact - a photo, video, document or contact card
texted into a 1:1 thread or a relay group - is served back to the dashboard as
`application/octet-stream` with a `Content-Disposition` filename of
`attachment-<idx>` that carries NO file extension. The browser is told nothing
useful in either channel, so clicking the attachment link deposits an inert,
untyped, extensionless blob that the operating system cannot open.

Reported from production 2026-08-26 against a relay thread; the label the
dashboard shows for such an attachment is the positional fallback
"Attachment 1".

This is NOT relay-specific. The relay conversation view reuses the shared
`Timeline` / `AttachmentGallery` (`dashboard/src/routes/conversation/ConversationDetail.tsx:32`),
and the media mirror is explicitly shared by the 1:1, relay and carrier-group
inbound paths. Relay is simply where it was noticed.

## 2. Root cause

Two defects, stacked. Both are reachable by construction, neither is timing
dependent.

### 2.1 The stored Content-Type is destroyed at mirror time

`services/mediaMirror.ts:104` stores
`normalizeStoredMediaType(target.contentType)`, and that helper
(`lib/mediaTypes.ts:56`) keeps a type ONLY when it is on
`INLINE_MEDIA_TYPES` (jpeg, png, gif, webp, pdf) and collapses everything else
to `application/octet-stream`. The sender's real type is written nowhere else,
so it is gone the moment the object lands in S3.

That collapse is the write-side half of the stored-XSS fix recorded in
`docs/issues/media-serve-stored-xss.md`, and its reasoning is sound: inbound
`MediaContentType{i}` describes content chosen by a third party, and a
same-origin `text/html` render is script execution in the dashboard origin.
The defect is that the rule was written for SERVING and took NAMING and
DECLARING down with it. "Unsafe to render" and "unsafe to declare" are not the
same question: `video/mp4`, `image/heic`, `text/vcard` and the OOXML documents
are not script-capable and cannot achieve same-origin execution.

### 2.2 The serve route names the download with no extension

`routes/api.ts:2295`:

```
res.setHeader('Content-Disposition', `attachment; filename="attachment-${idx}"`);
```

No extension - which is what actually breaks opening the saved file, because
Windows and macOS dispatch on extension, not on the MIME type the server sent.
The route also ignores `attachments[idx].filename`, which is in scope on the
line above and IS populated for email attachments. So an inbound email
attachment displays in the timeline as `budget.xlsx`
(`Timeline.tsx:614-617`) and downloads as `attachment-0`.

The outbound email send path already solved exactly this problem one channel
over - `services/sendEmailMessage.ts:225-235` maps content type to extension
and synthesizes `attachment-1.pdf`, with `.bin` as the fallback. The inbound
serve route never got the equivalent.

## 3. Decisions (locked by the human, 2026-08-26)

- D1. Non-inline media is served with its TRUE Content-Type plus
  `Content-Disposition: attachment` and a correct extension. It is NOT rendered
  in our origin. The inline-render allowlist stays exactly
  jpeg/png/gif/webp/pdf. Inline playback of video and audio was considered and
  deliberately NOT taken; it remains a one-line set change if wanted later.
- D2. The production repair re-reads original types from Twilio AND rewrites
  the stored S3 objects' Content-Type, not only the DynamoDB index rows. The
  cost was stated at decision time: the serve route's inline check currently
  runs on the S3 object's own normalized type, so that check stops being a
  second independent layer once objects carry wider types. Section 7 states how
  the guarantee is preserved instead.
- D3. Relay FORWARDING of non-image media is out of scope and gets an issue.

D2 makes the design smaller than it would otherwise have been. With the S3
object carrying a truthful type, the object's own Content-Type is again the
single source of truth: no new `originalContentType` field is added, old and
new rows converge on one shape, and the recovered data lands where a future
forwarding fix would need it.

## 4. Non-goals

- No inline rendering of anything beyond today's five types.
- No change to the outbound MMS upload allowlist, the outbound send path, unit
  photos, or call recordings.
- No relay forwarding fix (D3).
- No promotion of legacy `media_s3_keys` rows to `media_attachments` (see
  section 8.5 and `docs/issues/remove-media-s3-keys-legacy.md`).
- No transcoding of any kind.

## 5. Type tiers

Three tiers, one source of truth, in `lib/mediaTypes.ts`.

| Tier | Set | Response Content-Type | Disposition | Filename |
|---|---|---|---|---|
| Inline | `INLINE_MEDIA_TYPES` (unchanged) | the stored type | `inline` | typed |
| Declarable | `DECLARABLE_MEDIA_TYPES` (new) | the stored type | `attachment` | typed |
| Opaque | everything else | `application/octet-stream` | `attachment` | `.bin` |

`DECLARABLE_MEDIA_TYPES` (proposed; a closed allowlist, never a denylist):

- video: `video/mp4`, `video/quicktime`, `video/3gpp`, `video/3gpp2`, `video/webm`
- audio: `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg`, `audio/amr`, `audio/wav`
- images not renderable inline: `image/heic`, `image/heif`, `image/bmp`, `image/tiff`
- contact cards: `text/vcard`, `text/x-vcard`
- documents, reusing what `EMAIL_ATTACHMENT_TYPES` already blesses:
  `text/plain`, `text/csv`, docx, xlsx

DELIBERATELY EXCLUDED, permanently: `text/html`, `application/xhtml+xml`,
`image/svg+xml`, `text/xml`, `application/xml`, `application/javascript`, and
anything unrecognised. These fall to the opaque tier and are named `.bin`.

### 5.1 THE TRAP: widen `normalizeStoredMediaType`, NOT `isInlineMediaType`

`isInlineMediaType` has a second, unrelated caller: `routes/mmsMedia.ts:78`,
the OUTBOUND upload endpoint's gate. Widening `isInlineMediaType` to cover the
declarable tier would silently permit staff to upload video and documents as
outbound MMS attachments - media Twilio cannot carry (error 12300) - with no
other code change and no test naming it.

`normalizeStoredMediaType` becomes: keep the type (trimmed, lowercased) when it
is inline OR declarable; otherwise `application/octet-stream`.
`isInlineMediaType` is NOT touched. A test must pin that the outbound upload
gate still refuses `video/mp4`.

## 6. Design

### 6.1 Write side

`normalizeStoredMediaType` widens as above. It has TWO callers, and BOTH change
behavior. This is intended for both; both need coverage.

- `services/mediaMirror.ts:104` - inbound MMS/relay/carrier-group media. The
  reported bug.
- `services/inboundEmail.ts:677` - inbound EMAIL attachments. Today an inbound
  `.docx` collapses to octet-stream exactly like an MMS video does; after this
  change it stores `application/vnd...document` and downloads under its real
  stored filename.

No adapter change is needed on the mirror path: the type still comes from the
HMAC-validated webhook's `MediaContentType{i}`, unchanged.

### 6.2 Read side - the serve route

`routes/api.ts` `GET /messages/:providerSid/media/:idx` implements the section
5 table. Ordering and details:

1. `stored = object.contentType` (the S3 object's own type - unchanged source).
2. Inline tier: serve `stored`, `Content-Disposition: inline; filename=...`.
3. Declarable tier: serve `stored`, `Content-Disposition: attachment; filename=...`.
4. Opaque tier: `application/octet-stream`, `attachment`, `.bin`.
5. `X-Content-Type-Options: nosniff` and
   `Content-Security-Policy: default-src 'none'; sandbox` stay on EVERY
   response exactly as today.

Filename resolution, in order:

1. `attachments[idx].filename` when present and non-empty, sanitized (6.3).
2. Otherwise `attachment-<idx + 1><ext>`, where `ext` comes from a closed
   type-to-extension map and defaults to `.bin`.

Note the deliberate off-by-one correction: the header is 0-based today
(`attachment-0`) while the UI labels the same attachment "Attachment 1". The
synthesized name becomes 1-based to match the UI and the existing outbound
email convention.

### 6.3 Filename sanitization (header-injection guard)

`filename` is stored data that originated off a MIME part, so it is untrusted
for header construction:

- strip CR, LF and NUL; strip `"` and `\`; strip path separators; reject `..`
- collapse whitespace, cap at 100 characters preserving the extension
- emit an ASCII-only `filename="..."`; when the original contains non-ASCII,
  ALSO emit `filename*=UTF-8''<percent-encoded>` per RFC 5987
- if sanitization empties the name, fall back to the synthesized form

### 6.4 Dashboard readers

`AttachmentGallery` (`Timeline.tsx:640`) branches on
`att.contentType.startsWith('image/')` to decide between an inline `<img>` and
a file link. Once `image/heic` is stored truthfully that predicate becomes
WRONG - it would emit an `<img>` for a format most browsers cannot decode, and
a photo that renders as a broken image today would be a REGRESSION introduced
by this change.

It must branch on the inline-renderable set instead. The dashboard cannot
import from `app/`, so the four raster types are mirrored in
`dashboard/src/routes/contact/media.ts` with a comment naming
`app/src/lib/mediaTypes.ts` as the source of truth, matching how the dashboard
already mirrors other server constants.

The non-image label (`attachmentLabel`, `Timeline.tsx:614-617`) keeps preferring
a stored filename; the positional fallback gains the file kind, so an operator
sees "Video - Attachment 1" rather than a bare "Attachment 1".

### 6.5 Media pointer rows - the second persisted copy

`MediaPointer` (`repos/messagesRepo.ts:212-225`) carries its OWN `contentType`,
written by `append` / `annotateMessage` / `putMediaPointers` and read by the
"Media from comms" gallery via `toCommsMediaItem`
(`dashboard/src/routes/contact/media.ts:36`). It is a second copy of the state
this change corrects.

Runtime writes stay correct automatically (they derive from the same
attachments array). The BACKFILL must rewrite pointer rows too, or the gallery
and the thread will disagree about the same bytes.

### 6.6 Backfill

`app/scripts/backfill-media-content-types.ts`, npm script
`backfill:media-content-types`, modeled on `backfill-media-pointers.ts`
(scan + `--dry-run` + physical table via `lib/config.tableName`, ops-run
against a deliberately chosen environment).

Selection: message rows carrying `media_attachments`, direction `inbound`, with
at least one attachment whose `contentType` is `application/octet-stream`.
Outbound attachments are already correct (they are gated at upload) and are
skipped.

Per attachment:

1. Derive the MediaSid from the stored `mediaUrls[index]` - inbound MediaUrls
   are stable `api.twilio.com/.../Messages/<MM...>/Media/<ME...>` resource
   URLs, not expiring presigns. Missing or short `mediaUrls` -> skip + count.
2. `adapter.getMediaContentType(messageSid, mediaSid)` - METADATA ONLY, no
   bytes. A 404 (media aged out or deleted) -> skip + count.
3. Pass the recovered type through `normalizeStoredMediaType`. If it is still
   `application/octet-stream`, skip: the backfill can never write a type the
   runtime would refuse.
4. WRITE ORDER, LOAD-BEARING: S3 object first, then the message row, then the
   pointer rows.

The write order is the idempotency guarantee and must not be reordered. The
scan re-selects on the ROW still saying octet-stream, so if the row were
updated first and the S3 write then failed, a re-run would skip that attachment
forever and leave the object permanently wrong. S3 first means every partial
failure is recoverable by re-running, and `CopyObject` is itself idempotent.

Reporting (counts and type histogram only, never keys, bodies or numbers):
rows scanned, attachments eligible, recovered by type, skipped-no-url,
skipped-twilio-404, skipped-still-opaque, written.

Concurrency: the backfill targets old rows while `media.mirror` only ever
touches recent ones, so a race is not expected; the backfill nonetheless writes
through the existing repo methods so pointer rows stay consistent with whatever
else wrote them.

### 6.7 Adapter additions

Both belong in `app/src/adapters` per the vendor-SDK rule.

- `MessagingAdapter.getMediaContentType(messageSid, mediaSid): Promise<string | undefined>`.
  Twilio driver: `client.messages(messageSid).media(mediaSid).fetch()` ->
  `contentType`; a 404 resolves to `undefined` rather than throwing. Console
  driver: `undefined` with a log line.
- `MediaStore.setContentType(key, contentType): Promise<void>`. `CopyObject`
  with `CopySource` = the same bucket/key, `MetadataDirective: 'REPLACE'` and
  the new `ContentType`. This is the documented same-key copy case. Needs only
  `s3:PutObject`, already granted (the mirror `put`s with it) - NO new infra.
  Objects are capped at 25 MB upstream, well under the 5 GB single-part copy
  limit.

### 6.8 fake-twilio and e2e

`fake-twilio/src/engine/signer.ts:27` `inferMediaContentType` maps only
png/gif/webp/jpg/pdf and returns octet-stream otherwise, so today the harness
CANNOT produce a declarable-tier inbound MMS. Add one small canned non-image
asset (a few-KB `.mp4`) plus its suffix branch, so an e2e can drive a real
inbound video into a relay thread and assert the served headers.

## 7. Security analysis

The guarantee that must survive D2, stated as an invariant:

> No object in the media bucket ever carries a script-capable Content-Type, and
> no media response ever renders a script-capable type same-origin.

How it is enforced after this change:

1. WRITE SIDE, the primary gate. `normalizeStoredMediaType` is a closed
   ALLOWLIST. An unrecognised or active type cannot be written to S3 by any
   path: the mirror, the deferred `media.mirror` job, inbound email, and the
   backfill all pass through it. Safe by construction rather than by
   enumeration of the dangerous cases.
2. READ SIDE. The inline branch still gates on `INLINE_MEDIA_TYPES` against
   the object's own type, unchanged, so a legacy object cannot reach the inline
   branch either. The declarable branch always sets
   `Content-Disposition: attachment`, which forces a download rather than a
   render even if a type ever reached it wrongly.
3. HEADERS. `nosniff` and `default-src 'none'; sandbox` remain on every
   response, so a renderer reached by any means still executes nothing.

What D2 genuinely costs: before this change the read side re-derived safety
from an independently normalized S3 type, which protected objects written
BEFORE the write-side fix existed. After it, the S3 type is wider by design and
the read side's allowlists carry that weight alone. The compensating control is
that the backfill - the only thing that widens historical objects - writes
exclusively through the same allowlist, so it can never introduce a type the
runtime would not have written itself.

`Content-Disposition: inline` on the inline tier (new) does not change
rendering: it is the default behavior when no disposition is sent. Its only
effect is to give the browser a filename when the operator saves the image.

## 8. Mutation surfaces and readers of the corrected state

Every writer and every reader, enumerated. A surface missing from this list is
where the invariant silently breaks.

WRITERS of an attachment content-type:

1. `services/mediaMirror.ts` (inline mirror, both webhook and job callers)
2. `jobs/mediaMirror.ts` (deferred rungs; appends via `annotateMessage`)
3. `services/inboundEmail.ts:677` (inbound email attachments)
4. `routes/webhooks/twilio.ts` `mirrorInboundMedia` (persists via `annotateMessage`)
5. `repos/messagesRepo.ts` `append` / `annotateMessage` / `putMediaPointers`
   (pointer rows)
6. NEW: `scripts/backfill-media-content-types.ts` (S3 + row + pointers)
7. `services/sendMessage.ts` / `jobs/retrySend.ts` (OUTBOUND attachments -
   unchanged, gated at upload; listed so a reviewer can confirm they are
   untouched)

READERS:

1. `routes/api.ts` media serve (the fix)
2. `dashboard` `AttachmentGallery` - image-vs-file branch (6.4, MUST change)
3. `dashboard` "Media from comms" gallery via `MediaPointer.contentType` (6.5)
4. `jobs/relayFanOut.ts:495-498` - presigns `a.s3Key` and hands the URL to
   Twilio, which reads the S3 object's Content-Type. WATCH ITEM: after this
   change a forwarded video is presented to Twilio as `video/mp4` instead of
   `application/octet-stream`. Both are outside `TWILIO_DELIVERABLE_MMS_TYPES`
   (jpeg/png/gif only), so forwarding fails before and after - no regression -
   but the Twilio error code may change. No code change here; D3.
5. `routes/api.ts` outbound send-path Head re-check + `routes/mmsMedia.ts:78`
   upload gate - both gate on `isInlineMediaType`, which this change does NOT
   touch (5.1).

### 8.5 Legacy `media_s3_keys` rows

`mediaAttachmentsOf` folds legacy rows to octet-stream at read time; such rows
have no `media_attachments` array to correct and no per-attachment type to
recover into. They are skipped and counted by the backfill and keep the `.bin`
download. Tracked by `docs/issues/remove-media-s3-keys-legacy.md`.

## 9. Testing

Unit (app):

- `mediaTypes`: the new set; `normalizeStoredMediaType` keeps declarable types
  and still collapses `text/html`, `image/svg+xml`, XHTML, XML, unknown and
  absent; extension map total over both allowlists; active types map to `.bin`.
- REGRESSION GUARD: `isInlineMediaType('video/mp4')` is false and the outbound
  upload gate still refuses it (5.1).
- Serve route: one test per tier (inline / declarable / opaque) asserting
  Content-Type, disposition and filename together; stored `filename` preferred;
  a `filename` carrying CRLF and quotes cannot inject a header; non-ASCII name
  produces `filename*`; `nosniff` and CSP present on all three.
- Mirror: a `video/mp4` target stores `video/mp4`; a `text/html` target still
  stores octet-stream.
- Inbound email: a `.docx` attachment now stores its real type.
- Backfill: recovers and writes all three places; S3-first ordering proven by
  failing the row write and re-running; idempotent second run is a no-op;
  Twilio 404, missing `mediaUrls`, legacy rows, and a recovered active type all
  skip and count.

Dashboard: `image/heic` renders as a file link, not an `<img>`; `image/jpeg`
still renders inline; email attachment filename still labels the link.

e2e: inbound `.mp4` into a relay thread via the fake -> the attachment link is
a file link, and the served response carries `video/mp4`,
`Content-Disposition: attachment` and a `.mp4` filename.

Existing tests that MUST be updated, and why (so a reviewer does not read the
change as a broken guard): `app/test/mmsMedia.test.ts:229` and
`app/test/apiRoutes.test.ts:648,661` assert
`content-disposition` is UNDEFINED on the inline path. The inline tier now
sends `inline; filename=...` (section 6.2 step 2, rationale in section 7), so
those expectations change from "absent" to "starts with inline".

## 10. Ops

RUNBOOK entry. Human-run, never agent-run, in order: dev `--dry-run`, read the
histogram, dev apply, verify one attachment in the dev dashboard, prod
`--dry-run`, prod apply. Requires Twilio API credentials for the target account
and `s3:PutObject` on that environment's media bucket (both already held by the
app role; the script runs with the operator's own environment as the sibling
backfills do).

## 11. Risks

- Twilio media retention: an old enough message may have no media left. The
  backfill counts these and moves on; those attachments keep `.bin`. The
  dry-run histogram tells us the real number before anything is written.
- The recovered type is what the sending handset/carrier declared, so a
  mislabeled file stays mislabeled. Out of scope to detect; magic-byte sniffing
  was considered and rejected as unnecessary for this fix.
- `CopyObject` changes ETag and LastModified on production objects. Nothing in
  the app keys off either.

## 12. Follow-ups to file

- Relay forwarding of non-image media (D3): forwarding is blocked by
  `TWILIO_DELIVERABLE_MMS_TYPES` regardless of content type and needs
  transcoding or a link-out. This work supplies the data it would need.
- `routes/unitMediaServe.ts:65` has the same extensionless
  `filename="unit-media"` shape. Unit photos are image-only so the download
  branch is a rarely reached fallback; noted, not fixed here.
- INCIDENTAL: `routes/api.ts:23` imports `normalizeStoredMediaType` and never
  uses it - a pre-existing unused import. The implementer necessarily edits
  that import line, so the dead symbol is dropped in passing.
