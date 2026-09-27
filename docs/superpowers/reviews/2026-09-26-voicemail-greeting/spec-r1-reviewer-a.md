# Spec review R1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md` (DRAFT 1)
Worktree: `W:\tmp\voicemail-greeting` @ 7cb62edc (base main 0dafe3c1)
Date: 2026-09-26

Every claim about existing behavior below cites a file:line that was read.
Anything not verifiable from the repo is marked UNVERIFIED.

## Summary list

1. [HIGH] Webhook fallback has no time bound: a slow/hung store never throws, so the "never fail because of the greeting" guarantee is not delivered
2. [MEDIUM] "Never buffer the whole file" is undeliverable through S3MediaStore.put (lib-storage buffers every accepted greeting whole); the atomicity rationale is wrong; the through-EC2 route departs from the recorded direct-to-S3 decision without saying why
3. [MEDIUM] The file name rides the query string and is exported on every OTel server span, contradicting "never logged"
4. [MEDIUM] Empty `file.type` contradiction: the client lets it through "for the server to decide by header", the server rejects it at step 2 with the M4A message before any sniff
5. [MEDIUM] Existing `VoiceSection.test.tsx` is an unenumerated surface: the new hook fires an unmocked `getSettings`, and a load-error alert collides with its four `findByRole('alert')` assertions
6. [MEDIUM] fake-twilio greeting classification is order-blind: every voicemail TwiML has a `<Say>` (the thanks), so `'say'` is always reported and e2e step 4 proves nothing about the fallback prompt
7. [MEDIUM] Contradiction on the "no greeting set" WARN: decision 3 and section 1 say WARN; section 4.6 and the section 7 verification say no log
8. [LOW] The media bucket is versioned: Remove and Replace never delete the audio; "removing clears both" is not what DeleteObject does here
9. [LOW] Partial-failure states the spec does not enumerate: upload-vs-remove interleave leaves a record with no object; an audit failure after commit answers 500 while the new greeting is live
10. [LOW] Stored `s3Key` is a second source of truth for a constant; the projection accepts any non-empty key, so a malformed record can make the webhook `<Play>` (or the audio route stream) any object in the bucket
11. [LOW] `req.pipe(gate)` instead of `stream.pipeline` (AGENTS.md rule); unbounded drain on chunked bodies; client aborts log at ERROR; the open `mms-upload-endpoint-hardening` issue describes this exact design and is not referenced
12. [LOW] Dashboard direct `fetch` cannot reuse client.ts's private error shaping and skips `noteServerDate` (D8 "EVERY response"); the mirrored `SettingsPatch` type will advertise `voicemailGreeting` as patchable
13. [LOW] Test-fake misdescriptions: the harness mediaStore does not record heads or presigns and has no head-failure seam that test (d) needs; `settings.test.ts` repo tests use a stubbed DocumentClient, not DynamoDB Local
14. [LOW] MP3 sniff accepts ADTS AAC; Twilio-side `<Play>` fetch/decode failure behavior is UNVERIFIED and the "voicemail greeting played" INFO only proves TwiML was emitted
15. [LOW] `req.query.name` is not `string | undefined` in Express 5; the 120-char cap by UTF-16 code units can split a surrogate pair

---

## 1. [HIGH] Webhook fallback has no time bound

**What is wrong.** Decision 3 ("The webhook must never fail because of the
greeting") and section 4.6 ("A slow or failing store degrades to `<Say>`
through the catch, never to a webhook 5xx") rely on the try/catch in the
helper. A FAILING store throws and is caught. A SLOW or HUNG store does not
throw at all, so the catch never runs and no TwiML is sent.

**Evidence.**
- The S3 client is built with no request handler options:
  `app/src/adapters/mediaStore.ts:380-396` (`new S3Client({ region, ...endpoint/creds })`).
- The installed `@smithy/node-http-handler` 4.9.13 has no default request or
  connection timeout: `resolveDefaultConfig` passes `requestTimeout` /
  `connectionTimeout` through as `undefined`
  (`node_modules/@smithy/node-http-handler/dist-cjs/index.js:407-413`), and
  even a configured `requestTimeout` only WARNs unless `throwOnRequestTimeout`
  is set (`:79-98`).
- `MediaStore.head` takes no abort signal (`mediaStore.ts:120`, `:244-268`).
- The DynamoDB client used by `getOrgSettings` also has no timeout
  (`app/src/lib/dynamo.ts:65`, `:71-78`); the `/status` miss path does not
  read settings today (the only settings reads in voice.ts are `:771` in
  `/voice` and `:2350` elsewhere), so this feature ADDS both an unbounded
  GetItem and an unbounded HeadObject in front of the voicemail TwiML.
- The code already documents what happens when `/status` does not return
  TwiML: Twilio plays "an application error has occurred"
  (`app/src/routes/webhooks/voice.ts:1854-1858`), and it names the ~15s
  webhook budget (`voice.ts:723`).
- The repo has precedents for bounding a network call:
  `app/src/adapters/cloudwatch.ts:73-76` (NodeHttpHandler with connection and
  request timeouts), `app/src/lib/eventBridge.ts:56` (`AbortSignal.timeout(2000)`).

**What it implies.** During an S3 brown-out or a stalled socket the caller
hears Twilio's application error and NO voicemail is recorded - the exact
outcome decision 3 forbids, caused by the greeting code. The spec must bound
the whole greeting lookup (GetItem + HEAD + presign) with an explicit budget
(e.g. a `Promise.race` against a ~2-3s timer, or an `abortSignal` threaded
through a new `head` option), treat the timeout as a failure (WARN, `<Say>`),
and add a webhook test where `head` never settles. Test (d) as written
("head throwing") does not cover this.

## 2. [MEDIUM] "Never buffer the whole file" is undeliverable through S3MediaStore.put

**What is wrong.** Decision 2 says "never buffer the whole file"; 4.1 calls the
gate "streams, no whole-file buffer"; 4.3 argues a previously stored greeting
is never replaced by a partial one because "S3MediaStore.put aborts the
multipart upload" and "S3 commits a multipart object only on completion".
None of that describes what the mechanism does.

**Evidence.**
- `S3MediaStore.put` hands the Readable to lib-storage `Upload` with no
  `partSize` (`app/src/adapters/mediaStore.ts:162-171`). lib-storage 3.1070.0
  sets `partSize = max(MIN_PART_SIZE, ...)` with `MIN_PART_SIZE = 5 MiB`
  (`node_modules/@aws-sdk/lib-storage/dist-cjs/index.js:183`, `:220-221`).
- `getChunkStream` accumulates chunks and only yields a part while
  `currentBuffer.length > partSize` (strictly greater), otherwise it yields the
  whole accumulated buffer as `lastPart` at stream end, `Buffer.concat`-ed
  (`index.js:84-106`). A first part that is also the last part goes out as ONE
  `PutObject` (`index.js:335-336`).
- `VOICEMAIL_GREETING_MAX_BYTES = 5 * 1024 * 1024` (spec 4.1) equals
  `MIN_PART_SIZE`, so EVERY accepted greeting is held entirely in memory (plus
  a concat copy) and sent as a single PutObject. Multipart never starts; the
  abort path the spec cites never runs.
- The conclusion "never replaced by a partial one" still holds, but for a
  different reason: nothing is sent to S3 until the body has ended cleanly.
- The repo has a recorded decision to keep upload bytes OFF the single EC2
  instance: `docs/superpowers/specs/2026-07-15-unit-photos-direct-upload-revision.md:14-25`
  ("move the bytes OFF EC2 entirely"), and MMS followed it
  (`app/src/routes/api.ts:697-700`). The direct path needs no new infra: the
  CSP already allows the bucket origin in `connect-src` (`app/src/app.ts:259-277`)
  and the bucket CORS rule allows POST from dashboard origins
  (`infra/modules/s3_media/main.tf:47-58`). Section 2 names the precedent but
  the spec never says why it departs from it.
- UNVERIFIED: whether CloudFront's `origin_read_timeout = 30`
  (`infra/modules/cloudfront/main.tf:114`) can fire during a slow viewer upload
  of a 5 MB body before the app answers; if it can, the admin sees an error
  while the put and record write still complete.

**What it implies.** Either (a) keep the through-app route and restate the
guarantee honestly ("no app-level buffer; lib-storage holds at most one 5 MiB
part, which for this cap is the whole file; atomic because a single PutObject
is sent only after the gate ends"), fix the 4.3 rationale, and justify the
departure from the 2026-07-15 decision; or (b) use the established
presigned-POST + confirm pattern (confirm sniffs the first 12 bytes with a
ranged `getStream`, then copies to the fixed key), which delivers "never
buffer" literally. As written, a reviewer checking decision 2 against the
build will find it violated.

## 3. [MEDIUM] The file name is exported on OTel spans, contradicting "never logged"

**What is wrong.** Assumption C says the display name "is never logged";
4.10 lists the file name under "Never log". 4.3 puts the name in the query
string (`?name=<encodeURIComponent(file.name)>`).

**Evidence.**
- The incoming-span hook rebuilds `http.url` / `http.target` (and `url.query`
  in stable mode) from `req.url` INCLUDING the query string, masking only
  phones and signed-query parameter names
  (`app/src/lib/otel.ts:89-120`, regex at `:76`).
- Deployed dev and prod export traces:
  `.env.dev.example:249`, `.env.prod.example:274`
  (`OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318`).
- The request logger and error handler are NOT a leak (they log `req.path`
  only: `app/src/middleware/requestLogger.ts:36`, `app/src/lib/errors.ts:178-197`),
  and CloudFront has no access logging (no `logging_config` in
  `infra/modules/cloudfront`). The span is the leak.

**What it implies.** Every upload exports the file name to the trace backend.
Send it in a request header instead (e.g. `X-Greeting-File-Name`,
URI-encoded; the CloudFront origin request policy forwards viewer headers and
the request logger's header allowlist excludes it,
`requestLogger.ts:14-21`), or drop the guarantee.

## 4. [MEDIUM] Empty `file.type`: client and server contradict each other

**What is wrong.** 4.7: "an empty `file.type` with a `.mp3`/`.wav` extension is
allowed through to the server, which decides by header". 4.3 sends
`Content-Type: file.type` (empty) and step 2 rejects any Content-Type that
`normalizeGreetingContentType` does not map - BEFORE the gate ever sniffs. The
server never "decides by header" in that case.

**Evidence.** Spec 4.3 steps 2 and 4 (sniff runs only in step 4); 4.1
`normalizeGreetingContentType` returns undefined for anything outside the three
types, empty included; 4.7 client pre-check wording.

**What it implies.** A valid MP3 whose browser-reported type is empty is
refused with "iPhone voice memos are M4A", which is false for that file, and
the client branch that "lets it through" is dead code. Pick one: the client
infers `audio/mpeg` / `audio/wav` from the extension before sending, or the
server treats an ABSENT Content-Type as "sniff decides". Add the case to the
route tests. (UNVERIFIED which browsers report empty, `audio/mp3`,
`audio/wave` or `audio/vnd.wave` for these extensions; decision 1's type list
is given, but the empty-type branch is the spec's own addition.)

## 5. [MEDIUM] Existing `VoiceSection.test.tsx` is an unenumerated surface

**What is wrong.** The block is rendered INSIDE `VoiceSection` and its hook
calls `getSettings()` on mount (4.7). The existing VoiceSection test file is
not mentioned anywhere in section 5 or 4.9.

**Evidence.**
- `dashboard/src/routes/settings/VoiceSection.test.tsx:14-22` mocks only
  `getVoiceMe`, `startCellVerify`, `confirmCellVerify` and spreads the actual
  module, so `getSettings` runs for real.
- No global fetch stub exists (`dashboard/src/test/setup.ts`), so a relative
  `fetch('/api/settings')` under jsdom fails and `requestWithStatus` turns it
  into `ApiError(0, 'network_error')` (`dashboard/src/api/client.ts:106-117`).
- The spec does not say what the block renders on a LOAD failure; the local
  pattern for a load failure is a `role="alert"` block
  (`dashboard/src/routes/settings/VoiceSection.tsx:98-104`), and 4.7 says errors
  render as `role="alert"`.
- Four existing assertions use the singular `findByRole('alert')`
  (`VoiceSection.test.tsx:96`, `:131`, `:147`, `:159`); a second alert makes
  them throw "multiple elements". The e2e `voice-outbound.spec.ts:690` also
  asserts zero alerts on `/settings/voice`.

**What it implies.** Specify the load-failure rendering of the block, and add
`VoiceSection.test.tsx` (mock `getSettings`) and `voice-outbound.spec.ts:690`
to the surfaces the build must keep green.

## 6. [MEDIUM] fake-twilio greeting classification is order-blind

**What is wrong.** 4.8 defines `'play'` if the Response has a `Play`, else
`'say'` if it has a `Say`, else `'none'`. The voicemail TwiML ALWAYS contains a
`<Say>` after `<Record>` (the thanks), and the parser discards sibling order.

**Evidence.**
- `reply.say(resolveMessage('voice.voicemail_thanks'))` follows `<Record>` on
  every voicemail offer (`app/src/routes/webhooks/voice.ts:1894`).
- `interpretTwiml` uses `fast-xml-parser` without `preserveOrder`
  (`fake-twilio/src/engine/twimlInterpreter.ts:20`), so it cannot tell a `Say`
  before `<Record>` from one after it.

**What it implies.** `'none'` is unreachable for the app's TwiML, and e2e
step 4 (`voicemailGreeting === 'say'` after Remove) passes even if the build
drops the fallback prompt entirely - it only proves `<Play>` is gone. The
"boundary proof" is weaker than claimed. Define the field as "the verb
immediately preceding `<Record>`" and parse with `preserveOrder: true` (or
count `Say` elements), and pin it in the fake-twilio unit test with a
Say+Record+Say document versus a Record+Say document.

## 7. [MEDIUM] "No greeting set" WARN: the spec contradicts itself

**What is wrong.** Decision 3 (given, not reopenable): "If no greeting is set,
or the object is missing, or the check fails, it falls back to today's `<Say>`
unchanged and logs a WARN". Section 1: "any problem with it (no greeting set,
...) ... writes one WARN line". Section 4.6 code logs nothing when
`greeting === undefined`, and section 7 says the second call (after Remove)
logs "nothing greeting-related".

**Evidence.** Spec sections 1, 3 (decision 3), 4.6, 7.

**What it implies.** A builder following decision 3 literally WARNs on every
missed call for every org that never uploads (the default state), and the
section 7 verification then fails; a builder following 4.6 silently departs
from a "given" decision. The spec must state which reading it adopts and flag
it as an interpretation for the handback.

## 8. [LOW] Versioned bucket: Remove and Replace never delete the audio

**What is wrong.** Decision 2: "removing clears both". 4.4 calls
`deleteObject` and 4.3 says replace "overwrites the object".

**Evidence.** The media bucket has versioning `Enabled`
(`infra/modules/s3_media/main.tf:13-18`) and no lifecycle rule (none in
`infra/modules/s3_media/main.tf`). On a versioned bucket DeleteObject only adds
a delete marker and PutObject creates a new version; prior versions persist.

**What it implies.** Sam's recorded voice is retained indefinitely after
Remove, and every Replace adds a noncurrent version (bounded only by the
10/min admin rate limit). Accepting that is reasonable, but the spec should
say so instead of claiming the audio is cleared.

## 9. [LOW] Unenumerated partial-failure states

**What is wrong.** 4.3 analyzes only "settings write fails after the put" and
"two admins upload at once".

**Evidence / cases.**
- Upload and Remove interleave: PUT's `put` completes, DELETE removes the
  record and deletes the object, PUT then writes the record. Result: a record
  with no object. The webhook WARNs and says the prompt on every missed call,
  and the dashboard shows a greeting whose player 404s, until someone
  re-uploads. Degrades safely but persists.
- `audit.append` failing AFTER the record write (4.3 step 5 awaits it; the
  existing settings PUT does the same, `app/src/routes/settings.ts:219-223`)
  answers 500, so the UI says "Couldn't upload the greeting" while callers
  already hear the new one.

**What it implies.** Name both states as accepted, or make the audit append
best-effort after the commit.

## 10. [LOW] Stored `s3Key` is a second source of truth

**What is wrong.** `s3Key` is "always VOICEMAIL_GREETING_S3_KEY today" (4.2),
yet the projection accepts any non-empty string and the webhook presigns
`greeting.s3Key` (4.6). The claim "a bad record can never make the webhook
`<Play>` a nonsense URL" holds only as far as "non-empty".

**Evidence.** Spec 4.2 projection rule; 4.6 snippet uses `greeting.s3Key` for
HEAD and presign; the same bucket holds call recordings
(`recordings/<callSid>/<recordingSid>`, `voice.ts:2033`) and MMS media.

**What it implies.** A hand-edited or corrupted record naming a recording key
would play one caller's voicemail to every caller, and the audio route (if it
streams the recorded key) would serve it to any logged-in user. Require
`s3Key === VOICEMAIL_GREETING_S3_KEY` in the projection, or read the constant
in both readers and drop the field.

## 11. [LOW] `req.pipe` instead of `stream.pipeline`; drain and abort handling

**What is wrong.** 4.3 step 4 wires `req.pipe(gate)` plus a manual
`req.on('error')`. AGENTS.md: "Media movement uses streams
(`stream.pipeline`)". `pipe()` neither destroys the source when the
destination errors nor guarantees an error listener on the destination; the
design is safe only because lib-storage attaches its async iterator
synchronously inside `put` (`lib-storage/dist-cjs/index.js:230-235`, `:408`),
which the spec does not state as a requirement (any `await` between the pipe
and the put opens an unhandled-'error' window).

Also: `req.resume()` drains an unbounded body when there is no Content-Length
(the only case in which `too_large` can fire, since Node enforces a declared
length); a client that cancels mid-upload lands in "any other error -> 500
upload_failed with an ERROR log", which is noise, not a server fault.

**Evidence.** Spec 4.3 step 4; `docs/issues/mms-upload-endpoint-hardening.md:13-24`
records the same trade-offs for the retired through-EC2 MMS endpoint
(read-whole-body-before-413; suggested fix: destroy the socket after writing
the 413) and is not referenced.

**What it implies.** Use `pipeline(req, gate, ...)`, classify client aborts
separately (WARN or INFO), and decide explicitly between drain and
destroy-after-response for the chunked over-cap case.

## 12. [LOW] Dashboard direct fetch and mirrored types

**What is wrong.** 4.7 says the direct `fetch` produces an `ApiError` "from the
JSON body" and `client.ts` is not edited.

**Evidence.**
- `parseBody` and `errorFrom` are module-private
  (`dashboard/src/api/client.ts:58-79`), so the new endpoint must duplicate
  them.
- `requestWithStatus` feeds EVERY response's `Date` header to
  `noteServerDate` by rule (retry-send-window D8, `client.ts:119-125`); a
  direct fetch skips it. The presigned-POST precedent
  (`dashboard/src/api/endpoints.ts:1175`) targets S3, not this API, so it is
  not an analogous precedent.
- `SettingsPatch = Partial<Omit<OrgSettings, 'welcomeText'>> & ...`
  (`dashboard/src/api/types.ts:140`) will type `voicemailGreeting` as
  patchable once it is added to the `OrgSettings` mirror, although the server
  ignores it (4.2). The app-side `SettingsPatch` in
  `app/src/routes/settings.ts:59` has the same shape.

**What it implies.** Either export the two helpers from `client.ts` (a small
edit) or accept the duplication explicitly; call `noteServerDate`; and `Omit`
`voicemailGreeting` from both `SettingsPatch` types.

## 13. [LOW] Test-fake misdescriptions

**What is wrong.** Section 5 says the harness's fake `mediaStore` "already
records puts/heads/presigns/deletes" and relies on it for test (d) ("head
throwing").

**Evidence.** `app/test/helpers/twilioWebhookHarness.ts:3870-3992`: `put`
records `mediaPuts`, `deleteObject` records `deletedMediaKeys` and honors
`failMediaDeletes`; `head` and `presign` record nothing (presign only bumps a
counter), and there is no seam to make `head` (or `getOrgSettings`) throw.
Section 5 also says the repo tests run "against the DynamoDB Local repo like
the existing repo tests"; `app/test/settings.test.ts:7-24` drives the repo
through stubbed `GetCommand`/`UpdateCommand` on a fake DocumentClient (the
DynamoDB Local suite is `app/test/m14.integration.test.ts:80`).

**What it implies.** Add a head-failure seam (e.g. `failMediaHeads`) and, for
finding 1, a never-settling head seam to the 4.9 surfaces; name the right test
file for the projection tests.

## 14. [LOW] Sniff gaps and what "played" means

**What is wrong.**
- The MP3 rule `head[0] === 0xff && (head[1] & 0xe0) === 0xe0` also accepts
  ADTS AAC (sync `0xFFF1` / `0xFFF9`, whose layer bits are `00`), so an AAC
  file declared `audio/mpeg` passes both checks. Requiring non-zero layer bits
  (`(head[1] & 0x06) !== 0`) excludes it.
- UNVERIFIED: what Twilio does when a `<Play>` URL cannot be fetched or
  decoded (skip to the next verb vs. application error). Decision 3's fallback
  covers app-side failures only; if Twilio aborts the call on a bad `<Play>`,
  an unplayable upload loses every voicemail. Worth one dev check.
- The `voicemail greeting played` INFO (4.6) is written when the TwiML is
  emitted, not when Twilio plays it; section 7 uses it as evidence the caller
  heard the audio.

**What it implies.** Tighten the sniff, record the Twilio behavior as a
verified fact or a known risk, and rename the log line (e.g. "voicemail
greeting offered").

## 15. [LOW] `?name=` parsing edge cases

**What is wrong.** 4.3 passes `req.query.name` to
`sanitizeGreetingFileName(raw: string | undefined, ...)`. In Express 5
`req.query` values can be `string | string[] | ParsedQs` (`?name=a&name=b`).
The 120-character cap by UTF-16 code units can cut a surrogate pair and store
a lone surrogate; UNVERIFIED whether DynamoDB rejects it (if it does, the
record write fails AFTER the put - the 4.3 "stale record" state).

**What it implies.** Coerce non-string values to undefined and cap by code
points. Moot if finding 3 moves the name to a header.

---

## Claims in section 2 verified as correct (no finding)

- The voicemail offer is only at `voice.ts:1873-1900`; `/voicemail-done` says
  the thanks only (`voice.ts:2119-2121`); `voice.voicemail_prompt` has no other
  caller in `app/src`, `fake-twilio/src`, `e2e` or `dashboard/src`.
- `/voice` defended settings read: `voice.ts:769-778`.
- MediaStore contract: `mediaStore.ts:79-154`, `head` 404 -> undefined
  (`:244-268`). HEAD on a missing key returns 404 (not 403) because the EC2
  role has `s3:ListBucket` (`infra/modules/ec2/main.tf:74-77`).
- IAM covers the new key: `s3:GetObject/PutObject/DeleteObject` on
  `${media_bucket_arn}/*` (`infra/modules/ec2/main.tf:64-72`); no infra change
  needed. `/api` is in `EDGE_MUTATING_PREFIXES` (`app/src/app.ts:76`) and the
  CloudFront `/api/*` behavior allows PUT/DELETE
  (`infra/modules/cloudfront/main.tf:158-169`).
- Body parsers: only `express.json` / `express.urlencoded` are global
  (`app/src/app.ts:136-137`); `trimJsonBody` acts only on JSON
  (`app/src/middleware/trimStrings.ts:45`); no JSON-only guard in the `/api`
  chain; `csrfOrigin` is a header compare (`app/src/middleware/csrfOrigin.ts:47-66`).
- Settings route shape, `parsePatch` allowlist and audit event:
  `app/src/routes/settings.ts:61-164`, `:179-243`. `requireRole` answers 403
  `{ error: 'forbidden' }` (`app/src/middleware/auth.ts:235-247`);
  `SessionUser` carries `userId` and `email` only (`auth.ts:39-43`).
- Only `lean.ts:527` and `matrix.ts:1347` write the `org` row (full-item Put,
  `app/src/lib/seed/index.ts:153`), and reseed clears every table first
  (`app/src/lib/devReset.ts:101-107`); no MinIO touch.
- `settingsToOverrides` reads named fields only
  (`app/src/messages/resolve.ts:82-87`); no `app/src` log line spreads the
  settings object; no dashboard code spreads `settings` into a form.
- Recording route behavior as described (`app/src/routes/api.ts:2273-2361`);
  the range/416/404/cache tests exist (`app/test/voiceRecording.test.ts:374-526`).
- fake-twilio: `interpretTwiml` returns `record` whenever `Record` exists
  (`twimlInterpreter.ts:72-81`); `CallState` has no greeting field
  (`fake-twilio/src/engine/voiceTypes.ts:60-77`); `GET /control/calls`
  returns `getCalls()` verbatim (`fake-twilio/src/routes/voiceControl.ts:123-125`);
  the e2e `FakeCall` has an index signature (`e2e/fixtures/fakeVoice.ts:28-32`),
  so no e2e type mirror needs editing.
- The harness settings fake is hand-enumerated and must learn the field
  (`app/test/helpers/twilioWebhookHarness.ts:2289-2314`) - correctly listed in 4.9.
