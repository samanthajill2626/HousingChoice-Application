---
id: send-attempt-sweeper
title: No sweeper closes a send attempt stranded by a crash or a failed write - the Stage 2 backstop the send-outcome design records as residue
type: improvement
severity: med
status: open
area: app/messaging
created: 2026-09-25
updated: 2026-09-28
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

## Addendum 2026-09-27 - code review rounds 1-4

The branch's code review corrected one claim in the section above and added
three strands for this sweeper, and its fix waves changed the record the
sweeper reads. Records under
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/`
(`r2-adjudications.md` sections 2 and 4, `r2-adversarial.md` N-1 and A-3,
`r2-conformance.md` R2C-3 and R2C-5, `fw1-report.md`, `fw2-report.md` and
`fw4-report.md` "New residues", `r3-adjudications.md`); anchors at the
code-final commit `52220729`. Status and severity are unchanged: the
correction widens the sweeper's broadcast work, which `med` already covers.

**Correction to item 2: the broadcast ladder clears the TTL only for a
pass-1 strand (round 2 N-1 / R2C-3 / A-3 / F-2, LOW, a double fault).** Item
2 says the 10 s + 20 s broadcast ladder clears the 30 s claim TTL, "so a
continuation's claim or the cap-close takes the record over into reconcile:
this item is relay-only". Each continuation waits its OWN backoff - 10 s
before pass 2, 20 s before pass 3 (`broadcastBackoffMs`,
`app/src/jobs/broadcastFanOut.ts:148-150`, scheduled at `:1146` and `:1164`;
`MAX_BROADCAST_ATTEMPTS` 3, `:136`) - against the 30 s TTL
(`SEND_CLAIM_TTL_MS`, `app/src/lib/sendOutcome.ts:29`). Only a strand from
PASS 1 is old enough, by pass 3 or at its cap, to be taken over (`gateFor`,
`app/src/lib/sendAttemptGate.ts:35-37`). A strand in pass 2 or 3, or in ANY
re-drive pass (which meets a spent ladder, or reaches its cap about 20 s
later), is still fresh at the cap: the cap-close's gate defers it
(`closeBroadcast`, `broadcastFanOut.ts:431-439`), no continuation follows
close A (`:1147-1151`) or a re-drive's capped claim (`:1132-1135`), and
`finalize` waits on the queued slot (`:1526-1531`). The record stays
`attempting`, the slot `queued`, and the share reads Sending until this
sweeper. Round 2 reproduced it (throwaway probe zz-r2a-1: a last-rung 21211
whose reject-slot write throws ends slot `queued`, record `attempting`,
status `sending` at pass 3, no pending job, the cap gate `defer`).

The strands that reach it, each a DynamoDB write that throws after a
provider outcome:

- pre-existing: a lost hand-off (`handToReconcile`'s write threw,
  `broadcastFanOut.ts:598-614`, carried at `:613`);
- added by FW2-2 (round 1 C-2 / R-e), which keeps the record open when a
  terminal arm's slot write throws: a rejection (`onRejected`, carried at
  `:755-766`), a refusal (`:997-1009`) and a re-drive's second unknown
  (`onUnknown`, `:784-801`) - the last runs only on re-drive passes, so the
  carry never rescues it;
- relay: every strand, since the 5 s + 10 s relay ladder never clears the
  TTL (the concession at `app/src/jobs/relayFanOut.ts:1400-1408`; item 2).

What a pass-1 strand then gets (FW2 residue 3, corrected by N-1): a
REJECTED recipient whose slot write threw still has a `queued` slot, so once
taken over the reconcile finds nothing at the provider (a synchronous
rejection created no message), rules `never_sent` and re-drives once - a
second provider call for a rejected send, which for 30007 re-offers filtered
content to the carrier. Every later strand waits here.

FW2-2 is kept (round 2's answer to A-3): a record left `attempting` conforms
to D7a and stays visible to this sweeper, where a terminal record beside a
stuck `queued` slot would not. The reviewers' fix directions - hand the
attempt to reconcile directly from the failed arm, or let the cap-close take
over records this same pass abandoned (a local set), whatever their age - are
new machinery on a double-fault path and were declined under the human's
standing ruling on the branch (Cameron, 2026-09-27, `r1-adjudications.md`
section 6: a double text is annoying, not critical; no new failure points).

FW4-2 (commit `5d373ae9`) corrected the broadcast comments that promised the
takeover (`closeBroadcast` `:401-415`, `handToReconcile` `:585-596`,
`onRejected` `:672-685`). Three texts still carry the old promise:

- the approved spec, D8a revision 11
  (`docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md:444-445`:
  "the broadcast ladder (10 s + 20 s) clears it, so a stuck broadcast attempt
  is taken over at the cap"), true for a pass-1 strand only. The spec is the
  approved contract and is not edited on the branch; this is its erratum
  (FW4 residue 1);
- `app/src/lib/guardWrite.ts:4-6` ("a lost write is logged at ERROR and left
  to the stale-claim takeover") - true only where a later pass meets the
  record stale (filer's note, FW3);
- [fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
  2026-09-27 section ("on broadcast a continuation's claim or the cap-close
  takes the stale record over"), corrected by its own Addendum 2026-09-27.

**New for the sweeper.**

7. **A false open record beside a terminal slot (round 2 R2C-5, LOW).** The
   broadcast known arms (30007, 30005, 30006) write the slot and then bump
   the stats inside ONE guarded write (`onRejected`,
   `broadcastFanOut.ts:696-705`). When the slot write succeeds and the stats
   bump throws, the guarded write reports failure, so the record stays
   `attempting` and the recipient is carried (`:755-766`) beside a slot that
   already reads `failed` with the provider code. The next pass skips the
   terminal slot before any claim (`:1073`), and so does the cap-close
   (`:427`), so nothing meets the record: it stays `attempting` until its
   30-day cleanup horizon. Harmless to the user today (round 3's probe
   zz-r3-2): finalize reads the slot. For 30005/30006 the contact is flagged
   `sms_unreachable` regardless (`:724-728`). **The sweeper must read the
   SLOT before it takes over or re-drives any open record**: a recipient
   whose slot is already terminal is finished - close its record, never
   re-drive it. Splitting the guarded write is a write-structure change,
   left here (`r3-adjudications.md` sections 1-2); FW5-2 only made its log
   line say "its slot or stats write failed" (`:761-764`). The FW5-2 test
   pins today's state (`app/test/broadcastFanOut.test.ts:2319`), so a fix
   restates it.
8. **A re-arm that committed and then threw** leaves `attempting` on the
   re-armed clock beside a `queued` / `send_retryable` slot, nothing sent
   (round 2 R2C-6) - item 4 of
   [send-attempt-rearm-residues](./send-attempt-rearm-residues.md).
9. **A rung's `closeRedriven` that throws (FW2 residue 5, LOW).** The rung's
   gated closes close a `redriven` record FIRST (`closeUnlessOwned`,
   `app/src/jobs/relayRetryLeg.ts:680-699`, FW2-4). That write stays guarded
   on the rung - unguarded it would throw out of the job (FW2 deviation 6) -
   so a throw logs one ERROR and returns without closing: the record stays
   `redriven`, the retry leg's slot `queued`, and the rung's chain ends. The
   orphaned-`redriven` class of the problem's third bullet, the same end
   state as the rung's gate-read throws in
   [fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md)
   (build finding T9-7).

**The record as the fix waves left it** (supersedes the matching sentences
of the section above):

- **The re-arm (FW1-1, FW2-1).** Every send site re-arms its attempt as the
  last step before the provider call (`rearm`,
  `app/src/repos/sendAttemptsRepo.ts:379-420`): `attempted_at` becomes the
  LAST re-arm's instant, not the claim's; `expires_at` moves with it; and a
  SECOND recipient-index item is written at the re-armed instant. So
  "`attempted_at` is the latest claim's instant" and "`expires_at` ... written
  only by a claim" above no longer hold. The claim TTL and the takeover
  (`claim`, `:440-444`; `gateFor`, `sendAttemptGate.ts:35`) and the
  reconcile's window are all measured from the last re-arm. Its residues are
  [send-attempt-rearm-residues](./send-attempt-rearm-residues.md).
- **The op token (FW1-5).** Every fenced transition writes a fresh random
  `last_op` and, on ConditionalCheckFailed, re-reads it consistently and
  answers `true` when the stored token is its own - its write committed on an
  earlier SDK attempt (`transition`, `:448-482`). `true` now means "written by
  this call, on this request or an earlier attempt of it". The claim and the
  re-arm write no token: they are TransactWrites and rely on the SDK's
  ClientRequestToken (item 7 of the re-arm issue). `finalizeStatus` does the
  same with `finalize_op` (`app/src/repos/broadcastsRepo.ts:937-983`).
- **The op token's re-read window (FW1 residue 3; the narrow class of round
  1's ADV-3 note).** A write that committed and was then overwritten by
  ANOTHER writer's transition before the re-read reports `false`: the caller
  takes its lost-fence path while the record already carries the later
  writer's state. A sweeper is one more writer whose transitions can land in
  that window; it should read its own `false` the same way - someone else
  moved the record. The slot and stats writes carry no token at all (item 15
  of [send-reconcile-job-residues](./send-reconcile-job-residues.md)).
- **The window and the siblings are two-sided (FW1-2).** A reconcile's
  candidates lie in [attemptedAt - 60 s, attemptedAt + 90 s] and its siblings
  are the attempts whose start lies within 150 s of it, either side
  (`sendOutcome.ts:31-47`), whenever the check runs - so a sweeper that
  re-enqueues `send.reconcile` for an old record re-judges the same window.

## Addendum 2026-09-27 - planner post-build review: sweep by broadcast and relay source, not only by record

Found by the planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding H-1
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`),
filed as its own high issue:
[deploy-mid-share-strands-remaining-recipients](./deploy-mid-share-strands-remaining-recipients.md).
Anchors at HEAD `91a66577`. Status and severity here are unchanged; the high
lives in that issue.

**The gap.** The suggested fix above finds "attempt records open past a
bound". A deploy that lands during a share kills the pass mid-loop (the
worker's 10 s drain, `app/src/worker.ts:543`); the SQS redelivery carries the
same `jobId` and the run-once marker suppresses it
(`app/src/jobs/broadcastFanOut.ts:351-363`, relay
`app/src/jobs/relayFanOut.ts:829-841`). That leaves ONE recipient with an
`attempting` record (the one mid-send) and every recipient after it `queued`
with NO record at all - records are written only at the claim
(`broadcastFanOut.ts:869-879`, relay `relayFanOut.ts:1941-1952`). A sweeper
keyed on records finds the one and misses the rest, which is most of the
share. Every deploy during a share produces this, so it is the most frequent
strand this sweeper will meet.

**What the sweeper must add.**

- **A second input: owners, not only records.** `sending` broadcasts, and
  relay source messages carrying `queued` legs, whose pass is no longer live
  past a bound. For broadcasts the team-wide list can nominate candidates
  (`listByStatus('sending')`, a byCreated GSI Query with a status filter,
  `app/src/repos/broadcastsRepo.ts:692-695`) - under D11 only as a
  NOMINATOR, each candidate then re-read with `getByIdConsistent`. Relay
  source rows have no such list; finding them (a due row written with the
  source, or similar) is a design question.
- **Per `queued` slot, read the record consistently and act on it.** No
  record: the recipient was never claimed and so never sent - re-drive it in
  a continuation under a FRESH `jobId` (the claim makes a duplicate safe). A
  stale `attempting` or orphaned `reconciling` record: the existing plan
  above (takeover into `send.reconcile`). A terminal record: close the slot
  from it (item 7's rule, read the slot before acting, applies in reverse).
- **A liveness bound.** A large share is legitimately `sending` for minutes
  (about 1 text per second, `app/src/lib/config.ts:302`, plus the 10 s and
  20 s continuations), so "`sending` and old" is not enough. The sweeper
  needs a progress clock - for example the last slot write or the pass
  claim's time - and a bound past which no pass can still be running.
- **Shares that pre-date the record.** A `queued` slot with no record means
  "never sent" only for a pass that ran with the claim in place. A share
  whose pass ran before `feat/send-outcome-reconcile` deployed has no
  records at all, and a slot of it may have been sent. Bound the sweep to
  shares created after that deploy, or close such slots `send_unconfirmed`
  rather than re-driving them.

A SIGTERM-aware fan-out loop (stop at a recipient boundary, re-enqueue the
remainder under a fresh `jobId` before exit) would remove the common case at
its source; the owner sweep is still needed for a SIGKILL or a crash. Both
are recorded as directions in the H-1 issue, not designed.

**retry-send-adoption (2026-09-28).** `feat/retry-send-adoption` (code final
`1b5ddb01`, UNMERGED; anchors at `5a03e20b`) adds a fourth owner kind and a
third item family this sweeper will meet. Status and severity unchanged.
Records: `docs/superpowers/reviews/2026-09-27-retry-send-adoption/code-review/`
(`r1-adjudications.md`, `r2-adjudications.md`, `fw1-report.md`).

**The `retry_send` owner** - one automatic one-to-one 30003 retry attempt
(`app/src/repos/sendAttemptsRepo.ts:63-70`). Its `ownerKey` is
`retry#<conversationId>#<retriedTsMsgId>#<attempt>` (`:177-179`): the
RETRIED row (the one the job names by SID) and the attempt; the chain root is
the `retryRoot` fact, never part of the key. The record partition is
`sendattempt#` plus that key; its sort key is the recipient key - the retried
row's `recipient_contact_id`, else `phone#<participant_phone>`
(`app/src/services/retryChain.ts:48-55`) - hashed when it carries a phone.
The reconcile payload carries the ids and the recipient HASH
(`app/src/jobs/sendReconcile.ts:147-154`); each check re-derives the key from
the retried row and the thread and compares (`:619-640`). A death
mid-attempt is taken over by the SQS redelivery of the owner's own job,
through the gate (`app/src/jobs/retrySend.ts:421-426`; spec R12). What is
left for this sweeper:

10. **A guarded write that throws leaves `attempting`** (guardWrite's ERROR):
    a close after a refusal, a rejection, a deferral cap or a closed window
    (`finish`, `retrySend.ts:651-670`); the record phase after a send
    (`:563-567`; the retry row exists, so the route's `superseded` answers
    first); the deferral's release (`:745-754`), after which the promise is
    still refreshed (`:747`) and the deferred run takes the record over past
    the claim TTL (production backoffs are 60-240 s) or, under a shorter
    backoff (the lane's 10 s), defers and strands; and `handToReconcile`
    (`:806-823`), which leaves an UNKNOWN outcome with no chain and the
    promise unrefreshed.
11. **A death between a record write and its enqueue** (round 1 A-4): the
    hand-off or a takeover, then the check-0 enqueue (`retrySend.ts:815`,
    `:424`, `:508`; the enqueue `:769-772`), leaves `reconciling`;
    `markRedriven`, then the re-drive enqueue (`sendReconcile.ts:1619`,
    `:1631`), leaves `redriven` (item 4's class). Every redelivery of the
    job defers on `reconciling` (`app/src/lib/sendAttemptGate.ts:38`) and is
    deleted. For items 10 and 11 alike: once the promise lapses (at most
    `attemptedAt` + 480 s) the bubble offers Retry, but the route answers 409
    `retry_pending` until `attemptedAt` + 15 minutes
    (`app/src/routes/api.ts:1683-1690`), then lets a press through - a
    second text if the stranded attempt had been accepted. (A backlog that
    runs the checks late shows the same flicker without a crash.)
12. **A re-driven job that declines at step 1 or 3** - the retried row
    missing or not outbound, the conversation missing, a group or phone-less
    (`retrySend.ts:349-366`, `:395-403`, all before the gate) - leaves its
    record `redriven`, which the route reads as `retry_pending` for 15
    minutes. Practically unreachable: the reconcile read both just before
    the re-drive. Steps 4a and 4b close a `redriven` record `done` /
    `refused` (`:687-692`); since round 1 C-1 a close that throws fails the
    delivery and the redelivery re-runs it, so only a PERSISTENT fault
    strands it there - dead-lettered after five receives, paging
    `jobs-dlq-depth` (`fw1-report.md`, "Found, not in the list", item 2).
13. **C-2's job half (round 1 C-2).** A WITHDRAW that fails after the JOB's
    own unresolved close - a second unknown after a re-drive
    (`retrySend.ts:834-852`) or a failed check-0 enqueue (`:773-794`) - is
    never re-applied: the job returns normally, and a redelivery would meet
    the gate's skip on the `done` record (`sendAttemptGate.ts:33`). The row
    keeps its promise, then reads the plain 30003 failure WITH Retry; the
    route still refuses 409 `retry_unresolved` from the record
    (`api.ts:1670-1676`) for its 30-day life (item 15). The reconcile's half
    is fixed: its failed WITHDRAW now fails the check, and the redelivery
    re-applies it through the superseded exit
    (`sendReconcile.ts:1327-1332`, `:528-532`); a persistent fault
    dead-letters there with the record `done` / `unresolved`, which a scan
    of OPEN records will not see.
14. **C-7: a PHONE-keyed attempt whose thread number changed** is
    unaddressable - the re-derived key no longer hashes to the ref
    (`sendReconcile.ts:629-630`), every check logs INFO `owner recipient not
    found` (`:501-509`), the record stays `reconciling` and the promise
    untouched (R1 governs over R4's digest rule; pinned by
    `app/test/sendReconcile.test.ts:3577`). Practically unreachable (round
    2): a one-to-one thread's `participant_phone` is only rewritten for
    relay threads (`app/src/repos/conversationsRepo.ts:2158`).
15. **The TTL residue.** The record's `expires_at` is set only at the claim
    and the re-arm (`sendAttemptsRepo.ts:327`, `:436`), 30 days out
    (`SEND_ATTEMPT_CLEANUP_MS`, `:48`). After that the route's
    `retry_unresolved` refusal rests on the row's `retry_outcome` belt alone
    (`api.ts:1670-1672`), so a lost WITHDRAW (item 13) leaves an unresolved
    row manually retryable - the second text Cameron's Q1 ruling rules out.

**The `retrychild#` family** (spec R7), beside `sid#`, `relaysid#`,
`syssid#` and the media pointers: partition
`retrychild#<conversationId>#<parentTsMsgId>`, sort key the child row's
`tsMsgId`, attributes `provider_sid` and `retry_attempt` (absent on a manual
Retry row) (`app/src/repos/messagesRepo.ts:2102-2114`). Put, unconditioned,
inside the append transaction of every row carrying `retryOf`
(`:2785-2799`); never updated; read by one consistent Query (`:3359-3386`)
from the job's step 4a (`retrySend.ts:461`) and the manual Retry route
(`api.ts:1638`). It carries no `expires_at` - message rows have none - so it
lives with the table. A pointer, never state: a sweeper reads it only as
"this row has a child". Children appended before the deploy have none (no
backfill).

**(FW2/FW3, 2026-09-28) `already_sent` is not a refusal.** A `retry_send`
record closed `done` / `refused` with cause `already_sent` means the retry
text EXISTS: step 4a declines a re-driven attempt whose own retry row is
already appended (`app/src/jobs/retrySend.ts:478-486` at `aae99caa`, the
close `declineBeforeClaim(owner, redriven, ALREADY_SENT_CAUSE, octx)` at
`:480`; only a `redriven` record is closed so), and the retried row's
`retrychild#` pointer for that attempt names its SID. `closeRedriven` has no
`sent` outcome (`app/src/repos/sendAttemptsRepo.ts:159-162`), and nothing
reads `cause` today - a sweeper or a report must not count it as a refusal.

**Fix wave FW1's out-of-list finding 1 (`fw1-report.md`, "Found, not in the
list"): round 1 C-1's shape in SOR's relay code.** Checked at `5a03e20b`. No
new issue: its rung half is item 9 above, and its fan-out twin is added
here. Round 1 C-1 made this branch's pre-claim decline close unguarded
(`retrySend.ts:687-692`): the job has no run-once marker, so a throw there
is a real SQS redelivery that re-runs the idempotent decline. SOR's relay
jobs keep the guarded form:

- the rung's `closeUnlessOwned` (`app/src/jobs/relayRetryLeg.ts:672-722`,
  the guarded `closeRedriven` at `:684-689`), reached before the claim from
  the gate refusals (`:749`), the window gate (`:801`) and the send deadline
  (`:1046`) - item 9;
- the relay fan-out's `closeRedriveRefused`
  (`app/src/jobs/relayFanOut.ts:1680-1719`, the guarded `closeRedriven` at
  `:1697-1699`, documented "never throws"), reached from a re-drive pass
  that cannot run (`:846`, `:860`, `:866`, `:882`, `:1124`, `:1148`,
  `:1494`): a thrown close logs guardWrite's ERROR and skips the member
  (`:1700`), so its record stays `redriven` and its slot as it was - the
  same strand as item 9, not listed before.

The C-1 fix does not transfer as it stands: both jobs still claim the
run-once marker before these closes (`relayRetryLeg.ts:450-459`,
`relayFanOut.ts:829-841`), so an unguarded throw would fail the delivery and
its redelivery - the same jobId - would be suppressed: the same strand plus
a `job failed` line (why SOR kept the rung's close guarded, its FW2
deviation 6). Directions, SOR's call: re-run the decline under a fresh
envelope, the way SOR's own unguarded pre-claim closes reach the unit's
prepare catch and are deferred and carried (`relayFanOut.ts:1871-1881`,
`app/src/jobs/broadcastFanOut.ts:652-659`); or drop the marker for the
claim as the duplicate guard, as `retrySend` now has; else this sweeper's
orphaned-`redriven` re-drive (the suggested fix above). Nothing is sent
either way.

**share-sent-outcome (2026-09-28).** `feat/share-sent-outcome` (share-skip
Branch B, UNMERGED at this writing; spec
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` D1, D9)
reads this sweeper's population and writes none of it. Status and severity
unchanged.

- **The in-flight recipients D1 keeps flagging are this sweeper's
  population.** The composer's "Already sent" flag takes D1's SAFE reading
  (`app/src/services/shareRecipientState.ts:71-77`): a `queued` slot of a
  share still `sending` reads in flight whatever its record says, and a
  `queued` slot of a finished share reads in flight while its `broadcast`
  record exists and does not say the text never went. So a pass that died
  (the H-1 deploy strand above) keeps its unreached recipients flagged -
  the safe side, a hint and never a block - until this sweeper closes them.
  Nothing on the branch moves a `queued` slot: the attempt-ordered slot
  write never moves one (spec D2), and the repair
  (`app/scripts/repair-share-outcomes.ts`) leaves them to this sweeper.
- **A slot the sweeper closes feeds the flag and the labels at once.** A
  sweeper close to `send_unconfirmed` keeps the tenant flagged (Not
  confirmed); a close that proves the text never went (`done` with
  `refused`, `rejected`, `enqueue_failed` or `redrive_refused`) un-flags
  them - D1 reads either from the slot and the record, with no further
  change here.
- **The `already_sent` note above stands** (not repeated). The repair's
  record check reads a `retry_send` record only as unresolved - `done` /
  `unresolved`, or `reconciling` past the reconcile's schedule with no chain
  row - so a `done` / `refused` record with cause `already_sent` never
  decides a slot unresolved: the retry row it names is in the chain the
  repair walks.
