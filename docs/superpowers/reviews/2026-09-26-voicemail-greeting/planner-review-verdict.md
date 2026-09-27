# Planner verdict - feat/voicemail-greeting (recorded voicemail greeting, Sam's item #10)

Date: 2026-09-27 09:20 (overnight unattended mission, Go-AUTO taken by the
planner per Cameron's standing instruction in the mission text)
Worktree: `W:\tmp\voicemail-greeting`   Branch: `feat/voicemail-greeting`
Code tip: **c720e0a3** (the commit every gate below ran on; this verdict is
the only commit after it, docs only)   Base: main @0dafe3c1, **0 behind**
Spec: DRAFT 3 (`docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md`)
Plan: DRAFT 3 (`docs/superpowers/plans/2026-09-26-voicemail-greeting.md`)
Records: `docs/superpowers/reviews/2026-09-26-voicemail-greeting/` (29 files,
all committed as produced: spec R1-R2, plan R1-R2, research worklist, 9 slice
reports, build code-review R1-R2 + fix wave, self-QA, handback, planner
conformance + adversarial R1-R2 + adjudications, this verdict)

## MERGE-READY @c720e0a3 on feat/voicemail-greeting (W:/tmp/voicemail-greeting), 0 behind main, UNMERGED (human gate)

```powershell
cd "W:\AI Projects\Housing Choice\HC Application"; git merge --no-ff feat/voicemail-greeting -m "Merge feat/voicemail-greeting: recorded voicemail greeting (Sam's item #10)"
```

No infra, no dependency, no deploy, no data migration owed. Deploy follows
Cameron's normal path; the dev checks are in section "After deploy".

## Planner gates on c720e0a3 (bare, from the worktree, real exit codes)

| gate | result (quoted) |
|---|---|
| 1 `npm run typecheck` | `EXIT=0` |
| 2 `npm test` | `EXIT=0`; app `Test Files 379 passed (379)` `Tests 7278 passed / 1 skipped (7279)`; dashboard `205 passed (205)` / `3393 passed (3393)`; e2e workspace `21 passed (21)` / `499 passed (499)`; fake-twilio `34 passed (34)` / `252 passed (252)`; fake-twilio-web `13 passed (13)` / `111 passed (111)`; `[dynamoAdmin]` lines: 0 |
| 3 `npm run smoke` | `EXIT=0`; `smoke-dist: OK - 1437 import specifier(s) across 254 emitted file(s) resolve under plain Node.` |
| 4 `npm run e2e` (full, hermetic lane) | `EXIT=0`; `289 passed (21.1m)` |
| 5 `npx eslint <35 touched files>` | 1 error, `fake-twilio/src/engine/callEngine.ts:523:53 'scenario' is defined but never used` - PRE-EXISTING at the merge base (same error at main line 506, verified by linting the base blob); NO NEW ERRORS |

Earlier planner run on the handback tip e271acd2 (same day): typecheck 0,
smoke 0, `npm test` EXIT=0 (counts one test fewer, before the fix-wave
tests), e2e `288 passed, 1 failed (24.7m)` - the failure was
`group-text-reply-all.spec.ts` (a native group-text SSE delivery rollup that
did not finalize inside 60 s under a concurrent second e2e lane); it passed
alone `2 passed (25.5s)`, has no greeting intersection, and the final run
above is clean. The builder's two full runs on de4df265: run 1 cut by its
1500 s cap after one Chromium renderer crash in `tours.spec.ts` (passes
alone), run 2 `289 passed (27.8m)`. Three full runs, three different
outcomes, one green each way: environmental under dual-lane load, not a
branch flake. Nothing filed.

## Spec conformance (planner conformance reviewer + my own read)

| item | verdict | notes |
|---|---|---|
| D1 upload MP3/WAV, type + sniff, 5 MB, given message, helper text | CONFORMS | ADTS AAC refused on layer bits; an ID3-wrapped non-MP3 passes on the tag (filed) |
| D2 stream to fixed key; record key/type/uploadedAt/uploader; replace/remove | CONFORMS (assumption G) | lib-storage single PutObject; peak ~2x file (~10 MiB) |
| D3 `<Play>` presigned 10 min after HEAD, fallback `<Say>` + one WARN, never fails | CONFORMS | whole lookup bounded 2.5 s + abort signal; result-returning closure; WARN only when a greeting is set and cannot be offered (assumption F) |
| D4 Settings > Voice: upload, name + date, authed player, Replace, Remove with confirmation | CONFORMS (assumptions A, B, E) | admin-only mutations; VA read-only; Remove confirms; Replace = file picker |
| D5 nothing else about voicemail changes | CONFORMS | `<Record>` params, thanks, goodbye untouched; masked/outbound branch untouched |
| 4.9 writers/readers of the org item and the media key | CONFORMS | parsePatch ignores the field (pinned); seeds drop it on reseed (assumption D); harness fakes mirror it |
| gate-2 static surfaces | CONFORMS | mutation catalog 110; VOICE_GETS + conditional audio GET; no banned expression in the e2e |
| section 5 tests | CONFORMS | unit, routes (incl. 3 MiB / 6 MiB / chunked refusals on keep-alive), webhook (a)-(g) + (e2) + (e3), fake-twilio, dashboard, e2e steps 1-7 |

Declared deviations (all recorded, none reopening a decision): 12-byte
minimum body (fork 1); `serveMediaObject` releases the S3 body when a client
leaves, which also fixes a socket leak on the call-recording route (fork 3);
spec 4.3 erratum on the pipeline ban's measured reason (fork 4); e2e callers
are known contacts (fork 5); sanitizer keeps C1/bidi/zero-width (fork 6);
the webhook and audio route use the fixed-key CONSTANT, not the record's
`s3Key` (fork 7, defense in depth).

## Review rounds and fix waves

- Build: research drift check (10 fixes folded); code review R1 conformance
  CONFORMS + adversarial 0 MUST / 1 SHOULD (accepted by spec) -> FW1-FW9;
  R2 fresh reviewer: no MUST/SHOULD, FW1-FW4 revert-proven; polish F1-F3.
- Planner: conformance CONFORMS WITH DEVIATIONS (0 MUST / 0 SHOULD / 11
  NOTE); adversarial 0 MUST / 1 SHOULD / 13 NOTE -> planner fix wave
  (1f7e99b4); adversarial r2 on it: 1 SHOULD (my own message was false for
  a first upload) + 3 NOTE fixed -> second fix wave (c720e0a3). Adjudications
  with every rejection and its reason: `planner-review-adjudications.md`.

## Questions I would have stopped for (decide at leisure; none blocks the merge)

Spec section 3 assumptions A-H, built as written (verbatim in `handback.md`).
Plus, from the reviews:

1. **Greeting length.** Nothing caps it: 5 MB is ~5.5 min of MP3 that every
   caller sits through (billed) before the beep, while the caller's own
   message is capped at 120 s. A copy hint in the helper text ("keep it under
   30 seconds") costs nothing; a hard cap needs a decoder (a dependency) or a
   duration read from the header (WAV only). Not built.
2. **Alarm on a broken greeting.** A greeting that is set but cannot be
   offered logs WARN on every missed call (decision 3's word), and the alarms
   fire on ERROR. The default no-greeting state never reaches a WARN, so
   there is no flood risk either way; the real choice is whether a broken
   greeting should page you. A metric filter on the two WARN messages would
   alarm without touching decision 3. Not built.
3. **Uploader email shown to VAs.** Decision 4 asked for name and date;
   assumption B added "by <email>", the first staff email a VA sees in the
   app (the team list is admin-only). Date-only is a one-line change.
4. **Tiny uploads** (fork 1): bodies under 12 bytes are refused without a
   sniff; the plan's per-format reading would have let a 3-byte `ID3` body
   become the live greeting.
5. **Old greeting versions** persist on the versioned media bucket (a
   lifecycle rule would be infra; optional).

## Known limitations carried (all in the spec and handback)

- Through the LOCAL Vite dev proxy a SERVER refusal of a body of about 3 MB
  or more reaches the browser as a proxy 500 (the app answers the correct
  400 in 1 ms); deployed dev/prod (CloudFront -> origin) are expected to
  deliver the JSON - dev check 3 below settles it.
- A chunked body over the cap from a non-browser client is drained until it
  stops or Node's default 300 s `requestTimeout` ends it (never set it to 0).
- Whether CloudFront's 30 s `origin_read_timeout` can fire during a slow 5 MB
  upload is UNVERIFIED.
- Twilio's behavior on a `<Play>` file it cannot decode is UNVERIFIED (issue
  `voicemail-greeting-format-normalization`; dev check 4).
- Concurrent PUT/DELETE or PUT/PUT can leave a record describing other
  bytes (spec-accepted; visible in the dashboard; issue
  `voicemail-greeting-concurrent-writes-unserialized`).

## Issues filed by this branch

`voicemail-greeting-format-normalization` (improvement, low),
`voicemail-greeting-concurrent-writes-unserialized` (improvement, low,
deferred), `media-serve-client-abort-leaves-body-open` (debt, low: the MMS
media and unit-media routes still hold the S3 body when a client leaves).

## After deploy (spec section 7)

1. Upload a greeting in Settings > Voice on dev; call the dev business
   number; do not answer on the holder's cell: the caller hears the greeting,
   then the beep; the dev app log shows `voicemail greeting offered`.
2. Remove it; call again: the computer voice is back; no greeting log line.
3. Rename a 3-4 MB M4A voice memo to `.mp3` and upload it: the M4A message
   must appear inline (NOT "Couldn't upload the greeting").
4. Optional: upload a WAV Twilio cannot decode (32-bit float), call, and
   record what the caller hears in the format-normalization issue.

## Tooling note (from the builder)

The project Playwright MCP (`@playwright/mcp@latest`) wants chromium-1246,
which is not installed on this machine; the build's self-QA used the plugin
MCP instead. Installing that browser (a download) or pinning the MCP version
is Cameron's call; nothing on this branch depends on it.

## Recoveries

1 INFRA tier (orchestrator #1 and its readers died on the 1:20am usage limit
during Phase 1; resumed from the ledger + git at 01:29, no committed work
redone). 0 agent-failure tier. No cold-dispatch misfires. Cameron's 30-minute
watchdog cadence held from dispatch to handback.

Cleanup (worktree + branch + HISTORICAL stamps) only on an explicit go after
the merge.

## Addendum 2026-09-27 13:10 - Cameron's rulings, second merge owed

State: `main` already contains this branch through **65015b2c** (merged
before the rulings below). The branch now carries ONE code commit on top,
**c3b66108**, plus this addendum and an issue sighting (docs only).

Cameron's rulings (spec amended in the 2026-09-27 block under its header):
greeting length uncapped with a helper-text hint ("Keep it short - under 30
seconds works best, ..."); a greeting that IS set but cannot be offered logs
ERROR (a settings-read failure, where whether a greeting is set is unknown,
stays WARN); the uploader email to every logged-in user stays; old greeting
versions stay on the versioned bucket (no lifecycle rule); the 12-byte
tiny-upload floor stays.

Gates on c3b66108 (bare, from the worktree):

| gate | result |
|---|---|
| 1 typecheck | `EXIT=0` |
| 2 npm test | `EXIT=0`; app 379 files / `7278 passed / 1 skipped`; dashboard `3393 passed`; e2e workspace `499 passed`; fake-twilio `252 passed`; fake-twilio-web `111 passed`; `[dynamoAdmin]` 0 |
| 3 smoke | `EXIT=0`, 1437 specifiers / 254 files |
| 4 e2e | `EXIT=1`, `284 passed, 5 failed (38.6m)`; all 4 voicemail-greeting tests and every voice/settings spec passed. Of the 5: `group-text-stop`, `matching-entry-points`, `relay-30003-retry` passed alone; `group-text-reply-all` and `group-text-per-recipient-delivery` FAIL ALONE here AND at main @65015b2c (before c3b66108), so they are pre-existing and unrelated (c3b66108 touches only greeting log levels and one line of copy). They passed on this machine at 09:16 the same morning. Recorded as a sighting on `docs/issues/group-reply-live-rollup-full-suite-flake.md` (its reopen signature, now deterministic in isolation). |
| 5 eslint (touched vs main: 4 files) | `EXIT=0` |

Verdict: **MERGE-READY @c3b66108** for the rulings commit - the e2e red is
main's, not this branch's (proven at the base). UNMERGED (human gate).

```powershell
cd "W:\AI Projects\Housing Choice\HC Application"; git merge --no-ff feat/voicemail-greeting -m "Merge feat/voicemail-greeting: Cameron's rulings (ERROR on an unplayable greeting; length hint)"
```
