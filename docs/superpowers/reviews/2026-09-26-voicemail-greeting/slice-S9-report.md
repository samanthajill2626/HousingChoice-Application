# Slice S9 report - Playwright e2e spec (plan Task 9)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context). Commit `6d181b3c`: the ONE
file `e2e/tests/dashboard-next/voicemail-greeting.spec.ts` - upload/serve, `<Play>` before `<Record>` with the
fake's 200 fetch of the presigned MinIO URL, Remove restores `<Say>`, phone width, reject path, VA read-only.

## E2E invocations (worktree root, hermetic lane 15, logs in ignored `.superpowers/gates/`)

1. Cold `npm run e2e -- tests/dashboard-next/voicemail-greeting.spec.ts` -> `4 passed (22.6s)`, EXIT=0, `s9-e2e-1.log`.
2. Cold, same -> `4 passed (29.8s)`, EXIT=0, `s9-e2e-2.log`.
3. ONE invocation on a background `npm run e2e:session`: this spec + voice-outbound, voice-transcription, unknown-caller-
   triage, settings, call-inbox-unread, recording-range -> `31 passed (1.2m)`, EXIT=0, `s9-e2e-3-neighbors.log`.
4. Same session, `npm run e2e -w @housingchoice/e2e -- <spec> --repeat-each=5` -> `3 failed` / `17 passed (1.2m)`,
   EXIT=1, `s9-e2e-4-repeat5.log` - the upload limiter tripping BY DESIGN (item 10), not a flake.
5. Within the limiter budget, `--repeat-each=3` (9 PUTs) -> `12 passed (23.1s)`, EXIT=0, `s9-e2e-5-repeat3.log`.
6. `npm run e2e:stop`, then cold on the FINAL committed content -> `4 passed (25.6s)`, EXIT=0, `s9-e2e-6.log`.
   Per test across runs: 2.0-3.7s / 1.4-2.0s / 1.4-2.0s / 1.2-1.7s.

Static (final content): e2e `npx vitest run support/viewport.guard.test.ts` 1 passed; `npm run typecheck` exit 0;
`npx eslint <spec>` exit 0, no output; 0 non-ASCII bytes, 0 CR bytes, the M4A header kept as `\u` escapes.

## Deviations from plan Task 9 (otherwise the plan's code)

1. F7: `openVoiceTab` ends by waiting for the empty-state line; test 1's now-duplicate wait dropped.
2. N16: both `getByLabel('Voicemail greeting')` are `{ exact: true }`; the heading keeps `level: 3`.
3. Constants `NO_GREETING` / `REJECT_MESSAGE` / `M4A_HEADER` replace repeated literals (same bytes).
4. Added: the dialog is hidden after a successful Remove (test 1).
5. Added: the reject path GETs the audio route -> 404 (nothing stored SERVER-side, not just local state).
6. Added: the VA has no `Greeting audio file` input (count 0; non-vacuous after F7). Remove-greeting absence
   stays vacuous as planned (no greeting after a reseed); the S8 unit test pins the VA-with-greeting render.
7. Header notes (name-matching traps, upload budget); neighbor set + recording-range (S3 refactored its route).

## Surprising / worth knowing

8. No app bug. All 11 first calls placed after a successful upload got `play` + fetch 200 (11 "voicemail greeting
   offered"), zero lookup-budget WARNs under another mission's concurrent suite; `<audio>` read it via 206s.
9. Residue, not greeting code: test 1's UNKNOWN callers (spec 5 step 2) get the missed-call auto-text; in 3 of
   those 11 (runs 2, 5, 6) its sent/delivered receipts arrived after a later test's reseed wiped the message ->
   2 ERRORs "status callback for unknown provider SID after retry"; no assertion affected. A named known
   caller (voice-transcription.spec.ts:155-182) would silence it; I kept the contract - orchestrator's call.
10. Limiter: 10 PUTs/min/user, 3 founder PUTs per pass. Run 4: 10 PUTs at 45.0-68.2s, 429s at 70.4/73.4/94.2s,
   freed by 112.4s; the UI shows the generic "Couldn't upload the greeting." (spec 4.7 "anything else").
11. Harness: a cold run's tree-kill leaves lane.json + lease (scripts/e2e-session.mjs:581-592); run 2 printed
   "reusing the live e2e:session" for a DEAD launcher (likely PID reuse) - benign, it booted a fresh stack.
12. End state: no stack or listener of this worktree (lane 15 ports 10501/10511/10521/10531: 0 LISTENING).
