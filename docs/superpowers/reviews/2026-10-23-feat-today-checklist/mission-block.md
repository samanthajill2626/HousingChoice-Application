# MISSION: Today as the daily checklist (tracker #31)

Worktree: W:\tmp\today-checklist  Branch: feat/today-checklist  (cut from main @970a29b9)
Profile: W:\tmp\today-checklist\.claude\feature-mission.profile.md (thin Claude adapter; shared rules in AGENTS.md and documentation/FEATURE-DEVELOPMENT-WORKFLOW.md)
Spec: docs/superpowers/specs/2026-10-23-today-checklist-design.md (r8)
Plan: docs/superpowers/plans/2026-10-24-today-checklist.md (v4; sections 0-4 binding, rulings PR1-PR106 win over slice text)
Records: docs/superpowers/reviews/2026-10-23-feat-today-checklist/ (slice reports under slices/, committed as produced)
Design review: spec R4 (adjudications design-review/adjudications.md), plan R3 (design-review/plan-adjudications.md)   [REQUIRED]

Work map:
- S1 the signal: last_reached_out_at field, touchLastReachedOut, getRecipientDisplaysByIds consistentRead, recordStaffOutreach, conversationsRepo.getByIdConsistent, fakes
- S2 the system_copy message marker (Send now, Retry of automated copy); direct writers W1 (1:1), W2 (Retry), W3 (email), W6 (outbound dial, post-response), W8 (dev seams); no-stamp tests for every other sendMessage caller; inbound post-touch contact.updated (inbound email, founder-triage call, masked relay call); tour.updated on both tour-create paths
- S3 relay and group writers W4 (team-post legs), W5 (group text), W7 (staff-edited intro); after-loop fresh-read conversation.updated; no-stamp tests (30003 rung, announcements, reconcile)
- S4 Today server: Follow up core split (tab byte-identical), quiet shares, identify, tours_to_book, tours_today at/unitLabel, Unreplied removed, failure isolation
- S5 dashboard Today: section component (5 rows, Show all), option C quiet shares, At a glance, help lines, All caught up, fallback, past tours oldest first
- S6 backfill script app/scripts/backfill-last-reached-out.ts + tests + RUNBOOK entry
- S7 e2e (new today-checklist spec + every spec pinning the old page + perf terminals), backfill lane rehearsal, docs, live self-QA
- S8 one main sync, the five bare gates, gate report with the two handback lines (PR85)

Watch items:
- WI1-WI13 in plan section 3; each result goes in its slice report.
- Never touch Cameron's live stack (:5174 / :8080); never run anything against AWS dev or prod. The backfill runs ONLY on a hermetic e2e lane (S7.15), with the PR78 guarded helper.
- Deliberate test inversions are named in the slice reports (PR40, PR43, PR49, PR50, PR59); never weaken an assertion to make it pass.
- Section headings carry NO count (PR102, Cameron at the launch gate): the 2026-08-03 no-bare-counts pins stay untouched.
- e2e named-flake list is EMPTY: any failing named spec is a regression to diagnose. Never edit source or commit while this worktree's e2e runs.
- No seed edits (lean/full byte-stable), no Terraform/GSI/deploy, no new dependency.
- ASCII on every added line; explicit-path commits; bare git status before each commit; Co-Authored-By trailer.

Gates (bare, from the worktree, after the one main sync in S8):
1. npm run typecheck
2. npm test   (as `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test` if AWS_* is exported; DynamoDB Local up via npm run db:start)
3. npm run smoke
4. npm run e2e
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')   (no new errors in touched files; baseline-attribute any)

Post-merge obligations already known:
- Cameron runs the last_reached_out_at backfill AFTER the deploy: dev then prod, dry run first (RUNBOOK entry from S6).
- The planner records the Oct 23 decisions and Sam's option C pick in tracker #31.
- No infra or dependency change expected.
