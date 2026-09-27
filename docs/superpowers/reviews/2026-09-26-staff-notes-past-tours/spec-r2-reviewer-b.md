# Spec review R2 (reviewer B, adversarial) - staff notes + Past tours tab

Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` DRAFT 2 (commit 212020f0)
Also read: `spec-r1-adjudications.md`, `spec-r1-reviewer-a.md`, `documentation/GLOSSARY.md` (new entry), `docs/issues/past-tab-timeless-toured-tours.md`, `docs/issues/past-tab-no-show-rows-need-an-exit.md`, the corrected `docs/issues/tours-scheduled-range-query-unpaginated.md`.
Code read at: worktree HEAD 212020f0 (no code delta from base 0dafe3c1). The worktree has no `node_modules`; React Router internals were read (never executed) from the shared checkout's installed `react-router` 7.18.0 by absolute path, without cd.
Method: read-only; nothing executed. Every claim about existing behavior cites a file:line that was read; inferences are marked UNVERIFIED.

Order: new findings by severity, then a check of the fixes, then contested adjudications.

---

## 1. [HIGH] The new pre-read guard checks STATUS only: a past tour that was RESCHEDULED since the list loaded passes it, is marked toured, loses its freshly armed reminders, and then vanishes silently

**What is wrong.** 4.5 step 2 re-reads each tour and skips unless "the CURRENT status is `scheduled`". But a reschedule does not change status:

- From `scheduled`: the tour page offers Reschedule on a scheduled tour (`RESCHEDULABLE_UI` includes `scheduled`, `TourDetail.tsx:90-94`), and `confirmReschedule` sends `{ scheduledAt, status: 'scheduled' }` (`TourDetail.tsx:467-469`). A past "Not marked" tour that never happened and is rebooked for Friday is still `scheduled`.
- From `no_show`: Reschedule is also offered on a no-show (same set). `confirmReschedule` sends `status: 'scheduled'` explicitly, which `canReschedule('no_show')` allows (`RESCHEDULABLE`, `toursModel.ts:118-123`), and a bare time change auto-advances it anyway (`tours.ts:1166-1170`).

Either way the re-read sees `scheduled` and the runner PATCHes `status: 'toured'`. That is a real transition (`tours.ts:1222-1229`), so the terminal branch runs: the pointer rotates and `reminders.deleteSupersededForTour(tourId, rotation)` (`tours.ts:1354-1378`) DELETES every never-sent rung, which here is the ladder just armed for Friday. `recordTourEvent(..., 'tour_took_place', ...)` (`tours.ts:1425`) writes "Tour took place" on the tenant timeline and the property audit.

**It is then silent.** After `reload()` the tour is `toured` with a `scheduledAt` in the future, so it is outside the Past window (`to = now`, 4.2) and, not being `scheduled`, outside Active (`useTours.ts:70`). Its "Marked toured" line has no row to sit under. The new above-toolbar block reports only FAILED ids that vanished (4.5 last paragraph), not successes. So the rebooked visit disappears from every list, the tenant gets no reminders for it, the timeline records a visit that did not happen, and the UI says nothing.

This is the same stale-list class as R1 finding 1 (accepted), in the one variant the accepted fix does not cover. 4.7's invariant ("never PATCHes a tour whose current status is not `scheduled`") is literally kept and misses what it was meant to protect. Minor footnote: the re-read is `GET /api/tours/:tourId`, which reads without `ConsistentRead` (`tours.ts:432-434`, `toursRepo.ts:325-337`). So the window is one round trip plus DynamoDB's eventual-consistency lag, not one round trip. That is acceptable; just say it.

**What it implies.** Re-apply the Past rule itself to the re-read row: skip unless the current status is `scheduled` AND the current `scheduledAt` is before the start of today local (or equals the listed `scheduledAt`). Both are client-only and inside the current file list. Report a success whose row is not listed after the reload in the above-toolbar block too, or make the block cover every result whose row disappeared.

---

## 2. [MEDIUM] Stripping `?outcome=1` with a replace navigation drops `location.state`, so the new back arrow returns to /tours on exactly the Record-outcome path. The spec's own e2e step fails.

**What is wrong.** 4.6 specifies two things on the same page:

- the param is removed "with a `replace` navigation" (DRAFT 1's 4.6 named the mechanism, "one effect and one `useSearchParams`"; DRAFT 2 keeps the behavior), i.e. `setSearchParams(..., { replace: true })`;
- the back arrow reads `location.state.back`, set by the Past tab's links.

In the installed React Router, `setSearchParams` is `navigate("?" + newSearchParams, navigateOptions)` (`node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:10851-10857`, v7.18.0). A navigation creates the new location with `state = null` unless `navigateOptions.state` is passed (`createLocation(current, to, state = null, ...)`, same file line 234). The dashboard uses `BrowserRouter` (`dashboard/src/main.tsx:16`). So the replace that strips `?outcome=1` replaces `{ back: '/tours/past' }` with `null`, and the back arrow falls back to `/tours`.

Section 5 (tours-past.spec) does exactly this sequence: follow "Record outcome" -> the dialog open "and no `?outcome` in the URL" -> Cancel -> "the back arrow returns to `/tours/past`". A literal build fails that step. The TourDetail unit test in section 5 (the back arrow honors `state.back`) will pass if it mounts without `?outcome=1`, so the break shows up only in e2e.

Also ambiguous: "In both cases the param is removed". If a builder strips unconditionally (even when no param is present), the row-link path loses its state too.

**What it implies.** 4.6 must say the strip carries the state forward (`setSearchParams(next, { replace: true, state: location.state })`, or `navigate({ search: '' }, { replace: true, state: location.state })`), that it runs only when the param is present, and a unit test must mount with BOTH `?outcome=1` and `state.back`.

---

## 3. [LOW] `to = now` contradicts Q9's own rule for a tour marked toured or no-show before its scheduled time; `to` = end of today costs nothing

Q9: "Past therefore runs to `now` and lists today's toured and no-show rows". It lists only those whose `scheduledAt <= now`. The tour page marks toured at any time (`canMarkNoShow`/Mark toured have no time gate: `TourDetail.tsx:261`, `tours.ts` has no time guard per spec 2.2). A 17:00 tour the tenant turned up early for, marked toured at 15:00 with the dialog dismissed, is `toured` (so not on Active, `useTours.ts:70`) with `scheduledAt` 17:00 > now (so not in Past). It is on no list until 17:00 and a refetch. The same goes for any tour marked toured or no-show ahead of its date.

Step 2 of 4.2 already drops every `scheduled` row dated today. So `to` = end of today local (`new Date(y, m, d + 1)` minus 1 ms, same calendar arithmetic as `from`) lists every toured and no-show row dated today and adds no scheduled row. That makes Q9 true as written. Tours marked toured on a FUTURE date stay invisible until that date, which is worth one sentence.

---

## 4. [LOW] The toured-with-outcome exclusion is broader than its premise: it also hides a failed move_forward conversion, which the Past tab's own Record-outcome path can now create

4.2 step 3 drops every `toured` row with an `outcome`, justified in Q3 by "the tour page's 'Start placement' is the retry for a stuck move_forward conversion". That answers WHAT to click, not WHERE staff find the tour. A toured + move_forward + `convertible: true` + no `convertedPlacementId` tour is on no list: not Active (`useTours.ts:70`), not Closed (status), no placement exists, and now not Past. DRAFT 1's Q3 made exactly this argument for listing it.

The Past tab is now the most likely origin of such a tour. "Record outcome" deep-links into the dialog, and move_forward immediately POSTs from-tour (`TourDetail.tsx:489-512`). If that POST fails, the header alert shows once (`TourDetail.tsx:512-515`), and after that the tour is invisible.

A narrower rule loses none of what R1 finding 5 asked for: drop a toured row with an outcome UNLESS `convertible === true && convertedPlacementId === undefined`, and show that one with a "Start placement" chip and no row action (the tour page has the CTA, `TourDetail.tsx:534-539`). The not_a_fit case stays excluded, which was the point of R1 finding 5. Low because a failed conversion is rare and shows an error at the moment it happens.

---

## 5. [LOW] Runner result copy and data: a doubled phrase, and an alert block whose labels the spec never says to capture

- 4.5 step 2d records `{ ok: false, message: 'Could not mark toured' }` for a PATCH failure. The row line is "Could not mark toured: <message>", so it renders "Could not mark toured: Could not mark toured". Use a message such as "Request failed", or render the step-2d case bare.
- The above-toolbar block prints "<tenant> at <property> on <date-time>: <message>" for an id that is no longer listed after the reload. By definition that id's row data is gone from `past` at render time. The runner must snapshot each id's tenant, property and date-time labels at batch start, and the spec does not say so. A builder who looks the id up in the reloaded list prints nothing.

---

## 6. [LOW] 4.4 still claims the row's "Mark toured: ..." label "never collides with the bulk button". Under Playwright's default matching it does collide.

`getByRole('button', { name: 'Mark toured' })` is a case-insensitive substring match and resolves to the bulk "Mark toured (N)" and every row "Mark toured: ... on ..." button. Reviewer A raised this (F6 point c: require exact or regex names for the bulk button). The adjudication folded A6 into B2 and addressed only the notes locators. Either drop the claim or require `exact: true` / an anchored regex (`/^Mark toured \(\d+\)$/`) in both new specs' bulk-button locators.

---

## 7. [LOW] Section 5 says contact-detail.spec "already holds" the Edit-dialog locator. It does not.

Section 5: lines 59 and 73 "become `dialog.getByLabel('Notes')` where `dialog` is the Edit dialog locator the test already holds". The test holds no such variable. Line 58 is an inline `expect(page.getByRole('dialog', { name: /Edit contact/i })).toBeVisible()`, and the cleanup at lines 72-73 clicks Edit and goes straight to `page.getByLabel('Notes')` with no dialog reference (`e2e/tests/dashboard-next/contact-detail.spec.ts:57-59, 72-73`). The builder must introduce the locator in both places. Scoped to the dialog, "Notes" is unique: the only label containing "notes" in the form is the Notes textarea (`ContactEditForm.tsx:782`). State it as "introduce", not "reuse".

---

## 8. [LOW] 3.4 still says `applyExtraction` "writes `notes` only", and the planned test checks the wrong call

`applyExtraction` also commits all direct field writes in one `deps.contacts.update(contactId, writePatch)` (`app/src/services/extraction/apply.ts:455-460`), separate from the notes append (`apply.ts:704`). Reviewer A flagged this (F12, fourth bullet); the fold into "B8 + B9 + B5 + B11" dropped it. The conclusion (never `staff_notes`) holds, because `writePatch` keys come from the extraction schema. But the section 5 test "an extraction apply that appends a note line writes a notes-only patch" passes vacuously if the fixture also direct-writes, since it checks one call. Assert that NO `contacts.update` call made by the apply carries a `staff_notes` or `staff_notes_updated_at` key, and correct the 3.4 sentence.

---

## 9. [LOW] Glossary edit: three small inaccuracies

- The Unit `notes` entry still opens "free-form INTERNAL staff notes on a property" (GLOSSARY.md, the edited line). Now that "Staff notes" is a proper noun for a different contact field, the phrase invites the conflation the entry is trying to prevent. "Free-form internal notes on a property" says the same thing.
- The new entry says the companion stamp "renders as 'Last edited <date>'", unconditionally. Spec 3.6 renders it only when the trimmed value is non-empty.
- Spec 3.8 says the entry goes "under the contact vocabulary"; it was placed under "Feature & label notes". Harmless, but spec and file disagree.

---

## Were the fixes actually correct? (checked; no finding unless numbered above)

- Tenant-only gate (3.6): `contact.type === 'tenant'` inside TenantFile is correct. TenantFile's only render site is `ContactDetail.tsx:1058`, reached for tenant and team_member (`ContactDetail.tsx:551-558`), and the existing `files.test.tsx` tenant fixture is `type: 'tenant'` (line 53), so its expectations are unaffected.
- Aside hidden in edit mode plus `getByLabel('Staff notes', { exact: true })`: resolves uniquely. No other element carries that exact label, and the heading is an h3, not a label.
- contact-detail.spec scoping: correct once the dialog locator is introduced (finding 7).
- Shared component instance across tabs (2.2): VERIFIED in code. React Router renders each match as `RenderedRoute` with no `key` (`chunk-4ZMWKKQ3.mjs:6329-6339`), so `ToursPage` state survives a Past/Active/Closed switch, and the spec's explicit reset on view change is needed and sufficient.
- Calendar-arithmetic `from` (4.2) and the thread-store no-send proof (`e2e/fixtures/fakeTwilio.ts:201-212, 375-379`; no mid-suite reset, 381-386): correct.
- Derived selection (4.5): correct. It fixes the R1 hidden-selected-id amplifier.
- Every mark control disabled while busy, and the runner ignoring re-entry: correct.
- Corrected current-behavior claims (2.1, 2.2): all re-checked and accurate, including `contacts.ts:714`, `app.ts:136`, `tours.ts:1425`, `TourDetail.tsx:595`, and the two `listByScheduledRange` callers.

---

## Contested adjudications

### 10. CONCEDE (with one residual) - B4, timeless toured tours, DEFERRED

The deferral stands. The hole is now documented (4.2 known limits, Q10, non-goals), filed at med, and my R1 finding offered exactly that option. Two residuals, both small:

- The 4.1 intro copy is unchanged and still promises "toured tours still waiting on an outcome" with no exception. The documentation half of my R1 option (narrow the copy) was not done. One clause fixes it: "...waiting on an outcome (with a tour date)".
- The adjudication rests the deferral on the literal mission text ("tours whose scheduled time is before the start of today"), yet Q9 in the same draft overrides that literal text to include today's rows. The deferral is still reasonable on cost (a second read plus an undated-row placement rule). The stated reason just is not the real one, and the handback should not quote it as a mission constraint.

### 11. CONCEDE - A18 REJECT (last-write-wins) and A4 DEFER (no-show exit)

Both rulings are defensible on the evidence. `contacts.update` has no version check (`contactsRepo.ts:1262-1350`), the AI's own notes append accepts the same race (`apply.ts:686-690`), and no contact SSE exists. A no-show exit is a status-model product call, and the server already allows `no_show -> canceled`, as the filed issue says. No contest.
