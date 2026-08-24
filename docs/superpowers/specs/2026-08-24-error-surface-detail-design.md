# Error surface detail - design

Date: 2026-08-24
Status: DRAFT r2 (awaiting human spec review)
Branch: feat/error-surface-detail
Worktree: W:\tmp\error-surface-detail
Design review: round 1 complete (2 reviewers, 37 findings, 24 accepted).
Adjudications: `.superpowers/design-review/adjudications.md`

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

Two shared wrappers are structurally affected, because each covers many distinct
failures: the job dispatcher (`app/src/jobs/jobs.ts:332`) and the Express error
handler (`app/src/lib/errors.ts:137-164`). There are 13 registered job handlers
(`grep defineJobHandler(`), and 248 error call sites overall - most of which
write a specific message and read fine today.

## 2. Decision: the projection is a display control, not a storage control

`err.message` and `err.stack` are ALREADY at rest in CloudWatch. Widening the
projection adds no new data to any store and creates no new retention
obligation. It changes only what the panel is willing to render.

The panel is admin-only and enforced SERVER-side: `createSystemRouter` applies
`requireRole('admin')` to every `/api/system/*` route
(`app/src/routes/system.ts:45`), so a VA receives 403. Verified, not inferred
from the client-side route guard.

Human decision (2026-08-24): PII in the dashboard error panel is ACCEPTABLE,
because the people who can reach it already have access to the underlying data.
PII redaction remains correct at the LOG level, where the real boundary is.

SCOPE OF THAT DECISION: it covers CONTACT DATA - phone numbers, names, message
text. It does NOT cover CREDENTIALS, which were never in its scope. See section
6, which is materially different from the r1 draft.

CONSEQUENCE: the "PII-SAFE projection ONLY" guarantee is deliberately retired for
this panel. Every comment asserting it must be rewritten to the new posture, not
deleted. See section 8.

## 3. Verified facts (spike, 2026-08-24)

Read-only against the real account (938565869261, profile `housingchoice`) using
`start-query` / `get-query-results` / `get-log-record`. No mutations.

Each fact names the record it came from, because two different records were
sampled and conflating them was a defect in the r1 draft.

1. POINTER LIFETIME IS NOT DESIGNED AROUND. A pointer for a 2026-08-17 event
   resolved successfully on 2026-08-24 - the far edge of the widest window the
   panel offers. This is one observation, not a published guarantee, and is
   deliberately NOT stated as one. An expired pointer degrades exactly like any
   other CloudWatch failure (section S3). No fallback retrieval path is built;
   see adjudication RJ1.
2. `@ptr` MUST BE ADDED TO THE `fields` CLAUSE. It is returned only when listed
   there. The current query string is
   `fields @timestamp, @message | filter ... | sort @timestamp desc | limit N`
   (`app/src/adapters/cloudwatch.ts:227`) and must gain `@ptr` and `@log`.
3. `@ptr` CHARSET, MEASURED. A real pointer was 220 chars over `[A-Za-z0-9+=]`.
   It CONTAINS `+` and `=`. No `/` appeared in that sample, but base64's alphabet
   includes `/`, so the sample does not bound the general case. This drives S3's
   transport decision.
4. `GetLogRecord` FLATTENS NESTED JSON with dot notation. Sampled on a real prod
   ERROR record, which returned `err.message`, `err.stack`, `err.type` as
   separate top-level keys, alongside `correlationId`, `requestId`, `userId`,
   `s3Key`, `msg`, `level`, `time`.
5. VALUES COME BACK STRINGIFIED. Sampled on a DIFFERENT record (an info-level
   shutdown line), whose `level` was returned as the string `"30"`, not the
   number `30`. The detail path MUST coerce; it cannot reuse the list path's
   `typeof === 'number'` assumptions.
6. THE DETAIL RECORD ALSO CARRIES `@message` (the complete raw line, 799 chars in
   the sample - one observation, not a bound), plus `@log`, `@logStream`,
   `@logGroupId`, `@ingestionTime`, `@timestamp`.
7. `@log` IS `<accountId>:<logGroupName>`, NOT a bare name. Observed value:
   `938565869261:/hc/dev/app`. Any mapping to a source label must normalise by
   taking everything after the last `:`.

## 4. Scope

### S1 - Self-describing messages at the source

DECIDED: IDENTITY ONLY. The message names the failing unit and nothing else. It
does NOT append `err.type` or an `err.message` prefix. Rationale: `msg` stays a
stable, low-cardinality string - greppable, safe for future metric filters,
groupable for dedup. The error detail is a first-class field and is now fully
readable in the panel.

**Job dispatcher** (`app/src/jobs/jobs.ts:332`): `'job failed: ' + envelope.jobName`.

`jobName` is a module constant at all 13 call sites, but note
`defineJobHandler(jobName: string, ...)` (`jobs.ts:193`) types it as `string`,
not a registry enum - "registry constant" holds by convention, not by the type
system.

**Express handler** (`app/src/lib/errors.ts:137-164`) - THREE branches, not two,
and two of them currently emit an IDENTICAL string:

- `:140-143` headers-already-sent branch, `'unhandled error while handling request'`
- `:151-157` `URIError` branch, WARN, `'malformed URI in request - rejected as 400'`
- `:159-162` normal branch, `'unhandled error while handling request'` (same literal as `:143`)

The two error branches must be given DISTINCT strings - a headers-already-sent
failure is a materially different fault and is currently indistinguishable in the
panel, which is the exact problem S1 exists to fix. The WARN branch is
panel-visible whenever `includeWarnings` is on (`app/src/routes/system.ts:77-79`)
and is in scope.

**THE CONCRETE PATH NEVER ENTERS `msg`.** `req.path` can carry a raw E.164:
`app/src/routes/contacts.ts:2317`, `:2376` and
`app/src/routes/relayGroups.ts:467` all mount a `:phone` path segment. Putting it
in `msg` would write a phone across the very boundary section 2 says stays real,
and would destroy S1's own low-cardinality rationale.

DETERMINISTIC RULE: the message carries `method` plus `req.baseUrl +
req.route.path`, and the literal token `(unrouted)` when `req.route` is unset -
which it is for middleware, body-parser and `URIError` failures. `req.route.path`
alone is MOUNT-RELATIVE (contacts registers `'/:contactId/phones/:phone'`, not
the full path) and identifies nothing on its own, hence the `baseUrl` prefix.
`path` REMAINS a structured field; only its promotion into `msg` is refused.

ALSO NOTED, not renamed: `app/src/jobs/jobs.ts:290` logs
`'dispatchJob: malformed job envelope rejected'` with no `jobName` - by
construction, since the envelope failed validation. Left as-is; recorded so the
enumeration is honest.

ASCII CONSTRAINT: `errors.ts:154` currently contains a real em-dash
(bytes `E2 80 94`) - the exact non-ASCII section 9 shows does not survive the
pipeline. Any S1-touched line is ASCII-ised.

RISK CHECK: nothing asserts on the literal `job failed` in `app/`, `dashboard/`
or `e2e/`. The `ErrorLogs` metric filter keys on `{ $.level >= 50 }`
(`infra/modules/observability/main.tf:56`), so alarms are unaffected.

### S2 - Widened list projection

Extend `ErrorEventView` (`app/src/adapters/cloudwatch.ts:79-94`) with:

- `jobName`, `event`, `errType`, `errMessage` (capped), `source`, `ref`.

**MECHANISM - this is the part the r1 draft omitted entirely.** None of these
can be produced by the current code path:

- The query string (`cloudwatch.ts:227`) must gain `@ptr` and `@log` in `fields`.
- The result-row loop (`cloudwatch.ts:254-261`) extracts ONLY `@message` and
  `@timestamp` and discards every other cell. It must be rewritten to pass the
  whole row.
- `projectErrorEvent(rawMessage: string, ts: number)` (`:123`) must take the row,
  not a string, so it can read `@ptr` and `@log`.

**ACCESSOR SHAPES DIFFER BETWEEN PATHS - do not conflate them.** The LIST path
parses the raw `@message` string (`cloudwatch.ts:130`), where `err` is a NESTED
object written by pino's serializer: read `(obj.err as ...).message`.
`obj['err.message']` is `undefined` there. Only the DETAIL path (S3, via
GetLogRecord) sees dot-flattened `err.message` keys.

Getting this wrong ships a panel whose `errType`/`errMessage` are permanently
blank in the ONLY environment that has data - the hermetic lane degrades to
`unavailable_local` (`systemStatus.ts:212-214`), so no gate would catch it.

**`source` is `'app' | 'worker' | 'system'`** - THREE values. `config.ts:526-528`
defines three log groups and `systemStatus.ts:234` queries
`/hc/<env>/system` for kernel-OOM lines, merging them into the same array
(`:245`). Derive by normalising `@log` per fact 7 and matching the three
configured names; an unmatched group falls back to an explicit unknown rather
than being silently labelled `app`.

**`ref`** is the `@ptr`, TRANSCODED TO base64url server-side (`+`->`-`, `/`->`_`,
strip `=`) so it is URL-safe in any position. See S3 for why.

**TRUNCATION**: cap `errMessage` AND `message` at 300 characters with an explicit
truncation flag (not a bare ellipsis) so the UI can show more exists and offer
S3. `msg` is uncapped today (`cloudwatch.ts:136` takes it whole) and S1 now
appends to it, so it needs the cap as much as `errMessage` does.

**FALLBACK LADDER.** `projectErrorEvent` currently initialises
`message = '(unparseable log line)'` and replaces it only when `msg`/`message` is
a non-empty string (`:127`, `:135-136`) - so a well-formed JSON line carrying
`event` and `err` but NO `msg` renders as "(unparseable log line)" today. With
S2 adding an `event` chip, that row would read "(unparseable log line)" next to a
populated chip. New ladder: `msg` -> `event` -> `err.message` ->
`(unparseable log line)`.

**THE r1 "RELAX THE UNPARSEABLE FALLBACK" INSTRUCTION IS WITHDRAWN.** It was
undeliverable and self-contradictory. Non-JSON lines are excluded from the pino
query by construction (`cloudwatch.ts:57-58`); the only non-JSON rows come from
the two OOM queries, whose `message` is unconditionally overwritten at
`systemStatus.ts:239-240`. The relaxation would have changed nothing visible
while retiring a stated property, and
`app/test/cloudwatch.adapter.test.ts:129-130` pins the current behavior. Raw text
stays reachable via S3.

**PRESERVE** the OOM relabeling (`systemStatus.ts:236-240`) unchanged.

**DEDUP KEY**: `systemStatus.ts:247` keys on `timestamp|message|errorCode`, which
collapses genuinely distinct rows from different log groups at the same
millisecond. That was harmless while the panel made no origin claim; with a
`source` chip and a per-row `ref` it means the chip and the fetched record can
belong to a different event than the row shown. `ref` joins the key.

### S3 - Full-record detail

New: `GET /api/system/errors/detail?ref=<base64url>` (admin-only, same router).

**TRANSPORT - why a query parameter and why base64url.** A raw `@ptr` contains
`+` and `=` (fact 3) and may contain `/`. A path segment cannot carry `/`, and a
`%2F` is normalised or rejected by CloudFront before Express sees it; a malformed
escape does not even reach the handler, because Express's matcher throws
`URIError` first and `errors.ts:151-158` answers 400 - contradicting the degraded
contract below. A NAIVE query parameter is no better: Express's default `qs`
parser decodes `+` as a space, silently corrupting the pointer.

base64url transcoding removes every one of those hazards at the source, and the
query-parameter form keeps the value out of the request log: `requestLogger.ts:33`
logs `req.path`, which in Express EXCLUDES the query string.

**RESPONSE**: the flattened record - full `err.message`, `err.type`, `err.stack`,
the fields the call site attached, plus `@log`, `@logStream`, `@ingestionTime`
and the raw `@message`. Values coerced per fact 5.

**OUTBOUND DENYLIST (required).** The `err.config.*`, `err.request.*` and
`err.response.*` nests are DROPPED before the response. They are the documented
carriers of both credentials and the property ZIP the messaging sanitizer exists
to contain (`app/src/adapters/messaging.ts:693-716`), the logger's redact list
does NOT cover `err.config.url` / `err.config.params` / `err.config.auth`
(`logger.ts:204-223` lists three literal paths, not a wildcard), and they carry
no troubleshooting value the remaining fields lack. See section 6.

**RESPONSE SIZE BOUND**: the response is bounded; an oversized record is
truncated with an explicit flag rather than streamed whole.

**DEGRADATION**: HTTP 200 with `{ available: false, reason }` on a
local/hermetic stack, a CloudWatch failure, or an unresolvable/expired pointer.
Never a 500.

**VALIDATION**: `ref` is attacker-influencable input forwarded to an AWS API.
Length-bound and charset-validate it (base64url alphabet only) BEFORE the SDK
call; malformed input produces the degraded response, never an unhandled throw.

**SEAM**: a new method on `CloudWatchClientSeam` (`cloudwatch.ts:97-107`); the
SDK import stays in the adapter. Test fakes are built from
`Partial<CloudWatchClientSeam>` (`app/test/systemStatus.service.test.ts:41-42`),
so a fake omitting the method must THROW, not silently no-op - the method is not
optional on the interface.

### S4 - Correlation trace pivot

New: `GET /api/system/trace?correlationId=<uuid>` , also accepting
`?requestId=<uuid>` (admin-only, same router).

**IT DOES NOT REUSE `queryInsights`.** That seam hardcodes `sort @timestamp desc`
(`cloudwatch.ts:227`), its contract pins NEWEST-FIRST (`:100-106`),
`app/test/cloudwatch.adapter.test.ts:123` asserts it, and it returns
`ErrorEventView[]` - a projection that drops exactly the fields an INFO context
line carries. S4 gets its OWN seam method.

**ASCENDING SORT IS LOAD-BEARING, NOT COSMETIC.** Insights applies `limit` INSIDE
the sort, so a descending query on a correlation with more lines than the limit
keeps the lines AFTER the failure and discards the ones BEFORE it - the opposite
of the feature's purpose. Client-side re-sorting cannot recover them. The query
sorts ascending server-side.

**BOTH IDS, because correlationId alone cannot cross the job hop.**
`logger.ts:231` resolves `correlationId = jobRunId ?? pollRunId ?? requestId ??
bootId`, and `dispatchJob` mints a FRESH `jobRunId` per dispatch
(`jobs.ts:297-305`) while the originating `requestId` survives only as a separate
field. Filtering on a `job failed` line's correlationId therefore returns that
job run alone - `job started`, the handler's lines, `job failed` - and nothing
about what enqueued it. That is precisely the motivating case, so the pivot must
also filter on `requestId`.

**SHAPE**: its own row type carrying timestamp, level, message and the
diagnostic fields an INFO line needs (`method`, `path`, `statusCode`,
`durationMs`, `jobName`, `jobId`, `hopCount`) - not `ErrorEventView`.

**WINDOW / LIMIT / DEGRADATION**: same window vocabulary and validation as the
list route (`system.ts:65-75`), an explicit row limit, and the same
`{ available: false, reason }` degraded contract at HTTP 200.

**VALIDATION**: both ids are validated as UUID-shaped before entering the query
string - they are attacker-influencable input entering a query language.
`correlationId` is always a `randomUUID()` and the correlation middleware MINTS
rather than honors an inbound header (`app/src/middleware/correlation.ts:14`), so
the validation cannot reject a legitimate id.

**NO NEW IAM**: `logs:StartQuery` is already scoped to `/hc/<env>/*`
(`infra/modules/ec2/main.tf:288-295`).

### S5 - Dashboard UI

`dashboard/src/routes/settings/RecentErrors.tsx`.

DECIDED: compact row, ONE expander containing everything.

Collapsed row: timestamp, level, the `app`/`worker`/`system` source chip,
`jobName` or `event` chip, capped message, the trace link, and an expand control.

Expanded (one `GET /api/system/errors/detail`): full `err.message`, `err.type`,
`err.stack` in its OWN scroll container, remaining fields as a key/value list,
and the raw record. The stack must not push the page - it is bounded and scrolls
internally.

**ROW KEY**: use `ref`. The current key
(`RecentErrors.tsx:127`: `timestamp-correlationId-message`) collides once
messages are truncated to a shared 300-char prefix, and React would then
mis-associate per-row expander state and fetched detail across a refresh. `ref`
is unique per event and already on the wire. ("Never rendered" in S2 means not
displayed - it is used in the view layer.)

**TRACE LINK NULL GUARD**: OOM rows are non-JSON, so `correlationId` is always
`null` there (`cloudwatch.ts:127`, `:144-146`) - and those are exactly the rows
`systemStatus.ts:239-240` synthesises. `RecentErrors.tsx:52` already guards this
and the guard must be carried forward. The trace pivot requires a correlationId
or requestId and is ABSENT without one; it is never rendered as
`/api/system/trace?correlationId=null`.

Rejected: a two-tier expander (an extra click on exactly the cases where the
stack is wanted) and an uncapped message in the row.

A11y: the expander is a real button with `aria-expanded`; existing heading
structure and `role="alert"`-on-load-error preserved. Accessibility-first
selectors per `e2e/support/selectors.md`.

### S6 - IAM

Add `logs:GetLogRecord` to `infra/modules/ec2/main.tf`.

DEFAULT TO THE SCOPED STATEMENT (`/hc/${var.env}/*`, as
`SystemStatusInsightsStart` does at `:288-295`). Fall back to
`resources = ["*"]` ONLY on a cited AWS Service Authorization Reference entry
showing the action does not support resource-level permissions, and comment the
citation inline the way the neighbouring statements do. The repo's stated
preference is scope-where-scopable (`:282-287`); the permissive branch is not the
default.

Both envs share the module, so the change applies to dev and prod alike.

## 5. Non-goals

- No new datastore for errors.
- No change to what is WRITTEN to logs beyond S1's message strings.
- No change to alarms or metric filters.
- No relaxation of the admin-only gate. If the panel is ever opened to
  non-admins, this decision must be revisited.
- No dual-path retrieval fallback for an expired pointer (adjudication RJ1).
- The `forwardToken`/`backwardToken` adjacent-line reader is not built.
- The CP1252 log-encoding defect (section 9) is filed, not fixed, except on the
  specific lines S1 already edits.

## 6. Security posture (materially revised after review)

BEFORE: the panel guaranteed a PII-safe projection of four allowlisted fields.

AFTER: the panel may render contact PII, deliberately, because it is admin-only
and server-enforced and its audience already has that access.

**CREDENTIALS ARE A SEPARATE QUESTION AND THE r1 DRAFT GOT IT WRONG.** It claimed
credentials "never reach CloudWatch in the first place" and cited `err.config.*`.
That is false. `logger.ts:204-223` lists THREE literal `err.config` paths and no
wildcard; `err.config.url`, `err.config.params`, `err.config.baseURL` and
`err.config.auth` are NOT redacted. The code disclaims the guarantee in its own
words at `:200-203`: "This is defense in depth, not the fix ... Redaction only
covers the paths it is told about, and the next SDK will invent a new one."

The repo's adjudicated position (`app/src/lib/errors.ts:26-36`) is that
`err.message` is the field the VENDOR authors freely and is therefore the
UNTRUSTED one - the r1 draft named it as the safe one.

HONEST STATEMENT: credential redaction is a BEST-EFFORT path list, known to be
incomplete. This is why S3 carries an outbound denylist on the `err.config.*`,
`err.request.*` and `err.response.*` nests rather than relying on write-time
redaction alone. The human's PII decision covered contact data; it did not cover
credentials, and this spec does not treat it as though it had.

STILL TRUE: the write-time sanitizers remain correct and must not be weakened.
`app/src/adapters/messaging.ts:693-716` sanitizes the availability SEARCH only -
by its own comment, the purchase and messages paths still write those nests.

**`telemetry-phone-in-url-pii` - the r1 draft misdescribed this twice.** It is
NOT OTLP-only: the issue explicitly names the request logger writing `req.path`
to CloudWatch as a PRE-EXISTING half (`:21-23`). And it is NOT a prod gate: the
gate was LIFTED and accepted 2026-08-15, status `deferred` (`:28-33`). The honest
statement is that this change makes the CloudWatch half of that issue directly
renderable in the dashboard - consistent with the accepted posture, but not
"unaffected". S1's refusal to put a concrete path in `msg` avoids WIDENING it.

## 7. Testing

- Unit: `projectErrorEvent` widening - truncation and its flag, the fallback
  ladder, `source` derivation including `system` and the unknown-group fallback,
  NESTED `err` access on the list path.
- Unit: the new adapter seam methods with injected fakes (no AWS); base64url
  round-trip; stringified-value coercion on the detail path; the S3 denylist
  actually dropping `err.config.*` / `err.request.*` / `err.response.*`.
- Unit: admin enforcement on both new routes; validation of `ref` and both trace
  ids (malformed -> degraded response, never an unhandled throw).
- Unit: the trace query sorts ASCENDING (mirroring the existing
  `sort @timestamp desc` assertion at `cloudwatch.adapter.test.ts:123`).
- Unit: OOM relabeling still wins; dedup with `ref` in the key.
- Component: `RecentErrors` collapsed/expanded, chips, `ref` row key, the trace
  link's null guard.
- e2e: the panel degrades to "Available in deployed environments." on the
  hermetic stack - the only reachable state without AWS. Extend the existing
  System Status spec.

**PERF HARNESS - an unenumerated surface in the r1 draft.** `npm run perf:pages`
is a sanctioned gate (AGENTS.md) over a CLOSED registry. All three must change
together or its contract tests go red:

- `e2e/performance/templates.ts:151-153` - declare `/api/system/errors/detail`
  and `/api/system/trace`; `assertEndpointTemplate` throws
  `undeclared_endpoint_template` otherwise.
- `e2e/performance/routes.ts:304-306` - `SYSTEM_GETS` pins allowed query keys
  (`required('/api/system/errors', ['since'])`); the new routes' keys must be
  declared.
- `e2e/performance/routes.test.ts:106-109` asserts that exact list.

The artefact privacy scanner rejects a bare UUID. The query-parameter transport
(S3, S4) avoids minting UUID-bearing PATH templates, but the builder must
confirm the scanner is satisfied for the declared templates.

The detail and trace routes cannot be exercised against real AWS from the
hermetic lane; their AWS-facing behavior is covered by injected fakes, and the
section 3 spike is the real-API evidence.

## 8. Comment and doc truth-up (do not skip)

The r1 draft listed 6 sites; a grep for `PII-SAFE|PII-safe` across `app/` and
`dashboard/` shows at least 12. Rewrite each to the new posture:

- `app/src/adapters/cloudwatch.ts:12-14` (file header PII note)
- `app/src/adapters/cloudwatch.ts:78` ("projected to the PII-SAFE fields ONLY")
- `app/src/adapters/cloudwatch.ts:84-85` (the `message` field comment)
- `app/src/adapters/cloudwatch.ts:90-92` (the `errorCode` PII-SAFE note)
- `app/src/adapters/cloudwatch.ts:104` (seam doc, "PII-safe: each result row ...")
- `app/src/adapters/cloudwatch.ts:116-122` (`projectErrorEvent` docblock)
- `app/src/services/systemStatus.ts:15-22` (service header - untouched by r1)
- `app/src/routes/system.ts:14-18` (router header PII note)
- `app/src/routes/system.ts:63` ("recent error events (PII-safe)")
- `dashboard/src/api/endpoints.ts:2095` ("recent error events (PII-safe)")
- `dashboard/src/api/types.ts:334-346` (`SystemErrorEvent` docblock)
- `dashboard/src/routes/settings/RecentErrors.tsx:1-7` (component header)
- `app/test/cloudwatch.adapter.test.ts:7`, `:129` (test header and the comment
  attached to the assertion S2 keeps)
- `dashboard/src/routes/settings/RecentErrors.test.tsx:2`, `:63` (a describe
  block literally named "available:true rendering (PII-safe)")
- `app/src/adapters/messaging.ts:700` (comment naming the literal `job failed`)
- `docs/issues/fake-twilio-messaging-attach-404.md:45` (quotes
  `"msg":"job failed"` as a live Insights search signature that S1 invalidates)
- `RUNBOOK.md` - the DLQ alarm row. It currently teaches that the `job failed`
  lines carry "the originating request's correlation IDs" (plural). The rewrite
  must ADD the panel's new affordances and PRESERVE that requestId technique -
  which is broader than the correlationId pivot (S4).

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

TERRAFORM PLAN AND APPLY IS REQUIRED BEFORE DEPLOY, in dev AND prod. S6 adds an
IAM action; until it is applied, the detail expander will fail authorization and
degrade. The human runs this; agents do not mutate infrastructure.

Carry this to the top of the handback.
