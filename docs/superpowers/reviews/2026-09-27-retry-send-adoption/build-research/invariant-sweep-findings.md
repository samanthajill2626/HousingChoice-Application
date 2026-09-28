# Reader E - invariant sweep: who else reads or writes the state this branch moves (findings)

Read-only delta research for the build orchestrator of `feat/retry-send-adoption`
(worktree `W:\tmp\retry-send-adoption`, HEAD `d93aa5ad`, code identical to
`main@3dbb5740`), against spec revision 5 and plan revision 4. Swept app/src,
app/scripts, app/test (setup, helpers, suites), dashboard/src, e2e, fake-twilio,
scripts/ and infra/ - not only the plan's files. Nothing was run, edited or
committed. Byte-exact quotes for every citation are in the gitignored
companion `.superpowers/sdd/research/delta-invariant-reference.md` (section
letters A-G below match its headings). Readers A, B and C are not repeated.

## Headline

- Five findings, none blocking. Two want a handback / deploy line (F1, F4),
  two are one-line comment or log edits inside files the plan already touches
  (F2 in T1, F3 in T2), one answers the brief's item 4 (F5).
- Item 3 is SETTLED: no code path rewrites an existing live message row
  wholesale; `retry_outcome` and `retry_root` cannot be dropped (section C).
- Item 2 is SETTLED: the `retrychild#` family is invisible to every existing
  reader (the messages table has no GSI and no stream consumer; every Query is
  exact-partition; every Scan either filters on attributes the pointer lacks or
  deletes everything) and no central pointer-prefix list exists to extend
  (section B).
- Item 1: the only behavior-changing readers of a message row's `broadcast_id`
  are the two the brief names (the rollup gate and `isBroadcastRowFor`); both are
  accounted for by the spec (R7 cost) and the plan (deviation 7). No stats,
  share-results, share-skip, listing-send, activity or dashboard reader reads a
  message row's `broadcast_id`.

## Findings

### F1 (LOW) Deploy boundary: a pre-deploy `messaging.retrySend` redelivered after the deploy is no longer suppressed and can text twice

- Surface: `app/src/jobs/retrySend.ts:203-227` (the run-once marker is written
  BEFORE the send) and `:329-340` (every non-refusal error is rethrown after
  it); `app/src/adapters/sqsJobConsumer.ts:12-17` with
  `infra/modules/jobs/main.tf:36-41` (120 s visibility, 5 receives: a throwing
  job is redelivered for roughly 8-10 minutes). Reference G1-G5.
- What changes: today a retry job that throws after its marker (an unknown
  provider outcome, `SendAcceptedNotRecordedError`, a presign throw) or whose
  DeleteMessage failed is redelivered and SUPPRESSED by the marker - the anchor
  bug. After the deploy the new job never reads the marker, and a pre-deploy
  attempt has no attempt record (the gate reads absent) and no `retrychild#`
  pointer (and an unknown or accepted-not-recorded send has no row at all), so
  the redelivery claims and SENDS. For a not-attempted or retryable cause that
  is the intended fix; for an unknown outcome it is a possible second text; for
  sent_unrecorded or a lost DeleteMessage it is a certain one. The worker drains
  in-flight handlers on SIGTERM (`app/src/worker.ts:530-551`), so the exposure is
  the jobs that threw in the ~10 minutes before the deploy, plus any job killed
  past compose's stop timeout.
- Not covered: spec section 7's marker bullet covers post-deploy redeliveries
  only; plan T9's pre-deploy notes cover missing pointers only.
- Recommendation: a handback deploy note (T9 Step 5): "retrySend jobs that
  threw in the ~10 minutes before this deploy are re-run by the new code; one
  whose outcome was unknown or accepted-not-recorded may text the tenant twice -
  deploy when the worker log shows no recent retrySend job failure." Optional
  belt for the planner to rule on (T4, reads only the unfenced
  `getJobExecutionMarker`): when the gate reads NO record and
  `getJobExecutionMarker(jobId)` is true, a pre-deploy run already passed its
  marker (this job never writes one again) -> WARN and return, which is exactly
  the pre-deploy behavior for exactly those jobs; one Get per first run,
  removable a release later. Severity per Cameron's scale: a double text, rare
  and bounded.

### F2 (LOW) Doc comments that now contradict the data (`broadcast_id` "absent on 1:1")

- Surface: `app/src/services/sendMessage.ts:329-334` ("absent on every
  non-broadcast send (relay + 1:1)"), `app/src/repos/messagesRepo.ts:1127-1130`
  ("Absent on 1:1 / relay messages"), `app/src/repos/messagesRepo.ts:722-725`.
  Reference A8, A10, A11. The fenced `app/src/routes/webhooks/twilio.ts:3520-3528`
  ("when THIS message belongs to a broadcast") reads the same way.
- What changes: after this branch every retry row of a share text (automatic,
  adopted, manual) is a one-to-one row that carries `broadcast_id`.
- Recommendation: T1 already edits both unfenced files - reword the three
  comments in ASCII (the sendMessage.ts block carries U+2014 and arrow
  characters, so every touched line must be rewritten ASCII); name the fenced
  twilio.ts comment in the handback beside R7's one line.

### F3 (LOW, optional) `heldBy`'s `other` holder label now names a share-retry row as the share's own row

- Surface: `app/src/jobs/sendReconcile.ts:604-610` labels any row carrying
  `broadcast_id` as `broadcast#<id>#<contact>`; the label is logged in the
  `sid_held_elsewhere` verdicts at `:740`, `:748` and `:877`. Reference A5-A7.
- What changes: a share-retry row (with `retry_of`) and the share's own row now
  produce the same label, so a `sid_held_elsewhere` ERROR no longer tells which
  row holds the SID. Log only - no decision reads the label.
- Recommendation: T2 edits this function anyway: label a row with `retry_of`
  as `message#<conversationId>#<tsMsgId>` (or a `retry#` form). Accepting it is
  also fine; say so in the handback.

### F4 (LOW) Rolling back past this branch is not safe while `retry_send` state exists

- Surface: `app/src/repos/sendAttemptsRepo.ts:163-165` and
  `app/src/lib/sendFingerprint.ts:48-49` (pre-branch `recipientKeyOf` returns
  `owner.memberKey`, undefined for an unknown kind, and `hashRecipientKey`
  calls `startsWith` on it); `listByRecipient` (`:585-612`) resolves EVERY index
  item through `get(owner)` -> `recordKey`. Reference F1-F4.
- What changes (on a rollback only): a broadcast or relay reconcile whose
  recipient has a `retry_send` index item newer than its sibling lower bound
  throws in `lookup` and cycles to the DLQ; pre-branch `parseOwnerRef` throws on
  every in-flight `send.reconcile` envelope for a `retry_send` owner; a
  `reconciling` or `redriven` retry record strands. The window is short (index
  items are read only from `attempt - 150 s` onward, and no new ones are
  written after the rollback) but it breaks OTHER owners' reconciles.
- Recommendation: a handback deploy note ("a rollback past this branch should
  wait for the jobs queue to drain `send.reconcile`; for ~5 minutes after it a
  reconcile to a recipient with a fresh retry attempt can fail"). No code change.

### F5 (INFO) Item 4 answered: nothing else writes the retried row's `retry_due_at` while the job or its reconcile is live; the spec's "only competing writer" sentence is imprecise; every outcome is benign

- Writers of `retry_due_at` (reference C3, D1-D4, D9):
  (a) `updateDeliveryStatus` with `retryDueAt` (`twilio.ts:3462-3467`,
  `messagesRepo.ts:2849-2866`) commits only on a transition INTO
  undelivered/failed (`ALLOWED_PRIOR`, `messagesRepo.ts:133-143`). The retried
  row is already terminal, so a duplicate, late or redelivered 30003 callback
  runs `decideOneToOneRetry` (read-only) and then writes and enqueues nothing
  (the arm is gated on the transition, `twilio.ts:3560`).
  (b) RSW's unconditional withdrawal (`twilio.ts:3638-3641`) runs only inside the
  same request whose enqueue threw; the job runs at `runAt`, at least +10 s
  (lane) or +60 s later, so it reads the sentinel as its `expect` and its
  REFRESH/WITHDRAW win over it - correct, because a job IS live then.
  (c) The manual Retry route never writes the pressed row
  (`api.ts:1567-1697`). (d) No seed, fixture, import or script writes it; the
  only other annotate callers (`mediaMirror.ts:160`, `twilio.ts:805`,
  `backfill-media-content-types.ts:603`) write media on inbound rows.
- The races the spec does not name are same-owner and cross-process: the
  reconcile's re-drive REFRESH (plan T2, after `enqueueOrClose`) against the
  re-driven job, which is dispatched IMMEDIATELY (`scheduler.ts:165-204`
  defers only to a macrotask; SQS delay 0); and a takeover hand-off, whose
  check 0 is also delay 0, against the job's own REFRESH. Every interleaving
  resolves: a WITHDRAW that loses to a REFRESH is retried once from a fresh
  read and wins; a REFRESH that loses to a WITHDRAW or a newer REFRESH is
  dropped. 'lost' needs two interleaved moves between the WITHDRAW's two tries,
  and no owner writes twice in that span.
- Staff-visible residue, all inside the accepted wontfix class
  (`one-to-one-retry-promise-outlives-job-decline`): a re-drive REFRESH that
  lands after the re-driven job already refused or rejected re-promises
  "will retry" for up to 5 minutes on an ended chain; the hand-off REFRESH keeps
  Retry hidden for up to ~4 minutes after a `redrive_refused` or re-drive
  `enqueue_failed` close ("Retry stays available" is true at the route at once,
  on screen when the promise expires); a REFRESH that lands after a success
  re-promises a row the collapse already hides, so a stale-tab press gets
  `retry_pending` (RSW's time guard answers first) instead of `superseded`.
- Test note: the harness's `getByProviderSid*` and `getByTsMsgId*` return the
  LIVE stored object (`twilioWebhookHarness.ts:1311-1320`, `:1453-1460`), so a
  job's or reconcile's `expect` is always current in fake-backed tests: the
  lost-condition branches are provable only with a stale copy or a spy (plan T1
  Step 6 does this; T2 and T4 cases that claim a lost write must do the same).
- Recommendation: the handback states the corrected sentence and the three
  residues; no code change.

## Checked, harmless (one line per surface)

Item 1 - readers of a message row's `broadcast_id`:
- `twilio.ts:3529-3545` -> `rollIntoBroadcast` (`:3853-3906`): the slot match is conversationId + tsMsgId (`:3887-3888`), so a share-retry row always misses - two broadcast reads and one 2.5 s wait per transitioned receipt (sent AND terminal), no slot or stat write, no double count; for a share-retry that fails 30003, the next attempt's enqueue (runAt fixed at decision time) happens 2.5 s later in the same request. Known (plan T9).
- `twilio.ts:3882` "broadcast not found" WARN: unreachable for a sent share - only drafts delete (`broadcasts.ts:884-905`).
- `twilio.ts:3543` rollup-failure ERROR: newly reachable for share-retry receipts, only on a broadcasts-table fault, as for the share's own rows.
- `broadcastFanOut.ts:1296-1306` `isBroadcastRowFor`, callers `broadcastFanOut.ts:1387` and `sendReconcile.ts:597`: plan deviation 7 guards it; no legitimate share row carries `retry_of` (the fan-out, the broadcast adoption and the broadcast re-drive never pass `retryOf`).
- `sendMessage.ts:443`, `:658` and `messagesRepo.ts:2535`: pass-through stamp only; no other effect in `sendMessage`.
- `oneToOneRetryDecision.ts`: never reads `broadcast_id` (only `automated`, `recipient_contact_id`, `retry_attempt`, the origin).
- `contactTimeline.ts`: `broadcast_id` is not projected; `:687` reads `broadcastId` from a `broadcast_sent` ACTIVITY payload, not a row.
- broadcasts routes (results, delete), `listingSendsRepo` / `recordPropertySent`, `units.ts:176`, `:208`, dashboard `routes/broadcasts/*`, `api/types.ts` `ListingSendRow` and activity types: read broadcast items, listing sends or activity, never message rows; a retry writes none of those.
- `GET /api/conversations/:id/messages` (`api.ts:2183-2215`) returns raw rows; no dashboard reader of a message's `broadcast_id` exists.
- tests: `broadcastApi.test.ts:339/374/417/448/504` (first row with `broadcast_id`, flows without retries), `broadcastFanOut.test.ts:241` (every), `sendReconcile.test.ts:3045-3050` (T2 adds the `retry_of` row).

Item 2 - messages-table scanners and resets vs `retrychild#`:
- `tables.ts:205-212`: the messages table has NO GSI; its stream is enabled but nothing consumes it (`events.ts:14-16`; infra only outputs `stream_arns`) - the pointer is indexed nowhere.
- `listByConversation*` and every caller (`inbox.ts:935`, `unreadFeed.ts:575`, `contactTimeline.ts:1262`, `api.ts:2196`, `extraction.ts:456`, `relayFanOut.ts:877`, `relayQueuedMessages.ts:58`, `sendEmailMessage.ts:434`): exact-partition Queries; a `retrychild#` partition never equals a conversationId.
- `devReset.ts:36-63` (POST `/__dev/reseed`, the e2e reseed, the performance reseed) and `scripts/wipe-dev-data.mjs:163-205`: delete EVERY item of every table - no residue for a later e2e run; no schema change, so no stale-lane-schema risk.
- `performanceSeed.ts:80-98`: deletes two lean group partitions after a full reset; seeds carry no retry lineage.
- `backfill-media-pointers.ts:55-66`, `backfill-media-content-types.ts:449-459`: FilterExpression on media attributes the pointer lacks.
- every other Scan (`backfill-unread-flag`, `measure-unread-contact-coverage`, `backfill-relay-optout-flag`, `conversation-automation-census`, `enable-conversation-automation`, `retire-paused-tour-reminders`, `backfillConsentMethod`, `backfill-broadcast-list-partition`, `poolNumbersAudit.mjs`, `journalSweep.ts`, the repos' Scans): other tables.
- `import/apply.ts:693-722` retract: queries the conversation partition and deletes only an all-imported thread (a live retry row is foreign and blocks it); imported rows never carry `retry_of`.
- no `begins_with` or prefix allow/deny list over the messages table exists (the one `begins_with`, `messagesRepo.ts:3345`, stays inside `emailevent#`).
- `app/test/globalSetup.ts` / `sweepLedgerResidue` (`helpers/dynamoKeyLedger.ts`): drops whole per-file databases.
- seeds (`lib/seed/*`, `seedData.ts`, the performance seed) write no retry lineage; `seedMatrix`, `seedLive`, `seedProfile` scans are unaffected; no dev route or e2e fixture reads a raw partition.
- `tables.ts:209-236` TTL comment lists only `expires_at` families; `retrychild#` has none (like `sid#`), so no entry is needed.
- `rail-verify.ts`, `profile-inbox.ts`, `gen-tables.ts`, `db-seed.ts`, `db-create.ts`: no message-item reads.

Item 3 - writers of existing message rows (none wholesale):
- `messagesRepo.ts`: every PutCommand targets a pointer or marker partition (the list is in reference C); `append`'s row Put is conditioned `attribute_not_exists(tsMsgId)` (`:2638`); every later message-row write is an UpdateCommand SET/REMOVE of named attributes (`annotateMessage` `:3210`, `updateDeliveryStatus` `:2837`, `setMessageActualTransport` `:3420`, the relay recipient maps from `:3666`, call fields); no BatchWrite in the file.
- `import/apply.ts:406-433`: BatchWrite Put of IMPORTED rows keyed by the Quo id - never a live row; imported outbound rows are `sent` and never retried.
- `dev.ts:1027-1049`: Put of a NEW fixture row. No module outside `messagesRepo` writes the messages table except `sendAttemptsRepo` (own partitions), import, the dev fixture, seeds and resets.
- harness fakes mutate stored rows in place (`twilioWebhookHarness.ts:1472-1474`, `:1546`, `:1681-1769`).

Item 5 - `retry_of` / `retry_attempt` readers:
- `Timeline.tsx:2060-2075` collapse: an adopted row (terminal failure or not) hides its parent - one bubble; an adopted terminal failure shows the plain failure with Retry (no promise), as R4 states; the manual-plus-automatic fork renders both (pre-existing, reader C D9); a late adoption sorts at its send time (`contactTimeline.ts:430`, `at` from tsMsgId / provider_ts).
- `oneToOneRetryDecision.ts:125`: adopted rows carry `retry_attempt` and `retry_window_start`, so the cap and the window hold (R8); an adopted terminal failure never reaches it - the open issue `status-callback-passive-match-for-pending-reconcile`, inherited per spec section 5.
- `twilio.ts:3574`: a log field. `contactTimeline.ts:449`, `:452`: the projection.
- `inbox.ts:929-941` and `deriveLatest` (`:662`): newest row by tsMsgId with the same body; `created_at` (append time) only feeds the inbound resurfacing test.
- `unreadFeed.ts:575-578`: inbound-only predicate; outbound never touches unread counts.
- the adoption's inbox touch (`conversationsRepo.ts:1623-1646`) is status-preserving, forward-only and sets no preview, where `sendMessage`'s (`:1563-1576`) re-opens the thread and sets the preview: spec-mandated ("the preserving inbox touch"), cosmetic (the inbox derives the preview from the newest row); the inbox reorders by send time, only later.
- `media#` gallery pointers: an adopted row with `media_attachments` indexes the same attachments again - pre-existing for every one-to-one retry through `sendMessage` (only relay retry rows skip them, `messagesRepo.ts:2698-2718`).
- extraction and `sendEmailMessage` readers: duplicate-body retry rows are pre-existing.

Item 6 - the stored `owner` map:
- `toRecord` (`sendAttemptsRepo.ts:214-216`) casts `owner`, no per-field typing; the DocumentClient returns `attempt` as a number; `gateFor` (`sendAttemptGate.ts:30-39`) is kind-agnostic.
- `listByRecipient` (`:585-612`) -> `get(owner)` -> `ownerKey` / `recipientKeyOf`: T2 adds both arms (F4 is the rollback case only).
- no dev endpoint, script or e2e reads raw records; the tests' `rawRecord` and parity ternaries are in T2.
- the index item stores the raw owner (a `phone#` recipientKey in clear) - the same posture as a broadcast owner's `contactKey`; SOR D12 governs queue payloads, which carry only `recipientKeyHash`.

Item 7 - other surfaces:
- dashboard: `Timeline.tsx:88-139` `sendFailureMessage` is the only consumer of the retry route's codes (`EmailComposer.tsx:90` has its own; `api/client.ts` has no generic 409 path); no existing ApiError uses `superseded` or `retry_unresolved` (`superseded` elsewhere is a tour-reminder suppression reason, not an API code); `ContactCommsPane.tsx:303-307` is the one Retry caller.
- e2e: no spec reads `job#` markers; `one-to-one-30003-retry.spec.ts` stays valid (its press answers `retry_pending` from the time guard first; lineage via `find` / `toBe`); `e2e/performance/mutationCatalog.ts:71` lists the route only as a mutation.
- `registerHandlers.test.ts` and `relayRetryLeg.test.ts:2149` register handlers and never dispatch the retry job.
- infra metric filters (`observability/main.tf:34-112`) key on `level >= 50` and event names, never on retrySend message text; the new ERRORs feed the error-logs alarm by design (R9).
- SSE: the worker bridges every event name (`eventBridge.ts:42-45`), so the job's and the reconcile's `message.persisted` reach dashboards.
- a share ROOT row (a one-to-one text carrying `broadcast_id`) CAN carry `retry_outcome` (attempt 1 unresolved), despite R5's "never on ... broadcast rows"; no broadcast-side reader reads it - the handback should not repeat R5's phrase.
- a retry row appended before the deploy carries no `broadcast_id`, so a chain straddling the deploy loses share attribution from that row on (Branch B's repair walk already plans for unstamped rows).
