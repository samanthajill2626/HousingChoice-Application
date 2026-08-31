# Plan review R1-A - adversarial, plan-vs-repo

Plan: `docs/superpowers/plans/2026-08-26-media-content-type-fidelity.md`
Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
Repo read-only at `W:/tmp/media-content-type-fidelity`.

Question answered: if a builder with no context executes this LITERALLY, do they
produce the spec? **No.** The design is sound and the coverage walk is nearly
complete, but the plan carries a large volume of literal, paste-ready code, and
that code has four self-contradicting tests, one interface call that cannot
typecheck, one regex that cannot match its own fixtures, and three test harnesses
that do not exist in the files the plan names. A builder who trusts the plan
(which is what the plan asks for) burns a full day discovering this.

---

## 1. BLOCKING - Task 2: four of its own tests contradict its own implementation

Task 2 supplies both the tests (Step 1) and the implementation (Step 3), and
tells the builder in Step 4 not to change the sanitizer's order if a test fails.
Four assertions cannot hold against the code in the same task.

**(a) `.env`.** Plan test line: `expect(buildMediaFilename('.env', 0, MP4)).toBe('attachment-1.mp4')`.
Plan implementation:

```ts
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}
```

`'.env'.lastIndexOf('.') === 0`, so `dot <= 0` returns `{ stem: '.env', ext: '' }`.
The stem is non-empty and not `^attachment-\d+$`, so it is USABLE and the result
is `.env.mp4`. The docblock immediately above the function says the opposite
("A name whose only dot is leading (`.env`) is all extension and has an EMPTY
stem"), and so does spec 6.3 ("A name whose only dot is leading (`.env`) is all
EXTENSION and has an empty stem"). The code needs the leading-dot case split out
(`if (dot < 0) ... ; if (dot === 0) return { stem: '', ext: name };`).

**(b) `../../etc/passwd`.** Plan test: `expect(buildMediaFilename('../../etc/passwd', 0, MP4)).toBe('etcpasswd.mp4')`.
`'../../etc/passwd'.lastIndexOf('.') === 4`, so `splitName` yields
`stem = '../.'` and `ext = './etc/passwd'`. `sanitizeStem('../.')` then runs:
strip `/` -> `'...'`; strip `..` -> `'.'`; strip trailing dots -> `''`. Empty stem
-> not usable -> `attachment-1.mp4`. The expected `etcpasswd.mp4` is unreachable
because the SPLIT happens before sanitization, so `etc/passwd` never reaches the
stem at all. The plan's Step 4 note ("work out which rule fired in which order
before changing anything - the ORDER in `sanitizeStem` is deliberate") sends the
builder looking in the wrong function.

**(c) CRLF.** Plan test: `expect(buildMediaFilename('a\r\nb', 0, MP4)).toBe('a b.mp4')`.
The first sanitizer verb is `s.replace(/[\r\n\0"\\]/g, '')` - a REMOVAL, exactly
as spec 6.3 step 1 specifies. `'a\r\nb'` therefore becomes `'ab'`, not `'a b'`.
Result: `ab.mp4`. (Spec 6.3 is internally consistent here; only the plan's test
is wrong.)

**(d) Wholly non-ASCII stem.** Plan test:
`expect(buildMediaFilename('\u4f60\u597d', 0, XLSX)).toBe('attachment-1.xlsx')`.
`sanitizeStem` replaces each non-ASCII codepoint with `_`, giving `'__'`, which is
non-empty and not `^attachment-\d+$`, so it is usable: result `__.xlsx`. Spec 6.3
requires the missing rule explicitly - "If the ASCII stem is empty **or all
underscores** after that, use the synthesized stem instead" - and the plan's
implementation omits it.

**Implies:** the builder pastes both halves, gets four reds, and has been
pre-instructed that the implementation order is deliberate. The most likely
outcome is that the ASSERTIONS get "fixed" to match the code, which silently
drops (a) and (d) - both real behavioral rules from spec 6.3.

## 2. BLOCKING - Task 5: the Twilio driver code cannot typecheck

Plan Task 5 Step 4:

```ts
const media = await this.client.messages(messageSid).media(mediaSid).fetch();
```

`this.client` is `TwilioClientLike` (`app/src/adapters/messaging.ts:574`), and
that interface declares `messages` as a plain OBJECT, not a callable
(`app/src/adapters/messaging.ts:390-399`):

```ts
export interface TwilioClientLike {
  messages: {
    create(params: {...}): Promise<{ sid: string; status: string; dateCreated: Date | null }>;
  };
  ...
}
```

`messages(...)` is a type error. Fixing it means widening `messages` into a
callable-with-properties (the shape `incomingPhoneNumbers` uses at
`messaging.ts:426-438`), which is a change to a shared structural interface that
every injected fake satisfies with an object literal
(`app/test/messaging.test.ts:56, 529, 585, 755, 827, 923`) - none of which is
assignable to a callable. The plan never mentions this; its Step 5 ("Fix every
exhaustive implementer") is scoped only to adding `getMediaContentType` stubs.

**Implies:** the single largest unbudgeted piece of work in the plan, discovered
only when the builder runs typecheck, on a shared vendor-boundary interface.

## 3. BLOCKING - Task 6: the MediaSid regex cannot match Task 6's own fixtures

Plan Step 1 fixtures:

```ts
const URL0 = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME_ZERO';
const URL1 = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME_ONE';
```

Plan Step 3 item 4: "`parseMediaSid(url: string): string | undefined` - matches
`/Media/(ME[0-9a-f]+)` case-insensitively."

`ME_ZERO` and `ME_ONE` have `_` immediately after `ME`; `[0-9a-f]+` (even
case-insensitively, i.e. `[0-9a-fA-F]`) requires at least one hex character
there. Neither fixture matches, so `parseMediaSid` returns `undefined` for every
row and every Twilio-reaching case fails - including the flagship
`toHaveBeenCalledWith('MM1', 'ME_ONE')` index test, the write-order test, the
two-attachment test and the dry-run test. Real Twilio media SIDs are `ME` + 32
hex, so the fixtures are also unrealistic.

**Implies:** the builder's cheapest repair is to loosen the regex to
`ME[A-Za-z0-9_]+` to make the fixtures pass, which is the wrong fix and destroys
the "never guess an index" property the surrounding tests exist to protect.

## 4. BLOCKING - Task 5 Step 1: `mediaStore.test.ts` has no MinIO harness

The plan says: "For `MediaStore` (add to `app/test/mediaStore.test.ts`, using the
file's existing MinIO/localstack harness)" and then writes a real round trip:

```ts
await store.put('media/c1/MM1/0', Readable.from(Buffer.from('hello')), 'application/octet-stream');
await store.setContentType('media/c1/MM1/0', 'video/mp4');
const head = await store.head('media/c1/MM1/0');
expect(head?.contentType).toBe('video/mp4');
const bytes = await store.getBytes('media/c1/MM1/0');
expect(bytes?.toString()).toBe('hello');
```

There is no such harness. `app/test/mediaStore.test.ts` (139 lines) is entirely
hermetic: factory gating, local presign signing, and a `head` test against a
hand-rolled `{ send: async () => ({ ContentType, ContentLength }) }` fake
(`app/test/mediaStore.test.ts:108-138`). Its own header says so: "The real
S3/MinIO streaming path is exercised in the e2e harness; here we only assert the
factory's gating". The sibling adapter test `app/test/mediaStore.deleteObject.test.ts:13-20`
shows the actual house style - `createMediaStore({ config, client: { send } })`
plus an assertion on the emitted `Command` instance and its `.input`.

There is no `store` binding, no bucket, and no way to satisfy `put` -> `head` ->
`getBytes` without a live S3. Both plan tests, including the "is idempotent" one,
are unimplementable as written.

**Implies:** the only thing the repo can actually assert is command SHAPE
(`CopyObjectCommand` with `Bucket`/`Key`/`CopySource`/`ContentType`/`MetadataDirective`).
The bytes-preserved and idempotency claims stay UNVERIFIED, which matters because
S3's "cannot copy an object to itself without changing metadata" rule is the one
thing that could make `setContentType` fail in production and nothing here can
catch it.

## 5. HIGH - Task 3's tests are aimed at the wrong file; the harness they need is in the other one

Task 3 Step 1: "Add to `app/test/mmsMedia.test.ts` ... reuse whatever helper the
neighbouring tests use to seed a message + a stored object; do not invent a new
one", then calls `getMedia({ storedContentType, filename })`.

No such helper exists. `app/test/mmsMedia.test.ts`'s only serve-route seeding is
`seedMms(world)` (`:205-209`), which drives a signed Twilio webhook. That path:

- normalizes the sender type through `normalizeStoredMediaType`
  (`app/src/services/mediaMirror.ts:104`), so an arbitrary `storedContentType`
  cannot be placed on the S3 object - `application/x-made-up` and `text/html`
  both arrive as `application/octet-stream`;
- records `{ s3Key, contentType }` only, with NO `filename`
  (`app/test/mmsMedia.test.ts:104-106`), so `filename: 'invoice.exe'` and
  `filename: 'budget.xlsx'` cannot be expressed at all;
- cannot produce an OUTBOUND EMAIL message, which the spec-8.6 test requires.

The harness the plan needs already exists one file over:
`app/test/apiRoutes.test.ts:600-632` `makeMediaApp({ message, object })` injects
the `messagesRepo.getByProviderSid` result (so `media_attachments[i].filename` is
free) AND the store's returned `object.contentType` directly. Every one of Task
3's seven tests is trivially expressible there and expressible NOWHERE in
`mmsMedia.test.ts`.

**Implies:** a builder following the instruction literally invents a harness the
plan forbade, or waters the tests down to the three cases the webhook can reach -
losing the filename-stem rule, the accepted-extension rule and the outbound-email
tier move, i.e. most of spec 6.3 and all of spec 8.6.

## 6. HIGH - Task 1 Step 5 references three harness symbols that do not exist

Step 5 says the tests use "the file's existing `mirrorMediaSet` harness" and "its
existing inbound-email harness". Neither call compiles.

- `app/test/mediaMirror.test.ts` has no `deps` binding and no `putSpy`. Deps are
  built inline per test (`{ adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep }`,
  `:79-82`) and puts are recorded by `storeSpy()` into a plain `puts` array via a
  non-`vi.fn` method (`:40-50`). `expect(putSpy).toHaveBeenCalledWith(...)` cannot
  be written against it without adding a spy. The plan's call also omits
  `logger`/`sleep`, which `mirrorMediaSet` reads (`app/src/services/mediaMirror.ts:94-95`)
  and which default to a real logger and a real `setTimeout`.
- `app/test/inboundEmail.test.ts` has no `ingestWithAttachment`. The real shape is
  `makeWorld({ raw: mime({ attachments: [...] }) })` then
  `await ingestInboundEmail(notice(), w.deps)`, asserted through `w.appended[0].mediaAttachments`
  (`app/test/inboundEmail.test.ts:970-990`). The plan's `stored.media_attachments?.[0]?.contentType`
  is the wrong property name on the wrong object.

Good news the plan should have said out loud: **no existing assertion breaks.**
`mediaTypes.test.ts:39-44` only pins html/svg/xhtml/undefined; `inboundEmail.test.ts:988`
pins `application/x-weird -> octet-stream`; `mmsMedia.test.ts:159-169` pins
`text/html`. All still hold. The plan's warning that the builder may have to
rewrite existing assertions is unnecessary and invites unneeded edits.

## 7. HIGH - the backfill's account guard proves an account the writes never touch

Task 6 Step 3 item 10 tells the builder to copy `backfill-media-pointers.ts`'s
`invokedDirectly` shape PLUS `assertHousingChoiceAccount()`. Those two precedents
are incompatible.

`assertHousingChoiceAccount` resolves identity through `fromIni({ profile: 'housingchoice' })`
(`scripts/lib/hcAws.mjs:30-56`). `backfill-media-pointers.ts` obtains its client
from `getDocumentClient()` (`app/scripts/backfill-media-pointers.ts:24,48`) -
the DEFAULT credential chain. `createMediaStore()` likewise builds its `S3Client`
with no credentials unless a local endpoint is set
(`app/src/adapters/mediaStore.ts:317-332`). The repo's own comment names the
hazard: "Cameron's machine has default-chain credentials for an UNRELATED account
(ABT Industries). Nothing here may ever fall back to the default chain"
(`scripts/lib/hcAws.mjs:5-7`), and `app/scripts/import-apply.ts:36-38` says
explicitly that it does NOT retain `getDocumentClient` for exactly this reason.

The plan imports `hcCredentials` and `HC_REGION` but never uses them. As written,
the guard passes against the HousingChoice account while the DynamoDB and S3
writes go wherever the default chain points.

**Implies:** the mandatory ops control in spec 6.6/10 is cosmetic, and the failure
mode is a mutating ops script writing to the wrong AWS account with a green
"account guard OK" line in its log.

## 8. HIGH - the "merged" attachments array is neither specified nor tested, and its positional identity is load-bearing

Task 6 Step 3 item 8: "`putMediaPointers(conversationId, tsMsgId, merged)` and THEN
`annotateMessage(conversationId, tsMsgId, { mediaAttachments: merged })`". Nowhere
does the plan state that `merged` must be the FULL `media_attachments` array with
repaired entries in their ORIGINAL POSITIONS.

That invariant is absolute. `mediaPointerItems` assigns the pointer `index` from
the array position (`app/src/repos/messagesRepo.ts:231-233`, and `MediaPointer.index`
is documented at `:211` as "Position in the message's stored media_attachments -
the serve endpoint's `:idx`"), and the serve route selects with
`attachments[idx]` (`app/src/routes/api.ts:2266-2267`). A builder who collects
only the attachments it repaired - the natural reading of "stage the corrected
attachment" - would shorten or reorder the array, silently repointing every
gallery tile and every `/api/messages/:sid/media/:idx` URL on that message, and
would DELETE the unrepairable attachments from the row.

None of Task 6's twelve tests would catch it: `twoAttachmentRow` repairs both
attachments (so a filtered array is identical to the full one), and no test ever
inspects the array passed to `putMediaPointers`/`annotateMessage`.

**Implies:** the highest-consequence silent-corruption path in the whole change
is both unstated and untested. Needs an explicit sentence plus a test with one
repairable and one unrepairable attachment on the same row, asserting the array
handed to both writes has length 2 with the untouched entry still at its index.

## 9. HIGH - Task 6's "row write fails" test cannot pass against Task 6's implementation

```ts
const first = await run({ rows: [inboundRow()], annotateFails: true });
expect(first.result.written).toBe(0);
```

`annotateFails` makes the fake `annotateMessage` throw. Nothing in the
implementation outline (items 1-10) catches it, so `backfillMediaContentTypes`
rejects, `await run(...)` throws, and `first.result` is never assigned. The
assertion is unreachable.

Two things are ambiguous underneath it and the builder has to guess both:

- whether a per-message write failure aborts the whole run or is caught, counted
  and skipped (the test implies the latter; the prose never says so, and there is
  no counter for it in the plan's `BackfillResult` list);
- what `written` counts. Combining this test (`0`) with the two-attachment test
  (`written === 2`, `annotateMessage` called once) pins it to "attachments, but
  only after the row write for their message succeeded". That is a non-obvious
  definition stated nowhere in the prose.

## 10. HIGH - `setContentType` is not gated on `--dry-run` in the prose, but the test requires it to be

Step 3 item 7 (per attachment): "...normalize, skip if still opaque, else
`setContentType` and stage the corrected attachment" - no dry-run condition.
Step 3 item 8 (per row) gates only the two DynamoDB writes on `!dryRun`.
Step 1's test:

```ts
const { result, setContentType, annotateMessage } = await run({ rows: [inboundRow()], dryRun: true });
expect(setContentType).not.toHaveBeenCalled();
```

A builder implementing items 7-8 literally writes S3 on a dry run. This one is at
least caught by the test - but a `--dry-run` that mutates the production media
bucket is the sort of defect worth removing from the prose rather than leaving to
a red test.

## 11. MEDIUM - a 429 exhaustion is counted as `skippedTwilio404`, corrupting the histogram the ops decision reads

Step 3 item 9: "a retry on a Twilio 429 (sleep 1s, 2s, 4s, then give up and count
the attachment as `skippedTwilio404`)."

Spec 6.6 invented `skippedEmailRow` for precisely this reason - "Without the
clause they inflate the dry-run histogram the ops go/no-go decision reads" - and
spec 11 hangs the retention risk assessment on the 404 count ("The dry-run
histogram tells us the real number before anything is written"). Folding
rate-limit exhaustion into that bucket makes the number the operator reads mean
two different things, one of which (throttling) is transient and repairable by
re-running, and the other (retention expiry) is permanent. It needs its own
counter.

Related: `getMediaContentType` swallows only 404 (`(err as {status?:number}).status === 404`);
a 429 propagates as a throw, so the script's retry has to catch a raw provider
error at the call site. The plan does not say that, and the adapter exposes no
typed status.

## 12. MEDIUM - the bounded concurrency + backoff the spec mandates is self-contradicted and untested

Spec 6.6 requires "a bounded concurrency (small, single digit) and a retry with
backoff on 429" for BOTH the dry run and the apply run. Plan Step 3 item 9 says
"Bounded concurrency of 4 over attachments within a page ... Keep it simple: a
small `for` loop with a counter is fine - do not add a dependency." A `for` loop
with a counter is SEQUENTIAL; it is not concurrency of 4. The builder cannot tell
which of the two sentences governs.

No test in Task 6 exercises concurrency, the 429 path, or the backoff. This is an
untestable step in the strict sense: it has no observable pass/fail in the plan,
and the gates cannot catch getting it wrong.

## 13. MEDIUM - spec 6.3's `filename*` (RFC 5987) is dropped; spec 9 lists it as a required test

The plan's NOTE after Task 2 Step 1 deviates deliberately and asks for reviewer
sign-off, which is the right process. Recording it so the adjudication is
explicit: spec 6.3 requires "When the sanitized stem contained ANY non-ASCII,
ALSO emit `filename*=UTF-8''<pct>`", and spec 9 requires the test "a non-ASCII
stem produces `filename*`". Neither is delivered.

The plan's justification ("transliterates non-ASCII to `_`, which is a complete
and safe answer on its own") is reasonable, and the deletion is safe. But note it
interacts with finding 1(d): the plan drops `filename*` AND omits the
all-underscores fallback the ASCII half depends on, so as written the non-ASCII
population gets `__.xlsx` - neither the spec's answer nor the plan's.

## 14. MEDIUM - no MediaGallery test, though spec 9 requires both galleries

Spec 9: "`image/heic` renders as a file link in BOTH `AttachmentGallery` and
`MediaGallery`; `image/jpeg` still renders inline in both."

Task 4 Step 1 adds tests only to `dashboard/src/routes/contact/media.test.ts`
(the pure helpers) and `Timeline.test.tsx` (AttachmentGallery). There is no
`MediaGallery.test.tsx` in `dashboard/src/routes/contact/` and the plan creates
none. The predicate swap at `MediaGallery.tsx:36` therefore ships with zero
component-level coverage.

Worth flagging for whoever writes it: `MediaGallery`'s non-image tile has NO
accessible name - the glyph is `aria-hidden` and the only distinguishing
attribute is `title={m.contentType}` (`dashboard/src/routes/contact/MediaGallery.tsx:47-58`) -
so the test cannot use `getByRole('link', { name })` the way the Timeline tests do.

## 15. MEDIUM - spec 5.2's required route-level regression test is not delivered

Spec 5.2: "A test must pin that the outbound upload gate still refuses
`video/mp4`." Spec 9 repeats it: "the outbound upload gate still refuses
`video/mp4` (5.2)".

Task 1's test asserts only `isInlineMediaType('video/mp4') === false` - the
helper, not the gate. The gate is `POST /api/media/presign` at
`app/src/routes/mmsMedia.ts:78`, whose tests live in
`app/test/mmsMediaRoutes.test.ts`; that file pins `image/svg+xml -> 400`
(`:34-36`) but has no video case. Task 1 Step 5's run list includes
`test/mmsMedia.test.ts`, which is the mirror/serve file, NOT the upload-route
file - so the plan does not even RUN the suite that would regress.

## 16. MEDIUM - the stored-XSS amendment corrects the small claim and leaves the big one false

Task 8 Step 2's amendment addresses only the parameter-matching sentence. But
`docs/issues/media-serve-stored-xss.md:24-32` also states, as the resolved fix:

> ... **only** when `isInlineMediaType(object.contentType)` holds; everything else
> (incl. `text/html`, `image/svg+xml`, `application/xhtml+xml`, absent/empty, and
> the legacy `media_s3_keys` fallback ...) is forced to `application/octet-stream`
> + `Content-Disposition: attachment`.

After Task 3, the read side no longer calls `isInlineMediaType` at all, and
"everything else is forced to `application/octet-stream`" is false for the entire
declarable tier. The amendment as drafted leaves the issue asserting a guarantee
the code stopped providing - the exact failure the spec's follow-up existed to
prevent. The amendment must also say the READ-side gate is now `resolveMediaTier`
and that non-inline no longer implies octet-stream, only non-render.

## 17. MEDIUM - `sanitizeStem`'s cap-last comment is false and the defect is real

```ts
  // Makes "the stem never ends in a dot" TRUE rather than assumed ...
  s = s.replace(/\.+$/, '');
  return s.slice(0, MAX_STEM);
```

with the comment above claiming "The cap runs LAST so it can never re-expose a
sequence an earlier rule removed." The cap runs after the trailing-dot strip, so
a 101-character stem whose 100th character is `.` is truncated back to a
dot-terminated stem and `${stem}${ext}` emits `name..mp4`. Spec 6.3's ordering
has the same hole (truncate is step 5, trailing-dot removal is step 4). Either
re-strip after the cap, or cap before the dot strip.

## 18. MEDIUM - Task 6 cites an npm-script precedent that does not exist

Task 6 Files: "Modify: `package.json` (root scripts block - add
`"backfill:media-content-types": ...`, matching how `backfill:media-pointers` is
declared)."

There is no `backfill:media-pointers` script. Neither root `package.json` nor
`app/package.json` contains any `backfill` key (root scripts: `bootstrap` ...
`smoke`; app scripts: `dev`, `dev:worker`, `build`, `test`, `test:watch`,
`pool:retire`, `typecheck`). The repo's actual convention for backfills is a bare
tsx invocation documented in the RUNBOOK - `app/scripts/backfill-media-pointers.ts:20`
says "Run (from repo root, tsx): `tsx app/scripts/backfill-media-pointers.ts`",
and `RUNBOOK.md:206` documents
`npx tsx app/scripts/backfill-broadcast-list-partition.ts --dry-run`.

Also unresolved: how the operator selects dev vs prod. `backfill-media-pointers`
takes `env` and resolves through `tableName('messages', env)`; the plan's option
bag has no `env`, and there is no `--env` stage resolution like
`import:apply:dev` / `import:apply:prod`. Nor does the plan say where the media
bucket name or the Twilio credentials come from for the CLI path.

## 19. LOW - Task 7 does not name the directory the canned asset must live in

The plan says "Create: a canned `.vcf` asset under `fake-twilio/web/`" and greps
`fake-twilio/ --include=*.ts --include=*.tsx`, which cannot surface the asset
directory (the assets are `.png`/`.pdf`). The correct location is
`fake-twilio/web/public/canned/`, and the reason is load-bearing:
`fake-twilio/web/src/assets/canned/index.ts:1-14` warns that anything imported
through Vite under 4 KB is inlined as a `data:` URI, which the engine's
http(s)-only media guard then rejects. A few-line vCard is well under 4 KB, so a
builder who puts it under `src/assets` reproduces exactly the regression that
comment records.

Two concrete edits the plan should name rather than leave to discovery:
`cannedAssets` in `fake-twilio/web/src/assets/canned/index.ts:33-37`, and the
`EXT` map in `fake-twilio/web/src/assets/canned/index.test.ts:10`, which pins
`u.pathname === '/canned/${asset.id}.${EXT[asset.id]}'` for every asset.

Good news: the driving precedent the plan cites IS correct -
`e2e/tests/dashboard-next/outbound-mms.spec.ts:230-237` (and
`e2e/scenarios/steps.ts:2199-2209`) show `sendAsParty` with
`mediaUrls: [`${fakeUrl}/canned/room.png`]`, which is exactly the shape needed.

## 20. LOW - the e2e drives a relay thread, which also exercises the D3 defect

`outbound-mms.spec.ts`'s inbound-media precedent sends into a relay POOL, which
enqueues `relayFanOut` and forwards the media to the other members. Per spec D3 /
`docs/issues/relay-forwards-undeliverable-media.md`, forwarding a non-image is
the known-broken path. A 1:1 thread (as in `e2e/scenarios/steps.ts:2199` -
`to: APP_NUMBER`) exercises everything this spec asserts with none of that noise.
The plan should say which.

## 21. LOW - `git add app/test/` stages a directory

Task 5 Step 6: `git add app/src/adapters/messaging.ts app/src/adapters/mediaStore.ts app/test/`.
AGENTS.md: "Stage and commit explicit paths only". The Task-5 edits touch a known,
enumerable set (`app/test/helpers/twilioWebhookHarness.ts` plus whichever adapter
fakes typecheck flags); staging the whole directory can sweep in unrelated
in-flight test edits. The plan's other seven commits list explicit files - this
one is the outlier.

## 22. LOW - `CopySource` is not URL-encoded

```ts
CopySource: `${bucket}/${key}`,
```

S3 requires `CopySource` to be URL-encoded. Current keys are
`media/<conversationId>/<messageSid>/<index>` (`app/src/services/mediaMirror.ts:67-69`)
and `media/<conversationId>/<rfcIdSafe(rfcId)>/<i>` (`app/src/services/inboundEmail.ts:676`),
which are safe today. Noting it so the next key shape does not silently break the
backfill.

## 23. LOW - the dashboard mirrors two of the three things spec 6.4 demands

Spec 6.4 requires the dashboard to mirror (1) the raster set, (2) the DECLARABLE
type set and (3) a kind-word map. Task 4 mirrors (1) and (3). (2) is only
implicit - `mediaKindWord` returning `undefined` is the de-facto opaque test. That
is functionally equivalent and arguably better (one map, not two that can drift),
but it is a deviation from an explicit spec instruction and should be recorded as
one rather than discovered by the next reviewer.

## 24. LOW - `rowsScanned` and `eligible` have no defined semantics

`BackfillResult` names them; only `eligible` is ever asserted (once, `=== 0` for
an outbound row). Whether `rowsScanned` counts scanned items or attachment-carrying
rows, and whether `eligible` counts rows or attachments, is a coin flip. Since
these two numbers head the report the ops go/no-go reads, define them.

---

## What is right, and worth saying so

- The coverage walk from spec to task is otherwise complete: every numbered spec
  decision (D1-D3, 5.1, 5.2, 6.1-6.8, 7.1-7.5, 8.5, 8.6, 10, 12) maps to a task.
- The slice-integrity note (Tasks 1-4 must land together, HEIC would render as a
  broken `<img>` in between) is correct and is the non-obvious ordering hazard.
- The write-order argument in Task 6 (S3, then pointers, then the row) is correct
  and correctly grounded: `annotateMessage` really does swallow pointer failures
  in a try/catch (`app/src/repos/messagesRepo.ts:2544-2551`), so a row-first order
  really would clear the re-scan predicate against a failed pointer write.
- The index-from-s3Key rule is correct and correctly motivated: `media_attachments`
  really is a successes-only compaction (`app/src/routes/webhooks/twilio.ts:495-497`)
  that the deferred job appends to (`app/src/jobs/mediaMirror.ts:150-160`), and
  `mediaUrls` really is persisted on inbound MMS rows and absent on inbound email
  rows (`app/src/routes/webhooks/twilio.ts:600, 998, 1707`), so the email bucket's
  discriminator holds.
- Every line/file citation I checked in the plan is accurate:
  `app/test/mmsMedia.test.ts:229`, `app/test/apiRoutes.test.ts:648` and `:661` are
  the three `content-disposition` `toBeUndefined()` assertions;
  `Timeline.test.tsx:552`/`:555` and `Timeline.email.test.tsx:87`/`:88`/`:107` are
  as described; `Timeline.tsx:614-617,640,652,667` and `MediaGallery.tsx:36` are
  correct; `MediaGallery.tsx:9` really is a type-only import;
  `app/src/routes/api.ts:23` really does import `normalizeStoredMediaType` unused
  (only `isTwilioDeliverableType` at `:529` and `isInlineMediaType` at `:2292` are
  live, and Task 3 retires the latter);
  `app/src/routes/api.ts:2283-2298` is the header block; the media bucket really
  is versioned with no lifecycle rule (`infra/modules/s3_media/main.tf:12-17`);
  `normalizeStoredMediaType` really has exactly two callers
  (`services/mediaMirror.ts:104`, `services/inboundEmail.ts:677`).
- The dashboard surface enumeration is exhaustive: a repo-wide grep finds exactly
  two `startsWith('image/')` render branches on stored attachments
  (`MediaGallery.tsx:36`, `Timeline.tsx:640`); the other three hits
  (`EmailComposer.tsx:212`, `Timeline.tsx:1615`, plus the composer chips at
  `EmailComposer.tsx:415` / `Timeline.tsx:2189`) are local-file previews on the
  OUTBOUND compose path and are correctly out of scope. The relay thread
  (`routes/conversation/useRelayThread.ts`) carries data only and renders through
  the shared `Timeline`, as spec 1 claims. Its optimistic placeholder attachments
  use `application/octet-stream` (`useRelayThread.ts:251-253`), i.e. the opaque
  tier, so Task 4's label rule leaves them bare - unchanged.
- No existing assertion in `mediaTypes.test.ts`, `inboundEmail.test.ts`,
  `mmsMedia.test.ts` (mirror half) or `Timeline.email.test.tsx` breaks under the
  widened `normalizeStoredMediaType` or the new label rule. The plan's three
  named `content-disposition` changes are the complete set.
