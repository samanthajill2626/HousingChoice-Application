# Manual Extraction Trigger - Design and Scope

- Date: 2026-08-13
- Status: Ready for human review (8 adversarial review rounds; rebased onto
  main after the sonnet-5 extraction fixes of 2026-08-15)
- Owner: Cameron Abt
- Branch: `feat/manual-extraction-trigger`

## 1. Problem

AI conversation-fact extraction only ever runs because something scheduled it,
and every scheduling site is a reaction to traffic or a triage flip:

| Site | Channel | Trigger |
| --- | --- | --- |
| `app/src/routes/webhooks/twilio.ts:2160` | `sms` | inbound text |
| `app/src/services/inboundEmail.ts:748` | `email` | inbound email |
| `app/src/services/voiceTranscripts.ts:212` | `voice` | completed call transcript |
| `app/src/routes/contacts.ts:1605` | `triage` | human flips a contact to tenant |
| `app/src/routes/dev.ts:759` | `voice` | dev transcript fixture (hermetic only) |

There is no way for a human to say "extract this contact's facts now". The only
existing manual seam, `POST /__dev/extraction/tick` (`app/src/routes/dev.ts:643`),
drains rows that something else already scheduled, and it is structurally absent
in deployed environments.

### 1.1 Why this matters now

The Quo/Airtable import (M1.6) wrote a large body of historical conversation
into the system. Two properties of that data make it permanently invisible to
extraction:

1. **The importer never schedules extraction.** `app/src/lib/import/apply.ts`
   writes conversations and messages and does not call `scheduleExtraction`.
   Imported threads have no due row, so no poll will ever pick them up.
2. **The message timestamps are historical.** `apply.ts:411` writes
   `created_at: m.createdAt`, the original Quo timestamp. The job drops every
   message older than `MAX_TRANSCRIPT_AGE_DAYS = 30`
   (`app/src/jobs/extraction.ts:433-436`) before building the window.

So the facts in imported history have never been extracted and, under today's
rules, never will be.

### 1.2 Which gate actually fires

The age cutoff runs first and the freshness gate reads its output, so the two
are not independent. At `app/src/jobs/extraction.ts:435`, `fresh` is the
post-cutoff list; `hasNewClient` at line 449 tests `fresh.some(...)`; and the
`no_new_client` exit at line 452 is checked BEFORE the `fresh.length === 0`
exit at line 458.

For a conversation whose every message predates the cutoff, `fresh` is empty, so
`hasNewClient` is false and the run skips as **`no_new_client`** - it never
reaches `empty_window`. A design that waived only the freshness gate would then
fall through to `empty_window` on the very next line. Both gates must be waived
together for a manual run to reach the model, and neither one alone is the
culprit.

## 2. Goal

A staff user can open a contact, press one action, and have the extraction layer
run over that contact's stored conversation history **without an age floor**,
**watch it run to completion on that page**, and see its outcome - including an
outcome that changed nothing. Suggestions appear without a reload and the run is
recorded in the AI run log.

"Without an age floor" is the precise claim. It is not "all history": the
newest-50 message page (`MAX_TRANSCRIPT_MESSAGES`) and the 60k-char window
budget (`WINDOW_CHAR_BUDGET`) still bound every run, there is no backward
pagination, and pressing again re-reads the same newest page. A contact with
more than 50 messages of imported history will have its oldest messages read by
no run, manual or automatic. See section 8.

## 3. Locked decisions

Settled in brainstorming; not open in review:

1. **Surface: the contact page.** One action, per contact. Not Settings, not
   API-only.
2. **Waive `no_new_client` and the 30-day age cutoff together**, for manual runs
   only. Automatic runs keep both; the cutoff exists so routine polls do not
   re-bill ancient history on every inbound text.
3. **Keep `no_contact`, `ineligible_type`, and `empty_window`.** These mean
   there is genuinely nothing to send or nowhere to write it.
4. **The endpoint schedules, responds, THEN runs the work in-process.** No model
   call happens inside an HTTP request - the response is sent first. The worker
   poll remains the backstop and either process may win the claim.
5. **The operator watches the run.** The action shows a running state until the
   run reports back, then renders its outcome - including outcomes that change
   nothing. This is a change from the original "fire and forget" design and it
   subsumes what was previously deferred as a run-status surface.
6. **Single contact per press. No bulk backfill.** Separate work; see section 9.
7. **Permanent dismissal tombstones still apply.** A manual re-run will not
   re-suggest a dismissed value; it records `dismissed_before` instead.
8. **No new role.** Any authenticated staff user may press it, the same bar as
   accepting a suggestion or triaging a contact.
9. **The conditional `fail` fix ships with this feature** rather than being
   filed. It is required for correctness of the manual path (4.1) and
   incidentally repairs the same hazard for inbound messages. Boundary in
   section 9.

## 4. Design

### 4.1 A sticky `manualRequested` flag on the due row

The due row (`due#<conversationId>`) gains one sparse attribute:

```
manualRequested?: true
```

`ExtractionRepo` gains one method:

```
requestManualExtraction(conversationId: string, dueAt: string): Promise<void>
```

It upserts exactly like `scheduleExtraction` - SET `dueAt`, `_duePartition`,
`conversationId`, `updatedAt`, `createdAt` via `if_not_exists` - plus
`manualRequested = true`, and **deliberately does not touch `channel`**.

**Why `channel` is not written.** Storing `'manual'` in `channel` would create a
second manual signal that outlives the flag: `channel` has no clearing site, so
a row could later present `channel = 'manual'` on a run whose gates were
automatic, and the run log would record a manual trigger for an automatic run.
Leaving `channel` alone keeps it meaning exactly what it means today - what last
scheduled this row through an inbound path - and makes `manualRequested` the
single source of truth for both gate waiving and the recorded trigger.
`DueExtractionItem.channel` becomes optional, since a manual press on a
never-scheduled imported conversation creates a row that has never had one.

**Why a sticky flag rather than a per-request argument.**
`scheduleExtraction` is a sliding upsert. If a tenant replies between a manual
press and the poll claiming the row - up to the 60s poll interval plus debounce
- an ordinary schedule slides `dueAt` forward. A flag that lives on the row
survives that; anything encoded in the channel would not.

Lifecycle:

- `requestManualExtraction` sets it.
- **`claim` REMOVEs it**, in the same conditional update that already REMOVEs
  `_duePartition` and `dueAt`. The job reads the row returned by `listDue`, so
  the claimed run keeps its own value while a press landing during that run
  writes a fresh flag for the next one. Clearing at `complete` instead would let
  a finishing run wipe a flag it does not own, silently downgrading the run the
  operator just asked for.
- **`fail` becomes conditional on nobody having re-armed the row.** Today `fail`
  writes `dueAt` unconditionally: the re-arm branch SETs it to
  `now + backoff` (up to an hour) and the park branch REMOVEs it along with
  `_duePartition` (`app/src/repos/extractionRepo.ts:307-352`). Either one
  destroys a press that landed during the failing run - the park branch
  permanently, since the row leaves the due index with nobody left to re-arm it.
  That is the same bug class as the `complete` case above, on the sibling write
  path.

  Both branches gain the condition below, and `fail` takes `listedDueAt` - the
  value `listDue` returned for this row. Note where that comes from: the only
  production `fail` call site is in `runDueExtractions`
  (`app/src/jobs/extraction.ts:664`), NOT in `processRow`, and there the value
  is `row.dueAt`, which is optional on `DueExtractionItem`. `processRow` guards
  its own use of it (`app/src/jobs/extraction.ts:363-364`) but that guard does
  not reach the caller. The builder must handle the `undefined` case explicitly
  at the call site rather than assert it away; an absent `dueAt` there means the
  row was malformed, and the honest behavior is today's unconditional write.

  ```
  ConditionExpression: attribute_not_exists(_duePartition) OR dueAt = :listedDueAt
  ```

  **`attribute_not_exists(_duePartition)` alone is wrong**, and dangerously so.
  `fail` is reached on two kinds of path. On the normal path the claim succeeded
  and removed `_duePartition`, so the bare predicate holds. But when `claim`
  itself THROWS, `processRow` returns `failed('repo', err)`
  (`app/src/jobs/extraction.ts:367-370`) and the row was never un-armed - so the
  bare predicate is false, `fail` would take the fallback branch forever, the
  row would never back off and never park, and the poll would retry it every
  interval indefinitely, writing a run-log record each time. A transient
  DynamoDB error on one claim would produce an unbounded billed retry loop.

  The disjunct fixes it without giving up the protection: an unclaimed row whose
  `dueAt` still equals the listed value has demonstrably not been re-armed, so
  backoff and parking proceed normally. If something DID re-arm it during the
  throw, `dueAt` differs, the condition fails, and the press is preserved -
  the same guarantee as the claimed path. Both paths terminate.

  When the condition fails, `fail` performs a second, scheduling-free update
  that records `lastError` and increments `attempts` only, leaving the fresh
  `dueAt` and `manualRequested` untouched. The re-armed run happens on its own
  schedule.

  If that fallback update ALSO throws, `runDueExtractions` logs and swallows it
  (`app/src/jobs/extraction.ts:663-667`), so the attempt is not counted and the
  row keeps its schedule. This is exactly today's behavior when the current
  single-step `fail` throws, and it is not made worse here - but the two-step
  form has two writes that can fail instead of one, so the fallback logs at
  `error` with the conversation id. Out of scope to fix properly (section 9).

  This also fixes the pre-existing case where an ordinary inbound message
  arriving during a failing run had its `dueAt` overwritten or removed. That bug
  ships today; this feature makes it operator-visible, which is why it is fixed
  here rather than deferred. See section 9 for the boundary.
- **The re-arm branch re-sets `manualRequested`** when the run that failed was
  manual, so backoff retries stay manual. `fail` takes the manual-ness of the
  run from the job, which knows it.

  One consequence to accept knowingly: the `complete` error kind
  (`app/src/jobs/extraction.ts:354-361`) fires AFTER `applyExtraction` has
  already committed. Re-arming that run as manual means the retry re-sends the
  full un-aged window and re-bills it, where an automatic retry might have
  skipped as `no_new_client`. That is the correct trade - a manual run whose
  cursor write failed genuinely has not finished - but it is a real duplicate
  cost on a rare path, and it is why section 6's per-press cost is a floor
  rather than a fixed price.
- **The park branch REMOVEs `manualRequested`.** A parked row is inert until
  something re-arms it; leaving the flag set would waive both gates on whatever
  automatic run schedules it next, months later.
- **Both `fail` branches, and the fallback, also REMOVE `claimedAt`**, which
  `complete` already does and `fail` never did. See 4.4a-i: this is what makes
  `claimedAt` mean "a run holds this row" rather than "was claimed at some
  point", and the in-flight guard depends on it.
- `complete` does not touch `manualRequested` - `claim` already cleared it.

### 4.2 Two gate changes in the job, both scoped to `manual`

The job computes `const manual = row.manualRequested === true` and keys
everything off that, never off `channel`. In `app/src/jobs/extraction.ts`:

1. **Age.** The cutoff at line 433-436 is skipped when `manual`: `fresh` becomes
   the whole fetched page and `agedOutTsMsgIds` is empty.
2. **Freshness.** `hasNewClient` (line 449) is true when `manual`, joining the
   existing `voice` and `triage` bypasses - an established pattern, since both
   already bypass this gate because their signal is content the cursor cannot
   see.

The two waivers serve different cases and both are needed, but not for the same
conversation:

- On a **never-extracted imported** conversation (`cursor = ''`), the age waiver
  alone is sufficient: once the aged messages survive into `fresh`, any inbound
  among them satisfies `tsMsgId > ''` and `hasNewClient` passes on its own.
- On an **already-extracted** conversation, the freshness waiver is the one that
  matters: the cursor has advanced past every message, so `hasNewClient` is
  false no matter how wide the window is. This is the "press it again to see
  what the model does" case.

Nothing else about window assembly changes: the per-message tier caps, the 60k
budget, the newest-first fill, and the `group_ambiguous_origin` filter behave
exactly as for an automatic run. For a never-extracted conversation `cursor` is
`''`, so every message falls in the `new` tier at the 30k per-message cap,
bounded by the 60k window budget. Worst-case manual run input is unchanged from
the existing worst case.

### 4.3 The run record must not misreport the window

`app/src/services/extraction/runWindow.ts:113` stamps
`windowParams.maxTranscriptAgeDays` from the module constant. A manual run that
waived the cutoff would record `30`, describing a window that was never sent.

`RunWindowParams.maxTranscriptAgeDays` becomes `number | null`, where `null`
means "no age floor was applied", and `buildFullRunWindow` takes the effective
value from its caller instead of reading the constant. The matching dashboard
type at `dashboard/src/api/types.ts:292` widens to match.

**No component renders `windowParams` today** - it exists only as a type and in
the API response. The change is to the stored audit record and the served
payload, which is where it matters; a renderer is out of scope (section 9).
Every existing stored run has a number and is unaffected. No migration.

### 4.4 The trigger recorded in the run log

`RunTrigger` gains `'manual'`. The trigger is stamped in `newRunDraft`
(`app/src/jobs/extraction.ts:297-299`), which runs **before** the row is
claimed, so it reads `row.manualRequested` from the `listDue` row and records
`manual ? 'manual' : row.channel`. Since `channel` is never written as
`'manual'` (4.1), a manual label can only come from the flag.

**`channel` becoming optional breaks `newRunDraft` at the type level.** It
currently assigns `trigger: row.channel` into a required `RunTrigger`
(`app/src/jobs/extraction.ts:298`); once `channel` is `string | undefined` that
does not compile. This is not a judgement call left to the builder - the spec
decides it:

```
trigger: row.manualRequested === true ? 'manual' : (row.channel ?? 'manual')
```

The `?? 'manual'` arm is a **totality device, not a second labelling rule**. The
guarantee above is therefore stated precisely: a `manual` label originates from
the flag on every reachable path. The proof runs through the due index, not
through the flag's writers:

- `newRunDraft` only ever sees rows returned by `listDue`, and `listDue` returns
  only ARMED rows (`_duePartition` present).
- The only writer that arms a row without setting `channel` is
  `requestManualExtraction`, and it always sets the flag.
- Both flag-stripping sites - `claim` and the park branch of `fail` - also
  remove `_duePartition` in the same update, so a stripped row is simultaneously
  de-armed and cannot be listed again until something re-arms it. Whichever
  writer re-arms it either sets `channel` or sets the flag.

So every channel-less row that reaches a draft carries the flag, the second arm
is unreachable, and it exists so the expression is total and no `undefined` can
reach a stored record.

The test asserts exactly that - that the expression is total and yields a valid
`RunTrigger` for a channel-less row - and does NOT assert that a flagless
channel-less row "is a manual run", which would encode the contradiction rather
than the invariant.

The dashboard's `AiRunTrigger` union gains `'manual'`. **No other run-log change
is needed:** `AiRunList.tsx:55` and `AiRunDetail.tsx:50` render `trigger` as
free text and there is no trigger filter UI to extend. Together with 4.3, the
dashboard type file is the only run-log-side edit.

### 4.4a The in-process immediate run

Waiting for the 60s worker poll (`app/src/worker.ts:398`) would mean a running
indicator on screen for 5 to 70 seconds. Instead the endpoint kicks the work off
itself, in the app process, AFTER the response is sent.

This is safe in this deployment specifically: app and worker are long-lived
Docker containers on one EC2 host (`infra/modules/ec2/main.tf:1`), not Lambda,
so there is no freeze-after-response semantics to lose the work to. The model
call is I/O-bound - a held socket, not CPU - so a human-frequency press does not
meaningfully load the shared t4g.small.

`app/src/jobs/extraction.ts` grows one export:

```
runExtractionForConversations(conversationIds: string[], nowIso: string, deps: ExtractionJobDeps)
```

`runDueExtractions`'s per-row body is extracted into a shared helper so both
entry points run the SAME code - the draft allocation, the backstop, the failure
routing, `recordRun`, and `stampSuperseded`. The only difference is row
selection: `listDue` for the poll, `repo.getDue(id)` per id here. Reimplementing
the loop instead of sharing it would fork the machinery that took four review
rounds to get right.

**The claim is NOT a mutex, and this design must not pretend otherwise.** It is
a debounce collapse: it stops two runners claiming the SAME scheduled instance
(`app/src/repos/extractionRepo.ts:250-285`), and says nothing about two
instances overlapping in time. Without the guard below, pressing twice would
routinely produce two concurrent runs on one conversation - the second press
re-arms the row and its own endpoint call claims it while the first run is still
in its model call. That would mean two billed calls over the same window, two
`complete()` writes racing with independently computed cursors (so the cursor
can move BACKWARDS), and a `fail()` from one run re-arming a row the other is
still executing. It would also invalidate the round-4 soundness argument for the
conditional `fail`, which enumerated interleavings assuming a single runner.

**The in-flight guard (4.5a) is what makes 4.4a safe**, not the claim.

The call is fire-and-forget with respect to the response, but NOT unobserved: it
is wrapped so a rejection is logged at `error` with the conversation id and can
never become an unhandled rejection. The HTTP response has already been sent and
its status does not depend on the run's outcome.

**Known pre-existing hazard, unchanged and out of scope.** If the process
running an extraction dies mid-run, the row stays claimed and out of the due
index with nothing to re-arm it - there is no stale-claim reaper. That is true
of the worker today; routing some runs through the app does not create it, and
a container restart during a 10-second window is the exposure. Recorded here so
the builder does not think this design introduced it. See section 9.

### 4.4a-i The in-flight guard

**First, `claimedAt` is made to mean what its name says.** Today `claim` sets it
and only `complete` clears it (`app/src/repos/extractionRepo.ts:261,293`);
neither branch of `fail` does. So a row that failed hours ago still carries a
`claimedAt`, and the attribute means "was claimed at some point", not "is being
run". **Both branches of `fail`, and its scheduling-free fallback, now REMOVE
`claimedAt`** exactly as `complete` does. Verified safe: nothing in the codebase
reads this attribute for logic - the only readers are repo tests asserting the
clear behavior - so this narrows its meaning without changing any consumer.

With that, `claimedAt` present means precisely "a run holds this row", and the
guard is one clause plus a staleness escape:

```
attribute_not_exists(claimedAt) OR claimedAt < :staleBefore
```

where `staleBefore = now - MANUAL_CLAIM_STALE_MS`.

**The constant must be derived from a bounded run, and today nothing bounds
one.** `AnthropicExtractionDriver` constructs its client with no `timeout` and
no `maxRetries` (`app/src/adapters/extraction.ts:218`) and the job awaits
`driver.extract()` unguarded (`app/src/jobs/extraction.ts:491`), so the call
inherits the SDK defaults: a 10-minute request timeout with 2 retries, and
timeouts are themselves retried. Worst-case wall clock is therefore about
**30 minutes** - a hung call outlives any five-minute window, the guard reads
the row as stale while the run is still going, and a press starts the
concurrent run the guard exists to prevent.

So the driver bounds itself first. Three constraints drive the constants:

1. **The timeout must exceed a full-length generation, and that length is a
   function of `MAX_OUTPUT_TOKENS`.** The SDK models worst-case duration
   linearly - 60 minutes at 128k output tokens - in
   `calculateNonstreamingTimeout` (`node_modules/@anthropic-ai/sdk/client.js`,
   `expectedTime = (3_600_000 * maxTokens) / 128_000`). At the cap of 4096
   (`app/src/adapters/extraction.ts:171`) that is **115.2s**.
2. **SDK-level retries are disabled, because their sleeps are unbounded.** The
   SDK honours a `retry-after` header with no cap, so `timeout x (maxRetries +
   1)` is NOT the real worst case and a guard test asserting it would stay
   green while the property it protects is violated. Setting `maxRetries: 0`
   removes the sleeps entirely and makes the bound exact.
3. **Nothing is hardcoded to a cap that moves.** This exact defect has now
   happened once: an earlier revision of this spec fixed the timeout at 120s,
   derived from a 57.6s estimate at `MAX_OUTPUT_TOKENS = 2048`. Main then
   raised the cap to 4096 for unrelated reasons (`09831370`), which doubled the
   SDK's estimate to 115.2s and silently cut the headroom to under five
   seconds. A hardcoded number cannot survive a cap change it never sees, so
   the constants are **computed from the cap**.

Disabling SDK retries loses nothing, because **the job already owns retry**:
a failed call routes through `repo.fail()`'s attempt counter, exponential
backoff, and park-at-five (`app/src/jobs/extraction.ts:654-668`). SDK retries
were a second, redundant retry layer inside the first, with worse behavior on
rate limits - a tight SDK retry hammers a 429 that the job's backoff would have
waited out. The visible change is that a transient error now surfaces as a
`failed` run record and a backed-off retry rather than being silently absorbed,
which is more honest observability, not less.

Resulting set, every value computed rather than written down:

```
// The SDK's own worst-case model, restated so the chain is auditable.
SDK_WORST_CASE_MS             = (3_600_000 * MAX_OUTPUT_TOKENS) / 128_000  // 115_200 at 4096
EXTRACTION_REQUEST_TIMEOUT_MS = 2 * SDK_WORST_CASE_MS                      // 230_400
maxRetries                    = 0        // job owns retry; no uncapped sleeps
MANUAL_CLAIM_STALE_MS         = 2.5 * EXTRACTION_REQUEST_TIMEOUT_MS        // 576_000
```

Worst case is exactly the timeout, and each constant carries its stated
multiple over the one below it. **Raising `MAX_OUTPUT_TOKENS` now widens the
timeout and the staleness window automatically** - the failure that just
happened cannot happen again.

Two guard tests, because the chain has two links that can break independently:

- `EXTRACTION_REQUEST_TIMEOUT_MS >= 2 * SDK_WORST_CASE_MS`, with
  `SDK_WORST_CASE_MS` recomputed in the test from `MAX_OUTPUT_TOKENS` and the
  SDK's constants. This fails if someone replaces the derivation with a literal.
- `MANUAL_CLAIM_STALE_MS >= 2.5 * EXTRACTION_REQUEST_TIMEOUT_MS`. This holds
  only because retries are off; if `maxRetries` is ever raised, the premise is
  gone and the bound must be re-derived, not re-tuned.

The SDK's linear model is deliberately conservative - a structured-output call
emitting a few hundred tokens of JSON finishes in seconds, nowhere near 115s.
That conservatism is the point: it is the only non-guessed number available,
and the cost of being generous is a slower stranded-claim recovery, not a
wrong result.

**Where the constants live matters.** They do NOT get exported from
`adapters/extraction.ts`: `app/src/repos/extractionRepo.ts:38` imports that
module `import type`-only, and adding a runtime import would pull
`@anthropic-ai/sdk` into every module that imports the repo - the exact shape
already filed as debt in `extraction-runwindow-module-cycle`. Both constants go
in a leaf module that imports nothing, which the adapter, the repo, and the
test all read.

This bounds automatic runs too, which is a deliberate and separately good
outcome: an unbounded model call in a poll job can hold a claim for half an
hour today. A timeout is already handled end to end - the driver's catch arm
returns `failure: 'driver'`, which flows through the existing attempts/backoff/
park path and produces a `failed` run record and an `ai_run.completed`. See
section 9 for the boundary.

**Interaction with the thinking fix on main.** `09831370` pinned
`thinking: {type: 'disabled'}` on every call
(`app/src/adapters/extraction.ts:188`) because an absent parameter means
different things per model - `claude-opus-4-8` ran without thinking,
`claude-sonnet-5` ran adaptive thinking against the same shared `max_tokens`
budget. That fix is what makes the cap mean "JSON only", and therefore what
makes the SDK's token-derived duration model a sane basis for the timeout at
all. This spec depends on it: if thinking is ever un-pinned, output tokens stop
being a proxy for wall-clock duration and the derivation above needs revisiting.

**The guard lives in `requestManualExtraction`'s `ConditionExpression`, not in a
read before it.** A read-then-act check has a window: two presses can both read
"idle", and the second can schedule after the first has already claimed, so both
run. Putting the predicate in the conditional write closes that window - the
scheduling upsert itself fails when a run holds the row. A
`ConditionalCheckFailedException` for a thread means "already running"; anything
else propagates.

Why each piece is right, in the states that previously broke it:

- **A run in flight with an inbound arriving mid-run.** The inbound re-arms the
  row, so `_duePartition` comes back while the run continues. An earlier draft
  of this guard tested `_duePartition` absent as a proxy for "running" and read
  this state as idle, admitting a second concurrent run - the exact failure the
  guard exists to prevent. `claimedAt` is unaffected by the re-arm and reads
  correctly.
- **A parked row.** Park removes `_duePartition` and now also clears
  `claimedAt`, so a press proceeds. This is what makes section 8's "a second
  press is the recovery" true rather than aspirational.
- **A row that has never been scheduled** - every never-extracted imported
  conversation, the primary case for this feature. There is no item at all, so
  `attribute_not_exists(claimedAt)` holds and the upsert creates the row. No
  special-casing needed.
- **A process that died mid-run.** `claimedAt` is never cleared, so the
  staleness clause is the only way back; past the window a press proceeds. This
  also gives the operator a manual recovery from the stranded-claim hazard
  (4.4a) that does not exist today.

A skipped thread is reported honestly rather than silently: the response
distinguishes threads scheduled from threads already running, and 4.6 tells the
operator a run is already in progress instead of pretending a new one started.

**A refusal can discard the operator's intent, and the copy must say so.** The
in-flight run may be an AUTOMATIC one, which keeps the 30-day cutoff and will
skip on exactly the imported population this feature exists for. The press is
then refused and nothing manual ever happens. The guard cannot tell the two
apart - `claim` clears `manualRequested` before the guard ever reads the row -
so rather than guess, the copy covers both cases honestly: a run is already in
progress on this thread, and if the full history is what is wanted, press again
once it finishes. A second press after the in-flight run completes always
schedules.

**What this guard does and does not cover.** It covers presses, which is the
concurrency 4.4a introduces. It does NOT cover an inbound message arriving
during a run: that re-arms the row, and if the run outlasts the debounce plus
the poll interval, the worker can claim and start a second concurrent run. That
hazard ships today with no manual trigger anywhere near it and needs a run
exceeding roughly 30-90 seconds to be reachable. Closing it would require
turning the claim into a real lease, which is out of scope (section 9).

**A press absorbs a pending inbound countdown; it does not race it.** There is
exactly one due row per conversation and the debounce is a `dueAt` value on it,
not a separate timer. An inbound sets `dueAt = now + 30s`
(`app/src/lib/config.ts:897`); a press slides that same row to `now`. The
pending automatic run is therefore replaced by the manual one rather than
running alongside it. A consequence to expect: pressing mid-burst pre-empts what
the debounce is for, so the tenant's next text re-arms the row and produces a
second run - correct, since that is new content, but it costs a second call.

### 4.4b `ai_run.completed` - the event that resolves the indicator

`AppEventMap` gains an eighth event (`app/src/lib/events.ts:271-298`). The
`ALL_APP_EVENTS` record is exhaustive by construction, so adding the name there
is a compile error until it is registered - which is exactly what guarantees it
crosses the worker-to-app bridge rather than silently missing it.

Payload: `{ conversationId, runId, outcome, skipReason?, errorKind?, wrote,
suggested, notedLines, contactId? }` - ids and counts only, never field values
or message content, matching the PII rule the job already follows.

**`conversationId` is the match key, not `contactId`.** `contactId` is optional
on the draft and is never set on a `no_contact` run
(`app/src/jobs/extraction.ts:392-397` returns before the assignment at `:399`),
so an indicator keyed on it would hang on exactly the runs that resolve fastest.
`conversationId` is present on every draft from allocation
(`app/src/jobs/extraction.ts:297-299`), and 4.6 already counts one event per
returned `conversationId`. `contactId` rides along when known, for consumers
that want it.

**The counts must be put somewhere they exist.** `wrote` and `suggested` live on
`applyOutcome` inside `processRow` and never reach `RunDraft`; `notedLines` does.
The builder adds the two counts to the draft where `notedLines` is already set
(`app/src/jobs/extraction.ts:531-532`) rather than re-deriving them from
`draft.decisions`, which is assembled best-effort and can legitimately be
absent - a degraded observability record must not become a wrong count in a
live event.

Emitted once per run from the job, immediately after `recordRun`, for **every**
run rather than only manual ones: a uniform rule is easier to reason about than
a conditional emit, and the volume is bounded by the extraction rate, which is
already one model call per run. No claim is made about this making the run-log
page live - `useAiRuns.ts` does not subscribe to the event stream and this spec
does not change that.

`recordRun` is best-effort and swallows its own failures
(`app/src/jobs/extraction.ts:573-578`). The emit therefore sits AFTER it but
does not depend on it: a run whose log write failed still emits, because the
indicator's correctness must not hinge on an observability write.

Emitting from the job rather than the endpoint is what keeps the indicator
correct when the app-side attempt LOSES the claim: the worker runs it, emits,
and the bridge carries it to the waiting page. The page never needs to know
which process did the work.

That covers a lost claim, **but not every case**. If an inbound message slides
`dueAt` into the future between the schedule and the app-side attempt, the
app-side claim fails its `dueAt <= now` condition and nobody runs the row until
that new `dueAt` comes due and the poll reaches it - up to a debounce plus a
poll interval later. No event arrives in the meantime. This is what 4.6's
timeout exists for; the indicator must not claim "resolves either way".

### 4.5 `POST /api/contacts/:contactId/extraction-run`

Mounted in `app/src/routes/contacts.ts` alongside the other per-contact actions.

On success:

1. Load the contact; 404 if absent.
2. Resolve its threads with `conversationsForContact`
   (`app/src/lib/contactThreads.ts:38`), which unions phone and email
   participants and dedupes by `conversationId`.
3. **Filter to `tenant_1to1` and `unknown_1to1`.** `conversationsForContact`
   returns the raw union and its own header warns that a phone query can return
   `relay_group` threads, which front a pool number. Every other caller filters;
   so does this one. This is the SAME predicate the inbound sites already apply:
   `touched?.type === 'tenant_1to1' || touched?.type === 'unknown_1to1'` at
   `app/src/routes/webhooks/twilio.ts:2155-2158` and, in its own words "the EXACT
   twilio predicate", `app/src/services/inboundEmail.ts:741-746`. The voice and
   triage hooks do not filter, because they react to an event on one specific
   thread rather than fanning out across a contact's threads; fanning out is
   what makes the filter mandatory here.
4. `requestManualExtraction(conversationId, nowIso)` for each surviving thread,
   with no debounce - `dueAt = now`, as the voice and triage paths do. The
   in-flight guard (4.4a-i) is inside this call, so the partition into scheduled
   and already-running threads is the set of calls that succeeded versus the set
   that raised `ConditionalCheckFailedException`. There is no separate
   pre-read.
6. `audit.append('contacts#<contactId>', 'extraction_run_requested', { actor,
   scheduled: scheduled.length, alreadyRunning: alreadyRunning.length })`. The
   counts matter: an unconditional entry with no counts cannot distinguish a
   press that started three runs from one that started none, which is most of
   the audit value for an action that spends money.
7. Respond `200 { scheduled: string[], alreadyRunning: string[] }` - both as
   `conversationId` arrays. The client waits for one completion event per entry
   in `scheduled`, and must NOT wait on `alreadyRunning`: those runs were
   started by someone else and their events may already have fired. A response
   with an empty `scheduled` and a non-empty `alreadyRunning` is a success, not
   a refusal, and 4.6 renders it as "already running".
8. **After responding**, call `runExtractionForConversations` on the `scheduled`
   ids (4.4a). Failures here are logged, never surfaced through the already-sent
   response.

**This is not the same fan-out as the triage re-extraction hook.** That hook
(`app/src/routes/contacts.ts:1557,1569-1574`) resolves threads from the contact's
SCALAR primary phone plus their emails. This endpoint uses
`conversationsForContact`, which covers ALL of the contact's phone refs.
Deliberately broader: a contact with a secondary number has real history on that
thread, and a manual press should not silently miss it.

Refusals, each with a distinct machine-readable reason so the UI can explain
itself:

| Condition | Status | Reason |
| --- | --- | --- |
| Unknown contact, or a phone-pointer id | 404 | `contact_not_found` |
| `config.aiExtractionEnabled` is false | 409 | `extraction_disabled` |
| Contact type is `landlord`, `partner`, or `team_member` | 409 | `ineligible_contact_type` |
| Contact has no threads at all | 409 | `no_conversations` |
| Threads exist but none survive the type filter | 409 | `no_eligible_conversations` |

The response body is `{ error: '<reason>' }`, the shape every sibling route in
this file already returns (`res.status(404).json({ error: 'contact_not_found' })`
at `app/src/routes/contacts.ts:1059`), so the client parses one shape.

The phone-pointer case is a **404 `contact_not_found`**, reusing the branch the
sibling contact endpoints already have rather than inventing a status: those
routes 404 an unknown contact and a phone-pointer id identically and say so in
their comments (`app/src/routes/contacts.ts:1078-1086,1123-1130,1258-1267`). A
new 409 here would make this the only per-contact route that answers a
phone-pointer id differently from its neighbours.

The type refusal mirrors the job's eligibility rule
(`app/src/jobs/extraction.ts:401-406`). Queuing a row guaranteed to skip would
burn a poll cycle and write a misleading `skipped` record. Eligible types are
`tenant` and `unknown`.

The last two rows are deliberately distinct reasons. A contact whose only thread
is mis-typed - a real, documented state, since triage flips `unknown_1to1` and
can leave a thread resolved to another identity - would otherwise be told
"no conversations", which is false and sends the operator looking for missing
data instead of at the thread's type.

Unlike the triage hook, a scheduling failure here is **not** best-effort:
scheduling is the entire point of the request, so a repo error is a 500 and the
UI reports that nothing was queued.

### 4.6 The UI

The action goes in the contact header's `ContactActionsMenu`
(`dashboard/src/routes/contact/ContactActionsMenu.tsx`), the existing home for
per-contact actions. There is no "AI suggestions area" to sit beside -
`SuggestionChip` renders inline per field.

**Where the result renders.** `ContactActionsMenu` is purely presentational: it
takes `on*` callbacks plus `*Busy` flags and the parent owns every request
(`ContactActionsMenu.tsx:11-33`). This action follows that contract exactly -
`onRunExtraction` + `extractionBusy` - and `ContactDetail` performs the call.
There is **no toast primitive in this dashboard**, so the outcome renders in
`ContactDetail`, following the existing `styles.deletedBanner` pattern
(`ContactDetail.tsx:483`). Success uses `role="status"`; a refusal or error uses
`role="alert"`, matching the file's own idiom for errors rather than announcing
a failure politely. This region is where the running indicator and its
resolution live, so it is load-bearing rather than optional dressing: it is the
operator's only feedback that the press did anything at all.

Label: "Run AI extraction". **The server is the only gate.** The action is
always enabled; on a 4xx the UI renders the returned reason in that same
region. The contact
page does not hold `aiExtractionEnabled` - it is a server-side router dependency
at `app/src/routes/api.ts:740` and is exposed to clients only by
`GET /api/system/flags` (`app/src/routes/system.ts:47`) - so a client-side
precondition would mean fetching a new flag and maintaining a second copy of a
rule the server already enforces.

**The running indicator.** This is the point of the feature's feedback path, so
its states are specified rather than left to the builder:

1. **Pressed** - the menu item enters a running state and is disabled against a
   second press. The status region reads "Running AI extraction..." (or
   "...on 2 threads" when `scheduled` named more than one).
1a. **Already running** - `scheduled` is empty and `alreadyRunning` is not. This
   is a SUCCESS response, not a refusal: the region says a run is already in
   progress and the indicator does NOT start, because the events for those runs
   belong to whoever started them and may already have fired. Starting an
   indicator here would hang until the timeout. A mixed response (some
   scheduled, some already running) starts the indicator for the scheduled
   threads only and mentions the rest.
2. **Resolved** - one `ai_run.completed` per `conversationId` in `scheduled`.
   The region renders the aggregate outcome in the operator's terms, not the
   job's enum: applied ("Updated 2 fields, 1 suggestion"), no-op or skipped
   ("Ran - nothing new to extract"), failed ("Extraction failed - see Settings >
   AI runs"). A failure whose `errorKind` is **`truncated`** gets its own copy
   ("Extraction ran out of room - the transcript may be too long"), because it
   is the one failure an operator can act on and because it is the most likely
   failure on exactly this feature's target data: a manual run waives the age
   cutoff, so it sends the widest windows the system ever produces. `truncated`
   is a real `RunErrorKind` as of `09831370`
   (`app/src/repos/aiRunsRepo.ts:26`), added when a model swap made the
   truncation arm necessary - see 4.4a-i.
3. **Timed out** - if the events do not all arrive within a bounded wait, the
   region stops claiming to know and says so: "Still running - check Settings >
   AI runs". The indicator must never spin forever, because the event can be
   legitimately lost (see below).

Pending state is **session-local and does not survive a reload**. Recovering it
would mean querying the run log by contact since the press timestamp - the
`byEntity` index supports it (`app/src/repos/aiRunsRepo.ts:301-316`) - but for a
wait measured in seconds that is machinery bought for a rare case. A reloaded
page simply shows the current facts, which by then are usually the result.

**The event can be lost, and the timeout is the honest answer.** If
`EVENT_BRIDGE_URL` is unset the worker's emit never reaches app SSE, and if the
app-side run wins the claim the emit is in-process and arrives normally. So the
indicator resolves promptly on the expected path and degrades to the timeout
message otherwise. It never asserts an outcome it did not observe.

**What the operator will and will not see.** Suggestions and auto-applied writes
appear with no reload over the existing SSE path, proven end to end:
`apply.ts:658` emits `suggestion.updated`, the worker's event bridge crosses it
to the app, `api.ts:2098` writes it to the stream,
`EventStreamProvider.tsx:208` dispatches it, and
`dashboard/src/routes/contact/useSuggestions.ts:72-76` refetches when the event
names this contact. `e2e/tests/flows/event-bridge.spec.ts:193` asserts a chip
appearing with no reload and no tick.

But that emit fires **only when something changed**, which is why it cannot be
the indicator's resolution signal. A run ending `no_op`, `skipped`, or `failed`
produces no `suggestion.updated` at all. `ai_run.completed` (4.4b) fires on
every outcome and is what resolves the indicator; `suggestion.updated` remains
what refreshes the chips. Two events, two jobs - conflating them would leave the
indicator spinning on exactly the runs the operator most needs explained.

`suggestion.updated` from a WORKER-side run also depends on `EVENT_BRIDGE_URL`,
since the run executes in the worker while SSE clients are on the app. It is set
in all deployed environments and the local runners; unset, suggestions appear on
the next fetch instead -
degraded, not broken.

### 4.7 What does not change

- The backoff schedule and the `MAX_EXTRACTION_ATTEMPTS` park threshold. (The
  `claim` and `fail` WRITES do change - see 4.1 - but what they decide does not:
  same backoff curve, same park point, same per-row isolation.)
- `applyExtraction` and every guard in it, including dismissal tombstones and
  the `wrong_contact_type` drops.
- The run recorder's best-effort contract.
- The 30-day cutoff for `sms`, `email`, `voice`, and `triage` runs.
- `scheduleExtraction`'s signature and its channel union.
- The dev tick, which drains manual rows exactly as it drains any other.

### 4.8 Surfaces touched

- `app/src/repos/extractionRepo.ts` - `DueExtractionItem` (`manualRequested`,
  `channel` optional, and its now-stale channel doc comment), the
  `ExtractionRepo` interface, `requestManualExtraction`, `claim`, `fail`
  (signature gains BOTH the manual flag and `listedDueAt`; both branches gain
  the condition and the scheduling-free fallback).
- **Every full `ExtractionRepo` literal** must gain `requestManualExtraction`,
  and every `fail` caller and fake must match the new signature. Consumers
  taking a `Pick<ExtractionRepo, ...>` view are unaffected, which is most of
  them. Known literals and fakes: `app/test/helpers/twilioWebhookHarness.ts:2886`,
  `app/test/extractionJob.test.ts:164`, `app/test/extractionJobDraftGuard.test.ts:108`,
  `app/test/twilioSmsWebhook.test.ts:1135`.
  **`npm run typecheck` is the enumerator of record here** - the builder runs it
  before assuming this list is complete, because a missed literal is a compile
  error and a missed `Pick` view is not.
- `app/src/jobs/extraction.ts` - `manual` derivation, both gates, `newRunDraft`,
  the effective age value passed to the window builder.
- `app/src/services/extraction/runWindow.ts` and `runTypes.ts` - the nullable
  age param.
- `app/src/repos/aiRunsRepo.ts` - `RunTrigger`.
- `app/src/adapters/extraction.ts:218` - the client gains `timeout` and
  `maxRetries: 0` (4.4a-i), read from the new leaf constants module.
- A new leaf constants module holding `MAX_OUTPUT_TOKENS` and the values
  derived from it. It must import nothing: putting them in the adapter would
  turn `app/src/repos/extractionRepo.ts:38`'s `import type` into a runtime
  import of `@anthropic-ai/sdk`. **`MAX_OUTPUT_TOKENS` moves here from
  `app/src/adapters/extraction.ts:171`** so the timeout and staleness values
  can derive from it without the adapter becoming a runtime dependency of the
  repo. Its comment block - which records why 4096 is headroom rather than the
  fix - moves with it intact.
- `app/src/routes/contacts.ts` - the endpoint, including the post-response call.
- `app/src/lib/events.ts` - `AppEventMap` + `ALL_APP_EVENTS` (compile-enforced
  pair) and the payload type.
- `app/src/routes/api.ts` - the SSE writer for the new event, beside
  `suggestion.updated` at `:2098`.
- `dashboard/src/api/EventStreamProvider.tsx` - dispatch the new event beside
  `:208`.
- `dashboard/src/api/types.ts` - `AiRunTrigger`, `windowParams`, the new event
  payload.
- The app-side extraction deps must now be constructible in the APP process, not
  only the worker and the dev tick. `app/src/routes/dev.ts:603-641` already
  builds exactly these deps lazily, but **the builder cannot live there**: the
  dev router is structurally absent in deployed environments, so importing it
  from a production route would either break the build or drag dev-only code
  into production. Extract the builder to a normal module (alongside the job or
  under `services/extraction/`) and have BOTH `routes/dev.ts` and the new
  endpoint consume it, so a third copy cannot drift from the worker's.
- `dashboard/src/routes/contact/ContactActionsMenu.tsx` and its API client.
- `app/test/helpers/twilioWebhookHarness.ts:2886` - the extraction repo fake
  must implement the new method or the harness stops type-checking.

## 5. Concurrency and repeat presses

- **Two presses in quick succession** slide the single due row forward; one run
  happens. Existing debounce behavior, correct here.
- **A press while a run is in flight** is REFUSED for that thread by the
  in-flight guard (4.4a-i) and reported as `alreadyRunning`. This replaces the
  earlier design's "a second run follows"; with an indicator on screen, being
  told a run is already going is more useful than silently starting a rival one,
  and it is what keeps 4.4a from producing concurrent runs on one conversation.
  The flag lifecycle in 4.1 still matters for the paths the guard does not
  cover: an inbound re-arm during a run, and a failed run's retry.
- **An inbound message arriving during a run** re-arms the row while the run
  continues. The conditional `fail` (4.1) is what protects it: the re-armed
  `dueAt` survives, and `fail` records only the error and the attempt count.
  Without that condition the re-arm would be pushed out by the backoff, or - on
  the fifth failure - deleted with the row's index keys. This is now the
  scenario that motivates the conditional `fail`, since the guard makes a PRESS
  during a run impossible.
- **An inbound message between press and claim** slides `dueAt` and may
  overwrite `channel`, but cannot clear `manualRequested`, so the run stays
  manual. It can also slide `dueAt` into the future, in which case the app-side
  claim fails its `dueAt <= now` condition and the poll runs it later (4.4b).
- **Sustained inbound traffic** slides `dueAt` forward by a full debounce each
  time, so on an actively texting thread a manual run can be delayed well past
  "shortly". The run stays manual whenever it fires; the delay is the existing
  debounce and is not changed here. The UI copy promises queueing, not timing.

No rate limiting. It is a human-speed action, each press costs one model call
per eligible thread, and the sliding upsert already collapses bursts.

## 6. Cost

One manual run per eligible thread per press, bounded by the same newest-50 and
60k-char caps as any other run - a worst-case input of roughly 15k tokens per
the note at `app/src/jobs/extraction.ts:56-62`. Waiving the age cutoff does not
raise the ceiling; it changes which messages fill the same fixed budget.

## 7. Testing

Unit:

- The job waives the age cutoff when `manualRequested` is set: a conversation
  whose messages all predate the cutoff reaches the driver. The same fixture
  without the flag skips **`no_new_client`** (not `empty_window` - see 1.2).
- The job waives `no_new_client` when the flag is set and does not when absent.
- `windowParams.maxTranscriptAgeDays` is `null` on a manual run, `30` otherwise.
- `requestManualExtraction` sets the flag and leaves `channel` untouched;
  `scheduleExtraction` never sets the flag; `claim` removes it.
- **The two re-arm-survival regression tests, one per write path.** Drive these
  with an INBOUND re-arm, not a press: the guard (4.4a-i) makes a press during a
  claimed run impossible, so a press-driven version of this test would be
  asserting on an unreachable state. A re-arm landing during a claimed run
  survives that run's `complete`; and it survives that run's `fail` on BOTH
  branches - re-arm (its `dueAt` is not pushed to `now + backoff`) and park (its
  `dueAt` and `_duePartition` are not removed). Assert the error and attempt
  count are still recorded in the re-armed case.
- `fail` re-arms with the flag for a manual run and without it for an automatic
  one; `fail` parking REMOVEs the flag.
- `newRunDraft` records `manual` from the flag, and records a defined trigger
  for a row with no `channel` (the `?? 'manual'` arm).
- Route: fan-out covers phone and email threads and EXCLUDES `relay_group` and
  `landlord_1to1`; each of the FIVE refusals in 4.5 returns its status and
  reason, including `no_conversations` and `no_eligible_conversations` being
  distinguishable; a repo failure is a 500; the audit entry is appended.
- **All four quadrants of the disjunct in 4.1**, since three of them have each
  been wrong in some revision of this spec:
  1. Claim succeeded, nobody re-armed - backs off normally.
  2. Claim succeeded, a press re-armed - press survives, error recorded.
  3. Claim THREW, nobody re-armed (`dueAt` unchanged) - backs off and parks at
     the threshold. This is the unbounded-retry regression test.
  4. Claim THREW, a press re-armed (`dueAt` changed) - press survives, error
     recorded, and the row does NOT park underneath it.

In-process runner and event:

- `runExtractionForConversations` runs the SAME per-row path as the poll: assert
  a shared helper, not two parallel implementations.
- It processes only the named conversations and leaves other due rows alone.
- A conversation whose claim is LOST (the poll got there first) does nothing and
  records no run - the existing `record: false` path.
- `ai_run.completed` is emitted once per run, after `recordRun`, for applied,
  no_op, skipped AND failed outcomes - the skip and failure cases are the whole
  point of the indicator and are the easiest to forget.
- The emit still fires when `recordRun` fails (its failure is swallowed).
- A `no_contact` run emits with `conversationId` present and `contactId` absent.
- The payload carries ids and counts only. A guard test asserts no message body,
  phone number, or field value can reach it.

`claimedAt` narrowing and the in-flight guard (4.4a-i). Each case below is a
state that broke some earlier draft of this guard:

- **Both `fail` branches and the fallback clear `claimedAt`**, as `complete`
  does. Assert on all three; a missed branch silently re-creates the
  "refuses forever after a failure" trap.
- A thread whose row is claimed (run in flight) is reported `alreadyRunning` and
  is NOT re-scheduled - the `dueAt` is not slid and `manualRequested` is not
  re-set.
- **A claimed row that an INBOUND has re-armed is still reported
  `alreadyRunning`.** The regression test for the inverted predicate: an earlier
  draft read `_duePartition` as a proxy for "running" and admitted a second
  concurrent run here.
- A row left by an old FAILED run is scheduled normally.
- A PARKED row is scheduled normally - this is section 8's recovery path.
- A row that does not exist at all is created and scheduled - the imported
  conversation case, and the most common one in practice.
- A row whose `claimedAt` predates `MANUAL_CLAIM_STALE_MS` is scheduled,
  recovering a run stranded by a dead process.
- **The driver is constructed with an explicit `timeout` and `maxRetries: 0`**,
  and a guard test asserts `MANUAL_CLAIM_STALE_MS > EXTRACTION_REQUEST_TIMEOUT_MS`
  by the stated multiple. This is the test that keeps the constants from
  drifting apart later and silently re-opening the concurrent-run hole. It
  asserts against the exact bound, which only holds because retries are off -
  if `maxRetries` is ever raised, the test's premise is gone and it must be
  re-derived, not just re-tuned.
- A driver timeout produces `failure: 'driver'`, a `failed` run record, an
  incremented attempt, and an `ai_run.completed` - the existing path, asserted
  so disabling SDK retries cannot silently change failure handling.
- A press covering two threads, one running and one idle, schedules exactly one
  and reports the other as already running.
- The guard is enforced by the conditional write, not a pre-read: a test drives
  two concurrent `requestManualExtraction` calls against one claimed row and
  asserts exactly zero succeed.

Dashboard:

- The menu item enters its running state on press and is disabled against a
  second press.
- Each of the three resolutions renders: applied, nothing-new, failed.
- **The multi-thread case resolves only when every `conversationId` in
  `scheduled` has reported**, not on the first event, and does not wait on
  `alreadyRunning` entries.
- An `alreadyRunning`-only response renders "already running" and does not start
  an indicator that can never resolve.
- **The timeout renders the "still running" copy** and the indicator stops. A
  test drives this by never delivering an event.
- An event for a DIFFERENT contact does not resolve this contact's indicator.
- Each refusal reason from 4.5 renders its own copy in the status region.

E2E (`e2e/`, accessibility-first selectors):

- **Use the existing lean fixture.** `app/src/lib/seed/lean.ts:17-19` seeds the
  1:1 thread's messages at fixed `2026-06-01` timestamps, more than 30 days old
  against the current clock - the aged-history case exists without adding seed
  rows, which also protects lean's byte stability. (The neighbouring constants
  at `:26-29` belong to the group and relay threads, which the type filter in
  4.5 excludes; the test must target the `tenant_1to1` thread.)
- Press the action, drive `POST /__dev/extraction/tick`, and assert a
  `trigger: manual` row in Settings > AI runs whose outcome is not `skipped`.
- Assert a suggestion chip appears on the contact page without a reload.

## 8. Risks and consequences

- **Long imported histories are still truncated.** Newest-50 and 60k chars, no
  backward paging. A contact with hundreds of imported messages will have its
  oldest history read by no run. Pressing again does not reach further back - it
  re-reads the same page. This is a real limit of the feature, not a bug in it,
  and it is the strongest argument for treating a real backfill (section 9) as
  its own design rather than a loop over this button.
- **The age waiver removes the 30-day bound on whole-run demotion.** A single
  unknown-speaker utterance demotes EVERY write in a run to a suggestion
  (`app/src/services/extraction/apply.ts:222,331`). Older call transcripts now
  enter manual windows, so a manual run on a contact with an aged multi-speaker
  call yields suggestions where an automatic run would have written. Safe
  direction, but the operator should expect it.
- **A manual run writes to a real contact record.** It uses the same apply
  guards as every automatic run, so the blast radius is identical to what the
  system already does unprompted.
- **A manual run can park silently, and possibly on its first failure.**
  `attempts` lives on the row, not on the run, so a press inherits whatever
  counter the thread's earlier failures left behind: a press on a row already at
  four attempts parks on its first failure, not its fifth. The indicator does
  report that failure - `ai_run.completed` carries `outcome: failed` - so the
  operator learns the run failed. What they are NOT told is that the row is now
  PARKED and no automatic retry is coming; a second press is the only recovery,
  and it works. Surfacing parked-ness itself is out of scope.
  Resetting `attempts` on a manual press is NOT specified here: it
  would change automatic backoff semantics for a manual reason, and the honest
  fix is visibility, not a counter reset.

## 9. Out of scope

- **Any broader repair of the failure path.** Section 4.1 makes `fail`'s
  scheduling writes conditional, which incidentally fixes the pre-existing case
  of an inbound message being swallowed by a concurrent failing run. That is the
  boundary: the condition and its tests, nothing more. The backoff curve, the
  park threshold, the attempts accounting, and the parked-row recovery story are
  all untouched, and a parked row still needs something to re-schedule it.
- **Bulk backfill over the imported population.** Deferred by the human: run the
  action on a handful of imported conversations and judge the output before
  firing hundreds of real model calls. Section 8's truncation limit means a
  backfill needs its own windowing design, not a loop over this endpoint. File
  in `docs/issues/` when this lands.
- **Persisting the pending indicator across a page reload.** 4.6 keeps it
  session-local; the `byEntity` query that would recover it is real but is
  machinery for a wait measured in seconds.
- **A stale-claim reaper, or turning the claim into a real lease.** A process
  dying mid-run strands its row (4.4a); an inbound landing during a long run can
  still produce two concurrent runs (4.4a-i). Both are pre-existing, both need
  a lease to close properly, and the human has accepted them knowingly. The
  staleness clause in 4.4a-i gives the operator a manual way out of the first
  without building one. One consequence of accepting the second: `claimedAt` is
  a single slot, so when two runs do overlap, whichever finishes first clears it
  and un-guards the row while the other is still running. A press in that window
  starts a third run. This is a property of the accepted residual, not a new
  hazard - the guard cannot fix it without the lease.
- **Any broader change to the extraction driver.** 4.4a-i sets `timeout` and
  `maxRetries: 0` on the Anthropic client so the staleness constant is
  derivable. That is the boundary: two constructor options and the leaf module
  holding their constants. Retry classification, backoff shape, streaming, and
  model selection are untouched, and the job's own retry semantics are
  unchanged - they simply become the only retry layer.
- **Rendering `windowParams` in the run detail.** Nothing renders it today
  (4.3); making the stored record truthful does not require building a viewer.
- **Backward pagination of the transcript window.**
- **Ignoring dismissal tombstones on a manual run.** Locked decision 6.
- **A configurable window horizon.** Rejected in brainstorming: the only value
  anyone would set is "all of it", which is what a manual run now does.
- **Making the importer schedule extraction at import time.** A larger change to
  the import path with its own cost profile.
