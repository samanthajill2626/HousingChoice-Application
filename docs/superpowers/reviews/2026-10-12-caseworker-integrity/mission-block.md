# MISSION: Caseworker integrity (R2-ADV-1 fence, type-change refusals, tour/placement/property type checks)

Worktree: W:\tmp\caseworker-integrity  Branch: fix/caseworker-integrity  (cut from main @19607658)
Profile: W:\tmp\caseworker-integrity\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md (APPROVED rev 3 @fc7cff02)
Plan: docs/superpowers/plans/2026-10-12-caseworker-integrity.md (v2 @94211832; 58 tasks + 2 checkpoints)
Design review: spec R1 (two reviewers; one round per Cameron), plan R1 (two reviewers, terminal) - adjudications at
  docs/superpowers/reviews/2026-10-12-caseworker-integrity/design-review/adjudications.md,
  docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-research/plan-assembly-rulings.md (binding over the slices),
  docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-review/adjudications.md
Records: docs/superpowers/reviews/2026-10-12-caseworker-integrity/ (commit each record as produced)

Work map (execute in this order):
- S1 D1 accept fence: plan-time 409 suggestion_contact_not_tenant; classification_revision guard; consistent plan read; effectiveGuard at all three real-repo sites + the fake; superseded_by_reclassification -> 409 suggestion_contact_reclassified; SSE emit, dashboard copy + refetch; FakeWorld AND DynamoDB Local regressions (the R2-ADV-1 schedules A and B)
- S2 D2 type change: contactHoldings.ts extraction (conversion byte-identical), contactKind, PATCH 409 type_change_refused (live landlord units only), edit form + Unknown card
- CK typecheck + npm test + smoke
- S3 D3 tours/placements: contactTypeGuards.ts; tour create / revive-from-canceled / reopen; placement create / from-tour / terminal exit; handleTransitionError; deriveTenantStatus skip; TenantFile team-member buttons; contactTypeErrors.ts + every tour/placement copy site incl. TourModals failureCopy
- S4 properties: unit create/PATCH landlord type; contact-list caseworker (new seat) + landlord claim checks in order; restoreWithLandlord + restore route + "Restore property" dialog; Add contact picker hides caseworkers; runRosterWrite mapping; ownerless-property crash fix + optional landlordId type
- CK typecheck + npm test + smoke
- S5 seed invariant test; e2e (edit-form refusal, picker, Reopen-dialog refusal, placement refusal, restore dialog); RUNBOOK; resolve 3 issues (correct the third); file 4 issues (placement-terminal-stage-exit-unguarded, import-bypasses-contact-type-rules, landlord-of-record-no-reassign-ui, unit-primary-contact-unchecked)
- Known lint baseline (do NOT fix, name in the handback): TourDetail.tsx:341 react-hooks/purity, ScheduleTourForm.tsx:241 react-hooks/set-state-in-effect

Watch items:
- W1-W7 in plan section 3 (invariant rule; conversion byte-identical; fixture fixes never weaken a rule; real-repo legacy test on DynamoDB Local; listing-status untouched; caseworker_use_conversion wins; W7 fallbacks untouched).
- Another agent builds tracker #14 (public /join form: app/src/routes/public.ts, dashboard/src/routes/public/*, a backfill script) and another works on #3 + #27 (Tenants tab, Matching page, property-send records) at the same time. Do not touch their worktrees or files; keep edits to shared files additive.
- NEVER restart, stop or remove the shared DynamoDB Local container without Cameron's go (it carries Cameron's data and other agents' lanes). A START of a stopped one is fine. If it misbehaves, STATUS: QUESTION.
- Never test against Cameron's live :5174/:8080; hermetic e2e lanes only. Do not run a full e2e and an interactive session concurrently from this worktree.
- Any `[dynamoAdmin]` line in real suite output is a real container fault: capture httpStatusCode + attempts (AGENTS.md).
- If the build finds a mutation surface or reader the plan does not list: record it in a findings file and STOP for a ruling (STATUS: QUESTION), do not silently add scope.

Gates (bare, from the worktree, real exit codes, never piped):
1. npm run typecheck
2. npm test
3. npm run smoke
4. npm run e2e   (under a hard outer timeout)
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')   (attribute by merge-base baseline; empty list -> skip)
Sync main into the branch ONCE at the final pre-handback step (ask via QUESTION if main moved in a way that could conflict).

Post-merge obligations already known: none expected (no infra, no data migration, no new dependency). This branch must merge BEFORE #19 deploys and ships in the same deploy.
Handback: records/handback.md + a 2-3 sentence neutral third-person tracker note for #19 (no "you"). Never merge.
