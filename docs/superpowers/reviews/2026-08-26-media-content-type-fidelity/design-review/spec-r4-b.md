# Adversarial design review R4-B (cap round)

Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
@ `f1f201fe`. All 10 R3 findings accepted. This pass is calibrated to the cap
brief: what would break a build, not what could be phrased better.

Four findings. One would let a competent builder proceed confidently to the
wrong thing; one is a real hole a builder must guess at; two are precision on
enumerations. Verdict at the end.

---

# Charge 1: walking 6.3 again, and what the H1 fix cost

## 6.3 composes correctly. I walked every case, including the five you named.

The split rule ("the extension is the LAST dot and everything after it; a
leading-only dot means all extension and an empty stem"), the trailing-dot
sanitization step, and the stem-bounded cap now interlock. Traced end to end,
with the tier that reaches each:

| Stored name | Tier | Split | Stem after sanitize | Ext rule | Emitted |
|---|---|---|---|---|---|
| `budget.xlsx` | opaque | `budget` + `.xlsx` | `budget` | 2 (accepted) | `budget.xlsx` |
| `data.tar.csv` | opaque | `data.tar` + `.csv` | `data.tar` | 2 | `data.tar.csv` |
| `.env` | opaque | all ext, empty stem | absent -> rule 3 | 3 (`.env` not accepted) | `attachment-1.bin` |
| `report.` | opaque | `report` + `.` | `report` | 3 | `report.bin` |
| `report..csv` | opaque | `report.` + `.csv` | `report` (step 4 fires) | 2 | `report.csv` |
| 120 chars + `.xlsx` | opaque | 120-char stem | 100 chars (step 5) | 2 | 105-char name |
| `photo.jpeg` | opaque | `photo` + `.jpeg` | `photo` | 2 (ACCEPTED superset) | `photo.jpeg` |
| `invoice.exe` | opaque | `invoice` + `.exe` | `invoice` | 3 | `invoice.bin` |
| `invoice.exe` | declarable `video/mp4` | `invoice` + `.exe` | `invoice` | 1 | `invoice.mp4` |
| `attachment-0` | opaque | all stem, no ext | rule 2 -> absent -> rule 3 | 3 | `attachment-1.bin` |
| `lease agreement.pdf` | inline | `lease agreement` + `.pdf` | `lease agreement` | 1 | `lease agreement.pdf` |
| `""` / `"   "` | any | all stem | empty -> rule 3 | per tier | `attachment-1.<ext>` |
| `.csv` (leading-dot, accepted) | opaque | all ext, empty stem | rule 3 | 2 | `attachment-1.csv` |

Step 4 (remove trailing dots) is not redundant, which the spec's own note gets
slightly wrong: under the stated split, `report.` already yields a clean stem.
Step 4 earns its place on `report..csv`, where the split hands back the stem
`report.`. That is the case that would otherwise produce a double dot. Worth
correcting the note's example, not worth a finding.

Composition is sound. The one gap 6.3 still has is finding 2 below, and it is
not in the ladders - it is in the header-emission clause underneath them.

## The H1 fix is correct, and it did not break what H1 was protecting.

I re-verified both assertions H1 turned on:
`dashboard/src/routes/contact/Timeline.email.test.tsx:79-88` and `:104-107` are
both `contentType: 'application/octet-stream'` with **no** `filename`. Under
6.4's new fourth rule ("OPAQUE-tier file link: UNCHANGED, bare 'Attachment N'")
they correctly do not move, `:87` is correctly identified as the
filename-labelled case, and §9's dashboard block now tests both halves of the
fallback - which no earlier draft did.

What the fix cost is finding 1.

---

# Findings

## 1. [HIGH] 6.4's tier-based label rules need data the dashboard cannot reach, and the obvious client-side substitute breaks the two assertions §9 just declared stable.

**What is wrong.** 6.4 now asks the dashboard to distinguish DECLARABLE from
OPAQUE and to print a family word for the former. It then tells the builder to
mirror only the four raster types, and places the kind mapping server-side.

**Evidence.**

- 6.4, mirroring instruction: "The dashboard cannot import from `app/`, so **the
  four raster types** are mirrored in `dashboard/src/routes/contact/media.ts`."
  That is the whole of what the spec says to mirror.
- 6.4, third label rule: "The kind word comes from the canonical type's family
  (Video / Audio / Image / Document / Contact card) - a closed mapping **beside
  the type sets**." The type sets are `INLINE_MEDIA_TYPES` /
  `DECLARABLE_MEDIA_TYPES` in `app/src/lib/mediaTypes.ts` - the file the same
  section says the dashboard cannot import.
- The components that must implement it are client-side and see only the row's
  string: `dashboard/src/routes/contact/Timeline.tsx:640,658,667` and
  `MediaGallery.tsx:36,56`.

**Why a competent builder proceeds confidently to the wrong thing.** With no
mirrored declarable set and no mirrored family map, the natural client-side
derivation is a media-type PREFIX test - `startsWith('video/')` -> "Video",
`startsWith('audio/')` -> "Audio", `startsWith('application/')` -> "Document".
That collides in exactly the two places 6.4 cares about:

- `application/octet-stream` shares the `application/` prefix with the two OOXML
  document types (`app/src/lib/mediaTypes.ts:124-126`). A prefix rule therefore
  labels the OPAQUE case "Document - Attachment 2" - directly violating 6.4's
  fourth rule and failing `Timeline.email.test.tsx:88` and `:107`, the two
  assertions §9 lists specifically "to stop a builder 'fixing' one".
- `text/vcard` -> "Contact card" and `text/plain` / `text/csv` -> "Document"
  share the `text/` prefix, so the family word for those three cannot be derived
  at all.

**What it needs - one sentence, not a redesign.** Say what the dashboard mirrors:
the four raster types (already stated), plus the declarable-type-to-family map,
plus the fact that "opaque" client-side is the single literal
`contentType === 'application/octet-stream'`. Note that the legacy fold
(`repos/messagesRepo.ts:1005-1006`) and the two optimistic-row builders
(`useContactTimeline.ts:306`, `useRelayThread.ts:253`) all produce exactly that
literal, so the opaque test is a one-liner and only the family map is genuinely
new mirrored data.

This is the only item in the spec I believe a builder cannot resolve correctly
from the text alone.

---

## 2. [MEDIUM] The ASCII `filename="..."` is undefined when the stem is entirely non-ASCII, and there is no precedent in the repo to copy.

**What is wrong.** 6.3's emission clause: "Emit an ASCII-only `filename="..."`,
and when the original stem contained non-ASCII ALSO emit
`filename*=UTF-8''<percent-encoded>` per RFC 5987." It never says how the
ASCII-only form is DERIVED from a non-ASCII stem.

**Evidence.**

- The stem sanitization list (6.3 steps 1-5) removes control characters, quotes,
  backslashes, path separators, `..`, whitespace runs, trailing dots and excess
  length. **No step removes or transliterates non-ASCII**, so the sanitized stem
  can be entirely non-ASCII.
- Inbound email supplies exactly such stems verbatim:
  `app/src/services/inboundEmail.ts:683-686` stores the MIME part's filename
  after a byte-truncation only, and `truncateToBytes` (`:275-281`) is explicitly
  UTF-8 aware, i.e. multi-byte names are expected.
- There is no existing implementation to copy: grep for `filename\*`,
  `UTF-8''`, `encodeRFC`, `rfc5987` across `app/src` and `dashboard/src`
  returns **no matches**. The one prior art the spec cites,
  `services/sendEmailMessage.ts:339`, builds a MIME part name, not a
  `Content-Disposition` header, and does no RFC 5987 encoding.

**What it implies.** A CJK- or Cyrillic-named attachment - routine on inbound
email, and the population 6.3's stem ladder exists to serve - reduces to an
empty ASCII stem. A builder then emits `filename=".xlsx"` or `filename=""`,
both degenerate, and one of them is a header some clients treat as absent.
Nothing in the spec or the codebase steers them.

One clause closes it: if the ASCII reduction of the stem is empty, the ASCII
`filename=` uses the SYNTHESIZED stem (`attachment-<idx+1>`) while `filename*`
carries the real name. §9 already tests "a non-ASCII stem produces `filename*`";
it should also pin what the ASCII half says in that case.

---

## 3. [MEDIUM] A fourth defect in 7.1: a ninth writer of an S3 object Content-Type is missing - the unit-photo transcode rendition.

You asked for this one now rather than from a builder. It is there.

**Evidence.** 7.1's unit bullet reads "presigned-POST unit photos
(`routes/units.ts:516,686`, `isImageMediaType`)". Those two lines are the
presign gate and the confirm re-check. Neither is a write. The write is a third
site the bullet does not reach:

- `app/src/routes/units.ts:765-766`:
  ```
  const renditionKey = `${ownPrefix}${randomUUID()}`;
  await mediaStore.put(renditionKey, bufferToStream(result.bytes), result.contentType);
  ```
  `transcodeForUnitPhoto` (`app/src/adapters/mediaTranscode.ts:130`) returns
  `TranscodeResult`, whose `contentType` is the string literal `'image/jpeg'`
  (`:28`). So it is constrained by TYPE, exactly like the MMS transcode bullet
  the spec just rewrote - and it is the ninth writer, not one of the eight.

**Verified complete this round.** I re-derived the whole list from the code
rather than from the spec: every `mediaStore.put(` and `createPresignedPost(`
call site in `app/src` is `seed/media.ts:128`, `emailMedia.ts:82`,
`mmsMedia.ts:83`, `mmsMedia.ts:143`, `units.ts:543`, **`units.ts:766`**,
`webhooks/voice.ts:1995`, `inboundEmail.ts:679`, `mediaMirror.ts:110`. With
`units.ts:766` added, 7.1 is exhaustive.

Two adjacent checks that came back CLEAN, recorded so they are not re-derived:

- `routes/emailMedia.ts:65` **does** gate the PRESIGN on `isEmailAttachmentType`
  before `createPresignedPost(key, { contentType })` at `:82`. The email bullet
  is correct, and the bucket-wide invariant in 7's headline is not undermined by
  an ungated presign.
- `routes/unmatchedEmail.ts:204` passes `mediaStore` into `ingestInboundEmail`,
  so the admin re-ingest path writes through `inboundEmail.ts:679` and is
  already covered by bullet 1. Not a separate writer.
- `lib/import/apply.ts:409,436` is a DynamoDB `messageBatch.put`, writes
  `type: 'sms'` / `'call'` and **no** `media_attachments` - so the historical
  import contributes nothing to 8.6's table.

---

## 4. [LOW] Section 8 reader 4 names one of three presign-to-Twilio call sites.

`jobs/relayFanOut.ts:494-509` is listed as the place where "Twilio reads the S3
object's Content-Type". Two more call sites have the identical shape:

- `app/src/jobs/retrySend.ts:158-164` - `mediaAttachmentsOf(original)` then
  `store.presign(a.s3Key, ...)`.
- `app/src/routes/api.ts:1589-1594` - the same pair on the inline retry path.

Neither can change behavior: both source an OUTBOUND message, whose attachments
are bounded to jpeg/png/gif by `resolveAttachmentKeys`
(`app/src/routes/api.ts:527-531`), which is why only relayFanOut - whose source
is a member's INBOUND mirrored MMS - is a watch item. That reasoning is correct
but a reviewer auditing "who hands our objects to Twilio" has to reconstruct it.
Naming them as checked-and-excluded costs one line and retires the question.

---

## 5. [LOW] Two statements in 6.3 are now wrong rather than imprecise.

- The section's headline is "THE EXTENSION IS ALWAYS DRAWN FROM OUR OWN MAP."
  After the R3 fix that is false: rule 2 draws from the ACCEPTED SET, and the
  very next paragraph says building that set from the map is "a defect, not a
  shortcut". The headline should say "from our own closed sets" - as written it
  contradicts the paragraph it introduces, and it is the sentence a skimming
  builder keeps.
- The ACCEPTED set is exemplified but not enumerated: "`.jpeg`, `.tif`,
  `.heif`, `.3gp`, `.mpeg`, `.vcf` **and so on**". This is the set that decides
  what extension we hand the operator's OS, so "and so on" is the wrong closing
  for it. The safety property is stated ("contains no active extension, ever")
  and §9 pins both ends (`.jpeg` accepted, `.exe` refused), so a builder writes
  a defensible set and a reviewer can check it - which is why this is LOW and
  not a blocker. Note also that several of the listed "variants" (`.vcf` for
  `text/vcard`, `.3gp` for `video/3gpp`, `.heif` for `image/heif`) are almost
  certainly the EMISSION values, not variants of them; the set is a superset
  either way, so this is cosmetic.

---

# Charge 4: anything I believe is WRONG rather than underspecified

Findings 1, 3 and 5 are wrong-as-written. Beyond them I found nothing false. I
specifically re-checked the claims that have moved most between rounds and they
now hold: the s3Key-index invariant (`routes/webhooks/twilio.ts:440-448` does
skip empty entries, so the spec's "position in the ROW'S STORED `mediaUrls`
array" is exact); the per-message step 5 against `annotateMessage`'s whole-array
signature (`repos/messagesRepo.ts:2503-2551`); the three-bullet idempotency
statement against the row-granular predicate; the logging paragraph against the
INFO line at `:2528-2537`; 8.5's truncation limit against
`inboundEmail.ts:115,682-685`; and 8.6's enumeration table, which matches the
writer set I derived independently in R3.

---

# Verdict

**The spec is buildable once finding 1 is answered.** That is one sentence in
6.4 naming what the dashboard mirrors - the declarable-to-family map, and that
"opaque" client-side is the literal `application/octet-stream`. Without it a
builder has no correct source for the kind word and the available shortcut
silently breaks two assertions the spec just told them are stable.

Findings 2 and 3 should land in the same edit - each is a clause - but neither
would stop a build: finding 2 surfaces as a design question the builder will
raise when they write the header, and finding 3 is an enumeration a reviewer can
catch. Findings 4 and 5 are documentation hygiene and can ship as-is if the
edit window is closed.

Nothing here reopens a decision. All four are statements about what the spec
says, not about what it should do.
