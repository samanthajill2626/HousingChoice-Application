# Recorded voicemail greeting - design specification

Status: DRAFT 1 - written under Cameron's overnight, unattended mission block
(every product decision below was handed down in that block; none is reopened
here). Adversarial document review rounds are recorded in
`docs/superpowers/reviews/2026-09-26-voicemail-greeting/`.
Date: 2026-09-26
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

The voice webhook can never fail because of the greeting: any problem with it
(no greeting set, the file gone from storage, storage unreachable) falls back
to today's spoken prompt and writes one WARN line with no personal data.

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
  TwiML with a prompt.
- The router already holds `settings` (a `SettingsRepo`, injectable through
  `TwilioVoiceWebhookDeps.settingsRepo`) and `mediaStore` (a `MediaStore |
  undefined`, injectable through `deps.mediaStore`, undefined when
  `MEDIA_BUCKET` is unset). The inbound `/voice` handler already reads
  `settings.getOrgSettings()` on the TwiML path inside a try/catch that WARNs
  and falls back to a default (`preRingPauseSeconds`, line ~771). That is the
  defended-read pattern this feature copies.
- `app/src/adapters/mediaStore.ts` `MediaStore` has `put(key, Readable,
  contentType)` (lib-storage `Upload`, aborts the multipart upload when the
  body errors), `getStream(key, { range? })` (undefined on NoSuchKey/404),
  `head(key)` (undefined on 404), `presign(key, ttlSeconds)` (signed with the
  store's own client, MinIO parity), `deleteObject(key)` (idempotent).
  `createMediaStore` returns undefined without `MEDIA_BUCKET`.
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
  presigned POST; the app never streams upload bytes. There is no multipart
  parser (busboy/multer) in `app/package.json`. `app/src/app.ts` mounts only
  `express.json` and `express.urlencoded` body parsers (stage 3), so a request
  whose Content-Type is neither JSON nor form-urlencoded reaches its route with
  the body UNREAD and `req` still a readable stream.
- `app/src/repos/settingsRepo.ts`: `OrgSettings` is the singleton item
  `settingId = 'org'`; `getOrgSettings()` projects the stored item over
  `DEFAULT_ORG_SETTINGS` with per-field type checks (a malformed field reads
  as its default; `welcomeText` is optional and projected only when a string
  is stored); `putOrgSettings(patch)` is an `UpdateCommand` merge (SET per
  present field, REMOVE for a `null` value, ALL_NEW). `app/src/routes/
  settings.ts`: `GET /api/settings` (requireAuth) returns `{ settings,
  welcomeTextDefault, businessPhoneNumber? }`; `PUT /api/settings`
  (requireRole('admin')) runs `parsePatch`, which copies ONLY the fields it
  knows (`missedCallAutoText`, `missedCallAutoTextEnabled`, `quickReplies`,
  `preRingPauseSeconds`, `quietHours*`, `timezone`, `welcomeText`) and ignores
  everything else, then appends a `settings_updated` audit event with
  `{ fields, actor }` on `ORG_SETTINGS_ENTITY_KEY`.
- Seeds: `app/src/lib/seed/lean.ts` writes `{ settingId: 'org',
  quietHoursEnabled: false }`; `matrix.ts` (full profile) writes a full `org`
  row. Both are FULL-ITEM Puts, so a reseed REPLACES the org item and drops any
  attribute the seed does not carry. `POST /__dev/reseed` does not touch
  MinIO objects.
- Dashboard: `dashboard/src/api/types.ts` `OrgSettings` MIRRORS the app type
  by hand; `endpoints.ts` `getSettings` / `putSettings`; `client.ts`
  `requestWithStatus` serializes ONLY JSON bodies (no raw-body option; the one
  non-JSON upload, the presigned POST at endpoints.ts ~1175, calls `fetch`
  directly). `dashboard/src/routes/settings/VoiceSection.tsx` is the Voice tab
  (`/settings/voice`, visible to every logged-in user per `settingsTabs.ts`):
  it renders the self cell-verification flow off `useMe()`; it does not read
  org settings today. `useAuth().isAdmin` is the admin gate the rest of the
  Settings page uses. `dashboard/src/routes/contact/Modal.tsx` is the shared
  accessible dialog; `ConfirmRemoveDialog.tsx` (Team) is the existing
  confirm-before-remove shape (danger button, busy state, inline error).
- fake-twilio: `fake-twilio/src/engine/callEngine.ts` reads the `<Dial
  action>` response on a MISS, runs `interpretTwiml` (`engine/
  twimlInterpreter.ts`), and follows a `{ kind: 'record' }` plan into
  `leaveVoicemail`. `interpretTwiml` returns `record` whenever a `<Record>`
  element is present, regardless of what precedes it (a `<Play>` before
  `<Record>` still yields `record`). It records NOTHING about the greeting
  verb, and `CallState` (`engine/voiceTypes.ts`) has no field for it, so an
  e2e cannot tell `<Play>` from `<Say>` today. `GET /control/calls` returns
  `callEngine.getCalls()` verbatim (any new `CallState` field is exposed).
- e2e: `e2e/fixtures/fakeVoice.ts` `placeCall(api, { from, to, scenario: {
  digit: null } })` produces a missed business-line call; `listCalls(api)`
  reads the fake's calls. `listing-photos.spec.ts` drives a hidden file input
  with `setInputFiles({ name, mimeType, buffer })`. The hermetic lane runs
  MinIO (`MEDIA_BUCKET` + `MEDIA_S3_ENDPOINT` set by `scripts/e2e-session.mjs`).
- `app/src/lib/seed/media.ts` exports `minimalMp3()` (an ID3v2.3 header + one
  MPEG-1 Layer III frame, 427 bytes) that tests can reuse as a valid MP3.
- CloudFront: `/api/*` already has an all-methods behavior
  (`EDGE_MUTATING_PREFIXES` in app.ts includes `/api`), so a new route under
  `/api/settings/...` needs NO infrastructure change.

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

Assumptions made because the block did not say (flagged for the handback):

- A. Who may change the greeting: ADMIN only (upload, replace, remove), the
  same gate as `PUT /api/settings`. Every logged-in user may see and play it
  (the same read posture as `GET /api/settings`). A VA sees the greeting block
  read-only with no action buttons.
- B. "The uploader" is stored as the session user's `userId` and `email`
  (`SessionUser` carries no display name and the settings router has no users
  repo). The page shows "Uploaded <date> by <email>".
- C. The greeting's "name" is the uploaded file's name, sanitized (section
  4.2). It is staff-facing display only; it is never logged.
- D. Reseeding a stack (lean or full profile) drops the greeting RECORD (full-
  item Put) and leaves the object in MinIO/S3. That is the same fate as every
  other org-settings edit on reseed and is accepted; the webhook falls back to
  `<Say>` because the record is gone.

## 4. Design

### 4.1 Constants and shared helpers (`app/src/lib/voicemailGreeting.ts`, new)

```
export const VOICEMAIL_GREETING_S3_KEY = 'settings/voicemail-greeting';
export const VOICEMAIL_GREETING_MAX_BYTES = 5 * 1024 * 1024;
export const VOICEMAIL_GREETING_PLAY_TTL_SECONDS = 600;
export const VOICEMAIL_GREETING_MIME_TYPES: ReadonlySet<string> =
  new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav']);
export const VOICEMAIL_GREETING_REJECT_MESSAGE =
  'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.';
export type VoicemailGreetingFormat = 'mp3' | 'wav';
export const VOICEMAIL_GREETING_SNIFF_BYTES = 12;
```

- `normalizeGreetingContentType(raw: string | undefined): { contentType:
  'audio/mpeg' | 'audio/wav'; format: VoicemailGreetingFormat } | undefined`:
  lower-cases, strips parameters (`; charset=...`), maps `audio/x-wav` to
  `audio/wav` (the STORED type is always one of the two canonical values),
  undefined for anything else.
- `sniffGreetingHeader(head: Buffer, format): boolean` (pure):
  - `wav`: `head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WAVE'`.
  - `mp3`: `head.length >= 3 && (head.toString('latin1', 0, 3) === 'ID3' ||
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))` (ID3v2 tag or an MPEG
    frame sync).
  The declared type and the sniffed header must AGREE: an MP3 body declared as
  WAV is rejected, and vice versa (decision 1: "by content type and by
  sniffing").
- `class GreetingUploadGate extends Transform` (streams, no whole-file buffer):
  constructed with `{ format, maxBytes }`. It holds back at most
  `VOICEMAIL_GREETING_SNIFF_BYTES` bytes until it has that many (or the stream
  ends), runs `sniffGreetingHeader`, and either pushes the held bytes through
  and becomes a pass-through, or destroys itself with
  `GreetingRejectedError('invalid_format')`. It counts bytes and destroys
  itself with `GreetingRejectedError('too_large')` the moment the count exceeds
  `maxBytes`. On end with fewer bytes than the sniff needs it errors
  `invalid_format`; on end with zero bytes it errors `empty`.
- `class GreetingRejectedError extends Error { reason: 'invalid_format' |
  'too_large' | 'empty' }`.
- `sanitizeGreetingFileName(raw: string | undefined, format): string`: takes
  the last path segment (split on `/` and `\`), removes control characters
  (U+0000-U+001F, U+007F), trims, caps at 120 characters, and falls back to
  `greeting.mp3` / `greeting.wav` when empty.

### 4.2 Settings record (`app/src/repos/settingsRepo.ts`)

```
export interface VoicemailGreeting {
  s3Key: string;                       // always VOICEMAIL_GREETING_S3_KEY today
  contentType: 'audio/mpeg' | 'audio/wav';
  fileName: string;                    // sanitized display name (4.1)
  sizeBytes: number;                   // bytes stored
  uploadedAt: string;                  // ISO instant
  uploadedByUserId: string;
  uploadedByEmail: string;
}
```

- `OrgSettings.voicemailGreeting?: VoicemailGreeting` - OPTIONAL, no default,
  projected by `toOrgSettings` ONLY when the stored map has ALL of: string
  `s3Key` (non-empty), `contentType` in {`audio/mpeg`, `audio/wav`}, string
  `fileName`, finite non-negative number `sizeBytes`, string `uploadedAt`,
  string `uploadedByUserId`, string `uploadedByEmail`. Anything else projects
  as absent (the repo's malformed-field posture: a bad record can never make
  the webhook `<Play>` a nonsense URL; it falls back to `<Say>`).
- `OrgSettingsPatch.voicemailGreeting?: VoicemailGreeting | null`; `null` is a
  REMOVE (the existing `welcomeText` clearing mechanism in `putOrgSettings`
  already handles any `null`-valued key generically - no repo write-path
  change). Stored as ONE map attribute `voicemailGreeting` on the `org` item.
- `DEFAULT_ORG_SETTINGS` is unchanged (no greeting by default).
- `app/src/routes/settings.ts` `parsePatch` does NOT learn the field: a
  `voicemailGreeting` key in a `PUT /api/settings` body is IGNORED (a test pins
  this). The only writers are the two routes in 4.3 and 4.4.

### 4.3 Upload / replace: `PUT /api/settings/voicemail-greeting`

Mounted inside `createSettingsRouter` (so it lives under the existing
`/api/settings` prefix: `requireAuth` from the `/api` mount, `csrfOrigin`,
CloudFront's `/api/*` behavior - no infra). Gate: `requireRole('admin')`, then
a `createUserRateLimit({ routeKey: 'voicemail_greeting_upload', max: 10,
windowMs: 60_000 })` fence (one instance per router). New deps on
`SettingsRouterDeps`: `mediaStore?: MediaStore` (api.ts passes the one it
already built; undefined when `MEDIA_BUCKET` is unset).

Request: the RAW file bytes as the body (`fetch(url, { method: 'PUT', body:
file, headers: { 'Content-Type': file.type } })`), NOT multipart - there is no
multipart parser and none is added (no new dependency). The display name rides
the query string: `?name=<encodeURIComponent(file.name)>`. Express's JSON and
urlencoded parsers skip an `audio/*` body, so `req` is the unread stream.

Handler order (each step's failure answers before any storage write):

1. `!mediaStore` -> 503 `{ error: 'media_storage_unavailable' }`.
2. `normalizeGreetingContentType(req.headers['content-type'])` undefined ->
   400 `{ error: 'unsupported_media_type', message:
   VOICEMAIL_GREETING_REJECT_MESSAGE }`.
3. `Content-Length` header present and `> VOICEMAIL_GREETING_MAX_BYTES` -> 413
   `{ error: 'file_too_large', maxBytes }` (cheap refusal before reading;
   the gate below is the authority when the header is absent or lies).
   `Content-Length: 0` -> 400 `{ error: 'empty_file' }`.
4. Build `gate = new GreetingUploadGate({ format, maxBytes })`, `body =
   pipeline(req, gate)`-style wiring: `req.pipe(gate)` with error propagation
   (`req.on('error', e => gate.destroy(e))`). Call
   `await mediaStore.put(VOICEMAIL_GREETING_S3_KEY, gate, contentType)`.
   - `GreetingRejectedError('invalid_format')` -> 400 `unsupported_media_type`
     with the same message; `'too_large'` -> 413 `file_too_large`; `'empty'`
     -> 400 `empty_file`. Any other error -> 500 `{ error:
     'upload_failed' }` with an ERROR log (no bytes, no name).
   - Because the gate errors BEFORE pushing any byte when the header is bad,
     lib-storage never starts a part; on a too-large mid-stream error
     `S3MediaStore.put` aborts the multipart upload (existing behavior), so a
     previously stored greeting is NEVER replaced by a partial one (S3 commits
     a multipart object only on completion).
   - After a refused body the handler must not leave the request half-read:
     it calls `req.resume()` (drain) before answering, so the connection is
     reusable and the client reads the JSON error.
5. On success: `const record: VoicemailGreeting = { s3Key, contentType,
   fileName: sanitizeGreetingFileName(req.query.name, format), sizeBytes:
   gate.bytesSeen, uploadedAt: new Date().toISOString(), uploadedByUserId:
   req.user.userId, uploadedByEmail: req.user.email }`; `await
   settings.putOrgSettings({ voicemailGreeting: record })`; `await
   audit.append(ORG_SETTINGS_ENTITY_KEY, 'settings_updated', { fields:
   ['voicemailGreeting'], action: 'uploaded', actor: userId })`; INFO log
   `{ actor, s3Key, contentType, sizeBytes }` (never the file name); respond
   200 `{ voicemailGreeting: record }`.
   If the settings write fails AFTER the put: 500 `{ error:
   'greeting_record_failed' }` and an ERROR log; the object holds the new bytes
   and the record is stale or absent. The UI re-fetches on the next load; the
   webhook still HEAD-checks the fixed key and plays whatever is stored under
   the recorded key, which is the same key - so the worst case is a stale
   display name/date, never a broken call.

Replacing is the same request: the fixed key means `put` overwrites the object
and the record is SET over the old one. Two admins uploading at once: last
writer wins on both; a call in flight plays whichever object S3 serves at fetch
time. Accepted (single-org, rare).

### 4.4 Remove: `DELETE /api/settings/voicemail-greeting`

`requireRole('admin')`. Order (the RECORD is the authority):

1. `await settings.putOrgSettings({ voicemailGreeting: null })` (REMOVE).
2. `if (mediaStore) await mediaStore.deleteObject(VOICEMAIL_GREETING_S3_KEY)
   .catch(err => log.warn(...))` - best effort; a leftover object under the
   fixed key is harmless (unreferenced, overwritten by the next upload) and the
   webhook reads the record, not the bucket, to decide whether to `<Play>`.
3. Audit `settings_updated` `{ fields: ['voicemailGreeting'], action:
   'removed', actor }`; INFO log; 204.

Removing when nothing is set is a 204 no-op (REMOVE of an absent attribute is
a no-op; DeleteObject is idempotent).

### 4.5 Read and play back

- `GET /api/settings` (unchanged route) now carries `settings.voicemailGreeting`
  when set (it is part of `OrgSettings`). No new read endpoint for metadata.
- `GET /api/settings/voicemail-greeting/audio` (requireAuth from the mount; any
  logged-in user): streams the object like the recording route. Implemented by
  extracting the recording route's stream/range/416 logic into a shared helper
  `serveMediaObject(req, res, { mediaStore, key, defaultContentType,
  cacheControl, notFound: { status: 404, error: 'greeting_not_found' }, log,
  logContext })` in `app/src/routes/serveMediaObject.ts`, and re-pointing
  `GET /api/calls/:callId/recording` at the same helper with its current
  values (`recording_not_found`, `audio/mpeg`, `private, max-age=3600`,
  `{ callSid }`). The existing recording tests (`app/test/voiceRecording.test.ts`
  ranges/416/404) are the regression guard for the extraction; their
  assertions do not change.
  - 404 `greeting_not_found` when `settings.getOrgSettings().voicemailGreeting`
    is absent, the store is unconfigured, or the object is gone.
  - `Cache-Control: private, max-age=3600` (same posture as recordings) and
    the dashboard appends `?v=<uploadedAt>` so a Replace is never served from
    the browser cache (the URL changes with every upload).
  - `Content-Type` from the object (falls back to the record's contentType).

### 4.6 Voice webhook playback (`app/src/routes/webhooks/voice.ts`)

In the `/status` handler's missed-inbound-founder-bridge branch, replace the
single `reply.say(voice.voicemail_prompt)` line with a call to a local helper
`await addVoicemailGreeting(reply, entryCallSid)`:

```
let played = false;
try {
  const org = await settings.getOrgSettings();
  const greeting = org.voicemailGreeting;
  if (greeting !== undefined) {
    if (!mediaStore) {
      log.warn({ callSid, s3Key: greeting.s3Key },
        'voicemail greeting set but no media store configured - using the spoken prompt');
    } else {
      const head = await mediaStore.head(greeting.s3Key);
      if (head === undefined) {
        log.warn({ callSid, s3Key: greeting.s3Key },
          'voicemail greeting object missing - using the spoken prompt');
      } else {
        const url = await mediaStore.presign(greeting.s3Key, VOICEMAIL_GREETING_PLAY_TTL_SECONDS);
        reply.play(url);
        played = true;
        log.info({ callSid, s3Key: greeting.s3Key }, 'voicemail greeting played');
      }
    }
  }
} catch (err) {
  log.warn({ err, callSid }, 'voicemail greeting lookup failed - using the spoken prompt');
}
if (!played) reply.say(resolveMessage('voice.voicemail_prompt'));
```

- The `<Record>`, `voicemail_thanks` and `<Hangup>` that follow are untouched;
  `VOICEMAIL_MAX_LENGTH_SECONDS` / `VOICEMAIL_SILENCE_TIMEOUT_SECONDS` are
  untouched (decision 5).
- The masked/outbound `else if (isMissed)` branch and `/voicemail-done` are
  untouched: the greeting is business-line voicemail only, like the prompt it
  replaces.
- PII: the log lines carry `callSid` and the fixed `s3Key` only; the presigned
  URL is a bearer token and is NEVER logged (the mediaStore doc rule).
- One extra `GetItem` + one `HeadObject` + a local presign on the miss path
  only. The TwiML is emitted after they resolve; Twilio's `<Dial action>` wait
  budget is seconds, and both calls are sub-100ms in practice. A slow or
  failing store degrades to `<Say>` through the catch, never to a webhook 5xx.
- `<Play>` gets the presigned URL as its text; VoiceResponse XML-escapes the
  `&` in the query string. Twilio fetches the audio when it plays it, within
  the 10-minute TTL (the call is live at that moment).

### 4.7 Dashboard (`dashboard/src/routes/settings/VoiceSection.tsx` and friends)

- API (`dashboard/src/api/types.ts`, additive): `VoicemailGreeting` mirror of
  4.2; `OrgSettings.voicemailGreeting?: VoicemailGreeting`.
  `endpoints.ts` (additive): `uploadVoicemailGreeting(file: File):
  Promise<VoicemailGreeting>` (a direct `fetch` PUT with `credentials:
  'same-origin'`, the file as the body, `Content-Type: file.type`, `?name=`;
  non-2xx -> `ApiError` from the JSON body so `code` is
  `unsupported_media_type` / `file_too_large` / `empty_file` /
  `media_storage_unavailable` / `forbidden`), `removeVoicemailGreeting():
  Promise<void>` (DELETE via `request`), `voicemailGreetingAudioUrl(g):
  string` = `/api/settings/voicemail-greeting/audio?v=<encoded uploadedAt>`.
  `client.ts` is NOT edited (the direct fetch mirrors the presigned-POST
  precedent at endpoints.ts ~1175 and keeps the hub file untouched).
- A new hook `useVoicemailGreeting()` (in `dashboard/src/routes/settings/`):
  loads `getSettings()` once for the greeting (the Voice tab does not use
  `useSettings` today; reusing it would also drag the templates state along -
  the hook reads the same endpoint and keeps only `voicemailGreeting`),
  exposes `{ status, greeting, upload(file), remove(), error, busy, retry }`.
  Client-side pre-checks in `upload` BEFORE the request, with the SAME message
  as the server: `file.type` not in the allowlist (an empty `file.type` with a
  `.mp3`/`.wav` extension is allowed through to the server, which decides by
  header) -> the reject message inline; `file.size > 5 MB` -> "That file is
  over 5 MB. Trim or re-export it at a lower bitrate." `size === 0` -> "That
  file is empty." Server errors map: `unsupported_media_type` -> the reject
  message; `file_too_large` -> the 5 MB line; `media_storage_unavailable` ->
  "Media storage isn't available right now. Try again in a minute."; `forbidden`
  -> "Only an admin can change the greeting."; anything else -> "Couldn't upload
  the greeting. Try again."
- New component `VoicemailGreetingBlock` rendered INSIDE the existing Voice
  section below the cell-verification flow (same `<section
  aria-labelledby="voice-heading">`), as its own sub-block with an `<h3>`
  "Voicemail greeting":
  - Helper text: "When a call to the business line isn't answered, callers hear
    this greeting before the beep. Upload an MP3 or WAV file up to 5 MB. iPhone
    voice memos are M4A; export or convert the recording first. Without a
    greeting, callers hear the built-in spoken prompt."
  - No greeting: status line "No greeting uploaded - callers hear the built-in
    prompt." and, for admins, a button "Upload greeting".
  - Greeting set: the file name (as text), "Uploaded <Mon D, YYYY> by <email>"
    (`toLocaleDateString` like `fmtVerifiedAt`), an `<audio controls
    preload="none" aria-label="Voicemail greeting" src={audioUrl}>` (a plain
    `<audio>`; the greeting is mono/whatever was uploaded, no downmix needed),
    and for admins the buttons "Replace greeting" and "Remove greeting".
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
  - Errors render in a `<p role="alert">` under the controls.
  - VA (non-admin): everything above minus the buttons; the helper text gains
    "An admin can upload or change it."
  - Phone width: the block stacks (name/date over the player over the buttons)
    inside the section's existing max-width; the audio element is
    `width: 100%`; buttons wrap. No horizontal scroll at 375px.
- Styles go in `VoiceSection.module.css` (existing file), new class names only.

### 4.8 fake-twilio (in-repo test double; e2e observability)

- `engine/twimlInterpreter.ts`: the `record` plan gains `greeting: 'play' |
  'say' | 'none'` and `playUrl?: string`: `'play'` when the `<Response>` has a
  `Play` element (its text is `playUrl`), else `'say'` when it has a `Say`
  element, else `'none'`. Parsing stays generic (no app-specific assertions).
- `engine/voiceTypes.ts` `CallState` gains `voicemailGreeting?: 'play' | 'say'
  | 'none'` and `voicemailGreetingFetchStatus?: number` (the HTTP status the
  fake got when it GET the `playUrl`, best effort: on a network error it
  records 0).
- `engine/callEngine.ts` `leaveVoicemail`: sets `call.voicemailGreeting =
  plan.greeting`; when `plan.playUrl` is set, performs one `fetch(playUrl)`
  (consuming and discarding the body), records the status, and continues
  regardless of the outcome. This makes the e2e's "the presigned URL actually
  serves the file" a boundary proof (the URL points at the lane's MinIO, which
  the fake process can reach), not a string match.
- `GET /control/calls` needs no change (returns `CallState` verbatim).

### 4.9 Surfaces enumerated (the invariant "a set greeting is what callers hear")

Writers of `org.voicemailGreeting`:

| surface | behavior |
|---|---|
| `PUT /api/settings/voicemail-greeting` (4.3) | SET after a successful put |
| `DELETE /api/settings/voicemail-greeting` (4.4) | REMOVE, then best-effort delete |
| `PUT /api/settings` (`parsePatch`) | IGNORES the key (pinned by test) |
| seeds `lean.ts` / `matrix.ts` (full-item Put) | drop it on reseed (assumption D) |
| `POST /__dev/reseed` | via the seeds, same |
| `settingsRepo.putOrgSettings` generic null-REMOVE | the mechanism 4.4 uses |
| test fake `twilioWebhookHarness.ts` settingsRepo | MUST mirror the field (SET on patch, delete on null) so webhook tests can set it |

Readers / renderers:

| surface | behavior |
|---|---|
| `settingsRepo.toOrgSettings` | projects only a well-formed map (4.2) |
| `GET /api/settings` + `PUT /api/settings` responses | carry it inside `settings` |
| `/webhooks/twilio/voice/status` miss branch (4.6) | `<Play>` or `<Say>` fallback |
| `GET /api/settings/voicemail-greeting/audio` (4.5) | streams it or 404 |
| dashboard `VoicemailGreetingBlock` (4.7) | renders it |
| dashboard `TemplatesSection` / `useSettings` | untouched; they read known fields only (verified: no spread of `settings` into a form) |
| `settingsToOverrides()` (message catalog overrides) | reads named fields only; unaffected (builder verifies by reading it) |
| `fake-twilio` (4.8) | observes the verb for e2e |

### 4.10 Logging, PII, limits

- Never log: the file name, the presigned URL, any byte of audio. Log:
  `s3Key` (fixed), `contentType`, `sizeBytes`, `actor` userId, `callSid`.
- Limits: 5 MB (`VOICEMAIL_GREETING_MAX_BYTES`), 10 uploads/min/user, 10-minute
  play TTL, 120-char display name.
- No message-catalog entry is added (all new copy is staff-facing settings
  copy); `voice.voicemail_prompt` stays as the fallback.
- No new dependency; no infrastructure change (route under `/api`; bucket and
  IAM permissions for GetObject/PutObject/HeadObject/DeleteObject on
  `MEDIA_BUCKET` already exist for recordings/MMS/unit photos - the builder
  verifies the IAM policy in `infra/` grants `s3:DeleteObject` and
  `s3:PutObject` on the bucket, which unit-photo removal and MMS confirm
  already rely on).

## 5. Testing

Unit (vitest, `app/test/`):

- `voicemailGreeting.test.ts`: `normalizeGreetingContentType` (the three
  accepted values, parameters stripped, `audio/x-wav` canonicalized, `audio/
  mp4` / `audio/m4a` / `video/mp4` / empty rejected); `sniffGreetingHeader`
  (ID3, frame-sync 0xFFFB / 0xFFE3, RIFF/WAVE; an M4A `ftyp` box and a PNG
  header rejected under both formats; a WAV header declared MP3 rejected and
  vice versa); `GreetingUploadGate` (passes a valid stream byte-exact; rejects a
  bad header with `invalid_format` having pushed 0 bytes downstream; rejects at
  `maxBytes + 1` with `too_large`; `empty` on a zero-byte stream; a 2-byte
  stream -> `invalid_format`); `sanitizeGreetingFileName` (path stripping,
  control chars, cap, fallback).
- `settingsRepo` (extend `settings.test.ts` or a new
  `settingsVoicemailGreeting.test.ts` against the DynamoDB Local repo like the
  existing repo tests): SET projects; `null` REMOVEs; a malformed stored map
  (missing `contentType`, wrong type) projects as absent.
- Routes (`voicemailGreetingRoutes.test.ts`, supertest against
  `makeWebhookHarness`, whose fake `mediaStore` already records puts/heads/
  presigns/deletes): 401 no session; 403 VA on PUT/DELETE; 503 when no
  mediaStore; 400 `unsupported_media_type` for `audio/mp4` with the exact
  message; 400 for `audio/mpeg` declared over WAV bytes (sniff); 413 via
  `Content-Length` and via a body that exceeds the cap without a length
  header (chunked); 400 `empty_file`; happy path MP3 (`minimalMp3()`) and WAV
  (a 44-byte PCM header + silence built inline) -> 200 with the record, the
  harness `mediaPuts` shows ONE put under the fixed key with the canonical
  content type, `GET /api/settings` carries the record, audit event appended
  with `action: 'uploaded'`; replace overwrites (second put, record updated,
  `uploadedAt` advances); DELETE -> 204, record gone, `deletedMediaKeys`
  contains the key, audit `removed`; DELETE when the object delete rejects
  (`world.failMediaDeletes`) still clears the record and answers 204 with a
  WARN; `PUT /api/settings { voicemailGreeting: {...} }` leaves the record
  untouched; `GET .../audio` 200 with `Accept-Ranges`, 206 on a range, 404
  when unset, 404 when the object is gone; the recording route's existing
  range tests still pass after the helper extraction.
- Webhook (`founderTriage.test.ts` additions, using the harness's in-memory
  settings + fake mediaStore): (a) greeting set AND object present -> the
  `/status` miss TwiML contains `<Play>` with the harness's presigned URL shape
  (`X-Amz-Signature`) BEFORE `<Record`, and does NOT contain the
  `voice.voicemail_prompt` text; `<Record maxLength=...>` and the thanks are
  unchanged; (b) no greeting -> `<Say>` prompt exactly as today (the existing
  assertions keep passing untouched); (c) greeting set but the object missing
  from the fake store -> `<Say>` prompt AND a WARN line captured by
  `createLogCapture` matching /voicemail greeting object missing/ with no URL
  in it; (d) greeting set and `mediaStore.head` throwing -> `<Say>` + WARN, 200
  status; (e) masked relay miss with a greeting set -> still the goodbye, no
  `<Play>`.
- fake-twilio (`fake-twilio` vitest): `interpretTwiml` on `<Play>..<Record>`
  yields `greeting: 'play'` + `playUrl`; on `<Say>..<Record>` yields `'say'`.
- Dashboard (`VoicemailGreetingBlock.test.tsx`, RTL with mocked endpoints):
  renders "No greeting uploaded" + "Upload greeting" for an admin; VA sees no
  buttons; choosing an `audio/mp4` file shows the reject message WITHOUT
  calling the endpoint; choosing a 6 MB file shows the size message without a
  call; a valid file calls `uploadVoicemailGreeting` and renders the name,
  date, player (`aria-label="Voicemail greeting"`, `src` containing `?v=`) and
  the Replace/Remove buttons; Remove opens the dialog, Cancel closes it without
  a call, Remove calls the endpoint and returns to the empty state with the
  status message; a `forbidden` error renders the admin-only message.

Playwright (`e2e/tests/dashboard-next/voicemail-greeting.spec.ts`, hermetic
lane only; accessibility-first selectors):

1. Reseed; dev-login as `founder@example.com` (admin); go to
   `/settings/voice`; expect heading "Voicemail greeting" and the "No greeting
   uploaded" status; `setInputFiles` on the file input (`getByLabel('Greeting
   audio file')`) with a generated 44-byte-header WAV (`{ name:
   'sam-greeting.wav', mimeType: 'audio/wav', buffer }`); expect the status
   "Greeting uploaded.", the text `sam-greeting.wav`, and the audio element
   (`getByLabel('Voicemail greeting')`) whose `src` contains
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
4. Place a second missed call; expect `voicemailGreeting === 'say'`.
5. Phone width: `test.use({ viewport: { width: 375, height: 812 } })` in a
   second test that uploads and asserts `document.documentElement.scrollWidth
   <= 375` and that the Replace/Remove buttons and the player are visible.
6. Reject path in the real UI: `setInputFiles` an `audio/mp4` buffer -> the
   reject message appears as an alert and no greeting is listed.
7. VA path: dev-login as `va@example.com`, visit `/settings/voice`, expect the
   greeting block without "Upload greeting"/"Remove greeting" buttons.

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
  is on record.
- Twilio-side media caching semantics: the presigned URL changes per call, so
  a replaced greeting is heard on the next call; no cache invalidation exists
  or is needed.

## 7. Handback and dev verification

After deploy to dev (Cameron's step, not this branch's): upload a greeting in
Settings > Voice on the dev dashboard, call the dev business number, do not
answer on the holder's cell, and confirm the caller hears the uploaded audio,
then the beep. Remove it and repeat: the computer voice returns. The dev app
log shows `voicemail greeting played` on the first call and nothing
greeting-related on the second.
