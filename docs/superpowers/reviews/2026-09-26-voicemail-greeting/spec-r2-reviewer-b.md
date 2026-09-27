# Spec review R2 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md` (DRAFT 2)
Adjudications read: `spec-r1-adjudications.md`; other reviewer: `spec-r1-reviewer-a.md`
Worktree: `W:\tmp\voicemail-greeting` (base main 0dafe3c1)
Date: 2026-09-26

Every claim about existing behavior cites a file:line read in this worktree.
Where I proved runtime behavior, it was with throwaway Node scripts on the
installed Node (v24.14.1). The scripts live in my session scratchpad, not in
the repo. Each is described inline so it can be reproduced in a few lines. Anything
not proven is marked UNVERIFIED.

Order below: new defects in the rewritten material first, then contested
adjudications, then round-1 fixes that I checked and found correct.

---

## 1. [HIGH] The DRAFT 2 refusal posture destroys the socket, so the client never receives the 400/413 for any refused body still in flight

**What is wrong.** 4.3 now says: wire `pipeline(req, gate, cb)`; "every refusal
sets `Connection: close` and reads nothing further - the unread remainder of
the body is dropped with the connection". Both halves break the thing a
refusal exists for, which is getting the error JSON to the browser.

- **`pipeline` destroys `req` on any gate error.** Per the Node docs, pipeline
  calls `destroy(err)` on every stream that has not finished. An
  IncomingMessage destroyed before it is complete takes its socket down.
- **`Connection: close` on an early answer makes Node destroy the socket after
  the response flushes.** The client is still uploading at that point, so it
  gets a TCP reset instead of the response.

**Evidence (empirical, Node 24.14.1, loopback, 6-8 trials per row, fully deterministic).**

Probe 1 wiring: `pipeline(req, gate, cb)`, then in the same tick a `for await`
consumer standing in for lib-storage. The gate destroys itself on the first
chunk (sniff reject) or past a 5 MiB cap (too_large). The handler answers
400/413 with `Connection: close`:

| case | DRAFT 2 posture | round-1 posture (`req.pipe` + `req.resume()`) |
|---|---|---|
| sniff reject, 256 KiB body | 400 x8 | 400 x8 |
| sniff reject, 1 MiB body | 400 x8 | 400 x8 |
| sniff reject, 3 MiB body | **ECONNRESET x8** | 400 x8 |
| too_large, 5 MiB + 64 KiB, Content-Length | 413 x8 | 413 x8 |
| too_large, 6 MiB chunked | **ECANCELED x8** | 413 x8 |

The server side showed `req.destroyed=true` and `req.socket === null` BEFORE
the handler wrote the refusal, in every sniff case.

Probe 2 wiring: an early refusal before reading anything (4.3 steps 1-3), 413
with and without `Connection: close`:

| body | `Connection: close` | no header (Node auto-dump) |
|---|---|---|
| 512 KiB | 413 x6 | 413 x6 |
| 6 MiB | **ECONNRESET x6** | 413 x6 |
| 20 MiB | **ECONNRESET x6** | 413 x6 |

**What it implies.**
- **Section 5 route tests will fail.** "413 via a chunked body that exceeds
  the cap" gets ECANCELED/socket hang up. "413 via Content-Length" with a real
  over-cap body gets ECONNRESET. "Every refusal carries `Connection: close`"
  cannot be read from a reset connection. Gate 2 goes red, or the tests get
  weakened to tiny bodies that no longer prove the path.
- **Real users see a generic error for exactly the case the reject message
  exists for.** A renamed or mis-typed file (for example an AAC voice memo
  saved as `.mp3`, so the browser reports `audio/mpeg`) passes the client
  pre-check and is refused by the sniff in step 4. For any such file larger
  than the in-flight window, Sam gets a network error and "Couldn't upload the
  greeting. Try again." instead of the M4A message.
- **Deployed behavior is likely worse.** An origin reset behind CloudFront is
  likely served as the 502 maintenance page (infra/modules/cloudfront/main.tf:213-218,
  `custom_error_response` 502 -> maintenance path). UNVERIFIED that an origin
  reset mid-upload maps to 502.
- **The spec contradicts its own adjudication.** A11 says 4.3 "drains a
  KNOWN-length refused body (bounded) and destroys the request for a chunked
  over-cap body, and references `docs/issues/mms-upload-endpoint-hardening.md`".
  DRAFT 2 4.3 instead says every refusal reads nothing further, and never
  mentions that issue. The issue itself names the trade-off: "a clean 413 vs
  early reset" (docs/issues/mms-upload-endpoint-hardening.md:22-23).
- **"Never drained without bound" only covers the handler's refusals.** The
  csrf 403, 401, requireRole 403 and rate-limit 429 are middleware refusals
  (middleware/csrfOrigin.ts:66, middleware/auth.ts:235-247,
  middleware/rateLimit.ts:199-223). They cannot set the header and still go
  through Node's automatic dump of the whole body. The test "every refusal
  carries `Connection: close`" must be scoped to the handler's own refusals.

**A posture that works (for the author to choose; probe 1, right column).**
The bound comes from step 3. Every known-length body that reaches the gate is
at most 5 MiB, because step 3 already refused anything larger. So:
- On a gate refusal, stop the gate from taking the request down with it:
  unpipe, or use a gate that ends its readable side with the error without
  destroying upstream. Then `req.resume()` to drain at most the declared length
  (at most 5 MiB), and answer normally.
- Reserve `Connection: close` plus destroy-after-flush for the one unbounded
  case: a chunked body over the cap. Browsers never send that shape for a
  `Blob` body.
- Pin with route tests using a body larger than about 3 MiB. A small body
  hides the defect.

Also stale: the step 4 rationale "no `await` may sit between the pipeline call
and the put, or an error can fire with no listener" was true for `req.pipe`.
`pipeline` attaches its own error listeners, so it no longer applies.

---

## 2. [MEDIUM] The client-abort predicate `req.destroyed / req.aborted` is true after EVERY gate refusal

**What is wrong.** 4.3 step 4 classifies "A client abort (`req.destroyed` /
`req.aborted`, or an error whose `code` is `ECONNRESET` / `'aborted'`)" as
WARN with no response. Under the DRAFT 2 wiring, `pipeline` destroys `req` when
the GATE errors.

**Evidence (empirical).** In a Node 24 probe (a 200 KB body refused by the gate
on its first chunk under `pipeline(req, gate)`), the server saw
`err.reason=invalid_format err.code=undefined req.destroyed=true req.aborted=true req.complete=false`.

**What it implies.** The listed predicate cannot tell a refused upload from a
cancelled one. A builder who checks `req.destroyed || req.aborted` before, or
alongside, `instanceof GreetingRejectedError` silences every sniff and size
refusal: no response, and a misleading `client_aborted` WARN. Classify by the
error ALONE: GreetingRejectedError first, then an error originating from `req`
(for example one captured from `req`'s own 'error'/'aborted' events). Never use
the request's state. Add a route test that a sniff refusal is NOT logged as
`client_aborted`. If finding 1 is fixed by not destroying `req` on a gate
refusal, the predicate becomes safer, but it should still not be the
discriminator.

---

## 3. [MEDIUM] The 4.6 "settled flag" guard is self-contradictory, the helper signature cannot set it, and test (e) cannot observe what it claims

**What is wrong.**
- **The signature cannot carry a flag.** 4.1 defines `withTimeout<T>(promise,
  ms, label)`: it receives an ALREADY-RUNNING promise. It has no way to set a
  flag that the closure inside that promise reads. 4.6 nonetheless says the
  flag is "set by `withTimeout` on expiry". The existing helper of that exact
  shape (app/src/services/inboundEmail.ts:407-413, private) has no such hook
  either.
- **The prose contradicts itself.** 4.6 says a late resolution's
  "`reply.play` cannot run because the closure has already returned". That is
  false: on timeout the closure has not returned. It is suspended at `await
  mediaStore.head(...)`, and when HEAD resolves it goes on to presign,
  `reply.play(url)` and `log.info('voicemail greeting offered')`. The same
  paragraph then says the builder must guard against exactly that.
- **The real late side effects are the logs, not the TwiML.** `sendTwiml`
  (voice.ts:407-409, called at :1900) has already serialized and sent the
  response by the time a late HEAD resolves. A late `reply.play` on the object
  changes nothing the caller hears. What a late resolution DOES emit:
  - an INFO `voicemail greeting offered` for a call that actually got the
    spoken prompt. That is the exact line section 7 uses as dev proof that the
    greeting played.
  - or a second WARN ("object missing") after the timeout WARN, breaking
    section 1's "writes one WARN line".
- **Test (e) cannot see the TwiML half.** "no `<Play>` is ever appended
  afterwards" is unobservable over supertest, because the response body is
  immutable once sent. The meaningful assertion is on the log capture: no
  `offered`, and exactly one WARN, after the budget expires.

**What it implies.** Drop the flag entirely. Have the closure return a result
and never touch `reply`, for example `{ kind: 'play', url } | { kind: 'absent' }
| { kind: 'missing' } | { kind: 'no_store' }`. The CALLER, after the race
resolves in time, calls `reply.play(url)` and writes the INFO or WARN. A late
resolution then has nothing to append and nothing to log. Rewrite test (e) to
assert on the log lines. If a flag is kept anyway, the caller sets it in the
`catch`; `withTimeout` cannot.

---

## 4. [LOW] The budget abandons the hung calls but does not cancel them; each one keeps a pooled socket

**Evidence.**
- The S3 client built by `createMediaStore` gets the smithy handler's default
  agent, `maxSockets = 50`
  (node_modules/@smithy/node-http-handler/dist-cjs/index.js:409). The voice
  router builds its own store (voice.ts:349), and that client also serves the
  recording mirror's `put` (voice.ts:2033).
- The handler supports an `abortSignal` (same file, :8-12, and the `handle`
  options at :264). The repo already bounds calls this way
  (app/src/lib/eventBridge.ts:56 `AbortSignal.timeout(2000)`).
- 4.6 abandons the promise and swallows its rejection. A HEAD that hangs on a
  stuck connection keeps its socket until the OS gives up, and the SDK's
  retries keep going behind it.

**What it implies.** Under a partial S3 stall, every missed call leaks one
socket from the same pool the voicemail-recording mirror needs. Threading an
optional `{ signal }` into `MediaStore.head` (`client.send(cmd, { abortSignal
})`) and aborting on expiry makes the budget release what it abandons. This is
cheap and additive. The DynamoDB GetItem has the same shape, but it rides the
shared document client (lib/dynamo.ts:62-90), so leave that one alone.

---

## 5. [LOW] A gate-2 trap in the new `rawBody` option: the catalog scanner rejects a second `fetch` in `requestWithStatus`

**What is wrong.** 4.7 says the `rawBody` option is additive and "the JSON path
byte-identical". The natural way to keep the JSON fetch byte-identical is to
add a second `fetch(...)` branch for the raw body. That fails gate 2.

**Evidence.**
- mutationCatalog.test.ts:374 requires every discovered fingerprint to be
  unique (`new Set(discoveredFingerprints).size === discoveredFingerprints.length`).
- A second fetch inside `requestWithStatus` produces a second
  `client.ts :: requestWithStatus :: fetch:delegated_to_typed_request_options`
  fingerprint.
- Separately, `isCentralDelegatedFetch` only accepts a fetch whose first
  argument is the literal `buildUrl(...)` call (mutationCatalog.test.ts:158-162).
  Hoisting the URL into a variable instead makes `methodFromObject` hit the
  shorthand `method` property and throw `unprovable_method` for the whole scan
  (:147).

I verified that the two new endpoint calls themselves classify correctly:
`request('/api/settings/voicemail-greeting', { method: 'PUT', rawBody, headers })`
comes out as `request:PUT` with a literal path, and DELETE likewise, because
`methodFromObject` ignores non-`method` properties (:112-151).

**What it implies.** Add a row to the 4.9 gate-2 table: `requestWithStatus`
keeps exactly ONE `fetch(buildUrl(path, query), {...})`, and the body
expression picks `payload ?? rawBody`.

---

## 6. [LOW] The atomicity claim silently depends on the gate never forwarding more than `maxBytes`; nothing pins it, and the failure mode is orphaned parts that cannot be aborted

**Evidence.**
- lib-storage creates a multipart upload only when MORE than partSize (5 MiB)
  arrives (lib-storage dist-cjs/index.js:90 `while (currentBuffer.length >
  partSize)`).
- If the gate forwards the chunk that crosses the cap and errors on the next
  one, part 1 is uploaded as a multipart part before the error. `put` then
  calls `upload.abort()` and swallows the result (adapters/mediaStore.ts:179).
- The EC2 role grants only `s3:GetObject`, `s3:PutObject` and
  `s3:DeleteObject` on the bucket objects (infra/modules/ec2/main.tf:65-72).
  `s3:AbortMultipartUpload` is a separate IAM action (AWS IAM action list; not
  verifiable in-repo).
- The bucket has no lifecycle rule to reap incomplete multipart uploads
  (spec section 2; infra/modules/s3_media/main.tf).

**What it implies.** 4.3's "lib-storage sends its single PutObject only after
the gate ENDS cleanly" holds only if the gate checks the count BEFORE pushing a
chunk. The section 5 gate test ("rejects at `maxBytes + 1` with `too_large`")
should also assert that at most `maxBytes` bytes reached downstream, and the
route test should assert zero multipart activity. A loose gate would otherwise
leave billed, invisible orphaned parts that cannot be aborted.

---

## 7. [LOW] The "missing file made visible" fix does not fire at load: `preload="none"` means `onError` only runs after someone presses play

**Evidence.** 4.7 keeps `<audio controls preload="none" ...>` and relies on
the element's `onError` to show "The greeting file is missing or can't be
played". With `preload="none"` the browser does not fetch the source until
playback is requested, so no error event fires on page load.

**What it implies.** 4.3's claim that the interleave state is "rendered
visibly ... so it is repaired by a re-upload rather than found by a caller" is
overstated. The state stays silent unless an admin happens to press play. Two
honest options: soften the claim, or have the block probe the audio URL once on
load (a HEAD or ranged GET) and render the line from that. The spec should say
which.

---

## 8. [LOW] Section 2's claim that "the `/status` miss path today does NOT read settings" is false

**Evidence.** On a transitioned miss, `/status` awaits `onFounderBridgeMissed`
(voice.ts:1848-1849). That calls `sendMissedCallPush` (voice.ts:~2285), which
awaits `settings.getOrgSettings()` for the quick-reply actions (voice.ts:2349-2355).
Reviewer A's "`:2350` elsewhere" misread the same line.

**What it implies.** The path already carries one unbounded settings GetItem
before the TwiML on the first delivery, and the greeting adds a second. That
does not change the design, but the section 2 statement is wrong. Optionally,
`onFounderBridgeMissed` could hand the already-read `OrgSettings` to the
greeting helper, saving a round trip on the first delivery. Redelivered
summaries do not run `onFounderBridgeMissed` and would still read.

---

## Contested adjudications

### 9. [LOW] Contest assumption G: a literal delivery of "never buffer the whole file" exists; the adjudication only weighed presigned POST

**What is wrong.**
- **My round-1 option was never adjudicated.** B3 was ruled "ACCEPT, same as
  A2". A2 rejected only the presigned-POST switch. My round-1 alternative (b)
  kept the bytes flowing THROUGH the app, which is what decision 2 names:
  stream a `PutObjectCommand` with the gated body and an explicit
  `ContentLength` taken from the request's Content-Length. Browsers always send
  a Content-Length for a `Blob` body, so the route can refuse a length-less
  body with 411.
- **That mechanism holds no whole-file buffer anywhere.** S3 creates the object
  only on a complete body; a Content-Length mismatch or an aborted stream
  stores nothing. So the replace stays atomic, the gate's sniff and cap still
  apply, and no dependency is added. It needs an additive MediaStore method,
  for example `putStream(key, body, contentType, contentLength)`.
- **Assumption G's supporting sentence is wrong.** "the adapter's 'no
  whole-body buffering' header comment describes the app side, which holds no
  buffer": lib-storage runs in the app process, so its 5 MiB buffer IS app
  memory. "App level" versus "lib-storage" is not a memory distinction.

**UNVERIFIED.** How the local MinIO handles the SDK's default aws-chunked
trailing checksum on a streamed PutObject. The image is unpinned
(`minio/minio`, scripts/s3.mjs:106); S3 itself supports it.

**What it implies.** If the planner keeps G, the handback should say a literal
mechanism exists and was declined for simplicity. It should not say decision 2
can only be met at the app level. The consequence of shipping G is small (at
most 5 MiB of transient heap per upload); the issue is recording a given
decision as undeliverable when it is not.

### Concessions (one line each)

- A2 (switch to presigned POST): concede. Decision 2 says "stream the upload
  to the media store", and through-app streaming is the given shape.
- Assumption E (confirm on Remove only): concede. It is flagged for the
  handback, and choosing a file is itself a deliberate act.
- Assumption F (no log when no greeting is set): concede. It is flagged, and a
  WARN on the default state of the only org is the warn-flood class the repo
  removed.
- Assumption H (versioned bucket keeps prior versions): concede. It is stated
  honestly and the lifecycle rule is out-of-scope infrastructure.

---

## Round-1 fixes checked and found CORRECT (no finding)

- **ADTS sniff.** `(head[1] & 0x06) !== 0` rejects layer `00` (ADTS 0xFFF1 /
  0xFFF9) and keeps MPEG layer I/II/III syncs (0xFFFB / 0xFFE3). ADTS tests are
  added.
- **preserveOrder second parse.** Run against the installed fast-xml-parser
  4.5.6 (fake-twilio/node_modules), `preserveOrder: true` yields an ordered
  `Response` array (`Play`, `Record` with its attributes under `:@`, `Say`,
  `Hangup`), and `&amp;` in the Play URL decodes to `&`. The "verb immediately
  before `<Record>`" rule is implementable as specified.
- **fetchStatus seam.** It is additive and optional on `CallEngineDeps`
  (fake-twilio/src/engine/callEngine.ts:68-82). The default uses a real
  timeout. Existing voicemail unit tests use Say+Record+Say, so they never
  reach it.
- **Header transport for the file name.** The OTel config registers only
  `startIncomingSpanHook` (lib/otel.ts:192-196), with no header capture. The
  request logger's allowlist excludes the header (middleware/requestLogger.ts:14-21).
  The trace leak is closed.
- **Mutation catalog entries.** Both new calls classify as `request:PUT` /
  `request:DELETE` with the literal path (see finding 5 for the one remaining
  trap). `isCatalogPathIntercepted` derives from the catalog itself, so the
  default `first_party_api` interception is consistent. The count 108 -> 110 is
  right.
- **Viewport.** `expectNoHorizontalOverflowIn(surface: Locator, where)`
  matches e2e/support/viewport.ts:107-110. `NARROW_360` / `WIDE_RESTORE` exist
  (:23, :33).
- **VoiceSection surfaces.** Using `useOptionalAuth()` (app/AuthContext.tsx:65-70)
  and mounting outside the `useMe` ternary are correct. The load failure is a
  status line, not an alert, which keeps VoiceSection.test.tsx:96 and
  voice-outbound.spec.ts:690 green. The voice-outbound status assertions
  already filter by text (:256, :729-738), so the new status lines do not
  collide. The perf terminal matches via `.first()` (e2e/performance/cli.ts:464-468),
  so extra status elements do not break it.
- **s3Key pinned to the constant in the projection; the `SettingsPatch` Omits;
  best-effort audit.** All three are correct as written.
