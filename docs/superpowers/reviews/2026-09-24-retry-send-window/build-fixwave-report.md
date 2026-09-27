# Retry send window build - fix-wave report

Implementer: the one fix-wave implementer (Claude Opus 5.5), 2026-09-26.
Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, from
`5a6cf53a` (clean) to `d8aa32b6` plus the commit that adds this report.
Instruction list: `build-review-adjudications.md` (this folder), every FIX / FILE
row; the brief (`.superpowers/sdd/fixwave-brief.md`) added specifics. The two
never conflicted. NOTE and REJECT rows (A3, A7, A9, A10, Q1-Q5) were not
touched, and A1 / A2 got issue records only, no code.

Raw logs are under the worktree's gitignored `.superpowers/sdd/fixwave-*.log`;
everything that matters from them is quoted below.

## Verdicts

| Item | Verdict | Commit | Where (live, at `d8aa32b6`) |
| --- | --- | --- | --- |
| C1 | DONE | `ae50e4c1` | `app/test/twilioStatusWebhook.test.ts:1605-1638` (+ import `:37`) |
| C4 | DONE | `ebe8b50b` | `app/test/relayRetryClaim.webhook.test.ts:1113-1127` |
| A4 | DONE | `079d5731` | helper `app/src/lib/retrySendWindow.ts:65-70`; callers `app/src/services/oneToOneRetryDecision.ts:129`, `app/src/jobs/retrySend.ts:236`; rows `app/test/retrySendWindow.test.ts:67-111` |
| A5 | DONE | `57b04c61` | `app/src/repos/messagesRepo.ts:1228-1240`, `:1479`, `annotateMessage` at `:3006`; harness `app/test/helpers/twilioWebhookHarness.ts:1361-1366`; `app/test/messaging.integration.test.ts:194-210` |
| A6 | DONE | `06fb0f65` | constant `app/src/lib/retrySendWindow.ts:44`; `app/src/jobs/relayRetryLeg.ts:109-113`, `:593`, `:600`, `:681`, `:686`, `:730`, `:735`; `app/src/routes/webhooks/twilio.ts:417`, `:2861`, `:2880`, `:3011`; `dashboard/src/routes/contact/relayRetryJoin.ts:104`; `dashboard/src/routes/contact/deliveryStatus.ts:955-956`; new `dashboard/src/routes/contact/relayWindowCloseMirror.test.ts` |
| A8 | DONE | `d7f2d17a` | `app/src/lib/relayRetryClaim.ts:44-50` |
| C5 | DONE | `d7f2d17a` | `dashboard/src/routes/contact/Timeline.tsx:1013-1015` |
| C2 | DONE | `d8aa32b6` | `docs/issues/relay-hub-message-delivery-status-never-terminal.md:9`, `:60-74` |
| C3 | DONE | `d8aa32b6` | `RUNBOOK.md:341` |
| A1 | DONE (issue only) | `d8aa32b6` | `docs/issues/manual-retry-double-send-residual-windows.md:10`, `:25-26`, `:42-62` |
| A2 | DONE (issue only) | `d8aa32b6` | new `docs/issues/one-to-one-retry-promise-outlives-job-decline.md` |

## Per item

### C1 - the one-to-one retry job's exact window boundary (spec D13)

A two-row `it.each` beside the 16-minute test, using the file's own pattern
(`seedOutbound`, `jobIso`, `JOB_NOW`, `spySend`, `now: () => JOB_NOW`) and
`RETRY_SEND_WINDOW_MS` imported from the lib: origin exactly
`RETRY_SEND_WINDOW_MS` before the job clock sends once and logs no
`window_closed` ERROR; one millisecond earlier sends nothing and logs exactly one.

- Baseline 78 passed; with the rows 80 passed, EXIT=0.
- Mutant 1, `retrySend.ts` window check reading `now() + 1`: EXIT=1, 1 failed |
  1 passed. The exact-boundary row: `AssertionError: expected [] to have a
  length of 1 but got +0`.
- Mutant 2, reading `now() - 1` (the lenient direction): EXIT=1. The
  one-ms-earlier row: `AssertionError: expected [ { conversationId: 'conv-1',
  ...(6) } ] to have a length of +0 but got 1`.
- Reverted: 80 passed, EXIT=0; `retrySend.ts` absent from `git status`.

### C4 - the versioned root slot in the window-decline case

The `if (!versioned)` guard is gone: the root slot is asserted for both shapes.
The versioned literal was derived from the code, then confirmed exact by
`toEqual`: the callback's own write, `updateRecipientDeliveryStatus(...,
'undelivered', '30003')`, spreads the seeded slot and sets status and code; the
fixture leg SID `SMleg-bob-0000` is not provider-shaped, so
`normalizeTwilioTransportEvidence` returns `missing` (`fixture-message-sid`) and
`setRecipientActualTransport` is never called. Result:
`{ status: 'undelivered', requestedTransport: 'sms', transportAggregationState:
'attempted', errorCode: '30003', sentAt }`.

- Baseline 54 passed; after the change 54 passed, EXIT=0.
- Mutant: the claim's decline branch in `twilio.ts` writes the ROOT slot through
  `setRecipientActualTransport(..., 'sms')`, the one slot writer none of the
  case's three spies watches. EXIT=1, 1 failed | 53 passed: only the
  `(versioned=true)` row, `AssertionError: expected { status: 'undelivered',
  ...(5) } to deeply equal { status: 'undelivered', ...(4) }`, diff
  `+ "actualTransport": "sms",`. Before C4 this mutant survived the whole file.
- Reverted: 54 passed, EXIT=0.

### A4 - one copy of the one-to-one origin rule (strict TDD)

`oneToOneRetryWindowOrigin(message)` in `lib/retrySendWindow.ts`: structural
parameter `{ retry_window_start?: string; provider_ts?: string }` (the module
still has zero imports), returns the RAW value, keeps `??` exactly. Used at the
decision (`oneToOneRetryDecision.ts:129`) and the job (`retrySend.ts:236`). The
cap and backoff constants stay in the job module, as adjudicated.

- RED first: 7 failed, `TypeError: (0 , oneToOneRetryWindowOrigin) is not a
  function`. GREEN: 34 passed (27 + 7), EXIT=0.
- Seven rows: chain origin wins; `provider_ts` fallback; both absent is
  undefined (and parses to undefined); RFC 2822 value returned raw; empty and
  unparseable `retry_window_start` do NOT fall back (and parse to undefined, D5);
  a stored null falls through like an absent one.
- Mutants (each run EXIT=1; every row killed by at least one):
  - `||` for `??`: the empty row, `expected '2026-09-25T11:59:30.000Z' to be ''`.
  - operands swapped: 4 rows (chain, RFC, empty, unparseable), e.g.
    `expected '2026-09-25T11:59:30.000Z' to be '2026-09-25T11:50:00.000Z'`.
  - `!== undefined` ternary: the null row, `expected null to be
    '2026-09-25T11:59:30.000Z'`.
  - `?? ''` appended: the both-absent row, `expected '' to be undefined`.
  - fallback dropped: the first-send and null rows, `expected undefined to be
    '2026-09-25T11:59:30.000Z'`.
- Behavior unchanged, files unmodified: `oneToOneRetryDecision` 50 passed,
  `twilioStatusWebhook` 80 passed. Typecheck EXIT=0. Lint EXIT=0.

### A5 - the dead annotate-after lineage removed

Removed `MessageAnnotations.retryOf` / `retryAttempt`, their two SET branches and
two log fields in `annotateMessage`, and the harness twin's two lines. In the
integration test the lineage half is gone; media-annotation coverage stays and
the missing-message rejection now uses `retryDueAt: RETRY_PROMISE_WITHDRAWN_AT`;
retitled "stamps media keys onto an existing message and rejects a missing
one". The append path (`NewMessage.retryOf` / `retryAttempt`, the append's
`retry_of` / `retry_attempt`, harness `:1133` / `:1140`) and `retryDueAt` are
untouched. A four-line guard note in `MessageAnnotations` says lineage is
append-only (D6) and why; the interface doc at `:1479` no longer says "retry
lineage".

- Caller proof, before removal: every production `annotateMessage` call passes
  `mediaAttachments` (`app/src/jobs/mediaMirror.ts:160`, `twilio.ts:803`,
  `app/scripts/backfill-media-content-types.ts:603`) or `retryDueAt`
  (`twilio.ts:3619`). No `retryOf` / `retryAttempt` annotation anywhere in
  `app/`, `e2e/`, `scripts/`, `fake-twilio/` except the integration test.
  After removal: the same grep finds nothing; typecheck EXIT=0.
- Tests, EXIT=0 each: `messaging.integration` 24, `twilioWebhookHarnessRetryFields`
  6, `contactMedia` 11, `mediaPointers.integration` 7, `mediaMirrorJob` 7,
  `backfillMediaContentTypes` 28, `twilioStatusWebhook` 80, `sendMessage` 64,
  `apiRoutes` 43, `contactTimeline` 57.
- Extra proof (not required): the retargeted rejection still bites. With
  `annotateMessage`'s `attribute_exists(tsMsgId)` condition removed: EXIT=1,
  `promise resolved "undefined" instead of rejecting`. Reverted, 24 passed.

### A6 - one window-close constant, pinned across to the dashboard (strict TDD)

`RETRY_WINDOW_CLOSED_CODE = 'retry_window_closed' as const` in
`lib/retrySendWindow.ts` (still import-free). `RelayRetryCloseCode` and the
claim's `closeCode?` / `decline` types derive from it via `typeof`, and every
app write, compare and log site uses the constant, so no quoted copy remains in
app code (grep: only the constant itself and the dashboard's pinned mirror). The
dashboard's `WINDOW_CLOSED_CODE` is exported; the new
`relayWindowCloseMirror.test.ts` (header after `retryPromiseMirror.test.ts`)
asserts (a) it equals the app constant, (b) `deliveryReason(APP value)` is "Not
retried - message too old", and a floor (the app value is a non-empty string;
another code does not get that copy).

- RED first: 2 failed | 1 passed - `expected 'undefined' to be 'string'` (floor)
  and `expected undefined to be 'Not retried - message too old'`. Row (a)
  PASSED vacuously there (both imports resolved to undefined), which is exactly
  what the floor exists to catch. GREEN: 3 passed, EXIT=0.
- Mutant (a), dashboard copy drifts: `expected 'retry_window_expired' to be
  'retry_window_closed'`.
- Mutant (b), map key drifts: `expected 'Delivery failed (error
  retry_window_c...' to be 'Not retried - message too old'`.
- Rename proof, app constant's VALUE changed to `retry_window_expired`:
  - `npm run typecheck` EXIT=0, 0 errors - no literal copy remains in app code.
  - mirror test EXIT=1, both rows: `expected 'retry_window_closed' to be
    'retry_window_expired'` and `expected 'Delivery failed (error
    retry_window_e...' to be 'Not retried - message too old'`.
  - app tests that pin the stored value: `relayRetryLeg` 5 failed | 66 passed,
    `relayRetryClaim.webhook` 4 failed | 50 passed.
  - with the value still changed, the four pre-A6 typed literals restored: app
    `tsc` EXIT=2 with exactly
    `relayRetryLeg.ts(593,24): error TS2345: Argument of type
    '"retry_window_closed"' is not assignable to parameter of type
    'RelayRetryCloseCode'.`, the same at `(730,31)`,
    `twilio.ts(2880,9): error TS2322`, `twilio.ts(3011,20): error TS2367 ...
    have no overlap`. The restored LOG-field literal (`relayRetryLeg.ts:600`)
    produced no error - which is why every log site uses the constant.
  - all reverted; grep finds no `retry_window_expired` anywhere.
- Final, EXIT=0 each: dashboard mirror 3, `retryPromiseMirror` 3,
  `relayRetryJoin` 45, `deliveryStatus` 143, `Timeline.delivery` 45; app
  `retrySendWindow` 34, `relayRetryLeg` 71, `relayRetryClaim.webhook` 54,
  `relayRetryClaim` 5, `relayRetryGates` 15, `twilioStatusWebhook` 80.
  Typecheck EXIT=0. Lint EXIT=0.

### A8 - `already_claimed` after a closed rung (comment)

The union doc now says `already_claimed` also answers a DUPLICATE callback for a
rung the claim appended CLOSED (`gate_refused` / `window_closed`, D3), answered
by the append's SID dedupe without reading the rung, so on its own it does not
mean a ladder ran. The `twilio.ts` dedupe comment (`:2966-2972`) already says
"The ladder is running - or its rung was already appended CLOSED"; unchanged.
`relayRetryClaim` 5 passed.

### C5 - the conditional Retry (comment)

`Timeline.tsx:1013-1015`: "+ Retry, except that Retry is not rendered while an
automatic retry is still promised (retry-send-window D10; the gate is at the
Retry button below)" - both lines sit in `MessageBubble`, the gate at `:1423`.
Selected exactly; the file's non-ASCII lines untouched. `Timeline.delivery` 45
passed.

### C2, C3, A1, A2 - records

- C2: a dated UPDATE under the WARNING paragraph: the base 30003 copy promises
  nothing (D8), no native group text retries (D11 - the arm declines, the send
  path refuses one if the decision failed open), and the chip omits `relay`
  because `relay` would switch the one-to-one promise off (D8). Body kept as
  history. The frontmatter had no `updated:`; added `2026-09-26`.
- C3: "the 30003 retry" -> "the 30003 retry of an automated text"; only that
  phrase changed on the (ASCII) line.
- A1: gap 5 - the enqueue that throws after SQS accepted the job (standard-queue
  `SendMessage` is not idempotent; `app/src/adapters/scheduler.ts:357`), the
  withdrawal to the epoch sentinel, Retry at once, both sends; wider than gap 1;
  a residual, not a regression; F1 cited by file name; KEPT DELIBERATELY under
  ruling 4, quoted exactly from `rulings.md:62-63`; D7 withdraws the promise,
  not the retry; closed by the issue's own claim-based fix. The lead-in now
  reads "time-based, and it is withdrawn at once when the retry's enqueue fails
  (spec D7); these five gaps remain", because gap 5 does not follow from the
  guard being time-based. `updated:` was already 2026-09-26 (today). Refs gain
  `scheduler.ts` and the adversarial record.
- A2: new issue from the template (HTML comments deleted): type improvement,
  severity low, status open, area app/messaging, created 2026-09-26, the
  brief's refs. It lists the job's no-send exits, the ~3-minute bound, F2's
  probe output, spec section 9's explicit acceptance, the relay job's
  `announceRootClose`, and the best-effort withdrawal + `message.persisted`
  fix, never rethrown.
- `npm run issues` EXIT=0: 298 open, 180 closed, 478 total, no `warning(s)`
  line (the script prints one per schema problem). `INDEX.md:138` lists the new
  slug as low / improvement / open / app/messaging. INDEX.md is gitignored
  (`.gitignore:62`) and was not committed.

## Verification at `d8aa32b6`

- App vitest, one file at a time, each EXIT=0: `retrySendWindow` 34,
  `oneToOneRetryDecision` 50, `twilioStatusWebhook` 80, `relayRetryClaim.webhook`
  54, `relayRetryClaim` 5, `relayRetryLeg` 71, `messaging.integration` 24,
  `twilioWebhookHarnessRetryFields` 6, `contactMedia` 11,
  `mediaPointers.integration` 7, `mediaMirrorJob` 7, `sendMessage` 64,
  `apiRoutes` 43, `contactTimeline` 57.
- Dashboard vitest (from `dashboard/`), each EXIT=0: `relayWindowCloseMirror` 3,
  `retryPromiseMirror` 3, `relayRetryJoin` 45, `deliveryStatus` 143,
  `Timeline.delivery` 45.
- `npm run typecheck` EXIT=0. `npm run smoke` EXIT=0 ("1430 import specifier(s)
  across 252 emitted file(s) resolve under plain Node").
- Lint over the 16 script files changed in `5a6cf53a...HEAD`: one error, the
  known pre-existing `react-hooks/set-state-in-effect` on `setNow(fresh);`, now
  `Timeline.tsx:1577` (was `:1575`; moved by C5's two added comment lines). Any
  other: none.
- ASCII: 0 non-ASCII bytes in added lines and 0 in removed lines across
  `5a6cf53a..d8aa32b6`, checked per commit and over the range.
- No `[dynamoAdmin]` line in any fix-wave log.
- Not run, per the brief: `npm test` (whole), `npm run e2e`, any e2e session.

## Files touched

App: `app/src/lib/retrySendWindow.ts`, `app/src/services/oneToOneRetryDecision.ts`,
`app/src/jobs/retrySend.ts`, `app/src/jobs/relayRetryLeg.ts`,
`app/src/routes/webhooks/twilio.ts`, `app/src/repos/messagesRepo.ts`,
`app/src/lib/relayRetryClaim.ts`; tests `app/test/twilioStatusWebhook.test.ts`,
`app/test/relayRetryClaim.webhook.test.ts`, `app/test/retrySendWindow.test.ts`,
`app/test/messaging.integration.test.ts`, `app/test/helpers/twilioWebhookHarness.ts`.
Dashboard: `dashboard/src/routes/contact/relayRetryJoin.ts`,
`dashboard/src/routes/contact/deliveryStatus.ts`,
`dashboard/src/routes/contact/Timeline.tsx`, new
`dashboard/src/routes/contact/relayWindowCloseMirror.test.ts`.
Docs: `RUNBOOK.md`, `docs/issues/relay-hub-message-delivery-status-never-terminal.md`,
`docs/issues/manual-retry-double-send-residual-windows.md`, new
`docs/issues/one-to-one-retry-promise-outlives-job-decline.md`, and this report.

## Commits

| Hash | One line |
| --- | --- |
| `ae50e4c1` | test: pin the one-to-one retry job's window at its exact boundary (C1) |
| `ebe8b50b` | test: assert the versioned root slot is untouched by a window-declined claim (C4) |
| `079d5731` | refactor: one copy of the one-to-one window origin rule (A4) |
| `57b04c61` | refactor: remove the dead annotate-after retry lineage (A5) |
| `06fb0f65` | refactor: one app constant for the window-close code, pinned to the dashboard (A6) |
| `d7f2d17a` | docs: already_claimed after a closed rung; the conditional Retry (A8, C5) |
| `d8aa32b6` | docs: relay-hub note, RUNBOOK wording, residual gap 5, job-decline issue (C2, C3, A1, A2) |
| (branch tip) | docs(records): this report |

## Divergences and choices

None from the adjudications file. Choices the list left open:

- A6: took the brief's "leaves no literal" branch - the constant at every app
  write, compare and log site - rather than derived unions over surviving
  literals. The rename proof shows why: a log-field literal is untyped and
  would have drifted silently. The derived unions still reject any typed
  literal reintroduced later (TS2345 / TS2322 / TS2367 above).
- A6: one ASCII comment line added to `deliveryStatus.ts` naming the pin.
- A5: added the guard note and fixed the interface doc; added the extra mutant
  on the retargeted rejection case.
- A8: `twilio.ts` needed no change (its comment already covers a closed rung).
- A1: reworded the lead-in and added two refs, as above.
- A2: the title avoids double quotes (frontmatter-parser safety); the spec's
  inner quotes are rendered as single quotes, as the adjudications file does.
- Process: one sweep grep over the worktree root started walking
  `node_modules`; it was stopped (TaskStop) with no effect on the tree, and the
  sweep was redone with the gitignore-aware search.

## Noticed, not fixed

1. `app/src/lib/relayRetryClaim.ts:12` and `:15` cite `jobs/retrySend.ts:37`
   and `retrySend.ts:39-42` for the one-to-one cap and backoff. Already stale
   at `5a6cf53a` (`:47`, `:50`); now `:51`, `:54` after A4's import block.
   Comment-only drift, pre-existing.
2. `app/test/relayRetryClaim.webhook.test.ts:1270` types its window row with a
   test-local `RelayRetryGateCode | 'retry_window_closed'` union, and
   `app/test/relayRetryLeg.test.ts:322` types its gate code as `string`; a value
   change surfaces there as runtime failures (9 cases, proven above), not
   compile errors. Tests pinning the stored value is deliberate; left.
3. `docs/issues/relay-hub-message-delivery-status-never-terminal.md:10` refs
   carry 2026-09-01 line numbers (`Timeline.tsx:862`, `twilio.ts:2353`) that
   have long moved. Pre-existing, outside C2's ask.
4. Spec section 9's "Manual double send" residual
   (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md:799-806`)
   names three gaps; the live issue now names five. The spec is the frozen
   design and the issue the live record; left.

## Remaining steps

None in this wave. Next is the orchestrator's: the full gates (`npm test`,
`npm run e2e`) and the fresh re-reviewer the adjudications file names.
