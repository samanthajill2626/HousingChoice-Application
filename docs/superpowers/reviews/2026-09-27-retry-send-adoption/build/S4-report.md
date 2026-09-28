# S4 report - retry-send adoption, plan Tasks 5, 6 and 7

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`b765f895` (S3's report). Scope: plan Task 5 (the manual Retry route), Task 6
(projection + dashboard) and Task 7 (the one fenced line), with build worklist
items 18-21. Task 8 (the e2e) NOT started. Status: DONE. Line numbers below are
at `a7865cfe` (the last code commit).

## Commits

| hash | subject |
|---|---|
| `6ae0bfba` | feat(api): the manual Retry route refuses a superseded press (any child), an unresolved retry (the record by key, the row as a belt) and a pending attempt inside the window; its append carries retry_root and broadcast_id (retry-send-adoption T5) |
| `d574bd86` | feat(dashboard): a retried row the reconcile ruled unresolved reads 'retry not confirmed' with no Retry; the two 409 sentences; retry_outcome projected and mirrored (retry-send-adoption T6) |
| `a7865cfe` | fix(webhooks): the broadcast rollup's no-slot give-up logs at INFO (a retried share text is not a prod warning until Branch B teaches the rollup) - the one fenced-file line (retry-send-adoption T7) |
| (this file) | docs commit, recorded by its own hash in git log |

One commit per task; each was preceded by its red run and left the listed
suites, typecheck and gate-5 lint (no new error) green.

## Task 5 - the manual Retry route (R6, R7 route side)

`app/src/routes/api.ts`:
- Imports: `MAX_SEND_RETRY_ATTEMPTS`, `RETRY_OUTCOME_UNCONFIRMED`,
  `RETRY_SEND_WINDOW_MS` from the leaf (`:41-46`); `createSendAttemptsRepo`,
  `SendAttemptsRepo` (`:80`); `resolveRetryRoot`, `retryRecipientKey` (`:81`).
- `ApiRouterDeps.sendAttemptsRepo?` (`:305`); default construction
  `deps.sendAttemptsRepo ?? createSendAttemptsRepo({ logger: deps.logger })`
  (`:585`) - no network at construction.
- Handler `:1585`. The new guards sit AFTER RSW's time guard (`:1626`):
  superseded `:1638-1642`; the record read `:1652-1667`; retry_unresolved
  `:1671-1676`; the record's retry_pending `:1683-1690`.
- The append gains `retryRoot` and, when the pressed row has one,
  `broadcastId` (`:1768-1769`).
- The route's header comment said "the same failed SID stays retryable
  indefinitely" - false since R6's superseded refusal; that ONE line is
  reworded in ASCII (`:1579-1581`). The comment's pre-existing U+2014 lines are
  untouched.

### The route's final guard order

0. `manualSendLimiter` - 429 `rate_limited` (unchanged, before the handler).
1. 404 `message_not_found` (unknown SID, or another conversation's row).
2. 400 `not_outbound`.
3. 409 `not_retryable` (email).
4. 409 `not_failed` (status not failed/undelivered).
5. 409 `retry_pending` - RSW D10, the live promise (`isRetryPromiseLive`).
6. 409 `superseded` - ONE `listRetryChildrenConsistent(conversationId,
   original.tsMsgId)`; any pointer (automatic or manual child) refuses.
7. Reads: `conversations.getById` (eventual, as the plan allows), R1's
   `retryRecipientKey(original, conversation)`, `resolveRetryRoot(messages,
   original)` (consistent point-gets, a pre-deploy row's retry_of walk only),
   then ONE consistent `sendAttempts.get` at attempt
   `(retry_attempt ?? 0) + 1` - skipped when that exceeds
   `MAX_SEND_RETRY_ATTEMPTS` or there is no key.
8. 409 `retry_unresolved` - the row's `retry_outcome === 'unconfirmed'` (belt)
   OR the record is `done` with outcome `unresolved`. No time bound of the
   route's own (a 45-day-old record refuses).
9. 409 `retry_pending` - the record is open (attempting, reconciling,
   redriven) and `Date.now() - Date.parse(attemptedAt) <= RETRY_SEND_WINDOW_MS`.
10. Otherwise as before: the D14 recorded-recipient read, media, the send;
    201 with the SendMessageOutcome.

A `done` record with sent / refused / rejected / retryable / adopted /
enqueue_failed / redrive_refused never blocks (tested, all seven). The route
never writes the pressed row.

### Tests (`app/test/apiRoutes.test.ts`)

- `makeRetryApp(original, opts)` (`:463`) with `RetryAppOptions` (`:449`):
  `mediaStore`, `contactsRepo`, `children`, `parent`, `conversation`
  (`Partial<ConversationItem> | null`, null = no thread), `world`. The messages
  stub keeps `getByProviderSid` and gains `listRetryChildrenConsistent` and
  `getByTsMsgIdConsistent` as `vi.fn`s with annotated parameters (worklist
  item 18); a conversations stub (`getById`, `vi.fn`); `sendAttemptsRepo` =
  the world's fake. It returns `{ app, calls, messagesRepo, conversationsRepo,
  world }`. File-local helpers: `press` (`:519`), `PHONE_KEY` (`:529`),
  `retryOwner` (`:538`), `seedRecord` (`:558`) - which walks every record
  shape through the fake repo's OWN transitions (claim, finishAttempt,
  handToReconcile, markRedriven, closeRedriven, closeFromReconcile).
- Call sites: the 3 that passed positional args (media, D14 x2) converted to
  the options object; the other 10 pass `original` only and needed no edit.
- The two exact `toEqual` pins gained `retryRoot` (`:622`, `:753`); grep found
  no third.
- New cases `:901-1284` (15): superseded by any child; ONE pointer Query and
  no thread read; retry_unresolved by record (with and without the belt, 1 min
  and 45 days old); the belt alone (the record looked for and absent);
  retry_pending on 31 s attempting, reconciling, in-window redriven, attempting
  1 s inside the bound; 201 on stale attempting/reconciling/redriven
  (window + 1 s) and all seven non-blocking done outcomes, each proving the
  route read THAT record; the attempt number `(retry_attempt ?? 0) + 1`
  (deviation 1); R1's key (contact id vs phone key, and the thread's number);
  no record read past the cap or without a key; the guard order; every new read
  after the existing guards; R7 `retryRoot` + `broadcastId` on the append; the
  pre-deploy retry_of walk; a world-backed press through the REAL send wrapper
  (the route's own append writes `retry_of`, `retry_root`, `broadcast_id` and
  the `retrychild#` pointer; a second press with 60 newer rows is superseded by
  one pointer Query, no scan); and a `makeWebhookHarness` case that pins the
  harness api block's new `sendAttemptsRepo: world.sendAttemptsRepo`
  (`app/test/helpers/twilioWebhookHarness.ts:5000`).
- Red run before the route change: 15 failed (the two pins, 13 new behaviour
  cases), all for the missing behaviour (201 where 409, missing fields, a 500
  from the harness's unwired repo). Two new cases are regression pins and were
  green pre-change (no record read where none can exist; reads after guards).
- Mutation checks after green (each a temporary edit, restored and verified
  with `cmp`): the belt removed -> 2 red; the staleness bound set to the 30 s
  claim TTL -> the 31 s case red; a fixed attempt 1 -> 2 red.

## Task 6 - "retry not confirmed" (R5, R6 copy)

- `app/src/routes/contactTimeline.ts`: imports the leaf's
  `RETRY_OUTCOME_UNCONFIRMED` / `RetryOutcome` (`:33`); `TimelineMessage`
  gains `retry_outcome?: RetryOutcome` (`:188`); `toTimelineMessage` projects
  it ONLY when it is 'unconfirmed' (`:462`).
- `dashboard/src/routes/contact/retryPromise.ts:33` - the hand copy
  `RETRY_OUTCOME_UNCONFIRMED = 'unconfirmed' as const` with the MIRROR doc.
- `dashboard/src/api/types.ts`: `import type { RETRY_OUTCOME_UNCONFIRMED }
  from '../routes/contact/retryPromise.js'` (`:8`, type-only and `.js`-suffixed
  per worklist item 20); `export type RetryOutcome = typeof
  RETRY_OUTCOME_UNCONFIRMED` (`:2527`); `TimelineMessage.retry_outcome?`
  (`:2562`). One dashboard literal.
- `dashboard/src/routes/contact/deliveryStatus.ts`: `RETRY_UNCONFIRMED_REASONS`
  (`:965-966`, `'30003': 'Phone unreachable - retry not confirmed'`);
  `DeliveryReasonOptions.retryUnconfirmed?` (`:1024`); `deliveryReason`
  consults it FIRST, skipped when `relay` (`:1193`).
- `dashboard/src/routes/contact/Timeline.tsx`: import (`:54`);
  `sendFailureMessage` gains `superseded` and `retry_unresolved` (`:139`,
  `:141`); `const retryUnconfirmed = msg.retry_outcome ===
  RETRY_OUTCOME_UNCONFIRMED` (`:1056`), passed ONLY at the one-to-one chip
  call (`:1071`); the Retry button condition gains `&& !retryUnconfirmed`
  (`:1441`). The leg/row call sites are untouched.
- Tests: `app/test/contactTimeline.test.ts:405` (the unconfirmed row
  projects; the sentinel-only row and a plain row carry no `retry_outcome`; an
  unknown value is not projected; typed as the DASHBOARD type, so the app
  typecheck pins the declaration); `deliveryStatus.test.ts:842` (the plan's
  six expectations plus relay+scheduled, 30005 media, 99999, transient_cap,
  undefined) and the ASCII case `:868` extended;
  `Timeline.delivery.test.tsx:674-712` (an it.each: the sentinel and a live
  stamp, each with the outcome -> the unconfirmed chip, no promise, no Retry;
  an MMS bubble; the Review Focus 3 negative: the sentinel WITHOUT the outcome
  -> the plain copy and Retry offered); `Timeline.test.tsx:950-977` (an it.each
  over the two 409 codes -> their sentences in the alert, never
  "Couldn't send", ASCII); `retryPromiseMirror.test.ts:62` (the literal equals
  the app's, and is 'unconfirmed').
- Red run before the change: app 1 failed; dashboard 7 failed (mirror,
  deliveryReason, 3 Timeline.delivery, 2 Timeline), all on missing behaviour.
- Mutation check: keying the Timeline on the withdrawn sentinel instead of
  `retry_outcome` -> 3 red (the existing WITHDRAWN pin, the new negative case,
  the live-stamp case).

## Task 7 - the one fenced line (R7)

- `app/src/routes/webhooks/twilio.ts:3904`: `log.warn` -> `log.info`, and the
  U+2014 re-worded to ' - ' (plan deviation 4). Nothing else in the file.
- Diff stat, this slice (`b765f895..HEAD`) and the whole branch
  (`main...HEAD`): `app/src/routes/webhooks/twilio.ts | 2 +-`, 1 insertion(+),
  1 deletion(-).
- Test `app/test/twilioStatusWebhook.test.ts:374`, beside the rollup cases
  (worklist item 21), `statusUnknownSidRetryDelayMs: 5`: a delivered receipt
  for a share-RETRY row (broadcast_id, retry_of, retry_root) whose broadcast has
  a slot only for the share's own row -> the retry row reads delivered, the
  broadcast was read twice (the one re-load), exactly ONE give-up line at
  level 30 with the ASCII message, `broadcastId` and `conversationId`, no WARN
  line, the slot and stats untouched, no `broadcast.updated`.
- Red before the edit: level 40 and the U+2014 message, exactly as expected.

## Deviations from the plan / worklist (all deliberate)

Plan deviations 1, 4 and 8 are implemented as declared. Beyond them:

1. `makeRetryApp` returns its stubs and world (for call assertions) and its
   `conversation` option also takes `null` (no thread) - the plan's factory
   shape, extended.
2. Only 3 of the 13 call sites passed positional arguments; those were
   converted. The other 10 already match the new signature.
3. Cases beyond the plan's list (named above): guard order; reads after the
   existing guards; R1's key; no read past the cap or without a key; the
   world-backed press through the real send wrapper (it realizes spec item
   15's "writes the retrychild# pointer" and "one Query, with 60 newer
   unrelated rows", which a hand stub cannot); the harness-wiring case; the
   201 set widened to all seven non-blocking outcomes plus stale reconciling
   and redriven (the Global Constraints list them); an attempting record 1 s
   inside the bound.
4. The plan's "RSW's cases are unchanged" item adds no assertion of its own:
   the existing D10 cases pass through the grown factory, and the guard-order
   case pins "the time guard answers first".
5. The route's header comment line (`api.ts:1579`) reworded - doc-only, it
   contradicted R6.
6. The new 409s log nothing, like the route's existing 409s (the plan names no
   log line for the route).
7. `Timeline.tsx` computes `retryUnconfirmed` once and uses it at the chip and
   the button (the plan wrote the comparison inline at the button) - the same
   predicate, one reading.
8. `contactTimeline.ts` types the field as the leaf's `RetryOutcome` instead
   of the literal `'unconfirmed'` - the same type, one source.
9. T6 and T7 cases beyond the plan's minimum: an MMS unconfirmed bubble, a live
   stamp with the outcome, an unknown `retry_outcome` value not projected, the
   mirror pinning the literal's value, the rollup case's re-load, slot and
   emit assertions.
10. `retryPromiseMirror.test.ts`'s header gains a 3-line note naming the
    second hand copy.

No worklist item was contradicted by the live files. Anchors re-derived: the
plan's `api.ts:1611/1612/1685` are now `:1626-1629` (RSW's guard) / `:1691`
(the D14 block) / `:1764` (`retryOf`); `twilio.ts:3904` was exact.

## Verification (bare, from the worktree; DynamoDB Local `hc-dynamodb-local` up)

- Baseline before any edit: app 4 files 197 passed (rateLimit 16, apiRoutes
  44, contactTimeline 57, twilioStatusWebhook 80); dashboard 5 files 374
  passed (retryPromise 4, mirror 3, deliveryStatus 162, Timeline.delivery 49,
  Timeline 156).
- `cd /w/tmp/retry-send-adoption/app && npx vitest run test/apiRoutes.test.ts
  test/rateLimit.test.ts test/contactTimeline.test.ts
  test/twilioStatusWebhook.test.ts` -> exit 0, 4 files, 214 passed
  (apiRoutes 59, rateLimit 16, contactTimeline 58, twilioStatusWebhook 81).
- `cd /w/tmp/retry-send-adoption/dashboard && npx vitest run
  src/routes/contact/deliveryStatus.test.ts
  src/routes/contact/Timeline.delivery.test.tsx
  src/routes/contact/Timeline.test.tsx
  src/routes/contact/retryPromiseMirror.test.ts
  src/routes/contact/retryPromise.test.ts` -> exit 0, 5 files, 382 passed
  (deliveryStatus 163, Timeline.delivery 53, Timeline 158, mirror 4,
  retryPromise 4).
- Neighbours (not required): dashboard `src/routes/contact src/api` -> 80
  files, 1492 passed; app `retrySendAttempt sendReconcile sendMessage
  retryChain twilioWebhookHarnessRetryFields` -> 304 passed; app
  `broadcastApi broadcastFanOut` -> 176 passed.
- `npm run typecheck` -> exit 0 (app incl. tsconfig.test.json, which compiles
  `dashboard/src/api/types.ts` under NodeNext; dashboard; e2e; fake-twilio;
  fake-twilio-web).
- `npx eslint` over all 15 files this slice touched -> ONE error, pre-existing:
  `dashboard/src/routes/contact/Timeline.tsx:1595` react-hooks/set-state-in-effect
  (`setNow(fresh)`). Baseline: the merge base's file (`git show
  3dbb5740:dashboard/src/routes/contact/Timeline.tsx | npx eslint --stdin
  --stdin-filename dashboard/src/routes/contact/Timeline.tsx`) reports the same
  single error at `:1580` - the 15 lines this slice added above it shift it.
  No new error; the other 14 files are clean.
- ASCII: the slice's added lines (`git diff -U0 b765f895..HEAD`) -> 0
  non-ASCII bytes. No new file besides this report.
- Fences: no diff in `jobs.ts`, `sqsJobConsumer.ts`,
  `oneToOneRetryDecision.ts`, `messagesRepo.ts`; `twilio.ts` = the one line.
- NOT run (per the brief): the full `npm test`, `npm run e2e`, any e2e
  session, `npm run smoke` (no import graph change beyond two new imports in
  `api.ts` of existing leaf/service modules; the orchestrator's gates cover it).

## What Task 8 (the e2e) must know

- The chip, as rendered on the one-to-one bubble (the fake's 30003 profile
  writes `undelivered`): `Undelivered - Phone unreachable - retry not confirmed
  (error 30003)` (a `failed` row reads `Failed - ...`). The promise still reads
  `Undelivered - Phone unreachable - will retry (error 30003)`; the plain
  failure `Undelivered - Phone unreachable (error 30003)`.
- The Retry button's accessible name is `Retry sending this message`
  (aria-label, `Timeline.tsx:1449`); its visible text is U+21BB + "Retry" -
  address it by the aria name only. Hidden while the promise is live OR
  `retry_outcome === 'unconfirmed'`.
- The two 409 sentences render in the text composer's `role="alert"` slot
  (`sendError`, `Timeline.tsx:2855-2858`), set by `onRetrySurfaced`
  (`:2522-2526`) when a bubble's Retry press rejects - so only a UI press
  shows them (a stale tab; the button is hidden on an unconfirmed row). The
  slot is absent when the contact is deleted, a read-only note replaces the
  composer, or the Email channel is selected. A direct API press
  (`page.request.post(.../messages/<provider_sid>/retry)`) gets JSON only.
- Route answers: 201 `{ conversationId, providerSid, tsMsgId, status }`;
  409 `{ error: 'superseded' }`, `{ error: 'retry_unresolved' }`,
  `{ error: 'retry_pending' }` (both the promise and an open record); the
  earlier 404/400/409 bodies unchanged; 429 `{ error: 'rate_limited' }`.
- Timing for item 19: press only after the retried row carries
  `retry_outcome: 'unconfirmed'` - the WITHDRAW's sentinel makes RSW's time
  guard pass, so the press reaches the belt/record and answers
  `retry_unresolved`. Pressed earlier, while the promise is live, it answers
  `retry_pending`. For items 17/18: a press on the ORIGINAL after the retry row
  exists answers `superseded` - unless the refreshed promise (about attemptedAt
  + 8 s + 120 s on the lane) is still live, which answers `retry_pending` first.
- Reads: `GET /api/contacts/:id/timeline` items carry `retry_outcome:
  'unconfirmed'` only when set (never on the sentinel alone); `GET
  /api/conversations/:id/messages` returns raw rows (`{ messages }`) with
  `retry_outcome`, `retry_root`, `broadcast_id` and `retry_due_at` visible. A
  manual Retry row carries `retry_of`, `retry_root`, `automated: false`, no
  `retry_attempt`, no `retry_window_start`, and `broadcast_id` only when the
  pressed row had one.
- `e2e/support/selectors.md:50` still describes two chip readings; Task 8 adds
  the third and the two sentences (plan Task 8 Files).

## For the handback (orchestrator)

- The route's conversation read is `conversationsRepo.getById`, an eventual
  Get (the Global Constraints' allowance) - the same read the job keys its
  record with (`retrySend.ts:395`); the pointer Query, the lineage walk and the
  record Get are strongly consistent.
- A press on a pre-deploy row whose child has no `retrychild#` pointer is not
  refused `superseded` (no backfill) - Task 9's residue note for
  `send-reconcile-job-residues`, as planned.
