# Counted as sent: retries, the ledger and property-send labels - design (Branch B)

Date: 2026-09-25 (stub); rewritten 2026-09-27 against `main` @d9cb5c04 (Branch A,
`feat/retry-send-window` and `feat/send-outcome-reconcile` Stage 1 merged).
Status: DESIGN v5 - v1 (6e99330d), v2 (82bdd304), v3 (1951d190) and v4
(dc480dcc) revised after adversarial review rounds 1-4 (`spec-review-r1-a.md`,
`spec-review-r1-b.md`, `spec-review-r2.md`, `spec-review-r3.md`,
`spec-review-r4.md`; adjudications `spec-review-r<n>-adjudications.md`).
Written against Stage 1b's FINAL spec (revision 5 @dad3fecb). Round 4 was
the cap: its precision findings are folded here; its two remaining design
calls were RULED by Cameron on 2026-09-27 (section 9): the list refetch reads
a stats-only query flag on the existing per-share route; no relay to SOR.
GATE PASSED 2026-09-27. Stage 1b MERGED 2026-09-28 (main @3f38bcc2, synced
into this branch at cebc7d23, no dependency change); section 0 restated
against the code and 1b's section 8 errata as built (21 items). PLAN IN
PROGRESS.
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
  links each attempt to the previous one, not to the root. A promise can lapse
  even after its retry went out (a late job, a late receipt); the retry's own
  row is then the truth.
- SOR Stage 1 is merged: every share send and relay send claims a per-recipient
  send-attempt record; an ambiguous outcome is reconciled against the provider
  and ends adopted, re-sent, or `send_unconfirmed` ("Not confirmed"). The record
  holds only the latest attempt, records no delivery, and expires after 30
  days; nothing durable about "counted" can live on it.
- **SOR Stage 1b (the `retrySend` adoption) is being built now and must merge
  before this branch is PLANNED or BUILT.** Its spec is FINAL: revision 5
  @dad3fecb on `feat/retry-send-adoption`
  (`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`, whose
  section 8 "Errata as built", 21 items, is part of the interface). 1b
  MERGED on 2026-09-28 (main @3f38bcc2). This spec takes 1b's interface AS
  BUILT and asks nothing more of it; the plan's first task verifies the code
  against these four facts:
  1. Every retry row 1b appends - automatic, adopted, and the staff Retry
     route's row - carries `retry_root` (the retried row's own root if it has
     one; else, for a pre-deploy retry row, the row reached by following
     `retry_of` up to a HOP cap - `RETRY_ROOT_WALK_MAX_HOPS`, 16 as built, not
     the attempt cap - a broken link stopping at the last row read; else the
     retried row itself) and `broadcast_id` COPIED
     ONE HOP from the retried row. The one-hop copy has a hole this branch
     closes itself: a post-1b retry of an unstamped pre-1b retry row carries
     no `broadcast_id`, so its receipt never enters the rollup. The repair
     (D8) stamps every such row and re-applies its outcome; the window
     between 1b's deploy and the repair is the residual, and it is small - an
     automatic chain completes inside the 15-minute window, so only chains in
     flight at the deploy and a staff Retry of an old, childless, failed
     retry row fall in it.
  2. When 1b WITHDRAWS a retried row's promise because the chain ended with
     no retry row and an unresolved ruling - the reconcile's unresolved close
     and its redelivery re-apply, the job's second-unknown arm and its
     enqueue-failed-after-handoff arm - it writes `retry_outcome:
     'unconfirmed'` on that row together with the withdrawn sentinel in
     `retry_due_at` - and that row CAN be a share's own root row (1b erratum
     13: a one-tenant share text whose attempt-1 retry went unresolved), which
     is exactly the row D1 reads as the newest attempt. This branch reads that
     field (D1) and calls its own slot writer at those sites (D2). A WITHDRAW
     that is lost or throws at the job's arms is re-applied by nothing (1b
     erratum 9) - the case D1's bound and D8's record read cover. A chain end
     that leaves
     the promise to EXPIRE (refused, rejected, the window closed at job time,
     the deferral cap) needs nothing more: the lapse is the signal, on RSW's
     own clock.
  3. 1b writes nothing to a share slot. The job's two arms have NO re-apply
     to ride: they close the record first and WITHDRAW second, a redelivered
     job returns at INFO on a `done` record, and every post-claim write is
     guarded so nothing throws. This branch does not ask for one: at those
     two arms its slot write goes FIRST (D2), and the repair reads the
     retry-owner attempt records while they live (D8).
  4. r5's `retrychild#` pointer family and its "any child supersedes" rule (a
     Retry pressed on a row that already has a child, from a stale view or a
     direct call, is refused) confine the overlapping-attempt case to 1b's
     named two-child fork and to pre-1b chains, which carry no pointers.
  Until this branch lands, the status webhook SKIPS the broadcast rollup for
  a row that carries `retry_of` (1b's one fenced line, main @3f38bcc2, on
  Cameron's 2026-09-28 decision: no wait, no share reads for a share-retry
  receipt) and the give-up line stays at WARN. This branch opens the fence,
  removes that skip and routes retry rows itself (D2); after it, a miss for a
  row WITHOUT `retry_root` (an original whose slot cannot be found - the
  lost-rollup class) stays WARN, and a miss for a retry row is a routing bug
  and logs at ERROR. 1b also made `isBroadcastRowFor` (the fan-out's and the
  reconcile's "is this the recipient's own row" check) ignore rows with
  `retry_of` at both of its callers (erratum 15), which is the "not a retry
  row" clause section 8 asked for.
- This branch then adds, after 1b, the slot and ledger writes for a later
  attempt at every place a later attempt's outcome becomes known: the status
  webhook's rollup (a retry row's receipt), the reconcile's adoption of a
  retry (no receipt ever transitions an adopted row), and the four
  unresolved-end sites named above (no receipt exists). The webhook is fenced
  for SOR Stage 1 and opened here; the other sites are the retry-owner paths
  1b creates, which this branch extends with a call into its own slot writer:
  at the reconcile's close the call rides 1b's own re-apply; at the job's two
  arms, which have none, the call goes before 1b's record close. 1b's record,
  claim and close semantics are untouched.
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

- One per-recipient STATE, derived from the slot plus the newest attempt's own
  message row, that every surface reads - with exactly two readings of it: a
  safe reading for the composer flag ("may have reached the tenant") and a
  strict reading for everything else ("reached the tenant").
- A retry's outcome reaches its share by every path an outcome can arrive: a
  receipt, an adoption, an unresolved close, or a chain end recorded on the
  retried row.
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
  behavior; they write no ledger row today and none after; the repair does not
  walk them, so a pre-1b retry chain under one stays unattributed for good
  (its share label keeps the first failure, as today).

## 3. Decisions

### D1. The recipient state, and the two readings of it

A recipient's state is derived from their slot and, when the slot's newest
attempt failed 30003, from that attempt's own message row. Besides what the
slot holds today (status, code, the carrier-confirmed instant, the original
send's message pointer), it gains ONE attribute: the newest attempt's message
id, absent while the newest attempt is the original. The retry promise and the
chain's end are NOT copied onto the slot: they are read from the newest
attempt's row, where RSW and 1b write, refresh and withdraw them, so the share
can never disagree with the tenant's thread or the Retry guard.

The states:

- **reached** - the newest attempt was delivered, or accepted by the carrier
  (slot `sent`, confirmed or not);
- **pending** - the newest attempt failed 30003 and its row's promise is live;
- **unconfirmed** - "Not confirmed": the slot says `send_unconfirmed`, or the
  newest attempt's row says its chain ended `unresolved` (the text may have
  arrived either way);
- **in flight** - slot `queued` in a share still `sending` (not yet reached
  by the pass, deferred, under reconcile); or `queued` in a share no longer
  `sending` when the recipient's send-attempt record exists and does not say
  the text never went (a pass stranded mid-attempt; a route enqueue the route
  called failed whose pass ran anyway) - the text may be out;
- **stranded** - `queued` in a share no longer `sending` with NO send-attempt
  record, or with a record whose stored shape says the text never went (`done`
  with `refused`, `rejected`, `enqueue_failed` or `redrive_refused`; every
  other shape - any open state, `redriven`, or `done` with `sent`, `adopted`,
  `unresolved` or `retryable` - reads in flight, the safe side): never texted
  - a route enqueue that truly failed, a draft;
- **failed** - failed with no live promise and no unresolved ruling: a
  carrier rejection; a chain that ended without a retry row - refused,
  rejected, the window closed, the deferral cap (the promise lapses) or the
  webhook's enqueue failure (the promise is withdrawn) - or a lapsed promise
  with no outcome at all; or a text that never existed (`no_contact`,
  `transient_cap`, `enqueue_failed`);
- **skipped** - Branch A's rule, unchanged.

The SAFE reading ("Already sent" on the review list): reached, pending,
unconfirmed, in flight. The STRICT reading (the labels, the counts, the
ledger, the milestone): reached only. Failed, skipped and stranded count for
neither.

The share's stored lifecycle status is never read to decide whether a tenant
got the property. This replaces Branch A's interim rule ("failed keeps
counting") and its whole-share exclusions, and closes
`unconfirmed-share-invites-resend`.

In flight is told from stranded by the send-attempt record, never by the
share's stored status: the route marks a share failed on ANY enqueue throw
and the fan-out never reads that mark, so a share stored `failed` may have
texted everyone (records exist) or nobody (no record: never claimed, never
sent - the sweeper's own rule). Without the record, a route send that truly
failed would keep its whole audience flagged for good, and the share staff
create to recover would start every tenant unchecked. One keyed record read
per `queued` slot of a non-`sending` share - strands only, so rare; the
in-memory test double mirrors it. The read is bounded by the record's own
30-day life: a queued slot in a share older than that (the share's own
timestamp) reads stranded without a read, which is right for the flag's
purpose. A record read that fails reads in flight (the safe side) and is
logged; it never empties the set. Two prices remain: a `sending` share whose
pass died keeps its unreached recipients flagged until SOR's sweeper closes
it - the price Branch A already pays, named as the sweeper's population; and
a share the route marked failed whose pass is still RUNNING has recipients
not yet claimed, so with no record yet they read stranded until the pass
reaches them - a window the length of the pass, in the double-text hint
class (section 8).

The row reads are bounded in time: only a failed-30003 slot whose newest
attempt is younger than the LONGEST a promise can be live, measured from that
attempt's own provider timestamp (the message id's prefix), is read, for its
promise and its `retry_outcome`. That bound is a derived constant, not a
figure: the retry window, plus 1b's unknown-outcome refresh (the reconcile's
last check delay plus the promise grace), plus the promise's own liveness
grace, plus a one-minute margin for the skew between the provider's
second-granular timestamp and the server clock - today 15 + 4 + 2 + 2 + 1 =
24 minutes. An older slot is judged from the slot alone, which by then is
authoritative: every unresolved end has a slot writer (D2), so an old failed
slot without `send_unconfirmed` is a final failure. Two residues, both the
repair's (D8): a guarded slot write that was dropped at one of the job's arms
(the record still says `unresolved`), and a retry receipt whose rollup was
lost (section 8). A read that fails leaves the recipient PENDING for the flag
(the safe direction) and is logged; it never empties the set.

### D2. A later attempt reaches its slot: one attempt-ordered transition

Every retry row carries `broadcast_id` and `retry_root` (Stage 1b; this
branch's repair for rows written before it). A later attempt's outcome is
matched to its slot by the share id plus `retry_root` against the slot's
original message pointer, and applied through ONE new slot transition - the
only writer that may leave `failed`. It is a new primitive, not SOR's
status-only conditional write: its condition names the attempt the slot
currently records, so it can order attempts, and it carries the stats delta
in the same write.

Attempt order is the message id's order (provider time). An attempt that has
no row (the reconcile's unresolved close of a retry that was never appended)
is ordered immediately after the attempt it retried.

The rule:

- FROM `failed` (any code) or `sent`; never from `delivered` or `skipped`;
  never TO `queued`.
- A NEWER attempt always applies: it replaces status, code, carrier instant
  and the newest-attempt pointer.
- The SAME attempt applies only forward, in the message machine's own order
  (accepted -> confirmed -> delivered; accepted -> failed); a late `sent` for
  an attempt already `failed` or `delivered` is refused, so a delayed callback
  can never regress an attempt.
- An OLDER attempt never applies (its receipt arrived after a newer attempt
  was recorded) - with ONE exception: a DELIVERED receipt applies whatever
  its attempt's age, because a delivery is the strongest fact about a
  recipient and is never erased (I2); the slot then records the delivered
  attempt as its newest, and a delivered slot is terminal, so the pointer's
  ordering role ends there. 1b r5 refuses a Retry on any row that already
  has a child, so this covers only what remains open: 1b's named two-child
  fork and pre-1b chains (a staff Retry pressed from a stale view after the
  promise lapsed while the automatic retry's delivery receipt is in flight).
  The delivery lands, and the other attempt's later receipts are refused
  from `delivered`.
- A LOST condition re-reads the slot (consistently) and re-applies under the
  same rule, up to a small bound; a write still refused is logged at WARN
  with the ids. The loser of a race is never simply dropped: a retry's
  `failed` that loses to its own `sent` confirmation re-applies and wins on
  the second pass.

The callers, all in this branch: the status webhook's rollup (a retry row's
transitioning receipt: confirmed-sent, delivered, failed); the reconcile's
adoption of a retry (the adopted row's provider status, as the share adoption
maps it today - a receipt that outruns the adoption's append is dropped at
the webhook, so the hook is the only sure way the attempt reaches the slot;
a receipt that lands after the append transitions the row and reaches the
rollup like any retry row, and the same-attempt-forward rule reconciles the
two; the hook is placed BEFORE the reconcile closes the record, so a crash
leaves the record open and the redelivered check re-finds the row through its
own child pointer and re-runs the hook as a de-duplicated re-adoption - after
the close nothing re-applies an `adopted` outcome); and the four unresolved-end sites
of section 0 (the slot becomes `failed` / `send_unconfirmed`, the row-less
attempt ordered after the one it retried) - at the reconcile's close the
write rides 1b's own re-apply; at the job's two arms, which have none, it
goes FIRST, before 1b closes the record, and the ledger's `unconfirmed`
entry (D7) goes with it: `send_unconfirmed` is the safe state, a crash after
it leaves a record the redelivery or the sweeper resolves, and any later
real outcome (an adoption, a re-drive's own row) supersedes it under the
order rule. At the enqueue arm one window stays: a crash between 1b's
hand-off (the record turns `reconciling`) and this branch's write leaves a
`reconciling` record with no chain that no redelivery revisits; D8 reads
those too (step 3). A retry's mere acceptance is not
written by anyone (the retry job writes no slots); the slot learns a retry
from the carrier's `sent` confirmation or its terminal receipt, whichever
comes first.

### D3. The results row, the promise and the hint

The row shows the newest attempt's outcome from the slot. For a failed 30003
row young enough to have a promise (D1's bound), the results route reads the
newest attempt's message row and returns its `retry_due_at` and
`retry_outcome` with the row, so the page can judge liveness itself: it shows
"will retry" (RSW's copy) while the promise is live on the server clock and
re-judges it on a one-minute ticker (the conversation page's precedent), so a
promise that lapses is not shown until the next fetch.

The "open conversation to retry" hint appears only when the conversation would
offer Retry for this recipient: the slot's newest attempt has a message row
(a synchronous rejection, a fence, a cap or an enqueue failure has nothing to
retry), it is failed with no live promise, and it is neither "Not confirmed"
nor ended unresolved. This removes the hint from rows that show it today for
a text that never existed; the SOR end-to-end that pins the hint on a 21211
row is rewritten. One window stays (RSW's gap, named in section 8): between a
promise lapsing and the retry's first receipt, the row can show a hint for a
text the thread already shows as retried.

### D4. Share labels derive from recipients

For a finished share (stored `sent` or `failed`), the label derives from its
slots, first match wins:

- **Sent** - at least one recipient reached.
- **Sending** (progress tone) - none reached, at least one pending.
- **Not confirmed** - none reached, none pending, at least one unconfirmed.
- **Not sent** - everything else (failed, skipped, in flight only): danger
  tone when any recipient failed, neutral when every one was skipped (Branch
  A's case). A share the route marked failed with every slot still `queued`
  reads Not sent, danger.

Draft and Sending shares keep their stored labels. The stored `last_error`
shows under Not sent only. The status filter tabs and the stored status are
unchanged; "Failed" retires as a pill.

Pending needs a derived count. `deriveBroadcastStats` gains `retry_pending`,
a SUB-bucket of `failed`: `failed` keeps every failed slot (so finalize, the
persisted counters and the balance are unchanged), and `retry_pending` says
how many of them hold a live promise. It is derived from a promise map the
caller supplies, and it is OPTIONAL in the stats shape:

- the results and list routes build the full map from D1's bounded reads and
  return the count;
- the rollup that has just written a 30003 failure with a live promise
  supplies its own entry and emits the count as a lower bound (at least this
  recipient) on the `broadcast.updated` it emits, so the list and results
  pages read Sending from the very event that starts the retry;
- every other emitter (the fan-out, the reconcile, the other rollup arms,
  including the arm that ends a chain with a final failure) leaves the count
  UNSET - nothing has to learn to omit anything, an optional field stays
  unset whenever no promise map is supplied;
- a page merging a payload whose stats omit the count: when the row's last
  known count is zero, keeps zero; when it is above zero AND the share is
  finished (stored `sent` or `failed` - a Sending or Draft share keeps its
  stored label and needs no count, and a pass in progress emits an event a
  second), keeps it only until a debounced refetch of THAT share's STATS
  replaces it - a stats-only read of the per-share route (the share and its
  derived stats, without the recipient list and its contact reads that the
  results page needs; a query flag on the existing route, Cameron's ruling
  of 2026-09-27) - so a chain that
  ends in a failure receipt (exhaustion, a retry's 30007), which shrinks
  nothing in `failed`, still turns the row from Sending to Not sent within
  the debounce; a payload that carries the count replaces it outright. The
  volume is the receipts of finished shares with retries: a few a day.

Both hooks change from replacing the row's stats wholesale to this merge.
The chips show Failed minus pending and a Retrying chip for pending, so the
row still balances. The results page already refetches after any event and
re-judges liveness on its ticker. What remains stale on the list: a promise
that lapses with NO event at all (no receipt, no chain end - the job never
ran) reads Sending until the page is reopened. Accepted: the list is a
summary, and the results page ticks.

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
from that share's entry on the (property, tenant) row - `counted` reads
"Property sent"; `unconfirmed` reads "Property sent - not confirmed"; `failed`
reads "Property text failed"; `pending` is judged the way D1 judges pending -
the entry names its attempt, so within D1's bound the timeline reads that
attempt's row (its live promise, refreshed wherever 1b refreshes it, and its
`retry_outcome`): "Property sent" while the promise is live, "Property sent -
not confirmed" when the row says unresolved, "Property text failed" once the
promise has lapsed or the bound has passed with no later entry write (a
pending entry that never hears a retry outcome is a failure by RSW's own
clock). The ledger keeps no copy of the promise; the row is its one source
(I5). For a milestone written before this branch (no share id), from
the row's pair-level `counted` - "Property sent" when the pair still counts,
"Property text failed" when it does not. One ledger read per (property,
tenant) pair on the page, batched. A milestone whose pair has no row keeps its
stored words. This closes
`tenant-timeline-property-sent-milestone-after-failed-delivery` for every
milestone, with the pair-level approximation for the old ones.

### D7. The ledger follows the rule

The listing-send row (one per property-tenant pair) gains:

- per-share memory: for each share of the pair, the attempt it currently
  records (its order key - the message id, which D6 follows to the row for a
  `pending` entry), that attempt's ledger state - `counted`, `pending`,
  `unconfirmed`, or `failed` - whether a `counted` entry was counted by a
  DELIVERY (terminal) or by acceptance, and the instant the entry last
  counted; no copy of the promise;
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
pair again the moment it reaches). The ledger holds no time-bound fact that
counts: a `pending` entry's due instant is read only by D6's words.

Writers, each a conditional read-modify-write keyed on the row's change token
(`updated_at`), re-read and re-applied on a lost condition up to a small bound,
and logged at ERROR with the pair's ids when the bound is exhausted:

- the share pass at carrier acceptance (today's write): entry `counted` by
  acceptance for the original attempt;
- the reconcile's share adoption (today: only an adopted sent/delivered;
  a delivered adoption is `counted` by delivery);
- the webhook's rollup for the original attempt (new): delivered -> `counted`
  by delivery; failed 30003 with a live promise -> `pending` with its due;
  failed without -> `failed`;
- the D2 callers for a later attempt (new): reached -> `counted` (by delivery
  when delivered) with the new attempt; failed 30003 with a live promise ->
  `pending`; failed without -> `failed`; an unresolved end (any of the four
  sites) -> `unconfirmed`, as the row-less attempt ordered after the one it
  retried;
- the repair (once).

The share's own unresolved close of an ORIGINAL attempt writes nothing here:
no milestone was written for a text that was never accepted, and the pair
never counted from it.

Order-independence and the legacy row:

- Entries are ordered by attempt, in D2's order (message ids; a row-less
  attempt right after the one it retried; a seeded entry before every real
  attempt). An entry write applies when its attempt is NEWER than the stored
  one, or is the SAME attempt moving forward, where forward means: `counted`
  by acceptance may become `counted` by delivery, `pending` or `failed`;
  `pending` may become `failed` (the repair, for a lapsed promise whose chain
  ended without a retry row); nothing moves back. Mirroring D2, an OLDER
  attempt's DELIVERY applies too: the entry becomes `counted` by delivery for
  that attempt. An entry `counted` by delivery is TERMINAL for that share: no
  write, newer attempt or not, moves it (a delivery is never erased, I2). A
  writer that finds no entry CREATES
  it - so when a failure callback lands before the pass's acceptance write
  (the common order: the pass writes after the token wait), the callback's
  `failed` entry is there first and the pass's later `counted` write for the
  same attempt is refused.
- The first write to a legacy row seeds its memory from the row itself: the
  share its `broadcastId` names becomes a `counted` entry at its `sentAt`,
  ordered before every real attempt of that share (a row with no share id - a
  seeded individual send - seeds one `counted` entry keyed `individual`), so
  an older counted share survives a newer share's failure.
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

1. Walks every unit-targeted share (both share indexes, since shares created
   before the list index was backfilled are absent from it), every
   non-skipped slot, and for each: reads the original message, then the
   conversation's rows newer than it, and rebuilds the recipient's attempt
   chain by lineage (each retry names the attempt it retried; the walk follows
   every chain back to this original).
2. Stamps `broadcast_id` and `retry_root` on every retry row of such a chain
   that lacks them - written before Stage 1b, or written after it from an
   unstamped ancestor - and CORRECTS a `retry_root` that disagrees with the
   chain it rebuilt (1b's walk stops at its hop cap or at a broken link, so a
   post-1b row can carry a wrong root, which once stamped would route to no
   slot). This is what lets a chain that started before the deploy keep
   routing after it.
3. Applies D2's transition to slots whose newest attempt differs from the
   recorded one, to slots whose recorded attempt disagrees with its own
   message row (a slot stuck `sent` after a lost failure rollup; a retry
   whose receipt rollup was lost), and to failed-30003 slots whose chain
   ended unresolved while the slot never learned it - read from the newest
   attempt's row (`retry_outcome`) AND from the retry-owner attempt records
   (`retry#<conversation>#<retried row>#<attempt>`, read by key while they
   live, 30 days: a `done` / `unresolved` record is the trace a dropped
   guarded write leaves, and a `reconciling` record older than the
   reconcile's schedule with no chain row is the trace of the enqueue arm's
   first crash window - both read as unresolved) - under D2's conditions,
   never touching a delivered or skipped slot, never moving a slot an attempt
   newer than the census has touched.
4. Rebuilds each ledger row's per-share memory, `counted`, `sentAt` and
   `broadcastId` from the slots and the rows, under the row's change token,
   never erasing an entry written after the census; and fills a row the
   pass's swallowed write never created, for a reached recipient.

It reports, per environment: shares and slots walked, retry rows stamped,
slots moved, pairs un-counted and re-counted, rows created, and rows it could
not judge (a pre-RSW retry whose lineage was never written; an original
message missing) - those slots and rows are left as they are. A unit-less
share created before the list index was backfilled is in neither index and
is not walked: it has no ledger row, and its milestone keeps today's words
(section 2). Sizes are unknown until the census runs; every read is a keyed
query except the ledger enumeration, a scan of a small table.

### D9. Issues this branch closes or files

Closes: `broadcast-30003-retry-never-updates-slot`,
`unconfirmed-share-invites-resend`,
`tenant-timeline-property-sent-milestone-after-failed-delivery`. Amends
`send-attempt-sweeper` (the in-flight recipients D1 keeps flagging in a
stranded share are the sweeper's population). Files anything the review or
the build finds out of scope.

## 4. Invariants

- I1. One per-recipient state (D1), derived from the slot and the newest
  attempt's own row, is what every surface reads; the composer flag takes its
  safe reading, every other surface its strict reading, and no surface reads
  the share's stored status to decide whether a tenant got the property.
- I2. A recorded delivery is never erased: no writer moves a `delivered` slot,
  and a ledger entry counted by a delivery is terminal for that share - a
  later attempt for the same recipient and share (a staff Retry pressed from a
  stale view after the promise lapsed) can neither move the slot nor un-count
  the entry.
- I3. A `failed` slot moves only through a NEWER attempt (D2) or the repair
  (D8), under a condition naming the attempt it read, with a lost condition
  re-applied rather than dropped; a `skipped` slot never moves; nothing writes
  a slot back to `queued`.
- I4. Every slot write THIS BRANCH adds carries its stats delta in the same
  conditional write; displays keep deriving from the map. (The pre-existing
  blind writers are SOR's filed residue, not widened here.)
- I5. A retry's promise and a chain's end have one source, the newest
  attempt's message row; the results row and the composer flag read them
  there, and the results page re-judges the promise on the clock. A list row
  may lag by one event (D4).
- I6. The ledger counts no time-bound fact: only reached attempts count; a
  pending retry counts nowhere in the ledger until it reaches.
- I7. Stage 1b writes nothing to a share slot; this branch changes nothing in
  the retry job's record, claim or close SEMANTICS - it only calls its own
  slot writer from the retry adoption and the four unresolved-end sites, after
  1b has merged, placing that call before the record close at the job's two
  arms. The interface between them is the three fields on message rows
  (`broadcast_id` and `retry_root` on every retry row, `retry_outcome` on a
  retried row whose promise 1b withdrew) and, read-only, the retry-owner
  attempt records (D1's in-flight rule reads a recipient's record; D8 reads
  the retry records).
- I8. Production is written only by the deployed code paths and the
  Cameron-run repair on his explicit go; no infrastructure, index or
  dependency changes.
- I9. No new slot status, share status, table or GSI; the ledger's index
  becomes sparse by attribute absence, documented as a contract change to
  that GSI's meaning.

## 5. Surfaces (writers and readers the plan must cover)

- Slot state. Writers: the fan-out's arms (unchanged), the reconcile's share
  closes (unchanged), the rollup (D2 for retry rows; the D7 write for original
  failures), the retry adoption and the four unresolved-end sites (D2 + D7),
  the repair. Readers: the composer flag (the repo query and the
  in-memory test double, which must mirror the two readings and the promise
  reads and the record reads), the results route and row, the derived stats
  and the `retry_pending` sub-bucket, the SSE payload (the rollup's emit
  supplies its promise), the results route's stats-only read (D4's refetch:
  `GET /api/broadcasts/:id/results` with a query flag that skips the
  recipient list and its contact reads), finalize (unchanged), the two "Sent
  to N" surfaces (D5), the in-memory harness double
  (`app/test/helpers/twilioWebhookHarness.ts`, which mirrors the repo).
- The promise and the chain end: written by RSW and 1b on message rows
  (unchanged); read by the results route and the preview route (D1, D3),
  through the newest-attempt pointer, within D1's bound.
- Retry rows: written by 1b (the automatic retry, the adoption, the staff
  route); read by the rollup (D2) and the repair (D8).
- The ledger row: writers in D7; readers - the tenant "Properties sent" API
  and card, the property "Sent to tenants" API and card, the tour form's
  default property, the milestone words (D6), the seed history generator (one
  "Property sent" per ledger row - it must skip an un-counted pair), the
  repair; the in-memory ledger double must mirror the sparse index and the
  per-share memory, held to the real repo by a parity test.
- The milestone: writer unchanged in timing, now carrying the share id (the
  activity-event record input gains the field); reader - the contact timeline
  route, where the words are composed APP-side (as is D5's landlord label);
  the dashboard renders them verbatim. D5 and D6 both need a batch read that
  does not exist today (shares by id; ledger rows by pair) plus their harness
  doubles.
- The `broadcast_sent` audit row: unchanged; its two readers derive (D5).
- Seeds: the lean world is byte-stable and has no ledger rows; the full world's
  five ledger rows read as counted (absent flag). No seed change is required;
  a seeded un-counted pair is added only if an e2e needs it.
- Dashboard copy touched: the share labels and the Retrying chip (D4), the
  results-row hint (D3), the two "Sent to N" labels (D5), the milestone words
  (D6). None is catalog copy.

## 6. Sequencing and rollout

1. This spec: adversarial review (four rounds, closed), then Cameron's gate
   (passed 2026-09-27). Stage 1b merged 2026-09-28 with its errata as built;
   nothing was relayed to it - the plan's first task verifies the code
   against section 0's four facts.
2. After 1b merged: the plan (against the record and the retry job as built),
   plan review, the mission block, the build in this worktree with one main
   sync at the end, the planner's review, Cameron's merge.
3. After deploy: the D8 census, then the apply, dev then prod, each on
   Cameron's go, before the next blast. Nothing infra-side.
4. Merge points for anyone landing beside this branch: the rollup in the
   status webhook (fenced for SOR Stage 1; opened here for D2 and D7), the
   retry adoption and the four unresolved-end sites (1b's), the per-share
   route (its stats-only read), the ledger
   repo and its two routes, the contact timeline's milestone mapping, the
   fan-out's `recordPropertySent`, `deriveBroadcastStats` and the dashboard's
   stats types (the `retry_pending` sub-bucket and the promise map), the
   `broadcast.updated` payload, `presentShareLabel` and `shareRecipientReason`,
   the harness doubles.

## 7. Testing and acceptance

- Hermetic tests for every decision, including: D1's state table - a live
  promise, a lapsed one (a fake clock, since a lapse takes RSW's two-minute
  grace and cannot be watched end to end), a withdrawn one, a row whose
  `retry_outcome` says unresolved, an old slot judged without a read, a
  failed read landing on the safe side, and the in-flight rule (queued in a
  sending share; queued in a failed share with a live record; queued with no
  record or a never-sent record = stranded); D2's transition - every refusal
  (delivered, skipped, an older attempt, a same-attempt regression such as a
  late `sent` after `failed`), every allowed move including an older
  attempt's DELIVERED receipt, the slot-first order at the job's arms (a
  later adoption supersedes the unconfirmed slot), a lost condition
  re-applied, and a row-less unresolved retry ordered after its retried
  attempt, each with its stats delta, through all three callers; the D3
  promise read and the hint rule for every failed-row kind; the D4 label table,
  the chip balance with `retry_pending`, a `broadcast.updated` carrying the
  rollup's own promise, and the merge in both hooks (an omitted count on a
  pending row triggers the row refetch; on a zero row nothing); the D7 write
  rule under both orders (pass then callback, callback then pass) for one
  attempt, across attempts, an older attempt's delivery counting, a
  delivery-counted entry refusing a later attempt, a legacy row (the seeded
  entry survives), and a lost condition (the bounded re-read); the sparse
  index behavior of an un-counted pair and its return; the D5 recount with a
  missing share; the D6 words for every state including a `pending` entry
  read from a live, a refreshed, a withdrawn and a lapsed row, and a milestone
  without a share id; the D8 script's dry run writes nothing, its apply is
  idempotent, it refuses the wrong account, it stamps a chain with an
  unstamped ancestor, and it heals a slot from a `done` / `unresolved` retry
  record.
- End to end on the hermetic lane, with the fake carrier's fail profile and the
  lane's ten-second retry backoff: (a) a one-to-one share whose first text
  fails 30003 and whose retry delivers ends with the results row Delivered,
  the share Sent, the tenant flagged "Already sent", "Properties sent" listing
  the property, and the results row reading "will retry" in between; (b) a
  share whose text fails 30003 and whose retry also fails, exhausting the
  chain, ends with the row Failed, the share "Not sent" on the results page
  AND on the list (the row refetch), the tenant NOT flagged, the property gone
  from "Properties sent", the milestone reading "Property text failed", and
  "will retry" gone once the chain ends; (c) a
  share whose text fails 30007 ends with the row Failed (its hint shown: the
  text has a row and no promise), the share "Not sent", the tenant NOT
  flagged, the property Activity entry reading "No tenants reached"; (d) a
  "Not confirmed" share (SOR's e2e path) flags the tenant, reads "Not
  confirmed", and is not listed under "Properties sent".
- Tests that pin today's behavior and are rewritten to this rule, named so
  the builder does not mistake them for regressions: Branch A's interim-rule
  pins (`share-skip-fix.spec.ts` failed-stays-flagged; the repo and route
  tests for `priorRecipientContactIds`: the queued-in-a-sending-share case is
  kept, the DRAFT exclusion holds as a stranded case, the FAILED-share
  exclusion becomes slot-and-record cases - a failed share's record-less
  queued slots stay unflagged, its reached slots now flag - and the two
  "a failed one still does / still is" cases flip to "a final failure does
  not"); 1b's webhook pin that the rollup SKIPS a `retry_of` row (rewritten:
  the row is routed); the results-row hint pin on a keyless failed row (no
  message row, so no hint); SOR's all-unconfirmed "Failed" pill, its
  `last_error` alert (shown under Not sent only) and its 21211 retry-hint pin
  (`send-outcome-reconcile.spec.ts`); the "Sent to N tenants" label tests;
  the label-table test that reads sent + skipped + failed as "Sent".
- The `broadcasts.spec.ts` "Already sent" assertion made right after a prior
  send holds under D1 (in flight counts), and is kept.
- All five completion gates.
- Handback reports the D8 census numbers per environment once Cameron has run
  it, and every issue closed or filed.

## 8. Risks and accepted tradeoffs

- **Slot size.** The share item holds every slot; the repo budgets about 200
  bytes per slot at a 1500-recipient cap, near 300 KB of the 400 KB item
  limit. This branch adds one attribute per RETRIED slot (a message id, about
  60-90 bytes with its name). A share in which every recipient was retried
  would exceed the limit only near the cap; the write that crosses it throws
  mid-pass rather than failing a condition. Decision for the gate (section
  9): lower the recipient cap to 1000. A legacy share stored near the old cap
  that later gains many retried slots is a named residual: the D2 write
  fails, is logged, and the slot keeps its recorded failure.
- **Read cost.** D3's promise reads (only young 30003 rows), D5 and D6's
  relabels (bounded by the page, batched, on the hottest route only after the
  slice). Accepted.
- **A retry row stamped with the share id** looked, to SOR's reconcile
  ownership check, like the recipient's own message. RESOLVED by 1b as built:
  `isBroadcastRowFor` ignores rows with `retry_of` at both callers (1b
  erratum 15). The plan's first task verifies it; no clause is added here.
- **Pre-RSW rows** may lack lineage; the repair reports what it cannot judge
  and leaves those slots and rows as they are. Accepted (the stub's residual).
- **The double-text window** during a retry's backoff (a second share of the
  same property before the retry runs) stays: the tenant is flagged (pending
  is a safe reading), but the flag is a hint, not a block. Accepted, as in
  the pre-split v5. The same class: a share the route marked failed whose
  pass is still running leaves its unclaimed recipients unflagged for the
  length of the pass (D1) - a second share in that window can double-text
  them. Accepted (a double text is at most HIGH by the standing severity
  rule, and the flag is a hint).
- **A lapsed promise before the retry's first receipt** (RSW's gap): for that
  interval the results row reads a final failure and shows the hint while the
  thread shows the retry. Bounded by receipt latency; the next receipt or the
  chain end corrects it. Accepted.
- **A dropped slot write at one of the job's two arms.** The write goes
  first, so a crash after it costs nothing; a write that FAILS is logged and
  dropped by 1b's post-claim guard while the record still closes
  `unresolved`, and nothing redelivers. The slot keeps its 30003 failure;
  within D1's bound the row read gives the right state, past it the slot reads
  failed until the repair is re-run and reads the record. Accepted as the
  repair's residue.
- **A lost retry rollup.** The status webhook catches a rollup throw and
  still answers 200, so the carrier never redelivers; if D2's re-read bound is
  exhausted too, the retry's row exists but the slot never learns it, and past
  D1's bound the recipient reads a final failure although the retry delivered
  - the retry-side twin of the original's stuck-`sent` class. Healed only by a
  re-run of the repair. Accepted, and named.
- **1b's two-child fork.** Where an automatic and a manual retry of one row
  race (1b's named residual, two texts may go out), a row-less unresolved end
  of the automatic chain sorts before every row of the manual chain, so a
  later failure of the manual chain reads the recipient failed although the
  automatic retry may have arrived. Rare on rare; accepted with 1b's residual.
- **Strands keep their in-flight recipients flagged** until the sweeper
  (D1). Accepted; the sweeper issue names them.
- **The ledger's index becomes sparse.** A pair with no counted share leaves
  "Properties sent" entirely (not greyed) and returns when a share counts;
  during a retry's backoff the pair is absent. Accepted; the milestone keeps
  the history.
- **A lost ledger race past the retry bound** is logged and healed by a
  re-run of the repair, not by a live healer. Accepted.
- **Stage 1b drift.** r5 is final, but the build is not; the plan's first
  task verifies 1b as built against section 0's four facts (the two row
  fields at every append site - the retry job, the route, the adoption - the
  `retry_outcome` at every WITHDRAW, the record-first order at the job's
  arms, the child pointers) and, on a mismatch, corrects it before anything
  else. Nothing here depends on 1b's record shape beyond reading the retry
  records by key.

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
- Nothing REQUIRED of SOR: Stage 1b's spec is final (r5) and this spec is
  written against it. The walk request in the earlier relay is WITHDRAWN -
  r5 already walks pre-deploy chains for `retry_root`, and the one-hop
  `broadcast_id` copy is closed by this branch's own repair.
- Round 4's two remaining calls, RULED by Cameron 2026-09-27:
  1. D4's list refetch reads a share's stats WITHOUT its recipient list,
     through a QUERY FLAG on the existing results route
     (`GET /api/broadcasts/:id/results`; the same handler minus the recipient
     enrichment and its contact reads; no new endpoint). The
     alternatives (a new stats endpoint; no refetch, leaving a finished share
     whose retry chain failed reading Sending until reopened) are not taken.
  2. NO relay to SOR for the one-expression root `broadcast_id` change. A
     post-1b retry of an unstamped pre-1b retry row keeps today's behavior
     (its receipt bypasses the share) until the repair (D8) runs; 1b's loop
     stays closed.
