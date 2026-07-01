# CloudWatch host-metrics monitoring (disk + memory) + OOM visibility — design spec

> Date: 2026-07-01 · Status: approved (brainstorm) → ready for implementation plan.
> **HANDOFF:** this spec is written to be turned into an implementation plan and built by a
> **separate agent**. It is self-contained; read it top to bottom before planning.

## 1. Goal & context

Stand up the **CloudWatch agent** on the app EC2 box so host disk + memory metrics actually
flow, alarm on both, and make **out-of-memory (OOM) events visible on the Settings → System
Status page**.

Context (verified 2026-07-01):
- The CloudWatch agent was scoped in Phase 0 but **never installed**. EC2 `user_data`
  ([`infra/modules/ec2/main.tf:249-260`](../../../infra/modules/ec2/main.tf#L249)) installs
  only Docker + the compose plugin.
- The **disk-used alarm already exists** but has been **dark since Phase 0** — it reads the
  `CWAgent/disk_used_percent` metric that nothing produces
  ([`infra/modules/observability/main.tf:233`](../../../infra/modules/observability/main.tf#L233));
  `treat_missing_data = notBreaching` keeps it quietly OK.
- The instance is **`t4g.small` (2 GB RAM, 2 vCPU Graviton)**, 10 GB gp3 root. On 2 GB running
  the `app` + `worker` Node containers, **memory pressure is a real risk** — hence the memory ask.
- The instance role **already grants** `cloudwatch:PutMetricData` on the `CWAgent` namespace and
  `logs:*` on `/hc/<env>/*` ([`ec2/main.tf:173-184`](../../../infra/modules/ec2/main.tf#L173),
  and the logs statement just above it) — so **no IAM change is needed**.
- App/worker container **stdout/stderr already ship to `/hc/<env>/app` + `/hc/<env>/worker`**
  via the Docker **`awslogs`** driver (`docker-compose.yml`).
- System Status "recent errors" reads ONE log group with the server-side filter
  **`{ $.level >= 50 }`** (pino JSON only) — [`app/src/adapters/cloudwatch.ts:207`](../../../app/src/adapters/cloudwatch.ts#L207),
  driven from [`app/src/services/systemStatus.ts`](../../../app/src/services/systemStatus.ts).

## 2. Decisions (locked in brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Metrics collected | **`disk_used_percent` (root `/`) + `mem_used_percent`** only. No CPU (basic `AWS/EC2 CPUUtilization` + `StatusCheckFailed` alarm already cover it), no swap (AL2023 has none), no inode. |
| D2 | Disk dimensions | **`drop_device: true`** → dims `InstanceId, path=/, fstype=xfs`. Device names (`nvme…`) are unstable across instance replacement; `path` is the stable discriminator. Update the existing alarm to match these dims explicitly (we own both sides). |
| D3 | Memory alarms | **Two-tier**, both → the existing `alerts` SNS topic: **warning** `mem_used_percent > 80%` for 3×5 min (15 min sustained); **critical** `mem_used_percent > 90%` for 1×5 min. |
| D4 | Disk alarm | Unchanged threshold/sensitivity (80% / 5 min); just update its stale "agent arrives M0.5/M0.6" comment + confirm dims (D2). |
| D5 | Install mechanism | **EC2 `user_data`** (install `amazon-cloudwatch-agent`, write config, start) **+ a one-time SSM Run Command** to install on the already-running dev box (cloud-init runs only at first boot). |
| D6 | Instance replacement | **None.** `user_data` change applies in-place (`user_data_replace_on_change = false`, the default) — must NOT recreate the instance. Confirm the plan shows an in-place `user_data` update, not a replace. |
| D7 | IAM | No change (already granted — see §1). |
| D8 | OOM visibility | **Surface OOM on the System Status errors panel** (see §4). **No dedicated OOM metric-filter alarm** — the memory alarms (D3) are the leading indicator; container `restart: unless-stopped` already survives a kill. |

## 3. Components — the agent + metrics + alarms

1. **EC2 `user_data`** ([`ec2/main.tf:249`](../../../infra/modules/ec2/main.tf#L249)) — after the
   Docker install, add: `dnf install -y amazon-cloudwatch-agent`; write a config JSON; start via
   `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:<path>`.
2. **Agent config JSON** — `metrics.append_dimensions = { InstanceId }`, 60 s interval, collecting:
   - `disk`: measurement `disk_used_percent`, `resources: ["/"]`, **`drop_device: true`** (dims → `InstanceId, path, fstype`).
   - `mem`: measurement `mem_used_percent` (dim → `InstanceId`).
   - Store the config inline in `user_data` (fixed config; no SSM-Parameter indirection needed).
3. **observability module** ([`observability/main.tf`](../../../infra/modules/observability/main.tf) + `variables.tf`):
   - New alarm `${name_prefix}mem-used` — `mem_used_percent`, namespace `CWAgent`, dim `InstanceId`,
     threshold `var.mem_used_warn_threshold` (default **80**), period 300, evaluation_periods 3,
     `GreaterThanThreshold`, `treat_missing_data = notBreaching`, alarm+ok actions → `alerts` SNS.
   - New alarm `${name_prefix}mem-used-critical` — same, threshold `var.mem_used_critical_threshold`
     (default **90**), evaluation_periods **1**.
   - New dashboard widget for `mem_used_percent` (mirror the existing disk widget ~line 322).
   - Update the disk alarm + widget comments (drop "agent arrives M0.5/M0.6"); confirm disk dims = D2.
   - Two new threshold variables with the defaults above.

## 4. OOM visibility on System Status (the nuanced part)

**Requirement:** an OOM event must appear on the Settings → System Status **errors** panel. Today it
would not (see the finding: the panel filters `{ $.level >= 50 }`, and OOM produces either no app log
at all or a non-JSON line).

**Two OOM modes, two sources:**
- **Kernel OOM-kill (SIGKILL):** only trace is the host kernel/journal line
  `Out of memory: Killed process <pid> (node)` (also `oom-kill:`/`oom_reaper`). Not in any app log group.
- **Node V8 heap OOM:** Node prints `FATAL ERROR: … JavaScript heap out of memory` to **stderr** →
  already shipped to `/hc/<env>/app` (or `/hc/<env>/worker`) via `awslogs`, but as **plain text** →
  the `{ $.level >= 50 }` filter drops it.

**Mechanism (design intent):**
1. **Ship the host OOM signal.** Extend the CloudWatch agent config with a **logs** collection for
   the kernel/system log, into a **new `/hc/<env>/system` CloudWatch log group** (Terraform-created;
   covered by the existing `/hc/<env>/*` logs IAM). Prefer scoping to OOM-relevant lines if practical.
   - *Implementation question for the plan:* the exact AL2023 source for kernel OOM lines
     (journald vs `/var/log/messages`) and whether the installed agent version collects journald or
     needs a file (rsyslog). Resolve concretely in the plan; do not leave hand-wavy.
2. **Surface it in System Status.** Extend `systemStatus.getErrors` +
   `cloudwatch.filterErrorEvents` so the errors list ALSO includes OOM events:
   - Scan the new `/hc/<env>/system` group with a **text** filter matching the kernel OOM patterns,
     projecting matches as PII-safe error events (level 60/"fatal", short message e.g.
     `OOM-kill: node`, no PID/PII beyond process name).
   - ALSO match the **V8 heap-OOM text** (`JavaScript heap out of memory` / `Reached heap limit`) in
     the existing app/worker group so the Node-heap case surfaces too (the current `{ $.level >= 50 }`
     query stays for pino errors; add the text match alongside — do not remove the JSON query).
   - Keep the merged list newest-first, still capped (existing `ERROR_PROJECTION_CAP`).
3. **No dedicated OOM alarm** (per D8). Visibility = the errors panel here + the D3 memory alarms.

Keep the change **isolated**: the new behavior lives behind the existing `SystemStatusService` /
`CloudWatchClientSeam` interfaces so it stays unit-testable with a fake CloudWatch seam.

## 5. Operational

- **One-time install on the running dev instance** (cloud-init won't re-run): an SSM Run Command that
  performs the same `dnf install` + config-write + `agent-ctl` start. Document it in `RUNBOOK.md`.
- **Prod**: inherits the agent via `user_data` when its instance is created, OR the same one-time SSM
  command at the **M1.11 go-live cutover** (prod infra is applied then per the RUNBOOK).
- **RUNBOOK updates:** the disk-alarm row (agent now installed), the two new memory-alarm rows, a short
  "CloudWatch agent" subsection (what it is, config location, the one-time install, the drop_device
  dimension note), and the `/hc/<env>/system` log group + OOM-on-System-Status note.

## 6. Testing / verification

- `terraform validate` + `npm run plan -- dev`: expect an **in-place `user_data` update (NO replace)**,
  2 new memory alarms, the memory widget, and the new `/hc/<env>/system` log group. Fail the plan review
  if it shows an instance replacement.
- After `apply` + the one-time SSM install: confirm `CWAgent/disk_used_percent` + `mem_used_percent`
  appear in CloudWatch; the disk + two memory alarms leave `INSUFFICIENT_DATA` for `OK`.
- **App-code unit tests** (Vitest, fake CloudWatch seam): the extended `getErrors` surfaces (a) a kernel
  OOM line from the system group and (b) a V8 heap-OOM text line from the app group, both projected
  PII-safe; the existing `{ $.level >= 50 }` pino-error behavior is unchanged.
- **OOM smoke (dev):** induce a Node heap OOM (e.g. a throwaway container with a tiny
  `--max-old-space-size`) and/or a `stress`-driven cgroup kill, and confirm it appears on the System
  Status errors panel.
- Resolve [`docs/issues/cloudwatch-agent-disk-metric.md`](../../issues/cloudwatch-agent-disk-metric.md)
  when live-verified on dev.

## 7. Scope guard (YAGNI)

- Metrics: disk + memory only (no CPU/swap/inode).
- No dedicated OOM metric-filter **alarm**; no per-container metrics.
- Log shipping is limited to the **OOM/system signal**, not wholesale system-log ingestion, unless the
  simplest reliable AL2023 approach happens to be the full system log (a plan decision).
- No agent-liveness ("is the agent still running") heartbeat — noted as possible future work, out of scope.

## 8. Repo conventions for the implementer

- **Work in a git worktree under `w:\tmp`** (shared checkout + concurrent agents; do NOT move `main`'s
  HEAD). See the project's no-branch-switching / worktree-location norms.
- **Infra is operator-applied.** The builder writes Terraform + the SSM command + docs and verifies
  `validate`/`plan`; the human runs `apply`/SSM. Do not run `apply`.
- Follow `.claude/CLAUDE.md` (glossary, issue tracking) and stamp/resolve the issue file on completion.
