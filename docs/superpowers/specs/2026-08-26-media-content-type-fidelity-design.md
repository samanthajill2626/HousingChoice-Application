# Inbound media content-type fidelity - design

Date: 2026-08-26
Status: DRAFT (spec review round 2)
Branch: `feat/media-content-type-fidelity` (cut from `main` @3c2962a4)
Design review: spec R1 adjudicated at
`.superpowers/design-review/adjudications.md` (21 accepted, 2 rejected)

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

The outbound email send path already solved this problem one channel over -
`services/sendEmailMessage.ts:225-235` maps content type to extension and
synthesizes `attachment-1.pdf`, with `.bin` as the fallback. The inbound serve
route never got the equivalent.

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
- D3. Relay FORWARDING of non-image media is out of scope. Filed as
  `docs/issues/relay-forwards-undeliverable-media.md`.

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
- No consolidation of `EMAIL_EXTENSIONS` (`services/sendEmailMessage.ts:225-235`)
  into the new shared map. It is outbound-only and serves a different
  allowlist; merging them would put a regression risk into a channel nobody has
  reported a problem with. The duplication is noted in the new map's comment.
- No promotion of legacy `media_s3_keys` rows to `media_attachments` (see 8.5).
- No transcoding of any kind.

## 5. Type tiers

Three tiers, one source of truth, in `lib/mediaTypes.ts`.

| Tier | Set | Response Content-Type | Disposition | Filename |
|---|---|---|---|---|
| Inline | `INLINE_MEDIA_TYPES` (unchanged) | the canonical set member | `inline` | typed |
| Declarable | `DECLARABLE_MEDIA_TYPES` (new) | the canonical set member | `attachment` | typed |
| Opaque | everything else | `application/octet-stream` | `attachment` | `.bin` |

`DECLARABLE_MEDIA_TYPES` (a closed allowlist, never a denylist):

- video: `video/mp4`, `video/quicktime`, `video/3gpp`, `video/3gpp2`, `video/webm`
- audio: `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg`, `audio/amr`, `audio/wav`
- images not renderable inline: `image/heic`, `image/heif`, `image/bmp`, `image/tiff`
- contact cards: `text/vcard`, `text/x-vcard`
- documents, reusing what `EMAIL_ATTACHMENT_TYPES` already blesses:
  `text/plain`, `text/csv`, docx, xlsx

DELIBERATELY EXCLUDED, permanently: `text/html`, `application/xhtml+xml`,
`image/svg+xml`, `text/xml`, `application/xml`, `application/javascript`, and
anything unrecognised. These fall to the opaque tier and are named `.bin`.

### 5.1 Matching is on the media-type ESSENCE, and the canonical member is what gets served

A stored type can legitimately carry parameters - `text/plain; charset=utf-8`,
`video/3gpp; codecs=...` are ordinary wire forms. Today's exact-string set
lookup would send both to the opaque tier and silently defeat the feature for
the very types it adds.

So: match on the ESSENCE (everything before the first `;`, trimmed,
lowercased). Then SERVE THE CANONICAL SET MEMBER, not the raw stored string -
which also guarantees the tier decision, the response header and the extension
lookup can never disagree with each other.

This does not weaken the inline gate. Essence matching is exactly what makes
`text/html; charset=utf-8` fail the inline test, the same as the exact-match
form does today; the parameterized string never reaches a response header
either way.

### 5.2 THE TRAP: widen `normalizeStoredMediaType`, NOT `isInlineMediaType`

`isInlineMediaType` has a second, unrelated caller: `routes/mmsMedia.ts:78`,
the OUTBOUND upload endpoint's gate. Widening `isInlineMediaType` to cover the
declarable tier would silently permit staff to upload video and documents as
outbound MMS attachments - media Twilio cannot carry (error 12300) - with no
other code change and no test naming it.

`normalizeStoredMediaType` becomes: keep the canonical member when the essence
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
  change it stores its real type.

No adapter change is needed on the mirror path: the type still comes from the
HMAC-validated webhook's `MediaContentType{i}`, unchanged.

### 6.2 Read side - the serve route

`routes/api.ts` `GET /messages/:providerSid/media/:idx` implements the section
5 table:

1. `stored = object.contentType` (the S3 object's own type - unchanged source,
   see 7.4 for why the record must not be trusted here).
2. Inline tier: serve the canonical member,
   `Content-Disposition: inline; filename=...`.
3. Declarable tier: serve the canonical member,
   `Content-Disposition: attachment; filename=...`.
4. Opaque tier: `application/octet-stream`, `attachment`, `.bin`.
5. `X-Content-Type-Options: nosniff` and
   `Content-Security-Policy: default-src 'none'; sandbox` stay on EVERY
   response exactly as today.

### 6.3 Filename construction

THE EXTENSION IS ALWAYS OURS. It is looked up from the resolved tier's
canonical type and is never taken from stored data. This is not a detail: the
stored `filename` originates in a MIME part the sender controls
(`services/inboundEmail.ts` persists it verbatim), so honoring its extension
would let a sender choose what the operator's OS does with the downloaded file
- turning today's inert `attachment-0` into `invoice.exe`. The whole point of
the feature is a filename the OS acts on, which is exactly why the sender must
not choose it.

The stem is resolved in this order:

1. The stored `attachments[idx].filename`, reduced to its BASE NAME with any
   existing extension DISCARDED, then sanitized (below).
2. If that stem is empty after sanitizing, or matches `^attachment-\d+$`, treat
   it as absent. `lib/emailMime.ts:100-106` synthesizes exactly
   `attachment-<i>` for a nameless MIME part, so without this rule the stored
   value would be preferred and would reproduce the extensionless 0-based name
   this feature exists to remove.
3. Otherwise the synthesized stem `attachment-<idx + 1>`.

The final name is `<stem><ext>`. Note the deliberate off-by-one correction: the
header is 0-based today (`attachment-0`) while the UI labels the same
attachment "Attachment 1". The synthesized stem is 1-based to match the UI and
the existing outbound email convention.

Stem sanitization (header-injection guard): strip CR, LF and NUL; strip `"`
and `\`; strip path separators; reject `..`; collapse whitespace; cap at 100
characters. Emit an ASCII-only `filename="..."`, and when the original stem
contained non-ASCII ALSO emit `filename*=UTF-8''<percent-encoded>` per
RFC 5987.

### 6.4 Dashboard readers

TWO components carry the same predicate, and both must change:

- `AttachmentGallery` (`dashboard/src/routes/contact/Timeline.tsx:640`)
- `MediaGallery` (`dashboard/src/routes/contact/MediaGallery.tsx:36`)

Both branch on `contentType.startsWith('image/')` to choose between an inline
`<img>` and a file link. Once `image/heic` is stored truthfully that predicate
becomes WRONG - it emits an `<img>` for a format most browsers cannot decode,
so a photo that renders today would become a broken image. That is a
REGRESSION this change would introduce, in both the thread and the
"Media from comms" grid.

Both must branch on the inline-renderable set instead. The dashboard cannot
import from `app/`, so the four raster types are mirrored in
`dashboard/src/routes/contact/media.ts` with a comment naming
`app/src/lib/mediaTypes.ts` as the source of truth, matching how the dashboard
already mirrors other server constants. Both components consume the shared
helper; neither keeps its own predicate.

Label change, FILE-LINK FALLBACK ONLY: `attachmentLabel`
(`Timeline.tsx:614-617`) keeps preferring a stored filename, and its positional
fallback gains the file kind ("Video - Attachment 1" rather than a bare
"Attachment 1"). The image `alt` text is NOT given a kind prefix - it is
already known to be an image. Section 9 names the two assertions this moves.

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

SELECTION. A DynamoDB `FilterExpression` cannot express "some element of this
list has this value", so the scan filters coarsely (message rows carrying
`media_attachments`) and the per-attachment predicate is applied IN CODE, as
`backfill-media-pointers.ts` already does. An attachment is a repair candidate
when all of these hold:

- the carrying message is `direction: 'inbound'` (outbound attachments are
  gated at upload and are already correct), AND
- its stored `contentType` is `application/octet-stream`, AND
- the message carries `mediaUrls` (Twilio-recoverable evidence exists).

The last clause matters for reporting, not just correctness: inbound EMAIL rows
are inbound, carry `media_attachments`, and are octet-stream, but have no
Twilio media behind them. Without the clause they inflate the dry-run histogram
the ops go/no-go decision reads. They are counted in their own bucket instead.

PER ATTACHMENT:

1. Derive the provider media index BY PARSING THE S3 KEY, never from the
   attachment's array position. `media_attachments` is a compacted
   successes-only list (`routes/webhooks/twilio.ts:496-497`) that
   `jobs/mediaMirror.ts:150-160` later APPENDS to, so after any partial mirror
   `media_attachments[0]` can be provider index 1. The true index is carried in
   the key itself - `inboundMediaKey` (`services/mediaMirror.ts:67-69`) is
   `media/<conversationId>/<messageSid>/<index>`. A key that does not match
   that pattern is skipped and counted, never guessed at.
2. Read `mediaUrls[<that index>]` and extract the MediaSid. Inbound MediaUrls
   are stable `api.twilio.com/.../Messages/<MM...>/Media/<ME...>` resource
   URLs, not expiring presigns. Missing or out-of-range -> skip + count.
3. `adapter.getMediaContentType(messageSid, mediaSid)` - METADATA ONLY, no
   bytes. A 404 (media aged out or deleted) -> skip + count.
4. Pass the recovered type through `normalizeStoredMediaType`. If it is still
   `application/octet-stream`, skip: the backfill can never write a type the
   runtime would refuse.
5. WRITE ORDER, LOAD-BEARING: S3 object -> `putMediaPointers` -> the message
   row.

THE PREDICATE-CLEARING WRITE GOES LAST. The re-scan predicate is the message
row still saying octet-stream, so the row must be the final write: every step
before it is idempotent and a partial failure is repaired by simply re-running.
The naive order (row, then pointers) is specifically wrong here because
`annotateMessage` writes pointers best-effort inside a try/catch that logs and
swallows (`repos/messagesRepo.ts:2538-2550`) - so a pointer failure after the
row write would clear the predicate and leave the thread and the gallery
permanently disagreeing. Writing pointers first makes `annotateMessage`'s own
pointer write a harmless idempotent repeat.

REPORTING (counts and type histogram only, never keys, bodies or numbers):
rows scanned, attachments eligible, recovered by type, skipped-unparseable-key,
skipped-no-url, skipped-twilio-404, skipped-still-opaque, skipped-email-row,
skipped-legacy-row, written.

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
  the new `ContentType`. This is the documented same-key copy case. Objects are
  capped at 25 MB upstream, well under the 5 GB single-part copy limit.

Widening either interface breaks the full object literals in the test helpers
that implement them - `app/test/helpers/twilioWebhookHarness.ts` implements
`MediaStore` exhaustively. Named here so the builder treats it as a task rather
than discovering it as a type error.

### 6.8 fake-twilio and e2e

`fake-twilio/src/engine/signer.ts:27` `inferMediaContentType` maps only
png/gif/webp/jpg/pdf and returns octet-stream otherwise, so today the harness
CANNOT produce a declarable-tier inbound MMS. Nor can the seeds: the only
seeded MESSAGE attachment is `image/jpeg` (`lib/seed/cast.ts:1210`), and the
seeded `audio/mpeg` object (`lib/seed/media.ts:122`) is a CALL RECORDING served
by a different route that hardcodes its type.

So a new canned non-image asset is required, and it is more than a suffix
branch: the canned-asset registry, its pinning test and the static serving path
for the asset all live in `fake-twilio/web/` and must be updated together. The
builder must locate all of them before adding the asset rather than assuming
`signer.ts` is the whole change.

## 7. Security analysis

The guarantee that must survive D2:

> No object in the media bucket ever carries a script-capable Content-Type, and
> no media response ever renders a script-capable type same-origin.

### 7.1 Write side - every gate, not one gate

There is no single choke point, and the round-1 draft was wrong to claim one.
Every writer of an S3 object Content-Type, with the allowlist it enforces:

- `normalizeStoredMediaType` - inbound MMS mirror, deferred mirror job, inbound
  email attachments. Widened by this change; closed allowlist.
- presigned-POST MMS uploads (`routes/mmsMedia.ts:78`, `isInlineMediaType`).
- presigned-POST email attachments (`routes/emailMedia.ts`, `isEmailAttachmentType`).
- presigned-POST unit photos (`routes/units.ts:516,686`, `isImageMediaType`).
- the seeder (`lib/seed/media.ts:121-128`) - writes literal types with no gate
  at all, but writes only hardcoded dev fixtures.
- NEW: the backfill, which passes every recovered type through
  `normalizeStoredMediaType` and so cannot write a type the runtime would not.

Each is a closed allowlist of non-active types. The invariant holds because
every gate holds, not because one function guards them all.

### 7.2 Read side

The inline branch still gates on `INLINE_MEDIA_TYPES`, unchanged. The
declarable branch always sets `Content-Disposition: attachment`, which forces a
download rather than a render even if a type ever reached it wrongly.

### 7.3 Headers

`nosniff` and `default-src 'none'; sandbox` remain on every response, so a
renderer reached by any means still executes nothing.
`Content-Disposition: inline` on the inline tier (new) does not change
rendering - it is the default behavior when no disposition is sent. Its only
effect is to give the browser a filename when the operator saves the image.

### 7.4 Why the read side must keep reading the S3 OBJECT's type

Objects mirrored BEFORE the 2026-06-18 normalize fix can still carry active
types such as `text/html` at rest - that population is the entire reason the
stored-XSS fix put an allowlist on the READ side as well. So the tier decision
must keep running on the object's own Content-Type, and must never be
"simplified" to trust `media_attachments[idx].contentType`. The record is
display metadata; the object is what the browser will receive.

### 7.5 What D2 costs

Before this change the read side re-derived safety from an independently
normalized S3 type. After it, the S3 type is wider by design and the read
side's allowlists carry that weight alone. The compensating control is that the
backfill - the only thing that widens historical objects - writes exclusively
through the same allowlist the runtime uses.

## 8. Mutation surfaces and readers of the corrected state

WRITERS of an attachment content-type:

1. `services/mediaMirror.ts` (inline mirror, both webhook and job callers)
2. `jobs/mediaMirror.ts` (deferred rungs; appends via `annotateMessage`)
3. `services/inboundEmail.ts:677` (inbound email attachments)
4. `routes/webhooks/twilio.ts` `mirrorInboundMedia` (persists via `annotateMessage`)
5. `repos/messagesRepo.ts` `append` / `annotateMessage` / `putMediaPointers`
   (pointer rows)
6. `lib/seed/media.ts:121-128` and `lib/seed/cast.ts:1210` (dev/e2e fixtures,
   written with literal types)
7. the three presigned-POST upload paths (7.1) - unchanged by this work
8. NEW: `scripts/backfill-media-content-types.ts` (S3 + pointers + row)
9. `services/sendMessage.ts` / `jobs/retrySend.ts` (OUTBOUND attachments -
   unchanged; listed so a reviewer can confirm they are untouched)

READERS:

1. `routes/api.ts` media serve (the fix)
2. `dashboard` `AttachmentGallery` - image-vs-file branch (6.4, MUST change)
3. `dashboard` `MediaGallery` - the identical branch (6.4, MUST change)
4. `jobs/relayFanOut.ts:494-509` - presigns `a.s3Key` and hands the URL to
   Twilio, which reads the S3 object's Content-Type. WATCH ITEM: after this
   change a forwarded video is presented to Twilio as `video/mp4` instead of
   `application/octet-stream`. Both are outside `TWILIO_DELIVERABLE_MMS_TYPES`,
   so the expectation is that the leg fails before and after - but
   `relayFanOut` never consults a content type itself, so THE OUTCOME IS
   VENDOR-DECIDED AND UNVERIFIED. The observable that may change is the error
   code recorded on the failed leg. No code change here; D3.
5. `routes/api.ts:527-531` outbound send-path gate - uses
   `isTwilioDeliverableType`, NOT `isInlineMediaType`, and is untouched.
6. `routes/mmsMedia.ts:78` upload gate - `isInlineMediaType`, untouched (5.2).

### 8.5 Rows this backfill cannot repair

- LEGACY `media_s3_keys` rows: `mediaAttachmentsOf` folds them to octet-stream
  at read time, and they carry no `media_attachments` array to correct. They
  are counted during the scan and excluded from the repair set. Tracked by
  `docs/issues/remove-media-s3-keys-legacy.md`.
- EXISTING INBOUND EMAIL attachments: there is no Twilio media behind them and
  the MIME source is long gone, so their stored type is UNRECOVERABLE by any
  means. 6.1 fixes new ones; old ones keep `.bin` permanently. Counted
  separately in the report so this is visible rather than inferred.

## 9. Testing

Unit (app):

- `mediaTypes`: the new set; `normalizeStoredMediaType` keeps declarable types
  and still collapses `text/html`, `image/svg+xml`, XHTML, XML, unknown and
  absent; ESSENCE matching accepts `text/plain; charset=utf-8` and still
  refuses `text/html; charset=utf-8`; the canonical member is what comes back;
  extension map total over both allowlists; active types map to `.bin`.
- REGRESSION GUARD: `isInlineMediaType('video/mp4')` is false and the outbound
  upload gate still refuses it (5.2).
- Serve route: one test per tier asserting Content-Type, disposition and
  filename TOGETHER; a stored filename contributes its stem but NEVER its
  extension (`invoice.exe` on an opaque attachment downloads as `invoice.bin`);
  a stored `attachment-0` is treated as absent and yields `attachment-1.<ext>`;
  a filename carrying CRLF and quotes cannot inject a header; a non-ASCII stem
  produces `filename*`; `nosniff` and CSP present on all three tiers.
- Mirror: a `video/mp4` target stores `video/mp4`; a `text/html` target still
  stores octet-stream.
- Inbound email: a `.docx` attachment now stores its real type.
- Backfill: the index comes from the s3Key, PROVEN with a compacted
  attachments array whose position 0 is provider index 1; write order proven by
  failing the row write and re-running to a correct result; idempotent second
  run is a no-op; unparseable key, Twilio 404, missing `mediaUrls`, email rows,
  legacy rows and a recovered active type all skip and count.

Dashboard: `image/heic` renders as a file link in BOTH `AttachmentGallery` and
`MediaGallery`; `image/jpeg` still renders inline in both; email attachment
filename still labels the link.

e2e: inbound `.mp4` into a relay thread via the fake -> the attachment link is
a file link, and the served response carries `video/mp4`,
`Content-Disposition: attachment` and a `.mp4` filename.

Existing assertions that MUST change, and why (so a reviewer does not read the
change as a broken guard):

- `app/test/mmsMedia.test.ts:229`, `app/test/apiRoutes.test.ts:648,661` assert
  `content-disposition` is UNDEFINED on the inline path. The inline tier now
  sends `inline; filename=...` (6.2, rationale in 7.3), so these change from
  "absent" to "starts with inline".
- The two attachment-label assertions moved by 6.4's file-link kind prefix:
  `dashboard/src/routes/contact/Timeline.test.tsx:552` and
  `Timeline.email.test.tsx:88,107`.

## 10. Ops

RUNBOOK entry. Human-run, never agent-run.

HARD ORDERING: DEPLOY THE APPLICATION FIRST, THEN RUN THE BACKFILL. Running the
backfill against an environment still serving the old dashboard bundle
reproduces exactly the broken-`<img>` HEIC regression 6.4 exists to prevent,
for every operator, for the whole window between the two steps.

Sequence per environment: deploy -> `--dry-run` -> read the histogram -> apply
-> verify one repaired attachment in that environment's dashboard. Dev fully
through before prod is started.

Operator requirements, stated because the script runs under the OPERATOR's own
credentials and not the EC2 instance role: Twilio API credentials for the
target account, and `s3:GetObject` + `s3:PutObject` on that environment's media
bucket (`CopyObject` needs BOTH). The account-ID guard the sibling ops scripts
use is required - the default AWS credential chain resolves to the wrong
account in this repo's environment.

## 11. Risks

- Twilio media retention: an old enough message may have no media left. The
  backfill counts these and moves on; those attachments keep `.bin`. The
  dry-run histogram tells us the real number before anything is written.
- The recovered type is what the sending handset/carrier declared, so a
  mislabeled file stays mislabeled. Out of scope to detect; magic-byte sniffing
  was considered and rejected as unnecessary for this fix.
- The media bucket has versioning ENABLED and no lifecycle rule at all
  (`infra/modules/s3_media/main.tf:12-17`), so every in-place `CopyObject`
  retains the wrongly-typed version indefinitely. Two consequences, one bad and
  one good: storage grows by a full copy per repaired object, and the operation
  is REVERSIBLE - the pre-backfill state remains addressable as a noncurrent
  version, which is worth knowing for a change that mutates production objects.
- `CopyObject` changes ETag and LastModified. Nothing in the app keys off
  either.

## 12. Follow-ups

- FILED: `docs/issues/relay-forwards-undeliverable-media.md` (D3) - relay
  fan-out forwards media Twilio cannot carry, failing the whole leg including
  its body text.
- `routes/unitMediaServe.ts:65` has the same extensionless
  `filename="unit-media"` shape. Unit photos are image-only so the download
  branch is a rarely reached fallback; noted, not fixed here.
- The extension map is now a third copy alongside `EMAIL_EXTENSIONS` and the
  dashboard's mirrored raster set. Deliberate (non-goal 4); the new map's
  comment points at the others.
- INCIDENTAL: `routes/api.ts:23` imports `normalizeStoredMediaType` and never
  uses it - a pre-existing unused import. The implementer necessarily edits
  that import line, so the dead symbol is dropped in passing.
