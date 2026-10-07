# Caseworkers (branch B) - plan review adjudications

Plan: `docs/superpowers/plans/2026-10-07-caseworkers.md`. Spec revision 14.

## Round 1 (2026-10-07) - plan @66cdacf1

Two opus reviewers: `R1-reviewer-a.md` (17 findings; it covered S1-S4 fully,
then S5-S10 on a continuation) with its delegated sub-review
`R1-reviewer-a-S5-S7-sub.md` (11; covers S7 7.2/7.3/7.5), and
`R1-reviewer-b.md` (10). Every finding is a plan-text defect; none changes
what the product does. Rulings (A = reviewer A, S = the S5/S7 sub-review,
B = reviewer B). ALL ACCEPTED; the fixer applies them; round 2 reviews the
fixes.

| # | finding | ruling |
|---|---|---|
| A1, B9 | plan cites "CONTRACT ISSUES" / "CI-n" text that exists only in gitignored drafts | Replace every such citation with the matching `plan-assembly-rulings.md` id (e.g. "S1/S2-3") or inline the fact; no dangling citation remains. |
| A2 | Task 1.4's mirror test drags the app's AWS/Anthropic graph into the dashboard typecheck | `CASEWORKER_ROLE` is DEFINED in the leaf `app/src/lib/caseworkers.ts`; `contactKinds.ts` imports and re-exports it; the mirror test imports only `lib/caseworkers.ts` (and the D4 normalizer it uses). Plan 3.2 amended. |
| A3 | e2e red from S6/S9 until S10.4 (wording pins) | Each e2e wording pin moves into the task that changes the copy (S6.5 timeline, S9.1-9.6); Task 10.4 becomes a skip-if-done verification. Section 0 states e2e pins move with their copy. |
| A4 | units landlord-of-record and rosters check no contact type after a conversion | Widen Task 10.12's tours/placements follow-up issue to name `units.ts` landlord assignment and roster edits too. |
| A5, A6, B1 | Task 9.6 makes three PartnerFile props required but S8.9's `renderPartner` helper never passes them; 9.6's header anchor was replaced by 8.9 | Task 9.6 updates `renderPartner` (pass the three props) in the same step and anchors on S8.9's header text. |
| A7 | Tasks 9.6 and 10.9 both edit selectors.md (line 45, duplicate rows) | 9.6 owns line 45 and the partner/"Sent to" rows (one regex each); 10.9 is skip-if-done for those and adds only the rest. |
| A8 | `GLOSSARY.md:120` and `sequence-diagram-to-test.md:135` handed to S10 but no task edits them | Added to Tasks 10.10 / 10.11. |
| A9, B4 | `isCaseworkerContact` placement contradicts the binding note | Task 8.3's text defines it in `caseworkerRole.ts`; 8.5, 8.8 (and every importer) import from there. |
| A10, S7 | the display `deleted` counts column hits, so one record can read "+2 deleted" | The dashboard shows `inUse.deleted` (distinct) for "+N deleted" and in the Delete sentence; per-column `deleted` stays on the wire for compatibility only. |
| A11 | Task 10.7 scans page 1 of `?type=unknown` | Use the exact `?phone=` lookup. |
| A12 | stale "Sent to tenants" at `Card.tsx:193-195` and RUNBOOK 179/376/386/415 | Card.tsx in Task 9.1; RUNBOOK lines in Task 10.11. |
| A13 | Task 8.13's nav-order test reads `aria-label` the links do not have | Read the links' accessible names (`getAllByRole('link')` within the Contacts nav group). |
| A14 | 8.9's "Role: Partner" row makes `conversation-fact-extraction.spec.ts:342` ambiguous | Task 8.9 scopes that assertion (exact, within its card) in the same task. |
| A15, B2 | 8.3's `leftOther` sentence and test pin "other conversation" | Code and test use plan 3.9 verbatim ("... without a type ..."). |
| A16, B5 | Tasks 10.1/10.2 redo S8's catalog, profiler and :201 work with RED claims that cannot be red; 10.1 re-creates an issue file | 10.1/10.2 become verification steps (grep; no RED claim; no re-creation); S10's stated start state corrected. |
| A17, B6 | `caseworker_conversion.by` documented as email in 2.1 and 8.1 | userId everywhere. |
| S1 | no e2e drives the new Settings organization UI; the 5.7 seam is never used | New S10 task: plant a run-unique `organization` value on a run-unique contact with `setOffListValue({ field: 'organization' })`; assert its "Not on the list" row; Add as new requires "Kind"; Use of an existing name; never a count. |
| S2 | the job's claim path for an organization Use untested | Task 5.5 adds the claim-path case. |
| S3 | 5.6 misdescribes `orgNames.ts:260-262` | Instruction rewritten to the real line order. |
| S4 | 7.5 places `<OrgKindChoice>` two ways | One placement: a sibling after the Name block's expression. |
| S5, S6 | anchors that do not exist / span lines (7.2; 5.2; 7.5) | Re-anchored on text that exists on one line. |
| S8 | organization mode can still say "Use Split instead." | Task 7.3 maps `org_name_compound` in organization mode to organization copy with no Split; tested. |
| S9 | `selectors.md:121` org-picker row not updated | An S7 task updates it. |
| S10 | 5.2's stated RED reason wrong | Corrected (fails on the `skipped` count). |
| S11 | 7.4 duplicate anchor | No change (the plan says "first occurrence"). |
| B3 | "Current" anchors use `{--}` / `{"}` placeholders for non-ASCII bytes | Section 0 gains the legend (`{--}` U+2014 em dash, `{->}` U+2192, `{...h}` U+22EF, `{"}` U+201C/U+201D curly quotes): read the real line, edit it with the exact bytes read (never typing a `\u` escape), and write the replacement in ASCII. |
| B7 | spec D22 says BOTH timeline sites read "No recipients reached" | Spec amended to the plan's rule (recount site only; the stored-count site keeps "Sent to 0 recipients" so the relabel predicate finds it) - revision 15. |
| B8 | `make` on an existing caseworker ignores a staff-picked organization | When the preview says `alreadyCaseworker`, the dialog hides the Organization picker and says "This contact is already a caseworker. Confirming re-runs the cleanup." |
| B10 | no `npm run smoke`, gate 5, main sync or full `npm test` after S7-S9 | A checkpoint after S9 (typecheck + `npm test`), and a final task: sync main, then the five gates bare (gate 5 with the empty-list guard and the explicit merge base). |

Decision check: no finding changed what the product does; one e2e task and
one checkpoint are added (test surfaces). The fixes are new, unreviewed text,
so round 2 (reviewer A continued) reviews them.

### Round 1 fix pass - the fixer's open questions (planner rulings)

Fix report: `R1-fix-report.md` (every row applied; plan 18596 -> 19294 lines).
1. Task 10.12 step 8 repeats Task 8.9's staff-notes issue edit - make it
   skip-if-done (applied in the round 2 fix pass).
2. The Task 7.5 Settle dialog can still say "Use Split instead." on an
   organization row - EXTEND ruling S8: organization rows use the no-Split
   organization copy there too (round 2 fix pass).
3. `conversation-fact-extraction.spec.ts`'s own page-1 `?type=unknown` lookup -
   REJECT: pre-existing in a spec B does not otherwise change; B adds no
   unknown contacts that would push its row off page 1 beyond what other specs
   already do. Not B's change.
4. Plan 3.9 writes "No candidates - add a tenant below." with an ASCII hyphen
   for a string B leaves UNCHANGED (it keeps its em dash) - clarify the row:
   the UNCHANGED strings are named by meaning; their bytes stay as today
   (round 2 fix pass).
5. `sequence-diagram-to-test.md:133` "Broadcast to tenants" - no change: it
   describes a filter-resolved broadcast, which stays tenant-only (D20).
6. Task 10.3 made skip-if-done - CONFIRMED (assembly ruling S5/S7-5: S5 owns
   those pins).

## Round 2 (2026-10-07) - plan @5af82883 - TERMINAL

Reviewer A continued (it holds reviewer B's report too): `R2-reviewer-a.md`,
3 findings (1 HIGH, 2 LOW). It covered every changed line against HEAD
(A2 across 3.2/1.1/1.2/1.4, the glyph legend, the moved pins in 6.5/9.1/9.3/
9.4, Task 10.4's grep, the Checkpoint after S9, Task 10.14 line by line
against AGENTS.md, Task 10.8a, 10.1/10.2 vs 8.13, 10.7, 8.9(d), 9.6, 8.3,
10.10) and read in full the tasks it had skimmed (8.1, 8.2, 8.4, 8.6, 8.11,
6.1 GREEN, 8.3's dialog). It agreed with the REJECT of open question 3 and
contested no ruling. Its verdict: nothing found changes WHAT gets built.

| # | finding | ruling (applied by the planner) |
|---|---|---|
| 1 HIGH | S3's Step 0 (and S4's inherited one) greps `contactKinds.ts` for the `CASEWORKER_ROLE` definition the A2 fix moved | Step 0 greps the leaf `lib/caseworkers.ts` for the definition and `contactKinds.ts` for its import/re-export. |
| 2 LOW | Task 8.1's dashboard mirror comment still defines `leftOther` the old way | Comment matches plan 3.2. |
| 3 LOW | the glyph-legend fallback leaves the glyph on the touched line | Fallback rewrites the ONE line with a short UTF-8 node script (never PowerShell), asserting one match, writing ASCII. |

Also applied: the deferred fix-pass open questions 1 (Task 10.12 step 8
skip-if-done), 2 (Task 7.5 step 5: organization rows pass `{ organization:
true }` to `orgErrorCopy`, with a test) and 4 (plan 3.9's UNCHANGED row names
strings by meaning; their bytes stay as today).

Decision check: no accepted finding changed what gets built, added or
removed a surface, or moved an invariant. Plan review CLOSED after round 2.
