# Manual Extraction Trigger - Design and Scope

- Date: 2026-08-13
- Status: Ready for human review
- Owner: Cameron Abt
- Branch: `feat/manual-extraction-trigger`

## 1. Problem

AI conversation-fact extraction only ever runs because something inbound
scheduled it. Every call site of `extractionRepo.scheduleExtraction` is a
reaction to traffic or a triage flip:

| Site | Channel | Trigger |
| --- | --- | --- |
| `app/src/routes/webhooks/twilio.ts:2160` | `sms` | inbound text |
| `app/src/services/inboundEmail.ts:748` | `email` | inbound email |
| `app/src/services/voiceTranscripts.ts:212` | `voice` | completed call transcript |
| `app/src/routes/contacts.ts:1605` | `triage` | human flips a contact to tenant |

There is no way for a human to say "extract this contact's facts now". The only
existing manual seam, `POST /__dev/extraction/tick` (`app/src/routes/dev.ts:642`),
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
   (`app/src/jobs/extraction.ts:433-435`) before building the window.

So the facts in imported history have never been extracted and, under today's
rules, never will be.

### 1.2 The gate that actually blocks it

It is tempting to assume the blocking gate is `no_new_client`. It is not. For an
imported conversation the cursor is absent, so `cursor = ''` and
`hasNewClient` at `app/src/jobs/extraction.ts:449-451` is already true for any
inbound message. The gate that fires is `empty_window`
(`app/src/jobs/extraction.ts:458-463`), because the 30-day cutoff removed every
message first. A manual trigger that waived only the freshness gate would
produce `skipped / empty_window` run records on exactly the conversations this
feature exists to serve.

Both gates are therefore in scope.

## 2. Goal

A staff user can open a contact, press one button, and have the extraction
layer run over that contact's full stored conversation history - including
imported history of any age - with the result visible on the same page and a
first-class record in the AI run log.

## 3. Locked decisions

These were settled in brainstorming and are not open in review:

1. **Surface: the contact page.** One button, per contact. Not Settings, not
   API-only.
2. **Waive `no_new_client`.** A manual run always reaches the model when there
   is content to send.
3. **Keep `no_contact`, `ineligible_type`, and `empty_window`.** These mean
   there is genuinely nothing to send or nowhere to write it.
4. **Waive the 30-day age cutoff for manual runs only.** Automatic runs keep it;
   it exists so routine polls do not re-bill ancient history on every inbound
   text. The newest-50 (`MAX_TRANSCRIPT_MESSAGES`) and 60k-char
   (`WINDOW_CHAR_BUDGET`) caps still bound every manual run.
5. **Arm the existing poll; do not run synchronously.** The endpoint schedules
   and returns. No model call happens inside an HTTP request.
6. **Single contact per press. No bulk backfill.** A backfill over the imported
   population is separate work; see section 9.
7. **Permanent dismissal tombstones still apply.** A manual re-run will not
   re-suggest a value the human dismissed; it records `dismissed_before` in the
   run's decisions instead.
8. **No new role.** Any authenticated staff user may press it, the same bar as
   accepting a suggestion or triaging a contact.

## 4. Design

### 4.1 A sticky `manualRequested` flag on the due row

The due row (`due#<conversationId>`) gains one sparse attribute:

```
manualRequested?: true
```

`scheduleExtraction` gains `'manual'` in its channel union. A call with channel
`'manual'` sets `channel = 'manual'` AND `manualRequested = true`. Calls with
any other channel set `channel` as they do today and **never touch
`manualRequested`**.

**Why a flag and not just the channel value.** `scheduleExtraction` is a sliding
upsert: the last writer wins on `channel`. If a tenant replies in the window
between a manual press and the poll claiming the row - up to the 60s poll
interval plus debounce - the row's channel flips to `sms`, the gate waivers are
lost, and the run silently falls back to the 30-day window. For an imported
conversation that means the history is dropped and the operator believes it was
extracted. A sticky flag cannot be erased by a later inbound message.

The job reads `const manual = row.manualRequested === true` and keys everything
off that, never off `channel`. `channel` remains "what most recently scheduled
this row", which is still the useful thing to store.

Lifecycle:

- `scheduleExtraction(id, 'manual', now)` sets it.
- `claim` does not touch it - the job reads the row `listDue` returned, and a
  claim that loses never runs.
- `complete` REMOVEs it, alongside the existing `claimedAt`/`attempts`/
  `lastError` clears. This is the only clearing site.
- `fail` leaves it set, so the backoff retries of a failed manual run stay
  manual. A parked row keeps a harmless flag that the next schedule reuses.

### 4.2 Two gate changes in the job, both scoped to `manual`

In `app/src/jobs/extraction.ts`:

1. **Freshness.** `hasNewClient` (line 449) becomes true when `manual` is set,
   joining the existing `voice` and `triage` bypasses. This is an established
   pattern, not a new one: both of those channels already bypass this gate
   because their signal is content the cursor cannot see.
2. **Age.** The cutoff at line 433 is skipped when `manual` is set: `fresh`
   becomes the whole fetched page and `agedOutTsMsgIds` is empty. Nothing else
   about window assembly changes - the per-message tier caps, the 60k budget,
   the newest-first fill, and the `group_ambiguous_origin` filter all behave
   exactly as they do for an automatic run.

For a never-extracted imported conversation `cursor` is `''`, so every message
falls in the `new` tier and takes the 30k per-message cap, bounded by the 60k
window budget. Worst-case manual run input is unchanged from the existing
worst case.

### 4.3 The run record must not lie about the window

`app/src/services/extraction/runWindow.ts:113` stamps
`windowParams.maxTranscriptAgeDays` from the module constant. A manual run that
waived the cutoff would report `30`, and the run-detail view would describe a
window that was never sent.

`RunWindowParams.maxTranscriptAgeDays` becomes `number | null`, where `null`
means "no age floor was applied". `buildFullRunWindow` takes the effective value
from its caller rather than reading the constant. The run-detail view renders
`null` as an explicit "no age limit (manual run)" rather than blank.

This is additive on new rows only. Every existing stored run has a number and
keeps rendering as it does today; no migration.

### 4.4 The trigger recorded in the run log

`RunTrigger` gains `'manual'`. The job records
`trigger: manual ? 'manual' : row.channel`, so the flag - not the possibly
overwritten channel - decides the label, keeping the record consistent with the
gates that actually ran.

The dashboard's `AiRunTrigger` union in `dashboard/src/api/types.ts` gains
`'manual'` to match. **No other run-log change is needed:** `AiRunList.tsx:55`
and `AiRunDetail.tsx:50` render `trigger` as free text, and there is no trigger
filter UI to extend.

### 4.5 `POST /api/contacts/:contactId/extraction-run`

Mounted in `app/src/routes/contacts.ts` alongside the other per-contact actions.

Behavior on success:

1. Load the contact; 404 if absent.
2. Resolve its 1:1 threads with `conversationsForContact`
   (`app/src/lib/contactThreads.ts:38`), which unions phone and email
   participants and dedupes by `conversationId`. A contact with an SMS thread
   and an email thread gets one run per thread, each with its own window and its
   own run-log row.
3. `scheduleExtraction(conversationId, 'manual', nowIso)` for each, with no
   debounce - `dueAt = now`, exactly as the voice and triage paths do.
4. `audit.append('contacts#<contactId>', 'extraction_run_requested', { actor })`.
5. Respond `200 { scheduled: number, conversationIds: string[] }`.

This is deliberately the same shape as the triage re-extraction hook at
`app/src/routes/contacts.ts:1601-1613`, which already fans a per-contact action
across a contact's linked threads on a gate-bypassing channel.

Refusals, each with a distinct machine-readable reason so the button can explain
itself:

| Condition | Status | Reason |
| --- | --- | --- |
| `config.aiExtractionEnabled` is false | 409 | `extraction_disabled` |
| Contact type is `landlord`, `partner`, or `team_member` | 409 | `ineligible_contact_type` |
| Contact has no 1:1 conversations | 409 | `no_conversations` |

The type refusal mirrors the job's own eligibility rule
(`app/src/jobs/extraction.ts:401-406`) and the triage hook's reasoning: queuing
a row that is guaranteed to skip would burn a poll cycle and write a misleading
`skipped` record. Refusing at the edge is both cheaper and more honest. Eligible
types are `tenant` and `unknown`.

Unlike the triage hook, a `scheduleExtraction` failure here is **not**
best-effort: scheduling is the entire point of the request, so a repo error is a
500 and the button reports that nothing was queued.

### 4.6 The button

On the contact page, adjacent to the AI suggestions area. Label: "Run AI
extraction". On success it shows a transient confirmation naming the count when
more than one thread was queued ("Extraction queued for 2 threads"), and states
that results appear shortly.

Disabled with an inline explanation for each of the three refusal conditions,
evaluated client-side from data the page already holds where possible
(`aiExtractionEnabled` is already exposed on the config payload at
`app/src/routes/api.ts:740`; contact type is on the contact). The server still
enforces all three - the client-side disable is an affordance, not the gate.

Results arrive with no reload over the existing SSE path, which is already
proven end to end: `apply.ts:658` emits `suggestion.updated`, the worker's event
bridge crosses it to the app, `api.ts:2098` writes it to the stream,
`EventStreamProvider.tsx:208` dispatches it, and
`dashboard/src/routes/contact/useSuggestions.ts:72-76` refetches when the event
names this contact. `e2e/tests/flows/event-bridge.spec.ts:193` asserts a chip
appearing with no reload and no tick.

This depends on `EVENT_BRIDGE_URL` being set, since the run executes in the
worker process while the SSE clients are on the app. It is set in all deployed
environments and the local runners. If it were unset, suggestions would appear
on the next fetch instead - degraded, not broken. The button's copy promises
"shortly", never "instantly", so it stays honest in both cases.

### 4.7 What does not change

- Claim, backoff, `MAX_EXTRACTION_ATTEMPTS` parking, and the per-row failure
  routing.
- `applyExtraction` and every guard in it, including dismissal tombstones and
  the `wrong_contact_type` drops.
- The run recorder's best-effort contract.
- The 30-day cutoff for `sms`, `email`, `voice`, and `triage` runs.
- The dev tick, which drains manual rows exactly as it drains any other.

## 5. Concurrency and repeat presses

- **Two presses in quick succession** slide the single due row forward; the
  first claim to see the later `dueAt` wins and one run happens. This is the
  existing debounce behavior and is correct here.
- **A press while a run is in flight** creates a fresh `dueAt` on the row the
  poll already claimed, so a second run follows. Intended: the operator asked
  again.
- **An inbound message between press and claim** slides `dueAt` and overwrites
  `channel`, but cannot clear `manualRequested` (section 4.1), so the run stays
  manual.
- **A manual press on a row already scheduled by another channel** overwrites
  `channel` to `manual` and sets the flag. The resulting run waives more gates
  than the original schedule would have, which is a superset and harmless.

No rate limiting. It is a human-speed button, each press costs one model call
per thread, and the sliding upsert already collapses bursts.

## 6. Cost

One manual run per thread per press, bounded by the same newest-50 and 60k-char
caps as any other run - a worst-case input of roughly 15k tokens per the note at
`app/src/jobs/extraction.ts:56-62`. Waiving the age cutoff does not raise the
ceiling; it changes which messages fill the same fixed budget.

## 7. Testing

Unit:

- The job waives `no_new_client` when `manualRequested` is set, and does not
  when it is absent.
- The job waives the age cutoff when the flag is set: a conversation whose
  messages are all older than 30 days produces a non-empty window and reaches
  the driver, instead of skipping `empty_window`.
- An automatic run over the same fixture still skips `empty_window`.
- `trigger` is recorded as `manual` even when `channel` was overwritten to
  `sms` after the manual schedule.
- `windowParams.maxTranscriptAgeDays` is `null` on a manual run and `30` on an
  automatic one.
- `scheduleExtraction` sets the flag for `manual` and leaves it untouched for
  other channels; `complete` removes it; `fail` retains it.
- Route: success fans out across phone and email threads; each of the three
  refusals returns its status and reason; a repo failure is a 500; the audit
  entry is appended.

Dashboard:

- The button renders, calls the endpoint, and shows its confirmation.
- Each disabled state renders its explanation.

E2E (`e2e/`, accessibility-first selectors):

- Seed a contact whose only messages are older than 30 days, press the button,
  drive `POST /__dev/extraction/tick`, and assert a `trigger: manual` row in
  Settings > AI runs whose outcome is not `skipped`.
- Assert a suggestion chip appears on the contact page without a reload.

## 8. Risks

- **Cost of an unbounded press habit.** Mitigated by the caps in section 6 and
  by the button being per contact; a bulk pass is deliberately out of scope.
- **A manual run writes to a real contact record.** It uses the same apply
  guards as every automatic run, so the blast radius is identical to what the
  system already does on its own. The mitigation is that section 9's backfill
  stays a separate, deliberate decision.
- **A stale `manualRequested` on a parked row.** After five consecutive
  failures the row parks with the flag still set. The next schedule of any
  channel therefore inherits manual semantics for one run. This is a waiver of
  two gates on a single run, not a data-integrity problem, and the alternative
  (clearing on park) would silently downgrade the retry the operator asked for.

## 9. Out of scope

- **Bulk backfill over the imported population.** Explicitly deferred by the
  human: run the button on a handful of imported conversations first and judge
  the output before firing hundreds of real model calls. To be filed in
  `docs/issues/` as a follow-up when this lands.
- **Ignoring dismissal tombstones on a manual run.** Locked decision 7.
- **A configurable window horizon.** Rejected in brainstorming: the only value
  anyone would set is "all of it", which is what a manual run now does.
- **Making the importer schedule extraction at import time.** A larger change to
  the import path with its own cost profile; the button plus a future backfill
  covers the same ground under human control.
