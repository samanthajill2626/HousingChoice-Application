# Build research (live-tree drift check) - adjudications

Date: 2026-09-25. Build orchestrator, before slice 1. Tree: `feat/share-skip-fix`
at `cf088d22` (source equal to main@bbaad87d). Three parallel read-only readers
(ops = Tasks 1-5, backend = Tasks 6-8, dashboard/e2e/seed = Tasks 9-14) checked
every plan anchor, importer and lean-world consumer. Findings:
`build-research-ops-findings.md` (2 MUST-ADJUST, 2 NOTE),
`build-research-backend-findings.md` (4 NOTE),
`build-research-dashboard-findings.md` (5 NOTE). No BLOCKER. Every plan-quoted
test can pass as written; no lean-world consumer changes outcome (both sweeps).
The byte-exact worklists are run state (`.superpowers/sdd/build-worklist-*.md`).

No spec decision changes. Every accepted item below is folded into the
implementer briefs; the plan file itself is not re-versioned for them.

## Ops (Tasks 1-5)

- F1 (MUST-ADJUST) ACCEPT. Both RUNBOOK PowerShell recipes (the audit Query and
  the lost-audit `put-item`) are written the way RUNBOOK.md:2315-2323 already
  prescribes: build the JSON, `[IO.File]::WriteAllText` (BOM-free), pass
  `file://<path>`. The "same idiom as the other Query steps" wording is dropped.
  RUNBOOK.md:1797 (a `scan` with the same latent defect) is OUT OF SCOPE: filed
  at handback as a small issue, not fixed on this branch.
- F2 (MUST-ADJUST) ACCEPT, both halves. (a) `stageClient.test.ts` gains
  `parseStageArgs` cases: `--env dev --apply` sets the flag; `--conversation <id>`
  is captured; usage for `--dry-run`, `--env=dev`, a missing `--env`, a value
  flag with no value, `--lane 0`, `--lane x`, an unknown flag. (b) The Task 5
  lane rehearsal (run by the orchestrator) first switches ONE lane conversation
  to `manual` through a client bound to the lane's own key, so the dry run plans
  1, the apply enables 1 with a `bulk_enable` audit event, and the second apply
  plans 0 / `alreadyOn` 1. The next reseed restores the lane.
- F3 (NOTE) ACCEPT. The Task 5 eslint line is read as "no NEW errors versus the
  merge base": the two pre-existing `no-explicit-any` errors in
  `app/test/importApply.integration.test.ts` (base :739:59, :818:59) are the
  baseline and are named in the slice report, not fixed.
- F4 (NOTE) ACCEPT as a spec clarification: section 5's writer list now says the
  performance profiler's synthetic world already creates its one-to-one rows
  switched off and is left unchanged. Nothing is built for it.

## Backend (Tasks 6-8)

- N1 ACCEPT. Task 6 rewords `broadcastFanOut.ts:9-10` and `:25-26` (not `:26-27`);
  Task 7 also rewords `:492-494`. All rewrites ASCII (the current lines carry an
  arrow and em dashes).
- N2 ACCEPT. Tasks 6 and 7 run `test/seedMatrix.test.ts` and
  `test/performanceSeed.test.ts` (the files that read the edited seeds) in place
  of `test/seedData.test.ts`; `contactsBatchReads` / `contactsBatchIncomplete`
  stay in Task 7's list (they call the double's `create()`).
- N3, N4 ACCEPT. Citations corrected in the worklist (`priorRecipientContactIds`
  doc `:315-322`; `broadcastApi.test.ts` `toEqual` `:1216-1225`; `UpdateCommand`
  already imported; `markSent` at `:285`; `types.ts` doc `:2888-2891`). No edit
  changes.

## Dashboard, e2e, seed (Tasks 9-14)

- N1 ACCEPT. Task 9 splices only the already-sent sentence inside
  `RecipientPreview.tsx:8-11`, keeping the "auditable" sentence before it and
  the "A live selected count drives ..." sentence after it.
- N2 ACCEPT. Task 12's lint expectation is "no NEW errors versus the merge base".
  Pre-existing and left alone: `BroadcastComposer.tsx` 4 x
  `react-hooks/set-state-in-effect` (:167, :190, :208, :223 at base) and
  `BroadcastComposer.test.tsx` 3 x `no-unused-vars` (:11:24 `ContactsPage`,
  :11:69 `UnitsPage`, :37:10 `DEFAULT_SEND_TEMPLATE`). Named in the handback's
  gate-5 baseline.
- N3 ACCEPT. The e2e spec's comment cites `routes/broadcasts.ts:657-663` (no
  consent fence on explicit selection) and `broadcastFanOut.ts:397-407` (the
  consent skip), not the a2p spec.
- N4 ACCEPT. The stale comments are rewritten (ASCII) by the task that touches
  the file: Task 10 - `DeliveryBadge.tsx:24-25`, `broadcastFormat.ts:83-87`;
  Task 12 - `RecipientPreview.tsx:66-67`, `:427-428`, `RecipientPreview.test.tsx:502-503`,
  `resolveTemplate.ts:1-5`, `matching-entry-points.spec.ts:7-11`; Task 13 -
  `unknown-caller-triage.spec.ts:121-124` (four contacts), `cast.ts:114`
  (lean range ends at -4), and the two already-stale line citations
  (`deleted-contact-resurfacing.spec.ts:13`, `contact-create-relay-group.spec.ts:52,:65`),
  all added to Task 13's file list and explicit `git add`.
- N5 ACCEPT. `BroadcastStatusPill.tsx` keeps its header comment (ASCII), plus
  one clause for the "Not sent" case.

## Also recorded

- main has advanced two commits past the base (`685f2ede` touches only
  `app/src/jobs/relayRetryLeg.ts` + its test; `cd8e8ddd` docs). No overlap with
  any task; the Task 15 sync should be clean.
- The performance seed (F4) and the Property Activity "Sent to N tenants" count
  (reads `tenantCount`, which includes skipped recipients) are both Branch B /
  out of scope; the second is already listed in the Branch B stub.
