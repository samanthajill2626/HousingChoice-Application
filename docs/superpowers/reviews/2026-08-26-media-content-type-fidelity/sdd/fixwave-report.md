# Fix wave - media-content-type-fidelity

Base for this wave: `8842bdfb`. Three commits, all on
`feat/media-content-type-fidelity` in `W:\tmp\media-content-type-fidelity`.

| # | Commit | Covers |
|---|--------|--------|
| 1 | `6fd52655` | M1, P1, N8, N7/N9 comment truth, backfill anchor, RUNBOOK |
| 2 | `f4b0cf19` | N1, N2, N3, upload-gate route test |
| 3 | `b31281a1` | M2, P3/N4, N5 + conformance-N1/N2, ASCII slip, P2 issue |

Every adjudicated item is below with what changed, where, and the test that
proves it. Anything I had to interpret is flagged **INTERPRETED**.

---

## A. M1 - wrong-Twilio-account silent green exit

**Account SID guard.** `BackfillMediaContentTypesOpts` gains
`expectedAccountSid?: string`
(`app/scripts/backfill-media-content-types.ts:147-153`). A new exported pure
parser `parseAccountSid` (`:181-183`) reads `/\/Accounts\/([^/]+)\//` off the
stored media URL, and the candidate loop compares it per attachment, throwing on
the FIRST mismatch (`:443-456`). The throw happens during candidate assembly, so
it precedes `drain()` entirely - no vendor call, no S3 copy, no row write. Rows
whose URL carries no `/Accounts/<x>/` segment fall through to previous behavior,
as the review specified.

The regex is deliberately loose (`[^/]+`, not `AC` + 32 hex): the value is only
ever COMPARED, so a malformed account segment must read as a mismatch rather
than be silently ignored. Rationale is in the function's docblock.

**CLI wrapper.** `main` passes `expectedAccountSid: config.twilioAccountSid`
unconditionally (`:713-716`) - the pre-scan guard has already proven the field
is set.

**TWILIO_API_BASE_URL refusal.** Extended `messagingMisconfiguration` rather
than adding a sibling (`:588-590`), because it is already the pre-scan,
exit-non-zero, cause-naming guard and the new case is the same class. The
function is now EXPORTED so it can be unit-tested; its docblock explains the
redirect seam, and `HOW_TO_FIX` tells the operator to unset the variable.

**Tests** (`app/test/backfillMediaContentTypes.test.ts`):
- harness `run()` gains `expectedAccountSid` and `captureError` passthroughs.
- `ABORTS on the first media URL naming another account, before any vendor call`
  - asserts the message names both SIDs and the phrase WRONG ENVIRONMENT, and
  that `getMediaContentType`, `setContentType` and `annotateMessage` were all
  never called.
- `runs normally when the media URL names the configured account` - proves the
  guard is not simply always-on.
- `describe('messagingMisconfiguration')` - three cases: a good shell passes,
  `TWILIO_API_BASE_URL` is refused, the console driver is refused first.
- Every pre-existing test omits the opt and is unchanged.

**INTERPRETED:** the error names both account SIDs in full rather than prefixes.
An account SID is an identifier, not a secret, the script's PII rule is
"counts and IDs only", and a prefix would not tell an operator which environment
they are actually pointed at.

**RUNBOOK** gained an env bullet for the refusal
(`RUNBOOK.md`, the backfill section's env list) - without it an operator hitting
the new exit-1 has nothing to read. It also states the account-abort in one
sentence. This is slightly beyond the letter of the adjudicated list, which
named only the P1 sentence for the RUNBOOK, but the CLI change makes the old
list wrong, and a wrong runbook is the defect this whole wave is about.

## C. P1 - lost-update race on the row write

`messagesRepo` injection widened to
`Pick<MessagesRepo, 'getByTsMsgId' | 'putMediaPointers' | 'annotateMessage'>`
(`:140-142`). The per-row block (`:471-533`) now:

1. builds `stagedByKey` (s3Key -> canonical) from the snapshot,
2. `await messagesRepo.getByTsMsgId(...)` immediately before the writes,
3. skips the row entirely (no write, nothing counted) when the re-read is
   `undefined` **or** carries no `media_attachments` array,
4. maps over the RE-READ list, applying a staged type only where `s3Key`
   matches, counting `applied`,
5. skips the write when `applied === 0`,
6. `result.written += applied`.

Order within the re-read list is preserved (`map`, never filter/reorder/append),
which is what keeps `mediaPointerSk` and `/media/:idx` addressing the same
bytes.

**Docblock** (`:13-42`) rewritten honestly: it names `annotateMessage`'s
wholesale SET, the mirror's append window, and states that the merge SHRINKS the
window to the re-read-to-write gap rather than closing it (no optimistic
concurrency on the write, and `getByTsMsgId` is not a consistent read).

**`calls` recording - decision made and stated:** the re-read IS recorded, as
`read:<conversationId>`. The order assertion is updated to
`['s3:media/c1/MM1/0', 'read:c1', 'pointers:c1', 'annotate:c1']`. Recording it
turns the existing write-order test into a proof that the re-read is as LATE as
possible, which is the property the fix depends on; leaving it out would have
left the placement untested.

**Tests:** harness `getByTsMsgId` defaults to returning the scanned row; a new
`reread` option supplies a different row (or `null` for "gone").
- `PRESERVES an attachment the mirror appended between the scan and the write` -
  asserts the exact array handed to BOTH `putMediaPointers` and
  `annotateMessage`: appended entry intact, staged entry repaired.
- `matches the staged repair BY s3Key, not by array position` - the re-read has
  a different entry in slot 0; positional application would have stamped
  `video/mp4` on it.
- `writes nothing and does not throw when the row is gone at write time`.
- All pre-existing order / once-per-message / re-runnable tests stay green.

The fake `putMediaPointers` / `annotateMessage` signatures were widened to their
real arity (with `_`-prefixed unused params, per the repo's eslint convention)
so the merge tests can assert on the attachment array.

**RUNBOOK** step 4 gained the honest sentence: merged by `s3Key` at write time,
window shrunk not closed, quiet window still the belt-and-braces choice.

## D. N1 - Windows reserved device names

`RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i`
(`app/src/lib/mediaFilename.ts:20-27`) folded into `isUnusableStem` (`:81-92`).
Applied to BOTH decisions: the ascii branch through `isUnusableStem(asciiStem)`,
and the utf8 branch, which is now `!isUnusableStem(stem) && stem !== asciiStem`
(`:151-154`).

That substitution is behavior-preserving on the two old conditions:
`stem.length > 0 && !SYNTHESIZED.test(stem)` are both inside `isUnusableStem`,
and its extra `/^[_\s]+$/` arm can only match a pure-ASCII stem, for which
`stem !== asciiStem` is already false.

**Tests:** `treats a Windows RESERVED DEVICE NAME as unusable, extension or not`
(CON, nul, PRN.mov, COM1 -> `attachment-1.mp4`; LPT1.csv -> `attachment-1.csv`
on the opaque tier) and `leaves a stem that merely STARTS with a device name
alone` (CONTRACT.pdf, COM10).

## E. N2 - BiDi / direction-control stripping

`sanitizeName` REMOVES `[\u200e\u200f\u202a-\u202e\u2066-\u2069]`
(`app/src/lib/mediaFilename.ts:57-66`), between the Windows-character rule and
the traversal rule.

**Test:** `strips Unicode direction controls so filename* cannot spoof an
extension`. The fixture is built with `String.fromCharCode(0x202e)` plus a
non-ASCII character, so BOTH forms exist and can be asserted:
`{ascii: 'rep_fdp.csv', utf8: 'rep<e-acute>fdp.csv'}`, and the assembled header
contains neither the raw control nor its percent-encoding `%E2%80%AE`.

**INTERPRETED:** the finding's own repro (`report\u202Efdp.csv`) sanitizes to a
pure-ASCII stem, which produces no `filename*` at all - true, but it proves the
point vacuously. Adding one non-ASCII character keeps a real `filename*` in the
output so the assertion has something to be about.

## F. N3 - surrogate-safe cap

`dropLoneHighSurrogate` (`app/src/lib/mediaFilename.ts:94-105`) applied between
the slice and the final trim (`:139`). A high surrogate at the very END of a
string is unpaired by definition, so the last-code-unit test is sufficient.

**Test:** `does not split a surrogate pair at the cap and lose filename*` - a
99-code-unit stem (50 ASCII + 49 non-ASCII), then an astral character, then a
tail. Before the fix the stem ended in a lone high surrogate, `rfc5987` threw,
and the header emitted NO `filename*`; the test asserts the parts and that the
header contains the full encoded `filename*`.

**INTERPRETED:** the finding's suggested fixture (99 ASCII + emoji) cannot show
the loss - drop the surrogate and the stem is pure ASCII, so `filename*` is
correctly absent either way, and the header is identical before and after. The
non-ASCII prefix is what makes the regression observable.

## G. N8 - missing provider_sid

Guarded at `app/scripts/backfill-media-content-types.ts:432-442`, before the
vendor call, counted as `skippedNoUrl`. The counter's semantics comment
(`:100-104`) now says "an absent or non-string `provider_sid` lands here too"
with the reason.

**Test:** `skips a row whose provider_sid is missing rather than 404ing on it` -
`skippedNoUrl` 1, `skippedTwilio404` 0, `getMediaContentType` never called.

## H. Upload-gate route test (spec 5.2)

`app/test/mmsMediaRoutes.test.ts` -
`still rejects video/mp4 - the DECLARABLE tier did NOT widen this gate`, copying
the existing `image/svg+xml` case's shape (400, `unsupported_media_type`).

## B. M2 - dashboard mirror pinned to the server sets

New: `dashboard/src/routes/contact/mediaTypeMirror.test.ts`. It imports
`IMAGE_MEDIA_TYPES` and `DECLARABLE_MEDIA_TYPES` from
`../../../../app/src/lib/mediaTypes.js` and the two collections from
`./media.js`, and compares sorted set contents:

- `INLINE_RENDERABLE_TYPES` === `IMAGE_MEDIA_TYPES` (plus an explicit assertion
  that `application/pdf` is absent, so the deliberate divergence is documented
  as intent rather than looking like an omission),
- `KIND_WORDS.keys()` === `DECLARABLE_MEDIA_TYPES`,
- a non-vacuity floor (neither app set is empty).

`INLINE_RENDERABLE_TYPES` and `KIND_WORDS` are now `export`ed from
`dashboard/src/routes/contact/media.ts`, with a header note saying why (the
drift guard; components still go through the three predicates).

**Proven non-vacuous:** temporarily added `image/avif` to the app's
`IMAGE_MEDIA_TYPES`, ran the test, watched it fail naming `image/avif`, reverted.

**INTERPRETED - which precedent, and which direction.** The mechanism is
`app/test/consentDrift.test.ts`'s (import both copies, compare resolved values),
not `sw/mirror.test.ts`'s `readFileSync` + `new Function` - the latter exists
because a classic service worker cannot be imported, which does not apply here.
The DIRECTION is reversed from consentDrift, and the test therefore lives
dashboard-side: `app/tsconfig.test.json` sets no `jsx` option, so importing
`dashboard/src/routes/contact/media.ts` app-side would pull in its type-only
`../../api/index.js` barrel, which re-exports `EventStreamProvider.tsx`, and
`npm run typecheck` would fail on TS17004. The app module imported here is a
near-leaf (one pure constants import), so the traffic goes the cheap way. The
test file header records all of this.

## I. Comment / doc truth fixes (no behavior)

- `app/src/services/mediaMirror.ts:100-108` - rewritten to describe the current
  rule (inline OR declarable kept canonically, everything else octet-stream) and
  to name `resolveMediaTier` in `lib/mediaTypes.ts` as the shared decision.
- `app/src/lib/mediaTypes.ts:1-11` - header now names all three tiers and the
  real write sides (`services/mediaMirror.ts`, `services/inboundEmail.ts`)
  instead of `webhooks/twilio.ts`. The following paragraph is now labelled as
  the INLINE tier's detail; its pre-existing lines (which carry em dashes) were
  deliberately NOT reflowed, so no non-ASCII line is re-added by this branch.
- `app/scripts/backfill-media-content-types.ts` - `createMessagingAdapter`
  anchor corrected `1162-1193` -> `1208-1239` (verified against the live tree);
  the write-order docblock now records that `annotateMessage` re-writes the
  pointer rows internally, so the third write repeats the second on purpose;
  `skippedEmailRow`'s comment says it is counted EVERY run, repaired or not.
- `docs/issues/relay-forwards-undeliverable-media.md` - `refs:` and all three
  body anchors re-pointed at the current tree (`mediaTypes.ts:211-225` /
  `:216-220` / `:230-249`, `api.ts:2252`), and the closing paragraph reworded:
  this branch changes what Twilio SEES (octet-stream -> true type), the expected
  outcome is still a failed leg since video and audio stay outside
  `TWILIO_DELIVERABLE_MMS_TYPES`, but that is Twilio's decision, has not been
  observed, and the observable most likely to move is the ERROR CODE.
- `fake-twilio/web/src/assets/canned/index.ts:3` - em dash -> `-`. Whole-branch
  ASCII scan of added lines is now clean.

## J. P2 tracking issue

`docs/issues/declarable-office-doc-types-double-click.md` - copied from
`_TEMPLATE.md`, `type: security`, `severity: low`, `status: open`,
`area: app/media`, ASCII-only. States the exposure (declarable tier + typed
filenames make sender-chosen `text/csv`/`.docx`/`.xlsx` double-clickable where
they were extensionless and inert before), why the two documented threat models
each miss the overlap, why it is bounded (download AND open, Protected View,
small authed operator population, same class as any email-attachment workflow),
that design decision D1 named these exact types so this is a recorded
acceptance, and the two options if revisited. References the spec path and
adversarial finding P2. `npm run issues` regenerated the gitignored index
(257 open); INDEX.md is not committed.

---

## Verification

All bare, none piped.

| Command | Result |
|---|---|
| `cd app && npx vitest run test/backfillMediaContentTypes.test.ts test/mediaFilename.test.ts test/mediaTypes.test.ts test/mmsMediaRoutes.test.ts test/apiRoutes.test.ts test/mmsMedia.test.ts test/mediaMirror.test.ts test/inboundEmail.test.ts` | 8 files, **205 passed**, exit 0 |
| `cd dashboard && npx vitest run src/routes/contact/` (includes the new pin) | 55 files, **936 passed**, exit 0 |
| `npm run typecheck` (all five workspaces) | exit 0 |
| `npx eslint <all 10 touched .ts files>` | exit 0, zero problems - no baseline comparison needed |
| ASCII scan of every added diff line + both new files | clean |

`mediaMirror.test.ts` and `inboundEmail.test.ts` were added to the app run
beyond the prescribed list because the wave edits their write-side comment and
the shared `mediaTypes.ts` header.

Not run in this wave (unchanged by it, and the orchestrator did not ask):
`npm test` in full, `npm run smoke`, `npm run e2e`.

## Surprises

None that blocked. Two things worth the next reader's attention:

1. The M2 pin could not go app-side. `app/tsconfig.test.json` has no `jsx`
   option and the dashboard's `contact/media.ts` type-imports a barrel that
   re-exports a `.tsx`, so the consentDrift direction would have failed
   `npm run typecheck` rather than the test. Reversed direction, same mechanism;
   documented in the test header.
2. The P1 fix required widening the injected `messagesRepo` surface with
   `getByTsMsgId`, which every existing test's fake had to gain. No test
   resisted structurally; the only assertion that moved is the write-order one,
   and it moved because I chose to RECORD the read (it is now also a placement
   proof).
