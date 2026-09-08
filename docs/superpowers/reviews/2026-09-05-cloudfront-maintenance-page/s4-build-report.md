# S4 build report: operator handoff documentation

## Delivered

- `RUNBOOK.md`: inserted `### CloudFront maintenance fallback (502/504)` immediately after the shared deploy/secrets guidance and before `### Dev modes (npm run dev): live / --mock / --local`.
- `e2e/README.md`: added Terraform >=1.15 as setup prerequisite 3, renumbered the bundled-browser and verify prerequisites, and inserted `### Maintenance-page verification` after the two-mode helper and Windows lifecycle note and before `## Page performance profiler (on demand)`.
- The runbook records the independent private-S3 fallback, exact 502/504 status preservation, typed-503/body preservation, distribution-wide scope, fresh GET `/` recovery, direct-object limitation, separately authorized hosted-substitution proof, dev-before-prod guarded plan/apply sequence, no app redeploy, and mapping-only rollback.
- The local section names the actual Terraform console/catalog renderer, the three focused commands, ordinary hermetic browser scope and limitation, six named broken infrastructure copies, copied dev/prod composition validation, a locked provider mirror option, and the no-live-AWS boundary.

## Verification

- Inspected the changed prose against approved plan S4 and the live S1-S3 artifacts.
- ASCII check: all added and touched lines in the three owned paths are ASCII-only.
- No aggregate or full gates ran. Full gates, final main sync, independent reviews, and visual self-QA remain orchestrator-owned next phases.

## Operational boundary

This documentation does not authorize Terraform plan/apply, AWS mutation, outage exercise, deployment, merge, or cleanup. Hosted substitution remains unverified until a separately authorized dev application-error observation is captured.
