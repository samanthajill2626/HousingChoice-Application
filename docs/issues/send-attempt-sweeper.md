---
id: send-attempt-sweeper
title: No sweeper closes a send attempt stranded by a crash or a failed write - the Stage 2 backstop the send-outcome design records as residue
type: improvement
severity: med
status: open
area: app/messaging
created: 2026-09-25
updated: 2026-09-27
refs: docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md, app/src/repos/sendAttemptsRepo.ts:30, app/src/repos/sendAttemptsRepo.ts:329, app/src/lib/tables.ts:232, app/src/jobs/relayFanOut.ts:1381, app/src/jobs/relayRetryLeg.ts:939, app/src/jobs/sendReconcile.ts:370, app/src/jobs/sendReconcile.ts:1041, app/src/repos/messagesRepo.ts:714, app/src/services/groupSendStaleness.ts:1, app/src/jobs/groupGuardrails.ts:7, app/src/routes/webhooks/twilio.ts:2936, app/src/routes/webhooks/twilio.ts:3039, dashboard/src/routes/contact/deliveryStatus.ts:274
---

**Problem.** `feat/send-outcome-reconcile` (SOR) gives every adopted send site a
per-recipient send-attempt record (D8a) with a `state`
(`attempting` | `reconciling` | `redriven` | `done`) and an attempt clock
(`attemptedAt`). It closes the ordinary failure paths in-line, but it records,
and does not close, the windows in which that record is left open with nothing
coming back for it (design Sec 1 guarantee 2, D7a, D14):

- **`attempting` past its TTL with no send site revisiting it.** A process died
  between the claim and the send, or between the send and its record write, and
  no later pass or continuation for that recipient will run. D8a's takeover
  only fires when a send site meets the stale record; nothing meets it.
- **`reconciling` with no chain.** The record moved to `reconciling` and the
  process died before the `send.reconcile` enqueue (an enqueue that THROWS is
  handled - D7 - but a crash is not).
- **`redriven` that no continuation lists.** A `never_sent` verdict moved the
  record to `redriven` and the re-drive enqueue was lost to a crash, or the
  continuation early-returned before claiming (see
  [relay-continuation-early-return-strands-slots](./relay-continuation-early-return-strands-slots.md)).
- **A failure-arm write that itself fails** (D7a): the D5/D6/D7 slot or record
  write after a classified outcome throws; the record keeps `attempting` and
  the slot keeps whatever it held. This is the "throwing close" class of
  [fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md)
  one step earlier. (Superseded as built - see the 2026-09-27 section.)

Each leaves a slot non-terminal (`queued`) and, for a broadcast, the row
`sending`. SOR's dashboard rule D20a makes such a relay leg read "Queued - not
confirmed" after 15 minutes when the slot still carries `attemptedAt`, which is
honest but is presentation only: nothing reaches a verdict.

The same class already exists without the record:
[relay-retry-stranded-claim-window](./relay-retry-stranded-claim-window.md) (a
crash between the relay 30003 retry claim at
`app/src/routes/webhooks/twilio.ts:2742` and its enqueue at `:2803`) says the
fix is "a due sweeper" and puts it out of scope.

And one piece of the sweeper is assumed by the dashboard today: its relay
staleness comment (`dashboard/src/routes/contact/deliveryStatus.ts:221-223`)
says "the server's own staleness alarm covers" a relay leg whose dispatch never
happened. No such alarm exists - see
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md).
(That comment was corrected on the branch - see the 2026-09-27 section.)

**Suggested fix.** Group: the sweeper (see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9, and D14: "the attempt record gives it a clock and a state to read").
Build after SOR Stage 1 lands. A periodic job that finds attempt records open
past a bound and hands each to the machinery that already exists: a stale
`attempting` or an orphaned `reconciling` goes to `send.reconcile` (the takeover
D8a already defines), an orphaned `redriven` gets its re-drive enqueued again
(the claim makes a duplicate safe). Precedents for the finding half: the due
row written in the same transaction as the append
(`app/src/repos/messagesRepo.ts:714`) and the native group-text staleness sweep
(`app/src/services/groupSendStaleness.ts`, run from
`app/src/jobs/groupGuardrails.ts`). The relay staleness alarm the dashboard
assumes belongs in the same job. It must not read coordination state through a
GSI (SOR D11: strongly consistent base-table reads only), so how it FINDS open
records - a due row per attempt, or a bounded index used only to nominate
candidates that are then re-read consistently - is its main design question.

**Related.**
[relay-retry-stranded-claim-window](./relay-retry-stranded-claim-window.md),
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
[fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md),
[relay-continuation-early-return-strands-slots](./relay-continuation-early-return-strands-slots.md),
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md),
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md).

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

The record this sweeper reads, as BUILT, and what the build left for it.
Anchors at the branch's HEAD (`b7b3f24b`).

**Two item families** in the messages table (`app/src/repos/sendAttemptsRepo.ts`),
both carrying the 30-day `expires_at` cleanup horizon and both reaped ONLY by
TTL (`app/src/lib/tables.ts:232-235`): nothing consumes or deletes them, and a
`done` record is the recipient's answer until it expires.

- **The record.** Partition `sendattempt#<ownerKey>`; sort key the recipient
  key, hashed when it carries a phone (`:30-31`, `:143-148`; `phone#<E164>`
  becomes `phonehash#<32 hex>`, `app/src/lib/sendFingerprint.ts:37-40`).
  `ownerKey` is the owner WITHOUT the recipient (`:119-128`):
  `broadcast#<broadcastId>`, `relay#<relayConversationId>#<sourceTsMsgId>` or
  `rung#<relayConversationId>#<retryTsMsgId>`. The record's identity is
  `attemptKey` = `<ownerKey>|<hashed recipient key>` (`:139-141`). Attributes
  (`:190-209`, read back by `toRecord`, `:158-176`): `attempt_state`,
  `attempt_no`, `attempted_at`, `redrive_count`, `check_no`, `sid`, `outcome`,
  `cause`, `recipient_digest`, `sender` (null when unset), `body_hash`,
  `body_short`, `media_count`, `owner` and `expires_at`. `owner` is the RAW
  owner map, so it keeps the raw recipient key - a `phone#<E164>` for a
  contact-less recipient - which is how a reconcile addresses the slot; the
  index item below carries a second copy (build S1b concern 2).
- **The recipient index.** Partition
  `sendattemptix#<sender or ->#<recipientDigest>`; sort key
  `<attemptedAt>#<ownerKey>#<hashed recipient key>`; attributes `owner`,
  `attempted_at`, `body_hash`, `body_short`, `media_count`, `expires_at`
  (`:32-33`, `:150-152`, `:294-309`). Written in the claim's transaction,
  never updated: a reader resolves the record for the live state.

**States and clocks.** `state` is `attempting` | `reconciling` | `redriven` |
`done` (`:41`); on `done`, `outcome` is `sent`, `rejected`, `retryable`,
`refused`, `adopted`, `never_sent`, `unresolved`, `enqueue_failed` or
`redrive_refused` (`:42-51`), with an optional `cause`. `attempted_at` is the
latest claim's instant - the attempt clock every transition is fenced on, and
the index's sort-key prefix; a takeover keeps it. `expires_at` is that claim's
instant plus 30 days, in epoch seconds (`:35`, `:154-156`), written only by a
claim. The claim TTL is `SEND_CLAIM_TTL_MS`, 30 000 ms
(`app/src/lib/sendOutcome.ts:25`), the same value the Twilio driver uses as
its request timeout (`app/src/adapters/messaging.ts:690`); an `attempting`
record exactly 30 000 ms old is still fresh (`sendAttemptsRepo.ts:347-349`).

**Transitions**, each one conditional write (`true` = written, `false` = its
condition failed): `claim` (`:329-352`, a TransactWrite of the record and a new
index item) claims an absent, `done`/`retryable` or `redriven` record
(`attemptNo` + 1, a new `attemptedAt`, `checkNo` 0, `redriveCount` untouched);
a stale `attempting` is a `takeover` (nothing written - the caller runs
`takeOver` and hands off); a fresh `attempting` is refused fresh (defer);
`reconciling` or a terminal `done` is refused not fresh (skip).
`finishAttempt` and `handToReconcile` are fenced on `attempting` plus
`attemptNo` plus `attemptedAt` (`:377-419`); `takeOver` moves a stale
`attempting` to `reconciling`, keeping `attemptedAt` (`:421-427`);
`recordCheck` (`:429-435`), `markRedriven` (`redriveCount` 0 to 1, so at most
once, `:437-443`) and `closeFromReconcile` (`:444-463`) are fenced on
`reconciling` plus `attemptedAt`; `closeRedriven` moves any `redriven` record
to `done` (`:465-471`). Every read is strongly consistent on the base table:
`get` (`:256-259`) and `listByRecipient` (`:472-502`: a consistent Query,
newest first, 100 items a page, one consistent `get` per index item, one row
per `attemptKey`). No GSI anywhere.

Two facts for any reader of the index (build S1b concerns 1 and 4): a
re-claim under a DIFFERENT sender (or none) leaves the earlier index item in
the old sender's partition, still resolving to the live record, which now
carries the new sender - so re-read the record and never trust the
partition's sender; and a claim after a lost create costs extra consistent
reads, while `listByRecipient` costs one read per index item - inputs for the
cost of any sweep that walks them.

**What the build leaves for the sweeper** (spec Sec 1 guarantee 2, D8a
revision 11, D14; the slice records' residues):

1. **A fresh `attempting` record at a cap-close.** The cap-closes leave a
   recipient whose record is `attempting` inside the TTL to its own attempt
   (`app/src/jobs/broadcastFanOut.ts:455-463`,
   `app/src/jobs/relayFanOut.ts:1254-1262`; the rung's gated closes,
   `app/src/jobs/relayRetryLeg.ts:709-714`). Right while that attempt is a
   live send; when it is a stranded one (item 2), nothing revisits it.
2. **A STRANDED relay member or rung** - a lost `handToReconcile` write
   (`relayFanOut.ts:2098-2112`, returned as `stranded` at `:2126` and
   `:2237`). The fan-out carries the member with no slot write
   (`:1381-1387`), but the relay ladder - 5 s then 10 s (`fanOutBackoffMs`,
   `:151-153`; `MAX_FANOUT_ATTEMPTS` 3, `:135`) - never outlasts the 30 s
   claim TTL: each continuation's claim finds the record fresh and defers it,
   and the cap-close defers it too (item 1). The rung does not even defer: it
   logs ERROR and stops (`relayRetryLeg.ts:939-953`). The record stays
   `attempting` and the slot `queued` with its attempt clock, which the
   dashboard ages to "Queued - not confirmed" after 15 minutes (spec D20a).
   On broadcast the 10 s + 20 s ladder does clear the TTL, so a
   continuation's claim or the cap-close takes the record over into
   reconcile: this item is relay-only (spec D8a, revision 11; build S2b
   residue 2).
3. **An orphan record whose owner recipient cannot be resolved.**
   `send.reconcile` finds the raw recipient key from the payload's hash
   (`app/src/jobs/sendReconcile.ts:447-481`); when nothing matches it logs
   INFO and returns, leaving the record `reconciling` with no chain
   (`:370-378`; build S3a residue 4).
4. **`markRedriven`, then a death before the re-drive enqueue**
   (`sendReconcile.ts:1041-1053`): the record is `redriven` and no re-drive is
   coming; a redelivered check exits superseded (`:385-395`). The D14 class
   (build S3a residue 5).
5. **A `takeOver` that applied and then threw** (its response lost). Through
   the record gate (`broadcastFanOut.ts:256-265`, reached from the cap-close
   `:455` and the fences `:647`; `relayFanOut.ts:1663-1672`, from `:1254` and
   the suppression arm `:1858`; `relayRetryLeg.ts:395-404`, from
   `closeUnlessOwned` `:696`) or on the claim path (`broadcastFanOut.ts:857`,
   `relayFanOut.ts:1967`), the record is left `reconciling` with no chain: the
   caller took the throw as a prepare-phase failure (deferred and carried, or
   an ERROR on a cap-close), and every later claim refuses a `reconciling`
   record as not fresh and skips it (build S2a residue).
6. **The crash windows** the body lists (D14): a death between the claim and
   the send, or between a record transition (`handToReconcile`, `takeOver`,
   `markRedriven`) and the enqueue that follows it.

Not a residue, by design (build finding T7-11): a FIRST pass carries neither a
fence deferral nor a refused fresh claim (`broadcastFanOut.ts:653`, `:847`;
`relayFanOut.ts:1377`) - the attempt that owns the recipient belongs to
another pass, which carries it; if that attempt strands, items 1 and 2 apply.

**Bullet 4 of the problem is superseded (build finding T15-3).** No
failure-arm write throws any more: every one goes through `guardWrite`
(`app/src/lib/guardWrite.ts:16-29`), and a lost hand-off strands the recipient
(item 2) instead of throwing. What a failed guarded write leaves is recorded
with the close paths in
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md)
(2026-09-27 section); where the record half is the one lost, the record stays
open and is this sweeper's.

**The dashboard comment quoted in the problem is gone (build finding T15-3).**
The relay staleness rules no longer claim a server alarm: the S3 table
(`dashboard/src/routes/contact/deliveryStatus.ts:245-255`, the `queued` rows
at `:251-252`) and its reasoning (`:274-282`) now say the silent class has no
alarm anywhere and name
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md),
whose alarm stays in this sweeper's scope. The body's other webhook anchors at
HEAD: the relay 30003 retry claim's append is
`app/src/routes/webhooks/twilio.ts:2936` and its enqueue `:3039`.

A reconcile that keeps failing - a relay adoption onto a missing row, item 7
of [send-reconcile-job-residues](./send-reconcile-job-residues.md) - also ends
with a `reconciling` record after the DLQ, so a sweeper that re-enqueues
`send.reconcile` for such a record must bound its own retries.
