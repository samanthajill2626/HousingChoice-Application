# Adversarial design review - Error surface detail (spec r4, reviewer B, round 4 / hard cap)

Spec: `W:\tmp\error-surface-detail\docs\superpowers\specs\2026-08-24-error-surface-detail-design.md` (DRAFT r4)
Adjudications read: rounds 1-3, `.superpowers\design-review\adjudications.md`
Repo: `W:\tmp\error-surface-detail` (read-only; no tests, builds, or e2e runs)
Date: 2026-08-24

Charge honoured in order: I swept the whole document for edit seams before
re-walking the six r3 fixes. The two BLOCKING findings below are both seams -
an r4 paragraph contradicting a paragraph r4 did not touch. Neither is a fresh
surface.

**Convergence verdict is in section E and it is NOT converged.** Two findings are
decision-changing. I state that plainly there rather than softening to reach the
other answer.

---

## A. END-TO-END WALK - the six r3 fixes, re-run

| r3 fix | adapter | service | route | wire type | hook | component | test | verdict |
|---|---|---|---|---|---|---|---|---|
| F1 no raw `@message` (S4) | OK | n/a | OK | OK | OK | OK (`rawText`, L450) | OK (L561) | **reaches every layer** |
| F2 `?at=` anchor (S5/S6) | OK (L383) | n/a | OK (L347) | OK | OK | OK (L467) | **GAP (F7)** | plumbed, untested |
| F5 two-sided budget (S5) | **CONTRADICTED (F2)** | n/a | OK | OK | OK | OK (L456) | OK (L564) | **mechanism impossible** |
| F4 scalar `err` kept (S4) | OK (L299-308) | n/a | OK | n/a | n/a | n/a | OK (L560) | **reaches every layer** |
| F3 dashboard wire layer (S6) | n/a | n/a | n/a | OK (L427) | OK (L438) | OK (L441) | partial (F7) | reaches, one test gap |
| F7 log groups (S5) | OK (L349) | n/a | OK | n/a | n/a | n/a | - | **reaches** |
| F8 400-vs-200 split (S5) | n/a | n/a | OK (L406) | OK | OK | OK | OK (L566) | reaches S5, **asymmetric with S4 (F5)** |

Four of six now reach every layer. That is a real improvement over r3, where four
of six did not.

---

## B. EDIT-SEAM FINDINGS - the highest-value category this round

### F1. [BLOCKING] The +/-5 minute anchored bracket defeats the cross-the-job-hop pivot. The two headline fixes cancel each other.

**The seam.** AJ29's anchored window (r4 lines 373-385) was written into S5 next to
AJ15/AJ25's three-id pivot (lines 365-371), which r4 did not touch. They are
incompatible.

The pivot exists for exactly one reason, stated at lines 368-369: "Filtering a
`job failed` line's correlationId returns that job run alone - nothing about what
enqueued it." `requestId` and `pollRunId` are on the wire so the operator can
reach the ENQUEUEING work. The anchor is the row's own timestamp - the FAILURE -
and the bracket is `at - 5 minutes` to `at + 5 minutes` (line 382).

The enqueue-to-failure gap routinely exceeds five minutes:

- **Delayed enqueue.** `app/src/jobs/jobs.ts:112-114` computes
  `delaySeconds` from `opts.runAt` and routes to the SQS path whenever
  `delaySeconds <= JOBS_SQS_MAX_DELAY_SECONDS`; the docblock at `:104` states the
  live envelope as "no >12min callers" in Phase 1. So a scheduled job can fire up
  to roughly twelve minutes after the request or tick that enqueued it.
- **Retry span.** `infra/modules/jobs/main.tf:36` sets
  `visibility_timeout_seconds = 120` and `:41` sets `maxReceiveCount = 5`.
  `RUNBOOK.md:989-990` states the consequence: "it redelivers after the 120 s
  visibility timeout and dead-letters into `hc-<env>-jobs-dlq` after 5 receives".
  Four redeliveries at 120 s is about eight minutes of span before the DLQ, on
  top of handler runtime.

So the `job failed` line an operator clicks is, in the retry case, roughly eight
minutes after the first attempt and further still from the enqueue; in the
delayed case, up to twelve; combined, around twenty. A +/-5 minute bracket
anchored on that line cannot reach any of it.

**This lands on the feature's most important scenario, not an edge.** The DLQ
alarm row (`RUNBOOK.md:2169`) - the panel's headline triage path - is by
definition the fifth-receive case. Section 1 of this very spec names "what led up
to it" as one of the three things operators cannot see today.

**Implies.** The bracket policy is a decision the spec has not made. Options that
would resolve it: an ASYMMETRIC bracket (a long look-back, a short look-ahead);
an id-dependent bracket (tight for `correlationId`, wide for
`requestId`/`pollRunId`, which are the cross-hop ids by construction); or a
two-segment query - the anchor's neighbourhood plus the upstream id's earliest
lines. Whichever is chosen, the +/-5 minute symmetric constant as written makes
S2 - a deliberate widening of a non-goal into shared job plumbing - buy nothing
in the case it was justified by.

---

### F2. [BLOCKING] The two-sided N/2 budget contradicts "the query sorts ascending server-side" and the test that pins it

**The seam.** The two-sided budget (r4 lines 391-402) was inserted immediately
below the ASCENDING SORT paragraph (lines 360-363), which r4 did not touch, and
section 7's trace test (lines 570-571), which r4 also did not touch. All three
cannot hold.

- Line 363: "The query sorts ascending server-side." Singular query, ascending.
- Lines 398-399: "up to N/2 rows at-or-before `at`, and up to N/2 after it,
  merged ascending. This GUARANTEES the anchor line is present."
- Lines 570-571: "Unit: the trace query sorts ASCENDING".

The spec's own load-bearing insight is why this fails. Line 360: "Insights
applies `limit` INSIDE the sort." An ascending query over `[at-5m, at+5m]` with
`limit N` returns the EARLIEST N rows in the bracket. If more than N rows precede
the anchor within five minutes - which is precisely the "long correlation" case
lines 391-396 invoke, and which a `pollRunId` fan-out makes likely by the spec's
own argument - the anchor is not in the result. The stated guarantee fails
against the stated mechanism.

Getting "up to N/2 rows AT-OR-BEFORE `at`" out of Insights requires
`sort @timestamp desc | limit N/2` over `[at-5m, at]` and then reversing -
a DESCENDING query, contradicting line 363 and failing the test at line 570.
The word "merged" at line 399 hints at two result sets, but the spec never says
two queries, describes "the query" in the singular throughout, and specifies one
new seam method.

The alternative - no `limit` at all, letting the +/-5 minute bracket bound the
result and splitting client-side - is defensible but unstated, and it means the
row budget does not bound what Insights returns at all.

**Implies.** The builder cannot satisfy all three sentences. This needs an
explicit mechanism: two queries with opposite sorts and their own limits, or one
unlimited bracketed query with a client-side split and a stated ceiling. The
section 7 test must be restated to match whichever is chosen, because as written
it pins the half that cannot deliver the guarantee.

---

### F3. [HIGH] S4's "app-authored" pass-through premise and the `rawText` justification are both false for `/hc/<env>/system` - which the same slice explicitly admits

**The seam.** The pass-through tier (lines 294-295) predates the r4 edits:

> NON-`err` fields PASS THROUGH. They are app-authored - the call site chose to
> attach them, and they are the point of the detail view.

The new `rawText` paragraph (lines 281-284) makes the parallel claim:

> For a NON-JSON record (kernel OOM, V8 heap OOM, raw stderr) ... Those lines
> carry no vendor error object by construction, so the text is surfaced under an
> explicit, capped `rawText` field.

Both are written as though every record came from the app or the worker. The
ENVIRONMENT SCOPE CHECK three paragraphs later (lines 321-322) deliberately
admits a third group: it accepts any record whose `@log` matches
`errorLogGroupName` / `workerLogGroupName` / **`systemLogGroupName`**.

`/hc/<env>/system` is not app-authored and is not "kernel OOM lines". It is the
entire host syslog:

- `infra/modules/ec2/main.tf:410-411` -
  `"file_path": "/var/log/messages"`, `"log_group_name": "/hc/${var.env}/system"`.
  The whole file, unfiltered.
- `infra/modules/observability/main.tf:23` -
  "Host/system log (rsyslog /var/log/messages, shipped by the CloudWatch agent)".

`/var/log/messages` on AL2023 carries sshd, sudo, systemd, docker and cloud-init
output. Nothing in it was chosen by a call site, and the panel only ever showed
two synthesized labels from it before
(`OOM_APP_LABEL` / `OOM_SYSTEM_LABEL`, `app/src/services/systemStatus.ts:52-53`,
`:239-240`) - the projection has never surfaced its raw text.

The justification is also aimed at the wrong threat. "Carries no vendor error
object" is true and irrelevant: the risk in host syslog is not an axios `config`
nest, it is whatever the host wrote. Section 6's claim that the allowlist "closes
the class by construction, including nests nobody has met yet" (lines 532-533) is
true of the `err.*` subtree and does not extend to `rawText` or to pass-through
fields on a record the app did not author.

**Implies.** This is a posture decision, not a mechanism bug, and it is for the
human, not the builder. Either state that host syslog text is in scope of the
accepted PII decision (it plausibly is - it is admin-only, and the OOM rows are
the ones operators most need), or restrict `rawText` to records from the app and
worker groups and keep the system group on its synthesized labels. What must not
survive is the current justification, which asserts a property the third admitted
group does not have.

---

### F4. [MEDIUM] The `rawText` branch rests on a GetLogRecord behavior the spike never sampled

Lines 281-282 assert as fact: "For a NON-JSON record (kernel OOM, V8 heap OOM,
raw stderr) `GetLogRecord` returns no application fields and the raw text IS the
only content."

Section 3 sampled two records and says so precisely: fact 4 "a real prod ERROR
record" (JSON), fact 5 "a DIFFERENT record (an info-level shutdown line)" (also
JSON). Neither was non-JSON. Fact 6 lists what the DETAIL record carries, again
from a JSON sample.

The inference is very likely correct - a non-JSON event has no fields to flatten,
so `@message` plus the `@`-prefixed metadata is all there is - but it is an
inference, presented as measurement, in the one section that r2 restructured
specifically so that "each fact names the record it came from" (line 58). The
entire `rawText` branch, including whether it is ever populated, depends on it.

Mark it UNVERIFIED in the spec, or sample one OOM record and promote it to fact 8.
(I could not check it myself - read-only, no AWS.)

---

### F5. [MEDIUM] The F8 edit gave S5 a missing-parameter rule and left S4 without one; the sibling routes now disagree

**The seam.** S5's new VALIDATION paragraph (lines 406-410):

> a missing id, several ids at once, or a missing/unparseable `at` is a **400**,
> matching the `since` precedent on the sibling route (`system.ts:68-72`). A
> well-formed request whose id is not UUID-shaped takes the degraded 200.

S4's VALIDATION paragraph (lines 331-332) was not touched and covers only
malformed input:

> length-bound and charset-validate `ref` before the SDK call; malformed input
> produces the degraded response, never an unhandled throw.

`ref` is required. `GET /api/system/errors/detail` with no `ref` at all now has
no stated answer, while its sibling has an explicit 400 for the identical class.
Before the F8 edit both routes were equally silent; after it they are
inconsistent, and only one says so.

This is observable to the client: `dashboard/src/api/client.ts` distinguishes a
non-2xx from a degraded 200 body, so the two answers drive different UI paths.
One sentence in S4 closes it - and the answer should be 400, to match both the
`since` precedent and S5.

---

### F6. [MEDIUM] Two constants remain prose after r4 made concreteness an explicit principle

R4 states the principle at line 381: "CONCRETE VALUES, because prose alone left
this unbuildable in an earlier draft", and delivers `at +/- 5 minutes`. Three
quantities in the same design did not get the same treatment:

- **S5's row budget `N`** (lines 391-402) - the entire two-sided budget is
  expressed in terms of an `N` the spec never names. Line 398 says "up to N/2
  rows" on each side; the builder picks the number that decides whether a trace is
  useful or a firehose. `ERROR_EVENT_LIMIT = 25`
  (`app/src/services/systemStatus.ts:49`) is the obvious precedent to cite or
  deliberately depart from.
- **S4's response size bound** (line 325) - "bounded; an oversized record is
  truncated with a flag." No bound.
- **S4's `rawText` cap** (line 284) - "an explicit, capped `rawText` field." No cap.

S3 caps at "300 characters" and S5 brackets at "5 minutes"; these three are the
remainder of the same class, in slices r4 edited.

---

### F7. [MEDIUM] Section 7 was not extended for two of r4's own additions

Section 7 is one of the places an edit seam shows. Two r4 additions arrived
without tests:

- **S6's truncation indicators.** Lines 453-458 make rendering them a named
  requirement ("THE TRUNCATION INDICATORS ARE RENDERED HERE - they have no other
  purpose ... Likewise S5's `truncated` flag is surfaced in the trace view").
  The Component test line (573-574) still reads "collapsed/expanded, four-value
  chip, `ref` row key, trace-link id precedence and its absent-id case" - the
  pre-r4 list. The requirement that F6 (round 3) existed to create has no test.
- **The epoch-SECONDS conversion for the anchor.** Line 383-385 flags it as the
  thing "the existing seam warns about in capitals" (`cloudwatch.ts:229`), and
  the existing suite already pins exactly this for the list path:
  `app/test/cloudwatch.adapter.test.ts:120-121` asserts
  `startCmd.input.startTime` equals `Math.floor(sinceMs / 1000)`. Section 7's
  trace tests (lines 564-571) cover the budget, the 400/200 split and the sort -
  not the bracket bounds. A milliseconds-for-seconds slip yields an empty trace,
  which degrades silently and is invisible in the hermetic lane
  (`systemStatus.ts:212-214`).

---

### F8. [LOW] The spec never says whether the eight new fields are optional or required

S3 (lines 187-189) and S6 (line 429) add eight fields plus two truncation flags
to `ErrorEventView` and to `SystemErrorEvent`. Neither says whether they are
required, optional, or nullable, and the existing interface uses all three
conventions: `errorCode?: string | null` optional
(`app/src/adapters/cloudwatch.ts:93`), `correlationId: string | null` required
but nullable (`:87`), `message: string` required (`:85`).

The consequence is enumerable. Existing fixtures build partial literals:
`dashboard/src/routes/settings/RecentErrors.test.tsx:67-68` construct events with
four keys, `:88-92` with five. If `source` or `ref` are required, every one of
those breaks under `npm run typecheck` - a required gate - and the builder edits
fixtures rather than shipping. If they are optional, the four-value `source`
union has a fifth de-facto state (`undefined`) that S6's chip has no branch for,
which is the same defect AJ28 fixed.

One sentence: `source` and `ref` are required; the rest follow the `errorCode?`
convention.

---

### F9. [LOW] Section 2's framing sentence predates S2 and is now narrower than the spec

Section 2 opens (lines 36-38): "Widening the projection adds no new data to any
store and creates no new retention obligation. It changes only what the panel is
willing to render."

S2, added in r3, writes a new field into CloudWatch on every poll-enqueued job's
lines, and r4's own S2 text says so plainly at lines 164-166: "Every log line of
every poll-enqueued job DOES gain a `pollRunId` field ... that is the point of
the change." The non-goals list (lines 500-501) names it as an exception, but the
section that carries the spec's foundational framing was never revisited.

Trivial to fix and worth fixing, because section 2 is the paragraph a human reads
to decide whether this change touches storage.

---

## C. WHAT WE ALL MISSED ACROSS FOUR ROUNDS - everything I am still holding

Nothing beyond the above. Specifically, I checked and am NOT raising:

- **The `system` group's exclusion from S5 vs its admission by S4** (lines 349-352
  vs 321-322). This looks like a seam and is not one: the trace pivot excludes
  `system` because kernel lines carry no correlation id, while the detail route
  must admit it because the list merges OOM rows the operator can expand. Both are
  right. Do not "fix" it.
- **Perf harness, template matching, artefact scanning** - settled in round 3 and
  correctly restated at lines 579-597.
- **`URLSearchParams` transport** - verified in round 3
  (`dashboard/src/api/client.ts:44-52`) and correctly written into S6 at
  lines 434-437, including the "do NOT hand-roll a URL" caution.
- **S2's blast radius** - verified in round 3 and now written into the spec itself
  at lines 171-179, accurately.
- **Route collision** for `/errors/detail` - Express matches exact paths.
- **Envelope compatibility** for the added `pollRunId` -
  `isCompleteEnvelope` (`app/src/jobs/jobs.ts:216-232`) type-checks the object
  only.

---

## D. ARE THE FIXES CORRECT, OR MERELY PLAUSIBLE?

**Correct and complete.** F1's `@message` removal - the reasoning at lines 273-279
is exactly right and the response no longer carries the hole. F4's scalar-`err`
clause (lines 299-308) names all six call sites and the reason, and is tested at
line 560. F3's four-file dashboard scope (lines 424-441) reaches every layer I
walked, including the hook and the encoding caution. F7's log-group decision
(lines 349-352) states the reasoning rather than defaulting. F9's S2 rewording
(lines 163-179) is now precise about what changes and carries the verified blast
radius. F8's 400/200 split is right for S5.

**Correct in direction, not yet correct.** F2/F5's anchored window: anchoring
beats a rolling window, and the two-sided budget is the right idea. But the
bracket's width defeats the pivot it sits next to (F1), and the budget's
mechanism contradicts the query it sits next to (F2). Both are the "one layer,
not the others" pattern showing up inside a single slice.

---

## E. CONVERGENCE - my plain judgement

**This has NOT converged, and I will not say otherwise to close the round.**

Findings F1 and F2 are decision-changing, not polish:

- **F1** requires the spec to choose a bracket policy it has not chosen
  (symmetric / asymmetric / id-dependent). Until then, S2 - a deliberate widening
  of a non-goal into shared job plumbing that every job passes through - is
  purchased for a capability the bracket cancels in the retry and delayed-enqueue
  cases, which include the DLQ triage path the panel exists to serve.
- **F2** requires the spec to choose a query mechanism it has not chosen (two
  opposite-sorted queries, or one unlimited bracketed query with a client-side
  split). Three sentences in the current text cannot all be true.

**F3** is a third item for the human rather than the builder, but it is a posture
question with an easy conservative default (restrict `rawText` to app and worker
records), so it need not block if the human takes that default.

**F4 through F9 are builder-resolvable polish** - a constant, a sentence, two
test lines, an optionality rule, and a stale framing sentence. None of them
changes a decision. If F1, F2 and F3 are resolved, I would call the remainder
ready without a further review round.

My recommendation for the hard cap: take F1, F2 and F3 to the human as three
specific decisions, fold F4-F9 into the plan as builder instructions, and do not
run a fifth review round - the r3-to-r4 delta shows the process working (four of
six fixes now reach every layer), and the two open items are choices to be made,
not defects to be hunted.
