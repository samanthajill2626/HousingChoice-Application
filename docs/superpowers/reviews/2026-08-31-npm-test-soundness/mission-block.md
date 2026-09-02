# MISSION: npm test soundness (M7)

Worktree: `W:\tmp\npm-test-soundness`
Branch: `feat/npm-test-soundness` (cut from `main` @ `5ce9912f`)
Profile: `.claude/feature-mission.profile.md`

Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v5)
Plan: `docs/superpowers/plans/2026-09-01-npm-test-soundness.md` (v5 FINAL)

Design review: **spec R4 (TERMINAL), plan R4 (closed at the cap)**.
Adjudications at
`docs/superpowers/reviews/2026-08-31-npm-test-soundness/design-review/`.
154 findings across eight rounds, 154 accepted, 0 rejected.

## Work map

- **S0** - install, warm-up, 3 contended `npm test` baselines at the base
  commit, with contention snapshots. FIRST, and cannot be redone later.
- **S4** - `groupCrossCheck`: 10 solo runs. Before S1, so its arms cannot
  straddle a code change. Measure only; do NOT edit the file.
- **S1** - `dynamoAdmin.ts` retry for the container's `InternalFailure` /
  `InternalServerError`, local-endpoint gated, plus a 17-case
  stub-client acceptance suite written FIRST. Refactor
  `db-update-gsis.ts` onto the shared helper.
- **S2** - `logCallSiteGuard`: instrument the hook, cut the measured
  dominant cost, budget both clocks. Remove instrumentation before
  handback.
- **S3** - `staticSmoke`: split into fixture-served behaviour (never
  skips), the identity contract against tracked source (never skips), and
  a real-dist diagnostic that can only PASS or SKIP. Files one new issue.
- **S5** - the clean-key measurement plus the TTL probe.
- **S6** - one `main` sync, five bare gates, 3 post-fix runs.
- **S7** - issue closures, two new issues, the clean-key recipe in THREE
  files, `npm run issues`.
- **S8** - handback.

## Watch items

- **The acceptance suite is the point of S1.** Cases 11/12 prove the
  endpoint gate refuses; 13/14 prove it still says yes; 3 pins the hot
  path at zero extra calls; 15 proves the refactor did not disarm the
  retry that already works. Without them the whole item ships inert with
  five green gates.
- **Never restart the DynamoDB Local container** - three other missions
  share it. If the database-count axis is the blocker, measure it, say so,
  and stop.
- **Do NOT set `E2E_CHILD_LOG_DIR`** - it changes the timings being
  measured. A trace is the artifact.
- **A mixed contended/quiet measurement pair may NOT close the anchor
  issue.** Label a QUIET arm QUIET; never fabricate load.
- **The anchor is expected to stay OPEN.** The two mediums should close
  cleanly. That is a legitimate result, not a failure.
- **A fix can introduce a defect of the class it closed** - that happened
  in three consecutive review rounds on this plan. After any fix, re-ask
  the original question of the new text.
- These changes touch the harness every other mission is gated by.

## Gates

Bare, from the worktree, on a quiet tree, after the single `main` sync:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Gate 5 is NEW errors in TOUCHED files only, attributed by baseline
comparison at the merge base.

## Post-merge obligations already known

None expected. No dependencies, no infrastructure, no deploys.
