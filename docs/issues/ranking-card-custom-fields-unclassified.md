---
id: ranking-card-custom-fields-unclassified
title: Staff-defined custom fields reach the ranking model and two 180-day stores without classification
type: decision
severity: med
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/services/ranking/cardFields.ts:131, app/src/services/ranking/cards.ts:293, app/src/lib/contactProfile.ts:26, app/src/services/ranking/runLog.ts:114, app/src/services/ranking/runBatch.ts:145, app/scripts/rankingCounterfactual/swaps.ts:24
---

**Problem.** The ranking card is a runtime allowlist PER ATTRIBUTE (charter
6.1; WP1 B2a spec D2.1): `cards.ts` copies only keys `cardFields.ts`
classifies `include`, so a new attribute is dropped until someone classifies
it. Spec D2.1 (approved) includes the tenant's `customFields`
(cardFields.ts:131, copied whole by cards.ts:293-296). But `customFields` is
not one attribute: it is a container of staff-defined label/value pairs
(lib/contactProfile.ts:26-37, any label staff type). So any custom field
staff add later - a birth date, an income, a case number, a diagnosis -
reaches the model on the next ranking, and is kept with it for
`RANKING_PAIR_TTL_DAYS` (180 days) in two stores: each run's `inputGzip`
(runLog.ts:114) and each match's `inputSnapshot` (runBatch.ts:145). Nobody
classifies it, and the counterfactual fair-housing check never swaps a custom
field (scripts/rankingCounterfactual/swaps.ts:24-70), so the merge gate does
not cover this path either. Found by the plan-blind code review round 1
(reviewer A1, finding A1-8, plausible: reasoned from the code).

**Decision for Cameron** (raised in the B2a handback). Options:

- **Exclude** `customFields` from the card (one registry line, a
  card-definition change: every tenant fingerprint moves once, so every match
  reads out of date once).
- **Allowlist labels**: include only custom fields whose label is on a
  reviewed list (a new small registry; unknown labels dropped, like unknown
  attributes).
- **Keep and cover**: keep them on the card, add a custom-field swap (for
  example a birth date or an income line) to the counterfactual suite, and say
  in the RUNBOOK and the custom-field UI that custom fields are model input.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R1-adversarial-A1.md (A1-8) and R1-adjudications.md.
