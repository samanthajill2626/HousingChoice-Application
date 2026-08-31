# Plan review R1-B (adversarial) - media content-type fidelity

Plan: `docs/superpowers/plans/2026-08-26-media-content-type-fidelity.md`
Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
Repo read-only at `W:\tmp\media-content-type-fidelity` (branch `main`).

Question answered: if a builder with NO context executes this LITERALLY, do they
produce the spec?

Short answer: no. The architecture is right and most of the enumeration work is
genuinely done and correct (I verified nine of the plan's file:line citations and
all nine held). But Task 2's pasted implementation contradicts Task 2's pasted
tests in FOUR places, Task 5's pasted Twilio driver does not compile against the
repo's own `TwilioClientLike`, Task 6's fixtures cannot match Task 6's own regex,
and three of the four "use the file's existing harness" instructions name helpers
that do not exist. A builder who trusts the code blocks - which is what pasted
code is for - burns the whole first pass on tests that cannot go green.

---

## 1. [BLOCKING] Task 2: `'../../etc/passwd'` cannot produce `etcpasswd.mp4` - split runs before sanitize

**What is wrong.** Task 2 Step 1 asserts

```ts
expect(buildMediaFilename('../../etc/passwd', 0, MP4)).toBe('etcpasswd.mp4');
```

Task 2 Step 3's implementation calls `splitName` FIRST, and `splitName` splits at
`lastIndexOf('.')`. For `../../etc/passwd` that dot is at index 4, so
`stem = '../.'` and `ext = './etc/passwd'`. `sanitizeStem('../.')` then removes
`/` -> `'...'`, removes `..` -> `'.'`, strips trailing dots -> `''`. Empty stem ->
`usable === false` -> `stem = 'attachment-1'`. The function returns
`attachment-1.mp4`, not `etcpasswd.mp4`.

`etcpasswd.mp4` is the answer you get from sanitize-THEN-split. The plan's own
ordering (spec 6.3 "The stored `attachments[idx].filename`, split as above,
sanitized as below") is split-then-sanitize. Test and implementation encode
opposite orders.

**Evidence.** Plan lines 509 (assertion), 599-603 (`splitName`), 610-623
(`sanitizeStem`), 635-638 (call order). Spec 6.3 "SPLITTING A STORED NAME" and
"STEM, in order".

**What it implies.** Worse than a plain red test: Task 2 Step 4 says *"If
`'../../etc/passwd'` does not produce `etcpasswd.mp4`, work out which rule fired
in which order before changing anything - the ORDER in `sanitizeStem` is
deliberate."* The plan pre-emptively tells the builder the implementation is
right, so the likely repair is to weaken the assertion rather than fix the
traversal handling - and traversal handling is the security rule this function
exists for. Decide which order is normative and make the spec, the impl and the
test agree.

---

## 2. [BLOCKING] Task 2: `splitName('.env')` returns the whole name as the STEM, contradicting its own docblock and the test

**What is wrong.**

```ts
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  ...
```

For `.env`, `dot === 0`, so the `dot <= 0` branch fires and returns
`{ stem: '.env', ext: '' }`. `sanitizeStem('.env')` leaves `.env` intact (a
LEADING dot is not touched by any rule - only trailing dots are stripped), the
stem is usable, and the result is `'.env.mp4'`.

The test in the same task asserts `'attachment-1.mp4'` (plan line 500). The
function's OWN docblock four lines above says "A name whose only dot is leading
(`.env`) is all extension and has an EMPTY stem" (plan lines 596-598), and spec
6.3 says the same. The `dot === 0` case needs `{ stem: '', ext: name }`; the code
lumps it in with `dot === -1`.

**Evidence.** Plan lines 596-603 (docblock + code), 499-501 (test). Spec 6.3
paragraph "SPLITTING A STORED NAME".

**What it implies.** Red test with a one-character cause the builder will not find
quickly, because the docblock asserts the correct behavior. Also a live defect if
the test is "fixed" instead: a dotfile-named MIME part would ship a filename with
a leading dot and a doubled extension.

---

## 3. [BLOCKING] Task 2: the "all underscores" rule from spec 6.3 is missing from the implementation, so the wholly-non-ASCII test fails

**What is wrong.** Test (plan line 526):

```ts
expect(buildMediaFilename('\u4f60\u597d', 0, XLSX)).toBe('attachment-1.xlsx');
```

Implementation: `sanitizeStem` replaces every non-ASCII codepoint with `_`, giving
`'__'`. `usable` is then `rawStem.length > 0 && !SYNTHESIZED.test(rawStem)` -
`'__'` is length 2 and does not match `^attachment-\d+$`, so it IS usable. Result:
`'__.xlsx'`.

Spec 6.3 states the missing rule explicitly: *"If the ASCII stem is empty or all
underscores after that, use the synthesized stem instead, so the ASCII parameter
is always a usable name."* The plan never implements it.

**Evidence.** Plan lines 617 (`_` replacement), 636-638 (`usable`), 526
(assertion). Spec 6.3 "NON-ASCII" bullet 2.

**What it implies.** A spec decision is delivered only by the test, not by the
code - i.e. not delivered. Red on paste.

---

## 4. [BLOCKING] Task 2: `'a\r\nb'` -> the implementation gives `ab.mp4`, the test demands `a b.mp4`

**What is wrong.** `sanitizeStem`'s first verb is
`s.replace(/[\r\n\0"\\]/g, '')` - CR and LF are REMOVED, not replaced with a
space. `'a\r\nb'` becomes `'ab'`; the whitespace-collapse rule then has nothing to
collapse. The test asserts `'a b.mp4'` (plan line 510).

Spec 6.3's sanitization list agrees with the implementation ("1. remove CR, LF,
NUL, `"` and `\`" ... "3. collapse runs of whitespace to one space"), so here the
TEST is the wrong half.

**Evidence.** Plan lines 611 (impl), 510 (assertion). Spec 6.3 "STEM
SANITIZATION, in this exact order", rules 1 and 3.

**What it implies.** Third red test in one task from a pasted contradiction.
Cumulatively (findings 1-4) four of Task 2's fourteen assertions cannot pass
against Task 2's own code, and Task 2 is a "pure function, fully specified" task -
exactly the shape a builder trusts most.

---

## 5. [BLOCKING] Task 5: `this.client.messages(messageSid).media(mediaSid)` does not compile - `TwilioClientLike.messages` is not callable

**What is wrong.** The pasted Twilio driver body is

```ts
const media = await this.client.messages(messageSid).media(mediaSid).fetch();
```

`TwilioMessagingDriver.client` is typed `TwilioClientLike`
(`app/src/adapters/messaging.ts:574`), and `TwilioClientLike.messages` is declared
as a plain object with ONE member:

```ts
export interface TwilioClientLike {
  messages: {
    create(params: {...}): Promise<{ sid: string; status: string; dateCreated: Date | null }>;
  };
```

(`app/src/adapters/messaging.ts:390-399`). It has no call signature, so
`this.client.messages(messageSid)` is TS2349 ("This expression is not callable").
Note the interface DOES model a callable-plus-statics hybrid elsewhere -
`incomingPhoneNumbers` at `:426-438` has both `create`/`list` members and a
`(sid: string): {...}` call signature - so the repo knows the pattern, and the
plan simply does not apply it or mention that `TwilioClientLike` must be widened.

Corroborating signal that this is a real gap and not a typing nicety: the existing
`getMediaStream` on the same driver does NOT use the SDK at all
(`messaging.ts:913-914` delegates to `fetchTwilioMediaStream`, a raw fetch), so
there is no precedent in this file for reaching Twilio media through
`this.client`.

**Evidence.** `app/src/adapters/messaging.ts:390-399`, `:426-438`, `:574`,
`:913-914`. Plan Task 5 Step 4.

**What it implies.** Task 5 cannot typecheck as written, and the fix is a
non-trivial interface change (widening `messages` to a callable hybrid) that
touches the four exhaustive `MessagingAdapter`/client fakes the plan already warns
about - plus every fake that supplies a `messages` object literal. This is a
sizing miss, not a typo. It also needs a decision the plan never makes: SDK
resource fetch vs a raw `fetch` of the media resource URL, consistent with how
`getMediaStream` already works.

---

## 6. [BLOCKING] Task 6: the fixture MediaSids `ME_ZERO` / `ME_ONE` cannot match Task 6's own `parseMediaSid` regex

**What is wrong.** Step 1's shared fixtures:

```ts
const URL0 = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME_ZERO';
const URL1 = '.../Media/ME_ONE';
```

Step 3 item 4 specifies:

> `parseMediaSid(url: string): string | undefined` - matches
> `/Media/(ME[0-9a-f]+)` case-insensitively.

`ME_ZERO` is `ME` followed by `_`. `[0-9a-f]+` requires at least one hex
character and `_` is not one, so the pattern does not match anywhere in the URL.
`parseMediaSid` returns `undefined` for BOTH fixtures.

Consequences inside the same task: `'derives the media index from the S3 KEY'`
(expects `getMediaContentType` called with `('MM1','ME_ONE')`) fails;
`'writes S3, then pointers, then the row'` fails; `'writes the row ONCE for a
two-attachment message'` fails; `'never writes a type the runtime would refuse'`
fails; `'skips an attachment whose media Twilio no longer has'` fails; the dry-run
histogram test fails. Every row is instead counted as `skippedNoUrl` (or whatever
bucket an unparseable SID lands in - which the plan also never names; see finding
16).

**Evidence.** Plan lines 1250-1251 (fixtures), 1436-1437 (regex spec), 1324, 1331,
1343-1345, 1354-1355, 1376-1378, 1408-1412 (the assertions that depend on a
successful parse).

**What it implies.** Ten of thirteen backfill tests are red on paste for a reason
unrelated to any behavior under test. Real Twilio MediaSids are `ME` + 32 hex, so
the honest fix is hex fixtures; but note that also removes the readability the
fixture names were chosen for, and the "index came from the KEY not the position"
assertion then has to compare two hex strings - worth designing deliberately
rather than patching.

---

## 7. [BLOCKING] Task 5: the `MediaStore.setContentType` tests assume a live-S3 round-trip harness that `app/test/mediaStore.test.ts` does not have

**What is wrong.** Task 5 Step 1 says "add to `app/test/mediaStore.test.ts`, using
the file's existing MinIO/localstack harness" and then writes

```ts
await store.put('media/c1/MM1/0', Readable.from(Buffer.from('hello')), 'application/octet-stream');
await store.setContentType('media/c1/MM1/0', 'video/mp4');
const head = await store.head('media/c1/MM1/0');
expect(head?.contentType).toBe('video/mp4');
const bytes = await store.getBytes('media/c1/MM1/0');
expect(bytes?.toString()).toBe('hello');
```

There is NO such harness. `app/test/mediaStore.test.ts` is 139 lines and entirely
hermetic: it asserts factory gating (`:11-26`), constructs `S3MediaStore` over a
locally-signing client for `presign`/`createPresignedPost` (`:55-61`, `:77-82`,
both explicitly commented "no network" / "no S3 round trip"), and tests `head`
against a hand-rolled `{ send: async () => ({ ContentType: ... }) }` fake
(`:108-139`). There is no `store` in scope, no MinIO, and no put/get round trip
anywhere in the file. `npm test` requires DynamoDB Local, not S3/MinIO
(AGENTS.md's gate section), so a test that needs a real bucket would be a new
infrastructure dependency for the unit suite.

Step 2's stated red state - "FAIL - `store.setContentType` is not a function" - is
also wrong: the failure would be `store is not defined`.

**Evidence.** `app/test/mediaStore.test.ts:1-3` (header states the real streaming
path is exercised in e2e, "here we only assert the factory's gating"), `:55-61`,
`:77-82`, `:110-117`. Plan Task 5 Step 1-2.

**What it implies.** The builder must invent a harness the plan says already
exists, and the obvious cheap version (a fake `send` recorder) tests nothing about
`CopyObject`'s same-key `MetadataDirective: REPLACE` semantics - which is the ONE
thing this method's correctness rests on (spec 6.7). Either commit to a
command-shape assertion against a fake client (honest, matches the file) or state
that the real behavior is proven in e2e, but do not describe a harness that is not
there.

---

## 8. [BLOCKING] Task 3: `getMedia({ storedContentType, filename })` does not exist, and the harness the plan points at cannot express either argument

**What is wrong.** All seven Task 3 tests call a helper `getMedia` with a
`storedContentType` and (twice) a `filename`. The plan says "following the file's
existing harness setup for a mirrored attachment (reuse whatever helper the
neighbouring tests use to seed a message + a stored object; do not invent a new
one)".

`app/test/mmsMedia.test.ts`'s only helper is

```ts
async function seedMms(world: FakeWorld) {
  const { app } = makeWebhookHarness({ world });
  await signedTwilioPost(app, '/webhooks/twilio/sms', inboundMmsParams());
  return app;
}
```

(`:204-209`). It drives a real inbound webhook. That means:

- the object's Content-Type is whatever `normalizeStoredMediaType` produced, so
  `storedContentType: 'text/html'` and `storedContentType: 'application/x-made-up'`
  CANNOT be placed at rest - they are normalized on the way in (see finding 18);
- `filename` is impossible entirely. `mirrorMediaSet` builds
  `{ s3Key, contentType }` and never sets `filename`
  (`app/src/services/mediaMirror.ts:110`), and `MediaAttachment.filename` is
  documented as "MMS/inbound/legacy attachments have none"
  (`app/src/repos/messagesRepo.ts:808-814`).

The harness that CAN do all of this already exists one file over:
`app/test/apiRoutes.test.ts` has `makeMediaApp({ message, object })`, which takes
the message's `media_attachments` array AND the S3 object's `contentType`
independently (`app/test/apiRoutes.test.ts:640-670`). The plan touches that file
in Step 5 for two line edits and never notices it is the right home for Step 1.

**Evidence.** `app/test/mmsMedia.test.ts:204-209`, `:211-234`;
`app/test/apiRoutes.test.ts:635-670`; `app/src/services/mediaMirror.ts:104-110`;
`app/src/repos/messagesRepo.ts:797-815`. Plan Task 3 Step 1.

**What it implies.** Task 3's entire red-first step is unwritable as specified,
and the instruction "do not invent a new one" actively blocks the correct move.
Move Steps 1-4 to `apiRoutes.test.ts` / `makeMediaApp`, or say explicitly which
new fixture to build.

---

## 9. [HIGH] Task 1 Step 5: the mirror test names `deps` and `putSpy`, neither of which exists

**What is wrong.** The pasted test is

```ts
const out = await mirrorMediaSet(deps, {...});
expect(putSpy).toHaveBeenCalledWith('media/c1/MM1/0', expect.anything(), 'video/mp4');
```

`app/test/mediaMirror.test.ts` has no `deps` and no `putSpy`. Its shape is
`flakyAdapter(failures, err)` + `storeSpy()` (which exposes a plain
`puts: {key, contentType}[]` array, not a vi spy), and every call site builds the
deps object inline:
`{ adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep: async () => {} }`.

The `out.attachments[0]?.attachment.contentType` shape IS right
(`MediaMirrorOutcome.attachments` is `{ index, attachment }[]`,
`app/src/services/mediaMirror.ts:60-64`).

**Evidence.** `app/test/mediaMirror.test.ts:22-50`, `:76-90`;
`app/src/services/mediaMirror.ts:59-64`. Plan Task 1 Step 5.

**What it implies.** "Using the file's existing harness" is false, so the builder
must reconstruct it. Low risk of a wrong OUTCOME, high risk of wasted time and of
the builder assuming other harness claims in the plan are equally approximate.

---

## 10. [HIGH] Task 1 Step 5: the inbound-email test invents `ingestWithAttachment` and reads the wrong property name

**What is wrong.**

```ts
const stored = await ingestWithAttachment({ filename: 'lease.docx', contentType: '...' });
expect(stored.media_attachments?.[0]?.contentType).toBe('...');
```

`app/test/inboundEmail.test.ts` has no `ingestWithAttachment`. Its pattern is
`makeWorld({...})` returning `{ deps, put, appended, ... }`, then
`await ingestInboundEmail(notice(), w.deps)`, then assertions against
`w.appended[0]!.mediaAttachments` - CAMEL case, because `appended` records the
repo's `append` INPUT, not a stored DynamoDB row. Compare the file's own existing
assertion:

```ts
expect(w.appended[0]!.mediaAttachments).toEqual([
  { s3Key: keys[0], contentType: 'application/pdf', filename: 'lease agreement.pdf' },
  { s3Key: keys[1], contentType: 'application/octet-stream', filename: 'weird.bin' },
]);
```

(`app/test/inboundEmail.test.ts:987-988`).

**Evidence.** `app/test/inboundEmail.test.ts:280-284` (the `put`/`mediaStore`
seam), `:975-988`, `:1011-1021`. Plan Task 1 Step 5.

**What it implies.** Same as 9, plus a wrong property name that fails silently as
`undefined` rather than as a compile error under `?.`.

Positive note for the same step: I checked every existing assertion the widening
could move. `mmsMedia.test.ts:159-169` (`text/html` -> octet-stream) and
`inboundEmail.test.ts:975-988` (`application/x-weird` -> octet-stream) both stay
green, and `inboundEmail.test.ts:1011-1021` uses `text/plain` but only counts
`put` calls. So the plan's "an existing assertion may now be WRONG by design"
warning is correct to include and, as far as I can find, fires on nothing.

---

## 11. [HIGH] Task 6: the account guard is decorative - the clients are still built from the default (wrong) credential chain

**What is wrong.** Step 3 item 10 adds

```ts
const identity = await assertHousingChoiceAccount();
```

to a CLI wrapper "copying `backfill-media-pointers.ts`'s `invokedDirectly` shape".
`backfill-media-pointers.ts` builds its client with `getDocumentClient()`
(`app/scripts/backfill-media-pointers.ts:23,47`), which resolves the DEFAULT AWS
credential chain. The plan never says to build the doc client, the media store or
the messaging adapter from `hcCredentials()` / `HC_REGION`, and never says how
`mediaStore` and `adapter` are constructed for a real run at all (Step 1 only
covers injecting fakes for the test).

The cited precedent does it properly: `app/scripts/import-apply.ts` takes an
explicit `--env local|dev|prod` and resolves clients from `hcCredentials()` for
the AWS stages, with the guard first - its header states "the default credential
chain on this machine belongs to an UNRELATED account and is never used"
(`app/scripts/import-apply.ts:10-16, 30-34`). The plan copies the guard and drops
the plumbing that makes the guard mean something.

**Evidence.** `app/scripts/import-apply.ts:10-16`, `:26-34`;
`app/scripts/backfill-media-pointers.ts:12-24`, `:47`; `scripts/lib/hcAws.mjs:30`
(`hcCredentials`), `:39` (`assertHousingChoiceAccount`). Spec 6.6 "PRECEDENT,
SPLIT DELIBERATELY" and spec 10 "Operator requirements". Plan Task 6 Step 3
item 10.

**What it implies.** A guard that asserts account A while the writes go to
whatever the ambient chain resolves is worse than no guard: it manufactures
confidence. This script performs THREE destructive writes against production
(S3 CopyObject, pointer puts, message row update) and spec 11 says two of the
three are unrecoverable. The credential resolution needs to be an explicit,
tested part of Task 6.

---

## 12. [HIGH] Task 6: the "row write fails" test cannot pass - nothing catches the throw

**What is wrong.**

```ts
const first = await run({ rows: [inboundRow()], annotateFails: true });
expect(first.result.written).toBe(0);
```

The harness's fake `annotateMessage` throws (`plan:1291`). Step 3's structure
(items 5-8) contains no try/catch and no per-row error accounting; item 8 is a
bare "`putMediaPointers(...)` and THEN `annotateMessage(...)`". As written the
rejection propagates out of `backfillMediaContentTypes`, `await run(...)` throws,
and the test fails with `Error: boom` instead of returning `{ written: 0 }`.

**Evidence.** Plan lines 1289-1292 (fake), 1334-1340 (test), 1449-1451 (the
implementation instruction that omits handling).

**What it implies.** Undeliverable as specified, and the underlying question -
does a failed row write abort the whole run, or count and continue to the next
row? - is a real ops decision the plan never makes. Spec 6.6's idempotency
argument ("a partial failure is repaired by re-running") implies continue-and-
count, which needs a `skippedRowWriteFailed` bucket that the reporting list in
Step 3 item 2 does not contain.

---

## 13. [HIGH] Task 5: bare `status === 404` contradicts the repo's own documented Twilio-error rule

**What is wrong.**

```ts
if ((err as { status?: number }).status === 404) return undefined;
```

This repo has already been burned by exactly this and wrote the lesson down in
code. `app/src/adapters/groupConversations.ts:708-716` carries a comment reading
"VENDOR CODES, NOT A BARE 404 (same finding). `status === 404` also..." and the
three sibling call sites all use the paired form:

```ts
if (twilioStatus(err) === 404 || twilioErrorCode(err) === '20404') return undefined;
```

(`groupConversations.ts:591`, `:611`, `:644`), with both helpers coming from
`app/src/lib/errors.ts` (see `:62`, "NUMERIC CODES COUNT (fix wave 2, adversarial
9). Twilio's `RestException`...").

The plan's own comment even names 20404 - "20404 / HTTP 404: the media is gone" -
and then does not test for it.

**Evidence.** `app/src/adapters/groupConversations.ts:591,611,644,708-716`;
`app/src/lib/errors.ts:62`. Plan Task 5 Step 4.

**What it implies.** A Twilio error shape the bare check misses becomes a THROW
that aborts the backfill mid-run, in an ops script whose whole retention story
(spec 11 risk 1) is "aged-out media is a skip, not a failure". Use the existing
helpers.

---

## 14. [HIGH] `MediaGallery` gets no test at all, and spec 9 requires one

**What is wrong.** Spec 9 says: *"Dashboard: `image/heic` renders as a file link in
BOTH `AttachmentGallery` and `MediaGallery`; `image/jpeg` still renders inline in
both."* Spec 6.4 calls both components "MUST change" and section 8 lists them as
readers 2 and 3.

Task 4 delivers: unit tests for `isInlineRenderable` / `mediaKindWord` in
`media.test.ts`, and three component tests in `Timeline.test.tsx`. Nothing renders
`MediaGallery`. There is no `MediaGallery.test.tsx` in the repo
(`dashboard/src/routes/contact/` listing confirms - `MediaGallery.module.css` and
`MediaGallery.tsx` only), so no existing file covers it either. Step 5's "Run
`cd dashboard && npx vitest run src/routes/contact/`" therefore proves nothing
about the "Media from comms" grid.

**Evidence.** `dashboard/src/routes/contact/` directory listing;
`dashboard/src/routes/contact/MediaGallery.tsx:36`. Spec 6.4, 8 (readers 2-3), 9.
Plan Task 4 Steps 1 and 5.

**What it implies.** The half of the regression the spec calls out by name - "a
photo that renders today would become a broken image ... in both the thread and
the 'Media from comms' grid" - ships with a one-line predicate change and zero
coverage. A `media.ts` unit test does not prove the component consumes it; that is
exactly the shape of the bug (`MediaGallery.tsx:36` keeping its own predicate).

---

## 15. [HIGH] Task 2 drops `filename*`, which spec 6.3 MANDATES - and mis-describes the spec as permissive

**What is wrong.** The plan's note (lines 554-560) says "the spec ALLOWS an RFC
5987 parameter alongside the ASCII one. This plan deliberately does NOT implement
it."

The spec does not allow it, it requires it:

> When the sanitized stem contained ANY non-ASCII, ALSO emit
> `filename*=UTF-8''<pct>` where `<pct>` is the UTF-8 bytes of the FULL sanitized
> stem plus extension, percent-encoded with `encodeURIComponent` and then
> additionally escaping the characters it leaves bare that RFC 5987 reserves
> (`!`, `'`, `(`, `)`, `*`).

and spec 9 lists "a non-ASCII stem produces `filename*`" as a required unit test.
`contentDispositionHeader(kind, filename)` as designed cannot emit it at all - the
signature carries only the already-transliterated ASCII name, so the un-mangled
stem is gone by the time the header is built.

**Evidence.** Spec 6.3 "NON-ASCII" bullet 3; spec 9 "Filename construction" bullet.
Plan lines 554-560, 653-659.

**What it implies.** Two problems, and the second is the expensive one. (a) A
documented spec decision is not delivered. (b) The plan tells the builder to "flag
this to the reviewer as a deliberate spec deviation" while describing the spec
inaccurately - so the reviewer is handed a pre-argued justification for a
requirement the spec did not leave optional. If the deviation is right (and the
argument for it is reasonable), amend the SPEC, do not paper over it in the plan.
Note also that the signature change needed to support `filename*` later is not
additive, so "we can add it afterwards" is not free.

---

## 16. [MEDIUM] Task 6: the `written` counter's semantics are pinned by tests but never specified

**What is wrong.** Two tests constrain `written` in ways the implementation
instructions do not describe:

- `'writes the row ONCE for a two-attachment message'` expects `written === 2`
  (per ATTACHMENT), with `annotateMessage` called once;
- `'leaves everything repairable when the row write fails'` expects `written === 0`
  even though the S3 write and the pointer write both succeeded.

So `written` counts attachments but is only committed AFTER the per-message row
write lands. Step 3's items 7-8 say nothing about deferring the increment; a
builder incrementing at step 4 (the natural reading of item 7, "else
`setContentType` and stage the corrected attachment") fails the second test.

Related: Step 3 item 2 lists eleven counters, but the plan never says which bucket
an UNPARSEABLE MediaSid lands in (item 4 defines `parseMediaSid` and item 7 says
"parse the MediaSid" with no failure branch), nor which bucket a give-up-after-429
lands in beyond item 9's "count the attachment as `skippedTwilio404`" - see
finding 20.

**Evidence.** Plan lines 1342-1347, 1334-1340, 1427-1451.

---

## 17. [MEDIUM] Task 6 cites a precedent that does not exist: there is no `backfill:media-pointers` npm script

**What is wrong.** Task 6's file list says: add
`"backfill:media-content-types": "tsx app/scripts/backfill-media-content-types.ts"`
to the root scripts block, "matching how `backfill:media-pointers` is declared".

The root `package.json` scripts block has NO backfill entries at all (I enumerated
all 51 script names; `import:apply`, `rail:verify`, `secrets:*` etc. are there,
nothing named `backfill:*`). `app/package.json` has none either. The real
invocation is direct tsx, and `RUNBOOK.md:260` documents it that way:
`npx tsx app/scripts/backfill-media-pointers.ts --dry-run`.

**Evidence.** root `package.json` scripts; `app/package.json`; `RUNBOOK.md:260`.
Plan Task 6 Files block. Spec 6.6 and 10 both refer to
`backfill:media-content-types` as if it were a script name.

**What it implies.** Minor mechanically (adding the script is fine and arguably
better), but the RUNBOOK entry Task 8 writes must match whatever is actually
declared, and "matching how X is declared" sends the builder looking for a
template that is not there. Decide: declare the npm script, or document
`npx tsx app/scripts/backfill-media-content-types.ts` and stop calling it
`backfill:media-content-types`.

---

## 18. [MEDIUM] Task 3's two "still refuses / still forces" tests would be green without exercising anything

**What is wrong.** Given the harness the plan points at (finding 8), these two
tests pass for the wrong reason after Task 1 lands:

```ts
it('still refuses to render a script-capable stored type', ...)  // text/html
it('still forces an unknown type to an opaque download', ...)    // application/x-made-up
```

The inbound webhook path runs `normalizeStoredMediaType` at write time
(`app/src/services/mediaMirror.ts:104`), so the S3 object never carries
`text/html` or `application/x-made-up` - it carries `application/octet-stream`.
The response is octet-stream because the object was already collapsed, not
because the read-side gate refused anything.

That defeats the stated purpose, which the plan's own comment states correctly:
*"A legacy object written before the write-side normalizer existed can still carry
text/html at rest."* Spec 7.4 makes the same point and calls that population "the
entire reason the stored-XSS fix put an allowlist on the READ side as well".

**Evidence.** `app/src/services/mediaMirror.ts:101-104`;
`app/test/mmsMedia.test.ts:236-268` (the existing tests have the identical
weakness today, which is why moving to `makeMediaApp` matters);
`app/test/apiRoutes.test.ts:640-670` (`makeMediaApp` sets `object.contentType`
independently). Spec 7.4. Plan Task 3 Step 1.

**What it implies.** The single security assertion this change most needs - that
widening the write side did NOT weaken the read side for legacy at-rest objects -
would be untestable-by-construction in the file the plan chose. Fixing finding 8
fixes this.

---

## 19. [MEDIUM] `sanitizeStem` can still emit a double dot: the cap runs after the trailing-dot strip

**What is wrong.** Order in the pasted implementation is: ... strip trailing dots
(`s.replace(/\.+$/, '')`), THEN `s.slice(0, MAX_STEM)`. A stem longer than 100
characters whose 100th character is `.` survives truncation with a trailing dot,
and `${stem}${ext}` then produces `xxx..mp4`.

The plan's own comment above the function claims the opposite: *"The cap runs LAST
so it can never re-expose a sequence an earlier rule removed."* It can - that is
precisely what truncation does here. The test `'never emits a double dot from a
trailing-dot name'` only uses short inputs (`report.`, `report...`) so it does not
catch it.

**Evidence.** Plan lines 606-623 (order + comment), 503-506 (test inputs). Spec
6.3 sanitization rules 4 and 5 specify the same order, so the spec inherits the
hole.

**What it implies.** Cosmetic on the emitted name, but the plan asserts a
guarantee it does not hold, and the assertion is the kind a reviewer will accept
on the comment alone. Either re-strip after the cap or drop the claim.

---

## 20. [MEDIUM] Task 6 folds an exhausted 429 into `skippedTwilio404`, corrupting the histogram the ops decision reads

**What is wrong.** Step 3 item 9: "a retry on a Twilio 429 (sleep 1s, 2s, 4s, then
give up and count the attachment as `skippedTwilio404`)".

Spec 6.6's reporting list keeps these separate for a reason and spec 10 tells the
operator to "`--dry-run` -> read the histogram -> apply". `skipped-twilio-404`
means "the media is permanently gone; this attachment can never be repaired"
(spec 11 risk 1). A rate-limit give-up means "re-run and it will probably work".
Merging them makes an under-paced dry run look like an aged-out corpus, and the
go/no-go decision is made on that number.

**Evidence.** Spec 6.6 "REPORTING" list; spec 10 sequence; spec 11 risk 1. Plan
Task 6 Step 3 item 9.

---

## 21. [MEDIUM] Task 6 never selects on the attachment's own contentType, and no test proves a repaired attachment is skipped

**What is wrong.** Spec 6.6 defines a repair candidate as inbound AND
`contentType === 'application/octet-stream'` AND has `mediaUrls`. Step 3's
per-attachment sequence (item 7) is "parse the index, parse the MediaSid, call
`getMediaContentType` ... normalize, skip if still opaque, else `setContentType`" -
the octet-stream predicate is never applied per attachment, only implicitly at row
level via nothing at all.

Correspondingly, spec 9 requires "a re-run over a repaired row is a no-op while a
row with an unrepairable attachment is re-queried" and NO test in Task 6 Step 1
feeds a row whose attachment already carries a real type. `'leaves everything
repairable when the row write fails'` re-runs against a FRESH `inboundRow()`, i.e.
an unrepaired row, so it proves recoverability but not idempotency.

**Evidence.** Spec 6.6 "SELECTION" bullets and "IDEMPOTENCY" three bullets; spec 9
backfill bullet. Plan Task 6 Step 1 (thirteen cases, none of them a repaired row),
Step 3 item 7.

**What it implies.** Without the per-attachment predicate an apply re-run
re-queries Twilio for every already-repaired attachment on every row it touches -
which is a vendor-call multiplier on a live account, and the exact cost spec 6.6
budgets for only the interrupted case.

---

## 22. [MEDIUM] Task 7's e2e leaves the load-bearing mechanics undefined

**What is wrong.** Step 3 gives two assertions and a pointer to
`outbound-mms.spec.ts`, but never says:

- how `mediaHref` is obtained (it appears in the snippet undefined);
- which thread/party the inbound goes to. `outbound-mms.spec.ts`'s inbound case
  targets a full-profile relay group (`CONV_ID = 'conv-live-relay-group'`,
  `POOL = '+15550160001'`, with `registerParty` + `sendAsParty` first,
  `outbound-mms.spec.ts:36-40, 224-237`) - copying it drags in the relay fan-out,
  which will now forward a `text/vcard` to Twilio (spec 8 reader 4's WATCH ITEM,
  vendor-decided and unverified);
- where the `.vcf` file goes. The plan says "under `fake-twilio/web/`"; the actual
  location is `fake-twilio/web/public/canned/<id>.vcf` (the existing three are
  `kitchen.png`, `lease-doc.pdf`, `room.png`).

Also: `fake-twilio/web/src/assets/canned/index.test.ts:12` pins an `EXT` map
(`{ room: 'png', kitchen: 'png', 'lease-doc': 'pdf' }`) and then asserts
`u.pathname === '/canned/' + asset.id + '.' + EXT[asset.id]` for EVERY asset. A new
asset without an `EXT` entry produces `/canned/x.undefined` and a confusing
failure. The plan says "update the pinning test's expected list" without naming
this map.

Positive: the `.vcf` substitution itself is sound - `signer.ts`'s
`inferMediaContentType` is a pure suffix ladder (`fake-twilio/src/engine/signer.ts:26-38`)
and adding one branch is correct; and appending the asset at the END of
`cannedAssets` keeps `Composer.test.tsx:42,68,71,74`, `MessageBubble.test.tsx:70-72`
and `GroupPanel.test.tsx:98,107` green, since all three index `cannedAssets[0]`.

**Evidence.** `fake-twilio/web/public/canned/` listing;
`fake-twilio/web/src/assets/canned/index.ts:33-37`, `index.test.ts:12,17-24`;
`fake-twilio/src/engine/signer.ts:26-38`;
`e2e/tests/dashboard-next/outbound-mms.spec.ts:36-40,224-237`. Plan Task 7.

---

## 23. [LOW] The ASCII global constraint mis-states which dashboard files carry emoji

**What is wrong.** Global Constraints: "The two dashboard components already
contain non-ASCII emoji glyphs; do not add more and do not 'fix' the existing
ones."

`Timeline.tsx` deliberately does NOT: it builds its glyphs from code points
precisely to stay ASCII -

```
// Attachment glyphs via String.fromCodePoint (pure-ASCII source; byte-identical
// render to the literal emoji) so every source line stays ASCII.
const ICON_CLIP = String.fromCodePoint(0x1f4ce);
const ICON_PAGE = String.fromCodePoint(0x1f4c4);
```

(`dashboard/src/routes/contact/Timeline.tsx:604-608`). Only
`MediaGallery.tsx:56` carries literal emoji.

**Evidence.** `dashboard/src/routes/contact/Timeline.tsx:604-608`;
`dashboard/src/routes/contact/MediaGallery.tsx:56`.

**What it implies.** A builder told "this file already has emoji, don't worry" may
paste a literal glyph into `Timeline.tsx` and break its stated ASCII property.

---

## 24. [LOW] Nothing pins that every allowlisted type has an emitted extension

**What is wrong.** `resolveMediaTier` ends with
`ext: MEDIA_TYPE_EXTENSIONS.get(essence) ?? '.bin'`. Today both sets are fully
covered (I checked: 5 inline + 21 declarable = 26 types, 26 map entries, one-to-
one). But the fallback means a type added to `INLINE_MEDIA_TYPES` or
`DECLARABLE_MEDIA_TYPES` and forgotten in the map ships a truthful Content-Type
with a `.bin` filename - silently, with no test failing.

The repo already uses this guardrail pattern for the same class of problem:
`planMmsMedia`'s docblock (`app/src/lib/mediaTypes.ts:79-88`) describes a
"GUARDRAIL test [that] pins that every uploadable type maps to a non-reject plan,
so a future uploadable type that Twilio cannot carry fails CI until given a
branch."

**Evidence.** Plan lines 214-290, 335; `app/src/lib/mediaTypes.ts:79-88`.

---

## 25. [LOW] Task 4 does not say to extend `media.test.ts`'s import, though Task 1 says it for `mediaTypes.test.ts`

**What is wrong.** Task 1 Step 1 ends with "Add `resolveMediaTier` and
`isAcceptedExtension` to the file's existing import". Task 4 Step 1 appends two
`describe` blocks to `dashboard/src/routes/contact/media.test.ts` but never says
to extend its import line, which is currently
`import { messageMediaSrc, messageSid, toCommsMediaItem } from './media.js';`
(`media.test.ts:2`). Step 2's stated red state
("`isInlineRenderable is not a function`") is also wrong - it would be
`isInlineRenderable is not defined`.

**Evidence.** `dashboard/src/routes/contact/media.test.ts:1-2`. Plan Task 4
Steps 1-2, vs Task 1 Step 1 line 189.

---

## What I verified and found CORRECT (so the next reviewer does not re-derive it)

These all held against the repo and are worth keeping:

- `app/src/routes/api.ts:23` imports `normalizeStoredMediaType` and never uses it
  (only occurrence in the file); `isInlineMediaType`'s only use in that file is
  `:2292`, inside the block Task 3 replaces - so dropping BOTH from the import is
  safe and the plan's hedge is unnecessary but harmless.
- The header block really is `api.ts:2283-2298`, with `Content-Length`
  (`:2299-2301`), `Cache-Control` (`:2303`) and the `log.info` carrying `inline`
  (`:2304`) below it, exactly as the plan describes.
- `normalizeStoredMediaType` has EXACTLY two callers: `mediaMirror.ts:104` and
  `inboundEmail.ts:677`.
- `MediaAttachment.filename` exists and is documented as absent on MMS/inbound
  (`messagesRepo.ts:797-815`), so `attachments[idx]?.filename` is well typed.
- `Timeline.tsx` line citations are exact: `attachmentLabel` at `614-617`, the
  `startsWith('image/')` branch at `640`, `isPdf` at `658`, and the two
  `attachmentLabel` call sites at `652` and `667`.
- `MediaGallery.tsx:36` is the identical predicate. Repo-wide grep confirms these
  are the ONLY two attachment image/file branches in the dashboard - the plan's
  reader enumeration is complete on that axis.
- `Timeline.test.tsx:552` (image `alt`) / `:555` (PDF file link) and
  `Timeline.email.test.tsx:87/:88/:107` are exactly as spec 9 describes, and both
  email-test attachments really are `application/octet-stream` with no filename,
  so the opaque rule leaves them bare. Verified by counting lines, not by trust.
- `mmsMedia.test.ts:229` and `apiRoutes.test.ts:648,661` are the three
  `content-disposition` `toBeUndefined()` assertions, exactly as claimed.
- `annotateMessage` swallows pointer-write failures in a try/catch that logs at
  error (`messagesRepo.ts:2544-2550`), and emits an INFO carrying
  `conversationId`/`tsMsgId` (`:2526-2536`) - so the write-order argument
  (pointers before row) is correct and load-bearing.
- `inboundMediaKey` is `media/<conversationId>/<messageSid>/<index>`
  (`mediaMirror.ts:67-69`), so `^media/[^/]+/[^/]+/(\d+)$` is the right pattern.
- `parseInboundMediaUrls` (`routes/webhooks/twilio.ts:440-448`) skips empty
  entries, and `jobs/mediaMirror.ts:150-160` appends to the stored array - so the
  "index comes from the key, not the array position" invariant is real.
- `scripts/lib/hcAws.mjs` exports `HC_PROFILE`, `HC_REGION`, `hcCredentials`,
  `assertHousingChoiceAccount`, has a hand-written `hcAws.d.mts`, and is already
  imported from `app/scripts/import-apply.ts:30-34` - so the import path in Task 6
  typechecks.
- `npm run typecheck` really does cover `app/scripts` and `app/test`
  (`app/package.json`: `tsc -p tsconfig.json && tsc -p tsconfig.scripts.json &&
  tsc -p tsconfig.test.json`), so Task 5 Step 5's "run typecheck to find the test
  doubles" works. Note this is load-bearing: vitest runs through esbuild and would
  NOT surface a missing interface member.
- Exactly ONE exhaustive `MediaStore` object literal exists
  (`app/test/helpers/twilioWebhookHarness.ts:3425`); the other five test stores are
  `as unknown as MediaStore` casts and will not break. Four exhaustive
  `MessagingAdapter` literals exist (`twilioWebhookHarness.ts:3344`,
  `scheduledSendSuppression.test.ts:333`, `sendMessage.test.ts:286`,
  `tourReminders.test.ts:1453`) - matching spec 6.7's "FOUR ... and one".
- `DECLARABLE_MEDIA_TYPES` (21), `MEDIA_TYPE_EXTENSIONS` (26) and
  `ACCEPTED_EXTENSIONS` (29) all match the spec's enumerations exactly, and
  `isInlineMediaType`'s exact-match semantics are untouched.
- The two optimistic-send sites that synthesize `application/octet-stream`
  attachments (`useContactTimeline.ts:306`, `useRelayThread.ts:253`) are OUTBOUND
  placeholders with no derivable sid, so they render the count chip and are NOT an
  affected reader. Correctly omitted from the plan.
- The slice-integrity note (Task 1 widens storage before Task 4 fixes the
  predicate) is real and correctly stated.
