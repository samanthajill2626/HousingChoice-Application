# Error surface detail - design

Date: 2026-08-24
Status: DRAFT (awaiting human spec review)
Branch: feat/error-surface-detail
Worktree: W:\tmp\error-surface-detail

## 1. Problem

Operators troubleshooting from the dashboard see error rows whose entire text is
`job failed`. There is no way to tell which of the ~20 job handlers failed, what
the underlying error was, or what led up to it.

The information is NOT missing from the logs. `dispatchJob` already logs
`jobName`, `jobId`, `durationMs` and the serialized error
(`app/src/jobs/jobs.ts:325-333`), and pino 9 applies `stdSerializers.err` by
default, so `err.message`, `err.stack` and `err.type` are written to CloudWatch
on every failure. The RUNBOOK's DLQ playbook already tells operators to read
`jobName` off those lines.

The loss happens at the display layer. `projectErrorEvent`
(`app/src/adapters/cloudwatch.ts:123-148`) is a hard allowlist of four fields -
`timestamp`, `level`, `msg`, `correlationId` (+ `errorCode`) - and discards
everything else for PII safety. A log line whose entire identity lives in
`jobName` therefore renders as the bare string `job failed`.

Two call sites in the codebase are structurally affected, because each is a
shared wrapper covering many distinct failures:

- `app/src/jobs/jobs.ts:332` - one dispatcher for every registered job handler.
- `app/src/lib/errors.ts:141` and `:161` - one Express handler for every route;
  `method` and `path` are on the line and are dropped.

Most of the other ~249 error call sites write a specific message and read fine.

## 2. Decision: the projection is a display control, not a storage control

`err.message` and `err.stack` are ALREADY at rest in CloudWatch. Widening the
projection adds no new data to any store, creates no new retention obligation,
and changes nothing about what AWS holds. It changes only what the panel is
willing to render.

The panel is admin-only and enforced SERVER-side: `createSystemRouter` applies
`requireRole('admin')` to every `/api/system/*` route
(`app/src/routes/system.ts:45`), so a VA receives 403. This was verified rather
than inferred from the client-side route guard.

Human decision (2026-08-24): PII in the dashboard error panel is ACCEPTABLE,
because the people who can reach it already have access to the underlying data.
PII redaction remains correct at the LOG level, where the real boundary is.

CONSEQUENCE, stated explicitly so it is not lost: the "PII-SAFE projection ONLY"
guarantee is being deliberately retired for this panel. Every comment asserting
it must be rewritten to the new posture, not deleted. See section 8.

## 3. Verified facts (spike, 2026-08-24)

Run read-only against the real account (938565869261, profile `housingchoice`)
with `aws logs start-query` / `get-query-results` / `get-log-record`. No
mutations.

1. `@ptr` SURVIVES THE FULL WINDOW. A pointer for a 2026-08-17 event resolved
   successfully on 2026-08-24 - the far edge of the widest window the panel
   offers (7d). Pointer expiry is therefore NOT a design constraint, and no
   fallback retrieval path is required.
2. `@ptr` is returned automatically when listed in the Insights `fields` clause.
   Observed length 220-224 chars, opaque. Adding it costs one token in the
   existing query string.
3. `GetLogRecord` FLATTENS NESTED JSON with dot notation. A real prod error
   record returned `err.message`, `err.stack`, `err.type` as separate top-level
   keys, alongside `correlationId`, `requestId`, `userId`, `s3Key`, `msg`,
   `level`, `time`.
4. VALUES COME BACK STRINGIFIED. `level` was returned as the string `"30"`, not
   the number `30`. The detail path MUST coerce; it cannot reuse the list path's
   `typeof === 'number'` assumptions.
5. The record ALSO carries `@message` (the complete raw line, 799 chars in the
   sample) plus `@log`, `@logStream`, `@logGroupId`, `@ingestionTime`,
   `@timestamp`.
6. `@log` NAMES THE LOG GROUP. The panel merges `/hc/<env>/app` and
   `/hc/<env>/worker` today and cannot tell an operator whether the app or the
   worker failed. `@log` closes that gap at zero cost.
7. Records carry `backwardToken` / `forwardToken` (pointers to adjacent events).
   NOT designed around here; noted as a future option only.

## 4. Scope

### S1 - Self-describing messages at the source

`app/src/jobs/jobs.ts:332`: change the message to include the job name.

    'job failed: ' + envelope.jobName

DECIDED (2026-08-24): IDENTITY ONLY. The message names the job and nothing else.
It does NOT append `err.type` or an `err.message` prefix. Rationale: `msg` stays
a stable, low-cardinality string - greppable, safe to build future metric
filters on, groupable for dedup - and stays structurally free of PII. The error
detail is already a first-class field and is now fully readable in the panel, so
duplicating a truncated copy into `msg` buys little and costs the stable-string
property.

`app/src/lib/errors.ts:141` and `:161`: fold `method` and `path` into the
message the same way. The route TEMPLATE is preferred over the concrete path
where Express exposes it; a concrete path is acceptable.

`jobName` is a registry constant and `method` is a fixed verb, so neither
introduces PII into `msg`.

CONSTRAINT: `msg` strings are ASCII-only (AGENTS.md). See the encoding issue in
section 9 - non-ASCII in log strings demonstrably does not survive the pipeline.

RISK CHECK: nothing asserts on the literal string `job failed` anywhere in
`app/`, `dashboard/` or `e2e/` (verified by grep). The `ErrorLogs` metric filter
keys on `{ $.level >= 50 }`, not the message
(`infra/modules/observability/main.tf:56`), so alarms are unaffected.

### S2 - Widened list projection

Extend `ErrorEventView` (`app/src/adapters/cloudwatch.ts:79-94`) and
`projectErrorEvent` to carry:

- `jobName` - from the log line, when present.
- `event` - the house-style event field; already present on 28 error call sites
  (`relay_provisioning_failed`, `media_mirror_exhausted`, `transcode_failed`,
  ...) and currently invisible.
- `errType` - from `err.type`.
- `errMessage` - from `err.message`, TRUNCATED (see below).
- `source` - `app` or `worker`, derived from the log group the row came from.
- `ref` - the opaque `@ptr`, used by S3. Never rendered.

TRUNCATION: cap `errMessage` at 300 characters with an explicit truncation flag
(not a bare ellipsis) so the UI can show that more exists and offer S3. The cap
exists because a `RestException` or `AggregateError` can carry multi-KB text and
the list returns up to `ERROR_EVENT_LIMIT` (25) rows.

RELAX THE UNPARSEABLE FALLBACK: `projectErrorEvent` currently collapses any
non-JSON line to the literal `(unparseable log line)` to avoid surfacing raw
text. Those are exactly the V8-heap-OOM and raw-stderr lines an operator most
needs. Surface the raw text instead, capped identically.

PRESERVE the existing OOM relabeling in `systemStatus.getErrors` (lines 236-240)
- `OOM_APP_LABEL` / `OOM_SYSTEM_LABEL` are synthesized labels applied AFTER
projection, and must keep overriding the message for those two queries.

The `includeWarnings` (level >= 40) path uses the same widened projection; there
is no separate shape for warnings.

### S3 - Full-record detail

New: `GET /api/system/errors/:ref` (admin-only, same router).

- Calls `GetLogRecord` with the `@ptr` via a new method on `CloudWatchClientSeam`
  (adapter rule: the SDK import stays in `app/src/adapters/cloudwatch.ts`).
- Returns the COMPLETE flattened record: full `err.message`, `err.stack`,
  `err.type`, every field the call site attached, plus `@log`, `@logStream`,
  `@ingestionTime`, and the raw `@message`.
- Degrades like its siblings: HTTP 200 with `{ available: false, reason }` on a
  local/hermetic stack or a CloudWatch failure, never a 500.
- Coerces stringified values (fact 4).
- The `ref` is opaque to the client and is NOT a stable identifier - it is
  supplied by the list response and used immediately.

VALIDATION: `:ref` is attacker-influencable input forwarded to an AWS API. It
must be length-bounded and character-validated before the SDK call, and a
malformed pointer must produce a clean degraded response rather than an
unhandled SDK throw.

### S4 - correlationId trace pivot

New: `GET /api/system/trace/:correlationId` (admin-only, same router).

- Reuses the existing `queryInsights` seam with filter
  `correlationId = "<id>"`, sorted ASCENDING, across the app and worker groups,
  ALL levels (not just >= 50) - the point is the lines around the failure.
- No new IAM: `logs:StartQuery` is already granted and already scoped to
  `/hc/<env>/*` (`infra/modules/ec2/main.tf:288-295`).
- Bounded by the same window and a row limit.
- `correlationId` is validated as a UUID-shaped token before interpolation into
  the query string. It is attacker-influencable input entering a query language;
  it must not be concatenated unvalidated.

This is the "what led up to it" half. `GetLogRecord` answers "this line,
completely"; the pivot answers "everything around it".

### S5 - Dashboard UI

`dashboard/src/routes/settings/RecentErrors.tsx`.

DECIDED (2026-08-24): compact row, ONE expander containing everything.

Collapsed row: timestamp, level, `app`/`worker` chip, `jobName` or `event` chip,
capped message, `correlationId` rendered as the trace link, and a control to
expand.

Expanded (one `GET /api/system/errors/:ref`): full `err.message`, `err.type`,
`err.stack` in its OWN scroll container, the remaining fields as a key/value
list, and access to the raw record. The stack must not push the rest of the page
- it is bounded and scrolls internally.

Rejected: a two-tier expander (an extra click on exactly the cases where the
stack is wanted) and an uncapped message in the row (one multi-KB error pushes
every other row off screen).

A11y: the expander is a real button with `aria-expanded`; the panel keeps its
existing heading structure and `role="alert"` only on a true load error. Follow
`e2e/support/selectors.md` - accessibility-first selectors.

### S6 - IAM

Add `logs:GetLogRecord` to `infra/modules/ec2/main.tf`.

Follow the existing pattern: place it with `SystemStatusInsightsResults`
(`resources = ["*"]`) unless the builder confirms otherwise against the AWS
Service Authorization Reference. `GetLogRecord` is believed NOT to support
resource-level permissions, exactly like `GetQueryResults` and `StopQuery`.
BUILDER MUST VERIFY this before committing, and comment the finding inline the
way the neighbouring statements already do.

Both envs share the module, so the change applies to dev and prod alike.

## 5. Non-goals

- No new datastore for errors. CloudWatch already holds the data under a
  terraform-managed retention; a second store would add a write on the failing
  path, a new PII repository with its own deletion obligations, and two
  disagreeing accounts of the same failure.
- No change to what is WRITTEN to logs beyond S1's message strings. The
  credential redaction in `app/src/lib/logger.ts:182-226` is untouched and still
  correct: it covers `err.config.*`, `err.request._header` and
  `err.response.data` - the credential-bearing nests - not `err.message`.
- No change to alarms or metric filters.
- No relaxation of the admin-only gate. If the panel is ever opened to
  non-admins, this decision must be revisited.
- The `forwardToken`/`backwardToken` adjacent-line reader is not built.
- The CP1252 log-encoding defect (section 9) is filed, not fixed.

## 6. Security and PII posture (the change, stated plainly)

BEFORE: the panel guaranteed a PII-safe projection - four allowlisted fields.

AFTER: the panel may render PII, deliberately, because it is admin-only and
server-enforced, and its audience already has access to the underlying data.

UNCHANGED: credentials are redacted at WRITE time by pino and never reach
CloudWatch in the first place. Widening the projection does not reopen that -
the redact paths target the vendor-SDK nests that carry `Authorization` headers
and form bodies, not `err.message`.

STILL TRUE: the log-level sanitizers remain correct and must not be weakened.
`app/src/adapters/messaging.ts:693-716` rebuilds a plain Error specifically to
keep a property ZIP out of CloudWatch. That is an upstream write-time control
and is orthogonal to this change.

DISTINCT AND UNAFFECTED: `docs/issues/telemetry-phone-in-url-pii.md` is a
prod-gate about phone numbers in OTLP span attributes - a different sink with a
different audience. Nothing here clears or moves that gate.

## 7. Testing

- Unit: `projectErrorEvent` widening, including truncation, the truncation flag,
  the relaxed non-JSON path, and stringified-value coercion in the detail path.
- Unit: the new adapter seam method, with an injected fake SDK client (no AWS,
  no credential resolution - follow the existing pattern).
- Unit: route-level admin enforcement on BOTH new routes, and input validation
  for `:ref` and `:correlationId` (malformed input -> clean degraded response,
  never an unhandled throw).
- Unit: OOM relabeling still wins over the widened projection.
- Component: `RecentErrors` collapsed/expanded states, chips, the trace link.
- e2e: the panel degrades to "Available in deployed environments." on the
  hermetic stack, which is the only state reachable without AWS. Extend the
  existing System Status spec rather than adding a new one.

The detail and trace routes CANNOT be exercised against real AWS from the
hermetic lane. Their AWS-facing behavior is covered by injected fakes; the spike
in section 3 is the real-API evidence.

## 8. Comment and doc truth-up (do not skip)

These assert a guarantee this change retires. Rewrite each to the new posture -
admin-only, may contain PII, credentials still redacted at write time:

- `app/src/adapters/cloudwatch.ts:12-14` (file header PII note)
- `app/src/adapters/cloudwatch.ts:116-122` (projectErrorEvent docblock)
- `app/src/adapters/cloudwatch.ts:84-85` (the `message` field comment)
- `app/src/routes/system.ts:14-18` (router header PII note)
- `dashboard/src/routes/settings/RecentErrors.tsx:1-7` (component header)
- `dashboard/src/api/types.ts:334-346` (`SystemErrorEvent` docblock)
- `RUNBOOK.md` - the DLQ alarm row tells operators the `job failed` lines carry
  `jobName`; update it to describe the panel's new detail and trace affordances.

## 9. Related issue found during the spike (NOT in scope)

Log lines reach CloudWatch with CP1252-encoded em-dashes. `app/src/index.ts:162`
and `app/src/worker.ts:530` hold a correct UTF-8 em-dash in source
(bytes `E2 80 94`), but the stored log event contains a lone `0x97` byte, which
is invalid UTF-8 and renders as a replacement character in every UTF-8 consumer
- including the panel this mission builds.

Isolated past both the PowerShell console encoding and the AWS CLI's own stdout
encoding (`PYTHONIOENCODING=utf-8` reproduced it), so it is a genuine defect at
rest somewhere in the build/runtime/ingest path, not a display artifact.

To be filed as a Tier-2 issue under `docs/issues/`. Fixing it is a separate
decision. It reinforces the existing ASCII-only rule for log strings, which S1
must follow.

## 10. Post-merge obligations

TERRAFORM PLAN AND APPLY IS REQUIRED BEFORE DEPLOY, in dev AND prod. S6 adds an
IAM action; until it is applied, `GET /api/system/errors/:ref` will fail
authorization and the expander will degrade. The human runs this; agents do not
mutate infrastructure.

Carry this to the top of the handback.
