# Recorded voicemail greeting - design specification

Status: DRAFT 2 - written under Cameron's overnight, unattended mission block
(every product decision in section 3 was handed down in that block; none is
reopened here). DRAFT 2 folds in spec review round 1 (two reviewers, 31
findings, one decision changed: the webhook lookup time bound, 4.6).
Adjudications: `docs/superpowers/reviews/2026-09-26-voicemail-greeting/
spec-r1-adjudications.md`.
Date: 2026-09-26
Revised: 2026-09-26 (DRAFT 2)
Branch: `feat/voicemail-greeting`
Worktree: `W:\tmp\voicemail-greeting`
Base: `main` at `0dafe3c12291f60a69cccaf5a8a65bcb8d252452`
Tracker: Sam's improvements list item #10 (support work under Amendment No. 2,
estimate 4-6 hours)
Review records: `docs/superpowers/reviews/2026-09-26-voicemail-greeting/`

## 1. Outcome

Sam records a greeting on her own (any recorder that can export MP3 or WAV),
uploads it once in Settings > Voice, and from then on a caller who reaches the
business line's voicemail hears HER voice instead of the computer voice, then
the beep, exactly as today. She can listen to the greeting in the page, replace
it, or remove it (with a confirmation). Removing it puts the computer voice
back. Nothing else about voicemail changes: who gets one, when, the beep, the
maximum message length, the thanks-and-goodbye after the message, the missed-
call push and auto-text, the founder bridge and quiet hours are all untouched.

The voice webhook can never fail because of the greeting. Every LOOKUP-TIME
problem (the settings read or the storage check failing, timing out, or
finding the file gone) falls back to today's spoken prompt inside a fixed
time budget and writes one WARN line with no personal data. When no greeting
has been uploaded, callers hear today's prompt and nothing is logged (that is
the normal state of every org). What the fallback does NOT cover: a file that
exists but Twilio cannot play (an exotic WAV encoding, or a file removed in
the seconds between our check and Twilio's fetch). Twilio's behavior in that
case is UNVERIFIED (section 6) and is a dev check in the handback.

Nothing tenant-, landlord- or partner-facing changes in wording. The computer
voice prompt keeps its catalog entry (`voice.voicemail_prompt`) as the
fallback. No message-catalog copy is added (staff-facing settings copy only).

## 2. Current behavior (verified against `main` @0dafe3c1)

- `app/src/routes/webhooks/voice.ts` `POST /webhooks/twilio/voice/status`
  (the `<Dial action>` URL): on a MISSED inbound founder-bridge call
  (`isMissed && entry?.type === 'call' && entry.masked !== true &&
  entry.direction !== 'outbound'`, around line 1874) it emits
  `reply.say(resolveMessage('voice.voicemail_prompt'))`, then `reply.record({
  maxLength: VOICEMAIL_MAX_LENGTH_SECONDS, timeout:
  VOICEMAIL_SILENCE_TIMEOUT_SECONDS, playBeep: true, action:
  .../voicemail-done, recordingStatusCallback: .../recording,
  recordingStatusCallbackEvent: ['completed'] })`, then
  `reply.say(voice.voicemail_thanks)` and `reply.hangup()`. The `else if
  (isMissed)` branch (masked relay or outbound miss) says
  `voice.missed_call_goodbye` and hangs up. This `/status` handler is the ONLY
  place the voicemail prompt is spoken. `/voicemail-done` (line ~2118) says
  the thanks only; the recording callback (`/voice/recording`) never emits
  TwiML with a prompt. The `/status` miss path today does NOT read settings;
  before the TwiML it already awaits the missed-call push fan-out and a job
  enqueue (`onFounderBridgeMissed`), so the greeting lookup is added to a
  webhook budget that is already partly spent. The file names the ~15s
  Twilio webhook budget (line ~723) and fire-and-forgets the pre-ring push
  for that reason.
- The router already holds `settings` (a `SettingsRepo`, injectable through
  `TwilioVoiceWebhookDeps.settingsRepo`) and `mediaStore` (a `MediaStore |
  undefined`, injectable through `deps.mediaStore`, undefined when
  `MEDIA_BUCKET` is unset). The inbound `/voice` handler already reads
  `settings.getOrgSettings()` on the TwiML path inside a try/catch that WARNs
  and falls back to a default (`preRingPauseSeconds`, line ~771). That is the
  defended-read pattern this feature copies, plus a time bound (4.6).
- `app/src/adapters/mediaStore.ts` `MediaStore` has `put(key, Readable,
  contentType)` (lib-storage `Upload`), `getStream(key, { range? })`
  (undefined on NoSuchKey/404), `head(key)` (undefined on 404; the EC2 role
  has `s3:ListBucket`, so a missing key is a 404, not a 403), `presign(key,
  ttlSeconds)` (signed with the store's own client, MinIO parity),
  `deleteObject(key)` (idempotent). `createMediaStore` returns undefined
  without `MEDIA_BUCKET`. The `S3Client` is built with NO request timeout
  (`@smithy/node-http-handler` defaults to none), and `head` takes no abort
  signal: a slow or hung S3 call never throws on its own.
- lib-storage's minimum part size is 5 MiB and `S3MediaStore.put` passes no
  `partSize`, so a body of at most 5 MiB is collected into ONE buffer inside
  lib-storage and sent as a single `PutObject` when the stream ends; a
  multipart upload is never created for such a body. Nothing reaches S3
  before the stream ends cleanly. (The adapter's "no whole-body buffering"
  header comment describes the app side, which holds no buffer.)
- Voicemail recordings are mirrored with `mediaStore.put(key, stream,
  'audio/mpeg')` under `recordings/<callSid>/<recordingSid>` (voice.ts ~2033)
  and served back at `GET /api/calls/:callId/recording` (api.ts ~2273): authed
  via the `/api` mount, single well-formed byte range forwarded to
  `getStream`, `Accept-Ranges: bytes` on every success, `Cache-Control:
  private, max-age=3600`, 206 with `Content-Range` when the store returned one,
  416 with `Content-Range: bytes */<size>` on `RangeNotSatisfiableError`, 404
  `recording_not_found` when the key is absent, the store is unconfigured, or
  the object is gone. The dashboard plays it with `<MonoAudio controls
  preload="none" src="/api/calls/<sid>/recording" aria-label="Call recording">`
  (`dashboard/src/routes/contact/Timeline.tsx` ~1685).
- Outbound MMS uploads (`app/src/routes/mmsMedia.ts`) go BROWSER -> S3 with a
  presigned POST, per the 2026-07-15 unit-photos direct-upload decision (keep
  20 MB photo batches off the single EC2 instance). There is no multipart
  parser (busboy/multer) in `app/package.json`. `app/src/app.ts` mounts only
  `express.json` and `express.urlencoded` body parsers (stage 3), and
  `trimJsonBody` acts only on JSON, so a request whose Content-Type is neither
  JSON nor form-urlencoded reaches its route with the body UNREAD and `req`
  still a readable stream. `csrfOrigin` is a header compare on mutating
  methods (Origin must match `PUBLIC_BASE_URL` or a localhost dev origin).
- `app/src/repos/settingsRepo.ts`: `OrgSettings` is the singleton item
  `settingId = 'org'`; `getOrgSettings()` projects the stored item over
  `DEFAULT_ORG_SETTINGS` with per-field type checks (a malformed field reads
  as its default; `welcomeText` is optional and projected only when a string
  is stored); `putOrgSettings(patch)` is an `UpdateCommand` merge (SET per
  present field, REMOVE for ANY `null`-valued key, ALL_NEW).
  `OrgSettingsPatch = Partial<Omit<OrgSettings, 'welcomeText'>> &
  { welcomeText?: string | null }`. `app/src/routes/settings.ts` keeps its own
  copy of that derived type (`SettingsPatch`); `GET /api/settings`
  (requireAuth) returns `{ settings, welcomeTextDefault, businessPhoneNumber?
  }`; `PUT /api/settings` (requireRole('admin')) runs `parsePatch`, which
  copies ONLY the fields it knows (`missedCallAutoText`,
  `missedCallAutoTextEnabled`, `quickReplies`, `preRingPauseSeconds`,
  `quietHours*`, `timezone`, `welcomeText`) and ignores everything else, then
  AWAITS a `settings_updated` audit event with `{ fields, actor }` on
  `ORG_SETTINGS_ENTITY_KEY` (an audit failure there is a 500).
- Seeds: `app/src/lib/seed/lean.ts` writes `{ settingId: 'org',
  quietHoursEnabled: false }`; `matrix.ts` (full profile) writes a full `org`
  row. Both are FULL-ITEM Puts after a table wipe, so a reseed REPLACES the
  org item and drops any attribute the seed does not carry. A FULL-profile
  reseed also PUTs the two cast media objects into MinIO (`seedMedia`); no
  reseed deletes MinIO objects.
- Dashboard: `dashboard/src/api/types.ts` `OrgSettings` MIRRORS the app type
  by hand and `SettingsPatch` derives from it; `endpoints.ts` `getSettings` /
  `putSettings`; `client.ts` `requestWithStatus` serializes ONLY JSON bodies
  (no raw-body option), feeds EVERY response's `Date` header to
  `noteServerDate` (retry-send-window D8), and keeps `parseBody` / `errorFrom`
  module-private. `dashboard/src/routes/settings/VoiceSection.tsx` is the
  Voice tab (`/settings/voice`, visible to every logged-in user per
  `settingsTabs.ts`): it renders the self cell-verification flow off `useMe()`
  inside a loading/error ternary; it does not read org settings today.
  `useAuth()` THROWS outside an `<AuthProvider>`; `useOptionalAuth()` returns
  undefined there and exists for components that must render in tests without
  a provider. `VoiceSection.test.tsx` renders `<VoiceSection />` with NO
  provider, mocks only `getVoiceMe` / `startCellVerify` / `confirmCellVerify`
  (spreading the real module, so a real `getSettings` would run and fail
  under jsdom), and asserts a SINGLE `findByRole('alert')` in four cases.
  `e2e/tests/dashboard-next/voice-outbound.spec.ts` (~line 690) asserts zero
  alerts on `/settings/voice`. Other readers of `OrgSettings`:
  `TemplatesSection`, `QuietHoursSection`, `NumbersSection`, `SystemStatus`
  (via `useSettings`) and `QuickReply` (a direct `getSettings`); each reads
  named fields, none spreads the record into a form.
  `dashboard/src/routes/contact/Modal.tsx` is the shared accessible dialog;
  `ConfirmRemoveDialog.tsx` (Team) is the existing confirm-before-remove shape
  (danger button, busy state, inline error).
- Static test surfaces in gate 2 (`npm test` runs every workspace, including
  `e2e/support/**/*.test.ts` and `e2e/performance/*.test.ts`):
  - `e2e/support/viewport.guard.test.ts` FAILS any e2e file containing
    `documentElement.scrollWidth` (that measurement is vacuous in this shell:
    the document is clamped and `<main>` scrolls). The honest helpers are
    `expectNoHorizontalOverflow(page, where)`, `expectNoHorizontalOverflowIn(
    locator, where)` (the only valid check for a `position: fixed` dialog),
    `NARROW_360` and `WIDE_RESTORE` in `e2e/support/viewport.ts`.
  - `e2e/performance/mutationCatalog.test.ts` scans `dashboard/src` for every
    `fetch` / `request` / `requestWithStatus` / XHR call, requires the
    checked-in `DASHBOARD_MUTATION_CATALOG` (`e2e/performance/
    mutationCatalog.ts`) to match in both directions, and pins the
    non-delegated count at 108. The scanner needs a statically provable
    method and a LITERAL path (a URL held in a variable throws
    `unprovable_path` for the whole scan; a query string in the template
    becomes part of the path category and breaks the perf firewall's
    pattern).
  - `e2e/performance/routes.ts` declares the Voice tab's GETs as `VOICE_GETS =
    [required('/api/users/me')]` and `routes.test.ts` (~line 112) pins that
    list; its terminal locator forbids any `role="alert"` at load.
- fake-twilio: `fake-twilio/src/engine/callEngine.ts` reads the `<Dial
  action>` response on a MISS, runs `interpretTwiml` (`engine/
  twimlInterpreter.ts`, `fast-xml-parser` WITHOUT `preserveOrder`, so sibling
  order is lost), and follows a `{ kind: 'record' }` plan into
  `leaveVoicemail`. `interpretTwiml` returns `record` whenever a `<Record>`
  element is present, regardless of what precedes it. It records NOTHING
  about the greeting verb, and `CallState` (`engine/voiceTypes.ts`) has no
  field for it, so an e2e cannot tell `<Play>` from `<Say>` today. The
  engine's deps (`CallEngineDeps`) carry `clock`, `dispatcher`, `hub`,
  `registry`, `recordingServeBase`; there is no HTTP fetch seam. `GET
  /control/calls` returns `callEngine.getCalls()` verbatim (any new
  `CallState` field is exposed; the e2e `FakeCall` type has an index
  signature).
- e2e: `e2e/fixtures/fakeVoice.ts` `placeCall(api, { from, to, scenario: {
  digit: null } })` produces a missed business-line call; `listCalls(api)`
  reads the fake's calls. `listing-photos.spec.ts` drives a hidden file input
  with `setInputFiles({ name, mimeType, buffer })`. The hermetic lane runs
  MinIO with a PER-LANE bucket (`MEDIA_BUCKET` + `MEDIA_S3_ENDPOINT` set by
  `scripts/e2e-session.mjs`), so a fixed key cannot collide across lanes;
  `workers: 1`.
- `app/src/lib/seed/media.ts` exports `minimalMp3()` (an ID3v2.3 header + one
  MPEG-1 Layer III frame, 427 bytes) that tests can reuse as a valid MP3.
- Test harness (`app/test/helpers/twilioWebhookHarness.ts`): the fake
  `mediaStore` records `mediaPuts`, `deletedMediaKeys` and `presignPosts`,
  honors `failMediaDeletes`; `head` and GET `presign` record nothing and
  there is no head-failure seam. The in-memory `settingsRepo` is
  hand-enumerated per field. `makeWebhookHarness({ withoutMediaStore: true })`
  drops the store from both the api and webhook deps. `app/test/settings.test.ts`
  drives the real repo through a stubbed DocumentClient (`GetCommand` /
  `UpdateCommand`), not DynamoDB Local.
- Infra (verified, NO change needed): CloudFront's `/api/*` behavior allows
  all methods and forwards viewer headers (`Managed-AllViewerExceptHost
  Header`), `EDGE_MUTATING_PREFIXES` in app.ts includes `/api`; the EC2 role
  grants `s3:GetObject/PutObject/DeleteObject` on `MEDIA_BUCKET/*` plus
  `s3:ListBucket`. The media bucket has VERSIONING ENABLED and no lifecycle
  rule: `DeleteObject` writes a delete marker and `PutObject` over a key keeps
  the prior version as noncurrent. The OTel incoming-span hook exports the
  full `req.url` INCLUDING the query string (phones and signed-URL params
  masked); the request logger logs `req.path` and an allowlist of headers
  (`host`, `user-agent`, `content-type`, `content-length`, `traceparent`,
  `x-forwarded-for`) only. ERROR-level log lines feed the observability
  alarms.

## 3. Decisions (given by Cameron; verbatim intent, not reopened)

1. Upload, not in-app recording. One greeting for all hours. Accept MP3 and
   WAV only (`audio/mpeg`, `audio/wav`, `audio/x-wav`), checked on the server
   by content type AND by sniffing the file header, size cap 5 MB. Reject
   anything else with: "Upload an MP3 or WAV file. iPhone voice memos are M4A;
   export or convert the recording first." The format limit is also in the
   section's helper text.
2. Storage: stream the upload to the media store under a fixed settings key
   (never buffer the whole file); store the object key, content type,
   uploaded-at time and the uploader on the org settings. Replacing overwrites
   the object and the record; removing clears both.
3. Playback: when a greeting is set, the voice webhook checks the object exists
   (HEAD through the media store), then emits `<Play>` with a presigned GET URL
   good for 10 minutes, followed by the existing `<Record>`. If no greeting is
   set, or the object is missing, or the check fails, it falls back to today's
   `<Say>` unchanged and logs a WARN with no PII. The webhook must never fail
   because of the greeting.
4. Dashboard, Settings > Voice: an upload control, the current greeting's name
   and upload date, an in-page audio player served through an authed endpoint
   (like recordings), a Replace and a Remove action with confirmation. Staff-
   facing copy in the existing settings tone; nothing tenant-facing changes.
5. Everything about who hears voicemail, when, and the recording length stays
   as it is.

Interpretations and assumptions made because the block did not say (all
flagged for the handback as questions the planner would have asked):

- A. Who may change the greeting: ADMIN only (upload, replace, remove), the
  same gate as `PUT /api/settings`. Every logged-in user may see and play it
  (the same read posture as `GET /api/settings`). A VA sees the greeting block
  read-only with no action buttons.
- B. "The uploader" is stored as the session user's `userId` and `email`
  (`SessionUser` carries no display name and the settings router has no users
  repo). The page shows "Uploaded <date> by <email>".
- C. The greeting's "name" is the uploaded file's name, sanitized (4.1). It is
  staff-facing display only; it never reaches a log line or a trace attribute
  (it travels in a request header, not the URL - 4.3).
- D. Reseeding a stack (lean or full profile) drops the greeting RECORD (full-
  item Put) and leaves the object in MinIO/S3. That is the same fate as every
  other org-settings edit on reseed and is accepted; the webhook falls back to
  `<Say>` because the record is gone.
- E. "A Replace and a Remove action with confirmation" is read as
  confirmation on REMOVE only. Replace is the file picker itself (choosing a
  file is the deliberate act) and overwrites without a second dialog.
- F. Decision 3's WARN list is read as: WARN when a greeting IS set and cannot
  be offered (object missing, store unconfigured, lookup failed or timed
  out); NO log line when no greeting is set, because that is the default
  state of every org and a WARN per missed call there is the warn-flood class
  the log-hygiene work removed.
- G. Decision 2's "never buffer the whole file" is delivered at the APP level:
  the route holds no buffer and pipes the request into the media store.
  lib-storage holds at most one 5 MiB part in memory before its single
  `PutObject`, which at this cap is the whole file (section 2). That is the
  repo's existing "streams only" posture for voicemail recordings, which use
  the same `put`. Routing the bytes through the app (rather than the
  direct-to-S3 pattern MMS and photos use) is what decision 2 says, and the
  2026-07-15 reason for the direct pattern (20 MB photo batches on one EC2
  instance) does not apply to a <= 5 MB file uploaded a handful of times a
  year by one admin.
- H. Removing or replacing on a VERSIONED bucket keeps prior versions
  (section 2). "Removing clears both" is delivered for the current version
  and the record; true deletion of old versions needs a lifecycle rule (an
  infrastructure change, out of scope; handback names it as an option).

## 4. Design

### 4.1 Constants and shared helpers (`app/src/lib/voicemailGreeting.ts`, new)

```
export const VOICEMAIL_GREETING_S3_KEY = 'settings/voicemail-greeting';
export const VOICEMAIL_GREETING_MAX_BYTES = 5 * 1024 * 1024;
export const VOICEMAIL_GREETING_PLAY_TTL_SECONDS = 600;
export const VOICEMAIL_GREETING_LOOKUP_BUDGET_MS = 2500;
export const VOICEMAIL_GREETING_MIME_TYPES: ReadonlySet<string> =
  new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav']);
export const VOICEMAIL_GREETING_REJECT_MESSAGE =
  'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.';
export const VOICEMAIL_GREETING_FILE_NAME_HEADER = 'x-greeting-file-name';
export const VOICEMAIL_GREETING_FILE_NAME_MAX_CHARS = 120;
export type VoicemailGreetingFormat = 'mp3' | 'wav';
export const VOICEMAIL_GREETING_SNIFF_BYTES = 12;
```

- `normalizeGreetingContentType(raw: string | undefined): { contentType:
  'audio/mpeg' | 'audio/wav'; format: VoicemailGreetingFormat } | undefined`:
  lower-cases, strips parameters (`; charset=...`), maps `audio/x-wav` to
  `audio/wav` (the STORED type is always one of the two canonical values),
  undefined for anything else including an absent or empty value.
- `sniffGreetingHeader(head: Buffer, format): boolean` (pure):
  - `wav`: `head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WAVE'`.
  - `mp3`: `head.length >= 3 && (head.toString('latin1', 0, 3) === 'ID3' ||
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0))`
    - an ID3v2 tag, or an MPEG audio frame sync with NON-ZERO layer bits
    (layer bits `00` is reserved and is what ADTS AAC carries, so an AAC file
    declared as MP3 is refused).
  The declared type and the sniffed header must AGREE: an MP3 body declared as
  WAV is rejected, and vice versa (decision 1: "by content type and by
  sniffing").
- `class GreetingUploadGate extends Transform`: constructed with `{ format,
  maxBytes }`. It holds back at most `VOICEMAIL_GREETING_SNIFF_BYTES` bytes
  until it has that many (or the stream ends), runs `sniffGreetingHeader`,
  and either pushes the held bytes through and becomes a pass-through, or
  destroys itself with `GreetingRejectedError('invalid_format')` having pushed
  ZERO bytes downstream. It counts bytes (`bytesSeen`) and destroys itself
  with `GreetingRejectedError('too_large')` the moment the count exceeds
  `maxBytes`. On end with fewer bytes than the sniff needs it errors
  `invalid_format`; on end with zero bytes it errors `empty`.
- `class GreetingRejectedError extends Error { reason: 'invalid_format' |
  'too_large' | 'empty' }`.
- `sanitizeGreetingFileName(raw: unknown, format): string`: non-string ->
  fallback; otherwise takes the last path segment (split on `/` and `\`),
  removes control characters (U+0000-U+001F, U+007F), trims, caps at
  `VOICEMAIL_GREETING_FILE_NAME_MAX_CHARS` CODE POINTS (`Array.from(s)
  .slice(0, 120).join('')`, never splitting a surrogate pair), and falls
  back to `greeting.mp3` / `greeting.wav` when empty.
- `withTimeout<T>(promise: Promise<T>, ms: number, label: string):
  Promise<T>`: races `promise` against a timer; on timeout rejects with
  `GreetingLookupTimeoutError(label)` and attaches a no-op `catch` to the
  original promise so its eventual rejection is never unhandled. (A small
  generic helper; if `app/src/lib` already has an equivalent when the builder
  looks, reuse it.)

### 4.2 Settings record (`app/src/repos/settingsRepo.ts`)

```
export interface VoicemailGreeting {
  s3Key: string;                       // MUST equal VOICEMAIL_GREETING_S3_KEY
  contentType: 'audio/mpeg' | 'audio/wav';
  fileName: string;                    // sanitized display name (4.1)
  sizeBytes: number;                   // bytes stored
  uploadedAt: string;                  // ISO instant
  uploadedByUserId: string;
  uploadedByEmail: string;
}
```

- `OrgSettings.voicemailGreeting?: VoicemailGreeting` - OPTIONAL, no default,
  projected by `toOrgSettings` ONLY when the stored map has ALL of: `s3Key
  === VOICEMAIL_GREETING_S3_KEY` (the constant, imported; any other key
  projects as absent so a hand-edited or corrupted record can never point the
  webhook or the audio route at a recording or an MMS object), `contentType`
  in {`audio/mpeg`, `audio/wav`}, string `fileName`, finite non-negative
  number `sizeBytes`, string `uploadedAt`, string `uploadedByUserId`, string
  `uploadedByEmail`. Anything else projects as absent (the repo's
  malformed-field posture).
- `OrgSettingsPatch` becomes `Partial<Omit<OrgSettings, 'welcomeText' |
  'voicemailGreeting'>> & { welcomeText?: string | null; voicemailGreeting?:
  VoicemailGreeting | null }`; `null` is a REMOVE (the existing null-REMOVE
  mechanism in `putOrgSettings` handles it generically - no repo write-path
  change). Stored as ONE map attribute `voicemailGreeting` on the `org` item.
- `DEFAULT_ORG_SETTINGS` is unchanged (no greeting by default).
- `app/src/routes/settings.ts`: `parsePatch` does NOT learn the field (a
  `voicemailGreeting` key in a `PUT /api/settings` body is IGNORED; pinned by a
  test), and its local `SettingsPatch` type also Omits `voicemailGreeting` so
  it cannot admit a value `parsePatch` never produces. The only writers are
  the two routes in 4.3 and 4.4.

### 4.3 Upload / replace: `PUT /api/settings/voicemail-greeting`

Mounted inside `createSettingsRouter` (so it lives under the existing
`/api/settings` prefix: `requireAuth` from the `/api` mount, `csrfOrigin`,
CloudFront's `/api/*` behavior - no infra). Gate: `requireRole('admin')`, then
a `createUserRateLimit({ routeKey: 'voicemail_greeting_upload', max: 10,
windowMs: 60_000 })` fence (one instance per router). New deps on
`SettingsRouterDeps`: `mediaStore?: MediaStore` (api.ts passes the one it
already built; undefined when `MEDIA_BUCKET` is unset).

Request: the RAW file bytes as the body (`Content-Type: <the canonical audio
type>`), NOT multipart - there is no multipart parser and none is added (no
new dependency). The display name rides the request header
`X-Greeting-File-Name`, URI-encoded (`encodeURIComponent(file.name)`, so the
header value is always ASCII); the server `decodeURIComponent`s it inside a
try/catch (a malformed encoding reads as absent). NOT the query string: the
OTel span exports the query and the mutation catalog needs a literal path
(section 2). Express's JSON and urlencoded parsers skip an `audio/*` body, so
`req` is the unread stream.

Handler order (each step's failure answers before any storage write; every
refusal sets `Connection: close` and reads nothing further - the unread
remainder of the body is dropped with the connection, never drained without
bound):

1. `!mediaStore` -> 503 `{ error: 'media_storage_unavailable' }`.
2. `normalizeGreetingContentType(req.headers['content-type'])` undefined ->
   400 `{ error: 'unsupported_media_type', message:
   VOICEMAIL_GREETING_REJECT_MESSAGE }` (absent, empty, `audio/mp4`,
   `audio/x-m4a`, `video/mp4`, anything else).
3. `Content-Length` header present and `> VOICEMAIL_GREETING_MAX_BYTES` -> 413
   `{ error: 'file_too_large', maxBytes }` (cheap refusal before reading; the
   gate below is the authority when the header is absent or lies).
   `Content-Length: 0` -> 400 `{ error: 'empty_file' }`.
4. Build `gate = new GreetingUploadGate({ format, maxBytes })`; wire
   `pipeline(req, gate, (err) => { /* errors surface through the gate */ })`
   (callback form from `node:stream`, so a `req` error or abort destroys the
   gate and a gate error destroys `req`), then IN THE SAME TICK call
   `const putPromise = mediaStore.put(VOICEMAIL_GREETING_S3_KEY, gate,
   contentType)` (lib-storage attaches its consumer synchronously inside
   `put`; no `await` may sit between the pipeline call and the put, or an
   error can fire with no listener). `await putPromise`.
   - `GreetingRejectedError('invalid_format')` -> 400 `unsupported_media_type`
     with the same message; `'too_large'` -> 413 `file_too_large`; `'empty'`
     -> 400 `empty_file`.
   - A client abort (`req.destroyed` / `req.aborted`, or an error whose
     `code` is `ECONNRESET` / `'aborted'`): WARN `{ actor, reason:
     'client_aborted' }`, no response (the connection is gone), nothing
     stored.
   - Any other error -> 500 `{ error: 'upload_failed' }` with an ERROR log
     `{ err, actor, s3Key }` (no bytes, no name).
   - Because the gate errors BEFORE pushing any byte when the header is bad,
     and lib-storage sends its single `PutObject` only after the gate ENDS
     cleanly, a refused or aborted upload never reaches S3: the previously
     stored greeting is byte-identical afterwards (a route test pins this).
     Replacing is atomic for the same reason: one `PutObject`, sent whole.
5. On success: `const record: VoicemailGreeting = { s3Key, contentType,
   fileName: sanitizeGreetingFileName(decodedHeader, format), sizeBytes:
   gate.bytesSeen, uploadedAt: new Date().toISOString(), uploadedByUserId:
   req.user.userId, uploadedByEmail: req.user.email }`; `await
   settings.putOrgSettings({ voicemailGreeting: record })`; then the audit
   append `audit.append(ORG_SETTINGS_ENTITY_KEY, 'settings_updated', {
   fields: ['voicemailGreeting'], action: 'uploaded', actor: userId })` is
   BEST-EFFORT (`.catch` -> ERROR log; never a 500 once the greeting is live -
   the caller would otherwise be told the upload failed while callers already
   hear it); INFO log `{ actor, s3Key, contentType, sizeBytes }` (never the
   file name); respond 200 `{ voicemailGreeting: record }`.
   If the settings write fails AFTER the put: 500 `{ error:
   'greeting_record_failed' }` and an ERROR log; the object holds the new bytes
   and the record is stale or absent. The UI re-fetches on the next load; the
   webhook reads the record, so the worst case is the OLD record (or none)
   describing the NEW bytes at the same fixed key - a stale display name/date,
   never a broken call.

Concurrency (single org, admin-only, accepted; the end states are named so
nobody is surprised):

- Two admins uploading at once: the two `PutObject`s and the two record SETs
  are independent writes; the end state can be object B with record A (name,
  type, size from A). The next upload repairs it.
- Upload interleaved with Remove (put A -> REMOVE record + delete object ->
  SET record A): a record with no object. The webhook WARNs and says the
  prompt on every missed call, and the dashboard shows the greeting with a
  player that cannot load; 4.7 renders that state visibly ("The greeting file
  is missing...") so it is repaired by a re-upload rather than found by a
  caller.

### 4.4 Remove: `DELETE /api/settings/voicemail-greeting`

`requireRole('admin')`. Order (the RECORD is the authority):

1. `await settings.putOrgSettings({ voicemailGreeting: null })` (REMOVE).
2. `if (mediaStore) await mediaStore.deleteObject(VOICEMAIL_GREETING_S3_KEY)
   .catch(err => log.warn(...))` - best effort; a leftover object under the
   fixed key is harmless (unreferenced, overwritten by the next upload) and the
   webhook reads the record, not the bucket, to decide whether to `<Play>`.
   On the versioned media bucket this writes a delete marker; prior versions
   of the greeting persist (assumption H). A call whose TwiML was built in
   the seconds before this delete fetches a 404 from Twilio's side (section 1
   residual).
3. Best-effort audit `settings_updated` `{ fields: ['voicemailGreeting'],
   action: 'removed', actor }`; INFO log; 204.

Removing when nothing is set is a 204 no-op (REMOVE of an absent attribute is
a no-op; DeleteObject is idempotent).

### 4.5 Read and play back

- `GET /api/settings` (unchanged route) now carries `settings.voicemailGreeting`
  when set (it is part of `OrgSettings`). No new read endpoint for metadata.
- `GET /api/settings/voicemail-greeting/audio` (requireAuth from the mount; any
  logged-in user): streams the object like the recording route. Implemented by
  extracting the recording route's stream/range/416 logic into a shared helper
  `serveMediaObject(req, res, { mediaStore, key, defaultContentType,
  cacheControl, notFound: { error: 'greeting_not_found' }, log, logContext })`
  in `app/src/routes/serveMediaObject.ts`, and re-pointing `GET
  /api/calls/:callId/recording` at the same helper with its current values
  (`recording_not_found`, `audio/mpeg`, `private, max-age=3600`, `{ callSid
  }`). The existing recording tests (`app/test/voiceRecording.test.ts`
  ranges/416/404/cache) are the regression guard for the extraction; their
  assertions do not change.
  - 404 `greeting_not_found` when `settings.getOrgSettings().voicemailGreeting`
    is absent, the store is unconfigured, or the object is gone.
  - `Cache-Control: private, max-age=3600` (same posture as recordings) and
    the dashboard appends `?v=<uploadedAt>` so a Replace is never served from
    the browser cache (the URL changes with every upload). A GET with a query
    is fine for the mutation catalog (GETs are not cataloged) and for the
    OTel span (an ISO instant is not PII).
  - `Content-Type` from the object (falls back to the record's contentType).

### 4.6 Voice webhook playback (`app/src/routes/webhooks/voice.ts`)

In the `/status` handler's missed-inbound-founder-bridge branch, replace the
single `reply.say(voice.voicemail_prompt)` line with a call to a local helper
`await addVoicemailGreeting(reply, entryCallSid)`:

```
let played = false;
try {
  played = await withTimeout(
    (async () => {
      const org = await settings.getOrgSettings();
      const greeting = org.voicemailGreeting;
      if (greeting === undefined) return false;          // normal state: no log
      if (!mediaStore) {
        log.warn({ callSid, s3Key: greeting.s3Key },
          'voicemail greeting set but no media store configured - using the spoken prompt');
        return false;
      }
      const head = await mediaStore.head(greeting.s3Key);
      if (head === undefined) {
        log.warn({ callSid, s3Key: greeting.s3Key },
          'voicemail greeting object missing - using the spoken prompt');
        return false;
      }
      const url = await mediaStore.presign(greeting.s3Key, VOICEMAIL_GREETING_PLAY_TTL_SECONDS);
      reply.play(url);
      log.info({ callSid, s3Key: greeting.s3Key }, 'voicemail greeting offered');
      return true;
    })(),
    VOICEMAIL_GREETING_LOOKUP_BUDGET_MS,
    'voicemail greeting lookup',
  );
} catch (err) {
  // A thrown store/settings error OR the budget expiring land here.
  log.warn({ err, callSid, budgetMs: VOICEMAIL_GREETING_LOOKUP_BUDGET_MS },
    'voicemail greeting lookup failed or timed out - using the spoken prompt');
}
if (!played) reply.say(resolveMessage('voice.voicemail_prompt'));
```

- The WHOLE lookup (GetItem + HeadObject + presign) is bounded by
  `VOICEMAIL_GREETING_LOOKUP_BUDGET_MS = 2500` because neither the DynamoDB
  nor the S3 client has a request timeout (section 2) and a hung call would
  otherwise hold the TwiML past Twilio's webhook budget - the exact failure
  decision 3 forbids. On timeout the still-pending lookup is abandoned
  (`withTimeout` swallows its eventual rejection); if it later resolves, its
  `reply.play` cannot run because the closure has already returned - the
  builder guards this explicitly: the closure checks a `settled` flag before
  touching `reply` (set by `withTimeout` on expiry), so a late resolution
  never appends a `<Play>` after `<Say>`.
- `played` is set ONLY when `reply.play` was called; a `<Play>` and the
  `<Say>` prompt are never both emitted.
- The `<Record>`, `voicemail_thanks` and `<Hangup>` that follow are untouched;
  `VOICEMAIL_MAX_LENGTH_SECONDS` / `VOICEMAIL_SILENCE_TIMEOUT_SECONDS` are
  untouched (decision 5).
- The masked/outbound `else if (isMissed)` branch and `/voicemail-done` are
  untouched: the greeting is business-line voicemail only, like the prompt it
  replaces.
- Logging (assumption F): nothing when no greeting is set; WARN for
  store-unconfigured-with-greeting, object missing, thrown error, or timeout;
  INFO `voicemail greeting offered` when `<Play>` was emitted (it proves the
  TwiML, not that Twilio played the file). PII: the log lines carry `callSid`
  and the fixed `s3Key` only; the presigned URL is a bearer token and is NEVER
  logged (the mediaStore doc rule).
- `<Play>` gets the presigned URL as its text; VoiceResponse XML-escapes the
  `&` in the query string. Twilio fetches the audio when it plays it, within
  the 10-minute TTL (the call is live at that moment).

### 4.7 Dashboard (`dashboard/src/routes/settings/VoiceSection.tsx` and friends)

- API (`dashboard/src/api/types.ts`, additive): `VoicemailGreeting` mirror of
  4.2; `OrgSettings.voicemailGreeting?: VoicemailGreeting`; `SettingsPatch =
  Partial<Omit<OrgSettings, 'welcomeText' | 'voicemailGreeting'>> & {
  welcomeText?: string | null }` (the server ignores the field on PUT, so the
  type must not advertise it).
- `dashboard/src/api/client.ts` (ADDITIVE, the JSON path byte-identical):
  `RequestOptions` gains `rawBody?: Blob` and `headers?: Record<string,
  string>`. When `rawBody` is set, `requestWithStatus` sends it as the fetch
  body with the caller's headers (the caller sets `Content-Type`) and does
  NOT JSON-serialize; `body` and `rawBody` are mutually exclusive (a
  programmer error to pass both - throw). Everything else (credentials,
  `noteServerDate` on every response, `parseBody`, `errorFrom`) is reused, so
  the upload's errors become `ApiError`s with the server's `code` and the
  server-clock hook keeps its "every response" rule.
- `endpoints.ts` (additive; every call has a LITERAL path for the mutation
  scanner): `uploadVoicemailGreeting(file: File, contentType: string):
  Promise<VoicemailGreeting>` = `request<{ voicemailGreeting }>(
  '/api/settings/voicemail-greeting', { method: 'PUT', rawBody: file,
  headers: { 'Content-Type': contentType, 'X-Greeting-File-Name':
  encodeURIComponent(file.name) } })`; `removeVoicemailGreeting():
  Promise<void>` = `request<void>('/api/settings/voicemail-greeting', {
  method: 'DELETE' })`; `voicemailGreetingAudioUrl(g): string` =
  `/api/settings/voicemail-greeting/audio?v=<encodeURIComponent(uploadedAt)>`.
- A new hook `useVoicemailGreeting()` (in `dashboard/src/routes/settings/`):
  loads `getSettings()` once for the greeting (a small dedicated hook rather
  than `useSettings`, whose `save` is the Templates JSON PUT and would need a
  non-JSON special case), exposes `{ status: 'loading' | 'ready' | 'error',
  greeting, upload(file), remove(), error, busy, retry, notice }`.
  Client-side pre-checks in `upload` BEFORE the request, with the SAME message
  as the server: derive the content type as `file.type` when it is in the
  allowlist, else from the extension when `file.type` is EMPTY (`.mp3` ->
  `audio/mpeg`, `.wav` -> `audio/wav`), else reject -> the reject message
  inline (so an empty browser-reported type on a real MP3 still reaches the
  server, which decides by the header bytes); `file.size > 5 MB` -> "That
  file is over 5 MB. Trim or re-export it at a lower bitrate." `size === 0`
  -> "That file is empty." Server errors map: `unsupported_media_type` -> the
  reject message; `file_too_large` -> the 5 MB line; `empty_file` -> "That
  file is empty."; `media_storage_unavailable` -> "Media storage isn't
  available right now. Try again in a minute."; `forbidden` -> "Only an admin
  can change the greeting."; anything else -> "Couldn't upload the greeting.
  Try again."
- New component `VoicemailGreetingBlock` rendered INSIDE the existing Voice
  section (same `<section aria-labelledby="voice-heading">`) BELOW and
  OUTSIDE the `useMe` loading/error ternary (a `/users/me` failure never
  hides the greeting), as its own sub-block with an `<h3>` "Voicemail
  greeting". Admin gating reads `useOptionalAuth()?.isAdmin === true` (never
  `useAuth()`, which throws without a provider and would break the existing
  VoiceSection suite).
  - Helper text: "When a call to the business line isn't answered, callers hear
    this greeting before the beep. Upload an MP3 or WAV file up to 5 MB. iPhone
    voice memos are M4A; export or convert the recording first. Without a
    greeting, callers hear the built-in spoken prompt."
  - Loading: a `Spinner` inside the block. LOAD FAILURE: a `role="status"` line
    "Couldn't load the voicemail greeting." with a "Retry" button - NEVER a
    `role="alert"` (the cell-verification flow above owns the section's alert
    semantics; the existing tests query a single alert, and the perf terminal
    forbids an alert at load).
  - No greeting: `role="status"` line "No greeting uploaded - callers hear the
    built-in prompt." and, for admins, a button "Upload greeting".
  - Greeting set: the file name (as text), "Uploaded <Mon D, YYYY> by <email>"
    (`toLocaleDateString` like `fmtVerifiedAt`), an `<audio controls
    preload="none" aria-label="Voicemail greeting" src={audioUrl}>` (a plain
    `<audio>`; no downmix), and for admins the buttons "Replace greeting" and
    "Remove greeting". The audio element's `onError` sets a `role="status"`
    line "The greeting file is missing or can't be played. Upload it again."
    (the 4.3 interleave state made visible).
  - The upload/replace button opens a hidden `<input type="file"
    accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" aria-label="Greeting
    audio file">` (same hidden-input pattern as ListingDetail photos; the e2e
    drives it with `setInputFiles`). While uploading the button reads
    "Uploading..." and is disabled; success shows `role="status"` "Greeting
    uploaded." (or "Greeting replaced.") and the block re-renders from the
    response.
  - "Remove greeting" opens a `Modal` titled "Remove voicemail greeting?" with
    body "Callers will hear the built-in spoken prompt instead. You can upload
    a new greeting any time." and footer Cancel / Remove (danger, "Removing..."
    while busy; the dialog cannot be dismissed while busy - the
    ConfirmRemoveDialog shape). Success closes the dialog and shows
    `role="status"` "Greeting removed."
  - USER-ACTION errors (upload/remove failures) render in a `<p role="alert">`
    under the controls (only ever present after an action inside the block).
  - VA (non-admin): everything above minus the buttons; the helper text gains
    "An admin can upload or change it."
  - Phone width: the block stacks (name/date over the player over the buttons)
    inside the section's existing max-width; the audio element is
    `width: 100%`; buttons wrap. No sideways scroll of the routed `<main>` at
    360px, and the Remove dialog's own box does not overflow.
- Styles go in `VoiceSection.module.css` (existing file), new class names only.
- Perf route contract: `e2e/performance/routes.ts` `VOICE_GETS` gains
  `required('/api/settings')` and `routes.test.ts` (~line 112) is updated to
  match. Mutation catalog: `e2e/performance/mutationCatalog.ts` gains
  `entry(ENDPOINTS, 'uploadVoicemailGreeting', 'request:PUT',
  '/api/settings/voicemail-greeting')` and `entry(ENDPOINTS,
  'removeVoicemailGreeting', 'request:DELETE',
  '/api/settings/voicemail-greeting')`, and the pinned count in
  `mutationCatalog.test.ts` moves from 108 to 110.

### 4.8 fake-twilio (in-repo test double; e2e observability)

- `engine/twimlInterpreter.ts`: the `record` plan gains `greeting: 'play' |
  'say' | 'none'` and `playUrl?: string`, defined as THE VERB IMMEDIATELY
  BEFORE `<Record>` in document order: `'play'` when the element preceding
  `<Record>` is `<Play>` (its text is `playUrl`), `'say'` when it is `<Say>`,
  `'none'` when `<Record>` is the first verb. Implemented with a second parse
  using `fast-xml-parser`'s `preserveOrder: true` over the same XML (the
  existing tag-keyed parse is untouched). Generic parsing, no app-specific
  assertions.
- `engine/voiceTypes.ts` `CallState` gains `voicemailGreeting?: 'play' | 'say'
  | 'none'` and `voicemailGreetingFetchStatus?: number` (the HTTP status the
  fake got when it GET the `playUrl`, best effort: on a network error it
  records 0).
- `engine/callEngine.ts`: `CallEngineDeps` gains `fetchStatus?: (url: string)
  => Promise<number>` (default: global `fetch`, consuming and discarding the
  body, 5s `AbortSignal.timeout`, returning `res.status`; 0 on any throw).
  `leaveVoicemail` sets `call.voicemailGreeting = plan.greeting`; when
  `plan.playUrl` is set it awaits `fetchStatus(playUrl)`, records the status,
  and continues regardless. This makes the e2e's "the presigned URL actually
  serves the file" a boundary proof (the URL points at the lane's MinIO, which
  the fake process can reach), not a string match. Unit tests inject a stub.
- `GET /control/calls` needs no change (returns `CallState` verbatim).

### 4.9 Surfaces enumerated (the invariant "a set greeting is what callers hear")

Writers of `org.voicemailGreeting`:

| surface | behavior |
|---|---|
| `PUT /api/settings/voicemail-greeting` (4.3) | SET after a successful put |
| `DELETE /api/settings/voicemail-greeting` (4.4) | REMOVE, then best-effort delete |
| `PUT /api/settings` (`parsePatch`) | IGNORES the key (pinned by test); its local `SettingsPatch` Omits it |
| seeds `lean.ts` / `matrix.ts` (full-item Put) | drop it on reseed (assumption D) |
| `POST /__dev/reseed` | via the seeds, same (full profile also PUTs cast media; deletes nothing) |
| `settingsRepo.putOrgSettings` generic null-REMOVE | the mechanism 4.4 uses; `OrgSettingsPatch` typed for it |
| test fake `twilioWebhookHarness.ts` settingsRepo | MUST mirror the field (SET on patch, delete on null) so webhook tests can set it |

Readers / renderers:

| surface | behavior |
|---|---|
| `settingsRepo.toOrgSettings` | projects only a well-formed map with the fixed key (4.2) |
| `GET /api/settings` + `PUT /api/settings` responses | carry it inside `settings` |
| `/webhooks/twilio/voice/status` miss branch (4.6) | `<Play>` or `<Say>` fallback, time-bounded |
| `GET /api/settings/voicemail-greeting/audio` (4.5) | streams it or 404 |
| dashboard `VoicemailGreetingBlock` (4.7) | renders it |
| dashboard `TemplatesSection`, `QuietHoursSection`, `NumbersSection`, `SystemStatusSection` (via `useSettings`), `QuickReply` (direct `getSettings`) | untouched; each reads named fields, none spreads the record |
| `settingsToOverrides()` (message catalog overrides, `messages/resolve.ts`) | reads named fields only; unaffected |
| `fake-twilio` (4.8) | observes the verb for e2e |

Static/test surfaces that must stay green (gate 2):

| surface | change |
|---|---|
| `dashboard/src/routes/settings/VoiceSection.test.tsx` | mock `getSettings` (resolves with no greeting) so the block loads quietly; no new alert at load |
| `e2e/tests/dashboard-next/voice-outbound.spec.ts` (~690, zero alerts on the Voice tab) | must keep passing (the block never renders an alert at load) |
| `e2e/performance/mutationCatalog.ts` + `.test.ts` | two entries, count 108 -> 110 |
| `e2e/performance/routes.ts` + `routes.test.ts` | `VOICE_GETS` gains `/api/settings` |
| `e2e/support/viewport.guard.test.ts` | the new spec uses the viewport helpers, never `documentElement.scrollWidth` |
| `app/test/voiceRecording.test.ts` | unchanged assertions guard the `serveMediaObject` extraction |
| `app/test/helpers/twilioWebhookHarness.ts` | settings fake learns the field; media fake gains `mediaHeads` / `mediaPresigns` recorders and `failMediaHeads` / `hangMediaHeads` seams |

### 4.10 Logging, PII, limits

- Never log: the file name, the presigned URL, any byte of audio. Log:
  `s3Key` (fixed), `contentType`, `sizeBytes`, `actor` userId, `callSid`.
  The file name travels in a header (not logged, not on the span) and lands
  only in the settings record and the dashboard.
- ERROR level is reserved for server faults (a failed put, a failed record
  write); a client abort or a refused file is WARN/INFO (ERROR lines feed the
  alarms).
- Limits: 5 MB (`VOICEMAIL_GREETING_MAX_BYTES`), 10 uploads/min/user, 10-minute
  play TTL, 2.5 s lookup budget, 120-code-point display name.
- No message-catalog entry is added (all new copy is staff-facing settings
  copy); `voice.voicemail_prompt` stays as the fallback.
- No new dependency; no infrastructure change (section 2 verifies the route
  prefix, IAM and CloudFront). Known infra-side facts carried to the
  handback: prior greeting versions persist on the versioned bucket
  (assumption H); whether CloudFront's `origin_read_timeout` (30 s) can fire
  during a slow 5 MB upload from a poor connection is UNVERIFIED (if it does,
  the admin sees a network error while the upload still completes and the
  next page load shows it).

## 5. Testing

Unit (vitest, `app/test/`):

- `voicemailGreeting.test.ts`: `normalizeGreetingContentType` (the three
  accepted values, parameters stripped, `audio/x-wav` canonicalized; `audio/
  mp4`, `audio/x-m4a`, `video/mp4`, empty and undefined rejected);
  `sniffGreetingHeader` (ID3, frame-sync 0xFFFB / 0xFFE3 accepted; RIFF/WAVE
  accepted; an M4A `ftyp` box, a PNG header and an ADTS AAC sync 0xFFF1 /
  0xFFF9 rejected under both formats; a WAV header declared MP3 rejected and
  vice versa); `GreetingUploadGate` (passes a valid stream byte-exact; rejects
  a bad header with `invalid_format` having pushed 0 bytes downstream; rejects
  at `maxBytes + 1` with `too_large`; `empty` on a zero-byte stream; a 2-byte
  stream -> `invalid_format`); `sanitizeGreetingFileName` (non-string, path
  stripping, control chars, code-point cap on a string of astral characters,
  fallback); `withTimeout` (resolves, rejects, times out, and a late
  rejection of the abandoned promise is not unhandled).
- `settings.test.ts` additions (stubbed DocumentClient, the file's existing
  style): projection of a well-formed map; `null` -> a REMOVE expression; a
  map with a foreign `s3Key`, a missing `contentType`, or a wrong-typed
  `sizeBytes` projects as absent.
- Routes (`voicemailGreetingRoutes.test.ts`, supertest against
  `makeWebhookHarness`): 401 no session; 403 VA on PUT/DELETE; 503 when
  `withoutMediaStore`; 400 `unsupported_media_type` with the exact message for
  `audio/mp4`, for an ABSENT Content-Type, and for `audio/mpeg` declared over
  WAV bytes (sniff); 413 via `Content-Length` and via a chunked body that
  exceeds the cap; 400 `empty_file`; every refusal carries `Connection:
  close`; happy path MP3 (`minimalMp3()`) and WAV (a 44-byte PCM header +
  silence built inline) -> 200 with the record, the harness `mediaPuts` shows
  ONE put under the fixed key with the canonical content type, `GET
  /api/settings` carries the record, audit event appended with `action:
  'uploaded'`; the file name from `X-Greeting-File-Name` is decoded and
  sanitized (a percent-encoded non-ASCII name round-trips; a bad encoding
  falls back); replace overwrites (second put, record updated, `uploadedAt`
  advances); a refused second upload (bad header, too large) leaves the
  stored object BYTE-IDENTICAL and the record unchanged; DELETE -> 204,
  record gone, `deletedMediaKeys` contains the key, audit `removed`; DELETE
  when the object delete rejects (`world.failMediaDeletes`) still clears the
  record and answers 204 with a WARN; an audit failure after a successful
  upload still answers 200 (ERROR logged); `PUT /api/settings {
  voicemailGreeting: {...} }` leaves the record untouched; `GET .../audio`
  200 with `Accept-Ranges` and the object's content type, 206 on a range, 404
  when unset, 404 when the object is gone; the recording route's existing
  range tests still pass after the helper extraction; no log line contains
  the file name.
- Webhook (`founderTriage.test.ts` additions, using the harness's in-memory
  settings + fake mediaStore with the new seams): (a) greeting set AND object
  present -> the `/status` miss TwiML contains `<Play>` with the harness's
  presigned URL shape (`X-Amz-Signature`) BEFORE `<Record`, and does NOT
  contain the `voice.voicemail_prompt` text; `<Record maxLength=...>` and the
  thanks are unchanged; `mediaHeads` and `mediaPresigns` each record the
  fixed key once; the INFO `voicemail greeting offered` line is present;
  (b) no greeting -> `<Say>` prompt exactly as today (the existing assertions
  keep passing untouched) and NO greeting log line at any level; (c)
  greeting set but the object missing from the fake store -> `<Say>` prompt
  AND a WARN line matching /voicemail greeting object missing/ with no URL in
  it; (d) greeting set and `head` throwing (`failMediaHeads`) -> `<Say>` +
  WARN, 200; (e) greeting set and `head` NEVER settling (`hangMediaHeads`)
  -> the response arrives with `<Say>` within the budget (fake timers or a
  budget injected through a dep; the test must prove the bound, not just the
  fallback) and a WARN mentioning the timeout, and no `<Play>` is ever
  appended afterwards; (f) greeting set, `withoutMediaStore` -> `<Say>` +
  WARN; (g) masked relay miss with a greeting set -> still the goodbye, no
  `<Play>`.
- fake-twilio (`fake-twilio/test`): `interpretTwiml` on Play+Record+Say yields
  `greeting: 'play'` + `playUrl`; on Say+Record+Say yields `'say'`; on
  Record+Say yields `'none'`; on Say+Play+Record (a Say then a Play) yields
  `'play'`; `leaveVoicemail` records `voicemailGreeting` and the injected
  `fetchStatus` result, and proceeds when `fetchStatus` throws (status 0).
- Dashboard (`VoicemailGreetingBlock.test.tsx`, RTL with mocked endpoints and
  a mocked `useOptionalAuth`): renders "No greeting uploaded" + "Upload
  greeting" for an admin; VA sees no buttons; a load failure renders the
  status line + Retry and NO alert; choosing an `audio/mp4` file shows the
  reject message WITHOUT calling the endpoint; a file with an EMPTY type and a
  `.mp3` name calls the endpoint with `audio/mpeg`; choosing a 6 MB file
  shows the size message without a call; a valid file calls
  `uploadVoicemailGreeting` and renders the name, date, player (`aria-label=
  "Voicemail greeting"`, `src` containing `?v=`) and the Replace/Remove
  buttons; the player's error event renders the missing-file status line;
  Remove opens the dialog, Cancel closes it without a call, Remove calls the
  endpoint and returns to the empty state with the status message; a
  `forbidden` error renders the admin-only message as an alert.
  `VoiceSection.test.tsx` gains a `getSettings` mock (no greeting) and its
  existing assertions stay byte-identical. `client.test.ts` (or the nearest
  existing client test) pins the `rawBody` path: no JSON serialization, the
  caller's headers sent, `noteServerDate` still called, an error body still
  mapped to `ApiError`.

Playwright (`e2e/tests/dashboard-next/voicemail-greeting.spec.ts`, hermetic
lane only; accessibility-first selectors):

1. Reseed; dev-login as `founder@example.com` (admin); go to
   `/settings/voice`; expect heading "Voicemail greeting" (level 3) and the
   "No greeting uploaded" status; `setInputFiles` on the file input
   (`getByLabel('Greeting audio file')`) with a generated 44-byte-header WAV
   (`{ name: 'sam-greeting.wav', mimeType: 'audio/wav', buffer }`); expect the
   status "Greeting uploaded.", the text `sam-greeting.wav`, and the audio
   element (`getByLabel('Voicemail greeting')`) whose `src` contains
   `/api/settings/voicemail-greeting/audio?v=`; `page.request.get` that URL ->
   200 with `content-type` `audio/wav` and `accept-ranges: bytes` (playability
   at the API boundary; the browser's `<audio>` cannot be observed playing in
   headless CI, so this is the stated proxy).
2. `placeCall(api, { from: uniqueVoicePhone(), to: BUSINESS, scenario: {
   digit: null, voicemail: { durationSec: 3 } } })`; poll `listCalls` for that
   sid; expect `voicemailGreeting === 'play'` and
   `voicemailGreetingFetchStatus === 200` (the fake fetched the presigned MinIO
   URL).
3. Click "Remove greeting"; in the dialog (`getByRole('dialog', { name:
   'Remove voicemail greeting?' })`) click "Remove"; expect "Greeting removed."
   and the empty-state line; `page.request.get` the audio URL -> 404.
4. Place a second missed call; expect `voicemailGreeting === 'say'` (the verb
   before `<Record>` is the spoken prompt again).
5. Phone width, a separate test: `page.setViewportSize(NARROW_360)`; upload
   as in step 1; `expectNoHorizontalOverflow(page, '/settings/voice')`; the
   player and the Replace/Remove buttons are visible; open the Remove dialog
   and `expectNoHorizontalOverflowIn(dialog, 'Remove voicemail greeting
   dialog')`; Cancel; `page.setViewportSize(WIDE_RESTORE)` at the end. NEVER
   `documentElement.scrollWidth` (the guard test fails the file).
6. Reject path in the real UI: `setInputFiles` an `audio/mp4` buffer -> the
   reject message appears as an alert and no greeting is listed.
7. VA path: dev-login as `va@example.com`, visit `/settings/voice`, expect the
   greeting block without "Upload greeting"/"Remove greeting" buttons and, at
   load, no alert on the page (the existing zero-alert assertion in
   `voice-outbound.spec.ts` stays green).

All five completion gates from AGENTS.md run bare from the worktree.

## 6. Out of scope (not built; filed if worth tracking)

- Recording the greeting by phone through the platform.
- Per-time-of-day or per-teammate greetings.
- Any change to the missed-call ladder, founder bridge, quiet hours, recording
  length, or the thanks/goodbye copy.
- Transcoding or normalizing the uploaded audio (Twilio plays MP3 and PCM WAV
  as-is; an exotic WAV encoding that Twilio cannot play is a support
  conversation, not a code path). Issue to file:
  `voicemail-greeting-format-normalization` (improvement, low) so the option
  is on record. The same issue records the UNVERIFIED Twilio-side behavior
  when a `<Play>` URL cannot be fetched or decoded (skip to the next verb vs.
  end the call) and the dev check that settles it (section 7).
- True deletion of prior greeting versions on the versioned media bucket (a
  lifecycle rule; infrastructure). Named in the handback, not filed as a
  bug: every removal precedent on this bucket (unit-photo removal) has the
  same property.
- Twilio-side media caching semantics: the presigned URL changes per call, so
  a replaced greeting is heard on the next call; no cache invalidation exists
  or is needed.

## 7. Handback and dev verification

After deploy to dev (Cameron's step, not this branch's): upload a greeting in
Settings > Voice on the dev dashboard, call the dev business number, do not
answer on the holder's cell, and confirm the caller hears the uploaded audio,
then the beep. Remove it and repeat: the computer voice returns. The dev app
log shows `voicemail greeting offered` on the first call and no
greeting-related line on the second. Optional third check (settles the
section 6 UNVERIFIED item): upload a WAV Twilio cannot decode (for example a
32-bit float WAV), call, and note whether the caller hears silence then the
beep, or Twilio's error; record the answer in
`docs/issues/voicemail-greeting-format-normalization.md`.
