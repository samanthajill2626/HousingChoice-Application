# Code review round 2 - adjudications (orchestrator)

Branch feat/join-housing-authority @d7cbbab3 (code tip 514538d2 after fix wave 1).
Report: `R2-review.md` (fresh reviewer; hunted misses and the fix diff before reading the
round-1 records). Result: 0 MEDIUM+, so nothing reopens by the closing rule; all six
fix-wave-1 fixes verified real (mutant copies run against the real tests through a
throwaway alias config - the in-place mutation was refused by the permission classifier).
Gates at d7cbbab3 while R2 ran: e2e run2 (E2E_TRACE=1) EXIT 0, 340 passed (24.4m) - the
run1 blank-document failure did not recur.

| Id | Sev | Disposition |
|---|---|---|
| R2-F1 | LOW, fix-diff | FIX (micro wave). The R1-ADV-4 range I adjudicated (0-31, 127-159) was too narrow: bidi overrides/isolates, zero-width and line/paragraph separators still print raw and can visually reorder a report line, including the contactId the operator copies into `--skip`. Escape Unicode categories Cc, Cf, Zl, Zp. My adjudication's range was the defect; the fixer had flagged it. |
| R2-N5 | INFO | FIX (micro wave, RUNBOOK wording): "never an overwrite" overstates - the suggest-over-held-value rule is the extraction PROMPT's (`extraction/prompt.ts:35-39`), not a code guarantee (`extraction/apply.ts:290-305`). Reword to what is true. |
| R2-N3 + R1-ADV-1 comment ask | INFO | FILED: `docs/issues/public-rate-limit-key-spoofable-xff.md` now also lists the new "per-IP" comments (public.ts list router, app.ts mount comment, publicOrgList.ts) to correct when the key is fixed; the comments describe the intended key, which is the shared resolver's job. No code change on this branch (a comment-only code commit would cost a full gate re-run for no behavior). |
| R2-N4 | INFO | CLARIFIED: "MED" in the R1 table is the reviewer's rating of R1-ADV-3; the filed issue's `low` is the orchestrator's rating of the gap that remains once spec D6/D7 and section 5 are honored. |
| R1-ADV-3 partial disagreement | - | KEPT FILED. The cheap half (print the latest v2 answer on each `signed up again` report line) is already the issue's first suggested step; it extends the approved D10 report, and the leads it serves are those who re-sign-up between the deploy and Cameron's post-deploy run (expected near zero). Listed for Cameron. |
| R2-N1 | LOW | FILED `docs/issues/join-not-listed-error-on-wrong-fields.md`. AR-7 (binding planner ruling) accepted that the not-listed message clears on the next text edit or send, not on picking an authority; the accessibility angle (person fields marked invalid, the select not described by the alert) is new and recorded with R2's fix. Not a one-line fix. |
| R2-N2 | LOW, PLAUSIBLE | FILED `docs/issues/join-backfill-ignores-pending-authority-suggestion.md` and raised as an OPEN QUESTION for Cameron in the handback: spec D10's approved left-out rules do not consider a pending AI housing authority suggestion; whether the backfill should leave such a lead out (or print the suggestion on its line) is a product call to make before the first dev run. Not data loss: the suggestion survives and accepting it overwrites Atlanta. |
| R1-ADV-2 reason ("Cameron: authority only") | - | CORRECTED REASON (R2 is right): that quote is about status. The REJECT stands on D10's write definition ("Status and every other field are left alone") plus spec section 4's accepted suggest-over-held-value consequence. |
| Gate-4 run1 red | - | AGREED by R2 with stronger evidence (run1's app log: every request in the failing window finished within 29 ms) and run2 green. |
