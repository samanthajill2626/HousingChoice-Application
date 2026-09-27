---
id: send-reconcile-job-residues
title: The send.reconcile job's own residues as built - a lost audit row, an adoption filed under a changed number, three accepted ordering windows, noisy or permanent failures
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-27
updated: 2026-09-27
refs: app/src/jobs/sendReconcile.ts:205, app/src/jobs/sendReconcile.ts:459, app/src/jobs/sendReconcile.ts:490, app/src/jobs/sendReconcile.ts:628, app/src/jobs/sendReconcile.ts:639, app/src/jobs/sendReconcile.ts:642, app/src/jobs/sendReconcile.ts:687, app/src/jobs/sendReconcile.ts:886, app/src/jobs/broadcastFanOut.ts:1295, app/src/jobs/broadcastFanOut.ts:1361, app/src/jobs/broadcastFanOut.ts:1381, app/src/repos/messagesRepo.ts:4016
---

**Problem.** `feat/send-outcome-reconcile` built the `send.reconcile` job
(`app/src/jobs/sendReconcile.ts`) and the broadcast adoption it calls
(`adoptBroadcastRecipient`, `app/src/jobs/broadcastFanOut.ts:1279-1417`). The
build recorded these residues of the job itself (build S3a residues 1-3 and
6-10, with the S3b mutant pass's note on residue 6; line numbers at the
branch's HEAD). None can text anyone twice; each is bookkeeping, ordering,
presentation or noise. Grouped because they share one job and one fix surface.

1. **A lost audit row.** An adoption that dies between its row append
   (`broadcastFanOut.ts:1304-1319`) and its slot write (`:1341-1353`) loses
   the conversation's `message_sent` audit row: the retry's append dedupes on
   the SID, and the audit row is written only for a fresh append
   (`:1358-1371`).
2. **An adoption filed under a changed number.** A known-SID broadcast
   adoption whose row was never appended (a `SendAcceptedNotRecordedError`)
   files the row by the contact's CURRENT phone (`:1289-1295`), and the
   known-SID path skips the digest check (spec D12), so a number change between
   the send and the adoption puts the row in the new number's 1:1
   conversation. The only wrong-conversation risk the build found; it needs a
   number change inside the reconcile window (checks at about 5 s, 30 s and 4
   minutes after the attempt) on a send that landed unrecorded.
3. **A legacy relay re-run reports `adopted`.** The legacy adoption statement
   accepts the target status as its own prior
   (`app/src/repos/messagesRepo.ts:4016-4076`, the priors at `:4056`), so it
   cannot tell a same-status rewrite from a move; a redelivered adoption
   re-emits `message.persisted` and re-WARNs a terminal failure
   (`sendReconcile.ts:642-657`). Harmless: the writes are idempotent and the
   dashboard only refetches.
4. **A contact member off the roster is ruled `digest_mismatch`.** The
   lookup's current number is the roster member's phone, else a `phone#` key's
   own number (`sendReconcile.ts:490-505`); a contact member who has left the
   roster has neither, so the check closes `unresolved` with cause
   `digest_mismatch` (`:735-738`) rather than reading the contact. The
   conservative direction - never a re-send; only the logged cause is
   imprecise.
5. **Three ordering windows, accepted (build ruling A10).**
   - The inbox touch is read-then-write: the adoption compares
     `last_activity_at` and then writes it with an unconditional SET
     (`broadcastFanOut.ts:1375-1386`; the rung's `touchInboxForward`,
     `sendReconcile.ts:687-697`), so an inbound touch landing in between can be
     moved backwards and the inbox order regresses (build finding T10-12).
   - A relay receipt that lands after the adoption's pointer claim
     (`sendReconcile.ts:628`) and before its slot write (`:633-638`) finds the
     pointer and is applied by the webhook; the adoption then reports
     `skipped` (still `found`) and the slot ends without the adopted `sid` and
     `sentAt`. Spec D15 accepts only the window between the status read and
     the pointer write; this second one is accepted too (build finding T10-13).
   - The roster read behind the digest check and the re-drive pre-check is
     eventually consistent: `conversationsRepo.getById` has no consistent
     variant (`sendReconcile.ts:459`), so the member phone the digest compares
     and the group status and membership the pre-check reads (`:990-997`) can
     be stale - safe for the pre-check (the re-drive pass re-reads and
     re-filters), weaker for the digest (build finding T10-7).
6. **Duplicate chains, duplicate ERRORs.** Two duplicate check chains that
   both pass the state check before either closes each log their own
   `unresolved` ERROR (`sendReconcile.ts:886-891`). Only one record close lands
   (the other line carries `recordClosed: false`), but one recipient can put
   two ERROR lines toward the error-log alarm.
7. **A relay adoption onto a missing row or slot throws**
   (`sendReconcile.ts:639-641`). On SQS that is a genuine retry that ends in
   the DLQ with the record still `reconciling`; on the hermetic lane, or any
   stack without `JOBS_QUEUE_URL`, the in-process dispatch is never
   redelivered, so the chain dies at once (build finding T10-11). The pointer
   claim (`:628`) lands before the throw, so every retry re-finds its own
   pointer and throws again, leaving a `relaysid#` pointer to a row that does
   not exist (build S3b note). Unreachable in practice: relay rows are never
   deleted. The record it leaves is
   [send-attempt-sweeper](./send-attempt-sweeper.md)'s to find.
8. **A malformed payload is retried, not dropped.**
   `parseSendReconcilePayload` throws (`sendReconcile.ts:205-219`), so a
   malformed envelope fails five times and reaches the DLQ instead of being
   deleted as poison - the same as the other handlers' parse throws.

**Suggested fix.** Optional, and each separate: write the audit row
idempotently, keyed on the SID, so a retry can re-attempt it without a
duplicate - a row the send wrapper appended was already audited (1); file a
known-SID
adoption's row by the number the provider sent to rather than the contact's
current phone (2); an atomic inbox guard needs a conditional touch in the
conversations repo (5, first bullet); log the `unresolved` ERROR only from the
chain whose record close landed (6). The rest are accepted as they stand.

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md),
[accepted-send-lost-when-append-fails](./accepted-send-lost-when-append-fails.md),
[status-callback-passive-match-for-pending-reconcile](./status-callback-passive-match-for-pending-reconcile.md),
[relay-fanout-closes-emit-nothing](./relay-fanout-closes-emit-nothing.md).
