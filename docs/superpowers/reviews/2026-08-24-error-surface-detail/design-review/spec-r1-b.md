# Adversarial design review - Error surface detail (spec r1, reviewer B)

Spec under review: `W:\tmp\error-surface-detail\docs\superpowers\specs\2026-08-24-error-surface-detail-design.md`
Repo: `W:\tmp\error-surface-detail` (read-only; no tests, no builds, no e2e run)
Date: 2026-08-24

Everything below cites a file:line I opened. Anything I could not confirm from the
repo is marked UNVERIFIED.

---

## Claims that CHECK OUT (stated so the builder does not re-litigate them)

- `dispatchJob` logs `err`, `jobName`, `jobId`, `durationMs` with msg `'job failed'` -
  `app/src/jobs/jobs.ts:325-333`, literal at `:332`. Correct.
- `projectErrorEvent` is a four-field allowlist (+`errorCode`) -
  `app/src/adapters/cloudwatch.ts:123-148`. Correct.
- `ErrorEventView` at `app/src/adapters/cloudwatch.ts:79-94`. Correct.
- Admin-only is SERVER-enforced: `router.use(requireRole('admin'))` at
  `app/src/routes/system.ts:45`. Correct, and correctly flagged as verified rather
  than inferred.
- The `ErrorLogs` metric filter keys on `{ $.level >= 50 }` -
  `infra/modules/observability/main.tf:56`. Alarms are message-independent. Correct.
- `logs:StartQuery` already scoped to `/hc/<env>/*` -
  `infra/modules/ec2/main.tf:288-295`; `SystemStatusInsightsResults` uses
  `resources = ["*"]` at `:296-300`. Correct.
- Nothing in `app/`, `dashboard/` or `e2e/` ASSERTS on the literal `job failed`
  (grep confirms: only `app/src/jobs/jobs.ts:332`, a comment at
  `app/src/adapters/messaging.ts:700`, `RUNBOOK.md:2169`, and two `docs/issues/`
  files). Correct as scoped.
- `app/src/index.ts:162` holds a correct UTF-8 em-dash (`E2 80 94`, confirmed via
  `cat -v`). Same at `app/src/worker.ts:530`. Section 9's source-side claim holds.
- pino is `^9.14.0` (`app/package.json:40`). The "pino 9 default err serializer"
  premise is at least version-consistent. (Runtime behavior UNVERIFIED - no
  `node_modules` in this worktree.)
- `correlationId` is always a `randomUUID()` (`app/src/lib/logger.ts:231` computes
  it from `jobRunId ?? pollRunId ?? requestId ?? bootId`; all four are
  `randomUUID()` at `app/src/lib/context.ts:72-87`, and the request middleware
  MINTS rather than honoring an inbound header -
  `app/src/middleware/correlation.ts:14`). S4's "validate as a UUID-shaped token"
  is therefore safe and will not reject legitimate ids.

---

## 1. [BLOCKING] S1 writes a raw phone number into `msg`, the field S1 declares PII-free

**What is wrong.** S4/S1 says (spec lines 101-107):

> `app/src/lib/errors.ts:141` and `:161`: fold `method` and `path` into the message
> ... a concrete path is acceptable. ... `jobName` is a registry constant and
> `method` is a fixed verb, so neither introduces PII into `msg`.

That sentence enumerates the PII-safety of `jobName` and `method` and silently
omits `path` - the one component that can carry PII. Two shipped routes put a raw
E.164 in the URL path:

- `app/src/routes/contacts.ts:2317` - `router.patch('/:contactId/phones/:phone', ...)`
- `app/src/routes/contacts.ts:2376` - `router.delete('/:contactId/phones/:phone', ...)`
- `app/src/routes/relayGroups.ts:467` - `router.delete('/conversations/:conversationId/members/:phone', ...)`

and `docs/issues/telemetry-phone-in-url-pii.md:13-16` names exactly this class.
`app/src/lib/errors.ts:141`/`:161` already log `path: req.path` as a FIELD; S1
proposes promoting it into `msg`.

**Why that matters more than the field already existing.** The spec's own posture
(section 2, line 50) is: "PII redaction remains correct at the LOG level, where the
real boundary is." Non-goal (line 226): "No change to what is WRITTEN to logs
beyond S1's message strings." S1's message strings are precisely the change that
would write a phone across the boundary the spec says stays real.

It also destroys S1's own stated rationale (spec lines 94-99): `msg` must stay "a
stable, low-cardinality string - greppable, safe to build future metric filters on,
groupable for dedup - and stays structurally free of PII." A concrete path is
unbounded-cardinality by construction.

**Implies.** Either the route TEMPLATE is mandatory (not "preferred"), or `path`
stays a field and only `method` goes into `msg`. "A concrete path is acceptable"
cannot stand.

---

## 2. [BLOCKING] "Credentials never reach CloudWatch in the first place" is not what the redact list does, and S3 renders the whole record

**What is wrong.** Section 6 (lines 243-246) and non-goal (lines 227-229) rest the
entire security argument on:

> UNCHANGED: credentials are redacted at WRITE time by pino and never reach
> CloudWatch in the first place. ... it covers `err.config.*`,
> `err.request._header` and `err.response.data`

`err.config.*` is false. `app/src/lib/logger.ts:204-223` lists THREE `err.config`
paths and no wildcard:

```
'err.config.headers.Authorization',
'err.config.headers.authorization',
'err.config.data',
```

`err.config.url`, `err.config.params`, `err.config.baseURL` and `err.config.auth`
are NOT redacted. The code says so itself at `app/src/lib/logger.ts:200-203`:

> "This is defense in depth, not the fix ... Redaction only covers the paths it is
> told about, and the next SDK will invent a new one."

And `docs/issues/telemetry-phone-in-url-pii.md:47-61` records the live consequence:

> on a transport failure the twilio SDK re-throws the raw axios error, whose
> own-enumerable `config.params` / `request` carry the full request URL and query
> params, and pino's default `err` serializer copies them into CloudWatch
> (`createLogger`'s redact list covers headers only). ... Still exposed and tracked
> here: the **purchase / messages** paths of the same driver

`app/src/adapters/messaging.ts:693-716` sanitizes only the AVAILABILITY SEARCH and
says so at `:703-705`.

S3 (spec lines 152-155) returns "the COMPLETE flattened record ... every field the
call site attached." Combined with fact 3's dot-flattening, that renders
`err.config.url`, `err.config.params`, `err.request._headers` variants the redact
list never named - the exact nests the issue says are still exposed.

**Implies.** The spec tests its guarantee against INTENT, not against MECHANISM. If
"credentials stay safe" is to remain a guarantee of this panel, S3 needs an
outbound denylist/allowlist on the flattened record (or a generic `err` serializer
that strips `config`/`request`/`response`, which the issue itself proposes at
`docs/issues/telemetry-phone-in-url-pii.md:60-61`). Otherwise the sentence must be
struck and replaced with "credential exposure is best-effort and known-incomplete."

---

## 3. [BLOCKING] S2's "relax the unparseable fallback" and S2's "preserve OOM relabeling" cannot both hold - the relaxation is a guaranteed no-op

**What is wrong.** Spec lines 135-142 say, in consecutive paragraphs:

> RELAX THE UNPARSEABLE FALLBACK ... Those are exactly the V8-heap-OOM and
> raw-stderr lines an operator most needs. Surface the raw text instead
>
> PRESERVE the existing OOM relabeling in `systemStatus.getErrors` (lines 236-240)
> ... must keep overriding the message for those two queries.

Only three queries exist (`app/src/services/systemStatus.ts:227-235`):

1. `pinoFilter` (`level >= 50` or `>= 40`) over app+worker.
2. `OOM_APP_INSIGHTS_FILTER` over app+worker.
3. `OOM_SYSTEM_INSIGHTS_FILTER` over the system group.

Query 1 structurally CANNOT return a non-JSON line. `app/src/adapters/cloudwatch.ts:57-58`
states it as a contract: "Insights parses JSON, so `level` is a field; non-JSON
lines have no `level` and are excluded (as before)."

Queries 2 and 3 are the only ones that return non-JSON lines - and both have their
`message` unconditionally overwritten at `app/src/services/systemStatus.ts:239-240`:

```
const relabeledV8    = appWorkerV8Oom.map((e) => ({ ...e, message: OOM_APP_LABEL }));
const relabeledSystem = systemOom.map((e) => ({ ...e, message: OOM_SYSTEM_LABEL }));
```

So the rows S2 relaxes the fallback FOR are exactly the rows S2 then mandates be
relabeled. Net visible change: zero. And "raw-stderr lines an operator most needs"
are not returned by any of the three filters at all, so no relaxation surfaces them.

There is also an existing assertion in the other direction:
`app/test/cloudwatch.adapter.test.ts:129-130` asserts
`expect(events[0]!.message).toBe('(unparseable log line)')`.

**Implies.** The builder is given two mutually exclusive instructions on one field.
Either the raw text becomes a NEW field (`rawText`) that survives relabeling, or a
fourth query for unparsed stderr is added, or the relaxation is dropped as
scope. As written, S2's stated benefit is undeliverable.

---

## 4. [BLOCKING] `source` has no mechanism and an incomplete domain - the third log group is never enumerated

**What is wrong.** S2 (spec line 127) defines:

> `source` - `app` or `worker`, derived from the log group the row came from.

Two defects.

**(a) There is a third log group.** `app/src/lib/config.ts:526-528`:

```
const errorLogGroupName  = `/hc/${appEnv}/app`;
const workerLogGroupName = `/hc/${appEnv}/worker`;
const systemLogGroupName = `/hc/${appEnv}/system`;
```

and `app/src/services/systemStatus.ts:234` queries `config.systemLogGroupName` for
kernel OOM-kill lines, whose rows merge into the SAME `events` array
(`:245-253`). Every kernel-OOM row has a source that is neither `app` nor
`worker`. A two-value enum forces the builder to mislabel or drop it.

**(b) The list query does not return the log group, and the spec never says to
change it.** `app/src/adapters/cloudwatch.ts:227`:

```
const queryString = `fields @timestamp, @message | filter ${filterExpr} | sort @timestamp desc | limit ${limit}`;
```

and the row loop at `:254-261` extracts ONLY `@message` and `@timestamp` before
calling `projectErrorEvent(message, ts)` - whose signature
(`app/src/adapters/cloudwatch.ts:123`) takes a raw string and a number, not a row.

Section 3 fact 6 asserts "`@log` closes that gap at zero cost", but fact 6 is
stated about the `GetLogRecord` DETAIL record (facts 3-5 describe that record).
Nothing in the spec says the LIST query's `fields` clause must gain `@log`, that
the row loop must be rewritten to pass whole rows, or that `projectErrorEvent`'s
signature and the `CloudWatchClientSeam` contract change. Fact 2 does say `@ptr`
must be listed in `fields`; the same requirement for `@log` is never stated.

**Implies.** As written the builder can deliver `ref` (fact 2 tells them how) but
has no instruction that produces `source` at all, and the enum is wrong for one of
the three queries.

---

## 5. [HIGH] S4's "sorted ASCENDING" contradicts the seam it says it reuses, and the row limit truncates the wrong end

**What is wrong.** S4 (spec lines 171-176):

> Reuses the existing `queryInsights` seam with filter `correlationId = "<id>"`,
> sorted ASCENDING ... Bounded by the same window and a row limit.

`queryInsights` hardcodes `sort @timestamp desc` (`app/src/adapters/cloudwatch.ts:227`)
and its interface doc pins that as the contract (`:100-106`): "Returns up to
`limit` events, NEWEST-FIRST." There is no sort parameter. `app/test/cloudwatch.adapter.test.ts:123`
asserts `expect(startCmd.input.queryString).toContain('sort @timestamp desc')`.

Worse than a signature gap: `limit` is applied by Insights INSIDE the descending
sort. For any correlation with more lines than the limit, the server keeps the
NEWEST N - i.e. the lines AFTER the failure. Re-sorting client-side does not
recover the ones already dropped. The spec's stated purpose (line 182) is
"everything around it" and (line 173) "the point is the lines around the failure."
The proposed mechanism delivers the opposite end of the window.

**Implies.** Either the seam gains a sort/direction parameter (which the spec does
not authorize and which the adapter test pins), or the trace route gets its own
query builder. Either way "reuses the existing seam" is false and must be
rewritten before a builder acts on it.

---

## 6. [HIGH] S4 defines no response shape, no window, no limit, and no degradation contract

**What is wrong.** S3 specifies its return payload, its degraded shape
(`{ available: false, reason }` at HTTP 200), and its coercion rule. S4 specifies
none of these. It says "reuses the existing `queryInsights` seam", which returns
`ErrorEventView[]` (`app/src/adapters/cloudwatch.ts:106`) - a projection of
`timestamp`/`level`/`message`/`correlationId`/`errorCode`.

But S4's stated purpose is INFO-level context lines, and the value of an INFO line
lives in fields the projection drops. `request received` / `request completed`
(`app/src/middleware/requestLogger.ts:31-42`, `:55-63`) carry `method`, `path`,
`statusCode`, `durationMs`, `remoteIp`; `job started` / `job succeeded`
(`app/src/jobs/jobs.ts:317`, `:320-323`) carry `jobName`, `jobId`, `hopCount`,
`durationMs`. Through `ErrorEventView` all of that vanishes and the operator gets
a list of bare `msg` strings with the level column wrong-looking.

Also missing: which window the route uses (the list route validates `since` at
`app/src/routes/system.ts:65-75`; S4 says "the same window" without saying how it
is passed or defaulted), what the row limit is, and what happens on a CloudWatch
throw or a local stack.

**Implies.** S4 is not buildable as specified. A builder will invent a shape, and
the shape they invent will most likely be the one that makes the feature useless.

---

## 7. [HIGH] Section 8's truth-up list is incomplete - it names 6 of at least 12 sites asserting the retired guarantee

**What is wrong.** Section 8 is headed "do not skip" and lists
`cloudwatch.ts:12-14`, `:116-122`, `:84-85`, `system.ts:14-18`,
`RecentErrors.tsx:1-7`, `types.ts:334-346`, plus RUNBOOK. A grep for
`PII-SAFE|PII-safe` across `app/` and `dashboard/` returns these UNLISTED sites
that assert the same retired guarantee:

- `app/src/services/systemStatus.ts:15-22` - the SERVICE header PII note ("Errors
  are projected to message + correlationId (+ timestamp/level) by the adapter").
  The spec does not touch this file's comments at all.
- `app/src/adapters/cloudwatch.ts:78` - `/** One error log event, projected to the
  PII-SAFE fields ONLY. */` (section 8 lists 84-85, not 78).
- `app/src/adapters/cloudwatch.ts:90-92` - the `errorCode` "PII-SAFE" note.
- `app/src/adapters/cloudwatch.ts:104` - the `queryInsights` seam doc, "PII-safe:
  each result row projected through projectErrorEvent."
- `app/src/routes/system.ts:63` - "recent error events (PII-safe)".
- `dashboard/src/api/endpoints.ts:2095` - "recent error events (PII-safe)".
- `app/test/cloudwatch.adapter.test.ts:7` and `:129` - a test HEADER and a test
  COMMENT stating "raw text never surfaced", attached to an assertion S2 changes.
- `dashboard/src/routes/settings/RecentErrors.test.tsx:2` and `:63` - a describe
  block literally named "available:true rendering (PII-safe)".
- `app/src/adapters/messaging.ts:700` - a comment naming the literal `'job failed'`
  that S1 renames.

**Implies.** After the build, over half the codebase's comments still promise the
guarantee the change retired. Section 8's whole purpose - "rewrite each to the new
posture, not deleted" - fails on its own enumeration.

---

## 8. [HIGH] The performance profiler's CLOSED endpoint registry is never mentioned, and a bare-UUID correlationId in a URL trips its privacy scanner

**What is wrong.** Neither S3, S4, S5 nor section 7 mentions `e2e/performance/`.
It is a closed system:

- `e2e/performance/templates.ts:151-153` declares `/api/system/flags`,
  `/api/system/alarms`, `/api/system/errors` as the ONLY system templates.
- `assertEndpointTemplate` THROWS `undeclared_endpoint_template` for anything not
  declared - `e2e/performance/redact.test.ts:174-180`.
- `e2e/performance/routes.ts:304-307` pins the exact GET contract for the System
  page, and `e2e/performance/routes.test.ts:106-109` asserts that exact list.
- `scanArtifactText` REJECTS a bare UUID as an entity id -
  `e2e/performance/redact.test.ts:207` (`['bare uuid', uuid]`), `:215-217`.

`GET /api/system/trace/:correlationId` puts a bare UUID in a URL path. Unless a
`/api/system/trace/:correlationId` template is added to `templates.ts` AND the
sanitizer templates that segment, any profiler run that observes the request
produces `unmatched_api` at best and a privacy-scan rejection at worst. Same for
`/api/system/errors/:ref`.

Per `AGENTS.md`, `npm run perf:pages` is a sanctioned entry point, so this is live
surface, not dead code.

**Implies.** Two files and one test the spec never names must change, or the
profiler's contract tests go red on a change the spec calls display-only.

---

## 9. [MEDIUM] The trace pivot cannot cross the job hop - the exact case S1 exists to serve

**What is wrong.** `app/src/lib/logger.ts:231`:

```
const correlationId = ctx.jobRunId ?? ctx.pollRunId ?? ctx.requestId ?? ctx.bootId;
```

`dispatchJob` mints a FRESH `jobRunId` per dispatch and puts it in the context
(`app/src/jobs/jobs.ts:297-305`), so a `job failed` line's `correlationId` is the
JOB RUN id. The originating request's id survives as the separate `requestId`
field (spread from `envelope.correlationContext` at `:299`). A filter of
`correlationId = "<jobRunId>"` therefore returns ONLY that job run's handful of
lines - `job started`, the handler's own lines, `job failed` - and nothing about
what enqueued it.

`RUNBOOK.md:2169` already teaches the broader technique: "the `job failed` lines
carry `jobName`, stack, and the originating request's correlation IDs" (plural).
Section 8 asks the builder to rewrite that RUNBOOK row to describe the new
affordance - which would replace a broader established practice with a narrower
automated one.

**Implies.** For the spec's motivating case, "the pivot answers everything around
it" (line 182) is false. If the pivot is to earn its name it should offer
`requestId` as well, or at minimum the spec must say the pivot is scoped to one
job run and the RUNBOOK rewrite must not delete the requestId technique.

---

## 10. [MEDIUM] The existing dedup key does not include `source` or `ref`, so the new "app or worker" answer can be wrong

**What is wrong.** `app/src/services/systemStatus.ts:244-253` dedups the merged
result on `${e.timestamp}|${e.message}|${e.errorCode ?? ''}`. Two genuinely
distinct events - one from `/hc/<env>/app`, one from `/hc/<env>/worker` - with the
same millisecond timestamp and the same `msg` collapse to ONE row today. That was
harmless while the panel made no claim about origin. S2 adds a `source` chip that
answers "app or worker" and a `ref` that opens a specific record; after the merge
the survivor's chip and pointer are whichever query's row happened to land first
in `[...appErrors, ...relabeledV8, ...relabeledSystem]`.

The same collision exists in the React key at
`dashboard/src/routes/settings/RecentErrors.tsx:127`
(`${ev.timestamp}-${ev.correlationId ?? ''}-${ev.message}`).

S1 makes this MORE likely, not less: for the Express handler, every route failure
in the same millisecond now shares a `method + path` message.

**Implies.** The dedup key must gain `source` (and ideally `ref`), and the React
key must gain `ref`. Neither is mentioned.

---

## 11. [MEDIUM] "Route template preferred, concrete path acceptable" produces two different message strings for the same failure, and the template does not identify the route

**What is wrong.** S1 line 102-104. In an app-level Express error handler
(`app/src/lib/errors.ts:137-165`, mounted last), `req.route` is:

- UNSET when the error was thrown in middleware, in the body parser, or before any
  route matched - which includes the `URIError` case the same file handles at
  `:151`;
- when SET, mount-relative. The contacts router registers
  `'/:contactId/phones/:phone'` (`app/src/routes/contacts.ts:2317`), not
  `/api/contacts/:contactId/phones/:phone`. A bare `/:id` template appears in many
  routers and identifies nothing.

So the same handler emits sometimes a mount-relative template, sometimes a full
concrete path - defeating the "stable, low-cardinality, greppable, groupable"
property S1 spends a paragraph defending (spec lines 94-99).

**Implies.** The spec must state one deterministic rule (e.g.
`req.baseUrl + req.route.path`, with an explicit fallback token like `(unrouted)`
rather than the concrete path) or the message is not a stable identifier.

---

## 12. [MEDIUM] `@ptr` is not safe as a path SEGMENT, and the validation rule the spec demands may reject real pointers

**What is wrong.** S3 mounts `GET /api/system/errors/:ref` with a 220-224 char
opaque token (fact 2) as a single path segment, and requires (spec lines 162-165)
that `:ref` be "length-bounded and character-validated before the SDK call, and a
malformed pointer must produce a clean degraded response rather than an unhandled
SDK throw."

Three problems the spec does not resolve:

- The spec never states the charset. CloudWatch `@ptr` is a base64-family token; if
  it contains `/`, the client MUST `%2F`-encode it or Express will not match a
  single `:ref` segment. If the validator forbids `/`, `+` or `=`, it rejects real
  pointers. The builder is told to validate without being told what is valid.
- A malformed `%`-escape does not reach the route at all: Express's matcher throws
  `URIError` first, and `app/src/lib/errors.ts:151-158` answers **400** with a WARN
  line. That contradicts S3's "never a 500 ... degrades like its siblings" framing,
  which assumes the route's own handler sees the input.
- S2 line 128 says the `ref` is "Never rendered." That is not the same as never
  leaving the browser: it goes into a URL, and `app/src/middleware/requestLogger.ts:34`
  logs `path: req.path` on every request. The pointer lands in CloudWatch on both
  the `request received` and `request completed` lines, and in the perf profiler's
  artifacts (see finding 8).

**Implies.** A query parameter or a POST body sidesteps all three. If the path form
is kept, the spec owes the builder a concrete charset and an explicit statement
that the URIError branch is the 400 path.

---

## 13. [MEDIUM] Section 6 misdescribes `telemetry-phone-in-url-pii` on two counts, and this change DOES touch it

**What is wrong.** Spec lines 253-255:

> DISTINCT AND UNAFFECTED: `docs/issues/telemetry-phone-in-url-pii.md` is a
> prod-gate about phone numbers in OTLP span attributes - a different sink with a
> different audience. Nothing here clears or moves that gate.

Both halves are wrong against the issue file:

1. It is NOT only about OTLP spans. `docs/issues/telemetry-phone-in-url-pii.md:21-23`:
   "**The request logger** (PRE-EXISTING): `middleware/requestLogger.ts` logs
   `req.path`, so the same phone already lands in **CloudWatch logs today**."
   And `:47-61` documents the axios `config.params`/`request` leak into CloudWatch
   on the twilio purchase/messages paths. CloudWatch is the sink this spec's panel
   renders, and S4 explicitly widens the query to ALL levels - which is where
   `request received` / `request completed` live.
2. It is NOT a prod gate. `docs/issues/telemetry-phone-in-url-pii.md:28-33`:
   "**Gate LIFTED - accepted 2026-08-15 (Cameron).** ... it is now ordinary backlog
   rather than a release gate." Status is `deferred`, not blocking.

**Implies.** The spec reassures the reader with a boundary that does not exist. The
honest statement is: this change makes the CloudWatch half of that issue directly
renderable in the dashboard, which is consistent with the accepted posture but is
NOT "unaffected."

---

## 14. [MEDIUM] The spec misdescribes the fallback it is relaxing: it fires on PARSED JSON too

**What is wrong.** S2 line 136 says `projectErrorEvent` "currently collapses any
non-JSON line to the literal `(unparseable log line)`". The code
(`app/src/adapters/cloudwatch.ts:127`, `:135-136`) initialises
`message = '(unparseable log line)'` and replaces it ONLY when `obj['msg'] ??
obj['message']` is a non-empty string. A perfectly well-formed JSON error line that
carried `event` and `err` but no `msg` renders as `(unparseable log line)` today.

**Implies.** A builder who implements the relaxation literally ("if JSON.parse
throws, surface raw text") leaves that second, silent branch intact - so a widened
projection can still show `(unparseable log line)` next to a populated `event` chip.
Given S2 explicitly adds `event`, this is a reachable and confusing combination.

---

## 15. [LOW] The spike's own facts are internally inconsistent

Fact 3 (spec lines 69-72) says "A real prod **error** record returned `err.message`,
`err.stack`, `err.type` ... alongside `correlationId`, `requestId`, `userId`,
`s3Key`, `msg`, `level`, `time`." Fact 4 (lines 73-75), describing the same record,
says "`level` was returned as the string `"30"`". pino level 30 is INFO, not
error/fatal (`dashboard/src/routes/settings/RecentErrors.tsx:29-34`,
`app/src/lib/logger.ts:49-50`).

Either the sampled record was not an error record - in which case fact 3's
`err.*` observation rests on a record whose level says otherwise - or one of the two
is misreported. The coercion requirement (fact 4) stands regardless; the confidence
the spec asks the builder to place in a single sample does not.

---

## 16. [LOW] Fact 1 generalises a retention guarantee from n=1

"@ptr SURVIVES THE FULL WINDOW ... Pointer expiry is therefore NOT a design
constraint, and no fallback retrieval path is required" (spec lines 62-65) is one
successful resolve of one pointer. AWS publishes no such guarantee that I can cite
from this repo (UNVERIFIED - no AWS access used in this review). The consequence of
being wrong is bounded (the expander degrades), but the spec should state the
degradation as the designed behavior rather than assert the constraint away.

---

## 17. [LOW] "~20 job handlers" is 13

`grep -rn "defineJobHandler(" app/src` returns 13 registrations
(`broadcastFanOut.ts:195`, `groupRail.ts:51`, `mediaMirror.ts:121`,
`missedCallAutoText.ts:161`, `relayFanOut.ts:328/608/664`, `relayNumberReady.ts:83`,
`relayWarm.ts:87`, `retrySend.ts:103`, `voiceTranscript.ts:162/252`) plus the
definition at `jobs.ts:193`. Also note `defineJobHandler(jobName: string, ...)`
(`app/src/jobs/jobs.ts:193`) - `jobName` is typed `string`, not a registry enum;
S1's "registry constant" holds by convention (all 13 call sites pass module
constants) but nothing enforces it.

The `~249 error call sites` figure checks out (248 `log.error(`/`logger.error(`).

---

## 18. [LOW] S1 misses a third shared-wrapper site in the same file, and one in `jobs.ts`

- `app/src/lib/errors.ts:151-158` - the `URIError` branch logs `method`/`path` at
  WARN with msg `'malformed URI in request — rejected as 400'`. It IS visible in
  the panel with the warnings toggle on (`app/src/routes/system.ts:77-79`,
  `PINO_WARN_INSIGHTS_FILTER` at `app/src/adapters/cloudwatch.ts:63`). S1 names
  only `:141` and `:161`.
- `app/src/jobs/jobs.ts:290` - `log.error({ err }, 'dispatchJob: malformed job
  envelope rejected')` carries no `jobName` at all.

Both already have specific messages, so the omission is cosmetic - but S1 claims to
have enumerated the structurally-affected wrappers, and it has not.

Also note this branch's message contains a NON-ASCII em-dash
(`'malformed URI in request — rejected as 400'`), which section 9 says demonstrably
does not survive the pipeline. If the builder touches that line under S1 it must be
converted; the spec's ASCII constraint (lines 108-110) applies only to lines it
adds.

---

## 19. [LOW] Truncation is specified for `errMessage` only, while S5 promises a "capped message"

S2 caps `errMessage` at 300 chars (spec lines 130-133) and says nothing about
`message` (`msg`), `errType`, `event`, or `jobName`. S5 line 191 lists the collapsed
row as carrying a "capped message", and the rejected-alternatives note (line 201)
rejects "an uncapped message in the row (one multi-KB error pushes every other row
off screen)". `msg` itself has no cap today (`app/src/adapters/cloudwatch.ts:136`
takes it whole) and S1 now appends a path to it.

Either S2's cap must cover `message` too, or S5's "capped message" is wrong.

---

## 20. [LOW] Adding a method to `CloudWatchClientSeam` is an interface break

S3 line 151 adds a `GetLogRecord` method to `CloudWatchClientSeam`
(`app/src/adapters/cloudwatch.ts:97-107`). `app/test/systemStatus.service.test.ts:41`
builds fakes from `Partial<CloudWatchClientSeam>` and so survives, but the spec
should say the new method is added to the interface and what a fake that omits it
is expected to do (`systemStatus.service.test.ts:42` casts the partial back to the
full seam). Low risk, but worth one sentence so the builder does not make the
method optional and then silently no-op it in production.

---

## Summary of what must change before a builder starts

1. Decide what `path` contributes to `msg`, given the phone-bearing routes (F1).
2. Either add an outbound filter to S3's full record or strike the credentials
   guarantee (F2).
3. Resolve relax-vs-relabel; the current pair is undeliverable (F3).
4. Specify how `source` is obtained and what the third log group maps to (F4).
5. Give S4 a sort mechanism that is not the existing seam, plus a response shape,
   window, limit and degradation contract (F5, F6).
6. Complete section 8's enumeration (F7) and add `e2e/performance/` to scope (F8).
