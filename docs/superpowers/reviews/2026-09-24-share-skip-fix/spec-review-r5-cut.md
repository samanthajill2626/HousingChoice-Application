# Spec review r5 (reviewer B) - the Branch A / Branch B scope cut

## What was reviewed

- **Branch A spec** (v6, 0e600222):
  `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md`.
- **Branch B stub** (checked only for what was lost):
  `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`.
- **Split record:**
  `docs/superpowers/reviews/2026-09-24-share-skip-fix/branch-split.md`.
- **Sibling specs** (read-only):
  - RSW: `W:\tmp\retry-send-window\...\2026-09-24-retry-send-window-design.md`
    (draft 6).
  - SOR: `W:\tmp\send-outcome-reconcile\...\2026-09-24-send-outcome-reconcile-design.md`
    (revision 6).
- **Baseline for "was anything dropped":** v5 (3a6a1a06).

Every claim was checked in the code (read-only) or cited from those documents.
File paths are relative to the share-skip-fix worktree (`W:\tmp\share-skip-fix`);
paths starting `app/` or `dashboard/` are code.

## Decision impact

**No Branch A decision has to change.**

- F1 extends the merge-point list in section 6 item 3.
- F2 and F3 can each be closed by one line of wording (I4, G4). A small rule
  change is the alternative in each case, and it is the planner's choice.
- F4-F6 are record-keeping in the split and sibling documents.

## Charge 1 - does Branch A stand alone?

**Yes.** Every decision is buildable and testable with nothing from RSW or SOR:

- D1-D3 and D9 are the census, the fix script, the import default and the
  RUNBOOK.
- D4 is the creation-time record plus the send job reading it.
- D5 filters today's union by slot status (repos/broadcastsRepo.ts:524-550).
- D6 is a presentation label derivable from the stats buckets.
- D7 covers reasons, copy and buckets.
- D8 is the composer default.
- The section 7 cases can all be produced on the hermetic stack as it is today:
  - a skipped staff-share recipient comes from the consent fence on a filter
    blast, or from I8's recipient deletion check on a seeded recipient;
  - a failed one comes from the fake's `fail` profile.
- No retry copy, attempt record or ledger semantics is touched. D7 explicitly
  leaves 30003's wording alone.

**The interim rules are safe and independent.**

- A `skipped` slot is written only on paths that never reach the provider:
  - the first fence (jobs/broadcastFanOut.ts:381-390);
  - the consent fence (:397-407);
  - wrapper refusals, which are all thrown before the provider call
    (services/sendMessage.ts:286-367; fan-out catch at broadcastFanOut.ts:491-503).
- So un-flagging a skipped recipient can never un-flag a tenant who received the
  text.
- SOR adds no slot status (SOR D10). Its `failed` + `send_unconfirmed` therefore
  keeps counting under D5 - the safe direction, as SOR's section 2a item 1 says.
- SOR's new finalize rule (SOR D16a) still stores an all-skipped share `sent`, so
  D6's label keeps applying after SOR merges.

**Leftover RSW, SOR or Branch B material in Branch A:** none, except the
contradiction in F2.

## Charge 2 - the interim rules against the code

- **D5 is verified.**
  - Today's share-status filter is `sent | sending` (broadcastsRepo.ts:537); D5
    keeps it and adds a slot filter.
  - Its allowlist ("queued, sent, delivered or failed") and its denylist
    ("skipped never counts") describe the same set over today's five statuses,
    and SOR adds none. Two builders build the same thing.
- **"Corrects history" holds.** The diagnosis record gives Sam's tenant four
  one-to-one shares, finalized `sent`, with every slot `skipped` and no ledger
  rows (docs/superpowers/reviews/2026-09-24-share-skip-fix/diagnosis.md:22-30).
  The rule reads stored slots at preview time, so from deploy those three
  properties stop flagging the tenant.
- **D6 is verified.** An all-skipped share finalizes `sent`, because finalize
  marks a share failed only when every recipient failed
  (broadcastFanOut.ts:690-693). "Every recipient skipped" can be derived from the
  list's stats (the skip buckets sum to the audience), so the list's live overlay,
  which carries stats, can apply it (dashboard/src/routes/broadcasts/useBroadcastsList.ts:114-124).
- **Seeded rows and Select all:** not quite "unchanged". See F2.

---

## F1 [MEDIUM] Section 6's merge points are real but incomplete for Branch A's surfaces - sendMessage.ts above all

**What is right.** The four named points are real, and SOR and RSW confirm them:

- the stats buckets and the StatChips balance rule (SOR D22);
- the internal-code reason map (SOR D23; RSW D8's "Not retried - message too
  old");
- the fan-out's send call and first-fence skips (SOR D7a);
- the seed broadcast fixtures (SOR section 2 and D22).

**What is missing.** Four surfaces Branch A edits, and a sibling edits too:

- **`app/src/services/sendMessage.ts` - the highest risk.**
  - Branch A's I8 moves the consent and deletion judgments for fan-out sends
    from the phone-first contact to the recipient contact. That changes the gates
    at sendMessage.ts:307-344, or the input that feeds them.
  - SOR D3 re-types exactly that pre-provider section - "the conversation read,
    the contact read, the breaker increment" - and its post-append failures
    (SOR spec, D3).
  - RSW D6 adds lineage fields to the same input and append path (RSW spec, D6).
    RSW D3a also previews "the send path's" deletion and suppression gates for its
    retry decision.
  - The split record lists sendMessage.ts as a shared file
    (branch-split.md:18-21), but neither its merge-point list (:53-55) nor
    section 6 names it.
  - Neither sibling spec expects Branch A to edit it. RSW section 5 still lists
    v5's `retrySend.ts` / `api.ts` edits, and SOR section 2a item 1 lists only
    stats and codes.
- **The share results row's presentation.**
  - Branch A's D7 shows a reason on skipped rows. Today the badge shows one only
    when `isFailure` is true (dashboard/src/routes/broadcasts/DeliveryBadge.tsx:30-31),
    and a skipped row is presented as a bare "Skipped"
    (dashboard/src/routes/broadcasts/broadcastFormat.ts:98-100).
  - SOR D22 edits the same gate - "the badge shows a reason for this code even
    though `isFailure` is false" - and adds a "Not confirmed" row with no retry
    link.
- **`deliveryReason`'s options and check order.** Branch A's D7 needs
  share-row-only wording for `contact_opted_out`. RSW D8 adds a `retryScheduled`
  option that is checked ahead of the media and base maps, and rewrites the base
  30003 entry. More than one entry in the map changes here: the order rule does
  too.
- **finalize.** Branch A's D7 changes finalize's log line
  (broadcastFanOut.ts:697-700). SOR D16a rebuilds finalize: idempotent, a
  consistent read, and a new stored-status rule.
- **SOR's adoption re-creates what the wrapper would have written, including its
  audit row** (SOR D15). After Branch A, that row's `automated` value depends on
  the person's-share record. D9's runbook reads it to explain a breaker trip.

**Why it matters.** Branch A lands first, so RSW and SOR carry every merge. Their
planners work from section 6 and the split record. A semantic loss in any of
these places is caught only if Branch A's tests pin the behavior: I8's
duplicate-phone case, skipped-row reasons, the finalize log.

**Implies.** Add these four surfaces, and the audit-row note, to section 6 item 3
and to the split record's merge-point list.

---

## F2 [LOW] I4 still promises that seeded rows stay checked, which the cut's D5 no longer delivers

**What is wrong.**

- D5 (v6) says the review list is otherwise "unchanged" and "'Select all' keeps
  skipping flagged rows".
- Today Select all unchecks EVERY flagged row, seeded ones included
  (dashboard/src/routes/broadcasts/RecipientPreview.tsx:149-155).
- I4 (v6) still says "a seeded row stays checked". That is v5's wording from the
  R3-6 fix, which the cut moved to Branch B (B stub D5(a)).

**Consequence.** In the one-to-one flow, a flagged seeded tenant (after a failed
share, which D5 keeps flagging) is unchecked by Select all. That triggers the
resolved-mode Send block (RecipientPreview.tsx:119-124, 455-461).

**The fix does not need to wait for Branch B.** It depends on nothing RSW or SOR
change. Either keep it in Branch A (a small rule change to D5), or drop "stays
checked" from I4 until Branch B.

---

## F3 [LOW] G4 promises more than D6 delivers

**What is wrong.**

- G4 says "a share that texted nobody never reads 'Sent'". D6 gives "Not sent"
  only to an ALL-SKIPPED share, and "every other share keeps today's label".
- Recipients can also fail without being texted:
  - `no_contact` is recorded `failed` before any send
    (broadcastFanOut.ts:366-377);
  - the cap and enqueue closes mark unsent recipients `failed`
    (broadcastFanOut.ts:274-311).
- So a share with some skipped recipients and some failed-before-send ones -
  nobody texted - finalizes `sent` (broadcastFanOut.ts:690-693) and still reads
  "Sent" on Branch A.
- SOR's finalize rule later stores such a share `failed` (SOR D16a). Branch A
  alone does not deliver G4.

**Implies.** Either scope G4 to "every recipient skipped", or widen D6 to "no
recipient was texted". The planner's choice; both are independent of RSW and
SOR.

---

## F4 [LOW] RSW's spec still assigns the share row's `retry_due_at` read to feat/share-skip-fix, and the split record does not reassign it

**What is wrong.**

- RSW says three things about the share results row:
  - D8: reading `retry_due_at` for the share row "belongs to
    feat/share-skip-fix's results path, which already reads that message";
  - section 5: that branch's table "follows D8's rule instead";
  - section 7: "until share-skip-fix reads `retry_due_at`, that row shows no
    promise".
- `feat/share-skip-fix` is now Branch A. Branch A disclaims "every 30003 wording
  and retry promise" (section 2, non-goals) and has no path that reads the
  message. In code, the results route reads contacts only.
- The B stub does carry it: "its 30003 copy follows RSW's rule (a promise only
  while `retry_due_at` is live)".
- The split record never says the requirement moved from share-skip-fix to Branch
  B.

**Consequence.** The interim is safe (RSW: "under-promising, never false"). But
an RSW or SOR planner reading RSW's text will expect it of Branch A.

**Implies.** Record the reassignment in the split record.

---

## F5 [LOW] The split record's list of RSW requirements on SOR is incomplete

**What is wrong.**

- The split record says RSW #1 and #5 bind SOR Stage 1, and #2 and #3 move with
  the retrySend adoption (branch-split.md:40-46).
- SOR revision 6 section 2a carries more:
  - Stage 1 also carries #6 (RSW's window close follows SOR's D8 close gate,
    window checks before the claim, a possible `window_closed` outcome) and #7
    (both branches' special cases in the retry join's terminal step);
  - the adoption also carries #4 (the promise copy follows `retry_due_at`).
- The split record is the sequencing authority Branch A cites. It should match.

---

## F6 [LOW] Issue and stub bookkeeping around the cut

- **SOR's filing text contradicts the split.** SOR section 9 says "share-skip-fix's
  Branch A may land them first: the `no_contact` copy and the
  broadcast-30003-retry slot update". The split record assigns the slot update to
  Branch B (branch-split.md:51-52). Branch A does fix the `no_contact` copy (D7
  table row "No contact or phone on file"). Branch A does NOT do the slot update.
  If SOR's builder skips filing it because "Branch A merged", the gap goes
  untracked until B, and B's stub then "closes" an issue that was never filed.
- **v5 residuals dropped without a home.**
  - The repair's accepted blind spot: a historical automatic retry whose lineage
    annotate never landed. The lineage is written in a separate post-send write
    (app/src/jobs/retrySend.ts:221-229); RSW D6 fixes that only going forward.
  - The accepted double-text window during a retry backoff.
  - Neither is in the B stub or an issue.
- **A stale premise in the B stub.** The stub keeps "No 'pending retry' state".
  That rule's premise was "nothing records a pending retry" (round 2, R2-1). RSW's
  `retry_due_at` now records one, with an expiry (RSW D7). Whether a live
  `retry_due_at` counts as "on its way" belongs in the stub's "Not decided" list,
  so the rewrite considers it.

---

## Contested adjudications

None. The round-4 adjudications stand, and so does the split's safe-direction
rule for `failed` (verified above).

---

## Are the split's claims correct?

| Claim | Verdict |
|---|---|
| "Failed keeps counting - compatible with SOR's unconfirmed state by construction" | Correct (SOR D10, SOR section 2a item 1). |
| "'Not sent' only for an all-skipped share" works after SOR's finalize change | Correct (SOR D16a stores an all-skipped share `sent`). |
| The SOR adjustments: retrySend adoption deferred; ledger row and milestone only on a sent/delivered adoption | Correct (SOR section 2a; SOR D15). |
| The textual merge points | Real but incomplete (F1). |
| The RSW requirement mapping | Incomplete (F5). |
| The lean-seed coordination with RSW | Correct (RSW section 5 bullet 4; Branch A section 5). |
| The tenant-timeline milestone issue | Filed (docs/issues/tenant-timeline-property-sent-milestone-after-failed-delivery.md) and cited by Branch A's D10. |
