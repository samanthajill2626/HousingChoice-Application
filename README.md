# HousingChoice

HousingChoice is a text-first tenant-placement engine for the Section 8 (Housing Choice Voucher) program: tenants and landlords interact primarily over SMS, and the platform handles intake, matching, and placement workflows. Phase 0 builds the foundations only — repo scaffolding, the Express/worker monolith skeleton, local dev loop, Terraform-managed AWS infrastructure, and deploy/observability plumbing. The product itself (Twilio messaging, AI, matching, OAuth) begins in Phase 1.

**Stack (locked):** Node.js 24 LTS + Express + TypeScript modular monolith — one `app` process (API/webhooks/dashboard API) and one `worker` process (jobs), one codebase, one ARM64 Docker image, running on EC2 t4g.small behind CloudFront. React + Vite dashboard. AWS us-east-1, single account, two Terraform stacks (`hc-dev-` / `hc-prod-`), DynamoDB on-demand with PITR, Parameter Store for all config/secrets. No CI/CD — all ops via npm scripts.

## Status

**Phase 0** — foundations.

| Milestone | Status | Description |
|---|---|---|
| M0.0 | ✅ | Decisions locked: TypeScript, Vitest, us-east-1, Node 24 |
| M0.1 | ✅ | Repo scaffold: workspaces, lint/tsconfig, placeholder entrypoints, Docker/compose, seams (git remote: Azure, to be added) |
| M0.2 | ☐ | Express server + locked middleware chain, pino logging core, jobs.enqueue()/defineJobHandler() gates |
| M0.3 | ☐ | Full local dev loop: multi-process dev, DynamoDB Local, repos layer |
| M0.4 | ☐ | Terraform: both stacks (network, EC2, DynamoDB x9, S3, ECR, SES, Parameter Store, CloudFront, observability, budget), `plan`/`apply`/`drift` |
| M0.5 | ☐ | Deploy path: buildx ARM64 image → ECR → EC2, .env hydration from Parameter Store, `deploy:dev`/`deploy:prod` |
| M0.6 | ☐ | Prod stack apply, same-image-tag deploy, RUNBOOK.md (deploy/rollback/logs/drift/alarms/cost), Phase 0 exit checklist |

## Deviations from the Architecture Doc (v2.12)

This table is the changelog of every place the build intentionally deviates from `HousingChoice_Architecture_and_Build_Plan.docx` (v2.12). **Contributors: any time the build departs from the doc, add a row here in the same change.**

| Date | Area | Doc says | We chose | Why |
|---|---|---|---|---|
| 2026-06-11 | Runtime | Node.js 22 LTS | Node.js 24 LTS | Node 22 is maintenance-mode (EOL Apr 2027); Node 24 is active LTS through Apr 2028, fully compatible with the Phase 0 stack, and matches local dev. |

## Repo layout

```
app/                  @housingchoice/app — the monolith (both processes)
  src/
    index.ts          app process entrypoint (placeholder until M0.2)
    worker.ts         worker process entrypoint (placeholder until M0.2)
    routes/           Express routers (M0.2+)
      webhooks/       inbound provider webhooks — seam for Twilio etc. (Phase 1)
    services/         business logic, vendor-agnostic
    adapters/         thin wrappers around external systems (Twilio, EventBridge, SES, AI) — only place vendor SDKs are imported
    repos/            DynamoDB data access (M0.3)
    jobs/             job handlers, registered via defineJobHandler() (M0.2+)
    lib/              shared utilities (correlation context, logging, etc.)
  test/               vitest tests
dashboard/            React + Vite dashboard (shell only in Phase 0; owned separately)
infra/
  modules/            shared Terraform modules (M0.4)
  envs/dev/           hc-dev- stack (own S3 backend state, use_lockfile = true)
  envs/prod/          hc-prod- stack (own S3 backend state, use_lockfile = true)
scripts/              ops scripts (npm-script driven; no CI/CD)
docker-compose.yml    PROD composition that runs on the EC2 instance
Dockerfile            single multi-stage ARM64 image for app + worker
```

## npm scripts

| Script | What it does | Active since |
|---|---|---|
| `npm run dev` | Runs the app workspace in watch mode (full multi-process dev loop arrives in M0.3) | M0.1 |
| `npm test` | Vitest across all workspaces | M0.1 |
| `npm run lint` | ESLint (flat config), incl. the streams-only `readFileSync` ban in app/src | M0.1 |
| `npm run typecheck` | `tsc --noEmit` across workspaces | M0.1 |
| `npm run plan` | Terraform plan for a stack | M0.4 (stub until then) |
| `npm run apply` | Terraform apply for a stack | M0.4 (stub until then) |
| `npm run drift` | Detect infra drift vs. state | M0.4 (stub until then) |
| `npm run deploy:dev` | Build/push ARM64 image, hydrate .env from Parameter Store, roll EC2 dev | M0.5 (stub until then) |
| `npm run deploy:prod` | Same, prod stack | M0.5 (stub until then) |

## Local toolchain

| Tool | Required | Check |
|---|---|---|
| Node.js | >= 24 | `node --version` |
| Docker Desktop (with buildx) | current | `docker --version` and `docker buildx version` |
| Terraform | >= 1.15 | `terraform version` |
| AWS CLI | v2 | `aws --version` |
| git | current | `git --version` |

## Binding engineering guidelines

These five are binding for all Phase 0+ code:

1. **Streams only on media paths.** All file movement uses `stream.pipeline`; whole-file buffers are forbidden. `readFileSync` is banned in `app/src` by lint (`no-restricted-syntax`).
2. **Locked Express middleware order.** Correlation-ID → redacted light logger → CloudFront origin-secret validator (`/health` exempt) → body parsers with raw-body capture → routes. Do not reorder or insert ahead of the chain.
3. **Async context envelopes.** ALL job traffic goes through `jobs.enqueue()` / `defineJobHandler()` — never raw queue/scheduler calls. Correlation context and `traceparent` are stamped into every payload. One-off EventBridge schedules always set `ActionAfterCompletion: DELETE`.
4. **Errors are first-class logs.** Every error log carries a correlation ID; an orphan-log metric alarm catches logs that don't.
5. **OpenTelemetry, not the EOL X-Ray SDK.** Tracing/metrics go through OTel to CloudWatch Application Signals (disabled locally via `OTEL_SDK_DISABLED=true`).

## Architecture references

- `..\HousingChoice_Architecture_and_Build_Plan.docx` (v2.12) — the architecture and build plan this repo implements; deviations are logged above.
- [`PHASE0_KICKOFF_PROMPT.md`](./PHASE0_KICKOFF_PROMPT.md) — Phase 0 kickoff brief and milestone definitions.
