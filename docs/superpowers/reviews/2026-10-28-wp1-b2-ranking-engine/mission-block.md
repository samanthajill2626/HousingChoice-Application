# MISSION: WP1 B2a Ranking engine (Amendment No. 1, Work Package 1, slice 2a)

Worktree: W:\tmp\wp1-b2-ranking-engine  Branch: feat/wp1-b2-ranking-engine  (cut from main @404e039d)
Profile: W:\AI Projects\Housing Choice\HC Application\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md (rev 6, APPROVED by Cameron 2026-10-28)
Plan: docs/superpowers/plans/2026-10-28-wp1-b2a-ranking-engine.md (v5; sections 0-4 and 13 BINDING; rulings PR1-PR45 win over slice text)
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md (amended through section 20 item 14; charter decisions bind)
Records: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/ (intent.md holds Cameron's decisions verbatim)
Design review: spec R4 (63 findings, all accepted) - design-review/adjudications.md; plan R4 (round 1 four reviewers, rounds 2-4 continued; all findings accepted) - plan-review/plan-adjudications.md; drafter findings and the 36-item interface reconciliation - plan-drafts/   [REQUIRED]

Work map (strictly serial; each slice ends with its report in <records>/slices/ and its commits):
- S1 (plan 5)  The Notes box: toOneLine, filterNoteLines collapse + duplicate count, notesDuplicate, notes_updated_at by every writer, the PATCH notes_stale guard, the edit form's conflict panel, the staff_notes comments
- S2 (plan 6)  Foundations: every D19 config variable and its refusals (PR30 real tables), B1 list completeness, unitsRepo.getManyByIds, placementsRepo.hasActivePlacementForOtherTenant, matchesRepo, rankingRunsRepo (job, run, pointer, flag), the lean match row removed, the exclusion pins
- S3 (plan 7)  Pool and cards: pool, registries + classification test, cards, seen set + attach step, pair history, completeness, fingerprints, assembleRanking
- S4 (plan 8)  The model call: bands, capOf (PR29/PR40/PR45), cost, schema + shape test, parse, rubric r1, examples e1, prompt + pins, driver interface, fake/console/anthropic drivers, compile-check variants
- S5 (plan 9)  The job: claim/join/409, poll with expiry, lease, takeover, slots, fresh context, batches, match/run/pointer/flag writes, the event, worker poll, dev tick, e2e-session env
- S6 (plan 10) The read and the API: readRanking, rankings and admin routers, rate limit, the 150-tenant read budget
- S7 (plan 11) Dashboard and e2e: the Rankings tab, runs list, run detail, Rank this anchor, API client, event, every new e2e spec
- S8 (plan 12) Merge-gate scripts and docs: counterfactual check (+ --timing, offline tests), gate-run-commands.md, RUNBOOK, GLOSSARY, env examples, issues
- S9 (plan 13) Sync main once, the five gates, your independent review + fix wave + gates re-run, self-QA on a hermetic lane, the handback

Watch items: plan section 3, WI1-WI22 (each recorded in its slice report). Mission-specific traps:
- NO AGENT RUNS A REAL MODEL OR READS ANY API KEY (PR1). The compile check and the counterfactual check are Cameron's, at the end. `--dry-run` only with ANTHROPIC_API_KEY unset. Hand back "merge-ready PENDING Cameron's real-model runs".
- The plan was drafted offline (no node_modules); expected values in tests were worked by hand. A first RED->GREEN needing a one-value fix is normal; a fix that changes behavior or a ruling is a QUESTION, not a quiet edit.
- SDK typing of adaptive thinking / output_config.effort is UNVERIFIED (S4 C7): if typecheck rejects it, STOP and report the exact tsc error; never cast through unknown.
- PR30: tests that take the fake driver from config need a local DYNAMODB_ENDPOINT AND RANKING_DRIVER=fake.
- Six PR32 version pins start as 'PIN-ME' and are filled from S4's print command; record each in the S4 report.
- The shell cwd resets to the SHARED main checkout between calls: every git command carries -C W:/tmp/wp1-b2-ranking-engine.
- Never edit source while this worktree's e2e runs; never test against :5174 / :8080.
- No named-flake re-run list exists (AGENTS.md): a named e2e failure is a regression; npm test DynamoDB-Local failures are adjudicated by re-run-and-compare against the merge base.

Gates (bare, real exit codes, from the worktree, on a quiet tree):
1. npm run typecheck
2. npm test   (DynamoDB Local up; check env for an exported AWS_ACCESS_KEY_ID first)
3. npm run smoke
4. npm run e2e
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')   (attribute by baseline at the merge base; name pre-existing errors)
Plus the isolated read budget: RANKING_READ_BUDGET=1 on the S6 budget test file alone (PR24).

Post-merge obligations already known: no infra, no Terraform, no new table or index. Cameron's three real-model runs before merge (gate-run-commands.md). Before deploy: ANTHROPIC_API_KEY present in dev and prod (required at startup now); the new env keys follow the RUNBOOK's sync-copy-push-check step (PR35/PR39). Ranking is live in an environment as soon as it deploys (no switch).
