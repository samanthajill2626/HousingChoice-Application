# HousingChoice RUNBOOK

The operator manual for the two AWS stacks (`hc-dev-`, `hc-prod-`, account **938565869261**, us-east-1).
Everything here runs from the repo root on the operator machine; every mutating script is
account-guarded (see [State & bootstrap](#state--bootstrap)). The AWS console is **read-only by policy**.

Quick reference (authoritative source: `terraform -chdir=infra/envs/<env> output`):

| | dev | prod |
|---|---|---|
| CloudFront | `d2w86qra2rq9iz.cloudfront.net` | `d3v3fqgxdcoxv9.cloudfront.net` |
| EC2 instance | `i-0ad45daa858632001` | `i-087fd4eda3e2804c1` |
| ECR repo | `hc-dev-app` | `hc-prod-app` |
| Log groups | `/hc/dev/app`, `/hc/dev/worker` | `/hc/prod/app`, `/hc/prod/worker` |
| Jobs queue / DLQ | `hc-dev-jobs` / `hc-dev-jobs-dlq` | `hc-prod-jobs` / `hc-prod-jobs-dlq` |
| Released-tag pointer | SSM `/hc/dev/app/DEPLOYED_TAG` | SSM `/hc/prod/app/DEPLOYED_TAG` |
| Alerts topic | `hc-dev-alerts` | `hc-prod-alerts` |

---

## Daily operations

### Deploy to dev

```powershell
npm run deploy:dev
```

Builds the ARM64 image from the working tree, tags it `dev-<git sha>-<UTC timestamp>`, pushes to
`hc-dev-app`, then rolls the dev instance via SSM Run Command (no SSH exists anywhere).

### Promote to prod — never rebuild for prod

```powershell
npm run deploy:prod -- --promote <dev-tag>     # e.g. dev-351537e-20260612025557
```

Prod runs the **same image bytes** dev verified, always. `--promote`:

1. Verifies `<dev-tag>` exists in `hc-dev-app` (refuses otherwise).
2. Copies the image into `hc-prod-app` under the same tag **at the registry level** — manifest +
   blobs via the ECR registry API, no `docker pull/push`, no rebuild — and hard-verifies the
   prod digest equals the dev digest before continuing. Idempotent: re-promoting an
   already-promoted tag skips the copy; a same-tag/different-digest collision is a hard refusal.
3. Continues as a normal existing-tag deploy against prod (SSM roll + health gate + CloudFront
   verification below).

Building directly into prod (`npm run deploy:prod` with no flags) works mechanically but is **not
the process** — prod images come from dev via `--promote`, period.

### Listing what exists / what is running

```powershell
npm run deploy:dev -- --list      # last 10 hc-dev-app tags + current dev DEPLOYED_TAG
npm run deploy:prod -- --list     # same for prod
```

The currently-released tag is marked `<== DEPLOYED`.

### Secrets

Operator-managed secrets (Twilio etc.) live in the gitignored `.env.dev` / `.env.prod` at the repo
root — templates: `.env.dev.example` / `.env.prod.example` (copy, rename, fill in) — and reach AWS
by script only. Nobody hand-runs `aws ssm put-parameter`:

```powershell
npm run secrets:push -- dev       # .env.dev -> SecureString /hc/dev/app/<KEY> (account-guarded)
npm run secrets:check -- prod     # read-only diff: exit 0 in sync, 2 drift, 1 error
```

The flow: edit `.env.<env>` → `secrets:push` writes each key as SecureString under
`/hc/<env>/app/` (prints a created/updated/unchanged summary; values only ever appear masked, like
`AC…1234`) → the **next deploy** hydrates them into `/opt/hc/.env` on the instance. Pushing alone
restarts nothing — follow with a deploy (re-deploying the current `DEPLOYED_TAG` works) to make new
values live. `secrets:check` is the drift report: per-key missing/differs/matches against Parameter
Store, plus any unexpected extra params under the path (report-only).

Terraform/deploy-managed keys (`CF_ORIGIN_SECRET`, `JOBS_QUEUE_URL`, `LOG_LEVEL`, `MEDIA_BUCKET`,
`NODE_ENV`, `PORT`, `PUBLIC_BASE_URL`, `SCHEDULER_ROLE_ARN`, `SCHEDULER_TARGET_ARN`,
`TABLE_PREFIX`, `DEPLOYED_TAG`) are **refused** in the .env files — those belong to `plan`/`apply` and the deploy
script, and this tool can never overwrite them. `.env.dev` / `.env.prod` are gitignored; never
commit them.

**Template-first rule:** the real files must mirror the key set of their committed templates. A new
key lands in `.env.<env>.example` FIRST (placeholder + comment), then gets merged into the real
`.env.<env>` — append only, never overwrite existing lines. `secrets:push`/`secrets:check` print a
warning whenever the key sets drift.

**Rotating `SESSION_SECRET`** (the sealed-session-cookie key; Terraform-generated, NOT an `.env`
key): taint the generator, re-apply, deploy —

```powershell
$env:AWS_PROFILE = 'housingchoice'
terraform -chdir=infra/envs/<env> taint module.params.random_password.session_secret
npm run plan -- <env>; npm run apply -- <env>          # writes the new SecureString
npm run deploy:<env> -- --tag <current DEPLOYED_TAG>   # hydrates it onto the instance
```

Effect: every outstanding session cookie stops opening = **forced global logout** (everyone signs
back in via Google). No data loss — sessions live only inside the cookies themselves. Rotate on any
suspicion the secret leaked.

### Users & access (invite-first)

Access is **invite-first** (operator decision 2026-06-12, README deviations). A Google login
succeeds ONLY if an admin has already created a user record for that email — the login path never
auto-provisions. A verified, allowlisted Google account with **no invite is refused with a 403
"not invited"** (distinct from the domain-allowlist 403). The OAuth domain allowlist
(`OAUTH_ALLOWED_DOMAINS`) is retained as a second fence (defense-in-depth), not as the access grant.

Invite a user (account-guarded; idempotent — re-inviting is a no-op that leaves the role unchanged):

```powershell
npm run user:invite -- <dev|prod> someone@housingchoice.org va     # or admin
```

The invite writes an `invited` record (email + role + `session_epoch` 1, no `google_sub`) plus a
`user_invited` audit event. The user's **first** Google login activates it (writes `google_sub`,
flips `status` → `active`, audits `user_activated`); later logins just stamp `last_login_at`.

**Bootstrap the first admin** (do this once per env, before anyone can sign in — the order vs.
deploy does not matter, the record just has to exist before the user logs in):

```powershell
npm run user:invite -- <env> <your-workspace-email> admin
```

**Promote / demote** an existing user (never creates — invite first):

```powershell
npm run user:role -- <dev|prod> someone@housingchoice.org admin
```

`user:role` bumps `session_epoch`, so a role change revokes the user's active sessions within ~60s
and the new role applies at their next sign-in. `user:role` against a non-existent email refuses and
points you at `user:invite`.

In-app user management (list / invite / role-change behind `requireRole('admin')`) is coming in
**M1.4** — it will wrap the same `usersRepo.invite` + `usersRepo.setRole` these scripts use, and is
the first admin-only `/api` surface. Until then these npm scripts are the only invite/role path.

### Twilio

The messaging stack (M1.1) has a Twilio-console side that Terraform does NOT manage — this wiring
must hold or messages silently stop flowing:

- **Messaging Service inbound webhook** → `https://<cloudfront>/webhooks/twilio/sms` (the
  Messaging Service's Integration settings, "Send a webhook").
- **Delivery status callback** (same Integration page) → `https://<cloudfront>/webhooks/twilio/status`
  — without it, delivery outcomes (including failures that trigger retries/contact flags) never
  arrive.
- **The phone number must sit in the live A2P campaign's sender pool** of that Messaging Service —
  a number outside the pool can't send campaign traffic.
- **Voice URLs on the number** stay configured on the number itself (calls are not handled by the
  app yet; the number-level voice config is what answers).

The env keys that feed the app live in the gitignored `.env.<env>` and reach Parameter Store via
`npm run secrets:push -- <env>` (then a deploy to go live — see [Secrets](#secrets)):
`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` (REST), `TWILIO_AUTH_TOKEN`
(webhook signature validation ONLY), `TWILIO_MESSAGING_SERVICE_SID`, and `OUR_PHONE_NUMBERS`.

**`OUR_PHONE_NUMBERS` must list EVERY number we own** (comma-separated E.164): it is echo/author
defense #1 — an inbound webhook whose From matches is our own outbound projected back. A missing
number degrades that defense to SID-dedupe alone; in production with the twilio driver an EMPTY
list refuses to boot.

### Jobs (async delivery path)

Since M1.2 every job flows: `jobs.enqueue()` (app) → one-off EventBridge Scheduler schedule
(`ActionAfterCompletion: DELETE`, named `hc-<jobName>-<jobId>`; fires no sooner than ~60 s out —
Scheduler rejects past times, so "run now" is clamped to its floor) → SQS `hc-<env>-jobs` (the JSON
job envelope IS the message body) → worker long-poll → `dispatchJob()` → handler. A failed handler
does **not** delete the message: it redelivers after the 120 s visibility timeout and dead-letters
into `hc-<env>-jobs-dlq` after 5 receives, which trips `hc-<env>-jobs-dlq-depth`.

Inspect queue/DLQ depth (queue URLs: `terraform -chdir=infra/envs/<env> output`):

```powershell
aws sqs get-queue-attributes --queue-url (terraform -chdir=infra/envs/dev output -raw jobs_queue_url) --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --profile housingchoice --region us-east-1 --no-cli-pager
aws sqs get-queue-attributes --queue-url (terraform -chdir=infra/envs/dev output -raw jobs_dlq_url) --attribute-names ApproximateNumberOfMessages --profile housingchoice --region us-east-1 --no-cli-pager
```

Peek at dead-lettered envelopes (read-only — peeked messages reappear after the visibility timeout):

```powershell
aws sqs receive-message --queue-url (terraform -chdir=infra/envs/dev output -raw jobs_dlq_url) --max-number-of-messages 10 --profile housingchoice --region us-east-1 --no-cli-pager
```

**DLQ redrive** (after fixing the cause — messages move back to the jobs queue and the worker
retries them; omitting `--destination-arn` means "back to the source queue"):

```powershell
aws sqs start-message-move-task --source-arn arn:aws:sqs:us-east-1:938565869261:hc-dev-jobs-dlq --profile housingchoice --region us-east-1
aws sqs list-message-move-tasks --source-arn arn:aws:sqs:us-east-1:938565869261:hc-dev-jobs-dlq --profile housingchoice --region us-east-1 --no-cli-pager
```

**Local dev:** `JOBS_QUEUE_URL` / `SCHEDULER_*` are unset, so the app uses the in-memory scheduler
(enqueues are accepted with a boot WARN but never delivered) and the local worker starts no poll
loop — exercising handlers locally is what the test suite's `InMemorySchedulerAdapter.deliverAll`
is for. To consume REAL dev-queue messages from a local worker, set `JOBS_QUEUE_URL` in `.env`
(live mode) — note it then competes with the deployed dev worker for messages.

### What the health-check gate does

Every deploy (build, `--tag`, `--promote`) runs this gate **on the instance** before declaring success:

1. `curl localhost:8080/health` until 200 (up to 12 × 5 s).
2. Both containers (`app`, `worker`) must be in state `running`.
3. The worker must have printed its `worker ready` boot line (it has no health endpoint).
4. **Only after** all three pass does it `docker image prune -af` (the 10 GB root volume depends
   on pruning happening only on success — a failed deploy never prunes the previous image).

Then the **operator side** verifies `https://<cloudfront>/health` returns 200 (up to 8 × 5 s), and
only then writes the released tag to SSM `/hc/<env>/app/DEPLOYED_TAG`.

### What a failed deploy looks like

- The script exits non-zero, prints the instance's compose state + last 50 container log lines,
  and prints the exact rollback one-liner (using the image that was running before).
- **`DEPLOYED_TAG` is NOT flipped** — it only ever records deploys that passed both the
  on-instance gate and the CloudFront check. So `DEPLOYED_TAG` always answers "what was last
  *successfully* released", even mid-incident.
- The previously running image is not pruned, so rollback is a fast re-pull (cached layers).
- Lifecycle log lines (`app listening`, `worker ready`, shutdown) carry a per-process `bootId`
  as their correlationId, so container starts do NOT trip the orphan-log alarm (fixed
  2026-06-12; images tagged before that date still have the transient ALARM→OK wart).

### Troubleshooting: disk full after repeated failed deploys

Images are this box's only meaningful disk-growth vector (builds happen on the operator machine;
container logs ship to CloudWatch via the awslogs driver, not to local files). The deploy script
runs `docker image prune -af` **only after a successful health-gated deploy** — failures
deliberately don't prune, so a long streak of consecutive failed deploys can fill the 10 GB root
until the next image pull itself fails (`no space left on device` in the SSM/deploy output).

Recovery (~2 minutes, no data at risk — rollback images live in ECR, not on disk):

```powershell
aws ssm start-session --target <instance-id> --profile housingchoice --region us-east-1
```

then on the box:

```bash
sudo docker image prune -af     # frees everything not used by a running container
df -h /                          # confirm
```

Exit and re-run the deploy. A successful deploy's own prune also sweeps ALL accumulated junk
(every image not in use by the now-running containers), so the disk resets to ~one image on
every green deploy — this section is only needed when the failure streak wins the race.

## Rollback

One-liner per env (re-deploys an EXISTING ECR tag — no build, ~20–25 s end to end):

```powershell
npm run deploy:dev  -- --tag <previous-dev-tag>
npm run deploy:prod -- --tag <previous-prod-tag>
```

How to find the previous tag:

1. `npm run deploy:<env> -- --list` — newest-first tag list; `<== DEPLOYED` marks the current one.
   The previous tag is usually the next line down.
2. Every deploy's summary also prints `previous tag:` and the exact rollback command — scroll up
   in the terminal of the deploy you are reverting.

The rollback goes through the same health-check gate and CloudFront verification, and flips
`DEPLOYED_TAG` only on success.

## Reading logs

CloudWatch Logs Insights, region us-east-1. Select **both** log groups `/hc/<env>/app` and
`/hc/<env>/worker` so you see the full picture (the queries below work across both). Every line is
pino JSON; Insights auto-discovers the fields (`level`, `msg`, `correlationId`, `requestId`,
`jobRunId`, `err.stack`, ...). `@logStream` is `app/<container-id>` or `worker/<container-id>`,
which tells you which process said it.

**(a) Everything for one correlation ID** (a request and all logs it caused in that process):

```
fields @timestamp, @logStream, level, msg
| filter correlationId = 'PASTE-CORRELATION-ID'
| sort @timestamp asc
```

**(b) All errors (pino level >= 50) in the last hour, with stack traces** — set the console time
range to 1h (or keep the filter line):

```
fields @timestamp, @logStream, correlationId, msg, err.stack
| filter level >= 50 and @timestamp > now() - 1h
| sort @timestamp desc
```

**(c) Orphan lines (no correlationId)** — these should be **ZERO**, always, and they alarm
(`hc-<env>-orphan-logs`). Boot/shutdown lines carry a `bootId` correlationId since 2026-06-12,
so ANY hit from this query is a real bug — a code path logging outside the context gates:

```
fields @timestamp, @logStream, level, msg
| filter not ispresent(correlationId)
| sort @timestamp desc
```

**(d) One request's full journey, including job hops.** The correlation context is stamped into
every `jobs.enqueue()` payload, so worker lines for jobs caused by a request still carry that
request's `requestId` (their `correlationId` becomes the `jobRunId`, but `requestId` survives the
hop). Filter on `requestId` to stitch the whole story across app **and** worker:

```
fields @timestamp, @logStream, correlationId, jobRunId, msg
| filter requestId = 'PASTE-REQUEST-ID' or correlationId = 'PASTE-REQUEST-ID'
| sort @timestamp asc
```

## Drift

```powershell
npm run drift             # dev (default)
npm run drift -- prod
```

This is `terraform plan -detailed-exitcode` (read-only — it never changes anything):

| Exit code | Meaning |
|---|---|
| 0 | Clean — real infrastructure matches state and configuration |
| 2 | **DRIFT DETECTED** — the diff is printed above the message |
| 1 | The check itself errored (credentials, init, syntax) |

On drift: **investigate what changed in the console/out-of-band, then revert it via Terraform —
never console-fix.** Concretely: read the printed diff, figure out who/what made the change
(CloudTrail if needed), then `npm run plan -- <env>` + review + `npm run apply -- <env>` to push
reality back to the declared configuration. If the drifted value is actually *desired*, change the
`.tf` code instead and apply that. The console stays read-only either way.

Note: SSM `/hc/<env>/app/DEPLOYED_TAG` is written by deploys and is **unmanaged by Terraform on
purpose** — it never shows up as drift.

## Alarms

10 alarms (5 per env), all notifying SNS `hc-<env>-alerts` (email) on both ALARM and OK.

> **SNS subscription note:** email subscriptions need a one-time confirmation click.
> `hc-dev-alerts` is confirmed; **`hc-prod-alerts` is still `PendingConfirmation`** as of
> 2026-06-11 — until the "AWS Notification - Subscription Confirmation" email is clicked, prod
> alarms fire into the void. Re-send if lost: `aws sns subscribe --topic-arn
> arn:aws:sns:us-east-1:938565869261:hc-prod-alerts --protocol email --notification-endpoint
> <email> --profile housingchoice`.

| Alarm (dev / prod) | Fires when | What it means | First response |
|---|---|---|---|
| `hc-dev-orphan-logs` / `hc-prod-orphan-logs` | `OrphanLogs` sum > 0 over 5 min | A code path logged outside the correlation context (binding guideline #4 says this must be zero) | Run Insights query (c) above to find the offending lines. If they are only the `app listening` / `worker ready` boot lines, this is the known deploy-time artifact — it clears at the next 5-min evaluation that sees log traffic (observed: ~6–15 min; with zero traffic it can linger until the next request, so hit `/health` once to hurry it). Fix tracked in the backlog below. Anything else: find the code path and fix the gate (route the log through the correlation context / `jobs` envelope). |
| `hc-dev-error-logs` / `hc-prod-error-logs` | `ErrorLogs` sum >= 5 over 5 min | App/worker emitting error/fatal (pino level >= 50) at volume | Insights query (b) for the stacks; every error line carries a `correlationId` — pivot to query (a)/(d) for the full story. Roll back (`-- --tag <previous>`) if a deploy caused it. |
| `hc-dev-status-check-failed` / `hc-prod-status-check-failed` | EC2 `StatusCheckFailed` >= 1 (missing data = breaching) | Instance or underlying AWS hardware/network problem — also fires if the instance stops reporting entirely | Check SSM: `aws ssm describe-instance-information --profile housingchoice --region us-east-1`. If unreachable, reboot **via CLI** (console stays read-only): `aws ec2 reboot-instances --instance-ids <id> --profile housingchoice --region us-east-1`. Containers restart on boot (`restart: unless-stopped`). If the instance is truly dead, `npm run plan/apply -- <env>` will recreate it; then re-deploy the current `DEPLOYED_TAG`. |
| `hc-dev-jobs-dlq-depth` / `hc-prod-jobs-dlq-depth` | `ApproximateNumberOfMessagesVisible` > 0 on `hc-<env>-jobs-dlq` | A job envelope failed all 5 worker dispatch attempts and was dead-lettered — reminders/follow-ups are revenue-critical (doc §9 "Job/DLQ depth") | Worker ERROR logs first: Insights query (b) — the `job failed` lines carry `jobName`, stack, and the originating request's correlation IDs. Peek the DLQ to see the stuck envelopes, fix the handler/data (deploy), then redrive — exact one-liners in [Jobs](#jobs-async-delivery-path). The alarm clears once the DLQ drains. |
| `hc-dev-disk-used` / `hc-prod-disk-used` | `disk_used_percent` (root) > 80% | 10 GB root volume filling — usually Docker images/layers | Inspect via SSM Run Command (no SSH): `docker system df`, then `docker image prune -af` (safe: the running containers' images are in use). **Caveat:** this metric comes from the CloudWatch agent, which is NOT installed yet — the alarm currently sees no data and `notBreaching` keeps it quietly OK. It cannot actually fire until the agent ships (backlog below). The deploy's prune-on-success keeps disk in check meanwhile (post-deploy: 26% used). |

## Costs

Honest monthly estimate **at idle, both stacks combined** (us-east-1, on-demand, 730 h/mo):

| Item | Unit | Monthly |
|---|---|---|
| 2 × EC2 t4g.small (24/7) | ~$0.0168/h each | **$24.53** |
| 2 × public IPv4 (EIP) | $0.005/h each | **$7.30** |
| 2 × 10 GB gp3 root volume | $0.08/GB-mo | **$1.60** |
| CloudFront, DynamoDB (on-demand+PITR, empty), S3, ECR storage, CloudWatch logs/alarms/dashboards, Parameter Store, SNS, SES | idle traffic ≈ 0 | **≈ $0–1** |
| Route 53 | none (no hosted zone) | $0.00 |
| **Total** | | **≈ $33–34/mo** |

That is **materially above the architecture doc's "~$25/mo" expectation** (~35% over). The gap is
simply that the doc's number doesn't fully price two always-on stacks: the second instance and the
two public IPv4 charges dominate. Options if/when it matters (NOT actioned — decide first):

- **Single-stack idle:** stop the dev instance when not developing (saves ~$12.3/mo compute; the
  EIP of a *stopped* instance still bills, and an unattached EIP bills the same $3.65).
- **t4g.micro for dev** (~$6.1/mo): halves dev compute; fine for Phase 0 workloads.
- **Release the dev EIP** while dev is down (saves $3.65/mo, but the origin DNS changes on
  re-create → requires a Terraform apply + CloudFront update).

The Terraform `budget` module already emails at 80% actual / 100% forecast of a **$40/mo** budget,
so an honest ~$33 idle baseline leaves little headroom — expect 80% (= $32) budget emails as normal.

## Security / hardening backlog

Tracked here so nothing silently becomes permanent:

| Item | Status / decision | Notes |
|---|---|---|
| IAM-user MFA | **Deferred by decision 2026-06-11** | Root has MFA; the `housingchoice` IAM user does not. Mitigations in place: account-ID guard in every mutating script, named profile only (default chain never used), console read-only by policy. Revisit when the team is > 1. |
| Access-key rotation | Cadence: **rotate every 90 days** | `aws iam create-access-key` → update profile → `aws iam delete-access-key` for the old one. No automation yet; calendar it. |
| SES sandbox exit | Phase 1 | Both SES identities are sandboxed (verified recipients only). Production-access request goes in when Phase 1 needs real outbound mail. |
| CloudWatch agent (disk metric) | **Not installed** — disk alarms can't fire (no data → `notBreaching` → OK) | Install via user-data or SSM Distributor; config must emit `CWAgent disk_used_percent` with dimensions `InstanceId, path="/", fstype="xfs"` to match the alarm. Until then disk is only protected by deploy-time pruning. |
| OTLP exporter wiring | **OTel SDK currently runs with no exporter in BOTH envs** | Reality check 2026-06-11: neither `/hc/dev/app` nor `/hc/prod/app` sets `OTEL_SDK_DISABLED`, so the SDK starts and instruments http/express in both envs — but `app/src/lib/otel.ts` configures no `traceExporter`/`metricReader`, so traces/metrics are exported **nowhere** (locally `OTEL_SDK_DISABLED=true` makes it a true no-op). Wire OTLP → CloudWatch Application Signals via the existing `OTEL_EXPORTER_OTLP_ENDPOINT` seam. |
| Orphan boot-log lines | **Fixed 2026-06-12** | Lifecycle lines (boot/shutdown/process-level errors) now run inside a per-process `bootId` correlation context, so container starts no longer trip `hc-<env>-orphan-logs`. Any orphan hit is now a real bug. (Images tagged before 2026-06-12 still carry the old behavior.) |
| Custom domain + ACM | Deferred until the DNS question is settled | CloudFront serves on the default `*.cloudfront.net` cert. No Route 53 zone exists. |
| SNS prod confirmation | **Action needed once:** click the confirmation email for `hc-prod-alerts` | See the Alarms section note. |
| Messaging delivery alarms | M1.1 gap | Metric filter + alarm for webhook signature rejections and for undelivered-rate / 429-30022 throttling errors (the doc-§9 alarm table) — today only 30007 carrier filtering and breaker trips reach ERROR/the error-logs alarm. |
| /api rate limiting | Before M1.3 auth lands | Express rate limit on the /api manual-send route — it is origin-secret-protected only until OAuth/RBAC (M1.3), so a leaked origin secret currently means unthrottled sends. |

## State & bootstrap

- **Two Terraform state buckets**, one per stack: `hc-dev-tfstate-938565869261` and
  `hc-prod-tfstate-938565869261` (versioned, encrypted, public-blocked, S3-native lockfile
  locking). Separate buckets = per-stack IAM isolation; a prod-scoped principal never needs read
  on dev state or vice versa.
- **`npm run bootstrap`** creates/enforces those two buckets and is **idempotent** — safe to
  re-run any time; it converges settings rather than failing on "already exists".
  `npm run bootstrap:check` is the read-only audit of the same invariants. These buckets are the
  ONLY infrastructure not managed by Terraform (backend chicken-and-egg).
- **Account guard:** the operator machine's *default* AWS credentials belong to an unrelated
  account, so every script that can touch AWS (`bootstrap`, `plan`, `apply`, `drift`,
  `deploy:*`) first calls `assertHousingChoiceAccount()` (`scripts/lib/hcAws.mjs`): it resolves
  the named profile `housingchoice` (override: `HC_AWS_PROFILE`) via STS and **hard-fails unless
  the account is 938565869261**. `AWS_PROFILE=housingchoice` is also forced into every child
  process (terraform, aws CLI, docker login), so the default chain is never consulted. Belt,
  braces, and the profile is additionally pinned inside the Terraform backend/provider HCL.
