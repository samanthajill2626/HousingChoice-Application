# Slice S3 report - extract serveMediaObject (plan Task 3)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context).
Scope held to the two named files; `app/test/voiceRecording.test.ts` untouched.
Commit `ac60adce` refactor(media-serve): extract serveMediaObject from the
call-recording route (behavior unchanged; greeting audio reuses it).

## Gates (run bare from the worktree)

- Guard BEFORE: `Test Files  1 passed (1)` / `Tests  36 passed (36)`.
  Guard AFTER: `Test Files  1 passed (1)` / `Tests  36 passed (36)`. Identical.
- AFTER with the MMS media route files (`mmsMedia.test.ts` 13 + `mmsMediaRoutes.test.ts` 8,
  baseline `Tests  21 passed (21)`): `Test Files  3 passed (3)` / `Tests  57 passed (57)`.
- `npm run typecheck` exit 0. `npx eslint` on both files: exit 0, no findings
  (api.ts on the base commit was also clean, so F1 left nothing unused).
- Extra: `logCallSiteGuard.test.ts` (scans all app/src, the new file included) `Tests  3 passed (3)`.
- ASCII: 0 non-ASCII bytes in the new file and in the 25 added api.ts lines.

## Equivalence (removed span dedented, 6 literals swapped for option names, diffed against the helper body: the ONLY difference is range parsing moving into `singleByteRange` plus the options destructure)

- Range regex `/^bytes=(\d+-\d*|-\d+)$/` byte-identical (od-compared), same string-only `.trim()`.
- getStream: `{ range }` only when a range survives, else the 1-arg call (unchanged).
- 416: `Accept-Ranges: bytes`, `Content-Range: bytes */<size>` only if the best-effort head has a size, `range_not_satisfiable`.
- Other store errors: rethrown; the helper rejects, the handler awaits it -> the same Express 5 error path.
- 404: `{ error: 'recording_not_found' }` + WARN `{ callSid }` 'recording key present but object not found in the media store'.
- Content-Type `object.contentType ?? 'audio/mpeg'`; Accept-Ranges `bytes` on every success; Cache-Control `private, max-age=3600`.
- Content-Length only when defined; 206 + Content-Range only when a range was forwarded AND the store returned one.
- INFO `{ callSid }` 'streaming founder-bridge recording to the dashboard'; ERROR `{ err, callSid }` (same key order) 'recording stream errored mid-flight'.
- Stream error -> log + `res.destroy(err)`, then `object.body.pipe(res)`; header set order unchanged. pino's default mixin merge never mutates the shared `logContext`.

## Divergences (else identical to plan Task 3 code; F1 applied, D1 honored)

1. Comments carried from the live handler where the plan condensed them (no code change): the range-fallback, "416 still beats a 500", "404 rather than a hanging stream" and scrubber-symptom clauses in the helper; the full 10-line Cache-Control rationale (plan: a 5-line cut) and the nosniff note at the call site (api.ts:2294-2305).
2. getStream ternary keeps the live 3-line wrap (plan: one line) so the line diff is exact.
3. Two JSDoc additions for S4: `messages` (which level logs which text) and `serveMediaObject` (resolves once piped - never touch `res` after; non-range store errors reject).
4. F1 removed both imports outright (the plan said "only if eslint reports them"); import added after `createEmailMediaRouter`.

Worth an eye (not blocking): `docs/issues/authenticated-mms-media-browser-cache.md` refs `api.ts:2387, :2292` were stale BEFORE S3 (live were :2437/:2341); now api.ts:2306 (recording) and :2395 (MMS). Out of scope, untouched.
