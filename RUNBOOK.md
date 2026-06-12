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
- Expect a transient `hc-<env>-orphan-logs` ALARM around any container start — see
  [Alarms](#alarms), it self-clears within ~10 minutes.

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

**(c) Orphan lines (no correlationId)** — these should be **ZERO** during steady state and they
alarm (`hc-<env>-orphan-logs`). Known exception: the boot lines `app listening` / `worker ready`
are emitted before any context exists, so every container start produces them (see Alarms):

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

8 alarms (4 per env), all notifying SNS `hc-<env>-alerts` (email) on both ALARM and OK.

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
| Orphan boot-log lines | Known wart | `app listening` / `worker ready` are logged before any correlation context exists, so **every container start trips `hc-<env>-orphan-logs`** (ALARM→OK within ~10 min). Fix: stamp a synthetic boot correlationId on startup lines (app change → must ride the normal dev→promote train). Until then, a deploy-time orphan alarm followed by OK is expected noise. |
| Custom domain + ACM | Deferred until the DNS question is settled | CloudFront serves on the default `*.cloudfront.net` cert. No Route 53 zone exists. |
| SNS prod confirmation | **Action needed once:** click the confirmation email for `hc-prod-alerts` | See the Alarms section note. |

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
