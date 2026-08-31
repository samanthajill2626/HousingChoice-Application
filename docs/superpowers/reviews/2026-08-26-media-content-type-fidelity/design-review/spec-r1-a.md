# Adversarial design review R1-A

Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
Repo state: `W:/tmp/media-content-type-fidelity`, HEAD `ce536a30` (the spec's
header says "cut from `main` @3c2962a4"; the branch has since gained the D3
issue commit).

Every claim below cites a line I read. Anything I could not confirm is marked
UNVERIFIED.

---

## 1. [BLOCKING] The backfill derives the MediaSid from the wrong index - it will write the wrong Content-Type onto the wrong object

**What is wrong.** Section 6.6 step 1: "Derive the MediaSid from the stored
`mediaUrls[index]`". `index` there can only mean the attachment's POSITION in
`media_attachments`. Position is NOT the provider's MediaUrl index whenever a
message was mirrored in more than one pass - which is exactly the case the
mirror's whole retry/defer design exists to produce.

**Evidence.**

- `app/src/jobs/mediaMirror.ts:152-159` - the deferred rung reads the existing
  array and APPENDS what newly landed:
  ```
  const existing: MediaAttachment[] = current ? mediaAttachmentsOf(current) : [];
  const merged = [...existing];
  for (const { attachment } of outcome.attachments) { ... merged.push(attachment); }
  ```
  So if MediaUrl0 failed inline and MediaUrl1 landed, position 0 holds the
  attachment for provider index 1, and a later rung appends provider index 0 at
  position 1.
- This is not hypothetical; a test pins it. `app/test/twilioSmsWebhook.test.ts:1050-1052`
  asserts, after one broken fetch:
  ```
  expect(world.messages[0]!.media_attachments).toEqual([
    { s3Key: `media/${conv.conversationId}/MMmedia02/1`, contentType: 'application/octet-stream' },
  ]);
  ```
  Position 0, s3Key suffix `/1`.
- `app/src/services/mediaMirror.ts:99` builds the key from `target.index`
  (`inboundMediaKey(...)`, line 67-69: `media/<conv>/<sid>/<index>`), so the
  TRAILING SEGMENT OF `s3Key` is the authoritative provider index. The spec
  never mentions it.

**What it implies.** On a partially-mirrored message the backfill fetches the
metadata of a DIFFERENT attachment and stamps that type onto this object's S3
Content-Type, its row entry and its pointer row - silently, and idempotently
wrong (a re-run will not fix it; the row no longer says octet-stream). A video
served as `image/heic`, or worse. The spec must specify derivation from
`s3Key`'s trailing index, and must state what to do when `s3Key` does not match
the `media/<conv>/<sid>/<i>` shape (legacy/email keys).

---

## 2. [BLOCKING] The filename branch hands an attacker-controlled EXTENSION to the operator's operating system, and section 7 never evaluates it

**What is wrong.** Section 6.2 filename resolution step 1 prefers
`attachments[idx].filename` verbatim (sanitized only per 6.3). Section 6.3's
sanitization is explicitly and exclusively a HEADER-INJECTION guard: strip
CR/LF/NUL/quote/backslash/path separators, reject `..`, cap length, RFC 5987
encode. Nothing constrains the EXTENSION, and nothing ties the extension to the
Content-Type actually being served.

**Evidence.**

- `MediaAttachment.filename` is documented as "The original client-supplied
  filename" (`app/src/repos/messagesRepo.ts:810-813`).
- For INBOUND email it is taken straight off the MIME part, capped for bytes
  only: `app/src/services/inboundEmail.ts:683-686`
  (`const filename = truncateToBytes(a.filename, budget); ... stored.push({ s3Key, contentType, filename })`).
  The sender of an inbound email is an arbitrary third party (the same threat
  model section 2.1 invokes for `MediaContentType{i}`).
- Today the serve route emits NO extension at all -
  `app/src/routes/api.ts:2295` - so this exposure does not exist. The spec
  creates it.
- The spec's own section 2.2 states the premise: "Windows and macOS dispatch on
  extension, not on the MIME type the server sent."

**What it implies.** After this change an operator clicking an attachment on an
inbound email saves a file whose name the sender chose: `invoice.pdf.exe`,
`statement.hta`, `lease.lnk`, `photo.scr`. The server correctly says
`application/octet-stream` (the type is opaque), the `attachment` disposition
correctly forces a download, and then the OS dispatches on the attacker's
extension. Section 7's invariant is written only about same-origin RENDER, so
its three enforcement points all pass while the actual new risk goes
unexamined. This is a decision the spec has to make before anyone builds it -
e.g. force the extension from the closed type-to-extension map and treat the
stored filename as a STEM only, or hard-reject a stored extension that does not
match the served type. As written, "sanitized" reads as done and it is not.

---

## 3. [HIGH] Unenumerated reader: the "Media from comms" gallery has the SAME `startsWith('image/')` predicate section 6.4 says must change

**What is wrong.** Section 6.4 identifies ONE reader that must change
(`AttachmentGallery`, `Timeline.tsx:640`) and correctly argues that
`startsWith('image/')` becomes wrong once `image/heic` is stored truthfully.
There is a second, identical predicate the spec never asks anyone to touch.

**Evidence.**

- `dashboard/src/routes/contact/MediaGallery.tsx:36`:
  `m.contentType.startsWith('image/') ? (<img .../>) : (<glyph tile>)` - byte
  for byte the same defect.
- The gallery's data path carries no type filter: `app/src/routes/contacts.ts:1370-1375`
  maps every pointer's `contentType` straight through, and
  `dashboard/src/routes/contact/media.ts:36-43` (`toCommsMediaItem`) copies it
  verbatim.
- Section 8's READERS item 3 names this gallery but only cross-references 6.5,
  and 6.5 is exclusively about the BACKFILL rewriting pointer rows. Nowhere is
  the image predicate mentioned.

**What it implies.** The spec's own stated regression - "a photo that renders
as a broken image today would be a REGRESSION introduced by this change" -
ships in the contact file's gallery. Worse, the backfill is what causes it: as
soon as the pointer rows carry `image/heic` the gallery starts emitting
`<img src>` for undecodable bytes. The dashboard test list in section 9 covers
only the Timeline (`image/heic` renders as a file link) and would pass while
the gallery is broken.

---

## 4. [HIGH] The backfill's write-order guarantee does not cover its LAST write - a pointer failure is permanent divergence

**What is wrong.** Section 6.6 states "WRITE ORDER, LOAD-BEARING: S3 object
first, then the message row, then the pointer rows" and calls that "the
idempotency guarantee". The argument given is that the re-scan predicate is the
ROW still saying octet-stream, so S3-before-row makes a partial failure
recoverable. That reasoning covers the S3 leg and nothing else. The POINTER leg
is written AFTER the row, i.e. after the re-scan predicate has already been
cleared.

**Evidence.**

- `app/src/repos/messagesRepo.ts:2538-2550` - `annotateMessage` writes pointers
  best-effort AFTER the row update and SWALLOWS the failure:
  ```
  try { await this.putMediaPointers(conversationId, tsMsgId, annotations.mediaAttachments); }
  catch (err) { log.error(..., 'media pointers not written for annotated attachments'); }
  ```
- `putMediaPointers` is a loop of unconditional `PutCommand`s
  (`app/src/repos/messagesRepo.ts:2553-2557`) - no transaction with the row
  write, and a mid-loop failure leaves some positions updated and some not.

**What it implies.** S3 correct + row correct + pointer put failed = a re-run
skips the row forever (it no longer says octet-stream) and the pointer keeps
`application/octet-stream`. That is precisely the outcome 6.5 says must not
happen ("the gallery and the thread will disagree about the same bytes"), made
permanent by the very ordering the spec calls the guarantee. The spec needs a
recovery story for the pointer leg (re-select on EITHER the row or the pointer
disagreeing; or run the existing `backfill:media-pointers` afterwards and say
so; or make the pointer write the FIRST DynamoDB write).

---

## 5. [MEDIUM] Section 8 misdescribes the outbound send-path gate

**What is wrong.** Section 8 READERS item 5: "`routes/api.ts` outbound
send-path Head re-check + `routes/mmsMedia.ts:78` upload gate - both gate on
`isInlineMediaType`". The api.ts half is false.

**Evidence.**

- `app/src/routes/api.ts:527-531` (`resolveAttachmentKeys`):
  `if (!isTwilioDeliverableType(contentType)) { return { ok: false, status: 400, error: 'unsupported_attachment_type' }; }`
  - a NARROWER set (jpeg/png/gif, `app/src/lib/mediaTypes.ts:65-69`).
- The only `isInlineMediaType` call in `api.ts` is the media serve at
  `app/src/routes/api.ts:2292`.

**What it implies.** A builder acting on section 8 will "confirm untouched" the
wrong symbol, and a reviewer checking the claim finds it wrong and loses trust
in the rest of the enumeration. The real reasons that path is safe are
different (a narrower deliverable set, plus `UPLOAD_KEY_PATTERN` confining keys
to `uploads/`, `app/src/routes/api.ts:29`) and the spec should say so.

---

## 6. [MEDIUM] Section 7's "safe by construction" enumeration omits three writers into the same bucket, and hides a behavior change to outbound attachments

**What is wrong.** Section 7 point 1 asserts "An unrecognised or active type
cannot be written to S3 by ANY path: the mirror, the deferred `media.mirror`
job, inbound email, and the backfill all pass through it." Three other code
paths write objects into the same media bucket, and none of them goes through
`normalizeStoredMediaType`.

**Evidence.**

- `app/src/routes/mmsMedia.ts:78` - outbound MMS presign, gated on
  `isInlineMediaType`, then the browser POSTs directly to S3.
- `app/src/routes/emailMedia.ts:65` - outbound EMAIL attachment presign, gated
  on `isEmailAttachmentType` (`app/src/lib/mediaTypes.ts:115-127` - includes
  `text/plain`, `text/csv`, docx, xlsx).
- Unit-photo presign (image-only allowlist), plus the SEED (see finding 7).

The invariant does still hold, but by the UNION of four independent allowlists,
not by the single choke point section 7 claims. More importantly the omission
hides a real behavior change: outbound email attachments already sit in S3 with
their true `text/csv` / docx / xlsx type, and they are served by the very route
being changed (`app/src/routes/api.ts:2266`, via `mediaAttachmentsOf`). Today
they download as `application/octet-stream` + `attachment-<idx>`; after this
change they become the DECLARABLE tier and serve with the real type. That is
probably desirable - but section 8 WRITERS item 7 says outbound attachments are
"unchanged ... listed so a reviewer can confirm they are untouched", which is
true of the WRITE and false of the READ.

**What it implies.** The security section's headline mechanism is overstated,
and an outbound-attachment serving change ships unnamed and untested.

---

## 7. [MEDIUM] SEEDS are missing from the "every writer" enumeration

**What is wrong.** Section 8 opens "Every writer and every reader, enumerated.
A surface missing from this list is where the invariant silently breaks." The
seed writes both the S3 object Content-Type and the row's attachment
Content-Type, and appears nowhere.

**Evidence.**

- `app/src/lib/seed/cast.ts:1210`:
  `media_attachments: [{ s3Key: CAST_PHOTO_KEY, contentType: 'image/jpeg' }]`
- `app/src/lib/seed/media.ts:121-128` puts the objects with explicit types
  (`image/jpeg`, `audio/mpeg`) via `store.put(key, ..., contentType)`.

**What it implies.** Today's seeded types happen to be safe, so nothing breaks
on day one. But the enumeration is what a future change consults, and the seed
is also the natural place to exercise the new tier deterministically - note
that `audio/mpeg` is already seeded and is in the proposed DECLARABLE set, so
the seed ALREADY produces a declarable-tier object that section 9 does not
test.

---

## 8. [MEDIUM] Exact-set matching silently defeats the feature for parameterized MIME types

**What is wrong.** Section 5 says `normalizeStoredMediaType` keeps a type
"(trimmed, lowercased)" when it is inline or declarable. The existing helper is
an exact `Set.has` after trim/lowercase (`app/src/lib/mediaTypes.ts:37-39,
56-58`), and `docs/issues/media-serve-stored-xss.md` records the
parameter-stripping behavior as INTENDED security behavior: "`...; charset=...`
parameter forms cannot bypass it."

**Evidence.** `app/src/lib/mediaTypes.ts:38`:
`INLINE_MEDIA_TYPES.has(type.trim().toLowerCase())` - `text/plain; charset=utf-8`
does not match.

**What it implies.** `text/plain; charset=utf-8` and `text/csv; charset=...` are
the ordinary wire forms for the two text types the spec adds, and
`video/3gpp; codecs=...` is a real MMS shape. Every one of them falls to the
opaque tier and downloads as `.bin` - the exact outcome the spec exists to fix -
with no log line saying why. The spec must decide explicitly: strip parameters
before the allowlist test (and then be equally explicit that the SERVED header
is the canonical bare type, never the stored string), or accept the gap and say
so. Section 9's unit list contains no parameterized-type case either way.

---

## 9. [MEDIUM] The ops section contradicts itself about whose credentials run the backfill

**What is wrong.** Section 10: "Requires Twilio API credentials for the target
account and `s3:PutObject` on that environment's media bucket (both already
held by the app role; the script runs with the operator's own environment as
the sibling backfills do)." Those two clauses cannot both discharge the
requirement. The app role's grant is on the EC2 instance role, not on the
operator.

**Evidence.**

- `infra/modules/ec2/main.tf:64-73` grants `s3:GetObject` / `s3:PutObject` /
  `s3:DeleteObject` on `${var.media_bucket_arn}/*` to the EC2 instance role.
- The sibling backfill runs locally under `tsx` against
  `DYNAMODB_ENDPOINT` / `tableName(...)` with no S3 and no vendor API at all
  (`app/scripts/backfill-media-pointers.ts:12-24`) - it is not precedent for
  either capability.

**What it implies.** The runbook step will fail at the first `CopyObject`, or
worse, succeed against the wrong account. The spec also never enumerates the
env the script needs (`MEDIA_BUCKET`, `MESSAGING_DRIVER`, `TWILIO_*`,
`TABLE_PREFIX`, `AWS_PROFILE`) or an account-ID guard, and `CopyObject` also
needs `s3:GetObject` on the source, which the spec's "Needs only `s3:PutObject`"
(section 6.7) does not mention. (The grant does cover it - the spec's statement
of what is needed is what is wrong.)

---

## 10. [MEDIUM] The media bucket is VERSIONED with no noncurrent-version expiry; in-place CopyObject leaves the wrongly-typed version forever

**What is wrong.** Section 11 lists the CopyObject cost as "changes ETag and
LastModified on production objects. Nothing in the app keys off either." That
is not the whole cost.

**Evidence.** `infra/modules/s3_media/main.tf:12-17` -
`aws_s3_bucket_versioning "media" { versioning_configuration { status = "Enabled" } }`.
The file defines no `aws_s3_bucket_lifecycle_configuration` at all, so there is
no `noncurrent_version_expiration`.

**What it implies.** Every backfilled attachment permanently retains a
noncurrent version carrying `application/octet-stream` - storage doubles for
the repaired set, forever, and a version-ID-addressed read (none today, but
presigns and any future restore path) still returns the wrong type. Not a
blocker, but it belongs in section 11 and possibly in the runbook, and the
dry-run histogram is the right place to size it.

---

## 11. [LOW] "One source of truth" is contradicted by the spec's own mechanism - the type-to-extension map is the THIRD copy

**What is wrong.** Section 5 opens "Three tiers, one source of truth, in
`lib/mediaTypes.ts`." The design then (a) mirrors the inline raster set into
`dashboard/src/routes/contact/media.ts` (6.4, unavoidable and acknowledged) and
(b) adds a new "closed type-to-extension map" (6.2) without saying what to do
about the one that already exists.

**Evidence.** `app/src/services/sendEmailMessage.ts:225-235` - `EMAIL_EXTENSIONS`
already maps jpeg/png/gif/webp/pdf/txt/csv/docx/xlsx to extensions, i.e. the
whole document half of the proposed DECLARABLE set. Section 2.2 cites this code
as prior art and then proposes a parallel map anyway.

**What it implies.** Two extension maps that must agree, with nothing making
them agree. Either move `EMAIL_EXTENSIONS` into `lib/mediaTypes.ts` and have
both callers use it, or state in the spec why they stay separate (the email one
is an outbound MIME-part name, the new one a Content-Disposition name - a
defensible split, but the spec has to make it).

---

## 12. [LOW] The D3 follow-up in section 12 is already filed on this branch

**What is wrong.** Section 12 lists "Relay forwarding of non-image media (D3)"
under "Follow-ups to file". It exists.

**Evidence.** `docs/issues/relay-forwards-undeliverable-media.md`
(`id: relay-forwards-undeliverable-media`, `created: 2026-08-26`,
`severity: high`), committed as `ce536a30`, the current HEAD. Its body already
names this spec and already records the post-change `video/mp4` observation
that section 8 READERS item 4 states.

**What it implies.** A builder following section 12 files a duplicate. Also
note the existing issue is stronger than section 8's watch item: a 12300 fails
the WHOLE leg, so members receive neither the media nor the body text. Section
8's "forwarding fails before and after - no regression" is consistent with it,
but the spec should point at the filed issue rather than restate a weaker
version. (Whether Twilio's behavior actually differs between
`application/octet-stream` and `video/mp4` is UNVERIFIED in both documents.)

---

## 13. [LOW] Section 6.8 names one fake-twilio file and misses the canned-asset surface

**What is wrong.** 6.8 says "Add one small canned non-image asset (a few-KB
`.mp4`) plus its suffix branch" and cites only
`fake-twilio/src/engine/signer.ts:27`. Adding an asset touches more than that.

**Evidence.**

- `fake-twilio/web/src/assets/canned/index.ts:33-37` - `cannedAssets` is the
  picker registry (`room.png`, `kitchen.png`, `lease-doc.pdf`).
- Same file, lines 1-14: the assets are STATIC FILES under the host's
  `public/canned/`, "deliberately NOT imported through Vite" because Vite inlines
  anything under 4 KB as a `data:` URI, which the engine's http(s)-only guard
  then rejects. A "few-KB .mp4" runs straight into that documented trap.
- Same file, lines 46-48: `isImageAsset(url)` drives the dev UI's `<img>`
  thumbnail - a new `.mp4` in `cannedAssets` needs that branch too.
- The e2e can bypass the registry (`e2e/scenarios/steps.ts:2205` builds
  `${fakeUrl}/canned/room.png` directly), so the spec's e2e may work while the
  fake-phones UI shows a broken thumbnail.

---

## 14. [LOW] Widening the `MediaStore` interface breaks the full test double, unmentioned

**Evidence.** `app/test/helpers/twilioWebhookHarness.ts:3425` declares
`const mediaStore: MediaStore = { ... }` - a complete object literal, not a
`Pick<>`. Adding a required `setContentType` to the interface (6.7) fails
typecheck there. One-line fix, but section 6.7 presents the adapter addition as
having no other surface ("NO new infra") and a builder should be told.

---

## 15. [LOW] Serve the CANONICAL allowlist string, not the stored one

**What is wrong.** Section 6.2 steps 2 and 3 both say "serve `stored`". The
current code does the same (`app/src/routes/api.ts:2293`,
`res.setHeader('Content-Type', inline ? stored! : 'application/octet-stream')`),
so the stored string's case and surrounding whitespace reach the header even
though the ALLOWLIST test trimmed and lowercased it
(`app/src/lib/mediaTypes.ts:38`). Harmless today; with a wider set and a new
extension map keyed on the type it becomes a place where the header, the tier
decision and the extension lookup can disagree on the same string. Emit the
matched constant.

---

## 16. [LOW] Backfill selection will sweep up inbound EMAIL rows it can never repair

**What is wrong.** Section 6.6 selects "message rows carrying
`media_attachments`, direction `inbound`, with at least one attachment whose
`contentType` is `application/octet-stream`". Inbound email rows match that
predicate and have no Twilio media at all.

**Evidence.** `app/src/services/inboundEmail.ts:676-686` stores attachments
under `media/<conversationId>/<rfcIdSafe>/<i>` with no `mediaUrls`; the row's
`providerSid` is the RFC message-id (`app/src/services/inboundEmail.ts:713`),
not an `MM...`.

**What it implies.** Every historical inbound-email attachment lands in
`skipped-no-url`, so the dry-run histogram - the artifact section 10 says the
operator reads to decide - is polluted by rows that are not candidates. Exclude
`type === 'email'` in the selection and count it separately. Related: the spec
says "Selection: ... with at least one attachment whose `contentType` is
`application/octet-stream`" without noting that a DynamoDB `FilterExpression`
cannot test elements of a list, so that half of the predicate has to be applied
client-side after the scan (compare `app/scripts/backfill-media-pointers.ts:59-70`,
which filters server-side only on `attribute_exists`).
