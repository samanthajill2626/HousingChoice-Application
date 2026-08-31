# Adversarial review - feat/error-surface-detail @03a3e2ed

Scope: the diff package plus a whole-tree sweep for other readers/writers of every
route, type, query, invariant and log string this branch touches. Evidence is against
the CURRENT worktree (W:\tmp\error-surface-detail). Read-only; nothing was edited.

Tests actually run (all green, so none of the findings below are "the suite already
knows"):

```
cd W:\tmp\error-surface-detail\app
npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts \
                test/expressErrorHandler.test.ts test/jobs.test.ts
-> 4 files passed, 102 tests passed
```

Plus one throwaway `node -e` reimplementation of `enforceBound` (finding S2) to
measure the real output size. No docker, no e2e, no db:start.

---

## MUST-FIX

None. I did not find a defect I can prove breaks a caller, leaks a credential, or
corrupts state on the current tree. The four items below are ranked SHOULD-FIX
because each is either a stated contract the code does not keep, or an invariant the
feature's correctness rests on that nothing in the tree establishes.

---

## SHOULD-FIX

### S1. The trace's two windows leave a one-second hole that can swallow the anchor line - and the whole design rests on an AWS semantic nothing here pins

`app/src/adapters/cloudwatch.ts:662-683`

```ts
const anchorSec = Math.floor(atMs / 1000);
...
runInsights(groups, `... sort @timestamp desc | limit 25`, startSec, anchorSec, ...),
runInsights(groups, `... sort @timestamp asc  | limit 25`, anchorSec + 1, endSec, ...),
```

The comment asserts: "Insights `endTime` is INCLUSIVE (measured), so giving BEFORE the
anchor's whole second guarantees the anchor line is present ... Do NOT use ceil here."

That guarantee holds only if CloudWatch treats `endTime: T` (epoch **seconds**) as
covering the whole second `T.000-T.999`. If it treats it as the instant `T*1000` ms -
which is the plain reading of "the specified end time is included" - then:

- BEFORE covers `[startSec*1000, anchorSec*1000]`
- AFTER covers `[(anchorSec+1)*1000, endSec*1000]`
- **Nothing covers `(anchorSec*1000, (anchorSec+1)*1000)`** - a 999 ms hole centred on
  the failure.

Concrete walk. A job fails at `2026-08-24T10:00:00.500Z` (`atMs` = ...500).
`anchorSec` = the whole second `10:00:00`. BEFORE ends at `10:00:00.000`; AFTER starts
at `10:00:01.000`. The anchor line at `.500` is in neither. Every line the failing hop
emitted in that same second - typically the densest, most diagnostic moment - is
dropped too. The UI then renders a timeline with a gap and **no** "this failure"
marker, because `ErrorTrace.tsx:54,59` marks the anchor by exact string equality
`l.timestamp === at` and no returned line has that timestamp. Since only whole-second
failures (1 in 1000) are safe under the pessimistic reading, this would be the normal
case, not an edge case.

Why the test cannot catch it: `app/test/cloudwatch.adapter.test.ts:557-566` asserts
only the *numbers the adapter passes* (`before.endTime === floor(atMs/1000)`,
`after.startTime === floor+1`). It asserts the arithmetic, never AWS's interpretation
of it - a fake `send()` has no window semantics at all.

The tree also contains the opposite assumption 60 lines up: `queryInsights` uses
`Math.ceil(Date.now() / 1000)` for its `endTime` (`cloudwatch.ts:611`), i.e. it rounds
*up* to avoid losing the current partial second. Two paths in one file encode
contradictory beliefs about the same parameter, and only one of them can be right.

Cheapest close: make the two windows deliberately overlap by one second
(`before.endTime = anchorSec`, `after.startTime = anchorSec`) and dedup the merge on
`@ptr` - the same identity the row list already trusts (`systemStatus.ts:309`). That
is correct under *both* readings, at the cost of a dedup rule the current comment says
it is avoiding. Alternatively, record the measurement that justified `floor` somewhere
a future reader can check it.

### S2. `enforceBound` does not enforce the bound it names - measured 104,291 bytes against a declared 65,536

`app/src/adapters/cloudwatch.ts:176-185`

```ts
for (const key of keys) {
  if (Buffer.byteLength(JSON.stringify(fields), 'utf8') <= RESPONSE_BOUND_BYTES) break;
  fields[key] = fields[key]!.slice(0, 512);
}
return true;
```

The loop visits each key at most once and only ever shortens to 512 chars. Once every
key is already <= 512 there is nothing left to trim, so the function returns `true`
("truncated") while the payload is still over budget. I ran the exact algorithm:

```
200 fields x 2000 chars -> before 401,891 B, after 104,291 B,
responseTruncated = true, within RESPONSE_BOUND_BYTES = false
```

The break-even is ~128 surviving fields longer than 512 bytes (128 x 512 = 65,536).
The true ceiling is CloudWatch's 256 KB max log-event size, so the declared 64 KiB
bound can be overshot ~4x. `RESPONSE_BOUND_BYTES` is documented at
`cloudwatch.ts:158-159` as "Detail response bound in BYTES", and
`LogRecordView.responseTruncated` (`:206-207`) is documented as "True when `fields` had
to be trimmed **to fit**" - both claims are false in this case.

The adapter test that looks like it covers this
(`app/test/cloudwatch.adapter.test.ts:496-506`) uses a **single** oversized field, the
one shape where one pass does converge, and then asserts
`byteLength(...) <= RESPONSE_BOUND_BYTES`. It pins the happy shape, not the bound.

Fix is a loop-until-converged (re-trim at a smaller cap, or drop remaining keys) or an
honest rename of the constant to "trim trigger". Note also (F3 below) that `rawText`
bytes are outside this accounting entirely.

### S3. The `err` allowlist is not the by-construction guarantee its own docblock claims - everything outside the `err.` prefix is admitted, and bare `err` is admitted unconditionally

`app/src/adapters/cloudwatch.ts:167-173`

```ts
function isAllowedKey(key: string): boolean {
  if (key === 'err') return true;                        // scalar err: the message itself
  if (key.startsWith('err.')) return ERR_ALLOWLIST.includes(key);
  if (DROPPED_KEYS.has(key)) return false;
  if (DROPPED_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;                                           // app-authored field
}
```

The docblock at `:138-150` says the allowlist "closes the class by construction,
including nests nobody has met" and that "a vendor SDK error nest cannot carry an auth
header or a signed URL out through it" (`:20-22`). Both statements are scoped to the
`err.` prefix only. Two openings:

1. **Any other key name.** `log.error({ response: axiosErr.response })` or
   `{ error: vendorErr }` flattens (GetLogRecord returns dot-flattened keys) to
   `response.config.headers.Authorization` / `error.config.headers.Authorization`,
   which hits `return true` on line 172. Write-time redaction does not cover it
   either - `app/src/lib/logger.ts:183-224` names only `headers.*`, `req.headers.*`
   and eight literal `err.*` paths. So both layers miss simultaneously.
   *Reachability today: none that I could find.* I swept every `log.error/warn/fatal`
   in `app/src` for an error-shaped value under a non-`err` key; the only hits are
   `app/src/routes/api.ts:1326` (`error: outcome.error`) and
   `app/src/jobs/rosterActions.ts:581` (`error: added.refusal.error`), both **string**
   refusal codes. So this is latent, not live - but it is exactly the failure mode the
   docblock says is impossible, and the next call site that logs `{ e }` opens it.

2. **Bare `err`.** Line 168 admits `err` with no inspection of its value. The comment
   justifies it as "the scalar err: the message itself". If CloudWatch ever hands back
   `err` unflattened (a JSON string) because of a nesting-depth or field-count limit on
   discovery, that one key carries the entire error object - `config.headers.
   Authorization` included - straight to the admin UI, past the allowlist that exists
   to stop precisely that. I could not establish CloudWatch's flattening limits from
   the tree, and the test at `cloudwatch.adapter.test.ts:424-431` only feeds a scalar
   string, so the seam-vs-fake gap is unexamined.

Both are closed by one guard: admit bare `err` only when its value does not parse as a
JSON object, and state the `err.`-prefix scope in the docblock instead of claiming the
class is closed.

### S4. The old dedup is now inert, and the test that guards it passes for the wrong reason

`app/src/services/systemStatus.ts:303-313`

```ts
const key = `${e.ref}|${e.timestamp}|${e.message}|${e.errorCode ?? ''}`;
```

The comment concedes "with a ref present they never decide". Since `ref` is unique per
log event, the merge now deduplicates nothing that it used to. Two consequences:

- **Panel capacity.** N identical error lines emitted inside the same millisecond used
  to collapse to one row; they now occupy N of the 25 slots
  (`ERROR_EVENT_LIMIT`, `systemStatus.ts:62`, applied at `:315`) and can push older,
  *distinct* errors off the panel. Whether that is desired is a product call - but it
  is a behaviour change the commit message ("dedup error rows on the log-event
  pointer") does not read as.
- **A test that no longer tests its name.** `app/test/systemStatus.service.test.ts:424`
  is titled *"deduplicates OOM events that have the same timestamp+label"*. Its fixture
  (`:425`) gives both the pino-query and OOM-query copies the **same** `ref` (`PTR-8`),
  so it now exercises ref-dedup exclusively. Change `PTR-8` to two distinct pointers
  and the assertion `toHaveLength(1)` fails - i.e. the guard against same-timestamp
  duplicate rows is gone and nothing reports it.

Either rename/retire that test to match what the code now guarantees, or keep a
timestamp+message fallback for rows whose `ref` differs but whose identity does not.

---

## CONSIDER

### C1. `key={ev.ref}` assumes an invariant the service does not provide

`dashboard/src/routes/settings/RecentErrors.tsx:283-287` keys each row on `ev.ref`,
with the comment "ref ... is unique per event and stable across queries".

The *service* does not guarantee uniqueness within one response. The dedup key
(`systemStatus.ts:309`) includes `message`, and the OOM relabel at
`systemStatus.ts:297-298` rewrites `message` - so one log event returned by **both**
the pino query and the V8-OOM query survives twice with the *same* `ref` and different
messages. React then sees duplicate keys and can bind an `ErrorRow`'s `open` /
`detail` state to the wrong row across a refresh.

Reachability is thin but constructible: it needs a JSON pino line at `level >= 50`
whose raw `@message` also matches `/JavaScript heap out of memory/` or
`/Reached heap limit/` (`cloudwatch.ts:74`) - e.g. a handler that catches and logs
text quoting an OOM. Separately, `projectErrorEvent` defaults `ref` to `''`
(`cloudwatch.ts:359`, `ptr = ''`), so any response in which `@ptr` were absent
collapses every row onto the key `''`.

Cheap fix: `key={`${ev.ref}|${ev.timestamp}|${ev.message}`}` (or the array index),
which costs nothing and removes the dependency on a cross-layer invariant.

### C2. `useErrorDetail` / `useErrorTrace` do not abort on unmount, and the hook file documents two behaviours it does not have

`dashboard/src/routes/settings/useSystemStatus.ts:253-320`

Both new hooks create an `AbortController` per `load()` and abort the *previous* one,
but neither registers an unmount cleanup. Compare `useSystemFlags` (`:70`),
`useSystemAlarms` (`:126`) and `useSystemErrors` (`:218`), which all
`return () => abortRef.current?.abort()`.

Walk: an operator clicks **Trace**, then clicks it again before the response lands.
`ErrorTrace` unmounts (`RecentErrors.tsx:209-211` gates it on `tracing`), taking the
hook instance and its `abortRef` with it. The in-flight fetch is never cancelled; it
runs to completion, and its `.then` calls `setResult`/`setStatus` on a dead component
(a no-op in React 18, so no visible bug - just a wasted request and, on the server, a
completed pair of Insights queries nobody will read).

Two doc claims are contradicted by the code:

- `:13-16` "Each uses an AbortController + a cancelled/abort guard ... **an unmount**
  or a superseding fetch never sets state." - the unmount half is not implemented for
  these two.
- `:248-250` "Both carry an `abortRef` ... so **a second row supersedes the first in
  flight** instead of racing it into state." - false by construction:
  `RecentErrors.tsx:148` calls `useErrorDetail()` *inside* `ErrorRow`, so every row
  owns an independent hook and an independent `abortRef`. Opening row B cannot
  supersede row A's request. (The behaviour is fine - each row renders its own result -
  but the stated mechanism does not exist, which will mislead the next reader.)

### C3. Trace clicks are an unmetered CloudWatch Logs Insights spend, reachable by a top-level cross-site GET

`app/src/routes/system.ts:114-128` -> `systemStatus.ts:350-370` -> `cloudwatch.ts:680-683`

Each `/api/system/trace` request starts **two** `StartQuery` executions scanning up to
35 minutes (`BRACKET_WIDE_MS` + `BRACKET_AHEAD_MS`, `cloudwatch.ts:257-261`) across
both process log groups, and Insights bills per GB scanned regardless of match count.
There is no rate limiting on `/api/system` (only `requireRole('admin')` at
`system.ts:53`), and no caching (`infra/modules/cloudfront/main.tf:193-194` uses the
`caching_disabled` cache policy for the API behaviour).

The session cookie is `sameSite: 'lax'` (`app/src/middleware/auth.ts:54,64`;
`app/src/routes/auth.ts:153`), which **is** sent on a top-level cross-site GET
navigation. So a link an admin clicks can fire the pair. This is a cost-amplification
nuisance, not an authz break (the response goes to the attacker's tab only if they can
read it, which same-origin policy prevents) - and `/api/system/errors` already had a
3-query version of it. Worth a bounded cheap guard (a short per-session cooldown, or
narrowing `BRACKET_WIDE_MS`) rather than a fix.

### C4. The whole env-scope boundary for the detail route depends on `@log` being present in the GetLogRecord response, which every test supplies and nothing verifies

`app/src/adapters/cloudwatch.ts:620,650` -> `app/src/services/systemStatus.ts:335-339`

`getLogRecord` reads `record['@log'] ?? ''`, `normalizeLogGroup('')` returns `''`
(`:301-304`), and the service rejects anything not in the three configured groups. That
fails **closed**, which is the right direction - but it fails closed *completely*:
if AWS omits `@log` from `logRecord`, every "Show all" in every environment returns
`out_of_scope` and the feature is dead on arrival, with local tests green.

Every fake in `app/test/cloudwatch.adapter.test.ts:390-515` hard-codes `'@log'`, so the
suite cannot distinguish "works" from "AWS never sends this". The IAM comment in
`infra/modules/ec2/main.tf:301-307` says the pointer "resolves server-side to its log
group for IAM to match on" - which is about IAM, not about the response body. One
recorded real response (or a fallback to `@logStream`, which the adapter already
expects to exist per `cloudwatch.adapter.test.ts:483-494`) would retire the risk.

Related: `@log` is `<accountId>:<logGroupName>` and is *not* in `DROPPED_KEYS`
(`cloudwatch.ts:163-165`), so `fields['@log']` ships the AWS account id to the browser.
Admin-only, so low - but it is host metadata the "credentials are the one exclusion"
framing does not mention.

### C5. The anchor marker fires on every line sharing the anchor's millisecond

`dashboard/src/routes/settings/ErrorTrace.tsx:52-60`

```tsx
className={l.timestamp === at ? styles.traceAnchor : styles.traceLine}
...
{l.timestamp === at ? <span className={styles.errorChip}>this failure</span> : null}
```

Matching is by ISO-string equality on a millisecond-resolution timestamp. Two lines
logged in the same millisecond (an app line and a worker line under one requestId is
the normal interleaved case this view exists to show) both render "this failure". The
row already carries a unique identity - `ev.ref` - which the trace projection
deliberately does not return (`traceLine`, `cloudwatch.ts:423-465`, selects only
`@timestamp, @message, @log`). Adding `@ptr` to the trace `fields` clause
(`cloudwatch.ts:670`) and comparing on it would make the marker exact. See also S1:
when the anchor falls in the second-boundary hole, this renders **zero** markers and
the view silently loses its stated purpose.

### C6. `enforceBound` mutates its argument and excludes `rawText` from the budget

`app/src/adapters/cloudwatch.ts:176-185`, called at `:649`

`enforceBound(fields)` truncates in place while `fields` is already referenced by the
returned object literal (`:647`). It works, but the returned `LogRecordView.fields` is
silently a different object than the one the loop at `:633-637` built, and a future
caller that reads `fields` before the return would see untrimmed values.

Separately, `rawText` (up to `RAW_TEXT_CAP` = 4000, `:157`) is spread in at `:648`
*outside* the byte accounting, so the real response ceiling is
`RESPONSE_BOUND_BYTES + 4000` even in the converging case.

### C7. Route-label cardinality is safe only because no router is currently mounted on a parameterised path

`app/src/lib/errors.ts:144-148`

```ts
return `${req.baseUrl ?? ''}${path}`;
```

The docblock (`:132-142`) justifies `req.route.path` over `req.path` on the grounds
that a concrete path would put a tenant's E.164 into `msg`. That reasoning covers
`req.route.path` but not `req.baseUrl`: Express sets `baseUrl` to the **matched URL
prefix with actual values substituted**, so a router mounted at, say,
`/:contactId/phones` would put the concrete id into `msg` - the exact outcome the
comment says it is preventing.

I swept `app/src` for `\.use\('/:` and found none, and `app/src/app.ts:123-285` mounts
everything on literal prefixes, so this is safe *today*. It is a one-line invariant
worth stating in the docblock so the next parameterised mount does not quietly
re-introduce phone numbers into the grepped field.

---

## NIT

### N1. `ErrorTrace` list keys mix a value with an index
`dashboard/src/routes/settings/ErrorTrace.tsx:53`: `key={`${l.timestamp}-${i}`}`. The
index alone is already stable for an immutable, fully-replaced list; the composite
suggests a stability the timestamp does not provide (see C5).

### N2. The detail view has no timestamp of its own
`cloudwatch.ts:163-165` drops `@timestamp` (and `@message`) from `fields`, so the
expanded record shows every field *except* when it happened, unless the log line
happened to carry its own `time`. Pino does emit `time`, so this is cosmetic - but the
dropped-key list is worth a comment saying so.

### N3. `getErrorDetail` re-fetches a record it already holds
`RecentErrors.tsx:193-198` deliberately refetches on every re-open ("re-opening a row
whose record is already in hand still refetches deliberately"). Given the record is
immutable once written, this is a free `GetLogRecord` per toggle. Deliberate and
harmless; noted only because the comment presents it as a choice without a reason.

### N4. `at` accepts anything `Date.parse` accepts
`app/src/routes/system.ts:120-125` validates the anchor with `Date.parse`, which
accepts non-ISO forms ("1 Jan 2020") and extreme values, despite the 400 message
saying "at must be an ISO 8601 timestamp". Downstream damage is nil (an absurd bracket
just returns nothing or a CloudWatch error that degrades at 200), so this is only a
message-vs-behaviour mismatch.

---

## Explicitly checked and found sound

These are the hypotheses the charter pointed at that I could refute, so their absence
from the list above is a result, not a gap.

- **Insights query injection via `kind`.** `system.ts:109-119` filters the id kind
  against a frozen literal tuple before it can reach
  `filter ${kind} = "${id}"` (`cloudwatch.ts:672`). `req.query[k]` must be
  `typeof === 'string'`, so `?correlationId=a&correlationId=b` (which `qs` turns into
  an array) is counted absent and 400s rather than sneaking an array through.
- **Injection via `id`.** `UUID_PATTERN` (`systemStatus.ts:151`) is anchored and
  hex-only, applied at `:352` *before* the adapter call, and there is no other caller
  of `getTrace` in the tree. A payload like `x" | fields @message | filter x="` cannot
  match. `String(req.query[kind])` at `system.ts:127` is a no-op given the preceding
  `typeof` guard.
- **Pointer round-trip corruption.** `getSystemErrorDetail`
  (`dashboard/src/api/endpoints.ts:2123-2131`) routes `ref` through the `query` option,
  which builds with `URLSearchParams` (`dashboard/src/api/client.ts:44-53`), so `+`,
  `/` and `=` are percent-encoded and `qs` decodes them back. The route test at
  `app/test/system.routes.test.ts` ("hands the DECODED pointer to the service") pins it.
- **XSS from log-derived strings.** No `dangerouslySetInnerHTML` anywhere in
  `RecentErrors.tsx`, `ErrorTrace.tsx` or `useSystemStatus.ts`; `record.fields` values,
  `rawText` and `l.message` all render as JSX text nodes.
- **Authorization on the new routes.** `router.use(requireRole('admin'))` at
  `system.ts:53` precedes every route definition including the two new ones, and the
  whole router is mounted under the `/api` `requireAuth` gate
  (`app/src/routes/api.ts:756-766`). Both new routes have explicit 403 tests.
- **Confused-deputy on the pointer.** Defence in depth is real, not claimed:
  IAM scopes `logs:GetLogRecord` to `/hc/<env>/*`
  (`infra/modules/ec2/main.tf:308-315`) *and* the service rejects any record whose
  normalised `@log` is outside the three configured groups (`systemStatus.ts:335-339`).
  Neither is the sole boundary.
- **Envelope compatibility for `pollRunId`.** `isCompleteEnvelope`
  (`app/src/jobs/jobs.ts:222-237`) checks only that `correlationContext` is a non-null
  object - no key allowlist - so old in-flight envelopes without `pollRunId` and new
  ones with it both validate. `dispatchJob` re-hydrates with a full spread
  (`:305`), so the field survives the hop. The correlationId ladder is unchanged:
  `jobRunId` is minted at dispatch and still wins (`lib/logger.ts:231`).
- **`pollRunId` actually reaches a log line.** The pino `mixin`
  (`lib/logger.ts:228-233`) spreads the whole context, so `pollRunId` is a top-level
  field an Insights `filter pollRunId = "..."` can match and
  `projectErrorEvent` can read (`cloudwatch.ts:408`).
- **`pollRunId` is not dead code.** `startPoll` wraps every tick in a fresh
  `pollRunId` (`app/src/jobs/pollLoop.ts:66-72`) and `app/src/worker.ts:349-512` starts
  five polls whose bodies transitively reach `jobs.enqueue` (e.g. roster actions ->
  `addMemberToRelay` -> `groupRail.ts:107`).
- **Log-message consumers.** Nothing outside this diff asserts on or metric-filters the
  old `'job failed'` / `'unhandled error while handling request'` literals - see the
  sweep list below. `infra/modules/observability/main.tf:352` matches the string only
  inside an alarm *description*, not a pattern.
- **CloudFront.** The API behaviour uses `caching_disabled` +
  `all_viewer_except_host` (`infra/modules/cloudfront/main.tf:193-194`), so the new
  `ref` / `at` / `correlationId` query parameters are forwarded intact and no response
  is cached. No new `ordered_cache_behavior` is needed (the routes are GETs under an
  existing prefix).
- **Backend/dashboard contract mirror, field by field.** `ErrorEventView`
  (`cloudwatch.ts:101-135`) vs `SystemErrorEvent` (`dashboard/src/api/types.ts:343-361`);
  `LogRecordView` (`:199-210`) vs `SystemLogRecord` (`types.ts:378-384`);
  `TraceLineView` (`:224-242`) vs `SystemTraceLine` (`types.ts:387-399`). All 15 / 5 /
  11 members match in name, optionality and type. The dashboard widens the `reason`
  unions to `string`, which is safe in that direction.
- **CSS classes.** Every class the two new components reference exists in
  `SystemStatusSection.module.css` (`.detailBlock/.detailFields/.detailField/.detailKey/
  .detailValue/.detailStack/.detailRaw/.truncated/.traceList/.traceLine/.traceAnchor/
  .errorActions/.warnToggle/.errorDetail` all present).
- **`Promise.all` in `queryTrace`.** A rejection from one side does not orphan the
  other: `Promise.all` attaches handlers to both, so the loser's eventual rejection is
  handled and cannot become an unhandledRejection. The service catches and degrades
  (`systemStatus.ts:363-369`).
- **No shared mutable state in the adapter.** `createCloudWatchClient` closes over
  `cw` / `logs` / `config` only; `runInsights` keeps `queryId` in a local. Concurrent
  `queryInsights` / `queryTrace` / `getLogRecord` calls share nothing.

---

## Sweeps performed (so the absence of findings is itself evidence)

| # | Pattern / target | What it covered | Result |
|---|---|---|---|
| 1 | `job failed` (whole tree, ex-node_modules) | metric filters, alarms, RUNBOOK, e2e specs, unit tests, docs | Only the diff's own sites + `infra/.../observability/main.tf:352` (alarm *description* text, not a pattern). No parser/assertion depends on the old bare literal. |
| 2 | `unhandled error while handling request\|malformed URI in request\|unhandled error after response started` | anything asserting on the Express handler's message strings | Only `app/src/lib/errors.ts` itself and design docs. No test, no metric filter. |
| 3 | `pollRunId` across `app/src` | minting, context type, envelope, logger mixin, Insights projection, route allowlist | 11 sites, all consistent; ladder position unchanged. |
| 4 | `correlationContext` (whole tree) | every reader/writer/asserter of the envelope's correlation blob | 2 writers (`jobs.ts:174`, `:272`), 1 reader (`:305`), 1 shape check (`:229`), 4 test assertions. Adding a key breaks none. |
| 5 | `queryInsights\|getLogRecord\|queryTrace\|CloudWatchClientSeam\|ErrorEventView` | every implementer/consumer of the widened seam and projection type | 5 source/test files in `app/`, 1 mirror in `dashboard/src/api/types.ts`. No third implementation of the seam exists (no e2e fake, no dev stub). |
| 6 | `SystemErrorEvent\|SystemErrorsResult\|SystemLogRecord\|SystemTraceLine\|SystemTraceResult\|SystemErrorDetailResult` across `dashboard/src` | every construction site of the widened dashboard types | `RecentErrors.{tsx,test.tsx}`, `ErrorTrace.{tsx,test.tsx}`, `SystemStatusSection.test.tsx`, `useSystemStatus.ts`, `endpoints.ts`. `SystemStatusSection.test.tsx:36` only builds the degraded shape, so it needed no update - correct. |
| 7 | `log\.(error\|warn\|fatal\|info)\(\s*\{...(error\|e\|cause\|reason\|response\|request\|config\|...)\s*:` across `app/src` (multiline) | vendor-error objects logged under a key the `err.` allowlist does not cover (finding S3) | ~30 hits, all string-valued (`reason: 'source'`, `error: outcome.error`, ...). Two object-suspects manually opened (`api.ts:1326`, `rosterActions.ts:581`) - both refusal-code strings. No live leak. |
| 8 | `dangerouslySetInnerHTML` across `dashboard/src` | XSS from log-derived strings rendered by the new components | 13 hits, all in unrelated files and all of them *comments/tests asserting its absence*. Neither new component uses it. |
| 9 | `ordered_cache_behavior\|query_string\|cache_policy\|origin_request_policy\|forwarded_values` across `infra/` | CloudFront stripping the new query params or caching admin responses | API behaviours use `caching_disabled` + `all_viewer_except_host`. No exposure. |
| 10 | `createSystemRouter\|/api/system` across `app/src` | mount point, middleware order, auth gates for the new routes | One mount (`api.ts:757`) under the `/api` `requireAuth` gate; `requireRole('admin')` applied at the router head before any route. `/errors` and `/errors/detail` are distinct exact paths, so no shadowing. |
| 11 | `\.use\('/:` across `app/src` + `app.use(` in `app/src/app.ts` | parameterised mounts that would make `req.baseUrl` high-cardinality (finding C7) | None. All mounts are literal prefixes. |
| 12 | `sameSite` across `app/src` | CSRF reachability of the new GET routes (finding C3) | `lax` in all three cookie definitions - top-level cross-site GETs do carry the session. |
| 13 | `startPoll` + `enqueue(` across `app/src/jobs` | whether `pollRunId` propagation is reachable or dead code | 5 poll loops, 8 enqueue sites; roster actions -> `groupRail.ts:107` is a concrete poll->enqueue chain. Reachable. |
