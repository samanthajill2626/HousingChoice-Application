# Plan review R2-B (adversarial) - media content-type fidelity

Plan: `docs/superpowers/plans/2026-08-26-media-content-type-fidelity.md` @ `ee327047`
Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
Round 1: `plan-r1-a.md` (24), `plan-r1-b.md` (25), all 49 accepted.
Repo read-only at `W:\tmp\media-content-type-fidelity`.

## Verdict up front

**No BLOCKING findings.** The eight blocking defects are genuinely fixed, and I
verified each one by re-running the same trace that caught it - not by reading
the commit message. Every one of Task 2's twenty-two assertions now passes
against Task 2's own implementation; I hand-traced all of them below.

What the rewrite introduced instead is a different, milder class: **four
identifiers that do not exist or do not have the signature the plan gives them**
(one missing import, one omitted import symbol, one class-vs-closure paste, one
fabricated helper arity). All four are self-announcing - `tsc` names the symbol -
so none sends the builder the wrong way, which is the property that made round
1's defects expensive. There are also six MEDIUMs where an accepted round-1
finding was answered with a counter, a comment or a "report it in the handback"
rather than a mechanism.

Charge-by-charge:

1. The eight fixes: **seven are clean**. The RFC 5987 implementation is the one
   that carries new defects (findings 6, 7) plus a false comment (18).
2. What we all missed: **finding 3** - Task 5's `setContentType` body has been
   uncompilable since the first draft and neither reviewer caught it, because we
   both aimed at the tests above it. Also 10, 20, 21.
3. Executable end to end: **almost**. Findings 1-5 are the gaps; everything
   else - every command, every file path, the e2e invocation, the harnesses -
   checks out. See "Executability sweep" at the end.
4. Wrong rather than underspecified: 3, 4, 5, 6, 7, 10, 13, 15, 17, 18.

---

## Task 2: full hand-trace against the NEW implementation

Because this is the coordinator's first charge, here is the whole trace rather
than a summary. `MP4 = {declarable, video/mp4, .mp4}`,
`XLSX = {declarable, ...sheet, .xlsx}`, `OPAQUE = {opaque, application/octet-stream, .bin}`.

| Input | Trace through `sanitizeName` -> `splitName` -> stem -> `extFor` | Result | Asserted | OK |
|---|---|---|---|---|
| `undefined, 0, MP4` | cleaned `''`, stored undefined, stem `''`, unusable | `attachment-1.mp4` | same | yes |
| `undefined, 2, OPAQUE` | unusable; `extFor` opaque but stored undefined -> `.bin` | `attachment-3.bin` | same | yes |
| `invoice.exe, MP4` | stem `invoice`, ext `.exe` discarded (declarable) | `invoice.mp4` | same | yes |
| `holiday.mov, MP4` | stem `holiday` | `holiday.mp4` | same | yes |
| `budget.xlsx, OPAQUE` | `.xlsx` accepted -> kept | `budget.xlsx` | same | yes |
| `photo.jpeg, OPAQUE` | `.jpeg` in ACCEPTED (wider than emission map) | `photo.jpeg` | same | yes |
| `invoice.exe, OPAQUE` | `.exe` refused -> `.bin` | `invoice.bin` | same | yes |
| `run.ps1, OPAQUE` | `.ps1` refused | `run.bin` | same | yes |
| `attachment-0, 0, XLSX` | no dot -> stem `attachment-0`, `SYNTHESIZED` hits | `attachment-1.xlsx` | same | yes |
| `attachment-12, 3, MP4` | same, index 3 -> 4 | `attachment-4.mp4` | same | yes |
| `data.tar.csv, OPAQUE` | no `..` adjacency; split at last dot -> `data.tar` + `.csv` accepted | `data.tar.csv` | same | yes |
| `data.tar.csv, MP4` | ext discarded | `data.tar.mp4` | same | yes |
| `.env, MP4` | `dot === 0` -> `{stem:'', ext:'.env'}`; stem empty -> unusable | `attachment-1.mp4` | same | yes |
| `report., MP4` | split -> `report` + `.`; trailing-dot strip no-op | `report.mp4` | same | yes |
| `report..., MP4` | `\.\.` removes one pair -> `report.`; split -> `report` | `report.mp4` | same | yes |
| `../../etc/passwd, MP4` | `/` removed -> `....etcpasswd`; `..` x2 removed -> `etcpasswd`; no dot | `etcpasswd.mp4` | same | **yes - the round-1 defect is gone** |
| `C:\Users\x\secret.txt, MP4` | `\` removed -> `C:Usersxsecret.txt`; `:` removed by the new `[<>:\|?*]` rule | `CUsersxsecret.mp4` | same | yes |
| `a\r\nb, MP4` | control -> space -> `a  b`; `\s+` collapse -> `a b` | `a b.mp4` | same | **yes - fixed** |
| `a\tb, MP4` | same path | `a b.mp4` | same | yes |
| `he said "hi", MP4` | quotes removed, collapse | `he said hi.mp4` | same | yes |
| 120 a's + `.xlsx`, XLSX | split -> 120 a's; cap 100 | 100 a's + `.xlsx` | same | yes |
| 99 a's + `.` + 10 c's + `.txt`, MP4 | split at the LAST dot -> stem 110 chars; cap to 100 leaves a trailing dot at index 99; **second** strip removes it | 99 a's + `.mp4` | same | **yes - P2 fixed, and the fixture really does reach the case** |
| `bud<e9>get, XLSX` | asciiStem `bud_get`, usable | `bud_get.xlsx` | same | yes |
| `<4f60><597d>, XLSX` | asciiStem `__`; `isUnusableStem`'s `/^[_\s]+$/` hits | `attachment-1.xlsx` | same | **yes - fixed** |
| `///, MP4` | `/` removed -> `''` -> stored undefined | `attachment-1.mp4` | same | yes |
| `'   ', MP4` | collapse + trim -> `''` | `attachment-1.mp4` | same | yes |
| `Parts('budget.xlsx')` | `hadNonAscii` false, spread of `false` omits the key | `{ascii:'budget.xlsx'}` | `{ascii, utf8: undefined}` | yes - vitest `toEqual` ignores undefined properties |
| `Parts(bud<e9>get)` | utf8 built from the pre-transliteration stem | `{ascii:'bud_get.xlsx', utf8:'bud<e9>get.xlsx'}` | same | yes |
| `header('attachment',{ascii:'budget.xlsx'})` | no utf8 -> base only | as asserted | | yes |
| `header(...,{ascii:'bud_get.xlsx', utf8:'bud<e9>get.xlsx'})` | `encodeURIComponent` -> `bud%C3%A9get.xlsx`; no chars in `['()*!]` | `attachment; filename="bud_get.xlsx"; filename*=UTF-8''bud%C3%A9get.xlsx` | same | yes |
| `header(..., utf8: "a'(b)*!.txt")` | `encodeURIComponent` leaves all five bare; the replace escapes them: `%27 %28 %29 %2A %21` | contains `filename*=UTF-8''a%27%28b%29%2A%21.txt` | same | yes |
| `header('attachment',{ascii:'a"b\r\nX-Evil: 1'})` | `[\r\n\0"\\]` stripped -> `abX-Evil: 1` | no CR/LF, exactly 2 quotes | same | yes |

All twenty-two hold. The `hex`-case detail is right too: `(0x2a).toString(16)` is
`'2a'`, and `.toUpperCase()` on the two-char string yields `2A`, matching the
assertion.

Task 6's SID fixtures also check out: I ran
`/\/Media\/(ME[0-9a-fA-F]{32})/` against both constants - `ME0` and `ME1` are
each exactly `ME` + 32 characters and both match.

---

## 1. [HIGH] Task 2's test file uses `buildMediaFilenameParts` but never imports it

**What is wrong.** The pasted import (plan `:486`) is

```ts
import { buildMediaFilename, contentDispositionHeader } from '../src/lib/mediaFilename.js';
```

`buildMediaFilenameParts` is then called at plan `:604` and `:611` (the entire
"RFC 5987 companion" describe block). It is never imported, and unlike Task 1
Step 1 there is no "add X to the import" instruction anywhere in Task 2.

**What it implies.** `tsc -p tsconfig.test.json` fails with TS2304 (gate 1), and
under vitest the two tests throw `ReferenceError`. Step 4 says "Expected: PASS".
This is the new-code-under-pressure signature: the interfaces block at `:471-475`
was extended to name `buildMediaFilenameParts`, the tests were extended to use
it, and the import line was not.

**Evidence.** Plan `:471-475`, `:486`, `:604`, `:611`, `:760`. Import surface
confirmed against `app/tsconfig.test.json` (`include: ["test", "src", ...]`), so
this is a gate-1 failure, not just a runtime one.

---

## 2. [MEDIUM] Task 1 Step 1's import instruction omits `DECLARABLE_MEDIA_TYPES`, which the new guardrail block needs

**What is wrong.** The new describe block "the emission map covers every
allowlisted type" (plan `:141-156`) iterates
`[...INLINE_MEDIA_TYPES, ...DECLARABLE_MEDIA_TYPES]`. Step 1 then says:

> Add `resolveMediaTier` and `isAcceptedExtension` to the file's existing import

The existing import is
`{ INLINE_MEDIA_TYPES, isInlineMediaType, normalizeStoredMediaType }`
(`app/test/mediaTypes.test.ts:4-8`). `DECLARABLE_MEDIA_TYPES` is in neither list.

**Evidence.** `app/test/mediaTypes.test.ts:4-8`; plan `:146`, `:152`, `:213-214`.

**Positive, verified:** the guardrail itself is correct. I checked all 26
emission entries against both allowlists (5 inline + 21 declarable = 26 types,
26 map entries, one-to-one) and every emitted extension against
`ACCEPTED_EXTENSIONS`. Both assertions hold today, so the guardrail is a true
ratchet rather than a test that is already red.

---

## 3. [HIGH] Task 5's `setContentType` implementation cannot compile - it is written as a closure method inside a class

**What is wrong.** The pasted body (plan `:1431-1446`) is

```ts
    async setContentType(key, contentType) {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          ...
          CopySource: `${bucket}/${key}`,
```

`S3MediaStore` is a **class** with `private readonly bucket` and
`private readonly client` (`app/src/adapters/mediaStore.ts:138-142`). There is no
`client` or `bucket` in scope - the sibling `put` reads `this.client` and
`this.bucket` (`:144-152`). And under `"strict": true`
(`tsconfig.base.json`), unannotated method parameters are TS7006: `implements`
does not contextually type class method parameters, so `key` and `contentType`
are implicit `any`.

Three compile errors, in the one snippet the builder is told to paste "alongside
the existing `put`". Correct form:

```ts
  async setContentType(key: string, contentType: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket, Key: key,
      CopySource: `${this.bucket}/${key}`,
      ContentType: contentType, MetadataDirective: 'REPLACE',
    }));
  }
```

**Evidence.** `app/src/adapters/mediaStore.ts:138-152`; `tsconfig.base.json`
(`strict: true`); plan `:1428-1447`.

**What it implies.** This is the answer to charge 2: **both round-1 reviewers
missed it.** We each attacked the *tests* above it (my #7, R1-A #4) and neither
of us read the implementation snippet against the class. The revision rewrote the
tests and left the body byte-identical. Nothing in the fix loop would have caught
it, because the only thing that catches it is reading it.

---

## 4. [HIGH] Task 5's messaging tests call `makeDriver({ client })`; `makeDriver()` takes no arguments and is scoped to a different describe

**What is wrong.** All three pasted messaging tests (plan `:1379-1400`) call
`makeDriver({ client: { messages } })`.

`app/test/messaging.test.ts:293-303` is:

```ts
describe('TwilioMessagingDriver.getMediaStream - SSRF guard + size cap', () => {
  function makeDriver() {
    return new TwilioMessagingDriver({
      accountSid: 'ACtest', ..., client: makeFakeTwilioClient().client, ...
    });
  }
```

Zero parameters, and block-scoped inside a describe about a different method.
`makeDriver({...})` is TS2554 ("Expected 0 arguments, but got 1"), and used
outside that block it is also out of scope.

**Evidence.** `app/test/messaging.test.ts:54-65` (`makeFakeTwilioClient`),
`:292-303` (`makeDriver`); plan `:1374-1400`.

**What it implies.** Same class as round 1's `getMedia` / `putSpy` /
`ingestWithAttachment` - a pasted call against a fabricated signature - reappearing
in code written to fix that exact class. The plan does tell the builder to grep
for the file, which is why this is HIGH and not BLOCKING, but the honest form is
either "parameterize `makeDriver` to take an optional client override" or "write
`new TwilioMessagingDriver({...})` inline as the file's other 8 call sites do".

**Positive, verified:** the `typeof messages !== 'function'` discriminator itself
is sound. `TwilioClientLike.messages` really is a non-callable object literal in
every fake (`app/test/messaging.test.ts:56-63`), while the real twilio SDK's
`messages` is a callable list-instance carrying `.create`. So the real driver
takes the callable branch and every fake degrades. And the 404 handling now
checks BOTH `status === 404` and `code === 20404`, which matches the repo's own
rule at `app/src/adapters/groupConversations.ts:591,611,644,708-716`. That fix is
correct - though see finding 12 for what the degrade costs in the ops script, and
note the plan's citation says `app/src/services/groupConversations.ts` when the
file is `app/src/adapters/groupConversations.ts`.

---

## 5. [MEDIUM] `new S3MediaStore({ client, bucket })` is the wrong constructor shape

**What is wrong.** Plan `:1352-1355` writes an options-bag constructor. The real
one is positional: `constructor(private readonly bucket: string, private readonly client: S3Client)`
(`app/src/adapters/mediaStore.ts:138-142`), and the file's own tests already show
the call shape - `new S3MediaStore('b', fakeClient)`
(`app/test/mediaStore.test.ts:113`, and `:63` with the local client).

The plan hedges this honestly ("the constructor signature above is illustrative,
not verified"), which is why it is MEDIUM rather than HIGH. But the correct
two-token form was three lines further down the very file the plan is editing,
and leaving a knowingly-wrong snippet in a plan that elsewhere insists on
paste-ready code invites the builder to trust the next unhedged one.

**Evidence.** `app/src/adapters/mediaStore.ts:138-142`;
`app/test/mediaStore.test.ts:55-63`, `:110-117`; plan `:1350-1372`.

---

## 6. [MEDIUM] The new RFC 5987 code drops `filename*` for exactly the population it exists to serve

**What is wrong.** `buildMediaFilenameParts`'s unusable-stem branch returns

```ts
    return { ascii: `${stem}${extFor(resolved, stored)}`, utf8: undefined };
```

(plan `:777-780`). That branch fires when `asciiStem` is empty or all
underscores - i.e. when the stored name was **wholly** non-ASCII. So
`<4f60><597d>.pdf` is served as `filename="attachment-1.pdf"` with no `filename*`
at all, and the real name is lost.

Spec 6.3 is explicit and does not carve this out:

> When the sanitized stem contained ANY non-ASCII, ALSO emit
> `filename*=UTF-8''<pct>` where `<pct>` is the UTF-8 bytes of the FULL sanitized
> stem plus extension

The correct behavior is `filename="attachment-1.pdf"; filename*=UTF-8''%E4%BD%A0%E5%A5%BD.pdf` -
the ASCII fallback for old clients, the true name for modern ones. That is the
whole point of the pair, and a CJK or Cyrillic attachment name is the single most
likely real instance of it.

Two of Task 2's own tests sit either side of the hole and neither catches it:
`'falls through when nothing usable survives sanitizing'` asserts only `.ascii`
via `buildMediaFilename`, and `'reports both forms when the stem carried
non-ASCII'` uses `bud<e9>get`, which survives transliteration.

**Evidence.** Plan `:770-786`, `:592-599`, `:610-615`; spec 6.3 "NON-ASCII"
bullet 3.

---

## 7. [MEDIUM] `encodeURIComponent` throws on a lone surrogate, and nothing sanitizes `name.utf8` - a 500 on the authed media route

**What is wrong.** `rfc5987(value)` is `encodeURIComponent(value).replace(...)`
(plan `:748-753`). `encodeURIComponent` throws `URIError: URI malformed` on an
unpaired surrogate. `name.utf8` is `${stem}${ext}` built from the sanitized
stored filename; `sanitizeName` removes control characters, quotes, separators
and Windows-reserved characters, and none of those rules touches a lone
surrogate. A lone surrogate is a single UTF-16 code unit outside `\x20-\x7e`, so
it IS replaced by `_` in `asciiStem` - which sets `hadNonAscii` and puts the
surviving lone surrogate into `utf8`.

`contentDispositionHeader` then calls `rfc5987(name.utf8)` inside the media serve
route with no try/catch, so the request throws out of the handler.

**Reachability: PARTIALLY UNVERIFIED.** I ruled out the obvious source:
`truncateToBytes` (`app/src/services/inboundEmail.ts:275-281`) operates on a
UTF-8 `Buffer` and walks back over continuation bytes (`(buf[end] & 0xc0) === 0x80`),
so it cannot split a surrogate pair. The remaining source is a malformed
encoded-word decoded by mailparser into an unpaired surrogate, which
`inboundEmail.ts:683` persists verbatim. I could not prove mailparser does that,
so treat the trigger as unproven - but the consequence (an unhandled throw on an
authed route, from attacker-influenced stored data) and the fix (wrap
`rfc5987` and omit `filename*` on failure, or strip `[\uD800-\uDFFF]` in
`sanitizeName`) are both cheap enough that "unproven" is not a reason to ship it.

**Evidence.** Plan `:748-753`, `:816-824`, `:1015-1020`;
`app/src/services/inboundEmail.ts:275-281`, `:682-685`.

**Injection through the utf8 form: SAFE, verified.** The coordinator asked
specifically. `encodeURIComponent` escapes CR (`%0D`), LF (`%0A`), `"` (`%22`),
`\` (`%5C`), `;` (`%3B`) and space (`%20`); its unescaped set is
`A-Za-z0-9-_.!~*'()`, and the five RFC 5987 characters in that set are then
escaped by the explicit `.replace`. So no header separator can survive the utf8
path. The omission is documentational only - see finding 18.

**`filename*` omitted when it would duplicate: CORRECT, verified.**
`if (name.utf8 === undefined || name.utf8 === name.ascii) return base;` (plan
`:822`) covers both the never-set case and a hypothetical equal one, and
`hadNonAscii` guarantees they differ whenever `utf8` is set.

---

## 8. [MEDIUM] Task 3 Step 5 edits `apiRoutes.test.ts` by line number after Step 1 inserted ~105 lines into the same file

**What is wrong.** Step 5 says:

> `app/test/mmsMedia.test.ts:229`, `app/test/apiRoutes.test.ts:648` and `:661`
> assert `content-disposition` is UNDEFINED on the inline path.

Those line numbers are correct **today** (I verified: `apiRoutes.test.ts:648` is
the image case's `toBeUndefined()`, `:661` the PDF case's). But Step 1 now adds
~105 lines of new tests to that same describe block, and says only "Add to the
`GET /api/messages/:providerSid/media/:idx` describe block" - it does not say
append-at-the-end. If the builder inserts after the `get` helper (the natural
reading, since `mediaMessage` is a helper), both targets shift by ~105 and the
builder edits whatever now sits at 648.

This is a **regression introduced by the round-1 fix**: in the previous draft the
new tests lived in `mmsMedia.test.ts`, so the `apiRoutes.test.ts` line numbers
were stable across the task.

**Fix:** identify them by test name -
`'serves an image attachment INLINE (no attachment disposition)'` and
`'serves a PDF attachment INLINE (application/pdf, no attachment disposition)'`.

**Evidence.** `app/test/apiRoutes.test.ts:640-666`; plan `:867-978`, `:1033-1043`.

**Positive, verified:** the move to `makeMediaApp` is correct and every new test
is expressible there. `makeMediaApp(opts: { message: Record<string, unknown> | undefined; object?: { contentType?: string } })`
(`app/test/apiRoutes.test.ts:599-632`) injects `getByProviderSid`'s return and the
store's `contentType` independently, so `mediaMessage({contentType, filename})`
works verbatim, `get(app, sid, idx)` is in scope, and the `text/html`-on-the-object
case now genuinely exercises the read-side gate. I traced the `filename*` route
test too: stored `bud<e9>get.mov` + object `video/mp4` yields exactly
`attachment; filename="bud_get.mp4"; filename*=UTF-8''bud%C3%A9get.mp4`.

---

## 9. [MEDIUM] Task 6's credential fix stops one line short: `createMediaStore` is left as a comment

**What is wrong.** The prose is now right - "THE GUARD MUST BIND TO THE CLIENTS
THE SCRIPT ACTUALLY WRITES THROUGH" is exactly the round-1 finding. But the code
is:

```ts
const credentials = hcCredentials();
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: HC_REGION, credentials }));
const mediaStore = createMediaStore({ /* same region + credentials */ });
```

The third line is a comment where the mechanism should be, and the plan then
says: "If `createMediaStore` cannot accept explicit credentials, that is a
finding to report in the handback".

**It can.** `CreateMediaStoreDeps` has a `client?: S3Client` seam
(`app/src/adapters/mediaStore.ts:281-285`) and `createMediaStore` honours it
(`:304-307`: `deps.client ?? buildS3Client(config, 'createMediaStore')`).
Without it, `buildS3Client` builds `new S3Client({ region: config.awsRegion })`
with **no credentials** (`:317-332`), i.e. the default chain - the exact failure
the paragraph above it forbids.

So the answer is `createMediaStore({ config, client: new S3Client({ region: HC_REGION, credentials }) })`.
But that requires importing `S3Client` from `@aws-sdk/client-s3` **in a script**,
which this plan's own Global Constraints forbid: "Vendor SDK imports live only in
`app/src/adapters`. Services, routes, jobs and **scripts** depend on the
interfaces, never on `twilio` or `@aws-sdk/client-s3` directly." The plan does not
resolve that, and it is not hypothetical - the DynamoDB half of the same snippet
already imports `@aws-sdk/client-dynamodb` directly, as `import-apply.ts:27-28`
does.

**What it implies.** The mandatory ops control is one unwritten line from being
cosmetic again, and the builder's two obvious routes both violate something the
plan states. Decide it in the plan: either exempt this script from the vendor rule
(as `import-apply.ts` is de facto exempt) or add a credentials passthrough to
`CreateMediaStoreDeps`.

**Evidence.** `app/src/adapters/mediaStore.ts:281-285`, `:304-308`, `:317-332`;
`app/scripts/import-apply.ts:26-34`, `:236-257`; plan Global Constraints
(`:40-42`) and `:1860-1878`.

---

## 10. [MEDIUM] The doc-client snippet omits `removeUndefinedValues`, which the precedent it cites flags as must-match

**What is wrong.** Plan `:1871`:

```ts
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: HC_REGION, credentials }));
```

`import-apply.ts:243-247` - the exact lines the plan tells the builder to read -
passes the second argument and says why:

```ts
  // Must match lib/dynamo.ts createDocumentClient: dropping undefineds is
  // what keeps the sparse GSIs sparse.
  { marshallOptions: { removeUndefinedValues: true } },
```

and `app/src/lib/dynamo.ts:83-89` confirms the production client sets it.

**What it implies.** Without it, the SDK **throws** on any item carrying an
`undefined` rather than dropping it. This script writes production message rows
(`annotateMessage`) and pointer rows (`putMediaPointers`), and `merged` is built
from scanned rows whose `MediaAttachment` optionals (`originalKey`, `filename`)
may be absent - safe today, but a `map` that spreads a missing key as
`filename: undefined` is one careless line away, and the failure mode is a
mid-run throw against prod. This was in the round-1 fix's blast radius (the
credential rewrite touched this exact snippet) and was not carried across.

**Evidence.** `app/scripts/import-apply.ts:238-247`, `:253-256`;
`app/src/lib/dynamo.ts:83-89`; plan `:1869-1875`.

---

## 11. [MEDIUM] `skippedThrottled` got a counter but no detection mechanism and no test

**What is wrong.** The round-1 finding (R1-A #11, my #20) was that folding 429
into `skippedTwilio404` corrupts the histogram. The revision adds
`skippedThrottled` with a good comment (plan `:1786-1792`) and changes item 9's
give-up bucket. Both correct.

But the *mechanism* is still absent, and it was the tail of the same accepted
finding:

- `getMediaContentType` swallows only 404/20404 and **rethrows** everything else
  (plan `:1500-1509`), and the `MessagingAdapter` interface returns
  `Promise<string | undefined>` with no typed status. So the script must catch a
  raw vendor error at the call site and inspect it - which the plan never says,
  and which puts a `twilio`-shaped error check in a script the Global Constraints
  say must depend only on interfaces.
- Item 9 ("Bounded concurrency of 4 ... retry on a Twilio 429 ... sleep 1s, 2s,
  4s") has **no test**. `getMediaContentType` in the harness is a `vi.fn()` that
  never rejects, so neither the pool nor the backoff nor `skippedThrottled` has an
  observable pass/fail anywhere in the plan.

**Evidence.** Plan `:1786-1792`, `:1817-1820`, `:1839-1843`, `:1500-1509`,
`:1627-1629`; spec 6.6 "`--dry-run` IS NOT READ-ONLY" paragraph.

**Positive, verified:** item 9's other half is now unambiguous - "a simple
index-cursor worker pool - four async workers pulling from a shared array cursor"
replaces the previous self-contradicting "for loop with a counter", which R1-A
correctly called out as sequential.

---

## 12. [MEDIUM] The `typeof messages !== 'function'` degrade is indistinguishable from retention loss in the ops script

**What is wrong.** The discriminator is right for the SUITES (finding 4,
positive). But in the backfill it means a misconfigured or console-driver adapter
returns `undefined` for **every** attachment, which item 7 then counts as
`skippedTwilio404` - the counter spec 11 hangs the retention risk on:

> Twilio media retention: an old enough message may have no media left. The
> backfill counts these and moves on ... The dry-run histogram tells us the real
> number before anything is written.

So a dry run against a wrong client reports "every attachment aged out", writes
nothing, exits 0, and the operator reads it as "there is nothing to repair". The
plan's own framing of the guard problem applies verbatim: that is worse than an
error, because it reads as a finding.

**Fix:** either have the CLI wrapper assert the adapter is a real Twilio driver
before scanning, or give `getMediaContentType` a discriminated result so
"not-callable" and "404" land in different buckets.

**Evidence.** Plan `:1492-1496`, `:1516-1520`, `:1817-1820`; spec 11 risk 1;
spec 10 sequence ("`--dry-run` -> read the histogram -> apply").

---

## 13. [MEDIUM] Task 8 and the post-merge section still name `backfill:media-content-types`, the npm script Task 6 now refuses to create

**What is wrong.** Task 6 was corrected to:

> NO npm SCRIPT. There is no `backfill:*` script in any package.json - the
> RUNBOOK invokes every backfill as `npx tsx app/scripts/<name>.ts --dry-run`

(plan `:1556-1558`; I verified `RUNBOOK.md:257` and `:260` both use `npx tsx`,
and that no `backfill` key exists in either `package.json`).

Two downstream references were not updated:

- Task 8 Step 1: "Add a section for `backfill:media-content-types` covering..."
  (plan `:2010`) - so the RUNBOOK entry, whose entire job is telling a human what
  to type, documents a command that does not exist.
- Post-merge obligations: "`backfill:media-content-types` must be run by a human"
  (plan `:2100`).

**Evidence.** Plan `:1556-1558`, `:2010`, `:2100`; `RUNBOOK.md:257,260`; root and
`app/package.json` scripts.

---

## 14. [MEDIUM] Task 1 makes a spec-required test optional, when the harness it doubts is verifiable in three lines

**What is wrong.** The round-1 fix replaced the fabricated `ingestWithAttachment`
with an instruction to read the file first - good - but then added an escape
hatch:

> If no existing test in that file asserts on a stored attachment's contentType,
> say so in the handback and cover this caller with the mirror tests above plus
> the Task 3 route tests instead of inventing a harness.

Spec 9 lists "Inbound email: a `.docx` attachment now stores its real type" as
required coverage, and spec 6.1 names `services/inboundEmail.ts:677` as one of
the two callers whose behavior changes. The escape hatch lets a builder skip it
on a judgement call.

It is also unnecessary. Such a test exists and I can name it:
`app/test/inboundEmail.test.ts:975-988` builds
`makeWorld({ raw: mime({ attachments: [{ filename, contentType, base64 }] }) })`,
runs `ingestInboundEmail(notice(), w.deps)`, and asserts

```ts
expect(w.appended[0]!.mediaAttachments).toEqual([
  { s3Key: keys[0], contentType: 'application/pdf', filename: 'lease agreement.pdf' },
  { s3Key: keys[1], contentType: 'application/octet-stream', filename: 'weird.bin' },
]);
```

That is the setup, the assertion path and the property name (`mediaAttachments`,
camelCase - the recorded append input, not a re-read row).

**Evidence.** `app/test/inboundEmail.test.ts:44-46` (the `mime` attachment
fixture shape), `:280-284` (the `put`/`mediaStore` seam), `:975-988`; plan
`:431-443`; spec 6.1, spec 9.

**Positive, verified:** the mirror half of Step 5 is now exactly right.
`flakyAdapter` / `storeSpy` / `silent` / `INLINE_MIRROR_DELAYS_MS` all exist with
the shapes the plan states (`app/test/mediaMirror.test.ts:15-50`, `:20`), and
`s.puts` really is `{key, contentType}[]`, so
`expect(s.puts).toEqual([{ key: 'media/conv-1/MM9/0', contentType: 'video/mp4' }])`
is exact.

---

## 15. [LOW] Task 7 mis-describes what the canned-asset pinning test does

**What is wrong.** Plan `:1949-1952`:

> That test also carries an extension-to-type map; add `.vcf` there too or the
> registry and the signer will disagree, which is exactly the kind of split the
> pinning test exists to catch.

`fake-twilio/web/src/assets/canned/index.test.ts:10` is
`const EXT: Record<string, string> = { room: 'png', kitchen: 'png', 'lease-doc': 'pdf' }` -
an **asset-id to extension** map, not extension-to-type. It is used only to assert
`u.pathname === '/canned/${asset.id}.${EXT[asset.id]}'` (`:17-24`). The test
asserts no content type anywhere and has no knowledge of `signer.ts`, so it
cannot catch a registry/signer split.

The actionable half is still right and important: a new asset without an `EXT`
entry yields `/canned/x.undefined` and a confusing failure. Just say that.

**Evidence.** `fake-twilio/web/src/assets/canned/index.test.ts:10-24`;
`fake-twilio/src/engine/signer.ts:26-38`.

**Positive, verified:** the asset location is now correct and correctly reasoned -
`fake-twilio/web/public/canned/` holds `kitchen.png`, `lease-doc.pdf`,
`room.png`, and the Vite-inlining hazard the plan cites is the one recorded in
`index.ts:1-14`. Appending the new asset keeps `Composer.test.tsx:42,68,71,74`,
`MessageBubble.test.tsx:70-72` and `GroupPanel.test.tsx:98,107` green, since all
three index `cannedAssets[0]`. And the switch to a 1:1 thread is right on two
counts: it avoids the D3 forwarding path, and it drops the full-seed dependency
that `outbound-mms.spec.ts`'s relay constants carry.

---

## 16. [LOW] `isDeclarableMediaType` is exported with no caller and no test

**What is wrong.** Task 4 adds a third export (plan `:1075-1078`, `:1234-1239`) to
satisfy spec 6.4's "mirror all three". Nothing calls it - `Timeline.tsx` uses
`isInlineRenderable` + `mediaKindWord`, `MediaGallery.tsx` uses
`isInlineRenderable` - and Task 4 Step 1's test block does not cover it, so it
does not participate in the red state either.

It is one line over `KIND_WORDS.has`, so the cost is small; but it puts an
untested function in a shared module's public API to close a checklist item, and
the plan's own justification ("a caller asking...") names no caller.

**Evidence.** Plan `:1075-1078`, `:1084-1132`, `:1234-1239`, `:1242-1283`.

---

## 17. [LOW] Task 2 Step 4's troubleshooting note points at a function that no longer exists

**What is wrong.** Step 4 (plan `:829-832`) still reads:

> If `'../../etc/passwd'` does not produce `etcpasswd.mp4`, work out which rule
> fired in which order before changing anything - the ORDER in `sanitizeStem` is
> deliberate.

`sanitizeStem` was renamed `sanitizeName` in the same commit. The note also now
guards a case that passes, and its round-1 role was to tell the builder the
implementation was right when it was wrong - so it is worth rewriting rather than
just renaming.

**Evidence.** Plan `:712` (`sanitizeName`), `:830-832`.

---

## 18. [LOW] The module comment claims the utf8 half is "stripped" when it is percent-encoded

**What is wrong.** `mediaFilename.ts`'s header says "Everything that reaches a
header is stripped of CR, LF, quotes and backslashes" (plan `:684-685`), and
`contentDispositionHeader`'s docblock says it "strips anything a future caller
might pass" (plan `:814-815`). Both describe `name.ascii` only; `name.utf8` is
never stripped - it is percent-encoded by `rfc5987`, which is equally safe
(finding 7) but by a different mechanism the comments do not mention.

**What it implies.** A future maintainer adding a raw-`utf8` passthrough (or a
`filename*` variant that skips `encodeURIComponent`) would read these comments as
saying the sanitizing already happened. One clause fixes it.

---

## 19. [LOW] Two pasted snippets use undefined bindings the plan never introduces

- Task 4 Step 4b: `render(<MediaGallery media={[{ ..., at: T }]} />)` - `T` is
  never defined (plan `:1294`, `:1299`).
- Task 7 Step 3: `timeline.getByRole(...)` - `timeline` is never defined
  (plan `:1972`).

Both sit under an explicit "follow whatever helper the neighbouring files use"
instruction, so a builder will supply them; noting them so the next reviewer does
not read them as harness claims.

**Positive, verified:** the MediaGallery test itself is correct. `CommsMediaItem`
is `{ key, src, contentType, at }` (`dashboard/src/routes/contact/media.ts:24-31`),
`MediaGallery`'s props are `{ media, loading?, paging? }` (`MediaGallery.tsx:20-28`),
the jpeg branch renders `<img alt="Attachment">` (role `img`) and the non-image
branch renders an `aria-hidden` `<span>` inside an `<a>` - so
`getByRole('img')` / `queryByRole('img')` discriminate exactly as asserted, and
R1-A's warning about the tile having no accessible name is correctly sidestepped
by asserting on the img rather than the link.

---

## 20. [LOW] `setContentType`'s test lands in the one mediaStore test file scoped to something else

**What is wrong.** `app/test/` already has `mediaStore.deleteObject.test.ts`,
`mediaStore.getBytes.test.ts`, `mediaStore.getStreamRange.test.ts` and
`mediaStore.presignPost.test.ts` - one file per method. The plan puts the new
command-shape test in `mediaStore.test.ts`, whose own header says "here we only
assert the factory's gating".

`mediaStore.setContentType.test.ts` matches four siblings and keeps the factory
file's stated scope true. R1-A cited `mediaStore.deleteObject.test.ts:13-20` as
the house style for exactly this assertion; the revision took the assertion shape
and not the location.

---

## 21. [LOW] The stem is never re-trimmed after splitting or capping, so a trailing space can reach the emitted name

**What is wrong.** `sanitizeName` trims the WHOLE name (plan `:722`), but the
stem is taken after `splitName`, so `report .txt` yields stem `report ` and the
emitted `report .mp4`. The 100-character cap can also land on a space. Trailing
spaces in filenames are a mild annoyance on Windows (Explorer strips them, some
tools do not).

Cosmetic, and no test asserts otherwise; noting it because the trailing-DOT case
next to it was considered important enough to strip twice.

---

## Executability sweep (charge 3)

Everything below I checked rather than assumed. All of it is fine.

- **Every command runs.** `cd app && npx vitest run test/<file>` x5,
  `cd dashboard && npx vitest run src/routes/contact/`, `npm run typecheck`
  (which really does cover `app/scripts` and `app/test` -
  `app/package.json`: `tsc -p tsconfig.json && tsc -p tsconfig.scripts.json && tsc -p tsconfig.test.json` -
  so Task 5 Step 5's "run typecheck to find the doubles" works; note this is
  load-bearing, because vitest strips types through esbuild and would not).
- **The e2e invocation is safe and sanctioned.** `cd e2e && npx playwright test <spec>`
  resolves to the same entry point as `npm run e2e` (root: `npm run e2e -w @housingchoice/e2e`;
  e2e workspace: `playwright test`), so it loads `e2e/playwright.config.ts`, which
  allocates a lane synchronously (`:44-87`) and boots the hermetic stack via
  `webServer` (`:183-197`). It satisfies AGENTS.md's e2e-workspace-only rule and
  cannot reach the human's live lane.
- **`page.request.get(mediaHref!)` with a relative href works** - `baseURL` is set
  at `e2e/playwright.config.ts:153`, and `page.request` carries the page's session
  cookie, as the plan's comment claims.
- **Every file path exists or is explicitly created**, including the corrected
  `fake-twilio/web/public/canned/` location.
- **Every line citation I spot-checked is accurate**: `api.ts:23` (unused
  `normalizeStoredMediaType`; `isInlineMediaType`'s only live use is `:2292`,
  which Task 3 replaces), `api.ts:2283-2298`, `apiRoutes.test.ts:600-632` and
  `:648`/`:661`, `mmsMedia.test.ts:229`, `Timeline.tsx:604-608`/`614-617`/`640`/`652`/`658`/`667`,
  `MediaGallery.tsx:36`/`:56`, `Timeline.test.tsx:552`/`:555`,
  `Timeline.email.test.tsx:88`/`:107`, `messaging.ts:390-399`,
  `mediaMirror.ts:67-69`, `webhooks/twilio.ts:440-448`, `jobs/mediaMirror.ts:150-160`,
  `RUNBOOK.md:257,260`, `import-apply.ts:30-34`.
- **The ASCII constraint was corrected properly** - it now distinguishes
  `Timeline.tsx`'s `String.fromCodePoint` escapes from `MediaGallery.tsx:56`'s
  literals, and extends the rule to the test fixtures via `String.fromCharCode`,
  which is why every non-ASCII value in Tasks 2 and 3 is built rather than pasted.
- **`merged`'s positional identity is now stated and justified** (plan `:1833-1838`),
  answering R1-A #8 - correctly grounded in `mediaPointerSk` and `/media/:idx`.
  Note it is stated but still not TESTED: no case in Task 6 has one repairable
  and one unrepairable attachment on the same row asserting the array handed to
  both writes still has length 2 with the untouched entry at its index. The new
  `'skips an attachment already carrying a real type'` test is a one-attachment
  row, so a filtered `merged` would still pass it.

## Verdict

**The plan is buildable.** The eight blocking defects are genuinely fixed and I
verified every one by trace. Findings 1-5 should be corrected before handing it
to a builder - they are twenty minutes of edits and they are the difference
between "pastes and compiles" and "pastes, fails gate 1 four times, and starts
distrusting the rest of the document". Findings 6, 7, 9, 10, 12 and 13 are the
ones that would still be wrong in production if nobody touched them.
