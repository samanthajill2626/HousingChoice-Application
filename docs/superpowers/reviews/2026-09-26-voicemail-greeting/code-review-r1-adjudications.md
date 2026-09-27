# Code review R1 - adjudications (build orchestrator)

Branch `feat/voicemail-greeting` @4efb04a3 (merge base main @0dafe3c1).
Reviewers, independent and parallel, opus:
- (a) spec conformance - `code-review-r1-conformance.md` (spec, plan, work map,
  worklist, slice reports in hand): VERDICT CONFORMS; 0 MUST-FIX, 2
  SHOULD-FIX (C1, C2 - both test-pin gaps, behavior probed correct), 6 NOTE.
- (b) adversarial, PLAN-BLIND by mandate - `code-review-r1-adversarial.md`
  (diff package + repo only; read nothing under docs/superpowers): 0
  MUST-FIX, 1 SHOULD-FIX (A1), 8 NOTE. It drove the upload route through the
  REAL S3MediaStore + lib-storage against a local fake S3 (one PutObject at
  exactly 5 MiB; zero S3 requests on 413 / 400 / client abort).

Gate context at review time (pre-review commit 4efb04a3): typecheck 0, smoke
0, gate 5 no new errors (one pre-existing error at the merge base), full e2e
EXIT=0 "289 passed (22.5m)".

Ruling vocabulary: ACCEPT (fix wave FWn) / REJECT (reason) / DEFER (handback
or issue). "Basis" names the spec clause that makes a NOTE worth fixing.

## Accepted - one fix wave (FW1-FW9)

| FW | findings | ruling and basis | required change |
|---|---|---|---|
| FW1 | A2 | ACCEPT. Basis: spec 4.10 - "a client abort ... is WARN/INFO (ERROR lines feed the alarms)". The helper leaves the store body paused and open when the client leaves; the eventual upstream reset logs ERROR. This feature makes it frequent: `preload="metadata"` fetches the greeting on EVERY Voice-tab view. | `serveMediaObject`: when `res` closes before finishing, destroy the store body (no error) so the pooled socket is released and no ERROR line follows a client that left; a genuine upstream failure while the client is still connected stays ERROR. Pin it with a test (client aborts mid-stream -> body destroyed, no ERROR). `voiceRecording.test.ts` stays unchanged and green (the recording route shares the helper and gains the same fix). File one `docs/issues/` entry for the SAME pattern in the MMS media route (`api.ts` ~2400) and the unit-media route (`unitMediaServe.ts` ~73), which this branch does not touch. |
| FW2 | A4, C5 | ACCEPT. Basis: spec 4.1 - the gate "holds back at most VOICEMAIL_GREETING_SNIFF_BYTES bytes until it has that many (or the stream ends)" and "on end with fewer bytes than the sniff needs it errors invalid_format"; the plan's code read "needs" per format (3 bytes for MP3), which admitted a 3-byte `ID3` body as a live greeting. The 12-byte reading is the spec's own constant and no playable greeting is under 12 bytes. | Gate `_flush`: a non-empty body shorter than VOICEMAIL_GREETING_SNIFF_BYTES errors `invalid_format` (0 bytes stays `empty`). Tests: 3-byte `ID3`, 4-byte frame sync, 11-byte -> invalid_format; a 12-byte ID3-prefixed body passes. Add the ID3-prefixed-non-MP3 sniff limitation to `docs/issues/voicemail-greeting-format-normalization.md`. |
| FW3 | A5, C6 | ACCEPT. Basis: spec 4.3 Concurrency - the record-without-object state is "rendered visibly (4.7) so it is repaired by a re-upload rather than found by a caller"; a refused Replace currently HIDES that line while the broken player stays. | The missing-file status clears only when the player's `src` changes (a successful upload / replace), never merely because a file was chosen. Tests: a client-refused and a server-refused Replace keep the line; a successful Replace clears it. |
| FW4 | A6 | ACCEPT. Basis: plan Review Focus 5 / spec 4.2 fixed-key rule - no route or webhook test can observe it today because the harness fake never projects. | The harness settings fake projects `voicemailGreeting` through `toVoicemailGreeting` on read (get and put), mirroring the real repo; the audio route and the webhook lookup use `VOICEMAIL_GREETING_S3_KEY` directly (defense in depth). Pins through the harness: a record naming a foreign key -> audio route 404 `greeting_not_found`, webhook `<Say>` with no HEAD and no greeting log line. |
| FW5 | C1 | ACCEPT (test pin for Review Focus 1). | Block-suite table test: `uploadVoicemailGreeting` rejecting with ApiError `unsupported_media_type` / `file_too_large` / `empty_file` / `media_storage_unavailable` / an unknown code renders the spec 4.7 message (endpoint called once); a failed Remove renders its fallback in the dialog. |
| FW6 | C2, A8 | ACCEPT (test pins for Review Focus 2). | founderTriage (e3): a HEAD that IGNORES its signal and RESOLVES ~150 ms after a 50 ms budget -> `<Say>`, no `<Play>`, one WARN; after ~300 ms still no `offered` line and no second WARN. Plus an abort-at-budget pin: capture the AbortSignal handed to `head` and assert it is already aborted when the 50 ms-budget response arrives (a signal wired to a longer timeout fails it). Prefer the captured-signal assertion over asserting `err.name`, which rests on timer ordering. |
| FW7 | A3 | ACCEPT (comment accuracy). Basis: spec assumption G. | The GreetingUploadGate docstring and the upload route's comment block state the real bound: the route holds no buffer; lib-storage holds the accepted greeting (at most one 5 MiB part) in memory before its single PutObject. |
| FW8 | C3, A9 (and the S8 report) | ACCEPT (citation hygiene). | `e2e/performance/routes.ts` Voice citations re-pointed at the live lines: VoiceSection.tsx's current ranges, `useVoicemailGreeting.ts`'s load/GET lines, and the terminal citation at the block's status lines. |
| FW9 | S9 report ("decision for you") | ACCEPT (e2e hygiene; both readings honor spec 5 step 2's intent - prove the greeting plays on a missed business-line call). Unknown callers get the missed-call auto-text; in 3 of 11 runs its SMS delivery receipts landed after the NEXT test's reseed and the app logged 2 ERROR lines ("status callback for unknown provider SID after retry"). | The e2e's missed calls come from KNOWN contacts created with the `createContact` fixture (the `voice-transcription.spec.ts` precedent: the intake gate withholds the auto-text from a named caller). Re-run the spec twice plus the voice neighbors. |

## Rejected / deferred

- A1 (SHOULD-FIX, CONFIRMED: PUT/DELETE leaves a record with no object; PUT/PUT
  leaves a record describing the other upload's bytes) - REJECT as a code
  change: the APPROVED spec 4.3 "Concurrency (single org, admin-only,
  accepted; the end states are named so nobody is surprised)" names BOTH
  interleavings and accepts them, with the missing-object state made visible
  in the dashboard (strengthened by FW3). The reviewer's two options are
  recorded for Cameron in the handback and in a filed issue (improvement,
  low, deferred): an in-process lock around [put + record SET] and [record
  REMOVE + delete] (cost: a stalled upload would hold the lock until Node's
  300 s requestTimeout, blocking Remove), or pinning the record to the
  PutObject VersionId.
- A7 (NOTE: the sanitizer keeps C1 controls, bidi overrides, zero-width
  characters) - DEFER to the handback: spec 4.1's rule (strip U+0000-U+001F,
  U+007F) is met; the name is admin-supplied, staff-facing, React-escaped, and
  rendered in its own blockified span, so an override cannot leak past it.
  Widening the strip class is optional hardening.
- C4 (NOTE: Replace reads "Uploading..." during a Remove) - REJECT: the
  button sits behind the aria-modal backdrop and its disabled state is
  correct; the closing render clears it.
- C7 (NOTE: spec 4.3's stated reason for banning stream.pipeline is
  inaccurate on Node 24 - the 400 IS written; the connection then sticks and
  resets because the body is never drained) - no code change; the rule holds
  (probe A: pipeline and no-drain copies both turn the reuse pin red) and the
  route comment already states the measured mechanism. Recorded for the
  handback; the approved spec text is left as is.
- C8 (NOTE: the 500 upload_failed path does not drain) - REJECT: as spec 4.3
  step 4 is written; the JSON still arrives, only connection reuse after a
  server fault is lost.

## Decisions changed

NONE of spec section 3. FW2 adopts the stricter of two readings of a spec 4.1
sentence (its own constant); FW9 changes a test mechanic, not a behavior.
Re-review: a FRESH reviewer (AUTO mode - the resume ban holds) with this file
and both R1 reports, charged first with what round 1 missed, then the fix
diff cold, then any adjudication it disputes, and last whether the fixes are
real.
