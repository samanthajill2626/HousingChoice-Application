---
id: cloudwatch-agent-disk-metric
title: CloudWatch agent not installed — disk-used alarms can't fire
type: debt
severity: med
status: resolved
resolved: 2026-07-01
area: infra/aws
created: 2026-06-11
---

**Problem.** `hc-dev-disk-used` / `hc-prod-disk-used` alarm on `disk_used_percent`, but the
CloudWatch agent that emits that metric is **not installed** — the alarms see no data and
`notBreaching` keeps them quietly OK, so they cannot actually fire. Disk is currently
protected only by deploy-time pruning (post-deploy ~26% used).

**Suggested fix.** Install the CloudWatch agent via user-data or SSM Distributor; the config
must emit `CWAgent disk_used_percent` with dimensions `InstanceId, path="/", fstype="xfs"`
to match the existing alarm.

Migrated from the RUNBOOK "Security / hardening backlog".

**Resolution.** The CloudWatch agent is now installed and configured via EC2 `user_data` (new
instances get it at first boot) and via a one-time SSM Run Command for any already-running
instance (see RUNBOOK "CloudWatch agent" subsection). The agent emits `CWAgent
disk_used_percent` (dimensions `InstanceId`, `path="/"`, `fstype="xfs"`) and
`CWAgent mem_used_percent` (dimension `InstanceId`), so both the `hc-<env>-disk-used` alarm
and the two new memory alarms (`hc-<env>-mem-used` warn 80%/15 min,
`hc-<env>-mem-used-critical` 90%/5 min) now receive real data. rsyslog also ships
`/var/log/messages` to `/hc/<env>/system`, surfacing kernel OOM-kill lines on System Status.
The disk alarm caveat has been removed from the RUNBOOK alarms table.
