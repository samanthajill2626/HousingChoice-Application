# Planner review - adversarial (plan-blind) - feat/staff-notes-past-tours

Reviewer input: the diff `git diff main...HEAD -- app dashboard e2e` (25 files,
+3049/-75, branch cut from main @0dafe3c1, HEAD 821d8a36) and the repository.
No spec, plan, worklist or handback was read. Read-only review: no suites run.
`npx eslint` was run on the branch's touched code files (read-only) for the
gate-5 ratchet check only.

Severity is by consequence if the branch ships unfixed. Nothing found is
BLOCKING. Items already filed in `docs/issues/` are listed at the end and not
re-reported.

---

## F1. [MEDIUM] A Staff notes save from a stale page silently destroys a colleague's note, unrecoverably

**What is wrong.** The Staff notes editor opens on whatever `staff_notes` the
page loaded, and nothing ever refreshes that value while the page is open. A
save sends the whole box (`PATCH { staff_notes: draft }`), which the server
SETs unconditionally. So the "last write wins" window is not "two staff saving
at once" (the header comment's framing) - it is the entire lifetime of any
open tenant page.

**Evidence.**
- `dashboard/src/routes/contact/StaffNotesCard.tsx:65-70` - `startEdit` seeds
  `draft` and `baseline` from the in-memory prop; no refetch on open.
- `StaffNotesCard.tsx:79` - the only guard is `draft.trim() === baseline.trim()`
  (an UNTOUCHED save is skipped; any edited save goes out).
- `StaffNotesCard.tsx:86` - `updateContact(contactId, { staff_notes: draft })`,
  no version / precondition.
- `app/src/routes/contacts.ts:578-583, 1521-1523, 1573` - parse, stamp, and a
  plain `contacts.update` SET. `staff_notes_updated_at` exists and would be a
  ready-made version token, but nothing compares it.
- `dashboard/src/routes/contact/useContact.ts:60-71` - the page refetches the
  contact ONLY on `suggestion.updated` (an extraction run). There is no
  server-emitted contact event at all (`grep "emit('contact."` in `app/src`
  returns nothing), so another staffer's save never reaches an open page.
- `app/src/routes/contacts.ts:1817-1821` - the audit row carries
  `fields: ['staff_notes']` and the actor only, never the old value.
- `StaffNotesCard.test.tsx:173` pins this as intended ("an EDITED draft still
  saves after the stored value moved ... last write wins").

**Repro story.** Staffer A opens Tasha's file at 09:00 (box empty, card reads
"No staff notes yet."). Staffer B, on another machine, adds "Has a service dog
- call before visits" at 10:00. A's page never learns of it. At 11:00 A clicks
"+ Add", types "Prefers mornings", Save: draft != baseline (''), PATCH goes
out, the server SETs `staff_notes = 'Prefers mornings'`. B's note is gone; the
audit trail says only that `staff_notes` changed. Nothing in the app can
recover the text (UNVERIFIED whether DynamoDB PITR is enabled on the contacts
table in prod).

**Implies.** The feature's purpose is a shared hand-written box several staff
write into over days; stale tabs are the normal case, so silent loss of another
person's note is a realistic, recurring outcome, not a race. Cheapest guards:
refetch the contact when the editor opens, and/or send the
`staff_notes_updated_at` the editor opened with and have the route answer 409
when the stored stamp differs.

---

## F2. [LOW] A tab switch or route change mid-batch drops every per-row Mark toured result, failures included

**What is wrong.** The bulk runner accumulates all results locally and hands
them to `setResults` only after the LAST id (`ToursPage.tsx:459`). Those
setters belong to the view instance that STARTED the batch. The module store
correctly carries the busy flag and the reload to a remounted view
(`ToursPage.tsx:299-328, 465`), but not the results or the snapshot. A
remounted Past view therefore renders no per-row line and no above-toolbar
"vanished" block for that batch.

**Evidence.**
- `ToursPage.tsx:366-368` - `selectedIds`, `results`, `snapshot` are component
  state of `PastToursView`.
- `ToursPage.tsx:459-465` - `setResults(next)` (lands on the unmounted
  instance, as the comment at 472-477 concedes), then `mountedPastReload?.()`
  (reaches the NEW instance).
- `ToursPage.tsx:383-385` - the code's own contract: "no result is ever silent
  (spec 4.5)".
- Row links stay enabled during a batch by design, and the unit test
  `ToursPage.test.tsx:1006` exercises exactly this navigation; it and the
  tab-round-trip test at `:960` assert only that the reload reached the
  remounted view (`:997`, `:1048`), never that the batch's results were
  reported.

**Repro story.** Select 12 "Not marked" rows, click Mark toured (12). The batch
is 24 sequential round trips with no progress shown (see F3). Staff clicks a
row to peek, then the back arrow (state.back returns to /tours/past). The batch
ends: a row a colleague canceled meanwhile ("Changed since the list loaded")
drops out of the reloaded list with no line anywhere; a row whose PATCH 500'd
("The update failed") is back to plain "Not marked" with no alert. Staff has
no way to learn either happened.

**Implies.** The end state on screen is truthful, but the "why" (and the fact
that anything failed) is lost exactly on the path the design deliberately
supports. Holding `results`/`snapshot` in the same module store as the flag
(keyed by batch) would carry them to whichever view is mounted.

---

## F3. [LOW] The module-scoped busy flag has no timeout and no visible state: a stalled request freezes every Past control in the tab with no explanation

**What is wrong.** `batchRunning` is released only in the runner's `finally`
(`ToursPage.tsx:466-468`). The API client has no request timeout (no
`timeout` / `AbortSignal.timeout` in `dashboard/src/api/client.ts`),
`getTour(id)` is called without a signal (`ToursPage.tsx:441`) and `patchTour`
takes none (`dashboard/src/api/endpoints.ts:2623-2637`). A stalled connection
(laptop sleep, captive network) therefore holds the flag until the browser
abandons the socket. Meanwhile every Past view in the tab renders every
checkbox and Mark toured control disabled (`bulkBusy`,
`ToursPage.tsx:348, 534, 543, 559`) and nothing on the page says a batch is
running - there is no progress, count, spinner or `aria-busy` anywhere in
`PastToursView`. The comment at `ToursPage.tsx:471` acknowledges the hang.

**Implies.** The only recovery is a full page reload, which also silently
abandons the remaining ids. Even without a hang, a long batch shows nothing
but disabled controls for its whole duration, which is what invites the
navigation in F2.

---

## F4. [LOW] The Past row's accessible name hides the row's state - the one thing the tab exists to show

**What is wrong.** Each Past row link sets `aria-label={\`Tour for ${who}\`}`
(`ToursPage.tsx:234`), which replaces the link's content - including the state
chip `pastState(tour)` rendered inside it (`ToursPage.tsx:242`). "No show" and
"Needs placement" rows carry no other control, so for a screen-reader user
those two states are indistinguishable, and "Not marked" / "Needs outcome" can
only be inferred from which extra controls exist. The Active/Closed `TourRow`
has the same override (`ToursPage.tsx:159`, pre-existing), but there the badges
are secondary; on Past the state is the triage signal.

**Implies.** Append the state to the label (e.g. "Tour for X at Y on <when>,
Not marked") or drop the aria-label override in favor of content naming.

---

## F5. [LOW] Focus is dropped to the document body after Staff notes Save/Cancel and after a Past row's action completes

**What is wrong.** `StaffNotesCard` focuses the textarea on entry
(`StaffNotesCard.tsx:61-63`) but on Save or Cancel the form that holds focus
unmounts and the "Edit"/"+ Add" aside is re-created
(`StaffNotesCard.tsx:112`, `aside={editing ? undefined : aside}`) with no
focus restore, so keyboard focus lands on `<body>`. Likewise a Past row's
"Mark toured" button unmounts when the reload turns the row "Needs outcome"
(`ToursPage.tsx:246-257`). No test pins focus after either action.

---

## F6. [LOW] The perf-ledger Tours citations that commit dd06c7f1 refreshed are stale again at HEAD

**What is wrong.** `dd06c7f1` ("refresh the Tours citations ... to the lines
that now hold the cited code") was correct at that commit, but the later
fix-wave commits (3883d084, 57bdfe66, 9382e0c7) added 12 lines above the cited
code in `ToursPage.tsx`. At HEAD:
- `e2e/performance/routes.ts:686-687` cite `ToursPage.tsx:618-622` - that is now
  `whenLabel` (618-623); the cross-reference hooks are at 630-635.
- `routes.ts:716` cites `ToursPage.tsx:618-635`; `useClosedTours` is at 643.
- `routes.ts:740-741` cite `ToursPage.tsx:695-793`; the render starts at 704-705
  (695 is inside the `upcomingGroups` memo), and 805 holds the Closed list that
  793 held at dd06c7f1.

`routes.test.ts:421-454` only format-checks citations, so no gate catches it.
Documentation rot in a ledger this branch explicitly set out to refresh.

---

## F7. [LOW] Every Staff notes save runs the triage PATCH's thread propagation and fans a conversation.updated firehose out to every dashboard

**What is wrong.** Staff notes ride the generic `PATCH /api/contacts/:id`.
For any tenant with a name and linked 1:1 threads, that handler rewrites
`participant_display_name` on every linked thread and emits
`conversation.updated` per thread regardless of which field changed
(`app/src/routes/contacts.ts:1752-1792`). On the client that event makes every
connected dashboard refetch unread counts (`dashboard/src/app/UnreadContext.tsx:287`)
and every open contact page, for ANY contact, refetch its media gallery
(`dashboard/src/routes/contact/useContactMedia.ts:141`, unfiltered). Pre-existing
behavior of the route, but the Staff notes card makes a staff-only, text-only
edit the most frequent trigger of it.

**Implies.** Extra writes and org-wide refetch churn per note save; no wrong
data. Skipping propagation when the patch touches only non-identity fields
would remove it.

---

## F8. [LOW] Test hygiene: a production-module test hook, and a DST test that is vacuous off a DST host

- `ToursPage.tsx:325` exports `resetBulkBatchStoreForTests` from the production
  module (shipped in the bundle, callable by any importer).
- `useTours.test.ts:231` ("spans a DST change without an hour of drift") asserts
  only `getHours() === 0` and the day number; on a UTC CI host there is no DST
  and the case cannot fail. It proves the calendar arithmetic only on a
  DST-observing developer machine.

---

## What the tests do not cover (reachable, unpinned)

1. Batch results after a mid-batch tab switch or route change (F2): tests pin
   the reload hand-off, not the report.
2. A stalled GET/PATCH holding the module flag (F3).
3. Focus location after Staff notes Save/Cancel and after a row action (F5).
4. A save from a stale page over a colleague's newer note (F1) - pinned as
   intended behavior, not as a hazard.
5. The Record outcome deep link landing on an eventually consistent `GET
   /api/tours/:id` that still reads `scheduled` right after the batch: the
   initializer opens nothing, the param is stripped, and staff sees the
   "Mark toured" CTA instead of the dialog. Benign (the CTA is a way in), and
   UNVERIFIED how often prod replication lag is visible here; DynamoDB Local
   masks it in e2e.
6. The e2e never drives a batch failure or the "Needs placement" state
   (unit-only).
7. `useTours.test.ts` DST behavior on the CI host (F8).

---

## Already filed - not re-reported

- `docs/issues/tours-scheduled-range-query-unpaginated.md` - the Past tab's
  single-page range read drops the NEWEST rows first at scale.
- `docs/issues/tours-patch-status-precondition.md` - the re-read-then-PATCH
  window (canceled/no-show/rebooked tours can still be flipped).
- `docs/issues/past-tab-timeless-toured-tours.md`,
  `docs/issues/past-tab-no-show-rows-need-an-exit.md`.
- `docs/issues/staff-notes-on-landlord-partner-files.md` (PATCH not type-gated;
  card tenant-only), `docs/issues/extraction-prompt-read-staff-notes.md`.
- `docs/issues/perf-pages-tours-past-surface.md` (`/tours/past` excluded from
  the route pin).

---

## Checked and found sound

Server
- `parseTriageBody` accepts `staff_notes` as string-only, `''` clears
  (`contacts.ts:578-583`); `staff_notes_updated_at` is never copied from the
  body and is stamped only by the route (`contacts.ts:1521-1523`); a
  stamp-only body is a 400. `parseCreateBody` copies neither key
  (`contacts.ts:751-926`). `trimJsonBody` (`app/src/middleware/trimStrings.ts`)
  trims ends only, matching the card's trimmed no-op compare.
- No path can clobber or leak the field: `contactsRepo.update` is a SET-merge
  (`contactsRepo.ts:1277-1320`); every contacts `PutCommand` is conditional on
  `attribute_not_exists` (create, createIfAbsent, pointers); the import writes
  named fields only; no route spreads a request body into a write.
- AI isolation: the only LLM path is extraction; `toProfile` names its fields
  (`jobs/extraction.ts:152-153` reads `notes` only); `applyExtraction` writes
  only `notes`/schema fields; the new app test pins both.
- No unauthenticated route returns a contact (`routes/public.ts` returns flyer
  and a contact NUMBER only). The field renders through `NotesText` as text
  (`Card.tsx:262-283`), never HTML.
- The per-field suggestion read the PATCH does for `staff_notes`
  (`contacts.ts:1561-1569`) is a harmless GetItem with no target validation
  (`extractionRepo.ts:699-708`), so no warn-log noise.

Dashboard - contact
- `useContact.setContact` guard (`useContact.ts:51-53`): every caller
  (`ContactDetail.tsx:618, 633, 645, 706, 742, 776, 979, 1080, 1102, 1115`)
  passes the page's current contact; the guard only neutralizes a setter held
  for an EARLIER id. A stale A setter landing while B is still loading writes A
  with `forId: 'A'`, which the hook still derives as loading for B until B's
  fetch commits - correct. Initial state has `forId = contactId`, so a
  first-load `setContact` still applies. The SSE refetch path uses the same
  guard.
- `useContactFile` keys on `contactId` + type, not the contact object
  (`ContactDetail.tsx:286`), so a note save does not refetch the file.
- `TenantFile` is rendered only by `ContactDetail.tsx:1058`; the card renders
  only for `type === 'tenant'` (team_member shares the pane and is excluded);
  it is keyed by `contactId`. In-flight Save/Cancel are disabled and the
  textarea is read-only; the failure copy is a fixed string.
- The only other `updateContact` callers (`ContactEditForm.tsx:376`,
  `ConsentCaptureModal.tsx:52`, `ContactDetail.tsx:644`) build explicit patches
  and never send `staff_notes`.

Dashboard - tours
- Double-click / re-entry: `if (batchRunning) return` and
  `setBatchRunning(true)` run synchronously before the first await
  (`ToursPage.tsx:425-430`), so a second click in the same tick is refused.
  The flag's only release is the `finally`.
- Ids run in list order (`selected` is built from `notMarkedIds` order,
  `ToursPage.tsx:376-379`); the re-read compares `status` and `scheduledAt`,
  both canonical `toISOString()` server-side (`tours.ts:335-341, 1157-1159`);
  the PATCH body is `{ status: 'toured' }` only. A duplicate mark of an already
  toured tour is not a terminal transition server-side
  (`tours.ts:1221-1227`) and re-emits no milestone (`tours.ts:1424-1426`).
- `selectPastTours` drops every still-scheduled row dated today
  (`useTours.ts:201`), so no future tour can be selected or bulk-marked; the
  window uses calendar arithmetic (`useTours.ts:178-182`).
- A failed reload keeps rows and results (`useTours.ts:266-270`); a failed
  first load after a batch-triggered reload recovers to ready.
- `?outcome=1`: opened only in the state initializer, only for
  `toured && outcome === undefined` (`TourDetail.tsx:266-268`);
  `TourDetailLoaded` is keyed by `tour.tourId` (`TourDetail.tsx:144`) and
  `useTour` never flips back to loading for the same id; the strip is a
  `replace` that carries `location.state` (`TourDetail.tsx:269-274`) and
  cannot loop. No write happens on load or navigation.
- `state.back` is whitelisted (`TourDetail.tsx:103-110`); the image viewer's
  history marker merges into and restores the record state
  (`ui/imageViewer/history.ts:85-128`), so `back` survives an image open.
  Closed rows still pass no state (back goes to Active, unchanged from main);
  the `/tours/closed` whitelist entry has no producer - harmless.
- `ToursPage` props: only `App.tsx:240-242` and tests construct it.
- Module state (`batchRunning`, `batchListeners`, `mountedPastReload`,
  `BACK_TO_PAST`, the `g`-flagged `NBSP_LIKE` used only with `.replace`) is
  tab-scoped and stateless across calls where it should be; Vitest isolates
  modules per file and `ToursPage.test.tsx` resets the store in `beforeEach`.
- CSS: the new `@container` rules resolve against the existing `.page`
  container (`ToursPage.module.css:11`); `.rowActions:empty` matches because
  both action slots render `null` when absent.

e2e and conventions
- `contact-detail.spec.ts` Notes locators are correctly scoped to the Edit
  dialog (the "Add staff notes" aria-label would otherwise match
  `getByLabel('Notes')`); no other spec uses an unscoped Notes/notes locator on
  a tenant page (`listing-activity.spec.ts` scopes to its dialog; the
  `contact-detail.spec.ts:126` heading check is on the landlord page).
- Both new specs reseed in `beforeAll`; no `dashboard-next` spec sorts after
  `tours-past.spec.ts`, and every later root/flows/scenarios spec that touches
  tours reseeds; `workers: 1`, `fullyParallel: false`.
- Gate 5 ratchet: `npx eslint` on the branch's touched code files reports 3
  errors, all pre-existing at the same code on main (`TenantFile.tsx`
  unused `FieldSource` import = main:14; `TourDetail.tsx` `Date.now()` in render
  = main:269; `useTours.ts` `setState` in effect = main:116). None is the
  branch's.
- Added lines under app/dashboard/e2e are ASCII-only; every commit on the
  branch carries a Co-Authored-By trailer; staff copy says "property"/address,
  code says `unit`; GLOSSARY gains a Staff notes entry.
