# Code review R2 - fresh reviewer (round 1's misses, the fix diff cold, adjudications, FW1-FW9)

Branch `feat/voicemail-greeting` @aef90b91 (merge base main @0dafe3c1).
Reviewer: Claude Opus 5.5 (1M context), 2026-09-27. A FRESH reviewer: I did
not raise the round-1 findings.
Inputs: the two R1 reports, `code-review-r1-adjudications.md`,
`fix-wave-r1-report.md`, `.superpowers/review/diff-package-r2-fixwave.txt`,
`.superpowers/review/diff-package-r2-full.txt`, the approved spec, AGENTS.md,
and the repository itself (whole-app greps, not the diff alone).

## Verdict

**No MUST-FIX and no SHOULD-FIX.** The fix wave holds up:

- All nine FWs are real.
- I reverted the four that are cheap to revert (FW1, FW2, FW3, FW4) against
  the pre-fix code, and each pin goes red.
- FW1 was also proven on production-shaped store bodies: a real
  `http.IncomingMessage`, and the same body wrapped in the SDK's
  `ChecksumStream`. Both release the upstream socket with no ERROR.
- Normal streams are untouched: full 200s over a reused keep-alive socket, a
  3 MiB slow reader under backpressure, a full 206, and HEAD.

My fresh sweep of every consumer and mutator of the state this branch touches
found **no new defect in production code** (section 1 lists what was checked).

What remains is three NOTEs on the fix diff and one mild adjudication
challenge:

- F1: one FW4 route pin rests on only one of its two assertions.
- F2: the FW7 memory comment leaves out the transient copy lib-storage makes.
- F3: the new concurrent-writes issue under-describes the race window.
- C7: add a one-line erratum to the spec when it is frozen.

From the code-review standpoint the branch is merge-ready. The NOTEs are
optional.

## Evidence run by this reviewer

Every command ran bare in the worktree. I started no e2e, Playwright,
e2e:session, dev server or stack, did not run the whole `npm test`, and killed
no process.

**Test files, all green:**
- app, `test/serveMediaObject.test.ts` and `test/voicemailGreeting.test.ts`: `Test Files 2 passed (2)`, `Tests 28 passed (28)`.
- app, `test/voicemailGreetingRoutes.test.ts`, `test/founderTriage.test.ts`, `test/voiceRecording.test.ts`, `test/settings.test.ts` and `test/mediaStore.head.test.ts`: `Test Files 5 passed (5)`, `Tests 171 passed (171)`.
- dashboard, `VoicemailGreetingBlock.test.tsx`, `VoiceSection.test.tsx` and `voicemailGreeting.client.test.ts`: `Test Files 3 passed (3)`, `Tests 41 passed (41)`.
- fake-twilio, `twimlInterpreter.test.ts` and `callEngineVoicemail.test.ts`: `Test Files 2 passed (2)`, `Tests 18 passed (18)`.

**Typecheck:** `npm run typecheck` on the clean tree, after every probe was deleted: EXIT=0 (all workspaces).

**Probes:** nine throwaway files, each run with single-file vitest and then
deleted. Results are cited below; the list is under "Probe hygiene".
- `zz-review-probe-fw1`: FW1 on normal streams, plus the pre-fix helper.
- `zz-review-probe-fw1-real`: FW1 with an IncomingMessage body and a ChecksumStream body.
- `zz-review-probe-fw2`: the pre-fix gate from `git show 6b418954`.
- `zz-review-probe-fw3`: the current block test file run against the pre-fix block.
- `zz-review-probe-fw4`: the pre-FW4 harness read, and the pre-FW4 settings router.
- `zz-review-probe-e3-margin`: (e3)'s timing margin.

## 1. What round 1 missed - new findings

**None, at any severity, in production code.**

This sweep goes beyond round 1's "swept and clean" list. Each item names what
I checked and why it holds.

1. **Writers of the fixed key.** Every presigned-POST grant pins an EXACT, server-minted key:
   - the policy is set at `mediaStore.ts:302-323`;
   - the keys are minted at `emailMedia.ts:79` (`email-media/<userId>/<uuid>`), `mmsMedia.ts:82` (`uploads/<uuid>`) and `units.ts:542` (the unit prefix).

   So no non-admin path can write `settings/voicemail-greeting`. The only other bucket mutator is the operator script `scripts/wipe-dev-data.mjs`. It is dev only, and it wipes the tables and every object version together, so it cannot leave a record without its object.
2. **Streaming sites.** `pipe(res)` appears only at `api.ts:2404`, `unitMediaServe.ts:77` and `serveMediaObject.ts:111`. The new issue file names the first two. `emailMedia.ts` has no serve route.
3. **A second voicemail path.** `voice.ts:1961` is the ONLY `voice.voicemail_prompt` / `reply.record` site in `app/src`. No quiet-hours or no-holder path can skip the greeting.
4. **Settings caching.** `voice.ts` reads the repo on every call (`:397`, `:850`, `:2436`), with no cache in between. `getOrgSettings` is an eventually consistent GetItem, so for about a second after an upload or remove the webhook can read the previous record. Every such read ends in `<Say>` or the spec's named section-1 residual, never in a broken call.
5. **A late lookup.** Suppose the settings read resolves after the budget:
   - it calls `head` with an already-aborted signal, and the SDK refuses before it sends anything;
   - the rejection is swallowed by `withTimeout` (`voicemailGreeting.ts:183`).

   The FW4 early `absent` return (`voice.ts:398`) keeps the no-greeting path free of any S3 call.
6. **FW1 and pooled sockets.** Node's client `responseKeepAlive` sets `req.res.socket = null` before it frees a socket. So `body.destroy()` on an S3 body that has already ENDED can never destroy a socket that was handed to another request. Only an incomplete body reaches its socket, and that is exactly the leak being fixed.
7. **Log lines outside the helper.** `requestLogger.ts:56` logs on `'finish'` only. An aborted upload or an abandoned audio read therefore writes no line of its own, and nothing elsewhere undoes FW1's "no ERROR for a client that left".
8. **Traces.** Only URL attributes are hooked (`otel.ts:90-127`, `:193`), and no request headers are captured. `x-greeting-file-name` never reaches a span.
9. **Unknown callers after FW9.** In `founderTriage.test.ts:608-612`, `seedRingingBridgeWith` defaults the caller to `{ type: 'unknown' }`, and the run enqueues `call.missedAutoText`. So the greeting TwiML on an UNKNOWN caller's miss is still pinned at unit level, and the e2e's switch to known callers loses no coverage.
10. **e2e residue.** The spec file's last test (the VA test) reseeds before it runs and uploads nothing. The greeting record therefore never outlives the file. The MinIO object does, unreferenced, which assumption D accepts.

## 2. The fix diff, reviewed cold

### Per fix: what I tried to break, and the result

**FW1 (`serveMediaObject.ts:94-111`)** - holds.
- **Normal streams are untouched** (probe fw1). I ran:
  - two full 3 MiB 200s over one keep-alive agent, where the second reuses the socket;
  - a 3 MiB slow reader, pausing 5 ms per chunk under backpressure;
  - a 206 read in full;
  - a HEAD.

  Every byte arrived, no body was destroyed early or errored, and there was no level-50 line.
- **No double-handling.** On a genuine upstream error, the handler at `:90-93` logs one ERROR and destroys `res`. The release then runs on an already-destroyed body, which is a no-op.
- **The `res.destroyed` pre-check** (`:110`) covers a client that left while `getStream` was in flight. Node sets `destroyed` in the same step that emits `'close'`, so no gap exists between the two.
- **Recording route:** unchanged beyond the leak fix. `voiceRecording.test.ts` is untouched and passes 36/36.
- **Production shapes** (probe fw1-real). A body that is a raw `http.IncomingMessage` is released, and the upstream socket closes with no ERROR. The same holds with the `@smithy/core` `ChecksumStream` wrapper: its `_destroy` removes its source listeners and destroys the source, so the socket is released with no ERROR.

**FW2 (`voicemailGreeting.ts:127-144`)** - holds.
- **No valid upload is refused.** WAV already needed 12 bytes, and the smallest real MPEG frame is larger than 12 bytes.
- **No path skips the check.** The gate can end cleanly only through `_transform` having verified 12 or more bytes. `_flush` refuses everything else, and the route's pre-checks only refuse more.
- **Boundary** (probe fw2). A 12-byte body split 1+11 or 11+1 passes byte-exact, and so does a full MP3 delivered one byte at a time.

**FW3 (`VoicemailGreetingBlock.tsx:36`, `:54-56`, `:112`)** - holds.
- The line is keyed on the src that errored.
- An error event for the OLD src cannot arrive after the src changes: the media load algorithm drops queued media-element tasks.
- The successful-Replace test also guards against over-correction: an error on the NEW src shows the line again.

**FW4** - holds.
- **The harness projection** (`twilioWebhookHarness.ts:2312-2316`) hides nothing else. Every other field comes through `...rest`, which is the same shallow copy as the old `{ ...settings }`.
- **The route tests** still read the RAW `world.settings` for the stored record (for example `voicemailGreetingRoutes.test.ts:474`), so a route regression in the stored `s3Key` or `contentType` stays visible.
- One pin is weaker than it looks; see F1.

**FW6** - holds.
- **(e3) (`founderTriage.test.ts:1280`) is not vacuous.** The late head goes on to presign (`mediaPresigns` has length 1), and no `offered` line is logged.
- **(e4) (`:1318`) is deterministic.** The lookup builds `AbortSignal.timeout(50)` before `withTimeout` arms its own 50 ms timer (`voice.ts:423`). Both sit in the same Node timer list, so the signal fires first.
- **(e3)'s margin** (probe e3-margin). The in-process response is read in the same event-loop turn in which it is written. A stall of 60 or 110 ms, injected 2 ms after the answer, did not flip `lateHeadResolved`. Flipping it needs a stall of 100 ms or more inside that single turn, so I see no flake window worth a finding.

**FW9** - holds. The lookup is caller-independent: `offerVoicemailGreeting` takes only the callSid. Coverage of unknown callers is item 9 of section 1.

**The two new issue files.** Both follow the schema in `docs/issues/README.md` (the type, severity and status values). I verified every ref:
- `settings.ts:366`, `:411` and `:436`;
- `api.ts:2400-2404`;
- `unitMediaServe.ts:73-77`;
- `serveMediaObject.ts:106`;
- the `MediaObjects` statement at `infra/modules/ec2/main.tf:66-72`, which indeed lacks `s3:GetObjectVersion`.

### F1 - NOTE - CONFIRMED - FW4's route pin rests on only one of its two assertions

- **Where:** `app/test/voicemailGreetingRoutes.test.ts:583`, the test "a record naming a FOREIGN key (a call recording) is no greeting: 404 greeting_not_found, never the recording bytes".
- **Scenario:** revert the harness projection so `getOrgSettings` returns the raw map again, and keep the post-FW4 route.
  - The audio GET STILL answers 404 `greeting_not_found`.
  - It gets there through `serveMediaObject`'s object-missing branch, not the projection. `settings.ts:467` streams the constant key, and the test stores no object at that key, so the helper logs WARN "record present but object not found" and answers 404.
  - Only the second assertion (`GET /api/settings` carries no greeting) goes red.
- **Evidence:** probe fw4, case 1. Under the pre-FW4 read, the first assertion passes and `settings.voicemailGreeting.s3Key` equals `recordings/CA1/RE1`.
- **Minimal fix:** also store an object at the FIXED key in this test. The 404 then becomes reachable only through the projection; with the projection reverted, the route would serve 200 with the fixed-key bytes. Alternatively, assert no level-40 line.

### F2 - NOTE - CONFIRMED - FW7's memory comments drop the transient copy round 1 measured

- **Where:** `app/src/lib/voicemailGreeting.ts:86-89` and `app/src/routes/settings.ts:307-310`. Both say lib-storage holds "at most one 5 MiB part".
- **Evidence:**
  - In lib-storage 3.1070.0, `getChunkStream` (`node_modules/@aws-sdk/lib-storage/dist-cjs/index.js:101-105`) yields the last part as `Buffer.concat(currentBuffer.chunks)` while the chunk list is still referenced.
  - The transient peak per in-flight upload is therefore about twice the file, roughly 10 MiB at the cap.
  - Round-1 A3 recorded this ("plus a concat copy"). The FW7 text dropped it, although FW7's whole purpose was to make the memory statement accurate.
- **Minimal fix:** append "(plus a transient concatenated copy while the single PutObject is built)" to both comments. The rest matches the wording of spec assumption G.

### F3 - NOTE - CONFIRMED (by enumeration) - the concurrent-writes issue under-describes the race window

- **Where:** `docs/issues/voicemail-greeting-concurrent-writes-unserialized.md:18-20`, which reads "two admin writes that land inside one put-to-record window".
- **Evidence:** consider the six orders of PUT (put, then SET) against DELETE (REMOVE, then delete).
  - Four of the six end with a record and no object.
  - Two of those four START with the DELETE: REMOVE, put, SET, delete; and REMOVE, put, delete, SET.
  - In those two, the window is the DELETE's remove-to-delete gap, not the upload's put-to-record gap.
- **Why only a NOTE:** the end state is the same one spec 4.3 names, and the issue's option 1 already locks [REMOVE + deleteObject], so the remedy is unchanged.
- **Minimal fix:** reword to "inside one put-to-record or remove-to-delete window".

## 3. Adjudication challenges

- **C7 - a mild challenge (NOTE).** The adjudication leaves spec 4.3 step 4's rationale as it is. That rationale says `stream.pipeline` destroys `req` "so the 400 could never be written", and that is falsified: the 400 IS written. The rule itself is right, and the route comment (`settings.ts:311-318`) states the measured mechanism. But the spec is the design record a maintainer reads before "simplifying" to `pipeline`. When they see the 400 arrive, the stated reason fails in front of them and invites exactly that regression. Proposal: when the spec is stamped historical, add one erratum line pointing at the measured mechanism (a stuck, then reset, keep-alive connection). This is docs only and changes no decision.
- **A1 - agree** (reject as a code change). Spec 4.3 names both end states, and FW3 keeps the record-without-object state visible. F3 above only corrects how the filed issue describes the window.
- **C8 - agree, with added evidence.**
  - lib-storage yields its only part (`lastPart`) only after the body's async iteration completes (`dist-cjs/index.js:87-105`), and the single PutObject is sent only then.
  - So every S3-side failure that reaches the 500 `upload_failed` path happens after the request body has been fully consumed, and nothing is left to drain.
  - An unread body could remain only after a synchronous throw inside `put` before it reads anything, and no such throw exists.
- **A7, C4 - agree.**
  - A7: the sanitizer meets spec 4.1. The name is admin-supplied and rendered as its own flex item, so an override is contained to the name itself.
  - C4: the button is behind the aria-modal backdrop, and the closing render clears the label.

## 4. FW1-FW9 verification

| FW | real / plausible / not fixed | pinning test | would it FAIL with the fix reverted? |
|---|---|---|---|
| FW1 | REAL | `serveMediaObject.test.ts:65` (client leaves mid-stream), `:91` (client left during getStream), `:115` (upstream error stays ONE ERROR) | YES, proven: with the pre-fix helper (probe fw1), both leave cases keep the body OPEN after 300 ms (`destroyed false`), and a later upstream reset logs 1 ERROR. The implementer's RED run agrees: `Tests 2 failed / 1 passed`. The production-shaped probe is green with the fix. |
| FW2 | REAL | `voicemailGreeting.test.ts:122` (3-byte ID3, 4-byte frame, 11-byte ID3 -> invalid_format, zero bytes pushed), `:129` (12 bytes pass) | YES, proven: the pre-fix gate (`git show 6b418954`) ACCEPTS all three bodies byte-exact (probe fw2). |
| FW3 | REAL | `VoicemailGreetingBlock.test.tsx:210` (client-refused Replace), `:221` (server-refused), `:233` (successful Replace clears the line; a new-src error shows it again) | YES, proven: the current test file run against the pre-fix block gives `2 failed / 1 passed`. `:210` and `:221` fail with "Unable to find ... greeting file is missing"; `:233` passes, as it should, since it guards against over-correction. |
| FW4 | REAL (see F1) | routes `:583` (foreign key -> 404 and GET omits it), `:594` (defense in depth); webhook (i) `founderTriage.test.ts:1376`, (i2) `:1389` | Routes: YES, proven (probe fw4). The pre-FW4 route (`key: greeting.s3Key`) serves `RECORDING-BYTES`, so `:594` is red. The pre-FW4 harness read makes `:583` red on its GET assertion only (F1). Webhook (i)/(i2): not re-run as a revert (it needs a mutated `voice.ts`). By reading, (i2) asserts `mediaHeads` and `mediaPresigns` equal the fixed key, which the old `greeting.s3Key` reads fail. The implementer's RED lines are consistent with that. |
| FW5 | REAL | `VoicemailGreetingBlock.test.tsx:285` (six server codes, exact `textContent`, endpoint called once), `:295` (the copy verbatim) | Not reverted by me. By reading, exact equality plus called-once means a dropped or swapped map entry fails. The implementer's mutation (drop `file_too_large`) gives `1 failed / 5 passed`. |
| FW6 | REAL | (e3) `founderTriage.test.ts:1280`, (e4) `:1318` | Not re-run as a mutation; that needs a mutated `voice.ts`. By reading: (e4) fails for a signal wired to any longer timeout, or for none (`captured` undefined, or not yet aborted at the ~50 ms response). (e3) fails if the lookup logs `offered` itself. The implementer's mutations produced exactly those failures. My margin probe found no flake window. |
| FW7 | REAL (comment accuracy; see F2) | none (comments) | n/a |
| FW8 | REAL | `routes.test.ts` checks format only | Verified at HEAD: `VoiceSection.tsx:95` is the ternary and `:177` the field label; `useVoicemailGreeting.ts:92-112` is `load` plus the effect; `VoicemailGreetingBlock.tsx:106-113` is the `<audio>`; `:72-89` the loading, error and empty states; `:114-118` the missing-file line. |
| FW9 | REAL | `voicemail-greeting.spec.ts:89` (`createContact`), `:164` and `:180` (known callers) | Not re-run: e2e is barred to this reviewer. The claim holds because the lookup is caller-independent, and unknown callers stay covered at unit level (section 1, item 9). The run evidence is the fix-wave's `fw-e2e-1/2` (`4 passed`, 0 level-50) and neighbours (`24 passed`). |

## Probe hygiene

These files were created, run and deleted:

- `app/test/zz-review-probe-fw1.test.ts`
- `app/test/zz-review-probe-fw1-real.test.ts`
- `app/test/zz-review-probe-fw2.test.ts`
- `app/test/zz-review-probe-fw4.test.ts`
- `app/test/zz-review-probe-e3-margin.test.ts`
- `app/src/lib/zz-review-probe-vg-old.ts`
- `app/src/routes/zz-review-probe-settings-old.ts`
- `dashboard/src/routes/settings/zz-review-probe-block-old.tsx`
- `dashboard/src/routes/settings/zz-review-probe-fw3.test.tsx`

The pre-fix copies came from `git show 6b418954:<path>`. No tracked file was modified, and nothing was staged or committed. After deletion, `git status --short` was empty before this report was written. At finish, this report is the only untracked file.
