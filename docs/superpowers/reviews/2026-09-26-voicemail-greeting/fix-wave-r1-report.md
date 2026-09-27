# Fix wave R1 report - FW1-FW9 + the A1 issue

2026-09-27, `feat/voicemail-greeting` from 6b418954, implementer Claude Opus 5.5 (1M context).
Work list: `code-review-r1-adjudications.md`. Logs: ignored `.superpowers/gates/fw*`. Baseline
at 6b418954, app named set: `Test Files 6 passed (6)` / `Tests 186 passed (186)`.

## Per fix

- **FW1 `78330aa9`** serveMediaObject destroys the body (no error) on `res` 'close' before
  `writableFinished`; an upstream error while connected stays ONE ERROR. RED (new
  `app/test/serveMediaObject.test.ts`): `Tests 2 failed | 1 passed (3)`, both client-leave cases
  `expected false to be true` at the `body.destroyed` waits (:79, :107); upstream-error guard
  passed. GREEN: `Tests 66 passed (66)` (helper 3, voiceRecording 36 - file unchanged, routes 27).
  Deviation: also releases at once when `res.destroyed` is already true (client gone while the
  store answered; same rule, the S4-3 class), with its own case. The SDK ChecksumStream's
  `_destroy` destroys its source, so a checksum-wrapped S3 body releases its socket too.
  Issue: `media-serve-client-abort-leaves-body-open` (debt, low; MMS + unit-media routes).
- **FW2 `08c4b7d3`** RED: `Tests 3 failed | 22 passed (25)`, `promise resolved "Buffer[ 73, 68,
  51 ]" instead of rejecting` (3-byte ID3), `"Buffer[ 255, 251, 144, 0 ]"`, the 11-byte ID3 body;
  12-byte guard passed. GREEN: gate 25 + routes 27, `Tests 52 passed (52)`. Issue
  `voicemail-greeting-format-normalization` gains item 3 (ID3-prefixed non-MP3; tiny bodies closed).
- **FW4 + FW6 `d82fad87`** FW4 RED (4 pins): `expected 200 to be 404` (recording served),
  `expected 'RECORDING-BYTES' to be 'GREETING-BYTES'`, webhook (i) prompt missing (recording
  played), (i2) `<Play>` not the fixed key. Harness projection alone: `2 failed | 2 passed`; with
  the consumers on the constant: `Tests 85 passed (85)`. Deviation: (i2) and the route "defense in
  depth" case are EXTRA pins (settings read swapped to hand back a foreign key) - the projection
  hides the constant-key change, which needed its own RED. FW6 (e3)/(e4) green on the real code
  (`12 passed | 46 skipped (58)`); RED by mutation, voice.ts sha256 OK after each:
  `AbortSignal.timeout(VOICEMAIL_GREETING_LOOKUP_BUDGET_MS)` -> (e4) `expected false to be true`,
  (e) still green; a lookup logging `offered` itself -> (e3) `expected true to be false`. The
  router holds `world.mediaStore` (the harness passes the object; voice.ts calls it per use).
- **FW3 + FW5 `1453c97f`** FW3 RED: `Tests 2 failed | 24 passed (26)`, `Unable to find an element
  with the text: The greeting file is missing...` at the post-refusal asserts (:218, :230). Fix:
  `brokenSrc` state, line derived, no effect. FW5 table (6 codes) green on the real map; dropping
  `file_too_large` -> `1 failed | 5 passed`, `Received: "Couldn't upload the greeting. Try
  again."` (hook sha256 OK). GREEN: block 26, VoiceSection 10. Deviation: added a verbatim pin of
  the six constants vs spec 4.7; the failed-Remove-in-dialog test already existed (kept).
- **FW7 `2bb3b8b6`** comments only: no route buffer; lib-storage holds <= one 5 MiB part.
- **FW8 `359cda92`** printed after FW3: endpoints `VoiceSection.tsx:95-128,177;
  useVoicemailGreeting.ts:92-112; VoicemailGreetingBlock.tsx:106-113`; terminal
  `VoiceSection.tsx:95-128,177; VoicemailGreetingBlock.tsx:72-89,114-118`; routes.test `Tests 24
  passed (24)`. Deviations: 95 = the ternary (old 93 was blank; a pure +1 shift gives 94); the
  endpoints string also cites the player behind VOICE_GETS' conditional audio GET (uncited before).
- **FW9 `cb56f148`** both missed calls from NAMED tenants. Deviation: no shared `createContact`
  fixture exists; local copy of voice-transcription.spec.ts:73-82. First call: `auto-text skipped
  - caller intake details already on file`; 0 sent, 0 unknown-SID ERRORs (S9 runs 2, 6: 2 each).
  Pre-existing (every S9 run): the second call's job starts after the next reseed, WARN refusal
  `conversation_not_found`, no send.
- **A1 `7fdaa59a`** `voicemail-greeting-concurrent-writes-unserialized` (improvement, low,
  deferred); the VersionId option also needs `s3:GetObjectVersion` (not granted). `npm run issues`
  EXIT=0 `[issues] 314 open, 180 closed, 494 total`; INDEX.md gitignored.

## Verify (final tree 7fdaa59a, bare, foreground)

- app named: `Test Files 6 passed (6)` / `Tests 196 passed (196)`.
- app sweep, 47 files (named + every world.settings / settingsRepo / /api/settings / presign /
  mediaObjects user + all voice*.test.ts): `Test Files 47 passed (47)` / `Tests 1666 passed | 1
  skipped (1667)` (staticSmoke no-dist diagnostic); 0 `[dynamoAdmin]`.
- dashboard `src/routes/settings src/api`: `Test Files 28 passed (28)` / `Tests 323 passed (323)`.
- e2e static `performance support/viewport.guard.test.ts`: `Test Files 18 passed (18)` / `Tests 472 passed (472)`.
- `npm run typecheck` EXIT=0; `npx eslint` on the 13 touched .ts/.tsx EXIT=0, no output; 0
  non-ASCII bytes in 616 added lines; no forbidden file touched.
- e2e 1 (FW9 content, pre-commit): `4 passed (18.9s)` EXIT=0 `.superpowers/gates/fw-e2e-1.log`.
- e2e 2 (cold, committed): `4 passed (19.0s)` EXIT=0 `.superpowers/gates/fw-e2e-2.log`; 0 level-50.
- e2e 3 + 4 neighbors: `24 passed (51.6s)` EXIT=0 `.superpowers/gates/fw-e2e-3-neighbors.log`; 6
  level-50 lines, all BEFORE the greeting spec began (last ...017993, spec from ...034430): 5
  unknown-provider-SID (neighbors' unknown-caller auto-texts) + 1 "NO inbound-voice-line holder"
  (a neighbor's deliberate case) - the classes in S9's `s9-session.log` (2 + 1).
- Teardown: `npm run e2e:stop` "no running session found"; lane 15 (10501/10511/10521/10531):
  `LISTENING on lane-15 ports: 0` (1922 TIME_WAIT only); no e2e node process of this worktree.
