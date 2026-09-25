# Branch split: share-skip-fix A/B and the sequencing with RSW and SOR

Date: 2026-09-25. Decided by Cameron after the three planner agents
(share-skip-fix, `feat/retry-send-window` = RSW, `feat/send-outcome-reconcile`
= SOR) each checked the others' specs.

## Why

Spec v5 (`3a6a1a06`) redesigned "counted as sent" across retries, the
listing-send ledger, the activity count and share labels. That object is
shared with two branches at their own spec gates:

- SOR's per-recipient send-attempt record (its D8a) is the same "attempt" v5
  recorded against the share; built independently, one recipient would carry
  two disagreeing records. SOR's forward-only slot writes and its adoption path
  assume the pre-v5 rule; SOR's `failed` + `send_unconfirmed` means "unknown",
  which v5 would have read as "not sent" and re-proposed (the double text SOR
  exists to prevent); SOR's adoption wrote the ledger row even when adopting as
  failed. Shared files: `broadcastFanOut.ts`, `broadcastsRepo.ts` (both add a
  stats bucket), `deliveryStatus.ts` (both add codes), `sendMessage.ts`, the
  seed broadcast fixtures. SOR fences `webhooks/twilio.ts`; v5 needed its rollup.
- RSW carries Cameron's ruling that a declined retry shows as a plain failed
  attempt and that "will retry" appears only while a retry is scheduled
  (`retry_due_at`). v5 promised from the retry count and added "retries
  exhausted". RSW's 409-while-pending removes v5's accepted staff-Retry overlap.
  Both edit `retrySend.ts` and the retry route; both plan the same backoff seam.

## What was agreed

- **Branch A** (`feat/share-skip-fix`, now, independent): census, fix script,
  import default, RUNBOOK; staff shares as person's sends; reasons and honest
  counts; "Already sent" stops counting SKIPPED recipients only (failed keeps
  counting - safe direction, compatible with SOR's unconfirmed state by
  construction); "Not sent" only for an all-skipped share; the #4 default text.
- **Then RSW, then SOR Stage 1**, SOR planned against merged RSW. SOR
  adjustments (SOR agent): defer the `retrySend` adoption out of Stage 1; the
  adoption writes the ledger row and milestone only when adopting as
  sent/delivered; SOR's plan is written after RSW merges and files its Stage 2
  issues meanwhile.
- **RSW's section 5 requirements on SOR**: #1 (a re-driven relay rung passes
  the job-time window check) and #5 (a retry's throttle wait is a hard stop at
  15 minutes, never "retryable") bind SOR Stage 1; #2 and #3 (retry lineage and
  origin on an adopted 1:1 retry row; `retry_due_at` refreshed while a 1:1
  retry is pending) move with the `retrySend` adoption. Correction owned by
  the share-skip-fix planner: SOR's records did not list RSW's requirements;
  RSW's spec lists requirements on SOR.
- **Then the `retrySend` adoption and Branch B**
  (`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`, a stub
  carrying v5's deferred decisions), rewritten and reviewed against the merged
  code, on SOR's attempt record.
- Issues: SOR files only what is still open at filing time, so Branch A's
  `no_contact` copy fix and Branch B's slot-update fix are not double-filed.
- Textual merge points for whoever lands second: `deriveBroadcastStats`,
  StatChips' balance rule, the internal-code reason map, the fan-out's send
  call and first-fence skips, the seed broadcast fixtures.
