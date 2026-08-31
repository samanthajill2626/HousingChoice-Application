# Adversarial design review - "Error surface detail" spec (r1-a)

Spec under review: `W:\tmp\error-surface-detail\docs\superpowers\specs\2026-08-24-error-surface-detail-design.md`
Repo: `W:\tmp\error-surface-detail` (read-only; no tests, no builds, no e2e run)
Date: 2026-08-24

Every claim below cites a file:line I actually opened. Anything I could not
prove from the repo is marked UNVERIFIED.

What the spec gets RIGHT (verified, so the builder does not re-litigate it):

- `createSystemRouter` really does apply `requireRole('admin')` to every route
  (`app/src/routes/system.ts:45`). The 403-for-VA claim holds.
- The `ErrorLogs` metric filter really keys on level, not text:
  `pattern = "{ $.level >= 50 }"` (`infra/modules/observability/main.tf:56`).
  S1's message rename does not move an alarm.
- Nothing in `app/`, `dashboard/` or `e2e/` asserts on the literal `job failed`
  (grep: only `app/src/jobs/jobs.ts:332`, a comment at
  `app/src/adapters/messaging.ts:700`, `RUNBOOK.md:2169`, and
  `docs/issues/fake-twilio-messaging-attach-404.md:45`).
- `logs:StartQuery` is already scoped to `/hc/${var.env}/*`
  (`infra/modules/ec2/main.tf:288-295`), so S4 genuinely needs no new IAM.
- The logger redact list is where the spec says it is
  (`app/src/lib/logger.ts:182-226`) and `messaging.ts:693-716` is the ZIP
  sanitizer the spec describes.
- pino is `^9.14.0` (`app/package.json:40`) with no `serializers` override in
  `createLogger`, so the default `err` serializer does apply.

---

## 1. [BLOCKING] S4 cannot "reuse the existing `queryInsights` seam" - the seam hardcodes DESC and returns a 5-field projection

**What is wrong.** S4 (spec lines 169-179) says the trace pivot "Reuses the
existing `queryInsights` seam with filter `correlationId = "<id>"`, sorted
ASCENDING, across the app and worker groups, ALL levels". The seam cannot do
any of that.

**Evidence.**

- `app/src/adapters/cloudwatch.ts:227` builds the query string as a fixed
  template: `` `fields @timestamp, @message | filter ${filterExpr} | sort @timestamp desc | limit ${limit}` ``.
  The caller supplies only the filter expression. Sort direction is not a
  parameter.
- The interface docblock is a CONTRACT that says the opposite of what S4 wants:
  `app/src/adapters/cloudwatch.ts:100-106` - "Returns up to `limit` events,
  NEWEST-FIRST (Insights natively supports `sort @timestamp desc | limit N`).
  PII-safe: each result row projected through projectErrorEvent."
- `app/test/cloudwatch.adapter.test.ts:123` asserts
  `expect(startCmd.input.queryString).toContain('sort @timestamp desc')`.
- The seam's return type is `Promise<ErrorEventView[]>`
  (`app/src/adapters/cloudwatch.ts:106`), i.e. the 4-to-6 field projection -
  not the surrounding log lines S4 describes as "the lines around the failure".

**What it implies.** The builder has three unstated decisions to make: change
the seam signature (and the shared contract every other caller depends on), add
a second seam method, or reimplement the query inline in violation of the
adapter rule. The spec also never says what SHAPE a trace row is - `ErrorEventView`
has no field that would carry an INFO line's payload, and `projectErrorEvent`
defaults `level = 50` (`cloudwatch.ts:125`) for anything it cannot parse, so an
"ALL levels" trace would silently mislabel non-JSON rows as errors. This is not
a detail a builder can safely invent; it is the whole shape of S4.

---

## 2. [BLOCKING] `ref` is a 220-224 char CloudWatch `@ptr` placed in a URL PATH SEGMENT, and the spike never captured its character set

**What is wrong.** S3 (spec lines 149-165) defines
`GET /api/system/errors/:ref` where `:ref` is the raw `@ptr`. Section 3 fact 2
records "Observed length 220-224 chars, opaque" - it recorded the LENGTH and
never recorded the CHARACTER SET, which is the only fact that decides whether a
path segment is a legal transport. `@ptr` values are base64-family blobs;
a base64 payload contains `/` and `+` and `=`. A `/` cannot survive a path
segment, and `%2F` is normalised or rejected by CloudFront and by Express's
router before any handler sees it.

**Evidence.**

- Spec section 3 fact 2 (lines 66-68) - length only, no charset.
- Spec section 4, S3 VALIDATION (lines 162-165) bounds LENGTH and characters
  but frames it purely as an injection control, never as a transport question.
- The repo already knows what a bad %-escape in a path does:
  `app/src/lib/errors.ts:147-158` catches `URIError` from Express's route
  matcher ("A malformed %-escape in the URL path/params makes Express's route
  matcher throw URIError (decodeURIComponent) BEFORE any handler runs") and
  answers 400. So a percent-encoded pointer that any hop re-encodes lands in a
  400-warn path, not in the degraded `{ available: false }` S3 promises.
- The stack sits behind CloudFront with an origin-secret validator in the locked
  middleware order (AGENTS.md, "Preserve the locked Express middleware order"),
  so there is at least one normalising hop between the browser and Express.

(The `+`/`/`/`=` charset of `@ptr` is high-confidence from the base64 shape but
is UNVERIFIED in this repo - the spec is the only source that saw a real value,
and it did not write the value down.)

**What it implies.** The expander fails, non-deterministically, for whatever
fraction of pointers contain a `/`. The fix is one line of design - carry `ref`
as a query parameter (`GET /api/system/errors?ref=...`) or a POST body - but it
must be decided in the spec, because S5's UI, the perf endpoint template
(finding 9) and the route test all encode the choice. Note that the query-param
form also lands the value in the existing `?since=`-style ledger the perf
harness already understands, rather than minting a new path template.

---

## 3. [HIGH] `source: 'app' | 'worker'` cannot represent the THIRD log group the panel already merges

**What is wrong.** S2 (spec line 127) declares `source` as "`app` or `worker`,
derived from the log group the row came from". `getErrors` queries THREE log
groups and merges all three into one list.

**Evidence.**

- `app/src/lib/config.ts:526-528`:
  ```
  const errorLogGroupName = `/hc/${appEnv}/app`;
  const workerLogGroupName = `/hc/${appEnv}/worker`;
  const systemLogGroupName = `/hc/${appEnv}/system`;
  ```
- `app/src/services/systemStatus.ts:234` issues the kernel-OOM query against
  `config.systemLogGroupName`, and `:245` merges its rows
  (`relabeledSystem`) into the same `events` array the panel renders.
- Spec section 3 fact 6 (lines 79-81) states the gap as "The panel merges
  `/hc/<env>/app` and `/hc/<env>/worker` today" - which is only two of the three
  groups the service actually reads.

**What it implies.** Every kernel OOM-kill row must be labelled with a value
outside the declared enum. A builder will either widen the enum without
authority, or mislabel `/hc/<env>/system` rows as `app`, which is a factual lie
on the exact rows an operator is most likely to be paging on. The enum must be
`'app' | 'worker' | 'system'` (or carry an explicit unknown), and S5's chip must
render the third value.

---

## 4. [HIGH] S2's "relax the unparseable fallback" is unreachable by every query the panel runs, and S2's own OOM-preservation clause is what makes it unreachable

**What is wrong.** S2 (spec lines 135-138) orders: "RELAX THE UNPARSEABLE
FALLBACK ... Those are exactly the V8-heap-OOM and raw-stderr lines an operator
most needs. Surface the raw text instead". Ten lines later (139-142) it orders
the opposite outcome: "PRESERVE the existing OOM relabeling ... must keep
overriding the message for those two queries." Both cannot deliver the stated
benefit.

**Evidence.**

- Non-JSON lines are EXCLUDED from the pino query by construction.
  `app/src/adapters/cloudwatch.ts:57-58`: "Insights parses JSON, so `level` is a
  field; non-JSON lines have no `level` and are excluded (as before)."
  `PINO_ERROR_INSIGHTS_FILTER = 'level >= 50'` (`:59`);
  `PINO_WARN_INSIGHTS_FILTER = 'level >= 40'` (`:63`). The `includeWarnings`
  toggle widens the threshold, not the JSON-ness.
- The ONLY non-JSON rows that reach the list are from the two `@message like`
  OOM queries (`cloudwatch.ts:65-67`, used at `systemStatus.ts:233-234`).
- Those rows' `message` is unconditionally overwritten before render:
  `app/src/services/systemStatus.ts:239-240`
  ```
  const relabeledV8 = appWorkerV8Oom.map((e) => ({ ...e, message: OOM_APP_LABEL }));
  const relabeledSystem = systemOom.map((e) => ({ ...e, message: OOM_SYSTEM_LABEL }));
  ```
  The existing comment at `:237-238` says so explicitly: "never from the raw log
  text (which projectErrorEvent already collapses to '(unparseable log line)' for
  kernel/V8 OOM lines)".

**What it implies.** Two things, both bad. (a) The relaxation buys the list
nothing while retiring the "never surface raw text" property - a pure cost. If
the operator is supposed to reach OOM raw text via S3's detail record, say that,
and leave `projectErrorEvent`'s fallback alone. (b) The one case the relaxation
DOES change is unenumerated and unbounded: a line that parses as JSON but
carries no `msg`/`message` currently degrades to `(unparseable log line)`
(`cloudwatch.ts:126, 135-136`); under the relaxation it dumps the ENTIRE raw
JSON line into `message` - every field the call site attached, uncapped by the
300-char `errMessage` cap S2 designed specifically to stop multi-KB rows
(spec lines 130-133). The spec's own truncation rationale argues against its own
relaxation.

---

## 5. [HIGH] Section 6's credential guarantee is an absolute the codebase explicitly disclaims - and it names `err.message` as the SAFE field when the repo's adjudicated position is that `err.message` is the untrusted one

**What is wrong.** Section 6 (spec lines 243-246) states: "UNCHANGED:
credentials are redacted at WRITE time by pino and never reach CloudWatch in the
first place. Widening the projection does not reopen that - the redact paths
target the vendor-SDK nests that carry `Authorization` headers and form bodies,
and not `err.message`." Section 5 (lines 227-229) repeats it. The phrase "not
`err.message`" is offered as reassurance. In this repo it is the warning label.

**Evidence.**

- `app/src/lib/errors.ts:26-36` - the `ErrorSummary` docblock, an adjudicated
  decision (fix wave 2, adversarial 10 / conformance F7):
  > "NO `message` ... The adjudicated allowlist is (name, code, status).
  > `message` is the one field the vendor authors freely - Twilio's
  > address/validation family echoes the offending parameter into it ("The 'To'
  > number +1555... is not a valid phone number") - so a summary that carried it
  > could not honestly claim nothing raw leaves."
- `app/src/lib/logger.ts:194-199` - redaction is explicitly NOT the guarantee:
  > "This is defense in depth, not the fix: a call site that can receive a
  > vendor error must log `summarizeError(err)` (lib/errors.ts) rather than the
  > error object. Redaction only covers the paths it is told about, and the next
  > SDK will invent a new one."
- `app/src/lib/errors.ts:44-49` says the same from the other side: "The logger's
  `redact` list cannot save us there: the paths do not match and pino's redact
  is case-sensitive."

**What it implies.** The human's decision in section 2 (PII in the panel is
acceptable) covers the PHONE NUMBER in `err.message` - fine. It does NOT cover
CREDENTIALS, and section 6 is the only place the spec reasons about credentials.
Its reasoning is wrong: "never reach CloudWatch in the first place" is a
best-effort property that holds only for the exact paths listed at
`logger.ts:182-226`, by the repo's own statement. A builder who reads section 6
will conclude no further control is needed and render whatever is there. The
spec must either (a) restate the posture honestly ("credentials are redacted on
a BEST-EFFORT path list; the panel may therefore render an unredacted credential
from an SDK path not yet on that list") and accept it, or (b) put a field
allowlist/denylist on the S3 response. Right now it does neither because it
believes a guarantee that does not exist.

---

## 6. [HIGH] S3 returns "every field the call site attached" plus the raw line, uncapped - which renders exactly the axios nests the write-time sanitizers were built to keep out, and the redact list does not cover them

**What is wrong.** S3 (spec lines 153-155): "Returns the COMPLETE flattened
record: full `err.message`, `err.stack`, `err.type`, every field the call site
attached, plus `@log`, `@logStream`, `@ingestionTime`, and the raw `@message`."
No cap, no allowlist, no denylist. Section 6 (lines 248-251) simultaneously
promises "STILL TRUE: the log-level sanitizers remain correct and must not be
weakened", citing the ZIP sanitizer.

**Evidence.**

- `app/src/adapters/messaging.ts:693-706` - the sanitizer the spec cites, and
  what it says about the nests S3 will render:
  > "the twilio SDK re-throws the RAW axios error, whose own-enumerable `config`
  > and `request` carry the full request URL and query params - which now include
  > the property ZIP (InPostalCode). Pino's default err serializer copies those
  > verbatim ... (Only the SEARCH is sanitized here; the purchase path's
  > pre-existing exposure stays tracked in
  > docs/issues/telemetry-phone-in-url-pii.md.)"
  That parenthesis is the point: ONE call site was sanitized. The rest still
  write those nests.
- The redact path list (`app/src/lib/logger.ts:186-224`) covers
  `err.config.headers.Authorization`/`authorization`, `err.config.data`,
  `err.request._header(s)`, `err.response.data` and their `err.response.config.*`
  twins. It does NOT cover `err.config.url`, `err.config.params`, or
  `err.config.auth` (axios's alternative credential carrier). So those are at
  rest, unredacted, and S3 will render them.
- S2 caps `errMessage` at 300 chars "because a `RestException` or
  `AggregateError` can carry multi-KB text" (spec lines 130-133). S3 has the
  same exposure - a full `@message` was 799 chars in the spike's SAMPLE (spec
  line 76-77), which is one observation, not a bound - and no cap at all.

**What it implies.** S3 is the surface that actually reopens the write-time
sanitizers, and the spec asserts it does not. At minimum the spec must name a
response size bound and decide, explicitly, whether `err.config.*` /
`err.request.*` are rendered or dropped. The phrase "every field the call site
attached" is not a specification; it is an abdication.

---

## 7. [MEDIUM] The existing merge/dedup key silently collapses rows that the new `source` chip is supposed to distinguish

**What is wrong.** S2 adds `source` and `ref` but says nothing about the dedup
that runs immediately after projection, so the new fields do not participate in
row identity.

**Evidence.** `app/src/services/systemStatus.ts:244-253`:
```
const key = `${e.timestamp}|${e.message}|${e.errorCode ?? ''}`;
```
The existing comment at `:241-243` explains why `errorCode` was ADDED to the key
("so two distinct-code failures at the same instant both survive rather than
collapsing on timestamp+message") - the same argument now applies to `source`.
The app and worker groups are queried in ONE multi-group call
(`systemStatus.ts:232`), so two processes logging the same message in the same
millisecond are already in the same result array.

**What it implies.** The surviving row's `app`/`worker` chip is decided by array
order, not by fact - on the very gap section 3 fact 6 (spec lines 79-81) says
`source` closes. Adding `ref` to the key would also fix it (pointers are unique
per event) and would fix the React key in finding 10 at the same time. The spec
must say which.

---

## 8. [MEDIUM] The list path reads NESTED `err.message`; the detail path reads a FLATTENED `err.message` key. The spec states only the flattened form.

**What is wrong.** Section 3 fact 3 (spec lines 69-72) is the spec's only
statement about the error shape: "GetLogRecord FLATTENS NESTED JSON with dot
notation. A real prod error record returned `err.message`, `err.stack`,
`err.type` as separate top-level keys". S2 then says `errType` comes "from
`err.type`" and `errMessage` "from `err.message`" (spec lines 126-127) without
distinguishing which path it means.

**Evidence.** The list path does not go through GetLogRecord at all. It parses
the raw Insights `@message` string:
`app/src/adapters/cloudwatch.ts:130` `const parsed: unknown = JSON.parse(rawMessage);`
then reads flat keys off the object (`:133-142`). In that object `err` is a
NESTED object written by pino's `err` serializer - `obj['err.message']` is
`undefined`, `(obj['err'] as ...)['message']` is the value.

**What it implies.** A builder who takes fact 3 at face value implements
`obj['err.message']` in `projectErrorEvent`, gets `undefined`, and ships a panel
where `errType`/`errMessage` are permanently blank in the deployed environment -
which is the ONLY environment where the panel has data (the hermetic e2e lane
degrades to `unavailable_local`, `systemStatus.ts:212-214`), so no gate catches
it. The spec must state both accessor shapes.

---

## 9. [MEDIUM] Unenumerated surface: the e2e performance harness holds a CLOSED endpoint allowlist and a per-route GET contract that two new routes violate

**What is wrong.** The spec's testing section (7) names app unit tests, a
`RecentErrors` component test, and one e2e System Status spec. It never mentions
the performance harness, which encodes the app's HTTP surface as data in three
places that must all change together.

**Evidence.**

- `e2e/performance/templates.ts:19-164` - `ENDPOINT_TEMPLATES` is a frozen,
  closed list including `'/api/system/flags'`, `'/api/system/alarms'`,
  `'/api/system/errors'` (`:151-153`). `assertEndpointTemplate`
  (`templates.ts:172-174`) throws `undeclared_endpoint_template` for anything
  not in it.
- `e2e/performance/routes.ts:303-306` - `SYSTEM_GETS` enumerates exactly the
  GETs the system surface may issue:
  `required('/api/settings'), required('/api/system/flags'), required('/api/system/alarms'), required('/api/system/errors', ['since'])`.
  Note `['since']` is the ALLOWED query-key list - a query-param `?ref=` form
  (finding 2) would need it extended.
- `e2e/performance/routes.test.ts:107-108` asserts that exact list.
- `e2e/performance/redact.ts` scans captured artefacts for `uuid` and other
  identifier classes and fails the run on a hit; `redact.test.ts:37` is the
  system-errors entry in that ledger. S4 puts a UUID-shaped `correlationId` in a
  URL PATH - directly in the artefact text the `uuid` detector
  (`redact.ts` DETECTORS, `['uuid', /\b[0-9a-f]{8}-.../]`) scans.

**What it implies.** The perf harness is a sanctioned gate (`npm run perf:pages`,
AGENTS.md). Two undeclared endpoints will either throw
`undeclared_endpoint_template` or trip the privacy scanner, depending on whether
the profiler's walk reaches the expander. The spec must list these three files
as touched surfaces, and finding 2's transport decision must be made with the
`uuid`-in-artefact detector in view.

---

## 10. [MEDIUM] `ref` never reaches the row key, and S2's truncation makes the existing React key MORE collision-prone at the exact moment S5 adds per-row state

**What is wrong.** S5 (spec lines 188-198) adds an expander with per-row state
but says nothing about row identity.

**Evidence.** `dashboard/src/routes/settings/RecentErrors.tsx:127`:
```
key={`${ev.timestamp}-${ev.correlationId ?? ''}-${ev.message}`}
```
S2 truncates the rendered message to 300 characters (spec lines 130-133), so two
distinct long errors sharing a timestamp and correlationId now share a key
prefix and therefore a key.

**What it implies.** React reuses the component instance across a refresh, so
expansion state (and the fetched detail record) mis-associates to the wrong row.
`ref` is already unique per event and is already on the wire - key on it. The
spec should say so, since it explicitly says `ref` is "Never rendered"
(spec line 128) and a builder may read that as "never used in the view layer".

---

## 11. [MEDIUM] S1's Express half is under-enumerated: two branches log the SAME string, and a THIRD warn-level line carrying the same `method`/`path` is not mentioned

**What is wrong.** S1 (spec lines 101-104) names "`app/src/lib/errors.ts:141`
and `:161`". `:141` is the log-OBJECT line of one branch and `:161` is the
log-object line of the other; the spec never notices that the two branches emit
an IDENTICAL message string, nor that a third handler line exists.

**Evidence.** `app/src/lib/errors.ts:137-164`:
- `:140-143` - headers-already-sent branch, `'unhandled error while handling request'`
- `:151-157` - `URIError` branch, `log.warn(...)`,
  `'malformed URI in request - rejected as 400'`, carrying the same
  `method: req.method, path: req.path`
- `:159-162` - normal branch, `'unhandled error while handling request'` (the
  same literal as `:143`)

**What it implies.** Three things. (a) Folding `method`/`path` into the message
leaves the two error branches still indistinguishable in the panel, which is
exactly the problem S1 exists to fix - the headers-sent branch is a materially
different failure and should say so. (b) The warn branch surfaces in the panel
whenever `includeWarnings` is on (`app/src/routes/system.ts:77-79`), so it is a
row an operator sees, and it is not covered. (c) That warn string contains a
literal em-dash (U+2014) in source - the exact non-ASCII the spec's own section 9
says does not survive the pipeline, and the exact rule S1's CONSTRAINT (spec
lines 108-109) invokes. If S1 is touching this handler's strings at all, this
line is in scope by the spec's own constraint.

---

## 12. [MEDIUM] The S4 trace link is structurally dead on the OOM rows - the rows the panel synthesises specially - and S5 states no null branch

**What is wrong.** S5 (spec line 192) lists "`correlationId` rendered as the
trace link" in the collapsed row with no null case.

**Evidence.** Kernel and V8 OOM lines are non-JSON, so `projectErrorEvent`'s
`JSON.parse` throws and `correlationId` stays `null`
(`app/src/adapters/cloudwatch.ts:127, 144-146`). Those rows are precisely the
ones `systemStatus.ts:239-240` relabels and merges. The current component
already guards this (`RecentErrors.tsx:52`
`{event.correlationId !== null ? ... : null}`); the spec does not carry the
guard forward.

**What it implies.** Either a builder drops the existing guard and renders
`/api/system/trace/null`, or the spec's "what led up to it" affordance is
silently unavailable on OOM rows and the spec never says so. State it: the trace
pivot requires a correlationId and is absent without one.

---

## 13. [LOW] Section 3 fact 1 promotes a single observation into a guarantee and then uses that guarantee to delete a fallback

**What is wrong.** Spec lines 62-65: "`@ptr` SURVIVES THE FULL WINDOW. A pointer
for a 2026-08-17 event resolved successfully on 2026-08-24 ... Pointer expiry is
therefore NOT a design constraint, and no fallback retrieval path is required."
One pointer, one age, against an AWS lifetime the spec does not cite. "Therefore"
does not follow from n=1.

**What it implies.** The blast radius is bounded (S3 degrades to
`{ available: false, reason }`, spec line 156), so this is LOW - but the wording
is a slogan sitting in a section titled "Verified facts", and section 5 leans on
it to declare a non-goal. Restate as: pointer expiry is not designed around; an
expired pointer degrades like any other CloudWatch failure.

---

## 14. [LOW] S6 defaults the new IAM action to the PERMISSIVE branch while telling the builder to verify

**What is wrong.** S6 (spec lines 209-214) says place `logs:GetLogRecord` with
`SystemStatusInsightsResults` (`resources = ["*"]`) "unless the builder confirms
otherwise", then says "BUILDER MUST VERIFY this before committing".

**Evidence.** `infra/modules/ec2/main.tf:288-295` (`SystemStatusInsightsStart`)
scopes to `/hc/${var.env}/*`; `:296-299` (`SystemStatusInsightsResults`) is the
`["*"]` statement. The inline comment at `:282-287` shows the repo's stated
preference: scope where scopable, `"*"` only where AWS forbids scoping.

**What it implies.** The spec's default is the branch that is wrong if the
verification comes back "scopable", and a builder under time pressure takes the
default. Invert it: default to the scoped statement, fall back to `["*"]` only
on a cited Service Authorization Reference entry. (Whether `logs:GetLogRecord`
supports resource-level permissions: UNVERIFIED - not determinable from this
repo.)

---

## 15. [LOW] Section 3 fact 2 is self-contradictory, and no section says the seam's row loop must be extended

**What is wrong.** Spec line 66: "`@ptr` is returned automatically when listed in
the Insights `fields` clause." Automatic and explicitly-listed are two different
mechanisms; the builder cannot tell from this sentence whether
`fields @timestamp, @message` (`app/src/adapters/cloudwatch.ts:227`) needs
editing.

**Evidence.** Separately, the seam's result loop reads exactly two cells and
discards the rest:
`app/src/adapters/cloudwatch.ts:257-261` - `if (cell.field === '@message') ...`
/ `if (cell.field === '@timestamp') ...`. `@ptr` and `@log` will be silently
dropped there even if Insights returns them. No section of the spec mentions
this loop.

**What it implies.** Small, but it is the single line where both new list fields
are actually plumbed, and the spec's only sentence about it is ambiguous.

---

## 16. [LOW] `@log` is not the log group NAME, and the spec gives no mapping rule or unknown-group fallback

**What is wrong.** Section 3 fact 6 (spec lines 79-81): "`@log` NAMES THE LOG
GROUP". In Insights, `@log` is an identifier of the form
`<accountId>:<logGroupName>`, not a bare name.

**Evidence.** The spec's fact 6 does not quote the value it observed - it
asserts the interpretation instead. The mapping target is
`config.errorLogGroupName` / `workerLogGroupName` / `systemLogGroupName`
(`app/src/lib/config.ts:526-528, 1290-1292`), which are bare names.
(The `<accountId>:` prefix form is UNVERIFIED against this account in this
review; the spec's own evidence is insufficient to rule it in or out, which is
itself the finding.)

**What it implies.** S2's `source` derivation needs a stated normalisation
(strip everything up to the last `:`) and a stated fallback for a group name
that matches none of the three - which, with finding 3, is where a fourth log
group would land silently.

---

## 17. [LOW] Section 8's "do not skip" doc list is itself incomplete

**What is wrong.** Section 8 (spec lines 276-288) lists the comments and
`RUNBOOK.md` that assert the retired guarantee, but the `job failed` string it
renames in S1 is also quoted as a live CloudWatch signature elsewhere.

**Evidence.** `docs/issues/fake-twilio-messaging-attach-404.md:45` quotes
`` `RestException [HTTP 404] Failed to execute request` - `"msg":"job failed"` ``
as the Insights signature to search for. After S1 that literal no longer
matches.

**What it implies.** Trivial to fix, but section 8 is written as an exhaustive
checklist ("do not skip"), and an exhaustive checklist that is not exhaustive
teaches the builder to stop looking.

---

## Cross-cutting note (not a numbered finding)

The spec's non-goals are clean and I am not proposing anything additive against
them. Findings 2, 3, 4, 6 and 8 are all cases where the spec's DECISIONS are
sound but its stated MECHANISM cannot execute them against the code as it
stands. None of them requires re-opening the human's PII decision in section 2.
Finding 5 is the exception: it does not change the decision, but the reason
given for the decision's safety is a guarantee the repo explicitly disclaims,
and that reason is load-bearing for what S3 renders.
