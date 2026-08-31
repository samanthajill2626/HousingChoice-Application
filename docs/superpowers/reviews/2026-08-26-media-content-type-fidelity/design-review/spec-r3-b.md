# Adversarial design review R3-B

Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
@ `0153f271`. All 16 R2 findings accepted, so nothing to contest; this pass is
the new prose only, plus the two direct questions in the charge.

---

# Direct answers first

## Q3: is 8.6 complete? YES - and it should say so, and on what basis.

I enumerated every writer of `media_attachments` / `mediaAttachments` and traced
what each can put in an S3 object reachable through
`GET /messages/:providerSid/media/:idx` (which resolves
`mediaAttachmentsOf(message)[idx].s3Key`, `routes/api.ts:2266-2267`):

| Writer | Type source | Possible values | Tier move on 6.2? |
|---|---|---|---|
| `routes/webhooks/twilio.ts:499` + `jobs/mediaMirror.ts:160` | `normalizeStoredMediaType` | today: inline set or octet-stream | **No** - inline stays inline, octet-stream stays opaque |
| `services/inboundEmail.ts:730` | `normalizeStoredMediaType` | same | **No** |
| `services/sendEmailMessage.ts:410` | `isEmailAttachmentType` (`:324`) | 4 rasters + pdf + `text/plain` + `text/csv` + docx + xlsx | **YES** - the last four move opaque -> declarable |
| `services/sendMessage.ts:405`, `routes/api.ts:1705`, `routes/api.ts:1791` | `resolveAttachmentKeys` -> `isTwilioDeliverableType` (`api.ts:527-531`) | jpeg/png/gif only | **No** |
| `lib/seed/cast.ts:1210` | literal | `image/jpeg` | **No** |

`routes/contactTimeline.ts:418` is a read projection, not a writer.

Three populations I checked specifically because they were named in the charge
and are NOT on this route at all: **unit photos** are served by
`routes/unitMediaServe.ts` under `isImageMediaType`, a different route;
**call recordings** are reached only through `recording_s3_key`
(`lib/seed/cast.ts:1075`) and `routes/api.ts:2220`, never through
`media_attachments`; **MMS transcode output** is always `image/jpeg`
(`adapters/mediaTranscode.ts:28,80,109` - the return type is the literal
`'image/jpeg'`), and the pdf/webp ORIGINAL survives only as `originalKey`
(`routes/mmsMedia.ts:119,153`), which this route never reads.

I also checked the other half of the same question, which 8.6 does not ask: does
6.4's dashboard predicate swap (`startsWith('image/')` -> the four raster types)
move any existing row? No - the union of every writer above contains no
`image/*` value outside jpeg/png/gif/webp.

**So 8.6 is complete.** The finding is small and is item 10: it asserts
completeness without saying what was enumerated, so the next reader has to redo
this table. Two sentences naming the writer set would retire the question
permanently.

## Q4: are the round-2 fixes correct, or merely plausible?

Correct, with the exceptions below. Specifically verified this pass: the
s3Key-index invariant in 6.6 step 1 is now stated exactly right (it names the
row's compacted `mediaUrls` array, `routes/webhooks/twilio.ts:440-448`, rather
than Twilio's numbering); the per-message split in step 5 matches
`annotateMessage`'s whole-array signature (`repos/messagesRepo.ts:2503-2551`);
the `hcAws.mjs` precedent is cited correctly (`app/scripts/import-apply.ts:30-34`
does import `assertHousingChoiceAccount` / `hcCredentials`); and the
reversibility rewrite in 11 is accurate, including the detail that the prior
DynamoDB value was `application/octet-stream` by selection.

One verified negative worth recording because it would have been a nasty
surprise: `annotateMessage` emits **no** SSE or domain event
(`repos/messagesRepo.ts:2503-2551` is an `UpdateCommand`, a log line and the
pointer write). A prod backfill will not spray `message.persisted` at connected
dashboards.

The fix that is NOT correct is item 1 - the R2 label finding was inverted rather
than fixed.

---

# Findings

## 1. [HIGH] The label fix is inverted: section 9 now marks the two assertions that DO move as "unchanged", and 6.4 cannot produce the label they would move to.

**What is wrong.** 9: "`Timeline.email.test.tsx:88,107` cover filename-labelled
links, unchanged." Neither line covers a filename-labelled link. Both are the
positional fallback that 6.4's third label rule changes.

**Evidence.**

- `dashboard/src/routes/contact/Timeline.email.test.tsx:79-88`:
  ```
  media_attachments: [
    { s3Key: 'k0', contentType: 'application/pdf', filename: 'lease agreement.pdf' },
    { s3Key: 'k1', contentType: 'application/octet-stream' },
  ],
  ...
  // The named attachment shows its filename; the unnamed one keeps the fallback.
  expect(screen.getByText(/lease agreement\.pdf/)).toBeInTheDocument();   // :87
  expect(screen.getByText(/Attachment 2/)).toBeInTheDocument();           // :88
  ```
  `:88` asserts on the attachment with **no `filename`** and
  `contentType: 'application/octet-stream'`. The test's own comment at `:86`
  says so. The filename-labelled assertion is `:87`, which the spec does not
  list.
- `:104-107`: `media_attachments: [{ s3Key: 'k0', contentType: 'application/octet-stream' }]`
  then `expect(screen.getByText(/Attachment 1/))`. Again no filename, again the
  fallback.
- 6.4's label rules: image `alt` UNCHANGED, PDF file link UNCHANGED, "every
  other file link: the positional fallback gains the kind". Both of these are
  "every other file link".

**What it implies, and why this is worse than a wrong citation.** 6.4 gives no
kind word for these two cases. The type is `application/octet-stream` - the
OPAQUE tier, which by definition is the tier where we do not know the kind. The
example 6.4 gives is `"Video - Attachment 1"`, drawn from a declarable type. So
the builder reaches the only two existing assertions that must change, has no
rule for what to change them to, and is told by section 9 that they are
unchanged. Meanwhile section 9's dashboard block tests `image/heic` vs
`image/jpeg` rendering and the filename label, and contains **no test for the
kind prefix at all** - the one behavior 6.4 adds.

Three things have to be decided together: what the opaque tier's label is (leave
it a bare "Attachment N"? "File - Attachment N"?), that `:88` and `:107` move to
whatever that is, and that `:87` and `Timeline.test.tsx:552,555` do not. As
written, R2's finding was moved into the wrong column rather than closed.

---

## 2. [MEDIUM] 5.1's central guarantee is contradicted by 6.3 extension rule 2, deliberately, and neither section says so - and the resolver contract cannot express rule 2.

**What is wrong.** 5.1: "The serve route (6.2) and `normalizeStoredMediaType`
(5.2) both call it and nothing re-implements the decision, so the tier, the
response header and the extension can never disagree." 6.3 extension rule 2 then
makes the opaque tier's extension come from the stored filename rather than from
the resolver.

**Walk the input.** An opaque attachment named `budget.xlsx` (the exact
population 8.5 hands to rule 2) is served
`Content-Type: application/octet-stream` with
`Content-Disposition: attachment; filename="budget.xlsx"`. The tier and the
extension disagree, on purpose. That is the right call - I proposed it and the
adjudication adopted it - but 5.1 states the opposite as an invariant one
section earlier.

**Two mechanical consequences the contract does not cover.**

- `resolveMediaTier(raw) -> { tier, canonical, ext }` never says what `ext` is
  for `tier: 'opaque'`. If it is `'.bin'`, the serve route must override it for
  rule 2; if it is undefined, every caller must handle the absence. Unstated
  either way.
- Rule 2 needs a **reverse** lookup - "is this extension one we emit?" - and a
  type-to-extension map does not provide one. So a second exported artifact is
  required (an accepted-extension set), and 5.1's "nothing re-implements the
  decision" is the sentence that would otherwise stop a builder from adding it.

Say plainly: the resolver owns the tier, the header and the *default* extension;
the opaque tier alone may substitute a stored extension drawn from a closed
accepted set; that substitution is safe because it can never name a type outside
what we already emit, and it never changes the served Content-Type.

---

## 3. [MEDIUM] Rule 2's acceptance set is derived from the emission map, so it rejects the alternate spelling of the same format - producing exactly the `.bin` outcome the rule exists to prevent.

**What is wrong.** 6.3 rule 2: "if the stored filename ends in an extension that
is a VALUE IN OUR OWN EXTENSION MAP". The map is type -> extension, one value per
type. Real filenames use whichever spelling the sender's tool picked.

**Evidence.** The precedent the spec builds on picks one spelling per type:
`app/src/services/sendEmailMessage.ts:227` - `'image/jpeg': '.jpg'`. So under
rule 2, on an opaque attachment:

- `photo.jpg` -> `.jpg` kept.
- `photo.jpeg` -> not a map value -> `.bin`.
- `scan.tiff` -> `.bin` if the map holds `.tif` (and `scan.tif` -> `.bin` if it
  holds `.tiff`). One of the two always loses.
- `clip.mpeg` / `clip.mpga` against `audio/mpeg -> .mp3` -> `.bin`.

**What it implies.** The rule was added for one population - historical inbound
email attachments whose real filename is the only surviving evidence - and it
silently fails on that population whenever the sender used the longer spelling,
which for `.jpeg` and `.tiff` is common. The fix is one sentence: the accepted
set is enumerated separately from the emission map and includes every spelling
we are willing to honor, precisely because it is a different question from which
one we emit.

---

## 4. [MEDIUM] The extension ladder and the stem ladder must agree on where the extension boundary is, and now that there are two consumers, neither says.

**What is wrong.** Stem rule 1 removes "any existing extension". Extension rule 2
asks whether the name "ends in an extension that is a value in our map". Both
have to locate the same boundary in a multi-dot name and the spec defines it for
neither. In round 2 only the stem ladder needed this; rule 2 doubled the
requirement.

**Walk `data.tar.csv`, opaque tier.**

- Last-dot for both: stem `data.tar`, ext `.csv` -> `data.tar.csv`. Correct.
- First-dot stem, last-dot ext: stem `data`, ext `.csv` -> `data.csv`. Silently
  drops `.tar`.
- Longest-suffix ext (`.tar.csv`, not a map value -> `.bin`) with last-dot stem:
  -> `data.tar.bin`. Rule 2 misses a name it was meant to catch.

Three defensible readings of the same prose, three different downloads. Same for
`report.2026.xlsx` (`report.2026.xlsx` vs `report.xlsx`) and `archive.tar.gz`
(`.gz` is not a map value, so `archive.tar.bin` or `archive.bin`).

State it once: the boundary is the LAST `.` in the base name, both ladders use
it, and a leading `.` does not count (which is what already makes the dotfile
rule work).

---

## 5. [MEDIUM] "The stem never ends in one" is asserted as a premise and enforced by nothing; two other sanitization verbs are ambiguous in ways that matter.

**Evidence.** 6.3: "The final name is `<stem><ext>`, joined with exactly one `.`
which the extension carries (map values include the dot; the stem never ends in
one)." The sanitization list is: strip CR/LF/NUL; strip `"` and `\`; strip path
separators; reject `..`; collapse whitespace; cap at 100. **No step strips a
trailing dot.**

**Walk `report.` (trailing dot, no extension), opaque.** Stem rule 1 removes
"any existing extension" - there is none after the final dot - so a literal build
yields stem `report.`, and the final name is `report..bin`. That violates the
"exactly one `.`" the same sentence promises, and it does so through the exact
mechanism the sentence claims prevents it.

Two more, cheap to fix now and expensive to discover in review:

- **"reject `..`" is an ambiguous verb.** Refuse the whole filename (fall to the
  synthesized stem)? Or strip the sequence (`a..b` -> `a.b`)? A header-injection
  list usually means the former; a legitimate `my..notes.txt` then loses its
  name. Pick one.
- **"cap at 100 characters" does not say what it bounds.** Read as the STEM (its
  position in the list), a 200-character `<197>.xlsx` yields a 105-character
  name - fine. Read as the emitted NAME, a builder truncates into the extension
  and turns `.xlsx` into `.xls`, which silently defeats rule 3 and rule 2 at
  once. R1's draft said "cap at 100 characters preserving the extension"; that
  clause was clearer and got lost.

---

## 6. [MEDIUM] 7.1's transcode bullet names the wrong constraint - the third factual error found in this one enumeration across three rounds.

**What is wrong.** 7.1: "MMS transcode output (`routes/mmsMedia.ts:143`) - writes
the transcoder's own produced type, which `planMmsMedia` constrains to
deliverable renditions."

**Evidence.** `planMmsMedia` (`app/src/lib/mediaTypes.ts:89-98`) takes a SOURCE
type and a size and returns a plan - `'deliver' | 'transcode-image' |
'transcode-pdf' | 'reject'`. It never sees or constrains an output type. What
constrains the output is `transcodeForMms`, whose result type is the literal
`'image/jpeg'` (`app/src/adapters/mediaTranscode.ts:28`, produced at `:80` and
`:109`).

**What it implies.** The claim is harmlessly wrong in outcome - the output really
is always `image/jpeg`, and more tightly than the spec says - but 7.1 is now the
document's entire security argument ("the invariant holds because every gate
holds"), and this is the third time a bullet in that list has been checked and
found inaccurate (R1 found the single-choke-point claim false, R2 found two
writers missing, R3 finds a wrong constraining function). The list deserves one
pass where each bullet's named gate is opened rather than recalled.

---

## 7. [LOW] The idempotency statement's "repaired" is undefined against the three writes, and the crash window between step 4 and step 5 is the case it gets wrong.

**Evidence.** 6.6 now splits the writes: step 4's `mediaStore.setContentType`
runs PER ATTACHMENT, step 5's `putMediaPointers` + `annotateMessage` run ONCE
PER MESSAGE. The idempotency paragraph says "a second run is a no-op for every
attachment it repaired."

An attachment whose S3 object was rewritten in step 4 but whose message never
reached step 5 has been repaired in one of three places. Its ROW entry still says
`application/octet-stream`, which is the per-attachment selection predicate
(6.6 SELECTION, second bullet), so the next run re-selects it, re-queries Twilio
(one vendor call) and re-issues an identical `CopyObject`. Correct, but not a
no-op - and it is a real window now that the two writes are deliberately far
apart.

Scope the sentence: a second run is a no-op for every attachment that reached
step 5; attachments interrupted between step 4 and step 5 are re-queried and
re-written idempotently.

---

## 8. [LOW] The mandated repo method logs once per message, against a report the spec scopes to counts only.

**Evidence.** 6.6 requires writing "through the existing repo methods".
`annotateMessage` emits an INFO line on every call carrying `conversationId` and
`tsMsgId` (`app/src/repos/messagesRepo.ts:2528-2537`, `'message annotated'`).
6.6's REPORTING paragraph says the script reports "counts and type histogram
only, never keys, bodies or numbers".

Not a PII problem - those two ids are logged routinely elsewhere and neither is
a phone number - but a prod run emits one CloudWatch line per repaired message
in addition to its own report, which is worth one clause in the ops section
rather than a surprise in the log bill. If it is unwanted, the script can pass a
quiet logger; if it is wanted (an audit trail of what was touched), say so,
because it is currently neither chosen nor acknowledged.

---

## 9. [LOW] The 8KB inbound-email filename cap can cut an extension, which silently degrades rule 2 for the population rule 2 exists to serve.

**Evidence.** `app/src/services/inboundEmail.ts:682-685` truncates each stored
attachment filename against a budget SUMMED across the message's attachments,
`INBOUND_EMAIL_MAX_ATTACHMENT_FILENAME_BYTES = 8 * 1024` (`:115`).
`truncateToBytes` (`:275-281`) is codepoint-safe - it backs off UTF-8
continuation bytes - but it is not extension-aware.

So on a message whose earlier attachment names exhaust the budget, a later
`budget.xlsx` can be stored as `budget.xls` or `budget.x`. Rule 2 then finds no
map-value extension and falls to `.bin` - the outcome rule 2 was added to
prevent - with `headers_truncated: true` on the row as the only trace.

8 KB is generous, so this needs many or absurd filenames; it is worth one
sentence in 6.3 acknowledging that the stored filename is already lossy, not a
change to the ingest cap.

---

## 10. [LOW] 8.6 asserts it is the only tier-moving population without saying what was enumerated to establish that.

**What is wrong.** 8.6 identifies outbound email attachments and says they "move
from the opaque tier to the declarable tier the moment 6.2 lands, with no
backfill and no other change". It is correct - I verified it against every writer
of `mediaAttachments` (table at the top of this report). But the claim is
load-bearing (it is the spec's answer to "what else changes without a backfill?")
and it is unfalsifiable as written, so the next reader has to redo the
enumeration.

Two sentences retire it: name the writer set that was walked
(`webhooks/twilio.ts:499`, `jobs/mediaMirror.ts:160`, `inboundEmail.ts:730`,
`sendEmailMessage.ts:410`, `sendMessage.ts:405`, `api.ts:1705`, `api.ts:1791`,
`seed/cast.ts:1210`), and record the two reasons the others cannot move - the
three `resolveAttachmentKeys` writers are bounded by `isTwilioDeliverableType`
to jpeg/png/gif, and unit photos, call recordings and MMS transcode originals
are not reachable through `media_attachments` at all.
