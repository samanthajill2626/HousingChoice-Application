# Counted as sent: retries, the ledger and property-send labels - design (Branch B)

Date: 2026-09-25 (stub); rewritten 2026-09-27 against `main` @d9cb5c04 (Branch A,
`feat/retry-send-window` and `feat/send-outcome-reconcile` Stage 1 merged).
Status: DESIGN v2 - v1 (commit 6e99330d) revised after adversarial review
round 1 (`spec-review-r1-a.md`, `spec-review-r1-b.md`, adjudications in
`spec-review-r1-adjudications.md`); ready for round 2 and the human gate.
Branch `feat/share-sent-outcome`, worktree `W:\tmp\share-sent-outcome`.
Records: `docs/superpowers/reviews/2026-09-27-share-sent-outcome/` (the three
research findings this rewrite rests on: `research-broadcast-side-findings.md`,
`research-retry-lineage-findings.md`, `research-ledger-surfaces-findings.md`;
the pre-split rounds are under `docs/superpowers/reviews/2026-09-24-share-skip-fix/`).

Vocabulary: this document says "share" for a property send (one `broadcast`
row), "recipient" for one tenant slot in it, and "attempt" for one text sent
for that recipient - the original send, an automatic 30003 retry, or a staff
Retry. These are spec words only; staff copy says "property send", "Properties
sent", "Sent to N tenants" (GLOSSARY: `unit` in code, "property" to staff).

## 0. Sequencing and what this branch waits for

- Branch A (share-skip-fix) is merged: staff shares are a person's send, skipped
  recipients carry reasons and never count as "Already sent", an all-skipped
  share reads "Not sent".
- RSW is merged: a one-to-one 30003 retry is never sent more than 15 minutes
  after the original; a failed one-to-one message promises a retry only while
  its `retry_due_at` is live (RSW's rule: the due instant plus two minutes,
  judged on the server clock); lineage (`retry_of`, `retry_attempt`,
  `retry_window_start`, `automated`, `recipient_contact_id`) is written when
  the retry row is appended. `retry_of` names the attempt retried, so a chain
  links each attempt to the previous one, not to the root.
- SOR Stage 1 is merged: every share send and relay send claims a per-recipient
  send-attempt record; an ambiguous outcome is reconciled against the provider
  and ends adopted, re-sent, or `send_unconfirmed` ("Not confirmed"). The record
  holds only the latest attempt, records no delivery, and expires after 30
  days; nothing durable about "counted" can live on it.
- **SOR Stage 1b (the `retrySend` adoption) is being built now and must merge
  before this branch is PLANNED or BUILT.** This spec is written and reviewed in
  parallel with it. What this branch requires of 1b, agreed 2026-09-27: every
  retry row 1b appends - automatic, adopted, and the staff Retry route's row -
  carries `broadcast_id` (copied from the previous attempt's row) and
  `retry_root` (the tsMsgId of the ORIGINAL send: the previous row's
  `retry_root` if it has one, else the previous row's own tsMsgId); a retry the
  reconcile rules `unresolved` withdraws the retried row's promise; 1b writes
  nothing to a share slot. Until this branch lands, a share retry's receipt is
  logged at INFO and touches nothing (the rollup's one 2.5-second re-read on a
  slot miss is paid for those receipts in the interim - a few per day at most,
  since only share texts that failed 30003 have retries; accepted).
- This branch then adds, after 1b, the slot and ledger writes for a later
  attempt at THREE places: the status webhook's rollup (a retry's receipt), the
  reconcile's adoption of a retry (no receipt ever transitions an adopted row),
  and the reconcile's unresolved close of a retry (no receipt exists at all).
  The first is the webhook, fenced for SOR Stage 1 and opened here; the other
  two are the retry-owner paths 1b creates in the reconcile, which this branch
  extends with a call into its own slot writer. 1b's own record, claim and
  closes are untouched.
- After this branch: nothing waits on it.

## 1. Problem

Sam's improvements #5 and #4 are half fixed by Branch A. What remains is that
a property send tells three different stories about whether a tenant got the
property, and none of them follows what actually happened after the first text:

1. **The composer's "Already sent" flag** counts a recipient whose text FAILED
   (Branch A's interim rule, kept on purpose because a 30003 might have been
   delivered by the automatic retry), and reads the share's stored status,
   which is decided once at finalize: a one-recipient share whose only text
   fails after finalize is stored `sent` and its tenant stays flagged; one
   whose failure raced ahead is stored `failed` and its tenant is not flagged.
   A share whose texts all ended "Not confirmed" is stored `failed`, so a tenant
   who may well have received the text is offered pre-checked on the next send
   (`unconfirmed-share-invites-resend`).
2. **A retry never reaches the share.** The automatic 30003 retry and the staff
   Retry send a new message with no share attribution; the webhook rolls a
   receipt into a share only when the message row carries `broadcast_id`, and
   it finds the slot by the ORIGINAL send's message id; a `failed` slot refuses
   every later move. So the share row keeps its first failure forever, whatever
   the retry did, while the tenant's own thread shows the retry delivered
   (`broadcast-30003-retry-never-updates-slot`). The share row's 30003 reads a
   plain failure with no retry promise, and offers "open conversation to
   retry" while the conversation itself hides Retry.
3. **The "sent" records are written at carrier acceptance and never
   retracted.** The tenant's "Property sent" milestone and the listing-send
   ledger row (which orders "Properties sent" and picks the tour form's
   default property) are written right after the provider accepts the first
   text, whether or not it is ever delivered
   (`tenant-timeline-property-sent-milestone-after-failed-delivery`). The
   property Activity card and the landlord timeline say "Sent to N tenants"
   where N is every recipient slot, skipped and failed included, written even
   for a share that reached nobody.

## 2. Goals and non-goals

Goals:

- One per-recipient STATE, recorded on the slot from the newest attempt, that
  every surface reads - with exactly two readings of it: a safe reading for
  the composer flag ("may have reached the tenant") and a strict reading for
  everything else ("reached the tenant").
- A retry's outcome reaches its share by every path an outcome can arrive: a
  receipt, an adoption, an unresolved close.
- A failed recipient whose failure is final stops counting everywhere; a
  recipient whose text may have arrived (a live retry promise, "Not
  confirmed") keeps the safe flag and is never offered pre-checked.
- A Cameron-run, dry-run-first repair brings existing rows in line.

Non-goals (out of scope, with their owners):

- The retry job's own record, claim and closes (SOR Stage 1b).
- The 30003 wording and the retry window (RSW); this branch reads RSW's
  promise where RSW keeps it, it does not copy or restate it.
- The stranded-attempt sweeper (SOR D14, `send-attempt-sweeper`).
- Any new broadcast status, table, GSI or Terraform change. No new slot status.
- A matching or audience reader of the ledger (none exists; the stub's
  "matching reads it at scale" is not in code - the direct-lookup shape is
  kept as a constraint, not built for).
- Unit-less shares (a share with no property): their milestone keeps today's
  behavior; they write no ledger row today and none after.

## 3. Decisions

### D1. The recipient state, and the two readings of it

A recipient's state is the state of the NEWEST attempt for them in this share,
as recorded on their slot. Besides what the slot holds today (status, code,
the carrier-confirmed instant, the original send's message pointer), it gains
ONE attribute: the newest attempt's message id, absent while the newest
attempt is the original. The retry promise is NOT copied onto the slot: it is
read from the newest attempt's message row, where RSW writes, refreshes and
withdraws it, so the share can never disagree with the tenant's thread or the
Retry guard.

The states, from the newest attempt:

- **reached** - delivered, or accepted by the carrier (slot `sent`, confirmed
  or not);
- **pending** - failed 30003 with a LIVE retry promise on that attempt's row;
- **unconfirmed** - "Not confirmed" (`send_unconfirmed`): the text may have
  arrived;
- **in flight** - slot `queued` while the share is still `sending`: not yet
  reached by the pass, deferred, or under reconcile (the text may be out);
- **failed** - failed with no live promise: a carrier rejection, an exhausted
  or closed chain, a withdrawn promise, or a text that never existed
  (`no_contact`, `transient_cap`, `enqueue_failed`);
- **skipped** - Branch A's rule, unchanged;
- **stranded** - slot `queued` in a share that is no longer `sending` (the
  route marked it failed) - never texted.

The SAFE reading ("Already sent" on the review list): reached, pending,
unconfirmed, in flight. The STRICT reading (the labels, the counts, the
ledger, the milestone): reached only. Failed, skipped and stranded count for
neither.

The share's stored lifecycle status is read for one thing only, to tell in
flight from stranded; it never decides whether a tenant got the property. This
replaces Branch A's interim rule ("failed keeps counting") and its whole-share
exclusions, and closes `unconfirmed-share-invites-resend`.

In flight counts for the flag because the alternative flags nothing during a
long pass and un-flags a reconciling send whose text may be out; the price is
that a strand (a pass that died mid-share, the share stuck `sending`) keeps
its untexted recipients flagged until SOR's sweeper closes it - the same price
Branch A pays today, named as the sweeper's population.

### D2. A later attempt reaches its slot: one attempt-ordered transition

Every retry row carries `broadcast_id` and `retry_root` (Stage 1b; this
branch's repair for rows written before it). A later attempt's outcome is
matched to its slot by the share id plus `retry_root` against the slot's
original message pointer, and applied through ONE new slot transition - the
only writer that may leave `failed`. It is a new primitive, not SOR's
status-only conditional write: its condition names the attempt the slot
currently records, so it can order attempts, and it carries the stats delta
in the same write.

The rule:

- FROM `failed` (any code) or `sent`; never from `delivered` or `skipped`;
  never TO `queued`.
- A NEWER attempt (a larger message id - message ids order by provider time)
  always applies: it replaces status, code, carrier instant and the
  newest-attempt pointer.
- The SAME attempt applies only forward, in the message machine's own order
  (accepted -> confirmed -> delivered; accepted -> failed); a late `sent` for
  an attempt already `failed` or `delivered` is refused, so a delayed callback
  can never regress an attempt.
- An OLDER attempt never applies (its receipt arrived after a newer attempt
  was recorded).

Three callers, all in this branch: the status webhook's rollup (a retry row's
transitioning receipt: confirmed-sent, delivered, failed); the reconcile's
adoption of a retry (the adopted row's provider status, as the share adoption
maps it today - an adopted row produces no receipt, so this is the only way it
reaches the slot); the reconcile's unresolved close of a retry (the slot
becomes `failed` / `send_unconfirmed`, state unconfirmed - there is no receipt
and no row). A retry's mere acceptance is not written by anyone (the retry
job writes no slots); the slot learns a retry from the carrier's `sent`
confirmation or its terminal receipt, whichever comes first.

### D3. The results row, the promise and the hint

The row shows the newest attempt's outcome from the slot. For a failed 30003
row the results route reads the newest attempt's message row (one read per
such row, batched by conversation; only 30003 rows pay) and reports whether
its promise is live - RSW's rule, on the server clock. The dashboard shows
"will retry" while it is live and re-judges it on a one-minute ticker (the
conversation page's precedent), so a promise that lapses is not shown until
the next fetch.

The "open conversation to retry" hint appears only when the conversation would
offer Retry for this recipient: the slot's newest attempt has a message row
(a synchronous rejection, a fence, a cap or an enqueue failure has nothing to
retry), it is `failed` with no live promise, and it is not "Not confirmed".
This removes the hint from rows that show it today for a text that never
existed; the SOR end-to-end that pins the hint on a 21211 row is rewritten.

### D4. Share labels derive from recipients

For a finished share (stored `sent` or `failed`), the label derives from its
slots, first match wins:

- **Sent** - at least one recipient reached.
- **Sending** (progress tone) - none reached, at least one pending.
- **Not confirmed** - none reached, none pending, at least one unconfirmed.
- **Not sent** - everything else (failed, skipped and stranded only): danger
  tone when any recipient failed, neutral when every one was skipped (Branch
  A's case). A share the route marked failed with every slot still `queued`
  reads Not sent, danger.

Draft and Sending shares keep their stored labels. The stored `last_error`
shows under Not sent and Not confirmed only. The status filter tabs and the
stored status are unchanged; "Failed" retires as a pill.

Pending needs a derived count. `deriveBroadcastStats` gains `retry_pending`,
a SUB-bucket of `failed`: `failed` keeps every failed slot (so finalize, the
persisted counters and the balance are unchanged), and `retry_pending` says
how many of them hold a live promise. It is derived on the server at read
time from the promise reads D3 makes (only the results and list routes pay;
every other caller of the derivation gets zero). The chips show Failed minus
pending and a Retrying chip for pending, so the row still balances. The list
row is re-judged only when it refetches (a `broadcast.updated` from the
retry's receipt, or a visit); a lapsed promise can leave a list row reading
Sending for up to the grace plus the backoff after its due instant, which is
accepted - the results page ticks, and the list is a summary.

### D5. "Sent to N tenants" recounts and relabels at read time

The property Activity entry and the landlord-timeline milestone keep the
audit row finalize writes (append-only, never rewritten) but derive their
words from the share at read time: N = recipients reached; "Sent to N tenants"
when N > 0, "No tenants reached" when N = 0 (linking to the share either way,
whose page explains why). Cost: one projected batch read of the shares on the
page (at most the page size); on the landlord timeline the recount runs after
the merge and slice, so it costs at most one page of reads, never 25 units'
worth. A share that no longer exists falls back to the stored count with the
stored words.

### D6. The tenant "Property sent" milestone follows the ledger

The milestone stays written at carrier acceptance (it is a timeline fact:
"we sent it to you then"), but it now records its share id, and its words
derive at read time from the ledger: for a milestone that carries a share id,
from that share's entry on the (property, tenant) row - reached reads
"Property sent", unconfirmed reads "Property sent - not confirmed", failed
reads "Property text failed", pending reads "Property sent" (the safe reading
for a timeline fact that is being retried); for a milestone written before
this branch (no share id), from the row's pair-level `counted` - "Property
sent" when the pair still counts, "Property text failed" when it does not.
One ledger read per (property, tenant) pair on the page, batched. A milestone
whose pair has no row keeps its stored words. This closes
`tenant-timeline-property-sent-milestone-after-failed-delivery` for every
milestone, with the pair-level approximation for the old ones.

### D7. The ledger follows the rule

The listing-send row (one per property-tenant pair) gains:

- per-share memory: for each share of the pair, the attempt it currently
  records (message id) and that attempt's ledger state - `counted` (reached:
  accepted or delivered), `pending`, `unconfirmed`, or `failed` - and the
  instant the entry last counted;
- `counted` for the pair: true when any share entry is `counted`. On a legacy
  row (no memory yet) the flag is absent and reads as counted, so no backfill
  is needed to keep today's rows listed;
- `sentAt` and `broadcastId` describe the latest COUNTED share. When no share
  entry counts, `counted` is false and `sentAt` is REMOVED, so the "Properties
  sent" index (a GSI keyed on `sentAt`) drops the pair on its own - the
  codebase's sparse-by-absence convention - and the tour form's default
  property moves to the newest pair that still counts. The property page's
  "Sent to tenants" list filters `counted` explicitly (it reads the base table).

Only `counted` entries count; `pending` and `unconfirmed` do not ("Properties
sent" lists texts we believe reached the tenant; a pending retry lists the
pair again the moment it reaches). This is what keeps the ledger free of any
time-bound fact: a promise that lapses with no outcome leaves the entry
`pending`, which never counted.

Writers, each a conditional read-modify-write keyed on the row's change token
(`updated_at`), re-read and re-applied on a lost condition up to a small bound,
and logged at ERROR with the pair's ids when the bound is exhausted:

- the share pass at carrier acceptance (today's write): entry `counted` for
  the original attempt;
- the reconcile's share adoption (today: only an adopted sent/delivered);
- the D2 callers for a later attempt (new): reached -> `counted` with the new
  attempt; failed with a live promise -> `pending`; failed without ->
  `failed`; unresolved -> `unconfirmed`;
- the share's own unresolved closes for the ORIGINAL attempt (new; the three
  sites that write `send_unconfirmed` for a share recipient) -> `unconfirmed`;
- the webhook's failure rollup for the original attempt (new): failed with a
  live promise -> `pending`, without -> `failed`;
- the repair (once).

Order-independence and the legacy row:

- An entry write applies only when its attempt is newer than the stored one,
  or is the same attempt moving forward (`counted` -> `pending` / `failed` /
  `unconfirmed`; never back to `counted` for the same attempt). A writer that
  finds no entry CREATES it - so when a failure callback lands before the
  pass's acceptance write (the common order: the pass writes after the token
  wait), the callback's `failed` entry is there first and the pass's later
  `counted` write for the same attempt is refused.
- The first write to a legacy row seeds its memory from the row itself: the
  share its `broadcastId` names becomes a `counted` entry at its `sentAt`
  (a row with no share id - a seeded individual send - seeds one `counted`
  entry keyed `individual`), so an older counted share survives a newer
  share's failure.
- The pair's contact is the contact the share resolved when it was sent
  (today's key: the slot's key when it is a contact id, else the contact that
  held the number at send time); a later writer derives it the same way and
  writes the same row. A number that has since moved to another contact is a
  named residual: the entry lands on the send-time contact's row.

Drift between slot and ledger has one healer beyond the writers' own retries:
the repair (D8) can be re-run, idempotently, on Cameron's go.

### D8. The repair - a Cameron-run, dry-run-first pass over history

One script in the shape of Branch A's operator scripts (the shared stage
resolver: `--env local|dev|prod`, `--lane` for a hermetic lane, dry run by
default, `--apply`, the account guard on the `housingchoice` profile, every
write conditional, counts and ids only in logs), run once per environment on
Cameron's go right after this branch deploys and before the next blast, and
re-runnable. Its census, then its apply:

1. Walks every share (both share indexes, since shares created before the
   list index was backfilled are absent from it), every non-skipped slot, and
   for each: reads the original message, then the conversation's rows newer
   than it, and rebuilds the recipient's attempt chain by lineage (each retry
   names the attempt it retried; the walk follows every chain back to this
   original).
2. Stamps `broadcast_id` and `retry_root` on retry rows written before Stage
   1b. This is what lets a chain that started before the deploy keep routing
   after it: 1b copies the attribution from the previous attempt's row, so an
   unstamped ancestor would leave every later retry unattributed.
3. Applies D2's transition to slots whose newest attempt differs from the
   recorded one, and to slots whose recorded attempt disagrees with its own
   message row (a slot stuck `sent` after a lost failure rollup), under D2's
   conditions - never touching a delivered or skipped slot, never moving a
   slot an attempt newer than the census has touched.
4. Rebuilds each ledger row's per-share memory, `counted`, `sentAt` and
   `broadcastId` from the slots, under the row's change token, never erasing
   an entry written after the census; and fills a row the pass's swallowed
   write never created, for a reached recipient.

It reports, per environment: shares and slots walked, retry rows stamped,
slots moved, pairs un-counted and re-counted, rows created, and rows it could
not judge (a pre-RSW retry whose lineage was never written; an original
message missing) - those slots and rows are left as they are. Sizes are
unknown until the census runs; every read is a keyed query except the ledger
enumeration, a scan of a small table.

### D9. Issues this branch closes or files

Closes: `broadcast-30003-retry-never-updates-slot`,
`unconfirmed-share-invites-resend`,
`tenant-timeline-property-sent-milestone-after-failed-delivery`. Amends
`send-attempt-sweeper` (the in-flight recipients D1 keeps flagging in a
stranded share are the sweeper's population). Files anything the review or
the build finds out of scope.

## 4. Invariants

- I1. One per-recipient state (D1), recorded on the slot from the newest
  attempt, is what every surface reads; the composer flag takes its safe
  reading, every other surface its strict reading, and no surface reads the
  share's stored status to decide whether a tenant got the property.
- I2. A recorded delivery is never erased: no writer moves a `delivered` slot,
  and a ledger entry counted by a delivered attempt stays counted for that
  share (a later attempt for the same recipient and share cannot exist after a
  delivery - a retry follows only a failure).
- I3. A `failed` slot moves only through a NEWER attempt (D2) or the repair
  (D8), under a condition naming the attempt it read; a `skipped` slot never
  moves; nothing writes a slot back to `queued`.
- I4. Every slot write THIS BRANCH adds carries its stats delta in the same
  conditional write; displays keep deriving from the map. (The pre-existing
  blind writers are SOR's filed residue, not widened here.)
- I5. A retry's promise has one source, the newest attempt's message row; the
  results row and the composer flag read it there, and the results page
  re-judges it on the clock. A list row may lag it by one refetch (D4).
- I6. The ledger records no time-bound fact: only reached attempts count; a
  pending retry counts nowhere in the ledger until it reaches.
- I7. Stage 1b writes nothing to a share slot; this branch writes nothing to
  the retry job's record, claim or closes. The interface between them is the
  two attribution fields on the retry row and the two reconcile paths this
  branch extends with its own slot writer.
- I8. Production is written only by the deployed code paths and the
  Cameron-run repair on his explicit go; no infrastructure, index or
  dependency changes.
- I9. No new slot status, share status, table or GSI; the ledger's index
  becomes sparse by attribute absence, documented as a contract change to
  that GSI's meaning.

## 5. Surfaces (writers and readers the plan must cover)

- Slot state. Writers: the fan-out's arms (unchanged), the reconcile's share
  closes (unchanged in what they write to the slot; they gain the D7 ledger
  write), the rollup (D2 for retry rows; the D7 write for original failures),
  the reconcile's retry adoption and retry unresolved close (D2 + D7), the
  repair. Readers: the composer flag (the repo query and the in-memory test
  double, which must mirror the two readings), the results route and row, the
  derived stats and the `retry_pending` sub-bucket, the SSE payload, finalize
  (unchanged), the two "Sent to N" surfaces (D5), the fake-twilio harness.
- The promise: written by RSW and 1b on message rows (unchanged); read by the
  results route and the preview route (D1's pending, D3), through the
  newest-attempt pointer.
- Retry rows: written by 1b (the automatic retry, the adoption, the staff
  route); read by the rollup (D2) and the repair (D8).
- The ledger row: writers in D7; readers - the tenant "Properties sent" API
  and card, the property "Sent to tenants" API and card, the tour form's
  default property, the milestone words (D6), the seed history generator (one
  "Property sent" per ledger row - it must skip an un-counted pair), the
  repair; the in-memory ledger double must mirror the sparse index and the
  per-share memory, held to the real repo by a parity test.
- The milestone: writer unchanged in timing, now carrying the share id;
  reader - the contact timeline (D6).
- The `broadcast_sent` audit row: unchanged; its two readers derive (D5).
- Seeds: the lean world is byte-stable and has no ledger rows; the full world's
  five ledger rows read as counted (absent flag). No seed change is required;
  a seeded un-counted pair is added only if an e2e needs it.
- Dashboard copy touched: the share labels and the Retrying chip (D4), the
  results-row hint (D3), the two "Sent to N" labels (D5), the milestone words
  (D6). None is catalog copy.

## 6. Sequencing and rollout

1. This spec: adversarial review, then Cameron's gate. In parallel: SOR Stage
   1b.
2. After 1b merges: the plan (against the record and the retry job as built),
   plan review, the mission block, the build in this worktree with one main
   sync at the end, the planner's review, Cameron's merge.
3. After deploy: the D8 census, then the apply, dev then prod, each on
   Cameron's go, before the next blast. Nothing infra-side.
4. Merge points for anyone landing beside this branch: the rollup in the
   status webhook (fenced for SOR Stage 1; opened here for D2 and D7), the
   reconcile's retry-owner adoption and unresolved close (1b's), the ledger
   repo and its two routes, the contact timeline's milestone mapping, the
   fan-out's `recordPropertySent` and its share unresolved closes,
   `deriveBroadcastStats` and the dashboard's stats types (the `retry_pending`
   sub-bucket), `presentShareLabel` and `shareRecipientReason`, the harness
   doubles.

## 7. Testing and acceptance

- Hermetic tests for every decision, including: D2's transition - every
  refusal (delivered, skipped, an older attempt, a same-attempt regression
  such as a late `sent` after `failed`) and every allowed move, each with its
  stats delta, through all three callers; the D3 promise read and the hint
  rule for every failed-row kind; the D7 write rule under both orders (pass
  then callback, callback then pass) for one attempt, across attempts, on a
  legacy row (the seeded entry survives), and under a lost condition (the
  bounded re-read); the sparse index behavior of an un-counted pair and its
  return; the D4 label table and the chip balance with `retry_pending`; the
  D5 recount with a missing share; the D6 words for all four states and for a
  milestone without a share id; the D8 script's dry run writes nothing, its
  apply is idempotent, it refuses the wrong account, and it stamps a pre-1b
  chain.
- End to end on the hermetic lane, with the fake carrier's fail profile and the
  lane's ten-second retry backoff: a one-to-one share whose first text fails
  30003 and whose retry delivers ends with the results row Delivered, the
  share Sent, the tenant flagged "Already sent", "Properties sent" listing the
  property; the results row reads "will retry" while the promise is live and
  drops it when it lapses; a share whose text fails 30007 ends with the row
  Failed (its hint shown: the text has a row and no promise, so the
  conversation offers Retry), the share "Not sent", the tenant NOT flagged, the
  property gone from "Properties sent" and the milestone reading "Property
  text failed", the property Activity entry reading "No tenants reached"; a
  "Not confirmed" share (SOR's e2e path)
  flags the tenant, reads "Not confirmed", and is not listed under "Properties
  sent".
- Tests that pin today's behavior and are rewritten to this rule, named so
  the builder does not mistake them for regressions: Branch A's interim-rule
  pins (`share-skip-fix.spec.ts` failed-stays-flagged; the repo and route
  tests for `priorRecipientContactIds`, including the one that pins queued
  slots of a sent share as counted); SOR's all-unconfirmed "Failed" pill and
  its 21211 retry-hint pin (`send-outcome-reconcile.spec.ts`); the
  "Sent to N tenants" label tests; the label-table test that reads
  sent + skipped + failed as "Sent".
- The `broadcasts.spec.ts` "Already sent" assertion made right after a prior
  send holds under D1 (in flight counts), and is kept.
- All five completion gates.
- Handback reports the D8 census numbers per environment once Cameron has run
  it, and every issue closed or filed.

## 8. Risks and accepted tradeoffs

- **Slot size.** The share item holds every slot; the repo budgets about 200
  bytes per slot at a 1500-recipient cap, near 300 KB of the 400 KB item
  limit. This branch adds one attribute per RETRIED slot (a message id, about
  60-90 bytes with its name). With the promise kept off the slot, a share in
  which every recipient was retried would exceed the limit only near the cap;
  the write that crosses it throws mid-pass rather than failing a condition.
  Decision for the gate (section 9): lower the recipient cap to 1000. A
  legacy share stored near the old cap that later gains many retried slots is
  a named residual: the D2 write fails, is logged, and the slot keeps its
  recorded failure.
- **Read cost.** D3's promise reads (only 30003 rows), D5 and D6's relabels
  (bounded by the page, batched, on the hottest route only after the slice).
  Accepted.
- **A retry row stamped with the share id** looks, to SOR's reconcile
  ownership check, like the recipient's own message. It matters only when a
  share attempt is in the reconcile's lookup while its original row exists and
  the retry falls in that window; candidates are tried oldest-first, so the
  original is adopted first. Named as a watch item for the plan; the reconcile
  check gains a "not a retry row" clause if the plan finds a real path.
- **Pre-RSW rows** may lack lineage; the repair reports what it cannot judge
  and leaves those slots and rows as they are. Accepted (the stub's residual).
- **The double-text window** during a retry's backoff (a second share of the
  same property before the retry runs) stays: the tenant is flagged (pending
  is a safe reading), but the flag is a hint, not a block. Accepted, as in v5.
- **Strands keep their in-flight recipients flagged** until the sweeper
  (D1). Accepted; the sweeper issue names them.
- **The ledger's index becomes sparse.** A pair with no counted share leaves
  "Properties sent" entirely (not greyed) and returns when a share counts;
  during a retry's backoff the pair is absent. Accepted; the milestone keeps
  the history.
- **A lost ledger race past the retry bound** is logged and healed by a
  re-run of the repair, not by a live healer. Accepted.
- **Stage 1b drift.** If 1b lands without the two row fields, the plan's first
  task adds them at every append site (the retry job, the route, the
  adoption) before anything else; nothing here depends on 1b's record shape.

## 9. For Cameron at the spec gate

- D1: the review list keeps flagging a tenant whose text is in flight,
  pending a retry, or "Not confirmed"; it stops flagging a tenant whose text
  finally failed (this is the change from Branch A's interim rule).
- D4: a finished share's pill can read Sending while a retry is pending, Not
  confirmed, or Not sent; "Failed" retires as a pill (the tab stays); a
  Retrying chip joins the row.
- D5/D6: "No tenants reached", "Property text failed" and "Property sent - not
  confirmed" are new staff words.
- D7: a pair drops out of "Properties sent" when no share of it reached the
  tenant - including during a retry's backoff - and the tour form's default
  property moves with it.
- D8: one more Cameron-run script, once per environment, after deploy.
- Slot size: lower the property-send recipient cap from 1500 to 1000 (a
  1000-recipient blast already takes about 17 minutes at the pacing). Say no
  and the plan sizes the worst case instead, with the over-limit write as a
  logged failure.
