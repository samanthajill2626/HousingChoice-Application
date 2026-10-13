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

## Cameron's rulings (2026-10-12, after the review)

- A5 (pending suggestion): LEAVE THEM OUT, as recommended -> FW-2. Spec
  revision 5, D10.
- A1 (a repeat sign-up's answer): IGNORE. "This backfill is only a temporary
  solution" - do not file an issue; the orchestrator's
  `docs/issues/join-repeat-signup-answer-unreachable.md` is DELETED in the
  fix wave and every reference to it removed (RUNBOOK included).
- A10 (Settings note): ADD IT -> FW-4. Spec revision 5, D12.
- The pre-existing X-Forwarded-For rate-limit bug: a separate prompt for a
  separate agent (handed to Cameron; not this branch).

## Fix wave 1 (planner) - the complete list sent to the orchestrator

- FW-1 (A4): persist `--skip` on `--apply` (`housing_authority_backfill_excluded`
  audit event; later runs leave such a lead out, reason "excluded on an
  earlier run"); `--apply` refuses a `--skip` id that names no contact at all.
- FW-2 (A5): leave out a candidate with a pending `housingAuthority`
  suggestion, the reason showing its value.
- FW-3 (A9): a non-conditional write error reads "may or may not have
  landed - re-run the dry run to see", never "nothing written".
- FW-4 (A10): the D12 Settings help line.
- FW-5: delete `join-repeat-signup-answer-unreachable` and its references;
  resolve `join-backfill-ignores-pending-authority-suggestion` (FW-2 fixes it).
- RUNBOOK and the backfill rehearsal's expected output updated to match;
  tests for each.

---

# Planner independent review - round 2 (after fix wave 1)

Both reviewers were CONTINUED with the re-review charge on the fix diff
(15c1676f..0eb44652): `conformance-r2.md` (revision 5: 18 CONFORMS,
2 DEVIATES immaterial, 0 MISSING; the fix wave broke none of the round-1
rows; D12 shows on exactly the four surfaces that add or rename a housing
authority) and `adversarial-r2.md` (0 BLOCKING, 0 HIGH, 1 MEDIUM, 2 LOW; it
conceded A2, A3, A6, A11 and A12). The planner's own round-2 gates:
`planner-gates-r2.md` (1, 2, 3, 5 green; gate 4 one environmental
blank-document failure, the file 5/5 alone).

| # | Finding | Ruling | Effect |
|---|---|---|---|
| B1 | adversarial-r2 1 [MED] An interrupted --apply leaves later --skip exclusions unrecorded (they are appended in the same oldest-first loop as the writes), and the RUNBOOK says to drop --skip on later runs | ACCEPT | FIX WAVE 2: record every exclusion in a FIRST pass before any write; stop (exit 1, nothing written) if any exclusion append fails. RUNBOOK: keep the --skip value for every run on that environment, always. |
| B2 | conformance-r2 4 [LOW] RUNBOOK step 4 says "apply again" without the same --skip | ACCEPT | Folded into B1's RUNBOOK change. |
| B3 | adversarial-r2 2 [LOW] = fix-wave F2: a lead whose "Atlanta Housing Authority" suggestion staff dismissed is still written | CAMERON'S CALL | Recommended: leave it out (reuse the AI path's dismissal check). |
| B4 | adversarial-r2 3 [LOW] An accept/dismiss in flight or abandoned (its resolution record active, the suggestion row already deleted) is not seen; the backfill can supersede the accepted value | ACCEPT | FIX WAVE 2: leave a lead out while its (contactId, housingAuthority) resolution record is active. |
| B5 | adversarial-r2 nit: the post-write audit warning still says "could not be written" | ACCEPT | FIX WAVE 2: "may not have been written" wording. |
| B6 | conformance-r2 1, 2, 3, 5, 6, 7 [LOW] | ACCEPT as written | Exclusion recorded once per lead (same effect as "every apply"); the failure line's extra "(an ERROR line names this contactId)" inside the quoted phrase; one reason printed per lead; the D12 note also shows on the shared add dialog outside Settings (true there); a failed exclusion append or pending-suggestion read counts as FAILED; the post-apply re-read only after a write. |

## Cameron's ruling (2026-10-13) and the fix wave 2 list

- B3: INCLUDE the dismissed-Atlanta check (spec revision 6, D10).

Fix wave 2 (backfill script, its test, RUNBOOK only):
- FW2-1 (B1/B2): exclusions recorded in a first pass before any write; any
  failed exclusion append stops the run before writing (exit 1). RUNBOOK:
  keep the `--skip` value for every run on that environment, always.
- FW2-2 (B3): leave out a candidate with a staff dismissal of an "Atlanta
  Housing Authority" housingAuthority suggestion, using the AI suggest path's
  own dismissal rule.
- FW2-3 (B4): leave out a candidate whose housingAuthority suggestion
  resolution record is active.
- FW2-4 (B5): the post-write audit warning says "may not have been written".
