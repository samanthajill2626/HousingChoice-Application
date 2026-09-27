# Code review round 1 - adversarial, plan-blind (HEAD 83308e15, base bd752bd0)

Reviewer: adversarial child (Claude Opus 5.5, 1M context), PLAN-BLIND by the
standing rule: its brief carried the diff package paths, repository access and
the standing charter only (architecture/maintainability; races; security and
privacy; unintended consequences swept across every consumer and mutator of the
touched state), plus a one-sentence feature description. Record note: the
reviewer returned this report as TEXT (the harness refuses report files from
subagents); the orchestrator landed it here verbatim in substance.
Adjudications are in `r1-adjudications.md`.

Method: read the full source diff at HEAD and the callers of every touched piece
of state. Each finding marked CONFIRMED was reproduced with a throwaway test run
on its own (`cd app && npx vitest run test/zz-adv-N...`). All six zz-adv files
were deleted and `git status` is clean. No suite, e2e or lane was run; nothing
was killed. The harness globalSetup created and dropped its own per-file
DynamoDB Local tables. No AWS_ACCESS_KEY_ID was exported. The design docs were
not read; docs/issues was read only at the end, to mark which findings are not
already recorded as residues.

## Findings (most severe first)

**ADV-1 CRITICAL (impact: the same text sent twice; likelihood low) - CONFIRMED
(the interleaving was reproduced in the harness).**
- Where: the claim TTL decision, app/src/repos/sendAttemptsRepo.ts:347-349. The
  invariant it relies on, which is false: app/src/lib/sendOutcome.ts:20-25 and
  app/src/adapters/messaging.ts:683-690 - both say "a claim older than the TTL
  can only belong to a dead or overrunning call". Relay leg order: claim at
  relayFanOut.ts:1942, then DynamoDB writes at :1983 and :2013, then the
  provider call at :2017-2021. Broadcast order: claim at broadcastFanOut.ts:833,
  then the send at :872, but the send wrapper first does its own DynamoDB reads
  and writes.
- Mechanism: attemptedAt is stamped BEFORE work that has no bound. The DynamoDB
  client has no request timeout (lib/dynamo.ts:65-78; smithy's requestTimeout
  defaults to 0). The Twilio "timeout" is an axios/https-agent socket-idle
  timeout (twilio RequestClient.js:92-99, 173), not a bound on the whole
  request. So a live attempt can be older than 30 s before it even calls the
  provider. A second pass that meets the claim at that point takes it over. The
  reconcile then finds nothing at the provider, because the provider has not
  been called yet. It rules never_sent and re-drives. The stalled pass then
  resumes and sends too; it never re-checks its claim.
- Where the concurrent first pass comes from: relay.numberReady has no run-once
  marker and re-flushes when redelivered (relayNumberReady.ts:111-113).
  flushQueuedMessages enqueues relay.fanOut for every row still queued_pending
  without checking whether its flip transitioned (relayQueuedMessages.ts:88-99).
  Two overlapping runs therefore enqueue two first passes with different jobIds.
- Interleaving: (1) pass A claims member Bob at T0, then hangs inside
  setRelayRecipientAttemptedAt; (2) at T0+31s pass B (different jobId) finds the
  claim stale, takes it over and hands off; checks 0 and 1 run immediately and
  ask to continue; (3) check 2 at T0+240s finds nothing: never_sent, marked
  redriven, re-drive enqueued; the re-drive claims attempt 2 and sends; (4) pass
  A resumes and sends again.
- Tenant experience: the relay member gets the same message twice.
- Evidence (zz-adv-6):
  ```
  SENDS_TO_BOB_BEFORE_PASS1_RESUMED 1
  SENDS_TO_BOB_TOTAL 2 ["Alice: is the unit still available?","Alice: is the unit still available?"]
  RECORD {"state":"done","outcome":"sent","attemptNo":2,"redriveCount":1}
  ```
- It needs two rare conditions together: two concurrent first passes AND a
  stall of about 210 s or more between the claim and the provider call.
- Fix direction: re-arm the claim immediately before the provider call with a
  conditional write (SET attempted_at=:now WHERE state=attempting AND
  attempt_no=:no AND attempted_at=:claimAt); abort the send if that write fails
  (for broadcast, the wrapper calls a hook right before
  adapter.sendPreparedMessage). Give the DynamoDB client a requestTimeout with
  throwOnRequestTimeout. Correct the two comments.

**ADV-2 HIGH (by the charter's wording CRITICAL-class: a real send mislabeled;
graded HIGH because the window is narrow) - CONFIRMED.**
- Where: closeUnresolved writes the slot BEFORE the fenced record close
  (sendReconcile.ts:878-893, slot at :886). sendReconcile's own
  closeRedriveRefused does the same (:1005-1019). The job has no run-once marker
  (registerHandlers.ts, sendReconcile.ts:10-17). recordCheck deliberately lets a
  duplicate of the same check through (sendAttemptsRepo.ts:429-435). This
  contradicts the stated guarantee "every write it makes is idempotent or fenced
  on the attempt record". The enqueueOrClose redriven branch already writes the
  record first (T10-14); these two closes do not.
- Interleaving: (1) delivery B of the last check passes recordCheck, then its
  list call hangs; (2) delivery A of the same check rules never_sent, marks the
  record redriven and enqueues the re-drive; (3) the re-drive claims attempt 2
  and is mid-send; (4) B's list returns a 5xx, so B rules provider_unreachable
  and closes unresolved - closeRecipientIfQueued moves the still-queued slot to
  failed/send_unconfirmed; B's record close then loses its fence; (5) the
  re-drive's text goes out and its row is appended, but its slot write (from
  queued) no longer moves; (6) finalize flips the share to failed with
  "Couldn't confirm any text went out".
- Triggers are the ones the design says are safe: an SQS duplicate, or a check
  that outlives the 120 s visibility timeout (a check can walk 5 list pages with
  a 30 s timeout each - see ADV-4).
- Tenant/staff experience: the text went out and the 1:1 thread shows it, but
  the share row reads "Not confirmed" and the share reads Failed - inviting the
  manual resend this branch exists to prevent. The same pattern on a versioned
  relay row leaves the leg failed/send_unconfirmed permanently, because the
  forward-only writer keeps the first terminal code.
- Evidence (zz-adv-3):
  ```
  PROVIDER_SENDS 1
  ROWS_IN_1TO1 1 queued
  SLOT {"status":"failed","errorCode":"send_unconfirmed"}
  RECORD {"state":"done","outcome":"sent","attemptNo":2}
  BROADCAST failed "Couldn't confirm any text went out"
  ```
- Fix direction: write the record first (fenced on reconciling + attemptedAt)
  and touch the slot only if that close wins; to stay crash-safe, have the
  superseded path re-apply the idempotent slot close when the record is done
  for THIS attemptedAt with outcome unresolved or redrive_refused.

**ADV-3 MEDIUM - CONFIRMED (DynamoDB Local; the SDK retry was simulated at the
document client).**
- Where: transition() maps every ConditionalCheckFailedException to false,
  meaning "another writer" (sendAttemptsRepo.ts:354-371). The callers then act
  on that false: broadcast handToReconcile (broadcastFanOut.ts:608-624, "hand-off
  fence lost - the takeover owns the record"); relay handToReconcile
  (relayFanOut.ts:2098-2112); reconcile recordCheck (sendReconcile.ts:396: the
  chain ends); markRedriven (:1041-1047: no re-drive is enqueued); takeOver
  callers (no hand-off); finalizeStatus (won:false, so no unit audit row and no
  terminal emit).
- Mechanism: UpdateItem carries no idempotency token. When the SDK retries a
  write that already committed (after a 5xx or a socket reset), the retry fails
  its own condition.
- Consequence: the record is `reconciling` (our own write), but no reconcile
  chain is ever enqueued and nothing carries the recipient; a `reconciling`
  record is never taken over, and later claims are refused as not fresh; the
  send outcome is never decided (the text may have gone out); the slot stays
  queued and the broadcast stays `sending` forever. Not the same as the recorded
  sweeper residue (that covers an applied-then-THROWN takeOver; here the code
  positively decides "someone else owns it").
- Evidence (zz-adv-5):
  ```
  SIMULATED_RETRY true
  RECORD {"state":"reconciling","attemptNo":1}
  RECONCILE_ENQUEUED 0 CONTINUATIONS 0
  FENCE_LOST_LINES 1
  SLOT {"status":"queued"}
  BROADCAST_STATUS sending
  LATER_CLAIM refused false
  ```
- Fix direction: on ConditionalCheckFailedException, re-read consistently (or
  use ReturnValuesOnConditionCheckFailure: ALL_OLD) and report success when the
  item already shows this transition for this attempt.

**ADV-4 MEDIUM - CONFIRMED.**
- Where: lookup walks every page up to RECONCILE_MAX_PAGES BEFORE it judges any
  candidate, and closes page_bound even at check 0 (sendReconcile.ts:752-774,
  bound at :771). The list is newest-first, yet the walk never stops at the
  window's edge.
- Consequence: a recipient with more than 5 pages of OLD history from the sender
  (more than 5000 messages at PageSize 1000) ends unresolved/send_unconfirmed on
  the FIRST check, even when the orphan sits on page 1 inside the window - never
  adopted, never re-driven, "Not confirmed" although the text went out. Every
  check for any heavy-history recipient also walks up to 5 pages, which makes
  the ADV-2 visibility overrun plausible. The threshold scales with the
  provider's real page size, which the code itself marks UNVERIFIED.
- Evidence (zz-adv-4, listPageSize 2 standing in for 1000; 12 old messages plus
  the orphan):
  ```
  LIST_CALLS 5
  PAGE1_SIDS ["SMorphan-1","SMold-11"]
  RECORD {"state":"done","outcome":"unresolved","cause":"page_bound"}
  SLOT {"status":"failed","errorCode":"send_unconfirmed"}
  ```
- Fix direction: stop paging once a page's oldest createdAt is before
  windowStart; rule page_bound only when in-window messages remain past the
  bound; return `continue` instead of closing on a check that is not the last.

**ADV-5 LOW - CONFIRMED.**
- Where: a relay-LEG re-drive pass keeps only carried members still on the
  current roster (relayFanOut.ts:1139-1141). A carried member who has left is
  silently dropped: no closeRedriveRefused (early returns only), and it returns
  at :1455.
- Interleaving: the reconcile's pre-check sees the member (an eventually
  consistent read, sendReconcile.ts:459, 990-997); the member is removed before
  the re-drive pass runs.
- Consequence: the record stays `redriven` and the slot `queued` (with
  attemptedAt) forever; the bubble ages into "Queued - not confirmed" instead of
  "Wasn't resent: ... the member left". Contradicts send-reconcile-job-residues
  item 5; not among the recorded early-return residues.
- Evidence (zz-adv-2): `SENDS: 1 (Bob's first leg only)`; `RECORD
  {"state":"redriven","redriveCount":1}`; `SLOT {"status":"queued","attemptedAt":...}`;
  `REDRIVE_REFUSED_LINES 0`; `PENDING_DELAYED (none)`.
- Fix direction: on a redrive pass, run closeRedriveRefused('member_removed')
  (record first, then slot) for every carried key missing from `recipients`.

**ADV-6 LOW - CONFIRMED.**
- Where: a throw in the RECORD phase AFTER the slot write moved the slot skips
  afterSend (e.g. finishAttempt throws at broadcastFanOut.ts:898, or
  recordRecipientOutcome times out after it applied). The catch hands the SID to
  reconcile (:924-933); the adoption finds the slot already moved and returns
  'skipped' before step 3 (:1354).
- Consequence: the listing_sent milestone ("Property sent") and the
  listing-send row are lost permanently for a tenant who WAS texted; the tenant
  timeline and the unit's "Sent to tenants" list miss them; the A2P token is not
  spent. Not in the recorded residues (those record only the adoption's lost
  audit row).
- Evidence (zz-adv-1): `RECORD {"state":"done","outcome":"adopted","sid":"SMfake-out-1"}`;
  `SENT 1`; `LISTING_SENT_MILESTONES 0`; `LISTING_SEND_ROWS 0`; `BROADCAST_STATUS sent`.
- Fix direction: once the slot has moved, run recordPropertySent (both writes
  are upserts) even if finishAttempt fails - e.g. wrap finishAttempt in
  guardWrite, as plan deviation 3 intends; or let the adoption run the property
  rows when the slot already carries this row's tsMsgId.

**ADV-7 LOW - PLAUSIBLE (DynamoDB Local is always strongly consistent, so this
cannot be reproduced locally).**
- Where: the FIRST pass reads the broadcast with an eventually consistent
  getById milliseconds after the route's markSending (broadcastFanOut.ts:397-401,
  "The first pass keeps the cheap read").
- Consequence: a stale read sees the draft (recipients {}), sends nothing, and
  the job marker stops any retry; the new finalize then defers on the queued
  slots forever, so the share sits `sending` with nobody texted. Main flipped it
  to `sent` with nobody texted: the race predates the branch, but the failure
  mode changed.
- Fix direction: use getByIdConsistent on every pass.

**ADV-8 LOW - found by code reading.**
- markFailed('enqueue failed') is unconditional (broadcastsRepo.ts:613-639;
  routes/broadcasts.ts:765-771). If that enqueue failure was ambiguous and the
  SQS message actually landed, the job still texts everyone. The conditional
  finalize (finalizeStatus requires `sending`) can no longer flip the status, so
  the share shows Failed while every text went out. Main's markSent flipped it
  back.
- The same class as ADV-3: a finalizeStatus false negative skips the unit audit
  row and the terminal SSE emit.

**ADV-9 LOW (privacy / a comment that is wrong).**
- hashRecipientKey and recipientDigest are unkeyed sha256 over a phone
  (sendFingerprint.ts:31-40). The NANP number space can be brute-forced in
  seconds, so `phonehash#...` in the reconcile payloads and in the INFO line
  "owner recipient not found" (sendReconcile.ts:373-376 logs payload.owner) is
  effectively a phone number.
- sendFingerprint.ts:30 claims the record never holds a phone. It does: the
  record's and the index item's `owner` map keep the raw `phone#<E164>` key.
- Fix direction: key the hashes with an HMAC secret, and correct the comment.

**ADV-10 LOW (maintainability).**
- gateFor and GateResult are three byte-identical copies (broadcastFanOut.ts:256,
  relayFanOut.ts:1663, relayRetryLeg.ts:395; md5 identical);
  sendAttemptsRepo.claim re-encodes the same state machine a fourth time, so
  drift is likely.
- Two functions are both named closeRedriveRefused with OPPOSITE write orders:
  relayFanOut writes the record first; sendReconcile writes the slot first (the
  ADV-2 class).
- ProviderSendFailedError.facts/.attemptedAt and SendAcceptedNotRecordedError.facts
  are computed on every send and read by nothing; they duplicate the broadcast
  site's own fact computation, and the two can drift.

## Sweep: consumers and mutators checked per touched piece of state

- Broadcast recipient slots: route markSending (seeds the slots); fan-out
  writes - fences and refusals (blind setRecipient + bumpStats), onRejected,
  recordRecipientOutcome (sent, defer), closeRecipientIfQueued (cap, hand-off
  failure, second unknown); reconcile - adoptBroadcastRecipient, closeSlot;
  webhook rollIntoBroadcast (conditional queued/sent, carrierSentAt); readers -
  finalize, deriveBroadcastStats (results/list routes, SSE), reconcile resolve()
  and isBroadcastRowFor, dashboard broadcastFormat, StatChips, DeliveryBadge,
  BroadcastResults.
- Broadcast stats counters: bumpStats, the recordOutcome ADD, the rollup; seeds
  in matrix.ts and performance.ts. Readers use the derived stats; finalize no
  longer reads the counters.
- Broadcast status: markSending, markFailed (route), finalizeStatus (pass,
  cap-close, reconcile afterClose). Readers: the list tabs, the last_error
  header, presentShareLabel, useBroadcastResults.
- Relay delivery_recipients slots: preflightVersionedRecipients (initialize,
  aggregation); setRelayRecipientAttemptedAt (seeds a legacy slot);
  persistRelayRecipientResult (legacy whole-slot / versioned forward-only);
  closeRelayRecipientIfUnsent, adoptRelayRecipientIfUnsent; webhook
  handleRelayRecipientStatus and setRecipientDeliverySid; the retry-row claim;
  relayRetryLeg refuseGate and closeTerminally; dashboard presentRelayDelivery,
  presentLegDelivery, stalenessClockMs, relayRetryJoin.
- relaysid#, sid# and syssid# pointers: send wrapper append; adoption append /
  claimRelaySidPointer; putRelaySidPointer; webhook lookups and retry;
  reconcile heldBy (consistent reads).
- sendattempt# and sendattemptix# items: repo only; TTL is their only reaper;
  the messages table has no GSI and no stream consumer; the devReset wipe; the
  backfill scans filter on media attributes, so they are unaffected.
- Jobs: registerAllJobHandlers (app process and worker); send.reconcile has no
  marker; hop limit 10 (enqueueOrClose handles the throw); delays up to 240 s go
  through SQS; visibility timeout 120 s, maxReceiveCount 5, then the DLQ alarm;
  the SQS consumer takes a batch of 10 and runs it with Promise.all; the
  in-process lane never redelivers; the E2E delay override is inert whenever
  JOBS_QUEUE_URL is set; the job markers on broadcast.send, relay.fanOut and
  relay.retryLeg (a re-drive gets a fresh jobId).
- SSE: broadcast.updated (pass, reconcile, finalize); message.persisted
  (adoption; announceLeg with direction from the source row; rung-root
  announce). Dashboard consumers only refetch or mark read - checked
  useContactTimeline, useRelayThread, useGroupThread, useMarkContactRead,
  useContactMedia.
- Send wrapper error types and who catches them: broadcastFanOut (typed),
  relayFanOut (adapter direct), retrySend (rethrows non-refusals),
  missedCallAutoText, tourReminders (2 sites), placementNudges (2),
  routes/api.ts send routes (500 via the error handler, serializer-safe),
  routes/public.ts welcome, relayAnnouncements and groupSend (adapter level).
- Adapter: Twilio listMessages and getMessage checked against twilio-node 6.0.2
  Page.js (_payload, nextPageUrl, getPage); the timeout pin on both clients; the
  console driver's in-process store.
- fake-twilio: create/list/fetch resource shapes, fail seams, smart encoding,
  e2e fixtures.
- Dashboard presenters and the constants mirror test.

## Looked at, sound

- The claim uses a TransactWrite; the SDK auto-fills ClientRequestToken (the
  idempotencyToken trait), so a retried claim cannot misfire the way ADV-3 does.
- markRedriven's rc=0 fence gives at most one re-drive, even with duplicate chains.
- Two concurrent first passes produce exactly one send per member - except
  under ADV-1.
- Classification: ECONNRESET, timeouts and 5xx are unknown and never re-sent;
  ECONNREFUSED, ENOTFOUND and EAI_AGAIN (connect-time only) and 429/20429 are
  retryable; an exception thrown after messages.create resolves is classified
  unknown, so it goes to reconcile and is not re-sent.
- The known-SID path never re-sends; an unmatched free candidate makes the last
  check unresolved, never never_sent; the STOP auto-reply guard holds.
- The log serializer keeps axios config and URLs (To/From) and credentials out
  of logs; the page token is never persisted or logged.
- finalize: a consistent read plus a conditional flip gives a single winner
  (apart from ADV-8).
- Adoption dedupes on the SID pointer / isBroadcastRowFor, and the relay
  pointer claim is conditional.
- The dashboard presents send_unconfirmed by code first and offers no retry
  affordance for it.
- A redelivered broadcast or relay pass is suppressed by the marker.
