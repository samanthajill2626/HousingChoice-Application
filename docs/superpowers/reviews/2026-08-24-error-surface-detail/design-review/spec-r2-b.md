# Adversarial design review - Error surface detail (spec r2, reviewer B, round 2)

Spec under review: `W:\tmp\error-surface-detail\docs\superpowers\specs\2026-08-24-error-surface-detail-design.md` (DRAFT r2)
Adjudications read: `.superpowers\design-review\adjudications.md`
Other r1 reviewer read: `.superpowers\design-review\spec-r1-a.md`
Repo: `W:\tmp\error-surface-detail` (read-only; no tests, no builds, no e2e run)
Date: 2026-08-24

Reviewed the r2 mechanism cold, as new material. Every claim about existing
behavior cites a file:line I opened this round. UNVERIFIED is marked.

---

## A. What r2 gets RIGHT that I could not confirm in r1 (do not re-open)

- **CloudFront forwards query strings and does not cache these responses.**
  `infra/modules/cloudfront/main.tf:151-163`: the `/api/*` ordered behavior uses
  `origin_request_policy_id = all_viewer_except_host` and
  `cache_policy_id = caching_disabled`. A `?ref=` / `?correlationId=` query param
  reaches the origin intact and is not cached. The transport choice is sound at
  the edge. Both new routes are GETs under an already-declared prefix, so the
  "every mutating prefix must be listed" hazard (`main.tf:140-150`) does not bite.
- **The query-param form really does keep the value out of the request log.**
  `app/src/middleware/requestLogger.ts:34` and `:58` log `path: req.path`, and
  `req.path` excludes the query string. I checked the whole app for a fuller URL:
  `originalUrl` appears only at `app/src/middleware/twilioSignature.ts:60`, `:126`
  and `app/src/routes/auth.ts:202`, none of which log it. S3 line 229-230 holds.
- **The new 4-segment template cannot collide with the existing one.**
  `e2e/performance/templates.ts:200-211` (`matchTemplate`) skips any candidate
  whose segment count differs, so `/api/system/errors/detail` and
  `/api/system/errors` are unambiguous, and `COMPILED_TEMPLATES` is derived from
  the frozen list so a single addition suffices.
- **`req.baseUrl + req.route.path` cannot reintroduce a concrete id.** I grepped
  for a router mounted at a path containing a param (`.use('/...:...')`) across
  `app/src` and found none; the system router is mounted at the literal
  `'/system'` (`app/src/routes/api.ts:758`). AJ14's deterministic rule is safe.
- **Express is `^5.2.1`** (`app/package.json:36`) with no `query parser`
  override anywhere in `app/src`, so the default parser applies and the
  `+`-decodes-to-space claim holds.
- The corrected counts and enumerations are all accurate: 13 `defineJobHandler`
  registrations, 248 error call sites, three log groups
  (`app/src/lib/config.ts:526-528`), three Express branches
  (`app/src/lib/errors.ts:140-143`, `:151-157`, `:159-162`) with `:143` and `:162`
  emitting the identical literal, and a real em-dash at `:154`.

---

## B. NEW FINDINGS - defects in the r2 material itself

### N1. [BLOCKING] The `requestId` pivot does not exist for poll-enqueued jobs, and the spec states it as general

**What is wrong.** S4 lines 278-285 make `requestId` the fix for AJ15:

> Filtering on a `job failed` line's correlationId therefore returns that job run
> alone ... That is precisely the motivating case, so the pivot must also filter
> on `requestId`.

`requestId` is not always there. `app/src/jobs/jobs.ts:174-179` builds the
envelope's correlation context by copying FOUR optional fields, each only when
present:

```
const correlationContext: CorrelationContext = {
  ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
  ...(ctx.conversationId !== undefined && { conversationId: ctx.conversationId }),
  ...(ctx.tenantId !== undefined && { tenantId: ctx.tenantId }),
  ...(ctx.placementId !== undefined && { placementId: ctx.placementId }),
};
```

`pollRunId` and `bootId` are NOT copied. A job enqueued from a worker poll tick
runs under a `pollRunId` context with no `requestId`
(`app/src/lib/context.ts:20-33` documents the poll-tick context and names the
loops: tour reminders, placement nudges, roster actions, extraction, group
guardrails). Its envelope therefore carries no request id, `dispatchJob` spreads
an empty-ish context (`jobs.ts:298-305`), and the `job failed` line has
`correlationId = jobRunId` and NOTHING linking back to the tick that enqueued it.

**Implies.** For the entire worker-poll class of job failures - a large share of
what this panel exists to triage - the r2 pivot reproduces exactly the defect
AJ15 accepted. The spec asserts the remedy without qualification, so a builder
implements it and the gap ships silently. The fields that DO propagate for that
class are `conversationId`, `tenantId` and `placementId` (`jobs.ts:175-178`); the
spec never mentions them. Either the pivot accepts those too, or the spec must
state plainly that a poll-originated job failure has no upstream pivot.

---

### N2. [BLOCKING] Nothing on the wire carries `requestId` to the panel, so the two-id trace route is unreachable from the UI

**What is wrong.** S4 accepts `?requestId=<uuid>` (line 263-264). Nothing supplies
it.

- S2's widened field list (line 154) is `jobName`, `event`, `errType`,
  `errMessage`, `source`, `ref`. No `requestId`.
- `ErrorEventView` today carries `correlationId` only
  (`app/src/adapters/cloudwatch.ts:87`), and S2 does not add `requestId`.
- S5's collapsed row (line 311) lists "the trace link", singular, and S5's null
  guard paragraph (lines 325-330) describes it as driven by `correlationId`.
- The only place `requestId` appears is fact 4's DETAIL record (line 81) - i.e.
  after the operator has already expanded a row - and S5's expanded section
  (lines 313-316) does not mention offering a trace link from it.

**Implies.** The half of S4 that AJ15 added to close the job-hop gap is plumbed
into the route and unreachable from every surface a user touches. The panel can
only ever fire the narrow `correlationId` pivot that AJ15 judged insufficient. This
is not a UI polish item: it is the accepted fix failing to reach the data path.
`requestId` must join `ErrorEventView`, the projection, and the row.

(Note: `requestId` IS on the log line for request-originated work - the pino
mixin spreads the whole context, `app/src/lib/logger.ts:232` - so the projection
change is the only thing missing. Subject to N1 for poll-originated work.)

---

### N3. [HIGH] S3's outbound denylist is the same mechanism section 6 spends four paragraphs condemning

**What is wrong.** Section 6 lines 384-388:

> HONEST STATEMENT: credential redaction is a BEST-EFFORT path list, known to be
> incomplete. This is why S3 carries an outbound denylist on the `err.config.*`,
> `err.request.*` and `err.response.*` nests rather than relying on write-time
> redaction alone.

The stated defect of write-time redaction is that a path list cannot enumerate
what it has not met. The remedy is a path list of three prefixes. It fails the
same way, and the repo already says so in the sentence the spec itself quotes at
line 377-378 (`app/src/lib/logger.ts:200-203`): "Redaction only covers the paths
it is told about, and the next SDK will invent a new one."

The repo's established pattern for exactly this problem is an ALLOWLIST, in two
places:

- `app/src/lib/errors.ts:34-38` - `ErrorSummary` is the adjudicated allowlist
  `(name, code, status)`, and `:41-63` explains that it "copies nothing it was
  not asked for ... so neither a future SDK adding an enumerable property nor a
  vendor writing PII into its own error text can smuggle anything into a log line."
- `app/src/middleware/requestLogger.ts:11-18` - `SAFE_HEADER_ALLOWLIST`, described
  at `app/src/lib/logger.ts:180-181` as the primary control with redaction as
  "defense-in-depth" on top.

A concrete hole in the three-prefix denylist: `err.cause`. pino 9's
`stdSerializers.err` serializes the `cause` chain (UNVERIFIED - no `node_modules`
in this worktree - but it is the documented pino 8+ behavior and the spec's own
premise at line 18 is that the default serializer applies). An axios error
wrapped as a cause flattens to `err.cause.config.headers.Authorization`, matched
by neither `logger.ts:204-223` nor S3's three prefixes.

**Implies.** S3's control is presented as the answer to AJ6 but inherits the
failure mode AJ6 identified. An allowlist over the flattened record - or at
minimum a recursive `*.config.*` / `*.request.*` / `*.response.*` match rather
than three fixed prefixes - is the shape that closes the class, and it is the
shape this codebase already uses twice.

---

### N4. [HIGH] The denylist drops `err.response.status`, which the repo's own adjudicated allowlist keeps

**What is wrong.** S3 lines 236-242 drop the whole `err.response.*` nest and
justify it: "they carry no troubleshooting value the remaining fields lack."

That is contradicted by the repo's adjudicated error summary.
`app/src/lib/errors.ts:77-82`:

```
const status =
  typeof raw.status === 'number'
    ? raw.status
    : typeof raw.response?.status === 'number'
      ? raw.response.status
      : undefined;
```

`err.response.status` is read SPECIFICALLY because it is diagnostic, and
`app/src/lib/errors.ts:34-38` names `status` as one of the three fields in the
adjudicated allowlist - "the two vendor discriminators worth having"
(`:41-63`). Dropping the nest removes the single most useful triage field on a
vendor HTTP failure, on exactly the rows (Twilio/SES errors) an operator most
often opens.

**Implies.** The denylist's justification is false as written. An allowlist (N3)
resolves both findings at once: keep `name`/`code`/`status`, drop everything else
in those nests.

---

### N5. [HIGH] `source` is declared as a three-value union and given a fourth value in the same paragraph

**What is wrong.** S2 lines 176-181:

> **`source` is `'app' | 'worker' | 'system'`** - THREE values ... an unmatched
> group falls back to an explicit unknown rather than being silently labelled
> `app`.

The declared union has no member for the fallback. S5 line 310 renders "the
`app`/`worker`/`system` source chip" - also three. Section 7 line 405-406 asks for
a test of "`source` derivation including `system` and the unknown-group fallback",
so the fourth value is expected to exist and be asserted.

**Implies.** A builder either widens the union without authority (and S5's chip
has no branch for it) or drops the fallback and mislabels. This is a
self-inflicted contradiction introduced by the rewrite: r1 had the wrong enum,
r2 has the right enum plus an undeclared fourth state.

---

### N6. [HIGH] The trace link carries no window, and the list route's 24h default silently empties it

**What is wrong.** S4 lines 291-293: "same window vocabulary and validation as the
list route (`system.ts:65-75`)". That route defaults to 24h
(`app/src/routes/system.ts:66-75`) and offers `1h | 24h | 7d`. S5 line 311 puts
"the trace link" in the collapsed row and says nothing about a window.

The panel's own window selector goes to 7d (`app/src/services/systemStatus.ts:45`,
`dashboard/src/routes/settings/RecentErrors.tsx:16-20`). So the routine case is:
operator selects 7d, sees a five-day-old error, clicks trace, the route defaults
to 24h, and the query returns ZERO rows.

**Implies.** An empty trace is indistinguishable from "there was no context", on a
feature whose entire purpose is context. The link must carry the row's window, or
a window derived from the row's `timestamp`, and the spec must say which. This is
new material - r1's S4 had no window statement at all, so the defect arrived with
the fix.

---

### N7. [MEDIUM] The base64url rule depends on a positional property the spike did not measure, and its inverse is never stated

**What is wrong.** Fact 3 (lines 75-78) measured the CHARSET: "A real pointer was
220 chars over `[A-Za-z0-9+=]`. It CONTAINS `+` and `=`." S2 line 183 then
specifies "`+`->`-`, `/`->`_`, strip `=`".

Stripping `=` is reversible only if `=` is TRAILING padding. The spike measured
which characters appear, not where. The spec applies to its own evidence exactly
the inference the adjudication file rejects elsewhere - fact 3's own sentence
says "the sample does not bound the general case" about `/`, then treats `=`
positionally as settled. If any `=` is non-terminal, the transform is lossy and
every pointer is destroyed.

Second gap: the INVERSE transform is never specified. base64url decode requires
re-padding to a multiple of 4 before the SDK call. Only section 7's "base64url
round-trip" test (line 408) implies an inverse exists. If the builder omits the
re-pad, `GetLogRecord` rejects every pointer - and S3's degradation contract
(lines 247-249) swallows that into `{ available: false, reason }`, which is
indistinguishable from "no AWS". That is AJ8's trap exactly: a permanently broken
path in the only environment that has data, invisible to every gate, because the
hermetic lane short-circuits at `app/src/services/systemStatus.ts:212-214`.

**Contesting RJ2 on new grounds.** RJ2 correctly rejected my r1 remedy (a RAW
pointer in a naive query param) - `qs`/`querystring` decoding a literal `+` to a
space does corrupt it, and I did not catch that. But the conclusion "therefore
transcode" does not follow. `encodeURIComponent(ptr)` percent-encodes `+` as
`%2B`, `/` as `%2F` and `=` as `%3D`; both parsers decode `%2B` back to `+`
(the `+`-to-space rule applies only to a LITERAL `+`), and a query VALUE has no
path-segment or CloudFront-normalisation problem. That is zero new transform
code, zero lossiness question, and no inverse to get wrong. base64url is a fine
choice; the spec should say why it beats the standard URL-encoding of a value,
because on this evidence it is strictly more risk for the same result.

---

### N8. [MEDIUM] The detail route never checks that the resolved record belongs to this environment's log groups

**What is wrong.** S3's validation (lines 251-253) is charset and length only.
`ref` is an opaque, ACCOUNT-scoped pointer - nothing about it is bound to
`/hc/<env>/*`. The only thing scoping the read is IAM, and S6 (lines 343-349)
explicitly permits falling back to `resources = ["*"]` on a cited AWS reference
entry - a branch the spec expects may well be taken, since `GetQueryResults` and
`StopQuery` already sit in the `["*"]` statement
(`infra/modules/ec2/main.tf:296-300`).

On that branch, `GET /api/system/errors/detail?ref=<any pointer>` reads any log
record in account 938565869261 that the instance role can reach, from any log
group, including another environment's.

**Implies.** The response already carries `@log` (S3 line 233, fact 7), and S2
already specifies the normalisation. Rejecting a record whose normalised `@log`
is not one of `config.errorLogGroupName` / `workerLogGroupName` /
`systemLogGroupName` (`app/src/lib/config.ts:526-528`) costs one comparison and
makes the route's scope independent of which IAM branch S6 lands on. The spec
should require it rather than leaving env-scoping to an IAM outcome it admits is
unknown.

---

### N9. [MEDIUM] The spec misreads the test fake helper - the consequence is a typecheck failure, not a throw

**What is wrong.** S3 lines 255-259:

> Test fakes are built from `Partial<CloudWatchClientSeam>`
> (`app/test/systemStatus.service.test.ts:41-42`), so a fake omitting the method
> must THROW, not silently no-op - the method is not optional on the interface.

`Partial<>` is the helper's INPUT parameter type. The RETURN is a hardcoded
two-property object literal (`app/test/systemStatus.service.test.ts:40-50`):

```
function fakeSeam(impl: Partial<CloudWatchClientSeam> = {}): CloudWatchClientSeam & {...} {
  return {
    describeAlarms: vi.fn(impl.describeAlarms ?? (async () => [])),
    queryInsights:  vi.fn(impl.queryInsights  ?? (async () => [])),
  };
}
```

Adding a REQUIRED method to `CloudWatchClientSeam` makes that literal fail to
satisfy its declared return type - a compile error under `npm run typecheck`,
which AGENTS.md lists as a separate required gate. No runtime throw is reachable,
because the helper never constructs a fake missing the method; it will not
compile first.

**Implies.** The spec sends the builder looking for a runtime behavior that
cannot occur, and omits the actual work: `fakeSeam` must be edited to add stubs
for BOTH new methods (S3's `getLogRecord` and S4's ascending-sort query). Small,
but it is the one file the spec singled out and it described it wrongly.

---

### N10. [MEDIUM] The perf-harness instruction risks creating the red gate it warns about, and its "must change together" claim is probably false

**What is wrong.** Section 7 lines 421-431 says all three perf files "must change
together or its contract tests go red", and points at
`e2e/performance/routes.ts:304-306` - "`SYSTEM_GETS` pins allowed query keys ...;
the new routes' keys must be declared."

`SYSTEM_GETS` entries are built with `required(...)`
(`e2e/performance/routes.ts:155-161`), and `requirement` is part of the asserted
contract - `routes.test.ts:106-109` asserts strings carrying a literal
`#required` suffix. A `required` entry means the request MUST be observed on the
profiled page load. The detail and trace requests fire only on an expander click
and a link click, which a page-load profile never performs. Declaring them
`required` fails the contract from the other direction; `conditional(...)`
(`routes.ts:163`) is the correct helper and the spec does not name it.

Conversely, if the profiler never observes these requests at all, then NONE of
the three files needs to change - which makes "all three must change together or
its contract tests go red" an over-claim.

**Implies.** The spec must state the actual condition: declare in `templates.ts`
and add `conditional(...)` entries ONLY if the profiler's walk reaches the
expander; otherwise leave the harness alone. As written it invites a `required`
entry that reddens the gate. (I verified the safe half: `matchTemplate` keys on
segment count - `templates.ts:200-211` - so the 4-segment template is
unambiguous, and query VALUES never reach artefacts, only sorted KEY names
(`templates.ts:227-229`, `redact.test.ts:37`), so the 220-char `ref` value and a
UUID value are both fine.)

---

### N11. [MEDIUM] The fallback ladder routes vendor-authored text into the dedup key

**What is wrong.** S2 line 196 specifies the ladder `msg` -> `event` ->
`err.message` -> `(unparseable log line)`. `app/src/services/systemStatus.ts:247`
keys dedup on `message`.

`app/src/lib/errors.ts:26-36` records the repo's adjudicated position that
`err.message` is the field "the vendor authors freely" - the untrusted one, and
the exact reason it is excluded from `ErrorSummary`. Section 6 line 380-382 cites
that same passage approvingly. So on the ladder's third rung, row identity is
decided by vendor-authored text, capped by S2 (line 186) to a 300-char prefix -
which makes two different vendor errors sharing a 300-char prefix collapse into
one row.

`ref` joining the key (line 214) rescues it, but only by making every other
component inert: `@ptr` is unique per log event, so the key is now effectively
`ref` alone.

**Implies.** Two things the spec should say and does not: (a) the dedup is now
by-`ref`, and the timestamp/message/errorCode components are vestigial - keep or
drop them deliberately; (b) what the key does when `ref` is absent for a row
(Insights returning no `@ptr` cell, or a future query without it), because that
is the case where the truncated-vendor-text key silently takes over.

---

### N12. [LOW] One truncation flag, two capped fields

S2 lines 186-189 cap `errMessage` AND `message` at 300 "with an explicit
truncation flag" - singular. The UI cannot tell which field was truncated, and
S5's expander offer (line 187-188: "so the UI can show more exists and offer S3")
is meaningful for both. Two flags, or one flag per field.

---

### N13. [LOW] S1 never says whether the WARN branch's message takes the `method` / `(unrouted)` treatment

S1 line 120-122 puts the `URIError` branch in scope; lines 130-135 state the rule
for "the message". For that branch `req.route` is ALWAYS unset - Express's matcher
throws before any handler runs, as the existing comment says at
`app/src/lib/errors.ts:147-151` - so the rule yields `method + (unrouted)` for
every malformed URI, identically. Harmless, but unstated: a builder may reasonably
apply the rule, skip it, or ask. Say which.

---

### N14. [LOW] "a `%2F` is normalised or rejected by CloudFront before Express sees it" is asserted without a source

S3 line 222 states this as fact in a spec that now attributes every other fact to
the record it came from (section 3, line 62-63). It is UNVERIFIED - the behavior
is not determinable from this repo, and no AWS citation is given. The chosen
design does not depend on it, so the consequence is only that a reader cannot
audit the transport rationale.

---

## C. Contesting the adjudications

### RJ1 (no dual-path retrieval fallback) - CONCEDED, without reservation

The engineering conclusion is right and my r1 finding did not actually propose a
fallback (B16 asked only that the guarantee not be asserted from n=1, which AJ23
accepted). A second retrieval path against a hedge that measured fine at the
widest offered window is permanent cost for approximately-never exercise, and the
failure mode degrades visibly through the same `{ available: false, reason }`
every other CloudWatch failure uses. I withdraw any implication otherwise.

### RJ2 (query param / POST body as stated) - CONCEDED on the rejection, CONTESTED on the replacement

The rejection is correct and I missed the `qs` `+`-to-space rule; a raw pointer
in a naive query parameter is corrupted, and a POST body does turn a read into a
write for nothing. I do not defend either remedy.

What I do contest is that base64url follows from that. See N7: the standard
URL-encoding of a query VALUE (`encodeURIComponent`) solves the same three
hazards with no new transform, no lossiness question about `=`, and no unstated
inverse. base64url may still be the right call - it produces a shorter, more
readable URL - but the spec presents it as the only safe option, and it is not.
Whichever survives, the spec owes the builder the inverse transform in writing.

---

## D. Status of my r1 findings against r2

Closed correctly and completely: B1 (S1 lines 124-135), B3 (lines 199-208),
B4 (lines 156-181), B5/B6 (lines 266-293), B7 (section 8, 17 entries), B10
(lines 210-214, 318-323), B11 (lines 130-135), B13 (lines 394-400), B14
(lines 191-197), B15 (facts now attributed per record), B16 (fact 1 restated),
B17 (lines 30-31, 106-109), B18 (lines 111-122, 137-144), B19 (lines 186-189).

Closed in part, with new material open against them:
- B2 / AJ6 - the false guarantee is struck (good), but the replacement control is
  N3 and N4.
- B8 / AJ10 - the surface is enumerated, but the instruction is N10.
- B9 / AJ15 - accepted in the route and NOT delivered in the envelope (N1) or the
  projection and UI (N2). This is the one accepted finding that r2 does not
  actually close.
- B12 / AJ2 - transport moved off the path segment (good), but N7 and N8 are open
  against the replacement.
- B20 / AJ22 - one sentence added, describing the wrong mechanism (N9).

Section 8 nit, not a numbered finding: line 458-459 lists
`app/test/cloudwatch.adapter.test.ts:129` for rewrite, but S2 (line 199-208) now
KEEPS that behavior, so the comment "PII-safety: raw text never surfaced" remains
true of the list path. Rewrite it to note that S3 surfaces raw text elsewhere, or
drop it from the list - as written it tells the builder to correct a comment that
is not wrong.

---

## E. Are the fixes correct, or merely plausible?

Correct: the S1 path decision (N/A - `req.path` never enters `msg`, and I verified
no param-bearing router mount can smuggle an id in through `req.baseUrl`), the
`source` mechanism (fields clause, row loop, signature change - all three real and
all three now named), the nested-vs-flattened accessor warning, the withdrawal of
the relax-unparseable instruction, the dedup and row-key changes, the IAM default
inversion, and the section 8 enumeration.

Plausible but not yet correct: the credential control (N3, N4 - right diagnosis,
wrong shape of remedy), the pointer transport (N7 - right to move off the path,
under-specified in its replacement), the trace pivot (N1, N2, N6 - the route is
right and nothing feeds it), and the perf-harness scope (N10 - right files, wrong
instruction).
