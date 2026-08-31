# Spec design-review adjudications - round 1

Spec: docs/superpowers/specs/2026-08-24-error-surface-detail-design.md
Reviewers: spec-r1-a.md (17 findings), spec-r1-b.md (20 findings)
Adjudicated by the planner, 2026-08-24. Every load-bearing claim about existing
behavior was re-verified in the code before acceptance; verification notes below.

Counts: 24 ACCEPT, 2 ACCEPT-WITH-DIFFERENT-REMEDY, 2 REJECT, 1 DEFER.

The two reviews converged heavily. Where both found the same defect the
adjudication is recorded once, citing both.

---

## ACCEPTED - decision-changing

### AJ1. S4 cannot reuse the queryInsights seam (A1 BLOCKING, B5 HIGH, B6 HIGH)

VERIFIED: `cloudwatch.ts:227` hardcodes `sort @timestamp desc`;
`app/test/cloudwatch.adapter.test.ts:123` pins it; the seam returns
`ErrorEventView[]`, not raw lines.

B5's sharpest point decides the design and neither I nor A stated it: `limit` is
applied by Insights INSIDE the descending sort, so a truncated trace keeps the
lines AFTER the failure and drops the ones before it - the exact opposite of the
feature's purpose. Client-side re-sorting cannot recover them.

RESOLUTION: S4 gets its OWN seam method with an ascending sort and its own row
shape. "Reuses the existing seam" is struck.

### AJ2. @ptr transport (A2 BLOCKING, B12 MEDIUM)

VERIFIED BY MEASUREMENT, closing the gap both reviewers correctly flagged as
unrecorded: a real pointer is 220 chars over `[A-Za-z0-9+=]`. It contains `+`
and `=`. No `/` in that sample, but base64's alphabet includes `/`, so one
sample proves nothing about the general case.

Worse than either reviewer knew: Express's default `qs` parser decodes `+` as a
space, so a NAIVE query parameter corrupts the pointer just as a path segment
would.

RESOLUTION - ACCEPT THE FINDING, REJECT BOTH PROPOSED REMEDIES in favour of a
better one: base64url-transcode the pointer server-side (`+`->`-`, `/`->`_`,
strip `=`) into an opaque `ref`, and carry it as a QUERY PARAMETER. This is
URL-safe in every position, so it survives CloudFront normalisation, the `qs`
`+`-to-space rule, and Express's matcher. It keeps the route a GET.

VERIFIED consequence for B12's third sub-point: `requestLogger.ts:33` logs
`req.path`, which in Express EXCLUDES the query string. A query-param `ref`
therefore does NOT land in CloudWatch on every request. B12's third sub-point is
correct for the PATH form the spec had and is resolved by the change.

Same treatment for S4: `correlationId` moves to a query parameter, keeping the
UUID out of `req.path` too.

### AJ3. `source` enum and mechanism (A3 HIGH, B4 BLOCKING)

VERIFIED: `config.ts:526-528` defines THREE groups; `systemStatus.ts:234` queries
`/hc/<env>/system` and `:245` merges its rows into the same array.

Two distinct defects, both accepted:
(a) the enum must be `'app' | 'worker' | 'system'`;
(b) B4b is the one I actually missed - there was NO MECHANISM. The list query's
`fields` clause returns neither `@log` nor whole rows
(`cloudwatch.ts:227`, row loop `:254-261` extracts only two cells), and
`projectErrorEvent(rawMessage, ts)` takes a string, not a row. Fact 6 was stated
about the DETAIL record and silently assumed for the LIST.

RESOLUTION: the spec now states the `fields` change, the row-loop change, and the
`projectErrorEvent` signature change explicitly.

### AJ4. `@log` format (A16 LOW)

A marked this UNVERIFIED. I HAVE the spike data and can settle it: the observed
value was `938565869261:/hc/dev/app`. A is right - it is
`<accountId>:<logGroupName>`, not a bare name. Normalisation rule and an
unknown-group fallback are now specified.

### AJ5. Relax-unparseable is a no-op and self-contradictory (A4 HIGH, B3 BLOCKING, B14 MEDIUM)

VERIFIED: `cloudwatch.ts:57-58` documents that non-JSON lines have no `level` and
are excluded from the pino query by construction; the only non-JSON rows come
from the two OOM queries, whose `message` is unconditionally overwritten at
`systemStatus.ts:239-240`. `app/test/cloudwatch.adapter.test.ts:129-130` pins
`'(unparseable log line)'`.

RESOLUTION: the relaxation is DROPPED from the list path. It bought nothing and
cost a stated property. Raw text remains reachable via S3's detail record.

B14 is a separate, REAL, and reachable branch that survives the drop: the
fallback also fires on well-formed JSON carrying `event`/`err` but no `msg`
(`cloudwatch.ts:127, 135-136`). Since S2 now adds an `event` chip, a row reading
"(unparseable log line)" next to a populated chip is reachable and absurd. The
spec now specifies a fallback ladder: `msg` -> `event` -> `err.message` ->
`(unparseable log line)`.

### AJ6. The credentials guarantee is false (A5 HIGH, B2 BLOCKING)

The most important correction in the round. VERIFIED: `logger.ts:204-223` lists
THREE literal `err.config` paths, not `err.config.*`. `err.config.url`,
`err.config.params`, `err.config.baseURL` and `err.config.auth` are NOT redacted.
`logger.ts:200-203` disclaims the guarantee in the repo's own words: "This is
defense in depth, not the fix ... Redaction only covers the paths it is told
about." `errors.ts:26-36` records the adjudicated position that `err.message` is
the field the VENDOR authors freely - so my spec named as safe the exact field
the repo treats as untrusted.

RESOLUTION - BOTH remedies, not either/or:
(a) the absolute claim is STRUCK and replaced with an honest statement that
    credential redaction is a best-effort path list, known-incomplete;
(b) S3 gains an OUTBOUND DENYLIST on the flattened record - the `err.config.*`,
    `err.request.*` and `err.response.*` nests are dropped before the response.
    Those carry no troubleshooting value the other fields lack, and they are the
    documented carriers of both credentials and the ZIP the messaging sanitizer
    exists to contain.

This does not reopen the human's PII decision, which was about contact data.
Credentials were never in its scope.

### AJ7. S3 unbounded response (A6 HIGH)

ACCEPT. "Every field the call site attached" is an abdication, and the 799-char
sample is one observation, not a bound. A response size bound is now stated, on
top of AJ6's denylist.

### AJ8. Nested vs flattened accessor (A8 MEDIUM)

A's most dangerous finding, and one B did not have. VERIFIED: the LIST path
parses the raw `@message` string (`cloudwatch.ts:130`), where `err` is a NESTED
object - `obj['err.message']` is `undefined`. Only the DETAIL path
(GetLogRecord) sees dot-flattened keys.

A builder taking my fact 3 at face value ships a panel whose `errType`/
`errMessage` are permanently blank in the ONLY environment that has data - the
hermetic lane degrades to `unavailable_local` (`systemStatus.ts:212-214`), so NO
GATE CATCHES IT. Both accessor shapes are now stated explicitly.

### AJ9. Dedup and React key (A7 MEDIUM, A10 MEDIUM, B10 MEDIUM)

VERIFIED: `systemStatus.ts:247` keys on `timestamp|message|errorCode`;
`RecentErrors.tsx:127` keys on `timestamp-correlationId-message`. Adding a
`source` chip and per-row expander state on top of a key that collapses distinct
rows means the chip and the fetched record can mis-associate.

RESOLUTION: `ref` joins the dedup key and becomes the React key. It is unique per
event and already on the wire. The spec's "never rendered" wording, which A
correctly flagged as readable as "never used in the view layer", is fixed.

### AJ10. Perf harness is an unenumerated surface (A9 MEDIUM, B8 HIGH)

VERIFIED: `e2e/performance/templates.ts:151-153` is a closed registry;
`routes.ts:304-306` pins `required('/api/system/errors', ['since'])`;
`routes.test.ts:106-109` asserts that exact list; the artefact scanner rejects a
bare UUID.

`npm run perf:pages` is a sanctioned gate per AGENTS.md, so this is live surface.
The three files join the spec's scope. AJ2's query-param transport helps here
too: no new UUID-bearing PATH template is minted.

### AJ11. S1's Express half under-enumerated (A11 MEDIUM, B18 LOW)

VERIFIED at `errors.ts:137-164`: the headers-sent branch (`:140-143`) and the
normal branch (`:159-162`) emit an IDENTICAL string, and a third WARN branch
(`:151-157`) carries the same `method`/`path` and IS panel-visible with
`includeWarnings` on. VERIFIED that `:154` contains a real em-dash
(`M-bM-^@M-^T` = E2 80 94) - the exact non-ASCII my own section 9 says does not
survive the pipeline.

All three branches are now enumerated, the two error branches are given
DISTINCT strings, and the em-dash is ASCII-ised on the lines S1 touches.

### AJ12. Trace link dead on OOM rows (A12 MEDIUM)

VERIFIED: OOM rows are non-JSON, so `correlationId` stays `null`
(`cloudwatch.ts:127, 144-146`), and `RecentErrors.tsx:52` already guards it. The
spec did not carry the guard forward. Now stated.

### AJ13. Concrete `req.path` writes a phone into `msg` (B1 BLOCKING)

The finding A missed entirely, and it invalidates a sentence I wrote.
VERIFIED: `contacts.ts:2317`, `contacts.ts:2376` and `relayGroups.ts:467` all
carry a raw E.164 in the route path.

My spec said "`jobName` is a registry constant and `method` is a fixed verb, so
neither introduces PII into `msg`" - an enumeration that quietly omitted `path`,
the one component that can carry PII. It also destroyed S1's own stated
rationale, since a concrete path is unbounded-cardinality by construction.

RESOLUTION: the concrete path NEVER enters `msg`. "A concrete path is
acceptable" is struck.

### AJ14. Route template must be deterministic (B11 MEDIUM)

Follows from AJ13 and is accepted with it. VERIFIED: `req.route` is unset for
middleware/body-parser/URIError failures, and when set is MOUNT-RELATIVE -
contacts registers `'/:contactId/phones/:phone'`, so a bare template identifies
nothing.

RESOLUTION: one deterministic rule - `req.baseUrl + req.route.path`, with an
explicit `(unrouted)` token when `req.route` is unset. Never the concrete path.

### AJ15. The trace pivot cannot cross the job hop (B9 MEDIUM)

A genuine design insight neither I nor A had. VERIFIED: `logger.ts:231` resolves
`correlationId = jobRunId ?? pollRunId ?? requestId ?? bootId`, and `dispatchJob`
mints a FRESH `jobRunId` per dispatch (`jobs.ts:297-305`) while the originating
`requestId` survives only as a separate field. So a `job failed` line's
correlationId is the JOB RUN id, and filtering on it returns that job run alone -
nothing about what enqueued it.

That is precisely the motivating case. RESOLUTION: the pivot filters on
`correlationId` OR `requestId`, and the RUNBOOK rewrite must PRESERVE the
existing requestId technique rather than replace it.

### AJ16. telemetry-phone-in-url-pii misdescribed (B13 MEDIUM)

VERIFIED against the issue file, and I was wrong on BOTH counts. It is NOT
OTLP-only: `:21-23` explicitly names the request logger writing `req.path` to
CloudWatch as a PRE-EXISTING half. And it is NOT a prod gate: `:28-33` records
"Gate LIFTED - accepted 2026-08-15 (Cameron)", status `deferred`.

RESOLUTION: the "DISTINCT AND UNAFFECTED" paragraph is struck and replaced with
the honest statement - this change makes the CloudWatch half of that issue
directly renderable in the dashboard, which is consistent with the accepted
posture but is not "unaffected".

### AJ17. Section 8's enumeration incomplete (A17 LOW, B7 HIGH)

VERIFIED. B's enumeration is substantially more complete than mine (12+ sites vs
6), and correctly includes test headers and describe-block names that assert the
retired guarantee. B's list is adopted wholesale, plus A17's
`docs/issues/fake-twilio-messaging-attach-404.md:45`, which quotes the literal
`"msg":"job failed"` as a live Insights search signature that S1 invalidates.

### AJ18. Spike facts internally inconsistent (B15 LOW)

ACCEPT - my sloppiness. The `"30"` stringification was observed on a DIFFERENT
record (the info-level shutdown line), not on the error record that yielded the
`err.*` keys. Both observations are true; the spec conflated two records into
one sentence. Restated with each fact attributed to the record it came from.

### AJ19. IAM default inverted (A14 LOW)

ACCEPT. VERIFIED that `main.tf:282-287` states the repo's preference - scope
where scopable, `"*"` only where AWS forbids it. My spec defaulted to the
permissive branch while telling the builder to verify, which is the wrong
default under time pressure. Inverted: default to the scoped statement, fall
back to `"*"` only on a cited Service Authorization Reference entry.

### AJ20. Job handler count (B17 LOW)

ACCEPT. 13 registrations, not "~20". Also accepted: `defineJobHandler(jobName:
string)` is not a typed registry, so "registry constant" holds by convention
only. Both corrected. B's independent check that "~249 error call sites" is
accurate (248) is noted.

### AJ21. Truncation coverage (B19 LOW)

ACCEPT. The cap covered `errMessage` only while S5 promised a "capped message",
and S1 now appends to `msg`. The cap covers `message` too.

### AJ22. Seam interface break (B20 LOW)

ACCEPT - one sentence. The new method is added to `CloudWatchClientSeam`, and
the spec states that a fake omitting it must throw rather than silently no-op.

### AJ23. Fact 1 overclaims from n=1 (A13 LOW, B16 LOW)

ACCEPT THE WORDING FIX. "Therefore not a design constraint" does not follow from
one sample and does not belong in a section titled "Verified facts". Restated as:
pointer expiry is not designed around; an expired pointer degrades like any other
CloudWatch failure.

### AJ24. Fact 2 ambiguity and the row loop (A15 LOW)

ACCEPT, merged into AJ3's mechanism statement.

---

## REJECTED

### RJ1. Any dual-path retrieval fallback for an expired pointer
(implied by A13, B16)

The WORDING fix is accepted (AJ23). The ENGINEERING conclusion is rejected.
Building a second retrieval path - GetLogRecord with a correlationId re-query
fallback - to hedge a risk that measured fine at the widest window the panel
offers is exactly the complexity this design already declined once. The failure
mode is bounded and visible: the expander degrades to the same
`{ available: false, reason }` every other CloudWatch failure produces. A second
path would be permanently maintained, permanently tested, and exercised
approximately never.

### RJ2. A2's and B12's proposed remedies (query param / POST body, as stated)

The FINDING is accepted and is one of the two most important in the round
(AJ2). The remedies as proposed are rejected: a raw pointer in a naive query
parameter is corrupted by `qs` decoding `+` as a space, which neither reviewer
caught, and a POST body turns a read into a write for no gain. base64url
transcoding solves the transport at the source and keeps the route a GET.

---

## DEFERRED

### DF1. The CP1252 log-encoding defect (spec section 9)

Both reviewers touched its consequences (A11c, B18) in the narrow case of lines
S1 already edits, and those lines ARE fixed under AJ11. The general defect - the
build/runtime/ingest path transcoding UTF-8 to CP1252 - stays filed as a Tier-2
issue and out of this mission's scope. It is a separate root cause in a separate
subsystem and would expand this change into the deploy pipeline.

---

## Round outcome

Round 1 changed many decisions, including two that invalidate sentences the spec
asserted as fact (AJ6, AJ13, AJ16) and one that would have shipped a permanently
blank field no gate could catch (AJ8). A round 2 is therefore warranted.

Per the skill's continuation rule, round 2 continues reviewer B - it landed the
most accepted decision-changing findings (B1, B9, B13, B7, B14) - and is handed
A's report so the two-reviewer coverage is not lost.

---

# Round 2 adjudications

Reviewer: spec-r2-b.md (14 findings, 2 BLOCKING). Continued agent, so it held its
r1 context and had my adjudications plus reviewer A's report.

Counts: 14 ACCEPT (one of them reversing a round-1 REJECT), 0 REJECT.

Round 2 found the accepted-but-undelivered case the stop rule exists to catch:
AJ15 was accepted in round 1, written into the route, and reaches no data path.

### AJ25. requestId does not exist for poll-enqueued jobs (N1 BLOCKING)

VERIFIED at `jobs.ts:174-179`: the envelope copies `requestId`,
`conversationId`, `tenantId`, `placementId` - and NOT `pollRunId` or `bootId`. A
job enqueued from a worker poll tick therefore carries no upstream id at all, so
r2's `requestId` remedy silently does nothing for the entire worker-poll class
(tour reminders, placement nudges, roster actions, extraction, group guardrails).

RESOLUTION: propagate `pollRunId` through the envelope alongside `requestId`, and
let the pivot accept it as a third id.

THIS DELIBERATELY WIDENS A NON-GOAL. "No change to what is WRITTEN to logs beyond
S1's message strings" now has a second, named exception. It is justified rather
than convenient: AGENTS.md requires that "All job traffic goes through
`jobs.enqueue()` / `defineJobHandler()` so correlation and trace context are
preserved", and for poll-originated jobs the current code does not preserve it.
This is a correlation-plumbing fix in the spirit of the existing rule, not new
scope. `correlationId` resolution is unaffected (`jobRunId` still wins the `??`
ladder at `logger.ts:231`), so no existing line changes shape.

REJECTED sub-option: having the pivot also accept `conversationId` / `tenantId` /
`placementId`. Those are DOMAIN ids, not correlation ids; searching by them is a
different feature with a different security surface.

### AJ26. Nothing carries requestId to the panel (N2 BLOCKING)

ACCEPT. The r2 route accepted `?requestId=` while S2's field list, the
`ErrorEventView` shape and S5's row all carried `correlationId` alone - so the
half of S4 that closes the job hop was unreachable from every user surface.
`requestId` and `pollRunId` join the projection and the row.

### AJ27. The denylist is the mechanism section 6 condemns (N3 HIGH, N4 HIGH)

ACCEPT BOTH, and this is the sharpest finding of the round: I diagnosed
path-lists as structurally unable to enumerate what they have not met, then
answered with a three-prefix path list. `err.cause` is a concrete hole -
an axios error wrapped as a cause flattens to
`err.cause.config.headers.Authorization`, matched by neither the logger's redact
list nor my three prefixes.

VERIFIED N4: `errors.ts:77-82` reads `err.response.status` specifically because it
is diagnostic, and `status` is one of the three fields in the adjudicated
`ErrorSummary` allowlist (`errors.ts:34-38`). My denylist would have dropped the
single most useful triage field on a vendor HTTP failure.

RESOLUTION - replace the denylist with a TWO-TIER rule:
- NON-`err` fields pass through. They are app-authored: the call site chose to
  attach them, and they are the point of the detail view.
- The `err.*` subtree is ALLOWLISTED to `message`, `stack`, `type`, `name`,
  `code`, `status`, plus `response.status`. Everything else beneath `err` is
  dropped at any depth, which closes `err.cause.*` and every future
  `*.config.*` / `*.request.*` by construction rather than by enumeration.

This matches the two places the repo already solves this (`ErrorSummary`,
`SAFE_HEADER_ALLOWLIST`) instead of inventing a third, weaker shape.

### AJ28. source union contradiction (N5 HIGH)

ACCEPT - self-inflicted by the rewrite. r1 had the wrong enum; r2 had the right
enum plus an undeclared fourth state and no chip branch. The union is
`'app' | 'worker' | 'system' | 'unknown'` and S5 renders all four.

### AJ29. The trace link carries no window (N6 HIGH)

ACCEPT. The panel's selector goes to 7d while the route defaults to 24h, so the
routine case - operator picks 7d, opens a five-day-old error, clicks trace -
returns zero rows, and an empty trace is indistinguishable from "no context" on
a feature whose whole purpose is context.

RESOLUTION, and deliberately not the reviewer's either/or: the trace is ANCHORED
ON THE ROW'S TIMESTAMP with a bounded bracket around it, not on the panel's
rolling window. A rolling window is the wrong frame for "what happened around
this event" - it would still mislead near a window edge.

### AJ30. base64url loses to encodeURIComponent (N7 MEDIUM) - REVERSING RJ2's REPLACEMENT

ACCEPT THE CONTEST. I lose this one and the reviewer is right.

My RJ2 rejected "a raw pointer in a naive query parameter", which is correct, and
then treated that as establishing base64url - a strawman, because the reviewer's
remedy done properly is `encodeURIComponent`, not a raw value.
`encodeURIComponent` encodes `+` as `%2B`, `/` as `%2F` and `=` as `%3D`; both
parsers decode `%2B` back to a literal `+`, since the `+`-to-space rule applies
only to an unencoded `+`.

Against that, base64url is strictly more risk for the same result: it needs a
transform AND an inverse with re-padding, it assumes `=` is trailing padding -
a POSITIONAL property my own spike never measured, while fact 3 explicitly warns
its sample does not bound the general case - and if the inverse is wrong the
failure is swallowed by S3's degraded contract and invisible to every gate,
which is AJ8's trap exactly.

RESOLUTION: `ref` is the RAW pointer, carried as a query value encoded with
`encodeURIComponent`. No transcoding, no inverse. RJ2's replacement is withdrawn;
RJ2's rejection of the raw/POST forms stands.

### AJ31. The detail route never scopes the record to this env (N8 MEDIUM)

ACCEPT - a genuine security improvement neither round-1 reviewer found. A `ref`
is an account-scoped pointer bound to nothing; if S6's IAM verification lands on
the `resources = ["*"]` branch, the route reads any log record in the account,
including another environment's. The route now rejects a record whose normalised
`@log` is not one of this env's three configured groups. One comparison, and it
makes the route's scope independent of an IAM outcome the spec admits is unknown.

### AJ32. fakeSeam misread (N9 MEDIUM)

ACCEPT. VERIFIED at `systemStatus.service.test.ts:40-50`: `Partial<>` is the
INPUT type; the return is a hardcoded two-property literal typed as the full
seam. Adding a required method is a `npm run typecheck` failure - a separate
required gate - not a runtime throw. The spec described the wrong mechanism for
the one file it singled out. It now states the real work: add stubs for both new
methods.

### AJ33. Perf-harness instruction risks the red gate it warns about (N10 MEDIUM)

ACCEPT. `SYSTEM_GETS` entries use `required(...)`, meaning the request MUST be
observed on the profiled page load - but the detail and trace requests fire only
on a click a page-load profile never performs, so a `required` entry fails the
contract from the other direction. `conditional(...)` is the right helper and my
spec never named it. My "all three must change together" was also an over-claim.
Restated as a condition rather than a mandate.

Credited, not re-litigated: the reviewer verified the safe half - `matchTemplate`
keys on segment count so the 4-segment template is unambiguous, and query VALUES
never reach artefacts (only sorted key names), so neither the 220-char pointer
nor a UUID value trips the privacy scanner.

### AJ34. Dedup is now effectively by-ref (N11 MEDIUM)

ACCEPT. Adding `ref` to the key makes the other components inert, since `@ptr` is
unique per log event. The spec now says so deliberately and states the
absent-`ref` behavior rather than leaving a truncated-vendor-text key to take
over silently.

### AJ35. Two capped fields, one flag (N12 LOW)

ACCEPT. One flag per field.

### AJ36. WARN branch message treatment unstated (N13 LOW)

ACCEPT. `req.route` is always unset on that branch, so the rule yields
`method + (unrouted)` identically every time. Stated explicitly so a builder does
not have to guess whether to apply it.

### AJ37. Unsourced CloudFront %2F claim (N14 LOW)

ACCEPT. With AJ30 the whole path-segment rationale is moot; the unsourced
sentence is removed rather than sourced.

### AJ38. Section 8 tells the builder to fix a comment that is not wrong

ACCEPT (the reviewer's unnumbered nit). Since S2 now KEEPS the
`(unparseable log line)` behavior, the "PII-safety: raw text never surfaced"
comment at `cloudwatch.adapter.test.ts:129` remains true of the list path. The
entry is rewritten rather than listed for correction.

---

## Round 2 outcome

Round 2 changed decisions again, including two BLOCKING and one reversal of a
round-1 rejection. Not converged: a round 3 is warranted under the stop rule.

The pattern is informative and worth carrying into round 3: every round-2
BLOCKING was a fix from round 1 that was written into one layer and not carried
through the others (AJ15 into the route but not the envelope, the projection or
the UI). Round 3's charge should weight END-TO-END DELIVERY of the r2 changes
over fresh-surface hunting.

---

# Round 3 adjudications

Reviewer: spec-r3-b.md (9 findings, 2 BLOCKING). Counts: 9 ACCEPT, 0 REJECT.
The reviewer proposed NO accept reversals and explicitly judged the round-2
decisions correct but incompletely delivered. The end-to-end walk table it
produced is the most useful artefact of the whole review.

### AJ39. Raw `@message` defeats the `err` allowlist (F1 BLOCKING)

ACCEPT, and it is the r2 denylist finding reincarnated one layer out: I applied
the allowlist to the flattened fields and then shipped the original line
containing everything the allowlist had just dropped. Two sentences in one slice
cancelling each other.

RESOLUTION: the response NEVER carries raw `@message`. For a JSON line the
flattened allowlisted fields already hold everything of value. For a NON-JSON
record (kernel OOM, V8 OOM, raw stderr) the raw text is the only content and
carries no vendor error object by construction, so it is surfaced under an
explicit, capped `rawText` field instead. The guarantee is then true by
construction rather than by hope.

### AJ40. The anchored window has no transport (F2 BLOCKING)

ACCEPT. AJ29 was written as prose and never given a parameter, a width, or a
sender - the server cannot derive a row's timestamp from a UUID without running
the query it is trying to bound.

RESOLUTION: the route takes an explicit `?at=<ISO timestamp>` anchor; the row
supplies it from its own `timestamp`; the bracket is a stated constant of
+/- 5 minutes; and the spec restates the existing seam's capitalised warning that
`StartQuery` takes epoch SECONDS (`cloudwatch.ts:229`).

### AJ41. Ascending sort can truncate the failure out of its own trace (F5 HIGH)

ACCEPT - the symmetric defect of the descending case, and sharper than it looks
because S2 makes `pollRunId` a valid pivot and one poll tick fans out to many
jobs, so a `pollRunId` trace is the widest of the three by construction.

RESOLUTION - a two-sided row budget, because it is the only shape that actually
GUARANTEES the anchor line is present: up to N/2 rows at-or-before the anchor
and up to N/2 after it, merged ascending. Plus an explicit `truncated` flag the
UI must surface. The reviewer's closing line is the requirement: a trace that
omits the failure is worse than no trace, because it looks complete.

### AJ42. The dashboard wire layer is unenumerated (F3 HIGH)

ACCEPT. `SystemErrorEvent` (`dashboard/src/api/types.ts:335-346`) is a
HAND-MAINTAINED MIRROR, not a shared type, and the spec touched it only to
rewrite a docblock - so all eight new fields stop at the wire. Neither new route
has a client function in `endpoints.ts` or a hook alongside
`useSystemStatus.ts:177-230`. `npm run typecheck` bounds the damage on the type,
but the client functions and the hook were pure unscoped work.

Three files join the scope explicitly.

### AJ43. The allowlist deletes a SCALAR `err` (F4 HIGH)

ACCEPT, with the irony noted: six verified call sites log `err` as a string, and
two of them (`systemStatus.ts:204`, `:258`) are the panel's OWN degraded-read
diagnostics - so when System Status failed to read CloudWatch, the detail view
would delete the reason. One clause added: a scalar `err` is KEPT, since it is by
definition the message and `message` is allowlisted.

### AJ44. Truncation flags produced and never consumed (F6 MEDIUM)

ACCEPT - AJ35 landed in the producer and the test list, not the consumer. S6 now
states where the indicator renders. The flags' entire justification was a UI
affordance no slice built.

### AJ45. The trace's log groups were never stated (F7 MEDIUM)

ACCEPT, and this one went unnoticed by two reviewers and me across three rounds:
the r1 draft said "across the app and worker groups", the r2 rewrite dropped the
sentence, and nothing restored it - leaving the new seam method's FIRST argument
unspecified.

RESOLUTION: app + worker. `system` is excluded deliberately - kernel lines carry
no correlation id at all, so scanning it is bytes for nothing. Stated as a
decision, not left as a default.

### AJ46. Zero-or-multiple id parameters (F8 MEDIUM)

ACCEPT. Missing-or-multiple is a 400, matching the `since` precedent at
`system.ts:68-72`; a malformed UUID is the degraded 200 the spec already
promises. The two are observably different to the UI and a builder was left to
guess.

### AJ47. "NO EXISTING LINE CHANGES SHAPE" is false (F9 LOW)

ACCEPT. The mixin spreads the whole context (`logger.ts:232`), so every
poll-enqueued job's lines DO gain a `pollRunId` field - that is the point of the
change. The true and narrower claim is that the `correlationId` VALUE is
unchanged. Worth fixing precisely because that sentence is the spec's entire risk
argument for touching shared plumbing.

### AJ48. Client transport path (reviewer's section D caution)

ACCEPT. `dashboard/src/api/client.ts:44-52` already builds queries with
`URLSearchParams`, which encodes the pointer's alphabet identically to
`encodeURIComponent` - so AJ30 works end to end with zero client changes. The
spec now names that helper as the intended path, so a builder does not hand-roll
a URL and bypass it.

---

## Round 3 outcome

Round 3 changed decisions, so the loop continues to round 4 - which is the HARD
CAP. Convergence signal is good and worth recording: findings fell 24 -> 14 -> 9,
the reviewer proposed no accept reversals, and it judged every round-2 decision
CORRECT and only incompletely delivered. The remaining defects are delivery gaps
in prose, not contested design.

If round 4 still changes decisions, the skill's rule applies without exception:
STOP and put the open findings to the human as a decision rather than quietly
running a fifth round.

---

# Round 4 adjudications (HARD CAP)

Reviewer: spec-r4-b.md (9 findings, 2 BLOCKING). Counts: 9 ACCEPT, 0 REJECT.

The reviewer declared NOT CONVERGED and refused to soften to close the round -
correctly. Both BLOCKING findings were EDIT SEAMS: an r4 paragraph contradicting
a paragraph r4 did not touch. That vindicates the decision to make r4 by targeted
edit rather than full rewrite AND identifies the cost of doing so.

Its end-to-end walk showed four of six r3 fixes now reaching every layer, against
two of six in r3.

### AJ49. The +/-5min bracket cancels the job-hop pivot (F1 BLOCKING) - HUMAN DECISION

VERIFIED: `infra/modules/jobs/main.tf:36`/`:41` give a ~8-minute retry span
before the DLQ (120s visibility x 5 receives); `jobs.ts:112-114` plus the
`jobs.ts:104` docblock give a delayed enqueue up to ~12 minutes. So on the DLQ
triage path - the panel's headline scenario per `RUNBOOK.md:2169` - a 5-minute
look-back reaches neither the enqueue nor the first attempt. My constant made S2,
a deliberate widening of a non-goal, buy nothing in the case that justified it.

PUT TO THE HUMAN, DECIDED 2026-08-24: ID-DEPENDENT bracket. `-5min/+5min` for a
`correlationId` pivot (one job run, genuinely local); `-30min/+5min` for
`requestId`/`pollRunId` (the cross-hop ids, where reaching backwards is the
entire point). Look-ahead stays short in both.

### AJ50. Two-sided budget contradicts the ascending-sort rule (F2 BLOCKING) - HUMAN DECISION

ACCEPT. I bolted a two-sided budget onto a slice that says "the query sorts
ascending server-side", with a section 7 test pinning that, and never reconciled
them - three sentences that cannot all be true. Getting the before-half out of
Insights REQUIRES a descending query.

PUT TO THE HUMAN, DECIDED 2026-08-24: TWO OPPOSITE-SORTED QUERIES - descending
limit 25 over `[bracketStart, at]` reversed, ascending limit 25 over
`(at, bracketEnd]`, merged. The only shape that guarantees the anchor is present
and bounds both sides. The ascending-sort paragraph is reworded so it reads as
the diagnosis it is, not as a competing design.

### AJ51. `rawText` and pass-through are false for the system group (F3 HIGH) - HUMAN DECISION

VERIFIED: `infra/modules/ec2/main.tf:410-411` ships the ENTIRE
`/var/log/messages` to `/hc/<env>/system` - sshd, sudo, systemd, docker,
cloud-init - not "kernel OOM lines". My justification ("carries no vendor error
object") was true, irrelevant, and aimed at the wrong threat.

PUT TO THE HUMAN, DECIDED 2026-08-24: SHOW the host syslog raw text. Reasoning is
section 2's, not the bad one: admin-only and server-enforced, host operational
data rather than contact PII, and the OOM rows are exactly where a synthesized
label tells an operator nothing. What it exposes is now stated plainly in the
spec rather than hidden behind a false premise.

### AJ52. The `rawText` premise was never sampled (F4 MEDIUM)

ACCEPT, and RESOLVED BY MEASUREMENT rather than by marking it UNVERIFIED. Both
spike records were JSON, so the "a non-JSON record returns no application fields"
claim was an inference presented as fact in the one section restructured to stop
exactly that. I sampled a real `/hc/prod/system` record: it returned ONLY
`@`-prefixed metadata plus tokens - no `err`, no `msg`, no `level`. Promoted to
fact 8.

### AJ53. S4 had no missing-parameter rule while S5 gained one (F5 MEDIUM)

ACCEPT - an asymmetry my own F8 edit created. Both siblings now answer a MISSING
required parameter with 400 and a PRESENT-but-malformed one with the degraded
200. The client distinguishes the two, so they drive different UI paths.

### AJ54. Three constants remained prose (F6 MEDIUM)

ACCEPT, after r4 made concreteness an explicit principle and then left three
quantities abstract. Now stated: trace row budget 25 per side (matching
`ERROR_EVENT_LIMIT`, `systemStatus.ts:49`, rather than inventing a number), S4
response bound 64 KB, `rawText` cap 4000 characters.

### AJ55. Section 7 not extended for two r4 additions (F7 MEDIUM)

ACCEPT. The truncation indicators - whose entire justification is being shown -
had no component test, and the epoch-SECONDS anchor conversion had no assertion
despite the list path already pinning the equivalent at
`cloudwatch.adapter.test.ts:120-121`. Both added, along with the two-query
mechanism and the id-dependent bracket.

### AJ56. Field optionality unstated (F8 LOW)

ACCEPT. `source` and `ref` are REQUIRED and non-null; the rest follow the
`errorCode?` convention. The spec now warns that this WILL break existing partial
fixtures under typecheck and instructs the builder to fix the fixtures rather
than weaken the types.

### AJ57. Section 2's framing predates S2 (F9 LOW)

ACCEPT. Section 2 is the paragraph a human reads to decide whether this touches
storage, and it still said the change adds no new data anywhere. It now names
S2's `pollRunId` write explicitly.

---

## Review closed at the cap

4 rounds, 69 findings, 56 accepted, 1 rejection reversed. No fifth round: the
reviewer's own recommendation, and the right call - the two open items were
CHOICES the spec had not made, not defects still being hunted, and both are now
made. F4-F9 were builder-resolvable polish and are folded in.

The single most useful lesson for the plan phase, from the reviewer's own
diagnosis across rounds 2-4: EVERY blocking finding after round 1 was a decision
accepted in one round and delivered into only one layer. The plan must therefore
be written layer-by-layer per decision, not decision-by-decision, and the
independent reviewers at phase 6 should be given the same end-to-end walk charge
that produced these findings.

---

# Round 5 adjudications (human-requested, past the cap)

The human overrode the hard cap and asked for one more round. TWO reviewers ran
it: reviewer B continued (rounds 1-4 context), and reviewer A was resumed after
FOUR revisions it had never seen - a deliberately fresh lens on material B had
approved repeatedly.

That pairing paid for itself. A returned 10 findings, NINE in material it had
never read, including the round's most serious defect - which B had walked past
four times. B returned 8, including a whole missing rendering surface.

Counts: 18 findings, 18 ACCEPT, 0 REJECT. Two resolved by MEASUREMENT rather than
by specification. One adjudication of mine (AJ33) partially REVERSED.

### AJ58. The two-query split is inexpressible at second granularity (A1 BLOCKING)

THE ROUND'S MOST SERIOUS FINDING, and a textbook edit seam: the epoch-SECONDS
paragraph is AJ40 (round 3), the two-query split is AJ50 (round 4). Round 4
reconciled AJ50 against the ascending-sort paragraph - it added a whole NOTE FOR
THE BUILDER to do so - and never reconciled it against the epoch-seconds
paragraph twenty lines above.

`at` is a millisecond ISO timestamp; `StartQuery` takes whole seconds
(`cloudwatch.ts:229-237`). A split exactly at `at` cannot be expressed. The
convention a builder mirroring `cloudwatch.ts:233-234` would reach for - `ceil`
for BEFORE's end, `floor` for AFTER's start - OVERLAPS the windows by up to a
second, returning every line in the anchor's second INCLUDING THE FAILURE ITSELF
from both queries and rendering it twice. Same-second collisions are routine for
a `pollRunId` fan-out, which is the widest pivot by the spec's own argument. No
gate can see it: the tests use an injected fake and the hermetic lane never
reaches CloudWatch.

RESOLUTION (A's own proposal, adopted): the anchor's whole second belongs to the
BEFORE query. `endTime = floor(at/1000)`, `startTime = floor(at/1000) + 1`.
Windows disjoint, anchor guaranteed, no merge dedup rule needed. The spec also
now warns explicitly against the ceil/floor convention and says why.

### AJ59. The trace VIEW does not exist anywhere in the spec (B1 BLOCKING)

ACCEPT. The trace ROUTE was specified across four rounds in exhaustive detail -
ids, bracket, sort, limit, shape, validation, degradation, IAM - and nothing ever
said where its results RENDER. No component, no file in S6's list, no test. B
confirmed no trace surface exists today (`grep -rln "trace" dashboard/src` returns
only the `traceparent` family).

RESOLUTION: a new trace view component joins S6's file list with a stated
contract - timeline rows, the anchor marked visibly, per-side truncation
surfaced, empty distinguished from degraded - while leaving presentation within
the panel's idiom to the builder. What is not optional is that it exists and is
tested.

### AJ60. Section 7 had no test for S1 at all (A3 HIGH)

ACCEPT, and the most alarming omission of the review. Section 7 listed 18 items
covering S2-S6 and NOT ONE for S1 - including the PII refusal that closed round
1's BLOCKING AJ13. That rule keeps a tenant's phone out of a low-cardinality
field section 8 simultaneously teaches operators to grep, it lives only in prose,
and `req.path` in `msg` typechecks, lints and renders fine. Every gate was blind
to the single highest-consequence rule in the spec.

RESOLUTION: S1 gets its own test block, with the refusal asserted directly -
given a request to a `:phone` route, `msg` contains the TEMPLATE and not the
concrete segment.

### AJ61. `ref` required vs absent-`ref` dedup (A2 HIGH)

ACCEPT - a seam between AJ56 (round 4, required/non-null) and AJ34 (round 2,
absent-`ref` dedup behavior). Reaches three layers: the type, the dedup key, and
the React row key, where an absent `ref` would give every such row the key
`undefined` and reintroduce AJ9 exactly.

RESOLUTION: `ref` IS required and non-null - every Insights row carries `@ptr`
once it is in the `fields` clause. The absent-`ref` requirement is deleted; the
retained key components are documented as inert rather than as a live path.

### AJ62. `@ptr` stability was never measured (A7 MEDIUM) - RESOLVED BY MEASUREMENT

ACCEPT the finding and close it with data rather than a caveat. A was right that
the property three mechanisms depend on is STABILITY across queries, not
uniqueness, and that section 3 measured only length, charset and resolvability.

I fetched the same event through two independent Insights queries with distinct
query ids: BYTE-IDENTICAL pointers. Promoted to fact 9. Dedup across the three
merged queries and the React row key across refreshes are both sound.

### AJ63. The perf source-citation ledger (A4 MEDIUM) - REVERSES HALF OF AJ33

ACCEPT, and my round-3 adjudication was wrong. AJ33 concluded "if the profiler
does not reach the expander, leave `e2e/performance/` alone." That is unsafe for a
reason round 3 never considered: the harness pins SOURCE LINE RANGES into
`useSystemStatus.ts` - the exact file S6 mandates editing - at `routes.ts:680`
and `:762`, with `collect.test.ts:352-364` asserting them as literal strings.

Verified. S6 adds imports above both ranges, so the citations rot. The trap runs
both ways: leave them and every gate stays green while the ledger silently lies
(`cited()` only regex-checks citation SHAPE); update only `routes.ts` and
`collect.test.ts` goes red on a required gate.

RESOLUTION: section 7 now carries TWO separate perf obligations - endpoint
declarations (conditional, as AJ33 correctly established) and the source-citation
ledger (UNCONDITIONAL, update all three together).

### AJ64. The document does not stand alone (A8 MEDIUM)

ACCEPT, and it is the finding only A could have made - it is the one respect in
which the reviewed document was WORSE than the draft A saw in round 1. Four
rounds of defending against critique left the review's bookkeeping inside the
requirements: adjudication IDs as the sole rationale for a type decision,
"an earlier draft..." constructions, a withdrawal notice about text no builder
ever saw, and - the sharpest symptom - a slice that needed a NOTE FOR THE BUILDER
explaining which of its own two paragraphs was the design.

RESOLUTION: full rewrite stating requirements without provenance. Rejected
alternatives moved to Appendix A, where they are useful without being argued
with. A's caveat honoured: the EARNED insistent notes stay ("do not reconcile
them", "do not re-investigate", "not a correction"), because those stop a builder
redoing settled work.

### AJ65. Bracket policy vs link precedence (B3 MEDIUM)

ACCEPT. The id-dependent bracket and S6's id precedence were written
independently: precedence prefers `requestId`/`pollRunId`, so the tight `-5min`
branch is reached only by rows carrying nothing else. The "tight and cheap common
case" rationale was fiction.

RESOLUTION: no redesign - the per-id rule is still correct - but the spec now
states plainly which branch is common and which rows reach the tight one, so
nobody optimises for a path that is rarely taken.

### AJ66. Two queries double a bounded budget (B4 MEDIUM)

ACCEPT. Each Insights poll has a ~8s ceiling (`cloudwatch.ts:37-39`) and the spec
never said whether the two queries run in parallel. Sequential doubles the
worst-case wait on a user click. Now explicitly `Promise.all`, following the
existing precedent at `systemStatus.ts:227`.

### AJ67. Trace row omits `source` (A5 MEDIUM)

ACCEPT. S3 makes `source` REQUIRED on a single-row view on the grounds that an
unrepresented state is a defect, and the multi-row CROSS-PROCESS view dropped it -
on a two-group query whose entire purpose is the app-to-worker hop. Cost of
fixing: none, since the query already spans two groups and S3's normalisation is
shared.

### AJ68. S5's accessor shape unspecified (A6 MEDIUM)

ACCEPT - AJ8 reincarnated in the slice added after AJ8 was accepted. The spec
warned emphatically that list and detail read `err` differently and then added a
THIRD path without saying which shape it uses or stating its `fields` clause.
Now: S5 parses raw `@message` (NESTED), clause `@timestamp, @message, @log`.

### AJ69. S4/S5 validation asymmetry (B6 MEDIUM)

ACCEPT. S4 claimed "the same two answers as S5" while S5 has a THIRD case - a
present-but-malformed `at` answering 400 where a present-but-malformed `ref`
answers 200. Both routes now state their own rules explicitly rather than one
claiming parity with the other.

### AJ70. S4's truncation flags never reached S6 (B5 MEDIUM)

ACCEPT - the same producer/consumer gap AJ44 fixed for the 300-char flags,
recurring for the `rawText` cap and the 64 KB bound. S6 now enumerates EVERY flag
the server produces and where each renders.

### AJ71. `errType`/`errMessage` rendered by no slice (B2 HIGH)

ACCEPT, together with A10's overlap finding: the fallback ladder can make
`message` and `errMessage` the same string carrying two independent truncation
flags, which the collapsed row would render twice with two markers. S6's row
enumeration also contradicted its own truncation paragraph about whether
`errMessage` was in the row.

RESOLUTION: the collapsed row renders `message` plus `errType`; `errMessage` is
not rendered separately there, so the duplicate case cannot arise.

### AJ72. AWS transport metadata would ship (B7 LOW)

ACCEPT. Fact 8 newly documented `backwardToken`/`forwardToken`, `@logGroupId`,
`@aws.*`, `@entity.*` - which the non-`err` pass-through tier would have shipped,
contradicting the response's stated three-key metadata set. The response is now
an explicit key set with the AWS transport metadata named as excluded.

### AJ73. Optionality wording collision (B8 LOW)

ACCEPT. "`requestId` and `pollRunId` are NOT optional extras" (meaning
architecturally necessary) sat eight lines above a rule making them optional
FIELDS. Reworded to separate the two senses.

### AJ74. Wrong citation for the panel's selector (A9 LOW)

ACCEPT. `systemStatus.ts:45` is the service's `WINDOW_MS` map, not the selector;
the selector is `RecentErrors.tsx:16-20`. The argument was right and the citation
pointed a builder at the wrong file to confirm it.

---

## Review closed

5 rounds, 2 reviewers, 87 findings, 74 accepted, 2 rejected, 1 deferred, and TWO
of my own rulings reversed (RJ2's replacement in round 2, AJ33's carve-out in
round 5). Findings by round: 24, 14, 9, 9, 18 - the last inflated by introducing
a fresh reviewer, not by regression.

Both reviewers independently recommended no sixth round. A's closing judgement:
"nine of these ten are in material I had never seen, and the tenth is a genuine
hole in a carve-out made after my round."

TWO LESSONS FOR THE BUILD PHASE, both earned expensively:

1. EVERY blocking finding from round 2 onward was a decision accepted in one
   round and delivered into only one layer. The plan must be written
   layer-by-layer per decision, and phase-6 reviewers must get the end-to-end
   walk charge that produced these findings.
2. A FRESH REVIEWER FOUND WHAT FOUR ROUNDS OF THE CONTINUING ONE MISSED. Keeping
   a reviewer alive is right for continuity, but a long-running reviewer stops
   seeing what it has already approved. At phase 6, pair the continuing reviewer
   with one that has never read the diff.
