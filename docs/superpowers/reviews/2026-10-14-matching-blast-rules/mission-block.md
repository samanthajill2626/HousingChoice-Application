# MISSION: Matching blasts follow the audience rules (Sam's tracker #6)
Worktree: W:\tmp\matching-blast-rules  Branch: feat/matching-blast-rules  (cut from main @a2b3d80d)
Profile: W:\AI Projects\Housing Choice\HC Application\.claude\feature-mission.profile.md
Spec: W:\tmp\matching-blast-rules\docs\superpowers\specs\2026-10-14-matching-blast-rules-design.md (APPROVED rev 5)
Plan: W:\tmp\matching-blast-rules\docs\superpowers\plans\2026-10-14-matching-blast-rules.md (sections 0-4 + 4.1 BINDING; 4/4.1 rulings AR1-AR32 win over slice text)
Design review: spec R3 (terminal), plan R<see adjudications> - adjudications at
  docs/superpowers/reviews/2026-10-14-matching-blast-rules/design-review/adjudications.md and
  docs/superpowers/reviews/2026-10-14-matching-blast-rules/plan-review/adjudications.md
Records: docs/superpowers/reviews/2026-10-14-matching-blast-rules/ (commit records as produced; intent.md is the planner's, do not edit it)

Work map:
- S1 App foundations (Tasks 1.1-1.5): blastAudienceRules.ts (holds, checkedByDefault, filter normalizer, wire shape); AudienceFilter list type; toursRepo.listByStatus createdAtFrom + fakes; resolver reads searching then onboarding, authorities in memory; create list check + legacy body; storedFilterRefusal per member; wire projections.
- S2 App rules in routes (Tasks 2.1-2.5): readOpenTourHolds / readAudienceRules / buildReviewRows; preview fields + tourHolds + 503 + seeds-only degrade; estimate = default-checked count; send path (c) exclusions; matrix seed (one legacy, one list); comments (GSI kept, never deleted).
- S3 Dashboard (Tasks 3.1-3.6): types/endpoints/audienceSummary; tourHoldLabel + RecipientPreview; AudienceFilters multi picker + caption; prefillAuthorities; composer prefill/ownership/property change/settle gate/no draft until settled (AR23)/422 one member/503 Try again/Change frozen in preview (AR26); Available-only picker.
- S4 e2e, docs, completion (Tasks 4.1-4.5): repair the existing Matching specs (incl. AR22's draft-delete test); new e2e spec; GLOSSARY/RUNBOOK/resolve the truncation issue; main sync FIRST then the five gates once; lint count step (AR27); handback.

Watch items:
- Every slice re-anchors on quoted text, never line numbers; never revert an earlier slice (AR21).
- broadcasts.ts is edited by S1 then S2 (header split AR9; estimate/preview/path (c) are S2's).
- KEEP the byHousingAuthority GSI and contactsRepo.listByHousingAuthority (Cameron) - comments only.
- Lint gate 5 baseline: BroadcastComposer.tsx carries 4 react-hooks/set-state-in-effect errors and useComposerDraft.ts 1 react-hooks/refs on main - add NONE (S3 expects to remove 2).
- App vitest needs DynamoDB Local: START it if down, never RESTART the shared container (AR2/AR29).
- e2e tenants: explicit status, recorded consent, RUN-UNIQUE on-list authorities wherever counts/lists are asserted - except the a2p no-consent tenants (spec section 7).
- The a2p path (c) test must still see skipped_no_consent === 1.
- e2e serves source live: never edit source while this worktree's e2e runs; no concurrent e2e:session and full suite.
- Never touch :5174 / :8080; Playwright only through the e2e workspace.
- Lean seed's Tasha is `placing` - expected out of filter blasts now.

Gates (bare, real exit codes, from the worktree, after the ONE main sync - AR18/AR28):
1. npm run typecheck
2. npm test   (check `env | grep '^AWS_'` first; DynamoDB Local up)
3. npm run smoke
4. timeout 2700 npm run e2e   (AR17)
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')  - no NEW errors vs the merge-base baseline; skip if the list is empty

Post-merge obligations already known: none expected (no infra, no new dependency, no backfill; deploy is Cameron's). Handback includes a 2-3 sentence third-person tracker #6 note (no "you"); do not edit the tracker.
