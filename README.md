# HousingChoice

HousingChoice is a text-first tenant-placement engine for the Section 8 (Housing Choice Voucher) program: tenants and landlords interact primarily over SMS, and the platform handles intake, matching, and placement workflows. Phase 0 builds the foundations only — repo scaffolding, the Express/worker monolith skeleton, local dev loop, Terraform-managed AWS infrastructure, and deploy/observability plumbing. The product itself (Twilio messaging, AI, matching, OAuth) begins in Phase 1.

**Stack (locked):** Node.js 24 LTS + Express + TypeScript modular monolith — one `app` process (API/webhooks/dashboard API) and one `worker` process (jobs), one codebase, one ARM64 Docker image, running on EC2 t4g.small behind CloudFront. React + Vite dashboard. AWS us-east-1, single account, two Terraform stacks (`hc-dev-` / `hc-prod-`), DynamoDB on-demand with PITR, Parameter Store for all config/secrets. No CI/CD — all ops via npm scripts.

## Status

**Phase 0** — foundations.

| Milestone | Status | Description |
|---|---|---|
| M0.0 | ✅ | Decisions locked: TypeScript, Vitest, us-east-1, Node 24 |
| M0.1 | ✅ | Repo scaffold: workspaces, lint/tsconfig, placeholder entrypoints, Docker/compose, seams (git remote: Azure, to be added) |
| M0.2 | ✅ | Express 5 server + locked middleware chain, pino logging core (correlation context + orphan-log detection), OTel seam, jobs.enqueue()/defineJobHandler() gates with scheduler adapters |
| M0.3 | ✅ | Full local dev loop: `npm run dev` = DynamoDB Local (auto-start) + table create/seed + app & worker in watch mode; 9-table contract in `app/src/lib/tables.ts` |
| M0.4 | ✅ | Terraform baseline applied to dev (54 resources): network, EC2, DynamoDB x9, S3, ECR, SES, Parameter Store, CloudFront, observability, budget; account-guarded `plan`/`apply`/`drift`; drift clean. Prod stack applies in M0.6 |
| M0.5 | ✅ | Deploy path live: `deploy:dev` builds the ARM64 image → pushes ECR → rolls EC2 via SSM Run Command (.env hydrated from Parameter Store, health-check gate, prune on success), container logs ship to CloudWatch via the awslogs driver, rollback proven via `-- --tag` |
| M0.6 | ✅ | Prod stack applied (54 resources, drift-clean) and live: dev's exact image promoted to prod via `deploy:prod -- --promote <tag>` (ECR manifest copy, identical digest — prod is never rebuilt), CloudFront `/health` 200. Operator manual in [RUNBOOK.md](./RUNBOOK.md); §11.2 exit checklist in [PHASE0_EXIT.md](./PHASE0_EXIT.md) |

**Phase 0 is complete.** Day-2 operations live in [`RUNBOOK.md`](./RUNBOOK.md) (deploy/promote/rollback, Logs Insights queries, drift, the 8 alarms, honest idle-cost estimate, hardening backlog); the doc-§11.2 exit status is [`PHASE0_EXIT.md`](./PHASE0_EXIT.md) (18 ✅ / 3 ⚠️ / 0 ❌).

## Deviations from the Architecture Doc (v2.12)

This table is the changelog of every place the build intentionally deviates from `HousingChoice_Architecture_and_Build_Plan.docx` (v2.12). **Contributors: any time the build departs from the doc, add a row here in the same change.**

| Date | Area | Doc says | We chose | Why |
|---|---|---|---|---|
| 2026-06-11 | Runtime | Node.js 22 LTS | Node.js 24 LTS | Node 22 is maintenance-mode (EOL Apr 2027); Node 24 is active LTS through Apr 2028, fully compatible with the Phase 0 stack, and matches local dev. |
| 2026-06-11 | Terraform state | One shared state bucket, created manually as a one-time step | Two per-env buckets (`hc-dev-tfstate-…`, `hc-prod-tfstate-…`) created by the idempotent, account-guarded `npm run bootstrap` | Per-stack IAM isolation (prod role can't read dev state), names follow the `hc-dev-`/`hc-prod-` prefix rule, and nothing infrastructure-shaped is typed by hand. |
| 2026-06-12 | Source hosting | GitHub (private repo) | Azure DevOps | Org standard. Remote being configured — until the first push lands, this machine holds the only copy of the repo. |
| 2026-06-11 | Admin access | IAM admin via Identity Center, MFA on | Long-lived IAM-user keys (CLI profile `housingchoice`); MFA on root only, IAM-user MFA deferred | Solo operator; daily `aws sso login` rejected as unacceptable dev friction. Mitigations: account-ID guard in all mutating scripts, named profile (default chain never used), IAM-user MFA tracked as a RUNBOOK hardening item. |

## Repo layout

```
app/                  @housingchoice/app — the monolith (both processes)
  src/
    index.ts          app process entrypoint (Express server, M0.2)
    worker.ts         worker process entrypoint (job registry + keep-alive, M0.2)
    routes/           Express routers (health since M0.2)
      webhooks/       inbound provider webhooks — seam for Twilio etc. (Phase 1)
    middleware/       the locked Express middleware chain (correlation, request logger, origin secret)
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
| `npm run dev` | Full local loop: starts DynamoDB Local, creates+seeds the 9 tables, then runs app (`:8080`) + worker concurrently in watch mode (Ctrl-C stops the processes; container stays up) | M0.3 |
| `npm run dev:app` / `dev:worker` | Just the app / just the worker in watch mode (no DB orchestration) | M0.3 |
| `npm run db:start` | Start (or create) the `hc-dynamodb-local` container and wait until port 8000 answers — idempotent | M0.3 |
| `npm run db:stop` | Stop the container (in-memory data is discarded) | M0.3 |
| `npm run db:create` | Create all 9 tables from `app/src/lib/tables.ts` against `DYNAMODB_ENDPOINT` (default `http://localhost:8000`); existing tables skipped | M0.3 |
| `npm run db:seed` | Write fixed-ID fake seed data exercising every GSI — idempotent, safe to re-run | M0.3 |
| `npm test` | Vitest across all workspaces (DynamoDB integration suite auto-skips when DynamoDB Local isn't running) | M0.1 |
| `npm run lint` | ESLint (flat config), incl. the streams-only `readFileSync` ban in app/src | M0.1 |
| `npm run typecheck` | `tsc --noEmit` across workspaces | M0.1 |
| `npm run bootstrap` | One-time account bootstrap: creates/enforces the two versioned, encrypted, public-blocked TF state buckets — idempotent and account-guarded; `bootstrap:check` is the read-only dry run. The ONLY infra not managed by Terraform (backend chicken-and-egg). | M0.4 |
| `npm run gen:tables` | Regenerate `infra/envs/{dev,prod}/tables.auto.tfvars.json` from `app/src/lib/tables.ts` (the DynamoDB source of truth). Deterministic output — commit the JSON alongside any tables.ts change. `plan`/`drift` run the same generator in `--check` mode and FAIL if the files are stale; never hand-edit them | M0.4 |
| `npm run plan` | Terraform plan for a stack (`-- dev` default, `-- prod`): account-guard first, then refuses to run if the generated DynamoDB tfvars are stale (`gen:tables --check`), idempotent `terraform init`, then `terraform plan -out=tfplan` — the saved plan is what apply executes | M0.4 |
| `npm run apply` | Applies ONLY an existing `tfplan` saved by a prior `npm run plan` for that stack (refuses otherwise), then deletes the plan file so a stale plan can never be re-applied | M0.4 |
| `npm run drift` | `terraform plan -detailed-exitcode` drift check: exit 0 = clean, exit 2 = "DRIFT DETECTED" with the diff printed | M0.4 |
| `npm run deploy:dev` | Build+push the ARM64 image to ECR, then roll the dev box via SSM Run Command with a health-check gate and CloudFront verification. `-- --tag <t>` re-deploys an EXISTING ECR tag (the rollback path — no build); `-- --list` prints the last 10 ECR tags + the current `DEPLOYED_TAG` | M0.5 |
| `npm run deploy:prod` | Same flow against the prod stack. **The prod path is `-- --promote <dev-tag>`** (M0.6): verifies the tag exists in `hc-dev-app`, copies it into `hc-prod-app` at the registry level (manifest + blobs, digest-verified — no docker pull/push, never a rebuild), then runs the normal existing-tag deploy. `--tag`/`--list` work as in dev | M0.5 |
| `npm run secrets:push` | Push operator-managed secrets (`-- dev` or `-- prod`): parses the gitignored `.env.<env>` at the repo root and writes each key as SecureString `/hc/<env>/app/<KEY>` (overwrite; unchanged values skipped). Account-guarded; Terraform/deploy-managed keys are refused; values only ever print masked. Template: the "Deployed secrets" section of `.env.example` | Phase 1 |
| `npm run secrets:check` | Read-only drift report for the same keys (`-- dev` or `-- prod`): missing/differs/matches per key (masked), plus any unexpected extra params under `/hc/<env>/app/`. Exit 0 = in sync, 2 = drift, 1 = error | Phase 1 |

## Infrastructure

Two identical Terraform stacks — `hc-dev-` and `hc-prod-` — composed from the same modules in `infra/modules/`; the env roots (`infra/envs/dev`, `infra/envs/prod`) differ only in backend bucket and a small `locals` block (env name, log retention 30d/90d). Each stack has its OWN S3 backend (`hc-dev-tfstate-938565869261` / `hc-prod-tfstate-938565869261`, created by `npm run bootstrap`) with S3-native lockfile locking. **The AWS console is read-only — every infrastructure change goes through `npm run plan` / `npm run apply`** (both account-guarded to 938565869261 via the `housingchoice` profile; the default credential chain is never used).

Modules (all resources name-prefixed `hc-<env>-`, region us-east-1):

| Module | What it manages |
|---|---|
| `network` | Dedicated VPC (10.0.0.0/16), one public subnet (us-east-1a), IGW, route table; app SG admits TCP 8080 only from the CloudFront origin-facing prefix list — no SSH anywhere (SSM only) |
| `dynamodb` | The 9 on-demand tables, GENERATED from `app/src/lib/tables.ts` (the contractual source of truth): `npm run gen:tables` writes `infra/envs/*/tables.auto.tfvars.json` (committed; auto-loaded; never hand-edited) and the module `for_each`es over it — `plan`/`drift` fail if the JSON is stale. PITR + deletion protection on all, GSIs project ALL, streams on messages/cases, TTL on matches |
| `s3_media` | Versioned private media bucket (`hc-<env>-media-<account>`), SSE-S3, full public-access block |
| `ecr` | App image repository (`hc-<env>-app`), scan-on-push, lifecycle keeps last 10 images |
| `ses` | Sender email identity (sandbox; apply sends a verification email) |
| `params` | Parameter Store under `/hc/<env>/app/`: generated `CF_ORIGIN_SECRET` (SecureString) + LOG_LEVEL / TABLE_PREFIX / PORT / NODE_ENV — M0.5's deploy hydrates `.env` from this path; Terraform owns all values |
| `ec2` | t4g.small (AL2023 ARM64), EIP for a stable origin DNS, IMDSv2, encrypted gp3 10GB root (deploys prune old images after each health-gated roll — accumulated image history, not the running container, is what fills small disks), `hc-<env>-instance` role (SSM core + least-privilege Dynamo/S3/SSM/ECR/logs/metrics), user-data installs docker + compose only |
| `cloudfront` | The https entry point (default cert, price class 100, HTTP/2+3): origin = the EIP public DNS on HTTP:8080; `/api/*` + `/webhooks/*` and (for now) the default behavior all use CachingDisabled |
| `observability` | `/hc/<env>/app` + `/hc/<env>/worker` log groups, OrphanLogs (missing correlationId) and ErrorLogs (pino level ≥ 50) metric filters + alarms, EC2 status-check and disk alarms, `hc-<env>-alerts` SNS topic (email), CloudWatch dashboard |
| `budget` | Monthly USD 40 cost budget; email at 80% actual / 100% forecasted |

**Origin-secret flow:** Terraform generates a random 32-char secret and stores it as SecureString `/hc/<env>/app/CF_ORIGIN_SECRET`; CloudFront stamps it on every origin request as the `x-origin-verify` header; app middleware rejects requests without it (`GET /health` exempt). Combined with the SG's CloudFront-only ingress, the instance never serves anyone but CloudFront.

Notes: the disk-used alarm reads the CloudWatch agent's `disk_used_percent` — the agent is **not yet installed** (tracked in the [RUNBOOK hardening backlog](./RUNBOOK.md#security--hardening-backlog)), so that alarm treats missing data as OK and cannot fire yet. SNS/SES email subscriptions require one-time confirmation clicks after the first apply.

## Deploy & rollback

`npm run deploy:dev` (account-guarded like every mutating script) does, in order:

1. **Build & push** — tags the image `dev-<git short sha>-<UTC timestamp>` and runs `docker buildx build --platform linux/arm64 --provenance=false --push` to ECR (a dirty working tree only warns — solo dev). `--provenance=false` keeps images single-manifest so ECR lifecycle counting and `--list` stay sane.
2. **Roll the instance** — one SSM Run Command (base64-encoded payload; no SSH anywhere): ECR login with the instance role, hydrate `/opt/hc/.env` (chmod 600) from everything under `/hc/<env>/app/` plus computed `HC_IMAGE` / `HC_LOG_GROUP_*` / `AWS_REGION`, write `/opt/hc/docker-compose.yml` from the repo copy (the repo file is the single source of truth), `docker compose pull && up -d --remove-orphans`.
3. **Health-check gate** — `curl localhost:8080/health` (up to 12×5s), then both containers must be `running` and the worker must show its boot log line. **Only after** the gate passes does the script `docker image prune -af` (the 10GB root volume depends on this). On failure the command exits non-zero with the last 50 log lines dumped and the operator is pointed at the rollback one-liner — the previous image is NOT pruned.
4. **Operator-side verification** — `https://<cloudfront domain>/health` must return 200, then the released tag is written to SSM `/hc/<env>/app/DEPLOYED_TAG` (the rollback pointer; unmanaged by Terraform on purpose).

**Rollback** is the same deploy with an existing image (no build):

```powershell
npm run deploy:dev -- --list                 # see recent tags + what's deployed
npm run deploy:dev -- --tag <previous-tag>   # roll back (verified against ECR first)
```

**Prod promotes, never rebuilds** (M0.6, per the architecture doc): `npm run deploy:prod -- --promote <dev-tag>` copies the dev-verified image into `hc-prod-app` under the same tag at the ECR registry level (manifest + blobs; the prod digest is hard-verified to equal dev's before the roll), then runs the identical SSM/health-gate/CloudFront flow. Full operating procedures — including rollback one-liners, Logs Insights queries, drift response, and what each alarm means — are in [`RUNBOOK.md`](./RUNBOOK.md).

Additive notes (not deviations — the doc's deploy flow is unchanged): container logs ship straight to CloudWatch via the docker `awslogs` log driver (daemon-side, using the instance role's `logs:CreateLogStream/PutLogEvents` on `/hc/<env>/app` + `/hc/<env>/worker`; stream names `app/<container-id>` / `worker/<container-id>`), replacing the interim json-file config; and `DEPLOYED_TAG` exists so "what is running right now" is answerable without touching the box.

## Local development

Prerequisite: **Docker Desktop running** (DynamoDB Local is the only local container). Then the whole loop is one command:

```powershell
npm run dev
```

This (1) starts (or creates) the `hc-dynamodb-local` container (`amazon/dynamodb-local`, port 8000, `-sharedDb -inMemory`), (2) creates the 9 tables (`hc-local-*`), (3) writes idempotent seed data, and (4) runs the app on `http://localhost:8080` and the worker, both under `tsx watch` with prefixed colorized logs. Edit a file → instant reload; every request logs a correlated JSON line (`requestId`/`correlationId`). Ctrl-C stops app+worker; the container stays up.

Query DynamoDB Local from PowerShell (DynamoDB Local accepts any credentials — dummy values satisfy the CLI):

```powershell
$env:AWS_ACCESS_KEY_ID = 'local'; $env:AWS_SECRET_ACCESS_KEY = 'local'
aws dynamodb scan --table-name hc-local-contacts --endpoint-url http://localhost:8000 --region us-east-1 --no-cli-pager
```

(Or use a configured `--profile` instead of the env vars; the values never matter locally.)

**Data is in-memory:** stopping/restarting the container wipes all tables. `npm run dev` (or `npm run db:create && npm run db:seed`) rebuilds everything in seconds.

The 9-table schema (keys/GSIs are contractual) lives in [`app/src/lib/tables.ts`](./app/src/lib/tables.ts) — the single source of truth that M0.4 Terraform must mirror.

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
