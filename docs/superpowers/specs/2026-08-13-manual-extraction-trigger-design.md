# Manual Extraction Trigger - Design and Scope

- Date: 2026-08-13
- Status: Ready for human review (revised after spec review round 1)
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
| `app/src/routes/dev.ts:758` | `voice` | dev transcript fixture (hermetic only) |

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
with the result recorded in the AI run log and any suggestions appearing on the
page without a reload.

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
4. **Arm the existing poll; do not run synchronously.** The endpoint schedules
   and returns. No model call happens inside an HTTP request.
5. **Single contact per press. No bulk backfill.** Separate work; see section 9.
6. **Permanent dismissal tombstones still apply.** A manual re-run will not
   re-suggest a dismissed value; it records `dismissed_before` instead.
7. **No new role.** Any authenticated staff user may press it, the same bar as
   accepting a suggestion or triaging a contact.

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
- **`fail` re-sets it** when re-arming a run that was manual, so backoff retries
  stay manual. This requires `fail` to take the manual-ness of the run that just
  failed; the job knows it.
- `complete` does not touch it - `claim` already cleared it.

### 4.2 Two gate changes in the job, both scoped to `manual`

The job computes `const manual = row.manualRequested === true` and keys
everything off that, never off `channel`. In `app/src/jobs/extraction.ts`:

1. **Age.** The cutoff at line 433-436 is skipped when `manual`: `fresh` becomes
   the whole fetched page and `agedOutTsMsgIds` is empty.
2. **Freshness.** `hasNewClient` (line 449) is true when `manual`, joining the
   existing `voice` and `triage` bypasses - an established pattern, since both
   already bypass this gate because their signal is content the cursor cannot
   see.

Because the age waiver alone would leave the freshness gate reading a now
non-empty `fresh`, either change alone would still skip most target
conversations. They ship together.

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

`channel` being optional means the draft needs a defined fallback for a
manual-only row: when the flag is absent and `channel` is too, the row was not
scheduled by any known path, and the trigger falls back to the row's channel
being absent - the builder must pick one explicit behavior here and test it
rather than let `undefined` reach the record.

The dashboard's `AiRunTrigger` union gains `'manual'`. **No other run-log change
is needed:** `AiRunList.tsx:55` and `AiRunDetail.tsx:50` render `trigger` as
free text and there is no trigger filter UI to extend. Together with 4.3, the
dashboard type file is the only run-log-side edit.

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
   so does this one. The kept types match what the automatic sites schedule.
4. `requestManualExtraction(conversationId, nowIso)` for each surviving thread,
   with no debounce - `dueAt = now`, as the voice and triage paths do.
5. `audit.append('contacts#<contactId>', 'extraction_run_requested', { actor })`.
6. Respond `200 { scheduled: number, conversationIds: string[] }`.

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
| `config.aiExtractionEnabled` is false | 409 | `extraction_disabled` |
| Contact type is `landlord`, `partner`, or `team_member` | 409 | `ineligible_contact_type` |
| `contactId` starts with `PHONE_REF_PREFIX` | 409 | `not_a_contact` |
| No conversations survive the type filter | 409 | `no_conversations` |

The type refusal mirrors the job's eligibility rule
(`app/src/jobs/extraction.ts:401-406`); the phone-ref refusal mirrors its
`no_contact` branch (`app/src/jobs/extraction.ts:392`). Queuing a row guaranteed
to skip would burn a poll cycle and write a misleading `skipped` record.
Eligible types are `tenant` and `unknown`.

Unlike the triage hook, a scheduling failure here is **not** best-effort:
scheduling is the entire point of the request, so a repo error is a 500 and the
UI reports that nothing was queued.

### 4.6 The UI

The action goes in the contact header's `ContactActionsMenu`
(`dashboard/src/routes/contact/ContactActionsMenu.tsx`), the existing home for
per-contact actions. There is no "AI suggestions area" to sit beside -
`SuggestionChip` renders inline per field.

Label: "Run AI extraction". **The server is the only gate.** The action is
always enabled; on a 409 the UI renders the returned reason inline. The contact
page does not hold `aiExtractionEnabled` - it is a server-side router dependency
at `app/src/routes/api.ts:740` and is exposed to clients only by
`GET /api/system/flags` (`app/src/routes/system.ts:47`) - so a client-side
precondition would mean fetching a new flag and maintaining a second copy of a
rule the server already enforces.

On success: a transient confirmation naming the count when more than one thread
was queued ("Extraction queued for 2 threads").

**What the operator will and will not see.** Suggestions and auto-applied writes
appear with no reload over the existing SSE path, proven end to end:
`apply.ts:658` emits `suggestion.updated`, the worker's event bridge crosses it
to the app, `api.ts:2098` writes it to the stream,
`EventStreamProvider.tsx:208` dispatches it, and
`dashboard/src/routes/contact/useSuggestions.ts:72-76` refetches when the event
names this contact. `e2e/tests/flows/event-bridge.spec.ts:193` asserts a chip
appearing with no reload and no tick.

But that emit fires **only when something changed**. A run that ends `no_op`,
`skipped`, or `failed` produces no page-level signal whatsoever, and the page
will look identical to one where nothing ran. The confirmation copy therefore
points at Settings > AI runs as the place the outcome is recorded, and promises
only that the run was queued. A per-contact run-status surface would close this
properly and is deferred (section 9).

This also depends on `EVENT_BRIDGE_URL` being set, since the run executes in the
worker while SSE clients are on the app. It is set in all deployed environments
and the local runners; unset, suggestions appear on the next fetch instead -
degraded, not broken.

### 4.7 What does not change

- Claim, backoff, `MAX_EXTRACTION_ATTEMPTS` parking, per-row failure routing.
- `applyExtraction` and every guard in it, including dismissal tombstones and
  the `wrong_contact_type` drops.
- The run recorder's best-effort contract.
- The 30-day cutoff for `sms`, `email`, `voice`, and `triage` runs.
- `scheduleExtraction`'s signature and its channel union.
- The dev tick, which drains manual rows exactly as it drains any other.

### 4.8 Surfaces touched

- `app/src/repos/extractionRepo.ts` - `DueExtractionItem` (`manualRequested`,
  `channel` optional, and its now-stale channel doc comment), the
  `ExtractionRepo` interface, `requestManualExtraction`, `claim`, `fail`.
- `app/src/jobs/extraction.ts` - `manual` derivation, both gates, `newRunDraft`,
  the effective age value passed to the window builder.
- `app/src/services/extraction/runWindow.ts` and `runTypes.ts` - the nullable
  age param.
- `app/src/repos/aiRunsRepo.ts` - `RunTrigger`.
- `app/src/routes/contacts.ts` - the endpoint.
- `dashboard/src/api/types.ts` - `AiRunTrigger`, `windowParams`.
- `dashboard/src/routes/contact/ContactActionsMenu.tsx` and its API client.
- `app/test/helpers/twilioWebhookHarness.ts:2886` - the extraction repo fake
  must implement the new method or the harness stops type-checking.

## 5. Concurrency and repeat presses

- **Two presses in quick succession** slide the single due row forward; one run
  happens. Existing debounce behavior, correct here.
- **A press while a run is in flight** re-arms `dueAt` and writes a fresh
  `manualRequested` on the row the poll already claimed. Because `claim` cleared
  the flag rather than `complete`, the finishing run cannot wipe it: a second,
  still-manual run follows.
- **An inbound message between press and claim** slides `dueAt` and may
  overwrite `channel`, but cannot clear `manualRequested`, so the run stays
  manual.
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
- `trigger` is recorded as `manual` from the flag, and an automatic run over a
  row whose `channel` is absent records a defined trigger (4.4).
- `windowParams.maxTranscriptAgeDays` is `null` on a manual run, `30` otherwise.
- `requestManualExtraction` sets the flag and leaves `channel` untouched;
  `scheduleExtraction` never sets the flag; `claim` removes it; `fail` re-sets
  it for a manual run and does not for an automatic one; a press during a
  claimed run survives that run's `complete` (the F1 regression test).
- Route: fan-out covers phone and email threads and EXCLUDES `relay_group` and
  `landlord_1to1`; each of the four refusals returns its status and reason; a
  repo failure is a 500; the audit entry is appended.

Dashboard:

- The menu action calls the endpoint and shows its confirmation.
- A 409 renders the returned reason.

E2E (`e2e/`, accessibility-first selectors):

- **Use the existing lean fixture.** `app/src/lib/seed/lean.ts:17-29` already
  seeds messages at fixed `2026-06-01` timestamps, which are more than 30 days
  old against the current clock - the aged-history case exists without adding
  seed rows, which also protects lean's byte stability.
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
- **A stale flag on a parked row.** After five consecutive failures the row
  parks. Because `claim` clears the flag and `fail` re-sets it only for manual
  runs, a parked manual row carries the flag into whatever schedules it next -
  one run with two gates waived. Not a data-integrity problem, and clearing it
  on park would silently downgrade the retry the operator asked for.

## 9. Out of scope

- **Bulk backfill over the imported population.** Deferred by the human: run the
  action on a handful of imported conversations and judge the output before
  firing hundreds of real model calls. Section 8's truncation limit means a
  backfill needs its own windowing design, not a loop over this endpoint. File
  in `docs/issues/` when this lands.
- **A per-contact "last AI run" status surface.** Would close the `no_op` /
  `skipped` / `failed` invisibility in 4.6. New UI beyond the approved scope;
  file alongside the backfill.
- **Rendering `windowParams` in the run detail.** Nothing renders it today
  (4.3); making the stored record truthful does not require building a viewer.
- **Backward pagination of the transcript window.**
- **Ignoring dismissal tombstones on a manual run.** Locked decision 6.
- **A configurable window horizon.** Rejected in brainstorming: the only value
  anyone would set is "all of it", which is what a manual run now does.
- **Making the importer schedule extraction at import time.** A larger change to
  the import path with its own cost profile.
