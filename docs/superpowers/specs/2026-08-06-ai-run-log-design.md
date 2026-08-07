# AI Run Log - Design

Date: 2026-08-06
Status: APPROVED by Cameron 2026-08-06 (after adversarial review rounds 1-4)
Phase: 2 (automations), observability slice

Revision note: four rounds of adversarial review. 59 findings accepted, 3
rejected, 14 structural. Findings by round 23 / 16 / 13 / 7; BLOCKING by
round 3 / 2 / 0 / 0. R1 used two blind reviewers; R2-R4 continued one of them
under the re-review charge. Two rounds caught defects the PREVIOUS round's
revision had introduced, and reviewers overturned two of my adjudications on
contest - both reversals improved the design. Round 4 returned NOT CONVERGED
and was escalated to Cameron per the four-round cap; his ruling was to fold
the remaining seven in and proceed. Full adjudications, with every rejection
and its reasoning, are at `.superpowers/design-review/adjudications.md` in
the feature worktree.

## 1. Overview

The conversation-fact-extraction pipeline calls a model, mutates contact
data, and leaves almost no record of having done so. This design adds a
durable, queryable record of every extraction run: what the model was shown,
what it said, what we did with each finding, and what a human later decided
about it.

The record lives in a new `ai_runs` DynamoDB table and is read through an
admin-only two-pane run log at `/settings/ai-runs`.

Two audiences, one artifact:

- QA: browse recent runs, see how the system behaves, find the cases where
  it should have found something and did not.
- Audit: given a value on a contact, trace it back to the exact run, the
  exact messages that produced it, and the human verdict that followed.

## 2. The gap today

The pipeline is [app/src/jobs/extraction.ts](../../../app/src/jobs/extraction.ts)
-> [app/src/adapters/extraction.ts](../../../app/src/adapters/extraction.ts)
-> [app/src/services/extraction/apply.ts](../../../app/src/services/extraction/apply.ts).

What is persisted now:

- the `due#<conversationId>` row keeps `cursor`, `lastRanAt`, `lastError`;
- applied writes append an `ai_extraction_applied` audit event to the contact;
- inferred-role demotions append `ai_extraction_demoted`;
- pending suggestions carry `conversationId` and `tsMsgId`.

What is not persisted anywhere:

- the input window - which messages the model actually saw, and what was
  truncated or pushed out;
- the model's response text. It is consumed by `parseExtractionText` at
  `adapters/extraction.ts:170` and never leaves the driver;
- the model id, token usage, and driver identity. Usage is logged at
  `adapters/extraction.ts:152-160` and dropped;
- every finding the model made that the apply layer discarded. These end in
  `logger.debug` and are gone;
- runs that produced nothing, so "why did it not catch that" is unanswerable;
- any link from a suggestion back to the run that produced it.

## 3. Goals

- Answer "exactly which messages did the AI read for this run" without
  storing a second copy of message text.
- Answer "what did it propose, from what previous value, and what did we do
  with it" from the run record alone, without opening raw output.
- Record negative findings at field granularity, and distinguish a model that
  explicitly declined a field from a field the model never addressed.
- Record runs that were skipped or failed, with the reason, and with the same
  window and decision detail as a successful run wherever it exists.
- Close the loop: show what a human did with each suggestion, across every
  resolution path.
- Never affect extraction behavior. The recorder is best-effort (section 8).

## 4. Non-goals

- Voice transcription (Twilio Voice Intelligence). Its output is already
  stored on the message row and rendered in the UI. Out of scope.
- Aggregate statistics panels. The data model supports adding them later.
- Full instrumentation of every contact edit to attribute later hand
  corrections of auto-applied fields. Section 7.3 describes a bounded
  approximation and section 13 states its limits.
- Replaying a stored run. The record supports drift detection, not
  byte-identical replay (section 6.1).
- Versioning the truncation algorithm itself. Rejected as scope creep. The
  byte-affecting CONSTANTS are recorded instead (`windowParams`, 6.1); a pure
  algorithm change then surfaces as an unexplained hash mismatch, which is the
  honest signal. A hand-bumped builder version was considered and rejected -
  it reintroduces the same drift failure mode as a hand-bumped prompt version.

## 5. Storage

### 5.1 Why a new table

Adding `run#` rows to `ai_extraction` still requires a new GSI, and forces
table-wide TTL onto a table holding permanent dismissal tombstones and
extraction cursors. Those survive only by lacking `expires_at`; one careless
write resurrects a dismissed suggestion or rewinds a cursor into
re-extracting months of history.

Using `audit_events` needs no infra, but it is keyed `entityKey` + `ts`, so
"newest runs across all contacts" is only answerable by a full Scan, and it
has no TTL.

### 5.2 Table `ai_runs`

Single hash key `itemId`, two disjoint row kinds by prefix:

```
run#<runId>                            the full record
ptr#<entityKey>#<startedAt>#<runId>    an adjacency-list pointer
```

One GSI, `byEntity`: hash `entityKey` (S), range `sortKey` (S), formatted
`<startedAt ISO>#<runId>`. Sparse - only `ptr#` rows carry `entityKey`.

Projection is ALL. It is not a choice: `dynamoAdmin.ts:48` and
`infra/modules/dynamodb/main.tf:57` both hardcode `ProjectionType: 'ALL'`,
and `GsiSpec` has no projection field. Pointer rows are tiny, so ALL costs
nothing. Each pointer row carries an explicit `runId` attribute, which ALL
projection then makes readable straight off the index.

`ttlAttribute: 'expires_at'` (epoch seconds), registered in
[app/src/lib/tables.ts](../../../app/src/lib/tables.ts) alongside the
existing TTL tables.

### 5.3 Pointers

Each run writes one pointer per dimension it should be filterable by. The
entityKey is either a LITERAL SCOPE TOKEN or the `<table>#<id>` convention
used by `audit_events` - both forms coexist in this index by design:

| entityKey                | written                       |
| ------------------------ | ----------------------------- |
| `global`                 | always (literal token)        |
| `outcome#<outcome>`      | always (literal token)        |
| `conversations#<convId>` | always                        |
| `contacts#<contactId>`   | when a contact resolved       |
| `units#<unitId>` etc.    | future runs, no schema change |

Reading: Query `byEntity` on the chosen `entityKey`, descending by
`sortKey`, page size 25, then one `BatchGetItem` for those 25 `run#` rows.
Date ranges are a `BETWEEN` on `sortKey`. No Scan, ever.

Two mechanics the reader must honor:

- `BatchGetItem` returns items UNORDERED. The reader re-sorts by the pointer
  `sortKey` it already holds; it never trusts response order.
- `BatchGetItem` can return `UnprocessedKeys` under throttling. The reader
  retries them with backoff before rendering a partial page.

Pointers stay pure pointers - no denormalized run summary. A copied summary
would need updating whenever a verdict lands, and a drifting second copy is
the class of bug this feature exists to catch.

`expires_at` is set to the same value on both row kinds. This does NOT
guarantee simultaneous deletion - DynamoDB TTL is asynchronous and may lag by
up to 48 hours, unordered. So the reader tolerates a pointer whose `run#` row
is already gone: it renders that entry as expired rather than erroring.

Note on the `global` partition: all runs share one GSI partition key value,
and split-for-heat cannot subdivide a single key value, so it is capped near
3,000 RCU/s and 1,000 WCU/s. At low hundreds of runs per month that is about
six orders of magnitude of headroom. A footnote, not a constraint.

## 6. The run record

```
run#<runId>
  runId, startedAt, finishedAt, durationMs
            AMENDED post-approval: these are REAL wall-clock times taken from
            an injected `now()` on the recorder's deps - NOT the poll's
            `nowIso`. The dev tick calls the job with a SIMULATED future clock
            (`routes/dev.ts:373` advances by the debounce window), so using
            the poll clock would stamp dev and e2e runs about one debounce
            into the future and mis-sort the log against real time. Domain
            logic (cursor comparisons, due checks) keeps using `nowIso`
            unchanged; only the record's timestamps are wall clock. Injected
            so tests can pin it.
  conversationId, contactId?
  trigger:  sms | voice | triage | email        (the due row's channel)
  outcome:  applied | no_op | skipped | failed
            applied = at least one decision reached outcome `wrote` or
              `suggested`, OR notedLines > 0.
            no_op   = the model was called and NOTHING was written,
              suggested, or noted - including the case where every finding
              was dropped. A run full of drops is a no_op, not an applied.
            This boundary is a pointer partition and the primary QA scope
            selector, so it is defined here rather than left to the builder.
  skipReason?:  see 6.3
  error?:   { kind: refusal | parse | driver | complete | repo,
              message, attempts, parked }        (full definitions in 6.3)

  driver:   anthropic | console | fake
  model?:   the model id actually called
  promptFingerprint?: sha256 of the assembled system prompt CONCATENATED with
            the serialized EXTRACTION_SCHEMA, first 12 hex. Both are sent on
            the same call and both define the model contract; fingerprinting
            the prompt alone would miss half of it.
  usage?:   { inputTokens, outputTokens }

  window:   see 6.1
  profileFieldsPopulated: [ field name ]        see 6.2

  rawText?:     the model's response text, verbatim, pre-parse
  rawResult?:   the parsed ExtractionResult
  decisions:    map, target -> decision (section 7)
  notedLines:   count of note lines appended
  expires_at
```

### 6.1 Window fidelity

```
window:
  cursor, newestTsMsgId, hasInferredRoleContent, totalChars
  windowCappedAtLimit: boolean
  windowParams: { newMessageCharCap, seenMessageCharCap, windowCharBudget,
                  maxTranscriptMessages, maxTranscriptAgeDays,
                  truncationMarker }
  messages: [ { tsMsgId, type, direction, tier, capChars,
                truncated, chars, hash } ]
  excluded: [ { tsMsgId, cause } ]
  noContent: [ tsMsgId ]
```

The window stores message ids, not message text; text is rehydrated at view
time. Supporting fields:

`capChars` - the exact per-message cap this run applied, not just the
`new`/`seen` tier label, so a later tuning of `NEW_MESSAGE_CHAR_CAP` or
`SEEN_MESSAGE_CHAR_CAP` does not silently misrepresent historical runs.

`hash` - sha256, first 16 hex, of the EXACT rendered text this message
contributes to the user content. It is NOT a `\n`-join of the raw utterance
texts: the real renderer applies single-line normalization and speaker
prefixes, so a naive join would hash bytes that were never sent and produce a
permanent false mismatch on every run.

Two changes are required to make this implementable, and the spec is only
honest if it names them. Today `TranscriptUtterance`
(`adapters/extraction.ts:21-32`) carries no message id, and `toSingleLine`
(`prompt.ts:89`) is module-private, so `buildExtractionUserContent` cannot
attribute rendered output back to a message:

1. `TranscriptUtterance` gains `tsMsgId`. It is an internal type produced by
   `toUtterances` and consumed by the prompt builder; the id is already in
   hand at the only construction site.
2. `prompt.ts` exports `renderUtteranceLine(u)`, the single function that
   turns one utterance into its rendered line, and
   `buildExtractionUserContent` is refactored to call it. The recorder hashes
   the join of that function's output for the message's utterances.

Both the request and the hash then come from one function. Any other
arrangement reconstructs the rendering and reintroduces exactly the drift
this field exists to detect.

The join is exact and non-negotiable, because this single detail decides
whether every stored hash matches or every one fails: the message's
utterances are joined by a single `\n`, in the order `toUtterances` produced
them (chronological, and for a call transcript, line order), with no trailing
newline. `tsMsgId` is REQUIRED on `TranscriptUtterance`, not optional - an
optional id would let a construction site omit it and silently produce
unhashable messages.

Test fallout for that field addition is larger than either breaking change in
6.4 and must be planned for, not discovered: roughly twenty `toEqual`
assertions across the extraction tests construct or compare whole
`TranscriptUtterance` objects and will all need the new field.

This is DRIFT DETECTION, not a replay guarantee. A change to utterance
derivation (`toUtterances`), to the capping algorithm (`capUtterances`,
`clampHeadTail`), or to the renderer changes the bytes for the same stored
message, so a hash mismatch means "something changed", not necessarily "the
message changed". `windowParams` records the byte-affecting CONSTANTS, so a
reader can tell a constant change from an algorithm change: if the params
match and the hash does not, the code changed. A hand-bumped builder version
was rejected - it is the same drift failure mode this spec already rejected
for prompt versioning, over a larger surface.

`excluded` carries a CAUSE per message, because the causes are not
equivalent:

- `age_30d` - older than `MAX_TRANSCRIPT_AGE_DAYS` (`extraction.ts:296`).
- `char_budget` - pushed out by `WINDOW_CHAR_BUDGET` (`extraction.ts:349-356`).

Messages beyond `MAX_TRANSCRIPT_MESSAGES` are never fetched
(`listByConversation` is called with `limit`), so they cannot be enumerated
without a second read, which this design declines to pay for. Instead
`windowCappedAtLimit` is true when the fetch returned exactly
`MAX_TRANSCRIPT_MESSAGES` rows, which tells a reviewer that older messages
may exist unseen. Recording an honest boolean beats implying the excluded
list is exhaustive.

`noContent` - messages that produced ZERO utterances and therefore carried
nothing to the model. In practice this is a call whose transcript is not
`completed` (`toUtterances`, `extraction.ts:130-131`). Such a message still
enters the included set today at `extraction.ts:349-356` with size 0;
recording it as READ would be a false claim that the model saw a call it
never saw.

`chars` is the message's total utterance length after capping.

### 6.2 What is deliberately not stored

No wholesale profile snapshot. The model reconciles against a full contact
profile (`toProfile`, `extraction.ts:80`) including name, address, and notes.
Instead the run stores `profileFieldsPopulated` - the list of populated field
NAMES - which answers "it already had a last name and proposed one anyway"
without duplicating the record.

This is not a claim that the run record is PII-free, and the spec should not
pretend otherwise. `rawText`, `rawResult`, and the `previousValue` /
`proposedValue` on each decision all contain contact PII by design. That is
the point of the feature: those are the values under audit. Dropping
`previousValue` to reduce duplication was considered and rejected - it is the
single field that makes "what did it change this from" answerable. What is
declined is the wholesale snapshot, not decision-scoped values.

All of it is stored in DynamoDB, never logged, behind the admin route, and
TTL'd at 90 days.

### 6.3 Field optionality by outcome

The rule is uniform: **every field the run actually computed is recorded, on
every terminal path.** There is no outcome that discards work already done.

| outcome   | window        | decisions | rawText/rawResult | usage | error |
| --------- | ------------- | --------- | ----------------- | ----- | ----- |
| `applied` | yes           | yes       | yes (anthropic)   | yes   | no    |
| `no_op`   | yes           | yes       | yes (anthropic)   | yes   | no    |
| `skipped` | when computed | no        | no                | no    | no    |
| `failed`  | when computed | when computed | if the call returned | if returned | yes |

"When computed" is load-bearing, not hedging. A `no_new_client` skip has a
computed message list - the job assembles `fresh` at `extraction.ts:294-296`
and only then consults the cursor gate at 316 - and that list is precisely the
evidence a reviewer needs to answer "why did it decide there was nothing new".
Discarding it because the outcome is "skipped" would contradict goal 3.
`no_contact` and `ineligible_type` genuinely have no window; they exit before
the fetch.

AMENDED post-approval - a skip records a LIGHT window: `cursor`,
`newestTsMsgId`, `windowCappedAtLimit`, and the message ids with their
`type`/`direction`, but NO capping, NO `chars`, and NO `hash`. A `detail`
discriminator (`light` | `full`) tells the reader which shape it holds, so a
missing hash is never mistaken for a failed one. On a light window `excluded`
carries `age_30d` causes ONLY - `char_budget` exclusions are produced by the
capping pass this amendment deliberately keeps below the freshness gate, so
they do not exist yet and must not be implied. Capping and
hashing happen at `extraction.ts:337` onward, AFTER the gate, so recording a
full window for a skip would mean doing that work on every skipped run purely
to log it - and `no_new_client` is the common steady-state outcome, so that is
the hot path. The light window answers the question completely: which messages
existed, and where the cursor sat. Bytes only matter when bytes were sent.

`error.kind` - set AT THE THROW SITE, never inferred afterwards. A writer
that cannot see which stage failed cannot distinguish these, which was the
whole reason `complete` was added:

- `refusal` - `ExtractionRefusedError` (`adapters/extraction.ts:161-163`).
- `parse` - the response arrived but did not parse (see 6.4).
- `driver` - any other failure inside `extract`.
- `complete` - `repo.complete()` threw after the model ran and the contact
  was mutated.
- `repo` - any other repository throw on the run path. These are real and
  currently unguarded: `repo.claim`, `contacts.getById`,
  `contacts.findByPhone`, and `messages.listByConversation` can all throw
  before or around the model call.

There is no `apply` kind: `applyExtraction` guards every side effect and does
not throw.

`skipReason` values, derived from the actual skip branches:

- `no_contact` - missing conversation, missing contact, or a bare phone-ref
  pointer item (`extraction.ts:274-288`, one shared branch).
- `ineligible_type` - landlord / partner / team_member (same branch).
- `no_new_client` - nothing newer than the cursor (`extraction.ts:316`).
- `empty_window` - nothing survived the cutoffs (`extraction.ts:327`).

Two branches are NOT recorded at all, and the writer must skip them
explicitly now that it runs on every path:

- claim-lost (`extraction.ts:256`) - the sliding debounce working as
  designed; recording it would be pure noise.
- the defensive `listedDueAt === undefined` return (`extraction.ts:254`) - a
  listed row always carries `dueAt`, so this is unreachable in practice and
  has no meaningful `skipReason`.

### 6.4 Driver interface change

`ExtractionDriver.extract` currently returns only `ExtractionResult`, so
`model`, `usage`, `driver`, and the response text are unreachable from the
job. The interface widens to return the result plus a metadata envelope:

```
extract(input): Promise<ExtractionCall>
ExtractionCall =
  | { ok: true;  meta: ExtractionMeta; result: ExtractionResult }
  | { ok: false; meta: ExtractionMeta; failure: 'refusal' | 'parse' | 'driver';
      message: string }
ExtractionMeta = { driver, model?, rawText?, usage?, promptFingerprint? }
```

`extract` returns a DISCRIMINATED result rather than throwing, for the same
two reasons as `processRow` (section 8): the caller must know which stage
failed, and a thrown error carrying `rawText` would put PII on the object
loggers serialize wholesale.

This also closes a case the previous draft lost outright. Today
`parseExtractionText` is invoked inside `extract`'s return expression
(`adapters/extraction.ts:170`), so a malformed response throws before any
envelope is constructed - discarding `rawText` for the ONE failure mode where
the response text is the entire answer to "what went wrong". Under the
discriminated return, meta is assembled first and `rawText` survives a parse
failure.

The `console` and `fake` drivers return `meta` with `driver` set and the
model-specific fields absent. This is a required precondition for section 6;
without it three recorded fields cannot be populated.

This is a BREAKING interface change with known call sites and test fallout,
all of which are build tasks rather than discoveries: the two production
drivers plus `extractionFake.ts`, the `processRow` call at
`extraction.ts:364`, five return-shape assertions in
`app/test/extractionAdapter.test.ts`, and four driver doubles in
`app/test/extractionJob.test.ts`.

`putSuggestion` returning the displaced row (7.3) is a SECOND breaking
signature change, with its own fallout at `app/test/extractionRepo.test.ts`
lines 435, 471, and 504.

Four helpers in `jobs/extraction.ts` are module-private today and must be
exported for the recorder and the detail view to reuse them rather than
reimplement them: `toUtterances`, `capUtterances`, `clampHeadTail`, and
`toProfile`. Reimplementing any of them would guarantee the hash mismatch
described in 6.1.

## 7. Decisions and verdicts

`decisions` is a map keyed by target (`firstName` .. `porting`, `address`,
`status`, `type`, `phone`). A map, not a list, so verdict write-back is a
single targeted `UpdateExpression` with no read-modify-write race.

```
decisions[target] = {
  proposedOp:     write | suggest | none | absent
  proposedValue?, coercedValue?, previousValue?, reason?
  demotedFrom?:   'write'   (a write routed to the suggest path)
  outcome:        wrote | suggested | dropped | no_finding | not_addressed
  dropReason?
  verdict, verdictAt?, verdictBy?
}
```

### 7.1 Decisions are built from the raw result, not from apply

The previous draft derived `no_finding` inside `apply.ts`, which cannot
support it: the loop at `apply.ts:166` treats a missing field and an explicit
`op: 'none'` identically, and `parseExtractionText` folds the address, type,
and phone sentinels to absent before apply ever sees them.

So decisions are assembled from what the model SAID, joined with apply's
outcomes for what we DID. Two distinct negatives become observable:

- `no_finding` - the model explicitly returned `op: 'none'` for this target.
- `not_addressed` - the target is absent from the response entirely.

Only the first is evidence the model considered the field. Conflating them
manufactures evidence of evaluation that never happened.

**ALL TWELVE targets are read from `rawText`, never from the parsed result.**

The parsed `ExtractionResult` is unusable for this purpose at every target,
for two different reasons:

- `address` and `type`: `parseExtractionText` folds their `none` sentinels to
  ABSENT (`schema.ts:233`, `258-263`), so a decline is indistinguishable from
  a silence.
- the eight scalars: `schema.ts:215-219` REWRITES a `write`/`suggest` whose
  value is unusable into `{ op: 'none' }` and drops the reason. A parsed
  `none` therefore means EITHER "the model declined" OR "the model tried and
  supplied an unusable value" - and the second is precisely the case QA needs
  to see, since it is the model failing rather than abstaining.

Two earlier revisions got this wrong in opposite directions: first deriving
`no_finding` inside `apply.ts` (which fabricates evidence of evaluation),
then splitting the source by target (which still fabricates a decline
whenever the downgrade at 215-219 fires). Reading `rawText` for everything is
both simpler and the only correct option.

To avoid re-encoding the sentinel contract in a second place - the same
mistake `6.4` avoids for the window helpers - `schema.ts` exports a
`parseExtractionOps(rawText)` that returns the per-target op view BEFORE any
folding or downgrading. The recorder calls that; it does not hand-roll a
JSON walk.

`parseExtractionOps` MUST BE TOTAL - it never throws. Its sibling
`parseExtractionText` throws by design on malformed input, and the recorder's
`parse` failure kind (6.3) is precisely the case where it will be handed
unparseable text. A throwing helper would take down the recorder on the one
failure the recorder exists to capture. On unparseable input it returns an
empty view, and every target is recorded `not_addressed`.

When `rawText` is absent (the `console` driver, or a driver failure before a
response arrived) no target may be recorded as `no_finding` - only
`not_addressed`. The spec does not permit inferring a decline that was never
observed. The `fake` driver DOES emit a synthetic `rawText` matching its
`EXTRACT:` marker protocol, so the e2e exercises this mechanism rather than
only its fallback.

### 7.2 dropReason

Re-enumerated against every discard branch in `apply.ts`:

`wrong_contact_type` (169, 224), `invalid_value` (175),
`equal_to_current` (198, 270), `status_not_onboarding_tenant` (338),
`type_already_classified` (360), `phone_not_canonicalizable` (367),
`phone_already_owned` (369), `phone_owned_by_other` (379),
`dismissed_before` and `repo_error` (both in `putSuggestionSafe`), and
`empty_value_at_parse`.

`empty_value_at_parse` (AMENDED post-approval) closes a gap 7.1 left open.
When `rawText` shows the model proposed `write` or `suggest` but the value was
empty or whitespace, `schema.ts:215-219` (scalars) or `258-263` (address)
folds it away before apply ever runs. 7.1 forbids calling that `no_finding` -
the model did NOT decline - but named no alternative. It is recorded as
`outcome: dropped` with this reason. It is deliberately DISTINCT from
`invalid_value`, which is apply's `coerceField` rejecting a well-formed but
out-of-range value (`apply.ts:175`): one is the model sending nothing usable,
the other is the model sending something wrong, and QA needs to tell those
apart.

Two candidates were removed after checking the code rather than the
docstrings. `note_line_filtered` (409-411) has no decision target to attach
to - note lines are not targets - so it would have been an orphan key;
filtered notes are visible only as a lower `notedLines`. `address_no_usable_
parts` (226) is unreachable in production: `parseExtractionText` already
drops an address with zero usable parts before apply is called
(`schema.ts:258-263`), so the branch is defensive only. Recording a value
that can never occur is the same phantom class as the `error.kind: 'apply'`
this spec already removed.

`lossy_address` and `demoted_inferred_role` are NOT dropReasons. Both produce
SUGGESTIONS (`apply.ts:256-284` and `189-211`); the earlier draft inverted
apply's control flow. They are recorded as `outcome: suggested` with
`demotedFrom: 'write'`.

Note lines are not decision targets; they are recorded only as the
`notedLines` count. `phone_owned_by_other` legitimately produces BOTH a
dropped decision and a note line (`apply.ts:379-381`) - two different
mutations, both recorded.

### 7.3 Verdicts

`verdict` is total; never blank, because blank is indistinguishable from
"nobody has looked yet".

| outcome                     | verdict                                   |
| --------------------------- | ----------------------------------------- |
| `wrote`                     | `auto_applied`                            |
| `suggested`                 | `pending` -> `accepted` / `dismissed` / `superseded` / `superseded_by_human_edit` |
| `dropped`                   | `not_presented`                           |
| `no_finding`/`not_addressed`| `not_presented`                           |

`auto_applied` does not imply the field was empty. The model may write over
an occupied field as same-fact-better-form, and this is true of all eight
scalar fields and of address - not address alone. The presence or absence of
`previousValue` distinguishes the cases.

**Suggestion rows carry a `runId`.** Every verdict surface needs it to know
which run record to address; without it none of them can. (An earlier
revision dropped this plumbing while restructuring - it is restored here
explicitly because it is the precondition for all of section 7.3.)

Three resolution surfaces write verdicts, not one:

1. `suggestions.ts` accept / dismiss -> `accepted` / `dismissed`. AMENDED
   post-approval: accept is not one call site but FOUR separate
   `deleteSuggestion` branches - `status` (185), `phone` (235), `address`
   (270), and the generic field path (304) - plus dismiss (339).
   Instrumenting only the generic branch would silently miss status, phone,
   and address accepts, three of the most common targets. All five are
   explicit tasks with a test each.
2. `contacts.ts:1321-1327` - a human PATCH edit deletes the pending
   suggestion for every changed field. Without instrumenting this, those
   decisions sit `pending` forever -> `superseded_by_human_edit`.
3. `extractionRepo.putSuggestion` displacing an earlier run's suggestion,
   detected via `ReturnValues: 'ALL_OLD'` -> `superseded`.

Target `type` is partly special and was previously overstated here. The
ACCEPT route refuses it (`suggestions.ts:157`, `accept_type_via_triage`), so
a `type` decision can never reach `accepted` through surface 1 - it reaches
`accepted` only via the PATCH of surface 2. But the DISMISS route
(`suggestions.ts:316`) carries no target restriction and handles `type`
today, so surface 1 can still resolve it to `dismissed`. Instrumenting only
the PATCH would leave dismissed `type` decisions stranded.

AMENDED post-approval - **for `type` ONLY, the PATCH verdict depends on the
VALUE**: `accepted` when the patched type equals `suggestedValue`,
`superseded_by_human_edit` when it differs. An earlier reading recorded any
`type` PATCH as `accepted`, which inverts the signal in the case that matters
most: a human triaging a contact to `landlord` after the model suggested
`tenant` has REJECTED that suggestion, and recording it as an acceptance
would corrupt the accuracy record this feature exists to produce.

This value comparison is confined to `type`. It must NOT be generalized to
the other eleven targets: for them the PATCH is a human edit that supersedes
the suggestion regardless of value, and a general equality rule was
considered and rejected - it cannot even fire for `voucherSize`, `porting`,
or `address`, whose stored forms are not string-comparable to
`suggestedValue`.

The `superseded` stamp is NOT written inside `putSuggestion`, and NOT by
`apply.ts` - `apply.ts` is `putSuggestion`'s caller, so "the caller does it"
would have handed apply an `ai_runs` dependency the write-path section
explicitly denies. Instead `putSuggestion` RETURNS the displaced row,
`applyExtraction` surfaces the displaced `runId`s on its `ApplyOutcome`, and
the JOB writes the stamps. Apply stays free of `ai_runs`, and a stamp failure
cannot be mistaken for a suggestion failure - which matters, because
`putSuggestionSafe` treats a throw as a failed suggestion and that suppresses
the load-bearing `suggestion.updated` emit at `apply.ts:443-445`.

Every verdict write carries `ConditionExpression: attribute_exists(itemId)`.
Runs TTL at 90 days but pending suggestions never expire, so a verdict can
land on an expired run; without the guard, a nested-path `UpdateItem` either
errors or upserts a malformed partial item.

(An earlier revision's paragraph naming apply.ts as the stamp writer stood
here and has been deleted; it contradicted the routing above.)

## 8. Write path and failure isolation

An earlier draft claimed a single writer, which was false. The corrected
model separates the ENVELOPE from the VERDICTS.

**The envelope has exactly one writer, and writes exactly once.**
`processRow` builds a `RunDraft` as it goes - trigger and ids first, then
window, then meta and raw response, then decisions - and never writes it
itself.

**`processRow` no longer throws, and no longer returns a bare discriminator.**
It returns `{ outcome, draft }` on every path: success, skip, and failure
alike. It catches internally at each stage and stamps `draft.error.kind` at
the throw site (6.3), which is the only place that information exists.
`runDueExtractions` then performs the single write and derives its
backoff/park decision from `outcome === 'failed'`.

**The outer try/catch in `runDueExtractions` STAYS, as a backstop.** It is not
replaced by the returned outcome. Today it provides per-row batch isolation
(`extraction.ts:401-425`): one row's failure is logged, routed through
backoff/park, and the loop continues with the next row. `processRow` not
throwing on KNOWN failures does not mean it can never throw - an unhandled
defect, an OOM, or a repo path nobody enumerated would otherwise abort the
entire poll batch. The returned outcome is the primary path; the catch
remains the safety net and must still call `repo.fail`.

**A skip-path `complete()` throw is a FAILURE, not a skip.** The three skip
branches each call `repo.complete()` (`extraction.ts:286`, `318`, `328`).
Reading "it was a skip, so record `skipped`" would be a silent regression:
`repo.complete()` is what clears the claim, so a throw there leaves the row
CLAIMED and out of the `byDueAt` index, and recording it as `skipped` means
no `repo.fail()` - hence no backoff, no attempt increment, and no park. The
row would never run again and nothing would say so. Any `complete()` throw,
on any path including skips, is `outcome: 'failed'` with
`error.kind: 'complete'` and goes through the normal failure handling.

Three defects are closed by that one change, and they are why the obvious
designs were rejected:

- If `processRow` writes on success and the outer catch writes on failure,
  neither path holds every field AND a failure after a successful write
  emits TWO records for one run.
- If the draft rides on a thrown `Error`, `error.kind` still cannot name the
  failing stage, because the outer catch sees only an exception.
- If the draft rides on a thrown `Error`, then `rawText`, `previousValue`,
  and `proposedValue` - all PII - are attached to the one object type the
  logging conventions serialize WHOLESALE (`logger.error({ err })` appears
  throughout this codebase, including `extraction.ts:418-422`). That would
  put contact PII into logs, violating section 10's absolute rule as a side
  effect of an error path nobody would think to audit.

The third is the decisive one. A returned draft never touches a logger.

Verdicts are written later by three surfaces, per 7.3: `suggestions.ts`
accept/dismiss, the `contacts.ts` PATCH, and the job's `superseded` stamp.

All four writes are best-effort.

`applyExtraction` widens its `ApplyOutcome` to return per-target outcomes,
drop reasons, and any displaced `runId`s; the job joins those with the
model's response to build `decisions`. Apply stays the decision authority and
gains NO dependency on `ai_runs` - that separation is what makes the
`superseded` routing in 7.3 necessary rather than fussy.

The record is written on every terminal path, never gated on
`repo.complete()`. A `complete()` failure must not erase the record of a run
that called the model and mutated the contact; it is recorded as
`error.kind: 'complete'`.

The recorder is strictly best-effort: wrapped in try/catch, logged,
swallowed. It must never fail an extraction run, re-arm a due row, or burn a
retry attempt. Observability that can break what it observes is worse than
none.

Deliberately not idempotent. If `complete()` fails and the row re-arms, the
retry writes a second run record. The model really was called twice.

Both `ExtractionJobDeps` construction sites must be updated:
`app/src/worker.ts` and `app/src/routes/dev.ts` (the deterministic dev tick).
Missing the dev tick leaves the log permanently empty in e2e and local
development - the exact place this feature is first exercised.

Runs under the `console` and `fake` drivers are recorded, which is what makes
the feature testable end to end.

## 9. Surface

Admin-only route `/settings/ai-runs`. Surfaces to update: the settings tab
registry (`SETTINGS_TABS`), the route table in `dashboard/src/App.tsx`, the
client-side `AdminRoute` guard, and a server-side `requireRole('admin')` on
the new endpoints. Client-side guarding alone is not authorization.

Two-pane master-detail, matching Inbox and Placement detail. List paged 25.

Header states current driver, model, prompt fingerprint, and whether
extraction is enabled, so an empty log is never mistaken for "the AI reviewed
everything and found nothing". This extends the existing flags surface -
`GET /api/system/flags` in `app/src/routes/system.ts` - NOT `routes/settings.ts`,
which an earlier revision named incorrectly. `SystemFlags` carries no
extraction fields today, so `aiExtractionEnabled`, `aiExtractionDriver`,
`aiExtractionModel`, and `aiExtractionPromptFingerprint` are added to it as an
explicit task. AMENDED post-approval: the earlier bare `driver` / `model`
names would have sat ambiguously beside the existing `messagingDriver` on the
same object; the prefixed names match `aiExtractionEnabled` and cannot be
misread.

**Scope is a single exclusive selector, not a filter matrix.** One Query has
one hash key, so `global`, a contact, a conversation, and an outcome cannot
be combined. The UI offers one scope choice plus a date range (a `BETWEEN` on
`sortKey`, which composes with any scope). Presenting these as independent
checkboxes would promise a query the index cannot serve.

Detail pane: run header (contact, time, trigger, driver/model/fingerprint,
tokens, duration); the window table with tier, truncation, hash status,
excluded-with-cause and no-content lists; the decisions table with target /
proposed / was / outcome / verdict / reason; collapsed raw text and parsed
result.

API, both `requireRole('admin')`:

- `GET /api/ai-runs?scope=&before=&limit=` - list
- `GET /api/ai-runs/:runId` - detail

Rehydration needs a point-get by `(conversationId, tsMsgId)`, which
`messagesRepo` does not have today - it exposes only `listByConversation`
(`messagesRepo.ts:671`). Adding it is an explicit task, not an assumption.

## 10. Retention and PII

90-day TTL via `expires_at` on run and pointer rows alike.

PII lives in `rawText`, `rawResult`, and decision values. It is never logged
- the existing "never log message bodies or phone numbers" rule is unchanged
and binding on all new code. Storage is DynamoDB only, reads are admin-only
on both client and server, and TTL bounds the window.

## 11. Testing

- Unit: the `ai_runs` repo - both row kinds, pointer fan-out, TTL stamping,
  `byEntity` paging, BatchGet re-sorting and `UnprocessedKeys` retry.
- Unit: decisions assembly from `rawText` (via `parseExtractionOps`, never
  the parsed result - see 7.1) joined with apply outcomes, covering
  `no_finding` vs `not_addressed`, `demotedFrom`, and every `dropReason`
  branch. These branches have no test coverage today because they were
  `logger.debug` dead ends.
- Unit: all three verdict surfaces, including `superseded_by_human_edit` via
  the contacts PATCH path, `type` reaching `accepted` ONLY via that PATCH,
  and `type` reaching `dismissed` via the unrestricted dismiss route.
- Unit: `no_finding` vs `not_addressed` for all twelve targets sourced from
  `rawText` via `parseExtractionOps`, including the two cases a parsed-result
  reading gets wrong (a folded address/type sentinel, and a scalar downgraded
  by `schema.ts:215-219`), plus the absent-`rawText` case where neither may
  be inferred.
- Unit: `processRow` returns a draft rather than throwing on every failure
  stage, and `error.kind` names the correct stage for refusal, parse, driver,
  complete, and repo failures.
- Unit: no run-path error object ever carries `rawText` or decision values -
  the PII-on-Error regression guard.
- Unit: the envelope is written EXACTLY ONCE per run on every terminal path,
  including a failure after the model ran (no double record, no lost record).
- Unit: the window `hash` is produced by the same renderer that builds the
  request, so a round trip over an unchanged message matches.
- Unit: the `attribute_exists` guard - a verdict write against an expired run
  fails cleanly and creates nothing.
- Unit: recorder failure isolation - a throwing run-log write leaves the
  extraction outcome, cursor, and attempt count untouched.
- Unit: a `failed` run still records window and decisions.
- E2E: drive a message through the `fake` driver's `EXTRACT:` marker
  protocol; assert the run appears with the right window, `excluded` causes,
  `noContent`, and decisions; accept a suggestion and assert the verdict; edit
  a field via PATCH and assert `superseded_by_human_edit`.

## 12. Build tasks with infra coupling

`npm run gen:tables` must be run after registering the table, and the
regenerated `infra/envs/dev/tables.auto.tfvars.json` and
`infra/envs/prod/tables.auto.tfvars.json` committed. Both are tracked files;
`npm run plan` and `npm run drift` fail when they are stale. This is a BUILD
task, not a post-merge op.

## 13. Post-merge ops

Cameron's to run, per the standing no-infra-without-explicit-ask rule:

1. dev `terraform apply` for the new `ai_runs` table.
2. prod `terraform apply` at the M1.11 cutover.

Separately and independently: `AI_EXTRACTION_ENABLED` is being flipped to
`true` in production.

## 14. Known limitations

- A hand-edit that corrects an auto-applied field is not linked back to the
  run. The "changed since" comparison (current contact value vs the run's
  `coercedValue`) approximates it, but cannot distinguish a human correction
  from a LATER AI run overwriting the same field - both look identical.
- Messages beyond `MAX_TRANSCRIPT_MESSAGES` cannot be enumerated in
  `excluded`; only the `windowCappedAtLimit` flag signals they may exist.
- The `hash` detects drift but does not guarantee replay. `windowParams`
  distinguishes a constant change from an algorithm change, but a pure
  algorithm change is visible only as an unexplained mismatch.
- Aggregate quality statistics are not built.
- A run whose record fails to write is invisible while the extraction itself
  succeeded - the accepted cost of best-effort recording. Such failures log.
- Window previews depend on the underlying messages still existing. A deleted
  message rehydrates as unavailable; hash and char count still prove what was
  sent.
- A pointer whose run row has already been TTL-reaped renders as expired.
