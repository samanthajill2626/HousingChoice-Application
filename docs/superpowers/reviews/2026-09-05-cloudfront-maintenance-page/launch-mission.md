# Maintenance page build launch

Prepared 2026-09-07. Spec approved; implementation plan independently reviewed through R2. Cameron authorized AUTO on 2026-09-07: "Lets use auto mode, with a 15 minute checkin timer". Build and supervision are authorized; merge and live infrastructure activation remain separate actions.

AUTO: dispatch and supervise the build-orchestrator in this task. MANUAL: provide the same mission with its operating-manual instruction for a separate human-managed task. Merge and live AWS activation remain separate actions.

```text
# MISSION: CloudFront maintenance page
Worktree: W:\tmp\cloudfront-maintenance-page
Branch: codex/cloudfront-maintenance-page (cut from main @f82c149cf8523cbdb2f6d6ff3bdedc6583951ab4)
Profile: W:\tmp\cloudfront-maintenance-page\.codex\feature-mission.profile.md
Spec: W:\tmp\cloudfront-maintenance-page\docs\superpowers\specs\2026-09-05-cloudfront-maintenance-page-design.md
Plan: W:\tmp\cloudfront-maintenance-page\docs\superpowers\plans\2026-09-07-cloudfront-maintenance-page.md
Design review: spec R2, plan R2 (terminal precision correction included).
Spec adjudications: W:\tmp\cloudfront-maintenance-page\docs\superpowers\reviews\2026-09-05-cloudfront-maintenance-page\spec-adjudications.md
Plan adjudications: W:\tmp\cloudfront-maintenance-page\docs\superpowers\reviews\2026-09-05-cloudfront-maintenance-page\plan-adjudications.md
Records: W:\tmp\cloudfront-maintenance-page\docs\superpowers\reviews\2026-09-05-cloudfront-maintenance-page\

Work map:
S1 - Static edge copy, actual Terraform HTML template and provider-free rendering tests.
S2 - Dedicated private S3/OAC origin, exact route, 502/504 mappings, mocked contracts, six fault probes and copied dev/prod root validation.
S3 - Hermetic browser GET/POST recovery, narrow/desktop layout, keyboard and API error preservation.
S4 - Operator runbook, local prerequisites, full gates, independent review and visual self-QA.

Watch items:
- S1 before S2/S3; S4 after both. Use existing worktree; install its missing dependencies with npm ci.
- Only 502/504, preserve original status, zero error TTL; never map 503 or 200. Existing typed 503 readers stay intact.
- Copy escapes at all five text/title sites. No JavaScript, external assets or app dependency; Try again is GET / with no original query/body replay.
- Exact single-object CloudFront ARN grant, private bucket and signed OAC. Distribution depends on object, policy depends on distribution; no policy cycle.
- Preserve all app/media origin secrets, OAC, methods, caching and forwarding. Use existing viewport helper; no live ports 5174/8080.
- Local mocked/error-document proof is not hosted substitution proof. No AWS writes, live plan/apply, outage induction, deploy changes, merge or cleanup.
- Terraform >=1.15 is required for local tests; no new npm or production dependency. Do not skip a missing tool or replace the real template renderer.
- Coordinate shared DynamoDB and worktree ownership; no competing suites during self-QA. Commit records as produced, explicit paths and model coauthor trailer.
- AUTO supervision uses a 15-minute check-in timer per Cameron. This is a liveness/progress check, never a deadline or automatic termination of healthy work. Report actionable questions or failures promptly.

Gates (bare, from this worktree):
npm run typecheck
npm test
npm run smoke
npm run e2e
Touched-file ESLint from main...HEAD, explicit JS/TS paths, nonempty-list guard and baseline ratchet.
Additional: node scripts/check-maintenance-infra.mjs; touched Terraform fmt -check; node --check scripts/check-maintenance-infra.mjs.
Sync main once before final gates; report subsequent drift. Parent independently verifies handback on a quiet tree.

Post-merge obligations:
Human-controlled dev then prod plan/apply, healthy first provisioning, propagation/direct page/health checks, separately authorized actual dev substitution and recovery evidence. No app redeploy required. Rollback only the two mappings, retaining page infrastructure. Return UNMERGED (human gate).
```
