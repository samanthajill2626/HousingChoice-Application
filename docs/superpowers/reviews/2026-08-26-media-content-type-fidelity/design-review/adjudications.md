# Design review adjudications - media content-type fidelity

Spec round 1. Two independent reviewers, briefs per `design-review-briefs.md`.
Reports: `spec-r1-a.md` (16 findings), `spec-r1-b.md` (15 findings).

Merged below because the overlap was heavy: both found the blocking backfill
index defect independently, and both found the `MediaGallery` reader, the
versioned bucket, the operator-credentials error, the
`isTwilioDeliverableType` misdescription, the seed writers, the parameterized
types and the email-row histogram pollution.

Every claim about existing behavior below was re-verified against the code by
the planner before adjudication.

## ACCEPTED

**F1 [BLOCKING] (A1, B1) Backfill derives the provider media index from the
`media_attachments` array position.** VERIFIED. `mirrorInboundMedia` persists
`outcome.attachments.map(a => a.attachment)` (`routes/webhooks/twilio.ts:496-497`)
- successes only, compacted - and `jobs/mediaMirror.ts:150-160` APPENDS later
rungs. So after any partial mirror, `media_attachments[0]` can be provider
index 1. The spec's step 1 (`mediaUrls[index]`) would then read the wrong
MediaSid and stamp the wrong Content-Type on the wrong object, with no way to
detect it after the fact. Both reviewers independently noted the true index is
already carried in the s3Key (`inboundMediaKey`, `services/mediaMirror.ts:67-69`
= `media/<conversationId>/<messageSid>/<index>`).
FIX: derive the provider index by parsing the s3Key, never from array position;
refuse any key that does not match the inbound pattern. Test with a
deliberately compacted attachments array.

**F2 [BLOCKING] (A2, B4) Preferring the stored `filename` hands an
attacker-chosen extension to the operator's OS.** VERIFIED as a risk the spec
itself creates. Today the route emits an extensionless `attachment-<idx>` for
every non-inline attachment, so the saved file is inert; the spec's rule 1
would emit the sender's own MIME `filename` verbatim, so an inbound email part
named `invoice.exe` downloads as `invoice.exe`. Section 6.3 guards only header
injection and section 7 never evaluates this at all.
FIX: the extension ALWAYS comes from our type map. The stored filename
contributes only a sanitized STEM (its extension is discarded), so
`invoice.exe` on an opaque attachment becomes `invoice.bin`.

**F3 [HIGH] (B5) `emailMime` synthesizes a non-empty extensionless filename,
which rule 1 would then prefer.** VERIFIED at `lib/emailMime.ts:100-106`: a
nameless MIME part is stored as `attachment-<i>`. That is non-empty, so the
spec's "prefer the stored filename when present and non-empty" selects it,
producing exactly the extensionless 0-based name this feature exists to
eliminate. Sharpest finding of the round; only one reviewer saw it.
FIX: folded into F2 - a stem matching `^attachment-\d+$` is treated as absent
and falls through to the synthesized 1-based name.

**F4 [HIGH] (A3, B2) Unenumerated reader: `MediaGallery.tsx:36`.** VERIFIED -
it carries the identical `m.contentType.startsWith('image/')` predicate that
section 6.4 calls a regression in `Timeline.tsx`, and the spec never changes
it. HEIC would ship as a broken `<img>` in the "Media from comms" grid. My
section 6.5 named the pointer DATA path and missed the component that renders
it.
FIX: 6.4 covers both components; both switch to the shared renderable set.

**F5 [HIGH] (A4) The S3-first write order does not protect the last write.**
VERIFIED at `repos/messagesRepo.ts:2538-2550`: `annotateMessage` writes the
message row and THEN writes pointers inside a try/catch that logs and swallows.
The spec's order (S3, row, pointers) clears the re-scan predicate - the row's
octet-stream - before the pointer write, so a swallowed pointer failure is
permanent divergence between the thread and the gallery.
FIX: the predicate-clearing write goes LAST. Order becomes S3 ->
`putMediaPointers` -> `annotateMessage`. Every step before the last is
idempotent, so any partial failure is repaired by re-running.

**F6 [HIGH] (B3) "Forwarding fails before and after - no regression" is
vendor-decided and unverified.** VERIFIED that `jobs/relayFanOut.ts` contains
zero content-type references, so the claim rests entirely on what Twilio does
with an object we never inspect.
FIX: state it as UNVERIFIED and vendor-decided, and name the observable that
may change (the error code on the failed leg).

**F7 [MEDIUM] (A8, B15, A15) Exact-set matching drops parameterized types.**
ACCEPTED. `text/plain; charset=utf-8` and `video/3gpp; codecs=...` are ordinary
wire forms and would fall to the opaque tier, silently defeating the feature
for several types it adds.
FIX: match on the media-type ESSENCE (everything before `;`, trimmed and
lowercased), and SERVE THE CANONICAL SET MEMBER rather than the raw stored
string, so tier, header and extension can never disagree. Security note: this
does not weaken the inline gate - essence matching is what makes
`text/html; charset=x` fail the inline test, exactly as the exact-match form
does today.

**F8 [MEDIUM] (A5, B12) Section 8 misdescribes the outbound send-path gate.**
VERIFIED at `routes/api.ts:527-531`: it is `isTwilioDeliverableType`, not
`isInlineMediaType`. My section 8 reader 5 was simply wrong.

**F9 [MEDIUM] (A6) Section 7 overstates the write-side gate.** ACCEPTED. There
are other writers of an S3 object Content-Type - the presigned-POST paths for
MMS uploads, email attachments and unit photos - which never touch
`normalizeStoredMediaType`. The invariant still holds (each has its own
allowlist) but section 7's "no path can write an active type except through
`normalizeStoredMediaType`" is false as written.
FIX: rewrite section 7 to enumerate every gate rather than claim a single one.

**F10 [MEDIUM, PARTIAL] (A7, B8) Seeds omitted from the writers list.**
ACCEPTED for the enumeration: `lib/seed/media.ts:121-128` calls `store.put`
with literal content types, bypassing `normalizeStoredMediaType` entirely.
See REJECTED below for the sub-claim attached to it.

**F11 [MEDIUM] (A10, B9) Versioned bucket, no noncurrent-version expiry.**
VERIFIED: `infra/modules/s3_media/main.tf:12-17` enables versioning and the
module contains no lifecycle rule at all. Every in-place `CopyObject` therefore
retains the wrongly-typed version indefinitely.
FIX: add to risks - with the note that this also makes the backfill REVERSIBLE,
which is worth stating for a change that mutates production objects.

**F12 [MEDIUM] (A9, B10) Ops permissions misstated.** ACCEPTED. "Already
granted, no new infra" cites the EC2 instance role, but section 10 runs the
script under the operator's own credentials. `CopyObject` also needs
`s3:GetObject`, which the spec never lists.
FIX: state the operator's required permissions explicitly and require the
account-ID guard the sibling ops scripts use.

**F13 [MEDIUM] (B11) Unstated ops ordering.** ACCEPTED, and it is the finding
most likely to bite in practice: running the backfill before the dashboard fix
is deployed produces exactly the broken-`<img>` HEIC regression section 6.4
exists to prevent, in production, in the window between the two.
FIX: the RUNBOOK sequence is deploy-then-backfill, stated as a hard ordering.

**F14 [MEDIUM] (A16, B6) Selection sweeps inbound-email rows it can never
repair.** ACCEPTED - they are inbound, carry `media_attachments`, and are
octet-stream, but have no Twilio media behind them, so they inflate the
dry-run histogram the ops decision reads.
FIX: require Twilio-recoverable evidence in the selection and count email rows
in their own bucket. Also state plainly that existing inbound EMAIL attachments
are NOT repairable by any means - the MIME source is gone - so they keep `.bin`
even though new ones are fixed by 6.1.

**F15 [MEDIUM] (B7) Section 8.5 contradicts section 6.6.** ACCEPTED: 8.5 says
legacy `media_s3_keys` rows are "skipped and counted", but 6.6's selection
requires `media_attachments`, so they are never seen.
FIX: count them during the scan; keep them out of the repair set.

**F16 [MEDIUM] (A16) The list-element predicate cannot be a DynamoDB
FilterExpression.** ACCEPTED - "some attachment has octet-stream" is not
expressible; the sibling backfill filters in code after a scan.

**F17 [LOW, PARTIAL] (A11) The extension map is a third copy.** ACCEPTED as an
observation. See REJECTED for the proposed consolidation.

**F18 [LOW] (A12) The D3 issue section 12 asks to file already exists.**
ACCEPTED - filed at `docs/issues/relay-forwards-undeliverable-media.md` as
`ce536a30` while the review was running. Section 12 updated to reference it.

**F19 [LOW] (A13, B13) Section 6.8 understates the fake-twilio work.**
ACCEPTED - the canned-asset registry, its pinning test and the static-file
serving path all live outside `signer.ts`.

**F20 [LOW] (A14) Widening `MediaStore` breaks a full literal in
`app/test/helpers/twilioWebhookHarness.ts`.** ACCEPTED - named as a task so the
builder does not discover it as a type error.

**F21 [LOW] (B14) The kind-prefix label change is ambiguous for the image
`alt`.** ACCEPTED - 6.4 now says the prefix applies to the FILE-LINK fallback
label only, and names the two assertions it moves.

## REJECTED

**R1 (A7, second clause) "The seeded `audio/mpeg` already exercises the new
declarable tier untested."** REJECTED on the code. The `audio/mpeg` object is
`CAST_RECORDING_KEY` (`lib/seed/media.ts:122`), a CALL RECORDING. Call
recordings are served by a different route that hardcodes `audio/mpeg`
(`routes/api.ts:2220`) and never consults these tiers. The only seeded MESSAGE
attachment is `cast.ts:1210`, `image/jpeg` - inline tier, unchanged by this
work. So no seeded fixture reaches the declarable tier, which is precisely why
F19's fake-twilio asset is still required. The enumeration half of the finding
stands (F10).

**R2 (A11, proposed fix) Consolidate `EMAIL_EXTENSIONS` into the new shared
map.** REJECTED as scope creep against the spec's own non-goals: section 4
excludes changes to the outbound send path, and `EMAIL_EXTENSIONS`
(`services/sendEmailMessage.ts:225-235`) is outbound-only. The duplication is
real and is now noted in the new map's comment with a pointer, but merging two
maps that serve different allowlists in the same change trades a contained fix
for a regression risk in a channel nobody reported a problem with.

## Planner-added (found while adjudicating, neither reviewer raised it)

**P1.** Section 7 should state WHY the read-side inline gate must keep running
on the S3 object's own type rather than the record's: objects mirrored BEFORE
the 2026-06-18 normalize fix can still carry active types such as `text/html`.
That is the exact population the original stored-XSS fix was written for, and
it is the reason the read-side allowlist cannot be relaxed to trust the record.

## Round 1 outcome

21 accepted (2 blocking), 2 rejected, 1 planner-added. Decisions changed:
the backfill's index derivation, the filename rule, the backfill write order,
the tier matching rule, the ops sequence, and the reader list. Round 2 required.

---

# Round 2 (continued reviewer B, re-review charge)

Report: `spec-r2-b.md`, 16 findings. Both round-1 rejections were CONCEDED by
the reviewer on the code (R1: `cast.ts:1075` puts the seeded recording on
`recording_s3_key`, unreachable from the media route; R2: conceded as scope,
with a better justification which I adopted). All claims re-verified.

## ACCEPTED

**G1 [HIGH] The essence rule and "isInlineMediaType NOT touched" could not both
be built.** The round-1 revision named a matching rule but no resolver, leaving
`image/jpeg; charset=x` failing the exact-match inline gate AND absent from the
declarable set - landing in `.bin`. FIX: name ONE `resolveMediaTier` returning
`{tier, canonical, ext}`; the serve route uses it and stops calling
`isInlineMediaType`, which keeps its exact semantics for its own callers.

**G2 [MEDIUM] The s3Key index is not "the provider media index".**
`parseInboundMediaUrls` (`twilio.ts:440-448`) skips absent/empty entries, so
the stored array is itself compacted relative to Twilio's `MediaUrl{i}`
numbering. The MECHANISM is right - both the key and the stored `mediaUrls`
derive from the same compacted list - but the stated invariant was wrong and
would have sent the tests after the wrong property.

**G3 [MEDIUM] The 5.1 safety argument addressed the wrong direction.** It never
said what actually changes: parameterized forms of ALLOWLISTED types are newly
ADMITTED. It also silently contradicts `media-serve-stored-xss.md:30-32`, which
records exact-string parameter behavior as part of a resolved fix. FIX: state
the real direction, ground the safety in the canonical output, and amend the
issue in this change.

**G4 [MEDIUM] Section 9 named the wrong test line and left a case undecided.**
VERIFIED: `Timeline.test.tsx:552` is the image `alt` (which 6.4 exempts) and
`:555` is the PDF file-link label, whose fate 6.4 never decided. FIX: 6.4 now
states all three label cases exhaustively; PDF keeps "PDF attachment N" and
section 9 lists both lines as MUST NOT CHANGE.

**G5 [MEDIUM] Outbound EMAIL attachments move opaque -> declarable, unnamed.**
VERIFIED: they are stored with `EMAIL_ATTACHMENT_TYPES` values by the
presign/confirm path and served by the SAME route, so they change tier the
moment 6.2 lands - while section 8 called outbound "untouched". FIX: new
section 8.6 names it as intended behavior, non-goal 4 is narrowed to the SEND
path, and section 9 adds a test. This is the half of round-1 finding A6 my
adjudication dropped.

**G6 [MEDIUM] The rewritten-to-be-exhaustive 7.1 was still not exhaustive.**
VERIFIED two more object-Content-Type writers: `routes/webhooks/voice.ts:1995`
(call recordings, hardcoded `audio/mpeg`) and `routes/mmsMedia.ts:143`
(transcode output). Notably the first is the very writer my R1 rejection turned
on, and I had left it out of my own list.

**G7 [MEDIUM] `--dry-run` is not read-only.** It makes one live Twilio read per
candidate attachment to build the histogram. FIX: say so, add bounded
concurrency and 429 backoff, and report the vendor-call count.

**G8 [MEDIUM] The named precedent has none of the things this script needs.**
VERIFIED: `backfill-media-pointers.ts` has no credentials, no S3 write, no
vendor API and no account guard. The guard is `assertHousingChoiceAccount` in
`scripts/lib/hcAws.mjs`, used by `app/scripts/import-apply.ts:30-34`. FIX: take
the scan shape from one and the credential posture from the other, explicitly.

**G9 [MEDIUM] "REVERSIBLE" covers one write of three.** S3 has versioning; the
pointer and row writes are destructive DynamoDB overwrites. FIX: risk reworded
to say exactly what is and is not recoverable.

**G10 [MEDIUM] Four `MessagingAdapter` literals break, not one.** Sizing fix.

**G11 [MEDIUM] 6.3 and 8.5 intersect badly.** Every historical inbound-email
attachment would download as `<realname>.bin` while the timeline shows
`budget.xlsx` - worse than the bug being fixed - and the middle option was
never considered. FIX ADOPTED: on the OPAQUE tier only, if the stored
filename's extension is a VALUE IN OUR OWN EXTENSION MAP, use it. That is a
lookup against a closed set, so `.xlsx` is recoverable and `.exe` remains
impossible; the security property of G2/F2 is unchanged.

**G12 [LOW] The per-attachment / per-message boundary was unspecified and step
5 sat on the wrong side.** `annotateMessage` takes the whole array, so a
per-attachment row write would clear the predicate before later attachments on
the same row were repaired. FIX: steps 1-4 per attachment, step 5 once per
message.

**G13 [LOW] "Idempotent second run is a no-op" is false for rows carrying a
permanently unrepairable attachment** - the predicate is row-granular. FIX:
stated exactly, with the re-query cost accepted deliberately.

**G14 [LOW] Stem rules left the dot, dotfiles and cap-vs-regex ordering
undefined.** FIX: the map values carry the dot, an all-extension name has an
empty stem and falls through, and the cap runs LAST so it cannot re-expose a
removed sequence.

**G15 [LOW] Section 2.2 lost the ignored-`filename` root cause** in the round-1
rewrite, orphaning 6.3's stem ladder. FIX: restored as 2.3.

**G16 Adjudication feedback accepted.** Non-goal 4's justification replaced with
the strong form: neither extension map feeds a security decision, so their
divergence is cosmetic.

## Round 2 outcome

16 accepted, 0 rejected, both prior rejections conceded by the reviewer.
Decisions changed: the resolver, the opaque-tier extension rule, the
per-message batching boundary, the dry-run vendor-read story, the credential
precedent, and the outbound-email scope statement. Round 3 required by the stop
rule (a round that changes decisions is never terminal).

---

# Round 3 (continued reviewer B)

Report: `spec-r3-b.md`, 10 findings. Charge was to stress the NEW round-2
prose, especially 6.3's two interacting ladders. It did, and most of what came
back is in exactly that section - which is the expected failure mode for prose
written to satisfy a critique.

## ACCEPTED (all 10)

**H1 [HIGH] The label rule was inverted, and the assertions I listed were the
wrong ones.** VERIFIED: `Timeline.email.test.tsx:88` and `:107` both assert on
attachments that are `application/octet-stream` with NO filename, so under
round 2's "every other file link gains the kind" they WOULD move - and 6.4
supplied no kind word for octet-stream, so a builder could write neither the
label nor the assertion. Section 9 meanwhile called them "filename-labelled
links, unchanged", which is false; `:87` is the filename-labelled one.
FIX: the kind prefix applies to the DECLARABLE tier only. The opaque tier keeps
the bare "Attachment N", so all four assertions are correct as they stand, and
section 9 now lists them as MUST-NOT-CHANGE. A kind-prefix test is added; no
existing test covered either half of that rule.

**H2 [MEDIUM] "Tier, header and extension can never disagree" was contradicted
on purpose by my own 6.3 rule 2.** ACCEPTED. FIX: the claim is narrowed to tier
and Content-Type; `resolveMediaTier` now specifies its opaque return
(`application/octet-stream`, `.bin`); and rule 2's reverse lookup is named as a
SEPARATE helper rather than left implied.

**H3 [MEDIUM] Rule 2's acceptance set, derived from a one-per-type emission
map, rejects the variant spelling of the same format.** VERIFIED against
`sendEmailMessage.ts:227` (`image/jpeg -> '.jpg'`): a derived set has no
`.jpeg`, so `photo.jpeg` becomes `photo.bin` - the exact outcome rule 2 was
added to prevent. FIX: two explicitly separate sets, with a note that deriving
one from the other is a defect. Regression test added.

**H4 [MEDIUM] The two ladders must locate the same dot and neither said
which.** ACCEPTED - `data.tar.csv` had three defensible readings. FIX: split at
the LAST dot, interior dots stay in the stem, leading-dot-only names have an
empty stem.

**H5 [MEDIUM] "The stem never ends in a dot" was an unenforced premise.**
ACCEPTED - `report.` yields `report..bin`; "reject `..`" was an ambiguous verb;
and the cap did not say what it bounds. FIX: every sanitization verb now says
REMOVE THE MATCHED CHARACTERS, trailing-dot removal is an explicit numbered
step, and the cap explicitly bounds the STEM - capping the emitted name would
truncate `.xlsx` to `.xls` and silently change the file type.

**H6 [MEDIUM] 7.1's transcode bullet named the wrong constraint.** VERIFIED:
the output type is the string literal `'image/jpeg'`
(`adapters/mediaTranscode.ts:28,80,109`), constrained by TYPE; `planMmsMedia`
only decides a plan from the SOURCE and constrains no output. This is the third
bullet in that one enumeration to be checked and found wrong across three
rounds - a standing signal that my enumerations need reading against the code
rather than from memory of it.

**H7 [LOW] "Repaired" was undefined across three writes.** ACCEPTED - fixed
with the three explicit interruption cases, including why the vendor-call count
can exceed the repair count.

**H8 [LOW] `annotateMessage` logs at INFO per call.** VERIFIED at
`messagesRepo.ts:2528-2537` - IDs only, so it is PII-clean, but an apply run
writes a CloudWatch line per repaired message alongside a report that claims
"counts only". Now an explicit acceptance rather than an unnoticed one.

**H9 [LOW] The 8KB summed inbound-email filename cap is not
extension-aware.** VERIFIED at `inboundEmail.ts:115,682-685` - a name truncated
mid-extension degrades rule 2 to `.bin` for the very population it serves.
Documented as a known limit; fixing it means touching the inbound write path
for a cosmetic gain on already-truncated historical names.

**H10 [LOW] 8.6 was correct but asserted rather than shown.** ACCEPTED - and
the reviewer independently VERIFIED the claim (a useful negative: unit photos,
call recordings and transcode originals are not reachable through
`media_attachments` at all, and the `resolveAttachmentKeys` writers are bounded
to jpeg/png/gif). The enumeration table is now in the spec.

## Round 3 outcome

10 accepted, 0 rejected. Two changed what gets built (H1's label rule and its
new test; H3's separate acceptance set); the rest are precision on an already
decided mechanism. Findings are now concentrated in one section and shrinking
in consequence round over round - converging, but not yet terminal, so round 4
runs. Round 4 is the CAP: if it still changes decisions, the design goes to the
human as a decision rather than into a fifth round.

---

# Round 4 (continued reviewer B) - TERMINAL

Report: `spec-r4-b.md`, 5 findings. Reviewer's own verdict: "the spec is
buildable once finding 1 is answered... Nothing here reopens a decision."

## ACCEPTED (all 5)

**J1 [HIGH] 6.4's tier-based labels need three mirrored things; the spec named
one.** ACCEPTED. Round 3 made the label rules TIER-based but left 6.4 saying
the dashboard mirrors "the four raster types" and put the kind map "beside the
type sets" - i.e. server-side, in the file 6.4 itself says the dashboard cannot
import. A builder would reach for a media-type PREFIX test, which collides on
`application/octet-stream` against the OOXML `application/...` types and on
`text/vcard` against `text/plain` - labelling the opaque case
"Document - Attachment 2" and breaking the two assertions section 9 had just
declared stable. FIX: 6.4 now enumerates all three mirrored items and states
explicitly that a prefix test is not an acceptable substitute.

**J2 [MEDIUM] The ASCII `filename` parameter was undefined for a wholly
non-ASCII stem.** ACCEPTED - no sanitization step removed or transliterated
non-ASCII, inbound email supplies such names verbatim
(`inboundEmail.ts:683-686`), and there is no RFC 5987 implementation in the
repo to copy, so a builder would plausibly emit `filename=".xlsx"` or
`filename=""`. FIX: replace each non-ASCII codepoint with `_` (replace, never
drop), fall through to the synthesized stem if nothing usable remains, and
state the `filename*` percent-encoding concretely.

**J3 [MEDIUM] Fourth consecutive defect in the 7.1 enumeration.** VERIFIED at
`routes/units.ts:766` - the unit-photo transcode RENDITION is a ninth
`mediaStore.put` that the `:516,686` citations do not reach. The reviewer
re-derived every `mediaStore.put` / `createPresignedPost` site to confirm the
list is now complete, and cleared three adjacent suspicions in the process
(`emailMedia` IS gated at `:65`; `unmatchedEmail.ts:204` routes through
`inboundEmail.ts:679`; `import/apply.ts:409` writes no `media_attachments`).
FIX: writer added, plus a line recording that the list was independently
re-derived at a named commit - it took four rounds to get right and should not
be treated as free to extend.

**J4 [LOW] Reader 4 named one of three identical presign-to-Twilio call
sites.** ACCEPTED - `retrySend.ts:158-164` and `api.ts:1589-1594` share the
shape and are safe only via `resolveAttachmentKeys` (`api.ts:527-531`), a
constraint invisible at the call site. All three are now named with that
constraint stated.

**J5 [LOW] Two statements in 6.3 were wrong rather than imprecise.** ACCEPTED:
the headline "THE EXTENSION IS ALWAYS DRAWN FROM OUR OWN MAP" contradicted the
paragraph below it (rule 2 draws from the ACCEPTED set, which must NOT be built
from the map), and that safety-relevant closed set was left open-ended with
"and so on". FIX: headline reworded to "one of our own closed sets", and the
ACCEPTED set is now exhaustively enumerated - it gates what reaches an
operator's filesystem, so an open-ended specification of it is not acceptable.

## Verified negatives (worth as much as the findings)

- 6.3 COMPOSES CORRECTLY. The reviewer walked thirteen concrete inputs
  including all five I named (`.env`, `report.`, `data.tar.csv`, the
  120-character stem, `photo.jpeg`).
- The H1 label fix is correct: `Timeline.email.test.tsx:88` and `:107` really
  are `application/octet-stream` with no filename, so 6.4's opaque rule leaves
  them exactly where section 9 says.
- 8.6's claim is complete - no population other than outbound email attachments
  changes tier without a backfill.

## Round 4 outcome - STOP

5 accepted, 0 rejected, and NO DECISION CHANGED: nothing altered what gets
built, added or removed a surface, or moved an invariant. Every fix was a
clause closing an ambiguity in prose the previous round introduced. By the stop
rule this is the TERMINAL round - folded in, and the cap is not needed.

## Campaign totals

52 findings adjudicated across 4 rounds: 50 accepted, 2 rejected (both
subsequently conceded by the reviewer on the code). 2 were blocking, and both
were defects in MY design rather than gaps in its description - a backfill that
would have written the wrong content type onto the wrong object, and a filename
rule that would have handed a sender-chosen executable extension to an
operator's OS. Neither would have been caught by any gate in the pipeline: the
first produces green tests against wrong data, and the second produces a
correct-looking download.

---

# PLAN review round 1 - two independent reviewers

Reports: `plan-r1-a.md` (24 findings), `plan-r1-b.md` (25 findings). Eight
BLOCKING, found independently by both, and all of one class: literal code a
builder would paste and trust. That class does not exist in a spec review,
which is why the plan gets its own round rather than inheriting the spec's
clean verdict.

Every blocking claim was re-verified by the planner against the code.

## ACCEPTED - blocking

**P1 Task 2 shipped four tests its own implementation cannot satisfy.**
VERIFIED by hand-tracing all four. Root cause was ONE ordering error: the
implementation SPLIT the filename before SANITIZING it, so `../../etc/passwd`
split at index 4 and handed `./etc/passwd` to the extension logic. The other
three followed from adjacent sloppiness - `.env` returned the whole name as a
stem (contradicting its own docblock), CRLF was deleted rather than replaced so
`a\r\nb` became `ab`, and an all-underscore stem counted as usable so a wholly
non-ASCII name became `__.xlsx`.
FIX: sanitize first, then split; control characters become a space; a
leading-dot name has an empty stem; `isUnusableStem` covers empty, all
placeholder and emailMime's `attachment-<i>`.

**P2 The trailing-dot strip ran before the cap only.** VERIFIED: a 110-char
stem with a dot at position 99 is cut to a stem ENDING in a dot, emitting
`name..mp4`. The plan's own comment claimed the opposite. FIX: strip before AND
after the cap, with a test whose fixture actually reaches the case.

**P3 Task 5's Twilio driver cannot compile.** VERIFIED at
`app/src/adapters/messaging.ts:390-399`: `TwilioClientLike.messages` is a plain
object with only `create`, because every injected fake is an object literal.
`this.client.messages(sid)` is a type error. Widening it to a call signature
would break six unrelated fakes for one new method.
FIX: assert a narrow `MessageMediaResource` view at the ONE call site, and
discriminate with `typeof ... === 'function'` so a message-only fake returns
undefined instead of crashing - which is also now a test.

**P4 Task 5's MediaStore tests assume a harness that does not exist.**
VERIFIED: `app/test/mediaStore.test.ts` is hermetic and asserts command shapes
against a fake `send`; its header says the real S3/MinIO path is exercised in
e2e. FIX: assert the `CopyObject` command shape instead - specifically
`MetadataDirective: 'REPLACE'`, whose absence makes the call a silent no-op
that looks like success.

**P5 Task 3's tests were aimed at a harness that cannot express them.**
VERIFIED: `mmsMedia.test.ts` drives the WEBHOOK, which normalizes the type on
the way in - so its "we still refuse text/html at read time" test would have
passed without ever exercising the read-side gate. `makeMediaApp`
(`apiRoutes.test.ts:600-632`) injects the message record and the store's
returned contentType independently. FIX: all new route tests move there, and
the text/html case now sets the type on the OBJECT while the record says
octet-stream - the actual legacy shape the gate exists for.

**P6 Task 6's fixtures cannot match its own regex.** VERIFIED: `ME_ZERO` is not
`ME` + hex. Ten-plus tests would have gone red looking like a logic bug. FIX:
real-shaped `ME` + 32 hex constants, and the regex tightened to `{32}`.

**P7 The dry run mutates the production bucket.** VERIFIED against the plan's
own prose: `setContentType` sat outside the `dryRun` guard while the test
forbade it. A dry run that writes makes the entire "dry run first" ops sequence
a lie. FIX: inside the guard, with the reason stated.

**P8 The account guard was decorative.** VERIFIED against the cited precedent:
`import-apply.ts:240-254` threads `hcCredentials()` into the client it actually
writes through; the plan called `assertHousingChoiceAccount()` and then built
clients from the DEFAULT chain, which in this environment points at a different
account. That is worse than no guard because it reads as protection. FIX:
construct all three clients from `hcCredentials()` + `HC_REGION` explicitly.

## ACCEPTED - the rest (summarised)

Task 1 Step 5 named harness symbols that do not exist (`deps`, `putSpy`,
`ingestWithAttachment`); replaced with the file's real `flakyAdapter` /
`storeSpy` shapes, and the inbound-email test is now an instruction to READ the
harness first rather than a guess at it. `written` semantics, the `merged`
array's load-bearing positional identity, and every counter's meaning are now
specified. A 429 no longer counts as retention loss (`skippedThrottled` is its
own counter) - the histogram is what the ops go/no-go turns on. The
per-attachment octet-stream predicate and an already-repaired-row test were
missing. No npm script exists for any backfill; the RUNBOOK uses `npx tsx`.
`MediaGallery` had no component test. The canned asset directory is
`fake-twilio/web/public/canned/` - under `src/assets` Vite inlines a small file
as a data: URI. The e2e now targets a 1:1 thread rather than a relay group,
which would also drive the known-broken forwarding path this spec disowns. The
stored-XSS issue needs a THREE-part amendment, not one. Emission-map
completeness is now a guardrail test. `git add app/test/` violated the
explicit-paths rule.

**RFC 5987 REVERSED.** The plan had dropped `filename*` as a deliberate
deviation; both reviewers pushed back, and they are right - spec 6.3 mandates
it, spec 9 tests it, and it compounded with the non-ASCII stem rule to lose an
operator's real filename entirely. It is about eight lines over
`encodeURIComponent`. Implemented.

## Planner-caught, no reviewer

Folding these fixes in, I introduced literal non-ASCII into the plan itself
(accented fixtures), then mangled the escapes trying to repair them with sed -
the exact encoding-lossy-pipeline failure `AGENTS.md` forbids on source files.
All non-ASCII fixtures are now BUILT with `String.fromCharCode`, which is
unambiguous at every layer and matches what `Timeline.tsx:604-608` already
does.

## Plan round 1 outcome

49 findings, 0 rejected. Round 2 required - eight blocking fixes are eight
pieces of brand-new unreviewed code.

---

# PLAN review rounds 2 and 3 (continued reviewer B) - TERMINAL

Reports: `plan-r2-b.md` (21 findings), `plan-r3-b.md` (10 findings). Both
rounds accepted in full, nothing rejected. Round 2 verdict: "the plan is
buildable", with all 22 of Task 2's assertions hand-traced against the
rewritten implementation. Round 3 verdict: "no fix broke anything", both of
round 2's behaviour changes re-traced against every assertion they could reach.

## Round 2 - what mattered

THREE COMPILE ERRORS BOTH ROUND-1 REVIEWERS MISSED. `setContentType`'s body
used free `client` / `bucket` and unannotated parameters inside a class holding
`this.client` / `this.bucket` (`mediaStore.ts:138-142`) - three errors under
`strict`, present since the first draft and past four reviewer-passes. The
messaging tests called `makeDriver({client})` when `makeDriver()`
(`messaging.test.ts:293`) takes zero arguments and is scoped to another
describe. `new S3MediaStore({client, bucket})` is an options object; the
constructor is positional `(bucket, client)`.

TWO BEHAVIOUR DEFECTS. `filename*` was dropped on the unusable-stem branch,
losing the RFC 5987 form for wholly non-ASCII names - the exact population it
exists for; the ascii and utf8 forms are now decided independently. And
`getMediaContentType` returns `undefined` for both "media aged out" and "this
client cannot read media at all", so a misconfigured ops run would report
everything aged out, write nothing and EXIT GREEN.

Plus: `encodeURIComponent` throws `URIError` on a lone surrogate and would have
500'd the authed media route; `skippedThrottled` had a counter and no detection
mechanism; Task 3 Step 5 edited assertions BY LINE NUMBER that its own Step 1
had shifted by ~105 lines; the RUNBOOK named an npm script Task 6 explicitly
refuses to create; and the inbound-email test had been made optional when the
harness exists and is citable at `inboundEmail.test.ts:975-988`.

## Round 3 - what mattered

ONE ACTIVELY WRONG THING. Task 3's replacement grep was unscoped and returns
FOUR hits, the fourth being `app/test/unitMediaServe.test.ts:77` - a different
serve route this change must not touch and that spec section 12 defers. The
step said "change each", so a literal builder would have edited an assertion
whose behaviour never moved, hiding an untouched route behind a green suite.

BOTH NEW MECHANISMS NEEDED WORK, which is the expected result for design added
in a fix batch rather than in the plan proper:

- The misconfiguration guard's predicate was wrong. "recovered is empty" fires
  on the permanent steady state section 6.6 explicitly accepts (unrepairable
  attachments re-queried every run), on a single aged-out attachment, and on an
  all-opaque recovery. Replaced with a pre-scan check of the Twilio credentials
  themselves - the actual cause, with no false positives - and MOVED to the CLI
  wrapper, because a guard that exits from inside the injected function reddens
  two of that function's own tests.
- The 429 path had no test seam at all, and compared `code === 20429`
  numerically. Twilio delivers `code` as a number OR a string - which is the
  entire reason `groupConversations.ts:322-329` exists - so the strict form
  would have let a string-coded rate limit fall through to "propagate
  everything else" and ABORT an ops run on a transient throttle.

## Campaign totals

SPEC: 4 rounds, 52 findings, 50 accepted, 2 rejected (both later conceded by
the reviewer on the code).
PLAN: 3 rounds, 80 findings, 80 accepted, 8 of them blocking.

132 findings across 7 rounds. The two documents failed in completely different
ways, which is the argument for reviewing them separately: the spec's defects
were reasoning errors (a backfill that would corrupt data, a filename rule that
would hand an operator an executable), while the plan's were mechanical - code
that would not compile, tests that could not pass, harnesses that do not exist.
A spec reviewer would never have found the second class, and a plan reviewer
anchored on an approved spec would have inherited the first.
