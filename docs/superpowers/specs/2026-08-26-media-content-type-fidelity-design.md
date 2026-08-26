# Inbound media content-type fidelity - design

Date: 2026-08-26
Status: DRAFT (spec review round 4 - the cap)
Branch: `feat/media-content-type-fidelity` (cut from `main` @3c2962a4)
Design review: spec R1 + R2 adjudicated at
`.superpowers/design-review/adjudications.md`

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

Three defects, stacked. All are reachable by construction; none is timing
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

### 2.3 The serve route ignores the filename it already has

`attachments[idx].filename` is in scope on the line above and IS populated for
email attachments, but the header never reads it. So an inbound email
attachment displays in the timeline as `budget.xlsx`
(`Timeline.tsx:614-617`) and downloads as `attachment-0`. Section 6.3's stem
ladder exists to fix this, safely.

The outbound email send path already solved the naming problem one channel
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
- D3. Relay FORWARDING of non-image media is out of scope. Filed as
  `docs/issues/relay-forwards-undeliverable-media.md`.

D2 makes the design smaller than it would otherwise have been. With the S3
object carrying a truthful type, the object's own Content-Type is again the
single source of truth: no new `originalContentType` field is added, old and
new rows converge on one shape, and the recovered data lands where a future
forwarding fix would need it.

## 4. Non-goals

- No inline rendering of anything beyond today's five types.
- No change to the outbound MMS upload allowlist, the outbound SEND path, unit
  photos, or call recordings. (Outbound email ATTACHMENT SERVING does change -
  see 8.6. That is the same serve route, not the send path.)
- No relay forwarding fix (D3).
- No consolidation of `EMAIL_EXTENSIONS` (`services/sendEmailMessage.ts:225-235`)
  into the new shared map. Neither map feeds a security decision - the outbound
  one names a MIME part we are sending, the new one names a download we are
  offering, and both draw only from closed allowlists - so their divergence is
  cosmetic and does not justify touching a channel nobody reported a problem
  with. The duplication is noted in the new map's comment.
- No promotion of legacy `media_s3_keys` rows to `media_attachments` (see 8.5).
- No transcoding of any kind.

## 5. Type tiers

Three tiers, resolved in ONE place in `lib/mediaTypes.ts`.

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

### 5.1 ONE resolver, essence matching, canonical output

Add exactly one function and route every tier decision through it:

```
resolveMediaTier(raw: string | undefined):
  { tier: 'inline' | 'declarable' | 'opaque', canonical: string, ext: string }
```

It takes the media-type ESSENCE (everything before the first `;`, trimmed,
lowercased), matches it against the two sets in order, and returns the
CANONICAL SET MEMBER plus its EMITTED extension - never the caller's raw
string. For the opaque tier it returns `canonical: 'application/octet-stream'`
and `ext: '.bin'`. The serve route (6.2) and `normalizeStoredMediaType` (5.2)
both call it and nothing re-implements the decision, so THE TIER AND THE
RESPONSE CONTENT-TYPE can never disagree.

The EXTENSION is deliberately not bound that tightly: 6.3 rule 2 lets an opaque
attachment keep a stored `.xlsx` while its Content-Type stays
`application/octet-stream`. That is intentional, and it is the one place tier
and extension may differ. It needs a second, separate helper - a reverse lookup
`isAcceptedExtension(ext): boolean` over the ACCEPTED-EXTENSION SET defined in
6.3 - which `resolveMediaTier` does not provide and must not be conflated with.

Essence matching is required because parameters are ordinary wire forms:
`text/plain; charset=utf-8` and `video/3gpp; codecs=...` would fall to the
opaque tier under today's exact-string lookup and silently defeat the feature
for the types it adds.

SECURITY, STATED IN THE DIRECTION THAT ACTUALLY CHANGES: this NEWLY ADMITS the
parameterized forms of ALLOWLISTED types. `image/png; charset=x` reaches the
inline tier now, where today it falls to octet-stream. That is safe, and the
reason is the canonical output rather than the matching: the response header is
our own constant `image/png`, so a parameterized string never reaches a header
and cannot smuggle anything. Non-allowlisted types are unaffected in either
direction - `text/html; charset=utf-8` has essence `text/html` and still fails
both sets.

This DOES change a property asserted in a resolved security issue:
`docs/issues/media-serve-stored-xss.md:30-32` records that "`...; charset=...`
parameter forms cannot bypass it", describing exact-string matching as part of
the fix. That issue must be amended in this change with the reasoning above,
not left to contradict the code.

### 5.2 THE TRAP: widen `normalizeStoredMediaType`, NOT `isInlineMediaType`

`isInlineMediaType` has a second, unrelated caller: `routes/mmsMedia.ts:78`,
the OUTBOUND upload endpoint's gate. Widening `isInlineMediaType` to cover the
declarable tier would silently permit staff to upload video and documents as
outbound MMS attachments - media Twilio cannot carry (error 12300) - with no
other code change and no test naming it.

So: `isInlineMediaType` keeps BOTH its current set AND its current exact-string
semantics, and keeps its existing callers. It is not the serve route's gate any
more - the serve route goes through `resolveMediaTier`.
`normalizeStoredMediaType` is re-expressed on the resolver: return the
canonical member when the tier is inline or declarable, else
`application/octet-stream`. A test must pin that the outbound upload gate still
refuses `video/mp4`.

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

`routes/api.ts` `GET /messages/:providerSid/media/:idx` calls
`resolveMediaTier(object.contentType)` - the S3 object's own type, see 7.4 for
why the record must not be trusted here - and applies the section 5 table:

1. Inline: `Content-Type: <canonical>`, `Content-Disposition: inline; filename=...`.
2. Declarable: `Content-Type: <canonical>`, `Content-Disposition: attachment; filename=...`.
3. Opaque: `Content-Type: application/octet-stream`, `attachment`, `.bin`.
4. `X-Content-Type-Options: nosniff` and
   `Content-Security-Policy: default-src 'none'; sandbox` stay on EVERY
   response exactly as today.

### 6.3 Filename construction

THE EXTENSION IS ALWAYS DRAWN FROM OUR OWN MAP. It is never copied from stored
data as a string. The stored `filename` originates in a MIME part the sender
controls (`services/inboundEmail.ts` persists it verbatim), so honoring its
extension freely would let a sender choose what the operator's OS does with the
downloaded file - turning today's inert `attachment-0` into `invoice.exe`. The
whole point of the feature is a filename the OS acts on, which is exactly why
the sender must not choose it.

TWO EXTENSION SETS, deliberately different sizes. Do not build one from the
other:

- The EMISSION map, type -> one extension, used by `resolveMediaTier`. One
  value per type, our choice: `image/jpeg -> .jpg`.
- The ACCEPTED-EXTENSION SET, used only by rule 2 below. It is the emission
  map's values PLUS the ordinary spelling variants of the same formats -
  `.jpeg`, `.tif`, `.heif`, `.3gp`, `.mpeg`, `.vcf` and so on. It is a closed,
  hand-written set and it contains no active extension, ever.

  Deriving this set from the emission map's values is a defect, not a
  shortcut: the map emits `.jpg`, so a derived set would reject `photo.jpeg`
  and produce `photo.bin` - precisely the outcome rule 2 exists to prevent.

SPLITTING A STORED NAME. The extension is the LAST dot and everything after it;
the stem is everything before that dot. `data.tar.csv` splits to stem
`data.tar` + `.csv`. Interior dots stay in the stem. A name with no dot is all
stem. A name whose only dot is leading (`.env`) is all EXTENSION and has an
empty stem - it therefore has no usable stem and falls to stem rule 3.

EXTENSION, in order:

1. The emitted extension for the resolved tier's canonical type, when the tier
   is inline or declarable. The stored name's own extension is DISCARDED here.
2. OPAQUE TIER ONLY: if the stored name's extension is in the ACCEPTED set,
   keep it. This is a membership test against our closed set, never a
   passthrough - `.xlsx` is accepted because we recognise it, `.exe` can never
   be. It exists for one real population: historical inbound EMAIL attachments,
   whose stored type is permanently unrecoverable (8.5) but whose real filename
   we still hold. Without it the timeline shows `budget.xlsx` while the
   download is `budget.bin`, which is worse than the bug being fixed.
3. Otherwise `.bin`.

STEM, in order:

1. The stored `attachments[idx].filename`, split as above, sanitized as below.
2. If that stem is empty after sanitizing, or matches `^attachment-\d+$`, treat
   it as absent. `lib/emailMime.ts:100-106` synthesizes exactly
   `attachment-<i>` for a nameless MIME part, so without this rule the stored
   value would be preferred and would reproduce the extensionless 0-based name
   this feature exists to remove.
3. Otherwise the synthesized stem `attachment-<idx + 1>`.

STEM SANITIZATION, in this exact order. Each verb means REMOVE THE MATCHED
CHARACTERS, never "discard the whole name":

1. remove CR, LF, NUL, `"` and `\`
2. remove path separators (`/` and `\`) and every `..` sequence
3. collapse runs of whitespace to one space, then trim leading/trailing
   whitespace
4. remove trailing dots. This is what makes the "stem never ends in a dot"
   premise TRUE rather than assumed - without it a stored `report.` yields a
   stem `report` only by luck of the split, and `report..bin` otherwise.
5. truncate to 100 characters

THE CAP BOUNDS THE STEM, NOT THE EMITTED NAME. Capping the final name would
truncate the extension itself - a 100-character name ending `.xlsx` would ship
as `.xls`, silently changing the file type the OS sees. The emitted name is
therefore at most 100 + the longest extension.

Emit an ASCII-only `filename="..."`, and when the original stem contained
non-ASCII ALSO emit `filename*=UTF-8''<percent-encoded>` per RFC 5987.

Note the deliberate off-by-one correction: the header is 0-based today
(`attachment-0`) while the UI labels the same attachment "Attachment 1". The
synthesized stem is 1-based to match the UI and the outbound email convention.

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

LABEL RULES, exhaustively. A stored filename still wins over the fallback in
every case; these govern the FALLBACK only:

- image `alt`: UNCHANGED. No kind prefix - it is already known to be an image.
- PDF file link: UNCHANGED. Keeps "PDF attachment N", which already names its
  kind.
- DECLARABLE-tier file link: gains the kind, so "Attachment 1" becomes
  "Video - Attachment 1". The kind word comes from the canonical type's family
  (Video / Audio / Image / Document / Contact card) - a closed mapping beside
  the type sets.
- OPAQUE-tier file link: UNCHANGED, bare "Attachment N". THERE IS NO KIND WORD
  FOR `application/octet-stream`, and inventing one ("File - Attachment 1")
  would be noise.

That last rule is load-bearing for the existing tests and was wrong in the
round-2 draft, which said "every other file link" gains a kind. Both
assertions in `Timeline.email.test.tsx` (`:88` and `:107`) are on attachments
that are `application/octet-stream` with NO filename - so they are opaque-tier
fallbacks, and under this rule they do not move. The genuinely
filename-labelled assertion in that file is `:87`.

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
`backfill:media-content-types`.

PRECEDENT, SPLIT DELIBERATELY. Take the SCAN-AND-REPORT shape from
`backfill-media-pointers.ts` (paged scan, `--dry-run`, physical table via
`lib/config.tableName`). Do NOT take its credential posture: it has no AWS
write, no vendor API and no account guard. The guard this script needs is
`assertHousingChoiceAccount` / `hcCredentials` from `scripts/lib/hcAws.mjs`, as
used by `app/scripts/import-apply.ts:30-34` - the repo's own precedent for an
ops script that writes to a real account. The default AWS credential chain
resolves to the WRONG account in this environment, so the guard is mandatory,
not defensive.

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

PER ATTACHMENT (steps 1-4), then PER MESSAGE (step 5):

1. Derive the media index BY PARSING THE S3 KEY, never from the attachment's
   array position. `media_attachments` is a compacted successes-only list
   (`routes/webhooks/twilio.ts:496-497`) that `jobs/mediaMirror.ts:150-160`
   later APPENDS to, so after any partial mirror `media_attachments[0]` can
   carry index 1. The index is in the key: `inboundMediaKey`
   (`services/mediaMirror.ts:67-69`) is
   `media/<conversationId>/<messageSid>/<index>`. A key that does not match
   that pattern is skipped and counted, never guessed at.

   PRECISE INVARIANT, because the loose version misdirects the tests: that
   index is the position in the ROW'S STORED `mediaUrls` ARRAY, not Twilio's
   own `MediaUrl{i}` numbering. `parseInboundMediaUrls`
   (`routes/webhooks/twilio.ts:440-448`) SKIPS absent or empty entries, so the
   two can differ. It is the correct index to use precisely because both the
   s3Key and the stored `mediaUrls` derive from that same compacted list.

2. Read `mediaUrls[<that index>]` and extract the MediaSid. Inbound MediaUrls
   are stable `api.twilio.com/.../Messages/<MM...>/Media/<ME...>` resource
   URLs, not expiring presigns. Missing or out-of-range -> skip + count.
3. `adapter.getMediaContentType(messageSid, mediaSid)` - METADATA ONLY, no
   bytes. A 404 (media aged out or deleted) -> skip + count.
4. Pass the recovered type through `normalizeStoredMediaType`. If it is still
   `application/octet-stream`, skip: the backfill can never write a type the
   runtime would refuse. Then `mediaStore.setContentType` on THAT attachment's
   object.
5. ONCE PER MESSAGE, after every attachment on it has been through 1-4:
   `putMediaPointers` with the corrected array, then `annotateMessage` with it.

THE PREDICATE-CLEARING WRITE GOES LAST. The re-scan predicate is the message
row still saying octet-stream, so the row must be the final write: every step
before it is idempotent and a partial failure is repaired by re-running. The
naive order (row, then pointers) is specifically wrong because `annotateMessage`
writes pointers best-effort inside a try/catch that logs and swallows
(`repos/messagesRepo.ts:2538-2550`), so a pointer failure after the row write
would clear the predicate and leave the thread and the gallery permanently
disagreeing. Writing pointers first makes `annotateMessage`'s own pointer write
a harmless idempotent repeat.

Step 5 is per-message because `annotateMessage` takes the whole attachments
array; batching it per-attachment would rewrite the row once per attachment and
clear the predicate before the later attachments on that row were repaired.

`--dry-run` IS NOT READ-ONLY, and must not be described as if it were. It
performs no WRITES, but it makes one Twilio API READ per candidate attachment
against the live account in order to build the histogram. It therefore needs
the same pacing as the apply run: a bounded concurrency (small, single digit)
and a retry with backoff on 429, and its report must state the number of vendor
calls it made.

IDEMPOTENCY, stated exactly against the three writes. "Repaired" means REACHED
STEP 5 - the row write is what clears the re-scan predicate, so it is the only
write that makes a second run skip anything.

- An attachment that reached step 5: a second run does not select it. True
  no-op.
- An attachment interrupted BETWEEN its step-4 S3 write and its message's step
  5: the row still says octet-stream, so the next run re-selects it,
  re-queries Twilio and re-copies the object. Harmless (both are idempotent)
  but not free, and it is why the vendor-call count in the report can exceed
  the number of repairs.
- A row carrying a permanently unrepairable attachment: re-selected and
  re-queried EVERY run, because the predicate is row-granular. That is the cost
  of not writing a "tried and failed" marker; it is bounded and visible in the
  skip counts, and it is accepted deliberately rather than overlooked.

LOGGING: `annotateMessage` emits an INFO line per call carrying
`conversationId` and `tsMsgId` (`repos/messagesRepo.ts:2528-2537`), so an apply
run writes one CloudWatch line per repaired MESSAGE in addition to the script's
own counts-only report. That is IDs only and consistent with the PII rules, but
it is a deliberate acceptance rather than an oversight: the script's "counts
only" claim describes ITS report, not the repo methods it calls.

REPORTING (counts and type histogram only, never keys, bodies or numbers):
rows scanned, attachments eligible, recovered by type, skipped-unparseable-key,
skipped-no-url, skipped-twilio-404, skipped-still-opaque, skipped-email-row,
skipped-legacy-row, written, vendor calls made.

Concurrency: the backfill targets old rows while `media.mirror` only ever
touches recent ones, so a race is not expected; the backfill nonetheless writes
through the existing repo methods so pointer rows stay consistent.

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

SIZING NOTE: widening these interfaces breaks every exhaustive object literal
that implements them - FOUR for `MessagingAdapter` and one for `MediaStore`
across the test helpers and fakes. The builder must expect a spread of
mechanical type errors, not a single one.

### 6.8 fake-twilio and e2e

`fake-twilio/src/engine/signer.ts:27` `inferMediaContentType` maps only
png/gif/webp/jpg/pdf and returns octet-stream otherwise, so today the harness
CANNOT produce a declarable-tier inbound MMS. Nor can the seeds: the only
seeded MESSAGE attachment is `image/jpeg` (`lib/seed/cast.ts:1210`), and the
seeded `audio/mpeg` object (`lib/seed/media.ts:122`) is a CALL RECORDING
reachable only through `recording_s3_key` (`lib/seed/cast.ts:1075`) and a
different route.

So a new canned non-image asset is required, and it is more than a suffix
branch: the canned-asset registry, its pinning test and the static serving path
all live in `fake-twilio/web/` and must be updated together. The builder must
locate all of them before adding the asset rather than assuming `signer.ts` is
the whole change.

## 7. Security analysis

The guarantee that must survive D2:

> No object in the media bucket ever carries a script-capable Content-Type, and
> no media response ever renders a script-capable type same-origin.

### 7.1 Write side - every gate, not one gate

There is no single choke point. Every writer of an S3 object Content-Type, with
the allowlist it enforces:

- `normalizeStoredMediaType` - inbound MMS mirror, deferred mirror job, inbound
  email attachments. Widened by this change; closed allowlist via the resolver.
- presigned-POST MMS uploads (`routes/mmsMedia.ts:78`, `isInlineMediaType`).
- MMS transcode output (`routes/mmsMedia.ts:143`) - writes
  `result.contentType`, which is the literal `'image/jpeg'` the encoder always
  produces (`adapters/mediaTranscode.ts:28,80,109` - the return type is the
  string literal, so it is constrained by TYPE, not by policy). NOT
  `planMmsMedia`, which only decides a PLAN from the source type and constrains
  no output. Named precisely because this bullet has been wrong in every
  previous draft.
- presigned-POST email attachments (`routes/emailMedia.ts`, `isEmailAttachmentType`).
- presigned-POST unit photos (`routes/units.ts:516,686`, `isImageMediaType`).
- call recordings (`routes/webhooks/voice.ts:1995`) - hardcoded `audio/mpeg`.
- the seeder (`lib/seed/media.ts:121-128`) - literal types, dev fixtures only.
- NEW: the backfill, which passes every recovered type through
  `normalizeStoredMediaType` and so cannot write a type the runtime would not.

Each is a closed allowlist of non-active types, or a hardcoded constant. The
invariant holds because every gate holds, not because one function guards them
all.

### 7.2 Read side

The inline tier is still gated on `INLINE_MEDIA_TYPES`, now via
`resolveMediaTier`; the set is unchanged and the matching change is analysed in
5.1. The declarable tier always sets `Content-Disposition: attachment`, which
forces a download rather than a render even if a type ever reached it wrongly.

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

WRITERS of an attachment content-type: the eight listed in 7.1, plus
`repos/messagesRepo.ts` `append` / `annotateMessage` / `putMediaPointers` for
the pointer-row copy, plus `services/sendMessage.ts` / `jobs/retrySend.ts` for
OUTBOUND attachments (unchanged; listed so a reviewer can confirm it).

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
  the MIME source is long gone, so their stored TYPE is UNRECOVERABLE by any
  means. 6.1 fixes new ones. Old ones keep the opaque tier - but they do keep
  their real filename, and 6.3's extension rule 2 is what lets `budget.xlsx`
  still download as `budget.xlsx` rather than `budget.bin`.

  KNOWN LIMIT on that recovery: inbound email caps the SUMMED attachment
  filename bytes (`services/inboundEmail.ts:115,682-685`). The cap is
  codepoint-safe but not extension-aware, so a name truncated mid-extension
  (`budget.xls`, `budget.xl`) falls out of the ACCEPTED set and degrades to
  `.bin` for exactly the population rule 2 serves. Accepted, not fixed: making
  the cap extension-aware is a change to the inbound email write path for a
  cosmetic gain on already-truncated historical names.

### 8.6 A serving change this spec does NOT scope away: outbound email attachments

Outbound email attachments are stored by the presign/confirm path with types
from `EMAIL_ATTACHMENT_TYPES` - `text/plain`, `text/csv`, docx, xlsx - and
their S3 objects ALREADY carry those types. They are served by the SAME route.
So they move from the opaque tier to the declarable tier the moment 6.2 lands,
with no backfill and no other change.

That is the intended behavior and an improvement, but it is a behavior change
outside the reported bug, so it is named here rather than discovered later, and
section 9 covers it with a test. It does not contradict non-goal 4, which
excludes the SEND path; nothing about sending changes.

IT IS ALSO THE ONLY SUCH POPULATION, and here is the enumeration that shows it,
so the next reader does not have to redo it. Only objects reachable through
`media_attachments` are served by this route, which excludes most writers
outright:

| Stored population | Reachable via `media_attachments`? | Tier move? |
|---|---|---|
| inbound MMS/relay mirror | yes | only after the backfill (6.6) |
| inbound email attachments | yes | new ones via 6.1; old ones never (8.5) |
| OUTBOUND email attachments | yes | YES, immediately, no backfill |
| outbound MMS uploads + transcode output | yes, but bounded to jpeg/png/gif by `resolveAttachmentKeys` | no - already inline tier |
| unit photos | no - own route (`unitMediaServe.ts`) | n/a |
| call recordings | no - own route + `recording_s3_key` | n/a |
| seeds | only `cast.ts:1210`, `image/jpeg` | no - already inline tier |

## 9. Testing

Unit (app):

- `resolveMediaTier`: each tier; ESSENCE matching accepts
  `text/plain; charset=utf-8` and `image/png; charset=x` and still refuses
  `text/html; charset=utf-8`; the canonical member and its extension come back
  together; unknown and absent are opaque.
- `normalizeStoredMediaType` keeps declarable types and still collapses
  `text/html`, `image/svg+xml`, XHTML, XML, unknown and absent.
- REGRESSION GUARD: `isInlineMediaType('video/mp4')` is false, and
  `isInlineMediaType('image/png; charset=x')` is STILL FALSE (it keeps exact
  matching), and the outbound upload gate still refuses `video/mp4` (5.2).
- Serve route: one test per tier asserting Content-Type, disposition and
  filename TOGETHER; a stored filename contributes its stem but never its
  extension when the tier is inline or declarable (`invoice.exe` typed
  `video/mp4` downloads as `invoice.mp4`); an OPAQUE attachment named
  `budget.xlsx` keeps `.xlsx` (6.3 rule 2) while one named `invoice.exe`
  becomes `invoice.bin`; `photo.jpeg` on the OPAQUE tier keeps `.jpeg` (the
  ACCEPTED set is wider than the emission map - the regression guard for the
  variant-spelling defect); `nosniff` and CSP present on all three tiers.
- Filename construction, as its own unit (pure function, no route): a stored
  `attachment-0` is treated as absent; `.env` has an empty stem and falls
  through; `data.tar.csv` splits at the LAST dot; `report.` does not produce a
  double dot; a 120-character stem is capped to 100 WITHOUT truncating the
  extension; a filename carrying CRLF and quotes cannot inject a header; a
  non-ASCII stem produces `filename*`.
- OUTBOUND EMAIL ATTACHMENT (8.6): an `xlsx` attachment on an outbound email
  message is served `application/vnd...sheet` + `attachment` + `.xlsx`.
- Mirror: a `video/mp4` target stores `video/mp4`; `text/html` still stores
  octet-stream.
- Inbound email: a `.docx` attachment now stores its real type.
- Backfill: the index comes from the s3Key, PROVEN with a compacted
  attachments array whose position 0 carries index 1; the per-message step 5
  runs once for a two-attachment message; write order proven by failing the row
  write and re-running to a correct result; a re-run over a repaired row is a
  no-op while a row with an unrepairable attachment is re-queried; unparseable
  key, Twilio 404, missing `mediaUrls`, email rows, legacy rows and a recovered
  active type all skip and count.

Dashboard: `image/heic` renders as a file link in BOTH `AttachmentGallery` and
`MediaGallery`; `image/jpeg` still renders inline in both; email attachment
filename still labels the link. NEW, and absent from every earlier draft: a
DECLARABLE attachment with no filename is labelled with its kind
("Video - Attachment 1"), and an OPAQUE one with no filename is still labelled
bare ("Attachment 1") - the two halves of 6.4's fallback rule, neither of which
any existing test covers.

e2e: inbound `.mp4` into a relay thread via the fake -> the attachment link is
a file link, and the served response carries `video/mp4`,
`Content-Disposition: attachment` and a `.mp4` filename.

Existing assertions that MUST change, and why (so a reviewer does not read the
change as a broken guard):

- `app/test/mmsMedia.test.ts:229`, `app/test/apiRoutes.test.ts:648,661` assert
  `content-disposition` is UNDEFINED on the inline path. The inline tier now
  sends `inline; filename=...` (6.2, rationale in 7.3), so these change from
  "absent" to "starts with inline".
- NONE of the dashboard label assertions change. They are listed to stop a
  builder "fixing" one: `Timeline.test.tsx:552` is the image `alt` (6.4
  exempts it), `:555` is the PDF file link (6.4 keeps "PDF attachment N"), and
  `Timeline.email.test.tsx:88,107` are OPAQUE-tier fallbacks - both attachments
  are `application/octet-stream` with no filename, which 6.4's opaque rule
  leaves bare. `Timeline.email.test.tsx:87` is the filename-labelled case, also
  unchanged.

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
bucket (`CopyObject` needs BOTH). The `assertHousingChoiceAccount` guard from
`scripts/lib/hcAws.mjs` is mandatory - the default AWS credential chain
resolves to the wrong account in this environment.

Note that `--dry-run` reads the live Twilio account once per candidate
attachment (6.6). It is safe, but it is not free and it is not offline.

## 11. Risks

- Twilio media retention: an old enough message may have no media left. The
  backfill counts these and moves on; those attachments keep the opaque tier.
  The dry-run histogram tells us the real number before anything is written.
- The recovered type is what the sending handset/carrier declared, so a
  mislabeled file stays mislabeled. Out of scope to detect; magic-byte sniffing
  was considered and rejected as unnecessary for this fix.
- REVERSIBILITY IS PARTIAL, and only for one of the three writes. The media
  bucket has versioning ENABLED with no lifecycle rule at all
  (`infra/modules/s3_media/main.tf:12-17`), so each `CopyObject` retains the
  pre-backfill object as an addressable noncurrent version - recoverable, at
  the cost of a full extra copy per repaired object, forever. The pointer-row
  and message-row writes are DESTRUCTIVE OVERWRITES in DynamoDB with no version
  history; nothing restores their prior `contentType` except re-deriving it.
  Since the prior value was `application/octet-stream` by selection, that is a
  cheap re-derivation, but it is not a rollback.
- `CopyObject` changes ETag and LastModified. Nothing in the app keys off
  either.

## 12. Follow-ups

- FILED: `docs/issues/relay-forwards-undeliverable-media.md` (D3) - relay
  fan-out forwards media Twilio cannot carry, failing the whole leg including
  its body text.
- AMEND IN THIS CHANGE: `docs/issues/media-serve-stored-xss.md:30-32` asserts
  exact-string parameter behavior that 5.1 supersedes.
- `routes/unitMediaServe.ts:65` has the same extensionless
  `filename="unit-media"` shape. Unit photos are image-only so the download
  branch is a rarely reached fallback; noted, not fixed here.
- INCIDENTAL: `routes/api.ts:23` imports `normalizeStoredMediaType` and never
  uses it - a pre-existing unused import. The implementer necessarily edits
  that import line, so the dead symbol is dropped in passing.
