# Adversarial design review - r5, fresh-eyes pass (reviewer A, returning from round 1)

Spec: `W:\tmp\error-surface-detail\docs\superpowers\specs\2026-08-24-error-surface-detail-design.md` (r5)
Adjudications read: `.superpowers/design-review/adjudications.md` (rounds 1-4)
Repo: `W:\tmp\error-surface-detail` - READ-ONLY. No tests, no builds, no e2e, no
edits outside this file.
Date: 2026-08-24

I read r5 cold and in full BEFORE opening the adjudications, then re-verified
every load-bearing claim in the code. I did not iterate on rounds 2-4, which is
the only advantage I have this round.

---

## Verdict up front

**Not ready to build as written - one BLOCKING item, which is one paragraph of
work to fix.** With finding 1 resolved and findings 2-3 folded in, this is ready.

The document is enormously better than the draft I reviewed. Every one of my 17
round-1 findings is either fixed correctly or correctly rejected, and the fixes
are real fixes rather than hedges. **Nothing in r5 is worse than r1 on the
merits.** The one respect in which r5 is worse is as a DOCUMENT (finding 8): it
carries the review's own bookkeeping into its requirements.

Nine of the ten findings below are in material added in rounds 2-4. That is the
expected shape - the r1 surface has been worked over four times - and it is also
the warning: **the newest slice, S5, holds the BLOCKING item and two of the
MEDIUMs.** S5 was assembled across three rounds by accretion (AJ29 -> AJ40 ->
AJ41 -> AJ49 -> AJ50) and it shows.

### Spot-check of r5's factual base

I re-verified 24 of r5's code citations. **All 24 hold**, including every one
added after my round. Specifically confirmed:

- `jobs.ts:174-178` copies exactly `requestId`, `conversationId`, `tenantId`,
  `placementId` - no `pollRunId`. S2's premise is correct.
- `logger.ts:231` is verbatim `ctx.jobRunId ?? ctx.pollRunId ?? ctx.requestId ?? ctx.bootId`;
  `:232` spreads the whole context. AJ47's correction is correct.
- `isCompleteEnvelope` (`jobs.ts:216-231`) checks only
  `typeof e.correlationContext === 'object' && !== null`. S2's blast-radius
  argument holds.
- **I tried hardest to break S2 and could not.** `pollLoop.ts:67` wraps the whole
  tick in `runWithContext({ ...baseContext, pollRunId: newPollRunId() }, ...)`
  and the docblock at `:43-46` states the AsyncLocalStorage propagation
  explicitly, so an `enqueue()` inside a poll's `run()` does see `ctx.pollRunId`.
  S2 delivers. `startPoll` is the single entry point (`worker.ts:290`).
- The whole `correlationContext` surface is exactly two writers
  (`jobs.ts:174`, and `jobs.ts:266` `{}` on the synthesized path) and one
  spread-reader (`jobs.ts:299`). No enumerator anywhere. Verified by grep across
  `app/src` and `app/test`.
- `requestLogger.ts:33` logs `path: req.path`; `:11-18` is the header allowlist.
- `client.ts:44-52` builds queries with `URLSearchParams`, which percent-encodes
  `+`, `/` and `=` - so AJ30's transport works end to end unchanged.
- All six scalar-`err` call sites exist as cited (`pushService.ts:188`, `:235`,
  `:380`, `auth.ts:311`, `systemStatus.ts:204`, `:258`).
- `errors.ts:77-82` does read `raw.response?.status`; `infra/modules/jobs/main.tf:36`/`:41`
  are 120s / 5; `infra/modules/ec2/main.tf:410-411` ships all of
  `/var/log/messages`; `correlation.ts:14` mints rather than honors.
- `templates.ts:227-229` captures only sorted query KEYS, so the pointer value
  never reaches a perf artefact. AJ33's "verified safe" half is genuinely safe.

That is an unusually clean factual base for a spec this size. The findings below
are about what the document says, not about whether it checked its facts.

---

## 1. [BLOCKING] S5's two-query bracket is specified in milliseconds and executed in seconds - the split at `at` is not expressible, and the pattern the spec tells the builder to follow produces a duplicated anchor

**What is wrong.** S5 states two requirements that cannot both hold.

- Line 465: "Both bounds convert to EPOCH SECONDS." Reinforced with a dedicated
  section 7 test (lines 676-678) and the existing capitalised warning.
- Lines 487-489, the HUMAN DECISION mechanism:
  - BEFORE: `sort @timestamp desc | limit 25` over **`[bracketStart, at]`**
  - AFTER: `sort @timestamp asc | limit 25` over **`(at, bracketEnd]`**

`at` is an ISO timestamp with MILLISECOND precision - S6 sends the row's own
`timestamp` (line 568), which is `new Date(eventTimestampMs).toISOString()`
(`app/src/adapters/cloudwatch.ts:124`). The half-open split at `at` is a
millisecond boundary. The mechanism that must implement it has SECOND
granularity.

**Evidence.** `app/src/adapters/cloudwatch.ts:229-237`:
```
// CRITICAL: Insights StartQuery uses epoch SECONDS, not milliseconds.
const startOut = await logs.send(
  new StartQueryCommand({
    logGroupNames,
    startTime: Math.floor(sinceMs / 1000),
    endTime: Math.ceil(Date.now() / 1000),
```
`StartQuery` takes `startTime`/`endTime` in whole seconds. There is no third
value between `floor(at/1000)` and `floor(at/1000) + 1`.

So the builder has exactly three options, and the spec authorises none of them:

- BEFORE `endTime = ceil(at/1000)`, AFTER `startTime = floor(at/1000)` - **the
  convention the existing code uses, and the one a builder mirroring
  `cloudwatch.ts:233-234` will reach for.** The two windows OVERLAP by up to one
  second. Every line in the anchor's second - **including the anchor itself** -
  is returned by BOTH queries and appears TWICE in the merge.
- BEFORE `endTime = floor(at/1000)`, AFTER `startTime = floor(at/1000)+1` - every
  line strictly after `at` within the anchor's own second is dropped by BOTH.
- Same second on both, then reconcile in code - which requires a merge dedup rule
  the spec does not give.

**Line 490 says only "Merged ascending into one result of at most 50 rows."
There is no dedup rule, no tie-break, and no statement of which side owns the
anchor's second.**

**What it implies.** Three things, and the third is why this is BLOCKING rather
than HIGH.

(a) The guarantee at lines 492-493 - "This is the only shape that GUARANTEES the
anchor line is present" - is delivered by a mechanism that, under the
repo-idiomatic implementation, presents it twice. A duplicated failure line in a
timeline whose purpose is reconstructing a sequence is not cosmetic.

(b) The common case is the worst case. A `pollRunId` fan-out enqueues many jobs
inside one tick, i.e. many lines inside the SAME SECOND - and the spec itself
says (lines 482-483) "a `pollRunId` trace is the widest of the three by
construction". Same-second collision is the routine case for the pivot S2 widened
a non-goal to enable.

(c) **No gate can see it.** Section 7's test (lines 665-666) runs against an
injected fake seam, so the test author controls the rows and the second-boundary
never enters the assertion; and the hermetic lane degrades to `unavailable_local`
(`systemStatus.ts:212-214`), so e2e cannot reach it either. This is precisely the
"ships a defect no gate catches" class that the spec names as its own worst
outcome at lines 234-237.

**This is an edit seam, exactly as round 4 predicted.** The epoch-seconds
paragraph is AJ40 (round 3). The two-query split is AJ50 (round 4, human
decision). Round 4 reconciled AJ50 against the ascending-sort paragraph - it
added a whole NOTE FOR THE BUILDER to do so - and did not reconcile it against
the epoch-seconds paragraph sitting twenty lines above it.

**What the spec must state:** the boundary at second granularity (I would put the
anchor's whole second in the BEFORE query and start AFTER at
`floor(at/1000) + 1`, which keeps the anchor guaranteed and the windows
disjoint), OR an explicit merge dedup key. One sentence either way.

---

## 2. [HIGH] `ref` is declared REQUIRED and non-null, and thirty lines later the spec specifies behaviour for its absence

**What is wrong.** Two statements in the same slice contradict each other.

- S3, lines 214-217: "`source` and `ref` are **REQUIRED and non-null**. Every row
  has both, and making `source` optional would give the four-value union a fifth
  de-facto `undefined` state that S6's chip has no branch for - the same defect
  AJ28 fixed."
- S3, lines 266-271: "**DEDUP**: add `ref` to the key ... Keep them for **the
  absent-`ref` case**, which is the ONLY case where they still decide identity -
  and state it, because on that path a 300-char-truncated, vendor-authored
  `err.message` would otherwise silently become row identity."

If every row has a `ref`, the absent-`ref` case does not exist and lines 268-271
are a requirement with a justification for unreachable code. If the absent-`ref`
case is real, `ref` is not required, and the fifth `undefined` state that
paragraph 214-217 exists to forbid is back.

**Evidence of the seam.** The required/non-null rule is AJ56 (round 4). The
absent-`ref` dedup clause is AJ34 (round 2). Neither round touched the other's
paragraph.

**What it implies.** It reaches three layers, not one:

- the `ErrorEventView` type (`app/src/adapters/cloudwatch.ts:79-94`) - required
  vs optional changes the fixture breakage S3 lines 219-222 warns about;
- the dedup key at `app/src/services/systemStatus.ts:247`;
- **the React row key.** S6 line 561 says flatly "**ROW KEY**: use `ref`." If
  `ref` can be absent, every absent-`ref` row shares the key `undefined` and
  React mis-associates expander state across them - reintroducing AJ9, the exact
  defect the `ref` row key was adopted to fix.

A builder cannot satisfy both readings; they will pick one silently. Say which.

---

## 3. [HIGH] Section 7 contains no test for S1 at all - including the PII refusal that was round 1's BLOCKING finding

**What is wrong.** Section 7 (lines 653-687) lists 15 unit items, 2 component
items and 1 e2e item. Every one of them covers S2, S3, S4, S5 or S6. **There is
not a single entry for S1.**

S1 is not a trivial slice. It carries:

- a message-construction rule for the job dispatcher (line 113);
- two DISTINCT strings for two Express branches that currently emit an identical
  one (lines 122-127);
- a third WARN branch that "always yields `method + (unrouted)`" (lines 128-131);
- a deterministic route-template rule with a literal `(unrouted)` token
  (lines 139-144);
- **a PII REFUSAL: "THE CONCRETE PATH NEVER ENTERS `msg`"** (line 133), because
  `req.path` can carry a raw E.164 - verified at `app/src/routes/contacts.ts:2317`,
  `:2376` and `app/src/routes/relayGroups.ts:467`;
- an ASCII constraint on the touched lines (lines 150-152).

**What it implies.** The refusal at line 133 is the control that closes AJ13 -
which the adjudication file records as a **BLOCKING** finding whose acceptance
"invalidates a sentence I wrote" (adjudications.md:180-190). It is the single
highest-consequence rule in the slice: getting it wrong writes a tenant's phone
number into a low-cardinality field that section 8 is simultaneously teaching
operators to grep and that S1's own rationale says is "structurally free of PII".

Nothing asserts it. The rule lives only in prose, in a slice with no test line,
and every other gate is blind to it - `req.path` in `msg` typechecks, passes
lint, and renders fine.

The `(unrouted)` token has the same problem in miniature: an undocumented magic
string with no assertion pinning it, which S6 renders and an operator will grep.

Section 7 needs an S1 entry, and it must assert the refusal directly: given a
request to a `:phone` route, the logged `msg` contains the route TEMPLATE and
does not contain the concrete segment.

---

## 4. [MEDIUM] The perf-harness carve-out is conditioned on the wrong variable: the contract ledger keys on SOURCE LINE RANGES in a file S6 mandates editing, not on requests observed

**What is wrong.** Section 7 (lines 689-701) makes `e2e/performance/` changes
conditional on whether the profiler's walk reaches the expander:

> "If the profiler's walk does NOT reach the expander: leave `e2e/performance/`
> alone. An earlier draft's 'all three files must change together' was an
> over-claim."

The `required(...)`-vs-`conditional(...)` correction in that paragraph is right
and I do not contest it. But the condition is incomplete, because the perf
harness also pins SOURCE CITATIONS - and it pins them into the exact file S6
orders edited.

**Evidence.**

- `e2e/performance/routes.ts:680`:
  ```
  '/settings/system': { base: 'dashboard/src/routes/settings/useSettings.ts:18-62; dashboard/src/routes/settings/useSystemStatus.ts:77-132' },
  ```
- `e2e/performance/routes.ts:762`:
  ```
  systemAlarms: 'dashboard/src/routes/settings/useSystemStatus.ts:124-132',
  ```
- `e2e/performance/collect.test.ts:352-364` asserts that background list as
  **literal strings**, `'dashboard/src/routes/settings/useSystemStatus.ts:124-132'`
  first.
- S6 (line 539) names `dashboard/src/routes/settings/useSystemStatus.ts:177-230`
  as one of its four mandated files, and requires a new per-row detail fetch with
  its own loading/error/abort handling. That needs new imports; the import block
  is `useSystemStatus.ts:12-20`, **above** both cited ranges.

Adding one import line shifts `:77-132` and `:124-132` off the code they
document.

**What it implies.** A trap in both directions, which is why it is worth stating
rather than leaving to the builder:

- Builder edits `useSystemStatus.ts` and leaves `e2e/performance/` alone, as
  section 7 instructs: **all gates stay green** and the ledger silently rots.
  `routes.test.ts:401-434`'s `cited()` helper only regex-checks the citation's
  SHAPE (`/^[A-Za-z0-9_./-]+\.(?:ts|tsx):\d+(?:-\d+)?.../`), never that the lines
  exist or contain what they claim - so nothing detects it.
- Builder correctly refreshes the citation in `routes.ts:762`: **`collect.test.ts:353`
  goes red**, because it pins the old string literally. That is a surprise red
  `npm test` on a required gate, in a file the spec told them not to touch.

One sentence fixes it: if `useSystemStatus.ts` gains lines above 132, update the
two citations in `routes.ts:680`/`:762` AND the pinned literal in
`collect.test.ts:353` together.

*(Partial contest of AJ33, noted here rather than in section 11: the `conditional`
correction was right; "leave `e2e/performance/` alone" is not safe for a reason
round 2 did not consider.)*

---

## 5. [MEDIUM] S5's trace row omits `source`, on a two-group query whose entire purpose is the app-to-worker hop

**What is wrong.** S5 makes two decisions that sit badly together.

- Line 405: "**LOG GROUPS**: app + worker."
- Lines 472-474, SHAPE: "its own row type carrying timestamp, level, message and
  the diagnostic fields an INFO line needs (`method`, `path`, `statusCode`,
  `durationMs`, `jobName`, `jobId`, `hopCount`) - not `ErrorEventView`."

No `source`. So the trace renders an interleaved app+worker timeline in which the
reader cannot tell which process emitted a line.

**Why that matters here specifically.** S5's whole justification (lines 423-429)
is crossing the job hop: `requestId` covers request-originated work, `pollRunId`
covers poll-originated work, and the thing being traced is a request in the APP
process enqueuing a job that fails in the WORKER process. **The app/worker
boundary is the single most load-bearing structural fact on that timeline**, and
it is the one field the row omits.

It is also inconsistent with S3's own reasoning thirty lines earlier: S3 (lines
214-217) makes `source` REQUIRED and non-null on the LIST row - a single-row view
where the operator is looking at one failure - on the grounds that an
unrepresented state is a defect. The multi-row cross-process view drops it
entirely.

**Cost of fixing:** none beyond stating it. S5's query already spans two groups,
so it must carry `@log` in its `fields` clause for any per-row attribution, and
S3 already specifies the normalisation rule (line 242, fact 7). The mapping code
is shared.

**Consequence if unfixed:** the trace is still usable - `jobName` and `method`
let a reader infer the process most of the time - so this is MEDIUM, not HIGH.
But "most of the time" is doing work in a feature bought at the price of widening
a non-goal.

---

## 6. [MEDIUM] S5's field accessor shape is unspecified - a third context after AJ8 split list from detail

**What is wrong.** r5 states the accessor rule with real force, and scopes it to
two paths:

> Lines 231-237: "**ACCESSOR SHAPES DIFFER BETWEEN PATHS - do not conflate them.**
> The LIST path parses the raw `@message` string (`cloudwatch.ts:130`), where
> `err` is a NESTED object: read `(obj.err as ...).message`. `obj['err.message']`
> is `undefined` there. Only the DETAIL path (S4) sees dot-flattened keys."

S5 is a THIRD path and the rule does not name it. S5's row needs `level`,
`message`, `method`, `path`, `statusCode`, `durationMs`, `jobName`, `jobId`,
`hopCount` - all of which live inside the JSON `@message` - and S5 never states
its `fields` clause, in contrast to S3 which states its clause change explicitly
(line 226: "must gain `@ptr` and `@log` in `fields`").

**Both mechanisms are available and the spec picks neither.** A builder can
(a) keep `fields @timestamp, @message` and parse the JSON, getting NESTED access
like the list path; or (b) name the fields in the `fields` clause - Insights
supports dot-notation field references on parsed JSON - getting FLATTENED cells
like the detail path. The two produce different projection code, and one of them
is the shape the spec's own emphatic warning is about.

**What it implies.** This is AJ8 reincarnated in the slice added after AJ8 was
accepted - and AJ8 is recorded in the adjudications (`:126-136`) as "A's most
dangerous finding" precisely because the failure is a permanently blank field
that no gate catches. The spec should extend line 231-237 to say which shape S5
uses, or state S5's `fields` clause the way S3 states its own.

---

## 7. [MEDIUM] `ref` is now sole row identity in three places, on a property the spike did not measure

**What is wrong.** r5 promotes `@ptr` from "an opaque handle used immediately"
(r1's framing) to the primary identity of a row in three independent mechanisms:

- the dedup key (line 266: "the key becomes effectively `ref` alone");
- the React row key (line 561: "**ROW KEY**: use `ref`");
- the detail-fetch handle (S4).

The stated justification is one clause: "`@ptr` is unique per log event" (line
267). **Uniqueness is not the property these three uses need. They need
STABILITY - that the same log event yields the same `@ptr` in a DIFFERENT
Insights query.** Section 3 measured the pointer's length, charset and
resolvability. It did not measure stability across queries, and does not claim to.

**Where it bites, concretely:**

- **Dedup.** `app/src/services/systemStatus.ts:227-235` runs THREE separate
  `queryInsights` calls (three distinct `queryId`s) and merges their rows at
  `:245`. Cross-query dedup by `ref` only works if the same event carries the
  same pointer in two different queries. If it does not, the dedup that r5 says
  becomes "effectively `ref` alone" stops functioning entirely - and the
  `timestamp|message|errorCode` components it deliberately renders inert are the
  ones that were doing the work.
- **React key.** The errors panel refreshes on the manual button and on window /
  warnings changes (`useSystemStatus.ts:177-234`), each issuing a NEW query. An
  unstable pointer re-keys every row on every refresh, remounting them and
  collapsing any open expander - the visible symptom of the bug the `ref` key was
  adopted to prevent.

**Marked honestly: UNVERIFIED.** I cannot test AWS from here, and neither the
spec nor the repo settles it. That is the finding - the design's most load-bearing
new assumption is the one assumption section 3 did not sample, in a section
restructured specifically to stop inferences being presented as facts (see fact 8
and AJ52, where exactly this was caught once already).

Either add it to the spike (one query repeated, compare pointers) or state the
degradation: if pointers are not stable, dedup falls back to the retained
components and row keys churn on refresh.

---

## 8. [MEDIUM] The document does not fully stand alone: several requirements are stated as diffs against drafts the builder cannot see, and one slice needs a note explaining how to read itself

**What is wrong.** This is the over-correction finding, and it is the one respect
in which r5 is worse than the draft I reviewed. Four rounds of defending against
critique have left the review's bookkeeping inside the requirements.

**Load-bearing cases** (as opposed to harmless colour):

- **Line 216** - the ONLY stated rationale for a type decision is a citation into
  another file: "would give the four-value union a fifth de-facto `undefined`
  state that S6's chip has no branch for - **the same defect AJ28 fixed**." A
  builder who has not read `adjudications.md` cannot evaluate this.
- **Lines 476-503** - S5 contains a paragraph headed "ASCENDING SORT IS
  LOAD-BEARING" (416-421) and a later one that says "**This REPLACES the 'the
  query sorts ascending server-side' sentence above** as a description of
  mechanism". The spec then needs a further "NOTE FOR THE BUILDER" (501-503)
  telling the reader how to reconcile its own two paragraphs. A specification
  that must instruct the reader on which of its paragraphs to disregard has not
  finished being edited. The r4 mechanism should REPLACE the r3 text, with the
  diagnosis kept as one subordinate sentence.
- **Line 71** - "(adjudication RJ1)" is the only support given for a non-goal,
  repeated at line 606.
- **Line 206** - "(round 2, N2)" as the support for why two fields are not
  optional.
- **Line 258** - "**THE r1 'RELAX THE UNPARSEABLE FALLBACK' INSTRUCTION IS
  WITHDRAWN**" is a heading about a document the builder never saw.

Plus at least six more "an earlier draft ... " constructions (301, 314, 336, 620,
642, 695) and "it went unstated across three review rounds" (408).

**What it implies.** The prompt for this review is the test: a builder who has
never seen the conversation. Against that test, r5 asks the builder to hold a
diff in their head. The fix is mechanical - state the requirement, delete the
provenance, and move the "why we rejected the alternative" material into a short
"decisions considered and rejected" appendix if it is worth keeping at all. It is
MEDIUM rather than LOW only because line 476 and line 216 are places where the
provenance IS the requirement or IS the rationale.

I want to be precise about scope here: much of r5's insistent tone is EARNED and
should stay. The "do not reconcile them" note at line 333, the "do not
re-investigate" at line 703, and the "not a correction" entry at line 740 are
genuinely useful - they stop a builder redoing work. The problem is only the
places where the spec argues with a draft instead of stating a requirement.

---

## 9. [LOW] `systemStatus.ts:45` is cited as "the panel's selector"; it is the service's window map

**What is wrong.** S5, lines 432-434: "the list route defaults to 24h
(`system.ts:66-75`) while **the panel's selector goes to 7d
(`systemStatus.ts:45`)**".

**Evidence.** `app/src/services/systemStatus.ts:42-46` is `WINDOW_MS`, a
server-side lookup table; `:45` is the line `'7d': 7 * 24 * 60 * 60 * 1000,`.
The panel's selector is `dashboard/src/routes/settings/RecentErrors.tsx:16-20`
(`WINDOW_OPTIONS`, whose third entry is `{ value: '7d', label: 'Last 7 days' }`).

**What it implies.** The ARGUMENT is correct and important - a rolling window
would return zero rows for a five-day-old error - and the mis-citation does not
weaken it. But this is the one paragraph justifying a HUMAN-facing design
decision (AJ29), and it points a builder at the wrong file to confirm the premise.
Cite `RecentErrors.tsx:16-20`.

---

## 10. [LOW] The new fallback ladder can make `message` and `errMessage` the same string carrying two independent truncation flags, which S6 renders twice

**What is wrong.** Two r5 additions interact and neither mentions the other.

- Line 256, FALLBACK LADDER: `msg` -> `event` -> **`err.message`** -> `(unparseable log line)`.
- Line 247, TRUNCATION: "cap `errMessage` AND `message` at 300 characters, each
  with its **OWN** truncation flag so the UI can say which field was cut."
- Line 556, S6: "The collapsed row marks the capped field visibly and that marker
  is what invites the expander."

For a well-formed JSON line with no `msg` and no `event` - the case the ladder was
added for (AJ5/B14) - rung three sets `message = err.message`. `errMessage` is
independently `err.message`. Both are capped at 300 with separate flags, so the
row renders the same truncated text under two names with two truncation markers.

**What it implies.** Cosmetic, hence LOW, but it lands in the collapsed row that
S6 spent a decision on ("compact row"), and section 7 line 682 mandates a
component test asserting the indicators render "per capped field" - which will
encode the doubling. One clause: when `message` is derived from `err.message`,
the row shows one of them.

---

## 11. Contests and concessions on my round-1 adjudications

I read all 24 acceptances and both rejections. **I contest one, partially.**

- **RJ1 (dual-path retrieval fallback for an expired pointer) - I CONCEDE.** My
  own r1 text said the blast radius is bounded by S4's degrade contract and rated
  it LOW; the wording fix (AJ23) was the whole of my point and it was taken. A
  permanently-maintained second retrieval path for a failure mode that degrades
  visibly is the right thing to decline.
- **RJ2 (my proposed `@ptr` transport) - I CONCEDE, and the adjudication is
  better than my finding.** My r1 remedy said "query parameter or POST body"
  without specifying encoding, and the `qs` `+`-to-space rule would have
  corrupted a raw query value exactly as the adjudication says. AJ30 then landed
  on `encodeURIComponent`, which I verified works end to end:
  `dashboard/src/api/client.ts:44-52` uses `URLSearchParams`, which
  percent-encodes `+`, `/` and `=`. The r5 rationale at lines 288-292 for
  preferring it over base64url - no transform, no inverse, no unmeasured
  positional assumption about `=` - is stronger than anything I wrote.
- **AJ33 - I CONTEST ONE HALF.** The `required(...)` -> `conditional(...)`
  correction is right and I concede my "all three files must change together" was
  an over-claim about REQUESTS. But "leave `e2e/performance/` alone" is not safe,
  for a reason unrelated to requests: the contract ledger pins SOURCE LINE RANGES
  into `useSystemStatus.ts`, a file S6 mandates editing. Full evidence in finding
  4 above.

On the remaining 22: adjudicated correctly, and in four cases (AJ2's charset
measurement, AJ4's `@log` value, AJ6's dual remedy, AJ19's inversion) the
resolution is better than the finding that prompted it. AJ6 in particular went
further than I asked - I flagged the false guarantee and asked for honesty or a
control; r5 delivered honesty (section 6) AND a structural control (S4's `err`
allowlist), and then rounds 2-3 correctly rejected the denylist I would have
accepted. That is the review working.

---

## 12. Is anything worse than the draft I reviewed?

Asked directly, so answered directly.

**On the merits, no.** I checked each of my r1 findings against r5 and every one
is closed by a mechanism that actually delivers it, not by a hedge:

- the seam reuse (r1 #1) is now an explicit "IT DOES NOT REUSE `queryInsights`"
  with the three reasons cited;
- the transport (r1 #2) is measured and decided;
- `source` (r1 #3) is a four-value union with a stated derivation, an `unknown`
  fallback and a rendering branch;
- the relax-unparseable no-op (r1 #4) is withdrawn by name and replaced with the
  ladder, which is the reachable defect I only half-saw;
- the credentials guarantee (r1 #5) is struck and replaced with an allowlist -
  the structurally correct answer, and stronger than the denylist I would have
  settled for;
- the unbounded S4 response (r1 #6) is bounded at 64 KB with a scope check I did
  not think of;
- the accessor split (r1 #8) is stated in bold with the consequence spelled out.

**As a document, yes, in one respect:** finding 8. r5 is 767 lines against r1's
314, and a meaningful share of the growth is argument with drafts the builder
cannot read. The single sharpest symptom is that S5 now requires a note
instructing the builder which of its own two paragraphs is the design.

I looked specifically for other over-corrections and did not find them. The three
places I suspected one and checked all came back clean: S4's `err` allowlist is
narrower than r1 but the SCALAR-`err` clause (lines 348-357) rescues the six real
call sites I verified; the `rawText` decision widens exposure but the human made
it on stated reasoning after the false premise was removed; and S2 genuinely
delivers rather than being scope creep dressed as plumbing.

---

## Closing

**Not ready as written; one BLOCKING paragraph away from ready.** Finding 1 is a
real unbuildability - two requirements that cannot both be satisfied by the API
they run on - and it sits in the mechanism the human personally decided, so it
should go back with the decision intact and only the boundary stated. Findings 2
and 3 are cheap and should go in the same pass. Findings 4-7 are worth an
sentence each. Findings 8-10 are polish.

I found no reason to reopen any accepted decision, and I did not manufacture
findings to justify the round: nine of these ten are in material I had never seen,
and the tenth (finding 4) is a genuine hole in a carve-out made after my round.

The convergence signal across the whole review is good and I would not run a
sixth round. 24 -> 14 -> 9 -> 9 -> 10, with this round's count inflated by my
being fresh rather than by the spec regressing, and with the BLOCKING item being
a seam between two correct decisions rather than a contested one.
