# Counted as sent: retries, the ledger and share labels - design (Branch B, stub)

Date: 2026-09-25. Status: STUB - decisions carried over from the pre-split
share-skip-fix spec (v5, commit `3a6a1a06`, four adversarial review rounds);
NOT re-reviewed, NOT planned. Branch and worktree: to be cut when its
prerequisites merge. Records of the rounds that produced these decisions:
`docs/superpowers/reviews/2026-09-24-share-skip-fix/` (spec-review-r1..r4 and
their adjudications, and `branch-split.md`).

## Prerequisites (agreed sequencing, 2026-09-25)

1. Branch A (`feat/share-skip-fix`) merged.
2. `feat/retry-send-window` (RSW) merged: the retry window, `retry_due_at`,
   the manual Retry guard, the 30003 copy rule.
3. `feat/send-outcome-reconcile` (SOR) Stage 1 merged: the per-recipient
   send-attempt record, the reconcile job, `send_unconfirmed`.
4. The `retrySend` adoption into SOR's model (deferred out of SOR Stage 1),
   carrying RSW's section 5 requirements #2 and #3.

This spec is then REWRITTEN against that code before it is reviewed: its
"attempt" is SOR's send-attempt record, never a second one, and its 30003
copy follows RSW's rule (a promise only while `retry_due_at` is live).

## Decisions carried over (to be re-verified against the merged code)

- **D5. One "counted as sent" rule.** A share recipient's outcome follows their
  attempts (the original text, an automatic 30003 retry, a staff Retry), and
  every attempt belongs to the share that started it. A recipient counts as
  sent when any attempt delivered, or when the newest attempt is queued (share
  still `sending`) or handed to the carrier; never when skipped or when every
  attempt failed. No "pending retry" state: a retry that never sends is not an
  attempt. Attribution is by the attempt retried, never by conversation. The
  per-recipient record is bounded (newest attempt plus a delivered flag). Open
  from the split: how `failed` + `send_unconfirmed` (SOR) counts per surface -
  flag as already sent (safe), do not count in the ledger.
- **D5(a).** The review list follows the rule. (Branch A already owns the
  seeded-row behavior: a hand-picked tenant is a seed from the moment they are
  added, and "Select all" keeps seeded rows checked.)
- **D5(c).** The property activity entry ("Sent to N tenants") counts only
  counted recipients, derived at render time (one share read per entry, bounded
  by shares per property; the landlord timeline inherits the bound).
- **D5(d).** The results row shows the outcome that decides the count; 30003
  wording per RSW.
- **D5(e).** Share labels derive from recipients: Draft / Sending / Sent / Not
  sent, first match wins; the stored failure alert is suppressed only on
  "Sent"; a queued slot of a share that is not `sending` presents as "Not sent".
- **D6. The listing-send ledger follows the rule**, judged from carrier
  acceptance (it lags the queued window by the send pacing - the one stated
  exception). A pair stops counting when no share of it counts; a newly sent
  attempt or a new share re-counts it; a counted pair describes its latest
  counted share (date and id - the "Properties sent" order and the tour form's
  default property). Order-independent against the carrier callback. Direct
  lookup, no per-row join (Amendment No. 1 matching reads it at scale). SOR's
  adoption writes the row only when it adopts as sent or delivered (agreed).
- **D6 repair.** A dry-run-first, Cameron-run post-deploy pass, immediately
  after deploy and before the first blast: un-counts ledger rows the rule no
  longer counts and records historical retry attempts against their shares
  from message retry lineage, under D2-style conditional writes that never
  erase a live delivery or a post-deploy attempt. Its census sizes both.
- **I9.** A recorded outcome leaves `failed` only through a newly sent attempt
  (or the repair, once); a recorded delivery is never erased; per-attempt
  delivery stays forward-only.
- **Dev seam.** The one-to-one retry backoff override (`E2E_SEND_RETRY_BACKOFF_MS`)
  - RSW builds it; reuse.
- **Issue to close here:** the tenant-timeline "Property sent" milestone after
  a failed delivery (filed by Branch A); SOR's "broadcast 30003 retries never
  update the broadcast slot" if still open.

## Residuals carried from v5 (accepted there; re-decide here)

- A pre-branch automatic retry whose lineage write never landed (a crash
  between send and annotate) is invisible to the repair; accepted in v5.
- During a retry's backoff a recipient reads not sent and a second share can
  text them twice; v5 accepted the window. RSW's 409-while-pending narrows it
  for staff Retry; the re-share case remains.
- Reading `retry_due_at` on the share results row: RSW's spec (D8, sections 5
  and 7) assigns it to share-skip-fix; after the split it is THIS branch's.

## Not decided (for the rewrite)

- Whether SOR's attempt record needs the "any attempt delivered" fact or the
  rule can be derived from its outcomes and the message lineage.
- The per-surface rule for `send_unconfirmed` (above).
- Whether "no pending-retry state" survives: v5 dropped it because nothing
  recorded a pending retry; RSW's `retry_due_at` now does, so a failed slot
  with a live `retry_due_at` could count as on its way.
- Whether the property activity count is worth its read cost once labels
  derive from recipients.
