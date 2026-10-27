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

## Round 2 (2026-10-26)

Reviewer A continued (round2-reviewer-a.md, 10 findings; contested no
round-1 adjudication). Spec rev 3.

| # | Finding | Verdict | Decision changed | Resolution in rev 3 |
|---|---|---|---|---|
| R2-1 | A1 (calls' tsMsgId is ring time; cursor passes before the transcript lands) | ACCEPT | yes | The "new messages only" rule (R1-3) is WITHDRAWN: any window message may react; one reaction per source message per row (first reading wins) is the whole dedupe. The `new` mark is not rendered. |
| R2-2 | A2 (new-only turns every no-write run into permanent loss) | ACCEPT | yes | Same withdrawal; Q1 now says a reaction is delayed, not lost, while its message stays in the window. Row cap no longer evicts (new ones dropped and counted), so the dedupe memory is never lost. |
| R2-3 | A3 (full-value accumulation churns suggestions and bypasses dismissal; cap starvation) | ACCEPT | yes | R1-5 replaced: all four fields follow the pets/tenure rule unchanged; an ADDITIVE fact on a non-empty text field is a Notes line, and a field op on a non-empty text field is only for a contradiction. |
| R2-4 | A4 (prompt change affects every production prompt; gate measures only never-written) | ACCEPT | yes | The probe's default suite runs on branch and main (`--repo`) as part of the gate; no case may score worse than main. |
| R2-5 | A5 (probe must run production filters, not a copy) | ACCEPT | no | Value rules live in pure exported `filterNoteLines` / `filterReactions`; applyExtraction and the probe both call them; the probe still touches no data. |
| R2-6 | A6 (clamps in the parser are bypassed by the fake driver) | ACCEPT | no | The parser does no value filtering; every clamp and the floor live in the pure filters. |
| R2-7 | A7 (first-share check used created_at / latest sentAt) | ACCEPT | no | Earliest `countedAt` among counted non-flyer shares; `sentAt` on a legacy row. |
| R2-8 | A8 (new mark has no field) | ACCEPT (moot in part) | no | No new mark; `TranscriptUtterance.handle?: string` named. |
| R2-9 | A9 (Q3 remove control undesigned) | ACCEPT | no | Q3 now carries the design: soft remove (`removedAt`/`removedBy`, dedupe keeps it out), `removeReaction` under the token protocol, audit, admin and va. |
| R2-10 | A10 (D2 string wording) | ACCEPT | no | "any other string is a 400". |

Rejected: none. Round 2 changed decisions (R2-1..R2-4): round 3 runs,
reviewer A continued.

## Round 3 (2026-10-26) - TERMINAL

Reviewer A continued (round3-reviewer-a.md, 8 findings; contested no
adjudication). Spec rev 4.

| # | Finding | Verdict | Decision changed | Resolution in rev 4 |
|---|---|---|---|---|
| R3-1 | A1 (D3 bullets contradict; apply honors any write) | ACCEPT | no | Rev 3 already stated the model never rewrites staff text live; rev 4 ENFORCES it: a write on a non-empty text field is demoted to a suggestion in apply. Dollars keeps the pets rule. |
| R3-2 | A2 (D4 "no field covers" vs additive lines; accessibility vs the list) | ACCEPT | no | D4 names additive facts as Notes lines; the list allows the accessibility need as a line when it adds to a filled field, stated as the home's feature, never a diagnosis (D7 banned terms are diagnosis terms). |
| R3-3 | A3 (cap before dedupe starves new reactions; same for notes) | ACCEPT | no | Every reaction drop, the stored-sourceMsgId dedupe included, runs before the per-run cap; the notes retry guard moves before the five-line cap. |
| R3-4 | A4 (default-suite rule undefined) | ACCEPT | no | 3 runs per case; fail on a case down 2+ or a total down more than 2; one re-run of both sides allowed. |
| R3-5 | A5 (Q1 "delayed, not lost" overstated) | ACCEPT | no | Q1 says a missed reaction or line is recovered by a manual run, or lost. |
| R3-6 | A6 (projection scope; cap counting; audit copies text) | ACCEPT | no | Opt-in projection for the contact's Properties sent read only; removed items count toward the cap; removal blanks the text and the audit omits it. |
| R3-7 | A7 (floor plumbing; coerceField private; "written" vs proposed) | ACCEPT | no | Floor via ApplyDeps from config, passed by the probe; coerceField exported pure; record lists values proposed. |
| R3-8 | A8 (legacy first send is the latest send) | ACCEPT | no | First-send check skipped for legacy and ledger-seeded rows. |

Rejected: none. No decision changed: round 3 is the terminal round. Spec
goes to Cameron's gate with Q1-Q3.

Totals: 3 rounds, 40 findings (round 1 merged 33 to 22), all accepted, 0
rejected. Decision-changing rounds: 1 and 2.

## Between rounds 3 and 4: Cameron's spec-gate redesign (2026-10-26)

At the gate on rev 4, Cameron withdrew stored per-pair reactions (and with
them R1-1, R1-2, R1-3, R1-4, R1-9, R1-10, R1-14..R1-18, R2-1, R2-2, R2-7,
R2-9, R3-3's reaction half, R3-6 and R3-8, whose mechanisms no longer
exist). The charter was amended (section 20, items 4-6) and the spec cut
to rev 5: reaction LINES in the Notes box and a read-only PROPERTIES SENT
list. That is a decision change by the human, not by a reviewer.

## Round 4 (2026-10-26) - the last allowed round; TERMINAL

Reviewer A continued (round4-reviewer-a.md, 8 findings; contested no
adjudication; confirmed nothing of the withdrawn design dangles). Spec
rev 6.

| # | Finding | Verdict | Decision changed | Resolution in rev 6 |
|---|---|---|---|---|
| R4-1 | A1 (address guard only on exact-pattern lines; the "no address" claim overreaches) | ACCEPT | no | Case-insensitive match; a non-reaction line containing a sent label is dropped (`reactionLinesMalformed`); the claim is narrowed to what is guarded; the tenant's own address stays guarded as today. |
| R4-2 | A2 (demoting a filled-field write re-creates churn) | ACCEPT | no | Such a write is DROPPED with reason `text_field_filled`, not suggested, and kept out of `demotedFields`. |
| R4-3 | A3 (an unavailable block leads to address-less reaction lines that then suppress the real one) | ACCEPT | no | A failed read fails the run, as the org-list read does; limit-dropped properties accepted as rare. |
| R4-4 | A4 (address line 1 + city not unique in a building) | ACCEPT | no | Label includes line 2 when present; identical labels rendered once. A refinement (adds detail) of the charter's line shape, named to Cameron at the gate. |
| R4-5 | A5 (flyer leads are often unknown contacts) | ACCEPT | no | The block is built for tenant AND unknown contacts. |
| R4-6 | A6 (regex details, counting order) | ACCEPT | no | Lazy match, copied "- sent" suffix stripped, ordinary " - question: " lines dropped as unmatched, one count per line at the first failing check. |
| R4-7 | A7 (D7 "no address" detection undefined) | ACCEPT | no | Each reaction control names its expected label and lowercase word; the unsent-home case fails on its street line or any digit-led street address. |
| R4-8 | A8 (line prefix has no year) | ACCEPT as a B2 note | no | B2 ages a maybe from stored facts, never from the prefix. |

Rejected: none. No decision changed: round 4 is terminal and the review is
closed at its cap.

Totals: 4 rounds, 48 findings (round 1 merged 33 to 22), all accepted, 0
rejected; rounds 1 and 2 changed decisions; the human's gate redesign
withdrew the stored-reaction mechanism between rounds 3 and 4.

## Round 5 (2026-10-26) - past the cap, at Cameron's request

Rev 7 (Cameron's free-form feedback lines, charter section 20 item 7)
was reviewed again because Cameron asked for it ("Do another review after
the changes we've made"). Reviewer A continued (round5-reviewer-a.md, 9
findings: 5 medium, 4 low). R5-3 was verified in the code:
`getDisplaysByIds` swallows a failed chunk and drops unprocessed keys
(unitsRepo.ts:663-668, :1303-1310); the contacts repo's `requireComplete`
(contactsRepo.ts:776-810) is the precedent. `listByContact` pages to
exhaustion and throws (listingSendsRepo.ts:486-492), so only the units
read needed the fix. Spec rev 8.

| # | Finding | Verdict | Decision changed | Resolution in rev 8 |
|---|---|---|---|---|
| R5-1 | labelMatches over- and under-matches | ACCEPT | yes (function contract) | Fold `.` `,` `#`, case and spacing on both sides; boundary-anchored match. Abbreviations deliberately NOT folded (speculative; the model copies the label and R5-2's count shows misses). |
| R5-2 | A missed attach becomes feedback on every home; labels drift | ACCEPT | yes (new count) | `unlabeledAddressLines` run-record count (street-suffix pattern, narrower than the suggested number-then-word, which would count "3 bedrooms"); label drift on an address edit noted for B2. |
| R5-3 | "Failed units read fails the run" not buildable on a best-effort read | ACCEPT | yes (repo option) | `requireComplete` on `getDisplaysByIds`, throwing `IncompleteBatchReadError`; extraction passes it; other callers unchanged. |
| R5-4 | D7 "no" control contradicts D5.2 | ACCEPT | no | The no is tied to the home; a separate untied-place control must name no sent property. |
| R5-5 | Whole-line attach moves staff-typed lines under one home | ACCEPT as a B2 note | no | D5.4 notes it, with the two options, to raise with Cameron at B2. |
| R5-6 | Label edge cases | ACCEPT | no | Empty line 1 or city -> no label, left out of the block; identical labels for different units noted for B2. |
| R5-7 | Fail-the-run rationale names the wrong mechanism, omits a cost | ACCEPT | no | Rationale is the reconcile rule; the attempt-cap cost is stated. |
| R5-8 | Block adds a path into the empty tenant-address field | ACCEPT | no | D7 control: a tenant with no stored address talking about a sent home produces no address op. |
| R5-9 | Stale status line and charter item 6 wording | ACCEPT | no | Status updated; charter item 7 supersedes item 6's wording. |

Rejected: none. Decisions changed: R5-1, R5-2 and R5-3, all tightenings
of the rev 7 mechanism (no surface removed, no charter decision moved).
Whether a confirming round 6 runs is Cameron's call at the gate.

Totals: 5 rounds, 57 findings (round 1 merged 33 to 22), all accepted, 0
rejected.
