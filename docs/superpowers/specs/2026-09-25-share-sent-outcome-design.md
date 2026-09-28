# Counted as sent: retries, the ledger and property-send labels - design (Branch B)

Date: 2026-09-25 (stub); rewritten 2026-09-27 against `main` @d9cb5c04 (Branch A,
`feat/retry-send-window` and `feat/send-outcome-reconcile` Stage 1 merged).
Status: DESIGN v1 - the stub's decisions re-taken against the code as built,
ready for adversarial review and the human gate. Branch `feat/share-sent-outcome`,
worktree `W:\tmp\share-sent-outcome`. Records:
`docs/superpowers/reviews/2026-09-27-share-sent-outcome/` (the three research
findings this rewrite rests on: `research-broadcast-side-findings.md`,
`research-retry-lineage-findings.md`, `research-ledger-surfaces-findings.md`; the
pre-split rounds are under `docs/superpowers/reviews/2026-09-24-share-skip-fix/`).

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
  its `retry_due_at` is live; lineage (`retry_of`, `retry_attempt`,
  `retry_window_start`, `automated`, `recipient_contact_id`) is written when
  the retry row is appended.
- SOR Stage 1 is merged: every share send and relay send claims a per-recipient
  send-attempt record; an ambiguous outcome is reconciled against the provider
  and ends adopted, re-sent, or `send_unconfirmed` ("Not confirmed").
- **SOR Stage 1b (the `retrySend` adoption) is being built now and must merge
  before this branch is PLANNED or BUILT.** This spec is written and reviewed in
  parallel with it. What this branch requires of 1b, agreed 2026-09-27: every
  retry row 1b appends - automatic, adopted, and the staff Retry route's row -
  carries `broadcast_id` (copied from the previous attempt's row) and
  `retry_root` (the tsMsgId of the ORIGINAL send: the previous row's
  `retry_root` if it has one, else the previous row's own tsMsgId); a retry the
  reconcile rules `unresolved` withdraws the original's promise; the webhook's
  "retry receipt, no matching recipient slot" case logs at INFO until this
  branch lands. 1b writes nothing to a share slot.
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

- One rule, per recipient, for "counted as sent", that follows every attempt
  for that recipient and ignores the share's stored status.
- A retry's outcome reaches its share: the results row, the counts, the label,
  the composer flag, the ledger and the tenant milestone all follow it.
- A failed recipient whose failure is final stops counting everywhere; a
  recipient whose text may have arrived (a live retry promise, "Not
  confirmed") keeps the safe flag on the review list and is never offered
  pre-checked.
- A Cameron-run, dry-run-first repair brings existing rows in line.

Non-goals (out of scope, with their owners):

- The retry job's own record, claim and reconcile (SOR Stage 1b).
- The 30003 wording and the retry window (RSW); this branch reads RSW's
  promise, it does not restate it.
- The stranded-attempt sweeper (SOR D14, `send-attempt-sweeper`).
- Any new broadcast status, table, GSI or Terraform change. No new slot status.
- A matching or audience reader of the ledger (none exists; the stub's
  "matching reads it at scale" is not in code - the direct-lookup shape is
  kept as a constraint, not built for).
- Unit-less shares (a share with no property): their milestone keeps today's
  behavior; they write no ledger row today and none after.

## 3. Decisions

### D1. The counted-as-sent rule, per recipient

A recipient's state is the state of the NEWEST attempt for them in this share,
as recorded on their slot. The slot records: the original send's message
pointer (its identity for matching receipts), the newest attempt's message
pointer (absent when the newest attempt is the original), the newest attempt's
status and code, the carrier-confirmed instant, and, on a 30003 failure, the
retry promise (`retry_due_at`, the same instant RSW writes on the message row).

A recipient COUNTS as sent when the newest attempt:

- was delivered; or
- was accepted by the carrier (slot `sent`, whether or not the carrier has
  confirmed it yet); or
- failed with a LIVE retry promise (a retry is on its way; liveness is RSW's
  rule, `retry_due_at` plus two minutes, on the server clock); or
- ended "Not confirmed" (`send_unconfirmed`): the text may have arrived.

A recipient does NOT count when the newest attempt:

- was skipped (Branch A's rule, unchanged); or
- is still `queued` (no text has been attempted: a seed not yet reached, a
  deferral, a strand); or
- failed with no live promise - the carrier rejected it, the chain is
  exhausted, the retry window closed, the promise was withdrawn, or the text
  never existed (`no_contact`, `transient_cap`, `enqueue_failed`).

The share's stored lifecycle status plays no part. This replaces Branch A's
interim rule ("failed keeps counting") and the all-failed / all-unconfirmed
share exclusions, and closes `unconfirmed-share-invites-resend`.

Why `queued` no longer counts (it did under Branch A while the share was
`sending`): a queued slot is also a recipient stranded by a mid-share crash or
deploy, and the flag has no clock, so those tenants stayed "Already sent"
forever. The cost is a short window during a long blast in which a second
send of the same property would not flag the recipients the first has not
reached yet; a blast paces at about one text a second, so the window is the
pass itself, and sending the same property twice inside one pass is the
operator's call. The stranded case is closed for good by SOR's sweeper.

### D2. A retry's outcome reaches its slot (the one new slot transition)

Every retry row carries `broadcast_id` and `retry_root` (Stage 1b, and this
branch's repair for rows written before it). The status webhook's rollup
matches a retry row to its slot by the share id plus the root pointer against
the slot's original message pointer, exactly as it matches an original today.

The slot then moves under ONE new conditional transition, the only writer that
may leave `failed`:

- allowed FROM `failed` (any code) or `sent` (the original's own failure
  rollup may have missed - a thrown rollup, a slot not yet written); never
  from `delivered` or `skipped`;
- allowed only when the receipt's attempt is NEWER than the slot's recorded
  newest attempt (message ids order by provider time), or is that same attempt
  moving forward (sent -> delivered, sent -> failed);
- writes status, code, carrier instant, the newest-attempt pointer and the
  promise, with the stats delta, in one conditional write (the atomic
  slot-plus-stats primitive SOR added), so the buckets never drift from the
  map;
- never writes `queued`.

A retry's ACCEPTANCE is learned from the carrier's own `sent` callback for the
retry row, as it is for an original: the retry job writes nothing to the
share, so no send-time writer is added to the slot's six existing writers.
Until 1b and this branch both ship, a retry's receipt logs at INFO and touches
nothing.

### D3. The results row and the promise

The row shows the newest attempt's outcome, from the slot. A 30003 row reads
RSW's copy through the same rule as the tenant's thread: "will retry" only
while the slot's promise is live, judged on the server clock, re-judged by a
one-minute ticker on the page (the conversation page's own precedent) so a
promise that lapses is not shown until the next refetch. The promise is stamped
on the slot inside the rollup's failure write for the attempt it belongs to
(the first failure today; every later 30003 through D2), and withdrawn on the
slot when the message's promise is withdrawn (an enqueue failure; 1b's
declines). A stale copy cannot outlive its own clock: liveness is time-bound,
withdrawal is an accelerator.

The "open conversation to retry" hint appears only when the conversation
would offer Retry: never while a promise is live, never on "Not confirmed",
never once a later attempt delivered.

### D4. Share labels derive from recipients

For a finished share (stored `sent` or `failed`), the label derives from its
slots, first match wins:

- **Sent** - at least one recipient reached the carrier or was delivered.
- **Sending** (progress tone) - nobody reached yet, and at least one failed
  recipient has a live retry promise.
- **Not confirmed** - nobody reached, nothing pending, at least one "Not
  confirmed".
- **Not sent** - everything else: skipped and finally-failed recipients only
  (danger tone when any recipient failed, neutral when every one was skipped -
  Branch A's case).

Draft and Sending shares keep their stored labels. The stored `last_error`
(SOR's "Couldn't confirm any text went out", the route's "enqueue failed")
shows unless the label is Sent. The status filter tabs and the stored status
are unchanged (this is presentation, as Branch A's D6 was). The list needs one
more derived bucket to label a row without its recipients: `retry_pending`
(failed slots with a live promise), derived on the server at read time and
carried on the wire beside the existing buckets; the Failed chip excludes it.

### D5. "Sent to N tenants" recounts and relabels at read time

The property Activity entry and the landlord-timeline milestone keep the
audit row finalize writes (append-only, never rewritten) but derive their
words from the share at read time: N = recipients whose newest attempt reached
the carrier or was delivered; "Sent to N tenants" when N > 0, "No tenants
reached" when N = 0 (linking to the share either way, whose page explains why).
Cost: one projected batch read of the shares on the page (at most the page
size); on the landlord timeline the recount runs after the merge and slice, so
it costs at most one page of reads, never 25 units' worth. A share that no
longer exists falls back to the stored count with the stored words.

### D6. The tenant "Property sent" milestone follows the ledger

The milestone stays written at carrier acceptance (it is a timeline fact:
"we sent it to you then"), but it now records its share id, and its words
derive at read time from the ledger entry for (property, tenant, share): a
counted attempt reads "Property sent"; "Not confirmed" reads "Property sent -
not confirmed"; a final failure reads "Property text failed". One ledger read
per (property, tenant) pair on the page, batched; a milestone whose pair has
no entry (a share older than the repair's reach) keeps its stored words. This
closes `tenant-timeline-property-sent-milestone-after-failed-delivery`.

### D7. The ledger follows the rule

The listing-send row (one per property-tenant pair) gains:

- a per-share memory: for each share of the pair, the newest attempt (message
  id), its state - `counted` (accepted, delivered, or failed with a live
  promise), `unconfirmed`, or `failed` - and the instant it counted;
- `counted` for the pair: true when any share entry is `counted` (absent on
  a legacy row reads as counted, so no backfill is needed to keep today's
  rows listed);
- `sentAt` and `broadcastId` describe the latest COUNTED share. When no share
  counts, `counted` is false and `sentAt` is REMOVED, so the "Properties sent"
  index (a GSI keyed on `sentAt`) drops the pair on its own - the codebase's
  sparse-by-absence convention - and the tour form's default property moves
  to the newest pair that still counts. The property page's "Sent to tenants"
  list filters `counted` explicitly (it reads the base table).

Writers, each a conditional read-modify-write keyed on the row's change token:

- the share pass at carrier acceptance (today's write, now writing the entry
  as `counted` for that attempt);
- the reconcile's adoption (today: only an adopted sent/delivered; unchanged);
- the status webhook's rollup (new): a terminal failure with no live promise
  marks the entry `failed`; a 30003 with a promise leaves it `counted`; a later
  attempt's acceptance or delivery marks it `counted` again with the new
  attempt; the reconcile's unresolved close marks it `unconfirmed`;
- the repair (once).

Order-independence against the carrier callback: an entry write applies only
when its attempt is newer than the stored one, or is the same attempt moving
forward (counted -> failed, counted -> unconfirmed; never failed -> counted for
the same attempt). Since the pass writes the ledger AFTER the token wait, a
failure callback can land first; under this rule the pass's later write for
the same attempt cannot resurrect the entry. "Not confirmed" is recorded but
never counts in the ledger (a tenant is listed under "Properties sent" only
for a text we believe reached them); it counts for the composer flag (D1).
The pair's contact is the contact resolved when the share was sent (today's
key); a later writer resolves the slot's recipient the same way.

### D8. The repair - a Cameron-run, dry-run-first pass over history

One script, the D1/D2 ops-script shape (stage resolver, `--env`, `--lane`,
dry run by default, `--apply`, every write conditional, counts and ids only in
logs), run once per environment on Cameron's go right after this branch
deploys and before the next blast. Its census, then its apply:

1. Walks every share (the shares index), every non-skipped slot, reads the
   original message and the conversation's rows newer than it, and rebuilds
   the recipient's attempt chain by lineage (a retry points at the attempt it
   retried; the walk follows the chain root).
2. Stamps `broadcast_id` and `retry_root` on retry rows written before Stage
   1b, so in-flight chains route after the deploy.
3. Applies D2's transition to slots whose newest attempt differs from the
   recorded one (a retry that delivered or failed after the original's 30003),
   under D2's conditions - never touching a delivered or skipped slot, never
   moving a slot an attempt newer than the census has touched.
4. Rebuilds each ledger row's per-share memory, `counted`, `sentAt` and
   `broadcastId` under the row's change token, never erasing an entry written
   after the census.

It reports, per environment: shares and slots walked, retry rows stamped, slots
moved, pairs un-counted and re-counted, rows it could not judge (a pre-RSW
retry whose lineage was never written; an original message missing). Sizes are
unknown until the census runs; every read is a keyed query except the ledger
enumeration, which is a scan of a small table.

### D9. Issues this branch closes or files

Closes: `broadcast-30003-retry-never-updates-slot`,
`unconfirmed-share-invites-resend`,
`tenant-timeline-property-sent-milestone-after-failed-delivery`. Amends
`send-attempt-sweeper` (the stranded `queued` recipients D1 stops flagging are
the sweeper's population). Files anything the review or the build finds out of
scope.

## 4. Invariants

- I1. A recipient counts as sent only by the rule in D1, and every surface
  reads that one rule: the composer flag, the results row, the labels, the
  counts, the ledger, the milestone. No surface reads the share's stored
  status to decide whether a tenant got the property.
- I2. A recorded delivery is never erased: no writer moves a `delivered` slot,
  and a ledger entry counted by a delivery stays counted for that share.
- I3. A `failed` slot moves only through a NEWER attempt's receipt (D2) or the
  repair (D8), under a condition on the state it read; a `skipped` slot never
  moves; nothing writes a slot back to `queued`.
- I4. Every slot write that changes a bucket carries its stats delta in the
  same conditional write; displays keep deriving from the map.
- I5. A retry's promise is shown only while it is live on the server clock, on
  every surface that shows it, and never invites a Retry the conversation
  would refuse.
- I6. The ledger is order-independent against the carrier callback: for one
  attempt, a later write cannot resurrect a failure or un-count a delivery;
  only a newer attempt re-counts a pair.
- I7. Stage 1b writes nothing to a share slot; this branch writes nothing to
  the retry job's record or claim. The interface between them is the two
  fields on the retry row.
- I8. Production is written only by the deployed code paths and the
  Cameron-run repair on his explicit go; no infrastructure, index or
  dependency changes.
- I9. No new slot status, share status, table or GSI; the ledger's index
  becomes sparse by attribute absence, which is documented as a contract
  change to that GSI's meaning.

## 5. Surfaces (writers and readers the plan must cover)

- Slot state. Writers: the fan-out's arms (unchanged), the reconcile's closes
  (unchanged), the rollup (D2's transition and the promise stamp), the repair.
  Readers: the composer flag (repo + the in-memory test double, which mirrors
  the rule), the results route and row, derived stats and the new
  `retry_pending` bucket, the SSE payload, finalize (unchanged; it reads slots
  once), the two "Sent to N" surfaces (D5), the fake-twilio harness's world.
- Retry rows: written by 1b (the automatic retry, the adoption, the staff
  route); read by the rollup (D2) and the repair (D8).
- The ledger row: writers in D7; readers - the tenant "Properties sent" API
  and card, the property "Sent to tenants" API and card, the tour form's
  default property, the tenant timeline milestone words (D6), the seed
  history generator (one "Property sent" per ledger row - it must skip an
  un-counted pair), the repair.
- The milestone: writer unchanged in timing, now carrying the share id;
  reader - the contact timeline (D6).
- The `broadcast_sent` audit row: unchanged; its two readers derive (D5).
- Seeds: the lean world is byte-stable and has no ledger rows; the full world's
  five ledger rows read as counted (absent flag). No seed change is required;
  a seeded un-counted pair is added only if an e2e needs it.
- Dashboard copy touched: the share labels (D4), the results-row hint (D3),
  the two "Sent to N" labels (D5), the milestone words (D6). None is catalog
  copy.

## 6. Sequencing and rollout

1. This spec: adversarial review, then Cameron's gate. In parallel: SOR Stage
   1b.
2. After 1b merges: the plan (against the record and the retry job as built),
   plan review, the mission block, the build in this worktree with one main
   sync at the end, the planner's review, Cameron's merge.
3. After deploy: the D8 census, then the apply, dev then prod, each on
   Cameron's go, before the next blast. Nothing infra-side.
4. Merge points for anyone landing beside this branch: the rollup in the
   status webhook (fenced for SOR Stage 1; this branch opens it for D2 and D7),
   the ledger repo and its two routes, the contact timeline's milestone
   mapping, the fan-out's `recordPropertySent`, `deriveBroadcastStats` and the
   dashboard's stats types (the `retry_pending` bucket), `presentShareLabel`
   and `shareRecipientReason`, the harness doubles.

## 7. Testing and acceptance

- Hermetic tests for every decision, including: the D2 transition's every
  refusal (delivered, skipped, an older attempt, a same-attempt regression)
  and every allowed move, with its stats delta; the promise stamp and
  withdrawal on the slot; the D7 write rule under both orders (pass then
  callback, callback then pass) for one attempt and across attempts; the
  sparse index behavior of an un-counted pair and its return; the D4 label
  table; the D5 recount with a missing share; the D6 words for all three
  states; the D8 script's dry run writes nothing, its apply is idempotent, and
  it refuses the wrong account.
- End to end on the hermetic lane, with the fake carrier's fail profile and the
  lane's ten-second retry backoff: a one-to-one share whose first text fails
  30003 and whose retry delivers ends with the results row Delivered, the
  share Sent, the tenant flagged "Already sent", "Properties sent" listing the
  property; a share whose text fails 30007 ends with the row Failed, the share
  "Not sent", the tenant NOT flagged, the property gone from "Properties sent"
  and the milestone reading "Property text failed", the property Activity
  entry reading "No tenants reached"; a "Not confirmed" share (SOR's e2e path)
  flags the tenant, reads "Not confirmed", and is not listed under "Properties
  sent"; the results row shows "will retry" while the promise is live and
  drops it when it lapses.
- All five completion gates. The tests that pin Branch A's interim rule and
  SOR's "Failed" pill for an all-unconfirmed share are rewritten to this rule
  and say so.
- Handback reports the D8 census numbers per environment once Cameron has run
  it, and every issue closed or filed.

## 8. Risks and accepted tradeoffs

- **Slot size.** The share item holds every slot; the repo budgets about 200
  bytes per slot at a 1500-recipient cap, near 300 KB of the 400 KB item
  limit. This branch adds up to two attributes per slot, only on slots that
  were retried or promised a retry (a second message pointer, a timestamp).
  The plan sizes a capped share with every slot carrying both (the worst case
  is an entire blast failing 30003) and, if it does not fit, lowers the
  recipient cap rather than dropping the fields. Typical shares are small.
- **Read cost of the relabels** (D5, D6): bounded by the page, batched, and on
  the hottest route (the landlord timeline) only after the slice. Accepted.
- **A retry row stamped with the share id** looks, to SOR's reconcile
  ownership check, like the recipient's own message. It matters only when a
  share attempt is in the reconcile's lookup while its original row exists and
  the retry falls in that window; candidates are tried oldest-first, so the
  original is adopted first. Named as a watch item for the plan; the reconcile
  check gains a "not a retry row" clause if the plan finds a real path.
- **Pre-RSW rows** may lack lineage; the repair reports what it cannot judge
  and leaves those slots as they are. Accepted (the stub's residual).
- **The double-text window** during a retry's backoff (a second share of the
  same property before the retry runs) stays: the tenant is flagged (D1 counts
  a live promise), but the flag is a hint, not a block. Accepted, as in v5.
- **`queued` no longer counts** (D1): the in-pass window described there.
  Accepted.
- **The ledger's index becomes sparse.** A pair with no counted share leaves
  "Properties sent" entirely (not greyed); staff see it again the moment a
  share counts. Accepted; the milestone keeps the history.
- **Stage 1b drift.** If 1b lands without the two row fields, the plan's first
  task adds them (a two-line append change in the retry job and the route)
  before anything else; nothing here depends on 1b's record shape.

## 9. For Cameron at the spec gate

- D1: `queued` recipients no longer count as "Already sent" (only during a
  pass, or when stranded).
- D4: a finished share's pill can read Sending while a retry is pending, Not
  confirmed, or Not sent; "Failed" retires as a pill (the tab stays).
- D5/D6: "No tenants reached" and "Property text failed" are new staff words;
  "Property sent - not confirmed" too.
- D7: a pair drops out of "Properties sent" when no share of it counts, and
  the tour form's default property moves with it.
- D8: one more Cameron-run script, once per environment, after deploy.
