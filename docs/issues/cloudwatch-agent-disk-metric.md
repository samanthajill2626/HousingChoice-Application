---
id: cloudwatch-agent-disk-metric
title: CloudWatch agent not installed — disk-used alarms can't fire
type: debt
severity: med
status: open
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
