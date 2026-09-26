# Retry send window build - Slice 4 report (Tasks 14-18)

Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, base `198c061c`.

## Commits

- `40fc5c3c` feat(dashboard): estimate the server clock and judge the retry promise on it (retry-send-window D8, D10) - Task 14.
- `b7222692` feat(dashboard): 30003 promises a retry only while one is scheduled (retry-send-window D8, D11, D12) - Task 15.
- `0fd12e0a` feat(dashboard): a window-declined relay rung reads the plain 30003 failure (retry-send-window D8) - Task 16.
- `603f35a7` feat(dashboard): one-to-one bubble promises a retry only while one is scheduled, hides Retry, ticks to expiry (retry-send-window D8, D10, D11, D12) - Task 17.
- `12223364` test(dashboard): every other 30003 reader reads the plain failure (retry-send-window D8) - Task 18.

Every command below ran from the stated directory with its output redirected to a
log file; each count and exit code was read from the run itself, never through a pipe.

## Task 14

- Red (Step 3): `cd dashboard; npx vitest run src/api/serverClock.test.ts src/routes/contact/retryPromise.test.ts src/routes/contact/retryPromiseMirror.test.ts` - exit 1, 3 files failed to load and no test ran: `Failed to resolve import "./serverClock.js"` (serverClock.test.ts) and `Failed to resolve import "./retryPromise.js"` (retryPromise.test.ts and retryPromiseMirror.test.ts). The mirror's app import (`../../../../app/src/lib/retrySendWindow.js`) resolved. This is the reason the plan predicted.
- Green (Step 6): `cd dashboard; npx vitest run src/api src/routes/contact/retryPromise.test.ts src/routes/contact/retryPromiseMirror.test.ts` - exit 0, 11 files, 127 passed. `serverClock.test.ts` has 15: the plan's 14 plus the D5 case. `retryPromise.test.ts` has 4 and `retryPromiseMirror.test.ts` has 3. The two existing client suites pass unchanged (`client.maintenance.test.ts` 6, `mmsMedia.client.test.ts` 3).
- Extra check, not a plan step: the reference names four more suites whose fetch doubles reach `requestWithStatus`. After this change, a double without `headers` would throw. `cd dashboard; npx vitest run src/app/AuthContext.test.tsx src/routes/Login.test.tsx src/App.test.tsx src/app/AppFrame.test.tsx` - exit 0, 4 files, 30 passed.
- `npm run typecheck`: exit 0. `npx eslint` on the six files: exit 0, no output.
- ASCII: the five new files have 0 non-ASCII bytes in the whole file. `client.ts` has 0 in its added lines, and its whole-file count is 6 -> 6 (the two U+2014 in the header and the `body` doc were not touched).

## Task 15

- Red (Step 2): `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts` - exit 1, 7 failed and 136 passed (143). This is exactly the plan's set:
  - Five tests received `Phone unreachable <U+2014> will retry (error 30003)`: `promises no retry on a native group-text rollup either`, `promises nothing without retryScheduled - one-to-one and native group text alike`, `promises the retry with retryScheduled on a 30003 that is not a relay leg`, `keeps the promise on an MMS one-to-one 30003 - media: true does not suppress the promise` (the D6 title) and `writes the 30003 copy in ASCII, with and without the promise`.
  - Both `retry_window_closed` rows of the close-code table received `Delivery failed (error retry_window_closed)`.
  - Green as pins: the relay-leg test, `moves no other code...`, both order tests and the prototype sweep.
- Green (Step 4): the same command - exit 0, 143 passed.
- The Step 5 red set, as observed: `cd dashboard; npx vitest run src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/broadcasts/StatChips.test.tsx` - exit 1, exactly 4 failed and 53 passed (57). Nothing else failed in those files. The four:
  - `Timeline.delivery.test.tsx`: `keeps the retry promise on the SAME leg in a native GROUP TEXT`.
  - `Timeline.delivery.test.tsx`: `leaves the MESSAGE-LEVEL chip on the base copy, relay default notwithstanding`.
  - `Timeline.email.test.tsx`: `keeps the BASE 30003 copy on an outbound email failure`.
  - `StatChips.test.tsx`: `keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped`.
- `npm run typecheck`: exit 0. `npx eslint` on the two files: exit 0, no output. `EM_DASH` in the test file is still used, by the ASCII test.
- ASCII: 0 non-ASCII bytes in the added lines of both files.
  - `deliveryStatus.ts` whole file: 68 -> 65 bytes. The only non-ASCII line removed is the old 30003 entry's U+2014, which is the one character that had to go. The hazard lines at :773-774 and :969/:971 (their pre-edit numbers) were not touched.
  - `deliveryStatus.test.ts` whole file: 27 -> 27. The :430 hazard was not touched.
- The `presentLegDelivery` doc still quotes "because nothing observable depends on it today". The rewritten order comment keeps that phrase (`deliveryStatus.ts:1022`).

## Task 16

- Red (Step 3): `cd dashboard; npx vitest run src/routes/contact/relayRetryJoin.test.ts src/routes/contact/Timeline.delivery.test.tsx` - exit 1, 5 failed and 80 passed (85). This is the plan's set:
  - The two `retry_window_closed` join cases: the projected `errorCode` was `retry_window_closed`.
  - `reads a window-declined rung as the plain 30003 failure at all three positions`: the chip read `delivered 1/2 - 1 failed - Not retried - message too old`.
  - Task 15's two hand-offs.
  - Green as pins: both gate `it.each` tables (4 + 4 rows).
- Green (Step 5): the same command - exit 1. Only the two Task 15 hand-offs failed (2 failed, 83 passed). `relayRetryJoin.test.ts` had 45 passed. This is what the plan expects until Task 17.
- `npm run typecheck`: exit 0. `npx eslint` on the three files: exit 0, no output.
- ASCII: all three files are pure ASCII (whole file 0 before and after, added lines 0).

## Task 17

- Red (Step 4): `cd dashboard; npx vitest run src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.ticker.test.tsx src/routes/contact/Timeline.test.tsx` - exit 1, 7 failed and 234 passed (241). This is the plan's set:
  - `Timeline.delivery`, 2 tests: the live-stamp SMS and MMS tests (`Unable to find ... Undelivered - Phone unreachable - will retry (error 30003)`).
  - `Timeline.ticker`, 4 tests: the ARMS test and the three skew rows (no promise on screen).
  - `Timeline.test`, 1 test: the 409 test (the alert read the generic line).
  - Green as pins: the group-text inversion, the no-stamp test, the three stale-stamp rows and the three new SILENT rows.
- Green (Step 6): the same command - exit 0, 3 files, 241 passed (ticker 40, delivery 45, `Timeline.test` 156).
- Whole dashboard (Step 6): `cd dashboard; npx vitest run` - exit 1. Files: 2 failed, 192 passed (194). Tests: 2 failed, 3223 passed (3225). The two failures are exactly the Task 18 hand-offs (`StatChips.test.tsx` and `Timeline.email.test.tsx`).
- `npm run typecheck`: exit 0.
- `npx eslint` on the four files: exit 1 with ONE error, `Timeline.tsx:1575:7 react-hooks/set-state-in-effect` on the call card's `setNow(fresh);`. It is pre-existing, and a baseline comparison proves it. The pre-task content (`git show HEAD:dashboard/src/routes/contact/Timeline.tsx` at `0fd12e0a`) was linted with `npx eslint --stdin --stdin-filename dashboard/src/routes/contact/Timeline.tsx`. It reports the same single error at :1495. It moved +80 lines (the worklist estimated about :1572; see Deviations 5). There is no other error.
- ASCII: 0 non-ASCII bytes in the added lines of all four files, and no removed line carried non-ASCII.
  - `Timeline.tsx` whole file: 172 -> 172. `Timeline.test.tsx`: 75 -> 75. `Timeline.delivery.test.tsx` and `Timeline.ticker.test.tsx`: 0 -> 0.
  - These hazard lines were not touched: `Timeline.tsx` :130 ("Couldn't send"), :911 (props arrow), :1337-1338 (opted-out note) and :1351 (the button text), all pre-edit numbers, and `Timeline.test.tsx` :926/:928.

## Task 18

- Red (Step 1): `cd dashboard; npx vitest run src/routes/broadcasts/StatChips.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/broadcasts/broadcastFormat.test.ts` - exit 1, 2 failed and 38 passed (40). The two failures are exactly the StatChips and EmailCard hand-offs. `broadcastFormat.test.ts` passed: its old pin matched only the prefix.
- Green (Step 3): `cd dashboard; npx vitest run src/routes/broadcasts/StatChips.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/BroadcastResults.test.tsx` - exit 0, 4 files, 51 passed (broadcastFormat 18, StatChips 14, Timeline.email 8, BroadcastResults 11).
- Sweep (Step 4), `git grep -n "will retry" -- dashboard/src`. Every hit is one of the four kinds the plan allows:
  - (a) The `RETRY_SCHEDULED_REASONS` entry, `deliveryStatus.ts:837`.
  - (b) Comments: `serverClock.ts:3`, `types.ts:2499`, `retryPromise.ts:2`, `Timeline.tsx:779`, `:851`, `StatChips.test.tsx:133`, `Timeline.delivery.test.tsx:432`, `:458`, `:1002` and `Timeline.ticker.test.tsx:979`.
  - (c) Negatives: `StatChips.test.tsx:138`; `Timeline.delivery.test.tsx:450`, `:500`, `:532`, `:563`, `:613`, `:626`, `:1014`, `:1081`, `:1147`, `:1170`; and `Timeline.email.test.tsx:113`.
  - (d) Live-stamp positives: `deliveryStatus.test.ts:754`, `:766`; `PROMISE_TEXT` at `Timeline.delivery.test.tsx:589`; and `PROMISE_CHIP` at `Timeline.ticker.test.tsx:995`.
  - No other positive reader exists.
- Sweep (Step 4), `git grep -n "retryScheduled" -- dashboard/src ':!*.test.ts' ':!*.test.tsx'`:
  - `deliveryStatus.ts`: the option at :889, its docs and the chain at :1033.
  - Exactly ONE call site that passes it: `Timeline.tsx:1054`, `deliveryReason(msg.error_code, { media: isMms, retryScheduled: retryPromiseLive })`.
  - The rest are comments (`Timeline.tsx:1045`, `:1352`).
- WHOLE dashboard suite (Step 5, required): `cd dashboard; npx vitest run`, redirected to a log - exit 0. Test Files: 194 passed (194). Tests: 3225 passed (3225). Duration 52.40s. The log has no "Unhandled" section. The red window that Task 15 opened is closed.
- `npm run typecheck`: exit 0. `npx eslint` on the three files: exit 0, no output.
- ASCII: 0 non-ASCII bytes in the added lines of all three files. Whole-file counts: `StatChips.test.tsx` 14 -> 14, `broadcastFormat.test.ts` 15 -> 15, `Timeline.email.test.tsx` 0 -> 0.

Final combined check at `12223364`, over the 17 files this slice touched (`git diff --name-only 198c061c..HEAD`):
- `npx eslint`: exactly one error, the pre-existing `Timeline.tsx:1575` above.
- ASCII: `git diff -U0 198c061c..HEAD -- <those files> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> 0.

## Worklist items - how each landed

- D1 (Task 18): the `EmailCard (outbound delivery chip)` describe was replaced from its `describe(` line through its own closing `});` (:117). The seam now reads: the new describe's `});`, one blank line, then `describe('AttachmentGallery filename labels (fix-wave R1)', ...`. No orphan closer remains.
- D2 (REQUIRED): the diff-scoped check ran before every commit, and the count of added-line non-ASCII bytes was 0 each time:
  - Task 14: `client.ts` 0, with the five new files at 0 whole-file.
  - Task 15: `deliveryStatus.ts` 0 and `deliveryStatus.test.ts` 0.
  - Task 16: 0, 0 and 0.
  - Task 17: 0, 0, 0 and 0.
  - Task 18: 0, 0 and 0.
  - Whole-file counts were compared before and after each task, as listed per task above. The only non-ASCII character removed in the whole slice is the U+2014 of the old one-to-one 30003 entry (`deliveryStatus.ts`, 68 -> 65 bytes). Every named hazard line kept its bytes.
- D3 (Task 17): the rewritten `Timeline.delivery.test.tsx` comments cite by symbol:
  - The group-text inversion: "`rosterKind` defaults to 'relay' (the default in the `Timeline` props destructure, and MessageBubble's own default), so exactly ONE production caller opts out: GroupTextView."
  - The D8 chip set: "Every case renders with the DEFAULT rosterKind, which is 'relay' (the default in the `Timeline` props destructure) - on purpose ...".
  - `grep "1790\|:906"` on the file finds nothing. For the record, the two defaults now sit at `Timeline.tsx:962` (MessageBubble) and `:1876` (Timeline).
- D5 (Task 14): one case was added to the estimate describe, `measures the offset from the receipt instant it is GIVEN, not from the browser clock at the call`: `noteServerDate(httpDate(BROWSER_NOW), BROWSER_NOW - 5_000)` must give `serverNowMs() === BROWSER_NOW + 5_000`. An implementation that read `Date.now()` instead of the parameter would compute offset 0 and fail this case.
- D6 (optional): APPLIED - both tests are retitled to what they pin.
  - Task 15: `keeps the promise on an MMS one-to-one 30003 - media: true does not suppress the promise`. Its comment now says that the chain checks the promise ahead of the media map, but with no media 30003 entry the test cannot observe that order and pins only that `media: true` does not suppress the promise.
  - Task 17: `keeps the promise on an MMS one-to-one bubble - media: true does not suppress the promise`.
  - The chain order is the plan's: the promise first, then media, relay, base.
- D8 (Task 17): the chip comment's last sentence does not say that a group text "gets no stamp". It reads: "A native group text's aggregate reads the plain failure: its row can carry a stamp only when the one-to-one decision failed open (D3a, D11), and no screen renders that stamp - the contact timeline skips group_text conversations (app/src/routes/contactTimeline.ts), and the group view's fixed field list drops `retry_due_at` (conversation/useRelayThread.ts)." Both claims were checked:
  - `contactTimeline.ts:1242` is `if (conv.type === 'relay_group' || conv.type === 'group_text') continue;`.
  - The `useRelayThread.ts` fixed field list carries `retry_of` but no `retry_due_at`.
- D4, D9, D10: no action. D7 (accepted residual): not redesigned. The estimate replaces the offset on every response, as the plan's code does.

## Deviations from the plan

1. Worklist-directed text changes relative to the plan, quoted above:
   - D5 adds one test case.
   - D6 retitles two tests and rewrites the Task 15 test's comment.
   - D3 changes two comment citations.
   - D8 rewords the chip comment's final sentence. It is 3 lines longer than the plan's block, so it names the reason and both files.
2. Commit messages: Tasks 14, 15, 17 and 18 carry one extra paragraph naming the worklist items applied (the slice 2/3b precedent). Task 16's message is the plan's, verbatim. Every trailer names `Claude Opus 5.5`, this session's attribution.
3. `Timeline.delivery.test.tsx` Task 17 (a): deleting the `EM_DASH` docblock and constant also removed one of the two blank lines around them. Exactly one blank line now separates `GROUP_ROSTER` and the `RELAY_AT` docblock.
4. Extra verification, beyond the plan's steps (coverage only, no code differs):
   - Task 14's run of the four other fetch-double suites.
   - The slice-wide eslint and ASCII pass at `12223364`.
5. Line shift: Task 17 added 80 lines above the call card, not the reference's 77. The extra 3 are the D8 comment. The pre-existing gate-5 error therefore reports at `Timeline.tsx:1575`, not about :1572. Baseline attribution identifies it as the same error (:1495 at the base).
6. Nothing else. Every other quoted old text matched the live file exactly once and was applied by exact-text edit. No anchor needed adapting, and no importer, cycle or contract mismatch appeared. `MessageBubble` and `StreamItem` each have one render site, and `hasTickableLeg` has one caller (the memo).

Observations (no change made, for later slices):

- `dashboard/src/api/types.ts:2502-2503` (Task 13's doc on `retry_due_at`) still ends "Absent when no retry was scheduled (declined, exhausted, a relay or group row)". It has the same D8 nuance: a fail-open `group_text` row can carry a stamp. The file is outside this slice's scope and is left for Slice 5's comment sweep, which R1 already asks to re-read.
- The optional remnants from finding 10 were left alone, because neither sits inside an edit region:
  - `Timeline.delivery.test.tsx:432-433` ("30003's 'will retry' copy must not appear") is still true: its assertion is a negative.
  - `Timeline.tsx:1013` ("Failures expose a reason ... + Retry") is now true except while a promise is live. The Retry gate's own comment says so.

## Contract shipped for downstream slices

What the Task 19 e2e can select on, and where each piece lives:

- The PROMISE copy. On a one-to-one outbound bubble on the contact page (the `Timeline` that `ContactCommsPane` renders), the message-level chip reads exactly `Undelivered - Phone unreachable - will retry (error 30003)`. The chip is `{label}{' - ' + reason}`, so a row whose status is `failed` reads `Failed - Phone unreachable - will retry (error 30003)`.
  - It is a plain text element, not `role="img"`: that role is used only for recipient rollups, so `getByText` with the full string finds it.
  - The reason is `deliveryReason(msg.error_code, { media: isMms, retryScheduled: retryPromiseLive })`, whose map entry is `RETRY_SCHEDULED_REASONS['30003'] = 'Phone unreachable - will retry'` (`dashboard/src/routes/contact/deliveryStatus.ts`).
  - It shows only while `showsRetryPromise(msg, promiseNowMs)` holds (`Timeline.tsx`): the row is not email, is outbound, has a failure status (`undelivered` or `failed`), and `isRetryPromiseLive(msg.retry_due_at, promiseNowMs)` is true. That is, `promiseNowMs < Date.parse(retry_due_at) + 120_000`.
  - The error code is not checked. The server's 409 guard does not check it either.
- The BASE copy. The chip reads `Undelivered - Phone unreachable (error 30003)` in four cases:
  - a one-to-one bubble with no stamp, an expired stamp, the withdrawn `1970-01-01T00:00:00.000Z` stamp, or an unparseable stamp;
  - once the promise expires on screen;
  - an EmailCard;
  - the property-send results badge (`Failed` + reason `Phone unreachable (error 30003)`, via `shareRecipientReason`).
  - Every relay or group leg reads the same reason: row `Undelivered - Phone unreachable (error 30003)`, rollup `delivered N/M - K failed - Phone unreachable (error 30003)`.
  - The base entry is `ERROR_CODE_REASONS['30003'] = 'Phone unreachable'`, and the relay map keeps the same words. `relay` wins over `retryScheduled`, and the chip never passes `relay`.
- The Retry button.
  - Accessible name `Retry sending this message` (an `aria-label`). Its visible text is `<U+21BB> Retry`, which is unchanged.
  - It renders when the bubble's status presents as a failure, `onRetry` is wired (only `ContactCommsPane` wires it: the contact page and the placement and tour one-to-one tabs), and the promise is NOT live.
  - While the promise is live it is NOT RENDERED (absent from the DOM, never `disabled`).
  - It returns without a reload when the ticker tick (period 60 s, `STALE_TICK_MS`) that crosses `retry_due_at + 120 s` on the server-clock estimate re-renders the bubble. The expiry is visible within one tick after the edge.
- The 409 copy. `A retry is already scheduled for this message.` appears in the composer's error slot (`<p role="alert">` bound to `sendError`, `Timeline.tsx`). It comes through `onRetrySurfaced` -> `sendFailureMessage`, whose `retry_pending` case maps `ApiError.code === 'retry_pending'`. The response body `{ error: 'retry_pending' }` becomes that code through `errorFrom` in `client.ts`. It replaces the generic `Couldn't send <U+2014> please try again.` for this code only.
- A relay window decline. A last rung closed `retry_window_closed` carries no display code (`WINDOW_CLOSED_CODE`, `relayRetryJoin.ts`), so the original leg's 30003 stands. The leg reads `Phone unreachable (error 30003)` at the chip, the recital (`Lars Landlord: Undelivered, Phone unreachable (error 30003)` in the test fixture) and the row. No current surface renders `Not retried - message too old`: it is only the `INTERNAL_CODE_REASONS.retry_window_closed` fallback. The four gate closes still read `Not retried - group closed`, `no longer in this group`, `number changed since` and `opted out`.
- The server clock.
  - `noteServerDate(res.headers.get('Date'))` runs on EVERY response in `requestWithStatus` (`dashboard/src/api/client.ts`), ok or not, before `parseBody`.
  - `serverNowMs()` is `Date.now()` plus the latest offset, and `resetServerClockForTests()` is for tests only (`dashboard/src/api/serverClock.ts`).
  - The Timeline takes ONE snapshot per arming decision, in the `tickerArmed` memo, and passes it to every bubble as `promiseNowMs`.
  - The mirror is `RETRY_PROMISE_GRACE_MS = 120_000` in `dashboard/src/routes/contact/retryPromise.ts`, pinned against the app constant by `retryPromiseMirror.test.ts`.
  - On an e2e lane the server and the browser share one machine clock, so the estimate trails true server time by under a second (the header's truncated milliseconds plus the trip).
- The ticker. It arms while any visible one-to-one bubble shows a live promise (clause 7 in `hasTickableLeg`, checked ahead of the leg clauses) and disarms on the tick that expires the last one. A bubble with no stamp, an expired stamp or the withdrawn stamp never arms it.
