# Staff notes on the tenant file and a Past tab on the Tours page - design specification

Status: DRAFT 1 - written for an OVERNIGHT UNATTENDED mission (Cameron 2026-09-26): every product decision below was given in the mission text or is recorded in section 9 as a decision the planner took alone
Date: 2026-09-26
Branch: `feat/staff-notes-past-tours`
Worktree: `W:\tmp\staff-notes-past-tours`
Base: `main` at `0dafe3c12291f60a69cccaf5a8a65bcb8d252452`
Tracker: Sam's improvements list 2026-09-24, items 22 (staff notes) and 18 + 20 (past tours); support work under Amendment No. 2 with Tenant Place LLC
Review records: `docs/superpowers/reviews/2026-09-26-staff-notes-past-tours/`

## 1. Outcome

Two independent parts on one branch. Part 1 is built first.

**Part 1 (item 22).** A tenant's file gets a second notes card, "Staff notes",
directly above the existing "Preferences & notes" card. It is one free-text box
that staff type into by hand: small things that could matter to a tenant. Staff
edit it in place (a textarea with Save and Cancel), and the card shows "Last
edited <date>" once it has ever been saved. The AI never writes into it and
never reads it. The existing "Preferences & notes" card, its copy and its
"+ Add" action are unchanged; the AI keeps appending its dated "[Auto - <date>]"
lines there exactly as today. Partner and landlord files are unchanged.

**Part 2 (items 18 and 20, list half only).** The Tours page gets a third tab,
Past, between Active and Closed, at `/tours/past`. It lists tours from the last
90 days whose scheduled time has passed and that still need a human decision:
tours never marked toured ("Not marked"), toured tours with no outcome recorded
("Needs outcome"), and no-shows ("No show"). Most recent first. A row's
"Mark toured" marks that tour toured; a row's "Record outcome" opens the tour
page's existing outcome dialog; the row itself links to the tour page. Staff can
tick several "Not marked" rows and mark them toured in one go, one PATCH per
tour, with each row reporting its own success or failure. Nothing closes on its
own, no status changes except through these actions, and nothing here sends a
text or reminder. The calendar view (item 18's other half) is not part of this.

Nothing tenant-, landlord- or partner-facing changes in either part. No
message-catalog copy is added.

## 2. Current behavior (verified against `main` @0dafe3c1)

### 2.1 Contact notes

- `ContactItem` (`app/src/repos/contactsRepo.ts:91-292`) declares no `notes`
  field; it is read through the index signature `[key: string]: unknown`
  (line 292). Plain (non-key) attributes may be SET to an empty string
  (lines 505-509); only GSI key attributes refuse `''`.
- `PATCH /api/contacts/:contactId` (`app/src/routes/contacts.ts:1406-1849`)
  validates the body with `parseTriageBody` (lines 503-717), an ALLOWLIST: each
  known key is checked and copied into `patch`, its name pushed onto
  `changedFields`; an unknown key is silently ignored; a body that changes no
  known field is a 400 "patch body must include at least one field" (line 713).
  `notes` is accepted as a string only (lines 568-573); `''` clears it.
- The handler then: pre-reads the contact (line 1419), stamps consent, clears
  `<field>_source` provenance for every changed field in `PROVENANCE` (lines
  1518-1522; `notes` is one of them via `PROVENANCE_FIELDS`, line 102), reads any
  pending AI suggestion per changed field best-effort (lines 1541-1550), writes
  `contacts.update(contactId, patch)` (SET-merge, line 1554), resolves
  suggestions, appends a `contact_updated` audit event carrying `changedFields`
  (line 1800), and responds `{ contact: updated }` (line 1849).
- Manual create `POST /api/contacts` uses `parseCreateBody` (lines 741-830),
  also an allowlist: `notes` is copied when a string (lines 780-783); unknown
  keys are ignored.
- The import (`app/src/lib/import/apply.ts`, `app/src/lib/import/reviewNotes.ts`)
  and the seeds (`app/src/lib/seed/*.ts`) write `notes`. The public sign-up
  (`app/src/routes/public.ts`) does not write notes.
- The AI: `toProfile(contact)` (`app/src/jobs/extraction.ts:131-159`) builds the
  profile the model reconciles against from an explicit field list that includes
  `notes` (lines 152-153) and nothing it does not name. `applyExtraction`
  (`app/src/services/extraction/apply.ts:670-707`) appends `[Auto - <date>]`
  lines to `notes` via `contacts.update(contactId, { notes: nextNotes })`. The
  prompt (`app/src/services/extraction/prompt.ts:97-112`) reasons about "profile
  notes". No other app code reads `contact.notes`.
- Dashboard: `Contact.notes` (`dashboard/src/api/types.ts:2005`),
  `ContactPatch.notes` (line 2098). `TenantFile.tsx:164` trims `contact.notes`
  and lines 247-264 render the "Preferences & notes" card: `NotesText` (a clamped
  paragraph with a Show more toggle, `Card.tsx:262-297`) or the
  `PendingPanel` copy "No preferences yet - added manually for now."; the aside
  "+ Add" (aria-label "Add a note") calls `onEdit`, which opens
  `ContactEditForm` (a modal with a "Notes" textarea, `ContactEditForm.tsx:781-789`;
  `buildPatch` sends only the changed fields, line 251). `ContactDetail.tsx`
  holds the contact in `useContact` and applies the saved contact in place with
  `setContact` (lines 1097-1103). `LandlordFile.tsx`, `PartnerFile.tsx` and
  `UnknownFile.tsx` render `notes` the same way for their kinds.

### 2.2 Tours

- Statuses (`app/src/lib/toursModel.ts:36-43`): requested, scheduled, toured,
  no_show, canceled, closed. Outcomes (lines 66-77): move_forward, not_a_fit.
- `PATCH /api/tours/:tourId` (`app/src/routes/tours.ts:1010-1290`) rejects
  unknown fields (line 1023). Transition guard (lines 1065-1128): closed is
  terminal; nothing moves to requested; requested may only become scheduled,
  toured or canceled; a move to scheduled requires `canReschedule` (requested,
  scheduled, canceled, no_show). There is NO time-based guard: scheduled ->
  toured is legal at any time, and so is no_show -> toured. The exit gate
  `{ outcome, moveForward }` is accepted only on a `toured` tour (409
  `illegal_exit_gate`, lines 1146-1148) and does not change status by itself.
  A status PATCH that is a real transition into canceled, closed, toured or
  no_show is TERMINAL for the reminder ladder (lines 1208-1220): the generation
  pointer rotates and every pending rung is retired; nothing is sent.
- The dashboard exit gate (`TourDetail.tsx:489-520`): not_a_fit also sets
  `status: 'closed'` in the same PATCH; move_forward leaves the tour `toured`
  (with `outcome`, `moveForward`, `convertible: true`) and immediately POSTs
  `/api/placements/from-tour`, which finalizes the tour as `closed` with
  `convertedPlacementId` (`app/src/routes/placements.ts:640,772-773`). So a
  `toured` tour with an outcome recorded and no conversion is reachable only
  when that conversion failed (the tour page's "Start placement" is the retry).
- `GET /api/tours` (`tours.ts:393-429`) has four exclusive modes: `tenantId`,
  `unitId`, `from`+`to` (ISO datetimes, `listByScheduledRange`), or `status`
  (`listByStatus`). `listByScheduledRange` (`toursRepo.ts:347-364`) issues ONE
  Query on the `byScheduledAt` GSI (`BETWEEN :from AND :to`, inclusive) and does
  not follow `LastEvaluatedKey`; `listByStatus` (lines 366-385) paginates. A
  `requested` tour has no `scheduledAt` and is never in the GSI (line 301).
- `POST /api/tours` (lines 290-360) accepts any valid ISO `scheduledAt`,
  including one in the past; the arm (`app/src/jobs/tourReminders.ts:586-589`)
  silently skips a rung whose `dueAt` is already past, and the kinds armed today
  are day_before, morning_of, en_route (line 412; the confirmation kind is
  discontinued, line 312), so a past-scheduled create sends nothing.
- Dashboard: `useTours.ts` fetches `[start-of-today-local, +30 days]` via
  `toursDateRange` (lines 34-41) and filters the window to `status ===
  'scheduled'` on the client (line 70) because the range query returns every
  status; `useClosedTours(enabled)` (lines 111-146) is a lazy fetch of `closed`
  + `canceled` by status, newest `updatedAt` first. `ToursPage.tsx` takes
  `closed?: boolean`, renders the tabs from `VIEW_TABS` (lines 179-182), and
  `App.tsx:237-240` routes `tours` and `tours/closed`. `TourRow` (lines 122-158)
  is a single `<Link>` wrapping identity and meta chips; the row CSS
  (`ToursPage.module.css`) stacks identity over chips below a 560px container
  width.
- `TourDetail.tsx`: the header CTA is "Mark toured" on a scheduled tour (line
  550; it PATCHes `status: 'toured'` and then opens the RecordOutcomeModal
  itself, lines 312-323), and "Record outcome" on a toured tour with no outcome
  (lines 553-556); the modal slot is the `modal` state (line 237). The page
  reads only `useParams` and `useNavigate` from the router (line 26); nothing
  reads the query string.
- Seeds: the lean profile (the e2e world) seeds NO tours. e2e specs create
  tours through `POST /api/tours` with `page.request` after dev-login
  (`e2e/tests/dashboard-next/tours-page.spec.ts:397`).

## 3. Part 1 - staff notes

### 3.1 The field

- `staff_notes?: string` on the contact record. Free text, one value, no dated
  entries, no length cap (parity with `notes`, which has none). `''` clears.
- `staff_notes_updated_at?: string` (ISO 8601). Written by the server on every
  PATCH that carries `staff_notes` (a clear included). Never client-settable: it
  is not in the PATCH allowlist, so a client key of that name is ignored like
  any other unknown key.
- Declared on `ContactItem` next to `park_reason` (they are both plain staff
  text), with a comment that nothing machine-writes either field.
- Neither name goes into `PROVENANCE_FIELDS`; there is no `staff_notes_source`.

### 3.2 PATCH

`parseTriageBody` gains one block, placed directly after the `notes` block:

- `staff_notes` present and a string -> `patch['staff_notes'] = v`,
  `changedFields.push('staff_notes')`.
- `staff_notes` present and not a string -> 400 `staff_notes must be a string`.

The route handler stamps `parsed.patch['staff_notes_updated_at'] = new
Date().toISOString()` whenever `'staff_notes' in parsed.patch`, before the
write. Everything else on the PATCH path is untouched: the audit event's
`changedFields` names `staff_notes`; the provenance loop skips it (not in
`PROVENANCE`); the best-effort suggestion read for a changed field returns
nothing for it.

### 3.3 Create paths never set it

`parseCreateBody` is not changed, so `staff_notes` in a POST body is ignored
like any other unknown key. The import, the seeds and the public sign-up are not
changed and do not write it. A test proves a POST body carrying `staff_notes`
creates a contact without it.

### 3.4 The AI neither reads nor writes it

By construction, not by a new guard: `toProfile` names its fields and
`staff_notes` is not added; `applyExtraction` writes `notes` only. The prompt is
untouched. A test asserts `toProfile` of a contact carrying `staff_notes`
returns a profile without that key, and that an extraction apply that appends a
note line leaves `staff_notes` byte-identical.

One issue is filed: `extraction-prompt-read-staff-notes` (improvement, low) -
have the extraction prompt read staff notes as context, so the model can
reconcile against what staff already know. Not built here.

### 3.5 Dashboard types

`Contact` gains `staff_notes?: string` and `staff_notes_updated_at?: string`;
`ContactPatch` gains `staff_notes?: string`. Both additive.

### 3.6 The "Staff notes" card (tenant files only)

A new component `dashboard/src/routes/contact/StaffNotesCard.tsx`, rendered by
`TenantFile` directly ABOVE the "Preferences & notes" card. It owns its own edit
state and save call; the file pane stays a dumb renderer otherwise.

Props: `contactId`, `value` (the stored `staff_notes` or undefined),
`updatedAt` (the stored `staff_notes_updated_at` or undefined), and
`onContactUpdated?: (updated: Contact) => void`.

Read mode:

- Card title "Staff notes".
- Body: when the trimmed value is non-empty, `NotesText` (the same clamp and
  Show more toggle the notes card uses); when empty, the muted line "No staff
  notes yet." (an `EmptyRow`, NOT a `PendingPanel` - nothing is pending).
- Below the text, when `updatedAt` parses: a muted line "Last edited Sep 26,
  2026" (en-US, month short, day numeric, year numeric - the same formatter
  the Closed tours rows use). Unparseable or absent -> no line.
- Aside action: "Edit" with aria-label "Edit staff notes" when the value is
  non-empty, "+ Add" with aria-label "Add staff notes" when empty. Rendered as a
  `CardAction` only when `onContactUpdated` is provided; otherwise the aside is
  the plain text, mirroring how the other cards degrade without `onEdit`.

Edit mode (entered by the aside action):

- A `<textarea>` labeled "Staff notes" (a visible `<label>`, so
  `getByLabel('Staff notes')` resolves it), prefilled with the stored value,
  `rows={4}`, focused on entry.
- Buttons "Save" and "Cancel" (names exact). Cancel discards the draft and
  returns to read mode with no request. Save with the draft equal to the stored
  value returns to read mode with no request. Otherwise Save calls
  `patchContact(contactId, { staff_notes: draft })`; while in flight both
  buttons are disabled and the textarea is read-only.
- Success: `onContactUpdated(updated)` with the returned contact (which now
  carries the new `staff_notes_updated_at`), then read mode.
- Failure: stay in edit mode with the draft intact and an inline
  `role="alert"` reading "Could not save staff notes. Try again." (the API
  error message appended after a dash when present).

`TenantFile` gains an optional `onContactUpdated` prop and passes it through;
`ContactDetail` passes `setContact` at its tenant-file call site. The "+ Add" on
"Preferences & notes" and `ContactEditForm` are unchanged - the edit dialog does
NOT get a staff-notes field; the card is the one editor.

Copy is staff-facing only (no catalog). Source stays ASCII.

### 3.7 Not changed

- `LandlordFile`, `PartnerFile`, `UnknownFile`: no card. Issue filed:
  `staff-notes-on-landlord-partner-files` (improvement, low) - Sam's ask names
  tenants, but the same small box is plausibly useful on a landlord or partner
  file; decide later.
- Contact lists, the inbox, the timeline, exports: none render `staff_notes`.

## 4. Part 2 - the Past tab

### 4.1 Route and tabs

- `ToursPage`'s `closed?: boolean` prop becomes `view?: 'active' | 'past' |
  'closed'` (default `'active'`). `App.tsx` routes `tours` -> active,
  `tours/past` -> past, `tours/closed` -> closed. `VIEW_TABS` becomes Active
  (`/tours`), Past (`/tours/past`), Closed (`/tours/closed`), in that order; the
  current tab carries `aria-current="page"` as today.
- Heading: "Past tours". Intro line: "Last 90 days: tours that were never
  marked toured, toured tours still waiting on an outcome, and no-shows."
- The "+ New tour" button stays Active-only.

### 4.2 Data

A new lazy hook `usePastTours(enabled)` in `useTours.ts`, shaped like
`useClosedTours` (idle until enabled; `status`, `past: Tour[]`) plus a
`reload()` function the page calls after a bulk action.

- Window (`pastToursDateRange(now)`): `from` = start of today local minus 90
  days; `to` = start of today local minus 1 ms. The 1 ms keeps a tour at exactly
  local midnight today in Active (whose `from` is that same instant) rather
  than in both tabs. Both ends are sent as UTC ISO strings.
- One request: `getTours({ from, to })`.
- Selection (`selectPastTours(tours)`, a pure exported function): keep
  `status` in `PAST_TAB_STATUSES = ['scheduled', 'toured', 'no_show']`; drop
  everything else (canceled and closed belong to Closed; requested never has a
  time and is never returned by this mode anyway); sort by `scheduledAt`
  descending (most recent first), ties by `tourId` for a stable order.
- Statuses are filtered on the CLIENT. Why: the range endpoint already returns
  every status and the Active tab filters it the same way (`useTours.ts:70`); a
  server-side status filter would add a fifth query mode to the route and repo
  for a list that is one org's 90 days of tours. Recorded for the handback.
- Known pre-existing limit, not fixed here: `listByScheduledRange` reads one
  Query page (no `LastEvaluatedKey` follow). Filed as
  `tours-scheduled-range-query-unpaginated` (debt, low); the Active window has
  the same ceiling today.

### 4.3 The row

Each Past row shows, in this order: the scheduled date and time ("Sep 24,
2026, 2:30 PM": the page's existing `formatDate` + `formatTime`, joined with
", "), the tenant, the property, and the state in plain words:

| tour | state chip |
|---|---|
| status `scheduled` | "Not marked" |
| status `toured`, `outcome` absent | "Needs outcome" |
| status `toured`, `outcome` present | the outcome label (`TOUR_OUTCOME_LABELS`: "Move forward" / "Not a fit") |
| status `no_show` | "No show" |

`pastState(tour)` is a pure exported function returning the chip text. The
third case is the only one the mission did not name (section 9, Q3).

Row structure - the whole row is NOT one link any more, because buttons and a
checkbox cannot live inside an `<a>`:

```
<li class=rowItem>
  [checkbox]            only on a "Not marked" row; aria-label "Select tour for <tenant> at <property>"
  <Link to=/tours/:id>  identity (tenant, property) + meta (date-time, state chip);
                        aria-label "Tour for <tenant> at <property>" (same as today)
  <actions>             see 4.4
  <result line>         see 4.5, only after a bulk action touched this row
</li>
```

Tenant and property names resolve from the same live + soft-deleted contact and
unit maps the other tabs use. The tour-type badge is not shown on Past rows
(the mission lists the row's content; the type is on the tour page).

### 4.4 Row actions

- "Not marked" (scheduled): a button "Mark toured" (aria-label "Mark toured:
  <tenant> at <property>", so it never collides with the bulk button). It runs
  the same runner as the bulk action with one id (4.5).
- "Needs outcome" (toured, no outcome): a link "Record outcome" (aria-label
  "Record outcome: <tenant> at <property>") to `/tours/<id>?outcome=1`.
- "No show", and toured-with-outcome: no row action. The tour page holds
  reschedule / check-in / start-placement for those.

### 4.5 Bulk "Mark toured"

A toolbar above the list, Past view only:

- A checkbox "Select all not marked" that checks every "Not marked" row
  currently listed (and unchecks them when cleared). Indeterminate when some
  but not all are selected.
- A button whose text is "Mark toured (N)" with N the number of selected rows;
  disabled at 0 and while a batch is running.

The runner (`markToured(ids)`):

1. Set busy; clear previous results.
2. For each id IN LIST ORDER, ONE AT A TIME: `patchTour(id, { status:
   'toured' })`. Sequential, not `Promise.allSettled`: each PATCH rotates that
   tour's reminder ladder and writes audit and activity rows, and a serial run
   keeps those writes ordered and the per-row result deterministic. Record
   `{ ok: true }` or `{ ok: false, message }` (the `ApiError` message, else
   "Request failed") per id. A failure does not stop the batch.
3. Clear the selection for the ids that succeeded; keep it for the ones that
   failed.
4. `reload()` the list; clear busy.

Per-row result line, rendered under the row until the next batch or a
navigation away: "Marked toured" (`role="status"`, muted) or "Could not mark
toured: <message>" (`role="alert"`). After the reload a succeeded row reads
"Needs outcome" and offers "Record outcome"; a failed row is unchanged and still
"Not marked".

The batch sends only `status: 'toured'`. It never sends an outcome, never
closes a tour, and never touches a tour that is not `scheduled` (the checkbox
exists only on those rows, and the runner refuses an id whose listed status is
not `scheduled`).

### 4.6 The tour page's `?outcome=1` deep link

`TourDetail` reads the query string once the tour has loaded:

- `?outcome=1` and the tour is `toured` with no `outcome` -> `setModal('outcome')`.
- Otherwise -> nothing opens.
- In both cases the param is removed with a `replace` navigation so a reload or
  the back button does not reopen the dialog.

The dialog, its confirm handler and everything after it are the existing code
(4.6 adds one effect and one `useSearchParams`). The Past tab's "Record
outcome" is the only producer of the param.

### 4.7 Invariants

- No tour changes status except through a human clicking "Mark toured" (row or
  bulk) or the existing tour-page flows. The Past tab performs no write on load,
  on select, or on navigation.
- No send: `status: 'toured'` is a terminal ladder transition (retires pending
  rungs, sends nothing), and the tab calls no messaging route. The e2e proves
  the fake Twilio conversation list is unchanged across a bulk mark.
- Nothing closes on its own: the batch never sends `closed` or an outcome.
- Requested tours stay in Active's "Needs booking".

### 4.8 Narrow width

At 360px the row stacks identity over meta (the existing container query), the
checkbox stays leading, and the action wraps under the link. The e2e asserts no
horizontal overflow on `/tours/past` with rows present and on the tenant file
with the Staff notes card in edit mode.

## 5. Testing

Unit, app (`app/test/contactStaffNotes.test.ts`, in-memory harness like
`contactsCrud.test.ts`):

- PATCH `{ staff_notes: 'x' }` -> 200, stored `staff_notes === 'x'`,
  `staff_notes_updated_at` is an ISO string, `notes` untouched, the audit
  `contact_updated` names `staff_notes` in `changedFields`.
- PATCH `{ staff_notes: '' }` clears and re-stamps `staff_notes_updated_at`.
- PATCH `{ staff_notes: 5 }` -> 400 `staff_notes must be a string`.
- PATCH `{ staff_notes_updated_at: '2020-01-01T00:00:00.000Z' }` alone -> 400
  (no known field changed); alongside `staff_notes` it is ignored and the server
  stamp wins.
- POST `/api/contacts` with `staff_notes` in the body -> created contact has no
  `staff_notes`.
- `toProfile({ ..., staff_notes: 'x' })` has no `staff_notes` key.
- An extraction apply that appends a note line leaves `staff_notes` unchanged.

Unit, dashboard:

- `useTours.test.ts`: `pastToursDateRange` (from = start of today minus 90
  days; to = start of today minus 1 ms); `selectPastTours` keeps only
  scheduled/toured/no_show and sorts most recent first; `pastState` for the
  four cases; `usePastTours` idle until enabled, fetches with the window,
  `reload()` refetches.
- `ToursPage.test.tsx`: the three tabs with Past current on `/tours/past`; the
  Past rows (date-time, tenant, property, chip) and their actions (Mark toured
  button on Not marked; Record outcome link to `/tours/<id>?outcome=1` on Needs
  outcome; none on No show); select-all + bulk button count; the batch calls
  `patchTour` once per selected id, sequentially, and renders per-row success
  and failure lines, then reloads; the existing Active and Closed tests still
  pass under the `view` prop.
- `TourDetail.test.tsx`: `?outcome=1` on a toured-no-outcome tour opens the
  Record outcome dialog and strips the param; on a scheduled tour it opens
  nothing.
- `StaffNotesCard.test.tsx`: empty and filled read modes, the "Last edited"
  line, Edit -> textarea prefilled -> Save calls `patchContact` with
  `{ staff_notes }` and hands the returned contact up; Cancel discards without a
  request; unchanged Save sends no request; a failed save keeps the draft and
  shows the alert; no action without `onContactUpdated`.
- `TenantFile`: the Staff notes card renders above Preferences & notes.

Playwright (hermetic lane only):

- `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts`: on the seeded tenant
  (contact-tenant-0001), "+ Add" -> type into "Staff notes" -> Save -> the text
  shows with a "Last edited" line -> reload -> still there; the "Preferences &
  notes" card still shows its empty copy; Edit -> clear -> Save (cleanup); at
  360px the card in edit mode has no horizontal overflow.
- `e2e/tests/dashboard-next/tours-past.spec.ts`: after a reseed, create three
  tours via `POST /api/tours` for the seeded tenant and unit with `scheduledAt`
  one, two and three days in the past (10:00 local); PATCH the second to
  `toured` and the third to `no_show` via the API; `/tours/past` lists exactly
  those three with "Not marked", "Needs outcome", "No show", most recent first;
  none of them is in Active; tick the "Not marked" row, "Mark toured (1)" ->
  the row reads "Needs outcome" with "Record outcome"; that link lands on the
  tour page with the "Record outcome" dialog open; the fake Twilio conversation
  list is unchanged by the batch; at 360px no horizontal overflow.

Gates: the five in AGENTS.md, bare, from the worktree.

## 6. Non-goals

- The Tours calendar view.
- Bulk close, bulk outcome, or any automatic close.
- Staff notes on landlord, partner or unknown files (issue filed).
- The AI reading staff notes (issue filed).
- A server-side status filter on the range query; paginating that query (issue
  filed).
- Any change to the extraction prompt, the message catalog, the import, the
  seeds' contacts, or the public sign-up.

## 7. Files touched

App: `app/src/routes/contacts.ts`, `app/src/repos/contactsRepo.ts` (type
only), `app/test/contactStaffNotes.test.ts` (new).

Dashboard: `dashboard/src/api/types.ts` (additive), `dashboard/src/App.tsx`,
`dashboard/src/routes/contact/StaffNotesCard.tsx` (+ test, + module CSS if the
existing Card styles do not cover the textarea), `TenantFile.tsx`,
`ContactDetail.tsx` (one prop), `dashboard/src/routes/tours/useTours.ts` (+
test), `ToursPage.tsx` (+ test, + module CSS), `TourDetail.tsx` (+ test).

E2E: two new specs under `e2e/tests/dashboard-next/`.

Issues: three new files under `docs/issues/`.

Off limits (other missions own them tonight): `app/src/routes/webhooks/voice.ts`,
`app/src/routes/settings.ts`, `app/src/repos/settingsRepo.ts`,
`app/src/routes/mmsMedia.ts`, `app/src/adapters/mediaStore.ts`,
`dashboard/src/routes/settings/**`, `app/src/adapters/messaging.ts`,
`app/src/services/sendMessage.ts`, `app/src/jobs/broadcastFanOut.ts`,
`app/src/jobs/relayFanOut.ts`, `app/src/jobs/relayRetryLeg.ts`,
`app/src/jobs/retrySend.ts`, `app/src/repos/messagesRepo.ts`,
`app/src/repos/broadcastsRepo.ts`, `dashboard/src/routes/contact/deliveryStatus.ts`,
`dashboard/src/routes/contact/relayRetryJoin.ts`, `dashboard/src/routes/broadcasts/**`,
the broadcast seed fixtures. `dashboard/src/api/types.ts`, `client.ts`,
`endpoints.ts`: additive edits only.

## 8. Issues filed by this mission

- `extraction-prompt-read-staff-notes` - improvement, low.
- `staff-notes-on-landlord-partner-files` - improvement, low.
- `tours-scheduled-range-query-unpaginated` - debt, low, pre-existing.

## 9. Decisions the planner took alone (would have asked)

- Q1 `staff_notes` has no length cap. Parity with `notes`; a cap is a product
  call. A 400 KB DynamoDB item is the only hard ceiling.
- Q2 The edit dialog (`ContactEditForm`) does not get a staff-notes field. The
  mission says inline edit; two editors for one field invite drift.
- Q3 A `toured` tour WITH an outcome but no conversion (a failed conversion, per
  2.2) is listed in Past with its outcome label and no row action, because its
  status is `toured` and it is a past tour Sam may want to see. Hiding it would
  make a stuck conversion invisible from the list.
- Q4 A no-show row has no row action. Reschedule and the check-in text live on
  the tour page, and the mission named only "Mark toured" and "Record outcome".
- Q5 The bulk runner is sequential, not parallel (4.5).
- Q6 Past rows drop the tour-type badge (4.3).
- Q7 The Past window's `to` is start-of-today minus 1 ms (4.2).
- Q8 The e2e creates past-dated tours through the API rather than adding tours
  to the lean seed: the lean world is byte-stable and tour-free, every existing
  tours spec creates its own tours the same way, and a past-dated create arms
  nothing (2.2).
