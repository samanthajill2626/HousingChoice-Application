# B2a planner review - adjudications (2026-10-29)

Branch feat/wp1-b2-ranking-engine reviewed at 486e726c (code = 542e6874).
Reviewers (opus, fresh, read-only): spec conformance
(planner-conformance.md: D1-D19 19 CONFORMS, 12/12 of Cameron's decisions
hold, 2 LOW) and plan-blind adversarial (planner-adversarial.md: 0
CRITICAL, 0 HIGH, 5 MEDIUM, 8 LOW, 4 INFO).

Classes: FIX (planner fix wave PFW1), FILE (docs/issues, out of scope),
NOTE (no action; handback), REJECT (with the reason).

## Cameron's rulings that drive PFW1 (2026-10-29, verbatim in intent.md)

- Q1 / PA-1: the property's unlawful-flag record stores only the fixed
  reason "flagged as a requirement fair housing does not allow" (with the
  field named by the display). Charter 7.2 says "the model's reason":
  recorded as charter amendment item 15.
- Display: the admin Rankings page shows unlawful flags only on the
  PROPERTY's own ranking and that property's runs, never on a tenant
  anchor's ranking. The send composer never shows them. The property page
  shows them (scope question to Cameron: read-only notice in B2a now, or
  B4). Charter amendment item 16.

## Findings

| Id | Sev | Class | Ruling |
|---|---|---|---|
| PA-1 | MED | FIX | = Q1 (R2-server-1). Fixed sentence only; `flagReason` removed; test pins that no pair text reaches the record. |
| PA-2 | MED | FILE | No code check that reasons avoid protected traits; the counterfactual gate compares score and cap only. Charter 7.2 relies on the rubric plus the check. Issue `ranking-reason-text-protected-traits` (med): option to extend the counterfactual check to fail a reason that names the swapped value. For Cameron at handback. |
| PA-3 | MED | FILE | VA may POST rank (spec D12 by design, for B3's composer); limit is 6/min per user, in-memory per process; no spend ceiling. Issue `ranking-spend-ceiling` (med). For Cameron. |
| PA-4 | MED | FILE | inputSnapshot per match row (B2b's seam, unread in B2a) and run inputGzip keep tenant free text 180 days; no purge on contact delete. Extends A1-12. Issue `ranking-stored-input-retention` (med). For Cameron. |
| PA-5 | MED | REJECT | Names on the tenant card are charter 7.2 ("names stay"), and the counterfactual check swaps the tenant's name (spec D17). Noted for Cameron. |
| PA-6 | LOW | FILE | Append to `ranking-job-lifecycle-robustness` (single failed renewal). |
| PA-7 | LOW | FILE | Append to `ranking-job-lifecycle-robustness` (no DynamoDB request timeout holds a slot). |
| PA-8 | LOW | FILE | Card free text has no length cap; one oversized record can fail a batch or a write chunk every press. Issue `ranking-card-text-length` (low). |
| PA-9 | LOW | FILE | Same issue as PA-8 (unknowns length). |
| PA-10 | LOW | FILE | Read cost ~1000 requests per 300-tenant read, uncached, VA-open. Issue `ranking-read-cost` (low). |
| PA-11 | LOW | NOTE | Already open: `extraction-text-field-write-races-staff-fill`; append the cheap conditional-write idea. |
| PA-12 | LOW | FILE | With PC-2: cost totals under-count (timeouts with no usage; stopped-job spend only in logs). Issue `ranking-cost-undercount` (low). |
| PA-13 | LOW | FILE | Tenant SMS text reaches the ranker via extracted Notes lines (prompt-injection surface). Issue `ranking-notes-injection-surface` (low). |
| PA-14 | INFO | REJECT | By design, spec D10 / charter 7.2 ("a false flag costs a cap, never a tenant"); already noted A1-16. |
| PA-15 | INFO | NOTE | App vs worker model config drift marks rows out of date; correct and visible. |
| PA-16 | INFO | NOTE | Maintainability; batch-read third copy already in `units-contacts-batchget-walk-duplicated`. |
| PA-17 | INFO | NOTE | PR30 by design (any non-local endpoint is real tables). |
| PC-1 | LOW | NOTE | Driver defaults to anthropic outside the hermetic lane (PR30); no test reaches it. |
| PC-2 | LOW | FILE | Folded into `ranking-cost-undercount` with PA-12. |

Loop: PFW1 is one fix wave; after it, the five gates bare on a quiet tree,
then a narrow re-review of the PFW1 diff by the adversarial reviewer
(continued with SendMessage).
