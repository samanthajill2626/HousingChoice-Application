---
id: api-rate-limiting
title: No rate limiting on the /api manual-send route
type: security
severity: med
status: open
area: app/api
created: 2026-06-11
---

**Problem.** The `/api` manual-send route has no Express rate limit. It is
origin-secret-protected only, so a leaked origin secret currently means unthrottled sends.

**Suggested fix.** Add an Express rate limit on the manual-send route. (Originally framed as
"before M1.3 auth lands"; OAuth/RBAC reduces but does not remove the case for throttling.)

Migrated from the RUNBOOK "Security / hardening backlog".
