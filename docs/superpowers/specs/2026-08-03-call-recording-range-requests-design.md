<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-04).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Call-recording playback: HTTP Range support (seekable audio)

Date: 2026-08-03
Status: APPROVED (design locked with Cameron 2026-08-03)
Branch: feat/call-recording-range (cut from main @10088005)

## 1. Problem

A call recording in the contact timeline plays and pauses, but the scrubber
cannot be moved. Dragging it does nothing; the playhead snaps back. This
affects every founder-bridge call recording AND every platform voicemail,
which are the two things a navigator most wants to skim rather than sit
through end to end.

## 2. Root cause (verified, not inferred)

`GET /api/calls/:callId/recording` (app/src/routes/api.ts:1529) always
answers `200` with the entire object body. It never sets `Accept-Ranges`,
never reads `req.headers.range`, and never answers `206 Partial Content`.
A repo-wide search for range handling (`Range`, `Accept-Ranges`, `206`)
across app/src returns no hits in any serving route - not this one, not the
MMS media route, not unit-media serving.

Browsers treat a media resource whose response carries no `Accept-Ranges`
and cannot answer a range request as NON-SEEKABLE: `HTMLMediaElement.seekable`
stays empty (or collapses to the already-buffered span), so the native
control bar renders a scrubber that refuses to move. Play and pause still
work, which is exactly the reported symptom. Safari and iOS are stricter
than Chrome here and can degrade further on range-less media.

The Web Audio mono downmix in `MonoAudio`
(dashboard/src/routes/contact/Timeline.tsx:583) is NOT implicated;
`createMediaElementSource` does not affect seeking.

## 3. Goal and non-goals

GOAL: the native scrubber on the existing `<audio controls>` player seeks
correctly for both bridge-call recordings and voicemails, in the hermetic
dev stack and behind CloudFront, with no dashboard code change.

NON-GOALS (explicitly ruled out by Cameron on 2026-08-03):

- Exposing `recording_duration` on the timeline API, or rendering any
  duration next to the player. Duration appears from the native controls
  once playback starts; that is accepted.
- Changing `preload="none"`. No call card may issue a request before the
  user presses play. A timeline with N call cards still makes ZERO audio
  requests at render.
- Any change to `MonoAudio`, the CallCard markup, the timeline API shape,
  or any dashboard file. The dashboard diff for this change is EMPTY.
- Range support for the MMS media route or unit-media serving. Both serve
  images, which never seek.

## 4. Approach: pass the Range header through to S3

The client's `Range` header is forwarded verbatim to S3's `GetObjectCommand`,
and S3's partial response is mirrored back to the client. S3 owns range
parsing, clamping, suffix-range semantics, and unsatisfiable-range detection
- all of which are RFC 7233 edge cases we would otherwise reimplement and
get subtly wrong. MinIO (dev and e2e) implements the same semantics, so the
hermetic stack behaves like production.

### Alternatives rejected

- **Parse and validate the range ourselves in Node, then request exact byte
  offsets from S3.** More code and more test surface for no behavioral gain;
  hand-rolling suffix ranges, open-ended ranges, and EOF clamping is pure
  downside when S3 already does it.
- **Redirect the player to a presigned S3 URL.** Ranges would work natively
  and the app would stop proxying bytes. REJECTED on the documented PII
  posture at app/src/routes/api.ts:1522-1528: recordings are PII and must
  never transit a public or presigned URL - the bytes stay behind the
  session gate. This constraint is not negotiable in this change.

## 5. Design

### 5.1 MediaStore seam (app/src/adapters/mediaStore.ts)

`getStream` gains a second, OPTIONAL parameter:

    getStream(key: string, opts?: { range?: string }): Promise<MediaObject | undefined>

`MediaObject` gains one optional field:

    contentRange?: string;   // S3's ContentRange, e.g. "bytes 0-1023/98765"

DELIBERATE DEVIATION from the intake sketch: no separate `partial` boolean.
The presence of `contentRange` IS the partial signal. Two fields that encode
one fact can disagree; one cannot.

Both additions are optional, so every existing `MediaStore` test double
(app/test/apiRoutes.test.ts:130, :368, :474; app/test/unitMediaServe.test.ts:31;
app/test/helpers/twilioWebhookHarness.ts:2381) keeps satisfying the interface
with no edit - a function declared with fewer parameters remains assignable.

`S3MediaStore.getStream` forwards `opts.range` as the `Range` param on
`GetObjectCommand` and surfaces `out.ContentRange` on the returned
`MediaObject`. Its existing absent-object contract is unchanged: `NoSuchKey`
/ `NotFound` / HTTP 404 still return `undefined`.

New exported error type in the same module:

    export class RangeNotSatisfiableError extends Error

`S3MediaStore.getStream` throws it when a range WAS requested and S3 reports
the range unsatisfiable (`InvalidRange`, or `$metadata.httpStatusCode === 416`).
Every other error keeps bubbling unchanged. A typed error keeps the seam
explicit and unit-testable without widening the return type for the three
callers that never pass a range.

### 5.2 Route behavior (app/src/routes/api.ts, recording endpoint only)

`Accept-Ranges: bytes` is set on EVERY successful response, including the
plain `200`. This header alone is what tells the browser the resource is
seekable - it is what unblocks the scrubber before any range request is ever
issued, and it is the single most important line in this change.

A request's `Range` header is forwarded only when it is a single, well-formed
byte range, matched against:

    /^bytes=(\d+-\d*|-\d+)$/

| Request `Range`            | Behavior                                              |
|----------------------------|-------------------------------------------------------|
| absent                     | `200`, full body, `Accept-Ranges: bytes`              |
| `bytes=0-1023`             | forwarded -> `206` + `Content-Range` + part `Content-Length` |
| `bytes=1024-`              | forwarded -> `206` (open-ended, S3 clamps to EOF)     |
| `bytes=-500`               | forwarded -> `206` (suffix range)                     |
| `bytes=0-10,20-30` (multi) | NOT forwarded -> full `200` (RFC 7233 permits ignoring)|
| `items=0-10` (other unit)  | NOT forwarded -> full `200`                           |
| malformed (`bytes=`, `bytes=-`) | NOT forwarded -> full `200`                      |
| unsatisfiable (past EOF)   | `416` + `Content-Range: bytes */<size>`               |

On the `206` path the response sets `Content-Range` from S3's value and
`Content-Length` from S3's `ContentLength` (the PART length, not the object
length). `Content-Type` handling is unchanged.

DEFENSIVE DEGRADE: if a range was forwarded but the store returns no
`contentRange`, the route answers a normal `200` with the full body rather
than a `206` with a missing header. A degraded-but-correct full response
beats a malformed partial one.

416 path: catch `RangeNotSatisfiableError`, best-effort `mediaStore.head(key)`
for the object size, and answer `416` with `Content-Range: bytes */<size>`.
If `head` fails or returns no size, answer `416` without `Content-Range` -
best-effort, never a 500. This is the only new S3 call in the design and it
occurs ONLY on a malformed-client error path.

Ordering is preserved: the existing 404 branches (call not found, no
`recording_s3_key`, no media store configured, object absent) all run BEFORE
any range handling, so a range request for a missing recording still 404s
rather than 416s.

### 5.3 Deployment path (verified, no infra owed)

The CloudFront API behavior uses the managed `AllViewerExceptHostHeader`
origin-request policy and `CachingDisabled` cache policy
(infra/modules/cloudfront/main.tf:149-150). `AllViewerExceptHostHeader`
forwards every viewer header except Host, so `Range` reaches the origin and
the `206` passes back untouched. NO terraform change, NO deploy-time
configuration, NO post-merge infra is owed by this change.

## 6. Non-regression assertions (carry into review)

- A VOICEMAIL call card must keep rendering BOTH the recording player AND
  the collapsed transcript disclosure. `CallCard`
  (dashboard/src/routes/contact/Timeline.tsx:647-667) gates the player on
  `recording_s3_key && call_sid` and the transcript on `transcript_status` /
  `transcript`, with NO branch on `call_outcome` - a voicemail takes the same
  path as a bridge call today. The transcript stays inside `<details>`: shown,
  never auto-expanded. This change must not disturb it, and the dashboard
  diff being empty is the proof.
- A MASKED (relay-pool) call still exposes no recording and no transcript.
  The masked suppression lives upstream in contactTimeline.ts:413-416 and in
  `persistViTranscript`; range support must not create a new read path around
  it. The route's own 404 branches are untouched and still run first.
- The endpoint stays AUTH-ONLY behind `requireAuth` + session. Range support
  adds no new unauthenticated surface.
- No recording content, and no `Range` value, appears in any log line.

## 7. Testing

Unit (extend the existing `describe('GET /api/calls/:callId/recording ...')`
block at app/test/voiceRecording.test.ts:338):

1. no `Range` -> `200`, full body, `Accept-Ranges: bytes` present.
2. `Range: bytes=0-3` -> `206`, `Content-Range` present, `Content-Length`
   equals the part length, body is the requested slice.
3. suffix and open-ended ranges -> `206`.
4. multi-range and malformed ranges -> `200` full body (NOT 416, NOT 206).
5. unsatisfiable range -> `416` with `Content-Range: bytes */<size>`.
6. a range request for an absent recording still `404`s (ordering guard).

Adapter (extend app/test/mediaStore.test.ts): `getStream(key, {range})`
puts `Range` on the `GetObjectCommand` input and surfaces `ContentRange`;
an `InvalidRange` S3 error becomes `RangeNotSatisfiableError`; a `NoSuchKey`
error still returns `undefined`.

Live self-QA: `npm run e2e:session`, dev-login, reseed full, open a contact
with a call recording, press play, then DRAG the scrubber and confirm the
playhead moves and audio resumes from the new position. Confirm the response
carries `Accept-Ranges` and that a seek produces a `206`. Repeat on a
voicemail card and confirm its transcript disclosure is still present and
still collapsed.

Gates: `npm run typecheck` + `npm test` bare, from the worktree. Per the
profile's small-fix lane, bulk e2e rides the next checkpoint unless this
runs the full pipeline lane, in which case `timeout 1500 npm run e2e` from
the worktree too.

## 8. Risks

- LOW: an S3-compatible store that answers a range request WITHOUT
  `ContentRange` would fall into the defensive degrade and serve a full 200
  (non-seekable, i.e. today's behavior). Not a regression.
- LOW: `head()` on the 416 path adds one S3 call, only on a malformed-client
  request. No hot-path cost.
- NONE expected for existing callers: the two other `getStream` call sites
  pass no `opts` and see byte-identical behavior.

## 9. Post-merge obligations

None. No schema, no terraform, no secrets, no new dependency, no env var,
no dashboard build change.
