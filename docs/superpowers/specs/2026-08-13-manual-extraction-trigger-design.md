# Manual Extraction Trigger - Design and Scope

- Date: 2026-08-13
- Status: Ready for human review (9 adversarial review rounds; rebased onto main
  after the sonnet-5 extraction fixes of 2026-08-15; the in-process runner was
  withdrawn at round 9 - see 4.4a)
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
4. **The endpoint schedules and returns; the existing worker poll does the
   work.** No model call happens in the app process at all. An in-process
   immediate run was specified and then withdrawn - see 4.4a for what it cost
   and why the wait is the accepted price.
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
- `claim` also REMOVEs `requestId` alongside the flag, so a press's correlation
  key belongs to exactly one run (4.4b).
- `complete` does not touch `manualRequested` - `claim` already cleared it.

`claimedAt` is deliberately NOT touched. An earlier revision had `fail` clear it
to support an in-flight guard; that guard is withdrawn (4.4a), nothing reads
`claimedAt` for logic, and narrowing its meaning with no consumer would be
change for its own sake.

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

### 4.4a Arming the poll, and why there is no second runner

The endpoint schedules and returns. The worker's existing poll does the work.

**An earlier revision ran the extraction in the app process straight after
responding**, to cut the operator's wait from the poll interval to just the
model call. It was withdrawn. The atomic claim is a debounce collapse, not a
mutex: it stops two runners taking the SAME scheduled instance, and says nothing
about two instances overlapping in time. A second press re-armed the row and the
second endpoint call claimed it while the first run was still in its model call,
producing two billed runs over one window, two `complete()` writes racing with
independently computed cursors (so the cursor could move BACKWARDS), and a
`fail()` from one run re-arming a row the other was still executing.

Guarding that took an in-flight predicate, a narrowed `claimedAt`, a staleness
escape, and a driver timeout derived from the SDK's duration model - and four
consecutive review rounds each found a defect in the previous round's fix. The
guard is gone with the runner it existed to protect, and with it: the staleness
constant, the timeout derivation, the `claimedAt` narrowing, and the
consistent-read requirement on the runner's own write. That is five of round
nine's fourteen findings closed by deletion rather than by another fix.

What it costs is wall-clock. See 4.6 for the honest numbers.

Two hazards the withdrawn design would have made worse are real but
pre-existing, and are filed rather than fixed here (section 9): the driver's
model call is unbounded (no `timeout`, no `maxRetries` -
`app/src/adapters/extraction.ts:218`), and `claim` stamps `claimedAt` from the
poll-wide `nowIso` rather than the moment of claiming, so a later row in a long
poll records a claim time already minutes stale.

### 4.4b `ai_run.completed` - the event that resolves the indicator

`AppEventMap` gains a **ninth** event (`app/src/lib/events.ts:271-280`, which
already carries eight). `ALL_APP_EVENTS` is exhaustive by construction, so
registering the name is a compile error until it is done - which is what
guarantees the event crosses the worker-to-app bridge rather than silently
missing it.

**That compile-time guarantee does not cover everything.**
`app/test/eventBridge.test.ts:43` asserts `expect(APP_EVENT_NAMES).toHaveLength(8)`
- a runtime assertion the typecheck cannot see. Adding the event fails that test,
and the fix is to update the count, not to route around it.

Payload: `{ conversationId, requestId?, runId, outcome, skipReason?, errorKind?,
wrote, suggested, notedLines, contactId? }` - ids and counts only, never field
values or message content, matching the PII rule the job already follows.

**`conversationId` alone cannot correlate a press to its run.** It identifies
the thread, not the run: an unrelated automatic run on the same conversation -
an inbound text arriving right after the press - emits the same
`conversationId` and would resolve the operator's indicator with a different
run's outcome, possibly before their own run has started. So the press carries
an identity of its own:

- The endpoint generates a `requestId` (a uuid) per press and passes it to
  `requestManualExtraction`, which stores it on the due row beside
  `manualRequested`.
- `claim` REMOVEs it with the flag, so it belongs to exactly one run.
- `newRunDraft` reads it from the `listDue` row into the draft, and the emit
  carries it.
- The indicator matches on `requestId` and ignores events without it.

`contactId` is deliberately NOT the key: it is optional on the draft and is
never set on a `no_contact` run (`app/src/jobs/extraction.ts:392-397` returns
before the assignment at `:400`), so an indicator keyed on it would hang on
exactly the runs that resolve fastest. It rides along when known.

**The counts must be put somewhere they exist.** `wrote` and `suggested` live on
`applyOutcome` inside `processRow` and never reach `RunDraft`; `notedLines` does.
The builder adds the two counts to the draft where `notedLines` is already set
(`app/src/jobs/extraction.ts:531-532`) rather than re-deriving them from
`draft.decisions`, which is assembled best-effort and can legitimately be
absent - a degraded observability record must not become a wrong count in a
live event.

**The emit path is a surface, not a detail.** The job has no event bus today:
`ExtractionJobDeps` carries repos, a driver, `applyDeps`, config, a logger and a
clock, and nothing else. It gains a typed emitter, and **all three construction
sites must supply it** - `app/src/worker.ts` (the poll), `app/src/routes/dev.ts`
(the deterministic tick), and the unit-test harness - by the same reasoning the
existing `aiRuns` dep is REQUIRED rather than optional: a missed site should be
a typecheck failure, not a silently dead indicator in the one environment where
this feature is first exercised. The app-side SSE writer is a manual
`events.on` / `events.off` pair (`app/src/routes/api.ts:2098-2141`), so the new
event needs its own registration and its own cleanup; forgetting the `off` leaks
a listener per SSE connection.

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

**The event can be legitimately late or absent**, which is what 4.6's timeout is
for. An inbound message sliding `dueAt` into the future defers the run by a
debounce plus a poll interval; `EVENT_BRIDGE_URL` being unset drops the
worker-to-app hop entirely. The indicator must never claim an outcome it did not
observe.

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
4. Generate a `requestId` (uuid) for this press - the correlation key of 4.4b.
5. `requestManualExtraction(conversationId, nowIso, requestId)` for each
   surviving thread, with no debounce - `dueAt = now`, as the voice and triage
   paths do.
6. `audit.append('contacts#<contactId>', 'extraction_run_requested', { actor,
   requestId, scheduled: scheduled.length, failed: failed.length })`. The counts
   matter: an unconditional entry with no counts cannot distinguish a press that
   started three runs from one that started none, which is most of the audit
   value for an action that spends money.
7. Respond `200 { requestId, scheduled: string[], failed: string[] }` as
   `conversationId` arrays. The client waits for one completion event per entry
   in `scheduled`.

**A partial failure must not be reported as a total one.** The fan-out is N
independent writes; if the second throws after the first succeeded, a run is
queued and will bill. Returning 500 there tells the operator nothing happened,
which is false, and leaves an indicator they cannot see resolve. So the endpoint
**returns 500 only when NOTHING was scheduled**. Once any write succeeds the
response is a 200 naming both lists, and 4.6 says plainly that some threads
could not be queued. A thread in `failed` gets no indicator, because no run is
coming for it.

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
| Contact is soft-deleted | 409 | `contact_deleted` |
| `config.aiExtractionEnabled` is false | 409 | `extraction_disabled` |
| Contact type is `landlord`, `partner`, or `team_member` | 409 | `ineligible_contact_type` |
| Contact has no threads at all | 409 | `no_conversations` |
| Threads exist but none survive the type filter | 409 | `no_eligible_conversations` |
| Every scheduling write failed | 500 | `schedule_failed` |

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

**The soft-delete refusal is a deliberate divergence from the job**, which has
no soft-delete check and would happily extract into a deleted contact's record.
Spending money to write facts onto a record staff have removed from view is not
something to do on a human's button press, and the parity gap is not this
spec's to close - a soft-deleted contact still being extractable on the
automatic path is filed as its own issue (section 9).

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
   "...on 2 threads" when `scheduled` named more than one). If `failed` is
   non-empty it says so alongside: some threads could not be queued.
2. **Resolved** - one `ai_run.completed` carrying this press's `requestId` per
   `conversationId` in `scheduled`. The region renders the aggregate outcome in
   the operator's terms, not the job's enum: applied ("Updated 2 fields, 1
   suggestion"), no-op or skipped ("Ran - nothing new to extract"), failed
   ("Extraction failed - see Settings > AI runs"). A failure whose `errorKind`
   is **`truncated`** gets its own copy ("Extraction ran out of room - the
   transcript may be too long"), because it is the one failure an operator can
   act on and because it is the most likely failure on exactly this feature's
   target data: a manual run waives the age cutoff, so it sends the widest
   windows the system ever produces. `truncated` is a real `RunErrorKind` as of
   `09831370` (`app/src/repos/aiRunsRepo.ts:26`), added when a model swap made
   the truncation arm necessary.
3. **Timed out** - if the events do not all arrive within a bounded wait, the
   region stops claiming to know and says so: "Still running - check Settings >
   AI runs". The indicator must never spin forever, because the event can be
   legitimately late or lost (see below).

**How long the operator actually waits.** The run happens on the worker poll, so
the wait is `poll interval` (0-30s, averaging 15s since `WORKER_POLL_INTERVAL_MS`
became 30000 on 2026-08-16) plus the run itself (a `max_tokens: 4096`
structured-output call, seconds). Call it **5-40 seconds, averaging around 20**.
The timeout that ends the indicator sits well above that ceiling, not at it -
the poll can be delayed by a long-running row ahead of this one in the same
pass. This is the cost of withdrawing the in-process runner (4.4a), and it is
the accepted price.

Pending state is **session-local and does not survive a reload**. Recovering it
would mean querying the run log by contact since the press timestamp - the
`byEntity` index supports it (`app/src/repos/aiRunsRepo.ts:301-316`) - but for a
wait measured in tens of seconds that is machinery bought for a rare case. A
reloaded page simply shows the current facts, which by then are usually the
result.

**The event can be late or lost, and the timeout is the honest answer.** An
inbound message sliding `dueAt` forward defers the run past the debounce; an
unset `EVENT_BRIDGE_URL` drops the worker-to-app hop entirely. The indicator
degrades to the timeout message rather than asserting an outcome it did not
observe.

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
  `requestId`, `channel` optional, and its now-stale channel doc comment), the
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
- `app/src/jobs/extraction.ts` - `manual` derivation, both gates, `newRunDraft`
  (trigger + `requestId` + the two counts), the effective age value passed to
  the window builder, and a REQUIRED event emitter on `ExtractionJobDeps`.
- **All three `ExtractionJobDeps` construction sites** must supply the emitter:
  `app/src/worker.ts` (the poll), `app/src/routes/dev.ts` (the deterministic
  tick), and the unit-test harness. Required rather than optional for the same
  reason the existing `aiRuns` dep is: a missed site should be a typecheck
  failure, not a dead indicator in the one environment where this is first
  exercised.
- `app/src/services/extraction/runWindow.ts` and `runTypes.ts` - the nullable
  age param.
- `app/src/repos/aiRunsRepo.ts` - `RunTrigger`.
- `app/src/lib/events.ts` - `AppEventMap` + `ALL_APP_EVENTS` (compile-enforced
  pair) and the payload type.
- `app/test/eventBridge.test.ts:43` - the hardcoded `toHaveLength(8)` becomes 9.
  A runtime assertion the typecheck cannot catch (4.4b).
- `app/src/routes/api.ts:2098-2141` - the SSE writer is a manual `on`/`off`
  pair; the new event needs both halves or it leaks a listener per connection.
- `dashboard/src/api/EventStreamProvider.tsx:208` - dispatch the new event.
- `dashboard/src/api/types.ts` - `AiRunTrigger`, `windowParams`, the new event
  payload.
- `app/src/routes/contacts.ts` - the endpoint.
- `dashboard/src/routes/contact/ContactActionsMenu.tsx`, `ContactDetail.tsx`,
  and the API client.

## 5. Concurrency and repeat presses

- **Two presses in quick succession** slide the single due row forward; one run
  happens. Existing debounce behavior, correct here.
- **A press while a run is in flight** re-arms the row, and a second run follows
  once the first completes. This is the original design and it is correct: the
  operator asked again. It is only safe because there is no second runner - the
  poll claims one instance at a time, so "a second run follows" means after, not
  alongside. See 4.4a for the design that made this unsafe and was withdrawn.
- **An inbound message arriving during a run** re-arms the row while the run
  continues. The conditional `fail` (4.1) is what protects it: the re-armed
  `dueAt` survives, and `fail` records only the error and the attempt count.
  Without that condition the re-arm would be pushed out by the backoff, or - on
  the fifth failure - deleted with the row's index keys. This applies equally to
  a press landing in that window.
- **An inbound message between press and claim** slides `dueAt` and may
  overwrite `channel`, but cannot clear `manualRequested` or `requestId`, so the
  run stays manual and stays correlated to the press. It can also slide `dueAt`
  into the future, deferring the run past the debounce - which the indicator's
  timeout covers (4.6).
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
- `requestManualExtraction` sets the flag and the `requestId`, and leaves
  `channel` untouched; `scheduleExtraction` never sets either; `claim` removes
  both.
- **The two re-arm-survival regression tests, one per write path.** A re-arm
  landing during a claimed run survives that run's `complete`; and it survives
  that run's `fail` on BOTH branches - re-arm (its `dueAt` is not pushed to
  `now + backoff`) and park (its `dueAt` and `_duePartition` are not removed).
  Assert the error and attempt count are still recorded in the re-armed case.
  Drive it once with an inbound re-arm and once with a press: both reach this
  state now that the in-flight guard is withdrawn.
- `fail` re-arms with the flag for a manual run and without it for an automatic
  one; `fail` parking REMOVEs the flag.
- `newRunDraft` records `manual` from the flag, records a defined trigger for a
  row with no `channel` (the `?? 'manual'` arm), and carries the `requestId`
  through to the emit.
- Route: fan-out covers phone and email threads and EXCLUDES `relay_group` and
  `landlord_1to1`; each refusal in 4.5 returns its status and reason, including
  `no_conversations` and `no_eligible_conversations` being distinguishable, and
  the soft-delete refusal; the audit entry is appended with its counts.
- **Partial failure is a 200, not a 500.** With two threads where the second
  write throws: the response is 200, `scheduled` names the first, `failed` names
  the second, and the queued run is not orphaned by an error response. A 500
  happens only when nothing was scheduled.
- **All four quadrants of the disjunct in 4.1**, since three of them have each
  been wrong in some revision of this spec:
  1. Claim succeeded, nobody re-armed - backs off normally.
  2. Claim succeeded, a press re-armed - press survives, error recorded.
  3. Claim THREW, nobody re-armed (`dueAt` unchanged) - backs off and parks at
     the threshold. This is the unbounded-retry regression test.
  4. Claim THREW, a press re-armed (`dueAt` changed) - press survives, error
     recorded, and the row does NOT park underneath it.

The event:

- `ai_run.completed` is emitted once per run, after `recordRun`, for applied,
  no_op, skipped AND failed outcomes - the skip and failure cases are the whole
  point of the indicator and are the easiest to forget.
- The emit still fires when `recordRun` fails (its failure is swallowed).
- A `no_contact` run emits with `conversationId` present and `contactId` absent.
- **The `requestId` round-trips**: a run started by a press carries that press's
  id; an automatic run on the same conversation carries none. This is the test
  that proves an unrelated inbound run cannot resolve an operator's indicator.
- The payload carries ids and counts only. A guard test asserts no message body,
  phone number, or field value can reach it.
- `APP_EVENT_NAMES` has 9 entries and the bridge forwards the new name -
  `app/test/eventBridge.test.ts:43` updated rather than routed around.

Dashboard:

- The menu item enters its running state on press and is disabled against a
  second press.
- Each of the three resolutions renders: applied, nothing-new, failed; plus the
  `truncated` copy.
- **The multi-thread case resolves only when every `conversationId` in
  `scheduled` has reported**, not on the first event.
- **An event carrying a different `requestId` does not resolve the indicator**,
  nor does one for a different contact.
- **The timeout renders the "still running" copy** and the indicator stops. A
  test drives this by never delivering an event.
- A response with a non-empty `failed` says so.
- Each refusal reason from 4.5 renders its own copy in the status region.

E2E (`e2e/`, accessibility-first selectors):

**The fixture this needs does not exist, and the spec previously claimed it
did.** Two independent round-9 reviewers found it, and it partly vindicates a
round-1 finding this spec REJECTED - see the concession in the adjudications
file. Both halves are broken:

1. **The lean transcript cannot produce a suggestion.** The hermetic lane runs
   the fake driver, whose protocol is an `EXTRACT:` marker in a message body
   (`app/src/adapters/extractionFake.ts`). The lean 1:1 messages carry no
   marker, so the driver returns an empty result and the asserted chip never
   appears.
2. **The lean messages are not "aged" in the field the cutoff reads.** Lean
   message rows carry `ts` and `tsMsgId` (`app/src/lib/seed/lean.ts:274-300`),
   not `created_at` - and `created_at` is what
   `app/src/jobs/extraction.ts:433-436` filters on. The fixed `2026-06-01`
   timestamps are therefore not exercising the age cutoff at all.

The e2e uses a **dev seam** rather than new lean seed rows, mirroring the
existing `POST /__dev/voice/transcript-fixture` (`app/src/routes/dev.ts:759`),
which is hermetic-only and structurally absent in deployed environments: a
seam that plants a message on a named conversation with a caller-supplied
`created_at` and body. That gives the test an explicitly aged message carrying
an `EXTRACT:` marker, without touching lean's byte stability.

- Plant an aged, marker-carrying message on the lean `tenant_1to1` thread.
- Press the action, drive `POST /__dev/extraction/tick`, and assert a
  `trigger: manual` row in Settings > AI runs whose outcome is not `skipped`.
- Assert the suggestion chip appears on the contact page without a reload.
- **Assert the negative**: the same conversation WITHOUT the manual flag skips,
  proving the aged message is genuinely outside the automatic window rather
  than the test passing for an unrelated reason.

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
- **Four latent hazards found while specifying the withdrawn in-process runner.**
  All are pre-existing, none is created by this feature, and each is filed in
  `docs/issues/` rather than fixed here:
  1. **The driver's model call is unbounded.** The Anthropic client is
     constructed with no `timeout` and no `maxRetries`
     (`app/src/adapters/extraction.ts:218`), so it inherits a 10-minute timeout
     with 2 retries and retries its own timeouts - roughly 30 minutes of wall
     clock, during which the row stays claimed. Bounding it mattered when a
     staleness window had to be derived from it; with the guard withdrawn,
     nothing here depends on the bound.
  2. **`claim` stamps `claimedAt` from the poll-wide `nowIso`**, not the moment
     of claiming (`app/src/repos/extractionRepo.ts:270`), so a later row in a
     long poll records a claim time already minutes stale. Harmless today
     because nothing reads `claimedAt` for logic - which is exactly why it
     would bite whoever first does.
  3. **A process dying mid-run strands its row**: claimed, out of the due index,
     with nothing to re-arm it and no reaper.
  4. **A soft-deleted contact is still extractable on the automatic path.** This
     spec refuses it at the button (4.5) but does not change the job.
- **Bulk backfill over the imported population.** Deferred by the human: run the
  action on a handful of imported conversations and judge the output before
  firing hundreds of real model calls. Section 8's truncation limit means a
  backfill needs its own windowing design, not a loop over this endpoint. File
  in `docs/issues/` when this lands.
- **Persisting the pending indicator across a page reload.** 4.6 keeps it
  session-local; the `byEntity` query that would recover it is real but is
  machinery for a wait measured in tens of seconds.
- **Rendering `windowParams` in the run detail.** Nothing renders it today
  (4.3); making the stored record truthful does not require building a viewer.
- **Backward pagination of the transcript window.**
- **Ignoring dismissal tombstones on a manual run.** Locked decision 6.
- **A configurable window horizon.** Rejected in brainstorming: the only value
  anyone would set is "all of it", which is what a manual run now does.
- **Making the importer schedule extraction at import time.** A larger change to
  the import path with its own cost profile.
