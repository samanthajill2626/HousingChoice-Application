# Spec review R1, reviewer B - share-sent-outcome design v1 (Branch B)

Date: 2026-09-27. Spec under review:
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` (design v1).
Code: worktree `W:\tmp\share-sent-outcome` at main @d9cb5c04 (read-only; nothing
run). Every file:line below was read by this reviewer at that commit. The three
research records beside this file were used as a map only; each claim taken
from them was re-read in code. UNVERIFIED marks what the code cannot settle
(chiefly Stage 1b, which is unbuilt and has no addendum in the repo).

Spec line numbers refer to the spec file as committed (section 0 = 19-42,
D1 = 107-145, D2 = 147-173, D3 = 175-190, D4 = 192-212, D5 = 214-224,
D6 = 226-235, D7 = 237-274, D8 = 276-301, invariants = 312-339, surfaces =
341-364, testing = 382-408, risks = 410-439).

## Summary

1. [BLOCKING] An adopted retry never reaches its slot or the ledger: receipts are the only writer, and an adopted row produces no transitioning receipt
2. [BLOCKING] A retry that is pending past its due time or ends unresolved under 1b cannot be represented on the slot; the section 0 "withdraw on unresolved" requirement makes D1 un-count, and D3 invite a Retry of, a text that may have arrived
3. [HIGH] The ledger counts a live promise but has no writer when that promise lapses or is withdrawn without a retry outcome, so "Properties sent", the tour default and the milestone stay "sent" for good
4. [MEDIUM] `retry_pending` is undefined against finalize and the chip sum: carved out of `failed` it changes finalize's stored status; overlapping it breaks the balanced chip row; either way `deriveBroadcastStats` becomes clock-dependent across seven callers
5. [MEDIUM] I5 fails on the list page: its "Sending" pill comes from a count the list never re-judges (no ticker, no poll), and a withdrawal emits nothing the share pages hear
6. [MEDIUM] D1 misdescribes `queued`: a reconciling slot and a stranded pass's mid-send slot are `queued` with a text that may have arrived, so D1 un-flags exactly the case it promises to keep flagged - a regression from today
7. [MEDIUM] D2 names SOR's status-only primitive, which cannot express its attempt-ordering rule: a delayed same-retry `sent` can overwrite that retry's `failed`, or a strict CAS drops a `delivered`
8. [MEDIUM] D7's read-modify-write has no conflict rule; a lost race in the one-shot webhook rollup is never retried, so the callback-first order the spec designs for can still leave a failed attempt counted, and slot and ledger drift with no healer after the one-time repair
9. [MEDIUM] I1 ("one rule, every surface") is contradicted by the spec's own four projections: flag, ledger, labels and "Sent to N" each count a different set
10. [MEDIUM] A legacy ledger row loses its pre-existing share on the first new write: per-share memory starts empty, so one failed new share removes `sentAt` from a pair whose older share counted
11. [MEDIUM] The ledger's `unconfirmed` state has no well-defined writer and no reader: the share's own unresolved closes carry no attempt id, happen at three unlisted sites and never follow a milestone; "Property sent - not confirmed" is unreachable
12. [MEDIUM] D6 cannot relabel any existing milestone (none carries a share id, D8 does not touch milestones, and no rule covers a share-id-less milestone), so the "closes" claim and Goal 4 hold only for shares sent after deploy
13. [MEDIUM] D3's hint rule ("only when the conversation would offer Retry") removes the hint from every synchronously rejected or fenced failure and breaks a pinned SOR e2e that section 7 does not list
14. [MEDIUM] The item-size risk is real by the repo's own numbers: the "if it does not fit, lower the cap" branch is certain, product-visible and not at the spec gate, and an over-limit write throws mid-pass rather than failing a condition
15. [LOW] I4 is false on day one: the "unchanged" fan-out arms and today's rollup write the slot and bump stats in separate writes
16. [LOW] "Newest attempt wins" refuses the delivery of an older overlapping attempt, and D7's newer-attempt rule can un-count a share whose earlier attempt delivered, contrary to I2
17. [LOW] D2's "as it is for an original" misdescribes today: an original's `sent` is written at dispatch; only `carrierSentAt` comes from the callback
18. [LOW] D1's `queued` change breaks tests section 7 does not name (a repo integration test pins queued slots as counted) and makes a broadcasts e2e depend on fan-out timing
19. [LOW] Between 1b's deploy and this branch's, every share-retry receipt stalls the webhook ~2.5 s on the rollup's miss re-read before the INFO line
20. [LOW] D8 leaves known-wrong slots unrepaired (a slot stuck `sent` after a lost failure rollup), relies on an index that misses un-backfilled shares, and resolves phone-keyed pairs at repair time

---

## 1. [BLOCKING] An adopted retry never reaches its slot or the ledger

**What is wrong.** The spec makes carrier receipts the ONLY path by which a
retry's outcome reaches the share: "A retry's ACCEPTANCE is learned from the
carrier's own `sent` callback for the retry row ... the retry job writes
nothing to the share" (D2, 169-173), "1b writes nothing to a share slot"
(section 0, 40-41), and "The interface between them is the two fields on the
retry row" (I7, 331-333). Section 0 (35-36) explicitly includes the rows 1b's
reconcile ADOPTS. An adopted row produces no transitioning receipt, so the
rollup never runs for it.

**Evidence.**
- The rollup runs only when THIS row's own status transition applied
  (`app/src/routes/webhooks/twilio.ts:3462-3467`, gate `:3520`, share gate
  `:3529`); a redelivered or regressing receipt does nothing (comment
  `:3426-3428`).
- Terminal message statuses have no successors
  (`app/src/repos/messagesRepo.ts:133-142`).
- A receipt that arrives before its row exists waits once and is dropped with
  ERROR (`twilio.ts:3353-3370`, `:3408-3422`).
- SOR's own adoption precedent appends the row AT THE FETCHED PROVIDER STATUS
  (`app/src/jobs/broadcastFanOut.ts:1360`, append `:1366-1381`,
  `deliveryStatus: rowStatus`) and therefore writes the owner's slot itself
  (`:1395-1416`) - precisely because receipts will not do it. The relay adoption
  does the same (`app/src/jobs/sendReconcile.ts:637-649`).
- Reconcile checks run at 5 s / 30 s / 240 s (`app/src/lib/sendOutcome.ts:30`);
  the lane uses 2/4/8 s (`sendReconcile.ts:149-152`) while the fake posts
  `sent`/terminal receipts at +150/+300 ms
  (`fake-twilio/src/engine/delivery.ts:8-31`). In the hermetic lane an adopted
  retry's receipts therefore ALWAYS precede its row and are dropped.
- UNVERIFIED: 1b's adoption append status (1b is unbuilt); the precedent above
  is verified.

**What it implies.** For every retry whose send outcome was unknown and which
the reconcile later finds and adopts - the population SOR exists for, clustered
in provider outages - the slot keeps the ORIGINAL's 30003 failure, its promise
lapses, D1 un-counts a tenant whose retry was delivered (offered pre-checked on
the next share), and D3 shows a plain 30003 failure with "open conversation to
retry" while the thread shows the adopted retry Delivered (the adopted row
carries `retry_of`, so the thread hides the original,
`dashboard/src/routes/contact/Timeline.tsx:2066-2075`). The ledger stays
`counted` only by accident (no lapse writer - finding 3), and stays counted
even when the adopted retry FAILED. `broadcast-30003-retry-never-updates-slot`
is not closed for this population. The fix needs a writer at adoption (1b
calls a shared "roll this attempt into its share" step, or writes the slot
through D2's transition), which changes I7 and section 0 - and 1b is being
built against those words now, so this must be settled before 1b merges.

## 2. [BLOCKING] Pending and unresolved retries under 1b cannot be represented on the slot

**What is wrong.** The slot holds a COPY of the promise, stamped once by the
rollup (D3, 181-186) and never refreshed; the only writers named for its
withdrawal are the webhook's enqueue failure and "1b's declines" - but I7 and
section 0 forbid 1b to write a slot, so the second has no writer. Meanwhile 1b
already owes the MESSAGE row a refresh: RSW requirement 3 obliges any path
that "leaves [a one-to-one retry's] outcome pending past `retry_due_at` (a
deferral, or an `unknown` send outcome awaiting reconcile checks at about 5
seconds, 30 seconds and 4 minutes)" to keep the promise up "by refreshing
`retry_due_at`" (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md:627-633`;
SOR assigns it to 1b, `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md:199-208`).
And section 0 (38-40) tells 1b that a retry ruled `unresolved` "withdraws the
original's promise" - with no way for the slot to record that the newest
attempt ended "Not confirmed".

**Evidence.**
- `send_unconfirmed` reaches a share slot only through the share's own closes,
  which move a `queued` slot only (`sendReconcile.ts:936-941`, `:1003-1024`;
  `broadcastsRepo.ts:931-935`). A retry's slot is `failed`, never `queued`.
- The staff Retry guard is the promise alone
  (`app/src/routes/api.ts:1599-1611`); the thread hides Retry only while the
  promise is live (`Timeline.tsx:791-795`); an unresolved retry has no row, so
  nothing names the previous row in `retry_of` and it stays the visible tail
  (`Timeline.tsx:2066-2075`).
- `docs/issues/manual-retry-double-send-residual-windows.md:34-41`, `:67-68`:
  gaps 3 (pending past `retry_due_at`) and 4 (unresolved retry, "the retry's
  text may have gone out") belong to 1b to CLOSE.

**What it implies.**
- Pending: once the slot's copy passes due + 2 min while 1b keeps the message's
  promise refreshed, D1 reads "failed, no live promise" and un-counts the
  tenant, the results row drops "will retry" while the thread still shows it,
  and the hint invites a Retry the route refuses with 409 `retry_pending` -
  I5 ("never invites a Retry the conversation would refuse") is violated.
- Unresolved: the slot reads a final failure; D1 un-counts a recipient whose
  text may have arrived - the exact case D1 (123) and Goal 3 (86-89) say keeps
  the safe flag; the results row offers "open conversation to retry"; and the
  withdrawn promise re-arms the thread's Retry immediately, so staff are
  invited to double-text - the opposite of closing gap 4. UNVERIFIED whether 1b
  adds a claim-based Retry guard that would refuse the press; the share-side
  consequences hold either way.
- The requirement is being built into 1b now; section 0 must say what the slot
  records for a pending and an unresolved retry, and who writes it, before 1b
  merges.

## 3. [HIGH] The ledger counts a live promise but has no writer when it lapses

**What is wrong.** D7 stores `counted` for "failed with a live promise"
(241-243) and its rollup writer "leaves it `counted`" on a 30003 with a
promise (260). The spec's own promise is time-bound: "liveness is time-bound,
withdrawal is an accelerator" (D3, 185-186). Nothing in D7's writer list
(254-263) fires when the promise lapses or is withdrawn without a retry
outcome.

**Evidence.**
- The webhook's enqueue-failure withdrawal runs AFTER the rollup in the same
  callback (`twilio.ts:3531` vs `:3622-3657`) and writes only the message row.
- The retry job's exits that send nothing write nothing anywhere: original
  missing / not outbound (`app/src/jobs/retrySend.ts:174-182`), duplicate
  marker (`:210-219`), window closed at job time (`:244-255`), refusal
  (`:330-337`).
- 1b's declines and unresolved closes (finding 2) are 1b's code, outside I7's
  interface.

**What it implies.** For every 30003 whose promised retry never produces a
receipt, the pair stays under "Properties sent", keeps the tour form's default,
and the milestone reads "Property sent" forever, while the composer (slot plus
clock) un-counts the same recipient. D7's title claim and I1 fail by
construction for this class; D8 fixes it once. The decision has to change
before building: do not count a pending promise in the ledger (accept a
bounded flicker until the retry is accepted), or store the due instant and
judge it at read time (not expressible through the sparse `sentAt` index), or
add a lapse writer.

## 4. [MEDIUM] `retry_pending` is undefined against finalize and the chip sum

**What is wrong.** D4 (209-212) adds `retry_pending`, "failed slots with a
live promise, derived on the server at read time ... the Failed chip excludes
it", while section 5 (347) says finalize is "unchanged" and D4 (207-209) says
the stored status is unchanged. The spec does not say whether the new bucket
is disjoint from `failed` or a subset of it; both readings break something.

**Evidence.**
- Finalize decides the stored status and `last_error` from
  `deriveBroadcastStats` (`broadcastFanOut.ts:1532-1537`).
- `deriveBroadcastStats` is the single, pure derivation
  (`app/src/repos/broadcastsRepo.ts:239-325`) with seven call sites: results and
  list routes (`app/src/routes/broadcasts.ts:293`, `:311`), every fan-out and
  reconcile emit (`broadcastFanOut.ts:230`, used at 13 sites including
  `sendReconcile.ts:940`), finalize (`:1532`, `:1559`), and the webhook emits
  (`twilio.ts:3936`, `:3981`).
- The chip row's invariant is disjoint buckets summing to Recipients
  (`dashboard/src/routes/broadcasts/StatChips.tsx:1-7`, `:30-40`).
- The list replaces a row's stats with each SSE payload
  (`dashboard/src/routes/broadcasts/useBroadcastsList.ts:114-124`); worker-side
  emits never reach app SSE clients in deployed envs
  (`useBroadcastResults.ts:9-16`).

**What it implies.** Disjoint: a one-recipient share whose 30003 lands before
finalize (both orders occur; `e2e/tests/dashboard-next/share-skip-fix.spec.ts:259-264`)
now finalizes `sent` with no `last_error` instead of `failed` - a stored-status
change the spec says does not happen, and one that depends on the clock at
finalize. Overlapping: the chips no longer balance (tests at
`StatChips.test.tsx:32-147` pin it), and a share stored `failed` with "all
recipients failed" reads a "Sending" pill with that alert under it (D4 shows
`last_error` unless the label is Sent, 206-208). Either way every emitter must
pass the server clock or the next SSE overwrites the list row without the
bucket. The spec must pick one and say where the clock enters.

## 5. [MEDIUM] I5 fails on the list page, and withdrawals are silent to the share pages

**What is wrong.** I5 (325-327) promises "shown only while it is live on the
server clock, on every surface that shows it". D4's list label "Sending" for a
finished share is derived from `retry_pending`, a count computed at fetch
time. Only the results page gets a ticker (D3, 178-181).

**Evidence.** The list has no interval and no clock; it refetches on filter
change and patches on `broadcast.updated` only
(`useBroadcastsList.ts:65-74`, `:111-126`). The enqueue-failure withdrawal
emits only `message.persisted` (`twilio.ts:3642-3647`), which neither share
page subscribes to (`useBroadcastResults.ts:121-138`,
`useBroadcastsList.ts:124`).

**What it implies.** A finished share whose promise lapses with no retry
outcome (a job decline) reads "Sending" on the list until a reload; a slot
withdrawal accelerates nothing unless it emits `broadcast.updated`. On the
results page, the header pill either lags the same way (if taken from the
bucket) or needs a client-side second implementation of D4 over the recipients
and the ticker - the spec does not say which. D3's sentence "so a promise that
lapses is not shown until the next refetch" (180-181) also reads as the
opposite of what the ticker is for.

## 6. [MEDIUM] D1 misdescribes `queued`

**What is wrong.** D1 says a `queued` newest attempt means "no text has been
attempted: a seed not yet reached, a deferral, a strand" (128-132) and prices
the change as "the window is the pass itself" (142-145).

**Evidence.**
- An UNKNOWN provider outcome leaves the slot `queued` while the reconcile
  runs (`broadcastFanOut.ts:776-814`, hand-off `:598-614`), for checks at 5 s,
  30 s and 240 s (`sendOutcome.ts:30`) plus any re-drive; the text may have
  gone out (that is what the reconcile is for).
- A deploy-stranded pass leaves ONE recipient mid-send with an `attempting`
  record and a `queued` slot (`docs/issues/send-attempt-sweeper.md:383-394`).
- Today both are flagged "Already sent" while the share is `sending`
  (`broadcastsRepo.ts:716`, `:731`).

**What it implies.** D1 regresses today's safe flag for the "may have arrived"
class it promises to protect (Goal 3, 86-89; D1 123), for minutes, clustered in
outages (the outage brake, `broadcastFanOut.ts:1062-1097`). The decision may
still stand, but it must be taken knowingly and its cost restated.

## 7. [MEDIUM] D2 names a primitive that cannot express its ordering rule

**What is wrong.** D2 allows a move "only when the receipt's attempt is NEWER
than the slot's recorded newest attempt ... or is that same attempt moving
forward" (160-162), "in one conditional write (the atomic slot-plus-stats
primitive SOR added)" (163-166).

**Evidence.**
- `recordRecipientOutcome` conditions only on the slot's status
  (`broadcastsRepo.ts:547-579`, condition `:568`).
- A retry's `sent` and terminal receipts are separate requests whose rollups
  run after independent message transitions (`twilio.ts:3462-3467`,
  `:3520-3545`); `failed` is allowed from `sent`
  (`messagesRepo.ts:138-141`), so both can transition.
- The repo already has an open bug of the other shape: a read-state CAS that
  drops the loser instead of re-reading
  (`docs/issues/group-recipient-delivered-receipt-lost-to-sent-race.md:18-42`).

**What it implies.** With status-only priors `[failed, sent]`, a delayed
`sent` rollup for retry R overwrites R's `failed` (a failed text counted).
With a strict CAS on the state read, R's `delivered` that lost to R's `sent`
is dropped for good ("Sent" forever). D2 must require a condition on the
stored attempt pointer plus the allowed priors, and a consistent re-read and
re-apply on a lost race.

## 8. [MEDIUM] D7's read-modify-write has no conflict rule; slot and ledger drift

**What is wrong.** D7's writers are "each a conditional read-modify-write
keyed on the row's change token" (254-255) and I6 (328-330) promises
order-independence. The spec never says what a writer does when it loses.

**Evidence.**
- The rollup runs once per transition and a throw is caught and logged
  (`twilio.ts:3520-3545`); Twilio's redelivery never re-runs it
  (`:3426-3428`).
- The pass writes the ledger after the token acquire
  (`broadcastFanOut.ts:817-831`), up to ~1 s after the send for all but the
  first recipient; the fake fails a text at ~300 ms (`delivery.ts:18-31`). The
  callback-first order is also the contention case.
- Today's ledger write is best-effort and swallowed
  (`broadcastFanOut.ts:1237-1250`).
- The change token is unnamed; seeded rows lack `updated_at`
  (`app/src/lib/seed/matrix.ts:1263-1284`).

**What it implies.** A rollup that loses the CAS to the pass and does not
re-read leaves `counted` for a failed attempt - I6 fails in the very race it
is written for. A ledger write that throws after the slot write succeeded
leaves slot and ledger disagreeing permanently, and nothing but the one-time
D8 reconciles them. The spec needs "re-read and re-apply, bounded", a named
token, and an accepted-drift statement or a healer.

## 9. [MEDIUM] I1 is contradicted by the spec's own projections

**What is wrong.** I1 (314-317): "every surface reads that one rule". The spec
then defines four different counts:
- composer flag (D1, 116-123): sent, delivered, live promise, Not confirmed;
- ledger (D7, 241-243, 270-272): sent, delivered, live promise - NOT Not confirmed;
- labels (D4, 196-202): Sent = reached or delivered; live promise reads
  "Sending"; Not confirmed its own label;
- "Sent to N" (D5, 218-220): reached or delivered only.

**What it implies.** One recipient with a live promise is simultaneously
"Already sent", listed under "Properties sent", "Sending" on the pill and "No
tenants reached" on the Activity card; a Not confirmed one is flagged but not
listed. The builder cannot test I1 as written. Restate it as one per-recipient
state with a named projection per surface, and test the projections.

## 10. [MEDIUM] Legacy ledger rows lose their pre-existing share on the first new write

**What is wrong.** "absent on a legacy row reads as counted" (D7, 244-246)
holds only until a new writer touches the row. The per-share memory starts
with the new share only; D7 then derives `counted` from the entries and
REMOVES `sentAt` when none counts (247-251).

**Evidence.** Today's row carries only the latest share's attribution, no
history (`app/src/repos/listingSendsRepo.ts:14-19`, `:36-51`). Seed rows are
`via: 'individual'` with no share id (`app/src/lib/seed/cast.ts:672-702`,
`matrix.ts:1271-1284`).

**What it implies.** A legacy pair whose older share was delivered, then one
new share that fails, drops out of "Properties sent" and the tour default. The
repair runs after deploy (a window) and cannot judge `individual` rows; local
and full-seed worlds never get the repair. The first write must seed the memory
from the legacy row's attribution (or treat a missing entry for the row's
`broadcastId` as counted).

## 11. [MEDIUM] The ledger's `unconfirmed` state has no well-defined writer or reader

**What is wrong.** D7 lists "the reconcile's unresolved close marks it
`unconfirmed`" under the WEBHOOK's bullet (258-262); section 5 and the merge
points (374-380) never name `sendReconcile.ts`; D6 gives the state words
("Property sent - not confirmed", 231-233).

**Evidence.**
- The share's unresolved close moves only a `queued` slot, i.e. an attempt
  that never recorded a send (`sendReconcile.ts:936-941`, `:1003-1024`), and
  the milestone is written only after a recorded send or an adopted
  sent/delivered (`broadcastFanOut.ts:817-831`, `:1456-1463`) - so no milestone
  exists for any share attempt that ends unconfirmed.
- Two more `send_unconfirmed` sites live in the fan-out (hand-off enqueue
  failure `broadcastFanOut.ts:561-570`; second unknown `:784-793`).
- An unresolved verdict has no message, so no tsMsgId for D7's
  "newer attempt" rule (265-268).
- A retry's unresolved close is 1b's code, outside I7.

**What it implies.** The builder would add three writers into SOR-owned code
with no attempt id and no reader; "Property sent - not confirmed" can never
render. Either drop the state from the ledger or define its writer, attempt
key and reader.

## 12. [MEDIUM] D6 cannot relabel any existing milestone

**What is wrong.** D6 derives words from "the ledger entry for (property,
tenant, share)" (229-231) and keeps stored words only when "the pair has no
entry" (233-234). No existing milestone carries a share id, D8 (283-295) does
not touch milestones, and D6 has no rule for a milestone WITHOUT a share id
whose pair HAS entries (which is every repaired pair).

**Evidence.** Unit milestones store refType `unit` / refId only
(`broadcastFanOut.ts:1220-1226`); the activity repo has no update and its
input has no share field (`app/src/repos/activityEventsRepo.ts:86-94`,
`:102-110`).

**What it implies.** Every historical "Property sent" - the issue's own
evidence - keeps its words, and a builder must invent a rule for the
share-id-less case. D9's "Closes
`tenant-timeline-property-sent-milestone-after-failed-delivery`" (305-307) and
Goal 4 (90) overstate: state the rule (old milestones keep their words) and
narrow the claim, or have D8 match old milestones by (contact, unit, time).

## 13. [MEDIUM] D3's hint rule silently removes the hint from synchronous failures

**What is wrong.** D3: the hint "appears only when the conversation would
offer Retry" (188-190). A share recipient whose send was rejected at create or
fenced has no message in the thread, so the conversation offers no Retry.

**Evidence.** A provider rejection throws before any append
(`app/src/services/sendMessage.ts:620-625`); today the hint shows on every
failed row with a contactId except `send_unconfirmed`
(`dashboard/src/routes/broadcasts/BroadcastResults.tsx:55-56`); SOR's e2e pins
the hint on a 21211 row as a positive control
(`e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:457-464`); section 7
lists only Branch A's interim rule and SOR's pill as rewrites (404-406).

**What it implies.** Read literally, D3 drops the hint from 21211, create-time
30007/30005/30006, `no_contact`, `transient_cap` and `enqueue_failed` rows and
breaks a pinned e2e; its enumerated "never" cases suggest that was not meant.
Decide, and list the rewrite if it was.

## 14. [MEDIUM] The item-size cap cut is certain, product-visible and not at the gate

**What is wrong.** Section 8 (412-418) defers sizing to the plan and lowers
the recipient cap "if it does not fit". By the repo's own numbers it does not.

**Evidence.** The repo budgets ~200 B per slot, 1500 slots ~300 KB
(`broadcastsRepo.ts:56-68`). With real ids - `contact-<uuid>` 44 chars
(`contactsRepo.ts:1196`), `conv-<uuid>` 41 (`conversationsRepo.ts:1268`),
tsMsgId `<ISO>#<SID>` ~59 (`messagesRepo.ts:202-204`; `messaging.ts:870`) - a
failed 30003 slot with pointers, code and `carrierSentAt` is ~235-240 B. The
two new attributes (a second tsMsgId with its name, ~70 B; an ISO promise with
its name, ~35 B) add ~105 B: ~340 B x 1500 ~ 510 KB; even from 200 B it is ~460
KB, over 400 KB before the rest of the item (which can include up to 1500
`seed_contact_ids`). Estimate only, UNVERIFIED against real items.

**What it implies.** The cap must drop to roughly 1000-1200, changing the
`audience_too_large` refusals (`app/src/routes/broadcasts.ts:680-687`,
`:723-732`), the preview's truncation (`:527`) and pinned tests
(`app/test/broadcastApi.test.ts:994-1003`) - a user-visible limit missing from
section 9. It must hold for mid-pass growth too: an over-limit UpdateItem is a
ValidationException, not a condition failure, so a record-phase write turns a
sent text into `sent_unrecorded` and hands it to a reconcile whose adoption
fails the same write (`broadcastFanOut.ts:975-984`, `:1403-1415`).

## 15. [LOW] I4 is false on day one

I4 (323-324) says every bucket-changing slot write carries its delta in the
same write, while section 5 keeps "the fan-out's arms (unchanged)" (343). The
fence arm (`broadcastFanOut.ts:660-665`), the legacy reject arms (`:698-704`),
the refusal arm (`:997-1003`) and today's rollup (`twilio.ts:3949-3975`) each
write the slot and bump stats separately. Scope I4 to this branch's writers or
convert the rollup's original-attempt path.

## 16. [LOW] "Newest attempt wins" can lose a delivery

The staff route re-retries the same failed SID indefinitely
(`api.ts:1561-1563`, `:1595-1598`), guarded only by the pressed row's promise
(`:1608-1611`). With two overlapping attempts (a stale tab or the API), an
older attempt's `delivered` that lands after a newer attempt's failure is
refused by D2 (160-162), and D7's newer-attempt rule (265-268) can un-count a
share whose earlier attempt delivered - against I2 (318-319). Rare; say "any
delivered attempt counts" or accept it explicitly.

## 17. [LOW] D2's "as it is for an original" misdescribes today

An original's slot becomes `sent` at DISPATCH (`broadcastFanOut.ts:940-947`);
the carrier `sent` callback only stamps `carrierSentAt` on an already-`sent`
slot (`twilio.ts:3915-3940`). For retries the spec makes the callback the
status writer, so a retry never occupies the `sending` bucket and one whose
`sent` callback is lost stays `failed` (counted only through its promise) until
its terminal receipt.

## 18. [LOW] D1's `queued` change breaks unlisted tests

`app/test/broadcastsRepo.integration.test.ts:298-345` pins `queued` slots of
`sent` and `sending` shares as counted - a pre-Branch-A rule that section 7's
rewrite list (404-406) does not cover. `e2e/tests/dashboard-next/broadcasts.spec.ts:124-175`
posts a prior share and previews without waiting; under D1 Tasha is flagged
only once the fan-out moved her slot off `queued` (the in-process queue runs it
at `setTimeout(run, 0)`, `app/src/index.ts:67`), a new timing dependency.

## 19. [LOW] The 1b interim stalls the webhook

Section 0 (40-41) asks 1b only to log the miss at INFO. The rollup sleeps
`statusRetryDelayMs` (2500 ms, `twilio.ts:322`) and re-reads the share before
that line (`:3890-3906`), so between 1b's deploy and this branch's every
share-retry receipt holds the webhook ~2.5 s plus two share reads. Ask 1b to
skip the rollup for rows carrying `retry_of` until this branch lands, or accept.

## 20. [LOW] D8 leaves known-wrong slots and has enumeration caveats

D2 itself names slots left `sent` by a thrown or missed failure rollup
(157-159), but D8 step 3 (289-292) moves only slots "whose newest attempt
differs from the recorded one", so those stay counted after the repair. "The
shares index" misses rows without `_listPartition` until backfilled
(`app/src/lib/tables.ts:368-370`; prod backfill state UNVERIFIED). Phone-keyed
pairs are resolved by the CURRENT phone owner (`broadcastFanOut.ts:1192-1200`),
not the send-time contact the ledger was keyed on.

---

## Claims checked and found to hold

- The rollup's match, forward-only guard and non-atomic bump are as the spec
  says (`twilio.ts:3840-3844`, `:3887-3889`, `:3949-3975`).
- Finalize reads slots once, flips only from `sending`, audits the whole
  audience for `failed` shares too (`broadcastFanOut.ts:1514-1552`).
- The ledger has one runtime writer, no condition and no history
  (`listingSendsRepo.ts:136-178`); both readers and the tour default are as
  listed; no matching or audience reader exists.
- `broadcast_id` on a message row has exactly three runtime readers: the
  rollup gate (`twilio.ts:3529`), `isBroadcastRowFor`
  (`broadcastFanOut.ts:1296-1306`) and `heldBy`'s holder label
  (`sendReconcile.ts:604-610`); the dashboard reads none. Reconcile candidates
  are tried oldest-first (`sendReconcile.ts:860`), so section 8's watch item is
  correctly scoped.
- `listing_sent` has no reader beyond the contact timeline and the seeds; no
  dev seam or script writes slots or the ledger; the messages stream has no
  consumer (only a Terraform output); the `sparse` GSI flag is not emitted to
  Terraform, so I9's documented contract change needs no infra change.
- The fake arms a delivery outcome per NEXT message
  (`e2e/fixtures/fakeTwilio.ts:349-373`), so section 7's "30003, then the retry
  delivers" e2e is buildable with existing seams.
