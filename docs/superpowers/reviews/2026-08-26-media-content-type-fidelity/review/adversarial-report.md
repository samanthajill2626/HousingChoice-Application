# Adversarial review - feat/media-content-type-fidelity @8842bdfb

Read-only review, no spec/plan supplied; intended behavior derived from the diff,
the tests, and the surrounding code. Base `main` @3c2962a4.

Method: read every changed file at HEAD, then swept the WHOLE repo for the other
readers/writers of each touched value (`contentType` on `media_attachments`, the
S3 object type, the pointer rows, `Content-Disposition`, the dashboard type
sets), walked the backfill's write path against the live runtime's write path,
and reproduced the pure functions in a scratchpad to probe edge inputs.

Verdict: the feature is unusually well-reasoned and most of the traps a reviewer
would go looking for are already closed and tested. Two findings are worth
blocking on, three are worth a decision, the rest are nits. Section 3 lists the
things that looked wrong and are not - that list is long on purpose.

---

## 1. Must-fix

### M1. The backfill's misconfiguration guard names the wrong-Twilio-account case as a cause and then does not guard it - and the evidence is free in data it already parses

`app/scripts/backfill-media-content-types.ts:29-36` states the hazard:

> `getMediaContentType` resolves `undefined` both for "Twilio no longer has this
> media" and for "this client cannot read media at all" (the CONSOLE driver, a
> message-only fake, **a credential pointed at another account**).

`messagingMisconfiguration` (`:461-469`) checks only `messagingDriver === 'twilio'`
and the presence of three credential strings. The third named cause - a credential
for the WRONG Twilio account - passes the guard cleanly.

Walk:

1. Operator has finished dev and moves to prod. The shell still carries the DEV
   `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`, but
   `TABLE_PREFIX` and `MEDIA_BUCKET` have been switched to prod.
2. `messagingMisconfiguration` returns `undefined` - driver is twilio, all three
   credentials are set.
3. `assertHousingChoiceAccount()` passes. It cannot help: `scripts/lib/hcAws.mjs:14`
   pins ONE account id (`938565869261`) for dev AND prod, so the AWS guard gives
   zero environment separation. It proves the right *company*, never the right
   *environment*.
4. Every prod `MEXXXX` media SID 404s on the dev account. `getMediaContentType`
   returns `undefined` for all of them (`app/src/adapters/messaging.ts:947-950`).
5. Every attachment lands in `skippedTwilio404`. `written` is 0, `recovered` is
   `{}`, the run **logs a WARN and exits 0** (`:538-551`).
6. The RUNBOOK's step 3 says "Recovering nothing WARNs and still exits 0 - the
   correct steady state for an already-repaired environment", so the report is
   indistinguishable from success. Prod is never repaired and nobody learns that.

This is exactly the green-exit catastrophe the guard exists to prevent, reached by
a cause the guard's own docstring enumerates.

**The fix is nearly free and uses data the script already regexes.** Twilio's
stored `MediaUrl{i}` embeds the account SID:
`https://api.twilio.com/2010-04-01/Accounts/AC.../Messages/MM.../Media/ME...`
(the test fixture at `app/test/backfillMediaContentTypes.test.ts:9-10` is exactly
this shape). `parseMediaSid` (`:163-165`) already parses that URL. Extending it to
also read `/Accounts/(AC[0-9a-f]{32})/` and refusing the run when the first
candidate's account SID does not equal `config.twilioAccountSid` turns a silent
green exit into a hard refusal before any write. Rows whose URL does not carry an
account SID can fall through to today's behavior.

**Secondary, same class:** `TWILIO_API_BASE_URL` is also unguarded and produces
the identical silent-green outcome. `TwilioMessagingDriver`'s constructor
(`app/src/adapters/messaging.ts:604-611`) installs a redirecting HTTP client for
EVERY REST call when `apiBaseUrl` is set, media metadata fetches included. Config
rejects that variable only under `NODE_ENV=production` (`app/src/lib/config.ts:543-546`),
and the RUNBOOK's required-env list (`RUNBOOK.md`, the new section's env bullets)
does not include `NODE_ENV` at all - the script's own docstring assumes it is NOT
production, since it explains that `loadConfig` defaults the driver to `console`
"outside production". Adding `NODE_ENV=production` to the RUNBOOK's prod env list
is a one-line hardening that closes this for free and also arms the
`mediaS3Endpoint` fail-closed at `app/src/adapters/mediaStore.ts:377-379`. This
half is lower-probability than the account half (there is no dotenv in this repo -
see `app/src/lib/import/convertGroups.ts:167` - so it must be exported by hand),
but it costs nothing to close.

### M2. Nothing pins the dashboard's mirrored type sets to the server's, and drift there is the exact bug this branch was written to fix

`dashboard/src/routes/contact/media.ts:44-111` hand-copies three things from
`app/src/lib/mediaTypes.ts`: `INLINE_RENDERABLE_TYPES`, `KIND_WORDS` (the
declarable set), and the kind word per type. The header says "Source of truth:
app/src/lib/mediaTypes.ts" and then nothing enforces it. `media.test.ts:56-108`
spot-checks individual entries; no test compares the sets.

This is not hypothetical drift - it is the SAME defect the branch fixes.
`MediaGallery.tsx:36` and `Timeline.tsx:648` previously branched on
`contentType.startsWith('image/')`, which agreed with the server allowlist right
up until the server started storing `image/heic`, at which point the dashboard
rendered a broken `<img>`. The fix replaced one un-pinned copy with three
un-pinned copies.

Concrete future break: someone adds `image/avif` to `IMAGE_MEDIA_TYPES`
(`mediaTypes.ts:23-28`). The app-side guardrail test at `mediaTypes.test.ts:105-119`
passes (an extension exists). The server serves it inline. The dashboard's
`isInlineRenderable('image/avif')` returns false, so the gallery shows a file tile
for a perfectly renderable photo - a silent UX regression with a green suite.
The reverse edit (adding to the dashboard set only) reproduces the original broken
`<img>`.

**The repo already has the pattern for this.** `dashboard/src/sw/mirror.test.ts:49-61`
solves the identical "two files that cannot import each other must not drift"
problem by `readFileSync`-ing across the workspace boundary
(`join(here, '..', '..', 'public', 'sw.js')`) and comparing BEHAVIOUR. A dashboard
test that reads `../app/src/lib/mediaTypes.ts` and asserts
`KIND_WORDS.keys() === DECLARABLE_MEDIA_TYPES` and
`INLINE_RENDERABLE_TYPES === IMAGE_MEDIA_TYPES` is the same trick, and it is the
only thing that makes the "source of truth" comment true.

---

## 2. Plausible - worth a decision, not necessarily a code change

### P1. The backfill's row write is a blind lost-update: it can silently delete an attachment the deferred mirror job appended mid-run

`app/scripts/backfill-media-content-types.ts:405-413` rebuilds `merged` from
`row.attachments`, which was captured during the Scan (`:336`, `:353-358`), and
hands it to `annotateMessage`. `annotateMessage`
(`app/src/repos/messagesRepo.ts:2503-2526`) does
`SET media_attachments = :mediaAttachments` with `ConditionExpression:
'attribute_exists(tsMsgId)'` - a wholesale replace with no optimistic
concurrency on the value. The Scan is also eventually consistent (no
`ConsistentRead`), which widens the window at the front.

Interleaving:

1. An inbound MMS arrives carrying two media whose sender-declared types are off
   BOTH allowlists (e.g. `application/zip`), so the mirror stores both as
   `application/octet-stream` - the backfill's candidate predicate (`:366`).
2. The inline mirror lands index 0 and 404s on index 1 - the documented Twilio
   race (`app/src/services/mediaMirror.ts:6-14`). Row now holds
   `media_attachments = [ {s3Key: media/C/SM1/0, octet-stream} ]`. `media.mirror`
   is scheduled at +5s, with rungs out to ~3 minutes
   (`app/src/jobs/mediaMirror.ts:39-42`).
3. The backfill's Scan page includes this row and snapshots that ONE-element array.
4. `drain` runs. With `VENDOR_CONCURRENCY = 4` and the throttle ladder
   (`THROTTLE_BACKOFF_MS = [1000, 2000, 4000]`, `:77`), a throttling Twilio can
   hold the page for many seconds to minutes before the write loop starts.
5. Meanwhile `media.mirror` lands index 1 and writes
   `media_attachments = [A0, A1]` plus the pointer for position 1
   (`app/src/jobs/mediaMirror.ts:150-160`).
6. The backfill then writes its snapshot back: `media_attachments = [A0']`.
   **A1 is gone from the row, permanently.**

Consequences: the timeline loses the second attachment entirely. The pointer row
for position 1 is a separate DynamoDB item and SURVIVES (the backfill's
`putMediaPointers` only writes positions 0..len-1 of its own `merged`), so the
contact media gallery keeps showing a tile whose `GET /api/messages/SM1/media/1`
now 404s at `app/src/routes/api.ts:2268-2271`. No counter moves; `written`
increments as if the row were correct. A re-run cannot notice: position 0 is now
repaired, so the row is never selected again.

Probability is low - it needs an inbound MMS with 2+ media, an off-allowlist type,
a failed inline mirror leg, and the deferred rung landing inside the drain window,
all during a human-supervised one-time run against ~11 rows. But it is the ONLY
silent, permanent data-loss path in the diff, and the file's header claims
"Nothing here is destructive on a re-run" (`:22`) without qualification.

Cheapest closes, in order: (a) add `ConditionExpression: 'media_attachments = :expected'`
support (or a `size(media_attachments) = :n` guard) so a concurrent append makes
the write fail loudly and re-runnably; (b) re-read the row with `getByTsMsgId`
immediately before the write and merge by `s3Key` the way
`app/src/jobs/mediaMirror.ts:151-159` already does; (c) at minimum, state the
hazard in the RUNBOOK and tell the operator to run the backfill during a quiet
window.

### P2. The feature newly hands operators double-clickable Office/CSV files chosen by an untrusted sender, and nothing in the diff reasons about it

Two statements in the diff are each true and, together, leave a gap:

- `app/src/lib/mediaTypes.ts:49-58`: the declarable tier's entry criterion is
  "None is script-capable ... a browser handed one of these cannot execute
  anything in the dashboard origin."
- `app/src/lib/mediaFilename.ts:7-11`: "The point of this feature is a name the
  operating system ACTS ON, which is precisely why the sender must not choose it:
  today's extensionless `attachment-0` is inert, and `invoice.exe` would not be."

The threat model is scoped to the BROWSER ORIGIN; the filename work deliberately
extends reach to the OPERATOR'S OS. The overlap is `text/csv`, `.docx` and `.xlsx`,
which are on both the declarable set (`:78-81`) and `ACCEPTED_EXTENSIONS`
(`:130-135`).

Before this branch, an inbound email attachment declared `text/csv` was stored as
octet-stream and served as `attachment; filename="attachment-0"` - no extension,
so a double-click did nothing. After, an attacker who emails a part with
`Content-Type: text/csv` and `filename="Payroll Q3"` gets
`Content-Type: text/csv` + `Content-Disposition: attachment; filename="Payroll Q3.csv"`,
which Excel opens on double-click - the standard CSV-formula/DDE injection setup.
`.docx` is the remote-template-injection carrier.

I grepped the design and plan docs for `macro`, `csv injection`, `dde`,
`double-click`, `antivirus`, `malware` and `office document`: no hits. This is not
a claim that the tier is wrong - the operator population is small and authed, and
the files were already downloadable. It is a claim that the ONE new risk the
filename change introduces is the one the documented threat model does not cover,
and it should be either accepted in writing or narrowed (dropping `text/csv` and
the two OOXML types from the declarable tier costs almost nothing - they still get
their stored extension on the opaque tier, per `extFor` at
`mediaFilename.ts:135-143`).

### P3. The relay fan-out behavior change is real and untested, and the new issue asserts the opposite

`docs/issues/relay-forwards-undeliverable-media.md:64-67` says this branch "does
make the stored Content-Type truthful, so after it lands the object Twilio refuses
says `video/mp4` rather than `application/octet-stream` - **the leg still fails**".

That last clause is an unverified assertion about a live production send path
whose input this branch changes. `app/src/jobs/relayFanOut.ts:496-500` presigns
inbound attachments and hands the URLs to Twilio, which fetches each object and
reads its S3 `Content-Type`. This branch changes that byte-for-byte for every new
inbound relay attachment, and the backfill changes it retroactively for the
historical population. `application/octet-stream` and `video/mp4` are not the same
input to Twilio's accepted-content-type check; whether the outcome improves or
worsens, the issue's stated post-landing behavior is a guess presented as a
conclusion, on the one path where the consequence is "the other members receive
NOTHING - not the media and not the accompanying body text" (`:32-35`).

The issue is otherwise a good file and correctly scopes the fix out. It should say
"post-landing behavior on this path is UNVERIFIED and may differ per type" rather
than asserting no change. There is no test anywhere in the diff covering what
relay fan-out now hands Twilio.

---

## 3. Verified sound (things that looked wrong and are not)

Recording these so the next reviewer does not re-derive them.

- **`drain()`'s cursor claim is exactly right.** `:296-314`. `Array.from({length}, async fn)`
  invokes the mapper synchronously per index; each async body runs to its first
  `await` before returning a pending promise, and `const index = cursor; cursor += 1`
  sits before that await. No two workers can claim the same index. The comment
  says precisely this and is correct.
- **s3-key index vs. array position is handled correctly, and it is subtle.**
  `media.mirror` APPENDS (`app/src/jobs/mediaMirror.ts:147-159`), so array position
  can differ from the key's trailing integer. The backfill reads the URL by the
  KEY index (`:369-375`) and writes by the ARRAY position (`:292`, `:405-408`).
  `parseInboundMediaUrls` (`app/src/routes/webhooks/twilio.ts:436-447`) compacts,
  and `mirrorInboundMedia` (`:489`) indexes targets by the compacted position, so
  the key's integer really is the stored-`mediaUrls` index. Pinned by
  `backfillMediaContentTypes.test.ts:78-90`.
- **No header injection is reachable.** `asciiStem` is forced to `[\x20-\x7e]`
  (`mediaFilename.ts:112`); `extFor` can only return a member of the ASCII
  `ACCEPTED_EXTENSIONS` set or `resolved.ext` (also ours), because
  `isAcceptedExtension` lowercases before the set test and the only non-ASCII
  characters that lowercase to ASCII (U+212A -> k, U+0130 -> i+combining) produce
  no member of that set; `filename*` is percent-encoded end to end. So
  `res.setHeader` can never see a char outside latin1 (which would throw
  `ERR_INVALID_CHAR`). I reproduced `a"; x=1; y="b` -> `attachment; filename="a; x=1; y=b.mp4"`:
  the `;` and `=` stay INSIDE the quoted-string, and quotes are stripped, so
  parameter injection is not reachable either.
- **Path traversal in the download name is closed, and the stated ordering reason
  is the real one.** `../../etc/passwd` -> `etcpasswd.mp4`;
  `C:\Users\x\secret.txt` -> `CUsersxsecret.mp4`. Sanitize-before-split is correct.
- **`resolveMediaTier`'s essence match does not widen the script-capable set.**
  `text/html; charset=x` -> essence `text/html` -> opaque. The safety argument
  ("safety rests on the CANONICAL OUTPUT, not the matching") is right: the response
  header is always the allowlist's own constant, never the caller's string.
- **The declarable tier's "never rendered same-origin" guarantee does not actually
  depend on `Content-Disposition`** (which browsers ignore for subresource loads).
  It rests on the allowlist being non-script-capable, plus `nosniff` and
  `default-src 'none'; sandbox` on every response. That is the correct ordering of
  guarantees and the code states it that way.
- **`Content-Disposition: inline` newly added to the image/PDF responses is
  harmless.** Ignored for `<img>` subresource loads; honored as "render, and here
  is the save name" on top-level navigation. `apiRoutes.test.ts:648` and
  `mmsMedia.test.ts:229` were updated to match.
- **`CopyObject` + `MetadataDirective: REPLACE` is the right command and loses
  nothing here.** `mediaStore.put` sets only `ContentType`, no user metadata; the
  bucket is SSE-S3 (`infra/modules/s3_media/main.tf:19-23`, AES256, explicitly no
  KMS), so there is no key to lose on the copy. The RUNBOOK's "versioned and
  carries NO lifecycle rule, so the old bytes stay recoverable" claim checks out
  against `aws_s3_bucket_versioning` at `main.tf:12-16`. The test pins the command
  CLASS, which is the failure mode that matters.
- **`createMessagingAdapter` returns the driver undecorated** (`messaging.ts:1208-1238`),
  so the new `getMediaContentType` survives the factory - a real risk on a codebase
  that wraps adapters, and it does not apply here.
- **Historical inbound-EMAIL attachments are not left as badly off as the
  `skippedEmailRow` counter implies.** They are never repairable (the threaded row
  carries no `attachments_meta` - that field is only on the UNMATCHED row,
  `inboundEmail.ts:583`; the true type survives only in the raw MIME at
  `email_raw_ref`). But the opaque tier keeps a recognised stored extension
  (`extFor`, `mediaFilename.ts:139-141`), so an old `budget.xlsx` still downloads
  as `budget.xlsx`. Only the Content-Type header and the timeline kind word stay
  degraded. Pinned by `apiRoutes.test.ts:770-778`. Worth ONE sentence in the
  RUNBOOK saying inbound email is permanently out of scope; nothing more.
- **Appending `contact-card` to `cannedAssets` is safe.** Every consumer addresses
  `cannedAssets[0]` (`Composer.test.tsx:42,68,71,74`, `GroupPanel.test.tsx:98`,
  `MessageBubble.test.tsx:70`); nothing counts them. `isImageAsset`'s regex already
  excludes `.vcf`.
- **No service worker caches media.** `dashboard/public/sw.js` is push-only with no
  precaching (`dashboard/src/main.tsx:22-24`), so the stored-type change has no
  stale-cache surface beyond the response's own `private, max-age=3600`.
- **`media-serve-stored-xss.md`'s "Current anchors" paragraph is accurate on this
  branch** - I checked all five (`api.ts:2284-2304`, `mediaTypes.ts`,
  `mediaMirror.ts:104`, `messagesRepo.ts:1001`, `app.ts:118`, `api.ts:2168`). Good
  re-anchoring discipline; see N4 for the file where it was not applied.
- **`app/src/routes/unitMediaServe.ts:63` deliberately keeps the old
  `isInlineMediaType` two-branch logic** and is correct to: unit photos are
  operator-uploaded and gated at presign. The backfill's key regex
  (`^media/[^/]+/[^/]+/(\d+)$`) cannot match a `units/...` key, so the shared
  bucket is not at risk.

---

## 4. Nits

- **N1. Windows reserved device names pass through.** `sanitizeName`'s own comment
  (`mediaFilename.ts:45-47`) says "A name we hand to an operator's browser has to
  be a legal filename on their machine", but it only handles reserved CHARACTERS.
  Reproduced: `CON` -> `CON.mp4`, `NUL` -> `NUL.mp4`, `PRN.mov` -> `PRN.mp4`,
  `COM1` -> `COM1.mp4`, `LPT1.csv` -> `LPT1.mp4`. Chromium sanitizes reserved names
  in its own download path, so practical impact is browser-dependent - but the
  comment overclaims. One `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i` test on the
  stem, falling through to `isUnusableStem`, closes it.
- **N2. BiDi override characters survive into `filename*`.** U+202E/U+202D are not
  in `\s` and are not stripped. Reproduced: `report\u202Efdp.csv` on the opaque
  tier emits `attachment; filename="report_fdp.csv"; filename*=UTF-8''report%E2%80%AEfdp.csv`,
  which a client honoring `filename*` displays as `reportvsc.pdf` - a CSV wearing a
  PDF's face. The ASCII form correctly folds it to `_`; only the UTF-8 companion
  carries it. Since the real extension is always from our closed set, the ceiling
  is spoofing between two safe types, but it pairs badly with P2. Stripping
  `[\u202a-\u202e\u2066-\u2069]` in `sanitizeName` is one line.
- **N3. `stem.slice(0, MAX_STEM)` can split a surrogate pair, which then silently
  drops `filename*` entirely.** Reproduced with 99 `a` + an emoji + `tail`: `stem`
  ends in a lone high surrogate, `rfc5987` throws `URIError`, the catch at
  `mediaFilename.ts:86-88` returns `undefined`, and the header emits no `filename*`
  at all. The catch exists for hostile input; here the code manufactures the
  condition from valid input, and the international name is lost for a name that is
  merely long. Backing the slice off by one when
  `stem.charCodeAt(MAX_STEM-1)` is a high surrogate fixes it.
- **N4. The NEW issue file cites line numbers that are wrong on its own branch.**
  `docs/issues/relay-forwards-undeliverable-media.md:26-27` cites
  `app/src/lib/mediaTypes.ts:65-69` for "TWILIO_DELIVERABLE_MMS_TYPES - jpeg, png
  and gif"; on HEAD those lines are `audio/mpeg, audio/mp4, audio/aac, audio/ogg,
  audio/amr` (the DECLARABLE audio types) - a citation that points at something
  contradictory. Actual location: `:210-214`. Line `:55` cites `:89-98` for
  "planMmsMedia machinery"; those lines are now inside `MEDIA_TYPE_EXTENSIONS`.
  Actual: `:234-243`. The `refs:` frontmatter (`:9`) carries the same stale
  `mediaTypes.ts:65-74`, and that field is what `npm run issues` indexes. The file
  was written against the pre-change `mediaTypes.ts` and not re-anchored after the
  same branch added 157 lines above those offsets.
- **N5. `mediaTypes.ts:1-3` still names the wrong write side.** The header says the
  allowlist is "shared by the WRITE side (webhooks/twilio.ts mirror...)". The branch
  moved that call to `services/mediaMirror.ts:104` and the branch's own issue
  amendment (`media-serve-stored-xss.md:70-72`) explicitly calls out the move - but
  the source header the issue points AT was left saying the old thing.
- **N6. `backfill-media-content-types.ts:446` cites `adapters/messaging.ts:1162-1193`
  for `createMessagingAdapter`.** On this branch it is `:1208-1238` - the branch's
  own +46 lines in that file moved it. (The other three cited anchors -
  `messagesRepo.ts:2544-2550`, `config.ts:618`, `config.ts:623-629`,
  `groupConversations.ts:322-329` - all check out.)
- **N7. Every repaired row writes its pointer rows twice.** The backfill calls
  `putMediaPointers` explicitly (`:410`) and then `annotateMessage` calls it again
  internally (`messagesRepo.ts:2544-2549`). The explicit call is deliberate and
  correct - it is what makes the pointer failure non-swallowed - but the "WRITE
  ORDER IS LOAD-BEARING" docblock (`:13-22`) does not mention that the third write
  re-does the second, so a reader may conclude one of the two is redundant and
  delete the wrong one. One sentence.
- **N8. `raw.provider_sid` is used unguarded as the Twilio MessageSid** (`:386`).
  A row missing it produces a fetch for `messages(undefined)`, which 404s and is
  counted as `skippedTwilio404` - a silent, WRONG "Twilio aged this out". Given how
  carefully `skippedThrottled` was kept out of that bucket for exactly this reason
  (`:104-108`), a `typeof raw.provider_sid !== 'string'` guard with its own counter
  would be consistent.
- **N9. `skippedEmailRow` counts every inbound email row with attachments on every
  run, repaired or not** (the check at `:346-351` runs before any per-attachment
  predicate). Harmless, but the counter reads as "declined candidates" and is not.
- **N10. The e2e spec covers the declarable tier only.** No e2e asserts the INLINE
  tier still renders after the `Content-Disposition: inline` addition, nor that a
  script-capable object still downgrades. Both are unit-covered
  (`apiRoutes.test.ts:735-745`, `:748-758`), so this is a coverage-shape note, not a
  gap.

---

## 5. Suggested disposition

| # | Severity | Item | Cost to close |
|---|---|---|---|
| M1 | must-fix | Backfill guard misses wrong-Twilio-account (and `TWILIO_API_BASE_URL`) | ~15 lines + one RUNBOOK env line |
| M2 | must-fix | Nothing pins the dashboard type mirrors | one test, precedent at `sw/mirror.test.ts` |
| P1 | plausible | Backfill lost-update on concurrent mirror append | condition expression, or a RUNBOOK caveat |
| P2 | plausible | csv/docx/xlsx are newly OS-actionable from untrusted senders | a written decision, or drop 3 types |
| P3 | plausible | Relay fan-out claim in the new issue is asserted, not verified | reword the issue |
| N1-N10 | nit | see above | small |
