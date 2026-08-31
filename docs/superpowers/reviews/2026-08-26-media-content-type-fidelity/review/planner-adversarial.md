# Adversarial post-merge review - feat/media-content-type-fidelity (e3a97e77)

Range reviewed: `git diff 3c2962a4...e3a97e77` (42 files), plus whole-repo greps for
every other reader/writer/forwarder of stored media types and filenames.
No test suites were run and no servers were started.

## Verified negatives (stated so nobody re-derives them)

- **The resolved stored-XSS issue (`docs/issues/media-serve-stored-xss.md`) is NOT
  re-opened.** The serve gate still runs on the S3 OBJECT's type
  (`app/src/routes/api.ts:2296`), the essence match cannot admit a script-capable
  type (`text/html; charset=x` has essence `text/html`, which is in neither set -
  `app/src/lib/mediaTypes.ts:176-187`), the declarable tier is `attachment`-only
  (`api.ts:2301`), and `nosniff` + `default-src 'none'; sandbox` are still set
  unconditionally (`api.ts:2303-2304`). The write side still collapses
  script-capable types (`app/test/mediaMirror.test.ts` "still collapses a
  script-capable sender type at rest"; `app/test/inboundEmail.test.ts` "still
  stores an inbound text/html attachment as octet-stream").
- **The backfill's index derivation is correct**, and this was the easiest thing
  to get wrong. `media_attachments` is a compacted successes-only list the
  deferred `media.mirror` job APPENDS to (`app/src/jobs/mediaMirror.ts:148-158`),
  so array position != media index. The script derives the index from the S3 key
  (`app/scripts/backfill-media-content-types.ts:217-221, 483`) and merges by
  `s3Key` (`:546-581`). Both are right, and both are tested.
- **Header injection through `Content-Disposition` is closed.** `filename=` is
  stripped of CR/LF/NUL/quote/backslash (`app/src/lib/mediaFilename.ts:208`) on
  top of a sanitizer that already removed them (`:51-52`); `filename*` is
  percent-encoded end to end with a `URIError` catch for lone surrogates
  (`:119-128`).

---

## 1. [HIGH] A mistyped `--dry-run` silently performs the live production apply

**What is wrong.** The dry-run switch is a bare substring test over argv with no
validation of unrecognised arguments:

```ts
const dryRun = process.argv.includes('--dry-run');
```
`app/scripts/backfill-media-content-types.ts:713`

Anything that is not the exact literal `--dry-run` is silently ignored and the
run proceeds in APPLY mode. There is no confirmation pause - RUNBOOK.md's own
step 2 says so verbatim ("The script has no confirmation pause, so this line is
the environment check") - and the start-of-run log line that names the target
(`:773-782`) is printed identically for both modes, differing only by a `dryRun`
field an operator reading a wall of JSON is not being asked to check at that
moment (the RUNBOOK tells them to check `table`, `mediaBucket` and `appEnv`).

**Failing scenario.** Operator, on prod credentials, types
`npx tsx app/scripts/backfill-media-content-types.ts --dryrun` (or `--dry_run`,
or `-n`, or puts the flag before a `--` the shell eats). `process.argv` does not
contain `--dry-run`, so `dryRun === false`. The script immediately begins
mutating the production media bucket (`:405`) and the production messages table
(`:583-586`) with no further gate. The intended "read-only rehearsal, then read
the report, then apply" sequence the whole design rests on
(`:44-47`, RUNBOOK steps 2-4) is skipped in one keystroke.

**Why it matters.** This is the one guard the entire ops procedure is built
around, and it fails open. The fix is three lines: reject any argv entry that is
not `--dry-run`, and exit 1 naming it.

---

## 2. [HIGH] One S3 failure aborts the whole run, wedges every future run, and lets three workers keep mutating production after the "PARTIAL" report is logged

**What is wrong.** `repairAttachment` calls `mediaStore.setContentType` with no
error handling at all:

```ts
if (!dryRun) await mediaStore.setContentType(candidate.s3Key, canonical);
```
`app/scripts/backfill-media-content-types.ts:405`

The justifying comment immediately above it (`:400-404`) is factually wrong:

> "at this point the credentials and the bucket have already been proven by the
> account guard, so a failure here is systemic rather than per-object"

`assertHousingChoiceAccount()` (`:741`) proves an AWS ACCOUNT. It proves nothing
about whether a given key exists, and `setContentType` is the only method on
`S3MediaStore` with no 404 handling - `getStream` (`app/src/adapters/mediaStore.ts:212-220`)
and `head` (`:257-265`) both explicitly degrade `NoSuchKey`/`NotFound`/404 to
`undefined`. So an absent object is a hard, per-object abort dressed up as a
systemic one.

Three consequences, in increasing order of badness:

**(a) Permanent wedge.** The throw propagates out of `drain` -> `scanAndRepair`
-> `backfillMediaContentTypes` (`:309-318`) -> `main().catch` -> exit 1. Every
subsequent run rescans from the top, reaches the same object, and aborts at the
same point. Every row after it in the scan is unreachable forever. This is
EXACTLY the wedge the authors reasoned about and deliberately avoided for the
foreign-account case - "a first-mismatch abort would let one permanently-
unrepairable imported row wedge every future run" (`:501-511`, `:616-620`) - and
then left wide open one function away.

**(b) Mutation continues after the abort is reported.** `drain` is
`await Promise.all(Array.from({ length: workerCount }, ...))` (`:414-427`) with
`VENDOR_CONCURRENCY = 4` (`:113`). `Promise.all` rejects on the first worker's
throw, but the other three workers are not cancelled - they keep pulling from
`cursor` and keep calling `setContentType` against the production bucket. The
`logger.error({ ...result }, '... PARTIAL result ...')` at `:313-316` spreads a
SNAPSHOT taken while those workers are still running, so the numbers the RUNBOOK
tells the operator to read ("Read the PARTIAL line") understate what the run
actually did to S3. That is precisely "a partial failure that is invisible".

**(c) A second failure loses the report entirely.** Under Node 24's default
`--unhandled-rejections=throw`, a rejection from one of the orphaned workers is
an unhandled rejection and terminates the process. If it lands before or during
the PARTIAL log, the operator gets a stack trace and zero numbers - the exact
outcome the wrapper at `:274-289` exists to prevent.

**Failing scenario.** Prod messages table contains a row whose
`media_attachments[0].s3Key = media/c1/MM1/0` but whose S3 object is absent (an
object removed by hand, an object that predates a bucket rename, or a run where
`MEDIA_BUCKET` names the sibling environment's bucket - the key shapes are
identical across dev and prod, so this is not hypothetical). Twilio answers
`video/mp4`. `CopyObject` throws `NoSuchKey`. Run aborts at that attachment;
three sibling workers finish re-typing whatever they had already claimed; the
PARTIAL report undercounts them; every re-run dies at the same key.

**Fix shape.** Treat a `NoSuchKey`/404 from `setContentType` as a counted skip
(`skippedObjectMissing`), same as `skippedTwilio404`. Keep genuine auth/5xx
propagation, but drain the remaining workers before rethrowing (settle, then
throw) so the report is accurate.

---

## 3. [MEDIUM] The lost-update race is closed on the backfill's side only - the media.mirror job silently reverts committed repairs, and `written` still reports them as done

**What is wrong.** The backfill goes to real trouble to re-read the row
immediately before writing and merge by `s3Key` (`:556-586`), explicitly to
survive a concurrent `media.mirror` append. But the JOB does the symmetric
read-modify-write and nobody narrowed ITS window:

```ts
const current = await messages.getByTsMsgId(payload.conversationId, payload.tsMsgId);
const existing: MediaAttachment[] = current ? mediaAttachmentsOf(current) : [];
...
await messages.annotateMessage(payload.conversationId, payload.tsMsgId, { mediaAttachments: merged });
```
`app/src/jobs/mediaMirror.ts:149-158`

`annotateMessage` SETs `media_attachments` wholesale with no condition
(`app/src/repos/messagesRepo.ts:2506-2527`). So if the backfill's
`annotateMessage` (`:584`) commits between the job's `getByTsMsgId` and the job's
`annotateMessage`, the job writes back the STALE `application/octet-stream`
values it read, silently reverting the repair - and re-writes the pointer rows to
match (`messagesRepo.ts:2544-2549`).

**Why it matters.** `result.written += applied` (`:587`) counts the backfill's
commit, so the report claims N attachments repaired when some subset was
immediately undone. It self-heals on the NEXT run - but the operator has no
signal to run again, because the report said the work was done and RUNBOOK step 5
only asks them to eyeball ONE attachment. The RUNBOOK's mitigation ("a quiet
window remains the belt-and-braces choice") is advisory prose, not a gate.

**Failing scenario.** Inbound MMS with 2 attachments lands; attachment 1 fails
transiently, so `media.mirror` is deferred with a +2min rung. The operator starts
the backfill 100 seconds later. The job wakes, reads the row (both entries
octet-stream), fetches media, and is about to write. The backfill repairs
attachment 0 to `video/mp4` and commits. The job then writes its merged list -
built from its stale read - and attachment 0 is `application/octet-stream` again.
The S3 object still says `video/mp4`. Report says `written: 1`.

**Fix shape.** Give `annotateMessage`'s media write an optimistic condition (a
version attribute), or have the backfill re-verify the row after
`annotateMessage` and count a revert.

---

## 4. [MEDIUM] The OPAQUE tier hands the sender an OS-actionable extension for bytes whose declared type we refused - and the filed issue's proposed mitigation is a no-op

**What is wrong.** `extFor` keeps a stored extension on the opaque tier when it
is a member of `ACCEPTED_EXTENSIONS`:

```ts
if (resolved.tier === 'opaque' && stored !== undefined && isAcceptedExtension(stored.ext)) {
  return stored.ext.toLowerCase();
}
```
`app/src/lib/mediaFilename.ts:181-183`

`ACCEPTED_EXTENSIONS` (`app/src/lib/mediaTypes.ts:136-141`) contains `.csv`,
`.xlsx`, `.docx`, `.txt` and `.pdf` - all double-click-actionable. The opaque
tier is exactly where a type we REFUSED lands: `text/html`, `image/svg+xml`, and
every unknown type are normalized to `application/octet-stream` at store time
(`mediaTypes.ts:207-209`). The stored filename on that same attachment is the
sender's, persisted verbatim by `app/src/services/inboundEmail.ts:681-686`.

So the sender picks the extension from a 27-member set, on bytes whose declared
type we specifically decided we could not trust. That contradicts the module's
own stated rule 1 - "The extension is always chosen from one of our own closed
sets... the point of this feature is a name the operating system ACTS ON, which
is precisely why the sender must not choose it" (`mediaFilename.ts:6-11`) - and
it is pinned as intended behavior by
`app/test/apiRoutes.test.ts` ("keeps a recognised stored extension when the type
is unrecoverable", `budget.xlsx` on an octet-stream object) and
`app/test/mediaFilename.test.ts:41-45`.

**This invalidates the remediation recorded in the branch's own issue.**
`docs/issues/declarable-office-doc-types-double-click.md` proposes: "Drop
`text/csv`, `.docx` and `.xlsx` back to the OPAQUE tier. They keep their stored
extension there anyway... so the cost is the Content-Type header and the timeline
kind word, not the filename." That fix changes nothing about the risk it is
filed against, and the issue's own bounded-exposure argument is scoped to three
DECLARABLE types when the actual exposure is any attachment with a recognised
stored extension, declared type irrelevant.

**Failing scenario.** Attacker emails the intake address a part declared
`Content-Type: text/html` (or any garbage type) with
`filename="Q3 Reconciliation.csv"` and a CSV formula/DDE payload as the body.
Stored: `contentType: application/octet-stream`, `filename: Q3 Reconciliation.csv`
(`inboundEmail.ts:677-686`). Served: `Content-Type: application/octet-stream;
Content-Disposition: attachment; filename="Q3 Reconciliation.csv"`
(`api.ts:2296-2302`). Pre-branch the same attachment was
`attachment; filename="attachment-0"` and inert on a double-click.

---

## 5. [MEDIUM] `getMediaContentType`'s "degrade rather than crash" reintroduces the exact green-exit catastrophe the script's guard exists to prevent

**What is wrong.**

```ts
if (typeof (this.client as { messages?: unknown }).messages !== 'function') return undefined;
```
`app/src/adapters/messaging.ts:941`

The backfill's own header spends 8 lines (`:49-56`) on the rule that "a
misconfigured run would therefore report 'every attachment aged out', write
nothing, and EXIT GREEN - the worst outcome". `messagingMisconfiguration`
(`:689-703`) enforces `messagingDriver === 'twilio'` and the credential set - but
nothing anywhere checks that the CONSTRUCTED client actually exposes a callable
`messages`. That check was added for test fakes and it silently covers a real
client too.

**Failing scenario.** The `twilio` SDK is upgraded and `client.messages` becomes
a lazily-initialised getter returning an object rather than a callable (or the
resource moves under `client.api.v2010`). Every guard passes: driver is twilio,
all six keys are set, neither base-URL override is present, the account guard
passes. `getMediaContentType` returns `undefined` for every attachment.
`skippedTwilio404` equals `eligible`, `recovered` is `{}`, the script logs a WARN
("Expected once every repairable attachment is done", `:800-813`) and exits 0.
That is indistinguishable from a completed repair - the precise outcome the whole
guard block was written to make impossible.

**Fix shape.** In the ops path, make the shape mismatch a THROW rather than an
`undefined`, and keep the tolerant degrade behind the test seam - or probe one
candidate before the scan and refuse if the vendor read is structurally
impossible.

---

## 6. [MEDIUM] The dashboard mirror ships a dead export with a test that names it, and the gallery was half-migrated

**Dead code with a test.** `isDeclarableMediaType`
(`dashboard/src/routes/contact/media.ts:113-116`) has zero production callers.
A repo-wide grep finds it only in its own definition and in
`dashboard/src/routes/contact/media.test.ts` ("isDeclarableMediaType agrees with
it - one map, two views"). A test that exercises a function nothing calls tests
the test.

**Half-migrated gallery.** `MediaGallery.tsx` was updated for the RENDER branch
(`:36`, `isInlineRenderable`) but not for the LABEL: the file tile's accessible
name and tooltip is still the raw MIME string (`title={m.contentType}`,
`MediaGallery.tsx:53`), even though `mediaKindWord` now exists for exactly that
and Timeline uses it. Because declarable types are now stored truthfully, the
gallery went from showing every non-image tile as `application/octet-stream` to
showing, for an inbound .xlsx,
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` as the link
text. The new `MediaGallery.test.tsx` PINS the raw-MIME label
(`getByRole('link', { name: 'image/heic' })`), so the regression is now enforced
by a test.

Related, and in the same file: `MediaGallery.tsx:56` and `Timeline.tsx:666` both
test `contentType === 'application/pdf'` by exact string while every other
predicate on the adjacent lines was moved to essence matching. See finding 8.

---

## 7. [MEDIUM] `mediaTypes.ts` records that the duplicated extension map "does not feed a security decision" - the sibling it points at writes a filename onto a THIRD PARTY's disk with no allowlist

**What is wrong.** The new comment at `app/src/lib/mediaTypes.ts:94-98`:

> "Duplicated by design with EMAIL_EXTENSIONS (services/sendEmailMessage.ts),
> which names an OUTBOUND MIME part rather than a download we offer. Neither
> feeds a security decision, so the divergence is cosmetic..."

The code it exonerates:

```ts
const cleanName = filename?.replace(/[\r\n]+/g, ' ').trim();
const outName = cleanName && cleanName.length > 0
  ? cleanName
  : `attachment-${i + 1}${EMAIL_EXTENSIONS[contentType] ?? '.bin'}`;
attachments.push({ filename: outName, contentType, content: bytes });
```
`app/src/services/sendEmailMessage.ts:334-340`

When a client-supplied filename IS present, `EMAIL_EXTENSIONS` is not consulted
at all and `cleanName` is the name. `cleanName` strips CR/LF only. It applies
none of the eight rules this branch just wrote for the inbound half
(`mediaFilename.ts:49-70`): no path-separator or traversal removal, no
`<>:|?*` removal, no BiDi-control removal, no reserved-device-name check, no
length cap, and - the point - no extension allowlist. `.exe`, `.ps1`, `.lnk` and
`.html` all pass. That name goes into the outbound MIME part and lands on the
RECIPIENT's filesystem, and is also persisted onto `media_attachments.filename`
(`:344`).

**Why it matters.** The source is an authed staff user, so the exposure is
smaller than the inbound path - but "smaller" is not "not a security decision".
The branch hardened one half of a symmetric problem and then wrote down, in the
file that is now the canonical reference for filename policy, that the other half
does not matter. The next reader will believe it. Either apply
`buildMediaFilenameParts`' rules there too, or correct the comment to say the
outbound name is deliberately unfiltered and why.

---

## 8. [LOW] Server tier gate and both dashboard render sites disagree on PDF

`resolveMediaTier` matches on the essence (`mediaTypes.ts:176-187`) and
`isInlineRenderable`/`mediaKindWord` mirror that (`media.ts:62-64, 102-109`), but
the PDF test at both render sites is an exact string compare:

- `dashboard/src/routes/contact/Timeline.tsx:666` - `att.contentType === 'application/pdf'`
- `dashboard/src/routes/contact/MediaGallery.tsx:56` - `m.contentType === 'application/pdf'`

For an object stored before the 2026-06-18 normalize fix (which is the exact
population this feature exists to serve, per `api.ts:2292-2294`), a stored
`application/pdf; charset=binary` makes the server serve it INLINE as a PDF while
the timeline shows it as an unknown clip-icon "Attachment N" with no kind word -
`mediaKindWord` returns undefined because PDF is on the inline tier, not the
declarable map. Two readers, one type, opposite conclusions. Use `essenceOf`.

---

## 9. [LOW] `canonical` is the caller-derived essence, not the allowlist constant - and the security argument on record says otherwise

`ResolvedMediaType.canonical` is documented as "The allowlist's OWN string -
never the caller's" (`mediaTypes.ts:147`), and `docs/issues/media-serve-stored-xss.md:57-61`
records the safety argument as "the resolver returns the allowlist's own
constant, so a caller-supplied parameterized string never reaches a response
header." What the code returns is the string it derived from the caller:

```ts
const essence = raw.split(';')[0]!.trim().toLowerCase();
...
return { tier, canonical: essence, ext: MEDIA_TYPE_EXTENSIONS.get(essence) ?? '.bin' };
```
`mediaTypes.ts:178, 186`

It is provably equal to a set member today, because `Set.has` is exact. It stops
being equal the moment anyone loosens the match - a case-folding lookup, a
Unicode-normalising compare, a prefix or suffix test, a `Map` keyed on a
normalised form. At that point `res.setHeader('Content-Type', resolved.canonical)`
(`api.ts:2298`) becomes a passthrough of attacker-controlled text into a response
header, and the written-down argument will still say it cannot be. Return
the set member (or a lookup into a canonical Map) so the comment and the issue
are literally true.

---

## 10. [LOW] The backfill Scan pulls every message BODY in the table onto the operator's laptop

```ts
new ScanCommand({
  TableName: table,
  FilterExpression: 'attribute_exists(media_attachments) OR attribute_exists(media_s3_keys)',
  ...
})
```
`app/scripts/backfill-media-content-types.ts:432-441`

No `ProjectionExpression`. A DynamoDB `FilterExpression` is applied AFTER the
read, so every page transfers full items - bodies, phone numbers, email
addresses - for the entire messages table, and pays RCU for all of it. The script
needs six attributes (`conversationId`, `tsMsgId`, `provider_sid`, `direction`,
`mediaUrls`, `media_attachments`, plus `media_s3_keys` for the legacy counter).
This sits directly under a header that says "PII: logs COUNTS and IDs only" -
true of the logs, misleading about the process.

---

## 11. [LOW] Scan pagination is never exercised

`app/test/backfillMediaContentTypes.test.ts:92` -
`const doc = { send: vi.fn().mockResolvedValue({ Items: opts.rows }) };` - never
returns a `LastEvaluatedKey`. So the `do { ... } while (exclusiveStartKey !== undefined)`
loop (`:430-604`), the `ExclusiveStartKey` forwarding (`:440`), and the per-page
reset of `rows`/`candidates` (`:444-445`) are all single-iteration only in every
test. A filtered Scan routinely returns pages with zero `Items` and a
`LastEvaluatedKey`; nothing in the suite covers that shape, nor the
cross-page accumulation of `nativeAccountCandidates` that the wrong-credentials
backstop (`:621-629`) depends on.

---

## 12. [LOW] `MediaContentType{i}` is read at the COMPACTED index while the branch documents the compaction one line away

`parseInboundMediaUrls` skips absent/empty `MediaUrl{i}` entries
(`app/src/routes/webhooks/twilio.ts:439-447`), but the mirror targets pair each
compacted URL with `params[`MediaContentType${index}`]` using the COMPACTED index:

```ts
const targets: MediaMirrorTarget[] = mediaUrls.map((url, index) => ({
  ...
  contentType: params[`MediaContentType${index}`],
```
`app/src/routes/webhooks/twilio.ts:486-489`

If Twilio ever posts a sparse set, the wrong declared type is stored against the
right object. Pre-existing, and unlikely in practice - but the backfill's
docstring (`backfill-media-content-types.ts:208-215`) calls out this exact
compaction to justify its own index derivation and then leaves the sibling defect
untouched. Worth a one-line fix or an explicit note, because the backfill now
silently CORRECTS such rows from Twilio, which would make the underlying bug
harder to ever observe.
