# HousingChoice — Phase 0 Build Prompt (paste into Claude Code in VS Code)

You are building **Phase 0 (Foundations)** of the HousingChoice platform — a text-first Section 8 tenant-placement engine. The full architecture is specified in `..\HousingChoice_Architecture_and_Build_Plan.docx` (v2.12); this prompt is self-contained for Phase 0, but consult the doc when in doubt.

**Work incrementally.** Complete one milestone at a time, then STOP, summarize what you built, show me how to verify it, and wait for my go-ahead. Never run ahead. When a step requires action outside this codebase (AWS console, vendor signup, credentials), STOP and walk me through it click-by-click, then wait for me to confirm before continuing.

---

## Locked architecture decisions (do not re-litigate)

- **Stack:** Node.js 24 LTS + Express, modular monolith: one `app` process (API/webhooks/dashboard API) + one `worker` process (jobs), sharing one codebase and one Docker image (ARM64 — prod runs a `t4g.small`). React + Vite dashboard (PWA later; shell only in Phase 0).
- **AWS, one account, two stacks:** every resource name-prefixed `hc-dev-` / `hc-prod-`, separate Terraform state per stack, per-stack IAM roles. Region: `us-east-1`.
- **Infra (lean by decision):** EC2 t4g.small in a **public subnet** with security group locked to CloudFront's origin-facing managed prefix list + SSM only (no SSH, no NAT gateway, no WAF, no Cognito, no Secrets Manager). CloudFront in front (default `*.cloudfront.net` domain for now — custom domain/ACM deferred until DNS question is settled). DynamoDB on-demand **with PITR enabled** on all tables. S3 for media + Terraform state. Parameter Store (standard, free) for ALL config and credentials — SecureString for secrets. ECR for images. CloudWatch for everything observability.
- **No CI/CD (deliberate):** everything runs via npm scripts from my machine: `npm run dev | test | deploy:dev | deploy:prod | plan | apply | drift`. Deploys = build ARM64 image → push ECR → SSM Run Command pulls + restarts compose + health-check. No GitHub Actions.
- **Terraform ≥1.15**, AWS provider v6, S3 backend with **native lockfile locking** (`use_lockfile = true` — no DynamoDB lock table). Console access stays read-only; all changes through `npm run plan/apply`.
- **DynamoDB tables (9, document-style — only keys/GSIs are contractual):**
  `contacts` (PK contactId; GSIs byPhone, byTypeStatus, byHousingAuthority) · `units` (PK unitId; byLandlord, byStatus, byJurisdiction) · `conversations` (PK conversationId; byParticipantPhone, byLastActivity) · `messages` (PK conversationId, SK ts#msgId; stream on) · `matches` (PK tenantId, SK unitId; byUnit; TTL) · `cases` (PK caseId; byTenant, byUnit, byStage, byTourDate sparse, byNextDeadline sparse; stream on) · `invoices` (PK invoiceId; byLandlord, byStatus) · `users` (PK userId; byEmail) · `audit_events` (PK entityKey, SK ts; byActor).

## Binding coding guidelines (enforce with lint where possible)

1. **Streams only for media paths:** all file movement (S3 transfers, future MMS/recordings) uses `stream.pipeline`; `fs.readFileSync` and whole-file buffers are banned in `src/` media paths (add `no-restricted-syntax` lint rule now).
2. **Express middleware order (locked):** (0) correlation-ID injection → (1) light logger: method, path, socket IP + X-Forwarded-For (untrusted until validated), **redacted** headers (never log the origin secret or credentials) → (2) CloudFront secret-origin-header validator: mismatch = WARN log with offender IP/path under the correlation ID + immediate 403, body never parsed; `/health` exempt (deploy checks arrive via localhost) → (3) body parsers (`express.json` with raw-body capture — Twilio HMAC needs it later) → routes.
3. **Async context envelopes:** structured JSON logging via `pino` with `AsyncLocalStorage` correlation context (requestId, conversationId, tenantId, caseId). Context dies at async boundaries, so build the two gates now: a single `jobs.enqueue()` that stamps `correlationContext` (+ W3C traceparent, hop count) into every job payload **and sets `ActionAfterCompletion: DELETE` on one-off EventBridge schedules** (they don't clean up after themselves), and a single `defineJobHandler()` that re-hydrates AsyncLocalStorage (fresh jobRunId) before any business logic. Handlers never touch raw events; nothing calls EventBridge directly.
4. **Errors are first-class logs:** uncaught exceptions, unhandled rejections, and handled errors log with full stack + correlation IDs. A metric filter counts log lines missing a correlation ID ("orphan logs" — alarm if > 0).
5. **OpenTelemetry** (not the EOL X-Ray SDK) wired from day one, exporting to CloudWatch Application Signals.

---

## Milestones (one at a time, checkpoint after each)

**M0.0 — Setup questions.** Before writing anything, ask me: TypeScript or JavaScript (recommend TS); test runner preference (recommend vitest); repo name; confirm region us-east-1. Then list the toolchain I need locally — Node 24, Docker Desktop, Terraform ≥1.15, AWS CLI v2, git — with version-check commands, and wait while I install.

**M0.1 — Repo scaffold.** Monorepo: `app/` (src/routes, src/services, src/adapters, src/repos, src/jobs, src/lib), `dashboard/` (Vite React shell), `infra/` (modules/ + envs/dev + envs/prod), `scripts/`, root `package.json` with the npm-script surface, `docker-compose.yml` (prod composition), `.env.example` documenting every variable, eslint (incl. the readFileSync ban), `.gitignore`, README. 🖐 **Manual step you walk me through:** creating the private GitHub repo and first push.

**M0.2 — App + worker skeleton with the logging core.** Express app with the locked middleware order, `/health`, pino + AsyncLocalStorage correlation plumbing, error capture, the `jobs.enqueue()`/`defineJobHandler()` gates (EventBridge calls stubbed behind an adapter so they're testable locally), worker entrypoint, OTel wiring (no-op exporter locally). Unit tests proving: context survives a simulated job round-trip; orphan-log detection works; middleware rejects a missing origin header with 403 + correlated log; `/health` bypasses validation.

**M0.3 — Local dev environment.** `npm run dev`: app + worker natively with instant reload, auto-starting DynamoDB Local (the only local container), table-creation + seed scripts for all 9 tables, `npm test` green end-to-end. Show me the loop: edit → reload → log line with correlation ID → query DynamoDB Local.

**M0.4 — AWS bootstrap + Terraform baseline (dev stack).** 🖐 **Manual steps first — walk me through each, one at a time:** (1) AWS account ready + IAM admin via Identity Center, MFA on, billing alerts enabled; (2) AWS CLI configured (`aws sts get-caller-identity` works); (3) one-time state bootstrap: create the versioned S3 state bucket (give me the exact CLI command). Then Terraform: modules for network (VPC, public subnet, SG locked to CloudFront prefix list + SSM), EC2 t4g.small (user-data installs Docker + compose, instance profile scoped to exact tables/buckets/parameters), DynamoDB ×9 with PITR + streams + TTL, S3 (media, versioned), ECR, SES identity (sandbox), Parameter Store layout, CloudFront distribution (origin = EC2 public DNS, `/api/*` + `/webhooks/*` uncached + origin secret header, custom-error pages off), CloudWatch log groups/dashboard/alarms (EC2 status, disk, error-rate, orphan-logs), AWS Budget with email alert. `npm run plan` then, with my approval, `npm run apply` for **dev only**.

**M0.5 — Deploy path.** `npm run deploy:dev`: ARM64 image build (buildx) → ECR push → SSM Run Command on the instance (pull, compose up, health-check via localhost) → verify `/health` through the CloudFront URL (correct origin header injected by CloudFront). Rollback = redeploy previous tag; show me how. Prove the security group: direct-to-EC2 request fails, CloudFront request succeeds.

**M0.6 — Prod stack + runbook.** Apply the prod stack (same modules, `hc-prod-`), deploy the same image tag, then write `RUNBOOK.md`: how to deploy, roll back, read logs (Logs Insights queries by correlation ID), check drift (`npm run drift`), what each alarm means, and the monthly cost expectation (~$25 AWS at idle). Finish with a Phase 0 exit checklist against the plan doc §11.2.

## Parallel manual track (start at M0.1, runs while we build — remind me at every checkpoint until done)

- **Twilio:** create account → buy one temporary local number → file **A2P 10DLC brand registration ($4) and campaign registration ($15, low-volume mixed)** immediately — carrier approval takes days to 3 weeks and gates all Phase 1 texting. (Number port from Quo comes later, at Phase 1 cutover.)
- Nothing else external is needed for Phase 0 (Google OAuth, Anthropic/Bedrock, DocuSign, Stripe all arrive in later phases).

## Out of scope for Phase 0 — do not build yet

Twilio integration, conversation hub UI, any AI/Claude code, matching, Google OAuth, group relay threads, voice. The skeleton should leave clean seams for them (adapters/, routes/webhooks placeholder) but no implementation.
