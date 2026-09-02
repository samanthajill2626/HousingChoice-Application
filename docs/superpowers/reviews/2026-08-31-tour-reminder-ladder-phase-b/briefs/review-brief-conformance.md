# Reviewer A - SPEC CONFORMANCE (read-only)

You are a read-only spec-conformance reviewer. Do NOT edit or commit anything in the
worktree except your report. Worktree: `W:\tmp\tour-reminder-ladder-phase-b` (branch
`feat/tour-reminder-ladder-phase-b`, merge-base with main = `ec32170a`). ABSOLUTE paths in
every shell command. DynamoDB Local is up on :8000 if you need to run a unit file
(`cd .../app && npx vitest run test/<file>`). Do NOT run Playwright or the full suite -
gates are the orchestrator's; the FULL e2e is green at @66229715 (261 passed) and the
full app suite at @66229715 (6387 passed).

Inputs:
- Diff package (log + stat + `diff -U8`, feature files only):
  `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\review\phase-b-diff-package.txt`
- Spec (the CONTRACT): `W:\tmp\tour-reminder-ladder-phase-b\docs\superpowers\specs\2026-08-31-tour-reminder-ladder-phase-b-design.md`
- Plan: `W:\tmp\tour-reminder-ladder-phase-b\docs\superpowers\plans\2026-08-31-tour-reminder-ladder-phase-b.md`
- Orchestrator rulings + worklist: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\worklist.md` (section 1 = R1-R15)
- Slice reports (what each builder says it did/deviated): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-1.md` .. `slice-9.md`

WORK MAP (spec section -> task): T1 single-pass interpolate (s11) | T2 three tokens x six
sites (s4.3, 7.2) | T3 shared past-tour predicate + fire-time gate FIRST in precedence +
force-send refusal (s4.2, 6.1a) | T4 sweep script + RUNBOOK (s4) | T5 unit vehicle (s10) |
T6 e2e vehicle + live-worker audit (s10) | T7 DISCONTINUED_REMINDER_KINDS at four surfaces +
MANUAL_ONLY emptied + dev-tick divergence deleted (s3.1, 5) | T8 discontinued on read
surfaces incl. chip labels, union widening, DeadlinesNudgesCard entry (s3.1, 3.1a) + the
orchestrator-added fifth surface `routes/relayGroups.ts` (ruling R3) | T9 confirmation stops
arming; seeds; e2e anchor redesigns (s5, 10a) | T10 en_route exempt at arm, fire, AND the
panel estimate (3 sites) + widened `supersededBySlot` + LADDER_ORDER docblock (s6, 6.2) |
T11 names bound at BOTH sites (s7) | T12 overdue on BOTH builders + chip (s8) | T13 relay
catalog: five entries byte-exact, `{names}` total, `joinedName` (s9.1, 9.2, 9.2a) | T14
resolver keyed on OWNER, three intro variants with precedence, member_added split with ONE
persisted row carrying the NEW member's body, `bodyFor`, preview parity at all call sites,
role table, missing-input fallbacks (s9.0-9.6) | T15 docs closure + founder-handback-items.md
(s12, 15).

Charge: for EVERY work-map item and every numbered spec requirement inside it, verdict
CONFORMS / PARTIAL / MISSING / DEVIATES with `file:line` evidence from the LIVE tree (not the
slice reports - verify their claims). Specifically check:
1. Founder copy BYTE-EXACT against every fenced block in spec 9.1, 9.2, 9.4 (diff the catalog
   defaults character by character; note "on {when}" vs "at").
2. Precedence claims: past-tour gate FIRST in `processReminderRow`; force-send `kind_retired`
   > `tour_already_passed` > `names_unavailable`; discontinued evaluated OUTSIDE
   `suppressionOf` on both tour surfaces; the widened predicate's `undefined` guard polarity.
3. Every "N sites" claim: three tokens x SIX sites (spec 4.3); en_route at THREE sites;
   names bound at TWO; overdue on TWO builders; DISCONTINUED read at FOUR (+1) surfaces;
   `{where}` declared LAST in every new entry; `MessageId` union has the four new ids.
4. The sweep planner uses the SHARED predicate; conditional writes; dry-run writes nothing;
   PII-safe logging; RUNBOOK entry exists and states the order.
5. `sendRelayAnnouncement` default is byte-identical without `bodyFor`; the persisted row is
   the NEW member's body; `touchLastActivity` inherits it.
6. Preview parity at all FIVE production call sites (`tours.ts` x2, `placements.ts` x2,
   `relayGroups.ts` standalone -> naked unchanged).
7. Test coverage the spec's section 14 demands - name any listed test that does not exist.
8. Each orchestrator ruling R1-R15: implemented as ruled? Flag any ruling you believe
   CONTRADICTS the spec (the human must know).
9. Docs: issue ledger resolved with nine rows; founder-handback-items.md carries spec s15
   verbatim; `TODO(tour-reminder-ladder-phase-b)` gone from `app/src`.
10. ASCII-only on added lines; no `.superpowers/` or `INDEX.md` committed.

Reproduce anything doubtful with a throwaway test (do not commit it; delete it after).

Report (ASCII, compact tables, `file:line` everywhere) to
`W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\review-conformance.md`.
Findings ranked: BLOCKING (spec violated / behaviour wrong), MUST-FIX (gap a reader would
call a defect), SHOULD (cheap, worth folding into the fix wave), NOTE. Final message: the
report path + counts per rank + a one-line list of BLOCKING/MUST-FIX titles.
