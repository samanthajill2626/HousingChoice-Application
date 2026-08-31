# Adversarial design review R1-B

Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
Repo: `W:/tmp/media-content-type-fidelity` @ working tree (branch `main`, clean)
Reviewer scope: conflicts with existing behavior, unenumerated surfaces,
contradictions/slogans. Every claim below cites a file:line I opened.

What the spec gets RIGHT (verified, so nobody re-checks it): the root-cause
citations are accurate. `mediaTypes.ts:56-58` collapses to octet-stream on the
inline allowlist; `mediaMirror.ts:104` is the write; `api.ts:2295` emits
`attachment; filename="attachment-${idx}"` with no extension and never reads
`attachments[idx].filename` (in scope at `api.ts:2267`); `sendEmailMessage.ts`
does carry the extension map (`:224-236`) and the 1-based synthesized name
(`:339`); the 5.1 trap is real (`isInlineMediaType` has exactly two call sites,
`api.ts:2292` and `mmsMedia.ts:78`); the must-update test list in section 9 is
exactly right (`apiRoutes.test.ts:648,661`, `mmsMedia.test.ts:229`); section 1's
`ConversationDetail.tsx:32` really is `import { Timeline } from
'../contact/Timeline.js'`; the "unused import" in section 12 really is unused
(`normalizeStoredMediaType` appears in `api.ts` only at line 23); the
mirror-constant-in-dashboard convention really is the house style
(`ListingDetail.tsx:122-130`); and `MAX_MEDIA_CONTENT_LENGTH` really is 25 MB
(`adapters/messaging.ts:241`), so the CopyObject single-part claim holds.

The findings below are what is wrong.

---

## 1. [BLOCKING] The backfill's MediaSid derivation assumes `media_attachments[i]` corresponds to `mediaUrls[i]`. It does not.

**What is wrong.** Section 6.6 step 1: "Derive the MediaSid from the stored
`mediaUrls[index]`", where `index` is the attachment's position in
`media_attachments`. Those two arrays are not positionally aligned, by
construction, on exactly the messages the backfill targets.

**Evidence.**

- The webhook persists only the attachments that LANDED, compacted:
  `routes/webhooks/twilio.ts:496-497` -
  `const attachments: MediaAttachment[] = outcome.attachments.map((a) => a.attachment);`
  `mirrorMediaSet` pushes only successes (`services/mediaMirror.ts:111`) and
  records the rest in `out.failed` (`:129`). If MediaUrl0 404s on its inline
  ladder and MediaUrl1 lands, the stored array is `[attachment-for-url-1]`, i.e.
  `media_attachments[0]` -> `mediaUrls[1]`.
- The deferred job then APPENDS the late arrivals to the END of whatever is
  already there: `jobs/mediaMirror.ts:150-160` builds `merged = [...existing]`
  and pushes. So a message whose index-0 media arrived on a later rung stores it
  at array position 1.
- The retry ladder exists precisely because this happens in production - the
  header comment at `services/mediaMirror.ts:5-11` records 2 of 6 inbound MMS in
  one day losing media to the 404 beat. Partially-mirrored multi-attachment
  messages are the expected population, not a corner case.

**What it implies.** The one-time production repair writes the wrong
Content-Type onto the wrong S3 object, the wrong row entry, and the wrong
pointer row, on any multi-attachment message that did not mirror cleanly in one
pass - and it does so irreversibly (the original type is gone; a re-run will
skip the row because it no longer says octet-stream). The correct index is
already carried by the data: `inboundMediaKey` encodes it in the key itself -
`media/${conversationId}/${messageSid}/${index}` (`services/mediaMirror.ts:67-69`).
The design must derive the MediaUrl index from `a.s3Key`, not from the array
position, and must state what it does when the key does not parse.

Related: inbound EMAIL attachments use the SAME key shape with a different
middle segment - `media/${conversationId}/${rfcIdSafe(rfcId)}/${i}`
(`services/inboundEmail.ts:676`) - so a key-parsing implementation must also
discriminate on `type`/`direction`, which section 6.6 does not mention.

---

## 2. [HIGH] Unenumerated reader: `MediaGallery.tsx:36` has the identical `startsWith('image/')` predicate section 6.4 calls a regression, and the spec never changes it.

**What is wrong.** Section 6.4 correctly identifies that
`att.contentType.startsWith('image/')` becomes WRONG once `image/heic` is stored
truthfully, and mandates a fix at `Timeline.tsx:640`. There are TWO such
predicates in the dashboard. The other one is not named anywhere in the spec.

**Evidence.**

- `dashboard/src/routes/contact/MediaGallery.tsx:36` -
  `m.contentType.startsWith('image/') ? (<img .../>) : (<glyph tile/>)`.
- That component is fed by `toCommsMediaItem` (`contact/media.ts:36-43`), which
  copies `item.contentType` straight from the pointer index - the exact state
  section 6.5 says the backfill must rewrite.
- Section 8 READERS item 3 names this gallery, but only "via
  `MediaPointer.contentType` (6.5)", and 6.5 is entirely about backfilling
  pointer ROWS. Nothing tells the builder to touch the render predicate.
- Repo-wide there are exactly two stored-contentType image predicates:
  `Timeline.tsx:640` and `MediaGallery.tsx:36` (grep over `dashboard/src`).

**What it implies.** After the backfill, every `image/heic` / `image/bmp` /
`image/tiff` in the "Media from comms" grid renders as a broken `<img>` tile -
the precise regression section 6.4 exists to prevent, shipped in the surface the
spec's own enumeration promised would catch it. The mirrored dashboard set in
`contact/media.ts` must be consumed by BOTH components. (Note `MediaGallery.tsx:56`
also hard-codes the pdf-vs-clip glyph; a video tile will show a paperclip. Cosmetic,
but the same edit.)

---

## 3. [HIGH] "Forwarding fails before and after - no regression" rests on a gate that does not exist on the forwarding path.

**What is wrong.** Section 8 READERS item 4 and section 12 both assert that
relay forwarding of non-image media is blocked by `TWILIO_DELIVERABLE_MMS_TYPES`
"regardless of content type", and conclude there is no regression when a
forwarded object's type changes from `application/octet-stream` to `video/mp4`.
`jobs/relayFanOut.ts` never consults that set, or any content type at all.

**Evidence.**

- Grep for `contentType|Deliverable|isImage|mediaTypes` in
  `app/src/jobs/relayFanOut.ts`: **no matches**.
- `relayFanOut.ts:494-499` presigns EVERY source attachment unconditionally -
  `sourceMedia.map((a) => store.presign(a.s3Key, RELAY_PRESIGN_TTL_SECONDS))` -
  and hands the URLs to `adapter.sendMessage` at `:508`.
- The only `isTwilioDeliverableType` call in the app is `routes/api.ts:529`, in
  `resolveAttachmentKeys`, i.e. the outbound COMPOSE path. It is not on the
  relay fan-out path.

**What it implies.** What happens to a forwarded video today, and what happens
after, is decided entirely by Twilio's reaction to the presigned object's
Content-Type - not by any code in this repo. The spec's stated basis for "no
regression" is therefore vacuous, and the outcome is UNVERIFIED. The plausible
bad case is the opposite of the spec's assumption: Twilio refuses
`application/octet-stream` today and may ATTEMPT delivery of `video/mp4`,
turning a currently-failing forward into a multi-megabyte MMS fan-out to every
member of every relay group, billed per leg. D3 defers the forwarding FIX; it
cannot defer a behavior change this feature causes. Either prove the Twilio
behavior on both types, or add the `isTwilioDeliverableType` filter to
`relayFanOut.ts:494-499` as part of this change so the forward path's behavior
is pinned by our code rather than by the vendor.

---

## 4. [HIGH] The opaque tier does not produce `.bin`. Section 6.2's filename ordering overrides section 5's table and hands the OS an attacker-chosen extension.

**What is wrong.** Section 5's table says the Opaque tier's filename is `.bin`.
Section 6.2's filename resolution is stated globally, tier-independently, and
puts the stored `filename` FIRST. Both cannot hold.

**Evidence.**

- Section 5 table row 3: `Opaque | everything else | application/octet-stream |
  attachment | .bin`.
- Section 6.2: "Filename resolution, in order: 1. `attachments[idx].filename`
  when present and non-empty, sanitized (6.3). 2. Otherwise `attachment-<idx +
  1><ext>`". No tier qualifier.
- Inbound email stores an arbitrary sender-supplied filename alongside a
  collapsed type: `services/inboundEmail.ts:683-686` -
  `stored.push({ s3Key, contentType, filename })` where `contentType =
  normalizeStoredMediaType(a.contentType)` (`:677`) and `filename` is the MIME
  part's name, only length-truncated.
- Section 6.3's sanitizer strips CR/LF/NUL, `"`, `\`, path separators and `..`,
  collapses whitespace and caps length "preserving the extension". It never
  constrains WHICH extension, and does not strip Unicode bidi overrides (U+202E),
  which is the standard extension-spoofing trick against the RFC 5987
  `filename*` form the same section mandates.

**What it implies.** A mail with an `application/x-msdownload` part named
`invoice.exe` is stored as opaque today and downloads as the inert, extensionless
`attachment-0` (`routes/api.ts:2295` - the route can currently emit nothing
else). After this change it downloads as `invoice.exe`. The opaque tier exists
precisely because the type is not trusted; giving it the untrusted NAME as well
inverts its purpose, and section 2.2's own premise ("Windows and macOS dispatch
on extension") is what makes it consequential. Decide it explicitly: either the
opaque tier always synthesizes `attachment-<n>.bin`, or the sanitizer holds a
closed extension allowlist. Say which, in the table AND in 6.2.

---

## 5. [HIGH] The guarantee is not delivered for inbound email: every such attachment already carries a synthesized, extensionless, 0-based stored filename that section 6.2 rule 1 prefers.

**What is wrong.** Section 6.2's rule 1 assumes a stored `filename` is real user
data and therefore better than a synthesized name. For inbound email it is
frequently a synthesized placeholder, and one with the exact defect this spec
exists to fix.

**Evidence.**

- `app/src/lib/emailMime.ts:100-106`, the INBOUND parser: `filename: typeof
  a.filename === 'string' && a.filename.length > 0 ? a.filename :
  \`attachment-${i}\`` - 0-based, no extension.
- Pinned by test: `app/test/emailMime.test.ts:144` -
  `expect(parsed.attachments[0]!.filename).toBe('attachment-0')`.
- That value is what `inboundEmail.ts:683-686` persists.

**What it implies.** Two failures at once. (a) An inbound email attachment with
no MIME filename - now stored with its true `application/vnd...document` type per
section 6.1 - still downloads as `attachment-0` with no extension, so the fix
does not reach it. (b) It is 0-based, directly contradicting section 6.2's
"deliberate off-by-one correction ... becomes 1-based to match the UI". Rule 1
needs a condition ("...and it carries an extension"), or the resolution must
append the derived extension when the stored name lacks one.

---

## 6. [MEDIUM] The backfill's selection criteria sweep in inbound EMAIL rows it can never repair, and the spec never says so.

**What is wrong.** Section 6.6 selects "message rows carrying
`media_attachments`, direction `inbound`, with at least one attachment whose
`contentType` is `application/octet-stream`". Inbound email rows match that
description exactly, and step 1's Twilio-MediaSid mechanism cannot touch them.

**Evidence.**

- `services/inboundEmail.ts:711-733` builds the row with
  `direction: 'inbound'`, `type: 'email'`, `mediaAttachments: stored`, and NO
  `mediaUrls` key. (`mediaUrls` is only ever set on the Twilio paths -
  `routes/webhooks/twilio.ts:600, 998, 1707, 2128`.)
- Those attachments are collapsed to octet-stream today by the same helper
  (`inboundEmail.ts:677`) - section 6.1 says so explicitly.

**What it implies.** Every historical inbound-email attachment lands in the
`skipped-no-url` bucket. That is the counter section 6.6 defines to mean "the
row was malformed", so the dry-run histogram the operator reads in section 10 to
decide whether to apply is contaminated by a large, structurally-unrepairable
class it cannot distinguish. Worse, those types ARE recoverable - the raw MIME is
retained at `email_raw_ref` (`inboundEmail.ts:728`) - so the spec silently
writes off recoverable data without ever naming the tradeoff. Either add a
`skipped-email` counter and an explicit non-goal, or handle the class. Section
6.1 makes inbound email a first-class part of this change; sections 6.6, 8.5,
10 and 11 then never mention it again.

---

## 7. [MEDIUM] Section 8.5 and section 6.6 contradict each other about legacy `media_s3_keys` rows.

**What is wrong.** Section 8.5: legacy rows "are skipped and counted by the
backfill". Section 6.6's selection is rows "carrying `media_attachments`". A
legacy-only row carries no such attribute, so it is not selected and cannot be
counted.

**Evidence.** `repos/messagesRepo.ts:1001-1006` - `mediaAttachmentsOf` FOLDS
`media_s3_keys` into the new shape at READ time; nothing materializes a stored
`media_attachments` array for those rows. The sibling backfill had to filter for
both explicitly to see them: `app/scripts/backfill-media-pointers.ts:62` -
`FilterExpression: 'attribute_exists(media_attachments) OR
attribute_exists(media_s3_keys)'`.

**What it implies.** A builder implementing 6.6 literally produces a
`skipped-legacy` counter that is always zero, and the reviewer reading 8.5
believes the class was measured. Pick one: either widen the filter and count
them, or delete the "and counted" claim.

---

## 8. [MEDIUM] Section 8's WRITERS list omits every non-message writer of a media-bucket object Content-Type, which falsifies section 7's "cannot be written to S3 by any path".

**What is wrong.** Section 7 point 1 states the invariant over "the media
bucket" and enumerates four paths (mirror, `media.mirror` job, inbound email,
backfill) as if they were all of them. They are the four that go through
`normalizeStoredMediaType`. There are at least five others writing object
Content-Type into the same bucket under different allowlists - including the DEV
SEAM section 8 explicitly promises to enumerate.

**Evidence.**

- `app/src/lib/seed/media.ts:121-128` - the SEEDER puts `image/jpeg` and
  `audio/mpeg` straight into `media/cast/...` with no normalization at all. This
  is the reseed/dev-seam surface; `audio/mpeg` is not in any current allowlist.
- `routes/mmsMedia.ts:83-86` (presigned POST pinned to a client-declared type
  gated by `isInlineMediaType` at `:78`) and `:143` (the transcode derivative).
- `routes/emailMedia.ts:102-108` - gated by `isEmailAttachmentType`, a WIDER set
  than the mirror's (`lib/mediaTypes.ts:115-127`).
- `routes/units.ts:677` (unit photos, `isImageMediaType`) - and `unit-media/*` is
  the one prefix exposed publicly via CloudFront
  (`infra/modules/s3_media/main.tf:69-89`).
- `routes/webhooks/voice.ts` recording mirror.

**What it implies.** Nothing is broken today - each of those paths carries its
own allowlist - but the spec's central security paragraph asserts a
whole-bucket, single-gate guarantee that only one of six gates actually
enforces. A reader who trusts section 7 will assume widening
`normalizeStoredMediaType` is the only lever on that invariant. Restate the
invariant over the paths it actually governs (inbound-mirrored media), or
enumerate the other gates and their sets.

---

## 9. [MEDIUM] The media bucket is VERSIONED with no noncurrent-version expiry, so every `CopyObject` permanently retains the wrongly-typed original.

**Evidence.** `infra/modules/s3_media/main.tf:12-17` -
`aws_s3_bucket_versioning "media" { versioning_configuration { status =
"Enabled" } }`. There is no `aws_s3_bucket_lifecycle_configuration` anywhere in
that module (the file is 97 lines; I read all of it).

**What it implies.** A same-key `CopyObject` writes a new version and keeps the
old one indefinitely - up to 25 MB per repaired attachment
(`adapters/messaging.ts:241`), permanently, with no expiry rule to reclaim it.
Section 11's risk list mentions only ETag and LastModified. This is a standing
storage-cost consequence of D2 on production, and it belongs in the risk list so
the human decides it with the dry-run histogram in hand.

Secondary, non-blocking: `put` sets no user metadata
(`adapters/mediaStore.ts:144-153`, `ContentType` only), so
`MetadataDirective: 'REPLACE'` destroys nothing. That part of 6.7 is safe -
worth saying in the spec, because REPLACE silently dropping metadata is the
usual trap and a reviewer will look for it.

---

## 10. [MEDIUM] "Already granted - NO new infra" is proven for the wrong IAM principal.

**What is wrong.** Section 6.7 justifies the CopyObject permission with "already
granted (the mirror `put`s with it)". Section 10 then says the script "runs with
the operator's own environment as the sibling backfills do", and calls the
permissions "both already held by the app role".

**Evidence.** The grant is on the EC2 INSTANCE role:
`infra/modules/ec2/main.tf:64-73` - `sid = "MediaObjects"`, actions
`s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` on `${var.media_bucket_arn}/*`.
The sibling backfill it is modeled on runs against whatever credentials the
operator's shell holds (`backfill-media-pointers.ts:14-16`, "no local-only
guard, this is an ops script the human runs against dev and prod ... with the
target environment set on purpose").

**What it implies.** The app role's permissions are irrelevant to a script the
human runs from their own shell. Whether the operator's IAM principal can
`s3:PutObject` on the PROD media bucket is UNVERIFIED - and the failure mode is
mid-run: with the mandated S3-first write order, an AccessDenied on the copy
aborts before any row is touched (recoverable), but a principal with GetObject
and not PutObject will not be discovered by `--dry-run`. Either state the
required operator principal in section 10, or have `--dry-run` probe the copy
permission on one object.

Note the CopyObject permission itself is correct: same-key copy needs
`s3:GetObject` on the source and `s3:PutObject` on the destination, and both are
in the statement above.

---

## 11. [MEDIUM] The ops sequence has an unstated ordering constraint: the backfill must not run before the dashboard change is live.

**What is wrong.** Section 10 gives an ordered ops procedure (dev dry-run, dev
apply, verify, prod dry-run, prod apply) and never says the dashboard fix from
6.4 must already be deployed.

**Evidence.** The image-vs-file decision is made client-side from the ROW's
type: `Timeline.tsx:640` and `MediaGallery.tsx:36`. The backfill rewrites those
rows (6.6 step 4). Section 6.4's own argument is that the old predicate emits an
`<img>` for `image/heic`.

**What it implies.** Run the backfill against an environment still serving the
previous dashboard bundle and every repaired HEIC photo becomes a broken image
tile - which is exactly what section 6.4 calls "a REGRESSION introduced by this
change". The window is real in dev, where the script is run by hand. Make the
prerequisite explicit in the RUNBOOK entry.

---

## 12. [MEDIUM] Section 8 READER 5 misdescribes the outbound send-path gate.

**What is wrong.** "READERS 5. `routes/api.ts` outbound send-path Head re-check
+ `routes/mmsMedia.ts:78` upload gate - both gate on `isInlineMediaType`".

**Evidence.** The send-path re-check gates on a DIFFERENT, narrower set:
`routes/api.ts:527-531` -
```
const contentType = (meta.contentType ?? '').trim().toLowerCase();
// Deliverable-type guard: only jpeg/png/gif may reach Twilio (12300 fix).
if (!isTwilioDeliverableType(contentType)) {
```
Repo-wide, `isInlineMediaType` has exactly two call sites: `api.ts:2292` (the
media SERVE route being changed here) and `mmsMedia.ts:78`.

**What it implies.** The 5.1 trap is real and correctly reasoned, but its caller
inventory is wrong in the one place a reviewer is told to look to confirm the
outbound path is untouched. A builder trusting 8.5 will look for a gate that
isn't there, and - more importantly - will not notice that the serve route
itself is the other `isInlineMediaType` caller, i.e. that the function being
deliberately left alone is called by the very route being rewritten.

---

## 13. [MEDIUM] Section 6.8's harness change points at one file; the canned assets live in three others, none named.

**What is wrong.** Section 6.8 says: `fake-twilio/src/engine/signer.ts:27` maps
only png/gif/webp/jpg/pdf; "Add one small canned non-image asset (a few-KB
`.mp4`) plus its suffix branch". The suffix branch is indeed at
`signer.ts:33-37`. The ASSET is not in `fake-twilio/src` at all.

**Evidence.**

- Assets: `fake-twilio/web/public/canned/` (`room.png`, `kitchen.png`,
  `lease-doc.pdf`).
- Registry: `fake-twilio/web/src/assets/canned/index.ts:33-37` `cannedAssets`,
  plus `isImageAsset` at `:46-48` (regex on png/jpe?g/gif/webp - an `.mp4`
  correctly falls through, but the file must be read to know that).
- Test that pins the registry shape: `fake-twilio/web/src/assets/canned/index.test.ts:20`
  asserts `u.pathname === /canned/${asset.id}.${EXT[asset.id]}`, so a new asset
  needs an `EXT` entry or the test fails.
- The header comment at `index.ts:1-9` states the standing rationale for
  PNG/PDF-only ("the dashboard's media pipeline only renders allowlisted raster
  images + PDF inline"). Adding an `.mp4` contradicts it and must update it.
- `/canned/*` is only served when `uiDistDir` is configured
  (`fake-twilio/src/server.ts:229-231`), which is worth stating since the e2e in
  section 9 depends on it.

**What it implies.** A builder following 6.8 literally edits the signer, finds
no asset directory under `src/`, and improvises. Low blast radius, but it is a
concrete under-specification in the one section that carries the acceptance
evidence for the whole feature.

---

## 14. [LOW] Section 6.4's "positional fallback gains the file kind" is ambiguous about the image `alt`, and silently changes two assertions section 9 does not list.

**Evidence.** `attachmentLabel(filename, isPdf, i)` (`Timeline.tsx:614-617`) is
called TWICE: once for the file-link text (`:667`) and once as the inline
image's `alt` (`:652`, with `isPdf` hard-coded `false`). Section 6.4 changes its
fallback but does not say whether an image gets a kind prefix, and the third
parameter is a boolean that a "file kind" cannot fit. Two existing assertions
read that accessible name: `dashboard/src/routes/contact/Timeline.test.tsx:552`
(`getByRole('img', { name: /Attachment 1/i })`) and
`e2e/tests/dashboard-next/outbound-mms.spec.ts:130`
(`getByRole('img', { name: 'Attachment 1' })`). Section 9's otherwise-careful
"existing tests that MUST be updated" list names neither.

**What it implies.** Minor, but section 9's list is presented as complete so a
reviewer does not misread a changed expectation as a broken guard. It is not
complete.

---

## 15. [LOW] The declarable tier is an exact-string set lookup, so any Content-Type carrying parameters silently falls to opaque.

**Evidence.** `lib/mediaTypes.ts:38` - `INLINE_MEDIA_TYPES.has(type.trim().toLowerCase())`.
`normalizeStoredMediaType` (`:56-58`) inherits that exact-match behavior, and
section 5.1 keeps it ("keep the type (trimmed, lowercased) when it is inline OR
declarable").

**What it implies.** `text/plain; charset=utf-8`, `text/vcard; charset=utf-8`
and similarly parameterized values collapse to octet-stream and get `.bin`,
which for the `text/*` half of the declarable list is the likeliest real-world
shape. Whether Twilio's `MediaContentType{i}` and mailparser's `a.contentType`
ever carry parameters is UNVERIFIED here (mailparser is documented to expose the
bare type), but the spec should state the normalization rule - strip parameters
before the lookup, or accept the narrowing on purpose - rather than leave it to
be discovered in production. Cheap to decide now; invisible if it goes wrong
(the symptom is the original bug, unchanged).
