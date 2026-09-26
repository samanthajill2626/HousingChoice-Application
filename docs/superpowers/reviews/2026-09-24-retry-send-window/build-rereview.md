# Retry send window build - fresh re-review (after the fix wave)

Reviewer: fresh re-reviewer, read-only on tracked files. Branch
`feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, HEAD `72e1ae95`,
merge base `da04d0cb`. Inputs: the fix-wave and full-branch diff packages, the
two first-pass reviews, the adjudications, the fix-wave report, spec draft 7.3,
`rulings.md`, `AGENTS.md`. Citations are `file:line` in the live tree at
`72e1ae95` unless marked "base" (`da04d0cb`). Raw logs are under the worktree's
gitignored `.superpowers/sdd/rereview-*.log`.

## 1. Verdict

**The branch holds, and the fix wave is REAL and behavior-preserving. No
BLOCKER, MAJOR or MINOR was found.**

- NEW findings (first-pass misses): 0 BLOCKER, 0 MAJOR, 0 MINOR, 1 NIT (N1).
- Findings IN the fix diff: 0 BLOCKER, 0 MAJOR, 0 MINOR, 1 NIT (F1).
- Adjudication challenges: 3 (C4 scope, A2 rationale, A10 completeness). All
  are NIT-level. None argues for blocking the merge.
- Fix verification: C1-C5, A1, A2, A4, A5, A6 and A8 are all REAL. C4 is REAL for
  its stated scope; its neighbor case is still unpinned (challenge 4.1).
- Gates re-run by this reviewer: `npm run typecheck` EXIT=0, `npm run smoke`
  EXIT=0 ("1430 import specifier(s) across 252 emitted file(s) resolve"), and
  eslint over the 16 fix-wave script files, which reports only the known
  pre-existing `react-hooks/set-state-in-effect` at `Timeline.tsx:1577`. No
  `[dynamoAdmin]` line appears in any log. No whole `npm test`, no e2e, and no
  :5174/:8080 were used.

Tests run one file at a time, each EXIT=0.
- App: `retrySendWindow` 34, `oneToOneRetryDecision` 50, `twilioStatusWebhook`
  80, `relayRetryClaim.webhook` 54, `relayRetryClaim` 5, `relayRetryLeg` 71,
  `messaging.integration` 24, `twilioWebhookHarnessRetryFields` 6, `apiRoutes`
  43, `sendMessage` 64, `contactTimeline` 57, `relayRetryGates` 15,
  `relayFanOut` 82.
- Dashboard (run from `dashboard/`): `relayWindowCloseMirror` 3,
  `retryPromiseMirror` 3, `relayRetryJoin` 45, `deliveryStatus` 143,
  `Timeline.delivery` 45, `Timeline.ticker` 40, `serverClock` 15, `retryPromise`
  4, `Timeline` 156.

## 2. NEW findings (what the first pass missed)

### N1. NIT - CONFIRMED - a dashboard tab loaded before the deploy renders a window-declined relay leg with the raw internal code

- **Where.** The new server writes `retry_window_closed` on a relay rung:
  - the claim, at `app/src/routes/webhooks/twilio.ts:2880`;
  - the job, at `app/src/jobs/relayRetryLeg.ts:593`, `:681` and `:730`.

  The pre-deploy bundle has no answer for that code:
  - the base join copies the last rung's code onto the leg, with no window
    exception (base `dashboard/src/routes/contact/relayRetryJoin.ts:410`,
    `closeCode = last?.leg.errorCode`);
  - base `INTERNAL_CODE_REASONS` has no entry for it (base
    `deliveryStatus.ts:913-935`);
  - so `deliveryReason` falls to its raw-code template (base
    `deliveryStatus.ts:1007`).

  The new bundle handles it (`relayRetryJoin.ts:104`, `:423-424`), but only
  after a reload.
- **Scenario.** A staff member keeps the dashboard open across the deploy. A
  late 30003 then arrives on a relay leg, and the claim appends the rung already
  closed `retry_window_closed` (or the job closes it that way). The old tab's row
  reads `Undelivered - Delivery failed (error retry_window_closed)`. Cameron
  ruled that a declined retry "shows as a plain failed attempt". The tab shows
  that copy for as long as it stays open: `dashboard/src` has no version check
  and no `location.reload`, and the app serves the dashboard itself, so an open
  tab keeps the old bundle until someone reloads it by hand.
- **Evidence.** A throwaway probe, `zz-rereview-mixed-version.test.ts`, loaded
  the BASE `relayRetryJoin.ts` and `deliveryStatus.ts` (copied from `da04d0cb`,
  imports repointed) next to the current ones. It fed both one claim-time closed
  versioned rung, exactly as the new claim appends it. The probe has been
  deleted. Output:

  ```
  v control: the NEW bundle reads the plain 30003
  x a tab loaded BEFORE the deploy (base bundle) reads the plain 30003 too
    Expected: "Phone unreachable (error 30003)"
    Received: "Delivery failed (error retry_window_closed)"
  Tests 1 failed | 1 passed (2)
  ```

- **Consequence.** Cosmetic and transient per tab, and limited to relay legs
  with a late 30003. It is still an app-internal code shown to staff, which
  `INTERNAL_CODE_REASONS` exists to prevent. The A10 deploy note does not
  mention it: it names only the 409 mapping and the old webhook's stamp-less
  retries.
- **Smallest fix.** A line in the handback's deploy note: reload every open
  dashboard tab after the deploy. The same reload also clears A10's two items
  and the old "will retry on every 30003" copy. No code change.

No other first-pass miss survived the sweep in section 6.

## 3. Findings IN the fix diff

### F1. NIT - CONFIRMED (documentary; no probe applies) - the new issue says spec section 9 already accepts exits it never listed

- **Where.** `docs/issues/one-to-one-retry-promise-outlives-job-decline.md:48-52`
  says section 9's "A promise with nothing behind it" "accepts exactly this
  class". The bullets it lists earlier (`:22-27`) cover a STOP during the
  backoff, the kill switch, the breaker, manual mode, a late job and a missing
  original. The same claim is the stated reason for the A2 row in
  `build-review-adjudications.md:31`.
- **Evidence.** Section 9 of the spec
  (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md:811-824`)
  enumerates six exits:
  1. an automated retry the breaker refuses;
  2. a failed-read fail-open that the job then refuses;
  3. the D4 window at send time (D4 is the window check alone, spec :245-247);
  4. a provider send failure;
  5. an enqueue failure whose correction write also failed;
  6. a crash or throw between the stamped write and the enqueue.

  It does NOT list a job refusal whose cause arose DURING the backoff after
  successful reads. That covers a STOP, the kill switch turned off, manual mode
  set on an automated original's thread, a soft-delete, or lost consent. D3a
  (spec :238-243) calls the breaker "the one refusal the arm cannot preview".
  That is true only at decision time; the author did not consider state
  changing inside the 60-240 s backoff. The adversarial review found these
  exits (its F2). The spec never accepted them.
- **Consequence.** The handback would tell Cameron that the spec already
  accepted these cases, when he has not ruled on them. His gate answer 3 bears
  directly on them. The spec summarizes it as "'will retry' appears only when a
  retry will actually be attempted" (spec :43-44); his own words are at
  `rulings.md:54-57`. At the job's refusal
  the system knows no retry will be attempted, yet the promise stays up for up
  to about 3 minutes.
- **Smallest fix.** Reword `:48-52`, and the A2 reason, to separate the two
  groups. The breaker and the D4 window are accepted by section 9. A refusal
  caused by a change during the backoff is newly found and is his call. The FILE
  outcome can stand (challenge 4.2).

Everything else in the fix diff reviewed clean on a cold read; see section 5.

## 4. Adjudication challenges

### 4.1 C4 - agree it is fixed; disagree with its scope (NIT, CONFIRMED by a surviving mutant)

The first pass's finding 4 named several cases where intention 2's "the slot on
the root is unchanged in every case" goes unasserted. The adjudication fixed
only one: the versioned WINDOW decline. The other claim-time decline,
`gate_refused` (D3 step 1), has no versioned root-slot assertion anywhere:
- The rung-1 gate cases (`relayRetryClaim.webhook.test.ts:925`) seed a LEGACY
  source only. On a legacy slot, `setRecipientActualTransport` is a no-op.
- The versioned gate tests, the team send (`:1026`) and the data shape
  (`:1218`), never read the root slot.

**Evidence.** Mutant: in the decline exit (`twilio.ts` step 8a), write the root
slot on every GATE decline, with `if (decline !== RETRY_WINDOW_CLOSED_CODE) await
messages.setRecipientActualTransport(ptr.conversationId, rootTsMsgId,
ptr.memberKey, 'sms')`. Result: `relayRetryClaim.webhook` 54 passed, EXIT=0.
The mutant survives the whole file. The same write on the window branch fails
(section 5, C4). Reverted, and `git status` was clean.

**Position.** Add the root-slot `toEqual` to the versioned team case (`:1026`)
or the versioned data-shape row (`:1218`). This is a coverage gap only: the code
writes no root slot on any branch. Not merge-blocking.

### 4.2 A2 - agree with FILE; disagree with the recorded reason

The FILE is defensible on cost and benefit. The fix would be new worker writes
and emits after the execution marker, for at most about 3 minutes on rare
exits. But "Spec section 9 accepts exactly this class" is not true for the
during-backoff refusals (F1). The handback should put those exits to Cameron as
new, not as ruled. A fix would not conflict with ruling 4. Withdrawing a
promise changes the screen, never whether a text is sent, so it is not a
reverse double-send guard.

### 4.3 A10 - agree with NOTE; the note is incomplete

The note must also cover N1: the raw `retry_window_closed` code on relay legs in
pre-deploy tabs. It must also say that nothing forces a reload: there is no
version check in `dashboard/src`. One instruction, "reload open dashboard tabs
after the deploy", closes N1 and both of A10's items.

### 4.4 Rows with no challenge

I agree with the other rows:
- C1, C2, C3, C5.
- A1 and Q4. Under ruling 4 (`rulings.md:62-63`), a job that honors the
  withdrawal sentinel or an expired promise would drop a real retry whenever
  nobody presses Retry. That is the "not delivered at all" outcome Cameron chose
  against.
- A3. The fallback runs only when `/contacts/:id/timeline` answers 404
  (`useContactTimeline.ts:174-178`). The server's 409 guard still holds.
- A4. There is no import cycle, and the helper is pinned at both call sites
  (section 5).
- A5, A6, A7, A8, A9, Q1, Q2, Q3, Q5.

## 5. Fix verification

| Item | Verdict | Evidence |
| --- | --- | --- |
| C1 | REAL | `twilioStatusWebhook` 80 passed. Mutant: `retrySend.ts` `withinRetrySendWindow({ originMs: originMs - 1, ... })` (the job is 1 ms stricter than the helper) -> EXIT=1, 1 failed / 79 passed. Only the exact-boundary row failed: "expected [] to have a length of 1 but got +0". Reverted. The 16-minute tests do not see this mutant, so the new rows are the only pin. |
| C2 | REAL (docs) | Checked against the code: the base 30003 copy promises nothing (`deliveryStatus.ts:782`). A `group_text` decline is at `oneToOneRetryDecision.ts:90-92`, and the send path refuses a fail-open group send (`sendMessage.ts` group-text guard). `relay` beats `retryScheduled` (`deliveryStatus.ts:1034-1036`), and the chip passes no `relay` (`Timeline.tsx:1055-1057`). Group rows drop `retry_due_at` through `buildRelayItems` (`useRelayThread.ts:101-133`, which `useGroupThread.ts:27` reuses). |
| C3 | REAL | `RUNBOOK.md:341` now reads "the 30003 retry of an automated text". That matches `retrySend.ts:321` (`original.automated ?? true`) and the preview's manual-mode gate for automated sends only (`sendRefusalPreview.ts:69`). |
| C4 | REAL, for its stated scope | 54 passed. Mutant: the versioned decline writes `actualTransport` onto the ROOT slot -> EXIT=1, 1 failed / 53 passed. Only the `(versioned=true)` window row failed, with the diff `+ "actualTransport": "sms"`. The expected literal (`:1116-1126`) is the post-status-write, pre-claim slot, so it bites. The gate-decline neighbor is still unpinned (4.1). Reverted. |
| C5 | REAL (comment) | `Timeline.tsx:1013-1015` matches the gate at `:1423` (`&& !retryPromiseLive`). The file's non-ASCII lines are untouched; 0 non-ASCII bytes in the branch's 6474 added lines. |
| A1 | REAL (issue gap 5) | The claims hold. The jobs queue is a standard SQS queue (`infra/modules/jobs/main.tf:34-42`, no `fifo_queue`). `SendMessageCommand` is at `app/src/adapters/scheduler.ts:356-362`. The withdrawal is at `twilio.ts:3621-3629`, and `retrySend.ts` never reads `retry_due_at`. The quote matches `rulings.md:62-63`. The "Suggested fix" section it points to exists (`manual-retry-double-send-residual-windows.md:72-77`). |
| A2 | REAL as a filing | The new issue exists, and its schema is valid (`type: improvement` is in `scripts/issues.mjs:16`). Its behavioral claims are true: no no-send exit in `retrySend.ts` writes or emits, and `announceRootClose` is at `relayRetryLeg.ts:477-484`. Its spec-coverage claim is wrong (F1). |
| A4 | REAL | Helper `retrySendWindow.ts:65-70`, used at `oneToOneRetryDecision.ts:129` and `retrySend.ts:236`. Semantics are the same as the old inline `??` at both sites, including the value the job carries onto the retry row (`retrySend.ts:326`, still gated on `typeof windowStart === 'string'`). Unit file 34 passed. Call-site mutant, operands swapped in the helper: `twilioStatusWebhook` 2 failed (including "the new row carries its lineage, window origin ... FROM THE APPEND") and `oneToOneRetryDecision` 3 failed (including the chain-origin and no-fallback rows). Both call sites therefore pin the helper, beyond the fix wave's unit-row mutants. Reverted. The module is still import-free. |
| A5 | REAL, and the lineage was dead | Repo-wide sweep of app/, app/scripts, e2e/, scripts/, fake-twilio*/ and infra/: no `annotateMessage` call passes lineage. Production callers pass `mediaAttachments` (`mediaMirror.ts:160`, `twilio.ts:805`, `backfill-media-content-types.ts:603`) or `retryDueAt` (`twilio.ts:3621`). The inline test fakes (`mediaMirrorJob.test.ts:57`, `backfillMediaContentTypes.test.ts:81`, `contactMedia.test.ts:111`) do not read lineage. Typecheck EXIT=0. `messaging.integration` 24 passed; the append-time lineage keeps its own real-DynamoDB test (`messaging.integration.test.ts:213` onward). No behavior change: the removed log keys were always undefined for the remaining callers. The send-outcome-reconcile spec (read-only, `W:\tmp\send-outcome-reconcile`) defers the `retrySend` adoption and does not use annotate-after lineage. |
| A6 | REAL | In app/src the constant is the only copy (`retrySendWindow.ts:44`), used at `twilio.ts:417`, `:2861`, `:2880`, `:3011` and `relayRetryLeg.ts:113`, `:593`, `:600`, `:681`, `:686`, `:730`, `:735`. Dashboard mutant (`WINDOW_CLOSED_CODE` drifts): the mirror test 1 failed / 2 passed ("expected 'retry_window_close' to be 'retry_window_closed'"), and `relayRetryJoin` 2 failed / 43 passed. Reverted. The mirror test imports app code exactly as `retryPromiseMirror.test.ts` does (same relative path depth). It passes dashboard vitest, run from `dashboard/`, and the dashboard `tsc` inside the root typecheck (EXIT=0). |
| A8 | REAL (comment) | `relayRetryClaim.ts:44-50` matches `twilio.ts:2966-2974`. The append's SID dedupe answers a duplicate without reading the rung. |

## 6. Swept and found clean

Every item below was grepped repo-wide, not just in the diff, across app/,
dashboard/, e2e/, scripts/, fake-twilio*/ and infra/.

- **`retry_due_at`.**
  - Writers: `updateDeliveryStatus`'s `retryDueAt`, whose only caller is
    `twilio.ts:3444-3449`, in one conditional write (`messagesRepo.ts:2633-2680`).
    Terminal statuses never transition again (`ALLOWED_PRIOR`,
    `messagesRepo.ts:133-142`), so the stamp is written once. The other writer is
    the withdrawal annotate (`twilio.ts:3621`).
  - Every other `updateDeliveryStatus` caller passes no options.
  - Readers: the route guard (`api.ts:1605`), the projection
    (`contactTimeline.ts:450-452`), `normalizeServerItems` (pass-through,
    `useContactTimeline.ts:131-146`) and the chip, button and ticker
    (`Timeline.tsx:1041`, `:1423`, `:2200`).
  - Dropped by `buildRelayItems` and `buildTimelineFallback` (A3). No sort,
    schedule or "upcoming" reader treats the epoch sentinel as a time.
- **`retry_window_start` and `retry_attempt`.**
  - Both are written only at append now: through `sendMessage.ts:490-492`, fed
    by `retrySend.ts:324-326`. The manual route never passes either
    (`api.ts:1672-1684`).
  - Readers: the helper, and the cap at `oneToOneRetryDecision.ts:123`.
- **`retry_of`.** Written at append by the route and the job. Readers: the
  projection, the Timeline supersede set, and `useRelayThread.ts:101`. No
  server logic keys on it.
- **`automated`.**
  - Written on every `sendMessage` row. All six `sendMessage` call sites pass it
    explicitly (`api.ts:1437`, `:1677`, `broadcastFanOut.ts:468`,
    `missedCallAutoText.ts:242`, `public.ts:300`, `retrySend.ts:321`).
    `tourReminders.ts` and `placementNudges.ts` pass it through their own send
    service.
  - Readers: only the decision (`:117`) and the job (`:321`). No dashboard
    reader. `groupSend.ts:706` writes only an audit payload.
  - The census script's breaker evidence, `outbound_minute_bucket`
    (`conversation-automation-census.ts:151`), still holds: a person's retry is
    never metered.
- **`recipient_contact_id`.**
  - Readers: the decision (`:102-105`), the job before its marker (`:189-200`)
    and the route (`api.ts:1610-1625`).
  - `getById` returns soft-deleted rows, so all three judge alike, and the
    parity table (`sendRefusalCases.ts:68-173`) pins the duplicate-contact
    cases.
  - No contact-merge feature exists that could strand it.
- **`relay_retry_window_start`.** Written only by the claim append, normalized to
  ISO and present on declined rungs too. Readers: the claim for rungs 2-3, and
  the job, where it is optional (`relayRetryLeg.ts:325`). The dashboard does not
  declare it.
- **A rung appended CLOSED at claim time.**
  - There are only two `relay.retryLeg` enqueue sites (the claim, and the job's
    own transient re-enqueue), so a closed rung is never run.
  - Its slot shape matches `refuseGate`, and its row-level `queued` matches a
    job-refused rung. D20 hides the row, the join reads it as terminal, and no
    inbox touch or pointer write depends on it.
- **The 409 `retry_pending` guard.** The only caller of the retry endpoint is
  `ContactCommsPane.tsx:304-308`. The error is mapped at `Timeline.tsx:134-135`.
  The guard runs after not-found, not-outbound, email and not-failed, in that
  order.
- **The server-clock estimate.**
  - Every dashboard API call goes through `requestWithStatus`
    (`client.ts:108-125`). The only other `fetch` is the cross-origin S3
    presigned POST (`endpoints.ts:1175`), which correctly takes no sample.
  - Every CloudFront behavior serving the app is CachingDisabled
    (`infra/modules/cloudfront/main.tf:158-209`).
  - The estimate only lags and never runs ahead, apart from a browser clock
    jumping forward after a sample.
  - Test isolation holds: vitest isolates module state per file, and only
    `serverClock.test.ts` and `Timeline.ticker.test.tsx` touch it, both with
    resets.
- **The promise ticker.** One snapshot per memo feeds arming, the chip and the
  button. It re-takes on `visible`, `tickNow` and `retryIndex`, and it stops
  once the grace passes.
- **The lane seam `E2E_SEND_RETRY_BACKOFF_MS`.** Read only by the webhook's
  decision, and guarded by `JOBS_QUEUE_URL`. It is absent from all three
  `.env*.example` files. Only `one-to-one-30003-retry.spec.ts` arms a one-to-one
  30003; fake-twilio has no default failure profile.
- **New ERROR and WARN lines vs the alarms.** ErrorLogs matches `level >= 50`;
  DeliveryFailures matches `event`. No filter keys on `retryClaim`,
  `retryDecision` or message text (`infra/modules/observability/main.tf:50-111`).
  Every path walked logs one ERROR per incident. No error catalog keys on log
  text. The Q1 burst-alarm question stays Cameron's.
- **Races walked, all consistent.**
  1. Concurrent failed and undelivered callbacks on two tasks: one conditional
     write wins; the loser gets `ConditionalCheckFailed` and has no side
     effects.
  2. Duplicate relay callbacks whose previews diverge (open vs closed): the SID
     dedupe decides, and either outcome is coherent.
  3. A stamp that committed but lost its response, or a throw after the stamp:
     the residual accepted in spec section 9.
  4. The withdrawal: it re-emits.
  5. SQS visibility (120 s) vs a bounded relay acquire: the execution marker
     suppresses the redelivery. This is pre-existing, and the wait is now bounded.
- **Mixed versions.**
  - The job payload is unchanged in both directions (app/worker).
  - A new webhook with an old worker restarts the window and cap only for the
    deploy minutes (accepted: "a text sent before this deploy").
  - Old claim rows with a new job fail open under D5.
  - The dashboard ships inside the app image, so the only other mixed window is
    stale tabs: A10 plus N1.
- **Security and PII.** No new user input reaches a query, and the routes keep
  `requireAuth` and the rate limiter. The new log fields are IDs, codes and
  times; relay member keys go through the log-safe helpers.
- **ASCII.** 0 non-ASCII bytes in the 6474 added lines of the branch diff,
  outside the review records.
