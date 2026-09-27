# Self-QA (Phase 5) - feat/voicemail-greeting

Build orchestrator, 2026-09-27 06:43-06:50 EDT. Code under test: app commit
aef90b91 (the fix wave's last code commit; everything after it is docs or
test-only). Screenshots (ignored run state): `.superpowers/qa/01..06-*.png`.

## Harness

- Hermetic lane 15 via `npm run e2e:session` (dashboard
  http://127.0.0.1:10511). `/__dev/ping` -> `dev: true`, `tablePrefix:
  hc-local-15-`, `appCommit: aef90b91`. Never the live :5174/:8080 stack.
- Driver: the Claude Playwright PLUGIN MCP (Chrome channel). The project MCP
  (`@playwright/mcp@latest`, bundled Chromium) now expects chromium-1246,
  which is not installed (1228/1237/1243 are); installing it is a download,
  so it was not done - flagged for Cameron. The plugin MCP only accepts the
  MAIN checkout's gitignored `.playwright-mcp/` as its file root, so the
  audio fixtures and screenshots were staged in `.playwright-mcp/vmg-qa/`
  there and removed afterwards (main checkout status clean before and
  after); its automatic page/console snapshots also land in that gitignored
  folder.
- Dev-login as `founder@example.com` (admin) and `va@example.com` (va).
- Fixtures: generated PCM WAVs (2 s and 3 s, 8 kHz sine), a 50 KB `.m4a`, a
  200 KB and a 3.6 MB M4A renamed `.mp3`, a 5.3 MB WAV.

## Walk and measurements

| # | state | result (measured) |
|---|---|---|
| 1 | Admin, no greeting (01) | h3 "Voicemail greeting", helper text verbatim, status "No greeting uploaded - callers hear the built-in prompt.", "Upload greeting". |
| 2 | Upload a 2 s WAV through the real file chooser (02) | "Greeting uploaded."; name; "Uploaded Sep 27, 2026 by founder@example.com"; Chrome DECODED the served audio: `readyState 4`, `duration 2`, `error null`. `preload="metadata"` issued ONE GET -> 206 through the Vite proxy. Audio route: 200, 32044 bytes, `audio/wav`, `Accept-Ranges: bytes`, `Cache-Control: private, max-age=3600`; `Range: bytes=0-11` -> 206, `Content-Range: bytes 0-11/32044`, body `RIFF....WAVE`. |
| 3 | Missed business-line call (unknown caller) via fake-twilio | fake recorded `voicemailGreeting: 'play'`, `voicemailGreetingFetchStatus: 200` (the fake fetched the presigned MinIO URL). App log: INFO "voicemail greeting offered" with `callSid` + `s3Key` only; 0 greeting log lines contain `X-Amz`; the uploaded file name appears 0 times in the whole app log. |
| 4 | Phone width 360 (03, 04) | `<main>` scrollWidth 345 = clientWidth 345 (0 overflow); player 297 px inside the block; Replace/Remove on one row. Replace with a 76-character name: name wraps to 2 lines at 297 px, 0 overflow; `?v=` changed and `duration 3` (the new file, not a cached one); "Greeting replaced.". Remove dialog: box 16-344 px in a 360 px viewport, dialog scrollWidth = clientWidth, `aria-modal="true"`, named "Remove voicemail greeting?"; Escape closes it and nothing is removed. |
| 5 | Refusals (desktop) | `memo.m4a`: client pre-check M4A message as an alert, NO PUT. 200 KB renamed M4A (`audio/mpeg`): PUT -> 400 (server sniff), the same M4A message as an alert. 5.3 MB WAV: "That file is over 5 MB. Trim or re-export it at a lower bitrate.", NO PUT. 3.6 MB renamed M4A: the APP answered 400 in 1 ms (its request log), but the Vite dev proxy logged `http proxy error` and handed the browser a 500, so the UI showed "Couldn't upload the greeting. Try again." - spec 4.3's KNOWN LOCAL-DEV LIMITATION (seen here as a proxy 500 rather than a raw reset); the route wiring was not touched. After all refusals the stored object was intact (MinIO HEAD: 48044 bytes `audio/wav` = the 3 s file). |
| 6 | Record without object (spec 4.3 interleave end state), simulated by deleting the lane's MinIO object (05) | On reload the player failed at LOAD (`preload="metadata"`, media error code 4) and "The greeting file is missing or can't be played. Upload it again." appeared within ~200 ms as a STATUS, with NO alert. A refused Replace (m4a) KEPT that line (fix wave FW3) next to the M4A alert. A missed call then got `<Say>` (`voicemailGreeting: 'say'`) and the app logged ONE WARN "voicemail greeting object missing" (`callSid`, `s3Key`). A successful Replace cleared the line ("Greeting replaced.", player `duration 2`). |
| 7 | Remove | Dialog -> Remove -> "Greeting removed." + the empty state + "Upload greeting"; audio route 404 `{"error":"greeting_not_found"}`; MinIO HEAD NotFound; INFO "voicemail greeting removed". The next missed call: `voicemailGreeting: 'say'` and ZERO greeting log lines for it (assumption F). |
| 8 | VA with a greeting set (06) | Read-only block; helper ends "An admin can upload or change it."; name, date, player (`duration 3` - a VA can play it); no buttons and no file input in the block; 0 alerts on the page. A VA PUT -> 403 `{"error":"forbidden"}`; DELETE -> 403. |

## Sub-threshold observations (not blocking; for Cameron's eye)

1. The missing-file line (row 6) is plain text. It marks a state in which
   callers hear the computer voice; spec 4.7 asks only for `role="status"`,
   so a warning color would be optional polish.
2. The sr-only file input is an invisible tab stop after the visible
   buttons - the repo's own EmailComposer/Timeline pattern does the same.
3. In local dev, StrictMode's double mount aborts the block's first
   `GET /api/settings` (ERR_ABORTED in the network panel) - dev-only.

## Teardown

`npm run e2e:stop`: launcher 57272 stopped, lane 15 tables dropped, lease
released; 0 listeners on 10501/10511/10521/10531. QA fixtures removed from
both `.playwright-mcp/` folders; the MCP page closed.
