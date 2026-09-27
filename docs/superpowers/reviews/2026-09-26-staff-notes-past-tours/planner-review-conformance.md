# Planner review - independent spec conformance - feat/staff-notes-past-tours

Date: 2026-09-27
Reviewer: planner's independent spec-conformance reviewer (read-only; wrote only this file)
Branch: `feat/staff-notes-past-tours` at `821d8a36` (worktree `W:\tmp\staff-notes-past-tours`)
Base: `main` @ `0dafe3c1` (merge base identical; 45 commits ahead)
Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` (DRAFT 4)
Handback read as claims, not facts: `handback.md` in this directory.

Method: produced `git diff main...HEAD -- app dashboard e2e documentation`
(26 files, +3062/-77) and walked every decision in spec sections 3.1-3.8,
4.1-4.8, 5 and 6 to the code and tests at HEAD. Line numbers below are HEAD
line numbers. `TP` = `dashboard/src/routes/tours/ToursPage.tsx`, `TPcss` =
its module CSS, `UT` = `dashboard/src/routes/tours/useTours.ts`, `TD` =
`dashboard/src/routes/tours/TourDetail.tsx`, `SNC` =
`dashboard/src/routes/contact/StaffNotesCard.tsx`. No suite was run; gate
claims were spot-checked against `.superpowers/sdd/logs/p6*` only (p6b e2e
exit 0, `287 passed (26.6m)`; zero `[dynamoAdmin]` lines in the p6 test log -
the two `dynamoAdmin` hits there are the retry acceptance suite's own names).

## Verdict

CONFORMS. Every spec decision in 3.1-3.8 and 4.1-4.8 is delivered; every
test spec section 5 lists exists and asserts the listed substance; every
non-goal in section 6 and every off-limits path in section 7 is untouched.
No MISSING item and no spec violation. Ten LOW findings (P-1..P-10), none
blocking; the two that most deserve Cameron's eye are P-2 (a batch that
straddles a tab or route change reports nothing) and P-4 (the perf ledger's
Tours citations went stale again after the fix wave that refreshed them).

The handback's deviations are all either inside the spec's stated decisions
or defensible calls the spec left open. OD-3 in particular deviates from the
PLAN (a page-owned `bulkBusyRef`, plan lines 2357-2577), not from the spec:
spec 4.5 states only the behavior ("EVERY mark control is disabled ... the
runner also ignores a call while one is in flight") and never says where the
flag lives. OD-7 adds layout the spec never asked for, but contradicts none
of 4.3 / 4.8.

## 1. Per-spec-item table

| spec | decision | status | evidence (HEAD file:line) |
|---|---|---|---|
| 3.1 | `staff_notes?: string` on `ContactItem`, directly after `park_reason`, comment about staff_notes alone | DELIVERED | `app/src/repos/contactsRepo.ts:134` park_reason, `:135-143` comment + field |
| 3.1 | `staff_notes_updated_at?: string`, server-stamped, never client-settable | DELIVERED | `contactsRepo.ts:144-149`; parser never copies it (`app/src/routes/contacts.ts:578-583` copies only `staff_notes`) |
| 3.1 | no length cap; `''` clears | DELIVERED | `contacts.ts:578-583` (string-only, no cap); test `app/test/contactStaffNotes.test.ts:68-81` |
| 3.1 | neither name in `PROVENANCE_FIELDS`; no `staff_notes_source` | DELIVERED | `app/src/services/extraction/*` untouched (diff empty); test `contactStaffNotes.test.ts:61` |
| 3.2 | parse block directly after the `notes` block; 400 `staff_notes must be a string` | DELIVERED | `contacts.ts:568-573` notes, `:574-583` staff_notes, `:580` error text |
| 3.2 | route stamps `staff_notes_updated_at` whenever `'staff_notes' in parsed.patch`, before the write | DELIVERED | `contacts.ts:1518-1523` (before the voucher pre-read and `contacts.update`) |
| 3.2 | audit `fields` names it; provenance loop skips it; suggestion read returns nothing | DELIVERED | audit payload is field NAMES only (`contacts.ts:~1816-1820`); test `contactStaffNotes.test.ts:63-65` |
| 3.3 | `parseCreateBody`, import, seeds, public sign-up unchanged | DELIVERED | only hunks in contacts.ts are `@@ -4`, `@@ -571`, `@@ -1505`; `app/src/lib`, `app/src/routes/public.ts` diff empty; test `:128-145` |
| 3.4 | `toProfile` and `applyExtraction` unchanged; prompt untouched | DELIVERED | `app/src/jobs/extraction.ts`, `app/src/services/extraction/**` diff empty; `toProfile` names fields explicitly (`extraction.ts:131-159`) |
| 3.4 | issue `extraction-prompt-read-staff-notes` | DELIVERED | `docs/issues/extraction-prompt-read-staff-notes.md` |
| 3.5 | `Contact.staff_notes`, `Contact.staff_notes_updated_at`, `ContactPatch.staff_notes`, additive | DELIVERED | `dashboard/src/api/types.ts:2006-2012`, `:2106-2108` (+10/-0) |
| 3.6 | new `StaffNotesCard.tsx`, rendered by TenantFile directly above "Preferences & notes", ONLY for `type === 'tenant'` | DELIVERED | `TenantFile.tsx:262-270` then `:272-273` the Preferences card |
| 3.6 | props `contactId`, `value`, `updatedAt`, `onContactUpdated?` | DELIVERED | `SNC:21-29` |
| 3.6 | title "Staff notes"; NotesText when trimmed non-empty, else EmptyRow "No staff notes yet." | DELIVERED | `SNC:112`, `:156` |
| 3.6 | "Last edited <Mon D, YYYY>" only with text AND a parseable stamp; local `formatLastEdited` same shape as ToursPage `formatDate` | DELIVERED | `SNC:37-42`, `:100`, `:157-159`; shape identical to `TP:93-98` |
| 3.6 | aside "Edit"/"Edit staff notes" vs "+ Add"/"Add staff notes"; CardAction only with `onContactUpdated`, plain text otherwise; no aside in edit mode | DELIVERED | `SNC:101-109`, `:112` (`aside={editing ? undefined : aside}`) |
| 3.6 | textarea with a real visually-hidden `<label>` "Staff notes", prefilled, rows 4, focused | DELIVERED | `SNC:126-139` (sibling label by id, `:127-129`), focus effect `:61-63`, `rows={4}` `:136` |
| 3.6 | Save/Cancel exact; Cancel no request; unchanged Save no request; Save -> `updateContact(contactId, { staff_notes: draft })`; in flight both disabled + read-only | DELIVERED, refined (OD-2, F-10) | `SNC:71-94`, no-op compare `:79` trims both sides and compares to the edit-start baseline; `:137`, `:146`, `:149` |
| 3.6 | success -> `onContactUpdated(updated)` then read mode; failure -> stay, draft intact, `role="alert"` exactly "Could not save staff notes. Try again." | DELIVERED | `SNC:86-90`, `:33`, `:140-144` |
| 3.6 | TenantFile optional `onContactUpdated` passed through; ContactDetail passes `setContact` at the tenant-file site; ContactEditForm unchanged | DELIVERED | `TenantFile.tsx` prop + `:268`; `ContactDetail.tsx:1080` (the one TenantFile call site, `:1058`); ContactEditForm diff empty |
| 3.6 | last-write-wins; no catalog; ASCII | DELIVERED | no concurrency token; added-line non-ASCII byte count over the whole code diff = 0 |
| 3.7 | Landlord/Partner/Unknown files and team_member TenantFile get no card | DELIVERED | those files' diff empty; gate `TenantFile.tsx:262`; test `TenantFile.test.tsx` team_member case |
| 3.7 | lists, inbox, timeline, exports never render staff_notes | DELIVERED | `grep staff_notes` in `dashboard/src` hits only types, the card, TenantFile and tests |
| 3.7 | contact-detail.spec: only the two Notes locators scoped | DELIVERED | `e2e/tests/dashboard-next/contact-detail.spec.ts:60-62`, `:76`; no assertion changed |
| 3.7 | issue `staff-notes-on-landlord-partner-files` | DELIVERED | `docs/issues/staff-notes-on-landlord-partner-files.md` |
| 3.8 | Glossary "Staff notes" entry under Feature & label notes, directly above Unit `notes`; Unit `notes` line reworded | DELIVERED | `documentation/GLOSSARY.md` (section at `:115`); entry `:141-149`, Unit notes `:151-153` wording matches the spec |
| 4.1 | `closed?: boolean` -> `view?: 'active' \| 'past' \| 'closed'` default active | DELIVERED | `TP:574-580`, `:625` |
| 4.1 | App routes tours / tours/past / tours/closed | DELIVERED | `dashboard/src/App.tsx:240-242` |
| 4.1 | VIEW_TABS Active, Past, Closed in order; aria-current on the current | DELIVERED | `TP:584-588`, `:716-727` |
| 4.1 | heading "Past tours"; intro line verbatim; "+ New tour" Active only | DELIVERED | `TP:590-600` (intro `:598` matches the spec byte for byte), `:708-712` |
| 4.2 | lazy `usePastTours(enabled)`, `status`, `past`, `reload()`, `reloadFailed`; reload keeps rows; failed reload stays ready + flag; failed FIRST load is error | DELIVERED | `UT:221-278`; failed-reload branch `:267-270`; refresh alert `TP:494-498`; first-load error `TP:484-490`. Status union is `idle/ready/error` (no `loading`; the child's `idle` is the spinner, `TP:483`) - same behavior |
| 4.2 | window: start of local day 90 days ago .. end of today, calendar arithmetic, UTC ISO | DELIVERED | `UT:157`, `:178-182` |
| 4.2 | one request `getTours({ from, to })` | DELIVERED | `UT:258-260` (the page-level Active reads still fire on Past - P-10) |
| 4.2 | selection: statuses; drop today's scheduled; drop decided toured unless convertible + no `convertedPlacementId`; sort desc, tie tourId asc; client-side | DELIVERED | `UT:161-165`, `:186-188`, `:197-208` |
| 4.2 | known limits filed (`tours-scheduled-range-query-unpaginated`, `past-tab-timeless-toured-tours`) | DELIVERED | both files under `docs/issues/` |
| 4.3 | row: identity left, "Mon D, YYYY, h:mm AM" + state chip right; no type badge | DELIVERED, refined (OD-6) | `TP:236-243`; `whenLabel` `TP:618-623` maps U+202F/U+00A0 to a space |
| 4.3 | `pastState` pure exported; table order; outcome-first precedence; label fallback | DELIVERED | `UT:213-219` |
| 4.3 | row not one link: checkbox (Not marked only, "Select tour for ..."), Link ("Tour for ...", state `{ back: '/tours/past' }`), actions, result line | DELIVERED, plus fixed slots (OD-7) | `TP:212-282`; checkbox `:219-228`; link `:230-235`, `BACK_TO_PAST` `:604`; result `:270-280` |
| 4.3 | names from live + soft-deleted maps | DELIVERED | `TP:670-682`, passed at `:795` |
| 4.4 | Not marked: "Mark toured" (aria "Mark toured: <who>"), same runner with one id; stops at Needs outcome | DELIVERED | `TP:246-257`, `:558` |
| 4.4 | Needs outcome: "Record outcome" link (aria "Record outcome: <who>") to `/tours/<id>?outcome=1` with state back | DELIVERED | `TP:258-267` |
| 4.4 | Needs placement and No show: no row action | DELIVERED | `TP:246-267` renders neither |
| 4.4 | issue `past-tab-no-show-rows-need-an-exit` | DELIVERED | `docs/issues/past-tab-no-show-rows-need-an-exit.md` |
| 4.5 | toolbar: "Select all not marked" (indeterminate when partial); "Mark toured (N)" disabled at 0 and while running | DELIVERED | `TP:525-548`; indeterminate via ref `:531-533` |
| 4.5 | selection DERIVED (raw ticks intersect listed Not marked ids) | DELIVERED | `TP:372-381` |
| 4.5 | Past body is a Past-only child; selection + results fresh each time Past shows; tabs share one page instance | DELIVERED | `PastToursView` `TP:343`, mounted only at `:795`; selection/results/snapshot are child state `:366-368` |
| 4.5 | while a batch runs EVERY mark control disabled; runner ignores a call in flight | DELIVERED, mechanism changed (OD-3) | module store `TP:299-328`; `useSyncExternalStore` `:348`; guard `:425`; `busy` wired to row checkbox `:224`, row button `:251`, select-all `:534`, bulk `:543` |
| 4.5 | runner step 1: busy, clear results, snapshot | DELIVERED | `TP:430-432` |
| 4.5 | step 2: list order, one at a time: re-read; failed re-read -> "Could not check the tour"; not scheduled OR scheduledAt differs -> "Changed since the list loaded"; PATCH `{ status: 'toured' }` -> ok / "The update failed"; failure does not stop | DELIVERED | order from `notMarkedIds` `:373`, `:377`, `:427`; loop `:434-458`; guard phase in one try `:440-447` |
| 4.5 | step 3: clear raw selection for successes only | DELIVERED | `TP:460-464` |
| 4.5 | step 4: reload; clear busy | DELIVERED | `TP:465-468` (via the mounted-view slot; release in `finally`) |
| 4.5 | per-row result lines, `role="status"` / `role="alert"`, fixed strings only | DELIVERED | `TP:270-280`, `MarkFailure` union `:609` |
| 4.5 | results whose row the reload dropped: block above the toolbar, one line per tour from the snapshot | DELIVERED, role per block (P-7) | `vanished` `TP:386-397`; blocks `:499-518` precede the toolbar `:525` |
| 4.5 | batch sends only `status: 'toured'` | DELIVERED | `TP:453` |
| 4.6 | `?outcome=1` read once the tour has loaded; toured + no outcome opens the dialog, else nothing | DELIVERED (initializer, not an effect) | `TD:264-268`; `TourDetailLoaded` is keyed by `tourId` (`TD:143-144`) and mounts after load |
| 4.6 | param removed with `setSearchParams(next, { replace: true, state: location.state })` either way | DELIVERED | `TD:269-274` |
| 4.6 | back arrow -> `state.back` only if exactly `/tours`, `/tours/past`, `/tours/closed`, else `/tours` | DELIVERED | `TD:103`, `:107-110`, `:252`, `:630` |
| 4.6 | Active and Closed rows keep linking without state | DELIVERED | `TourRow` `TP:156-160` unchanged |
| 4.7 | no write on load/select/view change/navigation; batch never PATCHes a changed tour; no send; nothing closes; requested stays in Needs booking | DELIVERED | only writer is `markToured` `TP:424-481`; `PAST_TAB_STATUSES` excludes requested; e2e no-send proof (section 5 below) |
| 4.8 | 360px: identity over meta, checkbox leading, action wraps under the link; e2e overflow checks on /tours/past and on the tenant file in edit mode | DELIVERED, via an added Past-only 840px rule (OD-7) | `TPcss:381-403` (840px), `:406-417` (560px: row wraps, actions full width, empty slot hidden); e2e `tours-past.spec.ts:159-176`, `:231-236`; `tenant-staff-notes.spec.ts:79-91` |
| 5 | tests | DELIVERED | section 2 below |
| 6 | non-goals | HONORED | section 3 below |
| 7 | files touched / off limits | HONORED, three files beyond the list (declared) | `useContact.ts` (+test) F-8; `e2e/performance/routes.ts`, `routes.test.ts` OD-1; no off-limits path touched |
| 8 | six issues | DELIVERED (+2 from the build: `perf-pages-tours-past-surface`, `tours-patch-status-precondition`) | `docs/issues/` |

## 2. Spec section 5 - the listed tests

| spec 5 item | test (HEAD) | substance |
|---|---|---|
| app: PATCH 'x' -> 200, stored, ISO stamp, notes untouched, no `_source`, audit fields `['staff_notes']` | `app/test/contactStaffNotes.test.ts:45-66` | yes (`toMatchObject` on an array is length-exact) |
| app: `''` clears and re-stamps | `:68-81` | yes |
| app: `5` -> 400 exact text | `:83-92` | yes |
| app: stamp alone -> 400 `no updatable fields supplied`; beside staff_notes the server wins | `:94-112` | yes |
| app: notes-only PATCH leaves staff_notes and stamp | `:114-124` | yes |
| app: POST with staff_notes -> none on the contact | `:128-145` | yes |
| app: `toProfile` has no staff_notes key | `:149-160` | yes |
| app: extraction apply direct-write + note line, NO update carries either key, across ALL calls | `:162-214` | yes (loop over every update; asserts both calls happened) |
| useTours: `pastToursDateRange` calendar construction + November DST case | `useTours.test.ts:213-238` | yes (DST case is vacuous on a no-DST host - P-9) |
| useTours: `selectPastTours` drops canceled/closed, today's scheduled, not_a_fit toured; keeps convertible-no-placement and later-today toured; desc + tourId tie; no mutation | `:267-285` | yes |
| useTours: `pastState` four cases + fallback + precedence | `:289-306` | yes |
| useTours: `usePastTours` idle until enabled, window, reload keeps rows, failed reload flag cleared by next success, failed first load error | `:328-386` | yes |
| ToursPage: three tabs, Past current | `ToursPage.test.tsx:507`, `:708-722` | yes (order asserted at `:507`) |
| ToursPage: rows (date-time, tenant, property, chip; date-time in every label) | `:724-801` | yes, exact-string names |
| ToursPage: actions per state; Record outcome href + `state.back` | `:772-791` | yes |
| ToursPage: select-all + bulk count | `:803-818`, `:820-868` | yes |
| ToursPage: re-read each, PATCH once per still-scheduled same-time id, sequential (second waits) | `:870-905` | yes (held first PATCH, 50 ms window, then order) |
| ToursPage: skip "Changed since the list loaded" for not-scheduled AND for different time | `:820-868` (canceled), `:1073-1082` (rescheduled) | yes |
| ToursPage: per-row success/failure lines and the above-toolbar block for a dropped row | `:820-868`, `:907-938` | yes |
| ToursPage: every mark control disabled while running, then reloads | `:848-857` | yes |
| ToursPage: failed reload keeps rows AND results, one refresh alert | `:1153-1187` | yes (R1 C-2 closed) |
| ToursPage: switching the view resets selection and results | `:940-958` | yes |
| ToursPage: bulk button located by an anchored name | string names such as `'Mark toured (2)'` (RTL string names are whole-name exact) | yes |
| ToursPage: existing Active/Closed tests pass under `view` | `renderPage` wires `view="closed"` (`:252-263`); pre-existing cases `:309-664` | yes |
| TourDetail: `?outcome=1` toured-no-outcome opens + strips while keeping `state.back` (asserts the back arrow after the strip) | `TourDetail.test.tsx` spec 4.6 describe, cases 1-2 | yes |
| TourDetail: scheduled / toured-with-outcome open nothing; no param leaves state untouched; back arrow honors `/tours/past`, ignores others | same describe, cases 3-9 | yes (state-untouched shown through the back arrow with no param) |
| StaffNotesCard: empty/filled read, Last edited only with text, Edit -> prefilled focused -> Save payload -> handed up; Cancel; unchanged Save; failed save; no action without handler; aside absent in edit | `StaffNotesCard.test.tsx:44-227` | yes, plus OD-2 and F-10 pins |
| TenantFile: above Preferences & notes for a tenant; absent for team_member | `TenantFile.test.tsx` first two cases | yes (document order) |
| e2e contact-detail: two locators scoped to an Edit-dialog locator | `contact-detail.spec.ts:60-62`, `:76` | yes (second site inline, same locator) |
| e2e tenant-staff-notes: reseed; + Add -> exact label -> Save -> text + Last edited -> reload -> still; Preferences innerText identical; 360px edit no overflow; clear -> empty, no Last edited | `tenant-staff-notes.spec.ts:30-102` | yes, plus a card-level overflow measure |
| e2e tours-past: reseed; three API tours 1/2/3 days ago 10:00 local on two units; toured + no_show; exactly three, states, order; none in Active; outbound count; anchored `/^Mark toured \(1\)$/`; row -> Needs outcome + Record outcome; count unchanged; toured no outcome on the wire; deep link dialog open, no `?outcome`; Cancel; back -> /tours/past; 360px | `tours-past.spec.ts:77-238` | yes, plus per-party since-scoped no-send checks, a 960px no-clip pin and a checkbox-in-card pin |

## 3. Non-goals (spec 6) and off-limits (spec 7)

Verified by `git diff --stat main...HEAD -- <path>` returning nothing for:
`app/src/jobs`, `app/src/services` (extraction prompt, `applyExtraction`,
schema/`PROVENANCE_FIELDS`), `app/src/lib` (import, seeds), `app/src/routes/public.ts`,
`app/src/adapters`, `app/src/routes/webhooks`, `app/src/routes/settings.ts`,
`app/src/repos/settingsRepo.ts`, `app/src/routes/mmsMedia.ts`,
`app/src/repos/messagesRepo.ts`, `app/src/repos/broadcastsRepo.ts`,
`app/src/routes/tours.ts`, `app/src/repos/toursRepo.ts`,
`dashboard/src/api/client.ts`, `dashboard/src/api/endpoints.ts`,
`dashboard/src/routes/settings`, `dashboard/src/routes/broadcasts`,
`dashboard/src/routes/contact/deliveryStatus.ts`, `relayRetryJoin.ts`,
`ContactEditForm.tsx`, `LandlordFile.tsx`, `PartnerFile.tsx`, `UnknownFile.tsx`.
In `contacts.ts` the only hunks are the header comment, the `parseTriageBody`
block and the stamp - `parseCreateBody` is untouched. No catalog file changed.
No calendar view, no bulk close/outcome, no no-show exit, no timeless rows, no
server-side status filter or precondition, no range-query pagination, no
optimistic concurrency. All honored.

## 4. The handback's deviations, adjudicated against the spec

| id | what | against the spec |
|---|---|---|
| OD-1 | `/tours/past` added to the perf-route exclusions (`e2e/performance/routes.test.ts:380-381`), issue filed | Defensible call the spec left open: spec 7 missed the gate-2 route pin; excluding is the minimal change that keeps Cameron's human-run `perf:pages` contract intact. See P-6. |
| OD-2 | no-op Save compares trimmed draft to trimmed baseline | Defensible refinement of 3.6 "draft equal to the stored value": `trimJsonBody` (`app/src/middleware/trimStrings.ts:43-50`) trims every JSON string, so a whitespace-only difference would store identical text and re-stamp "Last edited". Verified. |
| OD-3 | busy flag + in-flight guard + reload slot as a MODULE store (`TP:299-328`) | Within the spec. 4.5 states behavior only; the page-owned ref was the PLAN's mechanism. The store meets 4.5's "every mark control disabled while a batch runs" in more cases (a remount after a tab switch or a route change) than the plan's design, which left a remounted view's controls enabled-but-inert. Selection and results still live in the Past-only child, as 4.5 requires. Costs in P-1; the silent-results residue it makes more reachable is P-2. |
| OD-4 | extra per-party no-send checks | Additive to 4.7 / 5. Fine. |
| OD-5 | house-style `?? 'http://127.0.0.1:5174'` fallback in the two new specs | Outside the spec; house style. See P-8. |
| OD-6 | `whenLabel` maps U+202F/U+00A0 to a space | Defensible refinement of 4.3's `formatDate + formatTime` string: keeps the row text and every accessible name identical on ICU 72+ hosts. Active/Closed rows are unchanged. |
| OD-7 | fixed lead slot (1.1rem) and action slot (8.5rem) on every Past row; Past-only 840px stacking rule | Beyond the spec, not against it: 4.3's structure and 4.8's 360px behavior are both met, and nothing outside `.pastRow` changes. Costs in P-3. |
| X-1 / F-9 | `key={contact.contactId}` on the card | Harmless; no behavior today (ContactDetail unmounts the pane on a switch). |
| F-8 | `useContact.setContact` ignores a setter bound to an earlier contact id (`useContact.ts:47-53`) | Outside spec 7's file list, not off limits. Traced: a stale setter while the new fetch is in flight writes `forId` = old id and the hook still derives loading until the new fetch commits; after it commits, the stale setter is a no-op. Correct for every caller. See P-5. |
| F-10 | the no-op compare uses the text the editor OPENED with | Defensible: spec 3.6's literal rule ("draft equal to the stored value") would make an untouched Save after a background refetch silently write the old text over a colleague's; Q12's last-write-wins is about two edits, not an untouched Save. An edited draft still saves (LWW), pinned by `StaffNotesCard.test.tsx:173-187`. |
| A-2 | no server precondition; issue filed | Exactly spec Q14. |
| 840px | threshold widened from 800 | Part of OD-7; see P-3. |

## 5. Findings

### P-1 - LOW - OD-3's module store trades a page-scoped flag for a browser-tab-scoped one

Evidence: `TP:299-328` (`let batchRunning`, `batchListeners`,
`mountedPastReload`, and the exported `resetBulkBatchStoreForTests`), consumed
at `TP:348`, `:355-359`, `:425`, `:465-468`.

It is spec-conformant (section 4) and closes the plan design's real gap (a
remounted view with enabled but inert controls, and a second batch possible
after a route change). What it costs:
- process-global mutable state in a page module, and a test-only export
  shipped in production code (the test file must reset it in `beforeEach`,
  `ToursPage.test.tsx:296-299`, or one test's held PATCH wedges the next);
- a request that never settles now disables every Past mark control for the
  whole browser tab, across navigations, until it settles or the page is
  reloaded (the plan's page-owned ref would have reset on a route change).
  The runner passes no AbortSignal and the api client sets no timeout; the
  handback's "hosted envs bound it at CloudFront's 30 s" (R2-4) is a claim I
  did not verify.
Implication: acceptable as shipped; worth one line in the merge note so a
future reader does not "simplify" it back into component state.

### P-2 - LOW - a batch that straddles a tab switch or a route change reports nothing

Evidence: results, snapshot and selection are child state (`TP:366-368`);
`markToured` writes them through the starting view's setters (`TP:431-432`,
`:459-464`), which land on an unmounted instance after a tab switch or a
route change; the remounted view receives only the reload (`TP:465`). Row
links stay enabled mid-batch, and the unit test at
`ToursPage.test.tsx:1006-1055` exercises exactly that navigation. After such a
batch a row that failed ("Changed since the list loaded", "The update
failed", "Could not check the tour") reappears as a plain "Not marked" with
no reason, and a row the reload dropped is named nowhere.

Spec 4.5 lets results clear on "a view change or a navigation away", so this
is not a violation, but its closing promise "so no result is ever silent" is
not met for these batches. The handback records it as C-7(ii). OD-3 made the
straddle more likely to end in a working page (the batch keeps running and
refreshes the new view), which is good, but the new view cannot say what
happened.
Implication: accept, or a small follow-up - keep the last batch's
results + snapshot in the same module store so the next mounted Past view
can render them.

### P-3 - LOW - OD-7's fixed slots and Past-only 840px stacking: consistent rows, inconsistent tabs, content-tuned threshold

Evidence: `TPcss:250-308` (slots, `.rowActions { flex: 0 0 8.5rem }`),
`:370-403` (the 840px rule and its rationale), `:406-417` (560px);
`tours-past.spec.ts:134-154` (960px no-clip pin).

Not a spec violation (4.3 and 4.8 are met). Effects to know:
- on the same page, Past rows stack identity over meta at 561-840px panes
  while Active and Closed rows stay side by side until 560px;
- above 560px every row reserves an 8.5rem action slot, so No show and Needs
  placement rows carry a blank band on the right (alignment is the point);
- the 840 value was measured against lean-seed name widths ("whole only from
  836px"); real, longer tenant names and addresses will still ellipsize just
  above 840px - the same trade Active rows make, but on a card ~170px
  narrower;
- stale comment: `tours-past.spec.ts:39-41` still says the "561-800px band".
Implication: a product-eye decision the spec did not ask for; Cameron
should see the 960px/1280px screenshots (self-QA 07-09) before merge if he
cares about tab-to-tab consistency. No code change required.

### P-4 - LOW - the perf ledger's Tours citations are stale again at HEAD (R1 C-6 regressed)

Evidence: `e2e/performance/routes.ts:686-687` and `:716` cite
`ToursPage.tsx:618-622` / `:618-635` for the page's hook calls; at HEAD
those lines are `whenLabel` (`TP:618-623`); the hooks are at `TP:625-643`.
`:740-741` cite the view JSX as `ToursPage.tsx:695-793`; at HEAD it is about
`TP:704-818`. The fix-wave-1 refresh (`dd06c7f1`, F-11) was correct when
committed (verified with `git show dd06c7f1:...ToursPage.tsx`); fix-wave-2's
`3883d084` shifted `ToursPage.tsx` by +7 lines and nobody re-derived them.
The `useTours.ts` and `TourDetail.tsx:630` citations are still accurate.
`routes.test.ts:421-449` checks citation FORMAT only, so gate 2 cannot see
this; the handback's claim that the ledger was refreshed is true of `dd06c7f1`
and false of HEAD.
Implication: documentation drift in Cameron's human-run `perf:pages`
fingerprints; a one-line refresh of four strings. Not blocking.

### P-5 - LOW - F-8 edits a shared hook outside the spec's file list

Evidence: `dashboard/src/routes/contact/useContact.ts:47-53`, pinned by
`useContact.test.tsx:54-98` (red with the fix reverted, per the fix-wave-1
report). Every in-place `setContact` caller (edit dialog, phone manager,
opt-out, the card) now ignores a setter bound to a contact the page has left.
My trace (section 4) finds it correct and strictly safer. Declared.
Implication: merge awareness only.

### P-6 - LOW - OD-1: /tours/past is not a profiler surface

Evidence: `e2e/performance/routes.test.ts:380-381`;
`docs/issues/perf-pages-tours-past-surface.md`. The spec's file list missed
that gate 2 pins every App route. Excluding with a reason and an issue is
the minimal, contract-preserving choice; registering a 32nd surface would
have changed Cameron's human-run self-QA without him.
Implication: the new view carries no page-performance baseline until
Cameron registers it.

### P-7 - LOW - above-toolbar results carry their live-region role per block, not per line

Evidence: `TP:499-518` - one `role="status"` div and one `role="alert"` div,
each holding one `<p>` per tour; spec 4.5 describes one line per tour
carrying the role. Screen readers announce the block's text either way;
declared as C-5 (plan-prescribed).
Implication: none required.

### P-8 - LOW - OD-5: both new specs reseed through a `:5174` fallback

Evidence: `tenant-staff-notes.spec.ts:21`, `:30-33`; `tours-past.spec.ts:32`,
`:77-80` - `process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174'` and a
`POST /__dev/reseed` in `beforeAll`. Under `npm run e2e` the env var is always
set; a stray non-harness Playwright run would aim the reseed at the human's
live dashboard port, which AGENTS.md forbids touching. House style across ~57
specs; declared as C-8. Whether `/__dev/reseed` even exists on the live stack
decides whether this is a failed request or a wiped database; I did not check.
Implication: repo-wide follow-up, not this branch's to fix.

### P-9 - LOW - the November DST unit test is vacuous on a host without DST

Evidence: `useTours.test.ts:231-238` asserts the local hour is 0 after 90
calendar days back from Nov 15; no `TZ` is pinned in the dashboard test
config (grep of `dashboard/vite*`, `vitest*`, `package.json` finds none). On a
US-zone machine it proves the calendar construction; on a UTC runner it
passes for either implementation. The implementation itself
(`UT:178-182`) is the DST-safe construction the spec prescribes.
Implication: fine on Cameron's machine; pin `TZ` if tests ever move to CI.

### P-10 - LOW - the Past view still fires the Active hook's two reads

Evidence: `TP:629` calls `useTours()` unconditionally (Active window +
`status=requested`) on every view, as it already did on Closed; the Past
child adds its own single range read (`UT:258-260`). Spec 4.2's "One
request" is about the Past hook and is met; the page-level reads are
pre-existing behavior the handback discloses (section 8).
Implication: two wasted reads per Past visit; not worth a change here.

## 6. Checked and holding (no finding)

- Stamp ordering: the stamp is set after parsing and consent stamping and
  before any write (`contacts.ts:1518-1523`); the audit event carries names
  only, so no staff note text reaches the audit log or any timeline.
- No other app or dashboard code reads `staff_notes` (grep: repo type,
  route, dashboard types, the card, TenantFile, tests).
- `getTour` returns the bare `Tour` (`dashboard/src/api/endpoints.ts:2176-2181`),
  so the runner's `current.status` / `current.scheduledAt` compare is real.
- Batch order is list order: `selected` is built by filtering
  `notMarkedIds` (list order) and `eligible` preserves it.
- The runner's single release point is its `finally` (`TP:466-468`); a
  malformed re-read is caught inside the guard phase (`TP:440-447`), pinned
  by `ToursPage.test.tsx:1108-1133`.
- `TourDetailLoaded` is keyed by `tourId`, so the `?outcome=1` initializer
  runs once per tour; the strip effect stops once the param is gone.
- Added lines across app/dashboard/e2e/documentation: zero non-ASCII bytes.
- The two gate-log claims I spot-checked match the handback (p6b e2e exit 0,
  287 passed; p6 test log has no `[dynamoAdmin]` line).
