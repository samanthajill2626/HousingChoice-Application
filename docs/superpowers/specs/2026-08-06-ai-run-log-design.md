# AI Run Log - Design

Date: 2026-08-06
Status: DRAFT - awaiting Cameron's review
Phase: 2 (automations), observability slice

## 1. Overview

The conversation-fact-extraction pipeline calls a model, mutates contact data,
and leaves almost no record of having done so. This design adds a durable,
queryable record of every extraction run: what the model was shown, what it
said, what we did with each finding, and what a human later decided about it.

The record lives in a new `ai_runs` DynamoDB table and is read through an
admin-only two-pane run log at `/settings/ai-runs`.

Two audiences, one artifact:

- QA: browse recent runs, see how the system behaves, find the cases where it
  should have found something and did not.
- Audit: given a value on a contact, trace it back to the exact run, the exact
  messages that produced it, and the human verdict that followed.

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
  truncated or pushed out by the char budget;
- the raw model output;
- every finding the model made that the apply layer discarded (invalid
  coercion, wrong contact type, equal-to-current, previously dismissed, lossy
  address). These end in `logger.debug` and are gone;
- runs that produced nothing, so "why did it not catch that" is unanswerable;
- the model id, prompt version, token counts, and latency per run;
- any link from a suggestion back to the run that produced it.

## 3. Goals

- Answer "exactly which messages did the AI read for this run" without storing
  a second copy of message text.
- Answer "what did it propose, from what previous value, and what did we do
  with it" from the run record alone, without opening raw JSON.
- Record negative findings explicitly, at field granularity - "it considered
  housingAuthority against this message and declined" - so a reviewer can
  disagree with a non-finding, not just with a finding.
- Record runs that were skipped or failed, with the reason.
- Close the loop: show what a human did with each suggestion.
- Never affect extraction behavior. The recorder is best-effort in the strict
  sense (section 8).

## 4. Non-goals

- Voice transcription (Twilio Voice Intelligence). Its output is already
  stored on the message row and rendered in the UI; the gap there is
  speaker-attribution quality, not visibility. Out of scope.
- Aggregate statistics panels (per-field accept rates, token spend charts).
  The data model supports adding them later; the first cut is the log itself.
- Linking a later human hand-edit of an auto-applied field back to the run
  that wrote it. Section 7 describes a free approximation; full instrumentation
  of every contact edit is a much wider blast radius for a weaker signal.
- Replaying or re-running a stored run. The record is designed to make replay
  possible later (section 6) but no replay UI is built.

## 5. Storage

### 5.1 Why a new table

Two alternatives were considered and rejected.

Adding `run#` rows to the existing `ai_extraction` table still requires a new
GSI (so a `terraform apply` either way) and forces table-wide TTL onto a table
that holds permanent dismissal tombstones and extraction cursors. Those rows
survive only by lacking the `expires_at` attribute; one careless write
silently resurrects a dismissed suggestion or rewinds a cursor into
re-extracting months of history. No savings, real new footgun.

Using `audit_events` needs no infra at all, but that table is keyed
`entityKey` + `ts`, so "newest runs across all contacts" - the primary surface
- is only answerable by a full Scan. It also has no TTL.

### 5.2 Table `ai_runs`

Single hash key `itemId`, two disjoint row kinds by prefix (the same pattern
`ai_extraction` uses):

```
run#<runId>                            the full record
ptr#<entityKey>#<startedAt>#<runId>    an adjacency-list pointer
```

One GSI, `byEntity`:

- hash `entityKey` (S)
- range `sortKey` (S), formatted `<startedAt ISO>#<runId>`
- sparse - only `ptr#` rows carry `entityKey`
- projection `INCLUDE [runId]`

`ttlAttribute: 'expires_at'` (epoch seconds), registered in
[app/src/lib/tables.ts](../../../app/src/lib/tables.ts) alongside the existing
TTL tables (`messages`, `matches`, `unmatched_email`).

### 5.3 Pointers

Each run writes one pointer per dimension it should be filterable by, using
the `<table>#<id>` entityKey convention already binding on `audit_events`:

| entityKey                | written                         |
| ------------------------ | ------------------------------- |
| `global`                 | always                          |
| `outcome#<outcome>`      | always                          |
| `conversations#<convId>` | always                          |
| `contacts#<contactId>`   | when a contact resolved         |
| `units#<unitId>` etc.    | future runs, no schema change   |

So 3 or 4 small rows per run today.

Reading is one code path for every filter: Query `byEntity` on the chosen
`entityKey`, descending by `sortKey`, page size 25, then one `BatchGetItem` for
those 25 `run#` rows. Date ranges are a `BETWEEN` on `sortKey` against any
entityKey. No Scan, ever.

Pointers stay pure pointers - no denormalized run summary. A copied summary
would need updating whenever a verdict lands, and a drifting second copy is
exactly the class of bug this feature exists to catch. The extra round trip is
negligible at staff-tool volumes.

`expires_at` is set on both row kinds with the same value, so a pointer can
never outlive its run and strand the list with dead ids.

Note on the `global` partition: all runs share one GSI partition key value, and
DynamoDB's split-for-heat cannot subdivide a single key value, so it is capped
at roughly 3,000 RCU/s and 1,000 WCU/s. At low hundreds of runs per month this
is about six orders of magnitude of headroom. Recorded as a footnote, not a
design constraint.

## 6. The run record

```
run#<runId>
  runId, startedAt, finishedAt, durationMs
  conversationId, contactId?
  trigger:  sms | voice | triage | email        (the due row's channel)
  outcome:  applied | no_op | skipped | failed
  skipReason?:  no_contact | ineligible_type | no_new_client | empty_window
  error?:   { kind: refusal | driver | apply, message, attempts, parked }

  driver:   anthropic | console | fake
  model:    the model id actually called
  promptVersion: integer - a constant exported from
            services/extraction/prompt.ts, bumped by hand in the same change
            that edits the system prompt. Starts at 1 (meaning "the prompt as
            of this feature"); earlier prompt revisions are not reconstructed.
  usage?:   { inputTokens, outputTokens }
  profileFieldsPopulated: [ field name ]   - see 6.2

  window:
    cursor, newestTsMsgId, hasInferredRoleContent, totalChars
    messages: [ { tsMsgId, type, direction, tier, capChars,
                  truncated, chars, hash } ]
    excluded: [ tsMsgId ]

  rawResult?:   the parsed model JSON, verbatim
  decisions:    map, target -> decision (section 7)
  notedLines:   count of note lines appended
  expires_at
```

### 6.1 Window fidelity

The window stores message ids, not message text - text is rehydrated from
`messagesRepo` at view time. Three fields make that decision safe:

`capChars` - the exact per-message cap this run applied, not just a `new` /
`seen` tier label. The caps are code constants (`NEW_MESSAGE_CHAR_CAP`,
`SEEN_MESSAGE_CHAR_CAP`). If either is ever tuned, every historical run would
silently rehydrate wrong. Storing the applied cap keeps replay deterministic
across future code changes.

`hash` - sha256 of the exact utterance text sent for that message, hex,
first 16 characters. For a multi-utterance message (a call transcript, one
utterance per line) the hash covers the utterance texts joined by `\n`, in
order, exactly as sent. This upgrades the viewer from "this is probably what
the model saw" to verified byte-identical, and catches the one real drift case:
a call transcript that lands after an SMS-triggered run already read that row.
A mismatch is surfaced in the UI, never silently ignored.

`excluded` - the list of `tsMsgId`s dropped by `WINDOW_CHAR_BUDGET`, not a
count. A message that existed in the conversation but never reached the model
is a prime explanation for a miss, and a count cannot tell you which one.

`chars` is the message's total utterance length after capping.

### 6.2 What is deliberately not stored

No profile snapshot. The model reconciles against a full contact profile
(name, address, notes). Copying it in would duplicate the contact's PII into a
second store for little gain. Instead the run stores the list of populated
profile field names, which answers the QA question that actually arises ("it
already had a last name and proposed one anyway") without the copy.

`rawResult` does contain PII - an extracted name, address, or phone. That is
unavoidable and accepted: it is the same data already landing on the contact
and in `ai_extraction` suggestions, and it is the point of the feature. It is
stored in DynamoDB, never logged, behind the admin route, and TTL'd at 90 days.

## 7. Decisions and verdicts

`decisions` is a map keyed by target (`firstName` .. `porting`, `address`,
`status`, `type`, `phone`). A map, not a list, so verdict write-back is a
single targeted `UpdateExpression` on `decisions.#target.verdict` with no
read-modify-write race. Apply performs at most one op per target, so keys are
unique.

```
decisions[target] = {
  proposedOp:     write | suggest | none
  proposedValue?: raw string from the model
  coercedValue?:  post-coercion value ("3" -> 3, address parts -> formatted)
  previousValue?: what the contact held before
  reason?:        the model's own justification
  outcome:        wrote | suggested | dropped | no_finding
  dropReason?:    see below
  verdict:        always populated (see table)
  verdictAt?, verdictBy?
}
```

`dropReason` values, one per existing discard branch in `apply.ts`:
`invalid_value`, `wrong_contact_type`, `equal_to_current`, `dismissed_before`,
`lossy_address`, `demoted_inferred_role`, `phone_owned_by_other`,
`not_canonicalizable`, `repo_error`.

Appended note lines are not decision targets - they are recorded only as the
`notedLines` count, since they carry no target, no previous value, and no
verdict.

### 7.1 Negative findings

`apply.ts` currently discards every `op: 'none'` from the model before anything
observes it. Those are recorded as `outcome: no_finding`. This is the finest
grain of negative finding available - not "the run found nothing" but "it
evaluated housingAuthority against this message and declined" - and it is the
one a reviewer can actually act on.

Runs where the model proposed nothing at all are recorded with
`outcome: no_op` and their full window, so a reviewer can see exactly which
messages were read and nothing found. Runs that never reached the model are
recorded with `outcome: skipped` and a `skipReason`.

Claim-lost skips are the sliding debounce working as designed and are NOT
recorded - they would be pure noise.

### 7.2 Verdicts

`verdict` is total; it is never blank, because a blank is indistinguishable
from "nobody has looked yet".

| outcome      | verdict                                              |
| ------------ | ---------------------------------------------------- |
| `wrote`      | `auto_applied`                                       |
| `suggested`  | `pending` -> `accepted` / `dismissed` / `superseded`  |
| `dropped`    | `not_presented` (`dropReason` says why)              |
| `no_finding` | `not_presented`                                      |

`auto_applied` does not imply the field was empty: address direct-writes are
allowed onto an occupied field as same-fact-better-form. The presence or
absence of `previousValue` distinguishes the two cases.

Suggestions gain a `runId` attribute. The accept and dismiss routes in
[app/src/routes/suggestions.ts](../../../app/src/routes/suggestions.ts) stamp
the verdict onto the run - best-effort, never blocking the accept.

Superseded suggestions: `putSuggestion` is a latest-wins `Put`, so a later run
replacing the same `(contact, target)` slot would leave the earlier run's
decision `pending` forever, inflating the "never reviewed" count. The fix is
free - that `Put` returns `ReturnValues: 'ALL_OLD'`, and when the displaced row
carried a different `runId`, the earlier decision is stamped `superseded`. No
extra read.

Auto-applied writes have no human verdict, since there is no accept button.
A free approximation is available at view time: compare the run's
`coercedValue` against the contact's current value; if they differ, the field
was changed after the AI wrote it. Displayed as a "changed since" hint, not a
stored verdict.

## 8. Write path and failure isolation

`applyExtraction` is widened to return the decisions map on its `ApplyOutcome`.
It stays the decision authority; `processRow` in `jobs/extraction.ts` becomes
the sole writer of the run record, after `repo.complete()`. One writer, no new
coupling. The failure path in `runDueExtractions` records `outcome: failed`.

The recorder is strictly best-effort: wrapped in try/catch, logged, swallowed.
A run-log write must never fail an extraction run, never re-arm a due row,
never burn a retry attempt. Observability that can break the thing it observes
is worse than no observability. This mirrors the discipline `apply.ts` already
applies to its audit appends.

Deliberately not idempotent. If `complete()` fails and the row re-arms, the
retry writes a second run record. That is correct - the model really was
called twice, and collapsing them would falsify both the token spend and the
behavior record.

Runs under the `console` and `fake` drivers are recorded too, which is what
makes the feature testable end to end.

## 9. Surface

Admin-only route `/settings/ai-runs` behind the existing `AdminRoute`, linked
from a Settings section. Two-pane master-detail, matching Inbox and Placement
detail. List paged 25.

Header states current driver, model, prompt version, and whether extraction is
enabled - so an empty log is never mistaken for "the AI reviewed everything and
found nothing".

List rows carry the outcome chip plus a change summary (for example
"applied - sms - 2 changes"), recovering some of the scan density a two-pane
layout costs relative to a dense table.

Detail pane shows, in order: run header (contact, time, trigger, driver/model/
prompt, tokens, duration); the window table with tier, truncation, hash
verification, and excluded messages, with previews rehydrated from
`messagesRepo`; the decisions table with target / proposed / was / outcome /
verdict / reason; and a collapsed raw model output block.

Filters: contact, conversation, outcome, date range - each one a choice of
pointer partition per section 5.3.

API:

- `GET /api/ai-runs?entity=&before=&limit=` - list
- `GET /api/ai-runs/:runId` - detail, rehydrates window previews and verifies
  hashes

Both admin-only.

## 10. Retention and PII

90-day TTL via `expires_at` on run and pointer rows alike. Sufficient for QA
pattern-spotting and recent-dispute auditing; storage stays flat with zero ops.

PII lives in `rawResult` and in `decisions` values. It is never logged - the
existing "never log message bodies or phone numbers" rule is unchanged and
still binding on all new code. Storage is DynamoDB only, reads are admin-only,
and TTL bounds the exposure window.

## 11. Testing

- Unit: the `ai_runs` repo (both row kinds, pointer fan-out, TTL stamping,
  `byEntity` paging).
- Unit: the decisions map, covering every `dropReason` branch. These branches
  currently have no test coverage at all, because they were `logger.debug` dead
  ends with no observable output.
- Unit: verdict write-back, including the `superseded` path via `ALL_OLD`.
- Unit: recorder failure isolation - a throwing run-log write leaves the
  extraction outcome, cursor, and attempt count untouched.
- E2E: drive a message through the deterministic `fake` driver's `EXTRACT:`
  marker protocol, assert the run appears in the log with the right window,
  decisions, and excluded list; accept a suggestion and assert the verdict
  lands.

## 12. Post-merge ops

Cameron's to run, per the standing no-infra-without-explicit-ask rule:

1. dev `terraform apply` for the new `ai_runs` table (new table + `byEntity`
   GSI + TTL).
2. prod `terraform apply` at the M1.11 cutover.

Separately, and independent of this feature: `AI_EXTRACTION_ENABLED` is being
flipped to `true` in production.

## 13. Known limitations

- A hand-edit that corrects an auto-applied field is not linked back to the
  run; only the "changed since" comparison in section 7.2 approximates it.
- Aggregate quality statistics are not built, though the data supports them.
- A run whose record fails to write is invisible in the log while the
  extraction itself succeeded. This is the accepted cost of best-effort
  recording; such failures are logged.
- Window previews depend on the underlying messages still existing. A deleted
  message rehydrates as unavailable; the hash and char count still prove what
  was sent.
