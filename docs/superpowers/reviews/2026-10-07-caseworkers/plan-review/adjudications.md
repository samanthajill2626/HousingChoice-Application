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
