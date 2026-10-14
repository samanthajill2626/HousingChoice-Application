# Planner verdict - primary contact integrity, after the planner fix wave

Date: 2026-10-13. Planner: Claude (feature-mission planner).
Branch `feat/primary-contact-integrity`, worktree
`W:\tmp\primary-contact-integrity`. Follows `planner-verdict.md` (the build)
and `fix-wave-findings.md` (Cameron's rulings F1-F5). Orchestrator handback:
`../handback-fixwave3.md`.

VERDICT: MERGE-READY at `e1cbf0fd (code tip a801d14a; e1cbf0fd adds docs and records only)`. 0 behind `main` (`e402a053`).
UNMERGED (human gate).

## What the wave shipped (Cameron's rulings)

| item | ruling | state |
|---|---|---|
| F1 | the property box's one-click names a contact typed landlord only (`autoEligible` row flag); four cases; script `noEligible` copy; RUNBOOK step 4 | shipped, conforms |
| F2 | deleting the landlord of record of a roster with NO flagged row hands off (`contactIsPrimaryToHandOff`, one shared rule in the Scan, the re-check and the fake) | shipped, conforms; issue `primary-handoff-no-flag-landlord-delete-gap` resolved |
| F3 | "Add a property manager or owner - they become the primary automatically." | shipped everywhere live |
| F4 | classifying a seated contact as a property manager still promotes nobody | no change, as ruled |
| F5a | "Restore without a landlord" and the swap read liveness strongly consistent | shipped, restore route only; issue `roster-liveness-read-eventual-consistency` narrowed, open |
| F5b | Delete dialog "...takes over when someone can..." | shipped |

## Independent gates (planner-run, bare, redirected, real exit codes)

Logs: `<worktree>/.superpowers/planner-gates/fw3-*` (ignored). Fast gates on
`a801d14a` (the merged code tip; everything after it is docs and records
only); e2e on ``e1cbf0fd``, quiet box, no reviewer running.

| gate | command | result |
|---|---|---|
| 1 | `npm run typecheck` | exit 0, 0 `error TS` |
| 2 | `npm test` (`env \| grep '^AWS_'` empty) | exit 0 - Test Files app 507/507, dashboard 248/248, 22/22, 34/34, 13/13; 0 `[dynamoAdmin]` lines |
| 3 | `npm run smoke` | exit 0 - "1705 import specifier(s) across 296 emitted file(s) resolve under plain Node." |
| 4 | `timeout 2700 npm run e2e` | exit 0 - "362 passed (25.8m)", 0 `[dynamoAdmin]` lines; the three primary-contact-integrity specs (a)(b)(c) and property-roster green |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)` (90 files) | exit 1 - ONE error, `dashboard/src/routes/tours/TourDetail.tsx 342:85 react-hooks/purity`, PRE-EXISTING (identical at the merge base; the first verdict proved it by stdin baseline) |

## Main sync

The orchestrator merged `main` once before building (`ebdd025d`, main
`8bec5de1`, six conflicts, both sides kept). `main` then advanced 6 commits
(last-heard-from records, a follow-ups lookback fix, an e2e spec); the
planner merged it at `a801d14a` (conflict in `RUNBOOK.md` only - both
backfill sections kept, main's text for last-heard-from) so the ff-only
merge command below works. Both reviewers checked both resolutions: nothing
dropped or duplicated.

## Independent review, round 2 (both reviewers CONTINUED, re-review charge)

- Spec conformance (`R2-conformance.md`): 46 rows - 44 CONFORMS, 2 PARTIAL
  (LOW, spec text F2 did not carry: 9.2's `landlordWasPrimary` users, 10's
  delete test list), 0 MISSING, 0 DIVERGES. Built-beyond-the-list items all
  recorded and justified (the `buildListingFile` pass-through - a reader the
  findings missed; spec 4.4 / 10 old-rule sentences; extra pins). R1
  adjudications conceded.
- Plan-blind adversarial (`R2-adversarial.md`): 0 BLOCKING, 0 HIGH, 0
  MEDIUM, 2 new LOW. Fixes judged correct, not merely plausible. R1
  adjudications 2-6 conceded.

### Adjudication of round 2

| id | finding | disposition |
|---|---|---|
| C-P1, C-P2 | spec 9.2 / 10 not brought along with F2 | FIXED at `e1cbf0fd` (docs only), with the conformance notes (spec 4.2's "as the getById it replaced" precision, the status line, the resolved issue's stale Delete-dialog sentence) |
| R2-1 | LOW: the delete rule reads FLAGS - a soft-deleted contact still flagged blocks the hand-off when the (unflagged, live) landlord of record is then deleted, leaving no contact | ACCEPTED, filed under shape 3 of `roster-liveness-read-eventual-consistency` (the restore paths already behave the same; spec 4.7 accepts a deleted flagged row until the next eligible write or the script). Its main source is primaries deleted before this branch deploys; the backfill repairs them - apply it promptly after each deploy. |
| R2-2 | LOW: the one-click sends the row's stored role; a row stored as `landlord` that is not the landlord of record gets a 409 (or, with no landlord of record, becomes it) | ACCEPTED: reachable only through an API-only landlord change no dashboard screen makes; edit mode's "Make primary" has always done the same. |
| R1-7 / R1-9 (reviewer's numbering) | the backfill audits healthy no-flag units; no real-repo route walk of the delete hand-off | Already adjudicated in `planner-verdict.md` as V8 and V9 (accepted); unchanged. |

No round-2 finding changed a decision. Review closed.

## Post-merge obligations (unchanged)

After EACH environment's deploy: `npx tsx app/scripts/assign-primary-contacts.ts --env dev`
(dry run) -> `--apply` -> dry run again -> hand the `noEligible` property ids
to Sam -> the same on prod (RUNBOOK "Primary contacts backfill"). The
`noEligible` lines now read "No eligible contact - no live contact is typed
landlord (add a property manager or owner)". No Terraform, secrets, SSM or
index change.

## Merge command (Cameron)

```
git -C "W:\AI Projects\Housing Choice\HC Application" merge --ff-only feat/primary-contact-integrity
```
