# Phase 0 Exit Checklist

Checked against `documentation/HousingChoice_Architecture_and_Build_Plan.pdf` **§11.2 "Phase 0 —
Foundations (1–1.5 weeks)"** (v2.12), as directed by `PHASE0_KICKOFF_PROMPT.md` (M0.6). Date: 2026-06-11.

**Extraction note (honesty):** §11.2 is not a checkbox list — it is a four-row *Workstream / Builds /
Days* effort table. The checklist below quotes each workstream's "Builds" cell verbatim and
decomposes it into its individual items; nothing was dropped or added. The four "Builds" cells,
verbatim from the PDF:

1. *Repo & scaffolding:* "Monorepo, Express app + worker skeleton, dashboard shell, lint/test harness, Dockerfiles"
2. *Terraform baseline:* "VPC (public subnet), EC2 t4g + bootstrap, CloudFront/ACM, DynamoDB (PITR on), S3, ECR, SES, Parameter Store, budgets/alarms — one AWS account, separate dev/prod stacks"
3. *npm tooling:* "npm run dev / test / deploy / plan / apply scripts — no CI/CD per review"
4. *Local dev & logging core:* "npm-first dev env (DynamoDB Local container), seeds, pino + correlation IDs + error capture, async-boundary context envelopes (enqueue/handler wrappers, §9), OTel wiring, log groups/dashboards"

Legend: ✅ met · ⚠️ partially met (gap stated) · ❌ not met

## 1. Repo & scaffolding

| Item (§11.2 verbatim) | Status | Evidence |
|---|---|---|
| Monorepo | ✅ | npm workspaces `app` + `dashboard` in root `package.json` |
| Express app + worker skeleton | ✅ | `app/src/index.ts` / `app/src/worker.ts`; both run in prod (containers `running`, `worker ready` boot line) |
| dashboard shell | ✅ | `dashboard/` workspace (shell only — product UI is Phase 1 scope) |
| lint/test harness | ✅ | `npm run lint` exit 0; `npm test` 38/38 passing (7 files), 2026-06-11 |
| Dockerfiles | ✅ | Single multi-stage ARM64 `Dockerfile` + `docker-compose.yml` (one image, two processes — per doc §architecture) |

## 2. Terraform baseline

| Item (§11.2 verbatim) | Status | Evidence |
|---|---|---|
| VPC (public subnet) | ✅ | `infra/modules/network` — 10.0.0.0/16, public subnet us-east-1a, CloudFront-prefix-list-only SG, no SSH |
| EC2 t4g + bootstrap | ✅ | t4g.small × 2 (`i-0ad45daa858632001` dev, `i-087fd4eda3e2804c1` prod), user-data installs docker/compose, SSM-only access |
| CloudFront/ACM | ⚠️ | CloudFront live both envs (`d2w86qra2rq9iz` dev, `d3v3fqgxdcoxv9` prod, `/health` 200). **ACM/custom domain NOT done** — default `*.cloudfront.net` cert; deferred pending the doc's own §13 open question (where DNS for housingchoice.com lives). Tracked in RUNBOOK backlog. |
| DynamoDB (PITR on) | ✅ | 9 on-demand tables per env, PITR + deletion protection (`infra/modules/dynamodb`, mirrors `app/src/lib/tables.ts`) |
| S3 | ✅ | `hc-<env>-media-938565869261`, versioned, SSE, public-blocked |
| ECR | ✅ | `hc-dev-app` / `hc-prod-app`; same-digest image promoted (sha256:9ae40ac5…3279 in both) |
| SES | ✅ | Sender identity per env (`infra/modules/ses`) — sandbox mode; production-access exit is Phase 1 (RUNBOOK backlog) |
| Parameter Store | ✅ | `/hc/<env>/app/*` (CF_ORIGIN_SECRET SecureString, LOG_LEVEL, NODE_ENV, PORT, TABLE_PREFIX) + deploy-written DEPLOYED_TAG |
| budgets/alarms | ⚠️ | $40/mo budget + 8 alarms + dashboards exist and `OrphanLogs`/`ErrorLogs`/`StatusCheckFailed` are live. **Gaps:** disk alarm cannot fire (CloudWatch agent not installed → metric absent → `notBreaching`); `hc-prod-alerts` email subscription still `PendingConfirmation` (one click outstanding); orphan alarm trips transiently on every container boot (boot lines carry no correlationId). All three in RUNBOOK backlog. |
| one AWS account, separate dev/prod stacks | ✅ | Account 938565869261 only (hard guard in `scripts/lib/hcAws.mjs`); two stacks `hc-dev-`/`hc-prod-` with separate state buckets, both applied, both drift-clean (exit 0, 2026-06-11) |

## 3. npm tooling

| Item (§11.2 verbatim) | Status | Evidence |
|---|---|---|
| npm run dev / test / deploy / plan / apply scripts | ✅ | All in root `package.json`; `deploy:prod -- --promote <tag>` promoted dev's exact image to prod (CloudFront 200, 24 s); plus `drift`, `bootstrap`, `--tag` rollback, `--list` |
| no CI/CD per review | ✅ | No pipelines anywhere; all ops are operator-run npm scripts |

## 4. Local dev & logging core

| Item (§11.2 verbatim) | Status | Evidence |
|---|---|---|
| npm-first dev env (DynamoDB Local container) | ✅ | `npm run dev` = DynamoDB Local auto-start + table create + app/worker watch mode (`scripts/dev.mjs`) |
| seeds | ✅ | `npm run db:seed` — idempotent fixed-ID data exercising every GSI |
| pino + correlation IDs + error capture | ✅ | `app/src/lib/logger.ts` (mixin injects correlationId, redaction); prod log lines verified carrying `correlationId`/`requestId`; ErrorLogs metric+alarm on level ≥ 50 |
| async-boundary context envelopes (enqueue/handler wrappers, §9) | ✅ | `jobs.enqueue()` / `defineJobHandler()` stamp correlation context + traceparent into payloads (`app/src/jobs`, tested in `app/test/jobs.test.ts`) |
| OTel wiring | ⚠️ | SDK + http/express instrumentation wired and starts in both AWS envs (`app/src/lib/otel.ts`; `OTEL_SDK_DISABLED=true` only locally). **No exporter configured** — traces/metrics are exported nowhere; OTLP → CloudWatch Application Signals is an explicit TODO seam (`OTEL_EXPORTER_OTLP_ENDPOINT`). RUNBOOK backlog. |
| log groups/dashboards | ✅ | `/hc/<env>/app` + `/hc/<env>/worker` (30d/90d retention), metric filters, `hc-<env>-dashboard`; prod log flow verified post-deploy |

## Score

**21 items: 18 ✅ · 3 ⚠️ (CloudFront/ACM custom-domain half, budgets/alarms operational gaps, OTel exporter) · 0 ❌**

The three ⚠️ items are deliberate, documented deferrals — each has an owner row in
[`RUNBOOK.md`](./RUNBOOK.md#security--hardening-backlog) — not silent omissions. Also noted
honestly: idle cost computes to ~$33–34/mo for both stacks, above the kickoff's "~$25" expectation
(RUNBOOK § Costs has the breakdown and the do-nothing-for-now options).

## M0.6 deliverables (kickoff prompt)

| Deliverable | Status | Evidence |
|---|---|---|
| Prod stack applied (same modules, `hc-prod-`) | ✅ | 54 resources, drift exit 0 |
| Same image tag deployed to prod | ✅ | `dev-351537e-20260612025557` promoted dev→prod, digests identical, `https://d3v3fqgxdcoxv9.cloudfront.net/health` → 200; direct origin :8080 times out; `/api/*` → 404 (not 403) |
| RUNBOOK.md (deploy, rollback, logs, drift, alarms, cost) | ✅ | [`RUNBOOK.md`](./RUNBOOK.md) |
| Phase 0 exit checklist against doc §11.2 | ✅ | This file |
