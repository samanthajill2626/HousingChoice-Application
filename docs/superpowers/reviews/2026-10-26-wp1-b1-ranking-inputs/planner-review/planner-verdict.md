# Planner verdict - WP1 B1 Ranking inputs

Verdict: MERGE-READY PENDING (1) Cameron's never-written gate run and
sign-off, and (2) two rulings below. UNMERGED (human gate).

Branch feat/wp1-b1-ranking-inputs @c70a56c4 (code at 89016353; later commits
are records). main @d0e2c2d8, 0 behind, 123 ahead.

## Planner's own gate run (quiet tree, bare, HEAD c70a56c4, 2026-10-27 23:15-23:36 UTC)

Logs: .superpowers/sdd/gates-planner/.

| gate | exit | detail |
|---|---|---|
| npm run typecheck | 0 | |
| npm test | 0 | app 545 files / 11772 passed, 1 skipped; dashboard 272 / 5633; 22/509, 34/275, 13/111; 0 [dynamoAdmin] lines (run with ANTHROPIC_API_KEY and AI_EXTRACTION_MODEL unset) |
| npm run smoke | 0 | 1760 import specifiers across 306 emitted files resolve |
| npm run e2e | 0 | 383 passed (17.1m) |
| npx eslint (main...HEAD, 87 files) | 0 | no output |

Agrees with the build's two batteries (67d877cc and 89016353, all 0).

## Independent review

conformance.md (90 of 95 spec items conform) and adversarial.md (plan-blind;
0 blocking). Adjudicated in adjudications.md: no fix wave; two rulings to
Cameron; everything else expected, by design, accepted as built, deferred to
B2, or recorded.

## Rulings for Cameron

1. PC-1 - Notes retry guard. Spec D4 / charter 6.4 kept today's guard (drop
   a line already anywhere in the box, any date). The build changed it to
   drop a model line only as a same-day repeat, because the old guard
   silently drops a change of mind back to earlier words (spec D5.2 requires
   it be written). Cost: a fact repeated word for word on a later day is
   written again. Planner recommends KEEP, recorded as spec rev 11 and charter
   20 item 12 (docs only; no prompt or fingerprint change).
2. PA-1 - field values outside the never-written list (Cameron's 2026-10-26
   call). Example: the gate's own "near my mosque" case would likely fill
   area preference live and the gate still PASSES; the record shows the
   value under "fields" for sign-off. Planner recommends KEEP the call for B1
   and revisit with extraction-fields-to-notes (the fields move into Notes,
   where the list applies).

## Conversation checklist

| item (date raised) | status | evidence |
|---|---|---|
| Switch dropped; test is the merge gate (10-26) | delivered | no AI_MATCHING_NOTES_ENABLED anywhere; RUNBOOK names the probe gate |
| List covers Notes lines only, not the free-text fields (10-26) | delivered | prompt.ts:144; probe reports field values, never fails them (PA-1) |
| One list of matching inputs + sources, easy to move to notes (10-26) | delivered | app/src/lib/tenantMatchingInputs.ts; dashboard mirror + drift test |
| Demoted runs append no lines (Q1, 10-26) | delivered | apply.ts filterNoteLines demotion |
| Cameron runs the gate on claude-sonnet-5-5; RUNBOOK fixed (Q2, 10-26) | delivered, run pending | gate-run-commands.md; RUNBOOK sonnet-5-5 |
| No stored reactions, no remove control, no Maybe button (10-26) | delivered | no listing_sends write; listingSendsRepo untouched |
| Feedback lines free-form, naming the home; no fixed shape (10-27) | delivered | prompt.ts feedback bullets; propertyLabel/labelMatches counts only |
| Feedback reaches every ranking; properties seen (10-26/27) | B2 | B1 writes the lines; charter 20 items 4-7 |
| WP3 redesign issue; B2 attach logic minimal (10-27) | delivered | docs/issues/wp3-property-feedback-redesign.md |
| No-address prompt bullet removed; postal filter and address-output rule kept (10-27) | delivered | prompt.ts; apply.ts postal filter |
| Model grader, plain fact descriptions, reasons shown, sign-off overrules; no word lists (10-27) | delivered | extractionProbeNeverWritten.ts; no banned lists |
| Grader defaults: pronoun, household by relationship, mobility aid (10-27) | delivered | extractionProbeNeverWritten.ts:94-96 |
| "Sex" includes sexual orientation and gender identity (10-27) | delivered | prompt.ts:145; grader description; gay feedback case |
| Typed input trimmed (standing) | delivered | S1 parsers and coerceField trim |
| No infra; synthetic content; no agent touched the testing key (standing) | delivered | PR1; tests stub the driver and grader |
| Charter decisions bind (10-26) | deviated once | retry guard (ruling 1) |

## Update after Cameron's rulings (2026-10-28)

- PC-1: Cameron chose the ANY-DATE retry guard over whole lines (planner fix
  PF-1, 68168b4c; spec rev 11). PA-1: fields stay outside the list.
- Gates re-run at a0371f40: all five exit 0 (e2e 383 passed, 17.6m; npm test
  app 11770 passed). Re-review of PF-1: 0 blocking/high/medium, 2 low.
- The prompt fingerprint changed: the never-written gate run must be on
  68168b4c or later.

## Final state (2026-10-28 01:40 UTC)

- Never-written gate, both commands, Cameron on the testing key with
  claude-sonnet-5-5 (never-written-test.md):
  - First run (68168b4c): every call 400 "compiled grammar too large" - fixed
    by PF-2 (bb6464df, fields as one list); compile check COMPILES x3.
  - Never-written suite on f311ba4e: 28 of 29 pass; excluded-medical-feedback
    OVERRULED to clean by Cameron ("regular care/regular appointments" is
    fine). Controls met; feedback lines keep the tenant's meaning.
  - Default suite vs main (d0e2c2d8) on 1fa3c8e1: PASS, 30/30 vs 30/30.
- Planner gates at 2901fa40 (code f5dcca26): all five exit 0 (e2e 383).
- Spend on the gate (informational, unverified prices): about $1.96 + $1.00.
- Verdict: MERGE-READY. UNMERGED (human gate).

## Owed

- Cameron: run gate-run-commands.md on the testing key (claude-sonnet-5-5,
  about $4-5.50), read the record, sign off.
- After merge: deploy dev, then prod (Cameron's ask). No Terraform, no
  migration, no new required env var.

## Merge command (after the gate run and the rulings)

git -C "W:\AI Projects\Housing Choice\HC Application" merge --no-ff feat/wp1-b1-ranking-inputs
