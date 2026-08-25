# Adversarial design review - Error surface detail (spec r5, reviewer B, round 5 / final)

Spec: `W:\tmp\error-surface-detail\docs\superpowers\specs\2026-08-24-error-surface-detail-design.md` (r5)
Adjudications read: rounds 1-4, `.superpowers\design-review\adjudications.md`
Repo: `W:\tmp\error-surface-detail` (read-only; no tests, builds, or e2e runs)
Date: 2026-08-24

Charge order followed: the three human decisions walked end-to-end first, then a
whole-document seam sweep, then what I am still holding. **Readiness verdict is
section E and it is a qualified NO with a short, specific remedy** - not a
decision reversal, and nothing that needs to go back to the human.

---

## A. THE THREE HUMAN DECISIONS - end-to-end walk

| Decision | route | seam | wire type | hook | component | test | verdict |
|---|---|---|---|---|---|---|---|
| **D1 id-dependent bracket** | OK (L400-403, L455-460) | OK (L465-470) | n/a - server-derived | n/a | OK (L566-568, sends id + `at`) | OK (L674-675) | **lands; coupled with S6 precedence in a way nobody reviewed - F3** |
| **D2 two opposite-sorted queries** | OK | OK (L485-495) | OK | OK | **GAP - no view exists (F1)** | OK (L671-673) | **server side complete; consumer absent** |
| **D3 host syslog raw text shown** | OK (L309-312) | OK | OK (L530) | OK | OK (L551) | OK (L662-663) | **lands; its truncation flag does not - F5** |

D1's mechanism is genuinely well-chosen: the bracket is derived server-side from
WHICH id arrived, so the client needs no new parameter and the coupling stays in
one place. D2's two-query shape is correct and the anchor guarantee now follows
from the mechanism rather than being asserted over it. D3 is honestly reasoned -
line 327-328 states what is exposed ("whatever the host wrote, including command
lines from sudo and sshd") instead of hiding behind the false premise I flagged
in round 4.

**"Does anything else still assume one query?"** - I swept for it. The reworded
ascending paragraph (L416-421), the builder note (L501-503), the test line
(L671-673), the singular "new seam method" (L407, L414) and `fakeSeam`'s "BOTH new
methods" (L396) are all consistent with one seam method issuing two queries.
I found one thing the two-query change touches that the document does not
address, and it is a runtime budget rather than a sort direction - F4.

---

## B. FINDINGS

### F1. [BLOCKING] The trace VIEW does not exist anywhere in the spec, and S6 references it as though it were decided

**What is wrong.** S5 specifies a complete server contract: two queries, an
id-dependent bracket, a bespoke row type carrying eight diagnostic fields
(L472-474), up to 50 merged rows (L490), and a per-side `truncated` flag that
"S6 must surface" (L497-499). Nothing renders any of it.

- S6 is titled "Dashboard wire layer and UI" and enumerates FOUR files
  (L525-542): `types.ts`, `endpoints.ts`, `useSystemStatus.ts`,
  `RecentErrors.tsx`. None is a trace view.
- S6 describes exactly two rendering surfaces: the collapsed row (L546-547) and
  the expander (L549-552). The expander's contents are the DETAIL record - err
  fields, key/value list, `rawText` - with no trace rows.
- L566 calls it "the trace link", which implies navigating somewhere, and
  L557-559 says "S5's `truncated` flag is surfaced in **the trace view**" - the
  document's only mention of it, phrased as a reference to a thing already
  specified. It is not specified anywhere.
- Nothing exists to extend. I checked `dashboard/src/routes/settings/` in full:
  `AlarmGrid`, `FlagPills`, `RecentErrors`, `SystemStatusSection`,
  `NotificationsSection`, `NumbersSection`, `QuietHoursSection`, `TeamSection`,
  `TemplatesSection`, `VoiceSection`, `aiRuns/`, and the hooks. There is no trace
  component, and a `grep -rln "trace" dashboard/src` returns only
  `dashboard/src/api/types.ts` (the `traceparent` family). UNVERIFIED only in the
  sense that I cannot rule out an intent to reuse an existing generic surface -
  but the spec names none.
- The testing section cannot catch it: every `Component:` line (L680-684) names
  `RecentErrors`. L684 states the principle - "an untested indicator is an unbuilt
  one" - and then the trace's `truncated` flag has no component test because the
  component does not exist.

**Implies.** The builder must invent a route or panel, its layout for 50 rows
across 8 columns, its loading / error / degraded-200 states, its per-side
truncation presentation, and its A11y - none of which the spec constrains, on a
slice whose server half is specified to the millisecond. This is the same
"landed in the route, not the UI" pattern that produced the round-2 BLOCKINGs
(AJ26) and the round-3 wire-layer gap (AJ-F3), recurring at the largest scale in
the document. S5 is the feature's headline capability and its consumer is absent.

The remedy is a paragraph, not a decision: state where the trace renders (a fifth
S6 file is the honest answer), what it shows, and add one `Component:` line.

---

### F2. [HIGH] `errType` and `errMessage` are projected, typed, and consumed by nothing - and S6 contradicts itself about whether they are in the row

**What is wrong.** S3 projects `errType` and `errMessage` (L202), caps
`errMessage` at 300 with its own truncation flag (L247-249), and S6 mirrors both
into `SystemErrorEvent` (L528-532). No slice renders either.

- The collapsed row enumeration (L546-547) is: "timestamp, level, the four-value
  source chip, `jobName` or `event` chip, capped message, the trace link, and an
  expand control." No `errType`, no `errMessage`.
- The expander (L549-552) shows "full `err.message`, `err.type`, `err.stack`" -
  but those come from the S4 DETAIL fetch, not from the list projection's
  `errType`/`errMessage`.
- The fallback ladder (L255-256) reads `err.message` off the parsed line into
  `message`; it does not read the `errMessage` field.

S6 then contradicts its own enumeration. L554-556: "S3 produces **one flag per
capped field** precisely so the UI can say WHICH field was cut; a flag that no
slice consumes is dead weight. The collapsed row marks the capped field visibly."
There are two capped fields (`message` and `errMessage`). If only `message` is in
the row, `errMessage`'s flag is exactly the "dead weight" that paragraph
condemns - and the paragraph exists because I raised that defect in round 3 (F6).

This also touches the feature's core promise. Section 1 (L15) names "what the
underlying error was" as one of three things operators cannot see. After S1 the
row's `message` is `'job failed: relay.fanOut'` - the WHICH, not the WHAT. If
`errMessage` is not in the row, the error text still requires a click, and the
r1 rationale for capping it at 300 ("so the UI can show more exists and offer the
detail view") is unfulfilled.

**Implies.** Either put `errMessage` in the collapsed row and say so in L546-547
(and decide what, if anything, renders `errType` - a chip alongside `jobName`/
`event` is the obvious candidate), or drop `errMessage`'s cap and flag as dead
weight. As written, a builder can ship a row that is no more informative about
the error than today's while passing every listed test.

---

### F3. [MEDIUM] The id-dependent bracket and S6's id precedence were written independently; the `-5min` branch is unreachable for almost every row

**The seam.** D1 is new in r5 (S5, L439-463). S6's precedence rule is from r3 and
r5 did not touch it (L566-567): "Prefer `requestId`, then `pollRunId`, then
`correlationId`; the first present one drives the link."

The bracket rule assumes the id expresses intent (L457-460): "`correlationId`
pivot ... One job run, genuinely local; keep it tight and cheap" versus
"`requestId` or `pollRunId` pivot ... These are the cross-hop ids by construction."
The precedence rule chooses mechanically, and always prefers the wide-bracket ids.

Walk it against the mixin (`app/src/lib/logger.ts:231-232`, which spreads the
whole context AND computes `correlationId = jobRunId ?? pollRunId ?? requestId ??
bootId`):

- **Plain Express-handler error**: the line carries `requestId = R` and
  `correlationId = R` - the same value. S3 projects both. Precedence picks
  `requestId` -> the **-30min** bracket, for a request that lived milliseconds.
  Six times the Insights time range, zero extra rows.
- **Worker poll tick's own error line**: ctx is `{pollRunId: P}`, so `pollRunId`
  is present and wins -> **-30min**, again for a non-cross-hop row.
- **`job failed` line**: `requestId` or `pollRunId` present -> **-30min**.
  Correct; this is the case D1 was decided for.
- **Boot-context lines only** (uncaughtException at `app/src/lib/errors.ts:116`,
  shutdown lines): no `requestId`, no `pollRunId` -> `correlationId = bootId`
  wins -> **-5min**.

So the tight branch is reachable essentially only for process-lifecycle rows, and
the "one job run, genuinely local" case it was written for always takes the wide
branch instead. The test at L674-675 pins a path the UI can barely produce.

**Implies.** No correctness failure - the wider bracket returns a superset - but
the stated rationale does not describe the mechanism, and Insights bills by data
scanned. If the tight branch is meant to be real, the bracket should key on
whether the chosen id differs from `correlationId` (i.e. a genuine cross-hop
pivot) rather than on the parameter name. If it is not meant to be real, say that
`-5min` is the process-lifecycle case and stop describing it as the job-run case.
One sentence either way.

---

### F4. [MEDIUM] Two queries double a deliberately bounded 8-second budget, and the spec never says parallel or sequential

**What is wrong.** D2 replaces one Insights query with two (L485-490) and says
nothing about how they are issued. The existing seam bounds a single Insights
read on purpose, and documents why:

- `app/src/adapters/cloudwatch.ts:37` - "Insights polling config: at most 20 polls
  x 400ms = 8s maximum wait", `:38-39` `INSIGHTS_MAX_POLLS = 20`,
  `INSIGHTS_POLL_INTERVAL_MS = 400`.
- `app/src/adapters/cloudwatch.ts:28-31` - the whole rationale: "A bounded request
  handler so a slow/blackholed CloudWatch connection degrades ... instead of tying
  up the Express handler for minutes - the dashboard auto-refreshes every 60s, so
  hung handlers would stack server-side."

Two sequential poll loops make that ~16s. The repo already has the right pattern
for exactly this, in the same feature: `app/src/services/systemStatus.ts:227`
issues its three Insights queries with `Promise.all`, under a comment that says
so ("Three Insights queries in parallel"). The spec cites `systemStatus.ts` a
dozen times and never cites this line.

**Implies.** One clause - "the two queries run in parallel, as `getErrors` does at
`systemStatus.ts:227`" - keeps the new route inside the budget the adapter was
built to enforce. Without it a builder may reasonably write `await` twice, and
the failure mode is a slow admin click that only appears under a degraded
CloudWatch, i.e. never in any gate.

---

### F5. [MEDIUM] S4's two truncation flags never reach the paragraph and the test that exist to consume truncation flags

**The seam.** S4 now produces two truncation flags that did not exist when S6's
truncation paragraph was written:

- `rawText` "capped at 4000 characters with a truncation flag" (L311, new in r5).
- The response size bound: "64 KB. An oversized record is truncated with a flag"
  (L374, new in r4).

S6's consumer paragraph (L554-559) enumerates "S3 produces one flag per capped
field" and "Likewise S5's `truncated` flag". It does not mention S4's two. The
component test line (L682-684) likewise covers "per capped field, and the trace's
per-side `truncated` flag" - S3's and S5's only.

This is the third recurrence of one pattern: a flag produced in one slice with no
instruction to render it. It is the defect round-3 F6 raised and this very
paragraph was written to prevent, on fields added after the paragraph.

**Implies.** Add S4's two flags to L554-559 and to L682-684. The `rawText` one
matters most: a silently truncated host-syslog line is the case where an operator
is most likely to draw a wrong conclusion from a partial view - the exact argument
L498-499 makes for the trace flag.

---

### F6. [MEDIUM] S4 claims "the same two answers as S5", and S5's own third case breaks the principle

**The seam.** r5 added S4's validation paragraph (L383-388) explicitly to make the
siblings agree, and states the principle: a MISSING `ref` is 400; a PRESENT but
malformed `ref` (length or charset) takes the degraded 200.

S5 (L507-511, untouched) does not follow that principle for all of its inputs:

- missing id -> 400 (consistent: missing)
- several ids -> 400 (consistent: structurally unusable)
- missing `at` -> 400 (consistent: missing)
- **unparseable `at` -> 400** (INCONSISTENT: present but malformed, which S4
  answers with 200)
- non-UUID id -> degraded 200 (consistent)

So "present but malformed" gets 400 in one place and 200 in two others, and the
paragraph asserting the siblings agree is the one that introduces the mismatch.
The test line inherits it (L667-668: "bad `at`" is 400).

There IS a principle that reconciles all five outcomes, and the spec should state
it instead of the current one: **400 when the server cannot BUILD the query** (no
id, ambiguous id, no or unparseable anchor - an anchor must be parsed to compute
the bracket); **degraded 200 when the query is buildable but cannot MATCH** (a
well-formed id of the wrong shape, a pointer that does not resolve). That is
consistent with the `since` precedent at `app/src/routes/system.ts:68-72`, which
400s because the window cannot be built.

**Implies.** The routes as written are buildable and their behavior is defensible;
what is wrong is the stated rule, which a builder will generalise to the next
parameter. One sentence fixes it.

---

### F7. [LOW] Fact 8 documents AWS metadata keys that the non-`err` pass-through tier would ship, contradicting the response's own `@`-key allowlist

Fact 8 (L95-101, new in r5) records that a `GetLogRecord` response carries
"`@`-prefixed metadata ... entity/account keys ... plus
`backwardToken`/`forwardToken`".

Two rules in S4 now disagree about those:

- The RESPONSE spec (L297-299) reads as an allowlist of three AWS keys: "plus
  `@log`, `@logStream` and `@ingestionTime`".
- The FIELD RULE (L343-344) is a pass-through: "NON-`err` fields PASS THROUGH.
  They are app-authored - the call site chose to attach them."

`backwardToken`, `forwardToken` and the entity/account keys are non-`err` fields
that are NOT app-authored - fact 8 is the proof, and it arrived after the
pass-through justification was written. A builder implementing the pass-through
literally ships adjacent-record pointers to the client, while section 5 lists
"The `forwardToken`/`backwardToken` adjacent-line reader is not built" as a
non-goal (L609).

Harmless in consequence (admin-only, same-stream pointers), but it is an
unresolved ambiguity: state that AWS-injected keys are an allowlist of the three
named and everything else `@`-prefixed or SDK-injected is dropped.

---

### F8. [LOW] "NOT optional extras" collides with the optionality rule eight lines later

L205-206: "`requestId` and `pollRunId` are NOT optional extras - without them on
the wire, S5's pivot is unreachable from the UI."

L217 (the r5 optionality block): "Everything else follows the
`errorCode?: string | null` convention" - which makes them optional.

Optional is the correct choice (poll ticks have no `requestId`; boot lines have
neither), but "NOT optional" is the phrase a builder reads first, and making them
required would break every row that legitimately has neither. Reword the first to
"not optional in the DESIGN; optional in the TYPE, per the rule below."

---

## C. WHAT I AM STILL HOLDING - nothing beyond the above

I checked and am deliberately NOT raising these, so they are not re-opened:

- **The -30min margin.** Measured worst case is roughly 12min delayed enqueue
  (`app/src/jobs/jobs.ts:112-114`, `:104`) + ~8min retry span
  (`infra/modules/jobs/main.tf:36`, `:41`) + handler runtimes. -30min covers it
  with real but not generous margin. The decision is sound and explicitly
  reasoned; I am not second-guessing a human decision on a thin margin.
- **The S4/S5 system-group asymmetry** (L330-333). Correct, and now labelled "Do
  not reconcile them." Agreed.
- **Everything closed in rounds 1-4**: the `err` allowlist and its scalar clause,
  the `@message` removal, `encodeURIComponent` transport, the environment scope
  check, `fakeSeam`, the perf-harness conditional, the four-value `source` union,
  dedup-by-`ref`, S2's blast radius, section 2's corrected framing, the
  optionality consequence for fixtures, the epoch-SECONDS test. All verified
  present and accurate in r5.

---

## D. ARE THE THREE DECISIONS IMPLEMENTED CORRECTLY, OR MERELY PLAUSIBLY?

**D1 - correctly, with an unreviewed coupling.** The server-side derivation is the
right shape and keeps the client unchanged. The coupling to S6's precedence (F3)
is a rationale defect, not a correctness one.

**D2 - correctly on the server, with no consumer.** The two-query mechanism
genuinely delivers the anchor guarantee the r4 text only asserted, the row budget
reuses `ERROR_EVENT_LIMIT` rather than inventing a number, and the reworded
ascending paragraph plus the explicit builder note (L501-503) close the seam I
raised. The runtime budget (F4) and the missing view (F1) are what remain.

**D3 - correctly, and it is the best-written decision in the document.** L314-333
states what is exposed rather than justifying it away, cites
`infra/modules/ec2:410-411` for the claim, and fact 8 replaces the inference I
asked to be marked UNVERIFIED with a measurement. Only its truncation flag failed
to reach the UI (F5).

---

## E. READY TO BUILD? - my plain judgement

**No, not as written - but it is two paragraphs away, and nothing needs to go back
to the human.**

That is a materially different answer from round 4. There, two findings were
DECISIONS the spec had not made and could not make without the human. Here,
every finding is a SPECIFICATION GAP the coordinator can close directly:

- **F1 is the only one I would call blocking**, and it is blocking because a whole
  rendering surface is referenced and never defined - not because anything is
  wrong. Name the file, say what the trace view shows, add one `Component:` test
  line.
- **F2 needs one decision of taste** (is `errMessage` in the collapsed row? it
  should be) and one sentence in L546-547.
- **F3-F8 are one or two sentences each**: a bracket-keying clarification, a
  "in parallel" clause, two flags added to two lists, a reconciling validation
  principle, an AWS-metadata allowlist, and a reworded "not optional".

I do not think a sixth review round is warranted and I am not asking for one. The
r4-to-r5 delta is the strongest of the review: all three human decisions landed
with correct mechanisms, and the residue is consumer-side plumbing of the same
kind the process has now caught four times running - which is itself the argument
for closing F1 and F2 explicitly rather than trusting the builder to notice.

My recommendation: fold F1 and F2 into S6 as written text, fold F3-F8 in as
one-line edits, and hand back without further review. If the coordinator prefers,
F3-F8 could go to the builder as plan notes instead - none of them changes a
decision - but F1 and F2 should be in the spec, because both are places where a
builder's reasonable invention would quietly under-deliver the feature's stated
purpose.
