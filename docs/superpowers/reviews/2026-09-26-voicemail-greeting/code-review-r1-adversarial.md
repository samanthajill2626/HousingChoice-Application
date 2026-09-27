# Code review R1 - adversarial (fresh eyes)

Branch `feat/voicemail-greeting` @4efb04a3 vs merge base 0dafe3c1 (main).
Inputs: `.superpowers/review/diff-package-r1.txt`, the repository, AGENTS.md.
Nothing under `docs/superpowers/` was read. Every probe was a throwaway
`zz-review-probe-*` file, run with single-file vitest and deleted afterwards.

## Verdict

No MUST-FIX. The riskiest mechanism holds up. That mechanism is the streamed
sniff-and-cap upload: `req.pipe` plus a drain, instead of `pipeline`. I drove
it end to end through the REAL `S3MediaStore` and `@aws-sdk/lib-storage`
3.1070.0 against a local fake-S3. The route tests only ever use the harness's
fake `put()`. Results:
- an exactly-5-MiB body goes out as ONE PutObject;
- a body of 5 MiB + 1 byte, a sniff refusal and a mid-upload client abort each
  send ZERO requests to S3, and each is classified correctly (413 / 400 / one
  WARN `client_aborted`, no ERROR).

The webhook fallback is sound, and so is the fixed-key projection in the real
repo. The infra paths also hold: CloudFront behaviors and header forwarding,
the IAM grants, and no lifecycle or sweep that could expire or delete the
fixed key. One real defect class remains: greeting writes are not serialized.
Two admin writes landing inside one put-to-record window leave a persistent
inconsistent state (A1). The rest are NOTEs:
- a stream-lifecycle weakness in the shared serve helper, inherited from the
  recording route (A2);
- two comment and ledger accuracy issues (A3, A9);
- permissive edge-input handling (A4, A7);
- a small UI state bug (A5);
- two test-strength gaps (A6, A8).

## Findings

### A1 - SHOULD-FIX - CONFIRMED - concurrent greeting writes are not serialized: PUT/DELETE leaves a live record with no object; PUT/PUT leaves a record describing the other upload's bytes

Where: `app/src/routes/settings.ts:361-407` (the upload does put, then the
record SET) and `app/src/routes/settings.ts:432-435` (the delete does the
record REMOVE, then deleteObject). Both write the same fixed key and the same
map with no coordination.

Interleaving 1 (PUT vs DELETE):
1. Admin A `PUT`: `mediaStore.put` resolves, so the object holds A's bytes (`:362-367`).
2. Admin B `DELETE`: `putOrgSettings({ voicemailGreeting: null })` removes the record (`:432`).
3. Admin B `DELETE`: `deleteObject` runs, the object is gone, and B gets 204 (`:435`).
4. Admin A `PUT`: `putOrgSettings({ voicemailGreeting: A })` sets the record, and A gets 200 (`:407`).

Final state: the record says greeting A exists, but there is no object. Both
admins were told they succeeded. `GET /api/settings` lists A, and the audio
route answers 404. On EVERY missed business-line call the webhook's HEAD
returns undefined. Each such call logs WARN "voicemail greeting object
missing" and plays the built-in prompt. This never self-heals; it lasts until
someone re-uploads or removes the greeting.

Interleaving 2 (PUT vs PUT): A put -> B put -> B record -> A record. The object
holds B's bytes and the record holds A's metadata. The UI shows A's name, size
and date (and A's `?v=` cache-buster), while callers hear B.

Evidence: I used a probe with the harness, where `putOrgSettings` was wrapped
to pause A's record write until B had finished.
- PUT/DELETE: upload 200, DELETE 204. Final record `{"fileName":"new.wav",...}`,
  `objectPresent false`. `GET /api/settings` lists `new.wav`. The audio GET
  returns `404 {"error":"greeting_not_found"}`.
- PUT/PUT: the record is `{"fileName":"A.mp3","contentType":"audio/mpeg","sizeBytes":427}`.
  The object is `audio/wav`, 144 bytes, and is served as `audio/wav`.

Likelihood: low. It needs two admin writes inside one put-to-record window,
from two admins or two tabs. Within one tab the UI's `busy` flag prevents it.
But the outcome is persistent, and callers silently lose the greeting.

Minimal fix: serialize the two write sections in-process. The app is
explicitly a single process; see the SINGLE-INSTANCE ASSUMPTION note in
`middleware/rateLimit.ts`. Use a router-level promise-chain lock held across
[put + record SET] and [record REMOVE + deleteObject], so a DELETE waits for
an in-flight upload (at most 5 MiB). This also caps concurrent uploads at one
(see A3).

Multi-instance-safe alternative: store the PutObject `VersionId` in the
record, and HEAD/presign/GET that version. The bucket is versioned, so a later
delete marker or overwrite cannot desynchronize the record from its bytes. Add
one interleaving test with the paused-record-write seam above.

### A2 - NOTE - CONFIRMED (mechanism) / PLAUSIBLE (production impact) - `serveMediaObject` never destroys the store body when the client leaves mid-stream

Where: `app/src/routes/serveMediaObject.ts:90-94` (`object.body.on('error', ...)`
plus a bare `object.body.pipe(res)`).

Scenario: a browser loads `<audio preload="metadata">` on the Voice tab. Every
viewer does this whenever a greeting is set (`VoicemailGreetingBlock.tsx`,
`preload="metadata"`). The browser stops or cancels the response after reading
metadata. `pipe` unpipes on `res` close, but it leaves the source open and
paused. In production the source is the S3 GetObject IncomingMessage. Its
pooled socket (SDK default maxSockets 50) stays checked out until S3 drops the
idle connection. That drop then emits `'error'`, which logs a level-50 line;
level-50 lines count toward `hc-<env>-error-logs` and `-error-logs-sustained`
(`infra/modules/observability/main.tf:50-56,150-188`).

Evidence: I ran a probe that calls `serveMediaObject` over a PassThrough body.
The client destroyed its request after the first chunk. 300 ms later,
`body.destroyed = false` and `readableFlowing = false`: the body was
unpiped, paused and still open. Destroying the body afterwards (standing in
for the upstream reset) produced ERROR `"voicemail greeting stream errored
mid-flight"`.

Context: this is pre-existing. The recording route had exactly this code
(moved here unchanged), and the MMS media route (`app/src/routes/api.ts:2400-2404`)
and unit-media route (`app/src/routes/unitMediaServe.ts:73-77`) use the same
pattern. This diff adds a frequently hit consumer, and it makes this helper
the single place to fix the problem for two routes.

Minimal fix: in the helper, add
`res.on('close', () => { if (!res.writableFinished) object.body.destroy(); })`.
Alternatively, use `stream.pipeline(object.body, res, cb)` and log only
non-premature-close errors. Add a test that aborts the client and asserts
`body.destroyed`. Or file a `docs/issues/` entry covering all three routes.

### A3 - NOTE - CONFIRMED - "the app never holds the file" is false: lib-storage buffers the whole accepted greeting in memory

Where: `app/src/lib/voicemailGreeting.ts:78-85` (GreetingUploadGate docstring:
"so the app never holds the file") and the matching claim in the route
comment block at `app/src/routes/settings.ts:304-322`.

Evidence: the real-store probe (above) sent a chunked, exactly-5-MiB upload.
The fake-S3 server saw ONE `PUT ...?x-id=PutObject` of 5,242,880 bytes, sent
only after the request stream ended. lib-storage's `getChunkStream` only
yields a part once its buffer exceeds `partSize` (5 MiB) or the stream ends
(`node_modules/@aws-sdk/lib-storage/dist-cjs/index.js:84-106`). So every
accepted greeting is fully resident in process memory, plus a concat copy.

Consequence: memory per in-flight upload is up to ~5 MiB, held for the
upload's lifetime. A slow chunked upload holds its partial buffer until
Node's default 300 s `requestTimeout`. The limiter bounds the rate (10 per
minute per admin), not concurrency. This is the same behavior as the
existing `put()` callers. But AGENTS.md says whole-file buffers are
forbidden, and this comment asserts the opposite of what happens.

Minimal fix: correct both comments to state the real bound ("at most one
5 MiB part buffered by lib-storage before a single PutObject"). A1's lock
also caps concurrency at one upload.

### A4 - NOTE - CONFIRMED - the header sniff accepts 3-4 byte bodies as a live greeting

Where: `app/src/lib/voicemailGreeting.ts:61-65` (`ID3` needs 3 bytes; a frame
sync needs 2 bytes plus a layer check) together with `_flush`, which sniffs
whatever is held. The client pre-check only refuses size 0
(`useVoicemailGreeting.ts`).

Evidence: I sent two uploads through the harness:
- `PUT` body `ID3` (3 bytes) -> 200, `sizeBytes 3`, and 3 bytes stored;
- `PUT` body `FF FB 90 00` -> 200, `sizeBytes 4`.

Either becomes the live greeting, and the webhook then emits `<Play>` of an
unplayable file. That is exactly the unverified Twilio behavior in
`docs/issues/voicemail-greeting-format-normalization.md`. Any ID3-prefixed
non-MP3 (for example, ID3 followed by ADTS AAC) also passes.

Minimal fix: set a minimum accepted size (a few hundred bytes) in the gate's
`_flush` and in the client pre-check. At least name the tiny-file and
ID3-prefix cases in the existing issue.

### A5 - NOTE - CONFIRMED - any file choice clears the "file is missing" status, even when the choice is refused and the same broken player stays mounted

Where: `dashboard/src/routes/settings/VoicemailGreetingBlock.tsx:36`
(`setPlayerBroken(false)` runs BEFORE `state.upload(file)`).

Evidence: in an RTL probe, `fireEvent.error(audio)` showed the missing-file
line. I then chose `memo.m4a`, which the client pre-check refuses without
calling the endpoint. Afterwards `src unchanged = true` and
`missing-status still shown = false`. The same happens after any server
refusal (400/413/429/500). The `<audio>` never re-fires `error` because its
`src` did not change.

Minimal fix: clear `playerBroken` only when the player's `src` changes, for
example with a `key={voicemailGreetingAudioUrl(g)}` remount, or only on a
successful upload.

### A6 - NOTE - CONFIRMED - the harness settings fake skips the fixed-key projection, and both consumers read `greeting.s3Key` instead of the constant

Where: `app/test/helpers/twilioWebhookHarness.ts:2304-2306` (`getOrgSettings`
returns the raw map). Consumers: `app/src/routes/settings.ts:459` (audio route
`key: greeting.s3Key`) and `app/src/routes/webhooks/voice.ts:400,402` (HEAD and
presign of `greeting.s3Key`).

Evidence: in a probe, a harness record naming `recordings/CA1/RE1`, followed
by `GET /api/settings/voicemail-greeting/audio` as a VA, returned 200 with
`RECORDING-BYTES`.

Production is safe: `toVoicemailGreeting` pins `s3Key`. But no route or
webhook test can observe the "only the fixed key is ever served or presigned"
guarantee. If a later projection change, or a second writer of the map, lets
another key through, the audio route would start serving it to any logged-in
user.

Minimal fix: use `VOICEMAIL_GREETING_S3_KEY` at the three use sites (defense
in depth). Optionally, have the harness fake apply `toVoicemailGreeting` on
read.

### A7 - NOTE - CONFIRMED - `sanitizeGreetingFileName` keeps C1 controls, bidi overrides and zero-width characters

Where: `app/src/lib/voicemailGreeting.ts:145-156`. The docstring promises "no
control characters", but only C0 and DEL are stripped.

Evidence: in a probe,
`sanitizeGreetingFileName('a' + U+0085 + 'b' + U+202E + '3pm.exe' + U+200B + '.mp3')`
came back unchanged (code points `85`, `202e`, `200b` present). The name is
shown to every staff member. React escapes it, so the impact is display
spoofing only (for example, an RLO flipping the visible extension), and the
input is admin-only.

Minimal fix: widen the strip class to
C0 + DEL plus U+0080-U+009F, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069 and U+FEFF (written as backslash-u escapes in the regex source).

### A8 - NOTE - PLAUSIBLE - test (e) does not prove the abort signal fires at the budget

Where: `app/test/founderTriage.test.ts:1223` (case (e)). The AbortSignal path
and the `withTimeout` path log the identical WARN message. Case (e) asserts
only that a signal was PASSED (`mediaHeads[0].signal === true`).

Scenario: a regression wires `AbortSignal.timeout(<constant>)` or a longer
timeout at `voice.ts:418`. Case (e) still passes, because `withTimeout` alone
ends the lookup at 50 ms. Meanwhile the property the signal exists for,
releasing the pooled socket at the budget, is lost.

Minimal fix: in (e), assert that the WARN's `err.name` is `'AbortError'`. The
signal's timer is created first, so that is the error that wins today. Or
record the abort instant in the fake and assert it is at or below the budget.

### A9 - NOTE - CONFIRMED - the perf contract ledger citations are stale

Where: `e2e/performance/routes.ts:705,759`.
- `VoiceSection.tsx:93-127,176` now sits at `94-128,177`: the new import
  shifted it by one line (verified by printing both revisions).
- `useVoicemailGreeting.ts:1-40` covers the header and constants. The GET it
  documents is `load` at `useVoicemailGreeting.ts:92-112` (`getSettings` call
  at line 97).

Minimal fix: update both strings.

## Swept and clean (consumers and mutators checked, no finding)

**Middleware chain (`app/src/app.ts:109-142`)**
- `express.json` and `express.urlencoded` are type-gated, so audio bodies
  reach the route unread and `trimJsonBody` ignores them.
- `csrfOriginMiddleware` admits the dashboard Origin.
- The request logger's header allowlist excludes `x-greeting-file-name`
  (`middleware/requestLogger.ts:14-21`).
- Auth and limiter refusals leave the body for Node's automatic dump, so the
  connection stays reusable.

**Real storage path (probe)**
- lib-storage rethrows the ORIGINAL body error (`concurrentUploaderFailures[0]`),
  so the `instanceof GreetingRejectedError` / `GreetingClientAbortedError`
  classification holds in production.
- The gate exposes no `length`/`size`/`byteLength`, so `partSize` stays at
  5 MiB.
- `S3MediaStore.put`'s `upload.abort()` after a failure is harmless.

**Infra**
- The CloudFront `/api/*` behavior allows all methods with
  `Managed-AllViewerExceptHostHeader`, so the name header is forwarded, and
  `CachingDisabled` applies.
- No WAF body-size rule, and no reverse proxy in front of the app.
- The EC2 role grants Get/Put/Delete on `media_bucket/*` plus `ListBucket`,
  so HEAD on a missing key is a 404, not a 403.
- The media bucket has no lifecycle rule.
- No `ListObjects` or sweep consumer exists. Unit-media deletes are
  prefix-guarded (`lib/unitMedia.ts:135-150`), and outbound MMS attachment
  keys are pattern-restricted (`routes/api.ts:518`), so the fixed key cannot
  be sent as an MMS attachment.

**Settings item writers and readers**
- The only writers are `putOrgSettings` (an UpdateItem merge) and the seeds
  (a full-item Put in `seed/lean.ts:525-530` and `seed/matrix.ts:1345`). A
  reseed wipes the record.
- The e2e phone-width test leaves a greeting behind, but every spec that
  places a call reseeds, except `recording-range.spec.ts`, which only places
  answered calls.
- `contactVocabularyRepo` uses a different `settingId`.
- No log line dumps `OrgSettings`.
- The `settings_updated` audit event has no consumer outside tests.
- Every `getOrgSettings` reader reads named fields only.
- The other SettingsRepo fakes (`test/helpers/settingsStub.ts`) are
  read-only; the harness fake handles the null REMOVE.

**Refactor and interfaces**
- The `serveMediaObject` extraction is byte-identical for the recording route
  (headers, 206/416/404, log keys and messages). The imports removed from
  `api.ts` are unused.
- `MediaStore.head`'s new optional parameter is compatible with every
  implementation and `Pick` consumer.

**Webhook**
- With no greeting set, the TwiML is unchanged.
- Every lookup failure or timeout degrades to the spoken prompt.
- A late lookup result is discarded and logs nothing.
- Masked and outbound misses are untouched, and the no-holder path is
  unaffected.
- The presigned URL is never logged: `sendTwiml` does not log bodies.

**Dashboard**
- The client's `body`/`rawBody` exclusivity and 204 handling work.
- `dashboard/public/sw.js` has no fetch handler, so range requests are not
  intercepted.
- The audio is same-origin under CSP `default-src 'self'`.
- VA gating matches the server.

**Security**
- The served type comes from the S3 object the route itself wrote
  (`audio/mpeg` or `audio/wav`), plus nosniff, so there is no stored-XSS
  path.
- The file name never reaches headers, logs or TwiML.
- Every new route is gated: upload and delete require admin, and the audio
  route requires a session.

**Perf tooling and the test double**
- Template matching is exact on segment count (`e2e/performance/templates.ts:204-207`).
- The mutation catalog entries are present.
- fake-twilio's `greetingBeforeRecord` runs only on record plans.

**Repo rules**
- Added lines contain no non-ASCII bytes.
- Gate 5 (touched files) reports one error,
  `fake-twilio/src/engine/callEngine.ts:523` (`scenario` unused in
  `chooseAnsweringLeg`). It is pre-existing on main at line 506 and is not
  this branch's.
