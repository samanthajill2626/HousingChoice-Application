# share-sent-outcome - adversarial code review, round 1 (plan-blind)

Branch `feat/share-sent-outcome` @7386968d against main @3f38bcc2. Inputs: the review
package (`.superpowers/review/share-sent-outcome-diff.txt`, read in full) and the
worktree. No spec, plan, review record or issue file was read. Every HIGH finding was
reproduced against the real code with a throwaway vitest file (deleted before
handback); the MEDIUM reproductions below were run the same way.

## 1. The behavior I derived

A property send (a `broadcast` row with a `unitId`) keeps one slot per recipient.
Before this branch a slot recorded only the ORIGINAL text; the automatic 30003
retries, a staff Retry and the reconcile's adoption of a retry never reached it. The
branch (a) gives each slot a newest-attempt pointer (`latestAttempt`, ordered by
message id, with a row-less `<key>~` marker for a retry that ended unresolved) and ONE
attempt-ordered conditional write with its stats delta (`applyAttemptOutcome` through
`applyLaterAttempt`), fed by the status webhook (retry rows routed by `broadcast_id` +
`retry_root`), the reconcile's found and unresolved arms, the retry job's two
unresolved arms and the repair - newer attempt wins, the same attempt moves only
forward from `sent`, an older attempt only as a delivery, never from
queued/delivered/skipped; (b) turns the listing-send row into per-share memory
(`shares`, `counted`, change token `shares_op`; `sentAt` REMOVED while nothing counts,
so the byContact index drops the pair), written by the pass at acceptance, adoptions,
original-row receipts and every slot move; (c) adds one per-recipient state with a
SAFE reading (the composer's "Already sent": reached, pending a live retry, not
confirmed, in flight) and a STRICT reading (reached only), reading the newest
attempt's row inside a 24-minute bound and, for the composer only, a queued slot's
attempt record; (d) the results and list routes carry the true `retry_pending` and
per-recipient promise facts (`?view=stats` for the list's refetch); (e) the dashboard
derives a finished share's label from its buckets (Sent / Sending / Not confirmed /
Not sent), adds a Retrying chip, re-judges promises on a 60 s server-clock ticker and
merges an event's omitted `retry_pending` by keeping the last value; (f) the landlord
timeline and the property Activity card recount "Sent to N tenants" from the share at
read time, and the tenant's "Property sent" pin takes its words from the ledger entry
of its share; (g) a census-first, conditional, re-runnable operator repair rebuilds
retry chains from rows, stamps attribution, re-applies the decided attempt to each
slot and rebuilds the ledger from the slot.

## 2. Findings

Count: 0 CRITICAL, 1 HIGH, 4 MEDIUM, 6 LOW.

### ADV-1 [HIGH] Deploying before the repair has run turns the composer's "Already sent" flag OFF for every historical recipient whose 30003 retry delivered - they are pre-checked and texted the same property again

Claim. Main flagged over-generously: every non-skipped slot of a sent/sending share
flagged its tenant (`git show 3f38bcc2:app/src/repos/broadcastsRepo.ts`, lines 716 and
731). The branch replaces that with the SAFE reading of the recipient state
(`app/src/services/shareRecipientState.ts:92-94`, called from
`app/src/routes/broadcasts.ts:602`). No historical slot ever learned its retry (main's
rollup skipped every retry row, and pre-1b retry rows carry no `broadcast_id`), so a
tenant whose original failed 30003 and whose retry DELIVERED still has a
`failed 30003` slot; outside the 24-minute row bound the slot is authoritative and
reads `failed` (`shareRecipientState.ts:83`), so the tenant is not flagged. The
composer pre-checks every consented, non-seeded, unflagged candidate and "Select all"
re-includes it (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:91`, `:167`):
the next blast of that property texts the tenant a second time. The historical error
flips from over-flagging (safe) to under-flagging (a duplicate send). The repair
moves such slots (its own test b-1), so the exposure is the deploy -> apply window,
plus permanently every slot the repair leaves alone (`unjudgeable.brokenLineage`, and a
pre-RSW retry whose after-send `retry_of` annotate failed, which the chain walk cannot
see at all).

Evidence (reproduced). `app/test/zz-adversarial-inmemory.test.ts` ADV-A (harness
world, the real preview route): a `sent` share; c-ok delivered; c-retry `failed 30003`
on R0, three hours old; R1 = a pre-1b retry of R0 (`retry_of` only) `delivered`.
Printed `ADV-A flags [["c-ok",true],["c-retry",false]]`. Main's rule flags c-retry (a
sent share, a non-skipped slot).

The RUNBOOK asks for the apply "AFTER the deploy ... and before the next property
blast" (`RUNBOOK.md:370`) and lists "be flagged wrongly in the composer" among what
the repair fixes (`RUNBOOK.md:372`), but says nothing about the deploy itself
reversing the direction of the error, nor that a one-to-one share from a tenant's file
reads the same flag (as its "Already sent" tag - its only warning, since a seeded row
stays checked).

Consumers swept. The preview route; RecipientPreview's pre-check, select-all and
hand-add annotation (`priorRecipientContactIds`); BroadcastComposer; the e2e specs
(share-skip-fix, share-sent-outcome) create fresh data, so none of them sees history.

Direction. Make the order binding: run census + apply in the same maintenance step as
the deploy and say WHY in the RUNBOOK; or keep main's over-approximation for failed
slots of shares finished before the deploy until the repair marks them; or let the
SAFE reading treat a failed-30003 slot as "may have reached" when its original row has
a retry child (the pointer read the manual Retry route already makes,
`app/src/routes/api.ts:1653`) - pre-pointer rows are invisible to that, so the repair
stays required.

### ADV-2 [MEDIUM] In steady state a retried recipient can still read as a final failure (the unsafe direction): the slot learns nothing at the retry's acceptance, and the webhook's slot write is single-shot

(a) Timing gap. Only the retry row's callbacks (or a reconcile adoption) move the
slot; the retry job's success path closes the attempt record and writes nothing else
(`app/src/jobs/retrySend.ts:602-610`). Until the retry's FIRST callback the slot is
the original's `failed 30003`, judged by the original's promise, which lapses at
due + 2 min whatever happened to the retry (`app/src/lib/retrySendWindow.ts:99-104`).
A retry job that runs late (the jobs consumer polls again only after its whole batch
finishes, `app/src/adapters/sqsJobConsumer.ts:129`) sends after that lapse, and until
its first callback the recipient is `failed`: not flagged, results "Failed" plus the
"open conversation to retry" hint, and - when no one else on the share was reached -
pill "Not sent" and "No tenants reached".
Reproduced: `zz-adversarial-inmemory.test.ts` ADV-B - R0 failed 30003 with its promise
lapsed 3 min ago, R1 accepted 30 s ago (row `queued`, post-1b stamps). Printed
`ADV-B flags [["c-ok",true],["c-retry",false]]`. The thread path is safe (the manual
route refuses a row with a child, `api.ts:1653-1657`); the composer is not.

(b) Failure handling. The webhook routes a retry row through a bare `applyLaterAttempt`
(`app/src/routes/webhooks/twilio.ts:3949`): one throw that survives the SDK's own
retries is logged "broadcast delivery rollup failed" (`twilio.ts:3581`) and is never
retried - the message row has already transitioned and the rollup is gated on the
transition. The reconcile's two sites use the bounded variant
(`app/src/jobs/sendReconcile.ts:1492`, `:1517`); the retry job's arms use the bare one
inside guardWrite (`retrySend.ts:825`). A lost write leaves the slot at the original's
failure for good - unflagged, uncounted. Every such line says "the repair heals it"
(`app/src/services/shareAttemptOutcome.ts:256`, `app/src/services/shareLedger.ts:7`,
`:192`), but the repair is a one-off operator script: no schedule, no alarm tie-in, no
RUNBOOK trigger for these lines.

Direction. Record the retry's acceptance on the slot (the pass does the equivalent for
originals at dispatch) or have the SAFE reading consult the original row's retry
children; use `applyLaterAttemptBounded` in the webhook as well; say in the RUNBOOK
when these log lines mean "re-run the repair" (or schedule it).

### ADV-3 [MEDIUM] The tenant's "Property sent" words for a pending entry use the SAFE reading, contradicting the service's documented STRICT reading and the "Properties sent" card on the same page; the STRICT predicate is dead and re-derived five times

Claim. The state service documents SAFE for the composer and STRICT for "labels,
counts, ledger, milestone" (`shareRecipientState.ts:6`, `:95-98`). `hasReached` has no
production caller. The milestone (`app/src/routes/contactTimeline.ts:713-738`) reads a
`pending` entry with a live promise as "Property sent" (`:736`), while the ledger does
not count that entry - the contact page's "Properties sent" card lists nothing, the
share's results row reads "Failed - will retry" and its pill "Sending". "Reached" is
re-derived independently in five places - `reachedCount`
(`shareRecipientState.ts:233`), `presentShareLabel`
(`dashboard/src/routes/broadcasts/broadcastFormat.ts:108`), `ledgerEntryForSlot`
(`shareLedger.ts:156`), `ledgerOutcome` (`shareAttemptOutcome.ts:142`) and
`propertySentWords` - and the milestone is the first to drift.

Evidence (reproduced). `zz-adversarial-inmemory.test.ts` ADV-C: a pending entry, its
attempt row with a live promise, and the pin. Printed
`ADV-C timeline ["Property sent"] listings-sent []`. (The branch's own D6 test pins the
same words, so the tests encode the contradiction.)

Direction. Decide the milestone's reading once; if STRICT, a pending entry reads as
not-yet-sent (for example "Property text failed - retrying"). Route every "reached"
decision through one exported predicate and delete or use `hasReached`.

### ADV-4 [MEDIUM] The repair aborts the WHOLE bulk run on one share's permanent write failure; every re-run aborts at the same share, the shares after it are never repaired, and no log line names the share

Claim. Any throw from a slot or ledger write aborts the walk
(`app/scripts/repair-share-outcomes.ts:273`), and the RUNBOOK says "Fix the cause and
re-run" (`RUNBOOK.md:390`). A permanent per-item cause is not fixable by the operator.
The concrete one is DynamoDB's 400 KB item limit: this branch lowers the recipient cap
from 1500 to 1000 precisely because `latestAttempt` grows every moved slot, but shares
recorded under the old cap still exist and the repair moves many slots at once. Scan
order is fixed, so every bulk re-run dies at the same share. The PARTIAL report
carries counters only, the DynamoDB error carries no ids, and the FAILED line logs only
`err` (`repair-share-outcomes.ts:684`).

Evidence (reproduced). `app/test/zz-adversarial-repair.test.ts` ADV-D (DynamoDB
Local, bulk mode, `scanLimit` 1): share adv-a-big sized 20 bytes under the limit plus
four normal shares that need moves. Both runs threw
`Item size to update has exceeded the maximum allowed size`; the only ERROR line was
the PARTIAL report (no share id). After two runs adv-b-1 and adv-e-4 (after adv-a-big
in scan order) were still `failed` while adv-c-2 and adv-d-3 had been repaired.

Direction. Log the share and slot ids on every abort; count a per-share
`ValidationException` as unjudgeable (for example `itemTooLarge`) and continue; or
checkpoint and resume by share id.

### ADV-5 [MEDIUM] A retry the carrier confirmed (row `sent`) is repaired as a bare acceptance - the slot reads "Sending..." forever while the same message's bubble reads "Sent"

Claim. `rowOutcome` maps a row's `sent` to a `sent` outcome with no carrier instant
(`repair-share-outcomes.ts:417-430`), so the slot becomes `sent` without
`carrierSentAt`, which every surface presents as in flight
(`dashboard/src/routes/broadcasts/broadcastFormat.ts:159-163`, the exact disagreement
that function's comment exists to prevent) and which derives into the Sending bucket
of a long-finished share. A row reaches `sent` only through the carrier's sent
callback, so the repair holds the proof and records the opposite; no later event will
ever fix a historical row. The same shape exists live in `ownRetryRow` ->
`mapAdopted` when the row's own callbacks never routed.

Evidence (reproduced). `zz-adversarial-repair.test.ts` ADV-E: a pre-1b retry R1 whose
row is `sent`; after the apply the slot printed
`{"conversationId":"conv-adv-e","tsMsgId":"...#SMadv-e-r0","latestAttempt":"...#SMadv-e-r1","status":"sent"}`
(no `carrierSentAt`), derived `sending 1, sent 0`, with the retry row's status `sent`.

Direction. When the decided row is `sent`, stamp a carrier instant (the row's provider
timestamp is a sound lower bound) or carry a carrier-confirmed flag on the outcome.

### ADV-6 [LOW] The results page judges stale promise facts: a promise REFRESH emits no broadcast.updated

`refreshRetryPromise` and `withdrawRetryPromise` emit only `message.persisted`
(`app/src/services/retryPromiseWrites.ts:34-41`). The retry job's deferral and the
unknown-outcome hand-off REFRESH the original row's promise to a later instant; the
results page listens to `broadcast.updated` only, keeps the old `retryDueAt`, and its
ticker recounts to 0 when that old instant lapses
(`dashboard/src/routes/broadcasts/BroadcastResults.tsx:166`): the page flips to
"Not sent" with the retry hint while the thread says "will retry" and the manual route
answers `retry_pending`. Transient (until the retry's own receipt). Direction: emit
`broadcast.updated` for a promise write on a share row, or let the ticker skip rows
whose facts predate the newest event.

### ADV-7 [LOW] The list hook decides its stats refetch from a ref that a passive effect updates, and an in-flight refetch can overwrite a newer event

`rowsRef.current` is assigned in a `useEffect`
(`dashboard/src/routes/broadcasts/useBroadcastsList.ts:54-56`) and read inside the SSE
handler (`:195`). An event handled before that effect flushes - the first event right
after a page load, or two back-to-back emits such as the rollup's `retry_pending 1`
followed by the enqueue-failure re-emit - reads the pre-patch row and skips the
refetch; the row keeps a stale positive count ("Sending") until the next event or a
reload. Separately, a count-carrying event never aborts an in-flight `?view=stats`
request (only a new schedule does, `:142`), so an older response can replace the
newer count (`:153`). Direction: decide from the merged row inside the functional
update and version the refetch.

### ADV-8 [LOW] The census forecast is per slot against the pre-run row, so a pair with several shares can be forecast to flip when the apply never flips it

On a dry run nothing is written, so each slot's `ledgerWouldChange` compares against
the ORIGINAL row (`repair-share-outcomes.ts:535`, `:575-577`). A legacy row naming B2
(whose text failed) for a pair that B1 had delivered to earlier: the census forecasts
`pairsToUncount` 1; the apply either never uncounts (B1 walked first) or uncounts and
recounts. The RUNBOOK tells the operator to read these as the pairs that will leave
"Properties sent" (`RUNBOOK.md:383`). Related precision: the legacy seed attributes a
legacy row's count only to its last `broadcastId` (`shareLedger.ts:69-77`), so when
B1's slot is unjudgeable the repair uncounts a pair the tenant did receive.

### ADV-9 [LOW] The Not-confirmed re-bucketing exists only in the routes

`unconfirmedByRow` (`shareRecipientState.ts:224`) feeds `deriveBroadcastStats` only in
the results and list routes; every `broadcast.updated` emit derives without it. An SSE
patch therefore moves such a recipient back to `failed` on the list ("Not confirmed" ->
"Not sent") and the list does not refetch (its kept count is 0). Residue cases only (a
dropped slot write after a WITHDRAW, or history inside the 24-minute bound).

### ADV-10 [LOW] Duplicated rules and constants that will drift

`RETRIED_CODE = '30003'` is declared in three services (`shareRecipientState.ts:47`,
`shareAttemptOutcome.ts:82`, `shareLedger.ts:42`) plus the literal in the webhook's
pending test (`twilio.ts:4106`); the pair-contact rule is private in
`shareAttemptOutcome.ts:156` and re-implemented in the repair
(`repair-share-outcomes.ts:534`); `bucketOf` (`shareAttemptOutcome.ts:85`)
re-implements `deriveBroadcastStats`'s bucket map; the ledger's `summarize` is
re-implemented in `app/test/helpers/listingSendSeed.ts`, so seeded test rows can
diverge from what the service would write.

### ADV-11 [LOW] Precision

- `outcomeOf` writes errorCode `unknown` for a code-less failure of a retry row
  (`twilio.ts:3921`; the repair's `rowOutcome` too) while the original rollup writes
  none: the same condition renders "Delivery failed" on one row and an "error unknown"
  tail on another.
- An `applyLaterAttempt` for the ORIGINAL's own key (the repair's stuck-`sent` move)
  sets `latestAttempt` equal to `tsMsgId`, contradicting the type's documented "ABSENT
  while the original send is the newest attempt" (`broadcastsRepo.ts:181-188`);
  harmless to every reader today, visible on the results wire.
- `describeUnitActivity` renders an ABSENT `tenantCount` as "No tenants reached" (a
  claim), while the landlord timeline keeps "Sent to 0 tenants" for a share that no
  longer exists.

## 3. App-wide sweep

| Touched state / route / event | Writers found | Readers / consumers found | Verdict |
|---|---|---|---|
| `broadcasts.recipients[k].latestAttempt` (new) | `applyAttemptOutcome` via `applyLaterAttempt`: webhook retry routing (`twilio.ts:3949`), reconcile found/unresolved (`sendReconcile.ts:1492`, `:1517`), retry job arms (`retrySend.ts:825`), repair. Preserved by `rollIntoBroadcast`'s spread (`twilio.ts:4049-4083`). The slot-replacing writers (the pass's unconditional `setRecipient`, `closeRecipientIfQueued`, `recordRecipientOutcome`) touch only queued slots | `applyLaterAttempt`, `shareRecipientState` (`newestKey`, `needsRowRead`), `ledgerEntryForSlot`, repair `slotRecords`, results route `promiseFields`, dashboard `toRecipientViews` + hint gate | Agrees (ADV-11 bullet 2) |
| A failed slot's status/errorCode | Only `applyAttemptOutcome` moves a failed slot, always setting `latestAttempt` - so the (status, latestAttempt) condition also pins the bucket | D1 classify, `deriveBroadcastStats`, finalize, repair | Agrees |
| `broadcasts.stats` (persisted) | `bumpStats` (rollup, second step), `applyAttemptOutcome` ADD (same write as the slot), `recordRecipientOutcome` deltas, `markSending` | `deriveBroadcastStats` empty-map passthrough; `reachedCount` for map-less legacy shares | Agrees (an ADD on an absent bucket can go negative; every read path derives from the map) |
| `broadcast.updated` `stats.retry_pending` (new, optional) | `rollIntoBroadcast` (1 or unset), `applyLaterAttempt` side effects (1 or unset), webhook withdrawal re-emit (unset, `twilio.ts:3704`), pass/finalize/reconcile (unset), repair (private bus, reaches nobody) | EventStreamProvider -> `useBroadcastResults` (keep), `useBroadcastsList` (keep + refetch); worker bridge re-emits unchanged (`routes/internal.ts:84`) | Agrees; ADV-7, ADV-9 |
| `GET /broadcasts/:id/results` (+ recipient `retryDueAt`/`retryOutcome`/`retryPending`/`latestAttempt`, `stats.retry_pending`, Not-confirmed re-bucket) and `?view=stats` | route | `useBroadcastResults`/`BroadcastResults`, `getBroadcastStats` (list), e2e | Agrees; ADV-6 |
| `GET /broadcasts` list stats | route (per-row state resolution, no record reads) | `useBroadcastsList`, `BroadcastsList` | Agrees |
| `POST /broadcasts/:id/preview` flag (SAFE reading) | route via `priorRecipientKeys` | RecipientPreview pre-check / select-all / hand-add, BroadcastComposer | DISAGREES pre-repair (ADV-1); steady-state gap (ADV-2) |
| `listing_sends` `shares`/`counted`/`shares_op` (new); `sentAt`/`broadcastId` optional and REMOVED | `putShareMemory` only: pass (`recordPropertySent`), adoption, webhook original rows, `applyLaterAttempt`, repair; seeds via PutCommand in the legacy shape (all carry `sentAt`, `seed/cast.ts`, `seed/matrix.ts:1261`) | `listByUnit`/`listByContact` (`isListed`, `listingSendsRepo.ts:156,318,332`) -> units recipients (`units.ts:954`), contacts listings-sent (`contacts.ts:1168`); timeline D6 `getByKeys`; repair; `listingSendMilestones` guard (`seed/history.ts:1004`); `toListingSendRow` throw (unreachable from the filtered readers) | Agrees; ADV-3 on the milestone words |
| `byContact` GSI `sparse: true` | `tables.ts:424` (documentation flag) | `gen-tables` emits nothing for it | Agrees |
| `activity_events.broadcastId` (new) | `recordPropertySent` | timeline `propertySentWords` | Agrees |
| messages `broadcast_id` / `retry_root` on retry rows | sendMessage (retry job, manual Retry, `adoptRetry`), repair `stampRetryAttribution` | webhook routing; reconcile found hook, unresolved close, `predecessorMatchers`, `isBroadcastRowFor` (never a retry row), `rowHolder`; retry job arms. No dashboard reader | Agrees |
| messages `retry_due_at` / `retry_outcome` (read) | webhook status write, refresh / withdraw | state row read, timeline D6, repair `decideAttempt` | Agrees; ADV-6 |
| Activity `tenantCount` recount; landlord timeline labels | `units.ts:1279-1292`, `contactTimeline.ts:1461` | `listingFormat.describeUnitActivity`, Timeline (label verbatim) | Agrees; ADV-11 bullet 3 |
| `MAX_BROADCAST_RECIPIENTS` 1500 -> 1000 | constant | `/send` `audience_too_large`, preview slice; no dashboard constant or copy | Agrees; legacy shares over 1000 remain (ADV-4 trigger) |
| `priorRecipientContactIds` repo method, `recordSend` (removed) | - | preview route and pass switched to the services; the harness double removed; tests seed through `seedListingSend` | Agrees |
| `deriveBroadcastStats` options | - | routes pass them; webhook, services, pass and reconcile do not | Agrees; ADV-9 |
| Harness doubles (`applyAttemptOutcome`, `getByIds`, `putShareMemory`, `getByKeys`, `listBy*`, `stampRetryAttribution`, activity `broadcastId`) | `app/test/helpers/twilioWebhookHarness.ts` | held to the real repos step by step by `twilioWebhookHarnessRepoAdditions.integration.test.ts` | Agrees |

## 4. Checked and sound (tried to break, could not)

- Original-row rollup vs retry writers on one slot: a retry row exists only after the
  original's ONE terminal transition (`undelivered`/`failed` are terminal,
  `messagesRepo.ts:134-143`), the webhook enqueues the retry after its own rollup in
  the same request, and a manual Retry requires a failed row
  (`api.ts:1628`) - no interleaving puts the spread-and-overwrite of
  `rollIntoBroadcast` over a retry's pointer.
- Two attempt writers on one slot (a retry receipt vs the reconcile's adoption; a
  manual retry vs an automatic one; a late older receipt): the (status, latestAttempt)
  condition plus the consistent re-read decides every order I walked; the stats delta
  rides the same write, so buckets never double-move.
- The replay check (a committed write whose response was lost) can match only when
  `latestAttempt` already equals the input's key - a true replay of the same attempt
  and outcome, whose side effects are idempotent.
- Ledger OCC: two writers on an absent row, a legacy row (`attribute_not_exists` on
  the token) and a tokened row; random tokens rule out ABA; the pass's acceptance after
  an earlier failure receipt is refused by the same-attempt rule.
- Order key: the row-less marker sorts after the retried row and before any later row
  (manual retries, re-drives); the repair's chain walk is cycle-safe and ignores other
  shares' and other slots' chains in a shared thread.
- The webhook takes the promise from the retry decision, never from the pre-write
  image; the enqueue-failure withdrawal re-emits with the count unset.
- Reconcile: the found hook runs before the record close; a crash between them re-runs
  it as a replay; the unresolved close's WITHDRAW precedes the slot write; the
  superseded exit's re-apply is idempotent; bounded and never propagated.
- Retry job arms: slot first, guarded; a lost close leaves `send_unconfirmed`, the
  safe side.
- Repair: a dry run writes nothing (every write sits behind `apply`); the target goes
  through `scripts/lib/stageClient.ts` (account guard first, ambient
  `AWS_ENDPOINT_URL*` refused, `--lane` local only); every repo it builds carries the
  stage env and no service it calls default-constructs a repo; stamps are conditional
  on an existing row; a second census reports zero.
- Security: new log lines carry ids and counts only, phone keys through
  `safeRecipientKey`; contact keys are aliased in every expression; stats bucket names
  come from code; `view` is validated before any read; no route's authorization
  changed.
- The worker bridge forwards `broadcast.updated` payloads unchanged, so `retry_pending`
  survives the process hop.
- Dashboard: the overlay keeps an omitted count; the ticker's recount is gated off
  while rows lag an event; all hooks are declared before the page's early returns; the
  ticker is visibility-gated and fetches nothing.
- `toListingSendRow`'s throw is unreachable from its two callers (both read through the
  `isListed` filter); every seed row carries `sentAt`.

## 5. Test-quality notes

- `hasReached` is unit-tested but has no production caller (ADV-3); the tests that pin
  the milestone's "Property sent" for a pending entry encode the contradiction.
- Nothing tests the SAFE reading on HISTORY before the repair (ADV-1), a retry in
  flight after the original's promise lapsed (ADV-2a), or the webhook's retry routing
  when `applyLaterAttempt` throws or loses (ADV-2b).
- The repair's bulk mode has one happy-path test; nothing covers a share that aborts a
  bulk run or checks that the failure names the share (ADV-4). No repair test asserts
  `carrierSentAt` for a `sent` decision (ADV-5).
- `app/test/helpers/listingSendSeed.ts` duplicates the ledger's `summarize`, so a
  change to the service's rule would not reach the seeded rows (ADV-10).
- No test covers a promise REFRESH on the results page (ADV-6) or the list hook's
  ref-lag path (ADV-7); e2e (b)'s live list assertion depends on that hook.
- The `repoPagingWiring` fixture change (rows now carry `sentAt`) is legitimate: the
  test still proves both pages are followed.
- The pins flipped in `send-outcome-reconcile.spec.ts` (the rejected row's hint 1 -> 0;
  the unconfirmed share's pill Failed -> Not confirmed, no alert) and in
  `share-skip-fix.spec.ts` (a final 30007 failure no longer flagged) follow the branch's
  rules, and the hint's positive controls exist in `share-sent-outcome.spec.ts` (b) and
  (c).
- The harness doubles for every new repo method are held to DynamoDB Local by the
  mirror integration test - no double lies on the branch's surface.
