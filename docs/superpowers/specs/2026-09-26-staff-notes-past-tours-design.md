# Staff notes on the tenant file and a Past tab on the Tours page - design specification

Status: DRAFT 4 + AMENDMENTS 3.9 (stale-save guard) and 4.2a (undated toured tours), 2026-09-27, Cameron - APPROVED FOR BUILD by the planner after spec review rounds 1-3 (round 3 changed no decision; adjudications in `docs/superpowers/reviews/2026-09-26-staff-notes-past-tours/spec-r1-adjudications.md`, `spec-r2-adjudications.md`, `spec-r3-adjudications.md`); written for an OVERNIGHT UNATTENDED mission (Cameron 2026-09-26): every product decision below was given in the mission text or is recorded in section 9 as a decision the planner took alone
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
edited <date>" while it holds text. The AI never writes into it and never
reads it. The existing "Preferences & notes" card, its copy and its "+ Add"
action are unchanged; the AI keeps appending its dated "[Auto - <date>]" lines
there exactly as today. Partner, landlord, unknown and team-member files are
unchanged.

**Part 2 (items 18 and 20, list half only).** The Tours page gets a third tab,
Past, between Active and Closed, at `/tours/past`. It lists, from the last 90
days through the end of today, the tours that still need a human decision:
tours whose time has passed and were never marked toured ("Not marked"),
toured tours with no outcome recorded ("Needs outcome"), toured tours whose
move-forward decision never became a placement ("Needs placement"), and
no-shows ("No show"). Most recent first. A tour dated today that is still
scheduled stays on Active's Today group until midnight and is not repeated
here; one dated today that has been marked toured or no-show is here, not on
Active. A row's "Mark toured" marks that tour toured; a row's "Record
outcome" opens the tour page's existing outcome dialog; the row itself links
to the tour page, and the tour page's back arrow returns to Past. Staff can
tick several "Not marked" rows and mark them toured in one go, one PATCH per
tour, each tour re-read just before its PATCH so a tour a colleague has since
canceled, marked no-show or rescheduled is skipped and says so. Nothing closes on its own, no status
changes except through these actions, and nothing here sends a text or
reminder. The calendar view (item 18's other half) is not part of this.

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
  known field is a 400 `no updatable fields supplied` (line 714). `notes` is
  accepted as a string only (lines 568-573); `''` clears it. The JSON body
  parser is `express.json()` with its default 100 KB limit (`app/src/app.ts:136`).
- The handler then: pre-reads the contact (line 1419), stamps consent, clears
  `<field>_source` provenance for every changed field in `PROVENANCE` (lines
  1518-1522; `notes` is one of them via `PROVENANCE_FIELDS`, line 102), reads any
  pending AI suggestion per changed field best-effort (lines 1541-1550), writes
  `contacts.update(contactId, patch)` (SET-merge returning the whole item, line
  1554), resolves suggestions, appends a `contact_updated` audit event whose
  payload carries the changed field names as `fields` (line 1800), and responds
  `{ contact: updated }` (line 1849). `GET /api/contacts/:id` returns the whole
  stored item (lines 1115-1117), so any new attribute round-trips on a reload.
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
  lines to `notes` via `contacts.update(contactId, { notes: nextNotes })` - a
  read-modify-write whose lost-update race is accepted in its own comment (lines
  686-690). The prompt (`app/src/services/extraction/prompt.ts:97-112`) reasons
  about "profile notes". No other app code reads `contact.notes`.
- Dashboard: `Contact.notes` (`dashboard/src/api/types.ts:2005`),
  `ContactPatch.notes` (line 2098); the PATCH client is `updateContact`
  (`dashboard/src/api/endpoints.ts:1443`). `TenantFile.tsx:164` trims
  `contact.notes` and lines 247-264 render the "Preferences & notes" card:
  `NotesText` (a clamped paragraph with a Show more toggle, `Card.tsx:262-297`)
  or the `PendingPanel` copy "No preferences yet <em dash> added manually for
  now." (the code holds a U+2014 there, `TenantFile.tsx:262`); the aside "+
  Add" (aria-label "Add a note") calls `onEdit`, which opens `ContactEditForm`
  (a modal with a "Notes" textarea, `ContactEditForm.tsx:781-789`; `buildPatch`
  sends only the changed fields, line 251). `ContactDetail.tsx` holds the
  contact in `useContact` and applies the saved contact in place with
  `setContact` (lines 1097-1103). `ContactDetail` maps every type that is not
  landlord, partner or unknown - i.e. tenant AND `team_member` - to `TenantFile`
  (lines 551-558). `LandlordFile.tsx`, `PartnerFile.tsx` and `UnknownFile.tsx`
  render `notes` the same way for their kinds.
- `documentation/GLOSSARY.md:141-145` describes Unit `notes` as "free-form
  INTERNAL staff notes on a property (the contact `notes` counterpart)" - the
  vocabulary currently equates contact `notes` with staff notes.
- The existing e2e `e2e/tests/dashboard-next/contact-detail.spec.ts` edits the
  seeded tenant's `notes` through the Edit dialog with PAGE-wide, non-exact
  `page.getByLabel('Notes')` locators (lines 59 and 73). Playwright's
  `getByLabel` matches `aria-label` too, as a case-insensitive substring, so any
  new control on that page whose accessible name contains "notes" makes those
  two locators ambiguous.

### 2.2 Tours

- Statuses (`app/src/lib/toursModel.ts:36-43`): requested, scheduled, toured,
  no_show, canceled, closed. Outcomes (lines 66-77): move_forward, not_a_fit.
- `PATCH /api/tours/:tourId` (`app/src/routes/tours.ts:1010-1290`) rejects
  unknown fields (line 1023). Transition guard (lines 1065-1128): closed is
  terminal; nothing moves to requested; requested may only become scheduled,
  toured or canceled; a move to scheduled requires `canReschedule` (requested,
  scheduled, canceled, no_show). There is NO time-based guard and NO
  expected-status precondition: scheduled -> toured is legal at any time, and
  so are no_show -> toured and canceled -> toured. A transition INTO toured
  records a "Tour took place" milestone on the tenant timeline (line 1425). The
  exit gate `{ outcome, moveForward }` is accepted only on a `toured` tour (409
  `illegal_exit_gate`, lines 1146-1148) and does not change status by itself.
  A status PATCH that is a real transition into canceled, closed, toured or
  no_show is TERMINAL for the reminder ladder (lines 1208-1220): the generation
  pointer rotates and every pending rung is retired; nothing is sent.
- A `toured` tour WITH an outcome and no `closed` status is reachable three
  ways: the dashboard exit gate (`TourDetail.tsx:489-520`) sends `status:
  'closed'` only for not_a_fit, while move_forward leaves the tour `toured`
  (`outcome`, `moveForward`, `convertible: true`) and immediately POSTs
  `/api/placements/from-tour`, which finalizes the tour as `closed` with
  `convertedPlacementId` (`app/src/routes/placements.ts:640,772-773`) - so a
  FAILED conversion leaves it toured with an outcome; an API caller may record
  not_a_fit without `closed` (open issue
  `tour-outcome-close-not-backend-enforced`); and the full-profile seed writes
  such rows (`app/src/lib/seed/matrix.ts:1072-1087`, rep 2 is not_a_fit and
  stays `toured`). For a not_a_fit-without-close tour the tour page offers no
  action at all (`TourDetail.tsx:528-556`, `TourActionsMenu.tsx`).
- A `requested` tour may be marked "already toured" with the date left blank
  (`TourModals.tsx:212-218`): it becomes `toured` with NO `scheduledAt`, so it
  is not in the `byScheduledAt` GSI and no range query ever returns it.
- `GET /api/tours` (`tours.ts:393-429`) has four exclusive modes: `tenantId`,
  `unitId`, `from`+`to` (ISO datetimes, `listByScheduledRange`), or `status`
  (`listByStatus`). `listByScheduledRange` (`toursRepo.ts:347-364`) issues ONE
  Query on the `byScheduledAt` GSI (`BETWEEN :from AND :to`, inclusive,
  ascending) and does not follow `LastEvaluatedKey`; its only callers are
  `today.ts:550` and `tours.ts:413`. `listByStatus` (lines 366-385) paginates.
  The GSI projects every attribute (`app/src/lib/tables.ts:14`), so `outcome`
  is present on range-query rows.
- `POST /api/tours` (lines 290-360) accepts any valid ISO `scheduledAt`,
  including one in the past. The arm (`app/src/jobs/tourReminders.ts:560-605`)
  then writes a VISIBLE `booked_too_late` skipped row for `day_before` and
  silently drops the rungs whose `dueAt` is already past; the create rotates the
  ladder pointer and records a "Tour scheduled" milestone. Nothing is SENT: the
  confirmation kind is discontinued (line 312) and a skipped row is never
  polled.
- Dashboard: `useTours.ts` fetches `[start-of-today-local, +30 days]` via
  `toursDateRange` (lines 34-41) and filters the window to `status ===
  'scheduled'` on the client (line 70) because the range query returns every
  status; the Today group of the Active tab therefore shows today's scheduled
  tours all day. `useClosedTours(enabled)` (lines 111-146) is a lazy fetch of
  `closed` + `canceled` by status, newest `updatedAt` first, refetched each
  time the view shows. `ToursPage.tsx` takes `closed?: boolean`, renders the
  tabs from `VIEW_TABS` (lines 179-182), and `App.tsx:237-240` routes `tours`
  and `tours/closed` to the SAME component type at the same tree position, so
  React preserves the page's state across a tab switch. `TourRow` (lines
  122-158) is a single `<Link>` wrapping identity and meta chips; the row CSS
  (`ToursPage.module.css`) stacks identity over chips below a 560px container
  width.
- `TourDetail.tsx`: the header CTA is "Mark toured" on a scheduled tour (line
  550; it PATCHes `status: 'toured'` and then opens the RecordOutcomeModal
  itself, lines 312-323, Cameron's 2026-08-06 rule), and "Record outcome" on a
  toured tour with no outcome (lines 553-556); the modal slot is the `modal`
  state (line 237). The back arrow is a hard-coded `<Link to="/tours">` (line
  595). The page reads only `useParams` and `useNavigate` from the router (line
  26); nothing reads the query string or the location state.
- Seeds: the lean profile (the e2e world) seeds NO tours. e2e specs create
  tours through `POST /api/tours` with `page.request` after dev-login
  (`e2e/tests/dashboard-next/tours-page.spec.ts:397`). The fake Twilio's
  outbound proof surface is its THREAD store (`e2e/fixtures/fakeTwilio.ts:375`,
  `listThreads`; `getOutboundTo` filters one party's outbound messages); the
  Conversations rail list (`listConversations`) does not see an SMS.

## 3. Part 1 - staff notes

### 3.1 The field

- `staff_notes?: string` on the contact record. Free text, one value, no dated
  entries, no length cap (parity with `notes`, which has none; the practical
  ceiling is the JSON body parser's 100 KB default, then DynamoDB's 400 KB
  item). `''` clears.
- `staff_notes_updated_at?: string` (ISO 8601). Written by the server on every
  PATCH that carries `staff_notes` (a clear included). Never client-settable: it
  is not in the PATCH allowlist, so a client key of that name is ignored like
  any other unknown key.
- Declared on `ContactItem` directly after `park_reason`, with a comment about
  `staff_notes` ALONE: nothing machine-writes or machine-reads it (not the
  import, the seeds, the public sign-up, the transition service, or extraction);
  `''` clears; the companion is server-stamped.
- Neither name goes into `PROVENANCE_FIELDS`; there is no `staff_notes_source`.

### 3.2 PATCH

`parseTriageBody` gains one block, placed directly after the `notes` block:

- `staff_notes` present and a string -> `patch['staff_notes'] = v`,
  `changedFields.push('staff_notes')`.
- `staff_notes` present and not a string -> 400 `staff_notes must be a string`.

The route handler stamps `parsed.patch['staff_notes_updated_at'] = new
Date().toISOString()` whenever `'staff_notes' in parsed.patch`, before the
write. Everything else on the PATCH path is untouched: the audit event's
`fields` names `staff_notes`; the provenance loop skips it (not in
`PROVENANCE`); the best-effort suggestion read for a changed field returns
nothing for it.

### 3.3 Create paths never set it

`parseCreateBody` is not changed, so `staff_notes` in a POST body is ignored
like any other unknown key. The import, the seeds and the public sign-up are not
changed and do not write it. A test proves a POST body carrying `staff_notes`
creates a contact without it.

### 3.4 The AI neither reads nor writes it

By construction, not by a new guard: `toProfile` names its fields and
`staff_notes` is not added; `applyExtraction` writes two kinds of patch, one
direct-write patch whose keys come from the extraction schema
(`apply.ts:455-460`) and the `notes` append (`apply.ts:704`), and neither can
name `staff_notes`. The prompt is untouched. A test asserts `toProfile` of a
contact carrying `staff_notes` returns a profile without that key, and that an
extraction apply that both direct-writes a field and appends a note line makes
NO `contacts.update` call carrying `staff_notes` or `staff_notes_updated_at`.

One issue is filed: `extraction-prompt-read-staff-notes` (improvement, low) -
have the extraction prompt read staff notes as context, so the model can
reconcile against what staff already know. Not built here.

### 3.5 Dashboard types

`Contact` gains `staff_notes?: string` and `staff_notes_updated_at?: string`;
`ContactPatch` gains `staff_notes?: string`. Both additive.

### 3.6 The "Staff notes" card (tenant files only)

A new component `dashboard/src/routes/contact/StaffNotesCard.tsx`, rendered by
`TenantFile` directly ABOVE the "Preferences & notes" card, and ONLY when
`contact.type === 'tenant'` (TenantFile also serves team-member contacts, who
do not get the card). It owns its own edit state and save call; the file pane
stays a dumb renderer otherwise.

Props: `contactId`, `value` (the stored `staff_notes` or undefined),
`updatedAt` (the stored `staff_notes_updated_at` or undefined), and
`onContactUpdated?: (updated: Contact) => void`.

Read mode:

- Card title "Staff notes".
- Body: when the trimmed value is non-empty, `NotesText` (the same clamp and
  Show more toggle the notes card uses); when empty, the muted line "No staff
  notes yet." (an `EmptyRow`, NOT a `PendingPanel` - nothing is pending).
- Below the text, ONLY when the trimmed value is non-empty and `updatedAt`
  parses: a muted line "Last edited Sep 26, 2026" (en-US short month, numeric
  day, numeric year; a local `formatLastEdited` in the card with the same
  output shape as ToursPage's private `formatDate`). A cleared box reads as
  never set even though the stamp is kept.
- Aside action: "Edit" with aria-label "Edit staff notes" when the value is
  non-empty, "+ Add" with aria-label "Add staff notes" when empty. Rendered as a
  `CardAction` only when `onContactUpdated` is provided; otherwise the aside is
  the plain text, mirroring how the other cards degrade without `onEdit`. The
  aside is NOT rendered while the card is in edit mode.

Edit mode (entered by the aside action):

- A `<textarea>` labeled "Staff notes" (a real `<label>`, visually hidden
  because the heading already says it; `getByLabel('Staff notes', { exact:
  true })` resolves it), prefilled with the stored value, `rows={4}`, focused
  on entry.
- Buttons "Save" and "Cancel" (names exact). Cancel discards the draft and
  returns to read mode with no request. Save with the draft equal to the stored
  value returns to read mode with no request. Otherwise Save calls
  `updateContact(contactId, { staff_notes: draft })`; while in flight both
  buttons are disabled and the textarea is read-only.
- Success: `onContactUpdated(updated)` with the returned contact (which now
  carries the new `staff_notes_updated_at`), then read mode.
- Failure: stay in edit mode with the draft intact and an inline
  `role="alert"` reading exactly "Could not save staff notes. Try again." (no
  server code or message is appended).

`TenantFile` gains an optional `onContactUpdated` prop and passes it through;
`ContactDetail` passes `setContact` at its tenant-file call site. The "+ Add" on
"Preferences & notes" and `ContactEditForm` are unchanged - the edit dialog does
NOT get a staff-notes field; the card is the one editor.

Two staff saving the same box at once is guarded (section 3.9, added
2026-09-27 at Cameron's request; this replaced the original last-write-wins
of section 9, Q12).

Copy is staff-facing only (no catalog). Source stays ASCII.

### 3.7 Not changed

- `LandlordFile`, `PartnerFile`, `UnknownFile`, and the team-member rendering
  of `TenantFile`: no card. Issue filed: `staff-notes-on-landlord-partner-files`
  (improvement, low) - Sam's ask names tenants, but the same small box is
  plausibly useful on a landlord or partner file; decide later.
- Contact lists, the inbox, the timeline, exports: none render `staff_notes`.
- `contact-detail.spec.ts` keeps its coverage; only its two `getByLabel('Notes')`
  locators are scoped to the Edit dialog (section 5).

### 3.8 Glossary

`documentation/GLOSSARY.md` gains an entry under "Feature & label notes",
directly above the Unit `notes` entry:

- **Staff notes** (contact `staff_notes`, 2026-09-26) - the tenant file's
  hand-written box, kept apart from contact `notes`. Contact `notes` is the
  "Preferences & notes" card, which the AI appends dated `[Auto - <date>]`
  lines to and reads as its profile; `staff_notes` is human-only - never
  machine-written or machine-read. Human label: "Staff notes" (staff only;
  no tenant-facing surface). The companion `staff_notes_updated_at` is
  server-stamped on every write and renders as "Last edited <date>" while the
  box holds text.

and the Unit `notes` line becomes "free-form INTERNAL notes on a property (the
counterpart of contact `notes`, the Preferences & notes field - not of the
contact's Staff notes)".

### 3.9 Stale-save guard (AMENDMENT 2026-09-27, Cameron)

Found by the planner's adversarial review (issue
`staff-notes-stale-page-overwrite`): nothing refreshes Staff notes on an open
page, so a Save from a page loaded before a colleague's save silently replaced
the newer note, unrecoverably. Cameron asked for the cheap guard.

- Request: the PATCH body may carry `staff_notes_expected_updated_at` - the
  `staff_notes_updated_at` the editor OPENED with, or `null` for a box that had
  never been saved. Neither a string nor null -> 400
  `staff_notes_expected_updated_at must be a non-empty string or null` (''
  can never match a stamp). It is a guard,
  never stored, and does not count as a changed field.
- Enforcement: only when the body also carries `staff_notes`. The route passes
  `{ expect: { attr: 'staff_notes_updated_at', value } }` to
  `contactsRepo.update`, which adds `#attr = :value` (or
  `attribute_not_exists(#attr)` for null) to the SAME conditional UpdateItem
  as the write - no read-then-write window.
- Refusal: a failed guarded write is re-read with a consistent read; if the
  contact exists the route answers 409 `staff_notes_stale` with
  `{ contact }` (the current item, the same shape as a 200), writes nothing and
  audits nothing; if it does not, 404 `contact_not_found` as before.
- Without the key the PATCH is unchanged (last-write-wins); only the card
  sends it. A cleared box keeps its stamp, so a stale save after a colleague
  CLEARED the box is refused too.
- Card: every Save sends the stamp captured at edit start. On a 409
  `staff_notes_stale` it stays in edit mode with the draft intact, hands the
  current contact up (so the read-mode text updates behind it), re-bases its
  baseline text and stamp on the colleague's version, and shows a
  `role="alert"` panel above the box, linked to it by `aria-describedby`:
  "These notes were changed since this page loaded. The current version is
  below, and your text is still in the box. Save again to replace it, or Cancel
  to keep it." followed by the current text (or a muted "(The notes were
  cleared.)"). The wording names what changed, not who: the same person in
  another tab, or a page simply left open, trips the guard as well. A second Save is then a deliberate,
  informed overwrite; Cancel keeps theirs. Any other failure is the existing
  plain alert.
- Tests: route (match lands; stale 409 with the current contact and no write
  or audit; null on a never-set box lands and is refused once stamped; a
  cleared box refuses; 400 on a bad type; no key = unchanged; key without
  `staff_notes` guards nothing; unknown contact stays 404); the real repo
  against DynamoDB Local (the condition itself); the card (sends the opened
  stamp; conflict panel, draft kept, contact handed up, second Save sends
  their stamp; Cancel keeps theirs; cleared variant; other 409s stay plain);
  Playwright with two pages on one tenant.

## 4. Part 2 - the Past tab

### 4.1 Route and tabs

- `ToursPage`'s `closed?: boolean` prop becomes `view?: 'active' | 'past' |
  'closed'` (default `'active'`). `App.tsx` routes `tours` -> active,
  `tours/past` -> past, `tours/closed` -> closed. `VIEW_TABS` becomes Active
  (`/tours`), Past (`/tours/past`), Closed (`/tours/closed`), in that order; the
  current tab carries `aria-current="page"` as today.
- Heading: "Past tours". Intro line: "Last 90 days: tours that were never
  marked toured, toured tours still waiting on an outcome or a placement, and
  no-shows." A toured tour recorded with no date is listed LAST, as
  "Undated" (section 4.2a, amendment 2026-09-27).
- The "+ New tour" button stays Active-only.

### 4.2 Data

A new lazy hook `usePastTours(enabled)` in `useTours.ts`, shaped like
`useClosedTours` (idle until enabled; `status`, `past: Tour[]`) plus a
`reload()` function the page calls after a bulk action and a `reloadFailed`
flag. A reload keeps the current rows on screen until the new page lands (no
spinner flash under the per-row results); only the first load shows the
spinner. A reload that FAILS also keeps the rows, the per-row results and the
above-toolbar block on screen: the hook stays `ready` with `reloadFailed:
true` (cleared by the next successful load), and the page adds one
`role="alert"` line above the toolbar, "Could not refresh the list. Reload the
page to see the latest." Only a failed FIRST load shows the page-level error
that replaces the list.

- Window (`pastToursDateRange(now)`): `from` = the start of the local calendar
  day 90 days before today; `to` = the end of today local (the start of
  tomorrow minus 1 ms). Both built with calendar arithmetic
  (`new Date(y, m, d - 90, 0, 0, 0, 0)` and `new Date(y, m, d + 1, 0, 0, 0, 0)`,
  DST-safe) and sent as UTC ISO strings. Ending at the end of today rather than
  at `now` lists a tour marked toured or no-show BEFORE its scheduled time
  today; a tour marked toured on a FUTURE date stays invisible until that date
  (section 9, Q9).
- One request: `getTours({ from, to })`.
- Selection (`selectPastTours(tours, now)`, a pure exported function), in this
  order:
  1. keep `status` in `PAST_TAB_STATUSES = ['scheduled', 'toured', 'no_show']`
     (canceled and closed belong to Closed; requested never has a time and is
     never returned by this mode);
  2. drop a `scheduled` row whose `scheduledAt` is at or after the start of
     today local - Active's Today group shows it all day, and it is not "past"
     until the day ends (section 9, Q9);
  3. drop a `toured` row that carries an `outcome` UNLESS it is `convertible
     === true` with no `convertedPlacementId` at all (a move-forward decision
     whose conversion never reached the tour - the case this tab's own
     Record-outcome path can produce). This is ONE of the states a failed
     conversion leaves: a tour whose placement WAS created but whose finalize
     failed may carry a `pending:` placeholder in `convertedPlacementId`
     (`placements.ts:754-760`, accepted residue) and is excluded here as
     "decided"; its tour page today links "View placement" at that placeholder
     (pre-existing bug, filed `tour-conversion-pending-placeholder-view-link`).
     A recorded not_a_fit left un-closed is the open issue
     `tour-outcome-close-not-backend-enforced` and stays excluded (section 9,
     Q3);
  4. sort by `scheduledAt` descending (most recent first), ties by `tourId`
     ascending for a stable order.
- Statuses are filtered on the CLIENT. Why: the range endpoint already returns
  every status and the Active tab filters it the same way (`useTours.ts:70`); a
  server-side status filter would add a fifth query mode to the route and repo
  for a list that is one org's 90 days of tours. Recorded for the handback.
- Known limits, filed not fixed: `listByScheduledRange` reads one ascending
  Query page (no `LastEvaluatedKey` follow), so a window past 1 MB would drop
  the NEWEST tours - the top of this list (`tours-scheduled-range-query-unpaginated`,
  debt, low; the Active window has the same ceiling today).

### 4.2a Undated toured tours (AMENDMENT 2026-09-27, Cameron)

A requested tour marked "already toured" with the date left blank becomes
`toured` with NO `scheduledAt`, so the range query never returns it and DRAFT 4
listed it nowhere - staff looking for it could not find it. Cameron ruled: list
them, labeled "Undated", at the bottom.

- Data: `usePastTours` makes a SECOND read in parallel with the range read,
  `getTours({ status: 'toured' })` (`listByStatus`, which paginates). Both reads
  succeed or the load fails as one (first load -> error; reload ->
  `reloadFailed`, rows kept), and `reload()` refetches both.
- Selection (`selectUndatedTours(touredRows, now)`, pure): keep a row with
  status `toured`, NO `scheduledAt`, and either no `outcome` or the
  Needs-placement shape (4.2 step 3's rule, same exception); keep it only if
  its `updatedAt ?? createdAt` is on or after the Past window's `from` (the
  same 90 days, measured by when it was last touched since it has no tour
  date); order most recently touched first, ties by `tourId`.
- The Past list is the dated rows (4.2, unchanged) followed by the undated
  rows. The two sets are disjoint by construction (a range row always has a
  `scheduledAt`).
- Row: the date-time column reads "Undated"; the chip is the usual state
  ("Needs outcome" or "Needs placement"); every accessible name uses
  "<tenant> at <property>, undated" in place of "<tenant> at <property> on
  <date-time>" (e.g. "Tour for Tasha Nguyen at 1450 Joseph E. Boone Blvd NW,
  undated, Needs outcome"). Actions as 4.4: "Record outcome" on a Needs-outcome
  row. An undated row is never "Not marked" (only a `requested` tour can
  become toured without a date), so it never carries a checkbox and never
  enters a bulk batch.
- Cost: the status read returns every toured tour ever; at this org's volume a
  toured tour normally leaves that status within days (the outcome closes it),
  so the set stays small. Noted, not engineered around.
- Tests: `selectUndatedTours` (kept / dropped / window / order / the two
  exceptions), the hook's two reads and the merged order, a page row with
  "Undated" and its label, and Playwright: a requested tour marked toured with
  no date appears LAST as "Undated" with "Record outcome".

### 4.3 The row

Each Past row shows the tenant and the property (the identity block, left,
as every other tours row does), then the scheduled date and time ("Sep 24,
2026, 2:30 PM": the page's existing `formatDate` + `formatTime`, joined with
", ") and the state in plain words (the meta chips, right; they wrap under the
identity on a tight pane):

| tour | state chip |
|---|---|
| status `scheduled` | "Not marked" |
| status `toured`, no `outcome` | "Needs outcome" |
| status `toured`, `convertible` and no `convertedPlacementId` (4.2 step 3) | "Needs placement" |
| status `no_show` | "No show" |

`pastState(tour)` is a pure exported function returning the chip text, tested
in table order: a toured row with no outcome reads "Needs outcome" even if it
is somehow `convertible` (an API-only shape); for any other combination it
returns the status label (`TOUR_STATUS_LABELS`) so a mis-selected row is never
blank.

Row structure - the whole row is NOT one link any more, because buttons and a
checkbox cannot live inside an `<a>`:

```
<li class=rowItem>
  [checkbox]            only on a "Not marked" row; aria-label "Select tour for <tenant> at <property> on <date-time>"
  <Link to=/tours/:id>  identity (tenant, property) + meta (date-time, state chip);
                        aria-label "Tour for <tenant> at <property> on <date-time>";
                        router state { back: '/tours/past' }
  <actions>             see 4.4
  <result line>         see 4.5, only after a bulk action touched this row
</li>
```

`<date-time>` in every label is the same "Sep 24, 2026, 2:30 PM" string the
row shows, so two tours for one tenant at one property have distinct
accessible names.

Tenant and property names resolve from the same live + soft-deleted contact and
unit maps the other tabs use. The tour-type badge is not shown on Past rows
(the mission lists the row's content; the type is on the tour page).

### 4.4 Row actions

- "Not marked" (scheduled): a button "Mark toured" (aria-label "Mark toured:
  <tenant> at <property> on <date-time>"). Its name is distinct from the bulk
  button's "Mark toured (N)" and from every sibling row under EXACT or
  anchored matching only - Playwright's default substring match on "Mark
  toured" finds all of them, so every test locates the bulk button with an
  anchored name (`/^Mark toured \(\d+\)$/` or `exact: true`). It runs the same
  runner as the bulk action with one id (4.5). Unlike the tour page's own "Mark
  toured" (which opens the outcome dialog on success, Cameron 2026-08-06), the
  list action stops at "Needs outcome": a list cannot open a page's dialog,
  and the row's "Record outcome" link is the way in.
- "Needs outcome" (toured, no outcome): a link "Record outcome" (aria-label
  "Record outcome: <tenant> at <property> on <date-time>") to
  `/tours/<id>?outcome=1`, with router state `{ back: '/tours/past' }`.
- "Needs placement": no row action; the row link opens the tour page, whose
  primary CTA is "Start placement" for exactly this state.
- "No show": no row action. The tour page holds reschedule and the check-in
  text; giving a no-show a way OFF this list is a product call (section 9,
  Q11; issue `past-tab-no-show-rows-need-an-exit`).

### 4.5 Bulk "Mark toured"

A toolbar above the list, Past view only:

- A checkbox "Select all not marked" that checks every "Not marked" row
  currently listed (and unchecks them when cleared). Indeterminate when some
  but not all are selected.
- A button whose text is "Mark toured (N)" with N the number of selected rows;
  disabled at 0 and while a batch is running.

Selection is DERIVED: the raw set of ticked ids intersected with the ids of
the "Not marked" rows currently listed, so a row that left that state (marked
elsewhere, then reloaded) leaves the selection and the count. The Past view's
body is a Past-only child component that mounts when the tab shows and
unmounts when it does not (the three tabs still share one page instance, as
today), so selection and results start fresh every time Past shows.

While a batch runs, EVERY mark control is disabled: the bulk button, every row
"Mark toured" button, every checkbox and the select-all box; the runner also
ignores a call while one is in flight.

The runner (`markToured(ids)`):

1. Set busy; clear previous results; SNAPSHOT the listed rows (the whole
   `Tour` per id: its raw ISO `scheduledAt` for step 2c's comparison, and its
   tenant, property and date-time for naming a row the reload drops).
2. For each id IN LIST ORDER, ONE AT A TIME:
   a. re-read the tour (`getTour(id)`) - the list is a snapshot, and the
      server accepts canceled -> toured, no_show -> toured and a reschedule
      that keeps `scheduled`, so a tour a colleague has since canceled, marked
      no-show or rebooked must not be flipped, given a false "Tour took place"
      milestone and stripped of its freshly armed reminders;
   b. if the re-read fails, record `{ ok: false, message: 'Could not check the
      tour' }` and continue;
   c. if the CURRENT status is not `scheduled`, OR the current `scheduledAt`
      differs from the snapshot's raw ISO `scheduledAt` (both are the server's
      canonical `toISOString` output, so an exact string compare is right),
      record `{ ok: false, message: 'Changed since the list loaded' }` and
      continue;
   d. `patchTour(id, { status: 'toured' })`; record `{ ok: true }` or
      `{ ok: false, message: 'The update failed' }`.
   Sequential, not `Promise.allSettled`: each PATCH rotates that tour's
   reminder ladder and writes audit and activity rows, and a serial run keeps
   those writes ordered and the per-row result deterministic. A failure does
   not stop the batch. The re-read is an eventually consistent GET, so the
   race window is one round trip plus DynamoDB's replication lag, not zero.
3. Clear the raw selection for the ids that succeeded; keep it for the ones
   that failed (the derived selection then drops any that are no longer
   listed).
4. `reload()` the list; clear busy.

Per-row result line, rendered under the row until the next batch, a view
change or a navigation away: "Marked toured" (`role="status"`, muted) or
"Could not mark toured: <message>" (`role="alert"`) - `<message>` being one of
the three fixed strings above, never a raw server code. After the reload a
succeeded row reads "Needs outcome" and offers "Record outcome"; a failed row
that is still listed is unchanged and still "Not marked". Every result whose
id is NO LONGER listed after the reload (its tour left the Past set) is
reported in a block ABOVE the toolbar, one line per tour from the snapshot:
"<tenant> at <property> on <date-time>: Marked toured" (`role="status"`) or
"<tenant> at <property> on <date-time>: <message>" (`role="alert"`), so no
result is ever silent - including when the reload itself fails (4.2: the rows
and results stay, one alert is added).

The batch sends only `status: 'toured'`. It never sends an outcome, never
closes a tour, and never PATCHes a tour whose CURRENT status (re-read
immediately before the PATCH) is not `scheduled` or whose scheduled time
changed since the list loaded.

### 4.6 The tour page: the `?outcome=1` deep link and the back arrow

`TourDetail` reads the query string once the tour has loaded. ONLY when
`outcome=1` is present:

- the tour is `toured` with no `outcome` -> `setModal('outcome')`; otherwise
  nothing opens;
- either way the param is removed with a `replace` navigation that CARRIES
  THE CURRENT LOCATION STATE FORWARD (`setSearchParams(next, { replace: true,
  state: location.state })`): a navigation without `state` resets it to null
  (react-router 7.18.0, `createLocation`), which would drop the back pointer
  on exactly the Record-outcome path. A reload or the back button then never
  reopens the dialog.

Without the param nothing runs, so the plain row-link path keeps its state
untouched.

The back arrow (`aria-label "Back to tours"`) links to `location.state.back`
when it is exactly `/tours`, `/tours/past` or `/tours/closed`, else `/tours`.
The Past tab's row link and "Record outcome" link are the only producers of
that state today; the Active and Closed rows keep linking without state and
so keep returning to `/tours`.

The dialog, its confirm handler and everything after it are the existing code.

### 4.7 Invariants

- No tour changes status except through a human clicking "Mark toured" (row or
  bulk) or the existing tour-page flows. The Past tab performs no write on load,
  on select, on view change or on navigation.
- The batch never PATCHes a tour whose current status is not `scheduled` or
  whose scheduled time changed since the list loaded (4.5 step 2c). The
  stale-list race is closed to one eventually consistent round trip; a
  server-side precondition is not added.
- No send: `status: 'toured'` is a terminal ladder transition (retires pending
  rungs, sends nothing), and the tab calls no messaging route. The e2e proves
  the fake Twilio THREAD store's outbound message count is unchanged across a
  bulk mark.
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
  `staff_notes_updated_at` is an ISO string, `notes` untouched, no
  `staff_notes_source`, the audit `contact_updated` payload's `fields` is
  `['staff_notes']`.
- PATCH `{ staff_notes: '' }` clears and re-stamps `staff_notes_updated_at`.
- PATCH `{ staff_notes: 5 }` -> 400 `staff_notes must be a string`.
- PATCH `{ staff_notes_updated_at: '2020-01-01T00:00:00.000Z' }` alone -> 400
  `no updatable fields supplied`; alongside `staff_notes` it is ignored and the
  server stamp wins.
- A `notes`-only PATCH leaves `staff_notes` and its stamp untouched.
- POST `/api/contacts` with `staff_notes` in the body -> created contact has no
  `staff_notes`.
- `toProfile({ ..., staff_notes: 'x' })` has no `staff_notes` key.
- An extraction apply that direct-writes one field AND appends a note line
  makes no `contacts.update` call whose patch carries `staff_notes` or
  `staff_notes_updated_at` (asserted across ALL update calls, not one).

Unit, dashboard:

- `useTours.test.ts`: `pastToursDateRange` (from = start of the local day 90
  calendar days ago, to = end of today local, both asserted with the same
  calendar construction; a November case proves no DST drift);
  `selectPastTours` drops canceled/closed, drops a scheduled row dated today,
  drops a toured row with a not_a_fit outcome, KEEPS a toured row that is
  convertible with no placement, keeps a toured row from later today, sorts
  most recent first with a tourId tiebreak, never mutates its input;
  `pastState` for the four cases plus the fallback and the outcome-first
  precedence; `usePastTours` idle until enabled, fetches with the window,
  `reload()` refetches while keeping the rows, a failed reload keeps the rows
  and sets `reloadFailed` (cleared by the next success), a failed first load
  is `error`.
- `ToursPage.test.tsx`: the three tabs with Past current on `/tours/past`; the
  Past rows (date-time, tenant, property, chip; date-time in every label) and
  their actions (Mark toured button on Not marked; Record outcome link to
  `/tours/<id>?outcome=1` with `state.back` on Needs outcome; none on Needs
  placement or No show); select-all + bulk button count; the batch re-reads
  each tour, calls `patchTour` once per id that is still scheduled AT THE SAME
  TIME, sequentially (the second call does not start until the first
  resolves), skips with "Changed since the list loaded" a tour whose re-read is
  no longer scheduled AND one whose re-read is scheduled at a different time,
  renders per-row success and failure lines and the above-toolbar block for a
  result whose row the reload dropped, disables every mark control while
  running, then reloads; a failed reload keeps the rows and results and shows
  the one refresh alert; switching the view resets selection and results; the
  bulk button is located by an anchored name; the existing Active and Closed
  tests still pass under the `view` prop.
- `TourDetail.test.tsx`: `?outcome=1` on a toured-no-outcome tour opens the
  Record outcome dialog and strips the param WHILE KEEPING `state.back` (the
  test mounts with both and asserts the back arrow still points at
  `/tours/past` after the strip); on a scheduled tour and on a toured tour with
  an outcome it opens nothing; without the param the state is untouched; the
  back arrow honors `state.back = '/tours/past'` and ignores any other value.
- `StaffNotesCard.test.tsx`: empty and filled read modes, the "Last edited"
  line only with text, Edit -> textarea prefilled and focused -> Save calls
  `updateContact` with `{ staff_notes }` and hands the returned contact up;
  Cancel discards without a request; unchanged Save sends no request; a failed
  save keeps the draft and shows the fixed alert; no action without
  `onContactUpdated`; the aside is absent in edit mode.
- `TenantFile`: the Staff notes card renders above Preferences & notes for a
  tenant and not at all for a team_member.

Playwright (hermetic lane only):

- `e2e/tests/dashboard-next/contact-detail.spec.ts`: lines 59 and 73 become
  `dialog.getByLabel('Notes')` where `dialog` is an Edit-dialog locator the
  test INTRODUCES at both sites (`page.getByRole('dialog', { name: /Edit
  contact/i })`; today line 58 asserts it inline and lines 72-73 hold no
  reference). A scoping fix; no assertion changes.
- `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts`: reseed in
  `beforeAll`; on the seeded tenant (contact-tenant-0001), "+ Add" -> type into
  `getByLabel('Staff notes', { exact: true })` -> Save -> the text shows with a
  "Last edited" line -> reload -> still there; the "Preferences & notes" card's
  innerText is identical before and after; at 360px the card in edit mode has
  no horizontal overflow; Edit -> clear -> Save shows "No staff notes yet." and
  no "Last edited" line (cleanup).
- `e2e/tests/dashboard-next/tours-past.spec.ts`: after a reseed, create three
  tours via `POST /api/tours` for the seeded tenant with `scheduledAt` one, two
  and three days in the past (10:00 local; two units so the labels differ in
  property as well as date); PATCH the second to `toured` and the third to
  `no_show` via the API; `/tours/past` lists exactly those three with "Not
  marked", "Needs outcome", "No show", most recent first; none of them is in
  Active; capture the fake's thread-store outbound count; tick the "Not marked"
  row, the bulk button (located by the anchored name `/^Mark toured \(1\)$/`)
  -> the row reads "Needs outcome" with "Record outcome"; the outbound count
  is unchanged and the tour reads toured with no outcome on the wire; the link
  lands on the tour page with the "Record outcome" dialog open and no
  `?outcome` in the URL; Cancel; the back arrow returns to `/tours/past` (the
  state survived the strip); at 360px no horizontal overflow.

Gates: the five in AGENTS.md, bare, from the worktree.

## 6. Non-goals

- The Tours calendar view.
- Bulk close, bulk outcome, or any automatic close.
- A way off the Past list for a no-show (issue filed).
- Listing `toured` tours that have no scheduled time (issue filed).
- Staff notes on landlord, partner, unknown or team-member files (issue filed).
- The AI reading staff notes (issue filed).
- A server-side status filter or an expected-status precondition on the tours
  routes; paginating the range query (issue filed).
- Optimistic concurrency on contact fields.
- Any change to the extraction prompt, the message catalog, the import, the
  seeds' contacts, or the public sign-up.

## 7. Files touched

App: `app/src/routes/contacts.ts`, `app/src/repos/contactsRepo.ts` (type
only), `app/test/contactStaffNotes.test.ts` (new).

Dashboard: `dashboard/src/api/types.ts` (additive), `dashboard/src/App.tsx`,
`dashboard/src/routes/contact/StaffNotesCard.tsx` (+ test, + module CSS),
`TenantFile.tsx` (+ new test), `ContactDetail.tsx` (one prop),
`dashboard/src/routes/tours/useTours.ts` (+ test), `ToursPage.tsx` (+ test, +
module CSS), `TourDetail.tsx` (+ test).

E2E: `e2e/tests/dashboard-next/contact-detail.spec.ts` (two locators scoped),
two new specs under `e2e/tests/dashboard-next/`.

Docs: `documentation/GLOSSARY.md` (section 3.8); six files under
`docs/issues/` (section 8). All of these are already committed on the branch
from the design phase.

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
- `past-tab-timeless-toured-tours` - improvement, med - RESOLVED on this branch 2026-09-27 (section 4.2a).
- `past-tab-no-show-rows-need-an-exit` - decision, med (section 9, Q11).
- `tour-conversion-pending-placeholder-view-link` - bug, low, pre-existing
  (found by spec review R3; 4.2 step 3).

## 9. Decisions the planner took alone (would have asked)

- Q1 `staff_notes` has no length cap. Parity with `notes`; a cap is a product
  call. The practical ceiling is the JSON body parser's 100 KB default (a
  bigger save fails with the card's generic alert), then DynamoDB's 400 KB item.
- Q2 The edit dialog (`ContactEditForm`) does not get a staff-notes field. The
  mission says inline edit; two editors for one field invite drift.
- Q3 A `toured` tour WITH an outcome is listed only when the outcome was
  move_forward and no placement exists (`convertible`, no
  `convertedPlacementId`): "Needs placement", no row action, the tour page's
  "Start placement" is the retry. DRAFT 1 listed every outcome; DRAFT 2 listed
  none (which hid a failed conversion this tab's own Record-outcome path can
  cause); DRAFT 3 lists the one case with a next step. A not_a_fit left
  un-closed by an API caller is the open issue
  `tour-outcome-close-not-backend-enforced` and stays excluded - listing it
  would put a row with no action anywhere into the demo world on day one. A
  failed conversion that DID create the placement (tour left with a
  `pending:` placeholder) is also excluded: its only list-side path would be
  "Start placement", which creates a second placement (the route's accepted
  residue); it is a tour-page bug, filed, not a Past-tab row.
- Q4 A no-show row has no row action (the mission named only "Mark toured" and
  "Record outcome"). See also Q11.
- Q5 The bulk runner is sequential, not parallel (4.5).
- Q6 Past rows drop the tour-type badge (4.3).
- Q7 The Past window ends at the end of today, not at the start of today
  (4.2), and a scheduled row dated today is dropped (Q9).
- Q8 The e2e creates past-dated tours through the API rather than adding tours
  to the lean seed: the lean world is byte-stable and tour-free, every existing
  tours spec creates its own tours the same way, and a past-dated create sends
  nothing (it does write a visible booked_too_late skipped reminder row and a
  "Tour scheduled" milestone, which the e2e tolerates).
- Q9 "Today" rule. The mission said "tours whose scheduled time is before the
  start of today". Taken literally, a tour marked toured (with the outcome
  dialog dismissed) or marked no-show earlier TODAY is on no list until
  midnight - the commonest "needs outcome" moment. Past therefore runs through
  the END of today and lists every toured and no-show row dated today (marked
  before or after its time), while a still-scheduled tour dated today stays on
  Active only (its Today group already shows it, and it is not past until the
  day ends). A tour scheduled for 9:00 today and never marked reaches Past at
  midnight. A tour marked toured or no-show on a FUTURE date is on no list
  until that date arrives (pre-existing; not changed here).
- Q10 SUPERSEDED 2026-09-27 by section 4.2a. Originally deferred: `toured`
  tours with NO scheduled time never appeared in Past. Cameron ruled they must
  be findable: list them last as "Undated".
- Q11 No-show rows have no way off the Past list until they age out at 90 days
  (the tour page offers only reschedule and the check-in text). Filed
  `past-tab-no-show-rows-need-an-exit`.
- Q12 SUPERSEDED 2026-09-27 by section 3.9. Originally: two staff editing the
  same Staff notes box at once is last-write-wins, like every other contact
  field. Cameron chose the cheap stale-save guard after the planner's review
  showed the loss is silent and unrecoverable for this box in particular.
- Q13 The tour page's back arrow returns to the tab that opened it, via router
  state carried by the Past tab's links. Without this, working through Past
  dropped staff on Active after every tour.
- Q14 The stale-list race in bulk "Mark toured" is closed on the CLIENT by a
  re-read before each PATCH (status still `scheduled` AND the scheduled time
  unchanged since the list loaded), not by a server-side expected-status
  precondition. A precondition would be the stronger guarantee but touches the
  tours route and its contract for every caller; the re-read narrows the
  window to one eventually consistent round trip and keeps the change inside
  the dashboard. Residual: a tour marked no-show and then revived at the SAME
  time between the load and the click passes the guard; it is scheduled at
  that time, so marking it toured is what the operator meant.
