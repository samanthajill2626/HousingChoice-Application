# Planner's independent review - adjudications

Date: 2026-09-28. Branch `feat/share-sent-outcome`, handback a33e0d7f (code
final e824a452). Two read-only reviewers dispatched by the planner after the
handback: spec conformance (`planner-review-conformance.md`: 92 items, 89
CONFORMS / 3 PARTIAL / 0 MISSING; 8 items to adjudicate) and plan-blind
adversarial (`planner-review-adversarial.md`: 0 CRITICAL / 1 HIGH / 1 MEDIUM /
8 LOW). The planner's own gates on the handback tree: typecheck EXIT=0, npm
test EXIT=0 (399 / 210 / 21 / 34 / 13 files, no `[dynamoAdmin]` line), smoke
EXIT=0, eslint EXIT=0 over 72 files, e2e - see the verdict.

Every finding is a claim: ACCEPT (a fix, a doc, or a named residual), REJECT
(with the reason), or FILE. Severity labels are the reviewers'.

## Conformance items

1. **D1/D6 wording conflict (PARTIAL D1.2).** ACCEPT as a SPEC ERRATUM, no
   code: D6 is the gated rule and shipped verbatim; D1's list of strict
   readers named the milestone wrongly. D1 is reworded (the planner's edit,
   committed with the verdict). Cameron confirms at the merge.
2. **D8.6 - the repair writes a `failed` entry over a legacy counted entry
   for a 30003 slot whose retry it cannot see (empty chain), un-counting a
   pair the unseen retry may have reached; the spec promised such rows are
   left alone.** ACCEPT - FIX (small, contained): for a failed-30003 slot
   with an EMPTY chain the repair writes NO ledger entry (the row stays as it
   is; the live D1 rule reads the slot past its bound either way). Test:
   a legacy counted row under such a slot keeps `counted: true`. RUNBOOK
   step 1 names the class.
3. **E2E (a)'s "will retry" copy is pinned by the unit test, the API poll and
   self-QA, not end to end.** ACCEPT as a DECLARED deviation (it was the plan's
   own choice, T14; round 1's G4 accepted it): added to the handback's list.
4. **G1 - the repair's `counted: false` rows change the words of existing
   milestones for never-reached pairs.** CONFIRMED as intended (D6 needs the
   memory; the readers and the index skip the row).
5. **Handback wording - the three issues already read `status: resolved`.**
   ACCEPT: the sentence is corrected.
6. **D7 erratum - "pending with its due" contradicts I5.** ACCEPT: the spec's
   D7 writer bullet is reworded (no due on an entry; the code follows I5).
7. **D6 edge - a share-id milestone with no entry on an existing row falls
   back to the pair rule.** ACCEPT and DECLARE (the plan's T12 said so; the
   spec's D6 gains the sentence).
8. **Gates.** The planner's own run, above.

## Adversarial items

1. **[HIGH] A retry's acceptance is never written to the slot; if every
   callback for it is lost (a lost callback, the unknown-SID drop, a bounded
   write that gave up, a no-slot miss), the slot reads a final failure after
   24 minutes and the tenant is un-flagged.** REJECT as a defect of THIS
   branch: spec D2 says verbatim that a retry's mere acceptance is written by
   nobody and the slot learns a retry from its carrier confirmation or its
   terminal receipt, and I7 fences the retry job (a slot write at the job's
   acceptance is the alternative the spec declined). The residual is REAL and
   was filed (`share-retry-rollup-lost-past-reread-bound`); the reviewer's
   framing widens it to every lost-callback path, and the frequency is low:
   both the `sent` confirmation and the terminal receipt must fail to route
   (Twilio's callbacks are reliable; the unknown-SID drop needs a receipt to
   outrun the adoption's append). The RUNBOOK's re-run triggers gain the
   webhook's unknown-SID drop line (item 2), so the repair closes what
   callbacks miss. Named in the verdict for Cameron with the frequency.
2. **[MEDIUM] The four "no matching recipient slot - a routing bug" ERRORs
   can fire without a bug (a queued slot has no `tsMsgId` while the fan-out's
   record-phase write waits on the reconcile); neither those lines nor the
   unknown-SID drop are on the RUNBOOK's re-run list or in its query.**
   ACCEPT - FIX (small): the miss logs WARN when the share holds a slot for
   the row's conversation without a matching original pointer (the record
   phase pending, or a chain the repair has not stamped) and ERROR only when
   no slot of the share names the conversation at all; both lines and the
   webhook's unknown-SID drop join the RUNBOOK's re-run list and its Logs
   Insights query. Test: the WARN case at the webhook.
3. **[LOW] A silently lapsing promise emits nothing; the list reads Sending
   until reload.** ACCEPT as designed (spec D4's accepted staleness: "the
   list is a summary, and the results page ticks").
4. **[LOW] The composer flag's record reads: one per queued slot of every
   finished share of the unit, 30 days; a route-failed 1000-slot share costs
   1000 null reads per preview.** ACCEPT as priced (spec D1: strands only, so
   rare; the 30-day life bounds it). Named in the verdict's residuals.
5. **[LOW] `markShareUnconfirmed` makes one unbounded write at the job's
   arms; it runs before the record close.** ACCEPT - FIX (small): the job's
   arms call `applyLaterAttemptBounded` inside `guardWrite` (the same bound
   as every other site). The order (before the close) is the spec's (D2,
   deviation 11); a lost close is resolved by the takeover's reconcile, which
   supersedes or leaves the safe state - a residual on the safe side.
6. **[LOW] `unconfirmedKeys` only in the routes, not the emits.** ACCEPT as
   filed (`share-list-sse-patch-rebucket-and-refresh`).
7. **[LOW] The filter tabs go by stored status, the pills by bucket.** ACCEPT
   as designed (spec D4: "the status filter tabs and the stored status are
   unchanged"); named for Cameron as a UX wrinkle to decide later.
8. **[LOW] The repair re-pages each slot's conversation with no reuse; the
   RUNBOOK's cost estimate is unmeasured.** ACCEPT as named: Cameron's dev
   census measures it; the RUNBOOK says so.
9. **[LOW] `RETRIED_ERROR_CODE` is not the one copy (the fenced decision
   keys on the literal); `STALE_RECONCILING_MS` hard-codes index [2].**
   ACCEPT - FIX (trivial): the repair reads the LAST reconcile delay like the
   service; the fenced file stays as it is (I7).
10. **[LOW] The cap drop (1500 -> 1000) is visible to staff and noted only
    in the RUNBOOK's repair section.** ACCEPT: Cameron approved it at the
    spec gate; the handback's obligations and the RUNBOOK's general share
    section name it.

## The planner's fix wave (one implementer, then the touched suites, then the verdict)

Code (with tests): repair - no ledger write for an empty-chain failed-30003
slot; the `no_slot` WARN/ERROR split at the webhook and the reconcile sites;
the job's arms through `applyLaterAttemptBounded`; the repair's stale bound
from the last reconcile delay. Docs: RUNBOOK (the re-run list + query, step
1's class, the cap), the handback (the issues sentence, two declared
deviations, the residuals), the spec (D1 done; D7's due wording; D6's
fallback sentence).

Filed: nothing new (the residuals already have issues).
