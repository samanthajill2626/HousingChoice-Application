# CloudWatch Host-Metrics (disk + memory) + OOM Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the CloudWatch agent on the app EC2 box so host disk + memory metrics flow, alarm on both (two-tier memory), light up the existing dark disk alarm, and surface OOM events on the Settings → System Status errors panel.

**Architecture:** Infra-first (Terraform: agent install in EC2 `user_data`, memory alarms + a `/hc/<env>/system` log group in the observability module), then a contained app-code change so `System Status → getErrors` also surfaces OOM lines. Agent metrics land in the `CWAgent` namespace; kernel OOM lines reach CloudWatch via rsyslog → `/var/log/messages` → the agent → `/hc/<env>/system`.

**Tech Stack:** Terraform (AWS provider), Amazon Linux 2023 (systemd, dnf), amazon-cloudwatch-agent, rsyslog, Node 24 + TypeScript + Vitest (app), AWS SDK v3 CloudWatch/Logs.

**Spec:** `docs/superpowers/specs/2026-07-01-cloudwatch-host-metrics-design.md` (read it).

## Global Constraints

- **Work in a git worktree under `w:\tmp`** — never move `main`'s HEAD (shared checkout + concurrent agents). Create it with the `superpowers:using-git-worktrees` skill.
- **Infra is operator-applied.** Write Terraform + the one-time SSM command + docs, and verify with `terraform validate` / `npm run plan -- dev`. **Do NOT run `terraform apply` or the SSM command** — the human runs those. A task "passes" its infra gate when `validate` is clean and `plan` shows the intended change (crucially: an **in-place `user_data` update, NOT an instance replacement**).
- **No IAM changes.** The instance role already grants `cloudwatch:PutMetricData` on the `CWAgent` namespace and `logs:*` on `/hc/<env>/*` ([`infra/modules/ec2/main.tf:160-184`](../../../infra/modules/ec2/main.tf#L160)). If a task appears to need an IAM change, STOP and flag it.
- **Instance type is `t4g.small` (2 GB RAM), 10 GB gp3 root.** Metrics collected: **disk + memory only** (no CPU/swap/inode).
- **Terraform heredoc gotcha:** the agent config JSON contains `${aws:InstanceId}` — inside a Terraform `<<-EOT` heredoc that MUST be written `$${aws:InstanceId}` to emit a literal `${aws:InstanceId}` (else Terraform tries to interpolate it and errors).
- Follow `.claude/CLAUDE.md` (glossary, issue tracking). App tests are Vitest (`npm test -w app`).
- Commit after each task.

## File Structure

- `infra/modules/ec2/main.tf` — **modify** `user_data` (~L249-260): add rsyslog + cloudwatch-agent install + inline agent config + start.
- `infra/modules/observability/main.tf` — **modify**: add a standalone `/hc/<env>/system` log group; add two memory alarms; add a memory dashboard widget; refresh the disk alarm/widget comments.
- `infra/modules/observability/variables.tf` — **modify**: add `mem_used_warn_threshold` (default 80) + `mem_used_critical_threshold` (default 90).
- `app/src/lib/config.ts` — **modify**: add `workerLogGroupName` + `systemLogGroupName`.
- `app/src/adapters/cloudwatch.ts` — **modify**: extract a shared paged scanner; add `filterEventsByPattern` to the seam; add OOM filter-pattern constants.
- `app/test/cloudwatch.test.ts` — **modify/create**: cover `filterEventsByPattern`.
- `app/src/services/systemStatus.ts` — **modify**: `getErrors` merges pino errors + OOM across app/worker/system groups.
- `app/test/systemStatus.test.ts` — **modify/create**: cover OOM merge + unchanged local/degrade behavior.
- `RUNBOOK.md` — **modify**: disk-alarm row, two memory rows, a "CloudWatch agent" subsection, the `/hc/<env>/system` + OOM note, the one-time SSM command.
- `docs/issues/cloudwatch-agent-disk-metric.md` — **modify**: resolve on completion.

> **Dependency note:** the `/hc/<env>/system` log group (Task 3) must exist before the agent ships to it (Task 1 references the name) and before the app reads it (Task 6). The agent config is just a string reference, so authoring order is flexible, but **apply Task 3 before/with Task 1** at deploy time.

---

## Phase 1 — CloudWatch agent + host metrics (infra)

### Task 1: Install the CloudWatch agent + rsyslog in EC2 user_data

**Files:**
- Modify: `infra/modules/ec2/main.tf` (the `user_data` heredoc, ~L249-260)

**Interfaces:**
- Produces: the `CWAgent/disk_used_percent` (dims `InstanceId,path=/,fstype=xfs`) and `CWAgent/mem_used_percent` (dim `InstanceId`) metrics on any newly-created instance; kernel/system lines shipped to `/hc/${var.env}/system`.

- [ ] **Step 1: Extend the `user_data` heredoc.** Replace the existing block so it keeps the Docker/compose setup and appends the monitoring setup. Full replacement:

```hcl
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf install -y docker
    systemctl enable --now docker
    # docker compose v2 CLI plugin (ARM64) — not packaged in AL2023 repos.
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL --retry 5 -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/${var.compose_version}/docker-compose-linux-aarch64"
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    mkdir -p /opt/hc

    # --- Host observability (M0.5/M0.6, finished 2026-07-01) ---------------
    # rsyslog so kernel/system messages (incl. the OOM killer's
    # "Out of memory: Killed process ...") land in /var/log/messages — AL2023 is
    # journald-only by default and the CloudWatch agent tails FILES, not journald.
    dnf install -y rsyslog
    systemctl enable --now rsyslog
    # CloudWatch agent: host disk + memory metrics, and ship /var/log/messages
    # (OOM lines) to /hc/${var.env}/system. IAM already grants PutMetricData
    # (CWAgent namespace) + logs on /hc/${var.env}/*.
    dnf install -y amazon-cloudwatch-agent
    cat > /opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json <<'CWCONFIG'
    {
      "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
      "metrics": {
        "namespace": "CWAgent",
        "append_dimensions": { "InstanceId": "$${aws:InstanceId}" },
        "metrics_collected": {
          "mem": { "measurement": ["mem_used_percent"] },
          "disk": { "measurement": ["disk_used_percent"], "resources": ["/"], "drop_device": true }
        }
      },
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/log/messages",
                "log_group_name": "/hc/${var.env}/system",
                "log_stream_name": "{instance_id}"
              }
            ]
          }
        }
      }
    }
    CWCONFIG
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json
  EOT
```

> Notes for the implementer: `$${aws:InstanceId}` is deliberate (Terraform heredoc escaping → literal `${aws:InstanceId}`). `run_as_user: root` is required so the agent can read `/var/log/messages`. `drop_device: true` yields exactly `InstanceId,path,fstype` dims (matches the alarm in Task 4). The agent writes to the TF-created group (Task 3); no `retention_in_days` in the agent config — Terraform owns retention.

- [ ] **Step 2: `terraform validate`.** Run: `npm run plan -- dev` is heavier; first do a syntax check. Run `terraform -chdir=infra/envs/dev validate`. Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Confirm no instance replacement.** Run `npm run plan -- dev`. Expected in the plan: `aws_instance.app` shows an **in-place update** to `user_data` (`~ user_data`), **not** `-/+ destroy and then create`. If it shows a replace, STOP — add `user_data_replace_on_change = false` explicitly to the `aws_instance "app"` resource and re-plan. (Do NOT apply.)

- [ ] **Step 4: Commit.**

```bash
git add infra/modules/ec2/main.tf
git commit -m "feat(infra): install cloudwatch-agent + rsyslog in EC2 user_data (disk/mem metrics + OOM log shipping)"
```

---

## Phase 2 — Alarms, dashboard, system log group (infra/observability)

### Task 2: Add the memory-alarm threshold variables

**Files:**
- Modify: `infra/modules/observability/variables.tf`

**Interfaces:**
- Produces: `var.mem_used_warn_threshold` (default 80), `var.mem_used_critical_threshold` (default 90) — defaults carry the operating values so env stacks don't pass them (same convention as `disk_used_alarm_threshold`).

- [ ] **Step 1: Append the two variables** (after `disk_used_alarm_threshold`):

```hcl
variable "mem_used_warn_threshold" {
  description = "mem_used_percent (CloudWatch agent) that trips the WARNING memory alarm (sustained 15 min). 2 GB t4g.small runs the app+worker Node containers."
  type        = number
  default     = 80
}

variable "mem_used_critical_threshold" {
  description = "mem_used_percent (CloudWatch agent) that trips the CRITICAL memory alarm (5 min) — near-OOM acute spike."
  type        = number
  default     = 90
}
```

- [ ] **Step 2: `terraform -chdir=infra/envs/dev validate`.** Expected: valid.
- [ ] **Step 3: Commit.**

```bash
git add infra/modules/observability/variables.tf
git commit -m "feat(infra): memory-alarm threshold variables (warn 80 / critical 90)"
```

### Task 3: Create the `/hc/<env>/system` log group (standalone — NOT a pino group)

**Files:**
- Modify: `infra/modules/observability/main.tf` (near the `aws_cloudwatch_log_group "proc"` block, ~L16-21)

**Interfaces:**
- Produces: log group `/hc/${var.env}/system` (retention `var.log_retention_days`).

> **CRITICAL:** do NOT add `"system"` to `local.log_groups`. That list drives the pino metric filters (`{ $.correlationId NOT EXISTS }` OrphanLogs + `{ $.level >= 50 }` ErrorLogs). Kernel lines are NOT pino JSON, so every one would match "correlationId NOT EXISTS" → the OrphanLogs alarm would false-fire. The system group must be a standalone resource with no metric filters.

- [ ] **Step 1: Add the standalone group** (immediately after the `aws_cloudwatch_log_group "proc"` resource):

```hcl
# Host/system log (rsyslog /var/log/messages, shipped by the CloudWatch agent):
# kernel OOM-killer lines etc. STANDALONE — deliberately NOT in local.log_groups,
# so the pino OrphanLogs/ErrorLogs metric filters do NOT run on it (non-JSON
# kernel lines would otherwise trip OrphanLogs). System Status reads it for OOM.
resource "aws_cloudwatch_log_group" "system" {
  name              = "/hc/${var.env}/system"
  retention_in_days = var.log_retention_days
}
```

- [ ] **Step 2: `terraform -chdir=infra/envs/dev validate`.** Expected: valid.
- [ ] **Step 3: `npm run plan -- dev`.** Expected: one new `aws_cloudwatch_log_group.system` to add; no metric filters attached to it. (Do NOT apply.)
- [ ] **Step 4: Commit.**

```bash
git add infra/modules/observability/main.tf
git commit -m "feat(infra): /hc/<env>/system log group for shipped kernel/OOM lines"
```

### Task 4: Two-tier memory alarms + refresh disk alarm comment

**Files:**
- Modify: `infra/modules/observability/main.tf` (add after the `aws_cloudwatch_metric_alarm "disk_used"` block; also touch that block's comment/description)

**Interfaces:**
- Consumes: `var.mem_used_warn_threshold`, `var.mem_used_critical_threshold` (Task 2); `aws_sns_topic.alerts` (existing, L116).
- Produces: alarms `${var.name_prefix}mem-used` and `${var.name_prefix}mem-used-critical`.

- [ ] **Step 1: Update the disk alarm's stale comment.** In the `aws_cloudwatch_metric_alarm "disk_used"` block (~L229-236) change the two "agent arrives M0.5/M0.6" mentions to reflect it now ships. Replace the description line with:

```hcl
  alarm_description   = "Root volume above ${var.disk_used_alarm_threshold}% (CWAgent disk_used_percent; agent installed via EC2 user_data)."
```

and update the preceding comment block to drop "agent arrives M0.5/M0.6". Leave `treat_missing_data = "notBreaching"` (a dead agent goes quiet rather than false-firing). Confirm its `dimensions` are exactly `{ InstanceId, path = "/", fstype = "xfs" }` (matches `drop_device: true`).

- [ ] **Step 2: Add the two memory alarms** (after the disk alarm block):

```hcl
# Host memory. Two-tier, both → the alerts SNS topic:
#   warn:     mem_used_percent > 80% sustained 15 min (3 x 5-min) — slow leak/creep.
#   critical: mem_used_percent > 90% for 5 min (1 x 5-min)        — acute near-OOM spike.
# Data arrives once the CloudWatch agent is installed (Task 1); notBreaching keeps
# them quiet before that / if the agent dies. On a 2 GB t4g.small the app+worker
# Node containers make memory the real pressure point (OOM survived by
# restart:unless-stopped; these alarms are the leading-indicator warning).
resource "aws_cloudwatch_metric_alarm" "mem_used" {
  alarm_name          = "${var.name_prefix}mem-used"
  alarm_description   = "Memory above ${var.mem_used_warn_threshold}% sustained 15 min (CWAgent mem_used_percent)."
  namespace           = "CWAgent"
  metric_name         = "mem_used_percent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.mem_used_warn_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = var.instance_id
  }
}

resource "aws_cloudwatch_metric_alarm" "mem_used_critical" {
  alarm_name          = "${var.name_prefix}mem-used-critical"
  alarm_description   = "Memory above ${var.mem_used_critical_threshold}% for 5 min (CWAgent mem_used_percent) — acute near-OOM."
  namespace           = "CWAgent"
  metric_name         = "mem_used_percent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.mem_used_critical_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = var.instance_id
  }
}
```

- [ ] **Step 2b: Add a memory dashboard widget.** Find the disk widget in the dashboard `properties`/`widgets` JSON (~L322-331, title "Disk used % …"). Add a sibling widget mirroring it, adjusting `x`/`y` so it doesn't overlap (pick the next free grid slot, e.g. `x = 0, y = 12` if free — verify against the existing layout):

```hcl
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "Memory used %"
          region = data.aws_region.current.region
          stat   = "Maximum"
          period = 300
          metrics = [
            ["CWAgent", "mem_used_percent", "InstanceId", var.instance_id],
          ]
        }
      },
```

- [ ] **Step 3: `terraform -chdir=infra/envs/dev validate`.** Expected: valid.
- [ ] **Step 4: `npm run plan -- dev`.** Expected: 2 new `aws_cloudwatch_metric_alarm` (mem_used, mem_used_critical) to add; the disk alarm shows only an in-place description/comment change; dashboard body updated. (Do NOT apply.)
- [ ] **Step 5: Commit.**

```bash
git add infra/modules/observability/main.tf
git commit -m "feat(infra): two-tier memory alarms + dashboard widget; refresh disk alarm"
```

---

## Phase 3 — OOM visibility on System Status (app)

### Task 5: Add worker + system log-group names to config

**Files:**
- Modify: `app/src/lib/config.ts` (interface near L51; resolution near L288; return near L611)
- Test: `app/test/config.test.ts` (if it exists; else add a focused assertion to the nearest config test)

**Interfaces:**
- Produces: `config.workerLogGroupName` = `/hc/<appEnv>/worker`, `config.systemLogGroupName` = `/hc/<appEnv>/system`.

- [ ] **Step 1: Write the failing test.** In the config test file, assert the new fields for a resolved config:

```ts
it('derives worker + system log group names from appEnv', () => {
  const cfg = loadConfig({ ...baseEnv, HC_ENV: 'dev' }); // match how existing tests build env
  expect(cfg.workerLogGroupName).toBe('/hc/dev/worker');
  expect(cfg.systemLogGroupName).toBe('/hc/dev/system');
});
```

(Match the existing test's config-loading helper/fixture; `errorLogGroupName` tests in this file show the pattern.)

- [ ] **Step 2: Run it, expect FAIL.** Run: `npm test -w app -- config` → FAIL (properties undefined).
- [ ] **Step 3: Implement.** In the `AppConfig` interface, after `errorLogGroupName`:

```ts
  /** The worker log group for THIS env — `/hc/<appEnv>/worker`. */
  workerLogGroupName: string;
  /** The host/system log group for THIS env — `/hc/<appEnv>/system` (rsyslog: kernel OOM etc.). */
  systemLogGroupName: string;
```

After `const errorLogGroupName = ...` (~L288):

```ts
  const workerLogGroupName = `/hc/${appEnv}/worker`;
  const systemLogGroupName = `/hc/${appEnv}/system`;
```

In the returned config object, after `errorLogGroupName,` (~L611):

```ts
    workerLogGroupName,
    systemLogGroupName,
```

- [ ] **Step 4: Run it, expect PASS.** Run: `npm test -w app -- config` → PASS. Also `npm run typecheck -w app` → clean.
- [ ] **Step 5: Commit.**

```bash
git add app/src/lib/config.ts app/test/config.test.ts
git commit -m "feat(app): config workerLogGroupName + systemLogGroupName"
```

### Task 6: `filterEventsByPattern` on the CloudWatch seam + OOM patterns

**Files:**
- Modify: `app/src/adapters/cloudwatch.ts`
- Test: `app/test/cloudwatch.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: seam method `filterEventsByPattern(logGroup: string, sinceMs: number, limit: number, filterPattern: string): Promise<ErrorEventView[]>`; exported consts `OOM_APP_FILTER_PATTERN`, `OOM_SYSTEM_FILTER_PATTERN`. `filterErrorEvents` keeps its exact behavior (now implemented via the shared scanner).

- [ ] **Step 1: Write the failing test.** In `app/test/cloudwatch.test.ts`, add (using the file's existing fake `CloudWatchLogsClient` pattern — a `send` stub returning `{ events: [...] }`):

```ts
it('filterEventsByPattern passes the pattern through and projects raw (non-JSON) OOM lines', async () => {
  const sent: any[] = [];
  const logs = { send: vi.fn(async (cmd: any) => { sent.push(cmd.input); return { events: [
    { message: 'Out of memory: Killed process 1234 (node)', timestamp: 1000 },
  ] }; }) } as any;
  const seam = createCloudWatchClient({ config: fakeConfig, logs, cloudwatch: {} as any });

  const events = await seam.filterEventsByPattern('/hc/dev/system', 0, 25, OOM_SYSTEM_FILTER_PATTERN);

  expect(sent[0].filterPattern).toBe(OOM_SYSTEM_FILTER_PATTERN);
  expect(events).toHaveLength(1);
  expect(events[0].message).toContain('Out of memory: Killed process');
  expect(events[0].level).toBe(50); // non-JSON → default level (still surfaced)
});

it('filterErrorEvents still uses the pino level>=50 JSON pattern', async () => {
  const sent: any[] = [];
  const logs = { send: vi.fn(async (cmd: any) => { sent.push(cmd.input); return { events: [] }; }) } as any;
  const seam = createCloudWatchClient({ config: fakeConfig, logs, cloudwatch: {} as any });
  await seam.filterErrorEvents('/hc/dev/app', 0, 25);
  expect(sent[0].filterPattern).toBe('{ $.level >= 50 }');
});
```

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -w app -- cloudwatch` → FAIL (`filterEventsByPattern` / consts not defined).
- [ ] **Step 3: Implement.** In `cloudwatch.ts`:

Add the exported constants (near the top, after the scan-budget consts):

```ts
/** CloudWatch filter patterns for OOM lines (unstructured — NOT pino JSON, so the
 *  `{ $.level >= 50 }` error query never matches them). `?term` = OR match. */
export const OOM_APP_FILTER_PATTERN = '?"JavaScript heap out of memory" ?"Reached heap limit"';
export const OOM_SYSTEM_FILTER_PATTERN = '?"Out of memory: Killed process" ?"oom-kill:" ?"oom_reaper"';
```

Add `filterEventsByPattern` to the `CloudWatchClientSeam` interface (next to `filterErrorEvents`):

```ts
  /**
   * FilterLogEvents on `logGroup` with an ARBITRARY `filterPattern` since `sinceMs`,
   * newest-first, capped at `limit`. Same bounded paged scan as filterErrorEvents.
   * Used to surface OOM lines (raw text) that the pino level>=50 query misses.
   */
  filterEventsByPattern(logGroup: string, sinceMs: number, limit: number, filterPattern: string): Promise<ErrorEventView[]>;
```

Refactor the paging loop into a private helper and back both methods with it:

```ts
async function scanFiltered(
  logs: CloudWatchLogsClient, logGroup: string, sinceMs: number, limit: number, filterPattern: string,
): Promise<ErrorEventView[]> {
  const projected: ErrorEventView[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const out = await logs.send(new FilterLogEventsCommand({
      logGroupName: logGroup, startTime: sinceMs, filterPattern, nextToken,
    }));
    for (const e of out.events ?? []) projected.push(projectErrorEvent(e.message ?? '', e.timestamp ?? Date.now()));
    nextToken = out.nextToken;
    pages += 1;
  } while (nextToken !== undefined && pages < ERROR_SCAN_MAX_PAGES && projected.length < ERROR_SCAN_MAX_EVENTS);
  projected.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return projected.slice(0, limit);
}
```

In the returned seam object, replace the inline `filterErrorEvents` body and add the new method:

```ts
    filterErrorEvents(logGroup, sinceMs, limit) {
      return scanFiltered(logs, logGroup, sinceMs, limit, '{ $.level >= 50 }');
    },
    filterEventsByPattern(logGroup, sinceMs, limit, filterPattern) {
      return scanFiltered(logs, logGroup, sinceMs, limit, filterPattern);
    },
```

- [ ] **Step 4: Run, expect PASS.** Run: `npm test -w app -- cloudwatch` → PASS. `npm run typecheck -w app` → clean.
- [ ] **Step 5: Commit.**

```bash
git add app/src/adapters/cloudwatch.ts app/test/cloudwatch.test.ts
git commit -m "feat(app): filterEventsByPattern seam + OOM filter patterns (DRY paged scan)"
```

### Task 7: `getErrors` merges pino errors + OOM across app/worker/system

**Files:**
- Modify: `app/src/services/systemStatus.ts` (the `getErrors` method, ~L161-181)
- Test: `app/test/systemStatus.test.ts`

**Interfaces:**
- Consumes: `filterErrorEvents` + `filterEventsByPattern` (Task 6); `config.errorLogGroupName`/`workerLogGroupName`/`systemLogGroupName` (Task 5); `OOM_APP_FILTER_PATTERN`/`OOM_SYSTEM_FILTER_PATTERN`.
- Produces: unchanged `ErrorsResult` shape; the events list now also includes OOM events.

- [ ] **Step 1: Write the failing tests.** In `app/test/systemStatus.test.ts` (fake `CloudWatchClientSeam`):

```ts
it('getErrors merges pino errors + OOM (app/worker V8 + system kernel), newest-first, capped', async () => {
  const seam: CloudWatchClientSeam = {
    describeAlarms: async () => [],
    filterErrorEvents: async () => [{ timestamp: '2026-07-01T00:00:01Z', level: 50, message: 'pino error', correlationId: 'c1' }],
    filterEventsByPattern: async (group, _s, _l, pattern) => {
      if (group.endsWith('/system')) return [{ timestamp: '2026-07-01T00:00:03Z', level: 50, message: 'Out of memory: Killed process 1 (node)', correlationId: null }];
      if (pattern === OOM_APP_FILTER_PATTERN) return [{ timestamp: '2026-07-01T00:00:02Z', level: 50, message: 'JavaScript heap out of memory', correlationId: null }];
      return [];
    },
  };
  const svc = createSystemStatusService({ config: deployedConfig, cloudwatch: seam });
  const res = await svc.getErrors('24h');
  expect(res.available).toBe(true);
  if (res.available) {
    expect(res.events.map((e) => e.message)).toEqual([
      'Out of memory: Killed process 1 (node)', // newest
      'JavaScript heap out of memory',
      'pino error',
    ]);
  }
});

it('getErrors still short-circuits locally with no SDK call', async () => {
  const seam = { describeAlarms: vi.fn(), filterErrorEvents: vi.fn(), filterEventsByPattern: vi.fn() } as any;
  const svc = createSystemStatusService({ config: localConfig, cloudwatch: seam });
  const res = await svc.getErrors();
  expect(res).toEqual({ available: false, reason: 'unavailable_local' });
  expect(seam.filterEventsByPattern).not.toHaveBeenCalled();
});
```

(`deployedConfig` = a config with `appEnv:'dev'`, `messagingDriver:'twilio'`, and the three log-group names set; `localConfig` = `appEnv:'local'`. Mirror the existing systemStatus test fixtures.)

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -w app -- systemStatus` → FAIL.
- [ ] **Step 3: Implement.** Add the OOM-pattern imports from the adapter, then replace the `try` block body in `getErrors`:

```ts
      const [appErrors, appOom, workerOom, systemOom] = await Promise.all([
        cloudwatch.filterErrorEvents(config.errorLogGroupName, sinceMs, ERROR_EVENT_LIMIT),
        cloudwatch.filterEventsByPattern(config.errorLogGroupName, sinceMs, ERROR_EVENT_LIMIT, OOM_APP_FILTER_PATTERN),
        cloudwatch.filterEventsByPattern(config.workerLogGroupName, sinceMs, ERROR_EVENT_LIMIT, OOM_APP_FILTER_PATTERN),
        cloudwatch.filterEventsByPattern(config.systemLogGroupName, sinceMs, ERROR_EVENT_LIMIT, OOM_SYSTEM_FILTER_PATTERN),
      ]);
      const seen = new Set<string>();
      const events = [...appErrors, ...appOom, ...workerOom, ...systemOom]
        .filter((e) => { const k = `${e.timestamp}|${e.message}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
        .slice(0, ERROR_EVENT_LIMIT);
      log.info({ window, errorCount: events.length }, 'system status: errors read');
      return { available: true, events };
```

Import at top: `import { ..., OOM_APP_FILTER_PATTERN, OOM_SYSTEM_FILTER_PATTERN } from '../adapters/cloudwatch.js';`

- [ ] **Step 4: Run, expect PASS.** Run: `npm test -w app -- systemStatus` → PASS. Then the full app suite `npm test -w app` → green; `npm run typecheck -w app` → clean.
- [ ] **Step 5: Commit.**

```bash
git add app/src/services/systemStatus.ts app/test/systemStatus.test.ts
git commit -m "feat(app): System Status errors surface OOM (app/worker V8 + system kernel)"
```

---

## Phase 4 — Ops, docs, verification

### Task 8: RUNBOOK + one-time SSM install command + resolve the issue

**Files:**
- Modify: `RUNBOOK.md`
- Modify: `docs/issues/cloudwatch-agent-disk-metric.md`

- [ ] **Step 1: RUNBOOK — alarms table.** In the alarms table, update the `disk-used` row (drop "agent not installed / can't fire"; it now reports real data) and add two rows for `mem-used` (warn, 80% / 15 min) and `mem-used-critical` (90% / 5 min), each: what it means (host memory pressure on the 2 GB box) + first response (SSM `free -m` / `docker stats`; check the app/worker for a leak; the box survives a kill via `restart: unless-stopped`).

- [ ] **Step 2: RUNBOOK — new "CloudWatch agent" subsection** (under the observability/alarms area). Cover: what it collects (`disk_used_percent` root, `mem_used_percent`); config lives at `/opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json` (written by EC2 `user_data`); `drop_device:true` so disk dims are `InstanceId,path,fstype`; rsyslog ships `/var/log/messages`; the agent ships it to `/hc/<env>/system`; System Status surfaces OOM lines from there (+ V8 heap OOM from app/worker groups). Include the **one-time install for an already-running instance** (cloud-init only runs at first boot):

```powershell
# One-time: install the agent on an ALREADY-RUNNING instance (dev now; prod at M1.11).
# Runs the same steps as user_data via SSM Run Command (no SSH). Fill <instance-id>.
aws ssm send-command --profile housingchoice --region us-east-1 `
  --instance-ids <instance-id> `
  --document-name "AWS-RunShellScript" `
  --parameters 'commands=["dnf install -y rsyslog amazon-cloudwatch-agent","systemctl enable --now rsyslog","aws s3 --version >/dev/null 2>&1 || true","cat > /opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json <<\"CFG\"\n{\"agent\":{\"metrics_collection_interval\":60,\"run_as_user\":\"root\"},\"metrics\":{\"namespace\":\"CWAgent\",\"append_dimensions\":{\"InstanceId\":\"${aws:InstanceId}\"},\"metrics_collected\":{\"mem\":{\"measurement\":[\"mem_used_percent\"]},\"disk\":{\"measurement\":[\"disk_used_percent\"],\"resources\":[\"/\"],\"drop_device\":true}}},\"logs\":{\"logs_collected\":{\"files\":{\"collect_list\":[{\"file_path\":\"/var/log/messages\",\"log_group_name\":\"/hc/dev/system\",\"log_stream_name\":\"{instance_id}\"}]}}}}\nCFG","/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json"]'
```

> The implementer must verify this SSM payload's JSON escaping actually applies cleanly (SSM + shell + heredoc nesting is finicky) — an acceptable alternative is to upload `hc-agent.json` to the instance via a small script and reference it. The RUNBOOK entry is operator-facing; keep the `/hc/dev/system` group name env-correct (dev vs prod).

- [ ] **Step 3: `npm run issues` sanity**, then resolve the issue. Edit `docs/issues/cloudwatch-agent-disk-metric.md` frontmatter → `status: resolved` + `resolved: <date>`, and add a `**Resolution.**` paragraph: agent installed via EC2 user_data + one-time SSM; disk + memory metrics flow; memory two-tier alarms added; OOM surfaced on System Status. Run `npm run issues` and confirm it moves to Closed.

- [ ] **Step 4: Commit.**

```bash
git add RUNBOOK.md docs/issues/cloudwatch-agent-disk-metric.md
git commit -m "docs(runbook): CloudWatch agent + memory alarms + OOM visibility; resolve issue"
```

### Task 9: Final verification (post-apply — operator-gated)

> These steps require the operator to `apply` + run the one-time SSM command. The builder prepares them and reports; the operator executes. Do NOT apply.

- [ ] **Step 1:** Operator runs `npm run plan -- dev` (final review: in-place `user_data`, new system log group, 2 mem alarms, dashboard update — **no instance replacement**), then `npm run apply -- dev`, then the Task-8 one-time SSM command.
- [ ] **Step 2: Verify metrics flow.** In CloudWatch → Metrics → `CWAgent`: `disk_used_percent` (dims InstanceId,path=/,fstype=xfs) and `mem_used_percent` (dim InstanceId) both have recent datapoints. The `hc-dev-disk-used`, `hc-dev-mem-used`, `hc-dev-mem-used-critical` alarms leave `INSUFFICIENT_DATA` for `OK`.
- [ ] **Step 3: Verify OOM surfacing.** Induce a Node heap OOM on dev (throwaway container `node --max-old-space-size=8 -e "const a=[];while(1)a.push(Buffer.alloc(1e6))"`), confirm the line appears in `/hc/dev/app` (or run it as the worker), and confirm it shows on Settings → System Status → errors. If feasible, drive a cgroup kill (`stress`) and confirm the `/hc/dev/system` "Out of memory: Killed process" line surfaces too.
- [ ] **Step 4:** Confirm the full app suite + typecheck are green on the branch, then hand back for merge (human merges; do not merge to `main`).

---

## Self-review notes (author)

- **Spec coverage:** agent install (T1) ✓; disk drop_device dims (T1/T4) ✓; two-tier memory alarms 80/15m + 90/5m (T4) ✓; dashboard widget (T4) ✓; no IAM change (constraint) ✓; no instance replacement (T1 step 3) ✓; OOM on System Status incl. kernel + V8 (T3/T5/T6/T7) ✓; one-time SSM + RUNBOOK (T8) ✓; resolve issue (T8) ✓; verification (T9) ✓.
- **Known implementation risks flagged for the builder:** (a) Terraform heredoc `$${aws:InstanceId}` escaping; (b) the SSM one-time payload's nested-JSON escaping (offer the upload-a-file alternative); (c) `run_as_user: root` needed to read `/var/log/messages`; (d) the system log group must stay OUT of `local.log_groups`; (e) confirm dashboard widget grid coordinates don't overlap existing widgets.
- **Out of scope (YAGNI):** CPU/swap/inode metrics; a dedicated OOM metric-filter alarm; worker *pino* errors on the panel (still app-only — a separate pre-existing gap, deliberately not expanded here); agent-liveness heartbeat.
