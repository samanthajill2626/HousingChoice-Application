# Planner adversarial review - feat/send-outcome-reconcile

- Worktree: `W:\tmp\send-outcome-reconcile`, HEAD `91a66577`, code final `52220729`, merge base `bd752bd0`.
- Scope: `git diff bd752bd0...52220729 -- . ':(exclude)docs'`, read against the repository. The spec, plan and
  review records were NOT read. The in-repo issue registry (`docs/issues/`) was read only to avoid
  re-reporting residues that are already filed: every finding below was checked against it and is not
  filed there (or is filed without the point made here, which the finding says).
- Method: code reading plus throwaway PURE-UNIT vitest runs (an in-memory FakeWorld and an injected fake
  document client). The runs used a scratch vitest config with NO `globalSetup` and NO `setupFiles`
  (the repo config's globalSetup creates and then DROPS the worktree-keyed DynamoDB Local tables, which
  would have hit the planner's live gate run), and `DYNAMODB_ENDPOINT` pointed at a dead port. 5 tests,
  5 passed, file deleted afterwards. Nothing tracked was edited; nothing was staged or committed.

## Verdict

**0 blocking, 1 high, 3 medium, 6 low.** None of the findings is a new automatic double text. The
high is pre-existing (not a regression) but is the commonest way a send strands, and neither this
branch's takeover nor the planned sweeper reaches it. The mediums are consequences the branch's own
records do not name: a share-level "Failed" that invites the very resend the per-row design avoids, a
short provider blip that now fails a whole share for good, and relay re-drives that land late and out
of order.

## HIGH

### H-1. A deploy during a fan-out strands the rest of the pass silently; the in-flight recipient is never taken over, and the untried remainder has no attempt record for a sweeper to find (pre-existing, not a regression)

- The worker drains for at most 10 s on SIGTERM, then exits: `app/src/worker.ts:530-556`, the hard
  exit at `:543` (`setTimeout(() => process.exit(0), 10_000)`). `docker-compose.yml` sets no
  `stop_grace_period` for `worker`, so the platform also kills at Docker's 10 s default.
- A broadcast pass is paced at the shared A2P bucket, 1 msg/s by default (`app/src/lib/config.ts:302`;
  one token per recorded send, `app/src/jobs/broadcastFanOut.ts:817-826`). Any share with more than
  about 10 recipients still sending when a deploy lands is cut mid-loop.
- The killed job's SQS message is not deleted; it redelivers after the 120 s visibility timeout
  (`infra/modules/jobs/main.tf:36`) with the SAME jobId, the execution marker suppresses it
  (`broadcastFanOut.ts:351-363`; relay `relayFanOut.ts:829-841`), and the consumer deletes it as a
  success. The only trace is the INFO "broadcast send duplicate delivery suppressed".
- Result: the recipient mid-send keeps an `attempting` record that no later pass will ever meet, so
  D8a's takeover ("a process died mid-send", `broadcastFanOut.ts:891-892`) never fires for it; every
  recipient after it stays `queued` with NO attempt record at all (records are created only at the
  claim, `broadcastFanOut.ts:869-879`); the broadcast reads "Sending" forever. No ERROR, no alarm.
- Why this is worth a line although it predates the branch: the registry's backstop
  (`docs/issues/send-attempt-sweeper.md`, "Suggested fix": "A periodic job that finds attempt records
  open past a bound") is keyed on attempt RECORDS. It would find the one `attempting` recipient and
  never see the untried remainder, which is most of the share. `fanout-pass-setup-throw-strands-pass`
  covers a setup THROW, not a kill mid-loop. So the design as filed leaves the most frequent strand
  trigger (every deploy during a share) uncovered.
- Direction (not designed here): make the fan-out loop SIGTERM-aware (stop at a recipient boundary and
  re-enqueue the remainder under a FRESH jobId before exit), and/or give the sweeper a second input -
  `sending` broadcasts / relay sources with `queued` slots and no live record past a bound - rather
  than records alone; a longer `stop_grace_period` only narrows it.

## MEDIUM

### M-1. An all-unconfirmed share finalizes `failed`: it reads "Failed" on the list and header, and drops out of the "already sent this property" set, so the next share of the property re-texts those tenants by default

- Finalize now fails a share when no recipient reached sent/delivered and at least one is failed OR
  unconfirmed (`app/src/jobs/broadcastFanOut.ts:1533-1537`). The branch's own test pins it for a
  one-recipient share whose outcome is unknown (`app/test/broadcastFanOut.test.ts:1538-1558`:
  `status 'failed'`, last_error "Couldn't confirm any text went out"). Before the branch an unknown
  outcome threw and the share stayed `sending`.
- The pill is "Failed", tone danger, on both the list row and the results header
  (`dashboard/src/routes/broadcasts/broadcastFormat.ts:78`, `:97-104`;
  `BroadcastStatusPill.tsx`). The per-row design goes out of its way NOT to invite a resend for these
  recipients (`BroadcastResults.tsx:52-56` drops the retry hint for `send_unconfirmed`), but the share
  level contradicts it.
- The untouched consumer: `priorRecipientContactIds` skips every broadcast whose status is not
  `sent`/`sending` (`app/src/repos/broadcastsRepo.ts:716`), and the preview uses it for
  `alreadySentThisProperty` (`app/src/routes/broadcasts.ts:521-548`), which is what starts a row
  UNCHECKED in the composer (`RecipientPreview.tsx:9-13`). So a tenant who may well have received the
  text is offered, pre-checked, on the next share of the same property.
- Verified by a throwaway FakeWorld test (the harness mirrors the repo rule,
  `app/test/helpers/twilioWebhookHarness.ts:3266-3279`): one tenant, unknown send, unresolved close ->
  slot `failed/send_unconfirmed`, share `failed`, `priorRecipientContactIds('unit-1')` returns `[]`.
- Reach: every one-recipient share (the matching page's 1:1 send) whose reconcile ends unresolved; and
  if the hosted-dev check finds link shortening on (`send-reconcile-hosted-dev-checks` item 4), EVERY
  ambiguous share send ends unresolved. It needs a human resend, which is why it is medium, not high.
- Direction: count `send_unconfirmed` slots in the prior-recipients set (and in any "reached" notion),
  and/or present an unconfirmed-only share as something other than "Failed".

### M-2. A ~30 s provider blip (5xx) or throttle (20429) now closes a whole share `failed/transient_cap` for good, most of it never attempted; the reason text says retries ran

- The outage brake defers the untried remainder after 3 consecutive unknowns
  (`broadcastFanOut.ts:1062-1097`), but every pass still spends a ladder rung, and the ladder is 3
  passes spaced 10 s then 20 s (`:136`, `:148-150`, `:1146-1152`). Retryables (20429 is now retryable,
  `app/src/lib/sendOutcome.ts:104-111`) never brake, and a failure acquires no A2P token
  (`:817-826`), so a throttle storm is sprayed at the provider unpaced.
- Verified by throwaway FakeWorld tests, 20 recipients, passes 2 and 3 run from the recorded
  continuations:
  - every send answers 503/20503: 9 provider calls in total (3 per pass), and the other 11 recipients
    are closed `failed/transient_cap` without ever being attempted;
  - every send answers 429/20429: 60 calls, all 20 closed `failed/transient_cap`, share `failed`.
- The rendered reason for those slots is "Sending gave up after repeated temporary errors"
  (`dashboard/src/routes/contact/deliveryStatus.ts`, `INTERNAL_CODE_REASONS.transient_cap`), which is
  untrue for the never-attempted ones. Relay is the same shape with a 5 s + 10 s ladder
  (`relayFanOut.ts:152-154`), though rosters rarely reach the brake.
- Better than before (a 20429 or 5xx used to throw and strand the pass silently), and loud (the
  "fan-out closed" ERROR), but a product owner would not expect a half-minute Twilio incident to fail a
  500-tenant share permanently. Direction: do not charge a ladder rung to a braked remainder (or give
  the brake its own, longer backoff), and pace retryables.

### M-3. Relay-leg re-drives have no freshness or ordering bound: about 4 minutes late on the normal path, out of order in the group, and unbounded when the chain is delayed

- `never_sent` is only ruled at the last check, attemptedAt + 240 s (`app/src/lib/sendOutcome.ts:30`;
  `app/src/jobs/sendReconcile.ts:897-906`), and the re-drive is enqueued then
  (`sendReconcile.ts:1078-1115`). The member receives "Alice: Meet at 3" roughly four minutes after
  Alice sent it - after anything she sent in between, with no marker that it is late (the body is
  re-composed from the current roster, `relayFanOut.ts:1110-1116`).
- The re-drive pre-check tests only group open / member on roster / row present / continuation
  (`sendReconcile.ts:1123-1130`), and the fan-out handler has no age gate (`relayFanOut.ts:843-903`).
  A chain delayed by an SQS backlog or an operator's DLQ redrive re-drives whenever it finally runs.
- Contrast: the 30003 retry RUNG, re-driven through its own job, IS bounded by the retry send window
  (`app/src/jobs/relayRetryLeg.ts:798`, `app/src/lib/retrySendWindow.ts:15`, 15 minutes), the product
  rule that stale relay re-sends must not go out. The leg re-drive skips that rule.
- The broadcast re-drive is equally unbounded and does not re-check that the unit is still available
  (the send route does; the pass does not), so a late re-drive can text a listing already leased.
- Not in the registry. Direction: apply the retry-send-window bound (origin of the source row) to a leg
  re-drive in `redriveRefusal`, closing `redrive_refused` past it.

## LOW

### L-1. `listByRecipient` reads the index with no upper bound and one consistent GetItem per item

- The Query is `conversationId = :p AND tsMsgId >= :since` with no upper key bound, paged to the end,
  with a sequential consistent `get` for every index item (`app/src/repos/sendAttemptsRepo.ts:585-615`);
  `lookup` then discards everything outside +-150 s (`sendReconcile.ts:787-795`).
- Verified with an injected fake document client: 250 index items spread over three days after
  `since` -> 3 Queries and 250 consistent GetItems, all but one outside the sibling span.
- On time it reads ~390 s of items. On a late check (backlog, DLQ redrive) it reads everything since
  attemptedAt - 150 s, up to the 30-day TTL, for a busy relay member (2 index items per leg). That can
  outrun the 120 s visibility timeout and redeliver the check concurrently. Fix: bound the range at
  `siblingToMs` (`BETWEEN :since AND :until`).

### L-2. The reconcile-delay seam is gated on "no JOBS_QUEUE_URL", which is also the live-Twilio local stack

- `reconcileCheckDelaysMs` honors `E2E_SEND_RECONCILE_DELAYS_MS` whenever `JOBS_QUEUE_URL` is empty
  (`sendReconcile.ts:148-153`). Every deployed worker sets the queue URL, so production is safe; but
  local `npm run dev` runs jobs in-process with no queue URL and, in live mode, real Twilio. With the
  variable exported in that shell, the last check runs at +8 s; the 2026-09-24 spike saw a just-created
  message absent from the list, which is exactly a `never_sent` and a real second text. Same pattern as
  the pre-existing `E2E_SEND_RETRY_BACKOFF_MS`. Gate on a hermetic signal (`TWILIO_API_BASE_URL` set or
  `E2E_LANE`) instead.

### L-3. The `redrive_refused` prose is wrong for most of the causes that write it

- "Wasn't resent: the group closed or the member left" (`dashboard/src/routes/contact/deliveryStatus.ts:1056`).
  Causes that write the code: `group_not_open` and `member_removed` fit; `conversation_not_found`,
  `no_pool_number`, `source_not_found` (`relayFanOut.ts:846-882`), `nothing_to_relay` (`:1124`),
  `source_vanished` (`:1494`), `no_continuation` and `retry_row_not_found`
  (`sendReconcile.ts:1125-1128`) do not. A generic "Wasn't resent" would be true for all.

### L-4. Dead and duplicated attempt facts

- `ProviderSendFailedError.facts` / `.attemptedAt` and `SendAcceptedNotRecordedError.facts` are built on
  every send (`app/src/services/sendMessage.ts:607-614`) and read by no production code (the only
  reader of the typed errors uses `.classification`, `broadcastFanOut.ts:1039`).
- The broadcast claim recomputes the facts itself with a hardcoded `mediaCount: 0`
  (`broadcastFanOut.ts:868-877`) instead of the wrapper's
  `mediaUrls?.length ?? attachments?.length ?? 0` (`sendMessage.ts:613`). Correct today (shares carry
  no media); the day `broadcast-mms` lands, every broadcast reconcile compares 0 against the real media
  count, never matches, and ends "Not confirmed" - silently, with no test naming the coupling.
- The `never_sent` member of `SendAttemptOutcome` (`sendAttemptsRepo.ts:61`) is never written (a
  never_sent verdict moves the record to `redriven`).

### L-5. Error messages carrying provider text are now logged twice

- `ProviderSendFailedError` copies the cause's message into its own (`sendMessage.ts:247`), and the safe
  serializer emits both `message` and `cause.message` (`app/src/lib/logSerializers.ts:56`, `:76-78`).
  Every caller that logs `err` on a non-refusal send failure - tour reminders
  (`app/src/jobs/tourReminders.ts:1470-1473`), placement nudges, missed-call auto-text
  (`app/src/jobs/missedCallAutoText.ts:261-264`), the housing-fair welcome (`app/src/routes/public.ts:314`),
  and the Express handler for the staff send route (`app/src/lib/errors.ts:196-199`) - now carries the
  provider's text twice. Twilio 4xx messages for a bad destination name the number (UNVERIFIED
  wording). Pre-existing exposure, doubled; message strings are not phone-masked anywhere.

### L-6. Avoidable reads on the happy path (cost)

- `claim` re-reads the record after its own successful write (`mustGet`, `sendAttemptsRepo.ts:424`), and
  `rearm` reads the record only to copy facts the caller already holds into the index item (`:383`).
  Two consistent reads per attempt that could go. See the cost line below.

## Charter answers (no finding unless stated)

- **Callers of `sendMessage`** (typed errors; post-append failures now swallowed):
  - staff 1:1 route (`app/src/routes/api.ts:1428-1459`): refusals unchanged; a post-append failure now
    answers 201 instead of 500 (removes a staff-retry double text); `SendAcceptedNotRecordedError` and an
    unknown `ProviderSendFailedError` still answer 500, so a staff Retry can still double-text (Stage 2,
    filed); the follow-on-batch ERROR logs only `err.name`, now the wrapper's class name.
  - tour reminders, placement nudges, missed-call auto-text, messaging.retrySend: non-refusal still
    rethrows under a claim/marker (not retried, as before); post-append failures no longer fail the job.
  - housing-fair welcome (`public.ts:297-316`): a post-append failure now counts as sent (fixes a
    duplicate welcome); an append failure still leaves `housing_fair_welcomed` unset (pre-existing).
  - relay announcements and the voice verification text call the ADAPTER directly: unaffected by the
    typed errors.
  - `beforeProviderSend` is used only by broadcast; a throw becomes `SendNotAttemptedError`.
- **Twilio timeout pinned to 30 s**: no behavior change - it equals twilio-node's own default
  (`node_modules/twilio/lib/base/RequestClient.js:47`, `DEFAULT_TIMEOUT = 30000`) on both the default
  and the redirecting client; it is a socket-idle timeout, not a wall-clock bound (filed in
  `send-attempt-rearm-residues`).
- **Slot codes** (`send_unconfirmed`, `send_retryable`, `redrive_refused`, `sms_sending_disabled`,
  `enqueue_failed`): every dashboard consumer found handles them (row, chip, recital, results badge, retry
  hint, skipped total); the server derives stats from the map everywhere; no seed writes them (the lean
  and full worlds never exercise "Not confirmed"); no export exists. The one consumer that mishandles
  their meaning is `priorRecipientContactIds` (M-1).
- **Slot writers the diff did not touch**: the status webhook's broadcast rollup matches by
  conversationId+tsMsgId and moves only `queued`/`sent`, so it cannot touch a reconciling slot; the relay
  status path resolves only through a `relaysid#` pointer. The residual gate-then-close window is filed.
- **DynamoDB**: every expression read lists exactly the aliases it uses; reserved words (`owner`,
  `status`, state) are aliased; the transaction attribution reads index 0 (the record) as designed; the TTL
  attribute matches the table (`app/src/lib/tables.ts:236`); the messages table has no GSI and no stream
  consumer, so the new families leak into no index or side effect; no hot partition at the pacing rate.
- **Cost per recipient, happy path**: broadcast +5 DynamoDB round trips (claim TransactWrite + Get, re-arm
  Get + TransactWrite, finish Update) minus 1 (slot + stats now one write) = +4; relay leg +7 (claim 2,
  attempt clock 2 writes of the source row, re-arm 2, finish 1). Each attempt writes 2 index items (claim
  and re-arm), 30-day TTL. For a large share the merged slot+stats write saves one write of the whole
  broadcast item per recipient, so broadcast WCU likely goes DOWN.
- **Hop count**: the deepest chains traced (broadcast route -> 3 passes -> 3 checks -> re-drive; rung ->
  2 transients -> 3 checks -> re-drive) reach 7 of `MAX_HOP_COUNT` 10 (`app/src/jobs/jobs.ts:37`).
- **Deploy with in-flight jobs**: old payload shapes parse; an OLD worker would delete a `send.reconcile`
  message as poison (`app/src/adapters/sqsJobConsumer.ts:159-170`), but the single-host compose recreate
  does not overlap old and new workers. The real deploy hazard is H-1.
- **PII**: every new log line routes keys through `safeRecipientKey` / `logSafeMemberKey`; no body or phone
  in a new line. Known and filed: raw keys in the record/index `owner`, the unkeyed digest, raw keys in
  continuation/re-drive payloads. `fake-twilio` still listens on all interfaces with unauthenticated
  control routes (`fake-twilio/src/index.ts:6`), pre-existing; the two new routes only inject failures.
- **E2E seam in deployed envs**: cannot fire (every worker sets `JOBS_QUEUE_URL`); see L-2 for local.
