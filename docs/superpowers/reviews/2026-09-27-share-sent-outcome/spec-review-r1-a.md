# Spec review R1 (reviewer A, adversarial) - share-sent-outcome design v1

Date: 2026-09-27. Spec under review:
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` (Branch B,
design v1). Code base: `main` @d9cb5c04 as checked out in
`W:\tmp\share-sent-outcome` (branch head 6e99330d adds only the spec and the
research records). Every `file:line` below was read by this reviewer at that
commit unless marked otherwise. The research records were used as a map only.

One source is NOT on main: the Stage 1b spec this branch depends on,
`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` on
`feat/retry-send-adoption` @08a41dc7 (read with `git show`, revision 2). It is
cited as "1b spec" and only as the other side of the interface section 0
defines; every finding that cites it also stands on main-side evidence.

Severity is consequence-if-shipped: BLOCKING = the build cannot proceed
correctly without a new decision; LOW = worth a sentence.

---

## 1. [BLOCKING] A retry ruled `unresolved` has no defined state; D1 un-counts it, against the spec's own goal and the prerequisite's recorded contract

**What is wrong.** The spec never says what a recipient is when a RETRY (not
the original) ends unresolved - the text may well have reached the tenant.

- Section 2 goal: "a recipient whose text may have arrived (a live retry
  promise, "Not confirmed") keeps the safe flag on the review list and is
  never offered pre-checked."
- Section 0: "a retry the reconcile rules `unresolved` withdraws the
  original's promise". D1 does NOT count "failed with no live promise - ...
  the promise was withdrawn". So D1 puts exactly this may-have-arrived tenant
  in the pre-checked set. That is a direct contradiction inside the spec.
- The slot cannot even see the event. D2: a slot learns a retry only from the
  retry row's carrier receipts; an unresolved retry has no row (the provider
  lookup found nothing), so no receipt. I7: "Stage 1b writes nothing to a
  share slot". The slot stays at the previous attempt's `failed`/30003 and
  its copied promise lapses.
- D7 lists "the reconcile's unresolved close marks it `unconfirmed`" inside
  the "status webhook's rollup (new)" bullet. The webhook never sees a
  reconcile close, and no reconcile-side ledger writer for a RETRY owner is
  assigned (I7 says the interface is only the two row fields).
- D6's third word set, "Property sent - not confirmed", is unreachable for an
  original: the milestone is written only after a recorded acceptance or an
  adopted sent/delivered (`app/src/jobs/broadcastFanOut.ts:817-832`,
  `:1456-1463`), while an unresolved close only moves a `queued` slot
  (`app/src/jobs/sendReconcile.ts:1003-1024` -> `closeSlot` ->
  `closeRecipientIfQueued`, `app/src/repos/broadcastsRepo.ts:931-935`). An
  original never has both a milestone and an unresolved outcome. The words
  exist only for the retry case, which has no writer.

**Evidence from the prerequisite (1b spec, branch, not main).** Section 0
records the ruling: "Branch B counts such a recipient as 'already sent' on
the review list (the safe flag, as `send_unconfirmed`) and not in the
ledger." R4 (`unresolved`): close the record, then WITHDRAW on the RETRIED
ROW with `retry_outcome: 'unconfirmed'`, emit `message.persisted` - no slot
or ledger write. R5: the conversation hides Retry when `retry_outcome ===
'unconfirmed'`. R10 ("what Branch B reads (contract)") lists
`retry_due_at = RETRY_PROMISE_WITHDRAWN_AT` and `retry_outcome` on the
retried row. This spec never mentions `retry_outcome`, and D1 reads only the
slot.

**What it implies.** A builder gets contradictory instructions from the two
specs it must build on. As written, an unresolved retry's tenant is offered
pre-checked on the next share (the double text `unconfirmed-share-invites-resend`
closes for originals, reopened for retries); the share row shows a plain
failure plus "open conversation to retry" while the conversation hides Retry
and the route answers 409 `retry_unresolved` (1b R6) - I5 broken; D6/D7's
`unconfirmed` state is dead. A decision is needed before planning: where the
"retry unresolved" fact lands on the share side (a sanctioned slot write, or
a read of the retried row), and what the composer, the row, the label and the
ledger each do with it.

---

## 2. [HIGH] The slot's promise is a one-time copy; the message row's promise is refreshed and withdrawn after it, so the share side diverges from the thread and the Retry guard while a retry is still pending

**What is wrong.** D3 stamps the promise on the slot once (in the rollup's
failure write) and withdraws it "when the message's promise is withdrawn".
It never refreshes it. But the retry path is REQUIRED to refresh the message
row's promise while a retry is pending:

- RSW section 5 requirement 3 (main,
  `docs/superpowers/specs/2026-09-24-retry-send-window-design.md:628-634`):
  any path that defers a one-to-one retry or leaves its outcome pending past
  `retry_due_at` refreshes `retry_due_at` and emits `message.persisted`.
- RSW D8 (same file `:310-313`): the share row's promise follows "the failed
  message['s] live `retry_due_at`" - the message row is the source of truth.
  This spec's non-goals claim it "reads RSW's promise, it does not restate
  it"; the slot copy restates it and drifts.
- 1b spec R3/R4 (branch): REFRESH on a deferral (new run time), on an
  unknown outcome (`attemptedAt + 240 s + 2 min`), on a takeover and on a
  `never_sent` re-drive; WITHDRAW on unresolved. None writes the slot.
- Nothing carries a refresh to the share side: the rollup runs only on a
  delivery TRANSITION (`app/src/routes/webhooks/twilio.ts:3520`, `:3529`),
  not on an annotation; the results page listens only to `broadcast.updated`
  (`dashboard/src/routes/broadcasts/useBroadcastResults.ts:118-138`).
- D3's withdrawal writers are unassigned: the webhook's enqueue-failure
  withdrawal runs after the rollup (`twilio.ts:3531` vs `:3622-3657`) and is
  not in section 5's slot-writer list; "1b's declines" cannot write the slot
  (I7; D2 "the retry job writes nothing to the share").
- The slot promise's lifecycle is otherwise unstated: the existing rollup
  writes `{ ...slot, status, errorCode? }` (`twilio.ts:3949-3958`), so
  without an explicit "every move replaces the promise" rule a stale promise
  rides onto the next attempt's failure (e.g. a retry that then fails 30007
  inside the old promise's grace reads "will retry").

**What it implies.** During a deferral, an unknown outcome or a re-drive
(prod reconcile checks at 5/30/240 s, `app/src/lib/sendOutcome.ts:30`, plus
the 2-minute grace) the slot's copy lapses while the thread still promises
and refuses Retry: D1 un-counts the tenant (pre-checked on a re-share while a
retry may already be out), D3 shows "open conversation to retry" for a
press the route answers 409 (I5 broken), D4/`retry_pending` stop reading
Sending, and I1 fails (thread and share disagree). The design needs either a
share-side writer for every promise change or a read-through to the retried
row.

---

## 3. [HIGH] An adopted retry never reaches its slot: its receipts were dropped before the row existed, and nothing else may write the slot

**What is wrong.** Section 0 names "adopted" among the retry rows that route
by `broadcast_id` + `retry_root`, and D2 learns a retry only from that row's
receipts. An adopted row is appended by the reconcile AFTER the provider
already holds the message; the receipts that arrived before it were dropped:

- `twilio.ts:3353-3370` (one 2.5 s re-read) and `:3408-3422`: "status
  callback for unknown provider SID after retry - delivery outcome dropped",
  acked 200 so Twilio does not redeliver.
- The rollup needs a transition of an existing row (`twilio.ts:3462-3467`,
  `:3520`); a row appended already `delivered` never transitions again.
- SOR's own share adoption writes the slot itself for exactly this reason:
  slot from `queued` with the provider's mapped status in the adoption
  (`broadcastFanOut.ts:1395-1416`; header `:1308-1340`, "the webhook's side
  effects ... never ran").
- Prod reconcile checks run 5 s, 30 s, 240 s after the attempt
  (`sendOutcome.ts:30`); carrier sent/delivered callbacks usually land within
  seconds, so the adopted row is typically already `sent` or `delivered`.
- D2: "the retry job writes nothing to the share"; I7: 1b writes nothing to a
  share slot. 1b spec R4 (branch): Adopt appends with `deliveryStatus` from
  the provider message and writes no slot.

**What it implies.** A retry that delivered through adoption leaves the slot
at the previous attempt's failure: row Failed with the retry hint (while the
conversation's tail is the delivered retry, no Retry), share "Not sent",
tenant not flagged, so a re-share pre-checks a tenant who received the text.
D7's re-count never runs for it either. `broadcast-30003-retry-never-updates-slot`
is not closed for this path. Needs a decision: a sanctioned exception to I7
(the retry adoption writes the slot, as SOR's does) or an event the share
side consumes.

---

## 4. [HIGH] D7 stores a time-bound fact as a permanent state: a pair counted by a live promise is never un-counted when the promise lapses without a receipt

**What is wrong.** D1 judges a promise live at read time (`retry_due_at` +
2 min on the server clock, `app/src/lib/retrySendWindow.ts:29`, `:93-98`).
D7 instead WRITES "a 30003 with a promise leaves it counted" into the ledger,
and its only later writers are receipt-driven (the rollup), the reconcile's
unresolved close, and the one-shot repair. No receipt ever arrives when the
retry is declined or never sent:

- job-side exits return without writing anything: original missing / not
  outbound (`app/src/jobs/retrySend.ts:174-182`), window closed (`:244-255`),
  `SendRefusedError` (`:330-337`); accepted as wontfix on the message side
  (`docs/issues/one-to-one-retry-promise-outlives-job-decline.md`, status
  wontfix), and kept by 1b ("after a refusal, a rejection, a window close or
  a success, the retried row's promise EXPIRES", 1b spec section 0 and R3);
- the webhook's enqueue failure, which runs after the rollup already left the
  entry counted (`twilio.ts:3531` vs `:3624-3657`) - D7 names no ledger
  writer there;
- a crash between the status write (`twilio.ts:3462`) and the enqueue.

The ledger has no clock and no TTL (`app/src/lib/tables.ts:402-425`,
`app/src/repos/listingSendsRepo.ts`), and D7's sparse-by-absence GSI cannot
drop a pair on a clock.

**What it implies.** For every declined or lost retry the pair stays in
"Properties sent", keeps its `sentAt` ordering (the tour form default), and
its milestone reads "Property sent" (D6 reads the ledger) - permanently -
while the composer, the row and the label say not sent. I1 and I6 fail, and
D6 fails to close its own issue for the 30003 case. The repair cannot help
after it runs. Needs a decision, for example: the ledger does not count a
pending promise (the retry's acceptance re-counts within minutes; D1 already
carries the safe direction for the composer).

---

## 5. [MEDIUM] I1's "one rule, every surface" is false by design: D1, D4/D5 and D7 use three different predicates

**What is wrong.** D1 counts delivered | sent | failed with a live promise |
`send_unconfirmed`. D4's "Sent" and D5's N count only reached (sent |
delivered). D7 counts accepted | delivered | failed-with-promise and
excludes unconfirmed ("recorded but never counts in the ledger ... it counts
for the composer flag (D1)"); D6 reads D7. I1: "every surface reads that one
rule: the composer flag, the results row, the labels, the counts, the ledger,
the milestone."

**What it implies.** With a retry pending, one tenant is "Already sent" (D1),
listed under "Properties sent" with a "Property sent" milestone (D7/D6),
counted out of "Sent to N tenants" / "No tenants reached" (D5), under a
"Sending" pill (D4) - the "different stories" the Problem section sets out
to end. I1 cannot be tested as written; it needs to be restated as a
per-surface table of which predicate each surface reads and why.

---

## 6. [MEDIUM] D1 misdescribes `queued`: a queued slot can hold a text that may already have gone out

**What is wrong.** D1 says a queued slot means "no text has been attempted: a
seed not yet reached, a deferral, a strand", and uses that to justify "queued
never counts". In the code a queued slot is also:

- an UNKNOWN outcome under reconcile: "the slot stays `queued` and only the
  verdict writes it" (`broadcastFanOut.ts:33-36`; `onUnknown` ->
  `handToReconcile`, `:776-814`, `:598-614`);
- a send the provider ACCEPTED whose recording failed: record-phase throw and
  `SendAcceptedNotRecordedError`, handed to reconcile WITH the SID, slot left
  queued (`:975-985`, `:1029-1036`; `app/src/services/sendMessage.ts:672-683`);
- a strand that waits for the unbuilt sweeper (`broadcastFanOut.ts:407-415`,
  `:592-597`).

**What it implies.** For the reconcile window (5/30/240 s checks plus one
re-drive in prod; indefinitely for a strand) a re-share pre-checks a tenant
whose text may be delivered - against the section 2 goal and exactly the
double text SOR exists to prevent. D1's cost statement ("the window is the
pass itself") rests on the wrong enumeration. Either distinguish a queued
slot whose attempt is open or handed off (the send-attempt record knows) from
a never-attempted one, or accept this window explicitly at the gate.

---

## 7. [MEDIUM] D1 turns an existing deterministic e2e into a timing-dependent one, and section 7 does not list it

**What is wrong.** `e2e/tests/dashboard-next/broadcasts.spec.ts:124-138`
sends a prior share to Tasha through the API and, without waiting for any
delivery, previews and asserts "Already sent" (`:172-175`). Today a queued
slot of a `sending` share counts (`broadcastsRepo.ts:716`, `:731`), so the
flag is deterministic. Under D1 it appears only if the fan-out reached Tasha
before the preview; in the lane jobs run in-process behind an admission token
bucket (`app/src/jobs/queueWiring.ts:122-131`,
`app/src/adapters/scheduler.ts:194-197`). Section 7 names only the
interim-rule and all-unconfirmed tests for rewriting. (The hermetic
`app/test/broadcastsRepo.integration.test.ts:298-347` also pins queued slots
of sent/sending shares as prior recipients.)

**What it implies.** A new intermittent failure in a gate spec (AGENTS.md
treats a named-spec failure as a regression). The spec should name the change
- wait for Delivered first, as `share-skip-fix.spec.ts:196` already does.

---

## 8. [MEDIUM] D3's hint rule contradicts its own list and an existing e2e: failures with no message row have nothing to retry

**What is wrong.** D3: the hint "appears only when the conversation would
offer Retry: never while a promise is live, never on "Not confirmed", never
once a later attempt delivered." The conversation's Retry sits on a failed
bubble (`dashboard/src/routes/contact/Timeline.tsx:1423-1426`). A provider
rejection throws before the append (`sendMessage.ts:620-625` vs `:672-683`)
and its slot is written without keys (`broadcastFanOut.ts:737-747`), as are
`no_contact`, `transient_cap` and `enqueue_failed` (`:245-250`, `:452`,
`:1166-1172`): no bubble, no Retry. The list omits them, and
`e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:457-464` pins the
hint on a 21211 row as the positive control. After 1b the conversation also
hides Retry on `retry_outcome: 'unconfirmed'` (1b spec R5), a fourth case D3
does not list.

**What it implies.** The builder must pick between the principle (drop the
hint on keyless failures and rewrite the SOR control) and the list (keep a
hint pointing at a thread with nothing to retry). Decide, and name the test.

---

## 9. [MEDIUM] The `retry_pending` bucket is undefined where it matters: finalize, the chip balance, and staleness on the list

**What is wrong.** D4 adds `retry_pending` "derived on the server at read
time ... beside the existing buckets; the Failed chip excludes it", and says
finalize is unchanged. But finalize decides from the same derivation:
`failedAny = failed + unconfirmed`, and `last_error` picks "Couldn't confirm
any text went out" when `failed === 0` (`broadcastFanOut.ts:1532-1537`).
StatChips documents that its buckets sum to Recipients
(`dashboard/src/routes/broadcasts/StatChips.tsx:4-8`, `:31-40`).
`deriveBroadcastStats` is pure today and feeds the fan-out's worker emits,
the webhook's emits, the list, the results and finalize
(`broadcastFanOut.ts:226-232`, `twilio.ts:3933-3937`, `:3978-3982`,
`app/src/routes/broadcasts.ts:293`, `:311`). The list refreshes only on
`broadcast.updated` and has no ticker
(`dashboard/src/routes/broadcasts/useBroadcastsList.ts:111-124`); the results
pill reads stats, not slots (`BroadcastResults.tsx:146`).

**What it implies.** Carved out of `failed`: a share whose only non-skipped
recipients are retry-pending at finalize is stored `sent` with no
`last_error` (today `failed`), and a pending-plus-unconfirmed share gets the
"Couldn't confirm" prose. Overlaid: a retry-pending recipient sits in no
chip. Either way the value is clock-dependent at emit time, and a lapse with
no following event (findings 2 and 4) leaves the list pill "Sending" until a
reload - I5 broken on the list. Decide disjoint or overlay, whether finalize
reads it, which chip shows it, and how the list re-judges it.

---

## 10. [MEDIUM] Item size: the worst case does not fit at today's cap, so "lower the cap" is the expected outcome - a staff-visible change not raised at the gate

**What is wrong.** The spec's baseline ("about 200 bytes per slot ... near 300
KB") is the repo comment (`broadcastsRepo.ts:56-68`), written before
`carrierSentAt`. With the code's own names and id formats - `contact-<uuid>`
keys (`app/src/repos/contactsRepo.ts:1196`), `conv-<uuid>`
(`app/src/repos/conversationsRepo.ts:1268`), `tsMsgId` = ISO + `#` + SID
(~59 chars), `carrierSentAt` ISO - a failed slot is roughly 235 B, about 350
KB at 1500 slots before the rest of the item. The two added attributes (a
second ~59-char pointer and an ISO instant, with their names) add roughly
100 B, about 500 KB worst case. SOR declined even one extra per-slot
attribute on this ground (SOR spec `:464-466`). Estimate only - real item
sizes UNVERIFIED.

**What it implies.** A mass 30003 on a large share makes the D2 writes, and
the original's now promise-carrying failure writes, fail with a size error
that the rollup catches and logs (`twilio.ts:3542-3544`), leaving slots stale
- a regression of today's failure rollup for the remaining recipients; the
repair's writes fail the same way. Lowering `MAX_BROADCAST_RECIPIENTS`
changes what staff can send (the route's `audience_too_large`,
`broadcasts.ts:686`, `:729`) and cannot protect shares already stored at the
old cap. It belongs in section 9, not a risk bullet.

---

## 11. [MEDIUM] D6 closes its issue only for milestones written after deploy

**What is wrong.** Existing milestones carry no share id
(`broadcastFanOut.ts:1219-1226`: refType `unit`, refId unitId); the activity
repo has no update method (`app/src/repos/activityEventsRepo.ts:102-110`);
D8 repairs slots, retry rows and ledger rows, not milestones. D6's fallback
covers "a milestone whose pair has no entry", not a milestone with no share
id whose pair HAS entries.

**What it implies.** Every "Property sent" written before deploy for a text
that failed keeps saying so, yet D9 lists
`tenant-timeline-property-sent-milestone-after-failed-delivery` as closed.
The builder must also invent how a share-id-less milestone reads (the pair's
`counted` flag would mislabel a pair with several shares). State "closes
prospectively", or make D8 back-stamp milestones.

---

## 12. [MEDIUM] D7's order-independence rests on an unstated decision: the failure callback must CREATE a tombstone

**What is wrong.** D7's rollup bullet "marks the entry `failed`". The spec
then claims the pass's later write "cannot resurrect the entry". That holds
only if the callback CREATES a per-share entry (and, for a first share of the
pair, a row) when none exists yet. The callback-first order is common:
`afterSend` acquires the A2P token before `recordPropertySent`
(`broadcastFanOut.ts:817-831`; its own note: a callback "can fire within the
~1s token gap", `:931-935`); the app process paces the fan-out with the same
bucket (`app/src/index.ts:56`); the lane's fake fails about 300 ms after the
send (`e2e/tests/dashboard-next/share-skip-fix.spec.ts:260`). Today's
`recordSend` is an unconditional upsert (`listingSendsRepo.ts:136-172`).
Also: "the reconcile's unresolved close marks it `unconfirmed`" is filed
under the webhook bullet but lives in `sendReconcile.ts:1003-1024`; and a
`phone#` slot is re-resolved by `findByPhone` at callback time
(`broadcastFanOut.ts:1196-1198`), which can name a different contact than the
pass wrote the row under.

**What it implies.** Built as "mark an existing entry", every paced recipient
after the first can resurrect a failed pair. A created tombstone for a
first-time pair is a base-table row with no `sentAt` that "Sent to tenants"
must filter. State the creation rule and the writer placement.

---

## 13. [MEDIUM] Legacy ledger rows lose pre-branch history the first time a later share fails

**What is wrong.** D7: absent `counted` reads counted, and `counted` = "any
share entry is counted". A legacy row whose FIRST per-share entry is a
failure (a new share that fails) has entries {S_new: failed} -> counted false
-> `sentAt` removed. Rows the repair cannot judge stay legacy (D8 "rows it
could not judge"); between deploy and the repair every row is legacy; the
full seed's `via: 'individual'` rows carry no broadcastId
(`app/src/lib/seed/matrix.ts:1274-1285`).

**What it implies.** A tenant who DID receive the property earlier vanishes
from "Properties sent" and the tour default moves - until the repair (or
forever, for an unjudgeable row). Needs a rule that carries a legacy row's
counted state into the per-share memory on its first write.

---

## 14. [LOW] I2's ledger clause is not delivered by D7's rule

The entry states (`counted | unconfirmed | failed`) do not record "counted by
a delivery", and "applies only when its attempt is newer" lets a later
attempt's failure un-count a delivered share. The staff Retry route accepts
any failed row indefinitely (`app/src/routes/api.ts:1556-1566`, `:1595-1598`),
so a superseded chain member is retryable by API; the slot refuses (D2 never
from `delivered`), the ledger does not. Rare, but I2 as written is false; add
"never from delivered" to the ledger rule.

## 15. [LOW] I4 contradicts "the fan-out's arms (unchanged)"

Blind `setRecipient` plus a separate `bumpStats` remain in the fence, legacy
reject and refusal arms (`broadcastFanOut.ts:660-665`, `:698-705`,
`:997-1003`) and in today's rollup (`twilio.ts:3949-3975`). Scope I4 to this
branch's writes or convert the old writers; the builder cannot tell which.

## 16. [LOW] D4's `last_error` list omits finalize's "all recipients failed"

`broadcastFanOut.ts:157-160`, `:1536-1537`. When a failure lands before
finalize, the header can read "Sending" (retry pending) or "Not confirmed"
over the alert "all recipients failed". Also: a share the route marked
`failed` with every slot still `queued` (`broadcasts.ts:761-775`) matches
"Not sent", whose tone rule covers only failed or skipped recipients.

## 17. [LOW] D2 misdescribes how an original's acceptance is learned

"A retry's ACCEPTANCE is learned from the carrier's own `sent` callback ...,
as it is for an original." For an original the pass writes `sent` at
dispatch (`broadcastFanOut.ts:940-947`); the callback only stamps
`carrierSentAt` (`twilio.ts:3915-3940`). So a retry never shows D1's
"accepted, whether or not the carrier has confirmed it" state; the slot stays
`failed` until the carrier's callback.

## 18. [LOW] D8's cross-reference and rationale do not stand alone

"The D1/D2 ops-script shape" means Branch A's D1/D2
(`docs/superpowers/specs/2026-09-24-share-skip-fix-design.md:127`, `:151`;
`app/scripts/conversation-automation-census.ts`,
`app/scripts/enable-conversation-automation.ts`), not this spec's D1/D2.
Step 2's "so in-flight chains route after the deploy" is off: automatic
chains end within 15 minutes (`retrySendWindow.ts:15`) and the repair runs
later on Cameron's go; the stamp serves only later staff Retries of old rows.
"Walks every share (the shares index)": byCreated membership needs
`_listPartition`, which older rows lack until
`app/scripts/backfill-broadcast-list-partition.ts` has run
(`broadcastsRepo.ts:49-54`) - UNVERIFIED for prod. Section 8's "a two-line
append change in the retry job and the route" omits the adoption append that
section 0 names.

## 19. [LOW] Unenumerated test double: the harness ledger fake

`app/test/helpers/twilioWebhookHarness.ts:3044-3085` returns every row from
`listByContact` and sorts on `sentAt`; it has no sparse-index behavior and no
per-share memory. Section 5 names only the composer double. Without a named
change, hermetic tests pass where the real sparse GSI behaves differently.
