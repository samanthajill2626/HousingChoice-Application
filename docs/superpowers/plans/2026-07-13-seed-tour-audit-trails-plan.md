<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-13).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Seeded tour audit trails - implementation plan

Executes docs/superpowers/specs/2026-07-13-seed-tour-audit-trails-design.md
(source of truth; the event vocabulary + per-status sequences + instants are
derived from the live writer and are NOT to be re-invented).

## Global constraints (bind every task)

- FULL profile only; lean.ts byte-identical (e2e world = regression gate).
- Follow history.ts conventions: deterministic FNV-1a hash8 SK suffixes,
  entity-scoped dedupe, pure generators exported for tests, no Math.random or
  wall-clock reads in the core (clocks come from the tour rows themselves).
- Event types ONLY from the 8-type vocabulary; payload shapes exactly as the
  live writer's ({ tourId } baseline; conversationId / placementId appendices;
  no actor on archive writes).
- ASCII only in every touched line (tr check per changed file). Bare gates.
- Commit small + reviewable; gating bare git status read before every commit;
  trailer: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
- Never merge to main.

## Task 1: tourTrail generator + historyItems wiring + coherence tests (TDD)

Files: app/src/lib/seed/history.ts (add exported tourTrail(tour) + fold into
historyItems' audit generation + entity-scoped dedupe for tours# keys);
app/test/seedTourTrails.test.ts (new - mimic seedMatrixCoherence conventions).

TDD order: write the failing coherence tests FIRST (spec section 6 list:
non-requested non-empty / requested zero / pinned 8-type label mirror /
per-status sequences + payloads / timestamp coherence + monotonicity /
byte-stability / tourMilestones alignment / lean untouched), watch them fail
(missing export), then implement.

Verify (bare): npm test -w app; npm run typecheck.

## Task 2: live-path verification + DB round-trip + gates

- VERIFY (not assume) live.ts tours get trails through seedLive's own
  historyItems call; if its call path bypasses the tours slice, wire minimally.
- Extend the existing full-seed DB round-trip test (or add a focused one) to
  read a seeded toured tour's trail back through auditRepo.listByEntity
  newest-first and assert order + a GET /api/tours/:id/activity-shaped
  projection succeeds (route test if cheap).
- Gates, all bare from the worktree: npm run typecheck; npm test;
  npm run e2e FROM THE e2e/ WORKSPACE DIRECTORY (never repo root - that
  targets the live :5174 stack).

## Task 3: review + self-QA + sync + handback (orchestrator-led)

- Whole-branch review (opus): spec conformance (vocabulary, sequences,
  instants, alignment, dedupe, lean untouched) + adversarial (booking-instant
  edge when createdAt == scheduledAt; canceled-instant clamping; closed
  semantics; suffix collisions on same-instant rows; matrix now-relative
  determinism; live path actually covered).
- Live self-QA on a hermetic lane per spec section 7 with screenshots
  (scheduled + toured/canceled tours show pins in all three panes + Activity
  card; requested stays comms-only).
- git merge main; re-run all three gates green on the merged base; handback
  with evidence; do NOT merge to main.
