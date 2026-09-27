---
id: media-serve-client-abort-leaves-body-open
title: MMS media and unit-media routes leave the S3 body open when the client leaves mid-stream (then log ERROR)
type: debt
severity: low
status: open
area: app/media-serve
created: 2026-09-27
refs: app/src/routes/api.ts:2400, app/src/routes/unitMediaServe.ts:73, app/src/routes/serveMediaObject.ts:106, app/test/serveMediaObject.test.ts
---

**Problem.** Two media-serving routes stream a media-store object with an
`'error'` listener plus a bare `object.body.pipe(res)`:

- `GET /api/messages/:providerSid/media/:idx` (inbound MMS media,
  `app/src/routes/api.ts:2400-2404`);
- `GET /unit-media/:unitId/:object` (unit photos, the non-CloudFront fallback,
  `app/src/routes/unitMediaServe.ts:73-77`).

When the CLIENT leaves mid-stream (a closed tab, a navigation away, a media
element that stops reading), `pipe()` only unpipes. The source - in
production the S3 GetObject response, holding a pooled SDK socket (default
`maxSockets` 50) - stays paused and open until S3 drops the idle connection.
That drop emits `'error'`, which each route logs at ERROR ("media stream
errored mid-flight" / "unit media: stream errored mid-flight"). ERROR lines
count toward the `hc-<env>-error-logs` and `-error-logs-sustained` alarms
(`infra/modules/observability/main.tf`), so a client that simply left can
feed an alarm, and each abandoned read holds a socket for the idle window.

Found by the voicemail-greeting code review (round 1, finding A2). That branch
fixed the SAME pattern in the shared helper `serveMediaObject` (the call
recording route and the greeting audio route), where the greeting player's
`preload="metadata"` read made it frequent, and pinned it in
`app/test/serveMediaObject.test.ts`. These two routes were out of that
branch's scope and are unchanged. Frequency here is lower: MMS images are
usually read whole, and in deployed environments CloudFront serves
`/unit-media/*` without reaching the app.

**Suggested fix.** Apply the helper's release to both routes: on `res`
`'close'`, when `!res.writableFinished`, call `object.body.destroy()` with NO
error (it releases the socket and emits no `'error'`), and do the same at once
when `res.destroyed` is already true before the pipe (a client that left
while the store was answering). A small shared function for the pipe step
(error listener + release + pipe) would let all four routes use one
implementation while the MMS and unit-media routes keep their own headers.
Pin each route with a client-abort test like `serveMediaObject.test.ts`: the
body ends destroyed with no error, and no ERROR line.
