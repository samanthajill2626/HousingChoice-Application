# Error surface detail - design

Date: 2026-08-24
Status: r5 - REVIEW COMPLETE, awaiting human spec review
Branch: feat/error-surface-detail
Worktree: W:\tmp\error-surface-detail
Design review: 4 rounds, the process cap (69 findings, 56 accepted, 1 round-1
rejection reversed in round 2). The three decision-changing items round 4 raised
were put to the human and decided 2026-08-24; they are marked HUMAN DECISION
below. Adjudications: `.superpowers/design-review/adjudications.md`

## 1. Problem

Operators troubleshooting from the dashboard see error rows whose entire text is
`job failed`. There is no way to tell which of the job handlers failed, what the
underlying error was, or what led up to it.

The information is NOT missing from the logs. `dispatchJob` already logs
`jobName`, `jobId`, `durationMs` and the serialized error
(`app/src/jobs/jobs.ts:325-333`), and pino 9 applies `stdSerializers.err` by
default, so `err.message`, `err.stack` and `err.type` are written to CloudWatch
on every failure.

The loss happens at the display layer. `projectErrorEvent`
(`app/src/adapters/cloudwatch.ts:123-148`) is a hard allowlist of four fields -
`timestamp`, `level`, `msg`, `correlationId` (+ `errorCode`) - and discards
everything else. A log line whose entire identity lives in `jobName` therefore
renders as the bare string `job failed`.

Two shared wrappers are structurally affected: the job dispatcher
(`app/src/jobs/jobs.ts:332`) and the Express error handler
(`app/src/lib/errors.ts:137-164`). There are 13 registered job handlers, and 248
error call sites overall - most of which write a specific message and read fine.

## 2. Decision: the projection is a display control, not a storage control

`err.message` and `err.stack` are ALREADY at rest in CloudWatch. Widening the
PROJECTION adds no new data to any store and creates no new retention
obligation; it changes only what the panel is willing to render.

ONE PART OF THIS SPEC DOES WRITE SOMETHING NEW, and this paragraph is where a
reader decides whether the change touches storage, so it says so here rather than
only in the non-goals: S2 adds a `pollRunId` field to every poll-enqueued job's
log lines. That is a deliberate, separately justified exception (see S2), not a
consequence of the projection widening.

The panel is admin-only and enforced SERVER-side: `createSystemRouter` applies
`requireRole('admin')` to every `/api/system/*` route
(`app/src/routes/system.ts:45`), so a VA receives 403. Verified, not inferred
from the client-side route guard.

Human decision (2026-08-24): PII in the dashboard error panel is ACCEPTABLE,
because the people who can reach it already have access to the underlying data.

SCOPE OF THAT DECISION: it covers CONTACT DATA - phone numbers, names, message
text. It does NOT cover CREDENTIALS, which were never in its scope. See section 6.

CONSEQUENCE: the "PII-SAFE projection ONLY" guarantee is deliberately retired for
this panel. Every comment asserting it must be rewritten to the new posture, not
deleted. See section 8.

## 3. Verified facts (spike, 2026-08-24)

Read-only against the real account (938565869261, profile `housingchoice`). No
mutations. Each fact names the record it came from.

1. POINTER LIFETIME IS NOT DESIGNED AROUND. A pointer for a 2026-08-17 event
   resolved on 2026-08-24 - the far edge of the widest window the panel offers.
   One observation, not a published guarantee, and deliberately not stated as
   one. An expired pointer degrades exactly like any other CloudWatch failure.
   No fallback retrieval path is built (adjudication RJ1).
2. `@ptr` MUST BE ADDED TO THE `fields` CLAUSE. It is returned only when listed
   there. The current query string is
   `fields @timestamp, @message | filter ... | sort @timestamp desc | limit N`
   (`app/src/adapters/cloudwatch.ts:227`) and must gain `@ptr` and `@log`.
3. `@ptr` CHARSET, MEASURED. A real pointer was 220 chars over `[A-Za-z0-9+=]`.
   It CONTAINS `+` and `=`. No `/` appeared in that sample, but base64's alphabet
   includes `/`, so the sample does not bound the general case. NOT MEASURED:
   the POSITION of `=` (whether it is only trailing padding). The transport in
   S4 is chosen so that neither gap matters.
4. `GetLogRecord` FLATTENS NESTED JSON with dot notation. Sampled on a real prod
   ERROR record, which returned `err.message`, `err.stack`, `err.type` as
   separate top-level keys, alongside `correlationId`, `requestId`, `userId`,
   `s3Key`, `msg`, `level`, `time`.
5. VALUES COME BACK STRINGIFIED. Sampled on a DIFFERENT record (an info-level
   shutdown line), whose `level` was returned as the string `"30"`. The detail
   path MUST coerce; it cannot reuse the list path's `typeof === 'number'`
   assumptions.
6. THE DETAIL RECORD ALSO CARRIES `@message` (the complete raw line, 799 chars in
   the sample - one observation, not a bound), plus `@log`, `@logStream`,
   `@logGroupId`, `@ingestionTime`, `@timestamp`.
7. `@log` IS `<accountId>:<logGroupName>`, NOT a bare name. Observed:
   `938565869261:/hc/dev/app`. Any mapping must normalise by taking everything
   after the last `:`.
8. A NON-JSON RECORD RETURNS NO APPLICATION FIELDS. Sampled on a real
   `/hc/prod/system` record (that group is entirely non-JSON): the response
   carried ONLY `@`-prefixed metadata (`@message`, `@log`, `@logStream`,
   `@ingestionTime`, `@timestamp`, `@logGroupId`, entity/account keys) plus
   `backwardToken`/`forwardToken`. No `err`, no `msg`, no `level`. This is the
   premise the `rawText` branch in S4 rests on, and it is measured rather than
   inferred.

## 4. Scope

Slices are numbered in dependency order. S2 is a prerequisite for S5.

### S1 - Self-describing messages at the source

DECIDED: IDENTITY ONLY. The message names the failing unit and nothing else - no
`err.type`, no `err.message` prefix. `msg` stays a stable, low-cardinality
string: greppable, safe for future metric filters, groupable for dedup.

**Job dispatcher** (`app/src/jobs/jobs.ts:332`): `'job failed: ' + envelope.jobName`.

`jobName` is a module constant at all 13 call sites, but
`defineJobHandler(jobName: string, ...)` (`jobs.ts:193`) types it as `string`,
not a registry enum - "registry constant" holds by convention, not by types.

**Express handler** (`app/src/lib/errors.ts:137-164`) - THREE branches, two of
which currently emit an IDENTICAL string:

- `:140-143` headers-already-sent, `'unhandled error while handling request'`
- `:151-157` `URIError`, WARN, `'malformed URI in request - rejected as 400'`
- `:159-162` normal, `'unhandled error while handling request'` (same as `:143`)

The two error branches get DISTINCT strings - a headers-already-sent failure is a
materially different fault and is currently indistinguishable in the panel, which
is the exact problem S1 exists to fix. The WARN branch is panel-visible with
`includeWarnings` on (`app/src/routes/system.ts:77-79`) and IS in scope: it takes
the same treatment, which for that branch always yields `method + (unrouted)`,
because Express's matcher throws before any route is bound (`errors.ts:147-151`).

**THE CONCRETE PATH NEVER ENTERS `msg`.** `req.path` can carry a raw E.164:
`app/src/routes/contacts.ts:2317`, `:2376` and
`app/src/routes/relayGroups.ts:467` mount a `:phone` segment. Promoting it into
`msg` would write a phone across the boundary section 2 says stays real, and
would destroy S1's low-cardinality rationale.

DETERMINISTIC RULE: the message carries `method` plus `req.baseUrl +
req.route.path`, and the literal token `(unrouted)` when `req.route` is unset.
`req.route.path` alone is MOUNT-RELATIVE and identifies nothing; no router in
`app/src` is mounted at a param-bearing path, so the `baseUrl` prefix cannot
reintroduce a concrete id. `path` REMAINS a structured field; only its promotion
into `msg` is refused.

ALSO NOTED, not renamed: `jobs.ts:290` logs
`'dispatchJob: malformed job envelope rejected'` with no `jobName` - by
construction, since the envelope failed validation.

ASCII CONSTRAINT: `errors.ts:154` contains a real em-dash (`E2 80 94`) - the
exact non-ASCII section 9 shows does not survive the pipeline. S1-touched lines
are ASCII-ised.

RISK CHECK: nothing asserts on the literal `job failed` in `app/`, `dashboard/`
or `e2e/`. The `ErrorLogs` metric filter keys on `{ $.level >= 50 }`
(`infra/modules/observability/main.tf:56`), so alarms are unaffected.

### S2 - Envelope correlation propagation (prerequisite for S5)

`app/src/jobs/jobs.ts:174-179` copies FOUR optional fields into the envelope's
correlation context - `requestId`, `conversationId`, `tenantId`, `placementId` -
and NOT `pollRunId` or `bootId`.

So a job enqueued from a worker poll tick (tour reminders, placement nudges,
roster actions, extraction, group guardrails - see `app/src/lib/context.ts:20-33`)
carries NO upstream id whatsoever. Its `job failed` line has
`correlationId = jobRunId` and nothing linking back to the tick that enqueued it.

ADD `pollRunId` to the copied set.

THIS DELIBERATELY WIDENS A NON-GOAL, and the justification is not convenience:
AGENTS.md requires that "All job traffic goes through `jobs.enqueue()` /
`defineJobHandler()` so correlation and trace context are preserved", and for
poll-originated jobs the current code does not preserve it. This is a
correlation-plumbing fix in the spirit of that rule.

WHAT CHANGES AND WHAT DOES NOT, precisely - this is the whole risk argument for
touching shared plumbing, so it must not overstate. Every log line of every
poll-enqueued job DOES gain a `pollRunId` field, because the mixin spreads the
whole context (`logger.ts:232`); that is the point of the change. What does NOT
change is the `correlationId` VALUE: `logger.ts:231` resolves
`correlationId = jobRunId ?? pollRunId ?? requestId ?? bootId`, and `jobRunId`
still wins inside a dispatched job.

BLAST RADIUS, verified rather than assumed: `isCompleteEnvelope`
(`jobs.ts:216-232`) only asserts that `correlationContext` is a non-null object -
no schema, no key allowlist, no rejection of unknown keys - so envelopes in
flight and new envelopes both validate. No test pins the key set (the
`correlationContext` hits in `app/test` are fixtures and one negative case). No
downstream reader enumerates context keys: `isOrphanLogLine`
(`logger.ts:251-254`) reads `correlationId` only, the metric filters key on
`{ $.level >= 50 }` and `{ $.correlationId NOT EXISTS }`, and the dev log ring
filters on `level`/`msg`/`event`.

NOT DONE: the pivot does not accept `conversationId` / `tenantId` /
`placementId`. Those are DOMAIN ids; searching by them is a different feature
with a different security surface.

### S3 - Widened list projection

Extend `ErrorEventView` (`app/src/adapters/cloudwatch.ts:79-94`) with:
`jobName`, `event`, `errType`, `errMessage`, `source`, `ref`, `requestId`,
`pollRunId`.

`requestId` and `pollRunId` are NOT optional extras - without them on the wire,
S5's pivot is unreachable from the UI (round 2, N2). They are already on the log
line for the work that has them, because the pino mixin spreads the whole
context (`logger.ts:232`).

**OPTIONALITY, stated because the existing interface uses all three conventions**
(`message: string` required, `correlationId: string | null` required-but-nullable,
`errorCode?: string | null` optional - `cloudwatch.ts:85`, `:87`, `:93`):

- `source` and `ref` are REQUIRED and non-null. Every row has both, and making
  `source` optional would give the four-value union a fifth de-facto `undefined`
  state that S6's chip has no branch for - the same defect AJ28 fixed.
- Everything else follows the `errorCode?: string | null` convention.

CONSEQUENCE THE BUILDER MUST EXPECT: existing fixtures build partial literals
(`dashboard/src/routes/settings/RecentErrors.test.tsx:67-68`, `:88-92`), so two
required fields WILL break them under `npm run typecheck` - a required gate.
Update the fixtures; do not weaken the types to avoid the edit.

**MECHANISM.** None of these can be produced by the current code path:

- The query string (`cloudwatch.ts:227`) must gain `@ptr` and `@log` in `fields`.
- The result-row loop (`cloudwatch.ts:254-261`) extracts ONLY `@message` and
  `@timestamp` and discards every other cell. It must pass the whole row.
- `projectErrorEvent(rawMessage: string, ts: number)` (`:123`) must take the row.

**ACCESSOR SHAPES DIFFER BETWEEN PATHS - do not conflate them.** The LIST path
parses the raw `@message` string (`cloudwatch.ts:130`), where `err` is a NESTED
object: read `(obj.err as ...).message`. `obj['err.message']` is `undefined`
there. Only the DETAIL path (S4) sees dot-flattened keys. Getting this wrong
ships a permanently blank field in the ONLY environment that has data - the
hermetic lane degrades to `unavailable_local` (`systemStatus.ts:212-214`), so no
gate catches it.

**`source` is `'app' | 'worker' | 'system' | 'unknown'`** - FOUR values.
`config.ts:526-528` defines three log groups and `systemStatus.ts:234` queries
`/hc/<env>/system`, merging its rows into the same array (`:245`). Derive by
normalising `@log` per fact 7 and matching the three configured names; anything
else is `unknown`, which S6 renders rather than silently labelling `app`.

**`ref`** is the RAW `@ptr`, unmodified. See S4 for the transport.

**TRUNCATION**: cap `errMessage` AND `message` at 300 characters, each with its
OWN truncation flag so the UI can say which field was cut. `msg` is uncapped
today (`cloudwatch.ts:136`) and S1 now appends to it.

**FALLBACK LADDER.** `projectErrorEvent` initialises
`message = '(unparseable log line)'` and replaces it only when `msg`/`message` is
a non-empty string (`:127`, `:135-136`) - so a well-formed JSON line carrying
`event` and `err` but NO `msg` renders as "(unparseable log line)" today, which
with an `event` chip alongside would be absurd. New ladder:
`msg` -> `event` -> `err.message` -> `(unparseable log line)`.

**THE r1 "RELAX THE UNPARSEABLE FALLBACK" INSTRUCTION IS WITHDRAWN** as
undeliverable: non-JSON lines are excluded from the pino query by construction
(`cloudwatch.ts:57-58`), and the only non-JSON rows come from the two OOM
queries, whose `message` is unconditionally overwritten
(`systemStatus.ts:239-240`). Raw text stays reachable via S4.

**PRESERVE** the OOM relabeling (`systemStatus.ts:236-240`) unchanged.

**DEDUP**: add `ref` to the key at `systemStatus.ts:247`. Note the consequence
deliberately: `@ptr` is unique per log event, so the key becomes effectively
`ref` alone and the `timestamp|message|errorCode` components go inert. Keep them
for the absent-`ref` case, which is the ONLY case where they still decide
identity - and state it, because on that path a 300-char-truncated,
vendor-authored `err.message` would otherwise silently become row identity.

### S4 - Full-record detail

New: `GET /api/system/errors/detail?ref=<encoded pointer>` (admin-only, same
router).

**TRANSPORT.** `ref` is the raw pointer, carried as a QUERY VALUE encoded with
`encodeURIComponent`. That encodes `+` as `%2B`, `/` as `%2F` and `=` as `%3D`;
both parsers decode `%2B` back to a literal `+`, because the `+`-to-space rule
applies only to an UNENCODED `+`.

Why not a path segment: a pointer may contain `/`, which cannot survive one, and
a malformed escape never reaches the handler at all - Express's matcher throws
`URIError` first and `errors.ts:151-158` answers 400, contradicting the degraded
contract below.

Why not base64url transcoding (considered and rejected, round 2): it needs a
transform AND an inverse with re-padding, and it assumes `=` is only trailing
padding - a positional property fact 3 explicitly did not measure. If the inverse
is wrong, every pointer fails and S4's degraded contract swallows it invisibly.
`encodeURIComponent` achieves the same result with no transform and no inverse.

The query-value form also keeps the pointer out of the request log:
`requestLogger.ts:33` logs `req.path`, which excludes the query string.

**RESPONSE**: the flattened record - `err.message`, `err.type`, `err.stack`, the
fields the call site attached, plus `@log`, `@logStream` and `@ingestionTime`.
Values coerced per fact 5.

**THE RAW `@message` IS NEVER RETURNED FOR A PARSED RECORD.** An earlier draft
returned it alongside the allowlisted fields, which defeated the allowlist
completely: the response would drop `err.config.params` and
`err.cause.config.headers.Authorization` from the flattened keys and then hand
the client the original line still containing them. For a JSON line the flattened
fields already carry everything of value, so the raw line is pure duplication
plus a hole.

For a NON-JSON record `GetLogRecord` returns no application fields at all
(fact 8, measured), so the raw text IS the only content. It is surfaced under an
explicit `rawText` field, capped at 4000 characters with a truncation flag.
`@message` itself is never a response key.

**HUMAN DECISION (2026-08-24): host syslog raw text IS in scope.** An earlier
draft justified `rawText` as safe because those lines "carry no vendor error
object" - true, but aimed at the wrong threat and false as a description of the
group. `/hc/<env>/system` is not kernel-OOM lines: it ships the ENTIRE
`/var/log/messages` unfiltered (`infra/modules/ec2/main.tf:410-411`), so it
carries sshd, sudo, systemd, docker and cloud-init output, none of it chosen by a
call site. The panel has only ever shown two synthesized labels from that group
(`systemStatus.ts:52-53`, `:239-240`).

Showing it is nonetheless the decision, and the reasoning is the one from section
2, not the false one: the page is admin-only and server-enforced, this is host
operational data rather than contact PII, and the OOM and host-level rows are
exactly the ones where a synthesized label tells an operator nothing. What is
exposed, stated plainly rather than hidden behind a bad justification: whatever
the host wrote, including command lines from sudo and sshd.

Note the deliberate asymmetry with S5, which EXCLUDES the system group. Both are
correct: the detail route must admit it because the list merges OOM rows the
operator can expand, while the trace pivot excludes it because kernel lines carry
no correlation id. Do not "reconcile" them.

**FIELD RULE - AN ALLOWLIST UNDER `err`, NOT A DENYLIST.** A denylist of
`err.config.*` / `err.request.*` / `err.response.*` prefixes was specified in r2
and is WITHDRAWN: it is the same path-list mechanism section 6 condemns, it
cannot enumerate what it has not met, and `err.cause` is a concrete hole (an
axios error wrapped as a cause flattens to
`err.cause.config.headers.Authorization`, matched by neither the logger's redact
list nor those three prefixes). The rule is two-tier:

- NON-`err` fields PASS THROUGH. They are app-authored - the call site chose to
  attach them, and they are the point of the detail view.
- The `err.*` subtree is ALLOWLISTED to `message`, `stack`, `type`, `name`,
  `code`, `status`, and `response.status`. Everything else beneath `err` is
  dropped AT ANY DEPTH.
- A SCALAR `err` IS KEPT. Six verified call sites log `err` as a STRING, not an
  Error: `app/src/services/systemStatus.ts:204` and `:258`,
  `app/src/services/pushService.ts:188`, `:235`, `:380`, and
  `app/src/routes/auth.ts:311`. pino's serializer only transforms an Error VALUE,
  so those arrive as a flat top-level `err` with text and nothing beneath it -
  matching none of the seven allowed paths, and a faithful path-allowlist would
  DELETE them. A scalar `err` is by definition the message, and `message` is
  allowlisted. Note which two call sites those are: `systemStatus.ts:204`/`:258`
  are this panel's OWN degraded-read diagnostics, so without this clause, when
  System Status fails to read CloudWatch the detail view would delete the reason.

`response.status` is explicitly kept because `errors.ts:77-82` reads it as the
vendor discriminator and `status` is one of the three fields in the repo's
adjudicated `ErrorSummary` allowlist (`errors.ts:34-38`) - dropping the whole
nest would have removed the most useful triage field on a vendor HTTP failure.

This matches the two places the repo already solves this problem
(`ErrorSummary`, `SAFE_HEADER_ALLOWLIST` at `requestLogger.ts:11-18`).

**ENVIRONMENT SCOPE CHECK (required).** A `ref` is an account-scoped pointer
bound to nothing. If S7's IAM verification lands on the `resources = ["*"]`
branch, this route could otherwise read any log record in the account, including
another environment's. REJECT any record whose normalised `@log` is not one of
`config.errorLogGroupName` / `workerLogGroupName` / `systemLogGroupName`. One
comparison, and it makes the route's scope independent of the IAM outcome.

**RESPONSE SIZE BOUND**: 64 KB. An oversized record is truncated with a flag
rather than streamed whole. (`err.stack` is the field that realistically
approaches this; the spike's sample record was 799 bytes, which is one
observation and not a bound.)

**DEGRADATION**: HTTP 200 with `{ available: false, reason }` on a
local/hermetic stack, a CloudWatch failure, an unresolvable or expired pointer,
or a failed scope check. Never a 500.

**VALIDATION - the same two answers as S5, stated so the siblings agree**: a
MISSING `ref` is a **400**, matching the `since` precedent (`system.ts:68-72`)
and S5. A PRESENT but malformed `ref` (length or charset) takes the degraded 200,
never an unhandled throw. The client distinguishes a non-2xx from a degraded 200
body (`dashboard/src/api/client.ts`), so the two drive different UI paths and
both must be specified.

**SEAM**: a new method on `CloudWatchClientSeam` (`cloudwatch.ts:97-107`); the
SDK import stays in the adapter. NOTE THE REAL TEST WORK: `fakeSeam`
(`app/test/systemStatus.service.test.ts:38-50`) takes
`Partial<CloudWatchClientSeam>` as its INPUT but RETURNS a hardcoded
two-property literal typed as the full seam. Adding a required method is a
`npm run typecheck` failure - a separate required gate - not a runtime throw.
`fakeSeam` must gain stubs for BOTH new methods (this one and S5's).

### S5 - Correlation trace pivot

New: `GET /api/system/trace` (admin-only, same router), taking:

- exactly one of `?correlationId=`, `?requestId=`, `?pollRunId=`; and
- `?at=<ISO timestamp>` - the anchor, REQUIRED. See the window rule below.

**LOG GROUPS**: app + worker. `system` is EXCLUDED deliberately - its kernel
lines carry no correlation id at all, so scanning it costs bytes for nothing.
This is the new seam method's first argument (`cloudwatch.ts:106`, `:232-236`)
and it went unstated across three review rounds; it is a decision, not a default.

**IT DOES NOT REUSE `queryInsights`.** That seam hardcodes `sort @timestamp desc`
(`cloudwatch.ts:227`), its contract pins NEWEST-FIRST (`:100-106`),
`app/test/cloudwatch.adapter.test.ts:123` asserts it, and it returns
`ErrorEventView[]` - a projection that drops exactly the fields an INFO context
line carries. S5 gets its OWN seam method.

**ASCENDING SORT IS LOAD-BEARING.** Insights applies `limit` INSIDE the sort, so
a descending query on a long correlation keeps the lines AFTER the failure and
drops the ones BEFORE it - the opposite of the purpose. Client-side re-sorting
cannot recover them, which is why the existing `queryInsights` seam cannot serve
this route. The result is presented ascending; the QUERY mechanism that produces
it is specified under LIMIT below, and it is not a single ascending query.

**THREE IDS, because correlationId alone cannot cross the job hop.**
`logger.ts:231` resolves `correlationId = jobRunId ?? pollRunId ?? requestId ??
bootId`, and `dispatchJob` mints a FRESH `jobRunId` per dispatch
(`jobs.ts:297-305`). Filtering a `job failed` line's correlationId returns that
job run alone - nothing about what enqueued it. `requestId` covers
request-originated work; `pollRunId` covers poll-originated work and only exists
on the wire because of S2.

**WINDOW - ANCHORED, NOT ROLLING.** The trace is anchored on the ROW'S TIMESTAMP,
which S6's link sends as `?at=`. It does NOT inherit the panel's rolling window:
the list route defaults to 24h (`system.ts:66-75`) while the panel's selector
goes to 7d (`systemStatus.ts:45`), so a rolling window would return ZERO rows for
any row older than a day - and an empty trace is indistinguishable from "there
was no context" on a feature whose entire purpose is context. A rolling window
would also mislead near its edge.

**HUMAN DECISION (2026-08-24): THE BRACKET IS ID-DEPENDENT.** A single
symmetric +/- 5 minute constant was specified in r4 and CANCELS the cross-hop
pivot it sits beside, which is the whole reason S2 widened a non-goal. Measured
gaps between the enqueue and the failure:

- SQS retry span ~8 minutes before the DLQ: `visibility_timeout_seconds = 120`
  and `maxReceiveCount = 5` (`infra/modules/jobs/main.tf:36`, `:41`), i.e. four
  redeliveries at 120s plus handler runtime.
- Delayed enqueue up to ~12 minutes: `delaySeconds` is computed from `opts.runAt`
  (`jobs.ts:112-114`) and the Phase 1 envelope is "no >12min callers"
  (`jobs.ts:104`).

So the `job failed` line an operator clicks on the DLQ triage path -
`RUNBOOK.md:2169`, the panel's headline scenario - can be ~8 minutes after the
first attempt and ~20 from the enqueue. A 5-minute look-back reaches none of it.

THE RULE:

- `correlationId` pivot: `at - 5 min` to `at + 5 min`. One job run, genuinely
  local; keep it tight and cheap.
- `requestId` or `pollRunId` pivot: `at - 30 min` to `at + 5 min`. These are the
  cross-hop ids by construction and reaching BACKWARDS is their entire purpose.

The look-ahead stays short in both cases: nothing an operator wants is half an
hour after the failure.

Both bounds convert to EPOCH SECONDS. The existing seam warns about this in
capitals at `cloudwatch.ts:229` ("CRITICAL: Insights StartQuery uses epoch
SECONDS, not milliseconds"), and the list path already pins it
(`cloudwatch.adapter.test.ts:120-121`). A milliseconds-for-seconds slip yields an
empty trace that degrades silently and is invisible in the hermetic lane, so the
new method gets its own equivalent assertion.

**SHAPE**: its own row type carrying timestamp, level, message and the
diagnostic fields an INFO line needs (`method`, `path`, `statusCode`,
`durationMs`, `jobName`, `jobId`, `hopCount`) - not `ErrorEventView`.

**HUMAN DECISION (2026-08-24): TWO OPPOSITE-SORTED QUERIES.** This REPLACES the
"the query sorts ascending server-side" sentence above as a description of
mechanism - that rule was correct as a diagnosis of the descending bug and wrong
as a single-query design, because ascending has the SYMMETRIC defect: Insights
applies `limit` inside the sort, so one ascending query returns the EARLIEST N
rows in the bracket and can drop the failure out of its own trace. That is not
hypothetical - S2 makes `pollRunId` a valid pivot and one poll tick fans out to
many jobs, so a `pollRunId` trace is the widest of the three by construction.

THE MECHANISM - two queries, merged:

- BEFORE: `sort @timestamp desc | limit 25` over `[bracketStart, at]`, then
  REVERSED client-side.
- AFTER: `sort @timestamp asc | limit 25` over `(at, bracketEnd]`.
- Merged ascending into one result of at most 50 rows.

This is the only shape that GUARANTEES the anchor line is present and bounds both
sides independently; a single-sided limit cannot. The row budget is 25 per side,
matching `ERROR_EVENT_LIMIT` (`systemStatus.ts:49`) rather than inventing a new
number.

When EITHER side hits its limit the response carries an explicit `truncated`
flag, per side, that S6 must surface. A trace that silently omits lines is worse
than no trace, because it looks complete.

NOTE FOR THE BUILDER: the ascending-sort paragraph above explains WHY the
original descending seam is unusable here. Do not read it as licensing a single
ascending query - the two-query mechanism in this paragraph is the design.

**DEGRADATION**: the same `{ available: false, reason }` contract at HTTP 200.

**VALIDATION AND ITS TWO DIFFERENT ANSWERS**: a missing id, several ids at once,
or a missing/unparseable `at` is a **400**, matching the `since` precedent on the
sibling route (`system.ts:68-72`). A well-formed request whose id is not
UUID-shaped takes the degraded 200. The two are observably different to the UI,
so the spec states both rather than leaving a builder to guess.

Ids are validated as UUID-shaped before entering the query string -
attacker-influencable input entering a query language. All four context ids are
`randomUUID()` (`app/src/lib/context.ts:72-87`) and the correlation middleware
MINTS rather than honors an inbound header
(`app/src/middleware/correlation.ts:14`), so validation cannot reject a
legitimate id.

**NO NEW IAM**: `logs:StartQuery` is already scoped to `/hc/<env>/*`
(`infra/modules/ec2/main.tf:288-295`).

### S6 - Dashboard wire layer and UI

FOUR files, not one. The dashboard does NOT share the backend types - it
hand-maintains a mirror, and every new field stops at the wire without this:

- `dashboard/src/api/types.ts:335-346` - `SystemErrorEvent` is declared
  independently with FIVE fields. It gains all eight new ones plus the two
  truncation flags, and response types for both new routes. (The mirroring
  obligation is stated in the panel's origin spec,
  `docs/superpowers/specs/2026-06-29-settings-dashboard-design.md:163`.)
- `dashboard/src/api/endpoints.ts:2088-2108` - holds `getSystemAlarms` and
  `getSystemErrors` only. Add a client function for each new route. Use the
  existing `request()` helper with `query: { ... }`: `client.ts:44-52` already
  builds query strings with `URLSearchParams`, which encodes the pointer's
  alphabet identically to `encodeURIComponent`, so the transport works with ZERO
  new encoding code. Do NOT hand-roll a URL and bypass it.
- `dashboard/src/routes/settings/useSystemStatus.ts:177-230` - where the panel's
  fetching lives. The per-row detail fetch, its loading/error state and its abort
  handling belong here, not improvised inside the component.
- `dashboard/src/routes/settings/RecentErrors.tsx` - the rendering below.

DECIDED: compact row, ONE expander containing everything.

Collapsed row: timestamp, level, the four-value source chip, `jobName` or `event`
chip, capped message, the trace link, and an expand control.

Expanded (one `GET /api/system/errors/detail`): full `err.message`, `err.type`,
`err.stack` in its OWN scroll container, remaining fields as a key/value list,
and `rawText` when the record carried one. The stack is bounded and scrolls
internally.

**THE TRUNCATION INDICATORS ARE RENDERED HERE - they have no other purpose.** S3
produces one flag per capped field precisely so the UI can say WHICH field was
cut; a flag that no slice consumes is dead weight. The collapsed row marks the
capped field visibly and that marker is what invites the expander. Likewise S5's
`truncated` flag is surfaced in the trace view: an incomplete trace must never
render as though it were complete.

**ROW KEY**: use `ref`. The current key (`RecentErrors.tsx:127`) collides once
messages share a truncated 300-char prefix, and React would then mis-associate
per-row expander state and fetched detail across a refresh. ("Never rendered" in
S3 means not displayed - it IS used in the view layer.)

**TRACE LINK - WHICH ID, AND THE NULL CASE.** Prefer `requestId`, then
`pollRunId`, then `correlationId`; the first present one drives the link. The
link ALSO sends the row's own `timestamp` as `?at=` - without it the route
cannot bound the query (S5). OOM
rows are non-JSON, so ALL of them are null there (`cloudwatch.ts:127`,
`:144-146`) - and those are exactly the rows `systemStatus.ts:239-240`
synthesises. `RecentErrors.tsx:52` already guards this and the guard must be
carried forward: with no id the pivot is ABSENT, never rendered as
`?correlationId=null`.

Rejected: a two-tier expander (an extra click on exactly the cases where the
stack is wanted) and an uncapped message in the row.

A11y: the expander is a real button with `aria-expanded`; existing heading
structure and `role="alert"`-on-load-error preserved. Accessibility-first
selectors per `e2e/support/selectors.md`.

### S7 - IAM

Add `logs:GetLogRecord` to `infra/modules/ec2/main.tf`.

DEFAULT TO THE SCOPED STATEMENT (`/hc/${var.env}/*`, as
`SystemStatusInsightsStart` does at `:288-295`). Fall back to
`resources = ["*"]` ONLY on a cited AWS Service Authorization Reference entry
showing the action does not support resource-level permissions, and comment the
citation inline as the neighbouring statements do. The repo's stated preference
is scope-where-scopable (`:282-287`).

S4's environment scope check is deliberately independent of which branch lands.

Both envs share the module, so the change applies to dev and prod alike.

## 5. Non-goals

- No new datastore for errors.
- No change to what is WRITTEN to logs, with TWO named exceptions: S1's message
  strings, and S2's `pollRunId` propagation.
- No change to alarms or metric filters.
- No relaxation of the admin-only gate. If the panel is ever opened to
  non-admins, this decision must be revisited.
- No dual-path retrieval fallback for an expired pointer (RJ1).
- The pivot does not search by domain ids (`conversationId`, `tenantId`,
  `placementId`).
- The `forwardToken`/`backwardToken` adjacent-line reader is not built.
- The CP1252 log-encoding defect (section 9) is filed, not fixed, except on the
  specific lines S1 already edits.

## 6. Security posture

BEFORE: the panel guaranteed a PII-safe projection of four allowlisted fields.

AFTER: the panel may render contact PII, deliberately, because it is admin-only
and server-enforced and its audience already has that access.

**CREDENTIALS ARE A SEPARATE QUESTION.** An earlier draft claimed credentials
"never reach CloudWatch in the first place" and cited `err.config.*`. That is
false. `logger.ts:204-223` lists THREE literal `err.config` paths and no
wildcard; `err.config.url`, `err.config.params`, `err.config.baseURL` and
`err.config.auth` are NOT redacted. The code disclaims the guarantee itself at
`:200-203`: "This is defense in depth, not the fix ... Redaction only covers the
paths it is told about, and the next SDK will invent a new one."

The repo's adjudicated position (`errors.ts:26-36`) is that `err.message` is the
field the VENDOR authors freely - the UNTRUSTED one.

HONEST STATEMENT: credential redaction at write time is a BEST-EFFORT path list,
known to be incomplete. That is exactly why S4 uses an ALLOWLIST under `err`
rather than a denylist or reliance on write-time redaction: an allowlist closes
the class by construction, including nests nobody has met yet. The human's PII
decision covered contact data; it did not cover credentials, and this spec does
not treat it as though it had.

STILL TRUE: the write-time sanitizers remain correct and must not be weakened.
`app/src/adapters/messaging.ts:693-716` sanitizes the availability SEARCH only -
by its own comment, the purchase and messages paths still write those nests.

**`telemetry-phone-in-url-pii`** was misdescribed in an earlier draft on two
counts. It is NOT OTLP-only: the issue explicitly names the request logger
writing `req.path` to CloudWatch as a PRE-EXISTING half (`:21-23`). And it is NOT
a prod gate: the gate was LIFTED and accepted 2026-08-15, status `deferred`
(`:28-33`). The honest statement is that this change makes the CloudWatch half of
that issue directly renderable in the dashboard - consistent with the accepted
posture, but not "unaffected". S1's refusal to put a concrete path in `msg`
avoids WIDENING it.

## 7. Testing

- Unit: `projectErrorEvent` widening - per-field truncation flags, the fallback
  ladder, `source` derivation including `system` and `unknown`, NESTED `err`
  access on the list path, `requestId`/`pollRunId` projection.
- Unit: S2's `pollRunId` propagation through `jobs.enqueue`, and that
  `correlationId` resolution is unchanged inside a dispatched job.
- Unit: the new adapter seam methods with injected fakes (no AWS); stringified
  coercion on the detail path; the S4 `err` ALLOWLIST - assert that
  `err.cause.config.headers.Authorization` and `err.config.params` are dropped,
  that `err.response.status` SURVIVES, and that a SCALAR string `err` survives.
- Unit: S4 never returns a raw `@message` key for a parsed record, and DOES
  return `rawText` for a non-JSON one.
- Unit: S4's environment scope check rejects a record from a foreign log group.
- Unit: S5's two-sided budget - on a correlation with more rows than the limit,
  assert the ANCHOR line is present and `truncated` is set.
- Unit: S5's 400-vs-degraded-200 split (missing id / several ids / bad `at` are
  400; a well-formed request with a non-UUID id is a degraded 200).
- Unit: admin enforcement on both new routes; validation of `ref` and the trace
  ids (malformed -> degraded response, never an unhandled throw).
- Unit: the trace issues TWO queries with OPPOSITE sorts and merges ascending
  (mirroring the existing `sort @timestamp desc` assertion at
  `cloudwatch.adapter.test.ts:123`).
- Unit: the trace bracket is ID-DEPENDENT - assert `-5min` for a `correlationId`
  pivot and `-30min` for `requestId`/`pollRunId`, both with `+5min` ahead.
- Unit: the bracket bounds are converted to EPOCH SECONDS, mirroring the existing
  `Math.floor(sinceMs / 1000)` assertion at `cloudwatch.adapter.test.ts:120-121`.
  A milliseconds slip yields an empty trace that degrades silently.
- Unit: OOM relabeling still wins; dedup with `ref` present AND absent.
- Component: `RecentErrors` collapsed/expanded, four-value chip, `ref` row key,
  trace-link id precedence and its absent-id case, the trace link sending `?at=`.
- Component: the truncation indicators RENDER - per capped field, and the trace's
  per-side `truncated` flag. These have no purpose except being shown, so an
  untested indicator is an unbuilt one.
- e2e: the panel degrades to "Available in deployed environments." on the
  hermetic stack - the only reachable state without AWS. Extend the existing
  System Status spec.

**PERF HARNESS - conditional, not mandatory.** `npm run perf:pages` is a
sanctioned gate (AGENTS.md) over a CLOSED registry, but the detail and trace
requests fire on a click, and a page-load profile never performs one.

- If the profiler's walk does NOT reach the expander: leave
  `e2e/performance/` alone. An earlier draft's "all three files must change
  together" was an over-claim.
- If it DOES: declare both templates in `e2e/performance/templates.ts:151-153`
  (`assertEndpointTemplate` throws `undeclared_endpoint_template` otherwise), and
  add entries to `SYSTEM_GETS` (`routes.ts:304-306`) using `conditional(...)`
  (`routes.ts:163`), NOT `required(...)` - a `required` entry asserts the request
  is observed on every profiled page load and would fail the contract from the
  other direction. `routes.test.ts:106-109` asserts the list.

VERIFIED SAFE, do not re-investigate: `matchTemplate` keys on segment count
(`templates.ts:200-211`), so a 4-segment `/api/system/errors/detail` cannot
collide with `/api/system/errors`; and query VALUES never reach artefacts, only
sorted key names (`templates.ts:227-229`), so neither the 220-char pointer nor a
UUID value trips the privacy scanner.

The detail and trace routes cannot be exercised against real AWS from the
hermetic lane; their AWS-facing behavior is covered by injected fakes, and the
section 3 spike is the real-API evidence.

## 8. Comment and doc truth-up (do not skip)

A grep for `PII-SAFE|PII-safe` across `app/` and `dashboard/` shows at least 12
sites asserting the retired guarantee. Rewrite each to the new posture:

- `app/src/adapters/cloudwatch.ts:12-14` (file header PII note)
- `app/src/adapters/cloudwatch.ts:78` ("projected to the PII-SAFE fields ONLY")
- `app/src/adapters/cloudwatch.ts:84-85` (the `message` field comment)
- `app/src/adapters/cloudwatch.ts:90-92` (the `errorCode` PII-SAFE note)
- `app/src/adapters/cloudwatch.ts:104` (seam doc, "PII-safe: each result row ...")
- `app/src/adapters/cloudwatch.ts:116-122` (`projectErrorEvent` docblock)
- `app/src/services/systemStatus.ts:15-22` (service header)
- `app/src/routes/system.ts:14-18` (router header PII note)
- `app/src/routes/system.ts:63` ("recent error events (PII-safe)")
- `dashboard/src/api/endpoints.ts:2095` ("recent error events (PII-safe)")
- `dashboard/src/api/types.ts:334-346` (`SystemErrorEvent` docblock - note this
  file also gains real FIELDS under S6, not just a comment fix)
- `dashboard/src/routes/settings/RecentErrors.tsx:1-7` (component header)
- `dashboard/src/routes/settings/RecentErrors.test.tsx:2`, `:63` (a describe
  block literally named "available:true rendering (PII-safe)")
- `app/src/adapters/messaging.ts:700` (comment naming the literal `job failed`)
- `docs/issues/fake-twilio-messaging-attach-404.md:45` (quotes
  `"msg":"job failed"` as a live Insights search signature that S1 invalidates)
- `RUNBOOK.md` - the DLQ alarm row. It currently teaches that the `job failed`
  lines carry "the originating request's correlation IDs" (plural). The rewrite
  must ADD the panel's new affordances and PRESERVE that technique.

NOT a correction - `app/test/cloudwatch.adapter.test.ts:7`, `:129`: the comment
"PII-safety: raw text never surfaced" REMAINS TRUE of the list path, because S3
withdrew the relaxation and keeps `(unparseable log line)`. Extend it to note
that S4 surfaces raw text on the detail path; do not "fix" it as though it were
wrong.

## 9. Related issue found during the spike (NOT in scope)

Log lines reach CloudWatch with CP1252-encoded em-dashes. `app/src/index.ts:162`
and `app/src/worker.ts:530` hold a correct UTF-8 em-dash in source (`E2 80 94`),
but the stored log event contains a lone `0x97` byte - invalid UTF-8, rendering
as a replacement character in every UTF-8 consumer including this panel.

Isolated past both the PowerShell console encoding and the AWS CLI's own stdout
encoding (`PYTHONIOENCODING=utf-8` reproduced it), so it is a genuine defect at
rest in the build/runtime/ingest path, not a display artifact.

To be filed as a Tier-2 issue. Fixing it generally is out of scope; the specific
lines S1 edits are ASCII-ised as part of S1.

## 10. Post-merge obligations

TERRAFORM PLAN AND APPLY IS REQUIRED BEFORE DEPLOY, in dev AND prod. S7 adds an
IAM action; until it is applied, the detail expander will fail authorization and
degrade. The human runs this; agents do not mutate infrastructure.

Carry this to the top of the handback.
