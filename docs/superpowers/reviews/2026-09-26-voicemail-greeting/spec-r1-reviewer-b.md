# Spec review R1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md` (DRAFT 1)
Worktree: `W:\tmp\voicemail-greeting` @ 7cb62edc (base main 0dafe3c1)
Date: 2026-09-26

Every claim about existing behavior below cites a file:line that was read in
this worktree. Anything not verified in code is marked UNVERIFIED.

Section 2 claims I verified TRUE (these are not findings): the `/status` miss
branch and its guard (voice.ts:1874-1899); `/voicemail-done` says the thanks
only (voice.ts:2119-2124); the only emitter of `voice.voicemail_prompt` is
voice.ts:1875; the defended pre-ring read (voice.ts:769-778); router-held
`settings` / `mediaStore` (voice.ts:349,354); MediaStore contract
(mediaStore.ts:79-153, put aborts on error at 172-181, head/getStream undefined
on 404 at 209-220 / 253-266); body parsers only JSON + urlencoded
(app.ts:136-137), so an `audio/*` body reaches the route unread;
`putOrgSettings` REMOVEs any null-valued key generically (settingsRepo.ts:319-331);
`parsePatch` copies known fields only (settings.ts:61-164); seeds are full-item
Puts after a table wipe (seed/index.ts:149-155, lean.ts:525-530,
matrix.ts:1345-1360); no multipart parser in app/package.json;
`EDGE_MUTATING_PREFIXES` includes `/api` (app.ts:76); IAM grants
Get/Put/DeleteObject on `bucket/*` plus ListBucket (infra/modules/ec2/main.tf:65-78),
so a HEAD on a missing key is a 404, not a 403; per-lane e2e buckets
(e2e/support/lane.mjs:307), so the fixed key cannot collide across lanes;
`workers: 1` (e2e/playwright.config.ts:141).

---

## 1. [HIGH] The webhook greeting lookup has no time bound; "a slow store degrades to `<Say>`" is false

**What is wrong.** Section 4.6 says: "A slow or failing store degrades to
`<Say>` through the catch, never to a webhook 5xx." A try/catch only catches
a store that FAILS. A store that is SLOW never throws: the `await
mediaStore.head(...)` (and the `getOrgSettings()` GetItem) simply keeps the
`/status` handler waiting, and the TwiML is not sent until they resolve.

**Evidence.**
- The S3 client is built with no request handler and no timeout
  (adapters/mediaStore.ts:380-396). In the installed
  `@smithy/node-http-handler` 4.9.13, `setRequestTimeout` defaults
  `timeoutInMs = 0` (no timer), and even a configured timeout only WARNs unless
  `throwOnRequestTimeout` is set (node_modules/@smithy/node-http-handler/dist-cjs/index.js:80-99).
  The SDK's standard retry (3 attempts with backoff) stacks on top.
- The codebase already knows this path has a hard budget: voice.ts:720-725
  fire-and-forgets the pre-ring push precisely because awaiting it would "risk
  the ~15s Twilio webhook timeout".
- The `/status` miss path ALREADY awaits the missed-call push fan-out and an
  SQS enqueue before the TwiML (voice.ts:1848-1849 -> onFounderBridgeMissed,
  voice.ts:~2285 `await sendMissedCallPush`, ~2294 `await enqueueImmediate`),
  so the greeting lookup is added to a budget that is already partly spent.

**What it implies.** During an S3 (or DynamoDB) brown-out, a missed caller gets
Twilio's generic application-error message and the call ends: no greeting, no
prompt, no `<Record>`, no voicemail. That is exactly the failure decision 3
forbids ("The webhook must never fail because of the greeting"), and it is
silent in our logs because nothing throws. The spec's mechanism cannot deliver
the guarantee. It needs a hard bound on the whole lookup (for example a
`Promise.race` of about 1.5-2s, with an AbortSignal passed to the HeadObject
send) that falls back to `<Say>` and WARNs. It also needs a webhook test that
drives a `head` that never resolves and asserts the prompt TwiML comes back
inside the bound. Test (d) in section 5 only covers a head that THROWS.

---

## 2. [HIGH] E2E step 5 prescribes the vacuous overflow check that a gate-2 guard forbids

**What is wrong.** Section 5, Playwright step 5 asserts
`document.documentElement.scrollWidth <= 375`. In this app shell that check
passes unconditionally, and the repo has a guard test that fails any e2e file
containing that expression.

**Evidence.**
- e2e/support/viewport.guard.test.ts:1-30 explains the vacuity (AppFrame clamps
  the document; overflow scrolls INSIDE `<main>`), and :56-70 fails when any
  `.ts/.tsx/.mjs` under e2e/ (other than support/viewport.ts) contains
  `documentElement.scrollWidth`. See also
  docs/issues/e2e-documentelement-overflow-check-vacuous.md.
- The guard runs in completion gate 2: e2e/vitest.config.ts:8 includes
  `support/**/*.test.ts`, and the root `npm test` runs every workspace
  (package.json:39).
- The honest helpers already exist: `expectNoHorizontalOverflow(page, where)`
  (e2e/support/viewport.ts:73) and the house narrow viewport `NARROW_360`
  (viewport.ts:23), already used by e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts:48,334.
  The Remove dialog is a `position: fixed` Modal, which needs
  `expectNoHorizontalOverflowIn` on its own box (viewport.ts:87-106).

**What it implies.** Built as written, gate 2 goes red. If someone "fixes" that
by deleting the assertion, the phone-width requirement in section 4.7 has no
proof at all. The spec must name `expectNoHorizontalOverflow` (and
`expectNoHorizontalOverflowIn` if the dialog is checked at phone width), and
should use the house viewport constant rather than an ad hoc 375.

---

## 3. [MEDIUM] "Never buffer the whole file" is not what the mechanism does: lib-storage buffers every accepted greeting in full

**What is wrong.** Decision 2 says "stream the upload ... (never buffer the whole
file)", and 4.3 relies on `mediaStore.put` (lib-storage `Upload`). The cap
(`VOICEMAIL_GREETING_MAX_BYTES = 5 * 1024 * 1024`, 4.1) is exactly lib-storage's
minimum part size. So every accepted greeting is collected into ONE in-memory
Buffer and sent as a single PutObject.

**Evidence.** node_modules/@aws-sdk/lib-storage (3.1070.0) dist-cjs/index.js:
- :84-106 `getChunkStream` pushes every chunk into `currentBuffer` and yields
  only while `length > partSize`. At end of stream it yields the whole
  remainder, `Buffer.concat`ed, with `lastPart: true`.
- :183 `MIN_PART_SIZE = 1024 * 1024 * 5`, and :220-221 partSize defaults to it
  (the Transform has no length, so totalBytes is unknown).
- :335-336 part 1 AND lastPart -> `__uploadUsingPut` with that single Buffer.
  The gate caps the stream at `maxBytes` = partSize, so the `> partSize` branch
  can never fire and a multipart upload is never created.

The same fact undercuts the reasoning in 4.3 step 4: "on a too-large mid-stream
error `S3MediaStore.put` aborts the multipart upload (existing behavior)". At
this cap there is never a multipart upload to abort. The old greeting survives
a too-large upload because nothing reaches S3 until the stream ENDS cleanly. The
claimed mechanism is the wrong one. The adapter's own header comment ("no
whole-body buffering, ever", mediaStore.ts:4-6) is likewise false for any body
<= 5 MiB, and AGENTS.md forbids whole-file buffers.

**What it implies.** The memory cost is small (<= 5 MiB, plus one concat copy,
per upload, admin-only, 10/min), but the spec asserts a guarantee its mechanism
does not deliver. Pick one:
- (a) State the bounded single-part buffering as accepted and correct the 4.3
  abort reasoning.
- (b) Actually stream it: a PutObject with the gated stream and a declared
  ContentLength. S3 commits a PutObject only on a complete body, so a mid-stream
  error still stores nothing. This requires the Content-Length header, and
  MediaStore.put's signature does not take a length.

Either way, the test list should pin the real protection: "a too-large or
bad-header upload leaves the previous object byte-identical".

---

## 4. [MEDIUM] The fallback guarantee is overstated: present-but-unplayable audio and HEAD-to-fetch races give callers silence, then a beep, with no app signal

**What is wrong.** Section 1 says "any problem with it (no greeting set, the file
gone from storage, storage unreachable) falls back to today's spoken prompt".
The mechanism (4.6) only proves the object EXISTS at HEAD time. It says nothing
about whether Twilio can fetch and decode it when `<Play>` runs.

**Evidence / cases the mechanism does not cover.**
- **A decodable-looking header that is not MP3.** The MP3 sniff
  `head[0] === 0xff && (head[1] & 0xe0) === 0xe0` (4.1) accepts ADTS AAC frame
  syncs (0xFF 0xF1 / 0xFF 0xF9), because ADTS shares the 12-bit 0xFFF sync. It
  also accepts any ID3-prefixed body, which some recorders put on AAC output. A
  cheap tightening that rejects ADTS is to require non-zero layer bits:
  `(head[1] & 0x06) !== 0`. Section 5 tests M4A `ftyp` and PNG but not ADTS.
- **WAV encodings Twilio cannot play.** Section 6 acknowledges these, but section
  1 still promises a fallback.
- **The object vanishes between HEAD and Twilio's fetch.** 4.4 deletes the object
  immediately after the record REMOVE, so a call whose TwiML was built a moment
  earlier fetches a 404.

UNVERIFIED: exactly how Twilio proceeds after a `<Play>` fetch or decode failure.
Whether it skips to the next verb or ends the call, the caller does not hear
the spoken prompt, and the app writes nothing (4.6 logs "voicemail greeting
played" when it EMITS the TwiML, not when Twilio plays it).

**What it implies.** Restate the guarantee honestly: the fallback covers lookup-time
failures only. Tighten the MP3 sniff and add an ADTS rejection test. Name the
residual (unplayable-but-present) as an accepted gap next to the section 6
normalization issue, so nobody reads section 1 as covering it. No transcoding
is being proposed here (section 6 non-goal respected).

---

## 5. [MEDIUM] Unenumerated surface: the dashboard mutation catalog (gate 2) must learn both new mutations, and its static scanner constrains how the fetch may be written

**What is wrong.** Section 4.9 enumerates writers and readers, but not the
repo's static inventory of every dashboard mutation. Section 4.7 adds two new
mutating calls in dashboard/src/api/endpoints.ts: a direct `fetch` PUT
(`uploadVoicemailGreeting`) and a `request` DELETE (`removeVoicemailGreeting`).

**Evidence.**
- e2e/performance/mutationCatalog.test.ts:265-310 scans all of dashboard/src
  with the TypeScript AST for `fetch` / `request` / `requestWithStatus` / XHR
  calls. :364-379 requires the checked-in
  `DASHBOARD_MUTATION_CATALOG` (e2e/performance/mutationCatalog.ts:38+) to match
  in BOTH directions. :373 hard-codes the count, `toHaveLength(108)`. This runs
  in gate 2 (e2e/vitest.config.ts:8, package.json:39).
- The scanner requires a statically provable method and path. A PUT whose URL is
  a variable throws `unprovable_path` for the WHOLE scan
  (mutationCatalog.test.ts:261-262, 295). So "build the URL, then fetch(url)"
  breaks the suite outright.
- If the URL template carries the query (`?name=${encodeURIComponent(file.name)}`),
  the path category becomes `/api/settings/voicemail-greeting?name=:name`
  (:176-192, 244-258). The perf firewall then turns that into a literal
  pattern and a pathname regex that can never match
  (e2e/performance/firewall.ts:196-214), so `perf:pages` would not intercept
  this write.
- A related contract drifts: e2e/performance/routes.ts:300 declares
  `VOICE_GETS = [/api/users/me]` for `/settings/voice`, and routes.test.ts:112
  pins it. The new `useVoicemailGreeting()` GET of `/api/settings` on that tab
  would be reported `unexpected_endpoint` by a `perf:pages` run
  (e2e/performance/report.ts:337).

**What it implies.** Add both catalog entries, bump the literal count to 110,
and keep the query string OUT of the fetch URL template (see finding 7 for
another reason). Update `VOICE_GETS` / routes.test.ts for the Voice tab's new
GET. None of this appears in the spec's surface table, and gate 2 fails until
it is done.

---

## 6. [MEDIUM] Mounting the block (with `useAuth` and a real `getSettings`) inside VoiceSection breaks the existing VoiceSection suite

**What is wrong.** Section 4.7 renders `VoicemailGreetingBlock` inside the
existing `VoiceSection`, gates it on `useAuth().isAdmin`, and has the hook call
`getSettings()`. The existing VoiceSection tests cannot survive either choice
unchanged, and the spec's test list does not mention them.

**Evidence.**
- dashboard/src/routes/settings/VoiceSection.test.tsx:33-37 (and every other case)
  renders a bare `<VoiceSection />` with NO `AuthProvider`.
  dashboard/src/app/AuthContext.tsx:57-63 `useAuth()` THROWS outside a provider.
  The repo's answer for exactly this case is `useOptionalAuth()` (:65-70, "for
  components and hooks that must render in tests without an <AuthProvider>").
- The suite's API mock spreads `...actual` (VoiceSection.test.tsx:14-22), so
  `getSettings` is the REAL function. In jsdom, a relative `fetch('/api/settings')`
  rejects, and the hook enters its error state. Section 4.7 renders errors as
  `<p role="alert">`, which collides with the existing single-alert query
  `await screen.findByRole('alert')` (VoiceSection.test.tsx:96).
- Section 4.7 also leaves open whether the block sits inside the `useMe`
  loading/error ternary (VoiceSection.tsx:93-127). If it does, a `/users/me`
  failure hides the greeting block too.

**What it implies.** Specify `useOptionalAuth()` or an `isAdmin` prop, and
specify that the existing VoiceSection tests mock `getSettings`. Otherwise
gate 2 goes red on tests the spec never lists.

---

## 7. [LOW] The file name rides the query string, which lands in exported trace attributes; contradicts "never logged"

**What is wrong.** Assumption C and 4.10 say the file name "is never logged". 4.3
puts it in `?name=`.

**Evidence.** The request logger logs `req.path` only (middleware/requestLogger.ts:37,57),
so the log lines are clean. But the OTel incoming-span hook copies the full
`req.url`, query included, into `http.target` / `http.url` / `url.query`,
masking only phones and signed-URL params (lib/otel.ts:91-117,79-88). Deployed
envs export traces (infra/modules/ec2/main.tf:~393, OTEL_EXPORTER_OTLP_ENDPOINT).

**What it implies.** A staff-chosen file name (which may contain a person's name)
reaches X-Ray/trace storage, breaking the spec's own rule. Carry the name in a
request header instead (for example a percent-encoded `X-Greeting-File-Name`).
Headers are not in the logger allowlist, not in span attributes, and not in the
mutation-catalog path (finding 5).

---

## 8. [LOW] The client lets an empty `file.type` through "to the server, which decides by header", but the server rejects it before any sniff

**What is wrong.** 4.7: "an empty `file.type` with a `.mp3`/`.wav` extension is
allowed through to the server, which decides by header". Yet 4.7's own fetch
sends `Content-Type: file.type`, which is empty, and 4.3 step 2 answers 400 when
`normalizeGreetingContentType` returns undefined. 4.1 returns undefined for
anything else, including an empty string. The sniff is never reached.

**What it implies.** The stated path is dead code with a misleading rationale.
Either have the client send the extension-derived canonical type when
`file.type` is empty, so the server really does decide by header, or drop the
allowance and reject on the client.

---

## 9. [LOW] Mirrored and derived types: three patch types silently widen or break

**Evidence.**
- App: `OrgSettingsPatch = Partial<Omit<OrgSettings, 'welcomeText'>> & {
  welcomeText?: string | null }` (repos/settingsRepo.ts:183-185). If
  `voicemailGreeting?` is added to OrgSettings but not to the Omit, the
  intersection resolves to `VoicemailGreeting | undefined`, and 4.4's
  `putOrgSettings({ voicemailGreeting: null })` fails typecheck.
- routes/settings.ts:59 keeps its own copy of the same derived type. It would now
  admit `voicemailGreeting` as a parsePatch output that parsePatch never produces.
- Dashboard: `SettingsPatch` derives from `OrgSettings`
  (dashboard/src/api/types.ts:140). Adding `voicemailGreeting` to the dashboard
  OrgSettings makes `putSettings({ voicemailGreeting })` type-check even though
  the server ignores it (4.2), so the type lies to the next caller.

**What it implies.** The spec should say: add `voicemailGreeting` to both Omit
lists, and state the null form explicitly.

---

## 10. [LOW] The fake-twilio greeting observation is order-blind, and `'say'` is satisfied by the thanks `<Say>`

**Evidence.** `interpretTwiml` parses with fast-xml-parser into a tag-keyed
object (fake-twilio/src/engine/twimlInterpreter.ts:19,30-31), which discards
element order. Every voicemail response also carries the thanks `<Say>`
(voice.ts:1894). So under 4.8's rule ("'play' if a Play element, else 'say' if a
Say element, else 'none'"):
- `'none'` is unreachable.
- `'say'` is produced even if the prompt were dropped entirely.
- `'play'` is produced even if `<Play>` came AFTER `<Record>` (a greeting played
  after the beep).

**What it implies.** E2E step 4 (`voicemailGreeting === 'say'`) does not prove the
spoken-prompt fallback, and step 2 does not prove ordering. The app-level test
(a) does pin ordering, so the gap is e2e-only. Either record the verb that
precedes `<Record>` (for example with fast-xml-parser's `preserveOrder`) or
narrow the e2e claims.

---

## 11. [LOW] Upload/Remove interleaving can persist "record set, object gone"; "last writer wins on both" is not what two independent writes give

**Evidence.** 4.3 is put-object then SET-record; 4.4 is REMOVE-record then
delete-object. Interleaving upload(put) -> remove(REMOVE, delete) ->
upload(SET) ends with the record present and the object deleted. From then on
every missed call WARNs and falls back, and the UI shows a greeting whose player
404s, until someone removes and re-uploads. Two concurrent uploads can likewise
end with object B and record A (name/type/size from A). 4.3's "last writer wins
on both" assumes the two writes stay paired, and nothing pairs them.

**What it implies.** This is acceptable for a single org, but the spec should
describe the real end states. It would cost one sentence to have the audio GET
(or the Voice tab) surface "greeting file missing" rather than a silently
failing player.

---

## 12. [LOW] The versioned media bucket has no lifecycle, so Remove and Replace keep every prior greeting; "removing clears both" holds only for the current version

**Evidence.** infra/modules/s3_media/main.tf:12-17 enables versioning, and the
module has no `aws_s3_bucket_lifecycle_configuration` (the only one in infra/
is inbound_mail/main.tf:291). DeleteObject without a version id writes a delete
marker, and PutObject over a key keeps the old version as noncurrent.

**What it implies.** Every greeting ever uploaded (a staff member's voice)
persists indefinitely. The storage cost is negligible, but decision 2's
"removing clears both" is not literally delivered. State it, or file it next to
the unit-photo removal precedent, which has the same property.

---

## 13. [LOW] Request-socket handling: the drain after `too_large` is unbounded, and a client abort becomes an alarm-feeding ERROR

**Evidence.** 4.3 step 4 calls `req.resume()` after a refused body. That drains
EVERYTHING the client sends after the 5 MiB point. The step-3 Content-Length
refusal and every pre-handler refusal also get drained, by Node's automatic
dump of an unconsumed request (Node http server `resOnFinish`; UNVERIFIED
against the exact Node 24 source).

A client that aborts mid-upload makes `req` error, which `gate.destroy(err)`
propagates, which becomes "Any other error -> 500 upload_failed with an ERROR
log". ERROR-level lines feed the ErrorLogs alarms
(infra/modules/observability/main.tf:55-56,152,188).

**What it implies.** The damage is bounded by admin-only access and the rate
limit, so this is low. Two fixes would help. Answer the size refusals with
`Connection: close` rather than draining an unbounded body. Classify a
`req`-originated abort as INFO/WARN rather than ERROR.

---

## 14. [LOW] Factual inaccuracies in sections 2, 4.7, 4.9 and 5 that a builder would act on

- Section 5 says the harness's fake mediaStore "already records
  puts/heads/presigns/deletes". It records puts (`mediaPuts`), deletes
  (`deletedMediaKeys`) and presigned POSTs (`presignPosts`) only
  (test/helpers/twilioWebhookHarness.ts:268-274, 3870-3985). `head` and GET
  `presign` record nothing, and there is no head-failure seam, so webhook test
  (d) has to monkeypatch `world.mediaStore.head`.
- Section 2 says `POST /__dev/reseed` "does not touch MinIO objects". A full-profile
  reseed PUTs the two cast media objects (lib/seed/index.ts:162-166). It deletes
  nothing, which is the point that matters for assumption D.
- Section 4.7 says reusing `useSettings` "would also drag the templates state
  along". `useSettings` is generic (settings, welcomeTextDefault,
  businessPhoneNumber; dashboard/src/routes/settings/useSettings.ts:30-83). This
  does not change the decision, but the stated reason is wrong.
- The 4.9 reader table omits `QuietHoursSection` (QuietHoursSection.tsx:68),
  `NumbersSection` (NumbersSection.tsx:179) and `QuickReply` (a direct
  `getSettings`, QuickReply.tsx:115). All are safe, because each diff is
  field-by-field (QuietHoursSection.tsx:37-49, TemplatesSection.tsx:47-70), but
  the table claims to be the full list.

---

## 15. [LOW] The direct fetch bypasses client.ts's every-response server-clock hook and must copy a private helper

**Evidence.** dashboard/src/api/client.ts:120-125 says EVERY response from our
server re-estimates the server clock (`noteServerDate`, retry-send-window D8),
before the body is parsed. `errorFrom` / `parseBody` are module-private
(client.ts:58-78). The presigned-POST "precedent" (endpoints.ts:1143-1182)
talks to S3, not our server, so it never needed either.

**What it implies.** 4.7 keeps client.ts untouched, so the builder must hand-copy
the `{ error }` -> `ApiError` mapping into endpoints.ts, which can drift, and the
upload's response skips the clock hook. Either export a small raw-body option
from client.ts, or call `noteServerDate` and a shared error helper explicitly.

---

## 16. [LOW] Decision 4's "a Replace and a Remove action with confirmation" is read as Remove-only, and the reading is not flagged

**Evidence.** Section 3 decision 4 is ambiguous about whether "with confirmation"
covers Replace. Sections 1 and 4.7 confirm only Remove; Replace goes straight
from the file picker to an overwrite. The "Assumptions" list (A-D) does not
record this reading.

**What it implies.** Add it as assumption E so the handback surfaces it. This
does not reopen the decision; it only states the interpretation that was made.
