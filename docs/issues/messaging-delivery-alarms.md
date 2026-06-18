---
id: messaging-delivery-alarms
title: Missing alarms for webhook signature rejections and undelivered/throttled SMS
type: improvement
severity: med
status: open
area: infra/observability
created: 2026-06-11
---

**Problem.** There is no metric filter + alarm for webhook signature rejections or for
undelivered-rate / 429-30022 throttling (the doc-§9 alarm table). Today only 30007 carrier
filtering and breaker trips reach ERROR / the error-logs alarm — other delivery failures are
invisible.

**Suggested fix.** Add the metric filters + alarms from the §9 alarm table (signature
rejections; undelivered-rate; 429/30022 throttling).

Noted as an "M1.1 gap". Migrated from the RUNBOOK "Security / hardening backlog".
