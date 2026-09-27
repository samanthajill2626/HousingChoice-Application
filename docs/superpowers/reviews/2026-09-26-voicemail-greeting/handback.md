# Handback - feat/voicemail-greeting (recorded voicemail greeting, Sam's item #10)

Build orchestrator, AUTO mode, overnight 2026-09-26/27. Worktree
`W:/tmp/voicemail-greeting`, branch `feat/voicemail-greeting`, base main
@0dafe3c1. Records (tracked): `docs/superpowers/reviews/2026-09-26-voicemail-greeting/`.

## The mission, restated

Let an admin upload an MP3 or WAV voicemail greeting in Settings > Voice, so a
caller who reaches the business line's voicemail hears Sam's own voice instead
of the computer voice, then the beep, exactly as today. Staff can play it in the
page; admins can replace it or remove it (Remove asks first); removing puts the
computer voice back. Server-side: content type AND header sniff, 5 MB cap, the
M4A message, streamed to one fixed media key, the record on the org settings.
The voice webhook must never fail because of the greeting: every lookup-time
problem falls back to today's spoken prompt inside a 2.5 s budget with one WARN
and no PII. Nothing else about voicemail changes. No new dependency, no infra,
no message-catalog copy.

## Questions I would have stopped for

Spec section 3 assumptions A-H (the planner's readings; built as written),
verbatim:

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
- G. Decision 2's "never buffer the whole file": the route holds no buffer
  and pipes the request into the media store's existing `put`, and
  lib-storage (in the app process) holds at most one 5 MiB part in heap
  before its single `PutObject`, which at this cap is the whole file
  (section 2) - the same posture the voicemail-recording mirror ships with.
  A LITERAL delivery exists: a streamed `PutObjectCommand` with an explicit
  `ContentLength` taken from the request behind an additive adapter method
  (S3 creates the object only on a complete body, so atomicity holds). It is
  DECLINED for this build, not because decision 2 cannot be met, but because
  it adds a new adapter path whose behavior against the local MinIO's
  streamed-checksum handling is UNVERIFIED, for a gain of at most 5 MiB of
  transient heap on an admin-only, 10/min route. Routing the bytes through
  the app (rather than the direct-to-S3 pattern MMS and photos use) is what
  decision 2 says; the 2026-07-15 reason for the direct pattern (20 MB photo
  batches on one EC2 instance) does not apply here.
- H. Removing or replacing on a VERSIONED bucket keeps prior versions
  (section 2). "Removing clears both" is delivered for the current version
  and the record; true deletion of old versions needs a lifecycle rule (an
  infrastructure change, out of scope; handback names it as an option).

Precision on G, measured during the build: lib-storage's part concatenation
makes a transient copy, so the per-upload PEAK is about twice the file (about
10 MiB at the cap), not 5 MiB; comments now say so (review R2 F2).

Forks met during the build (all decided on-branch; none is a section-3
decision; each is recorded in the adjudication files):

1. Tiny uploads (spec 4.1 "fewer bytes than the sniff needs"). The plan read
   "needs" per format, which let a 3-byte `ID3` body become the live greeting.
   Adopted the stricter reading with the spec's own 12-byte constant: a
   non-empty body under 12 bytes is refused (FW2). Your call if you prefer
   the per-format reading.
2. Concurrent greeting writes (review A1, CONFIRMED): PUT vs DELETE can leave a
   record with no object; PUT vs PUT a record describing the other upload's
   bytes. Spec 4.3 "Concurrency" names and ACCEPTS both, so no code change;
   the missing-object state is visible in the dashboard (strengthened by FW3).
   Hardening options filed for you in
   `docs/issues/voicemail-greeting-concurrent-writes-unserialized.md` (an
   in-process lock - cost: a stalled upload holds it up to Node's 300 s
   requestTimeout - or pinning the record to the PutObject VersionId).
3. The shared `serveMediaObject` helper now RELEASES the store body when the
   client leaves mid-stream (FW1, spec 4.10: client aborts must not produce
   ERROR lines; `preload="metadata"` makes that frequent). This also changes
   the call-recording route (strictly a socket-leak fix; its tests are
   unchanged and green). The same pattern in the MMS media and unit-media
   routes is filed, not fixed: `docs/issues/media-serve-client-abort-leaves-body-open.md`.
4. Spec 4.3's stated REASON for banning `stream.pipeline` was disproven on
   Node 24 (the 400 IS written; the connection then stalls because the body is
   never drained). The rule stands; an erratum paragraph was added to spec 4.3
   (review R2 C7), original text kept.
5. The e2e's missed calls come from known contacts (`createContact`) instead of
   `uniqueVoicePhone()` (spec 5 step 2): unknown callers get the missed-call
   auto-text, whose SMS receipts landed after the next test's reseed and
   logged ERRORs in 3 of 11 runs. Same proof, no async noise (FW9).
6. Deferred, your eye: the file-name sanitizer keeps C1 controls, bidi
   overrides and zero-width characters (review A7; spec 4.1's rule is met;
   display-only, admin input, React-escaped, rendered in its own block).

## Work map

| item | status | notes |
|---|---|---|
| S1 Task 1 greeting library | SHIPPED b8673294, e16a3838 | + a gate test that no lib-storage-sniffed property is exposed; a real timer-cleared pin for withTimeout (the plan's relied on leak detection vitest lacks); FW2 later (12-byte floor) 08c4b7d3 |
| S2 Task 2 settings record | SHIPPED 6f020587 | 6 extra malformed-map rows; comment corrections |
| S3 Task 3 serveMediaObject extraction | SHIPPED ac60adce | recording guard 36 = 36 before/after; both now-unused imports removed (F1); FW1 later 78330aa9 |
| S4 Task 4 routes + head signal + harness seams | SHIPPED d23e21c0 | + guard for a client gone during the auth check (put() would have waited forever); 429 / abort / connection-reuse / 500 tests; refusal wiring exactly per spec |
| S5 Task 5 webhook | SHIPPED f3cc91ef | (a)-(g) incl. (e2) on a REDELIVERED summary; removing withTimeout turns (e2) red; FW4/FW6 later d82fad87 ((e3) late success, abort-at-budget pin, fixed-key consumers) |
| S6 Task 6 fake-twilio | SHIPPED 6a9072b3 | verb-before-Record via an ordered parse; fetch status best effort |
| S7 Task 7 dashboard API + catalogs | SHIPPED fb58551a | ONE delegated fetch kept; mutation count 110; VOICE_GETS + templates; FW8 citations later 359cda92 |
| S8 Task 8 greeting block | SHIPPED cfb2dd1b | + F8: the hidden input exists only once LOADED and is disabled while busy; new `.greetingActions` (wraps); bare tokens; FW3/FW5 later 1453c97f |
| S9 Task 9 e2e spec | SHIPPED 6d181b3c | openVoiceTab waits for the loaded state; `exact: true` on the player label; FW9 later cb56f148 |
| S10 Task 10 issue | SHIPPED 4efb04a3 | `voicemail-greeting-format-normalization` (created 2026-09-27); GLOSSARY untouched (no voice vocabulary section) |

## Gates on the FINAL commit de4df265 (bare, from the worktree)

`git merge main` -> "Already up to date." (main @0dafe3c1; 0 behind; no sync
commit was needed).

1. `npm run typecheck` -> EXIT=0.
2. `npm test` -> EXIT=0. app "Test Files 379 passed (379)", "Tests 7277
   passed | 1 skipped (7278)"; dashboard "205 passed (205)", "3392 passed
   (3392)"; e2e "21 passed (21)", "499 passed (499)"; fake-twilio "34 passed
   (34)", "252 passed (252)"; fake-twilio-web "13 passed (13)", "111 passed
   (111)". 0 `[dynamoAdmin]` lines.
3. `npm run smoke` -> EXIT=0, "smoke-dist: OK - 1437 import specifier(s)
   across 254 emitted file(s) resolve under plain Node."
4. `npm run e2e` - TWO runs, both reported:
   - Run 1, `timeout 1500 npm run e2e` -> EXIT=124: the 1500 s cap killed a
     suite that was still progressing (277 ok at ~24.8 min; another
     mission's lane-13 e2e ran concurrently on this machine). One failure
     before the kill: `tests/scenarios/tours.spec.ts:178` "PM-team ... exit
     NO" -> `Error: locator.click: Page crashed` (a Chromium RENDERER crash
     while waiting for "Mark toured", not an assertion); 11 tests not run.
     Diagnosed: `npm run e2e -- tests/scenarios/tours.spec.ts` alone ->
     EXIT=0 "9 passed (2.0m)" (the crashed case included). The spec has no
     voicemail-greeting intersection.
   - Run 2, `timeout 2700 npm run e2e` (the cap raised because run 1 proved
     the suite slow, not wedged) -> EXIT=0, "289 passed (27.8m)", including
     all 4 `voicemail-greeting.spec.ts` tests.
   After each run the lane-15 ports were free and `npm run e2e:stop` cleared
   the stale lane record.
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
   (35 files) -> EXIT=1 with exactly ONE error,
   `fake-twilio/src/engine/callEngine.ts:523:53 'scenario' is defined but never
   used` in `chooseAnsweringLeg` - PRE-EXISTING: the same error is at the merge
   base (line 506; baseline lint of the base blob). NO NEW ERRORS.

Earlier full run (pre-review @4efb04a3): typecheck 0, smoke 0, npm test
EXIT=0 (app 378/7264|1 skipped, dashboard 205/3382, e2e 21/499, fake-twilio
34/252, fake-twilio-web 13/111), e2e EXIT=0 "289 passed (22.5m)" - no failures
in that run.

## Files, commits, delta

36 feature files plus 3 issue files: app (voicemailGreeting.ts new, serveMediaObject.ts
new, settingsRepo.ts, settings.ts, api.ts, webhooks/voice.ts,
adapters/mediaStore.ts), dashboard (api types/client/endpoints additive;
useVoicemailGreeting.ts, VoicemailGreetingBlock.tsx new; VoiceSection.tsx +
.module.css), fake-twilio engine (3 files), e2e (1 new spec; 5 perf files),
tests. Net vs base, excluding docs: 36 files, +3625 / -109 (production code 20
files +1354/-93; tests 16 files +2271/-16). With docs: 69 files, +12557 / -109.
Commits: `git log --oneline main..HEAD` (the 7 design commits, then the build); code
commits: b8673294 e16a3838 6f020587 ac60adce d23e21c0 f3cc91ef 6a9072b3
fb58551a cfb2dd1b 6d181b3c 78330aa9 08c4b7d3 d82fad87 1453c97f 2bb3b8b6
359cda92 cb56f148 f91b50e0; issues 4efb04a3 7fdaa59a; the rest are records.

## Review

- Phase 1 drift check (4 readers): no blocker; 10 FIX items folded into the
  slice briefs; invariant sweep of every writer/reader of the org settings
  item and the media key: clean (`research-drift-worklist.md`).
- Round 1: conformance - CONFORMS (0 MUST, C1-C2 SHOULD test pins, 6 NOTE);
  adversarial PLAN-BLIND - 0 MUST, A1 SHOULD (accepted by spec), 8 NOTE; it
  drove the upload through the REAL lib-storage against a fake S3 (one
  PutObject at exactly 5 MiB; zero S3 requests on 413 / 400 / abort).
  Adjudicated into FW1-FW9 (`code-review-r1-adjudications.md`); rejected or
  deferred: A1 (spec 4.3 accepts), A7 (deferred, see forks), C4 (cosmetic,
  behind the modal), C7 (erratum later), C8 (as spec).
- Fix wave: FW1-FW9 test-first (`fix-wave-r1-report.md`).
- Round 2 (FRESH reviewer, charged with what round 1 missed first): no MUST, no
  SHOULD, no new production finding; FW1-FW9 real (FW1-FW4 revert-proven);
  F1-F3 + the C7 erratum applied as polish (f91b50e0, 4eb186f3, 981d3627).

## Self-QA (hermetic lane 15; `self-qa.md`; screenshots `.superpowers/qa/`)

Admin upload through a real file chooser -> Chrome decoded the served audio
(readyState 4, duration 2 s); audio route 200/206 with Accept-Ranges and the
private cache header; a missed call played the greeting and the fake fetched
the presigned MinIO URL (200); the log carries callSid + fixed key only (no
URL, no file name). Phone width 360: 0 overflow, long names wrap, the dialog
fits. Refusals: M4A (client), renamed M4A 200 KB (server 400), 5.3 MB (client).
A 3.6 MB renamed M4A through the Vite dev proxy showed the generic error: the
app answered 400 in 1 ms, the PROXY returned 500 - the spec 4.3 local-dev
limitation. Missing object (MinIO object deleted): the status line appears at
load, survives a refused Replace, and a missed call falls back to `<Say>` with
one WARN; a successful Replace repairs it. Remove -> 404 + `<Say>` with no log
line. VA: read-only block, plays the greeting, PUT/DELETE 403.

## Issues filed

- `voicemail-greeting-format-normalization` (improvement, low): no transcoding;
  Twilio behavior on an unplayable `<Play>` UNVERIFIED; the ID3-prefix sniff
  limitation; the dev check that settles it.
- `voicemail-greeting-concurrent-writes-unserialized` (improvement, low,
  deferred): review A1 and the two hardening options.
- `media-serve-client-abort-leaves-body-open` (debt, low): the same unreleased
  body in the MMS media and unit-media routes.

## For Cameron (from the plan's Task 10 checklist)

1. Infra-side facts: prior greeting versions persist on the versioned media
   bucket (a lifecycle rule would be the infra change - optional); whether
   CloudFront's 30 s `origin_read_timeout` can fire during a slow 5 MB upload
   is UNVERIFIED.
2. Local-dev-only limitation: through the Vite dev proxy a SERVER refusal of a
   body of about 3 MB or more reaches the browser as a proxy 500 (the app's own
   answer is the correct 400); deployed dev/prod (CloudFront -> origin, no
   Vite) is expected unaffected - settled by dev check 3 below.
3. Chunked-drain acceptance: a non-browser client streaming more than 5 MiB
   chunked is drained until it stops or Node's default 300 s requestTimeout
   ends it (never set `requestTimeout: 0`); admin-only + 10/min.
4. Dev verification after deploy (spec section 7): (1) upload a greeting in
   Settings > Voice on dev, call the dev business number, do not answer: the
   caller hears it, then the beep; the dev app log shows `voicemail greeting
   offered`. (2) Remove it, call again: the computer voice returns and no
   greeting log line. (3) Rename a 3-4 MB M4A voice memo to `.mp3` and upload
   it: expect the M4A message inline, NOT "Couldn't upload the greeting".
   (4, optional) upload a WAV Twilio cannot decode (e.g. 32-bit float), call,
   and record what the caller hears in the format-normalization issue.
5. Tooling: the project Playwright MCP (`@playwright/mcp@latest`) now wants
   chromium-1246, which is not installed on this machine; self-QA used the
   plugin MCP. Installing it (a download) or pinning the MCP version is yours.

## Recoveries, flakes, open questions

- Recoveries: 1 INFRA tier (the prior orchestrator and its 5 readers died on an
  HTTP 429 usage limit at 00:08; resumed from the ledger + git, nothing
  committed was redone). 0 agent-failure tier. No cold-dispatch misfires.
- Flakes: none that implicate this branch. Full runs: npm test green twice
  (pre-review and final); e2e green pre-review ("289 passed (22.5m)") and on
  the final re-run ("289 passed (27.8m)"). The final gate's first e2e run was
  cut off by its 1500 s cap after one Chromium renderer crash ("Page crashed")
  in tours.spec.ts under a concurrent second e2e lane; that file passes alone
  and in the re-run. Not filed: an environmental one-off with no product
  surface (say if you want an issue for renderer crashes under dual-lane
  load).
- Open questions: the six forks above (1 and 2 are the ones that could change
  code); A-H as always.

## Post-merge

NO infra, NO dependency, NO deploy, NO data migration owed by this branch.
The section-7 dev checks follow Cameron's normal deploy.

MERGE-READY on feat/voicemail-greeting (W:/tmp/voicemail-greeting) at the
branch head - the commit that adds this handback record, whose parent de4df265
is where all five gates ran (the record is the only later change; no code) -
0 behind main (@0dafe3c1), UNMERGED (human gate).

## Planner addendum (independent review, 2026-09-27 08:40)

- Fork 7 (recorded as FW4 in the build's records, missing from the six
  above): the webhook and the audio route HEAD, presign and serve the FIXED
  key constant rather than the record's `s3Key` (the projection already pins
  the two equal; this is defense in depth against a second writer of the
  map).
- Planner fix wave (review AD1, CF7, CF8, CF9, CF11; all small, test-first
  where code changed): a replace whose settings-record write fails now tells
  the admin the file IS live and re-fetches the server record (dashboard
  `greeting_record_failed` mapping + block test; route test pins the state:
  new bytes stored, old record kept, one ERROR); comment corrections in
  `settings.ts` and `voicemailGreeting.ts` (ID3-prefixed AAC passes the
  sniff on the tag; the sanitizer strips C0 + DEL only); exact-message and
  WARN-wording test pins; the concurrent-writes issue's line refs
  re-pointed; spec assumption G names the ~2x memory peak.
- Planner gates and verdict: `planner-review-verdict.md`.
