# Planner review - spec conformance (feat/voicemail-greeting)

Reviewer: planner-dispatched spec-conformance reviewer (read-only), 2026-09-27.
Worktree `W:/tmp/voicemail-greeting`, branch `feat/voicemail-greeting`, head
e271acd2 (handback record only; de4df265 is the gated tree; last code commit
f91b50e0). Merge base = main = 0dafe3c1 (verified: `git merge-base main HEAD`).
Contract: `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md`
(DRAFT 3 + the builder's 4.3 erratum). Verdicts come from the code; the
builder's records were read only to check the handback's claims.

Legend: CONFORMS / PARTIAL / MISSING / DEVIATED. Severity on non-CONFORMS
items: MUST (blocks merge), SHOULD (fix or accept explicitly), NOTE (record).
Nothing was re-run; gate outputs are UNVERIFIED by this reviewer (the planner
re-runs them).

## Overall verdict

CONFORMS WITH DEVIATIONS. No MUST, no SHOULD. Every decision, assumption,
mechanism and surface row is implemented; every deviation is behavior-safe,
and all but two cosmetic ones are declared (handback forks or the fix-wave
report). Two test pins are thinner than the spec's wording (PARTIAL), and one
filed issue carries stale line refs.

## 1. Section 3 decisions

| # | item | verdict | evidence |
|---|---|---|---|
| D1 | MP3/WAV only, type AND sniff, 5 MB, exact reject message, helper text | CONFORMS (tiny-body reading DEVIATED, see F1) | `app/src/lib/voicemailGreeting.ts:12,20-26,43-66`; route `app/src/routes/settings.ts:336-349,385-391`; helper text `dashboard/src/routes/settings/VoicemailGreetingBlock.tsx:65-70` |
| D2 | stream to fixed key, no route buffer; record key/type/uploadedAt/uploader; replace overwrites; remove clears both | CONFORMS | `settings.ts:351-369` (pipe into `mediaStore.put`, no buffer), `settings.ts:404-414` (record), `settings.ts:437-452` (remove) |
| D3 | HEAD then `<Play>` presigned 10 min then existing `<Record>`; fallback `<Say>` + WARN no PII; webhook never fails | CONFORMS | `app/src/routes/webhooks/voice.ts:396-448,1960-1961`; TTL `voicemailGreeting.ts:14` |
| D4 | upload control, name + date, authed in-page player, Replace + Remove with confirmation | CONFORMS | `VoicemailGreetingBlock.tsx:85-197`; audio route `settings.ts:461-482` |
| D5 | who/when/length of voicemail unchanged | CONFORMS | `voice.ts:1957-1984`: only the prompt line changed; `<Record>` options, thanks, hangup, masked `else if` branch byte-identical in the diff |

## 2. Assumptions A-H

| # | verdict | evidence |
|---|---|---|
| A admin-only writes, all users read/play, VA read-only | CONFORMS | `settings.ts:330,437` (`requireRole('admin')`), `settings.ts:461` (no role gate); `VoicemailGreetingBlock.tsx:25-26,90,119,157`; tests `app/test/voicemailGreetingRoutes.test.ts:83-87,527-530,550-563` |
| B uploader = userId + email; "Uploaded <date> by <email>" | CONFORMS | `settings.ts:410-411`; `VoicemailGreetingBlock.tsx:100-102` |
| C sanitized name, header not URL, never logged | CONFORMS | `settings.ts:206-214,407`; `voicemailGreeting.ts:153-164`; INFO line omits it `settings.ts:429`; test `voicemailGreetingRoutes.test.ts:441-448` |
| D reseed drops the record | CONFORMS | seeds untouched (not in `git diff --stat main...HEAD`) |
| E confirmation on Remove only | CONFORMS | Replace = file picker `VoicemailGreetingBlock.tsx:121`; Remove -> Modal `:124-134,169-197` |
| F log matrix (none when unset; WARN when set but not offered; INFO on offer) | CONFORMS | `voice.ts:427-446` |
| G no route buffer; pipe into existing `put` | CONFORMS (spec text understated; see N-G) | `settings.ts:368-369`; comments `settings.ts:307-313`, `voicemailGreeting.ts:86-92` |
| H versioned bucket keeps prior versions | CONFORMS (named in handback "For Cameron" 1) | handback.md:217-219 |

## 3. Mechanisms 4.1-4.10

### 4.1 library

- Constants: CONFORMS, `voicemailGreeting.ts:9-35` (all nine values as specified).
- `normalizeGreetingContentType`: CONFORMS, `:43-49`.
- `sniffGreetingHeader`: CONFORMS, `:57-66` (RIFF/WAVE; ID3 or frame sync with non-zero layer bits).
- `GreetingUploadGate`: CONFORMS for sniff-before-push (`:114-127`), cap checked BEFORE forwarding (`:105-109`), `empty` (`:135-137`). DEVIATED (declared, fork 1) for end-of-stream with 1-11 bytes: refused `invalid_format` WITHOUT running the sniff (`:139-146`), where spec 4.1's literal text ("until it has that many (or the stream ends), runs sniffGreetingHeader") would let a 3-byte `ID3` pass the MP3 sniff. Stricter and safer; truthfully described.
- `GreetingRejectedError`: CONFORMS, `:70-75`.
- `sanitizeGreetingFileName`: CONFORMS, `:153-164` (C0 + DEL stripped, trimmed, 120 code points via `Array.from`, per-format fallback).
- `withTimeout`: CONFORMS, `:181-190` (race, clears timer in `finally`, `promise.catch(() => {})`, no flag).

### 4.2 settings record

- `VoicemailGreeting` + `toVoicemailGreeting`: CONFORMS, `app/src/repos/settingsRepo.ts:119-152`; fixed key REQUIRED (`:134`, imports the constant `:23-26`); contentType pair, string fields, finite non-negative `sizeBytes` (`:136`).
- Optional on `OrgSettings`, projected only when well-formed: CONFORMS, `:199,302,349-352`.
- `OrgSettingsPatch` Omit + `| null`: CONFORMS, `:234-237`; generic null-REMOVE unchanged `:376-395`.
- `DEFAULT_ORG_SETTINGS` unchanged: CONFORMS (not in diff).
- `parsePatch` ignores the key; local `SettingsPatch` Omits it: CONFORMS, `settings.ts:81-186`.

### 4.3 upload

- Mount, gate order, limiter (one instance, `voicemail_greeting_upload`, 10/60 s), `mediaStore` dep from api.ts: CONFORMS, `settings.ts:62-63,224-229,330`; `app/src/routes/api.ts:730`.
- Raw body, name in `X-Greeting-File-Name`, decode in try/catch: CONFORMS, `settings.ts:206-214,407`.
- Step 1 503: CONFORMS `:332-335`. Step 2 400 + message: CONFORMS `:336-340`. Step 3 413 / `Content-Length: 0` 400: CONFORMS `:341-349`.
- Step 4 refusal wiring (focus item): CONFORMS.
  - no-op `'error'` listener at once: `:354`.
  - `req.pipe(gate)`; NO `stream.pipeline` (grep of `settings.ts`: the word occurs only in comments `:315-316`).
  - req `'error'` / `'aborted'` / `'close'` before `req.complete` -> `gate.destroy(new GreetingClientAbortedError())`: `:355-360`.
  - `put` called in the same tick, then awaited: `:369-373`.
  - classification by the error alone: `:376-401`.
  - refusal: `req.unpipe(gate)` then `req.resume()` BEFORE the JSON: `:377,384-391`.
  - NO `Connection: close` (no `Connection` token anywhere in the file), NO `req.destroy` anywhere in the file.
  - client abort: WARN `{ actor, reason: 'client_aborted' }`, nothing stored: `:394-397`. It also calls `res.destroy()` when no header was sent (`:396`) - the client is already gone, so this matches "no response"; it is not a destroy after a refusal response.
  - other error: 500 `upload_failed` + ERROR `{ err, actor, s3Key }`: `:399-400`.
  - Addition (declared, work map S4): `if (req.destroyed) abortGate();` (`:367`) for a client gone before the handler ran; pinned `voicemailGreetingRoutes.test.ts:338-396`.
- Step 5 record, SET, best-effort audit (`.catch` -> ERROR), INFO without the name, 200: CONFORMS, `:404-430`; `greeting_record_failed` 500: `:413-422`.
- Erratum paragraph (spec lines 484-489): present, original text kept (fork 4, see F4).

### 4.4 remove

CONFORMS, `settings.ts:437-452`: REMOVE first, best-effort `deleteObject` with WARN, best-effort audit `removed`, INFO, 204; idempotent (test `voicemailGreetingRoutes.test.ts:504-515`).

### 4.5 read and play back

- `GET /api/settings` carries the field: CONFORMS (`settings.ts:238-241` returns the projection; PUT returns `toOrgSettings(ALL_NEW)` `settingsRepo.ts:410`).
- Audio route (focus item): CONFORMS on posture - any logged-in user (`settings.ts:461`), 404 `greeting_not_found` when unset / no store (`:462-467`) or object gone (`app/src/routes/serveMediaObject.ts:67-73`), single byte range, 206, 416 with `Content-Range: bytes */size` (`serveMediaObject.ts:34-66,83-88`), `Accept-Ranges: bytes` on every success (`:78`), `Cache-Control: private, max-age=3600` (`settings.ts:472`), Content-Type from the object falling back to the record (`serveMediaObject.ts:74`, `settings.ts:471`). Dashboard `?v=` cache-buster: `dashboard/src/api/endpoints.ts:2063-2066`.
- Extraction into `serveMediaObject` and recording route re-point: CONFORMS in behavior (`api.ts:2294-2318`, same values and same log texts); `app/test/voiceRecording.test.ts` is NOT in the branch diff, so its assertions are unchanged. DEVIATED (cosmetic, undeclared) on the helper's option shape: `notFoundError: string` plus a new `messages` object (`serveMediaObject.ts:18-24`) instead of spec 4.5's `notFound: { error }`. DEVIATED (declared, fork 3) by the added client-leave body release (`serveMediaObject.ts:106-110`), which also changes the recording route.

### 4.6 webhook (focus item)

- Result-returning lookup, touches nothing: CONFORMS, `voice.ts:390-409` (the `GreetingLookup` union and `lookupVoicemailGreeting` emit no TwiML and log nothing).
- `withTimeout` bound over the WHOLE lookup: CONFORMS, `voice.ts:422-426`.
- Abort signal to `head`: CONFORMS, `AbortSignal.timeout(greetingLookupBudgetMs)` `voice.ts:423` -> `mediaStore.head(s3Key, { signal })` `:405`; S3 store forwards `abortSignal` `app/src/adapters/mediaStore.ts:250-256`.
- Budget dep `voicemailGreetingLookupBudgetMs ?? 2500`: CONFORMS, `voice.ts:347-351,382`.
- Logging matrix: CONFORMS - absent returns with no log (`:435-436`); WARN for no_store (`:437-439`), missing (`:440-442`), thrown/timeout (`:427-432`); INFO offered (`:443-446`); presigned URL never logged.
- Only caller emits `<Play>`; `<Play>` and `<Say>` never both: CONFORMS, `voice.ts:1960-1961`.
- Nothing after `<Record>` changed; masked/outbound branch and `/voicemail-done` untouched: CONFORMS (the only hunk in the handler replaces one line; `voice.ts:1962-1984` unchanged).
- DEVIATED (undeclared in the handback's fork list; recorded as FW4 in `fix-wave-r1-report.md:21-24`): the lookup HEADs and presigns the constant `VOICEMAIL_GREETING_S3_KEY` (`voice.ts:403`) rather than the spec pseudocode's `greeting.s3Key`; the audio route does the same (`settings.ts:470`). Equivalent under the 4.2 projection, which admits only that key; defense in depth.

### 4.7 dashboard

- Types mirror, `OrgSettings.voicemailGreeting?`, `SettingsPatch` Omits it: CONFORMS, `dashboard/src/api/types.ts:110-121,150,158-160`.
- `client.ts` additive `rawBody` / `headers`, mutual-exclusion throw, one fetch: CONFORMS, `dashboard/src/api/client.ts:44-48,103-122`; exactly one `fetch(` in the file (`:117`, literal `buildUrl(path, query)`). The body is `outgoing = payload ?? rawBody` (`:113`) hoisted into a const - the scan accepts it (catalog test claimed green; UNVERIFIED here).
- `endpoints.ts` literal paths: CONFORMS, `endpoints.ts:2050-2066`.
- `useVoicemailGreeting`: CONFORMS, `dashboard/src/routes/settings/useVoicemailGreeting.ts:84-167`; pre-checks and error map `:34-44,64-82,119-134`. Remarks (behavior-equivalent, not listed below): `audio/x-wav` is sent as `audio/wav` (`:37`; the server canonicalizes it anyway); a failed Remove uses "Couldn't remove the greeting. Try again." (`:25`), copy the spec does not define.
- Block placement (inside the section, below and outside the useMe ternary), `<h3>`, `useOptionalAuth()`: CONFORMS, `dashboard/src/routes/settings/VoiceSection.tsx:211-214`; `VoicemailGreetingBlock.tsx:25-26,64`.
- Accessible names the e2e depends on (focus item), all CONFORMS:
  - heading "Voicemail greeting" level 3: `VoicemailGreetingBlock.tsx:64`
  - `role="status"` "Couldn't load the voicemail greeting." + "Retry" (never alert): `:76-84`
  - `role="status"` "No greeting uploaded - callers hear the built-in prompt." + "Upload greeting": `:85-95`
  - `<audio controls preload="metadata" aria-label="Voicemail greeting">` (wrapper deliberately unnamed to avoid a duplicate label): `:59-63,106-113`
  - missing-file `role="status"` line: `:114-118`
  - "Replace greeting", "Remove greeting", "Uploading..." disabled: `:91-93,119-135`
  - hidden input `accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"` `aria-label="Greeting audio file"`: `:16,157-167` (rendered only for an admin once LOADED and disabled while busy - additive, declared F8)
  - Modal "Remove voicemail greeting?" (Modal sets `role="dialog"` + `aria-labelledby` its title, `dashboard/src/routes/contact/Modal.tsx:170-180`), exact body copy, Cancel / Remove / "Removing...", not dismissable while busy, failed Remove `role="alert"` INSIDE the dialog: `VoicemailGreetingBlock.tsx:169-196`
  - success `role="status"` "Greeting uploaded." / "Greeting replaced." / "Greeting removed.": `useVoicemailGreeting.ts:140,155`, rendered `VoicemailGreetingBlock.tsx:140-144`
  - user-action `<p role="alert">`: `:145-149`
  - VA helper suffix: `:69`
- Phone width (stack, audio `width: 100%`, buttons wrap): CONFORMS, `VoiceSection.module.css` `.greetingPlayer` (`width: 100%; max-width: 480px`), `.greetingActions` (`flex-wrap: wrap`), `.greetingName` / `.greetingDate` (`overflow-wrap: anywhere`); new class names only.
- Perf contract + mutation catalog: CONFORMS (see 4.9 static rows).

### 4.8 fake-twilio

CONFORMS. Verb immediately before `<Record>` via a second `preserveOrder: true` parse (`fake-twilio/src/engine/twimlInterpreter.ts:23-51,108`); `CallState.voicemailGreeting` / `voicemailGreetingFetchStatus` (`fake-twilio/src/engine/voiceTypes.ts:74-79`); `fetchStatus` dep with a 5 s real-fetch default returning 0 on throw, recorded and never fatal (`fake-twilio/src/engine/callEngine.ts:83-87,144-152,190,662-673`); `/control/calls` unchanged.

### 4.9 surface tables

Writers:

| surface | verdict | evidence |
|---|---|---|
| PUT greeting route: SET after a successful put | CONFORMS | `settings.ts:372-414` |
| DELETE route: REMOVE then best-effort delete | CONFORMS | `settings.ts:439-446` |
| `PUT /api/settings` ignores the key; local type Omits it | CONFORMS | `settings.ts:81`; test `voicemailGreetingRoutes.test.ts:27-40` |
| seeds lean/matrix drop it on reseed | CONFORMS | unchanged files |
| `POST /__dev/reseed` via seeds | CONFORMS | unchanged |
| `putOrgSettings` generic null-REMOVE; patch typed | CONFORMS | `settingsRepo.ts:234-237,376-395`; test `app/test/settings.test.ts` (REMOVE `#k0`) |
| harness settings fake mirrors the field | CONFORMS (plus the real projection, FW4) | `app/test/helpers/twilioWebhookHarness.ts` `readSettings` + `putOrgSettings` voicemailGreeting SET/delete |

Readers:

| surface | verdict | evidence |
|---|---|---|
| `toOrgSettings` fixed-key projection | CONFORMS | `settingsRepo.ts:302,349-352` |
| GET/PUT `/api/settings` responses carry it | CONFORMS | `settings.ts:240,296`; `settingsRepo.ts:410` |
| `/voice/status` miss branch | CONFORMS | `voice.ts:1957-1961` |
| audio route | CONFORMS | `settings.ts:461-482` |
| `VoicemailGreetingBlock` | CONFORMS | as above |
| Templates / QuietHours / Numbers / SystemStatus / QuickReply untouched | CONFORMS | none in the diff |
| `settingsToOverrides()` unaffected | CONFORMS | not in the diff |
| fake-twilio observes the verb | CONFORMS | 4.8 |

Static/test surfaces:

| surface | verdict | evidence |
|---|---|---|
| `VoiceSection.test.tsx` mocks `getSettings`, existing assertions unchanged, no new alert | CONFORMS | diff adds the mock (`:14-24,34-49`) and one test (`:186-197`); no existing assertion line changed |
| `voice-outbound.spec.ts` zero alerts | CONFORMS by construction (file unchanged; block never renders an alert at load) | gate-4 evidence UNVERIFIED here |
| mutation catalog 2 entries, 108 -> 110 | CONFORMS | `e2e/performance/mutationCatalog.ts:126-127`; `mutationCatalog.test.ts:375` |
| `VOICE_GETS` + routes.test + templates | CONFORMS | `e2e/performance/routes.ts:302-306`; `routes.test.ts:112`; `templates.ts:144-145` (two unique paths cover the three endpoints); ledger citations re-pointed `routes.ts:705,759` and match the current lines (spot-checked `VoicemailGreetingBlock.tsx:106-113`, `useVoicemailGreeting.ts:92-112`) |
| viewport guard | CONFORMS | `grep -c scrollWidth e2e/tests/dashboard-next/voicemail-greeting.spec.ts` = 0; helpers imported `:46-51` |
| `voiceRecording.test.ts` unchanged | CONFORMS | not in the diff |
| harness `mediaHeads` / `mediaPresigns` / `failMediaHeads` / `hangMediaHeads` (hang rejects on abort), `head(key, { signal })`, budget option | CONFORMS | harness diff; seams pinned in `app/test/mediaStore.head.test.ts:44-107` |
| `client.ts` one fetch | CONFORMS | `client.ts:117` (only `fetch(` in the file) |
| every `MediaStore` implementation accepts `head(key, opts?)` | CONFORMS | `mediaStore.ts:126,250`; harness `:3980`; the other fakes (`apiRoutes.test.ts:128,278,621`, cast fakes) declare fewer params, which TypeScript accepts |

### 4.10 logging, PII, limits

CONFORMS. No log line carries the file name, the presigned URL or bytes (`settings.ts:395,399,419,429,444,450`; `voice.ts:427-446`; tests `voicemailGreetingRoutes.test.ts:441-448`, `founderTriage.test.ts:1188`). ERROR only for server faults (put, record write, audit); client abort WARN; refused files are not logged at all (compatible with "WARN/INFO"). Limits: 5 MB, 10/min, 600 s, 2500 ms, 120 code points. No catalog entry, no dependency (`package.json` files not in the diff; `fast-xml-parser` already a fake-twilio dependency).

## 4. Section 5 tests

Unit (`app/test/voicemailGreeting.test.ts`): CONFORMS - normalize (`:31-43`), sniff incl. 0xFFFB/0xFFE3, ADTS 0xFFF1/0xFFF9, M4A, PNG, cross-declared (`:45-72`), gate byte-exact / 0 bytes on bad header / <= maxBytes on too_large / empty / 2-byte (`:74-113`), sanitizer (`:161-178`), withTimeout incl. timer cleared and no unhandled late rejection (`:180-218`).

`settings.test.ts`: CONFORMS - well-formed, foreign key, missing contentType, wrong-typed sizeBytes and more, null -> REMOVE (`app/test/settings.test.ts` new describe at the end of the file).

Routes (`app/test/voicemailGreetingRoutes.test.ts`):

| spec case | verdict | evidence |
|---|---|---|
| 401 / 403 VA PUT and DELETE | CONFORMS | `:83-87,527-530` |
| 503 withoutMediaStore | CONFORMS | `:89-94` |
| 400 exact message for `audio/mp4` | CONFORMS | `:96-100` |
| 400 for an ABSENT Content-Type with the exact message | PARTIAL | `:101-103` asserts status and `error` code only, not the message (superagent sends no Content-Type for a Buffer, so the case is genuinely absent) |
| 400 for 3 MiB WAV declared MP3, JSON arrives, not `client_aborted` | CONFORMS | `:253-260` |
| 413 Content-Length 6 MiB and CHUNKED 6 MiB, JSON arrives | CONFORMS | `:262-279`; drain proven through keep-alive reuse `:240-251` |
| 400 empty_file | CONFORMS | `:107-112` |
| refused upload -> zero puts | CONFORMS | `:104,258,268,278` |
| happy MP3 + WAV, one put, canonical type, GET carries it, audit uploaded | CONFORMS | `:400-428` (WAV via shared `minimalWav` helper rather than inline - immaterial) |
| name decode round-trip + bad encoding fallback | CONFORMS | `:430-439` |
| replace overwrites, uploadedAt advances | CONFORMS | `:450-458` |
| refused replace (3 MiB bad header, too large) byte-identical + record unchanged | CONFORMS | `:460-466` |
| DELETE 204, record gone, deletedMediaKeys, audit removed | CONFORMS | `:504-515` |
| DELETE with `failMediaDeletes` -> 204 + WARN | CONFORMS | `:517-525` |
| audit failure after upload -> 200 + ERROR | CONFORMS | `:469-476` |
| `PUT /api/settings { voicemailGreeting }` untouched | CONFORMS | `:27-40` |
| audio 200 Accept-Ranges + type, 206, 404 unset, 404 gone | CONFORMS | `:543-572` |
| recording range tests still pass | CONFORMS (file unchanged; pass state UNVERIFIED) | not in the diff |
| no log line contains the file name | CONFORMS | `:441-448` |

Webhook (`app/test/founderTriage.test.ts`):

| case | verdict | evidence |
|---|---|---|
| (a) `<Play>` presigned before `<Record`, no prompt, Record + thanks unchanged, one head + one presign of the fixed key, INFO offered | CONFORMS | `:1171-1188` |
| (b) no greeting -> prompt, no greeting log line at any level | CONFORMS | `:1190-1197` |
| (c) object missing -> prompt + one WARN, no URL | CONFORMS | `:1199-1210` |
| (d) head throws -> prompt + WARN, 200 | CONFORMS | `:1212-1221` |
| (e) hung head, 50 ms budget, elapsed < 1 s, exactly one WARN, no offered line, still none after release + tick | PARTIAL | `:1223-1238` - all asserted except that the WARN "mentions the timeout" (text not checked here; the wording is pinned in (e2) `:1263`) |
| (f) withoutMediaStore -> prompt + WARN | CONFORMS | `:1338-1345` |
| (g) masked miss -> goodbye, no `<Play>`, no head | CONFORMS | `:1347-1374` |
| (h) head receives an AbortSignal | CONFORMS | `:1183` (`signal: true`), `:1233`, plus (e4) aborted-at-budget `:1318-1336` |

Extras beyond the spec: (e2) redelivered summary with a hung settings read, (e3) late success, (i)/(i2) foreign key.

fake-twilio: CONFORMS - `fake-twilio/test/twimlInterpreter.test.ts` (Play+Record+Say, Say+Record+Say, Record+Say, Say+Play+Record), `fake-twilio/test/callEngineVoicemail.test.ts` (verb + injected status; throwing fetch -> 0, call completes).

Dashboard: CONFORMS - `VoicemailGreetingBlock.test.tsx:82-94` (admin empty), `:96-106` (VA), `:108-116` (load failure, no alert), `:153-159` (m4a no call), `:161-167` (empty type .mp3 -> audio/mpeg), `:169-178` (6 MB no call), `:180-194` (name, date, player label + `?v=`, buttons), `:196-203` (player error), `:250-264` (Remove dialog, Cancel no call, Remove -> empty + status), `:266-272` (forbidden alert); `VoiceSection.test.tsx` mock + untouched assertions; client rawBody pin in `dashboard/src/api/voicemailGreeting.client.test.ts:25-60` (no JSON, headers sent, `noteServerDate` called, error -> ApiError).

Playwright (`e2e/tests/dashboard-next/voicemail-greeting.spec.ts`):

| step | verdict | evidence |
|---|---|---|
| 1 reseed, founder, heading L3, empty status, WAV via `getByLabel('Greeting audio file')`, "Greeting uploaded.", name, player src `?v=`, GET 200 audio/wav + accept-ranges | CONFORMS | `:142-160` (player addressed with `exact: true`) |
| 2 missed call -> `play`, fetch 200 | DEVIATED (declared, fork 5) | `:164-168`: caller is a named contact from `createContact` (`:89-97`, phone still from `uniqueVoicePhone`), not a bare `uniqueVoicePhone()` |
| 3 Remove via dialog, "Greeting removed.", empty line, audio 404 | CONFORMS | `:171-178` |
| 4 second missed call -> `say` | CONFORMS (same fork-5 caller change) | `:180-184` |
| 5 phone width, helpers, dialog overflow, WIDE_RESTORE | CONFORMS | `:211-230` |
| 6 reject path in the real UI | CONFORMS (plus a server-side 400 check) | `:187-209` |
| 7 VA read-only, no alert at load | CONFORMS | `:232-242` |

## 5. The handback's six forks

| fork | real? | truthfully described? | verdict |
|---|---|---|---|
| 1 tiny uploads refused under 12 bytes | yes, `voicemailGreeting.ts:139-146`; tests `app/test/voicemailGreeting.test.ts:118-135` | yes | DEVIATED (declared) - NOTE |
| 2 concurrent writes unserialized | yes (no lock in `settings.ts:330-452`); spec 4.3 "Concurrency" accepts both end states | yes; issue filed | CONFORMS |
| 3 `serveMediaObject` releases the body on client leave; also changes the recording route | yes, `serveMediaObject.ts:94-110`; recording tests file unchanged | yes; issue filed for MMS/unit-media | DEVIATED (declared, additive) - NOTE |
| 4 pipeline-ban reason disproven; erratum added to the spec | yes, spec lines 484-489, original text kept at 436-440 | yes (note: the builder amended the approved spec) | NOTE |
| 5 e2e callers are known contacts | yes, spec file `:89-97,164,180` | yes | DEVIATED (declared) - NOTE |
| 6 sanitizer keeps C1 / bidi / zero-width | yes, `voicemailGreeting.ts:161` strips only U+0000-001F and U+007F, exactly spec 4.1's rule | yes | CONFORMS (deferred hardening) |

## 6. Gate claims (plausibility only; not re-run)

- Scripts exist as named: root `package.json` `typecheck` / `test` (workspaces app, dashboard, e2e, fake-twilio, fake-twilio/web - the five suites quoted) / `smoke` / `e2e`. The quoted smoke line matches `scripts/smoke-dist.mjs:179`.
- Gate 5 file count: `git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'` = 35 files, as claimed. The one reported error is pre-existing: `chooseAnsweringLeg(numbers, scenario)` is at `fake-twilio/src/engine/callEngine.ts:523` on the branch and line 506 on main (`git show main:...`), unchanged by the branch.
- Gated tree: `git diff --name-only f91b50e0 de4df265` lists only the spec and `self-qa.md`; e271acd2 adds only `handback.md`. The claim that the gates ran on the final code holds.
- `git merge main` -> "Already up to date" is consistent: merge base == main == 0dafe3c1.
- Gate 4: the first run was not green (EXIT=124 under a 1500 s cap, one `Page crashed` in `tours.spec.ts:178`, 11 not run); the green verdict rests on a second full run (EXIT=0, 289 passed) plus `tours.spec.ts` alone green. Disclosed truthfully (handback.md:133-147). AGENTS.md treats a named-spec failure as a regression; the builder's reading (Chromium renderer crash under a concurrent second lane) is plausible but the planner owns that call - NOTE.
- Diff counts (36 files, +3625/-109) match `git diff --stat main...HEAD` excluding docs.

## 7. Issues filed

All three exist with valid frontmatter per `docs/issues/README.md:41-56` (id == filename, type / severity / status inside the taxonomy, area, created):

- `docs/issues/voicemail-greeting-format-normalization.md` - improvement / low / open. Body carries the spec section 6 items (no transcoding, UNVERIFIED Twilio behavior on an unplayable `<Play>`, the dev check) plus the ID3-prefix sniff limit.
- `docs/issues/voicemail-greeting-concurrent-writes-unserialized.md` - improvement / low / deferred. Its refs `settings.ts:366`, `:411`, `:436` (frontmatter line 9, body lines 16-17) are STALE by 3 lines: they were right at 7fdaa59a, but f91b50e0 added comment lines to `settings.ts` and edited this issue without re-pointing them. The intended lines are now `settings.ts:369` (put), `:414` (record SET) and `:439` (record REMOVE).
- `docs/issues/media-serve-client-abort-leaves-body-open.md` - debt / low / open. Refs `api.ts:2400` and `unitMediaServe.ts:73` match the current `on('error')` + `pipe` blocks.

## 8. Non-CONFORMS items (all severities)

1. NOTE - Fork 1: the gate refuses a non-empty body under 12 bytes without a sniff (`voicemailGreeting.ts:139-146`); spec 4.1's literal wording would sniff at stream end. Stricter; declared.
2. NOTE - Fork 3: `serveMediaObject` adds a client-leave body release (`serveMediaObject.ts:106-110`), which also changes the call-recording route; the spec said "behavior unchanged". Additive; declared.
3. NOTE - Fork 4: the builder added an erratum to the approved spec (spec lines 484-489); original text kept; declared.
4. NOTE - Fork 5: e2e steps 2 and 4 place calls from named contacts rather than bare `uniqueVoicePhone()`; same proof; declared.
5. NOTE - Webhook and audio route use the constant key instead of the record's `s3Key` (`voice.ts:403`, `settings.ts:470`). Equivalent under the 4.2 projection. Recorded as FW4 but missing from the handback's fork list.
6. NOTE - `serveMediaObject` option shape differs from spec 4.5 (`notFoundError` + `messages` instead of `notFound: { error }`, `serveMediaObject.ts:18-24`). Cosmetic; undeclared.
7. NOTE (PARTIAL) - The routes test's absent-Content-Type case checks only the `error` code, not the exact message (`voicemailGreetingRoutes.test.ts:101-103`).
8. NOTE (PARTIAL) - Webhook test (e) does not check that its single WARN mentions the timeout (`founderTriage.test.ts:1223-1238`); (e2) pins the wording.
9. NOTE - The concurrent-writes issue's `settings.ts` line refs are stale by +3 (366/411/436 -> 369/414/439).
10. NOTE - Gate 4's first run failed (cap timeout plus a `Page crashed` in `tours.spec.ts`); green rests on the re-run and an isolated run. Disclosed; the planner must accept or reject the environmental reading.
11. NOTE - Assumption G's spec text ("at most one 5 MiB part in heap") understates the measured peak of about 2x the file. The code comments and the handback were corrected; the spec's assumption text was not.
