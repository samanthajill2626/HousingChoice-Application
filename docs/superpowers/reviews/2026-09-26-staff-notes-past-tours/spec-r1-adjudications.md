# Spec review round 1 - adjudications

Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`
DRAFT 1 @525ec886 -> DRAFT 2 (this round).
Reviewers: A (`spec-r1-reviewer-a.md`, 20 findings) and B
(`spec-r1-reviewer-b.md`, 17 findings), independent, same brief, opus.
Planner: Fable (this session), overnight unattended run - no human in the loop;
every ACCEPT below is the planner's call and is listed in the spec's section 9
where it is a product decision.

Verification: every load-bearing claim was re-read in the worktree before the
ruling (file:line in the reviewer reports; the planner re-read tours.ts
1065-1128 and 1424-1426, TourModals.tsx 212-218, matrix.ts 1068-1090,
GLOSSARY.md 141-145, endpoints.ts 1443, contacts.ts 712-716, ContactDetail.tsx
549-558, app.ts 136, tourReminders.ts 560-586, TourDetail.tsx 595,
fakeTwilio.ts 196-210 and 375-379, and the callers of listByScheduledRange).

Counts: 37 findings -> 26 ACCEPT (13 changed a decision), 3 DEFER (issues
filed), 2 REJECT, 6 duplicates folded into their twin.

## Decision-changing accepts

| # | finding | ruling |
|---|---|---|
| B1 / A3 | the bulk guard keys on a stale list; the server allows canceled -> toured and no_show -> toured | ACCEPT. The runner re-reads each tour (`getTour`) immediately before its PATCH and skips with the per-row result "Changed since the list loaded" unless the CURRENT status is `scheduled`. Selection is the intersection with the currently listed "Not marked" rows after every reload. Spec 4.5, 4.7. |
| B2 / A6 | "Add staff notes" / "Edit staff notes" aria-labels break `contact-detail.spec.ts:59,73` (page-wide substring `getByLabel('Notes')`) and the spec's own `getByLabel('Staff notes')` claim | ACCEPT. The existing spec's two locators are scoped to the dialog (`dialog.getByLabel('Notes')`) - the loose locator is the defect, and the file joins section 7. The new spec uses `exact: true`. The card's aside action is HIDDEN in edit mode (stated). Spec 3.6, 5, 7. |
| B3 / A1 | Past ends at start of today, Active shows only scheduled, so a tour marked toured or no-show TODAY is on no list until midnight; the stated rule contradicts the window | ACCEPT. Past's window is `[start of the local day 90 calendar days ago, now]`; a `scheduled` row dated today is dropped (Active's Today group already shows it); toured and no-show rows from earlier today are listed. Rule restated in words. Spec 1, 4.2, 9 Q9. |
| B5 / A12c | 2.2 and Q3 misstate how toured-with-outcome arises (API not_a_fit without close; the full-profile seed); such rows would sit in Past with no action anywhere | ACCEPT. Premise corrected. Past lists a `toured` tour only when it has NO outcome; a toured tour with an outcome has had its decision and is excluded (the tour page's "Start placement" is the retry for a stuck move_forward; the not_a_fit-without-close case is the open issue `tour-outcome-close-not-backend-enforced`). `pastState` has three cases. Q3 rewritten. |
| B10 / A11 | TenantFile also renders for team_member contacts | ACCEPT. The card renders only when `contact.type === 'tenant'`. Spec 3.6. |
| B14 / A15 | result and selection lifecycle underspecified: failed-and-vanished rows, row buttons live during a batch, state survives tab switches, reload blanks the list | ACCEPT. Every mark control (row buttons, checkboxes, the bulk button) is disabled while a batch runs and the runner ignores a second call; results for ids no longer listed after the reload render in an alert block above the toolbar; selection and results reset when the view changes; `reload()` keeps the rows on screen. Spec 4.5. |
| B15 / A7 | row accessible names collide for one tenant + one property (the spec's own e2e fixture) | ACCEPT. Every label carries the date-time: "Tour for <tenant> at <property> on <date-time>", "Select ... on ...", "Mark toured: ... on ...", "Record outcome: ... on ...". Spec 4.3, 4.4. |
| B16 | a cleared card reads "No staff notes yet." above "Last edited ..."; the e2e cleanup leaves a stamp | ACCEPT. The Last edited line renders only when the trimmed value is non-empty. The stamp on a clear stays (3.1) but is invisible; the new spec reseeds in `beforeAll` (it already did). Spec 3.6. |
| A5 | the e2e "no send" proof reads the fake's Conversations rails, which cannot see an SMS | ACCEPT. The proof is the fake's THREAD store: the count of outbound messages across `listThreads` is unchanged by the batch. Spec 4.7, 5. |
| A13 | 90-day `from` by millisecond subtraction differs from calendar-day subtraction across DST | ACCEPT. `from` is built with calendar arithmetic (`new Date(y, m, d - 90)`), and the unit test uses the same construction. Spec 4.2. |
| A19 | the save error appends the raw ApiError message, which the codebase's own rule keeps out of user copy | ACCEPT. The alert is the plain "Could not save staff notes. Try again." only. Spec 3.6. |
| A20 | the tour page's back link is hard-coded to /tours, so working through Past drops staff on Active every time | ACCEPT. The Past row link and the Record-outcome link pass router `state: { back: '/tours/past' }`; the tour page's back link uses `location.state.back` when it is one of the three tours routes, else `/tours`. Spec 4.4, 4.6. |
| B6 / A8 | GLOSSARY calls contact `notes` "internal staff notes"; AGENTS.md requires a glossary update for a new domain noun | ACCEPT. A "Staff notes" entry is added and the Unit `notes` line's "counterpart" wording fixed; `documentation/GLOSSARY.md` joins section 7. Spec 3.8. |

## Precision accepts (no decision changed)

| # | finding | ruling |
|---|---|---|
| B7 / A9 | `patchContact` does not exist (`updateContact`, endpoints.ts:1443); the date formatter is private to ToursPage | ACCEPT. Renamed throughout; the card has its own `formatLastEdited` with the same output shape. |
| B8 / A12a | the contacts 400 is 'no updatable fields supplied' | ACCEPT. Corrected in 2.1 and 5. |
| B9 / A12b | a past-dated create writes a visible booked_too_late skipped row, rotates the pointer, records a milestone | ACCEPT. Wording corrected; the conclusion (nothing is sent) holds and is now the only claim made. |
| B11 / A12d | express.json's default 100 KB body limit caps a save first | ACCEPT. Q1 corrected. |
| B12 / A10 | "nothing machine-writes either field" is false for park_reason | ACCEPT. The comment is about `staff_notes` alone. |
| B13 | the Preferences & notes empty copy has an em dash | ACCEPT. Noted in 2.1; the e2e compares the card's innerText before and after rather than matching copy. |
| B17 / A16 | the filed issue names readers that do not exist and misses that truncation drops the NEWEST tours | ACCEPT. Issue corrected (readers: today.ts:550, tours.ts:413; ascending Query drops the newest first, the top of Past). |
| A14 | the row's Mark toured does not open the outcome dialog, unlike the tour page's 2026-08-06 rule | ACCEPT as a stated difference: a list action cannot open a page's dialog; the row's "Record outcome" link (with the deep link) is the way in, and the tour page keeps its own chaining. Spec 4.4. |
| A17 | the intro copy omits toured-with-outcome rows | Moot after B5 (those rows are excluded); copy unchanged. |

## Deferred (issues filed)

| # | finding | ruling |
|---|---|---|
| B4 / A2 | a requested tour marked "already toured" with the date left blank has no scheduledAt and can never appear in Past | DEFER. The mission defines Past by scheduled time ("tours whose scheduled time is before the start of today"); listing timeless toured tours needs a second read by status and a placement rule for undated rows, which is a product call. Filed `past-tab-timeless-toured-tours` (improvement, med). Recorded in spec 4.2 and 9 Q10. |
| A4 | no-show rows have no way off the list (the tour page offers only reschedule) | DEFER. The mission named the two row actions and ruled that no status changes except through them; giving a no-show an exit (cancel, or "reached, no follow-up") is a product call. Filed `past-tab-no-show-rows-need-an-exit` (decision, med). Spec 9 Q11. |

## Rejected

| # | finding | ruling |
|---|---|---|
| A18 | staff notes is one shared box with a blind overwrite and no live refresh | REJECT as out of scope. Every contact field is last-write-wins today (`contacts.update` is a SET-merge with no version check; the AI's own notes append accepts the same race, apply.ts:686-690), and no contact SSE event exists. Parity is the deliberate choice for a low-frequency field; recorded in 9 Q12 as an accepted risk. |
| (none else) | | |

## Duplicates folded

A1 = B3, A2 = B4, A3 = B1, A6 = B2, A7 = B15, A8 = B6, A9 = B7, A10 = B12,
A11 = B10, A12 = B8 + B9 + B5 + B11, A15 = B14, A16 = B17.
