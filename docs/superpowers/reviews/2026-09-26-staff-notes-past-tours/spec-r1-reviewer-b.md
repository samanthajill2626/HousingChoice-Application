# Spec review R1 (reviewer B, adversarial) - staff notes + Past tours tab

Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` (DRAFT 1, commit 525ec886)
Code read at: worktree `W:\tmp\staff-notes-past-tours`, HEAD 2e6a873a (525ec886 plus the three filed issue files; no code delta from base 0dafe3c1)
Method: read-only. Every claim below cites a file:line that was read. Nothing was executed (no test suites, no e2e). Anything inferred rather than read is marked UNVERIFIED.

Severity is by consequence if the spec ships unfixed.

---

## 1. [HIGH] The "never touches a tour that is not scheduled" guarantee is not delivered by the mechanism: the guard reads a stale snapshot and the server accepts canceled -> toured and no_show -> toured

**What is wrong.** Spec 4.5 (lines 356-359) promises the batch "never touches a tour that is not `scheduled` (the checkbox exists only on those rows, and the runner refuses an id whose listed status is not `scheduled`)". Both halves of that mechanism key on the LISTED status - a snapshot fetched once when the tab mounted. Nothing refreshes it: `useTours.ts` has no event subscription and the spec's `usePastTours` is modeled on `useClosedTours` (fetch on enable only). The server does not backstop it:

- The PATCH transition guard (`app/src/routes/tours.ts:1065-1119`) refuses only: anything out of `closed` (1076), a move INTO `requested`, the three non-exits from `requested`, and a move to `scheduled` from a non-reschedulable status (1112). `canceled -> toured` and `no_show -> toured` are legal 200s. A same-status `toured -> toured` is also a 200.
- `PATCH_ALLOWED` (`tours.ts:145`) is `scheduledAt, status, outcome, moveForward`; there is no expected-status / If-Match precondition the client could send.

**Failure story.** Staff A opens `/tours/past`. Staff B, on the tour page, marks tour X no-show (or cancels it - "it never happened"). A ticks X (or uses Select all) and clicks "Mark toured (N)". The server moves X to `toured`, returns 200, the row reads "Marked toured", and `recordTourEvent(..., 'tour_took_place', ...)` (`tours.ts:1425`) writes a false "Tour took place" milestone into the tenant timeline and the property audit. B's no-show determination is silently overwritten. A bulk control multiplies this.

**Amplifier (same section).** Step 3 keeps the selection for failed ids and step 4 reloads. A failed id whose tour was closed or canceled elsewhere is no longer a "Not marked" row after the reload (or not listed at all), yet it stays selected: "Mark toured (N)" counts a row the user cannot see, and the spec does not say what "refuses an id whose listed status is not scheduled" does for an id that is not listed at all.

**What it implies.** Either (a) the runner re-reads each tour (`getTour`, already in `endpoints.ts:2176`) immediately before its PATCH and skips with a per-row "Changed since the list loaded" result unless `status === 'scheduled'` - client-only, fits the current file list, narrows the window to one round trip; or (b) a server-side precondition (adds `tours.ts` to the files touched). And after `reload()` the selection must be intersected with the current "Not marked" rows. The guarantee sentence must describe whichever mechanism is chosen.

---

## 2. [HIGH] The spec-mandated aria-labels break an existing e2e spec, and the spec's own `getByLabel('Staff notes')` claim is not guaranteed

**What is wrong.** Spec 3.6 gives the new card's aside action the aria-label "Add staff notes" (empty) or "Edit staff notes" (filled), and places the card on every tenant file. The existing spec `e2e/tests/dashboard-next/contact-detail.spec.ts` runs on the SAME seeded tenant (`contact-tenant-0001`, line 11) and, with the Edit dialog open, does:

- line 59: `const notes = page.getByLabel('Notes');` then `.fill(marker)`
- line 73: `await page.getByLabel('Notes').fill('');`

Both are PAGE-scoped, not dialog-scoped. Playwright's `getByLabel` matches an element's associated `<label>` OR its `aria-label` attribute, and without `exact: true` it is a case-insensitive substring match (documented Playwright semantics; e2e pins `@playwright/test ^1.50.0`, `e2e/package.json:13`). "Add staff notes" contains "notes", so the locator resolves to two elements (the dialog's "Notes" textarea and the card's aside button) and `.fill()` fails with a strict-mode violation. Today the only other notes affordance on that page is "Add a note" (`TenantFile.tsx:251`), which does not contain the substring "notes", which is why the spec passes now. UNVERIFIED by execution (read-only review), but the mechanism is direct.

Same trap inside the spec's own claim (3.6, "a visible `<label>`, so `getByLabel('Staff notes')` resolves it"): the aside button's aria-label "Edit staff notes" / "Add staff notes" also substring-matches "Staff notes". The spec never says the aside action is hidden while in edit mode; if it stays rendered, `getByLabel('Staff notes')` resolves to two elements too.

**What it implies.** Gate 4 goes red on a spec the build never touched, and section 7 does not list `contact-detail.spec.ts`. Decide one: scope the existing locators to the dialog / `exact: true` (and add that file to section 7), or choose aside labels that do not contain "notes", and state that the aside action is hidden in edit mode (or require `exact: true` in the new spec).

---

## 3. [MEDIUM] Today's date is a blind spot: a tour marked toured or no-show today disappears from /tours until midnight, and the stated rule ("scheduled time has passed") is not what the window implements

**What is wrong.** Section 1 says Past lists tours "whose scheduled time has passed". The mechanism (4.2) is `to = start of today local - 1 ms`. Meanwhile Active filters its window to `status === 'scheduled'` (`useTours.ts:70`). So:

- A tour scheduled for 9:00 today is still "Upcoming / Today" at 17:00 and is NOT in Past - the stated rule is false for the whole current day.
- The normal same-day flow is TourDetail's "Mark toured" (`TourDetail.tsx:318-323`), which opens the outcome dialog; dismissing it leaves a `toured` tour with no outcome - the exact "Needs outcome" state Past exists to surface. That tour immediately leaves Active (not `scheduled`) and is not in Past (window ends yesterday). It is on no list until local midnight. Same for a no-show marked today.
- "Mark already toured" defaults its date to the current hour (`TourModals.tsx:198`, `currentHourLocal()`), so the default path also lands in today and is invisible until tomorrow.

**What it implies.** This is not a regression (these tours are invisible today too), but the spec states a rule its mechanism contradicts, and the most common "needs outcome" moment (just after the visit) is exactly the one the tab cannot show. Either say so plainly in section 1 and 4.2 ("tours dated before today") or pick a window/status split that covers today's non-scheduled tours without double-listing today's scheduled ones (e.g. Past takes `[today-90d, now]` but drops `scheduled` rows dated today, which Active already shows). This is a product call to record, not a silent default.

---

## 4. [MEDIUM] Timeless toured tours ("Mark already toured" with the date left blank) can never appear in Past, though the tab promises "toured tours still waiting on an outcome"

**What is wrong.** A `requested` tour may go straight to `toured` (`tours.ts:1086-1109`; `TourDetail.tsx:479-488`). The "Tour already happened" dialog makes the date optional, and blank sends no `scheduledAt` - its own comment says "the tour stays off the byScheduledAt index" (`TourModals.tsx:216-218`). Such a tour is `toured`, has no outcome, is not `requested` (so not in Needs booking), and is not in the `byScheduledAt` GSI (sparse, `app/src/lib/tables.ts:531-535`), so `getTours({ from, to })` never returns it. Spec 4.2 dismisses only `requested` ("never has a time"); it does not mention this `toured` population. The intro copy (4.1) - "toured tours still waiting on an outcome" - over-promises.

**What it implies.** Either add a second read (`getTours({ status: 'toured' })` - `listByStatus` already paginates, `toursRepo.ts:366-385` - keeping the rows with no `scheduledAt`, placed by `createdAt`/`updatedAt`) or record the exclusion as a known limit and narrow the intro copy. Silence is the one wrong answer: it is the stuck state the feature is for.

---

## 5. [MEDIUM] Section 2.2 and Q3 misstate how a `toured` tour with an outcome arises; the resulting "Not a fit" rows are permanently stuck in Past with no action anywhere

**What is wrong.** Spec 2.2 (lines 104-106): "a `toured` tour with an outcome recorded and no conversion is reachable only when that conversion failed". Q3 builds on it ("a stuck conversion"). False on three counts:

- API path: the exit gate never derives `closed` from a not-a-fit outcome; only the dashboard folds `status: 'closed'` into the PATCH. The repo already tracks this as open debt: `docs/issues/tour-outcome-close-not-backend-enforced.md` ("leaves the tour stuck at 'toured' with an outcome set, convertible false, no primary CTA on the page, and no obvious way forward").
- The page itself says so: `TourDetail.tsx:15-17` names "an API-recorded outcome" as a second route to a convertible-but-unconverted tour.
- Seeds: the full (demo) profile creates exactly these rows - `app/src/lib/seed/matrix.ts:1072-1087` gives each `toured` tour an outcome; rep 2 is `not_a_fit`, `moveForward: false`, status still `toured`; rep 1 is `move_forward`, `convertible: true`, unconverted. Their `scheduledAt` is 4 and 6 days back (`PAST_TOUR_DAYS`, matrix.ts:911-916), inside the Past window.

**Consequence.** A `toured` + `not_a_fit` tour renders in Past as "Not a fit" with no row action (4.4), and the tour page offers nothing either: `primaryCta` is null for toured + outcome + not convertible (`TourDetail.tsx:528-556`) and the kebab has no close action (`TourActionsMenu.tsx:12-41`). It sits in "tours that still need a human decision" for 90 days with no way to act on it - in the demo world on day one. Q3's rationale (keep it visible so a stuck conversion is noticed) does not apply to not-a-fit: there is no conversion to retry.

**What it implies.** Correct 2.2 and re-decide Q3 per outcome: `move_forward` + convertible (the tour page's "Start placement" is the action) is defensible to show; `not_a_fit` either should not be listed or needs an honest "no action here" treatment. Section 9 should record the corrected premise.

---

## 6. [MEDIUM] The GLOSSARY already calls contact `notes` "internal staff notes"; adding a field named "Staff notes" makes it wrong, and the spec does not update it

**What is wrong.** `documentation/GLOSSARY.md:141-144` defines Unit `notes` as "free-form INTERNAL staff notes on a property (the contact `notes` counterpart)". So the canonical vocabulary currently says contact `notes` ARE the internal staff notes. This spec introduces `staff_notes` / "Staff notes" as a DIFFERENT field from `notes` (the "Preferences & notes" card, which the AI appends to). AGENTS.md ("Product vocabulary") requires the glossary to be updated in the same change when a domain noun is added or drift is fixed. Section 7 does not list `documentation/GLOSSARY.md`.

**What it implies.** Two things now answer to "staff notes" in the canonical doc. Add a glossary entry distinguishing contact `notes` (Preferences & notes; AI-appended `[Auto - <date>]` lines) from `staff_notes` (human-only, AI never reads or writes), fix the Unit `notes` line's "counterpart" wording, and add the file to section 7.

---

## 7. [LOW] The spec names functions that do not exist

- `patchContact(contactId, ...)` (3.6 lines 223, and the section 5 StaffNotesCard test "Save calls `patchContact`"): there is no such dashboard function. The contact PATCH client is `updateContact` (`dashboard/src/api/endpoints.ts:1443`), already used by `ContactEditForm.tsx:376` and `ConsentCaptureModal.tsx:52`. A literal build adds a duplicate PATCH wrapper to `endpoints.ts`.
- "the same formatter the Closed tours rows use" (3.6): `formatDate` is module-private in `dashboard/src/routes/tours/ToursPage.tsx:77`. Exporting it from a route module into `contact/` or duplicating it is an unstated choice.

Implication: name `updateContact`; say where the date formatter lives.

---

## 8. [LOW] Wrong error string attributed to the contacts PATCH

Spec 2.1 (line 51) says a body with no known field is a 400 "patch body must include at least one field" (line 713). The contacts parser returns `'no updatable fields supplied'` (`app/src/routes/contacts.ts:714`). The quoted string is the TOURS PATCH message (`tours.ts:1029`). The section 5 test "PATCH `{ staff_notes_updated_at }` alone -> 400" will be written against the wrong text if the builder copies it.

---

## 9. [LOW] "A past-dated create arms nothing" (Q8, 2.2) is inaccurate; it writes a visible skipped reminder row

`armTourReminders` evaluates BOOKED-TOO-LATE before the silent past-dueAt drop (`app/src/jobs/tourReminders.ts:564-585`): for a tour 1-3 days back, `day_before` is born as a visible `booked_too_late` skipped row; only `morning_of`/`en_route` drop silently. The create also points the tour at the new ladder (`tours.ts:354-361`), emits `scheduled.updated`, and writes a "Tour scheduled" milestone. `e2e/tests/tour-no-show-checkin.spec.ts:71-82` documents the same derivation. The conclusion the spec needs ("sends nothing") holds; the description does not, and the e2e tours' Reminders panels will show skipped rows.

---

## 10. [LOW] The Staff notes card will also render on team-member contacts

Spec 3.6 heading: "(tenant files only)". But `ContactDetail.tsx:551-558` maps every type that is not landlord/partner/unknown - i.e. tenant AND `team_member` - to `TenantFile`, the only render site (`ContactDetail.tsx:1058`). The mechanism puts "Staff notes" on staff members' own contact pages. Either gate on `contact.type === 'tenant'` or state the team_member case.

---

## 11. [LOW] Q1's "400 KB DynamoDB item is the only hard ceiling" is false

`app/src/app.ts:136` mounts `express.json({ verify: captureRawBody })` with no `limit`, so Express's default 100 KB body limit applies. A save above that fails before the route and the card shows its generic failure. Parity with `notes` still holds; the stated ceiling does not. Correct the sentence (and the failure copy expectation) or set a real cap.

---

## 12. [LOW] The ContactItem comment the spec prescribes would be false for `park_reason`

Spec 3.1: declare `staff_notes` next to `park_reason` "with a comment that nothing machine-writes either field". `park_reason` is written - and REMOVEd via null - by the transition service on the parked move (`app/src/services/statusTransition.ts:163`; the field's own doc at `contactsRepo.ts:128-133` says so), and the seeds write it (`app/src/lib/seed/cast.ts:1095`, `matrix.ts:862`). Also note `park_reason` IS accepted on create (`contacts.ts:784-787`) while `staff_notes` deliberately is not, so the "both plain staff text" pairing is looser than stated. Write the comment about `staff_notes` alone.

---

## 13. [LOW] Quoted empty-state copy does not match the code

Spec 2.1 quotes the Preferences & notes empty copy as "No preferences yet - added manually for now." The code's string has an EM DASH (U+2014) where the spec has " - " (`TenantFile.tsx:262`). The staff-notes e2e asserts that card "still shows its empty copy"; a literal copy of the spec's string fails. Use the code's string (via a regex that tolerates the dash, since new spec lines must stay ASCII).

---

## 14. [LOW] Result/selection lifecycle is underspecified

- A row that fails because its tour was closed/canceled elsewhere drops out of the list on `reload()`, so its "Could not mark toured: ..." line (4.5, "rendered under the row") is never seen - the "each row reporting its own success or failure" promise (section 1) fails for exactly the rows that most need it.
- Only the bulk button is "disabled ... while a batch is running"; the per-row "Mark toured" (which "runs the same runner") is not, and runner step 1 clears previous results - a row click mid-batch starts a second concurrent runner and wipes the first batch's results.
- "until the next batch or a navigation away": `/tours`, `/tours/past`, `/tours/closed` render the same `ToursPage` component type at the same position (`App.tsx:239-240`), so React preserves its state across tab switches; selection and results survive Past -> Active -> Past unless explicitly reset on `view` change. (UNVERIFIED by execution; follows from React reconciliation, and matches `useClosedTours`' "re-fetching fresh each time the view shows" design, `useTours.ts:106-110`.)

Implication: disable every mark control while busy; keep failed-and-vanished rows visible (or summarize them above the list); reset selection/results on view change.

---

## 15. [LOW] Row accessible names are not unique - including in the spec's own e2e fixture

Row link "Tour for <tenant> at <property>", checkbox "Select tour for <tenant> at <property>", buttons "Mark toured: <tenant> at <property>" / "Record outcome: <tenant> at <property>" collide whenever a tenant has two past tours at the same property (a no-show and a later tour is ordinary). The spec's `tours-past.spec.ts` creates three tours for the SAME seeded tenant and SAME unit, so all three row links share one name, and the accessibility-first selectors the repo requires (`e2e/support/selectors.md`) cannot tell them apart. Put the date-time in the labels.

---

## 16. [LOW] "No staff notes yet." over "Last edited <date>" after a clear; e2e cleanup is not a revert

3.2 re-stamps `staff_notes_updated_at` on a clear and 3.6 shows "Last edited" whenever it parses, so a cleared card reads "No staff notes yet." above "Last edited Sep 26, 2026". The e2e's "Edit -> clear -> Save (cleanup)" leaves the seeded tenant with `staff_notes: ''` plus a stamp, so the next spec on `contact-tenant-0001` that does not reseed sees the "Last edited" line (the contact-detail spec's header states the revert-to-pristine convention). Decide the cleared-state copy; reseed in the new spec's `beforeAll` rather than relying on a partial revert.

---

## 17. [LOW] The filed issue `tours-scheduled-range-query-unpaginated` misstates its readers and misses the direction of truncation

`docs/issues/tours-scheduled-range-query-unpaginated.md` lists "the reminder and no-show sweeps" as readers. The only callers of `listByScheduledRange` are `app/src/routes/today.ts:550` and `app/src/routes/tours.ts:413`; there is no no-show sweep (the no-show check-in is manual, `tours.ts` terminal-branch comment). It also omits that the Query returns ascending `scheduledAt`, so a truncated 90-day page drops the NEWEST tours - the ones Past sorts to the top. Correct the refs and name the consequence.

---

## Checked and found accurate (no finding)

- `parseTriageBody` is an allowlist that ignores unknown keys (`contacts.ts:502-717`); `staff_notes_updated_at` from a client is dropped; alone it is a 400.
- `contacts.update` is a SET-merge returning ALL_NEW (`contactsRepo.ts:1262-1350`); no contact code path does a full-item Put except create/createIfAbsent/pointers, so no read-modify-write clobbers `staff_notes`.
- `toProfile` is an explicit field list (`app/src/jobs/extraction.ts:131-159`); `applyExtraction` writes `notes` only (`app/src/services/extraction/apply.ts:689-704`); the only LLM call sites are the extraction adapter/job/prompt. Broadcast merge fields are an allowlist (`app/src/lib/mergeFields.ts`). Public routes never return a contact.
- `GET /api/contacts/:id` spreads the whole item (`contacts.ts:1115-1117`), so the field round-trips on reload.
- The `byScheduledAt` GSI projects ALL (`tables.ts:14`), so `outcome` is present on range-query rows.
- The lean seed has no tours; e2e runs `workers: 1`, `fullyParallel: false` (`e2e/playwright.config.ts:140-141`).
- `TourDetail` loads the tour before mounting `TourDetailLoaded` (`TourDetail.tsx:97-134`), so a one-shot `?outcome=1` read after load is feasible.
