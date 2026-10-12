# Planner independent review - adjudications (round 1)

Branch `feat/join-housing-authority`, code at 15c1676f (HEAD 7d5e36c6 adds
mission records only). The orchestrator handed back MERGE-READY with 0
recoveries. The planner then ran the five gates itself on a quiet tree
(`planner-gates.md`) and dispatched two fresh opus reviewers:

- `conformance.md` (spec + work map): 62 CONFORMS, 1 DEVIATES (immaterial),
  0 MISSING of 63 rows; 5 LOW.
- `adversarial.md` (PLAN-BLIND: diff + repo + charter only): 0 BLOCKING,
  0 HIGH, 5 MEDIUM, 7 LOW.

The planner read the riskiest diffs itself (public.ts, app.ts,
publicOrgList.ts, the backfill's write path) and verified the pre-existing
X-Forwarded-For finding (`app/src/middleware/rateLimit.ts:67-74` keys on the
FIRST entry). It also checked the in-flight fix/caseworker-integrity diff:
it adds no contact audit event type and no new `housingAuthority` writer, so
the backfill's audit-shape rule (adversarial 12) has no live gap.

## Conformance

All five LOWs accepted as written (no change): the post-apply list re-read
only after a write (immaterial to D10's purpose); the select disabled while
sending; the backfill's defensive extras (escaped names, empty `--skip` id =
usage, two WARNING lines, non-advancing audit paging throws); the doc-only
additions; `consent_required` winning over the D4 refusal (pre-existing order,
reveals nothing).

## Adversarial

| # | Finding | Ruling | Effect |
|---|---|---|---|
| A1 | [MED] A repeat /join sign-up's answer is kept only in the audit, and the backfill leaves exactly those leads out | REJECT for this branch | D6 is Cameron's approved rule (a public form never edits an existing record); the gap is already filed (`join-repeat-signup-answer-unreachable`). Offered to Cameron as an optional backfill refinement (write the recorded answer). |
| A2 | [MED] The preselected default is stored like a real choice, no provenance | REJECT | Decided at the spec gate (spec review J5; Cameron approved the public default 2026-10-12); the AI-suggests consequence is in spec section 4. |
| A3 | [MED] Public sign-ups skip Needs review and default into AHA-filtered blasts; volume attacker-controlled via the spoofable rate-limit key | REJECT for this branch, NOTE on the security issue | The status and default are Cameron's decisions. Blasts have no status filter today, so a spoofed sign-up already reaches unfiltered blasts; the new exposure is AHA-filtered blasts. The amplifier is the pre-existing `public-rate-limit-key-spoofable-xff`; this attack path is appended there and its priority is raised with Cameron. |
| A4 | [MED] Backfill `--skip` is not persisted; a later run without it writes the excluded leads; a typo is ignored on `--apply` | ACCEPT | FIX WAVE FW-1: on `--apply`, each skipped candidate gets a `housing_authority_backfill_excluded` audit event that every later run treats as "left out - excluded on an earlier run"; `--apply` refuses (exit 1, nothing written) when a `--skip` id names no contact at all; an id that names a non-candidate is still reported, not refused. RUNBOOK updated. |
| A5 | [MED] Backfill writes AHA over a lead with a pending housingAuthority suggestion | CAMERON'S CALL (the handback's open question R2-N2, same finding) | Recommended: FW-2 - leave the lead out with the reason "has a pending housing authority suggestion (<value>) - accept or dismiss it first", read with `getSuggestion(contactId, 'housingAuthority')`. |
| A6 | [LOW] The default is the hard-coded name; a rename silently turns it into "Not sure" | REJECT | Spec D8 by design (default by exact name, else "Not sure"). |
| A7 | [LOW] Anonymous list reads are uncached consistent reads; the per-IP key is spoofable | NOTE on the security issue | The item is small; the fix is the rate-limit key. |
| A8 | [LOW] A sign-up racing a rename can store the old name | ACCEPT as known | The same window exists for staff writes; the value surfaces under "Not on the list". No change. |
| A9 | [LOW] Backfill write and audit are separate; "FAILED - nothing written" can be false on an ambiguous error | ACCEPT | FIX WAVE FW-3: a non-conditional write error reads "FAILED: the write may or may not have landed - re-run the dry run to see" (report + RUNBOOK); the audit stays a separate best-effort append (a transaction would change the shared repo seam for a one-time script). |
| A10 | [LOW] Staff-added authority names are published on /join with no notice | OFFER to Cameron | A one-line note on the Settings add/rename forms; not in this branch unless he asks. |
| A11 | [LOW] The batch flow meets the shared 5/min limit at a venue | REJECT | Cameron accepted the limit (2026-10-12). |
| A12 | [LOW] The audit-history rule hard-codes each writer's payload shape | ACCEPT as known | Verified no live gap against the in-flight caseworker-integrity diff; the function's comment names its sources. |
