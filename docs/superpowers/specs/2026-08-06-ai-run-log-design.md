# AI Run Log - Design

Date: 2026-08-06
Status: DRAFT - revised after adversarial review round 1
Phase: 2 (automations), observability slice

Revision note: round 1 of adversarial review (two blind reviewers) accepted
23 findings, 6 of them structural. Adjudications, including rejections with
reasoning, are at `.superpowers/design-review/adjudications.md` in the
feature worktree.

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
- Versioning the truncation algorithm itself. Rejected as scope creep; a
  `windowBuilderVersion` marker is recorded instead.

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
nothing and the `runId` attribute is available directly from the index.

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
  conversationId, contactId?
  trigger:  sms | voice | triage | email        (the due row's channel)
  outcome:  applied | no_op | skipped | failed
  skipReason?:  see 6.3
  error?:   { kind: refusal | driver, message, attempts, parked }

  driver:   anthropic | console | fake
  model?:   the model id actually called
  promptFingerprint?: sha256 of the assembled system prompt, first 12 hex
  windowBuilderVersion: integer
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

`hash` - sha256 of the exact utterance text sent for that message, first 16
hex. For a multi-utterance message the hash covers the utterance texts joined
by `\n`, in order, as sent.

This is DRIFT DETECTION, not a replay guarantee. A change to utterance
derivation (`toUtterances`) or to the capping algorithm (`capUtterances`,
`clampHeadTail`) changes the bytes for the same stored message, so a hash
mismatch means "something changed", not necessarily "the message changed".
`windowBuilderVersion` - a hand-bumped integer, incremented whenever
`toUtterances`, `capUtterances`, or `clampHeadTail` changes - tells a reader
that comparison across the boundary is invalid. Versioning the algorithm
itself was considered and rejected as scope creep.

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

| outcome   | window | decisions | rawText/rawResult | usage | error |
| --------- | ------ | --------- | ----------------- | ----- | ----- |
| `applied` | yes    | yes       | yes (anthropic)   | yes   | no    |
| `no_op`   | yes    | yes       | yes (anthropic)   | yes   | no    |
| `skipped` | no     | no        | no                | no    | no    |
| `failed`  | yes*   | yes*      | if the call returned | if returned | yes |

(*) A `failed` run carries whatever had been assembled when it failed. A
driver failure has a window but no decisions; an apply-stage failure has
both. This is the point of accepted finding 3: the previous draft wrote the
record only after `repo.complete()`, so a run that called the model and
mutated the contact but failed to complete left NO record at all.

`skipReason` values, derived from the actual skip branches:

- `no_contact` - missing conversation, missing contact, or a bare phone-ref
  pointer item (`extraction.ts:274-288`, one shared branch).
- `ineligible_type` - landlord / partner / team_member (same branch).
- `no_new_client` - nothing newer than the cursor (`extraction.ts:316`).
- `empty_window` - nothing survived the cutoffs (`extraction.ts:327`).

Claim-lost skips (`extraction.ts:256`) are NOT recorded: they are the sliding
debounce working as designed and would be pure noise.

### 6.4 Driver interface change

`ExtractionDriver.extract` currently returns only `ExtractionResult`, so
`model`, `usage`, `driver`, and the response text are unreachable from the
job. The interface widens to return the result plus a metadata envelope:

```
extract(input): Promise<{ result: ExtractionResult; meta: ExtractionMeta }>
ExtractionMeta = { driver, model?, rawText?, usage?, promptFingerprint? }
```

The `console` and `fake` drivers return `meta` with `driver` set and the
model-specific fields absent. This is a required precondition for section 6;
without it three recorded fields cannot be populated.

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

So decisions are assembled from the PARSED RESULT (for what the model said)
joined with apply's outcomes (for what we did). This makes two distinct
negatives observable:

- `no_finding` - the model explicitly returned `op: 'none'` for this target.
- `not_addressed` - the target is absent from the response entirely.

Only the first is evidence the model considered the field. Conflating them
would have manufactured evidence of evaluation that never happened.

### 7.2 dropReason

Re-enumerated against every discard branch in `apply.ts`:

`wrong_contact_type` (169, 224), `invalid_value` (175),
`equal_to_current` (198, 270), `address_no_usable_parts` (226),
`status_not_onboarding_tenant` (338), `type_already_classified` (360),
`phone_not_canonicalizable` (367), `phone_already_owned` (369),
`phone_owned_by_other` (379), `note_line_filtered` (409-411),
`dismissed_before` and `repo_error` (both in `putSuggestionSafe`).

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

Three resolution surfaces write verdicts, not one:

1. `suggestions.ts` accept / dismiss -> `accepted` / `dismissed`.
2. `contacts.ts:1321-1327` - a human PATCH edit deletes the pending
   suggestion for every changed field. Without instrumenting this,
   those decisions sit `pending` forever. -> `superseded_by_human_edit`.
3. `extractionRepo.putSuggestion` displacing an earlier run's suggestion,
   detected via `ReturnValues: 'ALL_OLD'` -> `superseded`.

Target `type` is a special case: `suggestions.ts:157` refuses
`accept_type_via_triage`, so `type` is resolvable ONLY through the PATCH
path. Surface 2 is therefore the sole way a `type` decision ever leaves
`pending`.

Every verdict write carries `ConditionExpression: attribute_exists(itemId)`.
Runs TTL at 90 days but pending suggestions never expire, so a verdict can
land on an expired run; without the guard, a nested-path `UpdateItem` either
errors or upserts a malformed partial item.

The `superseded` stamp is performed by the caller of `putSuggestion`, NOT
inside it. A throw inside `putSuggestion` would be caught by
`putSuggestionSafe` and counted as a suggestion failure, which suppresses the
load-bearing `suggestion.updated` emit at `apply.ts:443-445`.

## 8. Write path and failure isolation

The previous draft claimed a single writer. That was false. The real writer
set:

- `processRow` (`jobs/extraction.ts`) - the run envelope, on every terminal
  path including skips.
- `runDueExtractions` catch - `outcome: failed`, carrying whatever the run
  had assembled.
- `suggestions.ts` accept / dismiss - verdicts.
- `contacts.ts` PATCH - `superseded_by_human_edit` verdicts.
- the `putSuggestion` caller - `superseded` verdicts.

One writer owns the ENVELOPE; four surfaces write verdicts onto it later.
All five are best-effort.

`applyExtraction` widens its `ApplyOutcome` to return per-target outcomes and
drop reasons; the job joins them with the parsed result to build `decisions`.
Apply stays the decision authority; it does not gain a dependency on
`ai_runs`.

The record is assembled incrementally and written on every terminal path, not
after `repo.complete()`. A `complete()` failure must not lose the record of a
run that called the model and mutated the contact.

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
everything and found nothing". This extends the existing system-status
surface (`app/src/services/systemStatus.ts`, `routes/settings.ts`) rather
than adding a parallel config endpoint.

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
- Unit: decisions assembly from parsed result + apply outcomes, covering
  `no_finding` vs `not_addressed`, `demotedFrom`, and every `dropReason`
  branch. These branches have no test coverage today because they were
  `logger.debug` dead ends.
- Unit: all four verdict surfaces, including `superseded_by_human_edit` via
  the contacts PATCH path and the `type`-only-via-PATCH case.
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
- The `hash` detects drift but does not guarantee replay; a
  `windowBuilderVersion` change invalidates cross-boundary comparison.
- Aggregate quality statistics are not built.
- A run whose record fails to write is invisible while the extraction itself
  succeeded - the accepted cost of best-effort recording. Such failures log.
- Window previews depend on the underlying messages still existing. A deleted
  message rehydrates as unavailable; hash and char count still prove what was
  sent.
- A pointer whose run row has already been TTL-reaped renders as expired.
