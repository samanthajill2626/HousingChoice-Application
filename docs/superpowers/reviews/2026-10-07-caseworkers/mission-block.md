# MISSION: Caseworkers - branch B (Sam #19; #2 org names was branch A, merged and deployed in release 1.5.0)

Worktree: W:\tmp\caseworkers  Branch: feat/caseworkers  (cut from main @a8b66cd6; main merged in @c1530f9d; main is now 20ccdb12, one RUNBOOK-only commit ahead - synced once at Task 10.14)
Profile: W:\tmp\caseworkers\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md (revision 15). This mission builds BRANCH B only: D16-D22 and every "(B)" line in D6, D10, 5.2, 6, 9, 10, 11, 12. Cameron's eight rulings are recorded in the spec ("Cameron confirmed 2026-10-07").
Plan: docs/superpowers/plans/2026-10-07-caseworkers.md (74 tasks + 2 checkpoints; sections 0-3 are BINDING; the assembly notes at the top of S8, S9 and S10 override their task text)
Design review: spec R4 (closed, round 4 terminal; 49 findings, all accepted in substance, 3 partial rejections) - docs/superpowers/reviews/2026-10-07-caseworkers/design-review/adjudications.md. Plan review: R2 (closed, round 2 terminal; round 1 38 findings across two reviewers and a sub-review, all accepted; round 2 3 findings, applied) - docs/superpowers/reviews/2026-10-07-caseworkers/plan-review/adjudications.md. Plan research rulings: plan-research/planner-rulings.md and plan-assembly-rulings.md.
Records: docs/superpowers/reviews/2026-10-07-caseworkers/ (commit each record as produced; run state only in .superpowers/)

Work map (plan section 2; ORDER S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> checkpoint -> S7 -> S8 -> S9 -> checkpoint -> S10):
- S1 matching helpers (CASEWORKER_ROLE defined in the leaf lib/caseworkers.ts; isCaseworkerRole, mentionsCaseworker, hasAiCaseworkerNote, isCaseworker; canonicalizer; KINDS_FOR_FIELD.organization; dashboard mirror + mirror test)
- S2 repo primitives WITH their fakes and parity tests (multi-clause expect + notDeleted, findAllByPhone/Email, setTypeIfCurrent, getRecipientDisplaysByIds, deleted:'any', fake unit paging)
- S3 services: contactClassification.ts (extracted from the PATCH), caseworkerConversion.ts (refusals, preview, make, dismiss, organization derivation/carry, thread plan, suggestion sweep, side effects), possibleCaseworkers.ts
- S4 routes and wiring: caseworker-review routes, possible-caseworkers read, PATCH 409 caseworker_use_conversion, organization D5, server-owned key refusals, type_source stamp, importer guard
- S5 organization across the org-list server (usage inUse/kindLocked, rewrites, Not on the list rows, resolve kind, /check kinds, dev seam)
- S6 shares server (partner seeds/explicit recipients, both fan-out mint sites, recipient rows type/role, preview voucher facts, timeline wording)
- S7 dashboard org UI for both kinds; S8 dashboard contacts (KindPicker, forms, Unknown card, More actions, CaseworkerDialog, PartnerFile, Caseworkers page, nav); S9 dashboard shares (PartnerFile Properties sent + Send, neutral wording)
- S10 e2e specs and pins, GLOSSARY, RUNBOOK, selectors, issues; Task 10.14 = sync main once + the five gates; then live self-QA (hermetic lane) and the handback

Watch items:
- PARALLEL BRANCH fix/org-settings-layout (W:\tmp\org-settings-layout, NOT merged) rewrites the Settings org page (OrgListSection, NotOnListSection, new OrgDetailPanel/OrgListPane) and the Settings widths. Cameron's ruling: branch B keeps priority and merges FIRST; that branch absorbs the overlap at its own main sync. Build S7 against main's CURRENT Settings code; never touch that worktree. If it has merged to main before Task 10.14, STOP at the sync and report (do not resolve a page rewrite silently).
- E2E rules (plan section 0): assert only run-unique rows, never a count or empty state on the Possible list or Caseworkers tab; never convert or dismiss a seeded contact (Tasha and Marcus are read-only preview-refusal fixtures); the share e2e mints its own consented partner and never pre-opens its conversation.
- Every task ends green: e2e pins move WITH their copy (S6.5, S9.x); perf/mutation pins move with S8.1/S8.13; a typed fake changes in the same task as its repo.
- Non-ASCII bytes in existing lines: follow plan section 0's glyph legend; never type a `\u` escape through the Edit tool; never PowerShell Get-Content/-replace/Set-Content.
- DynamoDB Local is SHARED with Cameron's local dev data: `npm run db:start` if stopped; never restart, stop or remove the container. On a red DynamoDB-backed suite, AGENTS.md's re-run-and-compare; any `[dynamoAdmin]` line is a real container fault.
- Never test against Cameron's live :5174 / :8080; Playwright only through the e2e workspace; never edit source while this worktree's e2e runs; copy e2e/.artifacts/test-results BEFORE any re-run (Playwright clears it).
- No deploy, Terraform, secret push, SSM write, or script against dev/prod. No merge (the human merges).
- Do NOT edit the Improvements Tracker (Google Doc). The handback carries a two-to-three-sentence note for tracker #19 in neutral third person (no "you").
- Boundaries: #6 owns blast audience rules (filters stay tenant-only); #14 (/join dropdown) comes later.
- MODELS (Cameron, 2026-10-07): the orchestrator runs on Opus 5.5 and every child is dispatched with an EXPLICIT model - opus for implementers, explorers, researchers and reviewers, sonnet only for trivial mechanical sweeps. No Fable in the build. Never let a child inherit the parent model.

Gates (bare, from W:\tmp\caseworkers, real exit codes, never piped; AGENTS.md "Required completion gates"; plan Task 10.14):
1. npm run typecheck
2. npm test  (DynamoDB Local up)
3. npm run smoke
4. timeout 2700 npm run e2e  (Git Bash coreutils timeout; on a timeout tree-kill the lane launcher, `npm run e2e:stop`, confirm the lane's ports are free; judge failures outside this feature against a main baseline; socket exhaustion (blank first paint / ERR_NO_BUFFER_SPACE) is environmental - let sockets drain, preserve artifacts, re-run)
5. npx eslint over the branch's touched .ts/.tsx files against the EXPLICIT merge base (`git merge-base main HEAD`), REFUSING an empty list (an empty list lints the whole repo); attribute errors by file+rule against the merge base.

Post-merge obligations already known (Cameron's, never an agent's):
- No Terraform, table, index, env var, secret or script. Deploy only.
- RUNBOOK gains the caseworker conversion's repair and how to put a mistaken conversion back (Task 10.11).
- A2P coverage of property shares to caseworkers is unconfirmed; Sam owns the question (filed in Task 10.12). Cameron ruled B ships partner shares anyway.
- fix/org-settings-layout merges after this branch and absorbs the Settings overlap.
