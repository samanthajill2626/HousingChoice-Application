# Planner review - adversarial, plan-blind (feat/voicemail-greeting)

Reviewer: fresh adversarial reviewer, given NO spec, plan, worklist or prior
review. Intended behavior derived from the code and its tests only.
Worktree: `W:/tmp/voicemail-greeting` at `e271acd2` (base `main` @ `0dafe3c1`).
Package read: `.superpowers/review/planner-diff.txt` (36 feature files), plus the
whole-app greps listed under "What I checked and found sound".

Severity key: MUST = a defect a user or an attacker can hit; SHOULD = a real
weakness worth fixing before merge; NOTE = worth a sentence.

Result: 0 MUST, 1 SHOULD, 11 NOTE. The main path holds up. I checked it
empirically against the real `@aws-sdk/lib-storage` and the real S3 client (see
Evidence runs). The findings are about failure paths, contracts that lie, and
things that no hermetic test can see.

---

## 1. [SHOULD] A replace whose record write fails tells the admin "upload failed" while callers already hear the NEW file

**What is wrong.** The upload makes the object live before it writes the record.
`mediaStore.put(VOICEMAIL_GREETING_S3_KEY, ...)` overwrites the fixed key
(`app/src/routes/settings.ts:369`), and only then does the route SET the record
(`:414`). When that record write throws, the route answers
`500 greeting_record_failed` (`:420`), and the dashboard maps that code to the
generic "Couldn't upload the greeting. Try again."
(`dashboard/src/routes/settings/useVoicemailGreeting.ts:64-83`, `default:` at `:77`).
The dashboard then keeps showing the OLD greeting. The webhook never reads the
record's fields. It HEADs and presigns the FIXED key
(`app/src/routes/webhooks/voice.ts:403-407`), so every missed call from then on
plays the NEW bytes.

Two in-code claims are false for a replace:
- `settings.ts:416-418` says "the worst case is a stale name/date ... never a
  broken call". The call is fine, but the admin is told the change did NOT
  happen, and it did.
- `settings.ts:423-424` says "the greeting is LIVE once the record is written".
  For a replace, it is live once the OBJECT is written, before the record
  write. The DELETE comment's "the RECORD is the authority" (`:433-436`) holds
  for removal only. For what callers hear, the object is the authority.

**Evidence (reproduced).** A scratch `tsx` script (in the session scratchpad,
not the worktree) drove the real settings router through `makeWebhookHarness`:
upload A (`A-old.mp3`), then upload B (`B-new.wav`) with
`putOrgSettings` throwing. Output:

```
upload A: 200 A-old.mp3
replace with B (record write fails): 500 {"error":"greeting_record_failed"}
GET /api/settings says: A-old.mp3 audio/mpeg 427
object callers will be <Play>ed (fixed key): audio/wav 4044 bytes; RIFF? RIFF
in-page player URL (?v= A) serves: audio/wav 4044 bytes
```

The record now says `audio/mpeg`, 427 bytes, `A-old.mp3`. The object is a
4044-byte WAV. The in-page player's URL carries A's `?v=` cache-buster, but the
audio route streams the fixed key and ignores `v` (`settings.ts:461-481`). So
it serves B, and the browser caches B's bytes under A's URL for an hour
(`private, max-age=3600`, `:472`).

**Missing regression test.** The existing test
(`app/test/voicemailGreetingRoutes.test.ts:490-503`) covers only a FIRST
upload, where "failed" is roughly true because no record exists and callers hear
the spoken prompt. The failing input is a greeting A already set (record and
object), then an upload of B with `putOrgSettings` rejecting. Today that
answers 500 while the object is B.

**What it implies.** The trigger is a rare DynamoDB fault, but the result is
silent. An admin who gives up after "Couldn't upload" believes callers still hear
A, and nothing reconciles the state until the next upload. Cheap fixes:
- Answer a distinct code on a replace, for example "uploaded, but its details
  could not be saved - callers already hear the new file", or retry the record
  write.
- Make the record authoritative. Option 2 of
  `docs/issues/voicemail-greeting-concurrent-writes-unserialized.md` (pin the
  record to the PutObject VersionId) fixes this case too: the record would keep
  playing A's version.

---

## 2. [NOTE] The in-code sniff comment still claims AAC is refused

`app/src/lib/voicemailGreeting.ts:52-55` says "an AAC file declared as MP3 is
refused here". An ID3v2-prefixed body short-circuits to `true` at `:62`,
whatever follows the tag. Probe output (scratchpad):

```
ID3+ADTS AAC accepted as mp3: true
bare ADTS AAC accepted as mp3: false
ID3 + RIFF/WAVE accepted as mp3: true
MPEG-1 Layer II (mp2) accepted as mp3: true
```

The GAP is already filed (`docs/issues/voicemail-greeting-format-normalization.md`
item 3), but the comment still tells the next reader the opposite. Reword it to
"a BARE ADTS AAC is refused; an ID3-prefixed one is not (see the issue)".

One consequence is UNVERIFIED: Chrome's `<audio>` sniffs containers and will
likely play such a file in the Settings player. The admin's own check would then
pass while Twilio's decoder, untested here, may not.

## 3. [NOTE] The fallback covers only lookup-time failures; a Remove between HEAD and Twilio's fetch can leave the caller with only a beep

`offerVoicemailGreeting` (`voice.ts:419-450`) decides between `<Play>` and
`<Say>` before the TwiML is sent. It uses a HEAD pre-check (`:405`) whose result
can go stale before Twilio fetches the presigned URL. Walk it:
1. Missed call: GetItem sees the record and HEAD finds the object.
2. Presign, then the TwiML `<Play>` goes out.
3. An admin's DELETE clears the record and deletes the object
   (`settings.ts:439-446`).
4. Twilio GETs the presigned URL and receives 404.

The window is small, from HEAD to Twilio's fetch. What Twilio then does is
UNVERIFIED, and it is already filed as item 2 of the format-normalization
issue. I list it only because the charter asks for the interleaving. No new
action.

## 4. [NOTE] Nothing bounds the greeting's DURATION; a 5 MB cap allows about 5 minutes that every caller must sit through

The cap is bytes only (`VOICEMAIL_GREETING_MAX_BYTES`, `voicemailGreeting.ts:12`).
5 MiB of 128 kbps MP3 is about 5.5 minutes, and 8 kHz 16-bit mono PCM WAV at
16 KB/s is about 327 s. `<Play>` sits outside any `<Gather>`, so the caller
cannot skip it. The beep, and `<Record>`, come only after it ends (`voice.ts:1960-1977`).
A caller who hangs up during the greeting leaves no voicemail, and every
greeting second is billed call time on every missed call.

The UI copy steers admins toward a size model ("up to 5 MB",
`VoicemailGreetingBlock.tsx:67`). Consider rejecting on duration, which the WAV
header gives directly and MP3 gives approximately, or at least stating a
recommended length in the copy.

## 5. [NOTE] Upload memory has no global bound: each in-flight upload pins up to 5 MiB (about 10 MiB at peak) for up to Node's 300 s requestTimeout

lib-storage buffers the whole accepted body until the stream ends. That is
documented at `voicemailGreeting.ts:83-92` and `settings.ts:306-315`, and I
confirmed it: exactly 5 MiB goes to S3 as ONE `PutObject`, see Evidence runs.
The only limit is per user: 10 per minute (`settings.ts:224-229`), with nothing
on concurrency across requests. An admin session sending slow bodies (valid
header, then a trickle) can hold about 50 uploads in flight across the 300 s
request timeout. That is 250-500 MiB of external memory on a `t4g.small`
(2 GiB, `infra/modules/ec2/variables.tf:11-15`) that also runs the worker.
It is admin-only, so NOTE. The in-process lock suggested in the concurrent-writes
issue would cap this at one upload as a side benefit.

## 6. [NOTE] A persistent greeting failure is WARN-only, so ops is never alarmed while the dashboard says the greeting is live

Every lookup failure path logs WARN: timeout, S3 or DynamoDB error, missing
object, no store (`voice.ts:426-442`). Alarms key on pino level >= 50
(`infra/modules/observability/main.tf:55-56`). The catch-all at `:425` also
turns a programming error in the lookup (a TypeError, a presign misconfiguration)
into a WARN.

If the lookup breaks persistently, every missed call silently gets the spoken
prompt. Meanwhile Settings > Voice lists the greeting, and it plays in the page,
because the audio route streams through a different path (`settings.ts:461-481`).
The missing-object state does show in the page, but only if someone opens the
tab. Consider an ERROR on the unexpected-exception branch, keeping WARN for a
timeout, or a metric filter on the "missing"/"failed" messages.

## 7. [NOTE] The uploading admin's email and userId now go to every logged-in user, VAs included

The record stores `uploadedByEmail` and `uploadedByUserId` (`settings.ts:410-411`).
`GET /api/settings` is requireAuth-only (`settings.ts:238-253`), and the block
renders "Uploaded ... by <email>" to VAs (`VoicemailGreetingBlock.tsx:101`).
The team list, the only other place staff emails appear, is admin-only
(`app/src/routes/adminUsers.ts:74`). The exposure is small in a single org, but
it is new and nothing states it. Consider projecting a display name, or
dropping the email for non-admins.

## 8. [NOTE] `s3Key` is a duplicated truth: the type admits any string, the code only ever writes and accepts the constant, and it ships to the browser

- `VoicemailGreeting.s3Key: string` (`app/src/repos/settingsRepo.ts:119-120`,
  mirrored in `dashboard/src/api/types.ts`).
- The projection rejects anything but `VOICEMAIL_GREETING_S3_KEY`
  (`settingsRepo.ts:132-150`).
- Both consumers deliberately ignore the field (`voice.ts:403`, `settings.ts:470`).

So the field carries no information. It exists "for forward compatibility" that
the projection forbids, and it exposes an internal storage key to every client.
Either type it as the literal `typeof VOICEMAIL_GREETING_S3_KEY` or drop it from
the wire shape.

## 9. [NOTE] The FW1 socket fix landed only on the recording route; the MMS media route streams the same way and still holds the S3 body when the client leaves

`serveMediaObject` now destroys the store body on an early `res` close
(`app/src/routes/serveMediaObject.ts:105-111`). Two sibling routes still do a
bare `object.body.pipe(res)`:
- the authenticated MMS media route, `app/src/routes/api.ts:2404`;
- the unit-media fallback, `app/src/routes/unitMediaServe.ts:77`.

The recording and MMS routes are described in-code as "deliberately kept in
lockstep" (`api.ts`, recording call site). That sentence is about cache posture,
but a reader will assume more. Out of scope for this branch; worth a small
follow-up that moves the MMS route onto `serveMediaObject`.

## 10. [NOTE] The sanitizer says "no control characters" but strips only C0 and DEL

`sanitizeGreetingFileName` (`voicemailGreeting.ts:150-163`) keeps the following:
- C1 controls (U+0080-U+009F);
- bidi overrides (U+202E);
- line and paragraph separators (U+2028/2029);
- zero-width characters.

Probe output: `"a\u0085b\u202Ec\u2028d\u200B.mp3"` became code points
`61 85 62 202e 63 2028 64 200b 2e 6d 70 33`.

React renders the name as text, so this is not XSS. It is display spoofing of
the file name in the admin UI, and the doc comment overstates what the function
does. Either strip `\p{Cc}\p{Cf}\u2028\u2029`, or narrow the comment.

## 11. [NOTE] Duplicated copy and limits; the server's `message` field is dead on arrival

The refusal copy lives in three places:
- the server, `VOICEMAIL_GREETING_REJECT_MESSAGE`, sent as `message` at
  `settings.ts:338,386`;
- the dashboard, `GREETING_REJECT_MESSAGE`, `useVoicemailGreeting.ts:18`,
  commented "Verbatim the server's message";
- the e2e spec.

The client never reads the server's `message`; `messageFor` maps by code only.
The 5 MiB cap is also duplicated (`useVoicemailGreeting.ts:16`). This follows
the repo's mirror convention, but the unused `message` field is a contract
nobody consumes. Either render `err.body.message` when present, or stop sending
it.

## 12. [NOTE] The DELETE route's side-channel states can mislead

- It audits and logs "removed" even when no greeting existed
  (`settings.ts:447-450`). The route is idempotent by design, but the audit
  trail then records a removal that did not happen.
- The record is cleared before `deleteObject` (`:439-446`), which has no time
  bound. A hung S3 delete keeps the request open until CloudFront's 30 s origin
  timeout (`infra/modules/cloudfront/main.tf:114`). The dialog then reports
  "Couldn't remove the greeting" for a greeting that IS removed, and the block
  keeps showing it until a reload. This is the same class as finding 1, milder.

## 13. [NOTE] UNVERIFIED: the raw 5 MB PUT and the early-refusal drain through CloudFront

The hermetic suites prove the route directly against Node and through the Vite
proxy. The e2e even caps a refused body at 200 KB because of the proxy's
`Connection: close` window (`e2e/tests/dashboard-next/voicemail-greeting.spec.ts`,
reject test). No test covers these deployed-only behaviors:
1. CloudFront's handling of an origin that answers 400 after 12 bytes while the
   viewer is still uploading.
2. The 30 s `origin_read_timeout` (`cloudfront/main.tf:114`) against a 5 MB
   upload over a slow uplink.

Both are deployed-only. Make sure the dev check includes a near-cap upload on a
throttled connection and a renamed M4A of realistic size, and confirm that the
M4A message, not a network error, reaches the browser.

## 14. [NOTE] "Remove" does not remove the audio from the bucket

The media bucket is versioned with no lifecycle rule
(`infra/modules/s3_media/main.tf:12-17`, no lifecycle resource in the module).
DELETE writes a delete marker, so every uploaded or replaced greeting stays
retrievable as a noncurrent version indefinitely. The EC2 role lacks
`s3:GetObjectVersion`, so the app cannot serve old versions. The UI says
"Remove greeting". If an admin removes a recording made in error, for example
one that speaks a personal number, the bytes remain. This bucket posture
predates the branch; the feature inherits it.

---

## What I checked and found sound (with proof where the charter asked for it)

Evidence runs: throwaway `tsx` scripts in the session scratchpad, against the
installed `@aws-sdk/lib-storage` 3.1070.0 and `@aws-sdk/client-s3`, with a local
HTTP server standing in for S3.

- **Gate + real lib-storage.** Every refusal and abort case sends zero S3
  requests:
  - invalid header -> rejected `invalid_format`, 0 requests;
  - 5 MiB + 1 chunked -> rejected `too_large`, 0 requests;
  - mid-stream destroy -> rejected, 0 requests;
  - exactly 5 MiB -> ONE `PutObject` of 5242880 bytes. lib-storage splits only
    when `length > partSize` (`dist-cjs/index.js:90`), so the cap never goes
    multipart;
  - a gate destroyed BEFORE `put()`: the rejection is the SAME error instance
    (`GreetingClientAbortedError`), so `settings.ts:394` classifies it
    correctly.

  No poisoned or partial object under the fixed key is possible from a refused
  or aborted upload.
- **HEAD abort on the real SDK.** `S3MediaStore.head` against a TCP server that
  never answers, with `AbortSignal.timeout(300)`, rejects `AbortError: Request
  aborted`, opens 1 connection, and leaves 0 open 1.5 s later. The pooled socket
  is released and the abort is not retried. A late lookup whose GetItem
  outlived the budget reaches `head` with an already-aborted signal and never
  sends it.
- **The timeout race.** A late or failed lookup emits nothing. It returns a
  result, `withTimeout` swallows late rejections, and only the caller logs.
- **Auth, CSRF, injection.**
  - Upload and remove sit behind `requireRole('admin')`; audio sits behind the
    `/api` `requireAuth`.
  - `csrfOriginMiddleware` covers PUT/DELETE, and a cross-site PUT with
    `audio/mpeg` needs a CORS preflight anyway.
  - Keys are server constants. No other media write site takes a client key
    (`emailMedia.ts:79`, the presign routes).
  - The file name never reaches a log: the request logger allowlists headers
    (`middleware/requestLogger.ts:14-21`), the error handler logs only
    method and path, and OTel captures no request headers (`lib/otel.ts:192-195`).
  - React renders the name as text.
- **Body parsers.** `express.json` and `express.urlencoded` ignore audio types,
  so the raw stream reaches the route unconsumed (`app/src/app.ts:136-137`).
  CloudFront forwards all viewer headers (`AllViewerExceptHostHeader`), so the
  name header survives. No reverse proxy sits in front of Node.
- **IAM.** `MediaObjects` grants Get/Put/Delete on `bucket/*` and `MediaList`
  grants ListBucket, so HEAD on a missing key is a 404, not a 403
  (`infra/modules/ec2/main.tf:64-78`). No lifecycle rule can expire the fixed
  key.
- **Other writers and readers of the org settings item.**
  - `putOrgSettings` is an UpdateItem merge, and the only writers are the
    settings routes and seeds. `parsePatch` ignores unknown keys, so a PUT
    carrying `voicemailGreeting` changes nothing.
  - Dashboard settings readers (`TemplatesSection`, `QuietHoursSection`) build
    field-level diffs, never whole-object writes. App readers
    (`missedCallAutoText`, `relayFanOut`, `tourReminders`,
    `resolveWithSettings`) read only their own fields.
  - The DocumentClient has no `wrapNumbers`, so `sizeBytes` projects as a
    number.
- **E2E isolation.** Each lane has its own MinIO bucket
  (`e2e/support/lane.mjs:307`), so the fixed key cannot collide across
  concurrent worktree lanes. Live-mode local dev shares both the dev bucket AND
  the dev DynamoDB, so record and object stay consistent there.
- **Recording route refactor.** The range, 206/416/404, header and cache
  behavior carries over byte for byte. The one behavior change, destroying the
  body on an early close, is correct. Destroying an in-flight IncomingMessage
  without an error emits no `error`, so no false ERROR is logged.
- **ASCII.** No non-ASCII byte appears in any added line under app/, dashboard/,
  e2e/ or fake-twilio/.
