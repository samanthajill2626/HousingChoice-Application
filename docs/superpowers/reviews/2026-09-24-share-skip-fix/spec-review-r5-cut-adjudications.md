# Spec review round 5 (the Branch A cut) - adjudications

Spec v6 @0e600222. Reviewer B continued (`spec-review-r5-cut.md`, 6 findings).
The reviewer confirmed Branch A stands alone and both interim rules hold
against the code (and against SOR's finalize change). No Branch A decision
changed; all six are wording or record-keeping and are folded in.

| # | Finding | Verdict | Change |
|---|---|---|---|
| R5-1 | Section 6 merge points incomplete: `sendMessage.ts` (A's I8 gates vs SOR D3 vs RSW D6), the results-row reason gate (SOR D22), `deliveryReason`'s options/order (RSW), finalize (SOR D16a), SOR's adoption stamping the audit row's `automated` flag | ACCEPT | Section 6 item 3 lists them; SOR's adoption must read A's person's-share record to stamp `automated` - relayed to the SOR planner via Cameron |
| R5-2 | I4 says a seeded row stays checked, but Select all unchecks flagged seeded rows today; the fix went to B though it needs nothing from RSW/SOR | ACCEPT - keep the fix in A | D5: Select all leaves seeded rows checked (one-line dashboard change; avoids a blocked one-to-one Send on a flagged seed). Removed from the B stub |
| R5-3 | G4 promises "a share that texted nobody never reads Sent" while D6 covers all-skipped shares only | ACCEPT (wording) | G4 reworded to D6's scope. REJECTED widening D6 to failed-before-send closes: Branch B derives labels from every outcome; A stays minimal |
| R5-4 | RSW's spec still assigns reading `retry_due_at` on the share results row to share-skip-fix; the move to B is unrecorded | ACCEPT | Split record notes the move; relayed to the RSW planner via Cameron |
| R5-5 | The split record's RSW-requirements mapping is incomplete against SOR revision 6 section 2a (#6, #7 in Stage 1; #4 with the adoption) | ACCEPT (as reported; SOR rev 6 UNVERIFIED by the planner) | Split record updated and marked as SOR's document to maintain |
| R5-6 | Tracking gaps: SOR section 9 says A "may land" the 30003 slot update (it is B's); two v5 residuals have no home (retries with no lineage write; the retry-wait double-text window); the B stub's "no pending state" should be undecided now that RSW records `retry_due_at` | ACCEPT | B stub gains both residuals and lists the pending-state question as undecided; split record notes the SOR issue assignment - relayed via Cameron |

Contested adjudications: none. Review of Branch A closed; to Cameron's gate.
