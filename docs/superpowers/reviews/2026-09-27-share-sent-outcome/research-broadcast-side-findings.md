# Share sent outcome (Branch B) - research: the broadcast (property send) side - FINDINGS

Date: 2026-09-27. Read-only research for the planner rewriting
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` (the stub).
Base: `main` @ `d9cb5c04` (worktree `W:\tmp\share-sent-outcome`, branch
`feat/share-sent-outcome`, clean). Every `file:line` below is at that commit
and was read by this reader. "UNVERIFIED" marks a claim not confirmed from
code. Verbatim excerpts of the ranges that matter are in the gitignored
companion `.superpowers/sdd/research-broadcast-side-reference.md` (126
numbered excerpts, each headed by its `file:start-end`): slot model and repo
R1-R11, fan-out R12-R28, status webhook R29-R34, retry rows and messages
R35-R46, reconcile R47-R56, attempt record and tables R57-R62, share routes
R63-R71, harness mirror R72-R75, Activity card and timelines R76-R84,
dashboard R85-R110, pinning tests R111-R123, spec passages R124-R126.

Prerequisites at `d9cb5c04`: `feat/share-skip-fix` (Branch A),
`feat/retry-send-window` (RSW) and `feat/send-outcome-reconcile` (SOR Stage 1)
are each an ancestor of `d9cb5c04` with 0 commits ahead
(`git merge-base --is-ancestor`). Stub prerequisite 4 - the `retrySend`
adoption (SOR Stage 1b) - has NOT landed: `app/src/jobs/retrySend.ts` imports
no send-attempt repo, its newest commit is RSW-era (`03609cde`), and
`docs/issues/retry-send-lost-under-job-marker.md` is still `open`.

---

## 1. The recipient slot model as built

### 1.1 Shape and size

- `BroadcastRecipient` = `{ status, conversationId?, tsMsgId?, errorCode?,
  carrierSentAt? }` (`app/src/repos/broadcastsRepo.ts:136-166`); status is
  `queued | sent | delivered | failed | skipped` (`:146`). Keyed by contactKey =
  contactId, else `phone#<E164>` (`:192-196`). Broadcast slots carry NO attempt
  clock (SOR spec D8a; SOR errata 9).
- Share lifecycle `BroadcastStatus` = `draft | sending | sent | failed`
  (`:40`); `created_via?: 'dashboard'` (`:173`), `last_error` (`:205`),
  `finalize_op` (`:212`).
- Size: the map lives ON the item; the repo budgets ~150-200 B per slot and caps
  the audience at 1500 (~300 KB under DynamoDB's 400 KB item limit)
  (`:13-18`, `:56-68`). SOR declined even ONE extra attribute per broadcast slot
  (`attemptedAt`) on size grounds (SOR spec, lines 464-466).

### 1.2 Every status + errorCode a slot can carry, and who writes it

"Row" = whether a message row exists for that attempt; the slot keeps
`conversationId` + `tsMsgId` exactly when it does (see the derived fact below).

| status | errorCode | writer (file:line) | derived bucket | row |
|---|---|---|---|---|
| queued | none | route seed `buildRecipientsFrom` (`app/src/routes/broadcasts.ts:268-277`), filter path (`:738-741`); `markSending` (`broadcastsRepo.ts:747-773`) | queued | no |
| queued | numeric provider code (429, 30022, 20429, ...) | `retryable` arm -> `deferClaimed` -> `deferSlot` (`app/src/jobs/broadcastFanOut.ts:1044-1055`, `:620-627`, `:542-544`) | queued | no |
| queued | `send_retryable` | prepare-phase throw (`:961-972`), `SendNotAttemptedError` (`:1017-1028`), retryable without a numeric code (`:1049`) | queued | no |
| queued (reconciling) | unchanged | `unknown` outcome: the slot is NOT written while the reconcile runs (`:776-814`; SOR D7) | queued | unknown |
| sent | none, with keys | record phase, from `queued` (`:940-948`); adoption of a non-terminal provider status (`:1395-1416`) | sending (no carrierSentAt) / sent | yes |
| sent + carrierSentAt | none | webhook carrier-`sent` receipt (`app/src/routes/webhooks/twilio.ts:3915-3940`); adoption with the provider date_sent (`broadcastFanOut.ts:1411`) | sent | yes |
| delivered | none | webhook rollup (`twilio.ts:3943-3983`); adoption (`broadcastFanOut.ts:1395-1416`) | delivered | yes |
| failed | `no_contact` | `NO_CONTACT_FENCE` via `declineAtFence` (`:245-250`, `:636-670`) | failed | no |
| failed | `30007`, `30005`, `30006` | `onRejected` legacy arms: blind `setRecipient` + separate `bumpStats` (`:696-705`); 30005/30006 also flag `sms_unreachable` (`:724-728`) | failed | no |
| failed | other numeric provider code (21211, 21610, 30034, ...), `sms_sending_disabled`, or none (code-less 4xx) | `onRejected` else arm, `recordRecipientOutcome` from `queued` (`:733-747`) | failed | no |
| failed | `transient_cap` | `closeBroadcast` (`:419-479`, slot close `:452`) from close A (`:1147-1151`), close B (`:516-520`, `:1132-1135`), the unreachable guard (`:1137-1142`) | failed | no |
| failed | `enqueue_failed` | `closeBroadcast` close C (`:1166-1172`); reconcile re-drive enqueue failure on a redriven record (`app/src/jobs/sendReconcile.ts:1051-1066`) | failed | no |
| failed | `send_unconfirmed` | fan-out `handOff` enqueue failure (`broadcastFanOut.ts:561-575`); second unknown after a re-drive (`:784-811`); reconcile `closeUnresolved` (`sendReconcile.ts:1003-1024`) | unconfirmed | unknown (nothing found) |
| failed | `redrive_refused` | reconcile `closeRedriveRefused` (`sendReconcile.ts:1140-1160`) - relay only in practice: `redriveRefusal` returns undefined for a broadcast owner (`:1123-1124`) | failed | - |
| failed | any carrier code on a receipt (30003, 30005, 30006, 30007, 21610, ...) or none | webhook rollup (`twilio.ts:3943-3958`) | failed | yes |
| failed | provider code on an adopted terminal failure | adoption (`broadcastFanOut.ts:1359-1362`, `:1395-1416`) | failed | yes |
| skipped | `opted_out`, `unreachable`, `contact_deleted`, `no_consent` | fan-out fences (`:263-283`) via `declineAtFence`, blind `setRecipient` (`:660`) | opted_out / other / other / no_consent | no |
| skipped | a `SendRefusedError.code`: contact_opted_out, contact_deleted, contact_no_consent, breaker_open, manual_mode, sms_sending_disabled, conversation_not_found, relay_not_supported, group_text_not_supported (`app/src/services/sendMessage.ts:70-94`) | refusal arm, blind `setRecipient` (`broadcastFanOut.ts:987-1016`; bucket choice `:992-996`) | by predicate | no |
| skipped | none | legacy first-fence skips recorded before 2026-09-25 (`broadcastsRepo.ts:148-157`) | opted_out | no |

**Derived fact (from reading every runtime slot writer; no test pins it):** a
slot carries `tsMsgId`/`conversationId` exactly when a message row exists for
the attempt. The record phase, the adoption and the rollup's `{...slot}` spread
keep the keys; every fence, rejection, cap/enqueue close, deferral and
unresolved close writes the slot wholesale without them. This is a
code-supported way to tell Branch A's "failed after it was sent" from "failed
before any send" (`docs/superpowers/specs/2026-09-24-share-skip-fix-design.md:212-217`,
`:420-424`), with `send_unconfirmed` as the one keyless failure that may have
been sent. Exceptions: the matrix seed writes a keyless `delivered` slot
(`app/src/lib/seed/matrix.ts:1230-1232`); historical production slots written
by older code are UNVERIFIED.

### 1.3 Stats

- `BroadcastStats` (`broadcastsRepo.ts:86-133`): audience, sent, delivered,
  failed, `unconfirmed?` (SOR D22), skipped_opted_out, skipped_no_consent,
  `skipped_other?` (Branch A D7), queued, `sending?` (derived only). Dashboard
  mirror: `dashboard/src/api/types.ts:2950-2972`.
- `zeroStats` (`broadcastsRepo.ts:328-341`).
- `deriveBroadcastStats` (`:270-325`): an empty map returns the persisted stats
  (drafts); otherwise one bucket per slot - queued; `sent` without
  carrierSentAt -> sending, with it -> sent; delivered; `failed` -> unconfirmed
  when the code is `send_unconfirmed`, else failed; `skipped` -> no_consent by
  `isNoConsentCode` (`:228-230`), opted_out by `isOptedOutCode` (`:235-237`; NO
  code counts as opted out), else skipped_other. The switch has no default arm,
  so a new status string lands in no bucket (SOR D10).
- Every read surface derives from the map: results (`routes/broadcasts.ts:293`),
  list (`:311`), SSE (`broadcastFanOut.ts:226-232`; `twilio.ts:3933-3937`,
  `:3978-3982`), finalize (`broadcastFanOut.ts:1532`, `:1559`). The persisted
  counters are shown only for an empty-map draft (SOR D22).

---

## 2. Write map

### 2.1 Repo primitives (`app/src/repos/broadcastsRepo.ts`)

- `setRecipient` (`:797-843`): wholesale child SET of one slot. BLIND without
  priors (condition only `attribute_exists(broadcastId)`); with priors a
  conditional `status IN (...)` returning false on a condition failure. Blind
  callers: `recordRecipient` (`broadcastFanOut.ts:1488-1495`) from the fences
  (`:660`), the legacy reject arms (`:699`) and the refusal arm (`:998`).
  Conditional callers: the webhook (`twilio.ts:3924-3929` priors `['sent']`;
  `:3949-3958` priors `['queued','sent']`).
- `recordRecipientOutcome` (`:537-579`, contract `:452-468`): slot + stats ADD in
  ONE conditional write; priors required (empty list = TypeError); returns
  `{ moved, item }`.
- `closeRecipientIfQueued` (`:931-935`): `{status:'failed', errorCode}`, delta
  queued -1 / bucket +1, priors `['queued']`.
- `bumpStats` (`:886-927`): unconditional ADD.
- `finalizeStatus` (`:937-983`): flips `sent|failed` only FROM `sending`, with a
  `finalize_op` token so an SDK replay of a committed flip still reads as won.
- `markFailed` (`:989-991` via `flipStatus` `:619-645`): unconditional; its one
  runtime caller is the send route on an enqueue failure
  (`app/src/routes/broadcasts.ts:761-775`). `markSent` (`:985-987`) has no
  runtime caller (grep of `app/src`).
- `markSending` (`:747-773`): seeds the map wholesale, conditional on `draft`.

### 2.2 The fan-out, arm by arm (`app/src/jobs/broadcastFanOut.ts`)

- Idempotency: job marker (`:351-363`); strongly consistent snapshot
  (`:370-374`); terminal-slot skip, `isTerminal` = sent|delivered|failed|skipped
  (`:202-206`, used `:506`, `:1073`); the SOR claim (`:866-897`) and re-arm
  before the provider call (`:920-928`).
- Fences behind the D8 gate (`declineAtFence`, `:636-670`): blind slot write
  then a separate `bumpStats` (`:660-665`).
- SEND (`:907-929`): `sendMessage` with `broadcastId` (row stamped
  `broadcast_id` at append, `sendMessage.ts:655-658`,
  `app/src/repos/messagesRepo.ts:2535`) and `automated: created_via !== 'dashboard'`
  (`:912`).
- RECORD (`:940-959`): slot `sent` + keys + `{sent:+1, queued:-1}` from `queued`
  (`:941-947`); then `afterSend` (token, `recordPropertySent`) runs WHETHER OR
  NOT the slot write moved (`:949`); then the record `done/sent` (`:950-957`).
- Refusal -> skipped (`:987-1016`); rejected -> failed (`:687-774`); retryable ->
  queued + code (`:1044-1055`); unknown -> reconcile hand-off, slot untouched
  (`:782-814`, `:598-614`, `:554-583`); sent-but-unrecorded -> hand-off WITH the
  SID (`:975-985`, `:1029-1036`).
- `closeBroadcast` (`:419-479`): D8 gate per key, closes only `queued` slots,
  then finalizes. End of pass: continuation (`:1113-1176`) or `finalize`
  (`:1180`).

### 2.3 The status webhook's rollup (`app/src/routes/webhooks/twilio.ts`)

- Trigger: only when THIS row's own delivery transition succeeded
  (`transitioned`, `:3462-3467`, `:3520`) AND the row carries `broadcast_id`
  (`:3529`). A throw is caught and logged ERROR (`:3542-3544`).
- Slot lookup, exactly: `broadcasts.getById(row.broadcast_id)` (eventually
  consistent, `:3880`), then the FIRST recipient entry whose
  `conversationId === row.conversationId && tsMsgId === row.tsMsgId`
  (`:3887-3889`); on a miss ONE re-read after
  `STATUS_UNKNOWN_SID_RETRY_DELAY_MS` = 2500 ms (`:322`, `:3898-3902`), then
  WARN "no matching recipient slot - ignored" (`:3903-3906`).
- Guard `broadcastSlotMayTransition` (`:3840-3844`): refuses ANY move of a
  `delivered`, `failed` or `skipped` slot - the terminal moves AND the
  carrierSentAt stamp; allows `queued` / `sent`.
- Moves: carrier `sent` stamps `carrierSentAt` on a `sent` slot, priors
  `['sent']`, no stats bump (`:3915-3940`); delivered / failed / undelivered
  write `{...slot, status, errorCode?}` with priors `['queued','sent']`
  (`:3949-3958`), THEN a separate `bumpStats` (`:3970-3975`) - not atomic with
  the slot write; emits `broadcast.updated` with the STORED share status and
  derived stats (`:3978-3982`). It never calls `finalize`.
- Order inside one callback: the 30003 retry decision runs BEFORE the status
  write (`:3452-3461`); the rollup runs next (`:3520-3545`); the 30003 arm
  enqueues the retry AFTER it (`:3560-3659`, enqueue `:3622-3631`).

**A receipt for a row with NO `broadcast_id` (every automatic 30003 retry row
and every staff Retry row):** the row's own status transitions and
`message.persisted` fires (`:3508-3518`), placement attention on a failure
(`:3555-3557`), a 30003 may schedule a further retry (`:3567-3659`) - and
nothing reaches any share: `:3529` is false, no slot write, no
`broadcast.updated`.

### 2.4 Retry rows carry no share attribution

- Automatic retry: `retrySend` calls `sendMessage` with body/media, the
  original's `automated`, author, `recipient`, `retryOf`, `retryAttempt`,
  `retryWindowStart` - no `broadcastId` (`app/src/jobs/retrySend.ts:317-328`).
- Staff Retry: `POST /api/conversations/:id/messages/:sid/retry` sends with
  `automated: false`, `retryOf`, `recipient` - no `broadcastId`
  (`app/src/routes/api.ts:1676-1688`); 409 `not_failed` unless the original is
  failed/undelivered (`:1595-1598`), 409 `retry_pending` while its
  `retry_due_at` promise is live (`:1608-1611`).
- Lineage is written atomically AT APPEND since RSW D6 (`sendMessage.ts:659-665`,
  `messagesRepo.ts:2536-2544`). `retry_of` = the tsMsgId of the row retried, so a
  chain links n -> n-1 (`retrySend.ts:174`, `:325`; `twilio.ts:3624-3628`
  enqueues with the FAILING row's SID). Automatic chain: at most 3 retries
  (`retrySend.ts:51`), backoff 60/120/240 s (`:53-56`, lane override
  `:110-117`), inside RSW's 15-minute window. Staff Retries: no count bound.
- `retry_due_at` lives on the FAILED MESSAGE ROW, written with the failure
  (`twilio.ts:3462-3467`) and rewritten to an expired instant when the enqueue
  fails (`:3638-3641`) - never on the slot.

### 2.5 Adoption - `adoptBroadcastRecipient` (`broadcastFanOut.ts:1341-1479`)

SID claim first: the append the wrapper would have made, deduped on the SID; a
dedupe that is not this recipient's row (`isBroadcastRowFor`, `:1296-1306`) is
`other_owner` (`:1365-1393`). Then the slot from `queued` ONLY with its bump in
one write (`:1395-1416`), status from `mapTwilioStatus`
(`app/src/adapters/messaging.ts:665-681`): non-terminal -> sent,
delivered/read -> delivered, undelivered/failed/canceled -> failed + code;
`carrierSentAt` from date_sent. A slot not `queued` -> `skipped`, no side
effects (`:1416`). Only when moved: tick, audit row if appended, preserving inbox
touch, emits, and the property-sent rows ONLY for sent/delivered
(`:1456-1463`). An adopted failure flags 30005/30006 and WARNs that the webhook
side effects - the 30003 ladder included - never ran (`:1465-1477`), so an
adopted 30003 has no automatic retry and no `retry_due_at`.

### 2.6 Reconcile closes (`app/src/jobs/sendReconcile.ts`)

Record FIRST, slot only when that close won (SOR errata 2): `closeUnresolved`
-> slot failed/`send_unconfirmed`, bucket unconfirmed (`:1003-1024`);
`enqueueOrClose` -> an unresolved close (cause enqueue_failed) on a reconciling
record, an `enqueue_failed` slot on a redriven one (`:1035-1069`); the
superseded exit re-applies the implied slot close (`:405-420`, `slotCloseOf`
`:922-933`). Every slot close is `closeRecipientIfQueued` (`:936-942`); every
close and adoption ends in `afterClose` -> `finalize` for a broadcast
(`:967-971`). A broadcast re-drive is a `broadcast.send` pass for one key with
`redrive: true` (`:1078-1090`).

### 2.7 Finalize (`broadcastFanOut.ts:1497-1575`)

- Consistent re-read (`:1521`); returns while ANY slot is `queued`
  (`:1526-1531`).
- reachedAny = derived sent + sending + delivered > 0 (`:1533`); failedAny =
  failed + unconfirmed > 0 (`:1534`); status `failed` iff !reachedAny &&
  failedAny, else `sent` (`:1535`). Skips count for neither side, so an
  all-skipped share is stored `sent`.
- `last_error` only when failed: "Couldn't confirm any text went out" when
  failed == 0, else "all recipients failed" (`:1536-1537`, constants
  `:157-160`).
- Only the flip winner writes `units#<unitId>` `broadcast_sent`
  `{ broadcastId, tenantCount: slots.length }` (`:1546-1552`) - for a `failed`
  share and a `sent` one alike, counting the WHOLE audience (skipped, failed,
  unconfirmed included), best-effort, never rewritten; then the terminal emit
  (`:1555`) and a derived-stats log line (`:1559-1573`).
- Callers: end of pass (`:1180`), `closeBroadcast` (`:478`), reconcile
  `afterClose` (`sendReconcile.ts:970`) - NOT the webhook.
- Consequence: the stored status is fixed when the last slot leaves `queued`.
  An asynchronous carrier failure usually lands after that, so a one-recipient
  share whose only text fails asynchronously is usually stored `sent`, while one
  whose failure receipt raced ahead of finalize is stored `failed`
  (`e2e/tests/dashboard-next/share-skip-fix.spec.ts:16-22`, `:259-264` say so).

### 2.8 Coupled writes on the broadcast side

- `recordPropertySent` (`broadcastFanOut.ts:1208-1252`): the tenant milestone
  `listing_sent` "Property sent" with refType `unit` / refId unitId when the
  share has a unit - NO broadcastId stored - else refType `broadcast`
  (`:1217-1226`); a fresh random event id per call, no dedupe
  (`app/src/repos/activityEventsRepo.ts:125-141`); plus the listing-send upsert
  (`:1237-1250`; upsert semantics `app/src/repos/listingSendsRepo.ts:14-18`).
  Written by the pass after a recorded send (`:949`, after pacing) and by an
  adoption of sent/delivered only; never retracted by a later failure; never
  written for any retry.
- `broadcasts#<id>` `broadcast_sent` `{actor, count}` at send start
  (`routes/broadcasts.ts:777-780`): no runtime reader (grep of `app/src`).

---

## 3. Read map

### 3.1 The "Already sent" set

- Repo `priorRecipientContactIds` (`broadcastsRepo.ts:702-745`, contract
  `:389-399`): pages the byUnit GSI (projection ALL, `app/src/lib/tables.ts:14`,
  `:376-382`; eventually consistent), keeps only shares whose STORED status is
  `sent` or `sending` (`:716`), adds every slot key whose status is not
  `skipped` (`:731-732`); any error -> empty set, WARN (`:737-742`).
- Harness mirror (`app/test/helpers/twilioWebhookHarness.ts:3318-3331`): the same
  rule, no paging, no catch. No parity test holds it to the real repo:
  `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` covers
  recordRecipientOutcome / closeRecipientIfQueued / finalizeStatus
  (`:569-706`) and not this method.
- Its one call (`routes/broadcasts.ts:521-524`) feeds two consumers: (1) the
  per-candidate `alreadySentThisProperty`, matched on contactId OR
  `phone#<phone>` (`:547-549`); (2) `priorRecipientContactIds: [...set]` in the
  preview response (`:569`), which the review list uses to annotate a hand-added
  tenant, by contactId only (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:104-107`,
  `:226-233`; the phone-key gap is the TODO at `routes/broadcasts.ts:543-546`).
  The flag renders the amber row and "Already sent" tag, starts the row
  unchecked unless seeded, and "Select all" skips unseeded flagged rows
  (`RecipientPreview.tsx:79-93`, `:165-169`, `:405-448`).
- What the stored-status filter does today. Excluded whole: every `failed`
  share - all-failed (race-dependent, 2.7), all-unconfirmed (issue
  `unconfirmed-share-invites-resend`), and a share the route marked failed on an
  ambiguous enqueue whose fan-out ran anyway (issue
  `broadcast-route-markfailed-blocks-finalize`). Included forever: the `queued`
  slots of a share stranded in `sending` (SOR errata 6; issue
  `deploy-mid-share-strands-remaining-recipients`) - tenants who were never
  texted stay flagged.

### 3.2 The results route

- `GET /api/broadcasts/:id/results` (`routes/broadcasts.ts:785-797`): eventually
  consistent `getById`; `enrichRecipients` (`:223-258`) spreads each slot and
  adds only firstName / lastName / phone from one BatchGet - nothing from the
  message row (no `retry_due_at`, no message delivery status, no retry lineage).
  `toBroadcastResults` (`:280-298`): stored status, derived stats, recipients,
  `last_error`.
- Dashboard `toRecipientViews` (`dashboard/src/routes/broadcasts/broadcastFormat.ts:193-222`)
  keeps status, carrierSentAt, errorCode, conversationId and DROPS tsMsgId
  (`BroadcastRecipientView`, `dashboard/src/api/types.ts:3049-3065`; the wire
  type still has it, `:3005-3027`); failed rows sort first.

### 3.3 The list route

`GET /api/broadcasts` (`routes/broadcasts.ts:799-840`) reads the byCreated GSI
(projection ALL, so each map is read) and returns `toBroadcastSummary`
(`:301-315`): stored status + derived stats, NO recipients (`BroadcastSummary`,
`types.ts:2975-2989`). The status tabs filter on the stored status
(`routes/broadcasts.ts:822-831`; `dashboard/src/routes/broadcasts/BroadcastsList.tsx:20-26`).

### 3.4 SSE

`broadcast.updated` = `{ broadcastId, status, stats }`
(`app/src/lib/events.ts:140-150`; `types.ts:3104-3112`); `status` is always the
stored lifecycle. Results page: overlays status + stats, then a 400 ms debounced
refetch (`dashboard/src/routes/broadcasts/useBroadcastResults.ts:118-138`),
latches a terminal status (`:77`, `:126`), polls every 2 s only while the stored
status is `sending` (`:147-157`). List: patches status + stats in place
(`useBroadcastsList.ts:111-124`). No other event refreshes either page.

### 3.5 Presenters (dashboard)

- `presentShareLabel` (`broadcastFormat.ts:97-105`): "Not sent" (neutral) only
  for stored `sent` with audience > 0 and every slot skipped; otherwise the
  stored label Draft / Sending / Sent / Failed (`:74-89`).
- `skippedTotal` (`:113-115`): the three skip buckets; unconfirmed excluded on
  purpose.
- `presentRecipientStatus` (`:130-153`): `send_unconfirmed` code first -> "Not
  confirmed" (danger, not a failure); skipped -> "Skipped"; `sent` without
  carrierSentAt -> "Sending..."; else `presentDeliveryStatus`, with a
  "Sending..." fallback (a queued row reads "Sending...",
  `BroadcastResults.test.tsx:78`).
- `shareRecipientReason` (`:162-172`): skipped -> `shareSkipReason`
  (`dashboard/src/routes/contact/deliveryStatus.ts:1098-1116`); failed ->
  `no_contact` own line, else `deliveryReason(errorCode)` with NO options
  (`:169`), so 30003 reads "Phone unreachable (error 30003)"
  (`deliveryStatus.ts:888-899`, `:1133-1175`); `retryScheduled` is documented as
  omitted for this row (`:993-1000`).
- `DeliveryBadge` (`DeliveryBadge.tsx:34-44`); `StatChips` (`StatChips.tsx:30-56`:
  Recipients, Delivered, Sent, Sending, Queued, Failed, Not confirmed, Skipped);
  `BroadcastStatusPill` (`BroadcastStatusPill.tsx:19-28`); list row "N/M
  delivered" (`BroadcastsList.tsx:144-153`).
- `BroadcastResults.tsx`: pill with stats (`:146`); `last_error` rendered
  verbatim as `role="alert"` whenever present (`:149-153`); the "open
  conversation to retry" hint on every failed row with a contactId except
  `send_unconfirmed` (`:55-56`, `:71-75`).

### 3.6 The contact side reads no share data

The timeline's message projection carries no `broadcast_id`
(`app/src/routes/contactTimeline.ts:427-470`; dashboard TimelineMessage
`types.ts:2530-2548`). A share message renders as a plain one-to-one bubble: its
"will retry" follows its own `retry_due_at` on the server clock
(`dashboard/src/routes/contact/Timeline.tsx:791-795`, `:1044-1060`;
`dashboard/src/api/serverClock.ts`), and a failed row superseded through
`retry_of` is hidden (`Timeline.tsx:2062-2076`). So once a retry delivers, the
tenant's thread shows the delivered retry while the share row still reads Failed
(30003).

### 3.7 Property Activity card, landlord timeline, tenant milestone

- Activity card: `GET /api/units/:unitId/activity` (`app/src/routes/units.ts:1240-1276`)
  projects `broadcastId` + `tenantCount` from `units#` audit rows (`:183-213`),
  limit default 50 / max 100, no cursor (`:215-216`, `:1253`); the label is
  "Sent to N tenant(s)" linking to the share, "Sent to 0 tenants" when the count
  is absent (`dashboard/src/routes/listing/listingFormat.ts:130-136`). The route
  comment claiming sends do not appear there is stale (`units.ts:1237-1239`).
- Landlord timeline: walks up to 25 owned units (`contactTimeline.ts:283`,
  `:1304-1307`), `limit + 1` audit rows per unit (`:1311-1314`); `broadcast_sent`
  -> milestone type `listing_sent`, label "Sent to N tenant(s)", refType
  `broadcast`, refId broadcastId (`:674-689`).
- Neither `units.ts` nor `contactTimeline.ts` has a broadcasts repo dependency
  (grep).
- Tenant timeline "Property sent" = the `listing_sent` activity event
  (`contactTimeline.ts:1282-1289`, `:653-663`); for a unit-targeted share it
  carries no broadcastId (2.8).

### 3.8 Every app reader of the broadcasts repo

`jobs/broadcastFanOut.ts`, `jobs/sendReconcile.ts`, `routes/broadcasts.ts`,
`routes/webhooks/twilio.ts` (instantiated `:568`), `lib/performanceSeed.ts`;
`routes/api.ts:1016` only passes it to the broadcasts router. No listing-send,
units or timeline route reads a share.

---

## 4. Constraints B must respect

- **C1 Forward-only.** No path moves a slot out of failed / delivered / skipped:
  the guard (`twilio.ts:3840-3844`) and every conditional writer's priors
  (`broadcastFanOut.ts:543`, `:744`, `:941-947`, `:1403-1415`;
  `broadcastsRepo.ts:934`; `twilio.ts:3928`, `:3957`). A retry that moves a
  failed slot is ONE new conditional transition - per
  `docs/issues/broadcast-30003-retry-never-updates-slot.md`, "not a relaxation of
  the forward-only guard".
- **C2 Never back to `queued`.** `queued` means "send me" to the fan-out
  (`:202-206`, `:1073`), "close me" to `closeBroadcast` /
  `closeRecipientIfQueued`, and "not finished" to finalize (`:1526-1531`). A
  pending retry must not reuse it; a new status string vanishes from
  `deriveBroadcastStats` (no default arm) and falls back to "Sending..." on the
  dashboard (`broadcastFormat.ts:150-152`) (SOR D10).
- **C3 Blind writers exist.** The fences, the legacy reject arms and the refusal
  arm write with no condition (`broadcastFanOut.ts:660`, `:699`, `:998`) - safe
  only because they run for pass-snapshot non-terminal slots behind the D8 gate
  (SOR errata 8).
- **C4 Atomic stats.** `recordRecipientOutcome` gives slot + bump in one write;
  the rollup's `setRecipient` + `bumpStats` pair does not (`twilio.ts:3949-3975`).
  Displays derive from the map, so counter drift is invisible except on an
  empty-map draft.
- **C5 Per-row idempotency.** The rollup runs once per message transition
  (`transitioned`); the message machine is forward-only
  (`app/src/repos/messagesRepo.ts:133-142`: delivered / undelivered / failed only
  from queued or sent). A failed row never becomes delivered; a retry's delivery
  exists only on the retry row.
- **C6 Ordering.** A retry runs at least one backoff (60 s) after the
  original's failure. For a small share that is after finalize, so the stored
  status can no longer change (`finalizeStatus` flips only from `sending`). A
  pass paced at about one text per second (`A2P_RATE_LIMIT_PER_SEC` default 1.0,
  `app/src/lib/config.ts:302`) outlasts the backoff beyond roughly 60
  recipients, so an early recipient's retry can run - even deliver - while the
  share is still `sending`; finalize reads only the slots, so a retry outcome
  would decide the stored status only if B wrote it into the slot before the
  flip. The original's failure rollup precedes its retry's enqueue in one
  callback (`twilio.ts:3520` vs `:3622`), but it can throw (caught `:3542`) or
  miss the slot (`:3903-3906`), leaving the slot `sent` while the chain
  proceeds: a retry writer whose priors are `['failed']` alone would then refuse.
- **C7 Attribution path.** retry row -> `retry_of` chain -> root row
  (`broadcast_id`, conversationId, tsMsgId) -> slot by conversationId + tsMsgId,
  as the rollup matches. There is no reverse index: the messages table has no
  GSI (`app/src/lib/tables.ts:205-212`); `listByConversation` pages backward only
  (`messagesRepo.ts:1275-1279`); `getManyByTsMsgIds` reads known keys (`:1504`).
- **C8 Stamping `broadcast_id` on retry rows is not free.** The rollup would miss
  the slot (the retry's tsMsgId is not the slot's), wait 2.5 s and WARN on every
  such receipt (`twilio.ts:3890-3906`); `isBroadcastRowFor`
  (`broadcastFanOut.ts:1296-1306`) and the reconcile's `heldBy`
  (`sendReconcile.ts:593-610`) would read a same-share row naming the same (or
  no) contact as that recipient's own row.
- **C9 Record lifetime.** SOR attempt records and index items expire after 30
  days (`app/src/repos/sendAttemptsRepo.ts:47-48`, `:187-189`; `tables.ts:232-235`).
  "Already sent" has no time bound (it reads every share of the unit), so the
  counted fact cannot live only on the record.
- **C10 Item size.** Per-slot additions need a budget at 1500 recipients
  (1.1). Estimate only (UNVERIFIED against real items): today ~200 B x 1500 =
  ~300 KB per the repo's own note; a tsMsgId-sized field with its name (~80-90 B)
  plus a flag per slot would put a capped share near or over 400 KB.
- **C11 Finalize contract.** Every possible last writer calls finalize; it
  defers on `queued`; only the winner audits and emits
  (`broadcastFanOut.ts:1497-1555`). A relabel must not need a re-finalize.
- **C12 Person's share.** A retry follows the original's `automated`
  (`retrySend.ts:322`; `api.ts:1681` is always a person's send); the adoption
  derives `automated` from `created_via` (`broadcastFanOut.ts:1359`). Any retry
  path B touches must keep that.

---

## 5. Gaps between the stub's wording and what the code supports

- **G1 "Its attempt is SOR's send-attempt record, never a second one"
  (prerequisites).** On this `main` the broadcast record is one per
  (broadcastId, contactKey) (`sendAttemptsRepo.ts:50-83`, `:152-161`) and counts
  only the fan-out's own claims of the FIRST text (`broadcastFanOut.ts:869-879`).
  Automatic retries have no record (Stage 1b unbuilt); SOR says Stage 1b's record
  keys on the ORIGINAL MESSAGE and the rung (SOR spec, lines 722-726) - a
  different owner from the broadcast one. The staff Retry route is not a SOR
  adopter at all (SOR spec Sec 2a names only `retrySend`); whether Stage 1b will
  cover it is UNVERIFIED.
- **G2 "Any attempt delivered" / Not decided #1.** The record never learns
  delivery: receipts write only the message row and (first attempt) the slot;
  the adoption closes the record `adopted` with a SID and nothing else. The rule
  cannot be derived from record outcomes; it needs the message lineage or new
  slot state written by a retry-outcome writer.
- **G3 "Newest attempt is queued (share still `sending`)".** A `queued` slot is
  a never-attempted seed, a deferral, an unknown outcome under reconcile, or a
  strand that keeps the share `sending` indefinitely (SOR errata 6; deploy issue)
  - so the rule flags never-texted stranded tenants for good. For a retry there
  is no "queued on our box" state at all, and "(share still sending)" is a
  property of the share, not of the attempt: usually the share has finalized
  before any retry runs, but in a long pass an early recipient's retry can run
  while the share is still `sending` (C6).
- **G4 "Never when every attempt failed".** For the first attempt the slot keys
  split "carrier took it, then it failed" from "no text existed" (1.2 derived
  fact), which answers Branch A section 8's no_contact / transient_cap /
  enqueue_failed case and adds provider rejections; `send_unconfirmed` is the
  exception. For later attempts only the lineage knows.
- **G5 "No pending-retry state" vs Not decided #3.** `retry_due_at` records a
  pending retry, but on the NEWEST failed row of the chain, not the root the slot
  points at; after the first retry, the root's promise has expired. Liveness is
  server-clock based (`app/src/lib/retrySendWindow.ts:93`; dashboard
  `serverClock.ts`). A slot-level "pending" needs a slot write in the 30003 arm
  or a chain walk.
- **G6 "The per-recipient record is bounded (newest attempt plus a delivered
  flag)".** On the slot it meets C10; on the SOR record it meets C9 (and the
  record is first-attempt only, G1).
- **G7 `failed` + `send_unconfirmed` per surface.** Today: flagged only inside a
  `sent`/`sending` share; never in the ledger (no close writes property-sent
  rows); row "Not confirmed"; an all-unconfirmed share's pill "Failed" with the
  prose alert. "Flag as already sent (safe)" needs the status filter at
  `broadcastsRepo.ts:716` gone (the issue's own fix) or a slot-level exception.
- **G8 D5(a).** One rule, one reader holds (only `priorRecipientContactIds`),
  but: the stored-status filter is race-dependent (2.7) and should not survive;
  the harness mirror is unguarded by a parity test; and a rule that needs retry
  outcomes at preview time either reads slot state B writes, or walks lineage for
  every non-skipped slot of every share of the unit.
- **G9 D5(c).** The bound is the PAGE, not "shares per property": up to 100 share
  reads per Activity page; up to 25 x (limit + 1) rows per landlord timeline page
  (3.7). `tenantCount` today is the whole audience, written for failed shares
  too, never updated; a share whose finalize flip was pre-empted by the route's
  `markFailed` has no Activity entry at all. Relabel sites:
  `listingFormat.ts:130-136`, `contactTimeline.ts:680-689`. Both routers need a
  new broadcasts dependency.
- **G10 D5(d).** "The outcome that decides the count" is not on the results wire:
  slots point at the root row only, retries need a conversation Query, the view
  drops tsMsgId, and the page refreshes only on `broadcast.updated`. The RSW rule
  ("a 30003 promises only while the failed message carries a live
  `retry_due_at`", RSW spec D8 lines 353-359) must read the newest failed row.
  The retry hint (`BroadcastResults.tsx:55-56`) invites a Retry the thread hides
  while a promise is live, and after a retry delivered (the root is hidden).
- **G11 D5(e).** List rows have no recipients, so a recipient-derived list label
  must come from the derived buckets or a new summary field - and the buckets
  cannot say "a failed slot a retry delivered" unless the slot moves. The label
  set Draft / Sending / Sent / Not sent drops "Failed" and says nothing about an
  all-unconfirmed share. `last_error` comes from finalize and from the route's
  `markFailed("enqueue failed")`. "A queued slot of a share that is not
  sending" arises exactly from that route path (all slots `queued`, stored
  `failed`, `routes/broadcasts.ts:761-775`); in the ambiguous-enqueue variant the
  slots may be sent / delivered under a stored `failed`. The status tabs stay on
  stored status.
- **G12 I9.** Trivially true today (nothing leaves failed). B's one new
  transition must be conditional on the state it read, never move `delivered` or
  `skipped`, and keep buckets consistent (C1-C4). Per-attempt forward-only
  delivery is already the message machine (C5).
- **G13 Issue to close: the tenant-timeline "Property sent" milestone.** It is
  written at dispatch by the pass and by an adoption, keyed by a random id, and
  for a unit-targeted share stores no broadcastId - a render-time derivation
  cannot find its share, and a second writer would duplicate it.
- **G14 Stale anchors.** `broadcast-30003-retry-never-updates-slot.md` cites
  `twilio.ts:3312/3364/3544/3591`, `sendMessage.ts:425`, `retrySend.ts:200-207`
  (now `:3529`, `:3624`, `:3840`, `:3887`, `:658`, `:317-328`) and says the row
  promises "will retry" (false since RSW; `StatChips.test.tsx:171-182`).
  `unconfirmed-share-invites-resend.md` cites the harness at `:3266-3279` (now
  `:3318-3331`); its other anchors match this commit.
- **G15 Residual: a pre-branch retry whose lineage write never landed.** Since
  RSW D6 the lineage rides the append (`sendMessage.ts:659-665`), so the class
  is closed for rows written after RSW merged; older rows are UNVERIFIED (git
  history not traced).
- **G16 Residual: a re-share during backoff.** RSW's 409 guards only the staff
  Retry route (`api.ts:1608-1611`); a second share is unguarded. Today a failed
  slot stays flagged (inside a sent/sending share), so B's rule change is what
  opens or keeps this window.

---

## 6. Tests and e2e that pin today's behavior

App (vitest):

| file:lines | pins | under B |
|---|---|---|
| `app/test/broadcastFanOut.test.ts:225-266` | stamp `broadcast_id`, slot keys, `sent` | keeps |
| `app/test/broadcastFanOut.test.ts:268-294` | `units#` `broadcast_sent` with `tenantCount` = recipients; none for unit-less | changes if D5(c) touches the row |
| `app/test/broadcastFanOut.test.ts:979-1053` | `listing_sent` milestone + listing-send row per recipient SENT (refType unit), none for skipped / unit-less | changes if the milestone follows the rule |
| `app/test/broadcastFanOut.test.ts:1538-1558` | enqueue failure -> slot failed/`send_unconfirmed`, share `failed`, prose `last_error` | keeps (D16a stands) |
| `app/test/broadcastFanOut.test.ts:2549-2744` | finalize: one flip/audit/emit; all-skipped + unconfirmed -> failed prose; reached -> sent; skips alone -> sent; queued defers | keeps |
| `app/test/deriveBroadcastStats.test.ts:21-150` | buckets, unconfirmed routing, sum invariant | changes if a bucket is added |
| `app/test/broadcastsRepo.integration.test.ts:298-385` | prior set = sent/sending shares only; failed share excluded; skipped excluded, failed slot counted | rewrite |
| `app/test/broadcastApi.test.ts:1088-1242` | `alreadySentThisProperty` + set; phone# match; draft/failed shares excluded; skipped not flagged, failed flagged | rewrite 1183-1242 |
| `app/test/twilioStatusWebhook.test.ts:244-371` | rollup re-read once; carrierSentAt stamp; redelivered `sent` no-op | keeps; add retry-row cases |
| `app/test/sendReconcile.test.ts:324-2013` (broadcast owner) | adoption mapping, property rows only for sent/delivered (`:439`, `:1807`), `automated` from `created_via` (`:426`), unresolved close once (`:1323`) | keeps |
| `app/test/contactTimeline.test.ts:1010-1060` (+ `:1101`, `:1151`, `:1181`) | landlord `broadcast_sent` milestone, label carries `tenantCount` | changes with D5(c) |
| `app/test/unitsApiActivity.test.ts:158-166` | activity projects `broadcastId` + `tenantCount` | changes with D5(c) |

Dashboard (vitest):

| file:lines | pins | under B |
|---|---|---|
| `dashboard/src/routes/broadcasts/broadcastFormat.test.ts:214-231` | `presentShareLabel`: stored sent + 1 skipped + 1 FAILED reads "Sent" (`:224`); failed reads "Failed" (`:226`) | rewrite (D5(e)) |
| `broadcastFormat.test.ts:235-247` | unconfirmed never a skip; sent + skipped + unconfirmed reads "Sent" | re-decide (G7) |
| `broadcastFormat.test.ts:101-208` | recipient status + reason presentation | keeps unless D5(d) changes the row |
| `StatChips.test.tsx:171-182` | a share row's 30003 reads the plain failure, no "will retry" | rewrite with D5(d) |
| `StatChips.test.tsx:32-147`, `:238-257` | chip order / balance; pill "Not sent" | keeps unless a bucket is added |
| `BroadcastResults.test.tsx:139-200` | failed 30003 row shows the retry hint; unconfirmed row has none | re-decide (G10) |
| `BroadcastsList.test.tsx:69-76` | row pill + "delivered/total" | keeps |
| `useBroadcastResults.test.tsx:69-160` | poll only while sending; terminal latch | keeps |
| `dashboard/src/routes/listing/listingFormat.test.ts:181-191` | "Sent to N tenants" incl. "Sent to 0 tenants" | rewrite (D5(c) relabel) |

E2E (`e2e/tests/dashboard-next/`):

| spec:lines | drives | under B |
|---|---|---|
| `share-skip-fix.spec.ts:250-285` | a FAILED (30007) recipient in a share that finalized sent stays "Already sent" - the interim rule, pinned as such | rewrite |
| `share-skip-fix.spec.ts:155-248` | delivered -> flagged + checked; all-skipped -> "Not sent", not flagged | keeps |
| `send-outcome-reconcile.spec.ts:491-567` | all-unconfirmed share: "Not confirmed" row, pill "Failed", prose alert, no retry hint | re-decide (G7/G11) |
| `send-outcome-reconcile.spec.ts:362-489` | re-driven share ends Sent; 21211 row with retry hint, share Sent | keeps |
| `broadcasts.spec.ts:96-230`, `:268-360` | a prior sending/sent share flags Tasha unchecked; live chips, pill reaches Sent | keeps |
| `listing-activity.spec.ts:84-158` | Activity "Sent to 2 tenants" link | keeps if both count |
| `landlord-activity.spec.ts:66-125` | landlord timeline "Sent to 2 tenants" | keeps if both count |

---

## 7. Open questions for the planner

1. Where does the counted-as-sent fact live - new slot fields (C10 budget), a
   read-time lineage derivation (C7 read cost on preview, results, Activity,
   landlord timeline), or SOR's record (C9 TTL; first attempt only, G1)?
2. How does a retry outcome reach its share: attribution stamped on retry rows at
   append (retrySend, the staff route and the `sendMessage` input - files Stage
   1b also owns) plus a rollup lookup keyed on the ROOT (C8), or a lineage walk in
   the webhook for every row with `retry_of`?
3. Does a retry move the slot (failed -> delivered; failed -> sent on dispatch?),
   with which priors (C6: the slot may still be `sent`), which buckets and which
   row label - and does the slot keep the original's 30003 code?
4. Does "counted" read the stored share status at all? (It is race-dependent,
   2.7; dropping it also fixes the two failed-share exclusions in 3.1.)
5. `send_unconfirmed`: flag yes (issue fix)? ledger no (as today)? What does an
   all-unconfirmed share read under D5(e) - "Failed" today?
6. Stranded `sending` shares: should their `queued` slots count forever? Slots
   have no clock (1.1).
7. Pending retry: count a failed slot whose NEWEST failed row has a live
   `retry_due_at`? Which reader finds that row (G5)?
8. D5(c): accept a share read per Activity / landlord row (G9), or maintain a
   counted number with a new writer? What does a share with zero counted
   recipients read on both surfaces?
9. The tenant "Property sent" milestone (G13): record-on-count and retract, or
   leave it and close the issue on another basis?
10. List labels (G11): add a derived bucket to `BroadcastStats` (wire, both
    types, StatChips balance, seeds `matrix.ts:1202-1256`, `performance.ts`) or
    a new summary field?
11. The results row's retry hint: hide it while a promise is live and once a
    later attempt delivered (G10)?
12. The staff Retry route: does it get an attempt record, or is it attributed
    through lineage only (G1)?
