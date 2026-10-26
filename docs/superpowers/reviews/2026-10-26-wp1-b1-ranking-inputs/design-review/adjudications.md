# WP1 B1 Ranking inputs - design review adjudications

Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md.
Round 1 reviewed rev 1 (1d86f59f). Reviewer reports:
design-review/round1-reviewer-a.md (19 findings),
design-review/round1-reviewer-b.md (14 findings).

Verdicts: ACCEPT (spec edited), REJECT (reason given), DEFER (filed),
QUESTION (put to Cameron at the spec gate). "Decision changed" is the
planner's call after adjudication: did the finding alter what gets built,
add or remove a surface, or move an invariant.

## Round 1 (2026-10-26)

Merged list. A<n> / B<n> = the reviewer's finding number.

| # | Findings | Verdict | Decision changed | Resolution in rev 2 |
|---|---|---|---|---|
| R1-1 | A1, B3 | ACCEPT | yes | The JOB owns both handle maps: one pure function builds message handles (per message, oldest first, after the window is final) and the PROPERTIES SENT block with its property map; the prompt builder renders what it is given; apply, the fake-driver path and the probe use the same maps. Transcript line format written verbatim. |
| R1-2 | A9 | ACCEPT | yes | The handle is rendered BY `renderUtteranceLine` (the hash covers the bytes sent, invariant kept); each window entry records its handle; the run-detail verifier renders with the stored handle, and an entry without one (every pre-B1 run) renders without, so historic runs still verify. |
| R1-3 | A2, B4 | ACCEPT | yes | Reactions are read only from messages NEW to the run (after the cursor), and dedupe is one reaction per source message per row. The block shows each existing reaction with its date. A message older than the pair's first share cannot react to it. |
| R1-4 | A2 (correction path), B2 | ACCEPT in part + QUESTION | yes | The run record now stores the RESOLVED reactions (unitId, sourceMsgId, kind, text), shown in the AI run detail, so a reaction is auditable. Whether B1 also shows reactions on the tenant's Properties sent list with a remove control is Q3 to Cameron, with the planner recommending it. |
| R1-5 | B1 | ACCEPT | yes | Text fields accumulate: a model write on a NON-EMPTY text field is demoted to a suggestion carrying the full merged value; a write only lands when the field is empty. Model cap = staff cap = 500; an over-cap model value is dropped, never truncated. Dollars keeps the scalar rule. |
| R1-6 | A3, B5 | ACCEPT | yes | Gate record lists every field value written in each case and flags banned terms found there (reported, not failing, charter 20.2). Banned-term lists include paraphrases. Pass = mechanical pass AND Cameron's written sign-off on the record. |
| R1-7 | A13, B12 | ACCEPT | yes | No second script: `app/scripts/extraction-prompt-probe.ts` is refactored (exported main + invokedDirectly guard), gains a `--suite never-written` mode and the new input fields; `--model` is required in that mode and printed in the record. |
| R1-8 | A11 | ACCEPT | no | Record carries commit, prompt fingerprint, and a per-case hash of the user content; "a prompt change" = a change to any of them. Cost is computed from a dated price table in the script. |
| R1-9 | A5, B6 | ACCEPT | yes (surface) | `touched`, the `ai_run.completed` payload, `suggestion.updated` and the manual-run banner count reactions written. |
| R1-10 | A6, A7, B8 | ACCEPT | yes (surface) | Block budget 8,000 characters, newest 3 reactions per property, oldest properties dropped first with a warn; every value flattened to one line; a line containing TRANSCRIPT is dropped; handles assigned after drops; the units repo is a named dependency (address via the existing BatchGet projection); a unit that no longer resolves is skipped; a failed read renders "PROPERTIES SENT: unavailable", applies no reactions, and does not fail the run; non-tenants get "PROPERTIES SENT: none". |
| R1-11 | A8, B7 | ACCEPT | no | Order fixed: the parser keeps up to 20 structurally valid items; apply applies the floor first, then the five-line cap (system lines after model lines), and counts below-floor drops. Same for reactions. |
| R1-12 | A4, B14 | ACCEPT | yes | The list entry carries label, chip label (lowercase), kind, control (input / textarea / dollars) and prompt guidance; the form and prompt iterate it. runTypes.ts may import the leaf list (still no cycle). The spec states honestly what a later move involves: the entry, plus a data step for stored values, pending suggestions, journals and dismissals, owned by the later change. |
| R1-13 | A10 | ACCEPT as watch item + DEFER | no | The importer replaces the whole Notes box on re-import (lib/import/apply.ts:1196-1198, verified). Named in section 4 as a watch item; filed docs/issues/import-overwrites-notes-box.md. Fix out of scope. |
| R1-14 | A12, B2 (e2e) | ACCEPT | no | No new dev seam. The writer is proven by DynamoDB Local integration tests; e2e asserts through the run record's resolved reactions in the AI run detail, or the Properties sent list if Q3 adds it. |
| R1-15 | A15, B3 | ACCEPT | no | A message qualifies as the tenant's own when it carries at least one client utterance. |
| R1-16 | A16 | ACCEPT | no | Prompt gives the shape for an unlisted-home line ("not interested in a home they found: too far from work"). |
| R1-17 | A17, B9 | ACCEPT | no | Writer condition = token AND `attribute_exists(unitId)` AND counted AND `attribute_exists(sentAt)`; each retry re-applies the full qualifying rule (counted non-flyer share, or legacy). |
| R1-18 | B10 | ACCEPT as watch item | no | Contention with ledger writers named in section 4. |
| R1-19 | A18 | ACCEPT | no | Priority goes in its own row after Same-day RTA; table order matches the DOM; dashboard `Unit` type named. |
| R1-20 | A19, B11 | ACCEPT | no | Named doc and comment updates: RUNBOOK:1457, prompt "eight field entries", schema.ts:23, the system prompt's input description and line format, GLOSSARY entries. |
| R1-21 | B13 | ACCEPT | no | Chip labels lowercase; the dollars chip shows `$1,200 / month`. |
| R1-22 | A14 | ACCEPT as a sentence | no | Unbounded Notes growth accepted for B1; B2 decides how the card carries the box. |

Rejected: none.

Round 1 changed decisions (R1-1..R1-7, R1-9, R1-10, R1-12): round 2 runs
with reviewer A continued (more unique accepted findings), handed reviewer
B's report.
