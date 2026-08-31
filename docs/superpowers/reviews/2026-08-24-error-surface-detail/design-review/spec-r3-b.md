# Adversarial design review - Error surface detail (spec r3, reviewer B, round 3)

Spec: `W:\tmp\error-surface-detail\docs\superpowers\specs\2026-08-24-error-surface-detail-design.md` (DRAFT r3)
Adjudications read: rounds 1 and 2, `.superpowers\design-review\adjudications.md`
Repo: `W:\tmp\error-surface-detail` (read-only; no tests, builds, or e2e runs)
Date: 2026-08-24

Charge honoured: I walked each r3 change from the log line -> adapter -> service
-> route -> wire type -> component, rather than hunting fresh surfaces. Four of
the eight findings below are layer-gaps of exactly the AJ15 kind. Every claim
about existing behavior cites a file:line I opened this round.

---

## A. END-TO-END WALKS - the verdict per change

| r3 change | log line | adapter | service | route | wire type | component | verdict |
|---|---|---|---|---|---|---|---|
| `pollRunId` propagation (S2) | OK | OK | OK | OK | **GAP (F3)** | **GAP (F3)** | broken at the wire |
| four-value `source` (S3/S6) | n/a | OK | OK | OK | **GAP (F3)** | OK | broken at the wire |
| per-field truncation flags (S3) | n/a | OK | OK | OK | **GAP (F3)** | **GAP (F6)** | produced, never consumed |
| `err` allowlist (S4) | n/a | OK | n/a | **DEFEATED (F1)** | n/a | n/a | control is a no-op |
| trace id precedence (S6) | OK | OK | OK | OK | **GAP (F3)** | OK | broken at the wire |
| anchored trace window (S5) | n/a | **NO MECHANISM** | n/a | **NO PARAMETER (F2)** | n/a | **NOT SENT (F2)** | unbuildable |

---

## B. FINDINGS

### F1. [BLOCKING] S4 ships the raw `@message` alongside the allowlisted fields, which defeats the `err` allowlist entirely

**What is wrong.** Two sentences in the same slice cancel each other.

S4 RESPONSE, lines 255-257:

> the flattened record - `err.message`, `err.type`, `err.stack`, the fields the
> call site attached, plus `@log`, `@logStream`, `@ingestionTime` and **the raw
> `@message`**.

S4 FIELD RULE, lines 259-271: the `err.*` subtree is allowlisted to seven keys,
"Everything else beneath `err` is dropped AT ANY DEPTH."

Fact 6 (lines 82-84) says what `@message` is: "the complete raw line". S6 line 365
renders it ("and the raw record"). So the response drops
`err.config.params` / `err.config.url` / `err.cause.config.headers.Authorization`
from the flattened keys and then hands the client the original line containing
all of them.

Section 6 lines 435-438 states the guarantee this is supposed to deliver:

> That is exactly why S4 uses an ALLOWLIST under `err` rather than a denylist ...
> an allowlist closes the class by construction, including nests nobody has met yet.

It does not close anything while `@message` is in the payload. The only nests
that are safe there are pino's three literal redact paths, which are censored at
write time (`app/src/lib/logger.ts:204-223`) - and section 6 lines 426-428 lists
precisely the ones that are NOT: `err.config.url`, `err.config.params`,
`err.config.baseURL`, `err.config.auth`.

**Implies.** The allowlist landed on the flattened-field layer and was not
carried to the raw-line layer of the same response - the AJ15 pattern, inside a
single slice. This is the r2 denylist finding reincarnated: the mechanism does
not deliver the stated guarantee. Fix by one of: drop `@message` from the
response; or parse it, apply the same two-tier rule, and re-serialise; or state
plainly that the credential control is abandoned and section 6's "closes the
class by construction" is struck. Do not ship the sentence and its contradiction
together.

---

### F2. [BLOCKING] The anchored trace window has no transport - the route takes no anchor, the link sends none, and the bracket has no size

**What is wrong.** AJ29's fix is stated only as prose. S5 line 329-330:

> **WINDOW - ANCHORED, NOT ROLLING.** The trace is anchored on the ROW'S
> TIMESTAMP with a bounded bracket around it.

The route signature two paragraphs earlier (lines 307-308) is:

> `GET /api/system/trace` accepting **exactly one of** `?correlationId=`,
> `?requestId=`, or `?pollRunId=`

There is no anchor parameter. The server cannot derive the row's timestamp from a
UUID without first running the very query it is trying to bound. S6's trace-link
paragraph (lines 372-378) specifies only which id wins - it never says the link
carries a timestamp. Section 7's trace tests (lines 469-470) assert the ascending
sort and nothing about the anchor.

Three further unstated quantities, all needed to write the seam method: the
bracket WIDTH (a minute? an hour? asymmetric?), and the `startTime`/`endTime`
pair the SDK requires - `StartQuery` takes epoch SECONDS, as the existing seam
comments in capitals at `app/src/adapters/cloudwatch.ts:229`
("CRITICAL: Insights StartQuery uses epoch SECONDS, not milliseconds").

**Implies.** S5 cannot be built. A builder will either invent a bracket and a
parameter name, or quietly fall back to the rolling window AJ29 rejected - and
the rolling-window failure mode (empty trace, indistinguishable from "no
context") is invisible in the hermetic lane, which degrades to
`unavailable_local` (`app/src/services/systemStatus.ts:212-214`).

---

### F3. [HIGH] The entire dashboard wire layer is unenumerated: the mirrored type gains none of the eight new fields, and neither new route has a client or a hook

**What is wrong.** S3 line 173-175 extends `ErrorEventView` with eight fields.
The dashboard does NOT share that type - it hand-maintains a mirror, and the
spec touches it only to rewrite a comment.

- `dashboard/src/api/types.ts:335-346` declares `SystemErrorEvent` independently
  with FIVE fields: `timestamp`, `level`, `message`, `correlationId`,
  `errorCode`. Section 8 line 517 lists `types.ts:334-346` for a DOCBLOCK
  rewrite only. Nothing in S3 or S6 says the interface gains `jobName`, `event`,
  `errType`, `errMessage`, `source`, `ref`, `requestId`, `pollRunId` or the two
  truncation flags. The mirroring obligation is stated in the panel's own origin
  spec (`docs/superpowers/specs/2026-06-29-settings-dashboard-design.md:163`,
  "Mirror the backend contracts").
- `dashboard/src/api/endpoints.ts:2088-2108` holds `getSystemAlarms` and
  `getSystemErrors` and nothing else for this panel. There is no client function
  for `GET /api/system/errors/detail` or `GET /api/system/trace`, and no response
  type for either. The spec never asks for them.
- `dashboard/src/routes/settings/useSystemStatus.ts:177-230` is where the panel's
  fetching lives (`useSystemErrors`). S6 names only `RecentErrors.tsx`. Nothing
  says where the per-row detail fetch, its loading/error state, or its abort
  handling lives.

**Implies.** Every r3 change that has to reach the screen - `pollRunId`, the
four-value `source`, the truncation flags, `ref` as the row key, the id
precedence - stops at the wire. This is the same failure the round-2 stop rule
caught (AJ26: "the route accepted `?requestId=` while the projection and the row
carried `correlationId` alone"), reintroduced one layer further out. `npm run
typecheck` will catch the missing fields as compile errors, which bounds the
damage, but the two missing client functions and the missing hook are pure
unscoped work that a builder will improvise at the end of the mission.

---

### F4. [HIGH] The `err` allowlist silently deletes the error text on every call site that logs `err` as a STRING - including the panel's own failure logs

**What is wrong.** S4 line 265-271 defines the rule as a path allowlist BENEATH
`err`: keep `err.message`, `err.stack`, `err.type`, `err.name`, `err.code`,
`err.status`, `err.response.status`; "Everything else beneath `err` is dropped AT
ANY DEPTH."

A scalar `err` has nothing beneath it, and its own key matches none of the seven
allowed paths. A faithful implementation drops it. That is not a hypothetical
shape - six call sites log exactly that:

- `app/src/services/systemStatus.ts:204` - `{ kind: classifyCloudWatchError(err), err: (err as Error).message }`
- `app/src/services/systemStatus.ts:258` - same shape, on the Insights query failure
- `app/src/services/pushService.ts:188`, `:235`, `:380`
- `app/src/routes/auth.ts:311`

pino's `stdSerializers.err` only transforms an Error VALUE; a string is written
through as a string, so `GetLogRecord` returns a flat top-level key `err` with a
text value and no dots to flatten.

The irony is load-bearing: `systemStatus.ts:204` and `:258` are the panel's OWN
degraded-read diagnostics. Under this rule, when System Status fails to read
CloudWatch, the reason is the one thing the detail view deletes.

**Implies.** The rule needs one more clause - a scalar `err` is kept (it is by
definition the message, and `message` is allowlisted). State it, because the
consequence is silent data loss in the only environment that has data, which no
gate can see.

---

### F5. [HIGH] Ascending sort plus an unstated row limit can truncate the failing line itself out of the trace

**What is wrong.** S5 lines 316-319 correctly fix the descending case:

> Insights applies `limit` INSIDE the sort, so a descending query on a long
> correlation keeps the lines AFTER the failure and drops the ones BEFORE it.

The symmetric defect is not addressed. An ASCENDING query with a limit keeps the
EARLIEST N lines and drops everything after - which, on a correlation with more
lines than the limit, means the failure the operator clicked from is not in its
own trace. This is now more likely, not less, because F2's absent anchor leaves
the bracket unbounded and because AJ25/S2 makes `pollRunId` a valid pivot: ONE
poll tick fans out to many jobs (tour reminders, placement nudges - `app/src/lib/context.ts:20-33`),
so a `pollRunId` trace is the widest of the three by construction.

S5 line 341 says only "an explicit row limit" - no value, and no statement of
what happens when the bracket's rows exceed it (truncate which end? report the
truncation? narrow the bracket?).

**Implies.** The anchored bracket (F2) is what makes ascending safe, and the two
are specified independently as though they were unrelated. They must be
specified together: bracket width, row limit, and overflow behavior, with the
anchor line guaranteed present. A trace that omits the failure is worse than no
trace, because it looks complete.

---

### F6. [MEDIUM] The per-field truncation flags are produced, tested, and never consumed

**What is wrong.** S3 lines 205-207 require "each with its OWN truncation flag so
the UI can say which field was cut", and section 7 line 457 tests "per-field
truncation flags". S6 - the only slice that can deliver "the UI can say" - never
mentions them. Its collapsed row (line 361) says "capped message"; its expanded
view (lines 363-365) lists the full fields with no reference to a truncation
indicator or to the flag driving the offer to expand.

**Implies.** AJ35 was accepted into the producer and the test list and not into
the consumer. The flags' entire justification is a UI affordance that no slice
builds. Either S6 states where the indicator renders, or the flags are dead
weight and should be dropped.

---

### F7. [MEDIUM] S5 still does not say which log groups the trace queries - missed in all three rounds

**What is wrong.** The r1 draft said the pivot ran "across the app and worker
groups". r2 dropped that sentence during the rewrite; r3 has not restored it. S5
(lines 305-352) specifies the sort, the ids, the window frame, the row shape, the
limit, the degradation and the IAM - and never names a log group.

This is not cosmetic: the new seam method's first argument is `logGroupNames`
(`app/src/adapters/cloudwatch.ts:106`, `:232-236`), and the answer is not
obvious. `config.systemLogGroupName` (`app/src/lib/config.ts:528`) holds kernel
lines that carry no correlation id at all, so including it scans bytes for
nothing; excluding it is almost certainly right but is a decision, not a default.

**Implies.** I missed this in rounds 1 and 2 and so did reviewer A and the
adjudicator. It is the last unstated argument of a method the spec otherwise
specifies completely.

---

### F8. [MEDIUM] "Exactly one of" three query parameters has no stated behavior for zero or several

**What is wrong.** S5 line 307-308 requires "exactly one of `?correlationId=`,
`?requestId=`, or `?pollRunId=`". The VALIDATION paragraph (lines 344-349) covers
only the UUID shape of "the supplied id". Nothing says what the route does when
none is supplied, or when two are.

The existing sibling route sets the precedent and the spec does not follow it:
`app/src/routes/system.ts:68-72` answers an invalid `since` with a **400**, while
every other failure on these routes is a degraded HTTP 200. So "no id" could
plausibly be 400 (matching `since`) or `{ available: false }` (matching S5's own
degradation clause at lines 341-342). A builder has to guess, and the two answers
are observably different to the UI.

**Implies.** State it: missing-or-multiple is a 400 like `since`, malformed-UUID
is the degraded 200 the spec already promises. One sentence.

---

### F9. [LOW] "NO EXISTING LINE CHANGES SHAPE" is false, and the true claim is narrower

S2 line 163-165 says: "NO EXISTING LINE CHANGES SHAPE: `logger.ts:231` resolves
`correlationId = jobRunId ?? pollRunId ?? requestId ?? bootId`, and `jobRunId`
still wins inside a dispatched job."

The mixin spreads the whole context - `app/src/lib/logger.ts:232`,
`return correlationId !== undefined ? { ...ctx, correlationId } : { ...ctx };` -
so after S2 every log line of every poll-enqueued job gains a `pollRunId` FIELD
it did not have. That is the point of the change; the shape does change. What
does not change is the `correlationId` VALUE.

Worth correcting because the sentence is the spec's entire risk argument for
touching shared plumbing, and it overstates it in a way a reviewer of the built
branch would catch and re-open.

---

## C. S2 - should it be in this mission at all? Yes. Blast radius verified.

The coordinator asked for a plain answer. I checked the widening rather than
assuming it, and it is safe:

- **No consumer reads the key SET.** `isCompleteEnvelope`
  (`app/src/jobs/jobs.ts:216-232`) only asserts
  `typeof e.correlationContext === 'object' && !== null`. There is no schema, no
  key allowlist, and no rejection of unknown keys, so old envelopes in flight and
  new envelopes both validate.
- **No test pins the shape.** The only assertions on `correlationContext` in
  `app/test` are `jobs.test.ts:181` (a `'not-an-object'` negative case),
  `scheduler.test.ts:40` and `sqsJobConsumer.test.ts:33` (fixtures that CONSTRUCT
  a context, never assert its key set), and
  `twilioStatusWebhook.test.ts:338`, which asserts one field by name. Adding a
  key breaks none of them.
- **No downstream reader enumerates context keys.** `isOrphanLogLine`
  (`app/src/lib/logger.ts:251-254`) reads `correlationId` only; the metric
  filters key on `{ $.level >= 50 }` and `{ $.correlationId NOT EXISTS }`
  (`infra/modules/observability/main.tf:40`, `:56`); the dev log ring filters on
  `level`/`msg`/`event` (`app/src/lib/logger.ts:149-168`).
- **The justification holds.** AGENTS.md requires correlation and trace context
  to be preserved across `jobs.enqueue()`, and for poll-originated jobs
  `app/src/jobs/jobs.ts:174-179` demonstrably does not preserve it. This is a
  conformance fix, not new scope, and S5 is useless for the entire worker-poll
  class without it.

Keep it, in this mission, as its own slice ahead of S5. Fix only the wording at
F9.

---

## D. Verified safe - do not re-investigate

- **The AJ30 reversal works end to end, with no client change.**
  `dashboard/src/api/client.ts:44-52` builds query strings with
  `new URLSearchParams()` + `params.toString()`, which percent-encodes `+` as
  `%2B`, `/` as `%2F` and `=` as `%3D` - equivalent to `encodeURIComponent` over
  the pointer's alphabet. A raw `@ptr` passed as
  `query: { ref }` survives the round trip with zero new encoding code. One
  caution only: the spec says "encoded with `encodeURIComponent`", so state that
  the existing `request()` helper is the intended path, or a builder may hand-roll
  a URL and bypass it.
- **`pollRunId` genuinely reaches the log line.** `dispatchJob` spreads
  `...envelope.correlationContext` into the run context
  (`app/src/jobs/jobs.ts:298-305`), and the mixin spreads the context into every
  line (`app/src/lib/logger.ts:232`). S3's premise at lines 177-180 is correct.
- **The trace-id precedence is sound for every context kind.** requestId-only work
  and correlationId coincide (`logger.ts:231`), job rows resolve to the
  originating requestId or pollRunId, chained jobs preserve the upstream id
  because `jobs.ts:174-179` copies from the live context at each hop, and
  boot-context lines fall through to `correlationId = bootId`, which matches
  itself. No context kind is left without a pivot.
- The route paths do not collide: Express matches exact paths, so
  `router.get('/errors', ...)` (`app/src/routes/system.ts:65`) cannot capture
  `/errors/detail`.

---

## E. Were any of my accepted findings wrongly accepted?

No reversals to propose. Two notes on how accepts were implemented:

- **AJ27 (allowlist over denylist) was accepted correctly and implemented
  incompletely** - F1 and F4. The two-tier rule is the right shape; it is
  nullified by `@message` and it deletes a real scalar case.
- **AJ29 (anchored window) was accepted correctly and implemented as prose only**
  - F2. The reasoning for anchoring over a rolling window is better than the
  either/or I proposed; it just has no parameter, no width, and no sender.

## F. Are the fixes correct, or merely plausible?

Correct and complete: the `source` four-value union (S3 line 197, S6 line 360,
tests line 458 - all four values in all three places), the dedup-by-`ref`
statement including the absent-`ref` case (lines 224-229), the `fakeSeam`
typecheck correction (lines 298-303), the perf-harness conditional restatement
(lines 478-490), the section 8 `cloudwatch.adapter.test.ts` "not a correction"
entry (lines 528-532), the `encodeURIComponent` transport (verified in D), the
WARN-branch treatment (lines 114-117), and the S2 propagation itself (verified in
C).

Correct in direction, incomplete in delivery: the `err` allowlist (F1, F4), the
anchored window (F2, F5), and everything that has to cross the wire into the
dashboard (F3, F6).
