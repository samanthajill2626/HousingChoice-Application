# Error surface detail - design

Date: 2026-08-24
Status: READY TO BUILD (awaiting human spec approval)
Branch: feat/error-surface-detail
Worktree: W:\tmp\error-surface-detail

Design review: 5 rounds, 2 independent reviewers, 87 findings, 74 accepted.
Full decision record, including every rejection with its reasoning:
`docs/superpowers/reviews/2026-08-24-error-surface-detail-design-review.md`.
The two final-round reviewer reports are alongside it; among other things they
carry an independent audit confirming 24 of this spec's code citations.

This document states requirements; it does not argue with earlier drafts.
Appendix A carries the alternatives that were considered and rejected, for anyone
tempted to re-propose them.

## 1. Problem

Operators troubleshooting from the dashboard see error rows whose entire text is
`job failed`. There is no way to tell which job handler failed, what the
underlying error was, or what led up to it.

The information is not missing from the logs. `dispatchJob` already logs
`jobName`, `jobId`, `durationMs` and the serialized error
(`app/src/jobs/jobs.ts:325-333`), and pino 9 applies `stdSerializers.err` by
default, so `err.message`, `err.stack` and `err.type` reach CloudWatch on every
failure.

The loss happens at the display layer. `projectErrorEvent`
(`app/src/adapters/cloudwatch.ts:123-148`) is a hard allowlist of four fields -
`timestamp`, `level`, `msg`, `correlationId` (+ `errorCode`) - and discards
everything else. A line whose entire identity lives in `jobName` renders as the
bare string `job failed`.

Two shared wrappers are structurally affected, because each covers many distinct
failures: the job dispatcher (`app/src/jobs/jobs.ts:332`) and the Express error
handler (`app/src/lib/errors.ts:137-164`). There are 13 registered job handlers
and 248 error call sites overall; most write a specific message and read fine.

## 2. Posture: the projection is a display control, not a storage control

`err.message` and `err.stack` are already at rest in CloudWatch. Widening the
PROJECTION adds no new data to any store and creates no new retention
obligation; it changes only what the panel is willing to render.

One slice does write something new, and this is where a reader decides whether
the change touches storage: S2 adds a `pollRunId` field to every poll-enqueued
job's log lines. That is a separately justified exception, not a consequence of
the projection widening.

The panel is admin-only, enforced SERVER-side: `createSystemRouter` applies
`requireRole('admin')` to every `/api/system/*` route
(`app/src/routes/system.ts:45`), so a VA receives 403.

HUMAN DECISION (2026-08-24): PII in this panel is ACCEPTABLE, because everyone
who can reach it already has access to the underlying data.

SCOPE OF THAT DECISION: it covers CONTACT DATA - phone numbers, names, message
text - and host operational data. It does NOT cover CREDENTIALS. Section 6 is the
control for those.

CONSEQUENCE: the "PII-SAFE projection ONLY" guarantee is retired for this panel.
Every comment asserting it must be rewritten to the new posture, not deleted.
See section 8.

## 3. Verified facts

Measured read-only against the real account (938565869261, profile
`housingchoice`) on 2026-08-24. No mutations. Each fact names the record it came
from, because two different records were sampled.

1. POINTER LIFETIME IS NOT DESIGNED AROUND. A pointer for a 2026-08-17 event
   resolved on 2026-08-24 - the far edge of the widest window the panel offers.
   One observation, not a published guarantee. An expired pointer degrades like
   any other CloudWatch failure.
2. `@ptr` MUST BE ADDED TO THE `fields` CLAUSE. It is returned only when listed
   there. The current query string is
   `fields @timestamp, @message | filter ... | sort @timestamp desc | limit N`
   (`app/src/adapters/cloudwatch.ts:227`).
3. `@ptr` CHARSET, MEASURED. A real pointer was 220 chars over `[A-Za-z0-9+=]`.
   It CONTAINS `+` and `=`. No `/` appeared in that sample, but base64's alphabet
   includes `/`, so the sample does not bound the general case. NOT MEASURED: the
   POSITION of `=`. S4's transport is chosen so neither gap matters.
4. `GetLogRecord` FLATTENS NESTED JSON with dot notation. Sampled on a real prod
   ERROR record, which returned `err.message`, `err.stack`, `err.type` as
   separate top-level keys, alongside `correlationId`, `requestId`, `userId`,
   `s3Key`, `msg`, `level`, `time`.
5. VALUES COME BACK STRINGIFIED. Sampled on a DIFFERENT record (an info-level
   shutdown line), whose `level` was returned as the string `"30"`. The detail
   path must coerce; it cannot reuse the list path's `typeof === 'number'`
   assumptions.
6. THE DETAIL RECORD ALSO CARRIES `@message` (the complete raw line, 799 chars in
   the sample - one observation, not a bound), plus `@log`, `@logStream`,
   `@logGroupId`, `@ingestionTime`, `@timestamp`.
7. `@log` IS `<accountId>:<logGroupName>`, NOT a bare name. Observed:
   `938565869261:/hc/dev/app`. Normalise by taking everything after the last `:`.
8. A NON-JSON RECORD RETURNS NO APPLICATION FIELDS. Sampled on a real
   `/hc/prod/system` record (that group is entirely non-JSON): the response
   carried ONLY `@`-prefixed metadata (`@message`, `@log`, `@logStream`,
   `@ingestionTime`, `@timestamp`, `@logGroupId`, entity/account keys) plus
   `backwardToken`/`forwardToken`. No `err`, no `msg`, no `level`.
9. `@ptr` IS STABLE ACROSS SEPARATE QUERIES. The same log event was fetched by
   two independent Insights queries with distinct query ids; both returned a
   BYTE-IDENTICAL pointer. This is the property - not mere uniqueness - that lets
   `ref` serve as cross-query dedup identity and as a React row key that survives
   a refresh.

## 4. Scope

Slices are in dependency order. S2 is a prerequisite for S5.

### S1 - Self-describing messages at the source

The message names the failing unit and nothing else - no `err.type`, no
`err.message` prefix. `msg` stays a stable, low-cardinality string: greppable,
safe for future metric filters, groupable for dedup.

**Job dispatcher** (`app/src/jobs/jobs.ts:332`): `'job failed: ' + envelope.jobName`.

`jobName` is a module constant at all 13 call sites, but
`defineJobHandler(jobName: string, ...)` (`jobs.ts:193`) types it as `string`,
not a registry enum - the constant property holds by convention, not by types.

**Express handler** (`app/src/lib/errors.ts:137-164`) - THREE branches, two of
which currently emit an IDENTICAL string:

- `:140-143` headers-already-sent, `'unhandled error while handling request'`
- `:151-157` `URIError`, WARN, `'malformed URI in request - rejected as 400'`
- `:159-162` normal, `'unhandled error while handling request'` (same as `:143`)

The two error branches get DISTINCT strings; a headers-already-sent failure is a
materially different fault and is currently indistinguishable in the panel. The
WARN branch is panel-visible with `includeWarnings` on
(`app/src/routes/system.ts:77-79`) and is in scope: it takes the same treatment,
which for that branch always yields `method + (unrouted)`, because Express's
matcher throws before any route is bound (`errors.ts:147-151`).

**THE CONCRETE PATH NEVER ENTERS `msg`.** `req.path` can carry a raw E.164:
`app/src/routes/contacts.ts:2317`, `:2376` and
`app/src/routes/relayGroups.ts:467` mount a `:phone` segment. Promoting it into
`msg` would write a phone into a field section 8 simultaneously teaches operators
to grep, and would destroy the low-cardinality property this slice depends on.
This is the highest-consequence rule in the slice and section 7 asserts it
directly.

DETERMINISTIC RULE: the message carries `method` plus `req.baseUrl +
req.route.path`, and the literal token `(unrouted)` when `req.route` is unset.
`req.route.path` alone is MOUNT-RELATIVE and identifies nothing; no router in
`app/src` is mounted at a param-bearing path, so the `baseUrl` prefix cannot
reintroduce a concrete id. `path` REMAINS a structured field; only its promotion
into `msg` is refused.

`app/src/jobs/jobs.ts:290` logs `'dispatchJob: malformed job envelope rejected'`
with no `jobName`, by construction - the envelope failed validation. Left as-is.

ASCII CONSTRAINT: `errors.ts:154` contains a real em-dash (`E2 80 94`), the exact
non-ASCII section 9 shows does not survive the pipeline. S1-touched lines are
ASCII-ised.

RISK CHECK: nothing asserts on the literal `job failed` in `app/`, `dashboard/`
or `e2e/`. The `ErrorLogs` metric filter keys on `{ $.level >= 50 }`
(`infra/modules/observability/main.tf:56`), so alarms are unaffected.

### S2 - Envelope correlation propagation (prerequisite for S5)

`app/src/jobs/jobs.ts:174-179` copies four optional fields into the envelope's
correlation context - `requestId`, `conversationId`, `tenantId`, `placementId` -
and NOT `pollRunId` or `bootId`.

So a job enqueued from a worker poll tick (tour reminders, placement nudges,
roster actions, extraction, group guardrails - `app/src/lib/context.ts:20-33`)
carries no upstream id at all. Its `job failed` line has
`correlationId = jobRunId` and nothing linking back to the tick that enqueued it.

ADD `pollRunId` to the copied set.

This widens the "no change to what is written to logs" non-goal deliberately.
AGENTS.md requires that "All job traffic goes through `jobs.enqueue()` /
`defineJobHandler()` so correlation and trace context are preserved", and for
poll-originated jobs the current code does not preserve it.

WHAT CHANGES: every log line of every poll-enqueued job gains a `pollRunId`
field, because the mixin spreads the whole context (`logger.ts:232`). That is the
point of the change.

WHAT DOES NOT CHANGE: the `correlationId` VALUE. `logger.ts:231` resolves
`jobRunId ?? pollRunId ?? requestId ?? bootId`, and `jobRunId` still wins inside a
dispatched job.

BLAST RADIUS, verified: `isCompleteEnvelope` (`jobs.ts:216-232`) only asserts
that `correlationContext` is a non-null object - no schema, no key allowlist, no
rejection of unknown keys - so envelopes in flight and new envelopes both
validate. The whole surface is two writers (`jobs.ts:174`, and `jobs.ts:266` `{}`
on the synthesized path) and one spread-reader (`jobs.ts:299`); no code
enumerates context keys. `pollLoop.ts:67` wraps each tick in
`runWithContext({ ...baseContext, pollRunId: ... })` and `startPoll` is the
single entry point (`worker.ts:290`), so an `enqueue()` inside a poll's `run()`
does see `ctx.pollRunId`.

The pivot does NOT accept `conversationId` / `tenantId` / `placementId`. Those
are domain ids; searching by them is a different feature with a different
security surface.

### S3 - Widened list projection

Extend `ErrorEventView` (`app/src/adapters/cloudwatch.ts:79-94`) with:
`jobName`, `event`, `errType`, `errMessage`, `source`, `ref`, `requestId`,
`pollRunId`, and one truncation flag per capped field.

`requestId` and `pollRunId` must be on the wire or S5's pivot is unreachable from
the UI. They are already on the log line for the work that has them, because the
mixin spreads the whole context (`logger.ts:232`).

**MECHANISM.** None of these can be produced by the current code path:

- The query string (`cloudwatch.ts:227`) must gain `@ptr` and `@log` in `fields`.
- The result-row loop (`cloudwatch.ts:254-261`) extracts ONLY `@message` and
  `@timestamp` and discards every other cell. It must pass the whole row.
- `projectErrorEvent(rawMessage: string, ts: number)` (`:123`) must take the row.

**ACCESSOR SHAPES DIFFER BY PATH - do not conflate them.** The LIST path (this
slice) and the TRACE path (S5) parse the raw `@message` string
(`cloudwatch.ts:130`), where `err` is a NESTED object: read
`(obj.err as ...).message`. `obj['err.message']` is `undefined` there. Only the
DETAIL path (S4, via `GetLogRecord`) sees dot-flattened keys. Getting this wrong
ships a permanently blank field in the ONLY environment that has data - the
hermetic lane degrades to `unavailable_local` (`systemStatus.ts:212-214`), so no
gate catches it.

**FIELD PRESENCE.** `source` and `ref` are REQUIRED and non-null: every Insights
row carries `@log` and `@ptr` once they are in the `fields` clause, so both are
always derivable. An optional `source` would give the four-value union a fifth
de-facto `undefined` state with no rendering branch. Everything else follows the
existing `errorCode?: string | null` convention (`cloudwatch.ts:93`).

This WILL break existing partial fixtures under `npm run typecheck` - a required
gate - because `dashboard/src/routes/settings/RecentErrors.test.tsx:67-68` and
`:88-92` build four- and five-key literals. Update the fixtures; do not weaken
the types to avoid the edit.

**`source` is `'app' | 'worker' | 'system' | 'unknown'`.** `config.ts:526-528`
defines three log groups and `systemStatus.ts:234` queries `/hc/<env>/system` for
kernel-OOM lines, merging them into the same array (`:245`). Derive by
normalising `@log` per fact 7 and matching the three configured names; anything
else is `unknown`, which S6 renders rather than silently labelling `app`.

**`ref`** is the RAW `@ptr`, unmodified. S4 covers the transport.

**TRUNCATION**: cap `errMessage` AND `message` at 300 characters, each with its
OWN flag so the UI can say which field was cut. `msg` is uncapped today
(`cloudwatch.ts:136`) and S1 appends to it.

**FALLBACK LADDER.** `projectErrorEvent` initialises
`message = '(unparseable log line)'` and replaces it only when `msg`/`message` is
a non-empty string (`:127`, `:135-136`), so a well-formed JSON line carrying
`event` and `err` but no `msg` renders as "(unparseable log line)" today - absurd
next to a populated `event` chip. Ladder: `msg` -> `event` -> `err.message` ->
`(unparseable log line)`.

WHEN `message` IS DERIVED FROM `err.message` (rung three), it is by definition the
same string as `errMessage`. The row renders ONE of them, not the same truncated
text twice under two names with two truncation markers.

Non-JSON lines are excluded from the pino query by construction
(`cloudwatch.ts:57-58`), so `(unparseable log line)` remains reachable only for
the OOM queries, whose `message` is overwritten anyway. PRESERVE the OOM
relabeling (`systemStatus.ts:236-240`) unchanged.

**DEDUP**: add `ref` to the key at `systemStatus.ts:247`. Because `@ptr` is
unique per event and stable across queries (fact 9), the key becomes effectively
`ref` alone and the `timestamp|message|errorCode` components go inert. Keep them
in the key anyway - they cost nothing and document the prior contract - but do
not design around their being reached.

### S4 - Full-record detail

New: `GET /api/system/errors/detail?ref=<encoded pointer>` (admin-only, same
router).

**TRANSPORT.** `ref` is the raw pointer carried as a QUERY VALUE encoded with
`encodeURIComponent`, which encodes `+` as `%2B`, `/` as `%2F` and `=` as `%3D`;
both parsers decode `%2B` back to a literal `+`, because the `+`-to-space rule
applies only to an UNENCODED `+`. Use the existing `request()` helper with
`query: { ref }`: `dashboard/src/api/client.ts:44-52` already builds queries with
`URLSearchParams`, which encodes the pointer's alphabet identically, so this
works with zero new encoding code. Do NOT hand-roll a URL and bypass it.

The query-value form also keeps the pointer out of the request log:
`requestLogger.ts:33` logs `req.path`, which excludes the query string.

**RESPONSE - A STATED KEY SET, not "everything the record has".** Exactly:

- the `err` fields permitted by the allowlist below;
- the call site's own non-`err` fields;
- `@log`, `@logStream`, `@ingestionTime`;
- `rawText`, only for a non-JSON record (below);
- truncation/bound flags.

`@message` is never a response key. AWS transport metadata - `backwardToken`,
`forwardToken`, `@logGroupId`, `@logStreamId`, `@aws.*`, `@entity.*`,
`@data_*` (fact 8) - is NOT returned. Values coerced per fact 5.

Returning the raw `@message` alongside allowlisted fields would defeat the
allowlist completely: the response would drop `err.config.params` from the
flattened keys and then hand the client the original line still containing it.

For a NON-JSON record `GetLogRecord` returns no application fields at all
(fact 8), so the raw text is the only content. It is surfaced under an explicit
`rawText` field, capped at 4000 characters with a truncation flag.

**HUMAN DECISION (2026-08-24): host syslog raw text IS in scope.**
`/hc/<env>/system` is not kernel-OOM lines - it ships the ENTIRE
`/var/log/messages` unfiltered (`infra/modules/ec2/main.tf:410-411`), carrying
sshd, sudo, systemd, docker and cloud-init output, none of it chosen by a call
site. The panel has only ever shown two synthesized labels from that group
(`systemStatus.ts:52-53`, `:239-240`).

Showing it is the decision, on section 2's reasoning: admin-only and
server-enforced, host operational data rather than contact PII, and the OOM and
host-level rows are exactly where a synthesized label tells an operator nothing.
What it exposes, stated plainly: whatever the host wrote, including command lines
from sudo and sshd.

Note the deliberate asymmetry with S5, which EXCLUDES the system group. Both are
correct: the detail route admits it because the list merges OOM rows the operator
can expand, while the trace pivot excludes it because kernel lines carry no
correlation id. Do not reconcile them.

**FIELD RULE - AN ALLOWLIST UNDER `err`.**

- NON-`err` fields PASS THROUGH. They are app-authored: the call site chose to
  attach them, and they are the point of the detail view.
- The `err.*` subtree is ALLOWLISTED to `message`, `stack`, `type`, `name`,
  `code`, `status`, and `response.status`. Everything else beneath `err` is
  dropped AT ANY DEPTH, which closes `err.cause.*` and every future
  `*.config.*` / `*.request.*` by construction rather than by enumeration.
- A SCALAR `err` IS KEPT. Six call sites log `err` as a STRING, not an Error:
  `app/src/services/systemStatus.ts:204` and `:258`,
  `app/src/services/pushService.ts:188`, `:235`, `:380`, and
  `app/src/routes/auth.ts:311`. pino's serializer only transforms an Error VALUE,
  so those arrive as a flat top-level `err` with text and nothing beneath it,
  matching none of the seven allowed paths. A scalar `err` is by definition the
  message, and `message` is allowlisted. Note which two: `systemStatus.ts:204`
  and `:258` are this panel's OWN degraded-read diagnostics, so without this
  clause, when System Status fails to read CloudWatch the detail view would
  delete the reason.

`response.status` is kept because `errors.ts:77-82` reads it as the vendor
discriminator and `status` is one of the three fields in the repo's adjudicated
`ErrorSummary` allowlist (`errors.ts:34-38`).

**ENVIRONMENT SCOPE CHECK (required).** A `ref` is an account-scoped pointer bound
to nothing. If S7's IAM verification lands on the `resources = ["*"]` branch, this
route could otherwise read any log record in the account, including another
environment's. REJECT any record whose normalised `@log` is not one of
`config.errorLogGroupName` / `workerLogGroupName` / `systemLogGroupName`. One
comparison, and it makes the route's scope independent of the IAM outcome.

**RESPONSE SIZE BOUND**: 64 KB, with a flag when truncated. `err.stack` is the
field that realistically approaches it.

**VALIDATION - two different answers, matching S5**: a MISSING `ref` is a **400**,
matching the `since` precedent (`system.ts:68-72`). A PRESENT but malformed `ref`
(length or charset) takes the degraded 200. The client distinguishes a non-2xx
from a degraded 200 body (`dashboard/src/api/client.ts`), so the two drive
different UI paths.

**DEGRADATION**: HTTP 200 with `{ available: false, reason }` on a local/hermetic
stack, a CloudWatch failure, an unresolvable or expired pointer, or a failed
scope check. Never a 500.

**SEAM**: a new method on `CloudWatchClientSeam` (`cloudwatch.ts:97-107`); the SDK
import stays in the adapter. `fakeSeam` (`app/test/systemStatus.service.test.ts:38-50`)
takes `Partial<CloudWatchClientSeam>` as its INPUT but RETURNS a hardcoded
two-property literal typed as the full seam, so adding a required method is a
`npm run typecheck` failure, not a runtime throw. `fakeSeam` must gain stubs for
BOTH new methods (this one and S5's).

### S5 - Correlation trace pivot

New: `GET /api/system/trace` (admin-only, same router), taking:

- exactly one of `?correlationId=`, `?requestId=`, `?pollRunId=`; and
- `?at=<ISO timestamp>` - the anchor, REQUIRED.

**LOG GROUPS**: app + worker. `system` is EXCLUDED - its kernel lines carry no
correlation id, so scanning it costs bytes for nothing.

**IT DOES NOT REUSE `queryInsights`.** That seam hardcodes `sort @timestamp desc`
(`cloudwatch.ts:227`), its contract pins NEWEST-FIRST (`:100-106`),
`app/test/cloudwatch.adapter.test.ts:123` asserts it, and it returns
`ErrorEventView[]` - a projection that drops exactly the fields an INFO context
line carries. S5 gets its own seam method.

**THREE IDS, because correlationId alone cannot cross the job hop.**
`logger.ts:231` resolves `correlationId = jobRunId ?? pollRunId ?? requestId ??
bootId`, and `dispatchJob` mints a FRESH `jobRunId` per dispatch
(`jobs.ts:297-305`). Filtering a `job failed` line's correlationId returns that
job run alone - nothing about what enqueued it. `requestId` covers
request-originated work; `pollRunId` covers poll-originated work and is on the
wire only because of S2.

**WINDOW - ANCHORED ON THE ROW, NOT ROLLING.** S6's link sends the row's own
timestamp as `?at=`. A rolling window is the wrong frame: the list route defaults
to 24h (`system.ts:66-75`) while the panel's selector offers 7d
(`dashboard/src/routes/settings/RecentErrors.tsx:16-20`), so a rolling window
returns ZERO rows for any row older than a day, and an empty trace is
indistinguishable from "there was no context".

BRACKET WIDTH IS ID-DEPENDENT:

- `correlationId` pivot: `at - 5 min` to `at + 5 min`. One job run, local.
- `requestId` or `pollRunId` pivot: `at - 30 min` to `at + 5 min`. These are the
  cross-hop ids and reaching backwards is their purpose.

The wide branch is the common one, because S6's link precedence prefers
`requestId` and `pollRunId` when present. The tight branch applies to rows
carrying only a `correlationId` - boot-context lines and jobs whose enqueuing
context had no upstream id. Both branches are reachable; neither is dead.

Why 30 minutes: SQS retries span ~8 minutes before the DLQ
(`visibility_timeout_seconds = 120`, `maxReceiveCount = 5` -
`infra/modules/jobs/main.tf:36`, `:41`), and a delayed enqueue reaches ~12
minutes (`delaySeconds` from `opts.runAt`, `jobs.ts:112-114`, Phase 1 envelope
"no >12min callers" at `jobs.ts:104`). On the DLQ triage path
(`RUNBOOK.md:2169`) the failure can be ~20 minutes from its enqueue. The
look-ahead stays short: nothing wanted is half an hour after the failure.

**QUERY MECHANISM - TWO QUERIES WITH OPPOSITE SORTS.** A single ascending query
has the symmetric defect of the descending bug: Insights applies `limit` inside
the sort, so it returns the EARLIEST N rows in the bracket and can drop the
failure out of its own trace. That is the routine case, not an edge - one poll
tick fans out to many jobs, so a `pollRunId` trace is the widest of the three.

- BEFORE: `sort @timestamp desc | limit 25` over the bracket start through the
  ANCHOR'S WHOLE SECOND inclusive, then reversed.
- AFTER: `sort @timestamp asc | limit 25` starting at the second AFTER the
  anchor's, through the bracket end.
- Merged ascending into at most 50 rows.

**THE BOUNDARY IS AT SECOND GRANULARITY, AND THE ANCHOR'S SECOND BELONGS TO THE
BEFORE QUERY.** `StartQuery` takes epoch SECONDS, not milliseconds
(`cloudwatch.ts:229-237`), while `at` is a millisecond ISO timestamp - so a split
exactly at `at` is not expressible. Concretely: BEFORE uses
`endTime = floor(at/1000)`; AFTER uses `startTime = floor(at/1000) + 1`. The
windows are DISJOINT, so no row can appear in both and no merge dedup rule is
needed, and the anchor line is guaranteed present because its own second is in
the BEFORE half.

Do not use `ceil` for BEFORE's `endTime` and `floor` for AFTER's `startTime`.
That is the convention the existing list query uses (`cloudwatch.ts:233-234`) and
mirroring it here overlaps the two windows by up to a second, returning every
line in the anchor's second - INCLUDING THE FAILURE ITSELF - from both queries and
rendering it twice. Same-second collisions are routine for a `pollRunId`
fan-out, and no gate can see this: section 7's tests use an injected fake, and the
hermetic lane never reaches CloudWatch.

Both bounds convert to epoch seconds. A milliseconds-for-seconds slip yields an
empty trace that degrades silently.

**RUN THE TWO QUERIES IN PARALLEL.** Each Insights poll has a bounded ~8s budget
(20 polls x 400ms, `cloudwatch.ts:37-39`); sequential execution doubles the
worst-case wait on a user-initiated click. Use `Promise.all`, following
`systemStatus.ts:227`.

**ROW SHAPE**: its own type carrying timestamp, level, message, `source`, and the
diagnostic fields an INFO line needs (`method`, `path`, `statusCode`,
`durationMs`, `jobName`, `jobId`, `hopCount`). Not `ErrorEventView`.

`source` is on the trace row for the same reason it is required on the list row:
this is an interleaved app+worker timeline whose entire purpose is crossing the
process boundary, so which process emitted a line is the most load-bearing fact
on it. The query already spans two groups, so it carries `@log` in its `fields`
clause and reuses S3's normalisation.

**FIELD ACCESS**: S5 parses the raw `@message` JSON, exactly like the list path -
`err` is NESTED here. Its `fields` clause is `@timestamp, @message, @log`.

**TRUNCATION**: when either side hits its 25-row limit the response carries an
explicit per-side `truncated` flag, which S6 surfaces. A trace that silently omits
lines is worse than no trace, because it looks complete.

**VALIDATION - two different answers**: a missing id, several ids at once, or a
missing/unparseable `at` is a **400**, matching the `since` precedent
(`system.ts:68-72`). A well-formed request whose id is present but not
UUID-shaped takes the degraded 200. Ids are validated before entering the query
string - attacker-influencable input entering a query language. All four context
ids are `randomUUID()` (`app/src/lib/context.ts:72-87`) and the correlation
middleware MINTS rather than honors an inbound header
(`app/src/middleware/correlation.ts:14`), so validation cannot reject a
legitimate id.

**DEGRADATION**: the same `{ available: false, reason }` contract at HTTP 200.

**NO NEW IAM**: `logs:StartQuery` is already scoped to `/hc/<env>/*`
(`infra/modules/ec2/main.tf:288-295`).

### S6 - Dashboard wire layer and UI

FIVE files. The dashboard does not share the backend types - it hand-maintains a
mirror - so without the wire layer every new field stops at the server.

- `dashboard/src/api/types.ts:335-346` - `SystemErrorEvent` is declared
  independently with FIVE fields. It gains all eight new ones plus the truncation
  flags, and response types for both new routes. (The mirroring obligation is
  stated in the panel's origin spec,
  `docs/superpowers/specs/2026-06-29-settings-dashboard-design.md:163`.)
- `dashboard/src/api/endpoints.ts:2088-2108` - holds `getSystemAlarms` and
  `getSystemErrors` only. Add a client function per new route.
- `dashboard/src/routes/settings/useSystemStatus.ts:177-230` - where the panel's
  fetching lives. The per-row detail fetch and the trace fetch, with their
  loading/error state and abort handling, belong here, not improvised in a
  component.
- `dashboard/src/routes/settings/RecentErrors.tsx` - the list and the expander.
- A NEW trace view component alongside it - see below.

**COLLAPSED ROW**: timestamp, level, the four-value source chip, `jobName` or
`event` chip, the capped `message`, `errType` when present, `errMessage` when
present, the trace link, and an expand control.

`errMessage` IS rendered, on its own line under `message`. S3 leaves it null
whenever the fallback ladder already sourced `message` from `err.message`, so the
two can never duplicate each other - and when it IS populated it carries
different information: for a job failure `message` reads
"job failed: relay.warmNumber" while `errMessage` is the vendor text saying what
actually went wrong. That text is the point of the feature. It is also the only
place `errMessageTruncated` can be surfaced.

**EXPANDED** (one `GET /api/system/errors/detail`): full `err.message`,
`err.type`, `err.stack` in its OWN scroll container, remaining fields as a
key/value list, and `rawText` when the record carried one. The stack is bounded
and scrolls internally.

**TRUNCATION INDICATORS ARE RENDERED HERE - they have no other purpose.** Every
flag the server produces is surfaced: the two 300-char field flags in the
collapsed row (marking which field was cut, which is what invites the expander),
S4's `rawText` 4000-char flag and 64 KB response-bound flag in the expanded view,
and S5's per-side `truncated` flags in the trace view. A flag no slice renders is
dead weight.

**ROW KEY**: `ref`. It is unique per event and stable across queries (fact 9), so
it survives a refresh; the current key
(`RecentErrors.tsx:127`: `timestamp-correlationId-message`) collides once
messages share a truncated 300-char prefix, which would mis-associate expander
state and fetched detail.

**TRACE LINK**: prefer `requestId`, then `pollRunId`, then `correlationId`; the
first present one drives the link, and it also sends the row's `timestamp` as
`?at=`. OOM rows are non-JSON, so all three are null there
(`cloudwatch.ts:127`, `:144-146`) - exactly the rows `systemStatus.ts:239-240`
synthesises. `RecentErrors.tsx:52` already guards this and the guard is carried
forward: with no id the pivot is ABSENT, never rendered as `?correlationId=null`.

**TRACE VIEW** (new component): renders the merged ascending timeline returned by
S5. Per row: timestamp, level, source chip, message, and the diagnostic fields
present on that row. It shows the per-side `truncated` flags, marks the anchor
row visibly so the operator can see the failure they came from in its context,
and handles the degraded and empty results distinctly - an empty trace must read
as "no lines found in this window", never as a silent blank.

Presentation is the builder's call within the existing panel's idiom; it may be
an expansion within the panel or a routed sub-view. What is not optional is that
it exists, that it lives in the files above, and that it has a component test.

A11y: the expander is a real button with `aria-expanded`; existing heading
structure and `role="alert"`-on-load-error preserved. Accessibility-first
selectors per `e2e/support/selectors.md`.

### S7 - IAM

Add `logs:GetLogRecord` to `infra/modules/ec2/main.tf`.

DEFAULT TO THE SCOPED STATEMENT (`/hc/${var.env}/*`, as
`SystemStatusInsightsStart` does at `:288-295`). Fall back to
`resources = ["*"]` ONLY on a cited AWS Service Authorization Reference entry
showing the action does not support resource-level permissions, and comment the
citation inline as the neighbouring statements do. The repo's preference is
scope-where-scopable (`:282-287`).

S4's environment scope check is independent of which branch lands.

Both envs share the module, so the change applies to dev and prod alike.

## 5. Non-goals

- No new datastore for errors.
- No change to what is WRITTEN to logs, with two named exceptions: S1's message
  strings and S2's `pollRunId` propagation.
- No change to alarms or metric filters.
- No relaxation of the admin-only gate. If the panel is ever opened to
  non-admins, the section 2 decision must be revisited.
- No fallback retrieval path for an expired pointer (Appendix A.1).
- The pivot does not search by domain ids.
- The `forwardToken`/`backwardToken` adjacent-line reader is not built.
- The CP1252 log-encoding defect (section 9) is filed, not fixed, except on the
  specific lines S1 already edits.

## 6. Security posture

The panel may render contact PII and host operational data, deliberately, per
section 2.

**CREDENTIALS ARE A SEPARATE QUESTION.** Credential redaction at write time is a
BEST-EFFORT PATH LIST, known to be incomplete. `logger.ts:204-223` lists THREE
literal `err.config` paths and no wildcard; `err.config.url`, `err.config.params`,
`err.config.baseURL` and `err.config.auth` are NOT redacted. The code says so
itself at `:200-203`: "This is defense in depth, not the fix ... Redaction only
covers the paths it is told about, and the next SDK will invent a new one."

The repo's adjudicated position (`errors.ts:26-36`) is that `err.message` is the
field the VENDOR authors freely - the untrusted one.

That is why S4 uses an ALLOWLIST under `err` rather than a denylist or reliance
on write-time redaction: an allowlist closes the class by construction, including
nests nobody has met yet, and S4's response is a stated key set rather than a
pass-through of whatever the record holds.

The write-time sanitizers remain correct and must not be weakened.
`app/src/adapters/messaging.ts:693-716` sanitizes the availability SEARCH only -
by its own comment, the purchase and messages paths still write those nests.

**`telemetry-phone-in-url-pii`**: that issue is NOT OTLP-only - it explicitly
names the request logger writing `req.path` to CloudWatch as a pre-existing half
(`:21-23`) - and it is NOT a prod gate: the gate was lifted and accepted
2026-08-15, status `deferred` (`:28-33`). This change makes the CloudWatch half
directly renderable in the dashboard, consistent with the accepted posture. S1's
refusal to put a concrete path in `msg` avoids widening it.

## 7. Testing

**S1** - the slice with the highest-consequence rule and no test until now:

- Unit: the dispatcher message is `job failed: <jobName>`.
- Unit: **THE PII REFUSAL.** Given a request to a `:phone` route, the logged `msg`
  contains the route TEMPLATE and does NOT contain the concrete phone segment.
  This is the control that keeps a tenant's phone out of a low-cardinality field
  operators are taught to grep; nothing else asserts it, and `req.path` in `msg`
  typechecks, lints and renders fine.
- Unit: the two Express error branches emit DISTINCT messages.
- Unit: the `(unrouted)` token appears when `req.route` is unset, including on the
  `URIError` branch.

**S2**: `pollRunId` propagates through `jobs.enqueue`, and `correlationId`
resolution is unchanged inside a dispatched job.

**S3**: projection widening - per-field truncation flags, the fallback ladder,
the `message`-equals-`errMessage` single-render case, `source` derivation
including `system` and `unknown`, NESTED `err` access, `requestId`/`pollRunId`
projection, dedup with `ref` in the key.

**S4**: the seam method with an injected fake; stringified coercion; the `err`
ALLOWLIST - assert `err.cause.config.headers.Authorization` and
`err.config.params` are dropped, `err.response.status` SURVIVES, and a SCALAR
string `err` survives; no `@message` key for a parsed record and `rawText`
present for a non-JSON one; no AWS transport metadata in the response; the
environment scope check rejects a foreign log group; the 400-vs-degraded-200
split.

**S5**: two queries with OPPOSITE sorts, merged ascending; the ID-DEPENDENT
bracket (`-5min` for `correlationId`, `-30min` for `requestId`/`pollRunId`, both
`+5min` ahead); **the second-granularity boundary - assert BEFORE's `endTime` is
`floor(at/1000)` and AFTER's `startTime` is `floor(at/1000) + 1`, so the windows
are disjoint and the anchor appears exactly once**; epoch-SECONDS conversion,
mirroring `cloudwatch.adapter.test.ts:120-121`; the two queries run in parallel;
the anchor is present and `truncated` is set when a side is capped; the
400-vs-degraded-200 split.

**S6 (component)**: `RecentErrors` collapsed/expanded, four-value chip, `ref` row
key, trace-link id precedence, its absent-id case, and the link sending `?at=`;
every truncation indicator renders; the trace view renders a timeline, marks the
anchor, surfaces per-side truncation, and distinguishes empty from degraded.

**e2e**: the panel degrades to "Available in deployed environments." on the
hermetic stack - the only reachable state without AWS. Extend the existing System
Status spec.

The detail and trace routes cannot be exercised against real AWS from the
hermetic lane; their AWS-facing behavior is covered by injected fakes, and the
section 3 spike is the real-API evidence.

**PERF HARNESS.** `npm run perf:pages` is a sanctioned gate (AGENTS.md) over a
closed registry. Two separate obligations:

1. ENDPOINT DECLARATIONS, conditional. The detail and trace requests fire on a
   click, and a page-load profile never performs one. If the profiler's walk does
   NOT reach them, leave the endpoint registry alone. If it does, declare both
   templates in `e2e/performance/templates.ts:151-153` (`assertEndpointTemplate`
   throws `undeclared_endpoint_template` otherwise) and add `SYSTEM_GETS` entries
   (`routes.ts:304-306`) using `conditional(...)` (`routes.ts:163`), NOT
   `required(...)` - a `required` entry asserts the request is observed on every
   profiled page load and would fail from the other direction.
   `routes.test.ts:106-109` asserts the list.
2. SOURCE-CITATION LEDGER, UNCONDITIONAL. The harness pins SOURCE LINE RANGES
   into the exact file S6 mandates editing: `routes.ts:680`
   (`useSystemStatus.ts:77-132`) and `routes.ts:762`
   (`useSystemStatus.ts:124-132`), with `collect.test.ts:352-364` asserting them
   as literal strings. S6 adds a detail fetch and a trace fetch with new imports
   above both ranges. Update the two citations in `routes.ts` AND the pinned
   literal in `collect.test.ts:353` TOGETHER. Leaving them stale keeps every gate
   green while the ledger rots (`routes.test.ts:401-434`'s `cited()` helper only
   regex-checks citation SHAPE, never that the lines exist); updating only
   `routes.ts` turns `collect.test.ts` red on a required gate.

Also verified and NOT to be re-investigated: `matchTemplate` keys on segment
count (`templates.ts:200-211`), so a 4-segment `/api/system/errors/detail` cannot
collide with `/api/system/errors`; and query VALUES never reach artefacts, only
sorted key names (`templates.ts:227-229`), so neither the pointer nor a UUID
value trips the privacy scanner.

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
- `dashboard/src/api/types.ts:334-346` (`SystemErrorEvent` docblock - this file
  also gains real FIELDS under S6, not just a comment fix)
- `dashboard/src/routes/settings/RecentErrors.tsx:1-7` (component header)
- `dashboard/src/routes/settings/RecentErrors.test.tsx:2`, `:63` (a describe block
  named "available:true rendering (PII-safe)")
- `app/src/adapters/messaging.ts:700` (comment naming the literal `job failed`)
- `docs/issues/fake-twilio-messaging-attach-404.md:45` (quotes
  `"msg":"job failed"` as a live Insights search signature that S1 invalidates)
- `RUNBOOK.md` - the DLQ alarm row. It teaches that the `job failed` lines carry
  "the originating request's correlation IDs" (plural). ADD the panel's new
  affordances and PRESERVE that technique - it is broader than the pivot.

NOT a correction: `app/test/cloudwatch.adapter.test.ts:7`, `:129`. The comment
"PII-safety: raw text never surfaced" remains TRUE of the list path, which keeps
`(unparseable log line)`. Extend it to note that S4 surfaces raw text on the
detail path; do not "fix" it as though it were wrong.

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
IAM action; until it is applied, the detail expander fails authorization and
degrades. The human runs this; agents do not mutate infrastructure.

Carry this to the top of the handback.

## Appendix A - alternatives considered and rejected

Recorded so they are not re-proposed. None of these is a requirement.

**A.1 A fallback retrieval path for an expired pointer.** Rejected. A second
retrieval path (GetLogRecord with a correlationId re-query fallback) would be
permanently maintained, permanently tested, and exercised approximately never;
pointers resolved fine at the widest window offered (fact 1), and the failure
degrades visibly through the same `{ available: false, reason }` every other
CloudWatch failure uses.

**A.2 base64url-transcoding the pointer.** Rejected in favour of
`encodeURIComponent`. Transcoding needs a transform AND an inverse with
re-padding, and assumes `=` is only trailing padding - a positional property fact
3 explicitly did not measure. If the inverse were wrong, every pointer would fail
and the degraded contract would swallow it invisibly. `encodeURIComponent`
achieves the same result with no transform and no inverse.

**A.3 A raw pointer in a path segment, or in a naive query parameter.** Rejected.
A pointer may contain `/`, which cannot survive a path segment, and a malformed
escape never reaches the handler - Express's matcher throws `URIError` first and
`errors.ts:151-158` answers 400, contradicting the degraded contract. A naive
query parameter is no better: Express's default `qs` parser decodes an unencoded
`+` as a space, and pointers contain `+` (fact 3).

**A.4 An outbound DENYLIST on `err.config.*` / `err.request.*` /
`err.response.*`.** Rejected in favour of the allowlist. A denylist is the same
path-list mechanism section 6 identifies as structurally unable to enumerate what
it has not met; `err.cause` is a concrete hole through it (an axios error wrapped
as a cause flattens to `err.cause.config.headers.Authorization`, matched by
neither the logger's redact list nor those three prefixes). It would also have
dropped `err.response.status`, the vendor discriminator the repo's own
`ErrorSummary` deliberately keeps.

**A.5 Relaxing the `(unparseable log line)` fallback on the list path.**
Rejected as undeliverable. Non-JSON lines are excluded from the pino query by
construction (`cloudwatch.ts:57-58`), and the only non-JSON rows come from the
two OOM queries, whose `message` is unconditionally overwritten
(`systemStatus.ts:239-240`). It would have changed nothing visible while retiring
a stated property. Raw text is reachable via S4 instead.

**A.6 A two-tier expander** (summary first, stack behind a second click).
Rejected: it adds a click on exactly the cases where the stack is wanted.

**A.7 An uncapped message in the collapsed row.** Rejected: one multi-KB
`AggregateError` pushes every other row off screen.

**A.8 A rolling window for the trace**, inherited from the panel's selector.
Rejected: it returns zero rows for any row older than the route's 24h default and
misleads near its edge. See S5's anchored bracket.

**A.9 A single ascending trace query.** Rejected: Insights applies `limit` inside
the sort, so it keeps the earliest rows and can drop the failure out of its own
trace. See S5's two-query mechanism.
