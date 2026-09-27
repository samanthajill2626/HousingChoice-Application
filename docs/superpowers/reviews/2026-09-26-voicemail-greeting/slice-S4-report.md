# Slice S4 report - greeting routes, head abort signal, harness seams (plan Task 4)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context). Commit
`d23e21c0`: upload/remove/audio routes, MediaStore.head abort signal, harness head/presign
seams; the six named files only. Pre-edit grep: no other MediaStore impl changes (R1 holds).

## Gates (run bare from the worktree)

- RED (routes absent, seams absent): `Tests  25 failed | 4 passed (29)` - `expected 404 to
  be 403`, `non-JSON 404 response: <!DOCTYPE html>`, `Cannot read properties of undefined
  (reading 'abortSignal')`, `(reading 'add')`, `expected undefined to deeply equal [...]`.
  Guard RED (plan routes, no guard): `expected [] to have a length of 1 but got +0` at 5071ms.
- GREEN new files: `Test Files  2 passed (2)` / `Tests  33 passed (33)` (routes 27, head 6).
- Named set (+ settings, voiceRecording, mmsMedia*, mediaStore*): `Test Files  12 passed (12)`
  / `Tests  158 passed (158)`.
- Union with every presign/head/mediaObjects user (apiRoutes, emailMedia, publicIntake,
  messagesRepoRetryLineage.integration, relayFanOut, relayRetryLeg, sendMessage, staticSmoke,
  twilioStatusWebhook, twilioWebhookHarnessMediaIndex, unitsApiPhotos): `Test Files  23 passed
  (23)` / `Tests  615 passed | 1 skipped (616)` (staticSmoke no-dist skip); no `[dynamoAdmin]`.
- `npm run typecheck` exit 0. `npx eslint` on the six files: exit 0, no findings (none pre-existing).
- ASCII: 0 non-ASCII bytes in the new file and in every added line.

## Deviations from plan Task 4 (else identical)

1. N4: Content-Type passed straight; no `Readable`; `type VoicemailGreeting` and the test's
   imports merged. `parseContentLength` takes `string | undefined` (same dead branch as N4).
2. N5: the audit-failure case uses `failAuditAppendFor`; it also asserts the greeting is live.
3. Guard `if (req.destroyed) abortGate()` before `req.pipe(gate)`: a client gone during the
   async session check has already emitted 'close', so put() waited forever (RED above).
   Pinned by a mini-app case whose auth stand-in calls next() only after 'close'.
4. Added cases: 429 on the 11th upload; mid-upload disconnect (one WARN client_aborted + actor,
   no put, no ERROR); drain/reuse after all three refusals; both 500 ERROR paths (WARN probe
   goes red); the seams S5 consumes; "never logs the file name" proves the upload landed.
5. rawPut rejects on a non-JSON body (a throw inside 'end' hung RED 60 s as an uncaught error).
6. The accented name is built with `String.fromCodePoint(0xe9)`: the Write tool decoded
   the plan's backslash-u-00e9 escape into a literal two-byte e-acute.
7. Audio handler param named `req` (the plan's `_req` is used); comments reworded per item 8.

## Surprising (refusal wiring, Node 24.14.1, Windows loopback; every probe reverted)

8. Server-side `Connection: close` on a refusal: all four rawPut cases still PASS.
   `stream.pipeline(req, gate)`: they still PASS, the three gate refusals at ~6 s each -
   pipeline detaches a server request's socket before destroying req, so the 400 goes out,
   but the body is never read and the connection sits until the 5 s keep-alive timeout. So
   spec 4.3's "pipeline destroys req and its socket" is inaccurate here; the rule still holds
   for the drain reason. Destroy-after-finish: `read ECONNRESET` in the gate cases (caught).
   supertest's client `Connection: close`: ECONNRESET 5/5 (the plan's measurement reproduces).
   The new reuse case (`maxSockets: 1`, `reusedSocket`) fails on all three shapes (verified:
   `reusedSocket: false`, `read ECONNRESET` after ~6 s, `read ECONNRESET`).
9. An unread request body over ~16 KiB pauses the server socket, so a client FIN goes unseen
   until something reads; raw-socket teardowns use `closeAllConnections()` for that reason.
10. The 500 `upload_failed` path does not drain (spec 4.3 as written); if put rejects mid-body
    the JSON arrives but the connection is not reusable. Not changed; flagged.
