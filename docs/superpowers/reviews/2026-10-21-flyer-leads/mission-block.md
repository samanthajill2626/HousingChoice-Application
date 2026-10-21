# MISSION: Flyer trim and flyer / join leads (Sam's 2026-10-21 flyer feedback + tracker #13 + subzone match)
Worktree: W:\tmp\flyer-leads  Branch: feat/flyer-leads  (cut from main @b7959e2a)
Profile: W:\AI Projects\Housing Choice\HC Application\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-21-flyer-leads-design.md (rev 6 APPROVED, plus section 7 plan-time amendments)
Plan: docs/superpowers/plans/2026-10-21-flyer-leads-plan.md (v3 FINAL, 26 tasks)
Design review: spec R4 (the cap) + Cameron's gate answers - docs/superpowers/reviews/2026-10-21-flyer-leads/design-review/adjudications.md; plan R2 (terminal) - docs/superpowers/reviews/2026-10-21-flyer-leads/plan-review/adjudications.md   [REQUIRED]
Records: docs/superpowers/reviews/2026-10-21-flyer-leads/ (intent.md is the acceptance brief; slice reports go to slices/S<n>-report.md, committed as produced)
Work map (build order S1 -> S2 -> S3 -> S4 -> S5 -> S6, AR4):
- S1 (Tasks 1.1-1.2) app: the flyer projection drops the ten trimmed keys and their fields are re-tagged Staff only (D1, D2); the similar-properties subzone match ignores case and spacing (D9).
- S2 (Tasks 2.1-2.6) dashboard: the tag mirror, the TaggedField note gate, the form props, PublicFlyer, the FlyerPage layout (address heading, Same-day tours, bolder authority line, detail rows) and the sign-up copy (D2, D3).
- S3 (Tasks 3.1-3.5) app: the shareLedgerKeys leaf, applyFlyerShareEntry with the current-decline refusal, the decline writers stamping shares_op (O1), the signed_up outcome through all five callers, the phone label for a nameless recipient (D7, D8, AR13).
- S4 (Tasks 4.1-4.5) app: the signed_up activity type and a consistent hasEventSince, the public router deps and harness wiring, the sign-up handler (existing / deleted / new contact, welcome for new contacts only, the pin, the 24-hour per-source check, the unread mark, the flyer entry), the audit fields (D4-D7).
- S5 (Tasks 5.1-5.3) dashboard: the green signed_up pin, the roster row's words, chip and action gate, groupSendRows, every outcome switch (D6, D8 renderers).
- S6 (Tasks 6.1-6.5) e2e repairs and the new flyer-leads spec (with a mutation RED), selectors.md, GLOSSARY and the deleted-contact issue note, the ONE main sync, then the five gates.
Watch items:
- Plan section 4 (AR1-AR16) overrides slice text; plan section 0's ground rules bind every task (slice reports, bullet-indent anchors, commit messages never in the worktree).
- S4's test code was read but not dry-run (S3's was typechecked): expect small compile fixes at S4's RED steps (plan review R1 #7).
- The dashboard mirror drift test is red between S1's Task 1.1 commit and S2's Task 2.2 - expected there, nowhere else.
- The harness fake reuses only OPEN threads; the touch-before-increment order is pinned by spies (S4), not by the fake.
- Every new sign-up now leaves an unread thread and a signed_up pin: e2e specs that count unread rows lane-wide must reseed first (S6 section B).
- An old public flyer bundle crashing on the new payload is ACCEPTED (spec D1) - add no compatibility code.
- The AGENTS.md named-flake list is EMPTY: a named-spec e2e failure is a regression. The known open `e2e-blank-first-paint-at-sign-in` issue: re-run the file alone and record a sighting.
- Never edit source or commit while this worktree's e2e runs. Never test against :5174 / :8080. DynamoDB Local may be started, never restarted.
- No merge to main, no deploy, no infra, no cleanup - all Cameron's.
Gates (bare, from W:\tmp\flyer-leads, after the one main sync in Task 6.5; never piped; hard outer timeout on a suite that can wedge):
1. npm run typecheck
2. npm test (run `env | grep '^AWS_'` first; if any is exported, `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test`; any `[dynamoAdmin]` line is a real fault - capture it)
3. npm run smoke
4. npm run e2e
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') - skip if the list is empty; attribute errors by baseline at the merge base
Post-merge obligations already known: none expected (no infra, migration, backfill, dependency or env change). If merged before the #11 + #12 deploy, both ship in one release. Sam reviews the sign-up copy after the build.
