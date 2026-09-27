# Code review round 1 - SPEC CONFORMANCE - feat/voicemail-greeting

Reviewer: spec-conformance reviewer (Claude Opus 5.5, 1M context), 2026-09-27.
Target: `feat/voicemail-greeting` @4efb04a3, merge base main @0dafe3c1.
Contract: spec DRAFT 3 (approved; section 3 decisions + assumptions A-H),
plan DRAFT 3 (approved; Review Focus 1-5), worklist F1-F10 / D1-D3, slice
reports S1-S9, the S10 issue file.

**VERDICT: CONFORMS.** Every work-map item S1-S10 conforms. Every normative
requirement in spec 4.1-4.10 and every item on the section 5 test list is
implemented and tested. Assumptions A-H are implemented as stated. No
MUST-FIX. There are 2 SHOULD-FIX, both TEST-PIN gaps on Review Focus lines.
In both cases I proved the behavior itself correct with a probe (C1: RF1 has
no unit pin for the server-code mapping; C2: nothing exercises RF2's
late-success arm). There are also 6 NOTEs.

## Evidence run by this reviewer

The orchestrator's full e2e was running in the background, so I started no
e2e, Playwright, session or stack. Every command ran bare from the worktree.

- app: `npx vitest run test/voicemailGreeting.test.ts test/voicemailGreetingRoutes.test.ts test/mediaStore.head.test.ts test/settings.test.ts test/founderTriage.test.ts test/voiceRecording.test.ts`
  -> `Test Files 6 passed (6)`, `Tests 186 passed (186)`, EXIT=0, zero `[dynamoAdmin]` lines.
- dashboard: VoicemailGreetingBlock.test.tsx (16) + VoiceSection.test.tsx (10) + voicemailGreeting.client.test.ts (5) -> `Tests 31 passed (31)`, EXIT=0.
- fake-twilio: twimlInterpreter.test.ts (13) + callEngineVoicemail.test.ts (5) -> `Tests 18 passed (18)`, EXIT=0.
- e2e gate-2 static surfaces: mutationCatalog.test.ts (4) + routes.test.ts (24) + support/viewport.guard.test.ts (1) -> `Tests 29 passed (29)`, EXIT=0.
- `npm run typecheck` after every probe was deleted: EXIT=0 (all 5 workspaces).
- Four throwaway probes (A-D, `zz-review-probe-*`), all deleted. Results are in Table 4.
- Static checks:
  - None of the forbidden files, no package.json / lockfile, no message catalog and no `.tf` appears in `git diff --name-only 0dafe3c1..HEAD`.
  - `app/test/voiceRecording.test.ts` (the extraction guard) is untouched.
  - The e2e spec was NOT re-run here; S9 reports 6 runs (4 passed x cold 3, 31 passed with neighbours).

## Findings

**C1 - SHOULD-FIX - no unit pin for the client's server-code mapping (Review Focus 1)**

- Spec: 4.7 server error map; plan Review Focus 1.
- Where: `dashboard/src/routes/settings/useVoicemailGreeting.ts:64-82` (the mapping) and `dashboard/src/routes/settings/VoicemailGreetingBlock.test.tsx` (the missing case).
- What is wrong: Review Focus 1 says the message is "Pinned in ... Task 8 (the client maps `unsupported_media_type` to the message)". No dashboard unit test exercises that mapping.
  - The block test's M4A case (`VoicemailGreetingBlock.test.tsx:149-155`) is the CLIENT pre-check: `audio/mp4` never reaches the endpoint.
  - The only server-code case is `forbidden` (:217-223).
  - `grep -rn "unsupported_media_type|file_too_large|empty_file|media_storage_unavailable" dashboard/src` finds the greeting mapping only at `useVoicemailGreeting.ts:67-74`.
  - The client test (`voicemailGreeting.client.test.ts:39-46`) asserts `ApiError.code` only, never the UI message.
- Impact: deleting any of the four spec-4.7 mapping cases passes every dashboard unit test. Only the e2e (`voicemail-greeting.spec.ts:171-177`, gate 4) would catch `unsupported_media_type`, and nothing catches `file_too_large`, `empty_file` or `media_storage_unavailable`.
- Minimal correction: add a table test to the block suite:
  - Make `uploadVoicemailGreeting` reject with `ApiError(400,'unsupported_media_type')`, choose an `audio/mpeg` file, and expect the alert to equal `GREETING_REJECT_MESSAGE` with the endpoint called once.
  - Add the same shape for 413 `file_too_large`, 400 `empty_file` and 503 `media_storage_unavailable`.
- Evidence: probe D ran exactly that test against the real block and it was GREEN. The behavior is right; only the pin is missing.

**C2 - SHOULD-FIX - nothing exercises a lookup that succeeds after the budget (Review Focus 2)**

- Spec: 4.6 ("a lookup that resolves AFTER the budget has nothing to append and nothing to log") and section 5 webhook (e) ("after the hung head is released (the fake resolves it once the abort signal fires, or a test seam releases it) and a tick has passed, STILL no `offered` line").
- Where: `app/test/founderTriage.test.ts:1223-1238`, and the harness hang fake at `app/test/helpers/twilioWebhookHarness.ts:3967-3977`.
- What is wrong: the hang fake REJECTS with an AbortError when its signal fires. This follows the plan (Task 4, plan lines 1254-1260), so it is plan-sanctioned. Test (e2)'s settings read never settles. As a result, no test ever drives a lookup that SUCCEEDS after the budget, which is the exact case the result-returning design exists for. The "after a tick" arm of (e) exercises only a late rejection.
- Minimal correction: add an (e3) case:
  - Setup: greeting set, object present, budget 50.
  - Swap `world.mediaStore.head` for a head that ignores its signal and resolves after about 150 ms. The swap bites because the router holds the store object; (e2) relies on the same mechanism for `settingsRepo`.
  - Assert: `<Say>`, no `<Play>`, and ONE greeting WARN. After about 300 ms, still no `voicemail greeting offered` and no second WARN.
- Evidence (probe B):
  - Part 1, the REAL router through the harness: the response arrived at 72 ms and the late head settled at 176 ms. The abandoned lookup went on to presign once, yet the result was `<Say>`, no `<Play>`, exactly one WARN and no `offered` line. That is GREEN: the implementation is correct.
  - Part 2, a COPY of lookup/offer mutated to the DRAFT-2 shape (the lookup appends `<Play>` and logs `offered` itself): (e)'s assertions stay GREEN under the reject-on-abort fake, so the suite cannot see the regression. They go RED only under a late-resolving fake.
- Why not MUST-FIX: this is a test gap only. In production a late success needs a HEAD that ignores its signal, and the HEAD carries the same budget's `AbortSignal` (`voice.ts:418`).

**C3 - NOTE - stale line ranges in the Voice tab's perf source citations**

- Spec: 4.9 gate-2 row, "the Voice tab's source citations name `useVoicemailGreeting.ts`".
- Where: `e2e/performance/routes.ts:705` and `:759`.
- What is wrong: the requirement is met literally, but the line ranges are wrong.
  - `VoiceSection.tsx:93-127,176` is now one line off: the import at `VoiceSection.tsx:14` shifted the file. The ternary opens at :95 (was :94) and the cell-field label moved from :176 to :177.
  - `useVoicemailGreeting.ts:1-40` is the header and constants, not the GET. The GET is `load`, at :92-105.
  - The terminal-render citation (:759) arguably belongs at `VoicemailGreetingBlock.tsx:66-89`, the status lines.
- S8 flagged this (report item 4) and nobody picked it up. The static gates check format only, so this is citation hygiene.
- Minimal correction: re-point the three ranges.

**C4 - NOTE - the Replace button reads "Uploading..." during a Remove**

- Spec: 4.7, "While uploading the button reads 'Uploading...'".
- Where: `VoicemailGreetingBlock.tsx:86` and `:116`.
- What is wrong: both labels read the shared `state.busy`, which `remove()` also sets (`useVoicemailGreeting.ts:151`). While a DELETE is in flight, the Replace button behind the modal therefore reads "Uploading...".
- Impact: cosmetic. The button sits behind the aria-modal backdrop, and the render that closes the dialog clears it.
- Minimal correction: label by operation, for example with a separate `uploading` flag.

**C5 - NOTE - a 3-11 byte body can pass the MP3 sniff**

- Spec: 4.1, "On end with fewer bytes than the sniff needs it errors `invalid_format`".
- Where: `app/src/lib/voicemailGreeting.ts:122-139`.
- What happens: `_flush` sniffs whatever it holds, and the MP3 sniff needs only 3 bytes. A 3-11 byte body that starts with `ID3` or a valid frame sync is therefore accepted and stored. S1 probed this (worth-an-eye 1).
- Two readings of the spec line:
  - "Fewer than `sniffGreetingHeader` needs for the declared format" (the plan's code): the implementation conforms, and spec 5's 2-byte case passes.
  - "Fewer than `VOICEMAIL_GREETING_SNIFF_BYTES`" (12): such a body would be refused.
- Impact: a near-empty "MP3" uploaded by an admin falls into the section 6 unplayable-file case. The webhook does not break.
- Minimal correction, only if the 12-byte reading is wanted: in `_flush`, error `invalid_format` when `heldBytes < VOICEMAIL_GREETING_SNIFF_BYTES`.

**C6 - NOTE - a refused Replace hides the missing-file status**

- Spec: 4.7, the missing-file status ("the 4.3 interleave state made visible at load").
- Where: `VoicemailGreetingBlock.tsx:36`.
- What is wrong: `onFileChosen` clears `playerBroken` BEFORE the upload's pre-checks run. A refused Replace (client or server) leaves the greeting and its `<audio src>` unchanged, so `onError` does not refire. The "file is missing" line then stays hidden until the next page load.
- This is the plan's behavior (S8 item 7).
- Minimal correction: clear `playerBroken` only after a successful upload.

**C7 - NOTE - the spec's stated reason for the `stream.pipeline` ban is inaccurate**

- Spec: the 4.3 rationale says `stream.pipeline` "destroys `req` (and its socket) on a gate error, so the 400 could never be written".
- What was measured: on Node 24.14.1, S4 found that the 400 IS written. The real failure is a stuck, then reset, keep-alive connection.
- The rule itself is load-bearing (probe A):
  - I put `stream.pipeline(req, gate)` into a COPY of the refusal wiring, and separately a copy with the `req.resume()` drain removed.
  - Both turn the route suite's reuse pin RED: `{"error":"ECONNRESET"}` after about 6 s.
  - The faithful copy is GREEN.
- The route comment (`settings.ts:304-321`) already states the measured mechanism.
- Minimal correction: no code change; fix the spec sentence when the doc is frozen.

**C8 - NOTE - the 500 `upload_failed` path does not drain**

- Spec: 4.3 step 4, "Any other error -> 500 `upload_failed`".
- Where: `settings.ts:392-394`.
- What happens: after a store failure mid-body, the JSON arrives but the connection is not reusable (S4 item 10).
- This is exactly what the spec says. It is flagged so the fix wave does not rediscover it. No change is required.

## Table 1 - Work map S1-S10

| item | verdict | evidence |
|---|---|---|
| S1 Task 1: library, fixtures, unit tests | CONFORMS | `voicemailGreeting.ts:9-34` constants (4.1 values); :43-49 normalize; :57-66 sniff incl. the layer-bits check; :86-140 gate; :145-156 sanitizer; :173-182 withTimeout; `test/helpers/audioFixtures.ts`; `voicemailGreeting.test.ts` 21 green, ADTS 0xFFF1/0xFFF9 at :46-47 and :58-63 |
| S2 Task 2: settings record | CONFORMS | `settingsRepo.ts:118-151` (type + `toVoicemailGreeting`, fixed-key check at :137, constant returned at :141); :199 optional field; :234-237 patch type; :302 and :349-352 projection; `settings.ts:81` SettingsPatch Omit; harness mirror at `twilioWebhookHarness.ts:2327-2333`; `settings.test.ts:773-812`; parsePatch pin at `voicemailGreetingRoutes.test.ts:27-40` |
| S3 Task 3: `serveMediaObject` extraction | CONFORMS | `serveMediaObject.ts:1-95`; recording route calls it at `api.ts:2294` with `recording_not_found` / `audio/mpeg` / `private, max-age=3600` / `{ callSid }`; `voiceRecording.test.ts` untouched and 36/36 green; D1 honored |
| S4 Task 4: routes, HEAD signal, harness seams | CONFORMS | `settings.ts:224-229` limiter; :323-424 PUT; :430-445 DELETE; :450-472 audio; `mediaStore.ts:250-256` `head(key, opts?)` -> `abortSignal`; harness seams at :3966-3980; routes test 27 + `mediaStore.head.test.ts` 6 green |
| S5 Task 5: webhook | CONFORMS | `voice.ts:381` budget dep; :389-443 union, lookup, offer; :1955-1956 call site; `founderTriage.test.ts:1171-1305` (a)-(g) + (e2) green (C2 is a test-reach gap) |
| S6 Task 6: fake-twilio | CONFORMS | `twimlInterpreter.ts:27` ordered parser, :38-51 `greetingBeforeRecord`, :108 spread into the record plan; `voiceTypes.ts:76-79`; `callEngine.ts:144-152` `defaultFetchStatus`, :663-673 stamp + try/catch; 18 tests green |
| S7 Task 7: dashboard API + perf catalogs | CONFORMS | `types.ts` mirror + field + Omit; `client.ts:46-50`, :103-121 (throw on both, one fetch); `endpoints.ts:2050-2067`; `mutationCatalog.ts` +2, test count 110; `routes.ts` `VOICE_GETS`; `templates.ts` +2; static tests green (C3 = citation ranges) |
| S8 Task 8: hook, block, CSS | CONFORMS | `useVoicemailGreeting.ts`; `VoicemailGreetingBlock.tsx`; mount at `VoiceSection.tsx:214` after the ternary; CSS `.greeting*` classes; 16 + 10 tests green (C1, C4, C6 are gaps and nits, not misses) |
| S9 Task 9: e2e spec | CONFORMS | `voicemail-greeting.spec.ts:121-214`: 4 tests covering spec 5 Playwright steps 1-7; viewport guard green; S9 run log (not re-run here) |
| S10 Task 10: issue | CONFORMS | `docs/issues/voicemail-greeting-format-normalization.md` = plan Step 1 text; `docs/issues/INDEX.md` regenerated 04:42 and contains the slug; gitignored (`.gitignore:62`); GLOSSARY has no settings/voice section, so there was correctly no edit (the plan's own condition). Step 3 handback is the orchestrator's end item and not yet due |

## Table 2 - Spec 4.1-4.10 normative requirements

| req | verdict | code | pin |
|---|---|---|---|
| 4.1 constants (key, 5 MiB, 600 s, 2500 ms, types, message, header, 120, 12) | CONFORMS | `voicemailGreeting.ts:9-34` | test :198-204 |
| 4.1 normalize (lower-case, strip params, x-wav -> wav, else undefined) | CONFORMS | :43-49 | :31-43 |
| 4.1 sniff WAV (RIFF....WAVE, >= 12) | CONFORMS | :58-60 | :55-57, :68-71 |
| 4.1 sniff MP3 (ID3, or sync with non-zero layer bits; ADTS refused) | CONFORMS | :61-65 | :50-54, :58-63 |
| 4.1 declared type and header must agree | CONFORMS | sniff runs per declared format | :64-67; route :253-260 |
| 4.1 gate holds <= 12 bytes, refusal pushes ZERO bytes | CONFORMS | :96-120 | :88-94 |
| 4.1 gate never forwards the crossing chunk (<= maxBytes downstream) | CONFORMS | :97-101 count checked before any push | :95-109 |
| 4.1 end: 0 bytes -> `empty`; short -> `invalid_format` | CONFORMS (C5 reading) | :122-139 | :110-113 |
| 4.1 sanitizer (segment, controls, trim, 120 code points, fallback) | CONFORMS | :145-156 | :139-156 |
| 4.1 withTimeout (race, clear timer, swallow late rejection, no flag) | CONFORMS | :173-182 | :158-196 |
| 4.2 record shape; projected only when ALL fields valid AND key = constant | CONFORMS | `settingsRepo.ts:118-151` | `settings.test.ts:773-797` (11 malformed rows incl. foreign key, missing contentType, wrong-typed/negative size, DynamoDB NULL) |
| 4.2 patch null = REMOVE, generic path unchanged; default unchanged | CONFORMS | :234-237 | :799-811 (`REMOVE #k0`) |
| 4.2 parsePatch ignores the key; local SettingsPatch Omits it | CONFORMS | `settings.ts:81` (parsePatch body untouched) | routes :27-40 |
| 4.3 mount in the settings router (requireAuth, csrfOrigin `app.ts:216`, `/api/*`); `mediaStore` dep | CONFORMS | `settings.ts:63`, :323; `api.ts:730` | routes suite |
| 4.3 `requireRole('admin')` then limiter {`voicemail_greeting_upload`, 10, 60_000}, one per router | CONFORMS | :224-229, :323 | :114-123 (429) |
| 4.3 raw body, no multipart, no new dependency | CONFORMS | parsers `app.ts:136-137` only; no package.json change | - |
| 4.3 name header URI-decoded in try/catch; malformed = absent | CONFORMS | :206-214, :400 | :430-439 |
| 4.3 step 1: 503 `media_storage_unavailable` | CONFORMS | :325-328 | :89-94 |
| 4.3 step 2: 400 `unsupported_media_type` + message | CONFORMS | :329-333 | :96-105 |
| 4.3 step 3: CL > cap -> 413 {`file_too_large`, `maxBytes`}; CL 0 -> 400 `empty_file` | CONFORMS | :334-342 | :262-269, :107-112 |
| 4.3 step 4: no-op error listener at once; `req.pipe` not pipeline; req error / aborted / close-before-complete -> ClientAborted; put in same tick; classify by ERROR | CONFORMS | :344-362, :387 (+ S4-3 guard at :360) | :283-396 |
| 4.3 refusal: unpipe + resume drain, then answer; never destroy, never `Connection: close` | CONFORMS | :368-385 | reuse pin :240-251 (probe A red-proof) |
| 4.3 client abort: WARN {actor, reason}, no response, nothing stored | CONFORMS | :387-391 | :283-336, :338-396 |
| 4.3 other error: 500 `upload_failed` + ERROR {err, actor, s3Key} | CONFORMS (C8) | :392-394 | :478-488 |
| 4.3 refused/aborted never reaches S3; old bytes identical; >= 3 MiB bodies | CONFORMS | gate + single put | :253-279, :450-467 |
| 4.3 step 5: record fields; SET; record failure -> 500 `greeting_record_failed` + ERROR | CONFORMS | :397-415 | :400-420, :490-502 |
| 4.3 best-effort audit (`uploaded`); INFO without name; 200 {voicemailGreeting} | CONFORMS | :417-423 | :469-476, :441-448 |
| 4.4 admin; REMOVE, then best-effort delete (WARN), audit `removed`, INFO, 204; no-op when unset | CONFORMS | :430-444 | :504-530 |
| 4.5 GET /api/settings carries it | CONFORMS | OrgSettings field | :418-419 |
| 4.5 audio route: any user; shared helper; 404 unset / no store / object gone | CONFORMS | :450-472; `serveMediaObject.ts` | :543-548, :565-572, :574-577 |
| 4.5 Accept-Ranges, 206 range, `private, max-age=3600`, object type (fallback record), `?v=` | CONFORMS | :457-459; `endpoints.ts:2065-2067` | :550-563; client test |
| 4.6 offer replaces the `<Say>` line; fallback only when not played | CONFORMS | `voice.ts:1955-1956` | (a), (b) |
| 4.6 lookup returns a result and touches nothing | CONFORMS | :389-404 | probe B part 1 (C2) |
| 4.6 withTimeout + `AbortSignal.timeout(budget)` to HEAD; WARN {err, callSid, budgetMs} | CONFORMS | :414-427; `mediaStore.ts:256` | (d), (e), (e2); head test |
| 4.6 absent -> no log; no_store / missing WARN {callSid, s3Key}; play -> INFO; URL never logged | CONFORMS | :429-443 | (a)-(f) |
| 4.6 budget dep; production never overrides it | CONFORMS | :381; grep finds only :350/:381 in app/src | (e), (e2) |
| 4.6 Record / thanks / hangup / masked / voicemail-done untouched | CONFORMS | diff touches only :1955-1956 there | (a), (g) |
| 4.7 types mirror + SettingsPatch Omit | CONFORMS | `types.ts` | typecheck |
| 4.7 client `rawBody`/`headers` additive; throw on both; ONE fetch; `noteServerDate` / `errorFrom` reused | CONFORMS | `client.ts:103-121` | client test; catalog 110 |
| 4.7 endpoints (literal paths, encoded name header, audio URL) | CONFORMS | `endpoints.ts:2050-2067` | client test |
| 4.7 hook shape; pre-checks; aliases; extension only for EMPTY type; error map | CONFORMS (unit pin gap C1) | `useVoicemailGreeting.ts:34-44`, :64-82, :119-146 | block :149-174, :217-223, :253-269 |
| 4.7 block inside the section, below/outside the ternary; h3; `useOptionalAuth` gating | CONFORMS | `VoiceSection.tsx:214`; block :25-26, :58 | VoiceSection :190-197 |
| 4.7 helper text verbatim (+ VA suffix) | CONFORMS | block :59-64 | :83-87, :99-101 |
| 4.7 loading Spinner; LOAD failure = status + Retry, never an alert | CONFORMS | :66-78 | :104-112 |
| 4.7 empty state + admin Upload | CONFORMS | :79-89 | :78-90 |
| 4.7 set state: name, "Uploaded <date> by <email>", `<audio controls preload=metadata aria-label src>`, onError status, admin Replace/Remove | CONFORMS | :90-131 | :176-199 |
| 4.7 hidden input `accept` + label; "Uploading..." disabled; success notices | CONFORMS (C4) | :151-161, :85-86, :115-116; hook :140 | :118-147 |
| 4.7 Remove Modal: title, body, Cancel/Remove, busy-undismissable, in-dialog alert, stays open; "Greeting removed." | CONFORMS | :163-191, :40-48 | :201-215, :225-250 |
| 4.7 user-action errors as `<p role="alert">` under the controls | CONFORMS | :139-143 | :149-174, :217-223 |
| 4.7 phone width: stacked, `audio width: 100%`, buttons wrap; no `<main>` overflow; dialog fits | CONFORMS | CSS `.greetingCurrent` (column), `.greetingPlayer`, `.greetingActions` / `.greetingRow` (wrap) | e2e :183-202 |
| 4.7 styles in `VoiceSection.module.css`, new class names only | CONFORMS | new `.greeting*` classes; reuses existing `.center` / `.error` | - |
| 4.7 perf rows (VOICE_GETS, routes.test, 2 catalog entries, 108 -> 110) | CONFORMS | e2e/performance diff | static tests green |
| 4.8 verb immediately before `<Record>` via preserveOrder parse; CallState fields; `fetchStatus` seam (5 s, discard body, 0 on throw); continue regardless | CONFORMS | S6 anchors above | fake-twilio 18 green |
| 4.10 never log name / URL / bytes; ERROR only for server faults; limits; no catalog / dependency / infra | CONFORMS | as above | routes :441-448; (a) no `X-Amz-Signature` in capture; (c) no `http` in WARN |

### 4.9 surfaces vs the diff

- **Writers.**
  - PUT greeting: SET after the put (`settings.ts:407`).
  - DELETE: REMOVE, then delete (:432-438).
  - `PUT /api/settings`: ignores the key (pinned).
  - Seeds `lean.ts` / `matrix.ts` and `/__dev/reseed`: not in the diff, so the record is dropped on reseed (assumption D).
  - `putOrgSettings`: write path unchanged, patch type updated.
  - Harness settings fake: mirrors the field (:2327-2333).
  - All CONFORM.
- **Readers.**
  - Conform: projection, GET/PUT responses, webhook, audio route, block, fake-twilio.
  - Untouched (not in the diff): TemplatesSection, QuietHoursSection, NumbersSection, SystemStatus, QuickReply and `settingsToOverrides`. D3 notes that SystemStatus reads flags, not OrgSettings.
- **Gate-2 static surfaces.**
  - VoiceSection.test.tsx: `getSettings` is mocked, and only the `beforeEach` arrow was rewritten (F4). The existing assertions are byte-identical.
  - voice-outbound.spec.ts: untouched. The block has no alert at load, and S9 ran this spec as a neighbour (31 passed).
  - mutationCatalog +2, count 110: CONFORMS.
  - routes / routes.test / templates: CONFORMS. The 2 template paths cover the 3 endpoints because PUT and DELETE share a path. Citation ranges are C3.
  - viewport guard: green.
  - voiceRecording.test.ts: unchanged.
  - Harness seams and option: CONFORMS.
  - client.ts: one fetch (the scan did not throw; count 110).
  - `head(key, opts?)`: additive; one-argument fakes still typecheck (EXIT=0).

### Section 5 test list

Every listed test exists:

- Unit: `voicemailGreeting.test.ts`.
- Settings: :773-812.
- Routes: every bullet, mapped in the table above.
- Webhook (a)-(g) at :1171-1305, with (h) folded into the `signal: true` checks of (a) and (e).
- fake-twilio: interpreter :87-107, engine :152-190.
- Dashboard: every bullet, plus extras.
- `client.test`: 5 cases.
- Playwright steps 1-7: spec :121-214.

The only list-adjacent gaps are C1 (beyond the list) and the spec's literal "fake resolves" wording for (e) (C2).

## Table 3 - Assumptions A-H

| A | implemented as stated? | evidence |
|---|---|---|
| A: admin-only mutation; every user reads and plays; VA read-only, no buttons | YES | `requireRole('admin')` at `settings.ts:323` and :430; audio under the `/api` mount (VA 200 at routes :550-563, 401 at :574-577); block gating at :25-26, :84, :113, :151; tests: block :92-102, routes :83-87 and :527-530, e2e :204-214 |
| B: uploader = session `userId` + `email`; "Uploaded <date> by <email>" | YES | `settings.ts:403-404`; block :94-96; routes :404-411 |
| C: name = sanitized file name; never logged; travels in a header | YES | `settings.ts:400`; `endpoints.ts:2054`; routes :441-448 |
| D: reseed drops the record, object remains | YES (by omission) | seeds not in the diff |
| E: confirmation on Remove only; Replace = the picker | YES | block :115 (picker) vs :118-128 + Modal :163-191 |
| F: no log line when unset; WARN when set but unofferable | YES | `voice.ts:430-437`; (b) asserts no greeting line at any level |
| G: no app buffer; pipe into the existing `put`; no new adapter path | YES | `settings.ts:361-362`; `mediaStore.ts` only gains the head signal |
| H: versioned bucket keeps prior versions (delete marker) | YES (infra, no code) | handback item; no lifecycle change in the diff |

## Table 4 - Review Focus 1-5 (pin, would it go red, proof)

| RF | pinning test(s) | fails if regressed? | red-proof run by this reviewer |
|---|---|---|---|
| 1. Renamed M4A: server refuses with the M4A message and it REACHES the browser | routes :253-260 (JSON arrives, no put, not client_aborted); routes :240-251 (refusal drains, keep-alive socket reused); gate/sniff unit tests; e2e :159-181; client mapping: NONE at unit level (C1) | The JSON-arrival pin does NOT catch a pipeline / `Connection: close` regression on loopback (S4 item 8). The REUSE pin does. The mapping is caught only by the e2e. | Probe A: copies of the refusal wiring in a mini app. Faithful: `{putStatus:400, getStatus:200, reusedSocket:true}` GREEN, and chunked 413 GREEN. No-drain copy: `{"error":"ECONNRESET"}` RED. `stream.pipeline` copy: `{"error":"ECONNRESET"}` RED (about 6 s each). Probe D: the server-code mapping test against the real block is GREEN (C1). |
| 2. S3 hangs during a miss: prompt inside the budget, no `<Play>` after the `<Say>` | (e) :1223-1238 (elapsed < 1 s, one WARN, `signal: true`, nothing after a tick); (e2) :1240-1271 (withTimeout alone bounds a hung settings read) | Bound: YES. S5's probe removed withTimeout and (e2) went red ("Test timed out in 8000ms"); removing the abort signal fails (e)'s `signal: true`. "Nothing after the budget": NO for a late SUCCESS (C2). | Probe B: the REAL router with a late-succeeding head is GREEN (72 ms response, one WARN, no `offered`). A mutated copy (the lookup acts) stays GREEN under (e)'s fake and goes RED only under a late-resolving fake. |
| 3. 5 MB replace in flight while a caller hits voicemail: the old greeting byte-for-byte until the single PutObject | routes :450-467 (two puts only; refused 3 MiB and too-large replaces leave the object byte-identical and the record unchanged); gate unit :95-109 (<= maxBytes forwarded, so no multipart) | YES for any route-side regression that touches the object early. The harness put stores only at stream end, modelling S3's atomic PutObject. | Probe A: a delete-before-put copy RED on the byte-identical assertion; faithful copy GREEN. |
| 4. VA on Settings > Voice: no controls, no alert at load, cell flow unchanged | block :92-102 (VA), :104-112 (load failure = status); VoiceSection :190-197 (users/me failure -> one alert); VoiceSection's 9 original tests byte-identical; e2e :204-214 | YES | Probe D: a copy of the block that ignores `isAdmin` makes the VA pin RED; a copy that renders the load failure as `role="alert"` makes the no-alert pin RED. |
| 5. Hand-edited `s3Key` pointing at a recording is treated as no greeting | `settings.test.ts:779-797` (`recordings/CA1/RE1` row) | YES at the repo. The webhook and audio route read through `getOrgSettings` (`voice.ts:396`, `settings.ts:451`), and the projection returns the CONSTANT key (:141). N7: the harness fake is unprojected, so the pin lives only at the repo level, by design. | Probe C: the real projection returns undefined; a copy without the key check makes the pin RED. |

## Table 5 - Deviations named in slice reports and the worklist

Every deviation honors the spec's intent; the table covers each one.

| deviation | honors intent? | note |
|---|---|---|
| S1-1: extra test pinning N2 (no byteLength / length / size / path) | yes | stronger |
| S1-2: comment replaces the plan's eslint note | yes | - |
| S1-3: fake-timer clear-timer pin | yes | closes a spec 5 gap the plan left |
| S1 worth-an-eye 1: 3-byte MP3 accepted | yes, under one reading | C5 |
| S2-1 +6 malformed rows; S2-2 IIFE -> const; S2-3 comments | yes | - |
| S3-1..4: comments, wrap, JSDoc, F1 imports removed | yes | D1 honored; guard 36/36 |
| S4-1 N4; S4-2 N5 | yes | - |
| S4-3: `if (req.destroyed) abortGate()` before the pipe | yes | It triggers the abort path for a request already gone, so put never hangs. Put's OUTCOME is still classified by the error alone (spec 4.3). Pinned at routes :338-396. |
| S4-4..7: extra cases, rawPut rejects, `fromCodePoint` (ASCII), param names | yes | - |
| S4-8 / S4-10 | yes | C7 / C8 |
| S5-1..3: helper placement, eslint scope, (h) folded into (a)/(e) | yes | - |
| S6-1..3: F2 / F3, drive blocks, comment placement | yes | - |
| S7-1: SettingsPatch JSDoc appended, not replaced | yes | the additive-only rule |
| S7-2..5: F5, F6, N13, spy, import order | yes | - |
| S7 (implicit): `client.ts:113` hoists `payload ?? rawBody` into `outgoing` | yes | The scanner keys on the fetch's inline `buildUrl` argument and enclosing function; count 110, no throw |
| S8-1: dropped `useId` on the h3 | yes | no consumer; the wrapper is a plain div by design |
| S8-2 / S8-3: extra VoiceSection test and assertions | yes | - |
| S8-4 / S8-7 | yes | C3 / C6 |
| S9-1..7: F7, N16, constants, extra assertions | yes | - |
| S9-9: e2e residue ERRORs ("status callback for unknown provider SID") | yes (spec followed) | Spec 5 step 2 prescribes `uniqueVoicePhone()`. A known caller would silence the auto-text receipts; this is not greeting code and is the orchestrator's call. |
| S9-10: limiter trips at `--repeat-each` >= 4 | yes | by design (10/min) |
| F1-F10 | yes | All applied: F1 (`api.ts` imports), F2/F3 (`callEngineVoicemail.test.ts` `clock2` + type import), F4 (VoiceSection `beforeEach` block), F5 (`types.ts` placement), F6 (count comment), F7 (spec :89-93), F8 (block :151-161), F9 (`.greetingActions`), F10 (bare tokens) |
| D1-D3 | yes | honored as ruled |

## Spec requirements that NO slice delivered

None found. Open items that are open BY DESIGN, not misses:

- The section 7 dev checks and the plan Task 10 Step 3 handback (orchestrator and Cameron, after the build).
- This reviewer did not re-run the Playwright spec; S9's runs are the evidence.

## Probe hygiene

These probe files were created, run and deleted:

- `app/test/zz-review-probe-refusal.test.ts` (A)
- `app/test/zz-review-probe-late-lookup.test.ts` (B)
- `app/test/zz-review-probe-projection.test.ts` (C)
- `dashboard/src/routes/settings/zz-review-probe-block.test.tsx` (D), plus two sed-made copies of the block with one mutation each (`zz-review-probe-copy-admin.tsx`, `zz-review-probe-copy-alert.tsx`)

Mutated-variant cases used `it.fails`, so each passing probe run means the pin's assertion failed as predicted.

No tracked file was modified and nothing was staged or committed. After deletion, `git status --short` was clean before this report was written.

At finish, `git status --short` shows this report plus two untracked files that are NOT mine:

- `app/test/zz-review-probe-races.test.ts` (created 05:02:55)
- `app/test/zz-review-probe-realstore.test.ts` (created 05:01:20)

Their headers read "THROWAWAY adversarial-review probe (deleted before handback)", so they belong to the concurrent adversarial reviewer. I left them untouched. The orchestrator should confirm that reviewer deletes them before the round-1 records are committed.
