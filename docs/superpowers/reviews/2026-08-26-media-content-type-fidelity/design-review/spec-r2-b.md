# Adversarial design review R2-B

Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
@ `2631e274`. Reviewed against `adjudications.md` and `spec-r1-a.md`.
Every claim about existing behavior cites a line I opened this pass.

**Closure check (brief, because it is the smallest part of the job).** All 15 of
my R1 findings are addressed in the revised text. Two are addressed with prose
that is itself defective - see 1 and 2 below - and one (R1-11, the deploy
ordering) is now the best-written paragraph in the document. I re-verified the
new citations that carry weight: `routes/units.ts:516,686` are indeed the two
`isImageMediaType` gates; `repos/messagesRepo.ts:2538-2550` is indeed the
swallowed pointer write; `lib/seed/cast.ts:1210` is indeed the only seeded
message attachment; `contactTimeline.ts:406,417` projects `media_attachments`
verbatim including `filename`, so 6.4's label story has the data it needs.

The findings below are what the revision introduced or still misses.

---

## 1. [HIGH] The revision states an essence-matching rule and, two paragraphs later, forbids the change that would implement it. No tier resolver is named.

**What is wrong.** 5.1 makes essence matching the rule for tier selection: "match
on the ESSENCE ... Then SERVE THE CANONICAL SET MEMBER ... which also guarantees
the tier decision, the response header and the extension lookup can never
disagree with each other." 5.2 then says `isInlineMediaType` "is NOT touched",
and 7.2 says "The inline branch still gates on `INLINE_MEDIA_TYPES`,
**unchanged**." Those cannot both be executed.

**Evidence.**

- `app/src/lib/mediaTypes.ts:37-39` - `isInlineMediaType` is an EXACT set
  membership test after trim/lowercase:
  `INLINE_MEDIA_TYPES.has(type.trim().toLowerCase())`. It has no essence step.
- `app/src/routes/api.ts:2292` - the serve route's inline decision is
  `const inline = isInlineMediaType(stored);`. It is the ONLY inline predicate
  the route has.
- `app/src/lib/mediaTypes.ts:56-58` - `normalizeStoredMediaType` is DEFINED in
  terms of that same helper: `return isInlineMediaType(raw) ? raw!.trim().toLowerCase() : ...`.
  So 5.2's "keep the canonical member when the essence is inline OR declarable"
  cannot be built without `normalizeStoredMediaType` ceasing to call
  `isInlineMediaType` - a restructuring the spec never names while simultaneously
  telling the builder that helper is off limits.

**What it implies.** A builder who reads 7.2's "unchanged" literally writes
`isInlineMediaType(stored)` for tier 1 and an essence test for tier 2, producing
two different matching semantics on the same decision. A stored
`image/jpeg; charset=x` then fails the exact inline test, fails the declarable
test (`image/jpeg` is not in `DECLARABLE_MEDIA_TYPES` - it is in the inline set),
and lands in the OPAQUE tier as `.bin`. That is the precise failure 5.1 was
added to prevent, reachable by following 7.2. A builder who instead reads 5.1
as governing edits `isInlineMediaType` and trips 5.2's stated trap.

The spec has to name ONE function - a `resolveMediaTier(stored)` returning
`{ tier, canonicalType, ext }` - say that it is what the serve route calls, say
that `normalizeStoredMediaType` is rebuilt on the same primitive, and say that
`isInlineMediaType` survives untouched **solely** as the outbound upload gate at
`routes/mmsMedia.ts:78`. Right now three sections point three ways and none of
them names the artifact.

---

## 2. [MEDIUM] The s3Key's trailing segment is not "the provider media index". It is the index into the row's own compacted `mediaUrls` array - which is why step 2 works, and the spec says the opposite.

**What is wrong.** 6.6 step 1: "Derive the provider media index BY PARSING THE
S3 KEY ... The true index is carried in the key itself". Step 2: "Read
`mediaUrls[<that index>]`". The mechanism is correct. The stated invariant that
justifies it is false, and it is false in a direction that will mislead whoever
implements the validation.

**Evidence.**

- `app/src/routes/webhooks/twilio.ts:440-448`, `parseInboundMediaUrls`:
  ```
  const numMedia = Number(params['NumMedia'] ?? 0) || 0;
  const urls: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`];
    if (typeof url === 'string' && url.length > 0) urls.push(url);
  }
  ```
  An absent or empty `MediaUrl{i}` is **skipped, not held open**. The persisted
  `mediaUrls` array is therefore itself compacted, and its positions are not
  provider indices.
- `app/src/routes/webhooks/twilio.ts:486-490` builds mirror targets from that
  same compacted array - `mediaUrls.map((url, index) => ({ index, url, ... }))` -
  and `services/mediaMirror.ts:67-69,99` bakes that `index` into the key.

So key index `i` indexes the stored `mediaUrls[i]` exactly, and step 2 is sound.
It is sound because both sides are the SAME compacted array, not because the
segment is a provider index.

**What it implies.** Three concrete ways the wrong invariant bites. A builder who
believes the segment is a provider index may validate it against `NumMedia`
(wrong bound), may reconstruct a `MediaUrl{i}` param name from it, or may
"harden" step 2 by preferring a provider-index lookup over the array lookup -
each of which breaks a message with a gap. It also mis-names the test: 9's
"PROVEN with a compacted attachments array whose position 0 is provider index 1"
encodes the same error into the assertion's name. State it as: *the key's
trailing segment is the position in the message's persisted `mediaUrls` array,
which is what makes `mediaUrls[i]` the right lookup.*

Adjacent, and NOT this spec's to fix: `twilio.ts:489` reads
`params[\`MediaContentType${index}\`]` with the COMPACTED index against the
provider's sparse param names, so a gapped MMS already mis-pairs type to media.
Worth a one-line note only because it is the reason the naming matters.

---

## 3. [MEDIUM] Essence matching changes a property recorded as part of a RESOLVED security issue, and 5.1's safety argument addresses the wrong direction.

**Evidence.** `docs/issues/media-serve-stored-xss.md:30-32`, in the Resolution
section of a `status: resolved` security issue:

> "`isInlineMediaType` trims + lowercases before an exact set match, so
> `IMAGE/PNG`, surrounding space, and `…; charset=…` parameter forms cannot
> bypass it."

5.1 asserts "This does not weaken the inline gate. Essence matching is exactly
what makes `text/html; charset=utf-8` fail the inline test, the same as the
exact-match form does today."

That sentence is backwards. Essence matching is not what makes `text/html;
charset=utf-8` fail - exact matching already fails it, for a different reason
(no set member matches the whole string). What essence matching actually does is
ADMIT parameterized forms of ALLOWLISTED types to the branch:
`image/png; x=y` is opaque today and becomes inline after. The spec never states
that delta and therefore never argues it.

**What it implies.** The change is defensible - the canonical member is what
reaches the header, so the response is `image/png` and the allowlist's output
domain is unchanged - but the spec must make that argument, not the one it
makes. And a resolved security issue whose written resolution names the
exact-match property as a defense is being altered; per the repo's issue-registry
rules that issue needs updating in the same change. Neither is stated.

---

## 4. [MEDIUM] Section 9 names the one label assertion that 6.4 guarantees will NOT move, and misses the one whose fate 6.4 leaves undecided.

**What is wrong.** 9: "The two attachment-label assertions moved by 6.4's
file-link kind prefix: `dashboard/src/routes/contact/Timeline.test.tsx:552` and
`Timeline.email.test.tsx:88,107`."

**Evidence.**

- `Timeline.test.tsx:552` is the IMAGE alt:
  `const img = screen.getByRole('img', { name: /Attachment 1/i });` on an
  `image/jpeg` attachment (`:546`). 6.4 says explicitly: "The image `alt` text is
  NOT given a kind prefix." So this assertion does not move.
- `Timeline.test.tsx:555` IS a file-link fallback label:
  `const pdf = screen.getByRole('link', { name: /PDF attachment 2/i });` on an
  `application/pdf` attachment (`:547`). It is unnamed.
- `Timeline.email.test.tsx:88` (`getByText(/Attachment 2/)` on an octet-stream
  part) and `:107` (`getByText(/Attachment 1/)` on an octet-stream MMS) are both
  file-link fallbacks and ARE correctly identified.

**What it implies.** Beyond the wrong citation, 6.4 leaves a real question open:
a PDF's fallback is already `PDF attachment 2` (`Timeline.tsx:616`), i.e. it
already carries a kind word in a different grammar from the proposed
`Video - Attachment 1`. Does it become `PDF - Attachment 2`, or stay? The spec
does not say, and `:555` is the assertion that answers it. Section 9's whole
purpose is that "a reviewer does not read the change as a broken guard"; as
written it tells the reviewer a stable assertion will move and stays silent on
the unstable one.

---

## 5. [MEDIUM] The serving of OUTBOUND EMAIL attachments changes. It is unnamed, untested, and contradicted by section 8.

**What is wrong.** `text/plain`, `text/csv`, docx and xlsx are simultaneously in
`EMAIL_ATTACHMENT_TYPES` and in the new `DECLARABLE_MEDIA_TYPES`. Outbound email
attachments already sit in S3 and in `media_attachments` with those true types,
and they are read by the very route this change rewrites.

**Evidence.**

- `app/src/services/sendEmailMessage.ts:323-324` gates the type with
  `isEmailAttachmentType`, then `:341-346` persists
  `{ s3Key, contentType, ...(cleanName && { filename: cleanName }) }`, and
  `:410` puts them on the message as `mediaAttachments`.
- `app/src/routes/emailMedia.ts:102-108` pins the same type on the S3 object at
  confirm, so `object.contentType` is the real one.
- `app/src/routes/api.ts:2266` serves ANY message's `mediaAttachmentsOf(message)`
  - direction is never consulted - and `Timeline.tsx:1384` renders
  `AttachmentGallery` for the outbound email card.

So today a staff-sent `.csv` downloads as `application/octet-stream` +
`attachment-0`; after this change it downloads as `text/csv` +
`<stem>.csv`. Four types move opaque -> declarable on the OUTBOUND path.

**What it implies.** The change is desirable, but the spec says the opposite is
happening: 8 WRITERS 9 - "OUTBOUND attachments - unchanged; listed so a reviewer
can confirm they are untouched" - is true of the write and false of the read;
non-goal 2 ("No change to ... the outbound send path") reads as forbidding it;
6.6's "outbound attachments are gated at upload and are already correct" is the
justification for excluding them from the backfill and reinforces the framing;
and section 9 has no outbound serve case at all. This is the half of R1-A's
finding 6 that the adjudication dropped when it accepted only the enumeration
half as F9. Name it, decide it is wanted, and test one outbound `.csv`.

---

## 6. [MEDIUM] Section 7.1 was rewritten specifically to be exhaustive and still omits two writers into the same bucket - including the one the adjudication's own R1 rejection depends on.

**What is wrong.** 7.1: "There is no single choke point, and the round-1 draft
was wrong to claim one. Every writer of an S3 object Content-Type, with the
allowlist it enforces:" - followed by six bullets.

**Evidence of the omissions.**

- `app/src/routes/webhooks/voice.ts:1995` -
  `await mediaStore.put(key, stream, 'audio/mpeg');`. Call recordings, written
  into the same media bucket with a literal type and no allowlist.
- `app/src/routes/mmsMedia.ts:143` -
  `await mediaStore.put(deliverableKey, bufferToStream(result.bytes), result.contentType);`.
  The transcode derivative, whose type comes from `transcodeForMms`, not from the
  presign gate the bullet names.

**What it implies.** The recordings omission is pointed rather than pedantic:
the adjudication's R1 REJECTION rests on call recordings being a separate route
with a separate type source, so the writer whose separateness carries that
argument is absent from the list that claims to name every writer. Section 8's
WRITERS list has the same two gaps. Given that this list is now the document's
security argument ("The invariant holds because every gate holds"), an
enumeration that is provably incomplete twice is worth one more pass.

---

## 7. [MEDIUM] `--dry-run` is not read-only. It issues one Twilio API request per candidate attachment against production, and the spec presents it as the safe half of the ops sequence.

**Evidence.**

- 6.6 REPORTING requires "recovered by type" in the histogram, which can only be
  produced by step 3, `adapter.getMediaContentType(messageSid, mediaSid)`.
- 10 sequences it as "deploy -> `--dry-run` -> read the histogram -> apply", i.e.
  the dry run is the artifact the go/no-go decision reads.
- The model the spec names behaves oppositely:
  `app/scripts/backfill-media-pointers.ts:71` is `if (dryRun) continue;` - the
  dry run touches nothing outside the process.

**What it implies.** The operator is told to dry-run prod first and will
reasonably read that as free. It is a full-table scan issuing a serialized
vendor API call per candidate, on the live messaging account, with no pacing,
concurrency bound or rate-limit handling specified anywhere. Say so, and say
what the script does when Twilio throttles - a 429 handled as "skip + count"
would silently under-report the histogram the decision is based on. (Twilio's
specific per-account limits are UNVERIFIED here; the exposure does not depend on
the number.)

---

## 8. [MEDIUM] The spec points the builder at a template that establishes exactly the wrong posture, and the account guard it requires lives somewhere it does not name.

**What is wrong.** 6.6 says the script is "modeled on `backfill-media-pointers.ts`".
10 says "The account-ID guard the sibling ops scripts use is required".

**Evidence.**

- `app/scripts/backfill-media-pointers.ts:12-16` states its own posture:
  "Targets DYNAMODB_ENDPOINT (default DynamoDB Local) ... no local-only guard".
  Grep of `app/scripts/*.ts` for `GetCallerIdentity|STSClient|accountId|
  expectedAccount`: **no matches**. It has no AWS credentials story, no S3, no
  vendor API and no account guard.
- The guard exists at `scripts/lib/hcAws.mjs:10,40-43`
  (`assertHousingChoiceAccount`, `STSClient` + `GetCallerIdentityCommand`), and
  it IS already used from the app workspace - `app/scripts/import-apply.ts:34`
  and `app/scripts/rail-verify.ts:40` both
  `import { ... } from '../../scripts/lib/hcAws.mjs'`. Neither is named by the
  spec.

**What it implies.** The builder follows 6.6, copies the DynamoDB-Local-shaped
backfill, finds nothing to model the guard on, and either omits it or invents
one. The correct instruction is one line: model the SCAN on
`backfill-media-pointers.ts` and the CREDENTIAL/GUARD posture on
`app/scripts/import-apply.ts`. (No dependency problem: `@aws-sdk/client-sts` is
a root dependency and the cross-workspace import is the established pattern -
I checked `app/package.json` and `package.json:77` before raising this.)

---

## 9. [MEDIUM] "The operation is REVERSIBLE" is true of one of the three writes.

**What is wrong.** 11's new risk bullet: "the operation is REVERSIBLE - the
pre-backfill state remains addressable as a noncurrent version, which is worth
knowing for a change that mutates production objects."

**Evidence.** The backfill makes three writes (6.6 step 5). Only the S3 one is
versioned (`infra/modules/s3_media/main.tf:12-17`). The other two are
destructive overwrites: `putMediaPointers` is a loop of plain `PutCommand`s
(`repos/messagesRepo.ts:2553-2557`) and `annotateMessage` is an `UpdateCommand`
with `SET` (`repos/messagesRepo.ts:2520-2527`). Neither retains a prior value.
DynamoDB PITR is per-table configuration
(`infra/modules/dynamodb/main.tf:86-88`, `enabled = each.value.pitr` - whether
it is on for the messages table in each environment is UNVERIFIED) and would in
any case be a whole-table restore to a NEW table, not a per-attachment revert.
Even the S3 half has no bulk restore: reversing it means copying each noncurrent
version forward, object by object.

**What it implies.** This is a reassurance an operator acts on when deciding
whether to apply to production. As written it licenses "we can undo this", which
is false for two thirds of the write set and impractical for the third. State it
as: the S3 leg is recoverable object-by-object from noncurrent versions; the row
and pointer writes are not reversible, and a bad run is repaired by fixing the
script and re-running, not by rolling back.

---

## 10. [MEDIUM] The F20 remediation is incomplete: widening `MessagingAdapter` breaks four exhaustive literals, not one.

**What is wrong.** 6.7: "Widening either interface breaks the full object
literals in the test helpers that implement them -
`app/test/helpers/twilioWebhookHarness.ts` implements `MediaStore` exhaustively.
Named here so the builder treats it as a task rather than discovering it as a
type error." It names the `MediaStore` literal and one file.

**Evidence.** Four full `MessagingAdapter` literals exist, and a required
`getMediaContentType` breaks all of them:

- `app/test/helpers/twilioWebhookHarness.ts:3344` (`const adapter: MessagingAdapter = {`,
  running through `listViSentences` at `:3420-3423`)
- `app/test/scheduledSendSuppression.test.ts:333`
- `app/test/sendMessage.test.ts:286`
- `app/test/tourReminders.test.ts:1453`

plus the `MediaStore` literal at `twilioWebhookHarness.ts:3425` that the spec
does name.

**What it implies.** The paragraph exists precisely so this is a task and not a
surprise, and it under-counts by three files. Cheap to fix, and cheap to get
wrong - a builder who fixes the one named file hits three more type errors in
suites unrelated to media.

---

## 11. [MEDIUM] 6.3 and 8.5 intersect on the largest population of stored filenames, and the spec does not notice: every historical inbound-email attachment downloads as `<realname>.bin`.

**What is wrong.** 6.3 makes the extension always ours, from the resolved tier.
8.5 says existing inbound-email attachment types are "UNRECOVERABLE by any
means" and "keep `.bin` permanently". Both are individually right. Together they
mean a real, named, benign file is renamed to a dead extension.

**Evidence.**

- `app/src/services/inboundEmail.ts:683-686` persists the MIME part's filename
  (`budget.xlsx`) alongside the collapsed `application/octet-stream`.
- `dashboard/src/routes/contact/Timeline.tsx:614-617` shows that stored filename
  in the thread, and 6.4 leaves that unchanged - so the operator sees
  `budget.xlsx` and downloads `budget.bin`.
- Today the same click yields `attachment-0` (`routes/api.ts:2295`).

**What it implies.** Neither name opens, so this is not a regression in
function - but it is a decision the spec makes silently, on the one population
where a trustworthy filename already exists and the type does not. The
middle rule the spec never considers: honor a stored extension when it is a
VALUE in our own type-to-extension map, which keeps the extension ours by
membership and closes the `invoice.exe` vector just as completely (`.exe` is not
in the map). I am not asking for it - I am asking that 6.3 state that it
considered and rejected it, because "the extension is ALWAYS ours" currently
reads as though no case was lost.

---

## 12. [LOW] The per-attachment / per-message batching boundary is unspecified, and step 5 sits on the wrong side of it.

**Evidence.** 6.6 heads the numbered list "PER ATTACHMENT:" and step 5 is the
write order. But both DynamoDB writes take the whole array:
`putMediaPointers(conversationId, tsMsgId, attachments)` and `annotateMessage`'s
`mediaAttachments` (`repos/messagesRepo.ts:2544-2557`,
`mediaPointerItems(...)` at `:228-239`).

**What it implies.** A literal build issues N row updates and N pointer loops for
an N-attachment message. Correctness survives - the per-attachment predicate is
applied in code, so a re-run skips already-repaired attachments - but the spec
should say the S3 step is per attachment and the two DynamoDB steps are once per
message, after the loop.

---

## 13. [LOW] "Idempotent second run is a no-op" is false for any row carrying a permanently-unrepairable attachment.

**Evidence.** 9's backfill test list asserts "idempotent second run is a no-op".
6.6 defines the re-scan predicate as "the message row still saying
octet-stream", which is ROW-granular, while the repair is attachment-granular. A
message with one repaired attachment and one Twilio-404 attachment still matches
the row predicate forever, so every subsequent run re-selects it and re-issues
the Twilio metadata fetch for the dead one.

**What it implies.** Writes are correctly skipped, so this is not a correctness
bug - but the test as named will be written against a case that does not hold,
and combined with finding 7 it means every re-run costs vendor API calls
proportional to the unrepairable population. Scope the claim to "writes nothing
on a second run".

---

## 14. [LOW] 6.3's stem rules leave three cases undefined.

**Evidence / cases.** "reduced to its BASE NAME with any existing extension
DISCARDED" does not say which dot: `report.2026.xlsx` -> `report.2026` or
`report`? `archive.tar.gz` -> `archive.tar` or `archive`? A name that is only an
extension (`.htaccess`) -> empty stem, which then falls to rule 2's "empty after
sanitizing" branch, but only if the reduction is defined to produce empty rather
than `.htaccess`. And the ordering of the `^attachment-\d+$` test against the
100-character cap is unstated (a 120-char name truncating INTO that shape is
contrived but the rule should be deterministic).

Also worth one line rather than a decision: with the extension now forced, a
bidi control (U+202E) surviving in the stem no longer changes what the OS does -
`.bin` is still `.bin` - but it can still misrepresent the name in the browser's
download UI, and 6.3's strip list (CR, LF, NUL, `"`, `\`, path separators) does
not cover format controls while the mandated `filename*=UTF-8''` form carries
them through.

---

## 15. [LOW] Section 2.2 no longer contains the root cause that 6.3 exists to fix.

**Evidence.** The R1 draft's 2.2 stated both halves: no extension, AND "The route
also ignores `attachments[idx].filename`, which is in scope on the line above
and IS populated for email attachments. So an inbound email attachment displays
in the timeline as `budget.xlsx` (`Timeline.tsx:614-617`) and downloads as
`attachment-0`." The revision (lines 50-64) deleted the second half. 6.3 still
implements a three-step stem ladder, and 9 still tests
"a stored `attachment-0` is treated as absent".

**What it implies.** A builder reading section 2 has no idea why the filename
resolution has a ladder at all, or why rule 2 exists. The defect was real and it
is still being fixed - it just no longer appears in the problem statement.

---

## 16. Contesting the adjudications

**R1 (peer's claim that the seeded `audio/mpeg` already exercises the declarable
tier): CONCEDED. The planner is right, and I can add the confirming line.**
`CAST_RECORDING_KEY` (`lib/seed/media.ts:25,122`) is
`media/cast/call-recordings/parked-landlord-call.mp3`, and it is attached to a
message nowhere - `lib/seed/cast.ts:1075` puts it on `recording_s3_key`, a CALL
field, while the only seeded `media_attachments` is `cast.ts:1210`,
`image/jpeg`. It is therefore unreachable from
`GET /messages/:sid/media/:idx`, which resolves its key from
`mediaAttachmentsOf(message)` (`routes/api.ts:2266-2267`) and can only ever
address a message attachment. The recording route is separate and does not
consult the tiers (`routes/api.ts:2220`). The rejection stands.

**R2 (consolidating `EMAIL_EXTENSIONS`): CONCEDED, and the spec's stated reason
is weaker than the real one.** The rejection is correct - non-goal 2 excludes
the outbound send path and `EMAIL_EXTENSIONS` is consumed only at
`sendEmailMessage.ts:339` to name an outbound MIME part. But non-goal 4's
justification ("merging them would put a regression risk into a channel nobody
has reported a problem with") is the weak form of the argument, because it
invites the obvious retort that a shared map with tests is not a regression
risk. The strong form is available and should replace it: **neither map feeds a
security decision, and they cannot diverge into anything worse than a cosmetic
mismatch.** The extension is chosen AFTER the tier is resolved from the type
allowlist, so a wrong or missing entry produces a badly-named download and can
never widen what is served or rendered. That is what makes the duplication
cheap, and it is the sentence the non-goal should carry.

One small correction while here: section 12's "The extension map is now a third
copy alongside `EMAIL_EXTENSIONS` and the dashboard's mirrored raster set"
conflates two different kinds of thing. The dashboard mirror
(`contact/media.ts`, per 6.4) is a TYPE SET, not an extension map. There are two
extension maps and one mirrored type set.
