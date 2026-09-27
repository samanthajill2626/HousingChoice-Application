# Spec review R1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` (DRAFT 1)
Base: worktree `W:\tmp\staff-notes-past-tours` @525ec886 (spec commit on 0dafe3c1)
Method: every claim below was read in the code at the cited file:line. Anything
not verified by reading is marked UNVERIFIED. No suites were run.

Severity is consequence-if-shipped-unfixed, not interest.

---

## F1 [MEDIUM] Past excludes TODAY, so today's toured-no-outcome and no-show tours are on NO tab

What is wrong. Section 1 promises Past lists tours "whose scheduled time has
passed and that still need a human decision". The mechanism (4.2, Q7) ends the
window at start-of-today minus 1 ms. Active only shows `status === 'scheduled'`
(useTours.ts:70). So a tour scheduled at 09:00 today that staff mark toured at
15:00 and then dismiss the outcome dialog (TourDetail.tsx:312-323 opens it
automatically; dismissing is the documented way to end up at "Record outcome")
is `toured` with no outcome and appears on neither Active (not scheduled) nor
Past (after the window's `to`). Same for a tour marked no-show today
(TourActionsMenu "Mark no-show", scheduled only).

Evidence. `dashboard/src/routes/tours/useTours.ts:70` (Active filters to
scheduled); spec 4.2 window; spec 1 outcome sentence; TourDetail.tsx:312-323
(mark toured -> modal, dismiss leaves toured/no-outcome).

Implication. The single most common way to create a "Needs outcome" tour is
same-day, and that tour is invisible on the Tours page until midnight. The Q7
rationale (avoid a midnight tour in both tabs) only needs the boundary for
`scheduled` rows; the spec should either widen Past's `to` to `now` for
non-`scheduled` statuses (or for all, filtering `scheduled` to `scheduledAt <
start-of-today` to keep the no-double-listing rule), or restate the outcome
honestly. As written, the stated guarantee and the mechanism disagree.

## F2 [MEDIUM] A requested tour marked "already toured" with no date is toured-no-outcome and on no tab, ever

What is wrong. 4.2 says "requested never has a time and is never returned by
this mode anyway" and 4.7 says "Requested tours stay in Active's Needs
booking". Neither covers the tour that LEAVES requested through the kebab's
"Mark already toured" with the date left blank: the modal deliberately sends no
`scheduledAt` ("the tour stays off the byScheduledAt index"), the tour becomes
`toured`, and TourDetail chains into the outcome dialog. Dismiss it and the
tour is toured-no-outcome with no `scheduledAt`.

Evidence. `dashboard/src/routes/tours/TourModals.tsx:216-218` (blank = no
scheduledAt, stays off the index); `TourDetail.tsx:479-488`
(confirmAlreadyToured -> setModal('outcome')); `app/src/repos/toursRepo.ts:347-364`
(range mode is a byScheduledAt Query - an item with no scheduledAt is never in
the GSI); Active shows only scheduled + requested (useTours.ts:59-70).

Implication. The spec's "toured tours with no outcome recorded" list is a
subset it never names. This is an unenumerated mutation surface into the exact
state Past exists to surface. The spec must either accept and document the
hole (and file it) or change the data source for toured-no-outcome (e.g. a
`status=toured` query, which `listByStatus` already paginates, tours.ts:411-418).

## F3 [MEDIUM] "Never touches a tour that is not scheduled" is enforced only against a stale client snapshot; the server allows canceled -> toured

What is wrong. 4.5 guarantees the batch "never touches a tour that is not
`scheduled`" because "the runner refuses an id whose listed status is not
scheduled". The listed status is whatever the page fetched, possibly hours
ago. The server transition guard does not restrict `toured` to a scheduled
source: canceled -> toured and no_show -> toured both pass (only closed is
terminal; only `requested` has a restricted exit set).

Evidence. `app/src/routes/tours.ts:1065-1128` (guard: closed terminal; target
requested refused; requested restricted; target scheduled needs canReschedule;
nothing else). Spec 2.2 itself says no_show -> toured is legal. There is no
expected-status / conditional PATCH in `PATCH_ALLOWED`.

Implication. If a colleague cancels or marks no-show a tour from its tour page
while the Past tab sits open, the batch flips it to `toured`, reports "Marked
toured", writes a `tour_took_place` milestone (tours.ts:1424-1426) and rotates
the ladder. The guarantee is a slogan relative to the mechanism. Fix options:
re-read each tour (GET /api/tours/:id) immediately before its PATCH and skip
with a per-row failure if no longer scheduled, or state the weaker guarantee
honestly. The TourDetail "Mark toured" has the same stale-status exposure, but
it does not claim the invariant.

## F4 [MEDIUM] No-show rows have no resolution path in the UI, so Past cannot be worked to zero

What is wrong. Section 1 frames Past as tours "that still need a human
decision", and Q4 gives no-show rows no action, pointing at the tour page. On
the tour page a no_show tour can only be RESCHEDULED: Cancel is offered for
requested/scheduled only, Mark no-show for scheduled only, the primary CTA
exists only for requested/scheduled/toured/convertible, and there is no "mark
toured" for no_show.

Evidence. `dashboard/src/routes/tours/TourDetail.tsx:90-97` (RESCHEDULABLE_UI
includes no_show; CANCELABLE = requested, scheduled); `TourDetail.tsx:261`
(canMarkNoShow = scheduled); `TourDetail.tsx:528-558` (primary CTA ladder has
no no_show arm).

Implication. Every no-show sits on Past for 90 days whatever staff decide
(e.g. "dead lead, done"), and the only way off is to book a new time. The list
accumulates rows that are not actually awaiting a decision, which erodes the
tab's signal. Either no-show needs a terminal exit (cancel/close from
no_show on the tour page - small, but a product call), or the spec must say
Past is a 90-day log of no-shows rather than a queue. Same shape for an
API-recorded toured + not_a_fit tour (see F13): chip "Not a fit", no row action,
and TourDetail renders no CTA for it at all.

## F5 [MEDIUM] The e2e "no send" proof reads the Conversations rail list, which cannot see an SMS send

What is wrong. 4.7 and section 5 prove "No send" by asserting "the fake Twilio
conversation list is unchanged across a bulk mark". The e2e fixture's
`listConversations` returns the Conversations RAILS the fake holds (CH sids,
relay/native group plumbing). A tour reminder or any classic SMS goes through
the Messages API and lands in the fake's THREAD store, read by `listThreads` /
`getOutboundTo`.

Evidence. `e2e/fixtures/fakeTwilio.ts:307-312` (listConversations: "The rails
the fake currently holds"); `e2e/fixtures/fakeTwilio.ts:191-213,375-379`
(getOutboundTo / listThreads: "The proof-of-send read ... straight from the
fake's thread store"); `e2e/fixtures/fakeTwilio.ts:381-386` (no reset helper;
scope assertions with getOutboundTo's `since`).

Implication. Taken literally, the test is vacuous for the invariant it claims
to prove. Specify: capture a `since` timestamp before the batch and assert
`getOutboundTo(request, { to: <tenant phone>, since })` (and the landlord's
number if the unit has one) is empty after it, or diff `listThreads` outbound
message counts.

## F6 [MEDIUM] The new card breaks an existing e2e: contact-detail.spec.ts uses unscoped, non-exact getByLabel('Notes') on the same tenant

What is wrong. Playwright `getByLabel` matches `<label>` text AND the
`aria-label` attribute, case-insensitive SUBSTRING by default. The Staff notes
card's aside button carries aria-label "Add staff notes" (empty) / "Edit staff
notes" (filled) - both contain "notes". `contact-detail.spec.ts` drives the
edit dialog on `contact-tenant-0001` with `page.getByLabel('Notes')` (page-wide,
not exact), which will now resolve to two elements -> strict-mode violation.

Evidence. `e2e/tests/dashboard-next/contact-detail.spec.ts:11` (TENANT =
contact-tenant-0001), `:59` and `:73` (`page.getByLabel('Notes')`); spec 3.6
aria-labels. The repo already documents this trap class
(`e2e/support/today.ts:1-30`, substring role-name match broke ~dozens of specs).
The strict-mode outcome is UNVERIFIED by running, but follows from Playwright's
documented getByLabel semantics.

Implication. Gate 4 fails on a spec the plan does not list as touched. The
same trap bites the spec's OWN plan: 3.6 claims "a visible <label>, so
getByLabel('Staff notes') resolves it", but in edit mode that also matches the
aside button unless the aside is removed while editing (the spec never says
what the aside shows in edit mode). And 4.4's claim that the aria-label "Mark
toured: <tenant> at <property>" "never collides with the bulk button" is false
under substring matching (`name: 'Mark toured'` matches both it and "Mark
toured (1)"). The spec should (a) list contact-detail.spec.ts as touched and
scope/exact its selector, (b) say the aside is hidden in edit mode, (c) require
exact/regex names for the bulk button.

## F7 [MEDIUM] Row accessible names cannot tell two tours for the same tenant+property apart - and the spec's own e2e fixture creates exactly that

What is wrong. Every accessible name on a Past row is built from tenant and
property only: the row link ("Tour for X at Y" - an aria-label, which REPLACES
the link's content, so the date/time and state chip inside it are not
announced), the checkbox, "Mark toured: X at Y", "Record outcome: X at Y".
Several tours for one tenant+property inside 90 days is ordinary (a no-show then
a new booking). The e2e in section 5 creates three tours "for the seeded tenant
and unit".

Evidence. Spec 4.3 row structure and 4.4 labels; existing row link aria-label
at `dashboard/src/routes/tours/ToursPage.tsx:141-145`; spec section 5
tours-past.spec.ts fixture.

Implication. After the e2e's batch, two rows are "Needs outcome" with the
identical link name "Record outcome: X at Y" -> the planned click is a
strict-mode violation unless scoped by href; and screen-reader users hear
three identical "Tour for X at Y" links. Put the date-time into every per-row
accessible name (link, checkbox, both actions), or drop the link's aria-label
so its visible content (which already includes date and chip) names it.

## F8 [MEDIUM] GLOSSARY.md is not in the files touched, and the glossary already calls contact `notes` the internal staff notes

What is wrong. AGENTS.md requires GLOSSARY.md to be updated "in the same change
whenever you add a domain noun or fix drift". This spec adds a new domain noun
("Staff notes" / `staff_notes`) that splits the meaning of contact `notes`, plus
new staff-facing state labels ("Not marked", "Needs outcome", the Past view).
The glossary today describes unit `notes` as "free-form INTERNAL staff notes on
a property (the contact `notes` counterpart)" - i.e. it equates contact `notes`
with internal staff notes, which is exactly what this feature says `notes` is
NOT any more (it is the AI-appended "Preferences & notes").

Evidence. `AGENTS.md` "Product vocabulary" paragraph; `documentation/GLOSSARY.md:141-145`;
spec section 7 (no GLOSSARY entry).

Implication. The branch ships vocabulary drift the repo rules forbid and leaves
the next reader with a glossary that contradicts the UI. Add GLOSSARY.md to
section 7 with the `notes` vs `staff_notes` distinction (who writes each, AI
access) and the Past-tab labels.

## F9 [LOW] `patchContact` does not exist; the dashboard function is `updateContact`

What is wrong. 3.6 and section 5 have the card call, and the tests assert,
`patchContact(contactId, { staff_notes })`. No such function exists.

Evidence. `dashboard/src/api/endpoints.ts:1443` (`updateContact(contactId,
patch: ContactPatch)`); grep of dashboard/src finds no `patchContact`.

Implication. A literal builder either adds a duplicate endpoint wrapper
(section 7 says endpoints.ts edits are additive, so it would be allowed) or
mocks the wrong name. Name `updateContact`.

## F10 [LOW] The requested ContactItem comment ("nothing machine-writes either field") is false for park_reason

What is wrong. 3.1 declares `staff_notes` next to `park_reason` "with a comment
that nothing machine-writes either field". `park_reason` is machine-written by
the transition service on every parked move, and by seeds.

Evidence. `app/src/services/statusTransition.ts:163`; the adjacent existing
comment `app/src/repos/contactsRepo.ts:127-133` already says "Written by the
transition service"; seeds `app/src/lib/seed/cast.ts:1095`, `matrix.ts:862`.

Implication. The spec would plant a comment contradicting the one directly
above it. Declare `staff_notes` / `staff_notes_updated_at` with their own
accurate comment (human-only via PATCH; server-stamped timestamp; AI excluded
by toProfile's explicit field list).

## F11 [LOW] "TenantFile" is not tenant-only: team_member contacts get the card; a retyped tenant's notes become invisible

What is wrong. 3.6/3.7 say "tenant files only". ContactDetail renders
TenantFile for every type that is not landlord/partner/unknown - i.e. tenant AND
team_member. Conversely a tenant retyped to landlord/partner/unknown keeps
`staff_notes` on the record with no surface that shows or edits it.

Evidence. `dashboard/src/routes/contact/ContactDetail.tsx:551-558` (kind
derivation, else -> 'tenant'); `ContactType` includes team_member
(`app/src/repos/contactsRepo.ts:51`).

Implication. Small, but the spec should state the team_member behavior and that
retype hides (does not delete) staff notes, ideally in the filed
`staff-notes-on-landlord-partner-files` issue.

## F12 [LOW] Minor misstatements of current behavior

- 2.1 quotes the empty-PATCH 400 as "patch body must include at least one
  field" (line 713). That string is the TOURS route (`tours.ts:1029`); contacts
  returns "no updatable fields supplied" (`contacts.ts:714`). A test written
  against the quoted string fails.
- 2.2 says the arm "silently skips a rung whose dueAt is already past". For a
  past-dated create, `day_before` hits the booked-too-late branch FIRST and
  writes a visible skipped row (`app/src/jobs/tourReminders.ts:564-585`, checked
  before the `dueAt < now` skip at 587-590). "Sends nothing" still holds.
- 2.2 says a toured tour with an outcome and no conversion is "reachable only
  when that conversion failed". TourDetail's own header names the other path:
  an API-recorded outcome (`TourDetail.tsx:14-17`); tours-page.spec.ts records
  outcomes via the API. An API `{outcome:'not_a_fit', moveForward:false}`
  without `status:'closed'` leaves toured + not_a_fit, for which TourDetail
  renders no primary CTA at all (TourDetail.tsx:528-558).
- 3.4 says `applyExtraction` "writes `notes` only". It also commits direct
  field writes (`app/src/services/extraction/apply.ts:455-460`); the point
  (never `staff_notes`) stands because those keys come from the schema.
- Q1 says the 400 KB item limit is "the only hard ceiling". A single save is
  capped first by express.json's default 100 KB body limit
  (`app/src/app.ts:136`, no `limit` option), which yields a 413 the card will
  render as a machine-code alert.

## F13 [LOW] 90-day arithmetic is unpinned; a mismatched test goes red for part of the year

What is wrong. 4.2 says `from` = "start of today local minus 90 days" and the
test asserts the same phrase. Calendar-day subtraction (`new Date(y, m, d -
90)`) and millisecond subtraction (the existing `toursDateRange` style,
useTours.ts:37-41) differ by one hour whenever the 90-day span crosses a DST
change - roughly March-June and November-January in US zones.

Implication. If the helper and its test pick different arithmetic, the unit
test passes today (Sep 26, no crossing) and fails from early November. Pin
calendar-day arithmetic in the spec.

## F14 [LOW] The row "Mark toured" diverges from the recorded TourDetail decision without saying so

What is wrong. TourDetail's Mark toured "flows STRAIGHT into the exit gate
(Cameron, 2026-08-06): recording the outcome is what you came to do". The Past
row's single "Mark toured" does not open the dialog.

Evidence. `dashboard/src/routes/tours/TourDetail.tsx:312-323`.

Implication. Probably right for bulk; for the single-row button it contradicts
a recorded product decision. The spec should acknowledge it as a planner
decision in section 9, or make the single-row path navigate to
`?outcome=1` after success.

## F15 [LOW] Runner and view-state lifecycle underspecified

- Only the bulk button is disabled while busy (4.5). A per-row "Mark toured"
  clicked mid-batch re-enters the runner, whose step 1 clears results and
  resets busy - interleaved runs. Say every row action is disabled while busy.
- `reload()` via a hook shaped like `useClosedTours` sets `status: 'loading'`
  (useTours.ts:116), which the page renders as a full-list spinner - the list
  and its just-rendered per-row result lines blink out. Say reload keeps the
  current rows until the refetch lands.
- "Until ... a navigation away": `/tours`, `/tours/past`, `/tours/closed`
  render the same `ToursPage` element type at the same position, so React
  Router likely PRESERVES page state across tab switches (UNVERIFIED by
  running; consistent with how useClosedTours re-enables on the `closed` prop
  flip rather than on mount). Selection/results held in ToursPage would
  survive Past -> Active -> Past. Put them in a Past-only child or key the view.

## F16 [LOW] Unpaginated range query truncates the NEWEST past tours first

The spec files `tours-scheduled-range-query-unpaginated` and says "the Active
window has the same ceiling". The Query reads ascending by scheduledAt
(`toursRepo.ts:347-364`, one page). For Active a truncated page loses the
farthest-future tours; for Past it loses the MOST RECENT - the top of a
most-recent-first list - and the Past window is three times longer and carries
every closed/canceled tour in range (client-side filter). Same debt, worse
failure direction. Record that in the issue.

## F17 [LOW] Past copy contradicts Q3

The 4.1 intro ("tours that were never marked toured, toured tours still waiting
on an outcome, and no-shows") and section 1 omit the toured-WITH-outcome rows
Q3 deliberately lists. Either the copy names them or Q3 is dropped.

## F18 [LOW] One shared free-text box with no concurrency control and no live refresh

There is no contact SSE event (`app/src/lib/events.ts` has none), and the PATCH
is a blind SET. Two staff with the file open: the second Save overwrites the
first silently, and the card's "draft equals stored value, no request" check
compares against a stale value. Parity with `notes` via the edit dialog, but
`notes` is not the field staff are told to use for shared jottings. At minimum
file it; an `If-Unmodified-Since`-style check on `staff_notes_updated_at` is
cheap.

## F19 [LOW] Error copy appends raw `ApiError.message`

3.6 appends "the API error message" and 4.5 renders "Could not mark toured:
<message>". `ApiError.message` is `code (detail)`
(`dashboard/src/api/client.ts:75-77`), e.g. `illegal_status_transition (a
closed tour cannot be changed ...)`. TourDetail's own comment forbids this for
user copy ("NEVER err.message - that is the raw machine code",
TourDetail.tsx:346-352). Map codes to sentences or show only the generic line.

## F20 [LOW] The tour page's back link returns to Active, not Past

`TourDetail.tsx:595` hard-codes `<Link to="/tours">`. The Past workflow (row ->
tour page -> record outcome -> back) drops staff on Active each time. Worth a
sentence (or `navigate(-1)` when the referrer is a tours tab); not a blocker.
