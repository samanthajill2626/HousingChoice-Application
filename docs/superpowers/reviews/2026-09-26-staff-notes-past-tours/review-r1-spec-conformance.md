# Review R1 - spec conformance - feat/staff-notes-past-tours

Date: 2026-09-27

Reviewer: independent spec-conformance reviewer (Claude Opus 5.5, 1M context),
read-only; not one of the builders.

Scope: branch `feat/staff-notes-past-tours` at HEAD `c45e7159`, base
`0dafe3c1`. The contract is the APPROVED spec
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` (DRAFT 4).
The work map is `research-worklist.md` (slice map S1-S7, decisions OD-1..OD-6).
The thing under review is `.superpowers/review/feature-diff.txt` (22 code and
test files under app/, dashboard/, e2e/), read in full. The docs side of the
branch (`documentation/GLOSSARY.md`, `docs/issues/`) was read for spec 3.8, 7
and 8. The seven slice reports were checked claim by claim against the tree.

Method:

- Every behavior-bearing spec item (3.1-3.8, 4.1-4.8, 5, 6, 7, 8) was mapped
  to code at HEAD. Strings, accessible names, roles, request bodies, ordering,
  window arithmetic, selection and the 4.7 invariants were compared LITERALLY
  with the spec text.
- Server facts the client logic depends on were read at the source:
  `trimJsonBody` uses `String.prototype.trim`
  (`app/src/middleware/trimStrings.ts`, `deepTrimStrings`); `scheduledAt` is
  canonicalized to `toISOString()` on create and on PATCH
  (`app/src/routes/tours.ts:340`, `:1158`); `getTour` returns the unwrapped
  `Tour` (`dashboard/src/api/endpoints.ts:2176-2181`).
- Mechanical checks: the ASCII command on all added lines; CR bytes in touched
  files; a Co-Authored-By trailer on every branch commit; added UI copy scanned
  for "unit" / "home" drift.
- One throwaway layout probe for the 360px question (disclosed at the end).
  No source file was modified. No unit, smoke, lint or e2e suite was run: the
  orchestrator's gate run already reports typecheck, test and smoke exit 0
  (`.superpowers/sdd/logs/p3-timeline.log`), and its e2e gate was still
  running during this review.

Verdict: CONFORMS - no BLOCKING finding. Every spec contract is met in code.
There are two SHOULD-FIX items:

- C-1: the 360px Past row strands its checkbox on a line of its own. This
  drifts from the intent of spec 4.8. A one-declaration CSS fix was verified.
- C-2: two ToursPage unit tests are weaker than spec 5 lists them.

There are seven NOTEs. All six OD decisions match what the worklist records and
honor the spec's intent.

Counts: BLOCKING 0, SHOULD-FIX 2, NOTE 7.

## Conformance table - spec items

All paths are at HEAD `c45e7159`. Abbreviations: TP = `dashboard/src/routes/tours/ToursPage.tsx`,
TPcss = `ToursPage.module.css` (same folder), UT = `dashboard/src/routes/tours/useTours.ts`,
TD = `dashboard/src/routes/tours/TourDetail.tsx`, SNC = `dashboard/src/routes/contact/StaffNotesCard.tsx`,
TF = `dashboard/src/routes/contact/TenantFile.tsx`, CT = `app/src/routes/contacts.ts`.

| spec | item | verdict | evidence |
|---|---|---|---|
| 3.1 | `staff_notes?: string` directly after `park_reason`, comment about staff_notes alone, no cap, '' clears | CONFORMS | `app/src/repos/contactsRepo.ts:134` park_reason, `:136-143` comment + field (names import, seeds, public sign-up, transition service, extraction; "PATCH only; '' clears"); no cap anywhere |
| 3.1 | `staff_notes_updated_at?: string`, server-stamped, never client-settable | CONFORMS | `contactsRepo.ts:144-149` (its own comment carries the server-stamp note); not parsed in `parseTriageBody` |
| 3.1 | neither name in PROVENANCE_FIELDS; no `staff_notes_source` | CONFORMS | `app/src/services/extraction/schema.ts:40` untouched; loop `CT:1537-1541` gates on `PROVENANCE` (`CT:952`) |
| 3.2 | parse block directly after the `notes` block; string -> patch + changedFields; non-string -> 400 `staff_notes must be a string` | CONFORMS | notes block `CT:568-573`; new block `CT:574-583`, exact error `CT:580` |
| 3.2 | route stamps `staff_notes_updated_at = new Date().toISOString()` whenever `'staff_notes' in parsed.patch`, before the write | CONFORMS | `CT:1521-1522`; the write is `CT:1573` |
| 3.2 | audit `fields` names staff_notes; provenance skips it; suggestion read finds nothing | CONFORMS | `CT:1817-1818` `fields: parsed.changedFields` (the stamp is never pushed, so fields = ['staff_notes']); `CT:1538` |
| 3.3 | `parseCreateBody` unchanged; POST with staff_notes creates without it | CONFORMS | create parser not in the diff (its notes copy is `CT:790`); test `app/test/contactStaffNotes.test.ts:128-146` |
| 3.4 | toProfile / applyExtraction / prompt untouched; issue filed | CONFORMS | none of the three files is in the diff; tests `contactStaffNotes.test.ts:149-160`, `:162-214`; `docs/issues/extraction-prompt-read-staff-notes.md` (improvement, low) |
| 3.5 | `Contact.staff_notes`, `Contact.staff_notes_updated_at`, `ContactPatch.staff_notes`, additive | CONFORMS | `dashboard/src/api/types.ts:2009`, `:2012`, `:2108`; diff +10/-0 |
| 3.6 | new `StaffNotesCard.tsx`, rendered by TenantFile directly ABOVE "Preferences & notes", ONLY for `type === 'tenant'` | CONFORMS | gate `TF:256`, card `TF:257-262`, next element `TF:265-266` "Preferences & notes" |
| 3.6 | props `contactId`, `value`, `updatedAt`, `onContactUpdated?` | CONFORMS | `SNC:21-29` |
| 3.6 | read mode: title "Staff notes"; trimmed non-empty -> NotesText; empty -> EmptyRow "No staff notes yet." (not PendingPanel) | CONFORMS | `SNC:109`, `SNC:153`; EmptyRow is the muted "nothing here" row (`dashboard/src/routes/contact/Card.tsx:85-88`) |
| 3.6 | "Last edited Sep 26, 2026" only when trimmed value non-empty AND updatedAt parses; en-US short month; local `formatLastEdited` | CONFORMS | `SNC:37-42` ('' for absent/unparseable), `SNC:97`, `SNC:154-156` (muted via `responseClass.muted`) |
| 3.6 | aside "Edit" / aria "Edit staff notes" vs "+ Add" / aria "Add staff notes"; CardAction only with onContactUpdated, else plain text; absent in edit mode | CONFORMS | `SNC:98-106`; `aside={editing ? undefined : aside}` `SNC:109` |
| 3.6 | edit mode: textarea with a real visually hidden `<label>` "Staff notes", prefilled, rows=4, focused on entry | CONFORMS | label `SNC:124-126` (srOnly), `rows={4}` `SNC:133`, prefill via `startEdit` `SNC:64-68`, focus effect `SNC:60-62` |
| 3.6 | "Save" / "Cancel"; Cancel no request; equal draft -> no request; else `updateContact(contactId, { staff_notes: draft })`; in flight: both disabled, textarea read-only | CONFORMS (no-op compare trimmed per OD-2) | `SNC:143`, `SNC:146` `disabled={saving}`; `SNC:134` `readOnly={saving}`; cancel `SNC:69-72`; no-op `SNC:76`; request `SNC:83` (raw draft) |
| 3.6 | success -> onContactUpdated(updated) then read mode; failure -> stay in edit, draft intact, `role="alert"` exactly "Could not save staff notes. Try again." | CONFORMS | `SNC:83-88`; constant `SNC:33`; alert `SNC:138-140` |
| 3.6 | TenantFile optional `onContactUpdated` passed through; ContactDetail passes `setContact`; ContactEditForm and Preferences "+ Add" unchanged | CONFORMS | `TF:90-92`, `TF:136`, `TF:261`; `dashboard/src/routes/contact/ContactDetail.tsx:1080`; ContactEditForm not in the diff |
| 3.7 | Landlord/Partner/Unknown files and team_member rendering unchanged; lists, inbox, timeline, exports do not render it; issue filed | CONFORMS | none of those files is in the diff; `docs/issues/staff-notes-on-landlord-partner-files.md` (improvement, low) plus the N5 addendum (`c45e7159`) |
| 3.8 | glossary entry under "Feature & label notes", directly above Unit `notes`; Unit `notes` line rewritten | CONFORMS | `documentation/GLOSSARY.md:115` section heading, `:141-149` entry, `:151-153` rewritten Unit line (verbatim spec wording). The entry adds "Sam's item 22" and the machine-writer list, and says "Companion" for "The companion" - substance identical |
| 4.1 | `closed?: boolean` -> `view?: 'active' or 'past' or 'closed'`, default active; App routes three paths | CONFORMS | `TP:520` ToursView, `TP:522-526` prop, `TP:571` default; `dashboard/src/App.tsx:240-242` |
| 4.1 | VIEW_TABS Active, Past, Closed in that order; `aria-current="page"` on the current tab | CONFORMS | `TP:530-534`; `TP:675` |
| 4.1 | heading "Past tours"; intro line exact; "+ New tour" Active-only | CONFORMS | `TP:538`; `TP:544` matches the spec byte for byte; `TP:661` |
| 4.2 | lazy `usePastTours(enabled)` shaped like useClosedTours plus `reload()` and `reloadFailed` | CONFORMS | `UT:238-278`; status set is idle / ready / error (`UT:227`), no 'loading' - idle doubles as the first-load state (lint rule `react-hooks/set-state-in-effect`), page shows the spinner on idle `TP:429` |
| 4.2 | reload keeps rows; failed reload stays ready + `reloadFailed` (cleared by next success) + ONE `role="alert"` "Could not refresh the list. Reload the page to see the latest." above the toolbar; only a failed FIRST load replaces the list | CONFORMS | `UT:263` (success clears the flag), `UT:268-270`; `TP:440-444` (first element in the region, before the blocks and the toolbar); first-load error `TP:430-436` |
| 4.2 | window: from = `new Date(y, m, d - 90, 0,0,0,0)`, to = `new Date(y, m, d + 1, 0,0,0,0)` minus 1 ms, as UTC ISO | CONFORMS | `UT:178-182` - the exact construction |
| 4.2 | one request `getTours({ from, to })` | CONFORMS | `UT:261` |
| 4.2 | selection in order: keep scheduled / toured / no_show; drop scheduled at-or-after start of today; drop toured+outcome unless convertible and no convertedPlacementId; sort desc, tourId asc | CONFORMS | `UT:161-165` (a ReadonlySet, not an array literal), `UT:200`, `UT:201`, `UT:202` with `needsPlacement` `UT:186-188`, `UT:203-208`. The ISO string compares are exact because the server canonicalizes `scheduledAt` (`app/src/routes/tours.ts:340`, `:1158`). A `pending:` placeholder is excluded, as 4.2 step 3 says |
| 4.2 | client-side status filter; known limits filed | CONFORMS | `docs/issues/tours-scheduled-range-query-unpaginated.md` (debt, low), `past-tab-timeless-toured-tours.md` (improvement, med) |
| 4.3 | date-time = page's formatDate + formatTime joined with ", " | CONFORMS (OD-6 normalization) | `TP:564-569`, formatDate `TP:90-95`, formatTime `TP:80-85` |
| 4.3 | chip table + `pastState` pure exported, outcome-first precedence, status-label fallback | CONFORMS | `UT:213-219` |
| 4.3 | row structure: li; checkbox only on Not marked, aria "Select tour for <who>"; Link with aria "Tour for <who>" and state `{ back: '/tours/past' }`; actions; result line | CONFORMS | li `TP:208`; checkbox `TP:210-219` (aria `TP:217`); Link `TP:220-234` (aria `TP:224`, state `TP:222`, `BACK_TO_PAST` `TP:550`); actions `TP:235-260`; result `TP:262-272`; `<who>` = `TP:203` |
| 4.3 | names from live + soft-deleted maps; no tour-type badge | CONFORMS | maps `TP:623-636` passed at `TP:749-750`; meta holds only the date-time and the chip `TP:230-233` |
| 4.4 | Not marked: button "Mark toured", aria "Mark toured: <who>", same runner with one id, no dialog | CONFORMS | `TP:237-247` (aria `TP:244`); `TP:504` `markToured([t.tourId])` |
| 4.4 | Needs outcome: link "Record outcome", aria "Record outcome: <who>", to `/tours/<id>?outcome=1`, state back | CONFORMS | `TP:250-257` (to `TP:251`, state `TP:252`, aria `TP:254`) |
| 4.4 | Needs placement and No show: no row action | CONFORMS | `TP:235` renders the actions only for notMarked or needsOutcome |
| 4.5 | toolbar: "Select all not marked" checks all Not marked / clears; indeterminate when partial; "Mark toured (N)" disabled at 0 and while running | CONFORMS | select-all `TP:472-484` (indeterminate `TP:477-479`, disabled `TP:480`), toggleAll `TP:366-368`; bulk button `TP:485-493` (disabled `TP:489`, text `TP:492`) |
| 4.5 | selection DERIVED (raw ticks intersect listed Not marked ids) | CONFORMS | `TP:331-340` |
| 4.5 | Past body is a Past-only child that mounts / unmounts with the tab; selection and results fresh each visit | CONFORMS | `PastToursView` rendered only when `past` `TP:747-756`; selection, results and snapshot are child state `TP:325-327` |
| 4.5 | while a batch runs EVERY mark control disabled; runner ignores a call in flight | CONFORMS | row checkbox and button `disabled={busy}` (`TP:215`, `TP:242`), `TP:480`, `TP:489`; guard `TP:383`; page-owned busy / guard (OD-3) `TP:579-581` |
| 4.5 | runner: set busy, clear results, snapshot whole Tours; per id in LIST ORDER one at a time: re-read; fail -> "Could not check the tour"; not scheduled or scheduledAt differs -> "Changed since the list loaded"; PATCH `{ status: 'toured' }` -> ok or "The update failed"; prune succeeded ids; reload; clear busy | CONFORMS | `TP:382-419`: `TP:384`, `TP:387-390`, `TP:395`, `TP:397`, `TP:400`, `TP:405-408`, `TP:411-416`, `TP:417`, `TP:418-419`; list order = `notMarkedIds` order passed at `TP:490` |
| 4.5 | per-row line "Marked toured" (`role="status"`, muted) or "Could not mark toured: <message>" (`role="alert"`); fixed messages only | CONFORMS | `TP:262-272`; `MarkFailure` union `TP:555` |
| 4.5 | results whose id the reload dropped: block ABOVE the toolbar, from the snapshot, "<tenant> at <property> on <date-time>: ..." | CONFORMS (see C-5 on roles) | `vanished` `TP:345-364`; blocks `TP:445-463` precede the toolbar `TP:471` |
| 4.5 | batch sends only `status: 'toured'` | CONFORMS | `TP:405` |
| 4.6 | TourDetail reads the query once the tour has loaded; `outcome=1` + toured + no outcome -> dialog; else nothing | CONFORMS | `TourDetailLoaded` is mounted after load and keyed by tourId `TD:143-144`; `TD:264-265`; state initializer `TD:266-268` (equivalent to `setModal('outcome')`, lint-safe) |
| 4.6 | param removed by a replace navigation carrying `location.state`; nothing runs without the param | CONFORMS | `TD:270` early return; `TD:273` `setSearchParams(next, { replace: true, state: location.state })` |
| 4.6 | back arrow (aria "Back to tours") -> state.back when exactly `/tours`, `/tours/past`, `/tours/closed`, else `/tours`; Active/Closed rows keep linking without state | CONFORMS | `TD:103`, `TD:107-110`, `TD:252`, `TD:630`; TourRow unchanged (its aria `TP:156`, no state) |
| 4.7 | no status change except the human clicks; no write on load / select / view change / navigation | CONFORMS | the only write is `patchTour` `TP:405`, reachable only from the two click handlers `TP:490`, `TP:504`; the hook only reads `UT:261` |
| 4.7 | never PATCH a tour whose current status is not scheduled or whose time changed | CONFORMS | `TP:400` |
| 4.7 | no send; e2e proves the thread-store outbound count unchanged | CONFORMS | ToursPage imports only `getTour` / `patchTour` besides reads; `e2e/tests/dashboard-next/tours-past.spec.ts:139`, `:151` (plus OD-4 `:154-155`) |
| 4.7 | nothing closes on its own; requested stays in Needs booking | CONFORMS | body is status-only (unit test asserts the keys: `ToursPage.test.tsx:930-932`); requested is never in the range result or `PAST_TAB_STATUSES` |
| 4.8 | 360px: identity stacks over meta (existing query) | CONFORMS | `TPcss:200-220` applies inside the link |
| 4.8 | 360px: the checkbox stays leading | PARTIAL (C-1) | literally first and at the leading edge, but alone on its own line above its card (`TPcss:261-264`, `:355-363`) |
| 4.8 | 360px: the action wraps under the link | CONFORMS | `TPcss:359-362` |
| 4.8 | e2e: no horizontal overflow on /tours/past with rows and on the tenant file with the editor open | CONFORMS | `tours-past.spec.ts:129-133`, `:189-194`; `tenant-staff-notes.spec.ts:79-89` |
| 5 | test lists | see the section 5 table | two items weaker than specified (C-2) |
| 6 | non-goals | CONFORMS | no calendar view; the batch body is status-only; no no-show exit; no timeless rows; no card on other kinds; toProfile untouched; `app/src/routes/tours.ts` and the repos not in the diff; no optimistic concurrency; the prompt, catalog, import, seeds and public sign-up are not in the diff |
| 7 | files touched vs the list; off-limits untouched | CONFORMS (one adjudicated extra) | see the section 7 paragraph |
| 8 | six issues filed with the listed type / severity | CONFORMS | all six present with matching frontmatter (type and severity as listed); a seventh, `perf-pages-tours-past-surface.md` (improvement, low), comes from OD-1 |

## Conformance table - work-map slices

Every line-number claim in each slice report below was re-checked against HEAD
and holds.

| slice | plan task | verdict | evidence |
|---|---|---|---|
| S1 | Task 1 (app) | CONFORMS | `8c428d79`; 3 files as mapped; 8 tests at `contactStaffNotes.test.ts:45-214` |
| S2 | Tasks 2-4 (types, card, wiring) | CONFORMS | `07a53864`, `283d4d1f`, `c4dd9c95`; 11 card tests (10 plan + the OD-2 pin); 2 TenantFile tests |
| S3 | Task 5 (e2e Part 1) | CONFORMS | `c8d48fd5`; both locator sites scoped (`contact-detail.spec.ts:60-62`, `:76`); D1-R1 card-level overflow check `tenant-staff-notes.spec.ts:89` |
| S4 | Task 6 (useTours) | CONFORMS | `2bac788c`; exports `UT:157-278`; 16 new tests |
| S5 | Task 7 + D2-R1 | CONFORMS | `c39989fe`, `0ad6200a`; OD-1, OD-3, OD-6, D2-R2 (`let release` has no initializer), D2-R3 (`RefObject`), D2-R7 (`mockReset`) and D2-R8 (comments) all present; 14 new Past tests |
| S6 | Task 8 (TourDetail) | CONFORMS | `c4de3fe4`; 7 new tests at `TourDetail.test.tsx:1842-1897` |
| S7 | Task 9 (e2e Part 2) | CONFORMS | `46305bf8`; E-3 `test.slow()` `:76`, OD-4 `:142`, `:154-155`, E-5 `:194`; pre-batch 360px block `:126-134` (an addition, sound) |
| S8 | orchestrator gates | not in scope | typecheck / test / smoke exit 0 in `p3-timeline.log`; e2e was still running |

## Section 5 - the listed tests

| spec 5 item | test (file:line) | verdict |
|---|---|---|
| app: PATCH x -> 200, stored, ISO stamp, notes untouched, no _source, audit fields ['staff_notes'] | `app/test/contactStaffNotes.test.ts:45` | CONFORMS (the array `toMatchObject` is length-exact) |
| app: '' clears and re-stamps | `:68` | CONFORMS |
| app: 5 -> 400 exact message | `:83` | CONFORMS |
| app: client stamp alone -> 400 no updatable fields; beside staff_notes ignored, server stamp wins | `:94` | CONFORMS |
| app: notes-only PATCH leaves staff_notes and stamp | `:114` | CONFORMS |
| app: POST with staff_notes -> none on the created contact | `:128` | CONFORMS |
| app: toProfile omits the key | `:149` | CONFORMS |
| app: apply with a direct write AND a note line -> no update call carries either key (ALL calls) | `:162` | CONFORMS (loop over every recorded call; asserts at least two calls) |
| useTours: window, same calendar construction, November DST case | `dashboard/src/routes/tours/useTours.test.ts:213`, `:224`, `:231` | CONFORMS (the November case discriminates in a US zone: a millisecond subtraction lands on 01:00) |
| useTours: selectPastTours drops canceled / closed, today's scheduled, not_a_fit; keeps Needs placement and a later-today toured row; order + tiebreak; no mutation | `:267`, `:280` | CONFORMS |
| useTours: pastState four cases + fallback + precedence | `:289-306` | CONFORMS |
| useTours: usePastTours idle until enabled, window, reload keeps rows, failed reload flag cleared by success, failed first load = error | `:328`, `:334`, `:351`, `:364`, `:372` | CONFORMS |
| ToursPage: three tabs, Past current on /tours/past | `ToursPage.test.tsx:473` (all three tabs on /tours), `:687` (Past current) | CONFORMS (order not asserted - C-4) |
| ToursPage: rows (date-time, tenant, property, chip; date-time in every label) | `:703`, `:724`, `:751` | CONFORMS (Record outcome label only regex-matched - C-4) |
| ToursPage: actions per state, Record outcome href + state.back | `:751` | CONFORMS |
| ToursPage: select-all + bulk count | `:772` | CONFORMS |
| ToursPage: re-reads each; patchTour once per still-scheduled id; sequential (second call waits for the first) | `:772`, `:920` | WEAKER (C-2): no test ever issues a second patchTour |
| ToursPage: skips a re-read no longer scheduled AND one rescheduled | `:772` (canceled), `:936` (rescheduled) | CONFORMS |
| ToursPage: per-row lines + above-toolbar block for dropped rows | `:772`, `:822` | CONFORMS |
| ToursPage: every mark control disabled while running, then reload | `:772`, `:875` | CONFORMS |
| ToursPage: failed reload keeps rows AND results, one refresh alert | `:979` | WEAKER (C-2): no batch, so results are not shown kept |
| ToursPage: view switch resets selection and results | `:855` | CONFORMS |
| ToursPage: bulk located by anchored name | `:772` etc. | CONFORMS (a Testing Library string `name` is an exact full-string match) |
| ToursPage: existing Active / Closed tests pass under `view` | `:473-649` | CONFORMS (gate 2 green) |
| TourDetail: ?outcome=1 opens + strips WHILE KEEPING state.back | `dashboard/src/routes/tours/TourDetail.test.tsx:1853` (and `:1842`) | CONFORMS |
| TourDetail: nothing on scheduled / on toured-with-outcome | `:1862`, `:1871` | CONFORMS |
| TourDetail: without the param the state is untouched | `:1885` (state survives mount + effects) | CONFORMS |
| TourDetail: back arrow honors /tours/past, ignores other values | `:1885`, `:1892` | CONFORMS (no-state fallback not asserted - C-3) |
| StaffNotesCard: empty / filled read modes, Last edited only with text | `dashboard/src/routes/contact/StaffNotesCard.test.tsx:45`, `:61`, `:75` | CONFORMS |
| StaffNotesCard: Edit -> prefilled + focused -> Save `{ staff_notes }` -> hands the contact up | `:89` | CONFORMS |
| StaffNotesCard: Cancel no request; unchanged Save no request; failed save keeps draft + fixed alert | `:124`, `:135` (+ `:144` OD-2), `:156` | CONFORMS |
| StaffNotesCard: no action without onContactUpdated; aside absent in edit mode | `:80`, `:89` | CONFORMS |
| TenantFile: above Preferences & notes for a tenant; none for team_member | `dashboard/src/routes/contact/TenantFile.test.tsx:49`, `:62` | CONFORMS ("directly" asserted as document order only - C-4) |
| e2e contact-detail: both Notes locators scoped to the Edit dialog, no assertion change | `e2e/tests/dashboard-next/contact-detail.spec.ts:60-62`, `:76` | CONFORMS (site 2 builds the dialog locator inline instead of reusing the `dialog` variable - same scoping, the plan's text) |
| e2e tenant-staff-notes: reseed; + Add; exact label; Save; Last edited; reload; prefs innerText identical; 360px edit mode; clear | `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts:30-33`, `:52-66`, `:69-73`, `:79-89`, `:96-101` | CONFORMS |
| e2e tours-past: reseed; three tours 1/2/3 days back at 10:00 over two units; PATCH toured / no_show; exactly three, states, order; none in Active; outbound count; anchored bulk (1); Needs outcome + Record outcome; count unchanged; toured, no outcome on the wire; dialog open + no ?outcome; Cancel; back to Past; 360px | `tours-past.spec.ts:69-72`, `:82-86`, `:88-97`, `:107-124`, `:139-161`, `:164-171`, `:129-133`, `:189-194` | CONFORMS |

## Section 7 - files touched

Every file on the spec's list is touched:

- app: `contacts.ts`, `contactsRepo.ts` (type only), `contactStaffNotes.test.ts`;
- dashboard: `types.ts` (+10/-0), `App.tsx`, `StaffNotesCard` (+ test, + CSS),
  `TenantFile.tsx` (+ new test), `ContactDetail.tsx` (+1 line), `useTours`
  (+ test), `ToursPage` (+ test, + CSS), `TourDetail` (+ test);
- e2e: `contact-detail.spec.ts` and the two new specs;
- docs: `GLOSSARY.md` and the six issue files.

Files the list does not name:

- `e2e/performance/routes.test.ts` - two lines, adjudicated under OD-1 (judged
  below).
- `docs/issues/perf-pages-tours-past-surface.md` - the OD-1 issue.
- The N5 addendum edits `staff-notes-on-landlord-partner-files.md`, which is a
  listed file.

No off-limits path appears anywhere in the branch diff (`git diff --stat
0dafe3c1..HEAD`, 58 files). `client.ts` and `endpoints.ts` are untouched.

## OD-1..OD-6 judgments

- OD-1 (exclude `/tours/past` from the route-registry pin; file an issue).
  - Shipped as recorded: `e2e/performance/routes.test.ts:380-381`, a
    one-line comment naming the issue, and `docs/issues/perf-pages-tours-past-surface.md`.
  - Spec text vs decision: spec 7 does not list `routes.test.ts`. That is a
    spec omission - the pin reads `App.tsx` (`routes.test.ts:347-387`) and
    runs in gate 2, which the spec requires green.
  - HONORS the spec and AGENTS.md. The pin's own design is "profiled, or
    excluded with a stated reason" (see the neighboring entries at `:375-384`).
    Registering a 32nd surface would change Cameron's perf:pages contract
    ("exactly 31 registered surfaces") and its human-run self-QA, which AGENTS.md
    keeps human-owned.
  - Side effect: the existing perf ledger's Tours citations are now stale
    (C-6).
- OD-2 (no-op Save compares trimmed values).
  - Shipped as recorded: `SNC:76`. The request still sends the raw draft
    (`SNC:83`); pin test `StaffNotesCard.test.tsx:144`.
  - Spec text vs decision: spec 3.6 says "draft equal to the stored value". The
    code widens "equal" to "equal after `String.prototype.trim`", which is
    exactly the server's own normalization (`deepTrimStrings`). So it compares
    the values the server would store.
  - HONORS the intent: no request and no re-stamp when nothing would change.
- OD-3 (page-owned busy flag and reload pointer).
  - Shipped as recorded: `TP:579-581` (page state and refs), `TP:313-318`
    (register / clear in an effect, a ref write only), `TP:383`, `TP:388`,
    `TP:417-419`; mid-batch test `ToursPage.test.tsx:875`.
  - Spec text vs decision: 4.5 makes selection and results child-scoped. The
    busy flag is neither, so moving it to the page contradicts no sentence.
    It is what keeps 4.5's "EVERY mark control is disabled while a batch
    runs" true across a Past -> Active -> Past remount, and it sends step 4's
    reload to the view that is mounted.
  - HONORS the spec. Residuals are in C-7.
- OD-4 (keep the global outbound delta; add per-party since-scoped checks).
  - Shipped as recorded: `tours-past.spec.ts:139`, `:142`, `:151`, `:154-155`.
  - A strict superset of the 4.7 proof. HONORS.
- OD-5 (keep the house-style `:5174` fallback).
  - Shipped as recorded: `tenant-staff-notes.spec.ts:21`, `tours-past.spec.ts:29`.
  - The spec is silent. Consistent with the other 57 specs, and unreachable
    under `npm run e2e`.
  - HONORS. The pre-existing hazard is in C-8.
- OD-6 (whenLabel maps U+202F / U+00A0 to a plain space).
  - Shipped as recorded: `TP:559`, `TP:564-569`; test helper and portability
    test `ToursPage.test.tsx:724`. The page source is ASCII - the escapes are
    written as backslash-u.
  - Spec text vs decision: 4.3 says "formatDate + formatTime joined with ', '".
    The spec's own example uses a plain space, and 4.3's requirement is that
    the row text and every label carry the SAME string - they do, from one
    function.
  - HONORS. Visible delta: the Past time text is normalized while
    Active / Closed are not; the two look identical.

## Findings

### C-1 - SHOULD-FIX - at 360px a "Not marked" row's checkbox sits alone above its card

- Where: `dashboard/src/routes/tours/ToursPage.module.css:261-264` (`.pastRow > .row { flex: 1 1 auto; min-width: 0; }`) with the 560px container query `:355-363`.
- Evidence:
  - The S7 builder observed it in the real app (O-1; geometry: checkbox
    24,286 18x18; card 24,311 312x124).
  - This review reproduced it with the shipped rules in Chromium (probe
    below): checkbox at (0,0) 18x18 on line 1; card at (0,26) 312 wide on
    line 2; actions at (0,149) on line 3.
  - The CSS's own comment (`:353-354`) promises that "the checkbox stays
    leading on the first line". It is on the first line, but alone.
- Failure scenario: at phone width with any "Not marked" rows, the per-row
  checkbox floats in a column with the toolbar's "Select all not marked" box
  (S7 O-1) and reads as belonging to the toolbar, not to its tour. The literal
  4.8 words hold (the checkbox is first and at the leading edge); the intent,
  a selection affordance attached to its row, does not.
- Correction: one declaration. At `:262` change `flex: 1 1 auto` to
  `flex: 1 1 0` (or scope it: `flex-basis: 0` for `.pastRow > .row` inside the
  `:355` query), and update the `:353-354` comment. Verified in the probe:
  - the checkbox shares line 1 with the card (card x=26, w=286, checkbox
    vertically centered);
  - the actions alone wrap to line 2, right-aligned;
  - no overflow anywhere;
  - desktop geometry is identical under all three variants.

  Optionally pin it in `tours-past.spec.ts`'s pre-batch 360px block: assert
  that the checkbox's box lies within the card's vertical span.

### C-2 - SHOULD-FIX - two ToursPage tests are weaker than spec 5 lists them

- Where: `dashboard/src/routes/tours/ToursPage.test.tsx:772-820` and `:979-987`.
- Evidence (a):
  - Spec 5: "calls `patchTour` once per id that is still scheduled AT THE SAME
    TIME, sequentially (the second call does not start until the first
    resolves)".
  - No unit test, and not the e2e (it has one Not marked row), ever issues a
    SECOND patchTour. The bulk test's second id re-reads as canceled
    (`:776-778`), and the other runner tests mark one id each (`:822`, `:875`,
    `:920`).
  - Sequencing is shown only as "the second RE-READ waits for the first
    PATCH" (`:798-799`).
- Evidence (b):
  - Spec 5: "a failed reload keeps the rows AND RESULTS and shows the one
    refresh alert".
  - `:979` seeds `reloadFailed: true` at first render with no batch, so no
    result line exists to be kept. Its "above the toolbar" title is not
    asserted either.
- Failure scenario:
  - (a) A regression that PATCHed only the first eligible id, or that started
    PATCH 2 before PATCH 1 settled on a path that skips the re-read, passes
    every unit test and the e2e.
  - (b) A regression that cleared results on a failed reload passes. Low risk
    today: the runner is a plain for-await loop (`TP:392-410`) and the results
    are child state untouched by the reload.
- Correction:
  - (a) In the bulk test, let the second id re-read as scheduled at the SAME
    time. Hold PATCH 1 and assert `patchTour` has one call. Release, then
    assert the order `['p1', 'p4']` and that both rows read "Marked toured".
  - (b) Add a test whose `reloadPast` swaps `pastRows` to
    `{ ...same rows, reloadFailed: true }` after a batch. Assert that the
    per-row line survives, that exactly one refresh alert exists, and that the
    alert precedes the toolbar in document order.

### C-3 - NOTE - the back-arrow no-state fallback is not unit-asserted

`TourDetail.test.tsx:1892` is titled "without state or with a foreign path" but
exercises only `{ back: '/contacts/evil' }`. No test asserts `href="/tours"`
with no state: `:199` only waits for the link. Nor is `/tours/closed` or
`/tours` asserted as an honored value. By construction the behavior is correct
(`TD:107-110`, an exact Set). The S7 control NC-D showed the no-state case in
a real browser, but that control is not committed. Correction if wanted: one
`renderAt('')` case asserting `/tours`.

### C-4 - NOTE - specified behaviors with no test (not on spec 5's lists)

None of these is a spec-5 omission; each is specified behavior the suites do
not pin:

- the select-all INDETERMINATE state (4.5; `TP:477-479`);
- the card's in-flight state (3.6: both buttons disabled, textarea read-only;
  `SNC:134`, `:143`, `:146`);
- the tab ORDER Active, Past, Closed (4.1);
- the Record outcome label's date-time, matched only by
  `/^Record outcome: .* on /` (`ToursPage.test.tsx:762`);
- "directly above", asserted as document order (`TenantFile.test.tsx:54`);
- Cancel "discards the draft", asserted as no request plus the stored text
  (`StaffNotesCard.test.tsx:124-133`), not by re-entering edit.

### C-5 - NOTE - above-toolbar result blocks carry their role per block, not per line

`TP:446` is one `role="status"` div holding every success line. `TP:456` is one
`role="alert"` div holding every failure line.

Spec 4.5 ("a block ABOVE the toolbar, one line per tour ...: X (`role="status"`)
or Y (`role="alert"`)") reads either way. The plan prescribed exactly this shape
(plan `:2493-2505`), and the result is equivalent for assistive technology.
Nothing to change unless the spec author meant per-line roles.

### C-6 - NOTE - the perf ledger's Tours citations are stale after this branch's line shifts

`e2e/performance/routes.ts` cites Tours line ranges at `:131`, `:686-687`,
`:716`, `:740-741`, `:759`, `:768` and `:1077`. All of them point into
`ToursPage.tsx`, `useTours.ts` and `TourDetail.tsx`, which this branch shifted.
Examples:

- `ToursPage.tsx:181-185` pointed at the contacts / units lookups at base and
  now points at `PastTourRowProps`;
- `TourDetail.tsx:551` moved off the Mark-toured CTA.

Gate 2 stays green because `routes.test.ts:422-426` checks the citation FORMAT
only. The OD-1 issue's suggested fix already says to refresh them. It could
say plainly that the existing `/tours`, `/tours/closed` and `/tours/:tourId`
rows are stale NOW, not only once `/tours/past` is registered. Doc-only; no
behavior impact.

### C-7 - NOTE - OD-3 residuals (recorded by S5, repeated for the handback)

(i) The in-flight guard is scoped to the page. Leaving `/tours*` entirely
mid-batch and coming back mounts a new page with a clear guard, so a second
batch can run beside the first. 4.5's "ignores a call while one is in flight"
therefore holds per page instance. The per-id re-read bounds the damage: a
tour already marked re-reads as toured and is skipped.

(ii) A batch that straddles a view change never shows its results. The
remounted view starts fresh, and the old instance's `setResults` is a no-op.
So a FAILURE in that batch is reported only implicitly: the refreshed row
still reads "Not marked". This is consistent with 4.5's "results start fresh
every time Past shows", but in tension with its "no result is ever silent".

### C-8 - NOTE - OD-5's `:5174` fallback reaches a reseed

Both new specs POST `/__dev/reseed` in `beforeAll` to `NEXT`
(`tenant-staff-notes.spec.ts:30-33`, `tours-past.spec.ts:69-72`). `NEXT` falls
back to the human's live port when `E2E_DASHBOARD_URL` is unset. A stray
Playwright invocation outside `npm run e2e` would therefore aim a reseed and
tour creation at the lane AGENTS.md forbids.

This is the house style of the other 57 specs and unreachable under the
sanctioned entry. It is pre-existing and repo-wide, and a fix is its own change
(for example, failing fast when the env var is unset).

### C-9 - NOTE - desktop row edges are ragged; the spec does not specify cross-row alignment

See the alignment assessment below. This is a product-eye note, not a
conformance issue.

## 360px assessment (S7 O-1) - the layout mechanics

1. Under the 560px container query, `.pastRow` wraps (`TPcss:356-358`). Its
   children are:
   - the checkbox (`flex: 0 0 auto`, about 18px, `:266-272`);
   - the link (`flex: 1 1 auto; min-width: 0`, `:261-264`);
   - the actions (`flex: 1 1 100%`, `:359-362`).
2. A wrapping flex container breaks lines by each item's HYPOTHETICAL main
   size: the flex base size clamped by min/max (CSS Flexbox 9.2 step 3E and
   9.3 step 5). `flex-basis: auto` with `width: auto` makes the link's base
   size its max-content width. In the probe that is 557px: the tenant/property
   column, the gap, the date-time and chip, and the padding, laid side by side.
3. `min-width: 0` lowers only the MIN clamp. It lets the link SHRINK after
   line breaking; it does not shrink the size that line breaking uses.
4. So 18 + 8 + 557 > 312:
   - the link cannot share line 1, and starts line 2, where it shrinks to
     312px and the inner `.row` query stacks identity over meta;
   - the actions' 100% basis forces line 3;
   - line 1 keeps the checkbox alone. Its flex-grow is 0, so it stays 18px at
     the left edge.

Smallest fix: give the link a zero basis. Use `flex: 1 1 0` at `:262`, or
`flex-basis: 0` for `.pastRow > .row` inside the `:355` query.

- The link's hypothetical size becomes 0, so line 1 holds checkbox + link.
  The link then grows into the free 312 - 18 - 8 = 286px.
- The actions still cannot fit beside them (100% basis) and wrap alone to
  line 2, right-aligned.
- Rows without a checkbox are unaffected. The Needs-outcome link still fills
  line 1 and its action wraps under it.
- Above 560px `.pastRow` does not wrap, and the link is the only flexible
  item, so its final width is the container minus its fixed siblings under
  either basis. The probe measured identical desktop geometry: links 863, 887
  and 992px at a 992px pane, all three variants.

## Alignment assessment (S7 O-2)

Spec 4.3 places the identity block left and "the meta chips, right" INSIDE each
row. Its row structure puts the checkbox before the link and the actions after
it, as siblings, only on some rows. It says nothing about aligning chips ACROSS
rows.

With that structure the cards must differ in width:

- probe, 992px pane: 863px (checkbox + button), 887px (link action), 992px
  (no action);
- S7 right edges: 1149, 1151, 1256.

So the chips end at different x positions. This is a design call, not a
conformance issue. If Sam or Cameron want aligned chips, reserve fixed slots on
every row: a leading slot the checkbox's width (an inert spacer when there is
no checkbox) and a trailing slot the widest action's width (about 99px), or use
a grid with those two fixed columns.

## Checked and holding

- ASCII: the charged command on app, dashboard and e2e added lines prints 0.
  The same check on docs and documentation also prints 0.
- LF-only: 0 CR bytes in every touched code file.
- Every branch commit (`0dafe3c1..HEAD`) carries a Co-Authored-By trailer.
- Vocabulary: no added UI copy says "unit" or "home". Rows name the property
  by address (AGENTS.md product vocabulary). No catalog copy was needed: all
  of it is staff-facing.
- Exact copy matches the spec: "Staff notes", "No staff notes yet.", "Last
  edited <date>", "Edit" / "+ Add" with "Edit staff notes" / "Add staff
  notes", "Save", "Cancel", "Could not save staff notes. Try again.", "Past
  tours", the intro line, "Select all not marked", "Mark toured (N)", "Mark
  toured", "Record outcome", "Marked toured", "Could not mark toured:
  <message>", the three fixed messages, "Could not refresh the list. Reload
  the page to see the latest.", "Back to tours".
- Request bodies:
  - `{ staff_notes: draft }` only (`SNC:83`);
  - `getTours({ from, to })` only (`UT:261`);
  - `{ status: 'toured' }` only (`TP:405`; keys asserted at
    `ToursPage.test.tsx:930-932`).
  - The server ignores a client `staff_notes_updated_at` (`CT:574-583` never
    copies it).
- String compares are sound: the client's today boundary, sort and re-read
  guard compare ISO strings, and the server canonicalizes `scheduledAt` on
  create and PATCH.
- `?outcome=1` triggers only on the exact value '1'. The strip is a replace
  that carries state. Without the param no effect navigates, so the row-link
  path keeps its state (the e2e back-arrow proof is at `tours-past.spec.ts:183-184`).
- The Past hook is never called on Active or Closed (`ToursPage.test.tsx:473`),
  so the profiler's `/tours` and `/tours/closed` GET contracts are unchanged.
- The e2e specs use anchored or exact names wherever substring matching would
  collide:
  - `/^Mark toured \(1\)$/`;
  - `exact: true` on "Staff notes" / "Add staff notes";
  - the dialog-scoped Cancel.
- Every file-and-line claim in slice reports S1-S7 re-checked against HEAD, and
  each holds (for example S5's `markToured` at `TP:382`, S6's strip at
  `TD:273`, S4's exports at `UT:157-238`).

## Probe disclosure

To test the C-1 mechanics I wrote
`.superpowers/review/zz-review-scratch.layout.html` (the shipped Past-row CSS
with tokens resolved) and deleted it afterwards. The attempts, in order:

- The built-in browser pane refused to script a local file.
- The project Playwright MCP has no browser installed. I did not install one;
  that would be a download.
- The plugin Playwright MCP blocks `file:`, so the same CSS and markup were
  injected into `about:blank` and measured there. That browser is now closed.
- That MCP wrote a 0-byte snapshot, `page-2026-09-27T08-24-53-438Z.yml`, into
  the MAIN checkout's gitignored `.playwright-mcp/`. It was an automatic side
  effect of the navigate call. I removed that single file, and `git status` in
  the main checkout is clean.

No source file was modified. No unit, smoke, lint or e2e suite, session, lane
port or `e2e/.artifacts` path was touched.

Not mine, left untouched: at the end of this review the worktree held three
untracked probe files created at 04:30-04:31 local by another agent. A later
`npm test` would collect all three, so their owners must delete them before
any commit or gate rerun:

- `app/test/zz-review-scratch.tours-window.test.ts`
- `dashboard/src/routes/contact/zz-review-scratch.staffnotes.test.tsx`
- `dashboard/src/routes/tours/zz-review-scratch.remount.test.tsx`
