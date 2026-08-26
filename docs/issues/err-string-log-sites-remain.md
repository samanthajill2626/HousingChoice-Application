---
id: err-string-log-sites-remain
title: Three log sites still put a bare message string under `err`, so err.stack and err.type queries silently return nothing for them
type: debt
severity: low
status: open
area: app
created: 2026-08-25
refs: app/src/routes/auth.ts:311, app/src/services/systemStatus.ts:204, app/src/services/systemStatus.ts:258
---

**Problem.** `feat/log-hygiene` (2026-08-25) wired a safe error serializer onto
the four logger keys `err` / `error` / `cause` / `reason`
(`app/src/lib/logSerializers.ts`), and converted the four `pushService.ts`
payloads that logged `err: (err as Error).message` to pass the Error object
itself, so `type`, `code`, `status` and `stack` survive into CloudWatch.

Three sibling sites elsewhere in `app/src` were left on the string form:

| site | line |
|---|---|
| `app/src/routes/auth.ts` | `:311` - logout: removing this device push subscription failed |
| `app/src/services/systemStatus.ts` | `:204` - system status: DescribeAlarms failed |
| `app/src/services/systemStatus.ts` | `:258` - system status: Logs Insights query failed |

`err` is therefore HETEROGENEOUS across the app: usually a projected object,
but a bare message string on these three lines. The consequence is concrete and
silent. `RUNBOOK.md` (around `:2103`) documents the standing operator query

```
fields @timestamp, @logStream, correlationId, msg, err.stack
| filter level >= 50 and @timestamp > now() - 1h
```

which now returns a stack for every converted site and an empty column for
these three, with nothing in the output saying why. The same applies to any
query or dashboard keying on `err.type` or `err.code`. Both systemStatus lines
are `log.error`, i.e. they are alarm-feeding lines whose forensic detail is
exactly what an operator reaches for.

Nothing leaks here - the string form is strictly less information than the
object form, and the serializer's allowlist is what makes the object form safe
to adopt. This is a consistency and forensics gap, not a security one.

**Why it was not fixed in that branch.** Out of the adjudicated scope. The
log-hygiene spec, section 10 ("What this mission deliberately does NOT do"),
rules out a repo-wide forced conversion; the mission converted only the
`pushService.ts` payloads its own issue required. The remainder was recorded
rather than swept, which is what this file is.

**Suggested fix.** Change the three payloads to pass the caught value under
`err` instead of `(err as Error).message`, leaving every message string and
every sibling field alone:

- `auth.ts:311` - `{ userId: req.user.userId, err }`
- `systemStatus.ts:204` - `{ kind: classifyCloudWatchError(err), err }`
- `systemStatus.ts:258` - `{ window, kind: classifyCloudWatchError(err), err }`

`classifyCloudWatchError` already reads the raw error, so nothing about the
`kind` field changes. Each is a payload-object edit with no behavior change
beyond the shape of the logged field.

Two things to check in the same pass rather than after it:

1. The CloudWatch error-detail path filters records through a hard field
   allowlist (`ERR_ALLOWLIST` in `app/src/adapters/cloudwatch.ts`, from the
   error-surface-detail feature). Confirm it carries the serializer's field set
   before assuming the converted lines render in the panel.
2. `app/test/logCallSiteGuard.test.ts` is the static guard over catch-clause
   identifiers logged outside the wired keys; it does not flag the string form,
   so it will neither block nor confirm this change. A green guard is not
   evidence the conversion happened.
