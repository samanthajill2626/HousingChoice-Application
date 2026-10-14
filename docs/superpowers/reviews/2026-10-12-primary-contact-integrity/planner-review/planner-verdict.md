# Planner verdict - primary contact integrity + intro fallback explanation

Date: 2026-10-13. Planner: Claude (feature-mission planner).
Branch `feat/primary-contact-integrity`, worktree
`W:\tmp\primary-contact-integrity`. Builder handback:
`../handback.md` (MERGE-READY @283c9cb7, zero recoveries).

VERDICT: MERGE-READY on the code at 283c9cb7 (tip a7eca276 = that code + the
handback, the planner-review records and a spec section-12 wording fix - docs
only). 0 behind `main`. UNMERGED (human gate). One MEDIUM review finding is put
to Cameron as a decision before merge (below); nothing BLOCKING or HIGH.

## Independent gates (planner-run, bare, redirected, real exit codes)

Logs: `<worktree>/.superpowers/planner-gates/` (ignored).

| gate | command | result |
|---|---|---|
| 1 | `npm run typecheck` | exit 0, 0 `error TS` (tip 971c9551) |
| 2 | `npm test` (`env | grep '^AWS_'` empty; run with AWS_* unset) | exit 0 - app 494 files / 10043 passed + 1 skipped; dashboard 242 / 4611; e2e ws 22 / 503; 34 / 275; 13 / 111; 0 `[dynamoAdmin]` lines |
| 3 | `npm run smoke` | exit 0 - "1676 import specifier(s) across 291 emitted file(s) resolve under plain Node" |
| 4 | `timeout 2700 npm run e2e` (tip a7eca276, quiet box, no reviewer running) | exit 0 - "350 passed (21.6m)", 0 `[dynamoAdmin]`; specs (a)(b)(c) and property-roster green |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)` (87 files) | exit 1 - ONE error, `dashboard/src/routes/tours/TourDetail.tsx 342:85 react-hooks/purity` (`Date.now` during render); the merge-base 16ca96cc version linted via stdin reports the identical error: PRE-EXISTING, not this branch |

## Independent review

- Spec conformance (`R1-conformance.md`): 84 rows - 81 CONFORMS, 0 PARTIAL,
  0 MISSING, 3 DIVERGES (all LOW, all already recorded in the handback with
  reasons: the intro job's INFO line fires at compose time (D-4); the script
  logs contact ids beside unit ids, no names / phones / streets (D-1); the
  GLOSSARY lists more zero-primary paths than spec 12 - spec 12 was stale and
  is corrected at a7eca276 (D-3)). No unlisted behavioral divergence.
- Plan-blind adversarial (`R1-adversarial.md`): 0 BLOCKING, 0 HIGH, 1 MEDIUM,
  8 LOW. No lost update, dropped row or crash constructible in the new write
  paths.
- Planner's own reads: `services/primaryHandoff.ts` and its wiring in
  `routes/contacts.ts` (after the soft delete persists, guarded, ids-only
  logs), the dev seam (hermetic router only, refuses `landlord`, creates its
  own unit), `decideAutoPrimary` / `autoPrimaryLivenessIds` (only X, no live
  primary and no live landlord, unknown -> no promotion). Self-QA screenshots
  01-04 checked against the chosen mockups (layouts A).

### Adjudication of the planner-review findings

| id | finding | disposition |
|---|---|---|
| V1 | MEDIUM: the property box's one-click "Make <Name> primary" counts any live non-caseworker row, so it can make a TENANT primary; that tenant then joins other tenants' new groups and is named in their intros, and auto-primary no longer heals it. The backfill's `noEligible` guidance steers staff to the box. | DECISION FOR CAMERON - it narrows his 2026-10-13 "button unchanged" ruling on new information (the downstream harm + the script steering). Planner recommends the fix: a response-only `autoEligible` row flag, one-click only for landlord-typed rows, otherwise the eligible-less line + "Choose a primary"; reword the script's line. |
| V2 | LOW: "Restore without a landlord" lost caseworker-integrity's per-row consistent read (ruling R13 accepted the batch read). | Offered as a cheap fix-wave item (a `ConsistentRead` option on the batch read); otherwise stays filed (`roster-liveness-read-eventual-consistency`). |
| V3 | LOW: the Delete-dialog sentence says someone "takes over"; often nobody can. | Offered as a cheap copy fix ("...takes over when someone can..."). |
| V4 | LOW: removing a NON-primary row leaves a stale `primary_contact`. | Accepted: spec 4.7 aligns the scalar on writes that set or move the primary; the script aligns legacy scalars; nothing reads it at runtime. |
| V5 | LOW: one consistent units Scan per contact DELETE, in-request. | Accepted (spec 4.6); measured cheap at gate 4 (`roster-paging` 60 deletes, 1.4 s); a ProjectionExpression is a later optimization. |
| V6 | LOW: `propertyContact.ts <-> unitsRepo.ts` import cycle. | Accepted (ruling R3: no top-level reads either way). |
| V7 | LOW: the live-contact and non-empty-landlordId checks repeated; the single-source ladder test can pass while checking no files. | Accepted as debt; the ladder test gap noted for a follow-up. |
| V8 | LOW: the backfill also flags the landlord on no-flag units with a live landlord of record (count + Activity rows). | Accepted: spec 8 target rule (flag reflects the effective contact); the dry run shows the count before any apply. |
| V9 | LOW: the contact-delete hand-off has no real-repo or e2e walk (fakes at route level). | Accepted; noted. Unit + API + parity pins exist; self-QA walked it at the boundary. |

## Decisions put to Cameron (with the builder's open questions)

1. V1 (above) - recommended: fix before merge.
2. Builder Q2 / adversarial F1: deleting the landlord of record of a roster
   with NO flagged row hands off nothing (spec 4.6's designed asymmetry with
   restore). Two-line reuse of `landlordWasPrimary` would make delete heal it.
3. Builder Q1: spec 7.4's line "Add the landlord or property manager - they
   become the primary automatically." is wrong when the landlord of record is
   a soft-deleted contact (a Landlord-role add answers 409).
4. Builder Q3: classifying an already-seated contact as a property manager
   does not run auto-primary (spec 4.4), so it can recreate the 470 Bolton
   shape; the box and the backfill cover it.
5. V2 / V3 cheap LOW fixes.

Any fix taken goes in ONE fix wave, then a re-gate (typecheck, the touched
workspaces' tests, e2e) before the merge command is handed over.

## Post-merge obligations

After EACH environment's deploy: `npx tsx app/scripts/assign-primary-contacts.ts --env dev`
(dry run) -> `--apply` -> dry run again -> hand the `noEligible` unit ids to
Sam -> the same on prod (RUNBOOK "Primary contacts backfill"). No Terraform,
secrets, SSM or index change.
